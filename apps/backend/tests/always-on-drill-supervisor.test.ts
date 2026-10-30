import path from "node:path";
import { describe, expect, it } from "vitest";

import { drillStartRequestText, type DrillStartRequest } from "../src/modules/always-on/always-on-drill";
import { renderAlwaysOnStatus } from "../src/modules/always-on/always-on-status";
import type { AlwaysOnSupervisor } from "../src/modules/always-on/always-on-supervisor";
import { PublicTransportDrillGate, drillFileOf, parsePublicTransportDrill, publicTransportDrillText } from "../src/modules/native-scanner/public-transport-drill";
import { FakeMachine, HEALTHY_UNIVERSE, REPO, run, startSupervisor, testConfig, until } from "./helpers/always-on-fake-machine";

/**
 * THE OPERATOR NETWORK DRILL, end to end in the real supervisor on the fake
 * machine: who may start one (explicit, local, current generation and run,
 * verified controller, private directories, short-lived authorization), what
 * it touches (exactly the owned scanner's per-spawn drill file and the
 * supervisor's own probes), and how it always ends (TTL, manual restore,
 * shutdown, detach, fencing, a replaced run, the next generation) — with every
 * step journaled and every restoration confirmed or reported as unconfirmed.
 */

const id = (n: number) => n.toString(16).padStart(32, "0");
let nextRequest = 1;

/** Each scanner run honours its drill file through the REAL scanner gate, and reports it in its status. */
function honourDrills(m: FakeMachine): void {
  const gates = new Map<number, PublicTransportDrillGate>();
  m.scannerDrill = (child) => {
    if (child.stopFile === null || child.runId === null) return null;
    let gate = gates.get(child.root);
    if (gate === undefined) {
      gate = new PublicTransportDrillGate({ file: drillFileOf(child.stopFile), runId: child.runId, readText: (f) => m.files.get(f) ?? null, nowMs: () => m.now, monoMs: () => m.monoNow(), log: () => undefined });
      gates.set(child.root, gate);
    }
    gate.poll();
    return gate.observation() as Record<string, unknown> | null;
  };
}

async function runningStack(m = new FakeMachine()) {
  honourDrills(m);
  const { supervisor, started } = await startSupervisor(m);
  expect(started.ok).toBe(true);
  await until(m, supervisor, () => supervisor.status().state === "RUNNING");
  return { m, supervisor };
}

function requestDrill(m: FakeMachine, supervisor: AlwaysOnSupervisor, over: Partial<DrillStartRequest> = {}, controller = m.addDrillController()): DrillStartRequest {
  const s = supervisor.status();
  const request: DrillStartRequest = {
    requestId: id(nextRequest++),
    generation: s.generation,
    runId: s.roles.scanner.runId as string,
    fault: "PUBLIC_ALL_DOWN",
    durationSeconds: 300,
    requestedAtMs: m.now,
    controller: { pid: controller.pid, startedAtMs: controller.startedAtMs, user: "operator" },
    ...over,
  };
  m.files.set(m.paths.drillRequest, drillStartRequestText(request));
  return request;
}

const scannerChild = (m: FakeMachine) => m.live("scanner")[0];
const request0 = (supervisor: AlwaysOnSupervisor) => supervisor.status().drill?.drillId as string;
const drillFileOfScanner = (m: FakeMachine) => drillFileOf(scannerChild(m).stopFile as string);
const drillFiles = (m: FakeMachine) => [...m.files.keys()].filter((f) => f.endsWith(".drill"));
const incidentsOf = (m: FakeMachine, kind: string) => m.incidents().filter((i) => i.kind === kind) as unknown as { reasonCode: string; facts: Record<string, unknown>; generation: number }[];

async function activeDrill(over: Partial<DrillStartRequest> = {}) {
  const { m, supervisor } = await runningStack();
  const request = requestDrill(m, supervisor, over);
  await run(m, supervisor, 1);
  expect(supervisor.status().drill).toMatchObject({ drillId: request.requestId, state: "ACTIVE" });
  return { m, supervisor, request };
}

// ===========================================================================
// Authorization and isolation
// ===========================================================================

describe("ordinary production supervision can never activate a drill", () => {
  it("hours of supervision, an outage and a recovery included: no drill file, every probe asked with NO drill, no ACL check, no drill in the status", async () => {
    const { m, supervisor } = await runningStack();
    m.scannerBehaviour = "network-dependent";
    m.network = false;
    await run(m, supervisor, 40);
    m.network = true;
    await run(m, supervisor, 200);
    expect(m.connectivityProbes).toBeGreaterThan(0);
    expect(m.connectivityDrills.every((d) => d === null)).toBe(true);
    expect(m.streamProbeDrills.every((d) => d === null)).toBe(true);
    expect(drillFiles(m)).toEqual([]);
    expect(m.aclChecks).toEqual([]);
    expect("drill" in supervisor.status()).toBe(false);
    expect(m.kinds().filter((k) => k.startsWith("DRILL_"))).toEqual([]);
    expect(m.mutations).not.toContain("ALWAYS_ON_DRILL_START");
  });
});

