import {
  createNativeEngineConfig,
  createNativeEngineState,
  replayNativeEngine,
  replayNativeEngineWithImmediate,
  stepNativeEngineWithImmediate,
  type NativeEngineConfig,
  type NativeEngineConfigInput,
  type NativeEngineState,
  type NativeImmediateCandidate,
  type NativeKline,
  type NativeLevel,
  type NativeRetestCandidate,
} from "@trading-alert-dashboard/shared";

import { canonicalJson, canonicalSha256, sha256Hex } from "./native-signal-canonical";
import { HOUR_MS, MINUTE_MS, T_2024_01_01, barsFrom, dailyBars, doji, lcg, repeat, type Ohlc } from "./native-signal-fixtures";

/**
 * Behaviour-lock fixtures for the CAUSAL native engine (Slice 1 + 1b).
 *
 * Each fixture is a fixed bar sequence plus a fixed config. Its fingerprint
 * records everything the engine makes observable, bar by bar, so that a later
 * behaviour-preserving refactor of engine.ts can be proven not to have changed
 * any of it. Generated rows use only + - * /, Math.max/min/round and the
 * integer LCG: no implementation-defined Math functions, no clock, no
 * Math.random — the same seed always yields byte-identical input.
 */

export interface GoldenFixture {
  readonly name: string;
  readonly bars: readonly NativeKline[];
  readonly config: NativeEngineConfig;
}

const config = (input: NativeEngineConfigInput) => createNativeEngineConfig(input);
const daily1D = (overrides: Partial<NativeEngineConfigInput> = {}) =>
  config({ minMovePct: 0.07, enabledSourceTfs: ["1D"], ...overrides });

/** GREEN @ 120 (1D GOR) registered on bar 1. */
const GREEN_AT_120: Ohlc[] = [doji(100), [100, 120, 99, 99]];
/** Touches the 120 band (118.8..121.2) from above and closes inside the safe side. */
const TOUCH_120: Ohlc = doji(122, 122, 120);
/** Touches the 120 band from above and CLOSES THROUGH it (118.5 < 118.8). */
const THROUGH_120: Ohlc = [125, 125, 117, 118.5];
/** Touches the 80 band (79.2..80.8) from below. */
const TOUCH_80: Ohlc = doji(78, 79.5, 78);

const round6 = (x: number) => Math.round(x * 1_000_000) / 1_000_000;

/** The Slice 1 causality fixture: 15m bars from 2024-01-01 with rare 9% wicks. */
export function noisyFifteenMinuteBars(count: number, seed: number): NativeKline[] {
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

/** Literal seed for the large fixture. Never derived from anything at run time. */
export const LARGE_FIXTURE_SEED = 0x2b0_5eed;

/**
 * ~400 days of 1h bars from 2024-01-01 (crosses every D/W/M/3M/6M/12M boundary,
 * including 2024 -> 2025), volatile enough to register far more levels than a
 * 40-level registry holds, so FIFO eviction runs constantly.
 */
export function largeHourlyBars(count: number, seed: number): NativeKline[] {
  const next = lcg(seed);
  const rows: Ohlc[] = [];
  let price = 50;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    // Mean-reverting drift keeps the walk inside roughly 20..120.
    const pull = (50 - open) / 50 * 0.004;
    const close = round6(Math.max(1, open * (1 + pull + (next() - 0.5) * 0.03)));
    let high = round6(Math.max(open, close) * (1 + next() * 0.006));
    let low = round6(Math.min(open, close) * (1 - next() * 0.006));
    const shock = next();
    if (shock < 0.015) high = round6(Math.max(open, close) * (1.08 + next() * 0.05));
    else if (shock < 0.03) low = round6(Math.min(open, close) * (0.92 - next() * 0.05));
    rows.push([open, high, low, close]);
    price = close;
  }
  return barsFrom(T_2024_01_01, HOUR_MS, rows);
}

/** The Slice 1 production-oriented fixture: 15m from Wed 2024-01-03, every timeframe, 7%. */
function productionRows(): Ohlc[] {
  const rows: Ohlc[] = [];
  for (let i = 0; i < 96; i += 1) {
    if (i < 40) rows.push(doji(100));
    else if (i === 40) rows.push([100, 107.5, 99.5, 99.8]);
    else rows.push(doji(99.8));
  }
  rows.push(doji(99.8));
  let price = 99.8;
  for (let step = 1; step <= 23; step += 1) {
    const next = Math.round((99.8 + step * 0.4) * 100) / 100;
    rows.push([price, next, price, next]);
    price = next;
  }
  rows.push(...repeat(doji(109), 8));
  rows.push([109, 109, 108.2, 108.8]);
  rows.push(...repeat(doji(108.8), 4));
  return rows;
}

