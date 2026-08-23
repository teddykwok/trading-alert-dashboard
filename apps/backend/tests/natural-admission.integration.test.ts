import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";
import type { DynamicLeveragePlan } from "@trading-alert-dashboard/shared";

/**
 * Phase 12.3 — NATURAL_WINDOW authorization inside the REAL SafetyAdmission
 * transaction, against a real Postgres.
 *
 * The properties here cannot be proven against a mock: they are about a claim
 * and a capacity reservation committing or rolling back TOGETHER, under the
 * per-profile advisory lock, with genuinely concurrent contenders. Every row is
 * synthetic and removed in afterAll; Binance is a read-only stub and no network
 * call is made anywhere in this file.
 */

const TAG = "phase12c-natural-admission";

/**
 * Env is the OUTER bound of the min-merge, so it is set permissively here and
 * each test pins the real limit on its own policy ROW. Anything left to the
 * operator's `.env` would make these tests pass or fail by accident.
 *
 * Set before `config/env` is imported below, which is why every service arrives
 * through a dynamic import.
 */
process.env.EXECUTION_GLOBAL_KILL_SWITCH = "false";
process.env.EXECUTION_MAX_OPEN_POSITIONS = "5";
process.env.EXECUTION_SOFT_OPEN_POSITION_TARGET = "5";
process.env.EXECUTION_MAX_PENDING_ENTRIES = "5";
process.env.EXECUTION_MAX_TOTAL_ACTIVE_TRADES = "5";
process.env.EXECUTION_MAX_TOTAL_PLANNED_RISK_USD = "100.00";
process.env.EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD = "500.00";
process.env.EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE = "1";
process.env.EXECUTION_MAX_ALERT_AGE_SECONDS = "300";
process.env.BINANCE_FUTURES_REST_BASE_URL = "https://testnet.binancefuture.com";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ExecutionService } = await import("../src/modules/execution/execution.service");
const { SafetyAdmissionService } = await import("../src/modules/execution/safety-admission.service");
const { SafetyPolicyService } = await import("../src/modules/execution/safety-policy.service");
const { CanaryAuthorizationService } = await import("../src/modules/execution/canary-authorization.service");

type ExecutionServiceType = InstanceType<typeof ExecutionService>;
type SafetyAdmissionServiceType = InstanceType<typeof SafetyAdmissionService>;

// ---------------------------------------------------------------------------
// Read-only Binance stub — GET-shaped data only. No network, no credentials.
// ---------------------------------------------------------------------------

const readOnlyStub = {
  async getAccountSummary() {
    return {
      connection: { ok: true, host: "testnet", serverTimeMs: Date.now(), serverTimeIso: "", clockOffsetMs: 0, roundTripMs: 1 },
      positionMode: "HEDGE",
      assetMode: "SINGLE_ASSET",
      usdtWalletBalance: "5000.00",
      usdtAvailableBalance: "5000.00",
      nonZeroPositionCount: 0,
      openOrderCount: 0,
      openOrderSymbols: [] as string[],
      positions: [] as Array<{ symbol: string }>,
      warnings: [],
    };
  },
  async inspectSymbol(symbol: string) {
    return {
      filters: { symbol, status: "TRADING", contractType: "PERPETUAL", tickSize: "0.01", stepSize: "0.001" },
      brackets: [
        { bracket: 1, initialLeverage: 50, notionalCap: "10000", notionalFloor: "0", maintMarginRatio: "0.01", cum: "0" },
      ],
      maxInitialLeverage: 50,
      accountSymbolConfig: null,
    };
  },
} as unknown as ConstructorParameters<typeof SafetyAdmissionService>[1];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let executions: ExecutionServiceType;
let admissions: SafetyAdmissionServiceType;
let policies: InstanceType<typeof SafetyPolicyService>;
let authorizations: InstanceType<typeof CanaryAuthorizationService>;

const profileIds: string[] = [];
let sequence = 0;

interface RowLimits {
  maxOpenPositions?: number;
  softOpenPositionTarget?: number;
  maxPendingEntries?: number;
  maxTotalActiveTrades?: number;
  maxActivePerSymbolSide?: number;
  maxTotalPlannedRiskUsd?: string;
  maxTotalIsolatedMarginUsd?: string;
}

