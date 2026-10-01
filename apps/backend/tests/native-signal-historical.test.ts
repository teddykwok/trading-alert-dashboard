import { describe, expect, it } from "vitest";
import {
  NATIVE_HISTORICAL_STATE_SEMANTICS,
  NativeSignalInputError,
  PINE_V5_FIRST_HISTORY_BAR_NO_EDGE,
  SWITCHOVER_TRUNCATED_CLOSED_BARS,
  createNativeEngineConfig,
  reconstructPineHistoricalState,
  replayNativeEngine,
  stepNativeEngine,
  type NativeCandidate,
  type NativeEngineConfig,
  type NativeEngineConfigInput,
  type NativeEngineState,
  type NativeHistoricalResult,
  type NativeHistoricalTouch,
  type NativeKline,
  type NativeRetestCandidate,
} from "@trading-alert-dashboard/shared";

import { canonicalJson } from "./helpers/native-signal-canonical";
import { DAY_MS, HOUR_MS, T_2024_01_01, barsFrom, dailyBars, doji, type Ohlc } from "./helpers/native-signal-fixtures";
import { goldenFixtures } from "./helpers/native-signal-golden-fixtures";

/**
 * Slice 2B-1 — Pine-compatible HISTORICAL state reconstruction.
 *
 * Pine computes history with request.security(..., lookahead_on): every
 * historical chart bar of an HTF period sees that period's FINAL candle. The
 * reconstruction replays exactly that, then hands a complete NativeEngineState
 * to the unchanged causal engine at a fixed switchover S (a chart-bar open).
 *
 * Strongest oracle used below: on DAILY chart bars with only 1D enabled, every
 * chart bar is its own HTF period, so the historical projection and the causal
 * forming candle coincide — the reconstruction must then equal the causal
 * replay exactly, for every fixture and every switchover.
 */

const D = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const config = (input: Partial<NativeEngineConfigInput> = {}) => createNativeEngineConfig({ minMovePct: 0.07, ...input });

function dailyRange(fromMs: number, toExclusiveMs: number, rowAt: (ms: number) => Ohlc): NativeKline[] {
  const rows: Ohlc[] = [];
  for (let t = fromMs; t < toExclusiveMs; t += DAY_MS) rows.push(rowAt(t));
  return barsFrom(fromMs, DAY_MS, rows);
}

function reconstruct(input: {
  config: NativeEngineConfig;
  bars: readonly NativeKline[];
  switchoverMs?: number;
  historyStartMs?: number;
  contextBars?: readonly NativeKline[];
}): NativeHistoricalResult {
  return reconstructPineHistoricalState({
    config: input.config,
    bars: input.bars,
    contextBars: input.contextBars ?? [],
    historyStartMs: input.historyStartMs ?? input.bars[0].openTimeMs,
    switchoverMs: input.switchoverMs ?? input.bars[input.bars.length - 1].closeTimeMs + 1,
    partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
  });
}

const regs = (r: NativeHistoricalResult) =>
  r.report.registrations.map((l) => [l.id, l.sourceTf, l.condition, l.color, l.price, l.createdBarIndex]);
const touchesAsCommitted = (touches: readonly NativeHistoricalTouch[]) =>
  touches.map((t) => ({
    basis: "COMMITTED_BAR_CLOSE",
    signal: t.signal,
    touchDirection: t.touchDirection,
    levelColor: t.levelColor,
    sourceTf: t.sourceTf,
    levelPrice: t.levelPrice,
    chartBarIndex: t.chartBarIndex,
    chartBarOpenTimeMs: t.chartBarOpenTimeMs,
    chartBarCloseTimeMs: t.chartBarCloseTimeMs,
    level: t.level,
  }));
const codeOf = (thunk: () => unknown) => {
  try {
    thunk();
    return null;
  } catch (error) {
    return error instanceof NativeSignalInputError ? error.code : `unexpected: ${String(error)}`;
  }
};

// ---------------------------------------------------------------------------
// Shared calendar fixtures (daily chart bars)
// ---------------------------------------------------------------------------

/** Flat context: every 2023 period is complete and qualifies for nothing. */
const CONTEXT_2023 = dailyRange(D(2023, 1, 1), D(2023, 12, 25), () => doji(100));
/** Chart history begins on Monday 2023-12-25; 2024-01-01 is chart bar 7. */
const HISTORY_START = D(2023, 12, 25);

