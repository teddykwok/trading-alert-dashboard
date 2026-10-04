import { NATIVE_PLAN_EXECUTION_STATUS, type SelectedPlanSummary } from "@trading-alert-dashboard/shared";

/**
 * How a selected, frozen Extreme RR plan reads wherever it is displayed
 * READ ONLY (the alert's Execution tab, the Trading Control page). Pure.
 *
 * The plan owns the analysis choice (50/100/200/300 candles); this only shows
 * it. Prices appear only for a SELECTED plan: an incalculable plan shows its
 * reason, never a fabricated stop-loss or take-profit.
 */

export interface SelectedPlanRow {
  readonly label: string;
  readonly value: string;
}

export interface SelectedPlanPresentation {
  readonly headline: string;
  readonly tone: "green" | "yellow" | "gray" | "red";
  readonly rows: readonly SelectedPlanRow[];
  /** Always set for a Native plan: planning only, never executed. */
  readonly status: string;
}

/**
 * The plan's OWN global selection (its initial window comes from the deployment
 * default EXTREME_RR_LOOKBACK_CANDLES, or a manual Trade Plan choice). It is NOT
 * an account execution preference: Account A / B Native defaults are separate.
 */
export const PLAN_SELECTION_LABEL = "Plan selection (global)";

/** Rows whose value is an exact decimal price, rendered compactly (exact value kept in the tooltip). */
export const DECIMAL_ROW_LABELS: readonly string[] = ["Entry", "SL", "TP"];

export const NO_SELECTED_PLAN = "No selected plan — no Extreme RR plan has been generated for this alert.";

const STATE_HEADLINE: Readonly<Record<SelectedPlanSummary["state"], string>> = Object.freeze({
  SELECTED: "Selected plan",
  PLAN_NOT_READY: "Plan not ready",
  NO_SELECTED_CANDIDATE: "No candidate for the selected lookback",
  SELECTED_CANDIDATE_INVALID: "Selected lookback is not calculable",
});

const SOURCE_LABEL: Readonly<Record<SelectedPlanSummary["alertSource"], string>> = Object.freeze({ TRADINGVIEW: "TRADINGVIEW", NATIVE: "NATIVE" });

/** Display only: the exact decimal strings stay authoritative. */
function ratio(value: string | null): string {
  if (value === null) return "—";
  const n = Number(value);
  return Number.isFinite(n) ? `1:${Number(n.toFixed(2))}` : "—";
}

export function presentSelectedPlan(summary: SelectedPlanSummary | null): SelectedPlanPresentation {
  if (summary === null) {
    return { headline: "No selected plan", tone: "gray", rows: [], status: NO_SELECTED_PLAN };
  }
  const status = summary.alertSource === "NATIVE" ? NATIVE_PLAN_EXECUTION_STATUS : "Execution is decided by each account's own admission";
  const lookback = `${summary.selectedLookback} candles${summary.actualCandles !== null && summary.complete === false ? ` (only ${summary.actualCandles} available)` : ""}`;
  const rows: SelectedPlanRow[] = [
    { label: PLAN_SELECTION_LABEL, value: lookback },
    { label: "Direction", value: summary.direction },
    { label: "Entry", value: summary.entryPrice },
  ];
  if (summary.state === "SELECTED") {
    rows.push(
      { label: "SL", value: summary.stopLoss as string },
      { label: "TP", value: summary.takeProfit as string },
      { label: "RR", value: ratio(summary.riskRewardRatio) }
    );
  } else {
    rows.push({ label: "Not calculable", value: summary.reason ?? "Unknown reason" });
  }
  rows.push({ label: "Source", value: SOURCE_LABEL[summary.alertSource] }, { label: "Status", value: status });
  return {
    headline: STATE_HEADLINE[summary.state],
    tone: summary.state === "SELECTED" ? (summary.alertSource === "NATIVE" ? "yellow" : "green") : "gray",
    rows,
    status,
  };
}
