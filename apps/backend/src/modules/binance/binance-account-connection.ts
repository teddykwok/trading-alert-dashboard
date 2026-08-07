import { Prisma } from "@prisma/client";
import type { BinanceSymbolFiltersDto } from "./binance.types";

/**
 * Phase 10 — pure account-readiness logic.
 *
 * No network, no Prisma, no credentials, no I/O. Everything here is a function
 * of values the caller already read, which is what makes the readiness rules
 * and the local filter validation testable without touching a real account.
 */

const D = Prisma.Decimal;

// ---------------------------------------------------------------------------
// Stable readiness codes
// ---------------------------------------------------------------------------

export const ACCOUNT_READINESS_CODES = [
  "CONNECTED",
  "AUTHENTICATION_FAILED",
  "CLOCK_SYNC_FAILED",
  "FUTURES_ACCOUNT_UNAVAILABLE",
  "POSITION_MODE_MISMATCH",
  "ASSET_MODE_MISMATCH",
  "OPEN_POSITIONS_PRESENT",
  "OPEN_ORDERS_PRESENT",
  "ACCOUNT_SETUP_SAFE",
  "ACCOUNT_SETUP_BLOCKED",
] as const;

export type AccountReadinessCode = (typeof ACCOUNT_READINESS_CODES)[number];

/**
 * The connection-readiness ladder. Phase 10 can reach at most
 * TEST_ORDER_VALIDATED; LIVE_CANARY_NOT_ENABLED is the terminal state for this
 * phase because enabling a live canary is Phase 11's decision, not something a
 * successful validation earns.
 */
export const CONNECTION_READINESS_STATES = [
  "NOT_CONNECTED",
  "READ_ONLY_READY",
  "ACCOUNT_MODE_BLOCKED",
  "TRADING_PERMISSION_UNVERIFIED",
  "TEST_ORDER_READY",
  "TEST_ORDER_VALIDATED",
  "LIVE_CANARY_NOT_ENABLED",
] as const;

export type ConnectionReadinessState = (typeof CONNECTION_READINESS_STATES)[number];

export const EXPECTED_POSITION_MODE = "HEDGE" as const;
export const EXPECTED_ASSET_MODE = "SINGLE_ASSET" as const;

// ---------------------------------------------------------------------------
// Health result — sanitized counts only
// ---------------------------------------------------------------------------

/**
 * Everything a health check may report.
 *
 * Deliberately absent: wallet or available balance, position symbols, position
 * quantities, entry/liquidation prices, order ids, the account alias, the API
 * key, the API secret and any signed URL. Counts only.
 */
export interface BinanceAccountHealthDto {
  connected: boolean;
  serverTimeReachable: boolean;
  signedRequestWorks: boolean;
  futuresAccountReachable: boolean;
  positionMode: string | null;
  assetMode: string | null;
  nonZeroPositionCount: number | null;
  openOrderCount: number | null;
  symbolConfigReachable: boolean;
  leverageBracketReachable: boolean;
  clockOffsetMs: number | null;
  accountSetupSafe: boolean;
  testOrderCapabilityConfigured: boolean;
  accountSetupMutationsConfigured: boolean;
  liveEntryEnabled: boolean;
  protectionReady: boolean;
  readinessCodes: AccountReadinessCode[];
  readinessState: ConnectionReadinessState;
  checkedAt: string;
  warnings: string[];
}

export interface EvaluateReadinessInput {
  serverTimeReachable: boolean;
  signedRequestWorks: boolean;
  futuresAccountReachable: boolean;
  positionMode: string | null;
  assetMode: string | null;
  nonZeroPositionCount: number | null;
  openOrderCount: number | null;
  authenticationFailed: boolean;
  clockSyncFailed: boolean;
}

/**
 * Derives the stable readiness codes from one health observation.
 *
 * `accountSetupSafe` means only that a hedge-mode change WOULD be permitted
 * right now — never that one should happen. An account carrying any position or
 * any open order is blocked, and the operator decides what to do with existing
 * exposure; nothing here suggests or performs cleanup.
 */
