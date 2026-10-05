import path from "node:path";
import {
  NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1,
  NATIVE_SOURCE_TF_ORDER,
  NATIVE_TIMING_MODES,
  SWITCHOVER_TRUNCATED_CLOSED_BARS,
  createNativeEngineConfig,
  historicalStateSemanticsOf,
  pinePercentInputToFraction,
  type NativeLevelLifecycle,
  type NativePartialPeriodPolicy,
  type NativeSourceTf,
  type NativeTimingMode,
} from "@trading-alert-dashboard/shared";

import { SCANNER_MARKET_TYPE, intervalMsOf, type ScannerChartInterval, type ScannerMarketType } from "./binance-public-futures";
import { canonicalSha256 } from "./canonical-json";
import { engineSemanticsOf as engineSemanticsIdOf } from "./historical-replay";
import type { LineageConfig } from "./live-shadow-cli-args";
import { symbolPathSegment } from "./exchange-symbol";
import {
  HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1,
  SCANNER_KLINE_SOURCE,
  buildScannerLineage,
  deriveHtfContextStartMs,
  type ScannerHistoryOrigin,
  type ScannerLineage,
  type SymbolOriginInput,
} from "./scanner-lineage";
import { SYMBOL_TRUST_EXCHANGE_INFO_UNICODE_V1, type UniverseSymbolTrust } from "./usdm-universe";

/**
 * NATIVE SCANNER PROFILES — immutable, versioned, machine-identified.
 *
 * A profile is three policies that must never be confused with one another:
 *
 *  A. EnginePolicy     what the scanner COMPUTES. Every field changes committed
 *                      engine state, so all of them (and nothing else) form the
 *                      ENGINE FINGERPRINT, and through it the per-symbol lineage
 *                      and the on-disk state namespace.
 *  B. DeliveryPolicy   which live observations may become dashboard Alerts.
 *                      Dashboard only: never an execution permission.
 *  C. ExecutionPolicy  FUTURE execution modelling only. Native execution stays
 *                      hard-fenced in code (alerts/alert-source.ts); nothing here
 *                      is read by any plan, adoption or execution path.
 *
 * The three timeframe lists carry distinct brands, so the compiler refuses to
 * pass a delivery list where an engine list is expected (and every other mix).
 * The display label, the universe selection and the operational defaults are in
 * no fingerprint. A profile is not an account: it never names Account A or Account B.
 */

declare const ENGINE_TF: unique symbol;
declare const DELIVERY_TF: unique symbol;
declare const EXECUTION_TF: unique symbol;

/** A source timeframe the engine REGISTERS levels from (state-affecting). */
export type EngineSourceTimeframe = NativeSourceTf & { readonly [ENGINE_TF]: true };
/** A source timeframe whose live observations may be DELIVERED to the dashboard. */
export type DashboardDeliveryTimeframe = NativeSourceTf & { readonly [DELIVERY_TF]: true };
/** A source timeframe a FUTURE execution policy might allow. Not an execution permission today. */
export type FutureExecutionTimeframe = NativeSourceTf & { readonly [EXECUTION_TF]: true };

export class ScannerProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScannerProfileError";
  }
}

const refuse = (message: string): never => {
  throw new ScannerProfileError(message);
};

/** Validates a timeframe list (known, unique) and returns it in Pine's canonical order. */
function canonicalTfs(tfs: readonly string[], what: string): NativeSourceTf[] {
  if (!Array.isArray(tfs) || tfs.length === 0) refuse(`${what} must list at least one source timeframe`);
  const seen = new Set<string>();
  for (const tf of tfs) {
    if (!(NATIVE_SOURCE_TF_ORDER as readonly string[]).includes(tf)) refuse(`${what} contains an unknown timeframe: ${String(tf)}`);
    if (seen.has(tf)) refuse(`${what} lists ${tf} twice`);
    seen.add(tf);
  }
  return NATIVE_SOURCE_TF_ORDER.filter((tf) => seen.has(tf));
}

export const engineTimeframes = (...tfs: string[]) => Object.freeze(canonicalTfs(tfs, "engine source timeframes")) as readonly EngineSourceTimeframe[];
export const dashboardTimeframes = (...tfs: string[]) => Object.freeze(canonicalTfs(tfs, "dashboard delivery timeframes")) as readonly DashboardDeliveryTimeframe[];
export const futureExecutionTimeframes = (...tfs: string[]) => Object.freeze(canonicalTfs(tfs, "future execution timeframes")) as readonly FutureExecutionTimeframe[];