describe("a drill request is refused — journaled, consumed, and nothing is drilled — unless every check passes", () => {
  it.each([
    ["no live controller (a hand-written or leftover file)", (m: FakeMachine) => ({ controller: { pid: 999_999, startedAtMs: m.now, user: "operator" } }), "CONTROLLER_NOT_VERIFIED"],
    ["a controller that is not the drill CLI", (m: FakeMachine) => {
      const c = m.addDrillController(`node ${REPO}\\apps\\backend\\src\\modules\\always-on\\run-always-on-monitoring.ts status`);
      return { controller: { pid: c.pid, startedAtMs: c.startedAtMs, user: "operator" } };
    }, "CONTROLLER_NOT_VERIFIED"],
    ["a controller from another checkout", (m: FakeMachine) => {
      const c = m.addDrillController("node C:\\elsewhere\\node_modules\\tsx\\dist\\preflight.cjs src/modules/always-on/run-always-on-monitoring.ts drill start");
      return { controller: { pid: c.pid, startedAtMs: c.startedAtMs, user: "operator" } };
    }, "CONTROLLER_NOT_VERIFIED"],
    ["a reused controller pid (creation time differs)", (m: FakeMachine) => {
      const c = m.addDrillController();
      return { controller: { pid: c.pid, startedAtMs: c.startedAtMs - 60_000, user: "operator" } };
    }, "CONTROLLER_NOT_VERIFIED"],
    ["another generation (the fake's first is 1)", () => ({ generation: 7 }), "GENERATION_MISMATCH"],
    ["another scanner run", () => ({ runId: "20261022T000000Z-deadbeef" }), "RUN_MISMATCH"],
    ["an expired authorization", (m: FakeMachine) => ({ requestedAtMs: m.now - 61_000 }), "REQUEST_EXPIRED"],
  ])("%s → %s", async (_label, over, reasonCode) => {
    const { m, supervisor } = await runningStack();
    const request = requestDrill(m, supervisor, over(m));
    await run(m, supervisor, 1);
    expect(m.files.has(m.paths.drillRequest)).toBe(false);
    expect(drillFiles(m)).toEqual([]);
    expect(incidentsOf(m, "DRILL_REJECTED").map((i) => [i.reasonCode, i.facts.requestId])).toEqual([[reasonCode, request.requestId]]);
    expect(supervisor.status().drill ?? null).toBeNull();
    expect(m.mutations).not.toContain("ALWAYS_ON_DRILL_START");
  });

  it("directories other Windows accounts could write → DIRECTORY_NOT_PRIVATE (the real ACL is checked, never assumed)", async () => {
    const { m, supervisor } = await runningStack();
    m.privateDirectories = { private: false, reason: "S-1-5-32-545 may write C:\\local\\...\\requests" };
    requestDrill(m, supervisor);
    await run(m, supervisor, 1);
    expect(m.aclChecks).toEqual([[m.paths.dir, m.paths.requestsDir, m.paths.stopDir]]);
    expect(incidentsOf(m, "DRILL_REJECTED").map((i) => i.reasonCode)).toEqual(["DIRECTORY_NOT_PRIVATE"]);
    expect(drillFiles(m)).toEqual([]);
  });

  it("an ACL check that throws is NOT private (uncertain → refused)", async () => {
    const fresh = new FakeMachine();
    honourDrills(fresh);
    const started = await startSupervisor(fresh, testConfig(), {
      verifyPrivateDirectories: () => {
        throw new Error("Get-Acl failed");
      },
    });
    await until(fresh, started.supervisor, () => started.supervisor.status().state === "RUNNING");
    requestDrill(fresh, started.supervisor);
    await run(fresh, started.supervisor, 1);
    expect(incidentsOf(fresh, "DRILL_REJECTED").map((i) => i.reasonCode)).toEqual(["DIRECTORY_NOT_PRIVATE"]);
    expect(drillFiles(fresh)).toEqual([]);
  });

  it("the same request id twice → REQUEST_REPLAYED (an authorization is used once)", async () => {
    const { m, supervisor, request } = await activeDrill({ durationSeconds: 30 });
    await run(m, supervisor, 4);
    expect(supervisor.status().drill?.state).toBe("ENDED");
    requestDrill(m, supervisor, { requestId: request.requestId });
    await run(m, supervisor, 1);
    expect(incidentsOf(m, "DRILL_REJECTED").map((i) => i.reasonCode)).toEqual(["REQUEST_REPLAYED"]);
  });

  it("while a drill is active → DRILL_ALREADY_ACTIVE (one bounded drill at a time); the active one is untouched", async () => {
    const { m, supervisor, request } = await activeDrill();
    requestDrill(m, supervisor, { fault: "PUBLIC_REST_DOWN" });
    await run(m, supervisor, 1);
    expect(incidentsOf(m, "DRILL_REJECTED").map((i) => i.reasonCode)).toEqual(["DRILL_ALREADY_ACTIVE"]);
    expect(supervisor.status().drill).toMatchObject({ drillId: request.requestId, fault: "PUBLIC_ALL_DOWN", state: "ACTIVE" });
  });

  it("while a scanner recovery runs → RECOVERY_IN_PROGRESS; while stopping → SHUTTING_DOWN", async () => {
    const { m, supervisor } = await runningStack();
    const runId = supervisor.status().roles.scanner.runId as string; // a recovery forgets the run it replaces
    m.honourStops = false; // the old scanner takes its time to stop: the recovery stays in progress
    m.kill(m.live("emitter")[0].root);
    m.scannerBehaviour = "degraded";
    await until(m, supervisor, () => supervisor.status().state === "RECOVERING");
    requestDrill(m, supervisor, { runId });
    await run(m, supervisor, 1, 2_000);
    expect(incidentsOf(m, "DRILL_REJECTED").map((i) => i.reasonCode)).toContain("RECOVERY_IN_PROGRESS");

    const other = await runningStack();
    other.supervisor.requestShutdown("OPERATOR_STOP_REQUEST");
    other.m.honourStops = false;
    requestDrill(other.m, other.supervisor);
    await run(other.m, other.supervisor, 1, 2_000);
    expect(incidentsOf(other.m, "DRILL_REJECTED").map((i) => i.reasonCode)).toEqual(["SHUTTING_DOWN"]);
    expect(drillFiles(other.m)).toEqual([]);
  });

  it("a supervisor that owns no scanner (scanner excluded by --roles) → NO_OWNED_SCANNER", async () => {
    const m = new FakeMachine();
    const { supervisor } = await startSupervisor(m, testConfig({ roles: ["backend", "planner"] }));
    await run(m, supervisor, 3);
    const c = m.addDrillController();
    m.files.set(
      m.paths.drillRequest,
      drillStartRequestText({ requestId: id(900), generation: supervisor.currentGeneration, runId: "20261023T000000Z-10000000", fault: "PUBLIC_REST_DOWN", durationSeconds: 60, requestedAtMs: m.now, controller: { pid: c.pid, startedAtMs: c.startedAtMs, user: "operator" } })
    );
    await run(m, supervisor, 1);
    expect(incidentsOf(m, "DRILL_REJECTED").map((i) => i.reasonCode)).toEqual(["NO_OWNED_SCANNER"]);
  });

  it("the launcher's mutation lock is busy → MUTATION_AUTHORITY_BUSY: nothing is written without the generation fence re-checked under the lock", async () => {
    const { m, supervisor } = await runningStack();
    requestDrill(m, supervisor);
    m.lockBusy = true;
    await run(m, supervisor, 1);
    m.lockBusy = false;
    expect(incidentsOf(m, "DRILL_REJECTED").map((i) => i.reasonCode)).toEqual(["MUTATION_AUTHORITY_BUSY"]);
    expect(drillFiles(m)).toEqual([]);
  });

  it("a drill file the supervisor did not write (planted beside the scanner's stop file, bypassing the request) is removed within one pass and journaled — it can never last", async () => {
    const { m, supervisor } = await runningStack();
    const child = scannerChild(m);
    const planted = drillFileOf(child.stopFile as string);
    m.files.set(
      planted,
      publicTransportDrillText({ drillId: id(777), fault: "PUBLIC_ALL_DOWN", runId: child.runId as string, generation: supervisor.currentGeneration, startedAtMs: m.now, expiresAtMs: m.now + 900_000, faults: { rest: "REFUSED", openStreams: "DROP", newStreams: "REFUSED" } })
    );
    await run(m, supervisor, 1);
    expect(m.files.has(planted)).toBe(false);
    expect(incidentsOf(m, "DRILL_UNAUTHORIZED_FILE_REMOVED").map((i) => i.facts.file)).toEqual([path.basename(planted)]);
    expect(supervisor.status().drill ?? null).toBeNull();
    // The probes never saw it: only an accepted drill reaches them.
    expect(m.connectivityDrills.every((d) => d === null)).toBe(true);
    await run(m, supervisor, 2);
    expect(supervisor.status().roles.scanner.health?.drill).toMatchObject({ drillId: id(777), active: false });
  });

  it("the supervisor's OWN drill file (active, or ended but not yet removable) is never treated as unauthorized", async () => {
    const { m, supervisor } = await activeDrill();
    await run(m, supervisor, 3);
    m.failRemove = (f) => f.endsWith(".drill");
    m.files.set(m.paths.drillRestoreRequest, "{}");
    await run(m, supervisor, 3);
    expect(incidentsOf(m, "DRILL_UNAUTHORIZED_FILE_REMOVED")).toEqual([]);
    m.failRemove = null;
  });

  it("a malformed request is refused with its parse reason (never partly applied)", async () => {
    const { m, supervisor } = await runningStack();
    m.files.set(m.paths.drillRequest, '{"schema":"teddy.native-monitoring.always-on-request.v1","kind":"DRILL_START","url":"https://x"}');
    await run(m, supervisor, 1);
    expect(incidentsOf(m, "DRILL_REJECTED").map((i) => i.reasonCode)).toEqual(["FIELD_INVALID"]);
    expect(drillFiles(m)).toEqual([]);
  });
});

