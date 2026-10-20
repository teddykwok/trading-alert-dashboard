import { describe, expect, it } from "vitest";
import { SIGNAL_QUALITY_FLAGS } from "@trading-alert-dashboard/shared";

import { aggregateSignalQuality, alertRate, breakdown, groupKeys, horizonAggregate, planAggregate, rate, stats } from "../src/modules/signal-quality/signal-quality-aggregate";
import { SIGNAL_QUALITY_EXPORT_COLUMNS, csvCell, signalQualityCsv, signalQualityJson } from "../src/modules/signal-quality/signal-quality-export";
import {
  deliveryTimingOf,
  payloadFactsOf,
  planFactsOf,
  signalQualityFactsOf,
  soakScopeOf,
  timeframeClassOf,
  type SignalQualityAlertRow,
} from "../src/modules/signal-quality/signal-quality-facts";
import { barLookupFromArray, MINUTE_MS, type MinuteBar } from "../src/modules/signal-quality/signal-quality-outcome";
import { buildRows, setFlags, type RowInput } from "../src/modules/signal-quality/signal-quality-rows";
import { SignalQualityService } from "../src/modules/signal-quality/signal-quality.service";
import { SOURCE_BAR, SOURCE_BAR_CLOSE } from "./helpers/native-canary-fixtures";
import { alertRow, nonFiniteNumbersIn, planRow, row } from "./helpers/signal-quality-fixtures";

/**
 * M6.5 — aggregation, censoring, per-alert facts, diagnostic flags and export
 * (sections 12, 13, 14, 26 and 28). Pure.
 */

// ===========================================================================
// Rates and statistics never divide by zero
// ===========================================================================

describe("rates and statistics", () => {
  it("a rate always carries its denominator, and a zero denominator is null, never NaN or Infinity", () => {
    expect(rate(7, 19)).toEqual({ numerator: 7, denominator: 19, value: 7 / 19 });
    expect(rate(0, 0)).toEqual({ numerator: 0, denominator: 0, value: null });
  });
  it("stats: mean and median of finite values only; empty is n 0 with nulls", () => {
    expect(stats([3, -1, -1, 2])).toEqual({ n: 4, mean: 0.75, median: 0.5 });
    expect(stats([5, 1, 3])).toEqual({ n: 3, mean: 3, median: 3 });
    expect(stats([null, Number.NaN, Number.POSITIVE_INFINITY])).toEqual({ n: 0, mean: null, median: null });
    expect(stats([])).toEqual({ n: 0, mean: null, median: null });
  });
});

// ===========================================================================
// Censoring
// ===========================================================================

