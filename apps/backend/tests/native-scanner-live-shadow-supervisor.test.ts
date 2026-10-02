import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { NativeKline } from "@trading-alert-dashboard/shared";

import { GovernedPublicTransport } from "../src/modules/native-scanner/candidate-rank-runner";
import { KlineCacheStore } from "../src/modules/native-scanner/kline-cache";
import { REQUEST_POLICY_LIMITS, type PublicHttpResponse, type PublicHttpTransport } from "../src/modules/native-scanner/kline-fetcher";
import {
  LiveStreamError,
  assertPublicCombinedKlineStreamUrl,
  buildPublicCombinedKlineStreamUrl,
  parseCombinedStreamEnvelope,
} from "../src/modules/native-scanner/live-kline-stream";
import { LiveCheckpointStore } from "../src/modules/native-scanner/live-shadow-checkpoint";
import { parseLineageConfig } from "../src/modules/native-scanner/live-shadow-cli-args";
import { LiveShadowRunner, type StreamHandlers } from "../src/modules/native-scanner/live-shadow-runner";
import { LiveShadowSession, prepareLiveShadowState } from "../src/modules/native-scanner/live-shadow-session";
import { LiveShadowEventStore } from "../src/modules/native-scanner/live-shadow-store";
import { LiveShadowSupervisor, SupervisorConfigError, assignConnections, liveShadowDir } from "../src/modules/native-scanner/live-shadow-supervisor";
import { SupervisorCliUsageError, parseSupervisorCliArgs } from "../src/modules/native-scanner/live-shadow-supervisor-cli-args";
import { ScannerLockError, acquireLiveShadowLock } from "../src/modules/native-scanner/scanner-lock";
import { doji, repeat, type Ohlc } from "./helpers/native-signal-fixtures";
import { FIFTEEN_MINUTES_MS as M15, fifteenMinute } from "./helpers/native-scanner-fakes";

/**
 * Multi-symbol live SHADOW supervisor: failure injection with fake public
 * WebSocket and REST, a manual clock and a manual scheduler. No network.
 *
 * Fixture (per symbol, the live-shadow test's lineage: 1D, 7%): GREEN 120 and
 * GREEN 121 armed by Jan 10. Start at 23:59 on Jan 10: the 23:45 bar is the
 * readiness bar (QUARANTINED); L0 (Jan 11 00:00) is the first LIVE bar, where
 * u2 (low 121.5) observes 121 and the close (low 119.5) observes 120.
 */

const D = (d: number, h = 0, m = 0, s = 0) => Date.UTC(2025, 0, d, h, m, s);
const L0 = D(11);
const L1 = L0 + M15;
const ARGS: Record<string, string> = {
  "--interval": "15m", "--history-start": "2025-01-06T00:00:00Z", "--switchover": "2025-01-10T12:00:00Z", "--min-move-percent": "7",
  "--touch-tolerance-percent": "1", "--cooldown-bars": "10", "--min-bars-after-creation": "5", "--min-bars-after-arming": "4",
  "--source-timeframes": "1D", "--max-levels": "500", "--timing": "Immediate", "--partial-period-policy": "SWITCHOVER_TRUNCATED_CLOSED_BARS",
};
const LINEAGE = parseLineageConfig((n) => ARGS[n]);
const ARGV = Object.entries(ARGS).flat();

function bars(): NativeKline[] {
  const rows: Ohlc[] = [];
  rows.push(...repeat(doji(100), 96));
  rows.push([100, 120, 99, 99], ...repeat(doji(99), 95));
  rows.push(...repeat(doji(99), 96));
  rows.push([99, 121, 98.5, 99], ...repeat(doji(99), 94), [99, 99, 98.9, 98.9]);
  rows.push([98.9, 123, 98.9, 123], ...repeat(doji(123), 95));
  rows.push([123, 123, 119.5, 122.5], [122.5, 122.6, 121.6, 121.7], ...repeat(doji(121.7), 8));
  return fifteenMinute(D(6), rows);
}
const BAR_2345 = D(10, 23, 45);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  dirs.push(d);
  return d;
};

interface FakeSocket {
  url: string;
  handlers: StreamHandlers;
  closed: boolean;
}

function klinePayload(symbol: string, openTimeMs: number, [o, h, l, c]: Ohlc, closed: boolean, eventTimeMs: number) {
  return { e: "kline", E: eventTimeMs, s: symbol, k: { t: openTimeMs, T: openTimeMs + M15 - 1, s: symbol, i: "15m", o: String(o), c: String(c), h: String(h), l: String(l), x: closed } };
}

