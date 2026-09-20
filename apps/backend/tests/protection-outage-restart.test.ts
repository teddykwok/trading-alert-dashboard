import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";
import type { DynamicLeveragePlan } from "@trading-alert-dashboard/shared";
import { testProfileProjection } from "./helpers/bound-runtime";

/**
 * The 2026-08-26 outage, reconstructed: what a restart actually repairs.
 *
 * ## The incident
 *
 * The worker stopped between 13:58:01 and 13:59:06 with four executions
 * PROTECTED. Their STOP and TAKE_PROFIT legs stayed resting on Binance, so the
 * exchange could — and did — close those positions while nothing local was
 * watching. Two days later the database still read PROTECTED, closedAt null,
 * with no sibling cancellation ever attempted.
 *
 * That local state is consistent with TWO very different causes, and the
 * difference decides what gets fixed:
 *
 *   1. reconciliation is unable to repair the state after a restart, or
 *   2. reconciliation was never given the chance, because the worker never
 *      came back.
 *
 * These tests exist to tell those apart with evidence rather than argument, so
 * they deliberately do NOT stub the thing under test. `execution-restart-
 * recovery.test.ts` fakes `reconcileProtectionAndClosure` to prove ORCHESTRATOR
 * ROUTING; that fake cannot answer this question. Here the real
 * `ProtectionLifecycleService` and the real `ExecutionOrchestrator` run against
 * a fake exchange, entered through `runStartupRecovery()` — the exact call the
 * scheduler makes on boot.
 *
 * ## What "restart" means here
 *
 * Every runtime object is discarded and rebuilt by `freshRuntime()`. What
 * crosses the boundary is only what survives a real process death: the Postgres
 * rows and the exchange's own state. Nothing is toggled on a surviving service,
 * because that would prove nothing about a restart.
 *
 * ## Flat is modelled as a MISSING position row
 *
 * On real Binance a closed position does not come back as quantity "0" — the
 * row is omitted entirely. `readPosition` maps that absence to null and only
 * `reconcileProtectionAndClosure` reads it as flat, which is why the
 * orchestrator runs closure BEFORE the coverage-health path. Modelling flat as
 * "0" instead would exercise an exchange that does not exist.
 */

process.env.EXECUTION_GLOBAL_KILL_SWITCH = "false";
process.env.EXECUTION_LIVE_ENTRY_ENABLED = "false";
process.env.EXECUTION_PROTECTION_READY = "false";
process.env.EXECUTION_AUTO_ADD_MARGIN_ENABLED = "false";
process.env.EXECUTION_EMERGENCY_CLOSE_MODE = "DISABLED";
process.env.EXECUTION_SL_WORKING_TYPE = "CONTRACT_PRICE";
process.env.EXECUTION_TP_WORKING_TYPE = "CONTRACT_PRICE";
process.env.BINANCE_FUTURES_REST_BASE_URL = "https://testnet.binancefuture.example";

const SYNTHETIC_TAG = "outage-restart-synthetic";
const SYMBOL = "TESTOUTUSDT";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ExecutionService } = await import("../src/modules/execution/execution.service");
const { ProtectionLifecycleService } = await import("../src/modules/execution/protection-lifecycle.service");
const { EntryLifecycleService } = await import("../src/modules/execution/entry-lifecycle.service");
const { SafetyAdmissionService } = await import("../src/modules/execution/safety-admission.service");
const { CriticalAlertService } = await import("../src/modules/execution/critical-alert.service");
const { ExecutionOrchestrator } = await import("../src/modules/execution/execution-orchestrator");
const { BinanceError } = await import("../src/modules/binance/binance.errors");
const { buildClientOrderId } = await import("../src/modules/execution/execution-safety");

// ---------------------------------------------------------------------------
// The exchange. Survives a restart, exactly like the real one.
// ---------------------------------------------------------------------------

interface AlgoRow {
  algoStatus: string;
  executedQty: string;
  avgPrice: string;
  side: string;
  positionSide: string;
  orderType: string;
  quantity: string;
  triggerPrice: string;
  workingType: string;
}

class FakeExchange {
  /** null models a MISSING position row, which is how Binance reports flat. */
  positionAmt: string | null = "0.250";
  /** Every position read throws — a timeout, not a closure. */
  positionUnavailable = false;
  readonly algo = new Map<string, AlgoRow>();
  /** clientAlgoId values whose QUERY fails (ambiguous, never absence). */
  readonly queryFailures = new Set<string>();
  /** clientAlgoId values whose CANCEL fails. */
  readonly cancelFailures = new Set<string>();
  entryStatus = "FILLED";
  entryVisible = true;
  /** Observability: every mutation the runtime actually dispatched. */
  readonly cancelled: string[] = [];
  readonly submitted: string[] = [];
}

