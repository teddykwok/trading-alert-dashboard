import { describe, expect, it } from "vitest";
import {
  calculateFuturesRiskPlan,
  CROSS_MARGIN_WARNING,
  HIGH_LEVERAGE_WARNING,
  ISOLATED_MARGIN_WARNING,
  LIQUIDATION_BEFORE_STOP_WARNING,
  LIQUIDATION_BEFORE_STOP_WARNING_SHORT,
  type FuturesRiskPlanInput,
} from "@trading-alert-dashboard/shared";

const BASE_LONG: FuturesRiskPlanInput = {
  direction: "LONG",
  entryPrice: "100",
  stopLossPrice: "95",
  takeProfitPrice: "110",
  accountBalance: "1000",
  riskPercent: "1",
  leverage: "25",
  marginMode: "ISOLATED",
};

const BASE_SHORT: FuturesRiskPlanInput = {
  ...BASE_LONG,
  direction: "SHORT",
  stopLossPrice: "105",
  takeProfitPrice: "90",
};

function numericOutputs(plan: ReturnType<typeof calculateFuturesRiskPlan>): string[] {
  return [
    plan.riskPerUnit,
    plan.rewardPerUnit,
    plan.stopDistancePercent,
    plan.rewardPercent,
    plan.riskRewardRatio,
    plan.riskBudget,
    plan.positionQuantity,
    plan.positionNotional,
    plan.requiredMargin,
    plan.marginUsagePercent,
    plan.expectedProfitAtTakeProfit,
  ].filter((value): value is string => value !== null);
}

describe("calculateFuturesRiskPlan — risk/reward geometry", () => {
  it("LONG: entry 100, SL 95, TP 110 -> R:R 2", () => {
    const plan = calculateFuturesRiskPlan(BASE_LONG);

    expect(plan.valid).toBe(true);
    expect(plan.riskPerUnit).toBe("5");
    expect(plan.rewardPerUnit).toBe("10");
    expect(plan.stopDistancePercent).toBe("5");
    expect(plan.rewardPercent).toBe("10");
    expect(plan.riskRewardRatio).toBe("2");
  });

  it("SHORT: entry 100, SL 105, TP 90 -> R:R 2", () => {
    const plan = calculateFuturesRiskPlan(BASE_SHORT);

    expect(plan.valid).toBe(true);
    expect(plan.riskPerUnit).toBe("5");
    expect(plan.rewardPerUnit).toBe("10");
    expect(plan.riskRewardRatio).toBe("2");
  });

  it("rejects invalid LONG geometry (SL above entry, TP below entry)", () => {
    const badStop = calculateFuturesRiskPlan({ ...BASE_LONG, stopLossPrice: "101" });
    expect(badStop.valid).toBe(false);
    expect(badStop.validationErrors.join(" ")).toMatch(/stopLossPrice must be below entryPrice/);
    expect(badStop.riskBudget).toBeNull();

    const badTarget = calculateFuturesRiskPlan({ ...BASE_LONG, takeProfitPrice: "99" });
    expect(badTarget.valid).toBe(false);
    expect(badTarget.validationErrors.join(" ")).toMatch(/takeProfitPrice must be above entryPrice/);
  });

  it("rejects invalid SHORT geometry", () => {
    const badStop = calculateFuturesRiskPlan({ ...BASE_SHORT, stopLossPrice: "99" });
    expect(badStop.valid).toBe(false);
    expect(badStop.validationErrors.join(" ")).toMatch(/stopLossPrice must be above entryPrice/);

    const badTarget = calculateFuturesRiskPlan({ ...BASE_SHORT, takeProfitPrice: "101" });
    expect(badTarget.valid).toBe(false);
    expect(badTarget.validationErrors.join(" ")).toMatch(/takeProfitPrice must be below entryPrice/);
  });

  it("rejects zero/missing/nonsense values", () => {
    expect(calculateFuturesRiskPlan({ ...BASE_LONG, accountBalance: "0" }).valid).toBe(false);
    expect(calculateFuturesRiskPlan({ ...BASE_LONG, riskPercent: "0" }).valid).toBe(false);
    expect(calculateFuturesRiskPlan({ ...BASE_LONG, leverage: "0.5" }).valid).toBe(false);
    expect(calculateFuturesRiskPlan({ ...BASE_LONG, entryPrice: "" }).valid).toBe(false);
    expect(calculateFuturesRiskPlan({ ...BASE_LONG, stopLossPrice: "abc" }).valid).toBe(false);
    expect(calculateFuturesRiskPlan({ ...BASE_LONG, takeProfitPrice: "Infinity" }).valid).toBe(false);
    expect(calculateFuturesRiskPlan({ ...BASE_LONG, accountBalance: "NaN" }).valid).toBe(false);
  });

  it("handles small-cap prices exactly (0.004086 scale)", () => {
    const plan = calculateFuturesRiskPlan({
      ...BASE_LONG,
      entryPrice: "0.004086",
      stopLossPrice: "0.003950",
      takeProfitPrice: "0.004358",
    });

    expect(plan.valid).toBe(true);
    expect(plan.riskPerUnit).toBe("0.000136");
    expect(plan.rewardPerUnit).toBe("0.000272");
    expect(plan.riskRewardRatio).toBe("2");
  });

  it("handles very small prices (0.00001234 scale) without exponential notation", () => {
    const plan = calculateFuturesRiskPlan({
      ...BASE_LONG,
      entryPrice: "0.00001234",
      stopLossPrice: "0.00001111",
      takeProfitPrice: "0.00001480",
    });

    expect(plan.valid).toBe(true);
    expect(plan.riskPerUnit).toBe("0.00000123");
    expect(plan.rewardPerUnit).toBe("0.00000246");
    expect(plan.riskRewardRatio).toBe("2");
    for (const value of numericOutputs(plan)) {
      expect(value).not.toMatch(/[eE]/); // plain decimal strings only
    }
  });

  it("never returns NaN or Infinity in any output", () => {
    const plan = calculateFuturesRiskPlan(BASE_LONG);
    for (const value of numericOutputs(plan)) {
      expect(Number.isFinite(Number(value))).toBe(true);
    }
  });
});

