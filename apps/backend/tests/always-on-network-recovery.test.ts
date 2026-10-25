import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ALWAYS_ON_DEFAULTS } from "../src/modules/always-on/always-on-contract";
import { NATIVE_EXECUTION_ENABLED } from "../src/modules/native-canary/native-execution-switch";
import { DIRTY_ENV } from "./helpers/always-on-fake-machine";
import { SimulatedMonitoringMachine } from "./helpers/simulated-monitoring-machine";
import { M15, SIM_SYMBOLS } from "./helpers/simulated-scanner";

/**
 * ALWAYS-ON NETWORK RECOVERY OVER A SIMULATED PUBLIC NETWORK. The real
 * supervisor (production policy) owns REAL scanner processes and gates its
 * recovery on the REAL connectivity probe; one simulated network serves both,
 * and an outage changes what their transports do. These are automated
 * simulations: they prove the recovery contract and its safety invariants
 * against real code paths, not real-machine network recovery.
 *
 * Every scenario also asserts, every simulated second: one scanner process at
 * most, symbol locks held only by it (or left stale by an exited one), an
 * emitter only ever pinned to a running scanner's run, monitoring roles only,
 * and no signed or keyed request on the network.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let machines: SimulatedMonitoringMachine[] = [];
afterEach(async () => {
  // Deterministic cleanup whatever happened: no fault left in place, the stack stopped through the real supervisor.
  for (const sm of machines) {
    sm.net.restore();
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
  readonly detail: string | null;
}

async function runningStack() {
  const root = mkdtempSync(path.join(tmpdir(), "aon-net-root-"));
  const cacheDir = mkdtempSync(path.join(tmpdir(), "aon-net-cache-"));
  dirs.push(root, cacheDir);
  const sm = new SimulatedMonitoringMachine(root, cacheDir);
  machines.push(sm);
  await sm.start();
  expect(await sm.runUntil(() => sm.supervisor.status().state === "RUNNING", 40 * 60_000)).toBe(true);
  await sm.runFor(3 * 60_000);
  expect(sm.supervisor.status().state).toBe("RUNNING");
  return sm;
}

const incidents = (sm: SimulatedMonitoringMachine) => sm.m.incidents() as unknown as Incident[];
const since = (sm: SimulatedMonitoringMachine, fromMs: number) => incidents(sm).filter((i) => Date.parse(i.at) >= fromMs);
const kinds = (list: readonly Incident[]) => list.map((i) => `${i.kind}${i.role ? `/${i.role}` : ""}`);
const at = (list: readonly Incident[], kind: string, role?: string) => {
  const found = list.find((i) => i.kind === kind && (role === undefined || i.role === role));
  if (found === undefined) throw new Error(`no ${kind}${role ? `/${role}` : ""} incident`);
  return Date.parse(found.at);
};
const nextBarClose = (ms: number) => Math.floor(ms / M15) * M15 + M15;

/** The invariants every scenario must keep, checked on the final state (they were also checked every simulated second). */
function expectSafety(sm: SimulatedMonitoringMachine) {
  expect(sm.violations).toEqual([]);
  expect(NATIVE_EXECUTION_ENABLED).toBe(false);
  const status = sm.supervisor.status();
  expect(status.nativeExecutionEnabled).toBe(false);
  expect(status.accountExecution).toBe("NONE");
  expect(new Set(sm.spawnPlans.map((p) => p.role))).toEqual(new Set(sm.spawnPlans.map((p) => p.role).filter((r) => ["backend", "scanner", "emitter", "planner"].includes(r))));
  for (const plan of sm.spawnPlans) {
    for (const name of Object.keys(DIRTY_ENV).filter((k) => /api_key|api_secret|execution_profile/i.test(k))) {
      expect(Object.keys(plan.env).map((k) => k.toLowerCase())).not.toContain(name.toLowerCase());
    }
  }
  // Public market data only: GET-only server time, exchangeInfo and klines; nothing signed, nothing keyed.
  expect(new Set(sm.net.requests.map((r) => r.path))).toEqual(new Set(sm.net.requests.map((r) => r.path).filter((p) => ["/fapi/v1/time", "/fapi/v1/exchangeInfo", "/fapi/v1/klines"].includes(p))));
  expect(sm.net.violations).toEqual([]);
}

