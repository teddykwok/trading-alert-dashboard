import type { NativeKline } from "@trading-alert-dashboard/shared";

/**
 * Deterministic kline builders for the native signal engine tests.
 *
 * Nothing here touches the network, a clock or randomness: every bar is
 * written out, so each test states the exact chart it is reasoning about.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * 2024-01-01T00:00:00Z — a Monday, so it opens a day, an ISO week, a month, a
 * quarter, a half and a year at once. Every higher-timeframe aggregate that
 * starts here is complete.
 */
export const T_2024_01_01 = Date.UTC(2024, 0, 1);

/** [open, high, low, close] */
export type Ohlc = readonly [number, number, number, number];

/** A doji: close == open, so it can never create a level on its own. */
export function doji(price: number, high = price, low = price): Ohlc {
  return [price, high, low, price];
}

/** Contiguous bars from `startMs`, Binance-style closeTime = open + interval - 1. */
export function barsFrom(startMs: number, intervalMs: number, rows: readonly Ohlc[]): NativeKline[] {
  return rows.map(([open, high, low, close], index) => {
    const openTimeMs = startMs + index * intervalMs;
    return { openTimeMs, closeTimeMs: openTimeMs + intervalMs - 1, open, high, low, close };
  });
}

/** Daily chart bars from 2024-01-01: each bar is exactly one complete 1D candle. */
export function dailyBars(rows: readonly Ohlc[], startMs = T_2024_01_01): NativeKline[] {
  return barsFrom(startMs, DAY_MS, rows);
}

/** `count` copies of the same row. */
export function repeat(row: Ohlc, count: number): Ohlc[] {
  return Array.from({ length: count }, () => row);
}

/**
 * A seeded linear-congruential generator: reproducible "noise" for the
 * causality test, with no dependence on Math.random.
 */
export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
