import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ALWAYS_ON_DEFAULTS } from "../src/modules/always-on/always-on-contract";
import { judgeScannerHealth, type ScannerHealth } from "../src/modules/always-on/always-on-health";
import { SUPERVISOR_RECONNECT_DELAYS_MS } from "../src/modules/native-scanner/live-shadow-supervisor";
import { STREAM_OPEN_TIMEOUT_MS, STREAM_STALE_TIMEOUT_MS } from "../src/modules/native-scanner/live-shadow-runner";
import { makeRunId } from "../src/modules/native-scanner/supervisor-run-manifest";
import { SIMULATED_REST_TIMEOUT_MS, SimulatedPublicNetwork } from "./helpers/simulated-public-network";
import { M15, SIM_SYMBOLS, SIM_T0, SimulatedClock, SimulatedScanner, runScannerFor, simulatedMarket } from "./helpers/simulated-scanner";

/**
 * THE REAL SCANNER UNDER TRANSPORT FAULTS. A real LiveShadowSupervisor, wired
 * with the production CLI's own option values, runs over the simulated public
 * network: an outage refuses or holds its REST requests and drops, silences or
 * refuses its WebSocket streams. Every second its status is judged by the real
 * Always-On scanner health judge and checked for coherent membership. Offline:
 * no real network, no database, temp directories only.
 */

const PID = 7001;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

let live: { net: SimulatedPublicNetwork; scanner: SimulatedScanner }[] = [];
afterEach(() => {
  // Deterministic cleanup whatever the test did: the scanner stops (locks released), the network restores and closes.
  for (const { net, scanner } of live) {
    scanner.stop();
    net.dispose();
  }
  live = [];
});

interface Observation {
  readonly atMs: number;
  readonly health: ScannerHealth;
}

/** A healthy scanner over the simulated network: started, past its first bar close, every symbol live. */
async function healthyScanner() {
  const clock = SimulatedClock.at(SIM_T0);
  const net = new SimulatedPublicNetwork(clock.nowMs, simulatedMarket());
  const scanner = SimulatedScanner.launch({
    net,
    clock,
    root: tmp("netfault-root-"),
    cacheDir: tmp("netfault-cache-"),
    runId: makeRunId(clock.nowMs(), "0000f001"),
    pid: PID,
    processStartedAtMs: SIM_T0 - 1_000,
    isProcessAlive: () => true,
    processCreatedAtMs: () => SIM_T0 - 1_000,
    symbolsPerConnection: 3,
  });
  live.push({ net, scanner });
  const observations: Observation[] = [];
  const judge = () => judgeScannerHealth({ statusText: scanner.statusDocument(), nowMs: clock.nowMs(), ownedRuntimePids: [PID], policy: ALWAYS_ON_DEFAULTS });
  const invariants = () => {
    if (scanner.supervisor === null || scanner.state !== "RUNNING") return;
    const status = scanner.status();
    const health = judge();
    observations.push({ atMs: clock.nowMs(), health });
    // Membership: every selected symbol in exactly one known state, never double-counted.
    const t = status.totals;
    expect(t.selected).toBe(SIM_SYMBOLS.length);
    expect(t.liveEligible + t.quarantined + t.awaitingStream + t.recovering + t.failed + t.catchupPending).toBe(t.selected);
    expect(health.issues.map((i) => i.code)).not.toContain("MEMBERSHIP_INCONSISTENT");
    // One stream per scanner connection at most: a reconnect never leaves a second live socket behind.
    const openByUrl = new Map<string, number>();
    for (const s of net.sockets) if (s.state !== "CLOSED") openByUrl.set(s.url, (openByUrl.get(s.url) ?? 0) + 1);
    expect([...openByUrl.values()].every((n) => n === 1)).toBe(true);
    expect(openByUrl.size).toBeLessThanOrEqual(status.connections.length);
    expect(net.violations).toEqual([]);
  };
  const run = (ms: number) => runScannerFor(clock, net, scanner, ms, invariants);
  // Start-up (FAST_RECOVERY_V1), then the first bar close: the current bar's quarantine ends.
  await run(16 * 60_000);
  expect(judge().verdict).toBe("HEALTHY");
  expect(scanner.status().totals.liveEligible).toBe(SIM_SYMBOLS.length);
  return { clock, net, scanner, run, judge, observations };
}

type Rig = Awaited<ReturnType<typeof healthyScanner>>;

