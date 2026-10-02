import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createNativeEngineConfig,
  createNativeEngineState,
  reconstructImmediateCandidates,
  snapshotNativeEngineForNextBar,
  stepNativeEngine,
  type NativeEngineState,
  type NativeKline,
  type NativeLevelDiagnostic,
} from "@trading-alert-dashboard/shared";

import { canonicalJson, canonicalSha256 } from "../src/modules/native-scanner/canonical-json";
import { engineStateSha256 } from "../src/modules/native-scanner/compat-replay";
import { CandidateRankCliUsageError, parseCandidateRankCliArgs } from "../src/modules/native-scanner/candidate-rank-cli-args";
import {
  CandidateRankHaltError,
  GovernedPublicTransport,
  mapBounded,
  runCandidateRank,
  type CandidateRankRequest,
} from "../src/modules/native-scanner/candidate-rank-runner";
import {
  CANDIDATE_RANK_NOTICE,
  CANDIDATE_RANK_SCHEMA,
  DEFAULT_DELIVERY_SOURCE_TFS,
  compareCandidates,
  evaluateSymbol,
  formatCandidateTable,
  parseTickerPrices,
  proximityOf,
  rankCandidates,
  readinessOf,
  type RankedCandidate,
  type SymbolEvaluation,
} from "../src/modules/native-scanner/candidate-ranker";
import { KlineCacheStore } from "../src/modules/native-scanner/kline-cache";
import type { PublicHttpResponse, PublicHttpTransport } from "../src/modules/native-scanner/kline-fetcher";
import { parseLineageConfig } from "../src/modules/native-scanner/live-shadow-cli-args";
import { prepareLiveShadowState } from "../src/modules/native-scanner/live-shadow-session";
import {
  UniverseSelectionError,
  parseExchangeInfoContracts,
  selectSymbols,
  selectUsdtPerpetualUniverse,
  type UsdmUniverse,
} from "../src/modules/native-scanner/usdm-universe";
import { NATIVE_DELIVERY_V1_SOURCE_TFS } from "../src/modules/native-alerts/native-delivery-policy";
import { goldenFixtures, noisyFifteenMinuteBars } from "./helpers/native-signal-golden-fixtures";
import { doji, repeat, type Ohlc } from "./helpers/native-signal-fixtures";
import { FIFTEEN_MINUTES_MS as M15, fifteenMinute, manualClock } from "./helpers/native-scanner-fakes";

/**
 * Dynamic USD-M universe + READ-ONLY candidate ranker. No network: Binance is
 * an in-memory fake, the clock is manual, the cache is a temporary directory.
 */

// ===========================================================================
// Fixture: the live-shadow lineage (1D, 7%) — GREEN 120 and GREEN 121, both armed by Jan 10
// ===========================================================================

const D = (d: number, h = 0, m = 0) => Date.UTC(2025, 0, d, h, m);
const L0 = D(11);
const LINEAGE_ARGS = [
  "--interval", "15m",
  "--history-start", "2025-01-06T00:00:00Z",
  "--switchover", "2025-01-10T12:00:00Z",
  "--min-move-percent", "7",
  "--touch-tolerance-percent", "1",
  "--cooldown-bars", "10",
  "--min-bars-after-creation", "5",
  "--min-bars-after-arming", "4",
  "--source-timeframes", "1D",
  "--max-levels", "500",
  "--timing", "Immediate",
  "--partial-period-policy", "SWITCHOVER_TRUNCATED_CLOSED_BARS",
];
const lineageArgs = new Map<string, string>();
for (let i = 0; i < LINEAGE_ARGS.length; i += 2) lineageArgs.set(LINEAGE_ARGS[i], LINEAGE_ARGS[i + 1]);
const LINEAGE = parseLineageConfig((name) => lineageArgs.get(name) as string);

function craftedBars(variant: "BASE" | "RECENTLY_ARMED" = "BASE"): NativeKline[] {
  const rows: Ohlc[] = [];
  rows.push(...repeat(doji(100), 96));
  rows.push([100, 120, 99, 99], ...repeat(doji(99), 95)); // Jan 7: GREEN 120
  rows.push(...repeat(doji(99), 96));
  rows.push([99, 121, 98.5, 99], ...repeat(doji(99), 94), [99, 99, 98.9, 98.9]); // Jan 9: GREEN 121
  if (variant === "BASE") rows.push([98.9, 123, 98.9, 123], ...repeat(doji(123), 95));
  else rows.push([98.9, 121.5, 98.9, 121.5], ...repeat(doji(121.5), 94), [121.5, 123, 121.5, 123]);
  rows.push([123, 123, 119.5, 122.5], ...repeat(doji(122.5), 8)); // Jan 11
  return fifteenMinute(D(6), rows);
}
const closedBefore = (bars: NativeKline[], boundaryMs: number) => bars.filter((b) => b.openTimeMs < boundaryMs);

function stateAt(boundaryMs: number, bars = craftedBars()): NativeEngineState {
  return prepareLiveShadowState(bars, { symbol: "TESTUSDT", marketType: "USDM_PERPETUAL", ...LINEAGE, partialPeriodPolicy: "SWITCHOVER_TRUNCATED_CLOSED_BARS", expectedLineageId: null }, boundaryMs, null).state;
}

// ===========================================================================
// 1-2. Universe and selection
// ===========================================================================

