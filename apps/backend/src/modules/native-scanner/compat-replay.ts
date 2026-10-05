import {
  NATIVE_HISTORICAL_STATE_SEMANTICS,
  reconstructPineHistoricalState,
  stepNativeEngineWithImmediate,
  type NativeCandidate,
  type NativeEngineConfig,
  type NativeEngineState,
  type NativeKline,
  type NativePartialPeriodPolicy,
  type NativeSourceTf,
} from "@trading-alert-dashboard/shared";

import { SCANNER_MARKET_TYPE, assertScannerSymbol, intervalMsOf, type ScannerChartInterval, type ScannerMarketType } from "./binance-public-futures";
import { canonicalJson, canonicalSha256 } from "./canonical-json";
import { NATIVE_ENGINE_SEMANTICS, classifyCandidate, type ReplayEvidenceClass } from "./historical-replay";
import { findKlineGaps, serializeKlines, sha256Hex } from "./kline-cache";
import { buildScannerLineage, deriveHtfContextStartMs, type ScannerLineage } from "./scanner-lineage";

/**
 * COMPATIBILITY replay: Pine-compatible historical bootstrap up to a FIXED
 * switchover, then the approved causal engine, unchanged.
 *
 *   [htfContextStart, historyStart)  context: completes HTF candles only
 *   [historyStart, switchover)       Pine-historical reconstruction (Slice 2B-1)
 *   [switchover, end)                causal replay -> evidence records
 *
 * Every record is EVIDENCE about what the engine reconstructs. None is a
 * delivered TradingView alert and none is actionable: this path has no live
 * phase, no emitter and no Alert. Historical bootstrap touches are state
 * writes; they are counted, never written as records.
 *
 * Distinct from `scanner:replay`, which is a pure causal experiment from a
 * warmup anchor. Both exist on purpose.
 */

export const COMPAT_REPLAY_VERSION = "teddy-native-compat-replay/1";
export const COMPAT_RECORD_SCHEMA = "teddy.native-compat-replay.candidate.v1";
export const COMPAT_MANIFEST_SCHEMA = "teddy.native-compat-replay.manifest.v2";
export const COMPAT_EVIDENCE_NOTE =
  "No replay record is a delivered TradingView alert and no replay record is actionable.";

export type CompatReplayErrorCode = "INVALID_RANGE" | "INSUFFICIENT_HTF_CONTEXT" | "INCOMPLETE_DATA";

export class CompatReplayError extends Error {
  constructor(
    readonly code: CompatReplayErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CompatReplayError";
  }
}

export interface CompatReplayRequest {
  readonly symbol: string;
  readonly marketType: ScannerMarketType;
  readonly chartInterval: ScannerChartInterval;
  readonly historyStartMs: number;
  readonly switchoverMs: number;
  /** Exclusive: the last causal bar opens at endMs - interval. */
  readonly endMs: number;
  readonly engine: NativeEngineConfig;
  readonly partialPeriodPolicy: NativePartialPeriodPolicy;
  /**
   * A symbol-origin context start (scanner-lineage.ts effectiveHistoryRanges):
   * the symbol's first real bar, later than the profile's HTF context start and
   * at or before historyStart. Absent = derived from historyStart, as always.
   */
  readonly contextStartMs?: number;
}

export interface CompatReplayRanges {
  readonly intervalMs: number;
  readonly htfContextStartMs: number;
  readonly historyStartMs: number;
  readonly switchoverMs: number;
  readonly endMs: number;
  /** Bars needed in [htfContextStart, end). */
  readonly totalBars: number;
}

