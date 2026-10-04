import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NATIVE_DYNAMIC_HISTORICAL_STATE_SEMANTICS,
  NATIVE_HISTORICAL_STATE_SEMANTICS,
  NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1,
  SWITCHOVER_TRUNCATED_CLOSED_BARS,
  createNativeEngineConfig,
  createNativeEngineState,
  evaluateLevelConditions,
  reconstructHistoricalState,
  reconstructPineHistoricalState,
  replayNativeEngine,
  replayNativeEngineWithImmediate,
  retestTimerGates,
  stepNativeEngineWithImmediate,
  type NativeEngineConfig,
  type NativeEngineState,
  type NativeImmediateCandidate,
  type NativeKline,
  type NativeRetestCandidate,
  type NativeSourceTf,
} from "@trading-alert-dashboard/shared";

import { canonicalSha256 } from "../src/modules/native-scanner/canonical-json";
import { NATIVE_DYNAMIC_ENGINE_SEMANTICS, NATIVE_ENGINE_SEMANTICS } from "../src/modules/native-scanner/historical-replay";
import { ScannerLineageError, assertScannerLineage, buildScannerLineage } from "../src/modules/native-scanner/scanner-lineage";
import {
  ENGINE_NAMESPACE_SCHEMA,
  ScannerProfileError,
  TEDDY_7_ALL_ACTIVE_V1,
  TEDDY_AGGRESSIVE_V1,
  assertEngineNamespace,
  engineFingerprintOf,
  engineNamespaceDir,
  lineageConfigOf,
  profileSummaryOf,
} from "../src/modules/native-scanner/scanner-profile";
import { doji, repeat, type Ohlc } from "./helpers/native-signal-fixtures";
import { fifteenMinute } from "./helpers/native-scanner-fakes";

/**
 * TEDDY_DYNAMIC_SOURCE_LEVEL_V1 — the Teddy product rule for source levels.
 *
 * One forming candidate per (source TF, source period, colour) that follows the
 * period's running extreme, deactivates/reactivates with qualification without
 * ever duplicating, and becomes exactly one persistent level at the source close
 * — or none, if the closed candle no longer qualifies. Only persistent levels
 * arm and retest; timers mean N FULL 15m bars; an emitted Immediate alert always
 * consumes its cooldown. The legacy (PINE_V55_EDGE_FROZEN) engine is untouched.
 *
 * Synthetic scenarios use 15m chart bars and the 1D source (96 bars per day,
 * day 0 = Monday 2025-01-06). Regressions use committed public HUMAUSDT/BNBUSDT
 * 15m fixtures. No network, no database.
 */

const DAY0 = Date.UTC(2025, 0, 6);
const M15 = 15 * 60_000;
const DYNAMIC = NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1;
const config = (over: Partial<Parameters<typeof createNativeEngineConfig>[0]> = {}): NativeEngineConfig =>
  createNativeEngineConfig({ minMovePct: 0.07, touchTolerancePct: 0.01, touchCooldownBars: 10, minBarsAfterCreation: 5, minBarsAfterArming: 4, enabledSourceTfs: ["1D"], lifecycle: DYNAMIC, ...over });
const legacy = (over: Partial<Parameters<typeof createNativeEngineConfig>[0]> = {}) => config({ ...over, lifecycle: undefined });

interface Run {
  readonly states: NativeEngineState[]; // state AFTER bar i
  readonly registered: { bar: number; price: number; color: string; createdBarIndex: number; condition: string; htfPeriodStartMs: number }[];
  evicted: number;
  readonly committed: NativeRetestCandidate[];
  readonly immediate: NativeImmediateCandidate[];
}

function run(bars: readonly NativeKline[], cfg: NativeEngineConfig): Run {
  let state = createNativeEngineState(cfg);
  const out: Run = { states: [], registered: [], evicted: 0, committed: [], immediate: [] };
  bars.forEach((bar, i) => {
    const step = stepNativeEngineWithImmediate(state, bar);
    state = step.state;
    out.states.push(state);
    for (const l of step.registered) out.registered.push({ bar: i, price: l.price, color: l.color, createdBarIndex: l.createdBarIndex, condition: l.condition, htfPeriodStartMs: l.htfPeriodStartMs });
    out.evicted += step.evicted.length;
    out.committed.push(...step.candidates);
    out.immediate.push(...step.immediateCandidates);
  });
  return out;
}

const candidatesOf = (state: NativeEngineState, tf: NativeSourceTf = "1D") => state.htf[tf]?.candidates ?? null;
const day = (rows: Ohlc[]): Ohlc[] => {
  if (rows.length !== 96) throw new Error(`a day has 96 bars, got ${rows.length}`);
  return rows;
};

// Day 0: GREEN qualifies at bar 10 (GOG 9%), follows 110 -> 112, flickers off at bar 12, back on at
// bar 13 (115), turns red at bar 14 (GOR, same GREEN); RED qualifies at bar 15 (ROR) and follows 90 -> 88.
const DAY_A: Ohlc[] = day([
  ...repeat(doji(100), 10),
  [100, 110, 100, 101], // 10: GREEN created (GOG), price 110
  [101, 112, 101, 102], // 11: follows 112
  [102, 112, 102, 111], // 12: GOG 1% -> inactive
  [111, 115, 103, 103], // 13: active again, 115, same anchor
  [103, 103, 98, 98], //   14: red body -> GOR, still the same GREEN
  [98, 98, 90, 98], //     15: RED created (ROR 8.2%), price 90
  [98, 98, 88, 97], //     16: RED follows 88
  ...repeat(doji(97), 79),
]);

