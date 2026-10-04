import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NATIVE_PLAN_EXECUTION_STATUS, selectedPlanSummaryOf, type ExtremeRRCandidate, type ExtremeRRPlanDto } from "@trading-alert-dashboard/shared";

import { describeExecutionReason } from "../src/features/executions/executionReason";
import { NATIVE_EXECUTION_DISABLED, NATIVE_PIPELINE_NOT_APPLICABLE, NATIVE_PLAN_PLANNING_ONLY, signalPathRows } from "../src/features/alerts/signalPath";
import { NO_SELECTED_PLAN, presentSelectedPlan } from "../src/features/plans/selectedPlanPresentation";
import { NATIVE_ALERT_PLAN_NOTICE } from "../src/utils/alertSource";
import type { Alert } from "../src/types/alert";

/**
 * A Native alert uses the SAME Extreme RR planner as a TradingView alert, as
 * planning only: the Trade Plan owns the 50/100/200/300 choice, the Execution
 * tab and Trading Control only READ the selected, frozen plan, and every view
 * says execution is disabled. Pure functions plus source checks (no DOM).
 */

const src = (rel: string) => readFileSync(path.join(process.cwd(), "src", rel), "utf8").replace(/\r\n/g, "\n");

function candidate(lookback: 50 | 100 | 200 | 300, over: Partial<ExtremeRRCandidate> = {}): ExtremeRRCandidate {
  const tp = { 50: "115", 100: "130", 200: "145", 300: "160" }[lookback];
  const sl = { 50: "90", 100: "80", 200: "70", 300: "60" }[lookback];
  return {
    requestedCandles: lookback, actualCandles: lookback, complete: true, extremePrice: tp, oldestCandleOpenTime: null, newestCandleCloseTime: null,
    valid: true, invalidReason: null, extremeType: "HIGHEST_HIGH", takeProfit: tp, stopLoss: sl, rewardDistance: "15", riskDistance: "10", riskRewardRatio: "1.5", money: null,
    ...over,
  };
}

function plan(over: Partial<ExtremeRRPlanDto> = {}): ExtremeRRPlanDto {
  return {
    id: "p", alertId: "a", alertSource: "NATIVE", status: "READY", direction: "LONG", entryBasis: "ALERT_PRICE", entryPrice: "100", cutoffAt: "2026-10-03T19:36:15.123Z",
    timeframe: "15m", template: null, candidates: [candidate(50), candidate(100), candidate(200), candidate(300)], selectedLookback: 100, selectedLeverage: null,
    precision: "UNROUNDED", leverageLimitVerified: false, errorReason: null, executionOutcomes: [], executionOutcome: null, generatedAt: null, createdAt: "x", updatedAt: "x",
    ...over,
  };
}

const rowsOf = (p: ExtremeRRPlanDto | null) => Object.fromEntries(presentSelectedPlan(p === null ? null : selectedPlanSummaryOf(p)).rows.map((r) => [r.label, r.value]));

