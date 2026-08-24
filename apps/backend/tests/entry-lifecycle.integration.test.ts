import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";
import type { DynamicLeveragePlan } from "@trading-alert-dashboard/shared";

/**
 * Phase 6 integration tests against a real Postgres, with a FAKE mutation
 * transport.
 *
 * No test in this file can reach Binance: reads come from a scripted stub and
 * every mutation goes to an in-memory fake that records the call. One test
 * additionally builds the REAL mutation client with a transport that fails the
 * test if it is ever invoked, proving the closed gates dispatch nothing.
 *
 * Every row is synthetic (SYNTHETIC_TAG) and removed in afterAll.
 */

const SYNTHETIC_TAG = "phase6-synthetic";
const SYMBOL = "TESTCUSDT";
const TTL_SECONDS = 300;

// Env must be set BEFORE config/env.ts is evaluated.
process.env.EXECUTION_GLOBAL_KILL_SWITCH = "false";
process.env.EXECUTION_LIVE_ENTRY_ENABLED = "true";
process.env.EXECUTION_PROTECTION_READY = "true";
process.env.EXECUTION_ENTRY_TTL_SECONDS = String(TTL_SECONDS);
process.env.EXECUTION_ENTRY_RECONCILE_MAX_ATTEMPTS = "3";
process.env.EXECUTION_ENTRY_RECONCILE_DELAY_MS = "1";
process.env.EXECUTION_MAX_ALERT_AGE_SECONDS = "300";
// A REAL sanctioned Binance futures testnet origin, because connector
// environment is now classified by exact origin (binance-environment.ts) and a
// reserved `.example` host is deliberately not one. Nothing here reaches the
// network: every real client in this suite is built with a transport that
// throws if it is ever called.
process.env.BINANCE_FUTURES_REST_BASE_URL = "https://demo-fapi.binance.com";

// Integration state lives in the DEDICATED test database. The helper refuses
// to fall back to the runtime/canary database, so a misconfiguration fails the
// suite instead of quietly writing synthetic executions into runtime state.
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ExecutionService } = await import("../src/modules/execution/execution.service");
const { EntryLifecycleService } = await import("../src/modules/execution/entry-lifecycle.service");
const { BinanceUsdMExecutionClient } = await import("../src/modules/binance/binance-execution.client");
const { BinanceError } = await import("../src/modules/binance/binance.errors");
const { buildClientOrderId } = await import("../src/modules/execution/execution-safety");
const { SelectedPlanExecutor } = await import("../src/modules/execution/selected-plan-executor");
const { Prisma } = await import("@prisma/client");
// Mutated per test to exercise the env-level gates, restored in afterEach.
const { env: runtimeEnv } = await import("../src/config/env");
const { PENDING_ENTRY_STATUSES, TOTAL_ACTIVE_STATUSES, consumesNoCapacity } = await import(
  "../src/modules/execution/capacity-status"
);

type ExecutionServiceType = InstanceType<typeof ExecutionService>;
type EntryLifecycleServiceType = InstanceType<typeof EntryLifecycleService>;

// ---------------------------------------------------------------------------
// Scriptable exchange stub — reads and mutations, all in memory.
// ---------------------------------------------------------------------------

interface ExchangeOrder {
  orderId: string;
  clientOrderId: string;
  symbol: string;
  status: string;
  side: string;
  positionSide: string;
  type: string;
  price: string;
  origQty: string;
  executedQty: string;
  avgPrice: string;
}

interface Scenario {
  positionMode: "HEDGE" | "ONE_WAY";
  assetMode: "SINGLE_ASSET" | "MULTI_ASSET";
  availableBalance: string;
  positionSymbols: string[];
  openOrderSymbols: string[];
  symbolStatus: string;
  contractType: string;
  marginType: "ISOLATED" | "CROSS";
  leverage: string;
  maxNotionalValue: string;
  /** The order the exchange will report, or null for "not found". */
  order: ExchangeOrder | null;
  /** Errors injected into the next call of each operation. */
  failSubmitWith: Error | null;
  /**
   * The realistic ambiguous case: the exchange DID accept the order but our
   * response never arrived. When set, a failing submit still lands an order
   * with this status.
   */
  submitLandsWithStatus: string | null;
  submitLandsExecutedQty: string;
  failCancelWith: Error | null;
  /** Persistent while set, from `failQueryFromCall` onwards (1-based). */
  failQueryWith: Error | null;
  failQueryFromCall: number;
  queryCallCount: number;
  failMarginWith: Error | null;
  failLeverageWith: Error | null;
  /** When true, the margin/leverage POST does not actually change state. */
  marginPostIsNoOp: boolean;
  leveragePostIsNoOp: boolean;
  calls: string[];
  mutations: string[];
  cancellationContexts: Record<string, unknown>[];
  submittedParams: Record<string, string>[];
}

const scenario: Scenario = {} as Scenario;

function resetScenario() {
  Object.assign(scenario, {
    positionMode: "HEDGE",
    assetMode: "SINGLE_ASSET",
    availableBalance: "500.00",
    positionSymbols: [],
    openOrderSymbols: [],
    symbolStatus: "TRADING",
    contractType: "PERPETUAL",
    marginType: "ISOLATED",
    leverage: "10",
    maxNotionalValue: "100000",
    order: null,
    failSubmitWith: null,
    submitLandsWithStatus: null,
    submitLandsExecutedQty: "0",
    failCancelWith: null,
    failQueryWith: null,
    failQueryFromCall: 1,
    queryCallCount: 0,
    failMarginWith: null,
    failLeverageWith: null,
    marginPostIsNoOp: false,
    leveragePostIsNoOp: false,
    calls: [],
    mutations: [],
    cancellationContexts: [],
    submittedParams: [],
  } satisfies Scenario);
}

function exchangeOrder(overrides: Partial<ExchangeOrder> = {}): ExchangeOrder {
  return {
    orderId: "900001",
    clientOrderId: "",
    symbol: SYMBOL,
    status: "NEW",
    side: "BUY",
    positionSide: "LONG",
    type: "LIMIT",
    price: "100",
    origQty: "0.375",
    executedQty: "0",
    avgPrice: "0",
    ...overrides,
  };
}

function timeoutError(endpoint: string) {
  return new BinanceError({ kind: "TIMEOUT", message: `Binance ${endpoint} timed out`, endpoint });
}

const readOnlyStub = {
  async getAccountSummary() {
    scenario.calls.push("getAccountSummary");
    return {
      connection: { ok: true, host: "fake", serverTimeMs: Date.now(), serverTimeIso: "", clockOffsetMs: 0, roundTripMs: 1 },
      positionMode: scenario.positionMode,
      assetMode: scenario.assetMode,
      usdtWalletBalance: scenario.availableBalance,
      usdtAvailableBalance: scenario.availableBalance,
      nonZeroPositionCount: scenario.positionSymbols.length,
      openOrderCount: scenario.openOrderSymbols.length,
      openOrderSymbols: scenario.openOrderSymbols,
      positions: scenario.positionSymbols.map((symbol) => ({ symbol })),
      warnings: [],
    };
  },
  async inspectSymbol(symbol: string) {
    scenario.calls.push(`inspectSymbol:${symbol}`);
    return {
      filters: {
        symbol,
        status: scenario.symbolStatus,
        contractType: scenario.contractType,
        tickSize: "0.01",
        stepSize: "0.001",
        minQty: "0.001",
        minNotional: "5",
      },
      brackets: [{ bracket: 1, initialLeverage: 50, notionalCap: "100000", notionalFloor: "0", maintMarginRatio: "0.01", cum: "0" }],
      maxInitialLeverage: 50,
      accountSymbolConfig: null,
    };
  },
  async getSymbolConfiguration(symbol: string) {
    scenario.calls.push(`getSymbolConfiguration:${symbol}`);
    return {
      marginType: scenario.marginType,
      leverage: scenario.leverage,
      maxNotionalValue: scenario.maxNotionalValue,
      isAutoAddMargin: false,
    };
  },
  async getOpenOrders(symbol?: string) {
    scenario.calls.push(`getOpenOrders:${symbol ?? "all"}`);
    return scenario.openOrderSymbols.map((s) => ({ symbol: s }));
  },
  async getPositionRisk(symbol?: string) {
    scenario.calls.push(`getPositionRisk:${symbol ?? "all"}`);
    return scenario.positionSymbols.map((s) => ({ symbol: s }));
  },
  async queryOrderByClientOrderId(symbol: string, clientOrderId: string) {
    scenario.calls.push(`queryOrder:${clientOrderId}`);
    scenario.queryCallCount += 1;
    if (scenario.failQueryWith && scenario.queryCallCount >= scenario.failQueryFromCall) {
      throw scenario.failQueryWith;
    }
    if (!scenario.order || scenario.order.clientOrderId !== clientOrderId) {
      throw new BinanceError({
        kind: "MALFORMED_RESPONSE",
        message: "Order does not exist",
        binanceCode: -2013,
        endpoint: "order",
      });
    }
    const order = scenario.order;
    return {
      orderId: order.orderId,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      status: order.status,
      side: order.side,
      positionSide: order.positionSide,
      type: order.type,
      timeInForce: "GTC",
      price: order.price,
      origQty: order.origQty,
      executedQty: order.executedQty,
      averagePrice: order.avgPrice,
      reduceOnly: false,
      closePosition: false,
      updateTimeMs: Date.now(),
    };
  },
};

let dispatched = 0;

/**
 * Mirrors the real client's operation-aware authorization: exposure-increasing
 * POSTs demand a live-entry authorization (refused when the gates are closed),
 * while recovery cancellation only needs a narrowly scoped context.
 */
const gates = { liveEntryEnabled: true, protectionReady: true };
const LIVE_AUTH = { authorized: true } as const;

