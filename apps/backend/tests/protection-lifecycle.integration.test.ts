import { readFileSync } from "node:fs";
import path from "node:path";
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
const BACKEND = process.cwd();

// Env must be set BEFORE config/env.ts is evaluated. The two live-entry gates
// stay CLOSED on purpose: every Phase 7 mutation is risk-reducing and must
// work regardless.
process.env.EXECUTION_GLOBAL_KILL_SWITCH = "false";
process.env.EXECUTION_LIVE_ENTRY_ENABLED = "false";
process.env.EXECUTION_PROTECTION_READY = "false";
process.env.EXECUTION_AUTO_ADD_MARGIN_ENABLED = "false";
process.env.EXECUTION_EMERGENCY_CLOSE_MODE = "DISABLED";
process.env.EXECUTION_PROTECTION_RECONCILE_MAX_ATTEMPTS = "2";
// The production policy: both legs trigger on the traded contract price. Pinned
// explicitly so the suite exercises the shipped values rather than whatever a
// developer's environment happens to hold.
process.env.EXECUTION_SL_WORKING_TYPE = "CONTRACT_PRICE";
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
const { EntryLifecycleService } = await import("../src/modules/execution/entry-lifecycle.service");
const { BinanceError } = await import("../src/modules/binance/binance.errors");
const { buildClientOrderId } = await import("../src/modules/execution/execution-safety");
// Mutated per test to exercise the emergency-close policy, always restored.
const { env: runtimeEnv } = await import("../src/config/env");

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
  /**
   * Consumed one entry per position read, then falls back to positionAmt. The
   * entry "UNAVAILABLE" makes that read throw instead, so a test can make one
   * specific read in a sequence unreadable.
   */
  positionAmtSequence: string[];
  /** Counts every position read so a test can prove none was added. */
  positionReadCalls: number;
  /** When true, the open-order listings throw: evidence is unavailable. */
  openOrdersUnavailable: boolean;
  /** Counts every listing call so a test can prove none was made. */
  openOrderListCalls: number;
  markPrice: string;
  liquidationPrice: string | null;
  isolatedMargin: string | null;
  leverage: string;
  availableBalance: string;
  symbolStatus: string;
  contractType: string;
  positionMissing: boolean;
  algoOrders: Map<string, AlgoOrderRow>;
  /**
   * Client ids whose DIRECT query must fail, on either endpoint. The listing is
   * unaffected: a per-id query and the open-order book are separate calls, and
   * the race being modelled is precisely one failing while the other answers.
   */
  queryFailures: Set<string>;
  /** clientAlgoId -> how many further reads still answer -2013 despite existing. */
  invisibleReads: Map<string, number>;
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
  /** Every standard protection POST context, in order. */
  standardSubmitted: Record<string, string>[];
  standardSubmitFailure: Error | null;
  standardSubmitLands: boolean;
  standardCancelFailure: Error | null;
  /**
   * Called right after an algo order lands, so a test can change what the
   * exchange will report about it BEFORE the next coverage measurement in the
   * same tick reads it back.
   */
  onSubmitted: ((clientAlgoId: string) => void) | null;
}

const scenario: Scenario = {} as Scenario;

function resetScenario() {
  Object.assign(scenario, {
    positionAmt: "0.100",
    positionAmtSequence: [],
    positionReadCalls: 0,
    openOrdersUnavailable: false,
    openOrderListCalls: 0,
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
    invisibleReads: new Map<string, number>(),
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
    standardSubmitted: [],
    standardSubmitFailure: null,
    standardSubmitLands: true,
    standardCancelFailure: null,
    onSubmitted: null,
  } satisfies Scenario);
}

