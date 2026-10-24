import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseAlwaysOnCliArgs, AlwaysOnCliUsageError } from "../src/modules/always-on/always-on-cli-args";
import { ALWAYS_ON_DEFAULTS, ALWAYS_ON_INSTANCE_PORT, ALWAYS_ON_OWNERSHIP_SCHEMA, ALWAYS_ON_REQUEST_SCHEMA, STRIPPED_CREDENTIAL_KEYS, backoffDelayMs } from "../src/modules/always-on/always-on-contract";
import { judgeEmitterHealth, judgePlannerHealth, judgeScannerHealth, nextPlannerBaseline } from "../src/modules/always-on/always-on-health";
import { IncidentJournal, redactIncidentText } from "../src/modules/always-on/always-on-journal";
import { alwaysOnSupervisorArgs } from "../src/modules/always-on/always-on-launch";
import { decideAdoption, generationIsCurrent, listenerInstanceLock, nextGeneration, parseOwnership, sameRepository, supervisorLiveness, type ChildRecord } from "../src/modules/always-on/always-on-ownership";
import { alwaysOnPaths, childStopFile } from "../src/modules/always-on/always-on-paths";
import {
  MONITORING_ENTRYPOINTS,
  MonitoringPlanError,
  backendSpawnPlan,
  classifyMonitoringRuntime,
  credentialNamesPresent,
  emitterSpawnPlan,
  monitoringChildEnv,
  monitoringCensus,
  plannerSpawnPlan,
  scannerSpawnPlan,
} from "../src/modules/always-on/always-on-roles";
import { StartupTaskError, startupTaskArguments, startupTaskCommands, startupTaskXml, startupTaskXmlBytes } from "../src/modules/always-on/always-on-startup-task";
import { parseMultiEmitterCliArgs } from "../src/modules/native-alerts/multi-emitter-cli-args";
import { CooperativeStopUsageError, validateStopFilePath, watchCooperativeStop } from "../src/modules/native-scanner/cooperative-stop";
import { parseSupervisorCliArgs } from "../src/modules/native-scanner/live-shadow-supervisor-cli-args";
import { alwaysOnLaunchEnv, createAlwaysOnLauncher } from "../src/modules/operator/always-on-launcher";
import type { ObservedProcessNode } from "../src/modules/operator/runtime-launcher";
import { observed } from "../src/modules/operator/runtime-launcher";
import { DIRTY_ENV, ENGINE, plannerStatusBody } from "./helpers/always-on-fake-machine";

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const POLICY = ALWAYS_ON_DEFAULTS;

function scannerStatus(over: Record<string, unknown> = {}, totals: Record<string, unknown> = {}, universe: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema: "teddy.native-scanner.live-shadow-supervisor-status.v3",
    runId: "20261023T110000Z-0a0b0c0d",
    runState: "RUNNING",
    engineFingerprint: ENGINE,
    pid: 777,
    writtenAt: new Date(NOW - 20_000).toISOString(),
    totals: { selected: 522, liveEligible: 522, quarantined: 0, failed: 0, recovering: 0, awaitingStream: 0, catchupPending: 0, reconnects: 3, backpressureEvents: 0, restHalted: false, ...totals },
    universe: { generation: 9, stale: false, exchangeCandidates: 522, capacity: { exceeded: false }, ...universe },
    symbols: [{ symbol: "BTCUSDT", lastValidMessageAt: new Date(NOW - 2_000).toISOString() }],
    ...over,
  });
}

describe("contract", () => {
  it("backoff steps grow and the last repeats; the credential list is the operator's five", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 99].map((n) => backoffDelayMs(POLICY, n) / 1000)).toEqual([30, 60, 120, 300, 600, 900, 900, 900]);
    expect([...STRIPPED_CREDENTIAL_KEYS]).toEqual(["BINANCE_API_KEY", "BINANCE_API_SECRET", "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER", "API_KEY", "API_SECRET"]);
    expect(ALWAYS_ON_INSTANCE_PORT).toBe(4019);
    expect(POLICY.emitterQueueCapacity).toBe(10_000);
  });
});