// ===========================================================================
// Activation
// ===========================================================================

describe("an accepted drill touches exactly the owned scanner's per-spawn drill file and the supervisor's probes", () => {
  it("writes the drill beside the scanner's own stop file, bound to its run, for exactly the requested window, under the mutation lock", async () => {
    const { m, supervisor, request } = await activeDrill({ fault: "PUBLIC_STREAMS_DOWN", durationSeconds: 120 });
    const file = drillFileOfScanner(m);
    expect(drillFiles(m)).toEqual([file]);
    const parsed = parsePublicTransportDrill(m.files.get(file) as string, scannerChild(m).runId as string);
    expect(parsed.kind).toBe("VALID");
    const d = parsed.kind === "VALID" ? parsed.drill : null;
    expect(d).toMatchObject({ drillId: request.requestId, fault: "PUBLIC_STREAMS_DOWN", generation: supervisor.currentGeneration, faults: { rest: null, openStreams: "DROP", newStreams: "REFUSED" } });
    expect((d?.expiresAtMs ?? 0) - (d?.startedAtMs ?? 0)).toBe(120_000);
    expect(m.mutations.filter((a) => a === "ALWAYS_ON_DRILL_START")).toEqual(["ALWAYS_ON_DRILL_START"]);
    const started = incidentsOf(m, "DRILL_STARTED");
    expect(started).toHaveLength(1);
    expect(started[0].facts).toMatchObject({ requestId: request.requestId, fault: "PUBLIC_STREAMS_DOWN", runId: request.runId, generation: supervisor.currentGeneration, controllerPid: request.controller.pid, controllerUser: "operator" });
    expect(started[0].facts.expiresAt).toBe(new Date((d?.expiresAtMs ?? 0)).toISOString());
  });

  it("no other role ever gets a drill file, and no spawn plan carries a drill argument", async () => {
    const { m } = await activeDrill();
    expect(drillFiles(m)).toEqual([drillFileOfScanner(m)]);
    for (const child of m.spawns) expect(child.plan.args.join(" ")).not.toMatch(/drill/i);
  });

  it("the scanner confirms the activation in its own status (DRILL_ACTIVATION_CONFIRMED)", async () => {
    const { m, supervisor } = await activeDrill();
    await run(m, supervisor, 2);
    expect(supervisor.status().drill?.activation).toBe("CONFIRMED");
    expect(incidentsOf(m, "DRILL_ACTIVATION_CONFIRMED")).toHaveLength(1);
  });

  it("a scanner that never reports the drill: DRILL_ACTIVATION_UNCONFIRMED after the status freshness window — never claimed", async () => {
    const { m, supervisor } = await runningStack();
    m.scannerDrill = () => null;
    requestDrill(m, supervisor);
    await run(m, supervisor, 1);
    await run(m, supervisor, 14);
    expect(supervisor.status().drill?.activation).toBe("UNCONFIRMED");
    expect(incidentsOf(m, "DRILL_ACTIVATION_UNCONFIRMED")).toHaveLength(1);
    // Its silence proves no restore either: it has never shown that it reports drills at all.
    m.files.set(m.paths.drillRestoreRequest, "{}");
    await run(m, supervisor, 15);
    expect(supervisor.status().drill).toMatchObject({ state: "ENDED", restore: "UNCONFIRMED" });
    expect(incidentsOf(m, "DRILL_RESTORE_CONFIRMED")).toEqual([]);
  });

  it("the supervisor's REST and stream probes are handed the drill's probe faults while it is active, and NO drill afterwards", async () => {
    const { m, supervisor } = await activeDrill({ fault: "PUBLIC_ALL_DOWN", durationSeconds: 300 });
    m.scannerBehaviour = "degraded"; // the scanner reacts to the outage
    await run(m, supervisor, 12);
    expect(m.connectivityDrills).toContainEqual({ rest: "REFUSED", stream: "REFUSED" });
    expect(supervisor.status().roles.scanner.reasonCode).toBe("NETWORK_UNAVAILABLE");
    expect(supervisor.status().counters.scannerRecoveries).toBe(0);
    m.scannerBehaviour = "healthy";
    await run(m, supervisor, 10);
    expect(supervisor.status().drill?.state).toBe("ENDED");
    const after = m.connectivityDrills.length;
    m.scannerBehaviour = "degraded";
    await run(m, supervisor, 10);
    expect(m.connectivityDrills.length).toBeGreaterThan(after);
    expect(m.connectivityDrills.slice(after).every((d) => d === null)).toBe(true);
  });

  it("the status shows the drill (fault, run, start, restoration deadline) and the renderer prints it", async () => {
    const { m, supervisor, request } = await activeDrill();
    const view = supervisor.status().drill;
    expect(view).toMatchObject({ drillId: request.requestId, fault: "PUBLIC_ALL_DOWN", runId: request.runId, state: "ACTIVE", controller: { pid: request.controller.pid, user: "operator" } });
    const lines = renderAlwaysOnStatus(supervisor.status(), m.now);
    expect(lines.some((l) => l.includes("DRILL") && l.includes("PUBLIC_ALL_DOWN") && l.includes(view?.expiresAt as string))).toBe(true);
  });
});