describe("censoring: incomplete samples never enter a mature denominator", () => {
  it("pending, partial, gaps and unavailable horizons are counted but excluded from MFE/MAE/return and the directional rate", () => {
    const rows = [
      row({ h24: { state: "MATURED", mfe: 4, mae: 1, ret: 2 } }),
      row({ h24: { state: "MATURED", mfe: 2, mae: 3, ret: -1 } }),
      row({ h24: { state: "PENDING" } }),
      row({ h24: { state: "PARTIAL", mfe: 50, mae: 0, ret: 50 } }),
      row({ h24: { state: "DATA_GAP" } }),
      row({ h24: { state: "DATA_UNAVAILABLE" } }),
    ];
    const agg = horizonAggregate(rows, "24h");
    expect(agg.states).toEqual({ MATURED: 2, PARTIAL: 1, PENDING: 1, DATA_GAP: 1, DATA_UNAVAILABLE: 1 });
    expect(agg.mfePct).toEqual({ n: 2, mean: 3, median: 3 });
    expect(agg.maePct).toEqual({ n: 2, mean: 2, median: 2 });
    expect(agg.returnPct).toEqual({ n: 2, mean: 0.5, median: 0.5 });
    expect(agg.directional).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
  });

  it("ambiguous, neither, pending, gaps, unavailable and missing plans never enter the win/loss denominator or R", () => {
    const rows = [
      row({ outcome: "TP_FIRST", r: 3 }),
      row({ outcome: "SL_FIRST" }),
      row({ outcome: "SL_FIRST" }),
      row({ outcome: "TP_FIRST", r: 2 }),
      row({ outcome: "AMBIGUOUS_SAME_BAR" }),
      row({ outcome: "NEITHER" }),
      row({ outcome: "PENDING" }),
      row({ outcome: "DATA_GAP" }),
      row({ outcome: "DATA_UNAVAILABLE" }),
      row({ outcome: "PLAN_UNAVAILABLE" }),
    ];
    const agg = planAggregate(rows);
    expect(agg.outcomes).toEqual({ TP_FIRST: 2, SL_FIRST: 2, NEITHER: 1, AMBIGUOUS_SAME_BAR: 1, PLAN_UNAVAILABLE: 1, DATA_GAP: 1, PENDING: 1, DATA_UNAVAILABLE: 1 });
    expect(agg.tpBeforeSl).toEqual({ numerator: 2, denominator: 4, value: 0.5 });
    expect(agg.r).toEqual({ n: 4, mean: 0.75, median: 0.5 });
    expect(agg.expectancyR).toBe(0.75);
    expect(agg.profitFactor).toEqual({ value: 2.5, reason: null });
  });

  it("an ambiguous outcome is never a win and never a loss, even with a stray R value", () => {
    const agg = planAggregate([row({ outcome: "AMBIGUOUS_SAME_BAR", r: 3 }), row({ outcome: "AMBIGUOUS_SAME_BAR", r: -1 })]);
    expect(agg.tpBeforeSl).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(agg.r.n).toBe(0);
  });

  it("profit factor: no resolved plans and no losses are reported as such; only losses is 0", () => {
    expect(planAggregate([]).profitFactor).toEqual({ value: null, reason: "NO_RESOLVED_PLANS" });
    expect(planAggregate([row({ outcome: "PENDING" })]).profitFactor).toEqual({ value: null, reason: "NO_RESOLVED_PLANS" });
    expect(planAggregate([row({ outcome: "TP_FIRST", r: 3 })]).profitFactor).toEqual({ value: null, reason: "NO_LOSSES" });
    expect(planAggregate([row({ outcome: "SL_FIRST" })]).profitFactor).toEqual({ value: 0, reason: null });
  });

  it("nothing in any aggregate is ever NaN or Infinity, even over an empty set or null metrics", () => {
    expect(nonFiniteNumbersIn(aggregateSignalQuality([]))).toEqual([]);
    const weird = [row({ outcome: "TP_FIRST", r: Number.POSITIVE_INFINITY, h24: { state: "MATURED", mfe: null, mae: Number.NaN, ret: null } }), row({ outcome: "SL_FIRST", horizon: { state: "MATURED" } })];
    expect(nonFiniteNumbersIn(aggregateSignalQuality(weird))).toEqual([]);
  });
});

// ===========================================================================
// Groupings
// ===========================================================================