/** One supervisor over `symbols` with a fake Binance. */
function harness(options: { symbols: string[]; root?: string; perConnection?: number; failKlines?: Record<string, number>; queueCapacity?: number; maxLagMs?: number; cacheDir?: string } ) {
  let now = D(10, 23, 59);
  const root = options.root ?? tmp("supervisor-root-");
  const cacheDir = options.cacheDir ?? tmp("supervisor-cache-");
  const sockets: FakeSocket[] = [];
  const rest: string[] = [];
  const scheduled: Array<() => void> = [];
  const logs: string[] = [];
  const ok = (body: unknown, status = 200): PublicHttpResponse => ({ status, header: () => null, text: async () => JSON.stringify(body) });
  const transport: PublicHttpTransport = async (url) => {
    rest.push(url);
    const u = new URL(url);
    if (u.pathname === "/fapi/v1/time") return ok({ serverTime: now });
    const symbol = u.searchParams.get("symbol") as string;
    const fail = options.failKlines?.[symbol];
    if (fail !== undefined) return ok({ code: -1 }, fail);
    const start = Number(u.searchParams.get("startTime"));
    const end = Number(u.searchParams.get("endTime"));
    return ok(bars().filter((b) => b.openTimeMs >= start && b.openTimeMs <= end && b.closeTimeMs < now).slice(0, Number(u.searchParams.get("limit"))).map((k) => [k.openTimeMs, String(k.open), String(k.high), String(k.low), String(k.close), "1", k.closeTimeMs, "1", 1, "1", "1", "0"]));
  };
  const sleep = async (ms: number) => {
    now += ms;
  };
  const governor = new GovernedPublicTransport(transport, { maxTotalRequests: 2_000, minSpacingMs: REQUEST_POLICY_LIMITS.minSpacingFloorMs, nowMs: () => now, sleep });
  const supervisor = new LiveShadowSupervisor(
    {
      lineage: LINEAGE,
      symbols: options.symbols,
      symbolsPerConnection: options.perConnection ?? 50,
      maxConnections: 8,
      restConcurrency: 2,
      queueCapacity: options.queueCapacity ?? 10_000,
      maxProcessingLagMs: options.maxLagMs ?? 600_000,
      staleSymbolMs: 120_000,
      maxRecoveryAttempts: 3,
      liveDirFor: (symbol) => liveShadowDir(root, symbol, "15m"),
    },
    {
      openStream: (url, handlers) => {
        const socket: FakeSocket = { url, handlers, closed: false };
        sockets.push(socket);
        handlers.onOpen(); // the fake handshake completes at once
        return { close: () => (socket.closed = true) };
      },
      governor,
      fetchDeps: { transport: governor.transport, baseUrl: "https://fapi.binance.com", policy: { maxRequests: 500, minSpacingMs: 250, maxTransientRetries: 1, transientBackoffMs: 500 }, nowMs: () => now, sleep },
      cache: new KlineCacheStore(cacheDir),
      acquireLock: (dir) => acquireLiveShadowLock(dir, { pid: 999_001, owner: "test", startedAt: "t", isProcessAlive: () => false }),
      nowMs: () => now,
      nowIso: () => new Date(now).toISOString(),
      schedule: (fn) => scheduled.push(fn),
      log: (line) => logs.push(line),
    }
  );
  const flush = () => {
    while (scheduled.length > 0) (scheduled.shift() as () => void)();
  };
  const live = (index = 0) => sockets.filter((s) => !s.closed)[index];
  const send = (symbol: string, at: number, openTimeMs: number, ohlc: Ohlc, closed: boolean, socket = socketFor(symbol)) => {
    now = at;
    socket.handlers.onMessage(JSON.stringify({ stream: `${symbol.toLowerCase()}@kline_15m`, data: klinePayload(symbol, openTimeMs, ohlc, closed, at) }));
    flush();
  };
  const socketFor = (symbol: string) => sockets.filter((s) => !s.closed).find((s) => s.url.includes(`${symbol.toLowerCase()}@kline_15m`)) as FakeSocket;
  const events = (symbol: string) => {
    const f = path.join(liveShadowDir(root, symbol, "15m"), "events.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8") : "";
  };
  const statusOf = (symbol: string) => supervisor.status().symbols.find((s) => s.symbol === symbol)!;
  return {
    supervisor, sockets, rest, logs, root, cacheDir, flush, live, send, events, statusOf,
    setNow: (ms: number) => (now = ms),
    getNow: () => now,
    tickAll: async () => {
      await Promise.all(supervisor.tick());
      flush();
    },
  };
}

