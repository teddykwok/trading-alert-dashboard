import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AlwaysOnCliUsageError, parseAlwaysOnCliArgs } from "../src/modules/always-on/always-on-cli-args";
import { publicBinanceReachable } from "../src/modules/always-on/always-on-machine";
import type { StreamHandlers } from "../src/modules/native-scanner/live-shadow-runner";
import { SupervisorCliUsageError, parseSupervisorCliArgs } from "../src/modules/native-scanner/live-shadow-supervisor-cli-args";
import { forbidRealNetwork, plainKlines } from "./helpers/native-scanner-fakes";
import {
  MAX_SIMULATED_OUTAGE_MS,
  SIMULATED_REST_TIMEOUT_MS,
  SimulatedNetworkViolation,
  SimulatedPublicNetwork,
  type SimulatedMarket,
} from "./helpers/simulated-public-network";

/**
 * ISOLATED NETWORK FAULT INJECTION (test-only). The simulated public network
 * itself: every fault changes what the transports DO (requests fail or hang,
 * sockets drop, go silent or never open), restoration is deterministic and
 * fail-safe, and nothing in production can construct, select or reach it.
 */

const M15 = 15 * 60_000;
const T0 = Date.UTC(2026, 9, 23, 10, 0, 7);
const SYMBOLS = ["AAAUSDT", "BBBUSDT"];
const MARKET: SimulatedMarket = {
  symbols: () => SYMBOLS,
  bars: () => plainKlines(Date.UTC(2026, 9, 20), 2_000),
  onboardDateMs: () => Date.UTC(2025, 0, 1),
};
const BACKEND = path.resolve(__dirname, "..");

let open: SimulatedPublicNetwork[] = [];
afterEach(() => {
  for (const net of open) net.dispose();
  open = [];
});

function rig() {
  let now = T0;
  const net = new SimulatedPublicNetwork(() => now, MARKET);
  open.push(net);
  return {
    net,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const KLINES = "https://fapi.binance.com/fapi/v1/klines?symbol=AAAUSDT&interval=15m&startTime=0&endTime=9999999999999&limit=1500";

function recorder() {
  const seen: string[] = [];
  const handlers: StreamHandlers = {
    onOpen: () => seen.push("open"),
    onMessage: (text) => {
      const m = JSON.parse(text) as { data: { s: string; k: { t: number; x: boolean } } };
      seen.push(`${m.data.s}:${m.data.k.x ? "closed" : "update"}:${m.data.k.t}`);
    },
    onError: (reason) => seen.push(`error:${reason}`),
    onClose: (reason) => seen.push(`close:${reason}`),
  };
  return { seen, handlers };
}

const STREAM_URL = "wss://fstream.binance.com/market/stream?streams=aaausdt@kline_15m/bbbusdt@kline_15m";

describe("the real public connectivity probe over an injected transport", () => {
  it("sends its one unsigned server-time request through the injected fetch, never the real network", async () => {
    const restore = forbidRealNetwork();
    try {
      const seen: { url: string; method: string | undefined; headers: unknown }[] = [];
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), method: init?.method, headers: init?.headers });
        return new Response(JSON.stringify({ serverTime: 1_792_900_000_000 }), { status: 200 });
      }) as typeof fetch;
      expect(await publicBinanceReachable(5_000, fetchImpl)).toBe(true);
      expect(seen).toEqual([{ url: "https://fapi.binance.com/fapi/v1/time", method: "GET", headers: undefined }]);
    } finally {
      restore();
    }
  });

  it("observes a simulated outage exactly as a real one: reachable, then unreachable (refused or timing out), then reachable again", async () => {
    const restore = forbidRealNetwork();
    try {
      const { net, advance } = rig();
      expect(await publicBinanceReachable(5_000, net.fetch)).toBe(true);
      const refused = net.cut({ rest: "REFUSED", maxDurationMs: 600_000 });
      expect(await publicBinanceReachable(5_000, net.fetch)).toBe(false);
      refused.restore();
      net.cut({ rest: "TIMEOUT", maxDurationMs: 600_000 });
      expect(await publicBinanceReachable(5_000, net.fetch)).toBe(false);
      advance(600_000);
      expect(await publicBinanceReachable(5_000, net.fetch)).toBe(true); // the outage expired on its own
      expect(net.requests.filter((r) => r.via === "probe").map((r) => r.outcome)).toEqual(["OK", "REFUSED", "TIMEOUT", "OK"]);
    } finally {
      restore();
    }
  });
});

