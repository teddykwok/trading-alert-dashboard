import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SWITCHOVER_TRUNCATED_CLOSED_BARS,
  createNativeEngineConfig,
  reconstructPineHistoricalState,
  type NativeKline,
} from "@trading-alert-dashboard/shared";

import {
  CompatReplayError,
  engineStateSha256,
  runCompatibilityReplay,
  selectCompatReplayBars,
  type CompatReplayRecord,
  type CompatReplayRequest,
} from "../src/modules/native-scanner/compat-replay";
import { parseCachedKlines, sha256Hex } from "../src/modules/native-scanner/kline-cache";

/**
 * Slice 2B-2A — OFFLINE, SHA-PINNED parity regressions on the local LDO and
 * THETA caches (Binance USD-M 15m, 2025-12-01 .. 2026-09-15 21:45).
 *
 * Runs only when the exact cache bytes exist on this machine. A missing cache
 * is SKIPPED (fixture unavailable); a cache with any other SHA FAILS — never
 * silently replayed. No network is used and nothing is written.
 *
 * Lineage: history 2026-01-01, switchover 2026-09-12T01:00Z, end 2026-09-15T22:00Z.
 *
 * Why not history 2025-12-01 (the Slice 2B-1 scratch anchor)? With 12M
 * enabled, the year containing 2025-12-01 began on 2025-01-01, so its real
 * open needs context from 2025-01-01 — which these caches do not hold. The
 * production path therefore REFUSES that lineage (pinned below) instead of
 * inventing an HTF open. 2026-01-01 is the earliest history whose full
 * context (from Monday 2025-12-29) the pinned caches contain. Against the
 * scratch run, every registration difference is attributed: periods that now
 * lie before the history (Dec 2025), and the January monthly level, which now
 * falls on the first history bar (PINE_V5_FIRST_HISTORY_BAR_NO_EDGE). No level
 * appears that the scratch run lacked, and no common level moved.
 */

const LOCALAPPDATA = process.env.LOCALAPPDATA;
const cacheFile = (symbol: string) =>
  LOCALAPPDATA ? path.join(LOCALAPPDATA, "trading-alert-dashboard", "scanner", "klines", "USDM_PERPETUAL", symbol, "15m", "klines.jsonl") : null;

const D = (iso: string) => Date.parse(iso);
const ENGINE = createNativeEngineConfig({
  minMovePct: 0.07,
  touchTolerancePct: 0.01,
  touchCooldownBars: 10,
  minBarsAfterCreation: 5,
  minBarsAfterArming: 4,
  maxLevels: 500,
  enabledSourceTfs: ["1D", "1W", "1M", "3M", "6M", "12M"],
  timing: "Immediate",
});
const S = D("2026-09-12T01:00:00Z");
const END = D("2026-09-15T22:00:00Z");
const request = (symbol: string, historyStartMs: number): CompatReplayRequest => ({
  symbol,
  marketType: "USDM_PERPETUAL",
  chartInterval: "15m",
  historyStartMs,
  switchoverMs: S,
  endMs: END,
  engine: ENGINE,
  partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
});

interface Target {
  readonly bar: string;
  readonly signal: "LONG" | "SHORT";
  readonly tf: string;
  readonly price: number;
  readonly immediate: "PROVEN_INTRABAR_POSSIBLE" | "POSSIBLE_ONLY";
}

interface ParitySpec {
  readonly symbol: string;
  readonly cacheSha256: string;
  readonly levelsAtS: readonly { readonly tf: string; readonly color: string; readonly price: number; readonly condition: string; readonly created: string }[];
  readonly primaryTargets: readonly Target[];
  readonly secondaryTargets: readonly Target[];
  /** Native bar|signal groups with no TradingView alert: OBSERVED, not asserted correct. */
  readonly observedUnmatched: readonly string[];
  readonly pinned: {
    readonly lineageId: string;
    readonly bootstrapInputSha256: string;
    readonly causalInputSha256: string;
    readonly stateSha256AtSwitchover: string;
    readonly stateSha256AtEnd: string;
    readonly outputSha256: string;
    readonly rows: number;
    readonly registrationsByTf: Readonly<Record<string, number>>;
    readonly historicalTouchWrites: number;
  };
}

