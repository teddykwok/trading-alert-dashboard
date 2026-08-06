import { Prisma } from "@prisma/client";

/**
 * Phase 7 — pure SL/TP protection, liquidation-safety and closure logic.
 *
 * Deterministic and side-effect free: no Prisma, no HTTP, no fetch, no
 * environment read, no clock read, no logging, no Telegram, no queue and no
 * Binance client. Every time and every policy value is supplied by the caller.
 *
 * All quantity and price arithmetic uses arbitrary-precision decimals.
 */

const D = Prisma.Decimal;
type DecimalValue = InstanceType<typeof Prisma.Decimal>;

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

export const PROTECTION_REASON_CODES = [
  "PROTECTION_NOT_ENABLED",
  "EXECUTION_HAS_NO_CONFIRMED_FILL",
  "POSITION_STATE_UNAVAILABLE",
  "POSITION_NOT_FOUND_AFTER_FILL",
  "POSITION_IDENTITY_MISMATCH",
  "POSITION_QUANTITY_MISMATCH",
  "PROTECTION_FILTER_MISMATCH",
  "STOP_TRIGGER_INVALID",
  "TAKE_PROFIT_TRIGGER_INVALID",
  "PROTECTION_QUANTITY_UNSUPPORTED",
  "LIQUIDATION_PRICE_UNAVAILABLE",
  "LIQUIDATION_BUFFER_UNSAFE",
  "MARGIN_STATE_UNAVAILABLE",
  "MARGIN_BUDGET_EXHAUSTED",
  "AUTO_MARGIN_DISABLED",
  "INSUFFICIENT_MARGIN_BALANCE",
  "MARGIN_TOP_UP_SUBMITTING",
  "MARGIN_TOP_UP_REJECTED",
  "MARGIN_TOP_UP_RESULT_UNKNOWN",
  "MARGIN_TOP_UP_VERIFICATION_FAILED",
  "STOP_INTENT_CONFLICT",
  "STOP_SUBMISSION_REJECTED",
  "STOP_SUBMISSION_RESULT_UNKNOWN",
  "STOP_QUERY_UNAVAILABLE",
  "STOP_IDENTITY_MISMATCH",
  "STOP_NOT_VERIFIED",
  "TAKE_PROFIT_INTENT_CONFLICT",
  "TAKE_PROFIT_SUBMISSION_REJECTED",
  "TAKE_PROFIT_SUBMISSION_RESULT_UNKNOWN",
  "TAKE_PROFIT_QUERY_UNAVAILABLE",
  "TAKE_PROFIT_IDENTITY_MISMATCH",
  "TAKE_PROFIT_NOT_VERIFIED",
  "PROTECTION_COVERAGE_INCOMPLETE",
  "PROTECTION_GENERATION_CONFLICT",
  "EMERGENCY_CLOSE_DISABLED",
  "EMERGENCY_CLOSE_NOT_ELIGIBLE",
  "EMERGENCY_CLOSE_SUBMISSION_REJECTED",
  "EMERGENCY_CLOSE_RESULT_UNKNOWN",
  "EMERGENCY_CLOSE_VERIFICATION_FAILED",
  "SIBLING_CANCELLATION_REJECTED",
  "SIBLING_CANCELLATION_RESULT_UNKNOWN",
  "SIBLING_CLEANUP_INCOMPLETE",
  "PARTIAL_PROTECTION_EXIT",
  "CAPACITY_OR_VERSION_CONFLICT",
  "MANUAL_REVIEW_REQUIRED",
  "PROTECTION_VERIFIED",
  // --- Entry-remainder cleanup before terminal closure ---------------------
  "ENTRY_REMAINDER_CLEANUP_FAILED",
  "ENTRY_REFILLED_DURING_CLOSURE",
  "ENTRY_ORDER_STATE_UNAVAILABLE_DURING_CLOSURE",
] as const;

export type ProtectionReasonCode = (typeof PROTECTION_REASON_CODES)[number];

/**
 * Codes that mean "exposure may be unprotected right now". They outrank
 * everything else when several problems are reported at once, so the most
 * dangerous condition is always the one surfaced to an operator.
 */
