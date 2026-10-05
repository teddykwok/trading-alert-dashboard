import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createNativeEngineConfig, type NativeKline } from "@trading-alert-dashboard/shared";

import { parseMultiEmitterCliArgs } from "../src/modules/native-alerts/multi-emitter-cli-args";
import { RunBindingError, bindPinnedRun } from "../src/modules/native-alerts/multi-symbol-emitter";
import { buildNativeAlertDraftV2 } from "../src/modules/native-alerts/native-alert-draft";
import { ineligibilityOfV2, selectNativeDeliveriesV2 } from "../src/modules/native-alerts/native-delivery-policy-v2";
import { parseShadowEventLog } from "../src/modules/native-alerts/shadow-log-reader";
import { GovernedPublicTransport } from "../src/modules/native-scanner/candidate-rank-runner";
import { KlineCacheStore } from "../src/modules/native-scanner/kline-cache";
import { REQUEST_POLICY_LIMITS, type PublicHttpResponse, type PublicHttpTransport } from "../src/modules/native-scanner/kline-fetcher";
import { parseLineageConfig } from "../src/modules/native-scanner/live-shadow-cli-args";
import { SUPERVISOR_DEFAULTS, SupervisorCliUsageError, parseSupervisorCliArgs } from "../src/modules/native-scanner/live-shadow-supervisor-cli-args";
import {
  LiveShadowSupervisor,
  SUPERVISOR_LIMITS,
  SupervisorConfigError,
  assignConnections,
  liveShadowDir,
  type SupervisorSelection,
} from "../src/modules/native-scanner/live-shadow-supervisor";
import { acquireLiveShadowLock } from "../src/modules/native-scanner/scanner-lock";
import {
  SCANNER_PROFILES,
  ScannerProfileError,
  TEDDY_7_ALL_ACTIVE_V1,
  TEDDY_AGGRESSIVE_V1,
  assertScannerProfile,
  dashboardTimeframes,
  deliveryPolicyFingerprintOf,
  engineFingerprintOf,
  engineFingerprintOfConfig,
  engineNamespaceDir,
  engineTimeframes,
  executionPolicyFingerprintOf,
  futureExecutionTimeframes,
  isAllActiveUniverse,
  lineageConfigOf,
  profileById,
  profileLineageIdFor,
  profileSummaryOf,
  resolveScannerProfile,
  type ScannerProfile,
} from "../src/modules/native-scanner/scanner-profile";
import { RunManifestError, buildRunManifest, makeRunId, parseRunManifest, runManifestText, type SupervisorRunManifest } from "../src/modules/native-scanner/supervisor-run-manifest";
import { connectionCapacityOf, supervisorLiveDirFor, supervisorRunManifestOf, supervisorSelectionOf } from "../src/modules/native-scanner/supervisor-run-plan";
import { parseExchangeInfoContracts, selectUsdtPerpetualUniverse } from "../src/modules/native-scanner/usdm-universe";
import { bar, logOf, observation } from "./helpers/native-alert-fixtures";
import { doji, repeat, type Ohlc } from "./helpers/native-signal-fixtures";
import { fifteenMinute } from "./helpers/native-scanner-fakes";

/**
 * TEDDY 7% ALL ACTIVE: a second, independent profile. Only the minimum move
 * (7% instead of 18%) and the universe (EVERY scanner-eligible active USDT
 * perpetual, with a connection ceiling that fits them) differ from Teddy
 * Aggressive. Fake public REST and WebSocket, manual clock, generated
 * exchangeInfo, temporary directories only — no network, no database.
 */

const N = TEDDY_7_ALL_ACTIVE_V1;
const T = TEDDY_AGGRESSIVE_V1;
const TEDDY_18_FINGERPRINT = "3e21f1c15207b03b91315767a4b54c92b0e6a21da33149c02c4ec0ee7c903998";
const FLAGS_7: Record<string, string> = {
  "--interval": "15m", "--history-start": "2026-01-01T00:00:00Z", "--switchover": "2026-09-12T01:00:00Z", "--min-move-percent": "7",
  "--touch-tolerance-percent": "1", "--cooldown-bars": "10", "--min-bars-after-creation": "5", "--min-bars-after-arming": "4",
  "--source-timeframes": "1D,1W,1M,3M,6M,12M", "--max-levels": "500", "--timing": "Immediate", "--partial-period-policy": "SWITCHOVER_TRUNCATED_CLOSED_BARS",
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  dirs.push(d);
  return d;
};

// ===========================================================================
// Identity
// ===========================================================================