const mutationStub = {
  get mutationsDispatched() {
    return dispatched;
  },
  get blockedReason() {
    if (!gates.liveEntryEnabled) return "LIVE_ENTRY_DISABLED";
    if (!gates.protectionReady) return "PROTECTION_NOT_READY";
    return null;
  },
  get isLiveMutationAllowed() {
    return gates.liveEntryEnabled && gates.protectionReady;
  },
  authorizeLiveEntry() {
    const blocked = this.blockedReason;
    if (blocked) throw new BinanceError({ kind: "DISABLED", message: `gate closed: ${blocked}` });
    return LIVE_AUTH;
  },
  authorizeEntryCancellation(input: {
    executionId: string;
    symbol: string;
    clientOrderId: string;
    role: string;
    generation: number;
    reason: string;
  }) {
    if (input.role !== "ENTRY" || input.generation !== 1) throw new Error("narrow scope violated");
    if (input.clientOrderId !== buildClientOrderId(input.executionId, "ENTRY", 1)) {
      throw new Error("client order id does not belong to this execution");
    }
    scenario.cancellationContexts.push({ ...input });
    return { symbol: input.symbol, clientOrderId: input.clientOrderId };
  },
  async setIsolatedMarginType(_authorization: unknown, symbol: string) {
    dispatched += 1;
    scenario.mutations.push(`POST /fapi/v1/marginType ${symbol}`);
    if (scenario.failMarginWith) {
      const error = scenario.failMarginWith;
      scenario.failMarginWith = null;
      throw error;
    }
    if (!scenario.marginPostIsNoOp) scenario.marginType = "ISOLATED";
    return { code: 200, msg: "success" };
  },
  async setInitialLeverage(_authorization: unknown, symbol: string, leverage: number) {
    dispatched += 1;
    scenario.mutations.push(`POST /fapi/v1/leverage ${symbol} ${leverage}`);
    if (scenario.failLeverageWith) {
      const error = scenario.failLeverageWith;
      scenario.failLeverageWith = null;
      throw error;
    }
    if (!scenario.leveragePostIsNoOp) scenario.leverage = String(leverage);
    return { leverage, maxNotionalValue: scenario.maxNotionalValue, symbol };
  },
  async submitLimitEntry(_authorization: unknown, input: Record<string, string>) {
    dispatched += 1;
    scenario.mutations.push(`POST /fapi/v1/order ${input.symbol}`);
    scenario.submittedParams.push({ ...input });
    if (scenario.failSubmitWith) {
      const error = scenario.failSubmitWith;
      scenario.failSubmitWith = null;
      if (scenario.submitLandsWithStatus) {
        scenario.order = exchangeOrder({
          clientOrderId: input.newClientOrderId,
          side: input.side,
          positionSide: input.positionSide,
          price: input.price,
          origQty: input.quantity,
          status: scenario.submitLandsWithStatus,
          executedQty: scenario.submitLandsExecutedQty,
          avgPrice: scenario.submitLandsExecutedQty === "0" ? "0" : "100",
        });
      }
      throw error;
    }
    scenario.order = exchangeOrder({
      clientOrderId: input.newClientOrderId,
      side: input.side,
      positionSide: input.positionSide,
      price: input.price,
      origQty: input.quantity,
      status: "NEW",
    });
    return { orderId: scenario.order.orderId, clientOrderId: input.newClientOrderId, symbol: input.symbol, status: "NEW" };
  },
  async cancelReservedEntryOrder(context: { symbol: string; clientOrderId: string }) {
    const symbol = context.symbol;
    const origClientOrderId = context.clientOrderId;
    dispatched += 1;
    scenario.mutations.push(`DELETE /fapi/v1/order ${symbol}`);
    if (scenario.failCancelWith) {
      const error = scenario.failCancelWith;
      scenario.failCancelWith = null;
      throw error;
    }
    if (scenario.order && scenario.order.clientOrderId === origClientOrderId) {
      scenario.order.status = "CANCELED";
    }
    return { orderId: "900001", clientOrderId: origClientOrderId, symbol, status: "CANCELED" };
  },
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let executions: ExecutionServiceType;
let entries: EntryLifecycleServiceType;
let profileId = "";
let sequence = 0;

function readyPlan(direction: "LONG" | "SHORT" = "LONG"): DynamicLeveragePlan {
  return {
    status: "READY",
    reason: null,
    reasonMessage: null,
    symbol: SYMBOL,
    direction,
    entryPrice: "100",
    stopLoss: direction === "LONG" ? "96" : "104",
    calculatedStopLoss: direction === "LONG" ? "96" : "104",
    executableStopLoss: direction === "LONG" ? "96" : "104",
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
    estimatedLiquidationPrice: direction === "LONG" ? "90.1" : "109.9",
    requiredLiquidationBoundary: direction === "LONG" ? "94" : "106",
    liquidationBufferRatio: "0.5",
    liquidationDistance: "5.9",
    safetyBufferDistance: "2",
    marginDifferenceFromTarget: "0",
    candidates: [],
    warnings: [],
  } as DynamicLeveragePlan;
}

/** Creates an execution already admitted by Phase 5 (PREFLIGHT + PASS). */
async function admittedExecution(direction: "LONG" | "SHORT" = "LONG") {
  sequence += 1;
  const alert = await prisma!.alert.create({
    data: {
      symbol: SYMBOL,
      assetType: "CRYPTO",
      exchange: "SYNTHETIC",
      timeframe: "15m",
      price: 100,
      signal: direction,
      indicatorName: `${SYNTHETIC_TAG}-${sequence}`,
      rawPayload: { note: SYNTHETIC_TAG },
      triggeredAt: new Date(),
    },
  });

  const created = await executions.createExecutionFromReadyPlan({
    executionProfileId: profileId,
    alertId: alert.id,
    plan: readyPlan(direction),
    positionSide: direction,
    selectedLookback: 200,
    snapshots: { exchangeFilters: { tickSize: "0.01", stepSize: "0.001" } },
  });

  await prisma!.safetyAdmission.create({
    data: {
      tradeExecutionId: created.id,
      evaluatedVersion: created.version,
      evaluatedAt: new Date(),
      decision: "PASS",
      reasonCode: null,
      reservedRiskUsd: "1.50",
      reservedMarginUsd: "4.9999995",
    },
  });

  return prisma!.tradeExecution.update({
    where: { id: created.id },
    data: { status: "PREFLIGHT", version: { increment: 1 } },
  });
}

beforeAll(async () => {
  if (!prisma || !available) return;

  executions = new ExecutionService(prisma);
  entries = new EntryLifecycleService(
    prisma,
    readOnlyStub as unknown as ConstructorParameters<typeof EntryLifecycleService>[1],
    mutationStub as unknown as ConstructorParameters<typeof EntryLifecycleService>[2]
  );

  const profile = await prisma.executionProfile.create({
    data: {
      name: "Phase 6 synthetic profile",
      accountIdentifier: `${SYNTHETIC_TAG}-account`,
      environment: "TESTNET",
      isEnabled: true,
    },
  });
  profileId = profile.id;
  await prisma.executionSafetyPolicy.create({
    data: { executionProfileId: profileId, killSwitchActive: false },
  });
});

afterEach(async () => {
  resetScenario();
  dispatched = 0;
  gates.liveEntryEnabled = true;
  gates.protectionReady = true;
  runtimeEnv.EXECUTION_GLOBAL_KILL_SWITCH = false;
  runtimeEnv.EXECUTION_LIVE_ENTRY_ENABLED = true;
  runtimeEnv.EXECUTION_PROTECTION_READY = true;
  if (prisma && available && profileId) {
    await prisma.executionSafetyPolicy.updateMany({
      where: { executionProfileId: profileId },
      data: { killSwitchActive: false },
    });
    await prisma.executionProfile.updateMany({ where: { id: profileId }, data: { isEnabled: true } });
  }
  if (!prisma || !available) return;
  // Every synthetic execution uses the same symbol, so leftovers from one test
  // would trip the next one's "another local execution is active" guard.
  // Retired directly (not through the state machine) — this is fixture
  // teardown, not a lifecycle transition under test.
  await prisma.tradeExecution.updateMany({
    where: { executionProfileId: profileId, status: { notIn: ["FAILED", "SKIPPED"] } },
    data: { status: "FAILED" },
  });
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    const ids = (
      await prisma.tradeExecution.findMany({ where: { executionProfileId: profileId }, select: { id: true } })
    ).map((execution) => execution.id);
    if (ids.length > 0) {
      await prisma.safetyAdmission.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      // Phase 9 verification history is Restrict-linked audit data: it must go
      // before the execution it belongs to.
      // Phase 9 notifications are Restrict-linked; they must go first.
      await prisma.executionNotification.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.executionProtectionVerification.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.binanceOrder.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.tradeExecution.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionProfile.deleteMany({ where: { accountIdentifier: `${SYNTHETIC_TAG}-account` } });
    await prisma.alert.deleteMany({ where: { indicatorName: { startsWith: SYNTHETIC_TAG } } });
  }
  await prisma.$disconnect();
});

resetScenario();
const maybe = () => (available ? it : it.skip);

const at = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000);

// ===========================================================================

describe("live gates", () => {
  maybe()("dispatches nothing and reserves nothing when the gates are closed", async () => {
    const execution = await admittedExecution();

    // The REAL mutation client with closed gates and a transport that fails
    // the test if it is ever called.
    const forbiddenTransport = () => {
      throw new Error("A mutation was dispatched while the live gates were closed.");
    };
    const realClient = new BinanceUsdMExecutionClient({
      baseUrl: "https://testnet.binancefuture.example",
      apiKey: "synthetic-key-000000000000",
      apiSecret: "synthetic-secret-0000000000",
      liveEntryEnabled: false,
      protectionReady: false,
      transport: forbiddenTransport as never,
    });
    const gated = new EntryLifecycleService(
      prisma!,
      readOnlyStub as never,
      realClient as never
    );

    const outcome = await gated.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(false);
    expect(["LIVE_ENTRY_DISABLED", "PROTECTION_NOT_READY"]).toContain(outcome.reasonCode);
    expect(realClient.mutationsDispatched).toBe(0);
    expect(outcome.mutationsDispatched).toBe(0);

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("PREFLIGHT");
    expect(reloaded.version).toBe(execution.version);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
  });
});

describe("pre-submission revalidation", () => {
  const revalidationCase = async (mutate: () => void | Promise<void>, expectedReason: string) => {
    const execution = await admittedExecution();
    await mutate();
    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    expect(outcome.reasonCode).toBe(expectedReason);
    expect(scenario.mutations).toHaveLength(0);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
    return outcome;
  };

  maybe()("rejects a stale expectedVersion", async () => {
    const execution = await admittedExecution();
    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version + 4,
      evaluatedAt: at(),
    });
    expect(outcome.reasonCode).toBe("CAPACITY_OR_VERSION_CONFLICT");
    expect(scenario.mutations).toHaveLength(0);
  });

  maybe()("rejects an execution that is not PREFLIGHT", async () => {
    const execution = await admittedExecution();
    await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { status: "PLAN_READY" } });
    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    expect(outcome.reasonCode).toBe("EXECUTION_NOT_PREFLIGHT");
  });

  maybe()("rejects a missing PASS admission", async () => {
    const execution = await admittedExecution();
    await prisma!.safetyAdmission.updateMany({
      where: { tradeExecutionId: execution.id },
      data: { decision: "SKIP" },
    });
    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    expect(outcome.reasonCode).toBe("SAFETY_ADMISSION_NOT_READY");
  });

  maybe()("blocks when the profile kill switch is re-armed", async () => {
    const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({
      where: { executionProfileId: profileId },
    });
    await prisma!.executionSafetyPolicy.update({
      where: { id: policy.id },
      data: { killSwitchActive: true },
    });
    await revalidationCase(() => undefined, "KILL_SWITCH_RECHECK_ACTIVE");
    await prisma!.executionSafetyPolicy.update({ where: { id: policy.id }, data: { killSwitchActive: false } });
  });

  maybe()("rejects a HEDGE mismatch", async () => {
    await revalidationCase(() => {
      scenario.positionMode = "ONE_WAY";
    }, "POSITION_MODE_MISMATCH");
  });

  maybe()("rejects a multi-asset account", async () => {
    await revalidationCase(() => {
      scenario.assetMode = "MULTI_ASSET";
    }, "ASSET_MODE_MISMATCH");
  });

  maybe()("blocks configuration and submission when an external position appeared", async () => {
    await revalidationCase(() => {
      scenario.positionSymbols = [SYMBOL];
    }, "SYMBOL_EXPOSURE_CHANGED");
  });

  maybe()("blocks configuration and submission when an external open order appeared", async () => {
    await revalidationCase(() => {
      scenario.openOrderSymbols = [SYMBOL];
    }, "SYMBOL_EXPOSURE_CHANGED");
  });

  maybe()("rejects a stale entry deadline", async () => {
    const execution = await admittedExecution();
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { entryExpiresAt: new Date(Date.now() - 60_000) },
    });
    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    expect(outcome.reasonCode).toBe("SIGNAL_OR_ENTRY_DEADLINE_EXPIRED");
  });

  maybe()("rejects a symbol that is no longer TRADING", async () => {
    await revalidationCase(() => {
      scenario.symbolStatus = "BREAK";
    }, "SYMBOL_STATE_CHANGED");
  });

  maybe()("rejects frozen values that no longer satisfy the current filters", async () => {
    const execution = await admittedExecution();
    // Quantity 0.375 is no longer a multiple of a coarser step size, and
    // Phase 6 must fail closed rather than re-round it.
    const original = readOnlyStub.inspectSymbol;
    readOnlyStub.inspectSymbol = async (symbol: string) => {
      const result = await original.call(readOnlyStub, symbol);
      return { ...result, filters: { ...result.filters, stepSize: "0.1" } };
    };

    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    readOnlyStub.inspectSymbol = original;

    expect(outcome.reasonCode).toBe("SYMBOL_STATE_CHANGED");
    expect(scenario.mutations).toHaveLength(0);
  });

  maybe()("rejects an insufficient available balance", async () => {
    await revalidationCase(() => {
      scenario.availableBalance = "0.01";
    }, "SAFETY_ADMISSION_NOT_READY");
  });
});

