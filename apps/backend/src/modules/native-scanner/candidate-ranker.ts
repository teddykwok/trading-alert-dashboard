import {
  NATIVE_SOURCE_TF_ORDER,
  type NativeEngineConfig,
  type NativeEngineDiagnosticSnapshot,
  type NativeLevelDiagnostic,
  type NativeSourceTf,
} from "@trading-alert-dashboard/shared";

import { ScannerDataError } from "./binance-public-futures";
import { canonicalSha256 } from "./canonical-json";

/**
 * READ-ONLY CANDIDATE RANKING — pure core.
 *
 * Ranks registered native levels by how close the CURRENT public price is to
 * entering their touch band, judged against the COMMITTED engine state (the
 * state after the last fully closed bar). Nothing here is a signal, an alert
 * or actionable: proximity is advisory, and a level inside its band is still
 * only as ready as Pine's 4B gates say.
 *
 * No clock, no network, no file: the runner hands everything in.
 */

export const CANDIDATE_RANK_SCHEMA = "teddy.native-scanner.candidate-rank.v1";
export const CANDIDATE_RANK_NOTICE = Object.freeze([
  "READ-ONLY CANDIDATE RANKING",
  "NOT AN ALERT",
  "NOT ACTIONABLE",
  "NO ORDER AUTHORITY",
] as const);

/** NATIVE_DELIVERY_V1's source-timeframe allowlist: the ranker's default. */
export const DEFAULT_DELIVERY_SOURCE_TFS: readonly NativeSourceTf[] = Object.freeze(["1D", "1W"] as const);

/**
 * Pine's 4B gates, in the order they are reported. Readiness is the FIRST
 * failing gate; every failing gate is listed in `blockedBy`.
 *
 *  RETEST_DISABLED     the 4B loop does not run for this config
 *  NO_PREVIOUS_CLOSE   close[1] is na (no committed bar)
 *  NOT_ARMED           the level is not armed
 *  ARMED_TOO_RECENTLY  armed, but nextBar - armedBar < minBarsAfterArming
 *  TOO_YOUNG           nextBar - createdBar < minBarsAfterCreation
 *  COOLDOWN            nextBar - lastTouch < touchCooldownBars
 *  WRONG_SIDE_NOW      the committed close[1] is not beyond the band on the
 *                      approach side (GREEN: above upperBand; RED: below lowerBand)
 *  TRIGGER_READY       every gate but `inBand` holds for the forming bar
 */
export type TriggerReadiness =
  | "TRIGGER_READY"
  | "RETEST_DISABLED"
  | "NO_PREVIOUS_CLOSE"
  | "NOT_ARMED"
  | "ARMED_TOO_RECENTLY"
  | "TOO_YOUNG"
  | "COOLDOWN"
  | "WRONG_SIDE_NOW";

export function readinessOf(
  snapshot: Pick<NativeEngineDiagnosticSnapshot, "retestEnabled" | "previousClose">,
  level: NativeLevelDiagnostic
): { readonly readiness: TriggerReadiness; readonly blockedBy: readonly TriggerReadiness[] } {
  const blockedBy: TriggerReadiness[] = [];
  if (!snapshot.retestEnabled) blockedBy.push("RETEST_DISABLED");
  if (snapshot.previousClose === null) blockedBy.push("NO_PREVIOUS_CLOSE");
  if (!level.armed) blockedBy.push("NOT_ARMED");
  else if (!level.gates.armedReady) blockedBy.push("ARMED_TOO_RECENTLY");
  if (!level.gates.oldEnough) blockedBy.push("TOO_YOUNG");
  if (!level.gates.cooledDown) blockedBy.push("COOLDOWN");
  if (snapshot.previousClose !== null && !level.gates.approachSide) blockedBy.push("WRONG_SIDE_NOW");
  return { readiness: blockedBy[0] ?? "TRIGGER_READY", blockedBy };
}

export type BandSide = "ABOVE_BAND" | "IN_BAND" | "BELOW_BAND";