/** The canonical live sequence for one symbol: readiness bar, its close, then L0 with two observations and its live close. */
function playStandard(h: ReturnType<typeof harness>, symbol: string) {
  h.send(symbol, D(10, 23, 59, 30), BAR_2345, [123, 123, 123, 123], false);
  h.send(symbol, L0 + 1, BAR_2345, [123, 123, 123, 123], true);
  h.send(symbol, L0 + 1_000, L0, [123, 123, 123, 123], false);
  h.send(symbol, L0 + 60_000, L0, [123, 123, 121.5, 122], false);
  h.send(symbol, L0 + M15, L0, [123, 123, 119.5, 122.5], true);
}

/** The same per-symbol sequence through the UNCHANGED single-symbol runner: the reference evidence. */
function singleSymbolReference(symbol: string, mutate?: (send: (at: number, open: number, ohlc: Ohlc, closed: boolean) => void) => void): string {
  const dir = tmp("single-ref-");
  let now = D(10, 23, 59);
  const request = { symbol, marketType: "USDM_PERPETUAL" as const, ...LINEAGE, partialPeriodPolicy: "SWITCHOVER_TRUNCATED_CLOSED_BARS" as const, expectedLineageId: null };
  const checkpoints = new LiveCheckpointStore(dir);
  const plan = prepareLiveShadowState(bars(), request, BAR_2345, null);
  checkpoints.save(plan.checkpointBody, new Date(now).toISOString());
  const events = new LiveShadowEventStore(dir);
  const session = new LiveShadowSession({ plan, checkpoints, events, nowMs: () => now, nowIso: () => new Date(now).toISOString(), persistClosedBar: () => undefined });
  let handlers!: StreamHandlers;
  const runner = new LiveShadowRunner({
    session,
    url: `wss://fstream.binance.com/market/ws/${symbol.toLowerCase()}@kline_15m`,
    symbol,
    interval: "15m",
    openStream: (_url, h) => {
      handlers = h;
      return { close: () => undefined };
    },
    fetchClosedBars: async () => [],
    nowMs: () => now,
    log: () => undefined,
  });
  runner.connect();
  const send = (at: number, open: number, ohlc: Ohlc, closed: boolean) => {
    now = at;
    handlers.onMessage(JSON.stringify(klinePayload(symbol, open, ohlc, closed, at)));
  };
  if (mutate) mutate(send);
  else {
    send(D(10, 23, 59, 30), BAR_2345, [123, 123, 123, 123], false);
    send(L0 + 1, BAR_2345, [123, 123, 123, 123], true);
    send(L0 + 1_000, L0, [123, 123, 123, 123], false);
    send(L0 + 60_000, L0, [123, 123, 121.5, 122], false);
    send(L0 + M15, L0, [123, 123, 119.5, 122.5], true);
  }
  return readFileSync(events.file, "utf8");
}

const FIVE = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"];

