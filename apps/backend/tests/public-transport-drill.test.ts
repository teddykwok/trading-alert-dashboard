import { describe, expect, it } from "vitest";

import type { PublicHttpTransport } from "../src/modules/native-scanner/kline-fetcher";
import type { OpenPublicStream, StreamHandlers } from "../src/modules/native-scanner/live-shadow-runner";
import {
  PUBLIC_TRANSPORT_DRILL_MAX_MS,
  PUBLIC_TRANSPORT_DRILL_SCHEMA,
  PublicTransportDrillGate,
  drillFileOf,
  drilledOpenStream,
  drilledPublicTransport,
  parsePublicTransportDrill,
  publicTransportDrillText,
  type PublicTransportDrill,
} from "../src/modules/native-scanner/public-transport-drill";

/**
 * THE SCANNER'S PUBLIC TRANSPORT DRILL GATE — the process-local half of the
 * operator network drill. A scanner spawned by Always-On watches ONE drill
 * file, derived from its own cooperative stop file; while a valid, unexpired
 * drill for ITS run is there, its public REST and/or WebSocket transports fail
 * (refused, dropped or silent) instead of reaching the network. Nothing else
 * changes: when the drill ends the very same real transports carry on.
 */

const RUN = "20261025T030000Z-0a1b2c3d";
const OTHER_RUN = "20261025T030000Z-ffffffff";
const T0 = Date.UTC(2026, 9, 25, 3, 0, 0);
const STOP = "C:\\local\\trading-alert-dashboard\\monitoring\\always-on\\stop\\scanner-g3-s7.stop";
const DRILL_FILE = "C:\\local\\trading-alert-dashboard\\monitoring\\always-on\\stop\\scanner-g3-s7.drill";

function drill(over: Partial<PublicTransportDrill> = {}): PublicTransportDrill {
  return {
    drillId: "0123456789abcdef0123456789abcdef",
    fault: "PUBLIC_ALL_DOWN",
    runId: RUN,
    generation: 3,
    startedAtMs: T0,
    expiresAtMs: T0 + 300_000,
    faults: { rest: "REFUSED", openStreams: "DROP", newStreams: "REFUSED" },
    ...over,
  };
}

/** A clock whose wall time and monotonic time can be moved independently (a wall-clock jump). */
function clocks() {
  const c = { wall: T0, mono: 1_000_000 };
  return {
    c,
    advance: (ms: number) => {
      c.wall += ms;
      c.mono += ms;
    },
  };
}

function gateOver(files: Map<string, string>, c: { wall: number; mono: number }, runId = RUN) {
  const logs: string[] = [];
  const gate = new PublicTransportDrillGate({ file: DRILL_FILE, runId, readText: (f) => files.get(f) ?? null, nowMs: () => c.wall, monoMs: () => c.mono, log: (l) => logs.push(l) });
  return { gate, logs };
}

describe("the drill file: one per spawned scanner, bound to its run", () => {
  it("lives beside the scanner's own stop file (.stop → .drill); anything that is not a stop file has no drill file", () => {
    expect(drillFileOf(STOP)).toBe(DRILL_FILE);
    expect(() => drillFileOf("C:\\x\\scanner.txt")).toThrow();
  });

  it("round-trips through the one serializer, and the parser accepts exactly that format for the scanner's own run", () => {
    const text = publicTransportDrillText(drill());
    expect(JSON.parse(text).schema).toBe(PUBLIC_TRANSPORT_DRILL_SCHEMA);
    expect(parsePublicTransportDrill(text, RUN)).toEqual({ kind: "VALID", drill: drill() });
    expect(parsePublicTransportDrill(null, RUN)).toEqual({ kind: "ABSENT" });
  });

  it.each([
    ["another run's drill", publicTransportDrillText(drill()), OTHER_RUN, "RUN_MISMATCH"],
    ["not JSON", "{not json", RUN, "UNREADABLE"],
    ["another schema", publicTransportDrillText(drill()).replace(PUBLIC_TRANSPORT_DRILL_SCHEMA, "teddy.other.v1"), RUN, "SCHEMA_INVALID"],
    ["a window longer than the maximum", publicTransportDrillText(drill({ expiresAtMs: T0 + PUBLIC_TRANSPORT_DRILL_MAX_MS + 1 })), RUN, "WINDOW_INVALID"],
    ["an empty window", publicTransportDrillText(drill({ expiresAtMs: T0 })), RUN, "WINDOW_INVALID"],
    ["no fault at all", publicTransportDrillText(drill({ faults: { rest: null, openStreams: null, newStreams: null } })), RUN, "FAULTS_INVALID"],
    ["an unknown fault value", publicTransportDrillText(drill()).replace('"DROP"', '"REDIRECT"'), RUN, "FAULTS_INVALID"],
    ["a malformed drill id", publicTransportDrillText(drill({ drillId: "../../etc" })), RUN, "FIELD_INVALID"],
  ])("refuses %s", (_label, text, runId, reason) => {
    expect(parsePublicTransportDrill(text, runId)).toEqual({ kind: "INVALID", reason });
  });

  it("refuses any field it does not know — a drill can never carry a URL, a host, a header or a redirect", () => {
    const base = JSON.parse(publicTransportDrillText(drill())) as Record<string, unknown>;
    for (const extra of [{ url: "https://evil.example" }, { host: "evil.example" }, { headers: { "X-MBX-APIKEY": "k" } }, { redirect: "follow" }]) {
      expect(parsePublicTransportDrill(JSON.stringify({ ...base, ...extra }), RUN)).toEqual({ kind: "INVALID", reason: "FIELD_INVALID" });
    }
    expect(parsePublicTransportDrill(JSON.stringify({ ...base, faults: { ...(base.faults as object), proxy: "x" } }), RUN)).toEqual({ kind: "INVALID", reason: "FAULTS_INVALID" });
  });
});

