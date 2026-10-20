import type { SourceTimeframe } from "./alert-context";
import type { ExtremeRRPlanStatus, NativeExecutionIntegrityStatus, SelectedPlanState } from "./extreme-rr";

/**
 * NATIVE_SIGNAL_QUALITY_OBSERVATORY_V1 — the read-only contract between the
 * backend's signal-quality API and the frontend observatory.
 *
 * MONITORING ONLY. Nothing here grants, implies or prepares execution
 * authority: every response says authority NONE and
 * nativeExecutionEnabled false. It observes the persisted Native alerts, their
 * frozen selected plans and PUBLIC market data after each alert.
 *
 * Three questions are kept apart and never combined into one score:
 *   ENGINE  — was the alert generated with internally consistent evidence?
 *   SIGNAL  — after triggeredAt, did price move in the alert's direction?
 *   PLAN    — given the existing selected plan, did TP or SL resolve first?
 */

export const SIGNAL_QUALITY_POLICY = "NATIVE_SIGNAL_QUALITY_OBSERVATORY_V1" as const;

/** The outcome horizons, measured from the first full minute at or after triggeredAt. */
export const SIGNAL_QUALITY_HORIZONS = [
  { key: "15m", minutes: 15 },
  { key: "1h", minutes: 60 },
  { key: "4h", minutes: 240 },
  { key: "12h", minutes: 720 },
  { key: "24h", minutes: 1440 },
] as const;
export type SignalQualityHorizonKey = (typeof SIGNAL_QUALITY_HORIZONS)[number]["key"];
export const SIGNAL_QUALITY_HORIZON_KEYS: readonly SignalQualityHorizonKey[] = SIGNAL_QUALITY_HORIZONS.map((h) => h.key);

/**
 * MATURED          every minute of the horizon is observed;
 * PARTIAL          the horizon has started but not finished at the evaluation instant (censored);
 * PENDING          not one full minute of the horizon has closed yet (censored);
 * DATA_GAP         the horizon has elapsed but some minutes are missing from the market data;
 * DATA_UNAVAILABLE no market data could be used (not loaded yet, provider failure, unsupported).
 * Only MATURED horizons enter any aggregate. Nothing incomplete is ever a zero, a win or a loss.
 */
export const SIGNAL_QUALITY_HORIZON_STATES = ["MATURED", "PARTIAL", "PENDING", "DATA_GAP", "DATA_UNAVAILABLE"] as const;
export type SignalQualityHorizonState = (typeof SIGNAL_QUALITY_HORIZON_STATES)[number];

/**
 * TP_FIRST / SL_FIRST   resolved: the first minute that touched one level touched only that one;
 * NEITHER               neither level touched in the full 24h plan window;
 * AMBIGUOUS_SAME_BAR    one minute touched both levels (or the trigger minute already did): order unknowable;
 * PLAN_UNAVAILABLE      no plan, no selected candidate, or a malformed plan geometry;
 * DATA_GAP              a missing minute before any resolution: order unknowable;
 * PENDING               no resolution yet and the 24h window has not elapsed (censored);
 * DATA_UNAVAILABLE      no market data could be used.
 * Only TP_FIRST and SL_FIRST carry realized R; only they enter win-rate and R aggregates.
 */
export const SIGNAL_QUALITY_PLAN_OUTCOMES = ["TP_FIRST", "SL_FIRST", "NEITHER", "AMBIGUOUS_SAME_BAR", "PLAN_UNAVAILABLE", "DATA_GAP", "PENDING", "DATA_UNAVAILABLE"] as const;
export type SignalQualityPlanOutcome = (typeof SIGNAL_QUALITY_PLAN_OUTCOMES)[number];

/** The plan outcome window: 24 hours from the first full minute at or after triggeredAt. */
export const SIGNAL_QUALITY_PLAN_WINDOW_MINUTES = 1440;

/** The only market-data precision V1 uses: Binance USD-M public 1-minute OHLC. Never tick-level. */
export const SIGNAL_QUALITY_PRECISION = "BINANCE_USDM_PUBLIC_1M_OHLC" as const;

/** Where the reference price came from. The canonical Native level price; never a current market price. */
export const SIGNAL_QUALITY_REFERENCE_SOURCES = ["CANONICAL_LEVEL_PRICE", "UNAVAILABLE"] as const;
export type SignalQualityReferenceSource = (typeof SIGNAL_QUALITY_REFERENCE_SOURCES)[number];