describe("groupings and breakdowns", () => {
  it("LONG and SHORT math is symmetric: mirrored rows give identical aggregates per side", () => {
    const longs = [row({ direction: "LONG", outcome: "TP_FIRST", r: 3, h24: { state: "MATURED", mfe: 4, mae: 1, ret: 2 } }), row({ direction: "LONG", outcome: "SL_FIRST" })];
    const shorts = [row({ direction: "SHORT", outcome: "TP_FIRST", r: 3, h24: { state: "MATURED", mfe: 4, mae: 1, ret: 2 } }), row({ direction: "SHORT", outcome: "SL_FIRST" })];
    const [l, s] = breakdown([...longs, ...shorts], groupKeys.direction);
    expect(l.key).toBe("LONG");
    expect(s.key).toBe("SHORT");
    expect({ ...s, key: "LONG" }).toEqual(l);
  });
  it("1D / 1W / 1M group separately, and 1M is DASHBOARD_ONLY while 1D and 1W are the execution-policy timeframes", () => {
    expect([timeframeClassOf("1D"), timeframeClassOf("1W"), timeframeClassOf("1M"), timeframeClassOf("3M"), timeframeClassOf(null)]).toEqual([
      "EXECUTION_POLICY_TIMEFRAME",
      "EXECUTION_POLICY_TIMEFRAME",
      "DASHBOARD_ONLY_TIMEFRAME",
      "DASHBOARD_ONLY_TIMEFRAME",
      "DASHBOARD_ONLY_TIMEFRAME",
    ]);
    const rows = [row({ sourceTimeframe: "1D" }), row({ sourceTimeframe: "1W" }), row({ sourceTimeframe: "1M", timeframeClass: "DASHBOARD_ONLY_TIMEFRAME" }), row({ sourceTimeframe: "1M", timeframeClass: "DASHBOARD_ONLY_TIMEFRAME" })];
    const agg = aggregateSignalQuality(rows);
    expect(agg.counts.bySourceTimeframe).toEqual({ "1D": 1, "1M": 2, "1W": 1 });
    expect(agg.counts.byTimeframeClass).toEqual({ DASHBOARD_ONLY_TIMEFRAME: 2, EXECUTION_POLICY_TIMEFRAME: 2 });
    expect(agg.breakdowns.byTimeframeClass.map((b) => [b.key, b.total])).toEqual([["DASHBOARD_ONLY_TIMEFRAME", 2], ["EXECUTION_POLICY_TIMEFRAME", 2]]);
  });
  it("absent fields are grouped under explicit UNKNOWN / NOT_JUDGED keys, never merged into a real value", () => {
    const agg = aggregateSignalQuality([row({ levelColor: null, sourceTimeframe: null, evidenceClass: null, integrity: { judged: false, status: null, reason: null } })]);
    expect(agg.counts.byLevelColor).toEqual({ UNKNOWN: 1 });
    expect(agg.counts.bySourceTimeframe).toEqual({ UNKNOWN: 1 });
    expect(agg.counts.byIntegrity).toEqual({ NOT_JUDGED: 1 });
    expect(agg.counts.byEvidenceClass).toEqual({ UNKNOWN: 1 });
  });
  it("alert rate: per hour, the busiest rolling 15 minutes, and repeated symbols, sides and levels (observation only)", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 12, 0) + m * 60_000).toISOString();
    const rows = [
      row({ symbol: "AAAUSDT", triggeredAt: at(0), levelKey: "L1" }),
      row({ symbol: "AAAUSDT", triggeredAt: at(5), levelKey: "L1" }),
      row({ symbol: "BBBUSDT", triggeredAt: at(10) }),
      row({ symbol: "AAAUSDT", direction: "SHORT", triggeredAt: at(70) }),
    ];
    const r = alertRate(rows);
    expect(r.perHour).toEqual([
      { hourStart: "2026-10-01T12:00:00.000Z", alerts: 3, symbols: 2 },
      { hourStart: "2026-10-01T13:00:00.000Z", alerts: 1, symbols: 1 },
    ]);
    expect(r.maxInRolling15m).toEqual({ count: 3, windowStart: at(0) });
    expect(r.topSymbols).toEqual([{ key: "AAAUSDT", count: 3 }]);
    expect(r.topSymbolSides).toEqual([{ key: "AAAUSDT LONG", count: 2 }]);
    expect(r.repeatedLevels).toEqual([{ key: "AAAUSDT LONG 1D L1", count: 2 }]);
  });
});

// ===========================================================================
// Per-alert facts
// ===========================================================================

