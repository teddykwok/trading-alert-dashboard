import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";

/**
 * Start Trading must never create a temporarily-LEGACY window.
 *
 * ## The hole this closes
 *
 * A NATURAL window is session-backed when `tradingSessionId` is set, and
 * LEGACY when it is null. Legacy is a real, supported mode — historical rows
 * rely on it, and it admits up to `maxClaims` trades WITHOUT any session.
 *
 * That makes the null state dangerous for a NEW start. The original sequence
 * was:
 *
 *     1. prepare window (committed, tradingSessionId null)
 *     2. arm the profile (committed)   <- the window is now USABLE
 *     3. create session + link it
 *
 * A crash between 2 and 3 left an armed profile and a usable window that read
 * as legacy, free to admit five trades with no session bounding them at all —
 * the precise opposite of the fail-closed contract a session-backed start
 * promises.
 *
 * The order is now session -> window (born linked) -> arm, so every crash
 * window is a safe one. These tests fault the path deliberately and check the
 * committed state that survives.
 */

const TAG = "start-atomicity-synthetic";

/**
 * The profile identity must be set BEFORE `config/env` is evaluated, because
 * `configuredProfileIdentity()` reads a frozen snapshot of it. Doing this in
 * `beforeAll` is too late — Start Trading would resolve the real configured
 * profile instead of this suite's synthetic one.
 *
 * Snapshotted and restored: vitest reuses a worker across files, and a leaked
 * identity would silently retarget a later suite.
 */
const OVERRIDDEN = ["EXECUTION_PROFILE_ACCOUNT_IDENTIFIER", "EXECUTION_PROFILE_ENVIRONMENT"];
const originalEnv = new Map(OVERRIDDEN.map((key) => [key, process.env[key]]));
process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = `${TAG}-account`;
process.env.EXECUTION_PROFILE_ENVIRONMENT = "TESTNET";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const ACTIONS_SOURCE = readFileSync(
  path.resolve(__dirname, "../src/modules/operator/trading-control-actions.service.ts"),
  "utf8"
);
const PREPARE_SOURCE = readFileSync(
  path.resolve(__dirname, "../src/modules/execution/canary-authorization.service.ts"),
  "utf8"
);

/**
 * A switch for faulting the session write that STOP performs last.
 *
 * `vi.hoisted` because `vi.mock` is lifted above every declaration; a plain
 * `const` would not exist yet when the factory runs.
 */
const fault = vi.hoisted(() => ({ revokeThrows: false }));

vi.mock("../src/modules/execution/trading-session.service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/execution/trading-session.service")>();
  return {
    ...actual,
    revokeCurrentSession: async (...args: Parameters<typeof actual.revokeCurrentSession>) => {
      if (fault.revokeThrows) throw new Error("simulated crash while ending the session");
      return actual.revokeCurrentSession(...args);
    },
  };
});

const { TradingControlActionsService, START_TRADING_CONFIRMATION } = await import(
  "../src/modules/operator/trading-control-actions.service"
);
const { CanaryAuthorizationService } = await import(
  "../src/modules/execution/canary-authorization.service"
);

const maybe = () => (available ? it : it.skip);

let profileId = "";

/** The envelope Start Trading insists the persisted policy already equals. */
const REVIEWED_POLICY = {
  maxOpenPositions: 5,
  maxPendingEntries: 5,
  maxTotalActiveTrades: 5,
  maxActivePerSymbolSide: 1,
  softOpenPositionTarget: 3,
  maxTotalPlannedRiskUsd: "7.50",
  maxTotalIsolatedMarginUsd: "40.00",
};

/** The same fixture shapes the reviewed operator-actions suite uses. */
const passingAttestation = () =>
  ({
    ok: true,
    reasonCode: null,
    message: null,
    backend: { role: "BACKEND", freshCount: 1, staleCount: 0, gates: null, instanceId: "b1" },
    worker: { role: "WORKER", freshCount: 1, staleCount: 0, gates: null, instanceId: "w1" },
  }) as never;

const preflightResult = () =>
  ({
    ready: false,
    preparationReady: true,
    findings: [],
    preparationBlockers: [],
    liveActivationBlockers: [],
    summary: "CANARY_BLOCKED_GATE_STATE",
    gathered: {},
  }) as never;

