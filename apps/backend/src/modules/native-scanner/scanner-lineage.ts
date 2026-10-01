import {
  NATIVE_HISTORICAL_STATE_SEMANTICS,
  SWITCHOVER_TRUNCATED_CLOSED_BARS,
  createNativeEngineConfig,
  htfPeriodStartMs,
  type CalendarAlignment,
  type NativeEngineConfig,
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
import { NATIVE_ENGINE_SEMANTICS } from "./historical-replay";

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
/** Where the kline bytes come from: Binance USD-M public klines (last price). */
export const SCANNER_KLINE_SOURCE = "binance-usdm-public/fapi/v1/klines";

export interface ScannerLineage {
  readonly schema: typeof SCANNER_LINEAGE_SCHEMA;
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
  readonly engineSemantics: typeof NATIVE_ENGINE_SEMANTICS;
  readonly historicalStateSemantics: typeof NATIVE_HISTORICAL_STATE_SEMANTICS;
  /** The complete, canonical engine configuration, calendar included. */
  readonly engineConfig: NativeEngineConfig;
  readonly partialPeriodPolicy: NativePartialPeriodPolicy;
  /** SHA-256 of the canonical kline bytes of [htfContextStart, compatibilitySwitchover). */
  readonly bootstrapInputSha256: string;
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

export interface ScannerLineageInput {
  readonly marketType: ScannerMarketType;
  readonly symbol: string;
  readonly chartInterval: ScannerChartInterval;
  readonly historyStartMs: number;
  readonly compatibilitySwitchoverMs: number;
  readonly engineConfig: NativeEngineConfig;
  readonly partialPeriodPolicy: NativePartialPeriodPolicy;
  readonly bootstrapInputSha256: string;
}

/** Refuses anything that is not exactly a lineage: no missing, extra or malformed field. */
export function assertScannerLineage(lineage: ScannerLineage): void {
  if (lineage === null || typeof lineage !== "object") invalid("lineage must be an object");
  const keys = Object.keys(lineage).sort();
  if (canonicalJson(keys) !== canonicalJson(LINEAGE_KEYS)) {
    invalid(`lineage must have exactly the fields ${LINEAGE_KEYS.join(", ")}`);
  }
  if (lineage.schema !== SCANNER_LINEAGE_SCHEMA) invalid("unknown lineage schema");
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
  if (lineage.engineSemantics !== NATIVE_ENGINE_SEMANTICS) invalid("unknown engine semantics");
  if (lineage.historicalStateSemantics !== NATIVE_HISTORICAL_STATE_SEMANTICS) invalid("unknown historical state semantics");
  if (lineage.partialPeriodPolicy !== SWITCHOVER_TRUNCATED_CLOSED_BARS) invalid(`partialPeriodPolicy must be ${SWITCHOVER_TRUNCATED_CLOSED_BARS}`);
  if (!/^[0-9a-f]{64}$/.test(lineage.bootstrapInputSha256)) invalid("bootstrapInputSha256 must be a lowercase SHA-256 hex digest");
  const canonicalConfig = createNativeEngineConfig(lineage.engineConfig);
  if (canonicalJson(canonicalConfig) !== canonicalJson(lineage.engineConfig)) invalid("engineConfig is not in canonical form");
  const expectedContext = deriveHtfContextStartMs(lineage.historyStartMs, canonicalConfig.enabledSourceTfs, canonicalConfig.calendar);
  if (lineage.htfContextStartMs !== expectedContext) invalid("htfContextStartMs does not match the enabled timeframes and calendar");
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
  const lineage: ScannerLineage = Object.freeze({
    schema: SCANNER_LINEAGE_SCHEMA,
    marketType: input.marketType,
    symbol: input.symbol,
    chartInterval: input.chartInterval,
    historyStartMs: input.historyStartMs,
    compatibilitySwitchoverMs: input.compatibilitySwitchoverMs,
    htfContextStartMs: deriveHtfContextStartMs(input.historyStartMs, engineConfig.enabledSourceTfs, engineConfig.calendar),
    klineSource: SCANNER_KLINE_SOURCE,
    engineSemantics: NATIVE_ENGINE_SEMANTICS,
    historicalStateSemantics: NATIVE_HISTORICAL_STATE_SEMANTICS,
    engineConfig,
    partialPeriodPolicy: input.partialPeriodPolicy,
    bootstrapInputSha256: input.bootstrapInputSha256,
  });
  return { lineage, lineageId: scannerLineageId(lineage) };
}

/** A stored lineage must still hash to its stored ID; anything else is a different state lineage. */
export function verifyScannerLineage(lineage: ScannerLineage, expectedLineageId: string): void {
  const actual = scannerLineageId(lineage);
  if (actual !== expectedLineageId) {
    throw new ScannerLineageError("LINEAGE_MISMATCH", `lineage hashes to ${actual}, not ${expectedLineageId}`);
  }
}