describe("baseline: the stack runs on the simulated network", () => {
  it("the real scanner's run is identified, the emitter is pinned to it, the universe refreshes, and the probe is never needed while healthy", async () => {
    const sm = await runningStack();
    const live = sm.liveScanner();
    expect(live).not.toBeNull();
    // The first refresh is due one interval after the universe the run started with was read.
    expect(await sm.runUntil(() => (live?.scanner.status().universe?.refreshes ?? 0) >= 1, 6 * 60_000)).toBe(true);
    // RUNNING already while WARMING (the current bar quarantined); every symbol is live from the next bar close.
    await sm.runFor(nextBarClose(sm.m.now) - sm.m.now + 90_000);
    const status = sm.supervisor.status();
    expect(status.roles.scanner.health?.verdict).toBe("HEALTHY");
    expect(status.roles.scanner.runId).toBe(live?.runId);
    expect(status.roles.emitter.pinnedRunId).toBe(live?.runId);
    expect(sm.m.live("emitter").map((e) => e.pinnedRunId)).toEqual([live?.runId]);
    expect(live?.scanner.status().universe?.refreshes).toBeGreaterThanOrEqual(1);
    expect(live?.scanner.status().totals.liveEligible).toBe(SIM_SYMBOLS.length);
    // One probe before the scanner's first start (it is started only when public Binance answers), none while healthy.
    const runningAt = (sm.ticks.find((t) => t.state === "RUNNING") as { atMs: number }).atMs;
    const probes = sm.net.requests.filter((r) => r.via === "probe");
    expect(probes.map((r) => r.outcome)).toEqual(["OK"]);
    expect(probes[0].atMs).toBeLessThanOrEqual(sm.processes[0].spawnedAtMs);
    expect(probes.filter((r) => r.atMs > runningAt)).toEqual([]);
    expect(new Set(sm.lockHolders())).toEqual(new Set([live?.runtime]));
    expectSafety(sm);
  }, 120_000);
});