describe("profile identity: Teddy 7% All Active", () => {
  it("resolves by its own CLI name and id, with exactly the requested engine settings", () => {
    expect(resolveScannerProfile("teddy-7-all-active")).toBe(N);
    expect(profileById("TEDDY_7_ALL_ACTIVE_V1")).toBe(N);
    expect([N.profileId, N.cliName, N.label]).toEqual(["TEDDY_7_ALL_ACTIVE_V1", "teddy-7-all-active", "Teddy 7% All Active"]);
    expect(N.engine).toMatchObject({
      chartInterval: "15m", minMovePercent: 7, touchTolerancePercent: 1, cooldownBars: 10, minBarsAfterCreation: 5, minBarsAfterArming: 4, maxLevels: 500,
      timing: "Immediate", partialPeriodPolicy: "SWITCHOVER_TRUNCATED_CLOSED_BARS",
    });
    const config = lineageConfigOf(N.engine);
    expect(config.historyStartMs).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(config.switchoverMs).toBe(Date.parse("2026-09-12T01:00:00.000Z"));
    expect(config.engine).toEqual(
      createNativeEngineConfig({
        minMovePct: 0.07, touchTolerancePct: 0.01, touchCooldownBars: 10, minBarsAfterCreation: 5, minBarsAfterArming: 4, maxLevels: 500,
        enabledSourceTfs: ["1D", "1W", "1M", "3M", "6M", "12M"], timing: "Immediate", lifecycle: "TEDDY_DYNAMIC_SOURCE_LEVEL_V1",
      })
    );
    // The equivalent explicit flags PLUS the dynamic source-level lifecycle: the four 7% formulas and
    // every input are unchanged; only how a level lives (one dynamic candidate per period) differs.
    const explicit = parseLineageConfig((name) => FLAGS_7[name]);
    // Dynamic universe: each symbol's history starts at its own first real closed bar when later than the context.
    expect(N.engine.historyOrigin).toBe("SYMBOL_FIRST_CLOSED_BAR_V1");
    expect(config).toEqual({
      ...explicit,
      engine: createNativeEngineConfig({ ...explicit.engine, lifecycle: "TEDDY_DYNAMIC_SOURCE_LEVEL_V1" }),
      historyOrigin: "SYMBOL_FIRST_CLOSED_BAR_V1",
    });
  });

  it("timeframes: engine 1D..12M, dashboard 1D/1W/1M (NATIVE_DELIVERY_V2), future execution 1D/1W, never enabled", () => {
    expect([...N.engine.engineSourceTimeframes]).toEqual(["1D", "1W", "1M", "3M", "6M", "12M"]);
    expect([...N.delivery.dashboardSourceTimeframes]).toEqual(["1D", "1W", "1M"]);
    expect(N.delivery.policyVersion).toBe("NATIVE_DELIVERY_V2");
    expect(N.delivery.actionable).toBe(false);
    expect([...N.execution.futureExecutionSourceTimeframes]).toEqual(["1D", "1W"]);
    expect(N.execution.nativeExecutionEnabled).toBe(false);
    expect(profileSummaryOf(N).execution).toMatchObject({ nativeExecutionEnabled: false, notice: expect.stringMatching(/NOT enabled/) });
  });

  it("the universe is a DYNAMIC ALL_ACTIVE with no count, and the profile owns a connection ceiling and refresh interval that fit it", () => {
    expect(N.universe).toEqual({
      layer: "UNIVERSE", universe: "usdt-perpetual", selection: "ALL_ACTIVE", targetEligible: null, lifecycle: "DYNAMIC_UNIVERSE_V1", symbolTrust: "EXCHANGE_INFO_UNICODE_V1",
    });
    expect(isAllActiveUniverse(N.universe)).toBe(true);
    expect(isAllActiveUniverse(T.universe)).toBe(false);
    expect(N.operations).toEqual({ maxConnections: 16, universeRefreshMs: 300_000 });
    expect(profileSummaryOf(N).universe).toEqual({ universe: "usdt-perpetual", selection: "ALL_ACTIVE", targetEligible: null, lifecycle: "DYNAMIC_UNIVERSE_V1", symbolTrust: "EXCHANGE_INFO_UNICODE_V1" });
  });

  it("an all-active profile can carry no count and must state its connection ceiling; a bad ceiling is refused", () => {
    const bad = (patch: Partial<ScannerProfile>) => () => assertScannerProfile({ ...N, ...patch } as ScannerProfile);
    expect(bad({ universe: { ...N.universe, targetEligible: 50 } as never })).toThrow(/no target count/);
    expect(bad({ operations: undefined })).toThrow(/connection ceiling/);
    expect(bad({ operations: { maxConnections: 0 } })).toThrow(/maxConnections/);
    expect(bad({ operations: { maxConnections: SUPERVISOR_LIMITS.maxConnections + 1 } })).toThrow(/maxConnections/);
    expect(bad({ universe: { layer: "UNIVERSE", universe: "usdt-perpetual", selection: "FIRST_N", targetEligible: 5 } as never })).toThrow(/unknown universe selection/);
    expect(bad({ execution: { ...N.execution, nativeExecutionEnabled: true as never } })).toThrow(/never enable native execution/);
    expect(bad({ delivery: { ...N.delivery, dashboardSourceTimeframes: dashboardTimeframes("1D", "1W", "1M", "3M", "6M", "12M"), actionable: true as never } })).toThrow(ScannerProfileError);
  });

  it("both profiles stay registered and independently selectable; neither aliases the other", () => {
    expect(Object.keys(SCANNER_PROFILES).sort()).toEqual(["teddy-7-all-active", "teddy-aggressive"]);
    expect(resolveScannerProfile("teddy-aggressive")).toBe(T);
    expect(N).not.toBe(T);
    expect(N.engine).not.toBe(T.engine);
    expect(Object.isFrozen(N) && Object.isFrozen(N.engine) && Object.isFrozen(N.universe) && Object.isFrozen(N.operations)).toBe(true);
  });
});

describe("Teddy Aggressive is unchanged", () => {
  it("same id, label, engine, fingerprint, 50-eligible target, generic connection defaults", () => {
    expect([T.profileId, T.cliName, T.label]).toEqual(["TEDDY_AGGRESSIVE_V1", "teddy-aggressive", "Teddy Aggressive"]);
    expect(T.engine).toMatchObject({ minMovePercent: 18, touchTolerancePercent: 1, cooldownBars: 10, minBarsAfterCreation: 5, minBarsAfterArming: 4, maxLevels: 500 });
    expect(engineFingerprintOf(T)).toBe(TEDDY_18_FINGERPRINT);
    expect(T.universe).toEqual({ layer: "UNIVERSE", universe: "usdt-perpetual", targetEligible: 50 });
    expect(Object.keys(T)).not.toContain("operations");
    expect(profileSummaryOf(T).universe).toEqual({ universe: "usdt-perpetual", targetEligible: 50 });
    const options = parseSupervisorCliArgs(["--profile", "teddy-aggressive"]);
    expect(options.selection).toEqual({ mode: "UNIVERSE", include: [], exclude: [], maxSymbols: 50 });
    expect([options.symbolsPerConnection, options.maxConnections]).toEqual([SUPERVISOR_DEFAULTS.symbolsPerConnection, SUPERVISOR_DEFAULTS.maxConnections]);
    expect(SUPERVISOR_DEFAULTS.maxConnections).toBe(4);
  });
});