export function goldenFixtures(): GoldenFixture[] {
  const noisy = noisyFifteenMinuteBars(4000, 20240101);
  return [
    {
      // One red daily candle qualifies GOR and ROR on every timeframe at once.
      name: "registration-all-tfs-both-colours",
      bars: dailyBars([doji(100), [100, 120, 80, 99], doji(100), doji(100), doji(100)]),
      config: config({ minMovePct: 0.07 }),
    },
    {
      name: "fifo-overflow",
      bars: dailyBars([doji(100), ...[0, 1, 2, 3, 4, 5].flatMap((k): Ohlc[] => [[100, 110 + k, 99, 99], doji(100)])]),
      config: daily1D({ maxLevels: 3 }),
    },
    {
      name: "arm-disarm-rearm-retest",
      bars: dailyBars([
        ...GREEN_AT_120,
        doji(122), // 2: arm
        doji(122), // 3: hold
        doji(118), // 4: disarm (118 < 118.8)
        doji(119), // 5: inside the band, nothing
        ...repeat(doji(123), 4), // 6: re-arm, 7-9 hold
        TOUCH_120, // 10: LONG (armed at 6, 10-6 = 4)
      ]),
      config: daily1D(),
    },
    {
      name: "cooldown-and-wrong-side",
      bars: dailyBars([
        ...GREEN_AT_120,
        ...repeat(doji(123), 5), // 2: arm, 3-6 hold
        TOUCH_120, // 7: LONG, lastTouch 7
        doji(123), // 8
        TOUCH_120, // 9: blocked (2 bars)
        ...repeat(doji(123), 6), // 10-15
        TOUCH_120, // 16: blocked (9 bars)
        TOUCH_120, // 17: LONG (10 bars)
        doji(119), // 18: inside the band, still armed
        [119, 121, 119, 120.5], // 19: wrong side (close[1] inside the band) — no cooldown
        ...repeat(doji(123), 7), // 20-26
        TOUCH_120, // 27: LONG — 10 bars after 17; the wrong-side touch did not reset anything
      ]),
      config: daily1D(),
    },
    {
      name: "multiple-levels-same-bar",
      bars: dailyBars([
        ...GREEN_AT_120, // 1: GREEN 120 (id 0)
        doji(100),
        [100, 121, 99, 99], // 3: GREEN 121 (id 1)
        doji(100),
        [100, 101, 80, 99], // 5: RED 80 (id 2)
        ...repeat(doji(124), 5), // 6: both GREEN arm, 7-10 hold
        [124, 124, 119.5, 123], // 11: both GREEN retested, oldest first
        ...repeat(doji(78), 5), // 12: RED arms, both GREEN disarm; 13-16 hold
        TOUCH_80, // 17: SHORT on RED 80
      ]),
      config: daily1D(),
    },
    {
      name: "immediate-proof-flags",
      bars: dailyBars([
        ...GREEN_AT_120,
        ...repeat(doji(123), 5), // 2: arm
        THROUGH_120, // 7: IMMEDIATE only (closes through -> disarmed before 4B)
        ...repeat(doji(123), 5), // 8: re-arm
        [123, 123, 120.5, 120.5], // 13: closes AT its low -> band entry before close unprovable
        ...repeat(doji(123), 10), // 14-23
        [121, 122, 119, 119], // 24: opens INSIDE the band -> provable
      ]),
      config: daily1D(),
    },
    {
      // Registry full (2 of 2) with known-false previous flags: every level is at
      // intrabar eviction risk, so levelPresentOnEveryUpdate must be false.
      name: "immediate-eviction-risk",
      bars: dailyBars([
        ...GREEN_AT_120, // 1: GREEN 120 (id 0)
        doji(100),
        [100, 130, 99, 99], // 3: GREEN 130 (id 1)
        ...repeat(doji(132), 5), // 4: both arm
        doji(132, 132, 129.5), // 9: retests 130 only
      ]),
      config: daily1D({ maxLevels: 2 }),
    },
    {
      name: "production-15m-all-tfs-7pct",
      bars: barsFrom(Date.UTC(2024, 0, 3), 15 * MINUTE_MS, productionRows()),
      config: config({ minMovePct: 0.07 }),
    },
    { name: "noisy-15m-all-tfs", bars: noisy, config: config({ minMovePct: 0.07 }) },
    { name: "noisy-15m-retest-disabled", bars: noisy, config: config({ minMovePct: 0.07, retestEnabled: false }) },
    { name: "noisy-15m-bar-close-timing", bars: noisy, config: config({ minMovePct: 0.07, timing: "Bar Close" }) },
    {
      name: "large-1h-seeded-fifo-40",
      bars: largeHourlyBars(400 * 24, LARGE_FIXTURE_SEED),
      config: config({ minMovePct: 0.07, maxLevels: 40 }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

export interface FixtureRun {
  readonly committed: NativeRetestCandidate[];
  readonly immediate: NativeImmediateCandidate[];
  readonly registrations: NativeLevel[];
  readonly evictions: NativeLevel[];
  readonly finalState: NativeEngineState;
  /** Per-bar committed (state after the bar), in order. */
  readonly states: NativeEngineState[];
  readonly traceSha256: string;
}

/**
 * Steps the public engine bar by bar and chains a hash over every bar's full
 * observable output: the bar, its registrations, evictions, committed and
 * immediate candidates, and the complete committed state afterwards (levels in
 * array order with arming / cooldown fields, HTF aggregates, previous flags,
 * barIndex, lastBar, nextLevelId).
 */
export function runFixture(fixture: GoldenFixture, keepStates = false): FixtureRun {
  let state = createNativeEngineState(fixture.config);
  let chain = sha256Hex(`native-signal-golden/v1\n${fixture.name}`);
  const committed: NativeRetestCandidate[] = [];
  const immediate: NativeImmediateCandidate[] = [];
  const registrations: NativeLevel[] = [];
  const evictions: NativeLevel[] = [];
  const states: NativeEngineState[] = [];
  for (const bar of fixture.bars) {
    const step = stepNativeEngineWithImmediate(state, bar);
    chain = sha256Hex(
      `${chain}\n${canonicalJson({
        bar,
        registered: step.registered,
        evicted: step.evicted,
        candidates: step.candidates,
        immediateCandidates: step.immediateCandidates,
        state: step.state,
      })}`
    );
    committed.push(...step.candidates);
    immediate.push(...step.immediateCandidates);
    registrations.push(...step.registered);
    evictions.push(...step.evicted);
    if (keepStates) states.push(step.state);
    state = step.state;
  }
  return { committed, immediate, registrations, evictions, finalState: state, states, traceSha256: chain };
}

export interface GoldenFingerprint {
  readonly barCount: number;
  readonly inputSha256: string;
  readonly configSha256: string;
  readonly traceSha256: string;
  readonly committedCandidateSha256: string;
  readonly immediateCandidateSha256: string;
  readonly registrationSha256: string;
  readonly evictionSha256: string;
  readonly finalStateSha256: string;
  readonly counts: {
    readonly registrations: number;
    readonly evictions: number;
    readonly committed: number;
    readonly immediate: number;
    readonly immediateBothProofs: number;
    readonly immediateBandUnproven: number;
    readonly immediatePresenceUnproven: number;
    readonly finalLevels: number;
    readonly finalNextLevelId: number;
    readonly registrationsByTf: Readonly<Record<string, number>>;
  };
}

export function fingerprintOf(fixture: GoldenFixture, run: FixtureRun = runFixture(fixture)): GoldenFingerprint {
  const byTf: Record<string, number> = {};
  for (const level of run.registrations) byTf[level.sourceTf] = (byTf[level.sourceTf] ?? 0) + 1;
  return {
    barCount: fixture.bars.length,
    inputSha256: canonicalSha256(fixture.bars),
    configSha256: canonicalSha256(fixture.config),
    traceSha256: run.traceSha256,
    committedCandidateSha256: canonicalSha256(run.committed),
    immediateCandidateSha256: canonicalSha256(run.immediate),
    registrationSha256: canonicalSha256(run.registrations),
    evictionSha256: canonicalSha256(run.evictions),
    finalStateSha256: canonicalSha256(run.finalState),
    counts: {
      registrations: run.registrations.length,
      evictions: run.evictions.length,
      committed: run.committed.length,
      immediate: run.immediate.length,
      immediateBothProofs: run.immediate.filter((c) => c.proof.bandEnteredBeforeClosingUpdate && c.proof.levelPresentOnEveryUpdate).length,
      immediateBandUnproven: run.immediate.filter((c) => !c.proof.bandEnteredBeforeClosingUpdate).length,
      immediatePresenceUnproven: run.immediate.filter((c) => !c.proof.levelPresentOnEveryUpdate).length,
      finalLevels: run.finalState.levels.length,
      finalNextLevelId: run.finalState.nextLevelId,
      registrationsByTf: byTf,
    },
  };
}

/** The batch replay paths, which must agree with stepping exactly. */
export function replayPaths(fixture: GoldenFixture) {
  return {
    committedOnly: replayNativeEngine(fixture.bars, fixture.config),
    withImmediate: replayNativeEngineWithImmediate(fixture.bars, fixture.config),
  };
}
