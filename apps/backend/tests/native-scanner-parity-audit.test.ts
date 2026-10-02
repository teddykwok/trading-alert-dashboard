import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { NativeKline } from "@trading-alert-dashboard/shared";

import type { CompatReplayRecord } from "../src/modules/native-scanner/compat-replay";
import { KlineCacheStore } from "../src/modules/native-scanner/kline-cache";
import type { PublicHttpResponse, PublicHttpTransport } from "../src/modules/native-scanner/kline-fetcher";
import { parseLineageConfig } from "../src/modules/native-scanner/live-shadow-cli-args";
import {
  ASSESSABLE_CATEGORIES,
  EXPLAINED_CATEGORIES,
  buildParityReport,
  classifyTvAlert,
  nativeOnlyEvents,
  parseTvEvidence,
  tally,
  type ParityScope,
  type TvAlert,
} from "../src/modules/native-scanner/parity-audit";
import { ParityAuditError, runParityAudit } from "../src/modules/native-scanner/parity-audit-runner";
import { doji, repeat, type Ohlc } from "./helpers/native-signal-fixtures";
import { FIFTEEN_MINUTES_MS as M15, fifteenMinute, manualClock } from "./helpers/native-scanner-fakes";

/**
 * scanner:parity-audit — the classifier, the evidence parser and the runner,
 * with no network: Binance is an in-memory fake on the crafted 1D fixture.
 */

const BAR = Date.UTC(2026, 8, 20, 10, 15);
const SCOPE: ParityScope = { chartInterval: "15m", timing: "Immediate", minMovePercent: 7, switchoverMs: Date.UTC(2026, 8, 12, 1), endMs: Date.UTC(2026, 8, 30, 12, 30) };

const tv = (over: Partial<TvAlert> = {}): TvAlert => ({
  id: "tv1",
  symbol: "AAAUSDT",
  chartTimeframe: "15m",
  levelPrice: 0.5,
  signal: "LONG",
  sourceTf: "1D",
  levelColor: "GREEN",
  touchDirection: "FROM_ABOVE",
  triggeredAtMs: BAR + 60_000,
  barOpenTimeMs: BAR,
  alertTiming: "Immediate",
  eventType: "LEVEL_TOUCHED",
  minMovePercent: 7,
  duplicateCount: 0,
  ...over,
});

const rec = (over: Partial<CompatReplayRecord> = {}): CompatReplayRecord =>
  ({
    symbol: "AAAUSDT",
    chartBarOpenTimeMs: BAR,
    basis: "IMMEDIATE_INTRABAR",
    evidenceClass: "PROVEN_INTRABAR_POSSIBLE",
    signal: "LONG",
    touchDirection: "FROM_ABOVE",
    sourceTf: "1D",
    levelColor: "GREEN",
    levelPrice: 0.5,
    levelKey: "1D:GOR:1",
    ...over,
  }) as CompatReplayRecord;

const byBar = (records: CompatReplayRecord[]) => {
  const m = new Map<number, CompatReplayRecord[]>();
  for (const r of records) m.set(r.chartBarOpenTimeMs, [...(m.get(r.chartBarOpenTimeMs) ?? []), r]);
  return m;
};