// ===========================================================================
// Restoration
// ===========================================================================

describe("every drill ends — automatically, on request, and on every way out", () => {
  it("TTL: at its expiry the file is removed, DRILL_ENDED (EXPIRED) is journaled, and the scanner's own report confirms the restore", async () => {
    const { m, supervisor } = await activeDrill({ durationSeconds: 60 });
    const file = drillFileOfScanner(m);
    await run(m, supervisor, 4); // 60 s
    await run(m, supervisor, 1);
    expect(m.files.has(file)).toBe(false);
    expect(incidentsOf(m, "DRILL_ENDED").map((i) => i.reasonCode)).toEqual(["EXPIRED"]);
    await run(m, supervisor, 2);
    expect(supervisor.status().drill).toMatchObject({ state: "ENDED", endReason: "EXPIRED", fileRemoved: true, restore: "CONFIRMED" });
    expect(incidentsOf(m, "DRILL_RESTORE_CONFIRMED")).toHaveLength(1);
  });

  it("manual restore ends it at once and is idempotent: a second restore (or one with nothing active) changes nothing", async () => {
    const { m, supervisor } = await activeDrill();
    m.files.set(m.paths.drillRestoreRequest, "{}");
    await run(m, supervisor, 1);
    expect(drillFiles(m)).toEqual([]);
    expect(incidentsOf(m, "DRILL_ENDED").map((i) => i.reasonCode)).toEqual(["OPERATOR_RESTORE"]);
    m.files.set(m.paths.drillRestoreRequest, "not even json");
    await run(m, supervisor, 1);
    expect(m.files.has(m.paths.drillRestoreRequest)).toBe(false);
    expect(incidentsOf(m, "DRILL_ENDED")).toHaveLength(1);
    expect(incidentsOf(m, "DRILL_RESTORE_REQUESTED").map((i) => i.reasonCode)).toEqual(["ENDED_ACTIVE_DRILL", "NO_ACTIVE_DRILL"]);
  });

  it("a drill file that cannot be removed: REMOVAL_FAILED is reported and retried every pass — never a claimed restore", async () => {
    const { m, supervisor } = await activeDrill();
    m.failRemove = (f) => f.endsWith(".drill");
    m.files.set(m.paths.drillRestoreRequest, "{}");
    await run(m, supervisor, 3);
    expect(supervisor.status().drill).toMatchObject({ state: "ENDED", endReason: "OPERATOR_RESTORE", fileRemoved: false, restore: "REMOVAL_FAILED" });
    expect(incidentsOf(m, "DRILL_RESTORE_CONFIRMED")).toHaveLength(0);
    m.failRemove = null;
    await run(m, supervisor, 3);
    expect(drillFiles(m)).toEqual([]);
    expect(supervisor.status().drill).toMatchObject({ fileRemoved: true, restore: "CONFIRMED" });
  });

  it("the scanner ended the drill on its own (its file briefly unreadable: fail-safe): the supervisor ends it too (SCANNER_ENDED) — its probes never stay drilled after the scanner's transports are real again", async () => {
    const { m, supervisor, request } = await activeDrill({ fault: "PUBLIC_ALL_DOWN", durationSeconds: 600 });
    await run(m, supervisor, 1);
    expect(supervisor.status().drill?.activation).toBe("CONFIRMED");
    m.scannerDrill = () => ({ drillId: request.requestId, fault: "PUBLIC_ALL_DOWN", active: false, activatedAt: null, endedAt: new Date(m.now).toISOString(), endReason: "FILE_INVALID" });
    await run(m, supervisor, 2);
    expect(incidentsOf(m, "DRILL_ENDED").map((i) => i.reasonCode)).toEqual(["SCANNER_ENDED"]);
    expect(supervisor.status().drill).toMatchObject({ state: "ENDED", restore: "CONFIRMED" });
    expect(drillFiles(m)).toEqual([]);
    m.scannerBehaviour = "degraded";
    const before = m.connectivityDrills.length;
    await run(m, supervisor, 10);
    expect(m.connectivityDrills.length).toBeGreaterThan(before);
    expect(m.connectivityDrills.slice(before).every((d) => d === null)).toBe(true);
  });

  it("the scanner applies ANOTHER drill (its file overwritten): ours ends and its file goes; another drill's report never proves ours restored — confirmed only once nothing is applied", async () => {
    const { m, supervisor } = await activeDrill({ durationSeconds: 600 });
    await run(m, supervisor, 1);
    expect(supervisor.status().drill?.activation).toBe("CONFIRMED");
    const report = (active: boolean) => () => ({ drillId: id(888), fault: "PUBLIC_ALL_DOWN", active, activatedAt: null, endedAt: null, endReason: null });
    m.scannerDrill = report(true);
    await run(m, supervisor, 1);
    expect(incidentsOf(m, "DRILL_ENDED").map((i) => i.reasonCode)).toEqual(["SCANNER_ENDED"]);
    expect(drillFiles(m)).toEqual([]);
    expect(supervisor.status().drill?.restore).toBe("PENDING");
    await run(m, supervisor, 14);
    expect(supervisor.status().drill?.restore).toBe("UNCONFIRMED");
    expect(incidentsOf(m, "DRILL_RESTORE_CONFIRMED")).toEqual([]);
    m.scannerDrill = report(false);
    await run(m, supervisor, 1);
    expect(supervisor.status().drill?.restore).toBe("CONFIRMED");
  });

  it("a stale report never ends a drill: an older drill's report on an adopted scanner, a status written before the drill started, another run's status", async () => {
    // An older drill's report: the scanner was adopted by a new generation, and still reports the drill it last applied.
    const first = await activeDrill();
    await run(first.m, first.supervisor, 1);
    const next = await startSupervisor(first.m);
    await run(first.m, next.supervisor, 2);
    expect(next.supervisor.status().roles.scanner.health?.drill).toMatchObject({ drillId: first.request.requestId, active: false });
    const newer = requestDrill(first.m, next.supervisor);
    first.m.scannerDrill = () => ({ drillId: first.request.requestId, fault: "PUBLIC_ALL_DOWN", active: false, activatedAt: null, endedAt: null, endReason: "FILE_REMOVED" });
    await run(first.m, next.supervisor, 3);
    expect(next.supervisor.status().drill).toMatchObject({ drillId: newer.requestId, state: "ACTIVE" });
    expect(incidentsOf(first.m, "DRILL_ENDED")).toEqual([]);

    // The drill's own id, on evidence that cannot be about it: written before it started, or by another run.
    const { m, supervisor, request } = await activeDrill();
    const child = scannerChild(m);
    m.scannerBehaviour = "silent";
    m.scannerDrill = () => ({ drillId: request.requestId, fault: "PUBLIC_ALL_DOWN", active: false, activatedAt: null, endedAt: null, endReason: "EXPIRED" });
    const startedAtMs = Date.parse(supervisor.status().drill?.startedAt as string);
    m.writeScannerStatus(child, HEALTHY_UNIVERSE, 5_000, "RUNNING", startedAtMs - 1_000);
    await run(m, supervisor, 1);
    expect(incidentsOf(m, "DRILL_ENDED")).toEqual([]);
    m.writeScannerStatus(child, HEALTHY_UNIVERSE, 5_000);
    m.files.set(m.paths.scannerStatus, JSON.stringify({ ...(JSON.parse(m.files.get(m.paths.scannerStatus) as string) as object), runId: "20261022T000000Z-deadbeef" }));
    await run(m, supervisor, 1);
    expect(incidentsOf(m, "DRILL_ENDED")).toEqual([]);
    expect(supervisor.status().drill?.state).toBe("ACTIVE");
  });

  it("a scanner that keeps reporting the drill active after its end: DRILL_RESTORE_UNCONFIRMED — the supervisor never claims success", async () => {
    const { m, supervisor, request } = await activeDrill();
    m.scannerDrill = () => ({ drillId: request.requestId, fault: "PUBLIC_ALL_DOWN", active: true, activatedAt: null, endedAt: null, endReason: null });
    m.files.set(m.paths.drillRestoreRequest, "{}");
    await run(m, supervisor, 15);
    expect(supervisor.status().drill?.restore).toBe("UNCONFIRMED");
    expect(incidentsOf(m, "DRILL_RESTORE_UNCONFIRMED")).toHaveLength(1);
    expect(incidentsOf(m, "DRILL_RESTORE_CONFIRMED")).toHaveLength(0);
  });

  it("shutdown ends the drill FIRST (before the emitter is asked to stop) and removes its file", async () => {
    const { m, supervisor } = await activeDrill();
    supervisor.requestShutdown("OPERATOR_STOP_REQUEST");
    await run(m, supervisor, 20, 2_000);
    const kinds = m.kinds();
    expect(incidentsOf(m, "DRILL_ENDED").map((i) => i.reasonCode)).toEqual(["SHUTDOWN"]);
    expect(kinds.indexOf("DRILL_ENDED")).toBeLessThan(kinds.indexOf("ROLE_STOP_REQUESTED"));
    expect(drillFiles(m)).toEqual([]);
  });

  it("detach (console closed) ends the drill: the children keep running, the fault does not", async () => {
    const { m, supervisor } = await activeDrill();
    supervisor.detach("CONSOLE_CLOSED");
    expect(drillFiles(m)).toEqual([]);
    expect(incidentsOf(m, "DRILL_ENDED").map((i) => i.reasonCode)).toEqual(["DETACHED"]);
    expect(m.live("scanner")).toHaveLength(1);
  });

  it("a fenced supervisor (a newer generation owns the stack) removes ITS OWN drill file and controls nothing else", async () => {
    const { m, supervisor } = await activeDrill();
    const ownership = JSON.parse(m.files.get(m.paths.ownership) as string) as { generation: number };
    m.files.set(m.paths.ownership, JSON.stringify({ ...ownership, generation: ownership.generation + 1 }));
    expect(await supervisor.tick()).toBe("FENCED");
    expect(drillFiles(m)).toEqual([]);
    expect(incidentsOf(m, "DRILL_ENDED").map((i) => i.reasonCode)).toEqual(["FENCED"]);
  });

  it("a supervisor that crashed mid-drill: the next generation removes every leftover drill file at start (DRILL_STALE_REMOVED); the adopted scanner's fault ends", async () => {
    const { m, supervisor } = await activeDrill();
    await run(m, supervisor, 1); // the scanner applies the drill
    expect(supervisor.status().drill?.activation).toBe("CONFIRMED");
    const file = drillFileOfScanner(m);
    // No cleanup ran: the process just died. A new generation starts on the same machine and adopts the scanner.
    const next = await startSupervisor(m);
    expect(next.started.ok).toBe(true);
    expect(m.files.has(file)).toBe(false);
    const stale = incidentsOf(m, "DRILL_STALE_REMOVED");
    expect(stale).toHaveLength(1);
    expect(stale[0].generation).toBe(next.supervisor.currentGeneration);
    await run(m, next.supervisor, 2);
    expect(next.supervisor.status().roles.scanner.health?.drill).toMatchObject({ active: false });
  });

  it("the drilled scanner exits: the drill ends (RUN_ENDED), its file is removed, and the replacement run is NEVER drilled", async () => {
    const { m, supervisor } = await activeDrill();
    const file = drillFileOfScanner(m);
    const oldRun = scannerChild(m).runId;
    m.kill(scannerChild(m).root);
    await run(m, supervisor, 1); // the exit is noticed
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    expect(scannerChild(m).runId).not.toBe(oldRun);
    expect(incidentsOf(m, "DRILL_ENDED").map((i) => i.reasonCode)).toEqual(["RUN_ENDED"]);
    expect(m.files.has(file)).toBe(false);
    expect(drillFiles(m)).toEqual([]);
    expect(supervisor.status().roles.scanner.health?.drill ?? null).toBeNull();
    expect(supervisor.status().drill?.restore).toBe("CONFIRMED");
  });
});

