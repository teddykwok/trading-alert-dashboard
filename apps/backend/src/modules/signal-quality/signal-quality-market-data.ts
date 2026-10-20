import {
  KLINES_PATH,
  buildPublicFuturesUrl,
  parseFuturesKlinesPayload,
  parseRetryAfterMs,
} from "../native-scanner/binance-public-futures";
import { USED_WEIGHT_HEADER, klinesWeightForLimit, parseUsedWeightHeader } from "../native-scanner/public-request-weight";
import { MINUTE_MS, floorMinute, type MinuteBar, type OutcomeMarketData } from "./signal-quality-outcome";

/**
 * PUBLIC market data for the signal-quality observatory: Binance USD-M
 * 1-minute (and, for charts, 15-minute) klines. READ ONLY and UNSIGNED.
 *
 * Every URL is built by the scanner's own allowlisted builder
 * (buildPublicFuturesUrl): the host is fixed to fapi.binance.com, the only
 * path used is /fapi/v1/klines, and no signed, account or order endpoint can
 * even be expressed. Responses are parsed strictly (parseFuturesKlinesPayload).
 * No API key, header credential or secret exists anywhere here.
 *
 * Bounded, because the IP weight budget (2400/min) is SHARED with the scanner:
 *  - a token bucket of OBSERVATORY_WEIGHT_PER_MINUTE (240, a tenth of the IP limit);
 *  - at most OBSERVATORY_MAX_IN_FLIGHT requests at once;
 *  - a pause until the next minute whenever Binance reports the IP's used
 *    weight at or above OBSERVATORY_PAUSE_AT_USED_WEIGHT, and on 429/418 for
 *    Retry-After (or a minute);
 *  - one cache per SYMBOL (one contiguous minute range), so many alerts on one
 *    symbol cost one series, and only the new tail is fetched on refresh;
 *  - a memory cap on cached minutes, least recently used evicted first;
 *  - a failed symbol is not retried for a minute.
 * When the budget is spent, data is NOT_LOADED (shown as such, never guessed);
 * a provider failure is UNAVAILABLE. A Binance outage degrades observability
 * and nothing else: this module has no path to any execution state.
 */

export const OBSERVATORY_WEIGHT_PER_MINUTE = 240;
export const OBSERVATORY_MAX_IN_FLIGHT = 2;
export const OBSERVATORY_PAUSE_AT_USED_WEIGHT = 1_200;
export const OBSERVATORY_MAX_CACHED_MINUTES = 1_500_000;
export const OBSERVATORY_FAILURE_RETRY_MS = 60_000;
export const OBSERVATORY_REQUEST_TIMEOUT_MS = 10_000;
export const OBSERVATORY_PAGE_MINUTES = 1_000;
const PUBLIC_FUTURES_ORIGIN = "https://fapi.binance.com";
const QUARTER_MS = 15 * MINUTE_MS;

export interface PublicResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export type PublicFetch = (url: string, init: { signal: AbortSignal }) => Promise<PublicResponse>;

export interface SignalQualityMarketDataDeps {
  readonly fetch?: PublicFetch;
  readonly now?: () => number;
  readonly weightPerMinute?: number;
  readonly maxInFlight?: number;
  readonly maxCachedMinutes?: number;
}

/** One symbol's contiguous attempted minute range [startMs, endMs). Missing minutes are NaN. */
interface Series {
  startMs: number;
  endMs: number;
  /** open, high, low, close per minute. */
  data: Float64Array;
  lastUsedMs: number;
}

export interface MarketDataRequest {
  readonly symbol: string;
  readonly fromMs: number;
  readonly toMs: number;
}

export interface MarketDataView {
  readonly marketData: OutcomeMarketData;
  /** The latest instant the data covers (exclusive); the evaluation never looks past min(asOf, this). */
  readonly coveredThroughMs: number | null;
}