describe("entry intent reservation", () => {
  maybe()("creates exactly one ENTRY generation 1 row and moves to ENTRY_SUBMITTING", async () => {
    const execution = await admittedExecution();
    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    const orders = await prisma!.binanceOrder.findMany({ where: { tradeExecutionId: execution.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0].role).toBe("ENTRY");
    expect(orders[0].generation).toBe(1);
    expect(orders[0].clientOrderId).toBe(buildClientOrderId(execution.id, "ENTRY", 1));
    expect(orders[0].orderType).toBe("LIMIT");
    expect(orders[0].timeInForce).toBe("GTC");
    expect(outcome.ok).toBe(true);
  });

  maybe()("records the reservation event with the bumped version as its sequence", async () => {
    const execution = await admittedExecution();
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    const reserved = await prisma!.executionEvent.findFirst({
      where: { tradeExecutionId: execution.id, eventType: "ORDER_RESERVED" },
    });
    expect(reserved).not.toBeNull();
    expect(reserved!.sequenceNumber).toBe(execution.version + 1);
    expect(reserved!.fromStatus).toBe("PREFLIGHT");
    expect(reserved!.toStatus).toBe("ENTRY_SUBMITTING");
  });

  maybe()("reserves intent BEFORE any exchange mutation", async () => {
    const execution = await admittedExecution();
    scenario.marginType = "CROSS";
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    const order = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });
    expect(order.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    // The reservation exists even though mutations followed it.
    expect(scenario.mutations.length).toBeGreaterThan(0);
  });

  maybe()("replays an identical retry with the same client order id and no new row", async () => {
    const execution = await admittedExecution();
    const first = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });

    const second = await entries.resumeEntrySubmission({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    expect(second.order!.clientOrderId).toBe(first.order!.clientOrderId);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(1);
    expect(
      await prisma!.executionEvent.count({ where: { tradeExecutionId: execution.id, eventType: "ORDER_RESERVED" } })
    ).toBe(1);
  });

  maybe()("creates exactly one row under concurrent reservation", async () => {
    const execution = await admittedExecution();
    const results = await Promise.allSettled([
      entries.prepareEntrySubmission({ executionId: execution.id, expectedVersion: execution.version, evaluatedAt: at() }),
      entries.prepareEntrySubmission({ executionId: execution.id, expectedVersion: execution.version, evaluatedAt: at() }),
      entries.prepareEntrySubmission({ executionId: execution.id, expectedVersion: execution.version, evaluatedAt: at() }),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(1);
  });

  maybe()("never creates a generation 2 order", async () => {
    const execution = await admittedExecution();
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    scenario.failSubmitWith = timeoutError("newOrder");
    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.resumeEntrySubmission({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    const generations = await prisma!.binanceOrder.findMany({
      where: { tradeExecutionId: execution.id },
      select: { generation: true },
    });
    expect(generations.map((order) => order.generation)).toEqual([1]);
  });
});

describe("margin type configuration", () => {
  maybe()("issues no POST when the symbol is already ISOLATED", async () => {
    const execution = await admittedExecution();
    scenario.marginType = "ISOLATED";
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    expect(scenario.mutations.filter((call) => call.includes("marginType"))).toHaveLength(0);
  });

  maybe()("performs one POST and verifies with GET when the symbol is CROSS", async () => {
    const execution = await admittedExecution();
    scenario.marginType = "CROSS";
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(scenario.mutations.filter((call) => call.includes("marginType"))).toHaveLength(1);
    // Read again after the change: the success message is never taken as proof.
    expect(scenario.calls.filter((call) => call.startsWith("getSymbolConfiguration")).length).toBeGreaterThanOrEqual(2);
    expect(scenario.marginType).toBe("ISOLATED");
  });

  maybe()("continues when an unknown result is followed by verified ISOLATED", async () => {
    const execution = await admittedExecution();
    scenario.marginType = "CROSS";
    scenario.failMarginWith = timeoutError("setMarginType");
    // The change actually landed despite the timeout.
    const originalConfig = readOnlyStub.getSymbolConfiguration;
    let reads = 0;
    readOnlyStub.getSymbolConfiguration = async (symbol: string) => {
      reads += 1;
      const result = await originalConfig.call(readOnlyStub, symbol);
      return { ...result, marginType: reads === 1 ? "CROSS" : "ISOLATED" } as typeof result;
    };

    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    readOnlyStub.getSymbolConfiguration = originalConfig;

    expect(outcome.reasonCode).not.toBe("MARGIN_TYPE_RESULT_UNKNOWN");
    expect(scenario.mutations.some((call) => call.includes("/fapi/v1/order"))).toBe(true);
  });

  maybe()("stops when an unknown result is not followed by a verified state", async () => {
    const execution = await admittedExecution();
    scenario.marginType = "CROSS";
    scenario.marginPostIsNoOp = true;
    scenario.failMarginWith = timeoutError("setMarginType");

    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.reasonCode).toBe("MARGIN_TYPE_RESULT_UNKNOWN");
    expect(scenario.mutations.some((call) => call.includes("/fapi/v1/order"))).toBe(false);
  });

  maybe()("reports a verification mismatch when the state simply did not change", async () => {
    const execution = await admittedExecution();
    scenario.marginType = "CROSS";
    scenario.marginPostIsNoOp = true;

    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    expect(outcome.reasonCode).toBe("MARGIN_TYPE_VERIFICATION_MISMATCH");
  });

  maybe()("never cancels or closes exposure and never reverts to CROSS", async () => {
    const execution = await admittedExecution();
    scenario.marginType = "CROSS";
    scenario.leveragePostIsNoOp = true; // force a later failure
    scenario.leverage = "3";

    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    // Margin type stays ISOLATED — no automatic rollback.
    expect(scenario.marginType).toBe("ISOLATED");
    expect(scenario.mutations.filter((call) => call.includes("marginType"))).toHaveLength(1);
    expect(scenario.mutations.some((call) => call.startsWith("DELETE"))).toBe(false);
  });
});

describe("leverage configuration", () => {
  maybe()("issues no POST when the leverage already matches", async () => {
    const execution = await admittedExecution();
    scenario.leverage = "10";
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    expect(scenario.mutations.filter((call) => call.includes("leverage"))).toHaveLength(0);
  });

  maybe()("sends the exact frozen leverage", async () => {
    const execution = await admittedExecution();
    scenario.leverage = "5";
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    expect(scenario.mutations).toContain(`POST /fapi/v1/leverage ${SYMBOL} 10`);
  });

  maybe()("rejects a GET verification mismatch", async () => {
    const execution = await admittedExecution();
    scenario.leverage = "5";
    scenario.leveragePostIsNoOp = true;

    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    expect(outcome.reasonCode).toBe("LEVERAGE_VERIFICATION_MISMATCH");
    expect(scenario.mutations.some((call) => call.includes("/fapi/v1/order"))).toBe(false);
  });

  maybe()("rejects a max notional below the frozen position notional", async () => {
    const execution = await admittedExecution();
    scenario.maxNotionalValue = "10"; // frozen notional is 37.5

    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    expect(outcome.reasonCode).toBe("LEVERAGE_NOTIONAL_LIMIT_MISMATCH");
    expect(scenario.mutations.some((call) => call.includes("/fapi/v1/order"))).toBe(false);
  });

  maybe()("continues when a timeout is followed by the verified leverage", async () => {
    const execution = await admittedExecution();
    scenario.leverage = "5";
    scenario.failLeverageWith = timeoutError("setLeverage");
    const originalConfig = readOnlyStub.getSymbolConfiguration;
    let reads = 0;
    readOnlyStub.getSymbolConfiguration = async (symbol: string) => {
      reads += 1;
      const result = await originalConfig.call(readOnlyStub, symbol);
      return { ...result, leverage: reads === 1 ? "5" : "10" } as typeof result;
    };

    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    readOnlyStub.getSymbolConfiguration = originalConfig;

    expect(outcome.reasonCode).not.toBe("LEVERAGE_RESULT_UNKNOWN");
    expect(scenario.mutations.some((call) => call.includes("/fapi/v1/order"))).toBe(true);
  });

  maybe()("never reverts leverage after a later failure", async () => {
    const execution = await admittedExecution();
    scenario.leverage = "5";
    scenario.failSubmitWith = new BinanceError({ kind: "AUTH", message: "rejected", endpoint: "newOrder" });

    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(scenario.leverage).toBe("10");
    expect(scenario.mutations.filter((call) => call.includes("leverage"))).toHaveLength(1);
  });
});

describe("submission and reconciliation", () => {
  const submit = async (direction: "LONG" | "SHORT" = "LONG") => {
    const execution = await admittedExecution(direction);
    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    return { execution, outcome };
  };

  maybe()("submits a LONG entry with BUY/LONG and exact frozen values", async () => {
    await submit("LONG");
    const params = scenario.submittedParams[0];
    expect(params.side).toBe("BUY");
    expect(params.positionSide).toBe("LONG");
    expect(params.price).toBe("100");
    expect(params.quantity).toBe("0.375");
  });

  maybe()("submits a SHORT entry with SELL/SHORT", async () => {
    await submit("SHORT");
    const params = scenario.submittedParams[0];
    expect(params.side).toBe("SELL");
    expect(params.positionSide).toBe("SHORT");
  });

  maybe()("maps an acknowledged NEW order to ENTRY_PENDING", async () => {
    const { execution } = await submit();
    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const order = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });

    expect(reloaded.status).toBe("ENTRY_PENDING");
    expect(order.status).toBe("NEW");
    expect(order.exchangeOrderId).toBe("900001");
    expect(order.entryOrderExpiresAt).not.toBeNull();
  });

  maybe()("maps a partial fill to PARTIALLY_FILLED with the exact quantity", async () => {
    const { execution } = await submit();
    scenario.order!.status = "PARTIALLY_FILLED";
    scenario.order!.executedQty = "0.125";
    scenario.order!.avgPrice = "99.98";

    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const order = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });
    expect(reloaded.status).toBe("PARTIALLY_FILLED");
    expect(order.executedQuantity.toString()).toBe("0.125");
    expect(reloaded.filledQuantity?.toString()).toBe("0.125");
    expect(reloaded.averageFillPrice?.toString()).toBe("99.98");
    expect(reloaded.firstFillAt).not.toBeNull();
  });

  maybe()("maps a full fill to ENTRY_FILLED and stamps entryFilledAt once", async () => {
    const { execution } = await submit();
    scenario.order!.status = "FILLED";
    scenario.order!.executedQty = "0.375";
    scenario.order!.avgPrice = "100";

    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("ENTRY_FILLED");
    expect(reloaded.entryFilledAt).not.toBeNull();
    const stamped = reloaded.entryFilledAt;

    // A second reconciliation must not move the stamp.
    await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: reloaded.version,
      evaluatedAt: at(60),
    });
    const again = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(again.entryFilledAt?.toISOString()).toBe(stamped?.toISOString());
  });

  maybe()("queries the same client order id after a submission timeout", async () => {
    const execution = await admittedExecution();
    const clientOrderId = buildClientOrderId(execution.id, "ENTRY", 1);
    scenario.failSubmitWith = timeoutError("newOrder");
    // The order reached the book, but the response never came back.
    scenario.submitLandsWithStatus = "NEW";

    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(scenario.calls).toContain(`queryOrder:${clientOrderId}`);
    // Exactly one submission was ever dispatched — no new id, no second order.
    expect(scenario.mutations.filter((call) => call.startsWith("POST /fapi/v1/order"))).toHaveLength(1);
    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("ENTRY_PENDING");
  });

  maybe()("reaches ENTRY_FILLED when a timeout hid a completed fill", async () => {
    const execution = await admittedExecution();
    scenario.failSubmitWith = timeoutError("newOrder");
    scenario.submitLandsWithStatus = "FILLED";
    scenario.submitLandsExecutedQty = "0.375";

    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("ENTRY_FILLED");
  });

  maybe()("stays unresolved when the query is temporarily unavailable", async () => {
    const execution = await admittedExecution();
    scenario.failSubmitWith = timeoutError("newOrder");
    scenario.submitLandsWithStatus = "NEW";
    // The pre-submission look-ahead succeeds (nothing there yet); the
    // post-submission reconciliation query is the one that is rate-limited.
    scenario.failQueryWith = new BinanceError({ kind: "RATE_LIMIT", message: "Too many requests", endpoint: "order" });
    scenario.failQueryFromCall = 2;

    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("ENTRY_ORDER_QUERY_UNAVAILABLE");
    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    // Still submitting — never silently FAILED, never a second order.
    expect(reloaded.status).toBe("ENTRY_SUBMITTING");
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(1);
  });

  maybe()("escalates a contradictory order identity to MANUAL_INTERVENTION", async () => {
    const { execution } = await submit();
    // The exchange reports a different side under our client order id.
    scenario.order!.side = "SELL";

    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const outcome = await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    expect(outcome.reasonCode).toBe("ENTRY_ORDER_IDENTITY_MISMATCH");
    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("MANUAL_INTERVENTION");
    expect(reloaded.requiresManualIntervention).toBe(true);
    // Local intent was not rewritten.
    const order = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });
    expect(order.side).toBe("BUY");
  });

  maybe()("never moves executed quantity backwards", async () => {
    const { execution } = await submit();
    scenario.order!.status = "PARTIALLY_FILLED";
    scenario.order!.executedQty = "0.200";
    let current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    // A stale read now reports less filled.
    scenario.order!.executedQty = "0.050";
    current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    const order = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });
    expect(order.executedQuantity.toString()).toBe("0.2");
  });

  maybe()("never clears a known exchange order id", async () => {
    const { execution } = await submit();
    scenario.order!.orderId = "";
    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    const order = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });
    expect(order.exchangeOrderId).toBe("900001");
  });

  maybe()("rejects a stale version during reconciliation", async () => {
    const { execution } = await submit();
    const outcome = await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: execution.version, // deliberately stale
      evaluatedAt: at(),
    });
    expect(outcome.reasonCode).toBe("CAPACITY_OR_VERSION_CONFLICT");
  });

  maybe()("lets only one of two concurrent reconciliations commit", async () => {
    const { execution } = await submit();
    scenario.order!.status = "PARTIALLY_FILLED";
    scenario.order!.executedQty = "0.100";
    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });

    const results = await Promise.all([
      entries.reconcileEntryOrder({ executionId: execution.id, expectedVersion: current.version, evaluatedAt: at() }),
      entries.reconcileEntryOrder({ executionId: execution.id, expectedVersion: current.version, evaluatedAt: at() }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      (await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } })).version
    ).toBe(current.version + 1);
  });

  maybe()("rolls back the order and execution updates when the event insert fails", async () => {
    const { execution } = await submit();
    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const orderBefore = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });

    // Squat on the sequence number the reconciliation will need.
    await prisma!.executionEvent.create({
      data: {
        tradeExecutionId: execution.id,
        sequenceNumber: current.version + 1,
        eventType: "ENTRY_RECONCILED",
        message: "sequence squatter",
      },
    });

    scenario.order!.status = "FILLED";
    scenario.order!.executedQty = "0.375";
    await expect(
      entries.reconcileEntryOrder({
        executionId: execution.id,
        expectedVersion: current.version,
        evaluatedAt: at(),
      })
    ).rejects.toThrow();

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const orderAfter = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });
    expect(reloaded.version).toBe(current.version);
    expect(reloaded.status).toBe(current.status);
    expect(orderAfter.status).toBe(orderBefore.status);
    expect(orderAfter.executedQuantity.toString()).toBe(orderBefore.executedQuantity.toString());
  });
});

