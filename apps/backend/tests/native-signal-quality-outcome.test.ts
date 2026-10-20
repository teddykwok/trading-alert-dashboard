import { describe, expect, it } from "vitest";

import {
  MINUTE_MS,
  barLookupFromArray,
  evaluateSignalOutcome,
  outcomeBarRange,
  validatePlanGeometry,
  type MinuteBar,
  type OutcomeMarketData,
  type OutcomePlan,
  type SignalOutcome,
} from "../src/modules/signal-quality/signal-quality-outcome";

/**
 * M6.5 — the signal-quality outcome kernel, judged in isolation (section 27).
 * Pure: synthetic minute bars only, no network, no database, no clock.
 */

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0); // minute-aligned
const H24 = 1440 * MINUTE_MS;

interface Ohlc {
  o: number;
  h: number;
  l: number;
  c: number;
}
const flat = (p: number): Ohlc => ({ o: p, h: p, l: p, c: p });

function series(fromMs: number, minutes: number, at: (i: number) => Ohlc, skip: readonly number[] = []): MinuteBar[] {
  const out: MinuteBar[] = [];
  for (let i = 0; i < minutes; i += 1) {
    if (skip.includes(i)) continue;
    const x = at(i);
    out.push({ openTimeMs: fromMs + i * MINUTE_MS, open: x.o, high: x.h, low: x.l, close: x.c });
  }
  return out;
}

const loaded = (bars: MinuteBar[]): OutcomeMarketData => ({ status: "LOADED", bars: barLookupFromArray(bars) });
const NO_PLAN: OutcomePlan = { available: false, reason: "the alert has no plan" };

function run(options: { direction?: "LONG" | "SHORT"; triggeredAtMs?: number; ref?: number | null; plan?: OutcomePlan; bars?: MinuteBar[]; market?: OutcomeMarketData; end: number }): SignalOutcome {
  return evaluateSignalOutcome({
    signal: { direction: options.direction ?? "LONG", triggeredAtMs: options.triggeredAtMs ?? T0, referencePrice: options.ref === undefined ? 100 : options.ref },
    plan: options.plan ?? NO_PLAN,
    marketData: options.market ?? loaded(options.bars ?? []),
    evaluationEndMs: options.end,
  });
}
const h = (outcome: SignalOutcome, key: string) => outcome.horizons.find((x) => x.key === key)!;

// ===========================================================================
// LONG and SHORT excursions
// ===========================================================================

describe("LONG excursions, relative to the canonical reference", () => {
  const end = T0 + H24;
  it("favourable move only: MFE positive, MAE zero, return positive", () => {
    const o = run({ end, bars: series(T0, 1440, (i) => ({ o: 100, h: 100 + Math.min(5, i / 10), l: 100, c: 100 + Math.min(5, i / 10) })) });
    expect(h(o, "24h")).toMatchObject({ state: "MATURED", observedMinutes: 1440, missingMinutes: 0 });
    expect(h(o, "24h").mfePct).toBeCloseTo(5, 10);
    expect(h(o, "24h").maePct).toBeCloseTo(0, 10);
    expect(h(o, "24h").returnPct).toBeCloseTo(5, 10);
  });
  it("adverse move only: MFE zero, MAE positive, return negative", () => {
    const o = run({ end, bars: series(T0, 1440, () => ({ o: 100, h: 100, l: 96, c: 97 })) });
    expect([h(o, "24h").mfePct, h(o, "24h").maePct, h(o, "24h").returnPct]).toEqual([0, 4, -3]);
  });
  it("both: MFE and MAE each from their own extreme", () => {
    const o = run({ end, bars: series(T0, 1440, (i) => (i === 10 ? { o: 100, h: 103, l: 100, c: 101 } : i === 20 ? { o: 100, h: 100, l: 98, c: 99 } : flat(100))) });
    expect([h(o, "15m").mfePct, h(o, "15m").maePct]).toEqual([3, 0]);
    expect([h(o, "1h").mfePct, h(o, "1h").maePct, h(o, "1h").returnPct]).toEqual([3, 2, 0]);
  });
  it("no move: every metric is exactly zero (a matured zero, not a missing value)", () => {
    const o = run({ end, bars: series(T0, 1440, () => flat(100)) });
    for (const x of o.horizons) expect([x.state, x.mfePct, x.maePct, x.returnPct]).toEqual(["MATURED", 0, 0, 0]);
  });
  it("exact horizon boundary: at S + 15m the 15m horizon is MATURED; one millisecond earlier it is PARTIAL", () => {
    const bars = series(T0, 1440, () => flat(100));
    expect(h(run({ end: T0 + 15 * MINUTE_MS, bars }), "15m").state).toBe("MATURED");
    const early = run({ end: T0 + 15 * MINUTE_MS - 1, bars });
    expect(h(early, "15m")).toMatchObject({ state: "PARTIAL", observedMinutes: 14 });
    expect(h(early, "1h").state).toBe("PARTIAL");
  });
});