describe("one forming candidate per source period and colour", () => {
  const r = run(fifteenMinute(DAY0, DAY_A), config());
  const at = (i: number) => candidatesOf(r.states[i])!;

  it("1/2. 7% only gates: GREEN appears when a GREEN condition holds and its price is the running HIGH", () => {
    expect(at(9).GREEN).toBeNull();
    expect(at(10).GREEN).toMatchObject({ active: true, price: 110, condition: "GOG", firstQualifiedBarIndex: 10 });
    expect(at(11).GREEN).toMatchObject({ active: true, price: 112 });
  });

  it("6/9/10. qualification off -> inactive (price still follows); back on -> the SAME candidate, same anchor", () => {
    expect(at(12).GREEN).toMatchObject({ active: false, price: 112, firstQualifiedBarIndex: 10 });
    expect(at(13).GREEN).toMatchObject({ active: true, price: 115, firstQualifiedBarIndex: 10, firstQualifiedBarOpenTimeMs: DAY0 + 10 * M15 });
  });

  it("4. a body colour change GOG -> GOR stays ONE GREEN candidate", () => {
    expect(at(14).GREEN).toMatchObject({ active: true, price: 115, condition: "GOR", firstQualifiedBarIndex: 10 });
  });

  it("3/5. RED follows the running LOW in one candidate", () => {
    expect(at(14).RED).toBeNull();
    expect(at(15).RED).toMatchObject({ active: true, price: 90, condition: "ROR", firstQualifiedBarIndex: 15 });
    expect(at(16).RED).toMatchObject({ active: true, price: 88, firstQualifiedBarIndex: 15 });
  });

  it("7/8. a forming candidate is never a level: nothing to arm, retest or alert before the source close", () => {
    for (let i = 0; i < 95; i += 1) expect(r.states[i].levels).toHaveLength(0);
    expect(r.committed.length + r.immediate.length).toBe(0);
  });

  it("11. at the source close each still-qualifying colour becomes exactly ONE level at the final extreme", () => {
    expect(r.registered).toEqual([
      { bar: 95, price: 115, color: "GREEN", createdBarIndex: 10, condition: "GOR", htfPeriodStartMs: DAY0 },
      { bar: 95, price: 88, color: "RED", createdBarIndex: 15, condition: "ROR", htfPeriodStartMs: DAY0 },
    ]);
    expect(candidatesOf(r.states[95])).toEqual({ GREEN: null, RED: null });
  });

  it("a candidate from ANOTHER source period is never carried into this one (restored / tampered state)", () => {
    const restored = JSON.parse(JSON.stringify(r.states[50])) as NativeEngineState;
    const track = restored.htf["1D"] as { candidates: { GREEN: { periodStartMs: number } } };
    track.candidates.GREEN.periodStartMs = DAY0 - 86_400_000;
    const next = stepNativeEngineWithImmediate(restored, fifteenMinute(DAY0, DAY_A)[51]).state;
    // Day 0 still qualifies GREEN at bar 51: a NEW candidate anchored here, never the foreign anchor (bar 10).
    expect(candidatesOf(next)!.GREEN).toMatchObject({ periodStartMs: DAY0, firstQualifiedBarIndex: 51 });
  });

  it("legacy contrast: the same day leaves a ladder of frozen edge levels", () => {
    const old = run(fifteenMinute(DAY0, DAY_A), legacy());
    expect(old.registered.map((l) => `${l.color}@${l.price}`)).toEqual(["GREEN@110", "GREEN@115", "GREEN@115", "RED@90"]);
  });
});

