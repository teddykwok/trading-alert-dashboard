import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MARGIN_ENGINE_DEFAULTS,
  calculateDynamicLeveragePlan,
  estimateIsolatedLiquidationPrice,
  type DynamicLeveragePlanInput,
  type MarginPlanLeverageBracket,
  type MarginPlanSymbolFilters,
} from "@trading-alert-dashboard/shared";
import { compareDecimalStrings } from "../src/config/env";

/**
 * Phase 3 pure-engine tests. Everything here is synthetic and deterministic —
 * no network, no credentials, no live account data.
 */

const FILTERS: MarginPlanSymbolFilters = {
  status: "TRADING",
  contractType: "PERPETUAL",
  tickSize: "0.01",
  minPrice: "0.001",
  maxPrice: "1000000",
  stepSize: "0.001",
  minQty: "0.001",
  maxQty: "1000",
  minNotional: "5",
};

/** Wide first bracket so most cases stay in bracket 1. */
const BRACKETS: MarginPlanLeverageBracket[] = [
  { bracket: 1, initialLeverage: 50, notionalFloor: "0", notionalCap: "50000", maintMarginRatio: "0.01", cum: "0" },
  { bracket: 2, initialLeverage: 20, notionalFloor: "50000", notionalCap: "250000", maintMarginRatio: "0.025", cum: "750" },
];