function timeoutError(endpoint: string) {
  return new BinanceError({ kind: "TIMEOUT", message: "timed out", endpoint });
}

function notFound(endpoint: string) {
  return new BinanceError({
    kind: "MALFORMED_RESPONSE",
    message: "does not exist",
    binanceCode: -2013,
    endpoint,
  });
}

function readOnlyFor(exchange: FakeExchange) {
  return {
    async getPositionForSide(_symbol: string, positionSide: string) {
      if (exchange.positionUnavailable) throw timeoutError("positionRisk");
      if (exchange.positionAmt === null) return null;
      return {
        symbol: SYMBOL,
        positionSide,
        positionAmt: exchange.positionAmt,
        entryPrice: "100",
        markPrice: "100",
        liquidationPrice: "90",
        isolatedMargin: "10.00",
        isolatedWallet: "10.00",
        leverage: "10",
        unrealizedProfit: "0",
        notional: "25",
        marginType: "isolated",
      };
    },
    async queryAlgoOrderByClientAlgoId(_symbol: string, clientAlgoId: string) {
      if (exchange.queryFailures.has(clientAlgoId)) throw timeoutError("algoOrder");
      const row = exchange.algo.get(clientAlgoId);
      if (!row) throw notFound("algoOrder");
      return {
        algoId: `A-${clientAlgoId}`,
        clientAlgoId,
        symbol: SYMBOL,
        algoStatus: row.algoStatus,
        algoType: "CONDITIONAL",
        side: row.side,
        positionSide: row.positionSide,
        orderType: row.orderType,
        quantity: row.quantity,
        triggerPrice: row.triggerPrice,
        workingType: row.workingType,
        priceProtect: false,
        closePosition: false,
        // Binance's Algo Service sets reduceOnly itself on a hedge-mode closing
        // conditional order and reports it back as true.
        reduceOnly: true,
        actualOrderId: null,
        executedQuantity: row.executedQty,
        averagePrice: row.avgPrice,
        triggerTimeMs: null,
        updateTimeMs: Date.now(),
      };
    },
    async queryOrderByClientOrderId(_symbol: string, clientOrderId: string) {
      if (!exchange.entryVisible) throw timeoutError("order");
      return {
        orderId: "E-1",
        clientOrderId,
        symbol: SYMBOL,
        status: exchange.entryStatus,
        side: "BUY",
        positionSide: "LONG",
        type: "LIMIT",
        timeInForce: "GTC",
        price: "100",
        origQty: "0.250",
        executedQty: exchange.entryStatus === "FILLED" ? "0.250" : "0",
        averagePrice: "100",
        reduceOnly: false,
        closePosition: false,
        updateTimeMs: Date.now(),
      };
    },
    async inspectSymbol(symbol: string) {
      return {
        filters: {
          symbol,
          status: "TRADING",
          contractType: "PERPETUAL",
          tickSize: "0.01",
          stepSize: "0.001",
          minQty: "0.001",
          minNotional: "5",
        },
        brackets: [
          {
            bracket: 1,
            initialLeverage: 50,
            notionalCap: "100000",
            notionalFloor: "0",
            maintMarginRatio: "0.01",
            cum: "0",
          },
        ],
        maxInitialLeverage: 50,
        accountSymbolConfig: null,
      };
    },
    async getPositionMarginHistory() {
      return [];
    },
  };
}

