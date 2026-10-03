import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Alert, PrismaClient } from "@prisma/client";
import type { DynamicLeveragePlan } from "@trading-alert-dashboard/shared";
import { EXTREME_RR_LOOKBACKS, NATIVE_PLAN_EXECUTION_STATUS, selectedPlanSummaryOf, type ExtremeRRPlanDto } from "@trading-alert-dashboard/shared";

import { connectTestDatabase } from "./helpers/test-database";
import type { SnapshotCandle } from "../src/modules/market-data/market-data.types";

/**
 * NATIVE ALERT -> THE EXISTING EXTREME RR PLANNER -> 50/100/200/300 -> SELECTED,
 * FROZEN PLAN -> READ ONLY FOR TRADING CONTROL -> EXECUTION STILL REFUSED.
 *
 * One planner and one formula for TradingView and Native. A Native plan is
 * generated on demand only (never queued), never carries the execution fan-out
 * marker, and is refused by every execution path for every source timeframe.
 * TEST database only; candles are fixtures; no Binance request of any kind.
 */

// No job is ever enqueued by Native planning: these spies must stay untouched.
const queue = vi.hoisted(() => ({ enqueueVisionAnalysis: vi.fn(async () => undefined), enqueueExtremeRRPlan: vi.fn(async () => undefined) }));
vi.mock("../src/modules/jobs/queue", () => queue);
// The DEFAULT candle fetcher's only exit: the public closed-candle provider.
const marketData = vi.hoisted(() => ({ getClosedCandlesBefore: vi.fn() }));
vi.mock("../src/modules/market-data/market-data.service", () => marketData);

const TAG = "native-rr-it";
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient = testDatabase;
const maybe = () => (available ? it : it.skip);

const { ExtremeRRService, NATIVE_PLAN_LIST_LIMIT, extremeRRMarketTypeOf, resolveInitialLookback } = await import("../src/modules/extreme-rr/extreme-rr.service");
const { SelectedPlanExecutor } = await import("../src/modules/execution/selected-plan-executor");
const { ExecutionService } = await import("../src/modules/execution/execution.service");
const { SelectedPlanAdoptionService } = await import("../src/modules/jobs/selected-plan-adoption.service");
const { NativeAlertExecutionForbiddenError } = await import("../src/modules/alerts/alert-source");
const { ineligibilityOfV2 } = await import("../src/modules/native-alerts/native-delivery-policy-v2");
const { parseShadowEventLog } = await import("../src/modules/native-alerts/shadow-log-reader");
const { TEDDY_7_ALL_ACTIVE_V1, TEDDY_AGGRESSIVE_V1 } = await import("../src/modules/native-scanner/scanner-profile");
const { logOf, observation } = await import("./helpers/native-alert-fixtures");

const M15 = 15 * 60_000;
/** An intrabar trigger: 6m15s into the 19:30 bar, like the BNBUSDT smoke alert. */
const BAR = Date.UTC(2026, 9, 3, 19, 30);
const TRIGGER = new Date(BAR + 6 * 60_000 + 15_123);

/**
 * 320 closed 15m candles ending with the 19:15 bar (closes 19:29:59.999 <= cutoff),
 * then the FORMING 19:30 bar and two later bars, all with absurd extremes that must
 * never be seen. Each lookback has its own extreme: highs 115 / 130 / 145 / 160 and
 * lows 85 / 70 / 55 / 40 for the trailing 50 / 100 / 200 / 300 candles.
 */
function candles(trigger: Date = TRIGGER, closed = 320): SnapshotCandle[] {
  const lastOpen = Math.floor(trigger.getTime() / M15) * M15 - M15;
  const rows: SnapshotCandle[] = [];
  for (let i = closed - 1; i >= 0; i -= 1) {
    const openTimeMs = lastOpen - i * M15;
    const back = i + 1; // 1 = newest closed candle
    const high = back === 20 ? "115" : back === 75 ? "130" : back === 150 ? "145" : back === 250 ? "160" : "102";
    const low = back === 20 ? "85" : back === 75 ? "70" : back === 150 ? "55" : back === 250 ? "40" : "98";
    rows.push({ openTimeMs, closeTimeMs: openTimeMs + M15 - 1, high, low });
  }
  for (let k = 1; k <= 3; k += 1) {
    const openTimeMs = lastOpen + k * M15; // the forming bar, then the future
    rows.push({ openTimeMs, closeTimeMs: openTimeMs + M15 - 1, high: "999", low: "1" });
  }
  return rows;
}