describe("sustained combined outage: the documented contract, end to end", () => {
  it("degraded → NETWORK_UNAVAILABLE once (nothing restarted, no attempt spent) → NETWORK_RESTORED → heal window → ONE fenced recovery: emitter stopped before the scanner, a fresh run, the emitter re-pinned to it", async () => {
    const sm = await runningStack();
    const oldRun = sm.liveScanner();
    // A 25-minute outage that spans a bar close by far more than the scanner's recovery attempts: its symbols FAIL.
    await sm.runFor(nextBarClose(sm.m.now) - sm.m.now - 5 * 60_000);
    const cutAt = sm.m.now;
    const handle = sm.net.cut({ rest: "REFUSED", openStreams: "DROP", newStreams: "REFUSED", maxDurationMs: 30 * 60_000, label: "sustained" });
    await sm.runFor(25 * 60_000);
    const atRestore = sm.supervisor.status();
    handle.restore();
    const restoredAt = sm.m.now;
    expect(await sm.runUntil(() => kinds(since(sm, cutAt)).includes("SUPERVISOR_RETURNED_HEALTHY"), 20 * 60_000)).toBe(true);
    await sm.runFor(nextBarClose(sm.m.now) - sm.m.now + 2 * 60_000);
    const list = since(sm, cutAt);

    // During the outage: the outage is recognised once, and nothing is restarted or spent.
    expect(kinds(list).filter((k) => k === "NETWORK_UNAVAILABLE/scanner")).toHaveLength(1);
    const unavailableAt = at(list, "NETWORK_UNAVAILABLE");
    expect(unavailableAt - at(list, "SCANNER_DEGRADED")).toBeGreaterThanOrEqual(ALWAYS_ON_DEFAULTS.degradedGraceMs);
    const duringOutage = list.filter((i) => Date.parse(i.at) < restoredAt);
    expect(kinds(duringOutage).filter((k) => /^(ROLE_STARTED|ROLE_STOP_REQUESTED|ROLE_STOPPED|BACKOFF_ENTERED|SCANNER_RECOVERY_REQUESTED)/.test(k))).toEqual([]);
    expect(atRestore.roles.scanner.attempts).toBe(0);
    expect(atRestore.roles.scanner.state).toBe("DEGRADED");
    expect(atRestore.roles.scanner.reasonCode).toBe("NETWORK_UNAVAILABLE");
    for (const role of ["backend", "emitter", "planner"] as const) expect(atRestore.roles[role].state).toBe("RUNNING");
    // The probe really went through the faulted transport, and never faster than its cadence.
    const probes = sm.net.requests.filter((r) => r.via === "probe" && r.atMs >= cutAt && r.atMs < restoredAt);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((r) => r.outcome === "REFUSED" && r.path === "/fapi/v1/time")).toBe(true);
    expect(probes.slice(1).every((r, i) => r.atMs - probes[i].atMs >= ALWAYS_ON_DEFAULTS.connectivityProbeEveryMs)).toBe(true);

    // After restore: the network is recognised, the scanner gets its heal window, then exactly one ordered recovery.
    const restoredSeenAt = at(list, "NETWORK_RESTORED");
    const requestedAt = at(list, "SCANNER_RECOVERY_REQUESTED");
    expect(requestedAt - restoredSeenAt).toBeGreaterThanOrEqual(ALWAYS_ON_DEFAULTS.postNetworkGraceMs);
    expect(kinds(list.filter((i) => Date.parse(i.at) >= restoredAt))).toEqual(
      expect.arrayContaining(["NETWORK_RESTORED/scanner", "SCANNER_RECOVERY_REQUESTED/scanner", "SCANNER_RECOVERY_SUCCEEDED/scanner", "EMITTER_STARTED_ON_RUN/emitter", "SUPERVISOR_RETURNED_HEALTHY"])
    );
    const order = ["SCANNER_RECOVERY_REQUESTED/scanner", "ROLE_STOP_REQUESTED/emitter", "ROLE_STOPPED/emitter", "ROLE_STOP_REQUESTED/scanner", "ROLE_STOPPED/scanner", "ROLE_STARTED/scanner", "SCANNER_RUN_IDENTIFIED/scanner", "SCANNER_RECOVERY_SUCCEEDED/scanner", "ROLE_STARTED/emitter", "EMITTER_STARTED_ON_RUN/emitter"];
    expect(kinds(list).filter((k) => order.includes(k))).toEqual(order);
    expect(kinds(list).filter((k) => k === "SCANNER_RECOVERY_REQUESTED/scanner")).toHaveLength(1);

    // One fresh run; the old one stopped cooperatively (its locks released) before the new one started.
    expect(sm.processes).toHaveLength(2);
    const [old, fresh] = sm.processes;
    expect(old.runId).toBe(oldRun?.runId);
    expect(old.exit).toBe("STOPPED");
    expect(old.exitedAtMs as number).toBeLessThanOrEqual(fresh.spawnedAtMs);
    expect(old.scanner.status().totals.failed).toBe(SIM_SYMBOLS.length);
    expect(sm.supervisor.status().roles.emitter.pinnedRunId).toBe(fresh.runId);
    expect(sm.m.live("emitter").map((e) => e.pinnedRunId)).toEqual([fresh.runId]);
    expect(new Set(sm.lockHolders())).toEqual(new Set([fresh.runtime]));

    // The fresh run is fully healthy: market data fresh, universe refreshing, every symbol live, membership coherent.
    const s = fresh.scanner.status();
    expect(s.totals.liveEligible).toBe(SIM_SYMBOLS.length);
    expect(s.universe?.refreshes).toBeGreaterThanOrEqual(1);
    expect(s.universe?.stale).toBe(false);
    const final = sm.supervisor.status();
    expect(final.state).toBe("RUNNING");
    expect(final.roles.scanner.health?.issues).toEqual([]);
    expect(Date.parse(final.lastEndToEndHealthyAt as string)).toBeGreaterThan(restoredAt);
    expect(final.counters.restarts).toEqual({ backend: 0, scanner: 1, emitter: 1, planner: 0 });
    expect(final.counters.scannerRecoveries).toBe(1);
    expectSafety(sm);

    // The graceful stop, through the real supervisor: emitter, scanner, planner, backend; every lock released.
    const stopFrom = sm.m.now;
    expect(await sm.shutdown()).toBe(true);
    expect(kinds(since(sm, stopFrom)).filter((k) => k.startsWith("ROLE_STOPPED") || k === "SUPERVISOR_STOPPED")).toEqual(["ROLE_STOPPED/emitter", "ROLE_STOPPED/scanner", "ROLE_STOPPED/planner", "ROLE_STOPPED/backend", "SUPERVISOR_STOPPED"]);
    expect(sm.lockHolders()).toEqual([]);
    expect(sm.processes.every((p) => p.exit !== "RUNNING")).toBe(true);
  }, 240_000);

  it("a scanner that hangs on its cooperative stop is ended by the fenced terminate; its locks stay as stale locks of a dead process and the fresh run reclaims them — never two writers", async () => {
    const sm = await runningStack();
    await sm.runFor(nextBarClose(sm.m.now) - sm.m.now - 5 * 60_000);
    const cutAt = sm.m.now;
    sm.scannersIgnoreStop = true;
    sm.m.honourStops = false; // the emitter hangs as well: both reach their fenced terminate
    await sm.net.withOutage({ rest: "REFUSED", openStreams: "DROP", newStreams: "REFUSED", maxDurationMs: 30 * 60_000, label: "sustained, hung" }, async () => {
      await sm.runFor(25 * 60_000);
    });
    const hung = sm.liveScanner();
    expect(await sm.runUntil(() => sm.processes.length === 2, 15 * 60_000)).toBe(true);
    sm.m.honourStops = true;
    sm.scannersIgnoreStop = false;
    expect(await sm.runUntil(() => kinds(since(sm, cutAt)).includes("SUPERVISOR_RETURNED_HEALTHY"), 15 * 60_000)).toBe(true);
    const list = since(sm, cutAt);
    expect(kinds(list).filter((k) => k.startsWith("ROLE_FORCE_STOPPED"))).toEqual(["ROLE_FORCE_STOPPED/emitter", "ROLE_FORCE_STOPPED/scanner"]);
    expect(at(list, "ROLE_FORCE_STOPPED", "scanner") - at(list, "ROLE_STOP_REQUESTED", "scanner")).toBeGreaterThanOrEqual(180_000);
    // The emitter is gone (forced) before the scanner is even asked to stop: journal order, possibly the same instant.
    expect(kinds(list).indexOf("ROLE_FORCE_STOPPED/emitter")).toBeLessThan(kinds(list).indexOf("ROLE_STOP_REQUESTED/scanner"));
    expect(at(list, "ROLE_FORCE_STOPPED", "emitter")).toBeLessThanOrEqual(at(list, "ROLE_STOP_REQUESTED", "scanner"));
    const [old, fresh] = sm.processes;
    expect(old.runId).toBe(hung?.runId);
    expect(old.exit).toBe("KILLED");
    expect(sm.m.terminated).toEqual(expect.arrayContaining([old.root]));
    expect(old.exitedAtMs as number).toBeLessThanOrEqual(fresh.spawnedAtMs);
    // The fresh run took over every symbol: the dead holder's locks were reclaimed, none is left behind.
    expect(new Set(sm.lockHolders())).toEqual(new Set([fresh.runtime]));
    expect(fresh.scanner.status().totals.failed).toBe(0);
    expectSafety(sm);
  }, 240_000);
});