describe("the selected, frozen plan as Trading Control and the Execution tab read it", () => {
  it("26. a selected Native plan: 100 candles, LONG, entry, SL, TP, 1:1.5, NATIVE, PLANNING ONLY / EXECUTION DISABLED", () => {
    expect(rowsOf(plan())).toEqual({
      "Plan selection (global)": "100 candles", Direction: "LONG", Entry: "100", SL: "80", TP: "130", RR: "1:1.5", Source: "NATIVE", Status: "PLANNING ONLY / EXECUTION DISABLED",
    });
    expect(presentSelectedPlan(selectedPlanSummaryOf(plan())).headline).toBe("Selected plan");
    expect(NATIVE_PLAN_EXECUTION_STATUS).toBe("PLANNING ONLY / EXECUTION DISABLED");
  });

  it("only the persisted selected lookback counts, for each of 50/100/200/300", () => {
    for (const [lookback, sl, tp] of [[50, "90", "115"], [100, "80", "130"], [200, "70", "145"], [300, "60", "160"]] as const) {
      expect(rowsOf(plan({ selectedLookback: lookback }))).toMatchObject({ "Plan selection (global)": `${lookback} candles`, SL: sl, TP: tp });
    }
  });

  it("no valid selected plan is shown truthfully: no SL/TP, the reason, and still execution disabled", () => {
    for (const p of [plan({ status: "INVALID" }), plan({ status: "ERROR", errorReason: "Binance unavailable" }), plan({ candidates: [candidate(100, { valid: false, stopLoss: null, takeProfit: null, invalidReason: "Highest high is not above entry" })] }), plan({ candidates: [candidate(50)] })]) {
      const rows = rowsOf(p);
      expect(rows).not.toHaveProperty("SL");
      expect(rows).not.toHaveProperty("TP");
      expect(rows["Not calculable"]).toBeTruthy();
      expect(rows.Status).toBe(NATIVE_PLAN_EXECUTION_STATUS);
    }
    expect(rowsOf(plan({ status: "ERROR", errorReason: "Binance unavailable" }))["Not calculable"]).toBe("Binance unavailable");
    expect(presentSelectedPlan(null)).toMatchObject({ headline: "No selected plan", rows: [], status: NO_SELECTED_PLAN });
    expect(rowsOf(plan({ candidates: [candidate(100, { actualCandles: 40, complete: false })] }))["Plan selection (global)"]).toBe("100 candles (only 40 available)");
  });

  it("the summary itself (what the API returns) carries no price unless the selected plan is READY and valid", () => {
    const notSelected = [
      plan({ status: "INVALID" }),
      plan({ status: "PENDING" }),
      plan({ status: "ERROR", errorReason: "Binance unavailable" }),
      plan({ candidates: [candidate(100, { valid: false, invalidReason: "Highest high is not above entry" })] }),
      plan({ candidates: [candidate(50)] }),
    ];
    for (const p of notSelected) {
      const summary = selectedPlanSummaryOf(p);
      expect(summary.state).not.toBe("SELECTED");
      expect([summary.stopLoss, summary.takeProfit, summary.riskRewardRatio]).toEqual([null, null, null]);
      expect(summary.reason).toBeTruthy();
    }
    expect(selectedPlanSummaryOf(plan())).toMatchObject({ state: "SELECTED", stopLoss: "80", takeProfit: "130", riskRewardRatio: "1.5", reason: null });
  });

  it("a TradingView plan never reads as planning-only: its execution belongs to each account's admission", () => {
    const summary = selectedPlanSummaryOf(plan({ alertSource: "TRADINGVIEW" }));
    expect(summary.execution).toBe("DECIDED_BY_ACCOUNT_ADMISSION");
    expect(rowsOf(plan({ alertSource: "TRADINGVIEW" })).Status).not.toMatch(/PLANNING ONLY/);
  });
});