describe("races between expiry, restore and shutdown resolve deterministically: exactly one end, the truest reason", () => {
  it("expiry, a restore request and a stop request in the same pass → one DRILL_ENDED, EXPIRED", async () => {
    const { m, supervisor } = await activeDrill({ durationSeconds: 30 });
    m.now += 31_000;
    m.files.set(m.paths.stopRequest, JSON.stringify({ schema: "teddy.native-monitoring.always-on-request.v1", kind: "STOP", generation: supervisor.currentGeneration }));
    m.files.set(m.paths.drillRestoreRequest, "{}");
    await run(m, supervisor, 3, 2_000);
    expect(incidentsOf(m, "DRILL_ENDED").map((i) => i.reasonCode)).toEqual(["EXPIRED"]);
  });

  it("a restore request and a stop request before expiry → one DRILL_ENDED, SHUTDOWN", async () => {
    const { m, supervisor } = await activeDrill();
    m.files.set(m.paths.stopRequest, JSON.stringify({ schema: "teddy.native-monitoring.always-on-request.v1", kind: "STOP", generation: supervisor.currentGeneration }));
    m.files.set(m.paths.drillRestoreRequest, "{}");
    await run(m, supervisor, 3, 2_000);
    expect(incidentsOf(m, "DRILL_ENDED").map((i) => i.reasonCode)).toEqual(["SHUTDOWN"]);
  });

  it("a restore, then the original expiry instant passing → still exactly one DRILL_ENDED (OPERATOR_RESTORE)", async () => {
    const { m, supervisor } = await activeDrill({ durationSeconds: 60 });
    m.files.set(m.paths.drillRestoreRequest, "{}");
    await run(m, supervisor, 10);
    expect(incidentsOf(m, "DRILL_ENDED").map((i) => i.reasonCode)).toEqual(["OPERATOR_RESTORE"]);
  });
});