const TEMPLATE = {
  id: "tpl-native-rr", name: "Native RR $400", referenceCapital: "400", riskPercent: "1", rewardRatio: "1.5", isActive: true, createdAt: new Date(), updatedAt: new Date(),
};
/** The real test database, with a fixed active risk template (the shared table is never toggled). */
const db = new Proxy(prisma, {
  get: (target, key) => (key === "riskTemplate" ? { findFirst: async () => TEMPLATE } : Reflect.get(target, key)),
}) as PrismaClient;

let sequence = 0;
const nextSymbol = () => `NRR${++sequence}${Date.now() % 100000}USDT`;

async function nativeAlert(over: Partial<{ signal: "LONG" | "SHORT" | "WATCH"; price: number; sourceTimeframe: string; triggeredAt: Date; marketType: string | null }> = {}) {
  const symbol = nextSymbol();
  return prisma.alert.create({
    data: {
      symbol, assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: over.price ?? 100, signal: over.signal ?? "LONG",
      indicatorName: "Native Level Scanner", source: "NATIVE", sourceTimeframe: over.sourceTimeframe ?? "1M", eventType: "LEVEL_TOUCHED", levelColor: "GREEN",
      triggeredAt: over.triggeredAt ?? TRIGGER,
      rawPayload: {
        source: "NATIVE", actionable: false, symbol, ...(over.marketType === null ? {} : { marketType: over.marketType ?? "USDM_PERPETUAL" }), timeframe: "15m",
        delivery: { policyVersion: "NATIVE_DELIVERY_V2", sourceTimeframe: over.sourceTimeframe ?? "1M" },
        profile: { profileId: "TEDDY_7_ALL_ACTIVE_V1", nativeExecutionEnabled: false },
      },
    },
  });
}

async function tradingViewAlert(over: Partial<{ signal: "LONG" | "SHORT"; triggeredAt: Date }> = {}) {
  return prisma.alert.create({
    data: {
      symbol: nextSymbol(), assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 100, signal: over.signal ?? "LONG", indicatorName: TAG,
      rawPayload: { symbol: "BINANCE:SYNTHUSDT.P", note: TAG }, triggeredAt: over.triggeredAt ?? TRIGGER,
    },
  });
}

function planner(fetch: (alert: Alert, cutoff: Date, limit: number) => Promise<SnapshotCandle[]> = async (alert) => candles(alert.triggeredAt)) {
  const fetcher = vi.fn(fetch);
  return { service: new ExtremeRRService(db, fetcher, async () => 300 as const), fetcher };
}

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

const byLookback = (plan: ExtremeRRPlanDto) => Object.fromEntries(plan.candidates.map((c) => [c.requestedCandles, c]));

async function cleanup(): Promise<void> {
  if (!available) return;
  await prisma.selectedPlanAdoption.deleteMany({ where: { executionProfile: { accountIdentifier: { startsWith: TAG } } } });
  await prisma.alert.deleteMany({ where: { OR: [{ symbol: { startsWith: "NRR" } }, { indicatorName: TAG }] } });
  await prisma.executionProfile.deleteMany({ where: { accountIdentifier: { startsWith: TAG } } });
}
beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (available) await prisma.$disconnect();
});
beforeEach(() => {
  queue.enqueueVisionAnalysis.mockClear();
  queue.enqueueExtremeRRPlan.mockClear();
  marketData.getClosedCandlesBefore.mockReset();
});

// ===========================================================================
// One planner: TradingView unchanged, Native through the same path
// ===========================================================================

