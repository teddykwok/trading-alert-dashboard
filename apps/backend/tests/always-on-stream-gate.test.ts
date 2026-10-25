import { describe, expect, it } from "vitest";

import { ALWAYS_ON_DEFAULTS } from "../src/modules/always-on/always-on-contract";
import { FakeMachine, HEALTHY_UNIVERSE, run, startSupervisor, testConfig, until } from "./helpers/always-on-fake-machine";

/**
 * R1 — THE STREAM GATE, on the fake machine. A public stream outage holds a
 * scanner recovery ONLY when both independent signals agree: the scanner's own
 * current status shows no connection delivering anything (and nothing but
 * stream-explained issues), and the supervisor's public stream probe confirms
 * the outage (UNREACHABLE). Anything else — a probe that is uncertain, fails,
 * or is stale; a connection that still delivers; any other issue — keeps the
 * existing bounded recovery, attempts and latch.
 */

const P = ALWAYS_ON_DEFAULTS;
/** Every symbol awaiting its stream; connection 0 silent for 10 minutes, connection 1 never delivered. */
const NO_STREAM = { ...HEALTHY_UNIVERSE, liveEligible: 0, awaitingStream: HEALTHY_UNIVERSE.selected };

async function runningStack(config = testConfig()) {
  const m = new FakeMachine();
  m.scannerDetail = { silentAwaiting: true };
  const { supervisor } = await startSupervisor(m, config);
  await until(m, supervisor, () => supervisor.status().state === "RUNNING");
  await run(m, supervisor, 4);
  return { m, supervisor };
}

/** The live scanner loses every stream: AWAITING_STREAM on silent connections and no fresh market data. */
function loseStreams(m: FakeMachine) {
  m.scannerUniverse = NO_STREAM;
  m.scannerLastMessageAgoMs = 600_000;
}

const kinds = (m: FakeMachine) => m.incidents().map((i) => `${i.kind}${i.role ? `/${i.role}` : ""}${i.reasonCode ? `:${i.reasonCode}` : ""}`);
const scannerStarts = (m: FakeMachine) => m.spawns.filter((c) => c.role === "scanner").length;

