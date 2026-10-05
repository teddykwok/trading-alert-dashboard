import {
  NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1,
  SWITCHOVER_TRUNCATED_CLOSED_BARS,
  createNativeEngineConfig,
  historicalStateSemanticsOf,
  htfPeriodStartMs,
  type CalendarAlignment,
  type NativeEngineConfig,
  type NativeHistoricalStateSemantics,
  type NativePartialPeriodPolicy,
  type NativeSourceTf,
} from "@trading-alert-dashboard/shared";

import {
  SCANNER_MARKET_TYPE,
  assertScannerSymbol,
  intervalMsOf,
  type ScannerChartInterval,
  type ScannerMarketType,
} from "./binance-public-futures";
import { canonicalJson, canonicalSha256 } from "./canonical-json";
import { engineSemanticsOf, type NativeEngineSemantics } from "./historical-replay";

/**
 * Scanner STATE LINEAGE: everything that shapes the committed engine state at
 * the compatibility switchover — and nothing else.
 *
 * A lineage is not a process run. Its identity is the SHA-256 of its canonical
 * serialization, so the same inputs always name the same state, from any
 * machine and at any time, and a restart can never redefine which bars got
 * Pine-historical semantics. Run metadata (createdAt, gitHead, paths, the
 * replay end) is deliberately not part of it.
 *
 * The first-history-bar behaviour (PINE_V5_FIRST_HISTORY_BAR_NO_EDGE) is fixed
 * by the engine's historical semantics version, not a lineage choice.
 */

export const SCANNER_LINEAGE_SCHEMA = "teddy.native-scanner.lineage.v1";
/** A lineage whose history begins at the SYMBOL's own origin (symbolHistoryOrigin). */
export const SCANNER_LINEAGE_SCHEMA_V2 = "teddy.native-scanner.lineage.v2";
/** Where the kline bytes come from: Binance USD-M public klines (last price). */
export const SCANNER_KLINE_SOURCE = "binance-usdm-public/fapi/v1/klines";

/**
 * SYMBOL-SPECIFIC EFFECTIVE HISTORY ORIGIN (dynamic universe). A symbol's
 * history begins where its real market data begins, never before:
 *
 *   effectiveContextStart = max(profileContextStart, symbolFirstRealClosedBar)
 *   effectiveHistoryStart = max(profileHistoryStart, symbolFirstRealClosedBar)
 *   effectiveSwitchover   = max(profileSwitchover, effectiveHistoryStart + one bar)
 *
 * A symbol whose data already exists at the profile context start keeps the
 * profile's ranges exactly (kind PROFILE_CONTEXT). A later listing starts at its
 * first real closed bar (kind SYMBOL_FIRST_CLOSED_BAR): bars before it never
 * existed, so their absence is not a gap — and none is ever fabricated.
 */
export const HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1 = "SYMBOL_FIRST_CLOSED_BAR_V1" as const;
export type ScannerHistoryOrigin = typeof HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1;

export type SymbolOriginKind = "PROFILE_CONTEXT" | "SYMBOL_FIRST_CLOSED_BAR";

/** What the symbol's real public klines prove about where its history starts. */
export interface SymbolOriginInput {
  readonly kind: SymbolOriginKind;
  /** The open time of the symbol's first real closed bar; null for PROFILE_CONTEXT (data exists at the context start). */
  readonly firstClosedBarOpenTimeMs: number | null;
}

export interface SymbolHistoryOrigin extends SymbolOriginInput {
  readonly semantics: ScannerHistoryOrigin;
  readonly effectiveContextStartMs: number;
  readonly effectiveHistoryStartMs: number;
  readonly effectiveSwitchoverMs: number;
}