describe("one canonical planner for both sources", () => {
  maybe()("1. TradingView is unchanged: READY, fan-out marker set, futures market, and the SAME numbers a Native alert gets", async () => {
    const tv = await tradingViewAlert();
    const nat = await nativeAlert();
    const { service } = planner();
    const tvPlan = await service.generateForAlert(tv.id);
    const natPlan = await service.generateForAlert(nat.id);
    expect(tvPlan.alertSource).toBe("TRADINGVIEW");
    expect(natPlan.alertSource).toBe("NATIVE");
    expect(tvPlan.status).toBe("READY");
    const tvRow = await prisma.extremeRRPlan.findUniqueOrThrow({ where: { alertId: tv.id } });
    expect(tvRow.executionFanoutReadyAt).not.toBeNull();
    expect(tvRow.marketType).toBe("futures");
    // No source-specific drift: identical inputs, identical frozen candidates.
    expect(natPlan.candidates).toEqual(tvPlan.candidates);
  });

  maybe()("2/4/6-10. Native LONG: entry = alert price; TP = highest high; SL = entry - (TP - entry)/RR; 50/100/200/300", async () => {
    const alert = await nativeAlert({ signal: "LONG", price: 100 });
    const { service } = planner();
    const plan = await service.generateForAlert(alert.id);
    expect(plan).toMatchObject({ status: "READY", direction: "LONG", entryBasis: "ALERT_PRICE", entryPrice: "100", timeframe: "15m", cutoffAt: TRIGGER.toISOString() });
    expect(plan.candidates.map((c) => c.requestedCandles)).toEqual([...EXTREME_RR_LOOKBACKS]);
    const c = byLookback(plan);
    for (const [lookback, tp, sl, risk] of [[50, "115", "90", "10"], [100, "130", "80", "20"], [200, "145", "70", "30"], [300, "160", "60", "40"]] as const) {
      expect(c[lookback], `${lookback}`).toMatchObject({
        valid: true, extremeType: "HIGHEST_HIGH", extremePrice: tp, takeProfit: tp, stopLoss: sl, riskDistance: risk, riskRewardRatio: "1.5",
        actualCandles: lookback, complete: true,
      });
      expect(Number(c[lookback].stopLoss) < 100 && 100 < Number(c[lookback].takeProfit)).toBe(true);
    }
    // Money management from the frozen template snapshot ($400 x 1% = $4 risk, $6 target).
    expect(plan.template).toMatchObject({ rewardRatio: "1.5", riskAmount: "4", targetAmount: "6" });
    expect(c[50].money).toMatchObject({ quantityRaw: "0.4", plannedLossRaw: "4", plannedProfitRaw: "6" });
    expect(c[50].money?.leverage.options.map((o) => o.leverage)).toEqual([5, 10, 15, 20, 25]);
    expect([plan.precision, plan.leverageLimitVerified]).toEqual(["UNROUNDED", false]);
  });

  maybe()("3/5/6. Native SHORT: entry = alert price; TP = lowest low; SL = entry + (entry - TP)/RR", async () => {
    const alert = await nativeAlert({ signal: "SHORT", price: 100 });
    const plan = await planner().service.generateForAlert(alert.id);
    const c = byLookback(plan);
    expect(plan).toMatchObject({ status: "READY", direction: "SHORT", entryPrice: "100" });
    for (const [lookback, tp, sl] of [[50, "85", "110"], [100, "70", "120"], [200, "55", "130"], [300, "40", "140"]] as const) {
      expect(c[lookback], `${lookback}`).toMatchObject({ valid: true, extremeType: "LOWEST_LOW", takeProfit: tp, stopLoss: sl, riskRewardRatio: "1.5" });
      expect(Number(c[lookback].takeProfit) < 100 && 100 < Number(c[lookback].stopLoss)).toBe(true);
    }
  });

  maybe()("11. the initial selected lookback is the configured policy (default 300), exactly as for TradingView", async () => {
    const alert = await nativeAlert();
    const plan = await new ExtremeRRService(db, async (a) => candles(a.triggeredAt)).generateForAlert(alert.id);
    expect(plan.selectedLookback).toBe(resolveInitialLookback());
    const fixed = await planner().service.generateForAlert((await nativeAlert()).id);
    expect(fixed.selectedLookback).toBe(300);
  });
});

// ===========================================================================
// Frozen at the alert: no future data, ever
// ===========================================================================