function input(overrides: Partial<DynamicLeveragePlanInput> = {}): DynamicLeveragePlanInput {
  return {
    symbol: "TESTAUSDT",
    direction: "LONG",
    entryPrice: "100",
    stopLoss: "96",
    riskBudgetUsd: "1.50",
    filters: FILTERS,
    brackets: BRACKETS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Core sizing
// ---------------------------------------------------------------------------

describe("core sizing", () => {
  it("sizes a LONG from risk / stop distance and rounds DOWN to LOT_SIZE", () => {
    // stopDistance 4; raw qty = 1.50 / 4 = 0.375; step 0.001 -> 0.375 exactly.
    const plan = calculateDynamicLeveragePlan(input());

    expect(plan.stopDistance).toBe("4");
    expect(plan.quantityRaw).toBe("0.375");
    expect(plan.roundedQuantity).toBe("0.375");
    expect(plan.actualPlannedLoss).toBe("1.5");
    expect(plan.positionNotional).toBe("37.5");
    expect(plan.unusedRiskBudget).toBe("0");
  });

  it("sizes a SHORT symmetrically", () => {
    const plan = calculateDynamicLeveragePlan(input({ direction: "SHORT", entryPrice: "100", stopLoss: "104" }));

    expect(plan.stopDistance).toBe("4");
    expect(plan.roundedQuantity).toBe("0.375");
    expect(plan.actualPlannedLoss).toBe("1.5");
  });

  it("always rounds quantity DOWN and never exceeds the risk budget", () => {
    // raw = 1.50 / 3.7 = 0.405405...; step 0.001 -> 0.405 (never 0.406).
    const plan = calculateDynamicLeveragePlan(input({ stopLoss: "96.3" }));

    expect(plan.quantityRaw!.startsWith("0.4054")).toBe(true);
    expect(plan.roundedQuantity).toBe("0.405");
    expect(Number(plan.actualPlannedLoss)).toBeLessThan(1.5);
    expect(plan.unusedRiskBudget).not.toBe("0");
    // Structural guarantee.
    expect(compareDecimalStrings(plan.actualPlannedLoss!, "1.50")).toBeLessThanOrEqual(0);
  });

  it("uses LOT_SIZE for the LIMIT plan, never MARKET_LOT_SIZE", () => {
    // A coarse MARKET step must not influence the result.
    const plan = calculateDynamicLeveragePlan(
      input({ filters: { ...FILTERS, stepSize: "0.001" } })
    );
    expect(plan.quantityStepSize).toBe("0.001");
    expect(plan.roundedQuantity).toBe("0.375");

    // Same inputs but a coarse LOT_SIZE step really does change sizing,
    // proving stepSize (LOT_SIZE) is the filter in use.
    const coarse = calculateDynamicLeveragePlan(input({ filters: { ...FILTERS, stepSize: "0.1" } }));
    expect(coarse.roundedQuantity).toBe("0.3");
  });

  it("skips when quantity rounds to zero", () => {
    const plan = calculateDynamicLeveragePlan(input({ filters: { ...FILTERS, stepSize: "1", minQty: "1" } }));
    expect(plan.status).toBe("SKIPPED");
    expect(plan.reason).toBe("QUANTITY_ROUNDS_TO_ZERO");
  });

  it("skips below minQty and above maxQty", () => {
    const below = calculateDynamicLeveragePlan(input({ filters: { ...FILTERS, minQty: "10" } }));
    expect(below.reason).toBe("BELOW_MIN_QUANTITY");

    const above = calculateDynamicLeveragePlan(input({ filters: { ...FILTERS, maxQty: "0.1" } }));
    expect(above.reason).toBe("ABOVE_MAX_QUANTITY");
  });

  it("skips below MIN_NOTIONAL without inflating quantity", () => {
    const plan = calculateDynamicLeveragePlan(input({ filters: { ...FILTERS, minNotional: "100" } }));

    expect(plan.status).toBe("SKIPPED");
    expect(plan.reason).toBe("BELOW_MIN_NOTIONAL");
    // Quantity was NOT increased to satisfy the exchange minimum.
    expect(plan.roundedQuantity).toBe("0.375");
    expect(plan.reasonMessage).toMatch(/exceed the risk budget/);
  });

  it("skips a symbol that is not TRADING or an unsupported contract type", () => {
    expect(calculateDynamicLeveragePlan(input({ filters: { ...FILTERS, status: "BREAK" } })).reason).toBe(
      "SYMBOL_NOT_TRADING"
    );
    expect(
      calculateDynamicLeveragePlan(input({ filters: { ...FILTERS, contractType: "CURRENT_QUARTER" } })).reason
    ).toBe("UNSUPPORTED_CONTRACT");
  });

  it("rejects malformed and contradictory inputs", () => {
    expect(calculateDynamicLeveragePlan(input({ entryPrice: "0" })).reason).toBe("INVALID_ENTRY");
    expect(calculateDynamicLeveragePlan(input({ entryPrice: "abc" })).reason).toBe("INVALID_ENTRY");
    expect(calculateDynamicLeveragePlan(input({ riskBudgetUsd: "0" })).reason).toBe("INVALID_RISK_BUDGET");
    expect(calculateDynamicLeveragePlan(input({ stopLoss: "100" })).reason).toBe("INVALID_STOP_RELATION");
    // LONG with the stop at/above entry.
    expect(calculateDynamicLeveragePlan(input({ stopLoss: "101" })).reason).toBe("INVALID_STOP_RELATION");
    // SHORT with the stop at/below entry.
    expect(
      calculateDynamicLeveragePlan(input({ direction: "SHORT", stopLoss: "99" })).reason
    ).toBe("INVALID_STOP_RELATION");
    for (const invalid of [{ entryPrice: "0" }, { stopLoss: "100" }]) {
      expect(calculateDynamicLeveragePlan(input(invalid)).status).toBe("INVALID");
    }
  });
});

// ---------------------------------------------------------------------------
// Margin policy
// ---------------------------------------------------------------------------

describe("margin policy", () => {
  it("derives target and maximum margin from the risk BUDGET", () => {
    const plan = calculateDynamicLeveragePlan(input());
    expect(plan.targetIsolatedMargin).toBe("3.75");
    expect(plan.maximumIsolatedMargin).toBe("4.9999995"); // 1.50 × 3.333333
    expect(plan.targetMarginMultiplier).toBe("2.5");
    expect(plan.maximumMarginMultiplier).toBe("3.333333");
  });

  it("uses risk 4 -> target 10 and maximum ≈ 13.333332", () => {
    const plan = calculateDynamicLeveragePlan(input({ riskBudgetUsd: "4", stopLoss: "90" }));
    expect(plan.targetIsolatedMargin).toBe("10");
    expect(plan.maximumIsolatedMargin).toBe("13.333332");
  });

  it("derives margin from the budget, not the reduced rounded loss", () => {
    // Rounding leaves unused budget, but the envelope still uses 1.50.
    const plan = calculateDynamicLeveragePlan(input({ stopLoss: "96.3" }));
    expect(plan.actualPlannedLoss).not.toBe("1.5");
    expect(plan.targetIsolatedMargin).toBe("3.75");
  });

  it("validates multipliers and enforces maximum >= target", () => {
    expect(calculateDynamicLeveragePlan(input({ targetMarginMultiplier: "0" })).reason).toBe("INVALID_MULTIPLIERS");
    expect(
      calculateDynamicLeveragePlan(input({ targetMarginMultiplier: "3", maximumMarginMultiplier: "2" })).reason
    ).toBe("INVALID_MULTIPLIERS");
    expect(calculateDynamicLeveragePlan(input({ liquidationBufferRatio: "-1" })).reason).toBe("INVALID_MULTIPLIERS");
    // Equal is allowed.
    expect(
      calculateDynamicLeveragePlan(input({ targetMarginMultiplier: "2.5", maximumMarginMultiplier: "2.5" })).status
    ).not.toBe("INVALID");
  });

  it("treats maximum margin as a hard ceiling and target as merely preferred", () => {
    const plan = calculateDynamicLeveragePlan(input());
    expect(plan.status).toBe("READY");

    const margin = Number(plan.estimatedInitialMargin);
    expect(margin).toBeLessThanOrEqual(Number(plan.maximumIsolatedMargin));
    // Selected margin may sit below the target — that is allowed.
    for (const candidate of plan.candidates.filter((c) => c.eligible)) {
      expect(Number(candidate.estimatedInitialMargin)).toBeLessThanOrEqual(Number(plan.maximumIsolatedMargin));
    }
  });

  it("skips when every supported leverage needs more than the maximum margin", () => {
    // Huge notional vs a tiny risk budget: even max leverage cannot fit.
    const plan = calculateDynamicLeveragePlan(
      input({
        entryPrice: "100",
        stopLoss: "99.99",
        riskBudgetUsd: "1.50",
        filters: { ...FILTERS, stepSize: "1", minQty: "1", minNotional: "5" },
      })
    );
    expect(plan.status).toBe("SKIPPED");
    expect(plan.reason).toBe("REQUIRED_MARGIN_EXCEEDS_MAXIMUM");
    expect(plan.selectedLeverage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

describe("candidate selection", () => {
  /** Notional 75 with target 3.75 -> 20x is exact. */
  it("selects the exact candidate when one hits the target precisely", () => {
    // qty 0.75 @ 100 = notional 75; risk 1.50 target margin 3.75; 75/20 = 3.75
    const plan = calculateDynamicLeveragePlan(input({ stopLoss: "98" }));
    expect(plan.positionNotional).toBe("75");
    expect(plan.targetIsolatedMargin).toBe("3.75");
    expect(plan.selectedLeverage).toBe(20);
    expect(plan.estimatedInitialMargin).toBe("3.75");
    expect(plan.marginDifferenceFromTarget).toBe("0");
  });

  it("picks the nearest candidate to the target (notional 80.09 -> 21x)", () => {
    // qty 1 @ 80.09 -> notional 80.09; target 3.75.
    // 21x -> 3.8138… (diff 0.0638), 22x -> 3.6404… (diff 0.1095) -> 21x wins.
    const plan = calculateDynamicLeveragePlan(
      input({ entryPrice: "80.09", stopLoss: "78.59", riskBudgetUsd: "1.50", filters: { ...FILTERS, stepSize: "1", minQty: "1" } })
    );
    expect(plan.positionNotional).toBe("80.09");
    expect(plan.selectedLeverage).toBe(21);
  });

  it("chooses the LOWER leverage when two candidates are equally close", () => {
    // qty 1 @ 12 -> notional 12, target margin 3.5 (deliberately unreachable
    // exactly). 3x -> margin 4 (diff 0.5) and 4x -> margin 3 (diff 0.5): a
    // genuine tie with no exact hit, so the LOWER leverage (3x) must win.
    const plan = calculateDynamicLeveragePlan(
      input({
        entryPrice: "12",
        stopLoss: "11",
        riskBudgetUsd: "1",
        targetMarginMultiplier: "3.5", // target 3.5
        maximumMarginMultiplier: "12", // max 12
        filters: { ...FILTERS, stepSize: "1", minQty: "1", minNotional: "1" },
        liquidationBufferRatio: "0",
      })
    );
    expect(plan.positionNotional).toBe("12");
    expect(plan.targetIsolatedMargin).toBe("3.5");

    const three = plan.candidates.find((c) => c.leverage === 3)!;
    const four = plan.candidates.find((c) => c.leverage === 4)!;
    expect(three.estimatedInitialMargin).toBe("4");
    expect(four.estimatedInitialMargin).toBe("3");
    expect(three.eligible && four.eligible).toBe(true);
    // No candidate is closer than 0.5, and both are exactly 0.5 away.
    expect(plan.selectedLeverage).toBe(3);
  });

  it("never exceeds the bracket maximum leverage", () => {
    const capped = calculateDynamicLeveragePlan(
      input({ brackets: [{ ...BRACKETS[0], initialLeverage: 5 }] })
    );
    expect(capped.maximumSupportedLeverage).toBe(5);
    expect(capped.candidates.every((candidate) => candidate.leverage <= 5)).toBe(true);
    expect(capped.selectedLeverage === null || capped.selectedLeverage <= 5).toBe(true);
  });

  it("ignores the account's currently configured leverage entirely", () => {
    // The engine input has no field for current leverage: the bracket maximum
    // is the only ceiling. Proven by the DTO shape plus the capped case above.
    const plan = calculateDynamicLeveragePlan(input({ brackets: [{ ...BRACKETS[0], initialLeverage: 10 }] }));
    expect(plan.maximumSupportedLeverage).toBe(10);
    expect(Object.keys(input())).not.toContain("currentLeverage");
  });

  it("returns a stable reason when no leverage is liquidation-safe", () => {
    // Buffer so large that no liquidation price can satisfy it.
    const plan = calculateDynamicLeveragePlan(input({ liquidationBufferRatio: "1000" }));
    expect(plan.status).toBe("SKIPPED");
    expect(plan.reason).toBe("NO_LIQUIDATION_SAFE_LEVERAGE");
    expect(plan.selectedLeverage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// User maximum automation leverage
// ---------------------------------------------------------------------------

describe("user maximum automation leverage", () => {
  /**
   * The live 51x BTC example: entry 64000, stop 63500, risk 1.50 -> qty 0.003,
   * notional 192, max margin 4.9999995. Margin fits the ceiling only from
   * 39x up (192/39 ≈ 4.92), and unconstrained selection picks 51x
   * (192/51 ≈ 3.7647, nearest to the 3.75 target).
   */
  const BTC_LIKE = () =>
    input({
      entryPrice: "64000",
      stopLoss: "63500",
      riskBudgetUsd: "1.50",
      brackets: [
        { bracket: 1, initialLeverage: 150, notionalFloor: "0", notionalCap: "50000", maintMarginRatio: "0.004", cum: "0" },
      ],
    });

  it("skips the 51x plan under the default 25x cap with the dedicated reason", () => {
    const plan = calculateDynamicLeveragePlan({ ...BTC_LIKE(), userMaximumAutomationLeverage: 25 });

    expect(plan.binanceMaximumSupportedLeverage).toBe(150);
    expect(plan.userMaximumAutomationLeverage).toBe(25);
    expect(plan.usableMaximumLeverage).toBe(25);
    expect(plan.status).toBe("SKIPPED");
    expect(plan.reason).toBe("USER_LEVERAGE_CAP_PREVENTS_SAFE_PLAN");
    expect(plan.selectedLeverage).toBeNull();
    // Only capped candidates were generated or shown.
    expect(plan.candidates.length).toBe(25);
    expect(plan.candidates.every((candidate) => candidate.leverage <= 25)).toBe(true);
  });

  it("becomes READY again with a 50x-or-higher cap when all safety rules pass", () => {
    const at50 = calculateDynamicLeveragePlan({ ...BTC_LIKE(), userMaximumAutomationLeverage: 50 });
    expect(at50.status).toBe("READY");
    expect(at50.usableMaximumLeverage).toBe(50);
    // 51x is above the cap; the nearest usable candidate is 50x.
    expect(at50.selectedLeverage).toBe(50);

    const at55 = calculateDynamicLeveragePlan({ ...BTC_LIKE(), userMaximumAutomationLeverage: 55 });
    expect(at55.status).toBe("READY");
    expect(at55.selectedLeverage).toBe(51); // the original unconstrained pick
  });

  it("lets a lower Binance bracket maximum win over the user cap", () => {
    const plan = calculateDynamicLeveragePlan(
      input({ userMaximumAutomationLeverage: 25, brackets: [{ ...BRACKETS[0], initialLeverage: 8 }] })
    );
    expect(plan.binanceMaximumSupportedLeverage).toBe(8);
    expect(plan.usableMaximumLeverage).toBe(8);
    expect(plan.candidates.every((candidate) => candidate.leverage <= 8)).toBe(true);
  });

  it("lets a lower user cap win over the Binance bracket maximum", () => {
    const plan = calculateDynamicLeveragePlan(input({ userMaximumAutomationLeverage: 5 }));
    expect(plan.binanceMaximumSupportedLeverage).toBe(50);
    expect(plan.usableMaximumLeverage).toBe(5);
    expect(plan.candidates.every((candidate) => candidate.leverage <= 5)).toBe(true);
    expect(plan.selectedLeverage === null || plan.selectedLeverage <= 5).toBe(true);
  });

  it("never recommends above either limit and defaults the cap to 25", () => {
    const defaulted = calculateDynamicLeveragePlan(input());
    expect(defaulted.userMaximumAutomationLeverage).toBe(25);

    for (const cap of [1, 3, 10, 25, 50]) {
      const plan = calculateDynamicLeveragePlan({ ...BTC_LIKE(), userMaximumAutomationLeverage: cap });
      if (plan.selectedLeverage !== null) {
        expect(plan.selectedLeverage).toBeLessThanOrEqual(cap);
        expect(plan.selectedLeverage).toBeLessThanOrEqual(plan.binanceMaximumSupportedLeverage!);
      }
    }
  });

  it("rejects a non-integer or non-positive cap", () => {
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      const plan = calculateDynamicLeveragePlan({ ...input(), userMaximumAutomationLeverage: bad });
      expect(plan.status).toBe("INVALID");
      expect(plan.reason).toBe("INVALID_MULTIPLIERS");
    }
  });

  it("keeps genuine non-cap skip reasons when the cap is not the blocker", () => {
    // Margin cannot fit even at the Binance maximum -> not a cap problem.
    const impossible = calculateDynamicLeveragePlan(
      input({
        entryPrice: "100",
        stopLoss: "99.99",
        riskBudgetUsd: "1.50",
        filters: { ...FILTERS, stepSize: "1", minQty: "1", minNotional: "5" },
      })
    );
    expect(impossible.reason).toBe("REQUIRED_MARGIN_EXCEEDS_MAXIMUM");

    // Nothing is liquidation-safe at ANY leverage -> not a cap problem either.
    const unsafe = calculateDynamicLeveragePlan(input({ liquidationBufferRatio: "1000" }));
    expect(unsafe.reason).toBe("NO_LIQUIDATION_SAFE_LEVERAGE");
  });
});

// ---------------------------------------------------------------------------
// PRICE_FILTER validation
// ---------------------------------------------------------------------------

describe("PRICE_FILTER validation", () => {
  it("accepts valid tick-aligned small crypto prices", () => {
    const plan = calculateDynamicLeveragePlan(
      input({
        entryPrice: "0.2707",
        stopLoss: "0.2653",
        riskBudgetUsd: "1.50",
        filters: { ...FILTERS, tickSize: "0.0001", minPrice: "0.0001", maxPrice: "2000" },
      })
    );
    expect(plan.reason ?? "NONE").not.toMatch(/TICK|MINIMUM|MAXIMUM/);
  });

  it("fails closed on an off-tick entry (never silently rounds)", () => {
    const plan = calculateDynamicLeveragePlan(
      input({
        entryPrice: "0.27075",
        stopLoss: "0.2653",
        filters: { ...FILTERS, tickSize: "0.0001" },
      })
    );
    expect(plan.status).toBe("INVALID");
    expect(plan.reason).toBe("ENTRY_PRICE_NOT_TICK_ALIGNED");
    expect(plan.reasonMessage).toMatch(/never rounded/);
  });

  it("fails closed on an off-tick EXECUTION_LOCKED stop for LONG and SHORT", () => {
    // A calculated stop is normalized instead (see the normalization suite);
    // only an explicitly execution-locked stop still fails closed here.
    const long = calculateDynamicLeveragePlan(
      input({
        entryPrice: "0.2707",
        stopLoss: "0.26531",
        stopLossSource: "EXECUTION_LOCKED",
        filters: { ...FILTERS, tickSize: "0.0001" },
      })
    );
    expect(long.reason).toBe("STOP_PRICE_NOT_TICK_ALIGNED");

    const short = calculateDynamicLeveragePlan(
      input({
        direction: "SHORT",
        entryPrice: "0.2707",
        stopLoss: "0.27615",
        stopLossSource: "EXECUTION_LOCKED",
        filters: { ...FILTERS, tickSize: "0.0001" },
      })
    );
    expect(short.reason).toBe("STOP_PRICE_NOT_TICK_ALIGNED");

    // The same inputs as CALCULATED normalize rather than fail.
    const normalized = calculateDynamicLeveragePlan(
      input({ entryPrice: "0.2707", stopLoss: "0.26531", filters: { ...FILTERS, tickSize: "0.0001" } })
    );
    expect(normalized.reason).not.toBe("STOP_PRICE_NOT_TICK_ALIGNED");
    expect(normalized.executableStopLoss).toBe("0.2653");
  });

  it("rejects prices below the minimum and above the maximum", () => {
    const entryLow = calculateDynamicLeveragePlan(
      input({ entryPrice: "0.5", stopLoss: "0.4", filters: { ...FILTERS, minPrice: "1", tickSize: "0.1" } })
    );
    expect(entryLow.reason).toBe("ENTRY_PRICE_BELOW_MINIMUM");

    const stopLow = calculateDynamicLeveragePlan(
      input({ entryPrice: "2", stopLoss: "0.5", filters: { ...FILTERS, minPrice: "1", tickSize: "0.1" } })
    );
    expect(stopLow.reason).toBe("STOP_PRICE_BELOW_MINIMUM");

    const entryHigh = calculateDynamicLeveragePlan(
      input({ entryPrice: "2000", stopLoss: "500", filters: { ...FILTERS, maxPrice: "1000" } })
    );
    expect(entryHigh.reason).toBe("ENTRY_PRICE_ABOVE_MAXIMUM");

    const stopHigh = calculateDynamicLeveragePlan(
      input({ direction: "SHORT", entryPrice: "900", stopLoss: "1500", filters: { ...FILTERS, maxPrice: "1000" } })
    );
    expect(stopHigh.reason).toBe("STOP_PRICE_ABOVE_MAXIMUM");
  });

  it("treats zero-valued filter components as disabled", () => {
    const plan = calculateDynamicLeveragePlan(
      input({ filters: { ...FILTERS, minPrice: "0", maxPrice: "0", tickSize: "0" } })
    );
    // No price-filter rejection; sizing proceeds normally.
    expect(plan.reason ?? "NONE").not.toMatch(/TICK|MINIMUM|MAXIMUM/);
    expect(plan.roundedQuantity).toBe("0.375");
  });

  it("uses exact decimal alignment, not float modulo", () => {
    // 0.1 + 0.2 style traps: 0.3 is exactly divisible by 0.1 in decimal
    // arithmetic even though 0.3 % 0.1 !== 0 in JS floats.
    expect((0.3 % 0.1 === 0)).toBe(false); // the float trap is real
    const plan = calculateDynamicLeveragePlan(
      input({ entryPrice: "0.3", stopLoss: "0.2", filters: { ...FILTERS, tickSize: "0.1", minNotional: "0" } })
    );
    expect(plan.reason).not.toBe("ENTRY_PRICE_NOT_TICK_ALIGNED");
    expect(plan.reason).not.toBe("STOP_PRICE_NOT_TICK_ALIGNED");
  });

  it("leaves all existing valid fixtures unaffected", () => {
    // The original baseline case still sizes identically.
    const plan = calculateDynamicLeveragePlan(input());
    expect(plan.roundedQuantity).toBe("0.375");
    expect(plan.actualPlannedLoss).toBe("1.5");
    expect(plan.targetIsolatedMargin).toBe("3.75");
  });
});

// ---------------------------------------------------------------------------
// Stop-loss execution-price normalization
// ---------------------------------------------------------------------------

describe("stop-loss tick normalization", () => {
  /** FRAX-style filters: 0.0001 tick, fine LOT_SIZE. */
  const FRAX = {
    ...FILTERS,
    tickSize: "0.0001",
    minPrice: "0.0001",
    maxPrice: "2000",
    stepSize: "1",
    minQty: "1",
    minNotional: "5",
  };

  it("FRAX-style LONG: 0.26563 on a 0.0001 tick becomes 0.2656 (rounded DOWN)", () => {
    const plan = calculateDynamicLeveragePlan(
      input({ symbol: "FRAXUSDT", entryPrice: "0.2707", stopLoss: "0.26563", riskBudgetUsd: "1.50", filters: FRAX })
    );

    expect(plan.calculatedStopLoss).toBe("0.26563");
    expect(plan.executableStopLoss).toBe("0.2656");
    expect(plan.stopLoss).toBe("0.2656"); // downstream uses the executable stop
    expect(plan.stopAdjustment).toBe("-0.00003");
    expect(plan.stopNormalization).toBe("STOP_PRICE_NORMALIZED_TO_TICK");
    const warning = plan.warnings.find((w) => w.startsWith("STOP_PRICE_NORMALIZED_TO_TICK"))!;
    expect(warning).toContain("Stop moved away from entry to match the exchange tick.");
    expect(warning).toContain(
      "Quantity was recalculated downward so planned loss remains within the risk budget."
    );
    // The misleading absolute claim must be gone.
    expect(warning).not.toContain("risk cannot increase");
    // Not an error: normalization is expected for calculated stops.
    expect(plan.reason).not.toBe("STOP_PRICE_NOT_TICK_ALIGNED");
  });

  it("equivalent SHORT rounds UP", () => {
    const plan = calculateDynamicLeveragePlan(
      input({
        symbol: "FRAXUSDT",
        direction: "SHORT",
        entryPrice: "0.2707",
        stopLoss: "0.27577",
        riskBudgetUsd: "1.50",
        filters: FRAX,
      })
    );

    expect(plan.calculatedStopLoss).toBe("0.27577");
    expect(plan.executableStopLoss).toBe("0.2758");
    expect(plan.stopAdjustment).toBe("0.00003");
    expect(plan.stopNormalization).toBe("STOP_PRICE_NORMALIZED_TO_TICK");
  });

  it("never moves the stop toward entry (distance can only grow)", () => {
    const cases = [
      { direction: "LONG" as const, entryPrice: "0.2707", stopLoss: "0.26563" },
      { direction: "LONG" as const, entryPrice: "0.2707", stopLoss: "0.265678" },
      { direction: "SHORT" as const, entryPrice: "0.2707", stopLoss: "0.27577" },
      { direction: "SHORT" as const, entryPrice: "0.2707", stopLoss: "0.275712" },
    ];

    for (const testCase of cases) {
      const plan = calculateDynamicLeveragePlan(input({ ...testCase, riskBudgetUsd: "1.50", filters: FRAX }));
      const entry = Number(plan.entryPrice);
      const calculatedDistance = Math.abs(entry - Number(plan.calculatedStopLoss));
      const executableDistance = Math.abs(entry - Number(plan.executableStopLoss));

      expect(executableDistance).toBeGreaterThanOrEqual(calculatedDistance);
      if (testCase.direction === "LONG") {
        expect(Number(plan.executableStopLoss)).toBeLessThanOrEqual(Number(plan.calculatedStopLoss));
      } else {
        expect(Number(plan.executableStopLoss)).toBeGreaterThanOrEqual(Number(plan.calculatedStopLoss));
      }
    }
  });

  it("recalculates quantity, loss and notional from the EXECUTABLE stop", () => {
    const plan = calculateDynamicLeveragePlan(
      input({ symbol: "FRAXUSDT", entryPrice: "0.2707", stopLoss: "0.26563", riskBudgetUsd: "1.50", filters: FRAX })
    );

    // stopDistance = 0.2707 − 0.2656 = 0.0051 (executable), not 0.00507.
    expect(plan.stopDistance).toBe("0.0051");
    // quantityRaw = 1.50 / 0.0051 = 294.11…; step 1 -> 294.
    expect(plan.quantityRaw!.startsWith("294.1176")).toBe(true);
    expect(plan.roundedQuantity).toBe("294");
    // loss = 294 × 0.0051 = 1.4994 <= 1.50
    expect(plan.actualPlannedLoss).toBe("1.4994");
    expect(plan.positionNotional).toBe("79.5858"); // 294 × 0.2707
  });

  it("keeps actualPlannedLoss <= riskBudgetUsd after normalization", () => {
    for (const stopLoss of ["0.26563", "0.265678", "0.2651", "0.26509"]) {
      const plan = calculateDynamicLeveragePlan(
        input({ symbol: "FRAXUSDT", entryPrice: "0.2707", stopLoss, riskBudgetUsd: "1.50", filters: FRAX })
      );
      expect(Number(plan.actualPlannedLoss)).toBeLessThanOrEqual(1.5);
    }
  });

  it("leaves an already-aligned stop completely unchanged", () => {
    const plan = calculateDynamicLeveragePlan(
      input({ symbol: "FRAXUSDT", entryPrice: "0.2707", stopLoss: "0.2656", riskBudgetUsd: "1.50", filters: FRAX })
    );

    expect(plan.calculatedStopLoss).toBe("0.2656");
    expect(plan.executableStopLoss).toBe("0.2656");
    expect(plan.stopAdjustment).toBeNull();
    expect(plan.stopNormalization).toBeNull();
    expect(plan.warnings.some((w) => w.includes("NORMALIZED"))).toBe(false);
  });

  it("leaves the stop unchanged when the tick filter is disabled (zero)", () => {
    const plan = calculateDynamicLeveragePlan(
      input({ entryPrice: "100", stopLoss: "96.12345", filters: { ...FILTERS, tickSize: "0" } })
    );
    expect(plan.executableStopLoss).toBe("96.12345");
    expect(plan.stopNormalization).toBeNull();
  });

  it("still fails closed for an EXECUTION_LOCKED stop", () => {
    const plan = calculateDynamicLeveragePlan(
      input({
        symbol: "FRAXUSDT",
        entryPrice: "0.2707",
        stopLoss: "0.26563",
        stopLossSource: "EXECUTION_LOCKED",
        filters: FRAX,
      })
    );
    expect(plan.status).toBe("INVALID");
    expect(plan.reason).toBe("STOP_PRICE_NOT_TICK_ALIGNED");
    expect(plan.reasonMessage).toMatch(/execution-locked/);
  });

  it("keeps an off-tick ENTRY invalid regardless of stop source", () => {
    for (const source of ["CALCULATED", "EXECUTION_LOCKED"] as const) {
      const plan = calculateDynamicLeveragePlan(
        input({ entryPrice: "0.27075", stopLoss: "0.2656", stopLossSource: source, filters: FRAX })
      );
      expect(plan.status).toBe("INVALID");
      expect(plan.reason).toBe("ENTRY_PRICE_NOT_TICK_ALIGNED");
    }
  });

  it("defaults the stop source to CALCULATED and reports it", () => {
    const plan = calculateDynamicLeveragePlan(input());
    expect(plan.stopLossSource).toBe("CALCULATED");
  });

  it("rejects a normalized stop that would fall below the symbol minimum price", () => {
    const plan = calculateDynamicLeveragePlan(
      input({
        entryPrice: "0.0005",
        stopLoss: "0.00019",
        filters: { ...FRAX, tickSize: "0.0001", minPrice: "0.0002" },
      })
    );
    expect(plan.status).toBe("INVALID");
    expect(plan.reason).toBe("STOP_PRICE_BELOW_MINIMUM");
  });
});

// ---------------------------------------------------------------------------
// Bracket resolution
// ---------------------------------------------------------------------------

describe("bracket resolution", () => {
  it("selects the bracket containing the notional and respects floor/cap", () => {
    const small = calculateDynamicLeveragePlan(input());
    expect(small.applicableBracket?.bracket).toBe(1);
    expect(small.applicableBracket?.maintMarginRatio).toBe("0.01");

    // Notional 60000 -> bracket 2 (floor 50000, cap 250000, max 20x).
    const large = calculateDynamicLeveragePlan(
      input({
        entryPrice: "60000",
        stopLoss: "30000",
        riskBudgetUsd: "30000",
        filters: { ...FILTERS, stepSize: "1", minQty: "1", maxQty: "100000" },
      })
    );
    expect(large.applicableBracket?.bracket).toBe(2);
    expect(large.maximumSupportedLeverage).toBe(20);
    expect(large.applicableBracket?.cum).toBe("750");
  });

  it("skips when the notional falls outside every bracket", () => {
    const plan = calculateDynamicLeveragePlan(
      input({ brackets: [{ ...BRACKETS[0], notionalFloor: "1000", notionalCap: "2000" }] })
    );
    expect(plan.status).toBe("SKIPPED");
    expect(plan.reason).toBe("NOTIONAL_OUTSIDE_BRACKETS");
  });

  it("skips when no bracket data is supplied", () => {
    const plan = calculateDynamicLeveragePlan(input({ brackets: [] }));
    expect(plan.reason).toBe("LEVERAGE_BRACKET_UNAVAILABLE");
  });

  it("preserves decimal strings exactly in authoritative output", () => {
    const plan = calculateDynamicLeveragePlan(input());
    expect(plan.entryPrice).toBe("100");
    expect(plan.applicableBracket?.maintMarginRatio).toBe("0.01");
    expect(plan.applicableBracket?.cum).toBe("0");
    for (const value of [plan.stopDistance, plan.positionNotional, plan.targetIsolatedMargin]) {
      expect(typeof value).toBe("string");
      expect(value).not.toMatch(/e[+-]/i); // never exponent notation
    }
  });
});

// ---------------------------------------------------------------------------
// Liquidation estimation and guard
// ---------------------------------------------------------------------------

describe("liquidation estimation", () => {
  /**
   * Binance-like fixtures. Each is internally consistent with the published
   * balance condition (margin balance = maintenance margin), including the
   * maintenance amount `cum`, and stands in for a Binance-reported value.
   */
  const FIXTURES = [
    // LONG: qty 729 @ 0.16927, wallet 12.3775, mmr 0.01, cum 0
    // (729·0.16927 − 12.3775 − 0) / (729·0.99)
    { direction: "LONG" as const, quantity: "729", entryPrice: "0.16927", isolatedWallet: "12.3775", mmr: "0.01", cum: "0", reported: "0.153827" },
    // SHORT: qty 1.37 @ 55.458, wallet 12.87, mmr 0.01, cum 0
    // (1.37·55.458 + 12.87) / (1.37·1.01)
    { direction: "SHORT" as const, quantity: "1.37", entryPrice: "55.458", isolatedWallet: "12.87", mmr: "0.01", cum: "0", reported: "64.20268" },
    // LONG with a non-zero maintenance amount:
    // (100·50 − 500 − 75) / (100·0.975) = 4425 / 97.5 = 45.384615…
    { direction: "LONG" as const, quantity: "100", entryPrice: "50", isolatedWallet: "500", mmr: "0.025", cum: "75", reported: "45.384615" },
  ];

  it("matches Binance-like fixtures within max(1 tick, 0.1% relative)", () => {
    for (const fixture of FIXTURES) {
      const estimate = estimateIsolatedLiquidationPrice({
        direction: fixture.direction,
        quantity: fixture.quantity,
        entryPrice: fixture.entryPrice,
        isolatedWallet: fixture.isolatedWallet,
        brackets: [
          {
            bracket: 1,
            initialLeverage: 50,
            notionalFloor: "0",
            notionalCap: "1000000",
            maintMarginRatio: fixture.mmr,
            cum: fixture.cum,
          },
        ],
      });

      expect(estimate.available).toBe(true);
      const estimated = Number(estimate.price);
      const reported = Number(fixture.reported);
      const relative = (Math.abs(estimated - reported) / reported) * 100;
      expect(relative).toBeLessThanOrEqual(0.1);
    }
  });

  it("applies the documented LONG and SHORT algebra", () => {
    // LONG: (10·100 − 200 − 0) / (10·0.99) = 800 / 9.9 = 80.808…
    const long = estimateIsolatedLiquidationPrice({
      direction: "LONG",
      quantity: "10",
      entryPrice: "100",
      isolatedWallet: "200",
      brackets: [{ bracket: 1, initialLeverage: 50, notionalFloor: "0", notionalCap: "100000", maintMarginRatio: "0.01", cum: "0" }],
    });
    expect(long.price!.startsWith("80.8080")).toBe(true);

    // SHORT: (10·100 + 200 + 0) / (10·1.01) = 1200 / 10.1 = 118.811…
    const short = estimateIsolatedLiquidationPrice({
      direction: "SHORT",
      quantity: "10",
      entryPrice: "100",
      isolatedWallet: "200",
      brackets: [{ bracket: 1, initialLeverage: 50, notionalFloor: "0", notionalCap: "100000", maintMarginRatio: "0.01", cum: "0" }],
    });
    expect(short.price!.startsWith("118.811")).toBe(true);
  });

  it("uses the maintenance amount (cum) when Binance supplies one", () => {
    const withCum = estimateIsolatedLiquidationPrice({
      direction: "LONG",
      quantity: "10",
      entryPrice: "100",
      isolatedWallet: "200",
      brackets: [{ bracket: 1, initialLeverage: 50, notionalFloor: "0", notionalCap: "100000", maintMarginRatio: "0.01", cum: "50" }],
    });
    // (1000 − 200 − 50) / 9.9 = 75.7575…
    expect(withCum.price!.startsWith("75.757")).toBe(true);
  });

  it("re-resolves the bracket around the liquidation price", () => {
    // Entry notional sits in bracket 2, but the liquidation notional falls
    // back into bracket 1; the estimate must settle on a consistent bracket.
    const estimate = estimateIsolatedLiquidationPrice({
      direction: "LONG",
      quantity: "1000",
      entryPrice: "100",
      isolatedWallet: "20000",
      brackets: [
        { bracket: 1, initialLeverage: 50, notionalFloor: "0", notionalCap: "90000", maintMarginRatio: "0.01", cum: "0" },
        { bracket: 2, initialLeverage: 20, notionalFloor: "90000", notionalCap: "500000", maintMarginRatio: "0.025", cum: "1350" },
      ],
    });
    expect(estimate.available).toBe(true);
    expect(estimate.bracket).not.toBeNull();
  });

  it("fails closed when required data is missing", () => {
    const noBrackets = estimateIsolatedLiquidationPrice({
      direction: "LONG",
      quantity: "10",
      entryPrice: "100",
      isolatedWallet: "200",
      brackets: [],
    });
    expect(noBrackets.available).toBe(false);
    expect(noBrackets.price).toBeNull();
    expect(noBrackets.unavailableReason).toMatch(/no leverage brackets/);

    const badQuantity = estimateIsolatedLiquidationPrice({
      direction: "LONG",
      quantity: "0",
      entryPrice: "100",
      isolatedWallet: "200",
      brackets: BRACKETS,
    });
    expect(badQuantity.available).toBe(false);
  });

  it("returns LIQUIDATION_ESTIMATE_UNAVAILABLE and marks nothing safe when estimation fails", () => {
    // Brackets with an unusable maintenance ratio: bracket resolves for
    // sizing but every liquidation estimate fails.
    const plan = calculateDynamicLeveragePlan(
      input({
        brackets: [
          { bracket: 1, initialLeverage: 20, notionalFloor: "0", notionalCap: "50000", maintMarginRatio: "1", cum: "0" },
        ],
      })
    );
    // MMR = 1 makes the LONG denominator zero -> degenerate, fails closed.
    expect(plan.status).toBe("LIQUIDATION_ESTIMATE_UNAVAILABLE");
    expect(plan.reason).toBe("LIQUIDATION_ESTIMATE_UNAVAILABLE");
    expect(plan.selectedLeverage).toBeNull();
    expect(plan.candidates.every((candidate) => !candidate.eligible)).toBe(true);
  });
});

describe("liquidation safety guard", () => {
  it("computes the LONG required boundary as SL − stopDistance × ratio", () => {
    // Entry 100, SL 96, distance 4, ratio 0.5 -> boundary 94.
    const plan = calculateDynamicLeveragePlan(input());
    expect(plan.requiredLiquidationBoundary).toBe("94");
    expect(plan.safetyBufferDistance).toBe("2");
  });

  it("computes the SHORT required boundary as SL + stopDistance × ratio", () => {
    // Entry 100, SL 104, distance 4, ratio 0.5 -> boundary 106.
    const plan = calculateDynamicLeveragePlan(input({ direction: "SHORT", stopLoss: "104" }));
    expect(plan.requiredLiquidationBoundary).toBe("106");
  });

  it("passes only candidates on the safe side of the boundary", () => {
    const plan = calculateDynamicLeveragePlan(input());
    const boundary = Number(plan.requiredLiquidationBoundary);

    for (const candidate of plan.candidates) {
      if (!candidate.eligible || candidate.estimatedLiquidationPrice === null) continue;
      expect(Number(candidate.estimatedLiquidationPrice)).toBeLessThanOrEqual(boundary);
    }
    // The selected one is safe by construction.
    expect(Number(plan.estimatedLiquidationPrice)).toBeLessThanOrEqual(boundary);
  });

  it("rejects candidates whose liquidation sits inside the unsafe zone", () => {
    const plan = calculateDynamicLeveragePlan(input());
    const unsafe = plan.candidates.filter(
      (candidate) => candidate.rejectionReason === "estimated liquidation price is inside the required safety buffer"
    );
    // High leverage must produce liquidation too close to entry.
    expect(unsafe.length).toBeGreaterThan(0);
    for (const candidate of unsafe) expect(candidate.eligible).toBe(false);
  });

  it("treats the exact boundary as safe (inclusive comparison)", () => {
    const plan = calculateDynamicLeveragePlan(input({ liquidationBufferRatio: "0" }));
    // With ratio 0 the boundary is the stop loss itself.
    expect(plan.requiredLiquidationBoundary).toBe("96");
    if (plan.status === "READY") {
      expect(Number(plan.estimatedLiquidationPrice)).toBeLessThanOrEqual(96);
    }
  });
});

// ---------------------------------------------------------------------------
// Purity and safety boundary
// ---------------------------------------------------------------------------

describe("engine purity and safety", () => {
  const enginePath = path.join(process.cwd(), "..", "..", "packages", "shared", "src", "binance-margin-engine.ts");
  const source = readFileSync(enginePath, "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

  it("performs no float conversion on authoritative decimal values", () => {
    expect(code).not.toContain("parseFloat(");
    expect(code).not.toContain("Number.parseFloat(");
    // Number() is only allowed for integer guards, never on decimals.
    expect(code).not.toMatch(/[^.\w]Number\((?!\.isInteger)/);
  });

  it("is pure: no fetch, env, logging, Prisma or persistence", () => {
    for (const forbidden of ["fetch(", "process.env", "console.", "prisma", "@prisma/client", "logger"]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("exposes no trading or account-mutating capability", () => {
    for (const forbidden of [
      "placeOrder", "cancelOrder", "changeLeverage", "setLeverage", "changeMarginType",
      "changePositionMode", "/fapi/v1/order", "/fapi/v1/leverage", "/fapi/v1/marginType",
      "POST", "PUT", "PATCH", "DELETE",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("keeps the Phase 2 read-only allowlist untouched", async () => {
    const { allowedReadOnlyPaths } = await import("../src/modules/binance/binance.endpoints");
    expect(allowedReadOnlyPaths()).toEqual([
      "/fapi/v1/accountConfig",
      "/fapi/v1/algoOrder",
      "/fapi/v1/exchangeInfo",
      "/fapi/v1/leverageBracket",
      "/fapi/v1/multiAssetsMargin",
      "/fapi/v1/openOrders",
      "/fapi/v1/order",
      "/fapi/v1/ping",
      "/fapi/v1/positionMargin/history",
      "/fapi/v1/positionSide/dual",
      "/fapi/v1/symbolConfig",
      "/fapi/v1/time",
      "/fapi/v3/account",
      "/fapi/v3/balance",
      "/fapi/v3/positionRisk",
    ]);
  });

  it("Phase 3 backend modules never mutate Binance, Prisma or the alert pipeline", () => {
    const dir = path.join(process.cwd(), "src", "modules", "binance");
    for (const file of [
      "binance-margin-plan.service.ts",
      "run-margin-plan.ts",
      "run-liquidation-validation.ts",
    ]) {
      const moduleSource = readFileSync(path.join(dir, file), "utf8");
      const moduleCode = moduleSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
      for (const forbidden of [
        "placeOrder", "cancelOrder", "changeLeverage", "changeMarginType", "changePositionMode",
        "prisma", "@prisma/client", "extremeRRPlan", "selectedLeverage =", "sendTelegram",
        "notifyExtremeRR", "enqueue", "visionAnalysisQueue",
      ]) {
        expect(moduleCode, `${file} contains ${forbidden}`).not.toContain(forbidden);
      }
      expect(moduleCode).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)["']/);
    }
  });

  it("defaults match the locked policy", () => {
    expect(MARGIN_ENGINE_DEFAULTS).toEqual({
      targetMarginMultiplier: "2.5",
      maximumMarginMultiplier: "3.333333",
      liquidationBufferRatio: "0.5",
      userMaximumAutomationLeverage: 25,
    });
  });
});
