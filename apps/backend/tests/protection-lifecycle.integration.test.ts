import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";
import type { DynamicLeveragePlan } from "@trading-alert-dashboard/shared";
import type { TradeExecutionStatusName } from "../src/modules/execution/execution-status";

/**
 * Phase 7 integration tests against a real Postgres, with FAKE transports.
 *
 * No test here can reach Binance or Telegram: reads come from a scripted stub,
 * mutations go to an in-memory fake that records every call, and the critical
 * alert sender is a fake that records messages. Every row is synthetic and
 * removed in afterAll.
 */

const SYNTHETIC_TAG = "phase7-synthetic";
const SYMBOL = "TESTPUSDT";

// Env must be set BEFORE config/env.ts is evaluated. The two live-entry gates
// stay CLOSED on purpose: every Phase 7 mutation is risk-reducing and must
// work regardless.
process.env.EXECUTION_GLOBAL_KILL_SWITCH = "false";
process.env.EXECUTION_LIVE_ENTRY_ENABLED = "false";
process.env.EXECUTION_PROTECTION_READY = "false";
process.env.EXECUTION_AUTO_ADD_MARGIN_ENABLED = "false";
process.env.EXECUTION_EMERGENCY_CLOSE_MODE = "DISABLED";
process.env.EXECUTION_PROTECTION_RECONCILE_MAX_ATTEMPTS = "2";
process.env.EXECUTION_SL_WORKING_TYPE = "MARK_PRICE";
process.env.EXECUTION_TP_WORKING_TYPE = "CONTRACT_PRICE";
process.env.BINANCE_FUTURES_REST_BASE_URL = "https://testnet.binancefuture.example";

// Integration state lives in the DEDICATED test database. The helper refuses
// to fall back to the runtime/canary database, so a misconfiguration fails the
// suite instead of quietly writing synthetic executions into runtime state.
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ExecutionService } = await import("../src/modules/execution/execution.service");
const { ProtectionLifecycleService } = await import("../src/modules/execution/protection-lifecycle.service");
const { CriticalAlertService } = await import("../src/modules/execution/critical-alert.service");
const { BinanceError } = await import("../src/modules/binance/binance.errors");
const { buildClientOrderId } = await import("../src/modules/execution/execution-safety");

type ExecutionServiceType = InstanceType<typeof ExecutionService>;
type ProtectionServiceType = InstanceType<typeof ProtectionLifecycleService>;

// ---------------------------------------------------------------------------
// Scriptable exchange + Telegram fakes
// ---------------------------------------------------------------------------

interface AlgoOrderRow {
  clientAlgoId: string;
  algoId: string;
  symbol: string;
  algoStatus: string;
  side: string;
  positionSide: string;
  orderType: string;
  quantity: string;
  triggerPrice: string;
  workingType: string;
  priceProtect: boolean;
  executedQty: string;
  avgPrice: string;
}

interface Scenario {
  positionAmt: string | null;
  markPrice: string;
  liquidationPrice: string | null;
  isolatedMargin: string | null;
  leverage: string;
  availableBalance: string;
  symbolStatus: string;
  contractType: string;
  positionMissing: boolean;
  algoOrders: Map<string, AlgoOrderRow>;
  /** clientAlgoId values whose query must fail. */
  queryFailures: Set<string>;
  submitFailure: Error | null;
  submitLands: boolean;
  cancelFailure: Error | null;
  marginFailure: Error | null;
  marginLands: boolean;
  emergencyFailure: Error | null;
  standardOrders: Map<string, { status: string; executedQty: string; avgPrice: string; orderId: string; side?: string; type?: string; price?: string; origQty?: string }>;
  mutations: string[];
  submitted: Record<string, string>[];
  telegramMessages: string[];
  telegramFails: boolean;
  entryCancelFailure: Error | null;
  entryQueryUnavailable: boolean;
  /** Position reported by the query that follows entry cleanup. */
  positionAfterEntryCleanup: string | null;
  /** Makes the algo readback report closePosition=true (a real contradiction). */
  closePositionOnReadback: boolean;
}

const scenario: Scenario = {} as Scenario;

function resetScenario() {
  Object.assign(scenario, {
    positionAmt: "0.100",
    markPrice: "100",
    liquidationPrice: "90",
    isolatedMargin: "3.00",
    leverage: "10",
    availableBalance: "500",
    symbolStatus: "TRADING",
    contractType: "PERPETUAL",
    positionMissing: false,
    algoOrders: new Map<string, AlgoOrderRow>(),
    queryFailures: new Set<string>(),
    submitFailure: null,
    submitLands: true,
    cancelFailure: null,
    marginFailure: null,
    marginLands: true,
    emergencyFailure: null,
    standardOrders: new Map(),
    mutations: [],
    submitted: [],
    telegramMessages: [],
    telegramFails: false,
    entryCancelFailure: null,
    entryQueryUnavailable: false,
    positionAfterEntryCleanup: null,
    closePositionOnReadback: false,
  } satisfies Scenario);
}

function timeoutError(endpoint: string) {
  return new BinanceError({ kind: "TIMEOUT", message: `Binance ${endpoint} timed out`, endpoint });
}

