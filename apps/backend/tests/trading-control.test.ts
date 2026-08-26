import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * The READ-ONLY Trading Control panel feed.
 *
 * Two things are being guarded here. The first is the auth boundary: these
 * routes expose the whole safety posture of a real-money account, so an
 * unauthenticated caller must learn nothing at all. The second is honesty: the
 * panel must report what the authoritative services concluded, never a second
 * opinion computed in the presentation layer, and it must not quietly render an
 * unreadable profile as a safe one.
 *
 * Nothing here reaches Binance. The preflight runner and the attestation reader
 * are both injected, so a suite run can never place a signed request against the
 * live account.
 */

const TOKEN = "operator-test-token-0123456789abcdef";
const TEST_IDENTIFIER = "phase11-trading-control";

process.env.OPERATOR_API_TOKEN = TOKEN;
process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = TEST_IDENTIFIER;
process.env.EXECUTION_PROFILE_ENVIRONMENT = "MAINNET";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const describeDb = available && prisma ? describe : describe.skip;

const {
  TradingControlService,
  mapTradingSystemState,
  buildWarnings,
  describeReadiness,
} = await import("../src/modules/operator/trading-control.service");
const { operatorRoutes } = await import("../src/routes/operator.routes");
const { AppError } = await import("../src/utils/errors");

type Finding = { code: string; scope: string; detail: string };

