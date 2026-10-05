import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ObservedListener, ObservedProcess } from "../src/modules/operator/dual-account-topology";

/**
 * REAL-WIRING regression for the two bugs the Native planner operational smoke found.
 *
 * 1. Supervision is driven through the launcher MODULE (createNativePlannerLauncher -> start() -> supervise()), its
 *    real state file, its real record/ownership wiring and the reviewed ladder -- never the decision helper alone.
 *    A fake process table stands in for the machine: a spawned root carries the repo path (as the real cmd/pnpm
 *    wrapper does) and owns one runtime leaf; "the planner crashed" removes the whole tree, exactly as the smoke saw.
 * 2. The status read waits (bounded) for its own Redis connection instead of racing it.
 */

const { createNativePlannerLauncher } = await import("../src/modules/operator/native-planner-launcher");
const { WORKER_RESTART_MAX_ATTEMPTS } = await import("../src/modules/operator/worker-supervision");
const { readNativePlannerStatus, waitForRedisReady, NATIVE_PLANNER_STATUS_REDIS_READY_TIMEOUT_MS } = await import("../src/modules/native-planning/native-planner-status");
const { nativePlannerRoutes } = await import("../src/routes/native-planner.routes");

const PLANNER_ENTRY = "src/modules/native-planning/native-plan.worker.ts";
const leaf = (entrypoint: string, pid: number, startedAtMs = 1_000): ObservedProcess => ({ pid, startedAtMs, commandLine: `"C:\\Program Files\\nodejs\\node.exe" --require preflight.cjs ${entrypoint}` });
const BACKEND_LEAF = leaf("src/server.ts", 11);
const LISTENERS: ObservedListener[] = [{ port: 4000, address: "0.0.0.0", pid: 11 }];

/** A fake machine around the REAL launcher module. Every pass and every decision is the module's own. */
function machine(options: { spawnFails?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "native-planner-wiring-"));
  const envDir = path.join(dir, "trading-alert-dashboard", "env");
  mkdirSync(envDir, { recursive: true });
  writeFileSync(path.join(envDir, "generic.env"), "DATABASE_URL=postgresql://x\nREDIS_URL=redis://x\n");
  const repoRoot = path.join(dir, "repo");
  const table = new Map<number, ObservedProcess>([[11, BACKEND_LEAF]]);
  let nextPid = 500;
  const spawns: number[] = [];
  const spawnAttempts: number[] = [];
  const killed: number[] = [];
  const locks: string[] = [];
  const lines: string[] = [];
  const passHooks: Array<() => void> = [];
  let probeOk = true;
  const adapters = {
    repoRoot,
    statePath: path.join(dir, "state", "runtime-launcher-state.json.native-planner.json"),
    env: { LOCALAPPDATA: dir, PATH: "p" } as NodeJS.ProcessEnv,
    observeProcesses: () => ({ ok: true as const, value: [...table.values()] }),
    observeListeners: () => LISTENERS,
    probeProcesses: (pids: number[]) =>
      probeOk
        ? { ok: true as const, value: new Map(pids.flatMap((pid) => (table.has(pid) ? [[pid, { pid, commandLine: table.get(pid)!.commandLine, startedAtMs: table.get(pid)!.startedAtMs }] as const] : []))) }
        : { ok: false as const, reason: "COMMAND_FAILED" as const },
    terminate: (pid: number) => {
      killed.push(pid);
      table.delete(pid);
      table.delete(pid + 1);
      return true;
    },
    spawnRole: () => {
      spawnAttempts.push(Date.now());
      if (options.spawnFails) return null;
      const root = nextPid;
      nextPid += 10;
      table.set(root, { pid: root, startedAtMs: 2_000, commandLine: `cmd.exe /d /s /c pnpm -C ${repoRoot} --filter @trading-alert-dashboard/backend native-alerts:plan-worker` });
      table.set(root + 1, leaf(PLANNER_ENTRY, root + 1));
      spawns.push(root);
      return root;
    },
    gateAllows: () => true,
    readTransitionMarker: () => ({ status: "NONE" as const }),
    lockAdapters: () => ({ authority: { acquire: async (action: string) => (locks.push(action), { ok: true as const, held: { action, release: async () => ({ released: true }) } }) }, log: () => undefined }) as never,
    log: (line: string) => void lines.push(line),
    // Between supervision passes: run the next scripted step; when the script is exhausted, end the (infinite) loop.
    sleep: async () => {
      const hook = passHooks.shift();
      if (!hook) throw new Error("END_OF_SCRIPT");
      hook();
    },
  };
  const launcher = createNativePlannerLauncher(adapters as never);
  const state = () => JSON.parse(readFileSync(adapters.statePath, "utf8")) as { processes: Array<{ pid: number; role: string }> };
  const leaves = () => [...table.values()].filter((p) => p.commandLine.includes(PLANNER_ENTRY)).length;
  /** Runs supervise() through the scripted passes. Each hook runs AFTER one pass, before the next. */
  const supervise = async (...hooks: Array<() => void>) => {
    passHooks.push(...hooks);
    await launcher.supervise(async () => "y").catch((error: Error) => {
      if (error.message !== "END_OF_SCRIPT") throw error;
    });
  };
  const verdicts = () => lines.filter((l) => / supervision: /.test(l)).map((l) => l.replace(/^\[[0-9:]+\] /, ""));
  return { adapters, table, launcher, spawns, spawnAttempts, killed, locks, lines, state, leaves, supervise, verdicts, crash: (root: number) => (table.delete(root), table.delete(root + 1)), setProbeOk: (ok: boolean) => (probeOk = ok) };
}

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// Bug 1 -- supervision restarts a launcher-owned planner whose tree has exited
// ===========================================================================

