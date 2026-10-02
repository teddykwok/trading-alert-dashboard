import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { NativeKline } from "@trading-alert-dashboard/shared";

import { GovernedPublicTransport } from "../src/modules/native-scanner/candidate-rank-runner";
import { KlineCacheStore } from "../src/modules/native-scanner/kline-cache";
import { REQUEST_POLICY_LIMITS, type PublicHttpResponse, type PublicHttpTransport } from "../src/modules/native-scanner/kline-fetcher";
import { LiveCheckpointStore } from "../src/modules/native-scanner/live-shadow-checkpoint";
import { parseLineageConfig } from "../src/modules/native-scanner/live-shadow-cli-args";
import type { StreamHandlers } from "../src/modules/native-scanner/live-shadow-runner";
import {
  LiveShadowSupervisor,
  TargetNotReachedError,
  liveShadowDir,
  type SupervisorCandidate,
  type SupervisorSelection,
} from "../src/modules/native-scanner/live-shadow-supervisor";
import { LIVE_SHADOW_LOCK_FILE, acquireLiveShadowLock } from "../src/modules/native-scanner/scanner-lock";
import { parseExchangeInfoContracts, selectUsdtPerpetualUniverse, universeWalk } from "../src/modules/native-scanner/usdm-universe";
import { doji, repeat, type Ohlc } from "./helpers/native-signal-fixtures";
import { FIFTEEN_MINUTES_MS as M15, fifteenMinute } from "./helpers/native-scanner-fakes";

/**
 * Eligible-symbol BACKFILL: --max-symbols N means N SCANNER-ELIGIBLE symbols.
 * Fake public REST and WebSocket, manual clock, temporary directories.
 *
 * Fixture lineage (1D, 7%): the HTF context starts 2025-01-06. A symbol is
 *  - ELIGIBLE      when its bars start at the context start;
 *  - INSUFFICIENT  when its bars start later (2025-01-08): canonical preparation refuses it;
 *  - TOO_NEW       when Binance lists it well after the context start: the free pre-check skips it.
 */

const D = (d: number, h = 0, m = 0, s = 0) => Date.UTC(2025, 0, d, h, m, s);
const L0 = D(11);
const BAR_2345 = D(10, 23, 45);
const CTX = D(6);
const ARGS: Record<string, string> = {
  "--interval": "15m", "--history-start": "2025-01-06T00:00:00Z", "--switchover": "2025-01-10T12:00:00Z", "--min-move-percent": "7",
  "--touch-tolerance-percent": "1", "--cooldown-bars": "10", "--min-bars-after-creation": "5", "--min-bars-after-arming": "4",
  "--source-timeframes": "1D", "--max-levels": "500", "--timing": "Immediate", "--partial-period-policy": "SWITCHOVER_TRUNCATED_CLOSED_BARS",
};
const LINEAGE = parseLineageConfig((n) => ARGS[n]);

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
const lateBars = () => fullBars().filter((b) => b.openTimeMs >= D(8)); // listed after the context start

type Kind = "ELIGIBLE" | "INSUFFICIENT" | "TOO_NEW" | "FAIL_500" | "RATE_LIMIT";
/** Symbol name -> what it is. Onboard dates: eligible/insufficient at or before the context start, too-new days after. */
const kindOf = (symbol: string): Kind =>
  symbol.startsWith("BAD") ? "INSUFFICIENT" : symbol.startsWith("NEW") ? "TOO_NEW" : symbol.startsWith("ERR") ? "FAIL_500" : symbol.startsWith("RATE") ? "RATE_LIMIT" : "ELIGIBLE";
const candidate = (symbol: string, over: Partial<SupervisorCandidate> = {}): SupervisorCandidate => ({
  symbol,
  onboardDateMs: kindOf(symbol) === "TOO_NEW" ? D(8) : CTX - 86_400_000,
  required: false,
  ...over,
});

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  dirs.push(d);
  return d;
};