/** Whether a status means the order is still resting on the live book. */
function openOnExchange(status: string): boolean {
  return !["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(status.toUpperCase());
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
    scenario.positionReadCalls += 1;
    if (scenario.positionMissing) return null;
    const scripted = scenario.positionAmtSequence.length > 0 ? scenario.positionAmtSequence.shift()! : null;
    if (scripted === "UNAVAILABLE") throw timeoutError("positionRisk");
    return {
      symbol: SYMBOL,
      positionSide,
      // A scripted sequence lets a test change the position BETWEEN reads, which
      // is the only way to exercise a race that opens after one observation and
      // closes before the next.
      positionAmt: scripted ?? scenario.positionAmt,
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
  async getOpenAlgoOrders(_symbol: string) {
    scenario.openOrderListCalls += 1;
    if (scenario.openOrdersUnavailable) throw timeoutError("openAlgoOrders");
    // Derived from the SAME exchange state the direct query answers from, never
    // a second list a test could set independently: a fixture must not be able
    // to report an order as gone from the book while it is still live.
    return [...scenario.algoOrders.values()]
      .filter((row) => openOnExchange(row.algoStatus))
      .map((row) => ({ clientAlgoId: row.clientAlgoId, algoStatus: row.algoStatus }));
  },
  async getOpenOrders(_symbol?: string) {
    scenario.openOrderListCalls += 1;
    if (scenario.openOrdersUnavailable) throw timeoutError("openOrders");
    return [...scenario.standardOrders.entries()]
      .filter(([, row]) => openOnExchange(row.status))
      .map(([clientOrderId, row]) => ({ clientOrderId, status: row.status }));
  },
  async queryAlgoOrderByClientAlgoId(_symbol: string, clientAlgoId: string) {
    if (scenario.queryFailures.has(clientAlgoId)) throw timeoutError("algoOrder");
    // Read-after-write lag: the POST was accepted and the order exists, but the
    // exchange still answers -2013 for the first N reads. Counted per id so a
    // STOP and a TAKE_PROFIT lag independently.
    const remainingLag = scenario.invisibleReads.get(clientAlgoId);
    if (remainingLag !== undefined && remainingLag > 0) {
      scenario.invisibleReads.set(clientAlgoId, remainingLag - 1);
      throw new BinanceError({
        kind: "MALFORMED_RESPONSE",
        message: "Algo order does not exist",
        binanceCode: -2013,
        endpoint: "algoOrder",
      });
    }
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
    if (scenario.queryFailures.has(clientOrderId)) throw timeoutError("order");
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
      // Defaults to LONG so every pre-existing scenario is unchanged; a row
      // may name its own side, which a HEDGE-identity test needs.
      positionSide: row.positionSide ?? "LONG",
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
  authorizeStandardProtectionSubmission(input: Record<string, unknown>) {
    if (input.role !== "TAKE_PROFIT") {
      throw new Error("only a take profit may be standard");
    }
    if (buildClientOrderId(String(input.executionId), String(input.role), Number(input.generation)) !== input.clientOrderId) {
      throw new Error("client order id does not belong to this tranche");
    }
    const expectedSide = input.positionSide === "LONG" ? "SELL" : "BUY";
    if (input.side !== expectedSide) throw new Error("standard protection must close the position");
    return { ...input, kind: "STANDARD_PROTECTION_SUBMISSION" };
  },
  authorizeStandardProtectionCancellation(input: Record<string, unknown>) {
    if (buildClientOrderId(String(input.executionId), String(input.role), Number(input.generation)) !== input.clientOrderId) {
      throw new Error("client order id does not belong to this tranche");
    }
    return { ...input, kind: "STANDARD_PROTECTION_CANCELLATION" };
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
    scenario.onSubmitted?.(context.clientAlgoId);
    return { algoId: "A1", clientAlgoId: context.clientAlgoId, symbol: SYMBOL, algoStatus: "NEW" };
  },
  async submitStandardProtectionOrder(context: Record<string, string>) {
    dispatched += 1;
    scenario.mutations.push("POST /fapi/v1/order LIMIT TAKE_PROFIT");
    scenario.standardSubmitted.push({ ...context });
    if (scenario.standardSubmitFailure) {
      const error = scenario.standardSubmitFailure;
      scenario.standardSubmitFailure = null;
      if (scenario.standardSubmitLands) landStandardOrder(context);
      throw error;
    }
    landStandardOrder(context);
    return { orderId: "S-1", clientOrderId: context.clientOrderId, symbol: SYMBOL, status: "NEW" };
  },
  async cancelStandardProtectionOrder(context: Record<string, string>) {
    dispatched += 1;
    scenario.mutations.push("DELETE /fapi/v1/order");
    if (scenario.standardCancelFailure) {
      const error = scenario.standardCancelFailure;
      scenario.standardCancelFailure = null;
      throw error;
    }
    const row = scenario.standardOrders.get(context.clientOrderId);
    if (row) row.status = "CANCELED";
    return { orderId: "S-1", clientOrderId: context.clientOrderId, symbol: SYMBOL, status: "CANCELED" };
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

/** A submitted standard protection LIMIT becomes a resting NEW order. */
function landStandardOrder(context: Record<string, string>) {
  scenario.standardOrders.set(context.clientOrderId, {
    status: "NEW",
    origQty: context.quantity,
    executedQty: "0",
    avgPrice: "0",
    orderId: `S-${scenario.standardOrders.size + 1}`,
    side: context.side,
    positionSide: context.positionSide,
    type: "LIMIT",
    price: context.price,
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
let entryService: InstanceType<typeof EntryLifecycleService>;
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

  // The canonical entry repair the ENTRY_FILLED route uses when the confirmed
  // fill is missing. Same fake transports as protection.
  entryService = new EntryLifecycleService(prisma, readOnlyStub as never, mutationStub as never);

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

  // =========================================================================
  // PARTIAL EXIT — over-coverage we caused ourselves.
  //
  // A leg that is TRIGGERED or PARTIALLY_FILLED is closing the position right
  // now. Exposure has already fallen by whatever it filled while its sibling
  // still guards the pre-fill quantity, so coverage legitimately exceeds
  // exposure until the fill resolves.
  //
  // That used to escalate: ORPHAN_PROTECTION_ORDER plus MANUAL_INTERVENTION,
  // on a transient snapshot, naming an orphan that does not exist. It now
  // defers, exactly as an unreadable leg does. Unexplained over-coverage is
  // untouched and still fails closed.
  // =========================================================================

  /** The TP fires and half-fills, so the STOP now guards more than is left. */
  async function partiallyExitedByTakeProfit() {
    const execution = await protectedExecution();
    const takeProfitId = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);
    const leg = scenario.algoOrders.get(takeProfitId)!;
    leg.algoStatus = "PARTIALLY_FILLED";
    leg.executedQty = "0.060";
    // The exchange agrees: 0.100 became 0.040.
    scenario.positionAmt = "0.040";
    return execution;
  }

  maybe()("A. an owned TP partial fill defers instead of escalating", async () => {
    const execution = await partiallyExitedByTakeProfit();

    const outcome = await protect(await reload(execution.id));

    // Deferred and retryable — not a false success, not an escalation.
    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("TAKE_PROFIT_EXECUTION_IN_PROGRESS");
    const after = await reload(execution.id);
    expect(after.requiresManualIntervention).toBe(false);
    expect(after.status).toBe("PROTECTED");
    // Nothing cancelled, nothing submitted, no new identity minted.
    expect(scenario.submitted).toEqual([]);
    expect(scenario.mutations).toEqual([]);
    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1]);
    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toEqual([1]);
  });

  maybe()("A2. no ORPHAN_PROTECTION_ORDER alert is raised for our own fill", async () => {
    const execution = await partiallyExitedByTakeProfit();

    await protect(await reload(execution.id));

    const alerts = await prisma!.criticalAlert.findMany({ where: { tradeExecutionId: execution.id } });
    expect(alerts.map((alert) => alert.alertType)).not.toContain("ORPHAN_PROTECTION_ORDER");
  });

  maybe()("B. an owned STOP partial fill defers on the same evidence", async () => {
    const execution = await protectedExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    const leg = scenario.algoOrders.get(stopId)!;
    leg.algoStatus = "PARTIALLY_FILLED";
    leg.executedQty = "0.060";
    scenario.positionAmt = "0.040";

    const outcome = await protect(await reload(execution.id));

    // The STOP is the executing leg, so its code is reported.
    expect(outcome.reasonCode).toBe("STOP_EXECUTION_IN_PROGRESS");
    expect((await reload(execution.id)).requiresManualIntervention).toBe(false);
    expect(scenario.submitted).toEqual([]);
    expect(scenario.mutations).toEqual([]);
  });

  maybe()("B2. a TRIGGERED leg that has filled nothing yet defers too", async () => {
    // TRIGGERED is the same situation one moment earlier: the guard is gone
    // from the book and the close is on its way.
    const execution = await protectedExecution();
    scenario.algoOrders.get(buildClientOrderId(execution.id, "TAKE_PROFIT", 1))!.algoStatus = "TRIGGERED";
    scenario.positionAmt = "0.040";

    const outcome = await protect(await reload(execution.id));

    expect(outcome.reasonCode).toBe("TAKE_PROFIT_EXECUTION_IN_PROGRESS");
    expect((await reload(execution.id)).requiresManualIntervention).toBe(false);
  });

  maybe()("C. an executing leg contributes no coverage and is not a repairable gap", async () => {
    // The arithmetic question: a PARTIALLY_FILLED conditional is not a resting
    // guard, so it counts as zero. That must not be read as an absent leg and
    // repaired with a duplicate — the deferral above is what prevents it.
    const execution = await partiallyExitedByTakeProfit();

    await protect(await reload(execution.id));
    await protect(await reload(execution.id));

    // Two ticks, still exactly one generation and nothing sent.
    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toEqual([1]);
    expect(scenario.submitted).toEqual([]);
  });

  maybe()("D. unexplained shrinkage still fails closed", async () => {
    // Same shrunken position, but every owned leg is a healthy resting guard:
    // nothing of ours explains it, so this is the orphan case and is escalated.
    const execution = await protectedExecution();
    scenario.positionAmt = "0.040";

    const outcome = await protect(await reload(execution.id));

    expect(outcome.reasonCode).toBe("PROTECTION_COVERAGE_INCOMPLETE");
    const after = await reload(execution.id);
    expect(after.requiresManualIntervention).toBe(true);
    expect(after.status).toBe("MANUAL_INTERVENTION");
    // flushPending() is global and batched, so a queued alert left behind here
    // would starve an unrelated outbox test later in the file.
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("N. the ORPHAN_PROTECTION_ORDER alert is preserved for unexplained cases", async () => {
    const execution = await protectedExecution();
    scenario.positionAmt = "0.040";

    await protect(await reload(execution.id));

    const alerts = await prisma!.criticalAlert.findMany({ where: { tradeExecutionId: execution.id } });
    expect(alerts.map((alert) => alert.alertType)).toContain("ORPHAN_PROTECTION_ORDER");
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("E. an UNREADABLE leg is never treated as an executing one", async () => {
    // The two deferrals must not be conflated. "The exchange said nothing" is
    // not evidence that our protection caused the shrinkage, so this keeps the
    // pre-existing fail-closed escalation rather than borrowing the new
    // deferral. Unreadable is not owned evidence.
    const execution = await protectedExecution();
    scenario.queryFailures.add(buildClientOrderId(execution.id, "TAKE_PROFIT", 1));
    scenario.positionAmt = "0.040";

    const outcome = await protect(await reload(execution.id));

    expect(outcome.reasonCode).toBe("PROTECTION_COVERAGE_INCOMPLETE");
    expect(outcome.reasonCode).not.toBe("TAKE_PROFIT_EXECUTION_IN_PROGRESS");
    expect((await reload(execution.id)).requiresManualIntervention).toBe(true);
    expect(scenario.submitted).toEqual([]);
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("I. a position that goes flat during the fill is terminalized, not repaired", async () => {
    // The next tick's authoritative result. Closure reconciliation owns it and
    // attributes the exit; no replacement exit order is ever posted.
    const execution = await protectedExecution();
    const takeProfitId = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);
    scenario.algoOrders.get(takeProfitId)!.algoStatus = "FILLED";
    scenario.algoOrders.get(takeProfitId)!.executedQty = "0.100";
    scenario.positionAmt = "0";

    await protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: (await reload(execution.id)).version,
      evaluatedAt: at(),
    });

    const after = await reload(execution.id);
    expect(after.status).toBe("CLOSED_TP");
    expect(after.requiresManualIntervention).toBe(false);
    expect(scenario.submitted).toEqual([]);
  });

  maybe()("M. a fully covered execution is completely unaffected", async () => {
    const execution = await protectedExecution();

    const outcome = await protect(await reload(execution.id));

    expect(outcome.ok).toBe(true);
    expect(outcome.reasonCode).toBe("PROTECTION_VERIFIED");
    expect(scenario.submitted).toEqual([]);
    expect((await reload(execution.id)).status).toBe("PROTECTED");
  });

  maybe()("O. the deferral is read-only: no cancel, no submit, no state rewrite", async () => {
    const execution = await partiallyExitedByTakeProfit();
    const before = await ordersOf(execution.id);
    const versionBefore = (await reload(execution.id)).version;

    await protect(await reload(execution.id));
    await protect(await reload(execution.id));

    const after = await ordersOf(execution.id);
    expect(after.length).toBe(before.length);
    for (let index = 0; index < before.length; index += 1) {
      expect(after[index].clientAlgoId).toBe(before[index].clientAlgoId);
      expect(after[index].originalQuantity.toString()).toBe(before[index].originalQuantity.toString());
    }
    // Repeated deferrals cause no version churn on the execution row.
    expect((await reload(execution.id)).version).toBe(versionBefore);
    expect(scenario.mutations).toEqual([]);
  });

  // =========================================================================
  // OWNED STOP OVER-COVERAGE — over-guarded is not unguarded.
  //
  // Direct USD-M testnet observation, hedge mode, both directions: a
  // conditional close armed for 10 against a position of 4 clamps to 4 when it
  // triggers, closes the position and leaves the opposite side at zero. An
  // owned stop that still guards the pre-shrink quantity therefore cannot
  // over-close or reverse.
  //
  // It used to escalate anyway — ORPHAN_PROTECTION_ORDER plus
  // MANUAL_INTERVENTION — naming an orphan that does not exist. The exemption
  // below is deliberately narrow, and everything it does not cover keeps the
  // existing fail-closed behaviour exactly.
  // =========================================================================

  /**
   * The canonical case: exposure shrank, the take profit is conclusively
   * resolved, and the owned stop alone still guards the pre-shrink quantity.
   */
  async function stopOverCovers() {
    const execution = await protectedExecution();
    scenario.algoOrders.get(buildClientOrderId(execution.id, "TAKE_PROFIT", 1))!.algoStatus = "CANCELED";
    scenario.positionAmt = "0.040";
    return execution;
  }

  /**
   * The same safe oversized stop, but with the target still covering the
   * exposure exactly, so there is NOTHING to repair.
   *
   * This is the state whose behaviour must stay byte-for-byte what it was. The
   * three read-only guarantees below were originally written against the gap
   * fixture, back when a take-profit gap behind such a stop could not be
   * repaired at all; that limitation is gone, so they are pinned here, where
   * "the exemption writes nothing" is still exactly the right claim. The gap
   * case is covered by its own tests further down.
   */
  async function stopOverCoversWithTargetIntact() {
    const execution = await protectedExecution();
    // The target shrinks with the position; only the stop is left oversized.
    scenario.algoOrders.get(buildClientOrderId(execution.id, "TAKE_PROFIT", 1))!.quantity = "0.040";
    scenario.positionAmt = "0.040";
    return execution;
  }

  maybe()("P1-A. an owned verified stop guarding more than the position is left alone", async () => {
    const execution = await stopOverCoversWithTargetIntact();

    const outcome = await protect(await reload(execution.id));

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("STOP_COVERAGE_EXCEEDS_EXPOSURE");
    const after = await reload(execution.id);
    expect(after.requiresManualIntervention).toBe(false);
    expect(after.status).toBe("PROTECTED");
    // Read-only: nothing cancelled, nothing sent, no new identity minted.
    expect(scenario.submitted).toEqual([]);
    expect(scenario.mutations).toEqual([]);
  });

  maybe()("P1-A2. no ORPHAN_PROTECTION_ORDER alert is raised for our own stop", async () => {
    const execution = await stopOverCovers();

    await protect(await reload(execution.id));

    const alerts = await prisma!.criticalAlert.findMany({ where: { tradeExecutionId: execution.id } });
    expect(alerts.map((alert) => alert.alertType)).not.toContain("ORPHAN_PROTECTION_ORDER");
  });

  maybe()("P1-B. with nothing missing, NO tranche is reserved by this path", async () => {
    // The target already covers the exposure, so there is nothing to repair and
    // the exemption must reserve nothing at all.
    const execution = await stopOverCoversWithTargetIntact();

    const outcome = await protect(await reload(execution.id));

    expect(outcome.reasonCode).toBe("STOP_COVERAGE_EXCEEDS_EXPOSURE");
    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1]);
    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toEqual([1]);
    expect(scenario.submitted).toEqual([]);
  });

  maybe()("P1-G. BOTH legs over-covering is not blanket-ignored", async () => {
    // Only the stop has testnet evidence behind it. An excess that also covers
    // the take profit is not something this exemption may wave through.
    const execution = await protectedExecution();
    scenario.positionAmt = "0.040";

    const outcome = await protect(await reload(execution.id));

    expect(outcome.reasonCode).not.toBe("STOP_COVERAGE_EXCEEDS_EXPOSURE");
    expect(outcome.reasonCode).toBe("PROTECTION_COVERAGE_INCOMPLETE");
    expect((await reload(execution.id)).requiresManualIntervention).toBe(true);
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("P1-H. TWO active owned stop generations are never exempted", async () => {
    // The tranche model is additive, so two stops can legitimately be active at
    // once: a coverage gap mints generation 2 beside generation 1. Both may be
    // ours and both identity-valid, yet their AGGREGATE guarding more than the
    // position is duplicate protection, not the single stale stop the testnet
    // evidence covers. It must keep failing closed.
    const execution = await protectedExecution();

    // Exposure grows, so the health path reserves and submits generation 2.
    scenario.positionAmt = "0.200";
    await protect(await reload(execution.id));
    expect(await generationsOf(execution.id, "STOP_LOSS")).toContain(2);

    // Both stop generations are now ACTIVE and aggregate to 0.200.
    for (const generation of [1, 2]) {
      expect(scenario.algoOrders.get(buildClientOrderId(execution.id, "STOP_LOSS", generation))!.algoStatus).toBe("NEW");
      // Take profits resolved, so ONLY the stops over-cover — otherwise the
      // take-profit guard would be what refuses, and this would prove nothing.
      scenario.algoOrders.get(buildClientOrderId(execution.id, "TAKE_PROFIT", generation))!.algoStatus = "CANCELED";
    }

    // Now exposure collapses well below the aggregate stop coverage.
    scenario.positionAmt = "0.040";
    scenario.submitted = [];
    scenario.mutations = [];

    const outcome = await protect(await reload(execution.id));

    expect(outcome.reasonCode).not.toBe("STOP_COVERAGE_EXCEEDS_EXPOSURE");
    expect(outcome.reasonCode).toBe("PROTECTION_COVERAGE_INCOMPLETE");
    const after = await reload(execution.id);
    expect(after.requiresManualIntervention).toBe(true);
    expect(after.status).toBe("MANUAL_INTERVENTION");
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("P1-C. take-profit over-coverage is NOT exempted", async () => {
    // Only the stop may be over-covering. A take profit guarding more than the
    // position is not something this exemption has evidence about.
    const execution = await protectedExecution();
    scenario.algoOrders.get(buildClientOrderId(execution.id, "STOP_LOSS", 1))!.algoStatus = "CANCELED";
    scenario.positionAmt = "0.040";

    const outcome = await protect(await reload(execution.id));

    expect(outcome.reasonCode).not.toBe("STOP_COVERAGE_EXCEEDS_EXPOSURE");
    expect(outcome.reasonCode).toBe("PROTECTION_COVERAGE_INCOMPLETE");
    expect((await reload(execution.id)).requiresManualIntervention).toBe(true);
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("P1-D. an identity-mismatched stop is never exempted", async () => {
    // The observed order carries our id but contradicts our intent, so it is
    // not conclusively ours and the escalation must stand.
    const execution = await stopOverCovers();
    scenario.algoOrders.get(buildClientOrderId(execution.id, "STOP_LOSS", 1))!.positionSide = "SHORT";

    const outcome = await protect(await reload(execution.id));

    expect(outcome.reasonCode).not.toBe("STOP_COVERAGE_EXCEEDS_EXPOSURE");
    expect(outcome.reasonCode).toBe("PROTECTION_COVERAGE_INCOMPLETE");
    expect((await reload(execution.id)).requiresManualIntervention).toBe(true);
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("P1-D2. a mismatched trigger price is likewise never exempted", async () => {
    const execution = await stopOverCovers();
    scenario.algoOrders.get(buildClientOrderId(execution.id, "STOP_LOSS", 1))!.triggerPrice = "1.2345";

    const outcome = await protect(await reload(execution.id));

    expect(outcome.reasonCode).toBe("PROTECTION_COVERAGE_INCOMPLETE");
    expect((await reload(execution.id)).requiresManualIntervention).toBe(true);
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("P1-E. an unreadable leg is never exempted", async () => {
    // UNKNOWN could be the real explanation for the excess, so it keeps the
    // pre-existing fail-closed behaviour.
    const execution = await stopOverCovers();
    scenario.queryFailures.add(buildClientOrderId(execution.id, "TAKE_PROFIT", 1));

    const outcome = await protect(await reload(execution.id));

    expect(outcome.reasonCode).not.toBe("STOP_COVERAGE_EXCEEDS_EXPOSURE");
    expect((await reload(execution.id)).requiresManualIntervention).toBe(true);
    expect(scenario.submitted).toEqual([]);
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("P1-I. an owned EXECUTING stop keeps its own pre-existing deferral", async () => {
    // The two deferrals stay distinct: this one means the stop is firing, the
    // exemption above means it is resting and merely oversized.
    const execution = await protectedExecution();
    const stop = scenario.algoOrders.get(buildClientOrderId(execution.id, "STOP_LOSS", 1))!;
    stop.algoStatus = "PARTIALLY_FILLED";
    stop.executedQty = "0.060";
    scenario.positionAmt = "0.040";

    const outcome = await protect(await reload(execution.id));

    expect(outcome.reasonCode).toBe("STOP_EXECUTION_IN_PROGRESS");
    expect((await reload(execution.id)).requiresManualIntervention).toBe(false);
  });

  maybe()("P1-J. a fully covered execution is unchanged", async () => {
    const execution = await protectedExecution();

    const outcome = await protect(await reload(execution.id));

    expect(outcome.ok).toBe(true);
    expect(outcome.reasonCode).toBe("PROTECTION_VERIFIED");
    expect(scenario.submitted).toEqual([]);
  });

  maybe()("P1-K. an ordinary gap with no over-coverage still repairs", async () => {
    // Exposure GREW: the stop under-covers, nothing over-covers, so the normal
    // replacement path must be completely unaffected.
    const execution = await protectedExecution();
    scenario.positionAmt = "0.200";

    await protect(await reload(execution.id));

    expect(await generationsOf(execution.id, "STOP_LOSS")).toContain(2);
    expect(scenario.submitted.map((entry) => entry.role)).toContain("STOP_LOSS");
  });

  maybe()("P1-L. the stop is still submitted and verified before the take profit", async () => {
    const execution = await protectedExecution();
    scenario.positionAmt = "0.200";
    scenario.submitted = [];

    await protect(await reload(execution.id));

    const roles = scenario.submitted.map((entry) => entry.role);
    expect(roles.indexOf("STOP_LOSS")).toBeGreaterThanOrEqual(0);
    expect(roles.indexOf("STOP_LOSS")).toBeLessThan(roles.indexOf("TAKE_PROFIT"));
  });

  maybe()("P1-N. repeated safe ticks cause no mutation and no state churn", async () => {
    const execution = await stopOverCoversWithTargetIntact();
    const before = await ordersOf(execution.id);
    const versionBefore = (await reload(execution.id)).version;

    for (let index = 0; index < 3; index += 1) {
      const outcome = await protect(await reload(execution.id));
      expect(outcome.reasonCode).toBe("STOP_COVERAGE_EXCEEDS_EXPOSURE");
    }

    const after = await ordersOf(execution.id);
    expect(after.length).toBe(before.length);
    expect((await reload(execution.id)).version).toBe(versionBefore);
    expect(scenario.submitted).toEqual([]);
    expect(scenario.mutations).toEqual([]);
    const alerts = await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } });
    expect(alerts).toBe(0);
  });

  // =========================================================================
  // ROLE-AWARE TRANCHES — reserve only what is missing, sized to its own gap.
  //
  // Reservation used to walk both roles and size both from
  // max(missingStop, missingTakeProfit), so every single-leg repair minted a
  // redundant second leg. The redundant stop is the dangerous one: two active
  // stops against one position read as over-coverage and, since multiple active
  // stop generations are deliberately not exempt, fail-close into
  // MANUAL_INTERVENTION.
  // =========================================================================

  const stopIdOf = (id: string, generation: number) => buildClientOrderId(id, "STOP_LOSS", generation);
  const tpIdOf = (id: string, generation: number) => buildClientOrderId(id, "TAKE_PROFIT", generation);
  const orderFor = async (id: string, role: "STOP_LOSS" | "TAKE_PROFIT", generation: number) =>
    (await ordersOf(id)).find((order) => order.role === role && order.generation === generation);

  maybe()("R1. a missing take profit reserves a TAKE-PROFIT-ONLY generation", async () => {
    const execution = await protectedExecution();
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.algoStatus = "CANCELED";

    await protect(await reload(execution.id));

    // The whole point: the healthy stop is not duplicated.
    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1]);
    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toEqual([1, 2]);
    expect(scenario.submitted.map((entry) => entry.role)).not.toContain("STOP_LOSS");

    // And it actually POSTED. The pre-submit barrier runs while this very row
    // is still SUBMITTING and absent from the exchange, so this is what proves
    // the barrier asks "is the STOP safe enough" rather than "is protection
    // already complete" -- the latter would block the take profit on its own
    // not-yet-existing coverage, for ever.
    expect(scenario.submitted.map((entry) => entry.role)).toContain("TAKE_PROFIT");
    expect((await orderFor(execution.id, "TAKE_PROFIT", 2))!.status).toBe("NEW");
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("R2. a missing stop reserves a STOP-ONLY generation", async () => {
    const execution = await protectedExecution();
    scenario.algoOrders.get(stopIdOf(execution.id, 1))!.algoStatus = "CANCELED";

    await protect(await reload(execution.id));

    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1, 2]);
    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toEqual([1]);
    expect(scenario.submitted.map((entry) => entry.role)).not.toContain("TAKE_PROFIT");
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("R2b. a stop-only repair does not report the target as unplaceable", async () => {
    // The target is covered by generation 1, so this execution is healthy and
    // must not be written PROTECTION_INCOMPLETE or alerted on.
    const execution = await protectedExecution();
    scenario.algoOrders.get(stopIdOf(execution.id, 1))!.algoStatus = "CANCELED";

    await protect(await reload(execution.id));

    const alerts = await prisma!.criticalAlert.findMany({ where: { tradeExecutionId: execution.id } });
    expect(alerts.map((alert) => alert.reasonCode)).not.toContain("TAKE_PROFIT_TRIGGER_INVALID");
    expect((await protectionOf(execution.id)).state).toBe("PROTECTED");
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("R3. both legs missing still reserves a pair", async () => {
    const execution = await protectedExecution();
    for (const role of ["STOP_LOSS", "TAKE_PROFIT"] as const) {
      scenario.algoOrders.get(buildClientOrderId(execution.id, role, 1))!.algoStatus = "CANCELED";
    }

    await protect(await reload(execution.id));

    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1, 2]);
    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toEqual([1, 2]);
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("R4. each role is reserved for its OWN missing quantity", async () => {
    // Exposure 0.200 with a stop covering 0.100 and no take profit:
    // missing stop 0.100, missing take profit 0.200. The shared max used to
    // size BOTH at 0.200, over-reserving the stop by 0.100 and manufacturing
    // the very over-coverage the lifecycle fails closed on.
    const execution = await protectedExecution();
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    scenario.positionAmt = "0.200";

    await protect(await reload(execution.id));

    expect((await orderFor(execution.id, "STOP_LOSS", 2))!.originalQuantity.toString()).toBe("0.1");
    expect((await orderFor(execution.id, "TAKE_PROFIT", 2))!.originalQuantity.toString()).toBe("0.2");
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("R4b. the reverse asymmetry also uses each role's own quantity", async () => {
    // Exposure 0.200 with no stop and a take profit covering 0.100:
    // missing stop 0.200, missing take profit 0.100. The shared max would have
    // sized BOTH at 0.200, over-reserving the take profit this time.
    const execution = await protectedExecution();
    scenario.algoOrders.get(stopIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    scenario.positionAmt = "0.200";

    await protect(await reload(execution.id));

    expect((await orderFor(execution.id, "STOP_LOSS", 2))!.originalQuantity.toString()).toBe("0.2");
    expect((await orderFor(execution.id, "TAKE_PROFIT", 2))!.originalQuantity.toString()).toBe("0.1");
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("R2c. a genuinely missing target is still reported and alerted", async () => {
    // The other side of R2b. Both legs are gone and the target is unplaceable,
    // so the tranche is stop-only for the LEGACY reason and aggregate coverage
    // really is short. That must keep the existing operator signal.
    const execution = await protectedExecution();
    for (const role of ["STOP_LOSS", "TAKE_PROFIT"] as const) {
      scenario.algoOrders.get(buildClientOrderId(execution.id, role, 1))!.algoStatus = "CANCELED";
    }
    scenario.markPrice = "120"; // a LONG target at 108 can no longer be placed

    const outcome = await protect(await reload(execution.id));

    // Stop-only generation, and the missing target is surfaced rather than
    // absorbed by the intentional-omission path.
    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1, 2]);
    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toEqual([1]);
    expect(outcome.reasonCode).toBe("TAKE_PROFIT_TRIGGER_INVALID");
    const alerts = await prisma!.criticalAlert.findMany({ where: { tradeExecutionId: execution.id } });
    expect(alerts.map((alert) => alert.reasonCode)).toContain("TAKE_PROFIT_TRIGGER_INVALID");
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("R5. a pair still submits the stop before the take profit", async () => {
    const execution = await protectedExecution();
    for (const role of ["STOP_LOSS", "TAKE_PROFIT"] as const) {
      scenario.algoOrders.get(buildClientOrderId(execution.id, role, 1))!.algoStatus = "CANCELED";
    }
    scenario.submitted = [];

    await protect(await reload(execution.id));

    const roles = scenario.submitted.map((entry) => entry.role);
    expect(roles.indexOf("STOP_LOSS")).toBeGreaterThanOrEqual(0);
    expect(roles.indexOf("STOP_LOSS")).toBeLessThan(roles.indexOf("TAKE_PROFIT"));
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("R6. nothing to reserve creates NO generation and no churn", async () => {
    // The stop already covers the exposure and the target is not placeable.
    // Role filtering drops the stop, trigger filtering drops the take profit,
    // and an empty generation must never be manufactured.
    const execution = await protectedExecution();
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    scenario.markPrice = "120"; // a LONG target at 108 can no longer be placed
    const versionBefore = (await reload(execution.id)).version;
    const ordersBefore = (await ordersOf(execution.id)).length;
    scenario.submitted = [];
    scenario.mutations = [];

    for (let index = 0; index < 3; index += 1) {
      const outcome = await protect(await reload(execution.id));
      expect(outcome.reasonCode).toBe("TAKE_PROFIT_TRIGGER_INVALID");
    }

    expect((await ordersOf(execution.id)).length).toBe(ordersBefore);
    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toEqual([1]);
    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1]);
    expect((await reload(execution.id)).version).toBe(versionBefore);
    expect(scenario.submitted).toEqual([]);
    expect(scenario.mutations).toEqual([]);
  });

  /** A take-profit-only generation left reserved but unsubmitted. */
  async function pendingTakeProfitOnly() {
    const execution = await protectedExecution();
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    // The POST neither lands nor acknowledges, so the row stays reserved and
    // unresolved -- which is what makes the next tick resume it.
    scenario.submitFailure = "TIMEOUT";
    scenario.submitLands = false;
    await protect(await reload(execution.id));
    scenario.submitFailure = null;
    scenario.submitLands = true;
    // Reserved, stop untouched, and still unresolved so the next tick resumes.
    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1]);
    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toEqual([1, 2]);
    scenario.submitted = [];
    scenario.mutations = [];
    return execution;
  }

  maybe()("R7. a pending take-profit-only tranche is not submitted once the stop is insufficient", async () => {
    const execution = await pendingTakeProfitOnly();
    // Exposure grows, so the surviving stop no longer covers it.
    scenario.positionAmt = "0.200";

    const outcome = await protect(await reload(execution.id));

    expect(outcome.reasonCode).toBe("PROTECTION_COVERAGE_INCOMPLETE");
    expect(scenario.submitted).toEqual([]);
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("R8. multiple active stops over-covering still block the take profit", async () => {
    // The PR1 invariant, re-applied at the pre-submit barrier: two owned stops
    // guarding one position is not something a take profit may be added to.
    const execution = await pendingTakeProfitOnly();
    scenario.positionAmt = "0.200";
    await protect(await reload(execution.id)); // reserves a stop for the gap
    scenario.positionAmt = "0.040";            // both stops now over-cover
    scenario.submitted = [];

    const outcome = await protect(await reload(execution.id));

    expect(outcome.reasonCode).not.toBe("PROTECTION_VERIFIED");
    expect(scenario.submitted).toEqual([]);
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("R9. a flat position is never given a take profit", async () => {
    const execution = await pendingTakeProfitOnly();
    scenario.positionAmt = "0";

    await protect(await reload(execution.id));

    expect(scenario.submitted).toEqual([]);
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("R10. an unreadable stop blocks the take profit", async () => {
    const execution = await pendingTakeProfitOnly();
    scenario.queryFailures.add(stopIdOf(execution.id, 1));

    const outcome = await protect(await reload(execution.id));

    expect(outcome.reasonCode).toBe("STOP_QUERY_UNAVAILABLE");
    expect(scenario.submitted).toEqual([]);
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("R11. a verified single-role generation no longer starves later repair", async () => {
    // Generation 2 is take-profit-only and ACTIVE. It used to count as
    // permanently incomplete, so advanceProtection resumed it for ever and
    // could never reserve the stop repair below.
    const execution = await protectedExecution();
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    await protect(await reload(execution.id));
    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toEqual([1, 2]);

    // Now the stop disappears. A third generation must be reachable.
    scenario.algoOrders.get(stopIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    await protect(await reload(execution.id));

    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1, 3]);
    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toEqual([1, 2]);
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("R12. repeated ticks mint no duplicate single-role generation", async () => {
    const execution = await protectedExecution();
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.algoStatus = "CANCELED";

    for (let index = 0; index < 3; index += 1) await protect(await reload(execution.id));

    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toEqual([1, 2]);
    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1]);
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
  });

  maybe()("R13. ordinary fresh protection is unchanged", async () => {
    const execution = await entryFilledExecution();

    await protect(execution);

    expect((await reload(execution.id)).status).toBe("PROTECTED");
    expect(await generationsOf(execution.id, "STOP_LOSS")).toEqual([1]);
    expect(await generationsOf(execution.id, "TAKE_PROFIT")).toEqual([1]);
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
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
    // Both legs trigger on the traded contract price, and the resolved value is
    // FROZEN onto the intent so a later policy change cannot rewrite it.
    expect(stop.workingType).toBe("CONTRACT_PRICE");
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
    // Its protection is still live, so an attributable fill is legal — and
    // PLACING_PROTECTION is the one non-terminal exit, reserved for a proven
    // protection recovery.
    expect([...allowed].sort()).toEqual([
      "CLOSED_EMERGENCY",
      "CLOSED_EXTERNAL",
      "CLOSED_SL",
      "CLOSED_TP",
      "PLACING_PROTECTION",
    ]);

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
      // Our OWN order, so it carries the policy working type.
      workingType: "CONTRACT_PRICE",
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

  maybe()("9. an ATTEMPTED submission is never re-POSTed, even once it reads as absent", async () => {
    // SUPERSEDES an earlier liveness expectation, deliberately.
    //
    // This test previously asserted that a POST which "never reached the
    // exchange" was eventually retried under the same clientAlgoId, so a live
    // position could not be left unprotected by a deadlock. That property
    // cannot coexist with at-most-once external mutation: once the request has
    // been claimed, the persisted state cannot distinguish "it never left" from
    // "it landed and is not visible yet", so retrying necessarily risks a
    // SECOND live STOP against the same exposure. A duplicated economic
    // mutation is the worse outcome, so the ambiguity is now fail-closed and
    // an operator resolves it.
    //
    // The anti-deadlock concern is answered differently: the execution does not
    // wait forever, it converges on the truthful manual path once the bounded
    // budget expires.
    const execution = await filledExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);

    // Tick N: the POST never lands and the id is briefly unreadable.
    scenario.submitFailure = timeoutError("newAlgoOrder");
    scenario.submitLands = false;
    await protect(execution);
    expect(submittedRoles()).toEqual(["STOP_LOSS"]);
    // The attempt is durably claimed even though nothing was confirmed.
    const claimed = await prisma!.binanceOrder.findFirstOrThrow({
      where: { tradeExecutionId: execution.id, role: "STOP_LOSS" },
    });
    expect(claimed.submissionUnknownAt).not.toBeNull();
    expect(claimed.submittedAt).toBeNull();

    scenario.queryFailures.add(stopId);
    await protect(await reload(execution.id));
    expect(submittedRoles().filter((role) => role === "STOP_LOSS")).toHaveLength(1);

    // Tick N+2: readable and conclusively absent, and the submit would now
    // succeed — but the claim means absence cannot prove it was never sent.
    scenario.queryFailures.delete(stopId);
    scenario.submitFailure = null;
    scenario.submitLands = true;
    await protect(await reload(execution.id));

    // At most once: no second mutation, and no order exists under that id.
    expect(submittedRoles().filter((role) => role === "STOP_LOSS")).toHaveLength(1);
    expect(scenario.algoOrders.has(stopId)).toBe(false);
    expect((await protectionOf(execution.id)).state).not.toBe("PROTECTED");
    // No deadlock either: it has reached the truthful manual path.
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
    expect((await reload(execution.id)).requiresManualIntervention).toBe(true);
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

  // =========================================================================
  // Stale PLACING_PROTECTION: the exchange moved on and the local row did not
  // =========================================================================

  /**
   * The MAINNET incident, as a fixture.
   *
   * An entry filled, protection began, and the position later closed on the
   * exchange while the local row stayed in PLACING_PROTECTION with a STOP that
   * was never observed and a TAKE_PROFIT still SUBMITTING. It then held an
   * OPEN slot, a TOTAL_ACTIVE slot, its planned risk and its isolated margin
   * for as long as the row existed — and reconciliation never moved it,
   * because the PLACING_PROTECTION branch asked "can I finish placing
   * protection?" and never "is this position still there?".
   *
   * Deliberately generic: no incident symbol or count appears in production
   * code or here. What is reproduced is the STATE, not the trade.
   */
  async function stalePlacingProtection(direction: "LONG" | "SHORT" = "LONG") {
    const execution = await filledExecution({ direction, filled: "0.100" });
    const entryClientOrderId = buildClientOrderId(execution.id, "ENTRY", 1);
    await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id, role: "ENTRY", generation: 1,
        clientOrderId: entryClientOrderId, side: direction === "LONG" ? "BUY" : "SELL",
        positionSide: direction, orderType: "LIMIT", timeInForce: "GTC", price: "100",
        // Fully filled: there is no remainder that could refill.
        originalQuantity: "0.100", executedQuantity: "0.100", status: "FILLED",
      },
    });
    scenario.standardOrders.set(entryClientOrderId, {
      status: "FILLED", executedQty: "0.100", avgPrice: "100", orderId: "EN1",
      side: direction === "LONG" ? "BUY" : "SELL", positionSide: direction,
      type: "LIMIT", price: "100", origQty: "0.100",
    });
    const moved = await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { status: "PLACING_PROTECTION", version: { increment: 1 } },
    });
    await prisma!.executionProtectionState.create({
      // Mirrors the incident exactly: mid-placement, with NO verified
      // coverage on either leg.
      data: {
        tradeExecutionId: execution.id,
        state: "PLACING_STOP",
        confirmedOpenQuantity: "0.100",
        protectedStopQuantity: "0",
        protectedTakeProfitQuantity: "0",
        currentGeneration: 1,
      },
    });
    return moved;
  }

  /** A protection tranche that was reserved locally but never observed. */
  async function reserveTranche(
    executionId: string,
    role: "STOP_LOSS" | "TAKE_PROFIT",
    direction: "LONG" | "SHORT",
    status: string
  ) {
    const clientAlgoId = buildClientOrderId(executionId, role, 1);
    await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: executionId, role, generation: 1,
        // Both ids are the same deterministic value, exactly as the reservation
        // transaction writes them.
        clientOrderId: clientAlgoId, clientAlgoId,
        side: direction === "LONG" ? "SELL" : "BUY", positionSide: direction,
        orderType: role === "STOP_LOSS" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
        triggerPrice: role === "STOP_LOSS" ? "96" : "108",
        workingType: "MARK_PRICE", priceProtect: false,
        originalQuantity: "0.100", status,
      },
    });
    return clientAlgoId;
  }

  const closeStale = (execution: { id: string; version: number }) =>
    protectionService.reconcileProtectionAndClosure({
      executionId: execution.id, expectedVersion: execution.version, evaluatedAt: at(),
    });

  // =========================================================================
  // ENTRY_FILLED: real exposure, nothing built on it yet
  // =========================================================================

  /**
   * The TOWNSUSDT incident, as a fixture.
   *
   * An entry filled completely and the execution reached ENTRY_FILLED with
   * NO ExecutionProtectionState row and NO protection orders — the detail page
   * read "No confirmed exposure was recorded for this execution", which is
   * literally the absence of that row. The position was live and carried
   * neither a stop nor a target; the operator closed it by hand; and the row
   * still sat at ENTRY_FILLED more than five minutes later, holding an OPEN
   * slot, a TOTAL_ACTIVE slot, its planned risk and its isolated margin.
   *
   * Deliberately generic: the incident symbol and quantities appear nowhere in
   * production code or here. What is reproduced is the STATE.
   */
  async function staleEntryFilled(direction: "LONG" | "SHORT" = "LONG") {
    const execution = await filledExecution({ direction, filled: "0.100" });
    const entryClientOrderId = buildClientOrderId(execution.id, "ENTRY", 1);
    await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id, role: "ENTRY", generation: 1,
        clientOrderId: entryClientOrderId, side: direction === "LONG" ? "BUY" : "SELL",
        positionSide: direction, orderType: "LIMIT", timeInForce: "GTC", price: "100",
        // Fully filled: no remainder that could ever refill.
        originalQuantity: "0.100", executedQuantity: "0.100", status: "FILLED",
      },
    });
    scenario.standardOrders.set(entryClientOrderId, {
      status: "FILLED", executedQty: "0.100", avgPrice: "100", orderId: "EN1",
      side: direction === "LONG" ? "BUY" : "SELL", positionSide: direction,
      type: "LIMIT", price: "100", origQty: "0.100",
    });
    // ENTRY_FILLED, and NOTHING else. No protection row is created here — that
    // absence is the incident.
    return prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { status: "ENTRY_FILLED", entryFilledAt: at(), version: { increment: 1 } },
    });
  }

  const hasProtectionRow = async (executionId: string) =>
    (await prisma!.executionProtectionState.findUnique({ where: { tradeExecutionId: executionId } })) !==
    null;

  /**
   * The orchestrator's ENTRY_FILLED route, restated here so these tests can
   * exercise the real services directly.
   *
   * Restating it means it could drift from production, so the test below
   * pins the orchestrator source itself. The behavioural guards for the
   * WIRING live in execution-orchestration (routing order) and
   * execution-restart-recovery (L2); what these tests own is the SEMANTICS
   * of each branch once it is reached.
   */
  async function routeEntryFilled(execution: { id: string; version: number }) {
    const input = { executionId: execution.id, expectedVersion: execution.version, evaluatedAt: at() };
    const closure = await protectionService.reconcileProtectionAndClosure(input);
    if (closure.execution.status !== "ENTRY_FILLED") return closure;

    let protection = await protectionService.ensureProtectionForExposure({
      ...input,
      expectedVersion: closure.execution.version,
    });

    // The canonical repair, asked for by reason code exactly as production does.
    if (protection.reasonCode === "EXECUTION_HAS_NO_CONFIRMED_FILL") {
      const reconciled = await entryService.reconcileEntryOrder({
        ...input,
        expectedVersion: closure.execution.version,
      });
      if (reconciled.execution.status !== "ENTRY_FILLED") return reconciled;
      protection = await protectionService.ensureProtectionForExposure({
        ...input,
        expectedVersion: reconciled.execution.version,
      });
    }

    if (["POSITION_STATE_UNAVAILABLE", "EXECUTION_HAS_NO_CONFIRMED_FILL"].includes(protection.reasonCode)) {
      return protectionService.parkUnresolvedFilledExposure(input, protection.reasonCode, protection.message);
    }
    return protection;
  }

  /** The orchestrator's MANUAL_INTERVENTION route, which un-parks or closes. */
  async function routeManualIntervention(executionId: string) {
    const current = await reload(executionId);
    const input = { executionId, expectedVersion: current.version, evaluatedAt: at() };
    const closure = await protectionService.reconcileProtectionAndClosure(input);
    if (closure.execution.status !== "MANUAL_INTERVENTION") return closure;
    return protectionService.attemptProtectionRecovery({
      ...input,
      expectedVersion: closure.execution.version,
    });
  }

  maybe()("the route restated above is the route the orchestrator actually takes", () => {
    // `routeEntryFilled` reimplements the ENTRY_FILLED branch so these tests
    // can drive the real services without an orchestrator. That is only
    // legitimate while the two agree, so the orchestrator's own source is
    // pinned here: closure must be called first, and protection must be
    // reached only while the execution is still ENTRY_FILLED.
    const orchestrator = readFileSync(
      path.join(BACKEND, "src/modules/execution/execution-orchestrator.ts"),
      "utf8"
    );
    const branch = orchestrator.slice(
      orchestrator.indexOf('case "ENTRY_FILLED": {'),
      orchestrator.indexOf('case "PLACING_PROTECTION": {')
    );
    expect(branch, "the ENTRY_FILLED branch was not found").not.toBe("");
    expect(branch.indexOf("reconcileProtectionAndClosure")).toBeGreaterThan(-1);
    expect(branch.indexOf("reconcileProtectionAndClosure")).toBeLessThan(
      branch.indexOf("ensureProtectionForExposure")
    );
    expect(branch).toContain('closure.execution.status !== "ENTRY_FILLED"');
  });

  // TEST K + A + B -----------------------------------------------------------
  maybe()("K/A/B. a live ENTRY_FILLED with no protection row gets both legs", async () => {
    const execution = await staleEntryFilled();
    // The incident's defining absence.
    expect(await hasProtectionRow(execution.id)).toBe(false);
    scenario.positionAmt = "0.100";
    scenario.mutations = [];

    await routeEntryFilled(execution);

    // Protection actually happened, through the canonical lifecycle. No price
    // or parameter is asserted here on purpose — this fix is routing only.
    const after = await reload(execution.id);
    expect(after.status).toBe("PROTECTED");
    expect(await hasProtectionRow(execution.id)).toBe(true);
    const roles = (await ordersOf(execution.id))
      .filter((order) => order.role !== "ENTRY")
      .map((order) => order.role)
      .sort();
    expect(roles).toEqual(["STOP_LOSS", "TAKE_PROFIT"]);
    // It must not sit inert.
    expect(after.status).not.toBe("ENTRY_FILLED");
  });

  // TEST R8 ------------------------------------------------------------------
  maybe()("R8. the UI's Filled quantity IS the field protection checks", () => {
    // The incident page showed Filled quantity = 20270 while protection
    // reported no confirmed exposure. Those two readings are only reconcilable
    // if they read DIFFERENT fields — so this pins that they read the same one.
    //
    // The journal maps `actual.filledQuantity` straight off the TradeExecution
    // row, and `ensureProtectionForExposure` tests that same column. A
    // displayed 20270 therefore means filledQuantity > 0, which means
    // EXECUTION_HAS_NO_CONFIRMED_FILL cannot have been the incident branch.
    const journal = readFileSync(
      path.join(BACKEND, "src/modules/execution/execution-journal.service.ts"),
      "utf8"
    );
    expect(journal).toContain("filledQuantity: decimal(row.filledQuantity)");

    const protectionSource = readFileSync(
      path.join(BACKEND, "src/modules/execution/protection-lifecycle.service.ts"),
      "utf8"
    );
    expect(protectionSource).toContain("execution.filledQuantity ? new D(execution.filledQuantity)");
    expect(protectionSource).toContain('"EXECUTION_HAS_NO_CONFIRMED_FILL"');
  });

  // TEST R3 ------------------------------------------------------------------
  maybe()("R3. an unreadable position parks the execution instead of going inert", async () => {
    // The branch actually compatible with the incident evidence. Before this
    // fix it wrote nothing, escalated nothing and dispatched nothing, so a
    // live unprotected position sat unowned and unalarmed indefinitely.
    const execution = await staleEntryFilled();
    const originalRead = readOnlyStub.getPositionForSide;
    readOnlyStub.getPositionForSide = async () => {
      throw timeoutError("positionRisk");
    };
    scenario.mutations = [];

    // Several ticks, exactly as the worker would run them.
    for (let index = 0; index < 3; index += 1) {
      await routeEntryFilled(await reload(execution.id));
    }
    readOnlyStub.getPositionForSide = originalRead;

    const parked = await reload(execution.id);
    // UNKNOWN is never FLAT: no terminal status was invented.
    expect(parked.status).toBe("MANUAL_INTERVENTION");
    expect(parked.exitReason).toBeNull();
    expect(parked.closedAt).toBeNull();
    expect(parked.requiresManualIntervention).toBe(true);
    // Visible, through the durable state the repository already uses for
    // "this needs attention": MANUAL_INTERVENTION plus the manual flag, which
    // together put the execution into recoveryRequiredCount and onto the
    // panel's manual-intervention count.
    //
    // Deliberately NOT a critical alert. POSITION_STATE_UNAVAILABLE is not in
    // CRITICAL_REASON_CODES, and adding it would fire an operator alert for
    // every transient timeout on the four other paths that return it. The park
    // is the escalation; the alert stays reserved for observed contradictions.
    const { RECOVERY_REQUIRED_STATUSES } = await import(
      "../src/modules/execution/execution-orchestrator"
    );
    expect([...RECOVERY_REQUIRED_STATUSES]).toContain("MANUAL_INTERVENTION");
    const protectionRow = await prisma!.executionProtectionState.findUnique({
      where: { tradeExecutionId: execution.id },
    });
    expect(protectionRow?.state).toBe("MANUAL_INTERVENTION");
    expect(protectionRow?.reasonCode).toBe("POSITION_STATE_UNAVAILABLE");
    // And nothing was submitted on a position nobody could see.
    expect(scenario.mutations).toEqual([]);
  });

  maybe()("R3b. parking is recorded once, not once per tick", async () => {
    const execution = await staleEntryFilled();
    const originalRead = readOnlyStub.getPositionForSide;
    readOnlyStub.getPositionForSide = async () => {
      throw timeoutError("positionRisk");
    };

    await routeEntryFilled(execution);
    const afterFirst = await reload(execution.id);
    const eventsAfterFirst = await prisma!.executionEvent.count({
      where: { tradeExecutionId: execution.id },
    });

    for (let index = 0; index < 3; index += 1) {
      await routeEntryFilled(await reload(execution.id));
    }
    readOnlyStub.getPositionForSide = originalRead;

    const after = await reload(execution.id);
    expect(after.version).toBe(afterFirst.version);
    expect(await prisma!.executionEvent.count({ where: { tradeExecutionId: execution.id } })).toBe(
      eventsAfterFirst
    );
  });

  // TEST R4 ------------------------------------------------------------------
  maybe()("R4. once reads recover over a LIVE position, the park self-heals", async () => {
    const execution = await staleEntryFilled();
    const originalRead = readOnlyStub.getPositionForSide;
    readOnlyStub.getPositionForSide = async () => {
      throw timeoutError("positionRisk");
    };
    await routeEntryFilled(execution);
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");

    // The exchange answers again, and the position is still open.
    readOnlyStub.getPositionForSide = originalRead;
    scenario.positionAmt = "0.100";

    // The ordinary MANUAL_INTERVENTION route — no operator action, no new
    // subsystem. POSITION_STATE_UNAVAILABLE is a recoverable intervention
    // reason precisely so this works.
    await routeManualIntervention(execution.id);
    const recovered = await reload(execution.id);
    expect(recovered.status).not.toBe("MANUAL_INTERVENTION");
    expect(recovered.requiresManualIntervention).toBe(false);
    // And the exposure is genuinely protected, both legs.
    const roles = (await ordersOf(execution.id))
      .filter((order) => order.role !== "ENTRY")
      .map((order) => order.role)
      .sort();
    expect(roles).toEqual(["STOP_LOSS", "TAKE_PROFIT"]);
  });

  // TEST R5 ------------------------------------------------------------------
  maybe()("R5. once reads recover over a FLAT position, closure terminalizes it", async () => {
    const execution = await staleEntryFilled();
    const originalRead = readOnlyStub.getPositionForSide;
    readOnlyStub.getPositionForSide = async () => {
      throw timeoutError("positionRisk");
    };
    await routeEntryFilled(execution);
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");

    // The exchange answers again and the position is gone.
    readOnlyStub.getPositionForSide = originalRead;
    scenario.positionMissing = true;
    scenario.mutations = [];

    await routeManualIntervention(execution.id);

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_EXTERNAL");
    expect(closed.requiresManualIntervention).toBe(false);
    expect(scenario.mutations).toEqual([]);
  });

  // TEST R6 ------------------------------------------------------------------
  maybe()("R6. a missing confirmed fill is repaired from the entry, then protected", async () => {
    const execution = await staleEntryFilled();
    // The inconsistent state: ENTRY_FILLED with the confirmed-fill column
    // unset, while the ENTRY ORDER proves 0.100 executed.
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { filledQuantity: null, version: { increment: 1 } },
    });
    scenario.positionAmt = "0.100";

    await routeEntryFilled(await reload(execution.id));

    const after = await reload(execution.id);
    // Repaired from authoritative exchange evidence, never guessed.
    expect(after.filledQuantity?.toString()).toBe("0.1");
    expect(after.status).toBe("PROTECTED");
    const roles = (await ordersOf(execution.id))
      .filter((order) => order.role !== "ENTRY")
      .map((order) => order.role)
      .sort();
    expect(roles).toEqual(["STOP_LOSS", "TAKE_PROFIT"]);
  });

  // TEST R7 ------------------------------------------------------------------
  maybe()("R7. an unprovable fill is parked, never guessed at", async () => {
    const execution = await staleEntryFilled();
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { filledQuantity: null, version: { increment: 1 } },
    });
    // The entry query cannot answer either, so nothing can prove the fill.
    scenario.entryQueryUnavailable = true;
    scenario.positionAmt = "0.100";
    scenario.mutations = [];

    await routeEntryFilled(await reload(execution.id));
    scenario.entryQueryUnavailable = false;

    const after = await reload(execution.id);
    // No fill was invented and no protection was sized from a guess.
    expect(after.filledQuantity).toBeNull();
    expect(scenario.mutations).toEqual([]);
    // But it is not inert either: it is parked and alarmed.
    expect(after.status).toBe("MANUAL_INTERVENTION");
    expect(after.requiresManualIntervention).toBe(true);
  });

  // TEST C -------------------------------------------------------------------
  maybe()("C. repeated ticks never submit a second STOP or TP", async () => {
    const execution = await staleEntryFilled();
    scenario.positionAmt = "0.100";

    await routeEntryFilled(execution);
    const afterFirst = await reload(execution.id);
    const ordersAfterFirst = (await ordersOf(execution.id)).length;
    scenario.mutations = [];

    for (let index = 0; index < 3; index += 1) {
      await routeEntryFilled(await reload(execution.id));
    }

    expect((await ordersOf(execution.id)).length).toBe(ordersAfterFirst);
    // Deterministic clientAlgoIds mean a repeat resolves the SAME tranche
    // rather than reserving another one.
    const algoIds = (await ordersOf(execution.id))
      .filter((order) => order.clientAlgoId)
      .map((order) => order.clientAlgoId!);
    expect(new Set(algoIds).size).toBe(algoIds.length);
    expect((await reload(execution.id)).status).toBe(afterFirst.status);
    expect(scenario.mutations).toEqual([]);
  });

  // TEST D -------------------------------------------------------------------
  maybe()("D. concurrent ticks cannot double-submit protection", async () => {
    const execution = await staleEntryFilled();
    scenario.positionAmt = "0.100";
    scenario.mutations = [];

    // Four ticks racing on the same execution.
    await Promise.all(
      Array.from({ length: 4 }, () =>
        routeEntryFilled(execution).catch(() => undefined)
      )
    );

    const protectionOrders = (await ordersOf(execution.id)).filter((order) => order.role !== "ENTRY");
    // One STOP and one TAKE_PROFIT, generation 1, whatever the interleaving.
    expect(protectionOrders.filter((order) => order.role === "STOP_LOSS")).toHaveLength(1);
    expect(protectionOrders.filter((order) => order.role === "TAKE_PROFIT")).toHaveLength(1);
    expect(protectionOrders.every((order) => order.generation === 1)).toBe(true);
  });

  // TEST E + P ---------------------------------------------------------------
  maybe()("E/P. a proven-flat ENTRY_FILLED closes as CLOSED_EXTERNAL with no writes", async () => {
    // The incident's second half: the operator closed the position by hand, so
    // no owned order filled and nothing can attribute the close.
    const execution = await staleEntryFilled();
    scenario.positionMissing = true; // a real exchange OMITS the row when flat
    scenario.mutations = [];

    await routeEntryFilled(execution);

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_EXTERNAL");
    expect(closed.exitReason).toBe("EXTERNAL");
    // Nothing is fabricated.
    expect(closed.actualExitPrice).toBeNull();
    expect(closed.realizedPnl).toBeNull();
    // TEST P: no stop, no TP, no cancel, no margin, no close.
    expect(scenario.mutations).toEqual([]);
  });

  maybe()("E2. and it converges DIRECTLY, without parking for a human first", async () => {
    // Before this fix the flat case reached protection first, which read the
    // missing position row as POSITION_NOT_FOUND_AFTER_FILL and parked the
    // execution at MANUAL_INTERVENTION. Terminal convergence then depended on
    // a later tick taking the MANUAL_INTERVENTION route. Closure-first removes
    // the detour entirely.
    const execution = await staleEntryFilled();
    scenario.positionMissing = true;

    await routeEntryFilled(execution);

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_EXTERNAL");
    expect(closed.requiresManualIntervention).toBe(false);
    const events = await prisma!.executionEvent.findMany({
      where: { tradeExecutionId: execution.id },
    });
    expect(events.map((event) => event.toStatus)).not.toContain("MANUAL_INTERVENTION");
  });

  // TEST F -------------------------------------------------------------------
  maybe()("F. proven flat with owned TP evidence closes as CLOSED_TP", async () => {
    const execution = await staleEntryFilled();
    const tpId = await reserveTranche(execution.id, "TAKE_PROFIT", "LONG", "SUBMITTING");
    scenario.algoOrders.set(tpId, { algoStatus: "FILLED", executedQty: "0.100", avgPrice: "108" } as never);
    scenario.positionAmt = "0";
    scenario.mutations = [];

    await routeEntryFilled(execution);

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_TP");
    expect(closed.exitReason).toBe("TAKE_PROFIT");
    expect(closed.actualExitPrice?.toString()).toBe("108");
    expect(scenario.mutations).toEqual([]);
  });

  // TEST G -------------------------------------------------------------------
  maybe()("G. proven flat with owned STOP evidence closes as CLOSED_SL", async () => {
    const execution = await staleEntryFilled();
    const stopId = await reserveTranche(execution.id, "STOP_LOSS", "LONG", "UNKNOWN");
    scenario.algoOrders.set(stopId, { algoStatus: "FILLED", executedQty: "0.100", avgPrice: "96" } as never);
    scenario.positionAmt = "0";
    scenario.mutations = [];

    await routeEntryFilled(execution);

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_SL");
    expect(closed.exitReason).toBe("STOP_LOSS");
    expect(scenario.mutations).toEqual([]);
  });

  // TEST H -------------------------------------------------------------------
  maybe()("H. an unreadable position is never treated as flat, and never left inert", async () => {
    const execution = await staleEntryFilled();
    const originalRead = readOnlyStub.getPositionForSide;
    readOnlyStub.getPositionForSide = async () => {
      throw timeoutError("positionRisk");
    };
    scenario.mutations = [];

    await routeEntryFilled(execution);

    readOnlyStub.getPositionForSide = originalRead;
    // Fail closed: no terminal status invented, no protection pretended, and
    // nothing sent to an exchange that did not answer.
    const after = await reload(execution.id);
    expect(after.exitReason).toBeNull();
    expect(after.closedAt).toBeNull();
    expect(scenario.mutations).toEqual([]);
    // But not inert either. UNKNOWN parks the execution rather than leaving a
    // possibly-live, definitely-unprotected position unowned — see R3.
    expect(after.status).toBe("MANUAL_INTERVENTION");
    expect(after.requiresManualIntervention).toBe(true);
  });

  // TEST I -------------------------------------------------------------------
  maybe()("I. HEDGE: a flat LONG closes while a live SHORT keeps its exposure", async () => {
    const longExecution = await staleEntryFilled("LONG");
    const shortExecution = await staleEntryFilled("SHORT");

    const perSide = readOnlyStub.getPositionForSide;
    readOnlyStub.getPositionForSide = async (_symbol: string, positionSide: string) => {
      if (positionSide === "LONG") return null;
      return {
        symbol: SYMBOL, positionSide, positionAmt: "-0.100", entryPrice: "100",
        markPrice: "100", liquidationPrice: "110", isolatedMargin: "3.00",
        isolatedWallet: "3.00", leverage: "10", unrealizedProfit: "0",
        notional: "10", marginType: "isolated",
      } as never;
    };

    await routeEntryFilled(longExecution);
    await routeEntryFilled(shortExecution);
    readOnlyStub.getPositionForSide = perSide;

    expect((await reload(longExecution.id)).status).toBe("CLOSED_EXTERNAL");
    // The SHORT had live exposure, so it was PROTECTED rather than closed.
    expect((await reload(shortExecution.id)).status).toBe("PROTECTED");
  });

  // TEST J -------------------------------------------------------------------
  maybe()("J. HEDGE mirror: a flat SHORT closes while a live LONG keeps its exposure", async () => {
    const longExecution = await staleEntryFilled("LONG");
    const shortExecution = await staleEntryFilled("SHORT");

    const perSide = readOnlyStub.getPositionForSide;
    readOnlyStub.getPositionForSide = async (_symbol: string, positionSide: string) => {
      if (positionSide === "SHORT") return null;
      return {
        symbol: SYMBOL, positionSide, positionAmt: "0.100", entryPrice: "100",
        markPrice: "100", liquidationPrice: "90", isolatedMargin: "3.00",
        isolatedWallet: "3.00", leverage: "10", unrealizedProfit: "0",
        notional: "10", marginType: "isolated",
      } as never;
    };

    await routeEntryFilled(longExecution);
    await routeEntryFilled(shortExecution);
    readOnlyStub.getPositionForSide = perSide;

    expect((await reload(shortExecution.id)).status).toBe("CLOSED_EXTERNAL");
    expect((await reload(longExecution.id)).status).toBe("PROTECTED");
  });

  // TEST M + O ---------------------------------------------------------------
  maybe()("M/O. exposure is released on closure, and the warning holds until then", async () => {
    const { consumesOpenPosition, consumesTotalActive, consumesNoCapacity } = await import(
      "../src/modules/execution/capacity-status"
    );
    const execution = await staleEntryFilled();

    // TEST O: while filled and unprotected it MUST keep signalling.
    expect(consumesOpenPosition("ENTRY_FILLED")).toBe(true);
    expect(consumesTotalActive("ENTRY_FILLED")).toBe(true);
    const controlSource = readFileSync(
      path.join(BACKEND, "src/modules/operator/trading-control.service.ts"),
      "utf8"
    );
    // ENTRY_FILLED is one of the statuses FILLED_WITHOUT_VERIFIED_PROTECTION
    // counts, and this fix does not remove it from that list.
    expect(controlSource).toContain('"ENTRY_FILLED",');

    scenario.positionMissing = true;
    await routeEntryFilled(execution);

    // TEST M: exposure is a LIVE query over these groups, so terminalizing is
    // what releases OPEN, ACTIVE, RISK and MARGIN. No counter is adjusted.
    const closed = await reload(execution.id);
    expect(consumesOpenPosition(closed.status as never)).toBe(false);
    expect(consumesTotalActive(closed.status as never)).toBe(false);
    expect(consumesNoCapacity(closed.status as never)).toBe(true);
  });

  // TEST Q -------------------------------------------------------------------
  maybe()("Q. repeated reconciliation after terminal closure is inert", async () => {
    const execution = await staleEntryFilled();
    scenario.positionMissing = true;
    await routeEntryFilled(execution);

    const first = await reload(execution.id);
    expect(first.status).toBe("CLOSED_EXTERNAL");
    const eventsAfterFirst = await prisma!.executionEvent.count({
      where: { tradeExecutionId: execution.id },
    });
    const alertsAfterFirst = await prisma!.criticalAlert.count({
      where: { tradeExecutionId: execution.id },
    });
    scenario.mutations = [];

    for (let index = 0; index < 3; index += 1) {
      await protectionService.reconcileProtectionAndClosure({
        executionId: execution.id,
        expectedVersion: (await reload(execution.id)).version,
        evaluatedAt: at(),
      });
    }

    const after = await reload(execution.id);
    expect(after.status).toBe("CLOSED_EXTERNAL");
    expect(after.version).toBe(first.version);
    expect(after.closedAt?.getTime()).toBe(first.closedAt?.getTime());
    expect(await prisma!.executionEvent.count({ where: { tradeExecutionId: execution.id } })).toBe(
      eventsAfterFirst
    );
    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } })).toBe(
      alertsAfterFirst
    );
    expect(scenario.mutations).toEqual([]);
  });

  // TEST A -------------------------------------------------------------------

  maybe()("A. a stale PLACING_PROTECTION whose TP already filled closes as CLOSED_TP", async () => {
    const execution = await stalePlacingProtection();
    const tpId = await reserveTranche(execution.id, "TAKE_PROFIT", "LONG", "SUBMITTING");
    // The exchange's answer: our own TP filled and the position is gone.
    scenario.algoOrders.set(tpId, { algoStatus: "FILLED", executedQty: "0.100", avgPrice: "108" } as never);
    scenario.positionAmt = "0";
    scenario.mutations = [];

    await closeStale(execution);

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_TP");
    expect(closed.exitReason).toBe("TAKE_PROFIT");
    // The exit price is the one the exchange reported; nothing is invented.
    expect(closed.actualExitPrice?.toString()).toBe("108");
    // TEST H: terminal convergence writes NOTHING to the exchange.
    expect(scenario.mutations).toEqual([]);
  });

  // TEST B -------------------------------------------------------------------
  maybe()("B. a stale PLACING_PROTECTION whose STOP already filled closes as CLOSED_SL", async () => {
    const execution = await stalePlacingProtection();
    const stopId = await reserveTranche(execution.id, "STOP_LOSS", "LONG", "UNKNOWN");
    scenario.algoOrders.set(stopId, { algoStatus: "FILLED", executedQty: "0.100", avgPrice: "96" } as never);
    scenario.positionAmt = "0";
    scenario.mutations = [];

    await closeStale(execution);

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_SL");
    expect(closed.exitReason).toBe("STOP_LOSS");
    expect(scenario.mutations).toEqual([]);
  });

  // TEST C -------------------------------------------------------------------
  maybe()("C. proven flat with no owned fill closes as CLOSED_EXTERNAL, inventing nothing", async () => {
    const execution = await stalePlacingProtection();
    // Both tranches are gone from the exchange — PROVEN absent, not merely
    // unseen — and neither of them filled.
    const stopId = await reserveTranche(execution.id, "STOP_LOSS", "LONG", "UNKNOWN");
    const tpId = await reserveTranche(execution.id, "TAKE_PROFIT", "LONG", "SUBMITTING");
    scenario.queryFailures.delete(stopId);
    scenario.queryFailures.delete(tpId);
    scenario.positionAmt = "0";
    scenario.mutations = [];

    await closeStale(execution);

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_EXTERNAL");
    expect(closed.exitReason).toBe("EXTERNAL");
    // Nothing is fabricated: no exit price, no realized PnL, no fees.
    expect(closed.actualExitPrice).toBeNull();
    expect(closed.realizedPnl).toBeNull();
    expect(scenario.mutations).toEqual([]);
  });

  // TEST D -------------------------------------------------------------------
  maybe()("D. an unreadable position never terminalizes anything", async () => {
    const execution = await stalePlacingProtection();
    const originalRead = readOnlyStub.getPositionForSide;
    readOnlyStub.getPositionForSide = async () => {
      throw timeoutError("positionRisk");
    };
    scenario.mutations = [];

    const outcome = await closeStale(execution);

    readOnlyStub.getPositionForSide = originalRead;
    expect(outcome.reasonCode).toBe("POSITION_STATE_UNAVAILABLE");
    // Unchanged, and still recoverable on a later tick.
    expect((await reload(execution.id)).status).toBe("PLACING_PROTECTION");
    expect(scenario.mutations).toEqual([]);
  });

  // TEST E -------------------------------------------------------------------
  maybe()("E. a position that is still open is never closed", async () => {
    const execution = await stalePlacingProtection();
    scenario.positionAmt = "0.100";
    scenario.mutations = [];

    const outcome = await closeStale(execution);

    expect(outcome.reasonCode).toBe("PROTECTION_COVERAGE_INCOMPLETE");
    expect((await reload(execution.id)).status).toBe("PLACING_PROTECTION");
    // Closure performs no protection work of its own; the orchestrator's
    // resume half owns that, and runs precisely because this returned early.
    expect(scenario.mutations).toEqual([]);
  });

  // TEST F -------------------------------------------------------------------
  maybe()("F. HEDGE identity: a flat LONG closes while a live SHORT is untouched", async () => {
    // Two executions on the SAME symbol, opposite sides. The stub answers per
    // positionSide, which is the identity the service reads — a net or
    // aggregate view would have closed both.
    const longExecution = await stalePlacingProtection("LONG");
    const shortExecution = await stalePlacingProtection("SHORT");

    const readPerSide = readOnlyStub.getPositionForSide;
    readOnlyStub.getPositionForSide = async (_symbol: string, positionSide: string) => {
      if (positionSide === "LONG") return null; // flat: the row is omitted
      return {
        symbol: SYMBOL, positionSide, positionAmt: "-0.100", entryPrice: "100",
        markPrice: "100", liquidationPrice: "110", isolatedMargin: "3.00",
        isolatedWallet: "3.00", leverage: "10", unrealizedProfit: "0",
        notional: "10", marginType: "isolated",
      } as never;
    };

    await closeStale(longExecution);
    await closeStale(shortExecution);
    readOnlyStub.getPositionForSide = readPerSide;

    expect((await reload(longExecution.id)).status).toBe("CLOSED_EXTERNAL");
    // The SHORT still has exposure and must keep it.
    expect((await reload(shortExecution.id)).status).toBe("PLACING_PROTECTION");
  });

  maybe()("F2. and the mirror image: a flat SHORT closes while a live LONG is untouched", async () => {
    const longExecution = await stalePlacingProtection("LONG");
    const shortExecution = await stalePlacingProtection("SHORT");

    const readPerSide = readOnlyStub.getPositionForSide;
    readOnlyStub.getPositionForSide = async (_symbol: string, positionSide: string) => {
      if (positionSide === "SHORT") return null;
      return {
        symbol: SYMBOL, positionSide, positionAmt: "0.100", entryPrice: "100",
        markPrice: "100", liquidationPrice: "90", isolatedMargin: "3.00",
        isolatedWallet: "3.00", leverage: "10", unrealizedProfit: "0",
        notional: "10", marginType: "isolated",
      } as never;
    };

    await closeStale(longExecution);
    await closeStale(shortExecution);
    readOnlyStub.getPositionForSide = readPerSide;

    expect((await reload(shortExecution.id)).status).toBe("CLOSED_EXTERNAL");
    expect((await reload(longExecution.id)).status).toBe("PLACING_PROTECTION");
  });

  // TEST G -------------------------------------------------------------------
  maybe()("G. stale UNKNOWN/SUBMITTING generations do not strand a proven-flat trade", async () => {
    const execution = await stalePlacingProtection();
    await reserveTranche(execution.id, "STOP_LOSS", "LONG", "UNKNOWN");
    await reserveTranche(execution.id, "TAKE_PROFIT", "LONG", "SUBMITTING");
    scenario.positionAmt = "0";

    await closeStale(execution);

    const closed = await reload(execution.id);
    const { isTerminalStatus: terminal } = await import("../src/modules/execution/execution-status");
    expect(terminal(closed.status as never)).toBe(true);
    // The local order rows are NOT rewritten to FILLED to tidy the UI. They
    // keep whatever the exchange actually proved about them; the EXECUTION's
    // terminal status is what decides that nothing needs protecting.
    const orders = await ordersOf(execution.id);
    for (const order of orders.filter((o) => o.role !== "ENTRY")) {
      expect(`${order.role}:${order.status}`).not.toBe(`${order.role}:FILLED`);
    }
    // And the protection row is closed, so it no longer reads as in-flight.
    const protection = await prisma!.executionProtectionState.findUnique({
      where: { tradeExecutionId: execution.id },
    });
    expect(protection?.state).toBe("CLOSED");
  });

  // TEST N -------------------------------------------------------------------
  maybe()("N. a terminalized execution is never reconciled again", async () => {
    // Idempotence here is STRUCTURAL, and that is worth stating precisely
    // rather than asserting a version number. Terminal statuses are excluded
    // from RECONCILABLE_STATUSES, so once closure has committed one the
    // orchestrator stops selecting the row at all: there is no second tick to
    // be idempotent about, and no second terminal transition, session
    // accounting, notification or exchange write can occur.
    const { RECONCILABLE_STATUSES, RECOVERY_REQUIRED_STATUSES } = await import(
      "../src/modules/execution/execution-orchestrator"
    );
    const { TERMINAL_STATUSES } = await import("../src/modules/execution/execution-status");

    for (const terminal of TERMINAL_STATUSES) {
      expect(`${terminal}:${[...RECONCILABLE_STATUSES].includes(terminal as never)}`).toBe(
        `${terminal}:false`
      );
      // And it stops counting toward recoveryPending, which is what kept the
      // incident's stale rows blocking new work indefinitely.
      expect(`${terminal}:${[...RECOVERY_REQUIRED_STATUSES].includes(terminal as never)}`).toBe(
        `${terminal}:false`
      );
    }
  });

  maybe()("N2. and a direct repeat never rewrites the terminal fact or writes to the exchange", async () => {
    // Belt and braces: even called directly — which the orchestrator never
    // does — closure must not restate the outcome, duplicate the journal, or
    // touch the exchange.
    const execution = await stalePlacingProtection();
    const tpId = await reserveTranche(execution.id, "TAKE_PROFIT", "LONG", "SUBMITTING");
    scenario.algoOrders.set(tpId, { algoStatus: "FILLED", executedQty: "0.100", avgPrice: "108" } as never);
    scenario.positionAmt = "0";

    await closeStale(execution);
    const first = await reload(execution.id);
    expect(first.status).toBe("CLOSED_TP");

    const eventsAfterFirst = await prisma!.executionEvent.count({
      where: { tradeExecutionId: execution.id },
    });
    const alertsAfterFirst = await prisma!.criticalAlert.count({
      where: { tradeExecutionId: execution.id },
    });
    scenario.mutations = [];

    for (let index = 0; index < 3; index += 1) await closeStale(await reload(execution.id));
    const after = await reload(execution.id);

    // The terminal fact and its attribution are never rewritten.
    expect(after.status).toBe("CLOSED_TP");
    expect(after.exitReason).toBe("TAKE_PROFIT");
    expect(after.closedAt?.getTime()).toBe(first.closedAt?.getTime());
    expect(after.actualExitPrice?.toString()).toBe(first.actualExitPrice?.toString());
    // No duplicate journal entries and no duplicate operator alerts.
    expect(await prisma!.executionEvent.count({ where: { tradeExecutionId: execution.id } })).toBe(
      eventsAfterFirst
    );
    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } })).toBe(
      alertsAfterFirst
    );
    // And nothing is ever sent to the exchange for a finished trade.
    expect(scenario.mutations).toEqual([]);
  });

  // TEST I / P ---------------------------------------------------------------
  maybe()("I/P. terminalizing releases live exposure and the protection warning", async () => {
    const { consumesOpenPosition, consumesTotalActive, consumesNoCapacity } = await import(
      "../src/modules/execution/capacity-status"
    );

    // The panel counts FILLED_WITHOUT_VERIFIED_PROTECTION over exactly these
    // statuses. The list is module-private to trading-control.service.ts, so
    // it is restated here and pinned against that file, rather than imported.
    const FILLED_UNPROTECTED_STATUSES = ["PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION"];
    const controlSource = readFileSync(
      path.join(BACKEND, "src/modules/operator/trading-control.service.ts"),
      "utf8"
    );
    for (const status of FILLED_UNPROTECTED_STATUSES) {
      expect(controlSource).toContain(`"${status}",`);
    }

    const execution = await stalePlacingProtection();
    // Before: it occupies an OPEN slot, an ACTIVE slot, and its risk and
    // margin count toward the aggregate ceilings.
    expect(consumesOpenPosition("PLACING_PROTECTION")).toBe(true);
    expect(consumesTotalActive("PLACING_PROTECTION")).toBe(true);
    // And it is exactly what FILLED_WITHOUT_VERIFIED_PROTECTION counts.
    expect([...FILLED_UNPROTECTED_STATUSES]).toContain("PLACING_PROTECTION");

    const tpId = await reserveTranche(execution.id, "TAKE_PROFIT", "LONG", "SUBMITTING");
    scenario.algoOrders.set(tpId, { algoStatus: "FILLED", executedQty: "0.100", avgPrice: "108" } as never);
    scenario.positionAmt = "0";

    await closeStale(execution);

    const closed = await reload(execution.id);
    // After: it consumes nothing and is not a filled-unprotected position.
    // Exposure is a LIVE query over these status groups, so fixing the
    // lifecycle is what fixes the numbers — no counter is adjusted anywhere.
    expect(consumesOpenPosition(closed.status as never)).toBe(false);
    expect(consumesTotalActive(closed.status as never)).toBe(false);
    expect(consumesNoCapacity(closed.status as never)).toBe(true);
    expect([...FILLED_UNPROTECTED_STATUSES]).not.toContain(closed.status);
    expect(closed.requiresManualIntervention).toBe(false);
  });

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

// ===========================================================================
// MANUAL_INTERVENTION PROTECTION RECOVERY.
//
// A parked execution with LIVE exposure used to be a dead end: the orchestrator
// ran only closure reconciliation, which returns "Position is still open" and
// touches no protection at all. Nothing could ever notice that the reason for
// the intervention had stopped being true — Mainnet Canary #2 sat parked with a
// perfectly good STOP on Binance and no TAKE_PROFIT until an operator closed
// the position by hand.
//
// Recovery is an ALLOWLIST, not an escape hatch: only an intervention the
// PROTECTION lifecycle raised, for one of four re-decidable STOP reasons, with
// current exchange evidence proving the position open, every leg readable and
// coverage not excessive.
// ===========================================================================

describe("MANUAL_INTERVENTION protection recovery", () => {
  const recover = async (execution: { id: string; version: number }) =>
    protectionService.attemptProtectionRecovery({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

  const eventsOf = async (id: string) =>
    prisma!.executionEvent.findMany({ where: { tradeExecutionId: id }, orderBy: { sequenceNumber: "asc" } });

  const recoveryEventsOf = async (id: string) =>
    prisma!.executionEvent.findMany({
      where: { tradeExecutionId: id, fromStatus: "MANUAL_INTERVENTION", toStatus: "PLACING_PROTECTION" },
      orderBy: { sequenceNumber: "asc" },
    });

  /**
   * The Mainnet Canary #2 shape, built by the REAL machinery rather than by
   * fixture writes: the STOP reaches the exchange, local verification rejects
   * its identity, the TAKE_PROFIT is never submitted, and the execution parks.
   * Clearing the flag afterwards models the comparator defect being fixed.
   */
  const parkedByStopIdentity = async () => {
    const execution = await filledExecution();
    scenario.closePositionOnReadback = true;
    await protect(execution);
    scenario.closePositionOnReadback = false;

    const parked = await reload(execution.id);
    expect(parked.status).toBe("MANUAL_INTERVENTION");
    expect(parked.requiresManualIntervention).toBe(true);
    expect((await protectionOf(execution.id)).reasonCode).toBe("STOP_IDENTITY_MISMATCH");
    // The stop landed; the take profit never did.
    expect(scenario.submitted.map((entry) => entry.role)).toEqual(["STOP_LOSS"]);
    return parked;
  };

  /** Parks a HEALTHY protected execution through the validated public API. */
  const parkProtected = async (id: string, reasonCode: string) => {
    const current = await reload(id);
    await executions.transition({
      executionId: id,
      expectedVersion: current.version,
      targetStatus: "MANUAL_INTERVENTION",
      eventType: "MANUAL_INTERVENTION_REQUIRED",
      reasonCode,
      message: `Synthetic intervention: ${reasonCode}.`,
      requiresManualIntervention: true,
    });
    await prisma!.executionProtectionState.update({
      where: { tradeExecutionId: id },
      data: { state: "MANUAL_INTERVENTION", reasonCode },
    });
    return reload(id);
  };

  // -------------------------------------------------------------------------
  // 1-3. Recovery that must happen
  // -------------------------------------------------------------------------

  maybe()("1. MAINNET CANARY #2: repairs the missing take profit and returns to PROTECTED", async () => {
    const parked = await parkedByStopIdentity();
    const stopId = buildClientOrderId(parked.id, "STOP_LOSS", 1);

    const outcome = await recover(parked);

    expect(outcome.ok).toBe(true);
    const healed = await reload(parked.id);
    expect(healed.status).toBe("PROTECTED");
    // The flag is released only once coverage is proven.
    expect(healed.requiresManualIntervention).toBe(false);
    expect((await protectionOf(parked.id)).state).toBe("PROTECTED");

    // The existing STOP was reused: look-before-submit found it, so exactly one
    // STOP was ever sent and no second identity was minted.
    expect(scenario.submitted.filter((entry) => entry.role === "STOP_LOSS")).toHaveLength(1);
    expect(scenario.submitted.filter((entry) => entry.role === "TAKE_PROFIT")).toHaveLength(1);
    const orders = await ordersOf(parked.id);
    expect(orders.filter((order) => order.role === "STOP_LOSS")).toHaveLength(1);
    expect(orders.every((order) => order.generation === 1)).toBe(true);
    expect(scenario.algoOrders.has(stopId)).toBe(true);

    // Exactly one logical recovery transition, and it is auditable.
    const recoveries = await recoveryEventsOf(parked.id);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].reasonCode).toBe("PROTECTION_RECOVERY_RESUMED");
    const metadata = recoveries[0].metadata as Record<string, unknown>;
    expect(metadata.interventionReason).toBe("STOP_IDENTITY_MISMATCH");
    expect(metadata.recoveryAttempt).toBe(1);
    expect(metadata.alreadyFullyCovered).toBe(false);

    // The path taken is the documented one, and every hop is legal.
    const { canTransition } = await import("../src/modules/execution/execution-status");
    for (const event of await eventsOf(parked.id)) {
      if (!event.fromStatus || !event.toStatus || event.fromStatus === event.toStatus) continue;
      expect(canTransition(event.fromStatus as never, event.toStatus as never).allowed, `${event.fromStatus} -> ${event.toStatus}`).toBe(true);
    }
  });

  maybe()("2. recovers an execution whose protection is ALREADY fully valid, sending nothing", async () => {
    const execution = await filledExecution();
    await protect(execution); // fully protected
    const parked = await parkProtected(execution.id, "STOP_NOT_VERIFIED");
    const mutationsBefore = scenario.mutations.length;

    const outcome = await recover(parked);

    expect(outcome.ok).toBe(true);
    const healed = await reload(parked.id);
    expect(healed.status).toBe("PROTECTED");
    expect(healed.requiresManualIntervention).toBe(false);
    // Already covered: no POST, no DELETE, no new generation.
    expect(scenario.mutations).toHaveLength(mutationsBefore);
    expect((await ordersOf(parked.id)).every((order) => order.generation === 1)).toBe(true);
    const metadata = (await recoveryEventsOf(parked.id))[0].metadata as Record<string, unknown>;
    expect(metadata.alreadyFullyCovered).toBe(true);
  });

  maybe()("3. repairs a conclusively ABSENT stop under the existing stop-first rules", async () => {
    const execution = await filledExecution();
    await protect(execution);
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    const takeProfitId = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);
    // Both legs vanish from the exchange — conclusively absent, not unreadable.
    scenario.algoOrders.delete(stopId);
    scenario.algoOrders.delete(takeProfitId);
    const parked = await parkProtected(execution.id, "STOP_NOT_VERIFIED");

    const outcome = await recover(parked);

    expect(outcome.ok).toBe(true);
    expect((await reload(parked.id)).status).toBe("PROTECTED");
    // A replacement tranche was reserved, and the STOP went first.
    const roles = scenario.submitted.slice(2).map((entry) => entry.role);
    expect(roles).toEqual(["STOP_LOSS", "TAKE_PROFIT"]);
    expect((await ordersOf(parked.id)).some((order) => order.generation === 2)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4-9. Recovery that must NOT happen
  // -------------------------------------------------------------------------

  maybe()("4-6. an UNKNOWN protection leg keeps the execution parked and mutates nothing", async () => {
    for (const unreadable of ["STOP_LOSS", "TAKE_PROFIT", "BOTH"] as const) {
      const execution = await filledExecution();
      await protect(execution);
      const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
      const takeProfitId = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);
      if (unreadable !== "TAKE_PROFIT") scenario.queryFailures.add(stopId);
      if (unreadable !== "STOP_LOSS") scenario.queryFailures.add(takeProfitId);
      const parked = await parkProtected(execution.id, "STOP_NOT_VERIFIED");
      const mutationsBefore = scenario.mutations.length;

      const outcome = await recover(parked);

      expect(outcome.ok, unreadable).toBe(false);
      expect(outcome.reasonCode, unreadable).toBe(
        unreadable === "TAKE_PROFIT" ? "TAKE_PROFIT_QUERY_UNAVAILABLE" : "STOP_QUERY_UNAVAILABLE"
      );
      const after = await reload(parked.id);
      expect(after.status, unreadable).toBe("MANUAL_INTERVENTION");
      expect(after.requiresManualIntervention, unreadable).toBe(true);
      expect(after.version, unreadable).toBe(parked.version);
      expect(scenario.mutations.length, unreadable).toBe(mutationsBefore);
      expect(await recoveryEventsOf(parked.id), unreadable).toHaveLength(0);
      scenario.queryFailures.clear();
    }
  });

  maybe()("7. an unrecoverable reason stays parked even with perfectly healthy protection", async () => {
    // Healthy STOP+TP must never erase an unrelated manual reason.
    for (const reasonCode of [
      "PARTIAL_PROTECTION_EXIT",
      "PROTECTION_COVERAGE_INCOMPLETE",
      "POSITION_IDENTITY_MISMATCH",
      "STOP_TRIGGER_INVALID",
      "EMERGENCY_CLOSE_VERIFICATION_FAILED",
      "POSITION_NOT_FOUND_AFTER_FILL",
      "MANUAL_REVIEW_REQUIRED",
    ]) {
      const execution = await filledExecution();
      await protect(execution);
      const parked = await parkProtected(execution.id, reasonCode);
      const mutationsBefore = scenario.mutations.length;

      const outcome = await recover(parked);

      expect(outcome.ok, reasonCode).toBe(false);
      expect(outcome.reasonCode, reasonCode).toBe("MANUAL_REVIEW_REQUIRED");
      const after = await reload(parked.id);
      expect(after.status, reasonCode).toBe("MANUAL_INTERVENTION");
      expect(after.requiresManualIntervention, reasonCode).toBe(true);
      expect(after.version, reasonCode).toBe(parked.version);
      expect(scenario.mutations.length, reasonCode).toBe(mutationsBefore);
    }
  });

  maybe()("7b. an intervention the protection lifecycle never raised is excluded by construction", async () => {
    // The entry lifecycle parks without ever writing the protection row's
    // state, so no entry-class or operator intervention can be un-parked.
    const execution = await filledExecution();
    await protect(execution);
    const current = await reload(execution.id);
    await executions.transition({
      executionId: execution.id,
      expectedVersion: current.version,
      targetStatus: "MANUAL_INTERVENTION",
      eventType: "MANUAL_INTERVENTION_REQUIRED",
      reasonCode: "STOP_NOT_VERIFIED", // a RECOVERABLE code…
      message: "Parked without a protection-lifecycle escalation.",
      requiresManualIntervention: true,
    });
    // …but the protection row still says PROTECTED, so it was not our doing.
    const parked = await reload(execution.id);

    const outcome = await recover(parked);

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/did not come from the protection lifecycle/i);
    expect((await reload(parked.id)).status).toBe("MANUAL_INTERVENTION");
  });

  maybe()("8. an unreadable or contradictory position keeps the execution parked", async () => {
    const execution = await filledExecution();
    await protect(execution);
    const parked = await parkProtected(execution.id, "STOP_NOT_VERIFIED");

    // Contradictory: the position sign opposes the recorded direction.
    scenario.positionAmt = "-0.100";
    let outcome = await recover(parked);
    expect(outcome.reasonCode).toBe("POSITION_IDENTITY_MISMATCH");
    expect((await reload(parked.id)).status).toBe("MANUAL_INTERVENTION");

    // Unreadable: the position query itself fails.
    scenario.positionAmt = "0.100";
    const originalRead = readOnlyStub.getPositionForSide;
    readOnlyStub.getPositionForSide = async () => {
      throw timeoutError("positionRisk");
    };
    outcome = await recover(await reload(parked.id));
    readOnlyStub.getPositionForSide = originalRead;

    expect(outcome.reasonCode).toBe("POSITION_STATE_UNAVAILABLE");
    expect((await reload(parked.id)).status).toBe("MANUAL_INTERVENTION");
    expect(await recoveryEventsOf(parked.id)).toHaveLength(0);
  });

  maybe()("9. a flat position is closure's business — recovery never runs on it", async () => {
    const execution = await filledExecution();
    await protect(execution);
    const parked = await parkProtected(execution.id, "STOP_NOT_VERIFIED");
    // A real exchange reports a closed position as a MISSING row.
    scenario.positionMissing = true;

    const outcome = await recover(parked);

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("PROTECTION_COVERAGE_INCOMPLETE");
    expect((await reload(parked.id)).status).toBe("MANUAL_INTERVENTION");
    expect(await recoveryEventsOf(parked.id)).toHaveLength(0);
  });

  maybe()("9b. over-protection keeps the execution parked", async () => {
    const execution = await filledExecution();
    await protect(execution);
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    scenario.algoOrders.get(stopId)!.quantity = "0.999";
    const parked = await parkProtected(execution.id, "STOP_NOT_VERIFIED");

    const outcome = await recover(parked);

    expect(outcome.reasonCode).toBe("PROTECTION_COVERAGE_INCOMPLETE");
    expect((await reload(parked.id)).status).toBe("MANUAL_INTERVENTION");
  });

  // -------------------------------------------------------------------------
  // 13-16. Partial repair, churn, concurrency, restart
  // -------------------------------------------------------------------------

  maybe()("13. an incomplete repair does NOT clear the manual-intervention flag", async () => {
    const parked = await parkedByStopIdentity();
    const takeProfitId = buildClientOrderId(parked.id, "TAKE_PROFIT", 1);
    // The take profit submission is lost and its state cannot be resolved.
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

    const outcome = await recover(parked);
    mutationStub.submitProtectionOrder = originalSubmit;

    expect(outcome.ok).toBe(false);
    const after = await reload(parked.id);
    // Un-parked to do the work, but never declared healthy.
    expect(after.status).not.toBe("PROTECTED");
    expect(after.requiresManualIntervention).toBe(true);
    expect((await protectionOf(parked.id)).state).not.toBe("PROTECTED");
  });

  maybe()("14. repeated ticks after a recovery cause no version, event or mutation churn", async () => {
    const parked = await parkedByStopIdentity();
    await recover(parked);
    const settled = await reload(parked.id);
    expect(settled.status).toBe("PROTECTED");
    const mutationsAfter = scenario.mutations.length;
    const eventsAfter = (await eventsOf(parked.id)).length;

    // The orchestrator would now route PROTECTED, but even a direct re-entry
    // must be inert.
    for (let tick = 0; tick < 3; tick += 1) {
      await protectionService.ensureProtectionForExposure({
        executionId: parked.id,
        expectedVersion: (await reload(parked.id)).version,
        evaluatedAt: at(),
      });
      await recover(await reload(parked.id));
    }

    const final = await reload(parked.id);
    expect(final.status).toBe("PROTECTED");
    expect(final.version).toBe(settled.version);
    expect(scenario.mutations).toHaveLength(mutationsAfter);
    expect(await eventsOf(parked.id)).toHaveLength(eventsAfter);
    expect(await recoveryEventsOf(parked.id)).toHaveLength(1);
  });

  maybe()("15. concurrent recovery attempts produce exactly one winner", async () => {
    const parked = await parkedByStopIdentity();

    const results = await Promise.all([recover(parked), recover(parked)]);

    // One un-parked; the loser saw the version move and did nothing.
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await recoveryEventsOf(parked.id)).toHaveLength(1);
    expect((await reload(parked.id)).status).toBe("PROTECTED");
    expect(scenario.submitted.filter((entry) => entry.role === "STOP_LOSS")).toHaveLength(1);
  });

  maybe()("16. a crash mid-recovery converges through the existing restart path", async () => {
    const parked = await parkedByStopIdentity();
    // Un-park, then interrupt before protection could be completed: the TP is
    // accepted by the exchange but stays invisible for the rest of this tick,
    // so verification defers and the row is left at PLACING_PROTECTION exactly
    // as a killed worker would leave it.
    //
    // The interruption is a visibility gap rather than a failed submission on
    // purpose. A dispatched-but-unresolved POST is now a claimed, ambiguous
    // mutation that may never be repeated (see "at most one external mutation
    // per protection intent"), so using one here would test the fail-closed
    // rule instead of restart convergence.
    const takeProfitId = buildClientOrderId(parked.id, "TAKE_PROFIT", 1);
    scenario.invisibleReads.set(takeProfitId, 999);
    await recover(parked);
    // Exactly one take-profit mutation was dispatched, and it stays claimed.
    expect(scenario.submitted.filter((entry) => entry.role === "TAKE_PROFIT")).toHaveLength(1);
    const crashed = await reload(parked.id);
    expect(crashed.status).toBe("PLACING_PROTECTION");
    expect(crashed.requiresManualIntervention).toBe(true);

    // Restart: the orchestrator routes PLACING_PROTECTION here, and by now the
    // accepted take profit has become observable.
    scenario.invisibleReads.delete(takeProfitId);
    const resumed = await protectionService.resumeProtectionLifecycle({
      executionId: parked.id,
      expectedVersion: crashed.version,
      evaluatedAt: at(),
    });

    expect(resumed.ok).toBe(true);
    const healed = await reload(parked.id);
    expect(healed.status).toBe("PROTECTED");
    expect(healed.requiresManualIntervention).toBe(false);
    // The resumed tranche reused its own deterministic id, and the take profit
    // was submitted exactly once — only after its state became readable.
    expect((await ordersOf(parked.id)).every((order) => order.generation === 1)).toBe(true);
    expect(scenario.submitted.filter((entry) => entry.role === "TAKE_PROFIT")).toHaveLength(1);
    expect(await recoveryEventsOf(parked.id)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Episode-scoped retry budget
  // -------------------------------------------------------------------------

  maybe()("17. a failed recovery keeps spending the SAME episode's budget", async () => {
    // The whole point of the cap: a recovery that fails re-parks from
    // PLACING_PROTECTION, and that re-park must NOT hand out a fresh budget.
    const parked = await parkedByStopIdentity();
    // The comparator defect was NOT actually fixed, so every recovery un-parks,
    // fails identity verification again and re-parks from PLACING_PROTECTION.
    // That re-park is a transition INTO MANUAL_INTERVENTION, and it must not
    // hand the next attempt a fresh budget — otherwise the cap never binds.
    scenario.closePositionOnReadback = true;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const current = await reload(parked.id);
      expect(current.status, `attempt ${attempt}`).toBe("MANUAL_INTERVENTION");
      await protectionService.attemptProtectionRecovery({
        executionId: parked.id,
        expectedVersion: current.version,
        evaluatedAt: at(),
      });
    }

    const attempts = await recoveryEventsOf(parked.id);
    expect(attempts).toHaveLength(3);
    expect((attempts[2].metadata as Record<string, unknown>).recoveryAttempt).toBe(3);

    // Budget exhausted: the fourth attempt is refused outright.
    const outcome = await recover(await reload(parked.id));
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/already ran 3 time\(s\)/i);
    expect(await recoveryEventsOf(parked.id)).toHaveLength(3);
  });

  maybe()("18. a NEW intervention episode receives a fresh recovery budget", async () => {
    // Episode 1: parked, recovered, PROTECTED.
    const parked = await parkedByStopIdentity();
    await recover(parked);
    expect((await reload(parked.id)).status).toBe("PROTECTED");
    expect(await recoveryEventsOf(parked.id)).toHaveLength(1);

    // Later in the SAME trade, a new protection incident parks it again.
    const reparked = await parkProtected(parked.id, "STOP_NOT_VERIFIED");

    const outcome = await recover(reparked);

    expect(outcome.ok).toBe(true);
    expect((await reload(parked.id)).status).toBe("PROTECTED");
    const recoveries = await recoveryEventsOf(parked.id);
    expect(recoveries).toHaveLength(2);
    // The second episode counted from ITS own start, not the trade's.
    expect((recoveries[1].metadata as Record<string, unknown>).recoveryAttempt).toBe(1);
  });

  maybe()("19. repeated ticks inside one episode do not reset the budget", async () => {
    const parked = await parkedByStopIdentity();
    scenario.closePositionOnReadback = true; // the first attempt will fail

    await recover(parked);
    expect(await recoveryEventsOf(parked.id)).toHaveLength(1);
    expect((await reload(parked.id)).status).toBe("MANUAL_INTERVENTION");

    // An ordinary tick now re-stamps the already-parked row, writing a
    // MANUAL_INTERVENTION -> MANUAL_INTERVENTION self-transition. That must not
    // look like a new episode either.
    await protectionService.ensureProtectionForExposure({
      executionId: parked.id,
      expectedVersion: (await reload(parked.id)).version,
      evaluatedAt: at(),
    });
    const selfStamps = (await eventsOf(parked.id)).filter(
      (event) => event.fromStatus === "MANUAL_INTERVENTION" && event.toStatus === "MANUAL_INTERVENTION"
    );
    expect(selfStamps.length).toBeGreaterThan(0);

    scenario.closePositionOnReadback = false; // now it can succeed
    await recover(await reload(parked.id));
    const recoveries = await recoveryEventsOf(parked.id);
    expect(recoveries).toHaveLength(2);
    // Still counting from the same episode: this is attempt 2, not attempt 1.
    expect((recoveries[1].metadata as Record<string, unknown>).recoveryAttempt).toBe(2);
  });
});

// ===========================================================================
// ESCALATION EVIDENCE/VERSION COUPLING.
//
// escalate() CASes on the version its CALLER observed, because that version is
// what ties the escalation to the exchange evidence that justified it. Two
// opposite failures are possible and both are covered here:
//
//   - Adopting the CURRENT row's version (reload-then-CAS) lets a slow tick
//     park an execution a faster one has just verified as PROTECTED. The state
//     machine cannot catch it: PROTECTED -> MANUAL_INTERVENTION is perfectly
//     legal. Legality and freshness are separate requirements.
//
//   - Keeping the caller's ORIGINAL version after this same call has already
//     committed one — reserveNextTranche and recordProtectionStatus both do —
//     silently drops the park: the protection row said MANUAL_INTERVENTION
//     while the execution stayed PARTIALLY_FILLED with the manual flag false,
//     invisible to recoveryRequiredCount.
//
// The rule that satisfies both: thread forward the version THIS call produced,
// never one another tick produced.
// ===========================================================================

describe("escalation evidence and version stay coupled", () => {
  const eventsOf = async (id: string) =>
    prisma!.executionEvent.findMany({ where: { tradeExecutionId: id }, orderBy: { sequenceNumber: "asc" } });

  const parkEventsOf = async (id: string) =>
    prisma!.executionEvent.findMany({
      where: { tradeExecutionId: id, toStatus: "MANUAL_INTERVENTION" },
      orderBy: { sequenceNumber: "asc" },
    });

  /** ENTRY_FILLED, because only that status may be promoted to PROTECTED. */
  const entryFilled = async () => {
    const execution = await filledExecution();
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { status: "ENTRY_FILLED", version: { increment: 1 } },
    });
    return reload(execution.id);
  };

  maybe()("1. a stale tick cannot park an execution another tick just PROTECTED", async () => {
    // Tick B's snapshot: taken before tick A did anything.
    const execution = await entryFilled();
    const staleVersion = execution.version;

    // Tick A runs to completion and reaches PROTECTED.
    await protect(execution);
    const healthy = await reload(execution.id);
    expect(healthy.status).toBe("PROTECTED");
    expect(healthy.requiresManualIntervention).toBe(false);
    const parksBefore = (await parkEventsOf(execution.id)).length;

    // Tick B now reaches the production escalation path carrying its OLD
    // version: the exchange reports more protection than exposure, which is a
    // genuine escalation trigger — but its evidence is older than tick A's.
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    scenario.algoOrders.get(stopId)!.quantity = "0.999";

    const outcome = await protectionService.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: staleVersion, // deliberately stale
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(false);
    const after = await reload(execution.id);
    // The healthy winner survives untouched.
    expect(after.status).toBe("PROTECTED");
    expect(after.requiresManualIntervention).toBe(false);
    expect(after.version).toBe(healthy.version);
    // And no event claims a parking that never happened.
    expect(await parkEventsOf(execution.id)).toHaveLength(parksBefore);
  });

  maybe()("2. two overlapping paths: the newer healthy winner is never overwritten", async () => {
    // The realistic shape: startup recovery and a periodic tick both pick up
    // the same execution from the same snapshot (the scheduler fires the
    // interval without awaiting runStartupRecovery, so this genuinely races).
    const execution = await entryFilled();
    const sharedSnapshot = execution.version;

    const first = await protect(execution); // tick A wins the reservation
    expect(first.ok).toBe(true);
    const healthy = await reload(execution.id);
    expect(healthy.status).toBe("PROTECTED");

    // Tick B, still holding the shared snapshot, reads a contradictory
    // position. This escalates from a DIFFERENT call site than test 1 — one
    // that performs no same-call version bump at all — so it proves the
    // coupling holds for the un-threaded escalations too.
    scenario.positionAmt = "-0.100";
    const second = await protectionService.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: sharedSnapshot,
      evaluatedAt: at(),
    });
    scenario.positionAmt = "0.100";

    expect(second.reasonCode).toBe("POSITION_IDENTITY_MISMATCH");
    const after = await reload(execution.id);
    expect(after.status).toBe("PROTECTED");
    expect(after.requiresManualIntervention).toBe(false);
    expect(after.version).toBe(healthy.version);
  });

  maybe()("3. an escalation AFTER this call's own reservation still parks", async () => {
    // The intra-call control. The reservation commits a version bump, then the
    // stop fails identity verification in the SAME call — the Mainnet Canary #2
    // shape. Keeping the caller's original version here is what used to swallow
    // the park entirely.
    const execution = await filledExecution();
    scenario.closePositionOnReadback = true;

    const outcome = await protectionService.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.reasonCode).toBe("STOP_IDENTITY_MISMATCH");
    const parked = await reload(execution.id);
    // The park landed on the EXECUTION row, not just the protection row.
    expect(parked.status).toBe("MANUAL_INTERVENTION");
    expect(parked.requiresManualIntervention).toBe(true);
    expect((await protectionOf(execution.id)).state).toBe("MANUAL_INTERVENTION");

    // Proof the version really did move inside this one call before the park:
    // the reservation event sits between the caller's snapshot and the park.
    const events = await eventsOf(execution.id);
    const reserved = events.find((event) => event.eventType === "PROTECTION_RESERVED")!;
    const park = events.find((event) => event.toStatus === "MANUAL_INTERVENTION")!;
    expect(reserved.sequenceNumber).toBeGreaterThan(execution.version);
    expect(park.sequenceNumber).toBeGreaterThan(reserved.sequenceNumber);
  });

  maybe()("4. an escalation after a same-call PLACING_PROTECTION promotion still parks", async () => {
    // The second in-call writer: recordProtectionStatus promotes ENTRY_FILLED
    // -> PLACING_PROTECTION inside submitTranche, bumping the version before
    // the stop is even submitted.
    const execution = await filledExecution();
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { status: "ENTRY_FILLED", version: { increment: 1 } },
    });
    const filled = await reload(execution.id);
    scenario.closePositionOnReadback = true;

    const outcome = await protectionService.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: filled.version,
      evaluatedAt: at(),
    });

    expect(outcome.reasonCode).toBe("STOP_IDENTITY_MISMATCH");
    const parked = await reload(execution.id);
    expect(parked.status).toBe("MANUAL_INTERVENTION");
    expect(parked.requiresManualIntervention).toBe(true);
    // Both same-call writes happened before the park, and it still landed.
    const events = await eventsOf(execution.id);
    expect(events.some((event) => event.toStatus === "PLACING_PROTECTION")).toBe(true);
    expect(events.some((event) => event.toStatus === "MANUAL_INTERVENTION")).toBe(true);
  });
});

