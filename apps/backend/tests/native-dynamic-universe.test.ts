import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  NativeSignalInputError,
  SWITCHOVER_TRUNCATED_CLOSED_BARS,
  createNativeEngineConfig,
  htfPeriodStartMs,
  reconstructCausalHistoricalState,
  reconstructHistoricalState,
  type NativeHistoricalInput,
  type NativeKline,
  type NativeSourceTf,
} from "@trading-alert-dashboard/shared";

import { MultiSymbolNativeEmitter, bindPinnedRun, type EmitterCursor, type MultiEmitterEvent } from "../src/modules/native-alerts/multi-symbol-emitter";
import { FileEmitterCursorStore } from "../src/modules/native-alerts/native-emitter-state-files";
import { parseShadowEventLog } from "../src/modules/native-alerts/shadow-log-reader";
import { assertScannerSymbol } from "../src/modules/native-scanner/binance-public-futures";
import { GovernedPublicTransport } from "../src/modules/native-scanner/candidate-rank-runner";
import { CompatReplayError, engineStateSha256 } from "../src/modules/native-scanner/compat-replay";
import {
  isScannerSymbolShape,
  klineStreamNameOf,
  symbolFromPathSegment,
  symbolPathSegment,
  unicodeExchangeSymbolProblem,
} from "../src/modules/native-scanner/exchange-symbol";
import { probeSymbolHistoryOrigin } from "../src/modules/native-scanner/history-origin";
import { KlineCacheStore } from "../src/modules/native-scanner/kline-cache";
import { REQUEST_POLICY_LIMITS, type PublicHttpResponse, type PublicHttpTransport } from "../src/modules/native-scanner/kline-fetcher";
import { buildPublicCombinedKlineStreamUrl, buildPublicKlineStreamUrl } from "../src/modules/native-scanner/live-kline-stream";
import { LiveCheckpointStore, LiveShadowError } from "../src/modules/native-scanner/live-shadow-checkpoint";
import { prepareLiveShadowState, type LiveShadowRequest } from "../src/modules/native-scanner/live-shadow-session";
import { SupervisorCliUsageError, parseSupervisorCliArgs } from "../src/modules/native-scanner/live-shadow-supervisor-cli-args";
import {
  LiveShadowSupervisor,
  SupervisorConfigError,
  assignConnections,
  type MembershipChange,
  type SupervisorCandidate,
} from "../src/modules/native-scanner/live-shadow-supervisor";
import { RunMembershipError, membershipLine, parseMembershipJournal } from "../src/modules/native-scanner/run-membership";
import { acquireLiveShadowLock } from "../src/modules/native-scanner/scanner-lock";
import {
  HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1,
  ScannerLineageError,
  buildScannerLineage,
  effectiveHistoryRanges,
  type SymbolHistoryOrigin,
} from "../src/modules/native-scanner/scanner-lineage";
import {
  ENGINE_NAMESPACE_SCHEMA,
  ScannerProfileError,
  TEDDY_7_ALL_ACTIVE_V1,
  TEDDY_AGGRESSIVE_V1,
  assertEngineNamespace,
  assertScannerProfile,
  dashboardTimeframes,
  engineFingerprintOf,
  engineNamespaceDir,
  engineTimeframes,
  futureExecutionTimeframes,
  lineageConfigOf,
  profileLineageIdFor,
  profileSummaryOf,
  type ScannerProfile,
} from "../src/modules/native-scanner/scanner-profile";
import { buildRunManifest, makeRunId } from "../src/modules/native-scanner/supervisor-run-manifest";
import { supervisorLiveDirFor, supervisorRunManifestOf, supervisorSelectionOf } from "../src/modules/native-scanner/supervisor-run-plan";
import { assertRequestedSymbols, parseExchangeInfoContracts, selectUsdtPerpetualUniverse, UniverseSelectionError } from "../src/modules/native-scanner/usdm-universe";
import { logOf, observation } from "./helpers/native-alert-fixtures";
import { doji, repeat, type Ohlc } from "./helpers/native-signal-fixtures";
import { FIFTEEN_MINUTES_MS as M15, fifteenMinute, plainKlines } from "./helpers/native-scanner-fakes";

/**
 * DYNAMIC NATIVE UNIVERSE (DYNAMIC_UNIVERSE_V1 + SYMBOL_FIRST_CLOSED_BAR_V1):
 * symbol-specific history origin, periodic universe refresh, live onboarding,
 * removal / reactivation, exact Unicode exchange symbols, capacity, and the
 * emitter's dynamic lanes. Fake public REST and WebSocket, manual clock,
 * temporary directories — no network, no database.
 */

const N = TEDDY_7_ALL_ACTIVE_V1;
const OLD_DYNAMIC_7 = "5cd970a602d283f8c019ff07701283a2b290e382563d316769f4efcbf035a041";
const OLD_7 = "47d661a531c9d724d0bfbcb85ff68ea7dd85418464f959be2d0cb1340f4c5179";
const TEDDY_18 = "3e21f1c15207b03b91315767a4b54c92b0e6a21da33149c02c4ec0ee7c903998";
const ALL_TFS: NativeSourceTf[] = ["1D", "1W", "1M", "3M", "6M", "12M"];
const UNICODE = ["币安人生USDT", "我踏马来了USDT", "龙虾USDT", "牛来USDT", "哈基米USDT"];

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const iso = (s: string) => Date.parse(s);

// ===========================================================================
// Identity: semantics, fingerprint, namespace
// ===========================================================================

describe("new semantics, new fingerprint, new namespace", () => {
  const fp = engineFingerprintOf(N);

  it("Teddy 7% All Active carries SYMBOL_FIRST_CLOSED_BAR_V1 + DYNAMIC_UNIVERSE_V1; the fingerprint moved and old engines are untouched", () => {
    expect(N.engine.historyOrigin).toBe(HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1);
    expect(N.universe).toMatchObject({ selection: "ALL_ACTIVE", lifecycle: "DYNAMIC_UNIVERSE_V1", symbolTrust: "EXCHANGE_INFO_UNICODE_V1" });
    expect(fp).toBe("35f1a32d82ac2786ee67dd4c5146760bf1f29d5025cafe01da5394b79a9b47fb");
    expect([OLD_DYNAMIC_7, OLD_7, TEDDY_18]).not.toContain(fp);
    expect(engineFingerprintOf({ ...N, engine: { ...N.engine, historyOrigin: undefined } } as ScannerProfile)).toBe(OLD_DYNAMIC_7);
    expect(engineFingerprintOf(TEDDY_AGGRESSIVE_V1)).toBe(TEDDY_18);
    expect(Object.keys(TEDDY_AGGRESSIVE_V1.engine)).not.toContain("historyOrigin");
  });

  it("the old 5cd970a6 namespace is never shared, and a checkpoint of the old dynamic lineage is refused", () => {
    const root = path.join("C:", "never-created");
    expect(engineNamespaceDir(root, fp)).not.toBe(engineNamespaceDir(root, OLD_DYNAMIC_7));
    const oldManifest = JSON.stringify({ schema: ENGINE_NAMESPACE_SCHEMA, engineFingerprint: OLD_DYNAMIC_7, profileId: N.profileId, engine: {} });
    expect(() => assertEngineNamespace(oldManifest, fp)).toThrow(ScannerProfileError);
    const config = lineageConfigOf(N.engine);
    const common = { marketType: "USDM_PERPETUAL" as const, symbol: "HUMAUSDT", chartInterval: "15m" as const, historyStartMs: config.historyStartMs, compatibilitySwitchoverMs: config.switchoverMs, engineConfig: config.engine, partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS as typeof SWITCHOVER_TRUNCATED_CLOSED_BARS, bootstrapInputSha256: "a".repeat(64) };
    const oldLineage = buildScannerLineage(common);
    const newLineage = buildScannerLineage({ ...common, symbolOrigin: { semantics: HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1, kind: "PROFILE_CONTEXT", firstClosedBarOpenTimeMs: null } });
    expect(newLineage.lineage.schema).toBe("teddy.native-scanner.lineage.v2");
    expect(oldLineage.lineage.schema).toBe("teddy.native-scanner.lineage.v1");
    expect(newLineage.lineageId).not.toBe(oldLineage.lineageId);
  });

  it("the profile refuses a dynamic universe without the symbol origin, and the origin without the dynamic lifecycle", () => {
    expect(() => assertScannerProfile({ ...N, engine: { ...N.engine, historyOrigin: undefined } } as ScannerProfile)).toThrow(/SYMBOL_FIRST_CLOSED_BAR_V1/);
    expect(() => lineageConfigOf({ ...N.engine, lifecycle: undefined })).toThrow(/dynamic source-level lifecycle/);
    expect(() => assertScannerProfile({ ...N, operations: { maxConnections: 16, universeRefreshMs: 5_000 } } as ScannerProfile)).toThrow(/universeRefreshMs/);
    expect(N.operations?.universeRefreshMs).toBe(300_000);
  });
});

// ===========================================================================
// Effective history origin (pure)
// ===========================================================================