export const SIGNAL_QUALITY_MARKET_DATA_STATUSES = ["LOADED", "NOT_LOADED", "UNAVAILABLE"] as const;
export type SignalQualityMarketDataStatus = (typeof SIGNAL_QUALITY_MARKET_DATA_STATUSES)[number];

/**
 * Freshness under the M5 Native rule, judged at the instant the alert was
 * persisted (its delivery). Display only: the M5 rule itself is unchanged.
 */
export const SIGNAL_QUALITY_FRESHNESS_STATES = ["FRESH_AT_DELIVERY", "STALE_AT_DELIVERY", "TIME_UNAVAILABLE"] as const;
export type SignalQualityFreshnessState = (typeof SIGNAL_QUALITY_FRESHNESS_STATES)[number];

/** Integrity as the observatory saw it: a canonical status, or not judged within this request's bound. */
export const SIGNAL_QUALITY_INTEGRITY_FILTERS = ["ELIGIBLE", "NOT_ELIGIBLE", "NOT_JUDGED"] as const;
export type SignalQualityIntegrityFilter = (typeof SIGNAL_QUALITY_INTEGRITY_FILTERS)[number];

/**
 * Which source timeframes the Native execution POLICY names (1D, 1W) versus
 * dashboard-only ones (1M). A label, never authority: Native execution is
 * hard-disabled in code.
 */
export const SIGNAL_QUALITY_TIMEFRAME_CLASSES = ["EXECUTION_POLICY_TIMEFRAME", "DASHBOARD_ONLY_TIMEFRAME"] as const;
export type SignalQualityTimeframeClass = (typeof SIGNAL_QUALITY_TIMEFRAME_CLASSES)[number];

/** How the alert relates to the requested soak window. */
export const SIGNAL_QUALITY_SOAK_SCOPES = ["TRIGGERED_DURING_SOAK", "OBSERVED_DURING_SOAK_TRIGGERED_BEFORE_START", "OUTSIDE_SOAK", "NO_SOAK_WINDOW"] as const;
export type SignalQualitySoakScope = (typeof SIGNAL_QUALITY_SOAK_SCOPES)[number];

/** Delivery timing: persisted within SIGNAL_QUALITY_REALTIME_DELIVERY_MS of its trigger, or later (emitter backlog / recovery). */
export const SIGNAL_QUALITY_DELIVERY_TIMINGS = ["REALTIME", "DELAYED"] as const;
export type SignalQualityDeliveryTiming = (typeof SIGNAL_QUALITY_DELIVERY_TIMINGS)[number];
export const SIGNAL_QUALITY_REALTIME_DELIVERY_MS = 60_000;

export const SIGNAL_QUALITY_FLAG_CATEGORIES = ["DEFECT", "WARNING", "INFO"] as const;
export type SignalQualityFlagCategory = (typeof SIGNAL_QUALITY_FLAG_CATEGORIES)[number];

/**
 * Deterministic diagnostic flags. EXPECTED_REPEAT and SAME_LEVEL_REPEAT are
 * informational: Teddy legitimately re-arms after cooldown. Only a repeated
 * canonical identity is a SUSPICIOUS_DUPLICATE.
 */
export const SIGNAL_QUALITY_FLAGS = {
  SUSPICIOUS_DUPLICATE: "DEFECT",
  MALFORMED_PAYLOAD: "DEFECT",
  MISSING_BAR_START: "DEFECT",
  FUTURE_TIMESTAMP: "DEFECT",
  FRESHNESS_EVIDENCE_INVALID: "DEFECT",
  PLAN_MALFORMED: "DEFECT",
  INTEGRITY_NOT_ELIGIBLE: "WARNING",
  STALE_AT_DELIVERY: "WARNING",
  DELAYED_DELIVERY: "WARNING",
  TRIGGERED_BEFORE_SOAK: "WARNING",
  SYMBOL_SIDE_BURST: "WARNING",
  PLAN_UNAVAILABLE: "WARNING",
  EXPECTED_REPEAT: "INFO",
  SAME_LEVEL_REPEAT: "INFO",
} as const satisfies Record<string, SignalQualityFlagCategory>;
export type SignalQualityFlag = keyof typeof SIGNAL_QUALITY_FLAGS;
export const SIGNAL_QUALITY_FLAG_CODES = Object.keys(SIGNAL_QUALITY_FLAGS) as SignalQualityFlag[];

/** A burst: this many alerts on one symbol and side within SIGNAL_QUALITY_BURST_WINDOW_MS (observation only; nothing is throttled). */
export const SIGNAL_QUALITY_BURST_COUNT = 3;
export const SIGNAL_QUALITY_BURST_WINDOW_MS = 60 * 60_000;

