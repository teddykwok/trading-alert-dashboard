/**
 * Deciding what ONE observed userTrades page means, and nothing else.
 *
 * ## The failure this exists to prevent
 *
 * A time-windowed read can return a full page without saying so. The obvious
 * continuation — take the last returned trade's timestamp and resume at
 * `+ 1 ms` — loses fills silently whenever more than one trade shares that
 * millisecond, because the page may have been truncated partway through it and
 * Binance documents no ordering that would let a caller tell. The loss leaves
 * no trace: the next window starts after data nobody read.
 *
 * So this module never looks at the rows. It looks at HOW MANY there were. A
 * page that came back short of the limit could not have been truncated; a page
 * that reached the limit might have been, and is therefore not evidence of
 * anything except that a smaller question is needed.
 *
 * ## What it is not
 *
 * No I/O, no client, no database, no cursor, no scheduler. One page in, one
 * decision out. It does not split recursively, does not enumerate descendants
 * and does not schedule anything: a caller that must stay bounded per cycle
 * needs to persist its own continuation, and it cannot do that if the planner
 * has already expanded the whole tree in memory.
 *
 * ## Scope of the coverage proof
 *
 * The partition proof below is about THIS MODULE'S OWN inclusive integer
 * millisecond intervals: every millisecond of a parent appears in exactly one
 * child. It is not a claim about Binance's `startTime`/`endTime` inclusivity,
 * which the official documentation does not state. Whatever executes these
 * windows against the API must map them conservatively and keep whatever
 * overlap that boundary requires; re-reading a fill is free, because the ledger
 * is keyed on the exchange's own trade id.
 */

/** Binance's documented maximum span between `startTime` and `endTime`. */
export const USER_TRADES_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Binance's documented maximum page size for GET /fapi/v1/userTrades.
 *
 * The read-only wrapper holds its own private copy for argument validation.
 * Left unshared for now because this module is deliberately pure and the
 * wrapper is not; whichever slice first needs them to move together should
 * hoist one constant rather than let two drift.
 */
export const USER_TRADES_MAX_LIMIT = 1000;

/**
 * An INCLUSIVE integer-millisecond interval: `[startTimeMs, endTimeMs]`.
 *
 * Inclusive on both ends so that a single millisecond is representable as
 * `start === end` rather than as an empty or half-open oddity — which matters,
 * because that is exactly the case the whole design has to terminate on.
 */
export interface UserTradesWindow {
  readonly startTimeMs: number;
  readonly endTimeMs: number;
}

export const USER_TRADES_WINDOW_REFUSALS = [
  "WINDOW_BOUND_NOT_INTEGER",
  "WINDOW_BOUND_NEGATIVE",
  "WINDOW_INVERTED",
  "WINDOW_TOO_LONG",
  "LIMIT_OUT_OF_RANGE",
  "ROW_COUNT_INVALID",
  "ROW_COUNT_EXCEEDS_LIMIT",
] as const;

export type UserTradesWindowRefusal = (typeof USER_TRADES_WINDOW_REFUSALS)[number];

export type UserTradesWindowDecision =
  /**
   * The page came back short of its limit, so it was not truncated: this
   * window has been seen in full.
   */
  | { readonly kind: "COMPLETE"; readonly window: UserTradesWindow }
  /**
   * The page reached its limit and the window spans more than a millisecond,
   * so ask two smaller questions. Exactly two children, never a whole tree.
   */
  | {
      readonly kind: "SPLIT";
      readonly window: UserTradesWindow;
      readonly left: UserTradesWindow;
      readonly right: UserTradesWindow;
    }
  /**
   * The page reached its limit inside ONE millisecond. There is no smaller
   * window to ask for, so exhaustion cannot be proven by this method at all.
   *
   * Deliberately not COMPLETE. Reporting it as complete would be the same
   * silent loss as advancing past the timestamp, dressed as a success; a
   * caller must persist this and surface it rather than move on.
   */
  | { readonly kind: "SATURATED_SINGLE_MILLISECOND"; readonly window: UserTradesWindow }
  /** The observation itself was impossible or out of contract. */
  | { readonly kind: "REFUSED"; readonly reasonCode: UserTradesWindowRefusal; readonly message: string };

/** One observed page: the window that was asked for, and what came back. */
export interface UserTradesPageObservation {
  readonly window: UserTradesWindow;
  /** The limit that was REQUESTED, which is what saturation is measured against. */
  readonly limit: number;
  /**
   * How many rows the EXCHANGE returned for that request.
   *
   * Authoritative row count, not a downstream tally. Rows that were skipped as
   * unusable, deduplicated by the ledger or dropped in attribution still
   * occupied space in the page, so counting anything narrower would let a
   * truncated page look short and silently end the window.
   */
  readonly returnedRowCount: number;
}

