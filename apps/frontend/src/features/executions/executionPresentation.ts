/**
 * Phase 8 — central presentation mappings for every backend execution status.
 *
 * Pure and dependency-free so the mapping rules can be tested directly.
 *
 * The rule that matters: an UNKNOWN status is never silently styled as a
 * success. A future backend enum value falls through to a neutral/warning
 * presentation that still shows the raw sanitized value, so it stays visible
 * instead of disappearing or looking healthy.
 */

export type Tone = "green" | "red" | "yellow" | "gray" | "blue";

export interface StatusPresentation {
  label: string;
  tone: Tone;
  /** True when the state needs a human to look at it. */
  critical: boolean;
  /** True when the value was not in the known map. */
  unknown: boolean;
}

function unknownPresentation(raw: string): StatusPresentation {
  // The raw value is shown verbatim rather than guessed at.
  return { label: raw, tone: "yellow", critical: false, unknown: true };
}

// ---------------------------------------------------------------------------
// TradeExecution status
// ---------------------------------------------------------------------------

export const EXECUTION_STATUSES = [
  "PLAN_READY",
  "PREFLIGHT",
  "ENTRY_SUBMITTING",
  "ENTRY_PENDING",
  "PARTIALLY_FILLED",
  "ENTRY_FILLED",
  "PLACING_PROTECTION",
  "PROTECTED",
  "ENTRY_EXPIRED",
  "CLOSED_TP",
  "CLOSED_SL",
  "CLOSED_EMERGENCY",
  "CANCELED",
  "SKIPPED",
  "FAILED",
  "MANUAL_INTERVENTION",
] as const;

const EXECUTION_STATUS_MAP: Record<string, StatusPresentation> = {
  PLAN_READY: { label: "Plan ready", tone: "gray", critical: false, unknown: false },
  PREFLIGHT: { label: "Preflight", tone: "blue", critical: false, unknown: false },
  ENTRY_SUBMITTING: { label: "Submitting entry", tone: "blue", critical: false, unknown: false },
  ENTRY_PENDING: { label: "Entry pending", tone: "blue", critical: false, unknown: false },
  PARTIALLY_FILLED: { label: "Partially filled", tone: "yellow", critical: false, unknown: false },
  ENTRY_FILLED: { label: "Entry filled", tone: "yellow", critical: false, unknown: false },
  PLACING_PROTECTION: { label: "Placing protection", tone: "yellow", critical: false, unknown: false },
  PROTECTED: { label: "Protected", tone: "green", critical: false, unknown: false },
  ENTRY_EXPIRED: { label: "Entry expired", tone: "gray", critical: false, unknown: false },
  CLOSED_TP: { label: "Closed - take profit", tone: "green", critical: false, unknown: false },
  CLOSED_SL: { label: "Closed - stop loss", tone: "red", critical: false, unknown: false },
  CLOSED_EMERGENCY: { label: "Closed - emergency", tone: "red", critical: true, unknown: false },
  CANCELED: { label: "Canceled", tone: "gray", critical: false, unknown: false },
  SKIPPED: { label: "Skipped", tone: "gray", critical: false, unknown: false },
  FAILED: { label: "Failed", tone: "red", critical: false, unknown: false },
  MANUAL_INTERVENTION: { label: "Manual intervention", tone: "red", critical: true, unknown: false },
};

export function presentExecutionStatus(status: string): StatusPresentation {
  return EXECUTION_STATUS_MAP[status] ?? unknownPresentation(status);
}

// ---------------------------------------------------------------------------
// Protection state
// ---------------------------------------------------------------------------

export const PROTECTION_STATES = [
  "UNPROTECTED",
  "MARGIN_CHECK",
  "MARGIN_ADJUSTING",
  "PLACING_STOP",
  "STOP_VERIFIED",
  "PLACING_TAKE_PROFIT",
  "PROTECTED",
  "PROTECTION_INCOMPLETE",
  "EMERGENCY_CLOSING",
  "CLOSURE_CLEANUP",
  "CLOSED",
  "MANUAL_INTERVENTION",
] as const;

const PROTECTION_STATE_MAP: Record<string, StatusPresentation> = {
  UNPROTECTED: { label: "Unprotected", tone: "red", critical: true, unknown: false },
  MARGIN_CHECK: { label: "Checking margin", tone: "yellow", critical: false, unknown: false },
  MARGIN_ADJUSTING: { label: "Adjusting margin", tone: "yellow", critical: false, unknown: false },
  PLACING_STOP: { label: "Placing stop", tone: "yellow", critical: false, unknown: false },
  STOP_VERIFIED: { label: "Stop verified", tone: "blue", critical: false, unknown: false },
  PLACING_TAKE_PROFIT: { label: "Placing take profit", tone: "blue", critical: false, unknown: false },
  PROTECTED: { label: "Fully protected", tone: "green", critical: false, unknown: false },
  PROTECTION_INCOMPLETE: { label: "Protection incomplete", tone: "red", critical: true, unknown: false },
  EMERGENCY_CLOSING: { label: "Emergency closing", tone: "red", critical: true, unknown: false },
  CLOSURE_CLEANUP: { label: "Cleanup incomplete", tone: "red", critical: true, unknown: false },
  CLOSED: { label: "Closed", tone: "gray", critical: false, unknown: false },
  MANUAL_INTERVENTION: { label: "Manual intervention", tone: "red", critical: true, unknown: false },
};

