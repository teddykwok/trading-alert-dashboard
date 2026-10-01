import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  NATIVE_HISTORICAL_STATE_SEMANTICS,
  SWITCHOVER_TRUNCATED_CLOSED_BARS,
  createNativeEngineConfig,
  reconstructPineHistoricalState,
  stepNativeEngineWithImmediate,
  type NativeCandidate,
  type NativeEngineConfigInput,
  type NativeKline,
} from "@trading-alert-dashboard/shared";

import { canonicalJson, canonicalSha256, CanonicalJsonError } from "../src/modules/native-scanner/canonical-json";
import {
  COMPAT_EVIDENCE_NOTE,
  COMPAT_MANIFEST_SCHEMA,
  buildCompatReplayManifest,
  compatReplayRanges,
  engineStateSha256,
  runCompatibilityReplay,
  selectCompatReplayBars,
  type CompatReplayRequest,
} from "../src/modules/native-scanner/compat-replay";
import { CompatReplayCliUsageError, parseCompatReplayCliArgs } from "../src/modules/native-scanner/compat-replay-cli-args";
import { executeCompatibilityReplay } from "../src/modules/native-scanner/compat-replay-runner";
import { NATIVE_ENGINE_SEMANTICS, REPLAY_RECORD_SCHEMA, runHistoricalReplay } from "../src/modules/native-scanner/historical-replay";
import { KlineCacheStore, serializeKlines, sha256Hex } from "../src/modules/native-scanner/kline-cache";
import type { ClosedKlineRangeRequest } from "../src/modules/native-scanner/kline-fetcher";
import { ReplayCliUsageError, parseReplayCliArgs } from "../src/modules/native-scanner/replay-cli-args";
import {
  SCANNER_KLINE_SOURCE,
  SCANNER_LINEAGE_SCHEMA,
  ScannerLineageError,
  buildScannerLineage,
  deriveHtfContextStartMs,
  scannerLineageId,
  verifyScannerLineage,
  type ScannerLineage,
  type ScannerLineageInput,
} from "../src/modules/native-scanner/scanner-lineage";
import { lcg, type Ohlc } from "./helpers/native-signal-fixtures";
import { FIFTEEN_MINUTES_MS, fifteenMinute } from "./helpers/native-scanner-fakes";

/**
 * Slice 2B-2A — immutable scanner lineage + offline compatibility replay.
 *
 * Synthetic 15m data, network-free. The LDO / THETA SHA-pinned parity
 * regressions live in native-scanner-compat-parity.test.ts.
 */

const D = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);
const config = (input: Partial<NativeEngineConfigInput> = {}) => createNativeEngineConfig({ minMovePct: 0.07, ...input });

/** Seeded noisy 15m bars with rare 9% wicks: levels, arming and retests in a few weeks. */
function noisy(startMs: number, count: number, seed: number): NativeKline[] {
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
  return fifteenMinute(startMs, rows);
}

// Monday 2025-01-06 .. Saturday 2025-01-25. History starts Wednesday 01-08, so
// the 1W period containing it began on the Monday: two days of context.
const DATA_START = D(2025, 1, 6);
const BARS = noisy(DATA_START, 19 * 96, 20250106);
const HISTORY = D(2025, 1, 8);
const S = D(2025, 1, 20, 6);
const END = D(2025, 1, 25);
const ENGINE = config({ enabledSourceTfs: ["1D", "1W"] });

const request = (overrides: Partial<CompatReplayRequest> = {}): CompatReplayRequest => ({
  symbol: "TESTUSDT",
  marketType: "USDM_PERPETUAL",
  chartInterval: "15m",
  historyStartMs: HISTORY,
  switchoverMs: S,
  endMs: END,
  engine: ENGINE,
  partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
  ...overrides,
});
const codeOf = (thunk: () => unknown) => {
  try {
    thunk();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? `unexpected: ${String(error)}`;
  }
};
const BASE = runCompatibilityReplay(BARS, request());

// ===========================================================================
// Canonical serialization
// ===========================================================================