describe("classifying a TradingView alert against the canonical reconstruction", () => {
  it("EXACT_EXPLAINED keeps every evidence class separate", () => {
    const r = classifyTvAlert(tv(), byBar([rec(), rec({ basis: "COMMITTED_BAR_CLOSE", evidenceClass: "COMMITTED_BAR_CLOSE" })]), SCOPE);
    expect(r).toMatchObject({ category: "EXACT_EXPLAINED", matchedLevelKeys: ["1D:GOR:1"], evidence: { immediateProven: 1, immediatePossibleOnly: 0, committed: 1 } });
  });

  it("EXPLAINED_AMBIGUOUS_LEVEL when two distinct native levels share the exact price", () => {
    const r = classifyTvAlert(tv(), byBar([rec(), rec({ levelKey: "1D:GOR:2", evidenceClass: "POSSIBLE_ONLY" })]), SCOPE);
    expect(r).toMatchObject({ category: "EXPLAINED_AMBIGUOUS_LEVEL", matchedLevelKeys: ["1D:GOR:1", "1D:GOR:2"], evidence: { immediateProven: 1, immediatePossibleOnly: 1 } });
  });

  it("SOURCE_TF_MISMATCH, DIRECTION_MISMATCH, BAR_MATCH_LEVEL_MISMATCH and NO_NATIVE_EXPLANATION, in that precedence", () => {
    expect(classifyTvAlert(tv(), byBar([rec({ sourceTf: "1W" })]), SCOPE).category).toBe("SOURCE_TF_MISMATCH");
    expect(classifyTvAlert(tv(), byBar([rec({ signal: "SHORT", touchDirection: "FROM_BELOW", levelColor: "RED" })]), SCOPE).category).toBe("DIRECTION_MISMATCH");
    expect(classifyTvAlert(tv(), byBar([rec({ levelPrice: 0.5001 })]), SCOPE)).toMatchObject({ category: "BAR_MATCH_LEVEL_MISMATCH", nativeOnBar: ["1D/GREEN/LONG/0.5001/PROVEN_INTRABAR_POSSIBLE"] });
    expect(classifyTvAlert(tv(), byBar([rec({ chartBarOpenTimeMs: BAR + M15 })]), SCOPE)).toMatchObject({ category: "NO_NATIVE_EXPLANATION", detail: "no native candidate on this bar" });
    // A level price one ulp away is NOT a match: no tolerance is invented.
    expect(classifyTvAlert(tv({ levelPrice: 0.1 + 0.2 }), byBar([rec({ levelPrice: 0.3 })]), SCOPE).category).toBe("BAR_MATCH_LEVEL_MISMATCH");
  });

  it("OUTSIDE_LINEAGE_WINDOW, INSUFFICIENT_CONTEXT and UNSUPPORTED_DATA are never counted as mismatches", () => {
    expect(classifyTvAlert(tv({ barOpenTimeMs: SCOPE.switchoverMs - M15 }), byBar([]), SCOPE).category).toBe("OUTSIDE_LINEAGE_WINDOW");
    expect(classifyTvAlert(tv(), null, SCOPE, "INSUFFICIENT_HISTORY: listed late")).toMatchObject({ category: "INSUFFICIENT_CONTEXT", detail: "INSUFFICIENT_HISTORY: listed late" });
    expect(classifyTvAlert(tv({ barOpenTimeMs: SCOPE.endMs }), byBar([]), SCOPE).category).toBe("INSUFFICIENT_CONTEXT");
    for (const over of [{ barOpenTimeMs: null }, { chartTimeframe: "1h" }, { alertTiming: "Bar Close" }, { minMovePercent: 0 }, { eventType: "LEVEL_CREATED" }]) {
      expect(classifyTvAlert(tv(over), byBar([rec()]), SCOPE).category).toBe("UNSUPPORTED_DATA");
    }
    expect(ASSESSABLE_CATEGORIES).not.toContain("OUTSIDE_LINEAGE_WINDOW");
    expect(ASSESSABLE_CATEGORIES).not.toContain("INSUFFICIENT_CONTEXT");
    expect(ASSESSABLE_CATEGORIES).not.toContain("UNSUPPORTED_DATA");
  });

  it("explainability is explained / assessable, and native-only candidates are reported, never called false positives", () => {
    const rows = [
      classifyTvAlert(tv({ id: "a" }), byBar([rec()]), SCOPE),
      classifyTvAlert(tv({ id: "b", levelPrice: 0.6 }), byBar([rec()]), SCOPE),
      classifyTvAlert(tv({ id: "c", barOpenTimeMs: 1 }), byBar([]), SCOPE),
    ];
    expect(tally(rows)).toMatchObject({ total: 3, assessable: 2, explained: 1, explainabilityRate: 0.5 });
    expect(EXPLAINED_CATEGORIES).toEqual(["EXACT_EXPLAINED", "EXPLAINED_AMBIGUOUS_LEVEL"]);
    const only = nativeOnlyEvents([rec(), rec({ chartBarOpenTimeMs: BAR + M15, levelPrice: 0.7, evidenceClass: "POSSIBLE_ONLY" })], [tv()], SCOPE.switchoverMs, SCOPE.endMs);
    expect(only).toMatchObject({ nativeLogicalEvents: 2, matchedByTradingView: 1, withoutTradingViewAlert: { onBarsWithNoTradingViewAlert: 1, byStrongestEvidence: { POSSIBLE_ONLY: 1 } } });
    expect(only.withoutTradingViewAlert.interpretation).toMatch(/NOT false positives/);
  });

  it("the report is deterministic whatever the input order", () => {
    const rows = ["d", "a", "c", "b"].map((id, i) => classifyTvAlert(tv({ id, symbol: `S${i}USDT`, levelPrice: i % 2 ? 0.5 : 0.6 }), byBar([rec({ symbol: `S${i}USDT` })]), SCOPE));
    expect(JSON.stringify(buildParityReport([...rows].reverse(), 5))).toBe(JSON.stringify(buildParityReport(rows, 5)));
  });
});