/** A. Everything that shapes committed engine state. */
export interface EnginePolicy {
  readonly layer: "ENGINE";
  readonly marketType: ScannerMarketType;
  readonly chartInterval: ScannerChartInterval;
  readonly historyStart: string;
  readonly switchover: string;
  /** Pine percentage points (18 means 18%). */
  readonly minMovePercent: number;
  readonly touchTolerancePercent: number;
  readonly cooldownBars: number;
  readonly minBarsAfterCreation: number;
  readonly minBarsAfterArming: number;
  readonly engineSourceTimeframes: readonly EngineSourceTimeframe[];
  readonly maxLevels: number;
  readonly timing: NativeTimingMode;
  readonly partialPeriodPolicy: NativePartialPeriodPolicy;
  /**
   * How source levels live (see NATIVE_LIFECYCLE_* in the shared engine).
   * Absent = the legacy PINE_V55_EDGE_FROZEN lifecycle, so a legacy profile's
   * engine, lineage and fingerprint are exactly what they always were.
   */
  readonly lifecycle?: NativeLevelLifecycle;
  /**
   * Where each symbol's history begins (scanner-lineage.ts). Absent = the
   * profile's fixed history for every symbol (a later listing can never hold
   * it), so every existing profile's engine and fingerprint are unchanged.
   * SYMBOL_FIRST_CLOSED_BAR_V1 = the symbol's first real closed bar when that is
   * later than the profile context start; requires the dynamic lifecycle.
   */
  readonly historyOrigin?: ScannerHistoryOrigin;
}

export const NATIVE_DELIVERY_V2_VERSION = "NATIVE_DELIVERY_V2" as const;
export type LiveEvidenceClass = "PROVEN_INTRABAR_POSSIBLE" | "POSSIBLE_ONLY";

/** B. Dashboard delivery: what may become a source=NATIVE Alert. Never an execution permission. */
export interface DeliveryPolicy {
  readonly layer: "DASHBOARD_DELIVERY";
  readonly policyVersion: typeof NATIVE_DELIVERY_V2_VERSION;
  readonly dashboardSourceTimeframes: readonly DashboardDeliveryTimeframe[];
  /** Live evidence classes delivered; each is kept distinct on the Alert, never collapsed. */
  readonly evidenceClasses: readonly LiveEvidenceClass[];
  readonly source: "NATIVE";
  readonly exchange: "BINANCE";
  readonly assetType: "CRYPTO";
  readonly provenance: "SHADOW_LIVE_ONLY";
  readonly actionable: false;
}

/** C. Future execution modelling. Read by nothing that can trade. */
export interface ExecutionPolicy {
  readonly layer: "FUTURE_EXECUTION";
  readonly futureExecutionSourceTimeframes: readonly FutureExecutionTimeframe[];
  /** Hard-coded false. Native execution is fenced in code, with no switch. */
  readonly nativeExecutionEnabled: false;
}

/** The first `targetEligible` SCANNER-ELIGIBLE symbols of the universe walk (eligible-symbol backfill). */
export interface TargetEligibleUniversePolicy {
  readonly layer: "UNIVERSE";
  readonly universe: "usdt-perpetual";
  /** Count of SCANNER-ELIGIBLE symbols (eligible-symbol backfill), not of candidates. */
  readonly targetEligible: number;
}

/**
 * EVERY scanner-eligible active symbol: the whole universe is walked and every
 * eligible candidate is accepted. There is no count: the active universe is
 * dynamic, and an ineligible candidate is skipped by reason, never silently.
 */
export interface AllActiveUniversePolicy {
  readonly layer: "UNIVERSE";
  readonly universe: "usdt-perpetual";
  readonly selection: "ALL_ACTIVE";
  readonly targetEligible: null;
  /**
   * DYNAMIC_UNIVERSE_V1: the running scanner refreshes exchangeInfo, onboards new
   * listings without a restart, stops scanning symbols that leave the universe
   * (state preserved) and resumes them if they return. Absent = the universe is
   * resolved once at start-up. Requires a SYMBOL_FIRST_CLOSED_BAR_V1 engine.
   */
  readonly lifecycle?: typeof UNIVERSE_LIFECYCLE_DYNAMIC_V1;
  /** Which exchange symbol strings are accepted (usdm-universe.ts). Absent = ASCII. */
  readonly symbolTrust?: UniverseSymbolTrust;
}

export const UNIVERSE_LIFECYCLE_DYNAMIC_V1 = "DYNAMIC_UNIVERSE_V1" as const;

