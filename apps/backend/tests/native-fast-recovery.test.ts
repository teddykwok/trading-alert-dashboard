import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { NativeEngineState } from "@trading-alert-dashboard/shared";

import { GovernedPublicTransport, MAX_IN_FLIGHT_CEILING, MAX_WEIGHT_PER_MINUTE_CEILING } from "../src/modules/native-scanner/candidate-rank-runner";
import { canonicalSha256 } from "../src/modules/native-scanner/canonical-json";
import { BinanceServerClock, fetchClosedFuturesKlines, type PublicHttpResponse, type PublicHttpTransport } from "../src/modules/native-scanner/kline-fetcher";
import { LEGACY_RECOVERY_POLICY, NATIVE_RECOVERY_POLICY_VERSION, TargetNotReachedError } from "../src/modules/native-scanner/live-shadow-supervisor";
import { FAST_RECOVERY_DEFAULTS, LEGACY_RECOVERY_DEFAULTS, SupervisorCliUsageError, parseSupervisorCliArgs } from "../src/modules/native-scanner/live-shadow-supervisor-cli-args";
import { klinesWeightForLimit, publicRequestWeight } from "../src/modules/native-scanner/public-request-weight";
import { deriveHtfContextStartMs } from "../src/modules/native-scanner/scanner-lineage";
import {
  TEDDY_7_ALL_ACTIVE_V1,
  dashboardTimeframes,
  engineFingerprintOf,
  engineTimeframes,
  futureExecutionTimeframes,
  lineageConfigOf,
  profileSummaryOf,
  type ScannerProfile,
} from "../src/modules/native-scanner/scanner-profile";
import { manualClock, toBinanceRow } from "./helpers/native-scanner-fakes";
import {
  M15,
  cloneState,
  durableSnapshot,
  engineStateOf,
  peakWeightPerMinute,
  startRun,
  symbolFacts,
  syntheticBars,
  tempDir,
  type MarketScript,
  type RunResult,
} from "./helpers/native-recovery-harness";

/**
 * NATIVE FAST RECOVERY V1.
 *
 * The same trusted checkpoint and the same missed bars go through the
 * ORIGINAL serial recovery (LEGACY) and through FAST_RECOVERY_V1, and every
 * durable byte and the full committed engine state must come out identical —
 * for 6 h / 1 d / 3 d / 2 w / 30 d of downtime, for the production engine, and
 * for every failure shape. FAST may only differ in how it reached Binance:
 * fewer requests, lower weight, bounded in flight, inside the weight budget.
 * Offline: a fake Binance, a manual clock, temp directories.
 */

const N = TEDDY_7_ALL_ACTIVE_V1;
const D = (d: number, h = 0, m = 0, s = 0) => Date.UTC(2025, 0, d, h, m, s);
/** Fixture engine: the production engine (7%, 1%, 5/4/10, dynamic lifecycle, symbol origin) on 1D only, short timeline. */
const FIX: ScannerProfile = {
  ...N,
  engine: { ...N.engine, historyStart: "2025-01-06T00:00:00Z", switchover: "2025-01-10T12:00:00Z", engineSourceTimeframes: engineTimeframes("1D") },
  delivery: { ...N.delivery, dashboardSourceTimeframes: dashboardTimeframes("1D") },
  execution: { ...N.execution, futureExecutionSourceTimeframes: futureExecutionTimeframes("1D") },
} as ScannerProfile;

/** The trusted run stops here (30 s into a bar); restarts happen whole multiples of 15 min later. */
const T0 = D(12, 0, 0, 30);
const HORIZON = (T0 - D(6)) / M15 + 3_000;
const SERIES = new Map<string, ReturnType<typeof syntheticBars>>([
  ["AAAUSDT", syntheticBars(7, D(6), HORIZON)],
  ["龙虾USDT", syntheticBars(11, D(6), HORIZON, 0.5)],
  ["NEW1USDT", syntheticBars(13, D(6), HORIZON, 2.5).filter((b) => b.openTimeMs >= D(8))],
  // Listed later, with a REAL post-origin gap 10 bars after the trusted HWM (inside every downtime shape).
  ["GAP1USDT", syntheticBars(17, D(6), HORIZON, 40).filter((b) => b.openTimeMs >= D(8) && b.openTimeMs !== D(12) + 10 * M15)],
  ["NEW2USDT", syntheticBars(19, D(6), HORIZON, 9).filter((b) => b.openTimeMs >= D(9))],
]);
const SYMBOLS = ["AAAUSDT", "GAP1USDT", "NEW1USDT", "龙虾USDT"];
const LIVE = ["AAAUSDT", "NEW1USDT", "龙虾USDT"];

function market(over: Partial<MarketScript> = {}): MarketScript {
  return {
    bars: (s) => SERIES.get(s) ?? [],
    onboardDateMs: (s) => (s.startsWith("NEW1") || s.startsWith("GAP") ? D(8) : s.startsWith("NEW2") ? D(9) : D(5)),
    ...over,
  };
}

/** The trusted starting state (a clean LEGACY run that stopped at T0), shared read-only by every test. */
let BASE: { root: string; cacheDir: string };
let BASE_STATE: Record<string, NativeEngineState>;
let BASE_SNAPSHOT: Record<string, string>;
beforeAll(async () => {
  BASE = { root: tempDir("recov-base-root-"), cacheDir: tempDir("recov-base-cache-") };
  const first = await startRun({ mode: "LEGACY", profile: FIX, symbols: SYMBOLS, market: market(), ...BASE, nowMs: T0 });
  BASE_STATE = Object.fromEntries(LIVE.map((s) => [s, engineStateOf(first, s) as NativeEngineState]));
  first.supervisor.stop();
  BASE_SNAPSHOT = durableSnapshot({ root: BASE.root, cache: BASE.cacheDir });
}, 120_000);