const SPECS: readonly ParitySpec[] = [
  {
    symbol: "LDOUSDT",
    cacheSha256: "7facc31f48a45940b32c1e489e7fa69a865ee580fc05e900c0154369bc8219c0",
    levelsAtS: [
      { tf: "1D", color: "RED", price: 0.3797, condition: "ROR", created: "2026-04-27T00:00:00.000Z" },
      { tf: "1W", color: "GREEN", price: 0.3443, condition: "GOR", created: "2026-02-23T00:00:00.000Z" },
      { tf: "1W", color: "GREEN", price: 0.3431, condition: "GOG", created: "2026-03-30T00:00:00.000Z" },
    ],
    primaryTargets: [
      { bar: "2026-09-12T05:30", signal: "SHORT", tf: "1D", price: 0.3797, immediate: "PROVEN_INTRABAR_POSSIBLE" },
      { bar: "2026-09-12T17:45", signal: "SHORT", tf: "1D", price: 0.3797, immediate: "PROVEN_INTRABAR_POSSIBLE" },
      { bar: "2026-09-14T20:00", signal: "SHORT", tf: "1D", price: 0.3797, immediate: "PROVEN_INTRABAR_POSSIBLE" },
      { bar: "2026-09-15T14:30", signal: "LONG", tf: "1W", price: 0.3443, immediate: "PROVEN_INTRABAR_POSSIBLE" },
      { bar: "2026-09-15T14:45", signal: "LONG", tf: "1W", price: 0.3431, immediate: "PROVEN_INTRABAR_POSSIBLE" },
      { bar: "2026-09-15T18:30", signal: "LONG", tf: "1W", price: 0.3443, immediate: "PROVEN_INTRABAR_POSSIBLE" },
    ],
    secondaryTargets: [{ bar: "2026-09-15T21:30", signal: "LONG", tf: "1W", price: 0.3312, immediate: "PROVEN_INTRABAR_POSSIBLE" }],
    observedUnmatched: ["2026-09-12T08:00|SHORT", "2026-09-12T11:30|SHORT", "2026-09-14T20:30|SHORT"],
    pinned: {
      lineageId: "f36310dca38d44df03e1871746b91b76c8f29b08ce0ccc072b68581cf9148b2c",
      bootstrapInputSha256: "1ec7386c43360abb3d57171d997ed92db223238bebe86de9aa0a175b9b85a337",
      causalInputSha256: "5ef70c3469d44055f92a7b8b1f8ddde684ac3d81def15b7a7401fdf02402f343",
      stateSha256AtSwitchover: "4f875fe91f040b521dd486fd468556008649932e8fc4c996fb28b90f3c16139a",
      stateSha256AtEnd: "40f45f3052005205bcb554e16f2ac262d66eb7a0314350d212ad33857570678b",
      outputSha256: "e5cea6d225c93a54de708113a8f55e58ff6d1e6bd72fce8e4ff32951340a7733",
      rows: 30,
      registrationsByTf: { "1D": 8, "1W": 12, "1M": 5, "3M": 1, "6M": 1 },
      historicalTouchWrites: 396,
    },
  },
  {
    symbol: "THETAUSDT",
    cacheSha256: "141e91a584d4056bfcc9ede02537088e6769c4655e93405a1739844ad5be75d2",
    levelsAtS: [
      { tf: "1W", color: "RED", price: 0.194, condition: "ROR", created: "2026-01-26T00:00:00.000Z" },
      { tf: "1W", color: "RED", price: 0.1936, condition: "ROR", created: "2026-04-27T00:00:00.000Z" },
      { tf: "1D", color: "GREEN", price: 0.2073, condition: "GOG", created: "2026-09-11T00:00:00.000Z" },
    ],
    primaryTargets: [
      { bar: "2026-09-12T03:45", signal: "SHORT", tf: "1W", price: 0.194, immediate: "PROVEN_INTRABAR_POSSIBLE" },
      { bar: "2026-09-12T06:15", signal: "SHORT", tf: "1W", price: 0.1936, immediate: "PROVEN_INTRABAR_POSSIBLE" },
      { bar: "2026-09-12T12:45", signal: "SHORT", tf: "1W", price: 0.1936, immediate: "PROVEN_INTRABAR_POSSIBLE" },
      { bar: "2026-09-12T16:30", signal: "SHORT", tf: "1W", price: 0.194, immediate: "PROVEN_INTRABAR_POSSIBLE" },
      // OHLC cannot prove the band was entered before the closing update here.
      { bar: "2026-09-13T00:15", signal: "SHORT", tf: "1W", price: 0.1936, immediate: "POSSIBLE_ONLY" },
      { bar: "2026-09-13T11:45", signal: "LONG", tf: "1D", price: 0.2073, immediate: "PROVEN_INTRABAR_POSSIBLE" },
    ],
    secondaryTargets: [
      { bar: "2026-09-12T01:00", signal: "SHORT", tf: "1W", price: 0.194, immediate: "PROVEN_INTRABAR_POSSIBLE" },
      { bar: "2026-09-13T11:00", signal: "LONG", tf: "1M", price: 0.2049, immediate: "PROVEN_INTRABAR_POSSIBLE" },
    ],
    observedUnmatched: ["2026-09-12T16:45|SHORT"],
    pinned: {
      lineageId: "98440ba3644503a3a38cb1a45535d9aa28c09b112b3fb1d1be15432c7efe97fa",
      bootstrapInputSha256: "c85737594b8a2ebcaa0ffee08f16516fa2f54592b28144601429d7fbddaac0ff",
      causalInputSha256: "3f78dac929c33d3c78fc13908af6010638f4ac00b952530409263c01a23408f2",
      stateSha256AtSwitchover: "adca1c4b44d3994fec8971a0a44705cb73c93e815a41f72af251d4013ef93fd6",
      stateSha256AtEnd: "640ec19708ee5cc0eeaf426aedf1a12d479a17603d6c418309e80741b9fb77fe",
      outputSha256: "6859e4c3f6bf6bb5dd8b37ee6423153fea907f77a40850c29e684c3528fddcc3",
      rows: 76,
      registrationsByTf: { "1D": 10, "1W": 14, "1M": 4, "3M": 1, "6M": 1 },
      historicalTouchWrites: 415,
    },
  },
];

