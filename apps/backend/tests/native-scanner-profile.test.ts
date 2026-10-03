import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createNativeEngineConfig, type NativeKline } from "@trading-alert-dashboard/shared";

import { GovernedPublicTransport } from "../src/modules/native-scanner/candidate-rank-runner";
import { KlineCacheStore } from "../src/modules/native-scanner/kline-cache";
import { REQUEST_POLICY_LIMITS, type PublicHttpResponse, type PublicHttpTransport } from "../src/modules/native-scanner/kline-fetcher";
import { parseLineageConfig, type LineageConfig } from "../src/modules/native-scanner/live-shadow-cli-args";
import { SupervisorCliUsageError, parseSupervisorCliArgs } from "../src/modules/native-scanner/live-shadow-supervisor-cli-args";
import { LiveShadowSupervisor, SupervisorConfigError, liveShadowDir, type SupervisorStatus } from "../src/modules/native-scanner/live-shadow-supervisor";
import { acquireLiveShadowLock } from "../src/modules/native-scanner/scanner-lock";
import { buildScannerLineage, type ScannerLineage } from "../src/modules/native-scanner/scanner-lineage";
import {
  ScannerProfileError,
  TEDDY_AGGRESSIVE_V1,
  assertEngineNamespace,
  dashboardTimeframes,
  deliveryPolicyFingerprintOf,
  engineFingerprintOf,
  engineFingerprintOfConfig,
  engineFingerprintOfLineage,
  engineNamespaceDir,
  engineNamespaceManifestOf,
  engineTimeframes,
  executionPolicyFingerprintOf,
  futureExecutionTimeframes,
  lineageConfigOf,
  liveShadowEngineDir,
  profileLineageIdFor,
  profileSummaryOf,
  resolveScannerProfile,
  type DashboardDeliveryTimeframe,
  type EngineSourceTimeframe,
  type ScannerProfile,
} from "../src/modules/native-scanner/scanner-profile";
import { RunManifestError, SUPERVISOR_RUN_MANIFEST_SCHEMA, buildRunManifest, makeRunId, parseRunManifest, runManifestText } from "../src/modules/native-scanner/supervisor-run-manifest";
import { doji, repeat, type Ohlc } from "./helpers/native-signal-fixtures";
import { fifteenMinute } from "./helpers/native-scanner-fakes";

/**
 * NATIVE SCANNER PROFILES: the three policy layers, their fingerprints, the
 * engine-fingerprint state namespace, and lineage/checkpoint isolation between
 * engine-incompatible profiles (the 7% corpus vs the 18% Teddy Aggressive).
 * Fake public REST, manual clock, temporary directories only.
 */

const T = TEDDY_AGGRESSIVE_V1;
const with_ = (profile: ScannerProfile, patch: { engine?: object; delivery?: object; execution?: object; universe?: object; label?: string }): ScannerProfile =>
  ({
    ...profile,
    label: patch.label ?? profile.label,
    engine: { ...profile.engine, ...(patch.engine ?? {}) },
    delivery: { ...profile.delivery, ...(patch.delivery ?? {}) },
    execution: { ...profile.execution, ...(patch.execution ?? {}) },
    universe: { ...profile.universe, ...(patch.universe ?? {}) },
  }) as ScannerProfile;

const TEDDY_FLAGS: Record<string, string> = {
  "--interval": "15m", "--history-start": "2026-01-01T00:00:00Z", "--switchover": "2026-09-12T01:00:00Z", "--min-move-percent": "18",
  "--touch-tolerance-percent": "1", "--cooldown-bars": "10", "--min-bars-after-creation": "5", "--min-bars-after-arming": "4",
  "--source-timeframes": "1D,1W,1M,3M,6M,12M", "--max-levels": "500", "--timing": "Immediate", "--partial-period-policy": "SWITCHOVER_TRUNCATED_CLOSED_BARS",
};