describe("canonical JSON (scanner identity hashing)", () => {
  it("sorts keys, keeps array order, and writes a fixed vector byte for byte", () => {
    expect(canonicalJson({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}');
    const vector = { n: -1.5e-7, b: [3, { d: null, c: true }], a: 'x"y', i: 1789461900000 };
    expect(canonicalJson(vector)).toBe('{"a":"x\\"y","b":[3,{"c":true,"d":null}],"i":1789461900000,"n":-1.5e-7}');
    expect(canonicalSha256(vector)).toBe("6487c8f4f1ab5d9a15960276e41e6a52830229579a75d95e72051a1978909069");
  });

  it("refuses what it cannot represent canonically", () => {
    for (const bad of [{ a: undefined }, Number.NaN, Number.POSITIVE_INFINITY, -0, new Date(0), new Map(), BigInt(1), { f: () => 1 }]) {
      expect(() => canonicalJson(bad)).toThrow(CanonicalJsonError);
    }
  });
});

// ===========================================================================
// Lineage
// ===========================================================================

const LINEAGE_INPUT: ScannerLineageInput = {
  marketType: "USDM_PERPETUAL",
  symbol: "TESTUSDT",
  chartInterval: "15m",
  historyStartMs: HISTORY,
  compatibilitySwitchoverMs: S,
  engineConfig: ENGINE,
  partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
  bootstrapInputSha256: "a".repeat(64),
};
const idOf = (overrides: Partial<ScannerLineageInput>) => buildScannerLineage({ ...LINEAGE_INPUT, ...overrides }).lineageId;

describe("immutable scanner lineage", () => {
  const { lineage, lineageId } = buildScannerLineage(LINEAGE_INPUT);

  it("is exactly the state-shaping inputs, with fixed semantics versions and a derived context start", () => {
    expect(Object.keys(lineage).sort()).toEqual(
      [
        "bootstrapInputSha256",
        "chartInterval",
        "compatibilitySwitchoverMs",
        "engineConfig",
        "engineSemantics",
        "historicalStateSemantics",
        "historyStartMs",
        "htfContextStartMs",
        "klineSource",
        "marketType",
        "partialPeriodPolicy",
        "schema",
        "symbol",
      ].sort()
    );
    expect(lineage).toMatchObject({
      schema: SCANNER_LINEAGE_SCHEMA,
      klineSource: SCANNER_KLINE_SOURCE,
      engineSemantics: NATIVE_ENGINE_SEMANTICS,
      historicalStateSemantics: NATIVE_HISTORICAL_STATE_SEMANTICS,
      htfContextStartMs: D(2025, 1, 6),
    });
    expect(lineageId).toBe(canonicalSha256(lineage));
    expect(lineageId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the same inputs always name the same lineage", () => {
    expect(idOf({})).toBe(lineageId);
    expect(buildScannerLineage(JSON.parse(JSON.stringify(LINEAGE_INPUT)) as ScannerLineageInput).lineageId).toBe(lineageId);
  });

  it.each<[string, Partial<ScannerLineageInput>]>([
    ["symbol", { symbol: "OTHERUSDT" }],
    ["historyStart", { historyStartMs: HISTORY + FIFTEEN_MINUTES_MS }],
    ["switchover", { compatibilitySwitchoverMs: S + FIFTEEN_MINUTES_MS }],
    ["bootstrap input SHA", { bootstrapInputSha256: "b".repeat(64) }],
    ["minMovePct", { engineConfig: config({ enabledSourceTfs: ["1D", "1W"], minMovePct: 0.0701 }) }],
    ["touchTolerancePct", { engineConfig: config({ enabledSourceTfs: ["1D", "1W"], touchTolerancePct: 0.011 }) }],
    ["touchCooldownBars", { engineConfig: config({ enabledSourceTfs: ["1D", "1W"], touchCooldownBars: 11 }) }],
    ["minBarsAfterCreation", { engineConfig: config({ enabledSourceTfs: ["1D", "1W"], minBarsAfterCreation: 6 }) }],
    ["minBarsAfterArming", { engineConfig: config({ enabledSourceTfs: ["1D", "1W"], minBarsAfterArming: 5 }) }],
    ["maxLevels", { engineConfig: config({ enabledSourceTfs: ["1D", "1W"], maxLevels: 499 }) }],
    ["enabled source timeframes", { engineConfig: config({ enabledSourceTfs: ["1D"] }) }],
    ["retestEnabled", { engineConfig: config({ enabledSourceTfs: ["1D", "1W"], retestEnabled: false }) }],
    ["timing", { engineConfig: config({ enabledSourceTfs: ["1D", "1W"], timing: "Bar Close" }) }],
    ["calendar week start", { engineConfig: config({ enabledSourceTfs: ["1D", "1W"], calendar: { weekStartsOnUtcDay: 0, multiMonthAnchorMonth: 0 } }) }],
    ["calendar multi-month anchor", { engineConfig: config({ enabledSourceTfs: ["1D", "1W"], calendar: { weekStartsOnUtcDay: 1, multiMonthAnchorMonth: 1 } }) }],
  ])("changing %s changes the lineage ID", (_label, overrides) => {
    expect(idOf(overrides)).not.toBe(lineageId);
  });

  it("listing the same timeframes in another order is the SAME canonical config, so the same lineage", () => {
    // Pine registers in canonical order whatever order the inputs are listed in.
    expect(idOf({ engineConfig: config({ enabledSourceTfs: ["1W", "1D"] }) })).toBe(lineageId);
  });

  it("the partial-period policy and the fixed semantics versions are part of the hashed object and cannot be swapped", () => {
    expect(canonicalJson(lineage)).toContain(`"partialPeriodPolicy":"${SWITCHOVER_TRUNCATED_CLOSED_BARS}"`);
    for (const tampered of [
      { ...lineage, partialPeriodPolicy: "USE_FUTURE" },
      { ...lineage, engineSemantics: "other" },
      { ...lineage, historicalStateSemantics: "other" },
      { ...lineage, klineSource: "other" },
      { ...lineage, htfContextStartMs: lineage.htfContextStartMs + FIFTEEN_MINUTES_MS },
    ]) {
      expect(codeOf(() => scannerLineageId(tampered as ScannerLineage))).toBe("INVALID_LINEAGE");
    }
    expect(codeOf(() => buildScannerLineage({ ...LINEAGE_INPUT, partialPeriodPolicy: "USE_FUTURE" as typeof SWITCHOVER_TRUNCATED_CLOSED_BARS }))).toBe(
      "INVALID_LINEAGE"
    );
  });

  it("run metadata cannot enter the lineage: an extra field is refused, not hashed", () => {
    for (const extra of [{ createdAt: "2026-10-01T00:00:00.000Z" }, { gitHead: "deadbeef" }, { outputFile: "x.jsonl" }]) {
      expect(codeOf(() => scannerLineageId({ ...lineage, ...extra } as ScannerLineage))).toBe("INVALID_LINEAGE");
    }
  });

  it("a stored lineage that no longer hashes to its stored ID is a different lineage", () => {
    expect(() => verifyScannerLineage(lineage, lineageId)).not.toThrow();
    expect(() => verifyScannerLineage(lineage, "0".repeat(64))).toThrow(ScannerLineageError);
    expect(codeOf(() => verifyScannerLineage(lineage, "0".repeat(64)))).toBe("LINEAGE_MISMATCH");
  });
});

// ===========================================================================
// HTF context range
// ===========================================================================

describe("HTF context start", () => {
  const calendar = { weekStartsOnUtcDay: 1, multiMonthAnchorMonth: 0 };
  const history = D(2024, 5, 15, 6); // Wednesday 2024-05-15 06:00

  it.each([
    [["1D"], D(2024, 5, 15)],
    [["1W"], D(2024, 5, 13)],
    [["1M"], D(2024, 5, 1)],
    [["3M"], D(2024, 4, 1)],
    [["6M"], D(2024, 1, 1)],
    [["12M"], D(2024, 1, 1)],
    [["1D", "1W", "1M"], D(2024, 5, 1)],
    [["1D", "1W", "1M", "3M", "6M", "12M"], D(2024, 1, 1)],
  ] as const)("%j -> the earliest period start containing historyStart", (tfs, expected) => {
    expect(deriveHtfContextStartMs(history, tfs, calendar)).toBe(expected);
  });

  it("follows the calendar: a February-anchored quarter and a Sunday week", () => {
    expect(deriveHtfContextStartMs(history, ["3M"], { weekStartsOnUtcDay: 1, multiMonthAnchorMonth: 1 })).toBe(D(2024, 5, 1));
    expect(deriveHtfContextStartMs(history, ["1W"], { weekStartsOnUtcDay: 0, multiMonthAnchorMonth: 0 })).toBe(D(2024, 5, 12));
  });

  it("a history starting exactly on every enabled period start needs no context", () => {
    expect(deriveHtfContextStartMs(D(2024, 1, 1), ["1D", "1W", "1M", "3M", "6M", "12M"], calendar)).toBe(D(2024, 1, 1));
  });
});

// ===========================================================================
// Range refusals
// ===========================================================================

describe("compatibility replay refuses what it cannot reconstruct honestly", () => {
  it("missing context bars: INSUFFICIENT_HTF_CONTEXT, never an invented HTF open", () => {
    const withoutContext = BARS.filter((k) => k.openTimeMs >= HISTORY);
    expect(codeOf(() => runCompatibilityReplay(withoutContext, request()))).toBe("INSUFFICIENT_HTF_CONTEXT");
  });

  it("a gap inside the context, the history or the causal range is refused", () => {
    const drop = (at: number) => BARS.filter((k) => k.openTimeMs !== at);
    expect(codeOf(() => runCompatibilityReplay(drop(DATA_START + 10 * FIFTEEN_MINUTES_MS), request()))).toBe("INSUFFICIENT_HTF_CONTEXT");
    expect(codeOf(() => runCompatibilityReplay(drop(HISTORY + 10 * FIFTEEN_MINUTES_MS), request()))).toBe("INCOMPLETE_DATA");
    expect(codeOf(() => runCompatibilityReplay(drop(S + 10 * FIFTEEN_MINUTES_MS), request()))).toBe("INCOMPLETE_DATA");
  });

  it("refuses unordered or unaligned ranges", () => {
    for (const bad of [
      request({ switchoverMs: HISTORY }),
      request({ endMs: S }),
      request({ switchoverMs: S + 60_000 }),
      request({ historyStartMs: HISTORY + 1 }),
    ]) {
      expect(codeOf(() => compatReplayRanges(bad))).toBe("INVALID_RANGE");
    }
  });
});

// ===========================================================================
// Pipeline
// ===========================================================================

describe("compatibility replay pipeline", () => {
  const bars = selectCompatReplayBars(BARS, request());
  const historical = reconstructPineHistoricalState({
    config: ENGINE,
    historyStartMs: HISTORY,
    switchoverMs: S,
    contextBars: bars.contextBars,
    bars: bars.historyBars,
    partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
  });

  it("splits [context, history, causal] exactly at htfContextStart, historyStart and the switchover", () => {
    expect(bars.contextBars[0].openTimeMs).toBe(DATA_START);
    expect(bars.contextBars[bars.contextBars.length - 1].openTimeMs).toBe(HISTORY - FIFTEEN_MINUTES_MS);
    expect(bars.historyBars[0].openTimeMs).toBe(HISTORY);
    expect(bars.historyBars[bars.historyBars.length - 1].openTimeMs).toBe(S - FIFTEEN_MINUTES_MS);
    expect(bars.causalBars[0].openTimeMs).toBe(S);
    expect(BASE.input).toMatchObject({ contextBarCount: 192, historyBarCount: (S - HISTORY) / FIFTEEN_MINUTES_MS, causalBarCount: (END - S) / FIFTEEN_MINUTES_MS });
  });

  it("hashes the immutable bootstrap bytes, the causal bytes and the whole replayed input separately", () => {
    expect(BASE.input.bootstrapInputSha256).toBe(sha256Hex(serializeKlines([...bars.contextBars, ...bars.historyBars])));
    expect(BASE.input.causalInputSha256).toBe(sha256Hex(serializeKlines(bars.causalBars)));
    expect(BASE.input.replayedInputSha256).toBe(sha256Hex(serializeKlines([...bars.contextBars, ...bars.historyBars, ...bars.causalBars])));
    expect(BASE.lineage.bootstrapInputSha256).toBe(BASE.input.bootstrapInputSha256);
  });

  it("the state at the switchover is the Slice 2B-1 historical reconstruction — not a causal warmup", () => {
    expect(BASE.bootstrap.stateSha256AtSwitchover).toBe(engineStateSha256(historical.state));
    expect(BASE.bootstrap).toMatchObject({
      registrationCount: historical.report.registrations.length,
      liveLevelCount: historical.state.levels.length,
      evictionCount: historical.report.evictions.length,
      historicalTouchWriteCount: historical.report.touches.length,
    });
    // The fixture is non-trivial: history registers levels and writes cooldowns.
    expect(BASE.bootstrap.registrationCount).toBeGreaterThanOrEqual(3);
    expect(BASE.bootstrap.historicalTouchWriteCount).toBeGreaterThan(0);
  });

  it("the causal phase is the approved engine stepping from that state, bar by bar, from S", () => {
    let state = historical.state;
    const expected: NativeCandidate[] = [];
    for (const bar of bars.causalBars) {
      const step = stepNativeEngineWithImmediate(state, bar);
      expected.push(...step.immediateCandidates, ...step.candidates);
      state = step.state;
    }
    expect(BASE.causal.stateSha256AtEnd).toBe(engineStateSha256(state));
    const key = (c: { chartBarOpenTimeMs: number; basis: string; level: { id: number } }) => `${c.chartBarOpenTimeMs}|${c.basis}|${c.level.id}`;
    expect(BASE.records.map(key).sort()).toEqual(expected.map(key).sort());
    expect(BASE.records.length).toBeGreaterThan(5);
  });

  it("every record is causal-replay evidence: actionable false, lineage-stamped, at or after S", () => {
    for (const record of BASE.records) {
      expect(record).toMatchObject({ phase: "CAUSAL_REPLAY", actionable: false, lineageId: BASE.lineageId, symbol: "TESTUSDT" });
      expect(record.chartBarOpenTimeMs).toBeGreaterThanOrEqual(S);
      expect(["IMMEDIATE_INTRABAR", "COMMITTED_BAR_CLOSE"]).toContain(record.basis);
      expect(record.levelKey).toBe(`${record.sourceTf}:${record.level.condition}:${record.level.createdBarOpenTimeMs}`);
      expect(record.proof === null).toBe(record.basis === "COMMITTED_BAR_CLOSE");
    }
    expect(new Set(BASE.records.map((r) => r.levelOrigin))).toContain("HISTORICAL_BOOTSTRAP");
  });

  it("no historical bootstrap touch is serialized as a record", () => {
    expect(BASE.jsonl).not.toContain("HISTORICAL_STATE_WRITE");
    expect(BASE.jsonl.split("\n").filter(Boolean).every((line) => JSON.parse(line).actionable === false)).toBe(true);
    expect(BASE.jsonl).toBe(BASE.records.map((r) => `${canonicalJson(r)}\n`).join(""));
  });

  it("orders records by bar, then intrabar before close, then oldest level", () => {
    const order = BASE.records.map((r) => [r.chartBarOpenTimeMs, r.basis === "IMMEDIATE_INTRABAR" ? 0 : 1, r.level.id]);
    const sorted = [...order].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    expect(order).toEqual(sorted);
  });
});

// ===========================================================================
// Determinism and the hash model (Part 8)
// ===========================================================================

describe("determinism and hash model", () => {
  const swap = (bars: NativeKline[], at: number, close: number) =>
    bars.map((k) => (k.openTimeMs === at ? { ...k, close: Math.min(k.high, Math.max(k.low, close)) } : k));

  it("1-3. same lineage inputs and bytes -> same lineageId, stateHash(S), output and final state", () => {
    const again = runCompatibilityReplay(JSON.parse(JSON.stringify(BARS)) as NativeKline[], request());
    expect(again.lineageId).toBe(BASE.lineageId);
    expect(again.bootstrap.stateSha256AtSwitchover).toBe(BASE.bootstrap.stateSha256AtSwitchover);
    expect(again.outputSha256).toBe(BASE.outputSha256);
    expect(again.causal.stateSha256AtEnd).toBe(BASE.causal.stateSha256AtEnd);
    expect(again.jsonl).toBe(BASE.jsonl);
  });

  it("6. moving the switchover one bar -> a different lineage", () => {
    expect(runCompatibilityReplay(BARS, request({ switchoverMs: S + FIFTEEN_MINUTES_MS })).lineageId).not.toBe(BASE.lineageId);
  });

  it("7. moving historyStart one bar -> a different lineage", () => {
    expect(runCompatibilityReplay(BARS, request({ historyStartMs: HISTORY + FIFTEEN_MINUTES_MS })).lineageId).not.toBe(BASE.lineageId);
  });

  it("8. one changed bootstrap byte -> new bootstrap input SHA -> new lineage", () => {
    const at = S - 20 * FIFTEEN_MINUTES_MS;
    const original = BARS.find((k) => k.openTimeMs === at)!;
    const r = runCompatibilityReplay(swap(BARS, at, original.close === original.high ? original.low : original.high), request());
    expect(r.input.bootstrapInputSha256).not.toBe(BASE.input.bootstrapInputSha256);
    expect(r.lineageId).not.toBe(BASE.lineageId);
  });

  it("9. one changed causal byte after S -> same immutable lineage and stateHash(S); new causal input SHA and final state", () => {
    const at = END - FIFTEEN_MINUTES_MS;
    const original = BARS.find((k) => k.openTimeMs === at)!;
    const r = runCompatibilityReplay(swap(BARS, at, original.close === original.high ? original.low : original.high), request());
    expect(r.lineageId).toBe(BASE.lineageId);
    expect(r.input.bootstrapInputSha256).toBe(BASE.input.bootstrapInputSha256);
    expect(r.bootstrap.stateSha256AtSwitchover).toBe(BASE.bootstrap.stateSha256AtSwitchover);
    expect(r.input.causalInputSha256).not.toBe(BASE.input.causalInputSha256);
    expect(r.causal.stateSha256AtEnd).not.toBe(BASE.causal.stateSha256AtEnd);
  });

  it("causal evidence can extend: a later end keeps the lineage and stateHash(S), and the shorter run's records are a prefix", () => {
    const shorter = runCompatibilityReplay(BARS, request({ endMs: END - 96 * FIFTEEN_MINUTES_MS }));
    expect(shorter.lineageId).toBe(BASE.lineageId);
    expect(shorter.bootstrap.stateSha256AtSwitchover).toBe(BASE.bootstrap.stateSha256AtSwitchover);
    expect(BASE.jsonl.startsWith(shorter.jsonl)).toBe(true);
  });
});

// ===========================================================================
// Manifest v2 and the runner (cache-only by default)
// ===========================================================================

describe("manifest v2 and runner", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "compat-replay-test-"));
    dirs.push(dir);
    return dir;
  };
  const deps = (cache: KlineCacheStore, outputDir: string, nowIso: string, fetchRange: ((r: ClosedKlineRangeRequest) => Promise<{ klines: NativeKline[]; requestsMade: number }>) | null) => ({
    cache,
    fetchRange: fetchRange as never,
    outputDir,
    nowIso: () => nowIso,
    gitHead: `head-${nowIso}`,
    gitWorktreeClean: true,
    maxBars: 10_000,
    pageLimit: 1000,
    settleMs: 5000,
  });
  const withoutProvenance = (manifest: Record<string, unknown>) => {
    const { provenance: _p, output, ...rest } = manifest as { provenance: unknown; output: { file: string } } & Record<string, unknown>;
    return { ...rest, output: { ...output, file: null } };
  };

  it("builds manifest v2 with identity, inputs, bootstrap, causal replay, output, provenance and the evidence note", () => {
    const manifest = buildCompatReplayManifest(BASE, { createdAt: "2026-10-01T00:00:00.000Z", gitHead: "abc", gitWorktreeClean: true, cacheSha256: "c".repeat(64), cacheRowCount: BARS.length, outputFile: "f.jsonl" });
    expect(manifest.schema).toBe(COMPAT_MANIFEST_SCHEMA);
    expect(manifest.identity).toEqual({ lineageId: BASE.lineageId, lineage: BASE.lineage });
    expect(manifest.input).toMatchObject({ htfContextStart: new Date(DATA_START).toISOString(), historyStart: new Date(HISTORY).toISOString(), compatibilitySwitchover: new Date(S).toISOString(), replayEnd: new Date(END).toISOString() });
    expect(manifest.output).toEqual({ file: "f.jsonl", rowCount: BASE.records.length, sha256: BASE.outputSha256 });
    expect(manifest.provenance).toEqual({ createdAt: "2026-10-01T00:00:00.000Z", gitHead: "abc", gitWorktreeClean: true });
    expect(manifest.evidenceNote).toBe(COMPAT_EVIDENCE_NOTE);
    expect(COMPAT_EVIDENCE_NOTE).toBe("No replay record is a delivered TradingView alert and no replay record is actionable.");
  });

  it("cache-only by default: an incomplete cache is refused and nothing is fetched", async () => {
    const cache = new KlineCacheStore(tempDir());
    cache.save("USDM_PERPETUAL", "TESTUSDT", "15m", BARS.filter((k) => k.openTimeMs >= HISTORY), "2026-10-01T00:00:00.000Z");
    await expect(executeCompatibilityReplay(request(), deps(cache, tempDir(), "2026-10-01T00:00:00.000Z", null))).rejects.toMatchObject({
      code: "INSUFFICIENT_HTF_CONTEXT",
    });
  });

  it("with an explicit fetcher, fetches from htfContextStart (never later), caches, and replays the verified cache", async () => {
    const cache = new KlineCacheStore(tempDir());
    const calls: ClosedKlineRangeRequest[] = [];
    const fetcher = async (r: ClosedKlineRangeRequest) => {
      calls.push(r);
      return { klines: BARS.filter((k) => k.openTimeMs >= r.startMs && k.openTimeMs < r.endMs), requestsMade: 2 };
    };
    const outcome = await executeCompatibilityReplay(request(), deps(cache, tempDir(), "2026-10-01T00:00:00.000Z", fetcher));
    expect(calls.map((c) => [c.startMs, c.endMs])).toEqual([[DATA_START, END]]);
    expect(outcome.fetched).toEqual({ requestsMade: 2, rows: BARS.length });
    expect(outcome.manifest.output.sha256).toBe(BASE.outputSha256);
  });

  it("4-5. a different wall clock and git head change only provenance and file names; never the lineage, hashes or bytes", async () => {
    const cache = new KlineCacheStore(tempDir());
    cache.save("USDM_PERPETUAL", "TESTUSDT", "15m", BARS, "2026-10-01T00:00:00.000Z");
    const out = tempDir();
    const a = await executeCompatibilityReplay(request(), deps(cache, out, "2026-10-01T00:00:00.000Z", null));
    const b = await executeCompatibilityReplay(request(), deps(cache, out, "2027-03-04T05:06:07.890Z", null));
    expect(a.outputPath).not.toBe(b.outputPath);
    expect(withoutProvenance(a.manifest)).toEqual(withoutProvenance(b.manifest));
    expect(a.manifest.identity.lineageId).toBe(BASE.lineageId);
    expect(readFileSync(a.outputPath, "utf8")).toBe(readFileSync(b.outputPath, "utf8"));
    expect(sha256Hex(readFileSync(b.outputPath, "utf8"))).toBe(b.manifest.output.sha256);
    expect(readFileSync(a.outputPath, "utf8")).not.toContain("2026-10-01T00:00:00.000Z");
    // Never overwrites: the same clock again collides on the file name and is refused.
    await expect(executeCompatibilityReplay(request(), deps(cache, out, "2026-10-01T00:00:00.000Z", null))).rejects.toThrow();
  });
});

