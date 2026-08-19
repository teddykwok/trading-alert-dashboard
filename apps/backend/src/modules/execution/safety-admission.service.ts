import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaClient, SafetyAdmission, TradeExecution } from "@prisma/client";
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

/** Stable 32-bit key derived from the profile id for pg_advisory_xact_lock. */
export function profileLockKey(executionProfileId: string): number {
  const digest = createHash("sha256").update(executionProfileId).digest();
  // Signed 32-bit: Postgres advisory lock keys are int4.
  return digest.readInt32BE(0);
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

      const result = evaluateSafetyAdmission({
        evaluatedAt: input.evaluatedAt,
        proposed: {
          executionId: execution.id,
          profileId: execution.executionProfileId,
          symbol: execution.symbol,
          positionSide: execution.positionSide as "LONG" | "SHORT" | "BOTH",
          signalTriggeredAt: execution.signalTriggeredAt,
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
        },
        policy: effective,
        local,
        binance,
        symbolState,
      });

      /**
       * UNAVAILABLE is NOT terminal. Missing Binance state, a connector
       * failure, a rate limit or a network blip say nothing about whether the
       * trade is allowed — only that we could not tell yet. Burning the
       * execution into SKIPPED would turn a transient outage into a permanent
       * refusal, so the status stays PLAN_READY and only the version moves.
       * The caller retries with the new expectedVersion and may then get PASS,
       * SKIP or another UNAVAILABLE.
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
        hasFiltersSnapshot: inspection.filters.tickSize !== null && inspection.filters.stepSize !== null,
        hasBracketSnapshot: inspection.brackets.length > 0,
      };
    } catch {
      symbolState = UNAVAILABLE_SYMBOL;
    }

    return { binance, symbolState };
  }

  private environmentMatches(profileEnvironment: string): boolean {
    const host = env.BINANCE_FUTURES_REST_BASE_URL.toLowerCase();
    const connectorEnvironment = host.includes("testnet") ? "TESTNET" : "MAINNET";
    return profileEnvironment === connectorEnvironment;
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
