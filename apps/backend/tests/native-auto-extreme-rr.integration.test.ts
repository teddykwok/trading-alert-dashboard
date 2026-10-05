import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Alert, PrismaClient } from "@prisma/client";
import type { DynamicLeveragePlan } from "@trading-alert-dashboard/shared";
import { EXTREME_RR_LOOKBACKS, NATIVE_PLAN_EXECUTION_STATUS, parseNativeAccountPlanPolicy, previewNativeAccountPlan, type ExtremeRRPlanDto } from "@trading-alert-dashboard/shared";

import { connectTestDatabase } from "./helpers/test-database";
import { BAR0, M15, bar, commit, logOf, observation } from "./helpers/native-alert-fixtures";
import type { SnapshotCandle } from "../src/modules/market-data/market-data.types";

/**
 * AUTOMATIC, PLANNING-ONLY EXTREME RR FOR NEWLY COMMITTED NATIVE ALERTS.
 *
 *   V2 delivery commits (Alert + ledger)  ->  live push  ||  PENDING intent + Native queue job
 *   ->  dedicated Native worker  ->  the SAME planner as manual generation  ->  READY / INVALID / ERROR
 *   ->  per-account default preview (built-in A 100 / B 300, optional override)  ->  STOP.
 *
 * TEST database only; candles are fixtures; Redis is a fake; no Binance request of any kind.
 */

// The TradingView pipeline's queues, Telegram, screenshot and AI vision: Native auto-planning must never reach them.
const tvQueue = vi.hoisted(() => ({ enqueueVisionAnalysis: vi.fn(async () => undefined), enqueueExtremeRRPlan: vi.fn(async () => undefined) }));
vi.mock("../src/modules/jobs/queue", () => tvQueue);
const notify = vi.hoisted(() => ({
  notifyNewAlert: vi.fn(), notifyAlertUpdated: vi.fn(), notifyAlertFailed: vi.fn(), notifyAnalyzedAlert: vi.fn(), notifyExtremeRRPlanOutcome: vi.fn(),
}));
vi.mock("../src/modules/notifications/notification.service", () => notify);
const vision = vi.hoisted(() => ({ generateAndSaveScreenshot: vi.fn(), analyzeChart: vi.fn() }));
vi.mock("../src/modules/chart-renderer/screenshot.service", () => ({ generateAndSaveScreenshot: vision.generateAndSaveScreenshot }));
vi.mock("../src/modules/ai-vision/ai-vision.service", () => ({ analyzeChart: vision.analyzeChart }));
// The DEFAULT candle fetcher's only exit: the public closed-candle provider.
const marketData = vi.hoisted(() => ({ getClosedCandlesBefore: vi.fn() }));
vi.mock("../src/modules/market-data/market-data.service", () => marketData);

const TAG = "native-auto-rr-it";
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient = testDatabase;
const maybe = () => (available ? it : it.skip);

const { ExtremeRRService, NATIVE_PLAN_LIST_LIMIT } = await import("../src/modules/extreme-rr/extreme-rr.service");
const { extremeRRRoutes } = await import("../src/routes/extreme-rr.routes");
const { PrismaNativeDeliveryLedger } = await import("../src/modules/native-alerts/native-alert-ledger");
const { selectNativeDeliveriesV2 } = await import("../src/modules/native-alerts/native-delivery-policy-v2");
const { parseShadowEventLog } = await import("../src/modules/native-alerts/shadow-log-reader");
const { TEDDY_7_ALL_ACTIVE_V1, profileSummaryOf } = await import("../src/modules/native-scanner/scanner-profile");
const { SelectedPlanExecutor } = await import("../src/modules/execution/selected-plan-executor");
const { ExecutionService } = await import("../src/modules/execution/execution.service");
const { SelectedPlanAdoptionService } = await import("../src/modules/jobs/selected-plan-adoption.service");
const { NativeAlertExecutionForbiddenError } = await import("../src/modules/alerts/alert-source");
const { createNativePlanRequester, afterNativeAlertCommitted } = await import("../src/modules/native-planning/native-plan-request");
const { processNativePlanJob, runNativePlanRecoverySweep, NativePlanGenerationError, NATIVE_PLAN_RECOVERY_GRACE_MS } = await import("../src/modules/native-planning/native-plan-processor");
const { nativeAutoPlanRefusal } = await import("../src/modules/native-planning/native-plan-eligibility");
const { NATIVE_EXTREME_RR_QUEUE_NAME, NATIVE_PLAN_JOB_OPTIONS, nativePlanJobId } = await import("../src/modules/native-planning/native-plan-queue");
const { resolveNativeAccountPlanPolicies } = await import("../src/modules/native-planning/native-account-plan-policy");
type NativePlanJobState = import("../src/modules/native-planning/native-plan-queue").NativePlanJobState;

const T = TEDDY_7_ALL_ACTIVE_V1;
const CONTEXT = { profile: profileSummaryOf(T), runId: "20261004T140634Z-autoplan" };
const LINEAGE = "7".repeat(64);
const ENTRY = 0.04234;
let seq = 0;
const nextSymbol = () => `NAUTO${++seq}${Date.now() % 100000}USDT`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A real V2 delivery decision for one LONG level touch at 0.04234 (like the WCTUSDT smoke alerts). */
function decisionFor(symbol: string, over: { sourceTf?: "1D" | "1W" | "1M"; evidenceClass?: "PROVEN_INTRABAR_POSSIBLE" | "POSSIBLE_ONLY"; signal?: "LONG" | "SHORT" } = {}) {
  const identity = { lineageId: LINEAGE, marketType: "USDM_PERPETUAL" as const, symbol, chartInterval: "15m" as const };
  const sourceTf = over.sourceTf ?? "1W";
  const log = logOf([
    observation({ symbol, lineageId: LINEAGE, barMs: bar(1), sourceTf, levelPrice: ENTRY, signal: over.signal, evidenceClass: over.evidenceClass ?? "POSSIBLE_ONLY", createdBarOpenTimeMs: BAR0 - 30 * 96 * M15 }),
    commit(bar(1), "SHADOW_LIVE_ONLY", LINEAGE, symbol),
  ]);
  const [decision] = selectNativeDeliveriesV2(parseShadowEventLog(log, identity), T.delivery).flatMap((s) => (s.kind === "DELIVER" ? [s.decision] : []));
  return decision;
}

/**
 * 320 closed 15m candles ending with the last bar that CLOSED at or before the trigger, then the forming
 * bar and three later bars with absurd extremes (they exist "now", minutes after the alert, and must never
 * be used). Each lookback has its own extreme: highs 0.045 / 0.046 / 0.047 / 0.048 for 50 / 100 / 200 / 300.
 */