describe("profile model: Teddy Aggressive", () => {
  it("1. resolves to exactly the requested engine settings — the same engine the equivalent explicit flags build", () => {
    expect(resolveScannerProfile("teddy-aggressive")).toBe(T);
    expect(T.profileId).toBe("TEDDY_AGGRESSIVE_V1");
    expect(T.label).toBe("Teddy Aggressive");
    const config = lineageConfigOf(T.engine);
    expect(config.chartInterval).toBe("15m");
    expect(config.historyStartMs).toBe(Date.UTC(2026, 0, 1));
    expect(config.switchoverMs).toBe(Date.UTC(2026, 8, 12, 1));
    expect(config.engine).toEqual(
      createNativeEngineConfig({
        minMovePct: 0.18, touchTolerancePct: 0.01, touchCooldownBars: 10, minBarsAfterCreation: 5, minBarsAfterArming: 4, maxLevels: 500,
        enabledSourceTfs: ["1D", "1W", "1M", "3M", "6M", "12M"], timing: "Immediate",
      })
    );
    expect(config).toEqual(parseLineageConfig((name) => TEDDY_FLAGS[name]));
    expect(T.engine.partialPeriodPolicy).toBe("SWITCHOVER_TRUNCATED_CLOSED_BARS");
  });

  it("2-5. universe target 50 eligible; engine TFs 1D..12M; dashboard TFs 1D/1W/1M; future execution TFs 1D/1W and never enabled", () => {
    expect(T.universe).toEqual({ layer: "UNIVERSE", universe: "usdt-perpetual", targetEligible: 50 });
    expect([...T.engine.engineSourceTimeframes]).toEqual(["1D", "1W", "1M", "3M", "6M", "12M"]);
    expect([...T.delivery.dashboardSourceTimeframes]).toEqual(["1D", "1W", "1M"]);
    expect([...T.execution.futureExecutionSourceTimeframes]).toEqual(["1D", "1W"]);
    expect(T.execution.nativeExecutionEnabled).toBe(false);
    expect(T.delivery.actionable).toBe(false);
    expect(T.delivery.policyVersion).toBe("NATIVE_DELIVERY_V2");
    // The layers are separate objects with separate field names: there is no shared "enabledTimeframes".
    expect(Object.keys(T.engine)).not.toContain("dashboardSourceTimeframes");
    expect(Object.keys(T.delivery)).not.toContain("engineSourceTimeframes");
    expect(Object.keys(T.execution)).not.toContain("dashboardSourceTimeframes");
    expect(profileSummaryOf(T).execution.notice).toMatch(/NOT enabled/);
  });

  it("the compiler refuses to interchange the three timeframe lists", () => {
    const engine: readonly EngineSourceTimeframe[] = engineTimeframes("1D");
    const delivery: readonly DashboardDeliveryTimeframe[] = dashboardTimeframes("1D");
    // @ts-expect-error a dashboard delivery list is not an engine list
    const notEngine: readonly EngineSourceTimeframe[] = delivery;
    // @ts-expect-error a future execution list is not a dashboard delivery list
    const notDelivery: readonly DashboardDeliveryTimeframe[] = futureExecutionTimeframes("1D");
    // @ts-expect-error an engine list is not a future execution list
    const notExecution: readonly ReturnType<typeof futureExecutionTimeframes>[number][] = engine;
    expect([notEngine, notDelivery, notExecution].every((list) => list.length === 1)).toBe(true);
  });

  it("cross-layer invariants: a profile can never enable native execution, deliver or execute a TF the engine does not compute", () => {
    expect(() => resolveScannerProfile("account-a")).toThrow(ScannerProfileError);
    expect(() => profileSummaryOf(with_(T, { execution: { nativeExecutionEnabled: true } }))).toThrow(/never enable native execution/);
    expect(() => profileSummaryOf(with_(T, { engine: { engineSourceTimeframes: engineTimeframes("1D", "1W") } }))).toThrow(/delivery timeframe 1M is not an engine timeframe/);
    expect(() => profileSummaryOf(with_(T, { engine: { partialPeriodPolicy: "OTHER" } }))).toThrow(/partialPeriodPolicy/);
    expect(() => dashboardTimeframes("1D", "1D")).toThrow(/twice/);
    expect(() => engineTimeframes("2D")).toThrow(/unknown timeframe/);
  });
});