/** One restart of a CLONE of the trusted state under each policy. */
async function restartBoth(gapBars: number, opts: { symbols?: string[]; market?: MarketScript; mutate?: (state: { root: string; cacheDir: string }) => void; mode?: never } = {}) {
  const runs: Record<"LEGACY" | "FAST", { run: RunResult; dirs: { root: string; cacheDir: string } }> = {} as never;
  for (const mode of ["LEGACY", "FAST"] as const) {
    const dirs = cloneState(BASE);
    opts.mutate?.(dirs);
    const run = await startRun({ mode, profile: FIX, symbols: opts.symbols ?? SYMBOLS, market: opts.market ?? market(), ...dirs, nowMs: T0 + gapBars * M15 });
    run.supervisor.stop();
    runs[mode] = { run, dirs };
  }
  return runs;
}

const snapshotOf = (dirs: { root: string; cacheDir: string }) => durableSnapshot({ root: dirs.root, cache: dirs.cacheDir });
const klines = (run: RunResult) => run.requests.filter((r) => r.url.includes("/klines")).map((r) => new URL(r.url));
const isoBar = (ms: number) => new Date(Math.floor((ms - 5_000) / M15) * M15).toISOString();

// ===========================================================================
// Equivalence: the same trusted state, the same missed bars, both policies
// ===========================================================================

