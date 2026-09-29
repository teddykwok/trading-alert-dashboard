import {
  evaluatePreShutdownExchange,
  type PreShutdownCounts,
} from "../binance/pre-shutdown-exchange-check";
import { ROLE_CONTRACTS, type DualRole, type DualVerdict, type RuntimeAccount } from "./dual-account-topology";
import type { Observation } from "./runtime-launcher";
import {
  executeFencedStart,
  executeFencedStop,
  type FencedStartAdapters,
  type OwnedRootRecord,
  type WorkerRestartAdapters,
} from "./worker-supervision";

/**
 * Account-scoped SAFE <-> LIVE-READY runtime transition.
 *
 * ## Why this exists
 *
 * The launcher withdrew LIVE-READY in 11I for three reasons it still prints:
 * the gate file it rewrote was read by no runtime, the gates were
 * process-wide, and its safety check could only see one account. All three
 * were true of the pre-11F single-stack launcher. None is true now: every role
 * is started with its OWN `DOTENV_CONFIG_PATH`, so rewriting `account-a.env`
 * reaches exactly Account A's two processes, and each account's own control
 * plane answers for its own exposure over loopback.
 *
 * That left the operator in a loop -- the launcher said "use Trading Control",
 * and Trading Control said "start the runtime in live-ready mode first" --
 * with no path between them. This module is that path, and nothing more.
 *
 * ## What it is NOT
 *
 * It changes three environment gates for ONE account and restarts that
 * account's two processes. It does not enable a profile, release a profile
 * kill switch, create an authorization or a session, or send a single Binance
 * mutation. `Start Trading` remains a separate, later, separately guarded
 * operator action; this only stops Trading Control refusing on the RUNTIME.
 *
 * Everything here is a function of its inputs. No process is probed, started
 * or terminated, no file is read or written, and no network call is made.
 */

export type RuntimeMode = "SAFE" | "LIVE_READY";

/**
 * The furthest step a transition MAY have performed, in order.
 *
 * Each phase is persisted BEFORE the step it names, never after. A marker that
 * is one step ahead of reality costs a recovery a stop that finds nothing and
 * a gate rewrite that changes nothing; a marker one step BEHIND reality would
 * leave a stopped role with nothing recorded to restart it. Recovery is built
 * to absorb the first and cannot survive the second, so the marker is written
 * early and deliberately over-states.
 *
 * The ordering is the recovery argument. Everything from ENV_WRITTEN onward
 * means the account's file may no longer say SAFE, so an interrupted
 * transition must rewrite it before anything else -- and everything BEFORE it
 * means the file is untouched and only processes need restoring.
 */
export const TRANSITION_PHASES = [
  /** Preconditions passed. Nothing has been mutated yet. */
  "PRECHECKED",
  "WORKER_STOPPED",
  "CONTROL_STOPPED",
  /** The account's env file now names the target mode. THE boundary. */
  "ENV_WRITTEN",
  "CONTROL_STARTED",
  "CONTROL_HEALTHY",
  "WORKER_STARTED",
] as const;

export type TransitionPhase = (typeof TRANSITION_PHASES)[number];

/**
 * The durable marker written BEFORE the first mutation and cleared only after
 * a proven finish.
 *
 * Deliberately carries no credential and no environment contents. The only
 * supported recovery target is SAFE, and `applyGates` can write the three
 * known gate keys without ever having seen the original file -- so persisting
 * it would add a secret-bearing artifact for no recovery value.
 */
export interface PendingTransition {
  readonly account: Exclude<RuntimeAccount, "GENERIC">;
  readonly fromMode: RuntimeMode;
  readonly targetMode: RuntimeMode;
  readonly phase: TransitionPhase;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
}

/** The two roles a transition may ever touch. Generic roles are never here. */
export function rolesForAccount(account: Exclude<RuntimeAccount, "GENERIC">): {
  readonly control: DualRole;
  readonly worker: DualRole;
} {
  return account === "ACCOUNT_A"
    ? { control: "account-a-control", worker: "account-a-worker" }
    : { control: "account-b-control", worker: "account-b-worker" };
}

/**
 * The env alias a transition may rewrite, derived from the ROLE contract.
 *
 * Read from `ROLE_CONTRACTS` rather than built from the account name, so the
 * file this writes and the file the role is started with cannot drift apart.
 */