describe("engine fingerprint: every state-affecting input, nothing else", () => {
  const base = engineFingerprintOf(T);
  const seven = engineFingerprintOf(with_(T, { engine: { minMovePercent: 7 } }));

  it("6. min move 18 participates: Teddy Aggressive is NOT the 7% engine; it equals the fingerprint of the equivalent explicit flags", () => {
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(base).not.toBe(seven);
    expect(base).toBe(engineFingerprintOfConfig(parseLineageConfig((name) => TEDDY_FLAGS[name])));
    expect(seven).toBe(engineFingerprintOfConfig(parseLineageConfig((name) => ({ ...TEDDY_FLAGS, "--min-move-percent": "7" })[name] as string)));
  });

  it.each([
    ["7. min move 18 -> 19", { minMovePercent: 19 }],
    ["8. touch tolerance", { touchTolerancePercent: 1.5 }],
    ["9. cooldown", { cooldownBars: 11 }],
    ["min bars after creation", { minBarsAfterCreation: 6 }],
    ["min bars after arming", { minBarsAfterArming: 5 }],
    ["10. source timeframes", { engineSourceTimeframes: engineTimeframes("1D", "1W", "1M", "3M", "6M") }],
    ["11. max levels", { maxLevels: 499 }],
    ["12. timing", { timing: "Bar Close" }],
    ["history start", { historyStart: "2026-01-02T00:00:00Z" }],
    ["switchover", { switchover: "2026-09-12T01:15:00Z" }],
  ])("%s changes the engine fingerprint", (_label, engine) => {
    const changed = with_(T, {
      engine,
      // A source-TF removal must also leave the dependent layers valid.
      delivery: { dashboardSourceTimeframes: dashboardTimeframes("1D", "1W", "1M") },
    });
    expect(engineFingerprintOf(changed)).not.toBe(base);
  });

  it("13. the partial-period policy and every other lineage-level semantic input are inside the fingerprint", () => {
    const config = lineageConfigOf(T.engine);
    const lineage = buildScannerLineage({
      marketType: "USDM_PERPETUAL", symbol: "BTCUSDT", chartInterval: "15m", historyStartMs: config.historyStartMs, compatibilitySwitchoverMs: config.switchoverMs,
      engineConfig: config.engine, partialPeriodPolicy: "SWITCHOVER_TRUNCATED_CLOSED_BARS", bootstrapInputSha256: "c".repeat(64),
    }).lineage;
    expect(engineFingerprintOfLineage(lineage)).toBe(base);
    for (const [field, value] of [
      ["partialPeriodPolicy", "SOME_OTHER_POLICY"],
      ["engineSemantics", "other-engine"],
      ["historicalStateSemantics", "other-state"],
      ["klineSource", "other-source"],
      ["chartInterval", "1h"],
      ["htfContextStartMs", 0],
    ] as const) {
      expect({ field, same: engineFingerprintOfLineage({ ...lineage, [field]: value } as ScannerLineage) === base }).toEqual({ field, same: false });
    }
    // ... while the per-symbol fields are not: every symbol of one engine shares its fingerprint.
    expect(engineFingerprintOfLineage({ ...lineage, symbol: "ETHUSDT", bootstrapInputSha256: "d".repeat(64) })).toBe(base);
  });

  it("14. a dashboard-delivery-only change keeps the engine fingerprint and changes the delivery fingerprint", () => {
    const narrower = with_(T, { delivery: { dashboardSourceTimeframes: dashboardTimeframes("1D", "1W") } });
    expect(engineFingerprintOf(narrower)).toBe(base);
    expect(deliveryPolicyFingerprintOf(narrower.delivery)).not.toBe(deliveryPolicyFingerprintOf(T.delivery));
    expect(executionPolicyFingerprintOf(narrower.execution)).toBe(executionPolicyFingerprintOf(T.execution));
  });

  it("15. an execution-policy-only change keeps the engine and delivery fingerprints and changes the execution fingerprint", () => {
    const wider = with_(T, { execution: { futureExecutionSourceTimeframes: futureExecutionTimeframes("1D", "1W", "1M") } });
    expect(engineFingerprintOf(wider)).toBe(base);
    expect(deliveryPolicyFingerprintOf(wider.delivery)).toBe(deliveryPolicyFingerprintOf(T.delivery));
    expect(executionPolicyFingerprintOf(wider.execution)).not.toBe(executionPolicyFingerprintOf(T.execution));
  });

  it("16/17. the universe target and the display label change no fingerprint and no per-symbol lineage", () => {
    for (const changed of [with_(T, { universe: { targetEligible: 100 } }), with_(T, { label: "Something Else" })]) {
      const a = profileSummaryOf(changed);
      const b = profileSummaryOf(T);
      expect([a.engineFingerprint, a.deliveryPolicyFingerprint, a.executionPolicyFingerprint]).toEqual([b.engineFingerprint, b.deliveryPolicyFingerprint, b.executionPolicyFingerprint]);
      expect(profileLineageIdFor(changed, "BTCUSDT", "c".repeat(64))).toBe(profileLineageIdFor(T, "BTCUSDT", "c".repeat(64)));
    }
  });
});

