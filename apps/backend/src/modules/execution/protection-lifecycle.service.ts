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
import { canTransition, isTerminalStatus, type TradeExecutionStatusName } from "./execution-status";
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
 * Phase 7 — SL/TP protection, liquidation safety, margin top-up and emergency
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
  /** Explicit evaluation instant — the pure layer never reads a clock. */
  evaluatedAt: Date;
}

/**
 * The exact coverage that was proven at one verification moment. Decimal
 * STRINGS only — nothing here is ever routed through a JS number.
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
  // 1. ensureProtectionForExposure — the main entry point
  // ==========================================================================

  /**
   * Protects confirmed exposure. Runs on the FIRST confirmed non-zero fill —
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
      // The exchange says flat while we recorded a fill — reconcile closure.
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
  // 2. resumeProtectionLifecycle — crash recovery
  // ==========================================================================

  /**
   * Resumes from whatever durable state survived a crash. It never assumes a
   * protection order was NOT created: any reserved tranche is resolved by
   * querying its own deterministic clientAlgoId first.
   */
  async resumeProtectionLifecycle(input: ProtectionLifecycleInput): Promise<ProtectionOutcome> {
    const execution = await this.loadExecution(input.executionId);

    // The shared state machine is the single source of truth. The literal list
    // this replaced silently omitted every status added after it was written —
    // CLOSED_EXTERNAL among them — which would have made a terminally closed
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
        // for this sibling to cancel, which is a resolved state — collapsing it
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
    // nothing left to cancel — cleanup stays incomplete until we can see it.
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
      // owned sibling is absent, terminal or verifiably cancelled — but no
      // owned order filled, so we cannot say what closed it. A manual operator
      // close, another client, a liquidation and ADL are indistinguishable from
      // here, so the execution is terminalized as an unattributed EXTERNAL
      // close rather than mislabelled as one of ours.
      //
      // Without this the execution stayed MANUAL_INTERVENTION forever and kept
      // recoveryRequiredCount at 1, blocking all new work — exactly what the
      // first real canary left behind after the operator closed it by hand.
      //
      // ORDERING IS LOAD-BEARING, and mirrors the SL/TP/emergency path below:
      // the TradeExecution is terminalized FIRST and the protection row is
      // marked CLOSED only after that commit succeeds. Closing protection first
      // can produce protection=CLOSED with a non-terminal execution, and
      // resumeProtectionLifecycle then returns early on that CLOSED row forever
      // — a half-terminal durable state that strands the execution for good.
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
      // something we did not intend — an identity contradiction or an order we
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
      return this.outcome(true, "PROTECTION_VERIFIED", "Position is fully protected.", execution, await this.loadProtection(execution.id));
    }

    // Resolve any half-finished tranche before creating a new one.
    const pending = await this.findIncompleteTranche(execution);
    const generation = pending ?? (await this.reserveNextTranche(execution, coverage.missingQuantity, position, input));

    if (typeof generation === "object") return generation; // a failure outcome

    return this.submitTranche(execution, generation, position, input);
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
  ): Promise<number | ProtectionOutcome> {
    const direction = execution.direction as DirectionName;
    const positionSide = protectionPositionSide(direction);
    const side = closingSide(direction);

    if (new D(missingQuantity).lessThanOrEqualTo(0)) {
      return this.outcome(true, "PROTECTION_VERIFIED", "No missing coverage.", execution, await this.loadProtection(execution.id));
    }

    // Frozen triggers only — never recalculated, never rounded here.
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
    const workingTypeStop = env.EXECUTION_SL_WORKING_TYPE;
    const workingTypeTakeProfit = env.EXECUTION_TP_WORKING_TYPE;
    const priceProtect = env.EXECUTION_PROTECTION_PRICE_PROTECT;

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
            workingType: role === "STOP_LOSS" ? workingTypeStop : workingTypeTakeProfit,
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
      const existing = await this.findIncompleteTranche(execution);
      if (existing) return existing;
      return this.outcome(false, "PROTECTION_GENERATION_CONFLICT", "A concurrent tranche was created.", execution);
    }
    if (!committed) {
      return this.outcome(false, "CAPACITY_OR_VERSION_CONFLICT", "Version changed; nothing was reserved.", execution);
    }

    return generation;
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

    const stopResult = await this.submitAndVerifyProtection(execution, stop, input.evaluatedAt);
    if (!stopResult.verified) {
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

      // The stop could not be verified — consider the last-resort close.
      return this.considerEmergencyClose(execution, protection, stopResult.reasonCode, input);
    }

    await this.setProtectionState(protection.id, "STOP_VERIFIED", "PROTECTION_VERIFIED", "Stop is verified active.");

    const takeProfit = await this.loadOrder(execution.id, "TAKE_PROFIT", generation);
    if (!takeProfit) {
      // A plan with no take profit: a verified stop is the whole protection.
      return this.verifyAggregateCoverage(execution, input);
    }

    await this.setProtectionState(protection.id, "PLACING_TAKE_PROFIT", null, null);
    const takeProfitResult = await this.submitAndVerifyProtection(execution, takeProfit, input.evaluatedAt);
    if (!takeProfitResult.verified) {
      // The verified STOP is retained — never cancelled because TP failed.
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

    return this.verifyAggregateCoverage(execution, input);
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

    // Look before leaping: a crash may already have placed this exact order.
    let existing = await this.queryProtection(execution.symbol, order.clientAlgoId!);
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

      // Bounded reconciliation on the SAME clientAlgoId — never a new id.
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
      // A remaining gap means another tranche is required — say so plainly.
      return this.outcome(
        false,
        "PROTECTION_COVERAGE_INCOMPLETE",
        `Coverage is incomplete: stop ${measured.stop}, take profit ${measured.takeProfit}, exposure ${open}.`,
        execution,
        await this.loadProtection(execution.id)
      );
    }

    return this.outcome(true, "PROTECTION_VERIFIED", "Aggregate protection covers the full position.", execution, await this.loadProtection(execution.id));
  }

  /**
   * Aggregate VERIFIED coverage, proven against the exchange rather than local
   * rows alone.
   */
  private async measureVerifiedCoverage(execution: TradeExecution): Promise<{ stop: string; takeProfit: string }> {
    const orders = await this.loadProtectionOrders(execution.id);
    let stop = new D(0);
    let takeProfit = new D(0);

    for (const order of orders) {
      const query = await this.queryProtection(execution.symbol, order.clientAlgoId!);
      if (query.outcome !== "CONFIRMED_ACCEPTED" || !query.order) continue;
      const status = normalizeAlgoStatus(query.order.algoStatus);
      if (!countsAsActiveCoverage(status)) continue;

      const quantity = new D(query.order.quantity ?? order.originalQuantity.toString());
      if (order.role === "STOP_LOSS") stop = stop.plus(quantity);
      else takeProfit = takeProfit.plus(quantity);
    }

    return { stop: stop.toString(), takeProfit: takeProfit.toString() };
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
      // Unknown: never a second client id — reconcile the same one.
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
        // Query unavailable — the position check below is the real proof.
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

    // Confirmed flat — clean up siblings and record the terminal state.
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
   * One transaction: execution status, actual fields, version increment and
   * one event. A failing event rolls all of it back.
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
       * by exchange proof may set this — it is what releases the execution from
       * the recovery-required count.
       */
      clearManualIntervention?: boolean;
      actuals?: Prisma.TradeExecutionUpdateManyMutationInput;
    }
  ): Promise<TradeExecution | null> {
    return this.prisma.$transaction(async (tx) => {
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

      const next = await tx.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
      await tx.executionEvent.create({
        data: {
          tradeExecutionId: execution.id,
          sequenceNumber: next.version,
          eventType: change.eventType,
          fromStatus: execution.status,
          toStatus: next.status,
          reasonCode: change.reasonCode,
          message: change.message.slice(0, 1000),
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
    await this.setProtectionState(protection.id, "MANUAL_INTERVENTION", reasonCode, message);

    if (isCriticalReason(reasonCode)) {
      await this.alerts.raise({
        tradeExecutionId: execution.id,
        alertType: reasonCode === "POSITION_IDENTITY_MISMATCH" ? "POSITION_IDENTITY_CONFLICT" : "STOP_NOT_VERIFIED",
        reasonCode,
        details: {
          symbol: execution.symbol,
          positionSide: protectionPositionSide(execution.direction as DirectionName),
          protectionState: "MANUAL_INTERVENTION",
          requiredAction: message,
        },
      });
    }

    const committed = await this.commitExecutionChange(execution, input.expectedVersion, {
      status: execution.status === "MANUAL_INTERVENTION" ? undefined : "MANUAL_INTERVENTION",
      reasonCode,
      message,
      eventType: "MANUAL_INTERVENTION_REQUIRED",
      requiresManualIntervention: true,
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
   *   CONFIRMED_ACCEPTED  — the order exists; `order` carries its state;
   *   NOT_FOUND_CONFIRMED — Binance proved this exact id does not exist;
   *   anything else       — we do not know, and absence must not be inferred.
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
   * Written inside the caller's transaction — it is history, not a side effect,
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
   * the API key, secret, signature, signed URL or query string — the URL
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
