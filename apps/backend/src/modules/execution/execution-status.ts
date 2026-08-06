/**
 * Pure lifecycle state machine for a TradeExecution.
 *
 * Deliberately free of Prisma, network and I/O so it can be reasoned about and
 * tested in isolation. Mirrors the TradeExecutionStatus enum as string
 * literals; a compile-time check in the service keeps the two aligned.
 *
 * Semantics that matter more than the graph itself:
 *  - FAILED asserts that NO unresolved live exposure is known.
 *  - MANUAL_INTERVENTION is the correct state whenever exposure may exist and
 *    protection is uncertain — including after a timeout, which is never
 *    proof that an order was not created.
 *  - CANCELED is only for an execution stopped BEFORE any live exposure.
 */

export const TRADE_EXECUTION_STATUSES = [
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
  "CANCELED",
  "SKIPPED",
  "FAILED",
  "MANUAL_INTERVENTION",
] as const;

export type TradeExecutionStatusName = (typeof TRADE_EXECUTION_STATUSES)[number];

/** No transition may leave these. */
export const TERMINAL_STATUSES: readonly TradeExecutionStatusName[] = [
  "ENTRY_EXPIRED",
  "CLOSED_TP",
  "CLOSED_SL",
  "CANCELED",
  "SKIPPED",
  "FAILED",
];

/**
 * States in which live exposure may already exist. Reaching one of these
 * makes CANCELED invalid (there is something to unwind) and makes
 * MANUAL_INTERVENTION — not FAILED — the correct "we are unsure" state.
 */
export const EXPOSURE_POSSIBLE_STATUSES: readonly TradeExecutionStatusName[] = [
  "ENTRY_SUBMITTING",
  "PARTIALLY_FILLED",
  "ENTRY_FILLED",
  "PLACING_PROTECTION",
  "PROTECTED",
];

const TRANSITIONS: Record<TradeExecutionStatusName, readonly TradeExecutionStatusName[]> = {
  PLAN_READY: ["PREFLIGHT", "SKIPPED", "CANCELED", "FAILED"],
  PREFLIGHT: ["ENTRY_SUBMITTING", "SKIPPED", "CANCELED", "FAILED"],
  // No CANCELED: once submission is attempted an order may exist, so an
  // uncertain outcome must go to MANUAL_INTERVENTION instead.
  ENTRY_SUBMITTING: ["ENTRY_PENDING", "PARTIALLY_FILLED", "ENTRY_FILLED", "FAILED", "MANUAL_INTERVENTION"],
  ENTRY_PENDING: [
    "PARTIALLY_FILLED",
    "ENTRY_FILLED",
    "ENTRY_EXPIRED",
    "CANCELED",
    "FAILED",
    "MANUAL_INTERVENTION",
  ],
  PARTIALLY_FILLED: ["ENTRY_FILLED", "PLACING_PROTECTION", "ENTRY_EXPIRED", "MANUAL_INTERVENTION"],
  ENTRY_FILLED: ["PLACING_PROTECTION", "MANUAL_INTERVENTION"],
  PLACING_PROTECTION: ["PROTECTED", "MANUAL_INTERVENTION"],
  PROTECTED: ["CLOSED_TP", "CLOSED_SL", "MANUAL_INTERVENTION"],
  // Terminal.
  ENTRY_EXPIRED: [],
  CLOSED_TP: [],
  CLOSED_SL: [],
  CANCELED: [],
  SKIPPED: [],
  FAILED: [],
  // Stays put while further events are recorded (see allowsSelfEvent).
  MANUAL_INTERVENTION: [],
};

export function isTerminalStatus(status: TradeExecutionStatusName): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function mayHaveExposure(status: TradeExecutionStatusName): boolean {
  return EXPOSURE_POSSIBLE_STATUSES.includes(status);
}

export function allowedTransitionsFrom(status: TradeExecutionStatusName): readonly TradeExecutionStatusName[] {
  return TRANSITIONS[status] ?? [];
}

export interface TransitionCheck {
  allowed: boolean;
  reason: string | null;
}

/**
 * Validates a status transition. A MANUAL_INTERVENTION -> MANUAL_INTERVENTION
 * "transition" is permitted so additional events can be appended while the
 * execution stays parked for a human; no other self-transition is allowed.
 */
export function canTransition(
  from: TradeExecutionStatusName,
  to: TradeExecutionStatusName
): TransitionCheck {
  if (!TRADE_EXECUTION_STATUSES.includes(from)) {
    return { allowed: false, reason: `Unknown source status "${from}".` };
  }
  if (!TRADE_EXECUTION_STATUSES.includes(to)) {
    return { allowed: false, reason: `Unknown target status "${to}".` };
  }

  if (from === "MANUAL_INTERVENTION" && to === "MANUAL_INTERVENTION") {
    return { allowed: true, reason: null };
  }

  if (isTerminalStatus(from)) {
    return { allowed: false, reason: `${from} is terminal; no further transition is allowed.` };
  }

  if (from === to) {
    return { allowed: false, reason: `Repeating ${from} is not a valid transition.` };
  }

  if (!allowedTransitionsFrom(from).includes(to)) {
    // Make the two most safety-critical mistakes explicit.
    if (to === "CANCELED" && mayHaveExposure(from)) {
      return {
        allowed: false,
        reason: `CANCELED is only valid before live exposure; from ${from} use MANUAL_INTERVENTION and unwind explicitly.`,
      };
    }
    if (to === "FAILED" && mayHaveExposure(from)) {
      return {
        allowed: false,
        reason: `FAILED asserts no unresolved exposure; from ${from} exposure may exist, so use MANUAL_INTERVENTION.`,
      };
    }
    return { allowed: false, reason: `${from} -> ${to} is not an allowed transition.` };
  }

  return { allowed: true, reason: null };
}