const issuesBetween = (rig: Rig, fromMs: number, toMs: number) => new Set(rig.observations.filter((o) => o.atMs >= fromMs && o.atMs < toMs).flatMap((o) => o.health.issues.map((i) => i.code)));
const nextBarCloseAfter = (ms: number) => Math.floor(ms / M15) * M15 + M15;
const connectionAttempts = (net: SimulatedPublicNetwork, url: string) => net.sockets.filter((s) => s.url === url).map((s) => s.createdAtMs);

describe("REST-only outage: only the REST paths are affected", () => {
  it("streams keep every symbol live while universe refreshes are refused; the universe goes stale after two intervals, and the first refresh after restore clears it", async () => {
    const rig = await healthyScanner();
    const { clock, net, scanner } = rig;
    const before = scanner.status().universe;
    const outageStart = clock.nowMs();
    const handle = net.cut({ rest: "REFUSED", maxDurationMs: 20 * 60_000, label: "REST only" });
    await rig.run(15 * 60_000);
    const during = scanner.status();
    // The transport really refused: every REST request inside the outage, and only REST.
    const restDuring = net.requests.filter((r) => r.atMs >= outageStart && r.via === "rest");
    expect(restDuring.length).toBeGreaterThan(0);
    expect(restDuring.every((r) => r.outcome === "REFUSED" && r.path === "/fapi/v1/exchangeInfo")).toBe(true);
    expect(net.sockets.some((s) => s.closeReason !== null && s.closedAtMs !== null && s.closedAtMs >= outageStart)).toBe(false);
    expect(during.totals.liveEligible).toBe(SIM_SYMBOLS.length);
    expect(during.totals.reconnects).toBe(0);
    expect(during.universe?.refreshes).toBe(before?.refreshes);
    expect(during.universe?.refreshFailures).toBeGreaterThanOrEqual(2);
    expect(during.universe?.lastResult).toBe("FAILED");
    // Staleness is two refresh intervals without a success, and it is visible to Always-On.
    expect(during.universe?.stale).toBe(true);
    expect(rig.judge().issues.map((i) => i.code)).toEqual(["UNIVERSE_STALE"]);
    handle.restore();
    await rig.run(6 * 60_000); // at most one refresh interval to the next scheduled refresh
    const after = scanner.status();
    expect(after.universe?.refreshes).toBeGreaterThan(before?.refreshes as number);
    expect(after.universe?.lastResult).toBe("OK");
    expect(after.universe?.stale).toBe(false);
    expect(rig.judge().verdict).toBe("HEALTHY");
  }, 60_000);
});