describe("frozen at the alert", () => {
  maybe()("12. the cutoff is the alert's triggeredAt; the forming bar and later candles are never used, whatever the fetcher returns", async () => {
    const alert = await nativeAlert({ signal: "LONG" });
    const { service, fetcher } = planner();
    const plan = await service.generateForAlert(alert.id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0][1] as Date).toISOString()).toBe(TRIGGER.toISOString());
    expect(fetcher.mock.calls[0][2]).toBe(300);
    for (const c of plan.candidates) {
      expect(c.takeProfit).not.toBe("999");
      expect(Date.parse(c.newestCandleCloseTime as string)).toBeLessThanOrEqual(TRIGGER.getTime());
    }
    expect(byLookback(plan)[50].newestCandleCloseTime).toBe(new Date(BAR - 1).toISOString());
  });

  maybe()("13. a READY plan is frozen: new candles (even a new extreme) change nothing, and are not even fetched", async () => {
    const alert = await nativeAlert({ signal: "LONG" });
    const first = await planner().service.generateForAlert(alert.id);
    const later = planner(async (a) => [...candles(a.triggeredAt), ...candles(new Date(a.triggeredAt.getTime() + 3 * 86_400_000)).map((c) => ({ ...c, high: "500" }))]);
    const again = await later.service.generateForAlert(alert.id);
    expect(later.fetcher).not.toHaveBeenCalled();
    expect(again.candidates).toEqual(first.candidates);
    expect(again.id).toBe(first.id);
    // Selecting another lookback never recomputes anything.
    const selected = await later.service.updateSelection(alert.id, { selectedLookback: 100 });
    expect(selected.candidates).toEqual(first.candidates);
  });
});

// ===========================================================================
// Fail safely: nothing fabricated, nothing forced READY
// ===========================================================================

