import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Alert, PrismaClient } from "@prisma/client";
import { NATIVE_PLAN_BUILTIN_DEFAULTS, NATIVE_PLAN_EXECUTION_STATUS, parseNativeAccountPlanPolicy, previewNativeAccountPlan } from "@trading-alert-dashboard/shared";

import { connectTestDatabase } from "./helpers/test-database";
import type { SnapshotCandle } from "../src/modules/market-data/market-data.types";

/**
 * USER-APPROVED Native per-account defaults: Account A = 100 candles, Account B = 300 candles.
 *
 * Built in (no env needed); a valid explicit override (50/100/200/300) wins; an INVALID explicit override fails
 * visibly and never falls back. Read-only policy resolution: it never reads or writes a plan's global
 * selectedLookback, creates no adoption or execution, and leaves executionFanoutReadyAt null. TradingView is
 * untouched. TEST database only; fixture candles; no Binance request.
 */

const queue = vi.hoisted(() => ({ enqueueVisionAnalysis: vi.fn(async () => undefined), enqueueExtremeRRPlan: vi.fn(async () => undefined) }));
vi.mock("../src/modules/jobs/queue", () => queue);

const TAG = "native-acct-defaults-it";
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient = testDatabase;
const maybe = () => (available ? it : it.skip);

const { ExtremeRRService, NATIVE_PLAN_LIST_LIMIT } = await import("../src/modules/extreme-rr/extreme-rr.service");
const { resolveNativeAccountPlanPolicies, configuredNativeAccountPlanPolicies } = await import("../src/modules/native-planning/native-account-plan-policy");
const { SelectedPlanExecutor } = await import("../src/modules/execution/selected-plan-executor");

const M15 = 15 * 60_000;
const TRIGGER = new Date(Date.UTC(2026, 9, 5, 4, 6, 15, 123));
/** Each window has its own extreme: highs 115 / 130 / 145 / 160 for 50 / 100 / 200 / 300 (entry 100). */
function candles(trigger: Date): SnapshotCandle[] {
  const lastOpen = Math.floor(trigger.getTime() / M15) * M15 - M15;
  const rows: SnapshotCandle[] = [];
  for (let i = 319; i >= 0; i -= 1) {
    const openTimeMs = lastOpen - i * M15;
    const back = i + 1;
    rows.push({ openTimeMs, closeTimeMs: openTimeMs + M15 - 1, high: back === 20 ? "115" : back === 75 ? "130" : back === 150 ? "145" : back === 250 ? "160" : "102", low: "98" });
  }
  return rows;
}
const TP = { 50: "115", 100: "130", 200: "145", 300: "160" } as const;
const TEMPLATE = { id: "tpl-acct-defaults", name: "acct defaults", referenceCapital: "400", riskPercent: "1", rewardRatio: "1.5", isActive: true, createdAt: new Date(), updatedAt: new Date() };
const db = new Proxy(prisma, { get: (target, key) => (key === "riskTemplate" ? { findFirst: async () => TEMPLATE } : Reflect.get(target, key)) }) as PrismaClient;
/** The planner with an explicit GLOBAL initial selection (EXTREME_RR_LOOKBACK_CANDLES stand-in). */
const planner = (globalLookback: 50 | 100 | 200 | 300) => new ExtremeRRService(db, async (a: Alert) => candles(a.triggeredAt), async () => globalLookback);

let seq = 0;
const nextSymbol = () => `NACCT${++seq}${Date.now() % 100000}USDT`;
async function nativeAlert() {
  const symbol = nextSymbol();
  return prisma.alert.create({
    data: {
      symbol, assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 100, signal: "LONG", indicatorName: "Native Level Scanner", source: "NATIVE", sourceTimeframe: "1W",
      eventType: "LEVEL_TOUCHED", levelColor: "GREEN", triggeredAt: TRIGGER,
      rawPayload: { source: "NATIVE", actionable: false, symbol, marketType: "USDM_PERPETUAL", timeframe: "15m", delivery: { policyVersion: "NATIVE_DELIVERY_V2", sourceTimeframe: "1W" }, profile: { profileId: "TEDDY_7_ALL_ACTIVE_V1", nativeExecutionEnabled: false } },
    },
  });
}
async function tradingViewAlert() {
  return prisma.alert.create({ data: { symbol: nextSymbol(), assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 100, signal: "LONG", indicatorName: TAG, rawPayload: { symbol: "BINANCE:SYNTHUSDT.P", note: TAG }, triggeredAt: TRIGGER } });
}
const planRow = (alertId: string) => prisma.extremeRRPlan.findUniqueOrThrow({ where: { alertId } });