describe("equivalence: LEGACY serial recovery vs FAST_RECOVERY_V1", () => {
  it("a first bootstrap (no checkpoint) builds byte-identical state under both policies", async () => {
    const out: Record<string, { facts: unknown; snap: Record<string, string> }> = {};
    for (const mode of ["LEGACY", "FAST"] as const) {
      const dirs = { root: tempDir("recov-boot-root-"), cacheDir: tempDir("recov-boot-cache-") };
      const run = await startRun({ mode, profile: FIX, symbols: SYMBOLS, market: market(), ...dirs, nowMs: T0 });
      run.supervisor.stop();
      expect(run.recovery).toMatchObject({ bootstrapped: 4, recovered: 0, liveReady: 4, notLive: 0, policy: mode === "FAST" ? NATIVE_RECOVERY_POLICY_VERSION : LEGACY_RECOVERY_POLICY });
      out[mode] = { facts: symbolFacts(run), snap: snapshotOf(dirs) };
    }
    expect(out.FAST.facts).toEqual(out.LEGACY.facts);
    expect(out.FAST.snap).toEqual(out.LEGACY.snap);
    expect(out.FAST.snap).toEqual(BASE_SNAPSHOT);
  });

  const SHAPES = [
    ["6 hours", 24],
    ["1 day", 96],
    ["3 days", 288],
    ["2 weeks", 1344],
    ["30 days", 2880],
  ] as const;

  for (const [label, gap] of SHAPES) {
    it(`${label} down (${gap} missed 15m bars): identical durable state, commits, engine state, quarantine; FAST cheaper and bounded`, async () => {
      const { LEGACY: a, FAST: b } = await restartBoth(gap);
      const T1 = T0 + gap * M15;

      // ---- exact equivalence ----
      expect(symbolFacts(b.run)).toEqual(symbolFacts(a.run));
      expect(snapshotOf(b.dirs)).toEqual(snapshotOf(a.dirs));
      for (const symbol of LIVE) {
        const fact = symbolFacts(b.run).find((f) => f.symbol === symbol)!;
        expect(fact, symbol).toMatchObject({ status: "ATTACHED", failure: null, hwm: isoBar(T1) });
        // The checkpoint advanced exactly by the downtime (no HWM regression, nothing skipped, nothing doubled).
        expect(JSON.parse(snapshotOf(b.dirs)[Object.keys(snapshotOf(b.dirs)).find((k) => k.endsWith("checkpoint.json") && k.includes(symbol === "龙虾USDT" ? "u-" : symbol))!]).body.hwmOpenTimeMs).toBe(Date.parse(isoBar(T1)));
      }
      // A real post-origin gap is quarantined, identically.
      expect(symbolFacts(b.run).find((f) => f.symbol === "GAP1USDT")).toMatchObject({ status: "QUARANTINED", failure: expect.stringMatching(/^INCOMPLETE_DATA/) });

      // ---- historical recovery is NON_ACTIONABLE: no event (observation or commit) is written by a catch-up ----
      for (const [file, text] of Object.entries(snapshotOf(b.dirs))) {
        if (file.endsWith("events.jsonl")) expect(text, file).toBe(BASE_SNAPSHOT[file] ?? "");
      }

      // ---- the recovery summary ----
      expect(b.run.recovery).toMatchObject({ policy: NATIVE_RECOVERY_POLICY_VERSION, symbols: 4, liveReady: 3, recovered: 3, current: 0, bootstrapped: 0, notLive: 1, missingBarsReplayed: 3 * gap });
      expect(a.run.recovery).toMatchObject({ policy: LEGACY_RECOVERY_POLICY, recovered: 3, missingBarsReplayed: 3 * gap });

      // ---- FAST reached Binance more cheaply, never louder ----
      expect(b.run.requests.length).toBeLessThan(a.run.requests.length);
      expect(b.run.metrics.weightUsed).toBeLessThanOrEqual(a.run.metrics.weightUsed);
      // ONE Binance clock reading serves the whole start-up (probes and every symbol's closure proof).
      expect(b.run.requests.filter((r) => r.url.includes("/fapi/v1/time")).length).toBe(1);
      const pages = klines(b.run).map((u) => `${u.searchParams.get("symbol")}@${u.searchParams.get("startTime")}`);
      expect(new Set(pages).size).toBe(pages.length); // no page fetched twice
      for (const u of klines(b.run)) {
        const limit = Number(u.searchParams.get("limit"));
        expect(limit).toBeLessThanOrEqual(1000); // never above the page size Binance charges weight 5 for
        if (limit === 2) continue; // the origin probe
        expect(limit).toBeLessThanOrEqual(Math.ceil((Number(u.searchParams.get("endTime")) + 1 - Number(u.searchParams.get("startTime"))) / M15));
      }
      expect(b.run.maxInFlight).toBeLessThanOrEqual(FAST_RECOVERY_DEFAULTS.maxInFlight);
      expect(peakWeightPerMinute(b.run.requests)).toBeLessThanOrEqual(FAST_RECOVERY_DEFAULTS.maxWeightPerMinute);
      expect(a.run.maxInFlight).toBe(1);
    });
  }

  it("with real response latency FAST overlaps at most 2 requests (and does use 2), and still equals LEGACY byte for byte", async () => {
    const slow = market({ latencyTurns: 3 });
    const runs = [];
    for (const mode of ["LEGACY", "FAST"] as const) {
      const dirs = cloneState(BASE);
      const run = await startRun({ mode, profile: FIX, symbols: [...SYMBOLS, "NEW2USDT"], market: slow, ...dirs, nowMs: T0 + 288 * M15 });
      run.supervisor.stop();
      runs.push({ run, dirs });
    }
    expect(runs[0].run.maxInFlight).toBe(1);
    expect(runs[1].run.maxInFlight).toBe(FAST_RECOVERY_DEFAULTS.maxInFlight);
    expect(runs[1].run.metrics.maxInFlightObserved).toBe(FAST_RECOVERY_DEFAULTS.maxInFlight);
    expect(symbolFacts(runs[1].run)).toEqual(symbolFacts(runs[0].run));
    expect(snapshotOf(runs[1].dirs)).toEqual(snapshotOf(runs[0].dirs));
  });

  it("downtime that changes the Teddy state (levels created, armed, retested -> cooldown, source periods closed) is replayed identically", async () => {
    for (const gap of [1344, 2880]) {
      const { LEGACY: a, FAST: b } = await restartBoth(gap);
      const before = BASE_STATE.AAAUSDT;
      const after = engineStateOf(b.run, "AAAUSDT") as NativeEngineState;
      expect(engineStateOf(a.run, "AAAUSDT")).toEqual(after);
      expect(after.barIndex - before.barIndex).toBe(gap);
      const inGap = (index: number) => index >= before.barIndex;
      expect(after.levels.filter((l) => inGap(l.createdBarIndex)).length, `${gap}: created`).toBeGreaterThan(0);
      expect(after.levels.filter((l) => inGap(l.armedBarIndex)).length, `${gap}: armed`).toBeGreaterThan(0);
      expect(after.levels.filter((l) => inGap(l.lastTouchBarIndex)).length, `${gap}: retested (cooldown)`).toBeGreaterThan(0);
      // Source (1D) periods closed during the downtime: the forming track moved to a later period.
      expect(after.htf["1D"]?.aggregate?.periodStartMs).toBeGreaterThan(before.htf["1D"]?.aggregate?.periodStartMs as number);
      // The replay produced committed candidates during the downtime — and none of them was written as an event.
      expect(b.run.logs.some((l) => /AAAUSDT CATCHUP_OK .* replayed \d+ bar\(s\) NON_ACTIONABLE/.test(l))).toBe(true);
    }
  });

  it("the production engine (TEDDY_7_ALL_ACTIVE_V1: 1D/1W/1M/3M/6M/12M, 7%, 1%, 5/4/10) recovers identically under both policies", async () => {
    const lineage = lineageConfigOf(N.engine);
    const ctx = deriveHtfContextStartMs(lineage.historyStartMs, lineage.engine.enabledSourceTfs, lineage.engine.calendar);
    const start = Date.UTC(2026, 8, 20, 0, 0, 30);
    const gap = 96;
    const bars = syntheticBars(23, ctx, (start + gap * M15 - ctx) / M15 + 10, 3);
    const prod: MarketScript = { bars: (s) => (s === "PRODUSDT" ? bars : []), onboardDateMs: () => ctx - 86_400_000 };
    const base = { root: tempDir("recov-prod-root-"), cacheDir: tempDir("recov-prod-cache-") };
    const first = await startRun({ mode: "LEGACY", profile: N, symbols: ["PRODUSDT"], market: prod, ...base, nowMs: start });
    first.supervisor.stop();
    expect(first.startError).toBeNull();
    const results = [];
    for (const mode of ["LEGACY", "FAST"] as const) {
      const dirs = cloneState(base);
      const run = await startRun({ mode, profile: N, symbols: ["PRODUSDT"], market: prod, ...dirs, nowMs: start + gap * M15 });
      run.supervisor.stop();
      expect(run.recovery).toMatchObject({ recovered: 1, missingBarsReplayed: gap });
      results.push({ facts: symbolFacts(run), snap: snapshotOf(dirs), requests: run.requests.length, weight: run.metrics.weightUsed, state: engineStateOf(run, "PRODUSDT") as NativeEngineState });
    }
    expect(results[1].facts).toEqual(results[0].facts);
    expect(results[1].snap).toEqual(results[0].snap);
    // One symbol has no serverTime to share: the saving is the page weight (96 bars: weight 1 instead of 5).
    expect(results[1].requests).toBeLessThanOrEqual(results[0].requests);
    expect(results[1].weight).toBeLessThan(results[0].weight);
    expect(Object.keys(results[1].state.htf).sort()).toEqual(["12M", "1D", "1M", "1W", "3M", "6M"]);
  }, 120_000);
});

