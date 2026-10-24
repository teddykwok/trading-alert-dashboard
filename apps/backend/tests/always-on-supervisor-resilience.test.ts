import { describe, expect, it } from "vitest";

import { ALWAYS_ON_DEFAULTS, ALWAYS_ON_REQUEST_SCHEMA } from "../src/modules/always-on/always-on-contract";
import { parseOwnership } from "../src/modules/always-on/always-on-ownership";
import { emitterCommitStatus } from "../src/modules/always-on/always-on-paths";
import { ENGINE as PROFILE_ENGINE, FakeMachine, run, startSupervisor, testConfig, until } from "./helpers/always-on-fake-machine";

/**
 * ALWAYS-ON MONITORING V1 — resilience regressions from the adversarial
 * review. Each test reproduces a failure path that was reachable before its
 * fix (a crash, a false fence, a lost child record, a wrong restart) over the
 * fake machine.
 */

async function healthyStack() {
  const m = new FakeMachine();
  const { supervisor, started } = await startSupervisor(m);
  expect(started).toEqual({ ok: true, generation: 1 });
  await until(m, supervisor, () => supervisor.status().state === "RUNNING");
  return { m, supervisor };
}

const onDisk = (m: FakeMachine) => {
  const read = parseOwnership(m.files.get(m.paths.ownership) ?? null);
  if (read.kind !== "VALID") throw new Error(`ownership.json is ${read.kind}`);
  return read.file;
};

