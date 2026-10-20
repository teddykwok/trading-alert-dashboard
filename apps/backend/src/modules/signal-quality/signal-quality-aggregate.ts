import {
  SIGNAL_QUALITY_HORIZON_STATES,
  SIGNAL_QUALITY_HORIZONS,
  SIGNAL_QUALITY_PLAN_OUTCOMES,
  type SignalQualityAlertRateDto,
  type SignalQualityBreakdownRowDto,
  type SignalQualityHorizonAggregateDto,
  type SignalQualityHorizonKey,
  type SignalQualityHorizonState,
  type SignalQualityPlanAggregateDto,
  type SignalQualityPlanOutcome,
  type SignalQualityRate,
  type SignalQualityRowDto,
  type SignalQualityStats,
  type SignalQualitySummaryDto,
} from "@trading-alert-dashboard/shared";

/**
 * Aggregates over evaluated signal-quality rows. Pure and deterministic.
 *
 * CENSORING IS MANDATORY:
 *  - a horizon enters excursion/return statistics only when MATURED; PARTIAL,
 *    PENDING, DATA_GAP and DATA_UNAVAILABLE are counted, never averaged;
 *  - a plan enters win-rate and R statistics only when TP_FIRST or SL_FIRST;
 *    AMBIGUOUS_SAME_BAR, NEITHER, PENDING, DATA_GAP, DATA_UNAVAILABLE and
 *    PLAN_UNAVAILABLE are counted, never a win, a loss or a zero;
 *  - every rate carries its numerator and denominator, and every statistic its
 *    sample size; a zero denominator gives null, never NaN or Infinity.
 * Nothing here concludes that anything is profitable.
 */

export function rate(numerator: number, denominator: number): SignalQualityRate {
  return { numerator, denominator, value: denominator > 0 ? numerator / denominator : null };
}

export function stats(values: readonly (number | null)[]): SignalQualityStats {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  const n = finite.length;
  if (n === 0) return { n: 0, mean: null, median: null };
  const mean = finite.reduce((sum, v) => sum + v, 0) / n;
  const median = n % 2 === 1 ? finite[(n - 1) / 2] : (finite[n / 2 - 1] + finite[n / 2]) / 2;
  return { n, mean: Number.isFinite(mean) ? mean : null, median: Number.isFinite(median) ? median : null };
}

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

export function horizonAggregate(rows: readonly SignalQualityRowDto[], key: SignalQualityHorizonKey): SignalQualityHorizonAggregateDto {
  const states = zeroCounts<SignalQualityHorizonState>(SIGNAL_QUALITY_HORIZON_STATES);
  const matured: { mfe: number | null; mae: number | null; ret: number | null }[] = [];
  for (const row of rows) {
    const h = row.horizons.find((x) => x.key === key);
    if (h === undefined) continue;
    states[h.state] += 1;
    if (h.state === "MATURED") matured.push({ mfe: h.mfePct, mae: h.maePct, ret: h.returnPct });
  }
  const withReturn = matured.filter((m) => typeof m.ret === "number" && Number.isFinite(m.ret));
  return {
    key,
    states,
    mfePct: stats(matured.map((m) => m.mfe)),
    maePct: stats(matured.map((m) => m.mae)),
    returnPct: stats(matured.map((m) => m.ret)),
    directional: rate(withReturn.filter((m) => (m.ret as number) > 0).length, withReturn.length),
  };
}

export const RESOLVED_PLAN_OUTCOMES: readonly SignalQualityPlanOutcome[] = ["TP_FIRST", "SL_FIRST"];

export function planAggregate(rows: readonly SignalQualityRowDto[]): SignalQualityPlanAggregateDto {
  const outcomes = zeroCounts<SignalQualityPlanOutcome>(SIGNAL_QUALITY_PLAN_OUTCOMES);
  const realized: number[] = [];
  for (const row of rows) {
    outcomes[row.plan.outcome] += 1;
    if (RESOLVED_PLAN_OUTCOMES.includes(row.plan.outcome) && typeof row.plan.rMultiple === "number" && Number.isFinite(row.plan.rMultiple)) {
      realized.push(row.plan.rMultiple);
    }
  }
  const r = stats(realized);
  const wins = realized.filter((x) => x > 0).reduce((s, x) => s + x, 0);
  const losses = Math.abs(realized.filter((x) => x < 0).reduce((s, x) => s + x, 0));
  const profitFactor: SignalQualityPlanAggregateDto["profitFactor"] =
    realized.length === 0 ? { value: null, reason: "NO_RESOLVED_PLANS" } : losses === 0 ? { value: null, reason: "NO_LOSSES" } : { value: wins / losses, reason: null };
  return {
    outcomes,
    tpBeforeSl: rate(outcomes.TP_FIRST, outcomes.TP_FIRST + outcomes.SL_FIRST),
    r,
    expectancyR: r.mean,
    profitFactor,
  };
}

