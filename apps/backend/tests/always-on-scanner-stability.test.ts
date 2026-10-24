import { describe, expect, it } from "vitest";

import { ALWAYS_ON_DEFAULTS } from "../src/modules/always-on/always-on-contract";
import { SUPERVISOR_DEFAULTS } from "../src/modules/native-scanner/live-shadow-supervisor-cli-args";
import { FakeMachine, HEALTHY_UNIVERSE, run, startSupervisor, until } from "./helpers/always-on-fake-machine";

/**
 * ALWAYS-ON MONITORING V1 — real-machine stability. Replays of the first
 * runtime acceptance (2026-10-24), where a healthy, warming scanner run was
 * recovered for symbols that were merely quiet, over the fake machine with the
 * scanner's own per-symbol and per-connection status detail.
 */

/** Acceptance run 3 at 16:19:15: everything quarantined for the forming bar, one quiet symbol still awaiting its first update. */
const RUN3_WARMING = { ...HEALTHY_UNIVERSE, selected: 522, liveEligible: 0, quarantined: 521, awaitingStream: 1, exchangeCandidates: 522 };

describe("a quiet symbol awaiting its first stream update is warming, not a failure", () => {
  it("acceptance run 3 replay: the stack comes up and stays up; the scanner is never recovered for it", async () => {
    const m = new FakeMachine();
    m.scannerDetail = { silentAwaiting: false };
    m.scannerUniverse = RUN3_WARMING;
    const { supervisor } = await startSupervisor(m);
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    await run(m, supervisor, 40); // ten minutes
    expect(supervisor.status().state).toBe("RUNNING");
    expect(supervisor.status().roles.scanner).toMatchObject({ state: "RUNNING", reasonCode: "WARMING" });
    expect(m.kinds()).not.toContain("SCANNER_DEGRADED");
    expect(m.kinds()).not.toContain("SCANNER_RECOVERY_REQUESTED");
    expect(m.live("emitter")).toHaveLength(1);
  });

  it("the fresh run of a recovery in that state succeeds (no FRESH_RUN_DEGRADED) and the emitter is pinned to it", async () => {
    const m = new FakeMachine();
    m.scannerDetail = { silentAwaiting: false };
    const { supervisor } = await startSupervisor(m);
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    m.scannerUniverse = RUN3_WARMING;
    m.kill(m.live("scanner")[0].root);
    await until(m, supervisor, () => m.kinds().includes("SCANNER_RECOVERY_SUCCEEDED") && supervisor.status().state === "RUNNING");
    expect(m.kinds()).not.toContain("SCANNER_RECOVERY_FAILED");
    expect(m.live("emitter")[0].pinnedRunId).toBe(m.live("scanner")[0].runId);
  });

  it("fail-closed backstop: quiet symbols that STAY awaiting beyond the persistence bound degrade the scanner and take the usual recovery path", async () => {
    const m = new FakeMachine();
    m.scannerDetail = { silentAwaiting: false };
    m.scannerUniverse = { ...HEALTHY_UNIVERSE, liveEligible: 523, awaitingStream: 1 };
    const { supervisor } = await startSupervisor(m);
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    const since = m.now;
    await until(m, supervisor, () => m.kinds().includes("SCANNER_RECOVERY_REQUESTED"), 400);
    expect(m.incidents().find((i) => i.kind === "SCANNER_DEGRADED")?.reasonCode).toBe("AWAITING_STREAM_PERSISTENT");
    expect(m.now - since).toBeGreaterThanOrEqual(ALWAYS_ON_DEFAULTS.quarantinePersistentMs);
  });

  it("symbols awaiting their stream on a connection that delivers nothing are still a failure: degraded at once, recovered after the grace", async () => {
    const m = new FakeMachine();
    m.scannerDetail = { silentAwaiting: true };
    const { supervisor } = await startSupervisor(m);
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    m.scannerUniverse = { ...HEALTHY_UNIVERSE, liveEligible: 474, awaitingStream: 50 };
    await run(m, supervisor, 1);
    expect(m.incidents().find((i) => i.kind === "SCANNER_DEGRADED")?.reasonCode).toBe("AWAITING_STREAM");
    const since = m.now;
    await until(m, supervisor, () => m.kinds().includes("SCANNER_RECOVERY_REQUESTED"), 40);
    expect(m.now - since).toBeLessThanOrEqual(ALWAYS_ON_DEFAULTS.degradedGraceMs + 30_000);
  });

  it("contract: the warming bound outlasts the scanner's own per-symbol stale timeout, so the scanner always gets to act first", () => {
    expect(ALWAYS_ON_DEFAULTS.quarantinePersistentMs).toBeGreaterThan(SUPERVISOR_DEFAULTS.staleSymbolMs);
  });
});