export const isDynamicUniverse = (universe: UniversePolicy): universe is AllActiveUniversePolicy & { readonly lifecycle: typeof UNIVERSE_LIFECYCLE_DYNAMIC_V1 } =>
  isAllActiveUniverse(universe) && universe.lifecycle === UNIVERSE_LIFECYCLE_DYNAMIC_V1;

export type UniversePolicy = TargetEligibleUniversePolicy | AllActiveUniversePolicy;

export const isAllActiveUniverse = (universe: UniversePolicy): universe is AllActiveUniversePolicy =>
  (universe as Partial<AllActiveUniversePolicy>).selection === "ALL_ACTIVE";

/**
 * What a profile needs operationally to run as defined. Never semantic: in no
 * fingerprint, no lineage and no manifest identity, and the operator's
 * operational flags still override it. A profile without it uses the
 * supervisor's generic defaults.
 */
export interface ProfileOperations {
  /**
   * The CEILING of combined-stream connections. Only as many as the accepted
   * set needs are opened; an accepted set that does not fit is refused at
   * start-up, before any request, never truncated.
   */
  readonly maxConnections: number;
  /** A dynamic universe's exchangeInfo refresh interval (operational; default DEFAULT_UNIVERSE_REFRESH_MS). */
  readonly universeRefreshMs?: number;
}

/** Five minutes: one public exchangeInfo request (weight 1) per refresh; a listing joins within one refresh. */
export const DEFAULT_UNIVERSE_REFRESH_MS = 5 * 60_000;
export const UNIVERSE_REFRESH_LIMITS = Object.freeze({ minMs: 60_000, maxMs: 3_600_000 });

/** The supervisor's own ceiling (SUPERVISOR_LIMITS.maxConnections), restated here so profiles stay import-free of it. */
export const PROFILE_MAX_CONNECTIONS_CEILING = 32;

export interface ScannerProfile {
  /** Stable semantic identity. Never the label. */
  readonly profileId: string;
  /** The --profile name. */
  readonly cliName: string;
  /** Display only: in no fingerprint. */
  readonly label: string;
  readonly engine: EnginePolicy;
  readonly delivery: DeliveryPolicy;
  readonly execution: ExecutionPolicy;
  readonly universe: UniversePolicy;
  readonly operations?: ProfileOperations;
}

export const TEDDY_AGGRESSIVE_V1: ScannerProfile = Object.freeze({
  profileId: "TEDDY_AGGRESSIVE_V1",
  cliName: "teddy-aggressive",
  label: "Teddy Aggressive",
  engine: Object.freeze({
    layer: "ENGINE",
    marketType: SCANNER_MARKET_TYPE,
    chartInterval: "15m",
    historyStart: "2026-01-01T00:00:00Z",
    switchover: "2026-09-12T01:00:00Z",
    minMovePercent: 18,
    touchTolerancePercent: 1,
    cooldownBars: 10,
    minBarsAfterCreation: 5,
    minBarsAfterArming: 4,
    engineSourceTimeframes: engineTimeframes("1D", "1W", "1M", "3M", "6M", "12M"),
    maxLevels: 500,
    timing: "Immediate",
    partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
  }),
  delivery: Object.freeze({
    layer: "DASHBOARD_DELIVERY",
    policyVersion: NATIVE_DELIVERY_V2_VERSION,
    dashboardSourceTimeframes: dashboardTimeframes("1D", "1W", "1M"),
    evidenceClasses: Object.freeze(["PROVEN_INTRABAR_POSSIBLE", "POSSIBLE_ONLY"] as const),
    source: "NATIVE",
    exchange: "BINANCE",
    assetType: "CRYPTO",
    provenance: "SHADOW_LIVE_ONLY",
    actionable: false,
  }),
  execution: Object.freeze({
    layer: "FUTURE_EXECUTION",
    futureExecutionSourceTimeframes: futureExecutionTimeframes("1D", "1W"),
    nativeExecutionEnabled: false,
  }),
  universe: Object.freeze({ layer: "UNIVERSE", universe: "usdt-perpetual", targetEligible: 50 }),
}) as ScannerProfile;

/**
 * Teddy's 7% engine over EVERY scanner-eligible active USD-M USDT perpetual.
 * Identical to TEDDY_AGGRESSIVE_V1 in every engine setting but the minimum
 * move, and in delivery and future-execution policy; only the universe and
 * its connection ceiling differ. A separate profile: never an alias.
 */