// ===========================================================================
// STATE-MACHINE ENFORCEMENT IN RECONCILIATION.
//
// `mapOrderToExecutionStatus` answers "what is the ORDER". Its answer used to
// be written to TradeExecution.status directly, pinned only on `version`, with
// no canTransition check anywhere in the path — so an execution still in
// ENTRY_SUBMITTING whose order came back CANCELED with a zero fill was written
// straight to ENTRY_EXPIRED (or to CANCELED for an operator cancellation).
// Both are edges the graph deliberately omits: once submission is attempted an
// order may exist, so the lifecycle must not casually terminalize.
//
// These prove the illegal target is never persisted, that the replacement is a
// legal edge, and that the observation itself is still recorded.
// ===========================================================================

describe("reconciliation cannot persist an illegal transition", () => {
  const eventsOf = async (id: string) =>
    prisma!.executionEvent.findMany({ where: { tradeExecutionId: id }, orderBy: { sequenceNumber: "asc" } });

  /** An execution whose submission never resolved: ENTRY_SUBMITTING, order reserved. */
  const stuckSubmitting = async () => {
    const execution = await admittedExecution();
    scenario.failSubmitWith = timeoutError("newOrder");
    scenario.submitLandsWithStatus = "NEW";
    // Call 1 is the pre-submission look-ahead; call 2 is the reconciliation.
    scenario.failQueryWith = new BinanceError({ kind: "RATE_LIMIT", message: "Too many requests", endpoint: "order" });
    scenario.failQueryFromCall = 2;

    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    scenario.failQueryWith = null;
    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(current.status).toBe("ENTRY_SUBMITTING");
    return current;
  };

  maybe()("1. parks ENTRY_SUBMITTING instead of writing ENTRY_EXPIRED on a confirmed zero-fill cancel", async () => {
    const execution = await admittedExecution();
    scenario.failSubmitWith = timeoutError("newOrder");
    // The order reached the book and was then cancelled before our first read.
    scenario.submitLandsWithStatus = "CANCELED";
    scenario.submitLandsExecutedQty = "0";

    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    // The mapped target was ENTRY_EXPIRED — terminal, and illegal from here.
    expect(reloaded.status).toBe("MANUAL_INTERVENTION");
    expect(reloaded.requiresManualIntervention).toBe(true);
    expect(reloaded.decisionReasonCode).toBe("MANUAL_REVIEW_REQUIRED");
    expect(outcome.ok).toBe(false);

    const events = await eventsOf(execution.id);
    // No event anywhere claims the refused transition.
    expect(events.some((event) => event.toStatus === "ENTRY_EXPIRED")).toBe(false);
    const last = events.at(-1)!;
    expect(last.eventType).toBe("MANUAL_INTERVENTION_REQUIRED");
    expect(last.fromStatus).toBe("ENTRY_SUBMITTING");
    expect(last.toStatus).toBe("MANUAL_INTERVENTION");
    // The refusal is auditable rather than silent.
    expect((last.metadata as Record<string, unknown>).mappedExecutionStatus).toBe("ENTRY_EXPIRED");
    expect((last.metadata as Record<string, unknown>).refusedStatus).toBe("ENTRY_EXPIRED");

    // The observation was still persisted — a refused status never discards evidence.
    const order = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });
    expect(order.status).toBe("CANCELED");
  });

  maybe()("2. parks ENTRY_SUBMITTING instead of writing CANCELED on an operator cancellation", async () => {
    const execution = await stuckSubmitting();
    scenario.order!.status = "CANCELED";
    scenario.order!.executedQty = "0";

    // The only caller-suppliable route to a CANCELED mapping.
    await entries.reconcileEntryOrder(
      { executionId: execution.id, expectedVersion: execution.version, evaluatedAt: at() },
      "OPERATOR"
    );

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("MANUAL_INTERVENTION");
    expect(reloaded.version).toBe(execution.version + 1);
    const events = await eventsOf(execution.id);
    expect(events.some((event) => event.toStatus === "CANCELED")).toBe(false);
    expect((events.at(-1)!.metadata as Record<string, unknown>).refusedStatus).toBe("CANCELED");
  });

  maybe()("3. parks ENTRY_SUBMITTING instead of writing ENTRY_EXPIRED at TTL", async () => {
    const execution = await stuckSubmitting();
    const order = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });

    // The realistic production route: TTL is due while the submission never
    // resolved, so the remainder is cancelled and reconciled with cause TTL.
    await entries.expireEntryOrderIfDue({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: order.entryOrderExpiresAt!,
    });

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("MANUAL_INTERVENTION");
    const events = await eventsOf(execution.id);
    expect(events.some((event) => event.toStatus === "ENTRY_EXPIRED")).toBe(false);
  });

  maybe()("4. every replacement transition is one the state machine allows", async () => {
    const { canTransition } = await import("../src/modules/execution/execution-status");
    const execution = await stuckSubmitting();
    scenario.order!.status = "CANCELED";

    await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    const events = await eventsOf(execution.id);
    for (const event of events) {
      if (!event.fromStatus || !event.toStatus || event.fromStatus === event.toStatus) continue;
      expect(
        canTransition(event.fromStatus as never, event.toStatus as never).allowed,
        `${event.fromStatus} -> ${event.toStatus}`
      ).toBe(true);
    }
  });

  maybe()("5. a legal ENTRY_SUBMITTING mapping is untouched", async () => {
    const execution = await stuckSubmitting();
    scenario.order!.status = "PARTIALLY_FILLED";
    scenario.order!.executedQty = "0.125";
    scenario.order!.avgPrice = "99.98";

    const outcome = await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(true);
    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("PARTIALLY_FILLED");
    expect(reloaded.filledQuantity?.toString()).toBe("0.125");
    const last = (await eventsOf(execution.id)).at(-1)!;
    expect(last.eventType).toBe("ENTRY_RECONCILED");
    expect((last.metadata as Record<string, unknown>).refusedStatus).toBeNull();
  });

  maybe()("6. PARTIALLY_FILLED keeps its fill and never regresses to a zero-fill terminal", async () => {
    const execution = await admittedExecution();
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    scenario.order!.status = "PARTIALLY_FILLED";
    scenario.order!.executedQty = "0.125";
    scenario.order!.avgPrice = "99.98";
    let current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });
    expect((await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } })).status).toBe(
      "PARTIALLY_FILLED"
    );

    // The remainder is cancelled and the exchange now reports a zero fill.
    scenario.order!.status = "CANCELED";
    scenario.order!.executedQty = "0";
    current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    // mergeFillProgress preserves the fill, so the mapping still sees exposure.
    expect(reloaded.status).toBe("MANUAL_INTERVENTION");
    expect(reloaded.filledQuantity?.toString()).toBe("0.125");
    const order = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });
    expect(order.executedQuantity.toString()).toBe("0.125");
    // This one was a LEGAL edge, not a refusal.
    expect((await eventsOf(execution.id)).at(-1)!.eventType).toBe("ENTRY_RECONCILED");
  });

  maybe()("7. a parked execution observes the exchange but never un-parks itself", async () => {
    const { execution } = await (async () => {
      const created = await admittedExecution();
      await entries.prepareEntrySubmission({
        executionId: created.id,
        expectedVersion: created.version,
        evaluatedAt: at(),
      });
      return { execution: created };
    })();

    // Park it through a real production path: a contradictory order identity.
    scenario.order!.side = "SELL";
    let current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });
    expect((await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } })).status).toBe(
      "MANUAL_INTERVENTION"
    );

    // The identity now matches and the order is fully filled.
    scenario.order!.side = "BUY";
    scenario.order!.status = "FILLED";
    scenario.order!.executedQty = "0.375";
    scenario.order!.avgPrice = "100";
    current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    // ENTRY_FILLED is not a legal exit from MANUAL_INTERVENTION.
    expect(reloaded.status).toBe("MANUAL_INTERVENTION");
    // The fill was still recorded, so a human sees the real exposure.
    expect(reloaded.filledQuantity?.toString()).toBe("0.375");
    const last = (await eventsOf(execution.id)).at(-1)!;
    expect(last.fromStatus).toBe("MANUAL_INTERVENTION");
    expect(last.toStatus).toBe("MANUAL_INTERVENTION");
    expect((last.metadata as Record<string, unknown>).refusedStatus).toBe("ENTRY_FILLED");
  });

  maybe()("8. a stale version writes nothing and appends no event on the refusal path", async () => {
    const execution = await stuckSubmitting();
    scenario.order!.status = "CANCELED";
    const before = await eventsOf(execution.id);

    const outcome = await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: execution.version - 1, // deliberately stale
      evaluatedAt: at(),
    });

    expect(outcome.reasonCode).toBe("CAPACITY_OR_VERSION_CONFLICT");
    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("ENTRY_SUBMITTING");
    expect(reloaded.version).toBe(execution.version);
    expect(await eventsOf(execution.id)).toHaveLength(before.length);
  });

  maybe()("9. repeated reconciliation converges and never reaches the refused status", async () => {
    const execution = await stuckSubmitting();
    scenario.order!.status = "CANCELED";

    for (let round = 0; round < 3; round += 1) {
      const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
      await entries.reconcileEntryOrder({
        executionId: execution.id,
        expectedVersion: current.version,
        evaluatedAt: at(round),
      });
      const after = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
      expect(after.status, `round ${round}`).toBe("MANUAL_INTERVENTION");
    }

    const events = await eventsOf(execution.id);
    expect(events.some((event) => ["ENTRY_EXPIRED", "CANCELED"].includes(event.toStatus ?? ""))).toBe(false);
  });
});