describe("the evidence parser is strict", () => {
  const line = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ id: "x", symbol: "AAAUSDT", chartTimeframe: "15m", price: 0.5, signal: "LONG", sourceTimeframe: "1D", levelColor: "GREEN", touchDirection: "FROM_ABOVE", triggeredAt: "2026-09-20T10:16:00Z", raw: { barTime: "2026-09-20T10:15:00Z" }, noteAlertTiming: "Immediate", eventType: "LEVEL_TOUCHED", indicatorValue: 7, duplicateCount: 0, ...over }) + "\n";
  it("refuses torn, malformed, duplicate or incomplete rows", () => {
    expect(parseTvEvidence(line())[0]).toMatchObject({ levelPrice: 0.5, barOpenTimeMs: Date.UTC(2026, 8, 20, 10, 15) });
    expect(parseTvEvidence(line({ raw: { barTime: null } }))[0].barOpenTimeMs).toBeNull();
    expect(() => parseTvEvidence(line().slice(0, -1))).toThrow(/torn/);
    expect(() => parseTvEvidence(line() + line())).toThrow(/duplicate alert id/);
    expect(() => parseTvEvidence(line({ price: "0.5" }))).toThrow(/price/);
    expect(() => parseTvEvidence(line({ signal: "BUY" }))).toThrow(/signal/);
    expect(() => parseTvEvidence("{nope\n")).toThrow(/not JSON/);
  });
});

// ---------------------------------------------------------------------------
// The runner end to end, on the crafted fixture (1D, 7%): L0 touches GREEN 121 and GREEN 120.
// ---------------------------------------------------------------------------

const D = (d: number, h = 0, m = 0) => Date.UTC(2025, 0, d, h, m);
const L0 = D(11);
const ARGS: Record<string, string> = {
  "--interval": "15m", "--history-start": "2025-01-06T00:00:00Z", "--switchover": "2025-01-10T12:00:00Z", "--min-move-percent": "7",
  "--touch-tolerance-percent": "1", "--cooldown-bars": "10", "--min-bars-after-creation": "5", "--min-bars-after-arming": "4",
  "--source-timeframes": "1D", "--max-levels": "500", "--timing": "Immediate", "--partial-period-policy": "SWITCHOVER_TRUNCATED_CLOSED_BARS",
};
const LINEAGE = parseLineageConfig((n) => ARGS[n]);
function bars(): NativeKline[] {
  const rows: Ohlc[] = [];
  rows.push(...repeat(doji(100), 96));
  rows.push([100, 120, 99, 99], ...repeat(doji(99), 95));
  rows.push(...repeat(doji(99), 96));
  rows.push([99, 121, 98.5, 99], ...repeat(doji(99), 94), [99, 99, 98.9, 98.9]);
  rows.push([98.9, 123, 98.9, 123], ...repeat(doji(123), 95));
  rows.push([123, 123, 119.5, 122.5], ...repeat(doji(122.5), 8));
  return fifteenMinute(D(6), rows);
}
const evidenceLine = (id: string, symbol: string, price: number, tf = "1D", barMs = L0) =>
  JSON.stringify({ id, symbol, chartTimeframe: "15m", price, signal: "LONG", sourceTimeframe: tf, levelColor: "GREEN", touchDirection: "FROM_ABOVE", triggeredAt: new Date(barMs + 60_000).toISOString(), raw: { barTime: new Date(barMs).toISOString() }, noteAlertTiming: "Immediate", eventType: "LEVEL_TOUCHED", indicatorValue: 7, duplicateCount: 0 }) + "\n";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function harness(evidence: string, opts: { failKlines?: string[] } = {}) {
  const clock = manualClock(D(12));
  const calls: string[] = [];
  const ok = (body: unknown, status = 200): PublicHttpResponse => ({ status, header: () => null, text: async () => JSON.stringify(body) });
  const transport: PublicHttpTransport = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === "/fapi/v1/exchangeInfo") return ok({ symbols: [] });
    if (u.pathname === "/fapi/v1/time") return ok({ serverTime: D(12) });
    const symbol = u.searchParams.get("symbol") as string;
    if (opts.failKlines?.includes(symbol)) return ok({}, 500);
    const start = Number(u.searchParams.get("startTime"));
    const end = Number(u.searchParams.get("endTime"));
    return ok(bars().filter((b) => b.openTimeMs >= start && b.openTimeMs <= end).slice(0, Number(u.searchParams.get("limit"))).map((k) => [k.openTimeMs, String(k.open), String(k.high), String(k.low), String(k.close), "1", k.closeTimeMs, "1", 1, "1", "1", "0"]));
  };
  const cacheDir = mkdtempSync(path.join(tmpdir(), "parity-audit-"));
  dirs.push(cacheDir);
  return {
    calls,
    run: (over: Partial<Parameters<typeof runParityAudit>[0]> = {}) =>
      runParityAudit(
        { lineage: LINEAGE, minMovePercent: 7, evidenceText: evidence, expectedEvidenceSha256: createHash("sha256").update(evidence).digest("hex"), symbols: null, maxSymbols: null, concurrency: 2, cacheOnly: false, sampleSize: 5, ...over },
        { transport, baseUrl: "https://fapi.binance.com", maxTotalRequests: 500, minSpacingMs: 250, cache: new KlineCacheStore(cacheDir), nowMs: clock.nowMs, nowIso: () => "2025-01-12T00:00:00.000Z", sleep: clock.sleep, log: () => undefined }
      ),
  };
}