describe("per-symbol isolation and identical semantics", () => {
  it("20. every symbol's evidence is byte-identical to the single-symbol runner's for the same updates: no fork, no cross-symbol contamination", async () => {
    const h = harness({ symbols: FIVE, perConnection: 2 });
    await h.supervisor.start();
    expect(h.sockets.length).toBe(3);
    for (const s of FIVE) playStandard(h, s);
    for (const s of FIVE) {
      expect(h.events(s)).toBe(singleSymbolReference(s));
      expect(h.events(s)).toContain(`"symbol":"${s}"`);
      expect(h.statusOf(s)).toMatchObject({ status: "ATTACHED", counters: { observations: 2, commitsLive: 1, commitsQuarantined: 1 } });
    }
    const lineages = new Set(FIVE.map((s) => h.statusOf(s).lineageId));
    expect(lineages.size).toBe(5); // the lineage includes the symbol
  });

  it("1/16. a malformed kline for one symbol is refused for that symbol only; every other symbol stays live and identical", async () => {
    const h = harness({ symbols: FIVE });
    await h.supervisor.start();
    h.live().handlers.onMessage(JSON.stringify({ stream: "cccusdt@kline_15m", data: { e: "kline", E: 1, s: "CCCUSDT", k: { garbage: true } } }));
    h.live().handlers.onMessage(JSON.stringify({ stream: "zzzusdt@kline_15m", data: {} }));
    h.live().handlers.onMessage("not json");
    h.flush();
    for (const s of FIVE) playStandard(h, s);
    expect(h.statusOf("CCCUSDT").counters.refused).toBe(1);
    for (const s of FIVE) expect(h.events(s)).toBe(singleSymbolReference(s));
    expect(h.supervisor.status().connections[0].unknownStreamMessages).toBe(2);
  });

  it("10/11. a duplicate update changes nothing; an out-of-order update detaches only that symbol", async () => {
    const h = harness({ symbols: ["AAAUSDT", "BBBUSDT"] });
    await h.supervisor.start();
    for (const s of ["AAAUSDT", "BBBUSDT"]) {
      h.send(s, D(10, 23, 59, 30), BAR_2345, [123, 123, 123, 123], false);
      h.send(s, L0 + 1, BAR_2345, [123, 123, 123, 123], true);
      h.send(s, L0 + 1_000, L0, [123, 123, 123, 123], false);
      h.send(s, L0 + 60_000, L0, [123, 123, 121.5, 122], false);
    }
    const before = h.events("AAAUSDT");
    h.send("AAAUSDT", L0 + 60_000, L0, [123, 123, 121.5, 122], false); // duplicate
    expect(h.events("AAAUSDT")).toBe(before);
    h.send("BBBUSDT", L0 + 30_000, L0, [123, 123, 121.5, 122], false); // event time goes backwards
    expect(h.statusOf("BBBUSDT").status).toBe("RECOVERING");
    expect(h.statusOf("AAAUSDT").status).toBe("ATTACHED");
    h.send("AAAUSDT", L0 + M15, L0, [123, 123, 119.5, 122.5], true);
    // The single-symbol runner given the same updates, duplicate included (it counts as a valid update there too).
    expect(h.events("AAAUSDT")).toBe(
      singleSymbolReference("AAAUSDT", (send) => {
        send(D(10, 23, 59, 30), BAR_2345, [123, 123, 123, 123], false);
        send(L0 + 1, BAR_2345, [123, 123, 123, 123], true);
        send(L0 + 1_000, L0, [123, 123, 123, 123], false);
        send(L0 + 60_000, L0, [123, 123, 121.5, 122], false);
        send(L0 + 60_000, L0, [123, 123, 121.5, 122], false);
        send(L0 + M15, L0, [123, 123, 119.5, 122.5], true);
      })
    );
  });

  it("4. a gap on one symbol (a skipped bar) recovers that symbol alone; it re-quarantines while the others stay live", async () => {
    const h = harness({ symbols: ["AAAUSDT", "BBBUSDT"] });
    await h.supervisor.start();
    for (const s of ["AAAUSDT", "BBBUSDT"]) {
      h.send(s, D(10, 23, 59, 30), BAR_2345, [123, 123, 123, 123], false);
      h.send(s, L0 + 1, BAR_2345, [123, 123, 123, 123], true);
    }
    // BBB's L0 close is lost; its next message is already L1.
    h.send("AAAUSDT", L0 + M15, L0, [123, 123, 119.5, 122.5], true);
    h.send("BBBUSDT", L1 + 5_000, L1, [122.5, 122.6, 122.0, 122.2], false);
    expect(h.statusOf("BBBUSDT").status).toBe("RECOVERING");
    h.setNow(L1 + 60_000);
    await h.tickAll();
    // Recovered L0 from REST as REPLAYED_NON_ACTIONABLE, re-armed: the L1 bar in progress is QUARANTINED.
    expect(h.statusOf("BBBUSDT")).toMatchObject({ status: "ATTACHED", counters: { commitsReplayed: 1, recoveries: 1 } });
    expect(h.events("BBBUSDT")).toContain('"classification":"REPLAYED_NON_ACTIONABLE"');
    h.send("BBBUSDT", L1 + 61_000, L1, [122.5, 122.6, 121.9, 122.1], false);
    expect(h.statusOf("BBBUSDT").readiness).toBe("QUARANTINED_CURRENT_BAR");
    expect(h.statusOf("AAAUSDT").counters).toMatchObject({ commitsLive: 1, recoveries: 0 });
  });
});

