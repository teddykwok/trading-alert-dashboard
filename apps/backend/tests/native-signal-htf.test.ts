import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALENDAR_ALIGNMENT,
  advanceHtfAggregate,
  barFitsHtfPeriod,
  createNativeEngineConfig,
  htfPeriodStartMs,
  replayNativeEngine,
  type NativeHtfAggregate,
  type NativeKline,
  type NativeSourceTf,
} from "@trading-alert-dashboard/shared";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  T_2024_01_01,
  barsFrom,
  doji,
  type Ohlc,
} from "./helpers/native-signal-fixtures";

/**
 * Slice 1 — higher-timeframe periods and the FORMING candle.
 *
 * The engine models Pine v5.5 in continuous realtime: at each chart-bar close
 * the HTF candle is the period so far, never the period's final candle. These
 * tests pin the calendar and prove nothing after the current bar is used.
 *
 * Times are deliberately chosen late in the UTC evening: on a host east of UTC
 * (this machine runs Singapore time, UTC+8) any accidental local-time accessor
 * would land on the NEXT calendar day and fail here.
 */

const utc = (y: number, m: number, d: number, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm);
const at = (ms: number) => new Date(ms).toISOString();

function fold(bars: readonly NativeKline[], tf: NativeSourceTf, calendar = DEFAULT_CALENDAR_ALIGNMENT) {
  const out: NativeHtfAggregate[] = [];
  let aggregate: NativeHtfAggregate | null = null;
  for (const bar of bars) {
    aggregate = advanceHtfAggregate(aggregate, bar, tf, calendar);
    out.push(aggregate);
  }
  return out;
}