export interface Proximity {
  /** |price - level| / price * 100 */
  readonly distanceToLevelPct: number;
  /** Minimum move of the current price, as % of it, that puts it inside [lowerBand, upperBand]; 0 inside. */
  readonly distanceToTouchBandPct: number;
  readonly bandSide: BandSide;
  /** The direction the current price must move to enter the band. */
  readonly requiredMove: "DOWN" | "UP" | "NONE";
  /**
   * The price is on the FAR side of the band from the level's approach side
   * (GREEN below its band, RED above it): if the committed close was on the
   * approach side, the forming bar has already passed through the band.
   */
  readonly beyondBandFromApproach: boolean;
}

/**
 * Directional distance to the touch band.
 *
 * A GREEN level is retested from ABOVE (LONG): the forming bar touches when
 * its low reaches upperBand, so from above the band the required move is DOWN
 * by (price - upperBand) / price. A RED level is retested from BELOW (SHORT):
 * the bar touches when its high reaches lowerBand, so from below the required
 * move is UP by (lowerBand - price) / price. Inside the band the distance is 0.
 * On the far side the distance is the move back to the band's near edge, and
 * `beyondBandFromApproach` says so. None of this decides readiness.
 */
export function proximityOf(price: number, level: Pick<NativeLevelDiagnostic, "price" | "upperBand" | "lowerBand" | "color">): Proximity {
  if (!(typeof price === "number" && Number.isFinite(price) && price > 0)) {
    throw new ScannerDataError("MALFORMED_RESPONSE", "the current price must be a finite price > 0");
  }
  const distanceToLevelPct = (Math.abs(price - level.price) / price) * 100;
  let bandSide: BandSide;
  let distanceToTouchBandPct: number;
  let requiredMove: Proximity["requiredMove"];
  if (price > level.upperBand) {
    bandSide = "ABOVE_BAND";
    distanceToTouchBandPct = ((price - level.upperBand) / price) * 100;
    requiredMove = "DOWN";
  } else if (price < level.lowerBand) {
    bandSide = "BELOW_BAND";
    distanceToTouchBandPct = ((level.lowerBand - price) / price) * 100;
    requiredMove = "UP";
  } else {
    bandSide = "IN_BAND";
    distanceToTouchBandPct = 0;
    requiredMove = "NONE";
  }
  const beyondBandFromApproach = level.color === "GREEN" ? bandSide === "BELOW_BAND" : bandSide === "ABOVE_BAND";
  return { distanceToLevelPct, distanceToTouchBandPct, bandSide, requiredMove, beyondBandFromApproach };
}

// ---------------------------------------------------------------------------
// Per-symbol evaluation and ranking
// ---------------------------------------------------------------------------

export interface CurrentPrice {
  readonly price: number;
  /** Binance's own timestamp for the price, when the endpoint supplies one. */
  readonly observedAtMs: number | null;
  readonly source: string;
}

export interface SymbolEvaluation {
  readonly symbol: string;
  readonly displaySymbol: string;
  readonly lineageId: string;
  readonly snapshot: NativeEngineDiagnosticSnapshot;
  readonly config: NativeEngineConfig;
}

export interface RankedCandidate {
  readonly rank: number;
  readonly symbol: string;
  readonly displaySymbol: string;
  readonly lineageId: string;
  readonly currentPrice: number;
  readonly priceObservedAtMs: number | null;
  readonly sourceTf: NativeSourceTf;
  readonly levelColor: NativeLevelDiagnostic["color"];
  readonly levelCondition: NativeLevelDiagnostic["condition"];
  readonly levelPrice: number;
  readonly levelId: number;
  /** sourceTf:condition:createdBarOpenTimeMs — the scanner's stable level key. */
  readonly levelKey: string;
  readonly expectedSignal: NativeLevelDiagnostic["retestSignal"];
  readonly touchDirection: "FROM_ABOVE" | "FROM_BELOW";
  readonly upperBand: number;
  readonly lowerBand: number;
  readonly distanceToLevelPct: number;
  readonly distanceToTouchBandPct: number;
  readonly bandSide: BandSide;
  readonly requiredMove: Proximity["requiredMove"];
  readonly beyondBandFromApproach: boolean;
  readonly triggerReadiness: TriggerReadiness;
  readonly blockedBy: readonly TriggerReadiness[];
  readonly committedPreviousClose: number | null;
  readonly diagnostics: {
    readonly nextBarIndex: number;
    readonly barsSinceCreation: number;
    readonly barsSinceArming: number | null;
    readonly barsSinceTouch: number | null;
    readonly minBarsAfterCreation: number;
    readonly minBarsAfterArming: number;
    readonly touchCooldownBars: number;
    readonly intrabarEvictionRisk: boolean;
  };
  readonly deliverableUnderNativeDeliveryV1: boolean;
  /** Hard-coded: a ranking row can never be acted on. */
  readonly actionable: false;
}