const readOnlyStub = {
  async getAccountSummary() {
    return {
      connection: { ok: true, host: "fake", serverTimeMs: Date.now(), serverTimeIso: "", clockOffsetMs: 0, roundTripMs: 1 },
      positionMode: "HEDGE",
      assetMode: "SINGLE_ASSET",
      usdtWalletBalance: scenario.availableBalance,
      usdtAvailableBalance: scenario.availableBalance,
      nonZeroPositionCount: 1,
      openOrderCount: 0,
      openOrderSymbols: [] as string[],
      positions: [] as { symbol: string }[],
      warnings: [],
    };
  },
  async inspectSymbol(symbol: string) {
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
  async getPositionForSide(_symbol: string, positionSide: string) {
    if (scenario.positionMissing) return null;
    return {
      symbol: SYMBOL,
      positionSide,
      positionAmt: scenario.positionAmt,
      entryPrice: "100",
      markPrice: scenario.markPrice,
      liquidationPrice: scenario.liquidationPrice,
      isolatedMargin: scenario.isolatedMargin,
      isolatedWallet: scenario.isolatedMargin,
      leverage: scenario.leverage,
      unrealizedProfit: "0",
      notional: "10",
      marginType: "isolated",
    };
  },
  async queryAlgoOrderByClientAlgoId(_symbol: string, clientAlgoId: string) {
    if (scenario.queryFailures.has(clientAlgoId)) throw timeoutError("algoOrder");
    const row = scenario.algoOrders.get(clientAlgoId);
    if (!row) {
      throw new BinanceError({
        kind: "MALFORMED_RESPONSE",
        message: "Algo order does not exist",
        binanceCode: -2013,
        endpoint: "algoOrder",
      });
    }
    return {
      algoId: row.algoId,
      clientAlgoId: row.clientAlgoId,
      symbol: row.symbol,
      algoStatus: row.algoStatus,
      algoType: "CONDITIONAL",
      side: row.side,
      positionSide: row.positionSide,
      orderType: row.orderType,
      quantity: row.quantity,
      triggerPrice: row.triggerPrice,
      workingType: row.workingType,
      priceProtect: row.priceProtect,
      closePosition: scenario.closePositionOnReadback,
      // Binance's Algo Service sets reduceOnly ITSELF on a hedge-mode closing
      // conditional order and reports it back as true, even though we never
      // send it. Proven against the real mainnet order tad-sl-1-ed8fa3f5d4f2.
      // This fixture previously returned false, modelling an exchange that
      // does not exist — which is exactly why every protection test passed
      // while Mainnet Canary #2 failed.
      reduceOnly: true,
      actualOrderId: null,
      executedQuantity: row.executedQty,
      averagePrice: row.avgPrice,
      triggerTimeMs: null,
      updateTimeMs: Date.now(),
    };
  },
  async queryOrderByClientOrderId(_symbol: string, clientOrderId: string) {
    if (scenario.entryQueryUnavailable) throw timeoutError("order");
    const row = scenario.standardOrders.get(clientOrderId);
    if (!row) {
      throw new BinanceError({ kind: "MALFORMED_RESPONSE", message: "Order does not exist", binanceCode: -2013, endpoint: "order" });
    }
    return {
      orderId: row.orderId,
      clientOrderId,
      symbol: SYMBOL,
      status: row.status,
      side: row.side ?? "SELL",
      positionSide: "LONG",
      type: row.type ?? "MARKET",
      timeInForce: null,
      price: row.price ?? "0",
      origQty: row.origQty ?? row.executedQty,
      executedQty: row.executedQty,
      averagePrice: row.avgPrice,
      reduceOnly: false,
      closePosition: false,
      updateTimeMs: Date.now(),
    };
  },
  async getPositionMarginHistory() {
    return [];
  },
};

let dispatched = 0;

const mutationStub = {
  get mutationsDispatched() {
    return dispatched;
  },
  get blockedReason() {
    return "LIVE_ENTRY_DISABLED";
  },
  authorizeProtectionSubmission(input: Record<string, unknown>) {
    if (buildClientOrderId(String(input.executionId), String(input.role), Number(input.generation)) !== input.clientAlgoId) {
      throw new Error("client algo id does not belong to this tranche");
    }
    return { ...input, kind: "PROTECTION_SUBMISSION" };
  },
  authorizeProtectionCancellation(input: Record<string, unknown>) {
    if (buildClientOrderId(String(input.executionId), String(input.role), Number(input.generation)) !== input.clientAlgoId) {
      throw new Error("client algo id does not belong to this tranche");
    }
    return { ...input, kind: "PROTECTION_CANCELLATION" };
  },
  authorizeMarginAddition(input: Record<string, unknown>) {
    return { ...input, kind: "MARGIN_ADDITION" };
  },
  authorizeEmergencyClose(input: Record<string, unknown>) {
    if (buildClientOrderId(String(input.executionId), "EMERGENCY_CLOSE", 1) !== input.clientOrderId) {
      throw new Error("client order id does not belong to this execution");
    }
    return { ...input, kind: "EMERGENCY_CLOSE" };
  },
  async submitProtectionOrder(context: Record<string, string>) {
    dispatched += 1;
    scenario.mutations.push(`POST /fapi/v1/algoOrder ${context.orderType ?? context.role}`);
    scenario.submitted.push({ ...context });
    if (scenario.submitFailure) {
      const error = scenario.submitFailure;
      scenario.submitFailure = null;
      if (scenario.submitLands) landAlgoOrder(context);
      throw error;
    }
    landAlgoOrder(context);
    return { algoId: "A1", clientAlgoId: context.clientAlgoId, symbol: SYMBOL, algoStatus: "NEW" };
  },
  async cancelProtectionOrder(context: Record<string, string>) {
    dispatched += 1;
    scenario.mutations.push("DELETE /fapi/v1/algoOrder");
    if (scenario.cancelFailure) {
      const error = scenario.cancelFailure;
      scenario.cancelFailure = null;
      throw error;
    }
    const row = scenario.algoOrders.get(context.clientAlgoId);
    if (row) row.algoStatus = "CANCELED";
    return { algoId: "A1", clientAlgoId: context.clientAlgoId, symbol: SYMBOL, algoStatus: "CANCELED" };
  },
  async addIsolatedMargin(context: Record<string, string>) {
    dispatched += 1;
    scenario.mutations.push(`POST /fapi/v1/positionMargin ${context.amount} ${context.positionSide}`);
    if (scenario.marginFailure) {
      const error = scenario.marginFailure;
      scenario.marginFailure = null;
      if (scenario.marginLands) {
        scenario.isolatedMargin = String(Number(scenario.isolatedMargin) + Number(context.amount));
      }
      throw error;
    }
    if (scenario.marginLands) {
      scenario.isolatedMargin = String(Number(scenario.isolatedMargin) + Number(context.amount));
      scenario.liquidationPrice = "80";
    }
    return { code: 200, msg: "success" };
  },
  authorizeEntryCancellation(input: Record<string, unknown>) {
    if (input.role !== "ENTRY" || input.generation !== 1) throw new Error("narrow scope violated");
    if (buildClientOrderId(String(input.executionId), "ENTRY", 1) !== input.clientOrderId) {
      throw new Error("client order id does not belong to this execution");
    }
    return { ...input, kind: "ENTRY_CANCELLATION" };
  },
  async cancelReservedEntryOrder(context: Record<string, string>) {
    dispatched += 1;
    scenario.mutations.push("DELETE /fapi/v1/order ENTRY");
    if (scenario.entryCancelFailure) {
      const error = scenario.entryCancelFailure;
      scenario.entryCancelFailure = null;
      throw error;
    }
    const row = scenario.standardOrders.get(context.clientOrderId);
    if (row) row.status = "CANCELED";
    if (scenario.positionAfterEntryCleanup !== null) {
      scenario.positionAmt = scenario.positionAfterEntryCleanup;
      scenario.positionAfterEntryCleanup = null;
    }
    return { orderId: row?.orderId ?? "X", clientOrderId: context.clientOrderId, symbol: SYMBOL, status: "CANCELED" };
  },
  async submitEmergencyMarketClose(context: Record<string, string>) {
    dispatched += 1;
    scenario.mutations.push(`POST /fapi/v1/order MARKET ${context.quantity}`);
    if (scenario.emergencyFailure) {
      const error = scenario.emergencyFailure;
      scenario.emergencyFailure = null;
      throw error;
    }
    scenario.standardOrders.set(context.clientOrderId, {
      status: "FILLED",
      executedQty: context.quantity,
      avgPrice: "100",
      orderId: "E1",
    });
    scenario.positionAmt = "0";
    return { orderId: "E1", clientOrderId: context.clientOrderId, symbol: SYMBOL, status: "NEW" };
  },
};

function landAlgoOrder(context: Record<string, string>) {
  scenario.algoOrders.set(context.clientAlgoId, {
    clientAlgoId: context.clientAlgoId,
    algoId: `A-${scenario.algoOrders.size + 1}`,
    symbol: SYMBOL,
    algoStatus: "NEW",
    side: context.side,
    positionSide: context.positionSide,
    orderType: context.role === "STOP_LOSS" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
    quantity: context.quantity,
    triggerPrice: context.triggerPrice,
    workingType: context.workingType,
    priceProtect: Boolean(context.priceProtect),
    executedQty: "0",
    avgPrice: "0",
  });
}

/** Fake Telegram sender: records messages, never sends. */
const fakeSender = async (text: string): Promise<boolean> => {
  scenario.telegramMessages.push(text);
  return !scenario.telegramFails;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let executions: ExecutionServiceType;
let protectionService: ProtectionServiceType;
let alertService: InstanceType<typeof CriticalAlertService>;
let profileId = "";
let sequence = 0;

function readyPlan(direction: "LONG" | "SHORT" = "LONG"): DynamicLeveragePlan {
  return {
    status: "READY", reason: null, reasonMessage: null, symbol: SYMBOL, direction,
    entryPrice: "100", stopLoss: direction === "LONG" ? "96" : "104",
    calculatedStopLoss: direction === "LONG" ? "96" : "104", executableStopLoss: direction === "LONG" ? "96" : "104",
    stopAdjustment: "0", stopNormalization: null, stopLossSource: "CALCULATED", stopDistance: "4",
    riskBudgetUsd: "1.50", quantityRaw: "0.375", roundedQuantity: "0.375", quantityStepSize: "0.001",
    actualPlannedLoss: "1.5", unusedRiskBudget: "0", positionNotional: "37.5", minimumNotional: "5",
    targetMarginMultiplier: "2.5", maximumMarginMultiplier: "3.333333", targetIsolatedMargin: "3.75",
    maximumIsolatedMargin: "5.00", applicableBracket: null, maximumSupportedLeverage: 50,
    binanceMaximumSupportedLeverage: 50, userMaximumAutomationLeverage: 25, usableMaximumLeverage: 25,
    selectedLeverage: 10, estimatedInitialMargin: "3.75",
    estimatedLiquidationPrice: direction === "LONG" ? "90.1" : "109.9",
    requiredLiquidationBoundary: direction === "LONG" ? "94" : "106",
    liquidationBufferRatio: "0.5", liquidationDistance: "5.9", safetyBufferDistance: "2",
    marginDifferenceFromTarget: "0", candidates: [], warnings: [],
  } as DynamicLeveragePlan;
}

/** An execution with a confirmed partial fill and an open position. */
async function filledExecution(options: { direction?: "LONG" | "SHORT"; filled?: string } = {}) {
  const direction = options.direction ?? "LONG";
  sequence += 1;
  const alert = await prisma!.alert.create({
    data: {
      symbol: SYMBOL, assetType: "CRYPTO", exchange: "SYNTHETIC", timeframe: "15m", price: 100,
      signal: direction, indicatorName: `${SYNTHETIC_TAG}-${sequence}`, rawPayload: { note: SYNTHETIC_TAG },
      triggeredAt: new Date(),
    },
  });
  const created = await executions.createExecutionFromReadyPlan({
    executionProfileId: profileId,
    alertId: alert.id,
    plan: readyPlan(direction),
    positionSide: direction,
    selectedLookback: 200,
    takeProfit: direction === "LONG" ? "108" : "92",
    snapshots: { exchangeFilters: { tickSize: "0.01" } },
  });

  return prisma!.tradeExecution.update({
    where: { id: created.id },
    data: {
      status: "PARTIALLY_FILLED",
      filledQuantity: options.filled ?? "0.100",
      version: { increment: 1 },
    },
  });
}

beforeAll(async () => {
  if (!prisma || !available) return;
  executions = new ExecutionService(prisma);
  alertService = new CriticalAlertService(prisma, fakeSender);
  protectionService = new ProtectionLifecycleService(
    prisma,
    readOnlyStub as never,
    mutationStub as never,
    alertService,
    { reconcileMaxAttempts: 2 }
  );

  const profile = await prisma.executionProfile.create({
    data: { name: "Phase 7 synthetic profile", accountIdentifier: `${SYNTHETIC_TAG}-account`, environment: "TESTNET", isEnabled: true },
  });
  profileId = profile.id;
});

afterEach(async () => {
  resetScenario();
  dispatched = 0;
  if (!prisma || !available) return;
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
      await prisma.criticalAlert.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.marginAdjustmentIntent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.executionProtectionState.deleteMany({ where: { tradeExecutionId: { in: ids } } });
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
    await prisma.executionProfile.deleteMany({ where: { accountIdentifier: `${SYNTHETIC_TAG}-account` } });
    await prisma.alert.deleteMany({ where: { indicatorName: { startsWith: SYNTHETIC_TAG } } });
  }
  await prisma.$disconnect();
});

resetScenario();
const maybe = () => (available ? it : it.skip);
const at = () => new Date();

const protect = async (execution: { id: string; version: number }) =>
  protectionService.ensureProtectionForExposure({
    executionId: execution.id,
    expectedVersion: execution.version,
    evaluatedAt: at(),
  });

const reload = async (id: string) => prisma!.tradeExecution.findUniqueOrThrow({ where: { id } });
const protectionOf = async (id: string) =>
  prisma!.executionProtectionState.findUniqueOrThrow({ where: { tradeExecutionId: id } });
const ordersOf = async (id: string) =>
  prisma!.binanceOrder.findMany({ where: { tradeExecutionId: id }, orderBy: [{ generation: "asc" }, { role: "asc" }] });

// ===========================================================================

describe("first fill", () => {
  maybe()("creates no protection when nothing has filled", async () => {
    const execution = await filledExecution({ filled: "0" });
    await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { filledQuantity: "0" } });

    const outcome = await protect(await reload(execution.id));
    expect(outcome.reasonCode).toBe("EXECUTION_HAS_NO_CONFIRMED_FILL");
    expect(scenario.mutations).toHaveLength(0);
    expect(await ordersOf(execution.id)).toHaveLength(0);
  });

  maybe()("starts protection on the first partial fill without waiting for ENTRY_FILLED", async () => {
    const execution = await filledExecution({ filled: "0.100" });
    expect(execution.status).toBe("PARTIALLY_FILLED");

    const outcome = await protect(execution);

    expect(outcome.ok).toBe(true);
    expect(outcome.reasonCode).toBe("PROTECTION_VERIFIED");
    // The ENTRY status is untouched — a partial entry still consumes its
    // pending-entry capacity.
    expect((await reload(execution.id)).status).toBe("PARTIALLY_FILLED");
    expect((await protectionOf(execution.id)).state).toBe("PROTECTED");
  });

  maybe()("submits the stop before the take profit", async () => {
    const execution = await filledExecution();
    await protect(execution);

    const roles = scenario.submitted.map((entry) => entry.role);
    expect(roles).toEqual(["STOP_LOSS", "TAKE_PROFIT"]);
  });

  // ===========================================================================
  // MAINNET CANARY #2 REGRESSION — execution cmssohd070004t9h226c92lfn.
  //
  // A live, correct DOGSUSDT STOP was rejected because Binance's Algo Service
  // reported reduceOnly=true on the hedge-mode closing conditional order. The
  // STOP therefore never verified, submitTranche returned before the take
  // profit, and the TP was NEVER SUBMITTED — its row sat at SUBMITTING with
  // reconcileAttempts=0 while the execution parked at MANUAL_INTERVENTION with
  // a live, genuinely-protected position.
  //
  // This test fails on the pre-fix implementation with
  // reasonCode STOP_IDENTITY_MISMATCH and zero TAKE_PROFIT submissions.
  // ===========================================================================

  maybe()("MAINNET CANARY #2: reduceOnly=true on the STOP readback still verifies and reaches the TP", async () => {
    const execution = await filledExecution();

    const outcome = await protect(execution);

    // 1. The STOP verified rather than being rejected as a foreign identity.
    expect(outcome.reasonCode).not.toBe("STOP_IDENTITY_MISMATCH");
    // 2. submitTranche continued past the stop: the TP was ACTUALLY submitted.
    expect(scenario.submitted.map((entry) => entry.role)).toEqual(["STOP_LOSS", "TAKE_PROFIT"]);
    // 3. Both protections are live on the exchange under their own ids.
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    const takeProfitId = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);
    expect(scenario.algoOrders.get(stopId)?.algoStatus).toBe("NEW");
    expect(scenario.algoOrders.get(takeProfitId)?.algoStatus).toBe("NEW");
    // 4. And the exchange really is reporting the mainnet shape.
    expect((await readOnlyStub.queryAlgoOrderByClientAlgoId(SYMBOL, stopId)).reduceOnly).toBe(true);

    // 5. Both local rows left SUBMITTING and became active coverage.
    const orders = await ordersOf(execution.id);
    const stop = orders.find((order) => order.role === "STOP_LOSS")!;
    const takeProfit = orders.find((order) => order.role === "TAKE_PROFIT")!;
    expect(stop.status).toBe("NEW");
    expect(takeProfit.status).toBe("NEW");
    expect(takeProfit.status).not.toBe("SUBMITTING");

    // 6. The execution is protected, not parked for a human.
    const reloaded = await reload(execution.id);
    expect(reloaded.status).not.toBe("MANUAL_INTERVENTION");
    expect(reloaded.requiresManualIntervention).toBe(false);
    expect((await protectionOf(execution.id)).state).toBe("PROTECTED");
    expect(outcome.ok).toBe(true);
  });

  maybe()("MAINNET CANARY #2: closePosition=true is still rejected as a foreign identity", async () => {
    // The relaxation must not have weakened the check that actually matters.
    const execution = await filledExecution();
    scenario.closePositionOnReadback = true;

    const outcome = await protect(execution);

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("STOP_IDENTITY_MISMATCH");
    // The take profit is never reached when the stop is unverified.
    expect(scenario.submitted.map((entry) => entry.role)).toEqual(["STOP_LOSS"]);

    // This is the only test here that deliberately raises alerts, and
    // `flushPending` drains the OLDEST 20 outbox rows globally. Leaving them
    // behind would eat the batch budget of the alert-outbox tests further
    // down the file, so this test cleans up after itself.
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("uses the exact confirmed position quantity, not the local fill", async () => {
    const execution = await filledExecution({ filled: "0.100" });
    scenario.positionAmt = "0.080"; // the exchange is authoritative
    await protect(execution);

    expect(scenario.submitted[0].quantity).toBe("0.08");
    expect((await protectionOf(execution.id)).confirmedOpenQuantity.toString()).toBe("0.08");
  });

  maybe()("escalates when no position exists after a recorded fill", async () => {
    const execution = await filledExecution();
    scenario.positionMissing = true;

    const outcome = await protect(execution);
    expect(outcome.reasonCode).toBe("POSITION_NOT_FOUND_AFTER_FILL");
    expect((await protectionOf(execution.id)).state).toBe("MANUAL_INTERVENTION");
    expect(scenario.mutations).toHaveLength(0);
  });

  maybe()("escalates when the position sign contradicts the direction", async () => {
    const execution = await filledExecution({ direction: "LONG" });
    scenario.positionAmt = "-0.100";

    const outcome = await protect(execution);
    expect(outcome.reasonCode).toBe("POSITION_IDENTITY_MISMATCH");
    expect(scenario.mutations).toHaveLength(0);
  });
});

// ===========================================================================
// MAINNET CANARY #3 REGRESSION — execution cmst5kcdw0004au5034zwpqq6.
//
// ExecutionProtectionState reached PROTECTED with full verified coverage on
// both legs and 70 consecutive verifications, while TradeExecution.status sat
// at ENTRY_FILLED forever. The service could commit every way protection goes
// WRONG (MANUAL_INTERVENTION, CLOSED_*), and no way it goes right: nothing in
// the codebase ever wrote PLACING_PROTECTION or PROTECTED to the execution.
// ===========================================================================