describe("Bug 1: the real launcher-module wiring restarts a crashed, launcher-owned planner exactly once", () => {
  it("record -> healthy -> tree gone -> exactly ONE replacement, ownership moves to it -> next pass healthy, no second spawn", async () => {
    const m = machine();
    await m.launcher.start(); // 1. menu 11: fenced start writes the ownership record
    expect(m.spawns).toEqual([500]);
    expect(m.state().processes.map((p) => p.pid)).toEqual([500]);
    expect(m.leaves()).toBe(1); // 2. alive

    await m.supervise(
      () => m.crash(500), // after pass 1 (healthy): 4. the whole tree disappears, as in the smoke
      () => undefined, //   after pass 2 (restart): let pass 3 judge the replacement
    );

    const verdicts = m.verdicts();
    expect(verdicts[0]).toMatch(/supervision: WORKER_HEALTHY/); // 3. healthy, nothing done
    expect(m.lines.join("\n")).toMatch(/worker supervision: attempt 1\/3 — WORKER_EXITED \(no live process\)/); // 5. real wiring saw GONE
    expect(m.spawns).toEqual([500, 510]); // 6. exactly ONE replacement
    expect(m.killed).toEqual([]); // nothing to kill: the old tree was already gone
    expect(m.state().processes.map((p) => p.pid)).toEqual([510]); // 7. ownership moved to the replacement
    expect(verdicts[verdicts.length - 1]).toMatch(/supervision: WORKER_HEALTHY/); // 8. next pass healthy...
    expect(m.leaves()).toBe(1); // ...and still exactly one planner
    expect(m.locks).toEqual(["NATIVE_PLANNER_START", "SUPERVISE_RESTART"]); // the restart held the mutation lock
    expect(m.lines.join("\n")).not.toMatch(/No launcher-owned Native planner is recorded/);
  });

  it("A. a launcher-owned planner that is alive is healthy: no restart, no kill, no lock", async () => {
    const m = machine();
    await m.launcher.start();
    await m.supervise(() => undefined, () => undefined);
    expect(m.verdicts().every((v) => /WORKER_HEALTHY/.test(v))).toBe(true);
    expect([m.spawns, m.killed, m.locks]).toEqual([[500], [], ["NATIVE_PLANNER_START"]]);
  });

  it("C. a stored record whose PID now belongs to another process (PID reuse) fails closed: nothing killed, nothing started", async () => {
    const m = machine();
    await m.launcher.start();
    m.crash(500);
    m.table.set(500, { pid: 500, startedAtMs: 999_999, commandLine: "some unrelated program" }); // PID reused
    await m.supervise(() => undefined);
    expect(m.lines.join("\n")).toMatch(/The recorded Native planner PID could not be proven to be ours\. Nothing was terminated and nothing was started\./);
    expect(m.verdicts().at(-1)).toMatch(/supervision: WORKER_DEGRADED/);
    expect([m.spawns, m.killed]).toEqual([[500], []]);
    expect(m.state().processes.map((p) => p.pid)).toEqual([500]); // the record is kept, not guessed away
  });

  it("C. an unobservable machine (probe failed) changes nothing: UNKNOWN never becomes GONE", async () => {
    const m = machine();
    await m.launcher.start();
    m.crash(500);
    m.setProbeOk(false);
    await m.supervise(() => undefined);
    expect(m.lines.join("\n")).toMatch(/processes could not be observed \(COMMAND_FAILED\) — nothing was changed/);
    expect([m.spawns, m.killed]).toEqual([[500], []]);
  });

  it("D. our planner is gone but a FOREIGN planner is already consuming: no replacement is added beside it", async () => {
    const m = machine();
    await m.launcher.start();
    m.crash(500);
    m.table.set(900, leaf(PLANNER_ENTRY, 900)); // started by hand, not ours
    await m.supervise(() => undefined);
    expect(m.spawns).toEqual([500]);
    expect(m.leaves()).toBe(1);
    // and an explicit start refuses too
    await m.launcher.start();
    expect(m.spawns).toEqual([500]);
    expect(m.lines.join("\n")).toMatch(/ALREADY_RUNNING_EXTERNAL/);
  });

  it("no record at all (never launcher-owned): supervision owns nothing and never starts one", async () => {
    const m = machine();
    await m.supervise(() => undefined);
    expect(m.spawnAttempts).toEqual([]);
    expect(m.lines.join("\n")).toMatch(/No launcher-owned Native planner is recorded/);
  });

  it("F/G. a failing replacement is governed by the existing budget/backoff: exactly 3 attempts, then recovery STOPS and says so", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-05T03:00:00Z"));
    const m = machine({ spawnFails: false });
    await m.launcher.start();
    m.spawnAttempts.length = 0; // count REPLACEMENT attempts only
    m.adapters.spawnRole = (() => (m.spawnAttempts.push(Date.now()), null)) as never; // every replacement now fails
    m.crash(500);
    const advance = (ms: number) => () => vi.setSystemTime(Date.now() + ms);
    // 12 passes, 10 minutes apart: far beyond every stabilization / backoff window.
    await m.supervise(...Array.from({ length: 12 }, () => advance(10 * 60_000)));
    expect(m.spawnAttempts).toHaveLength(WORKER_RESTART_MAX_ATTEMPTS); // exactly the reviewed budget
    expect(m.lines.join("\n")).toMatch(/failed to come back across 3 restart attempts\. Automatic recovery has stopped; operator intervention is required/);
    expect(m.lines.join("\n")).toMatch(/Automatic recovery for the Native Planner Worker has STOPPED/);
    expect(m.leaves()).toBe(0);
  });

  it("F. right after a failed attempt the next pass waits (stabilization/backoff) instead of retrying immediately", async () => {
    const m = machine();
    await m.launcher.start();
    m.spawnAttempts.length = 0; // count REPLACEMENT attempts only
    m.adapters.spawnRole = (() => (m.spawnAttempts.push(Date.now()), null)) as never;
    m.crash(500);
    await m.supervise(() => undefined, () => undefined);
    expect(m.spawnAttempts).toHaveLength(1);
    expect(m.lines.join("\n")).toMatch(/started moments ago and is still coming up; its health is not judged yet|waiting out the restart backoff/);
    expect(m.verdicts().at(-1)).toMatch(/supervision: WORKER_RESTARTING/);
  });

  it("H. menu 13 still proves ownership before any kill, and a stop after a crash just clears the dead record", async () => {
    const m = machine();
    await m.launcher.start();
    await m.launcher.stop();
    expect(m.killed).toEqual([500]);
    expect(m.state().processes).toEqual([]);
    await m.launcher.start();
    m.crash(510);
    await m.launcher.stop();
    expect(m.killed).toEqual([500]); // nothing alive to kill
    expect(m.lines.join("\n")).toMatch(/fenced stop: pid 510 had already exited/);
    expect(m.state().processes).toEqual([]);
  });
});

