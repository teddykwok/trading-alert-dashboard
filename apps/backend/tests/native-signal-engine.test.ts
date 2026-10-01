import { describe, expect, it } from "vitest";
import {
  NATIVE_LEVEL_CONDITIONS,
  NATIVE_SOURCE_TF_ORDER,
  NativeSignalInputError,
  PINE_V55_INPUT_DEFAULTS,
  SOURCE_TIMEFRAMES,
  createNativeEngineConfig,
  createNativeEngineState,
  evaluateLevelConditions,
  pinePercentInputToFraction,
  replayNativeEngine,
  stepNativeEngine,
  type NativeEngineConfigInput,
  type NativeEngineState,
  type NativeHtfAggregate,
  type NativeKline,
  type NativeLevel,
  type NativeRetestCandidate,
} from "@trading-alert-dashboard/shared";
import {
  DAY_MS,
  HOUR_MS,
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
 * Slice 1 — the pure Pine v5.5 engine, line by line against
 * docs/pine/teddy-v5.5-current.pine.
 *
 * Most scenarios run on DAILY chart bars with only the 1D source enabled, so
 * each chart bar is exactly one complete 1D candle and every fixture states the
 * candle it reasons about. Doji bars (close == open) are used as "plain" bars:
 * a doji can never create a level, so they move price without side effects.
 */

const TOLERANCE = PINE_V55_INPUT_DEFAULTS.touchTolerancePct;
/** Pine's exact operand order (lines 267-268, 300-301). */
const upper = (level: number) => level * (1 + TOLERANCE);
const lower = (level: number) => level * (1 - TOLERANCE);

function config(overrides: Partial<NativeEngineConfigInput> = {}) {
  return createNativeEngineConfig({ minMovePct: 0.07, enabledSourceTfs: ["1D"], ...overrides });
}

function run(rows: readonly Ohlc[], overrides: Partial<NativeEngineConfigInput> = {}) {
  return replayNativeEngine(dailyBars(rows), config(overrides));
}

function complete(open: number, high: number, low: number, close: number): NativeHtfAggregate {
  return { periodStartMs: 0, open, high, low, close, complete: true };
}

function codeOf(thunk: () => unknown): string | null {
  try {
    thunk();
    return null;
  } catch (error) {
    return error instanceof NativeSignalInputError ? error.code : `not a NativeSignalInputError: ${String(error)}`;
  }
}

const summary = (levels: readonly NativeLevel[]) =>
  levels.map(({ id, sourceTf, condition, color, price, createdBarIndex }) => ({
    id,
    sourceTf,
    condition,
    color,
    price,
    createdBarIndex,
  }));

/** GREEN @ 120 from a red day with a 20% upper wick, registered on bar 1. */
const GREEN_AT_120: Ohlc[] = [doji(100), [100, 120, 99, 99]];
/** RED @ 80 from a red day whose close sits 19% above its low, registered on bar 1. */
const RED_AT_80: Ohlc[] = [doji(100), [100, 101, 80, 99]];
/** A touch of the 120 band from above that neither breaks nor re-arms. */
const TOUCH_120: Ohlc = doji(122, 122, 120);
/** A touch of the 80 band from below. */
const TOUCH_80: Ohlc = doji(78, 79.5, 78);

// ===========================================================================
// Configuration
// ===========================================================================

describe("configuration is explicit", () => {
  it("has NO default move threshold: neither Pine's 15% nor production's 7% is assumed", () => {
    expect("minMovePct" in PINE_V55_INPUT_DEFAULTS).toBe(false);
    expect(codeOf(() => createNativeEngineConfig({} as NativeEngineConfigInput))).toBe("INVALID_CONFIG");
  });

  it("keeps Pine's defaults for every other input", () => {
    const c = createNativeEngineConfig({ minMovePct: 0.07 });
    expect(c).toMatchObject({
      touchTolerancePct: 0.01,
      touchCooldownBars: 10,
      minBarsAfterCreation: 5,
      minBarsAfterArming: 4,
      maxLevels: 500,
      retestEnabled: true,
      timing: "Immediate",
      enabledSourceTfs: ["1D", "1W", "1M", "3M", "6M", "12M"],
      calendar: { weekStartsOnUtcDay: 1, multiMonthAnchorMonth: 0 },
    });
  });

  it("converts Pine percentage inputs with Pine's own division", () => {
    expect(pinePercentInputToFraction(7)).toBe(0.07);
    expect(pinePercentInputToFraction(15)).toBe(0.15);
    expect(pinePercentInputToFraction(1)).toBe(0.01);
  });

  it("uses the same timeframe vocabulary as the alert pipeline", () => {
    expect([...NATIVE_SOURCE_TF_ORDER]).toEqual([...SOURCE_TIMEFRAMES]);
    expect([...NATIVE_LEVEL_CONDITIONS]).toEqual(["GOR", "ROR", "GOG", "ROG"]);
  });

  it.each([
    ["negative minMovePct", { minMovePct: -0.01 }],
    ["NaN minMovePct", { minMovePct: Number.NaN }],
    ["tolerance of 1", { minMovePct: 0.07, touchTolerancePct: 1 }],
    ["zero cooldown (Pine minval=1)", { minMovePct: 0.07, touchCooldownBars: 0 }],
    ["zero minBarsAfterCreation", { minMovePct: 0.07, minBarsAfterCreation: 0 }],
    ["zero minBarsAfterArming (would allow a retest on the arming bar)", { minMovePct: 0.07, minBarsAfterArming: 0 }],
    ["fractional maxLevels", { minMovePct: 0.07, maxLevels: 2.5 }],
    ["unknown timeframe", { minMovePct: 0.07, enabledSourceTfs: ["2D"] }],
    ["duplicate timeframe", { minMovePct: 0.07, enabledSourceTfs: ["1D", "1D"] }],
    ["unknown timing", { minMovePct: 0.07, timing: "Later" }],
    ["week anchor 7", { minMovePct: 0.07, calendar: { weekStartsOnUtcDay: 7, multiMonthAnchorMonth: 0 } }],
    ["month anchor 12", { minMovePct: 0.07, calendar: { weekStartsOnUtcDay: 1, multiMonthAnchorMonth: 12 } }],
  ])("refuses %s", (_label, input) => {
    expect(codeOf(() => createNativeEngineConfig(input as NativeEngineConfigInput))).toBe("INVALID_CONFIG");
  });

  it("holds enabled timeframes in Pine's order whatever order they are given in", () => {
    expect(createNativeEngineConfig({ minMovePct: 0.07, enabledSourceTfs: ["12M", "1W", "1D"] }).enabledSourceTfs).toEqual(
      ["1D", "1W", "12M"]
    );
  });
});

// ===========================================================================
// BAGIAN 2 — level conditions on the forming HTF candle (lines 202-209)
// ===========================================================================

describe("level conditions", () => {
  // 1. all four conditions
  it.each([
    ["GOR: red, |high-open|/open", [100, 110, 95, 98], { GOR: true, ROR: false, GOG: false, ROG: false }],
    ["ROR: red, |close-low|/close", [100, 100, 90, 97], { GOR: false, ROR: true, GOG: false, ROG: false }],
    ["GOG: green, |high-close|/open", [100, 118, 100, 110], { GOR: false, ROR: false, GOG: true, ROG: false }],
    ["ROG: green, |open-low|/open", [100, 101, 92, 101], { GOR: false, ROR: false, GOG: false, ROG: true }],
  ] as const)("%s", (_label, [open, high, low, close], expected) => {
    expect(evaluateLevelConditions(complete(open, high, low, close), 0.07)).toEqual(expected);
  });

  // 2. ROR denominator is close
  it("ROR divides by CLOSE: (100-93)/100 = 0.07 qualifies although (100-93)/200 would not", () => {
    expect(evaluateLevelConditions(complete(200, 200, 93, 100), 0.07)?.ROR).toBe(true);
  });

  // 3. GOG numerator is high-close (and the other numerators/denominators are Pine's)
  it("GOG measures high-CLOSE: (110-105)/100 = 0.05 fails although high-open would pass", () => {
    expect(evaluateLevelConditions(complete(100, 110, 100, 105), 0.07)?.GOG).toBe(false);
  });

  it("GOG divides by OPEN: (214-200)/100 = 0.14 passes 0.1 although /close would be 0.07", () => {
    expect(evaluateLevelConditions(complete(100, 214, 100, 200), 0.1)?.GOG).toBe(true);
  });

  it("GOR measures high-OPEN over OPEN; ROG measures open-LOW over OPEN", () => {
    // GOR: (105-100)/100 = 0.05 fails; high-close would be 0.15.
    expect(evaluateLevelConditions(complete(100, 105, 90, 90), 0.07)?.GOR).toBe(false);
    // GOR: 6/100 fails; 6/close(50) would pass.
    expect(evaluateLevelConditions(complete(100, 106, 50, 50), 0.07)?.GOR).toBe(false);
    // ROG: (100-95)/100 = 0.05 fails; close-low would be 0.15.
    expect(evaluateLevelConditions(complete(100, 110, 95, 110), 0.07)?.ROG).toBe(false);
    // ROG: 7/100 passes; 7/close(200) would not.
    expect(evaluateLevelConditions(complete(100, 200, 93, 200), 0.07)?.ROG).toBe(true);
  });

  // 4. doji
  it("a doji is neither red nor green, whatever its wicks", () => {
    expect(evaluateLevelConditions(complete(100, 200, 50, 100), 0.07)).toEqual({
      GOR: false,
      ROR: false,
      GOG: false,
      ROG: false,
    });
  });

  // 5. / 6. exact boundary and just below
  it("the threshold is inclusive (>=): exactly 7% qualifies, 6.99% does not", () => {
    expect(evaluateLevelConditions(complete(100, 107, 99, 99), 0.07)?.GOR).toBe(true);
    expect(evaluateLevelConditions(complete(100, 106.99, 99, 99), 0.07)?.GOR).toBe(false);
  });

  // 41. arbitrary thresholds
  it.each([
    [0, true],
    [0.05, true],
    [0.07, true],
    [0.1, true],
    [0.1000001, false],
    [0.15, false],
    [0.5, false],
  ])("a 10%% upper wick against minMovePct=%s qualifies: %s", (minMovePct, expected) => {
    expect(evaluateLevelConditions(complete(100, 110, 99, 99), minMovePct)?.GOR).toBe(expected);
  });

  it("an incomplete candle (unknown real open) yields unknown, not false", () => {
    expect(evaluateLevelConditions({ ...complete(100, 120, 99, 99), complete: false }, 0.07)).toBeNull();
  });
});

// ===========================================================================
// BAGIAN 3 — registration
// ===========================================================================

describe("registration", () => {
  // 7. / 13. one red candle -> GREEN then RED, in GOR -> ROR order
  it("one red candle can register GREEN at its high and RED at its low, GOR before ROR", () => {
    const { registrations } = run([doji(100), [100, 110, 80, 90]]);
    expect(summary(registrations)).toEqual([
      { id: 0, sourceTf: "1D", condition: "GOR", color: "GREEN", price: 110, createdBarIndex: 1 },
      { id: 1, sourceTf: "1D", condition: "ROR", color: "RED", price: 80, createdBarIndex: 1 },
    ]);
  });

  // 8. / 13. one green candle -> GREEN then RED, in GOG -> ROG order
  it("one green candle can register GREEN at its high and RED at its low, GOG before ROG", () => {
    const { registrations } = run([doji(100), [100, 120, 90, 110]]);
    expect(summary(registrations)).toEqual([
      { id: 0, sourceTf: "1D", condition: "GOG", color: "GREEN", price: 120, createdBarIndex: 1 },
      { id: 1, sourceTf: "1D", condition: "ROG", color: "RED", price: 90, createdBarIndex: 1 },
    ]);
  });

  it("the first bar never registers: Pine's `flag[1]` is na there", () => {
    expect(run([[100, 120, 99, 99]]).registrations).toEqual([]);
    expect(run([[100, 120, 99, 99], [99, 118, 98, 98]]).registrations).toEqual([]);
  });

  // 9. edge trigger across chart bars
  it("registers once when the projected flag rises, not on every chart bar that it stays true", () => {
    const sixHour = barsFrom(T_2024_01_01, 6 * HOUR_MS, [
      doji(100),
      [100, 110, 99, 99], // day 1 turns red with a 10% upper wick -> GOR rises
      [99, 99, 98, 98], // still GOR: no new level
      doji(98), // still GOR: no new level
      doji(98), // day 2 opens as a doji: GOR falls
      [98, 108, 97, 97], // GOR rises again
    ]);
    const { registrations } = replayNativeEngine(sixHour, config());
    expect(summary(registrations)).toEqual([
      { id: 0, sourceTf: "1D", condition: "GOR", color: "GREEN", price: 110, createdBarIndex: 1 },
      { id: 1, sourceTf: "1D", condition: "GOR", color: "GREEN", price: 108, createdBarIndex: 5 },
    ]);
  });

  // 10. consecutive qualifying periods
  it("a qualifying day that directly follows a qualifying day is NOT registered — the flag never fell", () => {
    const { registrations } = run([
      doji(100),
      [100, 120, 99, 99], // GOR
      [99, 115, 98, 98], // its own GOR candle (16%), but flag[1] is still true
      doji(98),
      [98, 110, 97, 97], // GOR after a fall
    ]);
    expect(registrations.map((l) => [l.price, l.createdBarIndex])).toEqual([
      [120, 1],
      [110, 4],
    ]);
  });

  // 11. realtime flapping
  it("re-registers inside ONE period when the forming candle flips colour, at the high so far each time", () => {
    const sixHour = barsFrom(T_2024_01_01, 6 * HOUR_MS, [
      doji(100),
      [100, 110, 99, 99], // forming day red: GOR @ 110
      [99, 112, 99, 105], // forming day green: GOG @ 112 ((112-105)/100 = 0.07)
      [105, 115, 95, 95], // forming day red again: GOR @ 115
    ]);
    const { registrations } = replayNativeEngine(sixHour, config());
    expect(registrations.map((l) => [l.condition, l.price, l.htfPeriodStartMs, l.createdBarIndex])).toEqual([
      ["GOR", 110, T_2024_01_01, 1],
      ["GOG", 112, T_2024_01_01, 2],
      ["GOR", 115, T_2024_01_01, 3],
    ]);
  });

  // 12. / 14. timeframe order and distinct duplicates
  it("registers timeframes 1D -> 1W -> 1M -> 3M -> 6M -> 12M, keeping equal prices as distinct levels", () => {
    // 2024-01-01 opens every period, so all six candles are complete.
    const rows: Ohlc[] = [doji(100), [100, 120, 99, 99]];
    for (const enabled of [undefined, ["12M", "6M", "3M", "1M", "1W", "1D"] as const]) {
      const { registrations } = run(rows, { enabledSourceTfs: enabled ? [...enabled] : undefined });
      expect(registrations.map((l) => [l.id, l.sourceTf, l.condition, l.price])).toEqual([
        [0, "1D", "GOR", 120],
        [1, "1W", "GOR", 120],
        [2, "1M", "GOR", 120],
        [3, "3M", "GOR", 120],
        [4, "6M", "GOR", 120],
        [5, "12M", "GOR", 120],
      ]);
    }
  });

  it("the same timeframe can register the same price twice as two levels", () => {
    const { registrations } = run([doji(100), [100, 120, 99, 99], doji(100), [100, 120, 99, 99]]);
    expect(registrations.map((l) => [l.id, l.price])).toEqual([
      [0, 120],
      [1, 120],
    ]);
  });

  // 15. MAX_LEVELS
  it("drops exactly the oldest level once the registry exceeds maxLevels", () => {
    const rows: Ohlc[] = [doji(100)];
    for (let k = 0; k < 4; k += 1) rows.push([100, 110 + k, 99, 99], doji(100));
    const { state, evictions } = run(rows, { maxLevels: 3 });
    expect(evictions.map((l) => l.id)).toEqual([0]);
    expect(state.levels.map((l) => [l.id, l.price])).toEqual([
      [1, 111],
      [2, 112],
      [3, 113],
    ]);
  });

  it("MAX_LEVELS 500 -> 501 drops only the oldest and keeps every remaining level's fields together", () => {
    const rows: Ohlc[] = [doji(100)];
    for (let k = 0; k <= 500; k += 1) rows.push([100, 110 + k * 0.01, 99, 99], doji(100));
    const { state, registrations, evictions } = run(rows);
    expect(registrations).toHaveLength(501);
    expect(evictions.map((l) => l.id)).toEqual([0]);
    expect(state.levels).toHaveLength(500);
    state.levels.forEach((level, index) => {
      const id = index + 1;
      expect([level.id, level.price, level.createdBarIndex]).toEqual([id, 110 + id * 0.01, 2 * id + 1]);
    });
  });

  it("a timeframe whose real open is unknown registers nothing until a complete period begins", () => {
    // Start on Wednesday 2024-01-03 with only 1W enabled: the week began Monday.
    const wednesday = Date.UTC(2024, 0, 3);
    const bars = barsFrom(wednesday, DAY_MS, [
      doji(100), // Wed
      [100, 120, 99, 99], // Thu: a 20% upper wick, but this week's open is unknown
      doji(99), // Fri
      doji(99), // Sat
      doji(99), // Sun
      doji(99), // Mon 2024-01-08: a complete week begins; flag known false
      [99, 115, 98, 98], // Tue: GOR rises from a KNOWN false
    ]);
    const { registrations } = replayNativeEngine(bars, config({ enabledSourceTfs: ["1W"] }));
    expect(registrations.map((l) => [l.sourceTf, l.price, l.createdBarIndex, l.htfPeriodStartMs])).toEqual([
      ["1W", 115, 6, Date.UTC(2024, 0, 8)],
    ]);
  });

  it("an unknown previous flag never enables an edge, even on the first complete bar", () => {
    const wednesday = Date.UTC(2024, 0, 3);
    const bars = barsFrom(wednesday, DAY_MS, [
      ...repeat(doji(100), 5), // Wed..Sun, week open unknown
      [100, 115, 98, 98], // Mon: complete week, qualifies, but flag[1] was unknown
      doji(98), // Tue: still qualifies -> flag[1] true
    ]);
    expect(replayNativeEngine(bars, config({ enabledSourceTfs: ["1W"] })).registrations).toEqual([]);
  });

  it("a hidden timeframe (Pine's show* input) registers nothing", () => {
    const { registrations } = run([doji(100), [100, 120, 99, 99]], { enabledSourceTfs: ["1W", "1M"] });
    expect(registrations.map((l) => l.sourceTf)).toEqual(["1W", "1M"]);
  });
});

// ===========================================================================
// BAGIAN 4A — ARM / DISARM on the confirmed close
// ===========================================================================

describe("arm / disarm", () => {
  const level = (rows: Ohlc[]) => run(rows).state.levels[0];

  // 16.
  it("GREEN arms when close > level*(1+t)", () => {
    expect(level([...GREEN_AT_120, doji(125)])).toMatchObject({ armed: true, armedBarIndex: 2 });
    expect(level([...GREEN_AT_120, doji(upper(120))])).toMatchObject({ armed: false, armedBarIndex: -1 });
  });

  // 17.
  it("GREEN breaks when close < level*(1-t)", () => {
    expect(level([...GREEN_AT_120, doji(125), doji(118)])).toMatchObject({ armed: false, armedBarIndex: -1 });
    expect(level([...GREEN_AT_120, doji(125), doji(lower(120))])).toMatchObject({ armed: true, armedBarIndex: 2 });
  });

  // 18.
  it("RED arms when close < level*(1-t)", () => {
    expect(level([...RED_AT_80, doji(75)])).toMatchObject({ color: "RED", armed: true, armedBarIndex: 2 });
    expect(level([...RED_AT_80, doji(lower(80))])).toMatchObject({ armed: false });
  });

  // 19.
  it("RED breaks when close > level*(1+t)", () => {
    expect(level([...RED_AT_80, doji(75), doji(85)])).toMatchObject({ armed: false, armedBarIndex: -1 });
    expect(level([...RED_AT_80, doji(75), doji(upper(80))])).toMatchObject({ armed: true });
  });

  // 20.
  it("armedBar is set on the transition only, not on every bar that holds", () => {
    expect(level([...GREEN_AT_120, doji(125), doji(126), doji(127)])).toMatchObject({ armedBarIndex: 2 });
  });

  // 21.
  it("re-arming after a break records the NEW transition bar", () => {
    expect(level([...GREEN_AT_120, doji(125), doji(118), doji(125)])).toMatchObject({ armed: true, armedBarIndex: 4 });
  });

  it("arming updates even when the retest loop is disabled (line 262)", () => {
    expect(run([...GREEN_AT_120, doji(125)], { retestEnabled: false }).state.levels[0]).toMatchObject({
      armed: true,
      armedBarIndex: 2,
    });
  });
});

// ===========================================================================
// BAGIAN 4B — retest
// ===========================================================================

describe("retest", () => {
  const candidateBars = (rows: Ohlc[], overrides: Partial<NativeEngineConfigInput> = {}) =>
    run(rows, overrides).candidates.map((c) => c.chartBarIndex);

  // 22.
  it("minBarsAfterCreation: no retest at created+4, a retest at created+5", () => {
    const isolate = { minBarsAfterArming: 1, touchCooldownBars: 50 };
    expect(candidateBars([...GREEN_AT_120, ...repeat(doji(125), 3), TOUCH_120], isolate)).toEqual([]);
    expect(candidateBars([...GREEN_AT_120, ...repeat(doji(125), 4), TOUCH_120], isolate)).toEqual([6]);
  });

  // 23.
  it("minBarsAfterArming: no retest at armed+3, a retest at armed+4", () => {
    const isolate = { minBarsAfterCreation: 1, touchCooldownBars: 50 };
    const prefix = [...GREEN_AT_120, ...repeat(doji(110), 7)]; // armed on bar 9
    expect(candidateBars([...prefix, ...repeat(doji(125), 3), TOUCH_120], isolate)).toEqual([]);
    expect(candidateBars([...prefix, ...repeat(doji(125), 4), TOUCH_120], isolate)).toEqual([13]);
  });

  // 24.
  it("cooldown: blocked at lastTouch+9, allowed at lastTouch+10; a blocked touch does not restart it", () => {
    const rows = [...GREEN_AT_120, ...repeat(doji(125), 4), TOUCH_120, ...repeat(doji(125), 8), TOUCH_120, TOUCH_120];
    // touches on 6, 15 (6+9) and 16 (6+10)
    const result = run(rows);
    expect(result.candidates.map((c) => c.chartBarIndex)).toEqual([6, 16]);
    expect(result.state.levels[0].lastTouchBarIndex).toBe(16);
    expect(run(rows.slice(0, 16)).state.levels[0].lastTouchBarIndex).toBe(6);
  });

  // 25.
  it("a touch from below on an unarmed GREEN level starts no cooldown", () => {
    const rows: Ohlc[] = [
      ...GREEN_AT_120,
      ...repeat(doji(110), 3),
      [110, 119.5, 110, 119.5], // bar 5 rises into the band from below
      doji(125), // bar 6 arms
      ...repeat(doji(125), 3),
      TOUCH_120, // bar 10: only 5 bars after the wrong-side touch
    ];
    expect(run(rows.slice(0, 6)).state.levels[0].lastTouchBarIndex).toBe(-1);
    expect(run(rows).candidates.map((c) => c.chartBarIndex)).toEqual([10]);
  });

  it("an armed GREEN level touched from INSIDE the band starts no cooldown", () => {
    const rows: Ohlc[] = [
      ...GREEN_AT_120,
      doji(125), // bar 2 arms
      ...repeat(doji(120), 4), // bars 3..6 close inside the band: close[1] is not above it
      doji(125), // bar 7
      TOUCH_120, // bar 8: a real retest, 2 bars after bar 6
    ];
    expect(run(rows.slice(0, 7)).candidates).toEqual([]);
    expect(run(rows.slice(0, 7)).state.levels[0].lastTouchBarIndex).toBe(-1);
    expect(run(rows).candidates.map((c) => c.chartBarIndex)).toEqual([8]);
  });

  // 26.
  it("close[1] must be STRICTLY beyond the band on the approach side", () => {
    const greenPrefix = [...GREEN_AT_120, ...repeat(doji(125), 3)];
    expect(candidateBars([...greenPrefix, doji(upper(120)), TOUCH_120])).toEqual([]);
    expect(candidateBars([...greenPrefix, doji(upper(120) * (1 + 1e-9)), TOUCH_120])).toEqual([6]);

    const redPrefix = [...RED_AT_80, ...repeat(doji(75), 3)];
    expect(candidateBars([...redPrefix, doji(lower(80)), TOUCH_80])).toEqual([]);
    expect(candidateBars([...redPrefix, doji(lower(80) * (1 - 1e-9)), TOUCH_80])).toEqual([6]);
  });

  // 27.
  it("GREEN retested from above -> LONG FROM_ABOVE, with the level's identity", () => {
    const { candidates } = run([...GREEN_AT_120, ...repeat(doji(125), 4), TOUCH_120]);
    expect(candidates).toEqual<NativeRetestCandidate[]>([
      {
        basis: "COMMITTED_BAR_CLOSE",
        signal: "LONG",
        touchDirection: "FROM_ABOVE",
        levelColor: "GREEN",
        sourceTf: "1D",
        levelPrice: 120,
        chartBarIndex: 6,
        chartBarOpenTimeMs: T_2024_01_01 + 6 * DAY_MS,
        chartBarCloseTimeMs: T_2024_01_01 + 7 * DAY_MS - 1,
        level: {
          id: 0,
          condition: "GOR",
          htfPeriodStartMs: T_2024_01_01 + DAY_MS,
          createdBarIndex: 1,
          createdBarOpenTimeMs: T_2024_01_01 + DAY_MS,
        },
      },
    ]);
  });

  // 28.
  it("RED retested from below -> SHORT FROM_BELOW", () => {
    const { candidates } = run([...RED_AT_80, ...repeat(doji(75), 4), TOUCH_80]);
    expect(candidates.map((c) => [c.signal, c.touchDirection, c.levelColor, c.levelPrice, c.level.condition])).toEqual([
      ["SHORT", "FROM_BELOW", "RED", 80, "ROR"],
    ]);
  });

  // 29. band edges, and Pine's operand order
  it("band edges are inclusive, computed as level*(1±t) exactly as Pine writes them", () => {
    // At 1.1, Pine's 1.1*(1+0.01) is strictly ABOVE 1.1+1.1*0.01 and its
    // 1.1*(1-0.01) strictly BELOW 1.1-1.1*0.01, so a touch landing exactly on
    // Pine's band edge proves the operand order as well as the inclusion.
    const L = 1.1;
    expect(upper(L)).toBeGreaterThan(L + L * TOLERANCE);
    expect(lower(L)).toBeLessThan(L - L * TOLERANCE);

    const green = (touchLow: number) =>
      run([doji(1.0), [1.0, 1.1, 0.99, 0.99], ...repeat(doji(1.15), 4), [1.15, 1.15, touchLow, 1.15]]).candidates;
    expect(green(upper(L)).map((c) => [c.signal, c.levelPrice])).toEqual([["LONG", 1.1]]);
    expect(green(upper(L) * (1 + 1e-12))).toEqual([]);

    const red = (touchHigh: number) =>
      run([doji(1.2), [1.2, 1.2, 1.1, 1.19], ...repeat(doji(1.05), 4), [1.05, touchHigh, 1.05, 1.05]]).candidates;
    expect(red(lower(L)).map((c) => [c.signal, c.levelPrice])).toEqual([["SHORT", 1.1]]);
    expect(red(lower(L) * (1 - 1e-12))).toEqual([]);
  });

  // 30.
  it("ARM/DISARM runs before the retest: a touch that closes through the band does not fire", () => {
    const prefix = [...GREEN_AT_120, ...repeat(doji(125), 4)];
    const broken = run([...prefix, [125, 125, 118, 118]]); // closes below 120*(1-t): disarmed first
    expect(broken.candidates).toEqual([]);
    expect(broken.state.levels[0]).toMatchObject({ armed: false, lastTouchBarIndex: -1 });

    const held = run([...prefix, [125, 125, 119, 119]]); // closes inside the band: still armed
    expect(held.candidates.map((c) => c.chartBarIndex)).toEqual([6]);
  });

  // 31.
  it("fires oldest level first when several levels are retested on one bar", () => {
    const { candidates } = run([doji(100), [100, 120, 99, 99], ...repeat(doji(125), 4), TOUCH_120], {
      enabledSourceTfs: [...NATIVE_SOURCE_TF_ORDER],
    });
    expect(candidates.map((c) => [c.level.id, c.sourceTf, c.chartBarIndex])).toEqual([
      [0, "1D", 6],
      [1, "1W", 6],
      [2, "1M", 6],
      [3, "3M", 6],
      [4, "6M", 6],
      [5, "12M", 6],
    ]);
  });

  it("with the retest loop disabled there are no candidates and no cooldown", () => {
    const result = run([...GREEN_AT_120, ...repeat(doji(125), 4), TOUCH_120], { retestEnabled: false });
    expect(result.candidates).toEqual([]);
    expect(result.state.levels[0].lastTouchBarIndex).toBe(-1);
  });
});

// ===========================================================================
// Input the engine refuses rather than guesses about
// ===========================================================================

describe("input validation", () => {
  const ok = dailyBars([doji(100), doji(101)]);

  it("refuses a gap between bars", () => {
    expect(codeOf(() => replayNativeEngine([ok[0], { ...ok[1], openTimeMs: ok[1].openTimeMs + DAY_MS, closeTimeMs: ok[1].closeTimeMs + DAY_MS }], config()))).toBe(
      "NON_CONTIGUOUS_BARS"
    );
  });

  it("refuses a bar of a different interval", () => {
    expect(codeOf(() => replayNativeEngine([ok[0], { ...ok[1], closeTimeMs: ok[1].closeTimeMs - HOUR_MS }], config()))).toBe(
      "INCONSISTENT_INTERVAL"
    );
  });

  it.each([
    ["high below close", { high: 99 }],
    ["low above open", { low: 101 }],
    ["zero price", { open: 0, low: 0 }],
    ["NaN close", { close: Number.NaN }],
    ["non-integer time", { openTimeMs: ok[0].openTimeMs + 0.5 }],
  ])("refuses a malformed bar: %s", (_label, patch) => {
    expect(codeOf(() => replayNativeEngine([{ ...ok[0], ...patch } as NativeKline], config()))).toBe("INVALID_KLINE");
  });

  it("refuses a chart bar that spans an enabled HTF period boundary", () => {
    const weekly = barsFrom(T_2024_01_01, 7 * DAY_MS, [doji(100)]);
    expect(codeOf(() => replayNativeEngine(weekly, config({ enabledSourceTfs: ["1D"] })))).toBe(
      "BAR_STRADDLES_HTF_PERIOD"
    );
    expect(codeOf(() => replayNativeEngine(weekly, config({ enabledSourceTfs: ["1W"] })))).toBeNull();
  });
});

// ===========================================================================
// Causality, determinism, purity of step
// ===========================================================================

/**
 * Reproducible 15m "market": a seeded random walk with occasional large wicks,
 * across a month boundary, with every source timeframe enabled.
 */
function noisyFifteenMinuteBars(count: number, seed: number): NativeKline[] {
  const next = lcg(seed);
  const rows: Ohlc[] = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const close = Math.max(1, open * (1 + (next() - 0.5) * 0.02));
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

describe("causality and determinism", () => {
  const bars = noisyFifteenMinuteBars(4000, 20240101); // ~41 days, crosses Jan -> Feb
  const allTfs = createNativeEngineConfig({ minMovePct: 0.07 });
  const full = replayNativeEngine(bars, allTfs);

  it("the fixture is non-trivial: it registers levels and fires retests", () => {
    expect(full.registrations.length).toBeGreaterThan(20);
    expect(full.candidates.length).toBeGreaterThan(5);
    expect(new Set(full.registrations.map((l) => l.sourceTf)).size).toBeGreaterThan(1);
  });

  // 38. no future-bar leakage
  it("outputs up to bar k depend only on bars up to k (every prefix replays to the same history)", () => {
    for (const k of [1, 97, 500, 1500, 2880, 2977, 3999]) {
      const prefix = replayNativeEngine(bars.slice(0, k), allTfs);
      expect(prefix.registrations).toEqual(full.registrations.filter((l) => l.createdBarIndex < k));
      expect(prefix.candidates).toEqual(full.candidates.filter((c) => c.chartBarIndex < k));
    }
  });

  it("a monthly level registered early in the month sits at the high SO FAR, not the month's final high", () => {
    const rows: Ohlc[] = [doji(100), [100, 120, 99, 99], ...repeat(doji(99), 20), [99, 150, 99, 99]];
    const { registrations } = run(rows, { enabledSourceTfs: ["1M"] });
    expect(registrations[0]).toMatchObject({ sourceTf: "1M", price: 120, createdBarIndex: 1 });
  });

  // 39. determinism
  it("replays identically every time", () => {
    expect(replayNativeEngine(bars, allTfs)).toEqual(full);
  });

  it("stepping bar by bar reproduces the replay exactly, and never modifies the state it was given", () => {
    let state: NativeEngineState = createNativeEngineState(allTfs);
    const candidates: NativeRetestCandidate[] = [];
    const registrations: NativeLevel[] = [];
    const evictions: NativeLevel[] = [];
    let modifiedInputs = 0;
    for (const bar of bars) {
      // Checked on EVERY bar, so the bars that register, arm, disarm and
      // retest are all covered — a single quiet bar would prove nothing.
      const snapshot = JSON.stringify(state);
      const result = stepNativeEngine(state, bar);
      if (JSON.stringify(state) !== snapshot) modifiedInputs += 1;
      expect(result.state).not.toBe(state);
      expect(result.state.levels).not.toBe(state.levels);
      candidates.push(...result.candidates);
      registrations.push(...result.registered);
      evictions.push(...result.evicted);
      state = result.state;
    }
    expect(modifiedInputs).toBe(0);
    expect({ state, candidates, registrations, evictions }).toEqual(full);
  });

  it("a returned state shares no level object with the state it came from", () => {
    const before = replayNativeEngine(bars.slice(0, 2000), allTfs).state;
    const after = stepNativeEngine(before, bars[2000]).state;
    const shared = after.levels.filter((level) => before.levels.includes(level));
    expect(shared).toEqual([]);
  });

  it("timing mode does not change committed state (intrabar emission is out of Slice 1's scope)", () => {
    const barClose = replayNativeEngine(bars, createNativeEngineConfig({ minMovePct: 0.07, timing: "Bar Close" }));
    expect(barClose.candidates).toEqual(full.candidates);
    expect(barClose.registrations).toEqual(full.registrations);
    expect(barClose.state.levels).toEqual(full.state.levels);
    expect(full.candidates.every((c) => c.basis === "COMMITTED_BAR_CLOSE")).toBe(true);
  });
});

// ===========================================================================
// 40. / 41. Production-oriented fixture
// ===========================================================================

/**
 * The shape the preserved evidence describes: Binance perpetual, 15m chart,
 * every source timeframe shown, min move 7% (Pine input 7.0).
 *
 * Replay starts on Wednesday 2024-01-03 at 00:00 UTC, so only the 1D candle
 * has a known open; the week, month, quarter, half and year began earlier and
 * stay unknown — and silent — for the whole fixture.
 *
 *   day 1: flat at 100, then one 15m bar spikes to 107.5 and closes 99.8. The
 *          forming day is red with a 7.5% upper wick -> GREEN @ 107.5 (1D GOR).
 *   day 2: a smooth rally clears 107.5*(1.01) = 108.575 (arm), holds at 109,
 *          then dips to 108.2 -> LONG FROM_ABOVE on the 1D level.
 */
function productionFixture() {
  const rows: Ohlc[] = [];
  const spikeIndex = 40;
  for (let i = 0; i < 96; i += 1) {
    if (i < spikeIndex) rows.push(doji(100));
    else if (i === spikeIndex) rows.push([100, 107.5, 99.5, 99.8]);
    else rows.push(doji(99.8));
  }
  rows.push(doji(99.8)); // day 2 opens flat
  let price = 99.8;
  let armIndex = -1;
  for (let step = 1; step <= 23; step += 1) {
    const next = Math.round((99.8 + step * 0.4) * 100) / 100;
    rows.push([price, next, price, next]);
    if (armIndex < 0 && next > 107.5 * (1 + 0.01)) armIndex = rows.length - 1;
    price = next;
  }
  rows.push(...repeat(doji(109), 8));
  const touchIndex = rows.length;
  rows.push([109, 109, 108.2, 108.8]);
  rows.push(...repeat(doji(108.8), 4));
  const bars = barsFrom(Date.UTC(2024, 0, 3), 15 * MINUTE_MS, rows);
  return { bars, spikeIndex, armIndex, touchIndex };
}

describe("production-oriented fixture (15m, all timeframes, minMovePct from Pine input 7)", () => {
  const { bars, spikeIndex, armIndex, touchIndex } = productionFixture();
  const production = createNativeEngineConfig({ minMovePct: pinePercentInputToFraction(7) });

  it("registers exactly one 1D GREEN level at the spike and fires one LONG on the retest", () => {
    const { registrations, candidates, state } = replayNativeEngine(bars, production);
    expect(summary(registrations)).toEqual([
      { id: 0, sourceTf: "1D", condition: "GOR", color: "GREEN", price: 107.5, createdBarIndex: spikeIndex },
    ]);
    expect(state.levels[0]).toMatchObject({ armed: true, armedBarIndex: armIndex });
    expect(candidates.map((c) => [c.signal, c.touchDirection, c.sourceTf, c.levelPrice, c.chartBarIndex])).toEqual([
      ["LONG", "FROM_ABOVE", "1D", 107.5, touchIndex],
    ]);
  });

  it("the threshold is the caller's: 7.5% still registers, 7.51% and Pine's default 15% do not", () => {
    const at = (minMovePct: number) => replayNativeEngine(bars, createNativeEngineConfig({ minMovePct }));
    expect(at(0.075).registrations).toHaveLength(1);
    expect(at(0.0751).registrations).toEqual([]);
    const pineDefault = at(pinePercentInputToFraction(15));
    expect(pineDefault.registrations).toEqual([]);
    expect(pineDefault.candidates).toEqual([]);
  });

  it("and a 15% threshold registers when the market actually moves 15%", () => {
    const rows: Ohlc[] = [doji(100), [100, 115, 99, 99]];
    expect(run(rows, { minMovePct: 0.15 }).registrations.map((l) => l.price)).toEqual([115]);
    expect(run(rows, { minMovePct: 0.1501 }).registrations).toEqual([]);
  });
});
