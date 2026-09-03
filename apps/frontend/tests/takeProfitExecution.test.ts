import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { displayPercentFromRatio } from "../src/features/executions/executionFormat";
import { presentTakeProfitExecution } from "../src/features/executions/takeProfitExecution";
import type { TakeProfitExecution } from "../src/api/executions.api";

/**
 * Take-profit execution visibility.
 *
 * A TAKE_PROFIT_MARKET order controls its trigger and nothing after it: once
 * touched, the exchange fills at market. Across real closures the fill was
 * adverse fifteen times out of sixteen, worst by 43% of the reward distance —
 * a $2.25 plan delivering $1.28 — and none of it was visible anywhere.
 *
 * The backend owns every number. These tests pin what the UI is allowed to say
 * about them: the sign convention, the two deliberately separate dollar
 * figures, the percentage unit, and above all that "not measurable" never
 * renders as a clean zero.
 *
 * The repo has no DOM test environment, so — exactly as `executionPresentation`
 * and `tradingControlPage` already do — the pure presenter is exercised
 * directly and the rendering wiring is asserted from source.
 */

const src = (relative: string) => readFileSync(path.join(process.cwd(), "src", relative), "utf8");

/** Strips comments so a source assertion measures CODE, not documentation. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** LONG, trigger 108, entry 100, 0.375 filled: an exact fill at the trigger. */
const exact: TakeProfitExecution = {
  triggerPrice: "108",
  actualExitPrice: "108",
  closedQuantity: "0.375",
  plannedRewardDistance: "8",
  actualRewardDistance: "8",
  plannedGrossProfitUsd: "3",
  actualGrossProfitUsd: "3",
  grossProfitShortfallUsd: "0",
  adverseSlippagePrice: "0",
  adverseSlippageUsd: "0",
  adverseSlippageRatio: "0",
};

const adverse: TakeProfitExecution = {
  ...exact,
  actualExitPrice: "106",
  actualRewardDistance: "6",
  actualGrossProfitUsd: "2.25",
  grossProfitShortfallUsd: "0.75",
  adverseSlippagePrice: "2",
  adverseSlippageUsd: "0.75",
  adverseSlippageRatio: "0.25",
};

const favourable: TakeProfitExecution = {
  ...exact,
  actualExitPrice: "109",
  actualRewardDistance: "9",
  actualGrossProfitUsd: "3.375",
  grossProfitShortfallUsd: "-0.375",
  adverseSlippagePrice: "-1",
  adverseSlippageUsd: "-0.375",
  adverseSlippageRatio: "-0.125",
};

describe("A-C. take-profit execution verdicts", () => {
  it("A. an exact fill at the trigger reads ON TARGET, showing a real zero", () => {
    const view = presentTakeProfitExecution(exact)!;

    expect(view.verdict).toBe("ON_TARGET");
    expect(view.verdictLabel).toBe("On target");
    expect(view.tone).toBe("gray");
    // Zero here is a MEASURED zero, so it renders as a number rather than the
    // unknown marker — the opposite of the null case below.
    expect(view.slippageUsd.text).toBe("0");
    expect(view.slippageUsd.known).toBe(true);
    expect(view.slippageRatio.text).toBe("0.0%");
    expect(view.slippageRatio.known).toBe(true);
  });

  it("B. a fill worse than the trigger reads ADVERSE with both gross figures", () => {
    const view = presentTakeProfitExecution(adverse)!;

    expect(view.verdict).toBe("ADVERSE");
    expect(view.verdictLabel).toBe("Adverse");
    expect(view.triggerPrice.text).toBe("108");
    expect(view.actualExitPrice.text).toBe("106");
    expect(view.plannedGrossProfit.text).toBe("3");
    expect(view.actualGrossProfit.text).toBe("2.25");
    expect(view.slippageUsd.text).toBe("0.75");
    expect(view.slippageRatio.text).toBe("25.0%");
  });

  it("C. a fill better than the trigger is FAVOURABLE, never an error", () => {
    const view = presentTakeProfitExecution(favourable)!;

    expect(view.verdict).toBe("FAVOURABLE");
    expect(view.verdictLabel).toBe("Favourable");
    // Green, not red: beating the trigger is a good outcome, and the negative
    // sign is kept rather than clamped so it stays legible as one.
    expect(view.tone).toBe("green");
    expect(view.slippageUsd.text).toBe("-0.375");
    expect(view.slippageRatio.text).toBe("-12.5%");
  });

  it("C2. adverse is a caution tone, not the red reserved for actionable states", () => {
    // Analytics about a closed trade must not look like a runtime alarm.
    expect(presentTakeProfitExecution(adverse)!.tone).toBe("yellow");
    expect(["red"]).not.toContain(presentTakeProfitExecution(adverse)!.tone);
  });
});

describe("D. unavailable telemetry", () => {
  it("D. null yields no view at all — never a fabricated zero", () => {
    // The backend returns null for a stop closure, an external close, a
    // missing price or quantity and a split closure. None of those mean the
    // exit was perfect, so there is nothing to render.
    expect(presentTakeProfitExecution(null)).toBeNull();
    expect(presentTakeProfitExecution(undefined)).toBeNull();
  });

  it("D2. the section is hidden rather than rendered empty", () => {
    const page = src("pages/ExecutionDetailPage.tsx");
    // The component returns before any markup when the presenter declines.
    expect(page).toMatch(/const view = presentTakeProfitExecution\(detail\.takeProfitExecution\);/);
    expect(page).toMatch(/if \(!view\) return null;/);
    // And no placeholder text pretends a measurement exists.
    expect(page).not.toContain("No slippage");
  });
});