function mutationsFor(exchange: FakeExchange) {
  return {
    get mutationsDispatched() {
      return 0;
    },
    get blockedReason() {
      return "LIVE_ENTRY_DISABLED";
    },
    authorizeProtectionSubmission(input: Record<string, unknown>) {
      if (
        buildClientOrderId(String(input.executionId), String(input.role), Number(input.generation)) !==
        input.clientAlgoId
      ) {
        throw new Error("client algo id does not belong to this tranche");
      }
      return { ...input, kind: "PROTECTION_SUBMISSION" };
    },
    authorizeProtectionCancellation(input: Record<string, unknown>) {
      if (
        buildClientOrderId(String(input.executionId), String(input.role), Number(input.generation)) !==
        input.clientAlgoId
      ) {
        throw new Error("client algo id does not belong to this tranche");
      }
      return { ...input, kind: "PROTECTION_CANCELLATION" };
    },
    authorizeMarginAddition(input: Record<string, unknown>) {
      return { ...input, kind: "MARGIN_ADDITION" };
    },
    authorizeEmergencyClose(input: Record<string, unknown>) {
      return { ...input, kind: "EMERGENCY_CLOSE" };
    },
    authorizeEntryCancellation(input: Record<string, unknown>) {
      return { ...input, kind: "ENTRY_CANCELLATION" };
    },
    async submitProtectionOrder(context: Record<string, string>) {
      exchange.submitted.push(context.clientAlgoId);
      exchange.algo.set(context.clientAlgoId, {
        algoStatus: "NEW",
        executedQty: "0",
        avgPrice: "0",
        side: context.side,
        positionSide: context.positionSide,
        orderType: context.role === "STOP_LOSS" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
        quantity: context.quantity,
        triggerPrice: context.triggerPrice,
        workingType: context.workingType,
      });
      return { algoId: "A1", clientAlgoId: context.clientAlgoId, symbol: SYMBOL, algoStatus: "NEW" };
    },
    async cancelProtectionOrder(context: Record<string, string>) {
      exchange.cancelled.push(context.clientAlgoId);
      if (exchange.cancelFailures.has(context.clientAlgoId)) throw timeoutError("cancelAlgoOrder");
      const row = exchange.algo.get(context.clientAlgoId);
      if (row) row.algoStatus = "CANCELED";
      return { algoId: "A1", clientAlgoId: context.clientAlgoId, symbol: SYMBOL, algoStatus: "CANCELED" };
    },
    async cancelReservedEntryOrder(context: Record<string, string>) {
      exchange.entryStatus = "CANCELED";
      return { orderId: "E-1", clientOrderId: context.clientOrderId, symbol: SYMBOL, status: "CANCELED" };
    },
    async addIsolatedMargin() {
      return { code: 200, msg: "success" };
    },
    async submitEmergencyMarketClose(context: Record<string, string>) {
      return { orderId: "X1", clientOrderId: context.clientOrderId, symbol: SYMBOL, status: "NEW" };
    },
  };
}

// ---------------------------------------------------------------------------
// The restart itself: every runtime object rebuilt over surviving state.
// ---------------------------------------------------------------------------

