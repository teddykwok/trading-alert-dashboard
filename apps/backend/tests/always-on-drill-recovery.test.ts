import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ALWAYS_ON_DEFAULTS } from "../src/modules/always-on/always-on-contract";
import { drillStartRequestText, type AlwaysOnDrillFault } from "../src/modules/always-on/always-on-drill";
import { NATIVE_EXECUTION_ENABLED } from "../src/modules/native-canary/native-execution-switch";
import { SimulatedMonitoringMachine } from "./helpers/simulated-monitoring-machine";
import { M15 } from "./helpers/simulated-scanner";

/**
 * THE OPERATOR NETWORK DRILL END TO END: the real supervisor (production
 * policy) owns REAL scanner processes; the drill is requested exactly as the
 * CLI requests it, accepted by the real supervisor, written to the real
 * scanner's drill file and applied by the REAL scanner gate to that process's
 * own transports, while the supervisor's REAL probes run over the REAL drilled
 * probe transports. The simulated network itself is never cut: everything a
 * drill does happens inside the drilled processes.
 *
 * Each scenario proves the recovery contract R1/R2/R3 and the safety
 * invariants (checked every simulated second: one scanner process at most,
 * locks only its own, the emitter pinned only to a running run, monitoring
 * roles only, nothing signed, no drill past its window) against real code —
 * not real-machine networking.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let machines: SimulatedMonitoringMachine[] = [];
afterEach(async () => {
  for (const sm of machines) {
    if (!sm.supervisorStopped) await sm.shutdown();
    for (const p of sm.processes) p.scanner.stop();
    sm.net.dispose();
  }
  machines = [];
});

interface Incident {
  readonly at: string;
  readonly kind: string;
  readonly role: string | null;
  readonly reasonCode: string | null;
}

async function runningStack() {
  const root = mkdtempSync(path.join(tmpdir(), "aon-drill-root-"));
  const cacheDir = mkdtempSync(path.join(tmpdir(), "aon-drill-cache-"));
  dirs.push(root, cacheDir);
  const sm = new SimulatedMonitoringMachine(root, cacheDir);
  machines.push(sm);
  await sm.start();
  expect(await sm.runUntil(() => sm.supervisor.status().state === "RUNNING", 40 * 60_000)).toBe(true);
  // Past the first bar close: every symbol live, the scanner HEALTHY (a drill starts only from a healthy run).
  await sm.runFor(Math.floor(sm.m.now / M15) * M15 + M15 - sm.m.now + 90_000);
  expect(sm.supervisor.status().roles.scanner.health?.verdict).toBe("HEALTHY");
  return sm;
}

const incidents = (sm: SimulatedMonitoringMachine) => sm.m.incidents() as unknown as Incident[];
const since = (sm: SimulatedMonitoringMachine, fromMs: number) => incidents(sm).filter((i) => Date.parse(i.at) >= fromMs);
const kinds = (list: readonly Incident[]) => list.map((i) => `${i.kind}${i.role ? `/${i.role}` : ""}`);
const reasons = (list: readonly Incident[], kind: string) => list.filter((i) => i.kind === kind).map((i) => i.reasonCode);
const at = (list: readonly Incident[], kind: string) => Date.parse((list.find((i) => i.kind === kind) as Incident).at);
const restarts = (list: readonly Incident[]) => kinds(list).filter((k) => /^(SCANNER_RECOVERY_REQUESTED|ROLE_STOP_REQUESTED|ROLE_STARTED|BACKOFF_ENTERED|ROLE_LATCHED)/.test(k));
let nextId = 1;

/** Exactly what `monitoring:always-on drill start` does: a controller process, one request naming the generation and run. */
async function startDrill(sm: SimulatedMonitoringMachine, fault: AlwaysOnDrillFault, durationSeconds: number) {
  const controller = sm.m.addDrillController();
  const status = sm.supervisor.status();
  const requestId = (nextId++).toString(16).padStart(32, "a");
  sm.m.files.set(
    sm.m.paths.drillRequest,
    drillStartRequestText({ requestId, generation: status.generation, runId: status.roles.scanner.runId as string, fault, durationSeconds, requestedAtMs: sm.m.now, controller: { pid: controller.pid, startedAtMs: controller.startedAtMs, user: "operator" } })
  );
  expect(await sm.runUntil(() => sm.supervisor.status().drill?.drillId === requestId, 30_000)).toBe(true);
  const drill = sm.supervisor.status().drill as NonNullable<ReturnType<SimulatedMonitoringMachine["supervisor"]["status"]>["drill"]>;
  return { requestId, startedAtMs: Date.parse(drill.startedAt), expiresAtMs: Date.parse(drill.expiresAt) };
}