describe("E. the two dollar figures stay distinct", () => {
  it("E. shortfall and exit slippage are separate values with separate labels", () => {
    // An entry that filled BETTER than planned: the plan lost $0.20 of reward
    // distance to the entry, and the exit lost $0.75 more. Collapsing these
    // would blame the exit for both.
    const entryEffect: TakeProfitExecution = { ...adverse, grossProfitShortfallUsd: "0.95" };
    const view = presentTakeProfitExecution(entryEffect)!;

    expect(view.grossProfitShortfall.text).toBe("0.95");
    expect(view.slippageUsd.text).toBe("0.75");
    expect(view.grossProfitShortfall.text).not.toBe(view.slippageUsd.text);

    const page = src("pages/ExecutionDetailPage.tsx");
    expect(page).toContain("Gross profit shortfall");
    expect(page).toContain("Exit slippage");
    // The shortfall must never be labelled as slippage.
    expect(page).not.toMatch(/label="Gross profit slippage"/);
  });

  it("E2. the page explains why the two can differ", () => {
    const page = src("pages/ExecutionDetailPage.tsx");
    expect(page).toContain("isolates the trigger-to-fill");
  });
});

describe("F. ratio unit", () => {
  it("F. the backend ratio is a FRACTION and renders as a percentage", () => {
    // Proven by the merged backend tests: 0.25 is asserted for a fill two
    // dollars short of an eight-dollar reward distance, i.e. 25%.
    expect(displayPercentFromRatio("0.432").text).toBe("43.2%");
    expect(displayPercentFromRatio("0.25").text).toBe("25.0%");
    expect(displayPercentFromRatio("-0.125").text).toBe("-12.5%");
    // The guard against the classic mistake: never 4320%.
    expect(displayPercentFromRatio("0.432").text).not.toBe("4320.0%");
  });

  it("F2. the exact fraction stays reachable and unparseable input is unknown", () => {
    const shown = displayPercentFromRatio("0.4321987");
    expect(shown.exact).toBe("0.4321987");
    expect(shown.known).toBe(true);

    for (const bad of [null, undefined, "", "not-a-number"]) {
      const unknown = displayPercentFromRatio(bad);
      expect(unknown.known).toBe(false);
      expect(unknown.text).toBe("—");
    }
  });
});

describe("G-H. precision and read-only", () => {
  it("G. a small-price symbol keeps the trigger and the fill distinguishable", () => {
    // The real GRIFFAINUSDT case: 0.011824 planned, 0.011420 delivered.
    const tiny: TakeProfitExecution = {
      ...adverse,
      triggerPrice: "0.011824",
      actualExitPrice: "0.011420",
      adverseSlippagePrice: "0.000404",
      adverseSlippageUsd: "0.9708",
      adverseSlippageRatio: "0.4316",
    };
    const view = presentTakeProfitExecution(tiny)!;

    expect(view.triggerPrice.text).toBe("0.011824");
    expect(view.actualExitPrice.text).toBe("0.011420");
    expect(view.triggerPrice.text).not.toBe(view.actualExitPrice.text);
    expect(view.slippagePrice.text).toBe("0.000404");
    expect(view.slippageRatio.text).toBe("43.2%");
  });

  it("H. the surface is read-only: it presents, it never recalculates or writes", () => {
    const feature = stripComments(src("features/executions/takeProfitExecution.ts"));
    // Every displayed number is the backend string. The only arithmetic in the
    // whole feature is the ratio-to-percentage conversion, which lives in the
    // shared formatter, not here.
    // Operators between operands, checked on code with every string literal
    // blanked first: an import path is full of slashes and is not division.
    const codeOnly = feature
      .replace(/"[^"]*"/g, '""')
      .replace(/'[^']*'/g, "''")
      .replace(/`[^`]*`/g, "``");
    expect(codeOnly).not.toMatch(/[\w)]\s*[*/]\s*[\w(]/);
    // `displayDecimal` is a formatter, so "Decimal" alone proves nothing; what
    // must be absent is decimal ARITHMETIC.
    for (const arithmetic of ["minus(", "times(", "plus(", "div("]) {
      expect(feature.includes(arithmetic), arithmetic).toBe(false);
    }
    // No mutation surface of any kind.
    for (const forbidden of ["fetch(", "executionsApi", "onClick", "useState", "post(", "put("]) {
      expect(feature.includes(forbidden), forbidden).toBe(false);
    }

    const page = stripComments(src("pages/ExecutionDetailPage.tsx"));
    // The section renders values and nothing interactive.
    const section = page.slice(page.indexOf("function TakeProfitExecutionSection"));
    const body = section.slice(0, section.indexOf("\nfunction "));
    for (const forbidden of ["onClick", "onSubmit", "<button", "<input", "fetch("]) {
      expect(body.includes(forbidden), forbidden).toBe(false);
    }
  });
});
