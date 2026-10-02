import { ScannerDataError } from "./binance-public-futures";
import type { CompatReplayRecord } from "./compat-replay";

/**
 * READ-ONLY TradingView ↔ native PARITY AUDIT — pure core.
 *
 * The TradingView export is evidence of alerts TradingView actually DELIVERED.
 * The native side is the canonical compatibility replay's reconstruction from
 * closed OHLC. The question asked of every TradingView alert is narrow and
 * one-directional: can the canonical reconstruction explain it?
 *
 *  - Matching is EXACT on every dimension the export carries: symbol, chart
 *    interval, chart bar, source timeframe, level colour, signal, touch
 *    direction and level price (the export's price IS the level, as Pine
 *    sends it; the replay keeps the same IEEE double). No tolerance, no fuzz.
 *  - Evidence classes are never merged: IMMEDIATE_INTRABAR proven, IMMEDIATE
 *    possible-only and COMMITTED_BAR_CLOSE are counted separately.
 *  - A native candidate with no TradingView alert is NOT a false positive.
 *    The export holds positives only; TradingView's silence can come from
 *    alert-instance, session or one-alert-per-bar limits OHLC cannot encode.
 *    No false-positive rate is computed.
 */

export const PARITY_AUDIT_SCHEMA = "teddy.native-scanner.parity-audit.v1";
export const PARITY_NOTICE = Object.freeze([
  "READ-ONLY PARITY AUDIT",
  "TradingView rows are DELIVERED alerts; native rows are OHLC RECONSTRUCTIONS — never collapsed",
  "No false-positive rate is claimed: the export holds positives only",
] as const);

export type ParityCategory =
  | "EXACT_EXPLAINED"
  | "EXPLAINED_AMBIGUOUS_LEVEL"
  | "SOURCE_TF_MISMATCH"
  | "DIRECTION_MISMATCH"
  | "BAR_MATCH_LEVEL_MISMATCH"
  | "NO_NATIVE_EXPLANATION"
  | "INSUFFICIENT_CONTEXT"
  | "UNSUPPORTED_DATA"
  | "OUTSIDE_LINEAGE_WINDOW";

export const EXPLAINED_CATEGORIES: readonly ParityCategory[] = ["EXACT_EXPLAINED", "EXPLAINED_AMBIGUOUS_LEVEL"];
/** Categories in the explainability denominator: in window, supported, with context. */
export const ASSESSABLE_CATEGORIES: readonly ParityCategory[] = [
  "EXACT_EXPLAINED",
  "EXPLAINED_AMBIGUOUS_LEVEL",
  "SOURCE_TF_MISMATCH",
  "DIRECTION_MISMATCH",
  "BAR_MATCH_LEVEL_MISMATCH",
  "NO_NATIVE_EXPLANATION",
];

export interface TvAlert {
  readonly id: string;
  readonly symbol: string;
  readonly chartTimeframe: string;
  readonly levelPrice: number;
  readonly signal: "LONG" | "SHORT";
  readonly sourceTf: string;
  readonly levelColor: string;
  readonly touchDirection: string;
  readonly triggeredAtMs: number;
  /** The chart bar's open, as TradingView sent it; null when the export lacks it. */
  readonly barOpenTimeMs: number | null;
  readonly alertTiming: string;
  readonly eventType: string;
  /** "Minimum Price Movement (%)" as configured on the alert; 0 = not recorded. */
  readonly minMovePercent: number;
  readonly duplicateCount: number;
}

const fail = (line: number, message: string): never => {
  throw new ScannerDataError("MALFORMED_RESPONSE", `evidence line ${line}: ${message}`);
};

