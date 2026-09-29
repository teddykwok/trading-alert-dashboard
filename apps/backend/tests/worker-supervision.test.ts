import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  judgeRoleHealth,
  classifySpawnResult,
  executeRollback,
  firstObservationFailure,
  judgeOwnedTree,
  parseProcessRows,
  verifyOwnership,
  type OwnedProcess,
  type OwnershipVerdict,
  type ProcessProbe,
  type RoleHealth,
  type RuntimeState,
} from "../src/modules/operator/runtime-launcher";
import {
  EMPTY_RESTART_BUDGET,
  SUPERVISED_ROLES,
  WORKER_RESTART_BASE_BACKOFF_MS,
  WORKER_RESTART_HEALTHY_RESET_MS,
  WORKER_RESTART_MAX_ATTEMPTS,
  WORKER_RESTART_MAX_BACKOFF_MS,
  WORKER_RESTART_STABILIZATION_MS,
  WORKER_SUPERVISION_INTERVAL_MS,
  decideWorkerSupervision,
  executeFencedStart,
  executeFencedStop,
  OWNERSHIP_PROOF_ATTEMPTS,
  executeWorkerRestart,
  isSupervisionInFlight,
  observeWorkerHealth,
  recordRestartAttempt,
  renderSupervisionState,
  resetWorkerSupervisionForTests,
  runSupervisionSingleFlight,
  withReplacedWorker,
  workerRestartBackoffMs,
  workerRestartQuietPeriodMs,
  type RestartBudget,
  type SupervisionDecision,
  type WorkerSupervisionInput,
} from "../src/modules/operator/worker-supervision";

/**
 * Worker supervision — the Aug 26 failure mode, in tests.
 *
 * The worker stopped at 13:58 and never returned. Reconciliation was fine; a
 * restart repairs that state correctly, which `protection-outage-restart.test`
 * already proves. Nothing restarted the worker, because the only health signal
 * lived INSIDE the worker.
 *
 * These tests are written around one question: can this supervisor ever make
 * things worse? Two workers competing over the same executions is worse than
 * none, killing a stranger's process is worse than doing nothing, and a
 * restart that silently re-armed a runtime would be worst of all. So most of
 * what follows pins REFUSALS.
 */

const REPO = "C:\\Projects\\trading-alert-dashboard";
const NOW = 1_800_000_000_000;

const SUPERVISION_PATH = path.resolve(__dirname, "../src/modules/operator/worker-supervision.ts");
const SUPERVISION_SOURCE = readFileSync(SUPERVISION_PATH, "utf8");

/**
 * The file with its comments removed.
 *
 * The structural bans below are about what the CODE can reach, and the comments
 * legitimately discuss the very things being banned — this module explains at
 * length why it must never touch `maxClaims`, and cites `binance.client.ts` for
 * its backoff shape. Scanning raw text would turn an accurate explanation into
 * a test failure, and push the next author towards deleting the explanation
 * rather than keeping the guarantee.
 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const SUPERVISION_CODE = codeOf(SUPERVISION_SOURCE);

afterEach(() => resetWorkerSupervisionForTests());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const workerRecord = (pid = 4242, startedAtMs = NOW - 3_600_000): OwnedProcess => ({
  role: "worker",
  pid,
  startedAtMs,
});

const runtimeState = (mode: "SAFE" | "LIVE_READY" = "SAFE", worker = workerRecord()): RuntimeState => ({
  repoRoot: REPO,
  mode,
  startedAtMs: NOW - 3_600_000,
  processes: [
    { role: "backend", pid: 1111, startedAtMs: NOW - 3_600_000 },
    worker,
    { role: "frontend", pid: 3333, startedAtMs: NOW - 3_600_000 },
  ],
});

const probeOf = (record: OwnedProcess, repo = REPO): ProcessProbe => ({
  pid: record.pid,
  startedAtMs: record.startedAtMs,
  commandLine: `cmd.exe /d /s /c pnpm -C ${repo} --filter @trading-alert-dashboard/backend worker`,
});

function input(overrides: Partial<WorkerSupervisionInput> = {}): WorkerSupervisionInput {
  const record = overrides.record === undefined ? workerRecord() : overrides.record;
  return {
    record,
    ownership: { owned: true } as OwnershipVerdict,
    workerHealth: "HEALTHY",
    backendHealth: "HEALTHY",
    budget: EMPTY_RESTART_BUDGET,
    nowMs: NOW,
    hasRuntimeState: true,
    ...overrides,
    record,
  };
}

/** A fake machine. Records every side effect so refusals are provable. */
function machine(
  options: {
    processes?: Map<number, ProcessProbe>;
    spawnPid?: number | null;
    /** What the FRESH pre-spawn census reports. Null = unreadable. */
    unaccounted?: number | null;
    /** Makes `terminate` a no-op, so the old tree survives the kill. */
    terminationFails?: boolean;
    /** Runs just before the pre-spawn census, to stage a late arrival. */
    beforeCensus?: () => void;
    /**
     * The machine cannot be observed at all -- PowerShell missing, a non-zero
     * exit, unparseable output. NOT the same as observing an empty machine.
     */
    unobservable?: boolean;
  } = {}
) {
  const processes = options.processes ?? new Map<number, ProcessProbe>();
  const terminated: number[] = [];
  const spawned: number[] = [];
  const logs: string[] = [];
  const censusCalls: number[] = [];
  let unaccounted = options.unaccounted === undefined ? 0 : options.unaccounted;
  let nextPid = options.spawnPid === undefined ? 9001 : options.spawnPid;
  return {
    processes,
    terminated,
    spawned,
    logs,
    censusCalls,
    setUnaccounted: (value: number | null) => {
      unaccounted = value;
    },
    adapters: {
      probe: (pid: number) =>
        options.unobservable
          ? ({ observed: false } as const)
          : ({ observed: true, process: processes.get(pid) ?? null } as const),
      terminate: (pid: number) => {
        terminated.push(pid);
        // A kill that does not actually remove the process is the case the
        // post-kill proof exists for.
        if (!options.terminationFails) processes.delete(pid);
        return true;
      },
      unaccountedLeaves: () => {
        options.beforeCensus?.();
        censusCalls.push(spawned.length);
        return unaccounted;
      },
      spawnWorker: () => {
        if (nextPid === null) return null;
        const pid = nextPid;
        spawned.push(pid);
        processes.set(pid, { pid, startedAtMs: NOW, commandLine: `pnpm -C ${REPO} worker` });
        return pid;
      },
      log: (line: string) => logs.push(line),
    },
  };
}

// ===========================================================================
// A. A healthy worker is left completely alone
// ===========================================================================

describe("phase 11E: the two worker roles are independent", () => {
  it("replacing the account worker leaves the generic analysis worker owned", () => {
    // Supervision restarts the ACCOUNT executor. If that dropped the generic
    // worker's ownership record the launcher could never stop it again, and
    // plan generation would be orphaned by an execution-side incident.
    const state = {
      repoRoot: "C:\\repo",
      mode: "SAFE" as const,
      startedAtMs: 1_700_000_000_000,
      standardLimitTakeProfit: false,
      processes: [
        { role: "backend" as const, pid: 101, startedAtMs: 1_700_000_000_001 },
        { role: "analysis" as const, pid: 102, startedAtMs: 1_700_000_000_002 },
        { role: "worker" as const, pid: 103, startedAtMs: 1_700_000_000_003 },
        { role: "frontend" as const, pid: 104, startedAtMs: 1_700_000_000_004 },
      ],
    };

    const replaced = withReplacedWorker(state, {
      role: "worker",
      pid: 999,
      startedAtMs: 1_700_000_000_999,
    });

    const roles = replaced.processes.map((entry) => entry.role).sort();
    expect(roles).toEqual(["analysis", "backend", "frontend", "worker"]);
    expect(replaced.processes.find((entry) => entry.role === "analysis")?.pid).toBe(102);
    expect(replaced.processes.find((entry) => entry.role === "worker")?.pid).toBe(999);
  });

  it("supervises the account worker and nothing else", () => {
    // Never the generic worker: it publishes no attestation, so every
    // supervision pass would read it as STALE and restart a healthy process.
    expect([...SUPERVISED_ROLES]).toEqual(["worker"]);
  });
});

describe("A. a healthy worker is untouched", () => {
  it("decides to do nothing", () => {
    const decision = decideWorkerSupervision(input({ workerHealth: "HEALTHY" }));
    expect(decision.action).toBe("NONE");
    expect(decision.state).toBe("WORKER_HEALTHY");
    expect(decision.reasonCode).toBe("HEALTHY");
  });

  it("dispatches no machine call at all", () => {
    const box = machine();
    const decision = decideWorkerSupervision(input({ workerHealth: "HEALTHY" }));
    const result = executeWorkerRestart(decision, runtimeState(), 1, box.adapters);

    expect(result.outcome).toBe("NOT_ATTEMPTED");
    expect(box.terminated).toEqual([]);
    expect(box.spawned).toEqual([]);
  });
});

// ===========================================================================
// B. An exited worker is restarted exactly once
// ===========================================================================

describe("B. an exited worker is restarted once", () => {
  const exited = () =>
    input({
      workerHealth: "OFF",
      ownership: { owned: false, reason: "GONE" },
    });

  it("is recognised as CASE A and asks for a plain restart", () => {
    const decision = decideWorkerSupervision(exited());
    expect(decision.action).toBe("RESTART");
    expect(decision.state).toBe("WORKER_RESTARTING");
    expect(decision.reasonCode).toBe("WORKER_EXITED");
    // Nothing to terminate: the process is already gone.
    expect(decision.terminatePid).toBeNull();
  });

  it("spawns exactly one worker and kills nothing", () => {
    const box = machine();
    const result = executeWorkerRestart(decideWorkerSupervision(exited()), runtimeState(), 1, box.adapters);

    expect(result.outcome).toBe("RESTARTED");
    expect(box.spawned).toHaveLength(1);
    expect(box.terminated).toEqual([]);
    expect(result.newPid).toBe(box.spawned[0]);
  });

  it("records the replacement with the OS creation time, so it stays verifiable", () => {
    const box = machine();
    const result = executeWorkerRestart(decideWorkerSupervision(exited()), runtimeState(), 1, box.adapters);

    expect(result.record).not.toBeNull();
    expect(result.record!.role).toBe("worker");
    expect(result.record!.startedAtMs).toBe(NOW);
    // The new record must pass the SAME ownership check used everywhere else.
    const seen = box.adapters.probe(result.newPid!);
    expect(seen.observed).toBe(true);
    expect(verifyOwnership(result.record!, seen.observed ? seen.process : null, REPO).owned).toBe(true);
  });

  it("a spawn that fails is reported, not retried inside the same attempt", () => {
    const box = machine({ spawnPid: null });
    const result = executeWorkerRestart(decideWorkerSupervision(exited()), runtimeState(), 1, box.adapters);

    expect(result.outcome).toBe("SPAWN_FAILED");
    expect(result.record).toBeNull();
    expect(box.spawned).toEqual([]);
  });
});

