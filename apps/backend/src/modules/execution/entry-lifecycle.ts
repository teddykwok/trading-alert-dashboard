import { Prisma } from "@prisma/client";

/**
 * Phase 6 — pure LIMIT entry lifecycle mapping.
 *
 * Deterministic and side-effect free: no Prisma, no HTTP, no fetch, no
 * environment read, no clock read, no logging, no queue, no Telegram. Every
 * function takes the caller's `evaluatedAt` explicitly.
 *
 * This module answers "what does this exchange state MEAN for our local
 * lifecycle" — it never decides to call anything.
 */

const D = Prisma.Decimal;
type DecimalValue = InstanceType<typeof Prisma.Decimal>;

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

export const ENTRY_REASON_CODES = [
  "LIVE_ENTRY_DISABLED",
  "PROTECTION_NOT_READY",
  "EXECUTION_NOT_PREFLIGHT",
  "SAFETY_ADMISSION_NOT_READY",
  "KILL_SWITCH_RECHECK_ACTIVE",
  "SIGNAL_OR_ENTRY_DEADLINE_EXPIRED",
  "SYMBOL_STATE_CHANGED",
  "SYMBOL_EXPOSURE_CHANGED",
  "POSITION_MODE_MISMATCH",
  "ASSET_MODE_MISMATCH",
  "MARGIN_TYPE_CONFIGURATION_FAILED",
  "MARGIN_TYPE_RESULT_UNKNOWN",
  "MARGIN_TYPE_VERIFICATION_MISMATCH",
  "LEVERAGE_CONFIGURATION_FAILED",
  "LEVERAGE_RESULT_UNKNOWN",
  "LEVERAGE_VERIFICATION_MISMATCH",
  "LEVERAGE_NOTIONAL_LIMIT_MISMATCH",
  "ENTRY_INTENT_CONFLICT",
  "ENTRY_SUBMISSION_REJECTED",
  "ENTRY_SUBMISSION_RESULT_UNKNOWN",
  "ENTRY_ORDER_QUERY_UNAVAILABLE",
  "ENTRY_ORDER_NOT_FOUND",
  "ENTRY_ORDER_IDENTITY_MISMATCH",
  "ENTRY_STATUS_UNSUPPORTED",
  "ENTRY_TTL_EXPIRED",
  "ENTRY_CANCEL_REJECTED",
  "ENTRY_CANCEL_RESULT_UNKNOWN",
  "PARTIAL_FILL_REMAINDER_CANCELED",
  "UNPROTECTED_PARTIAL_FILL",
  "CAPACITY_OR_VERSION_CONFLICT",
  "MANUAL_REVIEW_REQUIRED",
  // A PREFLIGHT execution released BEFORE any reservation existed, because new
  // entry is blocked and the exchange was proven flat. Distinct from every
  // cancellation code above: nothing was ever sent, so there was nothing to
  // cancel — only local capacity to give back.
  "PREFLIGHT_ABANDONED_NEW_ENTRY_BLOCKED",
  // The same pre-submission release, but because the signal or entry deadline
  // has passed. The gates may be wide open: this execution is simply too old to
  // trade, which is a SKIP (deliberately not traded) rather than a cancellation.
  "PREFLIGHT_SKIPPED_SIGNAL_EXPIRED",
  "ENTRY_SUBMITTED",
  "ENTRY_RECONCILED",
] as const;

export type EntryReasonCode = (typeof ENTRY_REASON_CODES)[number];

// ---------------------------------------------------------------------------
// Side / position-side mapping
// ---------------------------------------------------------------------------

export type ExecutionDirectionName = "LONG" | "SHORT";
export type OrderSideName = "BUY" | "SELL";
export type PositionSideName = "LONG" | "SHORT" | "BOTH";

/** Entry only: LONG opens with BUY, SHORT opens with SELL. */
export function entryOrderSide(direction: ExecutionDirectionName): OrderSideName {
  return direction === "LONG" ? "BUY" : "SELL";
}

/** HEDGE mode: positionSide mirrors the direction and is never BOTH. */
export function entryPositionSide(direction: ExecutionDirectionName): PositionSideName {
  return direction;
}

// ---------------------------------------------------------------------------
// Exchange order status normalization
// ---------------------------------------------------------------------------

/** Documented USDⓈ-M order statuses. */
export const BINANCE_ORDER_STATUSES = [
  "NEW",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
  "EXPIRED_IN_MATCH",
] as const;
export type BinanceOrderStatusName = (typeof BINANCE_ORDER_STATUSES)[number];