export interface ChartBar {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface MarketDataStats {
  readonly requestsMade: number;
  readonly weightUsed: number;
  readonly symbolsCached: number;
  readonly minutesCached: number;
  readonly pausedUntil: string | null;
  readonly lastUsedWeightReported: number | null;
}

class BudgetExhausted extends Error {}

export class SignalQualityMarketData {
  private readonly fetchImpl: PublicFetch;
  private readonly now: () => number;
  private readonly weightPerMinute: number;
  private readonly maxInFlight: number;
  private readonly maxCachedMinutes: number;
  private tokens: number;
  private tokensAtMs: number;
  private pausedUntilMs = 0;
  private inFlight = 0;
  private readonly series = new Map<string, Series>();
  private readonly failures = new Map<string, { atMs: number; reason: string }>();
  private readonly charts = new Map<string, { bars: ChartBar[]; fetchedAtMs: number; complete: boolean }>();
  private requestsMade = 0;
  private weightUsed = 0;
  private lastUsedWeight: number | null = null;

  constructor(deps: SignalQualityMarketDataDeps = {}) {
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, { signal: init.signal }));
    this.now = deps.now ?? (() => Date.now());
    this.weightPerMinute = deps.weightPerMinute ?? OBSERVATORY_WEIGHT_PER_MINUTE;
    this.maxInFlight = deps.maxInFlight ?? OBSERVATORY_MAX_IN_FLIGHT;
    this.maxCachedMinutes = deps.maxCachedMinutes ?? OBSERVATORY_MAX_CACHED_MINUTES;
    this.tokens = this.weightPerMinute;
    this.tokensAtMs = this.now();
  }

  stats(): MarketDataStats {
    let minutes = 0;
    for (const s of this.series.values()) minutes += (s.endMs - s.startMs) / MINUTE_MS;
    return {
      requestsMade: this.requestsMade,
      weightUsed: this.weightUsed,
      symbolsCached: this.series.size,
      minutesCached: minutes,
      pausedUntil: this.pausedUntilMs > this.now() ? new Date(this.pausedUntilMs).toISOString() : null,
      lastUsedWeightReported: this.lastUsedWeight,
    };
  }

  // --- budget ------------------------------------------------------------------

  private refill(): void {
    const now = this.now();
    const elapsed = Math.max(0, now - this.tokensAtMs);
    this.tokens = Math.min(this.weightPerMinute, this.tokens + (elapsed / 60_000) * this.weightPerMinute);
    this.tokensAtMs = now;
  }

  private take(weight: number): boolean {
    if (this.now() < this.pausedUntilMs) return false;
    this.refill();
    if (this.tokens < weight) return false;
    this.tokens -= weight;
    return true;
  }

  // --- one request ---------------------------------------------------------------

  private async get(url: string, weight: number): Promise<unknown> {
    if (this.inFlight >= this.maxInFlight || !this.take(weight)) throw new BudgetExhausted();
    this.inFlight += 1;
    this.requestsMade += 1;
    this.weightUsed += weight;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OBSERVATORY_REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      const used = parseUsedWeightHeader(response.headers.get(USED_WEIGHT_HEADER));
      if (used !== null) {
        this.lastUsedWeight = used;
        if (used >= OBSERVATORY_PAUSE_AT_USED_WEIGHT) this.pausedUntilMs = Math.max(this.pausedUntilMs, floorMinute(this.now()) + MINUTE_MS + 1_000);
      }
      if (response.status === 429 || response.status === 418) {
        const retry = parseRetryAfterMs(response.headers.get("retry-after"), this.now()) ?? 60_000;
        this.pausedUntilMs = Math.max(this.pausedUntilMs, this.now() + retry);
        throw new Error(`Binance public rate limit (HTTP ${response.status})`);
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`Binance public klines HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
      this.inFlight -= 1;
    }
  }

  /** Closed minute bars of [fromMs, toMs) for one symbol, in pages; throws BudgetExhausted when it cannot continue. */
  private async fetchMinutes(symbol: string, fromMs: number, toMs: number): Promise<Map<number, MinuteBar>> {
    const out = new Map<number, MinuteBar>();
    for (let start = fromMs; start < toMs; start += OBSERVATORY_PAGE_MINUTES * MINUTE_MS) {
      const end = Math.min(toMs, start + OBSERVATORY_PAGE_MINUTES * MINUTE_MS);
      const limit = (end - start) / MINUTE_MS;
      const url = buildPublicFuturesUrl(PUBLIC_FUTURES_ORIGIN, KLINES_PATH, { symbol, interval: "1m", startTime: start, endTime: end - 1, limit });
      const payload = await this.get(url, klinesWeightForLimit(limit));
      for (const k of parseFuturesKlinesPayload(payload, MINUTE_MS)) {
        if (k.openTimeMs >= start && k.openTimeMs < end) out.set(k.openTimeMs, { openTimeMs: k.openTimeMs, open: k.open, high: k.high, low: k.low, close: k.close });
      }
    }
    return out;
  }

  // --- cache -----------------------------------------------------------------------

  private store(symbol: string, fromMs: number, toMs: number, bars: Map<number, MinuteBar>): void {
    const existing = this.series.get(symbol);
    const startMs = existing ? Math.min(existing.startMs, fromMs) : fromMs;
    const endMs = existing ? Math.max(existing.endMs, toMs) : toMs;
    const minutes = (endMs - startMs) / MINUTE_MS;
    const data = new Float64Array(minutes * 4).fill(Number.NaN);
    if (existing) data.set(existing.data, ((existing.startMs - startMs) / MINUTE_MS) * 4);
    for (const bar of bars.values()) {
      const i = ((bar.openTimeMs - startMs) / MINUTE_MS) * 4;
      data[i] = bar.open;
      data[i + 1] = bar.high;
      data[i + 2] = bar.low;
      data[i + 3] = bar.close;
    }
    this.series.delete(symbol);
    this.series.set(symbol, { startMs, endMs, data, lastUsedMs: this.now() });
    this.evict();
  }

  private evict(): void {
    let total = 0;
    for (const s of this.series.values()) total += (s.endMs - s.startMs) / MINUTE_MS;
    for (const [symbol, s] of [...this.series.entries()].sort((a, b) => a[1].lastUsedMs - b[1].lastUsedMs)) {
      if (total <= this.maxCachedMinutes) break;
      total -= (s.endMs - s.startMs) / MINUTE_MS;
      this.series.delete(symbol);
    }
  }

  /** The minute ranges still missing for `request` at `nowMs` (closed minutes only). */
  private gaps(request: MarketDataRequest, nowMs: number): Array<[number, number]> {
    const from = floorMinute(request.fromMs);
    const to = Math.min(request.toMs, floorMinute(nowMs));
    if (to <= from) return [];
    const s = this.series.get(request.symbol);
    if (!s) return [[from, to]];
    const out: Array<[number, number]> = [];
    if (from < s.startMs) out.push([from, Math.min(s.startMs, to)]);
    if (to > s.endMs) out.push([Math.max(s.endMs, from), to]);
    return out;
  }

  /**
   * Loads what the requests need, in priority order, until the budget is spent.
   * Requests for one symbol are merged into one range. Never throws.
   */
  async ensure(requests: readonly MarketDataRequest[], deadlineMs: number = Number.POSITIVE_INFINITY): Promise<{ loaded: number; skipped: number }> {
    const merged = new Map<string, MarketDataRequest>();
    for (const r of requests) {
      const m = merged.get(r.symbol);
      merged.set(r.symbol, m ? { symbol: r.symbol, fromMs: Math.min(m.fromMs, r.fromMs), toMs: Math.max(m.toMs, r.toMs) } : r);
    }
    const queue = [...merged.values()];
    let loaded = 0;
    let skipped = 0;
    let exhausted = false;
    const worker = async () => {
      for (;;) {
        const request = queue.shift();
        if (request === undefined) return;
        if (exhausted || this.now() >= deadlineMs) {
          skipped += 1;
          continue;
        }
        const failure = this.failures.get(request.symbol);
        if (failure && this.now() - failure.atMs < OBSERVATORY_FAILURE_RETRY_MS) continue;
        try {
          for (const [from, to] of this.gaps(request, this.now())) {
            this.store(request.symbol, from, to, await this.fetchMinutes(request.symbol, from, to));
          }
          this.failures.delete(request.symbol);
          loaded += 1;
        } catch (error) {
          if (error instanceof BudgetExhausted) {
            exhausted = true;
            skipped += 1;
          } else {
            this.failures.set(request.symbol, { atMs: this.now(), reason: error instanceof Error ? error.message.slice(0, 200) : "the public market-data request failed" });
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.maxInFlight) }, worker));
    return { loaded, skipped };
  }

  /** What is known for one alert's range, without any request. */
  view(request: MarketDataRequest): MarketDataView {
    const s = this.series.get(request.symbol);
    const from = floorMinute(request.fromMs);
    if (s && s.startMs <= from && s.endMs > from) {
      s.lastUsedMs = this.now();
      const data = s.data;
      const start = s.startMs;
      const end = s.endMs;
      const lookup = (openTimeMs: number): MinuteBar | undefined => {
        if (openTimeMs < start || openTimeMs >= end) return undefined;
        const i = ((openTimeMs - start) / MINUTE_MS) * 4;
        const open = data[i];
        if (!Number.isFinite(open)) return undefined;
        return { openTimeMs, open, high: data[i + 1], low: data[i + 2], close: data[i + 3] };
      };
      return { marketData: { status: "LOADED", bars: lookup }, coveredThroughMs: end };
    }
    const failure = this.failures.get(request.symbol);
    if (failure) return { marketData: { status: "UNAVAILABLE", reason: `public market data unavailable: ${failure.reason}` }, coveredThroughMs: null };
    return { marketData: { status: "NOT_LOADED", reason: "public market data not loaded yet (observatory request budget); refresh to continue loading" }, coveredThroughMs: null };
  }

  /** 15-minute bars of [fromMs, toMs) for a chart; one bounded request, cached. Never throws. */
  async chartBars(symbol: string, fromMs: number, toMs: number): Promise<{ bars: ChartBar[] } | { error: string }> {
    const from = Math.floor(fromMs / QUARTER_MS) * QUARTER_MS;
    const to = Math.floor(toMs / QUARTER_MS) * QUARTER_MS;
    const key = `${symbol}|${from}|${to}`;
    const cached = this.charts.get(key);
    if (cached && (cached.complete || this.now() - cached.fetchedAtMs < 60_000)) return { bars: cached.bars };
    if (to <= from) return { bars: [] };
    const limit = Math.min(1000, (to - from) / QUARTER_MS);
    try {
      const url = buildPublicFuturesUrl(PUBLIC_FUTURES_ORIGIN, KLINES_PATH, { symbol, interval: "15m", startTime: from, endTime: Math.min(to, from + limit * QUARTER_MS) - 1, limit });
      const payload = await this.get(url, klinesWeightForLimit(limit));
      const nowMs = this.now();
      const bars = parseFuturesKlinesPayload(payload, QUARTER_MS)
        .filter((k) => k.openTimeMs + QUARTER_MS <= nowMs)
        .map((k) => ({ time: Math.floor(k.openTimeMs / 1000), open: k.open, high: k.high, low: k.low, close: k.close }));
      if (this.charts.size >= 200) this.charts.delete(this.charts.keys().next().value as string);
      this.charts.set(key, { bars, fetchedAtMs: nowMs, complete: to <= floorMinute(nowMs) - QUARTER_MS });
      return { bars };
    } catch (error) {
      if (error instanceof BudgetExhausted) return { error: "chart data not loaded (observatory request budget); retry shortly" };
      return { error: error instanceof Error ? error.message.slice(0, 200) : "the public chart request failed" };
    }
  }
}