/** A preflight verdict with nothing blocking, which each test narrows. */
function preflightResult(overrides: {
  preparationBlockers?: Finding[];
  liveActivationBlockers?: Finding[];
  summary?: string;
  gates?: Partial<Record<string, unknown>>;
  policyProfile?: Record<string, unknown> | null;
} = {}) {
  const preparationBlockers = overrides.preparationBlockers ?? [];
  const liveActivationBlockers = overrides.liveActivationBlockers ?? [];
  const limits = {
    maxOpenPositions: 5,
    maxPendingEntries: 5,
    maxTotalActiveTrades: 5,
    maxActivePerSymbolSide: 1,
    softOpenPositionTarget: 3,
    maxTotalPlannedRiskUsd: "7.50",
    maxTotalIsolatedMarginUsd: "40.00",
  };
  return {
    ready: preparationBlockers.length === 0 && liveActivationBlockers.length === 0,
    preparationReady: preparationBlockers.length === 0,
    findings: [...preparationBlockers, ...liveActivationBlockers],
    preparationBlockers,
    liveActivationBlockers,
    summary: overrides.summary ?? "CANARY_READY",
    gathered: {
      infrastructure: {
        databaseReady: true,
        redisReady: true,
        executionWorkerReady: true,
        notificationSchedulerReady: true,
        executionOrchestrationWired: true,
      },
      binance: {
        connected: true,
        signedRequestWorks: true,
        consecutiveSignedSuccesses: 3,
        requiredConsecutiveSuccesses: 3,
        authenticationFailed: false,
        ipRestricted: false,
        positionMode: "HEDGE",
        assetMode: "SINGLE_ASSET",
        nonZeroPositionCount: 0,
        openOrderCount: 0,
      },
      local: { activeExecutionCount: 0, pendingEntryCount: 0, openPositionCount: 0, recoveryRequiredCount: 0 },
      policy: {
        global: limits,
        profile: overrides.policyProfile === undefined ? limits : overrides.policyProfile,
      },
      authorization: {
        mode: "NATURAL_WINDOW",
        available: true,
        exactPrepared: false,
        naturalState: null,
        naturalAllowedDirections: [],
        naturalMaxClaims: null,
        naturalClaimedCount: null,
      },
      gates: {
        globalKillSwitch: true,
        profileKillSwitchEngaged: true,
        liveEntryEnabled: false,
        protectionReady: false,
        accountSetupMutationsEnabled: false,
        testOrderEnabled: false,
        autoAddMarginEnabled: false,
        emergencyCloseMode: "DISABLED",
        ...overrides.gates,
      },
    },
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

// ---------------------------------------------------------------------------
// The locked state model
// ---------------------------------------------------------------------------

describe("trading control: the locked state model", () => {
  it.each([
    [false, true, "SAFE_OFF"],
    [true, false, "ARMED"],
    [true, true, "SAFE_RECOVERY"],
    [false, false, "INVALID"],
  ])("isEnabled=%s killSwitchActive=%s -> %s", (isEnabled, killSwitch, expected) => {
    expect(mapTradingSystemState(isEnabled, killSwitch)).toBe(expected);
  });

  it("never renders an unreadable profile as a safe one", () => {
    // "We could not tell" and "it is off" are different facts. Collapsing the
    // first into the second is how a dashboard reassures an operator about a
    // system it cannot actually see.
    for (const [enabled, kill] of [
      [null, null],
      [null, true],
      [false, null],
      [undefined, undefined],
    ] as const) {
      expect(mapTradingSystemState(enabled, kill)).toBe("UNKNOWN");
    }
  });
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

describe("trading control: readiness separates preparation from live activation", () => {
  it("reports a SAFE production system as prepared but not live-activatable", () => {
    // The everyday production reading: everything is built and pinned, and the
    // gates are deliberately shut. "Preparation READY / Live Activation
    // BLOCKED" is the correct answer, not a failure.
    const live: Finding[] = [
      { code: "CANARY_BLOCKED_KILL_SWITCH_STATE", scope: "LIVE_ACTIVATION", detail: "kill switch engaged" },
      { code: "CANARY_BLOCKED_GATE_STATE", scope: "LIVE_ACTIVATION", detail: "live entry false" },
    ];
    const described = describeReadiness(preflightResult({ liveActivationBlockers: live, summary: "CANARY_BLOCKED_GATE_STATE" }));
    expect(`${described.preparationReady}/${described.liveActivationReady}`).toBe("true/false");
    expect(described.liveActivationBlockers).toHaveLength(2);
    expect(described.preparationBlockers).toEqual([]);
  });

  it("passes preparation blockers through verbatim", () => {
    // The panel must print the blocker the CLI prints. Rewording it in the
    // browser produces two vocabularies for one safety condition.
    const prep: Finding[] = [
      { code: "CANARY_BLOCKED_POLICY", scope: "PREPARATION", detail: "PROFILE_POLICY_MISMATCH: maxOpenPositions" },
    ];
    const described = describeReadiness(preflightResult({ preparationBlockers: prep, summary: "CANARY_BLOCKED_POLICY" }));
    expect(described.preparationReady).toBe(false);
    expect(described.preparationBlockers[0].detail).toBe("PROFILE_POLICY_MISMATCH: maxOpenPositions");
  });
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

describe("trading control: warnings mirror existing authority", () => {
  const base = {
    systemState: "SAFE_OFF" as const,
    attestation: { status: "PASS" as const, reasonCode: null, message: null, backendCount: 1, workerCount: 1 },
    manualCount: 0,
    unprotectedCount: 0,
    capacity: { pending: 0, open: 0, totalActive: 0, desiredOpen: 3, hardTotal: 5 },
    authorizationState: null,
  };

  it("is silent when a SAFE system has nothing wrong with it", () => {
    expect(buildWarnings(base)).toEqual([]);
  });

  it.each([
    ["INVALID_STATE", { ...base, systemState: "INVALID" as const }],
    ["STATE_UNKNOWN", { ...base, systemState: "UNKNOWN" as const }],
    [
      "RUNTIME_ATTESTATION_BLOCKED",
      { ...base, attestation: { ...base.attestation, status: "BLOCKED" as const, message: "stale" } },
    ],
    ["MANUAL_INTERVENTION_REQUIRED", { ...base, manualCount: 2 }],
    ["FILLED_WITHOUT_VERIFIED_PROTECTION", { ...base, unprotectedCount: 1 }],
    ["CAPACITY_EXHAUSTED", { ...base, capacity: { ...base.capacity, totalActive: 5 } }],
    ["NATURAL_AUTHORIZATION_EXPIRED", { ...base, authorizationState: "EXPIRED" }],
  ])("raises %s", (code, input) => {
    expect(buildWarnings(input).map((w) => w.code)).toContain(code);
  });

  it("treats an unavailable attestation as blocked, not as passing", () => {
    const warnings = buildWarnings({
      ...base,
      attestation: { status: "UNAVAILABLE", reasonCode: "RUNTIME_ATTESTATION_UNAVAILABLE", message: null, backendCount: 0, workerCount: 0 },
    });
    expect(warnings.map((w) => w.code)).toContain("RUNTIME_ATTESTATION_BLOCKED");
  });
});

// ---------------------------------------------------------------------------
// The HTTP boundary
// ---------------------------------------------------------------------------

describe("trading control: the routes are behind the operator guard", () => {
  const paths = ["/api/operator/trading-control/status", "/api/operator/trading-control/readiness"];
  let app: FastifyInstance;
  let calls = 0;

  beforeAll(async () => {
    app = Fastify();
    app.decorate("prisma", {} as PrismaClient);
    await app.register(operatorRoutes, {
      tradingControlFactory: () => ({
        readStatus: async () => {
          calls += 1;
          return { systemState: "SAFE_OFF" };
        },
        readReadiness: async () => {
          calls += 1;
          return { preparationReady: true, liveActivationReady: false };
        },
      }),
    });
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

  it.each(paths)("refuses %s without a token", async (url) => {
    const before = calls;
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(401);
    // The refusal must happen BEFORE any work: an unauthenticated caller must
    // not be able to make the server read the account's safety posture at all.
    expect(calls).toBe(before);
  });

  it.each(paths)("refuses %s with a wrong token", async (url) => {
    const response = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${TOKEN}x` } });
    expect(response.statusCode).toBe(401);
  });

  it.each(paths)("serves %s with a valid token", async (url) => {
    const response = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.statusCode).toBe(200);
  });

  it("refuses an unrecognised mode rather than answering a different question", async () => {
    // Same failure the preflight CLI's `--mode=natrual` bug produced: a
    // confident verdict about a mode nobody asked about.
    const response = await app.inject({
      method: "GET",
      url: "/api/operator/trading-control/readiness?mode=natrual",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // 422 is this repo's ValidationError status, the same one every other
    // rejected query parameter returns.
    expect(response.statusCode).toBe(422);
  });

  it("accepts the two real modes and defaults to NATURAL_WINDOW", async () => {
    for (const query of ["", "?mode=NATURAL_WINDOW", "?mode=EXACT_SIGNAL"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/operator/trading-control/readiness${query}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(`${query}:${response.statusCode}`).toBe(`${query}:200`);
    }
  });
});

// ---------------------------------------------------------------------------
// The full status read, against the TEST database
// ---------------------------------------------------------------------------

describeDb("trading control: the status snapshot", () => {
  let profileId = "";

  const service = (options: Parameters<typeof TradingControlService.prototype.readStatus> extends never ? never : {
    preflight?: unknown;
    readAttestation?: unknown;
    now?: () => Date;
  } = {}) =>
    new TradingControlService(prisma!, {
      preflight: { run: async () => preflightResult() },
      readAttestation: async () => passingAttestation(),
      ...(options as object),
    } as never);

  async function setProfile(isEnabled: boolean, killSwitchActive: boolean) {
    await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled } });
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { killSwitchActive },
    });
  }

  beforeAll(async () => {
    const profile = await prisma!.executionProfile.create({
      data: { name: TEST_IDENTIFIER, accountIdentifier: TEST_IDENTIFIER, environment: "MAINNET", isEnabled: false },
    });
    profileId = profile.id;
    await prisma!.executionSafetyPolicy.create({
      data: {
        executionProfileId: profileId,
        killSwitchActive: true,
        allowedSymbols: ["COWUSDT"],
        maxOpenPositions: 5,
        maxPendingEntries: 5,
        maxTotalActiveTrades: 5,
        maxActivePerSymbolSide: 1,
        softOpenPositionTarget: 3,
        maxTotalPlannedRiskUsd: "7.50",
        maxTotalIsolatedMarginUsd: "40.00",
      },
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
    await prisma!.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
    const ids = (
      await prisma!.tradeExecution.findMany({ where: { executionProfileId: profileId }, select: { id: true } })
    ).map((row) => row.id);
    if (ids.length > 0) {
      await prisma!.executionEvent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma!.tradeExecution.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma!.executionSafetyPolicy.deleteMany({ where: { executionProfileId: profileId } });
    await prisma!.executionProfile.deleteMany({ where: { id: profileId } });
    await prisma!.$disconnect();
  });

  it.each([
    [false, true, "SAFE_OFF"],
    [true, false, "ARMED"],
    [true, true, "SAFE_RECOVERY"],
    [false, false, "INVALID"],
  ])("reports isEnabled=%s killSwitch=%s as %s end to end", async (isEnabled, killSwitch, expected) => {
    await setProfile(isEnabled, killSwitch);
    const status = await service().readStatus();
    expect(status.systemState).toBe(expected);
    expect(`${status.profile?.isEnabled}/${status.profile?.killSwitchActive}`).toBe(`${isEnabled}/${killSwitch}`);
  });

  it("raises the INVALID warning on the combination no command commits", async () => {
    await setProfile(false, false);
    const status = await service().readStatus();
    expect(status.warnings.map((w) => w.code)).toContain("INVALID_STATE");
  });

  it("reports the profile's allowed symbols", async () => {
    const status = await service().readStatus();
    expect(status.allowedSymbols).toEqual(["COWUSDT"]);
  });

  it("describes the natural window's TTL and claims", async () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        allowedDirections: ["LONG", "SHORT"],
        maxClaims: 5,
        claimedCount: 2,
        expiresAt: new Date(now.getTime() + 600_000),
      },
    });

    const status = await service({ now: () => now }).readStatus();
    expect(status.authorization).toEqual({
      state: "AVAILABLE",
      expiresAt: new Date(now.getTime() + 600_000).toISOString(),
      remainingTtlSeconds: 600,
      maxClaims: 5,
      claimedCount: 2,
      remainingClaims: 3,
    });
  });

  it("floors an expired window's countdown at zero and warns", async () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        allowedDirections: ["LONG"],
        maxClaims: 5,
        claimedCount: 0,
        expiresAt: new Date(now.getTime() - 60_000),
      },
    });

    const status = await service({ now: () => now }).readStatus();
    // A negative countdown is noise; EXPIRED already carries the meaning.
    expect(`${status.authorization?.state}:${status.authorization?.remainingTtlSeconds}`).toBe("EXPIRED:0");
    expect(status.warnings.map((w) => w.code)).toContain("NATURAL_AUTHORIZATION_EXPIRED");
  });

  it("counts capacity and reservations from the shared status groups", async () => {
    // PROTECTED consumes an open slot, ENTRY_PENDING a pending one, and both
    // count toward total active. CLOSED_TP consumes nothing at all.
    await createExecution("PROTECTED", "1.50", "4.00");
    await createExecution("ENTRY_PENDING", "1.25", "3.00");
    await createExecution("CLOSED_TP", "9.99", "99.00");

    const status = await service().readStatus();
    // desiredOpen is 1, not the profile row's 3: `tests/setup.ts` pins
    // EXECUTION_SOFT_OPEN_POSITION_TARGET to 1, so the env is the STRICTER side
    // and the min-merge correctly takes it. Reading 3 here would mean the panel
    // had stopped merging and started trusting the row alone.
    // maxOpen/maxPending are the same EFFECTIVE merge as hardTotal, exposed so
    // the panel can show each count against the limit that governs it rather
    // than borrowing the total-active one.
    expect(status.capacity).toEqual({
      pending: 1,
      open: 1,
      totalActive: 2,
      desiredOpen: 1,
      hardTotal: 5,
      maxOpen: 5,
      maxPending: 5,
    });
    // The limits are the EFFECTIVE merge of the env and the profile row, and
    // the row is the side that wins ties, so they stringify exactly as the CLI
    // preflight prints them ("profile 7.5 / effective 7.5" against a global
    // "7.50"). Reformatting them here would put a second spelling of the same
    // ceiling in front of the operator.
    expect(status.reservations).toEqual({
      riskUsd: "2.75",
      riskLimitUsd: "7.5",
      marginUsd: "7",
      marginLimitUsd: "40",
    });
  });

  it("warns when a filled position is not yet verified protected", async () => {
    await createExecution("ENTRY_FILLED", "1.50", "4.00");
    const status = await service().readStatus();
    expect(status.warnings.map((w) => w.code)).toContain("FILLED_WITHOUT_VERIFIED_PROTECTION");
  });

  it("warns on manual intervention and counts it", async () => {
    await createExecution("MANUAL_INTERVENTION", "1.50", "4.00");
    const status = await service().readStatus();
    expect(status.manualIntervention).toEqual({ present: true, count: 1 });
    expect(status.warnings.map((w) => w.code)).toContain("MANUAL_INTERVENTION_REQUIRED");
  });

  it("warns when total active capacity is exhausted", async () => {
    for (let i = 0; i < 5; i += 1) await createExecution("PROTECTED", "0.10", "1.00");
    const status = await service().readStatus();
    expect(status.warnings.map((w) => w.code)).toContain("CAPACITY_EXHAUSTED");
  });

  it("reports the most recently updated execution", async () => {
    await createExecution("CLOSED_TP", "1.00", "2.00", "COWUSDT");
    const latest = await createExecution("PROTECTED", "1.00", "2.00", "COWUSDT");
    await prisma!.tradeExecution.update({ where: { id: latest }, data: { decisionReasonCode: "PASS" } });

    const status = await service().readStatus();
    expect(status.latestExecution?.status).toBe("PROTECTED");
    expect(status.latestExecution?.reason).toBe("PASS");
    expect(status.latestExecution?.symbol).toBe("COWUSDT");
  });

  it("carries the context the panel needs to EXPLAIN a refusal", async () => {
    // The panel says "Source timeframe 1D is not allowed". It can only name the
    // timeframe if the timeframe travels with the row; without it the copy would
    // have to state the rule without its subject.
    const id = await createExecution("SKIPPED", "1.00", "2.00", "COWUSDT");
    await prisma!.tradeExecution.update({
      where: { id },
      data: { decisionReasonCode: "SOURCE_TIMEFRAME_NOT_ALLOWED", sourceTimeframe: "1D" },
    });

    const status = await service().readStatus();
    expect(status.latestExecution?.reason).toBe("SOURCE_TIMEFRAME_NOT_ALLOWED");
    expect(status.latestExecution?.sourceTimeframe).toBe("1D");
    // The freshness limit travels as POLICY, beside the source timeframes and
    // the lookback — not inside one execution, so the panel can still show it
    // when nothing has executed yet.
    expect(status.alertAgeLimitSeconds).toBeGreaterThan(0);
  });

  it("reports a null source timeframe honestly rather than inventing one", async () => {
    const id = await createExecution("SKIPPED", "1.00", "2.00", "COWUSDT");
    await prisma!.tradeExecution.update({
      where: { id },
      data: { decisionReasonCode: "ALERT_STALE", sourceTimeframe: null },
    });

    const status = await service().readStatus();
    expect(status.latestExecution?.sourceTimeframe).toBeNull();
  });

  it("adds READ-ONLY presentation fields only — no new decision or account data", async () => {
    // The enrichment exists so the panel can word an outcome it already shows.
    // It must not become a channel for anything else: no order ids, no prices,
    // no quantities, no balances, no credentials.
    const id = await createExecution("SKIPPED", "1.00", "2.00", "COWUSDT");
    await prisma!.tradeExecution.update({ where: { id }, data: { decisionReasonCode: "ALERT_STALE" } });

    const status = await service().readStatus();
    expect(Object.keys(status.latestExecution ?? {}).sort()).toEqual([
      "direction",
      "reason",
      "sourceTimeframe",
      "status",
      "symbol",
      "updatedAt",
    ]);
  });

  it("degrades to UNAVAILABLE rather than failing when attestation cannot be read", async () => {
    // An operator staring at this panel because something is wrong is exactly
    // who must not be shown a blank page.
    const status = await service({
      readAttestation: async () => {
        throw new Error("redis://user:password@host:6379 unreachable");
      },
    }).readStatus();
    expect(status.runtimeAttestation.status).toBe("UNAVAILABLE");
    // And the connection string in that error must not travel to the browser.
    expect(JSON.stringify(status)).not.toContain("password");
  });

  it("carries the attestation role counts", async () => {
    const status = await service().readStatus();
    expect(`${status.runtimeAttestation.status}:${status.runtimeAttestation.backendCount}:${status.runtimeAttestation.workerCount}`).toBe(
      "PASS:1:1"
    );
  });

  it("returns no secret of any kind", async () => {
    await createExecution("PROTECTED", "1.50", "4.00");
    await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        allowedDirections: ["LONG"],
        maxClaims: 5,
        claimedCount: 0,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    const serialized = JSON.stringify(await service().readStatus());
    for (const forbidden of [
      "tokenHash",
      "token",
      "secret",
      "apiKey",
      "apiSecret",
      "DATABASE_URL",
      "postgresql://",
      "redis://",
      // The account identifier is deliberately withheld: environment is all the
      // panel needs, and naming the account adds risk without adding meaning.
      TEST_IDENTIFIER,
    ]) {
      expect(`${forbidden}:${serialized.toLowerCase().includes(forbidden.toLowerCase())}`).toBe(`${forbidden}:false`);
    }
  });

  async function createExecution(
    status: string,
    riskBudgetUsd: string,
    maximumIsolatedMargin: string,
    symbol = "TESTRUSDT"
  ): Promise<string> {
    const row = await prisma!.tradeExecution.create({
      data: {
        executionProfileId: profileId,
        symbol,
        direction: "LONG",
        positionSide: "LONG",
        selectedLookback: 200,
        status: status as never,
        plannedEntryPrice: "100",
        calculatedStopLoss: "96",
        executableStopLoss: "96",
        riskBudgetUsd,
        quantityRaw: "0.375",
        plannedQuantity: "0.375",
        quantityStepSize: "0.001",
        actualPlannedLoss: riskBudgetUsd,
        unusedRiskBudget: "0",
        positionNotional: "37.5",
        targetIsolatedMargin: maximumIsolatedMargin,
        maximumIsolatedMargin,
        selectedLeverage: 10,
        estimatedInitialMargin: maximumIsolatedMargin,
        liquidationBufferRatio: "0.5",
      },
    });
    return row.id;
  }
});

// ---------------------------------------------------------------------------
// The status / readiness cost boundary
// ---------------------------------------------------------------------------

describeDb("trading control: the polled path never runs a preflight", () => {
  let profileId = "";
  let preflightRuns = 0;

  /**
   * A preflight runner that records every call and refuses to be cheap about
   * it. The real one performs three signed reads of the live account, so any
   * invocation from the polled path is a defect regardless of what it returns.
   */
  const countingPreflight = {
    run: async () => {
      preflightRuns += 1;
      return preflightResult();
    },
  };

  const service = () =>
    new TradingControlService(prisma!, {
      preflight: countingPreflight,
      readAttestation: async () => passingAttestation(),
    } as never);

  beforeAll(async () => {
    const profile = await prisma!.executionProfile.create({
      data: {
        name: `${TEST_IDENTIFIER}-cost`,
        accountIdentifier: TEST_IDENTIFIER,
        environment: "MAINNET",
        isEnabled: false,
      },
    });
    profileId = profile.id;
    await prisma!.executionSafetyPolicy.create({
      data: {
        executionProfileId: profileId,
        killSwitchActive: true,
        allowedSymbols: ["COWUSDT"],
        maxOpenPositions: 5,
        maxPendingEntries: 5,
        maxTotalActiveTrades: 5,
        maxActivePerSymbolSide: 1,
        softOpenPositionTarget: 3,
        maxTotalPlannedRiskUsd: "7.50",
        maxTotalIsolatedMarginUsd: "40.00",
      },
    });
  });

  afterAll(async () => {
    await prisma!.executionSafetyPolicy.deleteMany({ where: { executionProfileId: profileId } });
    await prisma!.executionProfile.deleteMany({ where: { id: profileId } });
  });

  it("runs ZERO preflights across many polls", async () => {
    // The whole point of the split. Fifteen-second polling multiplied by every
    // open browser tab must not become a standing load of signed requests
    // against a real-money account.
    preflightRuns = 0;
    for (let poll = 0; poll < 10; poll += 1) await service().readStatus();
    expect(preflightRuns).toBe(0);
  });

  it("still reports the full operational picture without one", async () => {
    // The cheap path must not have been made cheap by dropping fields.
    const status = await service().readStatus();
    for (const key of [
      "systemState",
      "profile",
      "environmentGates",
      "runtimeAttestation",
      "allowedSymbols",
      "authorization",
      "capacity",
      "reservations",
      "latestExecution",
      "manualIntervention",
      "warnings",
    ]) {
      expect(`${key}:${key in status}`).toBe(`${key}:true`);
    }
    expect(status.capacity.hardTotal).toBe(5);
    expect(status.reservations.riskLimitUsd).toBe("7.5");
    expect(status.allowedSymbols).toEqual(["COWUSDT"]);
  });

  it("carries no readiness verdict at all", async () => {
    // Readiness is the answer to a question the operator asked. The poll must
    // not fabricate one, and must not carry a stale one either.
    const status = await service().readStatus();
    expect("readiness" in status).toBe(false);
  });

  it("runs EXACTLY one preflight per explicit readiness check", async () => {
    preflightRuns = 0;
    await service().readReadiness();
    expect(preflightRuns).toBe(1);
    await service().readReadiness();
    expect(preflightRuns).toBe(2);
  });

  it("returns the evaluator's own verdict from the readiness check", async () => {
    const readiness = await service().readReadiness();
    expect(readiness.preparationReady).toBe(true);
    expect(readiness.liveActivationReady).toBe(true);
    expect(readiness.mode).toBe("NATURAL_WINDOW");
  });

  it("still enforces the effective policy merge without the preflight", async () => {
    // The profile row is the stricter side here, so the merge must return ITS
    // ceiling and not the env-wide one.
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { maxTotalActiveTrades: 2, maxTotalPlannedRiskUsd: "3.00" },
    });
    const status = await service().readStatus();
    expect(`${status.capacity.hardTotal}:${status.reservations.riskLimitUsd}`).toBe("2:3");
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { maxTotalActiveTrades: 5, maxTotalPlannedRiskUsd: "7.50" },
    });
  });
});

// ---------------------------------------------------------------------------
// Structural
// ---------------------------------------------------------------------------

describe("trading control: structural guarantees", () => {
  const codeOf = (relative: string) =>
    readFileSync(path.join(process.cwd(), relative), "utf8")
      .split(/\r?\n/)
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");

  it("keeps the READ surface read-only and fully guarded", () => {
    const code = codeOf("src/routes/operator.routes.ts");
    const routes = code.match(/app\.(get|post|put|patch|delete)\(/g) ?? [];
    const guards = code.match(/preHandler: requireOperatorAuth/g) ?? [];
    // Twelve now: the source-timeframe policy and the Extreme RR lookback each
    // add one guarded GET (read stays available while armed, so the operator
    // can always SEE what governs a live system) and one guarded POST (refused
    // unless SAFE_OFF and quiet).
    expect(`routes:${routes.length} guards:${guards.length}`).toBe(`routes:12 guards:12`);
    // Three GETs (probe, status, readiness) and five POSTs (the three
    // trading actions plus allowlist validate and save). The READ surface is
    // unchanged; no PUT/PATCH/DELETE exists at all.
    expect((code.match(/app\.get\(/g) ?? []).length).toBe(5);
    expect((code.match(/app\.post\(/g) ?? []).length).toBe(7);
    expect(code.match(/app\.(put|patch|delete)\(/g)).toBeNull();
  });

  it("writes nothing from the trading-control service", () => {
    // Read-only is a property of this file, not a promise in its header.
    const code = codeOf("src/modules/operator/trading-control.service.ts");
    for (const forbidden of [
      ".create(",
      ".update(",
      ".upsert(",
      ".delete(",
      ".createMany(",
      ".updateMany(",
      ".deleteMany(",
      "$executeRaw",
      "$transaction",
      // The terms on which this file is allowed to touch the natural domain at
      // all: it may describe a window, never spend one.
      "claimNaturalWindow",
      "prepareNaturalWindow",
      "revokeNaturalWindow",
      "armNaturalWindow",
    ]) {
      expect(`${forbidden}:${code.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("reuses the authoritative evaluators instead of re-deriving them", () => {
    const code = codeOf("src/modules/operator/trading-control.service.ts");
    // The one min-merge admission uses, the shared capacity status groups, the
    // natural-window describer, and the preflight evaluator.
    for (const expected of [
      "mergeCapacityLimits",
      "TOTAL_ACTIVE_STATUSES",
      "OPEN_POSITION_STATUSES",
      "PENDING_ENTRY_STATUSES",
      "describeNaturalWindow",
      "CanaryPreflightService",
    ]) {
      expect(`${expected}:${code.includes(expected)}`).toBe(`${expected}:true`);
    }
  });

  it("confines the preflight to the explicit readiness path", () => {
    // Structural, not behavioural: the polled method must not even be able to
    // reach the evaluator that performs signed exchange reads.
    const source = readFileSync(
      path.join(process.cwd(), "src/modules/operator/trading-control.service.ts"),
      "utf8"
    );
    const readStatusBody = source.slice(source.indexOf("async readStatus("));
    expect(readStatusBody).not.toContain("this.preflight.run(");

    const code = codeOf("src/modules/operator/trading-control.service.ts");
    expect((code.match(/this\.preflight\.run\(/g) ?? []).length).toBe(1);
  });

  it("keeps the polled status route free of a mode parameter", () => {
    // Mode is a readiness concept. A status route that accepted one would be
    // implying it answers a question it does not ask.
    const code = codeOf("src/routes/operator.routes.ts");
    const statusHandler = code.slice(code.indexOf("trading-control/status"));
    expect(statusHandler.slice(0, statusHandler.indexOf("});"))).toContain("readStatus()");
  });

  it("never returns the account identifier", () => {
    const code = codeOf("src/modules/operator/trading-control.service.ts");
    expect(code).not.toContain("accountIdentifier");
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
