import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { DynamicLeveragePlan } from "@trading-alert-dashboard/shared";

import { connectTestDatabase } from "./helpers/test-database";
import { BAR0, IDENTITY, LINEAGE, M15, bar, commit, logOf, observation, realisticLog } from "./helpers/native-alert-fixtures";

/**
 * Native alert emitter — the database half, against REAL Postgres.
 *
 * Exactly-once delivery is a property of a unique index and a transaction, so
 * none of it is provable against a mock. The execution fences are proven the
 * same way: a NATIVE alert is put where an execution worker would look, with
 * a READY plan forced in behind the planner's back, and nothing downstream may
 * move. The adoption executor is a stub that only COUNTS: it stands in for the
 * signed Binance reads, so any call to it for a native plan is the failure.
 *
 * No Binance client is imported and no exchange request is made.
 */

const TAG = "native-emitter-it";
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient = testDatabase;
const maybe = () => (available ? it : it.skip);

const { PrismaNativeDeliveryLedger, NativeDeliveryConflictError } = await import("../src/modules/native-alerts/native-alert-ledger");
const { NativeAlertEmitter } = await import("../src/modules/native-alerts/native-alert-emitter");
const { selectNativeDeliveries } = await import("../src/modules/native-alerts/native-delivery-policy");
const { parseShadowEventLog } = await import("../src/modules/native-alerts/shadow-log-reader");
const { NativeAlertExecutionForbiddenError } = await import("../src/modules/alerts/alert-source");
const { alertsRoutes } = await import("../src/routes/alerts.routes");
const { ExtremeRRService } = await import("../src/modules/extreme-rr/extreme-rr.service");
const { SelectedPlanAdoptionService } = await import("../src/modules/jobs/selected-plan-adoption.service");
const { ExecutionService } = await import("../src/modules/execution/execution.service");
const { runAlertQueueRecoverySweep } = await import("../src/modules/jobs/alert-queue-recovery.service");
const { resetRecoverySweepGuardForTests } = await import("../src/modules/jobs/alert-queue-recovery.scheduler");

type Decision = ReturnType<typeof selectNativeDeliveries>[number] & { kind: "DELIVER" };

/** Symbols unique to this file so cleanup and assertions never see another suite's rows. */
let sequence = 0;
const nextSymbol = () => `NEMIT${++sequence}${Date.now() % 100000}USDT`;

function decisionsFor(symbol: string, records = realisticLog()) {
  return selectNativeDeliveries(parseShadowEventLog(logOf(rebuild(symbol, records)), { ...IDENTITY, symbol })).filter(
    (s): s is Decision => s.kind === "DELIVER"
  );
}

/** The fixture log for another symbol, with that symbol's genuine event identities. */
function rebuild(symbol: string, records: ReturnType<typeof realisticLog>) {
  return records.map((r) => {
    if (r.kind === "BAR_CLOSE_COMMIT") return commit(r.barOpenTimeMs, r.classification, LINEAGE, symbol);
    return observation({
      barMs: r.barOpenTimeMs,
      sourceTf: r.sourceTf,
      signal: r.signal,
      levelPrice: r.levelPrice,
      condition: r.level.condition,
      createdBarOpenTimeMs: r.level.createdBarOpenTimeMs,
      candidateSequence: r.candidateSequence,
      updateSequence: r.updateSequence,
      eventTimeMs: r.exchangeEventTimeMs,
      evidenceClass: r.evidence.evidenceClass as "PROVEN_INTRABAR_POSSIBLE" | "POSSIBLE_ONLY",
      symbol,
    });
  });
}

const alertsOf = (symbol: string) => prisma.alert.findMany({ where: { symbol }, orderBy: { createdAt: "asc" } });
const ledgerOf = (symbol: string) => prisma.nativeAlertDelivery.findMany({ where: { symbol } });