const contract = (symbol: string, over: Record<string, unknown> = {}) => ({
  symbol,
  baseAsset: symbol.replace(/USDT$|USDC$|BUSD$/, ""),
  quoteAsset: "USDT",
  contractType: "PERPETUAL",
  status: "TRADING",
  onboardDate: Date.UTC(2020, 0, 1),
  underlyingType: "COIN",
  marginAsset: "USDT",
  ...over,
});

function universeOf(rows: unknown[]): UsdmUniverse {
  return selectUsdtPerpetualUniverse(parseExchangeInfoContracts({ timezone: "UTC", symbols: rows }));
}

describe("1. the USD-M USDT-perpetual universe filter", () => {
  it("keeps TRADING + PERPETUAL + quoteAsset USDT, in code-unit order; excludes everything else by reason", () => {
    const u = universeOf([
      contract("ETHUSDT"),
      contract("BTCUSDT"),
      contract("BTCUSDC", { quoteAsset: "USDC" }),
      // Ends in USDT but is quoted in something else: quoteAsset decides, not the suffix.
      contract("FAKEUSDT", { quoteAsset: "BUSD" }),
      contract("BTCUSDT_261225", { contractType: "CURRENT_QUARTER" }),
      contract("XAUUSDT", { contractType: "TRADIFI_PERPETUAL" }),
      contract("OLDUSDT", { status: "SETTLING" }),
      contract("PENDUSDT", { status: "PENDING_TRADING" }),
      contract("币安人生USDT"),
      contract("1000PEPEUSDT"),
    ]);
    expect(u.contracts.map((c) => c.symbol)).toEqual(["1000PEPEUSDT", "BTCUSDT", "ETHUSDT"]);
    expect(u.excluded).toEqual({ NOT_TRADING: 2, NOT_PERPETUAL: 2, NOT_USDT_QUOTED: 2, INVALID_SYMBOL: 1, CONFLICTING_DUPLICATE: 0 });
    expect(u.totalListed).toBe(10);
    expect(u.contracts[1]).toMatchObject({ symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", displaySymbol: "BTCUSDT.P" });
  });

  it("is independent of payload order and collapses identical duplicates; conflicting duplicates are excluded", () => {
    const rows = [contract("BTCUSDT"), contract("ETHUSDT"), contract("BTCUSDT"), contract("SOLUSDT"), contract("SOLUSDT", { status: "BREAK" })];
    const u = universeOf(rows);
    expect(u.contracts.map((c) => c.symbol)).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(u.identicalDuplicatesCollapsed).toBe(1);
    expect(u.excluded.CONFLICTING_DUPLICATE).toBe(1);
    expect(universeOf([...rows].reverse()).contracts).toEqual(u.contracts);
  });

  it("never hard-codes a count, and refuses a malformed payload instead of guessing", () => {
    const many = Array.from({ length: 777 }, (_, i) => contract(`S${String(i).padStart(4, "0")}USDT`));
    expect(universeOf(many).contracts.length).toBe(777);
    expect(() => parseExchangeInfoContracts({})).toThrow(/symbols array/);
    expect(() => parseExchangeInfoContracts({ symbols: [{ symbol: "BTCUSDT" }] })).toThrow(/baseAsset/);
    expect(() => parseExchangeInfoContracts({ symbols: [contract("BTCUSDT", { onboardDate: "soon" })] })).toThrow(/onboardDate/);
  });
});

describe("2. symbol selection", () => {
  const u = universeOf(["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"].map((s) => contract(s)));

  it("all active, explicit, include/exclude and max-symbols are deterministic", () => {
    expect(selectSymbols(u, { mode: "UNIVERSE", include: [], exclude: [], maxSymbols: null }).symbols).toEqual(["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"]);
    expect(selectSymbols(u, { mode: "EXPLICIT", symbols: ["DDDUSDT", "AAAUSDT"] }).symbols).toEqual(["AAAUSDT", "DDDUSDT"]);
    expect(selectSymbols(u, { mode: "UNIVERSE", include: [], exclude: ["BBBUSDT"], maxSymbols: null }).symbols).toEqual(["AAAUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"]);
    const bounded = selectSymbols(u, { mode: "UNIVERSE", include: ["EEEUSDT"], exclude: ["AAAUSDT"], maxSymbols: 2 });
    expect(bounded.symbols).toEqual(["BBBUSDT", "EEEUSDT"]); // the include survives the limit
    expect(bounded.truncatedByMaxSymbols).toBe(2);
  });

  it("fails closed on malformed, duplicate, unknown or conflicting requests — nothing is silently dropped", () => {
    const refuse = (spec: Parameters<typeof selectSymbols>[1]) => () => selectSymbols(u, spec);
    expect(refuse({ mode: "EXPLICIT", symbols: ["AAAUSDT", "bbbusdt"] })).toThrow(/malformed.*bbbusdt/);
    expect(refuse({ mode: "EXPLICIT", symbols: ["AAAUSDT.P"] })).toThrow(UniverseSelectionError);
    expect(refuse({ mode: "EXPLICIT", symbols: ["AAAUSDT", "AAAUSDT"] })).toThrow(/more than once/);
    expect(refuse({ mode: "EXPLICIT", symbols: ["ZZZUSDT"] })).toThrow(/not active USDT perpetuals: ZZZUSDT/);
    expect(refuse({ mode: "UNIVERSE", include: ["AAAUSDT"], exclude: ["AAAUSDT"], maxSymbols: null })).toThrow(/both included and excluded/);
    expect(refuse({ mode: "UNIVERSE", include: ["AAAUSDT", "BBBUSDT"], exclude: [], maxSymbols: 1 })).toThrow(/more than --max-symbols/);
    expect(refuse({ mode: "UNIVERSE", include: [], exclude: ["ZZZUSDT"], maxSymbols: null })).toThrow(/ZZZUSDT/);
  });
});

// ===========================================================================
// 3. The diagnostic snapshot is read-only and agrees with the engine
// ===========================================================================

describe("3. snapshotNativeEngineForNextBar is non-mutating", () => {
  it("zero, one or many snapshots leave state, its hash, every later step and the replay unchanged", () => {
    const bars = noisyFifteenMinuteBars(1200, 77);
    const config = createNativeEngineConfig({ minMovePct: 0.07, maxLevels: 40 });
    const run = (snapshotsPerBar: number) => {
      let s = createNativeEngineState(config);
      const out: string[] = [];
      for (const bar of bars) {
        const before = engineStateSha256(s);
        for (let k = 0; k < snapshotsPerBar; k += 1) snapshotNativeEngineForNextBar(s);
        expect(engineStateSha256(s)).toBe(before);
        const step = stepNativeEngine(s, bar);
        out.push(canonicalJson({ c: step.candidates, r: step.registered, e: step.evicted }));
        s = step.state;
      }
      return { out, hash: engineStateSha256(s), json: canonicalJson(s) };
    };
    const none = run(0);
    expect(run(1)).toEqual(none);
    expect(run(3)).toEqual(none);
  });

  it("returns frozen copies that share no object with the state", () => {
    const state = stateAt(L0);
    const snap = snapshotNativeEngineForNextBar(state);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.levels)).toBe(true);
    expect(snap.levels.every((l) => Object.isFrozen(l) && Object.isFrozen(l.gates))).toBe(true);
    for (const level of snap.levels) expect(state.levels.includes(level as never)).toBe(false);
    expect(() => {
      (snap.levels[0] as { price: number }).price = 1;
    }).toThrow(TypeError);
    expect(state.levels[0].price).not.toBe(1);
  });

  it("its gates agree with reconstructImmediateCandidates on every bar of every golden fixture", () => {
    let agreed = 0;
    for (const fixture of goldenFixtures()) {
      let state = createNativeEngineState(fixture.config);
      for (const bar of fixture.bars) {
        const snap = snapshotNativeEngineForNextBar(state);
        let predicted: number[] = [];
        if (state.lastBar !== null && state.config.timing === "Immediate" && state.config.retestEnabled && sameInterval(state, bar)) {
          predicted = snap.levels
            .filter((l) => readinessOf(snap, l).readiness === "TRIGGER_READY" && bar.low <= l.upperBand && bar.high >= l.lowerBand)
            .map((l) => l.id);
          const actual = reconstructImmediateCandidates(state, bar).map((c) => c.level.id);
          expect({ fixture: fixture.name, at: bar.openTimeMs, ids: predicted }).toEqual({ fixture: fixture.name, at: bar.openTimeMs, ids: actual });
          agreed += actual.length;
        }
        state = stepNativeEngine(state, bar).state;
      }
    }
    expect(agreed).toBeGreaterThan(0); // the cross-check is not vacuous
  });
});

