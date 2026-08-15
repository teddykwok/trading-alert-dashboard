import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
  BinanceOrder,
  ExecutionProtectionState,
  PrismaClient,
  ProtectionState,
  TradeExecution,
} from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import {
  IllegalExecutionTransitionError,
  canTransition,
  isTerminalStatus,
  type TradeExecutionStatusName,
} from "./execution-status";
import { NotFoundError } from "../../utils/errors";
import { BinanceError } from "../binance/binance.errors";
import type { BinanceUsdMExecutionClient, WorkingTypeName } from "../binance/binance-execution.client";
import type { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import type { BinanceAlgoOrderDto } from "../binance/binance.types";
import type { CriticalAlertService, CriticalAlertType } from "./critical-alert.service";
import {
  classifyMutationOutcome,
  findOrderIdentityMismatches as findEntryIdentityMismatches,
  mapExchangeToLocalOrderStatus,
  normalizeExchangeOrderStatus,
  type MutationOutcome,
} from "./entry-lifecycle";
import { buildClientOrderId } from "./execution-safety";
import { protectionWorkingType, type ProtectionPolicy } from "./protection-policy";
import {
  calculateCoverage,
  classifyPostCleanupPosition,
  decideEntryRemainderCleanup,
  calculateMarginTopUp,
  classifyClosure,
  closingSide,
  countsAsActiveCoverage,
  evaluateEmergencyCloseEligibility,
  evaluateLiquidationSafety,
  findProtectionIdentityMismatches,
  isCriticalReason,
  isWithinMarginCap,
  normalizeAlgoStatus,
  normalizeOpenQuantity,
  planSiblingCancellation,
  protectionPositionSide,
  validateProtectionTriggers,
  type DirectionName,
  type LocalEntryStatus,
  type NormalizedProtectionStatus,
  type ProtectionReasonCode,
  type SiblingCandidate,
} from "./protection-lifecycle";

/**
 * Phase 7 â€” SL/TP protection, liquidation safety, margin top-up and emergency
 * close orchestration.
 *
 * Internal methods only: no worker, no queue, no polling daemon, no user-data
 * stream, no webhook wiring and no HTTP route. A future worker calls these.
 *
 * Every mutation here is RISK-REDUCING and therefore deliberately NOT gated on
 * the exposure-increasing live-entry switches: refusing to protect or close an
 * existing position because new entries were disabled would be the opposite of
 * safe. Emergency close additionally survives an active kill switch.
 *
 * No database transaction is ever held across a Binance or Telegram call.
 */

const D = Prisma.Decimal;

/** Namespace for the per-(profile, symbol, positionSide) advisory lock. */
const PROTECTION_LOCK_NAMESPACE = 0x7afe;

export interface ProtectionLifecycleInput {
  executionId: string;
  expectedVersion: number;
  /** Explicit evaluation instant â€” the pure layer never reads a clock. */
  evaluatedAt: Date;
}

/**
 * The exact coverage that was proven at one verification moment. Decimal
 * STRINGS only â€” nothing here is ever routed through a JS number.
 */
export interface VerifiedCoverageSnapshot {
  confirmedOpenQuantity: string;
  protectedStopQuantity: string;
  protectedTakeProfitQuantity: string;
  verifiedAt: Date;
}

export interface ProtectionOutcome {
  ok: boolean;
  reasonCode: ProtectionReasonCode;
  message: string;
  execution: TradeExecution;
  protection: ExecutionProtectionState | null;
  mutationsDispatched: number;
}

/**
 * Aggregate protection coverage, WITH the confidence of the observation.
 *
 * `stop` / `takeProfit` are the quantities proven active. `unresolved` names
 * the roles whose exchange state could be proven neither present nor absent â€”
 * the distinction that separates "there is a real gap to repair" from "we
 * could not look". Only the former may drive a mutation.
 */
interface VerifiedCoverage {
  stop: string;
  takeProfit: string;
  unresolved: ReadonlyArray<"STOP_LOSS" | "TAKE_PROFIT">;
}

/**
 * Local order statuses that already settle the question: whatever the exchange
 * says now, an order in one of these cannot be providing live coverage.
 */
const LOCALLY_RESOLVED_ORDER_STATUSES: readonly string[] = ["FILLED", "CANCELED", "EXPIRED", "REJECTED"];

/**
 * Reason codes meaning "the exchange state could not be read", as opposed to
 * "the exchange told us something bad". They are DEFERRALS: nothing is known
 * to be wrong, so they must not alert, escalate or rewrite protection state â€”
 * only cause the next reconciliation tick to ask again.
 */
const UNREADABLE_PROTECTION_REASON_CODES: readonly ProtectionReasonCode[] = [
  "STOP_QUERY_UNAVAILABLE",
  "TAKE_PROFIT_QUERY_UNAVAILABLE",
];

function isUnreadableProtectionState(reasonCode: ProtectionReasonCode): boolean {
  return UNREADABLE_PROTECTION_REASON_CODES.includes(reasonCode);
}

/**
 * The ONLY reasons an execution may be automatically un-parked, as an explicit
 * allowlist rather than "everything not forbidden".
 *
 * Each one means the same thing: the STOP leg of a tranche could not be proven
 * active at the time, so the lifecycle stopped. None of them asserts anything
 * about the position itself, and all four are re-decidable from a fresh
 * exchange read â€” which is exactly what makes them recoverable. Mainnet Canary
 * #2 was parked by STOP_IDENTITY_MISMATCH from a comparator defect that has
 * since been fixed; nothing in the architecture could ever notice that the
 * reason had stopped being true.
 *
 * Everything else stays parked, and mostly by construction rather than by this
 * list: an intervention only becomes a candidate at all if it also wrote
 * ExecutionProtectionState.state = MANUAL_INTERVENTION, which ONLY the
 * protection service's escalate() does. Every entry-lifecycle escalation, every
 * mapping-driven park and every operator transition is therefore excluded
 * before this list is even consulted.
 *
 * Deliberately absent, with reasons:
 *  - PARTIAL_PROTECTION_EXIT / PROTECTION_COVERAGE_INCOMPLETE (over-protection)
 *    / POSITION_IDENTITY_MISMATCH: each asserts a contradiction about the
 *    POSITION or about orders we may not own. Re-running protection cannot
 *    resolve a contradiction; it would build on top of one.
 *  - STOP_TRIGGER_INVALID / TAKE_PROFIT_TRIGGER_INVALID /
 *    PROTECTION_QUANTITY_UNSUPPORTED / PROTECTION_FILTER_MISMATCH: the FROZEN
 *    plan is incompatible with the live symbol. Nothing here may recompute a
 *    trigger, so a retry can only fail identically.
 *  - EMERGENCY_CLOSE_*: the last resort itself failed. Automatic mutation after
 *    that is precisely what must not happen.
 *  - POSITION_NOT_FOUND_AFTER_FILL: a position row that contradicts a recorded
 *    fill. A later open position on the same symbol/side is not provably the
 *    same position, so re-protecting could protect someone else's trade.
 *  - STOP_SUBMISSION_REJECTED: it looks re-decidable and is not. It is written
 *    for EVERY classifyMutationOutcome CONFIRMED_REJECTED, which collapses nine
 *    distinct error kinds â€” AUTH, MISSING_CREDENTIALS, PERMISSION,
 *    READ_ONLY_VIOLATION, IP_RESTRICTED, FUTURES_NOT_ENABLED, DISABLED,
 *    UNSUPPORTED_SYMBOL and REQUEST_INVALID â€” into one string. All but a
 *    minority of REQUEST_INVALID cases are permanent until a human changes
 *    something outside this system, and the underlying kind/binanceCode is not
 *    persisted (only binanceOrder.status = REJECTED), so recovery cannot tell
 *    them apart even in principle. Auto-retrying a credential or permission
 *    rejection is not merely useless: repeated rejected submissions risk
 *    Binance error-rate penalties. Recovering the transient subset needs that
 *    classification persisted first, which is a separate design.
 */
const RECOVERABLE_INTERVENTION_REASON_CODES: readonly ProtectionReasonCode[] = [
  "STOP_NOT_VERIFIED",
  "STOP_IDENTITY_MISMATCH",
  "STOP_SUBMISSION_RESULT_UNKNOWN",
];

function isRecoverableInterventionReason(reasonCode: string | null): boolean {
  return reasonCode !== null && RECOVERABLE_INTERVENTION_REASON_CODES.includes(reasonCode as ProtectionReasonCode);
}

/**
 * Recovery attempts allowed within ONE intervention episode.
 *
 * Bounded because an attempt that fails re-parks the execution, and an
 * unbounded loop would mint a fresh protection generation every tick. Scoped
 * per episode because a later, unrelated incident in the same trade deserves
 * its own budget â€” see countRecoveryAttemptsInEpisode.
 */
const MAX_RECOVERY_ATTEMPTS_PER_EPISODE = 3;

/**
 * A tranche to submit, plus the execution version THIS call now owns.
 *
 * Reserving commits a version bump, so everything after it in the same
 * lifecycle call â€” an escalation especially â€” must CAS against the version the
 * reservation produced rather than the one the caller arrived with. A resumed
 * tranche reserves nothing and keeps the incoming version.
 */
interface ReservedTranche {
  generation: number;
  expectedVersion: number;
}

/**
 * The outcome of a protection status promotion.
 *
 * `committedVersion` is non-null ONLY when this call actually advanced the row.
 * Callers thread it forward so a later escalation CASes against a version this
 * call produced â€” never against one a concurrent tick produced.
 */
interface RecordedProtectionStatus {
  execution: TradeExecution;
  committedVersion: number | null;
}

interface PositionSnapshot {
  quantity: string;
  entryPrice: string | null;
  markPrice: string | null;
  liquidationPrice: string | null;
  isolatedMargin: string | null;
  isolatedWallet: string | null;
  leverage: string | null;
  marginAsset: string | null;
  updateTimeMs: number | null;
}

export function protectionLockKey(profileId: string, symbol: string, positionSide: string): number {
  return createHash("sha256")
    .update(`${profileId}:${symbol.trim().toUpperCase()}:${positionSide.toUpperCase()}`)
    .digest()
    .readInt32BE(0);
}

export class ProtectionLifecycleService {
  private readonly maxAttempts: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly readOnly: BinanceReadOnlyService,
    private readonly mutations: BinanceUsdMExecutionClient,
    private readonly alerts: CriticalAlertService,
    options: { reconcileMaxAttempts?: number } = {}
  ) {
    this.maxAttempts = options.reconcileMaxAttempts ?? env.EXECUTION_PROTECTION_RECONCILE_MAX_ATTEMPTS;
  }

  // ==========================================================================
  // 1. ensureProtectionForExposure â€” the main entry point
  // ==========================================================================

  /**
   * Protects confirmed exposure. Runs on the FIRST confirmed non-zero fill â€”
   * it never waits for ENTRY_FILLED, because a partial position is just as
   * exposed as a full one.
   */
  async ensureProtectionForExposure(input: ProtectionLifecycleInput): Promise<ProtectionOutcome> {
    const execution = await this.loadExecution(input.executionId);
    const direction = execution.direction as DirectionName;
    const positionSide = protectionPositionSide(direction);

    // 1. Confirmed local fill.
    const localFill = execution.filledQuantity ? new D(execution.filledQuantity) : new D(0);
    if (localFill.lessThanOrEqualTo(0)) {
      return this.outcome(false, "EXECUTION_HAS_NO_CONFIRMED_FILL", "No confirmed fill; nothing to protect.", execution);
    }

    // 2/3. Actual position from the exchange, for this symbol and side only.
    const position = await this.readPosition(execution.symbol, positionSide);
    if (position === "UNAVAILABLE") {
      return this.outcome(false, "POSITION_STATE_UNAVAILABLE", "Position state could not be read.", execution);
    }
    if (position === null) {
      return this.escalate(execution, "POSITION_NOT_FOUND_AFTER_FILL", "No position exists despite a recorded fill.", input);
    }

    const normalized = normalizeOpenQuantity(position.quantity, direction);
    if (!normalized.valid) {
      return this.escalate(
        execution,
        "POSITION_IDENTITY_MISMATCH",
        "Position sign contradicts the expected direction.",
        input
      );
    }
    if (new D(normalized.quantity).lessThanOrEqualTo(0)) {
      // The exchange says flat while we recorded a fill â€” reconcile closure.
      return this.reconcileProtectionAndClosure(input);
    }

    const protection = await this.ensureProtectionRow(execution.id);

    // 4. Persist actual values through the narrow Phase 4 mechanism.
    await this.recordActualPositionFields(execution, position, input.evaluatedAt);

    // 5. Liquidation safety against the FROZEN boundary.
    const safety = evaluateLiquidationSafety({
      direction,
      actualLiquidationPrice: position.liquidationPrice,
      requiredBoundary: execution.requiredLiquidationBoundary?.toString() ?? null,
    });

    if (!safety.safe) {
      // 6. Margin top-up, if it is enabled and there is budget left.
      const topUp = await this.attemptMarginTopUp(execution, position, normalized.quantity, input);
      if (!topUp.resolved) {
        await this.setProtectionState(protection.id, "MARGIN_ADJUSTING", topUp.reasonCode, topUp.message);
        await this.alerts.raise({
          tradeExecutionId: execution.id,
          alertType: topUp.reasonCode === "MARGIN_TOP_UP_RESULT_UNKNOWN" ? "MARGIN_TOP_UP_RESULT_UNKNOWN" : "MARGIN_TOP_UP_FAILED",
          reasonCode: topUp.reasonCode,
          details: {
            symbol: execution.symbol,
            positionSide,
            confirmedOpenQuantity: normalized.quantity,
            protectionState: "MARGIN_ADJUSTING",
            requiredAction: "Review isolated margin and liquidation buffer manually.",
          },
        });
        // Protection still proceeds: an unsafe buffer is a reason to place the
        // stop urgently, never a reason to leave the position naked.
      }
    }

    await this.prisma.executionProtectionState.update({
      where: { id: protection.id },
      data: { confirmedOpenQuantity: new D(normalized.quantity), liquidationSafe: safety.safe },
    });

    // 7-11. Reserve the missing tranche, then STOP first, then TP.
    return this.advanceProtection(execution, normalized.quantity, position, input);
  }

  // ==========================================================================
  // 2. resumeProtectionLifecycle â€” crash recovery
  // ==========================================================================

  /**
   * Resumes from whatever durable state survived a crash. It never assumes a
   * protection order was NOT created: any reserved tranche is resolved by
   * querying its own deterministic clientAlgoId first.
   */
  async resumeProtectionLifecycle(input: ProtectionLifecycleInput): Promise<ProtectionOutcome> {
    const execution = await this.loadExecution(input.executionId);

    // The shared state machine is the single source of truth. The literal list
    // this replaced silently omitted every status added after it was written â€”
    // CLOSED_EXTERNAL among them â€” which would have made a terminally closed
    // execution look like a resumable protection lifecycle.
    if (isTerminalStatus(execution.status as TradeExecutionStatusName)) {
      return this.outcome(false, "MANUAL_REVIEW_REQUIRED", `Execution is terminal (${execution.status}).`, execution);
    }

    const protection = await this.prisma.executionProtectionState.findUnique({
      where: { tradeExecutionId: execution.id },
    });

    // An unresolved margin ADD must be reconciled before anything else can add
    // more margin.
    const unresolvedMargin = await this.prisma.marginAdjustmentIntent.findFirst({
      where: { tradeExecutionId: execution.id, status: { in: ["SUBMITTING", "RESULT_UNKNOWN"] } },
      orderBy: { attempt: "desc" },
    });
    if (unresolvedMargin) {
      await this.reconcileMarginIntent(execution, unresolvedMargin.id, input.evaluatedAt);
    }

    // An unresolved emergency close is queried before anything else.
    const emergency = await this.loadOrder(execution.id, "EMERGENCY_CLOSE", 1);
    if (emergency && ["SUBMITTING", "UNKNOWN", "NEW"].includes(emergency.status)) {
      return this.reconcileEmergencyClose(execution, emergency, input);
    }

    if (protection?.state === "CLOSED") {
      return this.outcome(true, "PROTECTION_VERIFIED", "Protection lifecycle already closed.", execution, protection);
    }

    // Everything else is driven by the current exposure, which also resolves
    // any half-submitted protection tranche via its own clientAlgoId.
    return this.ensureProtectionForExposure(input);
  }

  // ==========================================================================
  // 2b. attemptProtectionRecovery â€” re-admit a parked execution
  // ==========================================================================

  /**
   * Returns a MANUAL_INTERVENTION execution to the protected lifecycle when â€”
   * and only when â€” current exchange evidence proves that is safe.
   *
   * MANUAL_INTERVENTION stays a safety boundary. This does not "resume
   * everything": it is an allowlist of protection-lifecycle reasons plus a
   * fresh proof, and it re-parks itself the moment either fails. Callers MUST
   * run reconcileProtectionAndClosure first â€” a flat position is closure's
   * business, and on a real exchange flat looks like a missing position row.
   *
   * Nothing here submits, cancels or reserves anything. Its entire job is to
   * decide whether the EXISTING machinery may run, then hand over to
   * ensureProtectionForExposure, which owns tranche reservation, STOP-first
   * sequencing, deterministic clientAlgoIds, generation semantics,
   * over-protection detection and coverage verification exactly as it does for
   * a never-parked execution.
   */
  async attemptProtectionRecovery(input: ProtectionLifecycleInput): Promise<ProtectionOutcome> {
    const execution = await this.loadExecution(input.executionId);

    // Gate 1: still parked. A closure pass in the same tick may already have
    // terminalized it, and a terminal execution is never re-opened.
    if (execution.status !== "MANUAL_INTERVENTION") {
      return this.outcome(false, "MANUAL_REVIEW_REQUIRED", `Execution is ${execution.status}; no recovery applies.`, execution);
    }

    const protection = await this.loadProtection(execution.id);

    // Gate 2: THE ALLOWLIST, in two parts.
    //
    // The protection row must itself say MANUAL_INTERVENTION â€” which only this
    // service's escalate() ever writes â€” and its reason must be one of the four
    // recoverable ones. An execution parked by the entry lifecycle, by a
    // refused mapping or by an operator never satisfies the first half, so a
    // healthy-looking STOP/TP can never erase an unrelated manual reason.
    if (!protection || protection.state !== "MANUAL_INTERVENTION") {
      return this.outcome(
        false,
        "MANUAL_REVIEW_REQUIRED",
        "The intervention did not come from the protection lifecycle; it stays parked for a human.",
        execution,
        protection
      );
    }
    if (!isRecoverableInterventionReason(protection.reasonCode)) {
      return this.outcome(
        false,
        "MANUAL_REVIEW_REQUIRED",
        `Intervention reason ${protection.reasonCode ?? "(none)"} is not automatically recoverable.`,
        execution,
        protection
      );
    }

    // Gate 3: a bounded budget for THIS episode.
    const attempts = await this.countRecoveryAttemptsInEpisode(execution.id);
    if (attempts >= MAX_RECOVERY_ATTEMPTS_PER_EPISODE) {
      return this.outcome(
        false,
        "MANUAL_REVIEW_REQUIRED",
        `Protection recovery already ran ${attempts} time(s) for this intervention; a human must intervene.`,
        execution,
        protection
      );
    }

    // Gate 4: the position must be conclusively OPEN and ours.
    const direction = execution.direction as DirectionName;
    const positionSide = protectionPositionSide(direction);
    const position = await this.readPosition(execution.symbol, positionSide);
    if (position === "UNAVAILABLE") {
      return this.outcome(false, "POSITION_STATE_UNAVAILABLE", "Position state could not be read; staying parked.", execution, protection);
    }
    if (position === null) {
      // Flat, or unreadable as flat. Either way closure owns this, not recovery.
      return this.outcome(false, "PROTECTION_COVERAGE_INCOMPLETE", "No open position to protect; staying parked.", execution, protection);
    }
    const normalized = normalizeOpenQuantity(position.quantity, direction);
    if (!normalized.valid) {
      // A contradiction, not a gap. Never escalate from here: it is already
      // parked, and re-stamping would only churn the version and the journal.
      return this.outcome(false, "POSITION_IDENTITY_MISMATCH", "Position sign contradicts the expected direction; staying parked.", execution, protection);
    }
    const openQuantity = normalized.quantity;
    if (new D(openQuantity).lessThanOrEqualTo(0)) {
      return this.outcome(false, "PROTECTION_COVERAGE_INCOMPLETE", "Position is flat; closure owns this execution.", execution, protection);
    }

    // Gate 5: EVERY protection leg must be readable. An UNKNOWN leg is not a
    // gap, it is an absence of evidence â€” and un-parking on it would hand
    // ensureProtectionForExposure a coverage number it cannot trust.
    const measured = await this.measureVerifiedCoverage(execution);
    if (measured.unresolved.length > 0) {
      return this.outcome(
        false,
        measured.unresolved.includes("STOP_LOSS") ? "STOP_QUERY_UNAVAILABLE" : "TAKE_PROFIT_QUERY_UNAVAILABLE",
        `Protection state is unreadable for ${measured.unresolved.join(" and ")}; staying parked until it can be seen.`,
        execution,
        protection
      );
    }

    // Gate 6: never build on top of protection we cannot explain.
    const coverage = calculateCoverage({
      confirmedOpenQuantity: openQuantity,
      activeStopQuantity: measured.stop,
      activeTakeProfitQuantity: measured.takeProfit,
    });
    if (coverage.overProtected) {
      return this.outcome(
        false,
        "PROTECTION_COVERAGE_INCOMPLETE",
        `Protection exceeds exposure (stop ${measured.stop}, take profit ${measured.takeProfit}, exposure ${openQuantity}); staying parked.`,
        execution,
        protection
      );
    }

    // Every gate passed: re-admit the execution. requiresManualIntervention is
    // deliberately LEFT SET â€” the execution is not healthy yet, it is merely
    // allowed to try, so it keeps counting towards recoveryRequiredCount until
    // full coverage is verified.
    const resumed = await this.commitExecutionChange(execution, input.expectedVersion, {
      status: "PLACING_PROTECTION",
      reasonCode: "PROTECTION_RECOVERY_RESUMED",
      message:
        `Re-admitted to the protection lifecycle after ${protection.reasonCode}: position is open ` +
        `(${openQuantity}), every protection leg is readable and coverage is not excessive.`,
      eventType: "PROTECTION_RECONCILED",
      metadata: {
        interventionReason: protection.reasonCode,
        recoveryAttempt: attempts + 1,
        maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS_PER_EPISODE,
        confirmedOpenQuantity: openQuantity,
        measuredStopQuantity: measured.stop,
        measuredTakeProfitQuantity: measured.takeProfit,
        // Distinguishes "protection was already valid" from "a gap was repaired"
        // without having to re-derive it from later events.
        alreadyFullyCovered: coverage.fullyCovered,
      },
    });
    if (!resumed) {
      // A concurrent tick won. It either recovered this execution or moved it
      // on; either way exactly one winner un-parks and this one does nothing.
      return this.outcome(false, "CAPACITY_OR_VERSION_CONFLICT", "Version changed during protection recovery.", execution, protection);
    }

    // The existing lifecycle takes over from here â€” no parallel mechanism.
    return this.ensureProtectionForExposure({ ...input, expectedVersion: resumed.version });
  }

  /**
   * Recovery attempts made during the CURRENT intervention episode.
   *
   * An execution can be parked, recovered and parked again within one trade,
   * and a later incident must not inherit the earlier one's spent budget. The
   * episode boundary is read from the append-only event log, which already
   * records it precisely â€” no schema is needed.
   *
   * The boundary is the newest event that reached PROTECTED â€” the execution's
   * last provably healthy moment.
   *
   * The tempting rule, "count attempts after the most recent transition INTO
   * MANUAL_INTERVENTION", is UNSAFE here, and the event semantics are what
   * prove it: a recovery moves the row to PLACING_PROTECTION, so a recovery
   * that then fails re-parks it by the legal PLACING_PROTECTION ->
   * MANUAL_INTERVENTION edge. That re-park IS a transition into
   * MANUAL_INTERVENTION, so every failed attempt would hand itself a fresh
   * budget and the cap could never bind â€” an unbounded loop, each iteration
   * potentially minting another protection generation.
   *
   * Reaching PROTECTED is the only event that proves an episode actually ENDED:
   * it is written solely by recordProtectionStatus after aggregate coverage has
   * been re-measured against the exchange. So a later, unrelated incident in
   * the same trade starts with a full budget, while a failing recovery keeps
   * spending the one it has. `sequenceNumber` is the execution's version at
   * commit time â€” strictly increasing and unique per execution â€” so it orders
   * events exactly.
   *
   * With no PROTECTED marker (the execution was parked before it was ever
   * healthy â€” the Mainnet Canary #2 shape) every recovery attempt ever made is
   * counted, which is the single-episode reading and the conservative one.
   */
  private async countRecoveryAttemptsInEpisode(executionId: string): Promise<number> {
    const episodeStart = await this.prisma.executionEvent.findFirst({
      where: { tradeExecutionId: executionId, toStatus: "PROTECTED" },
      orderBy: { sequenceNumber: "desc" },
      select: { sequenceNumber: true },
    });

    return this.prisma.executionEvent.count({
      where: {
        tradeExecutionId: executionId,
        // The signature of a recovery: no other path writes this pair.
        fromStatus: "MANUAL_INTERVENTION",
        toStatus: "PLACING_PROTECTION",
        ...(episodeStart ? { sequenceNumber: { gt: episodeStart.sequenceNumber } } : {}),
      },
    });
  }

  // ==========================================================================
  // 3. reconcileProtectionAndClosure
  // ==========================================================================

  /**
   * Determines whether SL or TP closed the position, verifies the position is
   * genuinely flat, and cleans up every remaining sibling across generations.
   */
  async reconcileProtectionAndClosure(input: ProtectionLifecycleInput): Promise<ProtectionOutcome> {
    const execution = await this.loadExecution(input.executionId);
    const direction = execution.direction as DirectionName;
    const positionSide = protectionPositionSide(direction);
    const protection = await this.ensureProtectionRow(execution.id);

    const position = await this.readPosition(execution.symbol, positionSide);
    if (position === "UNAVAILABLE") {
      return this.outcome(false, "POSITION_STATE_UNAVAILABLE", "Position state could not be read.", execution, protection);
    }

    const remaining = position === null ? "0" : normalizeOpenQuantity(position.quantity, direction).quantity;

    // Refresh every local protection order from the exchange.
    const orders = await this.loadProtectionOrders(execution.id);
    const observed: Array<{ order: BinanceOrder; status: NormalizedProtectionStatus; dto: BinanceAlgoOrderDto | null }> = [];
    for (const order of orders) {
      const query = await this.queryProtection(execution.symbol, order.clientAlgoId!, {
        executionId: execution.id,
        role: order.role,
        generation: order.generation,
      });
      if (query.outcome === "CONFIRMED_ACCEPTED" && query.order) {
        const status = normalizeAlgoStatus(query.order.algoStatus);
        await this.applyProtectionObservation(order, query.order, status, input.evaluatedAt);
        observed.push({ order, status, dto: query.order });
      } else if (query.outcome === "NOT_FOUND_CONFIRMED") {
        // Binance PROVED this exact id does not exist. There is nothing left
        // for this sibling to cancel, which is a resolved state â€” collapsing it
        // into UNKNOWN is what left the first real canary stuck forever.
        observed.push({ order, status: "ABSENT", dto: null });
      } else {
        observed.push({ order, status: "UNKNOWN", dto: null });
      }
    }

    const stopFilled = observed.find((entry) => entry.order.role === "STOP_LOSS" && entry.status === "FILLED");
    const takeProfitFilled = observed.find((entry) => entry.order.role === "TAKE_PROFIT" && entry.status === "FILLED");
    const emergency = await this.loadOrder(execution.id, "EMERGENCY_CLOSE", 1);

    const closure = classifyClosure({
      stopStatus: stopFilled ? "FILLED" : null,
      takeProfitStatus: takeProfitFilled ? "FILLED" : null,
      emergencyFilled: emergency?.status === "FILLED",
      remainingPositionQuantity: remaining,
    });

    if (closure.partialProtectionExit) {
      // A protection order fired but exposure remains: never a clean closure.
      await this.alerts.raise({
        tradeExecutionId: execution.id,
        alertType: "PROTECTION_COVERAGE_INCOMPLETE",
        reasonCode: "PARTIAL_PROTECTION_EXIT",
        details: {
          symbol: execution.symbol,
          positionSide,
          confirmedOpenQuantity: remaining,
          protectionState: "PROTECTION_INCOMPLETE",
          requiredAction: "A protection order filled while exposure remains; review coverage.",
        },
      });
      return this.escalate(execution, "PARTIAL_PROTECTION_EXIT", "Protection filled but exposure remains.", input);
    }

    if (!closure.positionClosed) {
      return this.outcome(false, "PROTECTION_COVERAGE_INCOMPLETE", "Position is still open.", execution, protection);
    }

    // ---------------------------------------------------------------------
    // STEP 1: neutralize the remaining ENTRY order BEFORE touching protection.
    //
    // A partially filled entry (0.10 of 0.25) whose protection closes the 0.10
    // leaves the position momentarily flat while the remaining 0.15 is STILL
    // WORKING. Tearing down protection first would leave a window in which the
    // entry refills into a completely unprotected position.
    // ---------------------------------------------------------------------
    const entryCleanup = await this.cleanupEntryRemainder(execution, input);
    if (entryCleanup.action === "BLOCK_UNRESOLVED") {
      await this.setProtectionState(protection.id, "CLOSURE_CLEANUP", entryCleanup.reasonCode!, entryCleanup.message!);
      await this.alerts.raise({
        tradeExecutionId: execution.id,
        alertType: "ORPHAN_PROTECTION_ORDER",
        reasonCode: entryCleanup.reasonCode!,
        details: {
          symbol: execution.symbol,
          positionSide,
          protectionState: "CLOSURE_CLEANUP",
          requiredAction: "Resolve the remaining entry order before the execution can be closed.",
        },
      });
      // Protection siblings are deliberately LEFT IN PLACE: an unresolved
      // entry could still refill, and it must not refill unprotected.
      return this.outcome(false, entryCleanup.reasonCode!, entryCleanup.message!, execution, await this.loadProtection(execution.id));
    }

    // STEP 2/3: the position must STILL be flat after entry cleanup.
    const afterCleanup = await this.readPosition(execution.symbol, positionSide);
    if (afterCleanup === "UNAVAILABLE") {
      return this.outcome(
        false,
        "ENTRY_ORDER_STATE_UNAVAILABLE_DURING_CLOSURE",
        "Position could not be re-read after entry cleanup.",
        execution,
        protection
      );
    }
    const afterQuantity =
      afterCleanup === null ? "0" : normalizeOpenQuantity(afterCleanup.quantity, direction).quantity;
    const refill = classifyPostCleanupPosition(afterQuantity);

    if (refill.action === "REFILLED_RECOVER_PROTECTION") {
      // The entry filled during cancellation. This is NOT a closed trade:
      // exposure exists again and needs protection, computed as the missing
      // coverage only. No entry is ever resubmitted and no opposite order sent.
      await this.setProtectionState(protection.id, "PROTECTION_INCOMPLETE", refill.reasonCode!, refill.message!);
      await this.alerts.raise({
        tradeExecutionId: execution.id,
        alertType: "PROTECTION_COVERAGE_INCOMPLETE",
        reasonCode: refill.reasonCode!,
        details: {
          symbol: execution.symbol,
          positionSide,
          confirmedOpenQuantity: afterQuantity,
          protectionState: "PROTECTION_INCOMPLETE",
          requiredAction: "The entry refilled during closure; protection is being restored.",
        },
      });
      const current = await this.loadExecution(execution.id);
      return this.ensureProtectionForExposure({ ...input, expectedVersion: current.version });
    }
    if (refill.action === "BLOCK_UNRESOLVED") {
      return this.outcome(false, refill.reasonCode!, refill.message!, execution, protection);
    }

    // STEP 4-6: the entry can no longer refill, so cleanup is now unrestricted.
    const siblings: SiblingCandidate[] = observed.map((entry) => ({
      clientAlgoId: entry.order.clientAlgoId!,
      role: entry.order.role as "STOP_LOSS" | "TAKE_PROFIT",
      generation: entry.order.generation,
      status: entry.status,
    }));
    const plan = planSiblingCancellation({ siblings, positionClosed: true });

    // An order whose state could not be read is NOT proof that there is
    // nothing left to cancel â€” cleanup stays incomplete until we can see it.
    // A CONFIRMED-ABSENT sibling is different: Binance proved that exact id
    // does not exist, so there is provably nothing to cancel.
    let cleanupComplete = !observed.some((entry) => entry.status === "UNKNOWN");
    for (const sibling of plan.cancel) {
      const cancelled = await this.cancelSibling(execution, sibling, input.evaluatedAt);
      if (!cancelled) cleanupComplete = false;
    }

    if (!cleanupComplete) {
      await this.setProtectionState(protection.id, "CLOSURE_CLEANUP", "SIBLING_CLEANUP_INCOMPLETE", "Sibling cleanup is unresolved.");
      await this.alerts.raise({
        tradeExecutionId: execution.id,
        alertType: "SIBLING_CANCELLATION_FAILED",
        reasonCode: "SIBLING_CLEANUP_INCOMPLETE",
        details: {
          symbol: execution.symbol,
          positionSide,
          protectionState: "CLOSURE_CLEANUP",
          requiredAction: "Cancel the remaining protection orders manually.",
        },
      });
      return this.outcome(
        false,
        "SIBLING_CLEANUP_INCOMPLETE",
        "Position is closed but sibling cleanup is unresolved.",
        execution,
        await this.loadProtection(execution.id)
      );
    }

    // Only now may a terminal status be recorded.
    const targetStatus =
      closure.reason === "TAKE_PROFIT"
        ? "CLOSED_TP"
        : closure.reason === "STOP_LOSS"
          ? "CLOSED_SL"
          : closure.reason === "EMERGENCY"
            ? "CLOSED_EMERGENCY"
            : null;

    if (!targetStatus) {
      // The position is PROVEN flat, the entry can no longer refill and every
      // owned sibling is absent, terminal or verifiably cancelled â€” but no
      // owned order filled, so we cannot say what closed it. A manual operator
      // close, another client, a liquidation and ADL are indistinguishable from
      // here, so the execution is terminalized as an unattributed EXTERNAL
      // close rather than mislabelled as one of ours.
      //
      // Without this the execution stayed MANUAL_INTERVENTION forever and kept
      // recoveryRequiredCount at 1, blocking all new work â€” exactly what the
      // first real canary left behind after the operator closed it by hand.
      //
      // ORDERING IS LOAD-BEARING, and mirrors the SL/TP/emergency path below:
      // the TradeExecution is terminalized FIRST and the protection row is
      // marked CLOSED only after that commit succeeds. Closing protection first
      // can produce protection=CLOSED with a non-terminal execution, and
      // resumeProtectionLifecycle then returns early on that CLOSED row forever
      // â€” a half-terminal durable state that strands the execution for good.
      const current = await this.loadExecution(execution.id);
      const currentStatus = current.status as TradeExecutionStatusName;

      if (isTerminalStatus(currentStatus)) {
        // Another reconciliation winner already terminalized this execution.
        // Its attribution is authoritative and is never overwritten; protection
        // is safe to close because the execution is already final.
        await this.setProtectionState(protection.id, "CLOSED", "PROTECTION_VERIFIED", "Position is flat.");
        return this.outcome(true, "PROTECTION_VERIFIED", "Execution is already terminal.", current, await this.loadProtection(execution.id));
      }

      if (!canTransition(currentStatus, "CLOSED_EXTERNAL").allowed) {
        // No terminal state may be recorded from here, so protection must stay
        // open: marking it CLOSED would strand a non-terminal execution.
        return this.outcome(
          false,
          "PROTECTION_COVERAGE_INCOMPLETE",
          `Position is flat with no owned protection fill, but ${currentStatus} cannot record an external closure.`,
          current,
          await this.loadProtection(execution.id)
        );
      }

      const externallyClosed = await this.commitExecutionChange(current, current.version, {
        status: "CLOSED_EXTERNAL",
        reasonCode: "PROTECTION_VERIFIED",
        message:
          "Position is provably flat and every owned protection identity is resolved, but no owned order " +
          "filled; the closure is external and unattributed.",
        eventType: "PROTECTION_CLEANUP",
        actuals: {
          // Deliberately NO actualExitPrice, realizedPnl or fees: none of them
          // is known, and inventing them would corrupt the journal.
          exitReason: "EXTERNAL",
          closedAt: input.evaluatedAt,
          lastReconciledAt: input.evaluatedAt,
        },
        clearManualIntervention: true,
      });
      if (!externallyClosed) {
        // Lost the version race. Protection is deliberately LEFT OPEN so the
        // next tick can retry the whole proof; closing it here would leave a
        // non-terminal execution that resumeProtectionLifecycle skips forever.
        return this.outcome(false, "CAPACITY_OR_VERSION_CONFLICT", "Version changed during external closure.", current, await this.loadProtection(execution.id));
      }

      // Terminal is durable; only now is protection safe to close.
      await this.setProtectionState(protection.id, "CLOSED", "PROTECTION_VERIFIED", "Position is flat.");

      return this.outcome(
        true,
        "PROTECTION_VERIFIED",
        "Position is flat with no owned protection fill; closed as external.",
        externallyClosed,
        await this.loadProtection(execution.id)
      );
    }

    const exitOrder = closure.reason === "TAKE_PROFIT" ? takeProfitFilled : closure.reason === "STOP_LOSS" ? stopFilled : null;
    const committed = await this.commitExecutionChange(execution, input.expectedVersion, {
      status: targetStatus,
      reasonCode: "PROTECTION_VERIFIED",
      message: `Position closed via ${closure.reason}; all sibling protection was cancelled.`,
      eventType: "PROTECTION_CLEANUP",
      actuals: {
        actualExitPrice: exitOrder?.dto?.averagePrice ? new D(exitOrder.dto.averagePrice) : undefined,
        exitReason: closure.reason,
        closedAt: input.evaluatedAt,
        lastReconciledAt: input.evaluatedAt,
      },
    });
    if (!committed) {
      return this.outcome(false, "CAPACITY_OR_VERSION_CONFLICT", "Version changed during closure.", execution, protection);
    }

    await this.setProtectionState(protection.id, "CLOSED", "PROTECTION_VERIFIED", `Closed via ${closure.reason}.`);
    return this.outcome(true, "PROTECTION_VERIFIED", `Position closed via ${closure.reason}.`, committed, await this.loadProtection(execution.id));
  }

  // ==========================================================================
  // Protection advancement: reserve tranche -> STOP -> TP -> verify
  // ==========================================================================

  private async advanceProtection(
    execution: TradeExecution,
    openQuantity: string,
    position: PositionSnapshot,
    input: ProtectionLifecycleInput
  ): Promise<ProtectionOutcome> {
    const direction = execution.direction as DirectionName;
    const positionSide = protectionPositionSide(direction);

    // Current verified aggregate coverage, refreshed from the exchange.
    const coverageNow = await this.measureVerifiedCoverage(execution);
    const coverage = calculateCoverage({
      confirmedOpenQuantity: openQuantity,
      activeStopQuantity: coverageNow.stop,
      activeTakeProfitQuantity: coverageNow.takeProfit,
    });

    const protection = await this.ensureProtectionRow(execution.id);
    await this.prisma.executionProtectionState.update({
      where: { id: protection.id },
      data: {
        protectedStopQuantity: new D(coverageNow.stop),
        protectedTakeProfitQuantity: new D(coverageNow.takeProfit),
      },
    });

    if (coverage.overProtected) {
      // More protection than exposure means the exchange is reporting
      // something we did not intend â€” an identity contradiction or an order we
      // do not own. It is never silently accepted as "protected".
      await this.alerts.raise({
        tradeExecutionId: execution.id,
        alertType: "ORPHAN_PROTECTION_ORDER",
        reasonCode: "PROTECTION_COVERAGE_INCOMPLETE",
        details: {
          symbol: execution.symbol,
          positionSide,
          confirmedOpenQuantity: openQuantity,
          protectedStopQuantity: coverageNow.stop,
          requiredAction: "Protection exceeds exposure; reconcile the protection orders manually.",
        },
      });
      return this.escalate(
        execution,
        "PROTECTION_COVERAGE_INCOMPLETE",
        `Protection exceeds exposure (stop ${coverageNow.stop}, take profit ${coverageNow.takeProfit}, exposure ${openQuantity}).`,
        input
      );
    }

    if (coverage.fullyCovered) {
      await this.setProtectionState(
        protection.id,
        "PROTECTED",
        "PROTECTION_VERIFIED",
        "Aggregate coverage matches exposure.",
        input.evaluatedAt,
        {
          confirmedOpenQuantity: openQuantity,
          protectedStopQuantity: coverageNow.stop,
          protectedTakeProfitQuantity: coverageNow.takeProfit,
          verifiedAt: input.evaluatedAt,
        }
      );
      // The execution row must say so too, or the position reads as merely
      // filled to every consumer of `status`.
      const protectedExecution = await this.markExecutionProtected(
        execution.id,
        "Aggregate protection covers the full position."
      );
      return this.outcome(
        true,
        "PROTECTION_VERIFIED",
        "Position is fully protected.",
        protectedExecution,
        await this.loadProtection(execution.id)
      );
    }

    // Resolve any half-finished tranche before creating a new one.
    const pending = await this.findIncompleteTranche(execution);

    // FAIL CLOSED ON AN UNRESOLVED OBSERVATION.
    //
    // Reaching here means coverage looks short. But a leg whose exchange state
    // could not be read contributes zero, so "short" may simply mean "we could
    // not look". Minting a REPLACEMENT generation on that evidence submits a
    // fresh STOP *and* TAKE_PROFIT under new ids â€” the tranche model always
    // reserves the pair â€” while the originals may still be live on Binance.
    //
    // So a new generation requires the gap to be PROVEN: every leg either
    // observed active or conclusively absent. Resuming an already-reserved
    // tranche (`pending`) is deliberately still allowed: it re-uses the same
    // deterministic clientAlgoId and mints no new identity.
    //
    // This defers rather than escalates: nothing is known to be wrong, only
    // unreadable, and the next tick asks again. The protection row is left
    // untouched so repeated unreadable ticks cause no state churn.
    if (pending === null && coverage.missingQuantity !== "0" && coverageNow.unresolved.length > 0) {
      const reasonCode: ProtectionReasonCode = coverageNow.unresolved.includes("STOP_LOSS")
        ? "STOP_QUERY_UNAVAILABLE"
        : "TAKE_PROFIT_QUERY_UNAVAILABLE";
      const message =
        `Protection state is unreadable for ${coverageNow.unresolved.join(" and ")}; ` +
        "refusing to reserve a replacement tranche until the exchange state is known.";
      logger.warn(
        {
          executionId: execution.id,
          unresolved: coverageNow.unresolved,
          measuredStop: coverageNow.stop,
          measuredTakeProfit: coverageNow.takeProfit,
          confirmedOpenQuantity: openQuantity,
        },
        "Protection coverage could not be resolved; deferring repair"
      );
      return this.outcome(false, reasonCode, message, execution, await this.loadProtection(execution.id));
    }

    // A resumed tranche writes nothing, so it keeps this call's incoming
    // version; a fresh reservation reports the version it committed.
    const reserved: ReservedTranche | ProtectionOutcome =
      pending === null
        ? await this.reserveNextTranche(execution, coverage.missingQuantity, position, input)
        : { generation: pending, expectedVersion: input.expectedVersion };

    if (!("generation" in reserved)) return reserved; // a failure outcome

    return this.submitTranche(execution, reserved.generation, position, {
      ...input,
      expectedVersion: reserved.expectedVersion,
    });
  }

  /** The lowest generation whose STOP or TP is not yet verified active. */
  private async findIncompleteTranche(execution: TradeExecution): Promise<number | null> {
    const orders = await this.loadProtectionOrders(execution.id);
    const generations = [...new Set(orders.map((order) => order.generation))].sort((a, b) => a - b);
    for (const generation of generations) {
      const stop = orders.find((order) => order.role === "STOP_LOSS" && order.generation === generation);
      const takeProfit = orders.find((order) => order.role === "TAKE_PROFIT" && order.generation === generation);
      const incomplete =
        !stop ||
        !takeProfit ||
        ["PLANNED", "SUBMITTING", "UNKNOWN"].includes(stop.status) ||
        ["PLANNED", "SUBMITTING", "UNKNOWN"].includes(takeProfit.status);
      if (incomplete) return generation;
    }
    return null;
  }

  /**
   * Reserves one paired STOP_LOSS + TAKE_PROFIT tranche for exactly the
   * missing delta, in ONE transaction, before any exchange call.
   */
  private async reserveNextTranche(
    execution: TradeExecution,
    missingQuantity: string,
    position: PositionSnapshot,
    input: ProtectionLifecycleInput
  ): Promise<ReservedTranche | ProtectionOutcome> {
    const direction = execution.direction as DirectionName;
    const positionSide = protectionPositionSide(direction);
    const side = closingSide(direction);

    if (new D(missingQuantity).lessThanOrEqualTo(0)) {
      return this.outcome(true, "PROTECTION_VERIFIED", "No missing coverage.", execution, await this.loadProtection(execution.id));
    }

    // Frozen triggers only â€” never recalculated, never rounded here.
    const stopTrigger = execution.executableStopLoss.toString();
    const takeProfitTrigger = execution.takeProfit?.toString() ?? null;

    let inspection;
    try {
      inspection = await this.readOnly.inspectSymbol(execution.symbol);
    } catch {
      return this.outcome(false, "POSITION_STATE_UNAVAILABLE", "Symbol state could not be read.", execution);
    }
    if ((inspection.filters.status ?? "").toUpperCase() !== "TRADING") {
      return this.outcome(false, "PROTECTION_FILTER_MISMATCH", "Symbol is no longer TRADING.", execution);
    }
    if ((inspection.filters.contractType ?? "").toUpperCase() !== "PERPETUAL") {
      return this.outcome(false, "PROTECTION_FILTER_MISMATCH", "Symbol is no longer PERPETUAL.", execution);
    }

    const validation = validateProtectionTriggers({
      direction,
      stopTriggerPrice: stopTrigger,
      takeProfitTriggerPrice: takeProfitTrigger,
      workingPrice: position.markPrice,
      tickSize: inspection.filters.tickSize,
      stepSize: inspection.filters.stepSize,
      minQty: inspection.filters.minQty,
      quantity: missingQuantity,
    });
    if (!validation.valid) {
      await this.alerts.raise({
        tradeExecutionId: execution.id,
        alertType: "STOP_NOT_VERIFIED",
        reasonCode: validation.reasonCode!,
        details: {
          symbol: execution.symbol,
          positionSide,
          confirmedOpenQuantity: missingQuantity,
          requiredAction: "The frozen protection is incompatible with current exchange state; protect manually.",
        },
      });
      return this.escalate(execution, validation.reasonCode!, validation.message ?? "Protection is invalid.", input);
    }

    const generation = (await this.highestGeneration(execution.id)) + 1;
    // The role -> workingType rule lives in ONE place, shared with the demo
    // verifier so the two cannot disagree about what a TAKE_PROFIT sends.
    const policy: ProtectionPolicy = {
      stopWorkingType: env.EXECUTION_SL_WORKING_TYPE,
      takeProfitWorkingType: env.EXECUTION_TP_WORKING_TYPE,
      priceProtect: env.EXECUTION_PROTECTION_PRICE_PROTECT,
    };
    const workingTypeStop = protectionWorkingType("STOP_LOSS", policy);
    const workingTypeTakeProfit = protectionWorkingType("TAKE_PROFIT", policy);
    const priceProtect = policy.priceProtect;

    const committed = await this.prisma.$transaction(async (tx) => {
      // Serialize per (profile, symbol, positionSide) so two concurrent
      // protectors cannot create the same generation or over-protect.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PROTECTION_LOCK_NAMESPACE}::int, ${protectionLockKey(
        execution.executionProfileId,
        execution.symbol,
        positionSide
      )}::int)`;

      const updated = await tx.tradeExecution.updateMany({
        where: { id: execution.id, version: input.expectedVersion },
        data: { version: { increment: 1 } },
      });
      if (updated.count === 0) return null;

      const next = await tx.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });

      for (const role of ["STOP_LOSS", "TAKE_PROFIT"] as const) {
        const trigger = role === "STOP_LOSS" ? stopTrigger : takeProfitTrigger;
        if (!trigger) continue;
        await tx.binanceOrder.create({
          data: {
            tradeExecutionId: execution.id,
            role,
            generation,
            clientOrderId: buildClientOrderId(execution.id, role, generation),
            clientAlgoId: buildClientOrderId(execution.id, role, generation),
            side,
            positionSide,
            orderType: role === "STOP_LOSS" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
            originalQuantity: new D(missingQuantity),
            triggerPrice: new D(trigger),
            // Frozen into the intent so a retry cannot silently change policy.
            workingType: protectionWorkingType(role, policy),
            priceProtect,
            status: "SUBMITTING",
          },
        });
      }

      await tx.executionEvent.create({
        data: {
          tradeExecutionId: execution.id,
          sequenceNumber: next.version,
          eventType: "PROTECTION_RESERVED",
          fromStatus: execution.status,
          toStatus: next.status,
          reasonCode: "PROTECTION_COVERAGE_INCOMPLETE",
          message: `Reserved protection generation ${generation} for ${missingQuantity}.`,
          metadata: { generation, quantity: missingQuantity, workingTypeStop, workingTypeTakeProfit } as Prisma.InputJsonValue,
        },
      });

      const state = await tx.executionProtectionState.findUnique({ where: { tradeExecutionId: execution.id } });
      if (state) {
        await tx.executionProtectionState.update({
          where: { id: state.id },
          data: { currentGeneration: generation, state: "PLACING_STOP" },
        });
      }

      return next;
    }).catch((error: unknown) => {
      // A concurrent reservation won the lock race.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "CONFLICT" as const;
      throw error;
    });

    if (committed === "CONFLICT") {
      // Another tick reserved first. THIS call wrote nothing, so it still owns
      // the version it came in with â€” adopting a newer one would inherit the
      // other tick's evidence along with it.
      const existing = await this.findIncompleteTranche(execution);
      if (existing) return { generation: existing, expectedVersion: input.expectedVersion };
      return this.outcome(false, "PROTECTION_GENERATION_CONFLICT", "A concurrent tranche was created.", execution);
    }
    if (!committed) {
      return this.outcome(false, "CAPACITY_OR_VERSION_CONFLICT", "Version changed; nothing was reserved.", execution);
    }

    // The reservation advanced the row, so everything later in THIS call â€” an
    // escalation above all â€” must CAS against the version it produced.
    return { generation, expectedVersion: committed.version };
  }

  /** Submits STOP first, verifies it, and only then submits TP. */
  private async submitTranche(
    execution: TradeExecution,
    generation: number,
    position: PositionSnapshot,
    input: ProtectionLifecycleInput
  ): Promise<ProtectionOutcome> {
    const protection = await this.ensureProtectionRow(execution.id);

    const stop = await this.loadOrder(execution.id, "STOP_LOSS", generation);
    if (!stop) {
      return this.outcome(false, "STOP_INTENT_CONFLICT", "No stop reservation exists for this tranche.", execution, protection);
    }

    // Protection placement is starting. This is the single funnel for BOTH a
    // freshly reserved tranche and a resumed incomplete one, so recording it
    // here covers every path that submits.
    //
    // It commits a version bump when it actually promotes the execution, so the
    // rest of this call â€” the escalation below in particular â€” must CAS against
    // that new version. When it promotes nothing, `committedVersion` is null and
    // the incoming version still stands.
    const placing = await this.recordProtectionStatus(
      execution.id,
      "PLACING_PROTECTION",
      "Placing protection for the confirmed fill."
    );
    const owned: ProtectionLifecycleInput =
      placing.committedVersion === null ? input : { ...input, expectedVersion: placing.committedVersion };

    const stopResult = await this.submitAndVerifyProtection(execution, stop, input.evaluatedAt);
    if (!stopResult.verified) {
      // DEFERRED, NOT FAILED. An unreadable existence query says nothing is
      // wrong â€” only that we could not look. Escalating here would park the
      // execution at MANUAL_INTERVENTION, which today has no automatic
      // protection-restoration path, so a transient query blip would strand a
      // live position permanently. The reserved tranche stays incomplete and
      // the next tick asks again.
      if (isUnreadableProtectionState(stopResult.reasonCode)) {
        return this.outcome(false, stopResult.reasonCode, stopResult.message, execution, protection);
      }

      await this.setProtectionState(protection.id, "PROTECTION_INCOMPLETE", stopResult.reasonCode, stopResult.message);
      await this.alerts.raise({
        tradeExecutionId: execution.id,
        alertType: stopResult.reasonCode === "STOP_SUBMISSION_RESULT_UNKNOWN" ? "STOP_SUBMISSION_UNKNOWN" : "STOP_NOT_VERIFIED",
        reasonCode: stopResult.reasonCode,
        details: {
          symbol: execution.symbol,
          positionSide: protectionPositionSide(execution.direction as DirectionName),
          confirmedOpenQuantity: protection.confirmedOpenQuantity.toString(),
          protectedStopQuantity: protection.protectedStopQuantity.toString(),
          protectionState: "PROTECTION_INCOMPLETE",
          requiredAction: "Verify or place the stop manually.",
        },
      });

      // The stop could not be verified â€” consider the last-resort close.
      return this.considerEmergencyClose(execution, protection, stopResult.reasonCode, owned);
    }

    await this.setProtectionState(protection.id, "STOP_VERIFIED", "PROTECTION_VERIFIED", "Stop is verified active.");

    const takeProfit = await this.loadOrder(execution.id, "TAKE_PROFIT", generation);
    if (!takeProfit) {
      // A plan with no take profit: a verified stop is the whole protection.
      return this.verifyAggregateCoverage(execution, owned);
    }

    await this.setProtectionState(protection.id, "PLACING_TAKE_PROFIT", null, null);
    const takeProfitResult = await this.submitAndVerifyProtection(execution, takeProfit, input.evaluatedAt);
    if (!takeProfitResult.verified) {
      // Same deferral as the stop: unreadable is not failed, so it raises no
      // critical alert and rewrites no protection state. The verified STOP is
      // untouched either way.
      if (isUnreadableProtectionState(takeProfitResult.reasonCode)) {
        return this.outcome(false, takeProfitResult.reasonCode, takeProfitResult.message, execution, protection);
      }

      // The verified STOP is retained â€” never cancelled because TP failed.
      await this.setProtectionState(
        protection.id,
        "PROTECTION_INCOMPLETE",
        takeProfitResult.reasonCode,
        "Stop is verified; take profit is not."
      );
      await this.alerts.raise({
        tradeExecutionId: execution.id,
        alertType: "PROTECTION_COVERAGE_INCOMPLETE",
        reasonCode: takeProfitResult.reasonCode,
        details: {
          symbol: execution.symbol,
          protectionState: "PROTECTION_INCOMPLETE",
          requiredAction: "Stop is in place; place the take profit manually.",
        },
      });
      return this.outcome(false, takeProfitResult.reasonCode, "Take profit is not verified; the stop remains active.", execution, await this.loadProtection(execution.id));
    }

    return this.verifyAggregateCoverage(execution, owned);
  }

  /**
   * Submits ONE protection order and proves the result by querying the same
   * clientAlgoId. A timeout is never treated as failure.
   */
  private async submitAndVerifyProtection(
    execution: TradeExecution,
    order: BinanceOrder,
    evaluatedAt: Date
  ): Promise<{ verified: boolean; reasonCode: ProtectionReasonCode; message: string }> {
    const role = order.role as "STOP_LOSS" | "TAKE_PROFIT";
    const unknownCode: ProtectionReasonCode =
      role === "STOP_LOSS" ? "STOP_SUBMISSION_RESULT_UNKNOWN" : "TAKE_PROFIT_SUBMISSION_RESULT_UNKNOWN";
    const notVerifiedCode: ProtectionReasonCode = role === "STOP_LOSS" ? "STOP_NOT_VERIFIED" : "TAKE_PROFIT_NOT_VERIFIED";
    const mismatchCode: ProtectionReasonCode = role === "STOP_LOSS" ? "STOP_IDENTITY_MISMATCH" : "TAKE_PROFIT_IDENTITY_MISMATCH";

    const queryUnavailableCode: ProtectionReasonCode =
      role === "STOP_LOSS" ? "STOP_QUERY_UNAVAILABLE" : "TAKE_PROFIT_QUERY_UNAVAILABLE";

    // Look before leaping: a crash may already have placed this exact order.
    let existing = await this.queryProtection(execution.symbol, order.clientAlgoId!);

    // FAIL CLOSED WHEN EXISTENCE CANNOT BE DETERMINED.
    //
    // Only two answers settle it: the exchange returned the order, or it
    // PROVED this exact id does not exist (-2013). A timeout, 5xx, rate limit
    // or auth failure settles nothing â€” and this branch used to submit on all
    // of them alike, firing a fresh POST every tick for as long as the query
    // stayed unreadable.
    //
    // Re-sending the same deterministic clientAlgoId is NOT provably
    // idempotent here. This codebase deliberately restricts the -4116
    // duplicate semantic to SUBMIT_ORDER (DUPLICATE_PROVING_OPERATIONS), so a
    // duplicate clientAlgoId on the Algo endpoint classifies as RESULT_UNKNOWN
    // â€” the architecture's own position is that a duplicate response proves
    // nothing for algo orders. Submitting on unreadable evidence therefore
    // risks a real second mutation, not a harmless replay.
    //
    // The reserved SUBMITTING intent is left exactly as it is: the tranche
    // stays incomplete, so the next tick resumes it and asks again. Nothing is
    // marked absent, rejected or verified, and no new identity is minted.
    if (existing.outcome !== "CONFIRMED_ACCEPTED" && existing.outcome !== "NOT_FOUND_CONFIRMED") {
      logger.warn(
        {
          executionId: execution.id,
          role,
          generation: order.generation,
          clientAlgoId: order.clientAlgoId,
          outcome: existing.outcome,
        },
        "Protection existence could not be determined; deferring submission"
      );
      return {
        verified: false,
        reasonCode: queryUnavailableCode,
        message: "Protection existence could not be determined; submission deferred until the state is readable.",
      };
    }

    if (existing.outcome !== "CONFIRMED_ACCEPTED") {
      let outcome: MutationOutcome = "CONFIRMED_ACCEPTED";
      try {
        const context = this.mutations.authorizeProtectionSubmission({
          executionId: execution.id,
          symbol: execution.symbol,
          role,
          generation: order.generation,
          clientAlgoId: order.clientAlgoId!,
          side: order.side as "BUY" | "SELL",
          positionSide: order.positionSide as "LONG" | "SHORT",
          quantity: order.originalQuantity.toString(),
          triggerPrice: order.triggerPrice!.toString(),
          workingType: (order.workingType ?? "MARK_PRICE") as WorkingTypeName,
          priceProtect: order.priceProtect ?? false,
        });
        await this.mutations.submitProtectionOrder(context);
      } catch (error) {
        outcome = classifyMutationOutcome(this.asFailureShape(error), "SUBMIT_ALGO");
        if (outcome === "CONFIRMED_REJECTED") {
          await this.prisma.binanceOrder.update({ where: { id: order.id }, data: { status: "REJECTED" } });
          return {
            verified: false,
            reasonCode: role === "STOP_LOSS" ? "STOP_SUBMISSION_REJECTED" : "TAKE_PROFIT_SUBMISSION_REJECTED",
            message: "Protection submission was rejected.",
          };
        }
      }

      // Bounded reconciliation on the SAME clientAlgoId â€” never a new id.
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        existing = await this.queryProtection(execution.symbol, order.clientAlgoId!);
        if (existing.outcome === "CONFIRMED_ACCEPTED") break;
        await this.prisma.binanceOrder.update({
          where: { id: order.id },
          data: { reconcileAttempts: { increment: 1 }, lastReconcileAt: evaluatedAt, status: "UNKNOWN" },
        });
      }
      if (existing.outcome !== "CONFIRMED_ACCEPTED" || !existing.order) {
        return { verified: false, reasonCode: unknownCode, message: "Protection state could not be resolved." };
      }
    }

    const observedOrder = existing.order!;
    const mismatches = findProtectionIdentityMismatches(
      {
        clientAlgoId: order.clientAlgoId!,
        symbol: execution.symbol,
        orderType: order.orderType as "STOP_MARKET" | "TAKE_PROFIT_MARKET",
        side: order.side as "BUY" | "SELL",
        positionSide: order.positionSide as "LONG" | "SHORT",
        quantity: order.originalQuantity.toString(),
        triggerPrice: order.triggerPrice!.toString(),
        workingType: order.workingType ?? "MARK_PRICE",
        priceProtect: order.priceProtect ?? false,
      },
      {
        clientAlgoId: observedOrder.clientAlgoId,
        symbol: observedOrder.symbol,
        orderType: observedOrder.orderType,
        side: observedOrder.side,
        positionSide: observedOrder.positionSide,
        quantity: observedOrder.quantity,
        triggerPrice: observedOrder.triggerPrice,
        workingType: observedOrder.workingType,
        priceProtect: observedOrder.priceProtect,
        closePosition: observedOrder.closePosition,
        reduceOnly: observedOrder.reduceOnly,
      }
    );

    if (mismatches.length > 0) {
      // Never rewrite local intent to match a contradictory response.
      return { verified: false, reasonCode: mismatchCode, message: `Identity mismatch: ${mismatches.join(", ")}.` };
    }

    const status = normalizeAlgoStatus(observedOrder.algoStatus);
    await this.applyProtectionObservation(order, observedOrder, status, evaluatedAt);

    if (!countsAsActiveCoverage(status)) {
      return { verified: false, reasonCode: notVerifiedCode, message: `Protection is ${status}, not active.` };
    }
    return { verified: true, reasonCode: "PROTECTION_VERIFIED", message: "Protection is verified active." };
  }

  /** Re-measures aggregate coverage from the exchange and records the result. */
  private async verifyAggregateCoverage(
    execution: TradeExecution,
    input: ProtectionLifecycleInput
  ): Promise<ProtectionOutcome> {
    const direction = execution.direction as DirectionName;
    const positionSide = protectionPositionSide(direction);
    const protection = await this.ensureProtectionRow(execution.id);

    const position = await this.readPosition(execution.symbol, positionSide);
    if (position === "UNAVAILABLE" || position === null) {
      return this.outcome(false, "POSITION_STATE_UNAVAILABLE", "Position could not be re-read.", execution, protection);
    }
    const open = normalizeOpenQuantity(position.quantity, direction).quantity;
    const measured = await this.measureVerifiedCoverage(execution);

    const coverage = calculateCoverage({
      confirmedOpenQuantity: open,
      activeStopQuantity: measured.stop,
      activeTakeProfitQuantity: measured.takeProfit,
    });

    const state: ProtectionState = coverage.fullyCovered && !coverage.overProtected ? "PROTECTED" : "PROTECTION_INCOMPLETE";
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.executionProtectionState.update({
        where: { id: protection.id },
        data: {
          confirmedOpenQuantity: new D(open),
          protectedStopQuantity: new D(measured.stop),
          protectedTakeProfitQuantity: new D(measured.takeProfit),
          state,
          reasonCode: state === "PROTECTED" ? "PROTECTION_VERIFIED" : "PROTECTION_COVERAGE_INCOMPLETE",
          verifiedAt: state === "PROTECTED" ? input.evaluatedAt : null,
          // A change counter, not an optimistic lock (nothing guards on it).
          // Advancing it per state write is what gives each verification a
          // distinct, collision-free identity in the history below.
          version: { increment: 1 },
        },
      });
      // History is appended only for a PROVEN verification, never for a gap.
      if (state === "PROTECTED") {
        await this.appendVerification(tx, updated, {
          confirmedOpenQuantity: open,
          protectedStopQuantity: measured.stop,
          protectedTakeProfitQuantity: measured.takeProfit,
          verifiedAt: input.evaluatedAt,
        });
      }
    });

    if (state !== "PROTECTED") {
      // A remaining gap means another tranche is required â€” say so plainly.
      return this.outcome(
        false,
        "PROTECTION_COVERAGE_INCOMPLETE",
        `Coverage is incomplete: stop ${measured.stop}, take profit ${measured.takeProfit}, exposure ${open}.`,
        execution,
        await this.loadProtection(execution.id)
      );
    }

    const protectedExecution = await this.markExecutionProtected(
      execution.id,
      "Aggregate protection covers the full position."
    );
    return this.outcome(
      true,
      "PROTECTION_VERIFIED",
      "Aggregate protection covers the full position.",
      protectedExecution,
      await this.loadProtection(execution.id)
    );
  }

  /**
   * Records the SUCCESS half of the protection lifecycle on the execution ROW.
   *
   * Until this existed the service could commit every way protection goes
   * WRONG â€” MANUAL_INTERVENTION, CLOSED_TP/SL/EMERGENCY, CLOSED_EXTERNAL â€” and
   * no way it goes right. `ExecutionProtectionState` reached PROTECTED while
   * `TradeExecution.status` stayed ENTRY_FILLED forever, which is exactly what
   * Mainnet Canary #3 showed: full verified coverage on both legs, 70
   * consecutive verifications, and a status that still claimed the position
   * was merely filled.
   *
   * Deliberately narrow:
   *
   *  - IDEMPOTENT. Already at the target means no commit, no event, no version
   *    churn â€” the reconciliation tick repeats indefinitely.
   *  - ONE legal hop only, and only along the documented path
   *    ENTRY_FILLED -> PLACING_PROTECTION -> PROTECTED. The caller walks the
   *    two hops in order, so no new state-machine edge is needed.
   *  - PARTIALLY_FILLED IS NEVER MOVED. A partial entry still has a resting
   *    order consuming pending-entry capacity; promoting it would release that
   *    capacity while the remainder is still live on the book.
   *  - A lost version race is not an error. The next tick re-derives the same
   *    conclusion from the exchange and tries again.
   */
  private async recordProtectionStatus(
    executionId: string,
    target: "PLACING_PROTECTION" | "PROTECTED",
    message: string
  ): Promise<RecordedProtectionStatus> {
    const current = await this.loadExecution(executionId);
    const status = current.status as TradeExecutionStatusName;

    if (status === target) return { execution: current, committedVersion: null };

    // Only the documented predecessor may advance, which is what keeps
    // PARTIALLY_FILLED (and every terminal state) untouched.
    const requiredFrom = target === "PLACING_PROTECTION" ? "ENTRY_FILLED" : "PLACING_PROTECTION";
    if (status !== requiredFrom) return { execution: current, committedVersion: null };
    if (!canTransition(status, target).allowed) return { execution: current, committedVersion: null };

    const committed = await this.commitExecutionChange(current, current.version, {
      status: target,
      reasonCode: "PROTECTION_VERIFIED",
      message,
      eventType: target === "PLACING_PROTECTION" ? "PROTECTION_SUBMITTED" : "PROTECTION_VERIFIED",
      // PROTECTED is the first moment a recovered execution is provably healthy:
      // aggregate coverage has been re-measured against the exchange and matches
      // exposure. A recovery deliberately carries requiresManualIntervention
      // through PLACING_PROTECTION, so this is where it is finally released â€”
      // never earlier, and never on a partial repair. On the ordinary path the
      // flag is already false and this writes the same value.
      ...(target === "PROTECTED" ? { clearManualIntervention: true } : {}),
    });

    // `committedVersion` is non-null ONLY when this call itself advanced the
    // row, so a caller can thread it forward without ever inheriting another
    // tick's version.
    return { execution: committed ?? current, committedVersion: committed?.version ?? null };
  }

  /**
   * Walks ENTRY_FILLED -> PLACING_PROTECTION -> PROTECTED in order.
   *
   * Both hops are attempted because protection can legitimately be discovered
   * already complete â€” after a restart, or on a tick where the tranche was
   * placed by a previous run â€” in which case the execution has never been
   * moved off ENTRY_FILLED and must still end up PROTECTED.
   */
  private async markExecutionProtected(executionId: string, message: string): Promise<TradeExecution> {
    await this.recordProtectionStatus(executionId, "PLACING_PROTECTION", message);
    return (await this.recordProtectionStatus(executionId, "PROTECTED", message)).execution;
  }

  /**
   * Aggregate VERIFIED coverage, proven against the exchange rather than local
   * rows alone.
   */
  private async measureVerifiedCoverage(execution: TradeExecution): Promise<VerifiedCoverage> {
    const orders = await this.loadProtectionOrders(execution.id);
    let stop = new D(0);
    let takeProfit = new D(0);
    const unresolved = new Set<"STOP_LOSS" | "TAKE_PROFIT">();

    for (const order of orders) {
      const role = order.role as "STOP_LOSS" | "TAKE_PROFIT";

      // An order we already know is finished cannot be contributing coverage,
      // so an unreadable query about it establishes nothing new. Skipping it
      // here is what stops a long-dead generation 1 from blocking the health
      // path forever once a generation 2 has replaced it.
      if (LOCALLY_RESOLVED_ORDER_STATUSES.includes(order.status)) continue;

      const query = await this.queryProtection(execution.symbol, order.clientAlgoId!);

      // THE ABSENT-VS-UNKNOWN BOUNDARY.
      //
      // Only two answers are conclusive: the exchange returned the order, or
      // it PROVED the exact id does not exist (-2013). Everything else â€” a
      // timeout, a 5xx, a rate limit, an auth failure, an unparseable body â€”
      // means we could not determine the state at all.
      //
      // This used to `continue` on all of them alike, so an unreadable leg was
      // counted as ZERO coverage and was indistinguishable from a confirmed
      // absent one. The lifecycle then saw a gap and minted a REPLACEMENT
      // generation, submitting a duplicate STOP and TAKE_PROFIT while the
      // originals may well have still been live on Binance.
      if (query.outcome === "CONFIRMED_ACCEPTED" && query.order) {
        const status = normalizeAlgoStatus(query.order.algoStatus);
        if (!countsAsActiveCoverage(status)) continue; // proven inactive
        const quantity = new D(query.order.quantity ?? order.originalQuantity.toString());
        if (role === "STOP_LOSS") stop = stop.plus(quantity);
        else takeProfit = takeProfit.plus(quantity);
        continue;
      }

      if (query.outcome === "NOT_FOUND_CONFIRMED") continue; // proven absent

      unresolved.add(role);
    }

    return { stop: stop.toString(), takeProfit: takeProfit.toString(), unresolved: [...unresolved] };
  }

  // ==========================================================================
  // Margin top-up
  // ==========================================================================

  private async attemptMarginTopUp(
    execution: TradeExecution,
    position: PositionSnapshot,
    openQuantity: string,
    input: ProtectionLifecycleInput
  ): Promise<{ resolved: boolean; reasonCode: ProtectionReasonCode; message: string }> {
    const positionSide = protectionPositionSide(execution.direction as DirectionName);

    // Reconcile any earlier unresolved ADD before considering another one.
    const unresolved = await this.prisma.marginAdjustmentIntent.findFirst({
      where: { tradeExecutionId: execution.id, status: { in: ["SUBMITTING", "RESULT_UNKNOWN"] } },
      orderBy: { attempt: "desc" },
    });
    if (unresolved) {
      const reconciled = await this.reconcileMarginIntent(execution, unresolved.id, input.evaluatedAt);
      if (!reconciled) {
        return { resolved: false, reasonCode: "MARGIN_TOP_UP_RESULT_UNKNOWN", message: "A previous margin ADD is unresolved." };
      }
    }

    let availableBalance: string | null = null;
    try {
      availableBalance = (await this.readOnly.getAccountSummary()).usdtAvailableBalance;
    } catch {
      return { resolved: false, reasonCode: "MARGIN_STATE_UNAVAILABLE", message: "Balance could not be read." };
    }

    const allowance = calculateMarginTopUp({
      maximumIsolatedMargin: execution.maximumIsolatedMargin.toString(),
      verifiedCurrentIsolatedMargin: position.isolatedMargin,
      availableBalance,
      autoAddMarginEnabled: env.EXECUTION_AUTO_ADD_MARGIN_ENABLED,
    });

    if (!allowance.allowed) {
      return { resolved: false, reasonCode: allowance.reasonCode ?? "MARGIN_BUDGET_EXHAUSTED", message: "No margin may be added." };
    }

    // Durable intent BEFORE the POST, with the baseline needed to prove
    // afterwards whether the ADD landed.
    const attempt = (await this.prisma.marginAdjustmentIntent.count({ where: { tradeExecutionId: execution.id } })) + 1;
    const intent = await this.prisma.marginAdjustmentIntent.create({
      data: {
        tradeExecutionId: execution.id,
        attempt,
        symbol: execution.symbol,
        positionSide,
        adjustType: 1,
        amount: new D(allowance.amount),
        baselineIsolatedMargin: position.isolatedMargin ? new D(position.isolatedMargin) : null,
        baselinePositionAmt: new D(openQuantity),
        baselineLiquidationPrice: position.liquidationPrice ? new D(position.liquidationPrice) : null,
        status: "SUBMITTING",
        requestedAt: input.evaluatedAt,
      },
    });

    let outcome: MutationOutcome = "CONFIRMED_ACCEPTED";
    try {
      await this.mutations.addIsolatedMargin(
        this.mutations.authorizeMarginAddition({ symbol: execution.symbol, positionSide, amount: allowance.amount })
      );
    } catch (error) {
      outcome = classifyMutationOutcome(this.asFailureShape(error), "SUBMIT_CONFIG");
      if (outcome === "CONFIRMED_REJECTED") {
        await this.prisma.marginAdjustmentIntent.update({
          where: { id: intent.id },
          data: { status: "REJECTED", reasonCode: "MARGIN_TOP_UP_REJECTED", resolvedAt: input.evaluatedAt },
        });
        return { resolved: false, reasonCode: "MARGIN_TOP_UP_REJECTED", message: "Margin ADD was rejected." };
      }
      await this.prisma.marginAdjustmentIntent.update({
        where: { id: intent.id },
        data: { status: "RESULT_UNKNOWN", reasonCode: "MARGIN_TOP_UP_RESULT_UNKNOWN" },
      });
    }

    const reconciled = await this.reconcileMarginIntent(execution, intent.id, input.evaluatedAt);
    if (!reconciled) {
      return { resolved: false, reasonCode: "MARGIN_TOP_UP_RESULT_UNKNOWN", message: "Margin ADD result is unresolved." };
    }
    return { resolved: true, reasonCode: "PROTECTION_VERIFIED", message: "Margin was topped up within the frozen cap." };
  }

  /**
   * Proves whether an ADD landed by re-reading the position (and, if needed,
   * the margin history) rather than by trusting the POST response.
   */
  private async reconcileMarginIntent(execution: TradeExecution, intentId: string, evaluatedAt: Date): Promise<boolean> {
    const intent = await this.prisma.marginAdjustmentIntent.findUnique({ where: { id: intentId } });
    if (!intent) return false;

    const position = await this.readPosition(execution.symbol, intent.positionSide);
    if (position === "UNAVAILABLE" || position === null || position.isolatedMargin === null) return false;

    const verified = new D(position.isolatedMargin);
    // The cap is enforced on the VERIFIED total, so retries can never
    // accumulate past the frozen maximum.
    if (!isWithinMarginCap(verified.toString(), execution.maximumIsolatedMargin.toString())) {
      await this.prisma.marginAdjustmentIntent.update({
        where: { id: intent.id },
        data: { status: "REJECTED", reasonCode: "MARGIN_TOP_UP_VERIFICATION_FAILED", verifiedIsolatedMargin: verified, resolvedAt: evaluatedAt },
      });
      return false;
    }

    const baseline = intent.baselineIsolatedMargin ? new D(intent.baselineIsolatedMargin) : null;
    const landed = baseline !== null && verified.greaterThan(baseline);

    await this.prisma.marginAdjustmentIntent.update({
      where: { id: intent.id },
      data: {
        status: landed ? "CONFIRMED" : "RESULT_UNKNOWN",
        verifiedIsolatedMargin: verified,
        resolvedAt: landed ? evaluatedAt : null,
        reasonCode: landed ? null : "MARGIN_TOP_UP_RESULT_UNKNOWN",
      },
    });

    if (landed) {
      await this.prisma.tradeExecution.update({
        where: { id: execution.id },
        data: { actualIsolatedMargin: verified, lastReconciledAt: evaluatedAt },
      });
    }
    return landed;
  }

  // ==========================================================================
  // Emergency close
  // ==========================================================================

  private async considerEmergencyClose(
    execution: TradeExecution,
    protection: ExecutionProtectionState,
    stopReason: ProtectionReasonCode,
    input: ProtectionLifecycleInput
  ): Promise<ProtectionOutcome> {
    const direction = execution.direction as DirectionName;
    const positionSide = protectionPositionSide(direction);
    const measured = await this.measureVerifiedCoverage(execution);

    const eligibility = evaluateEmergencyCloseEligibility({
      mode: env.EXECUTION_EMERGENCY_CLOSE_MODE,
      confirmedOpenQuantity: protection.confirmedOpenQuantity.toString(),
      activeStopQuantity: measured.stop,
      stopVerified: new D(measured.stop).greaterThan(0),
      positionIdentityKnown: true,
      reconciliationAttemptsExhausted: true,
    });

    if (!eligibility.eligible) {
      // DISABLED (or not eligible): park for a human, send nothing to Binance.
      await this.alerts.raise({
        tradeExecutionId: execution.id,
        alertType: "STOP_NOT_VERIFIED",
        reasonCode: eligibility.reasonCode ?? "EMERGENCY_CLOSE_NOT_ELIGIBLE",
        details: {
          symbol: execution.symbol,
          positionSide,
          confirmedOpenQuantity: protection.confirmedOpenQuantity.toString(),
          protectedStopQuantity: measured.stop,
          protectionState: "PROTECTION_INCOMPLETE",
          requiredAction: "Stop is unverified and emergency close is not eligible; intervene manually.",
        },
      });
      return this.escalate(execution, stopReason, "Stop is unverified; emergency close is not eligible.", input);
    }

    return this.executeEmergencyClose(execution, protection, input);
  }

  /** Reserves the emergency intent, then submits the one branded MARKET close. */
  private async executeEmergencyClose(
    execution: TradeExecution,
    protection: ExecutionProtectionState,
    input: ProtectionLifecycleInput
  ): Promise<ProtectionOutcome> {
    const direction = execution.direction as DirectionName;
    const positionSide = protectionPositionSide(direction);
    const quantity = protection.confirmedOpenQuantity.toString();
    const clientOrderId = buildClientOrderId(execution.id, "EMERGENCY_CLOSE", 1);

    let order = await this.loadOrder(execution.id, "EMERGENCY_CLOSE", 1);
    if (!order) {
      // Durable intent before the mutation. Generation 2 is never created.
      order = await this.prisma.binanceOrder.create({
        data: {
          tradeExecutionId: execution.id,
          role: "EMERGENCY_CLOSE",
          generation: 1,
          clientOrderId,
          side: closingSide(direction),
          positionSide,
          orderType: "MARKET",
          originalQuantity: new D(quantity),
          status: "SUBMITTING",
        },
      });
      await this.setProtectionState(protection.id, "EMERGENCY_CLOSING", "EMERGENCY_CLOSE_NOT_ELIGIBLE", "Emergency close reserved.");
      await this.alerts.raise({
        tradeExecutionId: execution.id,
        alertType: "EMERGENCY_CLOSE_STARTED",
        reasonCode: "STOP_NOT_VERIFIED",
        details: { symbol: execution.symbol, positionSide, confirmedOpenQuantity: quantity, protectionState: "EMERGENCY_CLOSING" },
      });
    }

    try {
      await this.mutations.submitEmergencyMarketClose(
        this.mutations.authorizeEmergencyClose({
          executionId: execution.id,
          symbol: execution.symbol,
          side: closingSide(direction),
          positionSide,
          quantity,
          clientOrderId,
        })
      );
    } catch (error) {
      const outcome = classifyMutationOutcome(this.asFailureShape(error), "SUBMIT_ORDER");
      if (outcome === "CONFIRMED_REJECTED") {
        await this.alerts.raise({
          tradeExecutionId: execution.id,
          alertType: "EMERGENCY_CLOSE_FAILED",
          reasonCode: "EMERGENCY_CLOSE_SUBMISSION_REJECTED",
          details: { symbol: execution.symbol, positionSide, confirmedOpenQuantity: quantity, requiredAction: "Close the position manually." },
        });
        return this.escalate(execution, "EMERGENCY_CLOSE_SUBMISSION_REJECTED", "Emergency close was rejected.", input);
      }
      // Unknown: never a second client id â€” reconcile the same one.
    }

    return this.reconcileEmergencyClose(execution, await this.loadOrder(execution.id, "EMERGENCY_CLOSE", 1), input);
  }

  /** Proves the close by querying the same order id AND the actual position. */
  private async reconcileEmergencyClose(
    execution: TradeExecution,
    order: BinanceOrder | null,
    input: ProtectionLifecycleInput
  ): Promise<ProtectionOutcome> {
    const direction = execution.direction as DirectionName;
    const positionSide = protectionPositionSide(direction);
    const protection = await this.ensureProtectionRow(execution.id);

    if (order) {
      try {
        const queried = await this.readOnly.queryOrderByClientOrderId(execution.symbol, order.clientOrderId);
        await this.prisma.binanceOrder.update({
          where: { id: order.id },
          data: {
            exchangeOrderId: order.exchangeOrderId ?? queried.orderId ?? undefined,
            status: (queried.status ?? "").toUpperCase() === "FILLED" ? "FILLED" : order.status,
            executedQuantity: queried.executedQty ? new D(queried.executedQty) : undefined,
            averageFillPrice: queried.averagePrice ? new D(queried.averagePrice) : undefined,
            lastExchangeUpdateAt: input.evaluatedAt,
          },
        });
      } catch {
        // Query unavailable â€” the position check below is the real proof.
      }
    }

    const position = await this.readPosition(execution.symbol, positionSide);
    if (position === "UNAVAILABLE") {
      return this.outcome(false, "EMERGENCY_CLOSE_RESULT_UNKNOWN", "Position could not be verified.", execution, protection);
    }

    const remaining = position === null ? "0" : normalizeOpenQuantity(position.quantity, direction).quantity;
    if (new D(remaining).greaterThan(0)) {
      await this.alerts.raise({
        tradeExecutionId: execution.id,
        alertType: "EMERGENCY_CLOSE_FAILED",
        reasonCode: "EMERGENCY_CLOSE_VERIFICATION_FAILED",
        details: { symbol: execution.symbol, positionSide, confirmedOpenQuantity: remaining, requiredAction: "Exposure remains after emergency close." },
      });
      return this.escalate(execution, "EMERGENCY_CLOSE_VERIFICATION_FAILED", "Exposure remains after the emergency close.", input);
    }

    // Confirmed flat â€” clean up siblings and record the terminal state.
    return this.reconcileProtectionAndClosure(input);
  }

  // ==========================================================================
  // Entry-remainder cleanup
  // ==========================================================================

  /**
   * Neutralizes the original LIMIT entry before a terminal closure.
   *
   * Reuses the Phase 6 BRANDED risk-reducing recovery-cancellation path, so
   * the cancellation stays limited to this execution's own ENTRY generation 1
   * and its persisted deterministic client order id. No generic cancellation
   * method exists, and no external order can be addressed.
   *
   * The entry is never resubmitted and no generation 2 is ever created: a
   * protection exit terminates the trade plan.
   */
  private async cleanupEntryRemainder(
    execution: TradeExecution,
    input: ProtectionLifecycleInput
  ): Promise<{ action: string; reasonCode: ProtectionReasonCode | null; message: string | null }> {
    const entry = await this.loadOrder(execution.id, "ENTRY", 1);
    if (!entry) {
      // No entry reservation at all (e.g. a synthetic or externally created
      // position): nothing can refill from our side.
      return { action: "NO_REMAINDER", reasonCode: null, message: null };
    }

    const observed = await this.queryEntryOrder(execution.symbol, entry.clientOrderId);
    const identityMismatches =
      observed.order === null
        ? []
        : findEntryIdentityMismatches(
            {
              symbol: execution.symbol,
              side: entry.side as "BUY" | "SELL",
              positionSide: entry.positionSide as "LONG" | "SHORT",
              orderType: entry.orderType,
              price: entry.price?.toString() ?? "0",
              originalQuantity: entry.originalQuantity.toString(),
              clientOrderId: entry.clientOrderId,
            },
            {
              symbol: observed.order.symbol,
              side: observed.order.side,
              positionSide: observed.order.positionSide,
              orderType: observed.order.type,
              price: observed.order.price,
              originalQuantity: observed.order.origQty,
              clientOrderId: observed.order.clientOrderId,
            }
          );

    const entryStatus: LocalEntryStatus =
      observed.order === null
        ? "UNKNOWN"
        : (mapExchangeToLocalOrderStatus(normalizeExchangeOrderStatus(observed.order.status)) as LocalEntryStatus);

    // A confirmed "does not exist" is treated as terminal only when Binance
    // positively said so; a transport failure is not.
    const stateUnavailable = observed.order === null && observed.outcome !== "NOT_FOUND_CONFIRMED";

    let decision = decideEntryRemainderCleanup({
      entryStatus,
      entryStateUnavailable: stateUnavailable,
      identityMismatches,
    });

    if (observed.order === null && observed.outcome === "NOT_FOUND_CONFIRMED") {
      // Binance confirms there is no such order: it cannot refill.
      decision = { action: "NO_REMAINDER", reasonCode: null, message: null };
    }

    if (decision.action !== "CANCEL_REMAINDER") {
      if (decision.action === "BLOCK_UNRESOLVED" && identityMismatches.length > 0) {
        // Never cancel an order whose identity contradicts our intent.
        await this.escalate(execution, "ENTRY_REMAINDER_CLEANUP_FAILED", decision.message!, input);
      }
      return decision;
    }

    // Persist the observed fill BEFORE cancelling, so historical filled
    // quantity is never lost.
    if (observed.order?.executedQty) {
      const observedFill = new D(observed.order.executedQty);
      if (observedFill.greaterThan(entry.executedQuantity)) {
        await this.prisma.binanceOrder.update({
          where: { id: entry.id },
          data: { executedQuantity: observedFill },
        });
      }
    }

    try {
      // The Phase 6 branded context: this execution, ENTRY, generation 1 only.
      const context = this.mutations.authorizeEntryCancellation({
        executionId: execution.id,
        symbol: execution.symbol,
        clientOrderId: entry.clientOrderId,
        role: "ENTRY",
        generation: 1,
        reason: "OPERATOR_RECOVERY",
      });
      await this.mutations.cancelReservedEntryOrder(context);
    } catch (error) {
      const outcome = classifyMutationOutcome(this.asFailureShape(error), "CANCEL");
      if (outcome === "CONFIRMED_REJECTED") {
        return {
          action: "BLOCK_UNRESOLVED",
          reasonCode: "ENTRY_REMAINDER_CLEANUP_FAILED",
          message: "The entry-remainder cancellation was rejected.",
        };
      }
      // Unknown: the query below decides, never the DELETE response.
    }

    const after = await this.queryEntryOrder(execution.symbol, entry.clientOrderId);
    if (after.order === null && after.outcome !== "NOT_FOUND_CONFIRMED") {
      return {
        action: "BLOCK_UNRESOLVED",
        reasonCode: "ENTRY_ORDER_STATE_UNAVAILABLE_DURING_CLOSURE",
        message: "The entry order could not be re-read after cancellation.",
      };
    }

    const finalStatus: LocalEntryStatus =
      after.order === null
        ? "CANCELED"
        : (mapExchangeToLocalOrderStatus(normalizeExchangeOrderStatus(after.order.status)) as LocalEntryStatus);

    if (!["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(finalStatus)) {
      return {
        action: "BLOCK_UNRESOLVED",
        reasonCode: "ENTRY_REMAINDER_CLEANUP_FAILED",
        message: `The entry order is still ${finalStatus} after cancellation.`,
      };
    }

    // Persist the terminal state, preserving monotonic fill data.
    const finalFill = after.order?.executedQty ? new D(after.order.executedQty) : new D(entry.executedQuantity);
    await this.prisma.binanceOrder.update({
      where: { id: entry.id },
      data: {
        status: finalStatus,
        executedQuantity: finalFill.greaterThan(entry.executedQuantity) ? finalFill : undefined,
        cancelConfirmedAt: input.evaluatedAt,
        lastReconcileAt: input.evaluatedAt,
      },
    });

    return { action: "NO_REMAINDER", reasonCode: null, message: null };
  }

  private async queryEntryOrder(symbol: string, clientOrderId: string) {
    try {
      const order = await this.readOnly.queryOrderByClientOrderId(symbol, clientOrderId);
      return { outcome: "CONFIRMED_ACCEPTED" as MutationOutcome, order };
    } catch (error) {
      return { outcome: classifyMutationOutcome(this.asFailureShape(error)), order: null };
    }
  }

  // ==========================================================================
  // Sibling cancellation
  // ==========================================================================

  /** Cancels one sibling and PROVES the result with a follow-up query. */
  private async cancelSibling(execution: TradeExecution, sibling: SiblingCandidate, evaluatedAt: Date): Promise<boolean> {
    try {
      const context = this.mutations.authorizeProtectionCancellation({
        executionId: execution.id,
        symbol: execution.symbol,
        role: sibling.role,
        generation: sibling.generation,
        clientAlgoId: sibling.clientAlgoId,
      });
      await this.mutations.cancelProtectionOrder(context);
    } catch (error) {
      const outcome = classifyMutationOutcome(this.asFailureShape(error), "CANCEL");
      if (outcome === "CONFIRMED_REJECTED") return false;
      // Unknown: the query below decides, never the DELETE response.
    }

    const after = await this.queryProtection(execution.symbol, sibling.clientAlgoId);
    if (after.outcome !== "CONFIRMED_ACCEPTED" || !after.order) return false;

    const status = normalizeAlgoStatus(after.order.algoStatus);
    const order = await this.prisma.binanceOrder.findFirst({ where: { clientAlgoId: sibling.clientAlgoId } });
    if (order) await this.applyProtectionObservation(order, after.order, status, evaluatedAt);

    return !countsAsActiveCoverage(status);
  }

  // ==========================================================================
  // Persistence helpers
  // ==========================================================================

  private async applyProtectionObservation(
    order: BinanceOrder,
    observed: BinanceAlgoOrderDto,
    status: NormalizedProtectionStatus,
    evaluatedAt: Date
  ): Promise<void> {
    const previousExecuted = new D(order.executedQuantity);
    const observedExecuted = observed.executedQuantity ? new D(observed.executedQuantity) : previousExecuted;
    // Fills only ever move forward.
    const executed = observedExecuted.greaterThan(previousExecuted) ? observedExecuted : previousExecuted;

    await this.prisma.binanceOrder.update({
      where: { id: order.id },
      data: {
        // Immutable once known.
        exchangeAlgoId: order.exchangeAlgoId ?? observed.algoId ?? undefined,
        actualOrderId: order.actualOrderId ?? observed.actualOrderId ?? undefined,
        algoStatus: observed.algoStatus ?? undefined,
        status: this.toLocalOrderStatus(status),
        executedQuantity: executed,
        averageFillPrice:
          observed.averagePrice && new D(observed.averagePrice).greaterThan(0)
            ? new D(observed.averagePrice)
            : undefined,
        triggeredAt: order.triggeredAt ?? (observed.triggerTimeMs ? new Date(observed.triggerTimeMs) : undefined),
        lastExchangeUpdateAt: observed.updateTimeMs ? new Date(observed.updateTimeMs) : evaluatedAt,
        lastReconcileAt: evaluatedAt,
      },
    });
  }

  private toLocalOrderStatus(status: NormalizedProtectionStatus) {
    switch (status) {
      case "ACTIVE":
      case "TRIGGERED":
        return "NEW" as const;
      case "PARTIALLY_FILLED":
        return "PARTIALLY_FILLED" as const;
      case "FILLED":
        return "FILLED" as const;
      case "CANCELED":
        return "CANCELED" as const;
      case "EXPIRED":
        return "EXPIRED" as const;
      case "REJECTED":
        return "REJECTED" as const;
      default:
        return "UNKNOWN" as const;
    }
  }

  private async recordActualPositionFields(
    execution: TradeExecution,
    position: PositionSnapshot,
    evaluatedAt: Date
  ): Promise<void> {
    await this.prisma.tradeExecution.update({
      where: { id: execution.id },
      data: {
        reportedLiquidationPrice: position.liquidationPrice ? new D(position.liquidationPrice) : undefined,
        actualIsolatedMargin: position.isolatedMargin ? new D(position.isolatedMargin) : undefined,
        actualLeverage: position.leverage && Number.isSafeInteger(Number(position.leverage)) ? Number(position.leverage) : undefined,
        lastReconciledAt: evaluatedAt,
      },
    });
  }

  /**
   * One transaction: execution status, actual fields, version increment, the
   * protection state, any critical alert, and one event. A failing event rolls
   * all of it back â€” and so does a lost CAS.
   *
   * The protection row and the alert are OPTIONAL participants rather than
   * separate writes because they are claims ABOUT the execution transition. A
   * write that happens whether or not the transition commits is a claim the
   * execution never made: escalation used to park
   * `ExecutionProtectionState.state = MANUAL_INTERVENTION` and raise a critical
   * alert BEFORE this CAS, so a stale tick whose park correctly lost still left
   * the protection row asserting MANUAL_INTERVENTION over a healthy PROTECTED
   * execution, and still alerted a human about an intervention that never
   * happened. Both now live or die with the CAS.
   */
  private async commitExecutionChange(
    execution: TradeExecution,
    expectedVersion: number,
    change: {
      status?: string;
      reasonCode: ProtectionReasonCode;
      message: string;
      eventType: "PROTECTION_RESERVED" | "PROTECTION_SUBMITTED" | "PROTECTION_VERIFIED" | "PROTECTION_RECONCILED" | "MARGIN_ADJUSTED" | "EMERGENCY_CLOSE_SUBMITTED" | "PROTECTION_CLEANUP" | "MANUAL_INTERVENTION_REQUIRED";
      requiresManualIntervention?: boolean;
      /**
       * Clears the manual-intervention flag. Only a terminal transition backed
       * by exchange proof may set this â€” it is what releases the execution from
       * the recovery-required count.
       */
      clearManualIntervention?: boolean;
      actuals?: Prisma.TradeExecutionUpdateManyMutationInput;
      /** Structured evidence for the event journal. Never read back as state. */
      metadata?: Prisma.InputJsonValue;
      /**
       * Protection state to write ATOMICALLY with the transition. Applied only
       * once the CAS has been won, so it can never describe a transition that
       * did not happen.
       */
      protectionState?: {
        id: string;
        state: ProtectionState;
        reasonCode: ProtectionReasonCode | null;
        message: string | null;
      };
      /** Critical alert raised only if the transition actually commits. */
      criticalAlert?: Parameters<CriticalAlertService["raiseInTransaction"]>[1];
    }
  ): Promise<TradeExecution | null> {
    return this.prisma.$transaction(async (tx) => {
      // The AUTHORITATIVE source status, read inside the transaction. The
      // caller's `execution` may be older than `expectedVersion` â€” several
      // paths load it before an intervening reservation bumps the version â€”
      // so validating against it could judge a transition that is not the one
      // about to be written.
      const current = await tx.tradeExecution.findUnique({ where: { id: execution.id } });
      if (!current) return null;

      // CAS FIRST, then legality. Order matters: if the row has already moved
      // on, this write is an ordinary lost race and must stay one. Validating
      // before the version check would turn a benign concurrent update into a
      // hard invariant failure â€” e.g. a row already CLOSED_TP while this
      // caller still holds an older version.
      if (current.version !== expectedVersion) return null;

      // A same-status write is a field-only update, not a transition, and is
      // intentionally supported (`escalate` re-stamps a parked execution to
      // append an event). `canTransition` models almost no self-transitions,
      // so it must not be consulted for one.
      const from = current.status as TradeExecutionStatusName;
      const to = change.status as TradeExecutionStatusName | undefined;
      if (to !== undefined && to !== from) {
        const check = canTransition(from, to);
        if (!check.allowed) {
          // Nothing is written and no event is created: throwing inside the
          // transaction rolls back anything this function has begun.
          throw new IllegalExecutionTransitionError(execution.id, from, to, check.reason);
        }
      }

      const updated = await tx.tradeExecution.updateMany({
        where: { id: execution.id, version: expectedVersion },
        data: {
          ...(change.actuals ?? {}),
          ...(change.status ? { status: change.status as TradeExecution["status"] } : {}),
          version: { increment: 1 },
          decisionReasonCode: change.reasonCode,
          sanitizedMessage: change.message.slice(0, 1000),
          ...(change.requiresManualIntervention ? { requiresManualIntervention: true } : {}),
          ...(change.clearManualIntervention ? { requiresManualIntervention: false } : {}),
        },
      });
      if (updated.count === 0) return null;

      // Past the CAS: this transition is happening, so its claims may be made.
      if (change.protectionState) {
        await tx.executionProtectionState.update({
          where: { id: change.protectionState.id },
          data: {
            state: change.protectionState.state,
            reasonCode: change.protectionState.reasonCode ?? undefined,
            sanitizedMessage: change.protectionState.message?.slice(0, 1000) ?? undefined,
            version: { increment: 1 },
          },
        });
      }
      if (change.criticalAlert) await this.alerts.raiseInTransaction(tx, change.criticalAlert);

      const next = await tx.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
      await tx.executionEvent.create({
        data: {
          tradeExecutionId: execution.id,
          sequenceNumber: next.version,
          eventType: change.eventType,
          // The status the row actually moved FROM, not the caller's snapshot.
          fromStatus: from,
          toStatus: next.status,
          reasonCode: change.reasonCode,
          message: change.message.slice(0, 1000),
          ...(change.metadata === undefined ? {} : { metadata: change.metadata }),
        },
      });
      return next;
    });
  }

  private async escalate(
    execution: TradeExecution,
    reasonCode: ProtectionReasonCode,
    message: string,
    input: ProtectionLifecycleInput
  ): Promise<ProtectionOutcome> {
    const protection = await this.ensureProtectionRow(execution.id);

    // NOTHING ESCALATION-SPECIFIC IS WRITTEN BEFORE THE CAS.
    //
    // The protection park and the critical alert used to be issued here, ahead
    // of the transition they describe. Both then survived a lost CAS, so a
    // stale tick left `ExecutionProtectionState.state = MANUAL_INTERVENTION`
    // and a queued human alert sitting on top of an execution another tick had
    // just verified as PROTECTED with the manual flag cleared. Correctness
    // cannot depend on a later healthy tick tidying that up.
    //
    // They are now passed INTO the transition and applied only after its CAS
    // wins, so the two authoritative rows move together or not at all.

    // EVIDENCE AND VERSION STAY COUPLED.
    //
    // `input.expectedVersion` is not merely a concurrency detail here â€” it is
    // what ties this escalation to the exchange evidence that justified it. A
    // tick that observed a failure at version N must LOSE the CAS once another
    // tick has advanced the row, because that other tick acted on newer
    // evidence. Reloading the row and adopting whatever version it now holds
    // breaks the coupling: a slow tick could park an execution a faster one had
    // just verified as PROTECTED, and PROTECTED -> MANUAL_INTERVENTION being a
    // LEGAL transition is precisely why the state machine cannot catch it.
    // Legality and freshness are separate requirements.
    //
    // The other half of the problem is real too: THIS call may legitimately
    // advance the version before escalating â€” reserveNextTranche and
    // recordProtectionStatus both commit â€” and an escalation that follows one
    // of its OWN writes must still land. That is solved by THREADING the new
    // version forward from the writer that produced it (see advanceProtection
    // and submitTranche), never by re-reading the row here.
    //
    // So: a version this call caused is threaded in and the park succeeds; a
    // version another tick caused is not, and the park correctly loses.
    const committed = await this.commitExecutionChange(execution, input.expectedVersion, {
      status: execution.status === "MANUAL_INTERVENTION" ? undefined : "MANUAL_INTERVENTION",
      reasonCode,
      message,
      eventType: "MANUAL_INTERVENTION_REQUIRED",
      requiresManualIntervention: true,
      protectionState: { id: protection.id, state: "MANUAL_INTERVENTION", reasonCode, message },
      criticalAlert: isCriticalReason(reasonCode)
        ? {
            tradeExecutionId: execution.id,
            alertType: reasonCode === "POSITION_IDENTITY_MISMATCH" ? "POSITION_IDENTITY_CONFLICT" : "STOP_NOT_VERIFIED",
            reasonCode,
            details: {
              symbol: execution.symbol,
              positionSide: protectionPositionSide(execution.direction as DirectionName),
              protectionState: "MANUAL_INTERVENTION",
              requiredAction: message,
            },
          }
        : undefined,
    });

    return this.outcome(false, reasonCode, message, committed ?? execution, await this.loadProtection(execution.id));
  }

  // ==========================================================================
  // Read helpers
  // ==========================================================================

  /** "UNAVAILABLE" = could not read; null = no such position. */
  private async readPosition(symbol: string, positionSide: string): Promise<PositionSnapshot | null | "UNAVAILABLE"> {
    try {
      const row = await this.readOnly.getPositionForSide(symbol, positionSide);
      if (!row) return null;
      return {
        quantity: row.positionAmt ?? "0",
        entryPrice: row.entryPrice,
        markPrice: row.markPrice,
        liquidationPrice: row.liquidationPrice,
        isolatedMargin: row.isolatedMargin,
        isolatedWallet: row.isolatedWallet,
        leverage: row.leverage,
        marginAsset: null,
        updateTimeMs: null,
      };
    } catch {
      return "UNAVAILABLE";
    }
  }

  /**
   * Queries ONE protection order by its deterministic client algo id.
   *
   * Three outcomes matter to the caller and must never be conflated:
   *
   *   CONFIRMED_ACCEPTED  â€” the order exists; `order` carries its state;
   *   NOT_FOUND_CONFIRMED â€” Binance proved this exact id does not exist;
   *   anything else       â€” we do not know, and absence must not be inferred.
   *
   * For a QUERY, absence is proven by -2013 (NO_SUCH_ORDER) and by nothing
   * else. -2011 is CANCEL_REJECTED, documented only in the cancel context, so
   * it says nothing about a GET and stays RESULT_UNKNOWN here. A timeout, a
   * 5xx, an auth failure, a rate limit or an unparseable reply likewise remain
   * unknown, because none of them says anything about the order.
   */
  private async queryProtection(
    symbol: string,
    clientAlgoId: string,
    context?: { executionId: string; role: string; generation: number }
  ): Promise<{ outcome: MutationOutcome; order: BinanceAlgoOrderDto | null }> {
    try {
      const order = await this.readOnly.queryAlgoOrderByClientAlgoId(symbol, clientAlgoId);
      return { outcome: "CONFIRMED_ACCEPTED", order };
    } catch (error) {
      const failure = this.asFailureShape(error);
      const outcome = classifyMutationOutcome(failure);
      if (context) {
        this.logProtectionFailure({
          stage: "QUERY",
          executionId: context.executionId,
          role: context.role,
          generation: context.generation,
          clientAlgoId,
          endpoint: "queryAlgoOrder",
          outcome,
          failure,
        });
      }
      return { outcome, order: null };
    }
  }

  private async loadExecution(executionId: string): Promise<TradeExecution> {
    const execution = await this.prisma.tradeExecution.findUnique({ where: { id: executionId } });
    if (!execution) throw new NotFoundError(`Execution ${executionId} not found.`);
    return execution;
  }

  private async ensureProtectionRow(executionId: string): Promise<ExecutionProtectionState> {
    const existing = await this.prisma.executionProtectionState.findUnique({ where: { tradeExecutionId: executionId } });
    if (existing) return existing;
    try {
      return await this.prisma.executionProtectionState.create({ data: { tradeExecutionId: executionId } });
    } catch {
      return this.prisma.executionProtectionState.findUniqueOrThrow({ where: { tradeExecutionId: executionId } });
    }
  }

  private async loadProtection(executionId: string): Promise<ExecutionProtectionState | null> {
    return this.prisma.executionProtectionState.findUnique({ where: { tradeExecutionId: executionId } });
  }

  private async setProtectionState(
    id: string,
    state: ProtectionState,
    reasonCode: ProtectionReasonCode | null,
    message: string | null,
    verifiedAt?: Date,
    coverage?: VerifiedCoverageSnapshot
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.executionProtectionState.update({
        where: { id },
        data: {
          state,
          reasonCode: reasonCode ?? undefined,
          sanitizedMessage: message?.slice(0, 1000) ?? undefined,
          verifiedAt: verifiedAt ?? undefined,
          version: { increment: 1 },
        },
      });
      if (coverage) await this.appendVerification(tx, updated, coverage);
    });
  }

  /**
   * Appends the durable proof that coverage was verified complete at this
   * protection version.
   *
   * The protection row itself is mutable and only ever shows the LATEST
   * coverage, so an observer that was offline across "protected 0.10" then
   * "protected 0.25" could never learn the first happened. This append-only row
   * is that history.
   *
   * Written inside the caller's transaction â€” it is history, not a side effect,
   * and it involves no network call, no Telegram and no notification table.
   * `upsert` rather than `create` so this bookkeeping can never be the thing
   * that fails a protection transaction.
   */
  private async appendVerification(
    tx: Prisma.TransactionClient,
    protection: ExecutionProtectionState,
    coverage: VerifiedCoverageSnapshot
  ): Promise<void> {
    const row = {
      state: protection.state,
      confirmedOpenQuantity: new D(coverage.confirmedOpenQuantity),
      protectedStopQuantity: new D(coverage.protectedStopQuantity),
      protectedTakeProfitQuantity: new D(coverage.protectedTakeProfitQuantity),
      liquidationSafe: protection.liquidationSafe,
      generation: protection.currentGeneration,
      verifiedAt: coverage.verifiedAt,
    };
    await tx.executionProtectionVerification.upsert({
      where: {
        tradeExecutionId_protectionVersion: {
          tradeExecutionId: protection.tradeExecutionId,
          protectionVersion: protection.version,
        },
      },
      create: {
        tradeExecutionId: protection.tradeExecutionId,
        protectionVersion: protection.version,
        ...row,
      },
      update: row,
    });
  }

  private async loadOrder(executionId: string, role: string, generation: number): Promise<BinanceOrder | null> {
    return this.prisma.binanceOrder.findUnique({
      where: {
        tradeExecutionId_role_generation: {
          tradeExecutionId: executionId,
          role: role as BinanceOrder["role"],
          generation,
        },
      },
    });
  }

  private async loadProtectionOrders(executionId: string): Promise<BinanceOrder[]> {
    return this.prisma.binanceOrder.findMany({
      where: { tradeExecutionId: executionId, role: { in: ["STOP_LOSS", "TAKE_PROFIT"] }, clientAlgoId: { not: null } },
      orderBy: [{ generation: "asc" }, { role: "asc" }],
    });
  }

  private async highestGeneration(executionId: string): Promise<number> {
    const highest = await this.prisma.binanceOrder.findFirst({
      where: { tradeExecutionId: executionId, role: { in: ["STOP_LOSS", "TAKE_PROFIT"] } },
      orderBy: { generation: "desc" },
      select: { generation: true },
    });
    return highest?.generation ?? 0;
  }

  private asFailureShape(error: unknown) {
    if (error instanceof BinanceError) {
      return { kind: error.kind, httpStatus: error.httpStatus, binanceCode: error.binanceCode };
    }
    return { kind: "NETWORK", httpStatus: null, binanceCode: null };
  }

  /**
   * Sanitized diagnostics for a protection exchange call.
   *
   * The first real canary failed with nothing but a reason code to go on. Every
   * field here is safe: the Binance error KIND, the HTTP status, the numeric
   * Binance code, the endpoint NAME, and identifiers we minted ourselves. Never
   * the API key, secret, signature, signed URL or query string â€” the URL
   * carries the signature, so it is never logged.
   */
  private logProtectionFailure(input: {
    stage: "SUBMIT" | "QUERY" | "CANCEL";
    executionId: string;
    role: string;
    generation: number;
    clientAlgoId: string;
    endpoint: string;
    outcome: MutationOutcome;
    failure: { kind: string; httpStatus?: number | null; binanceCode?: number | null };
  }): void {
    logger.warn(
      {
        stage: input.stage,
        executionId: input.executionId,
        role: input.role,
        generation: input.generation,
        clientAlgoId: input.clientAlgoId,
        endpoint: input.endpoint,
        outcome: input.outcome,
        binanceKind: input.failure.kind,
        httpStatus: input.failure.httpStatus ?? null,
        binanceCode: input.failure.binanceCode ?? null,
      },
      "Protection exchange call failed"
    );
  }

  private outcome(
    ok: boolean,
    reasonCode: ProtectionReasonCode,
    message: string,
    execution: TradeExecution,
    protection: ExecutionProtectionState | null = null
  ): ProtectionOutcome {
    return { ok, reasonCode, message, execution, protection, mutationsDispatched: this.mutations.mutationsDispatched };
  }
}