export const CRITICAL_REASON_CODES: readonly ProtectionReasonCode[] = [
  "STOP_NOT_VERIFIED",
  "STOP_SUBMISSION_RESULT_UNKNOWN",
  "STOP_IDENTITY_MISMATCH",
  "LIQUIDATION_BUFFER_UNSAFE",
  "POSITION_IDENTITY_MISMATCH",
  "POSITION_NOT_FOUND_AFTER_FILL",
  "EMERGENCY_CLOSE_RESULT_UNKNOWN",
  "EMERGENCY_CLOSE_VERIFICATION_FAILED",
  "PARTIAL_PROTECTION_EXIT",
  "PROTECTION_COVERAGE_INCOMPLETE",
  "SIBLING_CLEANUP_INCOMPLETE",
  // A remaining entry order can refill and recreate exposure, so an unresolved
  // one is every bit as dangerous as a missing stop.
  "ENTRY_REFILLED_DURING_CLOSURE",
  "ENTRY_REMAINDER_CLEANUP_FAILED",
  "ENTRY_ORDER_STATE_UNAVAILABLE_DURING_CLOSURE",
  "MANUAL_REVIEW_REQUIRED",
];

/** Highest-priority (most dangerous) code from a set, in stable order. */
export function prioritizeReasonCodes(codes: readonly ProtectionReasonCode[]): ProtectionReasonCode | null {
  if (codes.length === 0) return null;
  for (const critical of CRITICAL_REASON_CODES) {
    if (codes.includes(critical)) return critical;
  }
  return codes[0];
}

export function isCriticalReason(code: ProtectionReasonCode): boolean {
  return CRITICAL_REASON_CODES.includes(code);
}

// ---------------------------------------------------------------------------
// Side / positionSide mapping
// ---------------------------------------------------------------------------

export type DirectionName = "LONG" | "SHORT";
export type OrderSideName = "BUY" | "SELL";
export type PositionSideName = "LONG" | "SHORT" | "BOTH";

/**
 * The side that REDUCES the exposure. A long is closed by selling, a short by
 * buying — for both the stop and the take profit.
 */
export function closingSide(direction: DirectionName): OrderSideName {
  return direction === "LONG" ? "SELL" : "BUY";
}

/** Hedge mode: positionSide always mirrors the direction and is never BOTH. */
export function protectionPositionSide(direction: DirectionName): DirectionName {
  return direction;
}

/** Hedge mode forbids BOTH and forbids a side that contradicts the direction. */
export function isValidHedgePositionSide(direction: DirectionName, positionSide: string): boolean {
  return positionSide === direction;
}

// ---------------------------------------------------------------------------
// Decimal helpers
// ---------------------------------------------------------------------------