describe("supervisor CLI: --profile is fail-closed", () => {
  it("19. any lineage or universe flag alongside --profile is refused — even one equal to the profile's own value", () => {
    for (const [flag, value] of [...Object.entries(TEDDY_FLAGS), ["--universe", "usdt-perpetual"], ["--max-symbols", "50"], ["--include-symbols", "BTCUSDT"], ["--exclude-symbols", "BTCUSDT"]]) {
      expect(() => parseSupervisorCliArgs(["--profile", "teddy-aggressive", flag, value])).toThrow(SupervisorCliUsageError);
    }
    expect(() => parseSupervisorCliArgs(["--profile", "teddy-aggressive", "--all-active"])).toThrow(/conflicting/);
    expect(() => parseSupervisorCliArgs(["--profile", "teddy-conservative"])).toThrow(/unknown profile/);
    expect(() => parseSupervisorCliArgs(["--profile", "teddy-aggressive", "--account", "A"])).toThrow(/unexpected argument/);
  });

  it("--profile alone: the profile's engine and its 50-eligible universe target; operational flags still apply", () => {
    const options = parseSupervisorCliArgs(["--profile", "teddy-aggressive", "--symbols-per-connection", "50", "--max-connections", "2", "--duration-minutes", "45"]);
    expect(options.profile).toBe(T);
    expect(options.lineage).toEqual(lineageConfigOf(T.engine));
    expect(options.selection).toEqual({ mode: "UNIVERSE", include: [], exclude: [], maxSymbols: 50 });
    expect([options.symbolsPerConnection, options.maxConnections, options.durationMinutes]).toEqual([50, 2, 45]);
    // Legacy explicit-flag operation is unchanged.
    const legacy = parseSupervisorCliArgs([...Object.entries({ ...TEDDY_FLAGS, "--min-move-percent": "7" }).flat(), "--universe", "usdt-perpetual", "--max-symbols", "100"]);
    expect(legacy.profile).toBeNull();
    expect(legacy.selection).toEqual({ mode: "UNIVERSE", include: [], exclude: [], maxSymbols: 100 });
  });

  it("20 (CLI). diagnostic --symbols with a profile is an EXPLICIT, non-substituting selection", () => {
    expect(parseSupervisorCliArgs(["--profile", "teddy-aggressive", "--symbols", "BTCUSDT,ETHUSDT"]).selection).toEqual({ mode: "EXPLICIT", symbols: ["BTCUSDT", "ETHUSDT"] });
  });
});

// ===========================================================================
// Checkpoints and lineage across engine-incompatible profiles (fixture engine)
// ===========================================================================

const D = (d: number, h = 0, m = 0) => Date.UTC(2025, 0, d, h, m);
/** The fixture engine as a profile: 1D only, 15m, the supervisor tests' timeline. */
const FIXTURE: ScannerProfile = with_(T, {
  engine: { historyStart: "2025-01-06T00:00:00Z", switchover: "2025-01-10T12:00:00Z", minMovePercent: 7, engineSourceTimeframes: engineTimeframes("1D") },
  delivery: { dashboardSourceTimeframes: dashboardTimeframes("1D") },
  execution: { futureExecutionSourceTimeframes: futureExecutionTimeframes("1D") },
});
const FIXTURE_7 = FIXTURE;
const FIXTURE_18 = with_(FIXTURE, { engine: { minMovePercent: 18 } });

function fixtureBars(): NativeKline[] {
  const rows: Ohlc[] = [];
  rows.push(...repeat(doji(100), 96));
  rows.push([100, 120, 99, 99], ...repeat(doji(99), 95));
  rows.push(...repeat(doji(99), 96));
  rows.push([99, 121, 98.5, 99], ...repeat(doji(99), 94), [99, 99, 98.9, 98.9]);
  rows.push([98.9, 123, 98.9, 123], ...repeat(doji(123), 95));
  rows.push([123, 123, 119.5, 122.5], ...repeat(doji(122.5), 40));
  return fifteenMinute(D(6), rows);
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  dirs.push(d);
  return d;
};