function expectSafety(sm: SimulatedMonitoringMachine) {
  expect(sm.violations).toEqual([]);
  expect(NATIVE_EXECUTION_ENABLED).toBe(false);
  const status = sm.supervisor.status();
  expect(status.nativeExecutionEnabled).toBe(false);
  expect(status.accountExecution).toBe("NONE");
  for (const plan of sm.spawnPlans) {
    expect(["backend", "scanner", "emitter", "planner"]).toContain(plan.role);
    expect(plan.args.join(" ")).not.toMatch(/drill/i);
  }
  expect(new Set(sm.net.requests.map((r) => r.path))).toEqual(new Set(sm.net.requests.map((r) => r.path).filter((p) => ["/fapi/v1/time", "/fapi/v1/exchangeInfo", "/fapi/v1/klines"].includes(p))));
  expect(sm.net.violations).toEqual([]);
  // The simulated network itself was never cut: every failure happened inside the drilled processes.
  expect(sm.net.events.filter((e) => e.kind === "OUTAGE_STARTED")).toEqual([]);
  // Planning is untouched by any drill.
  expect(status.roles.planner.health?.delta.jobsFailed ?? 0).toBe(0);
}

describe("R1 under a drill: a public stream outage is held by the REAL stream probe, never spent", () => {
  it("PUBLIC_STREAMS_DOWN for 15 minutes: PUBLIC_STREAM_UNREACHABLE once, nothing restarted, the same run and emitter kept; at expiry the drill ends on its own, the real streams return and the scanner heals — no recovery at all", async () => {
    const sm = await runningStack();
    const runA = sm.liveScanner();
    const fromMs = sm.m.now;
    const drill = await startDrill(sm, "PUBLIC_STREAMS_DOWN", 900);
    expect(await sm.runUntil(() => sm.m.now >= drill.expiresAtMs - 1_000, 16 * 60_000)).toBe(true);
    const atEnd = sm.supervisor.status();
    expect(await sm.runUntil(() => kinds(since(sm, drill.expiresAtMs)).includes("SUPERVISOR_RETURNED_HEALTHY"), 15 * 60_000)).toBe(true);
    await sm.runFor(2 * 60_000);
    const list = since(sm, fromMs);
    expect(reasons(list, "NETWORK_UNAVAILABLE")).toEqual(["PUBLIC_STREAM_UNREACHABLE"]);
    expect(reasons(list, "NETWORK_RESTORED")).toEqual(["PUBLIC_STREAM_REACHABLE"]);
    expect(restarts(list)).toEqual([]);
    expect(atEnd.roles.scanner).toMatchObject({ state: "DEGRADED", reasonCode: "PUBLIC_STREAM_UNREACHABLE", attempts: 0, latched: false });
    expect(atEnd.roles.emitter.state).toBe("RUNNING");
    expect(sm.processes.map((p) => p.runId)).toEqual([runA?.runId]);
    expect(reasons(list, "DRILL_ENDED")).toEqual(["EXPIRED"]);
    expect(at(list, "DRILL_ENDED") - drill.expiresAtMs).toBeLessThanOrEqual(ALWAYS_ON_DEFAULTS.pollMs);
    expect(sm.supervisor.status().drill).toMatchObject({ state: "ENDED", activation: "CONFIRMED", restore: "CONFIRMED", fileRemoved: true });
    // The supervisor's stream probe never touched the network while the drill refused it, and did afterwards.
    expect(sm.net.streamProbes.filter((p) => p.atMs >= drill.startedAtMs && p.atMs < drill.expiresAtMs)).toEqual([]);
    expect(sm.net.streamProbes.filter((p) => p.atMs >= drill.expiresAtMs).every((p) => p.outcome === "OK")).toBe(true);
    // The kept run's own gate applied the drill and ended it at expiry: its streams are the real ones again.
    expect(runA?.gate?.observation()).toMatchObject({ drillId: drill.requestId, active: false, endReason: "EXPIRED" });
    // RUNNING again; WARMING is healthy (the current bar stays quarantined after a reconnect until it closes).
    expect(["HEALTHY", "WARMING"]).toContain(sm.supervisor.status().roles.scanner.health?.verdict);
    expectSafety(sm);
  }, 300_000);
});

