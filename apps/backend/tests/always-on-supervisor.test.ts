import path from "node:path";
import { describe, expect, it } from "vitest";

import { ALWAYS_ON_DEFAULTS, ALWAYS_ON_REQUEST_SCHEMA, STRIPPED_CREDENTIAL_KEYS } from "../src/modules/always-on/always-on-contract";
import { parseOwnership } from "../src/modules/always-on/always-on-ownership";
import { NATIVE_EXECUTION_ENABLED } from "../src/modules/native-canary/native-execution-switch";
import { ACCOUNT_SENSITIVE_KEYS } from "../src/modules/operator/dual-account-topology";
import {
  ENGINE,
  FakeMachine,
  HEALTHY_UNIVERSE,
  LOCAL,
  run,
  startSupervisor,
  testConfig,
  until,
} from "./helpers/always-on-fake-machine";

/**
 * ALWAYS-ON MONITORING V1 — the supervisor's behaviour, end to end over a fake
 * machine (process table, file system, local backend, public network, clock).
 * Numbered items are the milestone's required test matrix.
 */

async function healthyStack() {
  const m = new FakeMachine();
  const { supervisor, started } = await startSupervisor(m);
  expect(started).toEqual({ ok: true, generation: 1 });
  await until(m, supervisor, () => supervisor.status().state === "RUNNING");
  return { m, supervisor };
}

const scannerRuns = (m: FakeMachine) => m.spawns.filter((c) => c.role === "scanner").map((c) => c.runId);
const argAfter = (args: readonly string[], name: string) => args[args.indexOf(name) + 1];