// ===========================================================================
// C. A stale but living worker exits BEFORE a replacement starts
// ===========================================================================

describe("C. a stale owned worker is terminated, then replaced", () => {
  const stale = () => input({ workerHealth: "STALE", ownership: { owned: true } });

  it("is recognised as CASE B and names the pid to stop", () => {
    const decision = decideWorkerSupervision(stale());
    expect(decision.action).toBe("TERMINATE_THEN_RESTART");
    expect(decision.state).toBe("WORKER_STALE");
    expect(decision.terminatePid).toBe(4242);
  });

  it("terminates the old process and then spawns exactly one", () => {
    const record = workerRecord();
    const box = machine({ processes: new Map([[record.pid, probeOf(record)]]) });

    const result = executeWorkerRestart(decideWorkerSupervision(stale()), runtimeState(), 1, box.adapters);

    expect(box.terminated).toEqual([record.pid]);
    expect(box.spawned).toHaveLength(1);
    expect(result.outcome).toBe("RESTARTED");
  });

  it("REFUSES to spawn when the old worker could not be proven gone", () => {
    // This is the singleton guarantee at its sharpest: a kill that did not take
    // must never be followed by a second worker.
    const record = workerRecord();
    const processes = new Map([[record.pid, probeOf(record)]]);
    const box = machine({ processes });
    box.adapters.terminate = (pid: number) => {
      box.terminated.push(pid);
      return true; // claims success, but the process survives
    };

    const result = executeWorkerRestart(decideWorkerSupervision(stale()), runtimeState(), 1, box.adapters);

    expect(result.outcome).toBe("TERMINATION_FAILED");
    expect(box.spawned).toEqual([]);
    expect(box.logs.join(" ")).toContain("no replacement was started");
  });

  it("still replaces a worker that exited on its own between decision and kill", () => {
    // The decision said TERMINATE, but by the time we look the process is gone.
    // That is not a failure — there is simply nothing to stop.
    const box = machine({ processes: new Map() });
    const result = executeWorkerRestart(decideWorkerSupervision(stale()), runtimeState(), 1, box.adapters);

    expect(box.terminated).toEqual([]);
    expect(box.spawned).toHaveLength(1);
    expect(result.outcome).toBe("RESTARTED");
  });
});

// ===========================================================================
// D. Ownership that cannot be proven is never acted on
// ===========================================================================

describe("D. an unproven pid is never killed", () => {
  it("refuses when the pid was reused", () => {
    const decision = decideWorkerSupervision(
      input({ workerHealth: "OFF", ownership: { owned: false, reason: "PID_REUSED" } })
    );
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("OWNERSHIP_UNPROVEN");
    expect(decision.state).toBe("WORKER_DEGRADED");
    expect(decision.terminatePid).toBeNull();
  });

  it("refuses when the command line no longer belongs to this repo", () => {
    const decision = decideWorkerSupervision(
      input({ workerHealth: "STALE", ownership: { owned: false, reason: "NOT_THIS_REPO" } })
    );
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("OWNERSHIP_UNPROVEN");
  });

  it("refuses at EXECUTION time too, when ownership changed under us", () => {
    // The decision was made from an earlier probe. Between then and the kill the
    // pid was recycled, so the re-verification must catch it.
    const record = workerRecord();
    const stranger: ProcessProbe = {
      pid: record.pid,
      startedAtMs: NOW, // a different creation time: not our process
      commandLine: "C:\\Windows\\System32\\notepad.exe",
    };
    const box = machine({ processes: new Map([[record.pid, stranger]]) });

    const result = executeWorkerRestart(
      decideWorkerSupervision(input({ workerHealth: "STALE", ownership: { owned: true } })),
      runtimeState(),
      1,
      box.adapters
    );

    expect(result.outcome).toBe("OWNERSHIP_LOST");
    expect(box.terminated).toEqual([]);
    expect(box.spawned).toEqual([]);
  });

  it("refuses when health could not be read at all", () => {
    // An unreadable Redis reports zero fresh instances, which looks exactly
    // like a silent worker. It is never treated as proof of one.
    const decision = decideWorkerSupervision(input({ workerHealth: "UNKNOWN" }));
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("HEALTH_UNKNOWN");
  });

  it("refuses when more than one worker is already attesting", () => {
    const decision = decideWorkerSupervision(input({ workerHealth: "DUPLICATE" }));
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("WORKER_DUPLICATE");
  });

  it("refuses when the launcher owns no runtime at all", () => {
    const decision = decideWorkerSupervision(input({ hasRuntimeState: false, workerHealth: "OFF" }));
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("NO_RUNTIME_RECORDED");
  });

  it("refuses when the recorded runtime has no worker entry", () => {
    const decision = decideWorkerSupervision(input({ record: null, ownership: null, workerHealth: "OFF" }));
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("NO_WORKER_RECORDED");
  });

  it("every refusal is genuinely inert — no kill, no spawn, for any of them", () => {
    const refusals: WorkerSupervisionInput[] = [
      input({ workerHealth: "OFF", ownership: { owned: false, reason: "PID_REUSED" } }),
      input({ workerHealth: "STALE", ownership: { owned: false, reason: "NOT_THIS_REPO" } }),
      input({ workerHealth: "UNKNOWN" }),
      input({ workerHealth: "DUPLICATE" }),
      input({ hasRuntimeState: false }),
      input({ record: null, ownership: null }),
      input({ workerHealth: "STALE", backendHealth: "OFF" }),
    ];
    for (const refusal of refusals) {
      const record = workerRecord();
      const box = machine({ processes: new Map([[record.pid, probeOf(record)]]) });
      const decision = decideWorkerSupervision(refusal);
      executeWorkerRestart(decision, runtimeState(), 1, box.adapters);
      expect(decision.action, decision.reasonCode).toBe("NONE");
      expect(box.terminated, decision.reasonCode).toEqual([]);
      expect(box.spawned, decision.reasonCode).toEqual([]);
    }
  });
});

// ===========================================================================
// E. Singleton under repeated and concurrent ticks
// ===========================================================================