describe("R2 under a drill: a short public outage costs nothing", () => {
  it("PUBLIC_ALL_DOWN for 60 s (inside the 90 s grace): degraded, then healed by itself — no probe verdict, no recovery, same run, attempts 0", async () => {
    const sm = await runningStack();
    const runA = sm.liveScanner();
    const fromMs = sm.m.now;
    const drill = await startDrill(sm, "PUBLIC_ALL_DOWN", 60);
    await sm.runFor(20 * 60_000);
    const list = since(sm, fromMs);
    expect(kinds(list)).toContain("SCANNER_DEGRADED/scanner");
    expect(restarts(list)).toEqual([]);
    expect(reasons(list, "DRILL_ENDED")).toEqual(["EXPIRED"]);
    expect(at(list, "DRILL_ENDED")).toBeGreaterThanOrEqual(drill.expiresAtMs);
    expect(sm.processes.map((p) => p.runId)).toEqual([runA?.runId]);
    expect(sm.supervisor.status()).toMatchObject({ state: "RUNNING" });
    expect(sm.supervisor.status().roles.scanner.attempts).toBe(0);
    expectSafety(sm);
  }, 300_000);

  it("PUBLIC_STREAMS_DISCONNECT: one real drop of every open stream at the start, the real reconnects succeed — no recovery", async () => {
    const sm = await runningStack();
    const runA = sm.liveScanner();
    const reconnectsBefore = runA?.scanner.status().totals.reconnects ?? 0;
    const fromMs = sm.m.now;
    await startDrill(sm, "PUBLIC_STREAMS_DISCONNECT", 60);
    await sm.runFor(10 * 60_000);
    expect(runA?.scanner.status().totals.reconnects ?? 0).toBeGreaterThan(reconnectsBefore);
    expect(restarts(since(sm, fromMs))).toEqual([]);
    expect(sm.supervisor.status().state).toBe("RUNNING");
    expectSafety(sm);
  }, 300_000);
});

describe("R3 under a drill: a public REST outage, restored by the operator right after a failed refresh", () => {
  it("PUBLIC_REST_DOWN: the REST probe says unreachable (nothing restarted); `drill restore` right after a failed universe refresh; the stale universe gets the scanner's next refresh — the scanner heals by itself", async () => {
    const sm = await runningStack();
    const live = sm.liveScanner();
    const fromMs = sm.m.now;
    await startDrill(sm, "PUBLIC_REST_DOWN", 900);
    const failures = () => live?.scanner.status().universe?.refreshFailures ?? 0;
    expect(await sm.runUntil(() => kinds(since(sm, fromMs)).includes("NETWORK_UNAVAILABLE/scanner"), 14 * 60_000)).toBe(true);
    const seen = failures();
    expect(await sm.runUntil(() => failures() > seen, 6 * 60_000)).toBe(true);
    await sm.runFor(5_000);
    sm.m.files.set(sm.m.paths.drillRestoreRequest, "{}");
    expect(await sm.runUntil(() => sm.supervisor.status().drill?.state === "ENDED", 30_000)).toBe(true);
    const restoredAt = sm.m.now;
    const nextRefresh = Date.parse(live?.scanner.status().universe?.nextRefreshAt as string);
    expect(nextRefresh - restoredAt).toBeGreaterThan(ALWAYS_ON_DEFAULTS.postNetworkGraceMs);
    await sm.runFor(15 * 60_000);
    const list = since(sm, fromMs);
    expect(reasons(list, "NETWORK_UNAVAILABLE")).toEqual(["PUBLIC_BINANCE_UNREACHABLE"]);
    expect(reasons(list, "DRILL_ENDED")).toEqual(["OPERATOR_RESTORE"]);
    expect(kinds(list)).toContain("NETWORK_RESTORED/scanner");
    expect(restarts(list)).toEqual([]);
    expect(sm.processes).toHaveLength(1);
    expect(live?.scanner.status().universe?.stale).toBe(false);
    expect(sm.supervisor.status().state).toBe("RUNNING");
    expect(sm.supervisor.status().roles.scanner.attempts).toBe(0);
    expect(sm.supervisor.status().drill?.restore).toBe("CONFIRMED");
    expectSafety(sm);
  }, 300_000);
});