// ===========================================================================
// Fingerprints and state namespace
// ===========================================================================

describe("fingerprints and state namespace", () => {
  const engine7 = engineFingerprintOf(N);

  it("the engine fingerprint is derived canonically: the explicit 7% flags with the dynamic lifecycle and the symbol history origin — not an older 7% engine", () => {
    expect(engine7).toMatch(/^[0-9a-f]{64}$/);
    const explicit = parseLineageConfig((name) => FLAGS_7[name]);
    const dynamicConfig = { ...explicit, engine: createNativeEngineConfig({ ...explicit.engine, lifecycle: "TEDDY_DYNAMIC_SOURCE_LEVEL_V1" }) };
    expect(engine7).toBe(engineFingerprintOfConfig({ ...dynamicConfig, historyOrigin: "SYMBOL_FIRST_CLOSED_BAR_V1" }));
    // Without the symbol history origin it is the first dynamic 7% engine, historical and never reused.
    expect(engineFingerprintOfConfig(dynamicConfig)).toBe("5cd970a602d283f8c019ff07701283a2b290e382563d316769f4efcbf035a041");
    expect(engine7).not.toBe("5cd970a602d283f8c019ff07701283a2b290e382563d316769f4efcbf035a041");
    // The legacy 7% engine (explicit flags; Teddy Aggressive with only the min move changed) is the OLD fingerprint.
    const legacy7 = "47d661a531c9d724d0bfbcb85ff68ea7dd85418464f959be2d0cb1340f4c5179";
    expect(engineFingerprintOfConfig(explicit)).toBe(legacy7);
    expect(engineFingerprintOf({ ...T, engine: { ...T.engine, minMovePercent: 7 } } as ScannerProfile)).toBe(legacy7);
    expect(engine7).not.toBe(legacy7);
    expect(engine7).not.toBe(TEDDY_18_FINGERPRINT);
    // The universe, its ceiling and the label are in no fingerprint.
    expect(engineFingerprintOf({ ...N, universe: T.universe, operations: undefined, label: "x" } as ScannerProfile)).toBe(engine7);
  });

  it("delivery and future-execution policies are Teddy Aggressive's exactly, so their fingerprints are equal", () => {
    expect(deliveryPolicyFingerprintOf(N.delivery)).toBe(deliveryPolicyFingerprintOf(T.delivery));
    expect(executionPolicyFingerprintOf(N.execution)).toBe(executionPolicyFingerprintOf(T.execution));
  });

  it("per-symbol lineages differ from Teddy Aggressive's: no checkpoint can be shared; the 7% engine needs each symbol's origin", () => {
    const origin = { kind: "PROFILE_CONTEXT" as const, firstClosedBarOpenTimeMs: null };
    expect(profileLineageIdFor(N, "BTCUSDT", "c".repeat(64), origin)).not.toBe(profileLineageIdFor(T, "BTCUSDT", "c".repeat(64)));
    expect(() => profileLineageIdFor(N, "BTCUSDT", "c".repeat(64))).toThrow(/history origin/);
    expect(() => profileLineageIdFor(T, "BTCUSDT", "c".repeat(64), origin)).toThrow(/no symbol history origin/);
  });

  it("state lives in the 7% engine namespace — never Teddy Aggressive's, never the legacy live-shadow tree", () => {
    const root = path.join(tmpdir(), "never-created-scanner-root");
    const dirOf = supervisorLiveDirFor(root, profileSummaryOf(N), "15m");
    expect(dirOf("BTCUSDT")).toBe(path.join(root, "live-shadow-engines", engine7.slice(0, 24), "USDM_PERPETUAL", "BTCUSDT", "15m"));
    expect(dirOf("BTCUSDT").startsWith(engineNamespaceDir(root, engine7))).toBe(true);
    expect(dirOf("BTCUSDT").startsWith(engineNamespaceDir(root, TEDDY_18_FINGERPRINT))).toBe(false);
    expect(dirOf("BTCUSDT")).not.toBe(liveShadowDir(root, "BTCUSDT", "15m"));
    // Only a legacy explicit-flag run uses the legacy tree.
    expect(supervisorLiveDirFor(root, null, "15m")("BTCUSDT")).toBe(liveShadowDir(root, "BTCUSDT", "15m"));
  });
});

// ===========================================================================
// Supervisor CLI
// ===========================================================================

