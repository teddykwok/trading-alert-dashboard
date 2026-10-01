import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SWITCHOVER_TRUNCATED_CLOSED_BARS,
  createNativeEngineConfig,
  reconstructImmediateCandidates,
  stepNativeEngine,
  type NativeKline,
} from "@trading-alert-dashboard/shared";

import { canonicalJson, canonicalSha256 } from "../src/modules/native-scanner/canonical-json";
import { parseCompatReplayCliArgs, CompatReplayCliUsageError } from "../src/modules/native-scanner/compat-replay-cli-args";
import { engineStateSha256, runCompatibilityReplay } from "../src/modules/native-scanner/compat-replay";
import { serializeKlines, sha256Hex } from "../src/modules/native-scanner/kline-cache";
import { LiveStreamError, assertPublicKlineStreamUrl, buildPublicKlineStreamUrl, parseKlineStreamMessage } from "../src/modules/native-scanner/live-kline-stream";
import { LiveCheckpointStore, LiveShadowError, type LiveCheckpointFile } from "../src/modules/native-scanner/live-shadow-checkpoint";
import { LiveShadowCliUsageError, parseLiveShadowCliArgs } from "../src/modules/native-scanner/live-shadow-cli-args";
import { LiveShadowRunner, type StreamHandlers } from "../src/modules/native-scanner/live-shadow-runner";
import { LiveShadowSession, prepareLiveShadowState, type LiveShadowRequest } from "../src/modules/native-scanner/live-shadow-session";
import { LiveShadowEventStore, type ShadowRecord } from "../src/modules/native-scanner/live-shadow-store";
import { ReplayCliUsageError, parseReplayCliArgs } from "../src/modules/native-scanner/replay-cli-args";
import { doji, repeat, type Ohlc } from "./helpers/native-signal-fixtures";
import { FIFTEEN_MINUTES_MS as M15, fifteenMinute } from "./helpers/native-scanner-fakes";

/**
 * Slice 2B-2B — restart-safe LIVE SHADOW scanner, with a fake public stream,
 * a fake clock and a fake REST gap source. No network is touched.
 *
 * Fixture (15m bars, 1D source, 7%):
 *   Jan 6  flat 100
 *   Jan 7  spike to 120, red close        -> GREEN 120 (1D GOR)
 *   Jan 8  flat 99
 *   Jan 9  spike to 121, red close        -> GREEN 121 (1D GOR)
 *   Jan 10 rally to 123                   -> both armed (variant-dependent)
 *   Jan 11 live bars:
 *     00:00  u1 flat 123 · u2 low 121.5 (121's band only) · u3 CLOSED low 119.5 (both)
 *     00:15  closes 121.7 (cooldown)
 *     00:30  low 121.0: 120 in band from the right side but cooling down; 121 wrong side
 */

const D = (d: number, h = 0, m = 0, s = 0) => Date.UTC(2025, 0, d, h, m, s);
const SYMBOL = "TESTUSDT";
const ENGINE = createNativeEngineConfig({ minMovePct: 0.07, enabledSourceTfs: ["1D"] });
const S = D(10, 12);
const REQUEST: LiveShadowRequest = {
  symbol: SYMBOL,
  marketType: "USDM_PERPETUAL",
  chartInterval: "15m",
  historyStartMs: D(6),
  switchoverMs: S,
  engine: ENGINE,
  partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
  expectedLineageId: null,
};

type Variant = "BASE" | "WRONG_SIDE" | "RECENTLY_ARMED";
const L0_FINAL: Ohlc = [123, 123, 119.5, 122.5];
const L1_FINAL: Ohlc = [122.5, 122.6, 121.6, 121.7];
const L2_FINAL: Ohlc = [121.7, 121.8, 121.0, 121.2];

function craftedBars(variant: Variant = "BASE"): NativeKline[] {
  const rows: Ohlc[] = [];
  rows.push(...repeat(doji(100), 96)); // Jan 6
  rows.push([100, 120, 99, 99], ...repeat(doji(99), 95)); // Jan 7: GREEN 120
  rows.push(...repeat(doji(99), 96)); // Jan 8
  rows.push([99, 121, 98.5, 99], ...repeat(doji(99), 94), [99, 99, 98.9, 98.9]); // Jan 9: GREEN 121
  if (variant === "BASE") rows.push([98.9, 123, 98.9, 123], ...repeat(doji(123), 95));
  if (variant === "WRONG_SIDE") rows.push([98.9, 123, 98.9, 123], ...repeat(doji(123), 94), [123, 123, 121.5, 121.5]);
  if (variant === "RECENTLY_ARMED") rows.push([98.9, 121.5, 98.9, 121.5], ...repeat(doji(121.5), 94), [121.5, 123, 121.5, 123]);
  rows.push(L0_FINAL, L1_FINAL, L2_FINAL, ...repeat(doji(121.2), 6)); // Jan 11
  return fifteenMinute(D(6), rows);
}
const barAt = (bars: NativeKline[], openTimeMs: number) => bars.find((b) => b.openTimeMs === openTimeMs) as NativeKline;

function message(openTimeMs: number, [o, h, l, c]: Ohlc, closed: boolean, eventTimeMs: number, k: Record<string, unknown> = {}, top: Record<string, unknown> = {}): string {
  return JSON.stringify({
    e: "kline",
    E: eventTimeMs,
    s: SYMBOL,
    ...top,
    k: { t: openTimeMs, T: openTimeMs + M15 - 1, s: SYMBOL, i: "15m", o: String(o), c: String(c), h: String(h), l: String(l), x: closed, ...k },
  });
}
const finalMessage = (bar: NativeKline, eventTimeMs = bar.closeTimeMs + 1) => message(bar.openTimeMs, [bar.open, bar.high, bar.low, bar.close], true, eventTimeMs);

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "live-shadow-test-"));
  dirs.push(dir);
  return dir;
};