describe("execution status reflects verified protection", () => {
  /** A fully filled entry — the real Canary #3 shape. */
  async function entryFilledExecution() {
    const seed = await filledExecution();
    await prisma!.tradeExecution.update({
      where: { id: seed.id },
      data: { status: "ENTRY_FILLED", version: { increment: 1 } },
    });
    return reload(seed.id);
  }

  const eventsOf = async (id: string) =>
    prisma!.executionEvent.findMany({ where: { tradeExecutionId: id }, orderBy: { sequenceNumber: "asc" } });

  maybe()("A. a fully covered execution reaches status PROTECTED", async () => {
    const execution = await entryFilledExecution();

    const outcome = await protect(execution);

    expect(outcome.ok).toBe(true);
    expect(outcome.reasonCode).toBe("PROTECTION_VERIFIED");
    const after = await reload(execution.id);
    expect(after.status).toBe("PROTECTED");
    // The protection row and the execution row now AGREE — the whole defect.
    expect((await protectionOf(execution.id)).state).toBe("PROTECTED");
    expect(after.requiresManualIntervention).toBe(false);
  });

  maybe()("B. takes the documented legal path ENTRY_FILLED -> PLACING_PROTECTION -> PROTECTED", async () => {
    const { canTransition } = await import("../src/modules/execution/execution-status");
    const execution = await entryFilledExecution();

    await protect(execution);

    const transitions = (await eventsOf(execution.id))
      .filter((event) => event.fromStatus !== null && event.fromStatus !== event.toStatus)
      .map((event) => `${event.fromStatus}->${event.toStatus}`);
    expect(transitions).toEqual(["ENTRY_FILLED->PLACING_PROTECTION", "PLACING_PROTECTION->PROTECTED"]);
    // Every hop is legal, so no new state-machine edge was needed.
    expect(canTransition("ENTRY_FILLED", "PLACING_PROTECTION").allowed).toBe(true);
    expect(canTransition("PLACING_PROTECTION", "PROTECTED").allowed).toBe(true);
    expect(canTransition("ENTRY_FILLED", "PROTECTED").allowed).toBe(false);
  });

  maybe()("C. incomplete coverage never reaches PROTECTED", async () => {
    const execution = await entryFilledExecution();
    const takeProfitId = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);
    // The stop lands; the take profit is lost, so aggregate coverage has a gap.
    const originalSubmit = mutationStub.submitProtectionOrder;
    mutationStub.submitProtectionOrder = async (context: Record<string, string>) => {
      if (context.role === "TAKE_PROFIT") {
        scenario.queryFailures.add(takeProfitId);
        throw timeoutError("newAlgoOrder");
      }
      return originalSubmit.call(mutationStub, context);
    };

    try {
      const outcome = await protect(execution);
      expect(outcome.ok).toBe(false);
      const after = await reload(execution.id);
      // It may legitimately sit at PLACING_PROTECTION, but never PROTECTED.
      expect(after.status).not.toBe("PROTECTED");
      expect((await protectionOf(execution.id)).state).not.toBe("PROTECTED");
    } finally {
      mutationStub.submitProtectionOrder = originalSubmit;
      await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
    }
  });

  maybe()("D. an unverified STOP never reaches PROTECTED", async () => {
    const execution = await entryFilledExecution();
    scenario.submitFailure = timeoutError("newAlgoOrder");
    scenario.submitLands = false;

    await protect(execution);

    const after = await reload(execution.id);
    expect(after.status).not.toBe("PROTECTED");
    expect((await protectionOf(execution.id)).state).not.toBe("PROTECTED");
    // `flushPending` drains the OLDEST 20 outbox rows globally, so a test that
    // deliberately raises alerts must not eat the alert-outbox tests' budget.
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("E. is idempotent across repeated ticks", async () => {
    const execution = await entryFilledExecution();
    await protect(execution);

    const first = await reload(execution.id);
    const firstEvents = await eventsOf(execution.id);
    expect(first.status).toBe("PROTECTED");

    // Two more reconciliation ticks.
    await protect(await reload(execution.id));
    await protect(await reload(execution.id));

    const second = await reload(execution.id);
    expect(second.status).toBe("PROTECTED");
    // No duplicate transition, no event churn, no version churn.
    expect(second.version).toBe(first.version);
    expect((await eventsOf(execution.id)).length).toBe(firstEvents.length);
    // And no second protection generation was ever reserved.
    const orders = await ordersOf(execution.id);
    expect(orders.filter((order) => order.role === "STOP_LOSS")).toHaveLength(1);
    expect(orders.filter((order) => order.role === "TAKE_PROFIT")).toHaveLength(1);
  });

  maybe()("F. closure is still detected from the new PROTECTED status", async () => {
    const execution = await entryFilledExecution();
    await protect(execution);
    expect((await reload(execution.id)).status).toBe("PROTECTED");

    // The take profit fills and the position goes flat.
    const takeProfitId = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);
    scenario.algoOrders.get(takeProfitId)!.algoStatus = "FILLED";
    scenario.algoOrders.get(takeProfitId)!.executedQty = "0.100";
    scenario.positionAmt = "0";
    const current = await reload(execution.id);
    const outcome = await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(true);
    expect((await reload(execution.id)).status).toBe("CLOSED_TP");
  });

  maybe()("F2. external flat recovery still reaches CLOSED_EXTERNAL from PROTECTED", async () => {
    const execution = await entryFilledExecution();
    await protect(execution);
    expect((await reload(execution.id)).status).toBe("PROTECTED");

    // Closed by something that is not one of our orders.
    scenario.positionAmt = "0";
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "STOP_LOSS", 1));
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "TAKE_PROFIT", 1));

    const current = await reload(execution.id);
    await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });

    expect((await reload(execution.id)).status).toBe("CLOSED_EXTERNAL");
  });

  maybe()("never promotes a PARTIALLY_FILLED entry, which still holds pending-entry capacity", async () => {
    const { consumesPendingEntry } = await import("../src/modules/execution/capacity-status");
    // filledExecution() is PARTIALLY_FILLED: its entry is still on the book.
    const execution = await filledExecution();

    const outcome = await protect(execution);

    expect(outcome.ok).toBe(true);
    const after = await reload(execution.id);
    expect(after.status).toBe("PARTIALLY_FILLED");
    // Promoting it would have released the capacity its resting entry holds.
    expect(consumesPendingEntry("PARTIALLY_FILLED")).toBe(true);
    expect(consumesPendingEntry("PROTECTED")).toBe(false);
    // The protection row still records the truth.
    expect((await protectionOf(execution.id)).state).toBe("PROTECTED");
  });

  // -------------------------------------------------------------------------
  // PROTECTED must keep receiving the FULL health path.
  //
  // `reconcileProtectionAndClosure` returns early while exposure remains and
  // measures no coverage at all, so these prove the health pass — which the
  // orchestrator now runs after closure — still detects and repairs a leg that
  // vanished from the exchange.
  // -------------------------------------------------------------------------

  /** A PROTECTED execution with both legs live, as the fix now produces. */
  async function protectedExecution() {
    const execution = await entryFilledExecution();
    await protect(execution);
    expect((await reload(execution.id)).status).toBe("PROTECTED");
    scenario.submitted = [];
    scenario.mutations = [];
    return reload(execution.id);
  }

  maybe()("closure reconciliation ALONE never notices a cancelled STOP", async () => {
    // Characterises the gap the routing fix works around. This is why the
    // orchestrator cannot route PROTECTED to closure reconciliation alone.
    const execution = await protectedExecution();
    scenario.algoOrders.get(buildClientOrderId(execution.id, "STOP_LOSS", 1))!.algoStatus = "CANCELED";

    const outcome = await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    // It reports only "position still open" and repairs nothing.
    expect(outcome.ok).toBe(false);
    expect(scenario.submitted).toEqual([]);
  });

  maybe()("2. the health path detects a cancelled STOP and repairs it", async () => {
    const execution = await protectedExecution();
    scenario.algoOrders.get(buildClientOrderId(execution.id, "STOP_LOSS", 1))!.algoStatus = "CANCELED";

    // Exactly what the orchestrator now runs for a still-open PROTECTED row.
    await protect(await reload(execution.id));

    // A replacement tranche was reserved and submitted for the missing leg.
    const stops = (await ordersOf(execution.id)).filter((order) => order.role === "STOP_LOSS");
    expect(stops.length).toBeGreaterThan(1);
    expect(stops.some((order) => order.generation === 2)).toBe(true);
    expect(scenario.submitted.map((entry) => entry.role)).toContain("STOP_LOSS");
  });

  maybe()("3. the health path detects a cancelled TAKE_PROFIT and repairs it", async () => {
    const execution = await protectedExecution();
    scenario.algoOrders.get(buildClientOrderId(execution.id, "TAKE_PROFIT", 1))!.algoStatus = "CANCELED";

    await protect(await reload(execution.id));

    const takeProfits = (await ordersOf(execution.id)).filter((order) => order.role === "TAKE_PROFIT");
    expect(takeProfits.some((order) => order.generation === 2)).toBe(true);
  });

  maybe()("4. a partial coverage gap is detected and repaired", async () => {
    const execution = await protectedExecution();
    // The exchange now reports MORE exposure than the tranche covers.
    scenario.positionAmt = "0.200";

    await protect(await reload(execution.id));

    // A second generation covers exactly the missing delta.
    const orders = await ordersOf(execution.id);
    expect(orders.some((order) => order.generation === 2)).toBe(true);
    expect((await protectionOf(execution.id)).confirmedOpenQuantity.toString()).toBe("0.2");
  });

  // =========================================================================
  // UNKNOWN vs ABSENT — protection observation safety.
  //
  // `measureVerifiedCoverage` used to count an UNREADABLE leg as ZERO, making
  // it indistinguishable from a conclusively absent one. The lifecycle then saw
  // a gap and minted a REPLACEMENT generation, submitting a duplicate STOP and
  // TAKE_PROFIT while the originals may still have been live on Binance.
  //
  // Three states must stay distinct:
  //   PRESENT  — observed active         -> counts as coverage
  //   ABSENT   — proven gone (-2013)     -> a real gap, repair allowed
  //   UNKNOWN  — could not be determined -> no coverage claim, NO mutation
  // =========================================================================

  const generationsOf = async (id: string, role: "STOP_LOSS" | "TAKE_PROFIT") =>
    (await ordersOf(id)).filter((order) => order.role === role).map((order) => order.generation);

  maybe()("1. UNKNOWN STOP with a verified TP reserves nothing and submits nothing", async () => {
    const execution = await protectedExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    // Unreadable — which is NOT proof the stop is gone.
    scenario.queryFailures.add(stopId);

    const outcome = await protect(await reload(execution.id));

    // No replacement tranche, no new identity, nothing sent to the exchange.
    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1]);
    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toEqual([1]);
    expect(scenario.submitted).toEqual([]);
    expect(scenario.mutations).toEqual([]);
    // Deferred and retryable, not a false success and not an escalation.
    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("STOP_QUERY_UNAVAILABLE");
    // The original local intent is untouched — never rewritten as absent.
    const stop = (await ordersOf(execution.id)).find((order) => order.role === "STOP_LOSS")!;
    expect(stop.status).toBe("NEW");
    expect((await reload(execution.id)).requiresManualIntervention).toBe(false);
  });

  maybe()("2. UNKNOWN TAKE_PROFIT with a verified STOP reserves nothing and submits nothing", async () => {
    const execution = await protectedExecution();
    scenario.queryFailures.add(buildClientOrderId(execution.id, "TAKE_PROFIT", 1));

    const outcome = await protect(await reload(execution.id));

    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toEqual([1]);
    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1]);
    expect(scenario.submitted).toEqual([]);
    expect(outcome.reasonCode).toBe("TAKE_PROFIT_QUERY_UNAVAILABLE");
  });

  maybe()("3. a CONFIRMED ABSENT STOP is a real gap and is still repaired", async () => {
    const execution = await protectedExecution();
    // Binance PROVES this exact id is gone (-2013), unlike an unreadable query.
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "STOP_LOSS", 1));

    await protect(await reload(execution.id));

    expect(await generationsOf(execution.id, "STOP_LOSS")).toContain(2);
    expect(scenario.submitted.map((entry) => entry.role)).toContain("STOP_LOSS");
  });

  maybe()("4. a CONFIRMED ABSENT TAKE_PROFIT is a real gap and is still repaired", async () => {
    const execution = await protectedExecution();
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "TAKE_PROFIT", 1));

    await protect(await reload(execution.id));

    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toContain(2);
  });

  maybe()("5. UNKNOWN then PRESENT self-recovers with no mutation at all", async () => {
    const execution = await protectedExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);

    // Tick N: unreadable.
    scenario.queryFailures.add(stopId);
    await protect(await reload(execution.id));
    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1]);

    // Tick N+1: readable again, still active.
    scenario.queryFailures.delete(stopId);
    const outcome = await protect(await reload(execution.id));

    expect(outcome.ok).toBe(true);
    expect(outcome.reasonCode).toBe("PROTECTION_VERIFIED");
    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1]);
    expect(scenario.submitted).toEqual([]);
    expect((await reload(execution.id)).status).toBe("PROTECTED");
  });

  maybe()("6. UNKNOWN then ABSENT repairs only once absence is proven", async () => {
    const execution = await protectedExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);

    // Tick N: unreadable -> no mutation.
    scenario.queryFailures.add(stopId);
    await protect(await reload(execution.id));
    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1]);
    expect(scenario.submitted).toEqual([]);

    // Tick N+1: the exchange now PROVES it is gone.
    scenario.queryFailures.delete(stopId);
    scenario.algoOrders.delete(stopId);
    await protect(await reload(execution.id));

    expect(await generationsOf(execution.id, "STOP_LOSS")).toContain(2);
  });

  maybe()("7. both legs UNKNOWN yields neither a mutation nor a coverage claim", async () => {
    const execution = await protectedExecution();
    scenario.queryFailures.add(buildClientOrderId(execution.id, "STOP_LOSS", 1));
    scenario.queryFailures.add(buildClientOrderId(execution.id, "TAKE_PROFIT", 1));

    const outcome = await protect(await reload(execution.id));

    expect(scenario.submitted).toEqual([]);
    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1]);
    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toEqual([1]);
    // Not claimed healthy either — unknown is not "verified".
    expect(outcome.ok).toBe(false);
    expect(["STOP_QUERY_UNAVAILABLE", "TAKE_PROFIT_QUERY_UNAVAILABLE"]).toContain(outcome.reasonCode);
  });

  maybe()("8. repeated UNKNOWN ticks cause no generation, version or event churn", async () => {
    const execution = await protectedExecution();
    scenario.queryFailures.add(buildClientOrderId(execution.id, "STOP_LOSS", 1));

    const before = await reload(execution.id);
    const eventsBefore = await prisma!.executionEvent.count({ where: { tradeExecutionId: execution.id } });

    for (let tick = 0; tick < 4; tick += 1) await protect(await reload(execution.id));

    const after = await reload(execution.id);
    expect(after.version).toBe(before.version);
    expect(await prisma!.executionEvent.count({ where: { tradeExecutionId: execution.id } })).toBe(eventsBefore);
    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1]);
    expect(scenario.submitted).toEqual([]);
  });

  maybe()("9. a fully verified execution is unaffected by the unresolved gate", async () => {
    const execution = await protectedExecution();

    const outcome = await protect(await reload(execution.id));

    expect(outcome.ok).toBe(true);
    expect(outcome.reasonCode).toBe("PROTECTION_VERIFIED");
    expect(scenario.submitted).toEqual([]);
    expect((await reload(execution.id)).status).toBe("PROTECTED");
  });

  maybe()("a locally terminal generation never blocks the health path", async () => {
    // A dead generation 1 whose query later becomes unreadable must not stall
    // repair forever: we already know it is finished.
    const execution = await protectedExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    scenario.algoOrders.get(stopId)!.algoStatus = "CANCELED";
    await protect(await reload(execution.id));
    expect(await generationsOf(execution.id, "STOP_LOSS")).toContain(2);

    // Now generation 1 becomes unreadable. Generation 2 still covers.
    scenario.queryFailures.add(stopId);
    scenario.submitted = [];
    const outcome = await protect(await reload(execution.id));

    // No third generation: the unreadable leg is already locally terminal.
    expect(await generationsOf(execution.id, "STOP_LOSS")).not.toContain(3);
    expect(outcome.reasonCode).not.toBe("STOP_QUERY_UNAVAILABLE");
  });

  maybe()("6. an externally flat PROTECTED position still reaches CLOSED_EXTERNAL", async () => {
    const execution = await protectedExecution();
    scenario.positionAmt = "0";
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "STOP_LOSS", 1));
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "TAKE_PROFIT", 1));

    await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect((await reload(execution.id)).status).toBe("CLOSED_EXTERNAL");
  });

  maybe()("8. a filled STOP on a PROTECTED position reaches CLOSED_SL", async () => {
    const execution = await protectedExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    scenario.algoOrders.get(stopId)!.algoStatus = "FILLED";
    scenario.algoOrders.get(stopId)!.executedQty = "0.100";
    scenario.positionAmt = "0";

    await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect((await reload(execution.id)).status).toBe("CLOSED_SL");
  });

  maybe()("keeps every protected status counted as an open position", async () => {
    const { consumesOpenPosition } = await import("../src/modules/execution/capacity-status");
    // The fix must not change openPositionCount for a live protected trade.
    for (const status of ["ENTRY_FILLED", "PLACING_PROTECTION", "PROTECTED"] as const) {
      expect(consumesOpenPosition(status), status).toBe(true);
    }
  });
});