describe("finalization and persistence", () => {
  it("12. a candidate that no longer qualifies at the source close is discarded: no level at all", () => {
    // GREEN qualifies at bar 10, then the day closes AT its high: GOG 0% at the close.
    const rows = day([...repeat(doji(100), 10), [100, 110, 100, 101], ...repeat(doji(101), 84), [101, 110, 101, 110]]);
    const r = run(fifteenMinute(DAY0, rows), config());
    expect(candidatesOf(r.states[94])!.GREEN).toMatchObject({ active: true, price: 110 });
    expect(candidatesOf(r.states[95])).toEqual({ GREEN: null, RED: null });
    expect(r.registered).toEqual([]);
  });

  it("13/14. the next source candle has its own candidate; finalized levels persist across later candles", () => {
    const day1 = day([...repeat(doji(97), 20), [97, 107, 97, 98], ...repeat(doji(98), 75)]); // GOG (107-98)/97 = 9.3%
    const r = run(fifteenMinute(DAY0, [...DAY_A, ...day1]), config());
    expect(candidatesOf(r.states[116])!.GREEN).toMatchObject({ periodStartMs: DAY0 + 86_400_000, firstQualifiedBarIndex: 116, price: 107 });
    expect(r.states[150].levels.map((l) => l.price)).toEqual([115, 88]);
    expect(r.registered.map((l) => `${l.color}@${l.price}#${l.createdBarIndex}`)).toEqual(["GREEN@115#10", "RED@88#15", "GREEN@107#116"]);
  });

  it("15. MAX_LEVELS counts finalized levels only: qualification flicker never grows the registry", () => {
    const flicker: Ohlc[] = [...repeat(doji(100), 4)];
    for (let k = 0; k < 30; k += 1) flicker.push([100, 110, 100, 101], [101, 110, 101, 109.5]); // GOG on, off, on, off ...
    const rows = day([...flicker, ...repeat(doji(101), 96 - flicker.length)]);
    const twoDays = fifteenMinute(DAY0, [...rows, ...rows]);
    const dyn = run(twoDays, config({ maxLevels: 2 }));
    expect(dyn.registered.map((l) => l.price)).toEqual([110, 110]);
    expect(dyn.evicted).toBe(0);
    const old = run(twoDays, legacy({ maxLevels: 2 }));
    expect(old.registered.length).toBeGreaterThan(30);
    expect(old.evicted).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Persistent levels: arming, direction, timers, cooldown
// ---------------------------------------------------------------------------

/** Day 0 ending with a final GREEN 110 (anchor `anchorBar`); upper band 111.1, lower 108.9. */
const greenDay = (anchorBar = 10): Ohlc[] => day([...repeat(doji(100), anchorBar), [100, 110, 100, 101], ...repeat(doji(101), 95 - anchorBar)]);
const TOUCH: Ohlc = [112, 112, 111, 112]; // from above into [108.9, 111.1], close back above
const ARM: Ohlc = [101, 112, 101, 112]; //   bar 96: close 112 > 111.1 -> ARMED

/** Day 1 rows after ARM at bar 96: doji(112) with `touches` replaced at absolute bar indexes. */
function day1(touches: Record<number, Ohlc>): Ohlc[] {
  const rows: Ohlc[] = [ARM];
  for (let i = 97; i < 192; i += 1) rows.push(touches[i] ?? doji(112));
  return rows;
}
const longsAt = (r: Run) => [...new Set([...r.committed, ...r.immediate].filter((c) => c.signal === "LONG").map((c) => c.chartBarIndex))].sort((a, b) => a - b);

describe("persistent levels: arm / disarm / direction", () => {
  it("16/18/19. GREEN arms only on a close above the upper band; a close below the lower band disarms it; the level stays and re-arms", () => {
    const rows = [...greenDay(), [101, 111.1, 101, 111.1] as Ohlc, ARM, ...repeat(doji(112), 3), [112, 112, 108, 108.5] as Ohlc, [108.5, 112, 108.5, 112] as Ohlc, ...repeat(doji(112), 89)];
    const r = run(fifteenMinute(DAY0, rows), config());
    const level = (i: number) => r.states[i].levels[0];
    expect(level(96)).toMatchObject({ price: 110, armed: false }); // close == upper band: not above it
    expect(level(97)).toMatchObject({ armed: true, armedBarIndex: 97 });
    expect(level(101)).toMatchObject({ armed: false, armedBarIndex: -1 }); // closed below 108.9
    expect(r.states[101].levels).toHaveLength(1); // disarmed, never deleted
    expect(level(102)).toMatchObject({ armed: true, armedBarIndex: 102 });
  });

  it("17/21. RED arms only below the lower band and retests as SHORT only from below; the entry is the exact level", () => {
    const redDay = day([...repeat(doji(100), 10), [100, 100, 90, 99], ...repeat(doji(99), 85)]); // ROR 9.1% -> final RED 90
    const day1rows: Ohlc[] = [[99, 99, 88, 88]]; // 96: close 88 < 89.1 -> ARMED
    for (let i = 97; i < 192; i += 1) day1rows.push(i === 101 ? [88, 89.2, 88, 88] : doji(88)); // 101: into [89.1, 90.9] from below
    const r = run(fifteenMinute(DAY0, [...redDay, ...day1rows]), config());
    expect(r.states[95].levels[0]).toMatchObject({ color: "RED", price: 90 });
    expect(r.states[96].levels[0]).toMatchObject({ armed: true, armedBarIndex: 96 });
    const shorts = [...r.committed, ...r.immediate].filter((c) => c.chartBarIndex === 101);
    expect(shorts.length).toBeGreaterThan(0);
    for (const c of shorts) expect(c).toMatchObject({ signal: "SHORT", touchDirection: "FROM_BELOW", levelPrice: 90 });
  });

  it("20/22. LONG only from above; a wrong-side (from below) touch alerts nothing and consumes no cooldown", () => {
    // Day 1 stays BELOW the level, pokes into the band from below at bar 100, then rises and arms, then retests from above.
    const rows: Ohlc[] = [...greenDay()];
    for (let i = 96; i < 192; i += 1) {
      rows.push(i === 100 ? [108, 109.5, 108, 108] : i === 105 ? [108, 112, 108, 112] : i >= 106 ? (i === 111 ? TOUCH : doji(112)) : doji(108));
    }
    const r = run(fifteenMinute(DAY0, rows), config());
    expect([...r.committed, ...r.immediate].some((c) => c.chartBarIndex === 100)).toBe(false);
    expect(r.states[100].levels[0].lastTouchBarIndex).toBe(-1);
    expect(longsAt(r)).toEqual([111]);
    for (const c of [...r.committed, ...r.immediate]) expect(c).toMatchObject({ signal: "LONG", touchDirection: "FROM_ABOVE", levelPrice: 110 });
  });

  it("27/28. the candidate price is the exact level — never the band edge, the touch low or the close", () => {
    const r = run(fifteenMinute(DAY0, [...greenDay(), ...day1({ 101: TOUCH })]), config());
    const fired = [...r.committed, ...r.immediate];
    expect(fired.length).toBeGreaterThan(0);
    for (const c of fired) {
      expect(c.levelPrice).toBe(110);
      expect([110 * 1.01, 111, 112]).not.toContain(c.levelPrice);
    }
  });
});

describe("12. timers mean N FULL 15m bars after the anchoring close", () => {
  it("23. creation 5: confirmed at the close of bar q (T); bar q+5 opens at T+60 -> refused; bar q+6 opens at T+75 -> allowed", () => {
    // Anchor q = 94 (first qualification), finalized at 95; arming gate relaxed to 1 bar to isolate creation.
    const cfg = config({ minBarsAfterArming: 1 });
    const q = 94;
    const early = run(fifteenMinute(DAY0, [...greenDay(q), ...day1({ 99: TOUCH })]), cfg);
    const onTime = run(fifteenMinute(DAY0, [...greenDay(q), ...day1({ 100: TOUCH })]), cfg);
    expect(early.states[95].levels[0]).toMatchObject({ createdBarIndex: q, createdBarOpenTimeMs: DAY0 + q * M15 });
    expect((DAY0 + 99 * M15) - (DAY0 + (q + 1) * M15)).toBe(60 * 60_000);
    expect(longsAt(early)).toEqual([]);
    expect((DAY0 + 100 * M15) - (DAY0 + (q + 1) * M15)).toBe(75 * 60_000);
    expect(longsAt(onTime)).toEqual([100]);
    // The legacy `>= N` rule let bar q+5 fire, after only four full bars.
    expect(longsAt(run(fifteenMinute(DAY0, [...greenDay(q), ...day1({ 99: TOUCH })]), legacy({ minBarsAfterArming: 1 })))).toEqual([99]);
  });

  it("24. arming 4: armed at the close of bar a=96 (T); bar a+4 opens at T+45 -> refused; bar a+5 opens at T+60 -> allowed", () => {
    expect(longsAt(run(fifteenMinute(DAY0, [...greenDay(), ...day1({ 100: TOUCH })]), config()))).toEqual([]);
    expect(longsAt(run(fifteenMinute(DAY0, [...greenDay(), ...day1({ 101: TOUCH })]), config()))).toEqual([101]);
    expect(longsAt(run(fifteenMinute(DAY0, [...greenDay(), ...day1({ 100: TOUCH })]), legacy()))).toEqual([100]);
  });

  it("25. cooldown 10: after an alert in bar t, the next ten FULL bars cannot alert; bar t+11 can", () => {
    const t = 101;
    expect(longsAt(run(fifteenMinute(DAY0, [...greenDay(), ...day1({ [t]: TOUCH, [t + 10]: TOUCH })]), config()))).toEqual([t]);
    expect(longsAt(run(fifteenMinute(DAY0, [...greenDay(), ...day1({ [t]: TOUCH, [t + 11]: TOUCH })]), config()))).toEqual([t, t + 11]);
    expect(longsAt(run(fifteenMinute(DAY0, [...greenDay(), ...day1({ [t]: TOUCH, [t + 10]: TOUCH })]), legacy()))).toEqual([t, t + 10]);
  });

  it("the gate helper pins both comparisons exactly", () => {
    const level = { armed: true, armedBarIndex: 100, createdBarIndex: 100, lastTouchBarIndex: 100 };
    expect(retestTimerGates(config(), level, 104)).toEqual({ armedReady: false, oldEnough: false, cooledDown: false });
    expect(retestTimerGates(config(), level, 105)).toEqual({ armedReady: true, oldEnough: false, cooledDown: false });
    expect(retestTimerGates(config(), level, 106)).toEqual({ armedReady: true, oldEnough: true, cooledDown: false });
    expect(retestTimerGates(config(), level, 111)).toEqual({ armedReady: true, oldEnough: true, cooledDown: true });
    expect(retestTimerGates(legacy(), level, 104)).toEqual({ armedReady: true, oldEnough: false, cooledDown: false });
    expect(retestTimerGates(legacy(), level, 110)).toEqual({ armedReady: true, oldEnough: true, cooledDown: true });
  });
});

describe("13. an emitted Immediate alert's cooldown survives a same-bar disarm", () => {
  // Bar 101 dips into the band from above (Immediate alert) and CLOSES below the lower band (disarm).
  const DIP: Ohlc = [112, 112, 108, 108.5];
  const REARM: Ohlc = [108.5, 112, 108.5, 112];
  const rows = (retouch: number) => [...greenDay(), ...day1({ 101: DIP, 102: REARM, [retouch]: TOUCH })];

  it("26. the alert counts: lastTouch is the alerting bar even though the close disarmed the level", () => {
    const r = run(fifteenMinute(DAY0, rows(150)), config());
    expect(r.immediate.filter((c) => c.chartBarIndex === 101)).toHaveLength(1);
    expect(r.committed.filter((c) => c.chartBarIndex === 101)).toHaveLength(0);
    expect(r.states[101].levels[0]).toMatchObject({ armed: false, lastTouchBarIndex: 101 });
    // Legacy loses it (Pine's rollback): no cooldown recorded.
    expect(run(fifteenMinute(DAY0, rows(150)), legacy()).states[101].levels[0].lastTouchBarIndex).toBe(-1);
  });

  it("re-armed at 102, a retouch at 108 is still in cooldown (legacy would alert); at 112 (= 101 + 11) it alerts", () => {
    expect(longsAt(run(fifteenMinute(DAY0, rows(108)), config()))).toEqual([101]);
    expect(longsAt(run(fifteenMinute(DAY0, rows(108)), legacy()))).toEqual([101, 108]);
    expect(longsAt(run(fifteenMinute(DAY0, rows(112)), config()))).toEqual([101, 112]);
  });
});

// ---------------------------------------------------------------------------
// Regressions on committed public fixtures
// ---------------------------------------------------------------------------

const FIXTURE = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "native-dynamic-lifecycle-klines.json"), "utf8")) as Record<string, number[][]> & { intervalMs: number };
const klines = (symbol: "HUMAUSDT" | "BNBUSDT"): NativeKline[] =>
  FIXTURE[symbol].map(([openTimeMs, open, high, low, close]) => ({ openTimeMs, closeTimeMs: openTimeMs + FIXTURE.intervalMs - 1, open, high, low, close }));
const iso = (s: string) => Date.parse(s);
const indexAt = (bars: readonly NativeKline[], when: string) => bars.findIndex((b) => b.openTimeMs === iso(when));
const PROFILE_TFS: NativeSourceTf[] = ["1D", "1W", "1M", "3M", "6M", "12M"];

describe("29/30. HUMAUSDT: the stale 1W 0.032724 ladder is gone", () => {
  const bars = klines("HUMAUSDT");
  const dyn = run(bars, config({ enabledSourceTfs: PROFILE_TFS }));
  const WEEK = iso("2026-09-28T00:00:00Z");

  it("the week-of-09-28 GREEN is ONE candidate that followed 0.032724 -> 0.034664 -> 0.03626, anchored at its first qualification", () => {
    const greenAt = (when: string) => candidatesOf(dyn.states[indexAt(bars, when)], "1W")!.GREEN;
    expect(greenAt("2026-10-01T00:30:00Z")).toBeNull();
    expect(greenAt("2026-10-01T00:45:00Z")).toMatchObject({ periodStartMs: WEEK, price: 0.032724, active: true });
    expect(greenAt("2026-10-01T12:15:00Z")).toMatchObject({ price: 0.034664 });
    expect(greenAt("2026-10-02T09:30:00Z")).toMatchObject({ price: 0.03626 });
    const anchors = new Set(dyn.states.map((s) => candidatesOf(s, "1W")!.GREEN).filter((c) => c !== null && c.periodStartMs === WEEK).map((c) => c!.firstQualifiedBarOpenTimeMs));
    expect([...anchors]).toEqual([iso("2026-10-01T00:45:00Z")]);
    expect(greenAt("2026-10-03T19:30:00Z")).toMatchObject({ price: 0.03626, active: true });
  });

  it("no level at 0.032724, 0.034664 or 0.03626 exists to arm or retest, and the 10-03 19:30 touch fires nothing against them", () => {
    const final = dyn.states[dyn.states.length - 1];
    expect(final.levels.filter((l) => l.sourceTf === "1W" && [0.032724, 0.034664, 0.03626].includes(l.price))).toEqual([]);
    expect(final.levels.filter((l) => l.sourceTf === "1W" && l.htfPeriodStartMs === WEEK)).toEqual([]);
    expect([...dyn.committed, ...dyn.immediate].filter((c) => c.levelPrice === 0.032724)).toEqual([]);
    // (A 1D level at 0.03626 is legitimate: the CLOSED 10-02 day qualifies GOG at 7.39%.)
    const oct2 = final.levels.filter((l) => l.sourceTf === "1D" && l.htfPeriodStartMs === iso("2026-10-02T00:00:00Z"));
    expect(oct2.map((l) => `${l.color}@${l.price}`)).toEqual(["GREEN@0.03626"]);
    const touch = indexAt(bars, "2026-10-03T19:30:00Z");
    expect([...dyn.committed, ...dyn.immediate].filter((c) => c.chartBarIndex === touch && c.sourceTf === "1W")).toEqual([]);
  });

  it("the CLOSED previous week finalized exactly ONE GREEN 1W level at its final high (legacy left duplicates)", () => {
    const prev = dyn.registered.filter((l) => l.htfPeriodStartMs === iso("2026-09-21T00:00:00Z") && l.color === "GREEN");
    expect(prev).toHaveLength(1);
    expect(prev[0].price).toBe(0.032181);
    const old = run(bars, legacy({ enabledSourceTfs: ["1W"] })).registered.filter((l) => l.htfPeriodStartMs === iso("2026-09-21T00:00:00Z"));
    expect(old.filter((l) => l.price === 0.025589).length).toBeGreaterThan(1);
  });

  it("legacy contrast on the same bytes: the old engine registers the stale 0.032724 week level", () => {
    const old = run(bars, legacy({ enabledSourceTfs: ["1W"] }));
    expect(old.registered.filter((l) => l.htfPeriodStartMs === WEEK && l.color === "GREEN").map((l) => l.price)).toEqual([0.032724, 0.034664, 0.03626]);
  });

  it("at most one final level per (TF, period, colour), across every profile timeframe", () => {
    const finals = dyn.states[dyn.states.length - 1].levels.map((l) => `${l.sourceTf}:${l.htfPeriodStartMs}:${l.color}`);
    expect(finals.length).toBeGreaterThan(0);
    expect(new Set(finals).size).toBe(finals.length);
  });
});

describe("31. BNBUSDT: no September 1M GREEN level survives a close that no longer qualifies", () => {
  const bars = klines("BNBUSDT");
  const dyn = run(bars, config({ enabledSourceTfs: ["1M"] }));
  const SEPT = iso("2026-09-01T00:00:00Z");
  const lastSeptBar = indexAt(bars, "2026-09-30T23:45:00Z");

  it("the September GREEN candidate existed intramonth and followed 781.44 -> 808.23", () => {
    expect(candidatesOf(dyn.states[indexAt(bars, "2026-09-09T21:00:00Z")], "1M")!.GREEN).toMatchObject({ periodStartMs: SEPT, price: 781.44, active: true });
    expect(candidatesOf(dyn.states[lastSeptBar - 1], "1M")!.GREEN).toMatchObject({ price: 808.23 });
  });

  it("the final September candle fails every GREEN formula (GOG ~5.57%), so no September level exists — from the formulas, not a narrative", () => {
    const aggregate = dyn.states[lastSeptBar].htf["1M"]!.aggregate!;
    expect(aggregate).toMatchObject({ periodStartMs: SEPT, open: 691.67, high: 808.23, close: 769.73, complete: true });
    const flags = evaluateLevelConditions(aggregate, 0.07)!;
    expect(flags.GOR || flags.GOG).toBe(false);
    expect((808.23 - 769.73) / 691.67).toBeCloseTo(0.0557, 4);
    expect(dyn.registered.filter((l) => l.htfPeriodStartMs === SEPT)).toEqual([]);
    expect(dyn.states[dyn.states.length - 1].levels.filter((l) => [781.44, 808.23].includes(l.price))).toEqual([]);
    expect([...dyn.committed, ...dyn.immediate].filter((c) => c.levelPrice === 781.44)).toEqual([]);
  });

  it("legacy contrast: the old engine kept 781.44 and 808.23 levels, many times over", () => {
    const old = run(bars, legacy({ enabledSourceTfs: ["1M"] })).registered.filter((l) => l.htfPeriodStartMs === SEPT);
    expect(old.filter((l) => l.price === 781.44).length).toBeGreaterThan(1);
    expect(old.filter((l) => l.price === 808.23).length).toBeGreaterThan(1);
  });
});

describe("32/33. causal history and restart", () => {
  const bars = klines("HUMAUSDT");
  const cfg = config({ enabledSourceTfs: ["1D", "1W", "1M"] });
  const historyStartMs = iso("2026-09-01T00:00:00Z");
  const switchoverMs = iso("2026-10-02T00:00:00Z"); // inside the week of 09-28, before its 0.03626 high (10-02 09:30)
  const input = { config: cfg, historyStartMs, switchoverMs, contextBars: [], bars, partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS } as const;

  it("history is the live engine replayed forward: the same state as stepping the same bars", () => {
    const history = reconstructHistoricalState(input);
    expect(history.report.semantics).toBe(NATIVE_DYNAMIC_HISTORICAL_STATE_SEMANTICS);
    const replayed = replayNativeEngine(bars.slice(0, (switchoverMs - historyStartMs) / M15), cfg);
    expect(canonicalSha256(history.state)).toBe(canonicalSha256(replayed.state));
  });

  /** The first bar index (from the period start) whose range printed `price` as a high (GREEN) or low (RED). */
  const firstPrinted = (periodStartMs: number, color: string, price: number) =>
    bars.findIndex((b) => b.openTimeMs >= periodStartMs && (color === "GREEN" ? b.high === price : b.low === price));

  it("no future HTF extreme: at the switchover the week's candidate holds the high printed SO FAR, and no level was projected", () => {
    const history = reconstructHistoricalState(input);
    expect(candidatesOf(history.state, "1W")!.GREEN).toMatchObject({ periodStartMs: iso("2026-09-28T00:00:00Z"), price: 0.034664 });
    expect(history.state.levels.filter((l) => l.sourceTf === "1W" && l.htfPeriodStartMs === iso("2026-09-28T00:00:00Z"))).toEqual([]);
    // Every level becomes a level only at its source close, after its extreme was printed.
    const dynRun = run(bars.slice(0, (switchoverMs - historyStartMs) / M15), cfg);
    expect(dynRun.registered.length).toBeGreaterThan(0);
    for (const l of dynRun.registered) expect(firstPrinted(l.htfPeriodStartMs, l.color, l.price)).toBeLessThanOrEqual(l.bar);
    // The legacy look-ahead path is refused for this lifecycle, and is unchanged for the legacy one —
    // where levels DO appear before their extreme was printed.
    expect(() => reconstructPineHistoricalState(input)).toThrow(/look-ahead/);
    const old = reconstructPineHistoricalState({ ...input, config: legacy({ enabledSourceTfs: ["1D", "1W", "1M"] }) });
    expect(old.report.semantics).toBe(NATIVE_HISTORICAL_STATE_SEMANTICS);
    expect(old.report.registrations.some((l) => firstPrinted(l.htfPeriodStartMs, l.color, l.price) > l.createdBarIndex)).toBe(true);
  });

  it("33. a checkpoint round-trip mid-week reproduces the exact candidate state and the same future", () => {
    const cut = indexAt(bars, "2026-10-01T06:00:00Z");
    const whole = replayNativeEngineWithImmediate(bars, cfg);
    const firstHalf = replayNativeEngine(bars.slice(0, cut), cfg);
    const restored = JSON.parse(JSON.stringify(firstHalf.state)) as NativeEngineState;
    expect(canonicalSha256(restored)).toBe(canonicalSha256(firstHalf.state));
    expect(candidatesOf(restored, "1W")!.GREEN).toMatchObject({
      price: restored.htf["1W"]!.aggregate!.high,
      firstQualifiedBarOpenTimeMs: iso("2026-10-01T00:45:00Z"),
    });
    let state = restored;
    for (const bar of bars.slice(cut)) state = stepNativeEngineWithImmediate(state, bar).state;
    expect(canonicalSha256(state)).toBe(canonicalSha256(whole.state));
  });
});

// ---------------------------------------------------------------------------
// Identity: lifecycle, fingerprint, namespace, lineage
// ---------------------------------------------------------------------------

describe("14-18/34/35. engine identity", () => {
  const OLD_7 = "47d661a531c9d724d0bfbcb85ff68ea7dd85418464f959be2d0cb1340f4c5179";
  const TEDDY_18 = "3e21f1c15207b03b91315767a4b54c92b0e6a21da33149c02c4ec0ee7c903998";

  it("Teddy 7% All Active runs the dynamic lifecycle; Teddy Aggressive keeps the legacy one, byte for byte", () => {
    expect(TEDDY_7_ALL_ACTIVE_V1.engine.lifecycle).toBe(DYNAMIC);
    expect(lineageConfigOf(TEDDY_7_ALL_ACTIVE_V1.engine).engine.lifecycle).toBe(DYNAMIC);
    expect(Object.keys(TEDDY_AGGRESSIVE_V1.engine)).not.toContain("lifecycle");
    expect(Object.keys(lineageConfigOf(TEDDY_AGGRESSIVE_V1.engine).engine)).not.toContain("lifecycle");
    expect(engineFingerprintOf(TEDDY_AGGRESSIVE_V1)).toBe(TEDDY_18);
    expect(profileSummaryOf(TEDDY_AGGRESSIVE_V1).engine).not.toHaveProperty("lifecycle");
    expect(profileSummaryOf(TEDDY_7_ALL_ACTIVE_V1).engine.lifecycle).toBe(DYNAMIC);
  });

  it("the 7% fingerprint changed naturally (no salt): new semantics identifiers and the lifecycle key in the config", () => {
    const fp = engineFingerprintOf(TEDDY_7_ALL_ACTIVE_V1);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).not.toBe(OLD_7);
    // The same engine without the lifecycle IS the old 7% engine: the lifecycle alone moved it.
    expect(engineFingerprintOf({ ...TEDDY_7_ALL_ACTIVE_V1, engine: { ...TEDDY_7_ALL_ACTIVE_V1.engine, lifecycle: undefined } })).toBe(OLD_7);
  });

  it("34. the new engine never reuses the old namespace or a checkpoint lineage of the old engine", () => {
    const root = path.join("C:", "never-created");
    const fp = engineFingerprintOf(TEDDY_7_ALL_ACTIVE_V1);
    expect(engineNamespaceDir(root, fp)).not.toBe(engineNamespaceDir(root, OLD_7));
    const oldManifest = JSON.stringify({ schema: ENGINE_NAMESPACE_SCHEMA, engineFingerprint: OLD_7, profileId: "TEDDY_7_ALL_ACTIVE_V1", engine: {} });
    expect(() => assertEngineNamespace(oldManifest, fp)).toThrow(ScannerProfileError);
    const common = { marketType: "USDM_PERPETUAL" as const, symbol: "HUMAUSDT", chartInterval: "15m" as const, historyStartMs: iso("2026-01-01T00:00:00Z"), compatibilitySwitchoverMs: iso("2026-09-12T01:00:00Z"), partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS as typeof SWITCHOVER_TRUNCATED_CLOSED_BARS, bootstrapInputSha256: "a".repeat(64) };
    const dynLineage = buildScannerLineage({ ...common, engineConfig: lineageConfigOf(TEDDY_7_ALL_ACTIVE_V1.engine).engine });
    const oldLineage = buildScannerLineage({ ...common, engineConfig: { ...lineageConfigOf(TEDDY_7_ALL_ACTIVE_V1.engine).engine, lifecycle: undefined } as NativeEngineConfig });
    expect(dynLineage.lineageId).not.toBe(oldLineage.lineageId);
    expect(dynLineage.lineage).toMatchObject({ engineSemantics: NATIVE_DYNAMIC_ENGINE_SEMANTICS, historicalStateSemantics: NATIVE_DYNAMIC_HISTORICAL_STATE_SEMANTICS });
    expect(oldLineage.lineage).toMatchObject({ engineSemantics: NATIVE_ENGINE_SEMANTICS, historicalStateSemantics: NATIVE_HISTORICAL_STATE_SEMANTICS });
    // A lineage pairing the dynamic config with the legacy semantics is refused.
    expect(() => assertScannerLineage({ ...dynLineage.lineage, engineSemantics: NATIVE_ENGINE_SEMANTICS } as never)).toThrow(ScannerLineageError);
    expect(() => assertScannerLineage({ ...dynLineage.lineage, historicalStateSemantics: NATIVE_HISTORICAL_STATE_SEMANTICS } as never)).toThrow(ScannerLineageError);
  });

  it("the config refuses an unknown lifecycle and keeps legacy configs free of the key", () => {
    expect(() => config({ lifecycle: "SOMETHING" as never })).toThrow(/lifecycle/);
    expect(Object.keys(legacy())).not.toContain("lifecycle");
    expect(Object.keys(createNativeEngineConfig({ minMovePct: 0.07, lifecycle: "PINE_V55_EDGE_FROZEN" }))).not.toContain("lifecycle");
    expect(config().lifecycle).toBe(DYNAMIC);
  });
});