describe("supervisor CLI: --profile teddy-7-all-active", () => {
  it("alone: the 7% engine, every eligible symbol (no --max-symbols), the profile's connection ceiling", () => {
    const options = parseSupervisorCliArgs(["--profile", "teddy-7-all-active", "--duration-minutes", "30", "--status-every-s", "10"]);
    expect(options.profile).toBe(N);
    expect(options.lineage).toEqual(lineageConfigOf(N.engine));
    expect(options.selection).toEqual({ mode: "UNIVERSE", include: [], exclude: [], maxSymbols: null });
    expect([options.symbolsPerConnection, options.maxConnections, options.durationMinutes, options.statusEverySeconds]).toEqual([50, 16, 30, 10]);
  });

  it("refuses every semantic flag the profile owns — lineage, --universe, --max-symbols, --all-active, include/exclude", () => {
    for (const [flag, value] of [...Object.entries(FLAGS_7), ["--universe", "usdt-perpetual"], ["--max-symbols", "50"], ["--max-symbols", "600"], ["--include-symbols", "BTCUSDT"], ["--exclude-symbols", "BTCUSDT"]]) {
      expect(() => parseSupervisorCliArgs(["--profile", "teddy-7-all-active", flag, value])).toThrow(SupervisorCliUsageError);
    }
    expect(() => parseSupervisorCliArgs(["--profile", "teddy-7-all-active", "--all-active"])).toThrow(/conflicting/);
    expect(() => parseSupervisorCliArgs(["--profile", "teddy-7-all-active", "--account", "A"])).toThrow(/unexpected argument/);
  });

  it("operational flags stay operational: they are accepted and override the profile's defaults", () => {
    const options = parseSupervisorCliArgs([
      "--profile", "teddy-7-all-active", "--symbols-per-connection", "40", "--max-connections", "20", "--rest-concurrency", "3", "--queue-capacity", "30000",
      "--max-lag-ms", "20000", "--stale-symbol-ms", "900000", "--max-total-requests", "6000",
    ]);
    expect([options.symbolsPerConnection, options.maxConnections, options.restConcurrency, options.queueCapacity, options.maxProcessingLagMs, options.staleSymbolMs, options.maxTotalRequests]).toEqual([
      40, 20, 3, 30_000, 20_000, 900_000, 6_000,
    ]);
    expect(() => parseSupervisorCliArgs(["--profile", "teddy-7-all-active", "--max-connections", String(SUPERVISOR_LIMITS.maxConnections + 1)])).toThrow(/--max-connections/);
    // Diagnostic --symbols: an EXPLICIT, never-substituting selection.
    expect(parseSupervisorCliArgs(["--profile", "teddy-7-all-active", "--symbols", "BTCUSDT"]).selection).toEqual({ mode: "EXPLICIT", symbols: ["BTCUSDT"] });
  });

  it("the default capacity fits the current active universe with headroom; only what is needed is opened", () => {
    const options = parseSupervisorCliArgs(["--profile", "teddy-7-all-active"]);
    const capacity = connectionCapacityOf(options.symbolsPerConnection, options.maxConnections);
    expect(capacity).toBe(800);
    // About 520 active USDT perpetuals as of 2026-10 (about 470 eligible): fits with at least 50% headroom.
    expect(capacity).toBeGreaterThanOrEqual(Math.ceil(523 * 1.5));
    expect(options.maxConnections).toBeLessThanOrEqual(SUPERVISOR_LIMITS.maxConnections);
    expect(assignConnections(Array.from({ length: 523 }, (_, i) => `S${String(i).padStart(4, "0")}`), options.symbolsPerConnection, options.maxConnections)).toHaveLength(11);
  });
});

// ===========================================================================
// Generated exchangeInfo + the real supervisor on a fixture engine
// ===========================================================================

const D = (d: number, h = 0, m = 0) => Date.UTC(2025, 0, d, h, m);
const CTX = D(6);
/** The new profile on the supervisor tests' short fixture timeline (1D only): same universe, same ceiling. */
const FIXTURE_ALL: ScannerProfile = {
  ...N,
  engine: { ...N.engine, historyStart: "2025-01-06T00:00:00Z", switchover: "2025-01-10T12:00:00Z", engineSourceTimeframes: engineTimeframes("1D") },
  delivery: { ...N.delivery, dashboardSourceTimeframes: dashboardTimeframes("1D") },
  execution: { ...N.execution, futureExecutionSourceTimeframes: futureExecutionTimeframes("1D") },
} as ScannerProfile;

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
const LATE = FULL.filter((b) => b.openTimeMs >= D(8));

/** E*: eligible. NEW*: listed well after the context start (free pre-check). BAD*: history starts late (canonical preparation refuses). */
const kindOf = (symbol: string) => (symbol.startsWith("BAD") ? "INSUFFICIENT" : symbol.startsWith("NEW") ? "TOO_NEW" : "ELIGIBLE");
const eligibleNames = (n: number) => Array.from({ length: n }, (_, i) => `E${String(i).padStart(4, "0")}USDT`);
/** Every listing of exchangeInfo(n, { tooNew, insufficient }), sorted: all of them are scanner-eligible from their own origin. */
const allNames = (n: number, tooNew: number, insufficient: number) =>
  [
    ...eligibleNames(n),
    ...Array.from({ length: tooNew }, (_, i) => `NEW${String(i).padStart(3, "0")}USDT`),
    ...Array.from({ length: insufficient }, (_, i) => `BAD${String(i).padStart(3, "0")}USDT`),
  ].sort();

/** A deterministic exchangeInfo payload with `eligible` eligible USDT perpetuals plus every kind of non-member. */
function exchangeInfo(eligible: number, extra: { tooNew?: number; insufficient?: number } = {}) {
  const row = (symbol: string, over: Record<string, unknown> = {}) => ({
    symbol, baseAsset: symbol.replace(/USDT$|USDC$/, ""), quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING",
    onboardDate: kindOf(symbol) === "TOO_NEW" ? D(8) : CTX - 86_400_000, underlyingType: "COIN", ...over,
  });
  return {
    symbols: [
      ...eligibleNames(eligible).map((s) => row(s)),
      ...Array.from({ length: extra.tooNew ?? 0 }, (_, i) => row(`NEW${String(i).padStart(3, "0")}USDT`)),
      ...Array.from({ length: extra.insufficient ?? 0 }, (_, i) => row(`BAD${String(i).padStart(3, "0")}USDT`)),
      // Never members of the universe:
      row("XUSDC0USDC", { quoteAsset: "USDC" }),
      row("YUSDC1USDC", { quoteAsset: "USDC" }),
      row("DELISTEDUSDT", { status: "SETTLING" }),
      row("PENDINGUSDT", { status: "PENDING_TRADING" }),
      row("BTCUSDT_261225", { contractType: "CURRENT_QUARTER" }),
      row("ETHUSDT_270326", { contractType: "NEXT_QUARTER" }),
    ],
  };
}

