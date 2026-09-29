import {
  verifyOwnership,
  type LauncherRole,
  type OwnedProcess,
  type OwnershipVerdict,
  type ProcessProbe,
  type RoleHealth,
  type RuntimeState,
} from "./runtime-launcher";

/**
 * Worker supervision — pure core.
 *
 * ## The incident this exists for
 *
 * On 2026-08-26 the worker stopped between 13:58:01 and 13:59:06 and never
 * came back. The backend stayed alive for two more days and kept accepting
 * alerts, so 2494 of them piled up in RECEIVED with nothing consuming the
 * queue, while four PROTECTED executions went unreconciled.
 *
 * The reconciliation code was never the problem — a restart repairs that state
 * correctly, which is proven by `protection-outage-restart.test.ts`. The
 * problem is that nothing restarted the worker.
 *
 * ## Why the supervisor cannot live in the worker
 *
 * The existing health signal, `isReconciliationHealthy`, is consumed only by
 * the worker's own attestation publisher. That is detection, and detection
 * inside the patient is worthless once the patient is dead: a process that has
 * exited cannot notice that it exited. Every function here is therefore
 * designed to be driven by the LAUNCHER, which already owns the process
 * records and already runs outside all three roles.
 *
 * ## What this module is, and is not
 *
 * It is infrastructure recovery, NOT operator authorization. It restarts one
 * role using the mode the launcher already recorded. It cannot create or renew
 * a natural window, cannot change `maxClaims`, cannot refund a claim, cannot
 * clear a kill switch and cannot write a deployment gate. Those are all
 * separate, confirmed, audited actions elsewhere, and a worker coming back must
 * never be mistaken for a human deciding to trade. There is deliberately no
 * import from any execution or authorization module, and a test pins that.
 *
 * Everything here is a function of its inputs: no process is probed, started or
 * killed. The CLI supplies the adapters that do those things, which is what
 * makes the safety-sensitive decisions testable without a machine.
 */

// ---------------------------------------------------------------------------
// Restart policy
// ---------------------------------------------------------------------------

/**
 * How many restarts may be attempted before the supervisor gives up.
 *
 * Matches the repo's existing bounded-retry convention (`binance.client.ts`
 * uses 1 initial + 2 bounded retries). A worker that has failed three times in
 * a row is not failing transiently, and a fourth restart would be a crash loop
 * dressed up as recovery.
 */
export const WORKER_RESTART_MAX_ATTEMPTS = 3;

/**
 * Backoff base and ceiling, in the same `BASE * 2^(n-1)` shape as
 * `binance.client.ts`'s `backoffDelayMs`.
 *
 * 5s / 10s / 20s across the three attempts. The base is one heartbeat interval
 * (`RUNTIME_ATTESTATION_HEARTBEAT_MS`), which is the shortest delay that can
 * produce any new evidence at all; the ceiling exists so a future increase in
 * the attempt budget cannot silently turn into a multi-hour wait.
 */
export const WORKER_RESTART_BASE_BACKOFF_MS = 5_000;
export const WORKER_RESTART_MAX_BACKOFF_MS = 60_000;

/**
 * How long a freshly spawned worker is left alone before its health is judged.
 *
 * A cold `tsx watch` start has to compile before it publishes anything, and the
 * attestation TTL is 15s on a 5s heartbeat. The launcher's own post-start
 * verification already waits up to 30s for a runtime to attest, so judging a
 * new worker before then would mean restarting processes that were merely
 * still starting — the classic way a supervisor becomes the outage.
 */
export const WORKER_RESTART_STABILIZATION_MS = 45_000;

/**
 * How long the worker must stay continuously HEALTHY before the attempt
 * counter is forgiven.
 *
 * Ten minutes. Short enough that a genuinely recovered runtime regains its full
 * budget within one operator coffee break; long enough that a worker which
 * flaps healthy-for-30-seconds between crashes never earns its attempts back
 * and still trips the crash-loop bound.
 */
