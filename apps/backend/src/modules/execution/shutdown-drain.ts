import { PENDING_ENTRY_STATUSES } from "./capacity-status";
import type { TradeExecutionStatusName } from "./execution-status";

/**
 * Deciding whether the runtime may be stopped after draining pending entries.
 *
 * ## What this is for
 *
 * The launcher already refuses to stop while anything is active — that guard is
 * correct and is not touched here. What was missing is a supported way to
 * REACH a stoppable state on purpose: with a LIMIT entry resting at Binance,
 * the only options were to wait for it to fill or to wait out its 24-hour TTL.
 * Closing the laptop instead is what left a position filled with no worker
 * present to protect it.
 *
 * So this decides one question — "is every pending entry now resolved well
 * enough that leaving is safe?" — over outcomes that the ENTRY lifecycle
 * produced. It performs no cancellation and reads no exchange itself.
 *
 * ## The rule
 *
 * Every pending entry must reach a proven, exposure-free end state. One
 * ambiguous result refuses the whole shutdown: a cancellation whose outcome we
 * cannot establish is exactly the case that could be holding a live order, and
 * "we could not tell" is never rounded up to "safe to leave".
 *
 * ## What it deliberately does NOT claim
 *
 * This makes an INTENTIONAL shutdown safe. It cannot make an unexpected one
 * safe: an operating system that suspends or kills the process gives no
 * opportunity to run, and neither does power loss. Nothing here should be read
 * as protection against closing the lid without asking first.
 */

/** The canonical pending set — the same one capacity accounting uses. */
export const DRAIN_CANDIDATE_STATUSES: readonly TradeExecutionStatusName[] = PENDING_ENTRY_STATUSES;

export const DRAIN_OUTCOMES = [
  /** The entry is proven gone with no exposure. Safe to leave. */
  "CANCELED_CLEAN",
  /** A fill won the race, or exposure already existed. NOT safe to leave. */
  "EXPOSURE_PRESENT",
  /** Nothing could be cancelled here and the worker must resolve it. */
  "NOT_DRAINABLE",
  /** The result could not be established. NOT safe to leave. */
  "AMBIGUOUS",
] as const;

export type DrainOutcome = (typeof DRAIN_OUTCOMES)[number];

export interface DrainedExecution {
  executionId: string;
  symbol: string;
  positionSide: string;
  /** Status BEFORE the drain touched it. */
  statusBefore: string;
  /** Status AFTER, as the lifecycle left it. */
  statusAfter: string;
  outcome: DrainOutcome;
  /** The lifecycle's own reason code, never re-invented here. */
  reasonCode: string;
  detail: string;
}

/**
 * End states in which an execution holds no exposure and needs no worker.
 *
 * Deliberately narrow, and deliberately NOT derived from "is it in the capacity
 * set": an execution can be out of the active set for reasons that still want
 * attention. These are the states that are finished.
 */
const EXPOSURE_FREE_TERMINAL: readonly string[] = [
  "ENTRY_EXPIRED",
  "CANCELED",
  "SKIPPED",
  "FAILED",
  "CLOSED_TP",
  "CLOSED_SL",
  "CLOSED_EMERGENCY",
  "CLOSED_EXTERNAL",
];

/** True when the lifecycle left this execution finished and exposure-free. */
export function isExposureFreeTerminal(status: string): boolean {
  return EXPOSURE_FREE_TERMINAL.includes(status);
}

export interface ShutdownPosture {
  /** SAFE_OFF | SAFE_RECOVERY | ARMED | INVALID | UNKNOWN, or null if unread. */
  systemState: string | null;
  /** The newest natural window's state, or null when none exists. */
  authorizationState: string | null;
  /** Executions requiring manual intervention, or null if unread. */
  manualInterventionCount: number | null;
  /** Executions holding an open position, or null if unread. */
  openPositionCount: number | null;
}