/** Bounds: one request never evaluates more alerts than this, and says when the window held more. */
export const SIGNAL_QUALITY_MAX_ALERTS = 2_000;
export const SIGNAL_QUALITY_MAX_WINDOW_HOURS = 72;
export const SIGNAL_QUALITY_DEFAULT_WINDOW_HOURS = 24;
export const SIGNAL_QUALITY_PAGE_SIZES = [25, 50, 100] as const;
export const SIGNAL_QUALITY_PAGE_MAX_SIZE = 100;

export const SIGNAL_QUALITY_SORTS = ["TRIGGERED_DESC", "TRIGGERED_ASC", "SYMBOL_ASC", "R_DESC", "MFE_24H_DESC"] as const;
export type SignalQualitySort = (typeof SIGNAL_QUALITY_SORTS)[number];

export const SIGNAL_QUALITY_SCOPE_FILTERS = ["ALL", "TRIGGERED_DURING_SOAK", "OBSERVED_DURING_SOAK_TRIGGERED_BEFORE_START"] as const;
export type SignalQualityScopeFilter = (typeof SIGNAL_QUALITY_SCOPE_FILTERS)[number];

/** Every query key the signal-quality GET routes accept. Anything else is refused. */
export const SIGNAL_QUALITY_QUERY_KEYS = [
  "soakStart",
  "soakEnd",
  "scope",
  "asOf",
  "symbol",
  "sourceTimeframe",
  "direction",
  "levelColor",
  "timeframeClass",
  "integrity",
  "freshness",
  "planOutcome",
  "horizon",
  "horizonState",
  "flag",
  "sort",
  "offset",
  "pageSize",
] as const;
export type SignalQualityQueryKey = (typeof SIGNAL_QUALITY_QUERY_KEYS)[number];

// ---------------------------------------------------------------------------
// Value shapes
// ---------------------------------------------------------------------------

/** A rate with its denominator. `value` is null whenever the denominator is 0: never NaN or Infinity. */
export interface SignalQualityRate {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
}

/** Summary statistics of a finite sample. mean/median are null when n is 0. */
export interface SignalQualityStats {
  readonly n: number;
  readonly mean: number | null;
  readonly median: number | null;
}

export interface SignalQualityHorizonDto {
  readonly key: SignalQualityHorizonKey;
  readonly state: SignalQualityHorizonState;
  readonly expectedMinutes: number;
  readonly observedMinutes: number;
  readonly missingMinutes: number;
  /** Percent, relative to the reference price, signed so favourable is positive. Null unless observable. */
  readonly mfePct: number | null;
  /** Percent, relative to the reference price, signed so adverse is positive. Null unless observable. */
  readonly maePct: number | null;
  /** Signed close-to-reference return at the horizon's last observed minute (favourable positive). */
  readonly returnPct: number | null;
  readonly reason: string | null;
}

export interface SignalQualityPlanDto {
  readonly available: boolean;
  readonly state: SelectedPlanState | "NO_PLAN";
  readonly planStatus: ExtremeRRPlanStatus | null;
  readonly selectedLookback: number | null;
  readonly entry: string | null;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  /** The plan's own persisted risk:reward of the selected candidate. */
  readonly plannedRiskReward: string | null;
  readonly generatedAt: string | null;
  readonly cutoffAt: string | null;
  readonly provenance: "EXISTING_SELECTED_PLAN";
  readonly outcome: SignalQualityPlanOutcome;
  /** Realized R: only for TP_FIRST (the plan's own reward:risk) and SL_FIRST (-1). Never manufactured. */
  readonly rMultiple: number | null;
  readonly resolvedAt: string | null;
  readonly reason: string | null;
}

export interface SignalQualityFlagDto {
  readonly code: SignalQualityFlag;
  readonly category: SignalQualityFlagCategory;
  readonly detail: string;
}