describe("I/J. the six-role runtime paths are untouched by this fix", () => {
  it("Start SAFE and Stop Runtime still never mention the Native planner", () => {
    const cli = readFileSync(path.resolve(__dirname, "../src/modules/operator/run-runtime-launcher.ts"), "utf8");
    const startSafe = cli.slice(cli.indexOf("async function startSafe()"), cli.indexOf("async function stopRuntime()"));
    const stopRuntime = cli.slice(cli.indexOf("async function stopRuntime()"), cli.indexOf("function unaccountedLeavesFor"));
    expect(startSafe).not.toMatch(/native/i);
    expect(stopRuntime).not.toMatch(/native/i);
    expect(startSafe).toContain("for (const role of DUAL_ROLES) {");
  });

  it("the Native module now uses the account-worker supervisor's durable-record pattern", () => {
    const module = readFileSync(path.resolve(__dirname, "../src/modules/operator/native-planner-launcher.ts"), "utf8");
    expect(module).toContain("record: durable === null ? null : { pid: durable.pid, startedAtMs: durable.startedAtMs },");
    expect(module).toContain("verdict: verifyOwnership(durable, probed.value.get(durable.pid) ?? null, state!.repoRoot)");
    expect(module).not.toContain("ownership: record === null ? null : { owned: true },");
  });
});

