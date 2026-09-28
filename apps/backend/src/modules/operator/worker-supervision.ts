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
  | "NOT_ATTEMPTED";

export interface WorkerRestartResult {
  outcome: WorkerRestartOutcome;
  oldPid: number | null;
  newPid: number | null;
  /** The replacement record to merge into runtime state, when one started. */
  record: OwnedProcess | null;
}

/**
 * Carries out ONE restart decision.
 *
 * ## The singleton argument
 *
 * There is exactly one `spawnWorker()` call in this function, and every path
 * that reaches it has first established that no owned worker is running:
 * either the decision was RESTART (the process is gone) or the old process was
 * terminated AND re-probed to prove it exited. A termination that cannot be
 * proven returns without spawning, so the failure mode is "no worker" rather
 * than "two workers" — the former is visible and recoverable, the latter
 * silently competes over the same executions.
 *
 * ## Why ownership is re-verified here
 *
 * The decision was made from a probe taken earlier in the tick. Between then
 * and now the process could have exited and its PID been recycled. Re-checking
 * immediately before the kill is what keeps `verifyOwnership`'s guarantee
 * intact rather than merely inherited.
 */
export function executeWorkerRestart(
  decision: SupervisionDecision,
  /**
   * Structurally typed rather than `RuntimeState`, so the DUAL launcher can
   * pass its own state shape. Only the repo root and the recorded roots are
   * read; nothing else about the state matters to a restart.
   */
  state: {
    readonly repoRoot: string;
    readonly processes: readonly { role: string; pid: number; startedAtMs: number }[];
  },
  attemptNumber: number,
  adapters: WorkerRestartAdapters,
  /**
   * WHICH recorded role is being replaced. Defaults to the legacy
   * single-stack worker so every existing caller is unchanged; the dual
   * launcher names its own role, and a pass for one role can therefore never
   * select another role's record.
   */
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
    const current = state.processes.find((entry) => entry.role === role && entry.pid === oldPid);
    if (!current) {
      adapters.log(`worker supervision: pid ${oldPid} is no longer in runtime state — nothing was stopped`);
      return { outcome: "OWNERSHIP_LOST", oldPid, newPid: null, record: null };
    }
    // Re-verify immediately before the kill, never on the earlier reading.
    // A probe that could not be MADE is not a probe that found nothing. Asking
    // `verifyOwnership` about it would return GONE, and GONE is the verdict
    // that authorises a replacement without a kill.
    const beforeProbe = adapters.probe(oldPid);
    if (!beforeProbe.observed) {
      adapters.log(
        `worker supervision: pid ${oldPid} could not be observed — NOT terminated, no replacement was started`
      );
      return { outcome: "OBSERVATION_UNAVAILABLE", oldPid, newPid: null, record: null };
    }
    const before = verifyOwnership(current, beforeProbe.process, state.repoRoot);
    if (!before.owned) {
      if (before.reason === "GONE") {
        adapters.log(`worker supervision: pid ${oldPid} exited on its own before it could be stopped`);
      } else {
        // It stopped looking like ours between the decision and now. Refuse.
        adapters.log(`worker supervision: pid ${oldPid} is no longer provably ours (${before.reason}) — NOT terminated`);
        return { outcome: "OWNERSHIP_LOST", oldPid, newPid: null, record: null };
      }
    } else {
      adapters.terminate(oldPid);
      // Same rule after the kill: without an observation there is no proof the
      // tree exited, and an unproven exit must not be followed by a spawn.
      const afterProbe = adapters.probe(oldPid);
      if (!afterProbe.observed) {
        adapters.log(
          `worker supervision: pid ${oldPid} was signalled but could not be observed afterwards — no replacement was started`
        );
        return { outcome: "OBSERVATION_UNAVAILABLE", oldPid, newPid: null, record: null };
      }
      const after = verifyOwnership(current, afterProbe.process, state.repoRoot);
      if (after.owned) {
        adapters.log(`worker supervision: pid ${oldPid} could NOT be stopped — no replacement was started`);
        return { outcome: "TERMINATION_FAILED", oldPid, newPid: null, record: null };
      }
      /**
       * PID_REUSED and NOT_THIS_REPO here both mean the tree we terminated is
       * no longer at that pid, which is what the kill was for:
       *
       *   PID_REUSED     the creation time moved, so the pid was freed and
       *                  handed to somebody else -- ours exited.
       *   NOT_THIS_REPO  the same pid, a creation time within a second of our
       *                  record, and a different command line. A live process
       *                  cannot rewrite its own command line, and the pre-kill
       *                  probe already matched this repository, so this is
       *                  reachable only as a recycled pid that landed inside
       *                  the timing tolerance.
       *
       * Neither is observation ambiguity -- that case returned above, because
       * an unmade observation never reaches `verifyOwnership`. The fresh census
       * below remains the authority on whether a replacement is safe.
       */
      adapters.log(`worker supervision: pid ${oldPid} stopped`);
    }
  }

  /**
   * --- The pre-spawn fence ------------------------------------------
   *
   * Everything above proved the OLD tree is gone. This proves no OTHER
   * runtime has taken its place in the meantime.
   *
   * The decision was made from a census taken before the kill, and a kill
   * takes time. An operator starting a worker by hand in that window, or a
   * second launcher doing the same, would otherwise be joined by this
   * replacement -- two consumers on one queue, which is the failure this
   * whole sequence exists to prevent.
   *
   * Refused BOTH ways: a leaf that is present, and a census that could not
   * be read. An unreadable census is not evidence of absence.
   */
  const unaccounted = adapters.unaccountedLeaves();
  if (unaccounted === null) {
    adapters.log(
      "worker supervision: the pre-spawn process census could not be read — no replacement was started"
    );
    return { outcome: "CENSUS_UNAVAILABLE", oldPid, newPid: null, record: null };
  }
  if (unaccounted > 0) {
    adapters.log(
      `worker supervision: ${unaccounted} unaccounted runtime(s) appeared before the replacement could start — ` +
        "no replacement was started"
    );
    return { outcome: "DUPLICATE_PRESENT", oldPid, newPid: null, record: null };
  }

  // The ONLY spawn in this module.
  const newPid = adapters.spawnWorker();
  if (newPid === null) {
    adapters.log("worker supervision: the replacement worker could not be started");
    return { outcome: "SPAWN_FAILED", oldPid, newPid: null, record: null };
  }

  // Diagnostic only: the spawn already happened, and an unreadable creation
  // time makes the record unverifiable rather than unsafe. Reported, not
  // refused -- refusing here would leave a started process unrecorded.
  const spawnedProbe = adapters.probe(newPid);
  const probe = spawnedProbe.observed ? spawnedProbe.process : null;
  const record: OwnedProcess = {
    role: role as OwnedProcess["role"],
    pid: newPid,
    // The OS's own creation time, so a later ownership check compares like with
    // like. Falling back to 0 would make the record unverifiable, so a missing
    // probe keeps the spawn but is reported.
    startedAtMs: probe?.startedAtMs ?? 0,
  };
  if (!probe) {
    adapters.log(`worker supervision: started pid ${newPid} but its creation time could not be read`);
  } else {
    adapters.log(`worker supervision: started replacement worker pid ${newPid}`);
  }
  return { outcome: "RESTARTED", oldPid, newPid, record };
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