export interface RankingOptions {
  readonly deliverySourceTfs: readonly NativeSourceTf[];
  readonly includeNotReady: boolean;
  readonly top: number;
  readonly maxPerSymbol: number;
}

const TF_ORDER = new Map(NATIVE_SOURCE_TF_ORDER.map((tf, i) => [tf, i]));
const codeUnitCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every level of one symbol as a candidate row (unranked), restricted to `deliverySourceTfs`. */
export function evaluateSymbol(evaluation: SymbolEvaluation, price: CurrentPrice, deliverySourceTfs: readonly NativeSourceTf[]): Omit<RankedCandidate, "rank">[] {
  const { snapshot, config } = evaluation;
  return snapshot.levels
    .filter((level) => deliverySourceTfs.includes(level.sourceTf))
    .map((level) => {
      const { readiness, blockedBy } = readinessOf(snapshot, level);
      const proximity = proximityOf(price.price, level);
      const next = snapshot.nextBarIndex;
      return {
        symbol: evaluation.symbol,
        displaySymbol: evaluation.displaySymbol,
        lineageId: evaluation.lineageId,
        currentPrice: price.price,
        priceObservedAtMs: price.observedAtMs,
        sourceTf: level.sourceTf,
        levelColor: level.color,
        levelCondition: level.condition,
        levelPrice: level.price,
        levelId: level.id,
        levelKey: `${level.sourceTf}:${level.condition}:${level.createdBarOpenTimeMs}`,
        expectedSignal: level.retestSignal,
        touchDirection: level.retestSignal === "LONG" ? "FROM_ABOVE" : "FROM_BELOW",
        upperBand: level.upperBand,
        lowerBand: level.lowerBand,
        ...proximity,
        triggerReadiness: readiness,
        blockedBy,
        committedPreviousClose: snapshot.previousClose,
        diagnostics: {
          nextBarIndex: next,
          barsSinceCreation: next - level.createdBarIndex,
          barsSinceArming: level.armed && level.armedBarIndex >= 0 ? next - level.armedBarIndex : null,
          barsSinceTouch: level.lastTouchBarIndex >= 0 ? next - level.lastTouchBarIndex : null,
          minBarsAfterCreation: config.minBarsAfterCreation,
          minBarsAfterArming: config.minBarsAfterArming,
          touchCooldownBars: config.touchCooldownBars,
          intrabarEvictionRisk: level.intrabarEvictionRisk,
        },
        deliverableUnderNativeDeliveryV1: (DEFAULT_DELIVERY_SOURCE_TFS as readonly string[]).includes(level.sourceTf),
        actionable: false as const,
      };
    });
}

/**
 * The deterministic order:
 *   1. TRIGGER_READY first
 *   2. distanceToTouchBandPct ascending
 *   3. distanceToLevelPct ascending
 *   4. symbol (code-unit order)
 *   5. source TF in Pine's registration order (1D, 1W, 1M, ...)
 *   6. levelKey, then level id (registration ordinal)
 */
export function compareCandidates(a: Omit<RankedCandidate, "rank">, b: Omit<RankedCandidate, "rank">): number {
  const ready = Number(b.triggerReadiness === "TRIGGER_READY") - Number(a.triggerReadiness === "TRIGGER_READY");
  return (
    ready ||
    a.distanceToTouchBandPct - b.distanceToTouchBandPct ||
    a.distanceToLevelPct - b.distanceToLevelPct ||
    codeUnitCompare(a.symbol, b.symbol) ||
    (TF_ORDER.get(a.sourceTf) ?? 99) - (TF_ORDER.get(b.sourceTf) ?? 99) ||
    codeUnitCompare(a.levelKey, b.levelKey) ||
    a.levelId - b.levelId
  );
}