describe("per-alert engine facts", () => {
  it("a genuine V2 payload is valid, with barStart, delivery identity and evidence class", () => {
    const facts = payloadFactsOf(alertRow().rawPayload);
    expect(facts).toMatchObject({ valid: true, problem: null, barStartMs: SOURCE_BAR });
    expect(facts.deliveryKey).toMatch(/^[0-9a-f]{64}$/);
    expect(facts.shadowEventId).toMatch(/^[0-9a-f]{64}$/);
    expect(facts.evidenceClass).toBeTruthy();
  });
  it("malformed payloads are named, never corrected", () => {
    expect(payloadFactsOf(null)).toMatchObject({ valid: false, problem: "the alert carries no payload object" });
    expect(payloadFactsOf({ schema: "tradingview" })).toMatchObject({ valid: false });
    const p = alertRow().rawPayload as Record<string, any>;
    expect(payloadFactsOf({ ...p, delivery: { ...p.delivery, barStart: undefined } }).barStartMs).toBeNull();
    expect(payloadFactsOf({ ...p, delivery: undefined })).toMatchObject({ valid: false, problem: "the payload has no delivery provenance" });
  });
  it("M5 freshness, judged at the instant of delivery: fresh, stale, unprovable", () => {
    const fresh = signalQualityFactsOf(alertRow({ lagMs: 2_000 }), null, null)!;
    expect(fresh.freshness.state).toBe("FRESH_AT_DELIVERY");
    expect(fresh.freshness.window?.expiresAtMs).toBe(SOURCE_BAR_CLOSE + 5 * 60_000);
    const late = alertRow();
    const stale = signalQualityFactsOf({ ...late, createdAt: new Date(SOURCE_BAR_CLOSE + 5 * 60_000 + 1) }, null, null)!;
    expect(stale.freshness.state).toBe("STALE_AT_DELIVERY");
    const p = late.rawPayload as Record<string, any>;
    const noBar = signalQualityFactsOf({ ...late, rawPayload: { ...p, delivery: { ...p.delivery, barStart: undefined } } }, null, null)!;
    expect(noBar.freshness.state).toBe("TIME_UNAVAILABLE");
  });
  it("soak scope: triggered during, triggered before but observed during (backlog/recovery), outside, or no window", () => {
    const soak = { startMs: 1_000, endMs: 2_000 };
    expect(soakScopeOf(1_500, 1_510, soak)).toBe("TRIGGERED_DURING_SOAK");
    expect(soakScopeOf(1_000, 1_000, soak)).toBe("TRIGGERED_DURING_SOAK");
    expect(soakScopeOf(999, 1_200, soak)).toBe("OBSERVED_DURING_SOAK_TRIGGERED_BEFORE_START");
    expect(soakScopeOf(999, 999, soak)).toBe("OUTSIDE_SOAK");
    expect(soakScopeOf(2_000, 2_001, soak)).toBe("OUTSIDE_SOAK");
    expect(soakScopeOf(1_500, 1_510, null)).toBe("NO_SOAK_WINDOW");
  });
  it("delivery timing: within 60 s is REALTIME, later is DELAYED", () => {
    expect([deliveryTimingOf(60_000), deliveryTimingOf(60_001)]).toEqual(["REALTIME", "DELAYED"]);
  });
  it("the plan: a READY selected plan gives its own geometry; anything else is unavailable or malformed, never recalculated", () => {
    const ready = planFactsOf(planRow("LONG"), "LONG");
    expect(ready).toMatchObject({ exists: true, malformed: false, geometry: { available: true } });
    expect(ready.summary?.selectedLookback).toBe(100);
    expect(planFactsOf(null, "LONG")).toMatchObject({ exists: false, geometry: { available: false, reason: "the alert has no plan" } });
    expect(planFactsOf(planRow("LONG", { status: "PENDING" }), "LONG")).toMatchObject({ malformed: false, geometry: { available: false } });
    expect(planFactsOf(planRow("LONG", { candidates: "nonsense" }), "LONG")).toMatchObject({ malformed: true });
    expect(planFactsOf(planRow("LONG", { selectedLookback: 250 }), "LONG")).toMatchObject({ malformed: false, summary: { state: "NO_SELECTED_CANDIDATE" } });
    expect(planFactsOf(planRow("SHORT"), "LONG")).toMatchObject({ malformed: true });
  });
  it("a non-Native or non-directional alert is never evaluated", () => {
    expect(signalQualityFactsOf({ ...alertRow(), source: "TRADINGVIEW" }, null, null)).toBeNull();
    expect(signalQualityFactsOf({ ...alertRow(), signal: "WATCH" }, null, null)).toBeNull();
  });
});

// ===========================================================================
// Rows and diagnostic flags
// ===========================================================================

function bars(fromMs: number, minutes: number, price: number): MinuteBar[] {
  return Array.from({ length: minutes }, (_, i) => ({ openTimeMs: fromMs + i * MINUTE_MS, open: price, high: price, low: price, close: price }));
}

function input(alert: SignalQualityAlertRow, over: Partial<RowInput> = {}): RowInput {
  const facts = signalQualityFactsOf(alert, planRow(alert.signal as "LONG" | "SHORT"), null)!;
  return { facts, integrity: { status: "ELIGIBLE", reason: "fixture" }, marketData: { status: "LOADED", bars: barLookupFromArray(bars(Math.floor(facts.triggeredAtMs / MINUTE_MS) * MINUTE_MS, 1500, facts.levelPrice ?? 1)) }, evaluationEndMs: facts.triggeredAtMs + 2 * 3_600_000, ...over };
}

