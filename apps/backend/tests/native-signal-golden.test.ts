import { describe, expect, it } from "vitest";

import { NATIVE_SIGNAL_CAUSAL_GOLDEN } from "./fixtures/native-signal-causal-golden";
import {
  CanonicalJsonError,
  canonicalJson,
  canonicalSha256,
  nonIntegerTimeOrIndexFields,
  sha256Hex,
} from "./helpers/native-signal-canonical";
import {
  LARGE_FIXTURE_SEED,
  fingerprintOf,
  goldenFixtures,
  largeHourlyBars,
  replayPaths,
  runFixture,
  type FixtureRun,
  type GoldenFixture,
} from "./helpers/native-signal-golden-fixtures";

/**
 * Slice 2B-0 — behaviour lock for the CAUSAL native engine.
 *
 * The golden values in fixtures/native-signal-causal-golden.ts were generated
 * from the engine exactly as committed at bc4fbb6, before any refactor. A
 * later behaviour-preserving extraction of engine.ts must leave every value
 * here unchanged; any difference is a behaviour change and fails this suite.
 */

const fixtures = goldenFixtures();
const byName = new Map(fixtures.map((fixture) => [fixture.name, fixture]));
const fixture = (name: string): GoldenFixture => {
  const found = byName.get(name);
  if (!found) throw new Error(`no fixture ${name}`);
  return found;
};
const runs = new Map<string, FixtureRun>();
const runOf = (name: string): FixtureRun => {
  let run = runs.get(name);
  if (!run) {
    run = runFixture(fixture(name), true);
    runs.set(name, run);
  }
  return run;
};

// ===========================================================================
// Canonical serialization
// ===========================================================================

describe("canonical serialization", () => {
  it("sorts object keys, whatever their insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it("keeps array order: order is behaviour", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("writes a fixed vector byte for byte, and hashes it to a fixed digest", () => {
    const vector = { n: -1.5e-7, b: [3, { d: null, c: true }], a: 'x"y', i: 1789461900000 };
    const text = '{"a":"x\\"y","b":[3,{"c":true,"d":null}],"i":1789461900000,"n":-1.5e-7}';
    expect(canonicalJson(vector)).toBe(text);
    expect(canonicalSha256(vector)).toBe(sha256Hex(text));
    expect(sha256Hex(text)).toBe("6487c8f4f1ab5d9a15960276e41e6a52830229579a75d95e72051a1978909069");
  });

  it("refuses values it cannot represent canonically instead of dropping or coercing them", () => {
    class Box {
      constructor(readonly v: number) {}
    }
    for (const bad of [
      { a: undefined },
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0,
      { f: () => 1 },
      new Date(0),
      new Map(),
      new Box(1),
      BigInt(1),
    ]) {
      expect(() => canonicalJson(bad)).toThrow(CanonicalJsonError);
    }
  });

  it("finds a non-integer timestamp or index", () => {
    expect(nonIntegerTimeOrIndexFields({ openTimeMs: 1.5, x: [{ chartBarIndex: 2 }] })).toEqual(["$.openTimeMs"]);
    expect(nonIntegerTimeOrIndexFields({ level: { createdBarIndex: "3" } })).toEqual(["$.level.createdBarIndex"]);
  });
});

// ===========================================================================
// Fixture determinism
// ===========================================================================

describe("fixtures are deterministic", () => {
  it("the large fixture's seed is a literal and regenerates byte-identical bars", () => {
    expect(LARGE_FIXTURE_SEED).toBe(0x2b05eed);
    const a = largeHourlyBars(400 * 24, LARGE_FIXTURE_SEED);
    const b = largeHourlyBars(400 * 24, LARGE_FIXTURE_SEED);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalSha256(a)).toBe(NATIVE_SIGNAL_CAUSAL_GOLDEN["large-1h-seeded-fifo-40"].inputSha256);
  });

  it("every fixture input and every observable output uses integer times and indices", () => {
    for (const f of fixtures) {
      const run = runOf(f.name);
      expect(nonIntegerTimeOrIndexFields(f.bars)).toEqual([]);
      expect(nonIntegerTimeOrIndexFields([run.committed, run.immediate, run.registrations, run.finalState])).toEqual([]);
    }
  });
});

// ===========================================================================
// Golden fingerprints (generated from bc4fbb6)
// ===========================================================================