describe("calculateFuturesRiskPlan — position sizing", () => {
  it("derives quantity and notional from risk budget and stop distance", () => {
    const plan = calculateFuturesRiskPlan(BASE_LONG);

    expect(plan.riskBudget).toBe("10"); // 1000 × 1 / 100
    expect(plan.riskPerUnit).toBe("5");
    expect(plan.positionQuantity).toBe("2"); // 10 / 5
    expect(plan.positionNotional).toBe("200"); // 2 × 100
    expect(plan.expectedProfitAtTakeProfit).toBe("20"); // 2 × 10
    expect(plan.riskRewardRatio).toBe("2");
    // Invariant: expected profit == riskBudget × R:R
    expect(Number(plan.expectedProfitAtTakeProfit)).toBeCloseTo(
      Number(plan.riskBudget) * Number(plan.riskRewardRatio),
      10
    );
    // Never accountBalance × leverage: that would be 25,000, not 200.
    expect(plan.positionNotional).not.toBe("25000");
  });
});

describe("calculateFuturesRiskPlan — leverage only changes margin", () => {
  it("25x vs 100x: identical risk, quantity, notional, loss and profit; only margin differs", () => {
    const at25 = calculateFuturesRiskPlan({ ...BASE_LONG, leverage: "25" });
    const at100 = calculateFuturesRiskPlan({ ...BASE_LONG, leverage: "100" });

    expect(at25.riskBudget).toBe(at100.riskBudget); // expected loss at SL unchanged
    expect(at25.positionQuantity).toBe(at100.positionQuantity);
    expect(at25.positionNotional).toBe(at100.positionNotional);
    expect(at25.expectedProfitAtTakeProfit).toBe(at100.expectedProfitAtTakeProfit);
    expect(at25.riskRewardRatio).toBe(at100.riskRewardRatio);

    expect(at25.requiredMargin).toBe("8"); // 200 / 25
    expect(at100.requiredMargin).toBe("2"); // 200 / 100 = a quarter of 8
    expect(Number(at100.requiredMargin)).toBeCloseTo(Number(at25.requiredMargin) / 4, 10);
    expect(at25.marginUsagePercent).not.toBe(at100.marginUsagePercent);
  });
});

describe("calculateFuturesRiskPlan — warnings", () => {
  it("warns when isolated required margin <= risk budget", () => {
    // margin 8 <= budget 10 -> liquidation could hit before the stop.
    const plan = calculateFuturesRiskPlan(BASE_LONG);
    expect(plan.warnings).toContain(ISOLATED_MARGIN_WARNING);

    // leverage 10 -> margin 20 > budget 10 -> no warning.
    const safer = calculateFuturesRiskPlan({ ...BASE_LONG, leverage: "10" });
    expect(safer.warnings).not.toContain(ISOLATED_MARGIN_WARNING);
  });

  it("adds the informational cross-margin warning", () => {
    const plan = calculateFuturesRiskPlan({ ...BASE_LONG, marginMode: "CROSS" });
    expect(plan.warnings).toContain(CROSS_MARGIN_WARNING);
  });

  it("LONG: warns when the supplied liquidation price is at/above the stop", () => {
    const risky = calculateFuturesRiskPlan({ ...BASE_LONG, liquidationPrice: "96" });
    expect(risky.warnings).toContain(LIQUIDATION_BEFORE_STOP_WARNING);

    const safe = calculateFuturesRiskPlan({ ...BASE_LONG, liquidationPrice: "90" });
    expect(safe.warnings).not.toContain(LIQUIDATION_BEFORE_STOP_WARNING);
  });

  it("SHORT: warns when the supplied liquidation price is at/below the stop", () => {
    const risky = calculateFuturesRiskPlan({ ...BASE_SHORT, liquidationPrice: "104" });
    expect(risky.warnings).toContain(LIQUIDATION_BEFORE_STOP_WARNING_SHORT);

    const safe = calculateFuturesRiskPlan({ ...BASE_SHORT, liquidationPrice: "110" });
    expect(safe.warnings).not.toContain(LIQUIDATION_BEFORE_STOP_WARNING_SHORT);
  });

  it("shows a neutral educational warning at high leverage without blocking", () => {
    const high = calculateFuturesRiskPlan({ ...BASE_LONG, leverage: "100" });
    expect(high.valid).toBe(true); // never blocks
    expect(high.warnings).toContain(HIGH_LEVERAGE_WARNING);

    const normal = calculateFuturesRiskPlan({ ...BASE_LONG, leverage: "25" });
    expect(normal.warnings).not.toContain(HIGH_LEVERAGE_WARNING);
  });
});