describe("a confirmed public stream outage holds the scanner: no restart, no attempt spent", () => {
  it("probe UNREACHABLE + no connection delivering → NETWORK_UNAVAILABLE (PUBLIC_STREAM_UNREACHABLE) once; the scanner and the emitter are kept for an hour; probes never faster than their cadence and only after the grace", async () => {
    const { m, supervisor } = await runningStack();
    m.streamOutcome = "UNREACHABLE";
    const lostAt = m.now;
    loseStreams(m);
    await run(m, supervisor, 240); // an hour
    expect(kinds(m).filter((k) => k.startsWith("NETWORK_UNAVAILABLE"))).toEqual(["NETWORK_UNAVAILABLE/scanner:PUBLIC_STREAM_UNREACHABLE"]);
    expect(kinds(m).filter((k) => /SCANNER_RECOVERY_REQUESTED|ROLE_STOP_REQUESTED|BACKOFF_ENTERED|ROLE_LATCHED/.test(k))).toEqual([]);
    const s = supervisor.status();
    expect(s.roles.scanner).toMatchObject({ state: "DEGRADED", reasonCode: "PUBLIC_STREAM_UNREACHABLE", attempts: 0, latched: false });
    expect(scannerStarts(m)).toBe(1);
    expect(m.live("emitter")).toHaveLength(1);
    expect(m.streamProbes[0] - lostAt).toBeGreaterThanOrEqual(P.degradedGraceMs);
    expect(m.streamProbes.slice(1).every((t, i) => t - m.streamProbes[i] >= P.connectivityProbeEveryMs)).toBe(true);
    expect(m.streamProbes.length).toBeLessThanOrEqual(Math.ceil(3_600_000 / P.connectivityProbeEveryMs) + 1);
  });

  it("streams return and the scanner heals: NETWORK_RESTORED, no recovery at all", async () => {
    const { m, supervisor } = await runningStack();
    m.streamOutcome = "UNREACHABLE";
    loseStreams(m);
    await run(m, supervisor, 40);
    m.streamOutcome = "REACHABLE";
    m.scannerUniverse = HEALTHY_UNIVERSE;
    m.scannerLastMessageAgoMs = 5_000;
    await run(m, supervisor, 20);
    expect(kinds(m)).toContain("NETWORK_RESTORED/scanner:PUBLIC_STREAM_REACHABLE");
    expect(kinds(m).filter((k) => k.startsWith("SCANNER_RECOVERY_REQUESTED"))).toEqual([]);
    expect(supervisor.status().state).toBe("RUNNING");
  });

  it("streams return but the scanner stays broken: NETWORK_RESTORED, the heal window, then ONE ordered recovery (emitter first)", async () => {
    const { m, supervisor } = await runningStack();
    m.streamOutcome = "UNREACHABLE";
    loseStreams(m);
    await run(m, supervisor, 40);
    m.streamOutcome = "REACHABLE";
    await until(m, supervisor, () => m.kinds().includes("SCANNER_RECOVERY_REQUESTED"), 80);
    const incidents = m.incidents();
    const restored = incidents.find((i) => i.kind === "NETWORK_RESTORED" && i.reasonCode === "PUBLIC_STREAM_REACHABLE") as unknown as { at: string };
    const requested = incidents.find((i) => i.kind === "SCANNER_RECOVERY_REQUESTED") as unknown as { at: string };
    expect(Date.parse(requested.at) - Date.parse(restored.at)).toBeGreaterThanOrEqual(P.postNetworkGraceMs);
    await until(m, supervisor, () => m.kinds().includes("ROLE_STARTED") && scannerStarts(m) === 2, 80);
    const order = m.kinds().filter((k) => ["ROLE_STOP_REQUESTED", "ROLE_STOPPED", "ROLE_STARTED"].includes(k));
    expect(order.slice(-5)).toEqual(["ROLE_STOP_REQUESTED", "ROLE_STOPPED", "ROLE_STOP_REQUESTED", "ROLE_STOPPED", "ROLE_STARTED"]);
    expect(m.incidents().filter((i) => i.kind === "ROLE_STOP_REQUESTED").map((i) => i.role).slice(-2)).toEqual(["emitter", "scanner"]);
  });
});

describe("uncertainty never suppresses recovery (fail closed)", () => {
  it.each([
    ["UNKNOWN", "UNKNOWN" as const],
    ["a probe that throws", "THROWS" as const],
    ["REACHABLE (a scanner-local failure)", "REACHABLE" as const],
  ])("probe %s: the existing recovery follows the grace, no outage is recorded", async (_label, outcome) => {
    const { m, supervisor } = await runningStack();
    m.streamOutcome = outcome;
    const lostAt = m.now;
    loseStreams(m);
    await until(m, supervisor, () => m.kinds().includes("SCANNER_RECOVERY_REQUESTED"), 40);
    expect(m.now - lostAt).toBeLessThanOrEqual(P.degradedGraceMs + 2 * P.pollMs + 60_000);
    expect(kinds(m).filter((k) => k.startsWith("NETWORK_UNAVAILABLE"))).toEqual([]);
    expect(m.streamProbes.length).toBeGreaterThanOrEqual(1);
  });

  it("a confirmed outage is never held on a stale answer: once the probe stops confirming it, recovery follows within one probe cadence", async () => {
    const { m, supervisor } = await runningStack();
    m.streamOutcome = "UNREACHABLE";
    loseStreams(m);
    await run(m, supervisor, 40);
    expect(m.kinds()).not.toContain("SCANNER_RECOVERY_REQUESTED");
    m.streamOutcome = "UNKNOWN";
    const switched = m.now;
    await until(m, supervisor, () => m.kinds().includes("SCANNER_RECOVERY_REQUESTED"), 20);
    expect(m.now - switched).toBeLessThanOrEqual(P.connectivityProbeEveryMs + P.pollMs);
  });

  it("no probe while healthy or inside the grace; none when another issue is present (failed symbols), and none while any connection still delivers", async () => {
    const { m, supervisor } = await runningStack();
    m.streamOutcome = "UNREACHABLE";
    await run(m, supervisor, 20);
    expect(m.streamProbes).toEqual([]);
    // Failed symbols next to the lost streams: not stream-explained, so the normal path runs and never probes.
    m.scannerUniverse = { ...NO_STREAM, awaitingStream: NO_STREAM.awaitingStream - 10, failed: 10 };
    m.scannerLastMessageAgoMs = 600_000;
    await until(m, supervisor, () => m.kinds().includes("SCANNER_RECOVERY_REQUESTED"), 40);
    expect(m.streamProbes).toEqual([]);
  });

  it("a connection that still delivers (only some symbols silent) is a scanner-side problem: never probed, recovered as before", async () => {
    const { m, supervisor } = await runningStack();
    m.streamOutcome = "UNREACHABLE";
    m.scannerUniverse = { ...HEALTHY_UNIVERSE, liveEligible: HEALTHY_UNIVERSE.selected - 50, awaitingStream: 50 };
    await until(m, supervisor, () => m.kinds().includes("SCANNER_RECOVERY_REQUESTED"), 40);
    expect(m.streamProbes).toEqual([]);
  });
});

