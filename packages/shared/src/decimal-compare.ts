import Decimal from "decimal.js";

/**
 * Shared exact-decimal helpers for presentation layers.
 *
 * The repository rule is that authoritative trading values never pass through
 * JavaScript floating point. The dashboard needs to show differences (entry
 * slippage, planned-versus-filled quantity), so the subtraction happens here
 * with arbitrary precision rather than with `Number()` in the browser.
 */

const D = Decimal.clone({ precision: 40, toExpNeg: -30, toExpPos: 40 });

/**
 * Exact `right - left` as a decimal string, or null when either side is
 * unknown or unparseable.
 *
 * Null in means null out: a difference against a missing value would be pure
 * fiction (a "slippage" measured against a fill that never happened).
 */
export function subtractDecimalStrings(left: string | null, right: string | null): string | null {
  if (left === null || right === null) return null;
  try {
    const a = new D(String(left).trim());
    const b = new D(String(right).trim());
    if (!a.isFinite() || !b.isFinite()) return null;
    return b.minus(a).toString();
  } catch {
    return null;
  }
}

/** True when the decimal string is negative. Null and malformed are false. */
export function isNegativeDecimalString(value: string | null): boolean {
  if (value === null) return false;
  try {
    const parsed = new D(String(value).trim());
    return parsed.isFinite() && parsed.isNegative();
  } catch {
    return false;
  }
}