describe("the audit trail", () => {
  it("journals every step with its identity, target and times — and never an environment value or credential", async () => {
    const { m, supervisor } = await activeDrill({ durationSeconds: 30 });
    requestDrill(m, supervisor, { generation: 99 });
    await run(m, supervisor, 6);
    const text = m.files.get(m.paths.incidents) as string;
    for (const kind of ["DRILL_STARTED", "DRILL_REJECTED", "DRILL_ENDED", "DRILL_ACTIVATION_CONFIRMED", "DRILL_RESTORE_CONFIRMED"]) expect(text).toContain(kind);
    for (const secret of ["never-inherited", "postgresql://", "account-a-identifier"]) expect(text).not.toContain(secret);
    const ended = incidentsOf(m, "DRILL_ENDED")[0];
    expect(ended.facts).toMatchObject({ drillId: expect.any(String), fault: "PUBLIC_ALL_DOWN", startedAt: expect.any(String), expiresAt: expect.any(String), endedAt: expect.any(String), fileRemoved: true });
  });
});

// ===========================================================================
// N1: a run that already had a drill is still watched
// ===========================================================================

const plant = (m: FakeMachine, supervisor: AlwaysOnSupervisor, n: number, runId = scannerChild(m).runId as string) =>
  m.files.set(
    drillFileOfScanner(m),
    publicTransportDrillText({ drillId: id(n), fault: "PUBLIC_ALL_DOWN", runId, generation: supervisor.currentGeneration, startedAtMs: m.now, expiresAtMs: m.now + 900_000, faults: { rest: "REFUSED", openStreams: "DROP", newStreams: "REFUSED" } })
  );
const inconsistencies = (m: FakeMachine) => incidentsOf(m, "DRILL_STATE_INCONSISTENT").map((i) => i.reasonCode);

async function completedDrill() {
  const stack = await activeDrill({ durationSeconds: 30 });
  await stack.supervisor.tick();
  stack.m.now += 45_000;
  await run(stack.m, stack.supervisor, 2);
  expect(stack.supervisor.status().drill).toMatchObject({ state: "ENDED", restore: "CONFIRMED" });
  return stack;
}

