import {
  compareDecimal,
  divideDecimal,
  formatDecimal,
  fromInteger,
  gridDecimals,
  maxDecimal,
  multiplyDecimal,
  parsePositiveDecimal,
  snapToGrid,
  type ExactDecimal,
} from "./testnet-decimal";

/**
 * Pure sizing and trigger math.
 *
 * Exact scaled-integer arithmetic throughout (see testnet-decimal.ts) — no
 * `Number()`, `parseFloat` or float operation ever touches a price or a
 * quantity, matching the decimal policy of the production path.
 *
 * Nothing is hard-coded: every quantity is derived from the symbol's CURRENT
 * exchangeInfo filters, and the trigger distance must be stated explicitly by
 * the operator.
 */

export interface VerifierSymbolFilters {
  readonly tickSize: string | null;
  readonly stepSize: string | null;
  readonly minQty: string | null;
  readonly minNotional: string | null;
}

export type SizingFailureCode =
  | "FILTERS_INCOMPLETE"
  | "MARK_PRICE_INVALID"
  | "TRIGGER_OFFSET_INVALID"
  | "TRIGGER_ORDERING_INVALID"
  | "QUANTITY_NOT_REPRESENTABLE";

export type SizingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reasonCode: SizingFailureCode; readonly message: string };

function fail<T>(reasonCode: SizingFailureCode, message: string): SizingResult<T> {
  return { ok: false, reasonCode, message };
}

/** Working precision for the one division performed. Far beyond any filter. */
const DIVISION_SCALE = 18;

/** Basis points must be a whole number so the factor stays exact. */
function basisPointFactor(bps: number, direction: "ADD" | "SUBTRACT"): ExactDecimal | null {
  if (!Number.isSafeInteger(bps) || bps <= 0 || bps >= 10_000) return null;
  // (10000 ± bps) / 10000, expressed exactly at scale 4.
  return fromInteger(direction === "ADD" ? 10_000 + bps : 10_000 - bps, 4);
}

export interface QuantityPlan {
  /** Exact decimal string to send as `quantity`. */
  readonly quantity: string;
  readonly notional: string;
}

/**
 * The smallest quantity satisfying BOTH `minQty` and `minNotional` on the
 * current step grid.
 *
 * Always snaps UP. Snapping down through the step grid can push a quantity
 * back below `minNotional`, producing a rejection that reads like a contract
 * error when it is really a rounding error.
 */
export function planMinimumQuantity(input: {
  filters: VerifierSymbolFilters;
  markPrice: string;
}): SizingResult<QuantityPlan> {
  const stepSize = parsePositiveDecimal(input.filters.stepSize);
  const minQty = parsePositiveDecimal(input.filters.minQty);
  const minNotional = parsePositiveDecimal(input.filters.minNotional);
  if (!stepSize || !minQty || !minNotional) {
    return fail("FILTERS_INCOMPLETE", "stepSize, minQty and minNotional are all required to size a test position.");
  }

  const markPrice = parsePositiveDecimal(input.markPrice);
  if (!markPrice) return fail("MARK_PRICE_INVALID", "Mark price must be a positive decimal string.");

  const notionalQty = divideDecimal(minNotional, markPrice, DIVISION_SCALE);
  const quantity = snapToGrid(maxDecimal(minQty, notionalQty), stepSize, "UP");

  // Re-check rather than trust the snap: this is the invariant that actually
  // matters and asserting it costs nothing.
  const notional = multiplyDecimal(quantity, markPrice);
  if (compareDecimal(quantity, minQty) < 0 || compareDecimal(notional, minNotional) < 0) {
    return fail(
      "QUANTITY_NOT_REPRESENTABLE",
      "No quantity on the step grid satisfies both minQty and minNotional at the current mark price."
    );
  }

  return {
    ok: true,
    value: {
      quantity: formatDecimal(quantity, gridDecimals(input.filters.stepSize as string)),
      notional: formatDecimal(notional, 8),
    },
  };
}