describe("faults the probes cannot confirm keep the normal bounded recovery — and a replacement run is never drilled", () => {
  it("SCANNER_LOCAL_STREAMS: the probes connect (it is the scanner's own fault), ONE ordered recovery — emitter stopped first, fresh run, emitter re-pinned; the drill ends with the old run and the fresh run never sees it", async () => {
    const sm = await runningStack();
    const runA = sm.liveScanner() as NonNullable<ReturnType<SimulatedMonitoringMachine["liveScanner"]>>;
    const fromMs = sm.m.now;
    const drill = await startDrill(sm, "SCANNER_LOCAL_STREAMS", 900);
    expect(await sm.runUntil(() => kinds(since(sm, fromMs)).includes("SUPERVISOR_RETURNED_HEALTHY"), 15 * 60_000)).toBe(true);
    await sm.runFor(2 * 60_000);
    const list = since(sm, fromMs);
    expect(reasons(list, "NETWORK_UNAVAILABLE")).toEqual([]);
    expect(sm.net.streamProbes.filter((p) => p.atMs >= drill.startedAtMs).every((p) => p.outcome === "OK")).toBe(true);
    const order = ["SCANNER_RECOVERY_REQUESTED/scanner", "ROLE_STOP_REQUESTED/emitter", "ROLE_STOPPED/emitter", "ROLE_STOP_REQUESTED/scanner", "ROLE_STOPPED/scanner", "ROLE_STARTED/scanner", "SCANNER_RECOVERY_SUCCEEDED/scanner", "EMITTER_STARTED_ON_RUN/emitter"];
    expect(kinds(list).filter((k) => order.includes(k))).toEqual(order);
    expect(reasons(list, "DRILL_ENDED")).toEqual(["RUN_ENDED"]);
    // The drill ends (same pass, earlier in the journal) before the fresh run is started.
    expect(list.findIndex((i) => i.kind === "DRILL_ENDED")).toBeLessThan(list.findIndex((i) => i.kind === "ROLE_STARTED"));
    const fresh = sm.liveScanner();
    expect(fresh?.runId).not.toBe(runA.runId);
    expect(fresh?.gate?.observation()).toBeNull();
    expect(sm.supervisor.status().roles.emitter.pinnedRunId).toBe(fresh?.runId);
    expect(sm.supervisor.status().roles.scanner.attempts).toBe(1);
    expect(sm.supervisor.status().drill).toMatchObject({ endReason: "RUN_ENDED", restore: "CONFIRMED" });
    expect([...sm.m.files.keys()].filter((f) => f.endsWith(".drill"))).toEqual([]);
    expectSafety(sm);
  }, 300_000);

  it("PUBLIC_STREAMS_HALF_OPEN: the drilled stream probe opens and hears nothing → UNKNOWN, which never holds a recovery — the normal recovery runs, and the fresh run is not drilled", async () => {
    const sm = await runningStack();
    const runA = sm.liveScanner();
    const fromMs = sm.m.now;
    await startDrill(sm, "PUBLIC_STREAMS_HALF_OPEN", 900);
    expect(await sm.runUntil(() => kinds(since(sm, fromMs)).includes("SCANNER_RECOVERY_REQUESTED/scanner"), 12 * 60_000)).toBe(true);
    expect(await sm.runUntil(() => kinds(since(sm, fromMs)).includes("SUPERVISOR_RETURNED_HEALTHY"), 15 * 60_000)).toBe(true);
    const list = since(sm, fromMs);
    expect(list.filter((i) => i.reasonCode === "PUBLIC_STREAM_UNREACHABLE")).toEqual([]);
    expect(reasons(list, "DRILL_ENDED")).toEqual(["RUN_ENDED"]);
    expect(sm.liveScanner()?.runId).not.toBe(runA?.runId);
    expect(sm.liveScanner()?.gate?.observation()).toBeNull();
    expectSafety(sm);
  }, 300_000);

  it("a drilled scanner that dies mid-drill (PUBLIC_ALL_DOWN): the drill ends at once, the probes are real again, and the exit is recovered normally — a drill never blocks recovery from a dead scanner", async () => {
    const sm = await runningStack();
    const runA = sm.liveScanner() as NonNullable<ReturnType<SimulatedMonitoringMachine["liveScanner"]>>;
    const fromMs = sm.m.now;
    await startDrill(sm, "PUBLIC_ALL_DOWN", 900);
    await sm.runFor(30_000);
    sm.m.kill(runA.root);
    const killedAt = sm.m.now;
    expect(await sm.runUntil(() => kinds(since(sm, fromMs)).includes("SUPERVISOR_RETURNED_HEALTHY"), 15 * 60_000)).toBe(true);
    // A scanner killed from OUTSIDE leaves its emitter pinned to the dead run until the supervisor's next pass notices
    // (at most one poll interval) — the pre-existing crash-detection window, not a drill effect. Bounded, then gone;
    // every other invariant held throughout.
    const crashWindow = sm.violations.filter((v) => v.includes(`the emitter is pinned to ${runA.runId}, whose scanner is not running`));
    expect(crashWindow.every((v) => Date.parse(v.slice(0, 24)) - killedAt <= ALWAYS_ON_DEFAULTS.pollMs + 1_000)).toBe(true);
    sm.violations.splice(0, sm.violations.length, ...sm.violations.filter((v) => !crashWindow.includes(v)));
    const list = since(sm, fromMs);
    expect(reasons(list, "DRILL_ENDED")).toEqual(["RUN_ENDED"]);
    expect(reasons(list, "SCANNER_RECOVERY_REQUESTED")).toEqual(["SCANNER_EXITED"]);
    expect(at(list, "DRILL_ENDED")).toBeLessThanOrEqual(at(list, "SCANNER_RECOVERY_REQUESTED"));
    expect(reasons(list, "NETWORK_UNAVAILABLE")).toEqual([]);
    expect(sm.liveScanner()?.gate?.observation()).toBeNull();
    expectSafety(sm);
  }, 300_000);
});