describe("connections", () => {
  it("3/2. a whole-connection loss takes every symbol on it out of eligibility; each recovers itself; the reconnect re-quarantines; other connections are untouched", async () => {
    const h = harness({ symbols: FIVE, perConnection: 3 }); // AAA,BBB,CCC on 0; DDD,EEE on 1
    await h.supervisor.start();
    for (const s of FIVE) {
      h.send(s, D(10, 23, 59, 30), BAR_2345, [123, 123, 123, 123], false);
      h.send(s, L0 + 1, BAR_2345, [123, 123, 123, 123], true);
      h.send(s, L0 + 1_000, L0, [123, 123, 123, 123], false);
    }
    expect(FIVE.map((s) => h.statusOf(s).readiness)).toEqual(Array(5).fill("LIVE_ELIGIBLE"));
    h.sockets[0].handlers.onClose("code 1006");
    expect(["AAAUSDT", "BBBUSDT", "CCCUSDT"].map((s) => h.statusOf(s).status)).toEqual(["RECOVERING", "RECOVERING", "RECOVERING"]);
    expect(["DDDUSDT", "EEEUSDT"].map((s) => h.statusOf(s).readiness)).toEqual(["LIVE_ELIGIBLE", "LIVE_ELIGIBLE"]);
    h.setNow(L0 + 10_000);
    await h.tickAll();
    await h.tickAll();
    expect(["AAAUSDT", "BBBUSDT", "CCCUSDT"].map((s) => h.statusOf(s).status)).toEqual(["ATTACHED", "ATTACHED", "ATTACHED"]);
    expect(h.sockets.length).toBe(3); // reconnected after the backoff
    h.send("AAAUSDT", L0 + 20_000, L0, [123, 123, 123, 123], false, h.sockets[2]);
    expect(h.statusOf("AAAUSDT").readiness).toBe("QUARANTINED_CURRENT_BAR");
    expect(h.supervisor.status().totals.reconnects).toBe(1);
  });

  it("2. one silent symbol on a healthy connection is detached and recovered alone; the connection and its neighbours stay live", async () => {
    const h = harness({ symbols: ["AAAUSDT", "BBBUSDT"] });
    await h.supervisor.start();
    for (const s of ["AAAUSDT", "BBBUSDT"]) {
      h.send(s, D(10, 23, 59, 30), BAR_2345, [123, 123, 123, 123], false);
      h.send(s, L0 + 1, BAR_2345, [123, 123, 123, 123], true);
    }
    // Only AAA keeps talking for over two minutes.
    for (let t = L0 + 30_000; t <= L0 + 150_000; t += 30_000) {
      h.send("AAAUSDT", t, L0, [123, 123, 123, 123], false);
      await h.tickAll();
    }
    expect(h.logs.some((l) => l.startsWith("BBBUSDT DETACHED (STREAM_STALE_SYMBOL"))).toBe(true);
    expect(h.statusOf("AAAUSDT")).toMatchObject({ status: "ATTACHED", readiness: "LIVE_ELIGIBLE" });
    expect(h.supervisor.status().connections[0].lifecycle).toBe("OPEN");
    expect(h.sockets.filter((s) => s.closed)).toEqual([]);
    // Regression (Stage B smoke, 1000000MOGUSDT): once recovered and re-armed, a quiet symbol gets a fresh
    // window — it is not re-detached every tick.
    const detachesAfterFirst = () => h.logs.filter((l) => l.startsWith("BBBUSDT DETACHED")).length;
    const first = detachesAfterFirst();
    for (let i = 0; i < 60; i += 1) {
      h.setNow(h.getNow() + 1_000);
      await h.tickAll();
    }
    expect(detachesAfterFirst()).toBe(first);
    expect(h.statusOf("BBBUSDT").status).toBe("ATTACHED");
  });

  it("9. backpressure never drops silently: a queue overflow fails the connection closed; a lagging update fails its symbol closed", async () => {
    const h = harness({ symbols: ["AAAUSDT", "BBBUSDT"], queueCapacity: 100, maxLagMs: 5_000 });
    await h.supervisor.start();
    for (let i = 0; i < 101; i += 1) h.live().handlers.onMessage(JSON.stringify({ stream: "aaausdt@kline_15m", data: klinePayload("AAAUSDT", BAR_2345, [123, 123, 123, 123], false, D(10, 23, 59, 30)) }));
    expect(h.supervisor.status().connections[0]).toMatchObject({ overflows: 1, lifecycle: "CLOSED", queued: 0 });
    expect(h.statusOf("AAAUSDT").status).toBe("RECOVERING");
    expect(h.statusOf("BBBUSDT").status).toBe("RECOVERING");

    const g = harness({ symbols: ["AAAUSDT", "BBBUSDT"], maxLagMs: 5_000 });
    await g.supervisor.start();
    g.setNow(D(10, 23, 59, 50));
    g.live().handlers.onMessage(JSON.stringify({ stream: "aaausdt@kline_15m", data: klinePayload("AAAUSDT", BAR_2345, [123, 123, 123, 123], false, D(10, 23, 59, 30)) }));
    g.flush();
    expect(g.statusOf("AAAUSDT")).toMatchObject({ status: "RECOVERING", counters: { laggedUpdates: 1 } });
    g.send("BBBUSDT", D(10, 23, 59, 51), BAR_2345, [123, 123, 123, 123], false);
    expect(g.statusOf("BBBUSDT").status).toBe("ATTACHED");
  });

  it("17/18. assignment is deterministic and order-independent; reshuffling connections never changes a symbol's lineage or evidence", async () => {
    expect(assignConnections(["CCCUSDT", "AAAUSDT", "BBBUSDT"], 2, 4)).toEqual([["AAAUSDT", "BBBUSDT"], ["CCCUSDT"]]);
    expect(assignConnections(["BBBUSDT", "CCCUSDT", "AAAUSDT"], 2, 4)).toEqual([["AAAUSDT", "BBBUSDT"], ["CCCUSDT"]]);
    expect(() => assignConnections(["AAAUSDT", "BBBUSDT", "CCCUSDT"], 1, 2)).toThrow(SupervisorConfigError);
    expect(() => assignConnections(["AAAUSDT", "AAAUSDT"], 2, 2)).toThrow(/repeats/);
    expect(() => assignConnections(["AAAUSDT"], 201, 2)).toThrow(SupervisorConfigError);
    const one = harness({ symbols: ["AAAUSDT", "CCCUSDT"], perConnection: 1 });
    const two = harness({ symbols: ["AAAUSDT", "BBBUSDT", "CCCUSDT"], perConnection: 50 });
    await one.supervisor.start();
    await two.supervisor.start();
    for (const h of [one, two]) playStandard(h, "CCCUSDT");
    expect(one.statusOf("CCCUSDT").connection).not.toBe(two.statusOf("CCCUSDT").connection);
    expect(one.statusOf("CCCUSDT").lineageId).toBe(two.statusOf("CCCUSDT").lineageId);
    expect(one.events("CCCUSDT")).toBe(two.events("CCCUSDT"));
  });

  it("the combined stream URL is the one routed public form, and nothing else", () => {
    const url = buildPublicCombinedKlineStreamUrl(["BTCUSDT", "ETHUSDT"], "15m");
    expect(url).toBe("wss://fstream.binance.com/market/stream?streams=btcusdt@kline_15m/ethusdt@kline_15m");
    for (const bad of [
      "wss://fstream.binance.com/stream?streams=btcusdt@kline_15m/ethusdt@kline_15m",
      "wss://fstream.binance.com/ws/stream?streams=btcusdt@kline_15m/ethusdt@kline_15m",
      "wss://fstream.binance.com/market/stream?streams=btcusdt@kline_15m/ethusdt@kline_15m&listenKey=x",
      "wss://fstream.binance.com/market/stream?streams=btcusdt@kline_15m/ethusdt@depth",
      "wss://evil.example/market/stream?streams=btcusdt@kline_15m/ethusdt@kline_15m",
    ]) {
      expect(() => assertPublicCombinedKlineStreamUrl(bad, ["BTCUSDT", "ETHUSDT"], "15m")).toThrow(LiveStreamError);
    }
    expect(() => buildPublicCombinedKlineStreamUrl(["BTCUSDT", "BTCUSDT"], "15m")).toThrow(/repeat/);
    expect(() => buildPublicCombinedKlineStreamUrl(Array.from({ length: 201 }, (_, i) => `S${i}USDT`), "15m")).toThrow(/1..200/);
    expect(parseCombinedStreamEnvelope('{"stream":"btcusdt@kline_15m","data":{"e":"kline"}}').stream).toBe("btcusdt@kline_15m");
    expect(() => parseCombinedStreamEnvelope('{"e":"kline"}')).toThrow(LiveStreamError);
  });
});

