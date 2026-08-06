import type { DynamicLeveragePlan } from "@trading-alert-dashboard/shared";

/**
 * PRESENTATION ONLY for the margin-plan CLI.
 *
 * Nothing here calculates: it renders the authoritative decimal strings from
 * the plan DTO. Monetary values are shown with enough precision that a figure
 * is never understated or hidden (e.g. an unused risk budget of 0.0006 must
 * not collapse to "$0.00", and a maximum margin of 4.9999995 must not read as
 * "$5.00"). Pure string work — no float conversion anywhere.
 */

/** Money keeps 8 decimals: enough for cent-fractions and 4.9999995-style ceilings. */
const MONEY_DECIMALS = 8;
/** Prices keep 8 decimals for small-cap symbols. */
const PRICE_DECIMALS = 8;

/**
 * Truncates to `maxDecimals` without rounding, trims padding zeros but keeps
 * at least two decimals when the source had them, and appends "…" when real
 * digits were dropped so a shortened value is never mistaken for an exact one.
 */
export function formatDecimal(value: string | null, maxDecimals: number): string {
  if (value === null) return "—";

  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [intPart, fracPart] = unsigned.split(".");
  if (fracPart === undefined) return `${negative ? "-" : ""}${intPart}`;

  const kept = fracPart.slice(0, maxDecimals);
  const dropped = fracPart.slice(maxDecimals);
  const truncated = /[1-9]/.test(dropped);

  let shown = kept.replace(/0+$/, "");
  // Preserve a conventional 2-decimal look when the source had it.
  if (shown.length < 2 && fracPart.length >= 2) shown = kept.slice(0, Math.max(2, shown.length));

  const body = shown === "" ? intPart : `${intPart}.${shown}`;
  return `${negative ? "-" : ""}${body}${truncated ? "…" : ""}`;
}

export function formatMoney(value: string | null): string {
  if (value === null) return "—";
  const rendered = formatDecimal(value, MONEY_DECIMALS);
  return rendered.startsWith("-") ? `-$${rendered.slice(1)}` : `$${rendered}`;
}

export function formatPrice(value: string | null): string {
  return formatDecimal(value, PRICE_DECIMALS);
}

function row(label: string, value: string | number | null | undefined): string {
  return `  ${label.padEnd(24)}${value === null || value === undefined ? "—" : value}`;
}

/** Renders the whole plan as lines. Returned (not printed) so it is testable. */
export function formatMarginPlanLines(plan: DynamicLeveragePlan): string[] {
  const lines: string[] = ["Dynamic leverage plan — READ ONLY (nothing is sent to Binance)", ""];

  lines.push(row("Symbol:", plan.symbol));
  lines.push(row("Direction:", plan.direction));
  lines.push(row("Entry:", formatPrice(plan.entryPrice)));
  lines.push(row("Stop-loss (executable):", formatPrice(plan.stopLoss)));
  if (plan.stopNormalization) {
    lines.push(row("  calculated stop:", formatPrice(plan.calculatedStopLoss)));
    lines.push(row("  tick adjustment:", formatPrice(plan.stopAdjustment)));
  }
  lines.push(row("Stop distance:", formatPrice(plan.stopDistance)));
  lines.push(row("Risk budget:", formatMoney(plan.riskBudgetUsd)));

  lines.push("");
  lines.push(row("Quantity raw:", formatPrice(plan.quantityRaw)));
  lines.push(row("Quantity rounded down:", formatPrice(plan.roundedQuantity)));
  lines.push(row("LOT_SIZE step:", plan.quantityStepSize));
  lines.push(row("Actual planned loss:", formatMoney(plan.actualPlannedLoss)));
  lines.push(row("Unused risk budget:", formatMoney(plan.unusedRiskBudget)));
  lines.push(row("Position notional:", formatMoney(plan.positionNotional)));
  lines.push(row("Minimum notional:", plan.minimumNotional));

  lines.push("");
  lines.push(row("Target margin:", formatMoney(plan.targetIsolatedMargin)));
  lines.push(row("Maximum margin:", formatMoney(plan.maximumIsolatedMargin)));
  lines.push(
    row(
      "Binance max leverage:",
      plan.binanceMaximumSupportedLeverage ? `${plan.binanceMaximumSupportedLeverage}x` : null
    )
  );
  lines.push(row("User automation max:", `${plan.userMaximumAutomationLeverage}x`));
  lines.push(row("Usable maximum:", plan.usableMaximumLeverage ? `${plan.usableMaximumLeverage}x` : null));
  if (plan.applicableBracket) {
    lines.push(row("Bracket:", plan.applicableBracket.bracket));
    lines.push(row("Maint. margin rate:", plan.applicableBracket.maintMarginRatio));
    lines.push(row("Maint. amount (cum):", plan.applicableBracket.cum));
  }

  lines.push("");
  lines.push(row("Selected leverage:", plan.selectedLeverage ? `${plan.selectedLeverage}x` : null));
  lines.push(row("Estimated margin:", formatMoney(plan.estimatedInitialMargin)));
  lines.push(row("Margin vs target:", formatMoney(plan.marginDifferenceFromTarget)));
  lines.push(row("Estimated liquidation:", formatPrice(plan.estimatedLiquidationPrice)));
  lines.push(row("Required boundary:", formatPrice(plan.requiredLiquidationBoundary)));
  lines.push(row("Safety buffer:", formatPrice(plan.safetyBufferDistance)));
  lines.push(row("Liquidation distance:", formatPrice(plan.liquidationDistance)));
  lines.push(row("Liquidation safety:", plan.status === "READY" ? "PASS" : "NOT ESTABLISHED"));

  if (plan.candidates.length > 0) {
    const eligible = plan.candidates.filter((candidate) => candidate.eligible).length;
    lines.push("");
    lines.push(row("Candidates:", `${plan.candidates.length} evaluated, ${eligible} eligible`));
  }

  if (plan.warnings.length > 0) {
    lines.push("", "Warnings");
    for (const warning of plan.warnings) lines.push(`  - ${warning}`);
  }

  lines.push("");
  lines.push(`Decision: ${plan.status}${plan.reason ? ` (${plan.reason})` : ""}`);
  if (plan.reasonMessage) lines.push(`  ${plan.reasonMessage}`);
  lines.push(
    "",
    "Estimated liquidation price is an ESTIMATE, not Binance's guaranteed value. " +
      "No order was placed and no account setting was changed."
  );

  return lines;
}
