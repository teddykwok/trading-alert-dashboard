import {
  NATIVE_SOURCE_TF_ORDER,
  htfPeriodStartMs,
  isDynamicLifecycle,
  replayNativeEngineWithImmediate,
  type NativeCandidate,
  type NativeEngineConfig,
  type NativeKline,
  type NativeSourceTf,
} from "@trading-alert-dashboard/shared";

import {
  ScannerDataError,
  assertScannerSymbol,
  intervalMsOf,
  type ScannerChartInterval,
  type ScannerMarketType,
} from "./binance-public-futures";
import { findKlineGaps, serializeKlines, sha256Hex } from "./kline-cache";

/**
 * Historical replay: closed klines through the approved native engine, into
 * candidate EVIDENCE for later parity work.
 *
 *   warmupStart ──── builds engine state, records nothing ────┐
 *   outputStart ──── records candidates ──────────────────────┤ one engine run
 *   end ─────────────────────────────────────────────────────┘
 *
 * The whole range is replayed as ONE sequence, so every level, arming and
 * cooldown created during warmup carries into the output window exactly as it
 * would have in a live run that started at warmupStart. Only the recording is
 * windowed.
 *
 * The output is evidence about what the ENGINE reconstructs. It says nothing
 * about what TradingView delivered; that is a platform fact the engine cannot
 * observe, and no field here claims it.
 */

/** Bumped whenever the record or manifest shape, or replay semantics, change. */
export const NATIVE_REPLAY_VERSION = "teddy-native-replay/1";
/** The engine semantics this replay drives (Slice 1 + Slice 1b). */
export const NATIVE_ENGINE_SEMANTICS = "pine-v5.5/continuous-realtime-committed+immediate-intrabar-reconstruction";
/**
 * The TEDDY_DYNAMIC_SOURCE_LEVEL_V1 engine: one forming candidate per source
 * period and colour that follows the extreme and finalizes (or is discarded)
 * at the source close; N-FULL-bar timers; an emitted Immediate alert always
 * consumes its cooldown.
 */
export const NATIVE_DYNAMIC_ENGINE_SEMANTICS = "teddy-dynamic-source-level/v1/committed+immediate-intrabar-reconstruction+full-bar-timers";
export type NativeEngineSemantics = typeof NATIVE_ENGINE_SEMANTICS | typeof NATIVE_DYNAMIC_ENGINE_SEMANTICS;

/** The engine semantics a canonical config's lifecycle implies. */
export function engineSemanticsOf(config: Pick<NativeEngineConfig, "lifecycle">): NativeEngineSemantics {
  return isDynamicLifecycle(config) ? NATIVE_DYNAMIC_ENGINE_SEMANTICS : NATIVE_ENGINE_SEMANTICS;
}
export const REPLAY_RECORD_SCHEMA = "teddy.native-replay.candidate.v1";
export const REPLAY_MANIFEST_SCHEMA = "teddy.native-replay.manifest.v1";

/**
 * How a candidate counts as evidence. Three classes, never collapsed:
 *
 *  COMMITTED_BAR_CLOSE       the confirmed-close evaluation fired.
 *  PROVEN_INTRABAR_POSSIBLE  an Immediate intrabar candidate whose OHLC proves
 *                            BOTH entry before the closing update AND the
 *                            level's presence on every update.
 *  POSSIBLE_ONLY             an Immediate intrabar candidate where either proof
 *                            is missing: possible, not established.
 */
export type ReplayEvidenceClass = "COMMITTED_BAR_CLOSE" | "PROVEN_INTRABAR_POSSIBLE" | "POSSIBLE_ONLY";

export function classifyCandidate(candidate: NativeCandidate): ReplayEvidenceClass {
  if (candidate.basis === "COMMITTED_BAR_CLOSE") return "COMMITTED_BAR_CLOSE";
  const { bandEnteredBeforeClosingUpdate, levelPresentOnEveryUpdate } = candidate.proof;
  return bandEnteredBeforeClosingUpdate && levelPresentOnEveryUpdate ? "PROVEN_INTRABAR_POSSIBLE" : "POSSIBLE_ONLY";
}

export interface HistoricalReplayRequest {
  readonly symbol: string;
  readonly marketType: ScannerMarketType;
  readonly chartInterval: ScannerChartInterval;
  /** Where engine state begins. Required: levels never expire, so this shapes everything. */
  readonly warmupStartMs: number;
  /** First chart bar whose candidates are recorded. */
  readonly outputStartMs: number;
  /** Exclusive end: the last bar opens at endMs - interval. */
  readonly endMs: number;
  readonly engine: NativeEngineConfig;
}

function invalid(message: string): never {
  throw new ScannerDataError("INVALID_RANGE", message);
}