/** Flat 100 until a red spike day (low 80, close 99) on 2024-05-15, then flat 99 through 2024. */
const LONG_SPIKE = dailyRange(HISTORY_START, D(2025, 1, 1), (t) =>
  t < D(2024, 5, 15) ? doji(100) : t === D(2024, 5, 15) ? [100, 100, 80, 99] : doji(99)
);

/** Same shape, spike on 2024-05-14, the bar before the switchover S = 2024-05-15. */
const S_SPAN = D(2024, 5, 15);
function spanBars(afterS: (t: number) => Ohlc): NativeKline[] {
  return dailyRange(HISTORY_START, D(2024, 5, 21), (t) =>
    t < D(2024, 5, 14) ? doji(100) : t === D(2024, 5, 14) ? [100, 100, 85, 99] : afterS(t)
  );
}

// ===========================================================================
// Historical projection: FINAL candles, one edge per period
// ===========================================================================

describe("historical projection uses each period's FINAL candle", () => {
  it("1D: registers at the day's first chart bar at the FINAL high, where the causal engine used the high so far", () => {
    // 6h chart. Day 1: the first bar reaches 108 (already 8% above the open),
    // the second 115; the day closes red at 99.2.
    const rows: Ohlc[] = [
      ...Array.from({ length: 4 }, () => doji(100)),
      [100, 108, 99.5, 99.8],
      [99.8, 115, 99, 99.5],
      doji(99.2),
      doji(99.2),
      ...Array.from({ length: 4 }, () => doji(99.2)),
    ];
    const bars = barsFrom(T_2024_01_01, 6 * HOUR_MS, rows);
    const cfg = config({ enabledSourceTfs: ["1D"] });
    const historical = reconstruct({ config: cfg, bars });
    expect(regs(historical)).toEqual([[0, "1D", "GOR", "GREEN", 115, 4]]);
    expect(historical.report.registrations[0]).toMatchObject({
      htfPeriodStartMs: T_2024_01_01 + DAY_MS,
      createdBarOpenTimeMs: T_2024_01_01 + DAY_MS,
    });
    const causal = replayNativeEngine(bars, cfg);
    expect(causal.registrations.map((l) => [l.condition, l.price, l.createdBarIndex])).toEqual([["GOR", 108, 4]]);
  });

  it("1W: registers on the week's Monday at the week's final high", () => {
    const rows: Ohlc[] = [
      ...Array.from({ length: 7 }, () => doji(100)),
      [100, 104, 99, 101], // Mon 2024-01-08: GOG so far (104-101)/100 = 3%
      [101, 112, 100, 101], // Tue: 112
      ...Array.from({ length: 5 }, () => doji(101.5)),
      ...Array.from({ length: 7 }, () => doji(101.5)),
    ];
    // Week 2: O 100, H 112, L 99, C 101.5 -> GOG (112-101.5)/100 = 10.5%, ROG 1%.
    const r = reconstruct({ config: config({ enabledSourceTfs: ["1W"] }), bars: dailyBars(rows) });
    expect(regs(r)).toEqual([[0, "1W", "GOG", "GREEN", 112, 7]]);
    expect(r.report.registrations[0].createdBarOpenTimeMs).toBe(D(2024, 1, 8));
  });

  it("1M: registers on the 1st of the month at the month's final low", () => {
    const bars = dailyRange(D(2024, 1, 1), D(2024, 3, 6), (t) =>
      t < D(2024, 2, 10) ? doji(100) : t === D(2024, 2, 10) ? [100, 100, 85, 99] : doji(99)
    );
    // February: O 100, L 85, C 99 -> ROR (99-85)/99 = 14%; January flat.
    const r = reconstruct({ config: config({ enabledSourceTfs: ["1M"] }), bars });
    expect(regs(r)).toEqual([[0, "1M", "ROR", "RED", 85, 31]]);
    expect(r.report.registrations[0].createdBarOpenTimeMs).toBe(D(2024, 2, 1));
  });

  it.each([
    ["3M", 98, D(2024, 4, 1)],
    ["6M", 7, D(2024, 1, 1)],
    ["12M", 7, D(2024, 1, 1)],
  ] as const)("%s: registers at the period's first chart bar at the final low", (tf, barIndex, periodStart) => {
    const r = reconstruct({ config: config({ enabledSourceTfs: [tf] }), bars: LONG_SPIKE, contextBars: CONTEXT_2023, historyStartMs: HISTORY_START });
    expect(regs(r)).toEqual([[0, tf, "ROR", "RED", 80, barIndex]]);
    expect(r.report.registrations[0]).toMatchObject({ htfPeriodStartMs: periodStart, createdBarOpenTimeMs: periodStart });
  });

  it("forming flips inside one historical period never re-register: causal 4 levels, historical 1", () => {
    const rows: Ohlc[] = [
      ...Array.from({ length: 4 }, () => doji(100)),
      [100, 110, 100, 101], // green so far: GOG 9%
      [101, 101, 98, 98.5], // red so far: GOR 10%
      [98.5, 103, 98, 102], // green again: GOG 8%
      [102, 102, 99, 99.5], // red at the close: GOR 10%
      ...Array.from({ length: 4 }, () => doji(99.5)),
    ];
    const bars = barsFrom(T_2024_01_01, 6 * HOUR_MS, rows);
    const cfg = config({ enabledSourceTfs: ["1D"] });
    expect(replayNativeEngine(bars, cfg).registrations).toHaveLength(4);
    expect(regs(reconstruct({ config: cfg, bars }))).toEqual([[0, "1D", "GOR", "GREEN", 110, 4]]);
  });

  it("consecutive qualifying periods: true -> true makes no new edge; true -> false -> true does", () => {
    const Q: Ohlc = [100, 110, 99, 99];
    const r = reconstruct({ config: config({ enabledSourceTfs: ["1D"] }), bars: dailyBars([doji(100), Q, Q, doji(100), Q]) });
    expect(r.report.registrations.map((l) => l.createdBarIndex)).toEqual([1, 4]);
  });

  it("a doji has no flags, whatever its wicks", () => {
    const r = reconstruct({ config: config({ enabledSourceTfs: ["1D"] }), bars: dailyBars([doji(100), doji(100, 130, 70), doji(100)]) });
    expect(r.report.registrations).toEqual([]);
  });

  it("red registers GOR then ROR, green GOG then ROG, with Pine's asymmetries intact", () => {
    const cfg = config({ enabledSourceTfs: ["1D"] });
    const red = reconstruct({ config: cfg, bars: dailyBars([doji(100), [100, 120, 80, 99]]) });
    expect(regs(red).map((r) => r.slice(2, 5))).toEqual([["GOR", "GREEN", 120], ["ROR", "RED", 80]]);
    const green = reconstruct({ config: cfg, bars: dailyBars([doji(100), [100, 130, 85, 110]]) });
    expect(regs(green).map((r) => r.slice(2, 5))).toEqual([["GOG", "GREEN", 130], ["ROG", "RED", 85]]);
    // GOG measures high - CLOSE: (110-105)/100 = 5% although high - open is 10%.
    expect(reconstruct({ config: cfg, bars: dailyBars([doji(100), [100, 110, 95, 105]]) }).report.registrations).toEqual([]);
    // ROR divides by CLOSE: (100-93)/100 = 7% qualifies although /open (200) would not.
    expect(regs(reconstruct({ config: cfg, bars: dailyBars([doji(200), [200, 200, 93, 100]]) })).map((r) => r.slice(2, 5))).toEqual([
      ["ROR", "RED", 93],
    ]);
  });

  it("registration order on one bar is D -> W -> M -> 3M -> 6M -> 12M, and GOR before ROR", () => {
    const bars = dailyRange(HISTORY_START, D(2025, 1, 1), (t) =>
      t < D(2024, 1, 1) ? doji(100) : t === D(2024, 1, 1) ? [100, 120, 80, 99] : doji(99)
    );
    const r = reconstruct({ config: config(), bars, contextBars: CONTEXT_2023, historyStartMs: HISTORY_START });
    const expected: unknown[] = [];
    ["1D", "1W", "1M", "3M", "6M", "12M"].forEach((tf, k) =>
      expected.push([2 * k, tf, "GOR", "GREEN", 120, 7], [2 * k + 1, tf, "ROR", "RED", 80, 7])
    );
    expect(regs(r)).toEqual(expected);
  });
});

