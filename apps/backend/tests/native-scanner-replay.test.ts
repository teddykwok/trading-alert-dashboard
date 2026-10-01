import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNativeEngineConfig, type NativeCandidate, type NativeKline } from "@trading-alert-dashboard/shared";

import { ScannerDataError } from "../src/modules/native-scanner/binance-public-futures";
import { KlineCacheStore } from "../src/modules/native-scanner/kline-cache";
import { CONSERVATIVE_REQUEST_POLICY, fetchClosedFuturesKlines } from "../src/modules/native-scanner/kline-fetcher";
import {
  assertReplayRequest,
  buildReplayManifest,
  classifyCandidate,
  runHistoricalReplay,
  type HistoricalReplayRequest,
} from "../src/modules/native-scanner/historical-replay";
import { executeHistoricalReplay } from "../src/modules/native-scanner/historical-replay-runner";
import {
  MAX_REPLAY_BARS,
  ReplayCliUsageError,
  parseReplayCliArgs,
  parseUtcInstant,
} from "../src/modules/native-scanner/replay-cli-args";
import { ScannerPathError, assertOutsideRepository, scannerRootDir } from "../src/modules/native-scanner/scanner-paths";
import { FIFTEEN_MINUTES_MS as I, fakeBinance, fifteenMinute, forbidRealNetwork, manualClock } from "./helpers/native-scanner-fakes";
import { doji, repeat, type Ohlc } from "./helpers/native-signal-fixtures";

/**
 * Slice 2A — historical replay: warmup vs output, evidence classes, the
 * manifest, the CLI contract and the runner. No real network; files only in a
 * private temporary directory.
 */

let restoreNetwork: () => void;
let root: string;
beforeAll(() => {
  restoreNetwork = forbidRealNetwork();
  root = mkdtempSync(path.join(tmpdir(), "native-scanner-replay-"));
});
afterAll(() => {
  restoreNetwork();
  rmSync(root, { recursive: true, force: true });
});

const DAY = 96; // 15m bars per day
const WEDNESDAY = Date.UTC(2024, 0, 3);

/**
 * Three days of 15m bars from Wednesday 2024-01-03, 1D source only.
 *
 *   day 1  bar 40 spikes to 107.5 and closes red: 1D GREEN @ 107.5 (GOR).
 *   day 2  rally arms it (bar 118); bar 128 retests it        -> WARMUP evidence
 *   day 3  (output window)
 *          bar 200 retests and holds                          -> IMMEDIATE (proven) + COMMITTED
 *          bar 220 touches and closes through (low < close)   -> IMMEDIATE only, PROVEN_INTRABAR_POSSIBLE
 *          bar 240 re-arms; bar 245 closes through AT ITS LOW -> IMMEDIATE only, POSSIBLE_ONLY
 */
function mainFixture(): NativeKline[] {
  const rows: Ohlc[] = [];
  for (let i = 0; i < DAY; i += 1) rows.push(i < 40 ? doji(100) : i === 40 ? [100, 107.5, 99.5, 99.8] : doji(99.8));
  rows.push(doji(99.8)); // bar 96
  let price = 99.8;
  for (let step = 1; step <= 23; step += 1) {
    const next = Math.round((99.8 + step * 0.4) * 100) / 100;
    rows.push([price, next, price, next]); // bars 97..119 (108.6 on bar 118 arms)
    price = next;
  }
  rows.push(...repeat(doji(109), 8)); // 120..127
  rows.push([109, 109, 108.2, 108.8]); // 128: warmup retest
  while (rows.length < 2 * DAY) rows.push(doji(109)); // ..191
  while (rows.length < 200) rows.push(doji(109)); // 192..199
  rows.push([109, 109, 108.2, 108.8]); // 200
  while (rows.length < 220) rows.push(doji(109)); // 201..219
  rows.push([109, 109, 105, 106]); // 220: through 107.5*(0.99), low < close
  while (rows.length < 240) rows.push(doji(106)); // 221..239
  rows.push(doji(109)); // 240: re-arms
  while (rows.length < 245) rows.push(doji(109)); // 241..244
  rows.push([109, 109, 106, 106]); // 245: through, closing at its low
  while (rows.length < 3 * DAY) rows.push(doji(106)); // ..287
  return fifteenMinute(WEDNESDAY, rows);
}

const MAIN = mainFixture();
const bar = (index: number) => WEDNESDAY + index * I;

