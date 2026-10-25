import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AlwaysOnCliUsageError, parseAlwaysOnCliArgs } from "../src/modules/always-on/always-on-cli-args";
import { PUBLIC_STREAM_PROBE_SYMBOL, publicStreamReachable, type StreamProbeSocket } from "../src/modules/always-on/always-on-machine";
import { buildPublicCombinedKlineStreamUrl } from "../src/modules/native-scanner/live-kline-stream";
import { plainKlines } from "./helpers/native-scanner-fakes";
import { SimulatedPublicNetwork, immediateProbeTimers, type ProbeListener } from "./helpers/simulated-public-network";

/**
 * R1 — THE PUBLIC STREAM PROBE. One public subscription (BTCUSDT 15m klines)
 * decides REACHABLE only on a valid message; UNREACHABLE only on positive
 * evidence of failure (an error or close before one, or no handshake at all);
 * UNKNOWN for anything else — a socket that cannot be constructed, opens but
 * proves nothing in time, or says something it cannot read. Every path closes
 * the socket, removes every listener and clears its timer. Offline.
 */

const BACKEND = path.resolve(__dirname, "..");
let nets: SimulatedPublicNetwork[] = [];
afterEach(() => {
  for (const n of nets) n.dispose();
  nets = [];
});

function network() {
  const now = Date.UTC(2026, 9, 23, 10, 0, 7);
  const net = new SimulatedPublicNetwork(() => now, { symbols: () => ["AAAUSDT"], bars: () => plainKlines(Date.UTC(2026, 9, 20), 2_000), onboardDateMs: () => 0 });
  nets.push(net);
  return net;
}

/** Counts every timer the probe sets and clears (they fire right after the socket's own events). */
function countingTimers() {
  const live = new Set<unknown>();
  return {
    live,
    set: (fn: () => void, ms: number) => {
      const handle = immediateProbeTimers.set(() => {
        live.delete(handle);
        fn();
      }, ms);
      live.add(handle);
      return handle;
    },
    clear: (handle: unknown) => {
      live.delete(handle);
      immediateProbeTimers.clear(handle);
    },
  };
}

/** A hand-driven socket: records its listeners and lets the test fire events. */
function scriptedSocket() {
  const listeners = new Map<string, Set<ProbeListener>>();
  const fired: string[] = [];
  let closed = false;
  const socket: StreamProbeSocket = {
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set<ProbeListener>();
      set.add(listener as ProbeListener);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener as ProbeListener),
    close: () => {
      closed = true;
    },
  };
  return {
    socket,
    fire: (type: string, event: { data?: unknown } = {}) => {
      fired.push(type);
      for (const l of [...(listeners.get(type) ?? [])]) l(event);
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    get closed() {
      return closed;
    },
  };
}

describe("publicStreamReachable over the simulated network", () => {
  it("REACHABLE only after a valid kline message of the probe stream", async () => {
    const net = network();
    const timers = countingTimers();
    expect(await publicStreamReachable({ open: net.openProbeSocket, timers })).toBe("REACHABLE");
    expect(net.streamProbes).toHaveLength(1);
    expect(net.streamProbes[0]).toMatchObject({ outcome: "OK", closed: true });
    expect(net.streamProbes[0].listeners()).toBe(0);
    expect(timers.live.size).toBe(0);
  });

  it.each([
    ["a refused connection (error, then close)", { newStreams: "REFUSED" as const }, "UNREACHABLE"],
    ["a handshake that never answers", { newStreams: "BLACKHOLE" as const }, "UNREACHABLE"],
    ["a half-open connection that says nothing (ambiguous)", { openStreams: "SILENT" as const }, "UNKNOWN"],
  ])("%s: %s", async (_label, fault, expected) => {
    const net = network();
    net.cut({ ...fault, maxDurationMs: 60_000 });
    const timers = countingTimers();
    expect(await publicStreamReachable({ open: net.openProbeSocket, timers })).toBe(expected);
    expect(net.streamProbes[0].closed).toBe(true);
    expect(net.streamProbes[0].listeners()).toBe(0);
    expect(timers.live.size).toBe(0);
  });
});