describe("scanner health", () => {
  const judge = (text: string | null, owned = [777]) => judgeScannerHealth({ statusText: text, nowMs: NOW, ownedRuntimePids: owned, policy: POLICY });

  it("HEALTHY on a coherent, fresh universe of ANY size", () => {
    expect(judge(scannerStatus()).verdict).toBe("HEALTHY");
    expect(judge(scannerStatus({}, { selected: 17, liveEligible: 17 }, { exchangeCandidates: 900 })).verdict).toBe("HEALTHY");
  });

  it("a status whose pid is NOT in the owned tree vouches for nothing (stale file, previous run, somebody else's process)", () => {
    expect(judge(scannerStatus(), [778])).toMatchObject({ verdict: "AWAITING_STATUS", ours: false });
    expect(judge(null).verdict).toBe("AWAITING_STATUS");
    expect(judge("{garbage").verdict).toBe("AWAITING_STATUS");
  });

  it("WARMING when symbols are quarantined for the current bar but membership is coherent", () => {
    expect(judge(scannerStatus({}, { liveEligible: 500, quarantined: 22 })).verdict).toBe("WARMING");
  });

  it.each([
    ["STATUS_STALE", scannerStatus({ writtenAt: new Date(NOW - 10 * 60_000).toISOString() })],
    ["UNIVERSE_STALE", scannerStatus({}, {}, { stale: true })],
    ["CAPACITY_EXCEEDED", scannerStatus({}, {}, { capacity: { exceeded: true } })],
    ["SYMBOLS_FAILED", scannerStatus({}, { failed: 1, liveEligible: 521 })],
    ["SYMBOLS_RECOVERING", scannerStatus({}, { recovering: 2, liveEligible: 520 })],
    ["AWAITING_STREAM", scannerStatus({}, { awaitingStream: 1, liveEligible: 521 })],
    ["MEMBERSHIP_INCONSISTENT", scannerStatus({}, { liveEligible: 400 })],
    ["NO_SYMBOLS_SELECTED", scannerStatus({}, { selected: 0, liveEligible: 0 })],
    ["MARKET_DATA_STALE", scannerStatus({ symbols: [{ symbol: "BTCUSDT", lastValidMessageAt: new Date(NOW - 10 * 60_000).toISOString() }] })],
    ["REST_HALTED", scannerStatus({}, { restHalted: true })],
  ])("DEGRADED: %s", (code, text) => {
    const health = judge(text);
    expect(health.verdict).toBe("DEGRADED");
    expect(health.issues.map((i) => i.code)).toContain(code);
  });

  it("STOPPED when our own scanner says its run stopped", () => {
    expect(judge(scannerStatus({ runState: "STOPPED" })).verdict).toBe("STOPPED");
  });
});

describe("scanner health with the scanner's per-symbol and per-connection detail", () => {
  const judge = (text: string) => judgeScannerHealth({ statusText: text, nowMs: NOW, ownedRuntimePids: [777], policy: POLICY });
  const at = (agoMs: number) => new Date(NOW - agoMs).toISOString();
  /** A status as the real scanner writes it: every placed symbol with its connection and readiness, every connection. */
  function detailed(spec: { readonly readiness: readonly { readonly readiness: string; readonly status?: string; readonly connection?: number }[]; readonly connections: readonly { readonly lifecycle: string; readonly lastMessageAgoMs: number | null }[]; readonly selected?: number }) {
    const symbols = spec.readiness.map((r, i) => ({ symbol: `S${i}USDT`, connection: r.connection ?? 0, status: r.status ?? "ATTACHED", readiness: r.readiness, lastValidMessageAt: at(2_000) }));
    const count = (pred: (s: (typeof symbols)[number]) => boolean) => symbols.filter(pred).length;
    return scannerStatus(
      {
        symbols,
        connections: spec.connections.map((c, index) => ({ index, lifecycle: c.lifecycle, assigned: count((s) => s.connection === index), lastMessageAt: c.lastMessageAgoMs === null ? null : at(c.lastMessageAgoMs) })),
      },
      {
        selected: spec.selected ?? count((s) => s.connection >= 0),
        liveEligible: count((s) => s.readiness === "LIVE_ELIGIBLE"),
        quarantined: count((s) => s.readiness === "QUARANTINED_CURRENT_BAR"),
        awaitingStream: count((s) => s.readiness === "AWAITING_STREAM" || s.readiness === "NOT_READY"),
        recovering: count((s) => s.status === "RECOVERING"),
      }
    );
  }
  const many = (n: number, readiness: string, connection = 0) => Array.from({ length: n }, () => ({ readiness, connection }));

  it("acceptance run 3, 16:19:15: 521 quarantined + ONE quiet symbol awaiting its first update on a delivering connection is WARMING — not AWAITING_STREAM, not MEMBERSHIP_INCONSISTENT", () => {
    const health = judge(detailed({ readiness: [...many(521, "QUARANTINED_CURRENT_BAR"), { readiness: "AWAITING_STREAM" }], connections: [{ lifecycle: "OPEN", lastMessageAgoMs: 1_000 }] }));
    expect(health).toMatchObject({ verdict: "WARMING", issues: [] });
    expect(health.universe).toMatchObject({ selected: 522, quarantined: 521, awaitingStream: 1, awaitingStreamQuiet: 1 });
  });

  it("symbols awaiting their stream on a connection that delivers NOTHING (silent, never opened, closed) are a stream failure — DEGRADED at once, counted once", () => {
    for (const connection of [
      { lifecycle: "OPEN", lastMessageAgoMs: 10 * 60_000 },
      { lifecycle: "OPEN", lastMessageAgoMs: null },
      { lifecycle: "CONNECTING", lastMessageAgoMs: null },
      { lifecycle: "CLOSED", lastMessageAgoMs: 5_000 },
    ]) {
      const health = judge(detailed({ readiness: [...many(40, "LIVE_ELIGIBLE", 0), ...many(10, "AWAITING_STREAM", 1)], connections: [{ lifecycle: "OPEN", lastMessageAgoMs: 1_000 }, connection] }));
      expect({ connection, codes: health.issues.map((i) => i.code) }).toEqual({ connection, codes: ["AWAITING_STREAM"] });
      expect(health.verdict).toBe("DEGRADED");
    }
  });

  it("membership is the scanner's full partition: a placed symbol in no known state, or a selection that does not match the symbols, is MEMBERSHIP_INCONSISTENT", () => {
    const connections = [{ lifecycle: "OPEN", lastMessageAgoMs: 1_000 }];
    expect(judge(detailed({ readiness: [...many(20, "LIVE_ELIGIBLE"), { readiness: "RECOVERY_REQUIRED" }], connections })).issues.map((i) => i.code)).toEqual(["MEMBERSHIP_INCONSISTENT"]);
    expect(judge(detailed({ readiness: many(20, "LIVE_ELIGIBLE"), connections, selected: 25 })).issues.map((i) => i.code)).toEqual(["MEMBERSHIP_INCONSISTENT"]);
    // Recovering symbols are their own issue — never also an inconsistency.
    expect(judge(detailed({ readiness: [...many(20, "LIVE_ELIGIBLE"), { readiness: "RECOVERING", status: "RECOVERING" }], connections })).issues.map((i) => i.code)).toEqual(["SYMBOLS_RECOVERING"]);
    expect(judge(detailed({ readiness: many(20, "LIVE_ELIGIBLE"), connections })).verdict).toBe("HEALTHY");
  });

  it("a status without that detail (an older scanner) keeps the strict reading: an awaiting symbol is an issue — reported once, not twice", () => {
    const health = judge(scannerStatus({}, { awaitingStream: 1, liveEligible: 521 }));
    expect(health.issues.map((i) => i.code)).toEqual(["AWAITING_STREAM"]);
    expect(health.universe.awaitingStreamQuiet).toBeNull();
  });
});