function harness(selection: SupervisorSelection, options: { root?: string; cacheDir?: string; budget?: number; restConcurrency?: number; jitter?: boolean } = {}) {
  let now = D(10, 23, 59);
  const root = options.root ?? tmp("backfill-root-");
  const cacheDir = options.cacheDir ?? tmp("backfill-cache-");
  const sockets: { url: string; handlers: StreamHandlers; closed: boolean }[] = [];
  const rest: string[] = [];
  const logs: string[] = [];
  const scheduled: Array<() => void> = [];
  const ok = (body: unknown, status = 200): PublicHttpResponse => ({ status, header: () => null, text: async () => JSON.stringify(body) });
  const transport: PublicHttpTransport = async (url) => {
    rest.push(url);
    const u = new URL(url);
    if (options.jitter) for (let i = 0; i < (url.length * 7) % 13; i += 1) await Promise.resolve();
    if (u.pathname === "/fapi/v1/time") return ok({ serverTime: now });
    const symbol = u.searchParams.get("symbol") as string;
    const kind = kindOf(symbol);
    if (kind === "FAIL_500") return ok({}, 500);
    if (kind === "RATE_LIMIT") return ok({}, 429);
    const start = Number(u.searchParams.get("startTime"));
    const end = Number(u.searchParams.get("endTime"));
    const source = kind === "ELIGIBLE" ? fullBars() : lateBars();
    return ok(source.filter((b) => b.openTimeMs >= start && b.openTimeMs <= end && b.closeTimeMs < now).slice(0, Number(u.searchParams.get("limit"))).map((k) => [k.openTimeMs, String(k.open), String(k.high), String(k.low), String(k.close), "1", k.closeTimeMs, "1", 1, "1", "1", "0"]));
  };
  const sleep = async (ms: number) => {
    now += ms;
  };
  const governor = new GovernedPublicTransport(transport, { maxTotalRequests: options.budget ?? 2_000, minSpacingMs: REQUEST_POLICY_LIMITS.minSpacingFloorMs, nowMs: () => now, sleep });
  const supervisor = new LiveShadowSupervisor(
    {
      lineage: LINEAGE,
      selection,
      universeActive: selection.candidates.length,
      onboardPrecheckMarginMs: 86_400_000,
      symbolsPerConnection: 3,
      maxConnections: 8,
      restConcurrency: options.restConcurrency ?? 2,
      queueCapacity: 10_000,
      maxProcessingLagMs: 600_000,
      staleSymbolMs: 1_800_000,
      maxRecoveryAttempts: 3,
      liveDirFor: (symbol) => liveShadowDir(root, symbol, "15m"),
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
    }
  );
  const klineRequestsFor = (symbol: string) => rest.filter((u) => u.includes("/klines") && u.includes(`symbol=${symbol}&`)).length;
  const lockExists = (symbol: string) => existsSync(path.join(liveShadowDir(root, symbol, "15m"), LIVE_SHADOW_LOCK_FILE));
  const send = (symbol: string, at: number, openTimeMs: number, [o, h, l, c]: Ohlc, closed: boolean) => {
    now = at;
    const socket = sockets.filter((s) => !s.closed).find((s) => s.url.includes(`${symbol.toLowerCase()}@kline_15m`));
    socket?.handlers.onMessage(JSON.stringify({ stream: `${symbol.toLowerCase()}@kline_15m`, data: { e: "kline", E: at, s: symbol, k: { t: openTimeMs, T: openTimeMs + M15 - 1, s: symbol, i: "15m", o: String(o), c: String(c), h: String(h), l: String(l), x: closed } } }));
    while (scheduled.length > 0) (scheduled.shift() as () => void)();
  };
  const events = (symbol: string) => {
    const f = path.join(liveShadowDir(root, symbol, "15m"), "events.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8") : "";
  };
  return { supervisor, rest, logs, root, cacheDir, sockets, klineRequestsFor, lockExists, send, events, setNow: (ms: number) => (now = ms) };
}

const target = (symbols: string[], n: number, over: Record<string, Partial<SupervisorCandidate>> = {}): SupervisorSelection => ({
  mode: "TARGET",
  target: n,
  candidates: symbols.map((s) => candidate(s, over[s])),
});
const running = (h: ReturnType<typeof harness>) => h.supervisor.status().symbols.map((s) => s.symbol);

