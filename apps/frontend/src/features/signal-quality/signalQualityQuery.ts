import {
  SIGNAL_QUALITY_FLAG_CODES,
  SIGNAL_QUALITY_FRESHNESS_STATES,
  SIGNAL_QUALITY_HORIZON_KEYS,
  SIGNAL_QUALITY_HORIZON_STATES,
  SIGNAL_QUALITY_INTEGRITY_FILTERS,
  SIGNAL_QUALITY_PAGE_SIZES,
  SIGNAL_QUALITY_PLAN_OUTCOMES,
  SIGNAL_QUALITY_SCOPE_FILTERS,
  SIGNAL_QUALITY_SORTS,
  SIGNAL_QUALITY_TIMEFRAME_CLASSES,
  type SignalQualityFlag,
  type SignalQualityFreshnessState,
  type SignalQualityHorizonKey,
  type SignalQualityHorizonState,
  type SignalQualityIntegrityFilter,
  type SignalQualityPlanOutcome,
  type SignalQualityScopeFilter,
  type SignalQualitySort,
  type SignalQualityTimeframeClass,
} from "@trading-alert-dashboard/shared";

/**
 * The observatory's request, as pure data. Framework-free so every rule is
 * testable without a DOM: the filters and the soak window become ONE query
 * string, and that string is the request's identity (a re-render that does not
 * change it cannot trigger a request).
 */

export interface SignalQualityFilters {
  readonly symbol: string;
  readonly sourceTimeframe: "" | "1D" | "1W" | "1M";
  readonly direction: "" | "LONG" | "SHORT";
  readonly levelColor: "" | "GREEN" | "RED";
  readonly timeframeClass: "" | SignalQualityTimeframeClass;
  readonly integrity: "" | SignalQualityIntegrityFilter;
  readonly freshness: "" | SignalQualityFreshnessState;
  readonly planOutcome: "" | SignalQualityPlanOutcome;
  readonly horizon: SignalQualityHorizonKey;
  readonly horizonState: "" | SignalQualityHorizonState;
  readonly flag: "" | SignalQualityFlag;
}

export const EMPTY_SIGNAL_QUALITY_FILTERS: SignalQualityFilters = Object.freeze({
  symbol: "",
  sourceTimeframe: "",
  direction: "",
  levelColor: "",
  timeframeClass: "",
  integrity: "",
  freshness: "",
  planOutcome: "",
  horizon: "24h",
  horizonState: "",
  flag: "",
});

/** The soak window as the operator typed it (ISO …Z), or empty for the default last 24 hours. */
export interface SoakWindowInput {
  readonly soakStart: string;
  readonly soakEnd: string;
  readonly scope: SignalQualityScopeFilter;
  /** Point-in-time view; empty = now. */
  readonly asOf: string;
}

export const DEFAULT_SOAK_WINDOW: SoakWindowInput = Object.freeze({ soakStart: "", soakEnd: "", scope: "ALL", asOf: "" });

export type SignalQualityPageSize = (typeof SIGNAL_QUALITY_PAGE_SIZES)[number];
export const DEFAULT_SIGNAL_QUALITY_PAGE_SIZE: SignalQualityPageSize = 50;

export interface FilterOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

const option = <T extends string>(value: T, label: string = value): FilterOption<T> => ({ value, label });

export const SOURCE_TF_OPTIONS = (["1D", "1W", "1M"] as const).map((v) => option(v));
export const DIRECTION_OPTIONS = (["LONG", "SHORT"] as const).map((v) => option(v));
export const LEVEL_COLOR_OPTIONS = (["GREEN", "RED"] as const).map((v) => option(v));
export const TIMEFRAME_CLASS_OPTIONS = SIGNAL_QUALITY_TIMEFRAME_CLASSES.map((v) => option(v, v === "EXECUTION_POLICY_TIMEFRAME" ? "1D/1W (execution-policy TF)" : "Dashboard-only TF"));
export const INTEGRITY_OPTIONS = SIGNAL_QUALITY_INTEGRITY_FILTERS.map((v) => option(v, v.replace(/_/g, " ").toLowerCase()));
export const FRESHNESS_OPTIONS = SIGNAL_QUALITY_FRESHNESS_STATES.map((v) => option(v, v.replace(/_/g, " ").toLowerCase()));
export const PLAN_OUTCOME_OPTIONS = SIGNAL_QUALITY_PLAN_OUTCOMES.map((v) => option(v, v.replace(/_/g, " ")));
export const HORIZON_OPTIONS = SIGNAL_QUALITY_HORIZON_KEYS.map((v) => option(v));
export const HORIZON_STATE_OPTIONS = SIGNAL_QUALITY_HORIZON_STATES.map((v) => option(v, v.replace(/_/g, " ")));
export const FLAG_OPTIONS = SIGNAL_QUALITY_FLAG_CODES.map((v) => option(v, v.replace(/_/g, " ").toLowerCase()));
export const SCOPE_OPTIONS = SIGNAL_QUALITY_SCOPE_FILTERS.map((v) =>
  option(v, v === "ALL" ? "All alerts in the window" : v === "TRIGGERED_DURING_SOAK" ? "Triggered during the soak" : "Triggered before the soak, observed during it")
);
export const SORT_OPTIONS = SIGNAL_QUALITY_SORTS.map((v) =>
  option(v, { TRIGGERED_DESC: "Newest first", TRIGGERED_ASC: "Oldest first", SYMBOL_ASC: "Symbol", R_DESC: "Realized R", MFE_24H_DESC: "24h MFE" }[v])
);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const SYMBOL = /^[\p{L}\p{N}]{1,40}$/u;

