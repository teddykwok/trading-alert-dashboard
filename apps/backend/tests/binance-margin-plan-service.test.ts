import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarginPlanInput } from "@trading-alert-dashboard/shared";

/**
 * Phase 3 planning boundary — snapshot-aware planning.
 *
 * The execution path must freeze the exact filters that produced an execution's
 * numbers. A second `inspectSymbol` would not do: between two inspections a
 * tick size or minimum notional can change, and the persisted snapshot would
 * then describe a calculation that never happened.
 *
 * These tests assert OBJECT IDENTITY between the filters handed to the pure
 * calculator and the filters handed back to the caller, which is the strongest
 * available statement of "the same inspection".
 *
 * The read-only connector is a stub; no Binance transport is constructed.
 */

let capturedInput: MarginPlanInput | null = null;

vi.mock("@trading-alert-dashboard/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@trading-alert-dashboard/shared")>();
  return {
    ...actual,
    calculateDynamicLeveragePlan: (input: MarginPlanInput) => {
      capturedInput = input;
      return actual.calculateDynamicLeveragePlan(input);
    },
  };
});

const { BinanceMarginPlanService } = await import("../src/modules/binance/binance-margin-plan.service");

/** A full exchangeInfo-shaped filter row, including fields the plan ignores. */
const SYMBOL_FILTERS = {
  symbol: "DOGSUSDT",
  status: "TRADING",
  contractType: "PERPETUAL",
  tickSize: "0.0000010",
  minPrice: "0.0000010",
  maxPrice: "2000",
  stepSize: "1",
  minQty: "1",
  maxQty: "10000000",
  // Present on the DTO, deliberately NOT part of the frozen snapshot.
  marketStepSize: "1",
  marketMinQty: "1",
  marketMaxQty: "500000",
  minNotional: "5",
  orderTypes: ["LIMIT", "MARKET", "STOP_MARKET"],
  timeInForce: ["GTC", "IOC", "FOK", "GTX"],
};

let inspections: string[] = [];

function planner(overrides: Partial<typeof SYMBOL_FILTERS> = {}) {
  const readOnly = {
    async inspectSymbol(symbol: string) {
      inspections.push(symbol);
      return {
        filters: { ...SYMBOL_FILTERS, ...overrides },
        brackets: [
          { bracket: 1, initialLeverage: 75, notionalCap: "5000", notionalFloor: "0", maintMarginRatio: "0.01", cum: "0" },
        ],
        maxInitialLeverage: 75,
        accountSymbolConfig: null,
      };
    },
  };
  return new BinanceMarginPlanService(readOnly as never);
}

const REQUEST = {
  symbol: "DOGSUSDT",
  direction: "LONG" as const,
  entryPrice: "0.0001234",
  stopLoss: "0.0001180",
  riskBudgetUsd: "1.50",
};

beforeEach(() => {
  capturedInput = null;
  inspections = [];
});

describe("snapshot-aware margin planning", () => {
  it("inspects the symbol exactly once for one planning operation", async () => {
    await planner().planForSymbolWithSnapshot(REQUEST);
    expect(inspections).toEqual(["DOGSUSDT"]);
  });

  it("returns the plan and the filters that produced it", async () => {
    const result = await planner().planForSymbolWithSnapshot(REQUEST);

    expect(result.plan).toBeDefined();
    expect(result.plan.symbol).toBe("DOGSUSDT");
    expect(result.exchangeFilters).toEqual({
      status: "TRADING",
      contractType: "PERPETUAL",
      tickSize: "0.0000010",
      minPrice: "0.0000010",
      maxPrice: "2000",
      stepSize: "1",
      minQty: "1",
      maxQty: "10000000",
      minNotional: "5",
    });
  });

  it("hands the calculator the very same object it returns", async () => {
    const result = await planner().planForSymbolWithSnapshot(REQUEST);

    expect(capturedInput).not.toBeNull();
    // Identity, not equality: there is one projection, so the snapshot and the
    // calculation can never describe different filters.
    expect(Object.is(capturedInput!.filters, result.exchangeFilters)).toBe(true);
  });

  it("reflects a changed filter in both the calculation and the snapshot", async () => {
    const result = await planner({ stepSize: "10", minQty: "10" }).planForSymbolWithSnapshot(REQUEST);

    expect(result.exchangeFilters.stepSize).toBe("10");
    expect(capturedInput!.filters.stepSize).toBe("10");
    // The plan rounded against that same step size.
    expect(result.plan.quantityStepSize).toBe("10");
  });

  it("persists no raw payload, brackets, account data or unrelated filter fields", async () => {
    const result = await planner().planForSymbolWithSnapshot(REQUEST);
    const keys = Object.keys(result.exchangeFilters).sort();

    expect(keys).toEqual([
      "contractType",
      "maxPrice",
      "maxQty",
      "minNotional",
      "minPrice",
      "minQty",
      "status",
      "stepSize",
      "tickSize",
    ]);
    // Nothing from the account or the raw DTO leaks in.
    for (const forbidden of ["brackets", "accountSymbolConfig", "orderTypes", "timeInForce", "marketStepSize", "symbol"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    expect(JSON.stringify(result.exchangeFilters)).not.toMatch(/apiKey|secret|signature|authorization/i);
  });

  it("keeps planForSymbol's existing contract for callers that only want the plan", async () => {
    const service = planner();
    const plan = await service.planForSymbol(REQUEST);
    const { plan: viaSnapshot } = await service.planForSymbolWithSnapshot(REQUEST);

    // Same shape, same numbers, no extra properties bolted on.
    expect(plan).toEqual(viaSnapshot);
    expect(plan).not.toHaveProperty("exchangeFilters");
    // Still one inspection per call — delegation added no extra round trip.
    expect(inspections).toEqual(["DOGSUSDT", "DOGSUSDT"]);
  });
});