function engine(overrides: Partial<Parameters<typeof createNativeEngineConfig>[0]> = {}) {
  return createNativeEngineConfig({
    minMovePct: 0.07,
    touchTolerancePct: 0.01,
    touchCooldownBars: 10,
    minBarsAfterCreation: 5,
    minBarsAfterArming: 4,
    maxLevels: 500,
    enabledSourceTfs: ["1D"],
    timing: "Immediate",
    ...overrides,
  });
}

function request(overrides: Partial<HistoricalReplayRequest> = {}): HistoricalReplayRequest {
  return {
    symbol: "TESTUSDT",
    marketType: "USDM_PERPETUAL",
    chartInterval: "15m",
    warmupStartMs: bar(0),
    outputStartMs: bar(2 * DAY),
    endMs: bar(3 * DAY),
    engine: engine(),
    ...overrides,
  };
}

const summary = (r: ReturnType<typeof runHistoricalReplay>) =>
  r.records.map((x) => [x.chartBarIndexFromWarmup, x.basis, x.evidenceClass]);

// ===========================================================================
// 27-28. Warmup builds state; only the output window is recorded
// ===========================================================================

describe("warmup and output window", () => {
  const result = runHistoricalReplay(MAIN, request());

  it("records the three kinds of evidence in the output window, in order", () => {
    expect(summary(result)).toEqual([
      [200, "IMMEDIATE_INTRABAR", "PROVEN_INTRABAR_POSSIBLE"],
      [200, "COMMITTED_BAR_CLOSE", "COMMITTED_BAR_CLOSE"],
      [220, "IMMEDIATE_INTRABAR", "PROVEN_INTRABAR_POSSIBLE"],
      [245, "IMMEDIATE_INTRABAR", "POSSIBLE_ONLY"],
    ]);
  });

  // 27.
  it("excludes warmup candidates from the output, and counts what it excluded", () => {
    expect(result.records.every((r) => r.chartBarOpenTimeMs >= bar(2 * DAY))).toBe(true);
    expect(result.warmupExcluded).toEqual({ IMMEDIATE_INTRABAR: 1, COMMITTED_BAR_CLOSE: 1 });
  });

  it("a candidate ON the output-start bar is recorded; one bar later it is warmup", () => {
    const onBoundary = runHistoricalReplay(MAIN, request({ outputStartMs: bar(200) }));
    expect(onBoundary.records.slice(0, 2).map((r) => [r.chartBarIndexFromWarmup, r.basis])).toEqual([
      [200, "IMMEDIATE_INTRABAR"],
      [200, "COMMITTED_BAR_CLOSE"],
    ]);
    const after = runHistoricalReplay(MAIN, request({ outputStartMs: bar(201) }));
    expect(after.records.map((r) => r.chartBarIndexFromWarmup)).toEqual([220, 245]);
    expect(after.warmupExcluded).toEqual({ IMMEDIATE_INTRABAR: 2, COMMITTED_BAR_CLOSE: 2 });
  });

  // 28.
  it("keeps warmup STATE: the output candidates come from a level created during warmup", () => {
    expect(new Set(result.records.map((r) => r.levelKey))).toEqual(new Set([`1D:GOR:${bar(40)}`]));
    const noWarmup = runHistoricalReplay(MAIN, request({ warmupStartMs: bar(2 * DAY) }));
    expect(noWarmup.records).toEqual([]);
  });

  // 29.
  it.each([
    ["no warmup anchor", { warmupStartMs: undefined as unknown as number }],
    ["a non-numeric warmup anchor", { warmupStartMs: Number.NaN }],
    ["warmup after the output start", { warmupStartMs: bar(2 * DAY) + I }],
    ["an unaligned warmup anchor", { warmupStartMs: bar(0) + 60_000 }],
    ["output start at the end", { outputStartMs: bar(3 * DAY) }],
    ["another market", { marketType: "SPOT" as never }],
  ])("refuses %s", (_label, patch) => {
    expect(() => assertReplayRequest(request(patch))).toThrow(ScannerDataError);
  });

  it("refuses data with a gap or a late start instead of replaying around it", () => {
    expect(() => runHistoricalReplay([...MAIN.slice(0, 100), ...MAIN.slice(101)], request())).toThrow(/every 15m bar/);
    expect(() => runHistoricalReplay(MAIN.slice(1), request())).toThrow(/every 15m bar/);
  });
});

// ===========================================================================
// 30-32. Determinism, ordering, manifest
// ===========================================================================