describe("protection parameters", () => {
  maybe()("maps LONG protection to SELL on positionSide LONG", async () => {
    const execution = await filledExecution({ direction: "LONG" });
    await protect(execution);

    for (const submitted of scenario.submitted) {
      expect(submitted.side).toBe("SELL");
      expect(submitted.positionSide).toBe("LONG");
    }
    expect(scenario.submitted[0].triggerPrice).toBe("96");
    expect(scenario.submitted[1].triggerPrice).toBe("108");
  });

  maybe()("maps SHORT protection to BUY on positionSide SHORT", async () => {
    const execution = await filledExecution({ direction: "SHORT" });
    scenario.positionAmt = "-0.100";

    await protect(execution);
    for (const submitted of scenario.submitted) {
      expect(submitted.side).toBe("BUY");
      expect(submitted.positionSide).toBe("SHORT");
    }
  });

  maybe()("freezes the working types into the local intent", async () => {
    const execution = await filledExecution();
    await protect(execution);

    const orders = await ordersOf(execution.id);
    const stop = orders.find((order) => order.role === "STOP_LOSS")!;
    const takeProfit = orders.find((order) => order.role === "TAKE_PROFIT")!;
    expect(stop.workingType).toBe("MARK_PRICE");
    expect(takeProfit.workingType).toBe("CONTRACT_PRICE");
    expect(stop.priceProtect).toBe(false);
  });

  maybe()("rejects a stop that would trigger immediately", async () => {
    const execution = await filledExecution();
    scenario.markPrice = "95"; // below the frozen 96 stop for a LONG

    const outcome = await protect(execution);
    expect(outcome.reasonCode).toBe("STOP_TRIGGER_INVALID");
    expect(scenario.mutations).toHaveLength(0);
    // The frozen stop was NOT moved to make it acceptable.
    expect((await reload(execution.id)).executableStopLoss.toString()).toBe("96");
  });
});

describe("protection reservation", () => {
  maybe()("reserves one paired generation with deterministic ids", async () => {
    const execution = await filledExecution();
    await protect(execution);

    const orders = await ordersOf(execution.id);
    expect(orders).toHaveLength(2);
    expect(orders.map((order) => order.generation)).toEqual([1, 1]);
    expect(orders.find((order) => order.role === "STOP_LOSS")!.clientAlgoId).toBe(
      buildClientOrderId(execution.id, "STOP_LOSS", 1)
    );
    expect(orders.find((order) => order.role === "TAKE_PROFIT")!.clientAlgoId).toBe(
      buildClientOrderId(execution.id, "TAKE_PROFIT", 1)
    );
  });

  maybe()("records one reservation event whose sequence is the bumped version", async () => {
    const execution = await filledExecution();
    await protect(execution);

    const events = await prisma!.executionEvent.findMany({
      where: { tradeExecutionId: execution.id, eventType: "PROTECTION_RESERVED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].sequenceNumber).toBe(execution.version + 1);
  });

  maybe()("rejects a stale expectedVersion without reserving anything", async () => {
    const execution = await filledExecution();
    const outcome = await protectionService.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: execution.version + 9,
      evaluatedAt: at(),
    });
    expect(outcome.reasonCode).toBe("CAPACITY_OR_VERSION_CONFLICT");
    expect(await ordersOf(execution.id)).toHaveLength(0);
  });

  maybe()("creates exactly one generation under concurrent protection calls", async () => {
    const execution = await filledExecution();
    await Promise.allSettled([protect(execution), protect(execution), protect(execution)]);

    const orders = await ordersOf(execution.id);
    expect(orders.filter((order) => order.role === "STOP_LOSS")).toHaveLength(1);
    expect(orders.filter((order) => order.role === "TAKE_PROFIT")).toHaveLength(1);
  });
});

describe("incremental tranches", () => {
  maybe()("adds generation 2 for exactly the missing delta and keeps generation 1", async () => {
    const execution = await filledExecution({ filled: "0.100" });
    await protect(execution);

    const generationOne = await ordersOf(execution.id);
    expect(generationOne).toHaveLength(2);

    // Entry fills further: 0.10 -> 0.25.
    scenario.positionAmt = "0.250";
    await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { filledQuantity: "0.250" } });
    await protect(await reload(execution.id));

    const orders = await ordersOf(execution.id);
    const generationTwo = orders.filter((order) => order.generation === 2);
    expect(generationTwo).toHaveLength(2);
    for (const order of generationTwo) expect(order.originalQuantity.toString()).toBe("0.15");

    // Generation 1 is untouched — a verified stop is never replaced.
    const stopOne = orders.find((order) => order.role === "STOP_LOSS" && order.generation === 1)!;
    expect(stopOne.status).toBe("NEW");
    expect(stopOne.originalQuantity.toString()).toBe("0.1");

    const protection = await protectionOf(execution.id);
    expect(protection.protectedStopQuantity.toString()).toBe("0.25");
    expect(protection.protectedTakeProfitQuantity.toString()).toBe("0.25");
    expect(protection.state).toBe("PROTECTED");
  });

  maybe()("creates no third generation on an identical retry", async () => {
    const execution = await filledExecution({ filled: "0.100" });
    await protect(execution);
    scenario.positionAmt = "0.250";
    await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { filledQuantity: "0.250" } });
    await protect(await reload(execution.id));
    await protect(await reload(execution.id));

    const generations = [...new Set((await ordersOf(execution.id)).map((order) => order.generation))];
    expect(generations).toEqual([1, 2]);
  });

  maybe()("never over-protects when coverage already matches", async () => {
    const execution = await filledExecution();
    await protect(execution);
    const before = await ordersOf(execution.id);
    await protect(await reload(execution.id));
    expect(await ordersOf(execution.id)).toHaveLength(before.length);
  });
});

// ===========================================================================
// LOOK-BEFORE-SUBMIT: UNKNOWN existence must not fire a mutation.
//
// `submitAndVerifyProtection` queries the deterministic clientAlgoId before
// submitting. It used to submit on EVERY outcome that was not
// CONFIRMED_ACCEPTED — including a timeout or 5xx — so a sustained query
// outage fired a fresh POST on every reconciliation tick.
//
// Re-sending the same clientAlgoId is NOT provably idempotent here: this
// codebase restricts the -4116 duplicate semantic to SUBMIT_ORDER, so a
// duplicate clientAlgoId on the Algo endpoint classifies as RESULT_UNKNOWN.
// Only two answers may drive the decision:
//   CONFIRMED_ACCEPTED  -> already there, do not submit
//   NOT_FOUND_CONFIRMED -> conclusively absent, submit exactly once
// Everything else defers.
// ===========================================================================

// ===========================================================================
// TRANSITION ENFORCEMENT AT THE PERSISTENCE BOUNDARY.
//
// `commitExecutionChange` used to write whatever status the caller supplied,
// guarded only by the version CAS. The state machine was advisory: correctness
// depended on every call site remembering to call canTransition first, and two
// of the four did not.
//
// It now validates against the AUTHORITATIVE row read inside the transaction,
// after the CAS check, so a lost race stays a race and an illegal transition
// becomes a loud, non-mutating failure.
// ===========================================================================