// ===========================================================================
// Full state: reconstruction == causal where the projections coincide
// ===========================================================================

const dailyGolden = goldenFixtures().filter((f) => f.config.enabledSourceTfs.join() === "1D" && f.bars[1].openTimeMs - f.bars[0].openTimeMs === DAY_MS);

describe("full committed state (daily chart, 1D only: historical == causal)", () => {
  it("covers the 2B-0 daily fixtures", () => {
    expect(dailyGolden.map((f) => f.name).sort()).toEqual(
      [
        "arm-disarm-rearm-retest",
        "cooldown-and-wrong-side",
        "fifo-overflow",
        "immediate-eviction-risk",
        "immediate-proof-flags",
        "multiple-levels-same-bar",
      ].sort()
    );
  });

  for (const f of dailyGolden) {
    it(`${f.name}: state at EVERY switchover equals the causal replay; touches equal its committed candidates`, () => {
      for (let k = 1; k <= f.bars.length; k += 1) {
        const switchoverMs = f.bars[k - 1].closeTimeMs + 1;
        const r = reconstruct({ config: f.config, bars: f.bars, switchoverMs });
        const causal = replayNativeEngine(f.bars.slice(0, k), f.config);
        expect(canonicalJson(r.state)).toBe(canonicalJson(causal.state));
        expect(r.report.registrations).toEqual(causal.registrations);
        expect(r.report.evictions).toEqual(causal.evictions);
        expect(touchesAsCommitted(r.report.touches)).toEqual(causal.candidates);
      }
    });
  }

  it("FIFO: MAX_LEVELS evicts exactly the oldest during reconstruction", () => {
    const f = dailyGolden.find((x) => x.name === "fifo-overflow")!;
    const r = reconstruct({ config: f.config, bars: f.bars });
    expect(r.report.evictions.map((l) => l.id)).toEqual([0, 1, 2]);
    expect(r.state.levels.map((l) => l.id)).toEqual([3, 4, 5]);
  });

  it("arm / disarm state is reconstructed bar by bar", () => {
    const f = dailyGolden.find((x) => x.name === "arm-disarm-rearm-retest")!;
    const at = (k: number) => reconstruct({ config: f.config, bars: f.bars, switchoverMs: f.bars[k].openTimeMs }).state.levels[0];
    expect([3, 4, 5, 6, 7].map((k) => [at(k).armed, at(k).armedBarIndex])).toEqual([
      [true, 2],
      [true, 2],
      [false, -1],
      [false, -1],
      [true, 6],
    ]);
  });

  it("a qualifying historical retest writes lastTouch and is reported only as a non-actionable touch", () => {
    const f = dailyGolden.find((x) => x.name === "arm-disarm-rearm-retest")!;
    const r = reconstruct({ config: f.config, bars: f.bars });
    expect(r.state.levels[0].lastTouchBarIndex).toBe(10);
    expect(r.report.touches.map((t) => [t.chartBarIndex, t.signal, t.level.id, t.actionable, t.basis])).toEqual([
      [10, "LONG", 0, false, "HISTORICAL_STATE_WRITE"],
    ]);
  });

  it("several qualifying levels on one historical bar: EVERY one gets its cooldown written", () => {
    const f = dailyGolden.find((x) => x.name === "multiple-levels-same-bar")!;
    const r = reconstruct({ config: f.config, bars: f.bars, switchoverMs: f.bars[12].openTimeMs });
    expect(r.report.touches.map((t) => [t.chartBarIndex, t.level.id])).toEqual([
      [11, 0],
      [11, 1],
    ]);
    expect(r.state.levels.map((l) => [l.id, l.lastTouchBarIndex])).toEqual([
      [0, 11],
      [1, 11],
      [2, -1],
    ]);
  });

  it("an Immediate-only touch (closes through the band) is no state write and no touch", () => {
    const f = dailyGolden.find((x) => x.name === "immediate-proof-flags")!;
    const r = reconstruct({ config: f.config, bars: f.bars, switchoverMs: f.bars[8].openTimeMs });
    expect(r.report.touches).toEqual([]);
    expect(r.state.levels[0]).toMatchObject({ armed: false, armedBarIndex: -1, lastTouchBarIndex: -1 });
  });
});

