import { describe, expect, it } from "vitest";

import { SignalQualityMarketData, type PublicFetch, type PublicResponse } from "../src/modules/signal-quality/signal-quality-market-data";
import { MINUTE_MS } from "../src/modules/signal-quality/signal-quality-outcome";
import { deriveEmitterHealth, deriveScannerHealth } from "../src/modules/signal-quality/signal-quality-soak-health";
import { assessSoakContinuity, type SoakSnapshotFacts } from "../src/modules/signal-quality/soak-continuity";
import { SoakMonitorUsageError, parseSoakMonitorArgs, snapshotFacts, soakMonitorUrls, soakReportOf, takeSoakSnapshot, type SoakSnapshot } from "../src/modules/signal-quality/soak-monitor";

/**
 * M6.5 — the observatory's public market-data adapter, soak health and the 24h
 * soak monitor (sections 19, 22–24). No network: a fake fetch serves Binance's
 * documented kline row shape and records every URL.
 */

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

function klineRows(url: URL): unknown[] {
  const interval = url.searchParams.get("interval") === "15m" ? 15 * MINUTE_MS : MINUTE_MS;
  const start = Number(url.searchParams.get("startTime"));
  const end = Number(url.searchParams.get("endTime"));
  const limit = Number(url.searchParams.get("limit"));
  const rows: unknown[] = [];
  for (let t = start; t <= end && rows.length < limit; t += interval) {
    rows.push([t, "100.0", "101.0", "99.0", "100.5", "1", t + interval - 1, "1", 1, "1", "1", "0"]);
  }
  return rows;
}

interface FakeOptions {
  status?: number;
  usedWeight?: string;
  retryAfter?: string;
  body?: (url: URL) => unknown;
}

function fakeFetch(options: FakeOptions = {}) {
  const urls: string[] = [];
  const impl: PublicFetch = async (url) => {
    urls.push(url);
    const parsed = new URL(url);
    const headers = new Map<string, string>();
    if (options.usedWeight !== undefined) headers.set("x-mbx-used-weight-1m", options.usedWeight);
    if (options.retryAfter !== undefined) headers.set("retry-after", options.retryAfter);
    const response: PublicResponse = {
      status: options.status ?? 200,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      json: async () => (options.body ? options.body(parsed) : klineRows(parsed)),
    };
    return response;
  };
  return { impl, urls };
}