function freshRuntime(exchange: FakeExchange) {
  const readOnly = readOnlyFor(exchange) as never;
  const mutations = mutationsFor(exchange) as never;
  const alerts = new CriticalAlertService(prisma!, async () => false);
  const protection = new ProtectionLifecycleService(prisma!, readOnly, mutations, alerts, {
    reconcileMaxAttempts: 2,
  });
  const orchestrator = new ExecutionOrchestrator({
    prisma: prisma!,
    readOnly,
    admission: new SafetyAdmissionService(prisma!, readOnly),
    entry: new EntryLifecycleService(prisma!, readOnly, mutations),
    protection,
    // The profile this orchestrator OWNS, projected as production does
    // from the runtime that also produced its clients' credentials.
    boundProfile: testProfileProjection({ executionProfileId: profileId }),
  });
  return { orchestrator, protection };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let executions: InstanceType<typeof ExecutionService>;
let profileId = "";
let sequence = 0;

function readyPlan(): DynamicLeveragePlan {
  return {
    status: "READY", reason: null, reasonMessage: null, symbol: SYMBOL, direction: "LONG",
    entryPrice: "100", stopLoss: "96", calculatedStopLoss: "96", executableStopLoss: "96",
    stopAdjustment: "0", stopNormalization: null, stopLossSource: "CALCULATED", stopDistance: "4",
    riskBudgetUsd: "1.50", quantityRaw: "0.250", roundedQuantity: "0.250", quantityStepSize: "0.001",
    actualPlannedLoss: "1.0", unusedRiskBudget: "0", positionNotional: "25", minimumNotional: "5",
    targetMarginMultiplier: "2.5", maximumMarginMultiplier: "3.333333", targetIsolatedMargin: "2.50",
    maximumIsolatedMargin: "5.00", applicableBracket: null, maximumSupportedLeverage: 50,
    binanceMaximumSupportedLeverage: 50, userMaximumAutomationLeverage: 25, usableMaximumLeverage: 25,
    selectedLeverage: 10, estimatedInitialMargin: "2.50", estimatedLiquidationPrice: "90.1",
    requiredLiquidationBoundary: "94", liquidationBufferRatio: "0.5", liquidationDistance: "5.9",
    safetyBufferDistance: "2", marginDifferenceFromTarget: "0", candidates: [], warnings: [],
  } as DynamicLeveragePlan;
}

/**
 * An execution in the EXACT state the four Aug 26 trades were in at 13:58:01:
 * fully filled, PROTECTED, with a verified STOP and TAKE_PROFIT resting on the
 * exchange. Built through the real services, never hand-written into the table.
 */
async function protectedExecution(exchange: FakeExchange) {
  sequence += 1;
  const alert = await prisma!.alert.create({
    data: {
      symbol: SYMBOL, assetType: "CRYPTO", exchange: "SYNTHETIC", timeframe: "15m", price: 100,
      signal: "LONG", indicatorName: `${SYNTHETIC_TAG}-${sequence}`,
      rawPayload: { note: SYNTHETIC_TAG }, triggeredAt: new Date(),
    },
  });
  const created = await executions.createExecutionFromReadyPlan({
    executionProfileId: profileId,
    alertId: alert.id,
    plan: readyPlan(),
    positionSide: "LONG",
    selectedLookback: 200,
    takeProfit: "108",
    snapshots: { exchangeFilters: { tickSize: "0.01" } },
  });

  // The entry that produced the exposure: filled, terminal, cannot refill.
  await prisma!.binanceOrder.create({
    data: {
      tradeExecutionId: created.id, role: "ENTRY", generation: 1,
      clientOrderId: buildClientOrderId(created.id, "ENTRY", 1),
      side: "BUY", positionSide: "LONG", orderType: "LIMIT", timeInForce: "GTC",
      price: "100", originalQuantity: "0.250", executedQuantity: "0.250",
      averageFillPrice: "100", status: "FILLED",
    },
  });

  await prisma!.tradeExecution.update({
    where: { id: created.id },
    data: { status: "ENTRY_FILLED", filledQuantity: "0.250", version: { increment: 1 } },
  });

  // Protection placed by the REAL service, so both legs carry the deterministic
  // ids the post-restart runtime will look them up by.
  const before = await reload(created.id);
  const { protection } = freshRuntime(exchange);
  await protection.ensureProtectionForExposure({
    executionId: created.id,
    expectedVersion: before.version,
    evaluatedAt: new Date(),
  });

  const execution = await reload(created.id);
  expect(execution.status).toBe("PROTECTED");
  return execution;
}

const reload = async (id: string) => prisma!.tradeExecution.findUniqueOrThrow({ where: { id } });
const ordersOf = async (id: string) =>
  prisma!.binanceOrder.findMany({ where: { tradeExecutionId: id }, orderBy: [{ role: "asc" }] });
const legOf = async (id: string, role: "STOP_LOSS" | "TAKE_PROFIT") =>
  (await ordersOf(id)).find((order) => order.role === role)!;
const alertsOf = async (id: string) =>
  prisma!.criticalAlert.findMany({ where: { tradeExecutionId: id } });
const eventsOf = async (id: string) =>
  prisma!.executionEvent.findMany({ where: { tradeExecutionId: id }, orderBy: { sequenceNumber: "asc" } });

const stopId = (id: string) => buildClientOrderId(id, "STOP_LOSS", 1);
const tpId = (id: string) => buildClientOrderId(id, "TAKE_PROFIT", 1);

/** The outage: a leg fills and the position goes flat with nothing watching. */
function fillLegWhileOffline(exchange: FakeExchange, clientAlgoId: string, avgPrice: string) {
  const row = exchange.algo.get(clientAlgoId)!;
  row.algoStatus = "FILLED";
  row.executedQty = "0.250";
  row.avgPrice = avgPrice;
  exchange.positionAmt = null; // the row disappears, as it does on Binance
}

beforeAll(async () => {
  if (!prisma || !available) return;
  executions = new ExecutionService(prisma);
  const profile = await prisma.executionProfile.create({
    data: {
      name: "Outage restart synthetic profile",
      accountIdentifier: `${SYNTHETIC_TAG}-account`,
      environment: "TESTNET",
      isEnabled: true,
    },
  });
  profileId = profile.id;
  // A real policy row, so the orchestrator's soft-target probe reads authentic
  // limits instead of degrading through its warn-and-continue path.
  await prisma.executionSafetyPolicy.create({
    data: {
      executionProfileId: profileId,
      maxOpenPositions: 5, maxPendingEntries: 5, maxTotalActiveTrades: 5,
      maxActivePerSymbolSide: 1, maxAlertAgeSeconds: 300, softOpenPositionTarget: 5,
      maxTotalPlannedRiskUsd: "50", maxTotalIsolatedMarginUsd: "500",
    },
  });
});

afterEach(async () => {
  if (!prisma || !available) return;
  // Retire this file's rows so the next test's startup recovery — which scans
  // every non-terminal execution, not just this profile's — cannot inherit them.
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

const maybe = () => (available ? it : it.skip);

// A generous batch: startup recovery scans every non-terminal execution in the
// database, so a fixed small batch could order this file's rows out of the pass.
const recover = async (exchange: FakeExchange) =>
  freshRuntime(exchange).orchestrator.runStartupRecovery({ batchSize: 200 });

// ===========================================================================
// CASE A — the take profit filled while the worker was gone
// ===========================================================================

describe("CASE A. TP filled during the outage, STOP left resting", () => {
  maybe()("terminalizes as CLOSED_TP from authoritative fill evidence", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    fillLegWhileOffline(exchange, tpId(execution.id), "108");
    await recover(exchange);

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_TP");
    expect(closed.exitReason).toBe("TAKE_PROFIT");
    expect(closed.closedAt).not.toBeNull();
    // Attribution comes from the FILLED leg, never from "the position is flat".
    expect(closed.actualExitPrice?.toString()).toContain("108");
  });

  maybe()("cancels the orphaned STOP sibling and verifies the cancellation", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    fillLegWhileOffline(exchange, tpId(execution.id), "108");
    await recover(exchange);

    expect(exchange.cancelled).toEqual([stopId(execution.id)]);
    expect(exchange.algo.get(stopId(execution.id))!.algoStatus).toBe("CANCELED");

    // Cancellation is proven by a READBACK, never by the DELETE response and
    // never by a locally-set flag: `cancelSibling` re-queries the id afterwards
    // and only a non-active status counts as cleaned up. `cancelRequestedAt` /
    // `cancelConfirmedAt` are deliberately NOT written here — they belong to
    // the entry lifecycle, and a protection leg records its outcome as
    // observed exchange state instead.
    const stop = await legOf(execution.id, "STOP_LOSS");
    expect(stop.status).toBe("CANCELED");
    expect(stop.algoStatus).toBe("CANCELED");
    expect(stop.lastReconcileAt).not.toBeNull();
  });

  maybe()("releases capacity and reservations by reaching a capacity-free status", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    fillLegWhileOffline(exchange, tpId(execution.id), "108");
    await recover(exchange);

    // Reservations are DERIVED from status, never a separate counter, so a
    // terminal status is what releases them — and nothing can double-release.
    const { CAPACITY_FREE_STATUSES } = await import("../src/modules/execution/capacity-status");
    expect(CAPACITY_FREE_STATUSES).toContain((await reload(execution.id)).status);
    expect((await reload(execution.id)).requiresManualIntervention).toBe(false);
  });

  maybe()("neither resubmits protection nor records a false external close", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);
    exchange.submitted.length = 0;

    fillLegWhileOffline(exchange, tpId(execution.id), "108");
    await recover(exchange);

    expect(exchange.submitted).toEqual([]);
    expect(await ordersOf(execution.id)).toHaveLength(3); // ENTRY + STOP + TP
    expect((await reload(execution.id)).status).not.toBe("CLOSED_EXTERNAL");
  });
});