const sameInterval = (state: NativeEngineState, bar: NativeKline) =>
  state.intervalMs === null || (state.lastBar !== null && bar.openTimeMs === state.lastBar.openTimeMs + state.intervalMs);

// ===========================================================================
// 4-9. Readiness, distance, ranking
// ===========================================================================

const evaluation = (symbol: string, state: NativeEngineState): SymbolEvaluation => ({
  symbol,
  displaySymbol: `${symbol}.P`,
  lineageId: "a".repeat(64),
  snapshot: snapshotNativeEngineForNextBar(state),
  config: state.config,
});
const price = (p: number) => ({ price: p, observedAtMs: L0 + 60_000, source: "test" });

describe("4. readiness from real engine state", () => {
  it("both armed GREEN levels are TRIGGER_READY for the forming bar after Jan 10's rally", () => {
    const rows = evaluateSymbol(evaluation("TESTUSDT", stateAt(L0)), price(122.5), ["1D"]);
    expect(rows.map((r) => [r.levelPrice, r.levelColor, r.expectedSignal, r.touchDirection, r.triggerReadiness])).toEqual([
      [120, "GREEN", "LONG", "FROM_ABOVE", "TRIGGER_READY"],
      [121, "GREEN", "LONG", "FROM_ABOVE", "TRIGGER_READY"],
    ]);
    expect(rows[0].committedPreviousClose).toBe(123);
  });

  it("an arming too recent for minBarsAfterArming is ARMED_TOO_RECENTLY, not ready", () => {
    // RECENTLY_ARMED: closes at 121.5 arm only GREEN 120; the last bar closes 123 and arms 121 at the boundary.
    const rows = evaluateSymbol(evaluation("TESTUSDT", stateAt(L0, craftedBars("RECENTLY_ARMED"))), price(122.5), ["1D"]);
    const at121 = rows.find((r) => r.levelPrice === 121) as Omit<RankedCandidate, "rank">;
    expect(at121.triggerReadiness).toBe("ARMED_TOO_RECENTLY");
    expect(at121.diagnostics.barsSinceArming).toBeLessThan(4);
  });

  it("after the L0 retest fires, both levels are in COOLDOWN; readiness lists every failing gate", () => {
    const rows = evaluateSymbol(evaluation("TESTUSDT", stateAt(L0 + M15)), price(122.5), ["1D"]);
    expect(rows.every((r) => r.triggerReadiness === "COOLDOWN" && r.blockedBy.includes("COOLDOWN"))).toBe(true);
    expect(rows.every((r) => r.diagnostics.barsSinceTouch === 1)).toBe(true);
  });

  it("each gate maps to its readiness, first failure first", () => {
    const level = (gates: Partial<NativeLevelDiagnostic["gates"]>, armed = true): NativeLevelDiagnostic =>
      ({ armed, gates: { armedReady: true, oldEnough: true, cooledDown: true, approachSide: true, ...gates } }) as NativeLevelDiagnostic;
    const ctx = { retestEnabled: true, previousClose: 1 };
    expect(readinessOf(ctx, level({})).readiness).toBe("TRIGGER_READY");
    expect(readinessOf(ctx, level({ armedReady: false }, false)).readiness).toBe("NOT_ARMED");
    expect(readinessOf(ctx, level({ armedReady: false })).readiness).toBe("ARMED_TOO_RECENTLY");
    expect(readinessOf(ctx, level({ oldEnough: false })).readiness).toBe("TOO_YOUNG");
    expect(readinessOf(ctx, level({ cooledDown: false })).readiness).toBe("COOLDOWN");
    expect(readinessOf(ctx, level({ approachSide: false })).readiness).toBe("WRONG_SIDE_NOW");
    expect(readinessOf({ retestEnabled: false, previousClose: 1 }, level({})).readiness).toBe("RETEST_DISABLED");
    expect(readinessOf({ retestEnabled: true, previousClose: null }, level({ approachSide: false })).readiness).toBe("NO_PREVIOUS_CLOSE");
    expect(readinessOf(ctx, level({ oldEnough: false, cooledDown: false, approachSide: false })).blockedBy).toEqual(["TOO_YOUNG", "COOLDOWN", "WRONG_SIDE_NOW"]);
  });
});

