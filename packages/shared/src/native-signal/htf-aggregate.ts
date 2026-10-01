import {
  DEFAULT_CALENDAR_ALIGNMENT,
  type CalendarAlignment,
  type NativeHtfAggregate,
  type NativeKline,
  type NativeSourceTf,
} from "./types";

/**
 * Higher-timeframe periods and the FORMING candle within them.
 *
 * Pine asks `request.security` for "D", "W", "M", "3M", "6M" and "12M"
 * (labels 1D..12M). In continuous realtime, what it gets back at each
 * chart-bar close is the period's candle so far. That is rebuilt here from the
 * chart bars alone — nothing after the current close is ever consulted.
 *
 * Only UTC accessors are used. The host's local timezone must never move a
 * period boundary; a source-shape test enforces this.
 */

const DAY_MS = 86_400_000;

const MONTHS_PER_PERIOD: Readonly<Record<"1M" | "3M" | "6M" | "12M", number>> = Object.freeze({
  "1M": 1,
  "3M": 3,
  "6M": 6,
  "12M": 12,
});

/**
 * Start (UTC ms) of the `tf` period containing `timeMs`.
 *
 *  - 1D:  00:00 UTC of that day.
 *  - 1W:  00:00 UTC of the most recent `weekStartsOnUtcDay`.
 *  - 1M:  00:00 UTC on the 1st of the calendar month.
 *  - 3M/6M/12M: the 1st of the month that begins the block of 3/6/12 months
 *    anchored at `multiMonthAnchorMonth`.
 */
export function htfPeriodStartMs(
  tf: NativeSourceTf,
  timeMs: number,
  calendar: CalendarAlignment = DEFAULT_CALENDAR_ALIGNMENT
): number {
  const dayStart = Math.floor(timeMs / DAY_MS) * DAY_MS;
  if (tf === "1D") return dayStart;
  if (tf === "1W") {
    const weekday = new Date(dayStart).getUTCDay();
    const daysBack = (weekday - calendar.weekStartsOnUtcDay + 7) % 7;
    return dayStart - daysBack * DAY_MS;
  }
  const months = MONTHS_PER_PERIOD[tf];
  const at = new Date(timeMs);
  const month = at.getUTCMonth();
  const anchor = months === 1 ? 0 : calendar.multiMonthAnchorMonth;
  const offset = (((month - anchor) % months) + months) % months;
  // Date.UTC normalises a negative month into the previous year.
  return Date.UTC(at.getUTCFullYear(), month - offset, 1);
}

/**
 * The forming candle after one more CLOSED chart bar.
 *
 * A bar opening in a new period starts a fresh candle; otherwise the bar
 * extends the current one. `complete` records whether the period's real open
 * was seen: only a bar that opens exactly on the period boundary can supply it.
 */
export function advanceHtfAggregate(
  previous: NativeHtfAggregate | null,
  bar: NativeKline,
  tf: NativeSourceTf,
  calendar: CalendarAlignment = DEFAULT_CALENDAR_ALIGNMENT
): NativeHtfAggregate {
  const periodStartMs = htfPeriodStartMs(tf, bar.openTimeMs, calendar);
  if (previous === null || previous.periodStartMs !== periodStartMs) {
    return {
      periodStartMs,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      complete: bar.openTimeMs === periodStartMs,
    };
  }
  return {
    periodStartMs,
    open: previous.open,
    high: Math.max(previous.high, bar.high),
    low: Math.min(previous.low, bar.low),
    close: bar.close,
    complete: previous.complete,
  };
}

/**
 * True when the bar lies wholly inside one `tf` period.
 *
 * A chart bar that spans a boundary (say a weekly chart bar against the 1D
 * source) cannot be split into the two candles it belongs to, so the forming
 * candle would be invented. The engine refuses such input instead.
 */
export function barFitsHtfPeriod(
  bar: NativeKline,
  tf: NativeSourceTf,
  calendar: CalendarAlignment = DEFAULT_CALENDAR_ALIGNMENT
): boolean {
  return htfPeriodStartMs(tf, bar.openTimeMs, calendar) === htfPeriodStartMs(tf, bar.closeTimeMs, calendar);
}