// ===========================================================================
// CASE B — the mirror: the stop filled
// ===========================================================================

describe("CASE B. SL filled during the outage, TP left resting", () => {
  maybe()("terminalizes as CLOSED_SL and cleans up the take-profit sibling", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    fillLegWhileOffline(exchange, stopId(execution.id), "96");
    await recover(exchange);

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_SL");
    expect(closed.exitReason).toBe("STOP_LOSS");
    expect(exchange.cancelled).toEqual([tpId(execution.id)]);
    expect((await legOf(execution.id, "TAKE_PROFIT")).status).toBe("CANCELED");
  });

  maybe()("cleans up a loss exactly as it cleans up a win", async () => {
    // Cleanup must never depend on profit vs loss. Same shape, both directions.
    const win = new FakeExchange();
    const winner = await protectedExecution(win);
    fillLegWhileOffline(win, tpId(winner.id), "108");
    await recover(win);

    const loss = new FakeExchange();
    const loser = await protectedExecution(loss);
    fillLegWhileOffline(loss, stopId(loser.id), "96");
    await recover(loss);

    expect(win.cancelled).toHaveLength(1);
    expect(loss.cancelled).toHaveLength(1);
    expect((await reload(winner.id)).closedAt).not.toBeNull();
    expect((await reload(loser.id)).closedAt).not.toBeNull();
  });
});

// ===========================================================================
// CASE C — flat, but nothing of ours can be shown to have filled
// ===========================================================================