// ===========================================================================
// Failure shapes: both policies decide exactly the same way
// ===========================================================================

describe("failure shapes are decided identically (fail closed)", () => {
  const sameOutcome = (r: Awaited<ReturnType<typeof restartBoth>>) => {
    expect(symbolFacts(r.FAST.run)).toEqual(symbolFacts(r.LEGACY.run));
    expect(snapshotOf(r.FAST.dirs)).toEqual(snapshotOf(r.LEGACY.dirs));
  };
  const fact = (r: Awaited<ReturnType<typeof restartBoth>>, symbol: string) => symbolFacts(r.FAST.run).find((f) => f.symbol === symbol)!;
  const checkpointFile = (dirs: { root: string }, symbol: string) => {
    const key = Object.keys(durableSnapshot({ root: dirs.root })).find((k) => k.endsWith(`/${symbol}/15m/checkpoint.json`))!;
    return path.join(dirs.root, key.replace(/^root\//, ""));
  };

  it("a duplicate bar in a page is refused (unreadable, retried later), never merged", async () => {
    const r = await restartBoth(96, {
      market: market({ tamperPage: (symbol, rows) => (symbol === "AAAUSDT" && rows.length > 2 ? [...rows.slice(0, 2), rows[1], ...rows.slice(2)] : rows) }),
    });
    sameOutcome(r);
    expect(fact(r, "AAAUSDT")).toMatchObject({ status: "BOOTSTRAP_UNREADABLE" });
    expect(readFileSync(checkpointFile(r.FAST.dirs, "AAAUSDT"), "utf8")).toBe(readFileSync(checkpointFile(BASE, "AAAUSDT"), "utf8"));
  });

  it("a checkpoint that does not match the rebuilt state is refused (quarantined), and left exactly as found", async () => {
    let tampered = "";
    const r = await restartBoth(96, {
      mutate: (dirs) => {
        const file = checkpointFile(dirs, "AAAUSDT");
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        parsed.body.stateSha256 = "f".repeat(64);
        parsed.bodySha256 = canonicalSha256(parsed.body);
        tampered = JSON.stringify(parsed);
        writeFileSync(file, tampered);
      },
    });
    sameOutcome(r);
    expect(fact(r, "AAAUSDT")).toMatchObject({ status: "QUARANTINED", failure: expect.stringMatching(/^STATE_MISMATCH/) });
    expect(readFileSync(checkpointFile(r.FAST.dirs, "AAAUSDT"), "utf8")).toBe(tampered);
  });

  it("a retryable failure (one 5xx) is retried with backoff and ends in the same state as a clean recovery", async () => {
    const clean = await restartBoth(96);
    let failed = 0;
    const r = await restartBoth(96, {
      market: market({ respond: (u) => (u.pathname === "/fapi/v1/klines" && u.searchParams.get("symbol") === "AAAUSDT" && failed++ % 2 === 0 ? { status: 503, body: {} } : null) }),
    });
    expect(symbolFacts(r.FAST.run)).toEqual(symbolFacts(clean.FAST.run));
    expect(snapshotOf(r.FAST.dirs)).toEqual(snapshotOf(clean.FAST.dirs));
    sameOutcome(r);
  });

  it("a permanent failure is UNREADABLE (retried later), never guessed; the checkpoint is untouched", async () => {
    const r = await restartBoth(96, {
      market: market({ respond: (u) => (u.pathname === "/fapi/v1/klines" && u.searchParams.get("symbol") === "AAAUSDT" ? { status: 500, body: {} } : null) }),
    });
    sameOutcome(r);
    expect(fact(r, "AAAUSDT")).toMatchObject({ status: "BOOTSTRAP_UNREADABLE", failure: expect.stringMatching(/PUBLIC_FETCH_FAILED|HTTP_ERROR/) });
    expect(readFileSync(checkpointFile(r.FAST.dirs, "AAAUSDT"), "utf8")).toBe(readFileSync(checkpointFile(BASE, "AAAUSDT"), "utf8"));
  });

  it("a 429 halts the whole run under both policies; nothing starts once the halt is known", async () => {
    for (const mode of ["LEGACY", "FAST"] as const) {
      const dirs = cloneState(BASE);
      let hit = -1;
      const run = await startRun({
        mode,
        profile: FIX,
        symbols: SYMBOLS,
        market: market({ latencyTurns: 2, respond: (u, i) => (u.pathname === "/fapi/v1/klines" && hit < 0 ? ((hit = i), { status: 429, body: {} }) : null) }),
        ...dirs,
        nowMs: T0 + 96 * M15,
      });
      run.supervisor.stop();
      expect(run.startError, mode).toBeInstanceOf(TargetNotReachedError);
      // At most the requests already in flight when the 429 arrived (FAST: up to maxInFlight - 1 others).
      expect(run.requests.length - 1 - hit, mode).toBeLessThanOrEqual(mode === "FAST" ? FAST_RECOVERY_DEFAULTS.maxInFlight - 1 : 0);
    }
  });

  it("a shutdown midway through recovery lands nothing: no checkpoint write, no commit, no LIVE symbol", async () => {
    for (const mode of ["LEGACY", "FAST"] as const) {
      const dirs = cloneState(BASE);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let supervisorRef: { stop(): void } | null = null;
      const pending = startRun({
        mode,
        profile: FIX,
        symbols: SYMBOLS,
        market: market({ gate: (s) => (s === "AAAUSDT" ? gate : null), latencyTurns: 1 }),
        ...dirs,
        nowMs: T0 + 288 * M15,
        beforeStart: (s) => (supervisorRef = s),
      });
      for (let i = 0; i < 50; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
      (supervisorRef as unknown as { stop(): void }).stop();
      release();
      const run = await pending;
      expect(readFileSync(checkpointFile(dirs, "AAAUSDT"), "utf8"), mode).toBe(readFileSync(checkpointFile(BASE, "AAAUSDT"), "utf8"));
      for (const [file, text] of Object.entries(snapshotOf(dirs))) if (file.endsWith("events.jsonl")) expect(text, file).toBe(BASE_SNAPSHOT[file] ?? "");
      expect(run.supervisor.status().symbols.find((s) => s.symbol === "AAAUSDT")?.status).not.toBe("ATTACHED");
    }
  });

  it("an in-run recovery (detach -> missed closed bars -> REPLAYED_NON_ACTIONABLE commits) is identical under both policies, and cheaper", async () => {
    const out = [];
    for (const mode of ["LEGACY", "FAST"] as const) {
      const dirs = cloneState(BASE);
      const run = await startRun({ mode, profile: FIX, symbols: SYMBOLS, market: market(), ...dirs, nowMs: T0 + 96 * M15 });
      const internals = run.supervisor as unknown as { workers: Map<string, unknown>; detach(worker: unknown, reason: string): void };
      const before = run.requests.length;
      internals.detach(internals.workers.get("AAAUSDT"), "TEST_DISCONNECT");
      run.advance(3 * M15);
      // (Silent fake streams also time the connection out, so every live symbol recovers; ticks are bounded by the worker count.)
      for (let i = 0; i < 10 && run.supervisor.status().symbols.some((x) => x.status === "RECOVERING"); i += 1) await Promise.all(run.supervisor.tick());
      const recovery = run.requests.slice(before).filter((r) => !r.url.includes("exchangeInfo"));
      const facts = symbolFacts(run);
      const status = run.supervisor.status().symbols.find((x) => x.symbol === "AAAUSDT");
      run.supervisor.stop(); // flushes the (non-authoritative) kline cache before the files are compared
      out.push({ mode, facts, snap: snapshotOf(dirs), recovery, status });
    }
    const [a, b] = out;
    expect(b.status).toMatchObject({ status: "ATTACHED", counters: { recoveries: 1, commitsReplayed: 3 } });
    expect(b.facts).toEqual(a.facts);
    expect(b.snap).toEqual(a.snap);
    const events = Object.entries(b.snap).find(([k]) => k.endsWith("/AAAUSDT/15m/events.jsonl"))![1];
    expect(events.trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.kind, r.classification, r.actionable])).toEqual(Array(3).fill(["BAR_CLOSE_COMMIT", "REPLAYED_NON_ACTIONABLE", false]));
    // LEGACY: a serverTime + a 1000-row page per recovered symbol. FAST: one range-sized page each (weight 1); one shared Binance reading at most.
    const recovered = LIVE.length;
    expect(a.recovery.filter((r) => r.url.includes("/fapi/v1/time"))).toHaveLength(recovered);
    expect(a.recovery.filter((r) => r.url.includes("/klines")).map((r) => new URL(r.url).searchParams.get("limit"))).toEqual(Array(recovered).fill("1000"));
    expect(b.recovery.filter((r) => r.url.includes("/fapi/v1/time")).length).toBeLessThanOrEqual(1);
    expect(b.recovery.filter((r) => r.url.includes("/klines")).map((r) => new URL(r.url).searchParams.get("limit"))).toEqual(Array(recovered).fill("3"));
    expect(b.recovery.reduce((w, r) => w + r.weight, 0)).toBeLessThan(a.recovery.reduce((w, r) => w + r.weight, 0));
  });

  it("a newly onboarded symbol bootstraps from its own first real closed bar; a Unicode symbol recovers in its encoded directory", async () => {
    const r = await restartBoth(96, { symbols: [...SYMBOLS, "NEW2USDT"] });
    sameOutcome(r);
    expect(fact(r, "NEW2USDT")).toMatchObject({ status: "ATTACHED", origin: { kind: "SYMBOL_FIRST_CLOSED_BAR", firstClosedBarOpenTimeMs: D(9) } });
    // Only the three recovered symbols' missed bars count as downtime; the new symbol's bootstrap replay does not.
    expect(r.FAST.run.recovery).toMatchObject({ bootstrapped: 1, recovered: 3, missingBarsReplayed: 3 * 96 });
    expect(fact(r, "龙虾USDT")).toMatchObject({ status: "ATTACHED", stateDir: expect.stringMatching(/^u-[0-9a-f]+$/) });
  });

  it("Binance reporting the shared IP above the high-water mark pauses every start to the next minute; the result is unchanged", async () => {
    const clean = await restartBoth(96);
    const dirs = cloneState(BASE);
    const run = await startRun({
      mode: "FAST",
      profile: FIX,
      symbols: SYMBOLS,
      // The first klines response says the shared IP is at 1500 of its 2400 weight this minute.
      market: market({ headers: (u, i) => ({ "X-MBX-USED-WEIGHT-1M": String(u.pathname === "/fapi/v1/klines" && i <= 2 ? 1500 : 40) }) }),
      ...dirs,
      nowMs: T0 + 96 * M15,
    });
    run.supervisor.stop();
    expect(run.metrics.usedWeightPauses).toBeGreaterThanOrEqual(1);
    expect(run.metrics.peakReportedUsedWeight).toBe(1500);
    expect(run.recovery.usedWeightPauses).toBeGreaterThanOrEqual(1);
    // Every start after the report waited for the next minute.
    const reportedAt = run.requests.findIndex((r) => r.url.includes("/klines"));
    const nextMinute = (Math.floor(run.requests[reportedAt].atMs / 60_000) + 1) * 60_000;
    for (const later of run.requests.slice(reportedAt + 1)) expect(later.atMs).toBeGreaterThanOrEqual(nextMinute);
    expect(symbolFacts(run)).toEqual(symbolFacts(clean.FAST.run));
    // The pause itself, through the governor directly (headers are what Binance sends).
    const clock = manualClock(Date.UTC(2026, 0, 1, 0, 0, 10));
    const starts: number[] = [];
    let n = 0;
    const g = new GovernedPublicTransport(
      async () => (starts.push(clock.nowMs()), { status: 200, header: (h: string) => (h.toLowerCase() === "x-mbx-used-weight-1m" ? String(n++ === 0 ? 1500 : 10) : null), text: async () => "{}" }),
      { maxTotalRequests: 100, minSpacingMs: 250, nowMs: clock.nowMs, sleep: clock.sleep, weightBudget: { maxWeightPerMinute: 300, usedWeightHighWater: 1200 } }
    );
    await g.transport("https://fapi.binance.com/fapi/v1/time", { headers: {} });
    await g.transport("https://fapi.binance.com/fapi/v1/time", { headers: {} });
    expect(starts[1]).toBeGreaterThanOrEqual(Date.UTC(2026, 0, 1, 0, 1, 0));
    expect(g.metrics).toMatchObject({ usedWeightPauses: 1, peakReportedUsedWeight: 1500 });
  });
});

// ===========================================================================
// The governor: bounded, spaced, weighted; serial by default
// ===========================================================================

describe("the governed transport", () => {
  const ok = (): PublicHttpResponse => ({ status: 200, header: () => null, text: async () => "{}" });
  const slow = (track: { inFlight: number; max: number; starts: number[] }, clock: ReturnType<typeof manualClock>): PublicHttpTransport => async () => {
    track.inFlight += 1;
    track.max = Math.max(track.max, track.inFlight);
    track.starts.push(clock.nowMs());
    for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    track.inFlight -= 1;
    return ok();
  };
  const KLINES = (limit: number) => `https://fapi.binance.com/fapi/v1/klines?symbol=AAAUSDT&interval=15m&startTime=0&endTime=1&limit=${limit}`;

  it("by default it is the original strictly serial, spaced governor", async () => {
    const clock = manualClock();
    const track = { inFlight: 0, max: 0, starts: [] as number[] };
    const g = new GovernedPublicTransport(slow(track, clock), { maxTotalRequests: 100, minSpacingMs: 250, nowMs: clock.nowMs, sleep: clock.sleep });
    await Promise.all(Array.from({ length: 6 }, () => g.transport(KLINES(1000), { headers: {} })));
    expect(track.max).toBe(1);
    for (let i = 1; i < track.starts.length; i += 1) expect(track.starts[i] - track.starts[i - 1]).toBeGreaterThanOrEqual(250);
    expect(g.metrics).toMatchObject({ requestsMade: 6, weightWaits: 0, maxInFlightObserved: 1 });
  });

  it("maxInFlight bounds concurrent requests; starts stay spaced and in call order", async () => {
    const clock = manualClock();
    const track = { inFlight: 0, max: 0, starts: [] as number[] };
    const g = new GovernedPublicTransport(slow(track, clock), { maxTotalRequests: 100, minSpacingMs: 250, nowMs: clock.nowMs, sleep: clock.sleep, maxInFlight: 2 });
    await Promise.all(Array.from({ length: 8 }, () => g.transport(KLINES(10), { headers: {} })));
    expect(track.max).toBe(2);
    for (let i = 1; i < track.starts.length; i += 1) expect(track.starts[i] - track.starts[i - 1]).toBeGreaterThanOrEqual(250);
  });

  it("the weight budget holds in every rolling minute (klines weight by limit tier)", async () => {
    const clock = manualClock();
    const track = { inFlight: 0, max: 0, starts: [] as number[] };
    const g = new GovernedPublicTransport(slow(track, clock), { maxTotalRequests: 1000, minSpacingMs: 250, nowMs: clock.nowMs, sleep: clock.sleep, maxInFlight: 2, weightBudget: { maxWeightPerMinute: 30, usedWeightHighWater: 2400 } });
    await Promise.all(Array.from({ length: 20 }, () => g.transport(KLINES(1000), { headers: {} })));
    const weighted = track.starts.map((atMs) => ({ url: KLINES(1000), atMs, weight: 5 }));
    expect(peakWeightPerMinute(weighted)).toBeLessThanOrEqual(30);
    expect(g.metrics.weightUsed).toBe(100);
    expect(g.metrics.weightWaits).toBeGreaterThan(0);
  });

  it("no request starts once a 418/429 is known, even with requests in flight", async () => {
    const clock = manualClock();
    let calls = 0;
    const g = new GovernedPublicTransport(
      async () => {
        calls += 1;
        return calls === 1 ? { status: 429, header: () => null, text: async () => "{}" } : ok();
      },
      { maxTotalRequests: 100, minSpacingMs: 250, nowMs: clock.nowMs, sleep: clock.sleep, maxInFlight: 2 }
    );
    await g.transport(KLINES(10), { headers: {} });
    await expect(g.transport(KLINES(10), { headers: {} })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(calls).toBe(1);
  });

  it("refuses unsafe configurations", () => {
    const clock = manualClock();
    const make = (extra: object) => () => new GovernedPublicTransport(async () => ok(), { maxTotalRequests: 100, minSpacingMs: 250, nowMs: clock.nowMs, sleep: clock.sleep, ...extra });
    expect(make({ maxInFlight: 0 })).toThrow(/in flight/);
    expect(make({ maxInFlight: MAX_IN_FLIGHT_CEILING + 1 })).toThrow(/in flight/);
    expect(make({ minSpacingMs: 100 })).toThrow(/spacing/);
    expect(make({ weightBudget: { maxWeightPerMinute: 9, usedWeightHighWater: 1200 } })).toThrow(/weight budget/);
    expect(make({ weightBudget: { maxWeightPerMinute: MAX_WEIGHT_PER_MINUTE_CEILING + 1, usedWeightHighWater: 1200 } })).toThrow(/weight budget/);
    expect(make({ weightBudget: { maxWeightPerMinute: 300, usedWeightHighWater: 0 } })).toThrow(/high-water/);
    expect(MAX_WEIGHT_PER_MINUTE_CEILING).toBe(1200);
  });

  it("weights requests the way Binance does; unknown endpoints are charged the most", () => {
    expect([1, 99, 100, 499, 500, 1000, 1001, 1500].map(klinesWeightForLimit)).toEqual([1, 1, 2, 2, 5, 5, 10, 10]);
    expect(publicRequestWeight("https://fapi.binance.com/fapi/v1/time")).toBe(1);
    expect(publicRequestWeight("https://fapi.binance.com/fapi/v1/exchangeInfo")).toBe(1);
    expect(publicRequestWeight("https://fapi.binance.com/fapi/v1/klines?symbol=X")).toBe(5); // Binance default limit 500
    expect(publicRequestWeight("https://fapi.binance.com/fapi/v1/ticker/price")).toBe(2);
    expect(publicRequestWeight("https://fapi.binance.com/fapi/v1/ticker/price?symbol=X")).toBe(1);
    expect(publicRequestWeight("https://fapi.binance.com/fapi/v1/somethingElse")).toBe(10);
    expect(publicRequestWeight("not a url")).toBe(10);
  });
});

// ===========================================================================
// The shared Binance clock and range-sized pages
// ===========================================================================

describe("the shared Binance clock and range-sized pages", () => {
  const BARS = syntheticBars(5, D(6), 400);
  function binance(serverTimes: number[]) {
    const calls: string[] = [];
    let t = 0;
    const transport: PublicHttpTransport = async (url) => {
      calls.push(url);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const u = new URL(url);
      if (u.pathname === "/fapi/v1/time") return { status: 200, header: () => null, text: async () => JSON.stringify({ serverTime: serverTimes[Math.min(t++, serverTimes.length - 1)] }) };
      const start = Number(u.searchParams.get("startTime"));
      const end = Number(u.searchParams.get("endTime"));
      const rows = BARS.filter((b) => b.openTimeMs >= start && b.openTimeMs <= end).slice(0, Number(u.searchParams.get("limit")));
      return { status: 200, header: () => null, text: async () => JSON.stringify(rows.map(toBinanceRow)) };
    };
    return { transport, calls };
  }
  const deps = (transport: PublicHttpTransport, clock = manualClock(D(20))) => ({
    transport,
    baseUrl: "https://fapi.binance.com",
    policy: { maxRequests: 500, minSpacingMs: 250, maxTransientRetries: 0, transientBackoffMs: 250 },
    nowMs: clock.nowMs,
    sleep: clock.sleep,
  });

  it("concurrent readers share ONE serverTime request; a reading is reused until it can no longer prove closure", async () => {
    const b = binance([D(10), D(11), D(12)]);
    const clock = new BinanceServerClock(deps(b.transport), 60_000);
    const readings = await Promise.all([clock.current(), clock.current(), clock.atLeast(D(9))]);
    expect(readings).toEqual([D(10), D(10), D(10)]);
    expect(clock.requests).toBe(1);
    // Sequential readers inside the maximum age reuse it too.
    expect(await clock.current()).toBe(D(10));
    expect(await clock.current()).toBe(D(10));
    expect(clock.requests).toBe(1);
    expect(await clock.atLeast(D(9, 12))).toBe(D(10)); // still proves it: no request
    expect(clock.requests).toBe(1);
    expect(await clock.atLeast(D(10, 12))).toBe(D(11)); // cannot: one fresh reading
    expect(clock.requests).toBe(2);
  });

  it("never moves backwards, and is refused outside 1 s .. 15 min of age", async () => {
    const b = binance([D(12), D(11)]);
    const clock = new BinanceServerClock(deps(b.transport), 60_000);
    expect(await clock.refresh()).toBe(D(12));
    expect(await clock.refresh()).toBe(D(12));
    expect(() => new BinanceServerClock(deps(b.transport), 999)).toThrow();
    expect(() => new BinanceServerClock(deps(b.transport), 900_001)).toThrow();
  });

  it("range-sized pages return the very same rows with a lower limit (weight 1 under 100 bars)", async () => {
    for (const bars of [1, 24, 96, 99, 288, 399]) {
      const legacy = binance([D(20)]);
      const fast = binance([D(20)]);
      const request = { symbol: "AAAUSDT", interval: "15m" as const, startMs: D(6), endMs: D(6) + bars * M15, maxBars: 5_000, pageLimit: 1000, settleMs: 5_000 };
      const a = await fetchClosedFuturesKlines(deps(legacy.transport), request);
      const sharedClock = new BinanceServerClock(deps(fast.transport), 60_000);
      const b = await fetchClosedFuturesKlines(deps(fast.transport), request, { serverClock: sharedClock, sizePagesToRange: true });
      expect(b.klines).toEqual(a.klines);
      expect(b.klines).toHaveLength(bars);
      const limit = (calls: string[]) => Number(new URL(calls.find((c) => c.includes("/klines"))!).searchParams.get("limit"));
      expect(limit(legacy.calls)).toBe(1000);
      expect(limit(fast.calls)).toBe(bars);
      expect(publicRequestWeight(fast.calls.find((c) => c.includes("/klines"))!)).toBe(klinesWeightForLimit(bars));
    }
  });

  it("a kept reading too old to prove closure is refreshed (never refused while Binance's clock proves it)", async () => {
    const b = binance([D(6, 1), D(20)]);
    const clock = new BinanceServerClock(deps(b.transport), 60_000);
    expect(await clock.refresh()).toBe(D(6, 1)); // kept, and young by the local clock
    const result = await fetchClosedFuturesKlines(deps(b.transport), { symbol: "AAAUSDT", interval: "15m", startMs: D(6), endMs: D(6, 2), maxBars: 100, pageLimit: 1000, settleMs: 5_000 }, { serverClock: clock, sizePagesToRange: true });
    expect(result.klines).toHaveLength(8);
    expect(clock.requests).toBe(2);
  });

  it("closure is still refused when even a fresh Binance reading cannot prove the range closed (never a silently shortened range)", async () => {
    // Binance as it really is: at server time 01:10 it knows no bar that closes later; asked up to 01:15 it would just return less.
    const serverTime = D(6, 1, 10);
    const transport: PublicHttpTransport = async (url) => {
      const u = new URL(url);
      if (u.pathname === "/fapi/v1/time") return { status: 200, header: () => null, text: async () => JSON.stringify({ serverTime }) };
      const rows = BARS.filter((b) => b.openTimeMs >= Number(u.searchParams.get("startTime")) && b.openTimeMs <= Number(u.searchParams.get("endTime")) && b.closeTimeMs < serverTime);
      return { status: 200, header: () => null, text: async () => JSON.stringify(rows.slice(0, Number(u.searchParams.get("limit"))).map(toBinanceRow)) };
    };
    const request = { symbol: "AAAUSDT", interval: "15m" as const, startMs: D(6), endMs: D(6, 1, 15), maxBars: 100, pageLimit: 1000, settleMs: 5_000 };
    await expect(fetchClosedFuturesKlines(deps(transport), request, { serverClock: new BinanceServerClock(deps(transport), 60_000), sizePagesToRange: true })).rejects.toMatchObject({ code: "RANGE_NOT_CLOSED" });
    await expect(fetchClosedFuturesKlines(deps(transport), request)).rejects.toMatchObject({ code: "RANGE_NOT_CLOSED" });
  });
});

// ===========================================================================
// Operator surface, versioning, scope
// ===========================================================================

describe("operator surface, versioning and scope", () => {
  it("FAST_RECOVERY_V1 is the default; the original serial policy stays selectable; bounds are enforced", () => {
    const fast = parseSupervisorCliArgs(["--profile", "teddy-7-all-active"]);
    expect(fast).toMatchObject({ recoveryPolicy: "FAST_RECOVERY_V1", minSpacingMs: 250, maxInFlight: 2, maxWeightPerMinute: 300, restConcurrency: 4 });
    const legacy = parseSupervisorCliArgs(["--profile", "teddy-7-all-active", "--recovery-policy", "legacy"]);
    expect(legacy).toMatchObject({ recoveryPolicy: "LEGACY_SERIAL", minSpacingMs: 1000, maxInFlight: 1, maxWeightPerMinute: null, restConcurrency: 2 });
    expect(LEGACY_RECOVERY_DEFAULTS).toEqual({ minSpacingMs: 1000, maxInFlight: 1, restConcurrency: 2 });
    expect(parseSupervisorCliArgs(["--profile", "teddy-7-all-active", "--max-weight-per-minute", "1200", "--max-in-flight", "4"])).toMatchObject({ maxWeightPerMinute: 1200, maxInFlight: 4 });
    for (const bad of [["--max-weight-per-minute", "1201"], ["--max-weight-per-minute", "9"], ["--max-in-flight", "5"], ["--max-in-flight", "0"], ["--recovery-policy", "turbo"], ["--request-spacing-ms", "100"]]) {
      expect(() => parseSupervisorCliArgs(["--profile", "teddy-7-all-active", ...bad]), bad.join(" ")).toThrow(SupervisorCliUsageError);
    }
    expect(() => parseSupervisorCliArgs(["--profile", "teddy-7-all-active", "--recovery-policy", "legacy", "--max-weight-per-minute", "300"])).toThrow(SupervisorCliUsageError);
  });

  it("the engine fingerprint, lineage and state namespace are unchanged: recovery speed is not an engine change", () => {
    expect(engineFingerprintOf(N)).toBe("35f1a32d82ac2786ee67dd4c5146760bf1f29d5025cafe01da5394b79a9b47fb");
    const summary = JSON.stringify(profileSummaryOf(N));
    expect(summary).not.toMatch(/FAST_RECOVERY|recoveryPolicy|LEGACY_SERIAL/);
    const lineageSource = readFileSync(path.resolve(__dirname, "../src/modules/native-scanner/scanner-lineage.ts"), "utf8");
    expect(lineageSource).not.toMatch(/FAST_RECOVERY|recoveryPolicy/);
    // The FAST default never budgets more weight per minute than the old worst case (60 req/min x weight 5).
    expect(FAST_RECOVERY_DEFAULTS.maxWeightPerMinute).toBeLessThanOrEqual(60 * 5);
    expect(N.execution.nativeExecutionEnabled).toBe(false);
  });

  it("the recovery modules reach no database, account, signed endpoint or execution path", () => {
    for (const file of ["public-request-weight.ts", "kline-fetcher.ts", "candidate-rank-runner.ts", "live-shadow-supervisor.ts", "live-shadow-supervisor-cli-args.ts"]) {
      const text = readFileSync(path.resolve(__dirname, "../src/modules/native-scanner", file), "utf8");
      expect({ file, hit: text.match(/@prisma|prisma\.|\/execution\/|judgeNativeExecutionAdmission|X-MBX-APIKEY|apiSecret|createHmac/)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });
});