const refuse = (
  reasonCode: UserTradesWindowRefusal,
  message: string
): UserTradesWindowDecision => ({ kind: "REFUSED", reasonCode, message });

/**
 * Splits an inclusive interval into two non-empty inclusive halves.
 *
 * MODULE-PRIVATE, and that is the point. Splitting is a CONSEQUENCE of a
 * validated, saturated observation, not an operation a caller should be able
 * to perform on any pair of numbers. Exported, it was a way around the very
 * contract this module exists to enforce: it checks only `start >= end`, so a
 * `NaN` bound sails through (`NaN >= NaN` is false) and yields children with
 * `NaN` bounds, and a window longer than seven days splits happily even though
 * the planner refuses it outright. Both would look like ordinary work.
 *
 * The only way to obtain child windows is therefore
 * `planUserTradesWindow(...)` returning `SPLIT`, which happens only after the
 * bounds, the limit and the row count have all been checked and the page has
 * actually saturated.
 *
 * The midpoint is `start + floor((end - start) / 2)`, never
 * `floor((start + end) / 2)`: the second adds two timestamps together, and two
 * values that are individually safe integers can sum past `MAX_SAFE_INTEGER`
 * and land on a silently wrong midpoint. Subtracting first keeps every
 * intermediate no larger than the span itself.
 *
 * Returns null for a single-millisecond window, which has no halves.
 */
function splitUserTradesWindow(
  window: UserTradesWindow
): { readonly left: UserTradesWindow; readonly right: UserTradesWindow } | null {
  if (window.startTimeMs >= window.endTimeMs) return null;

  const mid = window.startTimeMs + Math.floor((window.endTimeMs - window.startTimeMs) / 2);
  return {
    left: { startTimeMs: window.startTimeMs, endTimeMs: mid },
    // `mid + 1`, so the two halves ABUT rather than overlap or skip: the
    // parent's every millisecond lands in exactly one child.
    right: { startTimeMs: mid + 1, endTimeMs: window.endTimeMs },
  };
}

/**
 * What to do after observing one page.
 *
 * Cardinality only. Trade ids, timestamps, ordering and `fromId` are never
 * consulted — none of them is documented in a way that could carry this
 * argument, and depending on any of them would make the proof rest on
 * behaviour nobody has specified.
 */
export function planUserTradesWindow(
  observation: UserTradesPageObservation
): UserTradesWindowDecision {
  const { window, limit, returnedRowCount } = observation;
  const { startTimeMs, endTimeMs } = window;

  for (const [label, value] of [
    ["startTimeMs", startTimeMs],
    ["endTimeMs", endTimeMs],
  ] as const) {
    if (!Number.isSafeInteger(value)) {
      return refuse("WINDOW_BOUND_NOT_INTEGER", `${label} must be a safe integer of milliseconds`);
    }
    if (value < 0) {
      return refuse("WINDOW_BOUND_NEGATIVE", `${label} must not be negative`);
    }
  }
  if (startTimeMs > endTimeMs) {
    return refuse("WINDOW_INVERTED", "startTimeMs must not be after endTimeMs");
  }
  // Refused rather than pre-split: carving months of history into askable
  // spans is a scheduling decision with its own durable state, and doing it
  // silently here would hide how much work a caller had actually created.
  if (endTimeMs - startTimeMs > USER_TRADES_MAX_WINDOW_MS) {
    return refuse("WINDOW_TOO_LONG", "a userTrades window may span at most 7 days");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > USER_TRADES_MAX_LIMIT) {
    return refuse("LIMIT_OUT_OF_RANGE", `limit must be an integer between 1 and ${USER_TRADES_MAX_LIMIT}`);
  }
  if (!Number.isSafeInteger(returnedRowCount) || returnedRowCount < 0) {
    return refuse("ROW_COUNT_INVALID", "returnedRowCount must be a non-negative integer");
  }
  // Impossible under the endpoint contract, so it is a caller bug rather than
  // a saturated page. Refused instead of treated as saturation, which would
  // silently convert a broken observation into ordinary-looking work.
  if (returnedRowCount > limit) {
    return refuse("ROW_COUNT_EXCEEDS_LIMIT", "returnedRowCount cannot exceed the requested limit");
  }

  // Short of the limit: the page could not have been truncated.
  if (returnedRowCount < limit) return { kind: "COMPLETE", window };

  const halves = splitUserTradesWindow(window);
  // Saturated, and no smaller window exists to ask for.
  if (halves === null) return { kind: "SATURATED_SINGLE_MILLISECOND", window };

  // Exactly two children. Splitting them further is the caller's next cycle,
  // not this call's business.
  return { kind: "SPLIT", window, left: halves.left, right: halves.right };
}
