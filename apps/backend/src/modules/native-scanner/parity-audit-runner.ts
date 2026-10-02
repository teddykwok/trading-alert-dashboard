import { createHash } from "node:crypto";
import {
  SWITCHOVER_TRUNCATED_CLOSED_BARS,
  evaluateLevelConditions,
  htfPeriodStartMs,
  snapshotNativeEngineForNextBar,
  stepNativeEngine,
  type NativeKline,
  type NativeSourceTf,
} from "@trading-alert-dashboard/shared";

import { EXCHANGE_INFO_PATH, SCANNER_MARKET_TYPE, ScannerDataError, buildPublicFuturesUrl, intervalMsOf } from "./binance-public-futures";
import { readinessOf } from "./candidate-ranker";
import { GovernedPublicTransport, fillClosedBarCache, mapBounded, type KlineCacheLike } from "./candidate-rank-runner";
import { canonicalSha256 } from "./canonical-json";
import { CompatReplayError, runCompatibilityReplay, type CompatReplayRecord } from "./compat-replay";
import { PublicRequestController, REQUEST_POLICY_LIMITS, type PublicHttpTransport } from "./kline-fetcher";
import type { LineageConfig } from "./live-shadow-cli-args";
import { prepareLiveShadowState } from "./live-shadow-session";
import {
  PARITY_AUDIT_SCHEMA,
  PARITY_NOTICE,
  buildParityReport,
  classifyTvAlert,
  nativeOnlyEvents,
  parseTvEvidence,
  type ParityScope,
  type TvAlert,
  type TvClassification,
} from "./parity-audit";
import { deriveHtfContextStartMs } from "./scanner-lineage";
import { parseExchangeInfoContracts } from "./usdm-universe";

/**
 * Orchestrates the READ-ONLY parity audit: verify the evidence file, fill the
 * public kline cache (one governed transport, as the ranker), run the
 * CANONICAL compatibility replay per symbol, classify every TradingView alert,
 * and — for alerts the replay does not explain — read the committed level's
 * gates at that bar from the canonical engine. No database, no alert, no
 * account; writes nothing but the public kline cache.
 */

export interface ParityAuditRequest {
  readonly lineage: LineageConfig;
  /** The lineage's "Minimum Price Movement (%)" as configured on TradingView, e.g. 7. */
  readonly minMovePercent: number;
  readonly evidenceText: string;
  readonly expectedEvidenceSha256: string;
  readonly symbols: readonly string[] | null;
  readonly maxSymbols: number | null;
  readonly concurrency: number;
  readonly cacheOnly: boolean;
  readonly sampleSize: number;
}

export interface ParityAuditDeps {
  readonly transport: PublicHttpTransport;
  readonly baseUrl: string;
  readonly maxTotalRequests: number;
  readonly minSpacingMs: number;
  readonly cache: KlineCacheLike;
  readonly nowMs: () => number;
  readonly nowIso: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
}

export class ParityAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParityAuditError";
  }
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const codeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface SymbolResult {
  readonly rows: TvClassification[];
  readonly records: CompatReplayRecord[];
  readonly skip: { readonly symbol: string; readonly reason: string } | null;
}

/**
 * Every price a level of `tf` could have been registered at from these
 * klines: the running high (GREEN levels register at the HTF high) or low
 * (RED, at the low) of each HTF period after every 15m close — which includes
 * each period's final value. A TradingView level price outside this set
 * cannot come from Binance's OHLC at all: a data-feed difference, not an
 * engine one.
 */
interface PriceSets {
  readonly highs: Map<number, Set<number>>;
  readonly lows: Map<number, Set<number>>;
  /** Each HTF period's FINAL candle (from the same klines), in period order. */
  readonly finals: Map<number, { open: number; high: number; low: number; close: number }>;
}

function registrablePrices(klines: readonly NativeKline[], tf: NativeSourceTf, calendar: LineageConfig["engine"]["calendar"]): PriceSets {
  // price -> the HTF period starts whose running high (or low) reached exactly that price
  const highs = new Map<number, Set<number>>();
  const lows = new Map<number, Set<number>>();
  const add = (m: Map<number, Set<number>>, price: number, start: number) => m.set(price, (m.get(price) ?? new Set<number>()).add(start));
  const finals = new Map<number, { open: number; high: number; low: number; close: number }>();
  let period = Number.NaN;
  let hi = -Infinity;
  let lo = Infinity;
  for (const k of klines) {
    const start = htfPeriodStartMs(tf, k.openTimeMs, calendar);
    if (start !== period) {
      period = start;
      hi = -Infinity;
      lo = Infinity;
    }
    hi = Math.max(hi, k.high);
    lo = Math.min(lo, k.low);
    add(highs, hi, start);
    add(lows, lo, start);
    const f = finals.get(start);
    if (f === undefined) finals.set(start, { open: k.open, high: hi, low: lo, close: k.close });
    else finals.set(start, { open: f.open, high: hi, low: lo, close: k.close });
  }
  return { highs, lows, finals };
}