export function evaluateReadiness(input: EvaluateReadinessInput): {
  codes: AccountReadinessCode[];
  accountSetupSafe: boolean;
} {
  const codes: AccountReadinessCode[] = [];

  if (input.authenticationFailed) codes.push("AUTHENTICATION_FAILED");
  if (input.clockSyncFailed) codes.push("CLOCK_SYNC_FAILED");
  if (!input.futuresAccountReachable) codes.push("FUTURES_ACCOUNT_UNAVAILABLE");

  const connected =
    input.serverTimeReachable &&
    input.signedRequestWorks &&
    input.futuresAccountReachable &&
    !input.authenticationFailed &&
    !input.clockSyncFailed;
  if (connected) codes.push("CONNECTED");

  if (input.positionMode !== null && input.positionMode !== EXPECTED_POSITION_MODE) {
    codes.push("POSITION_MODE_MISMATCH");
  }
  if (input.assetMode !== null && input.assetMode !== EXPECTED_ASSET_MODE) {
    codes.push("ASSET_MODE_MISMATCH");
  }

  const hasPositions = (input.nonZeroPositionCount ?? 0) > 0;
  const hasOrders = (input.openOrderCount ?? 0) > 0;
  if (hasPositions) codes.push("OPEN_POSITIONS_PRESENT");
  if (hasOrders) codes.push("OPEN_ORDERS_PRESENT");

  // Setup is safe only when everything is KNOWN and empty. A null count is
  // unknown, and unknown never counts as zero.
  const countsKnown = input.nonZeroPositionCount !== null && input.openOrderCount !== null;
  const accountSetupSafe = connected && countsKnown && !hasPositions && !hasOrders;
  codes.push(accountSetupSafe ? "ACCOUNT_SETUP_SAFE" : "ACCOUNT_SETUP_BLOCKED");

  return { codes, accountSetupSafe };
}

export interface ReadinessStateInput {
  codes: AccountReadinessCode[];
  positionMode: string | null;
  assetMode: string | null;
  testOrderEnabled: boolean;
  testOrderValidated: boolean;
}

/**
 * The single summary state. Note that it never reaches beyond
 * TEST_ORDER_VALIDATED: a validated test order is evidence that signing and
 * permissions work, not authority to trade.
 */
export function evaluateConnectionReadiness(input: ReadinessStateInput): ConnectionReadinessState {
  if (!input.codes.includes("CONNECTED")) return "NOT_CONNECTED";
  if (input.positionMode !== EXPECTED_POSITION_MODE || input.assetMode !== EXPECTED_ASSET_MODE) {
    return "ACCOUNT_MODE_BLOCKED";
  }
  if (input.testOrderValidated) return "TEST_ORDER_VALIDATED";
  if (input.testOrderEnabled) return "TEST_ORDER_READY";
  // Reads work, but nothing has yet proven the key carries Futures TRADE
  // permission — only /order/test can show that.
  return "TRADING_PERMISSION_UNVERIFIED";
}

// ---------------------------------------------------------------------------
// Local filter validation
// ---------------------------------------------------------------------------

export const TEST_ORDER_VALIDATION_CODES = [
  "SYMBOL_NOT_TRADING",
  "SYMBOL_NOT_PERPETUAL",
  "PRICE_NOT_DECIMAL",
  "QUANTITY_NOT_DECIMAL",
  "PRICE_OUT_OF_RANGE",
  "QUANTITY_OUT_OF_RANGE",
  "PRICE_TICK_SIZE_MISMATCH",
  "QUANTITY_STEP_SIZE_MISMATCH",
  "MIN_NOTIONAL_NOT_MET",
] as const;

export type TestOrderValidationCode = (typeof TEST_ORDER_VALIDATION_CODES)[number];

export interface TestOrderValidationInput {
  filters: BinanceSymbolFiltersDto;
  price: string;
  quantity: string;
}

export interface TestOrderValidationResult {
  valid: boolean;
  violations: TestOrderValidationCode[];
  /** Human-readable, bounded, no account data. */
  messages: string[];
}