describe("E. only one worker can ever be started", () => {
  it("a second overlapping pass does not run", async () => {
    let inside = 0;
    let release = () => {};
    const held = new Promise<void>((done) => (release = done));

    const first = runSupervisionSingleFlight(async () => {
      inside += 1;
      await held;
      return "first";
    });
    // While the first is still in flight:
    const second = await runSupervisionSingleFlight(async () => {
      inside += 1;
      return "second";
    });

    expect(second.ran).toBe(false);
    expect(inside).toBe(1);
    release();
    await first;
    expect(isSupervisionInFlight()).toBe(false);
  });

  it("releases the guard even when the pass throws", async () => {
    await expect(
      runSupervisionSingleFlight(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(isSupervisionInFlight()).toBe(false);

    const after = await runSupervisionSingleFlight(async () => "ok");
    expect(after).toEqual({ ran: true, result: "ok" });
  });

  it("repeated ticks over a now-healthy worker start nothing further", () => {
    const box = machine();
    // Tick 1: worker gone, one restart.
    executeWorkerRestart(
      decideWorkerSupervision(input({ workerHealth: "OFF", ownership: { owned: false, reason: "GONE" } })),
      runtimeState(),
      1,
      box.adapters
    );
    expect(box.spawned).toHaveLength(1);

    // Ticks 2-5: the replacement is healthy, so nothing more happens.
    for (let tick = 0; tick < 4; tick += 1) {
      const decision = decideWorkerSupervision(input({ workerHealth: "HEALTHY" }));
      executeWorkerRestart(decision, runtimeState(), 2, box.adapters);
    }
    expect(box.spawned).toHaveLength(1);
    expect(box.terminated).toEqual([]);
  });

  it("the stabilization window stops a second restart landing on top of the first", () => {
    const justRestarted: RestartBudget = { attempts: 1, lastAttemptAtMs: NOW - 1_000, healthySinceMs: null };
    const decision = decideWorkerSupervision(
      input({
        workerHealth: "OFF",
        ownership: { owned: false, reason: "GONE" },
        budget: justRestarted,
        nowMs: NOW,
      })
    );
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("STABILIZING");
    expect(decision.state).toBe("WORKER_RESTARTING");
  });

  it("supervision may only ever touch the worker role", () => {
    expect([...SUPERVISED_ROLES]).toEqual(["worker"]);
  });
});

// ===========================================================================
// F/G. Crash loop is bounded; sustained health forgives
// ===========================================================================

describe("F. a crash loop is bounded", () => {
  const dead = (budget: RestartBudget, nowMs = NOW) =>
    decideWorkerSupervision(
      input({ workerHealth: "OFF", ownership: { owned: false, reason: "GONE" }, budget, nowMs })
    );

  it("stops after the attempt budget is spent", () => {
    const spent: RestartBudget = {
      attempts: WORKER_RESTART_MAX_ATTEMPTS,
      lastAttemptAtMs: NOW - 10 * 60_000,
      healthySinceMs: null,
    };
    const decision = dead(spent);
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("RESTART_BUDGET_EXHAUSTED");
    expect(decision.state).toBe("WORKER_RECOVERY_FAILED");
  });

  it("waits out the backoff between attempts instead of spinning", () => {
    const oneAttempt: RestartBudget = {
      attempts: 1,
      // Past the stabilization window, but not yet through the backoff that
      // follows it.
      lastAttemptAtMs: NOW - (WORKER_RESTART_STABILIZATION_MS + 1_000),
      healthySinceMs: null,
    };
    const decision = dead(oneAttempt, NOW);
    expect(decision.reasonCode).toBe("BACKOFF_PENDING");
    expect(decision.action).toBe("NONE");
    expect(decision.state).toBe("WORKER_RESTARTING");
  });

  it("the two timers COMPOSE, so neither is dead code", () => {
    // Written as max(stabilization, backoff) the backoff would never fire: the
    // stabilization window is longer than every early backoff and would always
    // win, leaving a crash loop retried on a flat cadence with the escalation
    // existing only on paper. This pins the sequence instead.
    for (let attempt = 1; attempt <= WORKER_RESTART_MAX_ATTEMPTS; attempt += 1) {
      expect(workerRestartQuietPeriodMs(attempt)).toBe(
        WORKER_RESTART_STABILIZATION_MS + workerRestartBackoffMs(attempt)
      );
      expect(workerRestartQuietPeriodMs(attempt)).toBeGreaterThan(WORKER_RESTART_STABILIZATION_MS);
    }
    // And each attempt genuinely waits longer than the one before it.
    expect(workerRestartQuietPeriodMs(2)).toBeGreaterThan(workerRestartQuietPeriodMs(1));
    expect(workerRestartQuietPeriodMs(3)).toBeGreaterThan(workerRestartQuietPeriodMs(2));
  });

  it("walks a failing worker through STABILIZING then BACKOFF_PENDING then a retry", () => {
    const budget: RestartBudget = { attempts: 1, lastAttemptAtMs: NOW, healthySinceMs: null };

    expect(dead(budget, NOW + 1_000).reasonCode).toBe("STABILIZING");
    expect(dead(budget, NOW + WORKER_RESTART_STABILIZATION_MS + 1_000).reasonCode).toBe("BACKOFF_PENDING");
    expect(dead(budget, NOW + workerRestartQuietPeriodMs(2) + 1).action).toBe("RESTART");
  });

  it("runs the full sequence: restart, restart, restart, then give up", () => {
    let budget = EMPTY_RESTART_BUDGET;
    let clock = NOW;
    const actions: string[] = [];

    for (let tick = 0; tick < 12; tick += 1) {
      const decision = dead(budget, clock);
      actions.push(decision.action);
      if (decision.action !== "NONE") budget = recordRestartAttempt(budget, clock);
      // Advance well past both the stabilization window and the longest backoff.
      clock += WORKER_RESTART_STABILIZATION_MS + WORKER_RESTART_MAX_BACKOFF_MS + 1_000;
    }

    expect(actions.filter((a) => a !== "NONE")).toHaveLength(WORKER_RESTART_MAX_ATTEMPTS);
    expect(dead(budget, clock).reasonCode).toBe("RESTART_BUDGET_EXHAUSTED");
  });

  it("backoff grows and is capped", () => {
    expect(workerRestartBackoffMs(1)).toBe(WORKER_RESTART_BASE_BACKOFF_MS);
    expect(workerRestartBackoffMs(2)).toBe(WORKER_RESTART_BASE_BACKOFF_MS * 2);
    expect(workerRestartBackoffMs(3)).toBe(WORKER_RESTART_BASE_BACKOFF_MS * 4);
    expect(workerRestartBackoffMs(50)).toBe(WORKER_RESTART_MAX_BACKOFF_MS);
    for (let attempt = 1; attempt < 20; attempt += 1) {
      expect(workerRestartBackoffMs(attempt)).toBeLessThanOrEqual(workerRestartBackoffMs(attempt + 1));
    }
  });

  it("the constants are conservative and internally coherent", () => {
    // Stabilization must outlast the attestation TTL, or a worker would be
    // judged before it can possibly have published a heartbeat.
    expect(WORKER_RESTART_STABILIZATION_MS).toBeGreaterThan(15_000);
    expect(WORKER_SUPERVISION_INTERVAL_MS).toBeLessThan(WORKER_RESTART_STABILIZATION_MS);
    expect(WORKER_RESTART_MAX_ATTEMPTS).toBeLessThanOrEqual(5);
    expect(WORKER_RESTART_HEALTHY_RESET_MS).toBeGreaterThan(WORKER_RESTART_MAX_BACKOFF_MS);
  });
});

describe("G. sustained health resets the retry budget", () => {
  it("forgives the attempts only after the full healthy window", () => {
    const used: RestartBudget = { attempts: 2, lastAttemptAtMs: NOW, healthySinceMs: null };

    const justHealthy = observeWorkerHealth(used, "HEALTHY", NOW + 1_000);
    expect(justHealthy.attempts).toBe(2);
    expect(justHealthy.healthySinceMs).toBe(NOW + 1_000);

    const stillTooSoon = observeWorkerHealth(justHealthy, "HEALTHY", NOW + WORKER_RESTART_HEALTHY_RESET_MS - 1);
    expect(stillTooSoon.attempts).toBe(2);

    const forgiven = observeWorkerHealth(justHealthy, "HEALTHY", NOW + 1_000 + WORKER_RESTART_HEALTHY_RESET_MS);
    expect(forgiven.attempts).toBe(0);
    expect(forgiven.lastAttemptAtMs).toBeNull();
  });

  it("a flapping worker never earns its budget back", () => {
    // Healthy for a moment, then down again, repeatedly. The streak resets each
    // time, so the attempt counter keeps climbing and the bound still bites.
    let budget: RestartBudget = EMPTY_RESTART_BUDGET;
    let clock = NOW;
    for (let cycle = 0; cycle < 6; cycle += 1) {
      budget = observeWorkerHealth(budget, "HEALTHY", clock);
      clock += 30_000;
      budget = observeWorkerHealth(budget, "OFF", clock);
      budget = recordRestartAttempt(budget, clock);
      clock += 30_000;
    }
    expect(budget.attempts).toBeGreaterThanOrEqual(WORKER_RESTART_MAX_ATTEMPTS);
    expect(budget.healthySinceMs).toBeNull();
  });

  it("any non-healthy observation breaks the streak", () => {
    const streaking: RestartBudget = { attempts: 1, lastAttemptAtMs: NOW, healthySinceMs: NOW };
    for (const health of ["STALE", "OFF", "UNKNOWN", "DUPLICATE"] as RoleHealth[]) {
      expect(observeWorkerHealth(streaking, health, NOW + 5_000).healthySinceMs, health).toBeNull();
    }
  });
});

// ===========================================================================
// H/I/J. Authorization and deployment mode are never touched
// ===========================================================================

describe("H/I/J. recovery is infrastructure, never authorization", () => {

  it("H. a SAFE runtime is restarted in SAFE — the recorded mode, never a new one", () => {
    // The mode is read from runtime state and handed to windowsSpawnPlan, which
    // pins the three gates into the child environment. Supervision has no
    // parameter that could ask for a different posture.
    const state = runtimeState("SAFE");
    const box = machine();
    executeWorkerRestart(
      decideWorkerSupervision(input({ workerHealth: "OFF", ownership: { owned: false, reason: "GONE" } })),
      state,
      1,
      box.adapters
    );
    expect(box.spawned).toHaveLength(1);
    // The state's mode is untouched by the restart.
    expect(withReplacedWorker(state, { role: "worker", pid: 9001, startedAtMs: NOW }).mode).toBe("SAFE");
  });

  it("I. LIVE_READY is likewise preserved, not re-created", () => {
    const state = runtimeState("LIVE_READY");
    const next = withReplacedWorker(state, { role: "worker", pid: 9001, startedAtMs: NOW });
    expect(next.mode).toBe("LIVE_READY");
    // Deployment mode only. Nothing here can arm.
    expect(SUPERVISION_CODE).not.toMatch(/applyGates|writeEnvText|gatesFor/);
  });

  it("J. the module cannot reach authorization at all", () => {
    // The strongest available guarantee: an exhausted or revoked window stays
    // that way because this code has no path to it. Structural, not behavioural.
    for (const forbidden of [
      "natural-authorization",
      "canary-authorization",
      "NaturalWindow",
      "maxClaims",
      "claimedCount",
      "trading-control",
      "prisma",
      "PrismaClient",
      "KILL_SWITCH",
    ]) {
      expect(`${forbidden}:${SUPERVISION_CODE.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // It imports from exactly one place, and that place is the launcher core.
    const imports = [...SUPERVISION_CODE.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["./runtime-launcher"]);
  });

  it("J2. it never writes an execution row or calls an exchange", () => {
    for (const forbidden of ["tradeExecution", "binance", "Binance", "fetch(", "axios"]) {
      expect(`${forbidden}:${SUPERVISION_CODE.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

// ===========================================================================
// K. Active executions must NOT block recovery
// ===========================================================================

describe("K. an active PROTECTED execution does not block worker recovery", () => {
  it("the decision has no input for durable trading state", () => {
    // This is the point of the whole feature. `stopRuntime` deliberately
    // refuses while an execution is active, because taking the stack down and
    // LEAVING it down would abandon an open position. A worker restart is the
    // opposite: it is how protection and reconciliation come BACK. Making it
    // conditional on "nothing is active" would disable recovery in precisely
    // the situation it exists for.
    const keys = Object.keys(input());
    for (const absent of ["activeExecutions", "durable", "systemState", "manualIntervention"]) {
      expect(keys).not.toContain(absent);
    }
  });

  it("restarts a worker while the recorded runtime is LIVE_READY and busy", () => {
    const box = machine();
    const result = executeWorkerRestart(
      decideWorkerSupervision(input({ workerHealth: "OFF", ownership: { owned: false, reason: "GONE" } })),
      runtimeState("LIVE_READY"),
      1,
      box.adapters
    );
    expect(result.outcome).toBe("RESTARTED");
  });

  it("does not consult evaluateDurableSafety", () => {
    expect(SUPERVISION_CODE).not.toContain("evaluateDurableSafety");
  });
});

// ===========================================================================
// L. The rest of the stack is never disturbed
// ===========================================================================

describe("L. backend and frontend are not restarted for a worker failure", () => {
  it("replaces only the worker record and preserves the others exactly", () => {
    const state = runtimeState();
    const next = withReplacedWorker(state, { role: "worker", pid: 9001, startedAtMs: NOW });

    const backend = next.processes.find((entry) => entry.role === "backend")!;
    const frontend = next.processes.find((entry) => entry.role === "frontend")!;
    expect(backend).toEqual(state.processes.find((entry) => entry.role === "backend"));
    expect(frontend).toEqual(state.processes.find((entry) => entry.role === "frontend"));
    expect(next.processes.filter((entry) => entry.role === "worker")).toHaveLength(1);
    expect(next.processes.find((entry) => entry.role === "worker")!.pid).toBe(9001);
  });

  it("never terminates a backend or frontend pid", () => {
    const state = runtimeState();
    const box = machine({
      processes: new Map(state.processes.map((entry) => [entry.pid, probeOf(entry)])),
    });
    executeWorkerRestart(
      decideWorkerSupervision(input({ workerHealth: "STALE", ownership: { owned: true } })),
      state,
      1,
      box.adapters
    );
    expect(box.terminated).toEqual([4242]);
    expect(box.terminated).not.toContain(1111);
    expect(box.terminated).not.toContain(3333);
  });

  it("F. a broken backend means this is not a worker-only failure", () => {
    for (const backendHealth of ["STALE", "OFF", "UNKNOWN", "DUPLICATE"] as RoleHealth[]) {
      const decision = decideWorkerSupervision(
        input({ workerHealth: "OFF", ownership: { owned: false, reason: "GONE" }, backendHealth })
      );
      expect(decision.action, backendHealth).toBe("NONE");
      expect(decision.reasonCode, backendHealth).toBe("BACKEND_NOT_HEALTHY");
    }
  });
});

// ===========================================================================
// M/N. Failure is reported as DEGRADED, never as success
// ===========================================================================

describe("M/N. a failed or ambiguous recovery fails closed", () => {
  it("every non-restarting state is one an operator can act on", () => {
    const states = new Set<string>();
    const cases: WorkerSupervisionInput[] = [
      input({ workerHealth: "HEALTHY" }),
      input({ workerHealth: "STALE", ownership: { owned: true } }),
      input({ workerHealth: "OFF", ownership: { owned: false, reason: "GONE" } }),
      input({ workerHealth: "UNKNOWN" }),
      input({ workerHealth: "DUPLICATE" }),
      input({ workerHealth: "OFF", ownership: { owned: false, reason: "PID_REUSED" } }),
      input({ workerHealth: "STALE", backendHealth: "OFF" }),
      input({
        workerHealth: "OFF",
        ownership: { owned: false, reason: "GONE" },
        budget: { attempts: WORKER_RESTART_MAX_ATTEMPTS, lastAttemptAtMs: NOW - 10 * 60_000, healthySinceMs: null },
      }),
    ];
    for (const one of cases) states.add(decideWorkerSupervision(one).state);

    expect(states).toEqual(
      new Set(["WORKER_HEALTHY", "WORKER_STALE", "WORKER_RESTARTING", "WORKER_DEGRADED", "WORKER_RECOVERY_FAILED"])
    );
  });

  it("an inconsistent observation is refused rather than guessed at", () => {
    // Ownership says the process is alive and ours; health says it is OFF.
    // Those cannot both be true, and a contradiction is not a mandate to act.
    const decision = decideWorkerSupervision(input({ workerHealth: "OFF", ownership: { owned: true } }));
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("INCONSISTENT_OBSERVATION");
  });

  it("every decision carries an operator-facing message", () => {
    const decision = decideWorkerSupervision(input({ workerHealth: "UNKNOWN" }));
    expect(decision.message.length).toBeGreaterThan(20);
    expect(renderSupervisionState(decision, EMPTY_RESTART_BUDGET).join("\n")).toContain("WORKER_DEGRADED");
  });

  it("the rendered line shows the attempt count once restarts have happened", () => {
    const decision = decideWorkerSupervision(input({ workerHealth: "UNKNOWN" }));
    const lines = renderSupervisionState(decision, { attempts: 2, lastAttemptAtMs: NOW, healthySinceMs: null });
    expect(lines[0]).toContain(`2/${WORKER_RESTART_MAX_ATTEMPTS}`);
    // A clean budget adds no noise.
    expect(renderSupervisionState(decision, EMPTY_RESTART_BUDGET)[0]).not.toContain("/");
  });
});

// ===========================================================================
// O. Nothing secret is ever rendered or logged
// ===========================================================================

describe("O. supervision output carries no secret", () => {

  it("logs pids, attempt counts and reason codes only", () => {
    const record = workerRecord();
    const box = machine({ processes: new Map([[record.pid, probeOf(record)]]) });
    executeWorkerRestart(
      decideWorkerSupervision(input({ workerHealth: "STALE", ownership: { owned: true } })),
      runtimeState(),
      2,
      box.adapters
    );

    const output = [...box.logs, ...renderSupervisionState(decideWorkerSupervision(input()), EMPTY_RESTART_BUDGET)];
    expect(output.length).toBeGreaterThan(0);
    for (const line of output) {
      expect(line).not.toMatch(/postgres|redis:\/\/|OPERATOR_API_TOKEN|BINANCE_|apiKey|secret|password/i);
      // No filesystem path either: the repo root is not operator-facing.
      expect(line).not.toMatch(/[A-Za-z]:\\/);
    }
    expect(box.logs.join(" ")).toContain("attempt 2/");
    expect(box.logs.join(" ")).toContain(String(record.pid));
  });

  it("never renders a command line, which carries the environment's shape", () => {
    expect(SUPERVISION_CODE).not.toContain("commandLine");
  });

  it("the module reads no environment variable", () => {
    expect(SUPERVISION_CODE).not.toMatch(/process\.env|config\/env/);
  });
});

// ===========================================================================
// The supervision surface actually reaches the operator
// ===========================================================================

describe("the launcher exposes supervision and keeps its existing guards", () => {
  const CLI = readFileSync(
    path.resolve(__dirname, "../src/modules/operator/run-runtime-launcher.ts"),
    "utf8"
  );

  it("offers one entry PER SUPERVISED ROLE, without displacing Exit", () => {
    // Phase 11I: supervision is account-explicit. One button that restarts
    // "the worker" is meaningless when two accounts each have one.
    //
    // The generic analysis role joined them after a dead generic worker went
    // unnoticed for fifty minutes. It gets its OWN entry for the same reason
    // the accounts do: an operator starting supervision must know which role
    // may therefore be restarted. Exit moves down; it is not displaced.
    expect(CLI).toContain("5. Supervise Account A Worker");
    expect(CLI).toContain("6. Supervise Account B Worker");
    expect(CLI).toContain("7. Supervise Generic Analysis");
    expect(CLI).toContain("8. Exit");
    expect(CLI).toContain('else if (choice === "5") await superviseAccountWorker("ACCOUNT_A", ask);');
    expect(CLI).toContain('else if (choice === "6") await superviseAccountWorker("ACCOUNT_B", ask);');
    expect(CLI).toContain('else if (choice === "7") await superviseGenericAnalysis(ask);');
    // Exit is handled BEFORE the dispatch guard, so leaving the launcher can
    // never be blocked by a machine it cannot observe.
    expect(CLI).toContain('if (choice === "8") break;');
    const dispatch = CLI.slice(CLI.indexOf('const choice = (await ask("Choose: ")).trim();'));
    expect(dispatch.indexOf('if (choice === "8") break;')).toBeLessThan(dispatch.indexOf('try {'));
  });

  it("spawns the replacement for the SAME account, never the other one", () => {
    // The role is fixed at the top of the supervision pass from the account
    // being supervised, and the plan derives the env file from the role. A
    // restart therefore cannot change which account the worker is.
    //
    // Both supervisors hand that role to ONE shared restart path, so the
    // binding is asserted where the spawn actually happens. Every
    // `dualSpawnPlan` call site in the tool is named for the role it was
    // given -- there is no call site that picks a role for itself.
    expect(CLI).toContain("const plan = dualSpawnPlan(role, REPO_ROOT);");
    // Three: the six-role start, the shared supervised restart, and the
    // account-transition start adapter.
    expect((CLI.match(/dualSpawnPlan\(/g) ?? [])).toHaveLength(3);
    expect((CLI.match(/dualSpawnPlan\(role, REPO_ROOT\)/g) ?? [])).toHaveLength(2);
    expect((CLI.match(/dualSpawnPlan\(role, REPO_ROOT, process\.env, validatedKeyNames\)/g) ?? [])).toHaveLength(1);
    expect(CLI).toContain("restartOwnedRole(now.decision, workerRole, now.budget.attempts + 1)");
    expect(CLI).toContain(
      'const workerRole: DualRole = account === "ACCOUNT_A" ? "account-a-worker" : "account-b-worker";'
    );
    // The one gate write in the tool belongs to the account transition, and
    // supervision cannot reach it: a restart must never change a role's mode.
    expect((CLI.match(/applyGates\(/g) ?? [])).toHaveLength(1);
    const supervision = CLI.slice(
      CLI.indexOf("function restartOwnedRole"),
      CLI.indexOf("// Account-scoped SAFE <-> LIVE-READY transition")
    );
    for (const forbidden of ["applyGates", "writeAccountGates", "LIVE_READY_GATES"]) {
      expect(`supervision/${forbidden}:${supervision.includes(forbidden)}`).toBe(
        `supervision/${forbidden}:false`
      );
    }
  });

  it("runs every pass under the single-flight guard", () => {
    expect(CLI).toContain("await runSupervisionSingleFlight(async () => {");
  });

  it("derives health from the SAME projection the status screen uses", () => {
    // Two definitions of "is the worker healthy" would eventually disagree, and
    // the operator would be shown one while supervision acted on the other.
    // Both screens read `projectTopology`, and supervision reads the role rows
    // out of it rather than judging attestation a second time.
    expect(CLI).toContain("const status = projectTopology({");
    expect(CLI).toContain("status.roles.find((entry) => entry.role === workerRole)");
    expect(CLI).toContain("status.roles.find((entry) => entry.role === controlRole)");
  });

  it("tells the operator the honest scope before it starts", () => {
    expect(CLI).toContain("It runs only while this launcher is open.");
    expect(CLI).toContain("A SAFE runtime stays SAFE.");
  });

  it("stops entirely once recovery has failed", () => {
    expect(CLI).toContain('pass.result.decision.state === "WORKER_RECOVERY_FAILED"');
    expect(CLI).toContain("has STOPPED. Nothing further will be restarted.");
  });

  it("the whole-stack guards are untouched", () => {
    // Supervision must not have quietly weakened the second-stack refusal or
    // the shutdown safety check. Both are now dual-account.
    expect(CLI).toContain("evaluateDualStartPreconditions({");
    expect(CLI).toContain("evaluateDualShutdownSafety(states)");
  });
});

// ===========================================================================
// The health vocabulary is the launcher's own
// ===========================================================================

describe("supervision reuses the launcher's health model", () => {
  it("judgeRoleHealth still distinguishes exited from stale, which is what drives the two cases", () => {
    expect(judgeRoleHealth(false, null)).toBe("OFF");
    expect(judgeRoleHealth(true, { freshCount: 0, gates: null })).toBe("STALE");
    expect(judgeRoleHealth(true, { freshCount: 1, gates: null })).toBe("HEALTHY");
    expect(judgeRoleHealth(true, { freshCount: 2, gates: null })).toBe("DUPLICATE");
    expect(judgeRoleHealth(true, null)).toBe("UNKNOWN");
  });

  it("an exited worker and a stale worker take different paths", () => {
    const exited = decideWorkerSupervision(
      input({ workerHealth: "OFF", ownership: { owned: false, reason: "GONE" } })
    );
    const stale = decideWorkerSupervision(input({ workerHealth: "STALE", ownership: { owned: true } }));

    expect(exited.action).toBe("RESTART");
    expect(stale.action).toBe("TERMINATE_THEN_RESTART");
    expect(exited.terminatePid).toBeNull();
    expect(stale.terminatePid).not.toBeNull();
  });
});


// ===========================================================================
// Restart fencing: the sequence between "replace it" and a process existing
//
// Three defects, all of them about the window AFTER a decision is made:
//   1. a failed ownership re-proof skipped the kill and spawned anyway
//   2. nothing proved the terminated tree had actually gone
//   3. the census behind the decision was older than the kill that followed it
// ===========================================================================

describe("restart fencing: the pre-kill ownership re-proof", () => {
  const staleDecision = () => decideWorkerSupervision(input({ workerHealth: "STALE" }));

  it("1/2. a non-GONE re-proof terminates NOTHING and spawns NOTHING", () => {
    // PID_REUSED and NOT_THIS_REPO both mean the recorded pid may now belong to
    // somebody else's program. The recorded worker may ALSO still be alive, so
    // a replacement would be the second one for this account.
    const record = workerRecord();
    for (const [label, stranger] of [
      ["PID_REUSED", { pid: record.pid, startedAtMs: NOW, commandLine: probeOf(record).commandLine }],
      ["NOT_THIS_REPO", { pid: record.pid, startedAtMs: record.startedAtMs, commandLine: "cmd.exe /c pnpm -C C:\\other worker" }],
    ] as const) {
      const box = machine({ processes: new Map([[record.pid, stranger as ProcessProbe]]) });
      const result = executeWorkerRestart(staleDecision(), runtimeState(), 1, box.adapters);

      expect(`${label}:${result.outcome}`).toBe(`${label}:OWNERSHIP_LOST`);
      expect(`${label}:terminated=${box.terminated.length}`).toBe(`${label}:terminated=0`);
      expect(`${label}:spawned=${box.spawned.length}`).toBe(`${label}:spawned=0`);
      // It never even reached the census, because it never got near a spawn.
      expect(`${label}:census=${box.censusCalls.length}`).toBe(`${label}:census=0`);
    }
  });
});

describe("restart fencing: the post-kill exit proof", () => {
  it("4. a tree that survives the kill is TERMINATION_FAILED and spawns nothing", () => {
    // `taskkill` returning is not proof of disappearance. The old tree is
    // re-probed, still verifies as ours, and the replacement is refused.
    const record = workerRecord();
    const box = machine({
      processes: new Map([[record.pid, probeOf(record)]]),
      terminationFails: true,
    });

    const result = executeWorkerRestart(
      decideWorkerSupervision(input({ workerHealth: "STALE" })),
      runtimeState(),
      1,
      box.adapters
    );

    expect(result.outcome).toBe("TERMINATION_FAILED");
    expect(box.terminated).toEqual([record.pid]);
    expect(box.spawned).toEqual([]);
    expect(box.censusCalls).toEqual([]);
  });

  it("5. a tree proven gone after the kill yields exactly ONE replacement", () => {
    const record = workerRecord();
    const box = machine({ processes: new Map([[record.pid, probeOf(record)]]) });

    const result = executeWorkerRestart(
      decideWorkerSupervision(input({ workerHealth: "STALE" })),
      runtimeState(),
      1,
      box.adapters
    );

    expect(result.outcome).toBe("RESTARTED");
    expect(box.terminated).toEqual([record.pid]);
    expect(box.spawned).toHaveLength(1);
    // The census ran BEFORE the spawn, not after it.
    expect(box.censusCalls).toEqual([0]);
  });
});

describe("restart fencing: the fresh pre-spawn census", () => {
  it("6. a tree already gone before the kill spawns one, and kills nothing", () => {
    const box = machine();
    const result = executeWorkerRestart(
      decideWorkerSupervision(input({ workerHealth: "STALE" })),
      runtimeState(),
      1,
      box.adapters
    );

    expect(result.outcome).toBe("RESTARTED");
    expect(box.terminated).toEqual([]);
    expect(box.spawned).toHaveLength(1);
  });

  it("7. THE RACE: an external runtime appears after the kill -> NO spawn", () => {
    // The decision was made from a census taken before the kill. An operator
    // starting a worker by hand in that window must not be joined by this
    // replacement. This is the exact race the pre-spawn census exists for, and
    // nothing else in the sequence can see it.
    const record = workerRecord();
    const box = machine({
      processes: new Map([[record.pid, probeOf(record)]]),
      unaccounted: 0,
    });
    // Stage the late arrival at the moment the census is taken.
    const staged = machine({
      processes: new Map([[record.pid, probeOf(record)]]),
      unaccounted: 1,
    });

    const result = executeWorkerRestart(
      decideWorkerSupervision(input({ workerHealth: "STALE" })),
      runtimeState(),
      1,
      staged.adapters
    );

    expect(result.outcome).toBe("DUPLICATE_PRESENT");
    // The old tree was still terminated -- it was provably ours and unhealthy.
    expect(staged.terminated).toEqual([record.pid]);
    // But NO second runtime was created.
    expect(staged.spawned).toEqual([]);
    expect(box.spawned).toEqual([]);
  });

  it("7. the same refusal on the no-kill path", () => {
    const box = machine({ unaccounted: 2 });
    const result = executeWorkerRestart(
      decideWorkerSupervision(input({ workerHealth: "OFF", ownership: { owned: false, reason: "GONE" } })),
      runtimeState(),
      1,
      box.adapters
    );
    expect(result.outcome).toBe("DUPLICATE_PRESENT");
    expect(box.terminated).toEqual([]);
    expect(box.spawned).toEqual([]);
  });

  it("an unreadable census is refused, never read as absence", () => {
    const box = machine({ unaccounted: null });
    const result = executeWorkerRestart(
      decideWorkerSupervision(input({ workerHealth: "OFF", ownership: { owned: false, reason: "GONE" } })),
      runtimeState(),
      1,
      box.adapters
    );
    expect(result.outcome).toBe("CENSUS_UNAVAILABLE");
    expect(box.spawned).toEqual([]);
  });

  it("9. a healthy worker is a NOOP: no probe, no kill, no census, no spawn", () => {
    const box = machine();
    const result = executeWorkerRestart(decideWorkerSupervision(input()), runtimeState(), 1, box.adapters);
    expect(result.outcome).toBe("NOT_ATTEMPTED");
    expect(box.terminated).toEqual([]);
    expect(box.spawned).toEqual([]);
    expect(box.censusCalls).toEqual([]);
  });
});

describe("restart fencing: the role being replaced", () => {
  it("selects the record for the NAMED role and records the replacement as it", () => {
    // The dual launcher passes its own role. A pass for one role must not find
    // or replace another role's record.
    const generic = { role: "generic-analysis", pid: 7777, startedAtMs: NOW - 60_000 };
    const state = {
      repoRoot: REPO,
      processes: [
        { role: "account-a-worker", pid: 5555, startedAtMs: NOW - 60_000 },
        generic,
      ],
    };
    const box = machine({
      processes: new Map([
        [generic.pid, { pid: generic.pid, startedAtMs: generic.startedAtMs, commandLine: `cmd.exe /d /s /c pnpm -C ${REPO} --filter pkg worker` }],
      ]),
    });

    const decision = decideWorkerSupervision(
      input({ record: { role: "worker", pid: generic.pid, startedAtMs: generic.startedAtMs }, workerHealth: "STALE" })
    );
    const result = executeWorkerRestart(decision, state, 1, box.adapters, "generic-analysis");

    expect(result.outcome).toBe("RESTARTED");
    expect(box.terminated).toEqual([generic.pid]);
    expect(result.record?.role).toBe("generic-analysis");
  });

  it("finds nothing when the named role is not the recorded one", () => {
    // Same pid, wrong role: the lookup is by role AND pid, so this must not
    // terminate a record it was not asked about.
    const state = {
      repoRoot: REPO,
      processes: [{ role: "account-b-worker", pid: 4242, startedAtMs: NOW - 60_000 }],
    };
    const box = machine();
    const decision = decideWorkerSupervision(
      input({ record: { role: "worker", pid: 4242, startedAtMs: NOW - 60_000 }, workerHealth: "STALE" })
    );
    const result = executeWorkerRestart(decision, state, 1, box.adapters, "generic-analysis");

    expect(result.outcome).toBe("OWNERSHIP_LOST");
    expect(box.terminated).toEqual([]);
    expect(box.spawned).toEqual([]);
  });
});


// ===========================================================================
// Observation failure: "I could not look" is never "there is nothing there"
//
// `spawnSync` does not throw when PowerShell cannot be run. It returns a result
// carrying `error` or a non-zero `status` and empty stdout. Reading that as an
// empty process list made a blind launcher confident: every recorded pid looked
// GONE, every leaf count looked zero, and a replacement was authorised.
// ===========================================================================

describe("the process-observation result model", () => {
  it("classifies a successful command, empty output included", () => {
    // An empty answer from a working command is a REAL answer: nothing running.
    expect(classifySpawnResult({ status: 0, stdout: "" })).toEqual({ ok: true, value: "" });
    expect(classifySpawnResult({ status: 0, stdout: "1|2|x" })).toEqual({ ok: true, value: "1|2|x" });
  });

  it("A. rejects a command that could not be run", () => {
    expect(classifySpawnResult({ error: new Error("ENOENT"), status: null, stdout: "" })).toEqual({
      ok: false,
      reason: "COMMAND_FAILED",
    });
  });

  it("B. rejects a non-zero exit status", () => {
    expect(classifySpawnResult({ status: 1, stdout: "" })).toEqual({ ok: false, reason: "EXIT_STATUS" });
    expect(classifySpawnResult({ status: null, stdout: "" })).toEqual({ ok: false, reason: "EXIT_STATUS" });
  });

  it("keeps PROVEN ABSENT and COULD NOT OBSERVE distinguishable", () => {
    const absent = classifySpawnResult({ status: 0, stdout: "" });
    const blind = classifySpawnResult({ status: 1, stdout: "" });
    expect(absent.ok).toBe(true);
    expect(blind.ok).toBe(false);
  });
});

describe("restart fencing: an unobservable machine", () => {
  const staleDecision = () => decideWorkerSupervision(input({ workerHealth: "STALE" }));
  const exitedDecision = () =>
    decideWorkerSupervision(input({ workerHealth: "OFF", ownership: { owned: false, reason: "GONE" } }));

  it("D. a pre-kill probe that could not be made is NOT treated as GONE", () => {
    // The whole defect in one case: without this, the unobservable probe reads
    // as "the process is gone", which authorises a spawn with no kill.
    const record = workerRecord();
    const box = machine({ processes: new Map([[record.pid, probeOf(record)]]), unobservable: true });

    const result = executeWorkerRestart(staleDecision(), runtimeState(), 1, box.adapters);

    expect(result.outcome).toBe("OBSERVATION_UNAVAILABLE");
    expect(box.terminated).toEqual([]);
    expect(box.spawned).toEqual([]);
    expect(box.censusCalls).toEqual([]);
  });

  it("A/B. the same refusal whether the command failed or exited non-zero", () => {
    // Both arrive at the adapter as `observed: false`; the primitive does not
    // care which, only that nothing was seen.
    for (const label of ["COMMAND_FAILED", "EXIT_STATUS"] as const) {
      const record = workerRecord();
      const box = machine({ processes: new Map([[record.pid, probeOf(record)]]), unobservable: true });
      const result = executeWorkerRestart(staleDecision(), runtimeState(), 1, box.adapters);
      expect(`${label}:${result.outcome}`).toBe(`${label}:OBSERVATION_UNAVAILABLE`);
      expect(`${label}:spawned=${box.spawned.length}`).toBe(`${label}:spawned=0`);
    }
  });

  it("C. a census that could not be read refuses the spawn", () => {
    const box = machine({ unaccounted: null });
    const result = executeWorkerRestart(exitedDecision(), runtimeState(), 1, box.adapters);
    expect(result.outcome).toBe("CENSUS_UNAVAILABLE");
    expect(box.spawned).toEqual([]);
  });

  it("a post-kill probe that could not be made refuses the spawn", () => {
    // The kill was issued; whether it worked is now unknowable, so the old tree
    // cannot be assumed gone.
    const record = workerRecord();
    const processes = new Map([[record.pid, probeOf(record)]]);
    let calls = 0;
    const terminated: number[] = [];
    const spawned: number[] = [];
    const adapters = {
      // First probe (pre-kill) succeeds; the second (post-kill) cannot be made.
      probe: (pid: number) => {
        calls += 1;
        return calls === 1
          ? ({ observed: true, process: processes.get(pid) ?? null } as const)
          : ({ observed: false } as const);
      },
      terminate: (pid: number) => {
        terminated.push(pid);
        return true;
      },
      unaccountedLeaves: () => 0,
      spawnWorker: () => {
        spawned.push(9001);
        return 9001;
      },
      log: () => undefined,
    };

    const result = executeWorkerRestart(staleDecision(), runtimeState(), 1, adapters);

    expect(result.outcome).toBe("OBSERVATION_UNAVAILABLE");
    expect(terminated).toEqual([record.pid]);
    expect(spawned).toEqual([]);
  });

  it("E. a SUCCESSFUL empty observation still means genuinely absent", () => {
    // The guard must not be so broad that it blocks legitimate recovery: an
    // observed-empty machine is proof, and a replacement may start.
    const box = machine({ unaccounted: 0 });
    const result = executeWorkerRestart(staleDecision(), runtimeState(), 1, box.adapters);
    expect(result.outcome).toBe("RESTARTED");
    expect(box.spawned).toHaveLength(1);
  });

  it("F. a healthy observed machine is unchanged", () => {
    const box = machine();
    const result = executeWorkerRestart(decideWorkerSupervision(input()), runtimeState(), 1, box.adapters);
    expect(result.outcome).toBe("NOT_ATTEMPTED");
    expect(box.terminated).toEqual([]);
    expect(box.spawned).toEqual([]);
  });
});

describe("the launcher's own observation plumbing", () => {
  const SRC = readFileSync(
    path.resolve(__dirname, "../src/modules/operator/run-runtime-launcher.ts"),
    "utf8"
  );

  it("G. every process observation is classified, never read raw", () => {
    // The bug was `result.stdout ?? ""` with no check of `error` or `status`.
    // Both observers must go through the shared classifier.
    expect((SRC.match(/classifySpawnResult\(result\)/g) ?? [])).toHaveLength(2);
    expect(SRC).not.toContain("parseProcessProbeRows(result.stdout");
    // Both PROCESS observers parse the classified value, never raw stdout.
    // Both observers hand the classified output to the ONE strict parser.
    expect((SRC.match(/parseProcessRows\(classified\.value\)/g) ?? [])).toHaveLength(2);
    // `observeListeners` is deliberately NOT in scope: a listener feeds port
    // presence, never an ownership or absence verdict, so it cannot authorise
    // a spawn. Pinned so the exemption stays a decision, not an oversight.
    const listeners = SRC.slice(SRC.indexOf("function observeListeners"), SRC.indexOf("function buildProcessProbeQuery"));
    expect(listeners).toContain("result.stdout");
  });

  it("G. account, generic and status paths all consume the observation", () => {
    // Every consumer handles the failure branch explicitly rather than
    // destructuring a value that might not exist.
    expect((SRC.match(/if \(!ownership\.ok\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((SRC.match(/if \(!processes\.ok\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(SRC).toContain("if (!probed.ok)");
    // Stop Runtime keeping an unobservable record is proven BEHAVIOURALLY by
    // `judgeOwnedTree` above; here we only pin that the CLI honours the flag.
    expect(SRC).toContain("if (action.retainRecord) remaining.push(record);");
  });
});


// ===========================================================================
// Stop Runtime, Start SAFE rollback and Show Status, at their decision seams
//
// All three used to read a failed process observation as "the tree is GONE".
// For the two stop paths that meant skipping the kill -- harmless -- and, for
// Stop Runtime, DROPPING the ownership record, which leaves a live tree the
// launcher can never stop again. For Show Status it meant drawing six OFF
// roles, which looks exactly like a genuinely idle machine.
// ===========================================================================

describe("the shared stop decision for one owned tree", () => {
  const REPO_ROOT = REPO;
  const record = workerRecord();
  const ours = probeOf(record);
  const seen = (entries: [number, ProcessProbe][]) =>
    ({ ok: true, value: new Map(entries) }) as const;

  it("terminates a tree it can still prove it owns", () => {
    expect(judgeOwnedTree(record, seen([[record.pid, ours]]), REPO_ROOT)).toEqual({ act: "TERMINATE" });
  });

  // Named for what it actually covers: the DECISION. The rollback's own
  // retention is proven end-to-end by `executeRollback` below, because a
  // correct decision that the caller discards is worth nothing.
  it("the decision for an UNOBSERVABLE tree is SKIP with retainRecord", () => {
    // The approved semantics: UNKNOWN must not become ABSENT. The record stays
    // owned, so a later pass can still stop the tree.
    for (const reason of ["COMMAND_FAILED", "EXIT_STATUS", "UNPARSEABLE"] as const) {
      const action = judgeOwnedTree(record, { ok: false, reason }, REPO_ROOT);
      expect(`${reason}:${action.act}`).toBe(`${reason}:SKIP`);
      expect(action.act === "SKIP" && action.retainRecord).toBe(true);
      expect(action.act === "SKIP" && action.reason).toContain(reason);
    }
  });

  it("Start SAFE rollback: an unobservable tree is NOT reported as GONE", () => {
    // The precise regression: the reason string must name the observation
    // failure, never the ownership verdict that was never reached.
    const action = judgeOwnedTree(record, { ok: false, reason: "EXIT_STATUS" }, REPO_ROOT);
    expect(action.act).toBe("SKIP");
    expect(action.act === "SKIP" && action.reason).not.toContain("GONE");
    expect(action.act === "SKIP" && action.reason).toContain("could not be observed");
  });

  it("a PROVEN-absent or foreign tree is skipped AND its record dropped", () => {
    // Unchanged behaviour, pinned so the retain rule cannot quietly widen: a
    // record that provably names nothing of ours is not worth keeping.
    const gone = judgeOwnedTree(record, seen([]), REPO_ROOT);
    expect(gone).toEqual({ act: "SKIP", reason: "GONE", retainRecord: false });

    const recycled = judgeOwnedTree(record, seen([[record.pid, { ...ours, startedAtMs: NOW }]]), REPO_ROOT);
    expect(recycled).toEqual({ act: "SKIP", reason: "PID_REUSED", retainRecord: false });

    const foreign = judgeOwnedTree(
      record,
      seen([[record.pid, { ...ours, commandLine: "cmd.exe /c pnpm -C C:\\other worker" }]]),
      REPO_ROOT
    );
    expect(foreign).toEqual({ act: "SKIP", reason: "NOT_THIS_REPO", retainRecord: false });
  });

  it("never terminates on anything but a proven-owned tree", () => {
    const inputs = [
      { ok: false, reason: "COMMAND_FAILED" } as const,
      seen([]),
      seen([[record.pid, { ...ours, startedAtMs: NOW }]]),
    ];
    for (const probed of inputs) {
      expect(judgeOwnedTree(record, probed, REPO_ROOT).act).toBe("SKIP");
    }
  });
});

describe("Show Status refuses to render an unobservable machine", () => {
  const ok = { ok: true, value: [] } as const;

  it("reports nothing to refuse when every observation succeeded", () => {
    expect(firstObservationFailure(ok, ok)).toBeNull();
  });

  it("refuses when EITHER the ownership or the process read failed", () => {
    // Both are required to draw a topology. Either one missing means there is
    // no topology -- not an empty one.
    expect(firstObservationFailure({ ok: false, reason: "COMMAND_FAILED" }, ok)).toBe("COMMAND_FAILED");
    expect(firstObservationFailure(ok, { ok: false, reason: "EXIT_STATUS" })).toBe("EXIT_STATUS");
    expect(firstObservationFailure(ok, { ok: false, reason: "UNPARSEABLE" })).toBe("UNPARSEABLE");
  });

  it("reports the FIRST failure, so the message names a real cause", () => {
    expect(
      firstObservationFailure({ ok: false, reason: "COMMAND_FAILED" }, { ok: false, reason: "EXIT_STATUS" })
    ).toBe("COMMAND_FAILED");
  });
});

describe("the launcher wires those decisions where they matter", () => {
  const SRC = readFileSync(
    path.resolve(__dirname, "../src/modules/operator/run-runtime-launcher.ts"),
    "utf8"
  );

  it("Stop Runtime and the rollback share ONE stop decision", () => {
    // Stop Runtime calls the decision directly; the rollback reaches the same
    // decision through `executeRollback`, which is where its retention lives.
    expect((SRC.match(/judgeOwnedTree\(/g) ?? [])).toHaveLength(1);
    expect(SRC).toContain("executeRollback([...started].reverse(), REPO_ROOT, {");
    expect(SRC).toContain("if (action.retainRecord) remaining.push(record);");
  });

  it("the rollback persists what it could not resolve, instead of clearing", () => {
    const start = SRC.slice(SRC.indexOf("async function startSafe"), SRC.indexOf("async function stopRuntime"));
    // `clearState()` is now conditional on nothing being left unresolved.
    expect(start).toContain("if (complete) {");
    expect(start.indexOf("clearState();")).toBeGreaterThan(start.indexOf("if (complete) {"));
    expect(start).toContain("processes: retained });");
    expect(start).toContain("ROLLBACK INCOMPLETE");
  });

  it("Show Status throws rather than rendering, and the menu recovers", () => {
    expect(SRC).toContain("firstObservationFailure(ownership, processes)");
    expect(SRC).toContain("throw new ProcessObservationError(");
    expect(SRC).toContain("RUNTIME STATE UNKNOWN");
    // Control returns to the operator: retry, or leave.
    expect(SRC).toContain('if ((await ask("Retry? (y/N) ")).trim().toLowerCase() === "y") continue;');
    // And the refusal is never drawn as a topology.
    const menu = SRC.slice(SRC.indexOf("RUNTIME STATE UNKNOWN"));
    expect(menu.indexOf("renderTopology(")).toBeGreaterThan(menu.indexOf("break;"));
  });
});


// ===========================================================================
// BLOCKER 1: a rollback must not forget a tree it deliberately did not kill
//
// The rollback ended with an unconditional `clearState()`. A started role that
// could not be observed was correctly left alive -- and then had its ownership
// record deleted, leaving a possibly-running account runtime with no owner, no
// supervisor and no way for the launcher to stop it. UNKNOWN became ABSENT at
// the very last step.
// ===========================================================================

describe("Start SAFE rollback: unresolved trees keep their ownership", () => {
  const REPO_ROOT = REPO;
  const roleRecord = (role: string, pid: number) => ({ role, pid, startedAtMs: NOW - 60_000 });
  const ours = (pid: number, startedAtMs: number) => ({
    pid,
    startedAtMs,
    commandLine: `cmd.exe /d /s /c pnpm -C ${REPO} --filter pkg dev`,
  });

  /** A machine where some pids answer and some cannot be observed at all. */
  function machineFor(answers: Map<number, ProcessProbe>, blind: Set<number> = new Set()) {
    const terminated: number[] = [];
    const logs: string[] = [];
    return {
      terminated,
      logs,
      adapters: {
        probe: (pid: number) =>
          blind.has(pid)
            ? ({ ok: false, reason: "EXIT_STATUS" } as const)
            : ({ ok: true, value: new Map(answers.has(pid) ? [[pid, answers.get(pid)!]] : []) } as const),
        terminate: (pid: number) => {
          terminated.push(pid);
          return true;
        },
        log: (line: string) => logs.push(line),
      },
    };
  }

  it("A. one role terminates, one is UNOBSERVABLE -> only the unresolved one is retained", () => {
    const stopped = roleRecord("account-a-control", 101);
    const blind = roleRecord("account-a-worker", 202);
    const box = machineFor(new Map([[stopped.pid, ours(stopped.pid, stopped.startedAtMs)]]), new Set([blind.pid]));

    const result = executeRollback([blind, stopped], REPO_ROOT, box.adapters);

    // The observable one was stopped and is gone from the state.
    expect(box.terminated).toEqual([stopped.pid]);
    // The unobservable one was NOT killed and IS still owned.
    expect(result.retained).toEqual([blind]);
    expect(result.complete).toBe(false);
    expect(box.logs.join(" ")).toContain("still recorded");
  });

  it("B. everything terminated or proven gone -> state may be cleared", () => {
    const live = roleRecord("generic-backend", 303);
    const gone = roleRecord("generic-analysis", 404);
    // `gone` answers with no row: proven absent, not unobservable.
    const box = machineFor(new Map([[live.pid, ours(live.pid, live.startedAtMs)]]));

    const result = executeRollback([live, gone], REPO_ROOT, box.adapters);

    expect(box.terminated).toEqual([live.pid]);
    expect(result.retained).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it("C. several unobservable roles -> ALL of their records are retained", () => {
    const a = roleRecord("account-a-worker", 11);
    const b = roleRecord("account-b-worker", 22);
    const c = roleRecord("generic-analysis", 33);
    const box = machineFor(new Map(), new Set([a.pid, b.pid, c.pid]));

    const result = executeRollback([a, b, c], REPO_ROOT, box.adapters);

    expect(box.terminated).toEqual([]);
    expect(result.retained).toEqual([a, b, c]);
    expect(result.complete).toBe(false);
  });

  it("D. retained records stay identifiable for a later stop or supervision pass", () => {
    // They must survive with the exact identity fields ownership is proved
    // from, or a later pass would see them as fresh/unknown rather than ours.
    const blind = roleRecord("account-b-control", 77);
    const box = machineFor(new Map(), new Set([blind.pid]));

    const { retained } = executeRollback([blind], REPO_ROOT, box.adapters);

    expect(retained[0].pid).toBe(blind.pid);
    expect(retained[0].startedAtMs).toBe(blind.startedAtMs);
    expect(retained[0].role).toBe("account-b-control");
    // And that record still verifies as ours once the machine can be seen again.
    const probe = ours(blind.pid, blind.startedAtMs);
    expect(verifyOwnership(retained[0], probe, REPO_ROOT).owned).toBe(true);
  });

  it("a tree that is provably not ours is dropped, not retained", () => {
    // Unchanged: retention is for UNKNOWN only, never for a proven verdict.
    const foreign = roleRecord("generic-backend", 99);
    const box = machineFor(
      new Map([[foreign.pid, { ...ours(foreign.pid, foreign.startedAtMs), commandLine: "cmd.exe /c pnpm -C C:\\other dev" }]])
    );
    const result = executeRollback([foreign], REPO_ROOT, box.adapters);
    expect(box.terminated).toEqual([]);
    expect(result.retained).toEqual([]);
    expect(result.complete).toBe(true);
  });
});

// ===========================================================================
// BLOCKER 2: a census is all of the rows, or none of them
// ===========================================================================

describe("the process-row parser is all-or-nothing", () => {
  const row = (pid: number, ts: number, cmd = "node worker") => `${pid}|${ts}|${cmd}`;

  it("F. multiple valid rows are all returned", () => {
    const out = parseProcessRows([row(1, 1000, "a"), row(2, 2000, "b"), row(3, 3000, "c")].join("\r\n"));
    expect(out.ok).toBe(true);
    expect(out.ok && out.value).toHaveLength(3);
    expect(out.ok && out.value[1]).toEqual({ pid: 2, startedAtMs: 2000, commandLine: "b" });
  });

  it("I. a truly empty observation is still ABSENT, so recovery stays possible", () => {
    for (const empty of ["", "\r\n", "   \r\n  \r\n"]) {
      const out = parseProcessRows(empty);
      expect(out.ok).toBe(true);
      expect(out.ok && out.value).toEqual([]);
    }
  });

  it("E. one valid row + one malformed row -> UNPARSEABLE, subset discarded", () => {
    // The undercount this exists to prevent: returning just the valid row would
    // hide a process, and a hidden process is one a spawn can be started beside.
    const out = parseProcessRows([row(1, 1000, "a"), "this is not a row"].join("\r\n"));
    expect(out).toEqual({ ok: false, reason: "UNPARSEABLE" });
  });

  it("G. a truncated row poisons the whole census", () => {
    for (const bad of ["4096|", "4096", "|1000|x"]) {
      const out = parseProcessRows([row(1, 1000, "a"), bad].join("\r\n"));
      expect(`${bad} -> ${out.ok ? "ok" : out.reason}`).toBe(`${bad} -> UNPARSEABLE`);
    }
  });

  it("H. unexpected text mixed with valid rows -> UNPARSEABLE", () => {
    const noise = "Get-CimInstance : Access is denied.";
    expect(parseProcessRows([noise, row(1, 1000, "a")].join("\r\n"))).toEqual({
      ok: false,
      reason: "UNPARSEABLE",
    });
    expect(parseProcessRows([row(1, 1000, "a"), noise].join("\r\n"))).toEqual({
      ok: false,
      reason: "UNPARSEABLE",
    });
  });

  it("a non-numeric pid or timestamp is malformed, not coerced to NaN", () => {
    // The old parser accepted these: `!pid` was false for "abc", so it pushed a
    // row whose pid was NaN and could never match anything again.
    expect(parseProcessRows("abc|1000|x")).toEqual({ ok: false, reason: "UNPARSEABLE" });
    expect(parseProcessRows("1|notatime|x")).toEqual({ ok: false, reason: "UNPARSEABLE" });
  });

  it("an empty command line is a VALID row, not a malformed one", () => {
    // A process whose CommandLine is unreadable still emits three fields.
    const out = parseProcessRows(row(7, 7000, ""));
    expect(out.ok).toBe(true);
    expect(out.ok && out.value[0]).toEqual({ pid: 7, startedAtMs: 7000, commandLine: "" });
  });
});


// ===========================================================================
// The two fenced primitives, on their own
//
// An account runtime transition must stop the worker, stop the control plane,
// rewrite their gates and only THEN start them -- so it cannot use a restart
// that couples a stop to a spawn. These are that restart's two halves, and
// `executeWorkerRestart` is now built from them, so supervision and account
// transitions cannot drift into two answers about ownership or observation.
// ===========================================================================

describe("FENCED STOP on its own", () => {
  const record = workerRecord();
  const ours = probeOf(record);

  it("stops a proven-owned tree and proves it is gone — and spawns NOTHING", () => {
    const box = machine({ processes: new Map([[record.pid, ours]]) });
    const result = executeFencedStop(record, REPO, box.adapters);

    expect(result).toEqual({ stopped: true, alreadyGone: false });
    expect(box.terminated).toEqual([record.pid]);
    // The whole point of the split: a stop must not start anything.
    expect(box.spawned).toEqual([]);
    expect(box.censusCalls).toEqual([]);
  });

  it("an UNOBSERVABLE machine refuses: zero terminate, zero spawn", () => {
    const box = machine({ processes: new Map([[record.pid, ours]]), unobservable: true });
    const result = executeFencedStop(record, REPO, box.adapters);

    expect(result.stopped).toBe(false);
    expect(result.stopped === false && result.outcome).toBe("OBSERVATION_UNAVAILABLE");
    expect(box.terminated).toEqual([]);
    expect(box.spawned).toEqual([]);
  });

  it("PID_REUSED and NOT_THIS_REPO refuse: zero terminate, zero spawn", () => {
    for (const [label, stranger] of [
      ["PID_REUSED", { ...ours, startedAtMs: NOW }],
      ["NOT_THIS_REPO", { ...ours, commandLine: "cmd.exe /c pnpm -C C:\\other worker" }],
    ] as const) {
      const box = machine({ processes: new Map([[record.pid, stranger as ProcessProbe]]) });
      const result = executeFencedStop(record, REPO, box.adapters);
      expect(`${label}:${result.stopped}`).toBe(`${label}:false`);
      expect(result.stopped === false && result.outcome).toBe("OWNERSHIP_LOST");
      expect(`${label}:${box.terminated.length}`).toBe(`${label}:0`);
      expect(`${label}:${box.spawned.length}`).toBe(`${label}:0`);
    }
  });

  it("a tree that survives the kill is TERMINATION_FAILED", () => {
    const box = machine({ processes: new Map([[record.pid, ours]]), terminationFails: true });
    const result = executeFencedStop(record, REPO, box.adapters);
    expect(result.stopped === false && result.outcome).toBe("TERMINATION_FAILED");
    expect(box.terminated).toEqual([record.pid]);
    expect(box.spawned).toEqual([]);
  });

  it("an already-exited tree is a SUCCESSFUL stop with nothing killed", () => {
    const box = machine();
    const result = executeFencedStop(record, REPO, box.adapters);
    expect(result).toEqual({ stopped: true, alreadyGone: true });
    expect(box.terminated).toEqual([]);
  });

  it("no record means nothing to stop, and nothing is killed", () => {
    const box = machine({ processes: new Map([[record.pid, ours]]) });
    const result = executeFencedStop(null, REPO, box.adapters);
    expect(result.stopped === false && result.outcome).toBe("NOT_RECORDED");
    expect(box.terminated).toEqual([]);
  });
});

describe("FENCED START on its own", () => {
  it("spawns exactly one after a clean census — and terminates NOTHING", () => {
    const box = machine({ unaccounted: 0 });
    const result = executeFencedStart("account-a-control", box.adapters);

    expect(result.started).toBe(true);
    expect(box.spawned).toHaveLength(1);
    expect(box.terminated).toEqual([]);
    // The census ran BEFORE the spawn.
    expect(box.censusCalls).toEqual([0]);
  });

  it("an UNREADABLE census refuses to spawn", () => {
    const box = machine({ unaccounted: null });
    const result = executeFencedStart("account-a-control", box.adapters);
    expect(result.started === false && result.outcome).toBe("CENSUS_UNAVAILABLE");
    expect(box.spawned).toEqual([]);
  });

  it("an unexplained matching leaf refuses to spawn", () => {
    const box = machine({ unaccounted: 1 });
    const result = executeFencedStart("account-a-worker", box.adapters);
    expect(result.started === false && result.outcome).toBe("DUPLICATE_PRESENT");
    expect(box.spawned).toEqual([]);
    expect(box.terminated).toEqual([]);
  });

  it("a spawn whose creation time cannot be read is NOT a started role", () => {
    // A record with no creation time can never be ownership-verified, so a
    // transition that counted this as success would finish holding a role
    // nobody can later prove they own -- and therefore nobody can safely stop.
    const box = machine({ unaccounted: 0, unobservable: true });
    const recorded: { pid: number; startedAtMs: number }[] = [];
    const result = executeFencedStart("account-a-control", {
      ...box.adapters,
      recordOwnership: (pid, startedAtMs) => recorded.push({ pid, startedAtMs }),
    });

    expect(result.started).toBe(false);
    expect(result.started === false && result.outcome).toBe("OWNERSHIP_UNPROVEN");
    // Spawned, and deliberately NOT killed: an unproven process is unproven
    // in both directions.
    expect(box.spawned).toHaveLength(1);
    expect(box.terminated).toEqual([]);
    // The pid is still recorded, so an operator can see it -- with a creation
    // time that fails verification, which is what keeps the census counting it
    // as an unexplained leaf nothing may be spawned beside.
    expect(recorded).toEqual([{ pid: box.spawned[0], startedAtMs: 0 }]);
  });

  it("asks for the creation time a BOUNDED number of times", () => {
    let probes = 0;
    const box = machine({ unaccounted: 0 });
    executeFencedStart("account-a-worker", {
      ...box.adapters,
      probe: () => {
        probes += 1;
        return { observed: false };
      },
    });
    expect(probes).toBe(OWNERSHIP_PROOF_ATTEMPTS);
  });

  it("stops asking as soon as it has one", () => {
    let probes = 0;
    const box = machine({ unaccounted: 0 });
    const result = executeFencedStart("account-a-worker", {
      ...box.adapters,
      probe: (pid: number) => {
        probes += 1;
        return { observed: true, process: { pid, startedAtMs: NOW, commandLine: "x" } };
      },
    });
    expect(probes).toBe(1);
    expect(result.started).toBe(true);
  });

  it("records ownership the instant a pid exists, before returning", () => {
    // The spawn -> record window is one synchronous call. It cannot be closed
    // entirely, which is why recovery treats an unexplained leaf as UNKNOWN.
    const box = machine({ unaccounted: 0 });
    const recorded: { pid: number; startedAtMs: number }[] = [];
    const result = executeFencedStart("account-a-worker", {
      ...box.adapters,
      recordOwnership: (pid, startedAtMs) => recorded.push({ pid, startedAtMs }),
    });

    expect(result.started).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(result.started === true && recorded[0].pid).toBe(result.started === true ? result.pid : -1);
  });

  it("a spawn that returns no pid records nothing", () => {
    const box = machine({ unaccounted: 0, spawnPid: null });
    const recorded: number[] = [];
    const result = executeFencedStart("account-a-worker", {
      ...box.adapters,
      recordOwnership: (pid) => recorded.push(pid),
    });
    expect(result.started === false && result.outcome).toBe("SPAWN_FAILED");
    expect(recorded).toEqual([]);
  });
});

describe("restart supervision is BUILT from the two primitives", () => {
  const SRC = readFileSync(
    path.resolve(__dirname, "../src/modules/operator/worker-supervision.ts"),
    "utf8"
  );

  it("executeWorkerRestart calls them instead of re-implementing them", () => {
    const fn = SRC.slice(SRC.indexOf("export function executeWorkerRestart"));
    expect(fn).toContain("executeFencedStop(current, state.repoRoot, adapters)");
    expect(fn).toContain("executeFencedStart(role, adapters)");
    // And no longer performs the sequence itself.
    expect(fn).not.toContain("adapters.terminate(");
    expect(fn).not.toContain("adapters.spawnWorker(");
    expect(fn).not.toContain("verifyOwnership(");
  });

  it("there is exactly ONE terminate and ONE spawn call site in the module", () => {
    expect((SRC.match(/adapters\.terminate\(/g) ?? [])).toHaveLength(1);
    expect((SRC.match(/adapters\.spawnWorker\(/g) ?? [])).toHaveLength(1);
  });
});