describe("start-up and steady state", () => {
  it("starts the backend and the scanner, pins the emitter to OUR scanner's run, starts the planner, and reports RUNNING", async () => {
    const { m, supervisor } = await healthyStack();
    expect(m.spawns.map((c) => c.role)).toEqual(["backend", "scanner", "emitter", "planner"]);
    const [scanner] = m.spawns.filter((c) => c.role === "scanner");
    const emitter = m.spawns.find((c) => c.role === "emitter")!;
    expect(argAfter(emitter.plan.args, "--run-id")).toBe(scanner.runId);
    expect(argAfter(emitter.plan.args, "--expect-engine-fingerprint")).toBe(ENGINE);
    expect(emitter.plan.args).toEqual(expect.arrayContaining(["--commit-dashboard-alerts", "--follow", "--queue-capacity", "10000"]));
    expect(emitter.plan.args).not.toContain("--activate-at-eof");
    expect(argAfter(scanner.plan.args, "--profile")).toBe("teddy-7-all-active");
    const s = supervisor.status();
    expect(s.roles.scanner.runId).toBe(scanner.runId);
    expect(s.roles.emitter.pinnedRunId).toBe(scanner.runId);
    expect(s.lastEndToEndHealthyAt).not.toBeNull();
    expect(m.kinds()).toContain("SUPERVISOR_RETURNED_HEALTHY");
    // The status artifact is on disk, versioned, and claims nothing.
    const onDisk = JSON.parse(m.files.get(m.paths.status) as string);
    expect(onDisk).toMatchObject({ schema: "teddy.native-monitoring.always-on-status.v1", state: "RUNNING", authority: "NONE", nativeExecutionEnabled: false, accountExecution: "NONE" });
  });

  it("13. the active universe changing 524 → 522 with every current symbol healthy stays healthy (no size is a health invariant)", async () => {
    const { m, supervisor } = await healthyStack();
    const before = m.spawns.length;
    m.scannerUniverse = { ...HEALTHY_UNIVERSE, selected: 522, liveEligible: 522, exchangeCandidates: 522 };
    const outcomes = await run(m, supervisor, 20);
    expect(outcomes.every((o) => o === "CONTINUE")).toBe(true);
    expect(supervisor.status().state).toBe("RUNNING");
    expect(supervisor.status().roles.scanner.health?.universe).toMatchObject({ selected: 522, liveEligible: 522 });
    expect(m.spawns.length).toBe(before);
    expect(m.kinds()).not.toContain("SCANNER_DEGRADED");
  });

  it("14. the emitter tracking historical lanes beyond the scanner's current selection is NOT a failure", async () => {
    const { m, supervisor } = await healthyStack();
    m.scannerUniverse = { ...HEALTHY_UNIVERSE, selected: 522, liveEligible: 522, exchangeCandidates: 522 };
    m.emitterTracked = 524;
    await run(m, supervisor, 10);
    const s = supervisor.status();
    expect(s.state).toBe("RUNNING");
    expect(s.roles.emitter.state).toBe("RUNNING");
    expect(s.roles.emitter.health?.laneNote).toBe("HISTORICAL_LANES_BEYOND_CURRENT_SELECTION");
    expect(m.spawns.filter((c) => c.role === "emitter")).toHaveLength(1);
  });

  it("15. historical planner errors (ERROR = 3) with a zero delta stay healthy — nothing is reset or deleted to make them green", async () => {
    const { m, supervisor } = await healthyStack();
    await run(m, supervisor, 5);
    const s = supervisor.status();
    expect(s.roles.planner.state).toBe("RUNNING");
    expect(s.roles.planner.baseline).toMatchObject({ jobsFailed: 2, plansError: 3 });
    expect(s.roles.planner.health?.delta).toEqual({ jobsFailed: 0, plansError: 0 });
    expect(m.kinds()).toContain("PLANNER_BASELINE_ESTABLISHED");
    expect(m.plans.ERROR).toBe(3);
  });

  it("16. a NEW planner failure delta degrades health and is journaled once per increase; the planner is not restarted for it", async () => {
    const { m, supervisor } = await healthyStack();
    m.plans = { ...m.plans, ERROR: 4 };
    await run(m, supervisor, 3);
    let s = supervisor.status();
    expect(s.roles.planner.state).toBe("DEGRADED");
    expect(s.roles.planner.reasonCode).toBe("NEW_PLAN_ERRORS");
    expect(s.state).toBe("DEGRADED");
    expect(m.kinds().filter((k) => k === "PLANNER_FAILURE_DELTA_INCREASED")).toHaveLength(1);
    m.plannerOver = { failed: 5 };
    await run(m, supervisor, 3);
    s = supervisor.status();
    expect(s.roles.planner.health?.delta).toEqual({ jobsFailed: 3, plansError: 1 });
    expect(m.kinds().filter((k) => k === "PLANNER_FAILURE_DELTA_INCREASED")).toHaveLength(2);
    expect(m.spawns.filter((c) => c.role === "planner")).toHaveLength(1);
  });

  it("17. no private Binance / account credential reaches ANY child; generic.env is authoritative over every name it declares", async () => {
    const { m } = await healthyStack();
    const forbidden = new Set([...STRIPPED_CREDENTIAL_KEYS, ...ACCOUNT_SENSITIVE_KEYS].map((k) => k.toUpperCase()));
    expect(m.spawns.length).toBe(4);
    for (const child of m.spawns) {
      const keys = Object.keys(child.plan.env).map((k) => k.toUpperCase());
      expect({ role: child.role, leaked: keys.filter((k) => forbidden.has(k)) }).toEqual({ role: child.role, leaked: [] });
      expect(child.plan.env.DOTENV_CONFIG_PATH).toBe(path.join(LOCAL, "trading-alert-dashboard", "env", "generic.env"));
      expect(child.plan.env.DATABASE_URL).toBeUndefined();
      expect(child.plan.env.PATH).toBe("C:\\Windows");
      expect(JSON.stringify(child.plan.env)).not.toMatch(/never-inherited|account-a-identifier/);
    }
  });

  it("18. Native execution stays hard-disabled: the switch is false, no account or execution script is ever spawned, the status claims no authority", async () => {
    const { m, supervisor } = await healthyStack();
    expect(NATIVE_EXECUTION_ENABLED).toBe(false);
    const scripts = m.spawns.map((c) => c.plan.commandIdentity);
    expect(scripts).toEqual([
      "node apps/backend/dist/src/server.js",
      expect.stringMatching(/^scanner:live-shadow-supervisor: tsx src\/modules\/native-scanner\/run-live-shadow-supervisor\.ts --profile teddy-7-all-active --stop-file /),
      expect.stringMatching(/^native-alerts:multi-emitter: tsx src\/modules\/native-alerts\/run-native-multi-emitter\.ts --profile teddy-7-all-active --run-id /),
      "native-alerts:plan-worker: tsx src/modules/native-planning/native-plan.worker.ts",
    ]);
    for (const child of m.spawns) expect(child.plan.args.join(" ")).not.toMatch(/execution|account-control|arm|live-ready|binance:|set-policy|canary/i);
    expect(supervisor.status()).toMatchObject({ authority: "NONE", nativeExecutionEnabled: false, accountExecution: "NONE", notice: ["MONITORING ONLY", "NO ACCOUNT EXECUTION", "NATIVE EXECUTION HARD-DISABLED"] });
  });
});