/** A client whose ledger insert fails INSIDE the transaction (and outside it, for a non-transactional writer). */
function faultyLedgerInsert(client: PrismaClient): PrismaClient {
  const failingDelivery = (delegate: object) =>
    new Proxy(delegate, {
      get(target, prop, receiver) {
        if (prop === "create") return async () => Promise.reject(new Error("injected crash between the Alert insert and the ledger insert"));
        return Reflect.get(target, prop, receiver);
      },
    });
  const wrapTx = (tx: object) =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        if (prop === "nativeAlertDelivery") return failingDelivery(Reflect.get(target, prop, receiver) as object);
        return Reflect.get(target, prop, receiver);
      },
    });
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "$transaction") {
        return (fn: (tx: unknown) => Promise<unknown>) => target.$transaction((tx) => fn(wrapTx(tx)));
      }
      if (prop === "nativeAlertDelivery") return failingDelivery(target.nativeAlertDelivery);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

/** A client whose pre-insert lookup is held until `n` racers have all looked, so every racer reaches the insert. */
function gatedLookups(client: PrismaClient, n: number): PrismaClient {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const delivery = new Proxy(client.nativeAlertDelivery, {
    get(target, prop, receiver) {
      if (prop === "findUnique") {
        return async (args: unknown) => {
          const result = await (target.findUnique as (a: unknown) => Promise<unknown>)(args);
          if (first) {
            arrived += 1;
            if (arrived >= n) {
              first = false;
              release();
            }
            await gate;
          }
          return result;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "nativeAlertDelivery") return delivery;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

async function cleanup(): Promise<void> {
  if (!available) return;
  // A TradeExecution under this suite's profiles exists ONLY if the native
  // execution fence was broken (as under mutation testing). Reclaim it so a
  // broken run can never leave synthetic executions in the test database.
  const strays = (
    await prisma.tradeExecution.findMany({ where: { executionProfile: { accountIdentifier: { startsWith: TAG } } }, select: { id: true } })
  ).map((row) => row.id);
  if (strays.length > 0) {
    await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: strays } } });
    await prisma.tradeExecution.deleteMany({ where: { id: { in: strays } } });
  }
  await prisma.selectedPlanAdoption.deleteMany({ where: { executionProfile: { accountIdentifier: { startsWith: TAG } } } });
  await prisma.nativeAlertDelivery.deleteMany({ where: { symbol: { startsWith: "NEMIT" } } });
  await prisma.alert.deleteMany({ where: { symbol: { startsWith: "NEMIT" } } });
  await prisma.asset.deleteMany({ where: { symbol: { startsWith: "NEMIT" } } });
  await prisma.executionProfile.deleteMany({ where: { accountIdentifier: { startsWith: TAG } } });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// ===========================================================================
// The ledger: one Alert per key, atomically, across restarts and races
// ===========================================================================

describe("the delivery ledger (real Postgres)", () => {
  maybe()("44. migration applied: the ledger reports AVAILABLE and Alert.source defaults to TRADINGVIEW", async () => {
    const status = await new PrismaNativeDeliveryLedger(prisma).status({ lineageId: IDENTITY.lineageId, symbol: "NEMITNONE", chartInterval: "15m" });
    expect(status).toMatchObject({ available: true, delivered: 0 });
    const symbol = nextSymbol();
    const row = await prisma.alert.create({
      data: { symbol, assetType: "CRYPTO", timeframe: "15m", price: 1, signal: "LONG", rawPayload: {}, triggeredAt: new Date(BAR0) },
    });
    expect(row.source).toBe("TRADINGVIEW");
  });

  maybe()("45. COMMIT creates exactly one NATIVE Alert and its ledger row, linked, with the event-time triggeredAt", async () => {
    const symbol = nextSymbol();
    const [d] = decisionsFor(symbol);
    const result = await new PrismaNativeDeliveryLedger(prisma).deliver(d.decision);
    expect(result.outcome).toBe("CREATED");
    const [alert] = await alertsOf(symbol);
    const [ledger] = await ledgerOf(symbol);
    expect(alert).toMatchObject({ id: result.alertId, source: "NATIVE", exchange: "BINANCE", timeframe: "15m", price: 0.81, sourceTimeframe: "1D", status: "RECEIVED" });
    expect(alert.triggeredAt.getTime()).toBe(d.decision.winner.exchangeEventTimeMs);
    expect(alert.triggeredAt.getTime()).not.toBe(alert.createdAt.getTime());
    expect(ledger).toMatchObject({
      deliveryKey: d.decision.deliveryKey,
      policyVersion: "NATIVE_DELIVERY_V1",
      lineageId: IDENTITY.lineageId,
      marketType: "USDM_PERPETUAL",
      chartInterval: "15m",
      winningShadowEventId: d.decision.winner.eventId,
      provenanceSha256: d.decision.provenanceSha256,
      evidenceClass: "PROVEN_INTRABAR_POSSIBLE",
      alertId: alert.id,
    });
    expect(ledger.barOpenTime.getTime()).toBe(bar(1));
  });

  maybe()("46. a restarted emitter re-reading the whole log creates nothing new (crash case B: commit landed, progress lost)", async () => {
    const symbol = nextSymbol();
    const text = logOf(rebuild(symbol, realisticLog()));
    const identity = { ...IDENTITY, symbol };
    for (const expected of [{ created: 2, alreadyDelivered: 0 }, { created: 0, alreadyDelivered: 2 }, { created: 0, alreadyDelivered: 2 }]) {
      const emitter = new NativeAlertEmitter({ mode: "COMMIT_DASHBOARD_ALERTS", ledger: new PrismaNativeDeliveryLedger(prisma), report: () => undefined });
      await emitter.process(parseShadowEventLog(text, identity));
      expect(emitter.tally).toMatchObject(expected);
    }
    expect((await alertsOf(symbol)).length).toBe(2);
    expect((await ledgerOf(symbol)).length).toBe(2);
  });

  maybe()("47. racing emitters on one key: exactly one Alert, and both report the same one", async () => {
    const symbol = nextSymbol();
    const [d] = decisionsFor(symbol);
    const racers = 4;
    const client = gatedLookups(prisma, racers);
    const results = await Promise.all(Array.from({ length: racers }, () => new PrismaNativeDeliveryLedger(client).deliver(d.decision)));
    expect(results.filter((r) => r.outcome === "CREATED").length).toBe(1);
    expect(new Set(results.map((r) => r.alertId)).size).toBe(1);
    expect((await alertsOf(symbol)).length).toBe(1);
    expect((await ledgerOf(symbol)).length).toBe(1);
  });

  maybe()("48. a race between two DIFFERENT winners for one bar is a contradiction: one Alert, the other refused", async () => {
    const symbol = nextSymbol();
    const decided = decisionsFor(symbol, [observation({ barMs: BAR0 })]);
    const alternative = decisionsFor(symbol, [observation({ barMs: BAR0, sourceTf: "1W", createdBarOpenTimeMs: BAR0 - 7 * 96 * M15 })]);
    expect(alternative[0].decision.deliveryKey).toBe(decided[0].decision.deliveryKey);
    const client = gatedLookups(prisma, 2);
    const settled = await Promise.allSettled([
      new PrismaNativeDeliveryLedger(client).deliver(decided[0].decision),
      new PrismaNativeDeliveryLedger(client).deliver(alternative[0].decision),
    ]);
    expect(settled.filter((s) => s.status === "fulfilled").length).toBe(1);
    const rejected = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(NativeDeliveryConflictError);
    expect((await alertsOf(symbol)).length).toBe(1);
  });

  maybe()("49. an existing key with contradictory provenance is never reused: lookup and deliver both refuse, nothing is written", async () => {
    const symbol = nextSymbol();
    const [d] = decisionsFor(symbol);
    const ledger = new PrismaNativeDeliveryLedger(prisma);
    await ledger.deliver(d.decision);
    await prisma.nativeAlertDelivery.update({ where: { deliveryKey: d.decision.deliveryKey }, data: { winningShadowEventId: "0".repeat(64) } });
    await expect(ledger.deliver(d.decision)).rejects.toBeInstanceOf(NativeDeliveryConflictError);
    await expect(ledger.lookup(d.decision)).rejects.toBeInstanceOf(NativeDeliveryConflictError);
    const tampered = { ...d.decision, provenanceSha256: "9".repeat(64) };
    await prisma.nativeAlertDelivery.update({ where: { deliveryKey: d.decision.deliveryKey }, data: { winningShadowEventId: d.decision.winner.eventId } });
    await expect(ledger.deliver(tampered)).rejects.toBeInstanceOf(NativeDeliveryConflictError);
    expect((await alertsOf(symbol)).length).toBe(1);
  });

  maybe()("50. crash case C: the ledger insert fails after the Alert insert — the transaction leaves NO Alert behind; a retry then delivers once", async () => {
    const symbol = nextSymbol();
    const [d] = decisionsFor(symbol);
    await expect(new PrismaNativeDeliveryLedger(faultyLedgerInsert(prisma)).deliver(d.decision)).rejects.toThrow(/injected crash/);
    expect(await alertsOf(symbol)).toEqual([]);
    expect(await ledgerOf(symbol)).toEqual([]);
    // Crash case A: nothing was durable, so the retry is a normal first delivery.
    expect((await new PrismaNativeDeliveryLedger(prisma).deliver(d.decision)).outcome).toBe("CREATED");
    expect((await alertsOf(symbol)).length).toBe(1);
  });

  maybe()("51. an Alert an operator deleted stays delivered: the key is kept and the bar is never re-sent", async () => {
    const symbol = nextSymbol();
    const [d] = decisionsFor(symbol);
    const ledger = new PrismaNativeDeliveryLedger(prisma);
    const created = await ledger.deliver(d.decision);
    await prisma.alert.delete({ where: { id: created.alertId as string } });
    expect(await ledger.deliver(d.decision)).toEqual({ outcome: "ALREADY_DELIVERED_ALERT_REMOVED", deliveryKey: d.decision.deliveryKey, alertId: null });
    expect(await alertsOf(symbol)).toEqual([]);
  });

  maybe()("52. DRY RUN against a real database writes nothing at all", async () => {
    const symbol = nextSymbol();
    const before = [await prisma.alert.count(), await prisma.nativeAlertDelivery.count()];
    const emitter = new NativeAlertEmitter({ mode: "DRY_RUN", ledger: new PrismaNativeDeliveryLedger(prisma), report: () => undefined });
    await emitter.process(parseShadowEventLog(logOf(rebuild(symbol, realisticLog())), { ...IDENTITY, symbol }));
    expect(emitter.tally).toMatchObject({ decisions: 2, wouldCreate: 2, created: 0 });
    expect([await prisma.alert.count(), await prisma.nativeAlertDelivery.count()]).toEqual(before);
  });
});

// ===========================================================================
// The dashboard's own read path
// ===========================================================================

describe("dashboard visibility through the real alerts routes", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify();
    app.decorate("prisma", prisma);
    await app.register(alertsRoutes);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  maybe()("53. GET /api/alerts and /api/alerts/:id return the native Alert, marked NATIVE, with its level context", async () => {
    const symbol = nextSymbol();
    const [d] = decisionsFor(symbol);
    const { alertId } = await new PrismaNativeDeliveryLedger(prisma).deliver(d.decision);
    const list = await app.inject({ method: "GET", url: `/api/alerts?symbol=${symbol}` });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { items: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: alertId,
      source: "NATIVE",
      symbol,
      timeframe: "15m",
      signal: "LONG",
      alertContext: { eventType: "LEVEL_TOUCHED", levelColor: "GREEN", sourceTimeframe: "1D", touchDirection: "FROM_ABOVE", levelPrice: 0.81, chartTimeframe: "15m" },
    });
    const detail = await app.inject({ method: "GET", url: `/api/alerts/${alertId}` });
    expect(detail.json()).toMatchObject({ id: alertId, source: "NATIVE", triggeredAt: new Date(d.decision.winner.exchangeEventTimeMs).toISOString() });
  });
});