describe("REST faults change what the transport does", () => {
  it("UP serves server time, exchangeInfo and only CLOSED klines", async () => {
    const { net } = rig();
    expect(JSON.parse(await (await net.rest("https://fapi.binance.com/fapi/v1/time", { headers: {} })).text())).toEqual({ serverTime: T0 });
    const info = JSON.parse(await (await net.rest("https://fapi.binance.com/fapi/v1/exchangeInfo", { headers: {} })).text()) as { symbols: { symbol: string }[] };
    expect(info.symbols.map((s) => s.symbol)).toEqual(SYMBOLS);
    const rows = JSON.parse(await (await net.rest(KLINES, { headers: {} })).text()) as number[][];
    expect(rows.at(-1)?.[6]).toBeLessThan(T0);
    expect(rows.at(-1)?.[0]).toBe(Math.floor(T0 / M15) * M15 - M15);
  });

  it("REFUSED fails every request the way undici does (TypeError fetch failed, cause ECONNREFUSED)", async () => {
    const { net } = rig();
    net.cut({ rest: "REFUSED", maxDurationMs: 60_000 });
    const error = await net.rest(KLINES, { headers: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(((error as TypeError).cause as { code: string }).code).toBe("ECONNREFUSED");
    expect(net.requests.at(-1)).toMatchObject({ via: "rest", path: "/fapi/v1/klines", symbol: "AAAUSDT", outcome: "REFUSED" });
  });

  it("TIMEOUT holds a request until its 20 s client timeout elapses on the simulated clock; restoring does not release it early", async () => {
    const { net, advance } = rig();
    const handle = net.cut({ rest: "TIMEOUT", maxDurationMs: 600_000 });
    let settled: unknown = "pending";
    void net.rest(KLINES, { headers: {} }).then(
      () => (settled = "answered"),
      (e: unknown) => (settled = e)
    );
    const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
    advance(SIMULATED_REST_TIMEOUT_MS - 1);
    handle.restore();
    net.pump();
    await turn();
    expect(settled).toBe("pending");
    expect(net.heldRequests).toBe(1);
    advance(1);
    net.pump();
    await turn();
    expect((settled as Error).name).toBe("TimeoutError");
    expect(net.heldRequests).toBe(0);
    expect(net.requests.at(-1)).toMatchObject({ outcome: "TIMEOUT", settledAtMs: T0 + SIMULATED_REST_TIMEOUT_MS });
    // After the outage a new request is answered normally.
    expect((await net.rest(KLINES, { headers: {} })).status).toBe(200);
  });
});

describe("WebSocket faults change what the streams do", () => {
  it("UP: the handshake completes on the next turn, then each turn pushes the bar in progress, and the closing update only in the turn the bar closed", () => {
    const { net, advance } = rig();
    const { seen, handlers } = recorder();
    net.openStream(STREAM_URL, handlers);
    expect(seen).toEqual([]);
    net.pump();
    const bar = Math.floor(T0 / M15) * M15;
    expect(seen).toEqual(["open", `AAAUSDT:update:${bar}`, `BBBUSDT:update:${bar}`]);
    seen.length = 0;
    advance(bar + M15 - T0 + 1_000); // 1 s into the next bar
    net.pump();
    expect(seen).toEqual([`AAAUSDT:closed:${bar}`, `AAAUSDT:update:${bar + M15}`, `BBBUSDT:closed:${bar}`, `BBBUSDT:update:${bar + M15}`]);
    seen.length = 0;
    advance(5_000);
    net.pump();
    expect(seen).toEqual([`AAAUSDT:update:${bar + M15}`, `BBBUSDT:update:${bar + M15}`]);
  });

  it("DROP: every connection open when the outage starts gets an error and an abnormal close (1006) on the next turn", () => {
    const { net } = rig();
    const { seen, handlers } = recorder();
    net.openStream(STREAM_URL, handlers);
    net.pump();
    seen.length = 0;
    net.cut({ openStreams: "DROP", maxDurationMs: 60_000 });
    net.pump();
    expect(seen).toEqual(["error:websocket error event", "close:code 1006"]);
    expect(net.sockets[0]).toMatchObject({ state: "CLOSED", closeReason: "dropped by the simulated outage" });
  });

  it("new connections during an outage: REFUSED errors and closes without ever opening; BLACKHOLE never answers at all", () => {
    const { net } = rig();
    const refused = recorder();
    const handle = net.cut({ newStreams: "REFUSED", maxDurationMs: 60_000 });
    net.openStream(STREAM_URL, refused.handlers);
    net.pump();
    expect(refused.seen).toEqual(["error:websocket error event", "close:code 1006"]);
    handle.restore();
    const hole = recorder();
    net.cut({ newStreams: "BLACKHOLE", maxDurationMs: 60_000 });
    net.openStream(STREAM_URL, hole.handlers);
    net.pump();
    net.pump();
    expect(hole.seen).toEqual([]);
    expect(net.sockets[1].state).toBe("CONNECTING");
  });

  it("SILENT: a half-open connection stays OPEN and delivers nothing; after restore it resumes, and a closing update it missed is never replayed", () => {
    const { net, advance } = rig();
    const { seen, handlers } = recorder();
    net.openStream(STREAM_URL, handlers);
    net.pump();
    seen.length = 0;
    const bar = Math.floor(T0 / M15) * M15;
    const handle = net.cut({ openStreams: "SILENT", maxDurationMs: 3_600_000 });
    advance(bar + M15 - T0 + 1_000); // the bar closes while the connection is silent
    net.pump();
    expect(seen).toEqual([]);
    expect(net.sockets[0].state).toBe("OPEN");
    handle.restore();
    advance(5_000);
    net.pump();
    expect(seen).toEqual([`AAAUSDT:update:${bar + M15}`, `BBBUSDT:update:${bar + M15}`]);
  });

  it("a client close is acknowledged with a normal close (1000) and nothing more is delivered", () => {
    const { net, advance } = rig();
    const { seen, handlers } = recorder();
    const connection = net.openStream(STREAM_URL, handlers);
    net.pump();
    connection.close();
    net.pump();
    seen.length = 0;
    advance(60_000);
    net.pump();
    expect(seen).toEqual([]);
    expect(net.sockets[0]).toMatchObject({ state: "CLOSED", closeReason: "client closed" });
  });
});

describe("restoration is deterministic and fail-safe", () => {
  it("every outage needs a bounded duration and restores itself when the simulated clock passes it", () => {
    const { net, advance } = rig();
    expect(() => net.cut({ rest: "REFUSED", maxDurationMs: 0 })).toThrow(SimulatedNetworkViolation);
    expect(() => net.cut({ rest: "REFUSED", maxDurationMs: MAX_SIMULATED_OUTAGE_MS + 1 })).toThrow(SimulatedNetworkViolation);
    expect(() => net.cut({ rest: "REFUSED", maxDurationMs: Number.POSITIVE_INFINITY })).toThrow(SimulatedNetworkViolation);
    expect(() => net.cut({ maxDurationMs: 60_000 })).toThrow(/at least one path/);
    net.cut({ rest: "REFUSED", openStreams: "DROP", newStreams: "REFUSED", maxDurationMs: 90_000 });
    expect(() => net.cut({ rest: "TIMEOUT", maxDurationMs: 60_000 })).toThrow(/already active/);
    advance(89_999);
    expect(net.outage).not.toBeNull();
    advance(1);
    expect(net.outage).toBeNull();
    expect(net.events.map((e) => e.kind)).toEqual(["OUTAGE_STARTED", "AUTO_RESTORED"]);
  });

  it("withOutage restores even when the body throws", async () => {
    const { net } = rig();
    await expect(
      net.withOutage({ rest: "REFUSED", maxDurationMs: 60_000 }, async () => {
        throw new Error("the scenario failed mid-outage");
      })
    ).rejects.toThrow("the scenario failed mid-outage");
    expect(net.outage).toBeNull();
    expect((await net.rest(KLINES, { headers: {} })).status).toBe(200);
  });

  it("dispose restores, fails every held request, delivers nothing more and refuses any further use", async () => {
    const { net } = rig();
    const { seen, handlers } = recorder();
    net.openStream(STREAM_URL, handlers);
    net.pump();
    net.cut({ rest: "TIMEOUT", maxDurationMs: 600_000 });
    const held = net.rest(KLINES, { headers: {} }).catch((e: unknown) => e);
    seen.length = 0;
    net.dispose();
    expect(((await held) as Error).message).toBe("simulated network disposed");
    expect(net.outage).toBeNull();
    expect(seen).toEqual([]);
    expect(net.sockets[0].state).toBe("CLOSED");
    expect(() => net.pump()).toThrow(SimulatedNetworkViolation);
    await expect(net.rest(KLINES, { headers: {} })).rejects.toThrow(SimulatedNetworkViolation);
    expect(() => net.openStream(STREAM_URL, handlers)).toThrow(SimulatedNetworkViolation);
    net.dispose(); // idempotent
  });
});

describe("path-scoped REST faults and the stream probe socket", () => {
  it("a REST fault scoped to exchangeInfo refuses only exchangeInfo; klines and server time still answer; scoping needs a REST fault and known paths", async () => {
    const { net } = rig();
    expect(() => net.cut({ openStreams: "DROP", restPaths: ["/fapi/v1/exchangeInfo"], maxDurationMs: 60_000 })).toThrow(/restPaths/);
    expect(() => net.cut({ rest: "REFUSED", restPaths: ["/fapi/v1/order"], maxDurationMs: 60_000 })).toThrow(/restPaths/);
    net.cut({ rest: "REFUSED", restPaths: ["/fapi/v1/exchangeInfo"], maxDurationMs: 60_000 });
    await expect(net.rest("https://fapi.binance.com/fapi/v1/exchangeInfo", { headers: {} })).rejects.toBeInstanceOf(TypeError);
    expect((await net.rest(KLINES, { headers: {} })).status).toBe(200);
    expect(await publicBinanceReachable(5_000, net.fetch)).toBe(true);
    expect(net.events[0].detail).toContain("rest REFUSED (/fapi/v1/exchangeInfo)");
  });

  const PROBE_URL = "wss://fstream.binance.com/market/stream?streams=btcusdt@kline_15m";
  async function observe(net: SimulatedPublicNetwork) {
    const seen: string[] = [];
    const socket = net.openProbeSocket(PROBE_URL);
    for (const type of ["open", "message", "error", "close"] as const) socket.addEventListener(type, (e) => seen.push(type === "message" ? `message:${JSON.parse(String(e.data)).data.s}` : type));
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { seen, socket };
  }

  it("UP opens and sends one valid BTCUSDT kline; REFUSED errors and closes; BLACKHOLE never answers; SILENT opens and says nothing", async () => {
    const { net } = rig();
    expect((await observe(net)).seen).toEqual(["open", "message:BTCUSDT"]);
    const refused = net.cut({ newStreams: "REFUSED", maxDurationMs: 60_000 });
    expect((await observe(net)).seen).toEqual(["error", "close"]);
    refused.restore();
    const hole = net.cut({ newStreams: "BLACKHOLE", maxDurationMs: 60_000 });
    expect((await observe(net)).seen).toEqual([]);
    hole.restore();
    net.cut({ openStreams: "SILENT", maxDurationMs: 60_000 });
    expect((await observe(net)).seen).toEqual(["open"]);
    expect(net.streamProbes.map((p) => p.outcome)).toEqual(["OK", "REFUSED", "BLACKHOLE", "SILENT"]);
  });

  it("a closed probe socket delivers nothing more; its listener count is observable; only the validated public probe URL is accepted", async () => {
    const { net } = rig();
    const seen: string[] = [];
    const socket = net.openProbeSocket(PROBE_URL);
    const listener = () => seen.push("x");
    socket.addEventListener("open", listener);
    expect(net.streamProbes[0].listeners()).toBe(1);
    socket.removeEventListener("open", listener);
    socket.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(seen).toEqual([]);
    expect(net.streamProbes[0]).toMatchObject({ closed: true });
    expect(net.streamProbes[0].listeners()).toBe(0);
    expect(() => net.openProbeSocket("wss://fstream.binance.com/market/stream?streams=ethusdt@kline_15m")).toThrow(SimulatedNetworkViolation);
    expect(() => net.openProbeSocket("wss://stream.binance.com/market/stream?streams=btcusdt@kline_15m")).toThrow(SimulatedNetworkViolation);
  });
});

describe("the simulated network serves public market data only", () => {
  it("refuses any other host, signed parameters, an API-key header, a non-GET probe and a stream URL the production validator refuses", async () => {
    const { net } = rig();
    await expect(net.rest("https://api.binance.com/api/v3/time", { headers: {} })).rejects.toThrow(/only https:\/\/fapi.binance.com/);
    await expect(net.rest("http://fapi.binance.com/fapi/v1/time", { headers: {} })).rejects.toThrow(SimulatedNetworkViolation);
    await expect(net.rest("https://fapi.binance.com/fapi/v2/account?timestamp=1&signature=ab", { headers: {} })).rejects.toThrow(/signed request/);
    await expect(net.rest("https://fapi.binance.com/fapi/v1/time", { headers: { "X-MBX-APIKEY": "k" } })).rejects.toThrow(/API key header/);
    await expect(net.fetch("https://fapi.binance.com/fapi/v1/order", { method: "POST" })).rejects.toThrow(/POST request/);
    expect(() => net.openStream("wss://fstream.binance.com/market/stream?streams=aaausdt@kline_15m&x=1", recorder().handlers)).toThrow(SimulatedNetworkViolation);
    expect(() => net.openStream("wss://fstream.binance.com/market/stream?streams=zzzusdt@kline_15m", recorder().handlers)).toThrow(/not a listed symbol/);
    expect(net.violations).toHaveLength(7);
  });

  it("the network events record path-scoped outages", () => {
    const { net } = rig();
    net.cut({ rest: "TIMEOUT", restPaths: ["/fapi/v1/klines", "/fapi/v1/exchangeInfo"], maxDurationMs: 60_000, label: "scoped" });
    expect(net.events.map((e) => e.detail)).toEqual(["scoped: rest TIMEOUT (/fapi/v1/klines, /fapi/v1/exchangeInfo) (max 60s)"]);
  });
});

// ===========================================================================
// Ordinary production startup can never activate fault injection
// ===========================================================================

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("ordinary production startup cannot activate fault injection", () => {
  const sources = sourceFiles(path.join(BACKEND, "src")).map((file) => ({ file: path.relative(BACKEND, file), text: readFileSync(file, "utf8") }));

  it("no production module imports a test helper or names the simulated network", () => {
    expect(sources.length).toBeGreaterThan(100);
    const offenders = sources.filter(({ text }) => /from\s+["'][^"']*\/tests\/|simulated-public-network|SimulatedPublicNetwork/.test(text));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("no production module reads an environment variable that could select a fault, simulation or alternate transport", () => {
    // "DEFAULT" is not "FAULT": NATIVE_PLAN_DEFAULT_LOOKBACK_A and DASHBOARD_DEFAULT_LIMIT are ordinary settings.
    const selector = /(?:process\.env|\benv|processEnv)(?:\.|\[\s*["'])\w*(?:(?<!DE)FAULT|SIMULAT|CHAOS|INJECT|OFFLINE|PROXY)\w*/i;
    expect(selector.test("process.env.NETWORK_FAULT_MODE")).toBe(true);
    expect(selector.test("env.SIMULATE_OUTAGE")).toBe(true);
    expect(selector.test('process.env["HTTPS_PROXY"]')).toBe(true);
    expect(selector.test("env.DASHBOARD_DEFAULT_LIMIT")).toBe(false);
    const offenders = sources.filter(({ text }) => selector.test(text));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("the Always-On entrypoint wires the probe to the real transport (gated only by an ACTIVE operator drill), and the scanner entrypoint to the real fetch and WebSocket", () => {
    const always = readFileSync(path.join(BACKEND, "src/modules/always-on/run-always-on-monitoring.ts"), "utf8");
    // The entrypoint hands the supervisor the machine's production probe; outside an active operator drill it receives
    // the real fetch ITSELF (drilledProbeFetch(fetch, null) === fetch, pinned in always-on-drill.test.ts).
    expect(always).toContain("publicConnectivity: publicConnectivityProbe,");
    expect(always).not.toMatch(/publicBinanceReachable\(/);
    const machine = readFileSync(path.join(BACKEND, "src/modules/always-on/always-on-machine.ts"), "utf8");
    expect(machine).toContain("return publicBinanceReachable(undefined, drilledProbeFetch(fetch, drill));");
    expect((machine.replace(/\/\*[\s\S]*?\*\//g, "").match(/publicBinanceReachable\(/g) ?? []).length).toBe(2); // its definition and that one call (comments aside)
    const scanner = readFileSync(path.join(BACKEND, "src/modules/native-scanner/run-live-shadow-supervisor.ts"), "utf8");
    expect(scanner).toMatch(/const publicTransport: PublicHttpTransport = async \(url, init\) => \{\r?\n\s+const response = await fetch\(url, \{/);
    expect(scanner).toMatch(/const openPublicStream: OpenPublicStream = \(url, handlers\) => \{\r?\n\s+const socket = new WebSocket\(url\);/);
    // The operator drill gate wraps them only for a supervisor-spawned run (always-on-drill-structure.test.ts).
    expect(scanner).toMatch(/openStream: drilledStreams\?\.openStream \?\? openPublicStream,/);
  });

  it("neither CLI accepts a fault, simulation or transport option", () => {
    for (const flag of ["--simulate-network-fault", "--fault-injection", "--network-fault", "--offline", "--proxy"]) {
      expect(() => parseAlwaysOnCliArgs(["run", flag])).toThrow(AlwaysOnCliUsageError);
      expect(() => parseSupervisorCliArgs(["--profile", "teddy-7-all-active", flag])).toThrow(SupervisorCliUsageError);
    }
  });
});
