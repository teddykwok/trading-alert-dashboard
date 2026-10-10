import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXTREME_RR_LOOKBACKS,
  NATIVE_PLAN_EXECUTION_STATUS,
  parseNativeAccountPlanPolicy,
  previewNativeAccountPlan,
  type ExtremeRRCandidate,
  type ExtremeRRPlanDto,
} from "@trading-alert-dashboard/shared";

import {
  NATIVE_EXECUTION_DISABLED_LABEL,
  NATIVE_PLANNING_ONLY_LABEL,
  nativePlanStatusLabel,
  presentNativeAccountDefault,
  presentNativeAccountPolicy,
} from "../src/features/plans/nativeAccountDefaults";
import { NATIVE_PLAN_PLANNING_ONLY } from "../src/features/alerts/signalPath";
import { NATIVE_ALERT_PLAN_NOTICE } from "../src/utils/alertSource";

/**
 * Trading Control's Native plans: the frozen plan (generated automatically after delivery), the global
 * selected lookback, and each account's DEFAULT lookback preview — built-in A 100 / B 300 unless overridden. Read only:
 * PLANNING ONLY, NATIVE EXECUTION DISABLED, no execute or start-account control. Pure + source checks.
 */

const src = (rel: string) => readFileSync(path.join(process.cwd(), "src", rel), "utf8").replace(/\r\n/g, "\n");

function candidate(lookback: 50 | 100 | 200 | 300, over: Partial<ExtremeRRCandidate> = {}): ExtremeRRCandidate {
  const tp = { 50: "0.045", 100: "0.046", 200: "0.047", 300: "0.048" }[lookback];
  return {
    requestedCandles: lookback, actualCandles: lookback, complete: true, extremePrice: tp, oldestCandleOpenTime: null, newestCandleCloseTime: null,
    valid: true, invalidReason: null, extremeType: "HIGHEST_HIGH", takeProfit: tp, stopLoss: `sl${lookback}`, rewardDistance: "1", riskDistance: "1", riskRewardRatio: "1.5", money: null,
    ...over,
  };
}
const plan = (over: Partial<ExtremeRRPlanDto> = {}) => ({ status: "READY" as const, errorReason: null, candidates: EXTREME_RR_LOOKBACKS.map((l) => candidate(l)), ...over });

describe("per-account Native default rows", () => {
  it("22/23. A=100 and B=300 show different windows of the same frozen plan", () => {
    const a = presentNativeAccountDefault(previewNativeAccountPlan(plan(), parseNativeAccountPlanPolicy("A", "100")));
    const b = presentNativeAccountDefault(previewNativeAccountPlan(plan(), parseNativeAccountPlanPolicy("B", "300")));
    expect(a).toEqual({ label: "Account A Native default", value: "100 candles", source: "ENV OVERRIDE", detail: "SL sl100 · TP 0.046 · RR 1:1.5", detailExact: "SL sl100 · TP 0.046 · RR 1.5", tone: "green" });
    expect(b).toEqual({ label: "Account B Native default", value: "300 candles", source: "ENV OVERRIDE", detail: "SL sl300 · TP 0.048 · RR 1:1.5", detailExact: "SL sl300 · TP 0.048 · RR 1.5", tone: "green" });
  });

  it("24. an account with no override reads its BUILT-IN default (A 100, B 300); 25. an invalid override reads INVALID with its reason", () => {
    expect(presentNativeAccountPolicy(parseNativeAccountPlanPolicy("A", undefined))).toEqual({ label: "Account A Native default", value: "100 candles", source: "BUILT-IN DEFAULT", detail: null, detailExact: null, tone: "green" });
    expect(presentNativeAccountPolicy(parseNativeAccountPlanPolicy("B", ""))).toEqual({ label: "Account B Native default", value: "300 candles", source: "BUILT-IN DEFAULT", detail: null, detailExact: null, tone: "green" });
    expect(presentNativeAccountDefault(previewNativeAccountPlan(plan(), parseNativeAccountPlanPolicy("A", "")))).toMatchObject({ value: "100 candles", source: "BUILT-IN DEFAULT", detail: "SL sl100 · TP 0.046 · RR 1:1.5" });
    expect(presentNativeAccountDefault(previewNativeAccountPlan(plan(), parseNativeAccountPlanPolicy("B", undefined)))).toMatchObject({ value: "300 candles", source: "BUILT-IN DEFAULT", detail: "SL sl300 · TP 0.048 · RR 1:1.5" });
    const invalid = presentNativeAccountDefault(previewNativeAccountPlan(plan(), parseNativeAccountPlanPolicy("A", "75")));
    expect(invalid).toMatchObject({ value: "INVALID", tone: "red" });
    expect(invalid.detail).toMatch(/not one of 50, 100, 200, 300/);
  });

  it("a still-planning or incalculable plan never shows prices for an account", () => {
    const pending = presentNativeAccountDefault(previewNativeAccountPlan(plan({ status: "PENDING", candidates: [] }), parseNativeAccountPlanPolicy("A", "100")));
    expect(pending).toEqual({ label: "Account A Native default", value: "100 candles", source: "ENV OVERRIDE", detail: "Plan is still being generated", detailExact: null, tone: "yellow" });
    const bad = presentNativeAccountDefault(previewNativeAccountPlan(plan({ candidates: [candidate(100, { valid: false, stopLoss: null, takeProfit: null, invalidReason: "Highest high is not above entry" })] }), parseNativeAccountPlanPolicy("B", "100")));
    expect(bad.detail).toBe("Highest high is not above entry");
    expect(bad.detail).not.toMatch(/TP|SL/);
  });

  it("27. plan readiness is truthful: PENDING reads PLANNING, never READY", () => {
    expect(nativePlanStatusLabel("PENDING")).toBe("PLANNING");
    expect(nativePlanStatusLabel("READY")).toBe("READY");
    expect(nativePlanStatusLabel("ERROR")).toBe("ERROR");
    expect(nativePlanStatusLabel("INVALID")).toBe("INVALID");
  });
});