/** A typed instant is accepted only in the exact form the API accepts. */
export function checkInstant(text: string): { ok: true; value: string | null } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!ISO.test(trimmed) || !Number.isFinite(Date.parse(trimmed))) return { ok: false, message: "Use an ISO-8601 UTC instant, e.g. 2026-10-21T08:00:00Z" };
  return { ok: true, value: trimmed };
}

export function checkSymbol(text: string): { ok: true; value: string | null } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  return SYMBOL.test(trimmed) ? { ok: true, value: trimmed.toUpperCase() } : { ok: false, message: "A symbol is letters and digits only" };
}

export interface SignalQualityRequest {
  readonly window: SoakWindowInput;
  readonly filters: SignalQualityFilters;
  readonly sort: SignalQualitySort;
  readonly offset: number;
  readonly pageSize: SignalQualityPageSize;
}

/** Why a request cannot be sent yet (shown next to the inputs), or null. */
export function requestProblem(request: Pick<SignalQualityRequest, "window" | "filters">): string | null {
  const start = checkInstant(request.window.soakStart);
  const end = checkInstant(request.window.soakEnd);
  const asOf = checkInstant(request.window.asOf);
  const symbol = checkSymbol(request.filters.symbol);
  for (const check of [start, end, asOf, symbol]) if (!check.ok) return check.message;
  const hasStart = start.ok && start.value !== null;
  const hasEnd = end.ok && end.value !== null;
  if (hasStart !== hasEnd) return "Give both soak start and soak end, or neither";
  if (hasStart && hasEnd && Date.parse(request.window.soakEnd) <= Date.parse(request.window.soakStart)) return "Soak end must be after soak start";
  if (!hasStart && request.window.scope !== "ALL") return "A soak scope needs a soak window";
  return null;
}

/** The summary's query: window and filters, no paging. Deterministic key order. */
export function summaryQueryString(request: Pick<SignalQualityRequest, "window" | "filters">): string {
  const params = new URLSearchParams();
  const w = request.window;
  if (w.soakStart.trim()) params.set("soakStart", w.soakStart.trim());
  if (w.soakEnd.trim()) params.set("soakEnd", w.soakEnd.trim());
  if (w.scope !== "ALL") params.set("scope", w.scope);
  if (w.asOf.trim()) params.set("asOf", w.asOf.trim());
  const f = request.filters;
  if (f.symbol.trim()) params.set("symbol", f.symbol.trim().toUpperCase());
  if (f.sourceTimeframe) params.set("sourceTimeframe", f.sourceTimeframe);
  if (f.direction) params.set("direction", f.direction);
  if (f.levelColor) params.set("levelColor", f.levelColor);
  if (f.timeframeClass) params.set("timeframeClass", f.timeframeClass);
  if (f.integrity) params.set("integrity", f.integrity);
  if (f.freshness) params.set("freshness", f.freshness);
  if (f.planOutcome) params.set("planOutcome", f.planOutcome);
  if (f.horizonState) {
    params.set("horizon", f.horizon);
    params.set("horizonState", f.horizonState);
  }
  if (f.flag) params.set("flag", f.flag);
  return params.toString();
}

/** The page's query: the summary's, plus sort and paging. */
export function pageQueryString(request: SignalQualityRequest): string {
  const params = new URLSearchParams(summaryQueryString(request));
  if (request.sort !== "TRIGGERED_DESC") params.set("sort", request.sort);
  if (request.offset > 0) params.set("offset", String(request.offset));
  params.set("pageSize", String(request.pageSize));
  return params.toString();
}

export function activeFilterCount(filters: SignalQualityFilters): number {
  return (Object.keys(filters) as (keyof SignalQualityFilters)[]).filter((key) => key !== "horizon" && filters[key] !== "").length;
}

export const nextOffset = (offset: number, pageSize: number, total: number) => (offset + pageSize < total ? offset + pageSize : offset);
export const previousOffset = (offset: number, pageSize: number) => Math.max(0, offset - pageSize);
export const pageNumberOf = (offset: number, pageSize: number) => Math.floor(offset / pageSize) + 1;

/** A preset soak window: the 24 hours starting at `startIso`. */
export function soakWindowFrom(startIso: string, hours = 24): Pick<SoakWindowInput, "soakStart" | "soakEnd"> {
  const start = Date.parse(startIso);
  return { soakStart: new Date(start).toISOString(), soakEnd: new Date(start + hours * 3_600_000).toISOString() };
}