describe("N1: a completed drill's path stays watched, and a past restore never vouches for a new fault", () => {
  it("a file planted after a completed drill is removed and journaled; the restore is withdrawn while the scanner applies it, and confirmed again once its own report says nothing is applied", async () => {
    const { m, supervisor } = await completedDrill();
    const file = drillFileOfScanner(m);
    plant(m, supervisor, 901);
    await run(m, supervisor, 1);
    expect(m.files.has(file)).toBe(false);
    expect(incidentsOf(m, "DRILL_UNAUTHORIZED_FILE_REMOVED").map((i) => i.facts.file)).toEqual([path.basename(file)]);
    expect(inconsistencies(m)).toEqual(["SCANNER_REPORTS_UNEXPECTED_DRILL"]);
    expect(supervisor.status().drill?.restore).toBe("UNCONFIRMED");
    await run(m, supervisor, 1);
    expect(supervisor.status().roles.scanner.health?.drill).toMatchObject({ drillId: id(901), active: false });
    expect(supervisor.status().drill?.restore).toBe("CONFIRMED");
    expect(m.connectivityDrills.every((d) => d === null)).toBe(true);
  });

  it("no accepted drill at all: a scanner reporting one is flagged, and the status says it was not accepted (never a quiet healthy line)", async () => {
    const { m, supervisor } = await runningStack();
    m.scannerDrill = () => ({ drillId: id(902), fault: "PUBLIC_ALL_DOWN", active: true, activatedAt: null, endedAt: null, endReason: null });
    await run(m, supervisor, 3);
    expect(inconsistencies(m)).toEqual(["SCANNER_REPORTS_UNEXPECTED_DRILL"]);
    expect(renderAlwaysOnStatus(supervisor.status(), m.now).some((l) => l.includes("DRILL") && l.includes(id(902)) && l.includes("NOT accepted"))).toBe(true);
  });

  it("a status written before this drill started, naming an older drill as applied, raises nothing and withdraws nothing: it says nothing about now", async () => {
    const { m, supervisor } = await activeDrill({ durationSeconds: 600 });
    const child = scannerChild(m);
    const startedAtMs = Date.parse(supervisor.status().drill?.startedAt as string);
    m.scannerBehaviour = "silent";
    m.scannerDrill = () => ({ drillId: id(907), fault: "PUBLIC_ALL_DOWN", active: true, activatedAt: null, endedAt: null, endReason: null });
    m.writeScannerStatus(child, HEALTHY_UNIVERSE, 5_000, "RUNNING", startedAtMs - 1_000);
    await run(m, supervisor, 1);
    expect(inconsistencies(m)).toEqual([]);
    expect(supervisor.status().drill?.state).toBe("ACTIVE");
  });

  it("a legitimate drill, from request to confirmed restore, raises no inconsistency; nor does its removal retry", async () => {
    const { m, supervisor } = await activeDrill({ durationSeconds: 60 });
    await run(m, supervisor, 3);
    m.failRemove = (f) => f.endsWith(".drill");
    await run(m, supervisor, 4);
    expect(supervisor.status().drill).toMatchObject({ state: "ENDED", fileRemoved: false });
    m.failRemove = null;
    await run(m, supervisor, 3);
    expect(supervisor.status().drill).toMatchObject({ fileRemoved: true, restore: "CONFIRMED" });
    expect(inconsistencies(m)).toEqual([]);
    expect(incidentsOf(m, "DRILL_UNAUTHORIZED_FILE_REMOVED")).toEqual([]);
  });

  it("a file naming ANOTHER run at the scanner's path is inert to its gate: never deleted, journaled once; another child's file is not even looked at", async () => {
    const { m, supervisor } = await completedDrill();
    const file = drillFileOfScanner(m);
    const elsewhere = path.join(m.paths.stopDir, "scanner-g9-s9.drill");
    m.files.set(elsewhere, "{}");
    plant(m, supervisor, 903, "20261022T000000Z-deadbeef");
    await run(m, supervisor, 3);
    expect(m.files.has(file)).toBe(true);
    expect(m.files.has(elsewhere)).toBe(true);
    expect(inconsistencies(m)).toEqual(["FILE_OF_ANOTHER_RUN"]);
    expect(incidentsOf(m, "DRILL_UNAUTHORIZED_FILE_REMOVED")).toEqual([]);
    expect(supervisor.status().roles.scanner.health?.drill).toMatchObject({ drillId: request0(supervisor), active: false });
    expect(supervisor.status().drill?.restore).toBe("CONFIRMED");
  });

  it.each([
    ["an invalid file", (m: FakeMachine) => m.files.set(drillFileOfScanner(m), "{half-written"), "FILE_INVALID"],
    ["an unreadable file", (m: FakeMachine) => {
      m.files.set(drillFileOfScanner(m), "{}");
      m.failRead = (f) => f.endsWith(".drill");
    }, "FILE_UNREADABLE"],
  ])("%s: fail closed — kept, journaled once, nothing claimed about it", async (_label, arrange, reason) => {
    const { m, supervisor } = await runningStack();
    const file = drillFileOfScanner(m);
    arrange(m);
    await run(m, supervisor, 3);
    m.failRead = null;
    expect(m.files.has(file)).toBe(true);
    expect(inconsistencies(m)).toEqual([reason]);
    expect(incidentsOf(m, "DRILL_UNAUTHORIZED_FILE_REMOVED")).toEqual([]);
  });

  it("a planted file that cannot be removed is journaled once, retried every pass, and journaled again when it goes", async () => {
    const { m, supervisor } = await runningStack();
    const file = drillFileOfScanner(m);
    plant(m, supervisor, 904);
    m.failRemove = (f) => f.endsWith(".drill");
    await run(m, supervisor, 3);
    expect(incidentsOf(m, "DRILL_UNAUTHORIZED_FILE_REMOVED").map((i) => i.reasonCode)).toEqual(["NOT_WRITTEN_BY_THIS_SUPERVISOR_REMOVAL_FAILED"]);
    m.failRemove = null;
    await run(m, supervisor, 1);
    expect(m.files.has(file)).toBe(false);
    expect(incidentsOf(m, "DRILL_UNAUTHORIZED_FILE_REMOVED").map((i) => i.reasonCode)).toEqual(["NOT_WRITTEN_BY_THIS_SUPERVISOR_REMOVAL_FAILED", "NOT_WRITTEN_BY_THIS_SUPERVISOR"]);
  });

  it("the replaced run's file at the replacement's path cannot touch the replacement, and an accepted drill replaces it", async () => {
    const { m, supervisor } = await activeDrill();
    const oldRun = scannerChild(m).runId as string;
    m.kill(scannerChild(m).root);
    await run(m, supervisor, 1);
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    plant(m, supervisor, 905, oldRun);
    await run(m, supervisor, 2);
    expect(supervisor.status().roles.scanner.health?.drill ?? null).toBeNull();
    expect(inconsistencies(m)).toEqual(["FILE_OF_ANOTHER_RUN"]);
    const accepted = requestDrill(m, supervisor, { durationSeconds: 30 });
    await run(m, supervisor, 2);
    expect(supervisor.status().drill).toMatchObject({ drillId: accepted.requestId, state: "ACTIVE", activation: "CONFIRMED" });
    expect(supervisor.status().roles.scanner.health?.drill).toMatchObject({ drillId: accepted.requestId, active: true });
  });
});

// ===========================================================================
// N4: the wall clock moves during a drill
// ===========================================================================