describe("diagnostic flags", () => {
  const codes = (r: { flags: readonly { code: string }[] }) => r.flags.map((f) => f.code).sort();

  it("a clean alert has no flags at all", () => {
    const [r] = buildRows([input(alertRow())], alertRow().triggeredAt.getTime() + 2 * 3_600_000);
    expect(codes(r)).toEqual([]);
  });
  it("a repeated canonical identity is a SUSPICIOUS_DUPLICATE on every copy; a different identity on the same symbol and side is an EXPECTED_REPEAT", () => {
    const a = alertRow({ id: "a1" });
    const copy = { ...a, id: "a2" }; // same payload: same delivery key and shadow event
    const flags = setFlags([input(a).facts, input(copy).facts]);
    expect(flags.get("a1")!.map((f) => f.code)).toContain("SUSPICIOUS_DUPLICATE");
    expect(flags.get("a2")!.map((f) => f.code)).toContain("SUSPICIOUS_DUPLICATE");
    const other = alertRow({ id: "b1", eventTimeMs: SOURCE_BAR + 300_000, sourceTf: "1W" });
    const more = setFlags([input(alertRow({ id: "x1" })).facts, input(other).facts]);
    expect(more.get("b1")!.map((f) => f.code)).toContain("EXPECTED_REPEAT");
    expect(more.get("b1")!.map((f) => f.code)).not.toContain("SUSPICIOUS_DUPLICATE");
    expect(SIGNAL_QUALITY_FLAGS.EXPECTED_REPEAT).toBe("INFO");
    expect(SIGNAL_QUALITY_FLAGS.SUSPICIOUS_DUPLICATE).toBe("DEFECT");
  });
  it("the ingestion's own duplicate count is a SUSPICIOUS_DUPLICATE", () => {
    const [r] = buildRows([input(alertRow({ duplicateCount: 2 }))], Date.UTC(2027, 0, 1));
    expect(codes(r)).toContain("SUSPICIOUS_DUPLICATE");
  });
  it("three alerts on one symbol and side within an hour are a SYMBOL_SIDE_BURST (observed, not throttled)", () => {
    const ins = [0, 1, 2].map((i) => input(alertRow({ id: `burst-${i}`, eventTimeMs: SOURCE_BAR + 61_000 + i * 60_000, sourceTf: (["1D", "1W", "1M"] as const)[i] })));
    const rows = buildRows(ins, Date.UTC(2027, 0, 1));
    const newest = rows[0];
    expect(codes(newest)).toContain("SYMBOL_SIDE_BURST");
    expect(codes(rows[2])).not.toContain("SYMBOL_SIDE_BURST");
  });
  it("integrity not ELIGIBLE, delayed delivery, staleness, plan problems and future timestamps are flagged; NOT_JUDGED integrity is not", () => {
    const base = alertRow({ lagMs: 10 * 60_000 });
    const asOf = Date.UTC(2027, 0, 1);
    const [delayed] = buildRows([input(base, { integrity: { status: "INELIGIBLE_GAP", reason: "gap" } })], asOf);
    expect(codes(delayed)).toEqual(expect.arrayContaining(["DELAYED_DELIVERY", "INTEGRITY_NOT_ELIGIBLE"]));
    const [notJudged] = buildRows([input(alertRow(), { integrity: null })], asOf);
    expect(codes(notJudged)).not.toContain("INTEGRITY_NOT_ELIGIBLE");
    expect(notJudged.integrity).toEqual({ judged: false, status: null, reason: null });
    const facts = signalQualityFactsOf(alertRow(), null, null)!;
    const [noPlan] = buildRows([{ ...input(alertRow()), facts }], asOf);
    expect(codes(noPlan)).toContain("PLAN_UNAVAILABLE");
    const malformed = signalQualityFactsOf(alertRow(), planRow("LONG", { candidates: "nonsense" }), null)!;
    const [bad] = buildRows([{ ...input(alertRow()), facts: malformed }], asOf);
    expect(codes(bad)).toContain("PLAN_MALFORMED");
    const future = alertRow();
    const [ahead] = buildRows([input({ ...future, createdAt: new Date(future.triggeredAt.getTime() - 1) })], asOf);
    expect(codes(ahead)).toContain("FUTURE_TIMESTAMP");
  });
  it("an operational barStart that disagrees with the trigger is displayed as is, never corrected", () => {
    const a = alertRow();
    const facts = signalQualityFactsOf(a, null, null)!;
    const [r] = buildRows([input(a)], Date.UTC(2027, 0, 1));
    expect(r.barStart).toBe(new Date(SOURCE_BAR).toISOString());
    expect(r.triggerOffsetInBarMs).toBe(facts.triggeredAtMs - SOURCE_BAR);
  });
  it("rows are deterministic and newest first", () => {
    const ins = [input(alertRow({ id: "older", eventTimeMs: SOURCE_BAR + 10_000 })), input(alertRow({ id: "newer", eventTimeMs: SOURCE_BAR + 500_000, sourceTf: "1W" }))];
    const asOf = Date.UTC(2027, 0, 1);
    const first = buildRows(ins, asOf);
    expect(first.map((r) => r.alertId)).toEqual(["newer", "older"]);
    expect(buildRows([...ins].reverse(), asOf)).toStrictEqual(first);
  });
  it("filters and sorts are deterministic: scope, side, outcome, horizon state, flag; ties break on alert id", () => {
    const rows = [row({ id: "r1", outcome: "TP_FIRST", r: 3 }), row({ id: "r2", outcome: "SL_FIRST", direction: "SHORT" }), row({ id: "r3", outcome: "PENDING", h24: { state: "PENDING" } })];
    expect(SignalQualityService.applyFilters(rows, { scope: "ALL", filters: { planOutcome: "TP_FIRST" } }).map((r) => r.alertId)).toEqual(["r1"]);
    expect(SignalQualityService.applyFilters(rows, { scope: "ALL", filters: { direction: "SHORT" } }).map((r) => r.alertId)).toEqual(["r2"]);
    expect(SignalQualityService.applyFilters(rows, { scope: "ALL", filters: { horizon: "24h", horizonState: "PENDING" } }).map((r) => r.alertId)).toEqual(["r3"]);
    expect(SignalQualityService.applyFilters(rows, { scope: "TRIGGERED_DURING_SOAK", filters: {} })).toEqual([]);
    expect(SignalQualityService.sortRows(rows, "R_DESC").map((r) => r.alertId)).toEqual(["r1", "r2", "r3"]);
    expect(SignalQualityService.sortRows(rows, "TRIGGERED_ASC").map((r) => r.alertId)).toEqual(["r1", "r2", "r3"]);
    expect(SignalQualityService.sortRows(rows, "TRIGGERED_DESC").map((r) => r.alertId)).toEqual(["r3", "r2", "r1"]);
  });
});