// ===========================================================================
// The execution fences
// ===========================================================================

async function nativeAlert(symbol: string, triggeredAt = new Date(Date.now() - 30_000)) {
  return prisma.alert.create({
    data: {
      symbol, assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 100, signal: "LONG",
      indicatorName: "Native Level Scanner", rawPayload: { source: "NATIVE" }, triggeredAt, source: "NATIVE",
    },
  });
}

async function tradingViewAlert(symbol: string, triggeredAt = new Date(Date.now() - 30_000)) {
  return prisma.alert.create({
    data: { symbol, assetType: "CRYPTO", exchange: "SYNTHETIC", timeframe: "15m", price: 100, signal: "LONG", indicatorName: TAG, rawPayload: { note: TAG }, triggeredAt },
  });
}

/** A READY, fan-out-marked plan forced in directly — the state the planner fence normally makes unreachable. */
async function forcedReadyPlan(alertId: string, cutoffAt: Date) {
  return prisma.extremeRRPlan.create({
    data: {
      alertId, status: "READY", direction: "LONG", entryPrice: "100", cutoffAt, timeframe: "15m",
      selectedLookback: 300, generatedAt: cutoffAt, executionFanoutReadyAt: cutoffAt,
    },
  });
}

async function profile(alias: string) {
  sequence += 1;
  return prisma.executionProfile.create({
    data: { name: `${TAG} ${alias} ${sequence}`, accountIdentifier: `${TAG}-${alias}-${sequence}`, environment: "TESTNET", isEnabled: true },
  });
}