describe("scanner health, network outages and the one recovery path", () => {
  it("7. a scanner that is ALIVE but degraded (failed / silent symbols) is DEGRADED, never RUNNING", async () => {
    const { m, supervisor } = await healthyStack();
    m.scannerBehaviour = "degraded";
    await run(m, supervisor, 1);
    const s = supervisor.status();
    expect(m.live("scanner")).toHaveLength(1);
    expect(s.roles.scanner.state).toBe("DEGRADED");
    expect(s.state).toBe("DEGRADED");
    expect(s.roles.scanner.health?.verdict).toBe("DEGRADED");
    expect(s.roles.scanner.health?.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["SYMBOLS_FAILED", "MEMBERSHIP_INCONSISTENT", "MARKET_DATA_STALE"]));
  });

  it("8. degradation inside the grace period restarts nothing (no stop file, no spawn, not even a network probe)", async () => {
    const { m, supervisor } = await healthyStack();
    const spawns = m.spawns.length;
    const probes = m.connectivityProbes;
    m.scannerBehaviour = "degraded";
    await run(m, supervisor, 5); // 75 s < 90 s grace
    expect(m.spawns.length).toBe(spawns);
    expect([...m.files.keys()].filter((k) => k.endsWith(".stop"))).toEqual([]);
    expect(m.connectivityProbes).toBe(probes);
    expect(supervisor.status().roles.scanner.reasonCode).toBe("SYMBOLS_FAILED");
    expect(m.kinds().filter((k) => k === "SCANNER_DEGRADED")).toHaveLength(1);
  });

  it("network outage: while public Binance is unreachable nothing is restarted and no attempt is spent; backend, emitter and planner keep running; a self-healing scanner is never restarted", async () => {
    const { m, supervisor } = await healthyStack();
    m.scannerBehaviour = "network-dependent";
    m.network = false;
    await run(m, supervisor, 40); // 10 minutes
    const s = supervisor.status();
    expect(s.roles.scanner.state).toBe("DEGRADED");
    expect(s.roles.scanner.reasonCode).toBe("NETWORK_UNAVAILABLE");
    expect(s.roles.scanner.attempts).toBe(0);
    expect(s.network.reachable).toBe(false);
    expect(m.spawns).toHaveLength(4);
    expect(m.spawns.every((c) => m.alive(c))).toBe(true);
    expect(["backend", "emitter", "planner"].map((r) => s.roles[r as "backend"].state)).toEqual(["RUNNING", "RUNNING", "RUNNING"]);
    expect(m.kinds().filter((k) => k === "NETWORK_UNAVAILABLE")).toHaveLength(1);
    expect(m.connectivityProbes).toBeLessThanOrEqual(Math.ceil((40 * 15_000) / ALWAYS_ON_DEFAULTS.connectivityProbeEveryMs) + 1);
    m.network = true;
    await run(m, supervisor, 3);
    expect(supervisor.status().state).toBe("RUNNING");
    expect(m.spawns).toHaveLength(4);
    expect(m.kinds()).not.toContain("SCANNER_RECOVERY_REQUESTED");
  });

  it("9 + 11. persistent failure after the network returns takes ONE fenced recovery path: emitter stopped, scanner stopped, one fresh run, emitter re-pinned to it", async () => {
    const { m, supervisor } = await healthyStack();
    m.scannerBehaviour = "degraded-until-restart";
    m.network = false;
    await run(m, supervisor, 12);
    expect(m.kinds()).not.toContain("SCANNER_RECOVERY_REQUESTED");
    m.network = true;
    await until(m, supervisor, () => m.kinds().includes("SCANNER_RECOVERY_SUCCEEDED") && supervisor.status().state === "RUNNING");
    const kinds = m.incidents().map((i) => `${i.kind}${i.role ? `:${i.role}` : ""}`);
    const at = (k: string) => kinds.indexOf(k);
    expect(at("NETWORK_RESTORED:scanner")).toBeGreaterThan(-1);
    expect(at("SCANNER_RECOVERY_REQUESTED:scanner")).toBeGreaterThan(at("NETWORK_RESTORED:scanner"));
    expect(at("ROLE_STOP_REQUESTED:emitter")).toBeGreaterThan(at("SCANNER_RECOVERY_REQUESTED:scanner"));
    expect(at("ROLE_STOPPED:emitter")).toBeGreaterThan(at("ROLE_STOP_REQUESTED:emitter"));
    expect(at("ROLE_STOP_REQUESTED:scanner")).toBeGreaterThan(at("ROLE_STOPPED:emitter"));
    expect(at("ROLE_STOPPED:scanner")).toBeGreaterThan(at("ROLE_STOP_REQUESTED:scanner"));
    expect(kinds.lastIndexOf("ROLE_STARTED:scanner")).toBeGreaterThan(at("ROLE_STOPPED:scanner"));
    expect(at("SCANNER_RECOVERY_SUCCEEDED:scanner")).toBeGreaterThan(kinds.lastIndexOf("ROLE_STARTED:scanner"));
    expect(kinds.lastIndexOf("EMITTER_STARTED_ON_RUN:emitter")).toBeGreaterThan(at("SCANNER_RECOVERY_SUCCEEDED:scanner"));
    expect(kinds.filter((k) => k === "SCANNER_RECOVERY_REQUESTED:scanner")).toHaveLength(1);
    // Exactly one fresh scanner; the old emitter is gone and the new one is pinned to the NEW run.
    const runs = scannerRuns(m);
    expect(runs).toHaveLength(2);
    const emitters = m.spawns.filter((c) => c.role === "emitter");
    expect(emitters).toHaveLength(2);
    expect(m.alive(emitters[0])).toBe(false);
    expect(emitters[0].pinnedRunId).toBe(runs[0]);
    expect(emitters[1].pinnedRunId).toBe(runs[1]);
    expect(supervisor.status().roles.emitter.pinnedRunId).toBe(runs[1]);
    // Cooperative stops were honoured: nothing was force-terminated; backend and planner were never touched.
    expect(m.terminated).toEqual([]);
    expect(m.spawns.filter((c) => c.role === "backend" || c.role === "planner")).toHaveLength(2);
    expect(supervisor.status().lastRecovery).toMatchObject({ role: "scanner", reasonCode: "SCANNER_DEGRADED_BEYOND_GRACE" });
    expect(supervisor.status().roles.scanner.attempts).toBe(1);
  });

  it("10. backoff prevents restart storms: a scanner that dies on every start is retried on a growing backoff, then LATCHES — nothing spawns after", async () => {
    const { m, supervisor } = await healthyStack();
    m.scannerBehaviour = "crash";
    await run(m, supervisor, 3 * 240); // three hours
    const starts = m.spawns.filter((c) => c.role === "scanner");
    expect(starts.length).toBe(1 + ALWAYS_ON_DEFAULTS.maxRecoveryAttempts);
    const status = supervisor.status();
    expect(status.state).toBe("LATCHED");
    expect(status.roles.scanner.latched).toBe(true);
    expect(m.kinds()).toContain("ROLE_LATCHED");
    expect(m.kinds()).toContain("SUPERVISOR_LATCHED");
    // The emitter was stopped with the first recovery and never pinned to a run that never became healthy.
    expect(m.spawns.filter((c) => c.role === "emitter")).toHaveLength(1);
    expect(status.roles.emitter.state).toBe("BLOCKED");
    // Backend and planner were never restarted by a scanner problem.
    expect(m.spawns.filter((c) => c.role === "backend" || c.role === "planner")).toHaveLength(2);
    const spawnsAtLatch = m.spawns.length;
    await run(m, supervisor, 240);
    expect(m.spawns.length).toBe(spawnsAtLatch);
  });

  it("10b. the gaps between those restarts grow (30 s, 1, 2, 5, 10 min)", async () => {
    const { m, supervisor } = await healthyStack();
    m.scannerBehaviour = "crash";
    const startTimes: number[] = [];
    let seen = m.spawns.filter((c) => c.role === "scanner").length;
    for (let i = 0; i < 3 * 240; i += 1) {
      await supervisor.tick();
      const now = m.spawns.filter((c) => c.role === "scanner").length;
      if (now > seen) startTimes.push(m.now);
      seen = now;
      m.now += 15_000;
    }
    const gaps = startTimes.slice(1).map((t, i) => (t - startTimes[i]) / 1000);
    expect(gaps).toEqual([30, 60, 120, 300, 600]);
  });

  it("clear-latch resumes supervision of a latched role", async () => {
    const { m, supervisor } = await healthyStack();
    m.scannerBehaviour = "crash";
    await run(m, supervisor, 3 * 240);
    expect(supervisor.status().state).toBe("LATCHED");
    m.scannerBehaviour = "healthy";
    m.files.set(m.paths.clearLatchRequest, JSON.stringify({ schema: ALWAYS_ON_REQUEST_SCHEMA, kind: "CLEAR_LATCH", role: "scanner", generation: 1 }));
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    expect(m.kinds()).toContain("LATCH_CLEARED");
    expect(m.files.has(m.paths.clearLatchRequest)).toBe(false);
  });

  it("a cooperative stop that is not honoured is completed by the FENCED stop after its window (ownership re-proven first)", async () => {
    const { m, supervisor } = await healthyStack();
    m.honourStops = false;
    m.scannerBehaviour = "degraded-until-restart";
    await until(m, supervisor, () => m.kinds().includes("SCANNER_RECOVERY_SUCCEEDED"), 200);
    const [emitter] = m.spawns.filter((c) => c.role === "emitter");
    const [scanner] = m.spawns.filter((c) => c.role === "scanner");
    expect(m.terminated).toEqual([emitter.root, scanner.root]);
    expect(m.kinds().filter((k) => k === "ROLE_FORCE_STOPPED")).toHaveLength(2);
    const requested = m.incidents().find((i) => i.kind === "ROLE_STOP_REQUESTED" && i.role === "emitter");
    expect(requested?.detail).toMatch(/cooperative stop requested/);
  });

  it("an owned scanner that EXITS is replaced through the same recovery path (emitter first), never beside a live one", async () => {
    const { m, supervisor } = await healthyStack();
    const [scanner] = m.live("scanner");
    m.kill(scanner.root);
    await until(m, supervisor, () => m.kinds().includes("SCANNER_RECOVERY_SUCCEEDED") && supervisor.status().state === "RUNNING");
    expect(m.incidents().find((i) => i.kind === "ROLE_EXITED")?.role).toBe("scanner");
    expect(m.incidents().find((i) => i.kind === "SCANNER_RECOVERY_REQUESTED")?.reasonCode).toBe("SCANNER_EXITED");
    expect(m.live("scanner")).toHaveLength(1);
    expect(m.live("emitter")).toHaveLength(1);
    expect(m.live("emitter")[0].pinnedRunId).toBe(m.live("scanner")[0].runId);
  });
});