describe("WebSocket-only outage: only the streams are affected", () => {
  it("every connection drops; reconnects are refused on the bounded backoff (5/10/30/60 s); gap recovery over REST succeeds; nothing FAILS; on restore the streams reopen, the current bar is quarantined, then every symbol is live", async () => {
    const rig = await healthyScanner();
    const { clock, net, scanner } = rig;
    const outageStart = clock.nowMs();
    const urls = [...new Set(net.sockets.map((s) => s.url))];
    expect(urls).toHaveLength(2);
    const handle = net.cut({ openStreams: "DROP", newStreams: "REFUSED", maxDurationMs: 10 * 60_000, label: "streams only" });
    await rig.run(5 * 60_000);
    expect(net.sockets.filter((s) => s.closeReason === "dropped by the simulated outage")).toHaveLength(2);
    expect(net.requests.filter((r) => r.atMs >= outageStart).every((r) => r.outcome === "OK")).toBe(true);
    for (const url of urls) {
      const attempts = connectionAttempts(net, url).filter((t) => t > outageStart);
      const gaps = attempts.slice(1).map((t, i) => t - attempts[i]);
      // Backoff, never a storm: each gap is one of the scanner's reconnect delays (plus at most one 1 s tick).
      for (const gap of gaps) expect(SUPERVISOR_RECONNECT_DELAYS_MS.some((d) => gap >= d && gap <= d + 1_000)).toBe(true);
      expect(attempts.length).toBeLessThanOrEqual(8);
      expect(net.sockets.filter((s) => s.url === url && s.createdAtMs > outageStart).every((s) => s.closeReason === "refused by the simulated outage")).toBe(true);
    }
    expect(issuesBetween(rig, outageStart + 1_000, clock.nowMs())).toContain("AWAITING_STREAM");
    expect(scanner.status().totals.failed).toBe(0);
    handle.restore();
    const restoredAt = clock.nowMs();
    await rig.run(SUPERVISOR_RECONNECT_DELAYS_MS.at(-1) as number + 5_000);
    expect(scanner.status().connections.map((c) => c.lifecycle)).toEqual(["OPEN", "OPEN"]);
    expect(rig.judge().verdict).toBe("WARMING");
    await rig.run(nextBarCloseAfter(clock.nowMs()) - clock.nowMs() + 30_000);
    const healed = scanner.status();
    expect(healed.totals.liveEligible).toBe(SIM_SYMBOLS.length);
    expect(healed.universe?.refreshFailures).toBe(0);
    expect(rig.judge().verdict).toBe("HEALTHY");
    expect(clock.nowMs() - restoredAt).toBeLessThan(M15 + 2 * 60_000);
  }, 60_000);

  it("a half-open stream (SILENT) is caught by the scanner's own stale timeout, and a handshake that never answers (BLACKHOLE) by its open timeout", async () => {
    const rig = await healthyScanner();
    const { clock, net, scanner } = rig;
    const outageStart = clock.nowMs();
    const handle = net.cut({ openStreams: "SILENT", newStreams: "BLACKHOLE", maxDurationMs: 10 * 60_000, label: "half-open" });
    await rig.run(STREAM_STALE_TIMEOUT_MS + 5_000);
    // Nothing closed the sockets from outside: the scanner dropped its silent connections itself.
    const first = net.sockets.filter((s) => s.createdAtMs < outageStart);
    expect(first.every((s) => s.closeReason === "client closed")).toBe(true);
    expect(scanner.logs.filter((l) => l.includes("STREAM_STALE: no message on the connection"))).toHaveLength(2);
    await rig.run(SUPERVISOR_RECONNECT_DELAYS_MS[0] + STREAM_OPEN_TIMEOUT_MS + 5_000);
    expect(scanner.logs.some((l) => l.includes("STREAM_OPEN_TIMEOUT"))).toBe(true);
    expect(net.sockets.filter((s) => s.createdAtMs > outageStart && s.openedAtMs !== null)).toEqual([]);
    handle.restore();
    await rig.run(SUPERVISOR_RECONNECT_DELAYS_MS.at(-1) as number + 5_000);
    await rig.run(nextBarCloseAfter(clock.nowMs()) - clock.nowMs() + 30_000);
    expect(scanner.status().totals.liveEligible).toBe(SIM_SYMBOLS.length);
    expect(rig.judge().verdict).toBe("HEALTHY");
  }, 60_000);
});