describe("public market data: unsigned, allowlisted, bounded", () => {
  it("only ever requests fapi.binance.com /fapi/v1/klines, with no key, signature or account parameter", async () => {
    const fake = fakeFetch();
    const now = T0 + 3 * 3_600_000;
    const md = new SignalQualityMarketData({ fetch: fake.impl, now: () => now });
    await md.ensure([{ symbol: "BTCUSDT", fromMs: T0, toMs: T0 + 24 * 3_600_000 }]);
    await md.chartBars("BTCUSDT", T0 - 12 * 3_600_000, now);
    expect(fake.urls.length).toBeGreaterThan(0);
    for (const raw of fake.urls) {
      const url = new URL(raw);
      expect(url.origin).toBe("https://fapi.binance.com");
      expect(url.pathname).toBe("/fapi/v1/klines");
      expect([...url.searchParams.keys()].sort()).toEqual(["endTime", "interval", "limit", "startTime", "symbol"]);
      expect(raw).not.toMatch(/signature|timestamp|recvWindow|apiKey|X-MBX-APIKEY/i);
    }
  });

  it("loads closed minutes only, never past now, and serves a lookup over them", async () => {
    const fake = fakeFetch();
    const now = T0 + 90 * MINUTE_MS + 30_000;
    const md = new SignalQualityMarketData({ fetch: fake.impl, now: () => now });
    await md.ensure([{ symbol: "BTCUSDT", fromMs: T0, toMs: T0 + 24 * 3_600_000 }]);
    const view = md.view({ symbol: "BTCUSDT", fromMs: T0, toMs: T0 + 24 * 3_600_000 });
    expect(view.marketData.status).toBe("LOADED");
    expect(view.coveredThroughMs).toBe(T0 + 90 * MINUTE_MS);
    if (view.marketData.status !== "LOADED") throw new Error("expected LOADED");
    expect(view.marketData.bars(T0 + 89 * MINUTE_MS)).toMatchObject({ high: 101, low: 99 });
    expect(view.marketData.bars(T0 + 90 * MINUTE_MS)).toBeUndefined();
  });

  it("a refresh fetches only the new tail; many alerts on one symbol share one series", async () => {
    const fake = fakeFetch();
    let now = T0 + 60 * MINUTE_MS;
    const md = new SignalQualityMarketData({ fetch: fake.impl, now: () => now });
    await md.ensure([
      { symbol: "ETHUSDT", fromMs: T0, toMs: T0 + 24 * 3_600_000 },
      { symbol: "ETHUSDT", fromMs: T0 + 10 * MINUTE_MS, toMs: T0 + 25 * 3_600_000 },
    ]);
    expect(fake.urls).toHaveLength(1);
    now += 5 * MINUTE_MS;
    await md.ensure([{ symbol: "ETHUSDT", fromMs: T0, toMs: T0 + 24 * 3_600_000 }]);
    expect(fake.urls).toHaveLength(2);
    const tail = new URL(fake.urls[1]);
    expect([Number(tail.searchParams.get("startTime")), Number(tail.searchParams.get("limit"))]).toEqual([T0 + 60 * MINUTE_MS, 5]);
  });

  it("the weight budget stops requests; what was not loaded is NOT_LOADED, never guessed", async () => {
    const fake = fakeFetch();
    const md = new SignalQualityMarketData({ fetch: fake.impl, now: () => T0 + 30 * 3_600_000, weightPerMinute: 5 });
    const result = await md.ensure([
      { symbol: "AAAUSDT", fromMs: T0, toMs: T0 + 1000 * MINUTE_MS },
      { symbol: "BBBUSDT", fromMs: T0, toMs: T0 + 1000 * MINUTE_MS },
    ]);
    expect(result).toEqual({ loaded: 1, skipped: 1 });
    expect(fake.urls).toHaveLength(1);
    expect(md.view({ symbol: "BBBUSDT", fromMs: T0, toMs: T0 + MINUTE_MS }).marketData).toMatchObject({ status: "NOT_LOADED" });
  });

  it("pauses when Binance reports the IP's used weight at or above 1200 (the scanner shares the IP)", async () => {
    const fake = fakeFetch({ usedWeight: "1250" });
    const md = new SignalQualityMarketData({ fetch: fake.impl, now: () => T0 + 30 * 3_600_000 });
    await md.ensure([{ symbol: "AAAUSDT", fromMs: T0, toMs: T0 + 100 * MINUTE_MS }]);
    await md.ensure([{ symbol: "BBBUSDT", fromMs: T0, toMs: T0 + 100 * MINUTE_MS }]);
    expect(fake.urls).toHaveLength(1);
    expect(md.stats()).toMatchObject({ lastUsedWeightReported: 1250 });
    expect(md.stats().pausedUntil).not.toBeNull();
  });

  it("429 / 418 pause the adapter and the symbol reads UNAVAILABLE; a malformed payload is UNAVAILABLE too; nothing throws", async () => {
    const limited = new SignalQualityMarketData({ fetch: fakeFetch({ status: 429, retryAfter: "120" }).impl, now: () => T0 + 30 * 3_600_000 });
    await expect(limited.ensure([{ symbol: "AAAUSDT", fromMs: T0, toMs: T0 + 100 * MINUTE_MS }])).resolves.toBeDefined();
    expect(limited.view({ symbol: "AAAUSDT", fromMs: T0, toMs: T0 + MINUTE_MS }).marketData).toMatchObject({ status: "UNAVAILABLE" });
    expect(limited.stats().pausedUntil).not.toBeNull();
    const malformed = new SignalQualityMarketData({ fetch: fakeFetch({ body: () => [["not", "a", "kline"]] }).impl, now: () => T0 + 30 * 3_600_000 });
    await malformed.ensure([{ symbol: "AAAUSDT", fromMs: T0, toMs: T0 + 100 * MINUTE_MS }]);
    expect(malformed.view({ symbol: "AAAUSDT", fromMs: T0, toMs: T0 + MINUTE_MS }).marketData).toMatchObject({ status: "UNAVAILABLE" });
    const rejecting = new SignalQualityMarketData({ fetch: async () => { throw new Error("ENOTFOUND"); }, now: () => T0 + 30 * 3_600_000 });
    await rejecting.ensure([{ symbol: "AAAUSDT", fromMs: T0, toMs: T0 + 100 * MINUTE_MS }]);
    expect(rejecting.view({ symbol: "AAAUSDT", fromMs: T0, toMs: T0 + MINUTE_MS }).marketData).toMatchObject({ status: "UNAVAILABLE" });
    expect(await rejecting.chartBars("AAAUSDT", T0, T0 + 3_600_000)).toMatchObject({ error: expect.any(String) });
  });

  it("the cache is capped in minutes; the least recently used symbol is evicted first", async () => {
    const md = new SignalQualityMarketData({ fetch: fakeFetch().impl, now: () => T0 + 30 * 3_600_000, maxCachedMinutes: 150 });
    await md.ensure([{ symbol: "AAAUSDT", fromMs: T0, toMs: T0 + 100 * MINUTE_MS }]);
    await md.ensure([{ symbol: "BBBUSDT", fromMs: T0, toMs: T0 + 100 * MINUTE_MS }]);
    expect(md.stats()).toMatchObject({ symbolsCached: 1, minutesCached: 100 });
    expect(md.view({ symbol: "AAAUSDT", fromMs: T0, toMs: T0 + MINUTE_MS }).marketData.status).toBe("NOT_LOADED");
    expect(md.view({ symbol: "BBBUSDT", fromMs: T0, toMs: T0 + MINUTE_MS }).marketData.status).toBe("LOADED");
  });

  it("chart bars are 15-minute, closed only, and cached", async () => {
    const fake = fakeFetch();
    const now = T0 + 6 * 3_600_000 + 7 * MINUTE_MS;
    const md = new SignalQualityMarketData({ fetch: fake.impl, now: () => now });
    const result = await md.chartBars("BTCUSDT", T0, now);
    if (!("bars" in result)) throw new Error("expected bars");
    expect(result.bars.every((b) => b.time * 1000 + 15 * MINUTE_MS <= now)).toBe(true);
    await md.chartBars("BTCUSDT", T0, now);
    expect(fake.urls).toHaveLength(1);
    expect(new URL(fake.urls[0]).searchParams.get("interval")).toBe("15m");
  });

  it("a Unicode Binance symbol is sent percent-encoded, unchanged", async () => {
    const fake = fakeFetch();
    const md = new SignalQualityMarketData({ fetch: fake.impl, now: () => T0 + 3_600_000 });
    await md.ensure([{ symbol: "币安人生USDT", fromMs: T0, toMs: T0 + 30 * MINUTE_MS }]);
    expect(new URL(fake.urls[0]).searchParams.get("symbol")).toBe("币安人生USDT");
  });
});