function candles(trigger: Date, closed = 320): SnapshotCandle[] {
  const lastOpen = Math.floor(trigger.getTime() / M15) * M15 - M15;
  const rows: SnapshotCandle[] = [];
  for (let i = closed - 1; i >= 0; i -= 1) {
    const openTimeMs = lastOpen - i * M15;
    const back = i + 1;
    const high = back === 20 ? "0.045" : back === 75 ? "0.046" : back === 150 ? "0.047" : back === 250 ? "0.048" : "0.0428";
    const low = back === 20 ? "0.0400" : back === 75 ? "0.0390" : back === 150 ? "0.0380" : back === 250 ? "0.0370" : "0.0420";
    rows.push({ openTimeMs, closeTimeMs: openTimeMs + M15 - 1, high, low });
  }
  for (let k = 1; k <= 4; k += 1) {
    const openTimeMs = lastOpen + k * M15;
    rows.push({ openTimeMs, closeTimeMs: openTimeMs + M15 - 1, high: "9.99", low: "0.0001" });
  }
  return rows;
}
const TP = { 50: "0.045", 100: "0.046", 200: "0.047", 300: "0.048" } as const;

const TEMPLATE = { id: "tpl-native-auto", name: "Native auto $400", referenceCapital: "400", riskPercent: "1", rewardRatio: "1.5", isActive: true, createdAt: new Date(), updatedAt: new Date() };
/** The real test database, with a fixed active risk template (the shared table is never toggled). */
const db = new Proxy(prisma, { get: (target, key) => (key === "riskTemplate" ? { findFirst: async () => TEMPLATE } : Reflect.get(target, key)) }) as PrismaClient;

function planner(fetch: (alert: Alert, cutoff: Date) => Promise<SnapshotCandle[]> = async (alert) => candles(alert.triggeredAt)) {
  const fetcher = vi.fn(fetch);
  return { service: new ExtremeRRService(db, fetcher, async () => 300 as const), fetcher };
}

/** BullMQ's observable behaviour: one job per id; adding an existing id adds nothing. */
function fakeQueue() {
  const jobs = new Map<string, NativePlanJobState>();
  const adds: string[] = [];
  return {
    jobs,
    adds,
    queue: {
      add: vi.fn(async (alertId: string) => {
        adds.push(alertId);
        if (!jobs.has(alertId)) jobs.set(alertId, "waiting");
      }),
      stateOf: vi.fn(async (alertId: string) => jobs.get(alertId) ?? ("missing" as const)),
    },
  };
}

function requesterOn(client: PrismaClient, queue = fakeQueue(), timeoutMs?: number) {
  const lines: string[] = [];
  return { requester: createNativePlanRequester({ prisma: client, queue: queue.queue, resolveLookback: async () => 300, log: (l) => void lines.push(l), timeoutMs }), queue, lines };
}

const publisher = () => {
  const pushed: string[] = [];
  return { pushed, live: { publishCommitted: vi.fn(async (alert: Alert) => (pushed.push(alert.id), "PUBLISHED" as const)) } };
};

/** Delivers one decision through the REAL V2 ledger with the emitter's real post-commit composition. */
async function deliverAuto(over: Parameters<typeof decisionFor>[1] = {}, client: PrismaClient = prisma, q = fakeQueue()) {
  const symbol = nextSymbol();
  const decision = decisionFor(symbol, over);
  const { requester, queue, lines } = requesterOn(client, q);
  const { live, pushed } = publisher();
  const ledger = new PrismaNativeDeliveryLedger(client, { onAlertCommitted: (alert) => afterNativeAlertCommitted(alert, live, requester) });
  const result = await ledger.deliverV2(decision, CONTEXT);
  expect(result.outcome).toBe("CREATED");
  const alert = await prisma.alert.findUniqueOrThrow({ where: { id: result.alertId! } });
  return { alert, decision, ledger, requester, queue, lines, pushed, live };
}

/** The same V2 delivery WITHOUT any planning hook: the shape of every historical Native alert. */
async function deliverHistorical() {
  const symbol = nextSymbol();
  const result = await new PrismaNativeDeliveryLedger(prisma).deliverV2(decisionFor(symbol), CONTEXT);
  return prisma.alert.findUniqueOrThrow({ where: { id: result.alertId! } });
}

async function tradingViewAlert(triggeredAt = new Date(Date.now() - 30_000)) {
  return prisma.alert.create({
    data: { symbol: nextSymbol(), assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: ENTRY, signal: "LONG", indicatorName: TAG, rawPayload: { symbol: "BINANCE:SYNTHUSDT.P", note: TAG }, triggeredAt },
  });
}

const planRow = (alertId: string) => prisma.extremeRRPlan.findUnique({ where: { alertId } });
const byLookback = (plan: ExtremeRRPlanDto) => Object.fromEntries(plan.candidates.map((c) => [c.requestedCandles, c]));

/** A READY margin plan, as the existing Native planning suite uses: creation must refuse the alert by source, not by plan shape. */
function readyMarginPlan(symbol: string): DynamicLeveragePlan {
  return {
    status: "READY", reason: null, reasonMessage: null, symbol, direction: "LONG", entryPrice: "100", stopLoss: "96", calculatedStopLoss: "96", executableStopLoss: "96",
    stopAdjustment: "0", stopNormalization: null, stopLossSource: "CALCULATED", stopDistance: "4", riskBudgetUsd: "1.50", quantityRaw: "0.250", roundedQuantity: "0.250",
    quantityStepSize: "0.001", actualPlannedLoss: "1.0", unusedRiskBudget: "0", positionNotional: "25", minimumNotional: "5", targetMarginMultiplier: "2.5",
    maximumMarginMultiplier: "3.333333", targetIsolatedMargin: "2.50", maximumIsolatedMargin: "5.00", applicableBracket: null, maximumSupportedLeverage: 50,
    binanceMaximumSupportedLeverage: 50, userMaximumAutomationLeverage: 25, usableMaximumLeverage: 25, selectedLeverage: 10, estimatedInitialMargin: "2.50",
    estimatedLiquidationPrice: "90.1", requiredLiquidationBoundary: "94", liquidationBufferRatio: "0.5", liquidationDistance: "5.9", safetyBufferDistance: "2",
    marginDifferenceFromTarget: "0", candidates: [], warnings: [],
  } as unknown as DynamicLeveragePlan;
}

async function profile(alias: string) {
  seq += 1;
  return prisma.executionProfile.create({ data: { name: `${TAG} ${alias} ${seq}`, accountIdentifier: `${TAG}-${alias}-${seq}`, environment: "TESTNET", isEnabled: true } });
}