// ===========================================================================
// Export
// ===========================================================================

describe("export", () => {
  it("CSV has every documented column, quotes what needs quoting and neutralises spreadsheet formulas", () => {
    const csv = signalQualityCsv([row({ symbol: "AAAUSDT", outcome: "TP_FIRST", r: 3 })]);
    const [header, line] = csv.trim().split("\r\n");
    expect(header.split(",")).toEqual(SIGNAL_QUALITY_EXPORT_COLUMNS);
    for (const column of ["alertId", "symbol", "direction", "sourceTimeframe", "levelPrice", "triggeredAt", "barStart", "integrityStatus", "freshness", "selectedLookback", "entry", "stopLoss", "takeProfit", "planOutcome", "rMultiple", "h24hMfePct", "h24hMaePct", "flags"]) {
      expect(SIGNAL_QUALITY_EXPORT_COLUMNS).toContain(column);
    }
    expect(line.split(",")[1]).toBe("AAAUSDT");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-1+2")).toBe("'-1+2");
    expect(csvCell(-1)).toBe("-1");
    expect(csvCell(Number.NaN)).toBe("");
  });
  it("JSON says authority NONE, and no export carries a credential, token or order field", () => {
    const window = { soakStart: null, soakEnd: null, windowStart: "a", windowEnd: "b", scope: "ALL" as const, asOf: "c" };
    const sample = { evaluated: 1, truncated: false, limit: 2000, marketData: { LOADED: 1, NOT_LOADED: 0, UNAVAILABLE: 0 }, integrityJudged: 1, integrityNotJudged: 0 };
    const json = signalQualityJson(window, sample, [row()]);
    expect(JSON.parse(json)).toMatchObject({ authority: "NONE", nativeExecutionEnabled: false, monitoringOnly: true });
    for (const text of [json, signalQualityCsv([row()])]) expect(text).not.toMatch(/apiKey|apiSecret|secret|password|signature|clientOrderId|orderId|handoff|lease|token/i);
  });
});