describe("the gate: active only for a valid, unexpired drill of this run", () => {
  it("is inactive with no file, activates on a valid file, and the fault set is exactly the file's", () => {
    const files = new Map<string, string>();
    const { c } = clocks();
    const { gate, logs } = gateOver(files, c);
    gate.poll();
    expect(gate.faults()).toBeNull();
    expect(gate.observation()).toBeNull();
    files.set(DRILL_FILE, publicTransportDrillText(drill({ faults: { rest: "REFUSED", openStreams: null, newStreams: null } })));
    gate.poll();
    expect(gate.faults()).toEqual({ rest: "REFUSED", openStreams: null, newStreams: null });
    expect(gate.observation()).toMatchObject({ drillId: drill().drillId, fault: "PUBLIC_ALL_DOWN", active: true, endedAt: null, endReason: null });
    expect(logs.some((l) => l.includes("ACTIVE"))).toBe(true);
  });

  it("ends EXACTLY at its expiry, without waiting for a poll, even if the file is never removed", () => {
    const files = new Map([[DRILL_FILE, publicTransportDrillText(drill())]]);
    const { c, advance } = clocks();
    const { gate } = gateOver(files, c);
    gate.poll();
    advance(299_999);
    expect(gate.faults()).not.toBeNull();
    advance(1);
    expect(gate.faults()).toBeNull();
    expect(gate.observation()).toMatchObject({ active: false, endReason: "EXPIRED" });
    // The file is still there: polling never revives an expired drill.
    gate.poll();
    expect(gate.faults()).toBeNull();
  });

  it("a wall clock moved BACKWARDS cannot extend a drill: the monotonic deadline set at activation still ends it", () => {
    const files = new Map([[DRILL_FILE, publicTransportDrillText(drill())]]);
    const { c } = clocks();
    const { gate } = gateOver(files, c);
    gate.poll();
    c.mono += 300_000;
    c.wall -= 3_600_000; // the wall clock jumped an hour back
    expect(gate.faults()).toBeNull();
    expect(gate.observation()).toMatchObject({ active: false, endReason: "EXPIRED" });
  });

  it("ends when its file is removed (the supervisor's restore) and never reactivates that drill id", () => {
    const files = new Map([[DRILL_FILE, publicTransportDrillText(drill())]]);
    const { c, advance } = clocks();
    const { gate } = gateOver(files, c);
    gate.poll();
    files.delete(DRILL_FILE);
    gate.poll();
    expect(gate.faults()).toBeNull();
    expect(gate.observation()).toMatchObject({ active: false, endReason: "FILE_REMOVED" });
    advance(1_000);
    files.set(DRILL_FILE, publicTransportDrillText(drill()));
    gate.poll();
    expect(gate.faults()).toBeNull();
  });

  it("fails SAFE: a file that becomes unreadable or invalid ends the drill (inactive, never stuck active)", () => {
    const files = new Map([[DRILL_FILE, publicTransportDrillText(drill())]]);
    const { c } = clocks();
    const { gate } = gateOver(files, c);
    gate.poll();
    files.set(DRILL_FILE, "{half-written");
    gate.poll();
    expect(gate.faults()).toBeNull();
    expect(gate.observation()).toMatchObject({ active: false, endReason: "FILE_INVALID" });
  });

  it("never activates another run's drill, an already-expired drill, or one that claims to start in the future", () => {
    const { c } = clocks();
    for (const [text, runId] of [
      [publicTransportDrillText(drill()), OTHER_RUN],
      [publicTransportDrillText(drill({ startedAtMs: T0 - 400_000, expiresAtMs: T0 - 100_000 })), RUN],
      [publicTransportDrillText(drill({ startedAtMs: T0 + 60_000, expiresAtMs: T0 + 120_000 })), RUN],
    ] as const) {
      const files = new Map([[DRILL_FILE, text]]);
      const { gate } = gateOver(files, c, runId);
      gate.poll();
      expect(gate.faults()).toBeNull();
    }
  });

  it("a later drill (a new id) replaces the earlier one at once: one drill at a time", () => {
    const files = new Map([[DRILL_FILE, publicTransportDrillText(drill())]]);
    const { c, advance } = clocks();
    const { gate } = gateOver(files, c);
    gate.poll();
    advance(10_000);
    files.set(DRILL_FILE, publicTransportDrillText(drill({ drillId: "fedcba9876543210fedcba9876543210", startedAtMs: c.wall, expiresAtMs: c.wall + 60_000, faults: { rest: null, openStreams: "SILENT", newStreams: null } })));
    gate.poll();
    expect(gate.faults()).toEqual({ rest: null, openStreams: "SILENT", newStreams: null });
    expect(gate.observation()?.drillId).toBe("fedcba9876543210fedcba9876543210");
  });
});

