import type { NativeKline } from "@trading-alert-dashboard/shared";

import type { PublicHttpResponse, PublicHttpTransport } from "../../src/modules/native-scanner/kline-fetcher";
import type { Ohlc } from "./native-signal-fixtures";

/**
 * Deterministic stand-ins for Binance and the clock. Nothing here touches the
 * network: the fake answers from an in-memory candle list, and the clock's
 * sleep only advances a number.
 */

export const FIFTEEN_MINUTES_MS = 15 * 60_000;
export const T_2025_01_01 = Date.UTC(2025, 0, 1);

/** Contiguous 15m klines from `startMs`. */
export function fifteenMinute(startMs: number, rows: readonly Ohlc[]): NativeKline[] {
  return rows.map(([open, high, low, close], i) => {
    const openTimeMs = startMs + i * FIFTEEN_MINUTES_MS;
    return { openTimeMs, closeTimeMs: openTimeMs + FIFTEEN_MINUTES_MS - 1, open, high, low, close };
  });
}

/** `count` gently varying, valid 15m klines. */
export function plainKlines(startMs: number, count: number): NativeKline[] {
  const rows: Ohlc[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = 100 + (i % 7) * 0.25;
    rows.push([base, base + 0.5, base - 0.5, base + 0.125]);
  }
  return fifteenMinute(startMs, rows);
}

/** A kline as Binance's 12-field row, prices as decimal strings. */
export function toBinanceRow(k: NativeKline): unknown[] {
  return [k.openTimeMs, String(k.open), String(k.high), String(k.low), String(k.close), "1.0", k.closeTimeMs, "100.0", 10, "0.5", "50.0", "0"];
}

export function manualClock(startMs = Date.UTC(2026, 0, 1)) {
  let now = startMs;
  const sleeps: number[] = [];
  return {
    nowMs: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    sleeps,
  };
}

export interface ScriptedResponse {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Throw instead of answering, as a dropped connection would. */
  readonly throws?: boolean;
}

export interface RecordedCall {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly atMs: number;
}

/**
 * Serves /fapi/v1/time and /fapi/v1/klines (openTime in [startTime, endTime],
 * first `limit`) from `klines`. `script` answers the Nth call instead, when
 * set; `tamperPage` can rewrite a klines page to simulate exchange misbehaviour.
 */
export function fakeBinance(options: {
  klines: readonly NativeKline[];
  serverTimeMs: number;
  clock: { nowMs: () => number };
  script?: Readonly<Record<number, ScriptedResponse>>;
  tamperPage?: (rows: NativeKline[], params: { startTime: number; endTime: number; limit: number }) => NativeKline[];
}) {
  const calls: RecordedCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const respond = (status: number, body: string, headers: Readonly<Record<string, string>> = {}): PublicHttpResponse => ({
    status,
    header: (name) => {
      const key = Object.keys(headers).find((h) => h.toLowerCase() === name.toLowerCase());
      return key === undefined ? null : headers[key];
    },
    text: async () => body,
  });

  const transport: PublicHttpTransport = async (url, init) => {
    const index = calls.length;
    calls.push({ url, headers: { ...init.headers }, atMs: options.clock.nowMs() });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await Promise.resolve();
      const scripted = options.script?.[index];
      if (scripted) {
        if (scripted.throws) throw new Error("connection reset");
        return respond(scripted.status, scripted.body ?? "", scripted.headers);
      }
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/time") return respond(200, JSON.stringify({ serverTime: options.serverTimeMs }));
      if (parsed.pathname === "/fapi/v1/klines") {
        const startTime = Number(parsed.searchParams.get("startTime"));
        const endTime = Number(parsed.searchParams.get("endTime"));
        const limit = Number(parsed.searchParams.get("limit"));
        let rows = options.klines.filter((k) => k.openTimeMs >= startTime && k.openTimeMs <= endTime).slice(0, limit);
        if (options.tamperPage) rows = options.tamperPage(rows, { startTime, endTime, limit });
        return respond(200, JSON.stringify(rows.map(toBinanceRow)));
      }
      return respond(404, "{}");
    } finally {
      inFlight -= 1;
    }
  };

  return {
    transport,
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

/** Any accidental use of the real network fails the test that made it. */
export function forbidRealNetwork(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("real network access is forbidden in native-scanner tests");
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}