describe("emitter health", () => {
  const status = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema: "teddy.native-alerts.multi-symbol-emitter-status.v1",
      pid: 888,
      runId: "R1",
      mode: "COMMIT_DASHBOARD_ALERTS",
      writtenAt: new Date(NOW - 10_000).toISOString(),
      symbolsTracked: 524,
      symbolsHealthy: 524,
      symbolsFailed: 0,
      queueDepth: 0,
      queueCapacity: 10_000,
      maxQueueDepth: 9_000,
      catchUp: { backlogLanes: 0 },
      created: 3,
      ledgerDuplicates: 0,
      membership: { failure: null },
      ...over,
    });
  const judge = (text: string | null, selected: number | null = 522, owned = [888]) =>
    judgeEmitterHealth({ statusText: text, nowMs: NOW, ownedRuntimePids: owned, expectedRunId: "R1", scannerSelected: selected, policy: POLICY });

  it("historical lanes beyond the scanner's current selection are a NOTE, not a failure", () => {
    expect(judge(status())).toMatchObject({ verdict: "HEALTHY", laneNote: "HISTORICAL_LANES_BEYOND_CURRENT_SELECTION" });
    expect(judge(status({ symbolsTracked: 522, symbolsHealthy: 522 }))).toMatchObject({ verdict: "HEALTHY", laneNote: "MATCHES_SCANNER_SELECTION" });
  });

  it("CATCHING_UP while lanes are behind or the queue is half full; DEGRADED on failed lanes or a broken journal; STALE when old", () => {
    expect(judge(status({ queueDepth: 6_000 })).verdict).toBe("CATCHING_UP");
    expect(judge(status({ catchUp: { backlogLanes: 3 } })).verdict).toBe("CATCHING_UP");
    expect(judge(status({ symbolsFailed: 1, symbolsHealthy: 523 })).issues.map((i) => i.code)).toEqual(["LANES_FAILED"]);
    expect(judge(status({ membership: { failure: "seq gap" } })).verdict).toBe("DEGRADED");
    expect(judge(status({ mode: "DRY_RUN" })).issues.map((i) => i.code)).toContain("WRONG_MODE");
    expect(judge(status({ writtenAt: new Date(NOW - 6 * 60_000).toISOString() })).verdict).toBe("STALE");
  });

  it("another pid or another run vouches for nothing", () => {
    expect(judge(status(), 522, [889]).verdict).toBe("AWAITING_STATUS");
    expect(judge(status({ runId: "R0" })).verdict).toBe("AWAITING_STATUS");
  });

  it("an emitter still re-validating its lanes is INITIALIZING (alive, not yet healthy) — and STALE like any other once it stops writing", () => {
    const initializing = { initialization: { complete: false, lanesBaselined: 200, lanesTotal: 524 } };
    expect(judge(status(initializing))).toMatchObject({ verdict: "INITIALIZING", ours: true, initialization: { lanesBaselined: 200, lanesTotal: 524 } });
    expect(judge(status({ ...initializing, writtenAt: new Date(NOW - 6 * 60_000).toISOString() })).verdict).toBe("STALE");
    expect(judge(status({ initialization: { complete: true, lanesBaselined: 524, lanesTotal: 524 } })).verdict).toBe("HEALTHY");
    // An emitter that predates the field is judged exactly as before.
    expect(judge(status())).toMatchObject({ verdict: "HEALTHY", initialization: null });
  });
});