function readyMarginPlan(symbol: string): DynamicLeveragePlan {
  return {
    status: "READY", reason: null, reasonMessage: null, symbol, direction: "LONG",
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
  } as unknown as DynamicLeveragePlan;
}

describe("NATIVE alerts can never reach plans, adoption, execution or Binance", () => {
  beforeEach(() => resetRecoverySweepGuardForTests());

  maybe()("54. the planner refuses a NATIVE alert before any candle fetch: no PENDING row, no READY plan", async () => {
    const symbol = nextSymbol();
    const alert = await nativeAlert(symbol);
    const fetchCandles = vi.fn(async () => {
      throw new Error("a Binance kline fetch was attempted for a NATIVE alert");
    });
    const service = new ExtremeRRService(prisma, fetchCandles, async () => 300 as const);
    await expect(service.ensurePendingPlan(alert)).rejects.toBeInstanceOf(NativeAlertExecutionForbiddenError);
    await expect(service.generateForAlert(alert.id)).rejects.toBeInstanceOf(NativeAlertExecutionForbiddenError);
    expect(fetchCandles).not.toHaveBeenCalled();
    expect(await prisma.extremeRRPlan.count({ where: { alertId: alert.id } })).toBe(0);
  });

  maybe()("55. adoption never discovers a NATIVE plan — even a forced READY one — so the signed-read executor is never called for it", async () => {
    const tvSymbol = nextSymbol();
    const nativeSymbol = nextSymbol();
    const tv = await tradingViewAlert(tvSymbol);
    const nat = await nativeAlert(nativeSymbol);
    await forcedReadyPlan(tv.id, tv.triggeredAt);
    const nativePlan = await forcedReadyPlan(nat.id, nat.triggeredAt);
    const executed: string[] = [];
    const executor = {
      handleSelectedPlan: vi.fn(async (_plan: unknown, symbol: string) => {
        executed.push(symbol);
        return { handled: false, reasonCode: "MARGIN_PLAN_NOT_READY", message: "stub" };
      }),
    };
    const p = await profile("adoption");
    const service = new SelectedPlanAdoptionService({
      prisma,
      boundProfile: { executionProfileId: p.id, exchange: "BINANCE", product: "USDM_FUTURES", environment: "TESTNET" },
      executor: executor as never,
      plans: new ExtremeRRService(prisma),
      workerId: "native-fence",
    });
    for (let pass = 0; pass < 3; pass += 1) await service.runOnce(500);
    expect(executed).toContain(tvSymbol);
    expect(executed).not.toContain(nativeSymbol);
    expect(await prisma.selectedPlanAdoption.count({ where: { extremeRRPlanId: nativePlan.id } })).toBe(0);
  });

  maybe()("56. execution creation refuses a NATIVE alert before any write, whoever calls it", async () => {
    const symbol = nextSymbol();
    const alert = await nativeAlert(symbol);
    const p = await profile("execution");
    await expect(
      new ExecutionService(prisma).createExecutionFromReadyPlan({
        executionProfileId: p.id,
        alertId: alert.id,
        plan: readyMarginPlan(symbol),
        positionSide: "LONG",
        selectedLookback: 300,
      })
    ).rejects.toBeInstanceOf(NativeAlertExecutionForbiddenError);
    expect(await prisma.tradeExecution.count({ where: { alertId: alert.id } })).toBe(0);
  });

  maybe()("57. queue recovery never re-queues a NATIVE alert, and still recovers a stranded TradingView one", async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    const tv = await tradingViewAlert(nextSymbol(), old);
    const nat = await nativeAlert(nextSymbol(), old);
    await prisma.alert.updateMany({ where: { id: { in: [tv.id, nat.id] } }, data: { createdAt: old } });
    const added: string[] = [];
    await runAlertQueueRecoverySweep(prisma, { getJob: async () => null, add: async (id: string) => void added.push(id) }, { batchSize: 10_000 });
    expect(added).toContain(tv.id);
    expect(added).not.toContain(nat.id);
  });
});