describe("STOP_SUBMISSION_REJECTED is never automatically recovered", () => {
  maybe()("stays parked: the reason collapses permanent operator conditions", async () => {
    const execution = await filledExecution();
    await protect(execution); // healthy protection, so only the REASON blocks it
    const current = await reload(execution.id);
    await executions.transition({
      executionId: execution.id,
      expectedVersion: current.version,
      targetStatus: "MANUAL_INTERVENTION",
      eventType: "MANUAL_INTERVENTION_REQUIRED",
      reasonCode: "STOP_SUBMISSION_REJECTED",
      message: "Protection submission was rejected.",
      requiresManualIntervention: true,
    });
    await prisma!.executionProtectionState.update({
      where: { tradeExecutionId: execution.id },
      data: { state: "MANUAL_INTERVENTION", reasonCode: "STOP_SUBMISSION_REJECTED" },
    });
    const parked = await reload(execution.id);
    const mutationsBefore = scenario.mutations.length;

    const outcome = await protectionService.attemptProtectionRecovery({
      executionId: parked.id,
      expectedVersion: parked.version,
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("MANUAL_REVIEW_REQUIRED");
    expect(outcome.message).toMatch(/not automatically recoverable/i);
    const after = await reload(parked.id);
    expect(after.status).toBe("MANUAL_INTERVENTION");
    expect(after.requiresManualIntervention).toBe(true);
    expect(after.version).toBe(parked.version);
    // No recovery event, no protection mutation.
    expect(
      await prisma!.executionEvent.count({
        where: { tradeExecutionId: parked.id, fromStatus: "MANUAL_INTERVENTION", toStatus: "PLACING_PROTECTION" },
      })
    ).toBe(0);
    expect(scenario.mutations).toHaveLength(mutationsBefore);
  });

  maybe()("the allowlist is exactly the three re-decidable STOP observations", async () => {
    // A behavioural check of the whole set, so widening it silently is not
    // possible: each recoverable reason recovers, the rejected one does not.
    for (const reasonCode of [
      "STOP_NOT_VERIFIED",
      "STOP_IDENTITY_MISMATCH",
      "STOP_SUBMISSION_RESULT_UNKNOWN",
      "STOP_SUBMISSION_REJECTED",
    ] as const) {
      const execution = await filledExecution();
      await protect(execution);
      const current = await reload(execution.id);
      await executions.transition({
        executionId: execution.id,
        expectedVersion: current.version,
        targetStatus: "MANUAL_INTERVENTION",
        eventType: "MANUAL_INTERVENTION_REQUIRED",
        reasonCode,
        message: `Synthetic ${reasonCode}.`,
        requiresManualIntervention: true,
      });
      await prisma!.executionProtectionState.update({
        where: { tradeExecutionId: execution.id },
        data: { state: "MANUAL_INTERVENTION", reasonCode },
      });
      const parked = await reload(execution.id);

      const outcome = await protectionService.attemptProtectionRecovery({
        executionId: parked.id,
        expectedVersion: parked.version,
        evaluatedAt: at(),
      });

      const expected = reasonCode !== "STOP_SUBMISSION_REJECTED";
      expect(outcome.ok, reasonCode).toBe(expected);
      expect((await reload(parked.id)).status, reasonCode).toBe(expected ? "PROTECTED" : "MANUAL_INTERVENTION");
    }
  });
});
﻿
// ===========================================================================
// ESCALATION STATE CONSISTENCY.
//
// An escalation makes a claim about a TradeExecution transition. Everything
// that ASSERTS that claim â€” the parked protection row, the human alert, the
// event â€” must therefore live or die with the transition's CAS.
//
// It used to park `ExecutionProtectionState.state = MANUAL_INTERVENTION` and
// queue a critical alert BEFORE the CAS, so a stale tick whose park correctly
// lost still left the protection row claiming MANUAL_INTERVENTION on top of an
// execution another tick had just verified as PROTECTED, and still woke a
// human for an intervention that never happened.
// ===========================================================================

describe("escalation state consistency", () => {
  const eventsOf = async (id: string) =>
    prisma!.executionEvent.findMany({ where: { tradeExecutionId: id }, orderBy: { sequenceNumber: "asc" } });

  const parkEventsOf = async (id: string) =>
    prisma!.executionEvent.findMany({
      where: { tradeExecutionId: id, toStatus: "MANUAL_INTERVENTION" },
      orderBy: { sequenceNumber: "asc" },
    });

  /** Alerts raised BY escalate itself, as opposed to observation alerts. */
  const escalationAlertsOf = async (id: string) =>
    prisma!.criticalAlert.findMany({
      where: { tradeExecutionId: id, alertType: { in: ["STOP_NOT_VERIFIED", "POSITION_IDENTITY_CONFLICT"] } },
    });

  const entryFilled = async () => {
    const execution = await filledExecution();
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { status: "ENTRY_FILLED", version: { increment: 1 } },
    });
    return reload(execution.id);
  };

  /** Drives the private escalation exactly as production does. */
  const escalate = async (
    execution: Awaited<ReturnType<typeof reload>>,
    reasonCode: string,
    expectedVersion: number
  ) =>
    (
      protectionService as unknown as {
        escalate: (
          execution: unknown,
          reasonCode: string,
          message: string,
          input: { executionId: string; expectedVersion: number; evaluatedAt: Date }
        ) => Promise<{ ok: boolean; reasonCode: string }>;
      }
    ).escalate(execution, reasonCode, `Synthetic ${reasonCode}.`, {
      executionId: execution.id,
      expectedVersion,
      evaluatedAt: at(),
    });

  maybe()("1. a stale escalation leaves the protection row healthy, not parked", async () => {
    const execution = await entryFilled();
    const staleVersion = execution.version;

    // Tick A verifies protection: both rows healthy.
    await protect(execution);
    const healthy = await reload(execution.id);
    const healthyProtection = await protectionOf(execution.id);
    expect(healthy.status).toBe("PROTECTED");
    expect(healthyProtection.state).toBe("PROTECTED");

    // Tick B escalates on older evidence with its stale version.
    const outcome = await escalate(execution, "STOP_NOT_VERIFIED", staleVersion);

    expect(outcome.ok).toBe(false);
    const afterExecution = await reload(execution.id);
    const afterProtection = await protectionOf(execution.id);
    // Neither authoritative row moved.
    expect(afterExecution.status).toBe("PROTECTED");
    expect(afterExecution.requiresManualIntervention).toBe(false);
    expect(afterExecution.version).toBe(healthy.version);
    expect(afterProtection.state).toBe("PROTECTED");
    expect(afterProtection.reasonCode).toBe(healthyProtection.reasonCode);
    expect(afterProtection.version).toBe(healthyProtection.version);
    // No event, so nothing downstream can materialize a false notification.
    expect(await parkEventsOf(execution.id)).toHaveLength(0);
    // And no human was woken for an intervention that never happened.
    expect(await escalationAlertsOf(execution.id)).toHaveLength(0);
  });

  maybe()("2. a stale escalation cannot overwrite a newer PLACING_PROTECTION state", async () => {
    const execution = await entryFilled();
    const staleVersion = execution.version;

    // Another tick advances the execution into placement.
    const takeProfitId = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);
    scenario.queryFailures.add(takeProfitId);
    await protect(execution);
    scenario.queryFailures.delete(takeProfitId);
    const placing = await reload(execution.id);
    const placingProtection = await protectionOf(execution.id);
    expect(placing.status).toBe("PLACING_PROTECTION");

    const outcome = await escalate(execution, "STOP_NOT_VERIFIED", staleVersion);

    expect(outcome.ok).toBe(false);
    expect((await reload(execution.id)).status).toBe("PLACING_PROTECTION");
    expect((await reload(execution.id)).version).toBe(placing.version);
    const afterProtection = await protectionOf(execution.id);
    expect(afterProtection.state).toBe(placingProtection.state);
    expect(afterProtection.version).toBe(placingProtection.version);
    expect(await parkEventsOf(execution.id)).toHaveLength(0);
  });

  maybe()("3. a legitimate escalation parks BOTH rows together", async () => {
    const execution = await entryFilled();
    const current = await reload(execution.id);

    const outcome = await escalate(current, "STOP_NOT_VERIFIED", current.version);

    expect(outcome.ok).toBe(false); // an escalation never reports success
    const parked = await reload(execution.id);
    const protection = await protectionOf(execution.id);
    expect(parked.status).toBe("MANUAL_INTERVENTION");
    expect(parked.requiresManualIntervention).toBe(true);
    expect(parked.decisionReasonCode).toBe("STOP_NOT_VERIFIED");
    expect(protection.state).toBe("MANUAL_INTERVENTION");
    expect(protection.reasonCode).toBe("STOP_NOT_VERIFIED");
    // Exactly one truthful event, and the alert that goes with it.
    const parks = await parkEventsOf(execution.id);
    expect(parks).toHaveLength(1);
    expect(parks[0].eventType).toBe("MANUAL_INTERVENTION_REQUIRED");
    expect(parks[0].fromStatus).toBe("ENTRY_FILLED");
    expect(await escalationAlertsOf(execution.id)).toHaveLength(1);
  });

  maybe()("4. a same-call version bump still parks both rows", async () => {
    // The full production path: reserve (bumps), promote (bumps), then the stop
    // fails identity verification and escalates on the threaded version.
    const execution = await entryFilled();
    scenario.closePositionOnReadback = true;

    const outcome = await protectionService.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    scenario.closePositionOnReadback = false;

    expect(outcome.reasonCode).toBe("STOP_IDENTITY_MISMATCH");
    const parked = await reload(execution.id);
    expect(parked.status).toBe("MANUAL_INTERVENTION");
    expect(parked.requiresManualIntervention).toBe(true);
    expect((await protectionOf(execution.id)).state).toBe("MANUAL_INTERVENTION");
    expect((await protectionOf(execution.id)).reasonCode).toBe("STOP_IDENTITY_MISMATCH");
    expect(await parkEventsOf(execution.id)).toHaveLength(1);
  });

  maybe()("5. two concurrent escalations produce exactly one park", async () => {
    const execution = await entryFilled();
    const current = await reload(execution.id);

    const results = await Promise.all([
      escalate(current, "STOP_NOT_VERIFIED", current.version),
      escalate(current, "STOP_NOT_VERIFIED", current.version),
    ]);

    expect(results).toHaveLength(2);
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
    expect((await protectionOf(execution.id)).state).toBe("MANUAL_INTERVENTION");
    // One logical winner: one transition, one event.
    expect(await parkEventsOf(execution.id)).toHaveLength(1);
    expect((await reload(execution.id)).version).toBe(current.version + 1);
  });

  maybe()("6. a terminal execution is never parked, and neither is its protection row", async () => {
    const execution = await entryFilled();
    await protect(execution);
    const protectedRow = await reload(execution.id);
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { status: "CLOSED_TP", version: { increment: 1 } },
    });
    const terminal = await reload(execution.id);
    const protectionBefore = await protectionOf(execution.id);
    const eventsBefore = (await eventsOf(execution.id)).length;
    void protectedRow;

    // A terminal source is a modelling error, and it stays loud â€” but it must
    // not leave a half-written escalation behind.
    await expect(escalate(terminal, "STOP_NOT_VERIFIED", terminal.version)).rejects.toThrow();

    const after = await reload(execution.id);
    expect(after.status).toBe("CLOSED_TP");
    expect(after.version).toBe(terminal.version);
    const protectionAfter = await protectionOf(execution.id);
    expect(protectionAfter.state).toBe(protectionBefore.state);
    expect(protectionAfter.version).toBe(protectionBefore.version);
    expect(await eventsOf(execution.id)).toHaveLength(eventsBefore);
    expect(await escalationAlertsOf(execution.id)).toHaveLength(0);
  });

  maybe()("7. re-escalating an already parked execution stays consistent", async () => {
    const execution = await entryFilled();
    const first = await reload(execution.id);
    await escalate(first, "STOP_NOT_VERIFIED", first.version);
    const parked = await reload(execution.id);

    // A later tick records fresher evidence while it stays parked.
    const outcome = await escalate(parked, "STOP_IDENTITY_MISMATCH", parked.version);

    expect(outcome.ok).toBe(false);
    const after = await reload(execution.id);
    const protection = await protectionOf(execution.id);
    expect(after.status).toBe("MANUAL_INTERVENTION");
    expect(after.requiresManualIntervention).toBe(true);
    // Both rows carry the NEWER reason â€” they never disagree.
    expect(after.decisionReasonCode).toBe("STOP_IDENTITY_MISMATCH");
    expect(protection.state).toBe("MANUAL_INTERVENTION");
    expect(protection.reasonCode).toBe("STOP_IDENTITY_MISMATCH");
    // The self-stamp is recorded truthfully and cannot look like a new episode.
    const parks = await parkEventsOf(execution.id);
    expect(parks).toHaveLength(2);
    expect(parks[1].fromStatus).toBe("MANUAL_INTERVENTION");
    expect(parks[1].toStatus).toBe("MANUAL_INTERVENTION");
    // No recovery attempt was consumed or reset by the self-stamp.
    expect(
      await prisma!.executionEvent.count({
        where: { tradeExecutionId: execution.id, fromStatus: "MANUAL_INTERVENTION", toStatus: "PLACING_PROTECTION" },
      })
    ).toBe(0);
  });

  maybe()("8. after a successful recovery a stale escalation cannot re-park either row", async () => {
    // Park through the real machinery, recover, then replay the stale tick.
    const execution = await filledExecution();
    scenario.closePositionOnReadback = true;
    await protect(execution);
    scenario.closePositionOnReadback = false;
    const parked = await reload(execution.id);
    expect(parked.status).toBe("MANUAL_INTERVENTION");

    const recovered = await protectionService.attemptProtectionRecovery({
      executionId: parked.id,
      expectedVersion: parked.version,
      evaluatedAt: at(),
    });
    expect(recovered.ok).toBe(true);
    const healthy = await reload(execution.id);
    const healthyProtection = await protectionOf(execution.id);
    expect(healthy.status).toBe("PROTECTED");
    expect(healthy.requiresManualIntervention).toBe(false);
    expect(healthyProtection.state).toBe("PROTECTED");
    const parksBefore = (await parkEventsOf(execution.id)).length;

    // The tick that originally parked it replays with its old version.
    const outcome = await escalate(parked, "STOP_IDENTITY_MISMATCH", parked.version);

    expect(outcome.ok).toBe(false);
    const after = await reload(execution.id);
    const afterProtection = await protectionOf(execution.id);
    expect(after.status).toBe("PROTECTED");
    expect(after.requiresManualIntervention).toBe(false);
    expect(afterProtection.state).toBe("PROTECTED");
    expect(afterProtection.version).toBe(healthyProtection.version);
    expect(await parkEventsOf(execution.id)).toHaveLength(parksBefore);
  });
});