/** The TradingView bar|signal groups in the window (both symbols), for the "no TV counterpart" observation. */
const TV_BARS: Readonly<Record<string, readonly string[]>> = {
  LDOUSDT: ["2026-09-12T05:30|SHORT", "2026-09-12T17:45|SHORT", "2026-09-14T20:00|SHORT", "2026-09-15T14:30|LONG", "2026-09-15T14:45|LONG", "2026-09-15T18:30|LONG", "2026-09-15T21:30|LONG"],
  THETAUSDT: ["2026-09-12T01:00|SHORT", "2026-09-12T03:45|SHORT", "2026-09-12T06:15|SHORT", "2026-09-12T12:45|SHORT", "2026-09-12T16:30|SHORT", "2026-09-13T00:15|SHORT", "2026-09-13T11:00|LONG", "2026-09-13T11:45|LONG"],
};

const recordsAt = (records: readonly CompatReplayRecord[], t: Target) =>
  records.filter((r) => r.chartBarOpenTime.startsWith(t.bar) && r.signal === t.signal && r.sourceTf === t.tf && r.levelPrice === t.price);

for (const spec of SPECS) {
  const file = cacheFile(spec.symbol);
  const available = file !== null && existsSync(file);

  describe.skipIf(!available)(`${spec.symbol} SHA-pinned compatibility parity (local cache)`, () => {
    // Loaded lazily inside the suite so a missing cache never reads anything.
    let klines: NativeKline[] = [];
    const load = () => {
      if (klines.length > 0) return klines;
      const text = readFileSync(file as string, "utf8");
      // The cache is append-only and legitimately grows (a live --fetch adds newer closed
      // bars). What is pinned is the exact bytes of the range this regression replays:
      // they must hash to the pinned SHA and be the file's untouched prefix. Wrong bytes
      // there are a FAILURE, never a silent replay of different market data.
      const lines = text.split("\n").filter((line) => line !== "");
      const pinned = lines.filter((line) => (JSON.parse(line) as number[])[0] < END);
      const pinnedText = `${pinned.join("\n")}\n`;
      expect(sha256Hex(pinnedText)).toBe(spec.cacheSha256);
      expect(text.startsWith(pinnedText)).toBe(true);
      klines = parseCachedKlines(pinnedText, 15 * 60_000);
      return klines;
    };

    it("the pinned range's cache bytes are exactly the pinned ones (the cache may only have grown after it)", () => {
      expect(load().length).toBe(27_736);
    });

    it("history 2025-12-01 is REFUSED: the 12M period needs context from 2025-01-01, which this cache lacks", () => {
      let error: unknown = null;
      try {
        runCompatibilityReplay(load(), request(spec.symbol, D("2025-12-01T00:00:00Z")));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(CompatReplayError);
      expect((error as CompatReplayError).code).toBe("INSUFFICIENT_HTF_CONTEXT");
      expect((error as CompatReplayError).message).toContain("2025-01-01T00:00:00.000Z");
    });

    const run = () => runCompatibilityReplay(load(), request(spec.symbol, D("2026-01-01T00:00:00Z")));

    it("history 2026-01-01: full context from 2025-12-29, every period known, the pinned lineage and hashes", () => {
      const r = run();
      expect(r.ranges.htfContextStartMs).toBe(D("2025-12-29T00:00:00Z"));
      expect(r.input.contextBarCount).toBe(288);
      expect(r.bootstrap.incompletePeriods).toEqual([]);
      expect(r.bootstrap.unknownPreviousFlagEdges).toEqual([]);
      expect(r.bootstrap.evictionCount).toBe(0);
      expect({
        lineageId: r.lineageId,
        bootstrapInputSha256: r.input.bootstrapInputSha256,
        causalInputSha256: r.input.causalInputSha256,
        stateSha256AtSwitchover: r.bootstrap.stateSha256AtSwitchover,
        stateSha256AtEnd: r.causal.stateSha256AtEnd,
        outputSha256: r.outputSha256,
        rows: r.records.length,
        registrationsByTf: r.bootstrap.registrationsByTf,
        historicalTouchWrites: r.bootstrap.historicalTouchWriteCount,
      }).toEqual(spec.pinned);
    });

    it("the expected TradingView levels are live in the committed state at the switchover", () => {
      const r = run();
      const bars = selectCompatReplayBars(load(), request(spec.symbol, D("2026-01-01T00:00:00Z")));
      const { state } = reconstructPineHistoricalState({
        config: ENGINE,
        historyStartMs: D("2026-01-01T00:00:00Z"),
        switchoverMs: S,
        contextBars: bars.contextBars,
        bars: bars.historyBars,
        partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
      });
      // The production path's state at S IS this state.
      expect(engineStateSha256(state)).toBe(r.bootstrap.stateSha256AtSwitchover);
      for (const level of spec.levelsAtS) {
        const found = state.levels.filter((l) => l.sourceTf === level.tf && l.color === level.color && l.price === level.price);
        expect({ level, found: found.map((l) => [l.condition, new Date(l.createdBarOpenTimeMs).toISOString()]) }).toEqual({
          level,
          found: [[level.condition, level.created]],
        });
      }
    });

    it("every primary and secondary target bar has an exact COMMITTED and IMMEDIATE native event", () => {
      const r = run();
      for (const t of [...spec.primaryTargets, ...spec.secondaryTargets]) {
        const hits = recordsAt(r.records, t);
        expect({ target: t, bases: hits.map((h) => `${h.basis}:${h.evidenceClass}`).sort() }).toEqual({
          target: t,
          bases: [`COMMITTED_BAR_CLOSE:COMMITTED_BAR_CLOSE`, `IMMEDIATE_INTRABAR:${t.immediate}`],
        });
        expect(hits.every((h) => h.actionable === false && h.phase === "CAUSAL_REPLAY" && h.levelOrigin === "HISTORICAL_BOOTSTRAP")).toBe(true);
      }
    });

    it("observed native events with no TradingView alert on their bar are pinned as OBSERVATIONS (not asserted correct)", () => {
      const r = run();
      const tvBars = new Set(TV_BARS[spec.symbol]);
      const unmatched = [...new Set(r.records.map((rec) => `${rec.chartBarOpenTime.slice(0, 16)}|${rec.signal}`))].filter((k) => !tvBars.has(k));
      expect(unmatched).toEqual(spec.observedUnmatched);
    });
  });

  it.runIf(!available)(`${spec.symbol} parity: fixture unavailable on this machine (skipped, not passed)`, () => {
    expect(available).toBe(false);
  });
}
