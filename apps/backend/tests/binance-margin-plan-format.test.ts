import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  calculateDynamicLeveragePlan,
  type MarginPlanLeverageBracket,
  type MarginPlanSymbolFilters,
} from "@trading-alert-dashboard/shared";
import {
  formatDecimal,
  formatMarginPlanLines,
  formatMoney,
  formatPrice,
} from "../src/modules/binance/margin-plan-format";

/**
 * CLI presentation tests. The formatter must never understate or hide a
 * monetary value — a rounded-to-cents display would show the FRAX unused
 * budget (0.0006) as "$0.00" and the maximum margin (4.9999995) as "$5.00".
 */

const FRAX_FILTERS: MarginPlanSymbolFilters = {
  status: "TRADING",
  contractType: "PERPETUAL",
  tickSize: "0.0001",
  minPrice: "0.0001",
  maxPrice: "2000",
  stepSize: "1",
  minQty: "1",
  maxQty: "1000000",
  minNotional: "5",
};

const BRACKETS: MarginPlanLeverageBracket[] = [
  { bracket: 1, initialLeverage: 50, notionalFloor: "0", notionalCap: "50000", maintMarginRatio: "0.01", cum: "0" },
];

/** The live FRAXUSDT case: 0.26563 stop normalizes down to 0.2656. */
function fraxPlan() {
  return calculateDynamicLeveragePlan({
    symbol: "FRAXUSDT",
    direction: "LONG",
    entryPrice: "0.2707",
    stopLoss: "0.26563",
    riskBudgetUsd: "1.50",
    userMaximumAutomationLeverage: 55,
    filters: FRAX_FILTERS,
    brackets: BRACKETS,
  });
}

function lineFor(lines: string[], label: string): string {
  const line = lines.find((candidate) => candidate.trim().startsWith(label));
  if (!line) throw new Error(`No line starting with "${label}" in:\n${lines.join("\n")}`);
  return line.trim();
}

describe("monetary formatting", () => {
  it("never collapses a small non-zero amount to zero", () => {
    expect(formatMoney("0.0006")).toBe("$0.0006");
    expect(formatMoney("0.00000001")).toBe("$0.00000001");
    // Two-decimal rounding would have hidden both of these entirely.
    expect(formatMoney("0.0006")).not.toBe("$0.00");
  });

  it("never understates a value close to a ceiling", () => {
    expect(formatMoney("4.9999995")).toBe("$4.9999995");
    expect(formatMoney("4.9999995")).not.toBe("$5.00");
    expect(formatMoney("1.4994")).toBe("$1.4994");
    expect(formatMoney("1.4994")).not.toBe("$1.49");
  });

  it("keeps the conventional two decimals when the source has them", () => {
    expect(formatMoney("1.50")).toBe("$1.50");
    expect(formatMoney("79.5858")).toBe("$79.5858");
    expect(formatMoney("192")).toBe("$192");
  });

  it("flags truncation of a long repeating value instead of implying exactness", () => {
    const long = "3.789800000000000000000000000000000000001";
    expect(formatMoney(long)).toBe("$3.7898…");
    // Exactly representable values carry no ellipsis.
    expect(formatMoney("3.75")).toBe("$3.75");
  });

  it("handles negatives and nulls", () => {
    expect(formatMoney("-0.0138")).toBe("-$0.0138");
    expect(formatMoney(null)).toBe("—");
    expect(formatPrice(null)).toBe("—");
    expect(formatDecimal("0.26563", 8)).toBe("0.26563");
  });

  it("performs no float conversion", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src", "modules", "binance", "margin-plan-format.ts"),
      "utf8"
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    expect(code).not.toContain("parseFloat(");
    expect(code).not.toContain("parseInt(");
    expect(code).not.toMatch(/[^.\w]Number\(/);
    expect(code).not.toContain("toFixed(");
  });
});

describe("FRAX margin-plan CLI output", () => {
  it("shows every authoritative monetary value truthfully", () => {
    const plan = fraxPlan();
    const lines = formatMarginPlanLines(plan);

    // Sanity: the engine produced the live FRAX numbers.
    expect(plan.actualPlannedLoss).toBe("1.4994");
    expect(plan.unusedRiskBudget).toBe("0.0006");
    expect(plan.positionNotional).toBe("79.5858");
    expect(plan.maximumIsolatedMargin).toBe("4.9999995");

    expect(lineFor(lines, "Actual planned loss:")).toContain("$1.4994");
    expect(lineFor(lines, "Unused risk budget:")).toContain("$0.0006");
    expect(lineFor(lines, "Position notional:")).toContain("$79.5858");
    expect(lineFor(lines, "Target margin:")).toContain("$3.75");
    expect(lineFor(lines, "Maximum margin:")).toContain("$4.9999995");
    expect(lineFor(lines, "Estimated margin:")).toMatch(/\$\d+\.\d{2,}/);
    expect(lineFor(lines, "Margin vs target:")).toMatch(/-?\$\d/);
  });

  it("does not hide or understate any of the previously truncated figures", () => {
    const lines = formatMarginPlanLines(fraxPlan());
    for (const hidden of ["$1.49\n", "$0.00\n", "$79.58\n", "$5.00\n"]) {
      expect(lines.join("\n") + "\n").not.toContain(hidden);
    }
  });

  it("shows the executable stop plus the calculated stop and tick adjustment", () => {
    const lines = formatMarginPlanLines(fraxPlan());

    expect(lineFor(lines, "Stop-loss (executable):")).toContain("0.2656");
    expect(lineFor(lines, "calculated stop:")).toContain("0.26563");
    expect(lineFor(lines, "tick adjustment:")).toContain("-0.00003");
    expect(lineFor(lines, "Stop distance:")).toContain("0.0051");
  });

  it("prints the corrected normalization wording and drops the misleading claim", () => {
    const text = formatMarginPlanLines(fraxPlan()).join("\n");

    expect(text).toContain("Stop moved away from entry to match the exchange tick.");
    expect(text).toContain(
      "Quantity was recalculated downward so planned loss remains within the risk budget."
    );
    expect(text).not.toContain("away from entry, so risk cannot increase");
    expect(text).not.toContain("risk cannot increase");
  });

  it("keeps the read-only framing and claims no order was submitted", () => {
    const text = formatMarginPlanLines(fraxPlan()).join("\n");

    expect(text).toContain("READ ONLY (nothing is sent to Binance)");
    expect(text).toContain("No order was placed and no account setting was changed");
    expect(text).toContain("Decision: READY");
    for (const forbidden of ["order placed", "order submitted", "leverage applied", "leverage set"]) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("renders a SKIPPED plan without inventing values", () => {
    // A 5x cap cannot fit $79.5858 of notional inside the $4.9999995 ceiling
    // (5x needs ~$15.92), so no usable leverage qualifies.
    const skipped = calculateDynamicLeveragePlan({
      symbol: "FRAXUSDT",
      direction: "LONG",
      entryPrice: "0.2707",
      stopLoss: "0.26563",
      riskBudgetUsd: "1.50",
      userMaximumAutomationLeverage: 5,
      filters: FRAX_FILTERS,
      brackets: BRACKETS,
    });
    const text = formatMarginPlanLines(skipped).join("\n");

    expect(skipped.status).toBe("SKIPPED");
    expect(text).toContain("Decision: SKIPPED");
    expect(lineFor(formatMarginPlanLines(skipped), "Selected leverage:")).toContain("—");
    expect(text).toContain("Liquidation safety:");
    expect(text).not.toContain("PASS");
  });
});
