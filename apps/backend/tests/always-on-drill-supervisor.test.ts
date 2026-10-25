import { describe, expect, it } from "vitest";

import { drillStartRequestText, type DrillStartRequest } from "../src/modules/always-on/always-on-drill";
import { renderAlwaysOnStatus } from "../src/modules/always-on/always-on-status";
import type { AlwaysOnSupervisor } from "../src/modules/always-on/always-on-supervisor";
import { PublicTransportDrillGate, drillFileOf, parsePublicTransportDrill } from "../src/modules/native-scanner/public-transport-drill";
import { FakeMachine, REPO, run, startSupervisor, testConfig, until } from "./helpers/always-on-fake-machine";

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
      gate = new PublicTransportDrillGate({ file: drillFileOf(child.stopFile), runId: child.runId, readText: (f) => m.files.get(f) ?? null, nowMs: () => m.now, monoMs: () => m.now, log: () => undefined });
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
    const { m } = await activeDrill();
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