describe("ownership.json durability (Windows refuses a replace while the file is held)", () => {
  it("a failed ownership write right after a spawn neither crashes the supervisor nor loses the child; nothing starts until the record is durable", async () => {
    const m = new FakeMachine();
    const { supervisor } = await startSupervisor(m);
    let held = true;
    m.failWrite = (file) => held && file === m.paths.ownership;

    // The backend is spawned and its record cannot be written: the tick still completes.
    expect(await supervisor.tick()).toBe("CONTINUE");
    m.now += 15_000;
    const [backend] = m.spawns;
    expect(m.spawns.map((c) => c.role)).toEqual(["backend"]);
    expect(supervisor.status().roles.backend.owned?.rootPid).toBe(backend.root);
    expect(onDisk(m).children).toEqual([]);
    expect(m.kinds().filter((k) => k === "OWNERSHIP_WRITE_FAILED")).toHaveLength(1);
    // No second child is started while the first one is recorded only in memory.
    await run(m, supervisor, 3);
    expect(m.spawns.map((c) => c.role)).toEqual(["backend"]);
    expect(supervisor.status().roles.scanner.reasonCode).toBe("OWNERSHIP_NOT_DURABLE");
    expect(m.kinds().filter((k) => k === "OWNERSHIP_WRITE_FAILED")).toHaveLength(1);

    // The file is released: the record becomes durable and supervision carries on, the backend never duplicated.
    held = false;
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    expect(m.kinds()).toContain("OWNERSHIP_WRITE_RESTORED");
    expect(m.spawns.filter((c) => c.role === "backend")).toHaveLength(1);
    expect(onDisk(m).children.map((c) => c.pid).sort()).toEqual(m.spawns.map((c) => c.root).sort());
    expect(Object.values(supervisor.status().roles).some((r) => r.state === "CONFLICT")).toBe(false);
  });

  it("a later generation adopts the child whose record was retried, instead of meeting it as an external CONFLICT", async () => {
    const m = new FakeMachine();
    const { supervisor } = await startSupervisor(m);
    let held = true;
    m.failWrite = (file) => held && file === m.paths.ownership;
    await run(m, supervisor, 2);
    held = false;
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    supervisor.detach("TEST");
    const { supervisor: next, started } = await startSupervisor(m, testConfig(), {}, 51);
    expect(started.ok).toBe(true);
    expect(m.kinds().filter((k) => k === "CHILD_ADOPTED")).toHaveLength(4);
    await run(m, next, 3);
    expect(next.status().state).toBe("RUNNING");
    expect(m.spawns).toHaveLength(4);
  });

  it("start refuses (and starts nothing) when its own ownership record cannot be written", async () => {
    const m = new FakeMachine();
    m.failWrite = (file) => file === m.paths.ownership;
    const { started } = await startSupervisor(m);
    expect(started.ok).toBe(false);
    expect(m.spawns).toHaveLength(0);
  });

  it("a cooperative stop file that cannot be written is retried; the recovery still completes and nothing crashes", async () => {
    const { m, supervisor } = await healthyStack();
    let held = true;
    m.failWrite = (file) => held && file.endsWith(".stop");
    m.kill(m.live("scanner")[0].root);
    await run(m, supervisor, 4, 2_000);
    expect(m.kinds()).toContain("SCANNER_RECOVERY_REQUESTED");
    expect(m.live("emitter")).toHaveLength(1);
    expect(m.terminated).toEqual([]);
    held = false;
    await until(m, supervisor, () => m.kinds().includes("SCANNER_RECOVERY_SUCCEEDED") && supervisor.status().state === "RUNNING");
    expect(m.live("scanner")).toHaveLength(1);
    expect(m.live("emitter")).toHaveLength(1);
  });

  it("a stop request whose file cannot be removed is still honoured (once), without crashing the supervisor", async () => {
    const { m, supervisor } = await healthyStack();
    m.failRemove = (file) => file === m.paths.stopRequest;
    m.files.set(m.paths.stopRequest, JSON.stringify({ schema: ALWAYS_ON_REQUEST_SCHEMA, kind: "STOP", generation: 1 }));
    await until(m, supervisor, () => supervisor.status().state === "STOPPED", 100, 2_000);
    expect(m.kinds().filter((k) => k === "SUPERVISOR_STOPPING")).toHaveLength(1);
    expect(m.spawns.every((c) => !m.alive(c))).toBe(true);
  });

  it("a clear-latch request is applied exactly once, and only after its file is gone (re-reading it every tick would defeat latching)", async () => {
    const { m, supervisor } = await healthyStack();
    m.scannerBehaviour = "crash";
    await run(m, supervisor, 3 * 240);
    expect(supervisor.status().state).toBe("LATCHED");
    let held = true;
    m.failRemove = (file) => held && file === m.paths.clearLatchRequest;
    m.files.set(m.paths.clearLatchRequest, JSON.stringify({ schema: ALWAYS_ON_REQUEST_SCHEMA, kind: "CLEAR_LATCH", role: "scanner", generation: 1 }));
    await run(m, supervisor, 3);
    expect(m.kinds()).not.toContain("LATCH_CLEARED");
    expect(supervisor.status().roles.scanner.latched).toBe(true);
    held = false;
    await run(m, supervisor, 3);
    expect(m.kinds().filter((k) => k === "LATCH_CLEARED")).toHaveLength(1);
    expect(m.files.has(m.paths.clearLatchRequest)).toBe(false);
  });
});

