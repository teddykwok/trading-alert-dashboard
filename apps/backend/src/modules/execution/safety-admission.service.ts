import { Prisma } from "@prisma/client";
import type { ExecutionCanaryAuthorization, PrismaClient, SafetyAdmission, TradeExecution } from "@prisma/client";
import { claimNaturalWindow, type NaturalClaimFailure } from "./canary-authorization.service";
import { reserveSessionSlot } from "./trading-session.service";
import { effectiveNaturalWindowState, isSessionBackedWindow } from "./natural-authorization";
import { naturalWindowAdmitsDirection, naturalWindowState } from "./natural-authorization";
import { connectorEnvironmentMatches } from "../binance/binance-environment";
import { BinanceError } from "../binance/binance.errors";
import { profileLockKey } from "./profile-lock";
import { resolveTakeProfitModality, takeProfitLineage } from "./protection-lifecycle";
import { env } from "../../config/env";
import type { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import { NotFoundError } from "../../utils/errors";
import {
  OPEN_POSITION_STATUSES,
  PENDING_ENTRY_STATUSES,
  TOTAL_ACTIVE_STATUSES,
  symbolSideKey,
} from "./capacity-status";
import type { TradeExecutionStatusName } from "./execution-status";
import {
  evaluateSafetyAdmission,
  resolveEffectivePolicy,
  type BinanceCapacitySnapshot,
  type EffectiveSafetyPolicy,
  type LocalCapacitySnapshot,
  type SafetyDecisionResult,
  type SafetyReasonCode,
  type SymbolStateSnapshot,
} from "./safety-engine";

/**
 * Phase 5 admission control — SAFETY EVALUATION AND LOCAL RESERVATION ONLY.
 *
 * This service reads Binance through the Phase 2 GET-only connector and writes
 * only local rows. It never submits or cancels an order, never changes
 * leverage, margin type, isolated margin or position mode, never transfers
 * funds and never touches an existing position or open order.
 *
 * Atomicity: capacity is counted and reserved inside ONE transaction that
 * holds a per-profile PostgreSQL advisory lock. Without the lock, two
 * concurrent admissions could both read "0 open positions" and both reserve
 * the single available slot. The lock is scoped to the ExecutionProfile, so
 * admissions on different profiles never block each other.
 *
 * PASS is returned only if the PLAN_READY -> PREFLIGHT reservation actually
 * committed inside that transaction.
 */

/** Namespace for the advisory lock so it cannot collide with other features. */
const ADVISORY_LOCK_NAMESPACE = 0x5afe;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Statuses that reserve margin locally which Binance cannot yet reflect: they
 * exist only in our database (no exchange order yet). ENTRY_PENDING and later
 * ARE reflected in the exchange's available balance, so subtracting them again
 * would double-count.
 */
const UNREFLECTED_MARGIN_STATUSES: readonly TradeExecutionStatusName[] = ["PREFLIGHT", "ENTRY_SUBMITTING"];

export interface EvaluateAndReserveInput {
  executionId: string;
  expectedVersion: number;
  /** Explicit evaluation instant — the engine never reads a clock. */
  evaluatedAt: Date;
  maxAttempts?: number;
}

export interface SafetyAdmissionOutcome {
  decision: SafetyDecisionResult["decision"];
  reasonCode: SafetyDecisionResult["reasonCode"];
  result: SafetyDecisionResult | null;
  execution: TradeExecution;
  admission: SafetyAdmission | null;
  /** True when an existing stored decision was returned unchanged. */
  idempotentReplay: boolean;
}

/**
 * Re-exported from its own module so this file can import the natural claim
 * without an import cycle. The implementation and the keys it produces are
 * unchanged; see `profile-lock.ts`.
 */
export { profileLockKey } from "./profile-lock";

// ---------------------------------------------------------------------------
// Phase 12.3 — admission-time authorization
// ---------------------------------------------------------------------------

/**
 * Which authorization actually governs THIS execution, decided from persisted
 * state alone.
 *
 * Nothing is carried in from `SelectedPlanExecutor`. The reconciliation tick
 * calls `admitAndSubmit` on recovered PLAN_READY rows with no signal context at
 * all, so anything held in process memory would be absent exactly when a
 * restart made it matter. Every input here is a row: the execution's `alertId`,
 * its profile, and the authorization table.
 */
export type AdmissionAuthorization =
  /** The profile has no authorization history: pre-existing behaviour, untouched. */
  | { ok: true; mode: "LEGACY" }
  /** A durable EXACT_SIGNAL binding already names this alert. */
  | { ok: true; mode: "EXACT"; authorizationId: string }
  /** A usable natural window authorizes it; the claim is still to be spent. */
  | { ok: true; mode: "NATURAL"; window: ExecutionCanaryAuthorization }
  | { ok: false; reasonCode: SafetyReasonCode; message: string };

/**
 * Turns a PASSing decision into a terminal authorization refusal.
 *
 * Downgrade only. It never manufactures a PASS, and it leaves every measured
 * value — capacity counts, projections, reservations — exactly as the engine
 * reported them, so the stored admission still shows what capacity looked like
 * at the moment authorization refused.
 */
function refuseForAuthorization(
  result: SafetyDecisionResult,
  reasonCode: SafetyReasonCode,
  message: string
): SafetyDecisionResult {
  return {
    ...result,
    decision: "SKIP",
    reasonCode,
    failedChecks: [...result.failedChecks, { reasonCode, message }],
    message,
  };
}

/** Phase-2 claim outcomes → admission reason codes. One-to-one, no disguising. */
const NATURAL_CLAIM_REASON: Record<NaturalClaimFailure, SafetyReasonCode> = {
  NATURAL_WINDOW_NOT_FOUND: "NATURAL_AUTHORIZATION_REQUIRED",
  NOT_NATURAL: "NATURAL_AUTHORIZATION_REQUIRED",
  MALFORMED_NATURAL_WINDOW: "NATURAL_AUTHORIZATION_INVALID",
  REVOKED: "NATURAL_AUTHORIZATION_REVOKED",
  EXPIRED: "NATURAL_AUTHORIZATION_EXPIRED",
  EXHAUSTED: "NATURAL_AUTHORIZATION_EXHAUSTED",
  DIRECTION_NOT_ALLOWED: "NATURAL_AUTHORIZATION_DIRECTION_NOT_ALLOWED",
  VERSION_CONFLICT: "NATURAL_AUTHORIZATION_CONFLICT",
};

/**
 * Resolves the authorization mode from the database, inside the caller's
 * transaction.
 *
 * MUST be called after the per-profile advisory lock is held: it reads the
 * window that a concurrent admission may be claiming, and the lock is what
 * makes that read stable through to the claim.
 *
 * Precedence, and why:
 *
 *  1. NO authorization rows at all -> LEGACY. A profile that has never been
 *     put under authorization control keeps behaving exactly as it did. This
 *     feature is additive; it does not conscript every profile.
 *
 *  2. A durable EXACT_SIGNAL binding for this alert -> EXACT. The historical
 *     one-shot flow wins outright and spends no natural claim, even when a
 *     natural window happens to be open beside it. The alert was authorized
 *     specifically; that is stronger than being authorized generically.
 *
 *  3. Otherwise the profile IS authorization-controlled and this alert is not
 *     individually authorized, so a natural window must authorize it — or it
 *     is refused. Historical rows still mean "this profile requires
 *     authorization"; they never decay into "anything goes".
 */
export async function resolveAdmissionAuthorization(
  tx: Prisma.TransactionClient,
  execution: Pick<TradeExecution, "alertId" | "executionProfileId" | "positionSide">,
  evaluatedAt: Date
): Promise<AdmissionAuthorization> {
  const onRecord = await tx.executionCanaryAuthorization.count({
    where: { executionProfileId: execution.executionProfileId },
  });
  if (onRecord === 0) return { ok: true, mode: "LEGACY" };

  // --- 2. Exact binding wins ------------------------------------------------
  // `alertId` is nullable on TradeExecution (pre-Phase-5 rows). A row without
  // one simply cannot hold an exact binding, so it falls through to natural —
  // which is the fail-closed direction.
  if (execution.alertId !== null) {
    const bound = await tx.executionCanaryAuthorization.findFirst({
      where: {
        executionProfileId: execution.executionProfileId,
        authorizationType: "EXACT_SIGNAL",
        consumedAlertId: execution.alertId,
        revokedAt: null,
      },
      select: { id: true },
    });
    if (bound) return { ok: true, mode: "EXACT", authorizationId: bound.id };
  }

  // --- 3. A natural window must authorize it --------------------------------
  // The NEWEST natural row is the only relevant one: preparation exclusivity
  // means a second window cannot be opened while one is still open, so a newer
  // row implies every older one was already shut. Reading it regardless of
  // state (rather than filtering to the usable ones) is what lets the refusal
  // say REVOKED or EXPIRED instead of a uselessly generic REQUIRED.
  const window = await tx.executionCanaryAuthorization.findFirst({
    where: { executionProfileId: execution.executionProfileId, authorizationType: "NATURAL_WINDOW" },
    orderBy: { createdAt: "desc" },
  });

  const refuse = (reasonCode: SafetyReasonCode, message: string): AdmissionAuthorization => ({
    ok: false,
    reasonCode,
    message,
  });

  if (!window) {
    return refuse(
      "NATURAL_AUTHORIZATION_REQUIRED",
      "This profile requires authorization and no natural window has been prepared."
    );
  }

  // `effectiveNaturalWindowState`, not `naturalWindowState`: for a
  // SESSION-BACKED window the claim counter is not its budget, so EXHAUSTED is
  // not a state it can be in. The session's trade budget bounds it instead,
  // and that is checked below where the slot is reserved. For a LEGACY window
  // the two functions are identical, so nothing about the historical path
  // changes.
  switch (effectiveNaturalWindowState(window, evaluatedAt)) {
    case "INVALID":
      return refuse("NATURAL_AUTHORIZATION_INVALID", "The natural window contradicts its own declared mode.");
    case "REVOKED":
      return refuse("NATURAL_AUTHORIZATION_REVOKED", "The natural window was revoked.");
    case "EXPIRED":
      return refuse("NATURAL_AUTHORIZATION_EXPIRED", "The natural window has expired.");
    case "EXHAUSTED":
      return refuse(
        "NATURAL_AUTHORIZATION_EXHAUSTED",
        `The natural window has spent its whole budget (${window.claimedCount}/${window.maxClaims}).`
      );
  }

  // Direction is the only signal property a window judges. It never looks at
  // the symbol — that is the execution stack's concern, not authorization's.
  if (!naturalWindowAdmitsDirection(window, execution.positionSide, evaluatedAt)) {
    return refuse(
      "NATURAL_AUTHORIZATION_DIRECTION_NOT_ALLOWED",
      `The window admits ${window.allowedDirections.join("/")}, not ${execution.positionSide}.`
    );
  }

  return { ok: true, mode: "NATURAL", window };
}

export class SafetyAdmissionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly readOnly: BinanceReadOnlyService
  ) {}

  /**
   * Evaluates one PLAN_READY execution and, on PASS, atomically reserves its
   * capacity by transitioning it to PREFLIGHT.
   */
  async evaluateAndReserveSafetyAdmission(input: EvaluateAndReserveInput): Promise<SafetyAdmissionOutcome> {
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    const execution = await this.prisma.tradeExecution.findUnique({
      where: { id: input.executionId },
      include: { executionProfile: { include: { safetyPolicy: true } } },
    });
    if (!execution) throw new NotFoundError(`Execution ${input.executionId} not found.`);

    // Idempotent replay: an admission already recorded for this exact version
    // is returned as-is. Retrying must not append a second event or a second
    // admission row.
    const priorAdmission = await this.prisma.safetyAdmission.findUnique({
      where: {
        tradeExecutionId_evaluatedVersion: {
          tradeExecutionId: execution.id,
          evaluatedVersion: input.expectedVersion,
        },
      },
    });
    if (priorAdmission) {
      return {
        decision: priorAdmission.decision,
        reasonCode: (priorAdmission.reasonCode as SafetyDecisionResult["reasonCode"]) ?? null,
        result: null,
        execution,
        admission: priorAdmission,
        idempotentReplay: true,
      };
    }

    const profile = execution.executionProfile;
    const policyRow = profile.safetyPolicy;

    const effective: EffectiveSafetyPolicy = resolveEffectivePolicy(
      {
        killSwitchActive: env.EXECUTION_GLOBAL_KILL_SWITCH,
        maxOpenPositions: env.EXECUTION_MAX_OPEN_POSITIONS,
        maxPendingEntries: env.EXECUTION_MAX_PENDING_ENTRIES,
        maxTotalActiveTrades: env.EXECUTION_MAX_TOTAL_ACTIVE_TRADES,
        maxTotalPlannedRiskUsd: env.EXECUTION_MAX_TOTAL_PLANNED_RISK_USD,
        maxTotalIsolatedMarginUsd: env.EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD,
        maxActivePerSymbolSide: env.EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE,
        maxAlertAgeSeconds: env.EXECUTION_MAX_ALERT_AGE_SECONDS,
        softOpenPositionTarget: env.EXECUTION_SOFT_OPEN_POSITION_TARGET,
        signalFutureToleranceSeconds: env.EXECUTION_SIGNAL_FUTURE_TOLERANCE_SECONDS,
      },
      {
        // A missing policy fails closed: the kill switch reads as ACTIVE and
        // every limit collapses to the strictest possible value.
        present: policyRow !== null && policyRow !== undefined,
        enabled: profile.isEnabled,
        environmentMatchesConnector: this.environmentMatches(profile.environment),
        killSwitchActive: policyRow?.killSwitchActive ?? true,
        expectedPositionMode: profile.expectedPositionMode as "HEDGE" | "ONE_WAY",
        expectedMarginType: profile.expectedMarginType as "ISOLATED" | "CROSS",
        maxOpenPositions: policyRow?.maxOpenPositions ?? 1,
        maxPendingEntries: policyRow?.maxPendingEntries ?? 1,
        maxTotalActiveTrades: policyRow?.maxTotalActiveTrades ?? 1,
        maxTotalPlannedRiskUsd: policyRow ? policyRow.maxTotalPlannedRiskUsd.toString() : "0.00000001",
        maxTotalIsolatedMarginUsd: policyRow ? policyRow.maxTotalIsolatedMarginUsd.toString() : "0.00000001",
        maxActivePerSymbolSide: policyRow?.maxActivePerSymbolSide ?? 1,
        maxAlertAgeSeconds: policyRow?.maxAlertAgeSeconds ?? 1,
        softOpenPositionTarget: policyRow?.softOpenPositionTarget ?? 1,
        allowedSymbols: policyRow?.allowedSymbols ?? [],
        // A profile with no policy row reaches the engine with an EMPTY list,
        // which admits no source timeframe at all. That is the correct
        // direction to fail: PROFILE_POLICY_UNAVAILABLE already refuses this
        // case, and if that rule ever moved, eligibility must not be the thing
        // that silently defaults to permissive.
        allowedSourceTimeframes: policyRow?.allowedSourceTimeframes ?? [],
      }
    );

    // Kill switch short-circuit: no Binance call is made at all when either
    // switch is active. Nothing is cancelled or closed — only this admission
    // is refused.
    const killSwitched = effective.killSwitchActive;
    const { binance, symbolState } = killSwitched
      ? { binance: UNAVAILABLE_BINANCE, symbolState: UNAVAILABLE_SYMBOL }
      : await this.readBinanceState(execution.symbol);

    let lastConflict = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const outcome = await this.attempt(execution.id, input, effective, binance, symbolState, killSwitched);
      if (outcome !== "CONFLICT") return outcome;
      lastConflict = true;
    }

    // Bounded retries exhausted: the caller may retry later. Nothing was
    // reserved and no terminal decision was written.
    const current = await this.prisma.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    return {
      decision: "RETRY_CONFLICT",
      reasonCode: "CAPACITY_CONFLICT_RETRY",
      result: null,
      execution: current,
      admission: null,
      idempotentReplay: !lastConflict,
    };
  }

  /** One locked attempt. Returns "CONFLICT" when another writer won the race. */
  private async attempt(
    executionId: string,
    input: EvaluateAndReserveInput,
    effective: EffectiveSafetyPolicy,
    binance: BinanceCapacitySnapshot,
    symbolState: SymbolStateSnapshot,
    killSwitched: boolean
  ): Promise<SafetyAdmissionOutcome | "CONFLICT"> {
    return this.prisma.$transaction(async (tx) => {
      const execution = await tx.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });

      // Serialize admissions for this profile only. Transaction-scoped, so it
      // is released automatically on commit or rollback.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE}::int, ${profileLockKey(
        execution.executionProfileId
      )}::int)`;

      const local = await this.buildLocalSnapshot(tx, execution);

      /**
       * Which modality this execution's FIRST take profit would use.
       *
       * Read from durable rows rather than assumed: a PLAN_READY execution
       * normally has none, but "normally" is not a guarantee worth encoding,
       * and the same resolver the protection lifecycle uses is the only thing
       * that may answer this — durable lineage wins over configuration, and an
       * AMBIGUOUS history resolves to null so no modality is continued.
       */
      const protectionRows = await tx.binanceOrder.findMany({
        where: { tradeExecutionId: execution.id },
        select: { role: true, orderType: true },
      });
      const intendedTakeProfitModality =
        execution.takeProfit === null
          ? null
          : resolveTakeProfitModality(
              takeProfitLineage(protectionRows),
              env.EXECUTION_STANDARD_LIMIT_TAKE_PROFIT_ENABLED
            );

      let result = evaluateSafetyAdmission({
        evaluatedAt: input.evaluatedAt,
        proposed: {
          executionId: execution.id,
          profileId: execution.executionProfileId,
          symbol: execution.symbol,
          positionSide: execution.positionSide as "LONG" | "SHORT" | "BOTH",
          signalTriggeredAt: execution.signalTriggeredAt,
          sourceTimeframe: execution.sourceTimeframe,
          currentStatus: execution.status,
          riskBudgetUsd: execution.riskBudgetUsd.toString(),
          actualPlannedLoss: execution.actualPlannedLoss.toString(),
          estimatedInitialMargin: execution.estimatedInitialMargin.toString(),
          maximumIsolatedMargin: execution.maximumIsolatedMargin.toString(),
          estimatedLiquidationPrice: execution.estimatedLiquidationPrice?.toString() ?? null,
          requiredLiquidationBoundary: execution.requiredLiquidationBoundary?.toString() ?? null,
          marginPlanStatus: readPlanStatus(execution.marginPlanSnapshot),
          selectedLeverage: execution.selectedLeverage,
          hasMarginPlanSnapshot: execution.marginPlanSnapshot !== null,
          plannedQuantity: execution.plannedQuantity.toString(),
          takeProfit: execution.takeProfit?.toString() ?? null,
          intendedTakeProfitModality,
        },
        policy: effective,
        local,
        binance,
        symbolState,
      });

      /**
       * --- Phase 12.3: authorization, and the claim -----------------------
       *
       * Reached ONLY when every safety and capacity check already passed.
       * That ordering is the whole point: a claim is a cumulative, never
       * refunded budget, so it must not be spent on a trade that capacity was
       * always going to refuse.
       *
       * Consequently every non-PASS decision — terminal capacity refusals and
       * retryable UNAVAILABLE alike — skips this block entirely and spends
       * nothing. An infrastructure blip must never cost an authorization.
       *
       * The reverse direction is a downgrade only: authorization can turn a
       * PASS into a SKIP, and can never turn any other decision into a PASS.
       *
       * It also fixes CLASSIFICATION: when capacity and authorization would
       * both refuse, the capacity reason is the one reported. An opportunity
       * the account was never going to take is not an authorization problem.
       */
      let claimedWindowId: string | null = null;
      if (result.decision === "PASS") {
        const authorization = await resolveAdmissionAuthorization(tx, execution, input.evaluatedAt);

        if (!authorization.ok) {
          result = refuseForAuthorization(result, authorization.reasonCode, authorization.message);
        } else if (authorization.mode === "NATURAL" && isSessionBackedWindow(authorization.window)) {
          /**
           * --- SESSION-BACKED: the session is the budget ------------------
           *
           * No claim is spent, deliberately. A claim is a cumulative,
           * never-refunded cap on ADMISSIONS, and this window's bound is a
           * refundable cap on TRADES — spending both would stop a 100-trade
           * session at its fifth admission, which is the exact bug sessions
           * exist to remove.
           *
           * `claimedCount` therefore stays 0 on these rows. That is not an
           * omission: `isNaturalWindow` refuses any row whose claimedCount
           * exceeds maxClaims, so incrementing past the pinned 5 would make
           * the window INVALID and refuse everything. Zero claims spent is
           * both the honest record and the only valid one.
           *
           * `maxClaims` stays at its pinned value so the reviewed arming
           * checks in `natural-arm.ts` and `canary-readiness.ts` continue to
           * pass unchanged — this feature removes no arming guard.
           *
           * The reservation rides in THIS transaction under THIS profile lock,
           * so it commits or rolls back with the capacity reservation below,
           * and it fails CLOSED: a session that is missing, revoked, expired
           * or exhausted refuses the trade rather than falling back to
           * unlimited admissions.
           */
          claimedWindowId = authorization.window.id;
          const reservation = await reserveSessionSlot(tx, {
            executionProfileId: execution.executionProfileId,
            tradingSessionId: authorization.window.tradingSessionId,
            tradeExecutionId: execution.id,
            now: input.evaluatedAt,
          });
          if (!reservation.reserved) {
            result = refuseForAuthorization(result, reservation.reasonCode, reservation.message);
          }
        } else if (authorization.mode === "NATURAL") {
          /**
           * --- LEGACY: unchanged ------------------------------------------
           *
           * A window with no session link keeps the historical behaviour
           * exactly: one cumulative, never-refunded claim per admission,
           * bounded by maxClaims. No session is consulted, and none is
           * required — a pre-session window must not start refusing because a
           * feature it predates now exists.
           */
          const claim = await claimNaturalWindow(tx, {
            authorizationId: authorization.window.id,
            expectedVersion: authorization.window.version,
            direction: execution.positionSide,
            evaluatedAt: input.evaluatedAt,
          });
          if (claim.ok) {
            claimedWindowId = authorization.window.id;

          } else {
            // Fail closed. Under the lock a conflict means something changed
            // the window from outside the admission path, which is exactly the
            // case not to retry blindly — a later fresh alert may try again.
            result = refuseForAuthorization(result, NATURAL_CLAIM_REASON[claim.reasonCode], claim.message);
          }
        }
        // mode EXACT and mode LEGACY fall through untouched: the historical
        // paths spend no natural claim.
      }

      /**
       * UNAVAILABLE is NOT terminal. Missing Binance state, a connector
       * failure, a rate limit or a network blip say nothing about whether the
       * trade is allowed — only that we could not tell yet. Burning the
       * execution into SKIPPED would turn a transient outage into a permanent
       * refusal, so the status stays PLAN_READY and only the version moves.
       * The caller retries with the new expectedVersion and may then get PASS,
       * SKIP or another UNAVAILABLE.
       *
       * An authorization refusal is the opposite: it is TERMINAL, so it lands
       * in SKIPPED and is never revived. No queue, exactly as capacity.
       */
      const targetStatus: TradeExecutionStatusName =
        result.decision === "PASS" ? "PREFLIGHT" : result.decision === "SKIP" ? "SKIPPED" : "PLAN_READY";

      // Single conditional version bump: it both enforces the caller's
      // expectedVersion and produces the event sequence number. It runs for
      // UNAVAILABLE too, so the attempt is recorded and the stale version can
      // never be replayed into a second admission.
      const updated = await tx.tradeExecution.updateMany({
        where: { id: execution.id, version: input.expectedVersion, status: "PLAN_READY" },
        data: {
          status: targetStatus,
          version: { increment: 1 },
          decisionReasonCode: result.reasonCode ?? "SAFETY_ADMITTED",
          sanitizedMessage: result.message.slice(0, 1000),
        },
      });
      if (updated.count === 0) {
        // Someone else moved this execution (or capacity changed under us).
        // Rolling back leaves no partial reservation and no event.
        throw new CapacityConflict();
      }

      const next = await tx.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });

      await tx.executionEvent.create({
        data: {
          tradeExecutionId: execution.id,
          sequenceNumber: next.version,
          eventType: "DECISION_RECORDED",
          fromStatus: execution.status,
          toStatus: next.status,
          reasonCode: result.reasonCode ?? "SAFETY_ADMITTED",
          message:
            result.decision === "PASS"
              ? "Safety admission passed; local capacity reserved (no exchange call was made)."
              : result.message.slice(0, 1000),
          metadata: {
            decision: result.decision,
            failedChecks: result.failedChecks.map((check) => check.reasonCode),
            signalAgeSeconds: result.signalAgeSeconds,
            killSwitchShortCircuit: killSwitched,
            // Which natural window paid for this admission, when one did. The
            // id only — a window carries no secret, and this is what makes a
            // spent claim traceable back to the execution it bought.
            naturalWindowId: claimedWindowId,
          } as Prisma.InputJsonValue,
        },
      });

      const admission = await tx.safetyAdmission.create({
        data: {
          tradeExecutionId: execution.id,
          evaluatedVersion: input.expectedVersion,
          evaluatedAt: input.evaluatedAt,
          decision: result.decision,
          reasonCode: result.reasonCode,
          message: result.message.slice(0, 1000),
          signalAgeSeconds: result.signalAgeSeconds,
          // Sanitized snapshots only: limits, counts and totals. No
          // credentials, no signed URLs, no raw Binance payloads and no
          // unrelated position or account detail.
          effectiveLimits: sanitizedLimits(result.effectiveLimits) as Prisma.InputJsonValue,
          capacityBefore: result.capacityBefore as unknown as Prisma.InputJsonValue,
          capacityProjected: result.capacityProjected as unknown as Prisma.InputJsonValue,
          symbolStateSummary: {
            symbol: execution.symbol,
            available: symbolState.available,
            exists: symbolState.exists,
            status: symbolState.status,
            contractType: symbolState.contractType,
            binanceHasPosition: binance.symbolsWithPosition.includes(execution.symbol.toUpperCase()),
            binanceHasOpenOrder: binance.symbolsWithOpenOrder.includes(execution.symbol.toUpperCase()),
          } as Prisma.InputJsonValue,
          reservedRiskUsd: result.decision === "PASS" ? result.proposedReservations.riskUsd : null,
          reservedMarginUsd: result.decision === "PASS" ? result.proposedReservations.marginUsd : null,
          binanceSnapshotAt: binance.snapshotAt,
        },
      });

      return {
        decision: result.decision,
        reasonCode: result.reasonCode,
        result,
        execution: next,
        admission,
        idempotentReplay: false,
      } satisfies SafetyAdmissionOutcome;
    }).catch((error: unknown) => {
      if (error instanceof CapacityConflict) return "CONFLICT" as const;
      throw error;
    });
  }

  /**
   * Counts local capacity for the profile. Runs inside the locked transaction
   * so the counts cannot change before the reservation commits.
   */
  private async buildLocalSnapshot(
    tx: Prisma.TransactionClient,
    execution: TradeExecution
  ): Promise<LocalCapacitySnapshot> {
    const active = await tx.tradeExecution.findMany({
      where: {
        executionProfileId: execution.executionProfileId,
        id: { not: execution.id },
        status: { in: TOTAL_ACTIVE_STATUSES as unknown as TradeExecution["status"][] },
      },
      select: {
        status: true,
        symbol: true,
        positionSide: true,
        riskBudgetUsd: true,
        maximumIsolatedMargin: true,
      },
    });

    let reservedRisk = new Prisma.Decimal(0);
    let reservedMargin = new Prisma.Decimal(0);
    let unreflectedMargin = new Prisma.Decimal(0);
    let openPositionCount = 0;
    let pendingEntryCount = 0;
    const activeSymbolSideKeys: string[] = [];

    for (const row of active) {
      const status = row.status as TradeExecutionStatusName;
      if (OPEN_POSITION_STATUSES.includes(status)) openPositionCount += 1;
      if (PENDING_ENTRY_STATUSES.includes(status)) pendingEntryCount += 1;
      activeSymbolSideKeys.push(symbolSideKey(row.symbol, row.positionSide));
      reservedRisk = reservedRisk.plus(row.riskBudgetUsd);
      reservedMargin = reservedMargin.plus(row.maximumIsolatedMargin);
      if (UNREFLECTED_MARGIN_STATUSES.includes(status)) {
        unreflectedMargin = unreflectedMargin.plus(row.maximumIsolatedMargin);
      }
    }

    const admitted = await tx.safetyAdmission.count({
      where: { tradeExecutionId: execution.id, decision: "PASS" },
    });

    return {
      openPositionCount,
      pendingEntryCount,
      totalActiveCount: active.length,
      reservedRiskUsd: reservedRisk.toString(),
      reservedMaximumMarginUsd: reservedMargin.toString(),
      activeSymbolSideKeys,
      pendingUnreflectedMarginUsd: unreflectedMargin.toString(),
      alreadyAdmitted: admitted > 0,
    };
  }

  /**
   * Reads the account and symbol state through the GET-only Phase 2 connector.
   * A read failure is NOT swallowed into a pass — it degrades to an
   * unavailable snapshot, which the engine turns into UNAVAILABLE.
   */
  private async readBinanceState(
    symbol: string
  ): Promise<{ binance: BinanceCapacitySnapshot; symbolState: SymbolStateSnapshot }> {
    let binance: BinanceCapacitySnapshot = UNAVAILABLE_BINANCE;
    let symbolState: SymbolStateSnapshot = UNAVAILABLE_SYMBOL;

    try {
      const summary = await this.readOnly.getAccountSummary();
      binance = {
        available: true,
        positionMode: summary.positionMode,
        assetMode: summary.assetMode,
        usdtAvailableBalance: summary.usdtAvailableBalance,
        symbolsWithPosition: [...new Set(summary.positions.map((p) => p.symbol.trim().toUpperCase()))],
        symbolsWithOpenOrder: summary.openOrderSymbols,
        snapshotAt:
          typeof summary.connection.serverTimeMs === "number" ? new Date(summary.connection.serverTimeMs) : null,
      };
    } catch {
      // Message intentionally not propagated: connector errors can carry
      // endpoint detail that has no place in a stored decision.
      binance = UNAVAILABLE_BINANCE;
    }

    try {
      const inspection = await this.readOnly.inspectSymbol(symbol);
      symbolState = {
        available: true,
        exists: true,
        status: inspection.filters.status,
        contractType: inspection.filters.contractType,
        // Passed through verbatim, nulls included. The engine — not this
        // reader — decides what a missing asset means.
        quoteAsset: inspection.filters.quoteAsset,
        marginAsset: inspection.filters.marginAsset,
        // Verbatim, nulls included — the engine decides what a missing floor
        // means, exactly as it does for the assets above.
        minNotional: inspection.filters.minNotional,
        hasFiltersSnapshot: inspection.filters.tickSize !== null && inspection.filters.stepSize !== null,
        hasBracketSnapshot: inspection.brackets.length > 0,
      };
    } catch (error) {
      /**
       * Two very different failures used to collapse into one.
       *
       * `inspectSymbol` raises UNSUPPORTED_SYMBOL when exchangeInfo returned
       * successfully and simply had no such contract. That is an AUTHORITATIVE
       * answer — the symbol does not exist — and it belongs on the terminal
       * path so a bad ticker is SKIPPED once instead of being re-read forever.
       *
       * Any other error (timeout, 5xx, network, malformed payload) says
       * nothing about the symbol, only that we could not look. That stays
       * `available: false`, which the engine treats as retryable and which
       * never spends a claim or a reservation.
       */
      symbolState =
        error instanceof BinanceError && error.kind === "UNSUPPORTED_SYMBOL"
          ? { ...UNAVAILABLE_SYMBOL, available: true, exists: false }
          : UNAVAILABLE_SYMBOL;
    }

    return { binance, symbolState };
  }

  private environmentMatches(profileEnvironment: string): boolean {
    // Shared with the entry lifecycle so the two can never disagree about the
    // same base URL. Exact-origin, and an unrecognised origin matches nothing.
    return connectorEnvironmentMatches(profileEnvironment, env.BINANCE_FUTURES_REST_BASE_URL);
  }
}

/** Internal signal that the locked attempt lost its optimistic race. */
class CapacityConflict extends Error {
  constructor() {
    super("Capacity changed during admission.");
    this.name = "CapacityConflict";
  }
}

const UNAVAILABLE_BINANCE: BinanceCapacitySnapshot = {
  available: false,
  positionMode: null,
  assetMode: null,
  usdtAvailableBalance: null,
  symbolsWithPosition: [],
  symbolsWithOpenOrder: [],
  snapshotAt: null,
};

const UNAVAILABLE_SYMBOL: SymbolStateSnapshot = {
  available: false,
  exists: false,
  status: null,
  contractType: null,
  // Null, never "USDT". An unread symbol must never look eligible.
  quoteAsset: null,
  marginAsset: null,
  // Null, never a number. An unread floor is not a floor of zero.
  minNotional: null,
  hasFiltersSnapshot: false,
  hasBracketSnapshot: false,
};

/** Reads the frozen plan's status without trusting arbitrary snapshot shapes. */
function readPlanStatus(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const status = (snapshot as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

function sanitizedLimits(limits: EffectiveSafetyPolicy) {
  return {
    killSwitchActive: limits.killSwitchActive,
    globalKillSwitchActive: limits.globalKillSwitchActive,
    profileKillSwitchActive: limits.profileKillSwitchActive,
    maxOpenPositions: limits.maxOpenPositions,
    maxPendingEntries: limits.maxPendingEntries,
    maxTotalActiveTrades: limits.maxTotalActiveTrades,
    maxTotalPlannedRiskUsd: limits.maxTotalPlannedRiskUsd,
    maxTotalIsolatedMarginUsd: limits.maxTotalIsolatedMarginUsd,
    maxActivePerSymbolSide: limits.maxActivePerSymbolSide,
    maxAlertAgeSeconds: limits.maxAlertAgeSeconds,
    allowedSymbolCount: limits.allowedSymbols.length,
  };
}
