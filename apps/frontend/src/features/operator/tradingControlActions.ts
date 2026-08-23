import type { TradingControlStatusDto, TradingSystemState } from "../../api/operator";
import { START_TRADING_CONFIRMATION } from "../../api/operator";

/**
 * The three operator actions, as pure descriptions.
 *
 * Everything the confirmation dialog says, and every rule about when a button
 * is offered, lives here so it can be asserted directly. The component is a
 * thin mapping, exactly as the status presentation is.
 *
 * The backend is always the final authority: these rules decide what to OFFER,
 * never what is permitted. A button being enabled is not a claim that the
 * action will succeed — the server re-checks attestation, readiness, the
 * environment gates and the advisory lock regardless.
 */

export type TradingControlActionId = "START" | "STOP_NEW_TRADES" | "SAFE_OFF";

export interface TradingControlAction {
  id: TradingControlActionId;
  label: string;
  /** Shown in the confirmation dialog. Must not overstate what the action does. */
  description: string;
  /** Non-null when the operator must type a phrase exactly. */
  requiredPhrase: string | null;
  destructiveLooking: boolean;
}

export const TRADING_CONTROL_ACTIONS: readonly TradingControlAction[] = [
  {
    id: "START",
    label: "Start Trading",
    description:
      "Opens one natural authorization window and arms the profile so new entries can be admitted. No order is placed by this action.",
    // The one action that opens a real-money account to admission gets the
    // highest-friction confirmation there is.
    requiredPhrase: START_TRADING_CONFIRMATION,
    destructiveLooking: true,
  },
  {
    id: "STOP_NEW_TRADES",
    label: "Stop New Trades",
    description:
      "Blocks new entries. Existing positions continue to be managed: nothing is cancelled and no position is closed.",
    requiredPhrase: null,
    destructiveLooking: false,
  },
  {
    id: "SAFE_OFF",
    label: "Safe Off",
    description:
      "Disarms trading and revokes unused authorization. Existing executions remain managed until it is safe to disable the profile.",
    requiredPhrase: null,
    destructiveLooking: false,
  },
];

export function findAction(id: TradingControlActionId): TradingControlAction {
  const action = TRADING_CONTROL_ACTIONS.find((entry) => entry.id === id);
  if (!action) throw new Error(`unknown trading control action: ${id}`);
  return action;
}

/**
 * Whether an action is worth offering for the current system state.
 *
 * Deliberately permissive for START: the operator may legitimately try while
 * the panel shows blockers, and the server's refusal carries far better
 * information than a greyed-out button does. What must NOT happen is offering
 * Start on a system that is already armed, or offering Stop on one where
 * nothing can be admitted anyway.
 */