describe("execution transition enforcement", () => {
  const eventsOf = async (id: string) =>
    prisma!.executionEvent.findMany({ where: { tradeExecutionId: id }, orderBy: { sequenceNumber: "asc" } });

  /** Drives the private persistence helper exactly as production does. */
  const commit = async (execution: { id: string; status: string; version: number }, status: string) =>
    (
      protectionService as unknown as {
        commitExecutionChange: (
          execution: unknown,
          expectedVersion: number,
          change: Record<string, unknown>
        ) => Promise<unknown>;
      }
    ).commitExecutionChange(execution, execution.version, {
      status,
      reasonCode: "PROTECTION_VERIFIED",
      message: `test transition to ${status}`,
      eventType: "PROTECTION_CLEANUP",
    });

  async function executionAt(status: string) {
    const seed = await filledExecution();
    await prisma!.tradeExecution.update({
      where: { id: seed.id },
      data: { status: status as never, version: { increment: 1 } },
    });
    return reload(seed.id);
  }

  maybe()("1-3. persists every legal transition and records the real fromStatus", async () => {
    for (const [from, to] of [
      ["ENTRY_FILLED", "PLACING_PROTECTION"],
      ["PLACING_PROTECTION", "PROTECTED"],
      ["PROTECTED", "CLOSED_TP"],
    ] as const) {
      const execution = await executionAt(from);

      const committed = await commit(execution, to);

      expect(committed, `${from} -> ${to}`).not.toBeNull();
      const after = await reload(execution.id);
      expect(after.status, `${from} -> ${to}`).toBe(to);
      expect(after.version).toBe(execution.version + 1);
      const last = (await eventsOf(execution.id)).at(-1)!;
      expect(last.fromStatus).toBe(from);
      expect(last.toStatus).toBe(to);
    }
  });

  maybe()("4. CLOSED_EXTERNAL remains reachable from every documented source", async () => {
    const { allowedTransitionsFrom } = await import("../src/modules/execution/execution-status");
    for (const from of ["PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION", "PROTECTED", "MANUAL_INTERVENTION"] as const) {
      expect(allowedTransitionsFrom(from), from).toContain("CLOSED_EXTERNAL");
      const execution = await executionAt(from);
      expect(await commit(execution, "CLOSED_EXTERNAL"), from).not.toBeNull();
      expect((await reload(execution.id)).status).toBe("CLOSED_EXTERNAL");
    }
  });

  maybe()("5. rejects an illegal transition, writing no status, no version and no event", async () => {
    // PLAN_READY cannot jump straight to PROTECTED.
    const execution = await executionAt("PLAN_READY");
    const eventsBefore = await eventsOf(execution.id);

    await expect(commit(execution, "PROTECTED")).rejects.toThrow(/illegal execution transition/i);

    const after = await reload(execution.id);
    expect(after.status).toBe("PLAN_READY");
    expect(after.version).toBe(execution.version);
    expect(await eventsOf(execution.id)).toHaveLength(eventsBefore.length);
  });

  maybe()("6. rejects a second clearly illegal transition from the authoritative graph", async () => {
    // ENTRY_PENDING has no path to PROTECTED either.
    const execution = await executionAt("ENTRY_PENDING");

    await expect(commit(execution, "PROTECTED")).rejects.toThrow(/ENTRY_PENDING -> PROTECTED/);

    const after = await reload(execution.id);
    expect(after.status).toBe("ENTRY_PENDING");
    expect(after.version).toBe(execution.version);
  });

  maybe()("10. a terminal execution can never return to an active status", async () => {
    for (const terminal of ["CLOSED_TP", "CLOSED_SL", "CLOSED_EXTERNAL", "FAILED"] as const) {
      const execution = await executionAt(terminal);
      await expect(commit(execution, "PROTECTED"), terminal).rejects.toThrow(/terminal|illegal/i);
      expect((await reload(execution.id)).status, terminal).toBe(terminal);
      expect((await reload(execution.id)).version).toBe(execution.version);
    }
  });

  maybe()("11. MANUAL_INTERVENTION may take only the graph's documented exits", async () => {
    const { allowedTransitionsFrom, TRADE_EXECUTION_STATUSES } = await import(
      "../src/modules/execution/execution-status"
    );
    const allowed = allowedTransitionsFrom("MANUAL_INTERVENTION");
    // Its protection is still live, so an attributable fill is legal.
    expect([...allowed].sort()).toEqual(["CLOSED_EMERGENCY", "CLOSED_EXTERNAL", "CLOSED_SL", "CLOSED_TP"]);

    // Every other target is refused at the persistence boundary.
    for (const target of TRADE_EXECUTION_STATUSES) {
      if (allowed.includes(target) || target === "MANUAL_INTERVENTION") continue;
      const execution = await executionAt("MANUAL_INTERVENTION");
      await expect(commit(execution, target), target).rejects.toThrow();
      expect((await reload(execution.id)).status, target).toBe("MANUAL_INTERVENTION");
    }
  });

  maybe()("7. a same-status write is a field update, not a transition", async () => {
    // `escalate` re-stamps a parked execution to append an event; that must
    // keep working even though canTransition models almost no self-edges.
    const execution = await executionAt("MANUAL_INTERVENTION");

    const committed = await commit(execution, "MANUAL_INTERVENTION");

    expect(committed).not.toBeNull();
    const after = await reload(execution.id);
    expect(after.status).toBe("MANUAL_INTERVENTION");
    expect(after.version).toBe(execution.version + 1);
    // The event records a self-transition, not a fabricated one.
    const last = (await eventsOf(execution.id)).at(-1)!;
    expect(last.fromStatus).toBe("MANUAL_INTERVENTION");
    expect(last.toStatus).toBe("MANUAL_INTERVENTION");
  });

  maybe()("8. a lost CAS writes nothing and creates no event — and does not throw", async () => {
    const execution = await executionAt("ENTRY_FILLED");
    const eventsBefore = await eventsOf(execution.id);
    // Somebody else advances the row first.
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { version: { increment: 1 } },
    });

    // A stale-version commit is ordinary concurrency: null, never an error.
    const committed = await commit(execution, "PLACING_PROTECTION");

    expect(committed).toBeNull();
    expect((await reload(execution.id)).status).toBe("ENTRY_FILLED");
    expect(await eventsOf(execution.id)).toHaveLength(eventsBefore.length);
  });

  maybe()("8b. a CAS loser against an ALREADY-TERMINAL row loses quietly, not loudly", async () => {
    // The ordering that matters: version is checked BEFORE legality, so a row
    // that raced ahead to a terminal state produces a benign null rather than
    // an invariant failure.
    const execution = await executionAt("PROTECTED");
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { status: "CLOSED_TP", version: { increment: 1 } },
    });

    const committed = await commit(execution, "CLOSED_SL");

    expect(committed).toBeNull();
    expect((await reload(execution.id)).status).toBe("CLOSED_TP");
  });

  maybe()("9. concurrent legal transitions produce exactly one winner and one event", async () => {
    const execution = await executionAt("ENTRY_FILLED");
    const eventsBefore = (await eventsOf(execution.id)).length;

    const results = await Promise.all([
      commit(execution, "PLACING_PROTECTION"),
      commit(execution, "PLACING_PROTECTION"),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect((await reload(execution.id)).status).toBe("PLACING_PROTECTION");
    expect((await eventsOf(execution.id)).length).toBe(eventsBefore + 1);
  });
});

describe("look-before-submit existence safety", () => {
  const submittedRoles = () => scenario.submitted.map((entry) => entry.role);

  maybe()("1. FOUND: an already-placed order is reconciled, never re-submitted", async () => {
    const execution = await filledExecution();
    // A crash left this exact identity live on the exchange.
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    await protect(execution);
    expect(scenario.algoOrders.get(stopId)?.algoStatus).toBe("NEW");

    scenario.submitted = [];
    await protect(await reload(execution.id));

    // Nothing re-submitted for an identity that is already present.
    expect(submittedRoles()).toEqual([]);
  });

  maybe()("2. NOT_FOUND_CONFIRMED: submits exactly once, under the same deterministic id", async () => {
    const execution = await filledExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    const takeProfitId = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);

    await protect(execution);

    // Both legs absent beforehand (-2013), so both are submitted once each.
    expect(submittedRoles()).toEqual(["STOP_LOSS", "TAKE_PROFIT"]);
    expect(scenario.submitted[0].clientAlgoId).toBe(stopId);
    expect(scenario.submitted[1].clientAlgoId).toBe(takeProfitId);
  });

  maybe()("3. UNKNOWN on the STOP defers instead of submitting", async () => {
    const execution = await filledExecution();
    scenario.queryFailures.add(buildClientOrderId(execution.id, "STOP_LOSS", 1));

    const outcome = await protect(execution);

    // No POST at all — not for the stop, and not for the take profit.
    expect(submittedRoles()).toEqual([]);
    expect(scenario.mutations).toEqual([]);
    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("STOP_QUERY_UNAVAILABLE");
    // The reserved intent survives untouched — no new identity, no rewrite.
    const stop = (await ordersOf(execution.id)).find((order) => order.role === "STOP_LOSS")!;
    expect(stop.status).toBe("SUBMITTING");
    expect(stop.clientAlgoId).toBe(buildClientOrderId(execution.id, "STOP_LOSS", 1));
    // Deferral is not failure: no escalation, no critical alert.
    expect((await reload(execution.id)).requiresManualIntervention).toBe(false);
    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
  });

  maybe()("3b. UNKNOWN on the TAKE_PROFIT defers after a verified STOP", async () => {
    const execution = await filledExecution();
    scenario.queryFailures.add(buildClientOrderId(execution.id, "TAKE_PROFIT", 1));

    const outcome = await protect(execution);

    // The stop is genuinely absent so it is placed; the TP is only unreadable.
    expect(submittedRoles()).toEqual(["STOP_LOSS"]);
    expect(outcome.reasonCode).toBe("TAKE_PROFIT_QUERY_UNAVAILABLE");
    const takeProfit = (await ordersOf(execution.id)).find((order) => order.role === "TAKE_PROFIT")!;
    expect(takeProfit.status).toBe("SUBMITTING");
    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
  });

  maybe()("4. repeated UNKNOWN ticks fire no mutation storm and churn no identity", async () => {
    const execution = await filledExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    scenario.queryFailures.add(stopId);

    for (let tick = 0; tick < 5; tick += 1) await protect(await reload(execution.id));

    // Zero submissions across five ticks — the old code sent one per tick.
    expect(submittedRoles()).toEqual([]);
    expect(scenario.mutations).toEqual([]);
    // One generation, one identity, no false absence, no false PROTECTED.
    const orders = await ordersOf(execution.id);
    expect(orders.filter((order) => order.role === "STOP_LOSS").map((order) => order.generation)).toEqual([1]);
    expect(orders.find((order) => order.role === "STOP_LOSS")!.clientAlgoId).toBe(stopId);
    expect((await protectionOf(execution.id)).state).not.toBe("PROTECTED");
    expect((await reload(execution.id)).status).not.toBe("PROTECTED");
  });

  maybe()("5. UNKNOWN then FOUND converges onto the existing order without duplicating it", async () => {
    const execution = await filledExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);

    // Tick N: the stop is already live on the exchange but unreadable.
    scenario.algoOrders.set(stopId, {
      algoId: "A-recovered",
      clientAlgoId: stopId,
      symbol: SYMBOL,
      algoStatus: "NEW",
      side: "SELL",
      positionSide: "LONG",
      orderType: "STOP_MARKET",
      quantity: "0.100",
      triggerPrice: "96",
      workingType: "MARK_PRICE",
      priceProtect: false,
    });
    scenario.queryFailures.add(stopId);
    await protect(execution);
    expect(submittedRoles()).toEqual([]);

    // Tick N+1: readable again.
    scenario.queryFailures.delete(stopId);
    await protect(await reload(execution.id));

    // The pre-existing order was adopted; only the take profit was ever sent.
    expect(submittedRoles()).toEqual(["TAKE_PROFIT"]);
    expect(scenario.algoOrders.get(stopId)!.algoId).toBe("A-recovered");
    expect((await protectionOf(execution.id)).state).toBe("PROTECTED");
  });

  maybe()("6. UNKNOWN then NOT_FOUND_CONFIRMED submits only once absence is proven", async () => {
    const execution = await filledExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);

    scenario.queryFailures.add(stopId);
    await protect(execution);
    expect(submittedRoles()).toEqual([]);

    // The exchange now conclusively answers -2013 for that id.
    scenario.queryFailures.delete(stopId);
    await protect(await reload(execution.id));

    expect(submittedRoles()).toEqual(["STOP_LOSS", "TAKE_PROFIT"]);
    expect((await protectionOf(execution.id)).state).toBe("PROTECTED");
  });

  maybe()("7. a lost POST response is recovered by querying the same id, never a second identity", async () => {
    const execution = await filledExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    // The POST reaches Binance and lands, but the response is lost.
    const originalSubmit = mutationStub.submitProtectionOrder;
    let firstStop = true;
    mutationStub.submitProtectionOrder = async (context: Record<string, string>) => {
      if (context.role === "STOP_LOSS" && firstStop) {
        firstStop = false;
        await originalSubmit.call(mutationStub, context); // it DID land
        throw timeoutError("newAlgoOrder");
      }
      return originalSubmit.call(mutationStub, context);
    };

    try {
      await protect(execution);

      // Exactly one STOP submission; the bounded re-query adopted it.
      expect(submittedRoles().filter((role) => role === "STOP_LOSS")).toHaveLength(1);
      const stops = (await ordersOf(execution.id)).filter((order) => order.role === "STOP_LOSS");
      expect(stops.map((order) => order.generation)).toEqual([1]);
      expect(stops[0].clientAlgoId).toBe(stopId);
      expect((await protectionOf(execution.id)).state).toBe("PROTECTED");
    } finally {
      mutationStub.submitProtectionOrder = originalSubmit;
    }
  });

  maybe()("9. a POST that never reached the exchange is eventually retried, not deadlocked", async () => {
    const execution = await filledExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);

    // Tick N: the POST never lands and the id is briefly unreadable.
    scenario.submitFailure = timeoutError("newAlgoOrder");
    scenario.submitLands = false;
    await protect(execution);
    expect(submittedRoles()).toEqual(["STOP_LOSS"]);

    scenario.queryFailures.add(stopId);
    await protect(await reload(execution.id));
    // Still exactly one attempt — the unreadable tick added none.
    expect(submittedRoles().filter((role) => role === "STOP_LOSS")).toHaveLength(1);

    // Tick N+2: readable, conclusively absent, and the submit now works.
    scenario.queryFailures.delete(stopId);
    scenario.submitFailure = null;
    scenario.submitLands = true;
    await protect(await reload(execution.id));

    // No deadlock: the protection is finally placed under the SAME identity.
    expect(scenario.algoOrders.get(stopId)?.algoStatus).toBe("NEW");
    expect((await protectionOf(execution.id)).state).toBe("PROTECTED");
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });
});