describe("ownership, generations and fencing", () => {
  it("12. an OLD generation cannot stop, start or adopt anything once a newer generation owns the stack", async () => {
    const { m, supervisor: oldGen } = await healthyStack();
    const spawns = m.spawns.length;
    const { supervisor: newGen, started } = await startSupervisor(m, testConfig(), {}, 51);
    expect(started).toEqual({ ok: true, generation: 2 });
    expect(m.kinds().filter((k) => k === "CHILD_ADOPTED")).toHaveLength(4);
    // The old generation's every action is refused: a stop request, a tick, a shutdown.
    oldGen.requestShutdown("OLD_GENERATION_TRIES_TO_STOP");
    expect(await oldGen.tick()).toBe("FENCED");
    expect(await oldGen.tick()).toBe("FENCED");
    expect(m.terminated).toEqual([]);
    expect(m.spawns.length).toBe(spawns);
    expect([...m.files.keys()].filter((k) => k.endsWith(".stop"))).toEqual([]);
    expect(m.kinds()).toContain("SUPERVISOR_FENCED");
    // The new generation keeps every child running and healthy.
    await run(m, newGen, 3);
    expect(newGen.status().state).toBe("RUNNING");
    expect(m.spawns.every((c) => m.alive(c))).toBe(true);
    const ownership = parseOwnership(m.files.get(m.paths.ownership) as string);
    expect(ownership.kind === "VALID" && ownership.file.generation).toBe(2);
    expect(JSON.parse(m.files.get(m.paths.status) as string).generation).toBe(2);
  });

  it("a newer generation taking over BETWEEN a decision and its mutation is caught by the fence re-checked UNDER the lock: nothing is spawned", async () => {
    const m = new FakeMachine();
    // This supervisor's tick decides to start the backend (its generation is current then). While it acquires
    // the mutation lock, a newer generation takes over — only the re-check under the lock can stop the spawn.
    let takeovers = 0;
    const { supervisor } = await startSupervisor(m, testConfig(), {
      mutation: async (_action, runFn) => {
        if (takeovers === 0) {
          takeovers += 1;
          const file = parseOwnership(m.files.get(m.paths.ownership) as string);
          if (file.kind === "VALID") m.files.set(m.paths.ownership, JSON.stringify({ ...file.file, generation: file.file.generation + 1 }));
        }
        return { ran: true, result: await runFn() };
      },
    });
    expect(await supervisor.tick()).toBe("FENCED");
    expect(takeovers).toBe(1);
    expect(m.spawns).toEqual([]);
    expect(m.terminated).toEqual([]);
    expect(m.kinds()).toContain("SUPERVISOR_FENCED");
    expect(await supervisor.tick()).toBe("FENCED");
    expect(m.spawns).toEqual([]);
  });

  it("a new generation ADOPTS provably-owned children and DROPS (never kills) a recycled pid", async () => {
    const { m } = await healthyStack();
    const [emitter] = m.live("emitter");
    const root = m.nodes.get(emitter.root)!;
    m.nodes.set(emitter.root, { ...root, startedAtMs: root.startedAtMs + 60_000 }); // the root pid was recycled
    const { supervisor, started } = await startSupervisor(m, testConfig(), {}, 51);
    expect(started.ok).toBe(true);
    expect(m.kinds().filter((k) => k === "CHILD_ADOPTED")).toHaveLength(3);
    expect(m.incidents().find((i) => i.kind === "CHILD_RECORD_DROPPED")).toMatchObject({ role: "emitter", reasonCode: "PID_REUSED" });
    await run(m, supervisor, 4);
    // The old emitter runtime is now somebody else's: a CONFLICT, never terminated, never duplicated.
    expect(supervisor.status().roles.emitter.state).toBe("CONFLICT");
    expect(m.terminated).toEqual([]);
    expect(m.spawns.filter((c) => c.role === "emitter")).toHaveLength(1);
  });

  it("external monitoring processes are CONFLICT and never terminated; old soak monitors are reported as external", async () => {
    const m = new FakeMachine();
    const manualScanner = m.addExternal("src/modules/native-scanner/run-live-shadow-supervisor.ts");
    const soak = m.addExternal("src/modules/signal-quality/run-signal-quality-soak-monitor.ts");
    const { supervisor } = await startSupervisor(m);
    await run(m, supervisor, 6);
    const s = supervisor.status();
    expect(s.roles.scanner.state).toBe("CONFLICT");
    expect(s.roles.scanner.externalPids).toEqual([manualScanner]);
    expect(s.roles.emitter.state).toBe("BLOCKED");
    expect(s.external.soakMonitorPids).toEqual([soak]);
    expect(m.spawns.filter((c) => c.role === "scanner")).toHaveLength(0);
    expect(m.terminated).toEqual([]);
    expect(m.incidents().find((i) => i.kind === "EXTERNAL_MONITORING_PROCESS")?.reasonCode).toBe("SOAK_MONITOR_NOT_OWNED");
    // The manual scanner goes away: the conflict clears and the supervisor takes over.
    m.kill(m.nodes.get(manualScanner)!.parentPid);
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    expect(m.kinds()).toContain("ROLE_CONFLICT_CLEARED");
    expect(m.nodes.has(soak)).toBe(true);
  });

  it("a launcher-owned (external) backend on :4000 is read, never replaced", async () => {
    const m = new FakeMachine();
    m.externalBackend = true;
    m.addExternal("dist/src/server.js");
    const { supervisor } = await startSupervisor(m);
    await run(m, supervisor, 4);
    expect(supervisor.status().roles.backend.state).toBe("CONFLICT");
    expect(m.spawns.filter((c) => c.role === "backend")).toHaveLength(0);
    // Reads through the external backend still work: the planner starts.
    expect(m.spawns.filter((c) => c.role === "planner")).toHaveLength(1);
  });

  it("a stop request for an OLDER generation is ignored (and removed); one for the current generation stops the stack", async () => {
    const { m, supervisor } = await healthyStack();
    m.files.set(m.paths.stopRequest, JSON.stringify({ schema: ALWAYS_ON_REQUEST_SCHEMA, kind: "STOP", generation: 0 }));
    await run(m, supervisor, 2);
    expect(supervisor.status().state).toBe("RUNNING");
    expect(m.files.has(m.paths.stopRequest)).toBe(false);
    m.files.set(m.paths.stopRequest, JSON.stringify({ schema: ALWAYS_ON_REQUEST_SCHEMA, kind: "STOP", generation: 1 }));
    await until(m, supervisor, () => supervisor.status().state === "STOPPED", 100, 2_000);
    expect(m.kinds()).toContain("SUPERVISOR_STOPPED");
  });

  it("graceful stop: emitter → scanner (cooperative) → planner → backend (fenced); nothing external is touched; nothing stays owned", async () => {
    const { m, supervisor } = await healthyStack();
    const soak = m.addExternal("src/modules/signal-quality/run-signal-quality-soak-monitor.ts");
    supervisor.requestShutdown("TEST_STOP");
    const outcomes: string[] = [];
    for (let i = 0; i < 50 && outcomes.at(-1) !== "STOPPED"; i += 1) {
      outcomes.push(await supervisor.tick());
      m.now += 2_000;
    }
    expect(outcomes.at(-1)).toBe("STOPPED");
    const stopped = m.incidents().filter((i) => i.kind === "ROLE_STOPPED").map((i) => i.role);
    expect(stopped).toEqual(["emitter", "scanner", "planner", "backend"]);
    const planner = m.spawns.find((c) => c.role === "planner")!;
    const backend = m.spawns.find((c) => c.role === "backend")!;
    expect(m.terminated).toEqual([planner.root, backend.root]);
    expect(m.spawns.every((c) => !m.alive(c))).toBe(true);
    expect(m.nodes.has(soak)).toBe(true);
    const ownership = parseOwnership(m.files.get(m.paths.ownership) as string);
    expect(ownership.kind === "VALID" && ownership.file.supervisor).toBeNull();
    expect(ownership.kind === "VALID" && ownership.file.children).toEqual([]);
    expect(await supervisor.tick()).toBe("STOPPED");
  });

  it("11b. an emitter pinned to a SUPERSEDED run (left by an earlier generation) is stopped and re-pinned to the current run", async () => {
    const { m, supervisor } = await healthyStack();
    supervisor.detach("TEST");
    const read = parseOwnership(m.files.get(m.paths.ownership) as string);
    if (read.kind !== "VALID") throw new Error("ownership unreadable");
    const olderRun = "20261022T000000Z-0ddba11d";
    m.files.set(m.paths.ownership, JSON.stringify({ ...read.file, children: read.file.children.map((c) => (c.role === "emitter" ? { ...c, pinnedRunId: olderRun } : c)) }));
    const { supervisor: next } = await startSupervisor(m, testConfig(), {}, 51);
    await until(m, next, () => m.kinds().includes("EMITTER_STOPPED_RUN_SUPERSEDED") && next.status().state === "RUNNING");
    const emitters = m.spawns.filter((c) => c.role === "emitter");
    expect(emitters).toHaveLength(2);
    expect(m.alive(emitters[0])).toBe(false);
    expect(emitters[1].pinnedRunId).toBe(m.live("scanner")[0].runId);
    expect(next.status().roles.emitter.pinnedRunId).toBe(m.live("scanner")[0].runId);
    expect(m.incidents().find((i) => i.kind === "EMITTER_STOPPED_RUN_SUPERSEDED")?.reasonCode).toBe("PINNED_RUN_SUPERSEDED");
    // The scanner itself was never touched.
    expect(m.spawns.filter((c) => c.role === "scanner")).toHaveLength(1);
  });

  it("detach (console closed) leaves every child running and adoptable", async () => {
    const { m, supervisor } = await healthyStack();
    supervisor.detach("CONSOLE_CLOSED");
    expect(await supervisor.tick()).toBe("STOPPED");
    expect(m.spawns.every((c) => m.alive(c))).toBe(true);
    const { supervisor: next } = await startSupervisor(m, testConfig(), {}, 51);
    expect(m.kinds().filter((k) => k === "CHILD_ADOPTED")).toHaveLength(4);
    await run(m, next, 3);
    expect(next.status().state).toBe("RUNNING");
    expect(m.spawns).toHaveLength(4);
  });

  it("refuses to take ownership over an unreadable ownership file (it never guesses what it owns)", async () => {
    const m = new FakeMachine();
    m.files.set(m.paths.ownership, "{not json");
    const { started } = await startSupervisor(m);
    expect(started.ok).toBe(false);
    expect(m.spawns).toHaveLength(0);
  });
});