interface FakeConnection {
  readonly url: string;
  readonly handlers: StreamHandlers;
  closed: boolean;
  close(): void;
}

function harness(options: { variant?: Variant; trustedEndMs: number; dir?: string; clockOffsetMs?: number }) {
  const bars = craftedBars(options.variant ?? "BASE");
  const dir = options.dir ?? tempDir();
  const checkpoints = new LiveCheckpointStore(dir);
  const plan = prepareLiveShadowState(bars, REQUEST, options.trustedEndMs, checkpoints.load());
  checkpoints.save(plan.checkpointBody, "2025-01-01T00:00:00.000Z");
  const events = new LiveShadowEventStore(dir);
  let now = 0;
  const persisted: NativeKline[] = [];
  const session = new LiveShadowSession({
    plan,
    checkpoints,
    events,
    nowMs: () => now + (options.clockOffsetMs ?? 0),
    nowIso: () => new Date(now).toISOString(),
    persistClosedBar: (bar) => persisted.push(bar),
  });
  const connections: FakeConnection[] = [];
  const fetchCalls: [number, number][] = [];
  const logs: string[] = [];
  const runner = new LiveShadowRunner({
    session,
    url: buildPublicKlineStreamUrl(SYMBOL, "15m"),
    symbol: SYMBOL,
    interval: "15m",
    openStream: (url, handlers) => {
      const connection: FakeConnection = { url, handlers, closed: false, close: () => (connection.closed = true) };
      connections.push(connection);
      return connection;
    },
    fetchClosedBars: async (fromMs, toMs) => {
      fetchCalls.push([fromMs, toMs]);
      return bars.filter((b) => b.openTimeMs >= fromMs && b.openTimeMs < toMs);
    },
    nowMs: () => now,
    log: (line) => logs.push(line),
  });
  const live = () => connections[connections.length - 1];
  const send = (at: number, text: string) => {
    now = at;
    live().handlers.onMessage(text);
  };
  const records = (): ShadowRecord[] =>
    existsSync(events.file) ? readFileSync(events.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as ShadowRecord) : [];
  return { bars, dir, plan, checkpoints, events, session, runner, connections, live, send, records, persisted, fetchCalls, logs, setNow: (ms: number) => (now = ms) };
}

/** Ready at 23:59:59 on bar 23:45 (quarantined); bar 00:00 is the first LIVE_ELIGIBLE bar. */
function readyBeforeL0(variant: Variant = "BASE", clockOffsetMs = 0) {
  const h = harness({ variant, trustedEndMs: D(10, 23, 45), clockOffsetMs });
  h.runner.connect();
  const b2345 = barAt(h.bars, D(10, 23, 45));
  h.send(D(10, 23, 59, 59), message(b2345.openTimeMs, [b2345.open, b2345.high, b2345.low, b2345.close], false, D(10, 23, 59, 59)));
  h.send(D(10, 23, 59, 59) + 900, finalMessage(b2345));
  return h;
}
const L0 = D(11);
const u1 = message(L0, [123, 123, 123, 123], false, L0 + 1_000);
const u2 = message(L0, [123, 123, 121.5, 122], false, L0 + 60_000);
const u3 = message(L0, L0_FINAL, true, L0 + M15);

// ===========================================================================
// Durable checkpoint
// ===========================================================================

