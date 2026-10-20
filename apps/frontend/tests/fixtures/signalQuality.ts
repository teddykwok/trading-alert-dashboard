import {
  SIGNAL_QUALITY_HORIZONS,
  SIGNAL_QUALITY_POLICY,
  SIGNAL_QUALITY_PRECISION,
  type SignalQualityDetailDto,
  type SignalQualityHorizonAggregateDto,
  type SignalQualityHorizonState,
  type SignalQualityPageDto,
  type SignalQualityPlanAggregateDto,
  type SignalQualityPlanOutcome,
  type SignalQualityRowDto,
  type SignalQualitySoakHealthDto,
  type SignalQualitySummaryDto,
} from "@trading-alert-dashboard/shared";

/** Hand-made observatory DTOs: every number chosen by the test. */

const AUTHORITY = { policy: SIGNAL_QUALITY_POLICY, authority: "NONE", nativeExecutionEnabled: false, monitoringOnly: true } as const;
const WINDOW = { soakStart: null, soakEnd: null, windowStart: "2026-10-20T00:00:00.000Z", windowEnd: "2026-10-21T00:00:00.000Z", scope: "ALL" as const, asOf: "2026-10-21T00:00:00.000Z" };
const SAMPLE = { evaluated: 2, truncated: false, limit: 2000, marketData: { LOADED: 1, NOT_LOADED: 0, UNAVAILABLE: 1 }, integrityJudged: 2, integrityNotJudged: 0 };

export const UNICODE_SYMBOL = "币安人生USDT";
export const LONG_SYMBOL = "A".repeat(36) + "USDT";

export function rowFixture(over: Partial<SignalQualityRowDto> & { states?: SignalQualityHorizonState[]; outcome?: SignalQualityPlanOutcome } = {}): SignalQualityRowDto {
  const states = over.states ?? ["MATURED", "MATURED", "PARTIAL", "PENDING", "PENDING"];
  return {
    alertId: "cmalert0000000000000000001",
    symbol: "BTCUSDT",
    direction: "LONG",
    sourceTimeframe: "1D",
    timeframeClass: "EXECUTION_POLICY_TIMEFRAME",
    levelColor: "GREEN",
    touchDirection: "FROM_ABOVE",
    levelPrice: 64000.5,
    triggeredAt: "2026-10-20T12:16:01.234Z",
    observedAt: "2026-10-20T12:16:03.000Z",
    deliveryLagMs: 1766,
    deliveryTiming: "REALTIME",
    soakScope: "NO_SOAK_WINDOW",
    barStart: "2026-10-20T12:15:00.000Z",
    triggerOffsetInBarMs: 61234,
    evidenceClass: "PROVEN_INTRABAR_POSSIBLE",
    evidenceBasis: "IMMEDIATE_INTRABAR",
    deliveryKey: "k".repeat(64),
    levelKey: "level-1",
    shadowEventId: "e".repeat(64),
    runId: "20261020T000000Z-abcd1234",
    freshness: { state: "FRESH_AT_DELIVERY", expiresAt: "2026-10-20T12:35:00.000Z", reason: null },
    integrity: { judged: true, status: "ELIGIBLE", reason: "clean" },
    reference: { price: 64000.5, source: "CANONICAL_LEVEL_PRICE" },
    marketData: { status: "LOADED", precision: SIGNAL_QUALITY_PRECISION, reason: null },
    horizons: SIGNAL_QUALITY_HORIZONS.map((h, i) => ({
      key: h.key,
      state: states[i],
      expectedMinutes: h.minutes,
      observedMinutes: states[i] === "MATURED" ? h.minutes : 10,
      missingMinutes: states[i] === "DATA_GAP" ? 2 : 0,
      mfePct: states[i] === "MATURED" || states[i] === "PARTIAL" ? 1.25 : null,
      maePct: states[i] === "MATURED" || states[i] === "PARTIAL" ? 0.5 : null,
      returnPct: states[i] === "MATURED" || states[i] === "PARTIAL" ? 0.75 : null,
      reason: states[i] === "PARTIAL" ? "10 of 240 minutes have closed" : null,
    })),
    plan: {
      available: true,
      state: "SELECTED",
      planStatus: "READY",
      selectedLookback: 100,
      entry: "64000.5",
      stopLoss: "63500",
      takeProfit: "65500",
      plannedRiskReward: "3",
      generatedAt: "2026-10-20T12:16:04.000Z",
      cutoffAt: "2026-10-20T12:16:01.234Z",
      provenance: "EXISTING_SELECTED_PLAN",
      outcome: over.outcome ?? "TP_FIRST",
      rMultiple: (over.outcome ?? "TP_FIRST") === "TP_FIRST" ? 3 : (over.outcome ?? "TP_FIRST") === "SL_FIRST" ? -1 : null,
      resolvedAt: null,
      reason: null,
    },
    flags: [],
    ...over,
  };
}

const horizonAgg = (key: SignalQualityHorizonAggregateDto["key"]): SignalQualityHorizonAggregateDto => ({
  key,
  states: { MATURED: 1, PARTIAL: 0, PENDING: 1, DATA_GAP: 0, DATA_UNAVAILABLE: 0 },
  mfePct: { n: 1, mean: 1.25, median: 1.25 },
  maePct: { n: 1, mean: 0.5, median: 0.5 },
  returnPct: { n: 1, mean: 0.75, median: 0.75 },
  directional: { numerator: 1, denominator: 1, value: 1 },
});