describe("SHORT excursions mirror LONG exactly", () => {
  const end = T0 + H24;
  it("favourable move only (price falls)", () => {
    const o = run({ direction: "SHORT", end, bars: series(T0, 1440, () => ({ o: 100, h: 100, l: 95, c: 96 })) });
    expect([h(o, "24h").mfePct, h(o, "24h").maePct, h(o, "24h").returnPct]).toEqual([5, 0, 4]);
  });
  it("adverse move only (price rises)", () => {
    const o = run({ direction: "SHORT", end, bars: series(T0, 1440, () => ({ o: 100, h: 104, l: 100, c: 103 })) });
    expect([h(o, "24h").mfePct, h(o, "24h").maePct, h(o, "24h").returnPct]).toEqual([0, 4, -3]);
  });
  it("both", () => {
    const o = run({ direction: "SHORT", end, bars: series(T0, 1440, (i) => (i === 10 ? { o: 100, h: 100, l: 97, c: 99 } : i === 20 ? { o: 100, h: 102, l: 100, c: 101 } : flat(100))) });
    expect([h(o, "1h").mfePct, h(o, "1h").maePct, h(o, "1h").returnPct]).toEqual([3, 2, 0]);
  });
  it("no move", () => {
    const o = run({ direction: "SHORT", end, bars: series(T0, 1440, () => flat(100)) });
    for (const x of o.horizons) expect([x.mfePct, x.maePct, x.returnPct]).toEqual([0, 0, 0]);
  });
  it("exact horizon boundary", () => {
    const bars = series(T0, 1440, () => flat(100));
    expect(h(run({ direction: "SHORT", end: T0 + 60 * MINUTE_MS, bars }), "1h").state).toBe("MATURED");
    expect(h(run({ direction: "SHORT", end: T0 + 60 * MINUTE_MS - 1, bars }), "1h").state).toBe("PARTIAL");
  });
  it("symmetry: a LONG path and its mirror image as a SHORT give identical metrics and plan outcomes", () => {
    const up = series(T0, 1440, (i) => ({ o: 100, h: 100 + (i % 7) / 3, l: 100 - (i % 5) / 4, c: 100 + ((i % 3) - 1) / 5 }));
    const mirror = up.map((b) => ({ openTimeMs: b.openTimeMs, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close }));
    const long = run({ end, bars: up, plan: { available: true, entry: 100, stopLoss: 98.5, takeProfit: 102 } });
    const short = run({ direction: "SHORT", end, bars: mirror, plan: { available: true, entry: 100, stopLoss: 101.5, takeProfit: 98 } });
    for (const key of ["15m", "1h", "4h", "12h", "24h"]) {
      expect(h(short, key).mfePct).toBeCloseTo(h(long, key).mfePct as number, 10);
      expect(h(short, key).maePct).toBeCloseTo(h(long, key).maePct as number, 10);
      expect(h(short, key).returnPct).toBeCloseTo(h(long, key).returnPct as number, 10);
    }
    expect(short.plan.outcome).toBe(long.plan.outcome);
    expect(short.plan.resolvedAtMs).toBe(long.plan.resolvedAtMs);
  });
});

// ===========================================================================
// Horizon maturity and censoring
// ===========================================================================