export function envAliasForAccount(account: Exclude<RuntimeAccount, "GENERIC">): string {
  return ROLE_CONTRACTS[rolesForAccount(account).control].envAlias;
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

/** What the selected account's own control plane reports about itself. */
export interface SelectedAccountState {
  /** null whenever the control plane could not be read. Null always refuses. */
  readonly systemState: string | null;
  readonly profileEnabled: boolean | null;
  readonly profileKillSwitchActive: boolean | null;
  readonly totalActive: number | null;
  readonly pending: number | null;
  readonly open: number | null;
  readonly manualIntervention: number | null;
  /** Operator-facing warning CODES only. Null means unread, which refuses. */
  readonly warnings: readonly string[] | null;
}

export interface TransitionPreconditionInput {
  readonly account: Exclude<RuntimeAccount, "GENERIC">;
  readonly targetMode: RuntimeMode;
  /** The selected account's control-plane report. */
  readonly selected: SelectedAccountState;
  /**
   * The selected account's EXCHANGE flatness, proven by its own account-bound
   * read-only client and returned as counts only. Null when it could not be
   * obtained at all, which refuses.
   */
  readonly exchange: PreShutdownCounts | null;
  /** Ownership of the two selected roles; an unobservable machine refuses. */
  readonly ownership: Observation<{
    readonly controlOwned: boolean;
    readonly workerOwned: boolean;
  }>;
  /** A transition already in flight blocks another one outright. */
  readonly pending: PendingTransition | null;
}

/** Warnings that must never be present when a runtime is about to go live. */
export const BLOCKING_WARNINGS: readonly string[] = [
  "MANUAL_INTERVENTION_REQUIRED",
  "FILLED_WITHOUT_VERIFIED_PROTECTION",
  "INVALID_STATE",
  "STATE_UNKNOWN",
];

/**
 * Whether ONE account may transition right now.
 *
 * Fails closed on every unreadable field: a null is never read as a zero. The
 * exchange proof is required for BOTH directions -- going live because this is
 * the direct precursor to arming, and returning to SAFE because a restart of a
 * runtime holding exposure is the one thing neither mode should do.
 */
export function evaluateTransitionPreconditions(input: TransitionPreconditionInput): DualVerdict {
  const reasons: string[] = [];
  const { selected } = input;

  if (input.pending !== null) {
    reasons.push(
      `An incomplete ${input.pending.account} transition is already recorded (${input.pending.phase}). ` +
        "Recover it to SAFE before starting another."
    );
  }

  // ---- Ownership: an unobservable machine is never acted on ---------------
  if (!input.ownership.ok) {
    reasons.push(
      `The running processes could not be observed (${input.ownership.reason}), so ownership of the ` +
        "selected roles cannot be proven. Nothing was changed."
    );
  } else {
    if (!input.ownership.value.controlOwned) {
      reasons.push("The selected account's control plane is not launcher-owned; this tool only restarts what it started.");
    }
    if (!input.ownership.value.workerOwned) {
      reasons.push("The selected account's execution worker is not launcher-owned; this tool only restarts what it started.");
    }
  }

  // ---- The account's own report -------------------------------------------
  if (selected.systemState === null) {
    reasons.push("The selected account's control plane did not answer; an unread account is never assumed safe.");
  } else if (selected.systemState !== "SAFE_OFF") {
    reasons.push(`The selected account reports ${selected.systemState}; a runtime transition requires SAFE_OFF.`);
  }

  if (selected.profileEnabled === null) reasons.push("The selected profile's enabled state could not be read.");
  else if (selected.profileEnabled) reasons.push("The selected execution profile is ENABLED; disable it before changing the runtime.");

  if (selected.profileKillSwitchActive === null) reasons.push("The selected profile's kill switch state could not be read.");
  else if (!selected.profileKillSwitchActive) {
    reasons.push("The selected profile's kill switch is released; a runtime transition requires it engaged.");
  }

  const exposure: [string, number | null][] = [
    ["active", selected.totalActive],
    ["pending", selected.pending],
    ["open", selected.open],
    ["manual-intervention", selected.manualIntervention],
  ];
  for (const [label, value] of exposure) {
    if (value === null) reasons.push(`The selected account's ${label} count could not be read.`);
    else if (value !== 0) reasons.push(`The selected account reports ${value} ${label} execution(s); it must be zero.`);
  }

  if (selected.warnings === null) {
    reasons.push("The selected account's warnings could not be read.");
  } else {
    for (const code of selected.warnings) {
      if (BLOCKING_WARNINGS.includes(code)) reasons.push(`The selected account reports ${code}.`);
    }
  }

  // ---- Positive exchange proof, from the account's own signed reads --------
  if (input.exchange === null) {
    reasons.push(
      "The selected account's exchange flatness could not be obtained; it is not assumed flat."
    );
  } else {
    const verdict = evaluatePreShutdownExchange(input.exchange);
    if (!verdict.pass) for (const reason of verdict.reasons) reasons.push(`Exchange: ${reason}`);
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ---------------------------------------------------------------------------
// Proving the mode the account is ACTUALLY in
// ---------------------------------------------------------------------------

/** What a set of gate values says, including that it says nothing coherent. */
export type ObservedMode = RuntimeMode | "INVALID";

export type ProvenMode =
  | { readonly ok: true; readonly mode: RuntimeMode }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * The mode an account is in, proven from two independent readings.
 *
 * ## Why this cannot be inferred from the target
 *
 * An earlier draft recorded `fromMode` as "whatever the target is not". That
 * is a guess dressed as a fact, and recovery depends on it: `recoveryPlanFor`
 * asks whether the file may still be non-SAFE, and a guessed SAFE would tell
 * it to leave a LIVE-READY file alone.
 *
 * SAFE_OFF does not prove it either. SAFE_OFF is about the trading PROFILE --
 * disabled, kill switch engaged. The deployment gates are a different thing
 * entirely: a runtime can sit at SAFE_OFF all day with live-entry gates
 * loaded, which is exactly the state this transition produces on purpose.
 *
 * ## Two readings, because they can disagree
 *
 * `disk` is what the account's env file declares; `effective` is what its
 * running control plane reports having LOADED. They disagree whenever someone
 * edited the file without restarting, or a previous transition half-finished.
 * Either reading being unreadable or INVALID refuses, and so does any
 * disagreement -- there is no safe way to pick a winner between them, and an
 * ordinary activation must never proceed from an incoherent runtime.
 */
export function proveCurrentMode(input: {
  readonly disk: ObservedMode | null;
  readonly effective: ObservedMode | null;
}): ProvenMode {
  const reasons: string[] = [];
  if (input.disk === null) reasons.push("The account's environment file could not be read or parsed.");
  else if (input.disk === "INVALID") {
    reasons.push("The account's environment file holds a half-open set of gates that is neither SAFE nor LIVE-READY.");
  }

  if (input.effective === null) {
    reasons.push("The account's running control plane did not report the gates it loaded.");
  } else if (input.effective === "INVALID") {
    reasons.push("The running control plane has loaded a half-open set of gates that is neither SAFE nor LIVE-READY.");
  }

  if (reasons.length > 0) return { ok: false, reasons };
  if (input.disk !== input.effective) {
    reasons.push(
      `The account's file declares ${String(input.disk)} but its running control plane has loaded ` +
        `${String(input.effective)}. The runtime does not match its configuration, so its current mode is not proven.`
    );
    return { ok: false, reasons };
  }
  return { ok: true, mode: input.disk as RuntimeMode };
}

export type ModeDecision =
  | { readonly kind: "PROCEED"; readonly fromMode: RuntimeMode }
  /** The account is already in the requested mode. Nothing to do, and no lie to tell. */
  | { readonly kind: "ALREADY"; readonly mode: RuntimeMode };

/**
 * What to do given a PROVEN current mode and a requested one.
 *
 * Being already in the target is an explicit no-op rather than a transition
 * with an invented `fromMode`. Running the sequence anyway would restart two
 * healthy processes to reach the state they are already in, and would record a
 * marker claiming a direction that was never travelled.
 */
export function decideModeTransition(proven: RuntimeMode, target: RuntimeMode): ModeDecision {
  return proven === target ? { kind: "ALREADY", mode: proven } : { kind: "PROCEED", fromMode: proven };
}

// ---------------------------------------------------------------------------
// Reading one control plane's report, fail-closed
// ---------------------------------------------------------------------------

/**
 * Warning CODES from a control plane's status body, or null.
 *
 * Null for every shape that is not a fully-understood list of codes -- a
 * missing field, a non-array, an entry that is not an object, a code that is
 * not a non-empty string. `evaluateTransitionPreconditions` refuses on null,
 * so the effect of not understanding the field is a refusal.
 *
 * The shape that matters is the FIRST one: `(warnings ?? []).map(...)` turns a
 * field this reader has never seen into a successfully-read empty list, which
 * is the same class of mistake as reading an unobservable process as an absent
 * one. A control plane too old to report warnings, or one whose body was
 * truncated, must not read as "no warnings".
 */
export function warningCodesFromWire(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) return null;
  const codes: string[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const code = (entry as { code?: unknown }).code;
    if (typeof code !== "string" || code.trim() === "") return null;
    codes.push(code);
  }
  return codes;
}

/** A count from a status body, or null when it is not a finite number. */
const numberFromWire = (raw: unknown): number | null =>
  typeof raw === "number" && Number.isFinite(raw) ? raw : null;

const booleanFromWire = (raw: unknown): boolean | null => (typeof raw === "boolean" ? raw : null);

/** Every field unread. What a control plane that did not answer produces. */
export const UNREAD_ACCOUNT_STATE: SelectedAccountState = {
  systemState: null,
  profileEnabled: null,
  profileKillSwitchActive: null,
  totalActive: null,
  pending: null,
  open: null,
  manualIntervention: null,
  warnings: null,
};

/**
 * One control plane's status body, mapped to the decision type.
 *
 * Every field independently fails closed. A body missing a field, or carrying
 * one of the wrong type, leaves that field null -- and every null is a
 * refusal in `evaluateTransitionPreconditions`. Nothing here substitutes a
 * zero, a false or an empty list for something it did not read.
 */
export function selectedAccountStateFromWire(body: unknown): SelectedAccountState {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return UNREAD_ACCOUNT_STATE;
  const status = body as Record<string, unknown>;
  const profile = (status.profile ?? null) as Record<string, unknown> | null;
  const capacity = (status.capacity ?? null) as Record<string, unknown> | null;
  const manual = (status.manualIntervention ?? null) as Record<string, unknown> | null;

  return {
    systemState: typeof status.systemState === "string" ? status.systemState : null,
    profileEnabled: booleanFromWire(profile?.isEnabled),
    profileKillSwitchActive: booleanFromWire(profile?.killSwitchActive),
    totalActive: numberFromWire(capacity?.totalActive),
    pending: numberFromWire(capacity?.pending),
    open: numberFromWire(capacity?.open),
    manualIntervention: numberFromWire(manual?.count),
    warnings: warningCodesFromWire(status.warnings),
  };
}

/** The gates a control plane reports having loaded, as a mode. */
export function effectiveModeFromWire(body: unknown): ObservedMode | null {
  if (body === null || typeof body !== "object") return null;
  const gates = (body as { environmentGates?: unknown }).environmentGates;
  if (gates === null || typeof gates !== "object") return null;
  const read = gates as Record<string, unknown>;
  const triple = [read.globalKillSwitch, read.liveEntryEnabled, read.protectionReady];
  if (!triple.every((value) => typeof value === "boolean")) return null;
  const [kill, live, protection] = triple as boolean[];
  if (kill && !live && !protection) return "SAFE";
  if (!kill && live && protection) return "LIVE_READY";
  return "INVALID";
}

// ---------------------------------------------------------------------------
// The second proof, taken after the human has confirmed
// ---------------------------------------------------------------------------

/** Everything a single gathering of the selected account's facts produces. */
export interface GatheredAccountFacts {
  readonly mode: ProvenMode;
  readonly selected: SelectedAccountState;
  readonly exchange: PreShutdownCounts | null;
  readonly ownership: Observation<{ readonly controlOwned: boolean; readonly workerOwned: boolean }>;
  readonly marker: TransitionMarkerRead;
}

/**
 * Whether the account may still be mutated, given a SECOND reading.
 *
 * ## Why a second reading exists at all
 *
 * The first reading is taken, shown to the operator, and then the operator
 * types an account name. That gap is human-sized -- seconds at best, minutes
 * if they went to check something -- and the facts it was built from are
 * perishable. A position can be opened by hand, an algo order can trigger, a
 * profile can be enabled from the dashboard, another launcher window can start
 * its own transition. Acting on the first reading means acting on what was
 * true before the operator started reading.
 *
 * So the whole proof is retaken and must pass ON ITS OWN, and it must also
 * still describe the SAME runtime: the same proven mode, the same ownership,
 * and still no transition marker. Anything that moved is a refusal, because a
 * fact that changed once during the confirmation can change again during the
 * sequence.
 */
export function evaluateSecondProof(input: {
  readonly account: Exclude<RuntimeAccount, "GENERIC">;
  readonly targetMode: RuntimeMode;
  readonly first: GatheredAccountFacts;
  readonly second: GatheredAccountFacts;
}): DualVerdict {
  const { first, second } = input;
  const reasons: string[] = [];

  // 1. The second reading has to pass everything on its own merits.
  const standalone = evaluateTransitionPreconditions({
    account: input.account,
    targetMode: input.targetMode,
    selected: second.selected,
    exchange: second.exchange,
    ownership: second.ownership,
    pending: second.marker.status === "PENDING" ? second.marker.transition : null,
  });
  if (!standalone.ok) reasons.push(...standalone.reasons);

  // 2. A marker nobody can read appeared, or was there all along.
  if (second.marker.status === "UNREADABLE") {
    reasons.push(`The launcher state became unreadable while waiting for confirmation: ${second.marker.reason}.`);
  }

  // 3. The runtime must still be in the mode the plan was built for.
  if (!second.mode.ok) {
    reasons.push(...second.mode.reasons);
  } else if (!first.mode.ok) {
    reasons.push("The account's mode was not proven before confirmation, so the two readings cannot be compared.");
  } else if (second.mode.mode !== first.mode.mode) {
    reasons.push(
      `The account was ${first.mode.mode} when this was proposed and is ${second.mode.mode} now. ` +
        "Something else changed it; nothing was done."
    );
  }

  // 4. Ownership must not have moved underneath the plan.
  if (first.ownership.ok && second.ownership.ok) {
    const before = first.ownership.value;
    const after = second.ownership.value;
    if (before.controlOwned !== after.controlOwned || before.workerOwned !== after.workerOwned) {
      reasons.push("Launcher ownership of the selected roles changed while waiting for confirmation.");
    }
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/** What an interrupted transition still has to undo to be SAFE again. */
export interface RecoveryPlan {
  /** True when the account's env file may still name a non-SAFE mode. */
  readonly rewriteEnvToSafe: boolean;
  /** Roles that must be stopped (if still owned) and restarted on SAFE gates. */
  readonly restartRoles: readonly DualRole[];
  readonly summary: string;
}

/**
 * What SAFE recovery must do, from the phase AND the direction.
 *
 * The target is ALWAYS SAFE, whatever the interrupted transition was aiming
 * for. Recovering forwards would mean completing an activation nobody is
 * watching; recovering backwards needs only the three gate keys, which is why
 * the marker never has to carry the original file.
 *
 * ## Why the phase alone is not enough
 *
 * The question a recovery has to answer is "may the file still say something
 * other than SAFE?", and the phase only answers that for a run that STARTED
 * from SAFE. An interrupted LIVE-READY -> SAFE run that failed before
 * ENV_WRITTEN never rewrote anything, so the file still says LIVE-READY --
 * and a recovery that read the phase alone would conclude the file was
 * untouched, restart both roles onto live gates, and call that SAFE.
 *
 * So the rule is about the FILE, not the progress:
 *
 *   rewrite SAFE  <=>  the file may not already be SAFE
 *                 <=>  the run started from something other than SAFE,
 *                      OR it got far enough to have rewritten the file.
 *
 * Rewriting SAFE over a file that already says SAFE is a no-op, so the rule
 * errs towards rewriting and never towards assuming.
 *
 * ## Which roles have to come back
 *
 * A role must be restarted when it was stopped by the interrupted run, or when
 * it is still RUNNING on gates that are not SAFE. A run that started from
 * LIVE-READY has both roles on live gates from the very first phase, so both
 * always restart. A run that started from SAFE only has to put back what it
 * actually stopped -- until the file changed, after which the control plane
 * may have come up on the new gates too.
 */
export function recoveryPlanFor(transition: PendingTransition): RecoveryPlan {
  const { control, worker } = rolesForAccount(transition.account);
  const startedFromSafe = transition.fromMode === "SAFE";

  // A run that began anywhere other than SAFE had both roles on non-SAFE gates
  // from its very first phase, so the file and both processes always need
  // returning -- whatever the phase says.
  if (!startedFromSafe) {
    return {
      rewriteEnvToSafe: true,
      restartRoles: [control, worker],
      summary:
        `The account was running ${transition.fromMode} gates, so they are rewritten to SAFE and both ` +
        "roles are restarted on them.",
    };
  }

  switch (transition.phase) {
    case "PRECHECKED":
      return {
        rewriteEnvToSafe: false,
        restartRoles: [],
        summary: "Nothing was mutated; the marker is cleared once SAFE is re-proven.",
      };
    case "WORKER_STOPPED":
      return {
        rewriteEnvToSafe: false,
        restartRoles: [worker],
        summary: "The worker was stopped before any file changed; it is restarted on the unchanged SAFE gates.",
      };
    case "CONTROL_STOPPED":
      return {
        rewriteEnvToSafe: false,
        restartRoles: [control, worker],
        summary: "Both roles were stopped before any file changed; both are restarted on the unchanged SAFE gates.",
      };
    default:
      // ENV_WRITTEN and beyond, from SAFE: the file may now say the target.
      return {
        rewriteEnvToSafe: phaseAtLeast(transition.phase, "ENV_WRITTEN"),
        restartRoles: [control, worker],
        summary:
          "The account's gates were rewritten, so they are returned to SAFE and both roles are restarted on them.",
      };
  }
}

/** The phase order, exposed so a caller cannot invent its own comparison. */
export function phaseAtLeast(phase: TransitionPhase, boundary: TransitionPhase): boolean {
  return TRANSITION_PHASES.indexOf(phase) >= TRANSITION_PHASES.indexOf(boundary);
}


// ---------------------------------------------------------------------------
// The transition sequence
// ---------------------------------------------------------------------------

/**
 * Everything the sequence needs from the machine, injected.
 *
 * `journal` is the durable marker. It is written BEFORE the first process is
 * touched and updated at every boundary, so an interrupted run is recoverable
 * from the file alone rather than from whatever the operator remembers.
 */
export interface TransitionAdapters {
  /** Ownership record for one role, or null when none is recorded. */
  /**
   * The checkout these roles must belong to.
   *
   * Passed explicitly rather than defaulted: `verifyOwnership` resolves it
   * and asks whether a command line contains it, and an empty string is
   * contained by EVERY command line -- which would silently retire the
   * NOT_THIS_REPO check altogether.
   */
  readonly repoRoot: string;
  readonly recordFor: (role: DualRole) => OwnedRootRecord | null;
  /** The fenced machine calls, shared with restart supervision. */
  readonly stop: Pick<WorkerRestartAdapters, "probe" | "terminate" | "log">;
  /** Built per role, so each start censuses and spawns for THAT role only. */
  readonly startFor: (role: DualRole) => FencedStartAdapters;
  /** Atomically persists the phase. Throwing is treated as a hard failure. */
  readonly journal: (phase: TransitionPhase) => void;
  /** Clears the durable marker. Called ONLY after a proven finish. */
  readonly clearJournal: () => void;
  /** Rewrites ONLY the three gates of ONLY the selected account's file. */
  readonly writeGates: (mode: RuntimeMode) => { ok: true } | { ok: false; reason: string };
  /** Proves the selected account now runs the expected gates and is SAFE_OFF. */
  readonly verify: (role: DualRole, mode: RuntimeMode) => Promise<DualVerdict>;
  /**
   * A FRESH ownership check of one role against its durable record.
   *
   * Separate from `verify`, which asks the control plane about itself. This
   * asks the MACHINE whether the process we have a record for is still the
   * process that record describes -- the question that decides whether anyone
   * can safely stop it later. An unobservable machine answers neither yes nor
   * no, and is therefore not a success.
   */
  readonly proveOwned: (role: DualRole) => Observation<boolean>;
  readonly log: (line: string) => void;
}

export type TransitionOutcome =
  | { readonly ok: true; readonly mode: RuntimeMode }
  | {
      readonly ok: false;
      /** RECOVERED means the account was returned to proven SAFE. */
      readonly state: "REFUSED" | "RECOVERED" | "INCOMPLETE";
      readonly phase: TransitionPhase;
      readonly reasons: readonly string[];
    };

/**
 * Everything one run of the engine needs to know about ITS OWN identity.
 *
 * `fromMode` is PROVEN by the caller, never inferred from `targetMode`. It is
 * written into the marker and is what `recoveryPlanFor` reads to decide
 * whether the file may still be non-SAFE, so a guess here becomes a recovery
 * that skips the gate rewrite it needed.
 */
export interface TransitionRun {
  readonly account: Exclude<RuntimeAccount, "GENERIC">;
  readonly fromMode: RuntimeMode;
  readonly targetMode: RuntimeMode;
  /** When this run began, for the marker. */
  readonly startedAtMs: number;
}

/**
 * Moves ONE account between SAFE and LIVE-READY, or leaves it recoverable.
 *
 * ## The order, and why it is this one
 *
 * The account's control plane judges attestation against its OWN loaded gates
 * (`expected: currentProcessGateSnapshot()`), so a control plane on LIVE-READY
 * beside a worker still on SAFE reports a MISMATCH and blocks. Both roles must
 * therefore move, and the worker must be DOWN while the control plane comes up
 * on the new gates -- which is exactly this order:
 *
 *   stop worker -> stop control -> write gates -> start control -> verify
 *   -> start worker -> verify -> PROVE BOTH ROLES OWNED
 *
 * ## What success has to mean
 *
 * All of: both roles freshly proven launcher-owned against their durable
 * records, the target gates proven loaded, the worker's attestation PASS, and
 * the profile still SAFE_OFF. A role that is running but whose ownership
 * cannot be re-proven is a role nobody can safely stop later, so a transition
 * that produced one has not succeeded however healthy it looks.
 *
 * ## What a failure does
 *
 * Once the PRECHECKED marker is durable, EVERY failure goes through SAFE
 * recovery, and the marker survives until either the target or SAFE is
 * proven. Anything after the gate write is rolled back because a half-moved
 * account is the state nobody can reason about; anything before it needs only
 * its processes back -- but both are decided by recovery, not by guessing
 * whether this run happened to cause the problem it found.
 *
 * The only clean refusals are the ones that happen BEFORE that marker exists:
 * the preconditions, the operator cancelling, the second proof, and the
 * marker write itself.
 */
export async function executeAccountTransition(
  input: TransitionRun,
  adapters: TransitionAdapters
): Promise<TransitionOutcome> {
  const { control, worker } = rolesForAccount(input.account);
  let phase: TransitionPhase = "PRECHECKED";

  const markerAt = (at: TransitionPhase): PendingTransition => ({
    account: input.account,
    fromMode: input.fromMode,
    targetMode: input.targetMode,
    phase: at,
    startedAtMs: input.startedAtMs,
    updatedAtMs: input.startedAtMs,
  });

  /** Persists the phase we are ABOUT to perform. False means: do not perform it. */
  const mark = (next: TransitionPhase): boolean => {
    try {
      adapters.journal(next);
      phase = next;
      return true;
    } catch {
      // A step we cannot record is a step recovery would not know to undo.
      adapters.log("transition: the durable marker could not be written — stopping here");
      return false;
    }
  };

  /**
   * Every failure from here on goes through SAFE recovery.
   *
   * There is deliberately no "nothing was mutated, so clear the marker"
   * shortcut. An earlier version tracked whether THIS run had terminated
   * anything and cleared the journal when it had not -- which read a worker
   * that had died on its own as "nothing happened":
   *
   *   the second proof passes, the marker is written, the worker exits by
   *   itself, the fenced stop reports it already GONE, a later step fails,
   *   and the journal is cleared. The worker is now missing and no marker
   *   records that anything was ever in flight.
   *
   * The mistake was scoping the question to what this process CAUSED. Once
   * PRECHECKED is durable, the account's processes and gates can move for any
   * reason, and every later failure is a contradiction discovered after the
   * transition began. None of them is evidence that nothing needs recovering.
   */
  const fail = async (reason: string): Promise<TransitionOutcome> =>
    runRecovery(markerAt(phase), [reason], adapters);

  // Durable BEFORE the first mutation. Everything after this is recoverable,
  // and until it succeeds there is nothing to recover.
  if (!mark("PRECHECKED")) {
    // No marker was written and nothing was touched, so this is a clean
    // refusal. Reporting INCOMPLETE here would tell an operator to go and
    // recover a durable record that does not exist.
    return {
      ok: false,
      state: "REFUSED",
      phase,
      reasons: ["the transition marker could not be written, so nothing was started"],
    };
  }

  // ---- 1. stop the worker --------------------------------------------------
  if (!mark("WORKER_STOPPED")) return fail("the stopped worker could not be recorded");
  const workerStop = executeFencedStop(adapters.recordFor(worker), adapters.repoRoot, adapters.stop);
  if (!workerStop.stopped) {
    return fail(`the execution worker could not be stopped (${workerStop.outcome})`);
  }

  // ---- 2. stop the control plane ------------------------------------------
  if (!mark("CONTROL_STOPPED")) return fail("the stopped control plane could not be recorded");
  const controlStop = executeFencedStop(adapters.recordFor(control), adapters.repoRoot, adapters.stop);
  if (!controlStop.stopped) {
    return fail(`the control plane could not be stopped (${controlStop.outcome})`);
  }

  // ---- 3. the gates, with both roles down ---------------------------------
  if (!mark("ENV_WRITTEN")) return fail("the gate rewrite could not be recorded");
  const written = adapters.writeGates(input.targetMode);
  if (!written.ok) return fail(`the gates could not be written (${written.reason})`);

  // ---- 4. the control plane, then prove it --------------------------------
  if (!mark("CONTROL_STARTED")) return fail("the started control plane could not be recorded");
  const controlStart = executeFencedStart(control, adapters.startFor(control));
  if (!controlStart.started) {
    return fail(`the control plane could not be started (${controlStart.outcome})`);
  }

  if (!mark("CONTROL_HEALTHY")) return fail("the control plane's attestation could not be recorded");
  const controlVerdict = await adapters.verify(control, input.targetMode);
  if (!controlVerdict.ok) return fail(controlVerdict.reasons.join("; "));

  // ---- 5. the worker, then prove the pair ---------------------------------
  if (!mark("WORKER_STARTED")) return fail("the started worker could not be recorded");
  const workerStart = executeFencedStart(worker, adapters.startFor(worker));
  if (!workerStart.started) {
    return fail(`the execution worker could not be started (${workerStart.outcome})`);
  }

  // ---- 6. the FINAL proof, taken fresh ------------------------------------
  //
  // Not a formality. Everything above proves a step at the moment it ran; this
  // proves the account as it stands NOW, after all of them -- which is the
  // only claim clearing the marker actually makes.
  const settled = await proveAccountAt(input.account, input.targetMode, adapters);
  if (!settled.ok) return fail(settled.reasons.join("; "));

  // Proven. The marker may be cleared, and only now.
  try {
    adapters.clearJournal();
  } catch {
    // The target was reached and proven, but the record saying a transition
    // was in flight is still there. Claiming plain success would leave the
    // next action blocked by a marker nobody was told about.
    return {
      ok: false,
      state: "INCOMPLETE",
      phase,
      reasons: [
        `${input.account} reached ${input.targetMode} and was proven, but the transition marker ` +
          "could not be cleared. It still blocks this account until it is recovered.",
      ],
    };
  }
  adapters.log(`transition: ${input.account} is now ${input.targetMode}.`);
  return { ok: true, mode: input.targetMode };
}

/**
 * The single statement of what "this account is in mode X" means.
 *
 * Ownership of BOTH roles, freshly re-proven against their durable records,
 * plus the worker's report -- which carries the loaded gates, the attestation
 * the control plane judges against its own snapshot, and the profile state.
 * Used to end a forward transition and to end a recovery, so success and
 * recovered-success cannot mean two different things.
 */
async function proveAccountAt(
  account: Exclude<RuntimeAccount, "GENERIC">,
  mode: RuntimeMode,
  adapters: TransitionAdapters
): Promise<DualVerdict> {
  const { control, worker } = rolesForAccount(account);
  const reasons: string[] = [];

  for (const role of [control, worker]) {
    const owned = adapters.proveOwned(role);
    if (!owned.ok) {
      reasons.push(`${role}'s ownership could not be observed (${owned.reason}), so it is not proven.`);
    } else if (!owned.value) {
      reasons.push(`${role} is running but is no longer provably launcher-owned.`);
    }
  }

  // The worker leg is the strict one: it requires the attestation the control
  // plane judges against its OWN loaded gates, so it proves the pair agree.
  const verdict = await adapters.verify(worker, mode);
  if (!verdict.ok) reasons.push(...verdict.reasons);

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * Returns ONE account to SAFE, and never claims to have done so unproven.
 *
 * ## The marker rule
 *
 * Once this runs against an existing marker, THAT MARKER MAY ONLY DISAPPEAR
 * AFTER THE ACCOUNT IS PROVEN SAFE. Every other ending -- a refusal, a lost
 * ownership record, an unobservable process, a missing record, an unreadable
 * census, an unexplained leaf, a failed gate write, a failed spawn, a failed
 * attestation -- retains it and reports INCOMPLETE.
 *
 * This is why recovery does not go through the forward engine's clean-refusal
 * path. That path clears the marker when it can prove IT changed nothing,
 * which is right for a brand-new transition and catastrophic for a recovery:
 * the thing it would clear is not its own record of doing nothing, it is the
 * older record of an account that is still half-moved.
 *
 * ## A missing record is a failure here, not an absence
 *
 * In a forward transition, a role with no launcher record simply is not ours.
 * In a recovery it is different: the account is KNOWN to have been mid-
 * transition, so a role the plan expects to restart and has no record for is
 * missing evidence. The census is the only thing that could then tell us
 * whether something is running, and the honest answer is that we do not know.
 *
 * ## Write-ahead, monotonically
 *
 * Recovery's own steps are journalled before they happen, and the phase only
 * ever moves FORWARD. A recovery interrupted after rewriting the gates or
 * stopping the control plane leaves a marker whose plan still covers what it
 * did, so the next attempt finishes the job instead of restarting a role it
 * already put back -- or worse, leaving one down.
 */
export async function executeTransitionRecovery(
  marker: PendingTransition,
  adapters: TransitionAdapters
): Promise<TransitionOutcome> {
  return runRecovery(marker, [], adapters);
}

async function runRecovery(
  marker: PendingTransition,
  because: readonly string[],
  adapters: TransitionAdapters
): Promise<TransitionOutcome> {
  const safeMode: RuntimeMode = "SAFE";
  const { control, worker } = rolesForAccount(marker.account);
  const plan = recoveryPlanFor(marker);
  let phase = marker.phase;

  const incomplete = (...extra: string[]): TransitionOutcome => ({
    ok: false,
    state: "INCOMPLETE",
    phase,
    reasons: [...because, ...extra],
  });

  adapters.log(`transition: returning ${marker.account} to SAFE — ${plan.summary}`);

  /**
   * Moves the marker forward, never backward, before a step that would
   * invalidate the current plan. A phase we cannot persist is a step we do not
   * take.
   */
  const escalate = (to: TransitionPhase): boolean => {
    if (phaseAtLeast(phase, to)) return true;
    try {
      adapters.journal(to);
      phase = to;
      return true;
    } catch {
      adapters.log("transition: recovery could not record its next step — stopping here");
      return false;
    }
  };

  if (plan.rewriteEnvToSafe) {
    if (!escalate("ENV_WRITTEN")) return incomplete("the recovery's gate rewrite could not be recorded");
    const written = adapters.writeGates(safeMode);
    if (!written.ok) return incomplete(`the SAFE gates could not be restored: ${written.reason}`);
  }

  // Stop ONLY the roles that must come back on SAFE gates. A role the plan
  // does not name was never touched and is still running the gates it started
  // with, so killing it would be damage recovery invented.
  for (const role of [worker, control].filter((candidate) => plan.restartRoles.includes(candidate))) {
    if (!escalate(role === worker ? "WORKER_STOPPED" : "CONTROL_STOPPED")) {
      return incomplete(`the recovery's stop of ${role} could not be recorded`);
    }
    const stop = executeFencedStop(adapters.recordFor(role), adapters.repoRoot, adapters.stop);
    if (!stop.stopped) {
      return incomplete(`${role} could not be stopped during recovery (${stop.outcome})`);
    }
  }

  // Control plane first, then the worker: the same order, for the same reason,
  // as the forward path.
  for (const role of plan.restartRoles) {
    const started = executeFencedStart(role, adapters.startFor(role));
    if (!started.started) {
      return incomplete(`${role} could not be restarted during recovery (${started.outcome})`);
    }
    const verdict = await adapters.verify(role, safeMode);
    if (!verdict.ok) return incomplete(...verdict.reasons);
  }

  // The SAME proof a forward transition ends on, so RECOVERED and SUCCEEDED
  // are claims of equal strength. It runs even when the plan did nothing:
  // "nothing needed undoing" is a conclusion that still has to be checked.
  const settled = await proveAccountAt(marker.account, safeMode, adapters);
  if (!settled.ok) return incomplete(...settled.reasons);

  // The marker is cleared ONLY here, with SAFE re-proven.
  try {
    adapters.clearJournal();
  } catch {
    return incomplete("SAFE was re-proven, but the transition marker could not be cleared.");
  }
  return { ok: false, state: "RECOVERED", phase, reasons: [...because] };
}


// ---------------------------------------------------------------------------
// The durable marker, as a parsing and gating decision
// ---------------------------------------------------------------------------

/**
 * What the launcher's state file says about an in-flight transition.
 *
 * Three outcomes, and the third is the reason this type exists. "There is no
 * marker" and "there is a marker I cannot understand" are opposite facts: the
 * first means the runtime is in a state someone chose, the second means it may
 * be half-way between two and nobody knows which. Collapsing them into `null`
 * -- which is what a `try { JSON.parse } catch { return null }` reader does --
 * would hand an interrupted transition straight back to Start SAFE.
 */
export type TransitionMarkerRead =
  | { readonly status: "NONE" }
  | { readonly status: "PENDING"; readonly transition: PendingTransition }
  | { readonly status: "UNREADABLE"; readonly reason: string };

const isPhase = (value: unknown): value is TransitionPhase =>
  typeof value === "string" && (TRANSITION_PHASES as readonly string[]).includes(value);

const isMode = (value: unknown): value is RuntimeMode => value === "SAFE" || value === "LIVE_READY";

const isAccount = (value: unknown): value is Exclude<RuntimeAccount, "GENERIC"> =>
  value === "ACCOUNT_A" || value === "ACCOUNT_B";

const isInstant = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Reads the `transition` field of a parsed launcher state.
 *
 * ABSENT is a proven absence: a launcher state written before this feature
 * existed has no such field, and that is not a corrupt marker -- it is a
 * runtime that was never mid-transition. Every OTHER disagreement with the
 * shape is UNREADABLE, including a field that is present but null-ish, the
 * wrong type, or missing any single component. A marker is a safety record;
 * one we only half understand is one we do not have.
 */
export function parseTransitionMarker(raw: unknown): TransitionMarkerRead {
  if (raw === undefined) return { status: "NONE" };
  // An explicit null is how a completed transition clears itself.
  if (raw === null) return { status: "NONE" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { status: "UNREADABLE", reason: "the transition marker is not an object" };
  }

  const candidate = raw as Record<string, unknown>;
  const missing: string[] = [];
  if (!isAccount(candidate.account)) missing.push("account");
  if (!isMode(candidate.fromMode)) missing.push("fromMode");
  if (!isMode(candidate.targetMode)) missing.push("targetMode");
  if (!isPhase(candidate.phase)) missing.push("phase");
  if (!isInstant(candidate.startedAtMs)) missing.push("startedAtMs");
  if (!isInstant(candidate.updatedAtMs)) missing.push("updatedAtMs");
  if (missing.length > 0) {
    return {
      status: "UNREADABLE",
      reason: `the transition marker is missing or malformed: ${missing.join(", ")}`,
    };
  }

  return {
    status: "PENDING",
    transition: {
      account: candidate.account as Exclude<RuntimeAccount, "GENERIC">,
      fromMode: candidate.fromMode as RuntimeMode,
      targetMode: candidate.targetMode as RuntimeMode,
      phase: candidate.phase as TransitionPhase,
      startedAtMs: candidate.startedAtMs as number,
      updatedAtMs: candidate.updatedAtMs as number,
    },
  };
}

/**
 * Whether an action that touches these roles may proceed.
 *
 * A pending transition fences ONLY its own account's two roles. Account B's
 * worker is not made unsafe by Account A being mid-transition, and blocking it
 * would punish the account that is fine -- the same account-isolation rule the
 * rest of this module keeps. A marker nobody can read fences EVERYTHING,
 * because the one thing it does not tell us is which account it was about.
 */
export function evaluateTransitionGate(
  read: TransitionMarkerRead,
  roles: readonly DualRole[]
): DualVerdict {
  if (read.status === "NONE") return { ok: true };
  if (read.status === "UNREADABLE") {
    return {
      ok: false,
      reasons: [
        `${read.reason}.`,
        "A marker that cannot be read cannot be ruled out, and it does not say which account it was about.",
        "Run the return-to-SAFE recovery before starting, stopping or supervising anything.",
      ],
    };
  }

  const fenced = rolesForAccount(read.transition.account);
  const touched = roles.filter((role) => role === fenced.control || role === fenced.worker);
  if (touched.length === 0) return { ok: true };

  return {
    ok: false,
    reasons: [
      `${read.transition.account} has an INCOMPLETE runtime transition ` +
        `(${read.transition.fromMode} -> ${read.transition.targetMode}, reached ${read.transition.phase}).`,
      "Its gates and its two processes may not agree, so it is not safe to start, stop or supervise them.",
      `Run the return-to-SAFE recovery for ${read.transition.account} first.`,
    ],
  };
}

export type SupervisedRestartGate =
  | { readonly act: "RESTART" }
  | {
      readonly act: "REFUSE";
      /**
       * Always false. A refusal here means nothing was tried, so charging the
       * restart budget for it would walk a healthy account towards
       * WORKER_RECOVERY_FAILED while a transition was simply in flight.
       */
      readonly spendAttempt: false;
      readonly reasons: readonly string[];
    };

/**
 * Whether a supervision tick may restart, given a FRESH marker read.
 *
 * ## Why the check at supervisor startup is not enough
 *
 * A supervisor runs for hours. It checks the marker once when an operator
 * starts it, and the world moves afterwards:
 *
 *   the supervisor starts with no marker; another launcher begins a transition
 *   on the account it is watching; that launcher crashes half-way, leaving
 *   PENDING; the OS releases the mutation mutex on its death; this supervisor
 *   later decides the worker needs restarting, takes the mutex, and restarts a
 *   role belonging to a transition nobody finished.
 *
 * The mutex makes that sequence safe from CONCURRENCY and does nothing about
 * it being wrong. So the marker is read again inside the locked body, and it
 * is that reading -- not the one at startup -- that has authority.
 *
 * Account isolation is unchanged: a marker for the OTHER account does not
 * fence this one, and a marker nobody can read fences everything, including
 * the generic role.
 */
export function judgeSupervisedRestart(
  marker: TransitionMarkerRead,
  roles: readonly DualRole[]
): SupervisedRestartGate {
  const verdict = evaluateTransitionGate(marker, roles);
  if (verdict.ok) return { act: "RESTART" };
  return {
    act: "REFUSE",
    spendAttempt: false,
    reasons: [...verdict.reasons, "No process was stopped or started, and no restart attempt was spent."],
  };
}

/**
 * The operator-facing summary of a pending transition.
 *
 * Phase, direction and age. No env contents, no credential, no port, no pid --
 * a marker exists to say what was happening, not to describe the account.
 */
export function describePendingTransition(transition: PendingTransition, nowMs: number): string[] {
  const ageSeconds = Math.max(0, Math.floor((nowMs - transition.updatedAtMs) / 1000));
  return [
    `account        = ${transition.account}`,
    `direction      = ${transition.fromMode} -> ${transition.targetMode}`,
    `furthest step  = ${transition.phase}`,
    `last updated   = ${ageSeconds}s ago`,
    `recovery       = return this account to SAFE, then the marker clears`,
  ];
}