/**
 * Why a Binance-derivable TradingView level may be absent natively — observations, not verdicts:
 *  RUNNING_VALUE_ONLY            the price is an intermediate (not final) period high/low: a registration-timing difference
 *  PERIOD_STARTS_AT_HISTORY_START the producing period begins at the lineage's history start (Pine's first history bar never edges)
 *  PREVIOUS_PERIOD_ALSO_QUALIFIED the previous period of the same TF qualified the same condition (the strict edge rule suppresses it)
 *  FINAL_PERIOD_DOES_NOT_QUALIFY  the producing period's final candle does not meet the condition on Binance data
 *  AFTER_SWITCHOVER              the producing period is causal (after the switchover)
 *  OTHER                          none of the above
 */
function registrationPattern(
  tv: TvAlert,
  tf: NativeSourceTf,
  periods: ReadonlySet<number>,
  finals: ReadonlyMap<number, { open: number; high: number; low: number; close: number }>,
  lineage: LineageConfig
): string {
  const starts = [...finals.keys()].sort((a, b) => a - b);
  const finalMatches = [...periods].filter((s) => {
    const f = finals.get(s);
    return f !== undefined && (tv.levelColor === "GREEN" ? f.high : f.low) === tv.levelPrice;
  });
  if (finalMatches.length === 0) return "RUNNING_VALUE_ONLY";
  const conditions = tv.levelColor === "GREEN" ? (["GOR", "GOG"] as const) : (["ROR", "ROG"] as const);
  const flagsOf = (s: number) => {
    const f = finals.get(s) as { open: number; high: number; low: number; close: number };
    return evaluateLevelConditions({ ...f, periodStartMs: s, complete: true }, lineage.engine.minMovePct);
  };
  for (const s of finalMatches.sort((a, b) => a - b)) {
    if (s >= lineage.switchoverMs) return "AFTER_SWITCHOVER";
    const flags = flagsOf(s);
    const qualifying = conditions.filter((c) => flags !== null && flags[c]);
    if (qualifying.length === 0) continue;
    if (s === htfPeriodStartMs(tf, lineage.historyStartMs, lineage.engine.calendar)) return "PERIOD_STARTS_AT_HISTORY_START";
    const i = starts.indexOf(s);
    const previous = i > 0 ? flagsOf(starts[i - 1]) : null;
    if (previous !== null && qualifying.some((c) => previous[c])) return "PREVIOUS_PERIOD_ALSO_QUALIFIED";
    return "OTHER";
  }
  return "FINAL_PERIOD_DOES_NOT_QUALIFY";
}

