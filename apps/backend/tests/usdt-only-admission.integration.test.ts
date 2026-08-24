import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";
import type { DynamicLeveragePlan } from "@trading-alert-dashboard/shared";

/**
 * USDT-only eligibility at the REAL admission boundary, against real Postgres.
 *
 * The pure suite proves the RULE. This file proves the thing that actually
 * matters operationally: that a non-USDT contract costs nothing on its way to
 * being refused. Specifically, that when it is turned away —
 *
 *   the authorization claim count does not move,
 *   no capacity reservation is created (it never reaches PREFLIGHT),
 *   risk and margin reservations stay where they were,
 *   no Binance mutation is dispatched,
 *   and the refusal is PERSISTED with a reason an operator can read.
 *
 * None of that can be shown against a mocked admission service, because the
 * claim and the reservation commit inside one transaction under the profile
 * advisory lock. Every row here is synthetic and removed in afterAll. Binance
 * is a read-only stub: this file makes no network call and cannot place an
 * order — the mutation client is never imported.
 */

const TAG = "fixa-usdt-only-admission";

// Permissive env so each test pins its real limits on its own policy ROW.
// Anything left to a developer `.env` would make these pass or fail by accident.
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
const { BinanceError } = await import("../src/modules/binance/binance.errors");

type ExecutionServiceType = InstanceType<typeof ExecutionService>;
type SafetyAdmissionServiceType = InstanceType<typeof SafetyAdmissionService>;

// ---------------------------------------------------------------------------
// Read-only Binance stub. GET-shaped data only; every call is recorded so a
// mutation attempt would be visible rather than merely absent.
// ---------------------------------------------------------------------------

type SymbolMode = "USDT" | "USDC" | "QUOTE_ONLY_USDT" | "ABSENT" | "UNREADABLE" | "MISSING_ASSETS";

const stub = {
  calls: [] as string[],
  /** How `inspectSymbol` should answer, keyed by symbol. */
  modes: new Map<string, SymbolMode>(),
};