describe("TTL cancellation", () => {
  const submitted = async () => {
    const execution = await admittedExecution();
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    const order = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });
    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    return { execution: current, order };
  };

  maybe()("does nothing before the deadline", async () => {
    const { execution, order } = await submitted();
    const outcome = await entries.expireEntryOrderIfDue({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(order.entryOrderExpiresAt!.getTime() - 1),
    });

    expect(outcome.ok).toBe(false);
    expect(scenario.mutations.some((call) => call.startsWith("DELETE"))).toBe(false);
    expect((await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } })).status).toBe(
      "ENTRY_PENDING"
    );
  });

  maybe()("cancels a still-NEW order at the exact deadline and reaches ENTRY_EXPIRED", async () => {
    const { execution, order } = await submitted();
    await entries.expireEntryOrderIfDue({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: order.entryOrderExpiresAt!,
    });

    expect(scenario.mutations.filter((call) => call.startsWith("DELETE"))).toHaveLength(1);
    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("ENTRY_EXPIRED");
  });

  maybe()("never cancels an order that filled before the deadline", async () => {
    const { execution, order } = await submitted();
    scenario.order!.status = "FILLED";
    scenario.order!.executedQty = "0.375";
    scenario.order!.avgPrice = "100";

    await entries.expireEntryOrderIfDue({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: order.entryOrderExpiresAt!,
    });

    expect(scenario.mutations.some((call) => call.startsWith("DELETE"))).toBe(false);
    expect((await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } })).status).toBe(
      "ENTRY_FILLED"
    );
  });

  maybe()("cancels only the remainder of a partial fill and parks it for a human", async () => {
    const { execution, order } = await submitted();
    scenario.order!.status = "PARTIALLY_FILLED";
    scenario.order!.executedQty = "0.150";
    scenario.order!.avgPrice = "99.99";

    await entries.expireEntryOrderIfDue({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: order.entryOrderExpiresAt!,
    });

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const finalOrder = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });

    // The safety-critical assertions.
    expect(reloaded.status).toBe("MANUAL_INTERVENTION");
    expect(reloaded.status).not.toBe("ENTRY_EXPIRED");
    expect(reloaded.requiresManualIntervention).toBe(true);
    expect(reloaded.decisionReasonCode).toBe("UNPROTECTED_PARTIAL_FILL");
    // The filled quantity is preserved, never zeroed.
    expect(finalOrder.executedQuantity.toString()).toBe("0.15");
    expect(reloaded.filledQuantity?.toString()).toBe("0.15");
    // Exactly one cancel, and no compensating opposite order.
    expect(scenario.mutations.filter((call) => call.startsWith("DELETE"))).toHaveLength(1);
    expect(scenario.submittedParams).toHaveLength(1);
  });

  maybe()("queries after a cancel timeout instead of trusting the response", async () => {
    const { execution, order } = await submitted();
    scenario.failCancelWith = timeoutError("cancelOrder");
    // The cancel actually landed.
    scenario.order!.status = "CANCELED";

    await entries.expireEntryOrderIfDue({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: order.entryOrderExpiresAt!,
    });

    const queries = scenario.calls.filter((call) => call.startsWith("queryOrder"));
    expect(queries.length).toBeGreaterThanOrEqual(2);
    expect((await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } })).status).toBe(
      "ENTRY_EXPIRED"
    );
  });

  maybe()("reaches ENTRY_FILLED when a cancel timeout hid a fill", async () => {
    const { execution, order } = await submitted();
    scenario.failCancelWith = timeoutError("cancelOrder");
    const original = readOnlyStub.queryOrderByClientOrderId;
    let queries = 0;
    readOnlyStub.queryOrderByClientOrderId = async (symbol: string, clientOrderId: string) => {
      queries += 1;
      if (queries > 1 && scenario.order) {
        scenario.order.status = "FILLED";
        scenario.order.executedQty = "0.375";
        scenario.order.avgPrice = "100";
      }
      return original.call(readOnlyStub, symbol, clientOrderId);
    };

    await entries.expireEntryOrderIfDue({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: order.entryOrderExpiresAt!,
    });
    readOnlyStub.queryOrderByClientOrderId = original;

    expect((await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } })).status).toBe(
      "ENTRY_FILLED"
    );
  });

  maybe()("parks an ambiguous cancel with possible exposure for a human", async () => {
    const { execution, order } = await submitted();
    scenario.order!.status = "PARTIALLY_FILLED";
    scenario.order!.executedQty = "0.100";
    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    scenario.failCancelWith = timeoutError("cancelOrder");
    // The post-cancel query is also unavailable.
    const original = readOnlyStub.queryOrderByClientOrderId;
    let queries = 0;
    readOnlyStub.queryOrderByClientOrderId = async (symbol: string, clientOrderId: string) => {
      queries += 1;
      if (queries > 1) throw timeoutError("order");
      return original.call(readOnlyStub, symbol, clientOrderId);
    };

    const latest = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const outcome = await entries.expireEntryOrderIfDue({
      executionId: execution.id,
      expectedVersion: latest.version,
      evaluatedAt: order.entryOrderExpiresAt!,
    });
    readOnlyStub.queryOrderByClientOrderId = original;

    expect(outcome.reasonCode).toBe("ENTRY_CANCEL_RESULT_UNKNOWN");
    expect((await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } })).status).toBe(
      "MANUAL_INTERVENTION"
    );
    // Never a compensating trade.
    expect(scenario.submittedParams).toHaveLength(1);
  });
});

describe("crash recovery", () => {
  maybe()("resumes from a durable reservation with the same client order id", async () => {
    const execution = await admittedExecution();
    // Simulate a crash right after the reservation transaction committed.
    const clientOrderId = buildClientOrderId(execution.id, "ENTRY", 1);
    await prisma!.$transaction([
      prisma!.tradeExecution.update({
        where: { id: execution.id },
        data: { status: "ENTRY_SUBMITTING", version: { increment: 1 } },
      }),
      prisma!.binanceOrder.create({
        data: {
          tradeExecutionId: execution.id,
          role: "ENTRY",
          generation: 1,
          clientOrderId,
          side: "BUY",
          positionSide: "LONG",
          orderType: "LIMIT",
          timeInForce: "GTC",
          price: "100",
          originalQuantity: "0.375",
          status: "SUBMITTING",
          entryOrderExpiresAt: at(TTL_SECONDS),
        },
      }),
    ]);

    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.resumeEntrySubmission({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    const orders = await prisma!.binanceOrder.findMany({ where: { tradeExecutionId: execution.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0].clientOrderId).toBe(clientOrderId);
    expect(scenario.submittedParams.every((params) => params.newClientOrderId === clientOrderId)).toBe(true);
  });

  maybe()("queries an existing order before resubmitting after a crash", async () => {
    const execution = await admittedExecution();
    const clientOrderId = buildClientOrderId(execution.id, "ENTRY", 1);
    await prisma!.$transaction([
      prisma!.tradeExecution.update({
        where: { id: execution.id },
        data: { status: "ENTRY_SUBMITTING", version: { increment: 1 } },
      }),
      prisma!.binanceOrder.create({
        data: {
          tradeExecutionId: execution.id,
          role: "ENTRY",
          generation: 1,
          clientOrderId,
          side: "BUY",
          positionSide: "LONG",
          orderType: "LIMIT",
          timeInForce: "GTC",
          price: "100",
          originalQuantity: "0.375",
          status: "SUBMITTING",
          entryOrderExpiresAt: at(TTL_SECONDS),
        },
      }),
    ]);
    // The order was accepted before the crash.
    scenario.order = exchangeOrder({ clientOrderId, status: "NEW" });

    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.resumeEntrySubmission({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    // No second submission, and no configuration mutation either.
    expect(scenario.mutations).toHaveLength(0);
    expect((await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } })).status).toBe(
      "ENTRY_PENDING"
    );
  });

  maybe()("verifies margin type and leverage before continuing after a crash", async () => {
    const execution = await admittedExecution();
    const clientOrderId = buildClientOrderId(execution.id, "ENTRY", 1);
    await prisma!.$transaction([
      prisma!.tradeExecution.update({
        where: { id: execution.id },
        data: { status: "ENTRY_SUBMITTING", version: { increment: 1 } },
      }),
      prisma!.binanceOrder.create({
        data: {
          tradeExecutionId: execution.id,
          role: "ENTRY",
          generation: 1,
          clientOrderId,
          side: "BUY",
          positionSide: "LONG",
          orderType: "LIMIT",
          timeInForce: "GTC",
          price: "100",
          originalQuantity: "0.375",
          status: "SUBMITTING",
          entryOrderExpiresAt: at(TTL_SECONDS),
        },
      }),
    ]);
    scenario.marginType = "ISOLATED";
    scenario.leverage = "10";

    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.resumeEntrySubmission({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    // Both were read and already correct, so neither POST was issued.
    expect(scenario.calls.filter((call) => call.startsWith("getSymbolConfiguration")).length).toBeGreaterThanOrEqual(2);
    expect(scenario.mutations.filter((call) => call.includes("marginType"))).toHaveLength(0);
    expect(scenario.mutations.filter((call) => call.includes("leverage"))).toHaveLength(0);
  });

  maybe()("never resubmits a filled entry", async () => {
    const execution = await admittedExecution();
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    scenario.order!.status = "FILLED";
    scenario.order!.executedQty = "0.375";
    let current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    const submissionsBefore = scenario.submittedParams.length;
    current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const outcome = await entries.resumeEntrySubmission({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(true);
    expect(scenario.submittedParams).toHaveLength(submissionsBefore);
    expect(scenario.mutations.some((call) => call.startsWith("DELETE"))).toBe(false);
  });

  maybe()("never mutates from a terminal or manual state", async () => {
    const execution = await admittedExecution();
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { status: "MANUAL_INTERVENTION", requiresManualIntervention: true },
    });
    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });

    const outcome = await entries.resumeEntrySubmission({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("MANUAL_REVIEW_REQUIRED");
    expect(scenario.mutations).toHaveLength(0);
  });

  maybe()("a restart never creates a duplicate order", async () => {
    const execution = await admittedExecution();
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    for (let restart = 0; restart < 3; restart += 1) {
      const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
      await entries.resumeEntrySubmission({
        executionId: execution.id,
        expectedVersion: current.version,
        evaluatedAt: at(),
      });
    }

    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(1);
    expect(scenario.submittedParams).toHaveLength(1);
  });
});

// ===========================================================================
// Mutation-gate and recovery audit
// ===========================================================================

describe("gate semantics: exposure-increasing versus risk-reducing", () => {
  /** Submits an entry with the gates open, then closes one of them. */
  async function submittedThenGated(closeGate: "liveEntry" | "protection") {
    const execution = await admittedExecution();
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    const order = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });
    scenario.mutations = [];
    if (closeGate === "liveEntry") gates.liveEntryEnabled = false;
    else gates.protectionReady = false;
    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    return { execution: current, order };
  }

  maybe()("1. gates closed before PREFLIGHT submission changes nothing at all", async () => {
    const execution = await admittedExecution();
    gates.liveEntryEnabled = false;

    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("LIVE_ENTRY_DISABLED");
    expect(scenario.mutations).toHaveLength(0);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(0);

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("PREFLIGHT");
    expect(reloaded.version).toBe(execution.version);
    expect(
      await prisma!.executionEvent.count({
        where: { tradeExecutionId: execution.id, eventType: "ORDER_RESERVED" },
      })
    ).toBe(0);
  });

  maybe()("2. GET reconciliation and TTL cancellation survive the gates closing", async () => {
    const { execution, order } = await submittedThenGated("liveEntry");

    // Reconciliation is GET-only and must keep working.
    const reconciled = await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    expect(reconciled.ok).toBe(true);
    expect(scenario.mutations).toHaveLength(0);

    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.expireEntryOrderIfDue({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: order.entryOrderExpiresAt!,
    });

    // Exactly one DELETE, and no POST of any kind.
    expect(scenario.mutations.filter((call) => call.startsWith("DELETE"))).toHaveLength(1);
    expect(scenario.mutations.filter((call) => call.startsWith("POST"))).toHaveLength(0);
  });

  maybe()("3. protection-ready going false does not trap a pending zero-fill entry", async () => {
    const { execution, order } = await submittedThenGated("protection");

    await entries.expireEntryOrderIfDue({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: order.entryOrderExpiresAt!,
    });

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("ENTRY_EXPIRED");
    expect(scenario.mutations.filter((call) => call.startsWith("DELETE"))).toHaveLength(1);
  });

  maybe()("4. live-entry going false after a partial fill still cancels only the remainder", async () => {
    const execution = await admittedExecution();
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    const order = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });
    scenario.order!.status = "PARTIALLY_FILLED";
    scenario.order!.executedQty = "0.150";
    scenario.order!.avgPrice = "99.99";
    scenario.mutations = [];
    gates.liveEntryEnabled = false;

    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.expireEntryOrderIfDue({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: order.entryOrderExpiresAt!,
    });

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const finalOrder = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });

    expect(reloaded.status).toBe("MANUAL_INTERVENTION");
    expect(reloaded.requiresManualIntervention).toBe(true);
    expect(finalOrder.executedQuantity.toString()).toBe("0.15");
    expect(scenario.mutations.filter((call) => call.startsWith("DELETE"))).toHaveLength(1);
    // No opposite/compensating order — only the original submission ever went out.
    expect(scenario.submittedParams).toHaveLength(1);
  });

  maybe()("5. an unknown submission with the gates now closed queries, never resubmits", async () => {
    const execution = await admittedExecution();
    const clientOrderId = buildClientOrderId(execution.id, "ENTRY", 1);
    scenario.failSubmitWith = timeoutError("newOrder");
    scenario.submitLandsWithStatus = "NEW";
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    scenario.submitLandsWithStatus = null;

    // Gates close, then the order genuinely disappears from the exchange.
    gates.liveEntryEnabled = false;
    scenario.mutations = [];
    scenario.order = null;
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { status: "ENTRY_SUBMITTING" },
    });

    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const outcome = await entries.resumeEntrySubmission({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    // The same id was queried; nothing was resubmitted while gated.
    expect(scenario.calls).toContain(`queryOrder:${clientOrderId}`);
    expect(scenario.mutations).toHaveLength(0);
    // An already-ambiguous submission now reconciles BEFORE the gate check, so
    // the reason reports what the exchange said about the order rather than
    // that the gate was shut. Both refuse to resubmit — the assertion above is
    // the safety property — but only this one tells the operator the order is
    // genuinely absent, and only this path works while SAFE_RECOVERY.
    expect(outcome.reasonCode).toBe("ENTRY_ORDER_NOT_FOUND");
    const orders = await prisma!.binanceOrder.findMany({ where: { tradeExecutionId: execution.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0].clientOrderId).toBe(clientOrderId);
    expect(orders.map((row) => row.generation)).toEqual([1]);
  });

  maybe()("5b. an unknown submission with the gates closed still reconciles a found order", async () => {
    const execution = await admittedExecution();
    scenario.failSubmitWith = timeoutError("newOrder");
    scenario.submitLandsWithStatus = "NEW";
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    scenario.submitLandsWithStatus = null;

    gates.liveEntryEnabled = false;
    scenario.mutations = [];
    scenario.order!.status = "FILLED";
    scenario.order!.executedQty = "0.375";
    scenario.order!.avgPrice = "100";

    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await entries.reconcileEntryOrder({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    expect((await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } })).status).toBe(
      "ENTRY_FILLED"
    );
    expect(scenario.mutations).toHaveLength(0);
  });

  maybe()("6. an arbitrary cancellation request cannot be dispatched", async () => {
    const execution = await admittedExecution();
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    const order = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });

    // (a) An execution with no local reservation at all.
    const bare = await admittedExecution();
    scenario.mutations = [];
    const noReservation = await entries.expireEntryOrderIfDue({
      executionId: bare.id,
      expectedVersion: bare.version,
      evaluatedAt: at(3600),
    });
    expect(noReservation.reasonCode).toBe("ENTRY_ORDER_NOT_FOUND");
    expect(scenario.mutations).toHaveLength(0);

    // (b) A terminal, exposure-free execution.
    await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { status: "ENTRY_EXPIRED" } });
    const terminalCurrent = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    scenario.mutations = [];
    const terminalOutcome = await entries.expireEntryOrderIfDue({
      executionId: execution.id,
      expectedVersion: terminalCurrent.version,
      evaluatedAt: at(3600),
    });
    expect(terminalOutcome.ok).toBe(false);
    expect(terminalOutcome.reasonCode).toBe("EXECUTION_NOT_PREFLIGHT");
    expect(scenario.mutations.filter((call) => call.startsWith("DELETE"))).toHaveLength(0);

    // (c) The context factory rejects a wrong role, generation, execution or
    //     client order id — an external order can never be addressed.
    for (const bad of [
      { role: "STOP_LOSS", generation: 1, clientOrderId: order.clientOrderId, executionId: execution.id },
      { role: "ENTRY", generation: 2, clientOrderId: order.clientOrderId, executionId: execution.id },
      { role: "ENTRY", generation: 1, clientOrderId: "tad-en-1-ffffffffffff", executionId: execution.id },
      { role: "ENTRY", generation: 1, clientOrderId: order.clientOrderId, executionId: "someone-elses-execution" },
    ]) {
      expect(() => mutationStub.authorizeEntryCancellation({ symbol: SYMBOL, reason: "TTL_DUE", ...bad })).toThrow();
    }
  });

  maybe()("7. a kill switch engaged after leverage verification blocks the entry POST", async () => {
    const execution = await admittedExecution();
    scenario.marginType = "CROSS";
    scenario.leverage = "5";

    const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({
      where: { executionProfileId: profileId },
    });
    // Engage the profile kill switch at exactly the moment leverage has been
    // verified and before the entry POST.
    const originalSetLeverage = mutationStub.setInitialLeverage;
    mutationStub.setInitialLeverage = async (authorization: unknown, symbol: string, leverage: number) => {
      const result = await originalSetLeverage.call(mutationStub, authorization, symbol, leverage);
      await prisma!.executionSafetyPolicy.update({ where: { id: policy.id }, data: { killSwitchActive: true } });
      return result;
    };

    const outcome = await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    mutationStub.setInitialLeverage = originalSetLeverage;
    await prisma!.executionSafetyPolicy.update({ where: { id: policy.id }, data: { killSwitchActive: false } });

    expect(outcome.reasonCode).toBe("KILL_SWITCH_RECHECK_ACTIVE");
    // Configuration happened; the entry POST did not.
    expect(scenario.mutations.filter((call) => call.startsWith("POST /fapi/v1/order"))).toHaveLength(0);
    expect(scenario.submittedParams).toHaveLength(0);
    // Exactly one reservation, no duplicate.
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(1);
    // No automatic configuration rollback.
    expect(scenario.marginType).toBe("ISOLATED");
    expect(scenario.leverage).toBe("10");
    expect(scenario.mutations.filter((call) => call.startsWith("DELETE"))).toHaveLength(0);
  });

  maybe()("8. concurrent TTL cancellations commit at most one workflow", async () => {
    const execution = await admittedExecution();
    await entries.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    const order = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });
    scenario.order!.status = "PARTIALLY_FILLED";
    scenario.order!.executedQty = "0.120";
    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const eventsBefore = await prisma!.executionEvent.count({ where: { tradeExecutionId: execution.id } });

    const outcomes = await Promise.all([
      entries.expireEntryOrderIfDue({
        executionId: execution.id,
        expectedVersion: current.version,
        evaluatedAt: order.entryOrderExpiresAt!,
      }),
      entries.expireEntryOrderIfDue({
        executionId: execution.id,
        expectedVersion: current.version,
        evaluatedAt: order.entryOrderExpiresAt!,
      }),
    ]);

    // At most one workflow committed a lifecycle change.
    const committed = outcomes.filter((outcome) => outcome.reasonCode !== "CAPACITY_OR_VERSION_CONFLICT");
    expect(committed.length).toBeLessThanOrEqual(1);

    const events = await prisma!.executionEvent.findMany({
      where: { tradeExecutionId: execution.id },
      orderBy: { sequenceNumber: "asc" },
    });
    // One event per committed version bump; sequence numbers stay unique.
    expect(new Set(events.map((event) => event.sequenceNumber)).size).toBe(events.length);
    expect(events.length).toBeLessThanOrEqual(eventsBefore + 1);

    // Fill data is intact and never regressed, and no compensating trade exists.
    const finalOrder = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });
    expect(finalOrder.executedQuantity.toString()).toBe("0.12");
    expect(scenario.submittedParams).toHaveLength(1);
  });
});