async function cleanup(): Promise<void> {
  if (!available) return;
  await prisma.selectedPlanAdoption.deleteMany({ where: { executionProfile: { accountIdentifier: { startsWith: TAG } } } });
  await prisma.nativeAlertDelivery.deleteMany({ where: { symbol: { startsWith: "NAUTO" } } });
  await prisma.alert.deleteMany({ where: { OR: [{ symbol: { startsWith: "NAUTO" } }, { indicatorName: TAG }] } });
  await prisma.executionProfile.deleteMany({ where: { accountIdentifier: { startsWith: TAG } } });
}
beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (available) await prisma.$disconnect();
});
beforeEach(() => {
  for (const spy of [...Object.values(tvQueue), ...Object.values(notify), ...Object.values(vision)]) spy.mockClear();
  marketData.getClosedCandlesBefore.mockReset();
});
const assertNoTradingViewSideEffects = () => {
  for (const spy of [...Object.values(tvQueue), ...Object.values(notify), ...Object.values(vision)]) expect(spy).not.toHaveBeenCalled();
};

// ===========================================================================
// 1-3. The trigger: after the durable commit, independent of the live push
// ===========================================================================

describe("the trigger: post-commit, prospective, independent", () => {
  maybe()("1. a newly committed V2 Native alert records a PENDING intent and enqueues exactly one job on the DEDICATED Native queue", async () => {
    const { alert, queue, pushed } = await deliverAuto();
    expect(queue.adds).toEqual([alert.id]);
    expect(nativePlanJobId(alert.id)).toBe(alert.id);
    expect(NATIVE_EXTREME_RR_QUEUE_NAME).toBe("native-extreme-rr-plan");
    expect(NATIVE_PLAN_JOB_OPTIONS.attempts).toBe(2);
    const plan = await planRow(alert.id);
    expect(plan).toMatchObject({ status: "PENDING", direction: "LONG", cutoffAt: alert.triggeredAt, executionFanoutReadyAt: null, candidates: null, telegramStatus: null });
    expect(String(plan!.entryPrice)).toBe(String(ENTRY));
    expect(pushed).toEqual([alert.id]);
    assertNoTradingViewSideEffects();
  });

  maybe()("2. the Alert commit does not depend on planning: a failing intent write or enqueue leaves the Alert and its ledger row committed", async () => {
    // The intent write fails.
    const failingPlans = new Proxy(prisma, {
      get: (target, key) => (key === "extremeRRPlan" ? { createMany: async () => Promise.reject(new Error("plan table down")) } : Reflect.get(target, key)),
    }) as PrismaClient;
    const symbol = nextSymbol();
    const decision = decisionFor(symbol);
    const failing = requesterOn(failingPlans);
    const { live, pushed } = publisher();
    const ledger = new PrismaNativeDeliveryLedger(prisma, { onAlertCommitted: (alert) => afterNativeAlertCommitted(alert, live, failing.requester) });
    const result = await ledger.deliverV2(decision, CONTEXT);
    expect(result.outcome).toBe("CREATED");
    expect(await prisma.alert.count({ where: { id: result.alertId! } })).toBe(1);
    expect(await prisma.nativeAlertDelivery.count({ where: { deliveryKey: decision.deliveryKey } })).toBe(1);
    expect(await planRow(result.alertId!)).toBeNull();
    expect(failing.queue.adds).toEqual([]);
    expect(pushed).toEqual([result.alertId]);
    expect(failing.lines.join("\n")).toMatch(/intent not recorded .*can be planned manually/);

    // The enqueue fails: the intent stays PENDING for the sweep; the Alert is untouched.
    const down = fakeQueue();
    down.queue.add.mockRejectedValue(Object.assign(new Error("ECONNREFUSED"), { name: "RedisDown" }));
    const { alert, lines } = await deliverAuto({}, prisma, down);
    expect((await planRow(alert.id))!.status).toBe("PENDING");
    expect(lines.join("\n")).toMatch(/enqueue failed .*\(RedisDown\).*recovered by the planning worker's sweep/);
  });

  maybe()("3. the live dashboard push never waits on planning: a hung enqueue times out while the push has already happened", async () => {
    const order: string[] = [];
    const hung = fakeQueue();
    hung.queue.add.mockImplementation(() => new Promise<void>(() => undefined));
    const { requester } = requesterOn(prisma, hung, 50);
    const live = { publishCommitted: vi.fn(async () => (order.push("push"), "PUBLISHED" as const)) };
    const tracked = { requestCommitted: async (a: Alert) => { const outcome = await requester.requestCommitted(a); order.push(`plan:${outcome}`); return outcome; } };
    const symbol = nextSymbol();
    const ledger = new PrismaNativeDeliveryLedger(prisma, { onAlertCommitted: (alert) => afterNativeAlertCommitted(alert, live, tracked) });
    const result = await ledger.deliverV2(decisionFor(symbol), CONTEXT);
    expect(result.outcome).toBe("CREATED");
    expect(order).toEqual(["push", "plan:ENQUEUE_FAILED"]);
    // A planning request that rejects outright cannot suppress the push either.
    const pushed: string[] = [];
    const ledger2 = new PrismaNativeDeliveryLedger(prisma, {
      onAlertCommitted: (alert) => afterNativeAlertCommitted(alert, { publishCommitted: async (a) => void pushed.push(a.id) }, { requestCommitted: async () => Promise.reject(new Error("boom")) }),
    });
    const result2 = await ledger2.deliverV2(decisionFor(nextSymbol()), CONTEXT);
    expect(result2.outcome).toBe("CREATED");
    expect(pushed).toEqual([result2.alertId]);
  });

  maybe()("duplicate deliveries never re-request: the ledger calls the hook only for the call that CREATED the Alert", async () => {
    const { alert, decision, ledger, queue } = await deliverAuto();
    expect((await ledger.deliverV2(decision, CONTEXT)).outcome).toBe("ALREADY_DELIVERED");
    expect(queue.adds).toEqual([alert.id]);
  });
});

// ===========================================================================
// 4-7, 16. What the worker generates: the same frozen planner
// ===========================================================================

describe("the generated plan: frozen at the alert, exact entry, all four windows", () => {
  maybe()("4-7. a job run 47 minutes after the alert uses ONLY candles closed by triggeredAt; entry = 0.04234; 50/100/200/300 from one snapshot", async () => {
    const { alert } = await deliverAuto();
    const { service, fetcher } = planner(async (a) => candles(a.triggeredAt)); // includes bars that closed AFTER the alert
    const outcome = await processNativePlanJob({ prisma: db, planner: service }, alert.id);
    expect(outcome).toEqual({ kind: "GENERATED", status: "READY" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toEqual(alert.triggeredAt); // the cutoff is the alert, not "now"
    const plan = (await service.getForAlert(alert.id))!;
    expect(plan).toMatchObject({ status: "READY", alertSource: "NATIVE", entryPrice: String(ENTRY), cutoffAt: alert.triggeredAt.toISOString(), selectedLookback: 300 });
    const c = byLookback(plan);
    expect(Object.keys(c).map(Number)).toEqual([...EXTREME_RR_LOOKBACKS]);
    for (const lookback of EXTREME_RR_LOOKBACKS) {
      expect(c[lookback]).toMatchObject({ requestedCandles: lookback, actualCandles: lookback, complete: true, valid: true, takeProfit: TP[lookback], extremePrice: TP[lookback] });
      expect(Date.parse(c[lookback].newestCandleCloseTime!)).toBeLessThanOrEqual(alert.triggeredAt.getTime());
      expect(c[lookback].takeProfit).not.toBe("9.99");
    }
    // SL from reward / RR 1.5: 0.04234 - (0.045 - 0.04234) / 1.5
    expect(Number(c[50].stopLoss)).toBeCloseTo(ENTRY - (0.045 - ENTRY) / 1.5, 12);
    assertNoTradingViewSideEffects();
  });

  maybe()("4. the worker's DEFAULT fetcher asks the public provider for 15m USD-M futures candles closed before triggeredAt", async () => {
    const { alert } = await deliverAuto();
    marketData.getClosedCandlesBefore.mockResolvedValue(candles(alert.triggeredAt));
    const outcome = await processNativePlanJob({ prisma: db, planner: new ExtremeRRService(db) }, alert.id);
    expect(outcome.kind).toBe("GENERATED");
    expect(marketData.getClosedCandlesBefore).toHaveBeenCalledWith("CRYPTO", alert.symbol, "15m", alert.triggeredAt, "BINANCE", "futures", 300);
  });

  maybe()("16. a POSSIBLE_ONLY alert plans exactly as the manual path does; its class and non-actionable payload are preserved", async () => {
    const { alert } = await deliverAuto({ evidenceClass: "POSSIBLE_ONLY" });
    const { service } = planner();
    expect(await processNativePlanJob({ prisma: db, planner: service }, alert.id)).toEqual({ kind: "GENERATED", status: "READY" });
    const after = await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } });
    const payload = after.rawPayload as { actionable: boolean; delivery: { evidenceClass: string } };
    expect([after.source, after.status, payload.actionable, payload.delivery.evidenceClass]).toEqual(["NATIVE", "RECEIVED", false, "POSSIBLE_ONLY"]);
  });

  maybe()("a SHORT alert: TP = lowest low of each window", async () => {
    const { alert } = await deliverAuto({ signal: "SHORT" });
    const { service } = planner(async (a) => candles(a.triggeredAt).map((k) => ({ ...k, low: k.low === "0.0420" ? "0.0420" : k.low })));
    await processNativePlanJob({ prisma: db, planner: service }, alert.id);
    const plan = (await service.getForAlert(alert.id))!;
    expect(plan.direction).toBe("SHORT");
    expect(byLookback(plan)[300]).toMatchObject({ takeProfit: "0.037", extremeType: "LOWEST_LOW" });
  });
});