const readOnlyStub = {
  async getAccountSummary() {
    stub.calls.push("getAccountSummary");
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
    stub.calls.push(`inspectSymbol:${symbol}`);
    const mode = stub.modes.get(symbol) ?? "USDT";

    if (mode === "ABSENT") {
      // Exactly what the real reader raises when exchangeInfo answered and had
      // no such contract: an AUTHORITATIVE absence.
      throw new BinanceError({
        kind: "UNSUPPORTED_SYMBOL",
        message: `Symbol ${symbol} is not listed on Binance USDⓈ-M futures`,
        endpoint: "exchangeInfo",
      });
    }
    if (mode === "UNREADABLE") {
      // A timeout / 5xx / malformed reply: says nothing about the symbol.
      throw new BinanceError({ kind: "TIMEOUT", message: "exchangeInfo timed out", endpoint: "exchangeInfo" });
    }

    const assets =
      mode === "USDC"
        ? { quoteAsset: "USDC", marginAsset: "USDC" }
        : mode === "QUOTE_ONLY_USDT"
          ? { quoteAsset: "USDT", marginAsset: "USDC" }
          : mode === "MISSING_ASSETS"
            ? { quoteAsset: null, marginAsset: null }
            : { quoteAsset: "USDT", marginAsset: "USDT" };

    return {
      filters: { symbol, status: "TRADING", contractType: "PERPETUAL", ...assets, tickSize: "0.01", stepSize: "0.001" },
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

async function newProfile(): Promise<string> {
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
    maxOpenPositions: 5,
    softOpenPositionTarget: 5,
    maxPendingEntries: 5,
    maxTotalActiveTrades: 5,
    maxActivePerSymbolSide: 1,
    maxTotalPlannedRiskUsd: "100.00",
    maxTotalIsolatedMarginUsd: "500.00",
  });
  return profile.id;
}

const newWindow = (profileId: string) =>
  authorizations.prepareNaturalWindow({
    executionProfileId: profileId,
    allowedDirections: ["LONG"],
    maxClaims: 5,
    ttlMinutes: 30,
  });

function readyPlan(symbol: string): DynamicLeveragePlan {
  return {
    status: "READY",
    reason: null,
    reasonMessage: null,
    symbol,
    direction: "LONG",
    entryPrice: "100",
    stopLoss: "96",
    calculatedStopLoss: "96",
    executableStopLoss: "96",
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
    estimatedLiquidationPrice: "90.1",
    requiredLiquidationBoundary: "94",
    liquidationBufferRatio: "0.5",
    liquidationDistance: "5.9",
    safetyBufferDistance: "2",
    marginDifferenceFromTarget: "0",
    candidates: [],
    warnings: [],
  } as DynamicLeveragePlan;
}

/** A PLAN_READY execution on the given symbol, answered by the given mode. */
async function newExecution(profileId: string, symbol: string, mode: SymbolMode) {
  stub.modes.set(symbol, mode);
  sequence += 1;
  const alert = await prisma!.alert.create({
    data: {
      symbol,
      assetType: "CRYPTO",
      exchange: "SYNTHETIC",
      timeframe: "15m",
      sourceTimeframe: "1W",
      price: 100,
      signal: "LONG",
      indicatorName: `${TAG}-${sequence}`,
      rawPayload: { note: TAG },
      triggeredAt: new Date(),
    },
  });
  return executions.createExecutionFromReadyPlan({
    executionProfileId: profileId,
    alertId: alert.id,
    plan: readyPlan(symbol),
    positionSide: "LONG",
    selectedLookback: 200,
  });
}

const admit = (execution: { id: string; version: number }) =>
  admissions.evaluateAndReserveSafetyAdmission({
    executionId: execution.id,
    expectedVersion: execution.version,
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
      await prisma.tradeExecution.findMany({ where: { executionProfileId: { in: profileIds } }, select: { id: true } })
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
// F. A refused contract spends nothing
// ---------------------------------------------------------------------------

describeDb("F. a non-USDT contract costs nothing on its way to being refused", () => {
  it("F1. consumes NO authorization claim", async () => {
    const profileId = await newProfile();
    const window = await newWindow(profileId);
    const before = await windowOf(window.id);

    const execution = await newExecution(profileId, "BNBUSDC", "USDC");
    const outcome = await admit(execution);

    expect(outcome.decision).toBe("SKIP");
    expect(outcome.reasonCode).toBe("USDT_ONLY_CONTRACT_REQUIRED");

    const after = await windowOf(window.id);
    // The claim is a cumulative, never-refunded budget. An opportunity the
    // profile was never going to take must not cost one.
    expect(after.claimedCount).toBe(before.claimedCount);
    expect(after.consumedAt).toEqual(before.consumedAt);
    expect(after.revokedAt).toBeNull();
  });

  it("F2. creates NO capacity reservation — it never reaches PREFLIGHT", async () => {
    const profileId = await newProfile();
    await newWindow(profileId);
    const execution = await newExecution(profileId, "SOLUSDC", "USDC");

    await admit(execution);

    const row = await executionOf(execution.id);
    // PREFLIGHT is the reservation. SKIPPED is terminal and frees nothing
    // because nothing was ever taken.
    expect(row.status).toBe("SKIPPED");
    expect(row.status).not.toBe("PREFLIGHT");
  });

  it("F3. leaves risk, margin and active capacity exactly as they were", async () => {
    const profileId = await newProfile();
    await newWindow(profileId);
    const reserved = () =>
      prisma!.tradeExecution.findMany({
        where: { executionProfileId: profileId, status: { in: ["PREFLIGHT", "ENTRY_SUBMITTING", "ENTRY_FILLED", "PROTECTED"] } },
        select: { id: true, riskBudgetUsd: true, maximumIsolatedMargin: true },
      });

    const before = await reserved();
    const execution = await newExecution(profileId, "BNBUSDC", "USDC");
    await admit(execution);
    const after = await reserved();

    expect(after).toEqual(before);
    expect(after).toHaveLength(0);
  });

  it("F4. persists a durable, operator-readable refusal", async () => {
    const profileId = await newProfile();
    const execution = await newExecution(profileId, "SOLUSDC", "USDC");

    await admit(execution);

    const row = await executionOf(execution.id);
    expect(row.decisionReasonCode).toBe("USDT_ONLY_CONTRACT_REQUIRED");

    const admission = await prisma!.safetyAdmission.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });
    expect(admission.decision).toBe("SKIP");
    expect(admission.reasonCode).toBe("USDT_ONLY_CONTRACT_REQUIRED");
    // It must explain the POLICY, not merely that something failed.
    expect(admission.message).toMatch(/USDT/);
  });

  it("F5. dispatches NO Binance mutation — only signed GET-shaped reads", async () => {
    stub.calls.length = 0;
    const profileId = await newProfile();
    const execution = await newExecution(profileId, "BNBUSDC", "USDC");

    await admit(execution);

    // Whatever was called, it was an account/symbol READ. No order, no
    // configuration change, no cancel.
    expect(stub.calls.length).toBeGreaterThan(0);
    for (const call of stub.calls) {
      expect(call).toMatch(/^(getAccountSummary|inspectSymbol:)/);
    }
    const orders = await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } });
    expect(orders).toBe(0);
  });

  it("F6. refuses a USDT-QUOTED contract margined in USDC just as firmly", async () => {
    const profileId = await newProfile();
    const window = await newWindow(profileId);
    const execution = await newExecution(profileId, "TRICKYUSDT", "QUOTE_ONLY_USDT");

    const outcome = await admit(execution);

    expect(outcome.decision).toBe("SKIP");
    expect(outcome.reasonCode).toBe("USDT_ONLY_CONTRACT_REQUIRED");
    expect((await windowOf(window.id)).claimedCount).toBe(0);
    expect((await executionOf(execution.id)).status).toBe("SKIPPED");
  });

  it("F7. a symbol ABSENT from exchangeInfo is terminally skipped, spending nothing", async () => {
    const profileId = await newProfile();
    const window = await newWindow(profileId);
    const execution = await newExecution(profileId, "ETHBTC", "ABSENT");

    const outcome = await admit(execution);

    // exchangeInfo answered and had no such contract: authoritative, so
    // terminal rather than retried forever.
    expect(outcome.decision).toBe("SKIP");
    expect(outcome.reasonCode).toBe("UNSUPPORTED_SYMBOL");
    expect((await executionOf(execution.id)).status).toBe("SKIPPED");
    expect((await windowOf(window.id)).claimedCount).toBe(0);
  });

  it("F8. a USDT contract still passes — the gate refuses, it does not block everything", async () => {
    // The control. Without this, every assertion above would also hold for an
    // implementation that simply refused all work.
    const profileId = await newProfile();
    const window = await newWindow(profileId);
    const execution = await newExecution(profileId, "BTCUSDT", "USDT");

    const outcome = await admit(execution);

    expect(outcome.decision).toBe("PASS");
    expect((await executionOf(execution.id)).status).toBe("PREFLIGHT");
    expect((await windowOf(window.id)).claimedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// G. Unreadable metadata is unknown, and stays retryable
// ---------------------------------------------------------------------------

describeDb("G. metadata that could not be read is never called unsupported", () => {
  it("G1. a timed-out exchangeInfo leaves the execution PLAN_READY and retryable", async () => {
    const profileId = await newProfile();
    const window = await newWindow(profileId);
    const execution = await newExecution(profileId, "SLOWUSDT", "UNREADABLE");

    const outcome = await admit(execution);

    expect(outcome.decision).toBe("UNAVAILABLE");
    expect(outcome.reasonCode).toBe("BINANCE_SYMBOL_STATE_UNAVAILABLE");
    // NOT terminalized, and specifically NOT accused of being non-USDT.
    expect(outcome.reasonCode).not.toBe("USDT_ONLY_CONTRACT_REQUIRED");
    const row = await executionOf(execution.id);
    expect(row.status).toBe("PLAN_READY");
    expect((await windowOf(window.id)).claimedCount).toBe(0);
  });

  it("G2. a row missing its asset fields is unknown, not unsupported", async () => {
    const profileId = await newProfile();
    const window = await newWindow(profileId);
    const execution = await newExecution(profileId, "MYSTERYUSDT", "MISSING_ASSETS");

    const outcome = await admit(execution);

    expect(outcome.decision).toBe("UNAVAILABLE");
    expect(outcome.reasonCode).toBe("BINANCE_SYMBOL_STATE_UNAVAILABLE");
    expect((await executionOf(execution.id)).status).toBe("PLAN_READY");
    expect((await windowOf(window.id)).claimedCount).toBe(0);
  });

  it("G3. an unreadable symbol reaches no Binance mutation and reserves nothing", async () => {
    stub.calls.length = 0;
    const profileId = await newProfile();
    const execution = await newExecution(profileId, "SLOWUSDT2", "UNREADABLE");

    await admit(execution);

    for (const call of stub.calls) expect(call).toMatch(/^(getAccountSummary|inspectSymbol:)/);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
    expect((await executionOf(execution.id)).status).toBe("PLAN_READY");
  });

  it("G4. the retry can still succeed once metadata comes back", async () => {
    // The whole reason UNAVAILABLE must not be terminal: a blip is not a
    // verdict about the contract.
    const profileId = await newProfile();
    await newWindow(profileId);
    const execution = await newExecution(profileId, "FLAKYUSDT", "UNREADABLE");

    const first = await admit(execution);
    expect(first.decision).toBe("UNAVAILABLE");

    stub.modes.set("FLAKYUSDT", "USDT");
    const current = await executionOf(execution.id);
    const second = await admit({ id: execution.id, version: current.version });

    expect(second.decision).toBe("PASS");
    expect((await executionOf(execution.id)).status).toBe("PREFLIGHT");
  });

  it("G5. a retry after an UNREADABLE read still refuses a USDC contract", async () => {
    // Retryability must not become a back door: once the metadata arrives and
    // says USDC, the answer is a terminal refusal, not a pass.
    const profileId = await newProfile();
    const window = await newWindow(profileId);
    const execution = await newExecution(profileId, "LATEUSDC", "UNREADABLE");

    expect((await admit(execution)).decision).toBe("UNAVAILABLE");

    stub.modes.set("LATEUSDC", "USDC");
    const current = await executionOf(execution.id);
    const second = await admit({ id: execution.id, version: current.version });

    expect(second.decision).toBe("SKIP");
    expect(second.reasonCode).toBe("USDT_ONLY_CONTRACT_REQUIRED");
    expect((await windowOf(window.id)).claimedCount).toBe(0);
  });
});
