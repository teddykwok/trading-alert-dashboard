import {
  KLINES_PATH,
  SCANNER_MARKET_TYPE,
  SERVER_TIME_PATH,
  ScannerDataError,
  buildPublicFuturesUrl,
  intervalMsOf,
  parseFuturesKlinesPayload,
  parseServerTimePayload,
  type ScannerChartInterval,
} from "./binance-public-futures";
import type { KlineCacheLike } from "./candidate-rank-runner";
import { PublicRequestController, type BinanceServerClock, type PublicFetchDeps } from "./kline-fetcher";
import type { SymbolOriginInput } from "./scanner-lineage";

/**
 * WHERE A SYMBOL'S REAL HISTORY BEGINS (dynamic universe), from ACTUAL public
 * 15m klines — never from listing metadata alone and never guessed.
 *
 *  1. The verified kline cache holds a bar opening exactly at the profile's
 *     context start: real data exists there, so the profile's own ranges apply
 *     (PROFILE_CONTEXT). No request.
 *  2. Otherwise one public klines request (after Binance's clock): the first
 *     bars in [context start, now] — Binance returns them in ascending open
 *     time from startTime, the earliest first.
 *       - first bar opens exactly at the context start -> PROFILE_CONTEXT;
 *       - first bar opens later and has CLOSED by Binance's clock -> its open
 *         time is the symbol's first real closed bar (SYMBOL_FIRST_CLOSED_BAR);
 *       - no bar yet, or the first bar is still forming -> WAITING (retry at
 *         the next close), never "absent" and never rejected;
 *       - anything malformed, out of order, before the requested start, or a
 *         failed request -> UNREADABLE (retry later), never a guess.
 *
 * exchangeInfo's onboardDate is only a hint: when it disagrees with the first
 * real bar, the bar wins and the discrepancy is reported.
 */

export type OriginProbeOutcome =
  | {
      readonly kind: "ORIGIN";
      readonly origin: SymbolOriginInput;
      readonly source: "CACHE" | "BINANCE";
      /** First real bar minus the onboard hint (floored to the bar), when both are known and differ; else null. */
      readonly onboardDiscrepancyMs: number | null;
      readonly requests: number;
    }
  | { readonly kind: "WAITING_FIRST_CLOSED_BAR"; readonly detail: string; readonly retryAtMs: number; readonly requests: number }
  | { readonly kind: "UNREADABLE"; readonly detail: string; readonly requests: number };

/** Halting conditions are never folded into UNREADABLE: the caller stops the whole REST plane. */
const HALTING: readonly string[] = ["RATE_LIMITED", "IP_BANNED", "REQUEST_BUDGET_EXHAUSTED"];

export async function probeSymbolHistoryOrigin(input: {
  readonly symbol: string;
  readonly chartInterval: ScannerChartInterval;
  readonly contextStartMs: number;
  readonly onboardDateMs: number | null;
  readonly cache: KlineCacheLike;
  readonly fetchDeps: PublicFetchDeps;
  readonly settleMs: number;
  /** The run's shared Binance clock (one serverTime per round, not per probe). Absent: one serverTime request here, as before. */
  readonly serverClock?: BinanceServerClock;
}): Promise<OriginProbeOutcome> {
  const { symbol, chartInterval, contextStartMs, onboardDateMs, settleMs } = input;
  const intervalMs = intervalMsOf(chartInterval);
  try {
    const cached = input.cache.load(SCANNER_MARKET_TYPE, symbol, chartInterval);
    if (cached !== null && cached.klines.some((k) => k.openTimeMs === contextStartMs)) {
      return { kind: "ORIGIN", origin: { kind: "PROFILE_CONTEXT", firstClosedBarOpenTimeMs: null }, source: "CACHE", onboardDiscrepancyMs: null, requests: 0 };
    }
  } catch {
    // An unusable cache proves nothing either way: ask Binance (the cache fill reports the cache itself).
  }

  const controller = new PublicRequestController(input.fetchDeps);
  let serverTimeMs: number;
  let rows;
  try {
    serverTimeMs =
      input.serverClock === undefined
        ? parseServerTimePayload(await controller.getJson(buildPublicFuturesUrl(input.fetchDeps.baseUrl, SERVER_TIME_PATH)))
        : await input.serverClock.current();
    rows = parseFuturesKlinesPayload(
      await controller.getJson(buildPublicFuturesUrl(input.fetchDeps.baseUrl, KLINES_PATH, { symbol, interval: chartInterval, startTime: contextStartMs, endTime: serverTimeMs, limit: 2 })),
      intervalMs
    );
  } catch (error) {
    if (error instanceof ScannerDataError && HALTING.includes(error.code)) throw error;
    const why = error instanceof Error ? `${error.name}${"code" in error ? ` ${String((error as { code: unknown }).code)}` : ""}: ${error.message}` : "unknown";
    return { kind: "UNREADABLE", detail: `first-bar lookup failed (${why})`, requests: controller.requestCount };
  }
  const requests = controller.requestCount;
  const nextCloseMs = (Math.floor(serverTimeMs / intervalMs) + 1) * intervalMs;
  if (rows.length === 0) {
    return { kind: "WAITING_FIRST_CLOSED_BAR", detail: `no 15m bar exists at or after ${new Date(contextStartMs).toISOString()} yet`, retryAtMs: nextCloseMs + settleMs, requests };
  }
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].openTimeMs <= rows[i - 1].openTimeMs) return { kind: "UNREADABLE", detail: "the first-bar response is not strictly ordered", requests };
  }
  const first = rows[0];
  if (first.openTimeMs < contextStartMs) return { kind: "UNREADABLE", detail: "Binance returned a bar before the requested start", requests };
  if (first.openTimeMs === contextStartMs) {
    return { kind: "ORIGIN", origin: { kind: "PROFILE_CONTEXT", firstClosedBarOpenTimeMs: null }, source: "BINANCE", onboardDiscrepancyMs: null, requests };
  }
  if (first.closeTimeMs >= serverTimeMs - settleMs) {
    return { kind: "WAITING_FIRST_CLOSED_BAR", detail: `the first bar ${new Date(first.openTimeMs).toISOString()} has not closed yet`, retryAtMs: first.closeTimeMs + 1 + settleMs, requests };
  }
  const onboardBarMs = onboardDateMs === null ? null : Math.floor(onboardDateMs / intervalMs) * intervalMs;
  return {
    kind: "ORIGIN",
    origin: { kind: "SYMBOL_FIRST_CLOSED_BAR", firstClosedBarOpenTimeMs: first.openTimeMs },
    source: "BINANCE",
    onboardDiscrepancyMs: onboardBarMs === null || onboardBarMs === first.openTimeMs ? null : first.openTimeMs - onboardBarMs,
    requests,
  };
}