/**
 * Postures in which a drain may run.
 *
 * SAFE_RECOVERY is included alongside SAFE_OFF because it is what a real
 * incident leaves behind — the operator engaged the kill switch and revoked the
 * window — and refusing there would block the drain in exactly the situation it
 * exists for. Both durably block new entry, which is the property that matters:
 * nothing new can be admitted while pending orders are being cancelled.
 */
export const DRAIN_ELIGIBLE_STATES: readonly string[] = ["SAFE_OFF", "SAFE_RECOVERY"];

export type PostureVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether the durable posture permits a drain to begin.
 *
 * Never mutates and never asks for a transition. Reaching a safe posture is the
 * dashboard's job through Safe Off, exactly as the launcher already states.
 */
export function judgeDrainPosture(posture: ShutdownPosture): PostureVerdict {
  if (
    posture.systemState === null ||
    posture.manualInterventionCount === null ||
    posture.openPositionCount === null
  ) {
    return {
      allowed: false,
      reason: "The durable Trading Control state could not be read. It is not assumed to be safe.",
    };
  }

  if (!DRAIN_ELIGIBLE_STATES.includes(posture.systemState)) {
    return {
      allowed: false,
      reason:
        posture.systemState === "ARMED"
          ? "Trading is ARMED. Use Trading Control -> Safe Off before draining for shutdown."
          : `The durable trading state is ${posture.systemState}; draining requires ${DRAIN_ELIGIBLE_STATES.join(" or ")}.`,
    };
  }

  // An open window can admit a trade the moment a runtime is live, so draining
  // underneath one would be cancelling entries while new ones may appear.
  if (posture.authorizationState === "AVAILABLE") {
    return {
      allowed: false,
      reason: "A natural authorization window is still AVAILABLE and could admit a new trade. Revoke it first.",
    };
  }

  // Cleaning these up is a separate, deliberate operator action; a drain must
  // never quietly absorb one.
  if (posture.manualInterventionCount > 0) {
    return {
      allowed: false,
      reason: `${posture.manualInterventionCount} execution(s) require manual intervention. Resolve them before draining for shutdown.`,
    };
  }

  return { allowed: true };
}

export interface ShutdownVerdict {
  /** True only when every pending entry resolved cleanly AND nothing is open. */
  shutdownReady: boolean;
  reasons: string[];
  drained: DrainedExecution[];
}

/**
 * The total function over one drain pass.
 *
 * A single unresolved entry refuses the whole shutdown. Draining four of five
 * orders and stopping anyway would leave the fifth resting with nobody to
 * protect it, which is the exact failure this feature exists to prevent — so
 * there is no partial success.
 */
export function judgeShutdownReadiness(input: {
  posture: ShutdownPosture;
  drained: DrainedExecution[];
}): ShutdownVerdict {
  const reasons: string[] = [];

  const posture = judgeDrainPosture(input.posture);
  if (!posture.allowed) reasons.push(posture.reason);

  for (const entry of input.drained) {
    if (entry.outcome === "CANCELED_CLEAN") continue;
    reasons.push(`${entry.symbol} ${entry.positionSide} (${entry.executionId}): ${entry.outcome} — ${entry.detail}`);
  }

  // Positions are never closed by this feature, and a filled position needs the
  // worker for reconciliation and protection. An open position therefore
  // refuses shutdown outright rather than being drained around.
  if ((input.posture.openPositionCount ?? 0) > 0) {
    reasons.push(
      `${input.posture.openPositionCount} open position(s) exist. This feature never closes a position, ` +
        "and an open position needs the worker present."
    );
  }

  return { shutdownReady: reasons.length === 0, reasons, drained: input.drained };
}

/** A short, log-safe summary. Counts and codes only — never a payload. */
export function summarizeDrain(verdict: ShutdownVerdict): string {
  const clean = verdict.drained.filter((entry) => entry.outcome === "CANCELED_CLEAN").length;
  return verdict.shutdownReady
    ? `shutdown READY (${clean}/${verdict.drained.length} entries drained clean)`
    : `shutdown BLOCKED (${verdict.reasons.length} reason(s), ${clean}/${verdict.drained.length} drained clean)`;
}