export function isActionRelevant(id: TradingControlActionId, state: TradingSystemState): boolean {
  switch (id) {
    case "START":
      // Nothing to start when already armed.
      return state !== "ARMED";
    case "STOP_NEW_TRADES":
      // Only meaningful while admission is possible.
      return state === "ARMED";
    case "SAFE_OFF":
      // Meaningful whenever the profile is still enabled, which includes the
      // recovery state where work is being wound down.
      return state === "ARMED" || state === "SAFE_RECOVERY" || state === "INVALID";
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The deployment prerequisite
// ---------------------------------------------------------------------------

export const START_PREREQUISITE_REASON =
  "Runtime activation gates are SAFE. Start the runtime in live-ready mode before arming.";

export const START_ATTESTATION_WARNING =
  "The running backend and worker are not attesting live-ready gates. Arming will be refused until they do.";

export interface StartPrerequisite {
  ready: boolean;
  reason: string | null;
  /** Advisory only: shown, but never used to disable the control. */
  warning: string | null;
}

/**
 * Whether the deployment prerequisite for arming is satisfied.
 *
 * This is NOT a second copy of the backend's readiness logic. It reads the
 * three activation gates the status endpoint already publishes and answers one
 * question: has the runtime been started in live-ready mode at all?
 *
 * The distinction matters because that prerequisite is categorically different
 * from a readiness blocker. A readiness blocker is something the server
 * evaluates and may clear on its own, so the panel deliberately still offers
 * Start and lets the server explain its refusal. The activation gates are
 * process environment variables: nothing in the application writes them, and
 * Start can NEVER resolve them. Leaving the button live in that state invites
 * exactly one wrong belief — that pressing it will bring the runtime up live.
 *
 * Attestation is surfaced as a WARNING rather than a disabler: it can be
 * transiently unreadable, and the server is the authority on whether it blocks.
 */
export function describeStartPrerequisite(
  status: Pick<TradingControlStatusDto, "environmentGates" | "runtimeAttestation"> | null
): StartPrerequisite {
  if (!status) {
    // Unknown is not ready. The panel must not imply arming is possible before
    // it has read anything.
    return { ready: false, reason: START_PREREQUISITE_REASON, warning: null };
  }
  const gates = status.environmentGates;
  const ready = !gates.globalKillSwitch && gates.liveEntryEnabled && gates.protectionReady;
  return {
    ready,
    reason: ready ? null : START_PREREQUISITE_REASON,
    warning: status.runtimeAttestation.status === "PASS" ? null : START_ATTESTATION_WARNING,
  };
}

/** The server accepts the phrase only when it matches exactly. So does this. */
export function isConfirmationSatisfied(action: TradingControlAction, typed: string): boolean {
  if (action.requiredPhrase === null) return true;
  return typed === action.requiredPhrase;
}

export interface StartContext {
  environment: string;
  allowedSymbols: string;
  /** How many symbols the durable policy admits. 0 would be allow-all. */
  allowedSymbolCount: number;
  /** Full list when short, count plus a preview when long. */
  allowedSymbolsPreview: string;
  /** The SOURCE timeframes the server will admit, as persisted. */
  sourceTimeframes: string;
  /** False when the persisted policy could not admit any signal. */
  sourceTimeframesValid: boolean;
  riskLimit: string;
  marginLimit: string;
  desiredOpen: number;
  hardTotal: number;
  maxClaims: number;
  windowMinutes: number;
}

/** The reviewed first-live defaults, mirrored from the server for display. */
export const START_WINDOW_MINUTES = 60;
export const START_MAX_CLAIMS = 5;

/**
 * Beyond this many symbols the dialog shows a count and a preview instead of
 * the whole list. Six hundred badges is not information, it is a wall.
 */
export const ALLOWLIST_PREVIEW_THRESHOLD = 12;

/**
 * How the allowlist reads in a panel or dialog.
 *
 * An empty list is rendered as an explicit warning rather than as nothing,
 * because empty means ALL symbols to the admission engine and that is the one
 * state an operator must never mistake for "none".
 */
export function describeAllowlist(symbols: readonly string[]): string {
  if (symbols.length === 0) return "ALL (unrestricted)";
  if (symbols.length <= ALLOWLIST_PREVIEW_THRESHOLD) return symbols.join(", ");
  return `${symbols.slice(0, 6).join(", ")}, … (+${symbols.length - 6} more)`;
}

/**
 * The authoritative context shown before arming.
 *
 * Every figure comes from the status the server already sent. None of it is
 * editable: risk, margin, capacity, leverage, strategy and the symbol allowlist
 * are server-side policy, and this dialog reports them rather than offering
 * them.
 */
export function describeStartContext(status: TradingControlStatusDto): StartContext {
  return {
    environment: status.profile?.environment ?? "UNKNOWN",
    allowedSymbols:
      status.allowedSymbols.length === 0 ? "ALL (unrestricted)" : status.allowedSymbols.join(", "),
    allowedSymbolCount: status.allowedSymbols.length,
    allowedSymbolsPreview: describeAllowlist(status.allowedSymbols),
    // Straight from the server's status, exactly like every other figure
    // here. An unsaved checkbox in the editor must never reach this dialog:
    // the operator is confirming what the BACKEND will enforce.
    sourceTimeframes: describeSourceTimeframes(status.sourceTimeframes),
    sourceTimeframesValid: status.sourceTimeframes.valid,
    riskLimit: `${status.reservations.riskUsd} / ${status.reservations.riskLimitUsd} USD`,
    marginLimit: `${status.reservations.marginUsd} / ${status.reservations.marginLimitUsd} USD`,
    desiredOpen: status.capacity.desiredOpen,
    hardTotal: status.capacity.hardTotal,
    maxClaims: START_MAX_CLAIMS,
    windowMinutes: START_WINDOW_MINUTES,
  };
}

/**
 * How an action's result should read on the panel.
 *
 * A refusal is reported with the server's own blocker text. Nothing here
 * invents a verdict, and nothing here claims ARMED that the server did not.
 */
export function presentActionResult(result: {
  ok: boolean;
  outcome: string;
  message: string;
  blockers: string[];
}): { tone: "green" | "yellow" | "red"; headline: string; detail: string[] } {
  if (result.ok) {
    return {
      tone: result.outcome === "ARMED" || result.outcome === "ALREADY_ARMED" ? "yellow" : "green",
      headline: result.outcome,
      detail: [result.message],
    };
  }
  return {
    // A prepared-but-not-armed window is a state the operator must act on, and
    // it is not the same as a clean refusal.
    tone: result.outcome === "WINDOW_PREPARED_NOT_ARMED" ? "red" : "yellow",
    headline: result.outcome,
    detail: [result.message, ...result.blockers],
  };
}

// ---------------------------------------------------------------------------
// Source timeframes
// ---------------------------------------------------------------------------

/**
 * How the in-force source-timeframe policy reads.
 *
 * A policy that admits nothing is rendered as an explicit warning rather than
 * as an empty string, and NEVER as "all". Empty here means no signal can
 * execute, which is the opposite of what empty means for the symbol
 * allowlist — so it is spelled out instead of left to be inferred.
 */
export function describeSourceTimeframes(policy: {
  enforceable: string[];
  unrecognized: string[];
  valid: boolean;
}): string {
  if (policy.enforceable.length === 0) {
    return "NONE — no signal can execute";
  }
  const base = policy.enforceable.join(", ");
  return policy.unrecognized.length > 0
    ? `${base} (ignoring ${policy.unrecognized.length} unrecognised stored value(s))`
    : base;
}

/**
 * Whether the editor may offer to SAVE this selection.
 *
 * Two independent conditions, and the empty one is the load-bearing half:
 * an empty selection is not a smaller policy, it is a policy that admits
 * nothing. The backend refuses it too — this only stops the button from
 * offering something the server would reject.
 */
export function canSaveSourceTimeframes(input: {
  selection: readonly string[];
  inForce: readonly string[];
  editable: boolean;
}): { allowed: boolean; reason: string | null } {
  if (input.selection.length === 0) {
    return {
      allowed: false,
      reason: "Select at least one source timeframe. An empty selection would admit no signal at all.",
    };
  }
  if (!input.editable) return { allowed: false, reason: null };
  if (sameSelection(input.selection, input.inForce)) {
    return { allowed: false, reason: "This is already the policy in force." };
  }
  return { allowed: true, reason: null };
}

/** Order-insensitive comparison, so a reordered selection is not a change. */
export function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/** Adds or removes one timeframe, preserving the supported order. */
export function toggleSourceTimeframe(
  selection: readonly string[],
  timeframe: string,
  supported: readonly string[]
): string[] {
  const next = new Set(selection);
  if (next.has(timeframe)) next.delete(timeframe);
  else next.add(timeframe);
  return supported.filter((value) => next.has(value));
}

// ---------------------------------------------------------------------------
// The allowlist editor
// ---------------------------------------------------------------------------

/**
 * Whether the editor may offer to SAVE.
 *
 * Mirrors the server's rule so the button matches reality, and nothing more:
 * the backend re-checks the same durable facts inside a transaction, so a
 * browser that ignores this still cannot write while armed.
 */
export function canEditAllowlist(
  status: Pick<TradingControlStatusDto, "systemState" | "capacity" | "manualIntervention"> | null,
  what = "The allowlist"
): { allowed: boolean; reason: string | null } {
  if (!status) return { allowed: false, reason: "Trading Control status has not loaded yet." };
  if (status.systemState !== "SAFE_OFF") {
    return {
      allowed: false,
      reason: `${what} can only be changed while SAFE OFF (system is ${status.systemState}).`,
    };
  }
  if (status.capacity.totalActive > 0) {
    return {
      allowed: false,
      reason: `${status.capacity.totalActive} execution(s) are still active.`,
    };
  }
  if (status.manualIntervention.present) {
    return { allowed: false, reason: "Manual intervention is outstanding." };
  }
  return { allowed: true, reason: null };
}

/**
 * The SAME durable rule, for the source-timeframe editor.
 *
 * Deliberately delegates rather than restating the conditions: both editors
 * change which signals may become money, the backend guards them with one
 * shared invariant, and two copies of that list would eventually disagree.
 */
export function canEditSourceTimeframes(
  status: Pick<TradingControlStatusDto, "systemState" | "capacity" | "manualIntervention"> | null
): { allowed: boolean; reason: string | null } {
  return canEditAllowlist(status, "Source timeframes");
}

/** The counts line, in the order the operator reads them. */
export function describeAllowlistCounts(counts: {
  input: number;
  normalized: number;
  valid: number;
  duplicates: number;
  rejected: number;
}): string[] {
  return [
    `Input:      ${counts.input}`,
    `Normalized: ${counts.normalized}`,
    `Valid:      ${counts.valid}`,
    `Duplicates: ${counts.duplicates}`,
    `Rejected:   ${counts.rejected}`,
  ];
}

/** Groups rejections by reason so a 130-item list reads as five lines. */
export function groupRejections(
  rejected: readonly { reasonCode: string }[]
): { reasonCode: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of rejected) counts.set(entry.reasonCode, (counts.get(entry.reasonCode) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reasonCode, count]) => ({ reasonCode, count }))
    .sort((a, b) => b.count - a.count || a.reasonCode.localeCompare(b.reasonCode));
}
