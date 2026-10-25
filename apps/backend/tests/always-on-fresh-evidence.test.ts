import { describe, expect, it } from "vitest";

import { ALWAYS_ON_DEFAULTS } from "../src/modules/always-on/always-on-contract";
import { FakeMachine, HEALTHY_UNIVERSE, OUTAGE_UNIVERSE, run, startSupervisor, until } from "./helpers/always-on-fake-machine";

/**
 * R2 — A RECOVERY RESTS ON EVIDENCE COVERING THE WHOLE GRACE. The scanner
 * writes its status every 60 s and the grace is 90 s: a degraded snapshot
 * written before the grace deadline may describe an outage that is already
 * over. A recovery is decided only on a status written at or after
 * `unhealthySince + degradedGraceMs`. A status that stops arriving is itself
 * evidence (STATUS_STALE after 180 s, STATUS_MISSING) and is never delayed.
 */

const P = ALWAYS_ON_DEFAULTS;

/** A running stack whose scanner status the test writes itself (the autopilot stays silent). */
async function handWrittenStack() {
  const m = new FakeMachine();
  const { supervisor } = await startSupervisor(m);
  await until(m, supervisor, () => supervisor.status().state === "RUNNING");
  m.scannerBehaviour = "silent";
  const scanner = () => m.live("scanner")[0];
  const write = (universe: typeof HEALTHY_UNIVERSE, writtenAt = m.now, lastMessageAgoMs = universe === HEALTHY_UNIVERSE ? 5_000 : 600_000) =>
    m.writeScannerStatus(scanner(), universe, lastMessageAgoMs, "RUNNING", writtenAt);
  write(HEALTHY_UNIVERSE);
  await run(m, supervisor, 2);
  return { m, supervisor, write, scanner };
}

const requested = (m: FakeMachine) => m.kinds().includes("SCANNER_RECOVERY_REQUESTED");

describe("a degraded snapshot from before the grace deadline never triggers a recovery", () => {
  it("one degraded status, then nothing newer for 170 s, then a healthy one: no recovery at all (the outage was over)", async () => {
    const { m, supervisor, write } = await handWrittenStack();
    write(OUTAGE_UNIVERSE);
    const degradedAt = m.now;
    // Ticks pass the grace deadline while the only evidence is the snapshot written before it.
    while (m.now - degradedAt < 170_000) await run(m, supervisor, 1, 5_000);
    expect(requested(m)).toBe(false);
    expect(m.kinds()).toContain("SCANNER_DEGRADED");
    expect(supervisor.status().roles.scanner.reasonCode).toBe("AWAITING_FRESH_STATUS");
    write(HEALTHY_UNIVERSE);
    await run(m, supervisor, 4);
    expect(requested(m)).toBe(false);
    expect(supervisor.status().state).toBe("RUNNING");
    expect(supervisor.status().roles.scanner.attempts).toBe(0);
  });

  it("persistent degradation still recovers: on the first status written after the deadline, within the grace plus one status interval", async () => {
    const { m, supervisor, write } = await handWrittenStack();
    write(OUTAGE_UNIVERSE);
    await run(m, supervisor, 1, 1_000);
    const unhealthySince = m.now - 1_000;
    let lastWrite = m.now;
    for (let i = 0; i < 60 && !requested(m); i += 1) {
      if (m.now - lastWrite >= 60_000) {
        write(OUTAGE_UNIVERSE);
        lastWrite = m.now;
      }
      await run(m, supervisor, 1, 5_000);
    }
    expect(requested(m)).toBe(true);
    const at = Date.parse((m.incidents().find((i) => i.kind === "SCANNER_RECOVERY_REQUESTED") as unknown as { at: string }).at);
    expect(at - unhealthySince).toBeGreaterThanOrEqual(P.degradedGraceMs);
    expect(at - unhealthySince).toBeLessThanOrEqual(P.degradedGraceMs + 60_000 + 5_000);
  });
});

describe("a status that stops arriving is never delayed", () => {
  it("STATUS_MISSING (the file disappears after the first status) recovers after the grace exactly as before", async () => {
    const { m, supervisor } = await handWrittenStack();
    m.files.delete(m.paths.scannerStatus);
    const goneAt = m.now;
    await until(m, supervisor, () => requested(m), 40, 5_000);
    expect(m.now - goneAt).toBeLessThanOrEqual(P.degradedGraceMs + 2 * 5_000);
    expect(m.incidents().find((i) => i.kind === "SCANNER_DEGRADED")?.reasonCode).toBe("STATUS_MISSING");
  });

  it("a degraded status that is never rewritten recovers when it turns STATUS_STALE: the wait is bounded by the status freshness window (180 s)", async () => {
    const { m, supervisor, write } = await handWrittenStack();
    write(OUTAGE_UNIVERSE);
    const writtenAt = m.now;
    await until(m, supervisor, () => requested(m), 60, 5_000);
    expect(m.now - writtenAt).toBeGreaterThanOrEqual(P.scannerStatusFreshMs);
    expect(m.now - writtenAt).toBeLessThanOrEqual(P.scannerStatusFreshMs + 2 * 5_000);
  });
});

describe("the fresh run of a recovery is judged on the same rule", () => {
  it("a fresh run's degraded snapshot from before its grace deadline does not fail it; a status after the deadline does", async () => {
    const { m, supervisor, write, scanner } = await handWrittenStack();
    write(OUTAGE_UNIVERSE);
    for (let i = 0; i < 40 && m.spawns.filter((c) => c.role === "scanner").length < 2; i += 1) {
      write(OUTAGE_UNIVERSE);
      await run(m, supervisor, 1, 15_000);
    }
    expect(m.spawns.filter((c) => c.role === "scanner")).toHaveLength(2);
    // The fresh run reports degraded once, then nothing newer while its grace deadline passes.
    await run(m, supervisor, 1, 5_000);
    write(OUTAGE_UNIVERSE);
    await run(m, supervisor, 1, 5_000);
    const firstAt = m.now;
    while (m.now - firstAt < 150_000) await run(m, supervisor, 1, 5_000);
    expect(m.kinds()).not.toContain("SCANNER_RECOVERY_FAILED");
    write(OUTAGE_UNIVERSE);
    await until(m, supervisor, () => m.kinds().includes("SCANNER_RECOVERY_FAILED"), 10, 5_000);
    expect(scanner()).toBeDefined();
  });
});