export interface ScannerLineage {
  readonly schema: typeof SCANNER_LINEAGE_SCHEMA | typeof SCANNER_LINEAGE_SCHEMA_V2;
  readonly marketType: ScannerMarketType;
  readonly symbol: string;
  readonly chartInterval: ScannerChartInterval;
  /** Pine's bar_index 0. */
  readonly historyStartMs: number;
  /** Open time of the first causal bar. */
  readonly compatibilitySwitchoverMs: number;
  /** First context bar: the start of the earliest enabled HTF period containing historyStart. */
  readonly htfContextStartMs: number;
  readonly klineSource: typeof SCANNER_KLINE_SOURCE;
  /** Implied by the config's lifecycle (engineSemanticsOf / historicalStateSemanticsOf), never chosen separately. */
  readonly engineSemantics: NativeEngineSemantics;
  readonly historicalStateSemantics: NativeHistoricalStateSemantics;
  /** The complete, canonical engine configuration, calendar included. */
  readonly engineConfig: NativeEngineConfig;
  readonly partialPeriodPolicy: NativePartialPeriodPolicy;
  /** SHA-256 of the canonical kline bytes of [htfContextStart, compatibilitySwitchover) — v2: of [effectiveContextStart, effectiveSwitchover). */
  readonly bootstrapInputSha256: string;
  /** v2 only: where this symbol's history really begins. The profile fields above stay the profile's. */
  readonly symbolHistoryOrigin?: SymbolHistoryOrigin;
}

const LINEAGE_KEYS: readonly string[] = Object.freeze(
  [
    "schema",
    "marketType",
    "symbol",
    "chartInterval",
    "historyStartMs",
    "compatibilitySwitchoverMs",
    "htfContextStartMs",
    "klineSource",
    "engineSemantics",
    "historicalStateSemantics",
    "engineConfig",
    "partialPeriodPolicy",
    "bootstrapInputSha256",
  ].sort()
);

const LINEAGE_KEYS_V2: readonly string[] = Object.freeze([...LINEAGE_KEYS, "symbolHistoryOrigin"].sort());
const ORIGIN_KEYS: readonly string[] = Object.freeze(
  ["semantics", "kind", "firstClosedBarOpenTimeMs", "effectiveContextStartMs", "effectiveHistoryStartMs", "effectiveSwitchoverMs"].sort()
);

export type ScannerLineageErrorCode = "INVALID_LINEAGE" | "LINEAGE_MISMATCH";

export class ScannerLineageError extends Error {
  constructor(
    readonly code: ScannerLineageErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ScannerLineageError";
  }
}

function invalid(message: string): never {
  throw new ScannerLineageError("INVALID_LINEAGE", message);
}

/**
 * The earliest start of any enabled HTF period that contains historyStart.
 * Context bars from here complete every such period's real open; without them
 * the period's projected flags are unknown and the run must refuse instead.
 */
export function deriveHtfContextStartMs(
  historyStartMs: number,
  enabledSourceTfs: readonly NativeSourceTf[],
  calendar: CalendarAlignment
): number {
  let start = historyStartMs;
  for (const tf of enabledSourceTfs) start = Math.min(start, htfPeriodStartMs(tf, historyStartMs, calendar));
  return start;
}

/**
 * The effective ranges for a symbol origin (the formula above). Refuses an
 * origin that contradicts itself: a first bar on or before the context start is
 * PROFILE_CONTEXT by definition, and every time must sit on a bar boundary.
 */
export function effectiveHistoryRanges(input: {
  readonly historyStartMs: number;
  readonly compatibilitySwitchoverMs: number;
  readonly htfContextStartMs: number;
  readonly intervalMs: number;
  readonly origin: SymbolOriginInput;
}): { readonly effectiveContextStartMs: number; readonly effectiveHistoryStartMs: number; readonly effectiveSwitchoverMs: number } {
  const { historyStartMs, compatibilitySwitchoverMs, htfContextStartMs, intervalMs, origin } = input;
  if (origin === null || typeof origin !== "object") invalid("the symbol origin must be an object");
  if (origin.kind === "PROFILE_CONTEXT") {
    if (origin.firstClosedBarOpenTimeMs !== null) invalid("a PROFILE_CONTEXT origin carries no first-bar time");
    return { effectiveContextStartMs: htfContextStartMs, effectiveHistoryStartMs: historyStartMs, effectiveSwitchoverMs: compatibilitySwitchoverMs };
  }
  if (origin.kind !== "SYMBOL_FIRST_CLOSED_BAR") invalid("unknown symbol origin kind");
  const first = origin.firstClosedBarOpenTimeMs;
  if (first === null || !Number.isSafeInteger(first) || first % intervalMs !== 0) invalid("the first closed bar must be an integer time on a bar boundary");
  if (!((first as number) > htfContextStartMs)) invalid("a first bar at or before the context start is a PROFILE_CONTEXT origin");
  const effectiveHistoryStartMs = Math.max(historyStartMs, first as number);
  return {
    effectiveContextStartMs: Math.max(htfContextStartMs, first as number),
    effectiveHistoryStartMs,
    effectiveSwitchoverMs: Math.max(compatibilitySwitchoverMs, effectiveHistoryStartMs + intervalMs),
  };
}