describe("effective history origin: max(profile context, first real closed bar)", () => {
  const C = iso("2025-12-29T00:00:00Z");
  const H = iso("2026-01-01T00:00:00Z");
  const S = iso("2026-09-12T01:00:00Z");
  const r = (origin: Parameters<typeof effectiveHistoryRanges>[0]["origin"]) => effectiveHistoryRanges({ historyStartMs: H, compatibilitySwitchoverMs: S, htfContextStartMs: C, intervalMs: M15, origin });

  it("1. a symbol that existed before the context keeps the profile's ranges exactly", () => {
    expect(r({ kind: "PROFILE_CONTEXT", firstClosedBarOpenTimeMs: null })).toEqual({ effectiveContextStartMs: C, effectiveHistoryStartMs: H, effectiveSwitchoverMs: S });
  });

  it("2. later listings start at their first real closed bar (between C and H; between H and S; after S)", () => {
    const brev = iso("2025-12-30T06:00:00Z");
    expect(r({ kind: "SYMBOL_FIRST_CLOSED_BAR", firstClosedBarOpenTimeMs: brev })).toEqual({ effectiveContextStartMs: brev, effectiveHistoryStartMs: H, effectiveSwitchoverMs: S });
    const mid = iso("2026-03-11T11:30:00Z");
    expect(r({ kind: "SYMBOL_FIRST_CLOSED_BAR", firstClosedBarOpenTimeMs: mid })).toEqual({ effectiveContextStartMs: mid, effectiveHistoryStartMs: mid, effectiveSwitchoverMs: S });
    const late = iso("2026-10-01T10:00:00Z");
    // After the switchover: one history bar, then causal — a structural minimum of two closed bars, not an age rule.
    expect(r({ kind: "SYMBOL_FIRST_CLOSED_BAR", firstClosedBarOpenTimeMs: late })).toEqual({ effectiveContextStartMs: late, effectiveHistoryStartMs: late, effectiveSwitchoverMs: late + M15 });
  });

  it("a first bar at or before the context start, misaligned, or a malformed origin is refused (never guessed)", () => {
    expect(() => r({ kind: "SYMBOL_FIRST_CLOSED_BAR", firstClosedBarOpenTimeMs: C })).toThrow(ScannerLineageError);
    expect(() => r({ kind: "SYMBOL_FIRST_CLOSED_BAR", firstClosedBarOpenTimeMs: C + M15 + 1 })).toThrow(ScannerLineageError);
    expect(() => r({ kind: "SYMBOL_FIRST_CLOSED_BAR", firstClosedBarOpenTimeMs: null })).toThrow(ScannerLineageError);
    expect(() => r({ kind: "PROFILE_CONTEXT", firstClosedBarOpenTimeMs: H })).toThrow(ScannerLineageError);
  });
});

/** A 15m engine over the real profile lineage, but on its own timeline. */
function requestFor(symbol: string, over: Partial<LiveShadowRequest> = {}): LiveShadowRequest {
  const config = lineageConfigOf(N.engine);
  return {
    symbol,
    marketType: "USDM_PERPETUAL",
    chartInterval: "15m",
    historyStartMs: config.historyStartMs,
    switchoverMs: config.switchoverMs,
    engine: config.engine,
    partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
    expectedLineageId: null,
    historyOrigin: HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1,
    ...over,
  };
}

describe("history bootstrap from the symbol's own origin (prepareLiveShadowState)", () => {
  const F = iso("2026-08-01T10:00:00Z");
  const END = iso("2026-09-13T00:00:00Z");
  const listing = plainKlines(F, (END - F) / M15);
  const origin = { kind: "SYMBOL_FIRST_CLOSED_BAR" as const, firstClosedBarOpenTimeMs: F };

  it("2/3. a symbol listed after the profile context bootstraps from its first real bar; pre-listing absence is no gap", () => {
    const plan = prepareLiveShadowState(listing, requestFor("NEWUSDT", { symbolOrigin: origin }), END, null);
    expect(plan.lineage.symbolHistoryOrigin).toMatchObject({ kind: "SYMBOL_FIRST_CLOSED_BAR", firstClosedBarOpenTimeMs: F, effectiveContextStartMs: F, effectiveHistoryStartMs: F });
    expect(plan.hwmOpenTimeMs).toBe(END);
    expect(plan.checkpointBody.compatibilitySwitchoverMs).toBe(iso("2026-09-12T01:00:00Z"));
  });

  it("mutant contrast: the same bytes under the fixed global history origin are refused (the old permanent TOO_NEW)", () => {
    expect(() => prepareLiveShadowState(listing, requestFor("NEWUSDT", { historyOrigin: undefined, symbolOrigin: null }), END, null)).toThrow(CompatReplayError);
  });

  it("4. a REAL missing bar after the first market bar is still a gap: refused", () => {
    const gapped = listing.filter((k) => k.openTimeMs !== iso("2026-08-20T00:00:00Z"));
    expect(() => prepareLiveShadowState(gapped, requestFor("NEWUSDT", { symbolOrigin: origin }), END, null)).toThrow(/INCOMPLETE_DATA|does not hold every bar/);
  });

  it("real bars before the claimed first bar contradict the origin: ORIGIN_CONTRADICTED, never repaired", () => {
    const earlier = [...plainKlines(F - 4 * M15, 4), ...listing];
    expect(() => prepareLiveShadowState(earlier, requestFor("NEWUSDT", { symbolOrigin: origin }), END, null)).toThrow(expect.objectContaining({ code: "ORIGIN_CONTRADICTED" }));
  });

  it("the origin is required by a symbol-origin engine and refused by any other", () => {
    expect(() => prepareLiveShadowState(listing, requestFor("NEWUSDT", { symbolOrigin: null }), END, null)).toThrow(LiveShadowError);
    expect(() => prepareLiveShadowState(listing, requestFor("NEWUSDT", { historyOrigin: undefined, symbolOrigin: origin }), END, null)).toThrow(LiveShadowError);
  });
});