describe("determinism and ordering", () => {
  // 30.
  it("the same bars and config produce byte-identical output", () => {
    const a = runHistoricalReplay(MAIN, request());
    const b = runHistoricalReplay([...MAIN], request({ engine: engine() }));
    expect(b.jsonl).toBe(a.jsonl);
    expect(b.outputSha256).toBe(a.outputSha256);
  });

  // 31.
  it("orders by bar, then intrabar before close, then oldest level", () => {
    // Monday 2024-01-01: six levels register on one bar, then are retested together.
    const rows: Ohlc[] = [...repeat(doji(100), 40), [100, 120, 99, 99], [99, 125, 99, 125], ...repeat(doji(125), 4), doji(122, 122, 120)];
    while (rows.length < DAY) rows.push(doji(122));
    const monday = Date.UTC(2024, 0, 1);
    const result = runHistoricalReplay(fifteenMinute(monday, rows), {
      ...request({ engine: engine({ enabledSourceTfs: ["1D", "1W", "1M", "3M", "6M", "12M"] }) }),
      warmupStartMs: monday,
      outputStartMs: monday,
      endMs: monday + DAY * I,
    });
    expect(result.records.map((r) => [r.chartBarIndexFromWarmup, r.basis, r.level.id, r.sourceTf])).toEqual([
      ...["1D", "1W", "1M", "3M", "6M", "12M"].map((tf, id) => [46, "IMMEDIATE_INTRABAR", id, tf]),
      ...["1D", "1W", "1M", "3M", "6M", "12M"].map((tf, id) => [46, "COMMITTED_BAR_CLOSE", id, tf]),
    ]);
    expect(result.incompleteAtWarmupStart).toEqual([]);
  });

  // 32.
  it("builds a manifest whose fields are fully determined by input, except createdAt", () => {
    const result = runHistoricalReplay(MAIN, request());
    const meta = { gitHead: "abc123", gitWorktreeClean: true, cacheSha256: "c".repeat(64), cacheRowCount: 999, outputFile: "x.jsonl" };
    const first = buildReplayManifest(request(), result, { ...meta, createdAt: "2026-10-01T00:00:00.000Z" });
    const second = buildReplayManifest(request(), runHistoricalReplay(MAIN, request()), { ...meta, createdAt: "2027-01-01T00:00:00.000Z" });
    expect({ ...first, createdAt: null }).toEqual({ ...second, createdAt: null });
    expect(first).toMatchObject({
      schema: "teddy.native-replay.manifest.v1",
      replayVersion: "teddy-native-replay/1",
      gitHead: "abc123",
      symbol: "TESTUSDT",
      marketType: "USDM_PERPETUAL",
      chartInterval: "15m",
      warmupStart: "2024-01-03T00:00:00.000Z",
      outputStart: "2024-01-05T00:00:00.000Z",
      end: "2024-01-06T00:00:00.000Z",
      incompleteAtWarmupStart: [],
      engineConfigSha256: result.engineConfigSha256,
      input: { cacheSha256: "c".repeat(64), cacheRowCount: 999, replayBarCount: 288 },
      output: { file: "x.jsonl", rowCount: 4, sha256: result.outputSha256 },
      counts: {
        byBasis: { IMMEDIATE_INTRABAR: 3, COMMITTED_BAR_CLOSE: 1 },
        immediateByClass: { PROVEN_INTRABAR_POSSIBLE: 2, POSSIBLE_ONLY: 1 },
      },
      warmupCandidatesExcluded: { IMMEDIATE_INTRABAR: 1, COMMITTED_BAR_CLOSE: 1 },
    });
    expect(first.engineConfig).toEqual(request().engine);
  });

  it("names every source timeframe whose period began before the warmup anchor", () => {
    const all = runHistoricalReplay(MAIN, request({ engine: engine({ enabledSourceTfs: ["1D", "1W", "1M", "3M", "6M", "12M"] }) }));
    expect(all.incompleteAtWarmupStart).toEqual(["1W", "1M", "3M", "6M", "12M"]);
  });
});

// ===========================================================================
// 33-36. Evidence classes
// ===========================================================================