export interface SignalQualityRowDto {
  readonly alertId: string;
  readonly symbol: string;
  readonly direction: "LONG" | "SHORT";
  readonly sourceTimeframe: string | null;
  readonly timeframeClass: SignalQualityTimeframeClass;
  readonly levelColor: "GREEN" | "RED" | null;
  readonly touchDirection: string | null;
  readonly levelPrice: number | null;
  readonly triggeredAt: string;
  /** When the alert row was persisted (its delivery to the dashboard). */
  readonly observedAt: string;
  readonly deliveryLagMs: number;
  readonly deliveryTiming: SignalQualityDeliveryTiming;
  readonly soakScope: SignalQualitySoakScope;
  readonly barStart: string | null;
  /** triggeredAt minus the operational bar start, as persisted. Displayed, never corrected. */
  readonly triggerOffsetInBarMs: number | null;
  readonly evidenceClass: string | null;
  readonly evidenceBasis: string | null;
  readonly deliveryKey: string | null;
  readonly levelKey: string | null;
  readonly shadowEventId: string | null;
  readonly runId: string | null;
  readonly freshness: { readonly state: SignalQualityFreshnessState; readonly expiresAt: string | null; readonly reason: string | null };
  readonly integrity: { readonly judged: boolean; readonly status: NativeExecutionIntegrityStatus | null; readonly reason: string | null };
  readonly reference: { readonly price: number | null; readonly source: SignalQualityReferenceSource };
  readonly marketData: { readonly status: SignalQualityMarketDataStatus; readonly precision: typeof SIGNAL_QUALITY_PRECISION; readonly reason: string | null };
  readonly horizons: readonly SignalQualityHorizonDto[];
  readonly plan: SignalQualityPlanDto;
  readonly flags: readonly SignalQualityFlagDto[];
}

/** Every response says this: the observatory observes and can do nothing else. */
export interface SignalQualityAuthority {
  readonly policy: typeof SIGNAL_QUALITY_POLICY;
  readonly authority: "NONE";
  readonly nativeExecutionEnabled: false;
  readonly monitoringOnly: true;
}

export interface SignalQualityWindowDto {
  readonly soakStart: string | null;
  readonly soakEnd: string | null;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly scope: SignalQualityScopeFilter;
  /** The evaluation instant: no market data after it is used. */
  readonly asOf: string;
}

export interface SignalQualitySampleDto {
  /** Alerts the window held (up to SIGNAL_QUALITY_MAX_ALERTS + 1 read). */
  readonly evaluated: number;
  readonly truncated: boolean;
  readonly limit: number;
  readonly marketData: Readonly<Record<SignalQualityMarketDataStatus, number>>;
  readonly integrityJudged: number;
  readonly integrityNotJudged: number;
}

export interface SignalQualityHorizonAggregateDto {
  readonly key: SignalQualityHorizonKey;
  readonly states: Readonly<Record<SignalQualityHorizonState, number>>;
  /** Over MATURED horizons only. */
  readonly mfePct: SignalQualityStats;
  readonly maePct: SignalQualityStats;
  readonly returnPct: SignalQualityStats;
  /** MATURED horizons whose signed return is > 0, over MATURED horizons. */
  readonly directional: SignalQualityRate;
}

export interface SignalQualityPlanAggregateDto {
  readonly outcomes: Readonly<Record<SignalQualityPlanOutcome, number>>;
  /** TP_FIRST over TP_FIRST + SL_FIRST. Ambiguous, neither, pending and gaps are excluded. */
  readonly tpBeforeSl: SignalQualityRate;
  /** Realized R over resolved (TP_FIRST/SL_FIRST) plans only. */
  readonly r: SignalQualityStats;
  /** Mean realized R per resolved plan (equal to r.mean; named for clarity). */
  readonly expectancyR: number | null;
  /** Sum of winning R over the absolute sum of losing R; null with a reason when not meaningful. */
  readonly profitFactor: { readonly value: number | null; readonly reason: "NO_RESOLVED_PLANS" | "NO_LOSSES" | null };
}

export interface SignalQualityBreakdownRowDto {
  readonly key: string;
  readonly total: number;
  readonly plan: SignalQualityPlanAggregateDto;
  readonly horizon24h: SignalQualityHorizonAggregateDto;
}

export interface SignalQualityAlertRateDto {
  readonly perHour: readonly { readonly hourStart: string; readonly alerts: number; readonly symbols: number }[];
  readonly maxInRolling15m: { readonly count: number; readonly windowStart: string | null };
  readonly topSymbols: readonly { readonly key: string; readonly count: number }[];
  readonly topSymbolSides: readonly { readonly key: string; readonly count: number }[];
  readonly repeatedLevels: readonly { readonly key: string; readonly count: number }[];
}