describe("insufficient or invalid input fails safely", () => {
  maybe()("14. no closed candles: INVALID, no SL/TP; short history: the honest count, flagged incomplete", async () => {
    const empty = await planner(async () => []).service.generateForAlert((await nativeAlert()).id);
    expect(empty.status).toBe("INVALID");
    for (const c of empty.candidates) expect(c).toMatchObject({ valid: false, stopLoss: null, takeProfit: null, actualCandles: 0, complete: false });
    const short = await planner(async (a) => candles(a.triggeredAt, 30)).service.generateForAlert((await nativeAlert({ price: 100 })).id);
    for (const c of short.candidates) expect([c.actualCandles, c.complete]).toEqual([30, false]);
    expect(JSON.stringify([empty, short])).not.toMatch(/NaN|Infinity/);
  });

  maybe()("15. invalid LONG geometry (highest high <= entry): INVALID with its reason, no SL/TP", async () => {
    const plan = await planner().service.generateForAlert((await nativeAlert({ signal: "LONG", price: 200 })).id);
    expect(plan.status).toBe("INVALID");
    for (const c of plan.candidates) {
      expect(c).toMatchObject({ valid: false, stopLoss: null, takeProfit: null });
      expect(c.invalidReason).toMatch(/not above entry/);
    }
  });

  maybe()("16. invalid SHORT geometry (lowest low >= entry): INVALID with its reason, no SL/TP", async () => {
    const plan = await planner().service.generateForAlert((await nativeAlert({ signal: "SHORT", price: 30 })).id);
    expect(plan.status).toBe("INVALID");
    for (const c of plan.candidates) {
      expect(c).toMatchObject({ valid: false, stopLoss: null, takeProfit: null });
      expect(c.invalidReason).toMatch(/not below entry/);
    }
  });

  maybe()("no usable canonical entry price: ERROR before any candle fetch; never a current-price fallback", async () => {
    const { service, fetcher } = planner();
    const plan = await service.generateForAlert((await nativeAlert({ price: 0 })).id);
    expect(plan.status).toBe("ERROR");
    expect(plan.errorReason).toMatch(/canonical entry price/);
    expect(plan.candidates).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  maybe()("a non-directional Native alert is refused, as for TradingView", async () => {
    await expect(planner().service.generateForAlert((await nativeAlert({ signal: "WATCH" })).id)).rejects.toThrow(/LONG or SHORT/);
  });
});

// ===========================================================================
// Native stays Native: its own market, no screenshot, no AI, no queue
// ===========================================================================

describe("Native stays truthful", () => {
  it("the market comes from the Native payload (USDM_PERPETUAL -> futures), never TradingView's '.P' rule", () => {
    const base = { symbol: "BNBUSDT" } as const;
    expect(extremeRRMarketTypeOf({ ...base, source: "NATIVE", rawPayload: { symbol: "BNBUSDT", marketType: "USDM_PERPETUAL" } })).toBe("futures");
    expect(extremeRRMarketTypeOf({ ...base, source: "NATIVE", rawPayload: { symbol: "BNBUSDT" } })).toBeNull();
    expect(extremeRRMarketTypeOf({ ...base, source: "NATIVE", rawPayload: { symbol: "BNBUSDT", marketType: "SPOT" } })).toBeNull();
    expect(extremeRRMarketTypeOf({ ...base, source: "TRADINGVIEW", rawPayload: { symbol: "BINANCE:BNBUSDT.P" } })).toBe("futures");
    expect(extremeRRMarketTypeOf({ ...base, source: "TRADINGVIEW", rawPayload: { symbol: "BNBUSDT" } })).toBe("spot");
  });

  maybe()("the default fetcher asks the public provider for 15m USD-M futures candles closed before the alert", async () => {
    marketData.getClosedCandlesBefore.mockImplementation(async (_a: unknown, _s: unknown, _t: unknown, cutoff: Date) => candles(cutoff));
    const alert = await nativeAlert();
    const plan = await new ExtremeRRService(db, undefined, async () => 300 as const).generateForAlert(alert.id);
    expect(plan.status).toBe("READY");
    expect(marketData.getClosedCandlesBefore).toHaveBeenCalledWith("CRYPTO", alert.symbol, "15m", TRIGGER, "BINANCE", "futures", 300);
    // A Native alert that does not name its market is refused, never planned against SPOT.
    marketData.getClosedCandlesBefore.mockClear();
    const unnamed = await new ExtremeRRService(db, undefined, async () => 300 as const).generateForAlert((await nativeAlert({ marketType: null })).id);
    expect(unnamed.status).toBe("ERROR");
    expect(unnamed.errorReason).toMatch(/does not name its market/);
    expect(marketData.getClosedCandlesBefore).not.toHaveBeenCalled();
  });

  maybe()("17-20. no screenshot and no AI needed or faked; the alert stays NATIVE, RECEIVED and non-actionable; nothing is queued", async () => {
    const alert = await nativeAlert();
    const plan = await planner().service.generateForAlert(alert.id);
    expect(plan.status).toBe("READY");
    const after = await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(after).toMatchObject({ source: "NATIVE", status: "RECEIVED", screenshotUrl: null, aiProvider: null, aiBias: null, aiSummary: null, aiConfidence: null });
    expect((after.rawPayload as { actionable: boolean }).actionable).toBe(false);
    expect(after.updatedAt.toISOString()).toBe(alert.updatedAt.toISOString());
    // Never queued: no vision job, no background plan job, no PENDING row from the webhook path.
    await expect(planner().service.ensurePendingPlan(alert)).rejects.toBeInstanceOf(NativeAlertExecutionForbiddenError);
    expect(queue.enqueueVisionAnalysis).not.toHaveBeenCalled();
    expect(queue.enqueueExtremeRRPlan).not.toHaveBeenCalled();
  });

  maybe()("21-23. source TF 1D, 1W and 1M all plan on the same 15m chart candles: the source TF is not the lookback interval", async () => {
    const plans: ExtremeRRPlanDto[] = [];
    for (const tf of ["1D", "1W", "1M"]) {
      const { service, fetcher } = planner();
      plans.push(await service.generateForAlert((await nativeAlert({ sourceTimeframe: tf })).id));
      expect((fetcher.mock.calls[0][0] as Alert).timeframe).toBe("15m");
    }
    expect(plans.every((p) => p.status === "READY")).toBe(true);
    expect(plans[1].candidates).toEqual(plans[0].candidates);
    expect(plans[2].candidates).toEqual(plans[0].candidates);
  });

  it("24. 3M / 6M / 12M stay outside NATIVE_DELIVERY_V2 dashboard delivery", () => {
    const identity = { lineageId: "5".repeat(64), marketType: "USDM_PERPETUAL" as const, symbol: "BNBUSDT", chartInterval: "15m" as const };
    for (const profile of [TEDDY_7_ALL_ACTIVE_V1, TEDDY_AGGRESSIVE_V1]) {
      for (const [tf, deliverable] of [["1D", true], ["1W", true], ["1M", true], ["3M", false], ["6M", false], ["12M", false]] as const) {
        const record = parseShadowEventLog(logOf([observation({ symbol: "BNBUSDT", lineageId: identity.lineageId, sourceTf: tf })]), identity)[0];
        expect(ineligibilityOfV2(record, profile.delivery) === null, `${profile.profileId} ${tf}`).toBe(deliverable);
      }
    }
  });

  maybe()("25. repeated and concurrent generation is idempotent: one plan row, identical candidates", async () => {
    const alert = await nativeAlert();
    const { service } = planner();
    const [a, b] = await Promise.all([service.generateForAlert(alert.id), service.generateForAlert(alert.id)]);
    const c = await service.generateForAlert(alert.id);
    expect(await prisma.extremeRRPlan.count({ where: { alertId: alert.id } })).toBe(1);
    expect(b.candidates).toEqual(a.candidates);
    expect(c.candidates).toEqual(a.candidates);
  });
});

// ===========================================================================
// Selected plan -> Trading Control (read only) -> execution refused
// ===========================================================================

describe("the selected Native plan: readable, never executable", () => {
  maybe()("26. Trading Control's list reads the selected, frozen Native plan as PLANNING ONLY; TradingView plans are not in it", async () => {
    const nat = await nativeAlert({ sourceTimeframe: "1W" });
    const tv = await tradingViewAlert();
    const { service } = planner();
    await service.generateForAlert(nat.id);
    await service.generateForAlert(tv.id);
    await service.updateSelection(nat.id, { selectedLookback: 100 });
    const list = await service.listNativePlans(NATIVE_PLAN_LIST_LIMIT.max);
    expect(list.nativeExecutionEnabled).toBe(false);
    expect(list.items.some((i) => i.alertId === tv.id)).toBe(false);
    const item = list.items.find((i) => i.alertId === nat.id)!;
    expect(item).toMatchObject({ symbol: nat.symbol, sourceTimeframe: "1W", triggeredAt: TRIGGER.toISOString() });
    expect(item.plan).toMatchObject({
      state: "SELECTED", alertSource: "NATIVE", selectedLookback: 100, direction: "LONG", entryPrice: "100", stopLoss: "80", takeProfit: "130", riskRewardRatio: "1.5",
      execution: NATIVE_PLAN_EXECUTION_STATUS,
    });
    expect(NATIVE_PLAN_EXECUTION_STATUS).toBe("PLANNING ONLY / EXECUTION DISABLED");
    await expect(service.listNativePlans(0)).rejects.toThrow(/limit/);
    await expect(service.listNativePlans(NATIVE_PLAN_LIST_LIMIT.max + 1)).rejects.toThrow(/limit/);
    // A plan with nothing calculable is shown truthfully, never with prices.
    const invalid = await planner(async () => []).service.generateForAlert((await nativeAlert()).id);
    expect(selectedPlanSummaryOf(invalid)).toMatchObject({ state: "PLAN_NOT_READY", stopLoss: null, takeProfit: null, execution: NATIVE_PLAN_EXECUTION_STATUS });
  });

  async function profile(alias: string) {
    sequence += 1;
    return prisma.executionProfile.create({ data: { name: `${TAG} ${alias} ${sequence}`, accountIdentifier: `${TAG}-${alias}-${sequence}`, environment: "TESTNET", isEnabled: true } });
  }

  for (const tf of ["1D", "1W", "1M"] as const) {
    maybe()(`27-31. a READY, selected Native ${tf} plan: no fan-out marker; the executor refuses it before any signed read; creation refuses it; adoption never sees it`, async () => {
      const alert = await nativeAlert({ sourceTimeframe: tf, triggeredAt: new Date(Date.now() - 30_000) });
      const { service } = planner();
      await service.generateForAlert(alert.id);
      const plan = await service.updateSelection(alert.id, { selectedLookback: 100 });
      expect([plan.status, plan.selectedLookback, plan.alertSource]).toEqual(["READY", 100, "NATIVE"]);
      expect((await prisma.extremeRRPlan.findUniqueOrThrow({ where: { alertId: alert.id } })).executionFanoutReadyAt).toBeNull();

      // The executor: refused first, before canary lookups (prisma), the signed margin planner, or creation.
      const touched: string[] = [];
      const trap = (name: string) => new Proxy({}, { get: (_t, key) => (touched.push(`${name}.${String(key)}`), () => { throw new Error(`${name} reached`); }) });
      const executor = new SelectedPlanExecutor({
        prisma: trap("prisma") as never, marginPlanner: trap("marginPlanner") as never, executions: trap("executions") as never, orchestrator: trap("orchestrator") as never,
        boundProfile: { executionProfileId: "never", exchange: "BINANCE", product: "USDM_FUTURES", environment: "TESTNET" } as never,
      });
      expect(await executor.handleSelectedPlan(plan, alert.symbol)).toMatchObject({ handled: false, reasonCode: "NATIVE_ALERT_EXECUTION_FORBIDDEN" });
      // An allowlist, not a NATIVE denylist: a plan that does not positively say TRADINGVIEW never goes on.
      for (const alertSource of [undefined, null, "OTHER", "tradingview"]) {
        expect(await executor.handleSelectedPlan({ ...plan, alertSource } as never, alert.symbol)).toMatchObject({ handled: false, reasonCode: "NATIVE_ALERT_EXECUTION_FORBIDDEN" });
      }
      expect(touched).toEqual([]);

      // Execution creation refuses it before any write, whoever calls it.
      const p = await profile(`exec-${tf}`);
      await expect(
        new ExecutionService(prisma).createExecutionFromReadyPlan({ executionProfileId: p.id, alertId: alert.id, plan: readyMarginPlan(alert.symbol), positionSide: "LONG", selectedLookback: 100 })
      ).rejects.toBeInstanceOf(NativeAlertExecutionForbiddenError);
      expect(await prisma.tradeExecution.count({ where: { alertId: alert.id } })).toBe(0);
    });
  }

  maybe()("27/31. adoption never discovers a Native plan — even one FORCED to carry the fan-out marker — while a TradingView plan is discovered", async () => {
    const recent = new Date(Date.now() - 30_000);
    const nat = await nativeAlert({ sourceTimeframe: "1D", triggeredAt: recent });
    const tv = await tradingViewAlert({ triggeredAt: recent });
    const { service } = planner();
    await service.generateForAlert(nat.id);
    await service.generateForAlert(tv.id);
    const forced = await prisma.extremeRRPlan.update({ where: { alertId: nat.id }, data: { executionFanoutReadyAt: new Date() } });
    const executed: string[] = [];
    const executor = { handleSelectedPlan: vi.fn(async (_plan: unknown, symbol: string) => (executed.push(symbol), { handled: false, reasonCode: "MARGIN_PLAN_NOT_READY", message: "stub" })) };
    const adoption = new SelectedPlanAdoptionService({
      prisma,
      boundProfile: { executionProfileId: (await profile("adopt")).id, exchange: "BINANCE", product: "USDM_FUTURES", environment: "TESTNET" },
      executor: executor as never,
      plans: new ExtremeRRService(prisma),
      workerId: "native-rr-fence",
    });
    for (let pass = 0; pass < 3; pass += 1) await adoption.runOnce(500);
    expect(executed).toContain(tv.symbol);
    expect(executed).not.toContain(nat.symbol);
    expect(await prisma.selectedPlanAdoption.count({ where: { extremeRRPlanId: forced.id } })).toBe(0);
  });

  it("32. no private Binance path is reachable from planning: the planner and its route import no signed client", () => {
    const BACKEND = path.resolve(__dirname, "..");
    for (const rel of ["src/modules/extreme-rr/extreme-rr.service.ts", "src/routes/extreme-rr.routes.ts"]) {
      const source = readFileSync(path.join(BACKEND, rel), "utf8");
      expect(source, rel).not.toMatch(/from "\.\.\/binance\/|from "\.\.\/modules\/binance\/|signed|apiSecret|BINANCE_API_KEY|execution\.service|selected-plan-executor|orchestrator/i);
    }
  });
});