describe("start-up failures stay with their symbol", () => {
  it("5/6/12. a corrupt checkpoint, a lineage mismatch and a torn event log each fail one symbol; the rest go live identically", async () => {
    const root = tmp("supervisor-root-");
    const dir = (s: string) => liveShadowDir(root, s, "15m");
    // BBB: a corrupt checkpoint.
    new LiveCheckpointStore(dir("BBBUSDT")).save(prepareLiveShadowState(bars(), { symbol: "BBBUSDT", marketType: "USDM_PERPETUAL", ...LINEAGE, partialPeriodPolicy: "SWITCHOVER_TRUNCATED_CLOSED_BARS", expectedLineageId: null }, BAR_2345, null).checkpointBody, "t");
    writeFileSync(path.join(dir("BBBUSDT"), "checkpoint.json"), "{ not json");
    // CCC: a checkpoint of another lineage (different min move).
    const other = parseLineageConfig((n) => (n === "--min-move-percent" ? "8" : ARGS[n]));
    new LiveCheckpointStore(dir("CCCUSDT")).save(prepareLiveShadowState(bars(), { symbol: "CCCUSDT", marketType: "USDM_PERPETUAL", ...other, partialPeriodPolicy: "SWITCHOVER_TRUNCATED_CLOSED_BARS", expectedLineageId: null }, BAR_2345, null).checkpointBody, "t");
    // DDD: a torn event log.
    mkdirSync(dir("DDDUSDT"), { recursive: true });
    appendFileSync(path.join(dir("DDDUSDT"), "events.jsonl"), '{"schema":"teddy.native-scanner.live-shadow-event.v1","torn', { flag: "a" });
    const h = harness({ symbols: FIVE, root });
    await h.supervisor.start();
    expect(h.statusOf("BBBUSDT")).toMatchObject({ status: "FAILED", failure: expect.stringMatching(/^CHECKPOINT_CORRUPT/) });
    expect(h.statusOf("CCCUSDT")).toMatchObject({ status: "FAILED", failure: expect.stringMatching(/^LINEAGE_MISMATCH/) });
    expect(h.statusOf("DDDUSDT")).toMatchObject({ status: "FAILED", failure: expect.stringMatching(/^SHADOW_STORE_CORRUPT/) });
    expect(h.sockets[0].url).toBe(buildPublicCombinedKlineStreamUrl(["AAAUSDT", "EEEUSDT"], "15m"));
    for (const s of ["AAAUSDT", "EEEUSDT"]) {
      playStandard(h, s);
      expect(h.events(s)).toBe(singleSymbolReference(s));
    }
    // The failed symbols' files were left exactly as found.
    expect(readFileSync(path.join(dir("BBBUSDT"), "checkpoint.json"), "utf8")).toBe("{ not json");
  });

  it("7. a REST catch-up failure fails that symbol only", async () => {
    const h = harness({ symbols: ["AAAUSDT", "BBBUSDT"], failKlines: { BBBUSDT: 500 } });
    await h.supervisor.start();
    expect(h.statusOf("BBBUSDT")).toMatchObject({ status: "FAILED", failure: expect.stringMatching(/^PUBLIC_FETCH_FAILED/) });
    playStandard(h, "AAAUSDT");
    expect(h.events("AAAUSDT")).toBe(singleSymbolReference("AAAUSDT"));
  });

  it("8. a 418/429 halts ALL further REST: later symbols needing data fail REST_HALTED, cached ones still go live", async () => {
    const cacheDir = tmp("supervisor-cache-");
    new KlineCacheStore(cacheDir).save("USDM_PERPETUAL", "EEEUSDT", "15m", bars().filter((b) => b.openTimeMs < BAR_2345), "t");
    const h = harness({ symbols: ["AAAUSDT", "BBBUSDT", "CCCUSDT", "EEEUSDT"], failKlines: { AAAUSDT: 429 }, cacheDir });
    await h.supervisor.start();
    expect(h.supervisor.status().totals.restHalted).toBe(true);
    const afterHalt = h.rest.findIndex((u) => u.includes("symbol=AAAUSDT") && u.includes("klines"));
    expect(h.rest.slice(afterHalt + 1).filter((u) => u.includes("/klines"))).toEqual([]);
    expect(h.statusOf("AAAUSDT").failure).toMatch(/^REST_HALTED/);
    expect(h.statusOf("EEEUSDT").status).toBe("ATTACHED");
  });
});