/** Runs one supervisor start over explicit symbols; `layout` picks the state tree. */
async function runOnce(opts: { profile: ScannerProfile; root: string; cacheDir: string; symbols: string[]; nowMs: number; layout: "NAMESPACE" | "LEGACY"; operational?: Partial<{ symbolsPerConnection: number; maxConnections: number; restConcurrency: number; queueCapacity: number }> }) {
  let now = opts.nowMs;
  const ok = (body: unknown): PublicHttpResponse => ({ status: 200, header: () => null, text: async () => JSON.stringify(body) });
  const transport: PublicHttpTransport = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/fapi/v1/time") return ok({ serverTime: now });
    // BAD*: a symbol with no klines at all, so canonical preparation refuses it.
    if ((u.searchParams.get("symbol") ?? "").startsWith("BAD")) return ok([]);
    const start = Number(u.searchParams.get("startTime"));
    const end = Number(u.searchParams.get("endTime"));
    return ok(fixtureBars().filter((b) => b.openTimeMs >= start && b.openTimeMs <= end && b.closeTimeMs < now).slice(0, Number(u.searchParams.get("limit"))).map((k) => [k.openTimeMs, String(k.open), String(k.high), String(k.low), String(k.close), "1", k.closeTimeMs, "1", 1, "1", "1", "0"]));
  };
  const sleep = async (ms: number) => void (now += ms);
  const governor = new GovernedPublicTransport(transport, { maxTotalRequests: 2_000, minSpacingMs: REQUEST_POLICY_LIMITS.minSpacingFloorMs, nowMs: () => now, sleep });
  const summary = profileSummaryOf(opts.profile);
  const lineage: LineageConfig = lineageConfigOf(opts.profile.engine);
  const logs: string[] = [];
  const supervisor = new LiveShadowSupervisor(
    {
      lineage,
      symbols: opts.symbols,
      symbolsPerConnection: opts.operational?.symbolsPerConnection ?? 3,
      maxConnections: opts.operational?.maxConnections ?? 4,
      restConcurrency: opts.operational?.restConcurrency ?? 2,
      queueCapacity: opts.operational?.queueCapacity ?? 10_000,
      maxProcessingLagMs: 600_000,
      staleSymbolMs: 1_800_000,
      maxRecoveryAttempts: 3,
      liveDirFor: (symbol) => (opts.layout === "LEGACY" ? liveShadowDir(opts.root, symbol, "15m") : liveShadowEngineDir(opts.root, summary.engineFingerprint, "USDM_PERPETUAL", symbol, "15m")),
      runId: makeRunId(now, "0a0b0c0d"),
      profile: opts.layout === "LEGACY" ? null : summary,
    },
    {
      openStream: (_url, handlers) => {
        handlers.onOpen();
        return { close: () => undefined };
      },
      governor,
      fetchDeps: { transport: governor.transport, baseUrl: "https://fapi.binance.com", policy: { maxRequests: 500, minSpacingMs: 250, maxTransientRetries: 0, transientBackoffMs: 250 }, nowMs: () => now, sleep },
      cache: new KlineCacheStore(opts.cacheDir),
      acquireLock: (dir) => acquireLiveShadowLock(dir, { pid: 4242, owner: "test", startedAt: "t", isProcessAlive: () => false }),
      nowMs: () => now,
      nowIso: () => new Date(now).toISOString(),
      schedule: (fn) => fn(),
      log: (line) => logs.push(line),
    }
  );
  await supervisor.start();
  const status: SupervisorStatus = supervisor.status();
  const accepted = supervisor.acceptedSymbols();
  supervisor.stop();
  return { supervisor, status, accepted, logs, engineFingerprint: supervisor.engineFingerprint };
}