describe("alert detail: the same planner, Native stays Native", () => {
  const detail = src("pages/AlertDetailPage.tsx");

  it("the Plan tab renders the existing planner for every alert, with the Native notice above it", () => {
    expect(detail).toContain("{isNativeAlert(alert) && (");
    expect(detail).toContain("<p className=\"text-sm text-slate-500\">{NATIVE_ALERT_PLAN_NOTICE}</p>");
    // Rendered unconditionally: never behind a Native condition.
    expect(detail.split("\n").filter((line) => line.includes("<ExtremeRRPlanner")).map((line) => line.trim())).toEqual(["<ExtremeRRPlanner alert={alert} />"]);
    expect(detail).not.toMatch(/isNativeAlert\(alert\) \? \(\s*<Card className="p-4">\s*<p className="text-sm text-slate-500">\{NATIVE_ALERT_PLAN_NOTICE\}<\/p>\s*<\/Card>\s*\) : \(\s*<ExtremeRRPlanner/);
    expect(NATIVE_ALERT_PLAN_NOTICE).toMatch(/planning only/i);
    expect(NATIVE_ALERT_PLAN_NOTICE).toMatch(/execution is hard-disabled/i);
  });

  it("the planner offers the same 50/100/200/300 buttons, marks a Native plan PLANNING ONLY, and never generates on view", () => {
    const planner = src("components/alerts/ExtremeRRPlanner.tsx");
    expect(planner).toContain("EXTREME_RR_LOOKBACKS.map((lookback)");
    expect(planner).toContain("{native && <Badge tone=\"yellow\">PLANNING ONLY</Badge>}");
    // Opening the page only READS: generation happens only from the explicit button handler.
    expect(planner.match(/extremeRRApi\.generate\(/g)).toHaveLength(1);
    expect(planner.indexOf("extremeRRApi.generate(")).toBeGreaterThan(planner.indexOf("async function generate()"));
    // generate() is only ever passed as a click handler, never called (on mount or anywhere else).
    expect(planner.match(/\bgenerate\(\)/g)).toEqual(["generate()"]);
    expect(planner).toContain("onClick={generate}");
  });

  it("the Execution tab of a Native alert reads the selected plan and states execution is disabled; it never shows the execution panel", () => {
    expect(detail).toContain("Execution is disabled for Native scanner alerts, for every source timeframe.");
    expect(detail).toContain("<NativeExecutionPlanPanel alert={alert} />");
    expect(detail).toMatch(/isNativeAlert\(alert\) \? \([^]*?NativeExecutionPlanPanel[^]*?\) : \(\s*<AlertExecutionPanel alert=\{alert\} \/>/);
    const panel = src("features/executions/NativeExecutionPlanPanel.tsx");
    expect(panel).toContain("extremeRRApi\n      .getForAlert(alert.id)");
    expect(panel).not.toMatch(/generate\(|updateSelection|onClick|EXTREME_RR_LOOKBACKS/);
  });

  it("19/20. the signal path stays truthful: Native, no screenshot/AI pipeline, a planning-only plan, execution disabled", () => {
    const alert = {
      id: "a", source: "NATIVE", signal: "LONG", sourceTimeframe: "1W", status: "RECEIVED", screenshotUrl: null, aiProvider: null, duplicateCount: 0, alertContext: null,
      rawPayload: { actionable: false, delivery: { policyVersion: "NATIVE_DELIVERY_V2", evidenceClass: "PROVEN_INTRABAR_POSSIBLE" } },
    } as unknown as Alert;
    const rows = Object.fromEntries(signalPathRows(alert).map((r) => [r.label, r.value]));
    expect(rows.Source).toBe("Native scanner");
    expect(rows["Screenshot & AI"]).toBe(NATIVE_PIPELINE_NOT_APPLICABLE);
    expect(rows["Extreme RR plan"]).toBe(NATIVE_PLAN_PLANNING_ONLY);
    expect(rows.Execution).toBe(NATIVE_EXECUTION_DISABLED);
    expect(JSON.stringify(rows)).not.toMatch(/Analyzed|Pending|In progress|Waiting/);
    // A non-directional Native alert has no plan row at all.
    expect(signalPathRows({ ...alert, signal: "WATCH" } as Alert).map((r) => r.label)).not.toContain("Extreme RR plan");
  });

  it("27. the executor's Native refusal reads as planning-only, never as a failure", () => {
    const sentence = describeExecutionReason({ status: "SKIPPED", reasonCode: "NATIVE_ALERT_EXECUTION_FORBIDDEN", symbol: "BNBUSDT", direction: "LONG" });
    expect(sentence).toMatch(/planning only/i);
    expect(sentence).toMatch(/never executed/i);
  });
});

describe("Trading Control: reads the Native plan, owns no plan choice", () => {
  const page = src("pages/TradingControlPage.tsx");
  const card = src("components/operator/NativePlansCard.tsx");

  it("the Native plans card is on the page, outside the account-scoped controls (no account can execute a Native plan)", () => {
    expect(page).toContain("<NativePlansCard />");
    expect(page.indexOf("<NativePlansCard />")).toBeLessThan(page.indexOf("{account === null ? ("));
  });

  it("the card only reads: no lookback selector, no buttons, no generation, no selection writes, no account calls", () => {
    expect(card).toContain("extremeRRApi\n      .listNativePlans()");
    expect(card).not.toMatch(/EXTREME_RR_LOOKBACKS|onClick|<Button|generate\(|updateSelection|operatorApi|api\/operator|useSelectedOperatorAccount|account=\{/);
    expect(card).toContain("{NATIVE_PLAN_EXECUTION_STATUS}");
  });

  it("the account Trading Control card is untouched by Native planning", () => {
    expect(src("components/operator/TradingControlCard.tsx")).not.toMatch(/NativePlansCard|listNativePlans|selectedPlanSummaryOf/);
  });
});