describe("N4: a wall clock moved backwards never keeps a drill alive", () => {
  const HOUR = 3_600_000;

  it("an hour back mid-drill: the drill ends at once (CLOCK_ROLLBACK), its file goes, the probes are real, and the restore is confirmed exactly once on the scanner's own report", async () => {
    const { m, supervisor } = await activeDrill({ durationSeconds: 600 });
    await run(m, supervisor, 1);
    m.jumpWall(-HOUR);
    await run(m, supervisor, 3);
    expect(incidentsOf(m, "DRILL_ENDED").map((i) => i.reasonCode)).toEqual(["CLOCK_ROLLBACK"]);
    expect(drillFiles(m)).toEqual([]);
    expect(supervisor.status().drill).toMatchObject({ state: "ENDED", fileRemoved: true, restore: "CONFIRMED" });
    expect(incidentsOf(m, "DRILL_RESTORE_CONFIRMED")).toHaveLength(1);
    expect(supervisor.status().roles.scanner.health?.drill).toMatchObject({ active: false });
    await run(m, supervisor, 20);
    expect(incidentsOf(m, "DRILL_ENDED")).toHaveLength(1);
  });

  it("a drilled probe's answer cached before the rollback does not hold the scanner: the next probe is real, with no drill", async () => {
    const { m, supervisor } = await activeDrill({ fault: "PUBLIC_ALL_DOWN", durationSeconds: 600 });
    m.scannerBehaviour = "degraded";
    await run(m, supervisor, 12);
    expect(supervisor.status().roles.scanner.reasonCode).toBe("NETWORK_UNAVAILABLE");
    m.scannerBehaviour = "healthy";
    m.jumpWall(-HOUR);
    await run(m, supervisor, 2);
    const before = m.connectivityDrills.length;
    m.scannerBehaviour = "degraded";
    await run(m, supervisor, 8);
    expect(m.connectivityDrills.length).toBeGreaterThan(before);
    expect(m.connectivityDrills.slice(before).every((d) => d === null)).toBe(true);
    expect(supervisor.status().roles.scanner.reasonCode).not.toBe("NETWORK_UNAVAILABLE");
  });

  it("the clock moves back after the drill ended, before its restore was confirmed: the scanner's later report still confirms it, despite its older-looking timestamp", async () => {
    const { m, supervisor } = await activeDrill({ durationSeconds: 600 });
    await run(m, supervisor, 1);
    m.files.set(m.paths.drillRestoreRequest, "{}");
    const honest = m.scannerDrill;
    m.scannerDrill = () => null; // no status with the end in it yet
    m.scannerBehaviour = "silent";
    await run(m, supervisor, 1);
    expect(supervisor.status().drill?.state).toBe("ENDED");
    m.scannerDrill = honest;
    m.scannerBehaviour = "healthy";
    m.jumpWall(-HOUR);
    await run(m, supervisor, 3);
    expect(supervisor.status().drill?.restore).toBe("CONFIRMED");
    expect(incidentsOf(m, "DRILL_RESTORE_CONFIRMED")).toHaveLength(1);
    expect(inconsistencies(m)).toEqual(["WALL_CLOCK_MOVED_BACK"]);
  });

  it("evidence that cannot prove it, after a rollback: nothing confirmed — a silent scanner reads UNCONFIRMED on the monotonic clock (no wait for the wall clock to catch up), and another active drill is no restoration", async () => {
    const silent = await runningStack();
    silent.m.scannerDrill = () => null;
    requestDrill(silent.m, silent.supervisor, { durationSeconds: 600 });
    await run(silent.m, silent.supervisor, 2);
    silent.m.jumpWall(-HOUR);
    await run(silent.m, silent.supervisor, 15);
    expect(silent.supervisor.status().drill).toMatchObject({ state: "ENDED", activation: "UNCONFIRMED", restore: "UNCONFIRMED" });
    expect(incidentsOf(silent.m, "DRILL_RESTORE_CONFIRMED")).toEqual([]);

    const other = await activeDrill({ durationSeconds: 600 });
    await run(other.m, other.supervisor, 1);
    other.m.jumpWall(-HOUR);
    other.m.scannerDrill = () => ({ drillId: id(906), fault: "PUBLIC_ALL_DOWN", active: true, activatedAt: null, endedAt: null, endReason: null });
    await run(other.m, other.supervisor, 15);
    expect(other.supervisor.status().drill?.restore).toBe("UNCONFIRMED");
    expect(incidentsOf(other.m, "DRILL_RESTORE_CONFIRMED")).toEqual([]);
  });

  it("a rollback after the end, with the scanner still reporting the drill applied: UNCONFIRMED on the monotonic clock, with no wait for the wall clock to catch up", async () => {
    const { m, supervisor, request } = await activeDrill({ durationSeconds: 600 });
    await run(m, supervisor, 1);
    m.files.set(m.paths.drillRestoreRequest, "{}");
    m.scannerDrill = () => ({ drillId: request.requestId, fault: "PUBLIC_ALL_DOWN", active: true, activatedAt: null, endedAt: null, endReason: null });
    await run(m, supervisor, 1);
    m.jumpWall(-HOUR);
    await run(m, supervisor, 14);
    expect(supervisor.status().drill).toMatchObject({ state: "ENDED", restore: "UNCONFIRMED" });
    expect(incidentsOf(m, "DRILL_RESTORE_CONFIRMED")).toEqual([]);
  });

  it("a previous generation's drill report restores nothing: a scanner still reporting that older drill never confirms this one", async () => {
    const first = await activeDrill();
    await run(first.m, first.supervisor, 1);
    const next = await startSupervisor(first.m);
    await run(first.m, next.supervisor, 2);
    requestDrill(first.m, next.supervisor, { durationSeconds: 600 });
    first.m.scannerDrill = () => ({ drillId: first.request.requestId, fault: "PUBLIC_ALL_DOWN", active: false, activatedAt: null, endedAt: null, endReason: "FILE_REMOVED" });
    await run(first.m, next.supervisor, 2);
    first.m.files.set(first.m.paths.drillRestoreRequest, "{}");
    await run(first.m, next.supervisor, 15);
    expect(next.supervisor.status().drill).toMatchObject({ state: "ENDED", restore: "UNCONFIRMED" });
    expect(incidentsOf(first.m, "DRILL_RESTORE_CONFIRMED")).toEqual([]);
  });

  it("the TTL holds on the monotonic clock: a small correction (inside the tolerance) changes nothing and the drill still ends on time; so do manual restore, shutdown and a crash after a rollback", async () => {
    const small = await activeDrill({ durationSeconds: 60 });
    small.m.jumpWall(-3_000);
    await run(small.m, small.supervisor, 3);
    expect(small.supervisor.status().drill?.state).toBe("ACTIVE");
    await run(small.m, small.supervisor, 1); // 60 s on the monotonic clock; the wall clock reads 57 s
    expect(incidentsOf(small.m, "DRILL_ENDED").map((i) => i.reasonCode)).toEqual(["EXPIRED"]);

    const restore = await activeDrill({ durationSeconds: 600 });
    restore.m.jumpWall(-HOUR);
    restore.m.files.set(restore.m.paths.drillRestoreRequest, "{}");
    await run(restore.m, restore.supervisor, 2);
    expect(incidentsOf(restore.m, "DRILL_ENDED")).toHaveLength(1);

    const stop = await activeDrill({ durationSeconds: 600 });
    stop.m.jumpWall(-HOUR);
    stop.supervisor.requestShutdown("OPERATOR_STOP_REQUEST");
    await run(stop.m, stop.supervisor, 3, 2_000);
    expect(incidentsOf(stop.m, "DRILL_ENDED").map((i) => i.reasonCode)).toEqual(["SHUTDOWN"]);
    expect(drillFiles(stop.m)).toEqual([]);

    const crash = await activeDrill({ durationSeconds: 600 });
    crash.m.jumpWall(-HOUR);
    await startSupervisor(crash.m);
    expect(drillFiles(crash.m)).toEqual([]);
  });

  it("ordinary clocks are unchanged: a forward jump only ends a drill early (EXPIRED, never a rollback), and normal progress raises nothing", async () => {
    const { m, supervisor } = await activeDrill({ durationSeconds: 600 });
    m.jumpWall(HOUR);
    await run(m, supervisor, 2);
    expect(incidentsOf(m, "DRILL_ENDED").map((i) => i.reasonCode)).toEqual(["EXPIRED"]);
    expect(inconsistencies(m)).toEqual([]);
  });
});