/** Filters (readiness, per-symbol cap), sorts and numbers. Input order never matters. */
export function rankCandidates(rows: readonly Omit<RankedCandidate, "rank">[], options: RankingOptions): RankedCandidate[] {
  const eligible = rows.filter((row) => options.includeNotReady || row.triggerReadiness === "TRIGGER_READY");
  const sorted = [...eligible].sort(compareCandidates);
  const perSymbol = new Map<string, number>();
  const kept: Omit<RankedCandidate, "rank">[] = [];
  for (const row of sorted) {
    const count = perSymbol.get(row.symbol) ?? 0;
    if (count >= options.maxPerSymbol) continue;
    perSymbol.set(row.symbol, count + 1);
    kept.push(row);
  }
  return kept.slice(0, options.top).map((row, index) => ({ rank: index + 1, ...row }));
}

// ---------------------------------------------------------------------------
// Public ticker price parsing
// ---------------------------------------------------------------------------

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;
export const TICKER_PRICE_SOURCE = "binance-usdm-public/fapi/v1/ticker/price (latest trade price; advisory only)";

/** `/fapi/v1/ticker/price` without a symbol: [{ symbol, price, time }]. Malformed rows are refused. */
export function parseTickerPrices(payload: unknown): Map<string, CurrentPrice> {
  if (!Array.isArray(payload)) throw new ScannerDataError("MALFORMED_RESPONSE", "ticker/price must be an array");
  const prices = new Map<string, CurrentPrice>();
  for (const row of payload) {
    const r = row as { symbol?: unknown; price?: unknown; time?: unknown } | null;
    if (r === null || typeof r !== "object" || typeof r.symbol !== "string" || typeof r.price !== "string" || !DECIMAL.test(r.price)) {
      throw new ScannerDataError("MALFORMED_RESPONSE", "a ticker/price row must carry a symbol and a decimal price string");
    }
    const price = Number(r.price);
    if (!Number.isFinite(price) || price <= 0) continue; // a zero price is "no price", not a level of 0
    if (prices.has(r.symbol)) throw new ScannerDataError("MALFORMED_RESPONSE", `ticker/price lists ${r.symbol} twice`);
    const time = typeof r.time === "number" && Number.isSafeInteger(r.time) ? r.time : null;
    prices.set(r.symbol, { price, observedAtMs: time, source: TICKER_PRICE_SOURCE });
  }
  return prices;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type SkipReason =
  | "INSUFFICIENT_HISTORY"
  | "INCOMPLETE_DATA"
  | "UNSUPPORTED_SYMBOL"
  | "PUBLIC_FETCH_FAILED"
  | "REQUEST_BUDGET_EXHAUSTED"
  | "CACHE_UNUSABLE"
  | "CACHE_ONLY_MISSING_DATA"
  | "REPLAY_REFUSED"
  | "PRICE_UNAVAILABLE"
  | "NO_DELIVERABLE_ACTIVE_LEVEL"
  | "NO_TRIGGER_READY_LEVEL";

export interface SkippedSymbol {
  readonly symbol: string;
  readonly reason: SkipReason;
  readonly detail: string;
}

/** The signal configuration's identity: the same inputs a scanner lineage hashes, minus per-symbol bytes. */
export function signalConfigFingerprint(config: {
  readonly marketType: string;
  readonly chartInterval: string;
  readonly historyStartMs: number;
  readonly switchoverMs: number;
  readonly engine: NativeEngineConfig;
  readonly partialPeriodPolicy: string;
}): { readonly canonical: typeof config; readonly sha256: string } {
  return { canonical: config, sha256: canonicalSha256(config) };
}

// ---------------------------------------------------------------------------
// Human output
// ---------------------------------------------------------------------------

const fmtPrice = (n: number) => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(5));

/** A compact table. Every line about candidates says what they are not. */
export function formatCandidateTable(candidates: readonly RankedCandidate[]): string[] {
  const header = ["Rank", "Symbol", "Price", "TF", "Color", "Level", "BandDist%", "LevelDist%", "Side", "Readiness"];
  const rows = candidates.map((c) => [
    String(c.rank),
    c.symbol,
    fmtPrice(c.currentPrice),
    c.sourceTf,
    c.levelColor,
    fmtPrice(c.levelPrice),
    c.distanceToTouchBandPct.toFixed(2),
    c.distanceToLevelPct.toFixed(2),
    c.bandSide,
    c.triggerReadiness,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), ...rows.map(line)];
}