function simulate(profile: ScannerProfile, selection: SupervisorSelection, operational: { symbolsPerConnection: number; maxConnections: number }) {
  let now = D(10, 23, 59);
  const root = tmp("all-active-root-");
  const cacheDir = tmp("all-active-cache-");
  const urls: string[] = [];
  const ok = (body: unknown): PublicHttpResponse => ({ status: 200, header: () => null, text: async () => JSON.stringify(body) });
  const transport: PublicHttpTransport = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/fapi/v1/time") return ok({ serverTime: now });
    const symbol = u.searchParams.get("symbol") as string;
    const source = kindOf(symbol) === "ELIGIBLE" ? FULL : LATE;
    const start = Number(u.searchParams.get("startTime"));
    const end = Number(u.searchParams.get("endTime"));
    return ok(source.filter((b) => b.openTimeMs >= start && b.openTimeMs <= end && b.closeTimeMs < now).slice(0, Number(u.searchParams.get("limit"))).map((k) => [k.openTimeMs, String(k.open), String(k.high), String(k.low), String(k.close), "1", k.closeTimeMs, "1", 1, "1", "1", "0"]));
  };
  const sleep = async (ms: number) => void (now += ms);
  const governor = new GovernedPublicTransport(transport, { maxTotalRequests: 20_000, minSpacingMs: REQUEST_POLICY_LIMITS.minSpacingFloorMs, nowMs: () => now, sleep });
  const summary = profileSummaryOf(profile);
  const supervisor = new LiveShadowSupervisor(
    {
      lineage: lineageConfigOf(profile.engine),
      selection,
      universeActive: selection.candidates.length,
      onboardPrecheckMarginMs: 86_400_000,
      symbolsPerConnection: operational.symbolsPerConnection,
      maxConnections: operational.maxConnections,
      restConcurrency: 2,
      queueCapacity: 20_000,
      maxProcessingLagMs: 600_000,
      staleSymbolMs: 1_800_000,
      maxRecoveryAttempts: 3,
      liveDirFor: supervisorLiveDirFor(root, summary, "15m"),
      runId: makeRunId(now, "7a11ac71"),
      profile: summary,
    },
    {
      openStream: (url, handlers) => {
        urls.push(url);
        handlers.onOpen();
        return { close: () => undefined };
      },
      governor,
      fetchDeps: { transport: governor.transport, baseUrl: "https://fapi.binance.com", policy: { maxRequests: 500, minSpacingMs: 250, maxTransientRetries: 0, transientBackoffMs: 250 }, nowMs: () => now, sleep },
      cache: new KlineCacheStore(cacheDir),
      acquireLock: (dir) => acquireLiveShadowLock(dir, { pid: 4242, owner: "test", startedAt: "t", isProcessAlive: () => false }),
      nowMs: () => now,
      nowIso: () => new Date(now).toISOString(),
      schedule: () => undefined,
      log: () => undefined,
    }
  );
  /** The symbols each opened combined stream actually carries. */
  const streamed = () => urls.map((url) => new URL(url).searchParams.get("streams")!.split("/").map((s) => s.split("@")[0].toUpperCase()));
  const manifest = () =>
    supervisorRunManifestOf({
      runId: supervisor.status().runId as string,
      startedAt: supervisor.startedAt,
      gitHead: "test",
      chartInterval: "15m",
      engineFingerprint: supervisor.engineFingerprint,
      profile: summary,
      selection: supervisor.status().selection,
      symbols: supervisor.acceptedSymbols(),
    });
  return { supervisor, root, streamed, manifest, summary, requests: () => governor.requestsMade };
}

/** Runs the real CLI wiring: exchangeInfo -> universe -> the profile's parsed selection -> supervisor selection. */
function profileSelection(payload: unknown, argv = ["--profile", "teddy-7-all-active"]) {
  const options = parseSupervisorCliArgs(argv);
  const universe = selectUsdtPerpetualUniverse(parseExchangeInfoContracts(payload));
  return { options, universe, selection: supervisorSelectionOf(universe, options.selection) };
}