export type LocalOrderStatusName =
  | "PLANNED"
  | "SUBMITTING"
  | "NEW"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "EXPIRED"
  | "REJECTED"
  | "UNKNOWN";

/**
 * Normalizes Binance's status token. An unrecognised token is NOT guessed at —
 * it returns null so the caller records UNKNOWN and retries rather than
 * inventing a lifecycle transition.
 */
export function normalizeExchangeOrderStatus(raw: unknown): BinanceOrderStatusName | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim().toUpperCase();
  return (BINANCE_ORDER_STATUSES as readonly string[]).includes(token)
    ? (token as BinanceOrderStatusName)
    : null;
}

/** Exchange status → local BinanceOrder.status. EXPIRED_IN_MATCH folds to EXPIRED. */
export function mapExchangeToLocalOrderStatus(status: BinanceOrderStatusName | null): LocalOrderStatusName {
  switch (status) {
    case "NEW":
      return "NEW";
    case "PARTIALLY_FILLED":
      return "PARTIALLY_FILLED";
    case "FILLED":
      return "FILLED";
    case "CANCELED":
      return "CANCELED";
    case "REJECTED":
      return "REJECTED";
    case "EXPIRED":
    case "EXPIRED_IN_MATCH":
      return "EXPIRED";
    default:
      return "UNKNOWN";
  }
}

// ---------------------------------------------------------------------------
// Local order status → TradeExecution status
// ---------------------------------------------------------------------------

export type ExecutionStatusName =
  | "PLAN_READY"
  | "PREFLIGHT"
  | "ENTRY_SUBMITTING"
  | "ENTRY_PENDING"
  | "PARTIALLY_FILLED"
  | "ENTRY_FILLED"
  | "PLACING_PROTECTION"
  | "PROTECTED"
  | "ENTRY_EXPIRED"
  | "CLOSED_TP"
  | "CLOSED_SL"
  | "CANCELED"
  | "SKIPPED"
  | "FAILED"
  | "MANUAL_INTERVENTION";

/** Why an order stopped being open, when we know. */
export type CancelCause = "TTL" | "OPERATOR" | "UNKNOWN" | "SOFT_OPEN_TARGET";

export interface ExecutionStatusMapping {
  executionStatus: ExecutionStatusName;
  reasonCode: EntryReasonCode;
  requiresManualIntervention: boolean;
  /** True when live exposure is known or cannot be ruled out. */
  exposurePossible: boolean;
}

function hasFill(executedQuantity: string): boolean {
  try {
    return new D(executedQuantity).greaterThan(0);
  } catch {
    // Unparseable quantity is treated as "a fill may exist" — never as zero.
    return true;
  }
}

/**
 * Maps a reconciled order onto the execution lifecycle.
 *
 * The safety-critical rule lives here: an order that stopped being open while
 * carrying a NON-ZERO executed quantity leaves a live, unprotected position.
 * Until Phase 7 can protect it, that is MANUAL_INTERVENTION — never the
 * terminal ENTRY_EXPIRED, which asserts there is nothing to unwind.
 */
