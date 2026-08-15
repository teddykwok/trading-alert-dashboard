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
  "CLOSED_EMERGENCY",
  // Provably flat, but the closure cannot be attributed to one of OUR owned,
  // verified orders. A manual operator close, another client, a liquidation or
  // ADL all look identical from here, so the status claims only what is known.
  "CLOSED_EXTERNAL",
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
  // Phase 7: the position was closed at market as a last resort. Like every
  // other closed state it asserts there is nothing left to unwind.
  "CLOSED_EMERGENCY",
  // Reached only after the position is PROVEN flat, the entry can no longer
  // refill and every owned protection sibling is absent, terminal or verifiably
  // cancelled — so it asserts the same "nothing left to unwind" as the others.
  "CLOSED_EXTERNAL",
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

/**
 * The only statuses from which an unattributed external close may be recorded.
 *
 * Each one can reach reconcileProtectionAndClosure's proof path — position
 * proven flat, entry remainder neutralized, position re-read with no refill,
 * every owned protection sibling resolved and no owned fill to attribute — and
 * each one has RECORDED LIVE EXPOSURE, so "something closed this position" is a
 * statement about reality rather than a convenience.
 *
 * ENTRY_SUBMITTING is deliberately absent even though exposure MAY exist there:
 * no confirmed fill is recorded yet, so ensureProtectionForExposure stops at
 * EXECUTION_HAS_NO_CONFIRMED_FILL and the proof path is never reached. The
 * pre-exposure states are absent for the stronger reason that there is nothing
 * external to observe at all.
 */
export const EXTERNAL_CLOSURE_SOURCE_STATUSES: readonly TradeExecutionStatusName[] = [
  "PARTIALLY_FILLED",
  "ENTRY_FILLED",
  "PLACING_PROTECTION",
  "PROTECTED",
  "MANUAL_INTERVENTION",
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
  // Phase 7 protects the filled quantity while the entry may still be open, so
  // a protection exit can close directly from these states.
  //
  // CLOSED_EXTERNAL is reachable from all three because the orchestrator routes
  // each of them into ensureProtectionForExposure, which hands a flat position
  // straight to reconcileProtectionAndClosure. Exposure was recorded here, so a
  // proven-flat position that no owned order explains is a real outcome — not a
  // convenience. See EXTERNAL_CLOSURE_SOURCE_STATUSES.
  PARTIALLY_FILLED: [
    "ENTRY_FILLED",
    "PLACING_PROTECTION",
    "ENTRY_EXPIRED",
    "CLOSED_TP",
    "CLOSED_SL",
    "CLOSED_EMERGENCY",
    "CLOSED_EXTERNAL",
    "MANUAL_INTERVENTION",
  ],
  ENTRY_FILLED: [
    "PLACING_PROTECTION",
    "CLOSED_TP",
    "CLOSED_SL",
    "CLOSED_EMERGENCY",
    "CLOSED_EXTERNAL",
    "MANUAL_INTERVENTION",
  ],
  PLACING_PROTECTION: ["PROTECTED", "CLOSED_EMERGENCY", "CLOSED_EXTERNAL", "MANUAL_INTERVENTION"],
  PROTECTED: ["CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY", "CLOSED_EXTERNAL", "MANUAL_INTERVENTION"],
  // Terminal.
  ENTRY_EXPIRED: [],
  CLOSED_TP: [],
  CLOSED_SL: [],
  CLOSED_EMERGENCY: [],
  CANCELED: [],
  SKIPPED: [],
  FAILED: [],
  CLOSED_EXTERNAL: [],
  // Parked for a human — but its protection orders are still LIVE on the
  // exchange, so it can still close on its own.
  //
  // Every exit here requires exchange proof: a verified emergency close, an
  // owned STOP or TAKE_PROFIT that actually filled, or a proven-flat position
  // whose closure cannot be attributed to any owned order.
  //
  // CLOSED_TP/CLOSED_SL were missing. The orchestrator routes
  // MANUAL_INTERVENTION into reconcileProtectionAndClosure, which attributes a
  // closure from a filled owned order, so a parked execution whose stop fires
  // genuinely reaches CLOSED_SL. Mainnet Canary #2 sat parked for 16 minutes
  // with a live STOP on Binance; had it triggered, this is the transition that
  // would have been taken. Omitting them did not prevent the write — nothing
  // enforced the graph — it only meant the write bypassed the state machine.
  // Recording such a closure as CLOSED_EXTERNAL would discard attribution we
  // demonstrably have.
  //
  // PLACING_PROTECTION is the ONLY non-terminal exit, and it is deliberately
  // the weakest one available: it claims exposure exists and protection work is
  // in flight — nothing more. It does NOT claim protection is verified, so the
  // existing verifyAggregateCoverage funnel must still prove full coverage
  // before PROTECTED, and an escalation from there re-parks by a legal edge.
  //
  // Taking it requires far more than "the graph allows it". Only
  // attemptProtectionRecovery may, and only for an execution parked by an
  // ALLOWLISTED protection-lifecycle reason, with current exchange evidence
  // proving the position open, its identity valid, every protection leg
  // readable (no UNKNOWN) and no over-protection — within a bounded per-episode
  // retry budget. Every other parked reason, including every entry-lifecycle
  // and operator intervention, is excluded by construction because it never
  // writes ExecutionProtectionState.state = MANUAL_INTERVENTION.
  //
  // Without this edge a parked execution with live exposure could never rejoin
  // the protected lifecycle: recordProtectionStatus only admits
  // ENTRY_FILLED -> PLACING_PROTECTION -> PROTECTED, so repairing protection on
  // the exchange still left the row parked forever, holding recoveryRequiredCount
  // at 1 and blocking all new work until an operator closed the position by hand.
  MANUAL_INTERVENTION: [
    "CLOSED_EMERGENCY",
    "CLOSED_EXTERNAL",
    "CLOSED_TP",
    "CLOSED_SL",
    "PLACING_PROTECTION",
  ],
};

/**
 * A persistence layer refused to write a transition the state machine forbids.
 *
 * Deliberately DISTINCT from a lost compare-and-swap. A CAS loss is ordinary
 * concurrency — the next reconciliation tick simply retries and succeeds. This
 * is a modelling error: the same call will be refused forever, so it must be
 * loud rather than silently indistinguishable from a race.
 *
 * A plain Error subclass keeps this module dependency-free.
 */
export class IllegalExecutionTransitionError extends Error {
  readonly executionId: string;
  readonly fromStatus: string;
  readonly toStatus: string;

  constructor(executionId: string, fromStatus: string, toStatus: string, reason: string | null) {
    super(
      `Refusing to persist illegal execution transition ${fromStatus} -> ${toStatus} ` +
        `for ${executionId}${reason ? `: ${reason}` : "."}`
    );
    this.name = "IllegalExecutionTransitionError";
    this.executionId = executionId;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

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