describe("planner health and its baseline", () => {
  const plans = (error: number) => ({ PENDING: 0, READY: 9, INVALID: 0, ERROR: error });

  it("judges NEW failures only; a historical baseline is healthy", () => {
    const baseline = { jobsFailed: 2, plansError: 3, establishedAt: "x" };
    expect(judgePlannerHealth({ plannerStatus: plannerStatusBody(), plans: plans(3), baseline, nowMs: NOW, pendingSinceMs: null, policy: POLICY }).verdict).toBe("HEALTHY");
    const worse = judgePlannerHealth({ plannerStatus: plannerStatusBody({ failed: 4 }), plans: plans(5), baseline, nowMs: NOW, pendingSinceMs: null, policy: POLICY });
    expect(worse.issues.map((i) => i.code)).toEqual(["NEW_JOB_FAILURES", "NEW_PLAN_ERRORS"]);
    expect(worse.delta).toEqual({ jobsFailed: 2, plansError: 2 });
  });

  it("a persistent pending backlog, a dead heartbeat and a last-sweep error degrade; an unreadable status is UNKNOWN", () => {
    const at = (over: Parameters<typeof plannerStatusBody>[0], pendingSinceMs: number | null) =>
      judgePlannerHealth({ plannerStatus: plannerStatusBody(over), plans: plans(0), baseline: { jobsFailed: 2, plansError: 0, establishedAt: "x" }, nowMs: NOW, pendingSinceMs, policy: POLICY });
    expect(at({ pending: 4 }, NOW - 20 * 60_000).issues.map((i) => i.code)).toEqual(["PENDING_BACKLOG_PERSISTENT"]);
    expect(at({ pending: 4 }, NOW - 60_000).verdict).toBe("HEALTHY");
    expect(at({ state: "OFF", consumers: 0 }, null)).toMatchObject({ verdict: "DEGRADED", heartbeatMissing: true });
    expect(at({ lastSweepError: "boom" }, null).issues.map((i) => i.code)).toEqual(["LAST_SWEEP_ERROR"]);
    expect(judgePlannerHealth({ plannerStatus: null, plans: null, baseline: null, nowMs: NOW, pendingSinceMs: null, policy: POLICY }).verdict).toBe("UNKNOWN");
  });

  it("the baseline is established once, follows counters DOWN (retention), and never moves up to hide an increase", () => {
    const first = nextPlannerBaseline(null, { jobsFailed: 2, plansError: 3 }, "t1");
    expect(first).toMatchObject({ event: "ESTABLISHED", baseline: { jobsFailed: 2, plansError: 3 } });
    expect(nextPlannerBaseline(first.baseline, { jobsFailed: 9, plansError: 9 }, "t2")).toMatchObject({ event: null, baseline: { jobsFailed: 2, plansError: 3 } });
    expect(nextPlannerBaseline(first.baseline, { jobsFailed: 0, plansError: 5 }, "t3")).toMatchObject({ event: "RESET_COUNTERS_WENT_BACKWARDS", baseline: { jobsFailed: 0, plansError: 3 } });
    expect(nextPlannerBaseline(null, { jobsFailed: null, plansError: 3 }, "t")).toMatchObject({ baseline: null, event: null });
  });
});