/** Strict parse of the TradingView export. A malformed row stops the audit; nothing is skipped silently. */
export function parseTvEvidence(text: string): TvAlert[] {
  if (text !== "" && !text.endsWith("\n")) throw new ScannerDataError("MALFORMED_RESPONSE", "the evidence file ends in a torn line");
  const lines = text === "" ? [] : text.slice(0, -1).split("\n");
  const seen = new Set<string>();
  return lines.map((line, index) => {
    const n = index + 1;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return fail(n, "not JSON");
    }
    const str = (k: string) => (typeof r[k] === "string" && r[k] !== "" ? (r[k] as string) : fail(n, `${k} must be a non-empty string`));
    const id = str("id");
    if (seen.has(id)) fail(n, `duplicate alert id ${id}`);
    seen.add(id);
    if (typeof r.price !== "number" || !Number.isFinite(r.price) || r.price <= 0) fail(n, "price must be a finite positive number");
    const signal = str("signal");
    if (signal !== "LONG" && signal !== "SHORT") fail(n, "signal must be LONG or SHORT");
    const triggeredAtMs = Date.parse(str("triggeredAt"));
    if (!Number.isFinite(triggeredAtMs)) fail(n, "triggeredAt is not a date");
    const raw = r.raw as { barTime?: unknown } | undefined;
    if (raw === null || typeof raw !== "object") fail(n, "raw must be an object");
    const barTime = raw?.barTime ?? null;
    let barOpenTimeMs: number | null = null;
    if (barTime !== null) {
      if (typeof barTime !== "string" || !Number.isFinite(Date.parse(barTime))) fail(n, "raw.barTime must be a date or null");
      barOpenTimeMs = Date.parse(barTime as string);
    }
    const minMove = r.indicatorValue;
    if (typeof minMove !== "number" || !Number.isFinite(minMove)) fail(n, "indicatorValue must be a number");
    return {
      id,
      symbol: str("symbol"),
      chartTimeframe: str("chartTimeframe"),
      levelPrice: r.price as number,
      signal: signal as "LONG" | "SHORT",
      sourceTf: str("sourceTimeframe"),
      levelColor: str("levelColor"),
      touchDirection: str("touchDirection"),
      triggeredAtMs,
      barOpenTimeMs,
      alertTiming: str("noteAlertTiming"),
      eventType: str("eventType"),
      minMovePercent: minMove as number,
      duplicateCount: typeof r.duplicateCount === "number" ? r.duplicateCount : 0,
    };
  });
}

export interface ParityScope {
  readonly chartInterval: string;
  readonly timing: string;
  readonly minMovePercent: number;
  readonly switchoverMs: number;
  /** Exclusive end of the replay: bars at or after it are not reconstructed. */
  readonly endMs: number;
}

export interface EvidenceClasses {
  readonly immediateProven: number;
  readonly immediatePossibleOnly: number;
  readonly committed: number;
}

export interface TvClassification {
  readonly tvId: string;
  readonly symbol: string;
  readonly barOpenTime: string | null;
  readonly sourceTf: string;
  readonly levelColor: string;
  readonly signal: string;
  readonly levelPrice: number;
  readonly category: ParityCategory;
  readonly detail: string;
  /** Distinct native levels (levelKey) that explain it exactly. */
  readonly matchedLevelKeys: readonly string[];
  readonly evidence: EvidenceClasses | null;
  /** For mismatches: what the native side had on the same bar. */
  readonly nativeOnBar: readonly string[];
  /** For unexplained alerts: the committed native state's view of the TradingView level (set by the runner). */
  readonly diagnostic?: string;
}

const describe = (r: CompatReplayRecord) => `${r.sourceTf}/${r.levelColor}/${r.signal}/${r.levelPrice}/${r.basis === "IMMEDIATE_INTRABAR" ? r.evidenceClass : "COMMITTED"}`;

/**
 * Classifies one TradingView alert against the native records of its symbol,
 * grouped by chart bar. Pure and deterministic.
 */