// ===========================================================================
// Soak health
// ===========================================================================

describe("soak health from the status files the stack already writes", () => {
  const now = T0 + 3_600_000;
  const scanner = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema: "teddy.native-scanner.live-shadow-supervisor-status.v3",
      runId: "20261001T110000Z-abcd1234",
      runState: "RUNNING",
      startedAt: new Date(T0 - 3_600_000).toISOString(),
      writtenAt: new Date(now - 30_000).toISOString(),
      engineFingerprint: "f".repeat(64),
      selection: { targetEligible: 471, acceptedEligible: 471 },
      totals: { selected: 520, liveEligible: 518, quarantined: 1, recovering: 0, awaitingStream: 1, failed: 0, reconnects: 3, backpressureEvents: 0 },
      universe: { exchangeCandidates: 528, generation: 4, stale: false, capacity: { exceeded: false } },
      symbols: [{ lastValidMessageAt: new Date(now - 5_000).toISOString() }, { lastValidMessageAt: new Date(now - 2_000).toISOString() }],
      ...over,
    });
  it("reads the dynamic universe as reported (no fixed symbol count), the newest market-data instant, and freshness", () => {
    const health = deriveScannerHealth(scanner(), now);
    expect(health).toMatchObject({ state: "RUNNING", runId: "20261001T110000Z-abcd1234", lastMarketDataAt: new Date(now - 2_000).toISOString(), reconnects: 3 });
    expect(health.universe).toEqual({ exchangeCandidates: 528, generation: 4, stale: false, selected: 520, liveEligible: 518, quarantined: 1, recovering: 0, awaitingStream: 1, failed: 0, capacityExceeded: false });
    expect(deriveScannerHealth(scanner({ writtenAt: new Date(now - 10 * 60_000).toISOString() }), now).state).toBe("STALE");
    expect(deriveScannerHealth(null, now).state).toBe("UNKNOWN");
  });
  it("the emitter is RUNNING only with a fresh status, and its queue depth and duplicates are shown", () => {
    const text = (writtenAtMs: number) => JSON.stringify({ schema: "teddy.native-alerts.multi-emitter-status.v1", mode: "COMMIT_DASHBOARD_ALERTS", writtenAt: new Date(writtenAtMs).toISOString(), created: 41, queueDepth: 0, maxQueueDepth: 3, ledgerDuplicates: 0, symbolsTracked: 520, symbolsHealthy: 520, symbolsFailed: 0 });
    expect(deriveEmitterHealth(text(now - 20_000), now)).toMatchObject({ state: "RUNNING", created: 41, queueDepth: 0, ledgerDuplicates: 0 });
    expect(deriveEmitterHealth(text(now - 10 * 60_000), now).state).toBe("STALE");
    expect(deriveEmitterHealth(null, now).state).toBe("UNKNOWN");
    expect(deriveEmitterHealth("{not json", now).state).toBe("UNKNOWN");
  });
});