export function presentProtectionState(state: string | null): StatusPresentation | null {
  if (state === null) return null;
  return PROTECTION_STATE_MAP[state] ?? unknownPresentation(state);
}

// ---------------------------------------------------------------------------
// Order status, safety decision, alert delivery, margin adjustment
// ---------------------------------------------------------------------------

export const ORDER_STATUSES = [
  "PLANNED",
  "SUBMITTING",
  "NEW",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELED",
  "EXPIRED",
  "REJECTED",
  "UNKNOWN",
] as const;

const ORDER_STATUS_MAP: Record<string, StatusPresentation> = {
  PLANNED: { label: "Planned", tone: "gray", critical: false, unknown: false },
  SUBMITTING: { label: "Submitting", tone: "blue", critical: false, unknown: false },
  NEW: { label: "Working", tone: "blue", critical: false, unknown: false },
  PARTIALLY_FILLED: { label: "Partially filled", tone: "yellow", critical: false, unknown: false },
  FILLED: { label: "Filled", tone: "green", critical: false, unknown: false },
  CANCELED: { label: "Canceled", tone: "gray", critical: false, unknown: false },
  EXPIRED: { label: "Expired", tone: "gray", critical: false, unknown: false },
  REJECTED: { label: "Rejected", tone: "red", critical: false, unknown: false },
  // UNKNOWN is a REAL persisted state here, and it is a warning, not a success.
  UNKNOWN: { label: "Unknown", tone: "yellow", critical: true, unknown: false },
};

export function presentOrderStatus(status: string): StatusPresentation {
  return ORDER_STATUS_MAP[status] ?? unknownPresentation(status);
}

export const SAFETY_DECISIONS = ["PASS", "SKIP", "RETRY_CONFLICT", "UNAVAILABLE"] as const;

const SAFETY_DECISION_MAP: Record<string, StatusPresentation> = {
  PASS: { label: "Pass", tone: "green", critical: false, unknown: false },
  SKIP: { label: "Skipped", tone: "gray", critical: false, unknown: false },
  RETRY_CONFLICT: { label: "Retry conflict", tone: "yellow", critical: false, unknown: false },
  UNAVAILABLE: { label: "Unavailable", tone: "yellow", critical: false, unknown: false },
};

export function presentSafetyDecision(decision: string): StatusPresentation {
  return SAFETY_DECISION_MAP[decision] ?? unknownPresentation(decision);
}

export const ALERT_DELIVERY_STATUSES = ["PENDING", "SENT", "FAILED"] as const;

const ALERT_DELIVERY_MAP: Record<string, StatusPresentation> = {
  PENDING: { label: "Queued", tone: "yellow", critical: false, unknown: false },
  SENT: { label: "Delivered", tone: "green", critical: false, unknown: false },
  FAILED: { label: "Delivery failed", tone: "red", critical: true, unknown: false },
};

export function presentAlertDelivery(status: string): StatusPresentation {
  return ALERT_DELIVERY_MAP[status] ?? unknownPresentation(status);
}

export const MARGIN_ADJUSTMENT_STATUSES = [
  "PENDING",
  "SUBMITTING",
  "RESULT_UNKNOWN",
  "CONFIRMED",
  "REJECTED",
] as const;

const MARGIN_ADJUSTMENT_MAP: Record<string, StatusPresentation> = {
  PENDING: { label: "Pending", tone: "gray", critical: false, unknown: false },
  SUBMITTING: { label: "Submitting", tone: "blue", critical: false, unknown: false },
  RESULT_UNKNOWN: { label: "Result unknown", tone: "yellow", critical: true, unknown: false },
  CONFIRMED: { label: "Confirmed", tone: "green", critical: false, unknown: false },
  REJECTED: { label: "Rejected", tone: "red", critical: false, unknown: false },
};

export function presentMarginAdjustment(status: string): StatusPresentation {
  return MARGIN_ADJUSTMENT_MAP[status] ?? unknownPresentation(status);
}

// ---------------------------------------------------------------------------
// Exit reason
// ---------------------------------------------------------------------------

/**
 * The persisted exitReason wins. A lifecycle status is only used as a fallback
 * label where it unambiguously describes how the POSITION left the market.
 *
 * FAILED / SKIPPED / CANCELED / ENTRY_EXPIRED / MANUAL_INTERVENTION are
 * lifecycle outcomes, not position exits, so no exit reason is invented for
 * them.
 */
export function presentExitReason(exitReason: string | null, status: string): string | null {
  if (exitReason) return exitReason;
  switch (status) {
    case "CLOSED_TP":
      return "Take profit";
    case "CLOSED_SL":
      return "Stop loss";
    case "CLOSED_EMERGENCY":
      return "Emergency close";
    default:
      return null;
  }
}