describe("period boundaries are explicit, UTC and calendar-aligned", () => {
  it("1D starts at 00:00 UTC", () => {
    expect(at(htfPeriodStartMs("1D", utc(2024, 3, 15, 23, 59)))).toBe("2024-03-15T00:00:00.000Z");
    expect(at(htfPeriodStartMs("1D", utc(2024, 3, 16, 0, 0)))).toBe("2024-03-16T00:00:00.000Z");
  });

  // 33. weekly boundary
  it("1W starts on Monday 00:00 UTC by default, and the anchor is a parameter", () => {
    // 2024-01-07 is a Sunday, 2024-01-08 a Monday.
    expect(at(htfPeriodStartMs("1W", utc(2024, 1, 7, 23, 45)))).toBe("2024-01-01T00:00:00.000Z");
    expect(at(htfPeriodStartMs("1W", utc(2024, 1, 8, 0, 0)))).toBe("2024-01-08T00:00:00.000Z");
    expect(at(htfPeriodStartMs("1W", utc(2024, 1, 10, 12, 0)))).toBe("2024-01-08T00:00:00.000Z");

    const sundayWeeks = { weekStartsOnUtcDay: 0, multiMonthAnchorMonth: 0 };
    expect(at(htfPeriodStartMs("1W", utc(2024, 1, 7, 23, 45), sundayWeeks))).toBe("2024-01-07T00:00:00.000Z");
    expect(at(htfPeriodStartMs("1W", utc(2024, 1, 6, 23, 45), sundayWeeks))).toBe("2023-12-31T00:00:00.000Z");
  });

  // 34. monthly boundary
  it("1M is the calendar month, including leap February", () => {
    expect(at(htfPeriodStartMs("1M", utc(2024, 1, 31, 23, 45)))).toBe("2024-01-01T00:00:00.000Z");
    expect(at(htfPeriodStartMs("1M", utc(2024, 2, 1, 0, 0)))).toBe("2024-02-01T00:00:00.000Z");
    expect(at(htfPeriodStartMs("1M", utc(2024, 2, 29, 23, 45)))).toBe("2024-02-01T00:00:00.000Z");
    expect(at(htfPeriodStartMs("1M", utc(2024, 3, 1, 0, 0)))).toBe("2024-03-01T00:00:00.000Z");
    // The multi-month anchor never moves a calendar month.
    expect(htfPeriodStartMs("1M", utc(2024, 2, 10), { weekStartsOnUtcDay: 1, multiMonthAnchorMonth: 1 })).toBe(
      utc(2024, 2, 1)
    );
  });

  // 35. 3M calendar aggregation
  it("3M is a calendar quarter (Jan/Apr/Jul/Oct by default)", () => {
    expect(at(htfPeriodStartMs("3M", utc(2024, 3, 31, 23, 45)))).toBe("2024-01-01T00:00:00.000Z");
    expect(at(htfPeriodStartMs("3M", utc(2024, 4, 1)))).toBe("2024-04-01T00:00:00.000Z");
    expect(at(htfPeriodStartMs("3M", utc(2024, 9, 30, 23, 45)))).toBe("2024-07-01T00:00:00.000Z");
    expect(at(htfPeriodStartMs("3M", utc(2024, 12, 31, 23, 45)))).toBe("2024-10-01T00:00:00.000Z");
  });

  it("3M follows an explicit anchor across a year boundary", () => {
    const februaryQuarters = { weekStartsOnUtcDay: 1, multiMonthAnchorMonth: 1 };
    expect(at(htfPeriodStartMs("3M", utc(2024, 1, 15), februaryQuarters))).toBe("2023-11-01T00:00:00.000Z");
    expect(at(htfPeriodStartMs("3M", utc(2024, 2, 1), februaryQuarters))).toBe("2024-02-01T00:00:00.000Z");
    expect(at(htfPeriodStartMs("3M", utc(2024, 4, 30, 23, 45), februaryQuarters))).toBe("2024-02-01T00:00:00.000Z");
    expect(at(htfPeriodStartMs("3M", utc(2024, 5, 1), februaryQuarters))).toBe("2024-05-01T00:00:00.000Z");
  });

  // 36. 6M calendar aggregation
  it("6M is a calendar half-year (Jan/Jul by default)", () => {
    expect(at(htfPeriodStartMs("6M", utc(2024, 6, 30, 23, 45)))).toBe("2024-01-01T00:00:00.000Z");
    expect(at(htfPeriodStartMs("6M", utc(2024, 7, 1)))).toBe("2024-07-01T00:00:00.000Z");
    expect(at(htfPeriodStartMs("6M", utc(2024, 12, 31, 23, 45)))).toBe("2024-07-01T00:00:00.000Z");
    const aprilHalves = { weekStartsOnUtcDay: 1, multiMonthAnchorMonth: 3 };
    expect(at(htfPeriodStartMs("6M", utc(2024, 3, 31, 23, 45), aprilHalves))).toBe("2023-10-01T00:00:00.000Z");
    expect(at(htfPeriodStartMs("6M", utc(2024, 4, 1), aprilHalves))).toBe("2024-04-01T00:00:00.000Z");
  });

  // 37. 12M calendar aggregation
  it("12M is the calendar year by default, and an explicit anchor shifts it", () => {
    expect(at(htfPeriodStartMs("12M", utc(2024, 12, 31, 23, 45)))).toBe("2024-01-01T00:00:00.000Z");
    expect(at(htfPeriodStartMs("12M", utc(2025, 1, 1)))).toBe("2025-01-01T00:00:00.000Z");
    const aprilYears = { weekStartsOnUtcDay: 1, multiMonthAnchorMonth: 3 };
    expect(at(htfPeriodStartMs("12M", utc(2025, 3, 31, 23, 45), aprilYears))).toBe("2024-04-01T00:00:00.000Z");
    expect(at(htfPeriodStartMs("12M", utc(2025, 4, 1), aprilYears))).toBe("2025-04-01T00:00:00.000Z");
  });

  it("refuses to pretend a straddling chart bar belongs to one period", () => {
    const fifteen = (start: number): NativeKline => ({
      openTimeMs: start,
      closeTimeMs: start + 15 * MINUTE_MS - 1,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
    });
    expect(barFitsHtfPeriod(fifteen(utc(2024, 1, 31, 23, 45)), "1M")).toBe(true);
    // A weekly chart bar from Mon 2024-01-29 runs into February.
    const week: NativeKline = { ...fifteen(utc(2024, 1, 29)), closeTimeMs: utc(2024, 2, 5) - 1 };
    expect(barFitsHtfPeriod(week, "1W")).toBe(true);
    expect(barFitsHtfPeriod(week, "1M")).toBe(false);
    expect(barFitsHtfPeriod(week, "1D")).toBe(false);
  });
});