describe("backfill to N scanner-eligible symbols", () => {
  it("1/5. target 5 with an insufficient first candidate: the sixth is accepted; 5 run, 0 runtime failures", async () => {
    const h = harness(target(["BAD1USDT", "AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT", "FFFUSDT"], 5));
    await h.supervisor.start();
    expect(running(h)).toEqual(["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"]);
    const st = h.supervisor.status();
    expect(st.selection).toMatchObject({ mode: "TARGET", targetEligible: 5, candidatesTested: 6, acceptedEligible: 5, skippedInsufficientHistory: 1, skippedTooNew: 0, skippedOther: 0, universeExhausted: false });
    expect(st.totals).toMatchObject({ selected: 5, failed: 0 });
    expect(h.klineRequestsFor("FFFUSDT")).toBe(0); // never tested: the target was already met
  });

  it("2. several insufficient candidates interleaved are backfilled deterministically, in candidate order", async () => {
    const h = harness(target(["AAAUSDT", "BAD1USDT", "BBBUSDT", "BAD2USDT", "CCCUSDT", "DDDUSDT", "BAD3USDT", "EEEUSDT", "FFFUSDT"], 5));
    await h.supervisor.start();
    expect(running(h)).toEqual(["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"]);
    expect(h.supervisor.status().selection?.skipped.map((s) => [s.symbol, s.class])).toEqual([
      ["BAD1USDT", "INSUFFICIENT_HISTORY"],
      ["BAD2USDT", "INSUFFICIENT_HISTORY"],
      ["BAD3USDT", "INSUFFICIENT_HISTORY"],
    ]);
  });

  it("13. the accepted set and every symbol's evidence are independent of concurrency and completion order", async () => {
    const symbols = ["AAAUSDT", "BAD1USDT", "BBBUSDT", "BAD2USDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"];
    const serial = harness(target(symbols, 4), { restConcurrency: 1 });
    const parallel = harness(target(symbols, 4), { restConcurrency: 4, jitter: true });
    await serial.supervisor.start();
    await parallel.supervisor.start();
    expect(running(parallel)).toEqual(running(serial));
    for (const s of running(serial)) {
      expect(parallel.supervisor.status().symbols.find((x) => x.symbol === s)?.lineageId).toBe(serial.supervisor.status().symbols.find((x) => x.symbol === s)?.lineageId);
    }
  });

  it("7/9. the free pre-check skips too-new listings with zero kline requests; canonical preparation still decides everything else", async () => {
    const h = harness(target(["NEW1USDT", "BAD1USDT", "AAAUSDT", "NEW2USDT", "BBBUSDT"], 2));
    await h.supervisor.start();
    expect(running(h)).toEqual(["AAAUSDT", "BBBUSDT"]);
    expect(h.supervisor.status().selection).toMatchObject({ skippedTooNew: 2, skippedInsufficientHistory: 1 });
    expect(h.klineRequestsFor("NEW1USDT")).toBe(0);
    expect(h.klineRequestsFor("NEW2USDT")).toBe(0);
    // BAD1 was listed in time per Binance, so only canonical preparation could reject it — and it did, after fetching.
    expect(h.klineRequestsFor("BAD1USDT")).toBeGreaterThan(0);
  });

  it("8. missing or implausible listing metadata never excludes: it falls through to canonical preparation", async () => {
    const h = harness(
      target(["NEW1USDT", "AAAUSDT", "BBBUSDT", "CCCUSDT", "BAD1USDT"], 4, {
        NEW1USDT: { onboardDateMs: null }, // unknown: not pre-checked; its data is too short, so preparation rejects it
        AAAUSDT: { onboardDateMs: null }, // unknown: eligible, accepted
        BBBUSDT: { onboardDateMs: D(30) }, // "listed in the future" is contradictory: ignored, eligible, accepted
        CCCUSDT: { onboardDateMs: CTX + 43_200_000 }, // after the context start but inside the margin: not proof, eligible, accepted
      })
    );
    await h.supervisor.start();
    expect(running(h)).toEqual(["AAAUSDT", "BBBUSDT", "CCCUSDT"]);
    expect(h.klineRequestsFor("NEW1USDT")).toBeGreaterThan(0);
    expect(h.supervisor.status().selection).toMatchObject({ skippedTooNew: 0, skippedInsufficientHistory: 2, universeExhausted: true, acceptedEligible: 3 });
  });

  it("6. --all-active exhausts the universe: every eligible symbol, every ineligible one skipped by reason", async () => {
    const h = harness({ mode: "ALL_ACTIVE", candidates: ["AAAUSDT", "BAD1USDT", "BBBUSDT", "NEW1USDT", "CCCUSDT", "ERR1USDT"].map((s) => candidate(s)) });
    await h.supervisor.start();
    expect(running(h)).toEqual(["AAAUSDT", "BBBUSDT", "CCCUSDT"]);
    expect(h.supervisor.status().selection).toMatchObject({ mode: "ALL_ACTIVE", targetEligible: null, candidatesTested: 6, acceptedEligible: 3, skippedTooNew: 1, skippedInsufficientHistory: 1, skippedOther: 1, universeExhausted: true });
    expect(h.supervisor.status().totals.failed).toBe(0);
  });

  it("14. rejected candidates own no lock, no stream and no runtime slot", async () => {
    const h = harness(target(["BAD1USDT", "AAAUSDT", "ERR1USDT", "BBBUSDT"], 2));
    await h.supervisor.start();
    for (const s of ["BAD1USDT", "ERR1USDT"]) {
      expect(h.lockExists(s)).toBe(false);
      expect(h.sockets.some((k) => k.url.includes(s.toLowerCase()))).toBe(false);
      expect(running(h)).not.toContain(s);
    }
    for (const s of ["AAAUSDT", "BBBUSDT"]) expect(h.lockExists(s)).toBe(true);
    h.supervisor.stop();
    for (const s of ["AAAUSDT", "BBBUSDT"]) expect(h.lockExists(s)).toBe(false);
  });
});