describe("outages the probe cannot see: the current policy, pinned so a change is visible", () => {
  it("R2: a 60 s blip that ends before the 90 s grace costs no recovery — the degraded snapshot from before the grace deadline is not acted on, and the next status shows the scanner healed", async () => {
    const sm = await runningStack();
    const runA = sm.liveScanner();
    const cutAt = sm.m.now;
    await sm.net.withOutage({ rest: "REFUSED", openStreams: "DROP", newStreams: "REFUSED", maxDurationMs: 90_000, label: "blip" }, async () => {
      await sm.runFor(60_000);
    });
    await sm.runFor(20 * 60_000);
    const list = since(sm, cutAt);
    expect(kinds(list)).toContain("SCANNER_DEGRADED/scanner");
    expect(kinds(list).filter((k) => /^(SCANNER_RECOVERY_REQUESTED|ROLE_STOP_REQUESTED|ROLE_STARTED)/.test(k))).toEqual([]);
    expect(sm.processes).toHaveLength(1);
    expect(sm.processes[0].runId).toBe(runA?.runId);
    expect(sm.supervisor.status().state).toBe("RUNNING");
    expect(sm.supervisor.status().roles.scanner.attempts).toBe(0);
    expectSafety(sm);
  }, 240_000);

  it("R2: a persistent scanner fault after a blip still recovers, on the first status written after the grace deadline", async () => {
    const sm = await runningStack();
    const runA = sm.liveScanner() as NonNullable<ReturnType<SimulatedMonitoringMachine["liveScanner"]>>;
    sm.scannerStreamsBroken = (runId) => runId === runA.runId;
    const cutAt = sm.m.now;
    await sm.net.withOutage({ openStreams: "DROP", maxDurationMs: 2_000, label: "one drop" }, async () => {
      await sm.runFor(1_000);
    });
    expect(await sm.runUntil(() => kinds(since(sm, cutAt)).includes("SCANNER_RECOVERY_REQUESTED/scanner"), 15 * 60_000)).toBe(true);
    const list = since(sm, cutAt);
    const delay = at(list, "SCANNER_RECOVERY_REQUESTED") - at(list, "SCANNER_DEGRADED");
    expect(delay).toBeGreaterThanOrEqual(ALWAYS_ON_DEFAULTS.degradedGraceMs);
    expect(delay).toBeLessThanOrEqual(ALWAYS_ON_DEFAULTS.degradedGraceMs + runA.scanner.options.statusEverySeconds * 1_000 + ALWAYS_ON_DEFAULTS.pollMs);
    expect(await sm.runUntil(() => kinds(since(sm, cutAt)).includes("SUPERVISOR_RETURNED_HEALTHY"), 15 * 60_000)).toBe(true);
    expectSafety(sm);
  }, 240_000);

  it("R3: a REST-only outage restored right after a failed refresh: the stale universe gets the scanner's next refresh — no recovery, the scanner heals by itself", async () => {
    const sm = await runningStack();
    const cutAt = sm.m.now;
    const handle = sm.net.cut({ rest: "REFUSED", maxDurationMs: 50 * 60_000, label: "REST only" });
    const live = sm.liveScanner();
    const failures = () => live?.scanner.status().universe?.refreshFailures ?? 0;
    // Wait for UNIVERSE_STALE to be seen and the outage recognised, then restore right after a refresh attempt has
    // FAILED (all its transient retries spent), so the next one is a whole interval away.
    expect(await sm.runUntil(() => kinds(since(sm, cutAt)).includes("NETWORK_UNAVAILABLE/scanner"), 20 * 60_000)).toBe(true);
    const seen = failures();
    expect(await sm.runUntil(() => failures() > seen, 6 * 60_000)).toBe(true);
    await sm.runFor(5_000);
    handle.restore();
    const restoredAt = sm.m.now;
    const nextRefresh = Date.parse(live?.scanner.status().universe?.nextRefreshAt as string);
    expect(nextRefresh - restoredAt).toBeGreaterThan(ALWAYS_ON_DEFAULTS.postNetworkGraceMs + ALWAYS_ON_DEFAULTS.connectivityProbeEveryMs);
    await sm.runFor(15 * 60_000);
    const list = since(sm, cutAt);
    expect(at(list, "SCANNER_DEGRADED")).toBeGreaterThanOrEqual(cutAt);
    expect(list.find((i) => i.kind === "SCANNER_DEGRADED")?.reasonCode).toBe("UNIVERSE_STALE");
    expect(kinds(list).filter((k) => /^(SCANNER_RECOVERY_REQUESTED|ROLE_STOP_REQUESTED|ROLE_STARTED)/.test(k))).toEqual([]);
    expect(kinds(list)).toContain("NETWORK_RESTORED/scanner");
    expect(sm.processes).toHaveLength(1);
    expect(live?.scanner.status().universe?.stale).toBe(false);
    expect(Date.parse(live?.scanner.status().universe?.lastSuccessAt as string)).toBeGreaterThanOrEqual(nextRefresh);
    expect(sm.supervisor.status().state).toBe("RUNNING");
    expect(sm.supervisor.status().roles.scanner.attempts).toBe(0);
    expectSafety(sm);
  }, 240_000);

  it("R3: REST answers again but exchangeInfo keeps failing: the stale universe is recovered within the cap (restoration + refresh interval + 60 s)", async () => {
    const sm = await runningStack();
    const cutAt = sm.m.now;
    const full = sm.net.cut({ rest: "REFUSED", maxDurationMs: 50 * 60_000, label: "REST only" });
    expect(await sm.runUntil(() => kinds(since(sm, cutAt)).includes("NETWORK_UNAVAILABLE/scanner"), 20 * 60_000)).toBe(true);
    // REST comes back for the probe and klines; only exchangeInfo still fails, so the universe cannot refresh.
    full.restore();
    const scoped = sm.net.cut({ rest: "REFUSED", restPaths: ["/fapi/v1/exchangeInfo"], maxDurationMs: 30 * 60_000, label: "exchangeInfo only" });
    expect(await sm.runUntil(() => kinds(since(sm, cutAt)).includes("SCANNER_RECOVERY_REQUESTED/scanner"), 15 * 60_000)).toBe(true);
    scoped.restore(); // the fresh run can read its universe
    const list = since(sm, cutAt);
    const restoredSeen = at(list, "NETWORK_RESTORED");
    const requested = at(list, "SCANNER_RECOVERY_REQUESTED");
    expect(requested - restoredSeen).toBeGreaterThanOrEqual(ALWAYS_ON_DEFAULTS.postNetworkGraceMs);
    expect(requested - restoredSeen).toBeLessThanOrEqual(ALWAYS_ON_DEFAULTS.universeRefreshHealMaxMs + ALWAYS_ON_DEFAULTS.pollMs + 60_000);
    expect(await sm.runUntil(() => kinds(since(sm, cutAt)).includes("SUPERVISOR_RETURNED_HEALTHY"), 15 * 60_000)).toBe(true);
    expect(kinds(since(sm, cutAt)).filter((k) => k === "SCANNER_RECOVERY_REQUESTED/scanner")).toHaveLength(1);
    expectSafety(sm);
  }, 240_000);
});