describe("horizons: MATURED only when every minute is observed; incomplete is never a zero, a win or a loss", () => {
  const bars = series(T0, 1440, () => flat(100));
  for (const [key, minutes] of [["15m", 15], ["1h", 60], ["4h", 240], ["12h", 720], ["24h", 1440]] as const) {
    it(`${key} matures exactly at S + ${minutes} min`, () => {
      expect(h(run({ end: T0 + minutes * MINUTE_MS, bars }), key)).toMatchObject({ state: "MATURED", expectedMinutes: minutes, observedMinutes: minutes });
      expect(h(run({ end: T0 + minutes * MINUTE_MS - 1, bars }), key).state).toBe("PARTIAL");
    });
  }
  it("PARTIAL reports values so far but says how many minutes closed", () => {
    const o = run({ end: T0 + 90 * MINUTE_MS, bars });
    expect(h(o, "4h")).toMatchObject({ state: "PARTIAL", observedMinutes: 90, reason: "90 of 240 minutes have closed" });
  });
  it("PENDING: before the first full minute after the trigger has closed", () => {
    for (const end of [T0, T0 + MINUTE_MS - 1, T0 - 5 * MINUTE_MS]) {
      for (const x of run({ end, bars }).horizons) expect([x.state, x.mfePct, x.returnPct]).toEqual(["PENDING", null, null]);
    }
  });
  it("missing market data: NOT_LOADED and UNAVAILABLE become DATA_UNAVAILABLE (or PENDING before anything elapsed)", () => {
    for (const market of [{ status: "NOT_LOADED", reason: "budget" }, { status: "UNAVAILABLE", reason: "HTTP 503" }] as OutcomeMarketData[]) {
      const o = run({ end: T0 + H24, market });
      for (const x of o.horizons) expect([x.state, x.mfePct, x.reason]).toEqual(["DATA_UNAVAILABLE", null, (market as { reason: string }).reason]);
      for (const x of run({ end: T0, market }).horizons) expect(x.state).toBe("PENDING");
    }
  });
  it("gap: a missing minute makes every elapsed horizon containing it DATA_GAP, with no values", () => {
    const gappy = series(T0, 1440, () => flat(100), [7]);
    const o = run({ end: T0 + H24, bars: gappy });
    for (const x of o.horizons) expect([x.state, x.missingMinutes, x.mfePct]).toEqual(["DATA_GAP", 1, null]);
    const later = series(T0, 1440, () => flat(100), [100]);
    const p = run({ end: T0 + H24, bars: later });
    expect([h(p, "15m").state, h(p, "1h").state, h(p, "4h").state]).toEqual(["MATURED", "MATURED", "DATA_GAP"]);
    // While still running, a missing minute keeps the horizon PARTIAL and counts it.
    expect(h(run({ end: T0 + 30 * MINUTE_MS, bars: gappy }), "1h")).toMatchObject({ state: "PARTIAL", missingMinutes: 1 });
  });
  it("no canonical reference price: the horizon state is kept but no value is fabricated", () => {
    const o = run({ ref: null, end: T0 + H24, bars });
    expect(h(o, "24h")).toMatchObject({ state: "MATURED", mfePct: null, maePct: null, returnPct: null, reason: "no canonical reference price" });
  });
  it("duplicated or misaligned minutes are not trusted: they become gaps", () => {
    const doubled = [...series(T0, 1440, () => flat(100)), { openTimeMs: T0 + 3 * MINUTE_MS, open: 50, high: 50, low: 50, close: 50 }];
    expect(h(run({ end: T0 + H24, bars: doubled }), "15m").state).toBe("DATA_GAP");
    const shifted = series(T0, 1440, () => flat(100)).map((b, i) => (i === 2 ? { ...b, openTimeMs: b.openTimeMs + 1 } : b));
    expect(h(run({ end: T0 + H24, bars: shifted }), "15m").state).toBe("DATA_GAP");
  });
});

// ===========================================================================
// Timing: nothing before the trigger, nothing after the evaluation instant
// ===========================================================================

describe("timing", () => {
  it("no candle before triggeredAt contributes: a spike in the trigger minute and before it is invisible", () => {
    const t = T0 + 30_000; // mid-minute trigger
    const bars = [
      ...series(T0 - 10 * MINUTE_MS, 10, () => ({ o: 100, h: 150, l: 50, c: 100 })),
      { openTimeMs: T0, open: 100, high: 140, low: 60, close: 100 }, // the trigger minute
      ...series(T0 + MINUTE_MS, 1440, () => flat(100)),
    ];
    const o = run({ triggeredAtMs: t, end: T0 + MINUTE_MS + H24, bars });
    expect(o.outcomeStartMs).toBe(T0 + MINUTE_MS);
    expect([h(o, "24h").state, h(o, "24h").mfePct, h(o, "24h").maePct]).toEqual(["MATURED", 0, 0]);
  });
  it("exact triggeredAt boundary: a minute-aligned trigger starts at its own minute", () => {
    const bars = [{ openTimeMs: T0, open: 100, high: 103, low: 100, close: 102 }, ...series(T0 + MINUTE_MS, 1439, () => flat(100))];
    const o = run({ triggeredAtMs: T0, end: T0 + H24, bars });
    expect(o.outcomeStartMs).toBe(T0);
    expect(h(o, "15m").mfePct).toBe(3);
  });
  it("no future data beyond evaluationEnd: later minutes and the still-forming minute are ignored", () => {
    const bars = series(T0, 1440, (i) => (i >= 20 ? { o: 100, h: 200, l: 1, c: 100 } : flat(100)));
    const o = run({ end: T0 + 20 * MINUTE_MS + 30_000, bars }); // minute 20 is still forming
    expect(h(o, "15m")).toMatchObject({ state: "MATURED", mfePct: 0, maePct: 0 });
    expect(h(o, "1h")).toMatchObject({ state: "PARTIAL", observedMinutes: 20, mfePct: 0 });
  });
  it("outcomeBarRange covers the trigger minute through the end of the 24h window", () => {
    expect(outcomeBarRange(T0 + 30_000)).toEqual({ fromMs: T0, toMs: T0 + MINUTE_MS + H24 });
    expect(outcomeBarRange(T0)).toEqual({ fromMs: T0, toMs: T0 + H24 });
  });
});