/** The committed gates of the oldest level matching each alert, at that alert's bar — one forward pass. */
function levelDiagnostics(klines: readonly NativeKline[], lineage: LineageConfig, symbol: string, alerts: readonly TvClassification[], tvById: ReadonlyMap<string, TvAlert>): Map<string, { diagnostic: string; text: string }> {
  const out = new Map<string, { diagnostic: string; text: string }>();
  const sorted = [...alerts].sort((a, b) => (a.barOpenTime ?? "").localeCompare(b.barOpenTime ?? ""));
  // The switchover bar has no committed causal state before it to inspect.
  for (const row of sorted.filter((r) => Date.parse(r.barOpenTime as string) <= lineage.switchoverMs)) {
    out.set(row.tvId, { diagnostic: "AT_SWITCHOVER_BAR", text: "on the switchover bar itself: no committed causal state precedes it" });
  }
  const wanted = sorted.filter((r) => Date.parse(r.barOpenTime as string) > lineage.switchoverMs);
  if (wanted.length === 0) return out;
  const intervalMs = intervalMsOf(lineage.chartInterval);
  const first = Date.parse(wanted[0].barOpenTime as string);
  let state = prepareLiveShadowState(
    klines,
    { symbol, marketType: SCANNER_MARKET_TYPE, chartInterval: lineage.chartInterval, historyStartMs: lineage.historyStartMs, switchoverMs: lineage.switchoverMs, engine: lineage.engine, partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS, expectedLineageId: null },
    first,
    null
  ).state;
  let cursor = first;
  const byOpen = new Map(klines.map((k) => [k.openTimeMs, k]));
  const priceSets = new Map<NativeSourceTf, PriceSets>();
  for (const row of wanted) {
    const target = Date.parse(row.barOpenTime as string);
    while (cursor < target) {
      const bar = byOpen.get(cursor);
      if (bar === undefined) throw new ParityAuditError(`${symbol}: no cached bar at ${new Date(cursor).toISOString()}`);
      state = stepNativeEngine(state, bar).state;
      cursor += intervalMs;
    }
    const tv = tvById.get(row.tvId) as TvAlert;
    const snap = snapshotNativeEngineForNextBar(state);
    const level = snap.levels.find((l) => l.sourceTf === tv.sourceTf && l.color === tv.levelColor && l.price === tv.levelPrice);
    if (level === undefined) {
      const tf = tv.sourceTf as NativeSourceTf;
      let sets = priceSets.get(tf);
      if (sets === undefined) {
        sets = registrablePrices(klines, tf, lineage.engine.calendar);
        priceSets.set(tf, sets);
      }
      const periods = (tv.levelColor === "GREEN" ? sets.highs : sets.lows).get(tv.levelPrice);
      if (periods === undefined) {
        out.set(row.tvId, { diagnostic: "DATA_FEED_LEVEL_NOT_IN_BINANCE_OHLC", text: `LEVEL_ABSENT; TV price is NOT any Binance ${tv.sourceTf} running ${tv.levelColor === "GREEN" ? "high" : "low"}` });
      } else {
        const spans = [...periods].some((start) => start < lineage.switchoverMs && htfPeriodStartMs(tf, lineage.switchoverMs, lineage.engine.calendar) === start);
        const list = [...periods].sort((a, b) => a - b).map((s) => new Date(s).toISOString().slice(0, 10)).join(",");
        out.set(row.tvId, {
          diagnostic: spans ? "LEVEL_ABSENT_PRICE_FROM_SWITCHOVER_PERIOD" : `LEVEL_ABSENT_PRICE_DERIVABLE:${registrationPattern(tv, tf, periods, sets.finals, lineage)}`,
          text: `LEVEL_ABSENT; TV price IS a Binance ${tv.sourceTf} running ${tv.levelColor === "GREEN" ? "high" : "low"} of period(s) ${list}${spans ? " (a period that spans the switchover)" : ""}`,
        });
      }
      continue;
    }
    const bar = byOpen.get(target);
    const { readiness, blockedBy } = readinessOf(snap, level);
    const inBand = bar !== undefined && bar.low <= level.upperBand && bar.high >= level.lowerBand;
    out.set(row.tvId, {
      diagnostic: readiness === "TRIGGER_READY" && !inBand ? "LEVEL_READY_BINANCE_BAR_MISSED_BAND" : `LEVEL_PRESENT_${readiness}`,
      text: `LEVEL_PRESENT ${readiness}${blockedBy.length > 0 ? ` (${blockedBy.join(",")})` : ""}; bar range ${inBand ? "entered" : "did NOT enter"} the band`,
    });
  }
  return out;
}