export function mapOrderToExecutionStatus(input: {
  localOrderStatus: LocalOrderStatusName;
  executedQuantity: string;
  cancelCause?: CancelCause;
}): ExecutionStatusMapping {
  const filled = hasFill(input.executedQuantity);
  const cause = input.cancelCause ?? "UNKNOWN";

  switch (input.localOrderStatus) {
    case "NEW":
      return {
        executionStatus: "ENTRY_PENDING",
        reasonCode: "ENTRY_RECONCILED",
        requiresManualIntervention: false,
        exposurePossible: false,
      };

    case "PARTIALLY_FILLED":
      return {
        executionStatus: "PARTIALLY_FILLED",
        reasonCode: "ENTRY_RECONCILED",
        requiresManualIntervention: false,
        exposurePossible: true,
      };

    case "FILLED":
      return {
        executionStatus: "ENTRY_FILLED",
        reasonCode: "ENTRY_RECONCILED",
        requiresManualIntervention: false,
        exposurePossible: true,
      };

    case "CANCELED":
      if (filled) {
        // A partial fill with the remainder cancelled. WHY it was cancelled
        // decides everything, so the two causes are kept apart:
        //
        // SOFT_OPEN_TARGET — we withdrew the remainder on purpose because the
        // profile hit its soft open-position target. The filled quantity is an
        // ordinary open position: ENTRY_FILLED keeps the open-position slot,
        // releases the pending slot the (now cancelled) remainder held, and is
        // the state the orchestrator routes straight into
        // `ensureProtectionForExposure`. Raising manual intervention here would
        // page a human for the system doing exactly what it was told.
        if (cause === "SOFT_OPEN_TARGET") {
          return {
            executionStatus: "ENTRY_FILLED",
            reasonCode: "ENTRY_RECONCILED",
            requiresManualIntervention: false,
            exposurePossible: true,
          };
        }
        // Every other cause: a real position exists and is unprotected.
        // Releasing it as ENTRY_EXPIRED would claim there is no exposure and
        // would free open-position capacity that is still in use.
        return {
          executionStatus: "MANUAL_INTERVENTION",
          reasonCode: "UNPROTECTED_PARTIAL_FILL",
          requiresManualIntervention: true,
          exposurePossible: true,
        };
      }
      // No fill at all. A soft-target withdrawal is a deliberate stop before
      // any exposure — exactly what CANCELED means — not an expiry.
      return cause === "OPERATOR" || cause === "SOFT_OPEN_TARGET"
        ? {
            executionStatus: "CANCELED",
            reasonCode: "ENTRY_RECONCILED",
            requiresManualIntervention: false,
            exposurePossible: false,
          }
        : {
            executionStatus: "ENTRY_EXPIRED",
            reasonCode: "ENTRY_TTL_EXPIRED",
            requiresManualIntervention: false,
            exposurePossible: false,
          };

    case "EXPIRED":
      if (filled) {
        return {
          executionStatus: "MANUAL_INTERVENTION",
          reasonCode: "UNPROTECTED_PARTIAL_FILL",
          requiresManualIntervention: true,
          exposurePossible: true,
        };
      }
      return {
        executionStatus: "ENTRY_EXPIRED",
        reasonCode: "ENTRY_TTL_EXPIRED",
        requiresManualIntervention: false,
        exposurePossible: false,
      };

    case "REJECTED":
      if (filled) {
        return {
          executionStatus: "MANUAL_INTERVENTION",
          reasonCode: "UNPROTECTED_PARTIAL_FILL",
          requiresManualIntervention: true,
          exposurePossible: true,
        };
      }
      // No fill is possible on a rejection, so FAILED's "no unresolved
      // exposure" assertion holds.
      return {
        executionStatus: "FAILED",
        reasonCode: "ENTRY_SUBMISSION_REJECTED",
        requiresManualIntervention: false,
        exposurePossible: false,
      };

    default:
      // UNKNOWN / SUBMITTING / PLANNED: exposure cannot be ruled out, so the
      // caller keeps retrying and only parks the execution when its bounded
      // budget runs out.
      return {
        executionStatus: "MANUAL_INTERVENTION",
        reasonCode: "ENTRY_STATUS_UNSUPPORTED",
        requiresManualIntervention: true,
        exposurePossible: true,
      };
  }
}

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

/** Inclusive: the exact deadline instant is already due. */
export function isEntryTtlDue(evaluatedAt: Date, deadline: Date | null): boolean {
  if (!deadline || Number.isNaN(deadline.getTime())) return false;
  return evaluatedAt.getTime() >= deadline.getTime();
}

/** Derived ONCE from the committed submission intent, then never recomputed. */
export function entryDeadlineFrom(submittedAt: Date, ttlSeconds: number): Date {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error("Entry TTL seconds must be a positive safe integer.");
  }
  return new Date(submittedAt.getTime() + ttlSeconds * 1000);
}

// ---------------------------------------------------------------------------
// Mutation outcome classification
// ---------------------------------------------------------------------------

export const MUTATION_OUTCOMES = [
  "CONFIRMED_ACCEPTED",
  "CONFIRMED_REJECTED",
  "RESULT_UNKNOWN",
  "QUERY_RETRYABLE",
  "NOT_FOUND_CONFIRMED",
  "CONFLICT",
  "MANUAL_REVIEW_REQUIRED",
] as const;
export type MutationOutcome = (typeof MUTATION_OUTCOMES)[number];

export interface MutationFailureShape {
  kind: string;
  httpStatus?: number | null;
  binanceCode?: number | null;
}