describe("dependencies, blocking and bounded behaviour", () => {
  it("a stale build BLOCKS the backend (Always-On never builds) without spending attempts; the planner waits for a healthy backend", async () => {
    const m = new FakeMachine();
    m.build = { ok: false, reasons: ["backend: 3 built file(s) are MISSING (e.g. apps/backend/dist/src/server.js)"] };
    const { supervisor } = await startSupervisor(m);
    await run(m, supervisor, 8);
    const s = supervisor.status();
    expect(s.roles.backend.state).toBe("BLOCKED");
    expect(s.roles.backend.reasonCode).toBe("BUILD_STALE");
    expect(s.roles.backend.attempts).toBe(0);
    expect(s.roles.planner).toMatchObject({ state: "BLOCKED", reasonCode: "BACKEND_NOT_HEALTHY" });
    expect(m.spawns.filter((c) => c.role === "backend" || c.role === "planner")).toHaveLength(0);
  });

  it("an unavailable data store BLOCKS emitter and planner (re)starts; they resume when it returns", async () => {
    const { m, supervisor } = await healthyStack();
    m.soakStatus = 500;
    for (const child of [...m.live("emitter"), ...m.live("planner")]) m.kill(child.root);
    await run(m, supervisor, 6);
    const s = supervisor.status();
    expect(s.dataStore).toBe("UNAVAILABLE");
    expect(s.roles.planner.reasonCode).toBe("DATA_STORE_UNAVAILABLE");
    expect(s.roles.emitter.reasonCode).toBe("DATA_STORE_UNAVAILABLE");
    expect(m.spawns).toHaveLength(4);
    m.soakStatus = 200;
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    expect(m.kinds()).toEqual(expect.arrayContaining(["DATA_STORE_UNAVAILABLE", "DATA_STORE_RESTORED"]));
    expect(m.live("emitter")).toHaveLength(1);
    expect(m.live("planner")).toHaveLength(1);
  });

  it("an UNREADABLE planner heartbeat (Redis trouble) degrades but never restarts the planner; OFF beyond its grace does", async () => {
    const { m, supervisor } = await healthyStack();
    m.plannerOver = { state: "UNREADABLE", consumers: 1, readiness: "DEGRADED" };
    await run(m, supervisor, 40); // 10 minutes
    expect(m.spawns.filter((c) => c.role === "planner")).toHaveLength(1);
    expect(supervisor.status().roles.planner).toMatchObject({ state: "DEGRADED", reasonCode: "WORKER_NOT_RUNNING" });
    m.plannerOver = { state: "OFF", consumers: 0, readiness: "DOWN" };
    await until(m, supervisor, () => m.spawns.filter((c) => c.role === "planner").length === 2, 40);
    expect(m.incidents().find((i) => i.kind === "ROLE_STOP_REQUESTED" && i.role === "planner")?.reasonCode).toBe("HEARTBEAT_MISSING_BEYOND_GRACE");
  });

  it("the emitter is never pinned to a scanner run that has not reported healthy", async () => {
    const m = new FakeMachine();
    m.scannerBehaviour = "degraded";
    const { supervisor } = await startSupervisor(m);
    await run(m, supervisor, 30);
    expect(m.spawns.filter((c) => c.role === "scanner").length).toBeGreaterThanOrEqual(1);
    expect(m.spawns.filter((c) => c.role === "emitter")).toHaveLength(0);
    expect(supervisor.status().roles.emitter.reasonCode).toMatch(/^(WAITING_FOR_SCANNER_HEALTH|SCANNER_RECOVERING|WAITING_FOR_SCANNER_RUN)$/);
  });

  it("a crashed backend is restarted on its backoff; the planner keeps running (market data is not its dependency)", async () => {
    const { m, supervisor } = await healthyStack();
    m.kill(m.live("backend")[0].root);
    await until(m, supervisor, () => supervisor.status().state === "RUNNING" && m.live("backend").length === 1);
    expect(m.spawns.filter((c) => c.role === "backend")).toHaveLength(2);
    expect(m.spawns.filter((c) => c.role === "planner")).toHaveLength(1);
    expect(supervisor.status().roles.backend).toMatchObject({ restarts: 1, attempts: 1 });
  });

  it("an emitter that stops writing status is restarted only after the hung window, pinned to the same run", async () => {
    const { m, supervisor } = await healthyStack();
    m.emitterSilent = true;
    await run(m, supervisor, 22); // 5.5 minutes: STALE (older than 5 min), not yet hung (10 min)
    expect(m.spawns.filter((c) => c.role === "emitter")).toHaveLength(1);
    expect(supervisor.status().roles.emitter.state).toBe("DEGRADED");
    m.emitterSilent = false;
    await run(m, supervisor, 1);
    expect(supervisor.status().roles.emitter.state).toBe("RUNNING");
    m.emitterSilent = true;
    await until(m, supervisor, () => m.spawns.filter((c) => c.role === "emitter").length === 2, 100);
    const emitters = m.spawns.filter((c) => c.role === "emitter");
    expect(emitters[1].pinnedRunId).toBe(emitters[0].pinnedRunId);
    expect(m.incidents().find((i) => i.kind === "ROLE_STOP_REQUESTED" && i.role === "emitter")?.reasonCode).toBe("STATUS_HUNG");
  });

  it("large backlog detected and drained are journaled once each; catching up is healthy, not a failure", async () => {
    const { m, supervisor } = await healthyStack();
    m.emitterQueue = { depth: 9_000, capacity: 10_000, max: 9_000, backlogLanes: 400 };
    await run(m, supervisor, 3);
    expect(supervisor.status().roles.emitter).toMatchObject({ state: "RUNNING", reasonCode: "CATCHING_UP" });
    m.emitterQueue = { depth: 0, capacity: 10_000, max: 9_000, backlogLanes: 0 };
    await run(m, supervisor, 3);
    expect(m.kinds().filter((k) => k === "LARGE_BACKLOG_DETECTED")).toHaveLength(1);
    expect(m.kinds().filter((k) => k === "BACKLOG_DRAINED")).toHaveLength(1);
    expect(m.spawns.filter((c) => c.role === "emitter")).toHaveLength(1);
  });

  it("an unobservable process table changes nothing (unknown is never gone)", async () => {
    const { m, supervisor } = await healthyStack();
    m.observable = false;
    await run(m, supervisor, 5);
    expect(supervisor.status()).toMatchObject({ state: "DEGRADED", reasonCode: "OBSERVATION_FAILED" });
    expect(m.spawns).toHaveLength(4);
    expect(m.kinds().filter((k) => k === "OBSERVATION_FAILED")).toHaveLength(1);
    m.observable = true;
    await run(m, supervisor, 2);
    expect(supervisor.status().state).toBe("RUNNING");
  });

  it("a clock gap (sleep / hibernate) restarts every grace period instead of acting on pre-sleep timers", async () => {
    const { m, supervisor } = await healthyStack();
    m.scannerBehaviour = "degraded";
    await run(m, supervisor, 2);
    m.now += 2 * 60 * 60_000;
    await run(m, supervisor, 2);
    expect(m.kinds()).toContain("SUPERVISOR_RESUMED_AFTER_GAP");
    expect(m.kinds()).not.toContain("SCANNER_RECOVERY_REQUESTED");
    expect(supervisor.status().roles.scanner.state).toBe("DEGRADED");
  });

  it("a busy mutation lock defers starts without spending attempts", async () => {
    const m = new FakeMachine();
    m.lockBusy = true;
    const { supervisor } = await startSupervisor(m);
    await run(m, supervisor, 6);
    expect(m.spawns).toHaveLength(0);
    expect(supervisor.status().roles.backend.attempts).toBe(0);
    expect(supervisor.status().roles.backend.reasonCode).toBe("MUTATION_AUTHORITY_BUSY");
    m.lockBusy = false;
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    expect(m.spawns).toHaveLength(4);
  });

  it("--roles excludes roles: an excluded backend is never started, and the scanner/emitter/planner run against the external one", async () => {
    const m = new FakeMachine();
    m.externalBackend = true;
    const { supervisor } = await startSupervisor(m, testConfig({ roles: ["scanner", "emitter", "planner"] }));
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    expect(supervisor.status().roles.backend.state).toBe("DISABLED");
    expect(m.spawns.map((c) => c.role).sort()).toEqual(["emitter", "planner", "scanner"]);
  });

  it("--emitter-activate-at-eof is passed only when configured", async () => {
    const m = new FakeMachine();
    const { supervisor } = await startSupervisor(m, testConfig({ emitterActivateAtEof: true }));
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    expect(m.spawns.find((c) => c.role === "emitter")!.plan.args).toContain("--activate-at-eof");
  });
});