// ===========================================================================
// PREFLIGHT recovery  the gap that stranded a real mainnet canary.
//
// An execution admitted moments before the operator closed the canary window
// sat in PREFLIGHT forever: no reconciliation status included it, and PREFLIGHT
// consumes a pending-entry AND a total-active slot, so with the canary limits
// at 1/1 nothing else could ever start.
//
// PREFLIGHT is the one pre-submission state: `reserveEntryIntent` writes the
// ENTRY reservation and the move to ENTRY_SUBMITTING in a single transaction,
// so a PREFLIGHT execution owns no deterministic client order id and no
// exchange order can carry its identity. That  and only that  is what makes
// releasing it safe.
// ===========================================================================

describe("PREFLIGHT recovery", () => {
  /** Runs abandonment against the execution's current persisted version. */
  async function abandon(executionId: string) {
    const current = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });
    return entries.releaseUnrunnablePreflight({
      executionId,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });
  }

  const reload = (id: string) => prisma!.tradeExecution.findUniqueOrThrow({ where: { id } });
  const orderCount = (id: string) => prisma!.binanceOrder.count({ where: { tradeExecutionId: id } });

  // --- B. Gates open: the ordinary path, unchanged --------------------------

  maybe()("resumes a PREFLIGHT execution through the normal submission path exactly once", async () => {
    const execution = await admittedExecution();

    const outcome = await entries.resumeEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    // The existing prepareEntrySubmission path ran: one reservation, one
    // submitted order, no second identity.
    expect(outcome.ok).toBe(true);
    const orders = await prisma!.binanceOrder.findMany({ where: { tradeExecutionId: execution.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0].clientOrderId).toBe(buildClientOrderId(execution.id, "ENTRY", 1));
    expect(scenario.submittedParams).toHaveLength(1);
    expect((await reload(execution.id)).status).toBe("ENTRY_PENDING");
  });

  maybe()("never releases a PREFLIGHT execution while a new entry is possible", async () => {
    const execution = await admittedExecution();

    const outcome = await abandon(execution.id);

    // Gates open means the submission path owns this execution; terminalizing
    // it here would silently discard an admitted signal.
    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("SAFETY_ADMISSION_NOT_READY");
    expect((await reload(execution.id)).status).toBe("PREFLIGHT");
    expect(dispatched).toBe(0);
  });

  // --- C/D/E/F. Blocked: release without touching the exchange -------------

  const blockers: Array<[string, () => Promise<void> | void]> = [
    [
      "the profile kill switch is active",
      async () => {
        await prisma!.executionSafetyPolicy.updateMany({
          where: { executionProfileId: profileId },
          data: { killSwitchActive: true },
        });
      },
    ],
    ["the global kill switch is active", () => void (runtimeEnv.EXECUTION_GLOBAL_KILL_SWITCH = true)],
    ["live entry is disabled", () => void (runtimeEnv.EXECUTION_LIVE_ENTRY_ENABLED = false)],
    ["protection is not ready", () => void (runtimeEnv.EXECUTION_PROTECTION_READY = false)],
    ["the mutation client itself is blocked", () => void (gates.liveEntryEnabled = false)],
    [
      "the execution profile is disabled",
      async () => {
        await prisma!.executionProfile.updateMany({ where: { id: profileId }, data: { isEnabled: false } });
      },
    ],
  ];

  for (const [label, block] of blockers) {
    maybe()(`releases a PREFLIGHT execution with zero exchange mutations when ${label}`, async () => {
      const execution = await admittedExecution();
      await block();

      // The ordinary recovery path runs first and must dispatch nothing.
      const resumed = await entries.resumeEntrySubmission({
        executionId: execution.id,
        expectedVersion: execution.version,
        evaluatedAt: at(),
      });
      expect(resumed.ok, label).toBe(false);
      expect(await orderCount(execution.id), label).toBe(0);

      const released = await abandon(execution.id);

      expect(released.ok, label).toBe(true);
      expect(released.reasonCode, label).toBe("PREFLIGHT_ABANDONED_NEW_ENTRY_BLOCKED");

      const after = await reload(execution.id);
      expect(after.status, label).toBe("CANCELED");
      // Nothing was sent, nothing was reserved, no manual review demanded.
      expect(dispatched, label).toBe(0);
      expect(scenario.mutations, label).toEqual([]);
      expect(scenario.submittedParams, label).toHaveLength(0);
      expect(scenario.cancellationContexts, label).toEqual([]);
      expect(await orderCount(execution.id), label).toBe(0);
      expect(after.requiresManualIntervention, label).toBe(false);
    });
  }

  maybe()("records the release as an auditable status change", async () => {
    const execution = await admittedExecution();
    runtimeEnv.EXECUTION_LIVE_ENTRY_ENABLED = false;

    await abandon(execution.id);

    const events = await prisma!.executionEvent.findMany({
      where: { tradeExecutionId: execution.id },
      orderBy: { sequenceNumber: "asc" },
    });
    const release = events[events.length - 1];
    expect(release.fromStatus).toBe("PREFLIGHT");
    expect(release.toStatus).toBe("CANCELED");
    expect(release.reasonCode).toBe("PREFLIGHT_ABANDONED_NEW_ENTRY_BLOCKED");
    expect(release.message).toContain("no entry order was ever reserved");
  });

  maybe()("frees the capacity the stuck execution was holding", async () => {
    const execution = await admittedExecution();
    runtimeEnv.EXECUTION_LIVE_ENTRY_ENABLED = false;

    const before = await prisma!.tradeExecution.count({
      where: { executionProfileId: profileId, status: { in: [...PENDING_ENTRY_STATUSES] } },
    });
    await abandon(execution.id);
    const after = await prisma!.tradeExecution.count({
      where: { executionProfileId: profileId, status: { in: [...PENDING_ENTRY_STATUSES] } },
    });

    expect(before).toBe(1);
    expect(after).toBe(0);
    expect(consumesNoCapacity("CANCELED")).toBe(true);
  });

  // --- G. Unprovable exchange state: fail closed ---------------------------

  maybe()("does not release when exchange state cannot be read", async () => {
    const execution = await admittedExecution();
    runtimeEnv.EXECUTION_LIVE_ENTRY_ENABLED = false;
    const original = readOnlyStub.getPositionRisk;
    readOnlyStub.getPositionRisk = async () => {
      throw timeoutError("positionRisk");
    };

    try {
      const outcome = await abandon(execution.id);

      // Unknown is never read as "flat".
      expect(outcome.ok).toBe(false);
      expect(outcome.reasonCode).toBe("SYMBOL_EXPOSURE_CHANGED");
      expect((await reload(execution.id)).status).toBe("PREFLIGHT");
    } finally {
      readOnlyStub.getPositionRisk = original;
    }
  });

  maybe()("does not release while the symbol carries an open order", async () => {
    const execution = await admittedExecution();
    runtimeEnv.EXECUTION_LIVE_ENTRY_ENABLED = false;
    scenario.openOrderSymbols = [SYMBOL];

    const outcome = await abandon(execution.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("SYMBOL_EXPOSURE_CHANGED");
    expect((await reload(execution.id)).status).toBe("PREFLIGHT");
  });

  maybe()("does not release while the symbol carries a position", async () => {
    const execution = await admittedExecution();
    runtimeEnv.EXECUTION_LIVE_ENTRY_ENABLED = false;
    scenario.positionSymbols = [SYMBOL];

    const outcome = await abandon(execution.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("SYMBOL_EXPOSURE_CHANGED");
    expect((await reload(execution.id)).status).toBe("PREFLIGHT");
  });

  // --- H. Concurrency -------------------------------------------------------

  maybe()("releases once under concurrent reconciliation", async () => {
    const execution = await admittedExecution();
    runtimeEnv.EXECUTION_LIVE_ENTRY_ENABLED = false;
    const current = await reload(execution.id);
    const input = { executionId: execution.id, expectedVersion: current.version, evaluatedAt: at() };

    const outcomes = await Promise.all([
      entries.releaseUnrunnablePreflight(input),
      entries.releaseUnrunnablePreflight(input),
      entries.releaseUnrunnablePreflight(input),
    ]);

    // A compare-and-swap on the version, not an in-memory flag.
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    const after = await reload(execution.id);
    expect(after.status).toBe("CANCELED");
    expect(after.version).toBe(current.version + 1);
    const releases = await prisma!.executionEvent.count({
      where: { tradeExecutionId: execution.id, toStatus: "CANCELED" },
    });
    expect(releases).toBe(1);
    expect(dispatched).toBe(0);
  });

  // --- I/J. Post-submission states keep their existing semantics ------------

  maybe()("refuses to release anything at or past ENTRY_SUBMITTING", async () => {
    for (const status of ["ENTRY_SUBMITTING", "ENTRY_PENDING", "PARTIALLY_FILLED", "ENTRY_FILLED"] as const) {
      const execution = await admittedExecution();
      runtimeEnv.EXECUTION_LIVE_ENTRY_ENABLED = false;
      await prisma!.tradeExecution.update({
        where: { id: execution.id },
        data: { status, version: { increment: 1 } },
      });

      const outcome = await abandon(execution.id);

      // An exchange order may exist from here on; only the existing recovery
      // semantics may touch these.
      expect(outcome.ok, status).toBe(false);
      expect(outcome.reasonCode, status).toBe("EXECUTION_NOT_PREFLIGHT");
      expect((await reload(execution.id)).status, status).toBe(status);
      expect(dispatched, status).toBe(0);

      await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { status: "FAILED" } });
    }
  });

  maybe()("parks a PREFLIGHT execution that somehow already holds a reservation", async () => {
    const execution = await admittedExecution();
    runtimeEnv.EXECUTION_LIVE_ENTRY_ENABLED = false;
    // Not a state reserveEntryIntent can produce  it writes the order and the
    // status together  so exposure cannot be ruled out and a human decides.
    await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id,
        role: "ENTRY",
        generation: 1,
        clientOrderId: buildClientOrderId(execution.id, "ENTRY", 1),
        side: "BUY",
        positionSide: "LONG",
        orderType: "LIMIT",
        timeInForce: "GTC",
        price: "100",
        originalQuantity: "0.375",
        status: "SUBMITTING",
        entryOrderExpiresAt: at(TTL_SECONDS),
      },
    });

    const outcome = await abandon(execution.id);

    expect(outcome.ok).toBe(false);
    const after = await reload(execution.id);
    expect(after.status).toBe("MANUAL_INTERVENTION");
    expect(after.requiresManualIntervention).toBe(true);
    expect(dispatched).toBe(0);
  });

  maybe()("leaves risk-reducing recovery available while a kill switch blocks new entry", async () => {
    // The kill switch stops NEW submissions; it must never disable the
    // reconciliation of an order that may already exist.
    const execution = await admittedExecution();
    const clientOrderId = buildClientOrderId(execution.id, "ENTRY", 1);
    await prisma!.$transaction([
      prisma!.tradeExecution.update({
        where: { id: execution.id },
        data: { status: "ENTRY_PENDING", version: { increment: 1 } },
      }),
      prisma!.binanceOrder.create({
        data: {
          tradeExecutionId: execution.id,
          role: "ENTRY",
          generation: 1,
          clientOrderId,
          side: "BUY",
          positionSide: "LONG",
          orderType: "LIMIT",
          timeInForce: "GTC",
          price: "100",
          originalQuantity: "0.375",
          status: "NEW",
          entryOrderExpiresAt: at(-1),
        },
      }),
    ]);
    scenario.order = {
      orderId: "9001",
      clientOrderId,
      symbol: SYMBOL,
      status: "NEW",
      side: "BUY",
      positionSide: "LONG",
      type: "LIMIT",
      price: "100",
      origQty: "0.375",
      executedQty: "0",
      avgPrice: "0",
    };
    await prisma!.executionSafetyPolicy.updateMany({
      where: { executionProfileId: profileId },
      data: { killSwitchActive: true },
    });

    const current = await reload(execution.id);
    const outcome = await entries.expireEntryOrderIfDue({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    // The TTL cancellation still runs: it reduces risk rather than creating it.
    expect(scenario.cancellationContexts).toHaveLength(1);
    expect(outcome.reasonCode).not.toBe("KILL_SWITCH_RECHECK_ACTIVE");
  });
});