describe("CASE C. flat with no authoritative fill evidence", () => {
  maybe()("closes as CLOSED_EXTERNAL rather than guessing TP or SL", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    // Both legs resolved WITHOUT filling — cancelled out from under us, or
    // expired. A manual close, another client, a liquidation and ADL are all
    // indistinguishable from here.
    exchange.algo.get(stopId(execution.id))!.algoStatus = "CANCELED";
    exchange.algo.get(tpId(execution.id))!.algoStatus = "EXPIRED";
    exchange.positionAmt = null;

    await recover(exchange);

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_EXTERNAL");
    expect(closed.exitReason).toBe("EXTERNAL");
    // Inventing an exit price or a PnL would corrupt the journal.
    expect(closed.actualExitPrice).toBeNull();
    expect(closed.realizedPnl).toBeNull();
  });

  maybe()("never attributes an unowned close to a leg that merely existed", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    // A leg still RESTING while the position is flat proves nothing about what
    // closed it, so it must not become CLOSED_SL.
    exchange.algo.get(tpId(execution.id))!.algoStatus = "CANCELED";
    exchange.positionAmt = null;

    await recover(exchange);

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_EXTERNAL");
    expect(["TAKE_PROFIT", "STOP_LOSS"]).not.toContain(closed.exitReason);
    // The still-resting stop is withdrawn all the same: flat means cleanup.
    expect(exchange.cancelled).toEqual([stopId(execution.id)]);
  });
});

// ===========================================================================
// CASE D — the exchange cannot be read
// ===========================================================================

describe("CASE D. UNKNOWN / ambiguous exchange observations", () => {
  maybe()("an unreadable position closes nothing and cancels nothing", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    exchange.positionUnavailable = true;
    await recover(exchange);

    const after = await reload(execution.id);
    expect(after.status).toBe("PROTECTED");
    expect(after.closedAt).toBeNull();
    expect(exchange.cancelled).toEqual([]);
  });

  maybe()("an unreadable sibling blocks terminalization even when a leg DID fill", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    fillLegWhileOffline(exchange, tpId(execution.id), "108");
    // The stop's state cannot be read. Absence is NOT provable from a timeout,
    // so there may still be a live order out there.
    exchange.queryFailures.add(stopId(execution.id));

    await recover(exchange);

    const after = await reload(execution.id);
    // No terminal status and no attribution: the trade is NOT declared closed
    // on evidence that is incomplete.
    expect(after.status).not.toBe("CLOSED_TP");
    expect(after.status).not.toBe("CLOSED_EXTERNAL");
    expect(after.closedAt).toBeNull();
    expect(after.exitReason).toBeNull();

    // It escalates instead, and the escalation is what fails closed: a parked
    // execution keeps requiresManualIntervention set, which holds the whole
    // profile in RECOVERY_REQUIRED so no new work is admitted over an exchange
    // nobody can fully see.
    expect(after.status).toBe("MANUAL_INTERVENTION");
    expect(after.requiresManualIntervention).toBe(true);
    expect(await alertsOf(execution.id)).not.toHaveLength(0);
  });

  maybe()("keeps the orphan-order warning durable even though the reason code is overwritten", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    fillLegWhileOffline(exchange, tpId(execution.id), "108");
    exchange.queryFailures.add(stopId(execution.id));

    await recover(exchange);

    // TWO things happen in this single pass, and it is worth pinning which
    // record survives. Closure runs first and cannot finish, raising
    // SIBLING_CANCELLATION_FAILED. The coverage-health half then runs — the
    // orchestrator calls it whenever closure leaves the execution unfinished —
    // sees a position that is gone, and escalates. That escalation is the LAST
    // writer, so it overwrites the reason code on BOTH the execution and the
    // protection row.
    //
    // The consequence an operator has to live with: the status line says
    // POSITION_NOT_FOUND_AFTER_FILL (true, but not the actionable part) while
    // the thing that actually needs a human — a stop that may still be resting
    // on Binance — is recorded only as a CriticalAlert. That alert is
    // therefore the durable evidence, and this test exists to keep it so.
    const alertTypes = (await alertsOf(execution.id)).map((row) => row.alertType);
    expect(alertTypes).toContain("SIBLING_CANCELLATION_FAILED");

    const protectionRow = await prisma!.executionProtectionState.findUniqueOrThrow({
      where: { tradeExecutionId: execution.id },
    });
    expect(protectionRow.reasonCode).toBe("POSITION_NOT_FOUND_AFTER_FILL");
    expect((await reload(execution.id)).decisionReasonCode).toBe("POSITION_NOT_FOUND_AFTER_FILL");

    // Whatever the labelling, the unreadable stop was never reported as
    // cleaned up — which is the part that must never be wrong.
    expect((await legOf(execution.id, "STOP_LOSS")).status).not.toBe("CANCELED");
  });

  maybe()("a failed cancellation leaves the execution open for the next pass", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    fillLegWhileOffline(exchange, tpId(execution.id), "108");
    exchange.cancelFailures.add(stopId(execution.id));

    await recover(exchange);

    expect((await reload(execution.id)).status).not.toBe("CLOSED_TP");
    expect((await reload(execution.id)).closedAt).toBeNull();
  });

  maybe()("recovers on a later restart once the exchange answers again", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    fillLegWhileOffline(exchange, tpId(execution.id), "108");
    exchange.queryFailures.add(stopId(execution.id));
    await recover(exchange);
    // Parked, because the stop could not be seen.
    expect((await reload(execution.id)).status).toBe("MANUAL_INTERVENTION");

    // The transport comes back. This is the property that matters most: the
    // escalation is NOT a dead end. MANUAL_INTERVENTION is itself reconcilable
    // and routes to closure FIRST, so the same automatic path completes the
    // trade — no operator action, no special mode, no CLI.
    exchange.queryFailures.clear();
    await recover(exchange);

    const closed = await reload(execution.id);
    expect(closed.status).toBe("CLOSED_TP");
    expect((await legOf(execution.id, "STOP_LOSS")).status).toBe("CANCELED");
  });

  maybe()("an unresolvable entry order blocks closure and keeps protection in place", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    fillLegWhileOffline(exchange, tpId(execution.id), "108");
    // The entry cannot be read, so it cannot be proven unable to refill.
    exchange.entryVisible = false;

    await recover(exchange);

    const after = await reload(execution.id);
    expect(after.status).not.toBe("CLOSED_TP");
    // Siblings are deliberately LEFT IN PLACE: an unresolved entry could still
    // refill, and it must not refill unprotected.
    expect(exchange.cancelled).toEqual([]);
    expect((await legOf(execution.id, "STOP_LOSS")).status).not.toBe("CANCELED");
  });
});