describe("the parity runner", () => {
  const evidence =
    evidenceLine("e1", "TESTUSDT", 121) + // exact: GREEN 121 fired at L0
    evidenceLine("e2", "TESTUSDT", 121.5) + // no such level
    evidenceLine("e3", "BADUSDT", 121) + // fetch fails: insufficient context
    evidenceLine("e4", "TESTUSDT", 121, "1D", D(10, 6)); // before the switchover

  it("explains the real touch, classifies the rest, and never lets one symbol's failure touch another", async () => {
    const h = harness(evidence, { failKlines: ["BADUSDT"] });
    const result = await h.run();
    const byId = Object.fromEntries(result.rows.map((r) => [r.tvId, r]));
    expect(byId.e1).toMatchObject({ category: "EXACT_EXPLAINED", matchedLevelKeys: [expect.stringMatching(/^1D:GOR:/)] });
    // The native side DID fire GREEN 1D LONG on L0 — at 121 and 120, never at 121.5.
    expect(byId.e2.category).toBe("BAR_MATCH_LEVEL_MISMATCH");
    expect(byId.e2.diagnostic).toBe("DATA_FEED_LEVEL_NOT_IN_BINANCE_OHLC");
    expect(byId.e3).toMatchObject({ category: "INSUFFICIENT_CONTEXT" });
    expect(byId.e3.detail).toMatch(/PUBLIC_FETCH_FAILED/);
    expect(byId.e4.category).toBe("OUTSIDE_LINEAGE_WINDOW");
    expect(result.report.inLineageWindow).toMatchObject({ assessable: 2, explained: 1 });
    expect(result.report.binanceDerivable).toMatchObject({ assessable: 1, explained: 1, explainabilityRate: 1 });
    expect(result.notice).toContain("No false-positive rate is claimed: the export holds positives only");
  });

  it("an unexplained alert on the switchover bar itself is diagnosed, never a crash", async () => {
    const atSwitchover = evidenceLine("s1", "TESTUSDT", 99.5, "1D", D(10, 12)) + evidenceLine("s2", "TESTUSDT", 121);
    const result = await harness(atSwitchover).run();
    const s1 = result.rows.find((r) => r.tvId === "s1");
    expect(s1).toMatchObject({ category: "NO_NATIVE_EXPLANATION", diagnostic: "AT_SWITCHOVER_BAR" });
    expect(result.rows.find((r) => r.tvId === "s2")?.category).toBe("EXACT_EXPLAINED");
  });

  it("is deterministic: the same evidence and bytes give the same report and row hashes", async () => {
    const a = await harness(evidence, { failKlines: ["BADUSDT"] }).run();
    const b = await harness(evidence, { failKlines: ["BADUSDT"] }).run();
    expect([a.reportSha256, a.rowsSha256]).toEqual([b.reportSha256, b.rowsSha256]);
  });

  it("refuses unverified evidence, and cache-only never touches the network for klines", async () => {
    const h = harness(evidence);
    await expect(h.run({ expectedEvidenceSha256: "0".repeat(64) })).rejects.toBeInstanceOf(ParityAuditError);
    expect(h.calls).toEqual([]);
    const cached = await harness(evidence).run({ cacheOnly: true });
    expect(cached.rows.find((r) => r.tvId === "e1")?.category).toBe("INSUFFICIENT_CONTEXT");
    await expect(harness(evidence).run({ symbols: ["NOPEUSDT"] })).rejects.toThrow(/no in-window TradingView alert/);
  });
});