describe("restarts", () => {
  it("13/14/15. restart from a 5-symbol checkpoint set — one quarantined, one mid-gap — verifies and extends every checkpoint", async () => {
    const root = tmp("supervisor-root-");
    const cacheDir = tmp("supervisor-cache-");
    const first = harness({ symbols: FIVE, root, cacheDir });
    await first.supervisor.start();
    for (const s of ["AAAUSDT", "BBBUSDT", "CCCUSDT"]) playStandard(first, s);
    first.send("DDDUSDT", D(10, 23, 59, 30), BAR_2345, [123, 123, 123, 123], false); // DDD: still quarantined
    first.send("EEEUSDT", D(10, 23, 59, 30), BAR_2345, [123, 123, 123, 123], false);
    first.send("EEEUSDT", L0 + 1, BAR_2345, [123, 123, 123, 123], true);
    first.send("EEEUSDT", L1 + 5_000, L1, [122.5, 122.6, 122.0, 122.2], false); // EEE: a gap, now RECOVERING
    expect(first.statusOf("EEEUSDT").status).toBe("RECOVERING");
    const lineages = Object.fromEntries(FIVE.map((s) => [s, first.statusOf(s).lineageId]));
    const evidenceBefore = Object.fromEntries(FIVE.map((s) => [s, first.events(s)]));
    first.supervisor.stop();

    const second = harness({ symbols: FIVE, root, cacheDir });
    second.setNow(L1 + 6 * 60_000);
    await second.supervisor.start();
    for (const s of FIVE) {
      expect(second.statusOf(s)).toMatchObject({ status: "ATTACHED", lineageId: lineages[s] });
      expect(second.statusOf(s).hwm).toBe(new Date(L1).toISOString()); // caught up through the last closed bar
      expect(second.events(s).startsWith(evidenceBefore[s])).toBe(true); // append-only across the restart
    }
    expect(second.logs.filter((l) => l.includes("CATCHUP_OK")).every((l) => /VERIFIED_AND_EXTENDED|VERIFIED_UNCHANGED/.test(l))).toBe(true);
  });

  it("a symbol owned by a live process is refused; a stale lock is reclaimed", () => {
    const dir = tmp("lock-");
    const held = acquireLiveShadowLock(dir, { pid: 1, owner: "a", startedAt: "t", isProcessAlive: () => true });
    expect(() => acquireLiveShadowLock(dir, { pid: 2, owner: "b", startedAt: "t", isProcessAlive: () => true })).toThrow(ScannerLockError);
    const reclaimed = acquireLiveShadowLock(dir, { pid: 2, owner: "b", startedAt: "t", isProcessAlive: () => false });
    held.release(); // not ours any more: must not remove b's lock
    expect(existsSync(reclaimed.file)).toBe(true);
    reclaimed.release();
    expect(existsSync(reclaimed.file)).toBe(false);
  });
});