describe("golden fingerprints of the causal engine", () => {
  it("covers exactly the fixture set", () => {
    expect(Object.keys(NATIVE_SIGNAL_CAUSAL_GOLDEN).sort()).toEqual(fixtures.map((f) => f.name).sort());
  });

  for (const f of fixtures) {
    it(`${f.name}: every pinned hash and count is unchanged`, () => {
      expect(fingerprintOf(f, runOf(f.name))).toEqual(NATIVE_SIGNAL_CAUSAL_GOLDEN[f.name]);
    });
  }

  it("the fixtures are non-trivial where they need to be", () => {
    const g = NATIVE_SIGNAL_CAUSAL_GOLDEN;
    expect(Object.keys(g["noisy-15m-all-tfs"].counts.registrationsByTf).length).toBeGreaterThan(1);
    expect(g["noisy-15m-all-tfs"].counts.committed).toBeGreaterThan(5);
    expect(g["noisy-15m-retest-disabled"].counts.committed).toBe(0);
    expect(g["noisy-15m-bar-close-timing"].counts.immediate).toBe(0);
    expect(g["large-1h-seeded-fifo-40"].counts.evictions).toBeGreaterThan(100);
    expect(Object.keys(g["large-1h-seeded-fifo-40"].counts.registrationsByTf).sort()).toEqual(
      ["12M", "1D", "1M", "1W", "3M", "6M"].sort()
    );
    expect(g["large-1h-seeded-fifo-40"].counts.committed).toBeGreaterThan(20);
    expect(g["large-1h-seeded-fifo-40"].counts.immediatePresenceUnproven).toBeGreaterThan(0);
    // Random OHLC almost never closes at its own extreme, so the unprovable-band
    // case is pinned by a dedicated fixture rather than by the noise fixtures.
    expect(g["immediate-proof-flags"].counts.immediateBandUnproven).toBe(1);
    expect(g["immediate-eviction-risk"].counts.immediatePresenceUnproven).toBe(1);
  });

  for (const f of fixtures) {
    it(`${f.name}: the batch replays agree with stepping exactly`, () => {
      const run = runOf(f.name);
      const { committedOnly, withImmediate } = replayPaths(f);
      for (const replay of [committedOnly, withImmediate]) {
        expect(replay.candidates).toEqual(run.committed);
        expect(replay.registrations).toEqual(run.registrations);
        expect(replay.evictions).toEqual(run.evictions);
        expect(canonicalSha256(replay.state)).toBe(canonicalSha256(run.finalState));
      }
      expect(withImmediate.immediateCandidates).toEqual(run.immediate);
    });
  }
});

// ===========================================================================
// Explicit expectations (diagnostic: these say WHAT changed if a hash moves)
// ===========================================================================

const levelOf = (run: FixtureRun, bar: number, id: number) => {
  const level = run.states[bar].levels.find((l) => l.id === id);
  if (!level) throw new Error(`level ${id} absent after bar ${bar}`);
  return level;
};
const committedSummary = (run: FixtureRun) => run.committed.map((c) => [c.chartBarIndex, c.signal, c.touchDirection, c.level.id]);
const immediateSummary = (run: FixtureRun) =>
  run.immediate.map((c) => [
    c.chartBarIndex,
    c.signal,
    c.level.id,
    c.proof.bandEnteredBeforeClosingUpdate,
    c.proof.levelPresentOnEveryUpdate,
  ]);