export const TEDDY_7_ALL_ACTIVE_V1: ScannerProfile = Object.freeze({
  profileId: "TEDDY_7_ALL_ACTIVE_V1",
  cliName: "teddy-7-all-active",
  label: "Teddy 7% All Active",
  engine: Object.freeze({
    layer: "ENGINE",
    marketType: SCANNER_MARKET_TYPE,
    chartInterval: "15m",
    historyStart: "2026-01-01T00:00:00Z",
    switchover: "2026-09-12T01:00:00Z",
    minMovePercent: 7,
    touchTolerancePercent: 1,
    cooldownBars: 10,
    minBarsAfterCreation: 5,
    minBarsAfterArming: 4,
    engineSourceTimeframes: engineTimeframes("1D", "1W", "1M", "3M", "6M", "12M"),
    maxLevels: 500,
    timing: "Immediate",
    partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
    // The Teddy product rule: one dynamic candidate per source period and colour,
    // finalized at the source close; full-bar timers; causal history.
    lifecycle: NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1,
    // Each symbol's history starts at its own first real closed bar when that is later than the
    // profile context: a new listing is scanned from its real market, never rejected as too new.
    historyOrigin: HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1,
  }),
  delivery: Object.freeze({
    layer: "DASHBOARD_DELIVERY",
    policyVersion: NATIVE_DELIVERY_V2_VERSION,
    dashboardSourceTimeframes: dashboardTimeframes("1D", "1W", "1M"),
    evidenceClasses: Object.freeze(["PROVEN_INTRABAR_POSSIBLE", "POSSIBLE_ONLY"] as const),
    source: "NATIVE",
    exchange: "BINANCE",
    assetType: "CRYPTO",
    provenance: "SHADOW_LIVE_ONLY",
    actionable: false,
  }),
  execution: Object.freeze({
    layer: "FUTURE_EXECUTION",
    futureExecutionSourceTimeframes: futureExecutionTimeframes("1D", "1W"),
    nativeExecutionEnabled: false,
  }),
  universe: Object.freeze({
    layer: "UNIVERSE",
    universe: "usdt-perpetual",
    selection: "ALL_ACTIVE",
    targetEligible: null,
    lifecycle: UNIVERSE_LIFECYCLE_DYNAMIC_V1,
    symbolTrust: SYMBOL_TRUST_EXCHANGE_INFO_UNICODE_V1,
  }),
  // 16 x 50 symbols per connection = 800 symbols: room for the whole active USD-M USDT-perpetual
  // universe (about 530 active as of 2026-10) with headroom. Only the connections the running set
  // needs are opened (about 11 today); a universe larger than 800 is refused or degraded, never truncated.
  operations: Object.freeze({ maxConnections: 16, universeRefreshMs: DEFAULT_UNIVERSE_REFRESH_MS }),
}) as ScannerProfile;

/** Every profile the scanner knows, by --profile name. */
export const SCANNER_PROFILES: Readonly<Record<string, ScannerProfile>> = Object.freeze({
  [TEDDY_AGGRESSIVE_V1.cliName]: TEDDY_AGGRESSIVE_V1,
  [TEDDY_7_ALL_ACTIVE_V1.cliName]: TEDDY_7_ALL_ACTIVE_V1,
});

export function resolveScannerProfile(name: string): ScannerProfile {
  if (!Object.prototype.hasOwnProperty.call(SCANNER_PROFILES, name)) {
    refuse(`unknown profile ${JSON.stringify(name)}; known: ${Object.keys(SCANNER_PROFILES).join(", ")}`);
  }
  return assertScannerProfile(SCANNER_PROFILES[name]);
}

export function profileById(profileId: string): ScannerProfile {
  const profile = Object.values(SCANNER_PROFILES).find((p) => p.profileId === profileId);
  if (profile === undefined) refuse(`unknown profile id ${JSON.stringify(profileId)}`);
  return assertScannerProfile(profile as ScannerProfile);
}

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function utcMs(value: string, name: string): number {
  if (!UTC.test(value) || Number.isNaN(Date.parse(value))) refuse(`${name} must be a UTC instant like 2026-01-01T00:00:00Z`);
  return Date.parse(value);
}