async function cleanup() {
  if (!available) return;
  await prisma.alert.deleteMany({ where: { OR: [{ symbol: { startsWith: "NACCT" } }, { indicatorName: TAG }] } });
}
beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  if (available) await prisma.$disconnect();
});

// ===========================================================================
// 1-8. The resolver
// ===========================================================================

describe("1-8. the resolver: built-in A 100 / B 300, valid overrides win, invalid overrides fail visibly", () => {
  it("the approved built-in defaults are exactly A = 100 and B = 300", () => {
    expect(NATIVE_PLAN_BUILTIN_DEFAULTS).toEqual({ A: 100, B: 300 });
    expect(Object.isFrozen(NATIVE_PLAN_BUILTIN_DEFAULTS)).toBe(true);
  });

  it("1/2/7/8. no override (absent, undefined, null or empty) resolves A = 100 and B = 300, labelled BUILTIN_DEFAULT", () => {
    for (const raw of [undefined, null, ""]) {
      expect(parseNativeAccountPlanPolicy("A", raw)).toEqual({ account: "A", state: "RESOLVED", lookback: 100, source: "BUILTIN_DEFAULT", reason: null });
      expect(parseNativeAccountPlanPolicy("B", raw)).toEqual({ account: "B", state: "RESOLVED", lookback: 300, source: "BUILTIN_DEFAULT", reason: null });
    }
    expect(resolveNativeAccountPlanPolicies({}).map((p) => [p.account, p.lookback, p.source])).toEqual([["A", 100, "BUILTIN_DEFAULT"], ["B", 300, "BUILTIN_DEFAULT"]]);
    expect(resolveNativeAccountPlanPolicies({ A: "", B: undefined }).map((p) => p.lookback)).toEqual([100, 300]);
  });

  it("3/4. a valid explicit override wins, per account, labelled ENV_OVERRIDE", () => {
    expect(resolveNativeAccountPlanPolicies({ A: "50" })).toEqual([
      { account: "A", state: "RESOLVED", lookback: 50, source: "ENV_OVERRIDE", reason: null },
      { account: "B", state: "RESOLVED", lookback: 300, source: "BUILTIN_DEFAULT", reason: null },
    ]);
    expect(resolveNativeAccountPlanPolicies({ B: "200" })).toEqual([
      { account: "A", state: "RESOLVED", lookback: 100, source: "BUILTIN_DEFAULT", reason: null },
      { account: "B", state: "RESOLVED", lookback: 200, source: "ENV_OVERRIDE", reason: null },
    ]);
    // An override equal to the built-in value is still an override (its source is reported truthfully).
    expect(parseNativeAccountPlanPolicy("A", "100")).toMatchObject({ lookback: 100, source: "ENV_OVERRIDE" });
  });

  it("5/6. an INVALID explicit override stays INVALID -- never the built-in 100 / 300 fallback", () => {
    for (const raw of ["75", " 100", "100 ", "100.0", "garbage", "1e2", "0300", "-50", "300;", 300, true, {}]) {
      for (const account of ["A", "B"] as const) {
        const policy = parseNativeAccountPlanPolicy(account, raw);
        expect({ raw: String(raw), account, state: policy.state, lookback: policy.lookback }).toEqual({ raw: String(raw), account, state: "INVALID", lookback: null });
        expect(policy.reason).toMatch(/override .* is not one of 50, 100, 200, 300/);
      }
    }
    const [a, b] = resolveNativeAccountPlanPolicies({ A: "75", B: "garbage" });
    expect([a.state, a.lookback, b.state, b.lookback]).toEqual(["INVALID", null, "INVALID", null]);
  });

  it("the generic process with no variables set resolves the built-in defaults (no env required)", async () => {
    expect((await configuredNativeAccountPlanPolicies()).map((p) => [p.account, p.lookback, p.source])).toEqual([["A", 100, "BUILTIN_DEFAULT"], ["B", 300, "BUILTIN_DEFAULT"]]);
  });
});