// ===========================================================================
// Stale PREFLIGHT  the second permanent-stick case.
//
// Gates wide open, kill switches off, nothing reserved: `revalidate` still
// refuses forever because the signal is older than
// EXECUTION_MAX_ALERT_AGE_SECONDS. The blocked-release path does not apply
// (nothing is blocked), so without this the row holds a pending-entry and a
// total-active slot for good.
//
// SKIPPED rather than CANCELED: the signal was deliberately not traded, which
// is exactly what a Phase 5 SKIP decision already records on a PLAN_READY row.
// ===========================================================================

describe("PREFLIGHT expiry", () => {
  const reload = (id: string) => prisma!.tradeExecution.findUniqueOrThrow({ where: { id } });
  const orderCount = (id: string) => prisma!.binanceOrder.count({ where: { tradeExecutionId: id } });

  /** Ages the frozen signal past the freshness limit. Gates stay wide open. */
  async function staleExecution() {
    const execution = await admittedExecution();
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { signalTriggeredAt: at(-(runtimeEnv.EXECUTION_MAX_ALERT_AGE_SECONDS + 60)) },
    });
    return reload(execution.id);
  }

  async function release(executionId: string) {
    const current = await reload(executionId);
    return entries.releaseUnrunnablePreflight({
      executionId,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });
  }

  maybe()("skips a stale PREFLIGHT execution with zero exchange mutations", async () => {
    const execution = await staleExecution();

    // The ordinary path is genuinely stuck: it refuses on the deadline and
    // reserves nothing, however many times it runs.
    const resumed = await entries.resumeEntrySubmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.reasonCode).toBe("SIGNAL_OR_ENTRY_DEADLINE_EXPIRED");

    const outcome = await release(execution.id);

    expect(outcome.ok).toBe(true);
    expect(outcome.reasonCode).toBe("PREFLIGHT_SKIPPED_SIGNAL_EXPIRED");
    const after = await reload(execution.id);
    expect(after.status).toBe("SKIPPED");
    expect(after.requiresManualIntervention).toBe(false);
    // Nothing reserved, nothing sent, nothing cancelled.
    expect(await orderCount(execution.id)).toBe(0);
    expect(dispatched).toBe(0);
    expect(scenario.mutations).toEqual([]);
    expect(scenario.submittedParams).toHaveLength(0);
    expect(scenario.cancellationContexts).toEqual([]);
  });

  maybe()("skips a PREFLIGHT execution whose planned entry deadline has passed", async () => {
    const execution = await admittedExecution();
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { entryExpiresAt: at(-60) },
    });

    const outcome = await release(execution.id);

    expect(outcome.ok).toBe(true);
    expect(outcome.reasonCode).toBe("PREFLIGHT_SKIPPED_SIGNAL_EXPIRED");
    expect((await reload(execution.id)).status).toBe("SKIPPED");
    expect(dispatched).toBe(0);
  });

  maybe()("records the skip as an auditable status change", async () => {
    const execution = await staleExecution();

    await release(execution.id);

    const events = await prisma!.executionEvent.findMany({
      where: { tradeExecutionId: execution.id },
      orderBy: { sequenceNumber: "asc" },
    });
    const skip = events[events.length - 1];
    expect(skip.fromStatus).toBe("PREFLIGHT");
    expect(skip.toStatus).toBe("SKIPPED");
    expect(skip.reasonCode).toBe("PREFLIGHT_SKIPPED_SIGNAL_EXPIRED");
    expect(skip.message).toContain("can never be submitted");
  });

  maybe()("frees the capacity a stale execution was holding", async () => {
    const execution = await staleExecution();

    const before = await prisma!.tradeExecution.count({
      where: { executionProfileId: profileId, status: { in: [...TOTAL_ACTIVE_STATUSES] } },
    });
    await release(execution.id);
    const after = await prisma!.tradeExecution.count({
      where: { executionProfileId: profileId, status: { in: [...TOTAL_ACTIVE_STATUSES] } },
    });

    expect(before).toBe(1);
    expect(after).toBe(0);
    expect(consumesNoCapacity("SKIPPED")).toBe(true);
  });

  maybe()("leaves a still-fresh PREFLIGHT execution alone", async () => {
    // One second inside the limit: the submission path can still have it.
    const execution = await admittedExecution();
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { signalTriggeredAt: at(-(runtimeEnv.EXECUTION_MAX_ALERT_AGE_SECONDS - 1)) },
    });

    const outcome = await release(execution.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("SAFETY_ADMISSION_NOT_READY");
    expect((await reload(execution.id)).status).toBe("PREFLIGHT");
  });

  maybe()("never treats an unknown signal time as expiry", async () => {
    const execution = await admittedExecution();
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { signalTriggeredAt: null },
    });

    const outcome = await release(execution.id);

    // Age is unknowable, and unknown is never proof.
    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("SAFETY_ADMISSION_NOT_READY");
    expect((await reload(execution.id)).status).toBe("PREFLIGHT");
  });

  maybe()("prefers the blocked reason when the window is also shut", async () => {
    const execution = await staleExecution();
    runtimeEnv.EXECUTION_LIVE_ENTRY_ENABLED = false;

    const outcome = await release(execution.id);

    // The operator's decision is the more informative record.
    expect(outcome.reasonCode).toBe("PREFLIGHT_ABANDONED_NEW_ENTRY_BLOCKED");
    expect((await reload(execution.id)).status).toBe("CANCELED");
  });

  // --- The same proofs as the blocked path, re-asserted for this trigger ----

  maybe()("does not skip when exchange state cannot be read", async () => {
    const execution = await staleExecution();
    const original = readOnlyStub.getOpenOrders;
    readOnlyStub.getOpenOrders = async () => {
      throw timeoutError("openOrders");
    };

    try {
      const outcome = await release(execution.id);

      expect(outcome.ok).toBe(false);
      expect(outcome.reasonCode).toBe("SYMBOL_EXPOSURE_CHANGED");
      expect((await reload(execution.id)).status).toBe("PREFLIGHT");
    } finally {
      readOnlyStub.getOpenOrders = original;
    }
  });

  maybe()("does not skip while the symbol carries an open order", async () => {
    const execution = await staleExecution();
    scenario.openOrderSymbols = [SYMBOL];

    const outcome = await release(execution.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("SYMBOL_EXPOSURE_CHANGED");
    expect((await reload(execution.id)).status).toBe("PREFLIGHT");
  });

  maybe()("does not skip while the symbol carries a position", async () => {
    const execution = await staleExecution();
    scenario.positionSymbols = [SYMBOL];

    const outcome = await release(execution.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("SYMBOL_EXPOSURE_CHANGED");
    expect((await reload(execution.id)).status).toBe("PREFLIGHT");
  });

  maybe()("parks a stale PREFLIGHT execution that somehow holds a reservation", async () => {
    const execution = await staleExecution();
    await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id,
        role: "ENTRY",
        generation: 1,
        clientOrderId: buildClientOrderId(execution.id, "ENTRY", 1),
        side: "BUY",
        positionSide: "LONG",
        orderType: "LIMIT",
        timeInForce: "GTC",
        price: "100",
        originalQuantity: "0.375",
        status: "SUBMITTING",
        entryOrderExpiresAt: at(TTL_SECONDS),
      },
    });

    const outcome = await release(execution.id);

    expect(outcome.ok).toBe(false);
    const after = await reload(execution.id);
    // Never SKIPPED: an order identity exists, so exposure is not ruled out.
    expect(after.status).toBe("MANUAL_INTERVENTION");
    expect(after.requiresManualIntervention).toBe(true);
    expect(dispatched).toBe(0);
  });

  maybe()("refuses to skip anything at or past ENTRY_SUBMITTING", async () => {
    for (const status of ["ENTRY_SUBMITTING", "ENTRY_PENDING", "PARTIALLY_FILLED", "ENTRY_FILLED"] as const) {
      const execution = await staleExecution();
      await prisma!.tradeExecution.update({
        where: { id: execution.id },
        data: { status, version: { increment: 1 } },
      });

      const outcome = await release(execution.id);

      expect(outcome.ok, status).toBe(false);
      expect(outcome.reasonCode, status).toBe("EXECUTION_NOT_PREFLIGHT");
      expect((await reload(execution.id)).status, status).toBe(status);
      expect(dispatched, status).toBe(0);

      await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { status: "FAILED" } });
    }
  });

  maybe()("skips once under concurrent reconciliation", async () => {
    const execution = await staleExecution();
    const input = { executionId: execution.id, expectedVersion: execution.version, evaluatedAt: at() };

    const outcomes = await Promise.all([
      entries.releaseUnrunnablePreflight(input),
      entries.releaseUnrunnablePreflight(input),
      entries.releaseUnrunnablePreflight(input),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    const after = await reload(execution.id);
    expect(after.status).toBe("SKIPPED");
    expect(after.version).toBe(execution.version + 1);
    const skips = await prisma!.executionEvent.count({
      where: { tradeExecutionId: execution.id, toStatus: "SKIPPED" },
    });
    expect(skips).toBe(1);
    expect(dispatched).toBe(0);
  });
});