// ===========================================================================
// 8-10. Idempotency, freeze, restart / recovery
// ===========================================================================

describe("idempotent, frozen, recoverable", () => {
  maybe()("8. duplicate and concurrent jobs converge on ONE canonical plan row", async () => {
    const { alert, requester, queue } = await deliverAuto();
    expect(await requester.requestCommitted(alert)).toBe("REQUESTED"); // a replayed request
    expect(queue.jobs.size).toBe(1);
    const { service } = planner();
    const outcomes = await Promise.all([1, 2, 3].map(() => processNativePlanJob({ prisma: db, planner: service }, alert.id)));
    expect(outcomes.every((o) => o.kind === "GENERATED" || o.kind === "ALREADY_FINAL")).toBe(true);
    expect(await prisma.extremeRRPlan.count({ where: { alertId: alert.id } })).toBe(1);
  });

  maybe()("9. a READY plan is frozen: a replayed job fetches nothing, regenerates nothing and changes nothing", async () => {
    const { alert, requester } = await deliverAuto();
    await processNativePlanJob({ prisma: db, planner: planner().service }, alert.id);
    const before = await planRow(alert.id);
    const later = planner(async () => candles(new Date(alert.triggeredAt.getTime() + 6 * 3600_000)).map((k) => ({ ...k, high: "0.09" })));
    expect(await processNativePlanJob({ prisma: db, planner: later.service }, alert.id)).toEqual({ kind: "ALREADY_FINAL", status: "READY" });
    expect(await requester.requestCommitted(alert)).toBe("REQUESTED"); // a replayed request cannot downgrade it to PENDING
    expect(later.fetcher).not.toHaveBeenCalled();
    expect(await planRow(alert.id)).toEqual(before);
  });

  maybe()("10. restart: the job is lost before READY; the sweep (after its grace) re-enqueues the PENDING intent; one plan results", async () => {
    const { alert, queue } = await deliverAuto();
    queue.jobs.clear(); // the process died and Redis lost the job
    const sweepNow = (ms: number) => runNativePlanRecoverySweep(prisma, queue.queue, { batchSize: 500, now: () => new Date(Date.now() + ms) });
    const early = await runNativePlanRecoverySweep(prisma, queue.queue, { batchSize: 500 });
    expect(early.outcomes.find((o) => o.alertId === alert.id)).toBeUndefined(); // inside the grace
    const recovered = await sweepNow(NATIVE_PLAN_RECOVERY_GRACE_MS + 1_000);
    expect(recovered.outcomes.find((o) => o.alertId === alert.id)?.disposition).toBe("RECOVERED");
    expect((await sweepNow(NATIVE_PLAN_RECOVERY_GRACE_MS + 1_000)).outcomes.find((o) => o.alertId === alert.id)?.disposition).toBe("ALREADY_QUEUED");
    await processNativePlanJob({ prisma: db, planner: planner().service }, alert.id);
    expect((await sweepNow(NATIVE_PLAN_RECOVERY_GRACE_MS + 1_000)).outcomes.find((o) => o.alertId === alert.id)).toBeUndefined(); // READY: never swept
    expect(await prisma.extremeRRPlan.count({ where: { alertId: alert.id } })).toBe(1);
    expect(await prisma.alert.count({ where: { id: alert.id } })).toBe(1);
  });

  maybe()("10. a public-data failure: ERROR recorded, the job throws for BullMQ's bounded retry, the retry converges to READY on the same row", async () => {
    const { alert } = await deliverAuto();
    const failing = planner(async () => Promise.reject(new Error("Binance 503")));
    await expect(processNativePlanJob({ prisma: db, planner: failing.service }, alert.id)).rejects.toBeInstanceOf(NativePlanGenerationError);
    expect(await planRow(alert.id)).toMatchObject({ status: "ERROR", errorReason: "Binance 503", executionFanoutReadyAt: null, telegramStatus: null });
    expect(await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({ source: "NATIVE", status: "RECEIVED" });
    expect(await processNativePlanJob({ prisma: db, planner: planner().service }, alert.id)).toEqual({ kind: "GENERATED", status: "READY" });
    expect(await prisma.extremeRRPlan.count({ where: { alertId: alert.id } })).toBe(1);
    assertNoTradingViewSideEffects();
  });

  maybe()("no infinite loop: ERROR is never swept; a job that ended without an outcome closes its PENDING intent as ERROR once", async () => {
    const { alert: errored } = await deliverAuto();
    await expect(processNativePlanJob({ prisma: db, planner: planner(async () => Promise.reject(new Error("down"))).service }, errored.id)).rejects.toThrow();
    const { alert: stuck, queue } = await deliverAuto();
    queue.jobs.set(stuck.id, "failed");
    const sweep = () => runNativePlanRecoverySweep(prisma, queue.queue, { batchSize: 500, now: () => new Date(Date.now() + NATIVE_PLAN_RECOVERY_GRACE_MS + 1_000) });
    const first = await sweep();
    expect(first.outcomes.find((o) => o.alertId === errored.id)).toBeUndefined();
    expect(first.outcomes.find((o) => o.alertId === stuck.id)?.disposition).toBe("CLOSED_AS_ERROR");
    expect(await planRow(stuck.id)).toMatchObject({ status: "ERROR", executionFanoutReadyAt: null });
    expect((await sweep()).outcomes.find((o) => o.alertId === stuck.id)).toBeUndefined();
    expect(queue.adds.filter((id) => id === stuck.id)).toEqual([stuck.id]);
  });

  maybe()("a sweep whose queue is unreachable stops, touches nothing and retries next tick", async () => {
    const { alert, queue } = await deliverAuto();
    queue.queue.stateOf.mockRejectedValue(new Error("redis down"));
    const summary = await runNativePlanRecoverySweep(prisma, queue.queue, { batchSize: 500, now: () => new Date(Date.now() + NATIVE_PLAN_RECOVERY_GRACE_MS + 1_000) });
    expect(summary.queueUnavailable).toBe(true);
    expect((await planRow(alert.id))!.status).toBe("PENDING");
  });
});

// ===========================================================================
// 11-15, 35-36. Planning only
// ===========================================================================

describe("planning only: no screenshot, AI, Telegram, adoption or execution", () => {
  maybe()("11-15. an auto-generated READY plan: no vision/Telegram/TradingView job, no fan-out marker, no adoption, no execution", async () => {
    const { alert } = await deliverAuto();
    await processNativePlanJob({ prisma: db, planner: planner().service }, alert.id);
    const plan = (await planRow(alert.id))!;
    expect(plan).toMatchObject({ status: "READY", executionFanoutReadyAt: null, telegramStatus: null, telegramNotifiedAt: null });
    expect(await prisma.selectedPlanAdoption.count({ where: { extremeRRPlanId: plan.id } })).toBe(0);
    expect(await prisma.tradeExecution.count({ where: { alertId: alert.id } })).toBe(0);
    expect(await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({ screenshotUrl: null, aiBias: null, status: "RECEIVED" });
    assertNoTradingViewSideEffects();
  });

  maybe()("14/27. adoption discovery never sees an auto-generated Native plan while it still discovers a TradingView plan", async () => {
    const { alert: nat } = await deliverAuto({ sourceTf: "1D" });
    await prisma.alert.update({ where: { id: nat.id }, data: { triggeredAt: new Date(Date.now() - 30_000) } });
    await prisma.extremeRRPlan.update({ where: { alertId: nat.id }, data: { cutoffAt: new Date(Date.now() - 30_000) } });
    await processNativePlanJob({ prisma: db, planner: planner().service }, nat.id);
    const tv = await tradingViewAlert();
    await planner().service.generateForAlert(tv.id);
    const executed: string[] = [];
    const executor = { handleSelectedPlan: vi.fn(async (_plan: unknown, symbol: string) => (executed.push(symbol), { handled: false, reasonCode: "MARGIN_PLAN_NOT_READY", message: "stub" })) };
    const adoption = new SelectedPlanAdoptionService({
      prisma,
      boundProfile: { executionProfileId: (await profile("adopt")).id, exchange: "BINANCE", product: "USDM_FUTURES", environment: "TESTNET" },
      executor: executor as never,
      plans: new ExtremeRRService(prisma),
      workerId: "native-auto-fence",
    });
    for (let pass = 0; pass < 3; pass += 1) await adoption.runOnce(500);
    expect(executed).toContain(tv.symbol);
    expect(executed).not.toContain(nat.symbol);
    expect(await prisma.selectedPlanAdoption.count({ where: { extremeRRPlan: { alertId: nat.id } } })).toBe(0);
  });

  maybe()("13/35. the executor refuses the auto-generated plan BEFORE any canary, signed margin read or creation; creation refuses it too", async () => {
    const { alert } = await deliverAuto();
    await processNativePlanJob({ prisma: db, planner: planner().service }, alert.id);
    const plan = (await new ExtremeRRService(db).getForAlert(alert.id))!;
    const touched: string[] = [];
    const trap = (name: string) => new Proxy({}, { get: (_t, key) => (touched.push(`${name}.${String(key)}`), () => { throw new Error(`${name} reached`); }) });
    const executor = new SelectedPlanExecutor({
      prisma: trap("prisma") as never, marginPlanner: trap("marginPlanner") as never, executions: trap("executions") as never, orchestrator: trap("orchestrator") as never,
      boundProfile: { executionProfileId: "never", exchange: "BINANCE", product: "USDM_FUTURES", environment: "TESTNET" } as never,
    });
    expect(await executor.handleSelectedPlan(plan, alert.symbol)).toMatchObject({ handled: false, reasonCode: "NATIVE_ALERT_EXECUTION_FORBIDDEN" });
    expect(touched).toEqual([]);
    const p = await profile("exec");
    await expect(
      new ExecutionService(prisma).createExecutionFromReadyPlan({ executionProfileId: p.id, alertId: alert.id, plan: readyMarginPlan(alert.symbol), positionSide: "LONG", selectedLookback: 100 })
    ).rejects.toBeInstanceOf(NativeAlertExecutionForbiddenError);
    expect(await prisma.tradeExecution.count({ where: { alertId: alert.id } })).toBe(0);
  });

  maybe()("36. nativeExecutionEnabled stays false: in the profile, in the alert payload and in the Trading Control list", async () => {
    const { alert } = await deliverAuto();
    expect(T.execution.nativeExecutionEnabled).toBe(false);
    expect((alert.rawPayload as { profile: { nativeExecutionEnabled: boolean } }).profile.nativeExecutionEnabled).toBe(false);
    expect((await new ExtremeRRService(db).listNativePlans(1, resolveNativeAccountPlanPolicies({}))).nativeExecutionEnabled).toBe(false);
  });
});

// ===========================================================================
// 17-19. Fails safely; refuses everything that is not a V2 Native dashboard alert
// ===========================================================================

describe("fails safely and fails closed", () => {
  maybe()("17. invalid Native market metadata: ERROR with its reason, no candle request, the alert stays", async () => {
    const { alert } = await deliverAuto();
    const payload = { ...(alert.rawPayload as Record<string, unknown>) };
    delete payload.marketType;
    await prisma.alert.update({ where: { id: alert.id }, data: { rawPayload: payload as object } });
    const svc = new ExtremeRRService(db, undefined, async () => 300 as const); // the DEFAULT fetcher
    await expect(processNativePlanJob({ prisma: db, planner: svc }, alert.id)).rejects.toBeInstanceOf(NativePlanGenerationError);
    expect((await planRow(alert.id))!.errorReason).toMatch(/does not name its market/);
    expect(marketData.getClosedCandlesBefore).not.toHaveBeenCalled();
    expect(await prisma.alert.count({ where: { id: alert.id } })).toBe(1);
  });

  maybe()("18. an invalid alert price: ERROR before any candle fetch, never a current-price fallback", async () => {
    const { alert } = await deliverAuto();
    await prisma.alert.update({ where: { id: alert.id }, data: { price: 0 } });
    const { service, fetcher } = planner();
    await expect(processNativePlanJob({ prisma: db, planner: service }, alert.id)).rejects.toBeInstanceOf(NativePlanGenerationError);
    expect((await planRow(alert.id))!.errorReason).toMatch(/no usable canonical entry price/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("19. eligibility is an allowlist: TRADINGVIEW, unknown, missing, actionable, non-V2, ledgerless, mismatched or non-directional alerts are refused", () => {
    const good = {
      id: "a1", source: "NATIVE", signal: "LONG",
      rawPayload: { source: "NATIVE", actionable: false, delivery: { policyVersion: "NATIVE_DELIVERY_V2", deliveryKey: "k" } },
      nativeDelivery: { deliveryKey: "k", policyVersion: "NATIVE_DELIVERY_V2", alertId: "a1" },
    };
    expect(nativeAutoPlanRefusal(good)).toBeNull();
    for (const source of ["TRADINGVIEW", "native", "OTHER", undefined, null, ""]) expect(nativeAutoPlanRefusal({ ...good, source })).toBe("NOT_NATIVE");
    expect(nativeAutoPlanRefusal({ ...good, rawPayload: { ...good.rawPayload, actionable: true } })).toBe("NOT_DASHBOARD_ONLY");
    expect(nativeAutoPlanRefusal({ ...good, rawPayload: { ...good.rawPayload, actionable: undefined } })).toBe("NOT_DASHBOARD_ONLY");
    expect(nativeAutoPlanRefusal({ ...good, rawPayload: null })).toBe("NOT_DASHBOARD_ONLY");
    expect(nativeAutoPlanRefusal({ ...good, rawPayload: { ...good.rawPayload, delivery: { policyVersion: "NATIVE_DELIVERY_V1", deliveryKey: "k" } } })).toBe("NOT_V2_DELIVERY");
    expect(nativeAutoPlanRefusal({ ...good, nativeDelivery: null })).toBe("NO_DELIVERY_LEDGER");
    expect(nativeAutoPlanRefusal({ ...good, nativeDelivery: { ...good.nativeDelivery, deliveryKey: "other" } })).toBe("LEDGER_MISMATCH");
    expect(nativeAutoPlanRefusal({ ...good, nativeDelivery: { ...good.nativeDelivery, alertId: "a2" } })).toBe("LEDGER_MISMATCH");
    expect(nativeAutoPlanRefusal({ ...good, signal: "WATCH" })).toBe("NOT_DIRECTIONAL");
  });

  maybe()("19. a TradingView alert can never enter Native auto-planning; its own PENDING plan is left exactly as its pipeline made it", async () => {
    const tv = await tradingViewAlert();
    await new ExtremeRRService(db).ensurePendingPlan(tv); // the TradingView pipeline's own intent
    const before = await planRow(tv.id);
    const { requester, queue } = requesterOn(prisma);
    expect(await requester.requestCommitted(tv)).toBe("REFUSED");
    expect(queue.adds).toEqual([]);
    const { service, fetcher } = planner();
    expect(await processNativePlanJob({ prisma: db, planner: service }, tv.id)).toEqual({ kind: "REFUSED", reason: "NOT_NATIVE" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await planRow(tv.id)).toEqual(before); // still PENDING, no ERROR, no fan-out marker written by us
    const sweep = await runNativePlanRecoverySweep(prisma, queue.queue, { batchSize: 500, now: () => new Date(Date.now() + NATIVE_PLAN_RECOVERY_GRACE_MS + 1_000) });
    expect(sweep.outcomes.find((o) => o.alertId === tv.id)).toBeUndefined();
  });

  maybe()("a Native PENDING intent whose alert stopped being eligible is closed as ERROR, never planned and never re-swept", async () => {
    const { alert, queue } = await deliverAuto();
    await prisma.alert.update({ where: { id: alert.id }, data: { rawPayload: { ...(alert.rawPayload as Record<string, unknown>), actionable: true } } });
    const { service, fetcher } = planner();
    expect(await processNativePlanJob({ prisma: db, planner: service }, alert.id)).toEqual({ kind: "REFUSED", reason: "NOT_DASHBOARD_ONLY" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await planRow(alert.id)).toMatchObject({ status: "ERROR", errorReason: "Not eligible for automatic Native planning (NOT_DASHBOARD_ONLY)", candidates: null, executionFanoutReadyAt: null });
    const sweep = await runNativePlanRecoverySweep(prisma, queue.queue, { batchSize: 500, now: () => new Date(Date.now() + NATIVE_PLAN_RECOVERY_GRACE_MS + 1_000) });
    expect(sweep.outcomes.find((o) => o.alertId === alert.id)).toBeUndefined();
  });

  maybe()("historical Native alerts are never planned: no PENDING intent means a job (or a sweep) plans nothing", async () => {
    const old = await deliverHistorical();
    const { service, fetcher } = planner();
    expect(await processNativePlanJob({ prisma: db, planner: service }, old.id)).toEqual({ kind: "NO_PLANNING_INTENT" });
    expect(await planRow(old.id)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    const q = fakeQueue();
    const sweep = await runNativePlanRecoverySweep(prisma, q.queue, { batchSize: 500, now: () => new Date(Date.now() + 365 * 86_400_000) });
    expect(sweep.outcomes.find((o) => o.alertId === old.id)).toBeUndefined();
    expect(q.adds).not.toContain(old.id);
  });

  maybe()("a Native alert without its ledger row, or with an actionable payload, is refused before any write", async () => {
    const symbol = nextSymbol();
    const bare = await prisma.alert.create({
      data: {
        symbol, assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: ENTRY, signal: "LONG", indicatorName: "Native Level Scanner", source: "NATIVE", triggeredAt: new Date(),
        rawPayload: { source: "NATIVE", actionable: false, marketType: "USDM_PERPETUAL", delivery: { policyVersion: "NATIVE_DELIVERY_V2", deliveryKey: "x".repeat(64) } },
      },
    });
    const { requester, queue } = requesterOn(prisma);
    expect(await requester.requestCommitted(bare)).toBe("REFUSED");
    expect(await planRow(bare.id)).toBeNull();
    expect(queue.adds).toEqual([]);
  });
});

// ===========================================================================
// 20-21. The manual path is unchanged and coexists
// ===========================================================================

describe("the manual Native path still works and coexists", () => {
  maybe()("20. POST /api/alerts/:id/extreme-rr/generate still generates a Native plan (and completes an auto PENDING intent on the same row)", async () => {
    const { alert } = await deliverAuto();
    marketData.getClosedCandlesBefore.mockResolvedValue(candles(alert.triggeredAt));
    const app = Fastify();
    app.decorate("prisma", db);
    await app.register(extremeRRRoutes);
    const response = await app.inject({ method: "POST", url: `/api/alerts/${alert.id}/extreme-rr/generate` });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "READY", alertSource: "NATIVE", entryPrice: String(ENTRY), cutoffAt: alert.triggeredAt.toISOString() });
    expect(await prisma.extremeRRPlan.count({ where: { alertId: alert.id } })).toBe(1);
    // The queued job then finds a final plan and does nothing.
    const { service, fetcher } = planner();
    expect(await processNativePlanJob({ prisma: db, planner: service }, alert.id)).toEqual({ kind: "ALREADY_FINAL", status: "READY" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  maybe()("21. an existing manually selected Native plan stays readable and untouched by later jobs and requests", async () => {
    const { alert, requester } = await deliverAuto();
    const { service } = planner();
    await service.generateForAlert(alert.id);
    await service.updateSelection(alert.id, { selectedLookback: 100 });
    await processNativePlanJob({ prisma: db, planner: service }, alert.id);
    await requester.requestCommitted(alert);
    const plan = (await service.getForAlert(alert.id))!;
    expect([plan.status, plan.selectedLookback]).toEqual(["READY", 100]);
    const item = (await service.listNativePlans(NATIVE_PLAN_LIST_LIMIT.max, resolveNativeAccountPlanPolicies({}))).items.find((i) => i.alertId === alert.id)!;
    expect(item.plan).toMatchObject({ state: "SELECTED", selectedLookback: 100, takeProfit: TP[100], execution: NATIVE_PLAN_EXECUTION_STATUS });
  });
});

// ===========================================================================
// 22-26. Per-account DEFAULT Native plan policy (read-only overlay)
// ===========================================================================

describe("per-account default Native plan policy", () => {
  it("22/24/25. an explicit override resolves exactly 50/100/200/300; absent or empty is the built-in default (A 100, B 300); anything else is INVALID (never coerced)", () => {
    for (const lookback of EXTREME_RR_LOOKBACKS) expect(parseNativeAccountPlanPolicy("A", String(lookback))).toEqual({ account: "A", state: "RESOLVED", lookback, source: "ENV_OVERRIDE", reason: null });
    for (const raw of [undefined, null, ""]) expect(parseNativeAccountPlanPolicy("B", raw)).toEqual({ account: "B", state: "RESOLVED", lookback: 300, source: "BUILTIN_DEFAULT", reason: null });
    for (const raw of ["75", "150", "0", "-100", " 100", "100 ", "100.0", "1e2", "0100", "abc", "300;", 100, true]) {
      const policy = parseNativeAccountPlanPolicy("A", raw);
      expect(policy.state, String(raw)).toBe("INVALID");
      expect(policy.lookback).toBeNull();
      expect(policy.reason).toMatch(/not one of 50, 100, 200, 300/);
    }
    expect(resolveNativeAccountPlanPolicies({}).map((p) => [p.account, p.state, p.lookback, p.source])).toEqual([["A", "RESOLVED", 100, "BUILTIN_DEFAULT"], ["B", "RESOLVED", 300, "BUILTIN_DEFAULT"]]);
  });

  it("23/26. A and B resolve DIFFERENT candidates of the same plan from their own policy; the global selected lookback is never consulted", () => {
    const candidate = (lookback: 50 | 100 | 200 | 300) => ({
      requestedCandles: lookback, actualCandles: lookback, complete: true, extremeType: "HIGHEST_HIGH" as const, extremePrice: TP[lookback], oldestCandleOpenTime: null, newestCandleCloseTime: null,
      valid: true, invalidReason: null, takeProfit: TP[lookback], stopLoss: `sl${lookback}`, rewardDistance: "1", riskDistance: "1", riskRewardRatio: "1.5", money: null,
    });
    const plan = { status: "READY" as const, errorReason: null, selectedLookback: 50, candidates: EXTREME_RR_LOOKBACKS.map(candidate) };
    const [a, b] = resolveNativeAccountPlanPolicies({ A: "100", B: "300" }).map((policy) => previewNativeAccountPlan(plan, policy));
    expect(a).toMatchObject({ account: "A", policy: "RESOLVED", lookback: 100, state: "RESOLVED", takeProfit: TP[100], stopLoss: "sl100", execution: NATIVE_PLAN_EXECUTION_STATUS });
    expect(b).toMatchObject({ account: "B", policy: "RESOLVED", lookback: 300, state: "RESOLVED", takeProfit: TP[300], stopLoss: "sl300" });
    expect(plan.selectedLookback).toBe(50);
    // No override: the built-in default; INVALID never picks anything; a not-READY plan never shows prices.
    expect(previewNativeAccountPlan(plan, parseNativeAccountPlanPolicy("A", undefined))).toMatchObject({ state: "RESOLVED", lookback: 100, source: "BUILTIN_DEFAULT", takeProfit: TP[100] });
    expect(previewNativeAccountPlan(plan, parseNativeAccountPlanPolicy("B", "75"))).toMatchObject({ state: "INVALID_POLICY", lookback: null, takeProfit: null });
    expect(previewNativeAccountPlan({ ...plan, status: "PENDING" }, parseNativeAccountPlanPolicy("A", "100"))).toMatchObject({ state: "PLAN_NOT_READY", takeProfit: null, reason: "Plan is still being generated" });
    expect(previewNativeAccountPlan({ ...plan, candidates: [candidate(50)] }, parseNativeAccountPlanPolicy("A", "100"))).toMatchObject({ state: "NO_CANDIDATE", takeProfit: null });
    expect(previewNativeAccountPlan({ ...plan, candidates: [{ ...candidate(100), valid: false, takeProfit: null, stopLoss: null, invalidReason: "Highest high is not above entry" }] }, parseNativeAccountPlanPolicy("A", "100"))).toMatchObject({ state: "CANDIDATE_INVALID", reason: "Highest high is not above entry", takeProfit: null });
  });

  maybe()("23/26. Trading Control's list: A=100 and B=300 for the SAME auto-generated plan, read-only; the stored global selection is unchanged", async () => {
    const { alert } = await deliverAuto();
    const { service } = planner();
    await processNativePlanJob({ prisma: db, planner: service }, alert.id);
    await service.updateSelection(alert.id, { selectedLookback: 50 }); // the existing global (manual) selection
    const before = await planRow(alert.id);
    const list = await service.listNativePlans(NATIVE_PLAN_LIST_LIMIT.max, resolveNativeAccountPlanPolicies({ A: "100", B: "300" }));
    expect(list.accountPolicies.map((p) => [p.account, p.state, p.lookback])).toEqual([["A", "RESOLVED", 100], ["B", "RESOLVED", 300]]);
    const item = list.items.find((i) => i.alertId === alert.id)!;
    expect(item.availableLookbacks).toEqual([50, 100, 200, 300]);
    expect(item.plan).toMatchObject({ selectedLookback: 50, takeProfit: TP[50] });
    expect(item.accountDefaults.map((d) => [d.account, d.lookback, d.takeProfit])).toEqual([["A", 100, TP[100]], ["B", 300, TP[300]]]);
    expect(await planRow(alert.id)).toEqual(before); // listing wrote nothing
    expect(await prisma.selectedPlanAdoption.count({ where: { extremeRRPlanId: before!.id } })).toBe(0);
  });

  maybe()("24/27. accounts with no override use the built-in defaults, and a PENDING plan reads as still planning (no fake READY, no prices)", async () => {
    const { alert } = await deliverAuto();
    const list = await new ExtremeRRService(db).listNativePlans(NATIVE_PLAN_LIST_LIMIT.max, resolveNativeAccountPlanPolicies({}));
    const item = list.items.find((i) => i.alertId === alert.id)!;
    expect(item.plan).toMatchObject({ planStatus: "PENDING", state: "PLAN_NOT_READY", stopLoss: null, takeProfit: null });
    expect(item.availableLookbacks).toEqual([]);
    expect(item.accountDefaults.map((d) => [d.account, d.lookback, d.source, d.state, d.takeProfit])).toEqual([["A", 100, "BUILTIN_DEFAULT", "PLAN_NOT_READY", null], ["B", 300, "BUILTIN_DEFAULT", "PLAN_NOT_READY", null]]);
  });

  maybe()("the generic process reads the two raw settings (none set here) and resolves the built-in defaults without ever failing startup", async () => {
    const { configuredNativeAccountPlanPolicies } = await import("../src/modules/native-planning/native-account-plan-policy");
    const { env } = await import("../src/config/env");
    expect(env.NATIVE_PLAN_DEFAULT_LOOKBACK_A ?? undefined).toBeUndefined();
    expect(env.NATIVE_PLAN_DEFAULT_LOOKBACK_B ?? undefined).toBeUndefined();
    expect((await configuredNativeAccountPlanPolicies()).map((p) => [p.state, p.lookback, p.source])).toEqual([["RESOLVED", 100, "BUILTIN_DEFAULT"], ["RESOLVED", 300, "BUILTIN_DEFAULT"]]);
  });
});

// ===========================================================================
// Static isolation: the TradingView pipeline does not know Native planning exists
// ===========================================================================

describe("static isolation", () => {
  const BACKEND = path.resolve(__dirname, "..");
  const read = (rel: string) => readFileSync(path.join(BACKEND, rel), "utf8");
  const PLANNING_DIR = "src/modules/native-planning";

  it("30-34. no TradingView pipeline module imports Native planning, and the Native worker is a separate entrypoint", () => {
    for (const rel of [
      "src/modules/webhook/webhook.service.ts",
      "src/modules/jobs/queue.ts",
      "src/modules/jobs/vision-analysis.worker.ts",
      "src/modules/jobs/execution.worker.ts",
      "src/modules/jobs/selected-plan-adoption.service.ts",
      "src/modules/jobs/alert-queue-recovery.service.ts",
      "src/modules/execution/selected-plan-executor.ts",
      "src/modules/execution/execution.service.ts",
      "src/modules/alerts/alert-source.ts",
      "src/app.ts",
      "src/server.ts",
    ]) {
      expect({ rel, hit: /native-planning|native-plan-/.test(read(rel)) }).toEqual({ rel, hit: false });
    }
  });

  it("11-15/35. the Native planning modules reach no TradingView queue, Telegram, screenshot, vision, adoption, execution or signed client", () => {
    const files = readdirSync(path.join(BACKEND, PLANNING_DIR)).filter((f) => f.endsWith(".ts"));
    expect(files.sort()).toEqual([
      "native-account-plan-policy.ts", "native-plan-eligibility.ts", "native-plan-processor.ts", "native-plan-queue.ts", "native-plan-request.ts", "native-plan.worker.ts",
      "native-planner-heartbeat.ts", "native-planner-runtime.ts", "native-planner-status.ts",
    ]);
    for (const file of files) {
      const source = read(`${PLANNING_DIR}/${file}`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect({ file, hit: source.match(/jobs\/queue|(?<![A-Z_])EXTREME_RR_QUEUE_NAME\b|enqueueExtremeRRPlan|enqueueVisionAnalysis|notification|notify|telegram|screenshot|ai-vision|analyzeChart|selected-plan|\/execution\/|createExecution|executionFanoutReadyAt:\s*new Date|binance-execution|binance-read-only|binance-account|createHmac|X-MBX|BINANCE_API_KEY|apiSecret/i)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });
});