export const WORKER_RESTART_HEALTHY_RESET_MS = 10 * 60_000;

/**
 * How often a supervision pass runs.
 *
 * Two heartbeat intervals. Fast enough that a dead worker is noticed in
 * seconds rather than the hours the Aug 26 outage ran for, slow enough that the
 * pass — which costs one PowerShell process probe and one Redis read — is not
 * itself a load source.
 */
export const WORKER_SUPERVISION_INTERVAL_MS = 10_000;

/** The backoff component for attempt `attempt` (1-based). */
export function workerRestartBackoffMs(attempt: number): number {
  if (attempt <= 1) return WORKER_RESTART_BASE_BACKOFF_MS;
  return Math.min(WORKER_RESTART_BASE_BACKOFF_MS * 2 ** (attempt - 1), WORKER_RESTART_MAX_BACKOFF_MS);
}

/**
 * The total quiet period after an attempt, before attempt `attempt` may run.
 *
 * The two constants COMPOSE rather than compete, and getting that wrong is easy:
 * written as `max(stabilization, backoff)` the backoff would be dead code here,
 * because the stabilization window is deliberately longer than any early
 * backoff and would always win. Then a crash-looping worker would be retried on
 * a flat 45s cadence and the escalation would exist only on paper.
 *
 * Read as a sequence instead, each part answers its own question:
 *
 *   stabilization — "has it had a fair chance to come up yet?"  (45s)
 *   backoff       — "it did not; how long before trying again?" (5s, 10s, 20s)
 *
 * So attempt 2 waits 55s and attempt 3 waits 65s, and both constants are
 * load-bearing.
 */
export function workerRestartQuietPeriodMs(attempt: number): number {
  return WORKER_RESTART_STABILIZATION_MS + workerRestartBackoffMs(attempt);
}

// ---------------------------------------------------------------------------
// Restart accounting
// ---------------------------------------------------------------------------

export interface RestartBudget {
  /** Restarts attempted since the last forgiveness. */
  attempts: number;
  /** When the most recent restart was attempted. */
  lastAttemptAtMs: number | null;
  /** Start of the current uninterrupted HEALTHY streak. */
  healthySinceMs: number | null;
}

export const EMPTY_RESTART_BUDGET: RestartBudget = Object.freeze({
  attempts: 0,
  lastAttemptAtMs: null,
  healthySinceMs: null,
});

/**
 * Folds one health observation into the budget.
 *
 * Anything other than HEALTHY breaks the streak outright. A worker that is
 * merely "not currently failing" has not earned anything back — only sustained
 * health does, which is what stops a flapping worker from resetting its own
 * crash-loop bound every time it briefly comes up.
 */
export function observeWorkerHealth(
  budget: RestartBudget,
  health: RoleHealth,
  nowMs: number
): RestartBudget {
  if (health !== "HEALTHY") {
    return { ...budget, healthySinceMs: null };
  }
  const healthySinceMs = budget.healthySinceMs ?? nowMs;
  if (nowMs - healthySinceMs >= WORKER_RESTART_HEALTHY_RESET_MS) {
    return { attempts: 0, lastAttemptAtMs: null, healthySinceMs };
  }
  return { ...budget, healthySinceMs };
}