export function compatReplayRanges(request: CompatReplayRequest): CompatReplayRanges {
  assertScannerSymbol(request.symbol);
  if (request.marketType !== SCANNER_MARKET_TYPE) throw new CompatReplayError("INVALID_RANGE", `only ${SCANNER_MARKET_TYPE} is supported`);
  const intervalMs = intervalMsOf(request.chartInterval);
  const { historyStartMs, switchoverMs, endMs } = request;
  for (const [name, value] of [
    ["historyStart", historyStartMs],
    ["switchover", switchoverMs],
    ["end", endMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value % intervalMs !== 0) {
      throw new CompatReplayError("INVALID_RANGE", `${name} must be an integer time on a ${request.chartInterval} boundary`);
    }
  }
  if (!(historyStartMs < switchoverMs && switchoverMs < endMs)) {
    throw new CompatReplayError("INVALID_RANGE", "times must satisfy historyStart < switchover < end");
  }
  const derivedContextStartMs = deriveHtfContextStartMs(historyStartMs, request.engine.enabledSourceTfs, request.engine.calendar);
  const override = request.contextStartMs;
  if (override !== undefined && (!Number.isSafeInteger(override) || override % intervalMs !== 0 || override < derivedContextStartMs || override > historyStartMs)) {
    throw new CompatReplayError("INVALID_RANGE", "a symbol-origin context start must be a bar boundary between the HTF context start and historyStart");
  }
  const htfContextStartMs = override ?? derivedContextStartMs;
  return { intervalMs, htfContextStartMs, historyStartMs, switchoverMs, endMs, totalBars: (endMs - htfContextStartMs) / intervalMs };
}

export interface CompatReplayBars {
  readonly contextBars: NativeKline[];
  readonly historyBars: NativeKline[];
  readonly causalBars: NativeKline[];
}

/**
 * Every bar of [htfContextStart, end), split by phase — or a refusal. A missing
 * context bar is INSUFFICIENT_HTF_CONTEXT: an HTF open is never invented.
 */
export function selectCompatReplayBars(klines: readonly NativeKline[], request: CompatReplayRequest): CompatReplayBars {
  const r = compatReplayRanges(request);
  const inRange = (from: number, to: number) => klines.filter((k) => k.openTimeMs >= from && k.openTimeMs < to);
  const complete = (bars: readonly NativeKline[], from: number, to: number) =>
    bars.length === (to - from) / r.intervalMs && (bars.length === 0 || bars[0].openTimeMs === from) && findKlineGaps(bars, r.intervalMs).length === 0;

  const contextBars = inRange(r.htfContextStartMs, r.historyStartMs);
  if (!complete(contextBars, r.htfContextStartMs, r.historyStartMs)) {
    throw new CompatReplayError(
      "INSUFFICIENT_HTF_CONTEXT",
      `every bar from ${new Date(r.htfContextStartMs).toISOString()} to ${new Date(r.historyStartMs).toISOString()} is needed ` +
        "to know the real open of each enabled HTF period that contains historyStart"
    );
  }
  const historyBars = inRange(r.historyStartMs, r.switchoverMs);
  const causalBars = inRange(r.switchoverMs, r.endMs);
  if (!complete(historyBars, r.historyStartMs, r.switchoverMs) || !complete(causalBars, r.switchoverMs, r.endMs)) {
    throw new CompatReplayError("INCOMPLETE_DATA", "the data does not hold every bar from historyStart to end");
  }
  return { contextBars, historyBars, causalBars };
}

/** True when `klines` hold every bar the request needs. */
export function hasCompleteCompatRange(klines: readonly NativeKline[], request: CompatReplayRequest): boolean {
  try {
    selectCompatReplayBars(klines, request);
    return true;
  } catch (error) {
    if (error instanceof CompatReplayError && error.code !== "INVALID_RANGE") return false;
    throw error;
  }
}

/** The committed engine state's identity: SHA-256 of its canonical serialization. */
export function engineStateSha256(state: NativeEngineState): string {
  return canonicalSha256(state);
}

export type CompatReplayPhase = "CAUSAL_REPLAY";

export interface CompatReplayRecord {
  readonly schema: typeof COMPAT_RECORD_SCHEMA;
  readonly replayVersion: typeof COMPAT_REPLAY_VERSION;
  readonly lineageId: string;
  readonly phase: CompatReplayPhase;
  /** Hard-coded: nothing produced by a replay may ever be acted on. */
  readonly actionable: false;
  readonly symbol: string;
  readonly marketType: ScannerMarketType;
  readonly chartInterval: ScannerChartInterval;
  readonly chartBarOpenTime: string;
  readonly chartBarOpenTimeMs: number;
  readonly chartBarCloseTimeMs: number;
  /** Pine's bar_index: bars since historyStart (fixed by the lineage). */
  readonly chartBarIndex: number;
  readonly basis: NativeCandidate["basis"];
  readonly evidenceClass: ReplayEvidenceClass;
  readonly signal: NativeCandidate["signal"];
  readonly touchDirection: NativeCandidate["touchDirection"];
  readonly sourceTf: NativeSourceTf;
  readonly levelColor: NativeCandidate["levelColor"];
  readonly levelPrice: number;
  /** sourceTf:condition:createdBarOpenTimeMs */
  readonly levelKey: string;
  /** Whether the level was registered by the historical bootstrap or after the switchover. */
  readonly levelOrigin: "HISTORICAL_BOOTSTRAP" | "CAUSAL_REPLAY";
  readonly level: NativeCandidate["level"];
  readonly proof: { readonly bandEnteredBeforeClosingUpdate: boolean; readonly levelPresentOnEveryUpdate: boolean } | null;
}

const BASIS_ORDER: Readonly<Record<NativeCandidate["basis"], number>> = Object.freeze({
  IMMEDIATE_INTRABAR: 0,
  COMMITTED_BAR_CLOSE: 1,
});

export interface CompatReplayResult {
  readonly lineage: ScannerLineage;
  readonly lineageId: string;
  readonly ranges: CompatReplayRanges;
  readonly input: {
    readonly contextBarCount: number;
    readonly historyBarCount: number;
    readonly causalBarCount: number;
    /** [htfContextStart, switchover): immutable, part of the lineage. */
    readonly bootstrapInputSha256: string;
    /** [switchover, end): run evidence; may extend without changing the lineage. */
    readonly causalInputSha256: string;
    /** [htfContextStart, end). */
    readonly replayedInputSha256: string;
  };
  readonly bootstrap: {
    readonly semantics: typeof NATIVE_HISTORICAL_STATE_SEMANTICS;
    readonly stateSha256AtSwitchover: string;
    readonly registrationCount: number;
    readonly registrationsByTf: Readonly<Partial<Record<NativeSourceTf, number>>>;
    readonly liveLevelCount: number;
    readonly evictionCount: number;
    readonly historicalTouchWriteCount: number;
    readonly firstHistoryBarFlags: readonly { readonly sourceTf: NativeSourceTf; readonly condition: string }[];
    readonly unknownPreviousFlagEdges: readonly { readonly sourceTf: NativeSourceTf; readonly condition: string; readonly chartBarIndex: number }[];
    readonly incompletePeriods: readonly { readonly sourceTf: NativeSourceTf; readonly periodStartMs: number }[];
    readonly truncatedPeriods: readonly {
      readonly sourceTf: NativeSourceTf;
      readonly periodStartMs: number;
      readonly open: number;
      readonly high: number;
      readonly low: number;
      readonly close: number;
    }[];
  };
  readonly causal: {
    readonly engineSemantics: typeof NATIVE_ENGINE_SEMANTICS;
    readonly byBasis: Readonly<Record<NativeCandidate["basis"], number>>;
    readonly immediateByClass: { readonly PROVEN_INTRABAR_POSSIBLE: number; readonly POSSIBLE_ONLY: number };
    readonly registrationCount: number;
    readonly liveLevelCountAtEnd: number;
    readonly stateSha256AtEnd: string;
  };
  readonly records: readonly CompatReplayRecord[];
  /** Canonical JSONL; identical input always yields identical bytes. */
  readonly jsonl: string;
  readonly outputSha256: string;
}

export function runCompatibilityReplay(klines: readonly NativeKline[], request: CompatReplayRequest): CompatReplayResult {
  const ranges = compatReplayRanges(request);
  const { contextBars, historyBars, causalBars } = selectCompatReplayBars(klines, request);

  // ---- C/D. immutable bootstrap bytes -> lineage --------------------------
  const bootstrapInputSha256 = sha256Hex(serializeKlines([...contextBars, ...historyBars]));
  const { lineage, lineageId } = buildScannerLineage({
    marketType: request.marketType,
    symbol: request.symbol,
    chartInterval: request.chartInterval,
    historyStartMs: request.historyStartMs,
    compatibilitySwitchoverMs: request.switchoverMs,
    engineConfig: request.engine,
    partialPeriodPolicy: request.partialPeriodPolicy,
    bootstrapInputSha256,
  });

  // ---- E/F. Pine-compatible historical bootstrap -> state at S -------------
  const historical = reconstructPineHistoricalState({
    config: lineage.engineConfig,
    historyStartMs: request.historyStartMs,
    switchoverMs: request.switchoverMs,
    contextBars,
    bars: historyBars,
    partialPeriodPolicy: request.partialPeriodPolicy,
  });
  const stateSha256AtSwitchover = engineStateSha256(historical.state);
  const bootstrapNextLevelId = historical.state.nextLevelId;

  // ---- G. causal replay from S with the approved engine, unchanged ---------
  let state = historical.state;
  const candidates: NativeCandidate[] = [];
  let causalRegistrations = 0;
  for (const bar of causalBars) {
    const step = stepNativeEngineWithImmediate(state, bar);
    candidates.push(...step.immediateCandidates, ...step.candidates);
    causalRegistrations += step.registered.length;
    state = step.state;
  }
  candidates.sort(
    (a, b) =>
      a.chartBarOpenTimeMs - b.chartBarOpenTimeMs || BASIS_ORDER[a.basis] - BASIS_ORDER[b.basis] || a.level.id - b.level.id
  );

  // ---- H. evidence-only records --------------------------------------------
  const records: CompatReplayRecord[] = candidates.map((candidate) => ({
    schema: COMPAT_RECORD_SCHEMA,
    replayVersion: COMPAT_REPLAY_VERSION,
    lineageId,
    phase: "CAUSAL_REPLAY",
    actionable: false,
    symbol: request.symbol,
    marketType: request.marketType,
    chartInterval: request.chartInterval,
    chartBarOpenTime: new Date(candidate.chartBarOpenTimeMs).toISOString(),
    chartBarOpenTimeMs: candidate.chartBarOpenTimeMs,
    chartBarCloseTimeMs: candidate.chartBarCloseTimeMs,
    chartBarIndex: candidate.chartBarIndex,
    basis: candidate.basis,
    evidenceClass: classifyCandidate(candidate),
    signal: candidate.signal,
    touchDirection: candidate.touchDirection,
    sourceTf: candidate.sourceTf,
    levelColor: candidate.levelColor,
    levelPrice: candidate.levelPrice,
    levelKey: `${candidate.sourceTf}:${candidate.level.condition}:${candidate.level.createdBarOpenTimeMs}`,
    levelOrigin: candidate.level.id < bootstrapNextLevelId ? "HISTORICAL_BOOTSTRAP" : "CAUSAL_REPLAY",
    level: { ...candidate.level },
    proof: candidate.basis === "IMMEDIATE_INTRABAR" ? { ...candidate.proof } : null,
  }));
  const jsonl = records.map((record) => `${canonicalJson(record)}\n`).join("");

  const byBasis = { IMMEDIATE_INTRABAR: 0, COMMITTED_BAR_CLOSE: 0 };
  const immediateByClass = { PROVEN_INTRABAR_POSSIBLE: 0, POSSIBLE_ONLY: 0 };
  for (const record of records) {
    byBasis[record.basis] += 1;
    if (record.evidenceClass === "PROVEN_INTRABAR_POSSIBLE" || record.evidenceClass === "POSSIBLE_ONLY") {
      immediateByClass[record.evidenceClass] += 1;
    }
  }
  const registrationsByTf: Partial<Record<NativeSourceTf, number>> = {};
  for (const level of historical.report.registrations) registrationsByTf[level.sourceTf] = (registrationsByTf[level.sourceTf] ?? 0) + 1;

  return {
    lineage,
    lineageId,
    ranges,
    input: {
      contextBarCount: contextBars.length,
      historyBarCount: historyBars.length,
      causalBarCount: causalBars.length,
      bootstrapInputSha256,
      causalInputSha256: sha256Hex(serializeKlines(causalBars)),
      replayedInputSha256: sha256Hex(serializeKlines([...contextBars, ...historyBars, ...causalBars])),
    },
    bootstrap: {
      semantics: NATIVE_HISTORICAL_STATE_SEMANTICS,
      stateSha256AtSwitchover,
      registrationCount: historical.report.registrations.length,
      registrationsByTf,
      liveLevelCount: historical.state.levels.length,
      evictionCount: historical.report.evictions.length,
      historicalTouchWriteCount: historical.report.touches.length,
      firstHistoryBarFlags: historical.report.firstHistoryBarFlags,
      unknownPreviousFlagEdges: historical.report.unknownPreviousFlagEdges,
      incompletePeriods: historical.report.incompletePeriods,
      truncatedPeriods: historical.report.handoffPeriods
        .filter((period) => period.truncatedAtSwitchover)
        .map(({ sourceTf, periodStartMs, candle }) => ({
          sourceTf,
          periodStartMs,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        })),
    },
    causal: {
      engineSemantics: NATIVE_ENGINE_SEMANTICS,
      byBasis,
      immediateByClass,
      registrationCount: causalRegistrations,
      liveLevelCountAtEnd: state.levels.length,
      stateSha256AtEnd: engineStateSha256(state),
    },
    records,
    jsonl,
    outputSha256: sha256Hex(jsonl),
  };
}

export interface CompatReplayManifestMeta {
  /** Provenance only: never part of any hash, ID or record. */
  readonly createdAt: string;
  readonly gitHead: string;
  readonly gitWorktreeClean: boolean;
  readonly cacheSha256: string;
  readonly cacheRowCount: number;
  readonly outputFile: string;
}

export function buildCompatReplayManifest(result: CompatReplayResult, meta: CompatReplayManifestMeta) {
  const iso = (ms: number) => new Date(ms).toISOString();
  const { ranges } = result;
  return {
    schema: COMPAT_MANIFEST_SCHEMA,
    replayVersion: COMPAT_REPLAY_VERSION,
    identity: {
      lineageId: result.lineageId,
      lineage: result.lineage,
    },
    input: {
      htfContextStart: iso(ranges.htfContextStartMs),
      historyStart: iso(ranges.historyStartMs),
      compatibilitySwitchover: iso(ranges.switchoverMs),
      replayEnd: iso(ranges.endMs),
      ...result.input,
      cacheSha256: meta.cacheSha256,
      cacheRowCount: meta.cacheRowCount,
    },
    bootstrap: result.bootstrap,
    causalReplay: result.causal,
    output: {
      file: meta.outputFile,
      rowCount: result.records.length,
      sha256: result.outputSha256,
    },
    provenance: {
      createdAt: meta.createdAt,
      gitHead: meta.gitHead,
      gitWorktreeClean: meta.gitWorktreeClean,
    },
    evidenceNote: COMPAT_EVIDENCE_NOTE,
  };
}

export type CompatReplayManifest = ReturnType<typeof buildCompatReplayManifest>;
