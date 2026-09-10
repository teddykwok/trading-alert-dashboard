import { describe, expect, it } from "vitest";

import {
  canonicalUtcDayRoots,
  DAY_MS,
  FillIngestHorizonRefusedError,
  MAX_INGEST_HORIZON_DAYS,
  MIN_INGEST_HORIZON_DAYS,
} from "../src/modules/execution/exchange-fill-day-roots";
import { USER_TRADES_MAX_WINDOW_MS } from "../src/modules/binance/user-trades-window-planner";

/**
 * The doctrine these tests exist to hold in place.
 *
 * A root is a claim that an interval can be proven exhausted and will never
 * grow again. Two ways to break that quietly: seed a day that has not closed,
 * so a short page marks history complete before it happened; or derive the day
 * from calendar accessors, so the answer depends on which timezone the process
 * happens to run in. Both produce roots that look ordinary and are wrong, which
 * is why every expectation below is written in absolute epoch terms.
 *
 * Every expected value is built with `Date.UTC(...)`, so these assertions mean
 * the same thing on a host set to UTC, Asia/Singapore or America/Los_Angeles.
 */

/** An absolute UTC midnight, independent of the machine's timezone. */
const utcDay = (year: number, month: number, day: number): number =>
  Date.UTC(year, month - 1, day);

/** The UTC calendar date a root starts on, for readable failures. */
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const startDates = (roots: Array<{ startTimeMs: number }>): string[] =>
  roots.map((root) => isoDate(root.startTimeMs));

