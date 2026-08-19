import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { BinanceOrder, PrismaClient, TradeExecution } from "@prisma/client";
import { env } from "../../config/env";
import { NotFoundError } from "../../utils/errors";
import { BinanceError } from "../binance/binance.errors";
import { BinanceLiveEntryDisabledError, type BinanceUsdMExecutionClient } from "../binance/binance-execution.client";
import type { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import type { BinanceQueriedOrderDto } from "../binance/binance.types";
import { buildClientOrderId } from "./execution-safety";
import { canTransition, type TradeExecutionStatusName } from "./execution-status";
import type { EntryCancellationReason } from "../binance/binance-execution.client";
import {
  classifyMutationOutcome,
  decideReconciliation,
  entryDeadlineFrom,
  entryOrderSide,
  entryPositionSide,
  findOrderIdentityMismatches,
  isEntryTtlDue,
  mapExchangeToLocalOrderStatus,
  mapOrderToExecutionStatus,
  mergeFillProgress,
  normalizeExchangeOrderStatus,
  shouldCancelRemainder,
  type CancelCause,
  type EntryReasonCode,
  type LocalOrderStatusName,
  type MutationOutcome,
} from "./entry-lifecycle";

/**
 * Phase 6 — LIMIT entry lifecycle orchestration.
 *
 * Internal methods only: no worker, no queue, no polling daemon, no WebSocket
 * stream, no webhook wiring, no Telegram, no HTTP route. A future worker calls
 * these; nothing calls them automatically today.
 *
 * Reads go through the Phase 2 GET-only service; the four approved mutations
 * go through the separate Phase 6 mutation client. Both live gates must be
 * open before any mutation, and when they are not, this service performs zero
 * mutation calls, reserves nothing and changes no status.
 */

const D = Prisma.Decimal;

/** Namespace for the per-(profile, symbol) advisory lock. */
const ENTRY_LOCK_NAMESPACE = 0x5afe6;

/**
 * The only states in which a reserved ENTRY order may actually exist on the
 * exchange. Recovery cancellation is refused outside them, so a terminal,
 * exposure-free execution can never trigger a DELETE.
 */
const ENTRY_ORDER_POSSIBLE_STATUSES: readonly TradeExecutionStatusName[] = [
  "ENTRY_SUBMITTING",
  "ENTRY_PENDING",
  "PARTIALLY_FILLED",
  "MANUAL_INTERVENTION",
];

interface ResolvedReconciledStatus {
  /** What will actually be written. Equal to the current status means "no change". */
  targetStatus: TradeExecutionStatusName;
  /** The mapped status the state machine refused, or null when it was legal. */
  refusedStatus: TradeExecutionStatusName | null;
  explanation: string;
}

/**
 * Reconciles what the ORDER is with what the EXECUTION may legally become.
 *
 * `mapOrderToExecutionStatus` answers only the first question: it sees a
 * cancelled order carrying no fill and correctly says "this order expired".
 * Whether the execution may FOLLOW the order into that state is a different
 * question, and the state machine — not the order — owns it.
 *
 * The gap that made this necessary: an execution still in ENTRY_SUBMITTING
 * whose order comes back CANCELED with a zero fill mapped to ENTRY_EXPIRED (or
 * to CANCELED for an operator cancellation) and was written directly, pinned
 * only on `version`. Both are edges the graph deliberately omits, with the
 * reason spelled out on ENTRY_SUBMITTING itself: once submission is attempted
 * an order may exist, so the lifecycle must not casually terminalize.
 *
 * The substitution is MANUAL_INTERVENTION, and that is not a catch-all — it is
 * what this codebase already prescribes for every reachable case:
 *
 *   - ENTRY_SUBMITTING -> CANCELED / ENTRY_EXPIRED: `canTransition` answers
 *     these itself with "use MANUAL_INTERVENTION and unwind explicitly". The
 *     normal path never lands here — a confirmed order leaves ENTRY_SUBMITTING
 *     on the first reconciliation — so this only fires when submission never
 *     resolved, which is precisely when a human should look.
 *   - PARTIALLY_FILLED -> CANCELED / FAILED / ENTRY_PENDING: exposure is
 *     recorded, so both terminal claims are false and a backwards ENTRY_PENDING
 *     contradicts a fill we already hold. `mapOrderToExecutionStatus` reaches
 *     for MANUAL_INTERVENTION in the identical "cancelled while filled" case.
 *   - MANUAL_INTERVENTION -> anything: already parked, and the graph lets it
 *     leave only on proven closure. Here the substitution equals the current
 *     status, so it degenerates to "observe, stay parked, change nothing" —
 *     an execution can never quietly un-park itself.
 *
 * A terminal source is the one case where MANUAL_INTERVENTION is illegal too.
 * No production caller reconciles a terminal execution (the orchestrator and
 * `resumeEntrySubmission` both stop first, and `expireEntryOrderIfDue` is
 * gated on ENTRY_ORDER_POSSIBLE_STATUSES), but the public method is callable,
 * so it is handled rather than assumed away: the status is left exactly as it
 * is and the contradiction is carried by the manual-intervention FLAG and the
 * event. Nothing leaves a terminal state.
 *
 * The observation itself is always persisted either way. Refusing a status is
 * never a reason to discard a fill, an exchange order id or an event.
 */
function resolveReconciledStatus(
  currentStatus: TradeExecutionStatusName,
  mappedStatus: TradeExecutionStatusName
): ResolvedReconciledStatus {
  if (mappedStatus === currentStatus) {
    // Not a transition at all — the reconciliation only refreshes fields.
    return { targetStatus: currentStatus, refusedStatus: null, explanation: "" };
  }

  const direct = canTransition(currentStatus, mappedStatus);
  if (direct.allowed) {
    return { targetStatus: mappedStatus, refusedStatus: null, explanation: "" };
  }

  const parked = canTransition(currentStatus, "MANUAL_INTERVENTION");
  if (parked.allowed) {
    return {
      targetStatus: "MANUAL_INTERVENTION",
      refusedStatus: mappedStatus,
      explanation:
        `${currentStatus} -> ${mappedStatus} is not a legal transition ` +
        `(${direct.reason ?? "refused by the execution state machine"}), ` +
        `so the execution was parked for a human instead.`,
    };
  }

  return {
    targetStatus: currentStatus,
    refusedStatus: mappedStatus,
    explanation:
      `${currentStatus} -> ${mappedStatus} is not a legal transition ` +
      `(${direct.reason ?? "refused by the execution state machine"}), ` +
      `and ${currentStatus} is terminal, so the status was left unchanged and flagged for a human.`,
  };
}

export interface EntryLifecycleOptions {
  ttlSeconds?: number;
  reconcileMaxAttempts?: number;
  reconcileDelayMs?: number;
}

export interface EntryLifecycleInput {
  executionId: string;
  expectedVersion: number;
  /** Explicit evaluation instant — the pure layer never reads a clock. */
  evaluatedAt: Date;
}

export interface EntryLifecycleOutcome {
  ok: boolean;
  reasonCode: EntryReasonCode;
  message: string;
  execution: TradeExecution;
  order: BinanceOrder | null;
  /** Mutations actually dispatched by this call (0 when a gate is closed). */
  mutationsDispatched: number;
}

/** Stable 32-bit lock key so one symbol is configured/submitted once at a time. */
export function entryLockKey(executionProfileId: string, symbol: string): number {
  return createHash("sha256")
    .update(`${executionProfileId}:${symbol.trim().toUpperCase()}`)
    .digest()
    .readInt32BE(0);
}

export class EntryLifecycleService {
  private readonly ttlSeconds: number;
  private readonly reconcileMaxAttempts: number;
  private readonly reconcileDelayMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly readOnly: BinanceReadOnlyService,
    private readonly mutations: BinanceUsdMExecutionClient,
    options: EntryLifecycleOptions = {}
  ) {
    this.ttlSeconds = options.ttlSeconds ?? env.EXECUTION_ENTRY_TTL_SECONDS;
    this.reconcileMaxAttempts = options.reconcileMaxAttempts ?? env.EXECUTION_ENTRY_RECONCILE_MAX_ATTEMPTS;
    this.reconcileDelayMs = options.reconcileDelayMs ?? env.EXECUTION_ENTRY_RECONCILE_DELAY_MS;
  }

  // ==========================================================================
  // 1. prepareEntrySubmission — revalidate, reserve intent, configure, submit
  // ==========================================================================

  /**
   * Full happy path for an admitted execution: final revalidation, durable
   * local intent, ISOLATED margin, exact leverage, one LIMIT entry, then
   * reconciliation of the result.
   */
  async prepareEntrySubmission(input: EntryLifecycleInput): Promise<EntryLifecycleOutcome> {
    const gate = this.checkLiveGates();
    if (gate) {
      // Zero mutation calls, no reservation, no status change.
      const execution = await this.loadExecution(input.executionId);
      return this.result(false, gate, "Live entry is disabled; nothing was reserved or submitted.", execution, null);
    }

    const revalidated = await this.revalidate(input);
    if (!revalidated.ok) return revalidated;

    const reserved = await this.reserveEntryIntent(input);
    if (!reserved.ok) return reserved;

    return this.continueAfterReservation(reserved.execution, reserved.order!, input.evaluatedAt);
  }

  // ==========================================================================
  // 2. resumeEntrySubmission — crash recovery
  // ==========================================================================

  /**
   * Resumes from whatever durable state survived a crash. It never assumes an
   * order was NOT created: any state at or past ENTRY_SUBMITTING is resolved by
   * querying the SAME deterministic client order id first.
   */
  async resumeEntrySubmission(input: EntryLifecycleInput): Promise<EntryLifecycleOutcome> {
    const execution = await this.loadExecution(input.executionId);
    const status = execution.status as TradeExecutionStatusName;

    switch (status) {
      case "PREFLIGHT":
        // No local reservation yet — start from the top.
        return this.prepareEntrySubmission(input);

      case "ENTRY_SUBMITTING": {
        // No gate check here: an order may already exist, so we must at least
        // be able to GET-reconcile it. `continueAfterReservation` gates the
        // configuration/submission half on its own.
        const order = await this.loadEntryOrder(execution.id);
        if (!order) {
          // Status says submitting but no reservation survived: this cannot be
          // resolved automatically without risking a second order.
          return this.escalate(execution, "MANUAL_REVIEW_REQUIRED", "ENTRY_SUBMITTING without a local entry reservation.", input);
        }
        return this.continueAfterReservation(execution, order, input.evaluatedAt);
      }

      case "ENTRY_PENDING":
      case "PARTIALLY_FILLED": {
        const reconciled = await this.reconcileEntryOrder(input);
        if (!reconciled.ok) return reconciled;
        const order = await this.loadEntryOrder(execution.id);
        if (order && isEntryTtlDue(input.evaluatedAt, order.entryOrderExpiresAt)) {
          const current = await this.loadExecution(execution.id);
          return this.expireEntryOrderIfDue({ ...input, expectedVersion: current.version });
        }
        return reconciled;
      }

      case "ENTRY_FILLED":
        // Nothing to submit or cancel; Phase 7 owns what happens next.
        return this.result(
          true,
          "ENTRY_RECONCILED",
          "Entry is already filled; no further entry action is taken in this phase.",
          execution,
          await this.loadEntryOrder(execution.id)
        );

      default:
        return this.result(
          false,
          status === "MANUAL_INTERVENTION" ? "MANUAL_REVIEW_REQUIRED" : "EXECUTION_NOT_PREFLIGHT",
          `Execution is ${status}; Phase 6 performs no automatic mutation from this state.`,
          execution,
          await this.loadEntryOrder(execution.id)
        );
    }
  }

  // ==========================================================================
  // 3. reconcileEntryOrder
  // ==========================================================================

  /**
   * Queries by origClientOrderId and transactionally applies the result. Fills
   * are monotonic, identity is verified, and a contradictory order parks the
   * execution for a human rather than overwriting local intent.
   */
  async reconcileEntryOrder(input: EntryLifecycleInput, cancelCause: CancelCause = "UNKNOWN"): Promise<EntryLifecycleOutcome> {
    const execution = await this.loadExecution(input.executionId);
    const order = await this.loadEntryOrder(execution.id);
    if (!order) {
      return this.result(false, "ENTRY_ORDER_NOT_FOUND", "No local entry reservation exists.", execution, null);
    }

    const query = await this.queryEntryOrder(execution.symbol, order.clientOrderId);
    const mismatches = query.order
      ? findOrderIdentityMismatches(
          {
            symbol: execution.symbol,
            side: order.side as "BUY" | "SELL",
            positionSide: order.positionSide as "LONG" | "SHORT",
            orderType: order.orderType,
            price: order.price?.toString() ?? "0",
            originalQuantity: order.originalQuantity.toString(),
            clientOrderId: order.clientOrderId,
          },
          {
            symbol: query.order.symbol,
            side: query.order.side,
            positionSide: query.order.positionSide,
            orderType: query.order.type,
            price: query.order.price,
            originalQuantity: query.order.origQty,
            clientOrderId: query.order.clientOrderId,
          }
        )
      : [];

    const decision = decideReconciliation({
      queryOutcome: query.outcome,
      identityMismatches: mismatches,
      attempt: order.reconcileAttempts + 1,
      maxAttempts: this.reconcileMaxAttempts,
      exposurePossible: true,
    });

    if (decision.action === "ESCALATE_MANUAL") {
      return this.escalate(
        execution,
        decision.reasonCode,
        mismatches.length > 0
          ? `Exchange order contradicts local intent (${mismatches.join(", ")}).`
          : "Entry order state could not be resolved within the bounded attempt budget.",
        input
      );
    }

    if (decision.action !== "APPLY_ORDER_STATE") {
      // Record the bounded attempt without touching the execution lifecycle.
      await this.prisma.binanceOrder.update({
        where: { id: order.id },
        data: {
          reconcileAttempts: { increment: 1 },
          lastReconcileAt: input.evaluatedAt,
          submissionUnknownAt: order.submissionUnknownAt ?? input.evaluatedAt,
        },
      });
      return this.result(
        false,
        decision.reasonCode,
        `Entry order state is unresolved; a bounded retry is due in ${this.reconcileDelayMs} ms.`,
        execution,
        await this.loadEntryOrder(execution.id)
      );
    }

    return this.applyOrderState(execution, order, query.order!, input, cancelCause);
  }

  // ==========================================================================
  // 4. expireEntryOrderIfDue
  // ==========================================================================

  /**
   * Cancels only the UNFILLED remainder once the durable TTL is due. It never
   * closes a filled position, never submits an opposite order and never treats
   * a cancel response as proof of the final fill state.
   *
   * This is the RISK_REDUCING_RECOVERY path and is therefore **not** gated on
   * the live-entry switches. Gating it would trap a resting order: turning the
   * gates off after an entry was accepted would leave us unable to cancel the
   * unfilled remainder at TTL. Disabling live entry stops new exposure — it
   * must not prevent reducing exposure that already exists.
   *
   * The narrowing is structural instead. Every one of these must hold:
   * a persisted execution; a persisted ENTRY generation 1 reservation; the
   * exact deterministic client order id from that row; a lifecycle state in
   * which an entry order may exist; a successful query BEFORE cancelling; and
   * TTL due (or an explicit internal recovery reason).
   */
  async expireEntryOrderIfDue(
    input: EntryLifecycleInput & { recoveryReason?: EntryCancellationReason }
  ): Promise<EntryLifecycleOutcome> {
    const execution = await this.loadExecution(input.executionId);
    const order = await this.loadEntryOrder(execution.id);
    if (!order) {
      return this.result(false, "ENTRY_ORDER_NOT_FOUND", "No local entry reservation exists.", execution, null);
    }

    // Only states in which an entry order may actually exist.
    const status = execution.status as TradeExecutionStatusName;
    if (!ENTRY_ORDER_POSSIBLE_STATUSES.includes(status)) {
      return this.result(
        false,
        "EXECUTION_NOT_PREFLIGHT",
        `No entry order can exist while the execution is ${status}; nothing was cancelled.`,
        execution,
        order
      );
    }

    const reason: EntryCancellationReason = input.recoveryReason ?? "TTL_DUE";
    if (reason === "TTL_DUE" && !isEntryTtlDue(input.evaluatedAt, order.entryOrderExpiresAt)) {
      return this.result(false, "ENTRY_TTL_EXPIRED", "Entry TTL is not due yet; nothing was cancelled.", execution, order);
    }

    // Always look before cancelling: a fill may have landed since the last read.
    const before = await this.queryEntryOrder(execution.symbol, order.clientOrderId);
    if (before.outcome !== "CONFIRMED_ACCEPTED" || !before.order) {
      return this.result(
        false,
        "ENTRY_ORDER_QUERY_UNAVAILABLE",
        "Entry order could not be read before cancellation; nothing was cancelled.",
        execution,
        order
      );
    }

    const observedStatus = mapExchangeToLocalOrderStatus(normalizeExchangeOrderStatus(before.order.status));
    if (observedStatus === "FILLED") {
      // Never cancel a filled order.
      return this.reconcileEntryOrder(input);
    }
    if (!shouldCancelRemainder(observedStatus)) {
      return this.reconcileEntryOrder(input);
    }

    await this.prisma.binanceOrder.update({
      where: { id: order.id },
      data: { cancelRequestedAt: order.cancelRequestedAt ?? input.evaluatedAt },
    });

    let cancelOutcome: MutationOutcome;
    try {
      // The context is minted from the PERSISTED reservation, so the symbol
      // and client order id can never be caller-supplied.
      const context = this.mutations.authorizeEntryCancellation({
        executionId: execution.id,
        symbol: execution.symbol,
        clientOrderId: order.clientOrderId,
        role: order.role,
        generation: order.generation,
        reason,
      });
      await this.mutations.cancelReservedEntryOrder(context);
      cancelOutcome = "CONFIRMED_ACCEPTED";
    } catch (error) {
      cancelOutcome = classifyMutationOutcome(this.asFailureShape(error), "CANCEL");
    }

    // The HTTP result is never the final word — re-read before deciding.
    const after = await this.queryEntryOrder(execution.symbol, order.clientOrderId);
    if (after.outcome !== "CONFIRMED_ACCEPTED" || !after.order) {
      const reloaded = await this.loadEntryOrder(execution.id);
      const partiallyFilled = new D(reloaded?.executedQuantity ?? 0).greaterThan(0);
      if (partiallyFilled || cancelOutcome === "RESULT_UNKNOWN") {
        // Ambiguous cancellation while a fill is possible: a human decides.
        return this.escalate(
          execution,
          "ENTRY_CANCEL_RESULT_UNKNOWN",
          "Cancellation result is ambiguous and exposure cannot be ruled out.",
          input
        );
      }
      return this.result(
        false,
        "ENTRY_CANCEL_RESULT_UNKNOWN",
        "Cancellation result is unresolved; a bounded retry is due.",
        execution,
        reloaded
      );
    }

    const current = await this.loadExecution(execution.id);
    await this.prisma.binanceOrder.update({
      where: { id: order.id },
      data: { cancelConfirmedAt: input.evaluatedAt },
    });

    // The cause decides the terminal mapping (see mapOrderToExecutionStatus):
    // under TTL a zero-fill is ENTRY_EXPIRED and a partial fill escalates,
    // while a soft-target withdrawal is CANCELED / ENTRY_FILLED respectively.
    return this.reconcileEntryOrder(
      { ...input, expectedVersion: current.version },
      reason === "SOFT_OPEN_TARGET" ? "SOFT_OPEN_TARGET" : "TTL"
    );
  }

  // ==========================================================================
  // 5. releaseUnrunnablePreflight  give back PRE-SUBMISSION work that cannot run
  // ==========================================================================

  /**
   * Terminalizes a PREFLIGHT execution that can never be submitted, and only
   * when that is provably harmless.
   *
   * PREFLIGHT consumes a pending-entry AND a total-active slot (see
   * capacity-status.ts). With the canary limits at 1/1, an execution that can
   * no longer advance holds both slots forever and nothing else can ever start.
   * There are exactly two ways to reach that dead end, and this handles both:
   *
   *   - a NEW ENTRY IS BLOCKED (a gate, a kill switch, a disabled profile) 
   *     the operator has said no, so the execution is CANCELED;
   *   - the SIGNAL OR ENTRY DEADLINE HAS PASSED  the gates may be wide open,
   *     but `revalidate` will refuse forever because the signal is too old, so
   *     the execution is SKIPPED (deliberately not traded, matching what a
   *     Phase 5 SKIP decision already does to a PLAN_READY row).
   *
   * Both triggers share ONE set of proofs, which is the point of keeping them
   * in a single method: a second copy of this reasoning is exactly where a
   * safety property would drift.
   *
   * It is safe ONLY because of what PREFLIGHT means: `reserveEntryIntent`
   * writes the ENTRY reservation and the move to ENTRY_SUBMITTING in a single
   * transaction, so a PREFLIGHT execution has no deterministic client order id
   * and no order can bear its identity. Nothing is cancelled on the exchange
   * because nothing was ever sent  this gives back local capacity and nothing
   * else.
   *
   * Four conditions must ALL hold, and any doubt leaves the row untouched and
   * retryable:
   *
   *   1. the execution is still PREFLIGHT;
   *   2. it carries NO order reservation of any role or generation;
   *   3. one of the two triggers above applies;
   *   4. the exchange is proven FLAT for the symbol  `null` (unreadable) is
   *      never read as "no".
   *
   * Dispatches zero Binance mutations on every path.
   */
  async releaseUnrunnablePreflight(input: EntryLifecycleInput): Promise<EntryLifecycleOutcome> {
    const execution = await this.loadExecution(input.executionId);
    const status = execution.status as TradeExecutionStatusName;

    // 1. Only PREFLIGHT. Anything at or past ENTRY_SUBMITTING may own an
    //    exchange order and belongs to the existing recovery semantics.
    if (status !== "PREFLIGHT") {
      return this.result(
        false,
        "EXECUTION_NOT_PREFLIGHT",
        `Execution is ${status}; only a PREFLIGHT execution may be released pre-submission.`,
        execution,
        await this.loadEntryOrder(execution.id)
      );
    }

    // 2. Any order row at all means an identity exists that an exchange order
    //    could carry. PREFLIGHT plus a reservation is a state
    //    `reserveEntryIntent` cannot produce, so it is anomalous rather than
    //    merely inconvenient  park it for a human instead of guessing.
    const reservations = await this.prisma.binanceOrder.count({ where: { tradeExecutionId: execution.id } });
    if (reservations > 0) {
      return this.escalate(
        execution,
        "MANUAL_REVIEW_REQUIRED",
        "A PREFLIGHT execution carries an order reservation; exchange exposure cannot be ruled out.",
        input
      );
    }

    // 3. Is this execution actually unrunnable? If not, the normal submission
    //    path owns it and nothing here may touch it.
    const verdict = await this.preflightReleaseVerdict(execution, input.evaluatedAt);
    if (!verdict) {
      return this.result(
        false,
        "SAFETY_ADMISSION_NOT_READY",
        "This execution can still run; the normal submission path owns it.",
        execution,
        null
      );
    }

    // 4. Flatness must be PROVEN, not assumed.
    const exposure = await this.symbolHasExposure(execution.symbol);
    if (exposure === null) {
      return this.result(
        false,
        "SYMBOL_EXPOSURE_CHANGED",
        "Exchange state could not be read; nothing was terminalized and the next tick retries.",
        execution,
        null
      );
    }
    if (exposure) {
      return this.result(
        false,
        "SYMBOL_EXPOSURE_CHANGED",
        "Exchange exposure exists on this symbol; nothing was terminalized.",
        execution,
        null
      );
    }

    // The pure state machine has the final say on the transition itself.
    const transition = canTransition("PREFLIGHT", verdict.toStatus);
    if (!transition.allowed) {
      return this.result(
        false,
        "CAPACITY_OR_VERSION_CONFLICT",
        transition.reason ?? "The transition was refused.",
        execution,
        null
      );
    }

    const committed = await this.prisma.$transaction(async (tx) => {
      // Re-assert inside the transaction: a reservation appearing between the
      // check above and this write would invalidate the whole argument.
      const reservedNow = await tx.binanceOrder.count({ where: { tradeExecutionId: execution.id } });
      if (reservedNow > 0) return null;

      // Compare-and-swap on the version read a moment ago, so a concurrent
      // tick or a second worker loses rather than double-terminalizing.
      const updated = await tx.tradeExecution.updateMany({
        where: { id: execution.id, version: execution.version, status: "PREFLIGHT" },
        data: {
          status: verdict.toStatus,
          version: { increment: 1 },
          decisionReasonCode: verdict.reasonCode,
          sanitizedMessage: verdict.message.slice(0, 1000),
        },
      });
      if (updated.count === 0) return null;

      const next = await tx.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
      await tx.executionEvent.create({
        data: {
          tradeExecutionId: execution.id,
          sequenceNumber: next.version,
          eventType: "STATUS_CHANGED",
          fromStatus: "PREFLIGHT",
          toStatus: verdict.toStatus,
          reasonCode: verdict.reasonCode,
          message: verdict.message.slice(0, 1000),
        },
      });
      return next;
    });

    if (!committed) {
      const current = await this.loadExecution(execution.id);
      return this.result(
        false,
        "CAPACITY_OR_VERSION_CONFLICT",
        "The execution changed during release; nothing was terminalized.",
        current,
        await this.loadEntryOrder(execution.id)
      );
    }

    return this.result(true, verdict.reasonCode, verdict.message, committed, null);
  }

  /**
   * Decides WHETHER a PREFLIGHT execution is unrunnable, and into which
   * terminal state it should be released. `null` means "it can still run".
   *
   * Blocked is checked first so an operator-closed window keeps producing
   * CANCELED even when the signal has also gone stale  the operator's decision
   * is the more informative reason to record.
   */
  private async preflightReleaseVerdict(
    execution: TradeExecution,
    evaluatedAt: Date
  ): Promise<{ toStatus: TradeExecutionStatusName; reasonCode: EntryReasonCode; message: string } | null> {
    const blocked = await this.newEntryBlockedReason(execution.executionProfileId);
    if (blocked) {
      return {
        toStatus: "CANCELED",
        reasonCode: "PREFLIGHT_ABANDONED_NEW_ENTRY_BLOCKED",
        message:
          `New entry is blocked (${blocked}) and no entry order was ever reserved; ` +
          "the execution was released without contacting the exchange.",
      };
    }

    const expiry = this.preflightDeadlinePassed(execution, evaluatedAt);
    if (expiry) {
      return {
        toStatus: "SKIPPED",
        reasonCode: "PREFLIGHT_SKIPPED_SIGNAL_EXPIRED",
        message:
          `This execution can never be submitted: ${expiry}. No entry order was ever reserved; ` +
          "the execution was skipped without contacting the exchange.",
      };
    }

    return null;
  }

  /**
   * The subset of `revalidate`'s deadline rules that is MONOTONIC  once true
   * it can never become false again, because both conditions only move further
   * past their limit as time passes. That is what makes terminalizing on them
   * safe: the submission path is not merely refusing right now, it will refuse
   * forever.
   *
   * The comparisons deliberately mirror `revalidate` exactly, so an execution
   * the submission path would still accept can never be skipped here.
   *
   * A missing `signalTriggeredAt` is NOT treated as expiry: it means the age is
   * unknowable, and "unknown" is never proof. Such a row is left alone.
   */
  private preflightDeadlinePassed(execution: TradeExecution, evaluatedAt: Date): string | null {
    if (execution.entryExpiresAt && evaluatedAt.getTime() > execution.entryExpiresAt.getTime()) {
      return `the planned entry deadline passed at ${execution.entryExpiresAt.toISOString()}`;
    }
    if (!execution.signalTriggeredAt) return null;

    const ageSeconds = Math.floor((evaluatedAt.getTime() - execution.signalTriggeredAt.getTime()) / 1000);
    if (ageSeconds > env.EXECUTION_MAX_ALERT_AGE_SECONDS) {
      return `the signal is ${ageSeconds}s old, beyond the ${env.EXECUTION_MAX_ALERT_AGE_SECONDS}s limit`;
    }
    return null;
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /**
   * Gate for EXPOSURE_OR_CONFIGURATION mutations only (marginType, leverage,
   * new order). Risk-REDUCING cancellation is deliberately not gated here —
   * see `expireEntryOrderIfDue`.
   */
  private checkLiveGates(): EntryReasonCode | null {
    if (!env.EXECUTION_LIVE_ENTRY_ENABLED) return "LIVE_ENTRY_DISABLED";
    if (!env.EXECUTION_PROTECTION_READY) return "PROTECTION_NOT_READY";
    return this.mutations.blockedReason;
  }

  /**
   * Every condition that blocks a NEW entry submission, in ONE place: the two
   * live gates, the mutation client's own block, the profile being disabled,
   * the global kill switch and the profile kill switch.
   *
   * Both the pre-submission recheck and PREFLIGHT abandonment read it, so the
   * two can never disagree about what "blocked" means — which matters, because
   * abandonment is only safe precisely when submission is impossible.
   *
   * Returns `null` only when a new entry could legitimately be submitted.
   */
  private async newEntryBlockedReason(executionProfileId: string): Promise<EntryReasonCode | null> {
    const gate = this.checkLiveGates();
    if (gate) return gate;

    const profile = await this.prisma.executionProfile.findUnique({
      where: { id: executionProfileId },
      include: { safetyPolicy: true },
    });
    if (!profile?.isEnabled) return "SAFETY_ADMISSION_NOT_READY";
    if (env.EXECUTION_GLOBAL_KILL_SWITCH || profile.safetyPolicy?.killSwitchActive !== false) {
      return "KILL_SWITCH_RECHECK_ACTIVE";
    }
    return null;
  }

  /**
   * Re-validated IMMEDIATELY before POST /fapi/v1/order. Margin-type and
   * leverage configuration involve several network round trips, so a kill
   * switch or gate may have been engaged in the meantime. No database
   * transaction is held across any of these calls.
   */
  private async recheckBeforeSubmit(
    execution: TradeExecution,
    order: BinanceOrder
  ): Promise<{ reasonCode: EntryReasonCode; message: string } | null> {
    // 1/2. Gates, profile and kill switches — re-read, never cached from
    // revalidation. Same definition PREFLIGHT abandonment uses.
    const blocked = await this.newEntryBlockedReason(execution.executionProfileId);
    if (blocked === "SAFETY_ADMISSION_NOT_READY") {
      return { reasonCode: blocked, message: "Execution profile became disabled." };
    }
    if (blocked === "KILL_SWITCH_RECHECK_ACTIVE") {
      return {
        reasonCode: blocked,
        message: "A kill switch became active after configuration; the entry was not submitted.",
      };
    }
    if (blocked) return { reasonCode: blocked, message: "Live entry became disabled before submission." };

    // 3/4. Lifecycle ownership: still ours, still the same version and order.
    const current = await this.prisma.tradeExecution.findUnique({ where: { id: execution.id } });
    if (!current || current.status !== "ENTRY_SUBMITTING" || current.version !== execution.version) {
      return {
        reasonCode: "CAPACITY_OR_VERSION_CONFLICT",
        message: "Execution ownership changed after configuration; the entry was not submitted.",
      };
    }
    const currentOrder = await this.loadEntryOrder(execution.id);
    if (!currentOrder || currentOrder.id !== order.id || currentOrder.clientOrderId !== order.clientOrderId) {
      return {
        reasonCode: "ENTRY_INTENT_CONFLICT",
        message: "The reserved entry order changed after configuration; the entry was not submitted.",
      };
    }

    // 5. No conflicting local or Binance exposure appeared.
    const conflicting = await this.prisma.tradeExecution.count({
      where: {
        id: { not: execution.id },
        executionProfileId: execution.executionProfileId,
        symbol: execution.symbol,
        status: { in: ["ENTRY_SUBMITTING", "ENTRY_PENDING", "PARTIALLY_FILLED", "ENTRY_FILLED"] },
      },
    });
    if (conflicting > 0) {
      return { reasonCode: "ENTRY_INTENT_CONFLICT", message: "Another local execution took this symbol." };
    }
    const exposure = await this.symbolHasExposure(execution.symbol);
    if (exposure === null) {
      return { reasonCode: "SYMBOL_EXPOSURE_CHANGED", message: "Symbol exposure could not be confirmed." };
    }
    if (exposure) {
      return { reasonCode: "SYMBOL_EXPOSURE_CHANGED", message: "External exposure appeared on this symbol." };
    }

    return null;
  }

  /**
   * Final pre-submission revalidation. The safety admission may be seconds
   * old, so every precondition is re-read from GET-only state. Nothing here
   * recalculates or replaces a frozen Phase 3 value — it only compares.
   */
  private async revalidate(input: EntryLifecycleInput): Promise<EntryLifecycleOutcome> {
    const execution = await this.prisma.tradeExecution.findUnique({
      where: { id: input.executionId },
      include: { executionProfile: { include: { safetyPolicy: true } } },
    });
    if (!execution) throw new NotFoundError(`Execution ${input.executionId} not found.`);

    const fail = (reasonCode: EntryReasonCode, message: string) =>
      this.result(false, reasonCode, message, execution, null);

    if (execution.status !== "PREFLIGHT") {
      return fail("EXECUTION_NOT_PREFLIGHT", `Execution is ${execution.status}, not PREFLIGHT.`);
    }
    if (execution.version !== input.expectedVersion) {
      return fail("CAPACITY_OR_VERSION_CONFLICT", "Execution version changed since admission.");
    }

    const profile = execution.executionProfile;
    if (!profile.isEnabled) return fail("SAFETY_ADMISSION_NOT_READY", "Execution profile is disabled.");
    if (!this.environmentMatches(profile.environment)) {
      return fail("SAFETY_ADMISSION_NOT_READY", "Profile environment does not match the connector environment.");
    }

    // Kill switches are re-checked; they block a NEW submission but never
    // cancel an order that already exists (that is a later phase).
    if (env.EXECUTION_GLOBAL_KILL_SWITCH || profile.safetyPolicy?.killSwitchActive !== false) {
      return fail("KILL_SWITCH_RECHECK_ACTIVE", "A kill switch is active; no entry may be submitted.");
    }

    const admission = await this.prisma.safetyAdmission.findFirst({
      where: { tradeExecutionId: execution.id },
      orderBy: { evaluatedVersion: "desc" },
    });
    if (!admission || admission.decision !== "PASS") {
      return fail("SAFETY_ADMISSION_NOT_READY", "The latest safety admission is not a committed PASS.");
    }

    // Frozen plan completeness — compared, never regenerated.
    if (!execution.marginPlanSnapshot || !execution.exchangeFiltersSnapshot) {
      return fail("SAFETY_ADMISSION_NOT_READY", "The frozen plan or filters snapshot is missing.");
    }
    if (!Number.isSafeInteger(execution.selectedLeverage) || execution.selectedLeverage < 1) {
      return fail("SAFETY_ADMISSION_NOT_READY", "The frozen selected leverage is missing or invalid.");
    }
    const price = execution.plannedEntryPrice.toString();
    const quantity = execution.plannedQuantity.toString();
    if (!new D(price).greaterThan(0) || !new D(quantity).greaterThan(0)) {
      return fail("SAFETY_ADMISSION_NOT_READY", "The frozen entry price or quantity is not a positive decimal.");
    }

    // Deadlines: the plan's own entry deadline and signal freshness.
    if (execution.entryExpiresAt && input.evaluatedAt.getTime() > execution.entryExpiresAt.getTime()) {
      return fail("SIGNAL_OR_ENTRY_DEADLINE_EXPIRED", "The planned entry deadline has passed.");
    }
    if (!execution.signalTriggeredAt) {
      return fail("SIGNAL_OR_ENTRY_DEADLINE_EXPIRED", "The original signal time is unknown.");
    }
    const ageSeconds = Math.floor((input.evaluatedAt.getTime() - execution.signalTriggeredAt.getTime()) / 1000);
    if (ageSeconds > env.EXECUTION_MAX_ALERT_AGE_SECONDS) {
      return fail("SIGNAL_OR_ENTRY_DEADLINE_EXPIRED", `Signal is ${ageSeconds}s old.`);
    }

    // Live exchange state.
    let account;
    try {
      account = await this.readOnly.getAccountSummary();
    } catch {
      return fail("SYMBOL_STATE_CHANGED", "Binance account state could not be read.");
    }
    if (account.positionMode !== "HEDGE") return fail("POSITION_MODE_MISMATCH", "Account is not in HEDGE mode.");
    if (account.assetMode !== "SINGLE_ASSET") return fail("ASSET_MODE_MISMATCH", "Account is not in single-asset mode.");

    const symbol = execution.symbol.toUpperCase();
    if (account.positions.some((position) => position.symbol.toUpperCase() === symbol)) {
      return fail("SYMBOL_EXPOSURE_CHANGED", "A Binance position now exists on this symbol.");
    }
    if (account.openOrderSymbols.includes(symbol)) {
      return fail("SYMBOL_EXPOSURE_CHANGED", "A Binance open order now exists on this symbol.");
    }

    const available = account.usdtAvailableBalance;
    if (available === null || new D(available).lessThan(execution.maximumIsolatedMargin)) {
      return fail("SAFETY_ADMISSION_NOT_READY", "Available balance no longer covers the maximum isolated margin.");
    }

    let inspection;
    try {
      inspection = await this.readOnly.inspectSymbol(symbol);
    } catch {
      return fail("SYMBOL_STATE_CHANGED", "Symbol state could not be read.");
    }
    if ((inspection.filters.status ?? "").toUpperCase() !== "TRADING") {
      return fail("SYMBOL_STATE_CHANGED", "Symbol is no longer TRADING.");
    }
    if ((inspection.filters.contractType ?? "").toUpperCase() !== "PERPETUAL") {
      return fail("SYMBOL_STATE_CHANGED", "Symbol is no longer a PERPETUAL contract.");
    }

    // The frozen executable values must still satisfy the CURRENT filters. If
    // they do not, we fail closed — Phase 6 never re-rounds them.
    const filterCheck = this.checkFrozenValuesAgainstFilters(price, quantity, inspection.filters);
    if (filterCheck) return fail("SYMBOL_STATE_CHANGED", filterCheck);

    // Another local execution must not have taken the symbol/side meanwhile.
    const conflicting = await this.prisma.tradeExecution.count({
      where: {
        id: { not: execution.id },
        executionProfileId: execution.executionProfileId,
        symbol: execution.symbol,
        status: { in: ["PREFLIGHT", "ENTRY_SUBMITTING", "ENTRY_PENDING", "PARTIALLY_FILLED", "ENTRY_FILLED"] },
      },
    });
    if (conflicting > 0) {
      return fail("ENTRY_INTENT_CONFLICT", "Another local execution is already active on this symbol.");
    }

    return this.result(true, "ENTRY_SUBMITTED", "Revalidation passed.", execution, null);
  }

  /** Exact-string filter compliance. Never rounds, only rejects. */
  private checkFrozenValuesAgainstFilters(
    price: string,
    quantity: string,
    filters: { tickSize: string | null; stepSize: string | null; minQty: string | null; minNotional: string | null }
  ): string | null {
    const isMultipleOf = (value: string, step: string | null): boolean => {
      if (!step) return true;
      const stepDecimal = new D(step);
      if (stepDecimal.lessThanOrEqualTo(0)) return true;
      return new D(value).dividedBy(stepDecimal).modulo(1).isZero();
    };

    if (!isMultipleOf(price, filters.tickSize)) return "Frozen entry price no longer matches the tick size.";
    if (!isMultipleOf(quantity, filters.stepSize)) return "Frozen quantity no longer matches the step size.";
    if (filters.minQty && new D(quantity).lessThan(filters.minQty)) {
      return "Frozen quantity is below the current minimum quantity.";
    }
    if (filters.minNotional && new D(price).times(quantity).lessThan(filters.minNotional)) {
      return "Frozen notional is below the current minimum notional.";
    }
    return null;
  }

  /**
   * Durable local intent BEFORE any exchange mutation. One transaction:
   * verify → reserve exactly one ENTRY generation 1 → PREFLIGHT to
   * ENTRY_SUBMITTING → one version increment → one event.
   */
  private async reserveEntryIntent(input: EntryLifecycleInput): Promise<EntryLifecycleOutcome> {
    const existing = await this.loadEntryOrder(input.executionId);
    if (existing) {
      // Idempotent replay: same reservation, same client order id, no new event.
      const execution = await this.loadExecution(input.executionId);
      return this.result(true, "ENTRY_SUBMITTED", "Entry intent was already reserved.", execution, existing);
    }

    const execution = await this.loadExecution(input.executionId);
    const direction = execution.direction as "LONG" | "SHORT";
    const clientOrderId = buildClientOrderId(execution.id, "ENTRY", 1);
    const deadline = entryDeadlineFrom(input.evaluatedAt, this.ttlSeconds);

    try {
      const committed = await this.prisma.$transaction(async (tx) => {
        // Serialize per (profile, symbol): two local executions must never
        // configure or submit the same symbol simultaneously.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ENTRY_LOCK_NAMESPACE}::int, ${entryLockKey(
          execution.executionProfileId,
          execution.symbol
        )}::int)`;

        const updated = await tx.tradeExecution.updateMany({
          where: { id: execution.id, version: input.expectedVersion, status: "PREFLIGHT" },
          data: { status: "ENTRY_SUBMITTING", version: { increment: 1 } },
        });
        if (updated.count === 0) return null;

        const next = await tx.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });

        const order = await tx.binanceOrder.create({
          data: {
            tradeExecutionId: execution.id,
            role: "ENTRY",
            generation: 1,
            clientOrderId,
            side: entryOrderSide(direction),
            positionSide: entryPositionSide(direction),
            orderType: "LIMIT",
            timeInForce: "GTC",
            price: execution.plannedEntryPrice,
            originalQuantity: execution.plannedQuantity,
            executedQuantity: 0,
            status: "SUBMITTING",
            exchangeOrderId: null,
            entryOrderExpiresAt: deadline,
          },
        });

        await tx.executionEvent.create({
          data: {
            tradeExecutionId: execution.id,
            sequenceNumber: next.version,
            eventType: "ORDER_RESERVED",
            fromStatus: "PREFLIGHT",
            toStatus: "ENTRY_SUBMITTING",
            reasonCode: "ENTRY_SUBMITTED",
            message: "Reserved the local ENTRY intent before any exchange call.",
            metadata: { clientOrderId, role: "ENTRY", generation: 1 } as Prisma.InputJsonValue,
          },
        });

        return { execution: next, order };
      });

      if (!committed) {
        const current = await this.loadExecution(execution.id);
        return this.result(
          false,
          "CAPACITY_OR_VERSION_CONFLICT",
          "Execution version or status changed; nothing was reserved.",
          current,
          null
        );
      }
      return this.result(true, "ENTRY_SUBMITTED", "Entry intent reserved.", committed.execution, committed.order);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // Concurrent reservation won the race; replay its row.
        const current = await this.loadExecution(execution.id);
        return this.result(
          true,
          "ENTRY_SUBMITTED",
          "Entry intent was reserved concurrently.",
          current,
          await this.loadEntryOrder(execution.id)
        );
      }
      throw error;
    }
  }

  /** Configure margin type and leverage, then submit and reconcile. */
  private async continueAfterReservation(
    execution: TradeExecution,
    order: BinanceOrder,
    evaluatedAt: Date
  ): Promise<EntryLifecycleOutcome> {
    // A crash may have left an order already on the book — look before leaping.
    const existing = await this.queryEntryOrder(execution.symbol, order.clientOrderId);
    if (existing.outcome === "CONFIRMED_ACCEPTED" && existing.order) {
      return this.applyOrderState(execution, order, existing.order, {
        executionId: execution.id,
        expectedVersion: execution.version,
        evaluatedAt,
      });
    }

    // Configuration and submission are exposure-increasing: both gates must be
    // open. Cancellation of this same order stays available regardless.
    const gate = this.checkLiveGates();
    if (gate) {
      return this.result(
        false,
        gate,
        "Live entry is disabled; no configuration or submission was attempted. The reserved order can still be reconciled and cancelled.",
        execution,
        order
      );
    }

    const margin = await this.ensureIsolatedMargin(execution);
    if (margin) return this.result(false, margin.reasonCode, margin.message, execution, order);

    const leverage = await this.ensureExactLeverage(execution);
    if (leverage) return this.result(false, leverage.reasonCode, leverage.message, execution, order);

    // Configuration took several round trips — re-check everything that could
    // have changed before the one irreversible call.
    const recheck = await this.recheckBeforeSubmit(execution, order);
    if (recheck) {
      // No submission, no second reservation, and deliberately no automatic
      // rollback of margin type or leverage.
      return this.result(false, recheck.reasonCode, recheck.message, execution, order);
    }

    return this.submitAndReconcile(execution, order, evaluatedAt);
  }

  /**
   * ISOLATED margin, verified by a GET re-read. Never switches to CROSSED,
   * never touches a symbol carrying exposure, and never reverts on a later
   * failure — reverting could collide with the user's own activity.
   */
  private async ensureIsolatedMargin(
    execution: TradeExecution
  ): Promise<{ reasonCode: EntryReasonCode; message: string } | null> {
    const symbol = execution.symbol;

    let config = await this.readSymbolConfig(symbol);
    if (config === undefined) {
      return { reasonCode: "MARGIN_TYPE_RESULT_UNKNOWN", message: "Symbol configuration could not be read." };
    }
    if (config?.marginType === "ISOLATED") return null; // Already correct: no POST.

    const exposure = await this.symbolHasExposure(symbol);
    if (exposure === null) {
      return { reasonCode: "SYMBOL_EXPOSURE_CHANGED", message: "Symbol exposure could not be confirmed." };
    }
    if (exposure) {
      return { reasonCode: "SYMBOL_EXPOSURE_CHANGED", message: "Symbol carries exposure; margin type is not changed." };
    }

    let mutationOutcome: MutationOutcome = "CONFIRMED_ACCEPTED";
    try {
      await this.mutations.setIsolatedMarginType(this.mutations.authorizeLiveEntry(), symbol);
    } catch (error) {
      mutationOutcome = classifyMutationOutcome(this.asFailureShape(error), "SUBMIT_CONFIG");
      if (mutationOutcome === "CONFIRMED_REJECTED") {
        return { reasonCode: "MARGIN_TYPE_CONFIGURATION_FAILED", message: "Margin-type change was rejected." };
      }
    }

    // A success message is never taken as proof — verify with GET.
    config = await this.readSymbolConfig(symbol);
    if (config === undefined) {
      return { reasonCode: "MARGIN_TYPE_RESULT_UNKNOWN", message: "Margin type could not be verified after the change." };
    }
    if (config?.marginType !== "ISOLATED") {
      return {
        reasonCode:
          mutationOutcome === "RESULT_UNKNOWN" ? "MARGIN_TYPE_RESULT_UNKNOWN" : "MARGIN_TYPE_VERIFICATION_MISMATCH",
        message: "Margin type is still not verified as ISOLATED; the entry lifecycle stops here.",
      };
    }
    return null;
  }

  /**
   * Exactly TradeExecution.selectedLeverage — no clamp, no fallback, no
   * recalculation — verified by a GET re-read, with the resulting max notional
   * still covering the frozen position notional.
   */
  private async ensureExactLeverage(
    execution: TradeExecution
  ): Promise<{ reasonCode: EntryReasonCode; message: string } | null> {
    const symbol = execution.symbol;
    const wanted = execution.selectedLeverage;

    let config = await this.readSymbolConfig(symbol);
    if (config === undefined) {
      return { reasonCode: "LEVERAGE_RESULT_UNKNOWN", message: "Symbol configuration could not be read." };
    }

    const currentLeverage = config?.leverage === null || config?.leverage === undefined ? null : Number(config.leverage);
    if (currentLeverage === wanted) {
      return this.checkNotionalCapacity(execution, config?.maxNotionalValue ?? null);
    }

    const exposure = await this.symbolHasExposure(symbol);
    if (exposure === null) {
      return { reasonCode: "SYMBOL_EXPOSURE_CHANGED", message: "Symbol exposure could not be confirmed." };
    }
    if (exposure) {
      return { reasonCode: "SYMBOL_EXPOSURE_CHANGED", message: "Symbol carries exposure; leverage is not changed." };
    }

    let mutationOutcome: MutationOutcome = "CONFIRMED_ACCEPTED";
    let responseLeverage: number | null = null;
    try {
      const response = await this.mutations.setInitialLeverage(this.mutations.authorizeLiveEntry(), symbol, wanted);
      responseLeverage = response.leverage;
    } catch (error) {
      mutationOutcome = classifyMutationOutcome(this.asFailureShape(error), "SUBMIT_CONFIG");
      if (mutationOutcome === "CONFIRMED_REJECTED") {
        return { reasonCode: "LEVERAGE_CONFIGURATION_FAILED", message: "Leverage change was rejected." };
      }
    }

    if (responseLeverage !== null && responseLeverage !== wanted) {
      return {
        reasonCode: "LEVERAGE_VERIFICATION_MISMATCH",
        message: "Binance acknowledged a different leverage than the frozen selection.",
      };
    }

    config = await this.readSymbolConfig(symbol);
    if (config === undefined) {
      return { reasonCode: "LEVERAGE_RESULT_UNKNOWN", message: "Leverage could not be verified after the change." };
    }
    const verified = config?.leverage === null || config?.leverage === undefined ? null : Number(config.leverage);
    if (verified !== wanted) {
      return {
        reasonCode:
          mutationOutcome === "RESULT_UNKNOWN" ? "LEVERAGE_RESULT_UNKNOWN" : "LEVERAGE_VERIFICATION_MISMATCH",
        message: "Leverage is not verified at the exact frozen value; the entry lifecycle stops here.",
      };
    }

    return this.checkNotionalCapacity(execution, config?.maxNotionalValue ?? null);
  }

  private checkNotionalCapacity(
    execution: TradeExecution,
    maxNotionalValue: string | null
  ): { reasonCode: EntryReasonCode; message: string } | null {
    if (maxNotionalValue === null) return null;
    if (new D(maxNotionalValue).lessThan(execution.positionNotional)) {
      return {
        reasonCode: "LEVERAGE_NOTIONAL_LIMIT_MISMATCH",
        message: "The verified maximum notional no longer covers the frozen position notional.",
      };
    }
    return null;
  }

  /** Submit exactly one LIMIT entry, then resolve the result by client id. */
  private async submitAndReconcile(
    execution: TradeExecution,
    order: BinanceOrder,
    evaluatedAt: Date
  ): Promise<EntryLifecycleOutcome> {
    let outcome: MutationOutcome = "CONFIRMED_ACCEPTED";
    try {
      await this.mutations.submitLimitEntry(this.mutations.authorizeLiveEntry(), {
        symbol: execution.symbol,
        side: order.side as "BUY" | "SELL",
        positionSide: order.positionSide as "LONG" | "SHORT",
        // Exact frozen strings straight from the immutable plan.
        quantity: order.originalQuantity.toString(),
        price: (order.price ?? execution.plannedEntryPrice).toString(),
        newClientOrderId: order.clientOrderId,
      });
    } catch (error) {
      outcome = classifyMutationOutcome(this.asFailureShape(error), "SUBMIT_ORDER");
    }

    await this.prisma.binanceOrder.update({
      where: { id: order.id },
      data: {
        submittedAt: order.submittedAt ?? evaluatedAt,
        submissionUnknownAt: outcome === "RESULT_UNKNOWN" ? evaluatedAt : order.submissionUnknownAt,
      },
    });

    if (outcome === "CONFIRMED_REJECTED") {
      // Rejected before reaching the book: no exposure is possible, but the
      // order is still queried once so the claim is evidence-based.
      const check = await this.queryEntryOrder(execution.symbol, order.clientOrderId);
      if (check.outcome === "CONFIRMED_ACCEPTED" && check.order) {
        return this.applyOrderState(execution, order, check.order, {
          executionId: execution.id,
          expectedVersion: execution.version,
          evaluatedAt,
        });
      }
      return this.markSubmissionRejected(execution, order, evaluatedAt);
    }

    // Every other outcome — including a timeout — is resolved by asking about
    // the SAME client order id. A new id is never generated.
    return this.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt,
    });
  }

  // -------------------------------------------------------------------------
  // Persistence helpers
  // -------------------------------------------------------------------------

  /**
   * One transaction: order fields, execution actuals, lifecycle status, one
   * version increment and one event. A failing event rolls all of it back.
   */
  private async applyOrderState(
    execution: TradeExecution,
    order: BinanceOrder,
    observed: BinanceQueriedOrderDto,
    input: EntryLifecycleInput,
    cancelCause: CancelCause = "UNKNOWN"
  ): Promise<EntryLifecycleOutcome> {
    const exchangeStatus = normalizeExchangeOrderStatus(observed.status);
    const localStatus: LocalOrderStatusName = mapExchangeToLocalOrderStatus(exchangeStatus);

    const progress = mergeFillProgress(
      {
        executedQuantity: order.executedQuantity.toString(),
        averageFillPrice: order.averageFillPrice?.toString() ?? null,
      },
      { executedQuantity: observed.executedQty, averageFillPrice: observed.averagePrice }
    );

    const mapping = mapOrderToExecutionStatus({
      localOrderStatus: localStatus,
      executedQuantity: progress.executedQuantity,
      cancelCause,
    });

    const currentStatus = execution.status as TradeExecutionStatusName;
    const resolved = resolveReconciledStatus(currentStatus, mapping.executionStatus);
    const targetStatus = resolved.targetStatus;
    const reasonCode = resolved.refusedStatus ? "MANUAL_REVIEW_REQUIRED" : mapping.reasonCode;
    const message = resolved.refusedStatus
      ? `Entry order is ${localStatus}, but ${resolved.explanation}`
      : `Entry order is ${localStatus}.`;
    const filled = new D(progress.executedQuantity).greaterThan(0);

    const committed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.tradeExecution.updateMany({
        where: { id: execution.id, version: input.expectedVersion },
        data: {
          // A same-status reconciliation still records the observation.
          status: targetStatus === currentStatus ? undefined : targetStatus,
          version: { increment: 1 },
          decisionReasonCode: reasonCode,
          sanitizedMessage: message.slice(0, 1000),
          requiresManualIntervention:
            mapping.requiresManualIntervention || resolved.refusedStatus ? true : undefined,
          filledQuantity: filled ? new D(progress.executedQuantity) : undefined,
          averageFillPrice: progress.averageFillPrice ? new D(progress.averageFillPrice) : undefined,
          submittedEntryPrice: execution.submittedEntryPrice ?? order.price ?? undefined,
          entrySubmittedAt: execution.entrySubmittedAt ?? order.submittedAt ?? input.evaluatedAt,
          // Set once, never moved.
          firstFillAt: filled && !execution.firstFillAt ? input.evaluatedAt : undefined,
          entryFilledAt:
            localStatus === "FILLED" && !execution.entryFilledAt ? input.evaluatedAt : undefined,
          lastReconciledAt: input.evaluatedAt,
        },
      });
      if (updated.count === 0) return null;

      const next = await tx.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });

      await tx.binanceOrder.update({
        where: { id: order.id },
        data: {
          // Immutable once known.
          exchangeOrderId: order.exchangeOrderId ?? observed.orderId ?? undefined,
          status: localStatus,
          exchangeStatusRaw: observed.status ?? undefined,
          executedQuantity: new D(progress.executedQuantity),
          averageFillPrice: progress.averageFillPrice ? new D(progress.averageFillPrice) : undefined,
          submittedAt: order.submittedAt ?? input.evaluatedAt,
          lastExchangeUpdateAt: observed.updateTimeMs ? new Date(observed.updateTimeMs) : input.evaluatedAt,
          lastReconcileAt: input.evaluatedAt,
          reconcileAttempts: { increment: 1 },
        },
      });

      await tx.executionEvent.create({
        data: {
          tradeExecutionId: execution.id,
          sequenceNumber: next.version,
          eventType: resolved.refusedStatus ? "MANUAL_INTERVENTION_REQUIRED" : "ENTRY_RECONCILED",
          fromStatus: currentStatus,
          toStatus: next.status,
          reasonCode,
          message: resolved.refusedStatus
            ? `Entry order reconciled as ${localStatus}${filled ? " with a recorded fill" : ""}; ` +
              `${resolved.explanation} No compensating order was submitted.`
            : `Entry order reconciled as ${localStatus}${
                filled ? " with a recorded fill" : ""
              }; no compensating order was submitted.`,
          metadata: {
            localOrderStatus: localStatus,
            exchangeStatus: observed.status,
            cancelCause,
            regressionIgnored: progress.regressionIgnored,
            // What the ORDER mapped to, kept even when the execution could not
            // legally take it, so the refusal is auditable rather than silent.
            mappedExecutionStatus: mapping.executionStatus,
            refusedStatus: resolved.refusedStatus,
            // Exact decimal STRINGS (never JS numbers) of the fill as it stood
            // at THIS reconciliation. The mutable order row only ever shows the
            // latest quantity, so without this an observer that was offline
            // across 0.10 -> 0.15 -> 0.25 could never learn the intermediate
            // fills happened. Reading them is nobody's business here: this is
            // simply the durable history the event already describes.
            cumulativeFilledQuantity: progress.executedQuantity,
            plannedQuantity: execution.plannedQuantity.toFixed(),
            originalQuantity: order.originalQuantity.toFixed(),
            averageFillPrice: progress.averageFillPrice,
          } as Prisma.InputJsonValue,
        },
      });

      return next;
    });

    if (!committed) {
      const current = await this.loadExecution(execution.id);
      return this.result(
        false,
        "CAPACITY_OR_VERSION_CONFLICT",
        "Execution version changed during reconciliation; nothing was written.",
        current,
        await this.loadEntryOrder(execution.id)
      );
    }

    return this.result(
      // A refused status parks the execution, so the caller must stop exactly
      // as it does for `escalate` rather than continuing down the entry path.
      !resolved.refusedStatus,
      reasonCode,
      `Entry order is ${localStatus}; execution is ${committed.status}.`,
      committed,
      await this.loadEntryOrder(execution.id)
    );
  }

  private async markSubmissionRejected(
    execution: TradeExecution,
    order: BinanceOrder,
    evaluatedAt: Date
  ): Promise<EntryLifecycleOutcome> {
    const committed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.tradeExecution.updateMany({
        where: { id: execution.id, version: execution.version, status: "ENTRY_SUBMITTING" },
        data: {
          status: "FAILED",
          version: { increment: 1 },
          decisionReasonCode: "ENTRY_SUBMISSION_REJECTED",
          sanitizedMessage: "The entry order was rejected before reaching the order book.",
        },
      });
      if (updated.count === 0) return null;

      const next = await tx.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
      await tx.binanceOrder.update({ where: { id: order.id }, data: { status: "REJECTED" } });
      await tx.executionEvent.create({
        data: {
          tradeExecutionId: execution.id,
          sequenceNumber: next.version,
          eventType: "FAILURE_RECORDED",
          fromStatus: "ENTRY_SUBMITTING",
          toStatus: "FAILED",
          reasonCode: "ENTRY_SUBMISSION_REJECTED",
          message: "Entry submission was rejected; the order never reached the book.",
        },
      });
      return next;
    });

    if (!committed) {
      const current = await this.loadExecution(execution.id);
      return this.result(false, "CAPACITY_OR_VERSION_CONFLICT", "Version changed.", current, order);
    }
    return this.result(false, "ENTRY_SUBMISSION_REJECTED", "Entry submission was rejected.", committed, order);
  }

  /** Parks the execution for a human without ever unwinding exposure itself. */
  private async escalate(
    execution: TradeExecution,
    reasonCode: EntryReasonCode,
    message: string,
    input: EntryLifecycleInput
  ): Promise<EntryLifecycleOutcome> {
    const currentStatus = execution.status as TradeExecutionStatusName;
    const committed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.tradeExecution.updateMany({
        where: { id: execution.id, version: input.expectedVersion },
        data: {
          status: currentStatus === "MANUAL_INTERVENTION" ? undefined : "MANUAL_INTERVENTION",
          version: { increment: 1 },
          requiresManualIntervention: true,
          decisionReasonCode: reasonCode,
          sanitizedMessage: message.slice(0, 1000),
        },
      });
      if (updated.count === 0) return null;

      const next = await tx.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
      await tx.executionEvent.create({
        data: {
          tradeExecutionId: execution.id,
          sequenceNumber: next.version,
          eventType: "MANUAL_INTERVENTION_REQUIRED",
          fromStatus: currentStatus,
          toStatus: next.status,
          reasonCode,
          message: message.slice(0, 1000),
        },
      });
      return next;
    });

    if (!committed) {
      const current = await this.loadExecution(execution.id);
      return this.result(false, "CAPACITY_OR_VERSION_CONFLICT", "Version changed.", current, null);
    }
    return this.result(false, reasonCode, message, committed, await this.loadEntryOrder(execution.id));
  }

  // -------------------------------------------------------------------------
  // Read helpers
  // -------------------------------------------------------------------------

  private async queryEntryOrder(
    symbol: string,
    clientOrderId: string
  ): Promise<{ outcome: MutationOutcome; order: BinanceQueriedOrderDto | null }> {
    try {
      const order = await this.readOnly.queryOrderByClientOrderId(symbol, clientOrderId);
      return { outcome: "CONFIRMED_ACCEPTED", order };
    } catch (error) {
      return { outcome: classifyMutationOutcome(this.asFailureShape(error)), order: null };
    }
  }

  /** `undefined` means "could not read"; `null` means "no config row". */
  private async readSymbolConfig(symbol: string) {
    try {
      return await this.readOnly.getSymbolConfiguration(symbol);
    } catch {
      return undefined;
    }
  }

  /** `null` means the answer is unknown, which is never treated as "no". */
  private async symbolHasExposure(symbol: string): Promise<boolean | null> {
    try {
      const [positions, openOrders] = await Promise.all([
        this.readOnly.getPositionRisk(symbol),
        this.readOnly.getOpenOrders(symbol),
      ]);
      return positions.length > 0 || openOrders.length > 0;
    } catch {
      return null;
    }
  }

  private async loadExecution(executionId: string): Promise<TradeExecution> {
    const execution = await this.prisma.tradeExecution.findUnique({ where: { id: executionId } });
    if (!execution) throw new NotFoundError(`Execution ${executionId} not found.`);
    return execution;
  }

  /** ENTRY generation 1 is the ONLY reservation Phase 6 ever creates or reads. */
  private async loadEntryOrder(executionId: string): Promise<BinanceOrder | null> {
    return this.prisma.binanceOrder.findUnique({
      where: { tradeExecutionId_role_generation: { tradeExecutionId: executionId, role: "ENTRY", generation: 1 } },
    });
  }

  private environmentMatches(profileEnvironment: string): boolean {
    const host = env.BINANCE_FUTURES_REST_BASE_URL.toLowerCase();
    return profileEnvironment === (host.includes("testnet") ? "TESTNET" : "MAINNET");
  }

  private asFailureShape(error: unknown) {
    if (error instanceof BinanceLiveEntryDisabledError) {
      return { kind: "DISABLED", httpStatus: null, binanceCode: null };
    }
    if (error instanceof BinanceError) {
      return { kind: error.kind, httpStatus: error.httpStatus, binanceCode: error.binanceCode };
    }
    return { kind: "NETWORK", httpStatus: null, binanceCode: null };
  }

  private result(
    ok: boolean,
    reasonCode: EntryReasonCode,
    message: string,
    execution: TradeExecution,
    order: BinanceOrder | null
  ): EntryLifecycleOutcome {
    return { ok, reasonCode, message, execution, order, mutationsDispatched: this.mutations.mutationsDispatched };
  }
}