describe("ALL_ACTIVE selection over a generated 140-contract universe", () => {
  it("every active USDT perpetual is a candidate; non-USDT, inactive and dated contracts are not", () => {
    const { universe, selection } = profileSelection(exchangeInfo(130, { tooNew: 5, insufficient: 5 }));
    expect(universe.contracts).toHaveLength(140);
    expect(universe.excluded).toMatchObject({ NOT_USDT_QUOTED: 2, NOT_TRADING: 2, NOT_PERPETUAL: 2 });
    expect(selection.mode).toBe("ALL_ACTIVE");
    expect(selection.candidates.map((c) => c.symbol)).toEqual(universe.contracts.map((c) => c.symbol));
    expect(selection.candidates.every((c) => !c.required)).toBe(true);
    expect(JSON.stringify(selection)).not.toMatch(/USDC|DELISTED|PENDING|_2[67]/);
  });

  it("accepts EVERY one of the 140 listings — later listings from their own first real bar: no TOO_NEW, no pre-listing history demanded", async () => {
    const { options, selection } = profileSelection(exchangeInfo(130, { tooNew: 5, insufficient: 5 }));
    const sim = simulate(FIXTURE_ALL, selection, options);
    await sim.supervisor.start();
    const accepted = sim.supervisor.acceptedSymbols().map((s) => s.symbol);
    expect(accepted).toEqual(allNames(130, 5, 5));
    expect(accepted.length).toBeGreaterThan(50);
    expect(sim.supervisor.status().selection).toMatchObject({
      mode: "ALL_ACTIVE", targetEligible: null, universeActive: 140, candidatesTested: 140, acceptedEligible: 140, skippedTooNew: 0, skippedInsufficientHistory: 0, skippedOther: 0, universeExhausted: true,
    });
    expect(sim.supervisor.status().selection!.skipped).toEqual([]);
    // A long-listed symbol keeps the profile's history; a later listing starts at its first real closed bar.
    const originOf = (symbol: string) => sim.supervisor.acceptedSymbols().find((s) => s.symbol === symbol)!.symbolHistoryOrigin;
    expect(originOf("E0000USDT")).toMatchObject({ kind: "PROFILE_CONTEXT", firstClosedBarOpenTimeMs: null, effectiveContextStartMs: CTX });
    expect(originOf("NEW000USDT")).toMatchObject({ kind: "SYMBOL_FIRST_CLOSED_BAR", firstClosedBarOpenTimeMs: D(8), effectiveContextStartMs: D(8), effectiveHistoryStartMs: D(8) });
    expect(originOf("BAD000USDT")).toMatchObject({ kind: "SYMBOL_FIRST_CLOSED_BAR", firstClosedBarOpenTimeMs: D(8) });
    // Every accepted symbol is streamed, exactly once, on ceil(140/50) = 3 connections.
    expect(sim.streamed().map((g) => g.length)).toEqual([50, 50, 40]);
    expect(sim.streamed().flat().sort()).toEqual(accepted);
    expect(sim.supervisor.status().totals).toMatchObject({ selected: 140, failed: 0 });
    // State: only the 7% fixture engine's namespace; the legacy live-shadow tree is never created.
    expect(existsSync(path.join(sim.root, "live-shadow"))).toBe(false);
    expect(existsSync(path.join(engineNamespaceDir(sim.root, sim.summary.engineFingerprint), "USDM_PERPETUAL", "E0129USDT", "15m", "checkpoint.json"))).toBe(true);
    sim.supervisor.stop();
  });

  it("the run manifest records ALL_ACTIVE truthfully: no target, every accepted symbol, the profile and engine, never actionable", async () => {
    const { options, selection } = profileSelection(exchangeInfo(130, { tooNew: 5, insufficient: 5 }));
    const sim = simulate(FIXTURE_ALL, selection, options);
    await sim.supervisor.start();
    const manifest = sim.manifest();
    const body = manifest.body;
    expect(body.selection).toEqual({
      mode: "ALL_ACTIVE", universeActive: 140, targetEligible: null, candidatesTested: 140, acceptedEligible: 140, skippedTooNew: 0, skippedInsufficientHistory: 0, skippedOther: 0, universeExhausted: true,
    });
    expect(body.symbols.map((s) => s.symbol)).toEqual(allNames(130, 5, 5));
    expect(body.symbols.length).toBe(body.selection.acceptedEligible);
    // Symbols carry their history origin, so the manifest is v2 (membership null: this run's set is fixed).
    expect(body.schema).toBe("teddy.native-scanner.supervisor-run-manifest.v2");
    expect(body.membership).toBeNull();
    expect(body.symbols.every((s) => s.symbolHistoryOrigin !== undefined)).toBe(true);
    expect(body.profile).toMatchObject({ profileId: "TEDDY_7_ALL_ACTIVE_V1", profileLabel: "Teddy 7% All Active", engineFingerprint: body.engineFingerprint });
    expect(body.profile!.universe).toEqual({ universe: "usdt-perpetual", selection: "ALL_ACTIVE", targetEligible: null, lifecycle: "DYNAMIC_UNIVERSE_V1", symbolTrust: "EXCHANGE_INFO_UNICODE_V1" });
    expect(body.engineFingerprint).toBe(engineFingerprintOf(FIXTURE_ALL));
    expect([body.stateLayout, body.chartInterval, body.actionable]).toEqual(["ENGINE_NAMESPACE", "15m", false]);
    expect(parseRunManifest(runManifestText(manifest))).toEqual(manifest);
    // An omitted accepted symbol is refused, never a shorter manifest.
    expect(() =>
      supervisorRunManifestOf({ ...body, runId: body.runId, gitHead: "test", selection: sim.supervisor.status().selection, symbols: sim.supervisor.acceptedSymbols().slice(0, 50) })
    ).toThrow(RunManifestError);
    // Origin-bearing symbols can never be written into a v1 manifest.
    expect(() => buildRunManifest({ ...body, schema: "teddy.native-scanner.supervisor-run-manifest.v1", membership: undefined } as never)).toThrow(RunManifestError);
    // The manifest schema still refuses a count that differs from the list.
    expect(() => buildRunManifest({ ...body, selection: { ...body.selection, acceptedEligible: 50 } })).toThrow(/acceptedEligible/);
    sim.supervisor.stop();
  });
});