// ===========================================================================
// Nothing actionable, nothing that looks like a candidate
// ===========================================================================

describe("reconstruction produces no candidate and nothing actionable", () => {
  const f = dailyGolden.find((x) => x.name === "cooldown-and-wrong-side")!;
  const r = reconstruct({ config: f.config, bars: f.bars });

  it("returns only state and report, and no object anywhere carries a candidate basis", () => {
    expect(Object.keys(r).sort()).toEqual(["report", "state"]);
    expect(Object.keys(r.report)).not.toContain("candidates");
    expect(Object.keys(r.report)).not.toContain("immediateCandidates");
    const bases: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (typeof record.basis === "string") bases.push(record.basis);
        Object.values(record).forEach(walk);
      }
    };
    walk(r);
    expect(r.report.touches.length).toBe(3);
    expect(new Set(bases)).toEqual(new Set(["HISTORICAL_STATE_WRITE"]));
  });

  it("every touch is literally non-actionable, and the type system keeps it out of candidate positions", () => {
    expect(r.report.touches.every((t) => t.actionable === false && t.basis === "HISTORICAL_STATE_WRITE")).toBe(true);
    const touch: NativeHistoricalTouch = r.report.touches[0];
    // Compile-time guards (checked by tsc, not by vitest): a historical touch
    // can never be passed where a candidate is expected, and can never claim
    // to be actionable. If either assignment ever type-checks, the now-unused
    // expect-error directive fails the typecheck.
    // @ts-expect-error a historical state write is not a NativeCandidate
    const asCandidate: NativeCandidate = touch;
    // @ts-expect-error a historical state write is never actionable
    const actionable: NativeHistoricalTouch = { ...touch, actionable: true };
    expect(asCandidate.basis).toBe("HISTORICAL_STATE_WRITE");
    expect(actionable.level.id).toBe(touch.level.id);
  });

  it("the report states its fixed semantics", () => {
    expect(r.report).toMatchObject({
      semantics: NATIVE_HISTORICAL_STATE_SEMANTICS,
      firstHistoryBar: PINE_V5_FIRST_HISTORY_BAR_NO_EDGE,
      partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
    });
  });
});