describe("ownership records and the instance authority", () => {
  const child: ChildRecord = { role: "scanner", pid: 1200, startedAtMs: 5_000, spawnedAt: "x", spawnedByGeneration: 3, sequence: 2, commandIdentity: "pnpm …", stopFile: "C:\\local\\x.stop", pinnedRunId: null, engineFingerprint: ENGINE };
  const file = (over: Record<string, unknown> = {}) => JSON.stringify({ schema: ALWAYS_ON_OWNERSHIP_SCHEMA, generation: 3, repoRoot: "C:\\repo", supervisor: null, children: [child], writtenAt: "x", ...over });

  it("parses strictly: absent, valid, or unreadable — never 'nothing owned' for a broken file", () => {
    expect(parseOwnership(null)).toEqual({ kind: "ABSENT" });
    expect(parseOwnership(file()).kind).toBe("VALID");
    for (const bad of ["{", file({ schema: "other" }), file({ generation: -1 }), file({ children: [{ ...child, pid: 0 }] }), file({ children: [{ ...child, role: "account-a-worker" }] })]) {
      expect(parseOwnership(bad).kind).toBe("UNREADABLE");
    }
  });

  it("generations only go up; only the generation on disk is current", () => {
    expect(nextGeneration(parseOwnership(file()))).toBe(4);
    expect(nextGeneration({ kind: "ABSENT" })).toBe(1);
    expect(generationIsCurrent(parseOwnership(file()), 3)).toBe(true);
    expect(generationIsCurrent(parseOwnership(file()), 2)).toBe(false);
    expect(generationIsCurrent({ kind: "ABSENT" }, 3)).toBe(false);
    expect(generationIsCurrent({ kind: "UNREADABLE", reason: "x" }, 3)).toBe(false);
  });

  it("adoption: provably ours is adopted; gone / recycled / another repo is dropped; an unobservable probe decides nothing", () => {
    const probe = (process: { commandLine: string; startedAtMs: number } | null) => () => ({ observed: true as const, process: process === null ? null : { pid: 1200, ...process } });
    expect(decideAdoption([child], probe({ commandLine: "cmd /c pnpm -C C:\\repo", startedAtMs: 5_400 }), "C:\\repo")?.[0].decision).toBe("ADOPT");
    expect(decideAdoption([child], probe(null), "C:\\repo")?.[0]).toMatchObject({ decision: "DROP", reason: "GONE" });
    expect(decideAdoption([child], probe({ commandLine: "cmd /c pnpm -C C:\\repo", startedAtMs: 9_000 }), "C:\\repo")?.[0]).toMatchObject({ decision: "DROP", reason: "PID_REUSED" });
    expect(decideAdoption([child], probe({ commandLine: "cmd /c pnpm -C C:\\other", startedAtMs: 5_000 }), "C:\\repo")?.[0]).toMatchObject({ decision: "DROP", reason: "NOT_THIS_REPO" });
    expect(decideAdoption([child], () => ({ observed: false }), "C:\\repo")).toBeNull();
  });

  it("adoption: a record written by ANOTHER repository's supervisor is dropped whole, unprobed — even when the command-line containment check would pass", () => {
    const worktreeChild = { ...child, commandIdentity: "cmd /c pnpm -C C:\\repo-wt\\x" };
    const probe = () => ({ observed: true as const, process: { pid: 1200, commandLine: "cmd /c pnpm -C C:\\repo-wt\\x --filter backend", startedAtMs: 5_000 } });
    // The containment check alone accepts it ("c:\repo" is inside "c:\repo-wt\x")...
    expect(decideAdoption([worktreeChild], probe, "C:\\repo")?.[0].decision).toBe("ADOPT");
    // ...so the recorded repository decides first.
    expect(decideAdoption([worktreeChild], probe, "C:\\repo", "C:\\repo-wt\\x")).toEqual([{ child: worktreeChild, decision: "DROP", reason: "OTHER_REPOSITORY" }]);
    expect(decideAdoption([worktreeChild], () => ({ observed: false }), "C:\\repo", "C:\\repo-wt\\x")?.[0]).toMatchObject({ reason: "OTHER_REPOSITORY" });
    expect(sameRepository("C:\\repo", "c:\\REPO\\")).toBe(true);
    expect(sameRepository("C:\\repo", "C:/repo")).toBe(true);
    expect(sameRepository("C:\\repo", "C:\\repo-wt\\x")).toBe(false);
  });

  it("supervisor liveness for stop / status / clear-latch: a probe or read that FAILED is UNKNOWN, never 'not running'", () => {
    const supervisor = { pid: 60, startedAtMs: 1_000, startedAt: "x", commandIdentity: "x", instancePort: 4019 };
    const recorded = file({ generation: 7, supervisor });
    const alive = () => ({ observed: true as const, process: { pid: 60, startedAtMs: 1_200, commandLine: "node C:\\repo\\apps\\backend\\src\\modules\\always-on\\run-always-on-monitoring.ts" } });
    const failedProbe = () => ({ observed: false as const });
    const failedRead = (): string | null => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    };
    expect(supervisorLiveness(() => recorded, alive)).toEqual({ kind: "RUNNING", generation: 7, pid: 60 });
    // The finding: one failed PowerShell/CIM probe ended `stop`'s wait with "The supervisor has exited." (exit 0).
    expect(supervisorLiveness(() => recorded, failedProbe)).toMatchObject({ kind: "UNKNOWN" });
    expect(supervisorLiveness(failedRead, alive)).toMatchObject({ kind: "UNKNOWN" });
    expect(supervisorLiveness(() => "{not json", alive)).toMatchObject({ kind: "UNKNOWN" });
    // Proven absences stay NOT_RUNNING.
    expect(supervisorLiveness(() => null, alive)).toEqual({ kind: "NOT_RUNNING" });
    expect(supervisorLiveness(() => file({ supervisor: null }), alive)).toEqual({ kind: "NOT_RUNNING" });
    expect(supervisorLiveness(() => recorded, () => ({ observed: true as const, process: null }))).toEqual({ kind: "NOT_RUNNING" });
    expect(supervisorLiveness(() => recorded, () => ({ observed: true as const, process: { ...alive().process, startedAtMs: 9_000 } }))).toEqual({ kind: "NOT_RUNNING" });
  });

  it("the instance authority is exclusive on a real loopback port, and released on close", async () => {
    const open = () => {
      const server = createServer();
      return {
        listen: (host: string, port: number) => new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host, port, exclusive: true }, () => resolve()); }),
        close: () => new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve())),
      };
    };
    const probe = createServer();
    const port: number = await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve((probe.address() as { port: number }).port)));
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const first = await listenerInstanceLock(open, { port }).acquire();
    expect(first.ok).toBe(true);
    const second = await listenerInstanceLock(open, { port }).acquire();
    expect(second).toMatchObject({ ok: false, outcome: "BUSY" });
    if (first.ok) await first.held.release();
    const third = await listenerInstanceLock(open, { port }).acquire();
    expect(third.ok).toBe(true);
    if (third.ok) await third.held.release();
  });
});