// ===========================================================================
// Soak continuity
// ===========================================================================

describe("24h soak continuity: CONTINUOUS only when it really was", () => {
  const plan = { soakStartMs: T0, expectedSoakEndMs: T0 + 24 * 3_600_000, intervalMs: 15 * MINUTE_MS };
  const healthy = (takenAtMs: number, over: Partial<SoakSnapshotFacts> = {}): SoakSnapshotFacts => ({ takenAtMs, backendReachable: true, scannerState: "RUNNING", scannerRunId: "run-1", emitterState: "RUNNING", ...over });
  const every15 = (from: number, to: number) => {
    const out: SoakSnapshotFacts[] = [];
    for (let t = from; t <= to; t += 15 * MINUTE_MS) out.push(healthy(t));
    return out;
  };
  it("snapshots every 15 minutes across the whole window, all healthy: CONTINUOUS, with an actual end", () => {
    const c = assessSoakContinuity(plan, every15(T0, T0 + 24 * 3_600_000), T0 + 24 * 3_600_000 + 1);
    expect(c).toMatchObject({ verdict: "CONTINUOUS", interruptions: [], snapshots: 97, actualSoakEnd: new Date(T0 + 24 * 3_600_000).toISOString() });
  });
  it("still running and healthy: IN_PROGRESS, never claimed continuous early", () => {
    expect(assessSoakContinuity(plan, every15(T0, T0 + 3_600_000), T0 + 3_600_000 + 60_000).verdict).toBe("IN_PROGRESS");
  });
  it("a two-hour hole (sleep, lid closed, crash) is SOAK_INTERRUPTED: MONITOR_GAP", () => {
    const snaps = [...every15(T0, T0 + 5 * 3_600_000), ...every15(T0 + 7 * 3_600_000, T0 + 24 * 3_600_000)];
    const c = assessSoakContinuity(plan, snaps, T0 + 25 * 3_600_000);
    expect(c.verdict).toBe("SOAK_INTERRUPTED");
    expect(c.interruptions.map((i) => i.kind)).toEqual(["MONITOR_GAP"]);
  });
  it("a scanner restart, a stopped scanner, a stale emitter or an unreachable backend each interrupt the soak", () => {
    const base = every15(T0, T0 + 24 * 3_600_000);
    const mutate = (index: number, over: Partial<SoakSnapshotFacts>) => base.map((s, i) => (i === index ? { ...s, ...over } : i > index && over.scannerRunId ? { ...s, scannerRunId: over.scannerRunId } : s));
    const kinds = (snaps: SoakSnapshotFacts[]) => assessSoakContinuity(plan, snaps, T0 + 25 * 3_600_000).interruptions.map((i) => i.kind);
    expect(kinds(mutate(40, { scannerRunId: "run-2" }))).toEqual(["SCANNER_RESTARTED"]);
    expect(kinds(mutate(40, { scannerState: "STALE" }))).toEqual(["SCANNER_NOT_RUNNING"]);
    expect(kinds(mutate(40, { emitterState: "STALE" }))).toEqual(["EMITTER_NOT_RUNNING"]);
    expect(kinds(mutate(40, { backendReachable: false }))).toEqual(["BACKEND_UNREACHABLE"]);
  });
  it("starting late or stopping early is an interruption; no snapshot at all is too", () => {
    expect(assessSoakContinuity(plan, every15(T0 + 2 * 3_600_000, T0 + 24 * 3_600_000), T0 + 25 * 3_600_000).interruptions.map((i) => i.kind)).toEqual(["MONITOR_STARTED_LATE"]);
    expect(assessSoakContinuity(plan, every15(T0, T0 + 20 * 3_600_000), T0 + 25 * 3_600_000).interruptions.map((i) => i.kind)).toEqual(["MONITOR_ENDED_EARLY"]);
    expect(assessSoakContinuity(plan, [], T0 + 25 * 3_600_000)).toMatchObject({ verdict: "SOAK_INTERRUPTED", snapshots: 0 });
  });
});

