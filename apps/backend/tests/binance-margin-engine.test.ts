import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXTREME_RR_PREFERRED_MARGIN_MAX,
  EXTREME_RR_PREFERRED_MARGIN_MIN,
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
// Minimum isolated-margin floor
// ---------------------------------------------------------------------------

/**
 * The floor exists because a two-dollar isolated margin sits close to
 * liquidation and is dominated by fees, however correct its risk sizing is.
 *
 * Two properties matter more than the arithmetic and are pinned throughout:
 *
 *  1. The floor is OFF by default, and turning the mechanism on by merely
 *     adding the code would silently re-price every live plan. Every fixture
 *     below therefore also asserts what the SAME input does with no floor.
 *  2. The floor is satisfied by changing LEVERAGE only. Quantity, notional and
 *     planned risk are decided before any leverage is considered and must come
 *     out byte-identical with and without a floor — inflating size to reach a
 *     margin target would breach the risk budget, which is the one thing this
 *     engine exists to protect.
 *
 * Candidate margins are notional / integer leverage, never a hand-written
 * list, so every fixture is a plan the production engine can actually produce.
 */
describe("minimum isolated-margin floor", () => {
  /** Integer quantities, so notional is exactly the entry price. */
  const WHOLE_LOTS: MarginPlanSymbolFilters = { ...FILTERS, stepSize: "1", minQty: "1", minNotional: "5" };

  /**
   * Notional 11.4 -> margins 11.4 / 5.70 / 3.80 / 2.85 …
   * Ceiling 6 (1.50 × 4) excludes 1x; target stays the default 3.75.
   */
  const SCENARIO_A: Partial<DynamicLeveragePlanInput> = {
    entryPrice: "11.4",
    stopLoss: "9.9",
    maximumMarginMultiplier: "4",
    liquidationBufferRatio: "0",
    filters: WHOLE_LOTS,
  };

  /** Notional 24 -> margins 24 / 12 / 8 / 6 / 4.80 / 4 …, ceiling 9 (1.50 × 6). */
  const SCENARIO_B: Partial<DynamicLeveragePlanInput> = {
    entryPrice: "24",
    stopLoss: "22.5",
    maximumMarginMultiplier: "6",
    liquidationBufferRatio: "0",
    filters: WHOLE_LOTS,
  };

  /** Notional 14.8 -> margins 14.8 / 7.40 / 4.93 / 3.70 …, ceiling 9. */
  const SCENARIO_C: Partial<DynamicLeveragePlanInput> = {
    entryPrice: "14.8",
    stopLoss: "13.3",
    maximumMarginMultiplier: "6",
    liquidationBufferRatio: "0",
    filters: WHOLE_LOTS,
  };

  const marginAt = (plan: ReturnType<typeof calculateDynamicLeveragePlan>, leverage: number) =>
    plan.candidates.find((candidate) => candidate.leverage === leverage)?.estimatedInitialMargin;

  // --- Default is OFF ------------------------------------------------------

  it("is disabled by default, leaving closest-to-target selection untouched", () => {
    const plan = calculateDynamicLeveragePlan(input({ stopLoss: "98" }));
    expect(plan.minimumMarginUsd).toBe("0");
    expect(plan.minimumIsolatedMargin).toBeNull();
    expect(plan.marginSelectionMode).toBe("CLOSEST_TO_TARGET");
    // The long-standing exact-target case still resolves the same way.
    expect(plan.selectedLeverage).toBe(20);
    expect(plan.estimatedInitialMargin).toBe("3.75");
  });

  it("treats an explicit 0 as identical to omitting the floor entirely", () => {
    // Zero is 'disabled', NOT 'a floor of zero': a floor of zero would still
    // flip the selector to smallest-margin and quietly change every plan.
    for (const scenario of [SCENARIO_A, SCENARIO_B, SCENARIO_C, {}]) {
      const omitted = calculateDynamicLeveragePlan(input(scenario));
      const explicitZero = calculateDynamicLeveragePlan(input({ ...scenario, minimumMarginUsd: "0" }));
      expect(explicitZero).toEqual(omitted);
      expect(explicitZero.marginSelectionMode).toBe("CLOSEST_TO_TARGET");
    }
  });

  // --- The three operator scenarios ---------------------------------------

  it("A: 3.80 vs 5.70 — no floor takes 3.80, a 5.5 floor takes 5.70", () => {
    const withoutFloor = calculateDynamicLeveragePlan(input(SCENARIO_A));
    expect(withoutFloor.positionNotional).toBe("11.4");
    expect(marginAt(withoutFloor, 2)).toBe("5.7");
    expect(marginAt(withoutFloor, 3)).toBe("3.8");
    // 3.80 is 0.05 from the 3.75 target; 5.70 is 1.95 away.
    expect(withoutFloor.selectedLeverage).toBe(3);
    expect(withoutFloor.estimatedInitialMargin).toBe("3.8");

    const withFloor = calculateDynamicLeveragePlan(input({ ...SCENARIO_A, minimumMarginUsd: "5.5" }));
    expect(withFloor.status).toBe("READY");
    expect(withFloor.marginSelectionMode).toBe("SMALLEST_ABOVE_FLOOR");
    expect(withFloor.minimumIsolatedMargin).toBe("5.5");
    expect(withFloor.selectedLeverage).toBe(2);
    expect(withFloor.estimatedInitialMargin).toBe("5.7");
  });

  it("B: 4 / 6 / 8 — no floor takes 4, a 5.5 floor takes 6", () => {
    const withoutFloor = calculateDynamicLeveragePlan(input(SCENARIO_B));
    expect(withoutFloor.positionNotional).toBe("24");
    expect(marginAt(withoutFloor, 3)).toBe("8");
    expect(marginAt(withoutFloor, 4)).toBe("6");
    expect(marginAt(withoutFloor, 6)).toBe("4");
    expect(withoutFloor.estimatedInitialMargin).toBe("4");

    const withFloor = calculateDynamicLeveragePlan(input({ ...SCENARIO_B, minimumMarginUsd: "5.5" }));
    // 6 is the SMALLEST at or above 5.5 — not 8, which is closer to nothing
    // in particular, and not 4.80, which is below the floor.
    expect(withFloor.selectedLeverage).toBe(4);
    expect(withFloor.estimatedInitialMargin).toBe("6");
  });

  it("C: only the largest candidate clears the floor, so it is chosen", () => {
    const withoutFloor = calculateDynamicLeveragePlan(input(SCENARIO_C));
    expect(withoutFloor.positionNotional).toBe("14.8");
    expect(marginAt(withoutFloor, 2)).toBe("7.4");
    expect(withoutFloor.estimatedInitialMargin).toBe("3.7");

    const withFloor = calculateDynamicLeveragePlan(input({ ...SCENARIO_C, minimumMarginUsd: "5.5" }));
    // 3x is 4.93… — below the floor — so 2x/7.40 is the smallest survivor.
    expect(marginAt(withFloor, 3)!.startsWith("4.93")).toBe(true);
    expect(withFloor.selectedLeverage).toBe(2);
    expect(withFloor.estimatedInitialMargin).toBe("7.4");
  });

  // --- Fail-closed diagnosis, kept distinct -------------------------------

  it("reports NO_LEVERAGE_MEETS_MARGIN_FLOOR when every candidate is below the floor", () => {
    // Ceiling 15 (1.50 × 10) admits every candidate; a floor of 12 sits above
    // even the 1x margin of 11.4, so the band is empty from below only.
    const plan = calculateDynamicLeveragePlan(
      input({ ...SCENARIO_A, maximumMarginMultiplier: "10", minimumMarginUsd: "12" })
    );
    expect(plan.status).toBe("SKIPPED");
    expect(plan.reason).toBe("NO_LEVERAGE_MEETS_MARGIN_FLOOR");
    expect(plan.selectedLeverage).toBeNull();
    expect(plan.candidates.every((candidate) => !candidate.eligible)).toBe(true);
    // Never confused with the ceiling case.
    expect(plan.reason).not.toBe("REQUIRED_MARGIN_EXCEEDS_MAXIMUM");
  });

  it("still reports NO_LEVERAGE_MEETS_MARGIN_FLOOR when the band is empty from both ends", () => {
    // 1x/2x exceed the 9 ceiling and 3x downward fall under an 8.5 floor:
    // candidates exist on both sides but none inside the band.
    const plan = calculateDynamicLeveragePlan(input({ ...SCENARIO_B, minimumMarginUsd: "8.5" }));
    expect(plan.status).toBe("SKIPPED");
    expect(plan.reason).toBe("NO_LEVERAGE_MEETS_MARGIN_FLOOR");
  });

  it("keeps REQUIRED_MARGIN_EXCEEDS_MAXIMUM for the ceiling-only case", () => {
    // Same fixture the ceiling test uses, now with a floor configured: the
    // diagnosis must still name the ceiling, not the floor.
    const plan = calculateDynamicLeveragePlan(
      input({
        entryPrice: "100",
        stopLoss: "99.99",
        filters: { ...FILTERS, stepSize: "1", minQty: "1", minNotional: "5" },
        minimumMarginUsd: "4",
      })
    );
    expect(plan.status).toBe("SKIPPED");
    expect(plan.reason).toBe("REQUIRED_MARGIN_EXCEEDS_MAXIMUM");
  });

  it("fails closed when the floor cannot fit under the maximum", () => {
    // 10 > 1.50 × 4; no margin could ever satisfy both bounds.
    const impossible = calculateDynamicLeveragePlan(input({ ...SCENARIO_A, minimumMarginUsd: "10" }));
    expect(impossible.status).toBe("INVALID");
    expect(impossible.reason).toBe("MARGIN_FLOOR_EXCEEDS_MAXIMUM");
    expect(impossible.selectedLeverage).toBeNull();
    // Rejected before any sizing work, so nothing downstream can read a
    // half-built plan as if it were merely unlucky.
    expect(impossible.roundedQuantity).toBeNull();
    expect(impossible.positionNotional).toBeNull();

    // Exactly equal to the maximum is allowed, mirroring maximum >= target.
    const exact = calculateDynamicLeveragePlan(input({ ...SCENARIO_A, minimumMarginUsd: "6" }));
    expect(exact.reason).not.toBe("MARGIN_FLOOR_EXCEEDS_MAXIMUM");
  });

  it("rejects a negative or malformed floor rather than defaulting it away", () => {
    for (const raw of ["-1", "-0.01", "abc", "NaN"]) {
      const plan = calculateDynamicLeveragePlan(input({ ...SCENARIO_A, minimumMarginUsd: raw }));
      expect(plan.status, raw).toBe("INVALID");
      expect(plan.reason, raw).toBe("INVALID_MULTIPLIERS");
      expect(plan.reasonMessage, raw).toMatch(/[Mm]inimum isolated margin/);
    }
  });

  // --- Liquidation safety stays authoritative ------------------------------

  it("skips a floor-eligible candidate that is not liquidation-safe and takes the next one up", () => {
    // Buffer ratio 4 -> boundary 16.5. The smallest candidate above the 5.5
    // floor is 6 at 4x, whose liquidation (18.18) is inside the buffer; 8 at
    // 3x (liquidation 16.16) is safe. Safety wins over "smallest".
    const plan = calculateDynamicLeveragePlan(
      input({ ...SCENARIO_B, liquidationBufferRatio: "4", minimumMarginUsd: "5.5" })
    );
    expect(plan.requiredLiquidationBoundary).toBe("16.5");

    const fourX = plan.candidates.find((candidate) => candidate.leverage === 4)!;
    expect(fourX.estimatedInitialMargin).toBe("6");
    expect(fourX.eligible).toBe(false);
    expect(fourX.rejectionReason).toBe("estimated liquidation price is inside the required safety buffer");

    expect(plan.status).toBe("READY");
    expect(plan.selectedLeverage).toBe(3);
    expect(plan.estimatedInitialMargin).toBe("8");
  });

  it("reports the LIQUIDATION reason, not the floor reason, when no safe candidate clears the floor", () => {
    // Buffer ratio 5 -> boundary 15: both floor-eligible candidates (8 and 6)
    // reach the liquidation test and fail it. A configured floor must never
    // disguise a liquidation problem as a margin-band problem.
    const plan = calculateDynamicLeveragePlan(
      input({ ...SCENARIO_B, liquidationBufferRatio: "5", minimumMarginUsd: "5.5" })
    );
    expect(plan.status).toBe("SKIPPED");
    expect(plan.reason).toBe("NO_LIQUIDATION_SAFE_LEVERAGE");
    expect(plan.reason).not.toBe("NO_LEVERAGE_MEETS_MARGIN_FLOOR");
  });

  // --- The invariant this whole branch is built around ---------------------

  it("NEVER changes quantity, notional or planned risk when the floor is enabled", () => {
    const sizing = (plan: ReturnType<typeof calculateDynamicLeveragePlan>) => ({
      quantityRaw: plan.quantityRaw,
      roundedQuantity: plan.roundedQuantity,
      positionNotional: plan.positionNotional,
      actualPlannedLoss: plan.actualPlannedLoss,
      unusedRiskBudget: plan.unusedRiskBudget,
      riskBudgetUsd: plan.riskBudgetUsd,
      stopDistance: plan.stopDistance,
      stopLoss: plan.stopLoss,
      executableStopLoss: plan.executableStopLoss,
    });

    for (const scenario of [SCENARIO_A, SCENARIO_B, SCENARIO_C]) {
      const withoutFloor = calculateDynamicLeveragePlan(input(scenario));
      const withFloor = calculateDynamicLeveragePlan(input({ ...scenario, minimumMarginUsd: "5.5" }));

      expect(withFloor.status).toBe("READY");
      expect(sizing(withFloor)).toEqual(sizing(withoutFloor));
      // The floor did its job — margin went UP — and the ONLY reason is that a
      // different leverage was chosen for the same position.
      expect(withFloor.selectedLeverage).not.toBe(withoutFloor.selectedLeverage);
      expect(Number(withFloor.estimatedInitialMargin)).toBeGreaterThan(Number(withoutFloor.estimatedInitialMargin));
      expect(withFloor.positionNotional).toBe(withoutFloor.positionNotional);
      // notional / leverage, with notional untouched.
      expect(withFloor.estimatedInitialMargin).toBe(
        marginAt(withFloor, withFloor.selectedLeverage as number)
      );
    }
  });

  it("fails closed rather than resizing when the floor is unreachable", () => {
    // The BELOW_MIN_NOTIONAL rule already refuses to grow quantity for the
    // exchange minimum; the floor must behave the same way. Quantity here is
    // whatever the risk budget bought — never more.
    const plan = calculateDynamicLeveragePlan(
      input({ ...SCENARIO_A, maximumMarginMultiplier: "10", minimumMarginUsd: "12" })
    );
    const unfloored = calculateDynamicLeveragePlan(input({ ...SCENARIO_A, maximumMarginMultiplier: "10" }));
    expect(plan.reason).toBe("NO_LEVERAGE_MEETS_MARGIN_FLOOR");
    expect(plan.roundedQuantity).toBe(unfloored.roundedQuantity);
    expect(plan.positionNotional).toBe(unfloored.positionNotional);
  });
});