/**
 * Which exchange operation produced the failure.
 *
 * Absence is NOT a global property of an error code — it depends on what was
 * asked. -2011 is documented as CANCEL_REJECTED, "cancel failed because the
 * open order was not found": that proves absence for a DELETE and says nothing
 * whatsoever about a GET. Classifying it globally let a query inherit a
 * cancel-only semantic, so the operation is now explicit.
 */
export type MutationOperation =
  /** POST /fapi/v1/order — standard `clientOrderId` semantics apply. */
  | "SUBMIT_ORDER"
  /**
   * POST /fapi/v1/algoOrder — the identity is `clientAlgoId`. Binance's
   * duplicate-id semantics are documented for standard orders; the current
   * Algo Order documentation does not establish the same code for
   * `clientAlgoId`, so this family gets NO existence proof from a duplicate.
   */
  | "SUBMIT_ALGO"
  /** marginType / leverage / positionMargin — no order identity is involved. */
  | "SUBMIT_CONFIG"
  | "CANCEL"
  | "QUERY";

/**
 * Documented Binance codes this phase is willing to interpret, per operation.
 * Anything else is deliberately left unclassified rather than guessed at.
 *
 *   -2013 NO_SUCH_ORDER      "Order does not exist."  — proves absence for a
 *                            query AND for a cancel.
 *   -2011 CANCEL_REJECTED    documented only in the cancel context, so it may
 *                            prove absence for a DELETE and never for a GET.
 *
 * A submission can never prove absence: it was asking to CREATE something.
 */
const ABSENCE_CODES_BY_OPERATION: Record<MutationOperation, readonly number[]> = {
  SUBMIT_ORDER: [],
  SUBMIT_ALGO: [],
  SUBMIT_CONFIG: [],
  CANCEL: [-2011, -2013],
  QUERY: [-2013],
};

/**
 * The ONLY operation for which a duplicate-id error proves the order exists.
 *
 * Deliberately not `SUBMIT_ALGO`: an algo duplicate stays RESULT_UNKNOWN, which
 * sends the caller to query the SAME deterministic `clientAlgoId` and resolve
 * it definitively. No new identity is ever minted on an unestablished
 * semantic.
 */
const DUPLICATE_PROVING_OPERATIONS: readonly MutationOperation[] = ["SUBMIT_ORDER"];

/**
 * -4116 DUPLICATED_CLIENT_ORDER_ID is the documented duplicate code, and only
 * on submission — a duplicate id proves the order EXISTS, which is the one
 * case that must never be mistaken for absence.
 *
 * -4015 is deliberately NOT here: it is INVALID_CL_ORD_ID_LEN ("client order
 * id length should not be more than 36 chars"), a request-validation error.
 * Reading it as "duplicate" would have claimed an order exists on the strength
 * of a malformed id.
 *
 * Restricted to SUBMIT_ORDER, the standard-order family. Whether Algo Order
 * submission reports duplicates the same way is not established by the current
 * documentation, so SUBMIT_ALGO gets no existence proof: an algo duplicate
 * stays RESULT_UNKNOWN, which makes the caller query the same deterministic
 * `clientAlgoId` and resolve it definitively, rather than acting on an assumed
 * semantic.
 */
const DUPLICATE_CLIENT_ORDER_ID_CODES: readonly number[] = [-4116];

/**
 * Classifies a failed mutation.
 *
 * The central rule: a timeout, connection reset or 5xx is NOT proof that the
 * exchange did nothing. Those become RESULT_UNKNOWN, which obliges the caller
 * to reconcile by client order id instead of retrying blind.
 */