const service = (overrides: Record<string, unknown> = {}) =>
  new TradingControlActionsService(prisma!, {
    preflight: { run: async () => preflightResult() },
    readAttestation: async () => passingAttestation(),
    environmentArmed: () => true,
    ...overrides,
  } as never);

/** Every NATURAL window on the profile, newest first. */
const windows = () =>
  prisma!.executionCanaryAuthorization.findMany({
    where: { executionProfileId: profileId, authorizationType: "NATURAL_WINDOW" },
    orderBy: { createdAt: "desc" },
  });

const sessions = () =>
  prisma!.tradingSession.findMany({
    where: { executionProfileId: profileId },
    orderBy: { startedAt: "desc" },
  });

async function reset() {
  await prisma!.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
  await prisma!.tradingSessionSlot.deleteMany({
    where: { tradingSession: { executionProfileId: profileId } },
  });
  await prisma!.tradingSession.deleteMany({ where: { executionProfileId: profileId } });
  await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled: false } });
  await prisma!.executionSafetyPolicy.update({
    where: { executionProfileId: profileId },
    data: { killSwitchActive: true },
  });
}

beforeAll(async () => {
  if (!prisma || !available) return;
  const profile = await prisma.executionProfile.create({
    data: {
      name: "Start atomicity synthetic profile",
      accountIdentifier: `${TAG}-account`,
      environment: "TESTNET",
      isEnabled: false,
    },
  });
  profileId = profile.id;
  await prisma.executionSafetyPolicy.create({
    data: {
      executionProfileId: profileId,
      killSwitchActive: true,
      allowedSymbols: ["COWUSDT"],
      // The persisted limits must BE the reviewed canary envelope, or Start
      // Trading refuses with POLICY_ENVELOPE_MISMATCH before it writes anything
      // — which would make these tests pass for the wrong reason.
      ...REVIEWED_POLICY,
    },
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  fault.revokeThrows = false;
  if (!prisma || !available) return;
  await reset();
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    await reset();
    await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionProfile.deleteMany({ where: { id: profileId } });
  }
  await prisma.$disconnect();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ===========================================================================
// The invariant, stated as one assertion
// ===========================================================================

/**
 * No committed NATURAL window may be BOTH usable and unlinked.
 *
 * "Usable" is the pair that matters: an un-revoked, in-date window on a profile
 * that is armed. A window on a disabled profile with the kill switch engaged
 * admits nothing whatever its link says.
 */
async function assertNoUsableUnlinkedWindow() {
  const profile = await prisma!.executionProfile.findUniqueOrThrow({
    where: { id: profileId },
    include: { safetyPolicy: true },
  });
  const armed = profile.isEnabled && profile.safetyPolicy?.killSwitchActive === false;
  if (!armed) return; // Nothing is usable while the profile is safe.

  const now = new Date();
  const usable = (await windows()).filter(
    (row) => row.revokedAt === null && row.expiresAt > now
  );
  for (const row of usable) {
    expect(
      `${row.id}:${row.tradingSessionId === null ? "UNLINKED" : "linked"}`,
      "an armed profile must never carry a usable window with no session"
    ).toBe(`${row.id}:linked`);
  }
}

// ===========================================================================
// A. Failure injection
// ===========================================================================

describe("A. a partial Start Trading leaves nothing usable and unlinked", () => {
  maybe()("prepare fails after the session was created", async () => {
    await reset();
    vi.spyOn(CanaryAuthorizationService.prototype, "prepareNaturalWindow").mockRejectedValue(
      new Error("simulated crash before the window was created")
    );

    const result = await service().startTrading(START_TRADING_CONFIRMATION, 60, 100);

    expect(result.ok).toBe(false);
    // Either both exist, or no usable session-backed authorization does. Here:
    // no window at all, and the session opened moments earlier is retired.
    expect(await windows()).toHaveLength(0);
    const [session] = await sessions();
    expect(session?.status).toBe("REVOKED");
    await assertNoUsableUnlinkedWindow();
  });

  maybe()("arming fails after a linked window was created", async () => {
    await reset();
    // Force arming to refuse by moving the policy version underneath it.
    const result = await service({
      readAttestation: async () =>
        ({
          ok: false,
          reasonCode: "RUNTIME_ATTESTATION_MISSING",
          message: "no runtime is attesting",
          backend: { role: "BACKEND", freshCount: 0, staleCount: 0, gates: null, instanceId: null },
          worker: { role: "WORKER", freshCount: 0, staleCount: 0, gates: null, instanceId: null },
        }) as never,
    }).startTrading(START_TRADING_CONFIRMATION, 60, 100);

    expect(result.ok).toBe(false);
    // The profile is NOT armed, so nothing is usable regardless.
    const profile = await prisma!.executionProfile.findUniqueOrThrow({ where: { id: profileId } });
    expect(profile.isEnabled).toBe(false);
    await assertNoUsableUnlinkedWindow();
  });

  maybe()("any window that survives a failed start is linked, never legacy", async () => {
    await reset();
    vi.spyOn(CanaryAuthorizationService.prototype, "prepareNaturalWindow").mockImplementation(
      async function (this: unknown, input: never) {
        // Create the window exactly as production does — linked — and then
        // fail, standing in for a crash immediately afterwards.
        const created = await new CanaryAuthorizationService(prisma!).prepareNaturalWindow(
          input as never
        );
        void created;
        throw new Error("simulated crash immediately after the window was created");
      } as never
    );

    await service().startTrading(START_TRADING_CONFIRMATION, 60, 100);

    // The window survived the crash. What matters is that it is LINKED, so it
    // can never be mistaken for a legacy window free of a session.
    for (const row of await windows()) {
      expect(row.tradingSessionId, "a surviving window must carry its session").not.toBeNull();
    }
    await assertNoUsableUnlinkedWindow();
  });
});

// ===========================================================================
// B. The success path
// ===========================================================================

describe("B. a successful start links the window to its OWN session", () => {
  maybe()("the window names the exact session this call created", async () => {
    await reset();
    const result = await service().startTrading(START_TRADING_CONFIRMATION, 360, 100);
    expect(result.ok).toBe(true);

    const [window] = await windows();
    const active = (await sessions()).filter((row) => row.status === "ACTIVE");

    expect(active).toHaveLength(1);
    expect(window.tradingSessionId).toBe(active[0].id);
    expect(active[0].tradeBudget).toBe(100);
    await assertNoUsableUnlinkedWindow();
  });

  maybe()("the link is decided at CREATION, not by a later update", () => {
    // A window created unlinked and updated afterwards has a committed window
    // in between; if the process dies there it reads as legacy. Creation is
    // the only point at which the link can be made without that gap.
    expect(PREPARE_SOURCE).toContain("tradingSessionId: input.tradingSessionId ?? null,");
    // Start Trading passes it in, and performs no follow-up link.
    expect(ACTIONS_SOURCE).toContain("tradingSessionId: session.id,");
    expect(ACTIONS_SOURCE).not.toContain("data: { tradingSessionId: created.id }");
  });

  maybe()("the session is created BEFORE the window", () => {
    const sessionAt = ACTIONS_SOURCE.indexOf("return tx.tradingSession.create({");
    const prepareAt = ACTIONS_SOURCE.indexOf("prepareNaturalWindow({");
    expect(sessionAt).toBeGreaterThan(0);
    expect(prepareAt).toBeGreaterThan(sessionAt);
  });

  maybe()("a profile never carries two ACTIVE sessions", async () => {
    await reset();
    await service().startTrading(START_TRADING_CONFIRMATION, 60, 100);
    // Safe Off ends the session; a stop whose session write failed would not.
    // Simulate that leak, then start again.
    fault.revokeThrows = true;
    await expect(service().safeOff()).rejects.toThrow(/simulated crash/);
    fault.revokeThrows = false;
    expect((await sessions())[0]?.status).toBe("ACTIVE");

    await service().startTrading(START_TRADING_CONFIRMATION, 60, 50);

    const active = (await sessions()).filter((row) => row.status === "ACTIVE");
    expect(active, "the stale session must be retired by the new start").toHaveLength(1);
    expect(active[0].tradeBudget).toBe(50);
    const [window] = (await windows()).filter((row) => row.revokedAt === null);
    expect(window.tradingSessionId).toBe(active[0].id);
    await assertNoUsableUnlinkedWindow();
  });

  maybe()("an already-armed profile keeps the session backing its NEW window", async () => {
    await reset();
    await service().startTrading(START_TRADING_CONFIRMATION, 60, 100);
    // Retire the window but leave the profile armed — the state that makes
    // `armNaturalWindow` report alreadyArmed on the next start.
    await prisma!.executionCanaryAuthorization.updateMany({
      where: { executionProfileId: profileId },
      data: { revokedAt: new Date() },
    });

    const result = await service().startTrading(START_TRADING_CONFIRMATION, 60, 50);
    expect(result.ok).toBe(true);

    // The freshly prepared window is the live one, so the session it names
    // must be ACTIVE. Retiring it and reporting the older session would leave
    // the operator watching a session no window is bound to.
    const [live] = (await windows()).filter((row) => row.revokedAt === null);
    const backing = (await sessions()).find((row) => row.id === live.tradingSessionId);
    expect(backing?.status).toBe("ACTIVE");
    expect(backing?.tradeBudget).toBe(50);
    expect((await sessions()).filter((row) => row.status === "ACTIVE")).toHaveLength(1);
    await assertNoUsableUnlinkedWindow();
  });

  maybe()("no profile-level 'latest session' inference reaches admission", () => {
    // A stale window must never attach to a newer session. Admission targets
    // the session the WINDOW names, by id.
    const admission = readFileSync(
      path.resolve(__dirname, "../src/modules/execution/safety-admission.service.ts"),
      "utf8"
    );
    expect(admission).toContain("tradingSessionId: authorization.window.tradingSessionId");
    expect(admission).not.toContain("findCurrentSession");
  });
});

// ===========================================================================
// C. Stop / revoke ordering
// ===========================================================================

describe("C. stopping denies authorization before it touches the session", () => {
  maybe()("Stop New Trades engages the kill switch first", () => {
    const stop = ACTIONS_SOURCE.slice(
      ACTIONS_SOURCE.indexOf("async stopNewTrades()"),
      ACTIONS_SOURCE.indexOf("async safeOff()")
    );
    // Ordered, not atomic — and this is the safe order. If the session write
    // fails, admission is ALREADY blocked by the kill switch, so authorization
    // denial alone is sufficient to stop new trades.
    expect(stop.indexOf("closeCanaryWindowOperation")).toBeLessThan(
      stop.indexOf("revokeCurrentSession")
    );
  });

  maybe()("Safe Off disarms first", () => {
    const safe = ACTIONS_SOURCE.slice(ACTIONS_SOURCE.indexOf("async safeOff()"));
    expect(safe.indexOf("disarmCanaryOperation")).toBeLessThan(safe.indexOf("revokeCurrentSession"));
  });

  maybe()("a completed stop blocks admission and ends the session", async () => {
    await reset();
    await service().startTrading(START_TRADING_CONFIRMATION, 60, 100);
    await service().stopNewTrades();

    const profile = await prisma!.executionProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: { safetyPolicy: true },
    });
    expect(profile.safetyPolicy?.killSwitchActive).toBe(true);
    expect((await sessions())[0]?.status).toBe("REVOKED");
    await assertNoUsableUnlinkedWindow();
  });

  maybe()("a stop whose SESSION write fails still admits nothing", async () => {
    // The §6 question, asked directly: the two writes are ordered rather than
    // atomic, so what survives if the second one dies?
    await reset();
    await service().startTrading(START_TRADING_CONFIRMATION, 60, 100);

    fault.revokeThrows = true;
    await expect(service().stopNewTrades()).rejects.toThrow(/simulated crash/);

    const profile = await prisma!.executionProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: { safetyPolicy: true },
    });
    // The session row is deliberately left ACTIVE — its write never landed.
    expect((await sessions())[0]?.status).toBe("ACTIVE");

    // And it does not matter, because the FIRST write already landed. Stop
    // engages the kill switch (revoking windows is Safe Off's job, not this
    // one), and a kill-switched admission can never reach the session at all:
    // the reservation sits behind `result.decision === "PASS"`, and the kill
    // switch guarantees a refusal before that. So the stale ACTIVE session
    // grants nothing, and no transaction spanning both writes is needed.
    expect(profile.safetyPolicy?.killSwitchActive).toBe(true);

    const admission = readFileSync(
      path.resolve(__dirname, "../src/modules/execution/safety-admission.service.ts"),
      "utf8"
    );
    expect(admission.indexOf('if (result.decision === "PASS")')).toBeLessThan(
      admission.indexOf("reserveSessionSlot(tx, {")
    );
    await assertNoUsableUnlinkedWindow();
  });
});