describe("R1: a public stream-only outage is recognised by the stream probe and never exhausts the scanner's attempts", () => {
  const streamIncidents = (list: readonly Incident[]) => list.filter((i) => i.reasonCode === "PUBLIC_STREAM_UNREACHABLE" || i.reasonCode === "PUBLIC_STREAM_REACHABLE").map((i) => `${i.kind}:${i.reasonCode}`);
  const restarts = (list: readonly Incident[]) => kinds(list).filter((k) => /^(SCANNER_RECOVERY_REQUESTED|ROLE_STOP_REQUESTED|ROLE_STARTED|BACKOFF_ENTERED|ROLE_LATCHED)/.test(k));
  /** Every probe socket closed with no listener left; probes never faster than their cadence. */
  function expectCleanProbes(sm: SimulatedMonitoringMachine) {
    const probes = sm.net.streamProbes;
    expect(probes.every((p) => p.closed && p.listeners() === 0)).toBe(true);
    expect(probes.slice(1).every((p, i) => p.atMs - probes[i].atMs >= ALWAYS_ON_DEFAULTS.connectivityProbeEveryMs)).toBe(true);
  }

  it("45 minutes without public streams (REST fine): NETWORK_UNAVAILABLE (PUBLIC_STREAM_UNREACHABLE) once, no fresh run and no attempt spent, the scanner and its emitter kept; when the streams return the scanner heals itself — no recovery at all", async () => {
    const sm = await runningStack();
    const runA = sm.liveScanner();
    const cutAt = sm.m.now;
    let atRestore = sm.supervisor.status();
    await sm.net.withOutage({ openStreams: "DROP", newStreams: "REFUSED", maxDurationMs: 50 * 60_000, label: "streams only" }, async () => {
      await sm.runFor(45 * 60_000);
      atRestore = sm.supervisor.status();
    });
    const restoredAt = sm.m.now;
    await sm.runFor(nextBarClose(sm.m.now) - sm.m.now + 10 * 60_000);
    const list = since(sm, cutAt);
    expect(streamIncidents(list)[0]).toBe("NETWORK_UNAVAILABLE:PUBLIC_STREAM_UNREACHABLE");
    expect(streamIncidents(list).filter((k) => k.startsWith("NETWORK_UNAVAILABLE"))).toHaveLength(1);
    expect(streamIncidents(list)).toContain("NETWORK_RESTORED:PUBLIC_STREAM_REACHABLE");
    expect(list.filter((i) => i.reasonCode === "PUBLIC_BINANCE_UNREACHABLE")).toEqual([]);
    expect(restarts(list)).toEqual([]);
    expect(atRestore.roles.scanner).toMatchObject({ state: "DEGRADED", reasonCode: "PUBLIC_STREAM_UNREACHABLE", attempts: 0, latched: false });
    expect(atRestore.roles.emitter.state).toBe("RUNNING");
    expect(sm.processes).toHaveLength(1);
    expect(sm.processes[0].runId).toBe(runA?.runId);
    expect(sm.processes[0].exit).toBe("RUNNING");
    const probesDuring = sm.net.streamProbes.filter((p) => p.atMs >= cutAt && p.atMs < restoredAt);
    expect(probesDuring.length).toBeGreaterThan(0);
    expect(probesDuring.every((p) => p.outcome === "REFUSED")).toBe(true);
    expect(sm.net.streamProbes.length).toBeLessThanOrEqual(Math.ceil((45 * 60_000) / ALWAYS_ON_DEFAULTS.connectivityProbeEveryMs) + 4);
    expectCleanProbes(sm);
    const final = sm.supervisor.status();
    expect(final.state).toBe("RUNNING");
    expect(final.roles.scanner.health?.verdict).toBe("HEALTHY");
    expect(final.roles.scanner.attempts).toBe(0);
    expectSafety(sm);
  }, 300_000);

  it("streams return but the kept scanner cannot reconnect: NETWORK_RESTORED, the heal window, then ONE ordered recovery to a fresh run with the emitter re-pinned to it", async () => {
    const sm = await runningStack();
    const runA = sm.liveScanner() as NonNullable<ReturnType<SimulatedMonitoringMachine["liveScanner"]>>;
    const cutAt = sm.m.now;
    await sm.net.withOutage({ openStreams: "DROP", newStreams: "REFUSED", maxDurationMs: 20 * 60_000, label: "streams only" }, async () => {
      await sm.runFor(15 * 60_000);
    });
    sm.scannerStreamsBroken = (runId) => runId === runA.runId;
    expect(await sm.runUntil(() => kinds(since(sm, cutAt)).includes("SUPERVISOR_RETURNED_HEALTHY"), 20 * 60_000)).toBe(true);
    const list = since(sm, cutAt);
    expect(kinds(list).filter((k) => k === "SCANNER_RECOVERY_REQUESTED/scanner")).toHaveLength(1);
    const restoredSeen = Date.parse((list.find((i) => i.reasonCode === "PUBLIC_STREAM_REACHABLE") as Incident).at);
    expect(at(list, "SCANNER_RECOVERY_REQUESTED") - restoredSeen).toBeGreaterThanOrEqual(ALWAYS_ON_DEFAULTS.postNetworkGraceMs);
    const order = ["SCANNER_RECOVERY_REQUESTED/scanner", "ROLE_STOP_REQUESTED/emitter", "ROLE_STOPPED/emitter", "ROLE_STOP_REQUESTED/scanner", "ROLE_STOPPED/scanner", "ROLE_STARTED/scanner", "SCANNER_RECOVERY_SUCCEEDED/scanner", "EMITTER_STARTED_ON_RUN/emitter"];
    expect(kinds(list).filter((k) => order.includes(k))).toEqual(order);
    const fresh = sm.liveScanner();
    expect(fresh?.runId).not.toBe(runA.runId);
    expect(sm.supervisor.status().roles.emitter.pinnedRunId).toBe(fresh?.runId);
    expect(sm.supervisor.status().roles.scanner.attempts).toBe(1);
    expectCleanProbes(sm);
    expectSafety(sm);
  }, 300_000);

  it("a scanner-LOCAL stream failure while public streams answer is never an outage: the probe says REACHABLE, and the bounded recovery and its latch work exactly as before", async () => {
    const sm = await runningStack();
    const cutAt = sm.m.now;
    sm.scannerStreamsBroken = () => true;
    // One instant of dropped connections; from then on every reconnect fails inside the scanner, the network is fine.
    await sm.net.withOutage({ openStreams: "DROP", maxDurationMs: 2_000, label: "one drop" }, async () => {
      await sm.runFor(1_000);
    });
    expect(await sm.runUntil(() => sm.supervisor.status().roles.scanner.latched, 60 * 60_000)).toBe(true);
    const list = since(sm, cutAt);
    expect(streamIncidents(list)).toEqual([]);
    expect(sm.net.streamProbes.length).toBeGreaterThan(0);
    expect(sm.net.streamProbes.every((p) => p.outcome === "OK")).toBe(true);
    expect(list.filter((i) => i.kind === "ROLE_STARTED" && i.role === "scanner")).toHaveLength(ALWAYS_ON_DEFAULTS.maxRecoveryAttempts);
    expect(kinds(list)).toContain("ROLE_LATCHED/scanner");
    expect(kinds(list).filter((k) => k === "EMITTER_STARTED_ON_RUN/emitter")).toEqual([]);
    expectCleanProbes(sm);
    expectSafety(sm);
  }, 300_000);

  it.each([
    ["the probe socket cannot be constructed", "THROWS" as const, { openStreams: "DROP" as const, newStreams: "REFUSED" as const }],
    ["the probe reads something it cannot interpret", "INDETERMINATE" as const, { openStreams: "DROP" as const, newStreams: "REFUSED" as const }],
    ["a half-open outage: the probe opens and hears nothing", "REAL" as const, { openStreams: "SILENT" as const }],
  ])("uncertain (%s): never treated as an outage — the existing bounded recovery runs", async (_label, mode, fault) => {
    const sm = await runningStack();
    sm.streamProbeMode = mode;
    const cutAt = sm.m.now;
    sm.net.cut({ ...fault, maxDurationMs: 30 * 60_000, label: "uncertain" });
    expect(await sm.runUntil(() => kinds(since(sm, cutAt)).includes("SCANNER_RECOVERY_REQUESTED/scanner"), 12 * 60_000)).toBe(true);
    expect(streamIncidents(since(sm, cutAt))).toEqual([]);
    expect(sm.violations).toEqual([]);
  }, 240_000);
});