export function classifyTvAlert(
  tv: TvAlert,
  /** null when the symbol could not be reconstructed; `missingContext` then says why. */
  nativeByBar: ReadonlyMap<number, readonly CompatReplayRecord[]> | null,
  scope: ParityScope,
  missingContext: string | null = null
): TvClassification {
  const base = {
    tvId: tv.id,
    symbol: tv.symbol,
    barOpenTime: tv.barOpenTimeMs === null ? null : new Date(tv.barOpenTimeMs).toISOString(),
    sourceTf: tv.sourceTf,
    levelColor: tv.levelColor,
    signal: tv.signal,
    levelPrice: tv.levelPrice,
  };
  const out = (category: ParityCategory, detail: string, extra: Partial<TvClassification> = {}): TvClassification => ({
    ...base,
    category,
    detail,
    matchedLevelKeys: [],
    evidence: null,
    nativeOnBar: [],
    ...extra,
  });

  if (tv.eventType !== "LEVEL_TOUCHED") return out("UNSUPPORTED_DATA", `eventType ${tv.eventType}`);
  if (tv.chartTimeframe !== scope.chartInterval) return out("UNSUPPORTED_DATA", `chart timeframe ${tv.chartTimeframe} is not ${scope.chartInterval}`);
  if (tv.alertTiming !== scope.timing) return out("UNSUPPORTED_DATA", `alert timing ${tv.alertTiming} is not ${scope.timing}`);
  if (tv.minMovePercent !== scope.minMovePercent) return out("UNSUPPORTED_DATA", `min move ${tv.minMovePercent}% is not the lineage's ${scope.minMovePercent}%`);
  if (tv.barOpenTimeMs === null) return out("UNSUPPORTED_DATA", "the export carries no bar time for this alert");
  if (tv.barOpenTimeMs < scope.switchoverMs) {
    return out("OUTSIDE_LINEAGE_WINDOW", "before the compatibility switchover: TradingView's own continuous realtime run, which this lineage does not model");
  }
  if (tv.barOpenTimeMs >= scope.endMs) return out("INSUFFICIENT_CONTEXT", "after the replay end");
  if (nativeByBar === null) return out("INSUFFICIENT_CONTEXT", missingContext ?? "the symbol could not be reconstructed");

  const onBar = nativeByBar.get(tv.barOpenTimeMs) ?? [];
  const same = (r: CompatReplayRecord) => r.signal === tv.signal && r.sourceTf === tv.sourceTf && r.levelColor === tv.levelColor && r.touchDirection === tv.touchDirection;
  const exact = onBar.filter((r) => same(r) && r.levelPrice === tv.levelPrice);
  if (exact.length > 0) {
    const keys = [...new Set(exact.map((r) => r.levelKey))].sort();
    const evidence: EvidenceClasses = {
      immediateProven: exact.filter((r) => r.basis === "IMMEDIATE_INTRABAR" && r.evidenceClass === "PROVEN_INTRABAR_POSSIBLE").length,
      immediatePossibleOnly: exact.filter((r) => r.basis === "IMMEDIATE_INTRABAR" && r.evidenceClass === "POSSIBLE_ONLY").length,
      committed: exact.filter((r) => r.basis === "COMMITTED_BAR_CLOSE").length,
    };
    return keys.length > 1
      ? out("EXPLAINED_AMBIGUOUS_LEVEL", `${keys.length} distinct native levels at the same price explain it`, { matchedLevelKeys: keys, evidence })
      : out("EXACT_EXPLAINED", "exact", { matchedLevelKeys: keys, evidence });
  }
  const nativeOnBar = [...new Set(onBar.map(describe))].sort();
  if (onBar.some((r) => r.signal === tv.signal && r.levelPrice === tv.levelPrice && r.sourceTf !== tv.sourceTf)) {
    return out("SOURCE_TF_MISMATCH", "the native side has the same level price and signal on this bar under another source timeframe", { nativeOnBar });
  }
  if (onBar.some((r) => r.sourceTf === tv.sourceTf && r.levelPrice === tv.levelPrice && (r.signal !== tv.signal || r.touchDirection !== tv.touchDirection))) {
    return out("DIRECTION_MISMATCH", "the native side has the same level and timeframe on this bar with the other direction", { nativeOnBar });
  }
  if (onBar.some(same)) {
    return out("BAR_MATCH_LEVEL_MISMATCH", "the native side fired the same timeframe, colour and direction on this bar at a different level price", { nativeOnBar });
  }
  return out("NO_NATIVE_EXPLANATION", onBar.length === 0 ? "no native candidate on this bar" : "native candidates on this bar are unrelated", { nativeOnBar });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface Tally {
  readonly total: number;
  readonly byCategory: Partial<Record<ParityCategory, number>>;
  readonly assessable: number;
  readonly explained: number;
  /** explained / assessable, or null when nothing is assessable. */
  readonly explainabilityRate: number | null;
}

export function tally(rows: readonly TvClassification[]): Tally {
  const counts: Partial<Record<ParityCategory, number>> = {};
  for (const r of rows) counts[r.category] = (counts[r.category] ?? 0) + 1;
  // Keys in a fixed order, so the report's bytes never depend on row order.
  const byCategory = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as Partial<Record<ParityCategory, number>>;
  const assessable = rows.filter((r) => ASSESSABLE_CATEGORIES.includes(r.category)).length;
  const explained = rows.filter((r) => EXPLAINED_CATEGORIES.includes(r.category)).length;
  return { total: rows.length, byCategory, assessable, explained, explainabilityRate: assessable === 0 ? null : explained / assessable };
}

function groupTally(rows: readonly TvClassification[], key: (r: TvClassification) => string): Record<string, Tally> {
  const groups = new Map<string, TvClassification[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, tally(v)]));
}