// ===========================================================================
// The switchover boundary
// ===========================================================================

describe("switchover boundary (S is a chart-bar OPEN)", () => {
  const f = dailyGolden.find((x) => x.name === "cooldown-and-wrong-side")!;
  const k = 9; // S = open of bar 9; the historical touch at bar 7 still cools bar 9
  const S = f.bars[k].openTimeMs;
  const r = reconstruct({ config: f.config, bars: f.bars, switchoverMs: S });

  it("the last historical bar opens at S - interval; S itself was not processed", () => {
    expect(r.state.lastBar?.openTimeMs).toBe(S - DAY_MS);
    expect(r.state.barIndex).toBe(k);
    expect(r.report.chartBarCount).toBe(k);
  });

  it("the causal engine continues at S with no reset, gap or duplicate, and history's cooldown still applies", () => {
    let state: NativeEngineState = r.state;
    const candidates: NativeRetestCandidate[] = [];
    for (const bar of f.bars.slice(k)) {
      const step = stepNativeEngine(state, bar);
      candidates.push(...step.candidates);
      state = step.state;
    }
    const causal = replayNativeEngine(f.bars, f.config);
    expect(canonicalJson(state)).toBe(canonicalJson(causal.state));
    // Bar 9 is a touch 2 bars after the historical touch at 7: still cooling down.
    expect(candidates.map((c) => c.chartBarIndex)).toEqual([17, 27]);
    expect(candidates).toEqual(causal.candidates.filter((c) => c.chartBarIndex >= k));
  });

  it("re-processing the last historical bar, or skipping bar S, is refused by the causal engine", () => {
    expect(codeOf(() => stepNativeEngine(r.state, f.bars[k - 1]))).toBe("NON_CONTIGUOUS_BARS");
    expect(codeOf(() => stepNativeEngine(r.state, f.bars[k + 1]))).toBe("NON_CONTIGUOUS_BARS");
    expect(stepNativeEngine(r.state, f.bars[k]).state.barIndex).toBe(k + 1);
  });

  it("refuses ranges it cannot reconstruct honestly", () => {
    const base = { config: f.config, bars: f.bars, contextBars: [], partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS } as const;
    const first = f.bars[0].openTimeMs;
    const cases: [string, Parameters<typeof reconstructPineHistoricalState>[0]][] = [
      ["S not on a bar open", { ...base, historyStartMs: first, switchoverMs: S + HOUR_MS }],
      ["S before history", { ...base, historyStartMs: first, switchoverMs: first }],
      ["bars not starting at history", { ...base, historyStartMs: first + DAY_MS, switchoverMs: S }],
      ["bars ending before S", { ...base, historyStartMs: first, switchoverMs: f.bars[f.bars.length - 1].closeTimeMs + 1 + DAY_MS }],
      ["context not adjacent", { ...base, historyStartMs: first, switchoverMs: S, contextBars: dailyBars([doji(100)], first - 2 * DAY_MS) }],
      [
        "unapproved partial-period policy",
        { ...base, historyStartMs: first, switchoverMs: S, partialPeriodPolicy: "USE_FUTURE" as typeof SWITCHOVER_TRUNCATED_CLOSED_BARS },
      ],
    ];
    for (const [label, input] of cases) {
      expect({ label, code: codeOf(() => reconstructPineHistoricalState(input)) }).toEqual({ label, code: "INVALID_HISTORY_RANGE" });
    }
  });
});

