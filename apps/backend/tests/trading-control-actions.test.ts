import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * The three authenticated operator actions.
 *
 * These are the only routes in the project that can arm a real-money account,
 * so what is being guarded here is narrow and specific: that they are behind
 * the operator credential, that they refuse before doing any work, that they
 * fail CLOSED on every interlock, and above all that they do not contain a
 * second implementation of arming, closing or disarming — they call the exact
 * functions the reviewed CLI calls.
 *
 * Nothing here reaches Binance. The preflight, the attestation reader and the
 * environment-gate predicate are all injected, so a suite run cannot place a
 * signed request against the live account or read the suite process's own
 * activation gates.
 */

const TOKEN = "operator-test-token-0123456789abcdef";
const TEST_IDENTIFIER = "phase11-control-actions";

process.env.OPERATOR_API_TOKEN = TOKEN;
process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = TEST_IDENTIFIER;
process.env.EXECUTION_PROFILE_ENVIRONMENT = "MAINNET";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const describeDb = available && prisma ? describe : describe.skip;

const {
  TradingControlActionsService,
  START_TRADING_CONFIRMATION,
  START_TRADING_DIRECTIONS,
  START_TRADING_MAX_CLAIMS,
  START_TRADING_TTL_MINUTES,
} = await import("../src/modules/operator/trading-control-actions.service");
const { MAXIMUM_AUTHORIZATION_TTL_MINUTES } = await import(
  "../src/modules/execution/natural-authorization"
);
const { operatorRoutes } = await import("../src/routes/operator.routes");
const { AppError } = await import("../src/utils/errors");

const REVIEWED_POLICY = {
  maxOpenPositions: 5,
  maxPendingEntries: 5,
  maxTotalActiveTrades: 5,
  maxActivePerSymbolSide: 1,
  softOpenPositionTarget: 3,
  maxTotalPlannedRiskUsd: "7.50",
  maxTotalIsolatedMarginUsd: "40.00",
};

/** A preflight verdict with nothing blocking; each test narrows it. */
function preflightResult(
  overrides: { preparationBlockers?: unknown[]; liveActivationBlockers?: unknown[] } = {}
) {
  const preparationBlockers = overrides.preparationBlockers ?? [];
  const liveActivationBlockers = overrides.liveActivationBlockers ?? [];
  return {
    ready: false,
    preparationReady: preparationBlockers.length === 0,
    findings: [...preparationBlockers, ...liveActivationBlockers],
    preparationBlockers,
    liveActivationBlockers,
    summary: "CANARY_BLOCKED_GATE_STATE",
    gathered: {},
  } as never;
}

const passingAttestation = () =>
  ({
    ok: true,
    reasonCode: null,
    message: null,
    backend: { role: "BACKEND", freshCount: 1, staleCount: 0, gates: null, instanceId: "b1" },
    worker: { role: "WORKER", freshCount: 1, staleCount: 0, gates: null, instanceId: "w1" },
  }) as never;

const failingAttestation = () =>
  ({
    ok: false,
    reasonCode: "RUNTIME_ATTESTATION_MISSING",
    message: "no fresh BACKEND attestation was found.",
    backend: { role: "BACKEND", freshCount: 0, staleCount: 0, gates: null, instanceId: null },
    worker: { role: "WORKER", freshCount: 0, staleCount: 0, gates: null, instanceId: "w1" },
  }) as never;

// ---------------------------------------------------------------------------
// The HTTP boundary
// ---------------------------------------------------------------------------