// ===========================================================================
// Bug 2 -- the first status read waits for its own Redis connection (bounded)
// ===========================================================================

class FakeRedisClient extends EventEmitter {
  constructor(public status: string) {
    super();
  }
  becomeReady(afterMs: number) {
    setTimeout(() => {
      this.status = "ready";
      this.emit("ready");
    }, afterMs);
  }
}

const NOW = () => new Date("2026-10-05T03:00:10Z");
const FRESH = JSON.stringify({ schema: "teddy.native-planner.heartbeat.v1", role: "native-planner", queue: "native-extreme-rr-plan", pid: 424242, startedAt: "2026-10-05T03:00:00Z", beatAt: "2026-10-05T03:00:05Z", consumerRunning: true, lastSweep: null, lastSweepError: null, nativeExecutionEnabled: false });
const JOBS = { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 1 };

/** Status deps wired to a fake client: the Redis reads fail unless the client is READY, like ioredis with no offline queue. */
function statusDeps(client: FakeRedisClient, heartbeat: string | null, consumers: number, timeoutMs?: number) {
  const calls = { heartbeat: 0, stats: 0 };
  const requireReady = () => {
    if (client.status !== "ready") throw Object.assign(new Error("Stream isn't writeable and enableOfflineQueue options is false"), { name: "Error" });
  };
  return {
    calls,
    deps: {
      queue: "native-extreme-rr-plan",
      now: NOW,
      redisReady: () => waitForRedisReady(client, timeoutMs),
      readHeartbeat: async () => (calls.heartbeat++, requireReady(), heartbeat),
      queueStats: async () => (calls.stats++, requireReady(), { connectedConsumers: consumers, jobs: JOBS }),
      countPendingNativePlans: async () => 0,
    },
  };
}