// ---------------------------------------------------------------------------
// The TradingView script carries the same product rule (source-pinned: Pine cannot run here)
// ---------------------------------------------------------------------------

describe("Pine teddy v5.5 implements the same dynamic source-level rule", () => {
  const pine = readFileSync(path.resolve(__dirname, "../../../docs/pine/teddy-v5.5-current.pine"), "utf8").replace(/\r\n/g, "\n");
  const code = pine.replace(/\/\/.*$/gm, "");

  it("keeps the user's 7% default and the four unchanged 7% formulas", () => {
    expect(code).toContain('minPercentInput = input.float(7.0, "Persentase Pergerakan Harga Minimal (%)"');
    expect(code).toContain("signalGreenOnRed = isRedCandle and (math.abs(high - open) / open >= minPercentInput)");
    expect(code).toContain("signalRedOnRed   = isRedCandle and (math.abs(close - low) / close >= minPercentInput)");
    expect(code).toContain("signalGreenOnGreen = isGreenCandle and (math.abs(high - close) / open >= minPercentInput)");
    expect(code).toContain("signalRedOnGreen   = isGreenCandle and (math.abs(open - low) / open >= minPercentInput)");
  });

  it("one GREEN and one RED forming candidate per source candle, following the running high / low, created once", () => {
    expect(code).toContain("greenQualifies = show and (tf_sGOR or tf_sGOG)");
    expect(code).toContain("redQualifies = show and (tf_sROR or tf_sROG)");
    expect(code).toContain("if greenQualifies and not gExists");
    expect(code).toContain("if redQualifies and not rExists");
    expect(code).toContain("gPrice := tf_high");
    expect(code).toContain("rPrice := tf_low");
    expect(code).toContain("gActive := greenQualifies");
    expect(code).toContain("rActive := redQualifies");
    // The creation anchor is written only when the candidate is created.
    expect(code.match(/gFirstBar := bar_index/g)).toHaveLength(1);
    expect(code.match(/rFirstBar := bar_index/g)).toHaveLength(1);
    // No edge-registration remains.
    expect(code).not.toMatch(/and not tf_s(GOR|ROR|GOG|ROG)\[1\]/);
  });

  it("a level is registered ONLY when the source candle ends, and only for a still-qualifying candidate", () => {
    expect(code).toContain("newSourceCandle = not na(tf_time[1]) and tf_time != tf_time[1]");
    const calls = [...code.matchAll(/f_registerLevel\((?!levelPrice)/g)];
    expect(calls).toHaveLength(2);
    const block = code.slice(code.indexOf("if newSourceCandle"), code.indexOf("greenQualifies ="));
    expect(block).toContain('if gExists and gActive\n');
    expect(block).toContain('f_registerLevel(gPrice, "GREEN", labelText, gFirstBar)');
    expect(block).toContain('if rExists and rActive\n');
    expect(block).toContain('f_registerLevel(rPrice, "RED", labelText, rFirstBar)');
    expect(code).toContain("array.push(lvlCreatedBar, createdBar)");
  });

  it("timers mean N FULL bars, and Immediate commits an emitted alert's cooldown before arm/disarm", () => {
    expect(code).toContain("bar_index - armedBar > minBarsAfterArming");
    expect(code).toContain("bar_index - array.get(lvlCreatedBar, i) > minBarsAfterCreation");
    expect(code).toContain("bar_index - lastTouch > touchCooldownBars");
    expect(code).not.toMatch(/>= (minBarsAfterArming|minBarsAfterCreation|touchCooldownBars)/);
    expect(code).toMatch(/if touchAlertTiming == "Immediate"\n\s+f_retestLoop\(prevClose\)\n\s+f_armDisarm\(\)\nelse\n\s+f_armDisarm\(\)\n\s+f_retestLoop\(prevClose\)/);
    expect(code).toContain("alert(f_buildWebhookJson(touchSignal, levelPrice, touchNote), alert.freq_once_per_bar)");
    expect(code).toContain("longRetest = levelColor == \"GREEN\" and prevClose > upperBand and inBand");
    expect(code).toContain("shortRetest = levelColor == \"RED\" and prevClose < lowerBand and inBand");
  });
});