const order = (a: TvClassification, b: TvClassification) =>
  (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0) || (a.barOpenTime ?? "").localeCompare(b.barOpenTime ?? "") || a.tvId.localeCompare(b.tvId);

/**
 * The explained alerts by strongest native evidence, three disjoint classes:
 * PROVEN immediate, else POSSIBLE_ONLY immediate, else committed-only.
 */
export function explainedByEvidence(rows: readonly TvClassification[]) {
  const explained = rows.filter((r) => EXPLAINED_CATEGORIES.includes(r.category) && r.evidence !== null);
  return {
    immediateProven: explained.filter((r) => (r.evidence as EvidenceClasses).immediateProven > 0).length,
    immediatePossibleOnly: explained.filter((r) => (r.evidence as EvidenceClasses).immediateProven === 0 && (r.evidence as EvidenceClasses).immediatePossibleOnly > 0).length,
    committedOnly: explained.filter((r) => (r.evidence as EvidenceClasses).immediateProven === 0 && (r.evidence as EvidenceClasses).immediatePossibleOnly === 0).length,
  };
}

/**
 * Explainability over the alerts whose level price Binance's OHLC can produce
 * at all. An alert whose TradingView level is not any Binance running HTF
 * high/low (or whose Binance bar never reached a ready level's band) cannot be
 * reconstructed from Binance data by any engine; it is excluded here and
 * reported, never hidden.
 */
export const DATA_FEED_DIAGNOSTICS: readonly string[] = ["DATA_FEED_LEVEL_NOT_IN_BINANCE_OHLC", "LEVEL_READY_BINANCE_BAR_MISSED_BAND"];