describe("stop-first verification", () => {
  maybe()("does not submit the take profit when the stop cannot be verified", async () => {
    const execution = await filledExecution();
    scenario.submitFailure = timeoutError("newAlgoOrder");
    scenario.submitLands = false;
    // No queryFailures here: the order must be conclusively ABSENT so the
    // submission proceeds. Unreadable would now defer without submitting.

    const outcome = await protect(execution);

    expect(outcome.ok).toBe(false);
    expect(scenario.submitted.map((entry) => entry.role)).toEqual(["STOP_LOSS"]);
    expect((await protectionOf(execution.id)).state).not.toBe("PROTECTED");
  });

  maybe()("queries the same clientAlgoId after a submission timeout", async () => {
    const execution = await filledExecution();
    scenario.submitFailure = timeoutError("newAlgoOrder");
    scenario.submitLands = true; // it actually landed

    const outcome = await protect(execution);

    expect(outcome.ok).toBe(true);
    // Exactly one stop submission — no new id was ever generated.
    expect(scenario.submitted.filter((entry) => entry.role === "STOP_LOSS")).toHaveLength(1);
    const orders = await ordersOf(execution.id);
    expect(orders.filter((order) => order.role === "STOP_LOSS")).toHaveLength(1);
  });

  maybe()("retains a verified stop when the take profit fails", async () => {
    const execution = await filledExecution();
    const takeProfitId = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);
    // The stop lands; the TP submission is lost and unqueryable.
    const originalSubmit = mutationStub.submitProtectionOrder;
    mutationStub.submitProtectionOrder = async (context: Record<string, string>) => {
      if (context.role === "TAKE_PROFIT") {
        dispatched += 1;
        scenario.mutations.push("POST /fapi/v1/algoOrder TAKE_PROFIT");
        scenario.submitted.push({ ...context });
        scenario.queryFailures.add(takeProfitId);
        throw timeoutError("newAlgoOrder");
      }
      return originalSubmit.call(mutationStub, context);
    };

    const outcome = await protect(execution);
    mutationStub.submitProtectionOrder = originalSubmit;

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("TAKE_PROFIT_SUBMISSION_RESULT_UNKNOWN");
    // The stop is still active and was never cancelled.
    const stop = (await ordersOf(execution.id)).find((order) => order.role === "STOP_LOSS")!;
    expect(stop.status).toBe("NEW");
    expect(scenario.mutations.filter((call) => call.startsWith("DELETE"))).toHaveLength(0);
    expect((await protectionOf(execution.id)).state).toBe("PROTECTION_INCOMPLETE");
  });

  maybe()("escalates a contradictory protection identity", async () => {
    const execution = await filledExecution();
    await protect(execution);

    // The exchange now reports a different quantity under our algo id.
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    scenario.algoOrders.get(stopId)!.quantity = "0.999";

    const outcome = await protectionService.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: (await reload(execution.id)).version,
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(false);
    // Local intent was not rewritten to match.
    const stop = (await ordersOf(execution.id)).find((order) => order.role === "STOP_LOSS")!;
    expect(stop.originalQuantity.toString()).toBe("0.1");
  });
});

describe("liquidation and margin", () => {
  maybe()("performs no top-up when liquidation is safe", async () => {
    const execution = await filledExecution();
    scenario.liquidationPrice = "90"; // boundary is 94

    await protect(execution);
    expect(scenario.mutations.filter((call) => call.includes("positionMargin"))).toHaveLength(0);
    expect((await protectionOf(execution.id)).liquidationSafe).toBe(true);
  });

  maybe()("raises a critical alert when liquidation is unsafe and auto-margin is off", async () => {
    const execution = await filledExecution();
    scenario.liquidationPrice = "95"; // above the 94 boundary for a LONG

    await protect(execution);

    expect(scenario.mutations.filter((call) => call.includes("positionMargin"))).toHaveLength(0);
    const alerts = await prisma!.criticalAlert.findMany({ where: { tradeExecutionId: execution.id } });
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.some((alert) => alert.reasonCode === "AUTO_MARGIN_DISABLED")).toBe(true);
    expect((await protectionOf(execution.id)).liquidationSafe).toBe(false);
  });

  maybe()("still places protection when the buffer is unsafe", async () => {
    const execution = await filledExecution();
    scenario.liquidationPrice = "95";

    await protect(execution);
    // An unsafe buffer is a reason to protect urgently, never to skip it.
    expect(scenario.submitted.map((entry) => entry.role)).toEqual(["STOP_LOSS", "TAKE_PROFIT"]);
  });

  maybe()("fails closed when the liquidation price is missing", async () => {
    const execution = await filledExecution();
    scenario.liquidationPrice = null;

    await protect(execution);
    expect((await protectionOf(execution.id)).liquidationSafe).toBe(false);
  });
});

describe("critical alert outbox", () => {
  maybe()("persists a durable alert without sending it inline", async () => {
    const execution = await filledExecution();
    scenario.submitFailure = timeoutError("newAlgoOrder");
    scenario.submitLands = false;
    // No queryFailures here: the order must be conclusively ABSENT so the
    // submission proceeds. Unreadable would now defer without submitting.

    await protect(execution);

    const alerts = await prisma!.criticalAlert.findMany({ where: { tradeExecutionId: execution.id } });
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.every((alert) => alert.status === "PENDING")).toBe(true);
    // The safety action never waited for Telegram.
    expect(scenario.telegramMessages).toHaveLength(0);
  });

  maybe()("does not duplicate an identical alert on repeated reconciliation", async () => {
    const execution = await filledExecution();
    scenario.liquidationPrice = "95";

    await protect(execution);
    const first = await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } });
    await protect(await reload(execution.id));
    const second = await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } });

    expect(second).toBe(first);
  });

  maybe()("keeps a failed delivery visible and retryable", async () => {
    const execution = await filledExecution();
    scenario.liquidationPrice = "95";
    await protect(execution);

    scenario.telegramFails = true;
    const firstFlush = await alertService.flushPending();
    expect(firstFlush.failed).toBeGreaterThan(0);
    let alerts = await prisma!.criticalAlert.findMany({ where: { tradeExecutionId: execution.id } });
    expect(alerts.every((alert) => alert.status === "FAILED")).toBe(true);
    expect(alerts.every((alert) => alert.attempts >= 1)).toBe(true);

    scenario.telegramFails = false;
    const secondFlush = await alertService.flushPending();
    expect(secondFlush.sent).toBeGreaterThan(0);
    alerts = await prisma!.criticalAlert.findMany({ where: { tradeExecutionId: execution.id } });
    expect(alerts.every((alert) => alert.status === "SENT")).toBe(true);
  });

  maybe()("contains no credentials, balances or raw payloads", async () => {
    const execution = await filledExecution();
    scenario.liquidationPrice = "95";
    await protect(execution);
    await alertService.flushPending();

    const alerts = await prisma!.criticalAlert.findMany({ where: { tradeExecutionId: execution.id } });
    const serialized = JSON.stringify(alerts).toLowerCase();
    for (const forbidden of ["apikey", "apisecret", "signature", "authorization", "walletbalance", "availablebalance", "x-mbx"]) {
      expect(serialized).not.toContain(forbidden);
    }
    for (const message of scenario.telegramMessages) {
      expect(message.toLowerCase()).not.toContain("apikey");
      expect(message.toLowerCase()).not.toContain("signature");
    }
  });
});

describe("emergency close", () => {
  maybe()("sends no MARKET order while the mode is DISABLED", async () => {
    const execution = await filledExecution();
    scenario.submitFailure = timeoutError("newAlgoOrder");
    scenario.submitLands = false;
    // No queryFailures here: the order must be conclusively ABSENT so the
    // submission proceeds. Unreadable would now defer without submitting.

    const outcome = await protect(execution);

    expect(scenario.mutations.filter((call) => call.includes("MARKET"))).toHaveLength(0);
    expect(outcome.ok).toBe(false);
    expect((await protectionOf(execution.id)).state).toBe("MANUAL_INTERVENTION");
    // The evidence and local intents are preserved.
    expect((await ordersOf(execution.id)).length).toBeGreaterThan(0);
  });

  maybe()("never emergency-closes while a verified stop covers the position", async () => {
    const execution = await filledExecution();
    await protect(execution);
    expect(scenario.mutations.filter((call) => call.includes("MARKET"))).toHaveLength(0);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id, role: "EMERGENCY_CLOSE" } })).toBe(0);
  });
});

describe("closure and sibling cleanup", () => {
  async function protectedExecution() {
    const execution = await filledExecution();
    await protect(execution);
    return reload(execution.id);
  }

  maybe()("does not close the execution while exposure remains after a TP fill", async () => {
    const execution = await protectedExecution();
    const takeProfitId = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);
    scenario.algoOrders.get(takeProfitId)!.algoStatus = "FILLED";
    scenario.positionAmt = "0.050"; // still open

    const outcome = await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.reasonCode).toBe("PARTIAL_PROTECTION_EXIT");
    const reloaded = await reload(execution.id);
    expect(reloaded.status).not.toBe("CLOSED_TP");
    expect(reloaded.status).toBe("MANUAL_INTERVENTION");
  });

  maybe()("cancels every stop sibling once a TP closed the position", async () => {
    const execution = await protectedExecution();
    const takeProfitId = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);
    scenario.algoOrders.get(takeProfitId)!.algoStatus = "FILLED";
    scenario.algoOrders.get(takeProfitId)!.executedQty = "0.100";
    scenario.positionAmt = "0";
    scenario.mutations = [];

    const outcome = await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(true);
    expect((await reload(execution.id)).status).toBe("CLOSED_TP");
    expect(scenario.mutations.filter((call) => call.startsWith("DELETE"))).toHaveLength(1);
    const stop = (await ordersOf(execution.id)).find((order) => order.role === "STOP_LOSS")!;
    expect(stop.status).toBe("CANCELED");
  });

  maybe()("cancels every take-profit sibling once a stop closed the position", async () => {
    const execution = await protectedExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    scenario.algoOrders.get(stopId)!.algoStatus = "FILLED";
    scenario.algoOrders.get(stopId)!.executedQty = "0.100";
    scenario.positionAmt = "0";
    scenario.mutations = [];

    await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect((await reload(execution.id)).status).toBe("CLOSED_SL");
    const takeProfit = (await ordersOf(execution.id)).find((order) => order.role === "TAKE_PROFIT")!;
    expect(takeProfit.status).toBe("CANCELED");
  });

  maybe()("cleans up every generation", async () => {
    const execution = await filledExecution({ filled: "0.100" });
    await protect(execution);
    scenario.positionAmt = "0.250";
    await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { filledQuantity: "0.250" } });
    await protect(await reload(execution.id));

    const takeProfitId = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);
    scenario.algoOrders.get(takeProfitId)!.algoStatus = "FILLED";
    scenario.positionAmt = "0";
    scenario.mutations = [];

    await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: (await reload(execution.id)).version,
      evaluatedAt: at(),
    });

    const orders = await ordersOf(execution.id);
    const stillActive = orders.filter((order) => order.status === "NEW");
    expect(stillActive).toHaveLength(0);
  });

  maybe()("keeps cleanup incomplete when a cancellation is ambiguous", async () => {
    const execution = await protectedExecution();
    const takeProfitId = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    scenario.algoOrders.get(takeProfitId)!.algoStatus = "FILLED";
    scenario.positionAmt = "0";
    scenario.cancelFailure = timeoutError("cancelAlgoOrder");
    scenario.queryFailures.add(stopId);

    const outcome = await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.reasonCode).toBe("SIBLING_CLEANUP_INCOMPLETE");
    expect((await reload(execution.id)).status).not.toBe("CLOSED_TP");
    const alerts = await prisma!.criticalAlert.findMany({
      where: { tradeExecutionId: execution.id, alertType: "SIBLING_CANCELLATION_FAILED" },
    });
    expect(alerts).toHaveLength(1);
  });
});

describe("crash recovery", () => {
  maybe()("resumes a reserved-but-unsubmitted tranche with the same clientAlgoId", async () => {
    const execution = await filledExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    // Simulate a crash right after the reservation transaction.
    await prisma!.binanceOrder.createMany({
      data: [
        {
          tradeExecutionId: execution.id, role: "STOP_LOSS", generation: 1,
          clientOrderId: stopId, clientAlgoId: stopId, side: "SELL", positionSide: "LONG",
          orderType: "STOP_MARKET", originalQuantity: "0.100", triggerPrice: "96",
          workingType: "MARK_PRICE", priceProtect: false, status: "SUBMITTING",
        },
        {
          tradeExecutionId: execution.id, role: "TAKE_PROFIT", generation: 1,
          clientOrderId: buildClientOrderId(execution.id, "TAKE_PROFIT", 1),
          clientAlgoId: buildClientOrderId(execution.id, "TAKE_PROFIT", 1),
          side: "SELL", positionSide: "LONG", orderType: "TAKE_PROFIT_MARKET",
          originalQuantity: "0.100", triggerPrice: "108", workingType: "CONTRACT_PRICE",
          priceProtect: false, status: "SUBMITTING",
        },
      ],
    });

    await protectionService.resumeProtectionLifecycle({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    const orders = await ordersOf(execution.id);
    expect(orders).toHaveLength(2);
    expect(orders.find((order) => order.role === "STOP_LOSS")!.clientAlgoId).toBe(stopId);
    expect(scenario.submitted.every((entry) => entry.clientAlgoId.startsWith("tad-"))).toBe(true);
  });

  maybe()("resumes at the take profit when the stop is already accepted", async () => {
    const execution = await filledExecution();
    await protect(execution);
    const submissionsBefore = scenario.submitted.length;

    await protectionService.resumeProtectionLifecycle({
      executionId: execution.id,
      expectedVersion: (await reload(execution.id)).version,
      evaluatedAt: at(),
    });

    // Nothing was resubmitted: both legs were already verified.
    expect(scenario.submitted).toHaveLength(submissionsBefore);
  });

  maybe()("performs only cleanup when the position is already closed", async () => {
    const execution = await filledExecution();
    await protect(execution);
    scenario.positionAmt = "0";
    scenario.mutations = [];

    await protectionService.resumeProtectionLifecycle({
      executionId: execution.id,
      expectedVersion: (await reload(execution.id)).version,
      evaluatedAt: at(),
    });

    expect(scenario.mutations.filter((call) => call.startsWith("POST"))).toHaveLength(0);
  });

  maybe()("creates no duplicate protection after three restarts", async () => {
    const execution = await filledExecution();
    await protect(execution);

    for (let restart = 0; restart < 3; restart += 1) {
      await protectionService.resumeProtectionLifecycle({
        executionId: execution.id,
        expectedVersion: (await reload(execution.id)).version,
        evaluatedAt: at(),
      });
    }

    const orders = await ordersOf(execution.id);
    expect(orders).toHaveLength(2);
    expect(await prisma!.marginAdjustmentIntent.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id, role: "EMERGENCY_CLOSE" } })).toBe(0);
  });

  maybe()("does not recreate protection for a terminal execution", async () => {
    const execution = await filledExecution();
    await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { status: "CLOSED_TP" } });

    const outcome = await protectionService.resumeProtectionLifecycle({
      executionId: execution.id,
      expectedVersion: (await reload(execution.id)).version,
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(false);
    expect(scenario.mutations).toHaveLength(0);
    expect(await ordersOf(execution.id)).toHaveLength(0);
  });
});