describe("durable checkpoint", () => {
  it("1. canonical serialization: canonical JSON, body self-hash, provenance outside the body", () => {
    const h = harness({ trustedEndMs: D(11) });
    const text = readFileSync(h.checkpoints.file, "utf8");
    const file = JSON.parse(text) as LiveCheckpointFile;
    expect(text).toBe(`${canonicalJson(file)}\n`);
    expect(file.bodySha256).toBe(canonicalSha256(file.body));
    expect(Object.keys(file.body)).not.toContain("writtenAt");
    expect(file.body).toMatchObject({ lineageId: h.plan.lineageId, hwmOpenTimeMs: D(11), lastCommittedBarOpenTimeMs: D(10, 23, 45), causalBarCount: 48 });
  });

  it("2. atomic write/read: what is saved loads back verified, and no temp file is left behind", () => {
    const h = harness({ trustedEndMs: D(11) });
    expect(h.checkpoints.load()?.body).toEqual(h.plan.checkpointBody);
    expect(existsSync(`${h.checkpoints.file}.tmp`)).toBe(false);
  });

  it("3. a corrupt, torn, edited or inconsistent checkpoint is refused", () => {
    const h = harness({ trustedEndMs: D(11) });
    const original = readFileSync(h.checkpoints.file, "utf8");
    const file = JSON.parse(original) as LiveCheckpointFile;
    const resigned = (body: Record<string, unknown>) => `${canonicalJson({ ...file, body, bodySha256: canonicalSha256(body) })}\n`;
    for (const broken of [
      original.slice(0, original.length / 2),
      original.replace(file.body.stateSha256, "0".repeat(64)),
      resigned({ ...file.body, causalBarCount: 47 }),
      resigned({ ...file.body, extra: 1 }),
      `${canonicalJson({ ...file, extra: true })}\n`,
    ]) {
      writeFileSync(h.checkpoints.file, broken);
      expect(() => h.checkpoints.load()).toThrow(LiveShadowError);
      try {
        h.checkpoints.load();
      } catch (error) {
        expect((error as LiveShadowError).code).toBe("CHECKPOINT_CORRUPT");
      }
    }
  });

  const codeOf = (thunk: () => unknown) => {
    try {
      thunk();
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
  };

  it("4. a checkpoint of another lineage is refused, never overwritten", () => {
    const h = harness({ trustedEndMs: D(11) });
    const before = readFileSync(h.checkpoints.file, "utf8");
    expect(codeOf(() => prepareLiveShadowState(h.bars, { ...REQUEST, switchoverMs: S + M15 }, D(11), h.checkpoints.load()))).toBe("LINEAGE_MISMATCH");
    expect(codeOf(() => prepareLiveShadowState(h.bars, { ...REQUEST, expectedLineageId: "f".repeat(64) }, D(11), null))).toBe("LINEAGE_MISMATCH");
    expect(readFileSync(h.checkpoints.file, "utf8")).toBe(before);
  });

  it("5. a state hash mismatch (at the switchover or at the HWM) is refused", () => {
    const h = harness({ trustedEndMs: D(11) });
    const file = h.checkpoints.load() as LiveCheckpointFile;
    const forged = (body: LiveCheckpointFile["body"]): LiveCheckpointFile => ({ ...file, body, bodySha256: canonicalSha256(body) });
    expect(codeOf(() => prepareLiveShadowState(h.bars, REQUEST, D(11), forged({ ...file.body, stateSha256: "0".repeat(64) })))).toBe("STATE_MISMATCH");
    expect(codeOf(() => prepareLiveShadowState(h.bars, REQUEST, D(11), forged({ ...file.body, stateSha256AtSwitchover: "0".repeat(64) })))).toBe("STATE_MISMATCH");
  });

  it("6. changed causal bytes already consumed through the HWM: HISTORICAL_DATA_DRIFT", () => {
    const h = harness({ trustedEndMs: D(11) });
    const drifted = h.bars.map((b) => (b.openTimeMs === D(10, 18) ? { ...b, high: b.high + 0.5 } : b));
    expect(codeOf(() => prepareLiveShadowState(drifted, REQUEST, D(11), h.checkpoints.load()))).toBe("HISTORICAL_DATA_DRIFT");
    expect(codeOf(() => prepareLiveShadowState(h.bars, REQUEST, D(10, 23), h.checkpoints.load()))).toBe("CHECKPOINT_AHEAD_OF_DATA");
  });

  it("7. restart on the same bytes verifies, and extending it equals building fresh", () => {
    const h = harness({ trustedEndMs: D(10, 20) });
    const same = prepareLiveShadowState(h.bars, REQUEST, D(10, 20), h.checkpoints.load());
    expect(same.checkpointStatus).toBe("VERIFIED_UNCHANGED");
    expect(same.checkpointBody).toEqual(h.plan.checkpointBody);
    const extended = prepareLiveShadowState(h.bars, REQUEST, D(11), h.checkpoints.load());
    expect(extended.checkpointStatus).toBe("VERIFIED_AND_EXTENDED");
    expect(extended.catchUp).toEqual({ fromMs: D(10, 20), toMs: D(11), bars: 16 });
    expect(extended.checkpointBody).toEqual(prepareLiveShadowState(h.bars, REQUEST, D(11), null).checkpointBody);
  });

  it("the state at the switchover is exactly the compatibility replay's", () => {
    const h = harness({ trustedEndMs: D(11) });
    const compat = runCompatibilityReplay(h.bars, { ...REQUEST, endMs: D(11) });
    expect(h.plan.lineageId).toBe(compat.lineageId);
    expect(h.plan.stateSha256AtSwitchover).toBe(compat.bootstrap.stateSha256AtSwitchover);
    expect(h.plan.checkpointBody.stateSha256).toBe(compat.causal.stateSha256AtEnd);
    expect(h.plan.checkpointBody.causalInputSha256ThroughHwm).toBe(compat.input.causalInputSha256);
  });
});

// ===========================================================================
// Readiness and quarantine
// ===========================================================================

describe("readiness and mid-bar quarantine", () => {
  it("9. readiness established before a bar opens: that bar is LIVE_ELIGIBLE; the readiness bar is quarantined", () => {
    const h = readyBeforeL0();
    expect(h.session.barStatus(D(10, 23, 45))).toBe("QUARANTINED_CURRENT_BAR");
    expect(h.session.liveEligibleFromMs).toBe(L0);
    expect(h.session.barStatus(L0)).toBe("LIVE_ELIGIBLE");
  });

  it.each([
    ["10. 1 second", 1_000],
    ["11. 14 minutes", 14 * 60_000],
  ])("%s after the bar opened: QUARANTINED_CURRENT_BAR, even with a live touch in it", (_label, offset) => {
    const h = harness({ trustedEndMs: L0 });
    h.runner.connect();
    h.send(L0 + offset, message(L0, [123, 123, 119.5, 122.5], false, L0 + offset));
    expect(h.session.barStatus(L0)).toBe("QUARANTINED_CURRENT_BAR");
    expect(h.records().filter((r) => r.kind === "LIVE_IMMEDIATE_OBSERVATION")).toEqual([]);
    // 12. the next boundary becomes live eligible
    expect(h.session.liveEligibleFromMs).toBe(L0 + M15);
    h.send(L0 + M15, message(L0, L0_FINAL, true, L0 + M15));
    expect(h.records().find((r) => r.kind === "BAR_CLOSE_COMMIT")?.classification).toBe("QUARANTINED_CURRENT_BAR");
    h.send(L0 + M15 + 1_000, message(L0 + M15, [122.5, 122.5, 122.5, 122.5], false, L0 + M15 + 1_000));
    expect(h.session.barStatus(L0 + M15)).toBe("LIVE_ELIGIBLE");
  });

  it("a fast local clock cannot make the readiness bar live", () => {
    const h = harness({ trustedEndMs: L0 });
    h.runner.connect();
    h.send(L0 - 2_000, message(L0, [123, 123, 123, 123], false, L0 + 500)); // local clock 2.5s behind the exchange
    expect(h.session.barStatus(L0)).toBe("QUARANTINED_CURRENT_BAR");
  });

  it("nothing is evaluated before readiness, and a stream already past the HWM requires recovery", () => {
    const h = harness({ trustedEndMs: D(10, 23, 30) });
    h.runner.connect();
    h.send(L0 + 1_000, message(L0, [123, 123, 119.5, 122.5], false, L0 + 1_000));
    expect(h.session.phase).toBe("RECOVERY_REQUIRED");
    expect(h.session.barStatus(L0)).toBe("RECOVERY_REQUIRED");
    expect(h.records()).toEqual([]);
  });
});

// ===========================================================================
// Public stream adapter
// ===========================================================================

describe("public kline stream adapter", () => {
  it("1. builds exactly the routed MARKET raw kline stream: wss://fstream.binance.com/market/ws/<symbol>@kline_15m", () => {
    expect(buildPublicKlineStreamUrl("LDOUSDT", "15m")).toBe("wss://fstream.binance.com/market/ws/ldousdt@kline_15m");
    expect(assertPublicKlineStreamUrl("wss://fstream.binance.com/market/ws/ldousdt@kline_15m", "LDOUSDT", "15m")).toBe(
      "wss://fstream.binance.com/market/ws/ldousdt@kline_15m"
    );
  });

  it("2-4. refuses the decommissioned legacy /ws/ path, the /public/ route, /stream mode and anything else", () => {
    const refused = (url: string) => {
      try {
        assertPublicKlineStreamUrl(url, "LDOUSDT", "15m");
        return false;
      } catch (error) {
        return error instanceof LiveStreamError && error.code === "FORBIDDEN_STREAM";
      }
    };
    for (const bad of [
      "wss://fstream.binance.com/ws/ldousdt@kline_15m", // 2. legacy un-routed path (decommissioned 2026-04-23)
      "wss://fstream.binance.com/public/ws/ldousdt@kline_15m", // 3. klines are not on the /public route
      "wss://fstream.binance.com/market/stream?streams=ldousdt@kline_15m", // 4. stream (combined) mode
      "wss://fstream.binance.com/market/stream/ldousdt@kline_15m",
      "wss://fstream.binance.com/private/ws/ldousdt@kline_15m",
      "wss://fstream.binance.com/private/ws?listenKey=x",
      "wss://fstream.binance.com/market/ws/abc123listenkey",
      "ws://fstream.binance.com/market/ws/ldousdt@kline_15m",
      "wss://fapi.binance.com/market/ws/ldousdt@kline_15m",
      "wss://dstream.binance.com/market/ws/ldousdt@kline_15m",
      "wss://fstream.binance.com/market/ws/ldousdt@kline_1m",
      "wss://fstream.binance.com/market/ws/btcusdt@kline_15m",
      "wss://fstream.binance.com/market/ws/ldousdt@kline_15m?listenKey=x",
      "wss://user:pass@fstream.binance.com/market/ws/ldousdt@kline_15m",
      "wss://fstream.binance.com:9443/market/ws/ldousdt@kline_15m",
    ]) {
      expect({ bad, refused: refused(bad) }).toEqual({ bad, refused: true });
    }
    // A COIN-M contract cannot even be requested: the scanner symbol rule has no underscore.
    expect(() => buildPublicKlineStreamUrl("BTCUSD_PERP", "15m")).toThrow();
  });

  it("accepts the full current kline payload; an st discriminator must be 1 (USD-M), never 2 (COIN-M)", () => {
    const full = (extraTop: Record<string, unknown> = {}, extraK: Record<string, unknown> = {}) =>
      JSON.stringify({
        e: "kline",
        E: L0 + 250,
        s: SYMBOL,
        ...extraTop,
        k: {
          t: L0,
          T: L0 + M15 - 1,
          s: SYMBOL,
          i: "15m",
          f: 100,
          L: 200,
          o: "123",
          c: "122.5",
          h: "123",
          l: "121.5",
          v: "1000",
          n: 100,
          x: false,
          q: "1.0000",
          V: "500",
          Q: "0.500",
          B: "123456",
          ...extraK,
        },
      });
    expect(parseKlineStreamMessage(full(), SYMBOL, "15m")).toMatchObject({ openTimeMs: L0, open: 123, high: 123, low: 121.5, close: 122.5, closed: false });
    expect(parseKlineStreamMessage(full({ st: 1, ps: SYMBOL }), SYMBOL, "15m").symbol).toBe(SYMBOL);
    for (const cm of [full({ st: 2 }), full({}, { st: 2 }), full({ st: "1" })]) {
      let code: string | null = null;
      try {
        parseKlineStreamMessage(cm, SYMBOL, "15m");
      } catch (error) {
        code = (error as LiveStreamError).code;
      }
      expect(code).toBe("WRONG_MARKET");
    }
  });

  const code = (text: string) => {
    try {
      parseKlineStreamMessage(text, SYMBOL, "15m");
      return null;
    } catch (error) {
      return (error as LiveStreamError).code;
    }
  };

  it("13-15. wrong symbol, wrong interval, wrong event and malformed klines are refused explicitly", () => {
    expect(code(message(L0, [1, 1, 1, 1], false, L0, {}, { s: "BTCUSDT" }))).toBe("WRONG_SYMBOL");
    expect(code(message(L0, [1, 1, 1, 1], false, L0, { s: "BTCUSDT" }))).toBe("WRONG_SYMBOL");
    expect(code(message(L0, [1, 1, 1, 1], false, L0, { i: "1m" }))).toBe("WRONG_INTERVAL");
    expect(code(message(L0, [1, 1, 1, 1], false, L0, {}, { e: "aggTrade" }))).toBe("WRONG_EVENT");
    for (const broken of [
      message(L0, [100, 99, 101, 100], false, L0), // high < low
      message(L0, [100, 101, 99, 102], false, L0), // close above high
      message(L0, [100, 101, 99, 100], false, L0, { o: "1e2" }),
      message(L0, [100, 101, 99, 100], false, L0, { c: "-1" }),
      message(L0, [100, 101, 99, 100], false, L0, { T: L0 + M15 }),
      message(L0 + 1, [100, 101, 99, 100], false, L0),
      message(L0, [100, 101, 99, 100], false, L0, { x: "true" }),
      "not json",
    ]) {
      expect(code(broken)).toBe("MALFORMED_KLINE");
    }
  });

  it("the runner drops refused messages explicitly; they never establish readiness", () => {
    const h = harness({ trustedEndMs: L0 });
    h.runner.connect();
    h.send(L0 + 1_000, message(L0, [123, 123, 123, 123], false, L0, { i: "1m" }));
    h.send(L0 + 1_000, message(L0, [123, 123, 123, 123], false, L0, {}, { s: "BTCUSDT" }));
    expect(h.runner.dropped).toEqual({ WRONG_INTERVAL: 1, WRONG_SYMBOL: 1 });
    expect(h.session.phase).toBe("DISCONNECTED");
  });
});

// ===========================================================================
// Live Immediate semantics
// ===========================================================================

describe("live Immediate semantics", () => {
  it("20/22/23/27. first qualification per level is recorded once, in observation order, with Slice 1b proof fields", () => {
    const h = readyBeforeL0();
    const preBar = h.session.committedState;
    h.send(L0 + 1_000, u1);
    h.setNow(L0 + 60_000);
    // The session itself reports each logical candidate once (not just the store's dedupe).
    expect(h.runner.handleMessage(u2)?.observations.map((o) => o.levelPrice)).toEqual([121]);
    expect(h.runner.handleMessage(u2)?.observations).toEqual([]); // 16. duplicate update tolerated
    expect(h.runner.handleMessage(u2)?.observations).toEqual([]);
    expect(h.session.phase).toBe("READY");
    const observations = h.records().filter((r) => r.kind === "LIVE_IMMEDIATE_OBSERVATION");
    expect(observations.map((o) => o.kind === "LIVE_IMMEDIATE_OBSERVATION" && [o.levelPrice, o.candidateSequence, o.updateSequence])).toEqual([[121, 0, 2]]);
    h.send(L0 + M15, u3);
    const all = h.records().filter((r) => r.kind === "LIVE_IMMEDIATE_OBSERVATION");
    expect(all.map((o) => o.kind === "LIVE_IMMEDIATE_OBSERVATION" && [o.levelPrice, o.signal, o.sourceTf, o.candidateSequence])).toEqual([
      [121, "LONG", "1D", 0],
      [120, "LONG", "1D", 1],
    ]);
    // Exactly Slice 1b's candidates for the OHLC so far, from the same pre-bar state.
    const at = (ohlc: Ohlc) => reconstructImmediateCandidates(preBar, { openTimeMs: L0, closeTimeMs: L0 + M15 - 1, open: ohlc[0], high: ohlc[1], low: ohlc[2], close: ohlc[3] });
    const first = all[0];
    if (first.kind !== "LIVE_IMMEDIATE_OBSERVATION") throw new Error("unexpected");
    const expected = at([123, 123, 121.5, 122])[0];
    expect(first.evidence.proof).toEqual(expected.proof);
    expect(first.level).toEqual(expected.level);
    expect(first.levelKey).toBe(`1D:${expected.level.condition}:${expected.level.createdBarOpenTimeMs}`);
    expect(new Set(all.map((o) => o.eventId)).size).toBe(2);
  });

  it("21. partial updates never touch the committed state; only the close moves it", () => {
    const h = readyBeforeL0();
    const before = engineStateSha256(h.session.committedState);
    const hwm = h.session.hwmOpenTimeMs;
    h.send(L0 + 1_000, u1);
    h.send(L0 + 60_000, u2);
    expect(engineStateSha256(h.session.committedState)).toBe(before);
    expect(h.session.hwmOpenTimeMs).toBe(hwm);
    h.send(L0 + M15, u3);
    expect(engineStateSha256(h.session.committedState)).not.toBe(before);
    expect(h.session.hwmOpenTimeMs).toBe(hwm + M15);
  });

  it("24. a wrong-side approach records nothing for that level", () => {
    const h = readyBeforeL0("WRONG_SIDE");
    h.send(L0 + M15, u3);
    const prices = h.records().flatMap((r) => (r.kind === "LIVE_IMMEDIATE_OBSERVATION" ? [r.levelPrice] : []));
    expect(prices).toEqual([120]); // 121: previous close 121.5 is inside its band
  });

  it("25. cooldown from the committed close blocks the next bars", () => {
    const h = readyBeforeL0();
    h.send(L0 + M15, u3);
    h.send(L0 + 2 * M15, message(L0 + M15, L1_FINAL, true, L0 + 2 * M15));
    h.send(L0 + 3 * M15, message(L0 + 2 * M15, L2_FINAL, true, L0 + 3 * M15));
    const late = h.records().filter((r) => r.kind === "LIVE_IMMEDIATE_OBSERVATION" && r.barOpenTimeMs > L0);
    expect(late).toEqual([]);
  });

  it("26. a level armed too recently (minBarsAfterArming) records nothing", () => {
    const h = readyBeforeL0("RECENTLY_ARMED");
    h.send(L0 + M15, u3);
    const prices = h.records().flatMap((r) => (r.kind === "LIVE_IMMEDIATE_OBSERVATION" ? [r.levelPrice] : []));
    expect(prices).toEqual([120]); // 121 armed on the 23:45 close: 1 bar < 4
  });
});

// ===========================================================================
// Bar-close commit
// ===========================================================================

describe("bar-close commit", () => {
  it("28-31. commits exactly once, equals the offline causal step, and checkpoints that state and the extended causal hash", () => {
    const h = readyBeforeL0();
    const preBar = h.session.committedState;
    const causalBefore = h.bars.filter((b) => b.openTimeMs >= S && b.openTimeMs < L0);
    h.send(L0 + 1_000, u1);
    h.send(L0 + M15, u3);
    h.send(L0 + M15 + 10, u3); // 17. duplicate close
    const offline = stepNativeEngine(preBar, barAt(h.bars, L0));
    expect(engineStateSha256(h.session.committedState)).toBe(engineStateSha256(offline.state));
    const body = (h.checkpoints.load() as LiveCheckpointFile).body;
    expect(body).toMatchObject({ hwmOpenTimeMs: L0 + M15, causalBarCount: causalBefore.length + 1, stateSha256: engineStateSha256(offline.state) });
    expect(body.causalInputSha256ThroughHwm).toBe(sha256Hex(serializeKlines([...causalBefore, barAt(h.bars, L0)])));
    const commits = h.records().filter((r) => r.kind === "BAR_CLOSE_COMMIT" && r.barOpenTimeMs === L0);
    expect(commits).toHaveLength(1);
    const commit = commits[0];
    if (commit.kind !== "BAR_CLOSE_COMMIT") throw new Error("unexpected");
    expect(commit.classification).toBe("SHADOW_LIVE_ONLY");
    expect(commit.committedCandidates.map((c) => [c.levelPrice, c.liveObserved])).toEqual([
      [120, true],
      [121, true],
    ]);
    expect(h.persisted.map((b) => b.openTimeMs)).toEqual([D(10, 23, 45), L0]);
    // A restart on the same bytes verifies against what the live session wrote.
    const restarted = prepareLiveShadowState(h.bars, REQUEST, L0 + M15, h.checkpoints.load());
    expect(restarted.checkpointStatus).toBe("VERIFIED_UNCHANGED");
  });

  it("8. a different wall clock changes provenance only — committed state never; crossing the boundary only quarantines", () => {
    const run = (offset: number) => {
      const h = readyBeforeL0("BASE", offset);
      h.send(L0 + 1_000, u1);
      h.send(L0 + 60_000, u2);
      h.send(L0 + M15, u3);
      const strip = (r: ShadowRecord) => (r.kind === "LIVE_IMMEDIATE_OBSERVATION" ? { ...r, firstObservedAtMs: 0 } : r);
      return { body: (h.checkpoints.load() as LiveCheckpointFile).body, records: h.records().map(strip), status: h.session.barStatus(L0) };
    };
    const reference = run(0);
    // Readiness 37s earlier on the local clock: still before L0 opens -> identical evidence.
    expect(run(-37_000)).toEqual(reference);
    // Readiness 37s later on the local clock: now AFTER L0 opened -> L0 is quarantined (fail-safe),
    // yet the committed state and checkpoint are byte-identical: the clock never shapes strategy.
    const late = run(37_000);
    expect(late.body).toEqual(reference.body);
    expect(late.status).toBe("QUARANTINED_CURRENT_BAR");
    expect(late.records.filter((r) => r.kind === "LIVE_IMMEDIATE_OBSERVATION")).toEqual([]);
  });

  it("18/19. a skipped bar or an out-of-order close requires recovery; nothing is synthesized", () => {
    for (const late of [message(L0 + M15, [123, 123, 123, 123], false, L0 + M15 + 5), message(L0 + 2 * M15, [123, 123, 123, 123], true, L0 + 3 * M15)]) {
      const h = readyBeforeL0();
      const hwm = h.session.hwmOpenTimeMs;
      h.send(L0 + M15 + 5, late);
      expect(h.session.phase).toBe("RECOVERY_REQUIRED");
      expect(h.session.hwmOpenTimeMs).toBe(hwm);
      expect(h.live().closed).toBe(true);
    }
  });

  it("a close that contradicts the committed bar, or a backwards update, requires recovery", () => {
    const a = readyBeforeL0();
    a.send(L0 + M15, u3);
    a.send(L0 + M15 + 5, message(L0, [123, 123, 119.4, 122.5], true, L0 + M15 + 5));
    expect(a.session.phase).toBe("RECOVERY_REQUIRED");
    const b = readyBeforeL0();
    b.send(L0 + 60_000, u2);
    b.send(L0 + 70_000, message(L0, [123, 123, 122, 122], false, L0 + 70_000)); // low rose
    expect(b.session.phase).toBe("RECOVERY_REQUIRED");
  });
});

// ===========================================================================
// Disconnect and reconnect
// ===========================================================================

describe("disconnect and reconnect", () => {
  it("32-35. disconnect stops live at once; the closed gap is replayed non-actionably; the reconnect bar is quarantined; the next bar is live", async () => {
    const h = readyBeforeL0();
    h.send(L0 + 1_000, u1);
    h.live().handlers.onClose("network");
    expect(h.session.barStatus(L0)).toBe("NOT_READY");
    // A late message from the dead connection changes nothing.
    h.connections[0].handlers.onMessage(u3);
    expect(h.records().filter((r) => r.barOpenTimeMs === L0)).toEqual([]);

    h.setNow(L0 + M15 + 60_000); // 00:16 — bar 00:00 has closed while we were away
    const replayed = await h.runner.recoverAndReconnect();
    expect(h.fetchCalls).toEqual([[L0, L0 + M15]]);
    expect(replayed.map((r) => [r.barOpenTimeMs, r.classification, r.committedCandidates.length])).toEqual([[L0, "REPLAYED_NON_ACTIONABLE", 2]]);
    expect(h.records().filter((r) => r.kind === "LIVE_IMMEDIATE_OBSERVATION")).toEqual([]);

    // The DEAD connection can never establish readiness for the new one.
    h.connections[0].handlers.onMessage(message(L0 + M15, [122.5, 122.5, 122.0, 122.1], false, L0 + M15 + 60_500));
    expect(h.session.phase).toBe("DISCONNECTED");
    h.send(L0 + M15 + 61_000, message(L0 + M15, [122.5, 122.5, 122.0, 122.1], false, L0 + M15 + 61_000));
    expect(h.session.barStatus(L0 + M15)).toBe("QUARANTINED_CURRENT_BAR");
    expect(h.session.barStatus(L0 + 2 * M15)).toBe("LIVE_ELIGIBLE");
  });
});

// ===========================================================================
// Connection lifecycle and bounded timeouts
// ===========================================================================

describe("connection lifecycle and bounded timeouts", () => {
  it("5-6/10. CONNECTING -> OPEN -> FIRST_MESSAGE -> READINESS, each visible; readiness needs a VALID update, not OPEN", () => {
    const h = harness({ trustedEndMs: L0 });
    h.setNow(L0 + 500);
    h.runner.connect();
    expect(h.runner.lifecycle).toBe("STREAM_CONNECTING");
    h.live().handlers.onOpen();
    expect(h.runner.lifecycle).toBe("STREAM_OPEN");
    expect(h.session.phase).toBe("DISCONNECTED"); // OPEN alone is never readiness
    h.send(L0 + 1_000, message(L0, [123, 123, 123, 123], false, L0 + 1_000, { i: "1m" }));
    expect(h.runner.lifecycle).toBe("FIRST_MESSAGE_RECEIVED");
    expect(h.session.phase).toBe("DISCONNECTED"); // 9. an invalid message does not establish readiness
    h.send(L0 + 1_250, message(L0, [123, 123, 123, 123], false, L0 + 1_250));
    expect(h.runner.lifecycle).toBe("READINESS_ESTABLISHED");
    expect(h.session.barStatus(L0)).toBe("QUARANTINED_CURRENT_BAR");
    const order = ["STREAM_CONNECTING", "STREAM_OPEN", "FIRST_MESSAGE_RECEIVED", "READINESS_ESTABLISHED"].map((tag) =>
      h.logs.findIndex((line) => line.startsWith(tag))
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("7. no OPEN within the bound: STREAM_OPEN_TIMEOUT, visible and fail-closed", () => {
    const h = harness({ trustedEndMs: L0 });
    h.setNow(L0 + 1_000);
    h.runner.connect();
    h.setNow(L0 + 1_000 + 15_000);
    expect(h.runner.checkTimeouts()).toBeNull();
    h.setNow(L0 + 1_000 + 15_001);
    expect(h.runner.checkTimeouts()).toMatch(/^STREAM_OPEN_TIMEOUT/);
    expect(h.runner.connected).toBe(false);
    expect(h.live().closed).toBe(true);
    expect(h.runner.lifecycle).toBe("STREAM_CLOSED");
    expect(h.session.barStatus(L0)).toBe("NOT_READY");
    expect(h.logs.some((line) => line.startsWith("STREAM_CLOSED (dropped: STREAM_OPEN_TIMEOUT"))).toBe(true);
  });

  it("8. OPEN but no valid update within the bound: STREAM_READINESS_TIMEOUT, saying whether anything arrived", () => {
    for (const sendRefused of [false, true]) {
      const h = harness({ trustedEndMs: L0 });
      h.setNow(L0 + 1_000);
      h.runner.connect();
      h.live().handlers.onOpen();
      if (sendRefused) h.send(L0 + 2_000, message(L0, [123, 123, 123, 123], false, L0 + 2_000, {}, { s: "BTCUSDT" }));
      h.setNow(L0 + 1_000 + 30_000);
      expect(h.runner.checkTimeouts()).toBeNull();
      h.setNow(L0 + 1_000 + 30_001);
      const reason = h.runner.checkTimeouts();
      expect(reason).toMatch(/^STREAM_READINESS_TIMEOUT/);
      expect(reason).toContain(sendRefused ? "1 message(s) refused" : "no message at all");
      expect(h.runner.connected).toBe(false);
      expect(h.session.phase).toBe("DISCONNECTED");
    }
  });

  it("a ready stream that goes silent is dropped as STREAM_STALE; an error is visible and drops the stream", () => {
    const h = readyBeforeL0();
    expect(h.runner.lifecycle).toBe("READINESS_ESTABLISHED");
    h.setNow(D(10, 23, 59, 59) + 900 + 90_000);
    expect(h.runner.checkTimeouts()).toBeNull();
    h.setNow(D(10, 23, 59, 59) + 900 + 90_001);
    expect(h.runner.checkTimeouts()).toMatch(/^STREAM_STALE/);
    expect(h.session.barStatus(L0)).toBe("NOT_READY");

    const e = readyBeforeL0();
    e.live().handlers.onError("websocket error event");
    expect(e.logs.some((line) => line.startsWith("STREAM_ERROR (websocket error event)"))).toBe(true);
    expect(e.runner.connected).toBe(false);
    expect(e.session.barStatus(L0)).toBe("NOT_READY");
  });

  it("11. events from a dead connection (open, error, close, message) never touch the new one", async () => {
    const h = readyBeforeL0();
    h.live().handlers.onClose("network");
    h.setNow(L0 + 60_000);
    await h.runner.recoverAndReconnect();
    const dead = h.connections[0].handlers;
    dead.onOpen();
    dead.onError("late error");
    dead.onClose("late close");
    dead.onMessage(message(L0, [123, 123, 123, 123], false, L0 + 60_000));
    expect(h.runner.connected).toBe(true);
    expect(h.runner.lifecycle).toBe("STREAM_CONNECTING");
    expect(h.session.phase).toBe("DISCONNECTED");
  });
});

// ===========================================================================
// Shadow store, CLI and old CLIs
// ===========================================================================

describe("shadow evidence store", () => {
  it("36. every record is non-actionable, the store refuses an actionable one, and a torn log is refused", () => {
    const h = readyBeforeL0();
    h.send(L0 + M15, u3);
    const records = h.records();
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.actionable === false)).toBe(true);
    expect(new Set(records.map((r) => r.classification))).toEqual(new Set(["QUARANTINED_CURRENT_BAR", "SHADOW_LIVE_ONLY"]));
    expect(() => h.events.append({ ...records[0], eventId: "x", actionable: true } as unknown as ShadowRecord)).toThrow(LiveShadowError);
    expect(h.events.append(records[0])).toBe(false); // same identity is never written twice
    writeFileSync(h.events.file, `${readFileSync(h.events.file, "utf8")}{"torn":`);
    expect(() => new LiveShadowEventStore(h.dir)).toThrow(LiveShadowError);
  });
});

const LIVE_CLI = [
  "--symbol", "LDOUSDT", "--interval", "15m",
  "--history-start", "2026-01-01T00:00:00Z", "--switchover", "2026-09-12T01:00:00Z",
  "--min-move-percent", "7", "--touch-tolerance-percent", "1",
  "--cooldown-bars", "10", "--min-bars-after-creation", "5", "--min-bars-after-arming", "4",
  "--source-timeframes", "1D,1W,1M,3M,6M,12M", "--max-levels", "500", "--timing", "Immediate",
  "--partial-period-policy", SWITCHOVER_TRUNCATED_CLOSED_BARS,
];

describe("scanner:live-shadow CLI and the old CLIs", () => {
  it("parses one explicit lineage; refuses replay-only, account and execution arguments", () => {
    const options = parseLiveShadowCliArgs(LIVE_CLI);
    expect(options.request).toMatchObject({ symbol: "LDOUSDT", switchoverMs: Date.UTC(2026, 8, 12, 1), expectedLineageId: null });
    expect(options.fetch).toBe(false);
    expect(parseLiveShadowCliArgs([...LIVE_CLI, "--expect-lineage-id", "a".repeat(64)]).request.expectedLineageId).toBe("a".repeat(64));
    for (const extra of [
      ["--end", "2026-09-15T22:00:00Z"],
      ["--warmup-start", "2026-01-01T00:00:00Z"],
      ["--output-start", "2026-01-01T00:00:00Z"],
      ["--account", "A"],
      ["--execution-profile", "x"],
      ["--api-key", "x"],
      ["--symbol", "BTCUSDT"],
      ["--expect-lineage-id", "nothex"],
    ]) {
      expect(() => parseLiveShadowCliArgs([...LIVE_CLI, ...extra])).toThrow(LiveShadowCliUsageError);
    }
  });

  it("39/40. scanner:replay and scanner:compat-replay refuse live-only inputs and stay as they were", () => {
    const compatValid = [...LIVE_CLI, "--end", "2026-09-15T22:00:00Z"];
    expect(parseCompatReplayCliArgs(compatValid).fetch).toBe(false);
    expect(() => parseCompatReplayCliArgs([...compatValid, "--expect-lineage-id", "a".repeat(64)])).toThrow(CompatReplayCliUsageError);
    expect(() => parseReplayCliArgs([...compatValid])).toThrow(ReplayCliUsageError);
  });
});