// ===========================================================================
// Plan resolution against the EXISTING selected plan
// ===========================================================================

describe("plan resolution", () => {
  const LONG_PLAN: OutcomePlan = { available: true, entry: 100, stopLoss: 98, takeProfit: 106 };
  const end = T0 + H24;
  it("TP first: realized R is the plan's own reward:risk", () => {
    const o = run({ plan: LONG_PLAN, end, bars: series(T0, 1440, (i) => (i === 30 ? { o: 100, h: 106, l: 99, c: 105 } : flat(100))) });
    expect(o.plan).toEqual({ outcome: "TP_FIRST", rMultiple: 3, resolvedAtMs: T0 + 30 * MINUTE_MS, reason: null, plannedRewardR: 3 });
  });
  it("SL first: -1R", () => {
    const o = run({ plan: LONG_PLAN, end, bars: series(T0, 1440, (i) => (i === 5 ? { o: 100, h: 100, l: 98, c: 98 } : i === 30 ? { o: 100, h: 110, l: 100, c: 105 } : flat(100))) });
    expect(o.plan).toMatchObject({ outcome: "SL_FIRST", rMultiple: -1, resolvedAtMs: T0 + 5 * MINUTE_MS });
  });
  it("neither in the full 24h window: NEITHER, with no realized R", () => {
    const o = run({ plan: LONG_PLAN, end, bars: series(T0, 1440, () => ({ o: 100, h: 105.9, l: 98.1, c: 100 })) });
    expect(o.plan).toMatchObject({ outcome: "NEITHER", rMultiple: null, resolvedAtMs: null });
    expect(o.final).toBe(true);
  });
  it("same-bar TP + SL: AMBIGUOUS_SAME_BAR, never guessed, no R", () => {
    const o = run({ plan: LONG_PLAN, end, bars: series(T0, 1440, (i) => (i === 12 ? { o: 100, h: 107, l: 97, c: 100 } : flat(100))) });
    expect(o.plan).toMatchObject({ outcome: "AMBIGUOUS_SAME_BAR", rMultiple: null, resolvedAtMs: T0 + 12 * MINUTE_MS });
  });
  it("a trigger minute that already touched TP or SL is ambiguous too (pre- and post-trigger prices mixed)", () => {
    const t = T0 + 30_000;
    const bars = [{ openTimeMs: T0, open: 100, high: 106.5, low: 99.5, close: 100 }, ...series(T0 + MINUTE_MS, 1440, () => flat(100))];
    expect(run({ triggeredAtMs: t, plan: LONG_PLAN, end: T0 + MINUTE_MS + H24, bars }).plan).toMatchObject({ outcome: "AMBIGUOUS_SAME_BAR", rMultiple: null });
    const missingTriggerMinute = series(T0 + MINUTE_MS, 1440, () => flat(100));
    expect(run({ triggeredAtMs: t, plan: LONG_PLAN, end: T0 + MINUTE_MS + H24, bars: missingTriggerMinute }).plan.outcome).toBe("DATA_GAP");
  });
  it("missing plan: PLAN_UNAVAILABLE, the signal metrics still evaluate", () => {
    const o = run({ end, bars: series(T0, 1440, () => flat(100)) });
    expect(o.plan).toMatchObject({ outcome: "PLAN_UNAVAILABLE", rMultiple: null, reason: "the alert has no plan" });
    expect(h(o, "24h").state).toBe("MATURED");
  });
  it("malformed or zero-risk geometry fails observability safely: PLAN_UNAVAILABLE, never a number", () => {
    const bad: OutcomePlan[] = [
      { available: true, entry: 100, stopLoss: 101, takeProfit: 106 }, // LONG stop above entry
      { available: true, entry: 100, stopLoss: 100, takeProfit: 106 }, // zero risk
      { available: true, entry: 100, stopLoss: 98, takeProfit: 100 }, // zero reward
      { available: true, entry: Number.NaN, stopLoss: 98, takeProfit: 106 },
      { available: true, entry: 100, stopLoss: -1, takeProfit: 106 },
      { available: true, entry: 100, stopLoss: 98, takeProfit: Number.POSITIVE_INFINITY },
    ];
    for (const plan of bad) {
      const o = run({ plan, end, bars: series(T0, 1440, () => ({ o: 100, h: 200, l: 1, c: 100 })) });
      expect([o.plan.outcome, o.plan.rMultiple, o.plan.plannedRewardR]).toEqual(["PLAN_UNAVAILABLE", null, null]);
      expect(validatePlanGeometry("LONG", plan).ok).toBe(false);
    }
    // A SHORT geometry handed to a LONG signal is refused, not flipped.
    expect(validatePlanGeometry("LONG", { available: true, entry: 100, stopLoss: 102, takeProfit: 94 }).ok).toBe(false);
    expect(validatePlanGeometry("SHORT", { available: true, entry: 100, stopLoss: 102, takeProfit: 94 })).toEqual({ ok: true, rewardR: 3 });
  });
  it("PENDING: no resolution yet and the 24h window has not elapsed", () => {
    const o = run({ plan: LONG_PLAN, end: T0 + 3 * 3_600_000, bars: series(T0, 1440, () => flat(100)) });
    expect(o.plan).toMatchObject({ outcome: "PENDING", rMultiple: null });
    expect(o.final).toBe(false);
  });
  it("DATA_GAP before resolution: order unknowable, no R; a resolution before the gap stands", () => {
    const gapFirst = series(T0, 1440, (i) => (i === 50 ? { o: 100, h: 107, l: 100, c: 106 } : flat(100)), [10]);
    expect(run({ plan: LONG_PLAN, end, bars: gapFirst }).plan).toMatchObject({ outcome: "DATA_GAP", rMultiple: null });
    const tpFirst = series(T0, 1440, (i) => (i === 5 ? { o: 100, h: 107, l: 100, c: 106 } : flat(100)), [10]);
    expect(run({ plan: LONG_PLAN, end, bars: tpFirst }).plan).toMatchObject({ outcome: "TP_FIRST", rMultiple: 3 });
  });
  it("no market data: DATA_UNAVAILABLE (a valid plan keeps its planned R for display, never as realized R)", () => {
    const o = run({ plan: LONG_PLAN, end, market: { status: "UNAVAILABLE", reason: "HTTP 503" } });
    expect(o.plan).toEqual({ outcome: "DATA_UNAVAILABLE", rMultiple: null, resolvedAtMs: null, reason: "HTTP 503", plannedRewardR: 3 });
  });
  it("SHORT: TP below entry, SL above; touches are inclusive", () => {
    const plan: OutcomePlan = { available: true, entry: 100, stopLoss: 102, takeProfit: 96 };
    expect(run({ direction: "SHORT", plan, end, bars: series(T0, 1440, (i) => (i === 3 ? { o: 100, h: 100, l: 96, c: 97 } : flat(100))) }).plan).toMatchObject({ outcome: "TP_FIRST", rMultiple: 2 });
    expect(run({ direction: "SHORT", plan, end, bars: series(T0, 1440, (i) => (i === 3 ? { o: 100, h: 102, l: 100, c: 101 } : flat(100))) }).plan).toMatchObject({ outcome: "SL_FIRST", rMultiple: -1 });
  });
});

describe("determinism", () => {
  it("the same input and the same evaluation instant give deep-equal output, every time", () => {
    const bars = series(T0, 1440, (i) => ({ o: 100, h: 100 + (i % 11) / 7, l: 100 - (i % 13) / 9, c: 100 + ((i % 5) - 2) / 10 }));
    const input = { direction: "LONG" as const, triggeredAtMs: T0 + 12_345, ref: 100, plan: { available: true, entry: 100, stopLoss: 98, takeProfit: 103 } as OutcomePlan, bars, end: T0 + 7 * 3_600_000 };
    const first = run(input);
    for (let i = 0; i < 25; i += 1) expect(run(input)).toStrictEqual(first);
    expect(JSON.stringify(first)).not.toMatch(/NaN|Infinity/);
  });
});