describe("capacity classification is unchanged", () => {
  maybe()("a protected PARTIALLY_FILLED entry still consumes pending-entry capacity", async () => {
    const { consumesPendingEntry, consumesOpenPosition } = await import("../src/modules/execution/capacity-status");
    const execution = await filledExecution();
    await protect(execution);

    const reloaded = await reload(execution.id);
    expect(reloaded.status).toBe("PARTIALLY_FILLED");
    // Protection lives in its own state, so no capacity slot is released.
    expect(consumesPendingEntry("PARTIALLY_FILLED")).toBe(true);
    expect(consumesOpenPosition("PARTIALLY_FILLED")).toBe(true);
    expect((await protectionOf(execution.id)).state).toBe("PROTECTED");
  });
});

// ===========================================================================
// Closure-safety audit: entry remainder must be neutralized before terminal
// ===========================================================================

describe("entry remainder cleanup before terminal closure", () => {
  /**
   * Entry planned 0.25, filled 0.10, remaining 0.15 still working. Protection
   * covers the 0.10 and then closes it.
   */
  async function partiallyFilledEntryProtected(entryStatus = "PARTIALLY_FILLED") {
    const execution = await filledExecution({ filled: "0.100" });
    const entryClientOrderId = buildClientOrderId(execution.id, "ENTRY", 1);
    await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id, role: "ENTRY", generation: 1,
        clientOrderId: entryClientOrderId, side: "BUY", positionSide: "LONG",
        orderType: "LIMIT", timeInForce: "GTC", price: "100",
        originalQuantity: "0.250", executedQuantity: "0.100", status: "PARTIALLY_FILLED",
      },
    });
    scenario.standardOrders.set(entryClientOrderId, {
      status: entryStatus, executedQty: "0.100", avgPrice: "100", orderId: "EN1",
      side: "BUY", type: "LIMIT", price: "100", origQty: "0.250",
    });
    await protect(execution);
    return { execution: await reload(execution.id), entryClientOrderId };
  }

  function fireProtection(executionId: string, role: "STOP_LOSS" | "TAKE_PROFIT") {
    const id = buildClientOrderId(executionId, role, 1);
    scenario.algoOrders.get(id)!.algoStatus = "FILLED";
    scenario.algoOrders.get(id)!.executedQty = "0.100";
    scenario.positionAmt = "0";
    scenario.mutations = [];
  }

  maybe()("1. cancels the remaining entry BEFORE the protection siblings, then CLOSED_TP", async () => {
    const { execution } = await partiallyFilledEntryProtected();
    fireProtection(execution.id, "TAKE_PROFIT");

    const outcome = await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(true);
    expect((await reload(execution.id)).status).toBe("CLOSED_TP");

    // Ordering: the ENTRY cancel must come before any algo cancel.
    const entryIndex = scenario.mutations.indexOf("DELETE /fapi/v1/order ENTRY");
    const algoIndex = scenario.mutations.indexOf("DELETE /fapi/v1/algoOrder");
    expect(entryIndex).toBeGreaterThanOrEqual(0);
    expect(algoIndex).toBeGreaterThanOrEqual(0);
    expect(entryIndex).toBeLessThan(algoIndex);

    // The entry is terminal and its historical fill is preserved.
    const entry = (await ordersOf(execution.id)).find((order) => order.role === "ENTRY")!;
    expect(entry.status).toBe("CANCELED");
    expect(entry.executedQuantity.toString()).toBe("0.1");
  });

  maybe()("2. cancels the remaining entry first, then CLOSED_SL", async () => {
    const { execution } = await partiallyFilledEntryProtected();
    fireProtection(execution.id, "STOP_LOSS");

    await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect((await reload(execution.id)).status).toBe("CLOSED_SL");
    const entryIndex = scenario.mutations.indexOf("DELETE /fapi/v1/order ENTRY");
    const algoIndex = scenario.mutations.indexOf("DELETE /fapi/v1/algoOrder");
    expect(entryIndex).toBeLessThan(algoIndex);
  });

  maybe()("3. emergency close also neutralizes the entry before CLOSED_EMERGENCY", async () => {
    const { execution, entryClientOrderId } = await partiallyFilledEntryProtected();
    // Simulate a completed emergency close with the position now flat.
    const emergencyId = buildClientOrderId(execution.id, "EMERGENCY_CLOSE", 1);
    await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id, role: "EMERGENCY_CLOSE", generation: 1,
        clientOrderId: emergencyId, side: "SELL", positionSide: "LONG",
        orderType: "MARKET", originalQuantity: "0.100", status: "FILLED",
      },
    });
    scenario.standardOrders.set(emergencyId, { status: "FILLED", executedQty: "0.100", avgPrice: "100", orderId: "E1" });
    scenario.positionAmt = "0";
    scenario.mutations = [];

    await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect((await reload(execution.id)).status).toBe("CLOSED_EMERGENCY");
    expect(scenario.mutations.indexOf("DELETE /fapi/v1/order ENTRY")).toBeLessThan(
      scenario.mutations.indexOf("DELETE /fapi/v1/algoOrder")
    );
    expect(scenario.standardOrders.get(entryClientOrderId)!.status).toBe("CANCELED");
  });

  maybe()("4. issues no entry DELETE when the entry is already FILLED", async () => {
    const { execution } = await partiallyFilledEntryProtected("FILLED");
    fireProtection(execution.id, "TAKE_PROFIT");

    await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(scenario.mutations).not.toContain("DELETE /fapi/v1/order ENTRY");
    // Sibling cleanup still happened and the execution closed normally.
    expect(scenario.mutations).toContain("DELETE /fapi/v1/algoOrder");
    expect((await reload(execution.id)).status).toBe("CLOSED_TP");
  });

  maybe()("5. an entry cancellation timeout is resolved by querying the same id", async () => {
    const { execution, entryClientOrderId } = await partiallyFilledEntryProtected();
    fireProtection(execution.id, "TAKE_PROFIT");
    scenario.entryCancelFailure = timeoutError("cancelOrder");
    // The cancel actually landed.
    scenario.standardOrders.get(entryClientOrderId)!.status = "CANCELED";

    await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect((await reload(execution.id)).status).toBe("CLOSED_TP");
  });

  maybe()("5b. an ambiguous entry cancellation can never become CLOSED", async () => {
    const { execution } = await partiallyFilledEntryProtected();
    fireProtection(execution.id, "TAKE_PROFIT");
    scenario.entryCancelFailure = timeoutError("cancelOrder");
    // The entry is still working afterwards.

    const outcome = await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("ENTRY_REMAINDER_CLEANUP_FAILED");
    const reloaded = await reload(execution.id);
    expect(["CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY"]).not.toContain(reloaded.status);
    // Protection was NOT torn down while the entry could still refill.
    expect(scenario.mutations).not.toContain("DELETE /fapi/v1/algoOrder");
  });

  maybe()("6. a refill during cancellation returns to protection recovery, not closure", async () => {
    const { execution } = await partiallyFilledEntryProtected();
    fireProtection(execution.id, "TAKE_PROFIT");
    // The entry fills the remaining 0.15 as the cancel is processed.
    scenario.positionAfterEntryCleanup = "0.150";

    const outcome = await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    const reloaded = await reload(execution.id);
    expect(["CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY"]).not.toContain(reloaded.status);
    expect(outcome.ok === false || outcome.reasonCode === "PROTECTION_VERIFIED").toBe(true);

    // No duplicate ENTRY and no opposite compensating order.
    const entries = (await ordersOf(execution.id)).filter((order) => order.role === "ENTRY");
    expect(entries).toHaveLength(1);
    expect(scenario.mutations.filter((call) => call.includes("MARKET"))).toHaveLength(0);

    // A critical alert records the race.
    const alerts = await prisma!.criticalAlert.findMany({
      where: { tradeExecutionId: execution.id, reasonCode: "ENTRY_REFILLED_DURING_CLOSURE" },
    });
    expect(alerts).toHaveLength(1);
  });

  maybe()("7. a contradictory entry identity is escalated, never cancelled", async () => {
    const { execution, entryClientOrderId } = await partiallyFilledEntryProtected();
    fireProtection(execution.id, "TAKE_PROFIT");
    // The exchange reports a different side under our entry id.
    scenario.standardOrders.get(entryClientOrderId)!.side = "SELL";

    const outcome = await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.reasonCode).toBe("ENTRY_REMAINDER_CLEANUP_FAILED");
    expect(scenario.mutations).not.toContain("DELETE /fapi/v1/order ENTRY");
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
    const alerts = await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } });
    expect(alerts).toBeGreaterThan(0);
  });

  maybe()("8. position zero with an unreadable entry leaves protection intact and no terminal", async () => {
    const { execution } = await partiallyFilledEntryProtected();
    fireProtection(execution.id, "TAKE_PROFIT");
    scenario.entryQueryUnavailable = true;

    const outcome = await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.reasonCode).toBe("ENTRY_ORDER_STATE_UNAVAILABLE_DURING_CLOSURE");
    const reloaded = await reload(execution.id);
    expect(["CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY"]).not.toContain(reloaded.status);
    // No sibling teardown: a refill must not land unprotected.
    expect(scenario.mutations).not.toContain("DELETE /fapi/v1/algoOrder");
    const stop = (await ordersOf(execution.id)).find((order) => order.role === "STOP_LOSS")!;
    expect(stop.status).toBe("NEW");
    expect((await protectionOf(execution.id)).state).toBe("CLOSURE_CLEANUP");
  });

  maybe()("9. concurrent closure reconciliation commits exactly one cleanup", async () => {
    const { execution } = await partiallyFilledEntryProtected();
    fireProtection(execution.id, "TAKE_PROFIT");

    const outcomes = await Promise.all([
      protectionService.reconcileProtectionAndClosure({
        executionId: execution.id, expectedVersion: execution.version, evaluatedAt: at(),
      }),
      protectionService.reconcileProtectionAndClosure({
        executionId: execution.id, expectedVersion: execution.version, evaluatedAt: at(),
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect((await reload(execution.id)).status).toBe("CLOSED_TP");

    // No duplicate cleanup events and no duplicate alerts.
    const events = await prisma!.executionEvent.findMany({ where: { tradeExecutionId: execution.id } });
    expect(new Set(events.map((event) => event.sequenceNumber)).size).toBe(events.length);
    const alerts = await prisma!.criticalAlert.findMany({ where: { tradeExecutionId: execution.id } });
    expect(new Set(alerts.map((alert) => alert.dedupeKey)).size).toBe(alerts.length);
  });

  maybe()("10. CLOSED_EMERGENCY releases capacity only after verified cleanup", async () => {
    const { consumesTotalActive, consumesNoCapacity } = await import("../src/modules/execution/capacity-status");
    const { canTransition, isTerminalStatus } = await import("../src/modules/execution/execution-status");

    const { execution } = await partiallyFilledEntryProtected();
    // Before cleanup the execution is still active and still holds capacity.
    expect(consumesTotalActive((await reload(execution.id)).status as never)).toBe(true);

    const emergencyId = buildClientOrderId(execution.id, "EMERGENCY_CLOSE", 1);
    await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id, role: "EMERGENCY_CLOSE", generation: 1,
        clientOrderId: emergencyId, side: "SELL", positionSide: "LONG",
        orderType: "MARKET", originalQuantity: "0.100", status: "FILLED",
      },
    });
    scenario.standardOrders.set(emergencyId, { status: "FILLED", executedQty: "0.100", avgPrice: "100", orderId: "E1" });
    scenario.positionAmt = "0";

    await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id, expectedVersion: execution.version, evaluatedAt: at(),
    });

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_EMERGENCY");
    expect(isTerminalStatus("CLOSED_EMERGENCY")).toBe(true);
    expect(consumesNoCapacity("CLOSED_EMERGENCY")).toBe(true);
    // No transition out.
    for (const target of ["PROTECTED", "PARTIALLY_FILLED", "MANUAL_INTERVENTION"] as const) {
      expect(canTransition("CLOSED_EMERGENCY", target).allowed).toBe(false);
    }
  });

  maybe()("never resubmits the entry or creates an entry generation 2", async () => {
    const { execution } = await partiallyFilledEntryProtected();
    fireProtection(execution.id, "TAKE_PROFIT");
    await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id, expectedVersion: execution.version, evaluatedAt: at(),
    });

    const entries = (await ordersOf(execution.id)).filter((order) => order.role === "ENTRY");
    expect(entries).toHaveLength(1);
    expect(entries[0].generation).toBe(1);
    // The only POSTs in the whole flow were the two protection submissions.
    expect(scenario.mutations.filter((call) => call.startsWith("POST"))).toHaveLength(0);
  });
});