describe("connection capacity: every accepted symbol runs, or start-up refuses — never truncation", () => {
  const symbols251 = eligibleNames(251);

  it("251 symbols at 50 per connection: 6 connections, every symbol exactly once, in deterministic order", () => {
    const groups = assignConnections(symbols251, 50, 16);
    expect(groups.map((g) => g.length)).toEqual([50, 50, 50, 50, 50, 1]);
    expect(groups.flat()).toEqual(symbols251);
  });

  it("the same 251 under the generic ceiling of 4 connections are refused, not cut to 200", () => {
    expect(() => assignConnections(symbols251, 50, 4)).toThrow(/251 symbols need 6 connections at 50 per connection; the limit is 4/);
  });

  it("the supervisor refuses an ALL_ACTIVE selection that cannot fit BEFORE any request or lock — with an operator's lower --max-connections too", () => {
    const { selection } = profileSelection(exchangeInfo(251));
    const lowered = parseSupervisorCliArgs(["--profile", "teddy-7-all-active", "--max-connections", "4"]);
    expect(() => simulate(FIXTURE_ALL, selection, lowered)).toThrow(SupervisorConfigError);
    expect(() => simulate(FIXTURE_ALL, selection, { symbolsPerConnection: 10, maxConnections: 16 })).toThrow(/need 26 connections/);
  });

  it.each([50, 200, 251, 520])("%i long-listed + 5 later listings under the profile's defaults: all accepted, all streamed once, manifest and totals complete", async (n) => {
    const { options, selection } = profileSelection(exchangeInfo(n, { tooNew: 3, insufficient: 2 }));
    const sim = simulate(FIXTURE_ALL, selection, options);
    await sim.supervisor.start();
    const accepted = sim.supervisor.acceptedSymbols().map((s) => s.symbol);
    const total = n + 5;
    expect(accepted).toEqual(allNames(n, 3, 2));
    const groups = sim.streamed();
    expect(groups).toHaveLength(Math.ceil(total / 50));
    expect(groups.every((g) => g.length <= 50)).toBe(true);
    expect(groups.flat().sort()).toEqual(accepted);
    expect(new Set(groups.flat()).size).toBe(total);
    const status = sim.supervisor.status();
    expect(status.connections.map((c) => c.assigned).reduce((a, b) => a + b, 0)).toBe(total);
    expect(status.totals).toMatchObject({ selected: total, failed: 0, catchupPending: 0 });
    expect(status.selection).toMatchObject({ acceptedEligible: total, skippedTooNew: 0, skippedInsufficientHistory: 0, universeExhausted: true });
    expect(sim.manifest().body.symbols.map((s) => s.symbol)).toEqual(accepted);
    sim.supervisor.stop();
  }, 180_000);
});

// ===========================================================================
// Multi-emitter binding to a future teddy-7-all-active run
// ===========================================================================

