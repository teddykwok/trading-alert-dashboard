/**
 * Dynamic price formatting shared by the backend chart renderer (screenshot
 * y-axis / alert marker / overlay label) and the frontend dashboard cards.
 * Small-cap crypto and perpetual prices (e.g. TACUSDT.P at 0.004086) must
 * never collapse to "0.00" — decimals scale with price magnitude instead of
 * being fixed at 2.
 */

/** Decimal places appropriate for a price of the given magnitude. */
export function priceDecimalsFor(value: number): number {
  const abs = Math.abs(value);
  if (abs === 0) return 0;
  if (abs >= 1000) return 2; // 62,408.00
  if (abs >= 1) return 4; // 1.2345
  if (abs >= 0.01) return 5; // 0.03748
  if (abs >= 0.001) return 6; // 0.004086
  if (abs >= 0.000001) return 8; // 0.00001234
  return 10; // dust-sized prices
}

export interface ChartPriceFormat {
  precision: number;
  minMove: number;
}

/**
 * Lightweight Charts `priceFormat` options (type: "price") for a series whose
 * prices are around `value`, e.g. 0.004086 -> { precision: 6, minMove: 0.000001 }.
 */
export function pricePrecisionFor(value: number): ChartPriceFormat {
  // Zero carries no magnitude information; keep the library's default-ish 2.
  const precision = Math.abs(value) === 0 ? 2 : priceDecimalsFor(value);
  return { precision, minMove: Number(`1e-${precision}`) };
}

/**
 * Formats a price with magnitude-appropriate decimals ("en-US" locale for
 * deterministic output). Trailing zeros are trimmed except for >= 1000 where
 * two decimals are kept (62,408.00). Zero stays "0"; negative values keep
 * their sign.
 */
export function formatDynamicPrice(value: number): string {
  if (value === 0 || !Number.isFinite(value)) return "0";

  return value.toLocaleString("en-US", {
    minimumFractionDigits: Math.abs(value) >= 1000 ? 2 : 0,
    maximumFractionDigits: priceDecimalsFor(value),
  });
}