describe("the drill ends on every way out, with the stack's own guarantees intact", () => {
  it("a graceful stop mid-drill ends the drill FIRST, then stops emitter → scanner → planner → backend; every lock released, no drill file left", async () => {
    const sm = await runningStack();
    await startDrill(sm, "PUBLIC_STREAMS_DOWN", 900);
    await sm.runFor(2 * 60_000);
    expect(await sm.shutdown()).toBe(true);
    const list = incidents(sm);
    expect(reasons(list, "DRILL_ENDED")).toEqual(["SHUTDOWN"]);
    expect(list.findIndex((i) => i.kind === "DRILL_ENDED")).toBeLessThan(list.findIndex((i) => i.kind === "SUPERVISOR_STOPPING"));
    expect(sm.processes.every((p) => p.exit !== "RUNNING")).toBe(true);
    expect(sm.lockHolders()).toEqual([]);
    expect([...sm.m.files.keys()].filter((f) => f.endsWith(".drill"))).toEqual([]);
    expectSafety(sm);
  }, 300_000);

  it("PUBLIC_STREAMS_NEW_REFUSED alone is invisible to a healthy stream (open connections are untouched): nothing degrades, nothing restarts", async () => {
    const sm = await runningStack();
    const fromMs = sm.m.now;
    await startDrill(sm, "PUBLIC_STREAMS_NEW_REFUSED", 120);
    await sm.runFor(5 * 60_000);
    expect(restarts(since(sm, fromMs))).toEqual([]);
    expect(kinds(since(sm, fromMs))).not.toContain("SCANNER_DEGRADED/scanner");
    expect(reasons(since(sm, fromMs), "DRILL_ENDED")).toEqual(["EXPIRED"]);
    expectSafety(sm);
  }, 300_000);
});