describe("multi-emitter binding: --profile teddy-7-all-active --run-id <run> --expect-engine-fingerprint <7% engine>", () => {
  const ENGINE7 = engineFingerprintOf(N);
  const RUN_ID = makeRunId(Date.UTC(2026, 9, 4, 1, 0), "7a11ac71");
  const BOOT = "d".repeat(64);
  const symbols = eligibleNames(120);
  const ORIGIN = {
    semantics: "SYMBOL_FIRST_CLOSED_BAR_V1" as const, kind: "PROFILE_CONTEXT" as const, firstClosedBarOpenTimeMs: null,
    effectiveContextStartMs: Date.parse("2025-12-29T00:00:00Z"), effectiveHistoryStartMs: Date.parse("2026-01-01T00:00:00Z"), effectiveSwitchoverMs: Date.parse("2026-09-12T01:00:00Z"),
  };
  const lineageOf = (symbol: string) => profileLineageIdFor(N, symbol, BOOT, ORIGIN);

  function manifestOf(over: { profile?: ReturnType<typeof profileSummaryOf>; engineFingerprint?: string; lineage?: Record<string, string> } = {}): SupervisorRunManifest {
    const profile = over.profile ?? profileSummaryOf(N);
    return buildRunManifest({
      schema: "teddy.native-scanner.supervisor-run-manifest.v2",
      membership: null,
      runId: RUN_ID,
      startedAt: "2026-10-04T01:00:00.000Z",
      gitHead: "test",
      marketType: "USDM_PERPETUAL",
      chartInterval: "15m",
      engineFingerprint: over.engineFingerprint ?? ENGINE7,
      profile,
      stateLayout: "ENGINE_NAMESPACE",
      selection: { mode: "ALL_ACTIVE", universeActive: 131, targetEligible: null, candidatesTested: 131, acceptedEligible: symbols.length, skippedTooNew: 8, skippedInsufficientHistory: 3, skippedOther: 0, universeExhausted: true },
      symbols: symbols.map((symbol) => ({ symbol, lineageId: over.lineage?.[symbol] ?? lineageOf(symbol), bootstrapInputSha256: BOOT, symbolHistoryOrigin: ORIGIN })),
      actionable: false,
    });
  }
  const checkpoints = (overrides: Record<string, string | null> = {}) => (symbol: string) =>
    overrides[symbol] === null ? null : { lineageId: overrides[symbol] ?? lineageOf(symbol), symbol, chartInterval: "15m", marketType: "USDM_PERPETUAL" };
  const bind = (manifest: SupervisorRunManifest, expect_ = { profileId: N.profileId, runId: RUN_ID, engineFingerprint: ENGINE7 }, cps = checkpoints()) =>
    bindPinnedRun({ manifest, expect: expect_, checkpointOf: cps });

  it("the emitter CLI accepts the new profile with its run id and engine fingerprint", () => {
    const request = parseMultiEmitterCliArgs(["--profile", "teddy-7-all-active", "--run-id", RUN_ID, "--expect-engine-fingerprint", ENGINE7]);
    expect([request.profileName, request.runId, request.engineFingerprint]).toEqual(["teddy-7-all-active", RUN_ID, ENGINE7]);
    expect(resolveScannerProfile(request.profileName)).toBe(N);
  });

  it("binds every one of the 120 accepted symbols when profile, engine, lineages and checkpoints all match", () => {
    const run = bind(manifestOf());
    expect(run.profile).toBe(N);
    expect(run.engineFingerprint).toBe(ENGINE7);
    expect(run.summary.profileLabel).toBe("Teddy 7% All Active");
    expect(run.lanes.map((l) => l.symbol)).toEqual(symbols);
    expect(run.lanes.every((l) => l.bindingFailure === null)).toBe(true);
  });

  it("refuses a wrong profile — whether the manifest or the pin names another profile, even with the 7% engine", () => {
    expect(() => bind(manifestOf(), { profileId: T.profileId, runId: RUN_ID, engineFingerprint: ENGINE7 })).toThrow(expect.objectContaining({ code: "PROFILE_MISMATCH" }));
    expect(() => bind(manifestOf({ profile: { ...profileSummaryOf(N), profileId: T.profileId } }))).toThrow(expect.objectContaining({ code: "PROFILE_MISMATCH" }));
    const aggressiveRun = manifestOf({ profile: profileSummaryOf(T), engineFingerprint: TEDDY_18_FINGERPRINT });
    expect(() => bind(aggressiveRun)).toThrow(expect.objectContaining({ code: "PROFILE_MISMATCH" }));
  });

  it("refuses a wrong engine fingerprint — pinned, or in the manifest", () => {
    expect(() => bind(manifestOf(), { profileId: N.profileId, runId: RUN_ID, engineFingerprint: TEDDY_18_FINGERPRINT })).toThrow(expect.objectContaining({ code: "ENGINE_FINGERPRINT_MISMATCH" }));
    const forged = manifestOf({ engineFingerprint: TEDDY_18_FINGERPRINT, profile: { ...profileSummaryOf(N), engineFingerprint: TEDDY_18_FINGERPRINT } });
    expect(() => bind(forged)).toThrow(RunBindingError);
  });

  it("refuses a malformed manifest before binding", () => {
    const text = runManifestText(manifestOf());
    expect(() => parseRunManifest(text.replace('"acceptedEligible":120', '"acceptedEligible":50'))).toThrow(RunManifestError);
    expect(() => parseRunManifest(text.replace('"actionable":false', '"actionable":true'))).toThrow(RunManifestError);
    expect(() => parseRunManifest("{")).toThrow(RunManifestError);
  });

  it("a missing checkpoint or a mismatched lineage fails that symbol's lane alone", () => {
    const run = bind(manifestOf({ lineage: { E0007USDT: "9".repeat(64) } }), undefined, checkpoints({ E0003USDT: null, E0005USDT: lineageOf("E0006USDT") }));
    const failed = Object.fromEntries(run.lanes.filter((l) => l.bindingFailure !== null).map((l) => [l.symbol, l.bindingFailure!.split(":")[0]]));
    expect(failed).toEqual({ E0003USDT: "CHECKPOINT_MISSING", E0005USDT: "CHECKPOINT_MISMATCH", E0007USDT: "LINEAGE_MISMATCH" });
    expect(run.lanes.filter((l) => l.bindingFailure === null)).toHaveLength(117);
  });
});

// ===========================================================================
// Dashboard delivery and the Alert payload
// ===========================================================================

describe("delivery: NATIVE_DELIVERY_V2, 1D/1W/1M only", () => {
  const LINEAGE = "4".repeat(64);
  const identity = { lineageId: LINEAGE, marketType: "USDM_PERPETUAL" as const, symbol: "E0001USDT", chartInterval: "15m" as const };

  it.each([
    ["1D", true],
    ["1W", true],
    ["1M", true],
    ["3M", false],
    ["6M", false],
    ["12M", false],
  ] as const)("%s deliverable=%s", (tf, deliverable) => {
    const record = parseShadowEventLog(logOf([observation({ symbol: "E0001USDT", lineageId: LINEAGE, sourceTf: tf })]), identity)[0];
    expect(ineligibilityOfV2(record, N.delivery) === null).toBe(deliverable);
  });

  it("the Alert payload names the new profile truthfully, carries no target count, and claims no execution", () => {
    const record = parseShadowEventLog(logOf([observation({ symbol: "E0001USDT", lineageId: LINEAGE, sourceTf: "1W", barMs: bar(1) })]), identity);
    const decision = selectNativeDeliveriesV2(record, N.delivery).flatMap((s) => (s.kind === "DELIVER" ? [s.decision] : []))[0];
    const draft = buildNativeAlertDraftV2(decision, { profile: profileSummaryOf(N), runId: makeRunId(Date.UTC(2026, 9, 4), "7a11ac71") });
    const payload = draft.rawPayload as { actionable: boolean; delivery: { policyVersion: string }; profile: Record<string, unknown> };
    expect(draft.source).toBe("NATIVE");
    expect(payload.actionable).toBe(false);
    expect(payload.delivery.policyVersion).toBe("NATIVE_DELIVERY_V2");
    expect(payload.profile).toMatchObject({
      profileId: "TEDDY_7_ALL_ACTIVE_V1", profileLabel: "Teddy 7% All Active", engineFingerprint: engineFingerprintOf(N),
      dashboardSourceTimeframes: ["1D", "1W", "1M"], futureExecutionSourceTimeframes: ["1D", "1W"], nativeExecutionEnabled: false, universeTargetEligible: null,
    });
    expect(JSON.stringify(payload)).not.toMatch(/Teddy Aggressive/);
  });
});