// ===========================================================================
// READ-AFTER-WRITE PROPAGATION.
//
// An accepted POST followed by an immediate -2013 used to be indistinguishable
// from an order that never existed: the post-submit loop re-queried with NO
// delay at all, exhausted its budget in milliseconds, and returned
// *_SUBMISSION_RESULT_UNKNOWN — which raised two critical alerts, parked the
// execution at MANUAL_INTERVENTION, blocked all new work through
// recoveryRequiredCount, and (with EXECUTION_EMERGENCY_CLOSE_MODE enabled)
// satisfied every emergency-close eligibility condition. The next tick would
// then read -2013 again and POST a SECOND order for the same identity.
//
// The budget is now the configured re-query schedule
// (EXECUTION_PROTECTION_RECONCILE_DELAY_MS x attempts), anchored to the FIRST
// accepted submission, and an accepted identity is never re-POSTed.
// ===========================================================================

describe("accepted-submission propagation budget", () => {
  const eventsOf = async (id: string) =>
    prisma!.executionEvent.findMany({ where: { tradeExecutionId: id }, orderBy: { sequenceNumber: "asc" } });

  const stopOrderOf = async (id: string) =>
    prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: id, role: "STOP_LOSS" } });

  const posts = (role: string) => scenario.submitted.filter((entry) => entry.role === role).length;

  /** A service whose propagation budget is long enough to span a test tick. */
  const lagTolerant = () =>
    new ProtectionLifecycleService(
      prisma!,
      readOnlyStub as never,
      mutationStub as never,
      alertService,
      { reconcileMaxAttempts: 2, reconcileDelayMs: 60_000 }
    );

  /** A service whose budget has effectively already expired. */
  const lagIntolerant = () =>
    new ProtectionLifecycleService(
      prisma!,
      readOnlyStub as never,
      mutationStub as never,
      alertService,
      { reconcileMaxAttempts: 1, reconcileDelayMs: 60_000 } // (1 - 1) x delay = no grace
    );

  maybe()("1. the configured reconcile delay and attempts define the budget", async () => {
    // A single configured attempt means no re-query schedule at all, so an
    // invisible accepted submission gets no grace; more attempts do.
    const service = lagIntolerant();
    const execution = await filledExecution();
    scenario.invisibleReads.set(buildClientOrderId(execution.id, "STOP_LOSS", 1), 99);

    const outcome = await service.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.reasonCode).toBe("STOP_SUBMISSION_RESULT_UNKNOWN");
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
  });

  maybe()("2. an accepted STOP that is briefly invisible raises no alert and parks nothing", async () => {
    const service = lagTolerant();
    const execution = await filledExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    scenario.invisibleReads.set(stopId, 99); // never visible during this tick

    const outcome = await service.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.reasonCode).toBe("STOP_SUBMISSION_PROPAGATION_PENDING");
    const after = await reload(execution.id);
    expect(after.status).not.toBe("MANUAL_INTERVENTION");
    expect(after.requiresManualIntervention).toBe(false);
    // No critical alert, no protection park, no emergency close.
    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
    expect((await protectionOf(execution.id)).state).not.toBe("MANUAL_INTERVENTION");
    expect(scenario.mutations.filter((call) => call.includes("order"))).toHaveLength(0);
    // Exactly one POST, and no PROTECTED claim.
    expect(posts("STOP_LOSS")).toBe(1);
    expect(after.status).not.toBe("PROTECTED");
    expect((await protectionOf(execution.id)).state).not.toBe("PROTECTED");
  });

  maybe()("3. it converges on the next tick with a single POST", async () => {
    const service = lagTolerant();
    const execution = await filledExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    // Invisible for this tick's reads only.
    scenario.invisibleReads.set(stopId, 3);

    await service.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    const outcome = await service.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: (await reload(execution.id)).version,
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(true);
    // A PARTIALLY_FILLED entry is deliberately never promoted (its remainder
    // still holds pending-entry capacity), so protection verification is what
    // convergence means here.
    expect((await protectionOf(execution.id)).state).toBe("PROTECTED");
    expect((await reload(execution.id)).status).not.toBe("MANUAL_INTERVENTION");
    // The STOP was submitted exactly once across both ticks.
    expect(posts("STOP_LOSS")).toBe(1);
    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
  });

  maybe()("4. repeated ticks inside the budget cause no alert or mutation churn", async () => {
    const service = lagTolerant();
    const execution = await filledExecution();
    scenario.invisibleReads.set(buildClientOrderId(execution.id, "STOP_LOSS", 1), 999);

    for (let tick = 0; tick < 3; tick += 1) {
      const outcome = await service.ensureProtectionForExposure({
        executionId: execution.id,
        expectedVersion: (await reload(execution.id)).version,
        evaluatedAt: at(),
      });
      expect(outcome.reasonCode, `tick ${tick}`).toBe("STOP_SUBMISSION_PROPAGATION_PENDING");
    }

    expect(posts("STOP_LOSS")).toBe(1);
    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
    expect((await reload(execution.id)).status).not.toBe("MANUAL_INTERVENTION");
    // No replacement generation was minted while waiting.
    expect((await ordersOf(execution.id)).every((order) => order.generation === 1)).toBe(true);
  });

  maybe()("5. the deadline is anchored to the FIRST accepted submission and never resets", async () => {
    const service = lagTolerant();
    const execution = await filledExecution();
    scenario.invisibleReads.set(buildClientOrderId(execution.id, "STOP_LOSS", 1), 999);

    await service.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    const firstSubmittedAt = (await stopOrderOf(execution.id)).submittedAt;
    expect(firstSubmittedAt).not.toBeNull();

    for (let tick = 0; tick < 3; tick += 1) {
      await service.ensureProtectionForExposure({
        executionId: execution.id,
        expectedVersion: (await reload(execution.id)).version,
        evaluatedAt: at(),
      });
    }

    // Same instant after every later tick — the window cannot be pushed forward.
    expect((await stopOrderOf(execution.id)).submittedAt?.toISOString()).toBe(firstSubmittedAt?.toISOString());
    expect(posts("STOP_LOSS")).toBe(1);
  });

  maybe()("6. past the budget the accepted intent is NOT re-POSTed and normal failure resumes", async () => {
    const execution = await filledExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    scenario.invisibleReads.set(stopId, 999);

    // Tick 1 inside a generous budget: deferred, one POST, timestamp anchored.
    await lagTolerant().ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    expect(posts("STOP_LOSS")).toBe(1);
    const anchored = (await stopOrderOf(execution.id)).submittedAt;

    // Tick 2 with the budget already expired.
    const outcome = await lagIntolerant().ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: (await reload(execution.id)).version,
      evaluatedAt: at(),
    });

    // Genuine failure handling resumes...
    expect(outcome.reasonCode).toBe("STOP_SUBMISSION_RESULT_UNKNOWN");
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } })).toBeGreaterThan(0);
    // ...but the accepted identity was never submitted a second time, and the
    // anchor never moved.
    expect(posts("STOP_LOSS")).toBe(1);
    expect((await stopOrderOf(execution.id)).submittedAt?.toISOString()).toBe(anchored?.toISOString());
  });

  maybe()("7. repeated ticks after expiry never restart the window", async () => {
    const service = lagIntolerant();
    const execution = await filledExecution();
    scenario.invisibleReads.set(buildClientOrderId(execution.id, "STOP_LOSS", 1), 999);

    await service.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    const anchored = (await stopOrderOf(execution.id)).submittedAt;

    for (let tick = 0; tick < 3; tick += 1) {
      const outcome = await service.ensureProtectionForExposure({
        executionId: execution.id,
        expectedVersion: (await reload(execution.id)).version,
        evaluatedAt: at(),
      });
      expect(outcome.reasonCode, `tick ${tick}`).not.toBe("STOP_SUBMISSION_PROPAGATION_PENDING");
    }

    expect((await stopOrderOf(execution.id)).submittedAt?.toISOString()).toBe(anchored?.toISOString());
    expect(posts("STOP_LOSS")).toBe(1);
  });

  maybe()("8. a restart inside the budget reuses the persisted anchor", async () => {
    const execution = await filledExecution();
    scenario.invisibleReads.set(buildClientOrderId(execution.id, "STOP_LOSS", 1), 999);

    await lagTolerant().ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    const anchored = (await stopOrderOf(execution.id)).submittedAt;

    // A brand-new service instance holds no in-memory state whatsoever.
    const outcome = await lagTolerant().resumeProtectionLifecycle({
      executionId: execution.id,
      expectedVersion: (await reload(execution.id)).version,
      evaluatedAt: at(),
    });

    expect(outcome.reasonCode).toBe("STOP_SUBMISSION_PROPAGATION_PENDING");
    expect((await stopOrderOf(execution.id)).submittedAt?.toISOString()).toBe(anchored?.toISOString());
    expect(posts("STOP_LOSS")).toBe(1);
  });

  maybe()("9. two concurrent workers make the same decision and POST once", async () => {
    const execution = await filledExecution();
    scenario.invisibleReads.set(buildClientOrderId(execution.id, "STOP_LOSS", 1), 999);
    const current = await reload(execution.id);

    const outcomes = await Promise.all([
      lagTolerant().ensureProtectionForExposure({
        executionId: execution.id,
        expectedVersion: current.version,
        evaluatedAt: at(),
      }),
      lagTolerant().ensureProtectionForExposure({
        executionId: execution.id,
        expectedVersion: current.version,
        evaluatedAt: at(),
      }),
    ]);

    // Neither escalated, and only one reservation could win the version CAS.
    for (const outcome of outcomes) expect(outcome.ok).toBe(false);
    expect((await reload(execution.id)).status).not.toBe("MANUAL_INTERVENTION");
    expect(posts("STOP_LOSS")).toBeLessThanOrEqual(1);
    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
  });

  maybe()("10. a genuinely new generation gets its own independent budget", async () => {
    const service = lagTolerant();
    const execution = await filledExecution();
    await protect(execution); // generation 1 verifies normally
    expect((await reload(execution.id)).status).not.toBe("MANUAL_INTERVENTION");

    // The exchange loses generation 1 and the position grows, so a second
    // tranche is reserved — and its own STOP is briefly invisible.
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "STOP_LOSS", 1));
    scenario.algoOrders.delete(buildClientOrderId(execution.id, "TAKE_PROFIT", 1));
    scenario.invisibleReads.set(buildClientOrderId(execution.id, "STOP_LOSS", 2), 999);

    const outcome = await service.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: (await reload(execution.id)).version,
      evaluatedAt: at(),
    });

    expect(outcome.reasonCode).toBe("STOP_SUBMISSION_PROPAGATION_PENDING");
    const generation2 = (await ordersOf(execution.id)).find(
      (order) => order.role === "STOP_LOSS" && order.generation === 2
    )!;
    // A fresh identity with its own anchor, not the first generation's.
    expect(generation2.submittedAt).not.toBeNull();
    expect(posts("STOP_LOSS")).toBe(2);
  });

  maybe()("11. an identity mismatch is never hidden by the propagation budget", async () => {
    const service = lagTolerant();
    const execution = await filledExecution();
    scenario.closePositionOnReadback = true; // visible, but contradictory

    const outcome = await service.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });
    scenario.closePositionOnReadback = false;

    expect(outcome.reasonCode).toBe("STOP_IDENTITY_MISMATCH");
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
  });

  maybe()("12. a confirmed rejection is never hidden by the propagation budget", async () => {
    const service = lagTolerant();
    const execution = await filledExecution();
    scenario.submitFailure = new BinanceError({
      kind: "REQUEST_INVALID",
      message: "rejected",
      binanceCode: -2021,
      endpoint: "algoOrder",
    });
    scenario.submitLands = false;

    const outcome = await service.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.reasonCode).toBe("STOP_SUBMISSION_REJECTED");
    // A rejected submission records no accepted anchor.
    expect((await stopOrderOf(execution.id)).submittedAt).toBeNull();
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
  });

  maybe()("13. RESULT_UNKNOWN submission semantics are unchanged and earn no grace", async () => {
    const service = lagTolerant();
    const execution = await filledExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    // The POST itself never resolves, and the order never lands.
    scenario.submitFailure = timeoutError("newAlgoOrder");
    scenario.submitLands = false;
    scenario.invisibleReads.set(stopId, 999);

    const outcome = await service.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    // UNKNOWN stays UNKNOWN: no propagation grace, existing handling applies.
    expect(outcome.reasonCode).toBe("STOP_SUBMISSION_RESULT_UNKNOWN");
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
    const stop = await stopOrderOf(execution.id);
    expect(stop.submittedAt).toBeNull();
    expect(stop.submissionUnknownAt).not.toBeNull();
  });

  maybe()("14. a never-submitted protection order gets no grace", async () => {
    // Pre-existing missing protection with no accepted POST behind it must be
    // reserved and submitted exactly as before.
    const service = lagTolerant();
    const execution = await filledExecution();

    const outcome = await service.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(true);
    expect((await protectionOf(execution.id)).state).toBe("PROTECTED");
    expect(posts("STOP_LOSS")).toBe(1);
  });
});

// ===========================================================================
// AT-MOST-ONCE EXTERNAL PROTECTION MUTATION.
//
// The POST and the local record of it can never be one transaction, so a crash
// between them is unavoidable — only WHICH SIDE holds the durable evidence is a
// choice. Recording after the response left `submittedAt` null on rows whose
// order may already be live, and the next worker read -2013, concluded
// "never submitted", and POSTed a SECOND protection order against the same
// exposure. SUBMIT_ALGO duplicates are explicitly NOT treated as proven
// idempotent here, so that is a real second mutation.
//
// `submissionUnknownAt` is now CLAIMED before the request leaves, with a
// conditional update so exactly one worker can win it. From that moment the
// identity is fail-closed: -2013 proves it is not observable, never that our
// mutation failed to create it.
// ===========================================================================

describe("at-most-once external protection mutation", () => {
  const stopOrderOf = async (id: string) =>
    prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: id, role: "STOP_LOSS" } });

  const posts = (role: string) => scenario.submitted.filter((entry) => entry.role === role).length;

  /** Budget long enough that a test tick always lands inside it. */
  const tolerant = () =>
    new ProtectionLifecycleService(prisma!, readOnlyStub as never, mutationStub as never, alertService, {
      reconcileMaxAttempts: 2,
      reconcileDelayMs: 60_000,
    });

  /** Budget of zero: (1 - 1) x delay, so ambiguity has already expired. */
  const expired = () =>
    new ProtectionLifecycleService(prisma!, readOnlyStub as never, mutationStub as never, alertService, {
      reconcileMaxAttempts: 1,
      reconcileDelayMs: 60_000,
    });

  const run = async (
    instance: ReturnType<typeof tolerant>,
    execution: { id: string; version: number }
  ) =>
    instance.ensureProtectionForExposure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

  /** A prisma whose protection-order claim write always fails. */
  const claimFailingPrisma = () =>
    new Proxy(prisma! as object, {
      get(target, property) {
        if (property !== "binanceOrder") return Reflect.get(target, property);
        const model = Reflect.get(target, property) as object;
        return new Proxy(model, {
          get(modelTarget, modelProperty) {
            if (modelProperty === "updateMany") {
              return async () => {
                throw new Error("claim write failed");
              };
            }
            const value = Reflect.get(modelTarget, modelProperty);
            return typeof value === "function" ? value.bind(modelTarget) : value;
          },
        });
      },
    }) as typeof prisma;

  maybe()("1. the claim write failing dispatches ZERO external mutations", async () => {
    const execution = await filledExecution();
    const service = new ProtectionLifecycleService(
      claimFailingPrisma()!,
      readOnlyStub as never,
      mutationStub as never,
      alertService,
      { reconcileMaxAttempts: 2, reconcileDelayMs: 60_000 }
    );

    await expect(run(service, execution)).rejects.toThrow(/claim write failed/);

    // Fail-closed: the marker could not be persisted, so nothing was sent.
    expect(posts("STOP_LOSS")).toBe(0);
    expect(scenario.mutations).toHaveLength(0);
    expect((await stopOrderOf(execution.id)).submissionUnknownAt).toBeNull();
  });

  maybe()("2. two workers racing an unattempted intent produce at most one POST", async () => {
    const execution = await filledExecution();
    scenario.invisibleReads.set(buildClientOrderId(execution.id, "STOP_LOSS", 1), 999);
    const current = await reload(execution.id);

    await Promise.all([run(tolerant(), current), run(tolerant(), current)]);

    // Only one conditional update can match submissionUnknownAt: null.
    expect(posts("STOP_LOSS")).toBe(1);
    expect((await stopOrderOf(execution.id)).submissionUnknownAt).not.toBeNull();
    // The loser reconciled like a restarted worker: no alert, no park.
    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
  });

  maybe()("3. CASE D/E: accepted POST whose anchor never persisted is never re-POSTed", async () => {
    const execution = await filledExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    scenario.invisibleReads.set(stopId, 999);
    await run(tolerant(), execution);
    expect(posts("STOP_LOSS")).toBe(1);

    // The exact state a crash between the accepted response and the anchor
    // write leaves behind: the claim survived, the acceptance did not.
    const stop = await stopOrderOf(execution.id);
    await prisma!.binanceOrder.update({ where: { id: stop.id }, data: { submittedAt: null } });
    expect((await stopOrderOf(execution.id)).submissionUnknownAt).not.toBeNull();

    // Restart, still invisible — the shape that used to duplicate.
    const outcome = await run(tolerant(), await reload(execution.id));

    expect(outcome.reasonCode).toBe("STOP_SUBMISSION_PROPAGATION_PENDING");
    expect(posts("STOP_LOSS")).toBe(1);
    expect(scenario.algoOrders.has(stopId)).toBe(true); // the original is live
  });

  maybe()("4. CASE B: a claim with no POST behind it still refuses to submit", async () => {
    // The marker commits, then the process dies before the HTTP call. Whether
    // the request ever left is unprovable, so the conservative reading wins.
    const execution = await filledExecution();
    const service = new ProtectionLifecycleService(
      claimFailingPrisma()!,
      readOnlyStub as never,
      mutationStub as never,
      alertService,
      { reconcileMaxAttempts: 2, reconcileDelayMs: 60_000 }
    );
    // Reserves the tranche, then dies at the claim — no POST.
    await expect(run(service, execution)).rejects.toThrow(/claim write failed/);
    expect(posts("STOP_LOSS")).toBe(0);

    // Simulate the claim having committed just before the crash.
    const stop = await stopOrderOf(execution.id);
    await prisma!.binanceOrder.update({ where: { id: stop.id }, data: { submissionUnknownAt: at() } });
    scenario.invisibleReads.set(buildClientOrderId(execution.id, "STOP_LOSS", 1), 999);

    const deferred = await run(tolerant(), await reload(execution.id));
    expect(deferred.reasonCode).toBe("STOP_SUBMISSION_PROPAGATION_PENDING");
    expect(posts("STOP_LOSS")).toBe(0);

    // NO SILENT DEADLOCK: past the budget it becomes the truthful manual path,
    // still without a second mutation.
    const resolved = await run(expired(), await reload(execution.id));
    expect(resolved.reasonCode).toBe("STOP_SUBMISSION_RESULT_UNKNOWN");
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
    expect((await reload(execution.id)).requiresManualIntervention).toBe(true);
    expect(posts("STOP_LOSS")).toBe(0);
  });

  maybe()("5. CASE G: RESULT_UNKNOWN is never re-POSTed on a later tick", async () => {
    const execution = await filledExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    scenario.submitFailure = timeoutError("newAlgoOrder");
    scenario.submitLands = false;
    scenario.invisibleReads.set(stopId, 999);

    const first = await run(tolerant(), execution);
    // In-call RESULT_UNKNOWN semantics are untouched.
    expect(first.reasonCode).toBe("STOP_SUBMISSION_RESULT_UNKNOWN");
    expect((await stopOrderOf(execution.id)).submissionUnknownAt).not.toBeNull();
    expect(posts("STOP_LOSS")).toBe(1);

    // A later tick must not read the timeout as "nothing was sent".
    const second = await run(tolerant(), await reload(execution.id));

    expect(second.reasonCode).toBe("STOP_SUBMISSION_PROPAGATION_PENDING");
    expect(posts("STOP_LOSS")).toBe(1);
  });

  maybe()("6. the claim timestamp is never refreshed by later ticks", async () => {
    const execution = await filledExecution();
    scenario.invisibleReads.set(buildClientOrderId(execution.id, "STOP_LOSS", 1), 999);

    await run(tolerant(), execution);
    const claimed = (await stopOrderOf(execution.id)).submissionUnknownAt;
    expect(claimed).not.toBeNull();

    for (let tick = 0; tick < 3; tick += 1) {
      await run(tolerant(), await reload(execution.id));
    }

    expect((await stopOrderOf(execution.id)).submissionUnknownAt?.toISOString()).toBe(claimed?.toISOString());
    expect(posts("STOP_LOSS")).toBe(1);
  });

  maybe()("7. CONFIRMED_REJECTED stays conclusive and is not masked by the claim", async () => {
    const execution = await filledExecution();
    scenario.submitFailure = new BinanceError({
      kind: "REQUEST_INVALID",
      message: "rejected",
      binanceCode: -2021,
      endpoint: "algoOrder",
    });
    scenario.submitLands = false;

    const outcome = await run(tolerant(), execution);

    expect(outcome.reasonCode).toBe("STOP_SUBMISSION_REJECTED");
    const rejected = await stopOrderOf(execution.id);
    // The claim exists, but a rejected order is conclusively not live, so
    // rejection semantics stay authoritative rather than propagation-pending.
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.submissionUnknownAt).not.toBeNull();
    expect(rejected.submittedAt).toBeNull();
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
  });

  maybe()("8. a rejected identity is never stranded by the at-most-once ban", async () => {
    // The ban covers AMBIGUOUS attempts, not proven rejections. A REJECTED
    // order is conclusively not live, so it keeps the pre-existing semantics:
    // the lifecycle may act on that identity again rather than deferring on a
    // claim marker it can no longer win.
    const execution = await filledExecution();
    scenario.submitFailure = new BinanceError({
      kind: "REQUEST_INVALID",
      message: "rejected",
      binanceCode: -2021,
      endpoint: "algoOrder",
    });
    scenario.submitLands = false;
    await run(tolerant(), execution);
    const rejected = await stopOrderOf(execution.id);
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.submissionUnknownAt).not.toBeNull();
    expect(posts("STOP_LOSS")).toBe(1);

    // A later tick is NOT deferred as propagation-pending: the rejection is
    // authoritative, so the lifecycle proceeds instead of stalling.
    await prisma!.executionProtectionState.update({
      where: { tradeExecutionId: execution.id },
      data: { state: "MANUAL_INTERVENTION", reasonCode: "STOP_NOT_VERIFIED" },
    });
    const outcome = await tolerant().attemptProtectionRecovery({
      executionId: execution.id,
      expectedVersion: (await reload(execution.id)).version,
      evaluatedAt: at(),
    });

    expect(outcome.reasonCode).not.toBe("STOP_SUBMISSION_PROPAGATION_PENDING");
    expect(posts("STOP_LOSS")).toBeGreaterThan(1);
    // No generation rollover: gen 1 is still the incomplete tranche, so no new
    // identity was minted on the strength of an unobserved attempt.
    expect((await ordersOf(execution.id)).every((order) => order.generation === 1)).toBe(true);
  });

  maybe()("9. no new generation is minted merely because an attempt is unobserved", async () => {
    // The ambiguous identity keeps the tranche incomplete, so the generation
    // machinery never rolls over on the strength of "we could not see it".
    const execution = await filledExecution();
    scenario.invisibleReads.set(buildClientOrderId(execution.id, "STOP_LOSS", 1), 999);

    await run(tolerant(), execution);
    for (let tick = 0; tick < 3; tick += 1) {
      await run(expired(), await reload(execution.id));
    }

    const orders = await ordersOf(execution.id);
    expect(orders.every((order) => order.generation === 1)).toBe(true);
    expect(posts("STOP_LOSS")).toBe(1);
    // And it did not wait forever: it is parked for an operator.
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
  });
});

