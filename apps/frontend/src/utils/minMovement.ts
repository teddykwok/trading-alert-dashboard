/**
 * Helpers for the teddy Pine indicator's "Minimum Price Movement (%)" setting,
 * carried in `alert.indicatorValue` as PERCENTAGE POINTS (15 = 15%, 12.5 =
 * 12.5%) — it is the higher-timeframe level-formation threshold, not touch
 * tolerance, risk, or AI confidence. Historical teddy alerts hardcoded 0, so
 * 0 always means "not recorded", never a real 0% configuration.
 */

/** Matches current and future teddy versions ("teddy v5.5", "teddy v5.6", …). */
export function isTeddyIndicator(indicatorName: string | null | undefined): boolean {
  return indicatorName?.toLowerCase().startsWith("teddy") ?? false;
}

/**
 * "15%" / "12.5%" — trailing zeros and float tails trimmed. Null for the
 * historical/unrecorded cases (null, 0, negative, non-finite), so callers can
 * hide the value instead of showing a misleading "0%".
 */
export function formatMinMovementPercent(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return `${Math.round(value * 10000) / 10000}%`;
}