describe("the Trading Control Native plans card", () => {
  const card = src("components/operator/NativePlansCard.tsx");

  it("27/28. it states PLANNING ONLY and NATIVE EXECUTION DISABLED", () => {
    expect(NATIVE_PLANNING_ONLY_LABEL).toBe("PLANNING ONLY");
    expect(NATIVE_EXECUTION_DISABLED_LABEL).toBe("NATIVE EXECUTION DISABLED");
    expect(card).toContain("<Badge tone=\"yellow\">{NATIVE_PLANNING_ONLY_LABEL}</Badge>");
    // UI Scalability V1: DISABLED is a strong, always-visible safety panel — informational, deliberately not error red.
    const panel = card.slice(card.indexOf('data-testid="native-execution-state"') - 200, card.indexOf("{NATIVE_EXECUTION_DISABLED_LABEL}") + 40);
    expect(panel).toContain('role="status"');
    expect(panel).toContain("border-2 border-sky-400/50");
    expect(panel).not.toMatch(/red/);
    expect(card).toContain("{NATIVE_PLAN_EXECUTION_STATUS}");
    expect(NATIVE_PLAN_EXECUTION_STATUS).toBe("PLANNING ONLY / EXECUTION DISABLED");
  });

  it("29. it exposes no execute, adopt, arm, start-account or selection control: it is read only", () => {
    expect(card).not.toMatch(/<Button|<button|onClick|onSubmit|<form|<select|<input/);
    expect(card).not.toMatch(/execute|adopt|arm\b|LIVE_READY|startAccount|accountControl|operatorApi|extremeRRApi\.(generate|updateSelection|patch)/i);
    // Its only API call is the read-only paged list (a GET; see nativePlanTable.test for the request itself).
    expect([...card.matchAll(/extremeRRApi\s*\.\s*(\w+)/g)].map((m) => m[1])).toEqual(["listNativePlanPage"]);
  });

  it("it shows symbol, direction, source TF, exact entry, plan status, available lookbacks, the global selection and both account defaults", () => {
    // The per-plan fields live in the expandable row (NativePlanDetail); the policies stay on the card.
    const detail = src("components/operator/NativePlanDetail.tsx");
    for (const fragment of [
      "{item.symbol}",
      "{item.plan.direction}",
      "source TF {item.sourceTimeframe ?? \"—\"}",
      "Entry <DecimalText value={item.plan.entryPrice} />",
      "nativePlanStatusLabel(item.plan.planStatus)",
      "item.availableLookbacks",
      "<SelectedPlanSummaryView summary={item.plan} />",
      "item.accountDefaults.map",
    ]) {
      expect(detail).toContain(fragment);
    }
    expect(card).toContain("list.accountPolicies.map");
  });

  it("the Native copy says plans are generated automatically after delivery, still planning only", () => {
    expect(NATIVE_PLAN_PLANNING_ONLY).toMatch(/automatically after delivery/);
    expect(NATIVE_PLAN_PLANNING_ONLY).toMatch(/never executed/);
    expect(NATIVE_ALERT_PLAN_NOTICE).toMatch(/automatically after delivery/);
    expect(NATIVE_ALERT_PLAN_NOTICE).toMatch(/execution is hard-disabled/i);
  });
});