// ===========================================================================
// HTF periods that contain the switchover: closed bars before S only
// ===========================================================================

describe("periods spanning the switchover are truncated to closed bars before S", () => {
  const cfg = config();
  const run = (afterS: (t: number) => Ohlc) =>
    reconstruct({ config: cfg, bars: spanBars(afterS), contextBars: CONTEXT_2023, historyStartMs: HISTORY_START, switchoverMs: S_SPAN });
  const r = run(() => doji(99));

  it.each([
    ["1W", 140, D(2024, 5, 13)],
    ["1M", 128, D(2024, 5, 1)],
    ["3M", 98, D(2024, 4, 1)],
    ["6M", 7, D(2024, 1, 1)],
    ["12M", 7, D(2024, 1, 1)],
  ] as const)("%s: registered at the period's first bar from the truncated candle", (tf, barIndex, periodStart) => {
    const level = r.report.registrations.find((l) => l.sourceTf === tf);
    expect(level).toMatchObject({ condition: "ROR", price: 85, createdBarIndex: barIndex, htfPeriodStartMs: periodStart });
    const handoff = r.report.handoffPeriods.find((p) => p.sourceTf === tf);
    expect(handoff).toMatchObject({ truncatedAtSwitchover: true, periodStartMs: periodStart, lastChartBarIndex: 141 });
    expect(handoff?.candle).toEqual({ periodStartMs: periodStart, open: 100, high: 100, low: 85, close: 99, complete: true });
  });

  it("the day before S is a complete period, not a truncated one", () => {
    expect(r.report.handoffPeriods.find((p) => p.sourceTf === "1D")).toMatchObject({ truncatedAtSwitchover: false, periodStartMs: D(2024, 5, 14) });
  });

  it("hands over exactly the HTF tracks the causal engine holds after the last historical bar", () => {
    const causal = replayNativeEngine([...CONTEXT_2023, ...spanBars(() => doji(99)).slice(0, 142)], cfg);
    expect(canonicalJson(r.state.htf)).toBe(canonicalJson(causal.state.htf));
    expect(r.state.htf["1W"]?.previousFlags).toEqual({ GOR: false, ROR: true, GOG: false, ROG: false });
  });

  it("a poisoned bar AT S does not change state_S or the report", () => {
    const poisoned = run((t) => (t === S_SPAN ? [99, 140, 40, 60] : doji(99)));
    expect(canonicalJson(poisoned)).toBe(canonicalJson(r));
  });

  it("poisoned bars AFTER S — even invalid ones — do not change state_S or the report", () => {
    const poisoned = run((t) => (t === S_SPAN ? doji(99) : [10, 5, 50, 1]));
    expect(canonicalJson(poisoned)).toBe(canonicalJson(r));
  });
});

// ===========================================================================
// First history bar and context
// ===========================================================================