// ===========================================================================
// EMERGENCY CLOSE RESTS ON EVIDENCE, NOT ON ABSENCE OF IT.
//
// `measureVerifiedCoverage` counts an UNREADABLE leg as zero and names its role
// in `unresolved`. considerEmergencyClose used to consume only the number, so a
// transient query failure on a live covering STOP produced stop = "0",
// stopVerified = false, and — under ON_UNVERIFIED_STOP — a MARKET close of a
// fully protected position. It also asserted `reconciliationAttemptsExhausted:
// true` as a literal, which happened to be true only because of the call graph.
// ===========================================================================

describe("emergency close reconciliation evidence", () => {
  const withEmergencyMode = async <T>(mode: string, run: () => Promise<T>): Promise<T> => {
    const previous = runtimeEnv.EXECUTION_EMERGENCY_CLOSE_MODE;
    (runtimeEnv as { EXECUTION_EMERGENCY_CLOSE_MODE: string }).EXECUTION_EMERGENCY_CLOSE_MODE = mode;
    try {
      return await run();
    } finally {
      (runtimeEnv as { EXECUTION_EMERGENCY_CLOSE_MODE: string }).EXECUTION_EMERGENCY_CLOSE_MODE = previous;
    }
  };

  /**
   * A second tranche whose STOP is conclusively inactive, while generation 1's
   * STOP is still live and covering the whole position.
   */
  const twoGenerationsWithLiveStop = async () => {
    const execution = await filledExecution();
    await protect(execution); // generation 1: STOP + TP verified active
    const stop1 = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    const takeProfit1 = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);
    expect(scenario.algoOrders.get(stop1)?.algoStatus).toBe("NEW");
    return { execution, stop1, takeProfit1 };
  };

  maybe()("1. an UNREADABLE stop leg never authorizes a market close", async () => {
    // The dangerous shape, reached all the way into eligibility:
    //
    //   generation 1's STOP is LIVE and covers the position
    //   generation 2 is reserved because exposure grew
    //   generation 2's STOP lands CANCELED  -> STOP_NOT_VERIFIED, conclusive
    //   generation 1's STOP becomes unreadable at that instant
    //   -> measured.stop collapses to "0" while a stop is actually working
    //
    // Deciding on the number alone would market-close a protected position.
    const { execution, stop1 } = await twoGenerationsWithLiveStop();
    scenario.positionAmt = "0.200";

    // The failure is injected AT SUBMISSION so the reservation still happens:
    // advanceProtection's own unresolved guard would otherwise defer earlier
    // and this path would never be exercised.
    const originalSubmit = mutationStub.submitProtectionOrder;
    mutationStub.submitProtectionOrder = async (context: Record<string, string>) => {
      const result = await originalSubmit.call(mutationStub, context);
      if (context.role === "STOP_LOSS" && Number(context.generation) === 2) {
        const row = scenario.algoOrders.get(context.clientAlgoId);
        if (row) row.algoStatus = "CANCELED";
        scenario.queryFailures.add(stop1);
      }
      return result;
    };

    const outcome = await withEmergencyMode("ON_UNVERIFIED_STOP", async () =>
      protectionService.ensureProtectionForExposure({
        executionId: execution.id,
        expectedVersion: (await reload(execution.id)).version,
        evaluatedAt: at(),
      })
    );
    mutationStub.submitProtectionOrder = originalSubmit;

    // Zero market closes: unreadable is not proof of an unprotected position.
    expect(scenario.mutations.filter((call) => call.includes("MARKET"))).toHaveLength(0);
    expect(await emergencyOrdersOf(execution.id)).toBe(0);
    expect((await reload(execution.id)).status).not.toBe("CLOSED_EMERGENCY");
    // It fails closed onto the existing manual path instead.
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
    expect(outcome.ok).toBe(false);
  });

  /** Makes the submitted STOP land already in the given algo status. */
  const landStopWith = (algoStatus: string) => {
    const original = mutationStub.submitProtectionOrder;
    mutationStub.submitProtectionOrder = async (context: Record<string, string>) => {
      const result = await original.call(mutationStub, context);
      if (context.role === "STOP_LOSS") {
        const row = scenario.algoOrders.get(context.clientAlgoId);
        if (row) row.algoStatus = algoStatus;
      }
      return result;
    };
    return () => {
      mutationStub.submitProtectionOrder = original;
    };
  };

  const emergencyOrdersOf = async (id: string) =>
    prisma!.binanceOrder.count({ where: { tradeExecutionId: id, role: "EMERGENCY_CLOSE" } });

  maybe()("2. a conclusively inactive stop with readable coverage stays eligible", async () => {
    // The opposite proof: emergency close must not become impossible.
    const execution = await filledExecution();
    const restore = landStopWith("CANCELED"); // authoritative, and readable

    await withEmergencyMode("ON_UNVERIFIED_STOP", async () =>
      protectionService.ensureProtectionForExposure({
        executionId: execution.id,
        expectedVersion: execution.version,
        evaluatedAt: at(),
      })
    );
    restore();

    // The last resort remains available on authoritative evidence, even though
    // no reconciliation attempt was ever spent.
    expect(await emergencyOrdersOf(execution.id)).toBe(1);
  });

  maybe()("3. DISABLED mode never mutates however conclusive the failure", async () => {
    const execution = await filledExecution();
    const restore = landStopWith("CANCELED");

    await withEmergencyMode("DISABLED", async () =>
      protectionService.ensureProtectionForExposure({
        executionId: execution.id,
        expectedVersion: execution.version,
        evaluatedAt: at(),
      })
    );
    restore();

    expect(await emergencyOrdersOf(execution.id)).toBe(0);
    expect(scenario.mutations.filter((call) => call.includes("MARKET"))).toHaveLength(0);
    // Parked for a human instead.
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
  });

  maybe()("4. an UNPARSEABLE stop status is not conclusive evidence", async () => {
    // `normalizeAlgoStatus` reports an unrecognised token as UNKNOWN precisely
    // because it refuses to guess. That reaches the same STOP_NOT_VERIFIED
    // reason code as a conclusive CANCELED, so the observation itself — not the
    // reason code — has to decide.
    const execution = await filledExecution();
    const restore = landStopWith("SOMETHING_NEW");

    await withEmergencyMode("ON_UNVERIFIED_STOP", async () =>
      protectionService.ensureProtectionForExposure({
        executionId: execution.id,
        expectedVersion: execution.version,
        evaluatedAt: at(),
      })
    );
    restore();

    expect(await emergencyOrdersOf(execution.id)).toBe(0);
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
  });

  maybe()("5. a temporary post-submit visibility gap can never emergency close", async () => {
    // The propagation fix stays load-bearing: an accepted STOP that is briefly
    // invisible defers before emergency close is even considered.
    const execution = await filledExecution();
    const service = new ProtectionLifecycleService(
      prisma!,
      readOnlyStub as never,
      mutationStub as never,
      alertService,
      { reconcileMaxAttempts: 2, reconcileDelayMs: 60_000 }
    );
    scenario.invisibleReads.set(buildClientOrderId(execution.id, "STOP_LOSS", 1), 999);

    const outcome = await withEmergencyMode("ON_UNVERIFIED_STOP", async () =>
      service.ensureProtectionForExposure({
        executionId: execution.id,
        expectedVersion: execution.version,
        evaluatedAt: at(),
      })
    );

    expect(outcome.reasonCode).toBe("STOP_SUBMISSION_PROPAGATION_PENDING");
    expect(await prisma!.binanceOrder.count({
      where: { tradeExecutionId: execution.id, role: "EMERGENCY_CLOSE" },
    })).toBe(0);
    expect((await reload(execution.id)).status).not.toBe("MANUAL_INTERVENTION");
    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
  });
});

// ===========================================================================
// AN EXECUTING STOP IS NOT A FAILED STOP.
//
// TRIGGERED means the trigger fired and the resulting order is working the
// book; PARTIALLY_FILLED means it is working and has already closed part of
// the position. Neither counts as ACTIVE coverage, so both used to arrive as
// STOP_NOT_VERIFIED — the same verdict as a CANCELED stop. Under
// ON_UNVERIFIED_STOP that authorized a competing MARKET close against our own
// executing protection, and `classifyClosure` checks emergencyFilled BEFORE
// stopFired, so the exit would have been recorded CLOSED_EMERGENCY when the
// STOP is what actually closed it.
//
// Both states are now deferred: there is nothing to do but look again.
// ===========================================================================

describe("executing stop deferral", () => {
  const emergencyOrders = async (id: string) =>
    prisma!.binanceOrder.count({ where: { tradeExecutionId: id, role: "EMERGENCY_CLOSE" } });

  const stopOrdersOf = async (id: string) =>
    prisma!.binanceOrder.findMany({ where: { tradeExecutionId: id, role: "STOP_LOSS" } });

  const withEmergencyOn = async <T>(run: () => Promise<T>): Promise<T> => {
    const previous = runtimeEnv.EXECUTION_EMERGENCY_CLOSE_MODE;
    (runtimeEnv as { EXECUTION_EMERGENCY_CLOSE_MODE: string }).EXECUTION_EMERGENCY_CLOSE_MODE = "ON_UNVERIFIED_STOP";
    try {
      return await run();
    } finally {
      (runtimeEnv as { EXECUTION_EMERGENCY_CLOSE_MODE: string }).EXECUTION_EMERGENCY_CLOSE_MODE = previous;
    }
  };

  /**
   * A protected execution whose STOP is then observed in `algoStatus`, with the
   * take profit left unresolved so the tranche stays incomplete and the STOP is
   * re-verified on the next tick — the reachable shape from the audit.
   */
  const stopObservedAs = async (algoStatus: string) => {
    const execution = await filledExecution();
    const takeProfitId = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);
    // The TP never resolves, so generation 1 stays incomplete and the STOP is
    // looked at again rather than a new generation being minted.
    scenario.queryFailures.add(takeProfitId);
    await protect(execution);
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    scenario.algoOrders.get(stopId)!.algoStatus = algoStatus;
    return { execution, stopId, takeProfitId };
  };

  const tick = async (id: string) =>
    protectionService.ensureProtectionForExposure({
      executionId: id,
      expectedVersion: (await reload(id)).version,
      evaluatedAt: at(),
    });

  maybe()("1. a TRIGGERED stop defers instead of emergency closing", async () => {
    const { execution, stopId } = await stopObservedAs("TRIGGERED");
    const stopsBefore = (await stopOrdersOf(execution.id)).length;

    const outcome = await withEmergencyOn(() => tick(execution.id));

    expect(outcome.reasonCode).toBe("STOP_EXECUTION_IN_PROGRESS");
    expect(await emergencyOrders(execution.id)).toBe(0);
    expect(scenario.mutations.filter((call) => call.includes("MARKET"))).toHaveLength(0);
    const after = await reload(execution.id);
    expect(after.status).not.toBe("MANUAL_INTERVENTION");
    expect(after.status).not.toBe("CLOSED_EMERGENCY");
    expect(after.requiresManualIntervention).toBe(false);
    // The owned identity is untouched: no replacement, no new generation.
    const stops = await stopOrdersOf(execution.id);
    expect(stops).toHaveLength(stopsBefore);
    expect(stops[0].clientAlgoId).toBe(stopId);
    // Nothing was cancelled to simplify the lifecycle either.
    expect(scenario.mutations.filter((call) => call.startsWith("DELETE"))).toHaveLength(0);
    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
  });

  maybe()("2. a PARTIALLY_FILLED stop defers instead of emergency closing", async () => {
    const { execution, stopId } = await stopObservedAs("PARTIALLY_FILLED");

    const outcome = await withEmergencyOn(() => tick(execution.id));

    expect(outcome.reasonCode).toBe("STOP_EXECUTION_IN_PROGRESS");
    expect(await emergencyOrders(execution.id)).toBe(0);
    const after = await reload(execution.id);
    expect(after.status).not.toBe("MANUAL_INTERVENTION");
    expect(after.requiresManualIntervention).toBe(false);
    // No replacement stop for the coverage that PARTIALLY_FILLED does not count.
    const stops = await stopOrdersOf(execution.id);
    expect(stops).toHaveLength(1);
    expect(stops[0].clientAlgoId).toBe(stopId);
  });

  maybe()("3. ATTRIBUTION: TRIGGERED then FILLED and flat closes as CLOSED_SL", async () => {
    // The race that motivated this branch, end to end.
    const { execution, stopId } = await stopObservedAs("TRIGGERED");
    await withEmergencyOn(() => tick(execution.id));
    expect(await emergencyOrders(execution.id)).toBe(0);

    // The stop completes and the position is flat.
    scenario.algoOrders.get(stopId)!.algoStatus = "FILLED";
    scenario.algoOrders.get(stopId)!.executedQty = "0.100";
    scenario.algoOrders.get(stopId)!.avgPrice = "96";
    // Flat as a zero-quantity row: a MISSING row is the closure-first path's
    // business, and calling the health entry point directly would hit the
    // documented POSITION_NOT_FOUND_AFTER_FILL escalation instead.
    scenario.positionAmt = "0";
    scenario.queryFailures.clear();

    await withEmergencyOn(() => tick(execution.id));

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_SL");
    expect(closed.status).not.toBe("CLOSED_EMERGENCY");
    // The exit was never stolen by an emergency order, because none exists.
    expect(await emergencyOrders(execution.id)).toBe(0);
    expect(closed.exitReason).toBe("STOP_LOSS");
  });

  maybe()("4. PARTIALLY_FILLED then FILLED and flat also closes as CLOSED_SL", async () => {
    const { execution, stopId } = await stopObservedAs("PARTIALLY_FILLED");
    await withEmergencyOn(() => tick(execution.id));

    scenario.algoOrders.get(stopId)!.algoStatus = "FILLED";
    // Flat as a zero-quantity row: a MISSING row is the closure-first path's
    // business, and calling the health entry point directly would hit the
    // documented POSITION_NOT_FOUND_AFTER_FILL escalation instead.
    scenario.positionAmt = "0";
    scenario.queryFailures.clear();

    await withEmergencyOn(() => tick(execution.id));

    expect((await reload(execution.id)).status).toBe("CLOSED_SL");
    expect(await emergencyOrders(execution.id)).toBe(0);
  });

  maybe()("5. TRIGGERED then CANCELED with exposure remaining resumes real failure handling", async () => {
    // The deferral is not a trap: it lasts exactly as long as the exchange
    // keeps reporting an executing order.
    const { execution, stopId } = await stopObservedAs("TRIGGERED");
    const deferred = await withEmergencyOn(() => tick(execution.id));
    expect(deferred.reasonCode).toBe("STOP_EXECUTION_IN_PROGRESS");
    expect(await emergencyOrders(execution.id)).toBe(0);

    // It ends up cancelled while the position is still open.
    scenario.algoOrders.get(stopId)!.algoStatus = "CANCELED";

    await withEmergencyOn(() => tick(execution.id));

    // Authoritative failure: the last resort becomes available again.
    expect(await emergencyOrders(execution.id)).toBe(1);
  });

  maybe()("6. an executing stop whose query turns UNKNOWN still fails closed", async () => {
    const { execution, stopId } = await stopObservedAs("TRIGGERED");
    await withEmergencyOn(() => tick(execution.id));

    // The leg becomes unreadable: absence of evidence, not evidence of failure.
    scenario.queryFailures.add(stopId);

    const outcome = await withEmergencyOn(() => tick(execution.id));

    expect(outcome.reasonCode).toBe("STOP_QUERY_UNAVAILABLE");
    expect(await emergencyOrders(execution.id)).toBe(0);
    expect((await reload(execution.id)).status).not.toBe("CLOSED_EMERGENCY");
  });

  maybe()("7. a TRIGGERED stop decides the tick even while the take profit is UNKNOWN", async () => {
    // The TP is already unreadable in this fixture; the STOP's executing state
    // is what the outcome reports, and no emergency close occurs.
    const { execution } = await stopObservedAs("TRIGGERED");

    const outcome = await withEmergencyOn(() => tick(execution.id));

    expect(outcome.reasonCode).toBe("STOP_EXECUTION_IN_PROGRESS");
    expect(await emergencyOrders(execution.id)).toBe(0);
  });

  maybe()("8. an unparseable algo status is still not treated as executing", async () => {
    const { execution } = await stopObservedAs("SOMETHING_NEW");

    const outcome = await withEmergencyOn(() => tick(execution.id));

    // UNKNOWN keeps its own fail-closed semantics rather than borrowing the
    // executing deferral.
    expect(outcome.reasonCode).not.toBe("STOP_EXECUTION_IN_PROGRESS");
    expect(await emergencyOrders(execution.id)).toBe(0);
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
  });
});

// ===========================================================================
// EMERGENCY CLOSE KNOWS WHAT IT IS CLOSING.
//
// `positionIdentityKnown: true` and `confirmedOpenQuantity` both came from an
// observation taken at the TOP of ensureProtectionForExposure — before a
// coverage measurement, a tranche reservation, the protection POST and its
// bounded re-query loop. Seconds and many round-trips later that number was
// presented as current. If the owned STOP filled in that window, the position
// was already flat while eligibility still read "0.1 LONG is open".
//
// Identity is now proven from a fresh read at eligibility, and proven AGAIN
// immediately before the market order — which is also where the close quantity
// comes from.
// ===========================================================================

describe("emergency close position identity", () => {
  const emergencyOrders = async (id: string) =>
    prisma!.binanceOrder.count({ where: { tradeExecutionId: id, role: "EMERGENCY_CLOSE" } });

  const marketCloses = () => scenario.mutations.filter((call) => call.includes("MARKET"));

  const withEmergencyOn = async <T>(run: () => Promise<T>): Promise<T> => {
    const previous = runtimeEnv.EXECUTION_EMERGENCY_CLOSE_MODE;
    (runtimeEnv as { EXECUTION_EMERGENCY_CLOSE_MODE: string }).EXECUTION_EMERGENCY_CLOSE_MODE = "ON_UNVERIFIED_STOP";
    try {
      return await run();
    } finally {
      (runtimeEnv as { EXECUTION_EMERGENCY_CLOSE_MODE: string }).EXECUTION_EMERGENCY_CLOSE_MODE = previous;
    }
  };

  /**
   * Drives a conclusively CANCELED stop, which is the one shape that reaches
   * emergency-close eligibility with authoritative failure evidence.
   */
  const conclusivelyFailedStop = async (direction: "LONG" | "SHORT" = "LONG") => {
    const execution = await filledExecution({ direction });
    const original = mutationStub.submitProtectionOrder;
    mutationStub.submitProtectionOrder = async (context: Record<string, string>) => {
      const result = await original.call(mutationStub, context);
      if (context.role === "STOP_LOSS") {
        const row = scenario.algoOrders.get(context.clientAlgoId);
        if (row) row.algoStatus = "CANCELED";
      }
      return result;
    };
    return {
      execution,
      restore: () => {
        mutationStub.submitProtectionOrder = original;
      },
    };
  };

  const run = async (id: string, version: number) =>
    protectionService.ensureProtectionForExposure({
      executionId: id,
      expectedVersion: version,
      evaluatedAt: at(),
    });

  maybe()("1. a valid LONG identity still reaches the market close", async () => {
    const { execution, restore } = await conclusivelyFailedStop("LONG");

    await withEmergencyOn(() => run(execution.id, execution.version));
    restore();

    expect(await emergencyOrders(execution.id)).toBe(1);
    expect(marketCloses()).toHaveLength(1);
    // SELL against the LONG hedge leg, sized from the live position.
    expect(marketCloses()[0]).toContain("0.1");
    const order = await prisma!.binanceOrder.findFirstOrThrow({
      where: { tradeExecutionId: execution.id, role: "EMERGENCY_CLOSE" },
    });
    expect(order.side).toBe("SELL");
    expect(order.positionSide).toBe("LONG");
  });

  maybe()("2. a valid SHORT identity still reaches the market close", async () => {
    scenario.positionAmt = "-0.100"; // Binance reports a SHORT as negative
    const { execution, restore } = await conclusivelyFailedStop("SHORT");

    await withEmergencyOn(() => run(execution.id, execution.version));
    restore();

    expect(await emergencyOrders(execution.id)).toBe(1);
    const order = await prisma!.binanceOrder.findFirstOrThrow({
      where: { tradeExecutionId: execution.id, role: "EMERGENCY_CLOSE" },
    });
    expect(order.side).toBe("BUY");
    expect(order.positionSide).toBe("SHORT");
    expect(order.originalQuantity.toString()).toBe("0.1");
  });

  maybe()("3. the position going FLAT after eligibility sends nothing", async () => {
    // THE LOAD-BEARING RACE. Reads: (1) ensureProtectionForExposure,
    // (2) eligibility, (3) the final pre-mutation check. The stop fills between
    // 2 and 3, so only a revalidation at the mutation boundary can catch it —
    // this fails if eligibility is the only fresh read.
    const { execution, restore } = await conclusivelyFailedStop("LONG");
    scenario.positionAmtSequence = ["0.100", "0.100", "0"];
    scenario.positionAmt = "0";

    await withEmergencyOn(() => run(execution.id, execution.version));
    restore();

    expect(marketCloses()).toHaveLength(0);
    // No durable intent either: nothing was ever reserved for a call that
    // refused to submit.
    expect(await emergencyOrders(execution.id)).toBe(0);
    expect((await reload(execution.id)).status).not.toBe("CLOSED_EMERGENCY");
  });

  maybe()("4. the position SHRINKING after eligibility closes the smaller size", async () => {
    const { execution, restore } = await conclusivelyFailedStop("LONG");
    scenario.positionAmtSequence = ["0.100", "0.100", "0.040"];
    scenario.positionAmt = "0.040";

    await withEmergencyOn(() => run(execution.id, execution.version));
    restore();

    expect(marketCloses()).toHaveLength(1);
    // The CURRENT size, never the remembered 0.1.
    expect(marketCloses()[0]).toContain("0.04");
    expect(marketCloses()[0]).not.toContain("0.1");
    const order = await prisma!.binanceOrder.findFirstOrThrow({
      where: { tradeExecutionId: execution.id, role: "EMERGENCY_CLOSE" },
    });
    expect(order.originalQuantity.toString()).toBe("0.04");
  });

  maybe()("5. a SHORT position shrinking also closes the smaller size", async () => {
    scenario.positionAmt = "-0.100";
    const { execution, restore } = await conclusivelyFailedStop("SHORT");
    scenario.positionAmtSequence = ["-0.100", "-0.100", "-0.030"];
    scenario.positionAmt = "-0.030";

    await withEmergencyOn(() => run(execution.id, execution.version));
    restore();

    expect(marketCloses()).toHaveLength(1);
    expect(marketCloses()[0]).toContain("0.03");
  });

  maybe()("6. an identity that turns CONTRADICTORY before the mutation sends nothing", async () => {
    // The sign flips to the opposite hedge leg between eligibility and the
    // mutation: we must never close someone else's side.
    const { execution, restore } = await conclusivelyFailedStop("LONG");
    scenario.positionAmtSequence = ["0.100", "0.100", "-0.100"];
    scenario.positionAmt = "-0.100";

    await withEmergencyOn(() => run(execution.id, execution.version));
    restore();

    expect(marketCloses()).toHaveLength(0);
    expect(await emergencyOrders(execution.id)).toBe(0);
  });

  maybe()("7. an UNREADABLE final position read sends nothing", async () => {
    const { execution, restore } = await conclusivelyFailedStop("LONG");
    const originalRead = readOnlyStub.getPositionForSide;
    let reads = 0;
    readOnlyStub.getPositionForSide = async (symbol: string, positionSide: string) => {
      reads += 1;
      if (reads >= 3) throw timeoutError("positionRisk");
      return originalRead.call(readOnlyStub, symbol, positionSide);
    };

    await withEmergencyOn(() => run(execution.id, execution.version));
    readOnlyStub.getPositionForSide = originalRead;
    restore();

    // Absence of position evidence is never permission to close.
    expect(marketCloses()).toHaveLength(0);
    expect(await emergencyOrders(execution.id)).toBe(0);
  });

  maybe()("8. a MISSING position row before eligibility sends nothing", async () => {
    const { execution, restore } = await conclusivelyFailedStop("LONG");
    const originalRead = readOnlyStub.getPositionForSide;
    let reads = 0;
    readOnlyStub.getPositionForSide = async (symbol: string, positionSide: string) => {
      reads += 1;
      if (reads >= 2) return null; // a real exchange reports flat as no row
      return originalRead.call(readOnlyStub, symbol, positionSide);
    };

    await withEmergencyOn(() => run(execution.id, execution.version));
    readOnlyStub.getPositionForSide = originalRead;
    restore();

    expect(marketCloses()).toHaveLength(0);
    expect(await emergencyOrders(execution.id)).toBe(0);
  });

  maybe()("9. ATTRIBUTION: the stop that filled during the window still wins", async () => {
    // The whole point of refusing the stale close: the owned STOP closed this
    // position, so closure must record CLOSED_SL rather than CLOSED_EMERGENCY.
    const execution = await filledExecution();
    const stopId = buildClientOrderId(execution.id, "STOP_LOSS", 1);
    const original = mutationStub.submitProtectionOrder;
    mutationStub.submitProtectionOrder = async (context: Record<string, string>) => {
      const result = await original.call(mutationStub, context);
      if (context.role === "STOP_LOSS") {
        const row = scenario.algoOrders.get(context.clientAlgoId);
        if (row) row.algoStatus = "CANCELED";
      }
      return result;
    };
    scenario.positionAmtSequence = ["0.100", "0.100", "0"];
    scenario.positionAmt = "0";

    await withEmergencyOn(() => run(execution.id, execution.version));
    mutationStub.submitProtectionOrder = original;
    expect(await emergencyOrders(execution.id)).toBe(0);

    // The stop is now reported filled and the position stays flat.
    scenario.algoOrders.get(stopId)!.algoStatus = "FILLED";
    scenario.algoOrders.get(stopId)!.avgPrice = "96";
    const nextVersion = (await reload(execution.id)).version;
    await withEmergencyOn(() => run(execution.id, nextVersion));

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_SL");
    expect(closed.status).not.toBe("CLOSED_EMERGENCY");
    expect(await emergencyOrders(execution.id)).toBe(0);
  });

  maybe()("10. DISABLED mode still sends nothing with a perfectly valid identity", async () => {
    const { execution, restore } = await conclusivelyFailedStop("LONG");

    const previous = runtimeEnv.EXECUTION_EMERGENCY_CLOSE_MODE;
    (runtimeEnv as { EXECUTION_EMERGENCY_CLOSE_MODE: string }).EXECUTION_EMERGENCY_CLOSE_MODE = "DISABLED";
    await run(execution.id, execution.version);
    (runtimeEnv as { EXECUTION_EMERGENCY_CLOSE_MODE: string }).EXECUTION_EMERGENCY_CLOSE_MODE = previous;
    restore();

    expect(marketCloses()).toHaveLength(0);
    expect(await emergencyOrders(execution.id)).toBe(0);
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
  });
});

// ===========================================================================
// A VERIFIED OWNED CLOSURE RELEASES THE MANUAL-INTERVENTION FLAG.
//
// The owned-attribution branch committed the terminal status, the exit reason
// and the exit price but never cleared `requiresManualIntervention`, while the
// WEAKER CLOSED_EXTERNAL branch beside it always has. A trade that had been
// parked at any point therefore stayed in recoveryRequiredCount forever after
// closing perfectly.
//
// The real COWUSDT Mainnet canary ended exactly there: CLOSED_SL, exitReason
// STOP_LOSS, Binance flat and clean — and recoveryRequiredCount 1, which
// blocks every later canary.
// ===========================================================================

describe("terminal owned closure clears manual intervention", () => {
  /** A protected execution carrying a stale flag from an earlier incident. */
  const flaggedProtected = async () => {
    const execution = await filledExecution();
    await protect(execution);
    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { requiresManualIntervention: true, version: { increment: 1 } },
    });
    return reload(execution.id);
  };

  const fillOwned = (executionId: string, role: "STOP_LOSS" | "TAKE_PROFIT") => {
    const id = buildClientOrderId(executionId, role, 1);
    const row = scenario.algoOrders.get(id)!;
    row.algoStatus = "FILLED";
    row.executedQty = "0.100";
    row.avgPrice = role === "STOP_LOSS" ? "96" : "108";
    scenario.positionAmt = "0";
  };

  const reconcile = async (execution: { id: string; version: number }) =>
    protectionService.reconcileProtectionAndClosure({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: at(),
    });

  maybe()("1. an owned STOP fill closes as CLOSED_SL and clears the flag", async () => {
    const parked = await flaggedProtected();
    expect(parked.requiresManualIntervention).toBe(true);
    fillOwned(parked.id, "STOP_LOSS");

    const outcome = await reconcile(parked);

    expect(outcome.ok).toBe(true);
    const closed = await reload(parked.id);
    expect(closed.status).toBe("CLOSED_SL");
    expect(closed.exitReason).toBe("STOP_LOSS");
    // The canary's exact defect.
    expect(closed.requiresManualIntervention).toBe(false);
    expect((await protectionOf(parked.id)).state).toBe("CLOSED");
  });

  maybe()("2. an owned TP fill closes as CLOSED_TP and clears the flag", async () => {
    const parked = await flaggedProtected();
    fillOwned(parked.id, "TAKE_PROFIT");

    const outcome = await reconcile(parked);

    expect(outcome.ok).toBe(true);
    const closed = await reload(parked.id);
    expect(closed.status).toBe("CLOSED_TP");
    expect(closed.exitReason).toBe("TAKE_PROFIT");
    expect(closed.requiresManualIntervention).toBe(false);
  });

  maybe()("3. an owned emergency fill closes as CLOSED_EMERGENCY and clears the flag", async () => {
    // Emergency shares the same conclusively-verified terminal commit, so it
    // clears the flag on the same evidence.
    const parked = await flaggedProtected();
    await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: parked.id,
        role: "EMERGENCY_CLOSE",
        generation: 1,
        clientOrderId: buildClientOrderId(parked.id, "EMERGENCY_CLOSE", 1),
        side: "SELL",
        positionSide: "LONG",
        orderType: "MARKET",
        originalQuantity: "0.100",
        executedQuantity: "0.100",
        status: "FILLED",
      },
    });
    scenario.positionAmt = "0";

    const outcome = await reconcile(parked);

    expect(outcome.ok).toBe(true);
    const closed = await reload(parked.id);
    expect(closed.status).toBe("CLOSED_EMERGENCY");
    expect(closed.exitReason).toBe("EMERGENCY");
    expect(closed.requiresManualIntervention).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Fail-closed: the flag survives anything short of a proven terminal closure
  // -------------------------------------------------------------------------

  maybe()("4. exposure still open keeps the flag set and terminalizes nothing", async () => {
    const parked = await flaggedProtected();
    // The stop fired but the position is NOT flat: a partial protection exit.
    const stopId = buildClientOrderId(parked.id, "STOP_LOSS", 1);
    scenario.algoOrders.get(stopId)!.algoStatus = "FILLED";
    scenario.positionAmt = "0.100";

    const outcome = await reconcile(parked);

    expect(outcome.ok).toBe(false);
    const after = await reload(parked.id);
    expect(after.status).not.toBe("CLOSED_SL");
    expect(after.requiresManualIntervention).toBe(true);
  });

  maybe()("5. an UNKNOWN sibling observation keeps the flag set", async () => {
    const parked = await flaggedProtected();
    fillOwned(parked.id, "STOP_LOSS");
    // The take profit cannot be read, so cleanup is unresolved: absence of
    // evidence must not terminalize or release the flag.
    scenario.queryFailures.add(buildClientOrderId(parked.id, "TAKE_PROFIT", 1));

    const outcome = await reconcile(parked);

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("SIBLING_CLEANUP_INCOMPLETE");
    const after = await reload(parked.id);
    expect(after.status).not.toBe("CLOSED_SL");
    expect(after.requiresManualIntervention).toBe(true);
  });

  maybe()("6. a lost version CAS keeps the flag set and writes nothing", async () => {
    const parked = await flaggedProtected();
    fillOwned(parked.id, "STOP_LOSS");

    const outcome = await protectionService.reconcileProtectionAndClosure({
      executionId: parked.id,
      expectedVersion: parked.version - 1, // deliberately stale
      evaluatedAt: at(),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("CAPACITY_OR_VERSION_CONFLICT");
    const after = await reload(parked.id);
    expect(after.status).not.toBe("CLOSED_SL");
    expect(after.requiresManualIntervention).toBe(true);
  });

  maybe()("7. an unattributable flat close still terminalizes as CLOSED_EXTERNAL", async () => {
    // Documents the neighbouring branch that already cleared the flag: flat
    // with no owned fill is weaker evidence, yet still terminal.
    const parked = await flaggedProtected();
    scenario.algoOrders.delete(buildClientOrderId(parked.id, "STOP_LOSS", 1));
    scenario.algoOrders.delete(buildClientOrderId(parked.id, "TAKE_PROFIT", 1));
    scenario.positionAmt = "0";

    const outcome = await reconcile(parked);

    expect(outcome.ok).toBe(true);
    const closed = await reload(parked.id);
    expect(closed.status).toBe("CLOSED_EXTERNAL");
    expect(closed.requiresManualIntervention).toBe(false);
    // No fabricated attribution.
    expect(closed.exitReason).toBe("EXTERNAL");
    expect(closed.actualExitPrice).toBeNull();
  });
});

// ===========================================================================
// A WORKING-TYPE POLICY CHANGE IS NOT RETROACTIVE.
//
// `reserveNextTranche` FREEZES the resolved working type onto each protection
// intent, and both the submission and the identity comparator read that
// persisted value — never the current default. So flipping the stop policy from
// MARK_PRICE to CONTRACT_PRICE governs new generations only: a generation
// created before the change keeps its own identity and stays ours.
//
// The demo verifier is deliberately different — it re-resolves from the current
// policy on every run and persists no working type — which is why its fixtures
// track the policy while these do not.
// ===========================================================================

describe("working-type policy is not retroactive", () => {
  const stopOf = async (id: string) =>
    prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: id, role: "STOP_LOSS" } });

  const stopPosts = () => scenario.submitted.filter((entry) => entry.role === "STOP_LOSS");

  /**
   * A protected execution whose take profit stays unreadable, so generation 1
   * remains incomplete and its STOP is re-verified on the next tick — which is
   * where the identity comparator runs.
   */
  const protectedWithUnreadableTakeProfit = async () => {
    const execution = await filledExecution();
    scenario.queryFailures.add(buildClientOrderId(execution.id, "TAKE_PROFIT", 1));
    await protect(execution);
    return { execution, stopId: buildClientOrderId(execution.id, "STOP_LOSS", 1) };
  };

  const tick = async (id: string) =>
    protectionService.ensureProtectionForExposure({
      executionId: id,
      expectedVersion: (await reload(id)).version,
      evaluatedAt: at(),
    });

  // "A NEW generation uses the current policy" is already proven by
  // `protection parameters > freezes the working types into the local intent`.

  maybe()("2. a STOP persisted under the OLD policy is still recognized as ours", async () => {
    const { execution, stopId } = await protectedWithUnreadableTakeProfit();

    // Rewrite generation 1 to look like a pre-deployment order: the intent was
    // frozen as MARK_PRICE and Binance echoes MARK_PRICE, while the current
    // default is now CONTRACT_PRICE.
    await prisma!.binanceOrder.update({
      where: { id: (await stopOf(execution.id)).id },
      data: { workingType: "MARK_PRICE" },
    });
    scenario.algoOrders.get(stopId)!.workingType = "MARK_PRICE";
    const postsBefore = stopPosts().length;

    const outcome = await tick(execution.id);

    // The comparator judged it against its OWN frozen value, so there is no
    // mismatch and no escalation.
    expect(outcome.reasonCode).not.toBe("STOP_IDENTITY_MISMATCH");
    const after = await reload(execution.id);
    expect(after.status).not.toBe("MANUAL_INTERVENTION");
    expect(after.requiresManualIntervention).toBe(false);
    // Still ours: adopted, never replaced or re-submitted.
    expect(stopPosts()).toHaveLength(postsBefore);
    expect((await stopOf(execution.id)).workingType).toBe("MARK_PRICE");
    expect((await ordersOf(execution.id)).every((order) => order.generation === 1)).toBe(true);
  });

  maybe()("3. verification is NOT weakened: a readback that contradicts the frozen intent still fails", async () => {
    // Same shape, but only the EXCHANGE is rewritten. The frozen intent still
    // says CONTRACT_PRICE, so the observed MARK_PRICE is a genuine mismatch.
    const { execution, stopId } = await protectedWithUnreadableTakeProfit();
    scenario.algoOrders.get(stopId)!.workingType = "MARK_PRICE";

    const outcome = await tick(execution.id);

    expect(outcome.reasonCode).toBe("STOP_IDENTITY_MISMATCH");
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
  });
});