describe("spawn plans, the child environment and the census", () => {
  const keys = ["DATABASE_URL", "REDIS_URL"];
  const stop = "C:\\local\\trading-alert-dashboard\\monitoring\\always-on\\stop\\scanner-g1-s1.stop";

  it("the child environment drops every credential name case-insensitively, the generic file's names, and pins DOTENV_CONFIG_PATH last", () => {
    const env = monitoringChildEnv(DIRTY_ENV, keys);
    expect(Object.keys(env).sort()).toEqual(["ComSpec", "DOTENV_CONFIG_PATH", "LOCALAPPDATA", "PATH"]);
    expect(env.DOTENV_CONFIG_PATH).toBe(path.join("C:\\local", "trading-alert-dashboard", "env", "generic.env"));
    expect(credentialNamesPresent(DIRTY_ENV)).toEqual(["API_KEY", "Api_Secret", "BINANCE_API_KEY", "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER", "EXECUTION_PROFILE_ENVIRONMENT", "binance_api_secret"]);
    expect(DIRTY_ENV.BINANCE_API_KEY).toBe("never-inherited-key"); // the parent environment is never modified
  });

  it("each plan is the repo's own entry started as node itself (never through cmd.exe), carrying the repository path", () => {
    const tsx = "C:\\repo\\apps\\backend\\node_modules\\tsx\\dist\\cli.mjs";
    expect(backendSpawnPlan("C:\\repo", DIRTY_ENV, keys)).toMatchObject({ command: process.execPath, args: ["C:\\repo\\apps\\backend\\dist\\src\\server.js"], cwd: "C:\\repo\\apps\\backend" });
    const scanner = scannerSpawnPlan("C:\\repo", DIRTY_ENV, keys, { profileName: "teddy-7-all-active", stopFile: stop, extraArgs: ["--max-total-requests", "12000"] });
    expect(scanner).toMatchObject({ command: process.execPath, cwd: "C:\\repo\\apps\\backend" });
    expect(scanner.args).toEqual([tsx, "src/modules/native-scanner/run-live-shadow-supervisor.ts", "--profile", "teddy-7-all-active", "--stop-file", stop, "--max-total-requests", "12000"]);
    expect(plannerSpawnPlan("C:\\repo", DIRTY_ENV, keys).args).toEqual([tsx, "src/modules/native-planning/native-plan.worker.ts"]);
    const emitter = emitterSpawnPlan("C:\\repo", DIRTY_ENV, keys, { profileName: "teddy-7-all-active", runId: "20261023T110000Z-0a0b0c0d", engineFingerprint: ENGINE, queueCapacity: 10_000, activateAtEof: false, stopFile: stop });
    expect(emitter.args).toEqual(expect.arrayContaining([tsx, "src/modules/native-alerts/run-native-multi-emitter.ts", "--commit-dashboard-alerts", "--follow", "--run-id", "20261023T110000Z-0a0b0c0d"]));
    // The entries are exactly what the operator's package scripts run (`tsx <entry>`): plans and scripts cannot drift apart.
    const scripts = (JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect([scripts["scanner:live-shadow-supervisor"], scripts["native-alerts:multi-emitter"], scripts["native-alerts:plan-worker"]]).toEqual([
      `tsx ${MONITORING_ENTRYPOINTS.scanner}`,
      `tsx ${MONITORING_ENTRYPOINTS.emitter}`,
      `tsx ${MONITORING_ENTRYPOINTS.planner}`,
    ]);
    // Every plan parses with the real CLI parsers (no unknown argument can reach a child).
    expect(() => parseSupervisorCliArgs(scannerSpawnPlan("C:\\repo", DIRTY_ENV, keys, { profileName: "teddy-7-all-active", stopFile: stop, extraArgs: [] }).args.slice(2))).not.toThrow();
    expect(parseMultiEmitterCliArgs(emitter.args.slice(2))).toMatchObject({ mode: "COMMIT_DASHBOARD_ALERTS", follow: true, stopFile: stop, queueCapacity: 10_000, activateAtEof: false });
  });

  it("refuses arguments cmd or pnpm could re-split, and malformed pins", () => {
    expect(() => backendSpawnPlan("C:\\my repo", DIRTY_ENV, keys)).toThrow(MonitoringPlanError);
    expect(() => scannerSpawnPlan("C:\\repo", DIRTY_ENV, keys, { profileName: "teddy-7-all-active", stopFile: "C:\\a b\\x.stop", extraArgs: [] })).toThrow(MonitoringPlanError);
    expect(() => scannerSpawnPlan("C:\\repo", DIRTY_ENV, keys, { profileName: "x & calc", stopFile: stop, extraArgs: [] })).toThrow(MonitoringPlanError);
    expect(() => emitterSpawnPlan("C:\\repo", DIRTY_ENV, keys, { profileName: "teddy-7-all-active", runId: "latest", engineFingerprint: ENGINE, queueCapacity: 10_000, activateAtEof: false, stopFile: stop })).toThrow(MonitoringPlanError);
    expect(() => emitterSpawnPlan("C:\\repo", DIRTY_ENV, keys, { profileName: "teddy-7-all-active", runId: "20261023T110000Z-0a0b0c0d", engineFingerprint: "abc", queueCapacity: 10_000, activateAtEof: false, stopFile: stop })).toThrow(MonitoringPlanError);
  });

  it("the census classifies runtimes only (never wrappers) and attributes ownership by ANCESTRY to an owned root", () => {
    const node = (pid: number, parentPid: number, executable: string, commandLine: string): ObservedProcessNode => ({ pid, parentPid, executable, startedAtMs: 1, commandLine });
    const tree = [
      node(10, 50, "cmd.exe", "cmd /d /s /c pnpm -C C:\\repo --filter b scanner:live-shadow-supervisor"),
      node(11, 10, "node.exe", "node C:\\repo\\node_modules\\pnpm\\bin\\pnpm.cjs scanner:live-shadow-supervisor"),
      node(12, 11, "cmd.exe", "cmd /c tsx src/modules/native-scanner/run-live-shadow-supervisor.ts"),
      node(13, 12, "node.exe", "node C:\\repo\\node_modules\\tsx\\dist\\cli.mjs src/modules/native-scanner/run-live-shadow-supervisor.ts"),
      node(14, 13, "node.exe", "node --import loader.mjs src/modules/native-scanner/run-live-shadow-supervisor.ts"),
      node(20, 1, "node.exe", "node src/modules/native-alerts/run-native-multi-emitter.ts"),
      node(30, 1, "node.exe", "node src/modules/signal-quality/run-signal-quality-soak-monitor.ts"),
      node(40, 1, "node.exe", "node src/modules/always-on/run-always-on-monitoring.ts run"),
    ];
    expect(tree.map((n) => classifyMonitoringRuntime(n))).toEqual([null, null, null, null, "scanner", "emitter", "soakMonitor", "supervisor"]);
    const census = monitoringCensus(tree, { scanner: 10 }, 99);
    expect(census.owned.scanner).toEqual([14]);
    expect(census.external.emitter).toEqual([20]);
    expect(census.soakMonitors).toEqual([30]);
    expect(census.otherSupervisors).toEqual([40]);
    expect(monitoringCensus(tree, {}, 99).external.scanner).toEqual([14]);
    // A second scanner runtime OUTSIDE the owned tree is external even while an owned scanner exists.
    const withManual = [...tree, node(60, 1, "node.exe", "node C:\\elsewhere\\apps\\backend\\src\\modules\\native-scanner\\run-live-shadow-supervisor.ts")];
    const mixed = monitoringCensus(withManual, { scanner: 10 }, 99);
    expect(mixed.owned.scanner).toEqual([14]);
    expect(mixed.external.scanner).toEqual([60]);
  });

  it("stop files are unique per role, generation and spawn", () => {
    const paths = alwaysOnPaths({ LOCALAPPDATA: "C:\\local" });
    expect(childStopFile(paths, "scanner", 2, 5)).toBe(path.join(paths.stopDir, "scanner-g2-s5.stop"));
    expect(new Set([childStopFile(paths, "scanner", 1, 1), childStopFile(paths, "scanner", 2, 1), childStopFile(paths, "emitter", 1, 1)]).size).toBe(3);
    expect(() => alwaysOnPaths({})).toThrow(/LOCALAPPDATA/);
  });
});

describe("cooperative stop (scanner and emitter CLIs)", () => {
  it("both CLIs accept --stop-file and default to none; the path must be absolute, outside the repo, *.stop", () => {
    expect(parseSupervisorCliArgs(["--profile", "teddy-7-all-active"]).stopFile).toBeNull();
    expect(parseSupervisorCliArgs(["--profile", "teddy-7-all-active", "--stop-file", "C:\\x\\a.stop"]).stopFile).toBe("C:\\x\\a.stop");
    expect(parseMultiEmitterCliArgs(["--profile", "teddy-7-all-active", "--run-id", "20261023T110000Z-0a0b0c0d", "--expect-engine-fingerprint", ENGINE]).stopFile).toBeNull();
    expect(validateStopFilePath("C:\\local\\x\\a.stop", "C:\\repo")).toBe("C:\\local\\x\\a.stop");
    for (const bad of ["relative.stop", "C:\\repo\\apps\\a.stop", "C:\\local\\a.txt"]) expect(() => validateStopFilePath(bad, "C:\\repo")).toThrow(CooperativeStopUsageError);
  });

  it("the watcher calls the graceful stop exactly once when the file appears, and can be closed", () => {
    let tick: () => void = () => undefined;
    let cancelled = 0;
    let stops = 0;
    let present = false;
    watchCooperativeStop({ file: "f", onStop: () => (stops += 1), exists: () => present, every: (fn) => ((tick = fn), {}), cancel: () => (cancelled += 1) });
    tick();
    expect(stops).toBe(0);
    present = true;
    tick();
    tick();
    expect([stops, cancelled]).toEqual([1, 1]);
    const closed = watchCooperativeStop({ file: "f", onStop: () => (stops += 1), exists: () => true, every: (fn) => ((tick = fn), {}), cancel: () => undefined });
    closed.close();
    tick();
    expect(stops).toBe(1);
  });
});

describe("incident journal", () => {
  it("one line per record, generation-tagged, with credential-looking text redacted", () => {
    const lines: string[] = [];
    const journal = new IncidentJournal({ file: "j", append: (_f, line) => lines.push(line), now: () => NOW, generation: () => 4, log: () => undefined });
    journal.record({ kind: "ROLE_EXITED", role: "scanner", reasonCode: "GONE", detail: "exit with API_SECRET=abc123 via postgresql://user:pw@host/db", facts: { note: "TOKEN: xyz" } });
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({ schema: "teddy.native-monitoring.always-on-incident.v1", generation: 4, seq: 1, kind: "ROLE_EXITED", role: "scanner" });
    expect(lines[0]).not.toMatch(/abc123|user:pw|xyz/);
    expect(redactIncidentText("DATABASE_URL=postgres://a")).toBe("DATABASE_URL=***");
  });
});

describe("Windows startup task (built, never registered)", () => {
  it("a logon task, one minute delayed, interactive user, least privilege, no time limit, ignore a second instance — starting ONLY the supervisor", () => {
    const xml = startupTaskXml({ taskName: "TeddyAlwaysOnMonitoring", repoRoot: "C:\\repo", runArgs: ["--emitter-activate-at-eof"], userId: "HOST\\operator" });
    for (const fragment of ["<LogonTrigger>", "<Delay>PT1M</Delay>", "<LogonType>InteractiveToken</LogonType>", "<RunLevel>LeastPrivilege</RunLevel>", "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>", "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>", "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"]) {
      expect(xml).toContain(fragment);
    }
    expect(startupTaskArguments({ repoRoot: "C:\\repo", runArgs: [] })).toBe("/d /c pnpm -C C:\\repo --filter @trading-alert-dashboard/backend monitoring:always-on run");
    expect(xml).not.toMatch(/execution-worker|account-control|runtime:launcher|LIVE_READY|arm/i);
    expect(startupTaskXmlBytes(xml).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(startupTaskCommands("TeddyAlwaysOnMonitoring", "C:\\x.xml")[0]).toBe('schtasks /Create /TN "TeddyAlwaysOnMonitoring" /XML "C:\\x.xml"');
    expect(() => startupTaskXml({ taskName: "T", repoRoot: "C:\\repo", runArgs: [], userId: null })).toThrow(StartupTaskError);
    expect(() => startupTaskArguments({ repoRoot: "C:\\my repo", runArgs: [] })).toThrow(StartupTaskError);
  });
});

describe("the monitoring:always-on CLI arguments", () => {
  it("run defaults to the documented profile and all four roles; tuning is validated by the scanner's own parser", () => {
    expect(parseAlwaysOnCliArgs(["run"])).toMatchObject({ command: "run", profileName: "teddy-7-all-active", engineFingerprint: ENGINE, roles: ["backend", "scanner", "emitter", "planner"], emitterActivateAtEof: false, scannerExtraArgs: [], pollMs: 15_000 });
    expect(parseAlwaysOnCliArgs(["run", "--roles", "scanner,emitter", "--scanner-max-total-requests", "12000"])).toMatchObject({ roles: ["scanner", "emitter"], scannerExtraArgs: ["--max-total-requests", "12000"] });
    for (const bad of [["run", "--roles", "emitter"], ["run", "--scanner-max-total-requests", "999999"], ["run", "--profile", "nope"], ["run", "--arm"], ["run", "--account", "A"], [], ["serve"], ["clear-latch", "--role", "account-a-worker"]]) {
      expect(() => parseAlwaysOnCliArgs(bad), bad.join(" ")).toThrow(AlwaysOnCliUsageError);
    }
    expect(parseAlwaysOnCliArgs(["stop"])).toEqual({ command: "stop", waitSeconds: 600 });
    expect(parseAlwaysOnCliArgs(["startup-task", "--write"])).toMatchObject({ command: "startup-task", taskName: "TeddyAlwaysOnMonitoring", write: true, emitterActivateAtEof: false });
  });
});

describe("the runtime launcher's Always-On controls", () => {
  const base = (files: Map<string, string>, alive: boolean) =>
    createAlwaysOnLauncher({
      repoRoot: "C:\\repo",
      env: { LOCALAPPDATA: "C:\\local" },
      probeProcesses: (pids) => observed(new Map(alive ? pids.map((pid) => [pid, { pid, startedAtMs: 1_000, commandLine: "node C:\\repo\\apps\\backend\\src\\modules\\always-on\\run-always-on-monitoring.ts" }]) : [])),
      readText: (file) => files.get(file) ?? null,
      writeTextAtomic: (file, text) => void files.set(file, text),
      startSupervisor: () => 4242,
      lockAdapters: () => ({ authority: { acquire: async (action) => ({ ok: true, held: { action, release: async () => ({ released: true }) } }) }, log: () => undefined }),
      log: () => undefined,
      sleep: async () => undefined,
      now: () => NOW,
    });
  const paths = alwaysOnPaths({ LOCALAPPDATA: "C:\\local" });
  const ownership = JSON.stringify({ schema: ALWAYS_ON_OWNERSHIP_SCHEMA, generation: 7, repoRoot: "C:\\repo", supervisor: { pid: 60, startedAtMs: 1_000, startedAt: "x", commandIdentity: "x", instancePort: 4019 }, children: [], writtenAt: "x" });

  it("stop writes ONE generation-tagged request when a live supervisor is proven, and nothing otherwise", async () => {
    const files = new Map([[paths.ownership, ownership]]);
    await base(files, false).stop();
    expect(files.has(paths.stopRequest)).toBe(false);
    await base(files, true).stop();
    expect(JSON.parse(files.get(paths.stopRequest) as string)).toMatchObject({ schema: ALWAYS_ON_REQUEST_SCHEMA, kind: "STOP", generation: 7 });
  });

  it("the status line reports OFF / RUNNING; the launch environment carries no credential; the command is plain", () => {
    expect(base(new Map(), false).statusLine()).toBe("Always-On Monitoring (monitoring only): OFF");
    expect(base(new Map([[paths.ownership, ownership]]), true).statusLine()).toMatch(/RUNNING — generation 7/);
    expect(credentialNamesPresent(alwaysOnLaunchEnv(DIRTY_ENV))).toEqual([]);
    expect(alwaysOnSupervisorArgs("C:\\repo")).toEqual(["C:\\repo\\apps\\backend\\node_modules\\tsx\\dist\\cli.mjs", "src/modules/always-on/run-always-on-monitoring.ts", "run"]);
    expect(() => alwaysOnSupervisorArgs("C:\\my repo")).toThrow();
  });
});