describe("the generation fence reads ownership.json strictly (unknown is never 'superseded')", () => {
  it("a transient read failure of ownership.json pauses that tick and never fences the generation", async () => {
    const { m, supervisor } = await healthyStack();
    m.failRead = (file) => file === m.paths.ownership;
    expect(await supervisor.tick()).toBe("CONTINUE");
    m.now += 15_000;
    expect(await supervisor.tick()).toBe("CONTINUE");
    m.now += 15_000;
    expect(supervisor.status()).toMatchObject({ state: "DEGRADED", reasonCode: "OWNERSHIP_UNREADABLE" });
    expect(m.kinds()).not.toContain("SUPERVISOR_FENCED");
    expect(m.kinds().filter((k) => k === "OWNERSHIP_READ_FAILED")).toHaveLength(1);
    expect(m.spawns).toHaveLength(4);
    m.failRead = null;
    await run(m, supervisor, 2);
    expect(supervisor.status().state).toBe("RUNNING");
    expect(m.kinds()).toContain("OWNERSHIP_READ_RESTORED");
  });

  it("a read failure UNDER the mutation lock defers the start without fencing and without spending an attempt", async () => {
    const { m, supervisor } = await healthyStack();
    m.kill(m.live("backend")[0].root);
    let reads = 0;
    // The tick's own fence check and the record update read fine; the re-check under the lock fails.
    m.failRead = (file) => file === m.paths.ownership && ++reads === 3;
    expect(await supervisor.tick()).toBe("CONTINUE");
    m.now += 15_000;
    expect(m.spawns.filter((c) => c.role === "backend")).toHaveLength(1);
    expect(m.kinds()).not.toContain("SUPERVISOR_FENCED");
    expect(supervisor.status().roles.backend.attempts).toBe(0);
    m.failRead = null;
    await until(m, supervisor, () => supervisor.status().state === "RUNNING" && m.live("backend").length === 1);
    expect(m.spawns.filter((c) => c.role === "backend")).toHaveLength(2);
  });

  it("start refuses when ownership.json exists but cannot be read, instead of taking generation 1 and orphaning the previous children", async () => {
    const { m, supervisor } = await healthyStack();
    supervisor.detach("TEST");
    m.failRead = (file) => file === m.paths.ownership;
    const { started } = await startSupervisor(m, testConfig(), {}, 51);
    expect(started.ok).toBe(false);
    m.failRead = null;
    expect(onDisk(m).generation).toBe(1);
    expect(onDisk(m).children).toHaveLength(4);
    expect(m.spawns.every((c) => m.alive(c))).toBe(true);
  });

  it("a newer generation on disk still fences the old supervisor at once", async () => {
    const { m, supervisor: oldGen } = await healthyStack();
    await startSupervisor(m, testConfig(), {}, 51);
    expect(await oldGen.tick()).toBe("FENCED");
    expect(m.kinds()).toContain("SUPERVISOR_FENCED");
  });
});

describe("adoption never crosses repositories (both checkouts share %LOCALAPPDATA%)", () => {
  it("a supervisor of C:\\repo never adopts — or stops — children recorded by a supervisor of C:\\repo-wt\\…, a path the command-line check alone would accept", async () => {
    const m = new FakeMachine();
    const worktree = "C:\\repo-wt\\always-on";
    const { supervisor: other } = await startSupervisor(m, testConfig({ repoRoot: worktree }));
    await until(m, other, () => other.status().state === "RUNNING");
    other.detach("TEST");
    const { supervisor: main, started } = await startSupervisor(m, testConfig(), {}, 51);
    expect(started).toEqual({ ok: true, generation: 2 });
    expect(m.kinds()).not.toContain("CHILD_ADOPTED");
    expect(m.incidents().filter((i) => i.kind === "CHILD_RECORD_DROPPED").map((i) => i.reasonCode)).toEqual(["OTHER_REPOSITORY", "OTHER_REPOSITORY", "OTHER_REPOSITORY", "OTHER_REPOSITORY"]);
    main.requestShutdown("TEST_STOP");
    await run(m, main, 10, 2_000);
    // The other checkout's children are somebody else's: reported, never stopped, never duplicated.
    expect(m.terminated).toEqual([]);
    expect(m.spawns.every((c) => m.alive(c))).toBe(true);
    expect(m.spawns).toHaveLength(4);
    expect([...m.files.keys()].filter((k) => k.endsWith(".stop"))).toEqual([]);
  });

  it("the same repository spelled differently (case, trailing separator) is still the same repository", async () => {
    const m = new FakeMachine();
    const { supervisor } = await startSupervisor(m);
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    supervisor.detach("TEST");
    await startSupervisor(m, testConfig({ repoRoot: "c:\\REPO\\" }), {}, 51);
    expect(m.kinds().filter((k) => k === "CHILD_ADOPTED")).toHaveLength(4);
  });
});