describe("5-7. directional distance to the touch band", () => {
  const green = { price: 100, upperBand: 101, lowerBand: 99, color: "GREEN" as const };
  const red = { price: 100, upperBand: 101, lowerBand: 99, color: "RED" as const };

  it("5. GREEN (retested from above): from above the band the move is DOWN to the upper edge", () => {
    const p = proximityOf(105, green);
    expect(p).toMatchObject({ bandSide: "ABOVE_BAND", requiredMove: "DOWN", beyondBandFromApproach: false });
    expect(p.distanceToTouchBandPct).toBeCloseTo(((105 - 101) / 105) * 100, 12);
    expect(p.distanceToLevelPct).toBeCloseTo((5 / 105) * 100, 12);
    expect(proximityOf(95, green)).toMatchObject({ bandSide: "BELOW_BAND", requiredMove: "UP", beyondBandFromApproach: true });
  });

  it("6. RED (retested from below): from below the band the move is UP to the lower edge", () => {
    const p = proximityOf(95, red);
    expect(p).toMatchObject({ bandSide: "BELOW_BAND", requiredMove: "UP", beyondBandFromApproach: false });
    expect(p.distanceToTouchBandPct).toBeCloseTo(((99 - 95) / 95) * 100, 12);
    expect(proximityOf(105, red)).toMatchObject({ bandSide: "ABOVE_BAND", beyondBandFromApproach: true });
  });

  it("7. inside the band the distance is 0 — and that never bypasses readiness", () => {
    expect(proximityOf(100.5, green)).toMatchObject({ distanceToTouchBandPct: 0, bandSide: "IN_BAND", requiredMove: "NONE" });
    expect(proximityOf(99, green).distanceToTouchBandPct).toBe(0);
    expect(proximityOf(101, red).distanceToTouchBandPct).toBe(0);
    // Real state after the retest: in band (121.5 is inside 121's band) but COOLDOWN, so not ranked by default.
    const rows = evaluateSymbol(evaluation("TESTUSDT", stateAt(L0 + M15)), price(121.5), ["1D"]);
    const inBand = rows.find((r) => r.levelPrice === 121) as Omit<RankedCandidate, "rank">;
    expect(inBand).toMatchObject({ distanceToTouchBandPct: 0, triggerReadiness: "COOLDOWN" });
    expect(rankCandidates(rows, { deliverySourceTfs: ["1D"], includeNotReady: false, top: 20, maxPerSymbol: 5 })).toEqual([]);
    expect(rankCandidates(rows, { deliverySourceTfs: ["1D"], includeNotReady: true, top: 20, maxPerSymbol: 5 }).length).toBe(2);
    expect(() => proximityOf(0, green)).toThrow();
  });
});