// ===========================================================================
// 9-15. One real READY Native plan: A 100 and B 300 at once, read-only
// ===========================================================================

describe("9-15. the same READY Native plan resolves A = 100 and B = 300, read-only", () => {
  for (const globalLookback of [50, 100] as const) {
    maybe()(`9-14. plan selection (global) ${globalLookback}: A previews the 100 window and B the 300 window; the plan row is unchanged; no adoption, no execution, no fan-out marker`, async () => {
      const alert = await nativeAlert();
      const service = planner(globalLookback);
      await service.generateForAlert(alert.id);
      const before = await planRow(alert.id);
      expect([before.status, before.selectedLookback, before.executionFanoutReadyAt]).toEqual(["READY", globalLookback, null]);

      const list = await service.listNativePlans(NATIVE_PLAN_LIST_LIMIT.max, resolveNativeAccountPlanPolicies({}));
      const item = list.items.find((i) => i.alertId === alert.id)!;
      // The plan's own global selection is reported as itself...
      expect(item.plan).toMatchObject({ selectedLookback: globalLookback, takeProfit: TP[globalLookback] });
      // ...and each account resolves its OWN window from the same frozen plan, simultaneously.
      expect(item.accountDefaults.map((d) => [d.account, d.lookback, d.source, d.state, d.takeProfit, d.execution])).toEqual([
        ["A", 100, "BUILTIN_DEFAULT", "RESOLVED", TP[100], NATIVE_PLAN_EXECUTION_STATUS],
        ["B", 300, "BUILTIN_DEFAULT", "RESOLVED", TP[300], NATIVE_PLAN_EXECUTION_STATUS],
      ]);
      expect(list.accountPolicies.map((p) => [p.account, p.lookback, p.source])).toEqual([["A", 100, "BUILTIN_DEFAULT"], ["B", 300, "BUILTIN_DEFAULT"]]);
      expect(list.nativeExecutionEnabled).toBe(false);

      // Read-only: the row is byte-for-byte what it was; nothing adopted, nothing executed, no fan-out marker.
      const after = await planRow(alert.id);
      expect(after).toEqual(before);
      expect(after.selectedLookback).toBe(globalLookback);
      expect(after.executionFanoutReadyAt).toBeNull();
      expect(await prisma.selectedPlanAdoption.count({ where: { extremeRRPlanId: after.id } })).toBe(0);
      expect(await prisma.tradeExecution.count({ where: { alertId: alert.id } })).toBe(0);
    });
  }

  maybe()("11. a manual global selection (e.g. 200) stays its own value while A = 100 and B = 300 keep resolving independently", async () => {
    const alert = await nativeAlert();
    const service = planner(300);
    await service.generateForAlert(alert.id);
    await service.updateSelection(alert.id, { selectedLookback: 200 });
    const list = await service.listNativePlans(NATIVE_PLAN_LIST_LIMIT.max, resolveNativeAccountPlanPolicies({}));
    const item = list.items.find((i) => i.alertId === alert.id)!;
    expect(item.plan.selectedLookback).toBe(200);
    expect(item.accountDefaults.map((d) => d.lookback)).toEqual([100, 300]);
    expect((await planRow(alert.id)).selectedLookback).toBe(200);
  });

  it("the preview never reads the plan's global selection: a plan selected at 50 still previews A 100 / B 300", () => {
    const candidate = (lookback: 50 | 100 | 200 | 300) => ({
      requestedCandles: lookback, actualCandles: lookback, complete: true, extremeType: "HIGHEST_HIGH" as const, extremePrice: TP[lookback], oldestCandleOpenTime: null, newestCandleCloseTime: null,
      valid: true, invalidReason: null, takeProfit: TP[lookback], stopLoss: `sl${lookback}`, rewardDistance: "1", riskDistance: "1", riskRewardRatio: "1.5", money: null,
    });
    const plan = { status: "READY" as const, errorReason: null, selectedLookback: 50, candidates: ([50, 100, 200, 300] as const).map(candidate) };
    const [a, b] = resolveNativeAccountPlanPolicies({}).map((policy) => previewNativeAccountPlan(plan, policy));
    expect([a.lookback, a.takeProfit, b.lookback, b.takeProfit]).toEqual([100, TP[100], 300, TP[300]]);
    expect(plan.selectedLookback).toBe(50);
  });

  maybe()("15. the new defaults make nothing executable: the executor still refuses the Native plan before any canary / signed read / creation", async () => {
    const alert = await nativeAlert();
    const service = planner(100);
    await service.generateForAlert(alert.id);
    const plan = (await service.getForAlert(alert.id))!;
    const touched: string[] = [];
    const trap = (name: string) => new Proxy({}, { get: (_t, key) => (touched.push(`${name}.${String(key)}`), () => { throw new Error(`${name} reached`); }) });
    const executor = new SelectedPlanExecutor({
      prisma: trap("prisma") as never, marginPlanner: trap("marginPlanner") as never, executions: trap("executions") as never, orchestrator: trap("orchestrator") as never,
      boundProfile: { executionProfileId: "never", exchange: "BINANCE", product: "USDM_FUTURES", environment: "TESTNET" } as never,
    });
    expect(await executor.handleSelectedPlan(plan, alert.symbol)).toMatchObject({ handled: false, reasonCode: "NATIVE_ALERT_EXECUTION_FORBIDDEN" });
    expect(touched).toEqual([]);
    expect((await planRow(alert.id)).executionFanoutReadyAt).toBeNull();
  });
});