// ===========================================================================
// The soak monitor
// ===========================================================================

describe("the soak monitor is read-only by construction", () => {
  it("parses its arguments strictly: --out required, a plain http(s) origin, bounded hours and cadence", () => {
    const args = parseSoakMonitorArgs(["--out", "C:/soak", "--soak-start", "2026-10-21T08:00:00Z"], T0);
    expect(args).toMatchObject({ baseUrl: "http://127.0.0.1:4000", soakStartMs: Date.parse("2026-10-21T08:00:00Z"), soakHours: 24, everyMinutes: 15, once: false });
    for (const bad of [[], ["--out"], ["--out", "x", "--soak-hours", "73"], ["--out", "x", "--every-minutes", "0"], ["--out", "x", "--base-url", "http://user:pw@127.0.0.1:4000"], ["--out", "x", "--soak-start", "yesterday"], ["--out", "x", "--rogue"]]) {
      expect(() => parseSoakMonitorArgs(bad, T0), bad.join(" ")).toThrow(SoakMonitorUsageError);
    }
  });
  it("requests only GETs of read-only backend routes", () => {
    const urls = Object.values(soakMonitorUrls({ baseUrl: "http://127.0.0.1:4000", soakStartMs: T0, soakHours: 24 }));
    expect(urls.map((u) => new URL(u).pathname)).toEqual(["/health", "/api/signal-sources/status", "/api/native-planner/status", "/api/signal-quality/soak-health", "/api/signal-quality/summary"]);
  });
  it("a snapshot records what each route said, and the report judges continuity from the snapshots", async () => {
    const args = parseSoakMonitorArgs(["--out", "C:/soak", "--soak-start", new Date(T0).toISOString(), "--soak-hours", "1"], T0);
    const seen: string[] = [];
    const get = async (url: string) => {
      seen.push(url);
      return { ok: true, status: 200, body: url.endsWith("/soak-health") ? { scanner: { state: "RUNNING", runId: "run-1" }, emitter: { state: "RUNNING" } } : {}, error: null };
    };
    const snapshots: SoakSnapshot[] = [];
    for (let t = T0; t <= T0 + 3_600_000; t += 15 * MINUTE_MS) snapshots.push(await takeSoakSnapshot(args, get, t));
    expect(seen).toHaveLength(25);
    expect(snapshotFacts(snapshots[0])).toEqual({ takenAtMs: T0, backendReachable: true, scannerState: "RUNNING", scannerRunId: "run-1", emitterState: "RUNNING" });
    const report = soakReportOf(args, snapshots, T0 + 3_600_000 + 1);
    expect(report.continuity.verdict).toBe("CONTINUOUS");
    expect(report.notice).toEqual(expect.arrayContaining(["MONITORING ONLY", "NO EXECUTION AUTHORITY"]));
  });
});