// ---------------------------------------------------------------------------
// Floor configuration: one source, two files
// ---------------------------------------------------------------------------

describe("minimum-margin floor configuration", () => {
  const BACKEND = process.cwd();
  const read = (relative: string) => readFileSync(path.join(BACKEND, relative), "utf8");

  it("keeps the CODE default disabled, so adding the mechanism changed nothing", () => {
    // config/env deliberately does not import the shared package, so the "0"
    // literal there is pinned to the engine default here instead. This is the
    // fallback for an installation that never sets the variable, and it must
    // stay 0 even though .env.example now recommends a live floor.
    expect(MARGIN_ENGINE_DEFAULTS.minimumMarginUsd).toBe("0");
    expect(read("src/config/env.ts")).toContain('BINANCE_MIN_MARGIN_USD: nonNegativeDecimalString.default("0")');
    expect(read("src/config/env.ts")).toContain('BINANCE_TARGET_MARGIN_MULTIPLIER: positiveDecimalString.default("2.5")');
    expect(read("src/config/env.ts")).toContain('BINANCE_MAX_MARGIN_MULTIPLIER: positiveDecimalString.default("3.333333")');
  });

  it("passes the configured floor through the plan service to the engine", () => {
    const service = read("src/modules/binance/binance-margin-plan.service.ts");
    expect(service).toContain("minimumMarginUsd: request.minimumMarginUsd ?? env.BINANCE_MIN_MARGIN_USD");
  });
});