describe("publicStreamReachable fails closed on anything uncertain", () => {
  it("a socket that cannot be constructed is UNKNOWN (never a confirmed outage), and sets no timer", async () => {
    const timers = countingTimers();
    const outcome = await publicStreamReachable({
      open: () => {
        throw new Error("no WebSocket here");
      },
      timers,
    });
    expect(outcome).toBe("UNKNOWN");
    expect(timers.live.size).toBe(0);
  });

  it.each([
    ["not JSON", "{not json"],
    ["another stream", JSON.stringify({ stream: "ethusdt@kline_15m", data: {} })],
    ["a malformed kline", JSON.stringify({ stream: "btcusdt@kline_15m", data: { e: "kline", s: "BTCUSDT", k: { s: "BTCUSDT", i: "15m" } } })],
  ])("an unreadable message (%s) is never REACHABLE: UNKNOWN on the timeout, and UNKNOWN even if the socket then closes", async (_label, data) => {
    for (const ending of ["timeout", "close"] as const) {
      const s = scriptedSocket();
      const timers = countingTimers();
      const pending = publicStreamReachable({ open: () => s.socket, timers });
      s.fire("open");
      s.fire("message", { data });
      if (ending === "close") s.fire("close");
      expect(await pending).toBe("UNKNOWN");
      expect(s.closed).toBe(true);
      expect(s.listenerCount()).toBe(0);
      expect(timers.live.size).toBe(0);
    }
  });

  it("settles exactly once: an error and a close both fired, and anything after the answer, change nothing", async () => {
    const s = scriptedSocket();
    const timers = countingTimers();
    const pending = publicStreamReachable({ open: () => s.socket, timers });
    s.fire("error");
    s.fire("close");
    expect(await pending).toBe("UNREACHABLE");
    expect(s.listenerCount()).toBe(0);
    s.fire("message", { data: "late" });
    expect(s.closed).toBe(true);
    expect(timers.live.size).toBe(0);
  });

  it("an open socket that later closes before proving anything is UNREACHABLE (the stream service dropped it)", async () => {
    const s = scriptedSocket();
    const pending = publicStreamReachable({ open: () => s.socket, timers: countingTimers() });
    s.fire("open");
    s.fire("close");
    expect(await pending).toBe("UNREACHABLE");
  });
});

describe("the production probe: public, validated, unsigned, and never switchable", () => {
  it("subscribes to exactly the production-validated public combined stream of BTCUSDT 15m klines", async () => {
    const urls: string[] = [];
    const s = scriptedSocket();
    const pending = publicStreamReachable({
      open: (url) => {
        urls.push(url);
        return s.socket;
      },
      timers: countingTimers(),
    });
    s.fire("error");
    await pending;
    expect(PUBLIC_STREAM_PROBE_SYMBOL).toBe("BTCUSDT");
    expect(urls).toEqual([buildPublicCombinedKlineStreamUrl(["BTCUSDT"], "15m")]);
    expect(urls[0]).toBe("wss://fstream.binance.com/market/stream?streams=btcusdt@kline_15m");
  });

  it("production constructs the socket with the URL alone (no protocols, no headers), on bounded real timers, and calls it with no injected transport", () => {
    const machine = readFileSync(path.join(BACKEND, "src/modules/always-on/always-on-machine.ts"), "utf8");
    expect(machine).toMatch(/options\.open \?\? \(\(url: string\) => new WebSocket\(url\)\)/);
    expect(machine).not.toMatch(/new WebSocket\(url,/);
    expect(machine).toMatch(/const timeoutMs = options\.timeoutMs \?\? PUBLIC_STREAM_PROBE_TIMEOUT_MS;/);
    const entry = readFileSync(path.join(BACKEND, "src/modules/always-on/run-always-on-monitoring.ts"), "utf8");
    expect(entry.match(/publicStreamReachable\([^)]*\)/g)).toEqual(["publicStreamReachable()"]);
  });

  it("the Always-On CLI accepts no probe, stream or outage option", () => {
    for (const flag of ["--stream-probe", "--public-stream-probe", "--assume-stream-outage", "--skip-stream-probe"]) {
      expect(() => parseAlwaysOnCliArgs(["run", flag])).toThrow(AlwaysOnCliUsageError);
    }
  });
});