export interface TriggerPlan {
  readonly stopTriggerPrice: string;
  readonly takeProfitTriggerPrice: string;
  readonly markPrice: string;
}

/**
 * STOP and TAKE_PROFIT triggers for a LONG, normalized AWAY from the mark.
 *
 * The stop floors onto the tick grid and the take profit ceils, so tick
 * snapping can only ever move a trigger FURTHER from the mark. Rounding the
 * other way would quietly shrink the distance the operator asked for, and at a
 * small offset could place a trigger on the wrong side of the mark entirely.
 */
export function planLongTriggers(input: {
  markPrice: string;
  tickSize: string | null;
  triggerOffsetBps: number;
}): SizingResult<TriggerPlan> {
  const tickSize = parsePositiveDecimal(input.tickSize);
  if (!tickSize) return fail("FILTERS_INCOMPLETE", "tickSize is required to normalize trigger prices.");

  const markPrice = parsePositiveDecimal(input.markPrice);
  if (!markPrice) return fail("MARK_PRICE_INVALID", "Mark price must be a positive decimal string.");

  // No default: an arbitrary trigger distance is exactly the kind of implicit
  // choice this verifier must not make on the operator's behalf.
  const below = basisPointFactor(input.triggerOffsetBps, "SUBTRACT");
  const above = basisPointFactor(input.triggerOffsetBps, "ADD");
  if (!below || !above) {
    return fail(
      "TRIGGER_OFFSET_INVALID",
      "--trigger-offset-bps must be an explicit whole number greater than 0 and less than 10000."
    );
  }

  const stop = snapToGrid(multiplyDecimal(markPrice, below), tickSize, "DOWN");
  const takeProfit = snapToGrid(multiplyDecimal(markPrice, above), tickSize, "UP");

  if (
    stop.units <= 0n ||
    compareDecimal(stop, markPrice) >= 0 ||
    compareDecimal(takeProfit, markPrice) <= 0
  ) {
    return fail(
      "TRIGGER_ORDERING_INVALID",
      "Could not construct STOP < mark < TP on the current tick grid; widen --trigger-offset-bps."
    );
  }

  const decimals = gridDecimals(input.tickSize as string);
  return {
    ok: true,
    value: {
      stopTriggerPrice: formatDecimal(stop, decimals),
      takeProfitTriggerPrice: formatDecimal(takeProfit, decimals),
      markPrice: input.markPrice,
    },
  };
}

/**
 * A marketable LIMIT BUY price: above the mark by `crossBps`, ceiled onto the
 * tick grid so it crosses rather than rests.
 *
 * A LIMIT is used deliberately — it exercises the real production
 * `submitLimitEntry()` builder (LIMIT/GTC/ACK). A MARKET entry would test a
 * path the production entry lifecycle never takes.
 */
export function planMarketableLimitPrice(input: {
  markPrice: string;
  tickSize: string | null;
  crossBps: number;
}): SizingResult<{ price: string }> {
  const tickSize = parsePositiveDecimal(input.tickSize);
  if (!tickSize) return fail("FILTERS_INCOMPLETE", "tickSize is required to price the entry.");

  const markPrice = parsePositiveDecimal(input.markPrice);
  if (!markPrice) return fail("MARK_PRICE_INVALID", "Mark price must be a positive decimal string.");

  const factor = basisPointFactor(input.crossBps, "ADD");
  if (!factor) {
    return fail("TRIGGER_OFFSET_INVALID", "--entry-cross-bps must be a whole number greater than 0 and less than 10000.");
  }

  const price = snapToGrid(multiplyDecimal(markPrice, factor), tickSize, "UP");
  if (compareDecimal(price, markPrice) <= 0) {
    return fail("TRIGGER_ORDERING_INVALID", "The entry price did not cross the mark; widen --entry-cross-bps.");
  }

  return { ok: true, value: { price: formatDecimal(price, gridDecimals(input.tickSize as string)) } };
}