export interface ScannerLineageInput {
  readonly marketType: ScannerMarketType;
  readonly symbol: string;
  readonly chartInterval: ScannerChartInterval;
  readonly historyStartMs: number;
  readonly compatibilitySwitchoverMs: number;
  readonly engineConfig: NativeEngineConfig;
  readonly partialPeriodPolicy: NativePartialPeriodPolicy;
  readonly bootstrapInputSha256: string;
  /** Given only for a SYMBOL_FIRST_CLOSED_BAR_V1 engine: builds a v2 lineage carrying the symbol's origin. */
  readonly symbolOrigin?: (SymbolOriginInput & { readonly semantics: ScannerHistoryOrigin }) | null;
}

/** Refuses anything that is not exactly a lineage: no missing, extra or malformed field. */
export function assertScannerLineage(lineage: ScannerLineage): void {
  if (lineage === null || typeof lineage !== "object") invalid("lineage must be an object");
  const keys = Object.keys(lineage).sort();
  const v2 = lineage.schema === SCANNER_LINEAGE_SCHEMA_V2;
  const expectedKeys = v2 ? LINEAGE_KEYS_V2 : LINEAGE_KEYS;
  if (canonicalJson(keys) !== canonicalJson(expectedKeys)) {
    invalid(`lineage must have exactly the fields ${expectedKeys.join(", ")}`);
  }
  if (lineage.schema !== SCANNER_LINEAGE_SCHEMA && !v2) invalid("unknown lineage schema");
  if (lineage.marketType !== SCANNER_MARKET_TYPE) invalid(`marketType must be ${SCANNER_MARKET_TYPE}`);
  if (assertScannerSymbol(lineage.symbol) !== lineage.symbol) invalid("symbol is not canonical");
  const intervalMs = intervalMsOf(lineage.chartInterval);
  for (const [name, value] of [
    ["historyStartMs", lineage.historyStartMs],
    ["compatibilitySwitchoverMs", lineage.compatibilitySwitchoverMs],
    ["htfContextStartMs", lineage.htfContextStartMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value % intervalMs !== 0) invalid(`${name} must be an integer time on a ${lineage.chartInterval} boundary`);
  }
  if (!(lineage.historyStartMs < lineage.compatibilitySwitchoverMs)) invalid("historyStartMs must be before compatibilitySwitchoverMs");
  if (lineage.klineSource !== SCANNER_KLINE_SOURCE) invalid("unknown kline source");
  if (lineage.partialPeriodPolicy !== SWITCHOVER_TRUNCATED_CLOSED_BARS) invalid(`partialPeriodPolicy must be ${SWITCHOVER_TRUNCATED_CLOSED_BARS}`);
  if (!/^[0-9a-f]{64}$/.test(lineage.bootstrapInputSha256)) invalid("bootstrapInputSha256 must be a lowercase SHA-256 hex digest");
  const canonicalConfig = createNativeEngineConfig(lineage.engineConfig);
  if (canonicalJson(canonicalConfig) !== canonicalJson(lineage.engineConfig)) invalid("engineConfig is not in canonical form");
  // The semantics are a function of the config's lifecycle: a lineage can never pair one engine's
  // config with another engine's semantics.
  if (lineage.engineSemantics !== engineSemanticsOf(canonicalConfig)) invalid("unknown engine semantics");
  if (lineage.historicalStateSemantics !== historicalStateSemanticsOf(canonicalConfig)) invalid("unknown historical state semantics");
  const expectedContext = deriveHtfContextStartMs(lineage.historyStartMs, canonicalConfig.enabledSourceTfs, canonicalConfig.calendar);
  if (lineage.htfContextStartMs !== expectedContext) invalid("htfContextStartMs does not match the enabled timeframes and calendar");
  if (v2) {
    const origin = lineage.symbolHistoryOrigin as SymbolHistoryOrigin;
    if (origin === null || typeof origin !== "object" || canonicalJson(Object.keys(origin).sort()) !== canonicalJson(ORIGIN_KEYS)) {
      invalid(`symbolHistoryOrigin must have exactly the fields ${ORIGIN_KEYS.join(", ")}`);
    }
    if (origin.semantics !== HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1) invalid("unknown history origin semantics");
    // A symbol origin rests on causal history: the look-ahead (legacy) lifecycle can never carry one.
    if (canonicalConfig.lifecycle !== NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1) invalid("a symbol history origin requires the dynamic source-level lifecycle");
    const ranges = effectiveHistoryRanges({ ...lineage, intervalMs, origin });
    if (
      origin.effectiveContextStartMs !== ranges.effectiveContextStartMs ||
      origin.effectiveHistoryStartMs !== ranges.effectiveHistoryStartMs ||
      origin.effectiveSwitchoverMs !== ranges.effectiveSwitchoverMs
    ) {
      invalid("symbolHistoryOrigin's effective ranges do not follow from its origin");
    }
  }
}

/** The lineage ID: SHA-256 of the canonical serialization of the validated lineage. */
export function scannerLineageId(lineage: ScannerLineage): string {
  assertScannerLineage(lineage);
  return canonicalSha256(lineage);
}

export function buildScannerLineage(input: ScannerLineageInput): { readonly lineage: ScannerLineage; readonly lineageId: string } {
  // Canonical config: Pine's registration order is canonical whatever order the
  // caller listed timeframes in, so the hashed config is the canonical one.
  const engineConfig = createNativeEngineConfig(input.engineConfig);
  const htfContextStartMs = deriveHtfContextStartMs(input.historyStartMs, engineConfig.enabledSourceTfs, engineConfig.calendar);
  const origin = input.symbolOrigin ?? null;
  const symbolHistoryOrigin: SymbolHistoryOrigin | null =
    origin === null
      ? null
      : {
          semantics: origin.semantics,
          kind: origin.kind,
          firstClosedBarOpenTimeMs: origin.firstClosedBarOpenTimeMs,
          ...effectiveHistoryRanges({
            historyStartMs: input.historyStartMs,
            compatibilitySwitchoverMs: input.compatibilitySwitchoverMs,
            htfContextStartMs,
            intervalMs: intervalMsOf(input.chartInterval),
            origin,
          }),
        };
  const lineage: ScannerLineage = Object.freeze({
    schema: symbolHistoryOrigin === null ? SCANNER_LINEAGE_SCHEMA : SCANNER_LINEAGE_SCHEMA_V2,
    marketType: input.marketType,
    symbol: input.symbol,
    chartInterval: input.chartInterval,
    historyStartMs: input.historyStartMs,
    compatibilitySwitchoverMs: input.compatibilitySwitchoverMs,
    htfContextStartMs,
    klineSource: SCANNER_KLINE_SOURCE,
    engineSemantics: engineSemanticsOf(engineConfig),
    historicalStateSemantics: historicalStateSemanticsOf(engineConfig),
    engineConfig,
    partialPeriodPolicy: input.partialPeriodPolicy,
    bootstrapInputSha256: input.bootstrapInputSha256,
    ...(symbolHistoryOrigin === null ? {} : { symbolHistoryOrigin: Object.freeze(symbolHistoryOrigin) }),
  });
  return { lineage, lineageId: scannerLineageId(lineage) };
}

/** The open time of the lineage's first causal bar: the symbol's effective switchover (v2) or the profile's (v1). */
export const effectiveSwitchoverOf = (lineage: ScannerLineage): number => lineage.symbolHistoryOrigin?.effectiveSwitchoverMs ?? lineage.compatibilitySwitchoverMs;

/** A stored lineage must still hash to its stored ID; anything else is a different state lineage. */
export function verifyScannerLineage(lineage: ScannerLineage, expectedLineageId: string): void {
  const actual = scannerLineageId(lineage);
  if (actual !== expectedLineageId) {
    throw new ScannerLineageError("LINEAGE_MISMATCH", `lineage hashes to ${actual}, not ${expectedLineageId}`);
  }
}