const planAgg: SignalQualityPlanAggregateDto = {
  outcomes: { TP_FIRST: 7, SL_FIRST: 12, NEITHER: 2, AMBIGUOUS_SAME_BAR: 1, PLAN_UNAVAILABLE: 0, DATA_GAP: 0, PENDING: 3, DATA_UNAVAILABLE: 0 },
  tpBeforeSl: { numerator: 7, denominator: 19, value: 7 / 19 },
  r: { n: 19, mean: 0.47, median: -1 },
  expectancyR: 0.47,
  profitFactor: { value: 1.75, reason: null },
};

export function summaryFixture(over: Partial<SignalQualitySummaryDto> = {}): SignalQualitySummaryDto {
  return {
    ...AUTHORITY,
    window: WINDOW,
    sample: SAMPLE,
    counts: {
      total: 25,
      uniqueSymbols: 18,
      byDirection: { LONG: 14, SHORT: 11 },
      bySourceTimeframe: { "1D": 15, "1M": 4, "1W": 6 },
      byLevelColor: { GREEN: 13, RED: 12 },
      byTimeframeClass: { DASHBOARD_ONLY_TIMEFRAME: 4, EXECUTION_POLICY_TIMEFRAME: 21 },
      byIntegrity: { ELIGIBLE: 22, PENDING_BAR_CLOSE: 3 },
      byFreshness: { FRESH_AT_DELIVERY: 25 },
      byEvidenceClass: { PROVEN_INTRABAR_POSSIBLE: 20, POSSIBLE_ONLY: 5 },
      bySoakScope: { NO_SOAK_WINDOW: 25 },
      byDeliveryTiming: { REALTIME: 25 },
      planAvailable: 25,
      flags: { EXPECTED_REPEAT: 3 },
    },
    horizons: SIGNAL_QUALITY_HORIZONS.map((h) => horizonAgg(h.key)),
    plans: planAgg,
    breakdowns: { bySourceTimeframe: [{ key: "1D", total: 15, plan: planAgg, horizon24h: horizonAgg("24h") }], byDirection: [], byLevelColor: [], byTimeframeClass: [], byIntegrity: [], byEvidenceClass: [] },
    alertRate: { perHour: [{ hourStart: "2026-10-20T12:00:00.000Z", alerts: 4, symbols: 3 }], maxInRolling15m: { count: 3, windowStart: "2026-10-20T12:01:00.000Z" }, topSymbols: [], topSymbolSides: [], repeatedLevels: [] },
    ...over,
  };
}

export function pageFixture(items: SignalQualityRowDto[]): SignalQualityPageDto {
  return { ...AUTHORITY, window: WINDOW, sample: SAMPLE, items, pagination: { offset: 0, pageSize: 50, total: items.length, hasMore: false, sort: "TRIGGERED_DESC" } };
}

export function detailFixture(row: SignalQualityRowDto = rowFixture()): SignalQualityDetailDto {
  return {
    ...AUTHORITY,
    asOf: "2026-10-21T00:00:00.000Z",
    row,
    evidence: { payloadSchema: "teddy.native-alerts.alert-payload.v2", delivery: { barStart: row.barStart, deliveryKey: row.deliveryKey }, profile: { profileId: "TEDDY_7_ALL_ACTIVE_V1" }, note: "eventType=LEVEL_TOUCHED" },
    freshnessWindow: { barStart: row.barStart, barClose: "2026-10-20T12:30:00.000Z", postCloseExpiry: "2026-10-20T12:35:00.000Z", absoluteExpiry: "2026-10-20T12:36:01.234Z", expiresAt: "2026-10-20T12:35:00.000Z" },
  };
}

export function soakHealthFixture(): SignalQualitySoakHealthDto {
  return {
    ...AUTHORITY,
    generatedAt: "2026-10-21T00:00:00.000Z",
    scanner: {
      state: "RUNNING",
      reason: "fresh",
      runId: "20261020T000000Z-abcd1234",
      startedAt: "2026-10-20T00:00:00.000Z",
      writtenAt: "2026-10-20T23:59:30.000Z",
      ageSeconds: 30,
      universe: { exchangeCandidates: 528, generation: 7, stale: false, selected: 520, liveEligible: 518, quarantined: 0, recovering: 0, awaitingStream: 2, failed: 0, capacityExceeded: false },
      lastMarketDataAt: "2026-10-20T23:59:58.000Z",
      reconnects: 1,
      backpressureEvents: 0,
    },
    emitter: { state: "RUNNING", reason: "fresh", mode: "COMMIT_DASHBOARD_ALERTS", writtenAt: "2026-10-20T23:59:40.000Z", ageSeconds: 20, created: 25, queueDepth: 0, maxQueueDepth: 2, ledgerDuplicates: 0, symbolsTracked: 520, symbolsHealthy: 520, symbolsFailed: 0 },
    alerts: { lastDeliveredAt: "2026-10-20T23:40:00.000Z", lastHour: 2, last24h: 25 },
    plans: { PENDING: 0, READY: 25, ERROR: 0, INVALID: 0 } as SignalQualitySoakHealthDto["plans"],
  };
}