describe("8-9. delivery timeframes and deterministic ranking", () => {
  it("8. the default ranks 1D/1W only — NATIVE_DELIVERY_V1's allowlist; 1M/3M/6M/12M are never rows", () => {
    expect(DEFAULT_DELIVERY_SOURCE_TFS).toEqual(NATIVE_DELIVERY_V1_SOURCE_TFS);
    const fixture = goldenFixtures().find((f) => f.name === "registration-all-tfs-both-colours")!;
    let state = createNativeEngineState(fixture.config);
    for (const bar of fixture.bars) state = stepNativeEngine(state, bar).state;
    const all = snapshotNativeEngineForNextBar(state).levels.map((l) => l.sourceTf);
    expect(new Set(all)).toEqual(new Set(["1D", "1W", "1M", "3M", "6M", "12M"]));
    const rows = evaluateSymbol(evaluation("ANYUSDT", state), price(100), DEFAULT_DELIVERY_SOURCE_TFS);
    expect(new Set(rows.map((r) => r.sourceTf))).toEqual(new Set(["1D", "1W"]));
    expect(rows.every((r) => r.deliverableUnderNativeDeliveryV1)).toBe(true);
  });

  it("9. ties break by symbol, then TF order, then level key and id — independent of input order", () => {
    const base = evaluateSymbol(evaluation("TESTUSDT", stateAt(L0)), price(122.5), ["1D"]);
    const clone = (symbol: string) => base.map((r) => ({ ...r, symbol, displaySymbol: `${symbol}.P` }));
    const rows = [...clone("BBBUSDT"), ...clone("AAAUSDT"), ...clone("CCCUSDT")];
    const options = { deliverySourceTfs: ["1D" as const], includeNotReady: false, top: 100, maxPerSymbol: 5 };
    const ranked = rankCandidates(rows, options);
    expect(ranked.map((r) => [r.rank, r.symbol, r.levelPrice])).toEqual([
      [1, "AAAUSDT", 121],
      [2, "BBBUSDT", 121],
      [3, "CCCUSDT", 121],
      [4, "AAAUSDT", 120],
      [5, "BBBUSDT", 120],
      [6, "CCCUSDT", 120],
    ]);
    for (let seed = 1; seed < 20; seed += 1) {
      const shuffled = [...rows].sort((a, b) => ((canonicalSha256({ seed, k: a.symbol + a.levelKey }) < canonicalSha256({ seed, k: b.symbol + b.levelKey })) ? -1 : 1));
      expect(rankCandidates(shuffled, options)).toEqual(ranked);
    }
    expect(rankCandidates(rows, { ...options, maxPerSymbol: 1 }).map((r) => r.symbol)).toEqual(["AAAUSDT", "BBBUSDT", "CCCUSDT"]);
    // With --include-not-ready, a closer level that is NOT ready still ranks after every ready one.
    const cooling = evaluateSymbol(evaluation("AAAUSDT", stateAt(L0 + M15)), price(121.5), ["1D"]); // in band, COOLDOWN
    const ready = evaluateSymbol(evaluation("ZZZUSDT", stateAt(L0)), price(122.5), ["1D"]); // above band, TRIGGER_READY
    const mixed = rankCandidates([...cooling, ...ready], { ...options, includeNotReady: true });
    expect(mixed.map((r) => [r.symbol, r.triggerReadiness])).toEqual([
      ["ZZZUSDT", "TRIGGER_READY"],
      ["ZZZUSDT", "TRIGGER_READY"],
      ["AAAUSDT", "COOLDOWN"],
      ["AAAUSDT", "COOLDOWN"],
    ]);
    expect(cooling.some((r) => r.distanceToTouchBandPct === 0)).toBe(true);
    const tie = { ...ranked[0], rank: 0 };
    expect(compareCandidates(tie, { ...tie, levelKey: tie.levelKey + "z" })).toBeLessThan(0);
    expect(compareCandidates(tie, { ...tie, sourceTf: "1W" })).toBeLessThan(0);
  });
});

// ===========================================================================
// 10-12, 15. The runner, against a fake Binance
// ===========================================================================

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface FakeBinance {
  transport: PublicHttpTransport;
  calls: string[];
  maxInFlight: () => number;
  starts: number[];
}

function fakeBinance(options: {
  serverTimeMs: number;
  contracts: unknown[];
  bars: Record<string, NativeKline[]>;
  prices: Record<string, string>;
  failKlines?: Record<string, number>;
  clock: ReturnType<typeof manualClock>;
}): FakeBinance {
  const calls: string[] = [];
  const starts: number[] = [];
  let inFlight = 0;
  let max = 0;
  const ok = (body: unknown, status = 200): PublicHttpResponse => ({ status, header: () => null, text: async () => JSON.stringify(body) });
  const transport: PublicHttpTransport = async (url) => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    starts.push(options.clock.nowMs());
    calls.push(url);
    await Promise.resolve();
    inFlight -= 1;
    const u = new URL(url);
    switch (u.pathname) {
      case "/fapi/v1/exchangeInfo":
        return ok({ timezone: "UTC", serverTime: options.serverTimeMs, symbols: options.contracts });
      case "/fapi/v1/time":
        return ok({ serverTime: options.serverTimeMs });
      case "/fapi/v1/ticker/price":
        return ok(Object.entries(options.prices).map(([symbol, p]) => ({ symbol, price: p, time: options.serverTimeMs })));
      case "/fapi/v1/klines": {
        const symbol = u.searchParams.get("symbol") as string;
        const fail = options.failKlines?.[symbol];
        if (fail !== undefined) return ok({ code: -1 }, fail);
        const start = Number(u.searchParams.get("startTime"));
        const end = Number(u.searchParams.get("endTime"));
        const limit = Number(u.searchParams.get("limit"));
        const rows = (options.bars[symbol] ?? [])
          .filter((b) => b.openTimeMs >= start && b.openTimeMs <= end)
          .slice(0, limit)
          .map((k) => [k.openTimeMs, String(k.open), String(k.high), String(k.low), String(k.close), "1", k.closeTimeMs, "1", 1, "1", "1", "0"]);
        return ok(rows);
      }
      default:
        throw new Error(`unexpected public path ${u.pathname}`);
    }
  };
  return { transport, calls, maxInFlight: () => max, starts };
}

