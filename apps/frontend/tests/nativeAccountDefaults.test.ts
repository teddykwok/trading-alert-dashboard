import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXTREME_RR_LOOKBACKS, parseNativeAccountPlanPolicy, previewNativeAccountPlan, type ExtremeRRCandidate } from "@trading-alert-dashboard/shared";

import {
  NATIVE_ACCOUNT_DEFAULT_SOURCE_LABEL,
  PLAN_SELECTION_IS_NOT_ACCOUNT_DEFAULT,
  presentNativeAccountDefault,
  presentNativeAccountPolicy,
} from "../src/features/plans/nativeAccountDefaults";
import { PLAN_SELECTION_LABEL } from "../src/features/plans/selectedPlanPresentation";

/**
 * Trading Control: Account A Native default 100 and Account B Native default 300 (user-approved built-ins), each
 * with its source, separate from the plan's global selection; an override reads ENV OVERRIDE, an invalid override
 * reads INVALID. Read only: no Execute / Start Account / Adopt / Apply control. Pure + source checks.
 */

const src = (rel: string) => readFileSync(path.join(process.cwd(), "src", rel), "utf8").replace(/\r\n/g, "\n");

function candidate(lookback: 50 | 100 | 200 | 300): ExtremeRRCandidate {
  const tp = { 50: "115", 100: "130", 200: "145", 300: "160" }[lookback];
  return {
    requestedCandles: lookback, actualCandles: lookback, complete: true, extremePrice: tp, oldestCandleOpenTime: null, newestCandleCloseTime: null,
    valid: true, invalidReason: null, extremeType: "HIGHEST_HIGH", takeProfit: tp, stopLoss: `sl${lookback}`, rewardDistance: "1", riskDistance: "1", riskRewardRatio: "1.5", money: null,
  };
}
const plan = { status: "READY" as const, errorReason: null, candidates: EXTREME_RR_LOOKBACKS.map(candidate) };

describe("Trading Control Native account defaults", () => {
  it("16/17. with no override, Account A shows 100 candles and Account B shows 300 candles, both BUILT-IN DEFAULT", () => {
    expect(presentNativeAccountPolicy(parseNativeAccountPlanPolicy("A", undefined))).toMatchObject({ label: "Account A Native default", value: "100 candles", source: "BUILT-IN DEFAULT", tone: "green" });
    expect(presentNativeAccountPolicy(parseNativeAccountPlanPolicy("B", undefined))).toMatchObject({ label: "Account B Native default", value: "300 candles", source: "BUILT-IN DEFAULT", tone: "green" });
    const a = presentNativeAccountDefault(previewNativeAccountPlan(plan, parseNativeAccountPlanPolicy("A", undefined)));
    const b = presentNativeAccountDefault(previewNativeAccountPlan(plan, parseNativeAccountPlanPolicy("B", undefined)));
    expect([a.value, a.source, a.detail]).toEqual(["100 candles", "BUILT-IN DEFAULT", "SL sl100 · TP 130 · RR 1:1.5"]);
    expect([b.value, b.source, b.detail]).toEqual(["300 candles", "BUILT-IN DEFAULT", "SL sl300 · TP 160 · RR 1:1.5"]);
  });

  it("19. a valid override is shown as ENV OVERRIDE", () => {
    expect(NATIVE_ACCOUNT_DEFAULT_SOURCE_LABEL).toEqual({ BUILTIN_DEFAULT: "BUILT-IN DEFAULT", ENV_OVERRIDE: "ENV OVERRIDE" });
    expect(presentNativeAccountPolicy(parseNativeAccountPlanPolicy("A", "50"))).toMatchObject({ value: "50 candles", source: "ENV OVERRIDE" });
    expect(presentNativeAccountDefault(previewNativeAccountPlan(plan, parseNativeAccountPlanPolicy("B", "200")))).toMatchObject({ value: "200 candles", source: "ENV OVERRIDE", detail: "SL sl200 · TP 145 · RR 1:1.5" });
  });

  it("20. an invalid explicit override is shown INVALID, with its reason and no window or price", () => {
    for (const raw of ["75", " 100", "garbage"]) {
      const row = presentNativeAccountDefault(previewNativeAccountPlan(plan, parseNativeAccountPlanPolicy("A", raw)));
      expect(row).toMatchObject({ value: "INVALID", source: null, tone: "red", detailExact: null });
      expect(row.detail).toMatch(/not one of 50, 100, 200, 300/);
      expect(row.value).not.toMatch(/candles/);
    }
  });

  it("18. the global plan selection is labelled separately from the account defaults, and the copy says so", () => {
    expect(PLAN_SELECTION_LABEL).toBe("Plan selection (global)");
    expect(PLAN_SELECTION_IS_NOT_ACCOUNT_DEFAULT).toMatch(/not an account execution preference/);
    expect(PLAN_SELECTION_IS_NOT_ACCOUNT_DEFAULT).toMatch(/built-in A 100, B 300 unless overridden/);
    expect(PLAN_SELECTION_IS_NOT_ACCOUNT_DEFAULT).not.toMatch(/UNSET/);
    const card = src("components/operator/NativePlansCard.tsx");
    expect(card).toContain("{row.source !== null && <span");
    expect(card).toContain("<SelectedPlanSummaryView summary={item.plan} />");
    expect(card).toContain("item.accountDefaults.map");
    expect(card).toContain("list.accountPolicies.map");
  });

  it("21/22. still read only: PLANNING ONLY + NATIVE EXECUTION DISABLED, and no Execute, Start Account, Adopt or Apply control", () => {
    const card = src("components/operator/NativePlansCard.tsx");
    expect(card).toContain("{NATIVE_PLANNING_ONLY_LABEL}");
    expect(card).toContain("{NATIVE_EXECUTION_DISABLED_LABEL}");
    expect(card).not.toMatch(/<Button|<button|onClick|onSubmit|<form|<select|<input/);
    expect(card).not.toMatch(/execute|adopt|apply|startAccount|accountControl|operatorApi|LIVE_READY/i);
  });
});