/** Structural and cross-layer invariants of a profile. */
export function assertScannerProfile(profile: ScannerProfile): ScannerProfile {
  if (!/^[A-Z][A-Z0-9_]*_V[0-9]+$/.test(profile.profileId)) refuse("profileId must be a versioned machine identifier such as TEDDY_AGGRESSIVE_V1");
  if (profile.engine.layer !== "ENGINE" || profile.delivery.layer !== "DASHBOARD_DELIVERY" || profile.execution.layer !== "FUTURE_EXECUTION") {
    refuse("profile policies are in the wrong layers");
  }
  if ((profile.execution.nativeExecutionEnabled as boolean) !== false) refuse("a profile can never enable native execution");
  if ((profile.delivery.actionable as boolean) !== false) refuse("dashboard delivery is never actionable");
  const engineTfs = new Set<string>(profile.engine.engineSourceTimeframes);
  for (const tf of profile.delivery.dashboardSourceTimeframes) if (!engineTfs.has(tf)) refuse(`delivery timeframe ${tf} is not an engine timeframe`);
  for (const tf of profile.execution.futureExecutionSourceTimeframes) if (!engineTfs.has(tf)) refuse(`future execution timeframe ${tf} is not an engine timeframe`);
  if (isAllActiveUniverse(profile.universe)) {
    if (profile.universe.targetEligible !== null) refuse("an ALL_ACTIVE universe has no target count");
    // Every eligible symbol must fit: an all-active profile states its own connection ceiling.
    if (profile.operations === undefined) refuse("an ALL_ACTIVE profile must declare its connection ceiling (operations.maxConnections)");
    const lifecycle = profile.universe.lifecycle;
    if (lifecycle !== undefined && lifecycle !== UNIVERSE_LIFECYCLE_DYNAMIC_V1) refuse("unknown universe lifecycle");
    const trust = profile.universe.symbolTrust;
    if (trust !== undefined && trust !== "ASCII" && trust !== SYMBOL_TRUST_EXCHANGE_INFO_UNICODE_V1) refuse("unknown universe symbol trust");
    // A universe that onboards listings at any time needs histories that start at each symbol's own origin.
    if (lifecycle === UNIVERSE_LIFECYCLE_DYNAMIC_V1 && profile.engine.historyOrigin !== HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1) {
      refuse("a dynamic universe requires the SYMBOL_FIRST_CLOSED_BAR_V1 history origin");
    }
  } else {
    if ("selection" in profile.universe) refuse("unknown universe selection");
    if (!Number.isSafeInteger(profile.universe.targetEligible) || profile.universe.targetEligible < 1) refuse("the universe target must be a positive integer");
  }
  if (profile.operations !== undefined) {
    const max = profile.operations.maxConnections;
    if (!Number.isSafeInteger(max) || max < 1 || max > PROFILE_MAX_CONNECTIONS_CEILING) refuse(`operations.maxConnections must be 1..${PROFILE_MAX_CONNECTIONS_CEILING}`);
    const refresh = profile.operations.universeRefreshMs;
    if (refresh !== undefined && (!Number.isSafeInteger(refresh) || refresh < UNIVERSE_REFRESH_LIMITS.minMs || refresh > UNIVERSE_REFRESH_LIMITS.maxMs)) {
      refuse(`operations.universeRefreshMs must be ${UNIVERSE_REFRESH_LIMITS.minMs}..${UNIVERSE_REFRESH_LIMITS.maxMs}`);
    }
  }
  lineageConfigOf(profile.engine);
  return profile;
}

/**
 * The engine policy as the scanner's lineage configuration: exactly what the
 * equivalent explicit flags would parse to (same percent conversion, same
 * canonical engine config), so a profile can never build a different engine.
 */
export function lineageConfigOf(engine: EnginePolicy): LineageConfig {
  if (engine.marketType !== SCANNER_MARKET_TYPE) refuse(`marketType must be ${SCANNER_MARKET_TYPE}`);
  if (engine.partialPeriodPolicy !== SWITCHOVER_TRUNCATED_CLOSED_BARS) refuse(`partialPeriodPolicy must be ${SWITCHOVER_TRUNCATED_CLOSED_BARS}`);
  if (!(NATIVE_TIMING_MODES as readonly string[]).includes(engine.timing)) refuse(`timing must be one of: ${NATIVE_TIMING_MODES.join(", ")}`);
  const intervalMs = intervalMsOf(engine.chartInterval);
  const historyStartMs = utcMs(engine.historyStart, "historyStart");
  const switchoverMs = utcMs(engine.switchover, "switchover");
  if (historyStartMs % intervalMs !== 0 || switchoverMs % intervalMs !== 0 || !(historyStartMs < switchoverMs)) {
    refuse("historyStart and switchover must be bar boundaries with historyStart < switchover");
  }
  for (const [name, value] of [
    ["minMovePercent", engine.minMovePercent],
    ["touchTolerancePercent", engine.touchTolerancePercent],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) refuse(`${name} must be a finite number of percentage points >= 0`);
  }
  if (engine.historyOrigin !== undefined) {
    if (engine.historyOrigin !== HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1) refuse("unknown history origin");
    // A symbol origin rests on causal history; the legacy look-ahead lifecycle cannot carry one.
    if (engine.lifecycle !== NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1) refuse("the SYMBOL_FIRST_CLOSED_BAR_V1 history origin requires the dynamic source-level lifecycle");
  }
  const engineConfig = createNativeEngineConfig({
    minMovePct: pinePercentInputToFraction(engine.minMovePercent),
    touchTolerancePct: pinePercentInputToFraction(engine.touchTolerancePercent),
    touchCooldownBars: engine.cooldownBars,
    minBarsAfterCreation: engine.minBarsAfterCreation,
    minBarsAfterArming: engine.minBarsAfterArming,
    maxLevels: engine.maxLevels,
    enabledSourceTfs: canonicalTfs(engine.engineSourceTimeframes, "engine source timeframes"),
    timing: engine.timing,
    lifecycle: engine.lifecycle,
  });
  return {
    chartInterval: engine.chartInterval,
    engine: engineConfig,
    historyStartMs,
    switchoverMs,
    ...(engine.historyOrigin === undefined ? {} : { historyOrigin: engine.historyOrigin }),
  };
}