describe("Bug 2: the first status read is not a false DEGRADED", () => {
  it("1/2. the FIRST request while the connection is still establishing waits for it and reports the real state: OFF / DOWN", async () => {
    const client = new FakeRedisClient("connecting");
    client.becomeReady(40);
    const { deps } = statusDeps(client, null, 0);
    const status = await readNativePlannerStatus(deps);
    expect([status.worker.state, status.readiness, status.connectedConsumers, status.pendingNativePlans]).toEqual(["OFF", "DOWN", 0, 0]);
  });

  it("without the readiness wait, the same first request IS the false DEGRADED the smoke saw (the race is real)", async () => {
    const client = new FakeRedisClient("connecting");
    client.becomeReady(40);
    const { deps } = statusDeps(client, null, 0);
    const { redisReady: _skipped, ...raced } = deps;
    const status = await readNativePlannerStatus(raced);
    expect([status.worker.state, status.readiness]).toEqual(["UNREADABLE", "DEGRADED"]);
  });

  it("3. planner running, fresh heartbeat, one consumer: RUNNING / READY on the first request too", async () => {
    const client = new FakeRedisClient("connect");
    client.becomeReady(20);
    const status = await readNativePlannerStatus(statusDeps(client, FRESH, 1).deps);
    expect([status.worker.state, status.readiness, status.connectedConsumers, status.worker.ageSeconds]).toEqual(["RUNNING", "READY", 1, 5]);
  });

  it("4. Redis genuinely unavailable (connection ended): DEGRADED / UNREADABLE, the Redis reads are not even attempted", async () => {
    const client = new FakeRedisClient("end");
    const { deps, calls } = statusDeps(client, null, 0);
    const status = await readNativePlannerStatus(deps);
    expect([status.worker.state, status.readiness, status.connectedConsumers, status.jobs, status.pendingNativePlans]).toEqual(["UNREADABLE", "DEGRADED", null, null, 0]);
    expect(status.worker.reason).toMatch(/the Redis connection has ended/);
    expect(calls).toEqual({ heartbeat: 0, stats: 0 });
  });

  it("5. a connection that never becomes ready is BOUNDED: it fails truthfully after the timeout, never hangs", async () => {
    const client = new FakeRedisClient("reconnecting");
    const started = Date.now();
    const { deps, calls } = statusDeps(client, null, 0, 60);
    const status = await readNativePlannerStatus(deps);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect([status.worker.state, status.readiness]).toEqual(["UNREADABLE", "DEGRADED"]);
    expect(status.worker.reason).toMatch(/not ready within 60 ms/);
    expect(calls).toEqual({ heartbeat: 0, stats: 0 });
    expect(client.listenerCount("ready") + client.listenerCount("end")).toBe(0); // no leaked listeners
    expect(NATIVE_PLANNER_STATUS_REDIS_READY_TIMEOUT_MS).toBe(2_000);
  });

  it("an already-ready client is not delayed; a ready client whose read genuinely fails is still UNREADABLE", async () => {
    const ready = new FakeRedisClient("ready");
    await expect(waitForRedisReady(ready, 10)).resolves.toBeUndefined();
    const failing = { ...statusDeps(ready, null, 0).deps, readHeartbeat: async () => Promise.reject(new Error("WRONGTYPE")) };
    const status = await readNativePlannerStatus(failing);
    expect([status.worker.state, status.readiness]).toEqual(["UNREADABLE", "DEGRADED"]);
  });

  it("6/7. the route is GET-only, read-only, waits for readiness, and leaks no pid or secret", async () => {
    const client = new FakeRedisClient("connecting");
    client.becomeReady(30);
    const app = Fastify();
    await app.register(nativePlannerRoutes, { deps: statusDeps(client, FRESH, 1).deps });
    const response = await app.inject({ method: "GET", url: "/api/native-planner/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ readiness: "READY", worker: { state: "RUNNING" } });
    expect(response.body).not.toContain("424242");
    expect(response.body).not.toMatch(/redis:\/\/|postgres|password|secret/i);
    expect((await app.inject({ method: "POST", url: "/api/native-planner/status" })).statusCode).toBe(404);
    await app.close();
    const route = readFileSync(path.resolve(__dirname, "../src/routes/native-planner.routes.ts"), "utf8");
    expect(route).toContain("redisReady: () => waitForRedisReady(client),");
    expect(route).not.toMatch(/\.add\(|\.create\(|\.update\(|\.delete\(|\.set\(|spawn|native-plan\.worker/);
  });
});
