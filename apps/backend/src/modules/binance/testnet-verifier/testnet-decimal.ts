/**
 * Exact decimal arithmetic on scaled BigInt integers.
 *
 * Every value is `{ units, scale }` meaning `units / 10^scale`, so all
 * arithmetic is integer arithmetic and there is no rounding error to reason
 * about — stricter than a float path and stricter than a fixed-precision
 * decimal library, since nothing is ever rounded except where this module is
 * explicitly asked to snap onto a grid.
 *
 * This lives in the verifier rather than reaching for `Prisma.Decimal` (the
 * repository's usual decimal type) so the verifier tree stays free of any
 * Prisma import and therefore of any database coupling.
 *
 * Only NON-NEGATIVE values are representable. Prices and quantities are the
 * only things measured here, and a negative one is a bug, not a value.
 */

export interface ExactDecimal {
  readonly units: bigint;
  readonly scale: number;
}

/** Plain decimal literal only. Rejects "", "-1", "1e-8", "1.", ".5" and "abc". */
const DECIMAL_LITERAL = /^\d+(\.\d+)?$/;

export function parseDecimal(text: string | null | undefined): ExactDecimal | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!DECIMAL_LITERAL.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

/** Parses and additionally requires the value to be strictly greater than zero. */
export function parsePositiveDecimal(text: string | null | undefined): ExactDecimal | null {
  const parsed = parseDecimal(text);
  return parsed && parsed.units > 0n ? parsed : null;
}

export function fromInteger(value: number, scale = 0): ExactDecimal {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Not a non-negative safe integer: ${value}`);
  return { units: BigInt(value), scale };
}

function rescale(value: ExactDecimal, scale: number): bigint {
  if (scale < value.scale) throw new Error("Refusing to rescale downward: that would discard digits.");
  return value.units * 10n ** BigInt(scale - value.scale);
}

export function compareDecimal(a: ExactDecimal, b: ExactDecimal): -1 | 0 | 1 {
  const scale = Math.max(a.scale, b.scale);
  const left = rescale(a, scale);
  const right = rescale(b, scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function maxDecimal(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  return compareDecimal(a, b) >= 0 ? a : b;
}

/** Exact: scales add, nothing is rounded. */
export function multiplyDecimal(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

/**
 * Snaps `value` onto the `grid` lattice.
 *
 * The quotient is evaluated as an exact integer ratio, so "UP" is a true
 * ceiling and "DOWN" a true floor — a value already exactly on the grid is
 * returned unchanged in both directions.
 */
export function snapToGrid(value: ExactDecimal, grid: ExactDecimal, direction: "UP" | "DOWN"): ExactDecimal {
  if (grid.units <= 0n) throw new Error("Grid must be positive.");
  // value/grid = (value.units * 10^grid.scale) / (grid.units * 10^value.scale)
  const numerator = value.units * 10n ** BigInt(grid.scale);
  const denominator = grid.units * 10n ** BigInt(value.scale);
  let steps = numerator / denominator; // both non-negative, so this is a floor
  if (direction === "UP" && numerator % denominator !== 0n) steps += 1n;
  return { units: steps * grid.units, scale: grid.scale };
}

/**
 * `a / b`, truncated to `scale` fractional digits.
 *
 * Truncation is safe for the one use here — deriving a minimum quantity from
 * a minimum notional — because the result is immediately snapped UP onto the
 * step grid and then re-checked against the notional floor.
 */
export function divideDecimal(a: ExactDecimal, b: ExactDecimal, scale: number): ExactDecimal {
  if (b.units <= 0n) throw new Error("Refusing to divide by zero.");
  const shift = scale + b.scale - a.scale;
  const numerator = shift >= 0 ? a.units * 10n ** BigInt(shift) : a.units / 10n ** BigInt(-shift);
  return { units: numerator / b.units, scale };
}

/** Renders with exactly `decimals` fractional digits, truncating extras. */
export function formatDecimal(value: ExactDecimal, decimals: number): string {
  const scaled =
    decimals >= value.scale
      ? value.units * 10n ** BigInt(decimals - value.scale)
      : value.units / 10n ** BigInt(value.scale - decimals);
  const text = scaled.toString().padStart(decimals + 1, "0");
  if (decimals === 0) return text;
  return `${text.slice(0, text.length - decimals)}.${text.slice(text.length - decimals)}`;
}

/**
 * The number of fractional digits a grid string implies, e.g. "0.00100000"
 * declares 8 places but only needs 3. Trailing zeros are trimmed so the
 * rendered value is the shortest exact form on that grid.
 */
export function gridDecimals(grid: string): number {
  if (!grid.includes(".")) return 0;
  return grid.split(".")[1].replace(/0+$/, "").length;
}