describe("evidence classification", () => {
  const immediate = (bandEnteredBeforeClosingUpdate: boolean, levelPresentOnEveryUpdate: boolean) =>
    ({ basis: "IMMEDIATE_INTRABAR", proof: { bandEnteredBeforeClosingUpdate, levelPresentOnEveryUpdate } }) as NativeCandidate;

  // 33.
  it("both proofs true -> PROVEN_INTRABAR_POSSIBLE", () => {
    expect(classifyCandidate(immediate(true, true))).toBe("PROVEN_INTRABAR_POSSIBLE");
  });

  // 34.
  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])("entry proven=%s, presence proven=%s -> POSSIBLE_ONLY", (entry, presence) => {
    expect(classifyCandidate(immediate(entry, presence))).toBe("POSSIBLE_ONLY");
  });

  // 35.
  it("COMMITTED_BAR_CLOSE stays its own class, with no proof block", () => {
    expect(classifyCandidate({ basis: "COMMITTED_BAR_CLOSE" } as NativeCandidate)).toBe("COMMITTED_BAR_CLOSE");
    const committed = runHistoricalReplay(MAIN, request()).records.filter((r) => r.basis === "COMMITTED_BAR_CLOSE");
    expect(committed.map((r) => [r.evidenceClass, r.proof])).toEqual([["COMMITTED_BAR_CLOSE", null]]);
  });

  it("every immediate record carries the engine's proof flags verbatim, consistent with its class", () => {
    for (const record of runHistoricalReplay(MAIN, request()).records.filter((r) => r.basis === "IMMEDIATE_INTRABAR")) {
      const proven = record.proof!.bandEnteredBeforeClosingUpdate && record.proof!.levelPresentOnEveryUpdate;
      expect(record.evidenceClass).toBe(proven ? "PROVEN_INTRABAR_POSSIBLE" : "POSSIBLE_ONLY");
    }
  });

  // 36.
  it("nothing in the output or manifest claims a delivered TradingView alert", () => {
    const result = runHistoricalReplay(MAIN, request());
    const manifest = buildReplayManifest(request(), result, {
      createdAt: "x",
      gitHead: "x",
      gitWorktreeClean: true,
      cacheSha256: "x",
      cacheRowCount: 0,
      outputFile: "x",
    });
    for (const text of [result.jsonl, JSON.stringify(manifest)]) {
      expect(text).not.toMatch(/deliver/i);
      expect(text).not.toMatch(/tradingview/i);
    }
    expect(new Set(result.records.map((r) => r.evidenceClass))).toEqual(
      new Set(["COMMITTED_BAR_CLOSE", "PROVEN_INTRABAR_POSSIBLE", "POSSIBLE_ONLY"])
    );
  });
});

// ===========================================================================
// 37-39. The CLI contract
// ===========================================================================

const VALID_ARGS = [
  "--symbol", "BTCUSDT",
  "--interval", "15m",
  "--warmup-start", "2024-01-01T00:00:00Z",
  "--output-start", "2024-02-01T00:00:00Z",
  "--end", "2024-03-01T00:00:00Z",
  "--min-move-percent", "7",
  "--touch-tolerance-percent", "1",
  "--cooldown-bars", "10",
  "--min-bars-after-creation", "5",
  "--min-bars-after-arming", "4",
  "--source-timeframes", "1D,1W,1M,3M,6M,12M",
  "--max-levels", "500",
  "--timing", "Immediate",
];

function withArg(name: string, value: string | null): string[] {
  const args = [...VALID_ARGS];
  const at = args.indexOf(name);
  if (value === null) args.splice(at, 2);
  else args[at + 1] = value;
  return args;
}

function usageError(argv: string[]): string | null {
  try {
    parseReplayCliArgs(argv);
    return null;
  } catch (error) {
    if (error instanceof ReplayCliUsageError) return error.message;
    throw error;
  }
}

