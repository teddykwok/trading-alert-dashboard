/**
 * Readable, compact rendering of an EXACT decimal string. Display only.
 *
 * The planner stores and serves exact, unrounded decimal strings (e.g. a stop
 * of 0.0008901333333333333333333333333333333333333). Those stay the truth: this
 * never changes a stored number, a calculation or an API value. It only decides
 * what a narrow card shows, and the caller keeps the exact string for a
 * tooltip.
 *
 *  - up to COMPACT_SIGNIFICANT_DIGITS significant digits: shown exactly as given;
 *  - more: the integer part is always kept whole (a price is never rounded to a
 *    different magnitude), and only the fraction is shortened so the total is
 *    about COMPACT_SIGNIFICANT_DIGITS significant digits;
 *  - anything that is not a plain decimal string is shown unchanged.
 */

export const COMPACT_SIGNIFICANT_DIGITS = 8;

export interface CompactDecimal {
  readonly text: string;
  /** The exact value, for a tooltip / title. */
  readonly exact: string;
  readonly shortened: boolean;
}

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

function significantDigits(unsigned: string): number {
  const digits = unsigned.replace(".", "").replace(/^0+/, "");
  return digits.length;
}

export function compactDecimal(exact: string): CompactDecimal {
  const value = exact.trim();
  if (!PLAIN_DECIMAL.test(value)) return { text: exact, exact, shortened: false };
  const unsigned = value.startsWith("-") ? value.slice(1) : value;
  if (significantDigits(unsigned) <= COMPACT_SIGNIFICANT_DIGITS) return { text: value, exact, shortened: false };

  const [integerPart, fraction = ""] = unsigned.split(".");
  const negative = value.startsWith("-");
  let text: string;
  if (integerPart.replace(/^0+/, "").length > 0) {
    // |x| >= 1: keep every integer digit; shorten the fraction only.
    const keep = Math.max(0, COMPACT_SIGNIFICANT_DIGITS - integerPart.replace(/^0+/, "").length);
    text = new Intl.NumberFormat("en-US", { useGrouping: false, maximumFractionDigits: Math.max(keep, 0), minimumFractionDigits: 0 }).format(Number(unsigned));
    if (fraction.length > 0 && keep === 0) text = integerPart; // integer part already uses every significant digit
  } else {
    // |x| < 1: significant digits counted from the first non-zero; never scientific notation.
    text = new Intl.NumberFormat("en-US", { useGrouping: false, maximumSignificantDigits: COMPACT_SIGNIFICANT_DIGITS }).format(Number(unsigned));
  }
  const signed = negative && text !== "0" ? `-${text}` : text;
  return { text: signed, exact, shortened: signed !== value };
}
