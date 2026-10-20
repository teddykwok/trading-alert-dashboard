import type {
  SignalQualityFlagCategory,
  SignalQualityHorizonDto,
  SignalQualityHorizonState,
  SignalQualityMarketDataStatus,
  SignalQualityPlanOutcome,
  SignalQualityRate,
  SignalQualityRowDto,
  SignalQualityStats,
} from "@trading-alert-dashboard/shared";

/**
 * Presentation rules for the observatory. Pure.
 *
 * Every rate is shown WITH its denominator ("7 / 19 resolved · 36.8%"), every
 * statistic with its sample size, and an absent value is "—", never 0. A
 * censored horizon is labelled as such; nothing incomplete reads as a result.
 */

export type Tone = "green" | "red" | "yellow" | "gray" | "blue";

export const BANNER_LINES = ["SIGNAL QUALITY OBSERVATORY", "MONITORING ONLY", "NO EXECUTION AUTHORITY"] as const;

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

export function formatR(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}R`;
}

/** "7 / 19 resolved · 36.8%", or "0 / 0 resolved · —". The denominator is never hidden. */
export function formatRate(rate: SignalQualityRate, noun: string): string {
  const pct = rate.value === null || !Number.isFinite(rate.value) ? "—" : `${(rate.value * 100).toFixed(1)}%`;
  return `${rate.numerator} / ${rate.denominator} ${noun} · ${pct}`;
}

/** "mean +1.20% · median +0.80% (n = 12)". */
export function formatStats(stats: SignalQualityStats, format: (v: number | null) => string = (v) => formatPercent(v)): string {
  if (stats.n === 0) return "no matured sample (n = 0)";
  return `mean ${format(stats.mean)} · median ${format(stats.median)} (n = ${stats.n})`;
}

export const HORIZON_STATE_TONE: Record<SignalQualityHorizonState, Tone> = {
  MATURED: "green",
  PARTIAL: "blue",
  PENDING: "gray",
  DATA_GAP: "yellow",
  DATA_UNAVAILABLE: "yellow",
};

/** A table cell for one horizon: the return when matured, or the state when censored. */
export function horizonCell(h: SignalQualityHorizonDto | undefined): { text: string; tone: Tone; title: string } {
  if (h === undefined) return { text: "—", tone: "gray", title: "not evaluated" };
  switch (h.state) {
    case "MATURED":
      return { text: formatPercent(h.returnPct), tone: h.returnPct !== null && h.returnPct > 0 ? "green" : h.returnPct !== null && h.returnPct < 0 ? "red" : "gray", title: `matured · MFE ${formatPercent(h.mfePct)} · MAE ${formatPercent(h.maePct)}` };
    case "PARTIAL":
      return { text: `${formatPercent(h.returnPct)}*`, tone: "blue", title: `PARTIAL (censored): ${h.reason ?? `${h.observedMinutes} of ${h.expectedMinutes} minutes`}` };
    case "PENDING":
      return { text: "pending", tone: "gray", title: "PENDING (censored): no minute of this horizon has closed yet" };
    case "DATA_GAP":
      return { text: "gap", tone: "yellow", title: `DATA_GAP: ${h.reason ?? "missing minutes"}` };
    case "DATA_UNAVAILABLE":
      return { text: "no data", tone: "yellow", title: `DATA_UNAVAILABLE: ${h.reason ?? "no market data"}` };
  }
}

export const PLAN_OUTCOME_TONE: Record<SignalQualityPlanOutcome, Tone> = {
  TP_FIRST: "green",
  SL_FIRST: "red",
  NEITHER: "gray",
  AMBIGUOUS_SAME_BAR: "yellow",
  PLAN_UNAVAILABLE: "gray",
  DATA_GAP: "yellow",
  PENDING: "blue",
  DATA_UNAVAILABLE: "yellow",
};

export const PLAN_OUTCOME_LABEL: Record<SignalQualityPlanOutcome, string> = {
  TP_FIRST: "TP first",
  SL_FIRST: "SL first",
  NEITHER: "Neither (24h)",
  AMBIGUOUS_SAME_BAR: "Ambiguous (same bar)",
  PLAN_UNAVAILABLE: "No plan",
  DATA_GAP: "Data gap",
  PENDING: "Pending",
  DATA_UNAVAILABLE: "No data",
};

export const FLAG_TONE: Record<SignalQualityFlagCategory, Tone> = { DEFECT: "red", WARNING: "yellow", INFO: "gray" };

export const MARKET_DATA_LABEL: Record<SignalQualityMarketDataStatus, string> = {
  LOADED: "loaded",
  NOT_LOADED: "loading — refresh to continue",
  UNAVAILABLE: "public market data unavailable",
};

export function integrityLabel(row: SignalQualityRowDto): { text: string; tone: Tone } {
  if (!row.integrity.judged) return { text: "not judged", tone: "gray" };
  return row.integrity.status === "ELIGIBLE" ? { text: "ELIGIBLE", tone: "green" } : { text: row.integrity.status ?? "UNREADABLE", tone: "yellow" };
}

export function freshnessLabel(row: SignalQualityRowDto): { text: string; tone: Tone } {
  switch (row.freshness.state) {
    case "FRESH_AT_DELIVERY":
      return { text: "fresh", tone: "green" };
    case "STALE_AT_DELIVERY":
      return { text: "stale", tone: "yellow" };
    case "TIME_UNAVAILABLE":
      return { text: "time unavailable", tone: "red" };
  }
}

/** "12m after bar start" — displayed exactly as persisted, never corrected. */
export function triggerOffsetLabel(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1000);
  return `${sign}${minutes}m ${seconds}s after bar start`;
}

/** Bounded rendering: the DOM never holds more than one page. */
export const MAX_RENDERED_ROWS = 100;
export function boundedRows<T>(rows: readonly T[]): readonly T[] {
  return rows.length > MAX_RENDERED_ROWS ? rows.slice(0, MAX_RENDERED_ROWS) : rows;
}
