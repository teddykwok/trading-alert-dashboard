import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  judgeRoleHealth,
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
function machine(options: { processes?: Map<number, ProcessProbe>; spawnPid?: number | null } = {}) {
  const processes = options.processes ?? new Map<number, ProcessProbe>();
  const terminated: number[] = [];
  const spawned: number[] = [];
  const logs: string[] = [];
  let nextPid = options.spawnPid === undefined ? 9001 : options.spawnPid;
  return {
    processes,
    terminated,
    spawned,
    logs,
    adapters: {
      probe: (pid: number) => processes.get(pid) ?? null,
      terminate: (pid: number) => {
        terminated.push(pid);
        processes.delete(pid);
        return true;
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
    expect(verifyOwnership(result.record!, box.adapters.probe(result.newPid!), REPO).owned).toBe(true);
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

  it("offers one entry PER ACCOUNT, without displacing Exit", () => {
    // Phase 11I: supervision is account-explicit. One button that restarts
    // "the worker" is meaningless when two accounts each have one.
    expect(CLI).toContain("5. Supervise Account A Worker");
    expect(CLI).toContain("6. Supervise Account B Worker");
    expect(CLI).toContain("7. Exit");
    expect(CLI).toContain('else if (choice === "5") await superviseAccountWorker("ACCOUNT_A", ask);');
    expect(CLI).toContain('else if (choice === "6") await superviseAccountWorker("ACCOUNT_B", ask);');
    expect(CLI).toContain('else if (choice === "7") break;');
  });

  it("spawns the replacement for the SAME account, never the other one", () => {
    // The role is fixed at the top of the supervision pass from the account
    // being supervised, and the plan derives the env file from the role. A
    // restart therefore cannot change which account the worker is.
    expect(CLI).toContain("dualSpawnPlan(workerRole, REPO_ROOT)");
    expect(CLI).toContain(
      'const workerRole: DualRole = account === "ACCOUNT_A" ? "account-a-worker" : "account-b-worker";'
    );
    // No gate write was introduced anywhere in the tool.
    expect(`applyGates:${CLI.includes("applyGates")}`).toBe("applyGates:false");
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