describe("first history bar and context bars", () => {
  const Q: Ohlc = [100, 110, 99, 99];

  it("the first history bar creates NO edge, even when its period qualifies (PINE_V5_FIRST_HISTORY_BAR_NO_EDGE)", () => {
    const cfg = config({ enabledSourceTfs: ["1D"] });
    const r = reconstruct({ config: cfg, bars: dailyBars([Q, doji(100), Q]) });
    expect(r.report.registrations.map((l) => l.createdBarIndex)).toEqual([2]);
    expect(r.report.firstHistoryBarFlags).toEqual([{ sourceTf: "1D", condition: "GOR" }]);
    expect(r.report.unknownPreviousFlagEdges).toEqual([]);
    // One bar earlier, the same day is no longer the first bar and registers.
    const earlier = reconstruct({ config: cfg, bars: dailyBars([doji(100), Q, doji(100), Q], T_2024_01_01 - DAY_MS) });
    expect(earlier.report.registrations.map((l) => l.createdBarIndex)).toEqual([1, 3]);
  });

  it("without context, a period that began before the history stays UNKNOWN and enables no edge", () => {
    const r = reconstruct({ config: config({ enabledSourceTfs: ["6M", "12M"] }), bars: LONG_SPIKE });
    expect(r.report.registrations).toEqual([]);
    expect(r.report.unknownPreviousFlagEdges).toEqual([
      { sourceTf: "6M", condition: "ROR", chartBarIndex: 7 },
      { sourceTf: "12M", condition: "ROR", chartBarIndex: 7 },
    ]);
    expect(r.report.incompletePeriods).toEqual([
      { sourceTf: "6M", periodStartMs: D(2023, 7, 1) },
      { sourceTf: "12M", periodStartMs: D(2023, 1, 1) },
    ]);
  });

  it("with context the same periods are known, and the edges register", () => {
    const r = reconstruct({ config: config({ enabledSourceTfs: ["6M", "12M"] }), bars: LONG_SPIKE, contextBars: CONTEXT_2023, historyStartMs: HISTORY_START });
    expect(regs(r)).toEqual([
      [0, "6M", "ROR", "RED", 80, 7],
      [1, "12M", "ROR", "RED", 80, 7],
    ]);
    expect(r.report.incompletePeriods).toEqual([]);
    expect(r.report).toMatchObject({ contextStartMs: D(2023, 1, 1), contextBarCount: CONTEXT_2023.length });
  });

  it("context bars get no bar index, create no level, arm nothing and touch nothing", () => {
    const cfg = config({ enabledSourceTfs: ["1D", "1W"] });
    const bars = LONG_SPIKE.slice(0, 200);
    const S = bars[199].closeTimeMs + 1;
    // A wild context that only changes periods no chart bar belongs to.
    const wild = dailyRange(D(2023, 12, 4), HISTORY_START, (t) => (t % (2 * DAY_MS) === 0 ? [100, 150, 50, 51] : [51, 150, 50, 149]));
    const without = reconstruct({ config: cfg, bars, switchoverMs: S });
    const withContext = reconstruct({ config: cfg, bars, switchoverMs: S, contextBars: wild, historyStartMs: HISTORY_START });
    expect(withContext.state.barIndex).toBe(200);
    expect(canonicalJson(withContext.state)).toBe(canonicalJson(without.state));
    expect(withContext.report.touches).toEqual(without.report.touches);
    expect(withContext.report.registrations.every((l) => l.createdBarOpenTimeMs >= HISTORY_START)).toBe(true);
  });
});

// ===========================================================================
// Determinism and purity of inputs
// ===========================================================================

describe("determinism", () => {
  it("the same bytes and inputs rebuild a byte-identical state and report, and inputs are never modified", () => {
    const bars = spanBars(() => doji(99));
    const before = canonicalJson([bars, CONTEXT_2023]);
    const a = reconstruct({ config: config(), bars, contextBars: CONTEXT_2023, historyStartMs: HISTORY_START, switchoverMs: S_SPAN });
    const copy = JSON.parse(JSON.stringify([bars, CONTEXT_2023])) as [NativeKline[], NativeKline[]];
    const b = reconstruct({ config: config(), bars: copy[0], contextBars: copy[1], historyStartMs: HISTORY_START, switchoverMs: S_SPAN });
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson([bars, CONTEXT_2023])).toBe(before);
  });
});