// ===========================================================================
// External / unattributed flat recovery  the real canary's stuck state.
//
// The operator closed a real DOGSUSDT LONG by hand after protection failed.
// Binance went flat, but no OWNED order filled, so the reconciler had nothing
// to attribute the closure to and left the execution MANUAL_INTERVENTION with
// requiresManualIntervention=true forever.
// ===========================================================================

describe("external flat recovery", () => {
  async function parkedFlatExecution() {
    const seed = await filledExecution();
    await protect(seed);
    const execution = await reload(seed.id);
    // Position closed by something that is not one of our orders.
    scenario.positionAmt = "0";
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { status: "MANUAL_INTERVENTION", requiresManualIntervention: true, version: { increment: 1 } },
    });
    scenario.mutations = [];
    return reload(execution.id);
  }

  const reconcile = async (id: string) => {
    const current = await reload(id);
    return protectionService.reconcileProtectionAndClosure({
      executionId: id,
      expectedVersion: current.version,
      evaluatedAt: at(),
    });
  };

  maybe()("terminalizes as CLOSED_EXTERNAL when every owned sibling is confirmed absent", async () => {
    const execution = await parkedFlatExecution();
    // Binance proves both deterministic ids are gone (-2013).
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "STOP_LOSS", 1));
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "TAKE_PROFIT", 1));

    const outcome = await reconcile(execution.id);

    expect(outcome.ok).toBe(true);
    const after = await reload(execution.id);
    expect(after.status).toBe("CLOSED_EXTERNAL");
    // The whole point: recovery is no longer blocked.
    expect(after.requiresManualIntervention).toBe(false);
    expect(after.closedAt).not.toBeNull();
    expect(after.lastReconciledAt).not.toBeNull();
    expect(after.exitReason).toBe("EXTERNAL");
    // Nothing is invented about a closure we did not perform.
    expect(after.actualExitPrice).toBeNull();
    expect(after.realizedPnl).toBeNull();
    // Absence needs no cancellation.
    expect(scenario.mutations).toEqual([]);
  });

  maybe()("stays parked when ANY owned sibling is unknown", async () => {
    const execution = await parkedFlatExecution();
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "TAKE_PROFIT", 1));
    // The stop cannot be read at all  absence is not proven.
    scenario.queryFailures.add(buildClientOrderId(execution.id, "STOP_LOSS", 1));

    const outcome = await reconcile(execution.id);

    expect(outcome.ok).toBe(false);
    const after = await reload(execution.id);
    expect(after.status).toBe("MANUAL_INTERVENTION");
    expect(after.requiresManualIntervention).toBe(true);
    expect(after.status).not.toBe("CLOSED_EXTERNAL");
  });

  maybe()("cancels an ACTIVE owned sibling first, then terminalizes", async () => {
    const execution = await parkedFlatExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "TAKE_PROFIT", 1));
    scenario.algoOrders.get(stopId)!.algoStatus = "NEW";

    const outcome = await reconcile(execution.id);

    expect(outcome.ok).toBe(true);
    // Cancelled by its own persisted deterministic identity.
    expect(scenario.mutations).toContain("DELETE /fapi/v1/algoOrder");
    // Cancelled by its own persisted identity, and now off the book.
    expect(scenario.algoOrders.get(stopId)!.algoStatus).toBe("CANCELED");
    const after = await reload(execution.id);
    expect(after.status).toBe("CLOSED_EXTERNAL");
    expect(after.requiresManualIntervention).toBe(false);
  });

  maybe()("is idempotent  a repeated tick mutates nothing further", async () => {
    const execution = await parkedFlatExecution();
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "STOP_LOSS", 1));
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "TAKE_PROFIT", 1));

    await reconcile(execution.id);
    const first = await reload(execution.id);
    scenario.mutations = [];

    await reconcile(execution.id);
    const second = await reload(execution.id);

    expect(second.status).toBe("CLOSED_EXTERNAL");
    // No second transition, no second event, no exchange call.
    expect(second.version).toBe(first.version);
    expect(scenario.mutations).toEqual([]);
  });

  maybe()("never terminalizes while the position is still open", async () => {
    const execution = await parkedFlatExecution();
    scenario.positionAmt = "0.100";
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "STOP_LOSS", 1));
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "TAKE_PROFIT", 1));

    const outcome = await reconcile(execution.id);

    expect(outcome.ok).toBe(false);
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
  });

  // =========================================================================
  // Every exposure status that can REACH the proof path must be able to
  // record the outcome. The orchestrator routes PARTIALLY_FILLED and
  // ENTRY_FILLED into ensureProtectionForExposure and PLACING_PROTECTION into
  // resumeProtectionLifecycle; all three hand a flat position straight to
  // reconcileProtectionAndClosure, so all three genuinely arrive here.
  // =========================================================================

  /** Proven flat, both owned identities proven absent (-2013), at `status`. */
  async function flatExecutionAt(status: TradeExecutionStatusName) {
    const seed = await filledExecution();
    await protect(seed);
    const execution = await reload(seed.id);
    scenario.positionAmt = "0";
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: {
        status: status as never,
        requiresManualIntervention: status === "MANUAL_INTERVENTION",
        version: { increment: 1 },
      },
    });
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "STOP_LOSS", 1));
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "TAKE_PROFIT", 1));
    scenario.mutations = [];
    return reload(execution.id);
  }

  maybe()("1. PARTIALLY_FILLED reaches CLOSED_EXTERNAL through ensureProtectionForExposure", async () => {
    const execution = await flatExecutionAt("PARTIALLY_FILLED");

    const outcome = await protect(execution);

    expect(outcome.ok).toBe(true);
    const after = await reload(execution.id);
    expect(after.status).toBe("CLOSED_EXTERNAL");
    expect(after.exitReason).toBe("EXTERNAL");
    expect(after.closedAt).not.toBeNull();
    // Still nothing invented about a closure we did not perform.
    expect(after.actualExitPrice).toBeNull();
    expect(after.realizedPnl).toBeNull();
    expect((await protectionOf(execution.id)).state).toBe("CLOSED");
  });

  maybe()("2. ENTRY_FILLED reaches CLOSED_EXTERNAL through ensureProtectionForExposure", async () => {
    const execution = await flatExecutionAt("ENTRY_FILLED");

    const outcome = await protect(execution);

    expect(outcome.ok).toBe(true);
    const after = await reload(execution.id);
    expect(after.status).toBe("CLOSED_EXTERNAL");
    expect(after.exitReason).toBe("EXTERNAL");
    expect((await protectionOf(execution.id)).state).toBe("CLOSED");
  });

  maybe()("3. PLACING_PROTECTION reaches CLOSED_EXTERNAL through resumeProtectionLifecycle", async () => {
    const execution = await flatExecutionAt("PLACING_PROTECTION");

    const outcome = await protectionService.resumeProtectionLifecycle({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(true);
    const after = await reload(execution.id);
    expect(after.status).toBe("CLOSED_EXTERNAL");
    expect(after.exitReason).toBe("EXTERNAL");
    expect((await protectionOf(execution.id)).state).toBe("CLOSED");
  });

  maybe()("4. PROTECTED still reaches CLOSED_EXTERNAL", async () => {
    const execution = await flatExecutionAt("PROTECTED");

    const outcome = await reconcile(execution.id);

    expect(outcome.ok).toBe(true);
    expect((await reload(execution.id)).status).toBe("CLOSED_EXTERNAL");
    expect((await protectionOf(execution.id)).state).toBe("CLOSED");
  });

  maybe()("5. MANUAL_INTERVENTION still reaches CLOSED_EXTERNAL and clears the flag", async () => {
    const execution = await flatExecutionAt("MANUAL_INTERVENTION");
    expect(execution.requiresManualIntervention).toBe(true);

    const outcome = await reconcile(execution.id);

    expect(outcome.ok).toBe(true);
    const after = await reload(execution.id);
    expect(after.status).toBe("CLOSED_EXTERNAL");
    expect(after.requiresManualIntervention).toBe(false);
    expect((await protectionOf(execution.id)).state).toBe("CLOSED");
  });

  // =========================================================================
  // Durable state must never become half-terminal: protection is closed ONLY
  // after the TradeExecution terminalization commit has succeeded.
  // =========================================================================

  maybe()("7. a lost version race leaves protection OPEN, never half-terminal", async () => {
    const execution = await flatExecutionAt("ENTRY_FILLED");

    // A concurrent writer lands between the read and the compare-and-set, so
    // the real CAS runs with a stale expectedVersion and returns null.
    const service = protectionService as unknown as {
      commitExecutionChange: (...args: unknown[]) => Promise<unknown>;
    };
    const original = service.commitExecutionChange.bind(protectionService);
    service.commitExecutionChange = async (...args: unknown[]) => {
      await prisma!.tradeExecution.update({
        where: { id: execution.id },
        data: { version: { increment: 1 } },
      });
      return original(...args);
    };

    let outcome;
    try {
      outcome = await protect(await reload(execution.id));
    } finally {
      service.commitExecutionChange = original;
    }

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("CAPACITY_OR_VERSION_CONFLICT");

    const after = await reload(execution.id);
    // The execution is NOT terminal...
    expect(after.status).toBe("ENTRY_FILLED");
    // ...so protection must NOT be closed. A CLOSED row here would make
    // resumeProtectionLifecycle return early forever and strand the execution.
    expect((await protectionOf(execution.id)).state).not.toBe("CLOSED");

    // 7b. The next tick retries and completes normally.
    const retry = await protect(await reload(execution.id));
    expect(retry.ok).toBe(true);
    expect((await reload(execution.id)).status).toBe("CLOSED_EXTERNAL");
    expect((await protectionOf(execution.id)).state).toBe("CLOSED");
  });

  maybe()("8/9. protection closes only on success, and repeat ticks stay idempotent", async () => {
    const execution = await flatExecutionAt("PLACING_PROTECTION");
    // Before terminalization protection is still open.
    expect((await protectionOf(execution.id)).state).not.toBe("CLOSED");

    await protectionService.resumeProtectionLifecycle({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    const first = await reload(execution.id);
    expect(first.status).toBe("CLOSED_EXTERNAL");
    expect((await protectionOf(execution.id)).state).toBe("CLOSED");
    scenario.mutations = [];

    const repeat = await reconcile(execution.id);
    const second = await reload(execution.id);

    expect(repeat.ok).toBe(true);
    expect(second.status).toBe("CLOSED_EXTERNAL");
    expect(second.version).toBe(first.version);
    expect(scenario.mutations).toEqual([]);
    // Attribution is never rewritten by a later winner.
    expect(second.exitReason).toBe("EXTERNAL");
  });

  maybe()("10. resumeProtectionLifecycle treats CLOSED_EXTERNAL as terminal", async () => {
    const execution = await flatExecutionAt("MANUAL_INTERVENTION");
    await reconcile(execution.id);
    expect((await reload(execution.id)).status).toBe("CLOSED_EXTERNAL");
    scenario.mutations = [];

    const resumed = await protectionService.resumeProtectionLifecycle({
      executionId: execution.id,
      expectedVersion: (await reload(execution.id)).version,
      evaluatedAt: at(),
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.reasonCode).toBe("MANUAL_REVIEW_REQUIRED");
    expect(resumed.message).toContain("CLOSED_EXTERNAL");
    // A terminal execution is never re-protected.
    expect(scenario.mutations).toEqual([]);
    expect((await reload(execution.id)).status).toBe("CLOSED_EXTERNAL");
  });

  maybe()("12. an unknown sibling still blocks external closure from an exposure status", async () => {
    const execution = await flatExecutionAt("ENTRY_FILLED");
    // Re-arm one sibling as unreadable: absence is no longer proven.
    scenario.queryFailures.add(buildClientOrderId(execution.id, "STOP_LOSS", 1));

    const outcome = await protect(execution);

    expect(outcome.ok).toBe(false);
    const after = await reload(execution.id);
    expect(after.status).not.toBe("CLOSED_EXTERNAL");
    expect((await protectionOf(execution.id)).state).not.toBe("CLOSED");
  });
});
