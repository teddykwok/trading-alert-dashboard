import type { TradeExecutionStatusName } from "./execution-status";

/**
 * Central capacity classification for execution statuses (pure, no I/O).
 *
 * Every admission decision counts slots through these sets, so the meaning of
 * "pending", "open" and "active" is defined exactly once and tested directly.
 *
 * PARTIALLY_FILLED deliberately appears in BOTH pending and open: the unfilled
 * remainder is still a live working order while the filled part is real
 * exposure, so it consumes one slot of each.
 *
 * MANUAL_INTERVENTION counts as open/active because exposure may exist and is
 * unresolved — treating it as free capacity would let a second trade stack on
 * top of an unknown position.
 *
 * PLAN_READY consumes nothing: capacity is only reserved once admission
 * succeeds and the execution moves to PREFLIGHT.
 */

export const PENDING_ENTRY_STATUSES: readonly TradeExecutionStatusName[] = [
  "PREFLIGHT",
  "ENTRY_SUBMITTING",
  "ENTRY_PENDING",
  "PARTIALLY_FILLED",
];

export const OPEN_POSITION_STATUSES: readonly TradeExecutionStatusName[] = [
  "PARTIALLY_FILLED",
  "ENTRY_FILLED",
  "PLACING_PROTECTION",
  "PROTECTED",
  "MANUAL_INTERVENTION",
];

export const TOTAL_ACTIVE_STATUSES: readonly TradeExecutionStatusName[] = [
  "PREFLIGHT",
  "ENTRY_SUBMITTING",
  "ENTRY_PENDING",
  "PARTIALLY_FILLED",
  "ENTRY_FILLED",
  "PLACING_PROTECTION",
  "PROTECTED",
  "MANUAL_INTERVENTION",
];

/** Consume no capacity and can never be revived. */
export const CAPACITY_FREE_STATUSES: readonly TradeExecutionStatusName[] = [
  "PLAN_READY",
  "ENTRY_EXPIRED",
  "CLOSED_TP",
  "CLOSED_SL",
  // Phase 7: reached only after the position, the entry remainder and every
  // protection sibling are all verified terminated, so its risk and margin
  // reservations are safe to release.
  "CLOSED_EMERGENCY",
  "CANCELED",
  "SKIPPED",
  "FAILED",
];

export function consumesPendingEntry(status: TradeExecutionStatusName): boolean {
  return PENDING_ENTRY_STATUSES.includes(status);
}

export function consumesOpenPosition(status: TradeExecutionStatusName): boolean {
  return OPEN_POSITION_STATUSES.includes(status);
}

export function consumesTotalActive(status: TradeExecutionStatusName): boolean {
  return TOTAL_ACTIVE_STATUSES.includes(status);
}

export function consumesNoCapacity(status: TradeExecutionStatusName): boolean {
  return CAPACITY_FREE_STATUSES.includes(status);
}

/** Stable key for the "one active LONG and one active SHORT per symbol" rule. */
export function symbolSideKey(symbol: string, positionSide: string): string {
  return `${symbol.trim().toUpperCase()}:${positionSide.trim().toUpperCase()}`;
}
