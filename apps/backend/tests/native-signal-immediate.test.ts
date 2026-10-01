import { describe, expect, it } from "vitest";
import {
  NativeSignalInputError,
  PINE_V55_INPUT_DEFAULTS,
  createNativeEngineConfig,
  createNativeEngineState,
  reconstructImmediateCandidates,
  replayNativeEngine,
  replayNativeEngineWithImmediate,
  stepNativeEngine,
  stepNativeEngineWithImmediate,
  type NativeCandidate,
  type NativeEngineConfigInput,
  type NativeEngineState,
  type NativeImmediateCandidate,
  type NativeKline,
  type NativeLevel,
  type NativeRetestCandidate,
} from "@trading-alert-dashboard/shared";
import {
  MINUTE_MS,
  T_2024_01_01,
  barsFrom,
  dailyBars,
  doji,
  lcg,
  repeat,
  type Ohlc,
} from "./helpers/native-signal-fixtures";

/**
 * Slice 1b — IMMEDIATE INTRABAR candidates.
 *
 * Three things are kept apart throughout:
 *   COMMITTED candidate  — the closing-tick 4B fired; cooldown was written.
 *   IMMEDIATE candidate  — reconstructed from the PREVIOUS close's committed
 *                          state + this bar's final OHLC: Pine's Immediate
 *                          alert() COULD have fired during the bar.
 *   DELIVERED alert      — a TradingView platform fact. Never asserted here.
 *
 * Daily chart bars with only the 1D source enabled, as in the Slice 1 suite:
 * each bar is one complete daily candle, and dojis move price without
 * creating levels.
 */

const TOLERANCE = PINE_V55_INPUT_DEFAULTS.touchTolerancePct;
const upper = (level: number) => level * (1 + TOLERANCE);
const lower = (level: number) => level * (1 - TOLERANCE);

function config(overrides: Partial<NativeEngineConfigInput> = {}) {
  return createNativeEngineConfig({ minMovePct: 0.07, enabledSourceTfs: ["1D"], ...overrides });
}

function run(rows: readonly Ohlc[], overrides: Partial<NativeEngineConfigInput> = {}) {
  return replayNativeEngineWithImmediate(dailyBars(rows), config(overrides));
}

const bars = (candidates: readonly { chartBarIndex: number }[]) => candidates.map((c) => c.chartBarIndex);
const ids = (candidates: readonly { level: { id: number } }[]) => candidates.map((c) => c.level.id);

/** GREEN @ 120 registered on bar 1; RED @ 80 registered on bar 1. */
const GREEN_AT_120: Ohlc[] = [doji(100), [100, 120, 99, 99]];
const RED_AT_80: Ohlc[] = [doji(100), [100, 101, 80, 99]];
/** Touches the 120 band from above and closes safely inside it. */
const TOUCH_120: Ohlc = doji(122, 122, 120);
/**
 * Touches the 120 band from above, then CLOSES THROUGH it (118.5 < 118.8): the
 * closing 4A disarms the level before 4B runs. low (117) < close (118.5), so
 * OHLC proves the low was printed before the closing update.
 */
const THROUGH_120: Ohlc = [125, 125, 117, 118.5];
/** Touches the 80 band from below. */
const TOUCH_80: Ohlc = doji(78, 79.5, 78);

function codeOf(thunk: () => unknown): string | null {
  try {
    thunk();
    return null;
  } catch (error) {
    return error instanceof NativeSignalInputError ? error.code : `unexpected: ${String(error)}`;
  }
}

// ===========================================================================
// The core cases
// ===========================================================================