// ===========================================================================
// The transports
// ===========================================================================

function fixedGate(faults: { rest: "REFUSED" | null; openStreams: "DROP" | "SILENT" | null; newStreams: "REFUSED" | null } | null) {
  const listeners: ((f: NonNullable<typeof faults>) => void)[] = [];
  const g = {
    current: faults,
    faults: () => g.current,
    onActivate: (fn: (f: NonNullable<typeof faults>) => void) => void listeners.push(fn),
    activate: (f: NonNullable<typeof faults>) => {
      g.current = f;
      for (const fn of listeners) fn(f);
    },
  };
  return g;
}

describe("REST under a drill: refused like a dead network, never forwarded, never altered", () => {
  it("with no drill the inner transport receives EXACTLY the scanner's request (same URL, same init, same object)", async () => {
    const seen: unknown[] = [];
    const inner: PublicHttpTransport = async (url, init) => {
      seen.push([url, init]);
      return { status: 200, header: () => null, text: async () => "{}" };
    };
    const init = { headers: { Accept: "application/json" } };
    const t = drilledPublicTransport(inner, fixedGate(null));
    await t("https://fapi.binance.com/fapi/v1/time", init);
    expect(seen).toEqual([["https://fapi.binance.com/fapi/v1/time", init]]);
    expect((seen[0] as unknown[])[1]).toBe(init);
  });

  it("with a REST fault every request fails as undici fails on a refused connection — and the inner transport is never called", async () => {
    let calls = 0;
    const inner: PublicHttpTransport = async () => {
      calls += 1;
      return { status: 200, header: () => null, text: async () => "{}" };
    };
    const t = drilledPublicTransport(inner, fixedGate({ rest: "REFUSED", openStreams: null, newStreams: null }));
    for (const url of ["https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT", "https://fapi.binance.com/fapi/v1/order?signature=x"]) {
      const error = await t(url, { headers: {} }).then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe("fetch failed");
      expect(((error as Error).cause as { code?: string }).code).toBe("ECONNREFUSED");
    }
    expect(calls).toBe(0);
  });

  it("a stream-only fault leaves REST untouched", async () => {
    let calls = 0;
    const inner: PublicHttpTransport = async () => {
      calls += 1;
      return { status: 200, header: () => null, text: async () => "{}" };
    };
    await drilledPublicTransport(inner, fixedGate({ rest: null, openStreams: "DROP", newStreams: "REFUSED" }))("https://fapi.binance.com/fapi/v1/time", { headers: {} });
    expect(calls).toBe(1);
  });
});

/** A scripted inner stream: records opens and lets the test deliver events as the network would. */
function innerStreams() {
  const opened: { url: string; handlers: StreamHandlers; closed: boolean }[] = [];
  const open: OpenPublicStream = (url, handlers) => {
    const s = { url, handlers, closed: false };
    opened.push(s);
    return {
      close: () => {
        s.closed = true;
      },
    };
  };
  return { opened, open };
}

function recorder() {
  const events: string[] = [];
  const handlers: StreamHandlers = {
    onOpen: () => events.push("open"),
    onMessage: (t) => events.push(`message:${t}`),
    onError: (r) => events.push(`error:${r}`),
    onClose: (r) => events.push(`close:${r}`),
  };
  return { events, handlers };
}