/** A fresh enabled profile with its own policy row. Isolation per test. */
async function newProfile(limits: RowLimits = {}): Promise<string> {
  sequence += 1;
  const profile = await prisma!.executionProfile.create({
    data: {
      name: `${TAG}-${sequence}`,
      accountIdentifier: `${TAG}-${sequence}-${Date.now().toString(36)}`,
      environment: "TESTNET",
      isEnabled: true,
    },
  });
  profileIds.push(profile.id);
  await policies.createForProfile(profile.id, {
    killSwitchActive: false,
    maxOpenPositions: limits.maxOpenPositions ?? 5,
    softOpenPositionTarget: limits.softOpenPositionTarget ?? 5,
    maxPendingEntries: limits.maxPendingEntries ?? 5,
    maxTotalActiveTrades: limits.maxTotalActiveTrades ?? 5,
    maxActivePerSymbolSide: limits.maxActivePerSymbolSide ?? 1,
    maxTotalPlannedRiskUsd: limits.maxTotalPlannedRiskUsd ?? "100.00",
    maxTotalIsolatedMarginUsd: limits.maxTotalIsolatedMarginUsd ?? "500.00",
  });
  return profile.id;
}

/** An open natural window. Nothing here touches allowedSymbols. */
async function newWindow(
  profileId: string,
  options: { directions?: string[]; maxClaims?: number } = {}
) {
  return authorizations.prepareNaturalWindow({
    executionProfileId: profileId,
    allowedDirections: options.directions ?? ["LONG"],
    maxClaims: options.maxClaims ?? 5,
    ttlMinutes: 30,
  });
}

/** A consumed, historical EXACT_SIGNAL row — the MAINNET-shaped precondition. */
async function historicalExactRows(profileId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    sequence += 1;
    await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "EXACT_SIGNAL",
        allowedSymbol: "OLDUSDT",
        allowedDirection: "LONG",
        tokenHash: `${TAG}-hash-${sequence}-${Date.now().toString(36)}`,
        expiresAt: new Date(Date.now() - 60_000),
        consumedAt: new Date(Date.now() - 120_000),
        consumedAlertId: `${TAG}-old-alert-${sequence}`,
      },
    });
  }
}

function readyPlan(symbol: string, direction: "LONG" | "SHORT"): DynamicLeveragePlan {
  const long = direction === "LONG";
  return {
    status: "READY",
    reason: null,
    reasonMessage: null,
    symbol,
    direction,
    entryPrice: "100",
    stopLoss: long ? "96" : "104",
    calculatedStopLoss: long ? "96" : "104",
    executableStopLoss: long ? "96" : "104",
    stopAdjustment: "0",
    stopNormalization: null,
    stopLossSource: "CALCULATED",
    stopDistance: "4",
    riskBudgetUsd: "1.50",
    quantityRaw: "0.375",
    roundedQuantity: "0.375",
    quantityStepSize: "0.001",
    actualPlannedLoss: "1.5",
    unusedRiskBudget: "0",
    positionNotional: "37.5",
    minimumNotional: "5",
    targetMarginMultiplier: "2.5",
    maximumMarginMultiplier: "3.333333",
    targetIsolatedMargin: "3.75",
    maximumIsolatedMargin: "4.9999995",
    applicableBracket: null,
    maximumSupportedLeverage: 50,
    binanceMaximumSupportedLeverage: 50,
    userMaximumAutomationLeverage: 25,
    usableMaximumLeverage: 25,
    selectedLeverage: 10,
    estimatedInitialMargin: "3.75",
    // LONG liquidates below the boundary; SHORT above it.
    estimatedLiquidationPrice: long ? "90.1" : "109.9",
    requiredLiquidationBoundary: long ? "94" : "106",
    liquidationBufferRatio: "0.5",
    liquidationDistance: "5.9",
    safetyBufferDistance: "2",
    marginDifferenceFromTarget: "0",
    candidates: [],
    warnings: [],
  } as DynamicLeveragePlan;
}

/** A PLAN_READY execution on its own symbol, so contenders never collide. */
async function newExecution(
  profileId: string,
  options: { symbol?: string; direction?: "LONG" | "SHORT" } = {}
) {
  sequence += 1;
  const symbol = options.symbol ?? `SYN${sequence}USDT`;
  const direction = options.direction ?? "LONG";
  const alert = await prisma!.alert.create({
    data: {
      symbol,
      assetType: "CRYPTO",
      exchange: "SYNTHETIC",
      timeframe: "15m",
      sourceTimeframe: "1W",
      price: 100,
      signal: direction,
      indicatorName: `${TAG}-${sequence}`,
      rawPayload: { note: TAG },
      triggeredAt: new Date(),
    },
  });
  return executions.createExecutionFromReadyPlan({
    executionProfileId: profileId,
    alertId: alert.id,
    plan: readyPlan(symbol, direction),
    positionSide: direction,
    selectedLookback: 200,
  });
}

const admit = (execution: { id: string; version: number }, versionOffset = 0) =>
  admissions.evaluateAndReserveSafetyAdmission({
    executionId: execution.id,
    expectedVersion: execution.version + versionOffset,
    evaluatedAt: new Date(),
  });