export interface SignalQualitySummaryDto extends SignalQualityAuthority {
  readonly window: SignalQualityWindowDto;
  readonly sample: SignalQualitySampleDto;
  readonly counts: {
    readonly total: number;
    readonly uniqueSymbols: number;
    readonly byDirection: Readonly<Record<string, number>>;
    readonly bySourceTimeframe: Readonly<Record<string, number>>;
    readonly byLevelColor: Readonly<Record<string, number>>;
    readonly byTimeframeClass: Readonly<Record<string, number>>;
    readonly byIntegrity: Readonly<Record<string, number>>;
    readonly byFreshness: Readonly<Record<string, number>>;
    readonly byEvidenceClass: Readonly<Record<string, number>>;
    readonly bySoakScope: Readonly<Record<string, number>>;
    readonly byDeliveryTiming: Readonly<Record<string, number>>;
    readonly planAvailable: number;
    readonly flags: Readonly<Record<string, number>>;
  };
  readonly horizons: readonly SignalQualityHorizonAggregateDto[];
  readonly plans: SignalQualityPlanAggregateDto;
  readonly breakdowns: {
    readonly bySourceTimeframe: readonly SignalQualityBreakdownRowDto[];
    readonly byDirection: readonly SignalQualityBreakdownRowDto[];
    readonly byLevelColor: readonly SignalQualityBreakdownRowDto[];
    readonly byTimeframeClass: readonly SignalQualityBreakdownRowDto[];
    readonly byIntegrity: readonly SignalQualityBreakdownRowDto[];
    readonly byEvidenceClass: readonly SignalQualityBreakdownRowDto[];
  };
  readonly alertRate: SignalQualityAlertRateDto;
}

export interface SignalQualityPageDto extends SignalQualityAuthority {
  readonly window: SignalQualityWindowDto;
  readonly sample: SignalQualitySampleDto;
  readonly items: readonly SignalQualityRowDto[];
  readonly pagination: { readonly offset: number; readonly pageSize: number; readonly total: number; readonly hasMore: boolean; readonly sort: SignalQualitySort };
}

export interface SignalQualityDetailDto extends SignalQualityAuthority {
  readonly asOf: string;
  readonly row: SignalQualityRowDto;
  /** The alert's own durable payload provenance (no credential exists in it). */
  readonly evidence: {
    readonly payloadSchema: string | null;
    readonly delivery: Readonly<Record<string, unknown>> | null;
    readonly profile: Readonly<Record<string, unknown>> | null;
    readonly note: string | null;
  };
  readonly freshnessWindow: {
    readonly barStart: string | null;
    readonly barClose: string | null;
    readonly postCloseExpiry: string | null;
    readonly absoluteExpiry: string | null;
    readonly expiresAt: string | null;
  };
}

export interface SignalQualityChartDto extends SignalQualityAuthority {
  readonly alertId: string;
  readonly interval: "15m";
  readonly asOf: string;
  readonly signalTime: string;
  readonly bars: readonly { readonly time: number; readonly open: number; readonly high: number; readonly low: number; readonly close: number }[];
  readonly levelPrice: number | null;
  readonly entry: number | null;
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
  readonly horizonMarks: readonly { readonly key: SignalQualityHorizonKey; readonly time: string }[];
  readonly marketData: { readonly status: SignalQualityMarketDataStatus; readonly reason: string | null };
}

export interface SignalQualitySoakHealthDto extends SignalQualityAuthority {
  readonly generatedAt: string;
  readonly scanner: {
    readonly state: string;
    readonly reason: string;
    readonly runId: string | null;
    readonly startedAt: string | null;
    readonly writtenAt: string | null;
    readonly ageSeconds: number | null;
    readonly universe: {
      readonly exchangeCandidates: number | null;
      readonly generation: number | null;
      readonly stale: boolean | null;
      readonly selected: number | null;
      readonly liveEligible: number | null;
      readonly quarantined: number | null;
      readonly recovering: number | null;
      readonly awaitingStream: number | null;
      readonly failed: number | null;
      readonly capacityExceeded: boolean | null;
    };
    readonly lastMarketDataAt: string | null;
    readonly reconnects: number | null;
    readonly backpressureEvents: number | null;
  };
  readonly emitter: {
    readonly state: "RUNNING" | "STALE" | "UNKNOWN";
    readonly reason: string;
    readonly mode: string | null;
    readonly writtenAt: string | null;
    readonly ageSeconds: number | null;
    readonly created: number | null;
    readonly queueDepth: number | null;
    readonly maxQueueDepth: number | null;
    readonly ledgerDuplicates: number | null;
    readonly symbolsTracked: number | null;
    readonly symbolsHealthy: number | null;
    readonly symbolsFailed: number | null;
  };
  readonly alerts: { readonly lastDeliveredAt: string | null; readonly lastHour: number; readonly last24h: number };
  readonly plans: Readonly<Record<ExtremeRRPlanStatus, number>>;
}

export type SignalQualityAlertDirection = "LONG" | "SHORT";
export type { SourceTimeframe as SignalQualitySourceTimeframe };