describe("the gate holds at every recovery decision", () => {
  it("a scanner that exits during a confirmed outage is not restarted into it (no attempt spent); it starts when the streams return", async () => {
    const { m, supervisor } = await runningStack();
    m.streamOutcome = "UNREACHABLE";
    loseStreams(m);
    await run(m, supervisor, 20);
    expect(kinds(m)).toContain("NETWORK_UNAVAILABLE/scanner:PUBLIC_STREAM_UNREACHABLE");
    m.scannerBehaviour = "crash";
    await run(m, supervisor, 2);
    m.scannerBehaviour = "healthy";
    await run(m, supervisor, 120);
    expect(scannerStarts(m)).toBe(1);
    expect(supervisor.status().roles.scanner.attempts).toBe(0);
    expect(supervisor.status().roles.scanner.reasonCode).toBe("PUBLIC_STREAM_UNREACHABLE");
    m.streamOutcome = "REACHABLE";
    await until(m, supervisor, () => scannerStarts(m) === 2, 40);
    expect(kinds(m)).toContain("NETWORK_RESTORED/scanner:PUBLIC_STREAM_REACHABLE");
  });

  it("an answer is never reused for another run: when the scanner exits, the start decision asks the probe afresh, even inside the probe cadence", async () => {
    // No emitter role: nothing to stop first, so the start decision comes one pass after the exit — inside the cadence.
    const { m, supervisor } = await runningStack(testConfig({ roles: ["backend", "scanner", "planner"] }));
    m.streamOutcome = "UNREACHABLE";
    loseStreams(m);
    await until(m, supervisor, () => m.streamProbes.length > 0, 40);
    // Right after an answer for the running scanner's run: the scanner exits and the streams are back.
    const answeredAt = m.streamProbes[m.streamProbes.length - 1];
    m.streamOutcome = "REACHABLE";
    m.scannerBehaviour = "crash";
    await until(m, supervisor, () => scannerStarts(m) === 2, 10);
    // The run that answered is gone: its answer was not reused within the cadence — the probe was asked again.
    const askedAgain = m.streamProbes.filter((t) => t > answeredAt);
    expect(askedAgain.length).toBeGreaterThanOrEqual(1);
    expect(askedAgain[0] - answeredAt).toBeLessThan(P.connectivityProbeEveryMs);
  });

  it("a fresh run that cannot connect during a confirmed outage is kept (never failed for it), for longer than the start-up deadline", async () => {
    const { m, supervisor } = await runningStack();
    m.streamOutcome = "UNKNOWN";
    loseStreams(m);
    await until(m, supervisor, () => scannerStarts(m) === 2, 80);
    m.streamOutcome = "UNREACHABLE";
    await run(m, supervisor, Math.ceil((P.scannerStartupTimeoutMs + 15 * 60_000) / P.pollMs));
    expect(kinds(m).filter((k) => k.startsWith("SCANNER_RECOVERY_FAILED"))).toEqual([]);
    expect(scannerStarts(m)).toBe(2);
    expect(supervisor.status().roles.scanner).toMatchObject({ state: "RECOVERING", reasonCode: "PUBLIC_STREAM_UNREACHABLE", attempts: 1, latched: false });
    expect(m.live("emitter")).toEqual([]);
  });
});