const windowOf = (id: string) => prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id } });
const executionOf = (id: string) => prisma!.tradeExecution.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  if (!prisma || !available) return;
  executions = new ExecutionService(prisma);
  admissions = new SafetyAdmissionService(prisma, readOnlyStub);
  policies = new SafetyPolicyService(prisma);
  authorizations = new CanaryAuthorizationService(prisma);
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    const ids = (
      await prisma.tradeExecution.findMany({
        where: { executionProfileId: { in: profileIds } },
        select: { id: true },
      })
    ).map((execution) => execution.id);
    if (ids.length > 0) {
      await prisma.safetyAdmission.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.executionNotification.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.executionProtectionVerification.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.binanceOrder.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.tradeExecution.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: { in: profileIds } } });
    await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: { in: profileIds } } });
    await prisma.executionProfile.deleteMany({ where: { id: { in: profileIds } } });
    await prisma.alert.deleteMany({ where: { indicatorName: { startsWith: TAG } } });
  }
  await prisma.$disconnect();
});

const describeDb = available ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Authorization mode resolution
// ---------------------------------------------------------------------------

describeDb("natural admission: mode resolution", () => {
  it("LEGACY — a profile with no authorization history is unaffected", async () => {
    // The feature is additive. A profile that was never placed under
    // authorization control must not be conscripted into needing a window.
    const profileId = await newProfile();
    const execution = await newExecution(profileId);

    const outcome = await admit(execution);

    expect(outcome.decision).toBe("PASS");
    expect((await executionOf(execution.id)).status).toBe("PREFLIGHT");
    expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(0);
  });

  it("historical EXACT rows + NO natural window -> fail closed (today's MAINNET)", async () => {
    // The exact shape of the live profile: 31 consumed/expired exact rows and
    // no window. A tokenless alert must still be refused — the count predicate
    // becoming type-aware must NOT have turned this into an open profile.
    const profileId = await newProfile();
    await historicalExactRows(profileId, 31);
    const execution = await newExecution(profileId);

    const outcome = await admit(execution);

    expect(outcome.decision).toBe("SKIP");
    expect(outcome.reasonCode).toBe("NATURAL_AUTHORIZATION_REQUIRED");
    expect((await executionOf(execution.id)).status).toBe("SKIPPED");
  });

  it("historical EXACT rows + a valid natural window -> admitted, one claim", async () => {
    // The scenario the whole phase exists for. History no longer forces exact
    // binding, because a window currently authorizes new admissions.
    const profileId = await newProfile();
    await historicalExactRows(profileId, 31);
    const window = await newWindow(profileId, { directions: ["LONG"], maxClaims: 5 });
    const execution = await newExecution(profileId);

    const outcome = await admit(execution);

    expect(outcome.decision).toBe("PASS");
    expect((await executionOf(execution.id)).status).toBe("PREFLIGHT");
    const after = await windowOf(window.id);
    expect(after.claimedCount).toBe(1);
    expect(after.version).toBe(2);
    // A natural claim is a counter, never an exact-style binding.
    expect(after.consumedAt).toBeNull();
    expect(after.consumedAlertId).toBeNull();
    expect(after.consumedExecutionId).toBeNull();
  });

  it("EXACT binding wins and spends ZERO natural claims", async () => {
    // An alert authorized SPECIFICALLY outranks being authorized generically.
    const profileId = await newProfile();
    const execution = await newExecution(profileId);

    // The exact row is bound to THIS execution's alert...
    const bound = await executionOf(execution.id);
    await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "EXACT_SIGNAL",
        allowedSymbol: bound.symbol,
        allowedDirection: "LONG",
        tokenHash: `${TAG}-exact-${Date.now().toString(36)}`,
        expiresAt: new Date(Date.now() + 600_000),
        consumedAt: new Date(),
        consumedAlertId: bound.alertId!,
      },
    });
    // ...and a window exists too (prepared before the exact row, since
    // exclusivity forbids opening one while another is active).
    const window = await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        allowedDirections: ["LONG"],
        maxClaims: 5,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    const outcome = await admit(execution);

    expect(outcome.decision).toBe("PASS");
    // The exact path admitted it; the window paid nothing.
    expect((await windowOf(window.id)).claimedCount).toBe(0);
    expect((await windowOf(window.id)).version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Authorization refusals — every one spends zero claims
// ---------------------------------------------------------------------------

describeDb("natural admission: authorization refusals", () => {
  const cases = [
    {
      label: "wrong direction",
      reason: "NATURAL_AUTHORIZATION_DIRECTION_NOT_ALLOWED",
      directions: ["LONG"],
      side: "SHORT" as const,
      mutate: null,
    },
    {
      label: "expired",
      reason: "NATURAL_AUTHORIZATION_EXPIRED",
      directions: ["LONG"],
      side: "LONG" as const,
      mutate: { expiresAt: new Date(Date.now() - 1000) },
    },
    {
      label: "revoked",
      reason: "NATURAL_AUTHORIZATION_REVOKED",
      directions: ["LONG"],
      side: "LONG" as const,
      mutate: { revokedAt: new Date() },
    },
    {
      label: "exhausted",
      reason: "NATURAL_AUTHORIZATION_EXHAUSTED",
      directions: ["LONG"],
      side: "LONG" as const,
      mutate: { claimedCount: 2, maxClaims: 2 },
    },
    {
      label: "malformed",
      reason: "NATURAL_AUTHORIZATION_INVALID",
      directions: ["LONG"],
      side: "LONG" as const,
      mutate: { allowedSymbol: "BTCUSDT" },
    },
  ];

  it.each(cases)("$label -> refused, zero claims, no reservation", async ({ reason, directions, side, mutate }) => {
    const profileId = await newProfile();
    const window = await newWindow(profileId, { directions, maxClaims: 5 });
    if (mutate) {
      await prisma!.executionCanaryAuthorization.update({ where: { id: window.id }, data: mutate });
    }
    const before = await windowOf(window.id);
    const execution = await newExecution(profileId, { direction: side });

    const outcome = await admit(execution);

    expect(outcome.decision).toBe("SKIP");
    expect(outcome.reasonCode).toBe(reason);
    // No capacity reserved.
    expect((await executionOf(execution.id)).status).toBe("SKIPPED");
    // No claim spent.
    const after = await windowOf(window.id);
    expect(after.claimedCount).toBe(before.claimedCount);
    expect(after.version).toBe(before.version);
  });

  it("LONG passes under otherwise identical conditions", async () => {
    // The control for the wrong-direction case: nothing but direction differs.
    const profileId = await newProfile();
    const window = await newWindow(profileId, { directions: ["LONG"], maxClaims: 5 });
    const execution = await newExecution(profileId, { direction: "LONG" });

    expect((await admit(execution)).decision).toBe("PASS");
    expect((await windowOf(window.id)).claimedCount).toBe(1);
  });

  it("a LONG+SHORT window admits each direction explicitly", async () => {
    const profileId = await newProfile();
    const window = await newWindow(profileId, { directions: ["LONG", "SHORT"], maxClaims: 5 });

    expect((await admit(await newExecution(profileId, { direction: "LONG" }))).decision).toBe("PASS");
    expect((await admit(await newExecution(profileId, { direction: "SHORT" }))).decision).toBe("PASS");
    expect((await windowOf(window.id)).claimedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Capacity and infrastructure rejections spend zero claims
// ---------------------------------------------------------------------------

describeDb("natural admission: rejections spend zero claims", () => {
  it("every terminal capacity refusal leaves the budget untouched", async () => {
    // Capacity is evaluated FIRST, so a refusal short-circuits before the
    // claim. A cumulative, never-refunded budget must not pay for a trade the
    // account was never going to take.
    const profileId = await newProfile({ maxOpenPositions: 1, softOpenPositionTarget: 1, maxTotalActiveTrades: 1, maxPendingEntries: 1 });
    const window = await newWindow(profileId, { maxClaims: 5 });

    const first = await newExecution(profileId);
    expect((await admit(first)).decision).toBe("PASS");
    expect((await windowOf(window.id)).claimedCount).toBe(1);

    // Second contender: capacity is now full in every dimension.
    const second = await newExecution(profileId);
    const outcome = await admit(second);

    expect(outcome.decision).toBe("SKIP");
    expect(outcome.reasonCode).not.toMatch(/^NATURAL_AUTHORIZATION_/);
    expect((await executionOf(second.id)).status).toBe("SKIPPED");
    // Still exactly one claim.
    expect((await windowOf(window.id)).claimedCount).toBe(1);
  });

  it("SOFT_OPEN_TARGET_REACHED spends no claim", async () => {
    const profileId = await newProfile({ maxOpenPositions: 5, softOpenPositionTarget: 3, maxTotalActiveTrades: 5 });
    const window = await newWindow(profileId, { maxClaims: 5 });

    // Three OPEN positions, reached the honest way then parked as filled.
    for (let i = 0; i < 3; i += 1) {
      const execution = await newExecution(profileId);
      expect((await admit(execution)).decision).toBe("PASS");
      await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { status: "ENTRY_FILLED" } });
    }
    expect((await windowOf(window.id)).claimedCount).toBe(3);

    const fourth = await newExecution(profileId);
    const outcome = await admit(fourth);

    expect(outcome.decision).toBe("SKIP");
    expect(outcome.reasonCode).toBe("SOFT_OPEN_TARGET_REACHED");
    // The soft target is a capacity decision, so the budget is untouched.
    expect((await windowOf(window.id)).claimedCount).toBe(3);
    expect((await windowOf(window.id)).version).toBe(4);
  });

  it("capacity refusal outranks a simultaneously invalid window", async () => {
    // BOTH blockers are true at once: the soft target is reached AND the window
    // has expired. Capacity-first precedence means the reported reason is the
    // capacity one — an opportunity the account was never going to take must
    // not be classified by, or spend, authorization.
    const profileId = await newProfile({ maxOpenPositions: 5, softOpenPositionTarget: 3, maxTotalActiveTrades: 5 });
    const window = await newWindow(profileId, { maxClaims: 5 });

    // Reach the soft target while the window is still valid.
    for (let i = 0; i < 3; i += 1) {
      const execution = await newExecution(profileId);
      expect((await admit(execution)).decision).toBe("PASS");
      await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { status: "ENTRY_FILLED" } });
    }
    // Now ALSO invalidate the authorization.
    await prisma!.executionCanaryAuthorization.update({
      where: { id: window.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const before = await windowOf(window.id);

    const fourth = await newExecution(profileId);
    const outcome = await admit(fourth);

    // The CAPACITY reason wins, not NATURAL_AUTHORIZATION_EXPIRED.
    expect(outcome.decision).toBe("SKIP");
    expect(outcome.reasonCode).toBe("SOFT_OPEN_TARGET_REACHED");
    expect(outcome.reasonCode).not.toMatch(/^NATURAL_AUTHORIZATION_/);
    // Terminal, with no reservation.
    const after = await executionOf(fourth.id);
    expect(after.status).toBe("SKIPPED");
    expect(after.decisionReasonCode).toBe("SOFT_OPEN_TARGET_REACHED");
    expect(
      await prisma!.tradeExecution.count({ where: { executionProfileId: profileId, status: "PREFLIGHT" } })
    ).toBe(0);
    // And zero claims spent by the refusal.
    const budget = await windowOf(window.id);
    expect(budget.claimedCount).toBe(before.claimedCount);
    expect(budget.version).toBe(before.version);
  });

  it("the profile kill switch refuses without spending a claim", async () => {
    // A kill switch short-circuits before Binance is even read; authorization
    // must not be reached either.
    const profileId = await newProfile();
    const window = await newWindow(profileId, { maxClaims: 5 });
    const policy = await policies.getByProfileId(profileId);
    await policies.updateForProfile(profileId, policy!.version, { killSwitchActive: true });

    const execution = await newExecution(profileId);
    const outcome = await admit(execution);

    expect(outcome.decision).toBe("SKIP");
    expect(outcome.reasonCode).toBe("PROFILE_KILL_SWITCH_ACTIVE");
    expect((await windowOf(window.id)).claimedCount).toBe(0);
  });

  it("an infrastructure UNAVAILABLE spends no claim and stays PLAN_READY", async () => {
    // Retryable infrastructure failure. Converting one into a spent
    // authorization would make an outage cost real budget.
    const profileId = await newProfile();
    const window = await newWindow(profileId, { maxClaims: 5 });
    const execution = await newExecution(profileId);

    const failing = new SafetyAdmissionService(prisma!, {
      async getAccountSummary() {
        throw new Error("stubbed connector failure");
      },
      async inspectSymbol() {
        throw new Error("stubbed connector failure");
      },
    } as unknown as ConstructorParameters<typeof SafetyAdmissionService>[1]);

    const outcome = await failing.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });

    expect(outcome.decision).toBe("UNAVAILABLE");
    expect((await executionOf(execution.id)).status).toBe("PLAN_READY");
    expect((await windowOf(window.id)).claimedCount).toBe(0);

    // ADMISSION-TIME semantics: once infrastructure recovers, the SAME
    // execution is evaluated against the CURRENT window and can then claim.
    const recovered = await executionOf(execution.id);
    const second = await admit({ id: recovered.id, version: recovered.version });
    expect(second.decision).toBe("PASS");
    expect((await windowOf(window.id)).claimedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Atomicity — the claim and the reservation live or die together
// ---------------------------------------------------------------------------

describeDb("natural admission: atomicity", () => {
  it("rolls the claim back when the reservation fails after it", async () => {
    // A stale expectedVersion makes the status reservation match zero rows,
    // which throws CapacityConflict AFTER the claim has already incremented
    // inside the same transaction. If the two were not atomic, the budget
    // would be spent on an execution that never reserved anything.
    const profileId = await newProfile();
    const window = await newWindow(profileId, { maxClaims: 5 });
    const execution = await newExecution(profileId);

    const outcome = await admit(execution, 99);

    expect(outcome.decision).toBe("RETRY_CONFLICT");
    // Nothing reserved...
    expect((await executionOf(execution.id)).status).toBe("PLAN_READY");
    // ...and the claim was rolled back with it, on every bounded retry.
    const after = await windowOf(window.id);
    expect(after.claimedCount).toBe(0);
    expect(after.version).toBe(1);
  });

  it("a refused admission writes no PREFLIGHT and no claim, only a decision", async () => {
    const profileId = await newProfile();
    await historicalExactRows(profileId, 3);
    const execution = await newExecution(profileId);

    await admit(execution);

    const after = await executionOf(execution.id);
    expect(after.status).toBe("SKIPPED");
    expect(after.decisionReasonCode).toBe("NATURAL_AUTHORIZATION_REQUIRED");
    // The refusal is recorded as a durable admission decision, which is what
    // makes it auditable rather than a silent drop.
    const stored = await prisma!.safetyAdmission.findFirst({ where: { tradeExecutionId: execution.id } });
    expect(stored?.reasonCode).toBe("NATURAL_AUTHORIZATION_REQUIRED");
    expect(stored?.decision).toBe("SKIP");
  });

  it("records which window paid for an admission", async () => {
    const profileId = await newProfile();
    const window = await newWindow(profileId, { maxClaims: 5 });
    const execution = await newExecution(profileId);

    await admit(execution);

    const event = await prisma!.executionEvent.findFirst({
      where: { tradeExecutionId: execution.id, eventType: "DECISION_RECORDED" },
      orderBy: { sequenceNumber: "desc" },
    });
    expect((event?.metadata as { naturalWindowId?: string })?.naturalWindowId).toBe(window.id);
  });
});

// ---------------------------------------------------------------------------
// Concurrency — the real advisory lock, genuinely parallel contenders
// ---------------------------------------------------------------------------

describeDb("natural admission: concurrency", () => {
  it("10 contenders, hard capacity 5, maxClaims 5 -> exactly 5 admitted and 5 claims", async () => {
    const profileId = await newProfile({
      maxOpenPositions: 5,
      softOpenPositionTarget: 5,
      maxPendingEntries: 5,
      maxTotalActiveTrades: 5,
    });
    const window = await newWindow(profileId, { maxClaims: 5 });

    const contenders = await Promise.all(Array.from({ length: 10 }, () => newExecution(profileId)));
    const outcomes = await Promise.all(contenders.map((execution) => admit(execution)));

    const admitted = outcomes.filter((outcome) => outcome.decision === "PASS");
    expect(admitted).toHaveLength(5);

    const reserved = await prisma!.tradeExecution.count({
      where: { executionProfileId: profileId, status: "PREFLIGHT" },
    });
    expect(reserved).toBe(5);

    const after = await windowOf(window.id);
    expect(after.claimedCount).toBe(admitted.length);
    expect(after.claimedCount).toBe(5);
    expect(after.version).toBe(6);
  });

  it("soft target 3 under hard 5 stops new admission, and claims match admissions", async () => {
    const profileId = await newProfile({
      maxOpenPositions: 5,
      softOpenPositionTarget: 3,
      maxPendingEntries: 5,
      maxTotalActiveTrades: 5,
    });
    const window = await newWindow(profileId, { maxClaims: 5 });

    // Three admissions, each parked as an OPEN position before the next runs,
    // so open exposure genuinely reaches the soft target.
    for (let i = 0; i < 3; i += 1) {
      const execution = await newExecution(profileId);
      expect((await admit(execution)).decision).toBe("PASS");
      await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { status: "ENTRY_FILLED" } });
    }

    const late = await Promise.all(Array.from({ length: 4 }, () => newExecution(profileId)));
    const outcomes = await Promise.all(late.map((execution) => admit(execution)));

    expect(outcomes.every((outcome) => outcome.decision === "SKIP")).toBe(true);
    expect(outcomes.every((outcome) => outcome.reasonCode === "SOFT_OPEN_TARGET_REACHED")).toBe(true);
    // Claims equal successful admissions — the soft target bought nothing.
    expect((await windowOf(window.id)).claimedCount).toBe(3);
  });

  it("same symbol + side: at most one admitted and at most one claim", async () => {
    const profileId = await newProfile({ maxActivePerSymbolSide: 1 });
    const window = await newWindow(profileId, { maxClaims: 5 });

    const symbol = `DUPE${Date.now().toString(36)}USDT`;
    const both = await Promise.all([
      newExecution(profileId, { symbol, direction: "LONG" }),
      newExecution(profileId, { symbol, direction: "LONG" }),
    ]);
    const outcomes = await Promise.all(both.map((execution) => admit(execution)));

    const admitted = outcomes.filter((outcome) => outcome.decision === "PASS");
    expect(admitted.length).toBeLessThanOrEqual(1);
    expect((await windowOf(window.id)).claimedCount).toBe(admitted.length);
  });

  it("maxClaims 2 is the limiting factor when capacity is 5", async () => {
    const profileId = await newProfile({
      maxOpenPositions: 5,
      softOpenPositionTarget: 5,
      maxPendingEntries: 5,
      maxTotalActiveTrades: 5,
    });
    const window = await newWindow(profileId, { maxClaims: 2 });

    const contenders = await Promise.all(Array.from({ length: 5 }, () => newExecution(profileId)));
    const outcomes = await Promise.all(contenders.map((execution) => admit(execution)));

    const admitted = outcomes.filter((outcome) => outcome.decision === "PASS");
    expect(admitted).toHaveLength(2);
    // Capacity had room; authorization did not manufacture extra claims.
    expect((await windowOf(window.id)).claimedCount).toBe(2);
    const refusedForAuthorization = outcomes.filter(
      (outcome) => outcome.reasonCode === "NATURAL_AUTHORIZATION_EXHAUSTED"
    );
    expect(refusedForAuthorization.length).toBeGreaterThan(0);
  });

  it("capacity 2 is the limiting factor when maxClaims is 5", async () => {
    // The decisive proof that the claim is NOT spent before capacity: three
    // budget units must remain unspent.
    const profileId = await newProfile({
      maxOpenPositions: 2,
      softOpenPositionTarget: 2,
      maxPendingEntries: 2,
      maxTotalActiveTrades: 2,
    });
    const window = await newWindow(profileId, { maxClaims: 5 });

    const contenders = await Promise.all(Array.from({ length: 5 }, () => newExecution(profileId)));
    const outcomes = await Promise.all(contenders.map((execution) => admit(execution)));

    const admitted = outcomes.filter((outcome) => outcome.decision === "PASS");
    expect(admitted).toHaveLength(2);
    const after = await windowOf(window.id);
    expect(after.claimedCount).toBe(2);
    expect(after.maxClaims! - after.claimedCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// No queue — a refusal is terminal, whatever later frees up
// ---------------------------------------------------------------------------

describeDb("natural admission: no queue", () => {
  it("a capacity-refused alert stays SKIPPED after a slot frees", async () => {
    const profileId = await newProfile({ maxOpenPositions: 1, softOpenPositionTarget: 1, maxTotalActiveTrades: 1, maxPendingEntries: 1 });
    const window = await newWindow(profileId, { maxClaims: 5 });

    const first = await newExecution(profileId);
    await admit(first);
    const refused = await newExecution(profileId);
    await admit(refused);
    expect((await executionOf(refused.id)).status).toBe("SKIPPED");

    // The first trade closes, freeing every slot.
    await prisma!.tradeExecution.update({ where: { id: first.id }, data: { status: "CLOSED_TP" } });

    // The refused alert is terminal: admission refuses to re-enter it, and the
    // status machine has no transition out of SKIPPED.
    const stale = await executionOf(refused.id);
    const retry = await admit({ id: stale.id, version: stale.version });
    expect(retry.decision).not.toBe("PASS");
    expect((await executionOf(refused.id)).status).toBe("SKIPPED");
    // No claim was spent by the retry either.
    expect((await windowOf(window.id)).claimedCount).toBe(1);

    // A genuinely NEW alert may take the freed slot.
    const fresh = await newExecution(profileId);
    expect((await admit(fresh)).decision).toBe("PASS");
    expect((await windowOf(window.id)).claimedCount).toBe(2);
  });

  it("an authorization-refused alert is terminal even after a window opens", async () => {
    const profileId = await newProfile();
    await historicalExactRows(profileId, 2);
    const refused = await newExecution(profileId);
    await admit(refused);
    expect((await executionOf(refused.id)).status).toBe("SKIPPED");

    // A window is opened afterwards — the refused alert does not come back.
    const window = await newWindow(profileId, { maxClaims: 5 });
    const stale = await executionOf(refused.id);
    const retry = await admit({ id: stale.id, version: stale.version });

    expect(retry.decision).not.toBe("PASS");
    expect((await executionOf(refused.id)).status).toBe("SKIPPED");
    expect((await windowOf(window.id)).claimedCount).toBe(0);

    // Only a fresh alert can use it.
    expect((await admit(await newExecution(profileId))).decision).toBe("PASS");
    expect((await windowOf(window.id)).claimedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Authorization gates NEW admission only
// ---------------------------------------------------------------------------

describeDb("natural admission: authorization does not follow the trade", () => {
  it("revoking or expiring a window after admission changes nothing about the execution", async () => {
    const profileId = await newProfile();
    const window = await newWindow(profileId, { maxClaims: 5 });
    const execution = await newExecution(profileId);

    expect((await admit(execution)).decision).toBe("PASS");
    expect((await executionOf(execution.id)).status).toBe("PREFLIGHT");

    // The window is shut and drained after the fact.
    await prisma!.executionCanaryAuthorization.update({
      where: { id: window.id },
      data: { revokedAt: new Date(), expiresAt: new Date(Date.now() - 1000), claimedCount: 5, maxClaims: 5 },
    });

    // The admitted execution is untouched: still reserved, still holding its
    // capacity, ready for the entry lifecycle. Authorization gates NEW
    // admission only.
    const after = await executionOf(execution.id);
    expect(after.status).toBe("PREFLIGHT");
    expect(after.decisionReasonCode).toBe("SAFETY_ADMITTED");
    // And the spent claim is never refunded by the window being shut.
    expect((await windowOf(window.id)).claimedCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Symbol allowlist under live traffic (Phase 12.4B condition, 12.4C regression)
// ---------------------------------------------------------------------------

/**
 * Phase 12.4B brought the runtime up for twelve minutes and nine real
 * TradingView alerts arrived — STARUSDT, AIAUSDT, EVAAUSDT, XMRUSDT,
 * PROMPTUSDT, PORTALUSDT, 1000RATSUSDT, XPINUSDT, JELLYJELLYUSDT. None of them
 * was COWUSDT, and none of them may ever reach the exchange during a COWUSDT-only
 * supervised rollout.
 *
 * That posture currently holds because the global kill switch refuses everything
 * first. These tests remove that crutch: the profile is fully open and a valid
 * natural window is present, so the ONLY thing standing between a foreign symbol
 * and an order is the allowlist. If a future change made the window sufficient
 * on its own, exactly these tests fail.
 *
 * No new symbol logic is introduced — the refusal is the existing engine's.
 */
describeDb("natural admission: COWUSDT-only rollout under live traffic", () => {
  /** An open profile whose ONLY remaining restriction is the allowlist. */
  async function cowOnlyProfile(): Promise<string> {
    const profileId = await newProfile();
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { allowedSymbols: ["COWUSDT"] },
    });
    return profileId;
  }

  const PHASE_4B_TRAFFIC = [
    "STARUSDT",
    "AIAUSDT",
    "EVAAUSDT",
    "XMRUSDT",
    "PROMPTUSDT",
    "PORTALUSDT",
    "1000RATSUSDT",
    "XPINUSDT",
    "JELLYJELLYUSDT",
  ];

  it.each(PHASE_4B_TRAFFIC)("refuses %s even with an AVAILABLE natural window", async (symbol) => {
    const profileId = await cowOnlyProfile();
    const window = await newWindow(profileId, { directions: ["LONG", "SHORT"] });
    const execution = await newExecution(profileId, { symbol, direction: "LONG" });

    const outcome = await admit(execution);

    // The existing engine's own reason — nothing new was added for this.
    expect(outcome.decision).not.toBe("PASS");
    expect(outcome.reasonCode).toBe("SYMBOL_NOT_ALLOWED");
    expect((await executionOf(execution.id)).status).not.toBe("PREFLIGHT");

    // The whole point: a refused foreign symbol costs the canary nothing.
    const after = await windowOf(window.id);
    expect(after.claimedCount).toBe(0);
    expect(after.version).toBe(window.version);
  });

  it("spends zero claims across the entire Phase-4B alert burst", async () => {
    const profileId = await cowOnlyProfile();
    const window = await newWindow(profileId, { directions: ["LONG", "SHORT"], maxClaims: 5 });

    for (const symbol of PHASE_4B_TRAFFIC) {
      const execution = await newExecution(profileId, { symbol, direction: "LONG" });
      await admit(execution);
    }

    // Nine eligible-looking alerts, a five-claim budget, and not one spent.
    const after = await windowOf(window.id);
    expect(after.claimedCount).toBe(0);
    expect(after.version).toBe(window.version);
    expect(
      await prisma!.tradeExecution.count({ where: { executionProfileId: profileId, status: "PREFLIGHT" } })
    ).toBe(0);
  });

  it("CONTROL — COWUSDT is admitted under the identical setup", async () => {
    // Without this the test above would pass even if the allowlist refused
    // everything, which would prove nothing about COWUSDT being usable.
    const profileId = await cowOnlyProfile();
    const window = await newWindow(profileId, { directions: ["LONG", "SHORT"] });
    const execution = await newExecution(profileId, { symbol: "COWUSDT", direction: "LONG" });

    const outcome = await admit(execution);

    expect(outcome.decision).toBe("PASS");
    expect(outcome.reasonCode).not.toBe("SYMBOL_NOT_ALLOWED");
    expect((await executionOf(execution.id)).status).toBe("PREFLIGHT");
    // The control DOES spend exactly one claim — that is what admission is.
    expect((await windowOf(window.id)).claimedCount).toBe(1);
  });
});