describe("canonical UTC-day roots: shape of one day", () => {
  it("a root spans one whole UTC day, inclusive on both ends", () => {
    const roots = canonicalUtcDayRoots(new Date("2026-09-10T03:29:00.000Z"), 30);

    for (const root of roots) {
      // Starts exactly on a UTC midnight: an exact multiple of a day.
      expect(root.startTimeMs % DAY_MS).toBe(0);
      // Ends at 23:59:59.999 of the same day, never at the next midnight.
      expect(root.endTimeMs - root.startTimeMs).toBe(DAY_MS - 1);
      expect(root.endTimeMs).toBe(root.startTimeMs + DAY_MS - 1);
      expect(new Date(root.startTimeMs).toISOString()).toMatch(/T00:00:00\.000Z$/);
      expect(new Date(root.endTimeMs).toISOString()).toMatch(/T23:59:59\.999Z$/);
    }
  });

  it("bounds are safe integers, as the in-memory window contract requires", () => {
    const roots = canonicalUtcDayRoots(new Date("2026-09-10T03:29:00.000Z"), 60);

    for (const root of roots) {
      expect(Number.isSafeInteger(root.startTimeMs)).toBe(true);
      expect(Number.isSafeInteger(root.endTimeMs)).toBe(true);
      expect(root.startTimeMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("a daily span stays well inside the documented request maximum", () => {
    // The planner refuses a window wider than seven days, and the window
    // service enforces the same bound before anything is persisted. A day is
    // two orders of magnitude below it, so a daily root can never be refused
    // for width.
    const [root] = canonicalUtcDayRoots(new Date("2026-09-10T03:29:00.000Z"), 1);

    expect(root.endTimeMs - root.startTimeMs).toBeLessThan(USER_TRADES_MAX_WINDOW_MS);
    expect(root.endTimeMs - root.startTimeMs).toBe(86_399_999);
  });
});

describe("canonical UTC-day roots: the current day is never seeded", () => {
  it("mid-day, the newest root is yesterday", () => {
    const roots = canonicalUtcDayRoots(new Date("2026-09-10T03:29:00.000Z"), 1);

    expect(startDates(roots)).toEqual(["2026-09-09"]);
  });

  it("at exactly UTC midnight, the day that just opened is still excluded", () => {
    // The boundary case. 00:00:00.000 is the first millisecond of the 10th, so
    // the 10th has 24 hours left to run and only the 9th is closed.
    const roots = canonicalUtcDayRoots(new Date("2026-09-10T00:00:00.000Z"), 1);

    expect(startDates(roots)).toEqual(["2026-09-09"]);
  });

  it("one millisecond before midnight, the newest root is the day before", () => {
    const roots = canonicalUtcDayRoots(new Date("2026-09-09T23:59:59.999Z"), 1);

    expect(startDates(roots)).toEqual(["2026-09-08"]);
  });

  it("no returned root ever contains, or ends after, the instant asked about", () => {
    for (const iso of [
      "2026-09-10T00:00:00.000Z",
      "2026-09-10T03:29:00.000Z",
      "2026-09-10T23:59:59.999Z",
      "2026-01-01T00:00:00.000Z",
      "2026-12-31T23:59:59.999Z",
    ]) {
      const now = new Date(iso);
      const roots = canonicalUtcDayRoots(now, 30);
      const currentDayStart = Math.floor(now.getTime() / DAY_MS) * DAY_MS;

      for (const root of roots) {
        expect(root.endTimeMs).toBeLessThan(now.getTime());
        expect(root.startTimeMs).toBeLessThan(currentDayStart);
      }
    }
  });
});

describe("canonical UTC-day roots: horizon count and ordering", () => {
  const now = new Date("2026-09-10T03:29:00.000Z");

  it("the worked example: 30 days ending yesterday is 11 Aug through 9 Sep", () => {
    const roots = canonicalUtcDayRoots(now, 30);

    expect(roots).toHaveLength(30);
    expect(isoDate(roots[0].startTimeMs)).toBe("2026-08-11");
    expect(isoDate(roots[roots.length - 1].startTimeMs)).toBe("2026-09-09");
    expect(startDates(roots)).not.toContain("2026-09-10");
    // Exact bounds, not just the date label.
    expect(roots[0]).toEqual({
      startTimeMs: utcDay(2026, 8, 11),
      endTimeMs: utcDay(2026, 8, 11) + DAY_MS - 1,
    });
    expect(roots[29]).toEqual({
      startTimeMs: utcDay(2026, 9, 9),
      endTimeMs: utcDay(2026, 9, 9) + DAY_MS - 1,
    });
  });

  it("a horizon of one returns exactly yesterday and nothing else", () => {
    const roots = canonicalUtcDayRoots(now, MIN_INGEST_HORIZON_DAYS);

    expect(roots).toHaveLength(1);
    expect(roots[0]).toEqual({
      startTimeMs: utcDay(2026, 9, 9),
      endTimeMs: utcDay(2026, 9, 9) + DAY_MS - 1,
    });
  });

  it("the maximum horizon returns exactly that many days", () => {
    const roots = canonicalUtcDayRoots(now, MAX_INGEST_HORIZON_DAYS);

    expect(roots).toHaveLength(60);
    expect(isoDate(roots[0].startTimeMs)).toBe("2026-07-12");
    expect(isoDate(roots[59].startTimeMs)).toBe("2026-09-09");
  });

  it("every horizon in range returns exactly that many distinct days", () => {
    for (let horizonDays = MIN_INGEST_HORIZON_DAYS; horizonDays <= MAX_INGEST_HORIZON_DAYS; horizonDays += 1) {
      const roots = canonicalUtcDayRoots(now, horizonDays);

      expect(roots).toHaveLength(horizonDays);
      expect(new Set(roots.map((root) => root.startTimeMs)).size).toBe(horizonDays);
      // The newest is always yesterday, whatever the horizon.
      expect(roots[roots.length - 1].startTimeMs).toBe(utcDay(2026, 9, 9));
      // And the oldest is exactly horizonDays - 1 days before it.
      expect(roots[0].startTimeMs).toBe(utcDay(2026, 9, 9) - (horizonDays - 1) * DAY_MS);
    }
  });

  it("roots are ordered oldest to newest", () => {
    // Deliberate: the oldest day sits nearest the exchange's retention edge, so
    // it is the work with the least time left to be recoverable.
    const roots = canonicalUtcDayRoots(now, 30);

    for (let index = 1; index < roots.length; index += 1) {
      expect(roots[index].startTimeMs).toBeGreaterThan(roots[index - 1].startTimeMs);
    }
    const sorted = [...roots].sort((a, b) => a.startTimeMs - b.startTimeMs);
    expect(roots).toEqual(sorted);
  });

  it("adjacent roots abut exactly: no gap and no overlap", () => {
    // The property derived completeness rests on. One millisecond of overlap
    // would double-count a fill's interval; one millisecond of gap would leave
    // history no root ever asks for.
    const roots = canonicalUtcDayRoots(now, MAX_INGEST_HORIZON_DAYS);

    for (let index = 1; index < roots.length; index += 1) {
      expect(roots[index - 1].endTimeMs + 1).toBe(roots[index].startTimeMs);
    }
    // Stated the other way: the roots tile their whole range with no slack.
    const span = roots[roots.length - 1].endTimeMs - roots[0].startTimeMs + 1;
    expect(span).toBe(roots.length * DAY_MS);
  });

  it("crosses a month boundary without a gap", () => {
    const roots = canonicalUtcDayRoots(new Date("2026-03-02T12:00:00.000Z"), 3);

    // 2026 is not a leap year, so February has 28 days.
    expect(startDates(roots)).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
    expect(roots[0].endTimeMs + 1).toBe(roots[1].startTimeMs);
    expect(roots[1].endTimeMs + 1).toBe(roots[2].startTimeMs);
  });

  it("crosses a leap day and a year boundary without a gap", () => {
    expect(startDates(canonicalUtcDayRoots(new Date("2028-03-01T06:00:00.000Z"), 3))).toEqual([
      "2028-02-27",
      "2028-02-28",
      "2028-02-29",
    ]);
    // The current UTC day is excluded here too, so a 3-day horizon on 1 Jan
    // ends on 31 Dec rather than reaching into the new year.
    expect(startDates(canonicalUtcDayRoots(new Date("2027-01-01T06:00:00.000Z"), 3))).toEqual([
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
    ]);
  });
});

describe("canonical UTC-day roots: the day is UTC, not the host's", () => {
  /**
   * These are the cases a calendar-accessor implementation gets wrong.
   *
   * Both instants sit on a UTC date that differs from the local date in a
   * common deployment timezone, so `getDate()` would pick a different "today"
   * and shift every root by one day -- in one direction on a host east of UTC
   * and the other direction west of it. The expectations are absolute epoch
   * values, so this test asserts the same thing whatever TZ the runner has.
   */

  it("east of UTC: an instant that is already tomorrow locally", () => {
    // 2026-09-10T20:00Z is 2026-09-11 04:00 in Asia/Singapore (UTC+8).
    // A local-calendar implementation there would call today the 11th and
    // return a root for the 10th -- a UTC day still 4 hours from closing.
    const roots = canonicalUtcDayRoots(new Date("2026-09-10T20:00:00.000Z"), 2);

    expect(startDates(roots)).toEqual(["2026-09-08", "2026-09-09"]);
    expect(startDates(roots)).not.toContain("2026-09-10");
  });

  it("west of UTC: an instant that is still yesterday locally", () => {
    // 2026-09-10T02:00Z is 2026-09-09 19:00 in America/Los_Angeles (UTC-7).
    // A local-calendar implementation there would call today the 9th and stop
    // at the 8th, silently skipping a day that really has closed.
    const roots = canonicalUtcDayRoots(new Date("2026-09-10T02:00:00.000Z"), 2);

    expect(startDates(roots)).toEqual(["2026-09-08", "2026-09-09"]);
  });

  it("two instants in the same UTC day give identical roots", () => {
    // Whatever local date either instant falls on, the UTC day is the same, so
    // the answer must be byte-identical.
    const early = canonicalUtcDayRoots(new Date("2026-09-10T00:00:00.000Z"), 5);
    const late = canonicalUtcDayRoots(new Date("2026-09-10T23:59:59.999Z"), 5);

    expect(early).toEqual(late);
  });

  it("the same wall-clock reading in different offsets resolves by instant", () => {
    // "2026-09-10 01:00" in +08:00 is 2026-09-09T17:00Z -- a different UTC day
    // from the same reading in -07:00, which is 2026-09-10T08:00Z. The roots
    // must follow the instant, not the reading.
    const eastOfUtc = canonicalUtcDayRoots(new Date("2026-09-10T01:00:00.000+08:00"), 1);
    const westOfUtc = canonicalUtcDayRoots(new Date("2026-09-10T01:00:00.000-07:00"), 1);

    expect(startDates(eastOfUtc)).toEqual(["2026-09-08"]);
    expect(startDates(westOfUtc)).toEqual(["2026-09-09"]);
  });
});

describe("canonical UTC-day roots: invalid input is refused, never answered with []", () => {
  const now = new Date("2026-09-10T03:29:00.000Z");

  it("an empty result would be indistinguishable from a legitimate empty workset", () => {
    // Which is exactly why every rejection below throws instead of returning
    // one: a caller cannot tell "no eligible days" from "your horizon was
    // nonsense" if both arrive as [].
    expect(canonicalUtcDayRoots(now, 1)).not.toEqual([]);
  });

  it("a horizon below the minimum is refused", () => {
    for (const horizonDays of [0, -1, -30, Number.MIN_SAFE_INTEGER]) {
      expect(() => canonicalUtcDayRoots(now, horizonDays)).toThrow(FillIngestHorizonRefusedError);
    }
  });

  it("a horizon above the maximum is refused", () => {
    for (const horizonDays of [MAX_INGEST_HORIZON_DAYS + 1, 90, 365, Number.MAX_SAFE_INTEGER]) {
      expect(() => canonicalUtcDayRoots(now, horizonDays)).toThrow(FillIngestHorizonRefusedError);
    }
    // The boundary itself is legal.
    expect(canonicalUtcDayRoots(now, MAX_INGEST_HORIZON_DAYS)).toHaveLength(60);
  });

  it("a non-integer horizon is refused rather than truncated", () => {
    for (const horizonDays of [1.5, 29.999, 30.000001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => canonicalUtcDayRoots(now, horizonDays)).toThrow(FillIngestHorizonRefusedError);
    }
  });

  it("the refusal says which argument was wrong", () => {
    const thrown = (() => {
      try {
        canonicalUtcDayRoots(now, 61);
        return null;
      } catch (error) {
        return error as InstanceType<typeof FillIngestHorizonRefusedError>;
      }
    })();

    expect(thrown).toBeInstanceOf(FillIngestHorizonRefusedError);
    expect(thrown!.reasonCode).toBe("FILL_INGEST_HORIZON_REFUSED");
    expect(thrown!.message).toContain("61");
    expect(thrown!.message).toContain("60");
  });

  it("an invalid instant is refused", () => {
    expect(() => canonicalUtcDayRoots(new Date("not a date"), 30)).toThrow(
      FillIngestHorizonRefusedError
    );
    expect(() => canonicalUtcDayRoots(new Date(Number.NaN), 30)).toThrow(
      FillIngestHorizonRefusedError
    );
    // Untyped callers can hand over anything at all.
    for (const notADate of [null, undefined, 0, "2026-09-10", 1_757_000_000_000, {}]) {
      expect(() => canonicalUtcDayRoots(notADate as unknown as Date, 30)).toThrow(
        FillIngestHorizonRefusedError
      );
    }
  });

  it("an instant before the epoch, or a horizon reaching past it, is refused", () => {
    expect(() => canonicalUtcDayRoots(new Date(-1), 1)).toThrow(FillIngestHorizonRefusedError);
    // 1970-01-01 has no closed day behind it at all.
    expect(() => canonicalUtcDayRoots(new Date(0), 1)).toThrow(FillIngestHorizonRefusedError);
    // And a horizon that would walk back off the start of the epoch.
    expect(() => canonicalUtcDayRoots(new Date("1970-01-15T00:00:00.000Z"), 60)).toThrow(
      FillIngestHorizonRefusedError
    );
  });
});