describe("19. status is observation only", () => {
  it("reading status any number of times never changes evidence, state or readiness", async () => {
    const quiet = harness({ symbols: ["AAAUSDT", "BBBUSDT"] });
    const chatty = harness({ symbols: ["AAAUSDT", "BBBUSDT"] });
    await quiet.supervisor.start();
    await chatty.supervisor.start();
    for (const s of ["AAAUSDT", "BBBUSDT"]) {
      playStandard(quiet, s);
      chatty.send(s, D(10, 23, 59, 30), BAR_2345, [123, 123, 123, 123], false);
      for (let i = 0; i < 50; i += 1) chatty.supervisor.status();
      chatty.send(s, L0 + 1, BAR_2345, [123, 123, 123, 123], true);
      chatty.send(s, L0 + 1_000, L0, [123, 123, 123, 123], false);
      for (let i = 0; i < 50; i += 1) JSON.stringify(chatty.supervisor.status());
      chatty.send(s, L0 + 60_000, L0, [123, 123, 121.5, 122], false);
      chatty.send(s, L0 + M15, L0, [123, 123, 119.5, 122.5], true);
    }
    for (const s of ["AAAUSDT", "BBBUSDT"]) expect(chatty.events(s)).toBe(quiet.events(s));
    const st = chatty.supervisor.status();
    expect(st).toMatchObject({ actionable: false, notice: ["SHADOW ONLY", "NO ALERT AUTHORITY", "NO ORDER AUTHORITY"] });
    expect(JSON.stringify(st)).not.toMatch(/apiKey|secret|signature|DATABASE_URL|password/i);
  });
});

describe("scanner:live-shadow-supervisor arguments", () => {
  it("requires an explicit selection: never the whole universe by accident", () => {
    expect(() => parseSupervisorCliArgs(["--universe", "usdt-perpetual", ...ARGV])).toThrow(/--max-symbols N or the explicit --all-active/);
    expect(parseSupervisorCliArgs(["--universe", "usdt-perpetual", "--max-symbols", "5", ...ARGV]).selection).toEqual({ mode: "UNIVERSE", include: [], exclude: [], maxSymbols: 5 });
    expect(parseSupervisorCliArgs(["--universe", "usdt-perpetual", "--all-active", ...ARGV]).selection).toMatchObject({ mode: "UNIVERSE", maxSymbols: null });
    expect(parseSupervisorCliArgs(["--symbols", "BTCUSDT,ETHUSDT", ...ARGV]).selection).toEqual({ mode: "EXPLICIT", symbols: ["BTCUSDT", "ETHUSDT"] });
  });

  it("refuses unknown, unsafe and conflicting options", () => {
    const refuse = (argv: string[]) => () => parseSupervisorCliArgs(argv);
    for (const extra of [["--execute"], ["--account", "A"], ["--commit-dashboard-alerts"], ["--api-key", "x"], ["--emit"], ["--fetch"]]) {
      expect(refuse(["--symbols", "BTCUSDT", ...ARGV, ...extra])).toThrow(SupervisorCliUsageError);
    }
    expect(refuse(ARGV)).toThrow(/exactly one of --symbols/);
    expect(refuse(["--symbols", "BTCUSDT", "--universe", "usdt-perpetual", ...ARGV])).toThrow(/exactly one/);
    expect(refuse(["--universe", "usdt-perpetual", "--max-symbols", "5", "--all-active", ...ARGV])).toThrow(/exactly one of --max-symbols/);
    expect(refuse(["--symbols", "BTCUSDT", "--all-active", ...ARGV])).toThrow(/only applies with --universe/);
    expect(refuse(["--symbols", "BTCUSDT", "--max-symbols", "3", ...ARGV])).toThrow(/only applies with --universe/);
    expect(refuse(["--symbols", "BTCUSDT", "--symbols-per-connection", "500", ...ARGV])).toThrow(/1..200/);
    expect(refuse(["--symbols", "BTCUSDT", "--request-spacing-ms", "10", ...ARGV])).toThrow(/250/);
    expect(refuse(["--symbols", "BTCUSDT", "--interval", "15m"])).toThrow(/missing required/);
  });
});