function toDecimal(value: string | null | undefined): InstanceType<typeof Prisma.Decimal> | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  try {
    const parsed = new D(String(value).trim());
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

/** Exact multiple test — `value / step` must have no fractional remainder. */
function isMultipleOf(value: InstanceType<typeof Prisma.Decimal>, step: string | null): boolean {
  const stepDecimal = toDecimal(step);
  if (stepDecimal === null || stepDecimal.lessThanOrEqualTo(0)) return true;
  return value.dividedBy(stepDecimal).modulo(1).isZero();
}

/**
 * Validates a proposed test order against the symbol's own filters LOCALLY,
 * before anything is sent.
 *
 * Nothing is rounded or corrected: a price that is not on the tick grid is
 * REJECTED, not silently snapped. Quietly adjusting an operator's input would
 * mean validating a request they did not actually make.
 */
export function validateTestOrderAgainstFilters(input: TestOrderValidationInput): TestOrderValidationResult {
  const violations: TestOrderValidationCode[] = [];
  const messages: string[] = [];
  const { filters } = input;

  const add = (code: TestOrderValidationCode, message: string): void => {
    violations.push(code);
    messages.push(message);
  };

  if ((filters.status ?? "").toUpperCase() !== "TRADING") {
    add("SYMBOL_NOT_TRADING", `Symbol status is ${filters.status ?? "unknown"}, not TRADING.`);
  }
  // contractType is absent on some responses; only a KNOWN non-perpetual fails.
  if (filters.contractType !== null && filters.contractType.toUpperCase() !== "PERPETUAL") {
    add("SYMBOL_NOT_PERPETUAL", `Contract type is ${filters.contractType}, not PERPETUAL.`);
  }

  const price = toDecimal(input.price);
  const quantity = toDecimal(input.quantity);

  if (price === null || price.lessThanOrEqualTo(0)) {
    add("PRICE_NOT_DECIMAL", "Price must be a positive decimal string.");
  }
  if (quantity === null || quantity.lessThanOrEqualTo(0)) {
    add("QUANTITY_NOT_DECIMAL", "Quantity must be a positive decimal string.");
  }
  if (price === null || quantity === null || price.lessThanOrEqualTo(0) || quantity.lessThanOrEqualTo(0)) {
    return { valid: false, violations, messages };
  }

  const minPrice = toDecimal(filters.minPrice);
  const maxPrice = toDecimal(filters.maxPrice);
  if ((minPrice && price.lessThan(minPrice)) || (maxPrice && maxPrice.greaterThan(0) && price.greaterThan(maxPrice))) {
    add("PRICE_OUT_OF_RANGE", `Price is outside the symbol's [${filters.minPrice}, ${filters.maxPrice}] range.`);
  }

  const minQty = toDecimal(filters.minQty);
  const maxQty = toDecimal(filters.maxQty);
  if ((minQty && quantity.lessThan(minQty)) || (maxQty && maxQty.greaterThan(0) && quantity.greaterThan(maxQty))) {
    add("QUANTITY_OUT_OF_RANGE", `Quantity is outside the symbol's [${filters.minQty}, ${filters.maxQty}] range.`);
  }

  if (!isMultipleOf(price, filters.tickSize)) {
    add("PRICE_TICK_SIZE_MISMATCH", `Price is not an exact multiple of the tick size ${filters.tickSize}.`);
  }
  if (!isMultipleOf(quantity, filters.stepSize)) {
    add("QUANTITY_STEP_SIZE_MISMATCH", `Quantity is not an exact multiple of the step size ${filters.stepSize}.`);
  }

  const minNotional = toDecimal(filters.minNotional);
  if (minNotional && minNotional.greaterThan(0) && price.times(quantity).lessThan(minNotional)) {
    add(
      "MIN_NOTIONAL_NOT_MET",
      `Notional ${price.times(quantity).toFixed()} is below the symbol minimum ${filters.minNotional}.`
    );
  }

  return { valid: violations.length === 0, violations, messages };
}

// ---------------------------------------------------------------------------
// Test-order outcome
// ---------------------------------------------------------------------------

export const TEST_ORDER_OUTCOMES = [
  "TEST_ORDER_VALIDATED",
  "TEST_ORDER_FAILED",
  "TEST_ORDER_RESULT_UNKNOWN",
  "CRITICAL_TEST_INVARIANT_VIOLATION",
] as const;

export type TestOrderOutcome = (typeof TEST_ORDER_OUTCOMES)[number];

export interface TestOrderInvariantInput {
  openOrderCountBefore: number | null;
  openOrderCountAfter: number | null;
  accepted: boolean;
  resultUnknown: boolean;
}

/**
 * Combines the endpoint's answer with the real-open-order invariant.
 *
 * A successful response is NOT taken as proof on its own that no order was
 * created: the count is read before and after and compared. If it moved, the
 * result is CRITICAL regardless of what the endpoint said — and the caller
 * stops rather than cancelling anything.
 */
export function evaluateTestOrderOutcome(input: TestOrderInvariantInput): {
  outcome: TestOrderOutcome;
  realOpenOrdersChanged: boolean;
} {
  const known = input.openOrderCountBefore !== null && input.openOrderCountAfter !== null;
  const changed = known && input.openOrderCountBefore !== input.openOrderCountAfter;

  if (changed) return { outcome: "CRITICAL_TEST_INVARIANT_VIOLATION", realOpenOrdersChanged: true };
  if (input.resultUnknown) return { outcome: "TEST_ORDER_RESULT_UNKNOWN", realOpenOrdersChanged: false };
  return { outcome: input.accepted ? "TEST_ORDER_VALIDATED" : "TEST_ORDER_FAILED", realOpenOrdersChanged: false };
}

// ---------------------------------------------------------------------------
// Hedge-mode outcome
// ---------------------------------------------------------------------------

export const HEDGE_MODE_OUTCOMES = [
  "ALREADY_HEDGE",
  "HEDGE_MODE_SET",
  "ACCOUNT_SETUP_BLOCKED",
  "ACCOUNT_STATE_CHANGED",
  "MUTATIONS_DISABLED",
  "POSITION_MODE_UNKNOWN",
  "HEDGE_MODE_NOT_VERIFIED",
] as const;

export type HedgeModeOutcome = (typeof HEDGE_MODE_OUTCOMES)[number];