export function assertReplayRequest(request: HistoricalReplayRequest): number {
  assertScannerSymbol(request.symbol);
  if (request.marketType !== "USDM_PERPETUAL") invalid("only USDM_PERPETUAL is supported");
  const intervalMs = intervalMsOf(request.chartInterval);
  const { warmupStartMs, outputStartMs, endMs } = request;
  for (const [name, value] of [
    ["warmupStart", warmupStartMs],
    ["outputStart", outputStartMs],
    ["end", endMs],
  ] as const) {
    if (!Number.isSafeInteger(value)) invalid(`${name} is required and must be an integer time`);
    if (value % intervalMs !== 0) invalid(`${name} must be aligned to the ${request.chartInterval} interval`);
  }
  if (!(warmupStartMs <= outputStartMs && outputStartMs < endMs)) {
    invalid("times must satisfy warmupStart <= outputStart < end");
  }
  return intervalMs;
}

const BASIS_ORDER: Readonly<Record<NativeCandidate["basis"], number>> = Object.freeze({
  // Within one bar an intrabar alert precedes the close.
  IMMEDIATE_INTRABAR: 0,
  COMMITTED_BAR_CLOSE: 1,
});

export interface ReplayCandidateRecord {
  readonly schema: typeof REPLAY_RECORD_SCHEMA;
  readonly replayVersion: string;
  readonly engineConfigSha256: string;
  readonly symbol: string;
  readonly marketType: ScannerMarketType;
  readonly chartInterval: ScannerChartInterval;
  readonly chartBarOpenTime: string;
  readonly chartBarOpenTimeMs: number;
  readonly chartBarCloseTimeMs: number;
  /** Bars since warmupStart. Depends on the warmup anchor, which the manifest records. */
  readonly chartBarIndexFromWarmup: number;
  readonly basis: NativeCandidate["basis"];
  readonly evidenceClass: ReplayEvidenceClass;
  readonly signal: NativeCandidate["signal"];
  readonly touchDirection: NativeCandidate["touchDirection"];
  readonly sourceTf: NativeSourceTf;
  readonly levelColor: NativeCandidate["levelColor"];
  readonly levelPrice: number;
  /** sourceTf:condition:createdBarOpenTimeMs — identifies a level independently of the warmup anchor. */
  readonly levelKey: string;
  readonly level: NativeCandidate["level"];
  /** Present only for IMMEDIATE_INTRABAR, verbatim from the engine. */
  readonly proof: { readonly bandEnteredBeforeClosingUpdate: boolean; readonly levelPresentOnEveryUpdate: boolean } | null;
}

export interface HistoricalReplayResult {
  readonly records: readonly ReplayCandidateRecord[];
  /** The JSONL bytes; identical input always yields identical bytes. */
  readonly jsonl: string;
  readonly outputSha256: string;
  readonly engineConfigSha256: string;
  readonly replayBars: { readonly count: number; readonly firstOpenTime: string; readonly lastOpenTime: string; readonly sha256: string };
  readonly counts: {
    readonly byBasis: Readonly<Record<NativeCandidate["basis"], number>>;
    readonly immediateByClass: { readonly PROVEN_INTRABAR_POSSIBLE: number; readonly POSSIBLE_ONLY: number };
  };
  readonly warmupExcluded: Readonly<Record<NativeCandidate["basis"], number>>;
  /** Source timeframes whose period had already begun at warmupStart: silent until their next boundary. */
  readonly incompleteAtWarmupStart: readonly NativeSourceTf[];
}

/** The canonical engine configuration, hashed so every record can name it. */
export function engineConfigSha256(engine: NativeEngineConfig): string {
  return sha256Hex(JSON.stringify(engine));
}

/**
 * The bars of [warmupStart, end), or null unless EVERY one is present.
 * The engine counts bars, so a missing bar would silently shift every count.
 */
export function selectReplayBars(
  klines: readonly NativeKline[],
  request: HistoricalReplayRequest
): NativeKline[] | null {
  const intervalMs = assertReplayRequest(request);
  const { warmupStartMs, endMs } = request;
  const bars = klines.filter((k) => k.openTimeMs >= warmupStartMs && k.openTimeMs < endMs);
  const complete =
    bars.length === (endMs - warmupStartMs) / intervalMs &&
    bars[0]?.openTimeMs === warmupStartMs &&
    findKlineGaps(bars, intervalMs).length === 0;
  return complete ? bars : null;
}