function countBy(rows: readonly SignalQualityRowDto[], keyOf: (row: SignalQualityRowDto) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = keyOf(row);
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function breakdown(rows: readonly SignalQualityRowDto[], keyOf: (row: SignalQualityRowDto) => string): SignalQualityBreakdownRowDto[] {
  const groups = new Map<string, SignalQualityRowDto[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.keys()]
    .sort()
    .map((key) => {
      const group = groups.get(key) as SignalQualityRowDto[];
      return { key, total: group.length, plan: planAggregate(group), horizon24h: horizonAggregate(group, "24h") };
    });
}

/** Keys used for grouping, with explicit placeholders for absent fields (never silently merged into a real value). */
export const groupKeys = {
  sourceTimeframe: (row: SignalQualityRowDto) => row.sourceTimeframe ?? "UNKNOWN",
  direction: (row: SignalQualityRowDto) => row.direction,
  levelColor: (row: SignalQualityRowDto) => row.levelColor ?? "UNKNOWN",
  timeframeClass: (row: SignalQualityRowDto) => row.timeframeClass,
  integrity: (row: SignalQualityRowDto) => (row.integrity.judged ? (row.integrity.status ?? "UNREADABLE") : "NOT_JUDGED"),
  freshness: (row: SignalQualityRowDto) => row.freshness.state,
  evidenceClass: (row: SignalQualityRowDto) => row.evidenceClass ?? "UNKNOWN",
  soakScope: (row: SignalQualityRowDto) => row.soakScope,
  deliveryTiming: (row: SignalQualityRowDto) => row.deliveryTiming,
};

const HOUR_MS = 3_600_000;
const ROLLING_MS = 15 * 60_000;

function top(counts: Map<string, number>, limit = 10, minimum = 2): { key: string; count: number }[] {
  return [...counts.entries()]
    .filter(([, count]) => count >= minimum)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

/** Alert-rate and clustering observability. Observation only: nothing is throttled. */
export function alertRate(rows: readonly SignalQualityRowDto[]): SignalQualityAlertRateDto {
  const times = rows.map((r) => Date.parse(r.triggeredAt)).filter(Number.isFinite).sort((a, b) => a - b);
  const hours = new Map<number, { alerts: number; symbols: Set<string> }>();
  for (const row of rows) {
    const t = Date.parse(row.triggeredAt);
    if (!Number.isFinite(t)) continue;
    const hour = Math.floor(t / HOUR_MS) * HOUR_MS;
    const bucket = hours.get(hour) ?? { alerts: 0, symbols: new Set<string>() };
    bucket.alerts += 1;
    bucket.symbols.add(row.symbol);
    hours.set(hour, bucket);
  }
  let best = 0;
  let bestStart: number | null = null;
  for (let i = 0, j = 0; i < times.length; i += 1) {
    while (times[i] - times[j] >= ROLLING_MS) j += 1;
    const count = i - j + 1;
    if (count > best) {
      best = count;
      bestStart = times[j];
    }
  }
  const symbols = new Map<string, number>();
  const sides = new Map<string, number>();
  const levels = new Map<string, number>();
  for (const row of rows) {
    symbols.set(row.symbol, (symbols.get(row.symbol) ?? 0) + 1);
    const side = `${row.symbol} ${row.direction}`;
    sides.set(side, (sides.get(side) ?? 0) + 1);
    if (row.levelKey !== null) {
      const level = `${row.symbol} ${row.direction} ${row.sourceTimeframe ?? "?"} ${row.levelKey}`;
      levels.set(level, (levels.get(level) ?? 0) + 1);
    }
  }
  return {
    perHour: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([hour, b]) => ({ hourStart: new Date(hour).toISOString(), alerts: b.alerts, symbols: b.symbols.size })),
    maxInRolling15m: { count: best, windowStart: bestStart === null ? null : new Date(bestStart).toISOString() },
    topSymbols: top(symbols),
    topSymbolSides: top(sides),
    repeatedLevels: top(levels),
  };
}

export type SignalQualityAggregates = Pick<SignalQualitySummaryDto, "counts" | "horizons" | "plans" | "breakdowns" | "alertRate">;

/** Every aggregate the summary shows, over one evaluated set of rows. */
export function aggregateSignalQuality(rows: readonly SignalQualityRowDto[]): SignalQualityAggregates {
  const flagCounts: Record<string, number> = {};
  for (const row of rows) for (const flag of row.flags) flagCounts[flag.code] = (flagCounts[flag.code] ?? 0) + 1;
  return {
    counts: {
      total: rows.length,
      uniqueSymbols: new Set(rows.map((r) => r.symbol)).size,
      byDirection: countBy(rows, groupKeys.direction),
      bySourceTimeframe: countBy(rows, groupKeys.sourceTimeframe),
      byLevelColor: countBy(rows, groupKeys.levelColor),
      byTimeframeClass: countBy(rows, groupKeys.timeframeClass),
      byIntegrity: countBy(rows, groupKeys.integrity),
      byFreshness: countBy(rows, groupKeys.freshness),
      byEvidenceClass: countBy(rows, groupKeys.evidenceClass),
      bySoakScope: countBy(rows, groupKeys.soakScope),
      byDeliveryTiming: countBy(rows, groupKeys.deliveryTiming),
      planAvailable: rows.filter((r) => r.plan.available).length,
      flags: Object.fromEntries(Object.entries(flagCounts).sort(([a], [b]) => (a < b ? -1 : 1))),
    },
    horizons: SIGNAL_QUALITY_HORIZONS.map((h) => horizonAggregate(rows, h.key)),
    plans: planAggregate(rows),
    breakdowns: {
      bySourceTimeframe: breakdown(rows, groupKeys.sourceTimeframe),
      byDirection: breakdown(rows, groupKeys.direction),
      byLevelColor: breakdown(rows, groupKeys.levelColor),
      byTimeframeClass: breakdown(rows, groupKeys.timeframeClass),
      byIntegrity: breakdown(rows, groupKeys.integrity),
      byEvidenceClass: breakdown(rows, groupKeys.evidenceClass),
    },
    alertRate: alertRate(rows),
  };
}