describe("stale unsubmitted protection intent", () => {
  const tpIdOf = (id: string, generation: number) => buildClientOrderId(id, "TAKE_PROFIT", generation);
  const stopIdOf = (id: string, generation: number) => buildClientOrderId(id, "STOP_LOSS", generation);

  const tick = async (id: string) =>
    protectionService.ensureProtectionForExposure({
      executionId: id,
      expectedVersion: (await reload(id)).version,
      evaluatedAt: at(),
    });

  const takeProfitPosts = () =>
    scenario.submitted.filter((entry) => entry.role === "TAKE_PROFIT").map((entry) => entry.quantity);

  const rowOf = async (id: string, role: string, generation: number) =>
    prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: id, role: role as "TAKE_PROFIT", generation } });

  const refreshEvents = async (id: string) =>
    prisma!.executionEvent.findMany({
      where: { tradeExecutionId: id, eventType: "ORDER_UPDATED" },
      orderBy: { sequenceNumber: "asc" },
    });

  /**
   * The genuine current-main shape: a take-profit-only generation is reserved
   * for the whole gap, and take-profit coverage that was not visible then
   * becomes visible before its first POST. The stop still covers the exposure
   * exactly, so nothing above the barrier refuses and the frozen quantity is
   * simply too large.
   */
  async function staleTakeProfitIntent(options: { covering?: string; reserved?: string } = {}) {
    const execution = await filledExecution();
    await protect(execution);
    // Coverage that appeared after the tranche was reserved.
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.quantity = options.covering ?? "0.060";
    const first = await rowOf(execution.id, "TAKE_PROFIT", 1);
    await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id,
        role: "TAKE_PROFIT",
        generation: 2,
        clientOrderId: tpIdOf(execution.id, 2),
        clientAlgoId: tpIdOf(execution.id, 2),
        side: first.side,
        positionSide: first.positionSide,
        orderType: "TAKE_PROFIT_MARKET",
        originalQuantity: options.reserved ?? "0.100",
        triggerPrice: first.triggerPrice,
        workingType: first.workingType,
        priceProtect: first.priceProtect,
        status: "SUBMITTING",
      },
    });
    scenario.submitted = [];
    scenario.mutations = [];
    return execution;
  }

  const clearAlerts = async (id: string) =>
    prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: id } });

  maybe()("1/2. the stale quantity is never sent, and the current gap is", async () => {
    const execution = await staleTakeProfitIntent();

    await tick(execution.id);

    expect(takeProfitPosts()).toEqual(["0.04"]);
    expect(takeProfitPosts()).not.toContain("0.1");
    await clearAlerts(execution.id);
  });

  maybe()("3. the revision is journalled with both quantities", async () => {
    const execution = await staleTakeProfitIntent();

    await tick(execution.id);

    const events = await refreshEvents(execution.id);
    expect(events).toHaveLength(1);
    const metadata = events[0]!.metadata as Record<string, unknown>;
    expect(metadata.previousQuantity).toBe("0.1");
    expect(metadata.revisedQuantity).toBe("0.04");
    expect(metadata.reason).toBe("STALE_UNSUBMITTED_INTENT");
    expect(metadata.generation).toBe(2);
    // The sequence number is a real version, so the history stays ordered.
    expect(events[0]!.sequenceNumber).toBeGreaterThan(0);
    await clearAlerts(execution.id);
  });

  maybe()("4. once refreshed, a worker holding the stale quantity cannot claim it", async () => {
    const execution = await staleTakeProfitIntent();
    const before = await rowOf(execution.id, "TAKE_PROFIT", 2);
    await tick(execution.id);

    // Exactly the claim the submission path issues, with the quantity a stale
    // worker would still be holding.
    const staleClaim = await prisma!.binanceOrder.updateMany({
      where: { id: before.id, submissionUnknownAt: null, originalQuantity: before.originalQuantity },
      data: { submissionUnknownAt: at() },
    });
    expect(staleClaim.count).toBe(0);
    await clearAlerts(execution.id);
  });

  maybe()("5/10. a claimed intent is never rewritten and nothing is sent", async () => {
    const execution = await staleTakeProfitIntent();
    const row = await rowOf(execution.id, "TAKE_PROFIT", 2);
    // The submission claim won first.
    await prisma!.binanceOrder.update({ where: { id: row.id }, data: { submissionUnknownAt: at() } });

    await tick(execution.id);

    expect((await rowOf(execution.id, "TAKE_PROFIT", 2)).originalQuantity.toString()).toBe("0.1");
    expect(takeProfitPosts()).toEqual([]);
    expect(await refreshEvents(execution.id)).toHaveLength(0);
    await clearAlerts(execution.id);
  });

  maybe()("6. repeated ticks make exactly one durable revision", async () => {
    const execution = await staleTakeProfitIntent();

    for (let index = 0; index < 3; index += 1) await tick(execution.id);

    expect(await refreshEvents(execution.id)).toHaveLength(1);
    expect((await rowOf(execution.id, "TAKE_PROFIT", 2)).originalQuantity.toString()).toBe("0.04");
    await clearAlerts(execution.id);
  });

  maybe()("7. a gap below the exchange minimum is neither sent nor persisted", async () => {
    // minQty is 0.001 for this symbol, so a gap of 0.0005 is unplaceable.
    const execution = await staleTakeProfitIntent({ covering: "0.0995" });

    const outcome = await tick(execution.id);

    expect(outcome.reasonCode).toBe("PROTECTION_QUANTITY_UNSUPPORTED");
    expect(takeProfitPosts()).toEqual([]);
    expect((await rowOf(execution.id, "TAKE_PROFIT", 2)).originalQuantity.toString()).toBe("0.1");
    expect(await refreshEvents(execution.id)).toHaveLength(0);
    await clearAlerts(execution.id);
  });

  maybe()("8. an intent SMALLER than the gap is never enlarged", async () => {
    const execution = await staleTakeProfitIntent({ reserved: "0.010" });

    await tick(execution.id);

    expect(takeProfitPosts()).toEqual(["0.01"]);
    expect(await refreshEvents(execution.id)).toHaveLength(0);
    await clearAlerts(execution.id);
  });

  maybe()("9. a zero gap sends nothing, writes nothing, and does not starve", async () => {
    const execution = await staleTakeProfitIntent({ covering: "0.100" });

    for (let index = 0; index < 3; index += 1) await tick(execution.id);

    expect(takeProfitPosts()).toEqual([]);
    expect(await refreshEvents(execution.id)).toHaveLength(0);
    expect((await rowOf(execution.id, "TAKE_PROFIT", 2)).originalQuantity.toString()).toBe("0.1");

    // A real gap reappearing is still repaired through the same row.
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.quantity = "0.060";
    await tick(execution.id);
    expect(takeProfitPosts()).toEqual(["0.04"]);
    await clearAlerts(execution.id);
  });

  maybe()("11. an UNKNOWN-status intent is never rewritten", async () => {
    const execution = await staleTakeProfitIntent();
    const row = await rowOf(execution.id, "TAKE_PROFIT", 2);
    await prisma!.binanceOrder.update({ where: { id: row.id }, data: { status: "UNKNOWN" } });

    await tick(execution.id);

    expect((await rowOf(execution.id, "TAKE_PROFIT", 2)).originalQuantity.toString()).toBe("0.1");
    expect(await refreshEvents(execution.id)).toHaveLength(0);
    await clearAlerts(execution.id);
  });

  maybe()("12. an intent the exchange has acknowledged is never rewritten", async () => {
    const execution = await staleTakeProfitIntent();
    const row = await rowOf(execution.id, "TAKE_PROFIT", 2);
    await prisma!.binanceOrder.update({ where: { id: row.id }, data: { exchangeAlgoId: "A-observed" } });

    await tick(execution.id);

    expect((await rowOf(execution.id, "TAKE_PROFIT", 2)).originalQuantity.toString()).toBe("0.1");
    expect(await refreshEvents(execution.id)).toHaveLength(0);
    await clearAlerts(execution.id);
  });

  maybe()("14. after a persisted claim the same id is reconciled, never re-sized", async () => {
    const execution = await staleTakeProfitIntent();
    const row = await rowOf(execution.id, "TAKE_PROFIT", 2);
    // A crash between the claim and the response leaves exactly this state.
    await prisma!.binanceOrder.update({ where: { id: row.id }, data: { submissionUnknownAt: at() } });

    await tick(execution.id);

    const after = await rowOf(execution.id, "TAKE_PROFIT", 2);
    expect(after.originalQuantity.toString()).toBe("0.1");
    expect(after.clientAlgoId).toBe(tpIdOf(execution.id, 2));
    expect(scenario.mutations).toEqual([]);
    await clearAlerts(execution.id);
  });

  maybe()("17/18/19. a fresh revision changes nothing else about the row", async () => {
    const execution = await staleTakeProfitIntent();
    const before = await rowOf(execution.id, "TAKE_PROFIT", 2);

    await tick(execution.id);

    const after = await rowOf(execution.id, "TAKE_PROFIT", 2);
    // NO synthetic exchange terminal status is invented for a local decision.
    expect(after.status).not.toBe("CANCELED");
    expect(after.status).not.toBe("EXPIRED");
    expect(after.status).not.toBe("REJECTED");
    // Same identity, same generation, same trigger: only the quantity moved.
    expect(after.clientAlgoId).toBe(before.clientAlgoId);
    expect(after.generation).toBe(before.generation);
    expect(after.triggerPrice!.toString()).toBe(before.triggerPrice!.toString());
    expect(after.workingType).toBe(before.workingType);
    // And no duplicate generation was minted.
    const takeProfits = await prisma!.binanceOrder.findMany({
      where: { tradeExecutionId: execution.id, role: "TAKE_PROFIT" },
    });
    expect(takeProfits.map((order) => order.generation).sort()).toEqual([1, 2]);
    await clearAlerts(execution.id);
  });

  maybe()("15/16. an ordinary pair still submits STOP first, unrevised", async () => {
    const execution = await filledExecution();

    await protect(execution);

    // Stop before take profit, both at the reserved quantity, no revision.
    expect(scenario.submitted.map((entry) => entry.role)).toEqual(["STOP_LOSS", "TAKE_PROFIT"]);
    expect(scenario.submitted.map((entry) => entry.quantity)).toEqual(["0.1", "0.1"]);
    expect(await refreshEvents(execution.id)).toHaveLength(0);
    await clearAlerts(execution.id);
  });

  maybe()("21. a dormant TP intent does not starve STOP repair", async () => {
    // Generation 2 holds a take-profit-only intent that is no longer needed --
    // the target already covers the exposure -- while the STOP has gone away.
    // Repairing the stop is safety-critical and must not wait behind it.
    const execution = await staleTakeProfitIntent({ covering: "0.100" });
    scenario.algoOrders.get(stopIdOf(execution.id, 1))!.algoStatus = "CANCELED";

    for (let index = 0; index < 3; index += 1) await tick(execution.id);

    // A stop is actually placed again.
    expect(scenario.submitted.filter((entry) => entry.role === "STOP_LOSS").map((entry) => entry.quantity)).toEqual([
      "0.1",
    ]);
    // And the dormant target is neither posted nor duplicated.
    expect(takeProfitPosts()).toEqual([]);
    const takeProfits = await prisma!.binanceOrder.findMany({
      where: { tradeExecutionId: execution.id, role: "TAKE_PROFIT" },
    });
    expect(takeProfits.map((order) => order.generation).sort()).toEqual([1, 2]);
    expect((await reload(execution.id)).requiresManualIntervention).toBe(false);
    await clearAlerts(execution.id);
  });

  maybe()("22. a dormant STOP intent neither starves nor duplicates protection", async () => {
    // The mirror: generation 2 holds a stop-only intent that is no longer
    // needed -- the stop already covers the exposure -- while the target has
    // gone. Submitting that stop would put a SECOND stop against one position,
    // which the coverage model fail-closes on.
    const execution = await filledExecution();
    await protect(execution);
    const first = await rowOf(execution.id, "STOP_LOSS", 1);
    await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id,
        role: "STOP_LOSS",
        generation: 2,
        clientOrderId: stopIdOf(execution.id, 2),
        clientAlgoId: stopIdOf(execution.id, 2),
        side: first.side,
        positionSide: first.positionSide,
        orderType: "STOP_MARKET",
        originalQuantity: "0.100",
        triggerPrice: first.triggerPrice,
        workingType: first.workingType,
        priceProtect: first.priceProtect,
        status: "SUBMITTING",
      },
    });
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    scenario.submitted = [];

    for (let index = 0; index < 3; index += 1) await tick(execution.id);

    // No second stop is ever sent.
    expect(scenario.submitted.filter((entry) => entry.role === "STOP_LOSS")).toEqual([]);
    // The target that really is missing gets repaired.
    expect(takeProfitPosts()).toEqual(["0.1"]);
    expect((await reload(execution.id)).requiresManualIntervention).toBe(false);
    // The dormant stop row is left exactly as it was: no fabricated status.
    const dormant = await rowOf(execution.id, "STOP_LOSS", 2);
    expect(dormant.status).toBe("SUBMITTING");
    expect(dormant.originalQuantity.toString()).toBe("0.1");
    await clearAlerts(execution.id);
  });

  maybe()("23. a dormant intent is reused, not duplicated, when its gap returns", async () => {
    const execution = await staleTakeProfitIntent({ covering: "0.100" });
    // Dormant while the target covers the exposure.
    await tick(execution.id);
    expect(takeProfitPosts()).toEqual([]);

    // The gap returns: the SAME generation-2 row is refreshed and placed.
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.quantity = "0.060";
    await tick(execution.id);

    expect(takeProfitPosts()).toEqual(["0.04"]);
    const takeProfits = await prisma!.binanceOrder.findMany({
      where: { tradeExecutionId: execution.id, role: "TAKE_PROFIT" },
    });
    expect(takeProfits.map((order) => order.generation).sort()).toEqual([1, 2]);
    expect((await rowOf(execution.id, "TAKE_PROFIT", 2)).clientAlgoId).toBe(tpIdOf(execution.id, 2));
    await clearAlerts(execution.id);
  });

  maybe()("20. the revised intent is what a restart reads back", async () => {
    const execution = await staleTakeProfitIntent();
    await tick(execution.id);

    // Nothing in memory: exactly what a fresh process would load.
    const reloaded = await prisma!.binanceOrder.findUniqueOrThrow({
      where: { clientAlgoId: tpIdOf(execution.id, 2) },
    });
    expect(reloaded.originalQuantity.toString()).toBe("0.04");
    expect(reloaded.submittedAt).not.toBeNull();
    await clearAlerts(execution.id);
  });
});

describe("pair take-profit submission freshness", () => {
  const tpIdOf = (id: string, generation: number) => buildClientOrderId(id, "TAKE_PROFIT", generation);
  const stopIdOf = (id: string, generation: number) => buildClientOrderId(id, "STOP_LOSS", generation);

  const tick = async (id: string) =>
    protectionService.ensureProtectionForExposure({
      executionId: id,
      expectedVersion: (await reload(id)).version,
      evaluatedAt: at(),
    });

  const postsOf = (role: string) =>
    scenario.submitted.filter((entry) => entry.role === role).map((entry) => entry.quantity);

  const rowOf = async (id: string, role: string, generation: number) =>
    prisma!.binanceOrder.findFirstOrThrow({
      where: { tradeExecutionId: id, role: role as "TAKE_PROFIT", generation },
    });

  const revisions = async (id: string) =>
    prisma!.executionEvent.findMany({
      where: { tradeExecutionId: id, eventType: "ORDER_UPDATED" },
      orderBy: { sequenceNumber: "asc" },
    });

  const clearAlerts = async (id: string) =>
    prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: id } });

  /**
   * A pair is reserved from the tick's opening position read, then the STOP is
   * submitted and authoritatively verified. Every read AFTER that first one
   * sees the new exposure, which is exactly the window this fix closes.
   */
  const shrinkAfterReservation = (to: string) => {
    scenario.positionAmtSequence = ["0.100"];
    scenario.positionAmt = to;
  };

  maybe()("1/3. a shrink before the take-profit POST sends the current gap, not the reserved one", async () => {
    const execution = await filledExecution();
    shrinkAfterReservation("0.040");

    await protect(execution);

    // The stop went out at the reserved size and is never touched again.
    expect(postsOf("STOP_LOSS")).toEqual(["0.1"]);
    // The take profit carries the CURRENT gap.
    expect(postsOf("TAKE_PROFIT")).toEqual(["0.04"]);
    // Same generation, same deterministic identity: no new tranche was burned.
    const takeProfit = await rowOf(execution.id, "TAKE_PROFIT", 1);
    expect(takeProfit.originalQuantity.toString()).toBe("0.04");
    expect(takeProfit.clientAlgoId).toBe(tpIdOf(execution.id, 1));
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id, role: "STOP_LOSS" } })).toBe(1);
    expect(
      await prisma!.executionEvent.count({
        where: { tradeExecutionId: execution.id, eventType: "PROTECTION_RESERVED" },
      })
    ).toBe(1);
    await clearAlerts(execution.id);
  });

  maybe()("2. the revision is journalled with both quantities", async () => {
    const execution = await filledExecution();
    shrinkAfterReservation("0.040");

    await protect(execution);

    const events = await revisions(execution.id);
    expect(events).toHaveLength(1);
    const metadata = events[0]!.metadata as Record<string, unknown>;
    expect(metadata.previousQuantity).toBe("0.1");
    expect(metadata.revisedQuantity).toBe("0.04");
    expect(metadata.role).toBe("TAKE_PROFIT");
    expect(metadata.generation).toBe(1);
    await clearAlerts(execution.id);
  });

  maybe()("4. take-profit coverage that appears late shrinks the pair intent to the real gap", async () => {
    // Generation 1 keeps an ACTIVE target covering 0.060 while its stop is
    // gone, so generation 2 is a pair whose take-profit gap is only 0.040.
    const execution = await filledExecution();
    await protect(execution);
    const firstStop = await rowOf(execution.id, "STOP_LOSS", 1);
    const firstTakeProfit = await rowOf(execution.id, "TAKE_PROFIT", 1);
    scenario.algoOrders.get(stopIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.quantity = "0.060";
    await prisma!.binanceOrder.update({ where: { id: firstTakeProfit.id }, data: { originalQuantity: "0.060" } });
    // A pair reserved back when the whole 0.100 looked missing.
    for (const [role, clientId, type] of [
      ["STOP_LOSS", stopIdOf(execution.id, 2), "STOP_MARKET"],
      ["TAKE_PROFIT", tpIdOf(execution.id, 2), "TAKE_PROFIT_MARKET"],
    ] as const) {
      await prisma!.binanceOrder.create({
        data: {
          tradeExecutionId: execution.id,
          role,
          generation: 2,
          clientOrderId: clientId,
          clientAlgoId: clientId,
          side: firstStop.side,
          positionSide: firstStop.positionSide,
          orderType: type,
          originalQuantity: "0.100",
          triggerPrice: role === "STOP_LOSS" ? firstStop.triggerPrice : firstTakeProfit.triggerPrice,
          workingType: firstStop.workingType,
          priceProtect: firstStop.priceProtect,
          status: "SUBMITTING",
        },
      });
    }
    scenario.submitted = [];

    await tick(execution.id);

    expect(postsOf("STOP_LOSS")).toEqual(["0.1"]);
    expect(postsOf("TAKE_PROFIT")).toEqual(["0.04"]);
    await clearAlerts(execution.id);
  });

  maybe()("5. a reserved intent smaller than the gap is never enlarged", async () => {
    const execution = await filledExecution();
    // The gap grows instead of shrinking: exposure is larger than reserved.
    scenario.positionAmtSequence = ["0.040"];
    scenario.positionAmt = "0.100";

    await protect(execution);

    expect(postsOf("TAKE_PROFIT")).toEqual(["0.04"]);
    expect(await revisions(execution.id)).toHaveLength(0);
    await clearAlerts(execution.id);
  });

  maybe()("6/19. a zero gap places nothing and fabricates no exchange status", async () => {
    const execution = await filledExecution();
    await protect(execution);
    // The target already covers the exposure; a stale pair generation 2 has
    // nothing left to place.
    const firstStop = await rowOf(execution.id, "STOP_LOSS", 1);
    const firstTakeProfit = await rowOf(execution.id, "TAKE_PROFIT", 1);
    scenario.algoOrders.get(stopIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    for (const [role, clientId, type] of [
      ["STOP_LOSS", stopIdOf(execution.id, 2), "STOP_MARKET"],
      ["TAKE_PROFIT", tpIdOf(execution.id, 2), "TAKE_PROFIT_MARKET"],
    ] as const) {
      await prisma!.binanceOrder.create({
        data: {
          tradeExecutionId: execution.id,
          role,
          generation: 2,
          clientOrderId: clientId,
          clientAlgoId: clientId,
          side: firstStop.side,
          positionSide: firstStop.positionSide,
          orderType: type,
          originalQuantity: "0.100",
          triggerPrice: role === "STOP_LOSS" ? firstStop.triggerPrice : firstTakeProfit.triggerPrice,
          workingType: firstStop.workingType,
          priceProtect: firstStop.priceProtect,
          status: "SUBMITTING",
        },
      });
    }
    scenario.submitted = [];

    await tick(execution.id);

    expect(postsOf("TAKE_PROFIT")).toEqual([]);
    const dormant = await rowOf(execution.id, "TAKE_PROFIT", 2);
    expect(dormant.originalQuantity.toString()).toBe("0.1");
    expect(dormant.status).not.toBe("CANCELED");
    expect(dormant.status).not.toBe("EXPIRED");
    expect(dormant.status).not.toBe("REJECTED");
    expect(await revisions(execution.id)).toHaveLength(0);

    // 7. When a gap returns the SAME row is reused and refreshed.
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    scenario.submitted = [];
    await tick(execution.id);
    expect(postsOf("TAKE_PROFIT")).toEqual(["0.1"]);
    expect((await rowOf(execution.id, "TAKE_PROFIT", 2)).clientAlgoId).toBe(tpIdOf(execution.id, 2));
    const takeProfits = await prisma!.binanceOrder.findMany({
      where: { tradeExecutionId: execution.id, role: "TAKE_PROFIT" },
    });
    expect(takeProfits.map((order) => order.generation).sort()).toEqual([1, 2]);
    await clearAlerts(execution.id);
  });

  maybe()("8. a position that goes flat before the take profit places nothing", async () => {
    const execution = await filledExecution();
    shrinkAfterReservation("0");

    const outcome = await protect(execution);

    expect(postsOf("STOP_LOSS")).toEqual(["0.1"]);
    expect(postsOf("TAKE_PROFIT")).toEqual([]);
    // CLOSURE ACTUALLY RUNS IN THIS PASS. The stop we just armed is cancelled
    // and proven terminal here, not left live for a later tick -- Binance does
    // not retire a conditional order just because the position went flat.
    expect(scenario.mutations).toEqual(["POST /fapi/v1/algoOrder STOP_LOSS", "DELETE /fapi/v1/algoOrder"]);
    expect((await rowOf(execution.id, "STOP_LOSS", 1)).status).toBe("CANCELED");
    expect((await reload(execution.id)).status).toBe("CLOSED_EXTERNAL");
    expect((await protectionOf(execution.id)).state).toBe("CLOSED");
    expect(outcome.ok).toBe(true);
    // The stop is cancelled, never resized or replaced, and nothing is parked.
    expect((await rowOf(execution.id, "STOP_LOSS", 1)).originalQuantity.toString()).toBe("0.1");
    expect((await reload(execution.id)).requiresManualIntervention).toBe(false);
    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
    // No target was regenerated and no new generation was minted.
    expect((await ordersOf(execution.id)).map((order) => [order.role, order.generation])).toEqual([
      ["STOP_LOSS", 1],
      ["TAKE_PROFIT", 1],
    ]);
    await clearAlerts(execution.id);
  });

  maybe()("9. a gap below the exchange minimum is neither sent nor persisted, and does not churn", async () => {
    const execution = await filledExecution();
    shrinkAfterReservation("0.0005");

    const first = await protect(execution);
    expect(first.reasonCode).toBe("PROTECTION_QUANTITY_UNSUPPORTED");
    expect(postsOf("TAKE_PROFIT")).toEqual([]);
    expect((await rowOf(execution.id, "TAKE_PROFIT", 1)).originalQuantity.toString()).toBe("0.1");

    const versionBefore = (await reload(execution.id)).version;
    for (let index = 0; index < 3; index += 1) await tick(execution.id);
    expect((await reload(execution.id)).version).toBe(versionBefore);
    expect(await revisions(execution.id)).toHaveLength(0);
    expect(postsOf("TAKE_PROFIT")).toEqual([]);
    await clearAlerts(execution.id);
  });

  maybe()("9b. an under-minimum take profit is never reported as an invalid TRIGGER", async () => {
    /**
     * The FLOCKUSDT mislabel, as a regression.
     *
     * Its SHORT trigger sat correctly below the mark; only the notional was
     * short (4.46611 against a floor of 5). Reporting
     * TAKE_PROFIT_TRIGGER_INVALID sent the operator to inspect a price that was
     * never wrong. The reason an operator sees must name the real condition.
     */
    const execution = await filledExecution();
    shrinkAfterReservation("0.0005");

    const outcome = await protect(execution);
    expect(outcome.reasonCode).toBe("PROTECTION_QUANTITY_UNSUPPORTED");
    expect(outcome.reasonCode).not.toBe("TAKE_PROFIT_TRIGGER_INVALID");

    // And the same accurate reason must reach the durable operator surfaces,
    // not just the return value.
    const alerts = await prisma!.criticalAlert.findMany({ where: { tradeExecutionId: execution.id } });
    for (const alert of alerts) {
      expect(alert.reasonCode).not.toBe("TAKE_PROFIT_TRIGGER_INVALID");
    }
    await clearAlerts(execution.id);
  });

  maybe()("10. after a refresh a worker holding the stale quantity cannot claim it", async () => {
    const execution = await filledExecution();
    const before = "0.1";
    shrinkAfterReservation("0.040");
    await protect(execution);

    const row = await rowOf(execution.id, "TAKE_PROFIT", 1);
    const staleClaim = await prisma!.binanceOrder.updateMany({
      where: { id: row.id, submissionUnknownAt: null, originalQuantity: before },
      data: { submissionUnknownAt: at() },
    });
    expect(staleClaim.count).toBe(0);
    await clearAlerts(execution.id);
  });

  maybe()("11/13/14. a claimed, attempted or UNKNOWN pair intent is never rewritten", async () => {
    for (const patch of [
      { submissionUnknownAt: new Date() },
      { submittedAt: new Date() },
      { status: "UNKNOWN" as const },
    ]) {
      const execution = await filledExecution();
      await protect(execution);
      const firstStop = await rowOf(execution.id, "STOP_LOSS", 1);
      const firstTakeProfit = await rowOf(execution.id, "TAKE_PROFIT", 1);
      scenario.algoOrders.get(stopIdOf(execution.id, 1))!.algoStatus = "CANCELED";
      scenario.algoOrders.get(tpIdOf(execution.id, 1))!.algoStatus = "CANCELED";
      for (const [role, clientId, type] of [
        ["STOP_LOSS", stopIdOf(execution.id, 2), "STOP_MARKET"],
        ["TAKE_PROFIT", tpIdOf(execution.id, 2), "TAKE_PROFIT_MARKET"],
      ] as const) {
        await prisma!.binanceOrder.create({
          data: {
            tradeExecutionId: execution.id,
            role,
            generation: 2,
            clientOrderId: clientId,
            clientAlgoId: clientId,
            side: firstStop.side,
            positionSide: firstStop.positionSide,
            orderType: type,
            originalQuantity: "0.100",
            triggerPrice: role === "STOP_LOSS" ? firstStop.triggerPrice : firstTakeProfit.triggerPrice,
            workingType: firstStop.workingType,
            priceProtect: firstStop.priceProtect,
            status: "SUBMITTING",
            ...(role === "TAKE_PROFIT" ? patch : {}),
          },
        });
      }
      scenario.positionAmt = "0.040";
      scenario.submitted = [];

      await tick(execution.id);

      // The quantity of an identity the exchange may already hold is immutable.
      expect((await rowOf(execution.id, "TAKE_PROFIT", 2)).originalQuantity.toString()).toBe("0.1");
      expect(await revisions(execution.id)).toHaveLength(0);
      await clearAlerts(execution.id);
    }
  });

  maybe()("12. a restart with a live stop and an unclaimed target refreshes, and re-posts no stop", async () => {
    /**
     * Exactly the durable state a crash between stop verification and the
     * take-profit claim leaves: the pair's stop is live on the exchange and
     * recorded as such, its target intent has never been claimed, and the gap
     * has since shrunk because other coverage became visible.
     *
     * The shrink is in COVERAGE rather than exposure on purpose. An exposure
     * shrink leaves the stop guarding more than the position holds, and a later
     * tick defers on that over-coverage before submission is reached at all --
     * which is existing, deliberate behaviour, not this fix's business.
     */
    const execution = await filledExecution();
    await protect(execution);
    const firstStop = await rowOf(execution.id, "STOP_LOSS", 1);
    const firstTakeProfit = await rowOf(execution.id, "TAKE_PROFIT", 1);
    scenario.algoOrders.get(stopIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.quantity = "0.060";
    await prisma!.binanceOrder.update({ where: { id: firstTakeProfit.id }, data: { originalQuantity: "0.060" } });

    // Generation 2's stop is already placed and verified; its target is not.
    await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id,
        role: "STOP_LOSS",
        generation: 2,
        clientOrderId: stopIdOf(execution.id, 2),
        clientAlgoId: stopIdOf(execution.id, 2),
        side: firstStop.side,
        positionSide: firstStop.positionSide,
        orderType: "STOP_MARKET",
        originalQuantity: "0.100",
        triggerPrice: firstStop.triggerPrice,
        workingType: firstStop.workingType,
        priceProtect: firstStop.priceProtect,
        status: "NEW",
        submittedAt: new Date(),
      },
    });
    scenario.algoOrders.set(stopIdOf(execution.id, 2), {
      clientAlgoId: stopIdOf(execution.id, 2),
      algoId: "A-restart",
      symbol: SYMBOL,
      algoStatus: "NEW",
      side: firstStop.side,
      positionSide: firstStop.positionSide,
      orderType: "STOP_MARKET",
      quantity: "0.100",
      triggerPrice: firstStop.triggerPrice!.toString(),
      workingType: firstStop.workingType!,
      priceProtect: Boolean(firstStop.priceProtect),
      executedQty: "0",
      avgPrice: "0",
    });
    await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id,
        role: "TAKE_PROFIT",
        generation: 2,
        clientOrderId: tpIdOf(execution.id, 2),
        clientAlgoId: tpIdOf(execution.id, 2),
        side: firstStop.side,
        positionSide: firstStop.positionSide,
        orderType: "TAKE_PROFIT_MARKET",
        originalQuantity: "0.100",
        triggerPrice: firstTakeProfit.triggerPrice,
        workingType: firstStop.workingType,
        priceProtect: firstStop.priceProtect,
        status: "SUBMITTING",
      },
    });
    scenario.submitted = [];

    await tick(execution.id);

    // The live stop is re-verified, never re-posted.
    expect(postsOf("STOP_LOSS")).toEqual([]);
    // The unclaimed target is refreshed to the current gap and placed.
    expect(postsOf("TAKE_PROFIT")).toEqual(["0.04"]);
    expect((await rowOf(execution.id, "TAKE_PROFIT", 2)).clientAlgoId).toBe(tpIdOf(execution.id, 2));
    expect(await revisions(execution.id)).toHaveLength(1);
    await clearAlerts(execution.id);
  });

  /**
   * A second owned stop generation goes active while a pair's take profit is
   * still unsubmitted, so aggregate stop coverage exceeds exposure across TWO
   * legs. That is duplicate protection, which the coverage model fail-closes
   * on, and the freshness check must not become a side door around it.
   */
  async function twoActiveStopsBeforeTakeProfit() {
    const execution = await filledExecution();
    await protect(execution);
    const firstStop = await rowOf(execution.id, "STOP_LOSS", 1);
    const firstTakeProfit = await rowOf(execution.id, "TAKE_PROFIT", 1);
    // The target is gone, so a fresh pair is the work in front of us.
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    for (const [role, clientId, type] of [
      ["STOP_LOSS", stopIdOf(execution.id, 2), "STOP_MARKET"],
      ["TAKE_PROFIT", tpIdOf(execution.id, 2), "TAKE_PROFIT_MARKET"],
    ] as const) {
      await prisma!.binanceOrder.create({
        data: {
          tradeExecutionId: execution.id,
          role,
          generation: 2,
          clientOrderId: clientId,
          clientAlgoId: clientId,
          side: firstStop.side,
          positionSide: firstStop.positionSide,
          orderType: type,
          originalQuantity: "0.100",
          triggerPrice: role === "STOP_LOSS" ? firstStop.triggerPrice : firstTakeProfit.triggerPrice,
          workingType: firstStop.workingType,
          priceProtect: firstStop.priceProtect,
          status: "SUBMITTING",
        },
      });
    }
    scenario.submitted = [];
    return execution;
  }

  maybe()("A. TWO active stop legs over exposure fail closed; no take profit is placed", async () => {
    const execution = await twoActiveStopsBeforeTakeProfit();

    const outcome = await tick(execution.id);

    // Generation 2's stop went out, so two owned stops now cover 0.200 of a
    // 0.100 position. The take profit must NOT ride through on that.
    expect(postsOf("STOP_LOSS")).toEqual(["0.1"]);
    expect(postsOf("TAKE_PROFIT")).toEqual([]);
    expect(outcome.reasonCode).toBe("PROTECTION_COVERAGE_INCOMPLETE");
    // The intent is untouched: not refreshed, not treated as safe.
    expect((await rowOf(execution.id, "TAKE_PROFIT", 2)).originalQuantity.toString()).toBe("0.1");
    expect(await revisions(execution.id)).toHaveLength(0);
    await clearAlerts(execution.id);
  });

  maybe()("B. ONE owned verified oversized stop still lets the take profit through", async () => {
    // The distinguishing case: same over-coverage arithmetic, but a single
    // owned identity-verified stop, which is the shape testnet evidence covers.
    const execution = await filledExecution();
    shrinkAfterReservation("0.040");

    await protect(execution);

    expect(postsOf("TAKE_PROFIT")).toEqual(["0.04"]);
    expect(await revisions(execution.id)).toHaveLength(1);
    await clearAlerts(execution.id);
  });

  maybe()("C. an oversized stop that is not conclusively ours fails closed", async () => {
    const execution = await filledExecution();
    scenario.positionAmtSequence = ["0.100"];
    scenario.positionAmt = "0.040";
    // The readback contradicts our own intent, so identity is not verified.
    scenario.onSubmitted = (clientAlgoId) => {
      const row = scenario.algoOrders.get(clientAlgoId);
      if (row && row.orderType === "STOP_MARKET") row.positionSide = "SHORT";
    };

    const outcome = await protect(execution);
    scenario.onSubmitted = null;

    expect(postsOf("TAKE_PROFIT")).toEqual([]);
    // Caught even earlier than the freshness check: the stop's own verification
    // refuses an identity that contradicts our intent, so the exception is
    // never reached at all.
    expect(outcome.reasonCode).toBe("STOP_IDENTITY_MISMATCH");
    expect(await revisions(execution.id)).toHaveLength(0);
    await clearAlerts(execution.id);
  });

  maybe()("D. an unreadable or executing stop never reaches the freshness exception", async () => {
    for (const spoil of ["unreadable", "executing"] as const) {
      const execution = await filledExecution();
      scenario.positionAmtSequence = ["0.100"];
      scenario.positionAmt = "0.040";
      scenario.onSubmitted = (clientAlgoId) => {
        const row = scenario.algoOrders.get(clientAlgoId);
        if (!row || row.orderType !== "STOP_MARKET") return;
        if (spoil === "unreadable") scenario.queryFailures.add(clientAlgoId);
        else row.algoStatus = "PARTIALLY_FILLED";
      };

      const outcome = await protect(execution);
      scenario.onSubmitted = null;
      scenario.queryFailures.clear();

      expect(postsOf("TAKE_PROFIT")).toEqual([]);
      expect(outcome.reasonCode).not.toBe("PROTECTION_VERIFIED");
      expect(await revisions(execution.id)).toHaveLength(0);
      await clearAlerts(execution.id);
    }
  });

  maybe()("15/16/17/18. an ordinary pair is unchanged: stop first, both reserved sizes, no revision", async () => {
    const execution = await filledExecution();

    await protect(execution);

    expect(scenario.submitted.map((entry) => entry.role)).toEqual(["STOP_LOSS", "TAKE_PROFIT"]);
    expect(scenario.submitted.map((entry) => entry.quantity)).toEqual(["0.1", "0.1"]);
    expect(await revisions(execution.id)).toHaveLength(0);
    // One generation, one stop, one target.
    const orders = await ordersOf(execution.id);
    expect(orders.filter((order) => order.role === "STOP_LOSS")).toHaveLength(1);
    expect(orders.filter((order) => order.role === "TAKE_PROFIT")).toHaveLength(1);
    expect((await rowOf(execution.id, "STOP_LOSS", 1)).originalQuantity.toString()).toBe("0.1");
    await clearAlerts(execution.id);
  });
});