export function classifyMutationOutcome(
  failure: MutationFailureShape | null,
  /**
   * Defaults to QUERY, the NARROWEST interpretation: only -2013 proves
   * absence and no code proves a duplicate. A caller that genuinely cancelled
   * or submitted must say so to widen it.
   */
  operation: MutationOperation = "QUERY"
): MutationOutcome {
  if (!failure) return "CONFIRMED_ACCEPTED";

  if (failure.binanceCode !== null && failure.binanceCode !== undefined) {
    if (
      DUPLICATE_PROVING_OPERATIONS.includes(operation) &&
      DUPLICATE_CLIENT_ORDER_ID_CODES.includes(failure.binanceCode)
    ) {
      return "CONFLICT";
    }
    if (ABSENCE_CODES_BY_OPERATION[operation].includes(failure.binanceCode)) return "NOT_FOUND_CONFIRMED";
  }

  switch (failure.kind) {
    case "TIMEOUT":
    case "NETWORK":
    case "SERVER":
      // Ambiguous: the request may well have been executed.
      return "RESULT_UNKNOWN";
    case "RATE_LIMIT":
    case "IP_BANNED":
      // Nothing was executed, but the call is worth retrying under backoff.
      return "QUERY_RETRYABLE";
    case "MALFORMED_RESPONSE":
      return "RESULT_UNKNOWN";
    case "AUTH":
    case "PERMISSION":
    case "IP_RESTRICTED":
    case "FUTURES_NOT_ENABLED":
    case "DISABLED":
    case "MISSING_CREDENTIALS":
    case "READ_ONLY_VIOLATION":
    case "UNSUPPORTED_SYMBOL":
    // Binance parsed the request and refused it on a documented validation
    // code, so nothing was created. Treating this as ambiguous is what left
    // the first real canary unprotected and parked for a human.
    case "REQUEST_INVALID":
    // Binance evaluated a well-formed request and refused it on a documented
    // business rule (insufficient margin/balance, notional or price filter).
    // The answer is definitive and the matching engine created nothing, so
    // this is a rejection rather than an unknown — the distinction that lets
    // the entry terminalize instead of being resubmitted forever.
    case "ORDER_REJECTED":
      // The request never reached the matching engine.
      return "CONFIRMED_REJECTED";
    default:
      return "RESULT_UNKNOWN";
  }
}

// ---------------------------------------------------------------------------
// Order identity
// ---------------------------------------------------------------------------

export interface ExpectedOrderIdentity {
  symbol: string;
  side: OrderSideName;
  positionSide: PositionSideName;
  orderType: string;
  price: string;
  originalQuantity: string;
  clientOrderId: string;
}

export interface ObservedOrderIdentity {
  symbol: string | null;
  side: string | null;
  positionSide: string | null;
  orderType: string | null;
  price: string | null;
  originalQuantity: string | null;
  clientOrderId: string | null;
}

function decimalsEqual(a: string | null, b: string): boolean {
  if (a === null) return false;
  try {
    return new D(a).equals(new D(b));
  } catch {
    return false;
  }
}

/**
 * Returns the fields on which an observed exchange order contradicts the local
 * intent. A non-empty list means we are looking at a DIFFERENT order than the
 * one we reserved, which must never be silently written over local intent.
 */
export function findOrderIdentityMismatches(
  expected: ExpectedOrderIdentity,
  observed: ObservedOrderIdentity
): string[] {
  const mismatches: string[] = [];

  if ((observed.symbol ?? "").toUpperCase() !== expected.symbol.toUpperCase()) mismatches.push("symbol");
  if ((observed.side ?? "").toUpperCase() !== expected.side) mismatches.push("side");
  if ((observed.positionSide ?? "").toUpperCase() !== expected.positionSide) mismatches.push("positionSide");
  if ((observed.orderType ?? "").toUpperCase() !== expected.orderType.toUpperCase()) mismatches.push("orderType");
  if (!decimalsEqual(observed.price, expected.price)) mismatches.push("price");
  if (!decimalsEqual(observed.originalQuantity, expected.originalQuantity)) mismatches.push("originalQuantity");
  if (observed.clientOrderId !== expected.clientOrderId) mismatches.push("clientOrderId");

  return mismatches;
}

// ---------------------------------------------------------------------------
// Monotonic fill tracking
// ---------------------------------------------------------------------------

export interface FillProgress {
  executedQuantity: string;
  averageFillPrice: string | null;
  /** True when the observed values moved backwards and were ignored. */
  regressionIgnored: boolean;
}

/**
 * Fills only ever move forward. An exchange read that reports LESS filled than
 * we have already durably observed is stale or partial, and accepting it would
 * understate live exposure — so the previous value is kept and the regression
 * is flagged.
 */