/** SHA-256 of every file under `dir` (relative path -> hash): byte-level proof nothing was rewritten. */
function treeHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (!name.endsWith(".lock") && name !== "live-shadow.lock") out[path.relative(dir, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

const NOW = D(11, 2, 1);
const SYMBOLS = ["AAAUSDT", "BBBUSDT"];

describe("checkpoint / lineage isolation between engine-incompatible profiles", () => {
  it("the fixture profile's engine is exactly the explicit-flag fixture engine (profile -> config parity)", () => {
    const flags: Record<string, string> = { ...TEDDY_FLAGS, "--history-start": "2025-01-06T00:00:00Z", "--switchover": "2025-01-10T12:00:00Z", "--min-move-percent": "7", "--source-timeframes": "1D" };
    expect(lineageConfigOf(FIXTURE_7.engine)).toEqual(parseLineageConfig((name) => flags[name]));
    expect(engineFingerprintOf(FIXTURE_7)).not.toBe(engineFingerprintOf(FIXTURE_18));
    expect(engineNamespaceDir("R", engineFingerprintOf(FIXTURE_7))).not.toBe(engineNamespaceDir("R", engineFingerprintOf(FIXTURE_18)));
  });

  it("1/2. an 18% run REFUSES a 7% checkpoint at the same path (LINEAGE_MISMATCH) and leaves it byte-identical: no silent reuse, no overwrite", async () => {
    const root = tmp("profile-root-");
    const cacheDir = tmp("profile-cache-");
    const seven = await runOnce({ profile: FIXTURE_7, root, cacheDir, symbols: SYMBOLS, nowMs: NOW, layout: "LEGACY" });
    expect(seven.status.totals.failed).toBe(0);
    const before = treeHashes(path.join(root, "live-shadow"));
    // Force the 18% engine onto the LEGACY path (what a namespace-less run would do).
    const forced = await runOnce({ profile: FIXTURE_18, root, cacheDir, symbols: SYMBOLS, nowMs: NOW, layout: "LEGACY" });
    expect(forced.status.symbols.map((s) => [s.symbol, s.status, s.failure?.split(":")[0]])).toEqual([
      ["AAAUSDT", "FAILED", "LINEAGE_MISMATCH"],
      ["BBBUSDT", "FAILED", "LINEAGE_MISMATCH"],
    ]);
    expect(treeHashes(path.join(root, "live-shadow"))).toEqual(before);
  });

  it("3. 7% and 18% states coexist: the 18% profile builds its own namespace; neither run rewrites the other's files", async () => {
    const root = tmp("profile-root-");
    const cacheDir = tmp("profile-cache-");
    await runOnce({ profile: FIXTURE_7, root, cacheDir, symbols: SYMBOLS, nowMs: NOW, layout: "LEGACY" });
    const legacy = treeHashes(path.join(root, "live-shadow"));
    const aggressive = await runOnce({ profile: FIXTURE_18, root, cacheDir, symbols: SYMBOLS, nowMs: NOW, layout: "NAMESPACE" });
    expect(aggressive.status.totals.failed).toBe(0);
    expect(aggressive.logs.filter((l) => l.includes("CATCHUP_OK")).every((l) => l.includes("checkpoint CREATED"))).toBe(true);
    expect(treeHashes(path.join(root, "live-shadow"))).toEqual(legacy);
    const namespace = treeHashes(path.join(root, "live-shadow-engines"));
    // The 7% engine resumes its own legacy state untouched by the 18% run, and vice versa.
    const sevenAgain = await runOnce({ profile: FIXTURE_7, root, cacheDir, symbols: SYMBOLS, nowMs: NOW, layout: "LEGACY" });
    expect(sevenAgain.logs.filter((l) => l.includes("CATCHUP_OK")).every((l) => l.includes("VERIFIED_UNCHANGED"))).toBe(true);
    expect(treeHashes(path.join(root, "live-shadow-engines"))).toEqual(namespace);
    // Different engines, different lineages for the very same symbol and bytes.
    const sevenIds = sevenAgain.accepted.map((a) => a.lineageId);
    expect(aggressive.accepted.map((a) => a.lineageId).some((id) => sevenIds.includes(id))).toBe(false);
  });

  it("4/5/6. delivery-only and execution-only profile changes, and plain restarts, reuse the same engine state with identical lineages", async () => {
    const root = tmp("profile-root-");
    const cacheDir = tmp("profile-cache-");
    const first = await runOnce({ profile: FIXTURE_18, root, cacheDir, symbols: SYMBOLS, nowMs: NOW, layout: "NAMESPACE" });
    for (const variant of [
      FIXTURE_18,
      with_(FIXTURE_18, { delivery: { dashboardSourceTimeframes: dashboardTimeframes("1D") }, label: "Renamed" }),
      with_(FIXTURE_18, { execution: { futureExecutionSourceTimeframes: futureExecutionTimeframes("1D") }, universe: { targetEligible: 7 } }),
    ]) {
      const again = await runOnce({ profile: variant, root, cacheDir, symbols: SYMBOLS, nowMs: NOW, layout: "NAMESPACE" });
      expect(again.engineFingerprint).toBe(first.engineFingerprint);
      expect(again.accepted).toEqual(first.accepted);
      expect(again.logs.filter((l) => l.includes("CATCHUP_OK")).every((l) => l.includes("VERIFIED_UNCHANGED"))).toBe(true);
    }
  });

  it("7. a restart across a gap of missed bars catches up and keeps the lineage (VERIFIED_AND_EXTENDED)", async () => {
    const root = tmp("profile-root-");
    const cacheDir = tmp("profile-cache-");
    const first = await runOnce({ profile: FIXTURE_18, root, cacheDir, symbols: SYMBOLS, nowMs: NOW, layout: "NAMESPACE" });
    const later = await runOnce({ profile: FIXTURE_18, root, cacheDir, symbols: SYMBOLS, nowMs: NOW + 5 * 15 * 60_000, layout: "NAMESPACE" });
    expect(later.accepted).toEqual(first.accepted);
    expect(later.logs.filter((l) => l.includes("CATCHUP_OK")).every((l) => l.includes("VERIFIED_AND_EXTENDED"))).toBe(true);
  });

  it("8. profile runs with restarts never touch an unrelated 7% tree (byte-identical before and after)", async () => {
    const root = tmp("profile-root-");
    const cacheDir = tmp("profile-cache-");
    await runOnce({ profile: FIXTURE_7, root, cacheDir, symbols: ["AAAUSDT", "BBBUSDT", "CCCUSDT"], nowMs: NOW, layout: "LEGACY" });
    const before = treeHashes(path.join(root, "live-shadow"));
    for (let i = 0; i < 3; i += 1) await runOnce({ profile: FIXTURE_18, root, cacheDir, symbols: SYMBOLS, nowMs: NOW + i * 15 * 60_000, layout: "NAMESPACE" });
    expect(Object.keys(before).length).toBeGreaterThan(0);
    expect(treeHashes(path.join(root, "live-shadow"))).toEqual(before);
  });

  it("18 (operational). connection count, symbols per connection, REST concurrency and queue capacity never change the engine fingerprint or a lineage", async () => {
    const a = await runOnce({ profile: FIXTURE_18, root: tmp("profile-root-"), cacheDir: tmp("profile-cache-"), symbols: SYMBOLS, nowMs: NOW, layout: "NAMESPACE" });
    const b = await runOnce({
      profile: FIXTURE_18, root: tmp("profile-root-"), cacheDir: tmp("profile-cache-"), symbols: SYMBOLS, nowMs: NOW, layout: "NAMESPACE",
      operational: { symbolsPerConnection: 1, maxConnections: 2, restConcurrency: 1, queueCapacity: 100 },
    });
    expect(b.engineFingerprint).toBe(a.engineFingerprint);
    expect(b.accepted).toEqual(a.accepted);
  });

  it("20. explicit diagnostic symbols under a profile are never substituted: an ineligible named symbol stays a visible FAILED symbol", async () => {
    const r = await runOnce({ profile: FIXTURE_18, root: tmp("profile-root-"), cacheDir: tmp("profile-cache-"), symbols: ["AAAUSDT", "BADUSDT"], nowMs: NOW, layout: "NAMESPACE" });
    expect(r.status.symbols.map((s) => [s.symbol, s.status])).toEqual([
      ["AAAUSDT", "ATTACHED"],
      ["BADUSDT", "FAILED"],
    ]);
    expect(r.status.totals.selected).toBe(2);
    // Only the prepared symbol reaches the run manifest; nothing replaced the failed one.
    expect(r.accepted.map((a) => a.symbol)).toEqual(["AAAUSDT"]);
  });

  it("a supervisor refuses a profile whose engine fingerprint does not match its engine configuration", async () => {
    const summary = profileSummaryOf(FIXTURE_18);
    expect(
      () =>
        new LiveShadowSupervisor(
          { lineage: lineageConfigOf(FIXTURE_7.engine), symbols: ["AAAUSDT"], symbolsPerConnection: 3, maxConnections: 1, restConcurrency: 1, queueCapacity: 100, maxProcessingLagMs: 1_000, staleSymbolMs: 10_000, maxRecoveryAttempts: 1, liveDirFor: () => "x", profile: summary },
          {} as never
        )
    ).toThrow(SupervisorConfigError);
  });
});

describe("status v3, run manifest and engine namespace manifest", () => {
  it("status carries runId, runState, engine fingerprint and the profile block; actionable stays false", async () => {
    const r = await runOnce({ profile: FIXTURE_18, root: tmp("profile-root-"), cacheDir: tmp("profile-cache-"), symbols: SYMBOLS, nowMs: NOW, layout: "NAMESPACE" });
    expect(r.status.schema).toBe("teddy.native-scanner.live-shadow-supervisor-status.v3");
    expect(r.status.actionable).toBe(false);
    expect(r.status.runId).toMatch(/^\d{8}T\d{6}Z-0a0b0c0d$/);
    expect(r.status.runState).toBe("RUNNING");
    expect(r.supervisor.status().runState).toBe("STOPPED");
    expect(r.status.engineFingerprint).toBe(engineFingerprintOf(FIXTURE_18));
    expect(r.status.profile).toEqual(profileSummaryOf(FIXTURE_18));
  });

  it("the run manifest round-trips, binds engine -> lineage for every accepted symbol, and refuses tampering", async () => {
    const r = await runOnce({ profile: FIXTURE_18, root: tmp("profile-root-"), cacheDir: tmp("profile-cache-"), symbols: SYMBOLS, nowMs: NOW, layout: "NAMESPACE" });
    const manifest = buildRunManifest({
      schema: SUPERVISOR_RUN_MANIFEST_SCHEMA, runId: r.status.runId as string, startedAt: r.status.startedAt, gitHead: "test", marketType: "USDM_PERPETUAL",
      chartInterval: "15m", engineFingerprint: r.engineFingerprint, profile: profileSummaryOf(FIXTURE_18), stateLayout: "ENGINE_NAMESPACE",
      selection: { mode: "EXPLICIT", universeActive: null, targetEligible: null, candidatesTested: 2, acceptedEligible: 2, skippedTooNew: 0, skippedInsufficientHistory: 0, skippedOther: 0, universeExhausted: true },
      symbols: r.accepted, actionable: false,
    });
    expect(parseRunManifest(runManifestText(manifest))).toEqual(manifest);
    for (const s of manifest.body.symbols) expect(profileLineageIdFor(FIXTURE_18, s.symbol, s.bootstrapInputSha256)).toBe(s.lineageId);
    const tampered = runManifestText(manifest).replace(manifest.body.symbols[0].lineageId, "f".repeat(64));
    expect(() => parseRunManifest(tampered)).toThrow(RunManifestError);
    expect(() => buildRunManifest({ ...manifest.body, actionable: true as never })).toThrow(/never actionable/);
    expect(() => buildRunManifest({ ...manifest.body, stateLayout: "LEGACY" })).toThrow(/engine namespace/);
  });

  it("an engine namespace is never shared: a manifest naming another engine is refused", () => {
    const fp = engineFingerprintOf(T);
    expect(() => assertEngineNamespace(null, fp)).not.toThrow();
    expect(() => assertEngineNamespace(JSON.stringify(engineNamespaceManifestOf(T)), fp)).not.toThrow();
    expect(() => assertEngineNamespace(JSON.stringify({ ...engineNamespaceManifestOf(T), engineFingerprint: "e".repeat(64) }), fp)).toThrow(/refusing to share state/);
    expect(() => assertEngineNamespace("{", fp)).toThrow(/not JSON/);
    expect(liveShadowEngineDir("R", fp, "USDM_PERPETUAL", "BTCUSDT", "15m")).toBe(path.join("R", "live-shadow-engines", fp.slice(0, 24), "USDM_PERPETUAL", "BTCUSDT", "15m"));
    expect(liveShadowEngineDir("R", fp, "USDM_PERPETUAL", "BTCUSDT", "15m")).not.toContain(path.join("R", "live-shadow", "USDM_PERPETUAL"));
  });
});

describe("static boundaries of the profile and manifest modules", () => {
  const SRC = path.resolve(__dirname, "../src/modules/native-scanner");
  const code = (file: string) => readFileSync(path.join(SRC, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it.each(["scanner-profile.ts", "supervisor-run-manifest.ts"])("%s names no account, execution path, credential, database or queue", (file) => {
    expect(code(file)).not.toMatch(/Account ?[AB]\b|accountIdentifier|executionProfile|execution\.service|createExecution|tradeExecution|extreme-rr|selected-plan|binance-execution|prisma|redis|bullmq|BINANCE_API|apiSecret|process\.env/i);
  });
});

it("the CLI's profile lineage config fingerprints to exactly the profile's engine (no flag can leak in)", () => {
  const options = parseSupervisorCliArgs(["--profile", "teddy-aggressive"]);
  expect(engineFingerprintOfConfig(options.lineage)).toBe(engineFingerprintOf(T));
});