// ===========================================================================
// CLI contract, and the old causal replay left exactly as it was
// ===========================================================================

const CLI = [
  "--symbol", "LDOUSDT", "--interval", "15m",
  "--history-start", "2026-01-01T00:00:00Z", "--switchover", "2026-09-12T01:00:00Z", "--end", "2026-09-15T22:00:00Z",
  "--min-move-percent", "7", "--touch-tolerance-percent", "1",
  "--cooldown-bars", "10", "--min-bars-after-creation", "5", "--min-bars-after-arming", "4",
  "--source-timeframes", "1D,1W,1M,3M,6M,12M", "--max-levels", "500", "--timing", "Immediate",
  "--partial-period-policy", SWITCHOVER_TRUNCATED_CLOSED_BARS,
];

describe("scanner:compat-replay CLI contract", () => {
  it("parses one explicit lineage, cache-only unless --fetch is given", () => {
    const options = parseCompatReplayCliArgs(CLI);
    expect(options.fetch).toBe(false);
    expect(options.request).toMatchObject({ symbol: "LDOUSDT", historyStartMs: D(2026, 1, 1), switchoverMs: D(2026, 9, 12, 1), endMs: D(2026, 9, 15, 22) });
    expect(options.request.engine.minMovePct).toBe(0.07);
    // The fetch ceiling counts the context bars too: from 2025-12-29 (the week containing 2026-01-01).
    expect(options.maxBars).toBe((D(2026, 9, 15, 22) - D(2025, 12, 29)) / FIFTEEN_MINUTES_MS);
    expect(parseCompatReplayCliArgs([...CLI, "--fetch"]).fetch).toBe(true);
  });

  it("refuses missing, duplicated or unapproved inputs", () => {
    const without = (flag: string) => {
      const i = CLI.indexOf(flag);
      return [...CLI.slice(0, i), ...CLI.slice(i + 2)];
    };
    for (const argv of [
      without("--partial-period-policy"),
      without("--switchover"),
      [...CLI.slice(0, -1), "USE_FUTURE"],
      [...CLI, "--symbol", "BTCUSDT"],
      [...CLI, "--warmup-start", "2026-01-01T00:00:00Z"],
      [...CLI, "--fetch", "--fetch"],
    ]) {
      expect(() => parseCompatReplayCliArgs(argv)).toThrow(CompatReplayCliUsageError);
    }
  });

  it("the old scanner:replay parser is unchanged and does not accept compatibility inputs", () => {
    expect(() => parseReplayCliArgs(CLI)).toThrow(ReplayCliUsageError);
    // A complete, valid causal-replay command...
    const oldValid = [
      "--symbol", "LDOUSDT", "--interval", "15m",
      "--warmup-start", "2026-06-01T00:00:00Z", "--output-start", "2026-09-12T01:00:00Z", "--end", "2026-09-15T22:00:00Z",
      "--min-move-percent", "7", "--touch-tolerance-percent", "1",
      "--cooldown-bars", "10", "--min-bars-after-creation", "5", "--min-bars-after-arming", "4",
      "--source-timeframes", "1D,1W,1M,3M,6M,12M", "--max-levels", "500", "--timing", "Immediate",
    ];
    expect(parseReplayCliArgs(oldValid).request.warmupStartMs).toBe(D(2026, 6, 1));
    // ...must REFUSE any compatibility-only input rather than silently ignore it,
    // so nobody can believe they ran a compatibility replay with the causal tool.
    for (const extra of [
      ["--history-start", "2026-01-01T00:00:00Z"],
      ["--switchover", "2026-09-12T01:00:00Z"],
      ["--partial-period-policy", SWITCHOVER_TRUNCATED_CLOSED_BARS],
    ]) {
      expect(() => parseReplayCliArgs([...oldValid, ...extra])).toThrow(ReplayCliUsageError);
    }
  });

  it("the old causal replay keeps its own record schema and carries no lineage or actionability field", () => {
    const old = runHistoricalReplay(BARS.filter((k) => k.openTimeMs >= HISTORY), {
      symbol: "TESTUSDT",
      marketType: "USDM_PERPETUAL",
      chartInterval: "15m",
      warmupStartMs: HISTORY,
      outputStartMs: S,
      endMs: END,
      engine: ENGINE,
    });
    expect(old.records.length).toBeGreaterThan(0);
    for (const record of old.records) {
      expect(record.schema).toBe(REPLAY_RECORD_SCHEMA);
      expect(Object.keys(record)).not.toContain("lineageId");
      expect(Object.keys(record)).not.toContain("actionable");
      expect(Object.keys(record)).not.toContain("phase");
    }
    // A causal warmup and the compatibility bootstrap are different experiments.
    expect(old.outputSha256).not.toBe(BASE.outputSha256);
  });
});
