import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { TransitionMarkerRead } from "./account-runtime-transition";
import { judgeSupervisedRestart } from "./account-runtime-transition";
import {
  ROLE_CONTRACTS,
  censusOf,
  describeEnvFileFailure,
  dualSpawnPlan,
  envFilePathFor,
  parseEnvFileStrict,
  projectTopology,
  roleLogPath,
  type DualRole,
  type DualSpawnPlan,
  type ObservedListener,
  type ObservedProcess,
  type TopologyStatus,
} from "./dual-account-topology";
import { leafRuntimeCount } from "./generic-analysis-supervision";
import { withMutationLock, type MutationLockAdapters } from "./mutation-lock";
import {
  NATIVE_PLANNER_ROLE,
  decideNativePlannerStart,
  decideNativePlannerSupervision,
  nativePlannerHealth,
  renderNativePlannerStatus,
  renderNativePlannerSupervision,
} from "./native-planner-supervision";
import { observed, verifyOwnership, type Observation, type OwnershipVerdict, type ProcessProbe } from "./runtime-launcher";
import {
  EMPTY_RESTART_BUDGET,
  WORKER_SUPERVISION_INTERVAL_MS,
  executeFencedStart,
  executeFencedStop,
  executeWorkerRestart,
  observeWorkerHealth,
  recordRestartAttempt,
  runSupervisionSingleFlight,
  type ProbeOutcome,
  type RestartBudget,
} from "./worker-supervision";

/**
 * The runtime launcher's OPTIONAL Native planner role: explicit start, stop and
 * supervision of the planning-only Native planner worker.
 *
 * ## Why a module of its own
 *
 * The six-role SAFE runtime (run-runtime-launcher.ts) carries fences that are
 * pinned structurally: one state-file writer that preserves the transition
 * marker, one gate printer, ownership proved before every kill, a lock around
 * every mutation. The Native planner is not part of that runtime. Keeping it
 * here means none of those code paths change, while it still uses THE SAME
 * primitives, handed in by reference from the CLI:
 *
 *  - gate:      the CLI's one transition-gate printer;
 *  - ownership: `verifyOwnership` over the CLI's process probe, and the reviewed
 *               fenced start / fenced stop / worker restart (each proves
 *               ownership itself before any kill);
 *  - lock:      `withMutationLock` with the CLI's lock adapters, under the
 *               NATIVE_PLANNER_START / NATIVE_PLANNER_STOP / SUPERVISE_RESTART
 *               actions;
 *  - spawn:     the CLI's durable-log spawner, with the generic env file only.
 *
 * Its ownership record lives in ITS OWN state file (atomic temp + rename), so
 * Start SAFE, its rollback and Stop Runtime can never erase, block on or stop it.
 * It never opens a database, Redis or Binance client.
 */

export interface NativePlannerLauncherAdapters {
  readonly repoRoot: string;
  readonly statePath: string;
  readonly observeProcesses: () => Observation<ObservedProcess[]>;
  readonly observeListeners: () => ObservedListener[];
  readonly probeProcesses: (pids: number[]) => Observation<Map<number, ProcessProbe>>;
  /** taskkill /PID /T on ONE root; called only from inside the fenced primitives. */
  readonly terminate: (pid: number) => boolean;
  readonly spawnRole: (role: DualRole, plan: DualSpawnPlan) => number | null;
  /** The CLI's ONE transition-gate printer. */
  readonly gateAllows: (roles: readonly DualRole[]) => boolean;
  readonly readTransitionMarker: () => TransitionMarkerRead;
  readonly lockAdapters: () => MutationLockAdapters;
  readonly log: (line: string) => void;
  readonly sleep: (ms: number) => Promise<unknown>;
  /** Where the generic env file is resolved from (defaults to this process's environment). */
  readonly env?: NodeJS.ProcessEnv;
}

interface NativePlannerRecord {
  role: typeof NATIVE_PLANNER_ROLE;
  pid: number;
  startedAtMs: number;
  envAlias: string;
  port: null;
}

interface NativePlannerState {
  repoRoot: string;
  startedAtMs: number;
  processes: NativePlannerRecord[];
}