// ===========================================================================
// CASE E — both legs terminal
// ===========================================================================

describe("CASE E. both protection legs terminal", () => {
  maybe()("both resolved without filling is an EXTERNAL close, not an invented winner", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    exchange.algo.get(stopId(execution.id))!.algoStatus = "CANCELED";
    exchange.algo.get(tpId(execution.id))!.algoStatus = "CANCELED";
    exchange.positionAmt = null;

    await recover(exchange);

    expect((await reload(execution.id)).status).toBe("CLOSED_EXTERNAL");
    expect((await reload(execution.id)).exitReason).toBe("EXTERNAL");
  });

  maybe()("a protection fill with exposure REMAINING is escalated, never closed", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    // The TP filled but the position is not flat: a partial exit, which is a
    // critical condition rather than a terminal state.
    exchange.algo.get(tpId(execution.id))!.algoStatus = "FILLED";
    exchange.algo.get(tpId(execution.id))!.executedQty = "0.100";
    exchange.positionAmt = "0.150";

    await recover(exchange);

    const after = await reload(execution.id);
    expect(after.status).toBe("MANUAL_INTERVENTION");
    expect(after.closedAt).toBeNull();
    expect((await alertsOf(execution.id)).map((row) => row.alertType)).toContain(
      "PROTECTION_COVERAGE_INCOMPLETE"
    );
  });

  maybe()("resolves deterministically when both legs report FILLED", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    fillLegWhileOffline(exchange, tpId(execution.id), "108");
    const stop = exchange.algo.get(stopId(execution.id))!;
    stop.algoStatus = "FILLED";
    stop.executedQty = "0.250";
    stop.avgPrice = "96";

    await recover(exchange);

    // Same evidence must always produce the same answer. Whatever the
    // precedence is, it is FIXED and it is one of the two owned legs — never a
    // coin flip and never an unattributed EXTERNAL close.
    const closed = await reload(execution.id);
    expect(["CLOSED_TP", "CLOSED_SL"]).toContain(closed.status);
    expect(closed.status).toBe("CLOSED_TP");
    expect(closed.exitReason).toBe("TAKE_PROFIT");
  });
});

// ===========================================================================
// CASE F — the ordinary restart: nothing happened while we were away
// ===========================================================================