// ===========================================================================
// 23-25. TradingView and the Native planner worker are untouched
// ===========================================================================

describe("23-25. TradingView and the Native planner worker are untouched", () => {
  maybe()("23/24. a TradingView plan keeps its global selection and its fan-out marker, and is never listed with Native account defaults", async () => {
    const tv = await tradingViewAlert();
    const service = planner(300);
    await service.generateForAlert(tv.id);
    const plan = await planRow(tv.id);
    expect([plan.status, plan.selectedLookback]).toEqual(["READY", 300]);
    expect(plan.executionFanoutReadyAt).not.toBeNull(); // TradingView's own eligibility, unchanged
    const list = await service.listNativePlans(NATIVE_PLAN_LIST_LIMIT.max, resolveNativeAccountPlanPolicies({ A: "50", B: "50" }));
    expect(list.items.some((i) => i.alertId === tv.id)).toBe(false);
    expect((await planRow(tv.id)).selectedLookback).toBe(300);
  });

  it("23/24/25. no TradingView, execution, adoption or Native-planner-worker module reads the Native account policy", () => {
    const BACKEND = path.resolve(__dirname, "..");
    for (const rel of [
      "src/modules/webhook/webhook.service.ts",
      "src/modules/jobs/vision-analysis.worker.ts",
      "src/modules/jobs/execution.worker.ts",
      "src/modules/jobs/selected-plan-adoption.service.ts",
      "src/modules/execution/selected-plan-executor.ts",
      "src/modules/execution/execution.service.ts",
      "src/modules/native-planning/native-plan.worker.ts",
      "src/modules/native-planning/native-plan-processor.ts",
      "src/modules/native-planning/native-plan-request.ts",
    ]) {
      const source = readFileSync(path.join(BACKEND, rel), "utf8");
      expect({ rel, hit: /native-account-plan-policy|NATIVE_PLAN_BUILTIN_DEFAULTS|parseNativeAccountPlanPolicy|NATIVE_PLAN_DEFAULT_LOOKBACK/.test(source) }).toEqual({ rel, hit: false });
    }
    // The global plan-generation window is still its own setting, default 300, unchanged.
    expect(readFileSync(path.join(BACKEND, "src/config/env.ts"), "utf8")).toMatch(/EXTREME_RR_LOOKBACK_CANDLES: z\.coerce\s*\.number\(\)\s*\.int\(\)\s*\.positive\(\)\s*\.default\(300\)/);
  });
});