describe("restart accounting: only a role's OWN failures spend its attempts", () => {
  it("an emitter stopped for a scanner recovery did not fail: a DEGRADED-but-delivering emitter survives repeated recoveries without latching", async () => {
    const { m, supervisor } = await healthyStack();
    // One lane failed closed: DEGRADED, deliberately left running, so never forgiven by a healthy streak.
    m.emitterFailedLanes = 1;
    await run(m, supervisor, 2);
    expect(supervisor.status().roles.emitter.state).toBe("DEGRADED");
    for (let i = 1; i <= 7; i += 1) {
      m.kill(m.live("scanner")[0].root);
      await until(
        m,
        supervisor,
        () => m.kinds().filter((k) => k === "SCANNER_RECOVERY_SUCCEEDED").length === i && m.live("emitter").length === 1 && m.live("emitter")[0].pinnedRunId === m.live("scanner")[0].runId,
        200
      );
      await run(m, supervisor, 130); // 32.5 min: the SCANNER's own attempts are forgiven by its healthy streak
    }
    const s = supervisor.status();
    expect(s.roles.emitter).toMatchObject({ latched: false, attempts: 0, restarts: 7 });
    expect(m.kinds()).not.toContain("ROLE_LATCHED");
    expect(m.spawns.filter((c) => c.role === "emitter")).toHaveLength(8);
  });

  it("an emitter that crashes on its own still spends an attempt (and backs off)", async () => {
    const { m, supervisor } = await healthyStack();
    m.kill(m.live("emitter")[0].root);
    await until(m, supervisor, () => m.live("emitter").length === 1);
    expect(supervisor.status().roles.emitter).toMatchObject({ attempts: 1, restarts: 1 });
  });
});