describe("CASE F. restart with the position still open", () => {
  maybe()("stays PROTECTED and creates no duplicate protection", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);
    exchange.submitted.length = 0;

    await recover(exchange);

    const after = await reload(execution.id);
    expect(after.status).toBe("PROTECTED");
    expect(after.closedAt).toBeNull();
    expect(exchange.submitted).toEqual([]);
    expect(exchange.cancelled).toEqual([]);
    expect(await ordersOf(execution.id)).toHaveLength(3);
  });

  maybe()("survives repeated restarts without drifting", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);
    exchange.submitted.length = 0;

    for (let restart = 0; restart < 3; restart += 1) await recover(exchange);

    expect((await reload(execution.id)).status).toBe("PROTECTED");
    expect(exchange.submitted).toEqual([]);
    expect(await ordersOf(execution.id)).toHaveLength(3);
    expect(await prisma!.binanceOrder.count({
      where: { tradeExecutionId: execution.id, role: "EMERGENCY_CLOSE" },
    })).toBe(0);
  });
});

// ===========================================================================
// IDEMPOTENCY — a restart loop must be as safe as a single restart
// ===========================================================================

describe("repeated recovery after the outage is idempotent", () => {
  maybe()("three further restarts change nothing after a TP closure", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    fillLegWhileOffline(exchange, tpId(execution.id), "108");
    await recover(exchange);

    const settled = await reload(execution.id);
    const eventsAfterFirst = (await eventsOf(execution.id)).length;
    const alertsAfterFirst = (await alertsOf(execution.id)).length;

    for (let restart = 0; restart < 3; restart += 1) await recover(exchange);

    const final = await reload(execution.id);
    // A terminal execution is not reconcilable at all, so nothing re-enters it.
    expect(final.status).toBe("CLOSED_TP");
    expect(final.version).toBe(settled.version);
    expect(final.closedAt?.toISOString()).toBe(settled.closedAt?.toISOString());
    expect((await eventsOf(execution.id)).length).toBe(eventsAfterFirst);
    expect((await alertsOf(execution.id)).length).toBe(alertsAfterFirst);
  });

  maybe()("issues no second cancel once the first is confirmed", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    fillLegWhileOffline(exchange, tpId(execution.id), "108");
    await recover(exchange);
    expect(exchange.cancelled).toHaveLength(1);

    for (let restart = 0; restart < 3; restart += 1) await recover(exchange);
    expect(exchange.cancelled).toHaveLength(1);
  });

  maybe()("raises no duplicate CriticalAlert while a stall persists", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    fillLegWhileOffline(exchange, tpId(execution.id), "108");
    exchange.queryFailures.add(stopId(execution.id));

    for (let restart = 0; restart < 3; restart += 1) await recover(exchange);

    const raised = await alertsOf(execution.id);
    const cleanupAlerts = raised.filter((row) => row.alertType === "SIBLING_CANCELLATION_FAILED");
    // Idempotent per dedupe key: repeated reconciliation of one condition
    // reuses the row rather than burying the operator in duplicates.
    expect(cleanupAlerts).toHaveLength(1);
  });

  maybe()("does not reopen or re-protect a terminal execution", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);

    fillLegWhileOffline(exchange, stopId(execution.id), "96");
    await recover(exchange);
    expect((await reload(execution.id)).status).toBe("CLOSED_SL");

    // The position "reappears" — a wrong read, another client, anything. A
    // terminal execution is outside RECONCILABLE_STATUSES and must not revive.
    exchange.positionAmt = "0.250";
    exchange.submitted.length = 0;
    await recover(exchange);

    expect((await reload(execution.id)).status).toBe("CLOSED_SL");
    expect(exchange.submitted).toEqual([]);
  });
});

// ===========================================================================
// The structural claim the post-mortem rests on
// ===========================================================================

describe("what the Aug 26 evidence actually shows", () => {
  maybe()("a PROTECTED execution is discovered by startup recovery with no operator action", async () => {
    const exchange = new FakeExchange();
    const execution = await protectedExecution(exchange);
    fillLegWhileOffline(exchange, tpId(execution.id), "108");

    // No id is passed in and no queue message is replayed: recovery finds the
    // row by scanning persisted state, which is why the original BullMQ
    // delivery is unnecessary for the execution to survive.
    const result = await recover(exchange);

    expect(result.failed).toBe(false);
    expect(result.inspected).toBeGreaterThan(0);
    expect((await reload(execution.id)).status).toBe("CLOSED_TP");
  });

  maybe()("PROTECTED is routed to closure reconciliation by the orchestrator itself", async () => {
    const { RECONCILABLE_STATUSES } = await import("../src/modules/execution/execution-orchestrator");
    // If PROTECTED were not reconcilable, no restart could ever repair it — the
    // stale Aug 26 rows would then be a code defect rather than an absent worker.
    expect(RECONCILABLE_STATUSES).toContain("PROTECTED");
  });
});