// ===========================================================================
// Production path: SelectedPlanExecutor -> ExecutionService -> revalidation
//
// The Phase 11B canary blocker hid here. Every existing fixture in this file
// hands `snapshots.exchangeFilters` straight to `createExecutionFromReadyPlan`,
// so the suites stayed green while the PRODUCTION creation path passed no
// filters at all and every real execution stalled at PREFLIGHT.
//
// These tests therefore build the execution through the REAL
// SelectedPlanExecutor and the REAL ExecutionService against real Postgres,
// with only the margin planner and the orchestrator stubbed. No Binance
// transport is constructed.
// ===========================================================================

describe("production creation path freezes exchange filters", () => {
  /** The sanitized projection the real planner returns from ONE inspection. */
  const PLANNER_FILTERS = {
    status: "TRADING",
    contractType: "PERPETUAL",
    tickSize: "0.01",
    minPrice: "0.01",
    maxPrice: "100000",
    stepSize: "0.001",
    minQty: "0.001",
    maxQty: "1000",
    minNotional: "5",
  };

  let planningCalls = 0;

  /** The real executor, with only the exchange-facing planner stubbed. */
  function productionExecutor() {
    planningCalls = 0;
    return new SelectedPlanExecutor({
      prisma: prisma!,
      marginPlanner: {
        planForSymbolWithSnapshot: async () => {
          planningCalls += 1;
          return { plan: readyPlan("LONG"), exchangeFilters: PLANNER_FILTERS };
        },
      } as never,
      executions,
      // Admission is driven explicitly below so revalidation can be observed.
      orchestrator: {
        admitAndSubmit: async () => ({
          admitted: false,
          decision: null,
          reasonCode: "TEST_NO_ADMISSION",
          message: "Admission is driven by the test.",
        }),
      } as never,
      profileIdentity: { accountIdentifier: `${SYNTHETIC_TAG}-account`, environment: "TESTNET" as const },
    });
  }

  /** A READY Extreme RR plan for the synthetic alert, as the worker would pass it. */
  async function selectedPlan() {
    sequence += 1;
    const alert = await prisma!.alert.create({
      data: {
        symbol: SYMBOL,
        assetType: "CRYPTO",
        exchange: "SYNTHETIC",
        timeframe: "15m",
        price: 100,
        signal: "LONG",
        indicatorName: `${SYNTHETIC_TAG}-${sequence}`,
        rawPayload: { note: SYNTHETIC_TAG },
        triggeredAt: new Date(),
      },
    });

    // A real ExtremeRRPlan row: the executor passes plan.id as a foreign key.
    const planRow = await prisma!.extremeRRPlan.create({
      data: {
        alertId: alert.id,
        status: "READY",
        direction: "LONG",
        entryPrice: "100",
        cutoffAt: new Date(),
        timeframe: "15m",
        selectedLookback: 200,
      },
    });

    return {
      id: planRow.id,
      alertId: alert.id,
      status: "READY",
      direction: "LONG",
      entryPrice: "100",
      selectedLookback: 200,
      template: { riskTemplateId: "t1", name: "canary", riskAmount: "1.50" },
      candidates: [
        {
          requestedCandles: 200,
          valid: true,
          stopLoss: "96",
          takeProfit: "112",
          money: { quantityRaw: "0.375", plannedLossRaw: "1.5" },
        },
      ],
    };
  }

  /** Admits an execution exactly as Phase 5 would, then returns it. */
  async function admit(executionId: string) {
    const execution = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });
    await prisma!.safetyAdmission.create({
      data: {
        tradeExecutionId: execution.id,
        evaluatedVersion: execution.version,
        evaluatedAt: new Date(),
        decision: "PASS",
        reasonCode: null,
        reservedRiskUsd: "1.50",
        reservedMarginUsd: "4.9999995",
      },
    });
    return prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { status: "PREFLIGHT", version: { increment: 1 } },
    });
  }

  maybe()("persists a non-null exchangeFiltersSnapshot", async () => {
    const plan = await selectedPlan();
    const outcome = await productionExecutor().handleSelectedPlan(plan as never, SYMBOL);

    expect(outcome.handled).toBe(true);
    const execution = await prisma!.tradeExecution.findUniqueOrThrow({
      where: { id: (outcome as { executionId: string }).executionId },
    });

    // The exact defect: this was null for every real execution.
    expect(execution.exchangeFiltersSnapshot).not.toBeNull();
    expect(execution.exchangeFiltersSnapshot).toEqual(PLANNER_FILTERS);
    expect(execution.marginPlanSnapshot).not.toBeNull();
    // One inspection per signal  the snapshot describes THAT calculation.
    expect(planningCalls).toBe(1);
  });

  maybe()("persists every filter Phase 6 revalidation compares against", async () => {
    const plan = await selectedPlan();
    const outcome = await productionExecutor().handleSelectedPlan(plan as never, SYMBOL);
    const execution = await prisma!.tradeExecution.findUniqueOrThrow({
      where: { id: (outcome as { executionId: string }).executionId },
    });

    const snapshot = execution.exchangeFiltersSnapshot as Record<string, unknown>;
    expect(snapshot.status).toBe("TRADING");
    expect(snapshot.contractType).toBe("PERPETUAL");
    expect(snapshot.tickSize).toBe("0.01");
    expect(snapshot.stepSize).toBe("0.001");
    expect(snapshot.minQty).toBe("0.001");
    expect(snapshot.maxQty).toBe("1000");
    expect(snapshot.minPrice).toBe("0.01");
    expect(snapshot.maxPrice).toBe("100000");
    expect(snapshot.minNotional).toBe("5");
    // Nothing beyond the sanitized projection.
    expect(Object.keys(snapshot).sort()).toEqual([
      "contractType", "maxPrice", "maxQty", "minNotional", "minPrice", "minQty", "status", "stepSize", "tickSize",
    ]);
  });

  maybe()("reaches the ENTRY reservation instead of stalling at PREFLIGHT", async () => {
    const plan = await selectedPlan();
    const outcome = await productionExecutor().handleSelectedPlan(plan as never, SYMBOL);
    const admitted = await admit((outcome as { executionId: string }).executionId);

    const result = await entries.prepareEntrySubmission({
      executionId: admitted.id,
      expectedVersion: admitted.version,
      evaluatedAt: at(),
    });

    // Previously: SAFETY_ADMISSION_NOT_READY, "The frozen plan or filters
    // snapshot is missing", forever.
    expect(result.reasonCode).not.toBe("SAFETY_ADMISSION_NOT_READY");
    const after = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: admitted.id } });
    expect(after.status).not.toBe("PREFLIGHT");

    // The local reservation exists, with the one deterministic identity.
    const orders = await prisma!.binanceOrder.findMany({ where: { tradeExecutionId: admitted.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0].role).toBe("ENTRY");
    expect(orders[0].generation).toBe(1);
    expect(orders[0].clientOrderId).toBe(buildClientOrderId(admitted.id, "ENTRY", 1));
  });

  maybe()("still fails closed when the snapshot is missing", async () => {
    const plan = await selectedPlan();
    const outcome = await productionExecutor().handleSelectedPlan(plan as never, SYMBOL);
    const executionId = (outcome as { executionId: string }).executionId;

    // Deliberately remove what the production path now provides.
    await prisma!.tradeExecution.update({
      where: { id: executionId },
      data: { exchangeFiltersSnapshot: Prisma.DbNull },
    });
    const admitted = await admit(executionId);

    const result = await entries.prepareEntrySubmission({
      executionId: admitted.id,
      expectedVersion: admitted.version,
      evaluatedAt: at(),
    });

    // The fail-closed invariant is intact and still worth having.
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("SAFETY_ADMISSION_NOT_READY");
    expect(result.message).toContain("snapshot is missing");
    expect((await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: admitted.id } })).status).toBe("PREFLIGHT");
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: admitted.id } })).toBe(0);
    expect(dispatched).toBe(0);
  });

  maybe()("still fails closed when the margin plan snapshot is missing", async () => {
    const plan = await selectedPlan();
    const outcome = await productionExecutor().handleSelectedPlan(plan as never, SYMBOL);
    const executionId = (outcome as { executionId: string }).executionId;

    await prisma!.tradeExecution.update({
      where: { id: executionId },
      data: { marginPlanSnapshot: Prisma.DbNull },
    });
    const admitted = await admit(executionId);

    const result = await entries.prepareEntrySubmission({
      executionId: admitted.id,
      expectedVersion: admitted.version,
      evaluatedAt: at(),
    });

    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("SAFETY_ADMISSION_NOT_READY");
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: admitted.id } })).toBe(0);
  });
});