describe("combined outages: short heals itself, sustained needs a fresh run", () => {
  it("a short combined outage (60 s) fails no symbol and misses no more than one refresh; the scanner heals by itself", async () => {
    const rig = await healthyScanner();
    const { clock, net, scanner } = rig;
    const outageStart = clock.nowMs();
    await net.withOutage({ rest: "REFUSED", openStreams: "DROP", newStreams: "REFUSED", maxDurationMs: 90_000, label: "short" }, async () => {
      await rig.run(60_000);
    });
    expect(net.events.map((e) => e.kind)).toEqual(["OUTAGE_STARTED", "RESTORED"]);
    await rig.run(nextBarCloseAfter(clock.nowMs()) - clock.nowMs() + 90_000);
    const s = scanner.status();
    expect(s.totals.failed).toBe(0);
    expect(s.totals.liveEligible).toBe(SIM_SYMBOLS.length);
    expect(s.universe?.refreshFailures).toBeLessThanOrEqual(1);
    expect(issuesBetween(rig, outageStart, clock.nowMs())).not.toContain("UNIVERSE_STALE");
    expect(issuesBetween(rig, outageStart, clock.nowMs())).not.toContain("SYMBOLS_FAILED");
    expect(rig.judge().verdict).toBe("HEALTHY");
  }, 60_000);

  it("a sustained combined outage across a bar close: every gap recovery is refused until each symbol exhausts its attempts and FAILS for the run — the run cannot heal itself after restore — and the REST spend stays inside the run budget", async () => {
    const rig = await healthyScanner();
    const { clock, net, scanner } = rig;
    const outageStart = clock.nowMs();
    const handle = net.cut({ rest: "REFUSED", openStreams: "DROP", newStreams: "REFUSED", maxDurationMs: 30 * 60_000, label: "sustained" });
    await rig.run(25 * 60_000);
    const during = scanner.status();
    expect(during.totals.failed).toBe(SIM_SYMBOLS.length);
    expect(during.symbols.every((s) => s.status === "FAILED" && s.failure !== null && s.failure.startsWith("RECOVERY_FAILED"))).toBe(true);
    // Each symbol tried exactly its configured number of recoveries, spaced by the retry delay — bounded, never a loop.
    for (const symbol of SIM_SYMBOLS) {
      const attempts = scanner.logs.filter((l) => l.includes(`${symbol} recovery attempt`)).length;
      expect(attempts).toBe(scanner.options.maxRecoveryAttempts - 1);
    }
    expect(during.totals.restRequests).toBeLessThan(scanner.options.maxTotalRequests / 4);
    expect(during.totals.restHalted).toBe(false);
    expect(issuesBetween(rig, outageStart, clock.nowMs())).toEqual(new Set(["SYMBOLS_RECOVERING", "AWAITING_STREAM", "MARKET_DATA_STALE", "UNIVERSE_STALE", "SYMBOLS_FAILED"]));
    handle.restore();
    await rig.run(nextBarCloseAfter(clock.nowMs()) - clock.nowMs() + 6 * 60_000);
    const after = scanner.status();
    // The network is back and the universe refreshes again, but a FAILED symbol stays failed for this run.
    expect(after.universe?.stale).toBe(false);
    expect(after.totals.failed).toBe(SIM_SYMBOLS.length);
    expect(rig.judge().verdict).toBe("DEGRADED");
    expect(rig.judge().issues.map((i) => i.code)).toContain("SYMBOLS_FAILED");
  }, 60_000);

  it("REST TIMEOUT: requests are held for their full 20 s client timeout, the governor never exceeds its in-flight bound, and the scanner heals after restore", async () => {
    const rig = await healthyScanner();
    const { clock, net, scanner } = rig;
    const outageStart = clock.nowMs();
    const handle = net.cut({ rest: "TIMEOUT", openStreams: "DROP", newStreams: "REFUSED", maxDurationMs: 30 * 60_000, label: "timeouts" });
    await rig.run(nextBarCloseAfter(clock.nowMs()) - clock.nowMs() + 2 * 60_000);
    const timedOut = net.requests.filter((r) => r.atMs >= outageStart && r.outcome === "TIMEOUT");
    expect(timedOut.length).toBeGreaterThan(0);
    expect(timedOut.every((r) => r.settledAtMs !== null && r.settledAtMs - r.atMs >= SIMULATED_REST_TIMEOUT_MS && r.settledAtMs - r.atMs <= SIMULATED_REST_TIMEOUT_MS + 1_000)).toBe(true);
    const metrics = scanner.governor?.metrics;
    expect(metrics?.maxInFlightObserved).toBeGreaterThanOrEqual(1);
    expect(metrics?.maxInFlightObserved).toBeLessThanOrEqual(scanner.options.maxInFlight);
    expect(net.heldRequests).toBeLessThanOrEqual(scanner.options.maxInFlight);
    handle.restore();
    await rig.run(SIMULATED_REST_TIMEOUT_MS + (SUPERVISOR_RECONNECT_DELAYS_MS.at(-1) as number) + 10_000);
    await rig.run(nextBarCloseAfter(clock.nowMs()) - clock.nowMs() + 30_000);
    expect(scanner.status().totals.failed).toBe(0);
    expect(scanner.status().totals.liveEligible).toBe(SIM_SYMBOLS.length);
    expect(rig.judge().verdict).toBe("HEALTHY");
  }, 60_000);

  it("after a combined outage across bar closes, each symbol's missed bars are replayed NON_ACTIONABLE and its high-water mark continues exactly at the last closed bar", async () => {
    const rig = await healthyScanner();
    const { clock, net, scanner } = rig;
    // A 60 s outage that spans the next bar close: the closing update is lost on the dropped streams.
    await rig.run(nextBarCloseAfter(clock.nowMs()) - clock.nowMs() - 30_000);
    await net.withOutage({ rest: "REFUSED", openStreams: "DROP", newStreams: "REFUSED", maxDurationMs: 90_000, label: "across a close" }, async () => {
      await rig.run(60_000);
    });
    await rig.run(nextBarCloseAfter(clock.nowMs()) - clock.nowMs() + 60_000);
    const lastClosedOpen = Math.floor(clock.nowMs() / M15) * M15 - M15;
    for (const s of scanner.status().symbols) {
      expect(s.status).toBe("ATTACHED");
      expect(Date.parse(s.hwm as string)).toBe(lastClosedOpen + M15);
      expect(s.counters.commitsReplayed).toBeGreaterThanOrEqual(1);
    }
    expect(scanner.logs.filter((l) => / REPLAYED_NON_ACTIONABLE commit /.test(l)).length).toBeGreaterThanOrEqual(SIM_SYMBOLS.length);
  }, 60_000);
});