// ---------------------------------------------------------------------------
// Fingerprints: one per layer, each over exactly its own layer
// ---------------------------------------------------------------------------

export const ENGINE_FINGERPRINT_SCHEMA = "teddy.native-scanner.engine-fingerprint.v1";
export const DELIVERY_POLICY_FINGERPRINT_SCHEMA = "teddy.native-alerts.delivery-policy-fingerprint.v1";
export const EXECUTION_POLICY_FINGERPRINT_SCHEMA = "teddy.native-alerts.execution-policy-fingerprint.v1";

/**
 * The engine-semantic part of a lineage: every lineage field EXCEPT the
 * per-symbol ones (symbol, bootstrap bytes). Two symbols of one engine share it;
 * any state-affecting change (min move, tolerance, cooldown, bar gates, source
 * timeframes, max levels, timing, calendar, history start, switchover, partial
 * period policy, interval, market, engine/state semantics, kline source) changes it.
 */
function engineSemanticsOf(
  lineage: Omit<ScannerLineage, "schema" | "symbol" | "bootstrapInputSha256" | "symbolHistoryOrigin">,
  historyOrigin: ScannerHistoryOrigin | null
) {
  return {
    schema: ENGINE_FINGERPRINT_SCHEMA,
    marketType: lineage.marketType,
    chartInterval: lineage.chartInterval,
    historyStartMs: lineage.historyStartMs,
    compatibilitySwitchoverMs: lineage.compatibilitySwitchoverMs,
    htfContextStartMs: lineage.htfContextStartMs,
    klineSource: lineage.klineSource,
    engineSemantics: lineage.engineSemantics,
    historicalStateSemantics: lineage.historicalStateSemantics,
    engineConfig: lineage.engineConfig,
    partialPeriodPolicy: lineage.partialPeriodPolicy,
    // Only an engine with a symbol history origin carries the key, so every existing fingerprint is unchanged.
    ...(historyOrigin === null ? {} : { historyOrigin }),
  };
}

/** The engine fingerprint of a lineage configuration (what every symbol's lineage will share). */
export function engineFingerprintOfConfig(config: LineageConfig, marketType: ScannerMarketType = SCANNER_MARKET_TYPE): string {
  const engineConfig = createNativeEngineConfig(config.engine);
  return canonicalSha256(
    engineSemanticsOf({
      marketType,
      chartInterval: config.chartInterval,
      historyStartMs: config.historyStartMs,
      compatibilitySwitchoverMs: config.switchoverMs,
      htfContextStartMs: deriveHtfContextStartMs(config.historyStartMs, engineConfig.enabledSourceTfs, engineConfig.calendar),
      klineSource: SCANNER_KLINE_SOURCE,
      engineSemantics: engineSemanticsIdOf(engineConfig),
      historicalStateSemantics: historicalStateSemanticsOf(engineConfig),
      engineConfig,
      partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
    }, config.historyOrigin ?? null)
  );
}

/** The engine fingerprint a built lineage belongs to. */
export function engineFingerprintOfLineage(lineage: ScannerLineage): string {
  return canonicalSha256(engineSemanticsOf(lineage, lineage.symbolHistoryOrigin?.semantics ?? null));
}

export const engineFingerprintOf = (profile: ScannerProfile) => engineFingerprintOfConfig(lineageConfigOf(profile.engine), profile.engine.marketType);

export function deliveryPolicyFingerprintOf(delivery: DeliveryPolicy): string {
  return canonicalSha256({
    schema: DELIVERY_POLICY_FINGERPRINT_SCHEMA,
    policyVersion: delivery.policyVersion,
    dashboardSourceTimeframes: [...delivery.dashboardSourceTimeframes],
    evidenceClasses: [...delivery.evidenceClasses].sort(),
    source: delivery.source,
    exchange: delivery.exchange,
    assetType: delivery.assetType,
    provenance: delivery.provenance,
    actionable: delivery.actionable,
  });
}