describe("immediate reconstruction: the core cases", () => {
  // 1.
  it("GREEN touched from above, close holds: an IMMEDIATE candidate, and the normal COMMITTED one", () => {
    const result = run([...GREEN_AT_120, ...repeat(doji(125), 4), TOUCH_120]);
    expect(result.immediateCandidates).toEqual<NativeImmediateCandidate[]>([
      {
        basis: "IMMEDIATE_INTRABAR",
        signal: "LONG",
        touchDirection: "FROM_ABOVE",
        levelColor: "GREEN",
        sourceTf: "1D",
        levelPrice: 120,
        chartBarIndex: 6,
        chartBarOpenTimeMs: result.candidates[0].chartBarOpenTimeMs,
        chartBarCloseTimeMs: result.candidates[0].chartBarCloseTimeMs,
        level: result.candidates[0].level,
        proof: { bandEnteredBeforeClosingUpdate: true, levelPresentOnEveryUpdate: true },
      },
    ]);
    expect(result.candidates.map((c) => [c.basis, c.chartBarIndex, c.level.id])).toEqual([["COMMITTED_BAR_CLOSE", 6, 0]]);
  });

  // 2.
  it("GREEN touch-then-close-through: IMMEDIATE candidate, NO committed candidate, disarmed, no cooldown", () => {
    const result = run([...GREEN_AT_120, ...repeat(doji(125), 4), THROUGH_120]);
    expect(result.immediateCandidates.map((c) => [c.basis, c.signal, c.chartBarIndex, c.level.id, c.proof])).toEqual([
      ["IMMEDIATE_INTRABAR", "LONG", 6, 0, { bandEnteredBeforeClosingUpdate: true, levelPresentOnEveryUpdate: true }],
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.state.levels[0]).toMatchObject({ armed: false, armedBarIndex: -1, lastTouchBarIndex: -1 });
  });

  it("a bar that CLOSES AT ITS LOW cannot prove the band was entered before the closing update", () => {
    // 118 is both low and close: the band may have been reached only by the
    // closing update, where 4A runs first and disarms. Still a candidate (it
    // COULD have fired), but the proof flag says it is not established.
    const result = run([...GREEN_AT_120, ...repeat(doji(125), 4), [125, 125, 118, 118]]);
    expect(result.immediateCandidates.map((c) => c.proof.bandEnteredBeforeClosingUpdate)).toEqual([false]);
    expect(result.candidates).toEqual([]);
  });

  // 3.
  it("RED touch-then-close-through: IMMEDIATE SHORT, NO committed candidate, disarmed", () => {
    // closes 81 > 80*(1.01) = 80.8: broken. high (82) > close, so entry before the close is proven.
    const result = run([...RED_AT_80, ...repeat(doji(75), 4), [75, 82, 75, 81]]);
    expect(result.immediateCandidates.map((c) => [c.signal, c.touchDirection, c.levelColor, c.chartBarIndex, c.proof])).toEqual([
      ["SHORT", "FROM_BELOW", "RED", 6, { bandEnteredBeforeClosingUpdate: true, levelPresentOnEveryUpdate: true }],
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.state.levels[0]).toMatchObject({ armed: false, lastTouchBarIndex: -1 });
  });

  // 4.
  it("wrong-side touches produce no immediate candidate and no cooldown", () => {
    // Unarmed GREEN entered from below.
    const fromBelow = run([...GREEN_AT_120, ...repeat(doji(110), 3), [110, 119.5, 110, 119.5]]);
    // Armed GREEN whose previous close sits INSIDE the band.
    const fromInside = run([...GREEN_AT_120, doji(125), ...repeat(doji(120), 4)]);
    // Unarmed RED entered from above.
    const redFromAbove = run([...RED_AT_80, ...repeat(doji(85), 3), [85, 85, 80, 80.5]]);
    for (const result of [fromBelow, fromInside, redFromAbove]) {
      expect(result.immediateCandidates).toEqual([]);
      expect(result.candidates).toEqual([]);
      expect(result.state.levels[0].lastTouchBarIndex).toBe(-1);
    }
  });

  // 5.
  it("a level unarmed at the start of the bar yields nothing, even when this bar's close arms it", () => {
    const result = run([...GREEN_AT_120, ...repeat(doji(110), 5), [110, 126, 110, 125]]);
    expect(result.immediateCandidates).toEqual([]);
    expect(result.state.levels[0]).toMatchObject({ armed: true, armedBarIndex: 7 });
  });
});

// ===========================================================================
// What OHLC proves, and what it does not
// ===========================================================================

describe("proof flags", () => {
  it("a RED touch that closes AT ITS HIGH, from an open below the band, cannot prove entry before the close", () => {
    // open 75 < 79.2 and high == close: the high may have reached the band only on the closing update.
    const inside = run([...RED_AT_80, ...repeat(doji(75), 4), [75, 80.5, 75, 80.5]]);
    expect(inside.immediateCandidates.map((c) => c.proof.bandEnteredBeforeClosingUpdate)).toEqual([false]);
    const through = run([...RED_AT_80, ...repeat(doji(75), 4), [75, 81, 75, 81]]);
    expect(through.immediateCandidates.map((c) => c.proof.bandEnteredBeforeClosingUpdate)).toEqual([false]);
    expect(through.candidates).toEqual([]);
  });

  it("a GREEN bar that OPENS inside the band proves entry on its first update, even if it closes at its low", () => {
    // open 121 <= 120*(1.01): already in the band at the open; low == close does not matter.
    const result = run([...GREEN_AT_120, ...repeat(doji(125), 4), [121, 121, 119, 119]]);
    expect(result.immediateCandidates.map((c) => c.proof.bandEnteredBeforeClosingUpdate)).toEqual([true]);
  });

  it("a timeframe whose previous flags are UNKNOWN cannot push intrabar, so it puts no level at risk", () => {
    // Replay starts on Wednesday 2024-01-03 with 1D and 1W enabled. Through
    // Sunday the week's open is unknown, so 1W's committed flags are null.
    // Monday's bar touches two 1D levels; only 1D (flags known false) can push.
    const wednesday = Date.UTC(2024, 0, 3);
    const rows: Ohlc[] = [
      doji(100), // Wed
      [100, 120, 99, 99], // Thu: 1D GREEN @ 120 (id 0)
      doji(100), // Fri
      [100, 120, 99, 99], // Sat: 1D GREEN @ 120 (id 1)
      doji(125), // Sun: both arm
      TOUCH_120, // Mon: a complete week begins, but its previous flag was unknown
    ];
    const result = replayNativeEngineWithImmediate(
      barsFrom(wednesday, 24 * 60 * MINUTE_MS, rows),
      config({ enabledSourceTfs: ["1D", "1W"], maxLevels: 4, minBarsAfterArming: 1, minBarsAfterCreation: 1 })
    );
    // 2 levels + at most 2 pushes (1D only) - 4 = 0 at risk.
    expect(result.immediateCandidates.map((c) => [c.level.id, c.proof.levelPresentOnEveryUpdate])).toEqual([
      [0, true],
      [1, true],
    ]);
  });
});

// ===========================================================================
// Thresholds come from the PRE-BAR committed state
// ===========================================================================

describe("thresholds are read from the state committed at the previous close", () => {
  // 6. close-through bars, so only the IMMEDIATE basis can fire at all.
  it("minBarsAfterArming: none at armed+3, one at armed+4", () => {
    const isolate = { minBarsAfterCreation: 1, touchCooldownBars: 50 };
    const prefix = [...GREEN_AT_120, ...repeat(doji(110), 7)]; // armed on bar 9
    expect(bars(run([...prefix, ...repeat(doji(125), 3), THROUGH_120], isolate).immediateCandidates)).toEqual([]);
    expect(bars(run([...prefix, ...repeat(doji(125), 4), THROUGH_120], isolate).immediateCandidates)).toEqual([13]);
  });

  // 7.
  it("minBarsAfterCreation: none at created+4, one at created+5", () => {
    const isolate = { minBarsAfterArming: 1, touchCooldownBars: 50 };
    expect(bars(run([...GREEN_AT_120, ...repeat(doji(125), 3), THROUGH_120], isolate).immediateCandidates)).toEqual([]);
    expect(bars(run([...GREEN_AT_120, ...repeat(doji(125), 4), THROUGH_120], isolate).immediateCandidates)).toEqual([6]);
  });

  // 8.
  it("cooldown: blocked at committed lastTouch+9, allowed at +10", () => {
    const rows = [...GREEN_AT_120, ...repeat(doji(125), 4), TOUCH_120, ...repeat(doji(125), 8), TOUCH_120, TOUCH_120];
    const result = run(rows);
    expect(bars(result.immediateCandidates)).toEqual([6, 16]);
    expect(bars(result.candidates)).toEqual([6, 16]);
  });

  // 9.
  it("band edges are inclusive, at Pine's own L*(1±t)", () => {
    const L = 1.1; // where L*(1+t) > L+L*t and L*(1-t) < L-L*t
    const green = (touchLow: number) =>
      run([doji(1.0), [1.0, 1.1, 0.99, 0.99], ...repeat(doji(1.15), 4), [1.15, 1.15, touchLow, 1.15]]).immediateCandidates;
    expect(bars(green(upper(L)))).toEqual([6]);
    expect(green(upper(L) * (1 + 1e-12))).toEqual([]);

    const red = (touchHigh: number) =>
      run([doji(1.2), [1.2, 1.2, 1.1, 1.19], ...repeat(doji(1.05), 4), [1.05, touchHigh, 1.05, 1.05]]).immediateCandidates;
    expect(bars(red(lower(L)))).toEqual([6]);
    expect(red(lower(L) * (1 - 1e-12))).toEqual([]);
  });

  // 10.
  it("previous close must be strictly beyond the band: LONG needs > upper, SHORT needs < lower", () => {
    const greenPrefix = [...GREEN_AT_120, ...repeat(doji(125), 3)];
    expect(run([...greenPrefix, doji(upper(120)), THROUGH_120]).immediateCandidates).toEqual([]);
    expect(bars(run([...greenPrefix, doji(upper(120) * (1 + 1e-9)), THROUGH_120]).immediateCandidates)).toEqual([6]);

    const redPrefix = [...RED_AT_80, ...repeat(doji(75), 3)];
    expect(run([...redPrefix, doji(lower(80)), TOUCH_80]).immediateCandidates).toEqual([]);
    expect(bars(run([...redPrefix, doji(lower(80) * (1 - 1e-9)), TOUCH_80]).immediateCandidates)).toEqual([6]);
  });
});

// ===========================================================================
// Immediate candidates commit nothing
// ===========================================================================

describe("an immediate candidate commits nothing", () => {
  // 11.
  it("reconstruction never modifies the state it reads", () => {
    const rows = [...GREEN_AT_120, ...repeat(doji(125), 4), THROUGH_120];
    const daily = dailyBars(rows);
    const preBar = replayNativeEngine(daily.slice(0, 6), config()).state;
    const snapshot = JSON.stringify(preBar);
    expect(reconstructImmediateCandidates(preBar, daily[6])).toHaveLength(1);
    expect(JSON.stringify(preBar)).toBe(snapshot);
  });

  // 12.
  it("an immediate-only candidate writes no lastTouch: a retest 5 bars later still fires", () => {
    const rows = [
      ...GREEN_AT_120,
      ...repeat(doji(125), 4),
      THROUGH_120, // bar 6: immediate only; disarmed at the close
      doji(125), // bar 7: re-arms
      ...repeat(doji(125), 3),
      TOUCH_120, // bar 11: 5 bars after bar 6 — would be blocked if bar 6 had committed a cooldown
    ];
    const atSix = run(rows.slice(0, 7));
    expect(atSix.state.levels[0].lastTouchBarIndex).toBe(-1);
    const full = run(rows);
    expect(bars(full.immediateCandidates)).toEqual([6, 11]);
    expect(bars(full.candidates)).toEqual([11]);
  });

  // 13.
  it("when the close also commits, BOTH bases are reported for the same level and bar — nothing is merged", () => {
    const result = run([...GREEN_AT_120, ...repeat(doji(125), 4), TOUCH_120]);
    const all: NativeCandidate[] = [...result.immediateCandidates, ...result.candidates];
    expect(all.map((c) => [c.basis, c.chartBarIndex, c.level.id])).toEqual([
      ["IMMEDIATE_INTRABAR", 6, 0],
      ["COMMITTED_BAR_CLOSE", 6, 0],
    ]);
  });
});

// ===========================================================================
// Multiple levels, duplicates, and the same-bar registration boundary
// ===========================================================================

describe("multiple levels and same-bar registration", () => {
  // 14.
  it("reconstructs every qualifying level, oldest first, without discarding later ones", () => {
    const result = run([doji(100), [100, 120, 99, 99], ...repeat(doji(125), 4), THROUGH_120], {
      enabledSourceTfs: ["1D", "1W", "1M", "3M", "6M", "12M"],
    });
    expect(result.immediateCandidates.map((c) => [c.level.id, c.sourceTf])).toEqual([
      [0, "1D"],
      [1, "1W"],
      [2, "1M"],
      [3, "3M"],
      [4, "6M"],
      [5, "12M"],
    ]);
    expect(result.candidates).toEqual([]);
  });

  // 15.
  it("levels at the same price keep independent state", () => {
    // id 0 created bar 1, id 1 created bar 3, both @ 120, both armed on bar 4.
    const rows: Ohlc[] = [
      doji(100),
      [100, 120, 99, 99],
      doji(100),
      [100, 120, 99, 99],
      doji(125),
      doji(125),
      TOUCH_120, // bar 6: id 0 is old enough (5), id 1 is not (3)
      TOUCH_120, // bar 7: id 0 cooling down, id 1 still young
      TOUCH_120, // bar 8: id 1 old enough (5)
    ];
    const result = run(rows, { minBarsAfterArming: 1 });
    expect(result.immediateCandidates.map((c) => [c.chartBarIndex, c.level.id, c.levelPrice])).toEqual([
      [6, 0, 120],
      [8, 1, 120],
    ]);
  });

  // 16.
  it("a level registered by this bar's own close is never reconstructed as an intrabar candidate", () => {
    // Bar 6 closes 118 on every higher timeframe's forming candle (open 100,
    // high 125): (125-118)/100 = 0.07 -> GOG registers GREEN @ 125 on 1W..12M
    // AT THE CLOSE. Those levels did not exist at the start of the bar.
    const result = run([doji(100), [100, 120, 99, 99], ...repeat(doji(125), 4), [125, 125, 117, 118]], {
      enabledSourceTfs: ["1D", "1W", "1M", "3M", "6M", "12M"],
    });
    const registeredThisBar = result.registrations.filter((l) => l.createdBarIndex === 6);
    expect(registeredThisBar.map((l) => [l.id, l.sourceTf, l.price])).toEqual([
      [6, "1W", 125],
      [7, "1M", 125],
      [8, "3M", 125],
      [9, "6M", 125],
      [10, "12M", 125],
    ]);
    expect(ids(result.immediateCandidates)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  // 17.
  describe("MAX_LEVELS: a level that might be evicted intrabar is flagged, never invented or hidden", () => {
    // Two GREEN @ 120 levels (ids 0 and 1), both armed on bar 4. Bar 5 touches
    // the band and its red forming day (high 140) registers GREEN @ 140 at the
    // close. With the 1D flags known false before the bar, up to two levels can
    // be pushed on ANY intrabar update.
    const rows: Ohlc[] = [
      doji(100),
      [100, 120, 99, 99],
      doji(100),
      [100, 120, 99, 99],
      doji(125),
      [125, 140, 120, 121],
    ];
    const at = (maxLevels: number) => run(rows, { maxLevels, minBarsAfterArming: 1, minBarsAfterCreation: 1 });

    it("maxLevels 2: both pre-bar levels may be pushed out intrabar; id 0 is evicted at the close", () => {
      const result = at(2);
      expect(result.immediateCandidates.map((c) => [c.level.id, c.proof.levelPresentOnEveryUpdate])).toEqual([
        [0, false],
        [1, false],
      ]);
      expect(result.evictions.map((l) => l.id)).toEqual([0]);
      expect(ids(result.candidates)).toEqual([1]);
    });

    it("maxLevels 3: only the oldest is at risk", () => {
      const result = at(3);
      expect(result.immediateCandidates.map((c) => [c.level.id, c.proof.levelPresentOnEveryUpdate])).toEqual([
        [0, false],
        [1, true],
      ]);
      expect(ids(result.candidates)).toEqual([0, 1]);
    });

    it("maxLevels 4: nothing is at risk", () => {
      const result = at(4);
      expect(result.immediateCandidates.map((c) => c.proof.levelPresentOnEveryUpdate)).toEqual([true, true]);
    });

    it("the level registered at the close (id 2) never appears as an immediate candidate", () => {
      for (const maxLevels of [2, 3, 4, 500]) {
        const result = at(maxLevels);
        expect(result.registrations.map((l) => l.id)).toContain(2);
        expect(ids(result.immediateCandidates)).not.toContain(2);
      }
    });
  });
});

// ===========================================================================
// Gates, validation, and agreement with the committed engine
// ===========================================================================

describe("gates and validation", () => {
  const rows = [...GREEN_AT_120, ...repeat(doji(125), 4), THROUGH_120];

  it("'Bar Close' timing sends no intrabar alert, so nothing is reconstructed", () => {
    expect(run(rows, { timing: "Bar Close" }).immediateCandidates).toEqual([]);
  });

  it("with the retest loop disabled (Pine line 297) nothing is reconstructed", () => {
    expect(run(rows, { retestEnabled: false }).immediateCandidates).toEqual([]);
  });

  it("the first bar has no close[1] and reconstructs nothing", () => {
    const state = createNativeEngineState(config());
    expect(reconstructImmediateCandidates(state, dailyBars([doji(100)])[0])).toEqual([]);
  });

  it("refuses a malformed or non-contiguous bar exactly as the committed engine does", () => {
    const daily = dailyBars(rows);
    const preBar = replayNativeEngine(daily.slice(0, 6), config()).state;
    expect(codeOf(() => reconstructImmediateCandidates(preBar, { ...daily[6], high: 1 }))).toBe("INVALID_KLINE");
    expect(codeOf(() => reconstructImmediateCandidates(preBar, daily[5]))).toBe("NON_CONTIGUOUS_BARS");
  });
});

/**
 * A seeded 15m "market" like the Slice 1 causality fixture, but with closes
 * moving up to ±3% per bar. The Slice 1 walk (±1%) almost never touches a ±1%
 * band AND closes through it in one bar, so it holds no immediate-only
 * candidates — and the invariants below would pass vacuously on it.
 */
function noisyFifteenMinuteBars(count: number, seed: number): NativeKline[] {
  const next = lcg(seed);
  const rows: Ohlc[] = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const close = Math.max(1, open * (1 + (next() - 0.5) * 0.06));
    let high = Math.max(open, close) * (1 + next() * 0.004);
    let low = Math.min(open, close) * (1 - next() * 0.004);
    const shock = next();
    if (shock < 0.01) high = Math.max(open, close) * 1.09;
    else if (shock < 0.02) low = Math.min(open, close) * 0.91;
    rows.push([open, high, low, close]);
    price = close;
  }
  return barsFrom(T_2024_01_01, 15 * MINUTE_MS, rows);
}

describe("agreement with the committed engine, over a 4000-bar all-timeframe fixture", () => {
  const noisy = noisyFifteenMinuteBars(4000, 20240101);
  const allTfs = createNativeEngineConfig({ minMovePct: 0.07 });
  const withImmediate = replayNativeEngineWithImmediate(noisy, allTfs);
  const key = (c: { chartBarIndex: number; level: { id: number } }) => `${c.chartBarIndex}:${c.level.id}`;

  it("leaves every committed output exactly as Slice 1 computes it", () => {
    const committed = replayNativeEngine(noisy, allTfs);
    expect({
      state: withImmediate.state,
      candidates: withImmediate.candidates,
      registrations: withImmediate.registrations,
      evictions: withImmediate.evictions,
    }).toEqual(committed);
  });

  it("finds immediate-only candidates in the fixture, so the invariants below are not vacuous", () => {
    const committedKeys = new Set(withImmediate.candidates.map(key));
    expect(withImmediate.immediateCandidates.length).toBeGreaterThan(withImmediate.candidates.length);
    expect(withImmediate.immediateCandidates.filter((c) => !committedKeys.has(key(c))).length).toBeGreaterThan(0);
  });

  it("every committed candidate was also an immediate candidate (the close can only be stricter)", () => {
    const immediateKeys = new Set(withImmediate.immediateCandidates.map(key));
    expect(withImmediate.candidates.filter((c) => !immediateKeys.has(key(c)))).toEqual([]);
  });

  it("every immediate candidate refers to a level that existed before its bar", () => {
    expect(withImmediate.immediateCandidates.filter((c) => c.level.createdBarIndex >= c.chartBarIndex)).toEqual([]);
  });

  it("an immediate candidate without a committed one is explained only by a disarm or an eviction at that close", () => {
    let state: NativeEngineState = createNativeEngineState(allTfs);
    const unexplained: string[] = [];
    for (const bar of noisy) {
      const step = stepNativeEngineWithImmediate(state, bar);
      const committedIds = new Set(step.candidates.map((c) => c.level.id));
      for (const candidate of step.immediateCandidates) {
        if (committedIds.has(candidate.level.id)) continue;
        const after = step.state.levels.find((l: NativeLevel) => l.id === candidate.level.id);
        const evicted = step.evicted.some((l) => l.id === candidate.level.id);
        if (!(evicted || (after !== undefined && !after.armed))) unexplained.push(key(candidate));
      }
      state = step.state;
    }
    expect(unexplained).toEqual([]);
  });

  // 18.
  it("is deterministic, and stepping reproduces the replay without modifying any input", () => {
    expect(replayNativeEngineWithImmediate(noisy, allTfs)).toEqual(withImmediate);
    let state: NativeEngineState = createNativeEngineState(allTfs);
    const immediate: NativeImmediateCandidate[] = [];
    const committed: NativeRetestCandidate[] = [];
    let modifiedInputs = 0;
    for (const bar of noisy) {
      const snapshot = JSON.stringify(state);
      const step = stepNativeEngineWithImmediate(state, bar);
      if (JSON.stringify(state) !== snapshot) modifiedInputs += 1;
      expect(step.candidates).toEqual(stepNativeEngine(state, bar).candidates);
      immediate.push(...step.immediateCandidates);
      committed.push(...step.candidates);
      state = step.state;
    }
    expect(modifiedInputs).toBe(0);
    expect(immediate).toEqual(withImmediate.immediateCandidates);
    expect(committed).toEqual(withImmediate.candidates);
  });

  it("labels every candidate with its basis", () => {
    expect(new Set(withImmediate.immediateCandidates.map((c) => c.basis))).toEqual(new Set(["IMMEDIATE_INTRABAR"]));
    expect(new Set(withImmediate.candidates.map((c) => c.basis))).toEqual(new Set(["COMMITTED_BAR_CLOSE"]));
  });
});
