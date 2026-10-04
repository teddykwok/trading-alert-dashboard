import { readFileSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Alert, PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";
import { BAR0, M15, bar, commit, logOf, observation } from "./helpers/native-alert-fixtures";
import type { SnapshotCandle } from "../src/modules/market-data/market-data.types";
import type { ObservedListener, ObservedProcess } from "../src/modules/operator/dual-account-topology";

/**
 * OPERATING THE NATIVE PLANNER WORKER: a separate, optional, generic role that the runtime launcher can start,
 * supervise and stop (never as part of Start SAFE, never from `pnpm dev`), with a Redis heartbeat and a read-only
 * backend status. Planning semantics (one plan per alert, READY frozen, PENDING-only recovery) are unchanged.
 * TEST database only; Redis/BullMQ are fakes; no Binance request of any kind.
 */

const tvQueue = vi.hoisted(() => ({ enqueueVisionAnalysis: vi.fn(async () => undefined), enqueueExtremeRRPlan: vi.fn(async () => undefined) }));
vi.mock("../src/modules/jobs/queue", () => tvQueue);

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient = testDatabase;
const maybe = () => (available ? it : it.skip);

const topology = await import("../src/modules/operator/dual-account-topology");
const { DUAL_ROLES, OPTIONAL_GENERIC_ROLES, ROLE_CONTRACTS, censusOf, classifyEntrypoint, dualSpawnPlan, projectTopology, sanitizedChildEnv } = topology;
const supervision = await import("../src/modules/operator/native-planner-supervision");
const { EMPTY_RESTART_BUDGET, WORKER_RESTART_MAX_ATTEMPTS } = await import("../src/modules/operator/worker-supervision");
const { MUTATION_ACTIONS } = await import("../src/modules/operator/mutation-lock");
const heartbeatModule = await import("../src/modules/native-planning/native-planner-heartbeat");
const { createHeartbeatPublisher, judgeNativePlannerHeartbeat, NATIVE_PLANNER_HEARTBEAT_KEY, NATIVE_PLANNER_HEARTBEAT_STALE_MS } = heartbeatModule;
const { startNativePlannerRuntime } = await import("../src/modules/native-planning/native-planner-runtime");
const { readNativePlannerStatus } = await import("../src/modules/native-planning/native-planner-status");
const { nativePlannerRoutes } = await import("../src/routes/native-planner.routes");
const { NATIVE_EXTREME_RR_QUEUE_NAME } = await import("../src/modules/native-planning/native-plan-queue");
const { processNativePlanJob, runNativePlanRecoverySweep, NATIVE_PLAN_RECOVERY_GRACE_MS } = await import("../src/modules/native-planning/native-plan-processor");
const { createNativePlanRequester, afterNativeAlertCommitted } = await import("../src/modules/native-planning/native-plan-request");
const { ExtremeRRService } = await import("../src/modules/extreme-rr/extreme-rr.service");
const { PrismaNativeDeliveryLedger } = await import("../src/modules/native-alerts/native-alert-ledger");
const { selectNativeDeliveriesV2 } = await import("../src/modules/native-alerts/native-delivery-policy-v2");
const { parseShadowEventLog } = await import("../src/modules/native-alerts/shadow-log-reader");
const { TEDDY_7_ALL_ACTIVE_V1, profileSummaryOf } = await import("../src/modules/native-scanner/scanner-profile");

const BACKEND = path.resolve(__dirname, "..");
const ROOT = path.resolve(BACKEND, "..", "..");
const read = (rel: string) => readFileSync(path.join(BACKEND, rel), "utf8").replace(/\r\n/g, "\n");
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const PLANNER_ENTRY = "src/modules/native-planning/native-plan.worker.ts";

// ---------------------------------------------------------------------------
// Census fixtures
// ---------------------------------------------------------------------------
const leaf = (entrypoint: string, pid: number): ObservedProcess => ({ pid, startedAtMs: 1_000, commandLine: `"C:\\Program Files\\nodejs\\node.exe" --require preflight.cjs ${entrypoint}` });
const pnpmWrapper = (entrypoint: string, pid: number): ObservedProcess => ({ pid, startedAtMs: 1_000, commandLine: `"node.exe" C:/Users/x/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.mjs exec tsx ${entrypoint}` });
const LISTENERS: ObservedListener[] = [{ port: 4000, address: "0.0.0.0", pid: 11 }];
const statusOf = (processes: ObservedProcess[]) => projectTopology({ census: censusOf(processes, LISTENERS), ownedRoles: [], attestation: {} });
const BACKEND_LEAF = leaf("src/server.ts", 11);

// ===========================================================================
// 1-3, 6-8. A separate, optional, generic role
// ===========================================================================

describe("a separate, optional, generic role", () => {
  it("1. the Native planner is its own role: generic env, its own script and entrypoint, no port, no attestation", () => {
    expect(ROLE_CONTRACTS["native-planner"]).toEqual({
      role: "native-planner", label: "Native Planner Worker", account: "GENERIC", envAlias: "generic", filter: "@trading-alert-dashboard/backend",
      script: "native-alerts:plan-worker", entrypoint: PLANNER_ENTRY, port: null, loopbackOnly: false, attests: null,
    });
    for (const other of DUAL_ROLES) expect(ROLE_CONTRACTS[other].entrypoint).not.toBe(PLANNER_ENTRY);
    expect(supervision.isOptionalGenericRole("native-planner")).toBe(true);
    // Recognised by the census as itself, never as the analysis worker or an account worker; wrappers are not counted.
    expect(classifyEntrypoint(leaf(PLANNER_ENTRY, 1).commandLine)).toBe(PLANNER_ENTRY);
    expect(classifyEntrypoint(pnpmWrapper(PLANNER_ENTRY, 2).commandLine)).toBeNull();
  });

  it("1/3. it is OPTIONAL: not one of the six SAFE roles, so Start SAFE never starts it and topology verification never requires it", () => {
    expect([...DUAL_ROLES]).toEqual(["generic-backend", "generic-analysis", "account-a-control", "account-a-worker", "account-b-control", "account-b-worker"]);
    expect([...OPTIONAL_GENERIC_ROLES]).toEqual(["native-planner"]);
    expect(statusOf([BACKEND_LEAF, leaf(PLANNER_ENTRY, 21)]).roles.map((r) => r.role)).not.toContain("native-planner");
    const cli = code(read("src/modules/operator/run-runtime-launcher.ts"));
    const startSafe = cli.slice(cli.indexOf("async function startSafe()"), cli.indexOf("async function stopRuntime()"));
    expect(startSafe).toContain("for (const role of DUAL_ROLES) {");
    expect(startSafe).not.toMatch(/native|NATIVE_PLANNER/);
    const stop = cli.slice(cli.indexOf("async function stopRuntime()"), cli.indexOf("function unaccountedLeavesFor"));
    expect(stop).not.toMatch(/native|NATIVE_PLANNER/);
    // Its ownership record lives in its own file, so Start SAFE / rollback / Stop Runtime can never erase or block on it.
    expect(cli).toContain("statePath: `${defaultStatePath()}.native-planner.json`,");
    // The CLI hands the module ITS OWN fenced primitives, by reference: the one gate printer, the probe, the lock, the spawner.
    for (const wiring of ["terminate: terminateTree,", "gateAllows: transitionGateAllows,", "spawnRole: spawnRoleWithDurableLog,", "    lockAdapters,", "    probeProcesses,", "    readTransitionMarker,"]) {
      expect(cli).toContain(wiring);
    }
  });

  it("2. `pnpm dev` does not start it: dev runs only the backend and frontend; the worker is its own explicit script", () => {
    const rootPkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(rootPkg.scripts.dev).toBe('pnpm build:shared && concurrently -k -n backend,frontend -c blue,green "pnpm dev:backend" "pnpm dev:frontend"');
    expect(pkg.scripts.dev).toBe("tsx watch src/server.ts");
    expect(pkg.scripts.worker).toBe("tsx watch src/modules/jobs/vision-analysis.worker.ts");
    expect(pkg.scripts["native-alerts:plan-worker"]).toBe("tsx src/modules/native-planning/native-plan.worker.ts");
    for (const [name, command] of Object.entries({ ...rootPkg.scripts, ...pkg.scripts })) {
      if (name === "native-alerts:plan-worker") continue;
      expect({ name, hit: /native-plan\.worker|plan-worker/.test(command) }).toEqual({ name, hit: false });
    }
    for (const rel of ["src/server.ts", "src/app.ts", "src/modules/jobs/vision-analysis.worker.ts", "src/modules/jobs/execution.worker.ts"]) {
      expect({ rel, hit: /native-plan\.worker|native-planner-runtime|startNativePlannerRuntime/.test(read(rel)) }).toEqual({ rel, hit: false });
    }
  });

  it("3. the launcher actions are explicit menu entries; every mutation is locked, fenced and gated in its own module", () => {
    const cli = code(read("src/modules/operator/run-runtime-launcher.ts"));
    expect(cli).toContain('console.log("11. Start Native Planner (optional, generic, planning only)");');
    expect(cli).toContain('console.log("12. Supervise Native Planner");');
    expect(cli).toContain('console.log("13. Stop Native Planner");');
    expect(cli).toContain('else if (choice === "11") await nativePlanner().start();');
    expect(cli).toContain('else if (choice === "12") await nativePlanner().supervise(ask);');
    expect(cli).toContain('else if (choice === "13") await nativePlanner().stop();');
    expect(cli).toContain('console.log("2. Start SAFE (six-role dual-account topology)");');
    expect(MUTATION_ACTIONS).toContain("NATIVE_PLANNER_START");
    expect(MUTATION_ACTIONS).toContain("NATIVE_PLANNER_STOP");

    const module = code(read("src/modules/operator/native-planner-launcher.ts"));
    // Every mutation holds the lock under one of exactly these actions.
    expect([...module.matchAll(/withMutationLock\("([A-Z_]+)"/g)].map((m) => m[1]).sort()).toEqual(["NATIVE_PLANNER_START", "NATIVE_PLANNER_STOP", "SUPERVISE_RESTART"]);
    // Start / stop / restart go through the reviewed fenced primitives (each proves ownership before any kill).
    expect(module).toContain("const outcome = executeFencedStart(role, {");
    expect(module).toContain("const outcome = executeFencedStop(record, state!.repoRoot, { probe, terminate: adapters.terminate,");
    expect(module).toContain("const outcome = executeWorkerRestart(");
    // The kill is reachable ONLY inside those primitives: one reference in the fenced stop, one call in the restart adapter.
    expect((module.match(/adapters\.terminate/g) ?? []).length).toBe(2);
    // Both actions that may start a process consult the CLI's ONE gate printer first.
    expect((module.match(/adapters\.gateAllows\(\[role\]\)/g) ?? []).length).toBe(2);
    // One writer of its own state file, temp-then-rename; never the six-role file.
    expect((module.match(/writeFileSync\(/g) ?? []).length).toBe(1);
    expect(module).toContain("writeFileSync(temporary, JSON.stringify(state, null, 2)");
    expect(module).toContain("renameSync(temporary, adapters.statePath)");
    expect(module).not.toMatch(/\.dual\.json|transition:|writeStateFile|carriedTransition/);
    // No database, Redis or Binance client.
    expect(module).not.toMatch(/@prisma\/client|ioredis|bullmq|binance/i);
  });

  it("3. a start is fenced: one consumer at most, ours or anybody's", () => {
    expect(supervision.decideNativePlannerStart({ status: statusOf([BACKEND_LEAF]), ownedRootAlive: false })).toEqual({ act: "START" });
    expect(supervision.decideNativePlannerStart({ status: statusOf([BACKEND_LEAF, leaf(PLANNER_ENTRY, 21)]), ownedRootAlive: true })).toEqual({ act: "NONE", reason: "ALREADY_RUNNING_OWNED" });
    expect(supervision.decideNativePlannerStart({ status: statusOf([BACKEND_LEAF, leaf(PLANNER_ENTRY, 21)]), ownedRootAlive: false })).toEqual({ act: "NONE", reason: "ALREADY_RUNNING_EXTERNAL" });
    expect(supervision.decideNativePlannerStart({ status: statusOf([BACKEND_LEAF, leaf(PLANNER_ENTRY, 21), leaf(PLANNER_ENTRY, 22)]), ownedRootAlive: false })).toEqual({ act: "NONE", reason: "DUPLICATE_PRESENT" });
    expect(supervision.decideNativePlannerStart({ status: statusOf([BACKEND_LEAF, pnpmWrapper(PLANNER_ENTRY, 90)]), ownedRootAlive: true })).toEqual({ act: "NONE", reason: "OWNED_ROOT_WITHOUT_RUNTIME" });
  });

  it("8. it needs only the generic environment: the spawn selects generic.env and strips every account identity key", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local", BINANCE_API_KEY: "inherited-key", BINANCE_API_SECRET: "inherited-secret", EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "acct", PATH: "p" } as NodeJS.ProcessEnv;
    const child = sanitizedChildEnv("native-planner", env, () => ["DATABASE_URL", "REDIS_URL"]);
    expect(child.BINANCE_API_KEY).toBeUndefined();
    expect(child.BINANCE_API_SECRET).toBeUndefined();
    expect(child.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER).toBeUndefined();
    expect(child.DOTENV_CONFIG_PATH).toMatch(/generic\.env$/);
    const plan = dualSpawnPlan("native-planner", "C:\\repo", env, () => []);
    expect(plan.args).toEqual(["/d", "/s", "/c", "pnpm", "-C", "C:\\repo", "--filter", "@trading-alert-dashboard/backend", "native-alerts:plan-worker"]);
    const worker = code(read(PLANNER_ENTRY));
    expect(worker.trim().startsWith('import "../../config/bootstrap-generic";')).toBe(true);
    expect(worker).not.toMatch(/bootstrap-account|BINANCE_API_KEY|apiSecret|account-env/);
  });

  it("6/7. the worker consumes ONLY the dedicated Native queue; no TradingView consumer is added anywhere", () => {
    const worker = code(read(PLANNER_ENTRY));
    expect(worker.match(/new Worker</g)).toHaveLength(1);
    expect(worker).toContain("new Worker<NativePlanJobData>(NATIVE_EXTREME_RR_QUEUE_NAME,");
    expect(worker).not.toMatch(/(?<![A-Z_])EXTREME_RR_QUEUE_NAME\b|VISION_ANALYSIS_QUEUE_NAME|jobs\/queue|notification|telegram|screenshot|ai-vision|selected-plan|\/execution\//i);
    expect(NATIVE_EXTREME_RR_QUEUE_NAME).toBe("native-extreme-rr-plan");
    const vision = code(read("src/modules/jobs/vision-analysis.worker.ts"));
    expect(vision.match(/new Worker</g)).toHaveLength(2);
    expect(vision).not.toMatch(/native/i);
  });
});

// ===========================================================================
// 3/5. The launcher module, driven end to end with a fake machine
// ===========================================================================

const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync: readFs } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { createNativePlannerLauncher } = await import("../src/modules/operator/native-planner-launcher");

describe("3/5. the launcher module: one fenced start, an ownership-proven stop, a fenced restart", () => {

  function machine() {
    const dir = mkdtempSync(path.join(tmpdir(), "native-planner-launcher-"));
    const envDir = path.join(dir, "trading-alert-dashboard", "env");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(path.join(envDir, "generic.env"), "DATABASE_URL=postgresql://x\nREDIS_URL=redis://x\n");
    const repoRoot = path.join(dir, "repo");
    const table = new Map<number, ObservedProcess>([[11, BACKEND_LEAF]]);
    let nextPid = 500;
    const lines: string[] = [];
    const spawned: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const killed: number[] = [];
    const locks: string[] = [];
    const adapters = {
      repoRoot,
      statePath: path.join(dir, "state", "launcher.native-planner.json"),
      env: { LOCALAPPDATA: dir, BINANCE_API_KEY: "inherited", PATH: "p" } as NodeJS.ProcessEnv,
      observeProcesses: () => ({ ok: true as const, value: [...table.values()] }),
      observeListeners: () => LISTENERS,
      probeProcesses: (pids: number[]) => ({ ok: true as const, value: new Map(pids.flatMap((pid) => (table.has(pid) ? [[pid, { pid, commandLine: table.get(pid)!.commandLine, startedAtMs: table.get(pid)!.startedAtMs }] as const] : []))) }),
      terminate: (pid: number) => {
        killed.push(pid);
        table.delete(pid);
        table.delete(pid + 1); // its leaf
        return true;
      },
      spawnRole: (_role: string, plan: { args: readonly string[]; options: { env?: NodeJS.ProcessEnv } }) => {
        spawned.push({ args: plan.args, env: plan.options.env });
        const root = nextPid;
        nextPid += 10;
        table.set(root, { pid: root, startedAtMs: 2_000, commandLine: `cmd.exe /d /s /c pnpm -C ${repoRoot} --filter @trading-alert-dashboard/backend native-alerts:plan-worker` });
        table.set(root + 1, leaf(PLANNER_ENTRY, root + 1));
        return root;
      },
      gateAllows: () => true,
      readTransitionMarker: () => ({ status: "NONE" as const }),
      lockAdapters: () => ({ authority: { acquire: async (action: string) => (locks.push(action), { ok: true as const, held: { action, release: async () => ({ released: true }) } }) }, log: () => undefined }) as never,
      log: (line: string) => void lines.push(line),
      sleep: async () => undefined,
    };
    return { adapters, table, lines, spawned, killed, locks, launcher: createNativePlannerLauncher(adapters as never) };
  }

  it("start spawns exactly ONE planner from generic.env (account keys stripped), records it, and a second start adds nothing", async () => {
    const m = machine();
    await m.launcher.start();
    expect(m.spawned).toHaveLength(1);
    expect(m.spawned[0].args.slice(-1)).toEqual(["native-alerts:plan-worker"]);
    expect(m.spawned[0].env?.BINANCE_API_KEY).toBeUndefined();
    expect(m.spawned[0].env?.DOTENV_CONFIG_PATH).toMatch(/generic\.env$/);
    expect(m.locks).toEqual(["NATIVE_PLANNER_START"]);
    const state = JSON.parse(readFs(m.adapters.statePath, "utf8"));
    expect(state.processes).toEqual([{ role: "native-planner", pid: 500, startedAtMs: 2_000, envAlias: "generic", port: null }]);
    await m.launcher.start();
    expect(m.spawned).toHaveLength(1);
    expect(m.lines.join("\n")).toMatch(/nothing was started \(ALREADY_RUNNING_OWNED\)/);
    expect(m.launcher.statusLine(statusOf([...m.table.values()]))).toMatch(/ON \(launcher-owned\)$/);
  });

  it("start refuses to add a consumer beside an EXTERNALLY started planner", async () => {
    const m = machine();
    m.table.set(900, leaf(PLANNER_ENTRY, 900));
    await m.launcher.start();
    expect(m.spawned).toHaveLength(0);
    expect(m.lines.join("\n")).toMatch(/ALREADY_RUNNING_EXTERNAL/);
  });

  it("stop terminates ONLY a provably-owned root, then forgets it; an external planner is never stopped", async () => {
    const m = machine();
    await m.launcher.start();
    await m.launcher.stop();
    expect(m.killed).toEqual([500]);
    expect(JSON.parse(readFs(m.adapters.statePath, "utf8")).processes).toEqual([]);
    expect(m.locks).toEqual(["NATIVE_PLANNER_START", "NATIVE_PLANNER_STOP"]);
    m.table.set(900, leaf(PLANNER_ENTRY, 900));
    await m.launcher.stop();
    expect(m.killed).toEqual([500]);
    expect(m.lines.join("\n")).toMatch(/IS running that this launcher did not start\. It will not be terminated/);
  });

  it("a recorded PID that now belongs to something else (PID reuse) is NOT terminated, and the record is kept", async () => {
    const m = machine();
    await m.launcher.start();
    m.table.set(500, { pid: 500, startedAtMs: 99_999, commandLine: "some other program" });
    await m.launcher.stop();
    expect(m.killed).toEqual([]);
    expect(JSON.parse(readFs(m.adapters.statePath, "utf8")).processes).toHaveLength(1);
  });

  it("a refused gate (e.g. an unreadable transition marker) starts nothing", async () => {
    const m = machine();
    m.adapters.gateAllows = () => false;
    await m.launcher.start();
    expect(m.spawned).toHaveLength(0);
    expect(existsSync(m.adapters.statePath)).toBe(false);
  });
});

// ===========================================================================
// 5. Restart policy — the reviewed ladder, unchanged
// ===========================================================================

describe("5. an unexpected exit follows the existing restart policy", () => {
  const base = { budget: EMPTY_RESTART_BUDGET, nowMs: 10_000_000, hasRuntimeState: true };
  it("tree gone -> exactly one replacement; healthy / duplicate / external -> nothing", () => {
    const gone = supervision.decideNativePlannerSupervision({ ...base, record: { pid: 77, startedAtMs: 1 }, ownership: { owned: false, reason: "GONE" } as never, status: statusOf([BACKEND_LEAF]) });
    expect([gone.action, gone.reasonCode]).toEqual(["RESTART", "WORKER_EXITED"]);
    expect(gone.message).toMatch(/Starting exactly one replacement from the generic environment file/);
    const healthy = supervision.decideNativePlannerSupervision({ ...base, record: { pid: 77, startedAtMs: 1 }, ownership: { owned: true }, status: statusOf([BACKEND_LEAF, leaf(PLANNER_ENTRY, 77)]) });
    expect(healthy.action).toBe("NONE");
    const duplicate = supervision.decideNativePlannerSupervision({ ...base, record: { pid: 77, startedAtMs: 1 }, ownership: { owned: true }, status: statusOf([BACKEND_LEAF, leaf(PLANNER_ENTRY, 77), leaf(PLANNER_ENTRY, 78)]) });
    expect([duplicate.action, duplicate.reasonCode]).toEqual(["NONE", "WORKER_DUPLICATE"]);
    const external = supervision.decideNativePlannerSupervision({ ...base, record: null, ownership: null, status: statusOf([BACKEND_LEAF, leaf(PLANNER_ENTRY, 99)]) });
    expect(external.action).toBe("NONE");
    const stale = supervision.decideNativePlannerSupervision({ ...base, record: { pid: 77, startedAtMs: 1 }, ownership: { owned: true }, status: statusOf([BACKEND_LEAF, pnpmWrapper(PLANNER_ENTRY, 77)]) });
    expect([stale.action, stale.reasonCode]).toEqual(["TERMINATE_THEN_RESTART", "WORKER_STALE"]);
  });

  it("the restart budget is the reviewed one; an exhausted budget stops recovery and says so", () => {
    const exhausted = { attempts: WORKER_RESTART_MAX_ATTEMPTS, lastAttemptAtMs: 0, healthySinceMs: null };
    const decision = supervision.decideNativePlannerSupervision({ budget: exhausted, nowMs: 10_000_000, hasRuntimeState: true, record: { pid: 77, startedAtMs: 1 }, ownership: { owned: false, reason: "GONE" } as never, status: statusOf([BACKEND_LEAF]) });
    expect([decision.action, decision.reasonCode]).toEqual(["NONE", "RESTART_BUDGET_EXHAUSTED"]);
    expect(decision.message).toMatch(/Automatic recovery has stopped; operator intervention is required/);
  });

  it("a crash is recorded and exits non-zero (supervision sees it); the script runs WITHOUT a file watcher", () => {
    const worker = code(read(PLANNER_ENTRY));
    expect(worker).toContain("installFatalHandlers();");
    expect(ROLE_CONTRACTS["native-planner"].script).toBe("native-alerts:plan-worker");
    expect((JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts["native-alerts:plan-worker"]).not.toMatch(/watch/);
  });

  it("status line: census + ownership only", () => {
    expect(supervision.renderNativePlannerStatus({ status: statusOf([BACKEND_LEAF]), ownedRootAlive: false })).toBe("Native Planner Worker (optional, generic, not part of Start SAFE): OFF");
    expect(supervision.renderNativePlannerStatus({ status: statusOf([BACKEND_LEAF, leaf(PLANNER_ENTRY, 5)]), ownedRootAlive: true })).toMatch(/ON \(launcher-owned\)$/);
    expect(supervision.renderNativePlannerStatus({ status: statusOf([BACKEND_LEAF, leaf(PLANNER_ENTRY, 5)]), ownedRootAlive: false })).toMatch(/ON \(external\)$/);
  });
});

// ===========================================================================
// 4, 9, 13. Lifecycle, heartbeat, status
// ===========================================================================

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    store: { set: vi.fn(async (k: string, v: string) => void map.set(k, v)), get: vi.fn(async (k: string) => map.get(k) ?? null), del: vi.fn(async (k: string) => void map.delete(k)) },
  };
}
const logger = () => {
  const lines: string[] = [];
  return { lines, log: { info: (_f: Record<string, unknown>, m: string) => void lines.push(`INFO ${m}`), warn: (_f: Record<string, unknown>, m: string) => void lines.push(`WARN ${m}`) } };
};
const emptySweep = { inspected: 0, recovered: 0, alreadyQueued: 0, closedAsError: 0, queueUnavailable: false, outcomes: [] };

describe("4/9. lifecycle: identity logs, heartbeat, graceful shutdown", () => {
  it("start: one consumer on the Native queue, the startup sweep is ALWAYS logged, a heartbeat is published", async () => {
    const { map, store } = memoryStore();
    const { lines, log } = logger();
    const createWorker = vi.fn(() => ({ isRunning: () => true, close: async () => undefined }));
    const runtime = await startNativePlannerRuntime({
      queueName: NATIVE_EXTREME_RR_QUEUE_NAME, pid: 4242, createWorker, processJob: async () => ({ kind: "NO_PLANNING_INTENT" }) as const, sweep: async () => emptySweep, heartbeatStore: store,
      closeQueue: async () => undefined, closeConnection: async () => undefined, disconnectDb: async () => undefined, logger: log, sweepIntervalMs: 60_000,
    });
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      "INFO Native planner worker starting (PLANNING ONLY / NATIVE EXECUTION DISABLED)",
      "INFO Native planner startup recovery sweep",
      "INFO Native planner worker started",
    ]);
    const beat = JSON.parse(map.get(NATIVE_PLANNER_HEARTBEAT_KEY)!);
    expect(beat).toMatchObject({ role: "native-planner", queue: "native-extreme-rr-plan", pid: 4242, consumerRunning: true, nativeExecutionEnabled: false, lastSweep: { phase: "STARTUP", inspected: 0 } });
    await runtime.shutdown("SIGTERM");
  });

  it("4. SIGTERM: consumer closed first, then heartbeat withdrawn, queue + connection closed, database disconnected; idempotent; exit 0", async () => {
    const { map, store } = memoryStore();
    const { lines, log } = logger();
    const order: string[] = [];
    const runtime = await startNativePlannerRuntime({
      queueName: NATIVE_EXTREME_RR_QUEUE_NAME, pid: 7, createWorker: () => ({ isRunning: () => true, close: async () => void order.push("worker") }),
      processJob: async () => ({ kind: "NO_PLANNING_INTENT" }) as const, sweep: async () => emptySweep, heartbeatStore: store,
      closeQueue: async () => void order.push("queue"), closeConnection: async () => void order.push("connection"), disconnectDb: async () => void order.push("database"), logger: log, sweepIntervalMs: 60_000,
    });
    expect(map.has(NATIVE_PLANNER_HEARTBEAT_KEY)).toBe(true);
    const first = runtime.shutdown("SIGTERM");
    const second = runtime.shutdown("SIGINT");
    expect(second).toBe(first);
    expect(await first).toBe(0);
    expect(order).toEqual(["worker", "queue", "connection", "database"]);
    expect(map.has(NATIVE_PLANNER_HEARTBEAT_KEY)).toBe(false);
    expect(lines.slice(-2)).toEqual(["INFO Native planner worker stopping", "INFO Native planner worker stopped"]);
  });

  it("4. a failing shutdown step still runs the rest and exits non-zero", async () => {
    const { store } = memoryStore();
    const order: string[] = [];
    const runtime = await startNativePlannerRuntime({
      queueName: NATIVE_EXTREME_RR_QUEUE_NAME, pid: 8, createWorker: () => ({ isRunning: () => true, close: async () => Promise.reject(new Error("x")) }),
      processJob: async () => ({ kind: "NO_PLANNING_INTENT" }) as const, sweep: async () => emptySweep, heartbeatStore: store,
      closeQueue: async () => void order.push("queue"), closeConnection: async () => void order.push("connection"), disconnectDb: async () => void order.push("database"), logger: logger().log, sweepIntervalMs: 60_000,
    });
    expect(await runtime.shutdown("SIGTERM")).toBe(1);
    expect(order).toEqual(["queue", "connection", "database"]);
  });

  it("a stopping worker never deletes a SUCCESSOR's heartbeat", async () => {
    const { map, store } = memoryStore();
    const old = createHeartbeatPublisher({ store, queue: "q", pid: 1, consumerRunning: () => true });
    await old.start();
    const successor = createHeartbeatPublisher({ store, queue: "q", pid: 2, consumerRunning: () => true });
    await successor.publish();
    await old.stop();
    expect(JSON.parse(map.get(NATIVE_PLANNER_HEARTBEAT_KEY)!).pid).toBe(2);
    await successor.stop();
    expect(map.has(NATIVE_PLANNER_HEARTBEAT_KEY)).toBe(false);
  });

  it("9. heartbeat judgement: fresh+consumer RUNNING; old STALE; consumer down STALE; absent OFF; malformed UNREADABLE (never RUNNING)", async () => {
    const t = Date.parse("2026-10-05T00:00:00Z");
    const beat = (over: Record<string, unknown> = {}) => JSON.stringify({ schema: "teddy.native-planner.heartbeat.v1", role: "native-planner", queue: "q", pid: 1, startedAt: "2026-10-04T23:00:00Z", beatAt: new Date(t - 5_000).toISOString(), consumerRunning: true, lastSweep: null, lastSweepError: null, nativeExecutionEnabled: false, ...over });
    expect(judgeNativePlannerHeartbeat(beat(), t)).toMatchObject({ state: "RUNNING", ageSeconds: 5 });
    expect(judgeNativePlannerHeartbeat(beat({ beatAt: new Date(t - NATIVE_PLANNER_HEARTBEAT_STALE_MS - 1).toISOString() }), t).state).toBe("STALE");
    expect(judgeNativePlannerHeartbeat(beat({ consumerRunning: false }), t).state).toBe("STALE");
    expect(judgeNativePlannerHeartbeat(null, t).state).toBe("OFF");
    expect(judgeNativePlannerHeartbeat("{nope", t).state).toBe("UNREADABLE");
    expect(judgeNativePlannerHeartbeat(JSON.stringify({ schema: "other" }), t).state).toBe("UNREADABLE");
  });

  it("9/13. the read-only status tells 'backend healthy' apart from 'planner healthy', exposes no pid, and says execution is off", async () => {
    const now = () => new Date("2026-10-05T00:00:10Z");
    const fresh = JSON.stringify({ schema: "teddy.native-planner.heartbeat.v1", role: "native-planner", queue: "q", pid: 31337, startedAt: "2026-10-05T00:00:00Z", beatAt: "2026-10-05T00:00:05Z", consumerRunning: true, lastSweep: null, lastSweepError: null, nativeExecutionEnabled: false });
    const jobs = { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 3 };
    const ready = await readNativePlannerStatus({ queue: "native-extreme-rr-plan", now, readHeartbeat: async () => fresh, queueStats: async () => ({ connectedConsumers: 1, jobs }), countPendingNativePlans: async () => 0 });
    expect(ready).toMatchObject({ readiness: "READY", nativeExecutionEnabled: false, connectedConsumers: 1, pendingNativePlans: 0, worker: { state: "RUNNING", ageSeconds: 5 } });
    expect(JSON.stringify(ready)).not.toContain("31337");
    const down = await readNativePlannerStatus({ queue: "q", now, readHeartbeat: async () => null, queueStats: async () => ({ connectedConsumers: 0, jobs }), countPendingNativePlans: async () => 2 });
    expect([down.readiness, down.worker.state, down.pendingNativePlans]).toEqual(["DOWN", "OFF", 2]);
    const partial = await readNativePlannerStatus({ queue: "q", now, readHeartbeat: async () => Promise.reject(new Error("redis")), queueStats: async () => Promise.reject(new Error("redis")), countPendingNativePlans: async () => Promise.reject(new Error("db")) });
    expect([partial.readiness, partial.worker.state, partial.connectedConsumers, partial.jobs, partial.pendingNativePlans]).toEqual(["DEGRADED", "UNREADABLE", null, null, null]);
    // The route is GET-only, serves exactly that, and starts nothing.
    const app = Fastify();
    await app.register(nativePlannerRoutes, { deps: { queue: "native-extreme-rr-plan", now, readHeartbeat: async () => fresh, queueStats: async () => ({ connectedConsumers: 1, jobs }), countPendingNativePlans: async () => 0 } });
    const response = await app.inject({ method: "GET", url: "/api/native-planner/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ readiness: "READY", role: "native-planner", startedBy: "EXPLICIT_COMMAND_OR_LAUNCHER" });
    expect((await app.inject({ method: "POST", url: "/api/native-planner/status" })).statusCode).toBe(404);
    await app.close();
    const route = code(read("src/routes/native-planner.routes.ts"));
    expect(route).not.toMatch(/\.add\(|\.create\(|\.update\(|\.delete\(|\.set\(|spawn|native-plan\.worker/);
  });
});

// ===========================================================================
// 10-12. Restart recovery against the test database (semantics unchanged)
// ===========================================================================

const T = TEDDY_7_ALL_ACTIVE_V1;
const CONTEXT = { profile: profileSummaryOf(T), runId: "20261005T000000Z-ops" };
const LINEAGE = "8".repeat(64);
let seq = 0;
const nextSymbol = () => `NOPS${++seq}${Date.now() % 100000}USDT`;
function candles(trigger: Date): SnapshotCandle[] {
  const lastOpen = Math.floor(trigger.getTime() / M15) * M15 - M15;
  const rows: SnapshotCandle[] = [];
  for (let i = 319; i >= 0; i -= 1) {
    const openTimeMs = lastOpen - i * M15;
    rows.push({ openTimeMs, closeTimeMs: openTimeMs + M15 - 1, high: i === 10 ? "0.05" : "0.043", low: "0.042" });
  }
  return rows;
}
const TEMPLATE = { id: "tpl-ops", name: "ops", referenceCapital: "400", riskPercent: "1", rewardRatio: "1.5", isActive: true, createdAt: new Date(), updatedAt: new Date() };
const db = new Proxy(prisma, { get: (target, key) => (key === "riskTemplate" ? { findFirst: async () => TEMPLATE } : Reflect.get(target, key)) }) as PrismaClient;

function fakeQueue() {
  const jobs = new Map<string, "waiting" | "active" | "completed" | "failed">();
  return { jobs, queue: { add: vi.fn(async (id: string) => void (jobs.has(id) || jobs.set(id, "waiting"))), stateOf: vi.fn(async (id: string) => jobs.get(id) ?? ("missing" as const)) } };
}

async function deliver(withPlanning: boolean, q = fakeQueue()): Promise<Alert> {
  const symbol = nextSymbol();
  const identity = { lineageId: LINEAGE, marketType: "USDM_PERPETUAL" as const, symbol, chartInterval: "15m" as const };
  const log = logOf([observation({ symbol, lineageId: LINEAGE, barMs: bar(1), sourceTf: "1W", levelPrice: 0.04234, evidenceClass: "POSSIBLE_ONLY", createdBarOpenTimeMs: BAR0 - 30 * 96 * M15 }), commit(bar(1), "SHADOW_LIVE_ONLY", LINEAGE, symbol)]);
  const [decision] = selectNativeDeliveriesV2(parseShadowEventLog(log, identity), T.delivery).flatMap((s) => (s.kind === "DELIVER" ? [s.decision] : []));
  const requester = createNativePlanRequester({ prisma, queue: q.queue, resolveLookback: async () => 300, log: () => undefined });
  const ledger = withPlanning
    ? new PrismaNativeDeliveryLedger(prisma, { onAlertCommitted: (alert) => afterNativeAlertCommitted(alert, { publishCommitted: async () => "PUBLISHED" }, requester) })
    : new PrismaNativeDeliveryLedger(prisma);
  const result = await ledger.deliverV2(decision, CONTEXT);
  return prisma.alert.findUniqueOrThrow({ where: { id: result.alertId! } });
}

/** A whole runtime incarnation over the REAL processor and sweep (test DB), with a fake queue and a clock past the grace. */
async function incarnation(q: ReturnType<typeof fakeQueue>, fetcher = vi.fn(async (a: Alert) => candles(a.triggeredAt))) {
  const planner = new ExtremeRRService(db, fetcher, async () => 300 as const);
  let process: ((alertId: string) => Promise<unknown>) | null = null;
  const runtime = await startNativePlannerRuntime({
    queueName: NATIVE_EXTREME_RR_QUEUE_NAME, pid: 1000 + seq,
    createWorker: (run) => ((process = run), { isRunning: () => true, close: async () => undefined }),
    processJob: (alertId) => processNativePlanJob({ prisma: db, planner }, alertId),
    sweep: () => runNativePlanRecoverySweep(prisma, q.queue, { batchSize: 500, now: () => new Date(Date.now() + NATIVE_PLAN_RECOVERY_GRACE_MS + 1_000) }),
    heartbeatStore: memoryStore().store, closeQueue: async () => undefined, closeConnection: async () => undefined, disconnectDb: async () => undefined,
    logger: logger().log, sweepIntervalMs: 60_000,
  });
  return { runtime, run: (id: string) => process!(id), fetcher };
}

async function cleanup() {
  if (!available) return;
  await prisma.nativeAlertDelivery.deleteMany({ where: { symbol: { startsWith: "NOPS" } } });
  await prisma.alert.deleteMany({ where: { symbol: { startsWith: "NOPS" } } });
}
beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (available) await prisma.$disconnect();
});

describe("10-12. restart recovery converges, freezes and never backfills", () => {
  maybe()("10. PENDING + job lost, the worker exits; a restarted incarnation's startup sweep re-enqueues it and ONE plan results", async () => {
    const q = fakeQueue();
    const alert = await deliver(true, q);
    const first = await incarnation(q);
    q.jobs.clear(); // the job died with the first process
    expect(await first.runtime.shutdown("SIGTERM")).toBe(0);
    expect((await prisma.extremeRRPlan.findUniqueOrThrow({ where: { alertId: alert.id } })).status).toBe("PENDING");

    const second = await incarnation(q); // startup sweep runs here
    expect(q.jobs.get(alert.id)).toBe("waiting");
    await second.run(alert.id);
    expect(await prisma.extremeRRPlan.count({ where: { alertId: alert.id } })).toBe(1);
    expect(await prisma.extremeRRPlan.findUniqueOrThrow({ where: { alertId: alert.id } })).toMatchObject({ status: "READY", executionFanoutReadyAt: null });
    await second.runtime.shutdown("SIGTERM");
  });

  maybe()("11. a READY plan survives a restart untouched: no regeneration, no fetch, even when its job is replayed", async () => {
    const q = fakeQueue();
    const alert = await deliver(true, q);
    const first = await incarnation(q);
    await first.run(alert.id);
    await first.runtime.shutdown("SIGTERM");
    const before = await prisma.extremeRRPlan.findUniqueOrThrow({ where: { alertId: alert.id } });
    const second = await incarnation(q);
    await second.run(alert.id); // replayed job
    expect(second.fetcher).not.toHaveBeenCalled();
    expect(await prisma.extremeRRPlan.findUniqueOrThrow({ where: { alertId: alert.id } })).toEqual(before);
    await second.runtime.shutdown("SIGTERM");
  });

  maybe()("12. an old Native alert without a PENDING intent is never backfilled by any restart's startup sweep", async () => {
    const old = await deliverHistoricalLike();
    const q = fakeQueue();
    const a = await incarnation(q);
    await a.runtime.shutdown("SIGTERM");
    const b = await incarnation(q);
    await b.runtime.shutdown("SIGTERM");
    expect(q.queue.add).not.toHaveBeenCalledWith(old.id);
    expect(await prisma.extremeRRPlan.findUnique({ where: { alertId: old.id } })).toBeNull();
  });

  maybe()("13. Native execution stays off: the auto-generated plan has no fan-out marker and the heartbeat says false", async () => {
    const q = fakeQueue();
    const alert = await deliver(true, q);
    const r = await incarnation(q);
    await r.run(alert.id);
    expect((await prisma.extremeRRPlan.findUniqueOrThrow({ where: { alertId: alert.id } })).executionFanoutReadyAt).toBeNull();
    expect(r.runtime.heartbeat.current.nativeExecutionEnabled).toBe(false);
    expect(T.execution.nativeExecutionEnabled).toBe(false);
    await r.runtime.shutdown("SIGTERM");
  });
});

async function deliverHistoricalLike(): Promise<Alert> {
  return deliver(false);
}