export async function runParityAudit(request: ParityAuditRequest, deps: ParityAuditDeps) {
  // ---- the evidence, verified before anything else ---------------------------
  const evidenceSha256 = sha256(request.evidenceText);
  if (evidenceSha256 !== request.expectedEvidenceSha256.toLowerCase()) {
    throw new ParityAuditError(`evidence SHA-256 ${evidenceSha256} != expected ${request.expectedEvidenceSha256}: refusing to audit unverified evidence`);
  }
  const tv = parseTvEvidence(request.evidenceText);
  const tvById = new Map(tv.map((t) => [t.id, t]));
  const { lineage } = request;
  const intervalMs = intervalMsOf(lineage.chartInterval);
  const bars = tv.flatMap((t) => (t.barOpenTimeMs === null ? [] : [t.barOpenTimeMs]));
  if (bars.length === 0) throw new ParityAuditError("the evidence holds no alert with a bar time");
  const endMs = Math.floor(Math.max(...bars) / intervalMs) * intervalMs + intervalMs;
  const scope: ParityScope = { chartInterval: lineage.chartInterval, timing: lineage.engine.timing, minMovePercent: request.minMovePercent, switchoverMs: lineage.switchoverMs, endMs };
  const contextStartMs = deriveHtfContextStartMs(lineage.historyStartMs, lineage.engine.enabledSourceTfs, lineage.engine.calendar);

  // Symbols with at least one alert the lineage could explain; everything else is classified without data.
  const inWindow = (t: TvAlert) => t.barOpenTimeMs !== null && t.barOpenTimeMs >= lineage.switchoverMs && t.barOpenTimeMs < endMs;
  let symbols = [...new Set(tv.filter(inWindow).map((t) => t.symbol))].sort(codeUnit);
  if (request.symbols !== null) {
    const unknown = request.symbols.filter((s) => !symbols.includes(s));
    if (unknown.length > 0) throw new ParityAuditError(`--symbols names symbols with no in-window TradingView alert: ${unknown.join(", ")}`);
    symbols = [...request.symbols].sort(codeUnit);
  }
  if (request.maxSymbols !== null) symbols = symbols.slice(0, request.maxSymbols);
  const audited = new Set(symbols);
  const auditedAlerts = tv.filter((t) => audited.has(t.symbol) || (request.symbols === null && request.maxSymbols === null && !inWindow(t)));
  deps.log(`evidence ${evidenceSha256} rows ${tv.length}; in-window symbols audited ${symbols.length}; replay end ${new Date(endMs).toISOString()}`);

  const governor = new GovernedPublicTransport(deps.transport, { maxTotalRequests: deps.maxTotalRequests, minSpacingMs: deps.minSpacingMs, nowMs: deps.nowMs, sleep: deps.sleep });
  const fetchDeps = {
    transport: governor.transport,
    baseUrl: deps.baseUrl,
    policy: { maxRequests: REQUEST_POLICY_LIMITS.maxRequestsCeiling, minSpacingMs: deps.minSpacingMs, maxTransientRetries: 2, transientBackoffMs: Math.max(2_000, deps.minSpacingMs) },
    nowMs: deps.nowMs,
    sleep: deps.sleep,
  };

  // Listing dates spare requests for symbols that cannot have the context; advisory, so a failure here is not fatal.
  const onboard = new Map<string, number | null>();
  if (!request.cacheOnly && symbols.length > 0) {
    try {
      const payload = await new PublicRequestController(fetchDeps).getJson(buildPublicFuturesUrl(deps.baseUrl, EXCHANGE_INFO_PATH));
      for (const c of parseExchangeInfoContracts(payload)) onboard.set(c.symbol, c.onboardDateMs);
    } catch (error) {
      if (governor.halt !== null) throw governor.halt;
      if (!(error instanceof ScannerDataError)) throw error;
      deps.log(`exchangeInfo unavailable (${error.code}); continuing without listing dates`);
    }
  }

  let processed = 0;
  const results = await mapBounded(symbols, request.concurrency, async (symbol): Promise<SymbolResult> => {
    const alerts = tv.filter((t) => t.symbol === symbol);
    const done = (r: SymbolResult) => {
      processed += 1;
      if (processed % 25 === 0 || processed === symbols.length) deps.log(`processed ${processed}/${symbols.length} (requests ${governor.requestsMade}/${governor.budget})`);
      return r;
    };
    const missing = (reason: string): SymbolResult => done({ rows: alerts.map((t) => classifyTvAlert(t, null, scope, reason)), records: [], skip: { symbol, reason } });
    const listed = onboard.get(symbol);
    if (listed !== undefined && listed !== null && listed > contextStartMs) return missing(`INSUFFICIENT_HISTORY: listed ${new Date(listed).toISOString()}, after the HTF context start`);
    const filled = await fillClosedBarCache({ symbol, chartInterval: lineage.chartInterval, contextStartMs, endMs, cache: deps.cache, fetchDeps, governor, cacheOnly: request.cacheOnly, nowIso: deps.nowIso });
    if (filled.kind === "SKIP") return missing(`${filled.reason}: ${filled.detail}`);
    let records: CompatReplayRecord[];
    try {
      const replay = runCompatibilityReplay(filled.klines, {
        symbol,
        marketType: SCANNER_MARKET_TYPE,
        chartInterval: lineage.chartInterval,
        historyStartMs: lineage.historyStartMs,
        switchoverMs: lineage.switchoverMs,
        endMs,
        engine: lineage.engine,
        partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
      });
      records = [...replay.records];
    } catch (error) {
      if (error instanceof CompatReplayError) return missing(`${error.code}: ${error.message}`);
      throw error;
    }
    const byBar = new Map<number, CompatReplayRecord[]>();
    for (const r of records) byBar.set(r.chartBarOpenTimeMs, [...(byBar.get(r.chartBarOpenTimeMs) ?? []), r]);
    let rows = alerts.map((t) => classifyTvAlert(t, byBar, scope));
    const unexplained = rows.filter((r) => ["NO_NATIVE_EXPLANATION", "BAR_MATCH_LEVEL_MISMATCH", "SOURCE_TF_MISMATCH", "DIRECTION_MISMATCH"].includes(r.category));
    if (unexplained.length > 0) {
      // Advisory only: a diagnostic failure is reported on the alert and never aborts the audit.
      let diagnostics: Map<string, { diagnostic: string; text: string }>;
      try {
        diagnostics = levelDiagnostics(filled.klines, lineage, symbol, unexplained, tvById);
      } catch (error) {
        const why = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
        diagnostics = new Map(unexplained.map((r) => [r.tvId, { diagnostic: "DIAGNOSTIC_UNAVAILABLE", text: `diagnostic unavailable (${why})` }]));
      }
      rows = rows.map((r) => {
        const d = diagnostics.get(r.tvId);
        return d === undefined ? r : { ...r, diagnostic: d.diagnostic, detail: `${r.detail}; ${d.text}` };
      });
    }
    return done({ rows, records, skip: null });
  });

  // Alerts of symbols not audited this run (only in the full run: out-of-window or unsupported) are classified without data.
  const classified = results.flatMap((r) => r.rows);
  const seen = new Set(classified.map((r) => r.tvId));
  const rest = auditedAlerts.filter((t) => !seen.has(t.id)).map((t) => classifyTvAlert(t, null, scope, "the symbol was not reconstructed in this run"));
  const rows = [...classified, ...rest].sort((a, b) => codeUnit(a.symbol, b.symbol) || (a.barOpenTime ?? "").localeCompare(b.barOpenTime ?? "") || codeUnit(a.tvId, b.tvId));
  const records = results.flatMap((r) => r.records);

  // TradingView's own per-bar multiplicity: how many alerts it delivered per (symbol, bar).
  const perBar = new Map<string, number>();
  for (const t of tv.filter((x) => audited.has(x.symbol) && inWindow(x))) perBar.set(`${t.symbol}|${t.barOpenTimeMs}`, (perBar.get(`${t.symbol}|${t.barOpenTimeMs}`) ?? 0) + 1);
  const multiplicity: Record<string, number> = {};
  for (const n of perBar.values()) multiplicity[String(n)] = (multiplicity[String(n)] ?? 0) + 1;

  const body = {
    schema: PARITY_AUDIT_SCHEMA,
    notice: PARITY_NOTICE,
    evidence: { sha256: evidenceSha256, rows: tv.length },
    lineage: {
      configSha256: canonicalSha256({ chartInterval: lineage.chartInterval, historyStartMs: lineage.historyStartMs, switchoverMs: lineage.switchoverMs, engine: lineage.engine, partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS }),
      historyStart: new Date(lineage.historyStartMs).toISOString(),
      switchover: new Date(lineage.switchoverMs).toISOString(),
      replayEnd: new Date(endMs).toISOString(),
      minMovePercent: request.minMovePercent,
    },
    method: {
      match: "exact on symbol, chart interval, chart bar (TradingView raw.barTime), source TF, colour, signal, touch direction and level price (IEEE double equality, no tolerance)",
      window: "only alerts on bars in [switchover, replay end) are assessable; earlier ones are OUTSIDE_LINEAGE_WINDOW",
      evidenceClasses: "IMMEDIATE proven, IMMEDIATE possible-only and COMMITTED bar-close are reported separately",
    },
    scope: { symbolsAudited: symbols.length, alertsClassified: rows.length },
    report: buildParityReport(rows, request.sampleSize),
    tradingViewAlertsPerSymbolBar: multiplicity,
    nativeOnly: nativeOnlyEvents(records, tv.filter((t) => audited.has(t.symbol)), lineage.switchoverMs, endMs),
    skippedSymbols: results.flatMap((r) => (r.skip === null ? [] : [r.skip])),
    requests: { made: governor.requestsMade, budget: governor.budget, minSpacingMs: deps.minSpacingMs },
  };
  // Identities that exclude only run provenance (request count, wall clock): same evidence + same cache bytes => same hashes.
  return {
    ...body,
    reportSha256: canonicalSha256(JSON.parse(JSON.stringify({ ...body, requests: null }))),
    rowsSha256: canonicalSha256(JSON.parse(JSON.stringify(rows))),
    generatedAt: deps.nowIso(),
    rows,
  };
}

export type ParityAuditResult = Awaited<ReturnType<typeof runParityAudit>>;