describe("existing-symbol replay equivalence: PROFILE_CONTEXT reproduces the old dynamic engine bar for bar", () => {
  const FIXTURE = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "native-dynamic-lifecycle-klines.json"), "utf8")) as Record<string, number[][]> & { intervalMs: number };
  const klines = (symbol: string): NativeKline[] =>
    FIXTURE[symbol].map(([openTimeMs, open, high, low, close]) => ({ openTimeMs, closeTimeMs: openTimeMs + FIXTURE.intervalMs - 1, open, high, low, close }));
  // Fixture timeline (from 2026-09-01): 1D and 1M periods both begin at the history start, so no context is needed.
  const engine = createNativeEngineConfig({ ...lineageConfigOf(N.engine).engine, enabledSourceTfs: ["1D", "1M"] });
  const base = (symbol: string): LiveShadowRequest => ({
    symbol, marketType: "USDM_PERPETUAL", chartInterval: "15m", historyStartMs: iso("2026-09-01T00:00:00Z"), switchoverMs: iso("2026-09-12T01:00:00Z"),
    engine, partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS, expectedLineageId: null,
  });

  it.each(["HUMAUSDT", "BNBUSDT"])("%s: identical state at the switchover and at the frontier; only the lineage identity differs", (symbol) => {
    const bars = klines(symbol);
    const end = bars[bars.length - 1].openTimeMs + M15;
    const old = prepareLiveShadowState(bars, base(symbol), end, null);
    const now = prepareLiveShadowState(bars, { ...base(symbol), historyOrigin: HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1, symbolOrigin: { kind: "PROFILE_CONTEXT", firstClosedBarOpenTimeMs: null } }, end, null);
    expect(now.stateSha256AtSwitchover).toBe(old.stateSha256AtSwitchover);
    expect(engineStateSha256(now.state)).toBe(engineStateSha256(old.state));
    expect(now.state.levels).toEqual(old.state.levels);
    expect(now.replayedNonActionableCandidates).toBe(old.replayedNonActionableCandidates);
    expect(now.lineageId).not.toBe(old.lineageId);
  });

  it("HUMA/BNB through the REAL profile as late listings (origin 2026-09-01): the 1W 0.032724 candidate and no stale 781.44 / 808.23 levels", () => {
    const humaBars = klines("HUMAUSDT");
    const origin = { kind: "SYMBOL_FIRST_CLOSED_BAR" as const, firstClosedBarOpenTimeMs: humaBars[0].openTimeMs };
    const huma = prepareLiveShadowState(humaBars, requestFor("HUMAUSDT", { symbolOrigin: origin }), iso("2026-10-01T01:00:00Z"), null);
    expect(huma.state.htf["1W"]!.candidates!.GREEN).toMatchObject({ periodStartMs: iso("2026-09-28T00:00:00Z"), price: 0.032724, active: true, firstQualifiedBarOpenTimeMs: iso("2026-10-01T00:45:00Z") });
    const humaEnd = prepareLiveShadowState(humaBars, requestFor("HUMAUSDT", { symbolOrigin: origin }), humaBars[humaBars.length - 1].openTimeMs + M15, null);
    expect(humaEnd.state.levels.filter((l) => l.sourceTf === "1W" && [0.032724, 0.034664, 0.03626].includes(l.price))).toEqual([]);
    const bnbBars = klines("BNBUSDT");
    const bnb = prepareLiveShadowState(bnbBars, requestFor("BNBUSDT", { symbolOrigin: { kind: "SYMBOL_FIRST_CLOSED_BAR", firstClosedBarOpenTimeMs: bnbBars[0].openTimeMs } }), bnbBars[bnbBars.length - 1].openTimeMs + M15, null);
    expect(bnb.state.levels.filter((l) => [781.44, 808.23].includes(l.price))).toEqual([]);
    // No two finalized levels share a key.
    for (const plan of [humaEnd, bnb]) {
      const keys = plan.state.levels.map((l) => `${l.sourceTf}:${l.condition}:${l.createdBarOpenTimeMs}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("7-10. a listing's first source periods contain only its real post-listing bars", () => {
  const config = createNativeEngineConfig({ minMovePct: 0.07, touchTolerancePct: 0.01, touchCooldownBars: 10, minBarsAfterCreation: 5, minBarsAfterArming: 4, enabledSourceTfs: ALL_TFS, lifecycle: "TEDDY_DYNAMIC_SOURCE_LEVEL_V1" });
  // Wednesday 2026-07-15 10:00 UTC: mid-day, mid-week, mid-month, mid-quarter, mid-half, mid-year.
  const F = iso("2026-07-15T10:00:00Z");
  const bars = plainKlines(F, 40);
  const input = (listing: boolean): NativeHistoricalInput => ({ config, historyStartMs: F, switchoverMs: F + 40 * M15, contextBars: [], bars, partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS, ...(listing ? { listingOpenTimeMs: F } : {}) });

  it.each(ALL_TFS)("%s: the period opens at the listing bar's own open; high/low/close come only from real bars; it counts as complete", (tf) => {
    const { state } = reconstructCausalHistoricalState(input(true));
    const aggregate = state.htf[tf]!.aggregate!;
    expect(aggregate).toEqual({
      periodStartMs: htfPeriodStartMs(tf, F, config.calendar),
      open: bars[0].open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars[bars.length - 1].close,
      complete: true,
    });
    // Without the listing marker the period's open is unknown (complete false): nothing is fabricated either way.
    const plain = reconstructCausalHistoricalState(input(false)).state.htf[tf]!.aggregate!;
    expect({ ...plain, complete: true }).toEqual(aggregate);
    expect(plain.complete).toBe(false);
  });

  it("a 7% move inside the listing day qualifies a candidate only because the listing period's open is known; no pre-listing bar exists", () => {
    // A green listing day whose wick is 9% of its open: GOG = (high - close) / open >= 7%.
    const rows: Ohlc[] = [[100, 100.5, 99.5, 100], [100, 110, 100, 101], ...repeat(doji(101), 10)];
    const rally = fifteenMinute(F, rows);
    const make = (listing: boolean) =>
      reconstructCausalHistoricalState(<NativeHistoricalInput>{ config, historyStartMs: F, switchoverMs: F + rows.length * M15, contextBars: [], bars: rally, partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS, ...(listing ? { listingOpenTimeMs: F } : {}) });
    expect(make(true).state.htf["1D"]!.candidates!.GREEN).toMatchObject({ price: 110, condition: "GOG", firstQualifiedBarOpenTimeMs: F + M15 });
    expect(make(false).state.htf["1D"]!.candidates!.GREEN).toBeNull();
  });

  it("the listing marker must be the first bar given, and only the dynamic lifecycle accepts it", () => {
    expect(() => reconstructCausalHistoricalState({ ...input(false), listingOpenTimeMs: F + M15 })).toThrow(NativeSignalInputError);
    const legacy = createNativeEngineConfig({ minMovePct: 0.07, enabledSourceTfs: ["1D"] });
    expect(() => reconstructHistoricalState({ ...input(false), config: legacy, listingOpenTimeMs: F })).toThrow(NativeSignalInputError);
  });
});

// ===========================================================================
// First real closed bar from public klines
// ===========================================================================

describe("5/6. the first real closed 15m bar comes from actual klines; ambiguity is UNREADABLE, never guessed", () => {
  const C = iso("2025-12-29T00:00:00Z");
  const NOW = iso("2026-10-05T12:00:03Z");
  const row = (k: NativeKline) => [k.openTimeMs, String(k.open), String(k.high), String(k.low), String(k.close), "1", k.closeTimeMs, "1", 1, "1", "1", "0"];
  const probe = (respond: (url: URL) => { status: number; body: unknown }, opts: { onboard?: number | null; cached?: NativeKline[] } = {}) => {
    const urls: string[] = [];
    const transport: PublicHttpTransport = async (url) => {
      urls.push(url);
      const u = new URL(url);
      if (u.pathname === "/fapi/v1/time") return { status: 200, header: () => null, text: async () => JSON.stringify({ serverTime: NOW }) };
      const r = respond(u);
      return { status: r.status, header: () => null, text: async () => JSON.stringify(r.body) };
    };
    return probeSymbolHistoryOrigin({
      symbol: "NEWUSDT", chartInterval: "15m", contextStartMs: C, onboardDateMs: opts.onboard ?? null, settleMs: 5_000,
      cache: { load: () => (opts.cached === undefined ? null : { klines: opts.cached } as never), save: () => undefined },
      fetchDeps: { transport, baseUrl: "https://fapi.binance.com", policy: { maxRequests: 10, minSpacingMs: 250, maxTransientRetries: 0, transientBackoffMs: 250 }, nowMs: () => NOW, sleep: async () => undefined },
    }).then((outcome) => ({ outcome, urls }));
  };
  const F = iso("2026-03-11T11:30:00Z");

  it("first bar later than the context start and closed: SYMBOL_FIRST_CLOSED_BAR at its open; the request starts at the context start", async () => {
    const { outcome, urls } = await probe(() => ({ status: 200, body: plainKlines(F, 2).map(row) }));
    expect(outcome).toMatchObject({ kind: "ORIGIN", source: "BINANCE", origin: { kind: "SYMBOL_FIRST_CLOSED_BAR", firstClosedBarOpenTimeMs: F } });
    expect(new URL(urls[1]).searchParams.get("startTime")).toBe(String(C));
  });

  it("5. an onboardDate EARLIER than the first kline: the actual kline wins and the discrepancy is reported", async () => {
    const { outcome } = await probe(() => ({ status: 200, body: plainKlines(F, 2).map(row) }), { onboard: F - 3 * 60 * 60_000 });
    expect(outcome).toMatchObject({ kind: "ORIGIN", origin: { firstClosedBarOpenTimeMs: F }, onboardDiscrepancyMs: 3 * 60 * 60_000 });
  });

  it("data at the context start: PROFILE_CONTEXT (from Binance, or from the verified cache with no request at all)", async () => {
    expect((await probe(() => ({ status: 200, body: plainKlines(C, 2).map(row) }))).outcome).toMatchObject({ kind: "ORIGIN", origin: { kind: "PROFILE_CONTEXT" } });
    const cached = await probe(() => ({ status: 500, body: {} }), { cached: plainKlines(C, 3) });
    expect(cached.outcome).toMatchObject({ kind: "ORIGIN", source: "CACHE", origin: { kind: "PROFILE_CONTEXT" }, requests: 0 });
    expect(cached.urls).toEqual([]);
  });

  it("no bar yet, or the first bar still forming: WAITING_FIRST_CLOSED_BAR with a retry at the next close (unknown is not absent)", async () => {
    expect((await probe(() => ({ status: 200, body: [] }))).outcome).toMatchObject({ kind: "WAITING_FIRST_CLOSED_BAR", retryAtMs: iso("2026-10-05T12:15:05Z") });
    const forming = plainKlines(iso("2026-10-05T12:00:00Z"), 1);
    expect((await probe(() => ({ status: 200, body: forming.map(row) }))).outcome).toMatchObject({ kind: "WAITING_FIRST_CLOSED_BAR", retryAtMs: iso("2026-10-05T12:15:05Z") });
  });

  it("6. failure, malformed rows, disorder or a bar before the start: BOOTSTRAP_UNREADABLE", async () => {
    expect((await probe(() => ({ status: 503, body: {} }))).outcome.kind).toBe("UNREADABLE");
    expect((await probe(() => ({ status: 200, body: [["x"]] }))).outcome.kind).toBe("UNREADABLE");
    expect((await probe(() => ({ status: 200, body: [...plainKlines(F, 2)].reverse().map(row) }))).outcome.kind).toBe("UNREADABLE");
    expect((await probe(() => ({ status: 200, body: plainKlines(C - M15, 2).map(row) }))).outcome.kind).toBe("UNREADABLE");
  });

  it("a rate limit is never folded into UNREADABLE: it propagates so the whole REST plane halts", async () => {
    await expect(probe(() => ({ status: 429, body: {} }))).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

// ===========================================================================
// Exact Unicode exchange symbols
// ===========================================================================

describe("33-39. exact Unicode exchange symbols", () => {
  it("the five live Binance Unicode perpetuals have a valid shape; cased, decomposed, punctuated or traversal strings do not", () => {
    for (const s of UNICODE) expect(unicodeExchangeSymbolProblem(s)).toBeNull();
    for (const bad of ["ÄBCUSDT", "ΔΕΛΤΑUSDT", "币安人生usdt", "../币安USDT", "币/安USDT", "币安 USDT", "币安.USDT", "币安\u0000USDT", "caféUSDT", "币", "BTCUSDT"]) {
      expect(unicodeExchangeSymbolProblem(bad)).not.toBeNull();
    }
    expect(isScannerSymbolShape("BTCUSDT")).toBe(true);
    expect(() => assertScannerSymbol("../etc")).toThrow();
  });

  it("33/34. accepted ONLY from exchangeInfo as TRADING + PERPETUAL + USDT under EXCHANGE_INFO_UNICODE_V1; the ASCII universe is unchanged", () => {
    const rows = [
      ...UNICODE.map((symbol) => ({ symbol, baseAsset: symbol.replace(/USDT$/, ""), quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", onboardDate: 1, underlyingType: "COIN" })),
      { symbol: "币安SETTLEUSDT", baseAsset: "x", quoteAsset: "USDT", contractType: "PERPETUAL", status: "SETTLING", onboardDate: 1 },
      { symbol: "ÄBCUSDT", baseAsset: "x", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", onboardDate: 1 },
      { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", onboardDate: 1 },
    ];
    const contracts = parseExchangeInfoContracts({ symbols: rows });
    const unicode = selectUsdtPerpetualUniverse(contracts, "EXCHANGE_INFO_UNICODE_V1");
    expect(unicode.contracts.map((c) => c.symbol)).toEqual(["BTCUSDT", ...[...UNICODE].sort()]);
    expect(unicode.excluded).toMatchObject({ NOT_TRADING: 1, INVALID_SYMBOL: 1 });
    const ascii = selectUsdtPerpetualUniverse(contracts);
    expect(ascii.contracts.map((c) => c.symbol)).toEqual(["BTCUSDT"]);
    expect(ascii.excluded.INVALID_SYMBOL).toBe(6);
    // An operator can never name a Unicode string: the CLI accepts ASCII symbols only.
    expect(() => assertRequestedSymbols(["龙虾USDT"], "--symbols")).toThrow(UniverseSelectionError);
    const options = parseSupervisorCliArgs(["--profile", "teddy-7-all-active", "--symbols", "龙虾USDT"]);
    expect(() => supervisorSelectionOf(unicode, options.selection)).toThrow(UniverseSelectionError);
  });

  it("35/38/39. path identity: ASCII unchanged, Unicode \"u-<utf8 hex>\", reversible, distinct, traversal-free, case-safe", () => {
    expect(symbolPathSegment("BTCUSDT")).toBe("BTCUSDT");
    const segments = UNICODE.map(symbolPathSegment);
    expect(segments[0]).toBe(`u-${Buffer.from("币安人生USDT", "utf8").toString("hex")}`);
    for (const seg of segments) expect(seg).toMatch(/^u-[0-9a-f]+$/);
    expect(new Set(segments).size).toBe(UNICODE.length);
    expect(new Set(segments.map((s) => s.toLowerCase())).size).toBe(UNICODE.length);
    expect(UNICODE.map((s) => symbolFromPathSegment(symbolPathSegment(s)))).toEqual(UNICODE);
    expect(symbolPathSegment("CON")).toMatch(/^u-/);
    expect(() => symbolPathSegment("../x")).toThrow();
    expect(() => symbolFromPathSegment("u-2e2e2f")).toThrow();
    const root = path.join("C:", "scanner");
    const dir = supervisorLiveDirFor(root, profileSummaryOf(N), "15m")("币安人生USDT");
    expect(path.relative(engineNamespaceDir(root, engineFingerprintOf(N)), dir).split(path.sep)).toEqual(["USDM_PERPETUAL", segments[0], "15m"]);
    expect(new FileEmitterCursorStore(root)["fileOf"]("币安人生USDT")).toBe(path.join(root, `${segments[0]}.json`));
  });

  it("37. the WebSocket name is the verified lower-cased form, carried percent-encoded in the combined URL; raw single-symbol mode fails closed", () => {
    expect(klineStreamNameOf("币安人生USDT", "15m")).toBe("币安人生usdt@kline_15m");
    expect(klineStreamNameOf("BTCUSDT", "15m")).toBe("btcusdt@kline_15m");
    const url = buildPublicCombinedKlineStreamUrl(["BTCUSDT", "币安人生USDT"], "15m");
    expect(new URL(url).searchParams.get("streams")).toBe("btcusdt@kline_15m/币安人生usdt@kline_15m");
    expect(new URL(url).href).toContain("%E5%B8%81%E5%AE%89%E4%BA%BA%E7%94%9Fusdt@kline_15m");
    expect(buildPublicCombinedKlineStreamUrl(["BTCUSDT", "币安人生USDT"], "15m")).toBe(url);
    expect(() => buildPublicKlineStreamUrl("币安人生USDT", "15m")).toThrow(/ASCII-only/);
  });
});

// ===========================================================================
// The dynamic supervisor (fixture engine: 1D, short timeline)
// ===========================================================================

const D = (d: number, h = 0, m = 0, s = 0) => Date.UTC(2025, 0, d, h, m, s);
const CTX = D(6);
const FIX: ScannerProfile = {
  ...N,
  engine: { ...N.engine, historyStart: "2025-01-06T00:00:00Z", switchover: "2025-01-10T12:00:00Z", engineSourceTimeframes: engineTimeframes("1D") },
  delivery: { ...N.delivery, dashboardSourceTimeframes: dashboardTimeframes("1D") },
  execution: { ...N.execution, futureExecutionSourceTimeframes: futureExecutionTimeframes("1D") },
} as ScannerProfile;
const LINEAGE = lineageConfigOf(FIX.engine);

function fullBars(): NativeKline[] {
  const rows: Ohlc[] = [];
  rows.push(...repeat(doji(100), 96));
  rows.push([100, 120, 99, 99], ...repeat(doji(99), 95));
  rows.push(...repeat(doji(99), 96));
  rows.push([99, 121, 98.5, 99], ...repeat(doji(99), 94), [99, 99, 98.9, 98.9]);
  rows.push([98.9, 123, 98.9, 123], ...repeat(doji(123), 95));
  rows.push([123, 123, 119.5, 122.5], ...repeat(doji(122.5), 8));
  return fifteenMinute(D(6), rows);
}
const FULL = fullBars();
const barAt = (ms: number) => FULL.find((b) => b.openTimeMs === ms) as NativeKline;

/** Default data by name: NEW* listed D(8) (later than the context); GAP* listed D(8) with a real gap; everything else since the context. */
const defaultBars = (symbol: string): NativeKline[] =>
  symbol.startsWith("NEW") ? FULL.filter((b) => b.openTimeMs >= D(8)) : symbol.startsWith("GAP") ? FULL.filter((b) => b.openTimeMs >= D(8) && b.openTimeMs !== D(9, 6)) : FULL;

function contractRow(symbol: string, over: Record<string, unknown> = {}) {
  return { symbol, baseAsset: symbol.replace(/USDT$/, ""), quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", onboardDate: symbol.startsWith("NEW") || symbol.startsWith("GAP") ? D(8) : CTX - 86_400_000, underlyingType: "COIN", ...over };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

function harness(initial: string[], opts: { perConnection?: number; maxConnections?: number } = {}) {
  let now = D(10, 23, 59);
  const root = tmp("dyn-root-");
  const cacheDir = tmp("dyn-cache-");
  const rows = new Map<string, Record<string, unknown>>(initial.map((s) => [s, contractRow(s)]));
  const data = new Map<string, NativeKline[]>();
  const failing = new Set<string>();
  const gates = new Map<string, Promise<void>>();
  const sockets: { url: string; handlers: Parameters<ConstructorParameters<typeof LiveShadowSupervisor>[1]["openStream"]>[1]; closed: boolean }[] = [];
  const rest: string[] = [];
  const logs: string[] = [];
  const journal: MembershipChange[] = [];
  const scheduled: Array<() => void> = [];
  const universeControl = { calls: 0, fail: 0, gate: null as Promise<void> | null };
  const ok = (body: unknown, status = 200): PublicHttpResponse => ({ status, header: () => null, text: async () => JSON.stringify(body) });
  const transport: PublicHttpTransport = async (url) => {
    rest.push(url);
    const u = new URL(url);
    if (u.pathname === "/fapi/v1/time") return ok({ serverTime: now });
    const symbol = u.searchParams.get("symbol") as string;
    const gate = gates.get(symbol);
    if (gate !== undefined) await gate;
    if (failing.has(symbol)) return ok({}, 500);
    const start = Number(u.searchParams.get("startTime"));
    const end = Number(u.searchParams.get("endTime"));
    const source = data.get(symbol) ?? defaultBars(symbol);
    return ok(source.filter((b) => b.openTimeMs >= start && b.openTimeMs <= end && b.closeTimeMs < now).slice(0, Number(u.searchParams.get("limit"))).map((k) => [k.openTimeMs, String(k.open), String(k.high), String(k.low), String(k.close), "1", k.closeTimeMs, "1", 1, "1", "1", "0"]));
  };
  const sleep = async (ms: number) => void (now += ms);
  const governor = new GovernedPublicTransport(transport, { maxTotalRequests: 20_000, minSpacingMs: REQUEST_POLICY_LIMITS.minSpacingFloorMs, nowMs: () => now, sleep });
  const universe = () => selectUsdtPerpetualUniverse(parseExchangeInfoContracts({ symbols: [...rows.values()] }), "EXCHANGE_INFO_UNICODE_V1");
  const summary = profileSummaryOf(FIX);
  const dirOf = supervisorLiveDirFor(root, summary, "15m");
  const selection = supervisorSelectionOf(universe(), { mode: "UNIVERSE", include: [], exclude: [], maxSymbols: null });
  const supervisor = new LiveShadowSupervisor(
    {
      lineage: LINEAGE,
      selection,
      universeActive: selection.candidates.length,
      symbolsPerConnection: opts.perConnection ?? 3,
      maxConnections: opts.maxConnections ?? 8,
      restConcurrency: 2,
      queueCapacity: 10_000,
      maxProcessingLagMs: 600_000,
      staleSymbolMs: 1_800_000,
      maxRecoveryAttempts: 3,
      liveDirFor: dirOf,
      runId: makeRunId(now, "d1a2b3c4"),
      profile: summary,
      dynamicUniverse: { refreshIntervalMs: 300_000 },
    },
    {
      openStream: (url, handlers) => {
        const socket = { url, handlers, closed: false };
        sockets.push(socket);
        handlers.onOpen();
        return { close: () => (socket.closed = true) };
      },
      governor,
      fetchDeps: { transport: governor.transport, baseUrl: "https://fapi.binance.com", policy: { maxRequests: 500, minSpacingMs: 250, maxTransientRetries: 0, transientBackoffMs: 250 }, nowMs: () => now, sleep },
      cache: new KlineCacheStore(cacheDir),
      acquireLock: (dir) => acquireLiveShadowLock(dir, { pid: 4242, owner: "test", startedAt: "t", isProcessAlive: () => false }),
      nowMs: () => now,
      nowIso: () => new Date(now).toISOString(),
      schedule: (fn) => scheduled.push(fn),
      log: (line) => logs.push(line),
      fetchUniverse: async () => {
        universeControl.calls += 1;
        if (universeControl.gate !== null) await universeControl.gate;
        if (universeControl.fail > 0) {
          universeControl.fail -= 1;
          throw new Error("exchangeInfo unavailable");
        }
        return universe();
      },
      recordMembership: (change) => journal.push(change),
    }
  );
  /** Ticks until no work is in flight (bounded). */
  const settle = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.all(supervisor.tick());
  };
  const live = () => sockets.filter((s) => !s.closed);
  const streamsOf = (url: string) => new URL(url).searchParams.get("streams")!.split("/");
  const send = (symbol: string, at: number, openTimeMs: number, k: { open: number; high: number; low: number; close: number }, closed: boolean) => {
    now = at;
    const name = klineStreamNameOf(symbol, "15m");
    const socket = live().find((s) => streamsOf(s.url).includes(name)) ?? sockets.filter((s) => streamsOf(s.url).includes(name)).pop();
    socket?.handlers.onMessage(JSON.stringify({ stream: name, data: { e: "kline", E: at, s: symbol, k: { t: openTimeMs, T: openTimeMs + M15 - 1, s: symbol, i: "15m", o: String(k.open), c: String(k.close), h: String(k.high), l: String(k.low), x: closed } } }));
    while (scheduled.length > 0) (scheduled.shift() as () => void)();
  };
  const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);
  const sym = (symbol: string) => supervisor.status().symbols.find((s) => s.symbol === symbol);
  return {
    supervisor, rows, data, failing, gates, sockets, rest, logs, journal, universeControl, settle, live, streamsOf, send, sym, root, summary,
    now: () => now,
    setNow: (ms: number) => (now = ms),
    advance: (ms: number) => (now += ms),
    checkpoint: (symbol: string) => read(path.join(dirOf(symbol), "checkpoint.json")),
    events: (symbol: string) => read(path.join(dirOf(symbol), "events.jsonl")) ?? "",
    dirOf,
    klineRequests: (symbol: string) => rest.filter((u) => u.includes("/klines") && new URL(u).searchParams.get("symbol") === symbol).length,
    count: (pattern: RegExp) => logs.filter((l) => pattern.test(l)).length,
  };
}
type Harness = ReturnType<typeof harness>;

const startedHarness = async (initial: string[], opts: { perConnection?: number; maxConnections?: number } = {}): Promise<Harness> => {
  const h = harness(initial, opts);
  await h.supervisor.start();
  return h;
};

describe("start-up of a dynamic universe", () => {
  it("long-listed, later-listed and Unicode symbols all start; a real post-listing gap is QUARANTINED and tracked, never TOO_NEW", async () => {
    const h = await startedHarness(["AAAUSDT", "NEW1USDT", "GAP1USDT", "龙虾USDT"]);
    expect(h.sym("AAAUSDT")).toMatchObject({ status: "ATTACHED", origin: { kind: "PROFILE_CONTEXT" } });
    expect(h.sym("NEW1USDT")).toMatchObject({ status: "ATTACHED", origin: { kind: "SYMBOL_FIRST_CLOSED_BAR", firstClosedBarOpenTimeMs: D(8) } });
    expect(h.sym("龙虾USDT")).toMatchObject({ status: "ATTACHED", stateDir: symbolPathSegment("龙虾USDT") });
    expect(h.sym("GAP1USDT")).toMatchObject({ status: "QUARANTINED", failure: expect.stringMatching(/^INCOMPLETE_DATA/), connection: -1 });
    const sel = h.supervisor.status().selection!;
    expect(sel).toMatchObject({ acceptedEligible: 3, skippedTooNew: 0, skippedInsufficientHistory: 1 });
    expect(h.supervisor.acceptedSymbols().map((s) => s.symbol)).toEqual(["AAAUSDT", "NEW1USDT", "龙虾USDT"]);
    // The exact Unicode symbol is preserved inside its encoded directory, in the checkpoint and the manifest.
    expect(JSON.parse(h.checkpoint("龙虾USDT")!).body.symbol).toBe("龙虾USDT");
    expect(existsSync(path.join(engineNamespaceDir(h.root, h.summary.engineFingerprint), "USDM_PERPETUAL", "龙虾USDT"))).toBe(false);
    const manifest = supervisorRunManifestOf({
      runId: h.supervisor.status().runId as string, startedAt: h.supervisor.startedAt, gitHead: "t", chartInterval: "15m", engineFingerprint: h.supervisor.engineFingerprint,
      profile: h.summary, selection: sel, symbols: h.supervisor.acceptedSymbols(), dynamicMembership: true,
    });
    expect(manifest.body).toMatchObject({ schema: "teddy.native-scanner.supervisor-run-manifest.v2", membership: { mode: "DYNAMIC_JOURNAL", journal: "membership.jsonl" } });
    expect(manifest.body.symbols.find((s) => s.symbol === "NEW1USDT")!.symbolHistoryOrigin).toMatchObject({ kind: "SYMBOL_FIRST_CLOSED_BAR" });
    // Bootstrap replay wrote no evidence at all: nothing to deliver, no historical flood.
    for (const s of ["AAAUSDT", "NEW1USDT", "龙虾USDT"]) expect(h.events(s)).not.toMatch(/LIVE_IMMEDIATE_OBSERVATION/);
    h.supervisor.stop();
  });
});

describe("11-20. periodic refresh, discovery, onboarding", () => {
  it("11. an unchanged universe costs one exchangeInfo call: no kline request, no new socket, no rebuild", async () => {
    const h = await startedHarness(["AAAUSDT", "BBBUSDT"]);
    const restBefore = h.rest.length;
    const socketsBefore = h.sockets.length;
    await h.supervisor.refreshUniverse();
    await Promise.all(h.supervisor.tick());
    expect(h.universeControl.calls).toBe(1);
    expect(h.rest.length).toBe(restBefore);
    expect(h.sockets.length).toBe(socketsBefore);
    expect(h.supervisor.status().totals).toMatchObject({ bootstrapping: 0, awaitingPlacement: 0 });
    expect(h.supervisor.status().universe).toMatchObject({ lastResult: "OK", generation: 1, latest: { added: [], removed: [] } });
    expect(h.supervisor.status().totals).toMatchObject({ connectionRebuilds: 0 });
    h.supervisor.stop();
  });

  it("12-15. a new listing: exactly one worker, one bootstrap, one engine, one placement and one subscription — however many refreshes see it", async () => {
    const h = await startedHarness(["AAAUSDT", "BBBUSDT"]);
    h.rows.set("NEW9USDT", contractRow("NEW9USDT"));
    const gate = deferred();
    h.gates.set("NEW9USDT", gate.promise);
    await h.supervisor.refreshUniverse();
    expect(h.supervisor.status().universe!.latest.added).toEqual(["NEW9USDT"]);
    const pending = h.supervisor.tick(); // bootstrap starts (blocked at the first-bar lookup)
    expect(h.sym("NEW9USDT")!.status).toBe("BOOTSTRAPPING");
    await h.supervisor.refreshUniverse();
    await h.supervisor.refreshUniverse();
    expect(h.supervisor.status().universe!.latest.added).toEqual([]);
    expect(h.supervisor.tick()).toEqual([]); // nothing due: no second bootstrap
    gate.release();
    await Promise.all(pending);
    await h.settle();
    expect(h.supervisor.status().symbols.filter((s) => s.symbol === "NEW9USDT")).toHaveLength(1);
    expect(h.sym("NEW9USDT")).toMatchObject({ status: "ATTACHED", connection: 0 });
    expect(h.count(/NEW9USDT DISCOVERED/)).toBe(1);
    expect(h.count(/NEW9USDT BOOTSTRAPPED/)).toBe(1);
    expect(h.journal.map((j) => [j.kind, j.symbol])).toEqual([["JOINED", "NEW9USDT"]]);
    expect(h.journal[0]).toMatchObject({ lineageId: h.sym("NEW9USDT")!.lineageId, symbolHistoryOrigin: { kind: "SYMBOL_FIRST_CLOSED_BAR" } });
    // One controlled rebuild of connection 0 (room for 3); the new socket carries each symbol exactly once.
    const streams = h.live().flatMap((s) => h.streamsOf(s.url));
    expect(streams.sort()).toEqual(["aaausdt@kline_15m", "bbbusdt@kline_15m", "new9usdt@kline_15m"]);
    expect(h.supervisor.status().totals).toMatchObject({ connectionRebuilds: 1, selected: 3 });
    // Later refreshes: no duplicate engine, subscription or journal record.
    h.advance(300_000);
    await h.settle();
    h.advance(300_000);
    await h.settle();
    expect(h.live().flatMap((s) => h.streamsOf(s.url)).filter((s) => s.startsWith("new9usdt"))).toHaveLength(1);
    expect(h.journal).toHaveLength(1);
    expect(h.supervisor.status().totals.connectionRebuilds).toBe(1);
    h.supervisor.stop();
  });

  it("a full connection is never overfilled: the newcomer opens the next connection, its neighbours untouched", async () => {
    const h = await startedHarness(["AAAUSDT", "BBBUSDT", "CCCUSDT"]);
    h.rows.set("NEW9USDT", contractRow("NEW9USDT"));
    await h.supervisor.refreshUniverse();
    await h.settle();
    expect(h.sym("NEW9USDT")).toMatchObject({ status: "ATTACHED", connection: 1 });
    expect(h.supervisor.status().connections.map((c) => c.assigned)).toEqual([3, 1]);
    expect(h.supervisor.status().totals.connectionRebuilds).toBe(0);
    expect(h.sym("AAAUSDT")!.counters.recoveries).toBe(0);
    h.supervisor.stop();
  });

  it("16. a failed refresh keeps the last-known-good universe: nothing evicted, failure reported, stale after two intervals", async () => {
    const h = await startedHarness(["AAAUSDT", "BBBUSDT"]);
    h.universeControl.fail = 3;
    h.advance(300_000);
    await h.settle();
    expect(h.supervisor.status().universe).toMatchObject({ lastResult: "FAILED", consecutiveFailures: 1, lastError: expect.stringMatching(/exchangeInfo unavailable/) });
    expect(h.supervisor.status().symbols.map((s) => s.status)).toEqual(["ATTACHED", "ATTACHED"]);
    h.advance(300_000);
    await h.settle();
    h.advance(300_000);
    await h.settle();
    expect(h.supervisor.status().universe).toMatchObject({ consecutiveFailures: 3, stale: true });
    h.advance(300_000);
    await h.settle();
    expect(h.supervisor.status().universe).toMatchObject({ lastResult: "OK", consecutiveFailures: 0, stale: false });
    h.supervisor.stop();
  });

  it("17. an empty universe and an implausible mass removal are refused; a plausible removal is applied", async () => {
    const symbols = Array.from({ length: 30 }, (_, i) => `E${String(i).padStart(2, "0")}USDT`);
    const h = await startedHarness(symbols, { perConnection: 10 });
    const saved = new Map(h.rows);
    h.rows.clear();
    await h.supervisor.refreshUniverse();
    expect(h.supervisor.status().universe!.lastResult).toBe("REJECTED_EMPTY");
    for (const s of symbols.slice(0, 4)) h.rows.set(s, saved.get(s)!);
    await h.supervisor.refreshUniverse();
    expect(h.supervisor.status().universe!.lastResult).toBe("REJECTED_MASS_REMOVAL");
    expect(h.supervisor.status().symbols.every((s) => s.status === "ATTACHED")).toBe(true);
    for (const [k, v] of saved) h.rows.set(k, v);
    for (const s of symbols.slice(0, 3)) h.rows.delete(s);
    await h.supervisor.refreshUniverse();
    expect(h.supervisor.status().universe).toMatchObject({ lastResult: "OK", latest: { removed: symbols.slice(0, 3) } });
    expect(h.supervisor.status().totals).toMatchObject({ inactive: 3 });
    h.supervisor.stop();
  }, 60_000);

  it("18. an overlapping refresh is suppressed: one exchangeInfo call, one reconciliation", async () => {
    const h = await startedHarness(["AAAUSDT"]);
    const gate = deferred();
    h.universeControl.gate = gate.promise;
    const first = h.supervisor.refreshUniverse();
    await h.supervisor.refreshUniverse();
    gate.release();
    await first;
    expect(h.universeControl.calls).toBe(1);
    expect(h.supervisor.status().universe).toMatchObject({ refreshesSuppressed: 1, refreshes: 1 });
    h.supervisor.stop();
  });

  it("19. stop during a refresh: the late response changes nothing (no discovery, no activation)", async () => {
    const h = await startedHarness(["AAAUSDT"]);
    h.rows.set("NEW9USDT", contractRow("NEW9USDT"));
    const gate = deferred();
    h.universeControl.gate = gate.promise;
    const refresh = h.supervisor.refreshUniverse();
    h.supervisor.stop();
    gate.release();
    await refresh;
    expect(h.sym("NEW9USDT")).toBeUndefined();
    expect(h.supervisor.tick()).toEqual([]);
    await h.supervisor.refreshUniverse();
    expect(h.universeControl.calls).toBe(1);
  });

  it("20. a bootstrap that finishes after its symbol was removed (stale generation) never lands: no checkpoint, no engine, no placement", async () => {
    const h = await startedHarness(["AAAUSDT"]);
    h.rows.set("NEW9USDT", contractRow("NEW9USDT"));
    await h.supervisor.refreshUniverse();
    const gate = deferred();
    h.gates.set("NEW9USDT", gate.promise);
    const pending = h.supervisor.tick();
    expect(h.sym("NEW9USDT")!.status).toBe("BOOTSTRAPPING");
    h.rows.delete("NEW9USDT");
    await h.supervisor.refreshUniverse();
    expect(h.sym("NEW9USDT")!.status).toBe("INACTIVE");
    gate.release();
    await Promise.all(pending);
    await h.settle();
    expect(h.sym("NEW9USDT")).toMatchObject({ status: "INACTIVE", lineageId: null, connection: -1 });
    expect(h.checkpoint("NEW9USDT")).toBeNull();
    expect(h.journal).toEqual([]);
    expect(h.count(/NEW9USDT BOOTSTRAPPED/)).toBe(0);
    h.supervisor.stop();
  });

  it("a symbol that leaves and returns while its bootstrap is in flight never gets a second concurrent bootstrap", async () => {
    const h = await startedHarness(["AAAUSDT"]);
    h.rows.set("NEW9USDT", contractRow("NEW9USDT"));
    await h.supervisor.refreshUniverse();
    const gate = deferred();
    h.gates.set("NEW9USDT", gate.promise);
    const pending = h.supervisor.tick();
    expect(pending).toHaveLength(1);
    const row = h.rows.get("NEW9USDT")!;
    h.rows.delete("NEW9USDT");
    await h.supervisor.refreshUniverse();
    h.rows.set("NEW9USDT", row);
    await h.supervisor.refreshUniverse();
    expect(h.sym("NEW9USDT")!.status).toBe("PENDING");
    // The first (now stale) attempt still holds the symbol: nothing new starts until it has settled.
    expect(h.supervisor.tick()).toEqual([]);
    gate.release();
    await Promise.all(pending);
    await h.settle();
    expect(h.sym("NEW9USDT")).toMatchObject({ status: "ATTACHED", connection: 0 });
    expect(h.count(/NEW9USDT BOOTSTRAPPED/)).toBe(1);
    expect(h.journal.map((j) => [j.kind, j.symbol])).toEqual([["JOINED", "NEW9USDT"]]);
    h.supervisor.stop();
  });

  it("shutdown during a bootstrap: nothing lands afterwards", async () => {
    const h = await startedHarness(["AAAUSDT"]);
    h.rows.set("NEW9USDT", contractRow("NEW9USDT"));
    await h.supervisor.refreshUniverse();
    const gate = deferred();
    h.gates.set("NEW9USDT", gate.promise);
    const pending = h.supervisor.tick();
    h.supervisor.stop();
    gate.release();
    await Promise.all(pending);
    expect(h.checkpoint("NEW9USDT")).toBeNull();
    expect(h.sym("NEW9USDT")!.status).not.toBe("ATTACHED");
  });

  it("waiting for a first closed bar, and the structural two-bar minimum after the switchover — then the listing joins on its own", async () => {
    const h = await startedHarness(["AAAUSDT"]);
    h.data.set("NEW8USDT", []);
    h.rows.set("NEW8USDT", contractRow("NEW8USDT"));
    await h.supervisor.refreshUniverse();
    await h.settle();
    expect(h.sym("NEW8USDT")).toMatchObject({ status: "WAITING_FIRST_CLOSED_BAR", nextAttemptAt: "2025-01-11T00:00:05.000Z" });
    // Its first bar is 23:45 (after the switchover): the lineage needs that bar and one closed causal bar after it.
    h.data.set("NEW8USDT", FULL.filter((b) => b.openTimeMs >= D(10, 23, 45)));
    h.setNow(D(11, 0, 0, 1));
    await h.settle();
    expect(h.sym("NEW8USDT")).toMatchObject({ status: "WAITING_FIRST_CLOSED_BAR", nextAttemptAt: "2025-01-11T00:00:05.000Z" });
    h.setNow(D(11, 0, 0, 6));
    await h.settle();
    expect(h.sym("NEW8USDT")).toMatchObject({ status: "WAITING_FIRST_CLOSED_BAR", failure: expect.stringMatching(/needs a closed bar after 2025-01-10T23:45/), nextAttemptAt: "2025-01-11T00:15:05.000Z" });
    h.setNow(D(11, 0, 15, 6));
    await h.settle();
    expect(h.sym("NEW8USDT")).toMatchObject({ status: "ATTACHED", origin: { kind: "SYMBOL_FIRST_CLOSED_BAR", firstClosedBarOpenTimeMs: D(10, 23, 45) } });
    expect(h.journal.map((j) => j.kind)).toEqual(["JOINED"]);
    h.supervisor.stop();
  });

  it("an unreadable first-bar lookup is BOOTSTRAP_UNREADABLE and retried with backoff — never guessed, never dropped", async () => {
    const h = await startedHarness(["AAAUSDT"]);
    h.failing.add("NEW7USDT");
    h.rows.set("NEW7USDT", contractRow("NEW7USDT"));
    await h.supervisor.refreshUniverse();
    await h.settle();
    expect(h.sym("NEW7USDT")).toMatchObject({ status: "BOOTSTRAP_UNREADABLE", failure: expect.stringMatching(/first-bar lookup failed/) });
    h.failing.delete("NEW7USDT");
    h.advance(61_000);
    await h.settle();
    expect(h.sym("NEW7USDT")!.status).toBe("ATTACHED");
    h.supervisor.stop();
  });
});

describe("21-27. live activation and the REST/WebSocket handoff", () => {
  it("24-26. a gap between bootstrap and the stream is recovered by REST once; a WS close for a recovered bar is never applied twice", async () => {
    const h = await startedHarness(["AAAUSDT"]);
    h.rows.set("NEW9USDT", contractRow("NEW9USDT"));
    await h.supervisor.refreshUniverse();
    await h.settle();
    const hwm0 = JSON.parse(h.checkpoint("NEW9USDT")!).body.hwmOpenTimeMs;
    expect(hwm0).toBe(D(10, 23, 45));
    // Two bars close before the stream speaks: its first update is for 00:15 (> hwm 23:45).
    h.send("NEW9USDT", D(11, 0, 16), D(11, 0, 15), barAt(D(11, 0, 15)), false);
    expect(h.sym("NEW9USDT")!.status).toBe("RECOVERING");
    await h.settle();
    expect(h.sym("NEW9USDT")).toMatchObject({ status: "ATTACHED", hwm: new Date(D(11, 0, 15)).toISOString() });
    // A late WS close for the recovered 00:00 bar: stale, never applied.
    h.send("NEW9USDT", D(11, 0, 17), D(11, 0, 0), barAt(D(11, 0, 0)), true);
    // Readiness on the current bar (quarantined), its close committed once, a duplicate close ignored.
    h.send("NEW9USDT", D(11, 0, 20), D(11, 0, 15), barAt(D(11, 0, 15)), false);
    h.send("NEW9USDT", D(11, 0, 29, 59), D(11, 0, 15), barAt(D(11, 0, 15)), true);
    h.send("NEW9USDT", D(11, 0, 30, 1), D(11, 0, 15), barAt(D(11, 0, 15)), true);
    const commits = h.events("NEW9USDT").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "BAR_CLOSE_COMMIT");
    expect(commits.map((c) => [c.barOpenTimeMs, c.classification])).toEqual([
      [D(10, 23, 45), "REPLAYED_NON_ACTIONABLE"],
      [D(11, 0, 0), "REPLAYED_NON_ACTIONABLE"],
      [D(11, 0, 15), "QUARANTINED_CURRENT_BAR"],
    ]);
    const body = JSON.parse(h.checkpoint("NEW9USDT")!).body;
    expect(body.hwmOpenTimeMs).toBe(D(11, 0, 30));
    expect(body.causalBarCount).toBe((D(11, 0, 30) - D(10, 12)) / M15);
    h.supervisor.stop();
  });

  it("21/22/27. bootstrap and catch-up write zero observations; the first live bar after readiness is the earliest that can", async () => {
    const h = await startedHarness(["AAAUSDT"]);
    h.rows.set("NEW9USDT", contractRow("NEW9USDT"));
    await h.supervisor.refreshUniverse();
    await h.settle();
    h.send("NEW9USDT", D(10, 23, 59, 30), D(10, 23, 45), barAt(D(10, 23, 45)), false);
    expect(h.sym("NEW9USDT")).toMatchObject({ readiness: "QUARANTINED_CURRENT_BAR", liveEligibleFrom: new Date(D(11)).toISOString() });
    const records = parseShadowEventLog(h.events("NEW9USDT"), { lineageId: h.sym("NEW9USDT")!.lineageId!, marketType: "USDM_PERPETUAL", symbol: "NEW9USDT", chartInterval: "15m" });
    expect(records.filter((r) => r.kind === "LIVE_IMMEDIATE_OBSERVATION")).toEqual([]);
    h.supervisor.stop();
  });
});

describe("28-32. removal and reactivation", () => {
  it("28/29/30. TRADING -> SETTLING: removed from scanning, checkpoint and evidence byte-identical, late WS messages ignored", async () => {
    const h = await startedHarness(["AAAUSDT", "BBBUSDT"]);
    const checkpoint = h.checkpoint("BBBUSDT");
    const events = h.events("BBBUSDT");
    h.rows.set("BBBUSDT", contractRow("BBBUSDT", { status: "SETTLING" }));
    await h.supervisor.refreshUniverse();
    expect(h.sym("BBBUSDT")).toMatchObject({ status: "INACTIVE", connection: -1, inactiveSince: expect.any(String) });
    expect(h.supervisor.status().connections[0].assigned).toBe(1);
    expect(h.journal.map((j) => [j.kind, j.symbol])).toEqual([["INACTIVE", "BBBUSDT"]]);
    h.send("BBBUSDT", D(11, 0, 1), D(11), barAt(D(11)), true);
    expect(h.sym("BBBUSDT")!.counters.ignoredWhileInactive).toBe(1);
    expect(h.checkpoint("BBBUSDT")).toBe(checkpoint);
    expect(h.events("BBBUSDT")).toBe(events);
    expect(existsSync(h.dirOf("BBBUSDT"))).toBe(true);
    h.supervisor.stop();
  });

  it("31. return with the same identity: the SAME worker and lineage catch up closed bars and rejoin once (REACTIVATED)", async () => {
    const h = await startedHarness(["AAAUSDT", "BBBUSDT"]);
    const lineage = h.sym("BBBUSDT")!.lineageId;
    const original = h.rows.get("BBBUSDT")!;
    h.rows.delete("BBBUSDT");
    await h.supervisor.refreshUniverse();
    h.rows.set("BBBUSDT", original);
    h.setNow(D(11, 0, 31));
    await h.supervisor.refreshUniverse();
    expect(h.supervisor.status().universe!.latest.reactivated).toEqual(["BBBUSDT"]);
    await h.settle();
    expect(h.supervisor.status().symbols.filter((s) => s.symbol === "BBBUSDT")).toHaveLength(1);
    expect(h.sym("BBBUSDT")).toMatchObject({ status: "ATTACHED", lineageId: lineage, hwm: new Date(D(11, 0, 30)).toISOString() });
    expect(h.journal.map((j) => j.kind)).toEqual(["INACTIVE", "REACTIVATED"]);
    // The connection was waiting out a reconnect backoff (its readiness timed out meanwhile): the reconnect carries BBB once.
    h.advance(6_000);
    await h.settle();
    expect(h.live().flatMap((s) => h.streamsOf(s.url)).filter((s) => s.startsWith("bbbusdt"))).toHaveLength(1);
    h.supervisor.stop();
  });

  it("a returning symbol whose bars do not continue (a real halt gap) is QUARANTINED, never bridged", async () => {
    const h = await startedHarness(["AAAUSDT", "BBBUSDT"]);
    const original = h.rows.get("BBBUSDT")!;
    h.rows.delete("BBBUSDT");
    await h.supervisor.refreshUniverse();
    h.data.set("BBBUSDT", FULL.filter((b) => b.openTimeMs !== D(11, 0, 0)));
    h.rows.set("BBBUSDT", original);
    h.setNow(D(11, 0, 31));
    await h.supervisor.refreshUniverse();
    await h.settle();
    expect(h.sym("BBBUSDT")).toMatchObject({ status: "QUARANTINED", failure: expect.stringMatching(/^HISTORY_GAP_ACROSS_INACTIVITY/) });
    h.supervisor.stop();
  });

  it("32. a changed contract identity under the same symbol is QUARANTINED (fail closed), live or returning", async () => {
    const h = await startedHarness(["AAAUSDT", "BBBUSDT"]);
    h.rows.set("BBBUSDT", contractRow("BBBUSDT", { onboardDate: D(9) }));
    await h.supervisor.refreshUniverse();
    expect(h.sym("BBBUSDT")).toMatchObject({ status: "QUARANTINED", failure: expect.stringMatching(/^IDENTITY_CONFLICT/), connection: -1, nextAttemptAt: null });
    expect(h.supervisor.status().universe!.latest.identityConflicts).toEqual(["BBBUSDT"]);
    h.supervisor.stop();
  });
});

describe("40-42. capacity: never silently truncated", () => {
  const candidates = (n: number): SupervisorCandidate[] => Array.from({ length: n }, (_, i) => ({ symbol: `S${String(i).padStart(4, "0")}USDT`, onboardDateMs: null, required: false }));

  it("40/41. 800 fit 16 x 50; 801 are refused", () => {
    expect(assignConnections(candidates(800).map((c) => c.symbol), 50, 16)).toHaveLength(16);
    expect(() => assignConnections(candidates(801).map((c) => c.symbol), 50, 16)).toThrow(/801 symbols need 17 connections/);
  });

  it("41. a dynamic start-up universe larger than the ceiling is refused before any request", () => {
    let requests = 0;
    const transport: PublicHttpTransport = async () => {
      requests += 1;
      throw new Error("no request expected");
    };
    const governor = new GovernedPublicTransport(transport, { maxTotalRequests: 10, minSpacingMs: 250, nowMs: () => 0, sleep: async () => undefined });
    const make = (n: number) =>
      new LiveShadowSupervisor(
        {
          lineage: LINEAGE, selection: { mode: "ALL_ACTIVE", candidates: candidates(n) }, symbolsPerConnection: 50, maxConnections: 16, restConcurrency: 2, queueCapacity: 1_000,
          maxProcessingLagMs: 30_000, staleSymbolMs: 1_800_000, maxRecoveryAttempts: 3, liveDirFor: (s) => s, dynamicUniverse: { refreshIntervalMs: 300_000 },
        },
        {
          openStream: () => ({ close: () => undefined }), governor, fetchDeps: { transport, baseUrl: "https://fapi.binance.com", policy: { maxRequests: 10, minSpacingMs: 250, maxTransientRetries: 0, transientBackoffMs: 250 }, nowMs: () => 0, sleep: async () => undefined },
          cache: { load: () => null, save: () => undefined }, acquireLock: () => ({ release: () => undefined }) as never, nowMs: () => 0, nowIso: () => "t", schedule: () => undefined, log: () => undefined,
          fetchUniverse: async () => { throw new Error("unused"); },
        }
      );
    expect(() => make(800)).not.toThrow();
    expect(() => make(801)).toThrow(SupervisorConfigError);
    expect(requests).toBe(0);
  });

  it("42. a running universe that outgrows the ceiling admits nobody new and says CAPACITY_EXCEEDED / ALL ACTIVE not satisfied", async () => {
    const h = await startedHarness(["AAAUSDT", "BBBUSDT"], { perConnection: 1, maxConnections: 3 });
    h.rows.set("NEW1USDT", contractRow("NEW1USDT"));
    h.rows.set("NEW2USDT", contractRow("NEW2USDT"));
    await h.supervisor.refreshUniverse();
    await h.settle();
    expect(h.supervisor.status().universe!.capacity).toEqual({ symbolsPerConnection: 1, maxConnections: 3, available: 3, required: 4, exceeded: true, allActiveSatisfied: false });
    expect(h.supervisor.status().universe!.latest.notAdmitted).toEqual(["NEW1USDT", "NEW2USDT"]);
    expect(h.sym("NEW1USDT")).toBeUndefined();
    expect(h.count(/CAPACITY_EXCEEDED/)).toBe(1);
    // Once it fits again, the next refresh admits.
    h.rows.delete("NEW2USDT");
    await h.supervisor.refreshUniverse();
    await h.settle();
    expect(h.sym("NEW1USDT")!.status).toBe("ATTACHED");
    expect(h.supervisor.status().universe!.capacity).toMatchObject({ required: 3, exceeded: false, allActiveSatisfied: true });
    h.supervisor.stop();
  });
});

describe("the dynamic universe's configuration is fail-closed", () => {
  it("needs a symbol origin, ALL_ACTIVE, a universe source and a sane interval", () => {
    const base = harness(["AAAUSDT"]);
    base.supervisor.stop();
    const cfg = (base.supervisor as unknown as { config: ConstructorParameters<typeof LiveShadowSupervisor>[0] }).config;
    const deps = (base.supervisor as unknown as { deps: ConstructorParameters<typeof LiveShadowSupervisor>[1] }).deps;
    expect(() => new LiveShadowSupervisor({ ...cfg, lineage: { ...cfg.lineage, historyOrigin: undefined } }, deps)).toThrow(/symbol history origin/);
    expect(() => new LiveShadowSupervisor({ ...cfg, dynamicUniverse: { refreshIntervalMs: 1_000 } }, deps)).toThrow(/refresh interval/);
    expect(() => new LiveShadowSupervisor(cfg, { ...deps, fetchUniverse: undefined })).toThrow(/fetchUniverse/);
    expect(() => new LiveShadowSupervisor({ ...cfg, selection: { mode: "EXPLICIT", candidates: cfg.selection!.candidates } }, deps)).toThrow(/ALL_ACTIVE/);
    expect(() => parseSupervisorCliArgs(["--profile", "teddy-7-all-active", "--all-active"])).toThrow(SupervisorCliUsageError);
  });
});

// ===========================================================================
// Membership journal and the emitter's dynamic lanes
// ===========================================================================

const RUN_ID = makeRunId(Date.UTC(2026, 9, 5, 1, 0), "0d1e2f3a");
const BOOT = "e".repeat(64);
const PROFILE_ORIGIN: SymbolHistoryOrigin = {
  semantics: HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1, kind: "PROFILE_CONTEXT" as const, firstClosedBarOpenTimeMs: null,
  effectiveContextStartMs: iso("2025-12-29T00:00:00Z"), effectiveHistoryStartMs: iso("2026-01-01T00:00:00Z"), effectiveSwitchoverMs: iso("2026-09-12T01:00:00Z"),
};
const LISTING_ORIGIN: SymbolHistoryOrigin = {
  semantics: HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1, kind: "SYMBOL_FIRST_CLOSED_BAR" as const, firstClosedBarOpenTimeMs: iso("2026-10-01T10:00:00Z"),
  effectiveContextStartMs: iso("2026-10-01T10:00:00Z"), effectiveHistoryStartMs: iso("2026-10-01T10:00:00Z"), effectiveSwitchoverMs: iso("2026-10-01T10:15:00Z"),
};
const lineageOf = (symbol: string, origin = PROFILE_ORIGIN) => profileLineageIdFor(N, symbol, BOOT, origin);
const change = (kind: MembershipChange["kind"], symbol: string, origin = LISTING_ORIGIN, lineageId: string | null = lineageOf(symbol, origin)): MembershipChange => ({
  kind, symbol, lineageId, bootstrapInputSha256: kind === "JOINED" || kind === "REACTIVATED" ? BOOT : null, symbolHistoryOrigin: origin, reason: null, at: "2026-10-05T01:05:00.000Z",
});
function journalOf(changes: MembershipChange[]): string {
  let previous: string | null = null;
  let text = "";
  changes.forEach((c, i) => {
    const line = membershipLine(RUN_ID, i + 1, previous, c);
    text += line;
    previous = line.slice(0, -1);
  });
  return text;
}

describe("the run membership journal", () => {
  it("is canonical, contiguous and hash-chained; a partial last line waits; tampering, reordering or another run is refused", () => {
    const text = journalOf([change("JOINED", "龙虾USDT"), change("INACTIVE", "龙虾USDT"), change("REACTIVATED", "龙虾USDT")]);
    expect(parseMembershipJournal(text, RUN_ID).records.map((r) => [r.seq, r.kind, r.symbol])).toEqual([[1, "JOINED", "龙虾USDT"], [2, "INACTIVE", "龙虾USDT"], [3, "REACTIVATED", "龙虾USDT"]]);
    expect(parseMembershipJournal(`${text}{"partial`, RUN_ID).records).toHaveLength(3);
    const lines = text.split("\n");
    expect(() => parseMembershipJournal([lines[1], lines[0], lines[2], ""].join("\n"), RUN_ID)).toThrow(RunMembershipError);
    expect(() => parseMembershipJournal(text.replace("2026-10-05T01:05:00.000Z", "2026-10-05T01:06:00.000Z"), RUN_ID)).toThrow(RunMembershipError);
    expect(() => parseMembershipJournal(text, makeRunId(Date.UTC(2026, 9, 5, 2, 0), "0d1e2f3a"))).toThrow(RunMembershipError);
    expect(() => membershipLine(RUN_ID, 1, null, change("JOINED", "龙虾USDT", LISTING_ORIGIN, null))).toThrow(/lineage/);
    expect(parseMembershipJournal(null, RUN_ID).records).toEqual([]);
  });
});

describe("23. the emitter binds dynamically joined symbols and activates them at the live frontier", () => {
  const manifest = buildRunManifest({
    schema: "teddy.native-scanner.supervisor-run-manifest.v2",
    runId: RUN_ID, startedAt: "2026-10-05T01:00:00.000Z", gitHead: "t", marketType: "USDM_PERPETUAL", chartInterval: "15m",
    engineFingerprint: engineFingerprintOf(N), profile: profileSummaryOf(N), stateLayout: "ENGINE_NAMESPACE",
    selection: { mode: "ALL_ACTIVE", universeActive: 2, targetEligible: null, candidatesTested: 2, acceptedEligible: 1, skippedTooNew: 0, skippedInsufficientHistory: 0, skippedOther: 1, universeExhausted: true },
    symbols: [{ symbol: "AAAUSDT", lineageId: lineageOf("AAAUSDT"), bootstrapInputSha256: BOOT, symbolHistoryOrigin: PROFILE_ORIGIN }],
    actionable: false,
    membership: { mode: "DYNAMIC_JOURNAL", journal: "membership.jsonl", journalSchema: "teddy.native-scanner.run-membership.v1" },
  });
  const checkpointOf = (symbol: string) => ({ lineageId: symbol === "AAAUSDT" ? lineageOf(symbol) : lineageOf(symbol, LISTING_ORIGIN), symbol, chartInterval: "15m", marketType: "USDM_PERPETUAL" });
  const BAR = Date.UTC(2026, 9, 5, 2, 0);
  const obs = (symbol: string, n: number) =>
    observation({ symbol, lineageId: symbol === "AAAUSDT" ? lineageOf(symbol) : lineageOf(symbol, LISTING_ORIGIN), barMs: BAR + n * M15, sourceTf: "1D", createdBarOpenTimeMs: BAR - 96 * M15 - n * 96 * M15, levelPrice: 1 + n });

  function setup() {
    const logs: Record<string, string> = { AAAUSDT: "" };
    let journal = "";
    const events: MultiEmitterEvent[] = [];
    const cursors = new Map<string, EmitterCursor>();
    const run = bindPinnedRun({ manifest, expect: { profileId: N.profileId, runId: RUN_ID, engineFingerprint: engineFingerprintOf(N) }, checkpointOf });
    const emitter = new MultiSymbolNativeEmitter({
      mode: "DRY_RUN", run, readLog: (s) => logs[s] ?? null, cursors: { load: (s) => cursors.get(s) ?? null }, cursorWriter: null, ledger: null, baseline: "PRODUCTION_CURSOR", activateAtEof: false,
      queueCapacity: 1_000, pendingTailPolls: 0, nowIso: () => "2026-10-05T02:00:00.000Z", report: (e) => events.push(e), readMembership: () => journal, checkpointOf,
    });
    return { emitter, events, logs, setJournal: (t: string) => (journal = t), run };
  }

  it("a JOINED Unicode listing gets one lane: earlier records are never delivered, the next live observation is", async () => {
    const s = setup();
    expect(s.run.dynamicMembership).toBe(true);
    await s.emitter.initialize();
    s.logs["龙虾USDT"] = logOf([obs("龙虾USDT", 0)]);
    s.setJournal(journalOf([change("JOINED", "龙虾USDT")]));
    await s.emitter.poll();
    expect(s.events.filter((e) => e.type === "LANE_JOINED")).toEqual([{ type: "LANE_JOINED", symbol: "龙虾USDT", seq: 1, lineageId: lineageOf("龙虾USDT", LISTING_ORIGIN) }]);
    expect(s.events.filter((e) => e.type === "DECISION")).toHaveLength(0);
    s.logs["龙虾USDT"] += logOf([obs("龙虾USDT", 1)]);
    await s.emitter.poll();
    await s.emitter.poll();
    const decisions = s.events.filter((e) => e.type === "DECISION");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ symbol: "龙虾USDT", result: "WOULD_CREATE" });
    expect(s.emitter.status()).toMatchObject({ symbolsTracked: 2, membership: { dynamic: true, recordsAbsorbed: 1, failure: null }, skipCounts: { historicalBeforeActivationCutover: 1 } });
  });

  it("a JOINED record whose lineage the profile does not rebuild fails that lane alone; a tampered journal stops new bindings only", async () => {
    const s = setup();
    await s.emitter.initialize();
    s.setJournal(journalOf([change("JOINED", "BADUSDT", LISTING_ORIGIN, "9".repeat(64))]));
    await s.emitter.poll();
    expect(s.events.find((e) => e.type === "LANE_FAILED")).toMatchObject({ symbol: "BADUSDT", code: "BINDING" });
    s.setJournal(journalOf([change("JOINED", "BADUSDT", LISTING_ORIGIN, "9".repeat(64)), change("JOINED", "龙虾USDT")]).replace('"seq":2', '"seq":3'));
    await s.emitter.poll();
    expect(s.events.find((e) => e.type === "MEMBERSHIP_INVALID")).toBeDefined();
    expect(s.emitter.status().symbolsTracked).toBe(2);
    s.logs.AAAUSDT = logOf([obs("AAAUSDT", 2)]);
    await s.emitter.poll();
    expect(s.events.filter((e) => e.type === "DECISION").map((e) => (e as { symbol: string }).symbol)).toEqual(["AAAUSDT"]);
  });

  it("a static (v1 / membership null) run never reads a journal", async () => {
    const staticManifest = buildRunManifest({ ...manifest.body, membership: null });
    const run = bindPinnedRun({ manifest: staticManifest, expect: { profileId: N.profileId, runId: RUN_ID, engineFingerprint: engineFingerprintOf(N) }, checkpointOf });
    expect(run.dynamicMembership).toBe(false);
  });
});