describe("operator actions: every mutation is behind the operator credential", () => {
  const paths = [
    "/api/operator/trading-control/start",
    "/api/operator/trading-control/stop-new-trades",
    "/api/operator/trading-control/safe-off",
  ];
  let app: FastifyInstance;
  let invocations = 0;

  beforeAll(async () => {
    app = Fastify();
    app.decorate("prisma", {} as PrismaClient);
    const record = (outcome: string) => async () => {
      invocations += 1;
      return {
        ok: true,
        outcome,
        systemState: "ARMED",
        profile: { environment: "MAINNET", isEnabled: true, killSwitchActive: false },
        authorization: null,
        outstandingExecutions: null,
        authorizationsRevoked: null,
        blockers: [],
        message: "ok",
      };
    };
    await app.register(operatorRoutes, {
      tradingControlFactory: () => ({
        readStatus: async () => ({ systemState: "SAFE_OFF" }),
        readReadiness: async () => ({ preparationReady: true }),
      }),
      tradingControlActionsFactory: () => ({
        startTrading: record("ARMED"),
        stopNewTrades: record("NEW_TRADES_BLOCKED"),
        safeOff: record("SAFE_OFF"),
      }),
    } as never);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        return reply.code(error.statusCode).send({ error: error.name, message: error.message });
      }
      return reply.code(500).send({ error: "Internal", message: "failed" });
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(paths)("refuses %s with no token, before doing any work", async (url) => {
    const before = invocations;
    const response = await app.inject({ method: "POST", url, payload: {} });
    expect(response.statusCode).toBe(401);
    // The refusal must precede the operator service entirely. An unauthenticated
    // caller must never be able to reach an arm or a disarm, not even one that
    // would later fail.
    expect(invocations).toBe(before);
  });

  it.each(paths)("refuses %s with a wrong token", async (url) => {
    const before = invocations;
    const response = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${TOKEN}x` },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(invocations).toBe(before);
  });

  it.each(paths)("refuses %s when the credential is only in the body", async (url) => {
    // The token travels in the Authorization header or not at all. A body or
    // query credential lands in logs and proxies.
    const response = await app.inject({ method: "POST", url, payload: { token: TOKEN, confirmation: "START TRADING" } });
    expect(response.statusCode).toBe(401);
  });

  it.each(paths)("accepts %s with a valid token", async (url) => {
    const response = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { confirmation: "START TRADING" },
    });
    expect(response.statusCode).toBe(200);
  });

  it("answers 409 when an action refuses, so the session survives", async () => {
    // A refused control action is a conflict with authoritative state, not a
    // bad credential. Answering 401 would log the operator out every time the
    // gates were shut.
    const refusing = Fastify();
    refusing.decorate("prisma", {} as PrismaClient);
    await refusing.register(operatorRoutes, {
      tradingControlFactory: () => ({ readStatus: async () => ({}), readReadiness: async () => ({}) }),
      tradingControlActionsFactory: () => ({
        startTrading: async () => ({
          ok: false,
          outcome: "BLOCKED",
          systemState: "SAFE_OFF",
          profile: null,
          authorization: null,
          outstandingExecutions: null,
          authorizationsRevoked: null,
          blockers: ["ENVIRONMENT_GATES_NOT_ARMED: nope"],
          message: "Start refused.",
        }),
        stopNewTrades: async () => ({}) as never,
        safeOff: async () => ({}) as never,
      }),
    } as never);
    await refusing.ready();

    const response = await refusing.inject({
      method: "POST",
      url: "/api/operator/trading-control/start",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { confirmation: START_TRADING_CONFIRMATION },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().blockers).toEqual(["ENVIRONMENT_GATES_NOT_ARMED: nope"]);
    await refusing.close();
  });
});

// ---------------------------------------------------------------------------
// The actions themselves, against the TEST database
// ---------------------------------------------------------------------------

describeDb("operator actions", () => {
  let profileId = "";

  const service = (overrides: Record<string, unknown> = {}) =>
    new TradingControlActionsService(prisma!, {
      preflight: { run: async () => preflightResult() },
      readAttestation: async () => passingAttestation(),
      environmentArmed: () => true,
      ...overrides,
    } as never);

  async function setProfile(isEnabled: boolean, killSwitchActive: boolean) {
    await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled } });
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { killSwitchActive },
    });
  }

  async function createExecution(status: string, requiresManualIntervention = false): Promise<string> {
    const row = await prisma!.tradeExecution.create({
      data: {
        executionProfileId: profileId,
        symbol: "TESTRUSDT",
        direction: "LONG",
        positionSide: "LONG",
        selectedLookback: 200,
        status: status as never,
        requiresManualIntervention,
        plannedEntryPrice: "100",
        calculatedStopLoss: "96",
        executableStopLoss: "96",
        riskBudgetUsd: "1.50",
        quantityRaw: "0.375",
        plannedQuantity: "0.375",
        quantityStepSize: "0.001",
        actualPlannedLoss: "1.5",
        unusedRiskBudget: "0",
        positionNotional: "37.5",
        targetIsolatedMargin: "3.75",
        maximumIsolatedMargin: "5.00",
        selectedLeverage: 10,
        estimatedInitialMargin: "3.75",
        liquidationBufferRatio: "0.5",
      },
    });
    return row.id;
  }

  beforeAll(async () => {
    const profile = await prisma!.executionProfile.create({
      data: { name: TEST_IDENTIFIER, accountIdentifier: TEST_IDENTIFIER, environment: "MAINNET", isEnabled: false },
    });
    profileId = profile.id;
    await prisma!.executionSafetyPolicy.create({
      data: { executionProfileId: profileId, killSwitchActive: true, allowedSymbols: ["COWUSDT"], ...REVIEWED_POLICY },
    });
  });

  afterEach(async () => {
    await prisma!.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
    const ids = (
      await prisma!.tradeExecution.findMany({ where: { executionProfileId: profileId }, select: { id: true } })
    ).map((row) => row.id);
    if (ids.length > 0) {
      await prisma!.executionEvent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma!.tradeExecution.deleteMany({ where: { id: { in: ids } } });
    }
    await setProfile(false, true);
  });

  afterAll(async () => {
    // Authorizations point AT their session (RESTRICT), so they go first.
    await prisma!.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
    const ids = (
      await prisma!.tradeExecution.findMany({ where: { executionProfileId: profileId }, select: { id: true } })
    ).map((row) => row.id);
    if (ids.length > 0) {
      await prisma!.executionEvent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma!.tradeExecution.deleteMany({ where: { id: { in: ids } } });
    }
    // Start Trading now opens a session beside the window, and both the session
    // and its slots reference the profile ON DELETE RESTRICT — so they come out
    // before the profile can. Without this the teardown aborts and the profile
    // survives into the next run as a unique-constraint collision.
    await prisma!.tradingSessionSlot.deleteMany({
      where: { tradingSession: { executionProfileId: profileId } },
    });
    await prisma!.tradingSession.deleteMany({ where: { executionProfileId: profileId } });
    await prisma!.executionSafetyPolicy.deleteMany({ where: { executionProfileId: profileId } });
    await prisma!.executionProfile.deleteMany({ where: { id: profileId } });
    await prisma!.$disconnect();
  });

  // --- START ---------------------------------------------------------------

  describe("start trading: the confirmation phrase", () => {
    it.each([
      ["absent", undefined],
      ["empty", ""],
      ["lowercase", "start trading"],
      ["padded", " START TRADING "],
      ["near miss", "START TRADIN"],
      ["a truthy object", { confirmation: "START TRADING" }],
      ["a boolean", true],
    ])("refuses a %s confirmation without touching anything", async (_label, confirmation) => {
      const result = await service().startTrading(confirmation);
      expect(result.ok).toBe(false);
      expect(result.blockers).toEqual(["CONFIRMATION_REQUIRED"]);
      // Nothing was created and the profile did not move.
      expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(0);
      const profile = await prisma!.executionProfile.findUniqueOrThrow({ where: { id: profileId } });
      expect(profile.isEnabled).toBe(false);
    });

    it("accepts only the exact phrase", async () => {
      const result = await service().startTrading(START_TRADING_CONFIRMATION);
      expect(result.ok).toBe(true);
    });
  });

  describe("start trading: it fails CLOSED on every interlock", () => {
    async function expectRefusedWithoutSideEffects(result: Awaited<ReturnType<ReturnType<typeof service>["startTrading"]>>) {
      expect(result.ok).toBe(false);
      expect(result.outcome).toBe("BLOCKED");
      // Never fabricates ARMED, and never leaves a window behind.
      expect(result.systemState).not.toBe("ARMED");
      expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(0);
      const profile = await prisma!.executionProfile.findUniqueOrThrow({
        where: { id: profileId },
        include: { safetyPolicy: true },
      });
      expect(`${profile.isEnabled}/${profile.safetyPolicy?.killSwitchActive}`).toBe("false/true");
    }

    it("refuses when runtime attestation is not passing", async () => {
      // The Phase 12.4D-A.1 interlock: this process's own env snapshot proves
      // nothing about what the RUNNING backend and worker loaded.
      const result = await service({ readAttestation: async () => failingAttestation() }).startTrading(
        START_TRADING_CONFIRMATION
      );
      await expectRefusedWithoutSideEffects(result);
      expect(result.blockers.join(" ")).toContain("RUNTIME_ATTESTATION_MISSING");
    });

    it("refuses when the environment activation gates are not armed", async () => {
      // The gates are environment variables. Nothing in this codebase writes
      // them, so a browser cannot arm a real-money account on its own.
      const result = await service({ environmentArmed: () => false }).startTrading(START_TRADING_CONFIRMATION);
      await expectRefusedWithoutSideEffects(result);
      expect(result.blockers.join(" ")).toContain("ENVIRONMENT_GATES_NOT_ARMED");
    });

    it("refuses when preparation readiness is blocked", async () => {
      const result = await service({
        preflight: {
          run: async () =>
            preflightResult({
              preparationBlockers: [
                { code: "CANARY_BLOCKED_INFRASTRUCTURE", scope: "PREPARATION", detail: "worker not detected" },
              ],
            }),
        },
      }).startTrading(START_TRADING_CONFIRMATION);
      await expectRefusedWithoutSideEffects(result);
      expect(result.blockers.join(" ")).toContain("CANARY_BLOCKED_INFRASTRUCTURE");
    });

    it("refuses when the policy dimension is blocked", async () => {
      // Arming resolves the kill switch, not the policy. A policy blocker is
      // one arming cannot clear, so it must stop the action.
      const result = await service({
        preflight: {
          run: async () =>
            preflightResult({
              liveActivationBlockers: [
                { code: "CANARY_BLOCKED_POLICY", scope: "LIVE_ACTIVATION", detail: "PROFILE_POLICY_MISMATCH" },
              ],
            }),
        },
      }).startTrading(START_TRADING_CONFIRMATION);
      await expectRefusedWithoutSideEffects(result);
      expect(result.blockers.join(" ")).toContain("CANARY_BLOCKED_POLICY");
    });

    it("does NOT treat the kill switch as a blocker, because arming is what releases it", async () => {
      // Demanding a fully READY verdict would be unsatisfiable: the profile kill
      // switch is itself a live-activation blocker.
      const result = await service({
        preflight: {
          run: async () =>
            preflightResult({
              liveActivationBlockers: [
                { code: "CANARY_BLOCKED_KILL_SWITCH_STATE", scope: "LIVE_ACTIVATION", detail: "engaged" },
                { code: "CANARY_BLOCKED_GATE_STATE", scope: "LIVE_ACTIVATION", detail: "live entry false" },
              ],
            }),
        },
      }).startTrading(START_TRADING_CONFIRMATION);
      expect(result.ok).toBe(true);
    });
  });

  describe("start trading: the reviewed first-live defaults", () => {
    it("opens LONG+SHORT for 60 minutes with a 5-claim budget", async () => {
      const result = await service().startTrading(START_TRADING_CONFIRMATION);
      expect(result.ok).toBe(true);

      const row = await prisma!.executionCanaryAuthorization.findFirstOrThrow({
        where: { executionProfileId: profileId },
      });
      expect(row.authorizationType).toBe("NATURAL_WINDOW");
      expect([...row.allowedDirections].sort()).toEqual(["LONG", "SHORT"]);
      expect(row.maxClaims).toBe(5);
      expect(row.claimedCount).toBe(0);
      const ttlMinutes = Math.round((row.expiresAt.getTime() - row.createdAt.getTime()) / 60000);
      expect(ttlMinutes).toBe(60);
      // And the exported constants are what the panel will advertise.
      expect(`${[...START_TRADING_DIRECTIONS].sort().join(",")}|${START_TRADING_TTL_MINUTES}|${START_TRADING_MAX_CLAIMS}`).toBe(
        "LONG,SHORT|60|5"
      );
    });

    it("keeps the supervised default inside the system TTL cap", () => {
      // The cap is the safety limit; the default is a choice made under it.
      // Raising the default past the cap must fail here, not at arming time.
      expect(START_TRADING_TTL_MINUTES).toBeLessThanOrEqual(MAXIMUM_AUTHORIZATION_TTL_MINUTES);
      expect(START_TRADING_TTL_MINUTES).toBeGreaterThan(0);
      // 24 hours since Phase 2. The window's TTL now bounds how long PERMISSION
      // lasts; how much trading it can produce is bounded by the session's
      // trade budget, which counts trades that actually obtained exposure.
      expect(MAXIMUM_AUTHORIZATION_TTL_MINUTES).toBe(24 * 60);
      expect(START_TRADING_MAX_CLAIMS).toBe(5);
    });

    it("arms the profile and spends no claim", async () => {
      const result = await service().startTrading(START_TRADING_CONFIRMATION);
      expect(`${result.outcome}/${result.systemState}`).toBe("ARMED/ARMED");
      expect(result.profile).toEqual({ environment: "MAINNET", isEnabled: true, killSwitchActive: false });
      expect(result.authorization?.claimedCount).toBe(0);
      expect(result.authorization?.remainingClaims).toBe(5);
    });

    it("never accepts symbols, limits or leverage from the caller", async () => {
      // Policy is server-side authority. The caller may supply the confirmation
      // phrase and a supervised duration from the reviewed set — and nothing
      // else. Neither is a symbol, a limit or a leverage.
      // Four now: confirmation, duration, trade budget and the unlimited flag.
      // Still nothing that names a symbol, a limit or a leverage — those remain
      // server-side authority, and the unlimited flag is a REQUEST the server
      // refuses unless it can itself prove the environment is non-live.
      expect(TradingControlActionsService.prototype.startTrading.length).toBe(4);
      const before = await prisma!.executionSafetyPolicy.findUniqueOrThrow({
        where: { executionProfileId: profileId },
      });
      await service().startTrading(START_TRADING_CONFIRMATION, 15);
      const after = await prisma!.executionSafetyPolicy.findUniqueOrThrow({
        where: { executionProfileId: profileId },
      });
      expect(after.allowedSymbols).toEqual(before.allowedSymbols);
      expect(after.maxTotalPlannedRiskUsd.toString()).toBe(before.maxTotalPlannedRiskUsd.toString());
      expect(after.maxTotalActiveTrades).toBe(before.maxTotalActiveTrades);
      // A caller-chosen duration still cannot buy extra claims.
      const window = await prisma!.executionCanaryAuthorization.findFirstOrThrow({
        where: { executionProfileId: profileId },
        orderBy: { createdAt: "desc" },
      });
      expect(window.maxClaims).toBe(5);
    });

    it("honours a chosen duration without letting it exceed the maximum", async () => {
      const result = await service().startTrading(START_TRADING_CONFIRMATION, 15);
      expect(result.ok).toBe(true);
      const window = await prisma!.executionCanaryAuthorization.findFirstOrThrow({
        where: { executionProfileId: profileId },
        orderBy: { createdAt: "desc" },
      });
      const minutes = Math.round((window.expiresAt.getTime() - window.createdAt.getTime()) / 60000);
      expect(minutes).toBe(15);
      expect(window.maxClaims).toBe(5);
    });

    it("REFUSES a duration outside the permitted range and creates no window", async () => {
      // 45, 61 and 1440 are now LEGAL: a custom duration is a Phase-2 feature,
      // bounded by the 24-hour ceiling rather than by an enumeration. What is
      // still refused is anything past that ceiling, and anything malformed.
      for (const bad of [1441, 2880, 0, -15, "60", null]) {
        const result = await service().startTrading(START_TRADING_CONFIRMATION, bad);
        expect(`${String(bad)}:${result.ok}`).toBe(`${String(bad)}:false`);
        expect(`${String(bad)}:${result.blockers[0]}`).toBe(`${String(bad)}:DURATION_INVALID`);
      }
      expect(
        await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })
      ).toBe(0);
    });
  });

  describe("start trading: repeated and concurrent requests", () => {
    it("cannot create two active windows from a double click", async () => {
      // The reviewed preparation exclusivity does the work; the route adds no
      // second concurrency mechanism of its own.
      const results = await Promise.all([
        service().startTrading(START_TRADING_CONFIRMATION),
        service().startTrading(START_TRADING_CONFIRMATION),
      ]);

      const windows = await prisma!.executionCanaryAuthorization.findMany({
        where: { executionProfileId: profileId },
      });
      const active = windows.filter((row) => row.revokedAt === null && row.consumedAt === null);
      expect(active.length).toBe(1);

      // Whatever the interleaving, the profile is never left in the
      // false/false combination no command commits.
      const profile = await prisma!.executionProfile.findUniqueOrThrow({
        where: { id: profileId },
        include: { safetyPolicy: true },
      });
      const legitimate =
        (profile.isEnabled === false && profile.safetyPolicy?.killSwitchActive === true) ||
        (profile.isEnabled === true && profile.safetyPolicy?.killSwitchActive === true) ||
        (profile.isEnabled === true && profile.safetyPolicy?.killSwitchActive === false);
      expect(legitimate).toBe(true);
      expect(results.some((result) => result.ok)).toBe(true);
    });

    it("reports ALREADY_ARMED rather than arming twice", async () => {
      await service().startTrading(START_TRADING_CONFIRMATION);
      const windows = await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } });
      const second = await service().startTrading(START_TRADING_CONFIRMATION);
      // The second attempt is refused by preparation exclusivity, not by
      // creating another window.
      expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(
        windows
      );
      expect(second.ok).toBe(false);
    });
  });

  // --- STOP NEW TRADES -----------------------------------------------------

  describe("stop new trades", () => {
    it("engages the kill switch and blocks new admission", async () => {
      await setProfile(true, false);
      const result = await service().stopNewTrades();

      expect(result.outcome).toBe("NEW_TRADES_BLOCKED");
      const profile = await prisma!.executionProfile.findUniqueOrThrow({
        where: { id: profileId },
        include: { safetyPolicy: true },
      });
      expect(profile.safetyPolicy?.killSwitchActive).toBe(true);
    });

    it("leaves the profile ENABLED so recovery keeps running", async () => {
      // This is the whole difference from Safe Off. Disabling the profile here
      // would strand a live position with no reconciliation.
      await setProfile(true, false);
      await createExecution("PROTECTED");
      await service().stopNewTrades();

      const profile = await prisma!.executionProfile.findUniqueOrThrow({
        where: { id: profileId },
        include: { safetyPolicy: true },
      });
      expect(`${profile.isEnabled}/${profile.safetyPolicy?.killSwitchActive}`).toBe("true/true");
    });

    it("cancels nothing and closes nothing", async () => {
      await setProfile(true, false);
      const executionId = await createExecution("PROTECTED");
      await service().stopNewTrades();

      const execution = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });
      // Untouched: no cancel, no market close, no status change.
      expect(execution.status).toBe("PROTECTED");
    });

    it("does not revoke authorizations — that is Safe Off's job", async () => {
      await service().startTrading(START_TRADING_CONFIRMATION);
      await service().stopNewTrades();
      const active = await prisma!.executionCanaryAuthorization.count({
        where: { executionProfileId: profileId, revokedAt: null },
      });
      expect(active).toBe(1);
    });

    it("reports outstanding work honestly", async () => {
      await setProfile(true, false);
      await createExecution("PROTECTED");
      const result = await service().stopNewTrades();
      expect(result.outstandingExecutions).toBe(1);
      expect(result.message).toContain("NOT cancelled");
    });
  });

  // --- SAFE OFF ------------------------------------------------------------

  describe("safe off", () => {
    it("returns a clean system to SAFE_OFF", async () => {
      await setProfile(true, false);
      const result = await service().safeOff();

      expect(`${result.outcome}/${result.systemState}`).toBe("SAFE_OFF/SAFE_OFF");
      expect(result.profile).toEqual({ environment: "MAINNET", isEnabled: false, killSwitchActive: true });
    });

    it("revokes the unused window", async () => {
      await service().startTrading(START_TRADING_CONFIRMATION);
      const result = await service().safeOff();

      expect(result.authorizationsRevoked).toBe(1);
      const remaining = await prisma!.executionCanaryAuthorization.count({
        where: { executionProfileId: profileId, revokedAt: null },
      });
      expect(remaining).toBe(0);
    });

    it("leaves the profile ENABLED when work is outstanding", async () => {
      // Never disable recovery beneath an open execution.
      await setProfile(true, false);
      await createExecution("PROTECTED");
      const result = await service().safeOff();

      expect(`${result.outcome}/${result.systemState}`).toBe("SAFE_RECOVERY/SAFE_RECOVERY");
      const profile = await prisma!.executionProfile.findUniqueOrThrow({
        where: { id: profileId },
        include: { safetyPolicy: true },
      });
      expect(`${profile.isEnabled}/${profile.safetyPolicy?.killSwitchActive}`).toBe("true/true");
    });

    it("treats a manual-intervention flag as outstanding work", async () => {
      await setProfile(true, false);
      await createExecution("CLOSED_TP", true);
      const result = await service().safeOff();
      expect(result.outcome).toBe("SAFE_RECOVERY");
    });

    it("engages the kill switch FIRST, so it holds even with work outstanding", async () => {
      await setProfile(true, false);
      await createExecution("ENTRY_FILLED");
      await service().safeOff();

      const profile = await prisma!.executionProfile.findUniqueOrThrow({
        where: { id: profileId },
        include: { safetyPolicy: true },
      });
      expect(profile.safetyPolicy?.killSwitchActive).toBe(true);
    });

    it("cancels nothing", async () => {
      await setProfile(true, false);
      const executionId = await createExecution("PROTECTED");
      await service().safeOff();
      const execution = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });
      expect(execution.status).toBe("PROTECTED");
    });
  });

  // --- Sanitization --------------------------------------------------------

  describe("operator actions: responses carry no secret", () => {
    it("returns no credential, hash or connection string from any action", async () => {
      const results = [
        await service().startTrading(START_TRADING_CONFIRMATION),
        await service().stopNewTrades(),
        await service().safeOff(),
        await service({ environmentArmed: () => false }).startTrading(START_TRADING_CONFIRMATION),
      ];
      const serialized = JSON.stringify(results);
      for (const forbidden of [
        "tokenHash",
        "apiKey",
        "apiSecret",
        "postgresql://",
        "redis://",
        "OPERATOR_API_TOKEN",
        TOKEN,
        // The account identifier stays server-side; environment is enough.
        TEST_IDENTIFIER,
      ]) {
        expect(`${forbidden}:${serialized.toLowerCase().includes(forbidden.toLowerCase())}`).toBe(`${forbidden}:false`);
      }
    });

    it("returns no raw Prisma row", async () => {
      const result = await service().startTrading(START_TRADING_CONFIRMATION);
      // The authorization is DESCRIBED, never passed through: an exact
      // authorization row carries a token hash.
      expect(Object.keys(result.authorization ?? {}).sort()).toEqual([
        "claimedCount",
        "expiresAt",
        "id",
        "maxClaims",
        "remainingClaims",
        "state",
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// Structural: one implementation, not two
// ---------------------------------------------------------------------------

describe("operator actions: structural guarantees", () => {
  const codeOf = (relative: string) =>
    readFileSync(path.join(process.cwd(), relative), "utf8")
      .split(/\r?\n/)
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");

  const actions = () => codeOf("src/modules/operator/trading-control-actions.service.ts");

  it("calls the reviewed operations instead of reimplementing them", () => {
    const code = actions();
    for (const expected of [
      "armNaturalWindow(",
      "closeCanaryWindowOperation(",
      "disarmCanaryOperation(",
      "prepareNaturalWindow(",
      "environmentIsArmed",
      "readRuntimeAttestationStatusOnce",
    ]) {
      expect(`${expected}:${code.includes(expected)}`).toBe(`${expected}:true`);
    }
  });

  it("takes no lock and runs no admission logic of its own", () => {
    // A second advisory lock, or a second claim, would be a second operator
    // state machine — precisely what this design exists to avoid.
    const code = actions();
    for (const forbidden of [
      "pg_advisory_xact_lock",
      "CANARY_PREPARE_LOCK_NAMESPACE",
      "profileLockKey",
      "claimNaturalWindow",
      "evaluateSafetyAdmission",
      "SafetyAdmissionService",
    ]) {
      expect(`${forbidden}:${code.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("never writes an environment variable or reaches the exchange", () => {
    const code = actions();
    for (const forbidden of ["process.env", "writeFile", "BinanceExecutionClient", "fetch(", "axios"]) {
      expect(`${forbidden}:${code.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("writes only the profile and policy fields the reviewed operations write", () => {
    // Every durable write lives in the extracted operations or in the
    // authorization service. This file performs none directly.
    const code = actions();
    for (const forbidden of [
      "executionProfile.update",
      "executionSafetyPolicy.update",
      "tradeExecution.update",
      "deleteMany",
      "$executeRaw",
    ]) {
      expect(`${forbidden}:${code.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("keeps CLOSE and DISARM as ONE implementation shared with the CLI", () => {
    // The CLI must delegate, not keep a copy. If either grows its own
    // transaction again, the two can drift.
    const cli = codeOf("src/modules/execution/run-canary-controls.ts");
    expect(cli).toContain("closeCanaryWindowOperation(");
    expect(cli).toContain("disarmCanaryOperation(");
    const shared = codeOf("src/modules/execution/operator-actions.ts");
    expect((shared.match(/pg_advisory_xact_lock/g) ?? []).length).toBe(2);
  });

  it("guards every mutation with the strict operator budget", () => {
    const routes = codeOf("src/routes/operator.routes.ts");
    const posts = (routes.match(/app\.post\(/g) ?? []).length;
    const budgets = (routes.match(/OPERATOR_ACTION_RATE_LIMIT\b/g) ?? []).length;
    // Nine now: the three trading actions, allowlist validate and save, the
    // source-timeframe policy save, the Extreme RR lookback save, and the two
    // policy-limit mutations. Enumerated rather than counted loosely, so a NEW
    // mutation cannot appear without this pin being updated deliberately.
    expect(posts).toBe(9);
    for (const path of [
      "/api/operator/trading-control/start",
      "/api/operator/trading-control/stop-new-trades",
      "/api/operator/trading-control/safe-off",
      "/api/operator/trading-control/allowlist/validate",
      "/api/operator/trading-control/allowlist",
      "/api/operator/trading-control/source-timeframes",
      "/api/operator/trading-control/rr-lookback",
      "/api/operator/trading-control/policy/validate",
      "/api/operator/trading-control/policy",
    ]) {
      expect(`${path}:${routes.includes(path)}`).toBe(`${path}:true`);
    }
    // One declaration plus one spread per route: a POST that forgot the budget
    // would drop the count.
    expect(budgets).toBeGreaterThanOrEqual(posts + 1);
    expect(routes).toContain("env.OPERATOR_ACTION_RATE_LIMIT_MAX");
  });

  it("budgets mutations far below the dashboard read limit", async () => {
    const { env } = await import("../src/config/env");
    // Not a magic number: a human clicks these a handful of times an hour, and
    // anything larger is capacity only an attacker needs.
    expect(env.OPERATOR_ACTION_RATE_LIMIT_MAX).toBeLessThanOrEqual(20);
    expect(env.OPERATOR_ACTION_RATE_LIMIT_MAX).toBeLessThan(env.DASHBOARD_RATE_LIMIT_MAX);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
