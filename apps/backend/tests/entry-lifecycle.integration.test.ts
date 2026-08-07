import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
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
process.env.BINANCE_FUTURES_REST_BASE_URL = "https://testnet.binancefuture.example";

function resolveDatabaseUrl(): string | null {
  for (const candidate of [path.join(process.cwd(), ".env"), path.join(process.cwd(), "apps", "backend", ".env")]) {
    try {
      const match = /^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m.exec(readFileSync(candidate, "utf8"));
      if (match) return match[1].trim();
    } catch {
      // Try the next candidate path.
    }
  }
  return process.env.DATABASE_URL ?? null;
}

const databaseUrl = resolveDatabaseUrl();
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;

/** Module-scope probe: it/it.skip is chosen at collection time. */
let available = false;
if (prisma) {
  try {
    await prisma.$queryRaw`SELECT 1`;
    available = true;
  } catch (error) {
    console.warn(
      `[phase6] Skipping entry lifecycle integration tests — no database reachable: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }`
    );
  }
} else {
  console.warn("[phase6] Skipping entry lifecycle integration tests — no DATABASE_URL could be resolved.");
}

const { ExecutionService } = await import("../src/modules/execution/execution.service");
const { EntryLifecycleService } = await import("../src/modules/execution/entry-lifecycle.service");
const { BinanceUsdMExecutionClient } = await import("../src/modules/binance/binance-execution.client");
const { BinanceError } = await import("../src/modules/binance/binance.errors");
const { buildClientOrderId } = await import("../src/modules/execution/execution-safety");

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
    expect(outcome.reasonCode).toBe("LIVE_ENTRY_DISABLED");
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