export function executionPolicyFingerprintOf(execution: ExecutionPolicy): string {
  return canonicalSha256({
    schema: EXECUTION_POLICY_FINGERPRINT_SCHEMA,
    futureExecutionSourceTimeframes: [...execution.futureExecutionSourceTimeframes],
    nativeExecutionEnabled: execution.nativeExecutionEnabled,
  });
}

/**
 * The lineage a profile builds for one symbol from its bootstrap bytes' hash —
 * and, for a SYMBOL_FIRST_CLOSED_BAR_V1 engine, the symbol's origin (required
 * there, refused elsewhere: a lineage can never mix the two models).
 */
export function profileLineageIdFor(profile: ScannerProfile, symbol: string, bootstrapInputSha256: string, origin: SymbolOriginInput | null = null): string {
  const config = lineageConfigOf(profile.engine);
  if ((config.historyOrigin === undefined) !== (origin === null)) {
    refuse(config.historyOrigin === undefined ? "this profile's engine has no symbol history origin" : "this profile's engine needs the symbol's history origin");
  }
  return buildScannerLineage({
    marketType: profile.engine.marketType,
    symbol,
    chartInterval: config.chartInterval,
    historyStartMs: config.historyStartMs,
    compatibilitySwitchoverMs: config.switchoverMs,
    engineConfig: config.engine,
    partialPeriodPolicy: profile.engine.partialPeriodPolicy,
    bootstrapInputSha256,
    symbolOrigin: origin === null || config.historyOrigin === undefined ? null : { semantics: config.historyOrigin, kind: origin.kind, firstClosedBarOpenTimeMs: origin.firstClosedBarOpenTimeMs },
  }).lineageId;
}

/** What status, manifests and evidence show about a profile. Observational; no account. */
export interface ProfileSummary {
  readonly profileId: string;
  readonly profileLabel: string;
  readonly engineFingerprint: string;
  readonly deliveryPolicyFingerprint: string;
  readonly executionPolicyFingerprint: string;
  readonly engine: {
    readonly chartInterval: string;
    readonly historyStart: string;
    readonly switchover: string;
    readonly minMovePercent: number;
    readonly touchTolerancePercent: number;
    readonly cooldownBars: number;
    readonly minBarsAfterCreation: number;
    readonly minBarsAfterArming: number;
    readonly engineSourceTimeframes: readonly string[];
    readonly maxLevels: number;
    readonly timing: string;
    readonly partialPeriodPolicy: string;
    /** Present only for a non-legacy lifecycle, so a legacy profile's summary is unchanged. */
    readonly lifecycle?: NativeLevelLifecycle;
    /** Present only for a symbol history origin. */
    readonly historyOrigin?: ScannerHistoryOrigin;
  };
  readonly delivery: { readonly policyVersion: string; readonly dashboardSourceTimeframes: readonly string[]; readonly evidenceClasses: readonly string[] };
  readonly execution: { readonly futureExecutionSourceTimeframes: readonly string[]; readonly nativeExecutionEnabled: false; readonly notice: string };
  /** A target profile: { universe, targetEligible: N }. An all-active profile: { universe, selection: "ALL_ACTIVE", targetEligible: null } (+ lifecycle / symbolTrust when dynamic). */
  readonly universe: {
    readonly universe: string;
    readonly targetEligible: number | null;
    readonly selection?: "ALL_ACTIVE";
    readonly lifecycle?: typeof UNIVERSE_LIFECYCLE_DYNAMIC_V1;
    readonly symbolTrust?: UniverseSymbolTrust;
  };
}

export const FUTURE_EXECUTION_NOTICE = "Future execution policy only. Native execution is NOT enabled: it is hard-disabled in code for every source timeframe.";