export interface NativePlannerLauncher {
  start(): Promise<void>;
  stop(): Promise<void>;
  supervise(ask: (question: string) => Promise<string>): Promise<void>;
  statusLine(status: TopologyStatus): string;
}

export function createNativePlannerLauncher(adapters: NativePlannerLauncherAdapters): NativePlannerLauncher {
  const role = NATIVE_PLANNER_ROLE;
  const label = ROLE_CONTRACTS[role].label;
  const say = (line: string) => adapters.log(line);
  const env = adapters.env ?? process.env;

  const readState = (): NativePlannerState | null => {
    try {
      const parsed = JSON.parse(readFileSync(adapters.statePath, "utf8")) as NativePlannerState;
      if (!Array.isArray(parsed.processes)) return null;
      // Only this role may ever be recorded here.
      return { ...parsed, processes: parsed.processes.filter((entry) => entry.role === role) };
    } catch {
      return null;
    }
  };

  /** The ONLY writer of this role's state file. Atomic: write a temp, then rename. */
  const writeState = (record: NativePlannerRecord | null): void => {
    mkdirSync(path.dirname(adapters.statePath), { recursive: true });
    const temporary = `${adapters.statePath}.tmp`;
    const state: NativePlannerState = { repoRoot: adapters.repoRoot, startedAtMs: Date.now(), processes: record === null ? [] : [record] };
    writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
    renameSync(temporary, adapters.statePath);
  };

  const recordOf = (pid: number, startedAtMs: number): NativePlannerRecord => ({ role, pid, startedAtMs, envAlias: ROLE_CONTRACTS[role].envAlias, port: null });

  const probe = (pid: number): ProbeOutcome => {
    const probed = adapters.probeProcesses([pid]);
    return probed.ok ? { observed: true, process: probed.value.get(pid) ?? null } : { observed: false };
  };

  /**
   * The DURABLE record and a FRESH ownership verdict for it -- the account-worker
   * supervisor's pattern (superviseAccountWorker), reused unchanged.
   *
   * The record is never dropped just because its process is gone: a conclusively
   * GONE root is exactly the evidence that authorises the ladder's start-only
   * repair (WORKER_EXITED). Discarding it -- what this module used to do -- made
   * the ladder read "nothing is owned here" and a crashed planner was never
   * replaced. Every other verdict stays fail-closed: PID_REUSED / NOT_THIS_REPO
   * reach the ladder as OWNERSHIP_UNPROVEN (nothing killed, nothing started), and
   * an unobservable machine returns no verdict at all, because UNKNOWN must never
   * become GONE.
   */
  const recordOwnership = (state: NativePlannerState | null): Observation<{ durable: NativePlannerRecord | null; verdict: OwnershipVerdict | null }> => {
    const durable = state?.processes[0] ?? null;
    if (durable === null) return observed({ durable: null, verdict: null });
    const probed = adapters.probeProcesses([durable.pid]);
    if (!probed.ok) return probed;
    return observed({ durable, verdict: verifyOwnership(durable, probed.value.get(durable.pid) ?? null, state!.repoRoot) });
  };

  /** Our recorded root, if it is still provably ours (alive). */
  const ownedRecord = (state: NativePlannerState | null): Observation<NativePlannerRecord | null> => {
    const seen = recordOwnership(state);
    if (!seen.ok) return seen;
    return observed(seen.value.verdict?.owned === true ? seen.value.durable : null);
  };

  const observe = (): Observation<{
    status: TopologyStatus;
    /** Our root, only while it is provably ours AND alive. */
    record: NativePlannerRecord | null;
    /** The stored record, alive or not, and its fresh ownership verdict. */
    durable: NativePlannerRecord | null;
    ownership: OwnershipVerdict | null;
    hasState: boolean;
  }> => {
    const state = readState();
    const seen = recordOwnership(state);
    if (!seen.ok) return seen;
    const processes = adapters.observeProcesses();
    if (!processes.ok) return processes;
    const status = projectTopology({ census: censusOf(processes.value, adapters.observeListeners()), ownedRoles: [], attestation: {} });
    const { durable, verdict } = seen.value;
    return observed({ status, record: verdict?.owned === true ? durable : null, durable, ownership: verdict, hasState: state !== null });
  };

  /**
   * A FRESH count of Native planner runtimes immediately before a spawn. No
   * six-role record can explain one (the role is never in that file), so every
   * running leaf is unaccounted and blocks a second consumer.
   */
  const unaccountedLeaves = (): number | null => {
    const processes = adapters.observeProcesses();
    if (!processes.ok) return null;
    return censusOf(processes.value, []).counts[ROLE_CONTRACTS[role].entrypoint] ?? 0;
  };

  const spawn = (readKeyNames?: () => string[]) => adapters.spawnRole(role, dualSpawnPlan(role, adapters.repoRoot, env, readKeyNames));

  const start = async (): Promise<void> => {
    say("");
    say(`Starting the ${label}: PLANNING ONLY, generic.env only, no account, not part of Start SAFE.`);
    say("It consumes only the dedicated native-extreme-rr-plan queue. Native execution stays hard-disabled.");
    if (!adapters.gateAllows([role])) return;
    const held = await withMutationLock("NATIVE_PLANNER_START", adapters.lockAdapters(), async () => {
      // Only the generic file is required; parsed strictly so the child env can be sanitised against it.
      const parsed = parseEnvFileStrict(envFilePathFor(role, env));
      if (!parsed.ok) {
        say("BLOCKED — nothing was started:");
        say(`  - ${describeEnvFileFailure({ alias: "generic", reasonCode: parsed.reasonCode, detail: parsed.detail })}`);
        return;
      }
      const seen = observe();
      if (!seen.ok) {
        say(`  ${label}: processes could not be observed (${seen.reason}) — nothing was started.`);
        return;
      }
      const decision = decideNativePlannerStart({ status: seen.value.status, ownedRootAlive: seen.value.record !== null });
      if (decision.act === "NONE") {
        say(`  ${label}: nothing was started (${decision.reason}).`);
        return;
      }
      const outcome = executeFencedStart(role, {
        probe,
        unaccountedLeaves,
        spawnWorker: () => spawn(() => parsed.keys),
        recordOwnership: (pid, startedAtMs) => writeState(recordOf(pid, startedAtMs)),
        log: (line) => say(`  ${line}`),
      });
      if (!outcome.started) {
        say(`  ${label}: not started (${outcome.outcome}: ${outcome.reason}).`);
        return;
      }
      writeState(recordOf(outcome.pid, outcome.startedAtMs));
      say(`  ${label}: started, pid ${outcome.pid}. Log: ${roleLogPath(role)}`);
      say("  Its health is readable from the generic backend: GET /api/native-planner/status");
    });
    if (!held.ran) for (const reason of held.reasons) say(`  ${label}: ${reason}`);
  };

  const stop = async (): Promise<void> => {
    const held = await withMutationLock("NATIVE_PLANNER_STOP", adapters.lockAdapters(), async () => {
      const state = readState();
      const record = state?.processes[0] ?? null;
      if (record === null) {
        say("");
        say(`This launcher owns no ${label}, so there is nothing for it to stop.`);
        const seen = observe();
        if (seen.ok && leafRuntimeCount(seen.value.status, role) > 0) say("A Native planner IS running that this launcher did not start. It will not be terminated.");
        return;
      }
      // Ownership is proved inside the reviewed fenced stop before any kill.
      const outcome = executeFencedStop(record, state!.repoRoot, { probe, terminate: adapters.terminate, log: (line) => say(`  ${line}`) });
      if (outcome.stopped) {
        writeState(null);
        say(`  ${label}: stopped. Its jobs stay in Redis and PENDING intents stay in the database; the next start recovers them.`);
      } else {
        say(`  ${label}: NOT stopped (${outcome.outcome}: ${outcome.reason}); its ownership record was kept.`);
      }
    });
    if (!held.ran) for (const reason of held.reasons) say(`  ${label}: ${reason}`);
  };

  const supervise = async (ask: (question: string) => Promise<string>): Promise<void> => {
    if (!adapters.gateAllows([role])) return;
    say("");
    say(`Supervision watches the ${label} ONLY. It restarts no other role.`);
    say("It acts only on a planner THIS launcher started and can still prove it owns.");
    say("It runs only while this launcher is open. Press Ctrl+C to stop it.");
    say("");
    if ((await ask(`Start supervising the ${label}? (y/N) `)).trim().toLowerCase() !== "y") {
      say("Nothing was changed.");
      return;
    }

    /** One observation and one decision, with NO side effect. */
    const assess = async (from: RestartBudget) => {
      const seen = observe();
      if (!seen.ok) {
        say(`  ${label}: processes could not be observed (${seen.reason}) — nothing was changed.`);
        return null;
      }
      const { status, record, durable, ownership, hasState } = seen.value;
      const nowMs = Date.now();
      const observedBudget = observeWorkerHealth(from, nativePlannerHealth({ status, ownedRootAlive: record !== null }), nowMs);
      const decision = decideNativePlannerSupervision({
        // The DURABLE record with its verdict (GONE included), never `null` for a gone root.
        record: durable === null ? null : { pid: durable.pid, startedAtMs: durable.startedAtMs },
        ownership,
        status,
        budget: observedBudget,
        nowMs,
        hasRuntimeState: hasState,
      });
      return { budget: observedBudget, decision };
    };

    let budget: RestartBudget = EMPTY_RESTART_BUDGET;
    for (;;) {
      const pass = await runSupervisionSingleFlight(async () => {
        const first = await assess(budget);
        if (first === null) return null;
        // Nothing to mutate, so no lock is taken.
        if (first.decision.action === "NONE") {
          budget = first.budget;
          return first;
        }
        const held = await withMutationLock("SUPERVISE_RESTART", adapters.lockAdapters(), async () => {
          // Re-read under the lock: an unreadable marker fences this generic role too.
          const gate = judgeSupervisedRestart(adapters.readTransitionMarker(), [role]);
          if (gate.act === "REFUSE") {
            for (const reason of gate.reasons) say(`  ${label}: ${reason}`);
            return null;
          }
          // Re-proven under the lock.
          const now = await assess(budget);
          if (now === null) return null;
          if (now.decision.action === "NONE") {
            say(`  ${label}: the restart was no longer needed once mutation authority was held.`);
            budget = now.budget;
            return now;
          }
          const state = readState();
          // The SAME fenced sequence every supervisor uses: re-prove, refuse on non-GONE, terminate, prove exit, re-census.
          const outcome = executeWorkerRestart(
            now.decision,
            { repoRoot: state?.repoRoot ?? adapters.repoRoot, processes: state?.processes ?? [] },
            now.budget.attempts + 1,
            {
              probe,
              terminate: (pid) => {
                adapters.terminate(pid);
                return true;
              },
              unaccountedLeaves,
              spawnWorker: () => spawn(),
              log: (line) => say(`  ${line}`),
            },
            role
          );
          if (outcome.outcome === "RESTARTED" && outcome.newPid !== null) {
            const probed = probe(outcome.newPid);
            writeState(recordOf(outcome.newPid, (probed.observed ? probed.process?.startedAtMs : undefined) ?? Date.now()));
          }
          budget = recordRestartAttempt(now.budget, Date.now());
          return { budget, decision: now.decision };
        });
        if (held.ran) return held.result;
        for (const reason of held.reasons) say(`  ${label}: ${reason}`);
        say(`  ${label}: nothing was restarted.`);
        return null;
      });

      if (pass.ran && pass.result !== null) {
        const stamp = new Date().toISOString().slice(11, 19);
        for (const line of renderNativePlannerSupervision(pass.result.decision, pass.result.budget)) say(`[${stamp}] ${line}`);
        if (pass.result.decision.state === "WORKER_RECOVERY_FAILED") {
          say("");
          say(`Automatic recovery for the ${label} has STOPPED. Nothing further will be restarted.`);
          return;
        }
      }
      await adapters.sleep(WORKER_SUPERVISION_INTERVAL_MS);
    }
  };

  const statusLine = (status: TopologyStatus): string => {
    const owned = ownedRecord(readState());
    return renderNativePlannerStatus({ status, ownedRootAlive: owned.ok && owned.value !== null });
  };

  return { start, stop, supervise, statusLine };
}