describe("take-profit repair behind a safe oversized stop", () => {
  const tpIdOf = (id: string, generation: number) => buildClientOrderId(id, "TAKE_PROFIT", generation);
  const stopIdOf = (id: string, generation: number) => buildClientOrderId(id, "STOP_LOSS", generation);

  const tick = async (id: string) =>
    protectionService.ensureProtectionForExposure({
      executionId: id,
      expectedVersion: (await reload(id)).version,
      evaluatedAt: at(),
    });

  const postsOf = (role: string) =>
    scenario.submitted.filter((entry) => entry.role === role).map((entry) => entry.quantity);

  const generationsOfRole = async (id: string, role: string) =>
    (await ordersOf(id))
      .filter((order) => order.role === role)
      .map((order) => order.generation)
      .sort((a, b) => a - b);

  const clearAlerts = async (id: string) =>
    prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: id } });

  /**
   * The proven-safe shape: ONE owned identity-verified stop still armed for the
   * pre-shrink quantity, and a target that is conclusively gone.
   */
  async function safeOversizedStopWithGap() {
    const execution = await filledExecution();
    await protect(execution);
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    scenario.positionAmt = "0.040";
    scenario.submitted = [];
    scenario.mutations = [];
    return execution;
  }

  maybe()("V1. a real take-profit gap behind one safe oversized stop is repaired", async () => {
    const execution = await safeOversizedStopWithGap();

    await tick(execution.id);

    // Take-profit-only repair, sized to CURRENT exposure, with no second stop.
    expect(postsOf("TAKE_PROFIT")).toEqual(["0.04"]);
    expect(postsOf("STOP_LOSS")).toEqual([]);
    expect(await generationsOfRole(execution.id, "TAKE_PROFIT")).toEqual([1, 2]);
    expect(await generationsOfRole(execution.id, "STOP_LOSS")).toEqual([1]);
    // The stop itself is untouched: never resized, cancelled or replaced.
    expect(scenario.mutations.filter((entry) => entry.startsWith("DELETE"))).toEqual([]);
    const stop = await prisma!.binanceOrder.findFirstOrThrow({
      where: { tradeExecutionId: execution.id, role: "STOP_LOSS", generation: 1 },
    });
    expect(stop.originalQuantity.toString()).toBe("0.1");
    await clearAlerts(execution.id);
  });

  maybe()("V2. the repair tick does not park, alert or demote the execution", async () => {
    const execution = await safeOversizedStopWithGap();
    const before = await reload(execution.id);
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: execution.id } });
    const eventsBefore = await prisma!.executionEvent.count({ where: { tradeExecutionId: execution.id } });

    await tick(execution.id);

    const after = await reload(execution.id);
    expect(after.status).toBe(before.status);
    expect(after.requiresManualIntervention).toBe(false);
    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
    // Ordinary reservation accounting only: one version, one reservation event.
    expect(after.version).toBe(before.version + 1);
    const events = await prisma!.executionEvent.findMany({
      where: { tradeExecutionId: execution.id },
      orderBy: { sequenceNumber: "asc" },
    });
    expect(events.length).toBe(eventsBefore + 1);
    expect(events[events.length - 1]!.eventType).toBe("PROTECTION_RESERVED");
    await clearAlerts(execution.id);
  });

  maybe()("V3. a PARTIAL take-profit gap is repaired for the exact delta", async () => {
    const execution = await filledExecution();
    await protect(execution);
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.quantity = "0.015";
    scenario.positionAmt = "0.040";
    scenario.submitted = [];

    await tick(execution.id);

    expect(postsOf("TAKE_PROFIT")).toEqual(["0.025"]);
    expect(await generationsOfRole(execution.id, "STOP_LOSS")).toEqual([1]);
    await clearAlerts(execution.id);
  });

  maybe()("V4. once repaired, the next tick returns the ordinary safe deferral", async () => {
    const execution = await safeOversizedStopWithGap();
    await tick(execution.id);
    expect(postsOf("TAKE_PROFIT")).toEqual(["0.04"]);
    scenario.submitted = [];

    const outcome = await tick(execution.id);

    expect(outcome.reasonCode).toBe("STOP_COVERAGE_EXCEEDS_EXPOSURE");
    expect(scenario.submitted).toEqual([]);
    expect(await generationsOfRole(execution.id, "TAKE_PROFIT")).toEqual([1, 2]);
    expect(await generationsOfRole(execution.id, "STOP_LOSS")).toEqual([1]);
    await clearAlerts(execution.id);
  });

  maybe()("V5. TWO active stop legs over exposure are never repaired behind", async () => {
    const execution = await filledExecution();
    await protect(execution);
    // Grow the position so a second pair is legitimately reserved and placed.
    scenario.positionAmt = "0.200";
    await tick(execution.id);
    expect(await generationsOfRole(execution.id, "STOP_LOSS")).toEqual([1, 2]);
    // Now both targets are gone and the position shrinks: 0.200 of stop across
    // TWO legs against 0.040 of exposure.
    for (const generation of [1, 2]) {
      scenario.algoOrders.get(tpIdOf(execution.id, generation))!.algoStatus = "CANCELED";
    }
    scenario.positionAmt = "0.040";
    scenario.submitted = [];

    const outcome = await tick(execution.id);

    expect(outcome.reasonCode).toBe("PROTECTION_COVERAGE_INCOMPLETE");
    expect(outcome.reasonCode).not.toBe("STOP_COVERAGE_EXCEEDS_EXPOSURE");
    expect(scenario.submitted).toEqual([]);
    expect((await reload(execution.id)).requiresManualIntervention).toBe(true);
    expect(await generationsOfRole(execution.id, "TAKE_PROFIT")).toEqual([1, 2]);
    await clearAlerts(execution.id);
  });

  maybe()("V6. an unplaceable target reserves nothing and churns nothing", async () => {
    const execution = await safeOversizedStopWithGap();
    scenario.markPrice = "120"; // a LONG target at 108 can no longer be placed
    const versionBefore = (await reload(execution.id)).version;
    const ordersBefore = (await ordersOf(execution.id)).length;

    for (let index = 0; index < 3; index += 1) {
      const outcome = await tick(execution.id);
      expect(outcome.reasonCode).toBe("TAKE_PROFIT_TRIGGER_INVALID");
    }

    expect((await ordersOf(execution.id)).length).toBe(ordersBefore);
    expect((await reload(execution.id)).version).toBe(versionBefore);
    expect(scenario.submitted).toEqual([]);
    expect(scenario.mutations).toEqual([]);
    await clearAlerts(execution.id);
  });

  maybe()("V7. a flat position closes out instead of repairing a target", async () => {
    const execution = await safeOversizedStopWithGap();
    scenario.positionAmt = "0";

    await tick(execution.id);

    expect(postsOf("TAKE_PROFIT")).toEqual([]);
    expect(await generationsOfRole(execution.id, "TAKE_PROFIT")).toEqual([1]);
    expect((await reload(execution.id)).status).toBe("CLOSED_EXTERNAL");
    await clearAlerts(execution.id);
  });

  // ---------------------------------------------------------------------
  // COMPOSITION with the freshness machinery already in main. These do not
  // re-implement anything: they prove the repaired intent is protected by it.
  // ---------------------------------------------------------------------

  const plantRepairIntent = async (executionId: string, quantity: string) => {
    const first = await prisma!.binanceOrder.findFirstOrThrow({
      where: { tradeExecutionId: executionId, role: "TAKE_PROFIT", generation: 1 },
    });
    return prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: executionId,
        role: "TAKE_PROFIT",
        generation: 2,
        clientOrderId: tpIdOf(executionId, 2),
        clientAlgoId: tpIdOf(executionId, 2),
        side: first.side,
        positionSide: first.positionSide,
        orderType: "TAKE_PROFIT_MARKET",
        originalQuantity: quantity,
        triggerPrice: first.triggerPrice,
        workingType: first.workingType,
        priceProtect: first.priceProtect,
        status: "SUBMITTING",
      },
    });
  };

  maybe()("V8. a repair intent that goes stale before its POST is refreshed, not sent", async () => {
    const execution = await safeOversizedStopWithGap();
    await plantRepairIntent(execution.id, "0.040");
    // Exposure shrinks again before the reserved repair is ever submitted.
    scenario.positionAmt = "0.020";
    scenario.submitted = [];

    await tick(execution.id);

    expect(postsOf("TAKE_PROFIT")).toEqual(["0.02"]);
    expect(await generationsOfRole(execution.id, "TAKE_PROFIT")).toEqual([1, 2]);
    await clearAlerts(execution.id);
  });

  maybe()("V9. take-profit coverage appearing before the POST shrinks it to the delta", async () => {
    const execution = await filledExecution();
    await protect(execution);
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.quantity = "0.015";
    scenario.positionAmt = "0.040";
    await plantRepairIntent(execution.id, "0.040");
    scenario.submitted = [];

    await tick(execution.id);

    expect(postsOf("TAKE_PROFIT")).toEqual(["0.025"]);
    await clearAlerts(execution.id);
  });

  maybe()("V10. a repair intent whose gap closed is dormant, not posted", async () => {
    const execution = await filledExecution();
    await protect(execution);
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.quantity = "0.040";
    scenario.positionAmt = "0.040";
    await plantRepairIntent(execution.id, "0.040");
    scenario.submitted = [];

    for (let index = 0; index < 3; index += 1) {
      const outcome = await tick(execution.id);
      expect(outcome.reasonCode).toBe("STOP_COVERAGE_EXCEEDS_EXPOSURE");
    }

    expect(scenario.submitted).toEqual([]);
    // Still durable and reusable: no fabricated terminal status.
    const dormant = await prisma!.binanceOrder.findFirstOrThrow({
      where: { tradeExecutionId: execution.id, role: "TAKE_PROFIT", generation: 2 },
    });
    expect(dormant.status).toBe("SUBMITTING");
    expect(dormant.originalQuantity.toString()).toBe("0.04");

    // When the gap returns the SAME row is reused.
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    await tick(execution.id);
    expect(postsOf("TAKE_PROFIT")).toEqual(["0.04"]);
    expect((await prisma!.binanceOrder.findFirstOrThrow({
      where: { tradeExecutionId: execution.id, role: "TAKE_PROFIT", generation: 2 },
    })).clientAlgoId).toBe(tpIdOf(execution.id, 2));
    expect(await generationsOfRole(execution.id, "TAKE_PROFIT")).toEqual([1, 2]);
    await clearAlerts(execution.id);
  });

  maybe()("V11. a claimed repair intent is never rewritten or duplicated", async () => {
    const execution = await safeOversizedStopWithGap();
    const planted = await plantRepairIntent(execution.id, "0.040");
    await prisma!.binanceOrder.update({
      where: { id: planted.id },
      data: { submissionUnknownAt: at() },
    });
    scenario.positionAmt = "0.020";
    scenario.submitted = [];

    await tick(execution.id);

    expect(scenario.submitted).toEqual([]);
    const untouched = await prisma!.binanceOrder.findFirstOrThrow({
      where: { tradeExecutionId: execution.id, role: "TAKE_PROFIT", generation: 2 },
    });
    expect(untouched.originalQuantity.toString()).toBe("0.04");
    expect(await generationsOfRole(execution.id, "TAKE_PROFIT")).toEqual([1, 2]);
    await clearAlerts(execution.id);
  });
});

describe("modality-aware protection representation", () => {
  const tpIdOf = (id: string, generation: number) => buildClientOrderId(id, "TAKE_PROFIT", generation);
  const stopIdOf = (id: string, generation: number) => buildClientOrderId(id, "STOP_LOSS", generation);

  const tick = async (id: string) =>
    protectionService.ensureProtectionForExposure({
      executionId: id,
      expectedVersion: (await reload(id)).version,
      evaluatedAt: at(),
    });

  const clearAlerts = async (id: string) =>
    prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: id } });

  /**
   * Converts the execution's ONLY take-profit generation to a standard resting
   * LIMIT: role TAKE_PROFIT, orderType LIMIT, addressed by clientOrderId with no
   * clientAlgoId.
   *
   * Converting rather than adding a second differently-shaped generation is
   * deliberate. A single execution holding both modalities is exactly the mixed
   * lineage the reservation rule refuses, so a fixture that mixed them would be
   * describing a state the lifecycle now escalates rather than the state under
   * test.
   */
  async function standardTakeProfitRow(executionId: string, generation: number, quantity: string) {
    const row = await prisma!.binanceOrder.findFirstOrThrow({
      where: { tradeExecutionId: executionId, role: "TAKE_PROFIT", generation },
    });
    await prisma!.binanceOrder.update({
      where: { id: row.id },
      data: {
        clientAlgoId: null,
        orderType: "LIMIT",
        timeInForce: "GTC",
        price: row.triggerPrice,
        originalQuantity: quantity,
        status: "NEW",
        submittedAt: null,
        submissionUnknownAt: null,
      },
    });
    // The conditional readback must disappear with it: this identity is no
    // longer an algo order.
    scenario.algoOrders.delete(tpIdOf(executionId, generation));
    return row.clientOrderId;
  }

  maybe()("L. a standard protection row with no clientAlgoId is visible to the loader", async () => {
    const execution = await filledExecution();
    await protect(execution);
    // Generation 1's algo target is gone; a STANDARD target covers 0.040.
    const clientOrderId = await standardTakeProfitRow(execution.id, 1, "0.040");
    scenario.standardOrders.set(clientOrderId, {
      status: "NEW", origQty: "0.040", executedQty: "0", avgPrice: "0", orderId: "S1",
      side: "SELL", type: "LIMIT", price: "108",
    });
    scenario.positionAmt = "0.040";
    scenario.submitted = [];

    const outcome = await tick(execution.id);

    // Counted as real coverage: the execution is not treated as unprotected,
    // and no replacement target is minted for a leg that is already covered.
    expect(outcome.reasonCode).not.toBe("PROTECTION_COVERAGE_INCOMPLETE");
    expect(scenario.submitted.filter((entry) => entry.role === "TAKE_PROFIT")).toEqual([]);
    await clearAlerts(execution.id);
  });

  maybe()("K. a partially filled standard target and an active algo stop are both represented", async () => {
    const execution = await filledExecution();
    await protect(execution);
    const clientOrderId = await standardTakeProfitRow(execution.id, 1, "0.100");
    // Testnet #4 shape: part traded, the remnant still rests and still covers.
    scenario.standardOrders.set(clientOrderId, {
      status: "PARTIALLY_FILLED", origQty: "0.100", executedQty: "0.060", avgPrice: "108",
      orderId: "S2", side: "SELL", type: "LIMIT", price: "108",
    });
    scenario.positionAmt = "0.040";
    scenario.submitted = [];

    const outcome = await tick(execution.id);

    // The algo STOP still covers 0.100 and the standard remnant covers 0.040,
    // so neither hides the other: the stop over-covers the shrunken position
    // and the target is complete, which is the ordinary safe deferral.
    expect(outcome.reasonCode).toBe("STOP_COVERAGE_EXCEEDS_EXPOSURE");
    expect(scenario.submitted.filter((entry) => entry.role === "TAKE_PROFIT")).toEqual([]);
    await clearAlerts(execution.id);
  });

  maybe()("F/O. an EXPIRED standard remnant covers nothing, and repair sees the gap", async () => {
    const execution = await filledExecution();
    await protect(execution);
    const clientOrderId = await standardTakeProfitRow(execution.id, 1, "0.100");
    // origQty - executedQty is still positive, but the order is terminal.
    scenario.standardOrders.set(clientOrderId, {
      status: "EXPIRED", origQty: "0.100", executedQty: "0.060", avgPrice: "108",
      orderId: "S3", side: "SELL", type: "LIMIT", price: "108",
    });
    scenario.positionAmt = "0.040";
    scenario.submitted = [];

    const outcome = await tick(execution.id);

    // Zero coverage, so the target is genuinely missing: the lifecycle must
    // NOT read this as covered. And EXPIRED on its own parks nothing.
    expect(outcome.reasonCode).not.toBe("PROTECTION_VERIFIED");
    expect(outcome.reasonCode).not.toBe("STOP_COVERAGE_EXCEEDS_EXPOSURE");
    expect((await reload(execution.id)).requiresManualIntervention).toBe(false);
    await clearAlerts(execution.id);
  });

  maybe()("J. an unreadable standard target is unresolved, never zero", async () => {
    const execution = await filledExecution();
    await protect(execution);
    await standardTakeProfitRow(execution.id, 1, "0.100");
    // No scenario.standardOrders entry AND the query itself is unavailable, so
    // the state is genuinely unreadable rather than proven absent.
    scenario.entryQueryUnavailable = true;
    scenario.submitted = [];

    const outcome = await tick(execution.id);
    scenario.entryQueryUnavailable = false;

    // Fail closed: it defers on unreadability instead of repairing blindly.
    expect(outcome.reasonCode).toBe("TAKE_PROFIT_QUERY_UNAVAILABLE");
    expect(scenario.submitted).toEqual([]);
    await clearAlerts(execution.id);
  });

  maybe()("M. an ENTRY limit row is never loaded as protection", async () => {
    const execution = await filledExecution();
    await protect(execution);
    // An ENTRY row is a LIMIT with a clientOrderId and no clientAlgoId -- the
    // exact shape the widened loader must still refuse, on role alone.
    const entry = await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id,
        role: "ENTRY",
        generation: 1,
        clientOrderId: buildClientOrderId(execution.id, "ENTRY", 1),
        clientAlgoId: null,
        side: "BUY",
        positionSide: "LONG",
        orderType: "LIMIT",
        timeInForce: "GTC",
        price: "100",
        originalQuantity: "0.100",
        status: "NEW",
      },
    });
    expect(entry.orderType).toBe("LIMIT");
    expect(entry.clientAlgoId).toBeNull();

    const loaded = await prisma!.binanceOrder.findMany({
      where: { tradeExecutionId: execution.id, role: { in: ["STOP_LOSS", "TAKE_PROFIT"] } },
    });
    expect(loaded.some((order) => order.id === entry.id)).toBe(false);
    expect(loaded.map((order) => order.role).sort()).toEqual(["STOP_LOSS", "TAKE_PROFIT"]);

    // And a real tick still measures only the two protection legs.
    const outcome = await tick(execution.id);
    expect(outcome.reasonCode).toBe("PROTECTION_VERIFIED");
    await clearAlerts(execution.id);
  });

  maybe()("an unsupported protection order type is owned but never interpreted", async () => {
    // role proves the lifecycle owns it, so the loader must SEE it -- but its
    // order type is one this lifecycle never places, so it can be read as
    // neither modality and must not be queried as a conditional order.
    const execution = await filledExecution();
    await protect(execution);
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id,
        role: "TAKE_PROFIT",
        generation: 2,
        clientOrderId: tpIdOf(execution.id, 2),
        clientAlgoId: null,
        side: "SELL",
        positionSide: "LONG",
        orderType: "MARKET",
        originalQuantity: "0.100",
        status: "NEW",
      },
    });
    scenario.submitted = [];
    scenario.mutations = [];

    const outcome = await tick(execution.id);

    // Fail closed: unresolved coverage, and nothing sent to the exchange.
    expect(outcome.reasonCode).toBe("TAKE_PROFIT_QUERY_UNAVAILABLE");
    expect(scenario.submitted).toEqual([]);
    expect(scenario.mutations).toEqual([]);
    expect((await reload(execution.id)).requiresManualIntervention).toBe(false);
    // The row is still owned and untouched -- not reinterpreted, not rewritten.
    const row = await prisma!.binanceOrder.findFirstOrThrow({
      where: { tradeExecutionId: execution.id, role: "TAKE_PROFIT", generation: 2 },
    });
    expect(row.orderType).toBe("MARKET");
    expect(row.status).toBe("NEW");
    await clearAlerts(execution.id);
  });

  maybe()("P. an algo quantity rewrite never overwrites the durable intent", async () => {
    const execution = await filledExecution();
    await protect(execution);
    const stopRow = await prisma!.binanceOrder.findFirstOrThrow({
      where: { tradeExecutionId: execution.id, role: "STOP_LOSS", generation: 1 },
    });
    expect(stopRow.originalQuantity.toString()).toBe("0.1");
    // Testnet #4: after a clamped execution Binance reports the EXECUTED size
    // where the armed size used to be.
    const stop = scenario.algoOrders.get(stopIdOf(execution.id, 1))!;
    stop.quantity = "0.040";
    stop.algoStatus = "FINISHED";
    scenario.positionAmt = "0";

    await tick(execution.id);

    const after = await prisma!.binanceOrder.findFirstOrThrow({ where: { id: stopRow.id } });
    expect(after.originalQuantity.toString()).toBe("0.1");
    await clearAlerts(execution.id);
  });
});

describe("standard limit take-profit submission", () => {
  const tpIdOf = (id: string, generation: number) => buildClientOrderId(id, "TAKE_PROFIT", generation);
  const stopIdOf = (id: string, generation: number) => buildClientOrderId(id, "STOP_LOSS", generation);

  const tick = async (id: string) =>
    protectionService.ensureProtectionForExposure({
      executionId: id,
      expectedVersion: (await reload(id)).version,
      evaluatedAt: at(),
    });

  const clearAlerts = async (id: string) =>
    prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: id } });

  const rowOf = async (id: string, role: string, generation: number) =>
    prisma!.binanceOrder.findFirstOrThrow({
      where: { tradeExecutionId: id, role: role as "TAKE_PROFIT", generation },
    });

  const takeProfitRows = async (id: string) =>
    (await ordersOf(id)).filter((order) => order.role === "TAKE_PROFIT");

  /** Runs `run` with the standard-limit switch forced to `enabled`. */
  const withStandardTakeProfit = async <T>(enabled: boolean, run: () => Promise<T>): Promise<T> => {
    const key = "EXECUTION_STANDARD_LIMIT_TAKE_PROFIT_ENABLED" as const;
    const previous = (runtimeEnv as Record<string, unknown>)[key];
    (runtimeEnv as Record<string, unknown>)[key] = enabled;
    try {
      return await run();
    } finally {
      (runtimeEnv as Record<string, unknown>)[key] = previous;
    }
  };

  // ---------------------------------------------------------------- default

  maybe()("1/38. with the switch off the take profit is still a conditional order", async () => {
    const execution = await filledExecution();

    await withStandardTakeProfit(false, () => protect(execution));

    const takeProfit = await rowOf(execution.id, "TAKE_PROFIT", 1);
    expect(takeProfit.orderType).toBe("TAKE_PROFIT_MARKET");
    expect(takeProfit.clientAlgoId).toBe(tpIdOf(execution.id, 1));
    // Not one standard protection order was sent.
    expect(scenario.standardSubmitted).toEqual([]);
    expect(scenario.mutations).toEqual([
      "POST /fapi/v1/algoOrder STOP_LOSS",
      "POST /fapi/v1/algoOrder TAKE_PROFIT",
    ]);
    await clearAlerts(execution.id);
  });

  maybe()("26. the default configuration is off", async () => {
    // The switch is fail-closed in config, so an unset environment is off.
    expect(runtimeEnv.EXECUTION_STANDARD_LIMIT_TAKE_PROFIT_ENABLED).toBe(false);
  });

  // ------------------------------------------------------------ first intent

  maybe()("2/3/4/5. with the switch on the first take profit is a resting LIMIT", async () => {
    const execution = await filledExecution();

    await withStandardTakeProfit(true, () => protect(execution));

    const takeProfit = await rowOf(execution.id, "TAKE_PROFIT", 1);
    expect(takeProfit.orderType).toBe("LIMIT");
    // Standard identity only: no algo id is fabricated for it.
    expect(takeProfit.clientOrderId).toBe(tpIdOf(execution.id, 1));
    expect(takeProfit.clientAlgoId).toBeNull();
    expect(takeProfit.price!.toString()).toBe("108");
    expect(takeProfit.timeInForce).toBe("GTC");
    // The stop is untouched and still conditional, and still goes first.
    const stop = await rowOf(execution.id, "STOP_LOSS", 1);
    expect(stop.orderType).toBe("STOP_MARKET");
    expect(scenario.mutations).toEqual([
      "POST /fapi/v1/algoOrder STOP_LOSS",
      "POST /fapi/v1/order LIMIT TAKE_PROFIT",
    ]);
    // The exact request shape, and nothing else.
    expect(scenario.standardSubmitted).toHaveLength(1);
    const sent = scenario.standardSubmitted[0]!;
    expect(sent.symbol).toBe(SYMBOL);
    expect(sent.side).toBe("SELL");
    expect(sent.positionSide).toBe("LONG");
    expect(sent.quantity).toBe("0.1");
    expect(sent.price).toBe("108");
    expect(sent.clientOrderId).toBe(tpIdOf(execution.id, 1));
    expect("clientAlgoId" in sent).toBe(false);
    expect("reduceOnly" in sent).toBe(false);
    await clearAlerts(execution.id);
  });

  maybe()("6. a SHORT execution closes with a BUY limit on the SHORT leg", async () => {
    const execution = await filledExecution({ direction: "SHORT" });
    scenario.positionAmt = "-0.100";

    await withStandardTakeProfit(true, () => protect(execution));

    const sent = scenario.standardSubmitted[0]!;
    expect(sent.side).toBe("BUY");
    expect(sent.positionSide).toBe("SHORT");
    await clearAlerts(execution.id);
  });

  // -------------------------------------------------------------- verifying

  maybe()("7. a resting NEW standard take profit verifies", async () => {
    const execution = await filledExecution();

    const outcome = await withStandardTakeProfit(true, () => protect(execution));

    expect(outcome.reasonCode).toBe("PROTECTION_VERIFIED");
    expect((await rowOf(execution.id, "TAKE_PROFIT", 1)).status).toBe("NEW");
    await clearAlerts(execution.id);
  });

  maybe()("8/22. a partially filled remnant is resting coverage, not a gap", async () => {
    const execution = await filledExecution();
    await withStandardTakeProfit(true, () => protect(execution));
    // Part of the target traded; the remnant still rests and still covers.
    scenario.standardOrders.get(tpIdOf(execution.id, 1))!.status = "PARTIALLY_FILLED";
    scenario.standardOrders.get(tpIdOf(execution.id, 1))!.executedQty = "0.040";
    scenario.positionAmt = "0.060";
    scenario.standardSubmitted = [];

    const outcome = await withStandardTakeProfit(true, () => tick(execution.id));

    // 0.060 of remnant against 0.060 of exposure: the target is NOT missing, so
    // nothing is reserved or sent. The tick reports the ordinary safe-overstop
    // deferral because the conditional stop still guards the pre-fill size --
    // which is exactly the proof that the remnant was counted as coverage.
    expect(outcome.reasonCode).toBe("STOP_COVERAGE_EXCEEDS_EXPOSURE");
    expect(scenario.standardSubmitted).toEqual([]);
    expect(await takeProfitRows(execution.id)).toHaveLength(1);
    await clearAlerts(execution.id);
  });

  maybe()("15. a partial fill is persisted on the durable row", async () => {
    const execution = await filledExecution();
    await withStandardTakeProfit(true, () => protect(execution));
    scenario.standardOrders.get(tpIdOf(execution.id, 1))!.status = "PARTIALLY_FILLED";
    scenario.standardOrders.get(tpIdOf(execution.id, 1))!.executedQty = "0.040";
    scenario.positionAmt = "0.060";

    await withStandardTakeProfit(true, () => tick(execution.id));

    const row = await rowOf(execution.id, "TAKE_PROFIT", 1);
    expect(row.status).toBe("PARTIALLY_FILLED");
    // Intent history is never overwritten by the exchange's own quantities.
    expect(row.originalQuantity.toString()).toBe("0.1");
    await clearAlerts(execution.id);
  });

  maybe()("16/17/18. an expired remnant syncs once and then stops writing", async () => {
    const execution = await filledExecution();
    await withStandardTakeProfit(true, () => protect(execution));
    scenario.standardOrders.get(tpIdOf(execution.id, 1))!.status = "EXPIRED";
    scenario.standardOrders.get(tpIdOf(execution.id, 1))!.executedQty = "0.040";
    scenario.positionAmt = "0.040";

    await withStandardTakeProfit(true, () => tick(execution.id));
    expect((await rowOf(execution.id, "TAKE_PROFIT", 1)).status).toBe("EXPIRED");
    expect((await rowOf(execution.id, "TAKE_PROFIT", 1)).originalQuantity.toString()).toBe("0.1");

    // A second read of the SAME status writes nothing and churns nothing.
    const versionBefore = (await reload(execution.id)).version;
    const updatedBefore = (await rowOf(execution.id, "TAKE_PROFIT", 1)).updatedAt;
    await withStandardTakeProfit(true, () => tick(execution.id));
    expect((await rowOf(execution.id, "TAKE_PROFIT", 1)).updatedAt).toEqual(updatedBefore);
    expect((await reload(execution.id)).version).toBe(versionBefore);
    await clearAlerts(execution.id);
  });

  // ------------------------------------------------------- lineage / repair

  maybe()("10/13. an expired standard target is repaired as a STANDARD limit", async () => {
    const execution = await filledExecution();
    await withStandardTakeProfit(true, () => protect(execution));
    scenario.standardOrders.get(tpIdOf(execution.id, 1))!.status = "EXPIRED";
    scenario.positionAmt = "0.060";
    scenario.standardSubmitted = [];
    scenario.mutations = [];

    // Even with the switch OFF, the lineage decides.
    await withStandardTakeProfit(false, () => tick(execution.id));

    const replacement = await rowOf(execution.id, "TAKE_PROFIT", 2);
    expect(replacement.orderType).toBe("LIMIT");
    expect(replacement.originalQuantity.toString()).toBe("0.06");
    expect(replacement.price!.toString()).toBe("108");
    expect(scenario.mutations).not.toContain("POST /fapi/v1/algoOrder TAKE_PROFIT");
    await clearAlerts(execution.id);
  });

  maybe()("11/12. a cancelled or rejected standard target repairs as STANDARD too", async () => {
    for (const terminal of ["CANCELED", "REJECTED"] as const) {
      scenario.positionAmt = "0.100";
      const execution = await filledExecution();
      await withStandardTakeProfit(true, () => protect(execution));
      scenario.standardOrders.get(tpIdOf(execution.id, 1))!.status = terminal;
      scenario.positionAmt = "0.060";
      scenario.mutations = [];

      await withStandardTakeProfit(true, () => tick(execution.id));

      expect((await rowOf(execution.id, "TAKE_PROFIT", 2)).orderType).toBe("LIMIT");
      expect(scenario.mutations).not.toContain("POST /fapi/v1/algoOrder TAKE_PROFIT");
      await clearAlerts(execution.id);
    }
  });

  maybe()("19. an ALGO lineage stays ALGO after the switch is turned on", async () => {
    const execution = await filledExecution();
    await withStandardTakeProfit(false, () => protect(execution));
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    scenario.positionAmt = "0.040";
    scenario.mutations = [];

    await withStandardTakeProfit(true, () => tick(execution.id));

    expect((await rowOf(execution.id, "TAKE_PROFIT", 2)).orderType).toBe("TAKE_PROFIT_MARKET");
    expect(scenario.standardSubmitted).toEqual([]);
    await clearAlerts(execution.id);
  });

  maybe()("21. a mixed-modality history fails closed", async () => {
    const execution = await filledExecution();
    await withStandardTakeProfit(false, () => protect(execution));
    // Something wrote a second take profit of the other modality.
    const first = await rowOf(execution.id, "TAKE_PROFIT", 1);
    await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id,
        role: "TAKE_PROFIT",
        generation: 2,
        clientOrderId: tpIdOf(execution.id, 2),
        clientAlgoId: null,
        side: first.side,
        positionSide: first.positionSide,
        orderType: "LIMIT",
        timeInForce: "GTC",
        price: first.triggerPrice,
        originalQuantity: "0.040",
        status: "CANCELED",
      },
    });
    scenario.algoOrders.get(tpIdOf(execution.id, 1))!.algoStatus = "CANCELED";
    scenario.positionAmt = "0.040";
    scenario.mutations = [];
    scenario.standardSubmitted = [];

    const outcome = await withStandardTakeProfit(true, () => tick(execution.id));

    expect(outcome.reasonCode).toBe("TAKE_PROFIT_INTENT_CONFLICT");
    expect((await reload(execution.id)).requiresManualIntervention).toBe(true);
    expect(scenario.mutations).toEqual([]);
    expect(scenario.standardSubmitted).toEqual([]);
    expect(await takeProfitRows(execution.id)).toHaveLength(2);
    await clearAlerts(execution.id);
  });

  // ------------------------------------------------------------- submission

  maybe()("25. a claimed standard intent is never re-sent", async () => {
    const execution = await filledExecution();
    await withStandardTakeProfit(true, () => protect(execution));
    const row = await rowOf(execution.id, "TAKE_PROFIT", 1);
    // The claim persisted but the response was lost, and the order is not
    // visible: this identity may still be live.
    await prisma!.binanceOrder.update({
      where: { id: row.id },
      data: { status: "SUBMITTING", submittedAt: null, submissionUnknownAt: at() },
    });
    scenario.standardOrders.delete(tpIdOf(execution.id, 1));
    scenario.standardSubmitted = [];

    await withStandardTakeProfit(true, () => tick(execution.id));

    expect(scenario.standardSubmitted).toEqual([]);
    await clearAlerts(execution.id);
  });

  maybe()("26b. an ambiguous submission is reconciled by client order id, never re-POSTed", async () => {
    const execution = await filledExecution();
    scenario.standardSubmitFailure = timeoutError("newOrder");
    scenario.standardSubmitLands = true;

    await withStandardTakeProfit(true, () => protect(execution));
    expect(scenario.standardSubmitted).toHaveLength(1);

    // A restart re-reads the same identity and finds it resting.
    scenario.standardSubmitted = [];
    await withStandardTakeProfit(true, () => tick(execution.id));

    expect(scenario.standardSubmitted).toEqual([]);
    expect((await rowOf(execution.id, "TAKE_PROFIT", 1)).status).toBe("NEW");
    await clearAlerts(execution.id);
  });

  maybe()("24. a stale reserved quantity is refreshed before the standard POST", async () => {
    const execution = await filledExecution();
    scenario.positionAmtSequence = ["0.100"];
    // 0.060 x 108 = 6.48, above this symbol's notional floor, so the refresh
    // itself is what is under test rather than the floor.
    scenario.positionAmt = "0.060";

    await withStandardTakeProfit(true, () => protect(execution));

    // The pair freshness rule applies to a standard target exactly as it does
    // to a conditional one: the stale 0.1 is never sent.
    expect(scenario.standardSubmitted.map((entry) => entry.quantity)).toEqual(["0.06"]);
    const row = await rowOf(execution.id, "TAKE_PROFIT", 1);
    expect(row.originalQuantity.toString()).toBe("0.06");
    // 20. the frozen target price does not move with the quantity.
    expect(row.price!.toString()).toBe("108");
    expect(row.clientOrderId).toBe(tpIdOf(execution.id, 1));
    await clearAlerts(execution.id);
  });

  // ---------------------------------------------------------------- closure

  maybe()("31/32. closure cancels a resting standard target through the order endpoint", async () => {
    for (const resting of ["NEW", "PARTIALLY_FILLED"] as const) {
      scenario.positionAmt = "0.100";
      const execution = await filledExecution();
      await withStandardTakeProfit(true, () => protect(execution));
      scenario.standardOrders.get(tpIdOf(execution.id, 1))!.status = resting;
      scenario.positionAmt = "0";
      scenario.mutations = [];

      await withStandardTakeProfit(true, () => tick(execution.id));

      // The standard endpoint, never the algo DELETE.
      expect(scenario.mutations).toContain("DELETE /fapi/v1/order");
      expect((await rowOf(execution.id, "TAKE_PROFIT", 1)).status).toBe("CANCELED");
      await clearAlerts(execution.id);
    }
  });

  maybe()("33. an already terminal standard target is not cancelled again", async () => {
    const execution = await filledExecution();
    await withStandardTakeProfit(true, () => protect(execution));
    scenario.standardOrders.get(tpIdOf(execution.id, 1))!.status = "EXPIRED";
    scenario.positionAmt = "0";
    scenario.mutations = [];

    await withStandardTakeProfit(true, () => tick(execution.id));

    expect(scenario.mutations).not.toContain("DELETE /fapi/v1/order");
    await clearAlerts(execution.id);
  });

  maybe()("34. an unresolved standard cancellation leaves cleanup incomplete", async () => {
    const execution = await filledExecution();
    await withStandardTakeProfit(true, () => protect(execution));
    scenario.standardCancelFailure = timeoutError("cancelOrder");
    scenario.positionAmt = "0";

    await withStandardTakeProfit(true, () => tick(execution.id));

    // Still resting after an unknown DELETE: cleanup is not claimed as done.
    expect((await protectionOf(execution.id)).state).not.toBe("CLOSED");
    await clearAlerts(execution.id);
  });

  maybe()("30. a stop that fires while the standard target rests leaves no replacement", async () => {
    const execution = await filledExecution();
    await withStandardTakeProfit(true, () => protect(execution));
    // Testnet #4: the stop takes the remaining exposure and the remnant expires.
    scenario.algoOrders.get(stopIdOf(execution.id, 1))!.algoStatus = "FILLED";
    scenario.standardOrders.get(tpIdOf(execution.id, 1))!.status = "EXPIRED";
    scenario.standardOrders.get(tpIdOf(execution.id, 1))!.executedQty = "0.040";
    scenario.positionAmt = "0";
    scenario.standardSubmitted = [];

    await withStandardTakeProfit(true, () => tick(execution.id));

    expect(scenario.standardSubmitted).toEqual([]);
    expect(await takeProfitRows(execution.id)).toHaveLength(1);
    expect((await reload(execution.id)).status).toBe("CLOSED_SL");
    await clearAlerts(execution.id);
  });

  maybe()("35. a standard target that fills immediately closes the execution", async () => {
    const execution = await filledExecution();
    await withStandardTakeProfit(true, () => protect(execution));
    scenario.standardOrders.get(tpIdOf(execution.id, 1))!.status = "FILLED";
    scenario.standardOrders.get(tpIdOf(execution.id, 1))!.executedQty = "0.100";
    scenario.positionAmt = "0";
    scenario.standardSubmitted = [];

    await withStandardTakeProfit(true, () => tick(execution.id));

    expect(scenario.standardSubmitted).toEqual([]);
    expect(await takeProfitRows(execution.id)).toHaveLength(1);
    expect((await reload(execution.id)).status).toBe("CLOSED_TP");
    await clearAlerts(execution.id);
  });

  // ------------------------------------------------------------ composition

  maybe()("28. a take-profit gap behind one safe oversized stop repairs as STANDARD", async () => {
    const execution = await filledExecution();
    await withStandardTakeProfit(true, () => protect(execution));
    scenario.standardOrders.get(tpIdOf(execution.id, 1))!.status = "EXPIRED";
    scenario.positionAmt = "0.060"; // the stop now guards 0.1 against 0.06
    scenario.mutations = [];

    await withStandardTakeProfit(true, () => tick(execution.id));

    const replacement = await rowOf(execution.id, "TAKE_PROFIT", 2);
    expect(replacement.orderType).toBe("LIMIT");
    expect(replacement.originalQuantity.toString()).toBe("0.06");
    // The stop is never resized, cancelled or duplicated by the repair.
    expect((await ordersOf(execution.id)).filter((o) => o.role === "STOP_LOSS")).toHaveLength(1);
    await clearAlerts(execution.id);
  });

  maybe()("13b. an unreadable standard target repairs nothing", async () => {
    const execution = await filledExecution();
    await withStandardTakeProfit(true, () => protect(execution));
    scenario.standardOrders.delete(tpIdOf(execution.id, 1));
    scenario.entryQueryUnavailable = true;
    scenario.standardSubmitted = [];
    scenario.mutations = [];

    const outcome = await withStandardTakeProfit(true, () => tick(execution.id));
    scenario.entryQueryUnavailable = false;

    expect(outcome.reasonCode).toBe("TAKE_PROFIT_QUERY_UNAVAILABLE");
    expect(scenario.standardSubmitted).toEqual([]);
    expect(await takeProfitRows(execution.id)).toHaveLength(1);
    await clearAlerts(execution.id);
  });

  // ------------------------------------------------- minimum notional

  maybe()("N1. a refresh that would fall below the notional floor is never sent", async () => {
    // Reserved 0.100 at 108 = 10.8, comfortably above the floor of 5. Exposure
    // then shrinks to 0.040, whose notional is 4.32 and therefore unplaceable.
    const execution = await filledExecution();
    scenario.positionAmtSequence = ["0.100"];
    scenario.positionAmt = "0.040";

    await withStandardTakeProfit(true, () => protect(execution));

    // Nothing may reach the exchange, and the durable intent must NOT be
    // shrunk into a size that can never be placed.
    expect(scenario.standardSubmitted).toEqual([]);
    const row = await rowOf(execution.id, "TAKE_PROFIT", 1);
    expect(row.originalQuantity.toString()).toBe("0.1");
    expect(row.price!.toString()).toBe("108");
    expect(row.submittedAt).toBeNull();
    expect(row.submissionUnknownAt).toBeNull();
    expect(row.clientOrderId).toBe(tpIdOf(execution.id, 1));
    // The stop is placed and untouched; only the target is deferred.
    expect((await rowOf(execution.id, "STOP_LOSS", 1)).orderType).toBe("STOP_MARKET");
    expect(await takeProfitRows(execution.id)).toHaveLength(1);
    await clearAlerts(execution.id);
  });

  maybe()("N2. repeated under-notional ticks churn nothing", async () => {
    const execution = await filledExecution();
    scenario.positionAmtSequence = ["0.100"];
    scenario.positionAmt = "0.040";
    await withStandardTakeProfit(true, () => protect(execution));

    const versionBefore = (await reload(execution.id)).version;
    const updatedBefore = (await rowOf(execution.id, "TAKE_PROFIT", 1)).updatedAt;
    const revisionsBefore = await prisma!.executionEvent.count({
      where: { tradeExecutionId: execution.id, eventType: "ORDER_UPDATED" },
    });
    scenario.standardSubmitted = [];

    for (let index = 0; index < 3; index += 1) await withStandardTakeProfit(true, () => tick(execution.id));

    expect(scenario.standardSubmitted).toEqual([]);
    expect((await reload(execution.id)).version).toBe(versionBefore);
    expect((await rowOf(execution.id, "TAKE_PROFIT", 1)).updatedAt).toEqual(updatedBefore);
    expect(
      await prisma!.executionEvent.count({
        where: { tradeExecutionId: execution.id, eventType: "ORDER_UPDATED" },
      })
    ).toBe(revisionsBefore);
    await clearAlerts(execution.id);
  });

  maybe()("N3. once the gap is placeable again the SAME intent is refreshed and sent", async () => {
    const execution = await filledExecution();
    scenario.positionAmtSequence = ["0.100"];
    scenario.positionAmt = "0.040";
    await withStandardTakeProfit(true, () => protect(execution));
    expect(scenario.standardSubmitted).toEqual([]);

    // 0.060 x 108 = 6.48, above the floor.
    scenario.positionAmt = "0.060";
    await withStandardTakeProfit(true, () => tick(execution.id));

    expect(scenario.standardSubmitted.map((entry) => entry.quantity)).toEqual(["0.06"]);
    const row = await rowOf(execution.id, "TAKE_PROFIT", 1);
    expect(row.originalQuantity.toString()).toBe("0.06");
    expect(row.price!.toString()).toBe("108");
    expect(row.clientOrderId).toBe(tpIdOf(execution.id, 1));
    // Same generation: the deferral did not strand or duplicate the tranche.
    expect(await takeProfitRows(execution.id)).toHaveLength(1);
    expect((await ordersOf(execution.id)).filter((o) => o.role === "STOP_LOSS")).toHaveLength(1);
    await clearAlerts(execution.id);
  });

  maybe()("N4. an already under-notional durable intent is never posted", async () => {
    // Defensive: a row that is already too small, however it got there.
    const execution = await filledExecution();
    await withStandardTakeProfit(true, () => protect(execution));
    const row = await rowOf(execution.id, "TAKE_PROFIT", 1);
    await prisma!.binanceOrder.update({
      where: { id: row.id },
      data: { originalQuantity: "0.040", status: "SUBMITTING", submittedAt: null, submissionUnknownAt: null },
    });
    scenario.standardOrders.delete(tpIdOf(execution.id, 1));
    scenario.positionAmt = "0.040";
    scenario.standardSubmitted = [];
    scenario.mutations = [];

    await withStandardTakeProfit(true, () => tick(execution.id));

    expect(scenario.standardSubmitted).toEqual([]);
    const after = await rowOf(execution.id, "TAKE_PROFIT", 1);
    expect(after.submittedAt).toBeNull();
    expect(after.submissionUnknownAt).toBeNull();
    expect(after.orderType).toBe("LIMIT");
    await clearAlerts(execution.id);
  });

  maybe()("N5. a repair delta below the floor reserves nothing and never falls back to ALGO", async () => {
    const execution = await filledExecution();
    await withStandardTakeProfit(true, () => protect(execution));
    scenario.standardOrders.get(tpIdOf(execution.id, 1))!.status = "EXPIRED";
    // 0.040 x 108 = 4.32, below the floor.
    scenario.positionAmt = "0.040";
    scenario.mutations = [];
    scenario.standardSubmitted = [];

    for (let index = 0; index < 3; index += 1) await withStandardTakeProfit(true, () => tick(execution.id));

    expect(scenario.standardSubmitted).toEqual([]);
    expect(scenario.mutations).not.toContain("POST /fapi/v1/algoOrder TAKE_PROFIT");
    // No second generation is minted for a tranche that cannot be placed.
    expect(await takeProfitRows(execution.id)).toHaveLength(1);
    expect((await ordersOf(execution.id)).filter((o) => o.role === "STOP_LOSS")).toHaveLength(1);
    await clearAlerts(execution.id);
  });

  maybe()("27. a dormant standard intent is reused, not duplicated", async () => {
    const execution = await filledExecution();
    await withStandardTakeProfit(true, () => protect(execution));
    // The target covers the exposure exactly, so a stale sibling has no work.
    scenario.positionAmt = "0.100";
    scenario.standardSubmitted = [];

    await withStandardTakeProfit(true, () => tick(execution.id));

    expect(scenario.standardSubmitted).toEqual([]);
    expect(await takeProfitRows(execution.id)).toHaveLength(1);
    expect((await rowOf(execution.id, "TAKE_PROFIT", 1)).clientOrderId).toBe(tpIdOf(execution.id, 1));
    await clearAlerts(execution.id);
  });
});