export function mergeFillProgress(
  previous: { executedQuantity: string; averageFillPrice: string | null },
  observed: { executedQuantity: string | null; averageFillPrice: string | null }
): FillProgress {
  let previousQty: DecimalValue;
  try {
    previousQty = new D(previous.executedQuantity);
  } catch {
    previousQty = new D(0);
  }

  if (observed.executedQuantity === null) {
    return {
      executedQuantity: previousQty.toString(),
      averageFillPrice: previous.averageFillPrice,
      regressionIgnored: false,
    };
  }

  let observedQty: DecimalValue;
  try {
    observedQty = new D(observed.executedQuantity);
  } catch {
    return {
      executedQuantity: previousQty.toString(),
      averageFillPrice: previous.averageFillPrice,
      regressionIgnored: true,
    };
  }

  if (observedQty.lessThan(previousQty)) {
    return {
      executedQuantity: previousQty.toString(),
      averageFillPrice: previous.averageFillPrice,
      regressionIgnored: true,
    };
  }

  // An average price is only meaningful alongside a fill; a null or zero
  // reading never clears a price we already recorded.
  const nextAverage =
    observed.averageFillPrice !== null && new D(observed.averageFillPrice || "0").greaterThan(0)
      ? observed.averageFillPrice
      : previous.averageFillPrice;

  return {
    executedQuantity: observedQty.toString(),
    averageFillPrice: nextAverage,
    regressionIgnored: false,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation decision
// ---------------------------------------------------------------------------

export type ReconciliationAction =
  | "APPLY_ORDER_STATE"
  | "RETRY_QUERY"
  | "RESUBMIT_SAME_CLIENT_ORDER_ID"
  | "ESCALATE_MANUAL"
  | "STOP_NOT_FOUND";

export interface ReconciliationDecision {
  action: ReconciliationAction;
  reasonCode: EntryReasonCode;
}

/**
 * Decides what to do with a query result for the reserved client order id.
 *
 * `exposurePossible` is the pivot: once a submission has been attempted we can
 * never claim "no order exists" without positive evidence, so an exhausted
 * budget escalates to a human instead of quietly giving up.
 */
export function decideReconciliation(input: {
  queryOutcome: MutationOutcome;
  identityMismatches: string[];
  attempt: number;
  maxAttempts: number;
  exposurePossible: boolean;
}): ReconciliationDecision {
  if (input.identityMismatches.length > 0) {
    return { action: "ESCALATE_MANUAL", reasonCode: "ENTRY_ORDER_IDENTITY_MISMATCH" };
  }

  switch (input.queryOutcome) {
    case "CONFIRMED_ACCEPTED":
      return { action: "APPLY_ORDER_STATE", reasonCode: "ENTRY_RECONCILED" };

    case "NOT_FOUND_CONFIRMED":
      // Binance positively reports the order does not exist. Only after the
      // full confirmation window may the SAME client order id be resubmitted.
      if (input.attempt >= input.maxAttempts) {
        return input.exposurePossible
          ? { action: "RESUBMIT_SAME_CLIENT_ORDER_ID", reasonCode: "ENTRY_ORDER_NOT_FOUND" }
          : { action: "STOP_NOT_FOUND", reasonCode: "ENTRY_ORDER_NOT_FOUND" };
      }
      return { action: "RETRY_QUERY", reasonCode: "ENTRY_ORDER_NOT_FOUND" };

    case "CONFLICT":
      // A duplicate client order id proves the order DOES exist — query it.
      return { action: "RETRY_QUERY", reasonCode: "ENTRY_INTENT_CONFLICT" };

    case "QUERY_RETRYABLE":
    case "RESULT_UNKNOWN":
      if (input.attempt < input.maxAttempts) {
        return { action: "RETRY_QUERY", reasonCode: "ENTRY_ORDER_QUERY_UNAVAILABLE" };
      }
      return input.exposurePossible
        ? { action: "ESCALATE_MANUAL", reasonCode: "MANUAL_REVIEW_REQUIRED" }
        : { action: "STOP_NOT_FOUND", reasonCode: "ENTRY_ORDER_QUERY_UNAVAILABLE" };

    case "CONFIRMED_REJECTED":
      return input.exposurePossible
        ? { action: "ESCALATE_MANUAL", reasonCode: "MANUAL_REVIEW_REQUIRED" }
        : { action: "STOP_NOT_FOUND", reasonCode: "ENTRY_SUBMISSION_REJECTED" };

    default:
      return { action: "ESCALATE_MANUAL", reasonCode: "MANUAL_REVIEW_REQUIRED" };
  }
}

/**
 * Whether a cancel may be issued at all. A FILLED order must never receive
 * another cancel, and no compensating opposite trade is ever an option here.
 */
export function shouldCancelRemainder(localOrderStatus: LocalOrderStatusName): boolean {
  return localOrderStatus === "NEW" || localOrderStatus === "PARTIALLY_FILLED";
}