describe("CLI contract", () => {
  it("parses one complete, explicit configuration, cache-only unless --fetch is given", () => {
    const options = parseReplayCliArgs(VALID_ARGS);
    expect(options.fetch).toBe(false);
    expect(options.policy).toEqual(CONSERVATIVE_REQUEST_POLICY);
    expect(options.request).toMatchObject({
      symbol: "BTCUSDT",
      marketType: "USDM_PERPETUAL",
      chartInterval: "15m",
      warmupStartMs: Date.UTC(2024, 0, 1),
      outputStartMs: Date.UTC(2024, 1, 1),
      endMs: Date.UTC(2024, 2, 1),
    });
    expect(options.request.engine).toMatchObject({
      minMovePct: 0.07,
      touchTolerancePct: 0.01,
      touchCooldownBars: 10,
      minBarsAfterCreation: 5,
      minBarsAfterArming: 4,
      maxLevels: 500,
      timing: "Immediate",
      enabledSourceTfs: ["1D", "1W", "1M", "3M", "6M", "12M"],
    });
    expect(parseReplayCliArgs([...VALID_ARGS, "--fetch"]).fetch).toBe(true);
    expect(parseReplayCliArgs([...VALID_ARGS, "--max-requests", "60"]).policy.maxRequests).toBe(60);
  });

  // 29 (CLI side): every engine input and the warmup anchor are required.
  it.each([
    "--symbol",
    "--interval",
    "--warmup-start",
    "--output-start",
    "--end",
    "--min-move-percent",
    "--touch-tolerance-percent",
    "--cooldown-bars",
    "--min-bars-after-creation",
    "--min-bars-after-arming",
    "--source-timeframes",
    "--max-levels",
    "--timing",
  ])("has no default for %s", (name) => {
    expect(usageError(withArg(name, null))).toMatch(new RegExp(`missing required: .*${name}`));
  });

  // 37.
  it.each([
    ["a symbol list", withArg("--symbol", "BTCUSDT,ETHUSDT")],
    ["a second --symbol", [...VALID_ARGS, "--symbol", "ETHUSDT"]],
    ["a positional symbol", [...VALID_ARGS, "ETHUSDT"]],
    ["a universe flag", [...VALID_ARGS, "--all-symbols"]],
    ["a universe option", [...VALID_ARGS, "--universe", "top500"]],
  ])("refuses more than one symbol: %s", (_label, argv) => {
    expect(usageError(argv)).not.toBeNull();
  });

  // 38. / 39.
  it.each([
    ["a lowercase symbol", withArg("--symbol", "btcusdt")],
    ["a TradingView symbol", withArg("--symbol", "BINANCE:BTCUSDT.P")],
    ["a 1h chart", withArg("--interval", "1h")],
    ["a local time", withArg("--warmup-start", "2024-01-01T00:00:00")],
    ["a date without time", withArg("--warmup-start", "2024-01-01")],
    ["an impossible date", withArg("--end", "2024-02-30T00:00:00Z")],
    ["an unknown timing", withArg("--timing", "Later")],
    ["a percent sign", withArg("--min-move-percent", "7%")],
    ["an unknown timeframe", withArg("--source-timeframes", "1D,2D")],
    ["a budget above the ceiling", [...VALID_ARGS, "--max-requests", "600"]],
    ["spacing below the floor", [...VALID_ARGS, "--request-spacing-ms", "100"]],
    ["a flag without a value", [...VALID_ARGS.slice(0, -1)]],
    ["warmup after output", withArg("--warmup-start", "2024-02-02T00:00:00Z")],
  ])("refuses %s", (_label, argv) => {
    expect(usageError(argv)).not.toBeNull();
  });

  it("refuses a replay longer than the bar ceiling", () => {
    expect(MAX_REPLAY_BARS).toBe(200_000);
    expect(usageError(withArg("--warmup-start", "2010-01-01T00:00:00Z"))).toMatch(/at most 200000/);
  });
});

// ===========================================================================
// 40. Host timezone
// ===========================================================================

