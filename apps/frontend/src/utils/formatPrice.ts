import { formatDynamicPrice } from "@trading-alert-dashboard/shared";

/**
 * Magnitude-aware price formatting (shared with the backend chart renderer)
 * so small-cap/perpetual prices like 0.004086 never display as "0.00".
 */
export function formatPrice(value: number): string {
  return formatDynamicPrice(value);
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}