/** Replays [warmupStart, end) and records candidates from outputStart onward. */
export function runHistoricalReplay(
  klines: readonly NativeKline[],
  request: HistoricalReplayRequest
): HistoricalReplayResult {
  const intervalMs = assertReplayRequest(request);
  const { warmupStartMs, outputStartMs, endMs, engine } = request;
  const bars = selectReplayBars(klines, request);
  if (bars === null) {
    throw new ScannerDataError(
      "INVALID_RANGE",
      `replay needs every ${request.chartInterval} bar from warmupStart to end (${(endMs - warmupStartMs) / intervalMs}); the data has gaps or a late start`
    );
  }

  const result = replayNativeEngineWithImmediate(bars, engine);
  const configHash = engineConfigSha256(engine);
  const all: NativeCandidate[] = [...result.immediateCandidates, ...result.candidates];
  const warmupExcluded = { IMMEDIATE_INTRABAR: 0, COMMITTED_BAR_CLOSE: 0 };
  const kept: NativeCandidate[] = [];
  for (const candidate of all) {
    if (candidate.chartBarOpenTimeMs < outputStartMs) warmupExcluded[candidate.basis] += 1;
    else kept.push(candidate);
  }
  kept.sort(
    (a, b) =>
      a.chartBarOpenTimeMs - b.chartBarOpenTimeMs ||
      BASIS_ORDER[a.basis] - BASIS_ORDER[b.basis] ||
      a.level.id - b.level.id
  );

  const records: ReplayCandidateRecord[] = kept.map((candidate) => ({
    schema: REPLAY_RECORD_SCHEMA,
    replayVersion: NATIVE_REPLAY_VERSION,
    engineConfigSha256: configHash,
    symbol: request.symbol,
    marketType: request.marketType,
    chartInterval: request.chartInterval,
    chartBarOpenTime: new Date(candidate.chartBarOpenTimeMs).toISOString(),
    chartBarOpenTimeMs: candidate.chartBarOpenTimeMs,
    chartBarCloseTimeMs: candidate.chartBarCloseTimeMs,
    chartBarIndexFromWarmup: candidate.chartBarIndex,
    basis: candidate.basis,
    evidenceClass: classifyCandidate(candidate),
    signal: candidate.signal,
    touchDirection: candidate.touchDirection,
    sourceTf: candidate.sourceTf,
    levelColor: candidate.levelColor,
    levelPrice: candidate.levelPrice,
    levelKey: `${candidate.sourceTf}:${candidate.level.condition}:${candidate.level.createdBarOpenTimeMs}`,
    level: candidate.level,
    proof: candidate.basis === "IMMEDIATE_INTRABAR" ? { ...candidate.proof } : null,
  }));

  const jsonl = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  const counts = {
    byBasis: { IMMEDIATE_INTRABAR: 0, COMMITTED_BAR_CLOSE: 0 },
    immediateByClass: { PROVEN_INTRABAR_POSSIBLE: 0, POSSIBLE_ONLY: 0 },
  };
  for (const record of records) {
    counts.byBasis[record.basis] += 1;
    if (record.evidenceClass === "PROVEN_INTRABAR_POSSIBLE" || record.evidenceClass === "POSSIBLE_ONLY") {
      counts.immediateByClass[record.evidenceClass] += 1;
    }
  }

  return {
    records,
    jsonl,
    outputSha256: sha256Hex(jsonl),
    engineConfigSha256: configHash,
    replayBars: {
      count: bars.length,
      firstOpenTime: new Date(bars[0].openTimeMs).toISOString(),
      lastOpenTime: new Date(bars[bars.length - 1].openTimeMs).toISOString(),
      sha256: sha256Hex(serializeKlines(bars)),
    },
    counts,
    warmupExcluded,
    incompleteAtWarmupStart: NATIVE_SOURCE_TF_ORDER.filter(
      (tf) => engine.enabledSourceTfs.includes(tf) && htfPeriodStartMs(tf, warmupStartMs, engine.calendar) !== warmupStartMs
    ),
  };
}

export interface ReplayManifestMeta {
  /** Provenance only: never part of any hash. */
  readonly createdAt: string;
  readonly gitHead: string;
  readonly gitWorktreeClean: boolean;
  readonly cacheSha256: string;
  readonly cacheRowCount: number;
  readonly outputFile: string;
}

export function buildReplayManifest(
  request: HistoricalReplayRequest,
  result: HistoricalReplayResult,
  meta: ReplayManifestMeta
) {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    schema: REPLAY_MANIFEST_SCHEMA,
    replayVersion: NATIVE_REPLAY_VERSION,
    engineSemantics: NATIVE_ENGINE_SEMANTICS,
    createdAt: meta.createdAt,
    gitHead: meta.gitHead,
    gitWorktreeClean: meta.gitWorktreeClean,
    symbol: request.symbol,
    marketType: request.marketType,
    chartInterval: request.chartInterval,
    warmupStart: iso(request.warmupStartMs),
    outputStart: iso(request.outputStartMs),
    end: iso(request.endMs),
    incompleteAtWarmupStart: result.incompleteAtWarmupStart,
    engineConfig: request.engine,
    engineConfigSha256: result.engineConfigSha256,
    input: {
      cacheSha256: meta.cacheSha256,
      cacheRowCount: meta.cacheRowCount,
      replayBarCount: result.replayBars.count,
      replayFirstOpenTime: result.replayBars.firstOpenTime,
      replayLastOpenTime: result.replayBars.lastOpenTime,
      replayBarsSha256: result.replayBars.sha256,
    },
    output: {
      file: meta.outputFile,
      rowCount: result.records.length,
      sha256: result.outputSha256,
    },
    counts: result.counts,
    warmupCandidatesExcluded: result.warmupExcluded,
    evidenceNote:
      "Evidence classes describe what the engine reconstructs from closed candles. " +
      "Platform alert receipt is not observable here and is not represented.",
  };
}

export type ReplayManifest = ReturnType<typeof buildReplayManifest>;