describe("explicit naming is never substituted", () => {
  it("3. --symbols: an ineligible named symbol is a visible FAILED symbol; nothing replaces it", async () => {
    const h = harness({ mode: "EXPLICIT", candidates: ["AAAUSDT", "BAD1USDT", "NEW1USDT"].map((s) => candidate(s, { required: true })) });
    await h.supervisor.start();
    const st = h.supervisor.status();
    expect(st.symbols.map((s) => [s.symbol, s.status])).toEqual([
      ["AAAUSDT", "ATTACHED"],
      ["BAD1USDT", "FAILED"],
      ["NEW1USDT", "FAILED"],
    ]);
    expect(st.symbols.find((s) => s.symbol === "NEW1USDT")?.failure).toMatch(/^ONBOARD_AFTER_CONTEXT_START/);
    expect(h.klineRequestsFor("NEW1USDT")).toBe(0);
    expect(st.totals.selected).toBe(3);
  });

  it("4. --include-symbols are walked first and never replaced: an ineligible include refuses the start; --exclude removes", async () => {
    const universe = selectUsdtPerpetualUniverse(
      parseExchangeInfoContracts({ symbols: ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT"].map((symbol) => ({ symbol, baseAsset: symbol.slice(0, 3), quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING" })) })
    );
    const walk = universeWalk(universe, { mode: "UNIVERSE", include: ["DDDUSDT"], exclude: ["BBBUSDT"], maxSymbols: 2 });
    expect(walk.map((c) => [c.contract.symbol, c.required])).toEqual([
      ["DDDUSDT", true],
      ["AAAUSDT", false],
      ["CCCUSDT", false],
    ]);
    const h = harness(target(["BAD1USDT", "AAAUSDT", "BBBUSDT"], 2, { BAD1USDT: { required: true } }));
    const failure = await h.supervisor.start().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TargetNotReachedError);
    expect((failure as Error).message).toMatch(/REQUIRED_SYMBOL_INELIGIBLE: BAD1USDT/);
    expect(h.sockets).toEqual([]);
  });
});