function gappy(): NativeKline[] {
  return craftedBars().filter((b) => b.openTimeMs !== D(8, 6));
}

function scenario(over: { failKlines?: Record<string, number>; prices?: Record<string, string>; cacheDir?: string; serverTimeMs?: number } = {}) {
  const clock = manualClock(L0 + 5 * 60_000);
  const cacheDir = over.cacheDir ?? mkdtempSync(path.join(tmpdir(), "candidate-rank-cache-"));
  if (over.cacheDir === undefined) dirs.push(cacheDir);
  const binance = fakeBinance({
    serverTimeMs: over.serverTimeMs ?? L0 + 5 * 60_000 + 10_000,
    contracts: [
      contract("TESTUSDT"),
      contract("BADUSDT"),
      contract("GAPUSDT"),
      contract("NEWUSDT", { onboardDate: D(9) }),
      contract("NOPRICEUSDT"),
      contract("ETHBUSD", { quoteAsset: "BUSD" }),
    ],
    bars: { TESTUSDT: craftedBars(), BADUSDT: craftedBars(), GAPUSDT: gappy(), NEWUSDT: craftedBars(), NOPRICEUSDT: craftedBars() },
    prices: over.prices ?? { TESTUSDT: "122.5", BADUSDT: "122.5", GAPUSDT: "122.5", NEWUSDT: "122.5" },
    failKlines: over.failKlines,
    clock,
  });
  const logs: string[] = [];
  const deps = {
    transport: binance.transport,
    baseUrl: "https://fapi.binance.com",
    maxTotalRequests: 500,
    minSpacingMs: 250,
    cache: new KlineCacheStore(cacheDir),
    nowMs: clock.nowMs,
    nowIso: () => "2025-01-11T00:05:00.000Z",
    sleep: clock.sleep,
    log: (line: string) => logs.push(line),
  };
  return { binance, deps, logs, cacheDir, clock };
}

const REQUEST: CandidateRankRequest = {
  lineage: LINEAGE,
  selection: { mode: "UNIVERSE", include: [], exclude: [], maxSymbols: null },
  ranking: { deliverySourceTfs: ["1D"], includeNotReady: false, top: 20, maxPerSymbol: 1 },
  concurrency: 4,
  cacheOnly: false,
  universeOnly: false,
};

async function ranked(request = REQUEST, s = scenario()) {
  const report = await runCandidateRank(request, s.deps);
  if (!("candidates" in report)) throw new Error("expected a ranking");
  return { report, s };
}

describe("10. one bad symbol never poisons another", () => {
  it("fetch failures, gaps, late listings and missing prices are skipped with reasons; TESTUSDT still ranks", async () => {
    const { report } = await ranked(REQUEST, scenario({ failKlines: { BADUSDT: 500 } }));
    expect(report.candidates.map((c) => [c.rank, c.symbol, c.levelPrice, c.triggerReadiness])).toEqual([[1, "TESTUSDT", 121, "TRIGGER_READY"]]);
    expect(report.skipped.map((s) => [s.symbol, s.reason])).toEqual([
      ["BADUSDT", "PUBLIC_FETCH_FAILED"],
      ["GAPUSDT", "INCOMPLETE_DATA"],
      ["NEWUSDT", "INSUFFICIENT_HISTORY"],
      ["NOPRICEUSDT", "PRICE_UNAVAILABLE"],
    ]);
    expect(report.universe).toMatchObject({ eligible: 5, totalListed: 6 });
    expect(report.counts).toMatchObject({ selected: 5, rankableSymbols: 1, rankedRows: 1 });
  });

  it("the ranking of TESTUSDT is identical whether or not its neighbours fail", async () => {
    const alone = await ranked({ ...REQUEST, selection: { mode: "EXPLICIT", symbols: ["TESTUSDT"] } });
    const crowded = await ranked(REQUEST, scenario({ failKlines: { BADUSDT: 500 } }));
    expect(crowded.report.candidates).toEqual(alone.report.candidates);
  });
});

describe("11-12. committed state, partial bar and advisory price", () => {
  it("11. the forming bar is never committed, even when a poisoned forming bar sits in the cache", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "candidate-rank-partial-"));
    dirs.push(cacheDir);
    const poisoned = [...closedBefore(craftedBars(), L0), { openTimeMs: L0, closeTimeMs: L0 + M15 - 1, open: 123, high: 900, low: 1, close: 2 }];
    new KlineCacheStore(cacheDir).save("USDM_PERPETUAL", "TESTUSDT", "15m", poisoned, "test");
    const one = { ...REQUEST, selection: { mode: "EXPLICIT" as const, symbols: ["TESTUSDT"] } };
    const { report } = await ranked(one, scenario({ cacheDir }));
    const clean = await ranked(one);
    expect(report.committedState).toMatchObject({ lastCommittedBarOpenTime: new Date(L0 - M15).toISOString(), evaluatedForFormingBarOpenTime: new Date(L0).toISOString() });
    expect(report.candidates).toEqual(clean.report.candidates);
    expect(report.candidates[0].committedPreviousClose).toBe(123);
  });

  it("11b. the boundary comes from Binance's clock minus the settle time: a bar closing seconds ago is not yet committed", async () => {
    // Server time 2s after L0 opens: the L0-15m bar closed, but within the 5s settle window.
    const { report } = await ranked({ ...REQUEST, selection: { mode: "EXPLICIT", symbols: ["TESTUSDT"] } }, scenario({ serverTimeMs: L0 + 2_000 }));
    expect(report.committedState.evaluatedForFormingBarOpenTime).toBe(new Date(L0 - M15).toISOString());
  });

  it("12. the current price moves proximity only — never readiness, gates or state — and is labelled advisory", async () => {
    const one = { ...REQUEST, selection: { mode: "EXPLICIT" as const, symbols: ["TESTUSDT"] }, ranking: { ...REQUEST.ranking, maxPerSymbol: 5 } };
    const near = await ranked(one, scenario({ prices: { TESTUSDT: "122.3" } }));
    const far = await ranked(one, scenario({ prices: { TESTUSDT: "140" } }));
    const strip = (c: RankedCandidate) => ({ ...c, rank: 0, currentPrice: 0, distanceToLevelPct: 0, distanceToTouchBandPct: 0, bandSide: "", requiredMove: "", beyondBandFromApproach: false });
    expect(far.report.candidates.map(strip).sort((a, b) => a.levelId - b.levelId)).toEqual(near.report.candidates.map(strip).sort((a, b) => a.levelId - b.levelId));
    expect(near.report.price.meaning).toMatch(/advisory.*NOT a committed scanner close/);
    expect(near.report.candidates.every((c) => c.actionable === false)).toBe(true);
  });
});