// ---------------------------------------------------------------------------
// The intended single-trade margin policy, read from the shipped example
// ---------------------------------------------------------------------------

/**
 * The recommended policy lives in `.env.example`, not in a constant, because a
 * third declaration of the same numbers is exactly how the STOP/TP working
 * types drifted apart. These tests therefore READ the shipped example and feed
 * its literal values to the engine: if someone edits the file, the engine
 * behaviour asserted here is what they get, or the suite fails.
 *
 * The code defaults stay conservative (previous describe). This is the
 * `EXECUTION_ENTRY_TTL_SECONDS` split: fallback in the schema, recommendation
 * in the example.
 */
describe("intended single-trade margin policy", () => {
  const BACKEND = process.cwd();
  const EXAMPLES = [path.join(BACKEND, ".env.example"), path.join(BACKEND, "..", "..", ".env.example")];

  /** Reads one KEY=VALUE out of an example file, ignoring comments. */
  const setting = (source: string, key: string): string => {
    const match = source.match(new RegExp(`^${key}=(.*)$`, "m"));
    if (!match) throw new Error(`${key} is missing from .env.example`);
    return match[1].trim();
  };

  const backendExample = readFileSync(EXAMPLES[0], "utf8");
  const POLICY = {
    riskBudgetUsd: setting(backendExample, "EXECUTION_MAX_TOTAL_PLANNED_RISK_USD"),
    minimumMarginUsd: setting(backendExample, "BINANCE_MIN_MARGIN_USD"),
    targetMarginMultiplier: setting(backendExample, "BINANCE_TARGET_MARGIN_MULTIPLIER"),
    maximumMarginMultiplier: setting(backendExample, "BINANCE_MAX_MARGIN_MULTIPLIER"),
  };

  const WHOLE_LOTS: MarginPlanSymbolFilters = { ...FILTERS, stepSize: "1", minQty: "1", minNotional: "5" };

  /** One plan under the shipped policy; only entry/stop vary. */
  const planFor = (entryPrice: string, stopLoss: string, overrides: Partial<DynamicLeveragePlanInput> = {}) =>
    calculateDynamicLeveragePlan(
      input({ ...POLICY, entryPrice, stopLoss, filters: WHOLE_LOTS, liquidationBufferRatio: "0", ...overrides })
    );

  const marginAt = (plan: ReturnType<typeof calculateDynamicLeveragePlan>, leverage: number) =>
    plan.candidates.find((candidate) => candidate.leverage === leverage)!;

  // --- The numbers themselves ---------------------------------------------

  it("ships the same recommended policy in BOTH example files", () => {
    const [backend, root] = EXAMPLES.map((file) => readFileSync(file, "utf8"));
    for (const key of [
      "BINANCE_MIN_MARGIN_USD",
      "BINANCE_TARGET_MARGIN_MULTIPLIER",
      "BINANCE_MAX_MARGIN_MULTIPLIER",
      "EXECUTION_MAX_TOTAL_PLANNED_RISK_USD",
      "EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD",
      "EXECUTION_MAX_TOTAL_ACTIVE_TRADES",
    ]) {
      expect(setting(root, key), key).toBe(setting(backend, key));
    }
  });

  it("recommends risk 1.50, floor 5.50, target ×4 and maximum ×5.333333", () => {
    expect(POLICY.riskBudgetUsd).toBe("1.50");
    expect(POLICY.minimumMarginUsd).toBe("5.50");
    expect(POLICY.targetMarginMultiplier).toBe("4");
    expect(POLICY.maximumMarginMultiplier).toBe("5.333333");
  });

  it("derives the intended envelope: floor 5.50 <= target 6.00 <= maximum ~8.00", () => {
    const plan = planFor("11.4", "9.9");
    expect(plan.minimumIsolatedMargin).toBe("5.5");
    expect(plan.targetIsolatedMargin).toBe("6"); // 1.50 × 4
    // 1.50 × 5.333333 — TRUNCATED, so the per-plan ceiling lands just UNDER
    // the 8.00 aggregate cap rather than just over it.
    expect(plan.maximumIsolatedMargin).toBe("7.9999995");
    expect(plan.marginSelectionMode).toBe("SMALLEST_ABOVE_FLOOR");

    expect(compareDecimalStrings(plan.minimumIsolatedMargin as string, plan.targetIsolatedMargin as string)).toBe(-1);
    expect(compareDecimalStrings(plan.targetIsolatedMargin as string, plan.maximumIsolatedMargin as string)).toBe(-1);
  });

  it("keeps the per-plan ceiling at or below the aggregate admission cap", () => {
    // Admission reserves maximumIsolatedMargin, so a per-plan ceiling above the
    // aggregate cap would make every plan un-admittable. This is the invariant
    // that binds the two files together.
    const perPlanCeiling = planFor("11.4", "9.9").maximumIsolatedMargin as string;
    const aggregateCap = setting(backendExample, "EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD");
    expect(aggregateCap).toBe("8.00");
    expect(compareDecimalStrings(perPlanCeiling, aggregateCap)).toBeLessThanOrEqual(0);
  });

  it("leaves the planned-risk cap and the one-trade capacity untouched", () => {
    for (const source of EXAMPLES.map((file) => readFileSync(file, "utf8"))) {
      expect(setting(source, "EXECUTION_MAX_TOTAL_PLANNED_RISK_USD")).toBe("1.50");
      expect(setting(source, "EXECUTION_MAX_TOTAL_ACTIVE_TRADES")).toBe("1");
      expect(setting(source, "EXECUTION_MAX_OPEN_POSITIONS")).toBe("1");
      expect(setting(source, "EXECUTION_MAX_PENDING_ENTRIES")).toBe("1");
      expect(setting(source, "EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE")).toBe("1");
    }
  });

  // --- The three operator scenarios, under the REAL recommended values ------

  it("A: notional 11.4 — candidates 11.40 / 5.70 / 3.80 → 5.70", () => {
    const plan = planFor("11.4", "9.9");
    expect(plan.positionNotional).toBe("11.4");
    expect(marginAt(plan, 1).rejectionReason).toBe("estimated margin exceeds the maximum isolated margin");
    expect(marginAt(plan, 3).rejectionReason).toBe("estimated margin is below the minimum isolated margin");
    expect(plan.status).toBe("READY");
    expect(plan.selectedLeverage).toBe(2);
    expect(plan.estimatedInitialMargin).toBe("5.7");
  });

  it("B: notional 24 — candidates 8 / 6 / 4.80 → 6", () => {
    const plan = planFor("24", "22.5");
    expect(plan.positionNotional).toBe("24");
    expect(marginAt(plan, 4).estimatedInitialMargin).toBe("6");
    expect(marginAt(plan, 5).estimatedInitialMargin).toBe("4.8");
    // Worth pinning: a candidate at EXACTLY 8 sits above the truncated ceiling
    // 7.9999995 and is excluded. The answer is 6 either way, but the boundary
    // is deliberate and should fail loudly if the multiplier is ever rounded up.
    expect(marginAt(plan, 3).estimatedInitialMargin).toBe("8");
    expect(marginAt(plan, 3).rejectionReason).toBe("estimated margin exceeds the maximum isolated margin");
    expect(plan.status).toBe("READY");
    expect(plan.selectedLeverage).toBe(4);
    expect(plan.estimatedInitialMargin).toBe("6");
  });

  it("C: notional 14.8 — only 7.40 clears the floor → 7.40", () => {
    const plan = planFor("14.8", "13.3");
    expect(plan.positionNotional).toBe("14.8");
    expect(marginAt(plan, 3).rejectionReason).toBe("estimated margin is below the minimum isolated margin");
    expect(plan.status).toBe("READY");
    expect(plan.selectedLeverage).toBe(2);
    expect(plan.estimatedInitialMargin).toBe("7.4");
  });

  // --- Liquidation safety is still the authority ---------------------------

  it("takes the next-smallest candidate when the smallest above the floor is unsafe", () => {
    // Notional 45 puts THREE candidates in the band: 7.50 (6x), 6.43 (7x) and
    // 5.625 (8x). With no buffer the smallest wins; with a buffer that makes
    // only 5.625 unsafe, the next-smallest wins instead.
    const relaxed = planFor("45", "43.5");
    expect(relaxed.selectedLeverage).toBe(8);
    expect(relaxed.estimatedInitialMargin).toBe("5.625");

    const buffered = planFor("45", "43.5", { liquidationBufferRatio: "2.5" });
    expect(marginAt(buffered, 8).rejectionReason).toBe(
      "estimated liquidation price is inside the required safety buffer"
    );
    expect(buffered.status).toBe("READY");
    expect(buffered.selectedLeverage).toBe(7);
  });

  it("fails closed with the LIQUIDATION reason when nothing clears both", () => {
    const plan = planFor("24", "22.5", { liquidationBufferRatio: "4" });
    expect(plan.status).toBe("SKIPPED");
    expect(plan.reason).toBe("NO_LIQUIDATION_SAFE_LEVERAGE");
    expect(plan.selectedLeverage).toBeNull();
  });

  // --- The dashboard band is a DIFFERENT model -----------------------------

  it("never lets the Extreme RR dashboard band reach execution", () => {
    // The dashboard prefers 6–10 USD; execution now recommends 5.50–8.00. They
    // disagree, and that is fine ONLY because the dashboard constants are
    // presentational — no exchange filters, no brackets, no liquidation. What
    // must never happen is one silently becoming the other, so assert the
    // execution path does not reference them at all.
    expect(EXTREME_RR_PREFERRED_MARGIN_MIN).toBe("6");
    expect(EXTREME_RR_PREFERRED_MARGIN_MAX).toBe("10");
    for (const file of [
      path.join(BACKEND, "..", "..", "packages", "shared", "src", "binance-margin-engine.ts"),
      path.join(BACKEND, "src", "modules", "binance", "binance-margin-plan.service.ts"),
      path.join(BACKEND, "src", "modules", "execution", "selected-plan-executor.ts"),
      path.join(BACKEND, "src", "modules", "execution", "safety-engine.ts"),
    ]) {
      expect(readFileSync(file, "utf8"), file).not.toContain("EXTREME_RR_PREFERRED_MARGIN");
    }
  });

  // --- Sizing is untouched by the whole policy ------------------------------

  it("produces IDENTICAL quantity, notional and risk sizing to the old policy", () => {
    const sizing = (plan: ReturnType<typeof calculateDynamicLeveragePlan>) => ({
      quantityRaw: plan.quantityRaw,
      roundedQuantity: plan.roundedQuantity,
      positionNotional: plan.positionNotional,
      actualPlannedLoss: plan.actualPlannedLoss,
      unusedRiskBudget: plan.unusedRiskBudget,
      riskBudgetUsd: plan.riskBudgetUsd,
      stopDistance: plan.stopDistance,
    });

    for (const [entry, stop] of [["11.4", "9.9"], ["24", "22.5"], ["14.8", "13.3"], ["45", "43.5"]]) {
      const intended = planFor(entry, stop);
      // The previous policy: no floor, old multipliers, same risk budget.
      const legacy = calculateDynamicLeveragePlan(
        input({
          entryPrice: entry,
          stopLoss: stop,
          riskBudgetUsd: POLICY.riskBudgetUsd,
          filters: WHOLE_LOTS,
          liquidationBufferRatio: "0",
        })
      );
      expect(sizing(intended), `${entry}/${stop}`).toEqual(sizing(legacy));
    }
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
      // Historical order and fill readers. Signed GETs, added so a stuck entry
      // can PROVE it never reached the exchange instead of being retried
      // forever — the allowlist stays provably read-only.
      "/fapi/v1/allOrders",
      "/fapi/v1/exchangeInfo",
      "/fapi/v1/leverageBracket",
      "/fapi/v1/multiAssetsMargin",
      "/fapi/v1/openAlgoOrders",
      "/fapi/v1/openOrders",
      "/fapi/v1/order",
      "/fapi/v1/ping",
      "/fapi/v1/positionMargin/history",
      "/fapi/v1/positionSide/dual",
      // Phase 20B: mark price. Public, unsigned and GET-only, so the
      // allowlist stays provably read-only.
      "/fapi/v1/premiumIndex",
      "/fapi/v1/symbolConfig",
      "/fapi/v1/time",
      "/fapi/v1/userTrades",
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
        "extremeRRPlan", "selectedLeverage =", "sendTelegram",
        "notifyExtremeRR", "enqueue", "visionAnalysisQueue",
      ]) {
        expect(moduleCode, `${file} contains ${forbidden}`).not.toContain(forbidden);
      }

      // Phase 11D: the two CLIs now open a SHORT-LIVED Prisma client, solely to
      // bind the configured exchange runtime -- the proof of which account a
      // signed margin read is made as. The planner service itself still touches
      // no database at all, and neither CLI may name an execution model or
      // reach the worker's shared pool.
      if (file === "binance-margin-plan.service.ts") {
        expect(moduleCode, `${file} contains prisma`).not.toContain("prisma");
      } else {
        expect(moduleCode).not.toContain("plugins/prisma");
        for (const model of ["tradeExecution", "executionEvent", "binanceOrder"]) {
          expect(moduleCode, `${file} names ${model}`).not.toContain(model);
        }
      }
      expect(moduleCode).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)["']/);
    }
  });

  it("defaults match the locked policy", () => {
    expect(MARGIN_ENGINE_DEFAULTS).toEqual({
      targetMarginMultiplier: "2.5",
      maximumMarginMultiplier: "3.333333",
      liquidationBufferRatio: "0.5",
      // "0" = the isolated-margin floor is OFF. Changing this default would
      // re-price every existing installation on deploy.
      minimumMarginUsd: "0",
      userMaximumAutomationLeverage: 25,
    });
  });
});