describe("request budget and rate limits", () => {
  it("10. budget exhausted before the target: TARGET_NOT_REACHED, nothing started, every lock released", async () => {
    const h = harness(target(["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT"], 4), { budget: 6, restConcurrency: 1 });
    const failure = (await h.supervisor.start().catch((e: unknown) => e)) as TargetNotReachedError;
    expect(failure).toBeInstanceOf(TargetNotReachedError);
    expect(failure.code).toBe("TARGET_NOT_REACHED");
    expect(failure.summary).toMatchObject({ targetEligible: 4, requestsUsed: h.rest.length }); // the governor holds one request in reserve
    expect(h.rest.length).toBeLessThanOrEqual(6);
    expect(failure.summary.acceptedEligible).toBeLessThan(4);
    expect(failure.summary.remainingUniverse).toBeGreaterThan(0);
    // The candidate whose preparation ran out of budget is undecided, not "tested": it is still part of the remaining universe.
    expect(failure.summary.candidatesTested + failure.summary.remainingUniverse).toBe(4);
    expect(h.sockets).toEqual([]);
    for (const s of ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT"]) expect(h.lockExists(s)).toBe(false);
  });

  it("11. a 418/429 halts every further REST request and refuses the start", async () => {
    const h = harness(target(["AAAUSDT", "RATE1USDT", "BBBUSDT", "CCCUSDT"], 3), { restConcurrency: 1 });
    const failure = await h.supervisor.start().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TargetNotReachedError);
    expect((failure as Error).message).toMatch(/REST_HALTED/);
    const halt = h.rest.findIndex((u) => u.includes("symbol=RATE1USDT"));
    expect(h.rest.slice(halt + 1)).toEqual([]);
    expect(h.sockets).toEqual([]);
  });
});

describe("restarts and lineage", () => {
  it("12/15/16/19. a cached restart revalidates cheaply; accepted lineages and checkpoints are those an explicit run builds", async () => {
    const root = tmp("backfill-root-");
    const cacheDir = tmp("backfill-cache-");
    const symbols = ["NEW1USDT", "AAAUSDT", "BAD1USDT", "BBBUSDT", "CCCUSDT"];
    const first = harness(target(symbols, 3), { root, cacheDir });
    await first.supervisor.start();
    const lineages = Object.fromEntries(first.supervisor.status().symbols.map((s) => [s.symbol, s.lineageId]));
    first.supervisor.stop();

    const second = harness(target(symbols, 3), { root, cacheDir });
    await second.supervisor.start();
    expect(running(second)).toEqual(running(first));
    expect(Object.fromEntries(second.supervisor.status().symbols.map((s) => [s.symbol, s.lineageId]))).toEqual(lineages);
    expect(second.logs.filter((l) => l.includes("CATCHUP_OK")).every((l) => /VERIFIED_UNCHANGED|VERIFIED_AND_EXTENDED/.test(l))).toBe(true);
    // Accepted symbols need no kline request at all from a warm cache; too-new listings still cost nothing.
    for (const s of ["AAAUSDT", "BBBUSDT", "CCCUSDT", "NEW1USDT"]) expect(second.klineRequestsFor(s)).toBe(0);
    expect(second.rest.length).toBeLessThan(first.rest.length);

    // The same symbols run EXPLICITLY build the very same lineage and checkpoint body: backfill changes no lineage.
    const explicitRoot = tmp("backfill-root-");
    const explicit = harness({ mode: "EXPLICIT", candidates: ["AAAUSDT", "BBBUSDT", "CCCUSDT"].map((s) => candidate(s, { required: true })) }, { root: explicitRoot, cacheDir });
    await explicit.supervisor.start();
    for (const s of ["AAAUSDT", "BBBUSDT", "CCCUSDT"]) {
      expect(explicit.supervisor.status().symbols.find((x) => x.symbol === s)?.lineageId).toBe(lineages[s]);
      expect(new LiveCheckpointStore(liveShadowDir(explicitRoot, s, "15m")).load()?.body.lineageId).toBe(lineages[s]);
    }
    // And the evidence they write is identical (no cross-symbol contamination from the walk).
    for (const h of [second, explicit]) {
      h.send("AAAUSDT", D(10, 23, 59, 30), BAR_2345, [123, 123, 123, 123], false);
      h.send("AAAUSDT", L0 + 1, BAR_2345, [123, 123, 123, 123], true);
      h.send("AAAUSDT", L0 + 60_000, L0, [123, 123, 121.5, 122], false);
    }
    expect(second.events("AAAUSDT").endsWith(explicit.events("AAAUSDT").split("\n").slice(-4).join("\n"))).toBe(true);
  });
});