describe("network discipline", () => {
  it("every request is serial and spaced, even with concurrency 4; a warm rerun is served from the cache", async () => {
    const s = scenario({ failKlines: { BADUSDT: 500 } });
    await ranked(REQUEST, s);
    expect(s.binance.maxInFlight()).toBe(1);
    for (let i = 1; i < s.binance.starts.length; i += 1) expect(s.binance.starts[i] - s.binance.starts[i - 1]).toBeGreaterThanOrEqual(250);
    const coldKlineCalls = s.binance.calls.filter((c) => c.includes("/klines")).length;
    const warm = scenario({ cacheDir: s.cacheDir, failKlines: { BADUSDT: 500 } });
    const again = await ranked(REQUEST, warm);
    expect(warm.binance.calls.filter((c) => c.includes("/klines") && c.includes("TESTUSDT"))).toEqual([]);
    expect(coldKlineCalls).toBeGreaterThan(0);
    expect(again.report.counts.symbolsServedFromCacheOnly).toBeGreaterThanOrEqual(1);
  });

  it("a 418/429 anywhere halts the whole run and nothing further is sent", async () => {
    const s = scenario({ failKlines: { BADUSDT: 429 } });
    await expect(runCandidateRank({ ...REQUEST, concurrency: 1 }, s.deps)).rejects.toBeInstanceOf(CandidateRankHaltError);
    const last = s.binance.calls[s.binance.calls.length - 1];
    expect(last).toContain("symbol=BADUSDT");
    expect(s.binance.calls.filter((c) => c.includes("ticker/price"))).toEqual([]);
  });

  it("the governor enforces the run budget and keeps one request for the price", async () => {
    const clock = manualClock();
    let sent = 0;
    const g = new GovernedPublicTransport(async () => ({ status: 200, header: () => null, text: async () => (sent++, "{}") }), {
      maxTotalRequests: 4,
      minSpacingMs: 250,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });
    for (let i = 0; i < 3; i += 1) await g.transport("https://fapi.binance.com/fapi/v1/time", { headers: {} });
    await expect(g.transport("https://fapi.binance.com/fapi/v1/time", { headers: {} })).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXHAUSTED" });
    g.releaseReserve();
    await g.transport("https://fapi.binance.com/fapi/v1/ticker/price", { headers: {} });
    expect(g.requestsMade).toBe(4);
    expect(() => new GovernedPublicTransport(async () => ({}) as never, { maxTotalRequests: 4, minSpacingMs: 10, nowMs: clock.nowMs, sleep: clock.sleep })).toThrow();
  });

  it("mapBounded keeps input order whatever the completion order, and never exceeds its limit", async () => {
    let inFlight = 0;
    let max = 0;
    const delays = [5, 1, 4, 0, 3, 2, 6];
    const out = await mapBounded(delays, 3, async (d, i) => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      for (let k = 0; k < d; k += 1) await Promise.resolve();
      inFlight -= 1;
      return i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(max).toBe(3);
    await expect(mapBounded([1, 2], 0, async (x) => x)).rejects.toThrow();
  });
});

describe("15. the JSON report", () => {
  it("has its schema, notices, config fingerprint, counts and no secret, and is deterministic for the same inputs", async () => {
    const a = await ranked(REQUEST, scenario({ failKlines: { BADUSDT: 500 } }));
    const b = await ranked(REQUEST, scenario({ failKlines: { BADUSDT: 500 } }));
    expect(Object.keys(a.report).sort()).toEqual(
      ["actionable", "candidates", "committedState", "config", "counts", "generatedAt", "notice", "price", "requests", "schema", "skipped", "universe"].sort()
    );
    expect(a.report.schema).toBe(CANDIDATE_RANK_SCHEMA);
    expect(a.report.notice).toEqual(["READ-ONLY CANDIDATE RANKING", "NOT AN ALERT", "NOT ACTIONABLE", "NO ORDER AUTHORITY"]);
    expect(a.report.actionable).toBe(false);
    expect(a.report.config.signal.sha256).toBe(canonicalSha256(a.report.config.signal.canonical));
    expect(canonicalSha256(JSON.parse(JSON.stringify(a.report)))).toBe(canonicalSha256(JSON.parse(JSON.stringify(b.report))));
    expect(JSON.stringify(a.report)).not.toMatch(/apiKey|secret|signature|DATABASE_URL|password/i);
    expect(a.report.candidates[0].lineageId).toMatch(/^[0-9a-f]{64}$/);
    const table = formatCandidateTable(a.report.candidates);
    expect(table[0]).toMatch(/^Rank\s+Symbol\s+Price\s+TF\s+Color\s+Level\s+BandDist%\s+LevelDist%/);
    expect(CANDIDATE_RANK_NOTICE).toContain("NOT ACTIONABLE");
  });

  it("the universe-only mode lists the selection and makes exactly one request", async () => {
    const s = scenario();
    const report = await runCandidateRank({ ...REQUEST, universeOnly: true }, s.deps);
    expect("candidates" in report).toBe(false);
    expect(s.binance.calls.map((c) => new URL(c).pathname)).toEqual(["/fapi/v1/exchangeInfo"]);
    expect(report.universe.selection.symbols).toEqual(["BADUSDT", "GAPUSDT", "NEWUSDT", "NOPRICEUSDT", "TESTUSDT"]);
  });

  it("parses ticker prices strictly", () => {
    expect(parseTickerPrices([{ symbol: "A", price: "1.5", time: 7 }]).get("A")).toMatchObject({ price: 1.5, observedAtMs: 7 });
    expect(() => parseTickerPrices([{ symbol: "A", price: 1.5 }])).toThrow();
    expect(() => parseTickerPrices([{ symbol: "A", price: "1" }, { symbol: "A", price: "2" }])).toThrow(/twice/);
    expect(parseTickerPrices([{ symbol: "A", price: "0" }]).has("A")).toBe(false);
  });
});

// ===========================================================================
// 13-14. CLI and static fences
// ===========================================================================

describe("13. scanner:candidate-rank arguments", () => {
  const base = ["--universe", "usdt-perpetual", ...LINEAGE_ARGS];

  it("defaults to 1D/1W, trigger-ready only, top 20, one row per symbol, serial-safe network settings", () => {
    const o = parseCandidateRankCliArgs(base);
    expect(o.request.ranking).toEqual({ deliverySourceTfs: ["1D"], includeNotReady: false, top: 20, maxPerSymbol: 1 });
    const allTfs = parseCandidateRankCliArgs(base.map((a) => (a === "1D" ? "1D,1W,1M,3M,6M,12M" : a)));
    expect(allTfs.request.ranking.deliverySourceTfs).toEqual(["1D", "1W"]);
    expect(o).toMatchObject({ json: false, maxTotalRequests: 2000, minSpacingMs: 1000 });
    expect(o.request).toMatchObject({ concurrency: 2, cacheOnly: false, universeOnly: false });
  });

  it("refuses unsafe, unknown and conflicting flags", () => {
    const refuse = (argv: string[]) => () => parseCandidateRankCliArgs(argv);
    for (const extra of [["--execute"], ["--account", "A"], ["--commit-dashboard-alerts"], ["--api-key", "x"], ["--profile", "p"], ["--fetch"]]) {
      expect(refuse([...base, ...extra])).toThrow(CandidateRankCliUsageError);
    }
    expect(refuse(LINEAGE_ARGS)).toThrow(/exactly one of --universe/);
    expect(refuse([...base, "--symbols", "BTCUSDT"])).toThrow(/exactly one/);
    expect(refuse(["--symbols", "BTCUSDT", "--max-symbols", "5", ...LINEAGE_ARGS])).toThrow(/only applies with --universe/);
    expect(refuse(["--universe", "all", ...LINEAGE_ARGS])).toThrow(/usdt-perpetual/);
    expect(refuse([...base, "--delivery-source-timeframes", "1D,4H"])).toThrow(/unknown timeframes/);
    expect(refuse([...base, "--delivery-source-timeframes", "1W"])).toThrow(/enabled in --source-timeframes/);
    expect(refuse([...base, "--concurrency", "9"])).toThrow(/1..4/);
    expect(refuse([...base, "--request-spacing-ms", "100"])).toThrow(/250/);
    expect(refuse([...base, "--max-total-requests", "999999"])).toThrow();
    expect(refuse([...base, "--universe-only", "--top", "5"])).toThrow(/ranking options do not apply/);
    expect(refuse([...base, "--json", "--json"])).toThrow(/twice/);
  });
});

const SCANNER_DIR = path.resolve(__dirname, "../src/modules/native-scanner");
const RANKER_FILES = ["usdm-universe.ts", "candidate-ranker.ts", "candidate-rank-runner.ts", "candidate-rank-cli-args.ts", "run-candidate-rank.ts"];
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("14. the ranker reaches no database, queue, alert, account or signed endpoint", () => {
  it.each(RANKER_FILES)("%s", (file) => {
    expect(readdirSync(SCANNER_DIR)).toContain(file);
    const body = code(readFileSync(path.join(SCANNER_DIR, file), "utf8"));
    for (const pattern of [
      /prisma|PrismaClient/i,
      /redis|bullmq|enqueue/i,
      /native-alerts|alerts\.service|alert\.create|NativeAlertDelivery/i,
      /\/execution\/|TradeExecution|extreme-rr|selected-plan/i,
      /bootstrap-account|account-env|BINANCE_API_KEY|BINANCE_API_SECRET|apiSecret|createHmac|signature|listenKey/i,
      /actionable:\s*true/,
    ]) {
      expect({ file, hit: body.match(pattern)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });
});