/** Records that an attempt was just made. */
export function recordRestartAttempt(budget: RestartBudget, nowMs: number): RestartBudget {
  return { attempts: budget.attempts + 1, lastAttemptAtMs: nowMs, healthySinceMs: null };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * What an operator is told about the worker.
 *
 * The first two mirror what `judgeRoleHealth` already observes; the last three
 * are SUPERVISION states, which no existing surface could express because
 * nothing used to act on a dead worker.
 */
export type WorkerSupervisionState =
  | "WORKER_HEALTHY"
  | "WORKER_STALE"
  | "WORKER_RESTARTING"
  | "WORKER_DEGRADED"
  | "WORKER_RECOVERY_FAILED";

export type SupervisionReasonCode =
  | "HEALTHY"
  | "NO_RUNTIME_RECORDED"
  | "NO_WORKER_RECORDED"
  | "BACKEND_NOT_HEALTHY"
  | "OWNERSHIP_UNPROVEN"
  | "HEALTH_UNKNOWN"
  | "WORKER_DUPLICATE"
  | "STABILIZING"
  | "BACKOFF_PENDING"
  | "RESTART_BUDGET_EXHAUSTED"
  | "WORKER_EXITED"
  | "WORKER_STALE"
  | "INCONSISTENT_OBSERVATION";

export type SupervisionAction = "NONE" | "RESTART" | "TERMINATE_THEN_RESTART";

export interface SupervisionDecision {
  action: SupervisionAction;
  state: WorkerSupervisionState;
  reasonCode: SupervisionReasonCode;
  /** Operator-facing sentence. Never contains a secret, a path or a URL. */
  message: string;
  /** The owned worker PID that must be terminated first, when applicable. */
  terminatePid: number | null;
}

export interface WorkerSupervisionInput {
  /** The launcher's recorded worker process, or null when none is recorded. */
  record: OwnedProcess | null;
  /** Ownership verdict for that record; null when there is no record. */
  ownership: OwnershipVerdict | null;
  /** `judgeRoleHealth` for the worker. */
  workerHealth: RoleHealth;
  /** `judgeRoleHealth` for the backend. */
  backendHealth: RoleHealth;
  budget: RestartBudget;
  nowMs: number;
  /** True when the launcher has no runtime state file at all. */
  hasRuntimeState: boolean;
}

const decide = (
  action: SupervisionAction,
  state: WorkerSupervisionState,
  reasonCode: SupervisionReasonCode,
  message: string,
  terminatePid: number | null = null
): SupervisionDecision => ({ action, state, reasonCode, message, terminatePid });

/**
 * Decides what, if anything, to do about the worker.
 *
 * The ordering is the safety argument, so it is written as one flat sequence
 * rather than nested conditions. Every branch that could END with a process
 * being killed or spawned sits BELOW every branch that fails closed, so a new
 * check added at the top can only ever make the supervisor more cautious.
 */
export function decideWorkerSupervision(input: WorkerSupervisionInput): SupervisionDecision {
  // ---- 1. Is there anything to supervise at all? -------------------------
  // No state file means the launcher is not managing a stack on this machine.
  // Supervision has no ownership to reason about and must invent none.
  if (!input.hasRuntimeState) {
    return decide(
      "NONE",
      "WORKER_DEGRADED",
      "NO_RUNTIME_RECORDED",
      "No launcher-owned runtime is recorded, so there is no worker to supervise."
    );
  }
  if (!input.record || !input.ownership) {
    return decide(
      "NONE",
      "WORKER_DEGRADED",
      "NO_WORKER_RECORDED",
      "The recorded runtime has no worker process, so supervision has nothing it can prove ownership of."
    );
  }

  // ---- 2. Healthy: the overwhelmingly common case ------------------------
  if (input.workerHealth === "HEALTHY") {
    return decide("NONE", "WORKER_HEALTHY", "HEALTHY", "The worker is running and attesting.");
  }

  // ---- 3. Fail-closed observations ---------------------------------------
  // Each of these means we cannot PROVE what is going on, and the response to
  // an unproven state is never to kill or spawn.

  if (input.workerHealth === "DUPLICATE") {
    // More than one fresh worker is already attesting. Spawning a third is the
    // exact opposite of what this situation needs, and terminating one would
    // mean choosing between processes we cannot tell apart.
    return decide(
      "NONE",
      "WORKER_DEGRADED",
      "WORKER_DUPLICATE",
      "More than one worker is attesting. Supervision will not add or remove one; resolve the duplicate runtime first."
    );
  }

  if (input.workerHealth === "UNKNOWN") {
    // Attestation could not be read — typically Redis. That is indistinguishable
    // from a silent worker by count alone, so it is never treated as proof of
    // one.
    return decide(
      "NONE",
      "WORKER_DEGRADED",
      "HEALTH_UNKNOWN",
      "Worker health could not be read, so a stall cannot be distinguished from an unreadable heartbeat. Nothing was restarted."
    );
  }

  if (!input.ownership.owned && input.ownership.reason !== "GONE") {
    // PID_REUSED or NOT_THIS_REPO. The recorded PID may now belong to somebody
    // else's program, so it is reported and left alone — and no replacement is
    // started either, because the state that would justify one is exactly the
    // state we just failed to establish.
    return decide(
      "NONE",
      "WORKER_DEGRADED",
      "OWNERSHIP_UNPROVEN",
      `The recorded worker PID could not be proven to be ours (${input.ownership.reason}). Nothing was terminated and nothing was started.`
    );
  }

  // A worker-only repair is only safe over an otherwise intact stack. If the
  // backend is not healthy the fault is not worker-shaped, and restarting the
  // worker alone would produce a partial runtime that looks recovered.
  if (input.backendHealth !== "HEALTHY") {
    return decide(
      "NONE",
      "WORKER_DEGRADED",
      "BACKEND_NOT_HEALTHY",
      `The backend is ${input.backendHealth}, so this is not a worker-only failure. Supervision will not repair half a runtime; use the launcher's Stop and Start controls.`
    );
  }

  // ---- 4. Timing gates ----------------------------------------------------
  const sinceAttempt =
    input.budget.lastAttemptAtMs === null ? null : input.nowMs - input.budget.lastAttemptAtMs;

  if (sinceAttempt !== null && sinceAttempt < WORKER_RESTART_STABILIZATION_MS) {
    return decide(
      "NONE",
      "WORKER_RESTARTING",
      "STABILIZING",
      "A worker was restarted moments ago and is still starting; its health is not judged yet."
    );
  }

  if (input.budget.attempts >= WORKER_RESTART_MAX_ATTEMPTS) {
    return decide(
      "NONE",
      "WORKER_RECOVERY_FAILED",
      "RESTART_BUDGET_EXHAUSTED",
      `The worker failed to stay healthy across ${WORKER_RESTART_MAX_ATTEMPTS} restart attempts. Automatic recovery has stopped; operator intervention is required.`
    );
  }

  if (sinceAttempt !== null && sinceAttempt < workerRestartQuietPeriodMs(input.budget.attempts + 1)) {
    return decide(
      "NONE",
      "WORKER_RESTARTING",
      "BACKOFF_PENDING",
      "The worker did not come back within its stabilization window; waiting out the restart backoff before trying again."
    );
  }

  // ---- 5. Act -------------------------------------------------------------
  if (!input.ownership.owned && input.ownership.reason === "GONE") {
    // CASE A: the process is simply gone. Nothing to terminate.
    return decide(
      "RESTART",
      "WORKER_RESTARTING",
      "WORKER_EXITED",
      "The worker process is gone. Starting exactly one replacement in the recorded deployment mode."
    );
  }

  if (input.ownership.owned && input.workerHealth === "STALE") {
    // CASE B: the process exists and is provably ours, but has stopped
    // attesting. It must EXIT before a replacement starts, or the runtime ends
    // up with two workers — which the arming interlock reads as DUPLICATE and
    // refuses anyway.
    return decide(
      "TERMINATE_THEN_RESTART",
      "WORKER_STALE",
      "WORKER_STALE",
      "The worker is running but not attesting. Stopping the owned process first, then starting exactly one replacement.",
      input.record.pid
    );
  }

  // Ownership and health disagree in a way this function does not model.
  // Refusing is the only safe reading of a contradiction.
  return decide(
    "NONE",
    "WORKER_DEGRADED",
    "INCONSISTENT_OBSERVATION",
    "Worker ownership and worker health disagree. Nothing was changed."
  );
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** The side effects a restart needs. Injected, so this stays testable. */
/**
 * What ONE ownership probe found.
 *
 * `{ observed: true, process: null }` is "the OS answered, and that pid is not
 * running" -- proven absence, which `verifyOwnership` reads as GONE.
 * `{ observed: false }` is "the OS could not be asked", which proves nothing
 * and must never reach `verifyOwnership` at all.
 */
export type ProbeOutcome =
  | { readonly observed: true; readonly process: ProcessProbe | null }
  | { readonly observed: false };

export interface WorkerRestartAdapters {
  probe(pid: number): ProbeOutcome;
  /** taskkill /T on ONE verified repo-owned root. */
  terminate(pid: number): boolean;
  /**
   * A FRESH count of runtime leaves this spawn could duplicate, minus the
   * ones already explained by other launcher-owned records.
   *
   * Taken immediately before the spawn, never reused from the decision. The
   * decision's census is older than the kill that followed it, and an
   * externally started runtime that appeared in between is exactly the thing
   * a replacement must not be added on top of.
   *
   * Zero means nothing unexplained is running and the spawn is the only one.
   * Null means the census could not be read, which is not evidence of
   * absence and is therefore refused.
   */
  unaccountedLeaves(): number | null;
  /** Spawns exactly one worker in the recorded mode. Returns its PID. */
  spawnWorker(): number | null;
  log(line: string): void;
}

export type WorkerRestartOutcome =
  | "RESTARTED"
  | "TERMINATION_FAILED"
  | "SPAWN_FAILED"
  | "OWNERSHIP_LOST"
  /** A runtime this spawn could duplicate is already running. */
  | "DUPLICATE_PRESENT"
  /** A required process observation could not be made at all. */
  | "OBSERVATION_UNAVAILABLE"
  /** The pre-spawn census could not be read, so absence is unproven. */
  | "CENSUS_UNAVAILABLE"
  /** A process was started, but its identity could not be recorded provably. */
  | "OWNERSHIP_UNPROVEN"
  | "NOT_ATTEMPTED";

export interface WorkerRestartResult {
  outcome: WorkerRestartOutcome;
  oldPid: number | null;
  newPid: number | null;
  /** The replacement record to merge into runtime state, when one started. */
  record: OwnedProcess | null;
}

/**
 * A launcher-recorded root, as the fenced primitives need to see it.
 *
 * Structural rather than `OwnedProcess`, so both the legacy single-stack state
 * and the dual-account state satisfy it without either knowing the other's
 * role vocabulary.
 */
export interface OwnedRootRecord {
  readonly role: string;
  readonly pid: number;
  readonly startedAtMs: number;
}

export type FencedStopOutcome =
  | { readonly stopped: true; readonly alreadyGone: boolean }
  | {
      readonly stopped: false;
      readonly outcome: "NOT_RECORDED" | "OWNERSHIP_LOST" | "OBSERVATION_UNAVAILABLE" | "TERMINATION_FAILED";
      readonly reason: string;
    };

/**
 * FENCED STOP. Terminates one launcher-owned tree, or refuses.
 *
 * ## Why stopping is its own operation
 *
 * A restart couples a stop to a spawn, which is right when a role must come
 * straight back. An account runtime transition must NOT: it stops the worker
 * and the control plane, rewrites their gates, and only then starts them --
 * respawning either on the OLD gates in between would defeat the transition
 * entirely. Splitting the sequence, rather than writing a second one, is what
 * stops two safety implementations existing.
 *
 * Success means the tree is CONFIRMED gone, by a second observation. A kill
 * that returned is not a kill that worked.
 */
export function executeFencedStop(
  record: OwnedRootRecord | null,
  repoRoot: string,
  adapters: Pick<WorkerRestartAdapters, "probe" | "terminate" | "log">
): FencedStopOutcome {
  if (!record) {
    adapters.log("fenced stop: no launcher record for that role — nothing was stopped");
    return { stopped: false, outcome: "NOT_RECORDED", reason: "no launcher record" };
  }
  const { pid } = record;

  // A probe that could not be MADE is not a probe that found nothing.
  const beforeProbe = adapters.probe(pid);
  if (!beforeProbe.observed) {
    adapters.log(`fenced stop: pid ${pid} could not be observed — NOT terminated`);
    return { stopped: false, outcome: "OBSERVATION_UNAVAILABLE", reason: "process observation unavailable" };
  }

  const before = verifyOwnership(record, beforeProbe.process, repoRoot);
  if (!before.owned) {
    if (before.reason === "GONE") {
      adapters.log(`fenced stop: pid ${pid} had already exited`);
      return { stopped: true, alreadyGone: true };
    }
    adapters.log(`fenced stop: pid ${pid} is no longer provably ours (${before.reason}) — NOT terminated`);
    return { stopped: false, outcome: "OWNERSHIP_LOST", reason: before.reason };
  }

  adapters.terminate(pid);

  // Trust the re-probe, never the exit code.
  const afterProbe = adapters.probe(pid);
  if (!afterProbe.observed) {
    adapters.log(`fenced stop: pid ${pid} was signalled but could not be observed afterwards`);
    return { stopped: false, outcome: "OBSERVATION_UNAVAILABLE", reason: "post-kill observation unavailable" };
  }
  if (verifyOwnership(record, afterProbe.process, repoRoot).owned) {
    adapters.log(`fenced stop: pid ${pid} could NOT be stopped`);
    return { stopped: false, outcome: "TERMINATION_FAILED", reason: "the tree is still running" };
  }
  adapters.log(`fenced stop: pid ${pid} stopped`);
  return { stopped: true, alreadyGone: false };
}

export type FencedStartOutcome =
  | { readonly started: true; readonly pid: number; readonly startedAtMs: number }
  | {
      readonly started: false;
      readonly outcome: "CENSUS_UNAVAILABLE" | "DUPLICATE_PRESENT" | "SPAWN_FAILED";
      readonly reason: string;
    }
  | {
      /**
       * A process WAS started and may well be healthy, but its creation time
       * could not be read, so no record of it can ever be ownership-verified.
       *
       * Carries the pid so a caller can report it. Deliberately NOT `started:
       * true`: a role whose ownership cannot be proven must not count towards
       * a successful transition, and deliberately not a reason to kill it
       * either -- an unproven process is unproven in both directions.
       */
      readonly started: false;
      readonly outcome: "OWNERSHIP_UNPROVEN";
      readonly pid: number;
      readonly reason: string;
    };

export type FencedStartAdapters = Pick<
  WorkerRestartAdapters,
  "probe" | "unaccountedLeaves" | "spawnWorker" | "log"
> & {
  /** Persists the new root. Called the instant a pid exists. */
  recordOwnership?: (pid: number, startedAtMs: number) => void;
};

/**
 * How many times a fresh spawn's creation time is asked for before giving up.
 *
 * Bounded, and small. The creation time exists the moment the process does, so
 * a miss is a failure of the PROBE rather than of the process -- worth one or
 * two retries because a probe is a separate round-trip that can fail on its
 * own, and worth no more than that because a probe that fails three times is
 * not going to succeed on the fourth.
 */
export const OWNERSHIP_PROOF_ATTEMPTS = 3;

/**
 * FENCED START. Spawns exactly one replacement, or refuses.
 *
 * The census is taken HERE, immediately before the spawn, never inherited from
 * a decision taken earlier: between a decision and a spawn a tree gets killed,
 * and an externally started runtime can appear in that window. An unreadable
 * census refuses, because it is not evidence of absence.
 *
 * `recordOwnership` runs the instant a pid exists, so the window in which a
 * spawned process has no durable owner is one synchronous call. It cannot be
 * closed entirely -- a crash between spawn and record is possible -- and
 * recovery must treat that as UNKNOWN rather than assume either outcome.
 *
 * ## A spawn without a provable identity is not a success
 *
 * A record needs a creation time: `verifyOwnership` compares it against the
 * live process, and that comparison is the only thing standing between "our
 * worker" and "whatever reused that pid". A record written with a zero
 * creation time can never be verified, so treating such a spawn as success
 * would let a transition finish and clear its marker while leaving a role
 * nobody can subsequently prove they own -- and therefore nobody can safely
 * stop.
 *
 * So the creation time is asked for a bounded number of times, and when it
 * still cannot be read the outcome is OWNERSHIP_UNPROVEN. The pid is recorded
 * anyway, because an operator needs to see it, but with a creation time that
 * fails verification -- which keeps the process counted as an UNEXPLAINED LEAF
 * by the census. That is deliberate: it is the thing that stops anyone
 * spawning beside it. It is not killed, because an unproven process is
 * unproven in both directions.
 */
export function executeFencedStart(role: string, adapters: FencedStartAdapters): FencedStartOutcome {
  const unaccounted = adapters.unaccountedLeaves();
  if (unaccounted === null) {
    adapters.log(`fenced start: the pre-spawn census for ${role} could not be read — nothing was started`);
    return { started: false, outcome: "CENSUS_UNAVAILABLE", reason: "process census unavailable" };
  }
  if (unaccounted > 0) {
    adapters.log(
      `fenced start: ${unaccounted} unaccounted ${role} runtime(s) are already running — nothing was started`
    );
    return { started: false, outcome: "DUPLICATE_PRESENT", reason: `${unaccounted} unaccounted runtime(s)` };
  }

  const pid = adapters.spawnWorker();
  if (pid === null) {
    adapters.log(`fenced start: ${role} could not be started`);
    return { started: false, outcome: "SPAWN_FAILED", reason: "spawn returned no pid" };
  }

  // A bounded fresh attempt to establish an ownership record that can later
  // be VERIFIED, rather than one that merely exists.
  let startedAtMs = 0;
  for (let attempt = 0; attempt < OWNERSHIP_PROOF_ATTEMPTS && startedAtMs === 0; attempt += 1) {
    const probe = adapters.probe(pid);
    startedAtMs = (probe.observed ? probe.process?.startedAtMs : undefined) ?? 0;
  }

  // Durable FIRST, before anything else can fail -- including in the unproven
  // case, so the pid is at least visible to an operator.
  adapters.recordOwnership?.(pid, startedAtMs);

  if (startedAtMs === 0) {
    adapters.log(
      `fenced start: started ${role} pid ${pid}, but its creation time could not be read — ` +
        "its ownership cannot be proven, so it was NOT killed and nothing was started beside it"
    );
    return {
      started: false,
      outcome: "OWNERSHIP_UNPROVEN",
      pid,
      reason: "the new process's creation time could not be read",
    };
  }

  adapters.log(`fenced start: started ${role} pid ${pid}`);
  return { started: true, pid, startedAtMs };
}

/**
 * Carries out ONE restart decision, by composing the two fenced primitives.
 *
 * ## The singleton argument, unchanged
 *
 * There is exactly one spawn, inside `executeFencedStart`, and it is reached
 * only once `executeFencedStop` has CONFIRMED the old tree is gone -- either
 * because it exited on its own or because a post-kill observation proved it.
 * A stop that cannot be proven returns without starting anything, so the
 * failure mode stays "no worker" rather than "two workers".
 *
 * Since the account runtime transition drives the same two primitives in a
 * different order, supervision and transitions cannot drift into two different
 * answers about what an unobservable or unowned tree means.
 */
export function executeWorkerRestart(
  decision: SupervisionDecision,
  state: {
    readonly repoRoot: string;
    readonly processes: readonly { role: string; pid: number; startedAtMs: number }[];
  },
  attemptNumber: number,
  adapters: WorkerRestartAdapters,
  role: string = "worker"
): WorkerRestartResult {
  if (decision.action === "NONE") {
    return { outcome: "NOT_ATTEMPTED", oldPid: null, newPid: null, record: null };
  }

  const oldPid = decision.terminatePid;
  adapters.log(
    `worker supervision: attempt ${attemptNumber}/${WORKER_RESTART_MAX_ATTEMPTS} — ${decision.reasonCode}` +
      (oldPid === null ? " (no live process)" : ` (old pid ${oldPid})`)
  );

  if (decision.action === "TERMINATE_THEN_RESTART") {
    if (oldPid === null) {
      return { outcome: "NOT_ATTEMPTED", oldPid: null, newPid: null, record: null };
    }
    const current = state.processes.find((entry) => entry.role === role && entry.pid === oldPid) ?? null;
    const stop = executeFencedStop(current, state.repoRoot, adapters);
    if (!stop.stopped) {
      // A record that vanished from state is the same refusal as one we cannot
      // prove: nothing was stopped, so nothing may be started.
      const outcome = stop.outcome === "NOT_RECORDED" ? "OWNERSHIP_LOST" : stop.outcome;
      // The primitive reports what IT did; only the composer knows a spawn was
      // going to follow, so the consequence is stated here.
      adapters.log(
        `worker supervision: ${stop.reason} — no replacement was started`
      );
      return { outcome, oldPid, newPid: null, record: null };
    }
  }

  const started = executeFencedStart(role, adapters);
  if (!started.started) {
    return { outcome: started.outcome, oldPid, newPid: null, record: null };
  }

  const record: OwnedProcess = {
    role: role as OwnedProcess["role"],
    pid: started.pid,
    startedAtMs: started.startedAtMs,
  };
  return { outcome: "RESTARTED", oldPid, newPid: started.pid, record };
}

/**
 * Replaces the worker entry in the runtime state, leaving every other role
 * untouched.
 *
 * A worker-only failure must never disturb the backend, the generic analysis
 * worker or the frontend, and their ownership records are the only way the
 * launcher can still stop them. After Phase 11E that matters more, not less:
 * restarting the account executor must not take plan generation down with it.
 */
export function withReplacedWorker(state: RuntimeState, worker: OwnedProcess | null): RuntimeState {
  const others = state.processes.filter((entry) => entry.role !== "worker");
  return { ...state, processes: worker ? [...others, worker] : others };
}

/** The roles supervision is allowed to touch. Deliberately just the one. */
export const SUPERVISED_ROLES: readonly LauncherRole[] = Object.freeze(["worker"]);

// ---------------------------------------------------------------------------
// Single flight
// ---------------------------------------------------------------------------

/**
 * Only one supervision pass may run at a time.
 *
 * The same shape as the orchestration scheduler's guard, and load-bearing for
 * the same reason: two overlapping passes could each observe "no worker" and
 * each spawn one. The flag is released in a `finally`, so a throwing pass still
 * frees it.
 *
 * This guards one launcher process against itself. Two launcher processes are
 * prevented from co-existing by `evaluateStartPreconditions`, and two workers
 * by the terminate-and-prove-exit sequence above.
 */
let supervisionInFlight = false;

export function isSupervisionInFlight(): boolean {
  return supervisionInFlight;
}

export async function runSupervisionSingleFlight<T>(
  run: () => Promise<T>
): Promise<{ ran: true; result: T } | { ran: false }> {
  if (supervisionInFlight) return { ran: false };
  supervisionInFlight = true;
  try {
    return { ran: true, result: await run() };
  } finally {
    supervisionInFlight = false;
  }
}

/** Test-only: clears the single-flight guard between cases. */
export function resetWorkerSupervisionForTests(): void {
  supervisionInFlight = false;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * The supervision line for the launcher screen.
 *
 * Deliberately reuses the launcher's existing vocabulary and prints counts and
 * states only — never a token, a path or a connection string.
 */
export function renderSupervisionState(
  decision: SupervisionDecision,
  budget: RestartBudget
): string[] {
  const attempts =
    budget.attempts === 0
      ? ""
      : `  (restart attempts ${budget.attempts}/${WORKER_RESTART_MAX_ATTEMPTS})`;
  return [`Worker supervision: ${decision.state}${attempts}`, `  ${decision.message}`];
}