describe("WebSocket streams under a drill", () => {
  const url = "wss://fstream.binance.com/market/stream?streams=btcusdt@kline_15m";

  it("with no drill a stream is the real one: same URL, every event passed through, close closes it", () => {
    const inner = innerStreams();
    const deferred: (() => void)[] = [];
    const s = drilledOpenStream(inner.open, fixedGate(null), (fn) => deferred.push(fn));
    const r = recorder();
    const conn = s.openStream(url, r.handlers);
    expect(inner.opened.map((o) => o.url)).toEqual([url]);
    inner.opened[0].handlers.onOpen();
    inner.opened[0].handlers.onMessage("m1");
    inner.opened[0].handlers.onClose("code 1000");
    expect(r.events).toEqual(["open", "message:m1", "close:code 1000"]);
    conn.close();
    expect(inner.opened[0].closed).toBe(true);
    expect(deferred).toEqual([]);
  });

  it("new connections REFUSED: never reach the network, and fail asynchronously (error, then close 1006) like a refused handshake", () => {
    const inner = innerStreams();
    const deferred: (() => void)[] = [];
    const s = drilledOpenStream(inner.open, fixedGate({ rest: null, openStreams: null, newStreams: "REFUSED" }), (fn) => deferred.push(fn));
    const r = recorder();
    s.openStream(url, r.handlers);
    expect(inner.opened).toEqual([]);
    expect(r.events).toEqual([]);
    for (const fn of deferred.splice(0)) fn();
    expect(r.events.length).toBe(2);
    expect(r.events[0]).toMatch(/^error:/);
    expect(r.events[1]).toMatch(/^close:code 1006/);
  });

  it("a refused connection the scanner closes first reports nothing afterwards", () => {
    const deferred: (() => void)[] = [];
    const s = drilledOpenStream(innerStreams().open, fixedGate({ rest: null, openStreams: null, newStreams: "REFUSED" }), (fn) => deferred.push(fn));
    const r = recorder();
    s.openStream(url, r.handlers).close();
    for (const fn of deferred.splice(0)) fn();
    expect(r.events).toEqual([]);
  });

  it("DROP on activation: every open connection is closed for real and reported as an abnormal close; late events of the dead socket are swallowed", () => {
    const inner = innerStreams();
    const deferred: (() => void)[] = [];
    const gate = fixedGate(null);
    const s = drilledOpenStream(inner.open, gate, (fn) => deferred.push(fn));
    const a = recorder();
    const b = recorder();
    s.openStream(url, a.handlers);
    s.openStream(url, b.handlers);
    inner.opened[0].handlers.onOpen();
    inner.opened[1].handlers.onOpen();
    gate.activate({ rest: null, openStreams: "DROP", newStreams: null });
    expect(inner.opened.every((o) => o.closed)).toBe(true);
    for (const fn of deferred.splice(0)) fn();
    for (const r of [a, b]) {
      expect(r.events[0]).toBe("open");
      expect(r.events[1]).toMatch(/^error:/);
      expect(r.events[2]).toMatch(/^close:code 1006/);
    }
    // The real socket's own late close event never reaches the scanner a second time.
    inner.opened[0].handlers.onClose("code 1005");
    inner.opened[0].handlers.onMessage("late");
    expect(a.events.length).toBe(3);
  });

  it("DROP alone is a disconnect, not an outage: connections opened afterwards are real and deliver", () => {
    const inner = innerStreams();
    const gate = fixedGate(null);
    const s = drilledOpenStream(inner.open, gate, (fn) => fn());
    s.openStream(url, recorder().handlers);
    gate.activate({ rest: null, openStreams: "DROP", newStreams: null });
    const r = recorder();
    s.openStream(url, r.handlers);
    expect(inner.opened.length).toBe(2);
    inner.opened[1].handlers.onMessage("fresh");
    expect(r.events).toEqual(["message:fresh"]);
  });

  it("SILENT (half-open): the connection stays open and delivers nothing while the drill lasts, then delivers again", () => {
    const inner = innerStreams();
    const gate = fixedGate({ rest: null, openStreams: "SILENT", newStreams: null });
    const s = drilledOpenStream(inner.open, gate, (fn) => fn());
    const r = recorder();
    const conn = s.openStream(url, r.handlers);
    inner.opened[0].handlers.onOpen();
    inner.opened[0].handlers.onMessage("swallowed");
    gate.current = null; // the drill ended
    inner.opened[0].handlers.onMessage("delivered");
    expect(r.events).toEqual(["open", "message:delivered"]);
    expect(inner.opened[0].closed).toBe(false);
    conn.close();
    expect(inner.opened[0].closed).toBe(true);
  });
});