describe("a sleep or hibernate: nothing is judged on pre-sleep timers", () => {
  it("a healthy emitter whose status is still pre-sleep when the supervisor wakes is not restarted as hung", async () => {
    const { m, supervisor } = await healthyStack();
    m.emitterSilent = true; // its next status write has not happened yet when the supervisor wakes
    m.now += 40 * 60_000;
    await run(m, supervisor, 2);
    expect(m.kinds()).toContain("SUPERVISOR_RESUMED_AFTER_GAP");
    expect(m.incidents().filter((i) => i.kind === "ROLE_STOP_REQUESTED" && i.role === "emitter")).toEqual([]);
    m.emitterSilent = false;
    await run(m, supervisor, 1);
    expect(supervisor.status().roles.emitter.state).toBe("RUNNING");
    expect(m.spawns.filter((c) => c.role === "emitter")).toHaveLength(1);
  });

  it("an emitter that stays silent after the resume is still restarted once the hung window has passed since the resume", async () => {
    const { m, supervisor } = await healthyStack();
    m.emitterSilent = true;
    m.now += 40 * 60_000;
    const resumedAt = m.now;
    await until(m, supervisor, () => m.incidents().some((i) => i.kind === "ROLE_STOP_REQUESTED" && i.role === "emitter"), 100);
    expect(m.now - resumedAt).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("a fresh run that was degraded before the sleep gets its grace period again, instead of failing on the first tick after resume", async () => {
    const { m, supervisor } = await healthyStack();
    m.scannerBehaviour = "degraded";
    await until(m, supervisor, () => m.spawns.filter((c) => c.role === "scanner").length === 2, 200, 2_000);
    await run(m, supervisor, 2, 2_000); // the fresh run reports DEGRADED (inside its grace)
    expect(m.kinds()).not.toContain("SCANNER_RECOVERY_FAILED");
    m.now += 2 * 60 * 60_000;
    await run(m, supervisor, 2, 2_000);
    expect(m.kinds()).toContain("SUPERVISOR_RESUMED_AFTER_GAP");
    expect(m.kinds()).not.toContain("SCANNER_RECOVERY_FAILED");
  });

  it("time asleep is not healthy time: attempts are forgiven only after 30 minutes of OBSERVED health", async () => {
    const { m, supervisor } = await healthyStack();
    m.kill(m.live("backend")[0].root);
    await until(m, supervisor, () => supervisor.status().roles.backend.state === "RUNNING" && m.live("backend").length === 1);
    expect(supervisor.status().roles.backend.attempts).toBe(1);
    await run(m, supervisor, 4);
    m.now += 40 * 60_000;
    await run(m, supervisor, 2);
    expect(supervisor.status().roles.backend.attempts).toBe(1);
    await run(m, supervisor, 125);
    expect(supervisor.status().roles.backend.attempts).toBe(0);
  });
});

describe("a scanner run of another engine is never left in charge", () => {
  const OLD_ENGINE = "f".repeat(64);

  it("an owned run that is not the profile's engine is replaced through the recovery path; the emitter is pinned only to the profile's engine", async () => {
    const m = new FakeMachine();
    m.scannerEngine = (index) => (index === 0 ? OLD_ENGINE : PROFILE_ENGINE);
    const { supervisor } = await startSupervisor(m);
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    expect(m.incidents().find((i) => i.kind === "SCANNER_RECOVERY_REQUESTED")?.reasonCode).toBe("ENGINE_FINGERPRINT_MISMATCH");
    const runs = m.spawns.filter((c) => c.role === "scanner");
    expect(runs).toHaveLength(2);
    const emitters = m.spawns.filter((c) => c.role === "emitter");
    expect(emitters).toHaveLength(1);
    expect(emitters[0].pinnedRunId).toBe(runs[1].runId);
  });

  it("an ADOPTED emitter pinned to a run of another engine (code changed between generations) is stopped before the run is replaced", async () => {
    const m = new FakeMachine();
    m.scannerEngine = (index) => (index === 0 ? OLD_ENGINE : PROFILE_ENGINE);
    const { supervisor: first } = await startSupervisor(m, testConfig({ engineFingerprint: OLD_ENGINE }));
    await until(m, first, () => first.status().state === "RUNNING");
    first.detach("TEST");
    const { supervisor: next } = await startSupervisor(m, testConfig(), {}, 51);
    await until(m, next, () => next.status().state === "RUNNING");
    const kinds = m.incidents().filter((i) => i.generation === 2).map((i) => `${i.kind}${i.role ? `:${i.role}` : ""}`);
    expect(kinds.indexOf("SCANNER_RECOVERY_REQUESTED:scanner")).toBeGreaterThan(-1);
    expect(kinds.indexOf("ROLE_STOPPED:emitter")).toBeGreaterThan(kinds.indexOf("SCANNER_RECOVERY_REQUESTED:scanner"));
    const emitters = m.spawns.filter((c) => c.role === "emitter");
    expect(emitters).toHaveLength(2);
    expect(m.alive(emitters[0])).toBe(false);
    expect(emitters[1].pinnedRunId).toBe(m.live("scanner")[0].runId);
  });

  it("a fresh run that is again not the profile's engine LATCHES at once (another run of the same code cannot help) — no 45-minute timeouts, no retries", async () => {
    const m = new FakeMachine();
    m.scannerEngine = () => OLD_ENGINE;
    const { supervisor } = await startSupervisor(m);
    await until(m, supervisor, () => supervisor.status().state === "LATCHED", 100);
    await run(m, supervisor, 2);
    expect(supervisor.status().roles.scanner).toMatchObject({ state: "LATCHED", latched: true, reasonCode: "ENGINE_FINGERPRINT_MISMATCH" });
    expect(m.spawns.filter((c) => c.role === "scanner")).toHaveLength(2);
    expect(m.spawns.filter((c) => c.role === "emitter")).toHaveLength(0);
    await run(m, supervisor, 240);
    expect(m.spawns.filter((c) => c.role === "scanner")).toHaveLength(2);
    expect(m.terminated).toEqual([]);
  });
});

describe("the fresh run of a recovery also gets the post-network grace", () => {
  it("connectivity returning while a fresh run is degraded gives it time to reconnect before it is replaced", async () => {
    const { m, supervisor } = await healthyStack();
    m.scannerBehaviour = "degraded";
    await until(m, supervisor, () => m.spawns.filter((c) => c.role === "scanner").length === 2, 200, 2_000);
    m.network = false;
    await run(m, supervisor, 60, 10_000); // 10 minutes: the fresh run is degraded, the network gate holds
    expect(m.kinds()).not.toContain("SCANNER_RECOVERY_FAILED");
    m.network = true;
    await run(m, supervisor, 4, 10_000); // 40 s after the network returned: inside postNetworkGraceMs
    expect(m.kinds()).not.toContain("SCANNER_RECOVERY_FAILED");
    expect(supervisor.status().roles.scanner.reasonCode).toBe("NETWORK_RESTORED_SCANNER_HEALING");
    m.scannerBehaviour = "healthy";
    await until(m, supervisor, () => m.kinds().includes("SCANNER_RECOVERY_SUCCEEDED"));
    expect(m.spawns.filter((c) => c.role === "scanner")).toHaveLength(2);
  });
});

describe("--roles: a role this generation does not supervise is never 'recovered'", () => {
  it("an ADOPTED scanner of an excluded role exiting does not start a recovery that can never advance", async () => {
    const { m, supervisor } = await healthyStack();
    supervisor.detach("TEST");
    const { supervisor: next } = await startSupervisor(m, testConfig({ roles: ["backend", "planner"] }), {}, 51);
    await run(m, next, 2);
    m.kill(m.live("scanner")[0].root);
    await run(m, next, 4);
    expect(m.kinds()).not.toContain("SCANNER_RECOVERY_REQUESTED");
    expect(next.status().state).toBe("RUNNING");
    expect(next.nextDelayMs()).toBe(ALWAYS_ON_DEFAULTS.pollMs);
    expect(m.spawns.filter((c) => c.role === "scanner")).toHaveLength(1);
  });
});

describe("an emitter re-validating a large backlog at start-up is alive, not silent", () => {
  it("a fresh INITIALIZING status keeps the emitter STARTING past the first-status deadline; it is never restarted for it", async () => {
    const m = new FakeMachine();
    m.emitterInitializingUntilMs = m.now + 25 * 60_000; // longer than emitterStartupTimeoutMs (10 min)
    const { supervisor } = await startSupervisor(m);
    await until(m, supervisor, () => m.live("emitter").length === 1);
    await run(m, supervisor, 48); // 12 minutes after its start
    expect(supervisor.status().roles.emitter).toMatchObject({ state: "STARTING", reasonCode: "INITIALIZING" });
    expect(supervisor.status().state).toBe("STARTING");
    await until(m, supervisor, () => supervisor.status().state === "RUNNING", 200);
    expect(m.spawns.filter((c) => c.role === "emitter")).toHaveLength(1);
    expect(m.incidents().filter((i) => i.kind === "ROLE_STOP_REQUESTED")).toEqual([]);
  });

  it("a truly silent emitter (no status of its own at all) is restarted once its first-status deadline has passed", async () => {
    const m = new FakeMachine();
    m.emitterSilent = true;
    const { supervisor } = await startSupervisor(m);
    await until(m, supervisor, () => m.live("emitter").length === 1);
    const startedAt = m.now;
    await until(m, supervisor, () => m.incidents().some((i) => i.kind === "ROLE_STOP_REQUESTED" && i.role === "emitter"), 100);
    expect(m.incidents().find((i) => i.kind === "ROLE_STOP_REQUESTED" && i.role === "emitter")?.reasonCode).toBe("NO_STATUS_AFTER_START");
    expect(m.now - startedAt).toBeGreaterThanOrEqual(ALWAYS_ON_DEFAULTS.emitterStartupTimeoutMs);
  });
});

describe("a role that has reported and then has no readable status is degraded evidence — not a failed start-up", () => {
  it("one unreadable scanner status, long after its start-up window, triggers no recovery", async () => {
    const { m, supervisor } = await healthyStack();
    await run(m, supervisor, 200); // 50 minutes: past the 45-minute start-up window
    m.failRead = (file) => file === m.paths.scannerStatus;
    await run(m, supervisor, 1);
    m.failRead = null;
    await run(m, supervisor, 3);
    expect(m.kinds()).not.toContain("SCANNER_RECOVERY_REQUESTED");
    expect(supervisor.status().state).toBe("RUNNING");
    expect(m.spawns.filter((c) => c.role === "scanner")).toHaveLength(1);
  });

  it("a scanner status that STAYS unreadable is degraded first and recovered only after the grace period", async () => {
    const { m, supervisor } = await healthyStack();
    await run(m, supervisor, 200);
    m.failRead = (file) => file === m.paths.scannerStatus;
    const since = m.now;
    await until(m, supervisor, () => m.kinds().includes("SCANNER_RECOVERY_REQUESTED"), 40);
    expect(m.incidents().find((i) => i.kind === "SCANNER_DEGRADED")?.reasonCode).toBe("STATUS_MISSING");
    expect(m.incidents().find((i) => i.kind === "SCANNER_RECOVERY_REQUESTED")?.reasonCode).toBe("SCANNER_DEGRADED_BEYOND_GRACE");
    expect(m.now - since).toBeGreaterThanOrEqual(ALWAYS_ON_DEFAULTS.degradedGraceMs);
  });

  it("one unreadable emitter status, long after its start, does not restart it", async () => {
    const { m, supervisor } = await healthyStack();
    await run(m, supervisor, 50); // 12.5 minutes: past the 10-minute first-status window
    const statusFile = emitterCommitStatus(m.paths, m.live("emitter")[0].pinnedRunId as string);
    m.failRead = (file) => file === statusFile;
    await run(m, supervisor, 1);
    expect(supervisor.status().roles.emitter).toMatchObject({ state: "DEGRADED", reasonCode: "STATUS_MISSING" });
    m.failRead = null;
    await run(m, supervisor, 2);
    expect(m.incidents().filter((i) => i.kind === "ROLE_STOP_REQUESTED" && i.role === "emitter")).toEqual([]);
    expect(supervisor.status().roles.emitter.state).toBe("RUNNING");
    expect(m.spawns.filter((c) => c.role === "emitter")).toHaveLength(1);
  });

  it("an emitter status that STAYS unreadable is restarted once the hung window has passed since its last own status", async () => {
    const { m, supervisor } = await healthyStack();
    await run(m, supervisor, 50);
    const statusFile = emitterCommitStatus(m.paths, m.live("emitter")[0].pinnedRunId as string);
    m.failRead = (file) => file === statusFile;
    const since = m.now;
    await until(m, supervisor, () => m.incidents().some((i) => i.kind === "ROLE_STOP_REQUESTED" && i.role === "emitter"), 100);
    expect(m.incidents().find((i) => i.kind === "ROLE_STOP_REQUESTED" && i.role === "emitter")?.reasonCode).toBe("STATUS_HUNG");
    expect(m.now - since).toBeGreaterThanOrEqual(ALWAYS_ON_DEFAULTS.emitterHungMs - 15_000);
  });
});

describe("one supervision pass never ends the supervisor", () => {
  it("an unexpected error inside a tick is journaled once and supervision continues", async () => {
    const { m, supervisor } = await healthyStack();
    // A backend death makes the next ticks consult the build verdict; that adapter throws twice.
    let broken = 2;
    const realBuild = m.build;
    Object.defineProperty(m, "build", {
      configurable: true,
      get: () => {
        if (broken > 0) {
          broken -= 1;
          throw new Error("unexpected adapter failure");
        }
        return realBuild;
      },
    });
    m.kill(m.live("backend")[0].root);
    expect(await supervisor.tick()).toBe("CONTINUE");
    m.now += 15_000;
    expect(await supervisor.tick()).toBe("CONTINUE");
    m.now += 15_000;
    expect(supervisor.status()).toMatchObject({ state: "DEGRADED", reasonCode: "SUPERVISION_ERROR" });
    expect(m.kinds().filter((k) => k === "SUPERVISOR_TICK_FAILED")).toHaveLength(1);
    await until(m, supervisor, () => supervisor.status().state === "RUNNING" && m.live("backend").length === 1);
    expect(m.spawns.filter((c) => c.role === "backend")).toHaveLength(2);
  });
});