// ===========================================================================
// TradingView behaviour is unchanged
// ===========================================================================

describe("the TradingView webhook path is unchanged", () => {
  maybe()("58. webhook alerts are TRADINGVIEW; a NATIVE row never absorbs one as its duplicate; TV duplicates and TV plans still work", async () => {
    const { handleTradingViewWebhook } = await import("../src/modules/webhook/webhook.service");
    const symbol = nextSymbol();
    // A NATIVE alert with the exact duplicate-lookup fields a TradingView webhook will carry.
    await prisma.alert.create({
      data: {
        symbol, assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 1, signal: "LONG",
        indicatorName: TAG, rawPayload: { source: "NATIVE" }, triggeredAt: new Date(), source: "NATIVE",
      },
    });
    const payload = {
      secret: process.env.WEBHOOK_SECRET,
      symbol,
      assetType: "crypto",
      timeframe: "15m",
      price: 1,
      signal: "LONG",
      indicatorName: TAG,
      triggeredAt: new Date().toISOString(),
      exchange: "BINANCE",
      note: "eventType=LEVEL_TOUCHED | levelColor=GREEN | sourceTf=1D | touchDirection=FROM_ABOVE | levelPrice=1 | chartTf=15m",
    };
    const first = await handleTradingViewWebhook(prisma, payload);
    expect(first.duplicate).toBeUndefined();
    const created = await prisma.alert.findUniqueOrThrow({ where: { id: first.id } });
    expect(created.source).toBe("TRADINGVIEW");
    expect(JSON.stringify(created.rawPayload)).not.toContain(String(process.env.WEBHOOK_SECRET));
    expect(await prisma.extremeRRPlan.count({ where: { alertId: created.id, status: "PENDING" } })).toBe(1);

    const second = await handleTradingViewWebhook(prisma, payload);
    expect(second).toMatchObject({ id: first.id, status: "IGNORED_DUPLICATE", duplicate: true });
    expect((await prisma.alert.findMany({ where: { symbol, source: "TRADINGVIEW" } })).length).toBe(1);
  });
});