describe("detection is never hidden by an outage", () => {
  it("a planner failure that appears during an outage is reported as a delta (not restarted for it), next to the network incident", async () => {
    const sm = await runningStack();
    const cutAt = sm.m.now;
    await sm.net.withOutage({ rest: "REFUSED", openStreams: "DROP", newStreams: "REFUSED", maxDurationMs: 10 * 60_000, label: "outage + planner error" }, async () => {
      await sm.runFor(3 * 60_000);
      sm.m.plans = { ...sm.m.plans, ERROR: (sm.m.plans.ERROR ?? 0) + 1 };
      await sm.runFor(3 * 60_000);
    });
    const list = since(sm, cutAt);
    expect(kinds(list)).toContain("NETWORK_UNAVAILABLE/scanner");
    expect(kinds(list)).toContain("PLANNER_FAILURE_DELTA_INCREASED/planner");
    expect(sm.supervisor.status().roles.planner.state).toBe("DEGRADED");
    expect(sm.supervisor.status().counters.restarts.planner).toBe(0);
    expectSafety(sm);
  }, 240_000);
});

describe("restoration and cleanup always happen", () => {
  it("a scenario that fails mid-outage still leaves the network restored, and the stack stops gracefully with every lock released", async () => {
    const sm = await runningStack();
    await expect(
      sm.net.withOutage({ rest: "REFUSED", openStreams: "DROP", newStreams: "REFUSED", maxDurationMs: 10 * 60_000, label: "aborted" }, async () => {
        await sm.runFor(2 * 60_000);
        throw new Error("the scenario failed mid-outage");
      })
    ).rejects.toThrow("the scenario failed mid-outage");
    expect(sm.net.outage).toBeNull();
    expect(sm.net.events.map((e) => e.kind)).toEqual(["OUTAGE_STARTED", "RESTORED"]);
    expect(await sm.shutdown()).toBe(true);
    expect(sm.supervisor.status().state).toBe("STOPPED");
    expect(sm.lockHolders()).toEqual([]);
    expect(sm.processes.every((p) => p.exit !== "RUNNING")).toBe(true);
    expect([...sm.m.nodes.values()].filter((n) => n.parentPid !== 1)).toEqual([]);
    expectSafety(sm);
  }, 240_000);
});