describe("the forming candle is built only from bars already closed", () => {
  // 32. partial 1D aggregation
  it("1D: open of the first sub-bar, running high/low, close of the latest bar", () => {
    const sixHours = barsFrom(T_2024_01_01, 6 * HOUR_MS, [
      [100, 104, 99, 103],
      [103, 108, 101, 102],
      [102, 103, 95, 96],
      [96, 97, 94, 97],
      [97, 98, 96, 98], // next day
    ]);
    const steps = fold(sixHours, "1D").map(({ periodStartMs, open, high, low, close, complete }) => ({
      start: at(periodStartMs),
      open,
      high,
      low,
      close,
      complete,
    }));
    expect(steps).toEqual([
      { start: "2024-01-01T00:00:00.000Z", open: 100, high: 104, low: 99, close: 103, complete: true },
      { start: "2024-01-01T00:00:00.000Z", open: 100, high: 108, low: 99, close: 102, complete: true },
      { start: "2024-01-01T00:00:00.000Z", open: 100, high: 108, low: 95, close: 96, complete: true },
      { start: "2024-01-01T00:00:00.000Z", open: 100, high: 108, low: 94, close: 97, complete: true },
      { start: "2024-01-02T00:00:00.000Z", open: 97, high: 98, low: 96, close: 98, complete: true },
    ]);
  });

  it("weekly, monthly, quarterly, half-year and yearly candles each reset only at their own boundary", () => {
    // Daily bars for all of 2024 plus Jan 2025, each opening at 100 + dayIndex,
    // so a candle's open names the bar that started it.
    const rows: Ohlc[] = Array.from({ length: 366 + 31 }, (_, day) => doji(100 + day));
    const bars = barsFrom(T_2024_01_01, DAY_MS, rows);
    const dayOf = (y: number, m: number, d: number) => (utc(y, m, d) - T_2024_01_01) / DAY_MS;

    const expectations: Array<[NativeSourceTf, number, string, number]> = [
      // [tf, bar index, period start, open = 100 + index of the period's first bar]
      ["1W", dayOf(2024, 1, 7), "2024-01-01T00:00:00.000Z", 100],
      ["1W", dayOf(2024, 1, 8), "2024-01-08T00:00:00.000Z", 100 + dayOf(2024, 1, 8)],
      ["1M", dayOf(2024, 1, 31), "2024-01-01T00:00:00.000Z", 100],
      ["1M", dayOf(2024, 2, 1), "2024-02-01T00:00:00.000Z", 100 + dayOf(2024, 2, 1)],
      ["3M", dayOf(2024, 3, 31), "2024-01-01T00:00:00.000Z", 100],
      ["3M", dayOf(2024, 4, 1), "2024-04-01T00:00:00.000Z", 100 + dayOf(2024, 4, 1)],
      ["6M", dayOf(2024, 4, 1), "2024-01-01T00:00:00.000Z", 100],
      ["6M", dayOf(2024, 7, 1), "2024-07-01T00:00:00.000Z", 100 + dayOf(2024, 7, 1)],
      ["12M", dayOf(2024, 12, 31), "2024-01-01T00:00:00.000Z", 100],
      ["12M", dayOf(2025, 1, 1), "2025-01-01T00:00:00.000Z", 100 + dayOf(2025, 1, 1)],
    ];
    for (const [tf, index, start, open] of expectations) {
      const aggregate = fold(bars, tf)[index];
      expect({ tf, index, start: at(aggregate.periodStartMs), open: aggregate.open }).toEqual({
        tf,
        index,
        start,
        open,
      });
      // close is always the CURRENT bar's close, high the running max so far.
      expect(aggregate.close).toBe(100 + index);
      expect(aggregate.high).toBe(100 + index);
    }
  });

  it("a period that began before the first bar is marked incomplete until the next boundary", () => {
    // Start on Wednesday 2024-01-03: the 1W, 1M, 3M, 6M and 12M periods began earlier.
    const wednesday = utc(2024, 1, 3);
    const bars = barsFrom(wednesday, DAY_MS, Array.from({ length: 7 }, () => doji(100)));
    expect(fold(bars, "1D").every((a) => a.complete)).toBe(true);
    const weekly = fold(bars, "1W");
    expect(weekly.slice(0, 5).map((a) => a.complete)).toEqual([false, false, false, false, false]);
    // Monday 2024-01-08 opens a period whose first sub-bar we did see.
    expect(at(weekly[5].periodStartMs)).toBe("2024-01-08T00:00:00.000Z");
    expect(weekly[5].complete).toBe(true);
    expect(fold(bars, "12M").every((a) => !a.complete)).toBe(true);
  });

  // 38. no future-bar leakage (aggregation)
  it("never sees the period's later bars: the January candle on Jan 2 is not January's final candle", () => {
    const rows: Ohlc[] = [doji(100), [100, 120, 99, 99], ...Array.from({ length: 20 }, () => doji(99)), [99, 150, 99, 99]];
    const bars = barsFrom(T_2024_01_01, DAY_MS, rows);
    const full = fold(bars, "1M");
    // On Jan 2 the month's high is 120, not the 150 printed on Jan 23.
    expect(full[1].high).toBe(120);
    expect(full[full.length - 1].high).toBe(150);
    // And every aggregate equals the one computed from that prefix alone.
    for (let k = 1; k <= bars.length; k += 1) {
      expect(fold(bars.slice(0, k), "1M")[k - 1]).toEqual(full[k - 1]);
    }
  });

  it("the engine's own state carries the same forming candle", () => {
    const config = createNativeEngineConfig({ minMovePct: 0.07 });
    const sixHours = barsFrom(T_2024_01_01, 6 * HOUR_MS, [doji(100), [100, 104, 99, 103]]);
    const { state } = replayNativeEngine(sixHours, config);
    expect(state.htf["1D"]?.aggregate).toEqual({
      periodStartMs: T_2024_01_01,
      open: 100,
      high: 104,
      low: 99,
      close: 103,
      complete: true,
    });
  });
});