export function buildParityReport(rows: readonly TvClassification[], sampleSize: number) {
  const sorted = [...rows].sort(order);
  const samples: Partial<Record<ParityCategory, TvClassification[]>> = {};
  for (const r of sorted) {
    if (r.category === "EXACT_EXPLAINED") continue;
    const list = (samples[r.category] ??= []);
    if (list.length < sampleSize) list.push(r);
  }
  const inWindow = rows.filter((r) => r.category !== "OUTSIDE_LINEAGE_WINDOW");
  const diagnostics: Record<string, number> = {};
  for (const r of rows) if (r.diagnostic !== undefined) diagnostics[`${r.category} | ${r.diagnostic}`] = (diagnostics[`${r.category} | ${r.diagnostic}`] ?? 0) + 1;
  return {
    overall: tally(rows),
    inLineageWindow: tally(inWindow),
    binanceDerivable: tally(inWindow.filter((r) => r.diagnostic === undefined || !DATA_FEED_DIAGNOSTICS.includes(r.diagnostic))),
    unexplainedDiagnostics: Object.fromEntries(Object.entries(diagnostics).sort(([a], [b]) => (a < b ? -1 : 1))),
    explainedByEvidence: explainedByEvidence(rows),
    bySourceTf: groupTally(inWindow, (r) => r.sourceTf),
    byMonth: groupTally(inWindow, (r) => (r.barOpenTime ?? "unknown").slice(0, 7)),
    byDay: groupTally(inWindow, (r) => (r.barOpenTime ?? "unknown").slice(0, 10)),
    bySymbol: groupTally(inWindow, (r) => r.symbol),
    samples,
  };
}

/** How many native logical events (bar, signal, TF, level) have no TradingView alert — reported, never called false positives. */
export function nativeOnlyEvents(records: readonly CompatReplayRecord[], tv: readonly TvAlert[], fromMs: number, toMs: number) {
  const tvKeys = new Set(tv.filter((t) => t.barOpenTimeMs !== null).map((t) => `${t.symbol}|${t.barOpenTimeMs}|${t.signal}|${t.sourceTf}|${t.levelPrice}`));
  const tvBars = new Set(tv.filter((t) => t.barOpenTimeMs !== null).map((t) => `${t.symbol}|${t.barOpenTimeMs}`));
  const events = new Map<string, { bar: string; classes: Set<string> }>();
  for (const r of records) {
    if (r.chartBarOpenTimeMs < fromMs || r.chartBarOpenTimeMs >= toMs) continue;
    const key = `${r.symbol}|${r.chartBarOpenTimeMs}|${r.signal}|${r.sourceTf}|${r.levelPrice}`;
    const entry = events.get(key) ?? { bar: `${r.symbol}|${r.chartBarOpenTimeMs}`, classes: new Set<string>() };
    entry.classes.add(r.basis === "IMMEDIATE_INTRABAR" ? r.evidenceClass : "COMMITTED_BAR_CLOSE");
    events.set(key, entry);
  }
  let matched = 0;
  let unmatchedOnTvBar = 0;
  let unmatchedOnSilentBar = 0;
  const unmatchedByClass: Record<string, number> = {};
  for (const [key, entry] of events) {
    if (tvKeys.has(key)) {
      matched += 1;
      continue;
    }
    if (tvBars.has(entry.bar)) unmatchedOnTvBar += 1;
    else unmatchedOnSilentBar += 1;
    const strongest = entry.classes.has("PROVEN_INTRABAR_POSSIBLE") ? "PROVEN_INTRABAR_POSSIBLE" : entry.classes.has("POSSIBLE_ONLY") ? "POSSIBLE_ONLY" : "COMMITTED_BAR_CLOSE";
    unmatchedByClass[strongest] = (unmatchedByClass[strongest] ?? 0) + 1;
  }
  return {
    nativeLogicalEvents: events.size,
    matchedByTradingView: matched,
    withoutTradingViewAlert: {
      onBarsWhereTradingViewAlertedAnotherLevel: unmatchedOnTvBar,
      onBarsWithNoTradingViewAlert: unmatchedOnSilentBar,
      byStrongestEvidence: unmatchedByClass,
      interpretation: "NOT false positives: TradingView's silence is not evidence of absence (one alert per bar per alert() call, alert-instance lifetime, sessions)",
    },
  };
}