export function profileSummaryOf(profile: ScannerProfile): ProfileSummary {
  assertScannerProfile(profile);
  const e = profile.engine;
  return {
    profileId: profile.profileId,
    profileLabel: profile.label,
    engineFingerprint: engineFingerprintOf(profile),
    deliveryPolicyFingerprint: deliveryPolicyFingerprintOf(profile.delivery),
    executionPolicyFingerprint: executionPolicyFingerprintOf(profile.execution),
    engine: {
      chartInterval: e.chartInterval,
      historyStart: e.historyStart,
      switchover: e.switchover,
      minMovePercent: e.minMovePercent,
      touchTolerancePercent: e.touchTolerancePercent,
      cooldownBars: e.cooldownBars,
      minBarsAfterCreation: e.minBarsAfterCreation,
      minBarsAfterArming: e.minBarsAfterArming,
      engineSourceTimeframes: [...e.engineSourceTimeframes],
      maxLevels: e.maxLevels,
      timing: e.timing,
      partialPeriodPolicy: e.partialPeriodPolicy,
      ...(e.lifecycle === NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1 ? { lifecycle: e.lifecycle } : {}),
      ...(e.historyOrigin === undefined ? {} : { historyOrigin: e.historyOrigin }),
    },
    delivery: {
      policyVersion: profile.delivery.policyVersion,
      dashboardSourceTimeframes: [...profile.delivery.dashboardSourceTimeframes],
      evidenceClasses: [...profile.delivery.evidenceClasses],
    },
    execution: {
      futureExecutionSourceTimeframes: [...profile.execution.futureExecutionSourceTimeframes],
      nativeExecutionEnabled: false,
      notice: FUTURE_EXECUTION_NOTICE,
    },
    universe: isAllActiveUniverse(profile.universe)
      ? {
          universe: profile.universe.universe,
          selection: "ALL_ACTIVE",
          targetEligible: null,
          ...(profile.universe.lifecycle === undefined ? {} : { lifecycle: profile.universe.lifecycle }),
          ...(profile.universe.symbolTrust === undefined ? {} : { symbolTrust: profile.universe.symbolTrust }),
        }
      : { universe: profile.universe.universe, targetEligible: profile.universe.targetEligible },
  };
}

// ---------------------------------------------------------------------------
// On-disk state namespace
// ---------------------------------------------------------------------------

/** Hex chars of the engine fingerprint used in directory names; the full value is verified from ENGINE.json. */
export const ENGINE_NAMESPACE_PREFIX_CHARS = 24;
export const ENGINE_NAMESPACE_MANIFEST = "ENGINE.json";
export const ENGINE_NAMESPACE_SCHEMA = "teddy.native-scanner.engine-namespace.v1";

/**
 * live-shadow-engines/<fingerprint prefix>: one tree per engine fingerprint.
 * Engine-incompatible states therefore coexist and never share a checkpoint,
 * an event log or a lock. The legacy live-shadow/<market>/<symbol>/<interval>
 * tree (the existing 7% corpus) is a different directory and is never touched
 * by a profile run.
 */
export function engineNamespaceDir(scannerRoot: string, engineFingerprint: string): string {
  if (!/^[0-9a-f]{64}$/.test(engineFingerprint)) refuse("the engine fingerprint must be a SHA-256 hex digest");
  return path.join(scannerRoot, "live-shadow-engines", engineFingerprint.slice(0, ENGINE_NAMESPACE_PREFIX_CHARS));
}

/** A profile symbol's live-shadow directory inside its engine namespace. */
export function liveShadowEngineDir(scannerRoot: string, engineFingerprint: string, marketType: string, symbol: string, interval: string): string {
  // The symbol as a path-safe segment: an ASCII symbol is itself; anything else is "u-<utf8 hex>".
  return path.join(engineNamespaceDir(scannerRoot, engineFingerprint), marketType, symbolPathSegment(symbol), interval);
}

export interface EngineNamespaceManifest {
  readonly schema: typeof ENGINE_NAMESPACE_SCHEMA;
  readonly engineFingerprint: string;
  readonly profileId: string;
  readonly engine: ProfileSummary["engine"];
}

export function engineNamespaceManifestOf(profile: ScannerProfile): EngineNamespaceManifest {
  const summary = profileSummaryOf(profile);
  return { schema: ENGINE_NAMESPACE_SCHEMA, engineFingerprint: summary.engineFingerprint, profileId: profile.profileId, engine: summary.engine };
}

/**
 * An existing namespace manifest must name exactly this engine fingerprint;
 * a prefix collision (or a hand-edited file) is refused, never shared.
 */
export function assertEngineNamespace(existingText: string | null, expectedFingerprint: string): void {
  if (existingText === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(existingText);
  } catch {
    refuse("the engine namespace manifest is not JSON");
  }
  const manifest = parsed as Partial<EngineNamespaceManifest>;
  if (manifest.schema !== ENGINE_NAMESPACE_SCHEMA) refuse("the engine namespace manifest has an unknown schema");
  if (manifest.engineFingerprint !== expectedFingerprint) {
    refuse(`the engine namespace belongs to engine ${String(manifest.engineFingerprint)}, not ${expectedFingerprint}: refusing to share state`);
  }
}