function toDecimal(value: string | null | undefined): DecimalValue | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  try {
    const parsed = new D(String(value).trim());
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Absolute open quantity for the expected side. Binance reports a SHORT
 * positionAmt as negative, so the sign is validated against the direction
 * rather than being discarded blindly.
 */
export function normalizeOpenQuantity(
  positionAmt: string | null,
  direction: DirectionName
): { quantity: string; valid: boolean } {
  const amount = toDecimal(positionAmt);
  if (amount === null) return { quantity: "0", valid: false };
  if (amount.isZero()) return { quantity: "0", valid: true };

  const signMatchesDirection = direction === "LONG" ? amount.greaterThan(0) : amount.lessThan(0);
  return { quantity: amount.abs().toString(), valid: signMatchesDirection };
}

// ---------------------------------------------------------------------------
// Liquidation safety
// ---------------------------------------------------------------------------

export interface LiquidationSafetyResult {
  safe: boolean;
  reasonCode: ProtectionReasonCode | null;
}

/**
 * Revalidates the ACTUAL reported liquidation price against the frozen
 * required boundary. Exact equality is accepted.
 *
 * Missing, zero, malformed or contradictory data is never treated as safe —
 * this is the check that stands between a live position and a liquidation.
 */
export function evaluateLiquidationSafety(input: {
  direction: DirectionName;
  actualLiquidationPrice: string | null;
  requiredBoundary: string | null;
}): LiquidationSafetyResult {
  const actual = toDecimal(input.actualLiquidationPrice);
  const boundary = toDecimal(input.requiredBoundary);

  if (actual === null || boundary === null || actual.lessThanOrEqualTo(0) || boundary.lessThanOrEqualTo(0)) {
    return { safe: false, reasonCode: "LIQUIDATION_PRICE_UNAVAILABLE" };
  }

  // LONG liquidates BELOW the entry, so it must sit at or below the boundary.
  const safe = input.direction === "LONG" ? actual.lessThanOrEqualTo(boundary) : actual.greaterThanOrEqualTo(boundary);
  return { safe, reasonCode: safe ? null : "LIQUIDATION_BUFFER_UNSAFE" };
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export interface CoverageInput {
  confirmedOpenQuantity: string;
  /** Sum of ACTIVE VERIFIED stop coverage across every generation. */
  activeStopQuantity: string;
  activeTakeProfitQuantity: string;
}

export interface CoverageResult {
  missingStopQuantity: string;
  missingTakeProfitQuantity: string;
  /** The delta a new tranche must protect (the larger of the two gaps). */
  missingQuantity: string;
  fullyCovered: boolean;
  overProtected: boolean;
}

/**
 * Coverage arithmetic. A tranche protects the LARGER gap so one paired
 * generation closes both, and over-protection is reported rather than being
 * silently accepted.
 */
export function calculateCoverage(input: CoverageInput): CoverageResult {
  const open = toDecimal(input.confirmedOpenQuantity) ?? new D(0);
  const stop = toDecimal(input.activeStopQuantity) ?? new D(0);
  const takeProfit = toDecimal(input.activeTakeProfitQuantity) ?? new D(0);

  const missingStop = open.minus(stop);
  const missingTakeProfit = open.minus(takeProfit);
  const missing = missingStop.greaterThan(missingTakeProfit) ? missingStop : missingTakeProfit;

  return {
    missingStopQuantity: missingStop.greaterThan(0) ? missingStop.toString() : "0",
    missingTakeProfitQuantity: missingTakeProfit.greaterThan(0) ? missingTakeProfit.toString() : "0",
    missingQuantity: missing.greaterThan(0) ? missing.toString() : "0",
    fullyCovered: open.greaterThan(0) && stop.equals(open) && takeProfit.equals(open),
    overProtected: stop.greaterThan(open) || takeProfit.greaterThan(open),
  };
}

/**
 * Full protection requires positive exposure with BOTH aggregates exactly
 * equal to it. "Greater than or equal" would hide over-protection, and
 * anything less leaves an unprotected remainder.
 */
export function isFullyProtected(input: CoverageInput): boolean {
  const coverage = calculateCoverage(input);
  return coverage.fullyCovered && !coverage.overProtected;
}

// ---------------------------------------------------------------------------
// Trigger validation
// ---------------------------------------------------------------------------

export interface TriggerValidationInput {
  direction: DirectionName;
  stopTriggerPrice: string;
  takeProfitTriggerPrice: string | null;
  /** The price the triggers are evaluated against right now. */
  workingPrice: string | null;
  tickSize: string | null;
  stepSize: string | null;
  minQty: string | null;
  quantity: string;
}

export interface TriggerValidationResult {
  valid: boolean;
  reasonCode: ProtectionReasonCode | null;
  message: string | null;
}

function isMultipleOf(value: DecimalValue, step: string | null): boolean {
  if (!step) return true;
  const stepDecimal = toDecimal(step);
  if (stepDecimal === null || stepDecimal.lessThanOrEqualTo(0)) return true;
  return value.dividedBy(stepDecimal).modulo(1).isZero();
}

/**
 * Validates the FROZEN triggers against the current filters and working
 * price. Phase 7 never rounds or moves a trigger to make it acceptable — an
 * incompatible frozen value fails closed.
 */
export function validateProtectionTriggers(input: TriggerValidationInput): TriggerValidationResult {
  const stop = toDecimal(input.stopTriggerPrice);
  const quantity = toDecimal(input.quantity);

  if (stop === null || stop.lessThanOrEqualTo(0)) {
    return { valid: false, reasonCode: "STOP_TRIGGER_INVALID", message: "Stop trigger price is missing or not positive." };
  }
  if (quantity === null || quantity.lessThanOrEqualTo(0)) {
    return {
      valid: false,
      reasonCode: "PROTECTION_QUANTITY_UNSUPPORTED",
      message: "Protection quantity is missing or not positive.",
    };
  }
  if (!isMultipleOf(quantity, input.stepSize)) {
    return {
      valid: false,
      reasonCode: "PROTECTION_QUANTITY_UNSUPPORTED",
      message: "Protection quantity does not match the current step size.",
    };
  }
  const minQty = toDecimal(input.minQty);
  if (minQty !== null && quantity.lessThan(minQty)) {
    return {
      valid: false,
      reasonCode: "PROTECTION_QUANTITY_UNSUPPORTED",
      message: "Protection quantity is below the current minimum quantity.",
    };
  }
  if (!isMultipleOf(stop, input.tickSize)) {
    return { valid: false, reasonCode: "PROTECTION_FILTER_MISMATCH", message: "Stop trigger does not match the tick size." };
  }

  const working = toDecimal(input.workingPrice);
  if (working === null || working.lessThanOrEqualTo(0)) {
    return {
      valid: false,
      reasonCode: "POSITION_STATE_UNAVAILABLE",
      message: "The current working price is unavailable, so trigger direction cannot be checked.",
    };
  }

  // A stop that is already through the working price would fire immediately.
  if (input.direction === "LONG" && stop.greaterThanOrEqualTo(working)) {
    return {
      valid: false,
      reasonCode: "STOP_TRIGGER_INVALID",
      message: "A LONG stop must sit below the current working price.",
    };
  }
  if (input.direction === "SHORT" && stop.lessThanOrEqualTo(working)) {
    return {
      valid: false,
      reasonCode: "STOP_TRIGGER_INVALID",
      message: "A SHORT stop must sit above the current working price.",
    };
  }

  const takeProfit = toDecimal(input.takeProfitTriggerPrice);
  if (takeProfit !== null) {
    if (takeProfit.lessThanOrEqualTo(0) || !isMultipleOf(takeProfit, input.tickSize)) {
      return {
        valid: false,
        reasonCode: "TAKE_PROFIT_TRIGGER_INVALID",
        message: "Take-profit trigger is not positive or does not match the tick size.",
      };
    }
    if (input.direction === "LONG" && takeProfit.lessThanOrEqualTo(working)) {
      return {
        valid: false,
        reasonCode: "TAKE_PROFIT_TRIGGER_INVALID",
        message: "A LONG take profit must sit above the current working price.",
      };
    }
    if (input.direction === "SHORT" && takeProfit.greaterThanOrEqualTo(working)) {
      return {
        valid: false,
        reasonCode: "TAKE_PROFIT_TRIGGER_INVALID",
        message: "A SHORT take profit must sit below the current working price.",
      };
    }
  }

  return { valid: true, reasonCode: null, message: null };
}

// ---------------------------------------------------------------------------
// Algo status normalization
// ---------------------------------------------------------------------------

/** Documented USDⓈ-M algo/conditional statuses. */
export const ALGO_STATUSES = [
  "NEW",
  "WORKING",
  "TRIGGERED",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELLED",
  "CANCELED",
  "EXPIRED",
  "REJECTED",
  "FINISHED",
] as const;
export type AlgoStatusName = (typeof ALGO_STATUSES)[number];

export type NormalizedProtectionStatus =
  | "ACTIVE"
  | "TRIGGERED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "EXPIRED"
  | "REJECTED"
  | "UNKNOWN";

/**
 * Algo status semantics are NOT the same as standard-order status: an algo
 * order is "working" until it triggers, and only then creates an actual order.
 * An unrecognised token is never guessed at.
 */
export function normalizeAlgoStatus(raw: unknown): NormalizedProtectionStatus {
  if (typeof raw !== "string") return "UNKNOWN";
  switch (raw.trim().toUpperCase()) {
    case "NEW":
    case "WORKING":
      return "ACTIVE";
    case "TRIGGERED":
      return "TRIGGERED";
    case "PARTIALLY_FILLED":
      return "PARTIALLY_FILLED";
    case "FILLED":
    case "FINISHED":
      return "FILLED";
    case "CANCELLED":
    case "CANCELED":
      return "CANCELED";
    case "EXPIRED":
      return "EXPIRED";
    case "REJECTED":
      return "REJECTED";
    default:
      return "UNKNOWN";
  }
}

/** Only an ACTIVE conditional order counts towards verified coverage. */
export function countsAsActiveCoverage(status: NormalizedProtectionStatus): boolean {
  return status === "ACTIVE";
}

/** Still on the book, so cancellable. */
export function isCancellableProtection(status: NormalizedProtectionStatus): boolean {
  return status === "ACTIVE" || status === "TRIGGERED";
}

// ---------------------------------------------------------------------------
// Protection order identity
// ---------------------------------------------------------------------------

export interface ExpectedProtectionIdentity {
  clientAlgoId: string;
  symbol: string;
  orderType: "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  side: OrderSideName;
  positionSide: PositionSideName;
  quantity: string;
  triggerPrice: string;
  workingType: string;
  priceProtect: boolean;
}

export interface ObservedProtectionIdentity {
  clientAlgoId: string | null;
  symbol: string | null;
  orderType: string | null;
  side: string | null;
  positionSide: string | null;
  quantity: string | null;
  triggerPrice: string | null;
  workingType: string | null;
  priceProtect: boolean | null;
  closePosition: boolean | null;
  reduceOnly: boolean | null;
}

function decimalsEqual(a: string | null, b: string): boolean {
  const left = toDecimal(a);
  const right = toDecimal(b);
  return left !== null && right !== null && left.equals(right);
}

/**
 * Fields on which an observed protection order contradicts the local intent.
 * A non-empty result means we are looking at a DIFFERENT order and must never
 * rewrite our intent to match it.
 */
export function findProtectionIdentityMismatches(
  expected: ExpectedProtectionIdentity,
  observed: ObservedProtectionIdentity
): string[] {
  const mismatches: string[] = [];

  if (observed.clientAlgoId !== expected.clientAlgoId) mismatches.push("clientAlgoId");
  if ((observed.symbol ?? "").toUpperCase() !== expected.symbol.toUpperCase()) mismatches.push("symbol");
  if ((observed.orderType ?? "").toUpperCase() !== expected.orderType) mismatches.push("orderType");
  if ((observed.side ?? "").toUpperCase() !== expected.side) mismatches.push("side");
  if ((observed.positionSide ?? "").toUpperCase() !== expected.positionSide) mismatches.push("positionSide");
  if (!decimalsEqual(observed.quantity, expected.quantity)) mismatches.push("quantity");
  if (!decimalsEqual(observed.triggerPrice, expected.triggerPrice)) mismatches.push("triggerPrice");
  if ((observed.workingType ?? "").toUpperCase() !== expected.workingType.toUpperCase()) {
    mismatches.push("workingType");
  }
  if (observed.priceProtect !== null && observed.priceProtect !== expected.priceProtect) {
    mismatches.push("priceProtect");
  }
  // The strategy tracks filled quantity explicitly, so neither of these may
  // ever be true on our protection orders.
  if (observed.closePosition === true) mismatches.push("closePosition");
  if (observed.reduceOnly === true) mismatches.push("reduceOnly");

  return mismatches;
}

// ---------------------------------------------------------------------------
// Margin top-up
// ---------------------------------------------------------------------------

export interface MarginAllowanceInput {
  maximumIsolatedMargin: string;
  verifiedCurrentIsolatedMargin: string | null;
  availableBalance: string | null;
  autoAddMarginEnabled: boolean;
}

export interface MarginAllowanceResult {
  allowed: boolean;
  /** Exact amount that may be added — never more than the remaining budget. */
  amount: string;
  remainingAllowance: string;
  reasonCode: ProtectionReasonCode | null;
}

/**
 * How much isolated margin may be added right now.
 *
 * The total verified isolated margin may never exceed the FROZEN
 * maximumIsolatedMargin, so the allowance is recomputed from the verified
 * current margin on every attempt — retries after an ambiguous result can
 * therefore never accumulate past the cap.
 */
export function calculateMarginTopUp(input: MarginAllowanceInput): MarginAllowanceResult {
  const maximum = toDecimal(input.maximumIsolatedMargin);
  const current = toDecimal(input.verifiedCurrentIsolatedMargin);
  const available = toDecimal(input.availableBalance);

  if (maximum === null) {
    return { allowed: false, amount: "0", remainingAllowance: "0", reasonCode: "MARGIN_STATE_UNAVAILABLE" };
  }
  if (current === null) {
    // Never guess the current margin: adding on top of an unknown base could
    // blow straight through the cap.
    return { allowed: false, amount: "0", remainingAllowance: "0", reasonCode: "MARGIN_STATE_UNAVAILABLE" };
  }
  if (!input.autoAddMarginEnabled) {
    const remaining = maximum.minus(current);
    return {
      allowed: false,
      amount: "0",
      remainingAllowance: remaining.greaterThan(0) ? remaining.toString() : "0",
      reasonCode: "AUTO_MARGIN_DISABLED",
    };
  }

  const remaining = maximum.minus(current);
  if (remaining.lessThanOrEqualTo(0)) {
    return { allowed: false, amount: "0", remainingAllowance: "0", reasonCode: "MARGIN_BUDGET_EXHAUSTED" };
  }
  if (available === null) {
    return {
      allowed: false,
      amount: "0",
      remainingAllowance: remaining.toString(),
      reasonCode: "MARGIN_STATE_UNAVAILABLE",
    };
  }
  if (available.lessThan(remaining)) {
    // Only add what the account can actually fund.
    if (available.lessThanOrEqualTo(0)) {
      return {
        allowed: false,
        amount: "0",
        remainingAllowance: remaining.toString(),
        reasonCode: "INSUFFICIENT_MARGIN_BALANCE",
      };
    }
    return { allowed: true, amount: available.toString(), remainingAllowance: remaining.toString(), reasonCode: null };
  }

  return { allowed: true, amount: remaining.toString(), remainingAllowance: remaining.toString(), reasonCode: null };
}

/** The cap check applied to the POST-adjustment verified margin. */
export function isWithinMarginCap(verifiedMargin: string | null, maximumIsolatedMargin: string): boolean {
  const verified = toDecimal(verifiedMargin);
  const maximum = toDecimal(maximumIsolatedMargin);
  if (verified === null || maximum === null) return false;
  return verified.lessThanOrEqualTo(maximum);
}

// ---------------------------------------------------------------------------
// Emergency close
// ---------------------------------------------------------------------------

export type EmergencyCloseMode = "DISABLED" | "ON_UNVERIFIED_STOP";

export interface EmergencyEligibilityInput {
  mode: EmergencyCloseMode;
  confirmedOpenQuantity: string;
  activeStopQuantity: string;
  stopVerified: boolean;
  positionIdentityKnown: boolean;
  reconciliationAttemptsExhausted: boolean;
}

export interface EmergencyEligibilityResult {
  eligible: boolean;
  reasonCode: ProtectionReasonCode | null;
}

/**
 * Emergency close is a last resort. Every condition must hold: real exposure,
 * an unverifiable stop after the bounded budget, no verified coverage for the
 * full position, a known identity, and the mode explicitly switched on.
 */
export function evaluateEmergencyCloseEligibility(input: EmergencyEligibilityInput): EmergencyEligibilityResult {
  const open = toDecimal(input.confirmedOpenQuantity) ?? new D(0);
  const stop = toDecimal(input.activeStopQuantity) ?? new D(0);

  if (open.lessThanOrEqualTo(0)) {
    return { eligible: false, reasonCode: "EMERGENCY_CLOSE_NOT_ELIGIBLE" };
  }
  if (!input.positionIdentityKnown) {
    return { eligible: false, reasonCode: "POSITION_IDENTITY_MISMATCH" };
  }
  // A fully verified stop already protects the position — closing at market
  // would be strictly worse than letting the stop work.
  if (input.stopVerified && stop.greaterThanOrEqualTo(open)) {
    return { eligible: false, reasonCode: "EMERGENCY_CLOSE_NOT_ELIGIBLE" };
  }
  if (!input.reconciliationAttemptsExhausted) {
    return { eligible: false, reasonCode: "STOP_SUBMISSION_RESULT_UNKNOWN" };
  }
  if (input.mode === "DISABLED") {
    return { eligible: false, reasonCode: "EMERGENCY_CLOSE_DISABLED" };
  }

  return { eligible: true, reasonCode: null };
}

// ---------------------------------------------------------------------------
// Closure and sibling cleanup
// ---------------------------------------------------------------------------

export type ClosureReason = "TAKE_PROFIT" | "STOP_LOSS" | "EMERGENCY" | "NONE";

export interface ClosureClassificationInput {
  stopStatus: NormalizedProtectionStatus | null;
  takeProfitStatus: NormalizedProtectionStatus | null;
  emergencyFilled: boolean;
  remainingPositionQuantity: string;
}

export interface ClosureClassification {
  reason: ClosureReason;
  /** True only when the exchange confirms the position is genuinely flat. */
  positionClosed: boolean;
  /** A protection order fired but exposure remains — never a clean closure. */
  partialProtectionExit: boolean;
  reasonCode: ProtectionReasonCode | null;
}

/**
 * Classifies why (and whether) a position closed.
 *
 * A filled protection order is NOT proof of closure: only a confirmed zero
 * position quantity is. A protection fill alongside remaining exposure is a
 * partial exit, which is a critical condition rather than a terminal state.
 */
export function classifyClosure(input: ClosureClassificationInput): ClosureClassification {
  const remaining = toDecimal(input.remainingPositionQuantity);
  const flat = remaining !== null && remaining.abs().isZero();

  const stopFired = input.stopStatus === "FILLED";
  const takeProfitFired = input.takeProfitStatus === "FILLED";
  const anyFired = stopFired || takeProfitFired || input.emergencyFilled;

  if (!flat) {
    return {
      reason: "NONE",
      positionClosed: false,
      partialProtectionExit: anyFired,
      reasonCode: anyFired ? "PARTIAL_PROTECTION_EXIT" : null,
    };
  }

  if (input.emergencyFilled) {
    return { reason: "EMERGENCY", positionClosed: true, partialProtectionExit: false, reasonCode: null };
  }
  if (takeProfitFired) {
    return { reason: "TAKE_PROFIT", positionClosed: true, partialProtectionExit: false, reasonCode: null };
  }
  if (stopFired) {
    return { reason: "STOP_LOSS", positionClosed: true, partialProtectionExit: false, reasonCode: null };
  }

  return { reason: "NONE", positionClosed: true, partialProtectionExit: false, reasonCode: null };
}

export interface SiblingCandidate {
  clientAlgoId: string;
  role: "STOP_LOSS" | "TAKE_PROFIT";
  generation: number;
  status: NormalizedProtectionStatus;
}

/**
 * Plans which sibling protection orders to cancel after a closure.
 *
 * The guard that matters: while the position is still OPEN, the only verified
 * stop protecting it is never cancellable. Cleanup only becomes unrestricted
 * once the exchange confirms the position is flat.
 */
export function planSiblingCancellation(input: {
  siblings: readonly SiblingCandidate[];
  positionClosed: boolean;
}): { cancel: SiblingCandidate[]; blocked: SiblingCandidate[] } {
  const cancellable = input.siblings.filter((sibling) => isCancellableProtection(sibling.status));

  if (input.positionClosed) return { cancel: cancellable, blocked: [] };

  // Position still open: cancel nothing. Removing a stop here could leave live
  // exposure naked, and Phase 7 has no safe replacement plan to offer.
  return { cancel: [], blocked: cancellable };
}

// ---------------------------------------------------------------------------
// Entry-remainder cleanup before terminal closure
// ---------------------------------------------------------------------------

export type EntryRemainderAction =
  | "NO_REMAINDER"
  | "CANCEL_REMAINDER"
  | "BLOCK_UNRESOLVED"
  | "REFILLED_RECOVER_PROTECTION";

export interface EntryRemainderDecision {
  action: EntryRemainderAction;
  reasonCode: ProtectionReasonCode | null;
  message: string | null;
}

/**
 * Decides what to do with the original LIMIT entry when a protection exit has
 * apparently closed the position.
 *
 * The danger this exists to prevent: a partially filled entry (say 0.10 of
 * 0.25) whose protection closes the 0.10 leaves the position momentarily flat
 * while the remaining 0.15 is STILL WORKING on the book. Declaring the
 * execution CLOSED there would release capacity and tear down protection while
 * an order that can reopen the trade is still live.
 *
 * A protection exit terminates the trade plan — the remaining entry quantity
 * must never be allowed to reopen it, and it is never resubmitted.
 */
export function decideEntryRemainderCleanup(input: {
  /** Normalized status of the ENTRY generation 1 order. */
  entryStatus: LocalEntryStatus;
  /** True when the entry order could not be read at all. */
  entryStateUnavailable: boolean;
  identityMismatches: readonly string[];
}): EntryRemainderDecision {
  if (input.entryStateUnavailable) {
    return {
      action: "BLOCK_UNRESOLVED",
      reasonCode: "ENTRY_ORDER_STATE_UNAVAILABLE_DURING_CLOSURE",
      message: "The entry order state could not be read; closure cannot be declared.",
    };
  }
  if (input.identityMismatches.length > 0) {
    return {
      action: "BLOCK_UNRESOLVED",
      reasonCode: "ENTRY_REMAINDER_CLEANUP_FAILED",
      message: `Entry order identity is contradictory (${input.identityMismatches.join(", ")}).`,
    };
  }

  switch (input.entryStatus) {
    case "FILLED":
    case "CANCELED":
    case "EXPIRED":
    case "REJECTED":
      // Terminal on the exchange: nothing can refill.
      return { action: "NO_REMAINDER", reasonCode: null, message: null };

    case "NEW":
    case "PARTIALLY_FILLED":
      // Still working: the unfilled remainder must be cancelled first.
      return {
        action: "CANCEL_REMAINDER",
        reasonCode: null,
        message: "The entry order is still working and must be cancelled before closure.",
      };

    default:
      return {
        action: "BLOCK_UNRESOLVED",
        reasonCode: "ENTRY_ORDER_STATE_UNAVAILABLE_DURING_CLOSURE",
        message: "The entry order state is unknown; closure cannot be declared.",
      };
  }
}

export type LocalEntryStatus =
  | "NEW"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "EXPIRED"
  | "REJECTED"
  | "UNKNOWN";

/**
 * After the entry remainder has been dealt with, the position is read again.
 * If exposure reappeared, the entry refilled during cancellation — a real race
 * that must never be reported as a clean close.
 */
export function classifyPostCleanupPosition(remainingQuantity: string): EntryRemainderDecision {
  const remaining = toDecimal(remainingQuantity);
  if (remaining === null) {
    return {
      action: "BLOCK_UNRESOLVED",
      reasonCode: "ENTRY_ORDER_STATE_UNAVAILABLE_DURING_CLOSURE",
      message: "Position quantity could not be re-read after entry cleanup.",
    };
  }
  if (remaining.abs().greaterThan(0)) {
    return {
      action: "REFILLED_RECOVER_PROTECTION",
      reasonCode: "ENTRY_REFILLED_DURING_CLOSURE",
      message: "The entry refilled during cleanup; exposure exists again and needs protection.",
    };
  }
  return { action: "NO_REMAINDER", reasonCode: null, message: null };
}