// ===========================================================================
// A protection order that closes the WHOLE position and the position reading
// zero are not simultaneous at Binance. The fill lands on the order endpoint
// first; positionRisk settles after. One read taken inside that window says
// "filled, and exposure remains" - indistinguishable from a genuine partial
// exit - and ZROUSDT was escalated to MANUAL_INTERVENTION and parked for hours
// on exactly that reading, with the exchange already flat and clean.
//
// The same window auto-cancels the other leg, so the sibling's own
// verification query can come back unresolved about an order that is already
// gone. Both halves are covered here.
// ===========================================================================

describe("protection exit confirmation and sibling absence", () => {
  const tpIdOf = (id: string) => buildClientOrderId(id, "TAKE_PROFIT", 1);
  const stopIdOf = (id: string) => buildClientOrderId(id, "STOP_LOSS", 1);

  const clearAlerts = async (id: string) =>
    prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: id } });

  const closeOut = async (id: string) =>
    protectionService.reconcileProtectionAndClosure({
      executionId: id,
      expectedVersion: (await reload(id)).version,
      evaluatedAt: at(),
    });

  /** Runs `run` with the standard-limit take-profit switch forced on. */
  const withStandardTakeProfit = async <T>(run: () => Promise<T>): Promise<T> => {
    const key = "EXECUTION_STANDARD_LIMIT_TAKE_PROFIT_ENABLED" as const;
    const previous = (runtimeEnv as Record<string, unknown>)[key];
    (runtimeEnv as Record<string, unknown>)[key] = true;
    try {
      return await run();
    } finally {
      (runtimeEnv as Record<string, unknown>)[key] = previous;
    }
  };

  /**
   * The ZRO shape, built by the real machinery: an ALGO STOP_MARKET and a
   * STANDARD resting LIMIT take profit on one LONG position.
   */
  async function standardTakeProfitFixture() {
    const execution = await filledExecution();
    await withStandardTakeProfit(() => protect(execution));
    const takeProfit = await prisma!.binanceOrder.findFirstOrThrow({
      where: { tradeExecutionId: execution.id, role: "TAKE_PROFIT", generation: 1 },
    });
    expect(takeProfit.orderType).toBe("LIMIT");
    expect(takeProfit.clientAlgoId).toBeNull();
    scenario.mutations = [];
    scenario.submitted = [];
    scenario.standardSubmitted = [];
    scenario.openOrderListCalls = 0;
    scenario.positionReadCalls = 0;
    return reload(execution.id);
  }

  /** Both protection legs conditional, which is the pre-switch default. */
  async function algoFixture(direction: "LONG" | "SHORT" = "LONG") {
    const execution = await filledExecution({ direction });
    if (direction === "SHORT") scenario.positionAmt = "-0.100";
    await protect(execution);
    scenario.mutations = [];
    scenario.submitted = [];
    scenario.openOrderListCalls = 0;
    scenario.positionReadCalls = 0;
    return reload(execution.id);
  }

  /** The standard take profit fills for the whole position. */
  const fillStandardTakeProfit = (id: string) => {
    const row = scenario.standardOrders.get(tpIdOf(id))!;
    row.status = "FILLED";
    row.executedQty = "0.100";
    row.avgPrice = "108";
  };

  /**
   * Binance auto-cancels the other leg in the same moment, and the per-id
   * verification query issued inside that window does not resolve.
   */
  const autoCancelledAlgoSibling = (id: string, role: "STOP_LOSS" | "TAKE_PROFIT") => {
    const clientAlgoId = buildClientOrderId(id, role, 1);
    scenario.algoOrders.get(clientAlgoId)!.algoStatus = "CANCELED";
    scenario.queryFailures.add(clientAlgoId);
  };

  // ------------------------------------------------------- the ZRO regression

  maybe()("1. a settling position read does not turn a full TP exit into a partial one", async () => {
    const execution = await standardTakeProfitFixture();
    fillStandardTakeProfit(execution.id);
    autoCancelledAlgoSibling(execution.id, "STOP_LOSS");
    // Read 1 still shows the whole position; every later read shows it flat.
    scenario.positionAmtSequence = ["0.100"];
    scenario.positionAmt = "0";

    const outcome = await closeOut(execution.id);

    expect(outcome.ok).toBe(true);
    expect(outcome.reasonCode).not.toBe("PARTIAL_PROTECTION_EXIT");
    expect(outcome.reasonCode).not.toBe("SIBLING_CLEANUP_INCOMPLETE");
    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_TP");
    expect(closed.exitReason).toBe("TAKE_PROFIT");
    expect(closed.requiresManualIntervention).toBe(false);
    expect((await protectionOf(execution.id)).state).toBe("CLOSED");
    // Nothing was sent to fix it: no duplicate protection, no emergency close,
    // and no cancel of an order that was already gone.
    expect(scenario.mutations).toEqual([]);
    expect(scenario.submitted).toEqual([]);
    expect(scenario.standardSubmitted).toEqual([]);
  });

  maybe()("2. it takes exactly ONE confirmation read, and only when a leg fired", async () => {
    const execution = await standardTakeProfitFixture();
    fillStandardTakeProfit(execution.id);
    autoCancelledAlgoSibling(execution.id, "STOP_LOSS");
    scenario.positionAmtSequence = ["0.100"];
    scenario.positionAmt = "0";

    await closeOut(execution.id);

    // The closure path reads the position twice by design: once up front, and
    // once after entry cleanup to prove the entry cannot refill. The
    // confirmation is the third and last - no loop, no retry budget.
    expect(scenario.positionReadCalls).toBe(3);
    // And ONE listing, shared by every sibling that needed it.
    expect(scenario.openOrderListCalls).toBe(1);
  });

  maybe()("3. a first read that is already flat adds no confirmation read at all", async () => {
    const execution = await standardTakeProfitFixture();
    fillStandardTakeProfit(execution.id);
    scenario.positionAmt = "0";

    await closeOut(execution.id);

    expect((await reload(execution.id)).status).toBe("CLOSED_TP");
    // The ordinary two reads, and not one more.
    expect(scenario.positionReadCalls).toBe(2);
    // Every sibling resolved on its own query, so the book was never listed.
    expect(scenario.openOrderListCalls).toBe(0);
  });

  maybe()("4. an ordinary protected tick with nothing fired reads the position once", async () => {
    const execution = await algoFixture();
    scenario.positionAmt = "0.100";

    const outcome = await closeOut(execution.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("PROTECTION_COVERAGE_INCOMPLETE");
    expect(scenario.positionReadCalls).toBe(1);
    expect(scenario.openOrderListCalls).toBe(0);
    // Left exactly as it was: an open position is not a closure of any kind.
    expect((await reload(execution.id)).status).toBe(execution.status);
  });

  // ------------------------------------------------------------- fail closed

  maybe()("5. a genuinely partial exit still escalates", async () => {
    const execution = await standardTakeProfitFixture();
    const row = scenario.standardOrders.get(tpIdOf(execution.id))!;
    row.status = "FILLED";
    row.executedQty = "0.040";
    row.origQty = "0.040";
    row.avgPrice = "108";
    // Both reads agree: the exposure is real.
    scenario.positionAmt = "0.060";

    const outcome = await closeOut(execution.id);

    expect(outcome.reasonCode).toBe("PARTIAL_PROTECTION_EXIT");
    const parked = await reload(execution.id);
    expect(parked.status).toBe("MANUAL_INTERVENTION");
    expect(parked.requiresManualIntervention).toBe(true);
    expect(parked.status).not.toBe("CLOSED_TP");
    expect(scenario.positionReadCalls).toBe(2);
    await clearAlerts(execution.id);
  });

  maybe()("6. an unreadable confirmation is not flat, and never closes the trade", async () => {
    const execution = await standardTakeProfitFixture();
    fillStandardTakeProfit(execution.id);
    autoCancelledAlgoSibling(execution.id, "STOP_LOSS");
    // Read 1 sees exposure; the confirmation cannot be taken at all.
    scenario.positionAmtSequence = ["0.100", "UNAVAILABLE"];
    scenario.positionAmt = "0";

    const outcome = await closeOut(execution.id);

    expect(outcome.reasonCode).toBe("PARTIAL_PROTECTION_EXIT");
    const parked = await reload(execution.id);
    expect(parked.status).toBe("MANUAL_INTERVENTION");
    expect(parked.status).not.toBe("CLOSED_TP");
    await clearAlerts(execution.id);
  });

  // ----------------------------------------------------------- STOP symmetry

  maybe()("7. the same race on a filled STOP converges to CLOSED_SL", async () => {
    const execution = await standardTakeProfitFixture();
    const stopId = stopIdOf(execution.id);
    const stop = scenario.algoOrders.get(stopId)!;
    stop.algoStatus = "FILLED";
    stop.executedQty = "0.100";
    stop.avgPrice = "96";
    // The STANDARD take profit is the unresolved sibling this time: cancelled
    // by the exchange, and its own query does not answer.
    scenario.standardOrders.get(tpIdOf(execution.id))!.status = "CANCELED";
    scenario.queryFailures.add(tpIdOf(execution.id));
    scenario.positionAmtSequence = ["0.100"];
    scenario.positionAmt = "0";

    const outcome = await closeOut(execution.id);

    expect(outcome.ok).toBe(true);
    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_SL");
    expect(closed.exitReason).toBe("STOP_LOSS");
    expect(closed.requiresManualIntervention).toBe(false);
    expect(scenario.positionReadCalls).toBe(3);
    expect(scenario.mutations).toEqual([]);
  });

  maybe()("8. a SHORT position confirms the same way", async () => {
    const execution = await algoFixture("SHORT");
    const takeProfit = scenario.algoOrders.get(tpIdOf(execution.id))!;
    takeProfit.algoStatus = "FILLED";
    takeProfit.executedQty = "0.100";
    autoCancelledAlgoSibling(execution.id, "STOP_LOSS");
    scenario.positionAmtSequence = ["-0.100"];
    scenario.positionAmt = "0";

    await closeOut(execution.id);

    expect((await reload(execution.id)).status).toBe("CLOSED_TP");
  });

  // ------------------------------------------- absence must be PROVEN, always

  maybe()("9. an unreadable book is not absence, and cleanup stays incomplete", async () => {
    const execution = await standardTakeProfitFixture();
    fillStandardTakeProfit(execution.id);
    autoCancelledAlgoSibling(execution.id, "STOP_LOSS");
    scenario.openOrdersUnavailable = true;
    scenario.positionAmt = "0";

    const outcome = await closeOut(execution.id);

    expect(outcome.reasonCode).toBe("SIBLING_CLEANUP_INCOMPLETE");
    expect((await reload(execution.id)).status).not.toBe("CLOSED_TP");
    expect((await protectionOf(execution.id)).reasonCode).toBe("SIBLING_CLEANUP_INCOMPLETE");
    await clearAlerts(execution.id);
  });

  maybe()("10. a sibling STILL RESTING on the book is not absent", async () => {
    const execution = await standardTakeProfitFixture();
    fillStandardTakeProfit(execution.id);
    // The STOP is genuinely live; only its per-id query is unreadable. An
    // UNKNOWN sibling is never cancelled blind, so nothing resolves it.
    scenario.queryFailures.add(stopIdOf(execution.id));
    scenario.positionAmt = "0";

    const outcome = await closeOut(execution.id);

    expect(outcome.reasonCode).toBe("SIBLING_CLEANUP_INCOMPLETE");
    expect((await reload(execution.id)).status).not.toBe("CLOSED_TP");
    // The listing was consulted and answered; it just did not say what a
    // closure needs to hear.
    expect(scenario.openOrderListCalls).toBe(1);
    expect(scenario.mutations.filter((call) => call.startsWith("DELETE"))).toEqual([]);
    await clearAlerts(execution.id);
  });

  maybe()("11. absence alone never closes a trade whose position is not flat", async () => {
    // Nothing about the live book says anything about exposure. With no leg
    // fired and the position open, the closure never gets that far.
    const execution = await standardTakeProfitFixture();
    scenario.queryFailures.add(stopIdOf(execution.id));
    scenario.positionAmt = "0.100";

    const outcome = await closeOut(execution.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.reasonCode).toBe("PROTECTION_COVERAGE_INCOMPLETE");
    expect(scenario.openOrderListCalls).toBe(0);
    expect((await reload(execution.id)).status).toBe(execution.status);
  });

  // ------------------------------------------------------ restart / self-heal

  maybe()("12. a trade parked by this race converges on an ordinary later pass", async () => {
    // The whole ZRO incident end to end, built by the real machinery: escalate
    // on a settling read, then stay parked while the sibling is unverifiable,
    // then close cleanly once the exchange can be read.
    const execution = await standardTakeProfitFixture();
    fillStandardTakeProfit(execution.id);
    autoCancelledAlgoSibling(execution.id, "STOP_LOSS");

    // Pass A: the position genuinely still reads non-zero, twice.
    scenario.positionAmt = "0.100";
    expect((await closeOut(execution.id)).reasonCode).toBe("PARTIAL_PROTECTION_EXIT");
    const parked = await reload(execution.id);
    expect(parked.status).toBe("MANUAL_INTERVENTION");
    expect(parked.decisionReasonCode).toBe("PARTIAL_PROTECTION_EXIT");

    // Pass B: flat now, but the book cannot be read, so it stays parked.
    scenario.positionAmt = "0";
    scenario.openOrdersUnavailable = true;
    expect((await closeOut(execution.id)).reasonCode).toBe("SIBLING_CLEANUP_INCOMPLETE");
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");
    const midway = await protectionOf(execution.id);
    expect(midway.state).toBe("CLOSURE_CLEANUP");
    expect(midway.reasonCode).toBe("SIBLING_CLEANUP_INCOMPLETE");

    // Pass C: nothing changes except that the exchange can be read.
    scenario.openOrdersUnavailable = false;
    const outcome = await closeOut(execution.id);

    expect(outcome.ok).toBe(true);
    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_TP");
    expect(closed.exitReason).toBe("TAKE_PROFIT");
    expect(closed.requiresManualIntervention).toBe(false);
    expect((await protectionOf(execution.id)).state).toBe("CLOSED");
    // Self-healed with no operator mutation of any kind.
    expect(scenario.mutations).toEqual([]);
    await clearAlerts(execution.id);
  });

  maybe()("13. the STOP mirror of that recovery closes CLOSED_SL", async () => {
    const execution = await algoFixture();
    const stop = scenario.algoOrders.get(stopIdOf(execution.id))!;
    stop.algoStatus = "FILLED";
    stop.executedQty = "0.100";
    autoCancelledAlgoSibling(execution.id, "TAKE_PROFIT");

    scenario.positionAmt = "0.100";
    expect((await closeOut(execution.id)).reasonCode).toBe("PARTIAL_PROTECTION_EXIT");
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");

    scenario.positionAmt = "0";
    const outcome = await closeOut(execution.id);

    expect(outcome.ok).toBe(true);
    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_SL");
    expect(closed.requiresManualIntervention).toBe(false);
    await clearAlerts(execution.id);
  });
});

// ===========================================================================
// What a standard take profit ACTUALLY did
// ===========================================================================
//
// ZROUSDT closed correctly as CLOSED_TP on 68.8 filled at 1.0925, and its own
// durable row said `executedQuantity 0`, `averageFillPrice null`. The exchange
// had already returned both on the same query the closure read; they were
// parsed and discarded. `actualExitPrice` came from an ALGO-shaped field that
// is structurally null for a standard order, so the execution recorded no exit
// price either.
//
// The prices here run on the fixture's own scale rather than ZRO's, so the
// plan stays internally coherent. The average fill is deliberately NOT the
// take-profit target: that is what proves the value comes from the fill.

describe("standard take-profit fill actuals", () => {
  const TP_TARGET = "108";
  const FILL_AVERAGE = "108.4";
  const FILL_QUANTITY = "68.8";
  const EXCHANGE_ORDER_ID = "S-ZRO-1";

  const tpIdOf = (id: string) => buildClientOrderId(id, "TAKE_PROFIT", 1);
  const stopIdOf = (id: string) => buildClientOrderId(id, "STOP_LOSS", 1);

  const clearAlerts = async (id: string) =>
    prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: id } });

  const withStandardTakeProfit = async <T>(run: () => Promise<T>): Promise<T> => {
    const key = "EXECUTION_STANDARD_LIMIT_TAKE_PROFIT_ENABLED" as const;
    const previous = (runtimeEnv as Record<string, unknown>)[key];
    (runtimeEnv as Record<string, unknown>)[key] = true;
    try {
      return await run();
    } finally {
      (runtimeEnv as Record<string, unknown>)[key] = previous;
    }
  };

  const reconcile = async (id: string) =>
    protectionService.reconcileProtectionAndClosure({
      executionId: id,
      expectedVersion: (await reload(id)).version,
      evaluatedAt: at(),
    });

  const takeProfitRow = async (id: string) =>
    (await ordersOf(id)).find((order) => order.role === "TAKE_PROFIT")!;

  /** A LONG protected by an ALGO stop and a STANDARD resting LIMIT target. */
  async function standardProtected() {
    scenario.positionAmt = FILL_QUANTITY;
    const execution = await filledExecution({ filled: FILL_QUANTITY });
    await withStandardTakeProfit(() => protect(execution));
    const takeProfit = await takeProfitRow(execution.id);
    expect(takeProfit.orderType).toBe("LIMIT");
    expect(takeProfit.price!.toString()).toBe(TP_TARGET);
    expect(takeProfit.executedQuantity.toString()).toBe("0");
    expect(takeProfit.averageFillPrice).toBeNull();
    scenario.mutations = [];
    scenario.submitted = [];
    scenario.standardSubmitted = [];
    return reload(execution.id);
  }

  /** The exchange now reports the target as fully filled. */
  const fillOnExchange = (id: string, quantity = FILL_QUANTITY, average = FILL_AVERAGE) => {
    const row = scenario.standardOrders.get(tpIdOf(id))!;
    row.status = "FILLED";
    row.executedQty = quantity;
    row.avgPrice = average;
    row.orderId = EXCHANGE_ORDER_ID;
  };

  // ------------------------------------------------------------ the ZRO case

  maybe()("A/B/C/H. a filled standard target records what it filled, and at what price", async () => {
    const execution = await standardProtected();
    fillOnExchange(execution.id);
    scenario.positionAmt = "0";

    const outcome = await reconcile(execution.id);

    expect(outcome.ok).toBe(true);
    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_TP");
    expect(closed.exitReason).toBe("TAKE_PROFIT");
    expect(closed.requiresManualIntervention).toBe(false);
    // The execution's exit price is the FILL, not the target it was aiming at.
    expect(closed.actualExitPrice!.toString()).toBe(FILL_AVERAGE);
    expect(closed.actualExitPrice!.toString()).not.toBe(TP_TARGET);

    const takeProfit = await takeProfitRow(execution.id);
    expect(takeProfit.status).toBe("FILLED");
    expect(takeProfit.executedQuantity.toString()).toBe(FILL_QUANTITY);
    expect(takeProfit.averageFillPrice!.toString()).toBe(FILL_AVERAGE);
    expect(takeProfit.exchangeOrderId).toBe(EXCHANGE_ORDER_ID);

    // Nothing was submitted to fix it, and the stop was cancelled exactly once.
    expect(scenario.standardSubmitted).toEqual([]);
    expect(scenario.submitted).toEqual([]);
    expect(scenario.mutations.filter((call) => call.startsWith("DELETE"))).toHaveLength(1);
    expect(
      await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id, role: "EMERGENCY_CLOSE" } })
    ).toBe(0);
    expect((await protectionOf(execution.id)).state).toBe("CLOSED");
    await clearAlerts(execution.id);
  });

  maybe()("D. a row ALREADY marked FILLED still learns what it filled", async () => {
    // The exact production state, and the defect that made it permanent: the
    // old code returned early whenever the mapped status equalled the stored
    // one, so a row that reached FILLED before this fix could never be
    // completed. No status transition is available to carry the repair.
    const execution = await standardProtected();
    fillOnExchange(execution.id);
    await prisma!.binanceOrder.updateMany({
      where: { tradeExecutionId: execution.id, role: "TAKE_PROFIT", generation: 1 },
      data: { status: "FILLED", executedQuantity: "0", averageFillPrice: null, exchangeOrderId: null },
    });
    const stale = await takeProfitRow(execution.id);
    expect(stale.status).toBe("FILLED");
    expect(stale.executedQuantity.toString()).toBe("0");
    expect(stale.averageFillPrice).toBeNull();
    scenario.positionAmt = "0";

    await reconcile(execution.id);

    const healed = await takeProfitRow(execution.id);
    expect(healed.status).toBe("FILLED");
    expect(healed.executedQuantity.toString()).toBe(FILL_QUANTITY);
    expect(healed.averageFillPrice!.toString()).toBe(FILL_AVERAGE);
    expect(healed.exchangeOrderId).toBe(EXCHANGE_ORDER_ID);
    expect((await reload(execution.id)).actualExitPrice!.toString()).toBe(FILL_AVERAGE);
    await clearAlerts(execution.id);
  });

  // ------------------------------------------------------- partial and stale

  maybe()("E. a partial fill is captured and advances on the next observation", async () => {
    const execution = await standardProtected();
    const row = scenario.standardOrders.get(tpIdOf(execution.id))!;
    row.status = "PARTIALLY_FILLED";
    row.executedQty = "20";
    row.avgPrice = "108.1";
    // Still open: a resting LIMIT with a live remnant is not a closure.
    scenario.positionAmt = "48.8";

    await reconcile(execution.id);

    const first = await takeProfitRow(execution.id);
    expect(first.status).toBe("PARTIALLY_FILLED");
    expect(first.executedQuantity.toString()).toBe("20");
    expect(first.averageFillPrice!.toString()).toBe("108.1");

    row.executedQty = "45";
    row.avgPrice = "108.25";
    scenario.positionAmt = "23.8";

    await reconcile(execution.id);

    const second = await takeProfitRow(execution.id);
    expect(second.executedQuantity.toString()).toBe("45");
    // The aggregate average moves with the quantity it describes.
    expect(second.averageFillPrice!.toString()).toBe("108.25");
    await clearAlerts(execution.id);
  });

  maybe()("F. a stale observation can move neither the quantity nor the price", async () => {
    const execution = await standardProtected();
    const row = scenario.standardOrders.get(tpIdOf(execution.id))!;
    row.status = "PARTIALLY_FILLED";
    row.executedQty = "45";
    row.avgPrice = "108.25";
    scenario.positionAmt = "23.8";
    await reconcile(execution.id);
    expect((await takeProfitRow(execution.id)).executedQuantity.toString()).toBe("45");

    // An older view of the same order. Its average belongs to a fill we have
    // already superseded, so accepting it would pair a stale price with a
    // quantity it does not describe.
    row.executedQty = "20";
    row.avgPrice = "108.1";

    await reconcile(execution.id);

    const held = await takeProfitRow(execution.id);
    expect(held.executedQuantity.toString()).toBe("45");
    expect(held.averageFillPrice!.toString()).toBe("108.25");
    await clearAlerts(execution.id);
  });


  maybe()("a REJECTED stale quantity cannot send its average out through the closure", async () => {
    // The two rules have to be one rule. Persistence rejects a stale read's
    // average because it belongs to a fill we have already superseded; if
    // closure then read the same raw response, the execution would record an
    // exit price its own protection row disagrees with.
    const execution = await standardProtected();
    const row = scenario.standardOrders.get(tpIdOf(execution.id))!;
    row.status = "PARTIALLY_FILLED";
    row.executedQty = "45";
    row.avgPrice = "108.25";
    scenario.positionAmt = "23.8";
    await reconcile(execution.id);
    const accepted = await takeProfitRow(execution.id);
    expect(accepted.executedQuantity.toString()).toBe("45");
    expect(accepted.averageFillPrice!.toString()).toBe("108.25");

    // An older view of the same order, now arriving as a terminal reading.
    row.status = "FILLED";
    row.executedQty = "20";
    row.avgPrice = "108.1";
    scenario.positionAmt = "0";

    await reconcile(execution.id);

    const held = await takeProfitRow(execution.id);
    expect(held.executedQuantity.toString()).toBe("45");
    expect(held.averageFillPrice!.toString()).toBe("108.25");

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_TP");
    // The rejected average must not appear anywhere.
    expect(closed.actualExitPrice!.toString()).not.toBe("108.1");
    // What is attributed is exactly what the row holds.
    expect(closed.actualExitPrice!.toString()).toBe(held.averageFillPrice!.toString());
    await clearAlerts(execution.id);
  });

  maybe()("a later read with no average keeps attributing the one already proven", async () => {
    // The same rule from the other side: an authoritative average we already
    // accepted is not discarded because a later response omits it.
    const execution = await standardProtected();
    fillOnExchange(execution.id);
    scenario.positionAmt = FILL_QUANTITY;
    await reconcile(execution.id);
    expect((await takeProfitRow(execution.id)).averageFillPrice!.toString()).toBe(FILL_AVERAGE);

    const row = scenario.standardOrders.get(tpIdOf(execution.id))!;
    row.avgPrice = "0";
    scenario.positionAmt = "0";

    await reconcile(execution.id);

    expect((await takeProfitRow(execution.id)).averageFillPrice!.toString()).toBe(FILL_AVERAGE);
    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_TP");
    expect(closed.actualExitPrice!.toString()).toBe(FILL_AVERAGE);
    await clearAlerts(execution.id);
  });

  // ------------------------------------------------- absence is not a price

  maybe()("G. an unfilled target keeps a null average, never its own limit price", async () => {
    const execution = await standardProtected();
    const row = scenario.standardOrders.get(tpIdOf(execution.id))!;
    row.status = "NEW";
    row.executedQty = "0";
    // Binance reports "nothing filled yet" as a zero average.
    row.avgPrice = "0";
    scenario.positionAmt = FILL_QUANTITY;

    await reconcile(execution.id);

    const resting = await takeProfitRow(execution.id);
    expect(resting.status).toBe("NEW");
    expect(resting.executedQuantity.toString()).toBe("0");
    // Not 0, and emphatically not the target it is resting at.
    expect(resting.averageFillPrice).toBeNull();
    expect((await reload(execution.id)).actualExitPrice).toBeNull();
    await clearAlerts(execution.id);
  });

  maybe()("a FILLED target with no usable average closes, but claims no exit price", async () => {
    // Fail-open on the accounting, never on the closure: the position really is
    // closed and the attribution really is ours, so the trade must not be
    // parked. The price simply stays unknown rather than being invented.
    const execution = await standardProtected();
    fillOnExchange(execution.id, FILL_QUANTITY, "0");
    scenario.positionAmt = "0";

    const outcome = await reconcile(execution.id);

    expect(outcome.ok).toBe(true);
    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_TP");
    expect(closed.actualExitPrice).toBeNull();
    const takeProfit = await takeProfitRow(execution.id);
    expect(takeProfit.executedQuantity.toString()).toBe(FILL_QUANTITY);
    expect(takeProfit.averageFillPrice).toBeNull();
    await clearAlerts(execution.id);
  });

  // ------------------------------------------------------------ ALGO is safe

  maybe()("I. a conditional take profit still records its fill and exit price", async () => {
    // The conditional path already did this correctly and must be untouched;
    // only the field closure reads it through changed.
    scenario.positionAmt = "68.8";
    const execution = await filledExecution({ filled: "68.8" });
    await protect(execution);
    const takeProfitId = buildClientOrderId(execution.id, "TAKE_PROFIT", 1);
    const algo = scenario.algoOrders.get(takeProfitId)!;
    expect(algo.orderType).toBe("TAKE_PROFIT_MARKET");
    algo.algoStatus = "FILLED";
    algo.executedQty = "68.8";
    algo.avgPrice = "108.4";
    scenario.positionAmt = "0";

    await reconcile(execution.id);

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_TP");
    expect(closed.actualExitPrice!.toString()).toBe("108.4");
    const takeProfit = await takeProfitRow(execution.id);
    expect(takeProfit.executedQuantity.toString()).toBe("68.8");
    expect(takeProfit.averageFillPrice!.toString()).toBe("108.4");
    await clearAlerts(execution.id);
  });

  maybe()("I2. a conditional STOP still records its fill and exit price", async () => {
    scenario.positionAmt = "68.8";
    const execution = await filledExecution({ filled: "68.8" });
    await protect(execution);
    const stop = scenario.algoOrders.get(stopIdOf(execution.id))!;
    stop.algoStatus = "FILLED";
    stop.executedQty = "68.8";
    stop.avgPrice = "95.8";
    scenario.positionAmt = "0";

    await reconcile(execution.id);

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_SL");
    expect(closed.exitReason).toBe("STOP_LOSS");
    expect(closed.actualExitPrice!.toString()).toBe("95.8");
    await clearAlerts(execution.id);
  });
});