describe("host timezone independence", () => {
  it("produces identical times, candidates and bytes under any host TZ", () => {
    const original = process.env.TZ;
    const offsets: number[] = [];
    const outputs: string[] = [];
    try {
      for (const tz of ["UTC", "Pacific/Kiritimati", "America/Los_Angeles", "Asia/Singapore"]) {
        process.env.TZ = tz;
        offsets.push(new Date(Date.UTC(2024, 0, 1)).getTimezoneOffset());
        const parsed = parseUtcInstant("2024-01-03T00:00:00Z", "t");
        outputs.push(`${parsed}|${runHistoricalReplay(MAIN, request()).jsonl}`);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    expect(new Set(offsets).size).toBe(4); // the host timezone really did change
    expect(new Set(outputs).size).toBe(1);
  });
});

// ===========================================================================
// The runner end to end: fake Binance, real fetcher and cache, temp dirs
// ===========================================================================

describe("runner", () => {
  let seq = 0;
  const dirs = () => {
    seq += 1;
    return { cache: path.join(root, `cache-${seq}`), out: path.join(root, `out-${seq}`) };
  };
  const SERVER_TIME = bar(3 * DAY) + 3_600_000;

  function deps(cacheDir: string, outDir: string, opts: { fetch: boolean; now?: string; klines?: readonly NativeKline[] }) {
    const clock = manualClock();
    const binance = fakeBinance({ klines: opts.klines ?? MAIN, serverTimeMs: SERVER_TIME, clock });
    return {
      binance,
      deps: {
        cache: new KlineCacheStore(cacheDir),
        fetchRange: opts.fetch
          ? (req: Parameters<typeof fetchClosedFuturesKlines>[1]) =>
              fetchClosedFuturesKlines(
                { transport: binance.transport, baseUrl: "https://fapi.binance.com", policy: CONSERVATIVE_REQUEST_POLICY, nowMs: clock.nowMs, sleep: clock.sleep },
                req
              )
          : null,
        outputDir: outDir,
        nowIso: () => opts.now ?? "2026-10-01T00:00:00.000Z",
        gitHead: "f".repeat(40),
        gitWorktreeClean: true,
        maxBars: 10_000,
        pageLimit: 1000,
        settleMs: 5000,
      },
    };
  }

  it("cache-only mode refuses an incomplete cache and makes no request", async () => {
    const { cache, out } = dirs();
    const { binance, deps: d } = deps(cache, out, { fetch: false });
    await expect(executeHistoricalReplay(request(), d)).rejects.toThrow(/--fetch/);
    expect(binance.calls).toEqual([]);
    expect(existsSync(out)).toBe(false);
  });

  it("fetches once, caches, replays the verified cache, and a cache-only rerun reproduces the output", async () => {
    const { cache, out } = dirs();
    const first = deps(cache, out, { fetch: true });
    const run1 = await executeHistoricalReplay(request(), first.deps);
    expect(run1.fetched).toEqual({ requestsMade: 2, rows: 288 });
    expect(readFileSync(run1.outputPath, "utf8")).toBe(runHistoricalReplay(MAIN, request()).jsonl);
    expect(run1.manifest.input.cacheRowCount).toBe(288);

    const second = deps(cache, out, { fetch: false, now: "2026-10-02T00:00:00.000Z" });
    const run2 = await executeHistoricalReplay(request(), second.deps);
    expect(second.binance.calls).toEqual([]);
    expect(run2.fetched).toBeNull();
    expect(run2.manifest.output.sha256).toBe(run1.manifest.output.sha256);
    expect(run2.manifest.input.cacheSha256).toBe(run1.manifest.input.cacheSha256);
    expect(readdirSync(path.dirname(run1.outputPath)).sort()).toHaveLength(4);
  });

  it("never overwrites an existing output", async () => {
    const { cache, out } = dirs();
    await executeHistoricalReplay(request(), deps(cache, out, { fetch: true }).deps);
    await expect(executeHistoricalReplay(request(), deps(cache, out, { fetch: false }).deps)).rejects.toThrow(/EEXIST/);
  });

  it("refuses fetched data that contradicts the cache, leaving the cache as it was", async () => {
    const { cache, out } = dirs();
    // Cache only the first two days, so the rerun must fetch again.
    new KlineCacheStore(cache).save("USDM_PERPETUAL", "TESTUSDT", "15m", MAIN.slice(0, 2 * DAY), "t");
    const before = new KlineCacheStore(cache).load("USDM_PERPETUAL", "TESTUSDT", "15m")!.manifest.sha256;
    const altered = MAIN.map((k, i) => (i === 10 ? { ...k, close: k.close + 0.01, high: k.high + 0.01 } : k));
    await expect(executeHistoricalReplay(request(), deps(cache, out, { fetch: true, klines: altered }).deps)).rejects.toThrow(
      /two different candles/
    );
    expect(new KlineCacheStore(cache).load("USDM_PERPETUAL", "TESTUSDT", "15m")!.manifest.sha256).toBe(before);
  });

  it("refuses to replay over a gap the exchange left", async () => {
    const { cache, out } = dirs();
    const holed = [...MAIN.slice(0, 150), ...MAIN.slice(151)];
    await expect(executeHistoricalReplay(request(), deps(cache, out, { fetch: true, klines: holed }).deps)).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
  });
});

describe("scanner paths", () => {
  it("lives under LOCALAPPDATA and refuses to start without it", () => {
    expect(scannerRootDir({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" })).toBe(
      path.join("C:\\Users\\x\\AppData\\Local", "trading-alert-dashboard", "scanner")
    );
    expect(() => scannerRootDir({})).toThrow(ScannerPathError);
  });

  it("refuses any directory inside the repository", () => {
    const repo = path.resolve(__dirname, "../../..");
    expect(() => assertOutsideRepository(repo, repo)).toThrow(ScannerPathError);
    expect(() => assertOutsideRepository(path.join(repo, "apps", "backend", "cache"), repo)).toThrow(ScannerPathError);
    expect(assertOutsideRepository(root, repo)).toBe(path.resolve(root));
  });
});