describe("explicit expectations", () => {
  it("registration: one red candle registers GOR then ROR on each timeframe, D -> 12M", () => {
    const run = runOf("registration-all-tfs-both-colours");
    const expected: [number, string, string, string, number][] = [];
    ["1D", "1W", "1M", "3M", "6M", "12M"].forEach((tf, k) => {
      expected.push([2 * k, tf, "GOR", "GREEN", 120], [2 * k + 1, tf, "ROR", "RED", 80]);
    });
    expect(run.registrations.map((l) => [l.id, l.sourceTf, l.condition, l.color, l.price])).toEqual(expected);
    expect(new Set(run.registrations.map((l) => l.createdBarIndex))).toEqual(new Set([1]));
    expect(run.evictions).toEqual([]);
    expect(run.committed).toEqual([]);
    // Every HTF candle except 1D (a new day each bar) still holds the bar-1 range.
    expect(run.finalState.htf["1W"]?.aggregate).toMatchObject({ open: 100, high: 120, low: 80, close: 100, complete: true });
    expect(run.finalState.htf["1D"]?.previousFlags).toEqual({ GOR: false, ROR: false, GOG: false, ROG: false });
  });

  it("FIFO: maxLevels 3 evicts exactly the oldest, in registration order", () => {
    const run = runOf("fifo-overflow");
    expect(run.registrations.map((l) => [l.id, l.price, l.createdBarIndex])).toEqual([
      [0, 110, 1],
      [1, 111, 3],
      [2, 112, 5],
      [3, 113, 7],
      [4, 114, 9],
      [5, 115, 11],
    ]);
    expect(run.evictions.map((l) => l.id)).toEqual([0, 1, 2]);
    expect(run.finalState.levels.map((l) => l.id)).toEqual([3, 4, 5]);
  });

  it("arm / disarm: armedBar moves only on transitions; the retest fires at armed+4", () => {
    const run = runOf("arm-disarm-rearm-retest");
    const trace = run.states.slice(1).map((_, k) => {
      const l = levelOf(run, k + 1, 0);
      return [k + 1, l.armed, l.armedBarIndex];
    });
    expect(trace).toEqual([
      [1, false, -1],
      [2, true, 2],
      [3, true, 2],
      [4, false, -1],
      [5, false, -1],
      [6, true, 6],
      [7, true, 6],
      [8, true, 6],
      [9, true, 6],
      [10, true, 6],
    ]);
    expect(committedSummary(run)).toEqual([[10, "LONG", "FROM_ABOVE", 0]]);
    expect(immediateSummary(run)).toEqual([[10, "LONG", 0, true, true]]);
    expect(levelOf(run, 10, 0).lastTouchBarIndex).toBe(10);
  });

  it("cooldown: blocked touches and wrong-side touches write nothing; fires at lastTouch+10", () => {
    const run = runOf("cooldown-and-wrong-side");
    expect(committedSummary(run).map(([bar]) => bar)).toEqual([7, 17, 27]);
    expect(immediateSummary(run).map(([bar]) => bar)).toEqual([7, 17, 27]);
    expect([9, 16, 18, 19, 26].map((bar) => levelOf(run, bar, 0).lastTouchBarIndex)).toEqual([7, 7, 17, 17, 17]);
    expect(run.states.slice(2).every((s) => s.levels[0].armed && s.levels[0].armedBarIndex === 2)).toBe(true);
  });

  it("several levels on one bar fire oldest first; colour flips arm/disarm independently", () => {
    const run = runOf("multiple-levels-same-bar");
    expect(run.registrations.map((l) => [l.id, l.color, l.price, l.createdBarIndex])).toEqual([
      [0, "GREEN", 120, 1],
      [1, "GREEN", 121, 3],
      [2, "RED", 80, 5],
    ]);
    expect(committedSummary(run)).toEqual([
      [11, "LONG", "FROM_ABOVE", 0],
      [11, "LONG", "FROM_ABOVE", 1],
      [17, "SHORT", "FROM_BELOW", 2],
    ]);
    expect(immediateSummary(run)).toEqual([
      [11, "LONG", 0, true, true],
      [11, "LONG", 1, true, true],
      [17, "SHORT", 2, true, true],
    ]);
    expect(run.states[12].levels.map((l) => [l.id, l.armed, l.armedBarIndex])).toEqual([
      [0, false, -1],
      [1, false, -1],
      [2, true, 12],
    ]);
  });

  it("immediate proof: close-through, close-at-low and open-inside-band", () => {
    const run = runOf("immediate-proof-flags");
    expect(immediateSummary(run)).toEqual([
      [7, "LONG", 0, true, true],
      [13, "LONG", 0, false, true],
      [24, "LONG", 0, true, true],
    ]);
    expect(committedSummary(run).map(([bar]) => bar)).toEqual([13, 24]);
    expect([7, 8].map((bar) => [levelOf(run, bar, 0).armed, levelOf(run, bar, 0).armedBarIndex])).toEqual([
      [false, -1],
      [true, 8],
    ]);
    expect(levelOf(run, 12, 0).lastTouchBarIndex).toBe(-1);
  });

  it("immediate proof: a full registry puts every level at intrabar eviction risk", () => {
    const run = runOf("immediate-eviction-risk");
    expect(immediateSummary(run)).toEqual([[9, "LONG", 1, true, false]]);
    expect(committedSummary(run)).toEqual([[9, "LONG", "FROM_ABOVE", 1]]);
  });

  it("production-oriented 15m fixture: one 1D GREEN level at 107.5 and one LONG retest", () => {
    const run = runOf("production-15m-all-tfs-7pct");
    expect(run.registrations.map((l) => [l.sourceTf, l.condition, l.color, l.price])).toEqual([["1D", "GOR", "GREEN", 107.5]]);
    expect(run.committed.map((c) => [c.signal, c.sourceTf, c.levelPrice])).toEqual([["LONG", "1D", 107.5]]);
  });
});
