import type { NativeKline } from "@trading-alert-dashboard/shared";

import {
  KLINES_PATH,
  SERVER_TIME_PATH,
  ScannerDataError,
  assertScannerSymbol,
  buildPublicFuturesUrl,
  intervalMsOf,
  parseFuturesKlinesPayload,
  parseRetryAfterMs,
  parseServerTimePayload,
  type ScannerChartInterval,
} from "./binance-public-futures";
import { mergeClosedKlines } from "./kline-cache";

/**
 * Sequential, budgeted, closed-only fetching of public Futures klines.
 *
 * The same machine and IP carry Teddy's Account A/B Binance traffic, and
 * Binance's REST limits are per IP. A scanner burst that earned a 429 or a 418
 * would block those accounts' reconciliation and protection while positions
 * are open. So this module is built to be incapable of a burst:
 *
 *  - one request at a time, awaited — there is no concurrency anywhere;
 *  - a minimum spacing between request starts, with a hard floor;
 *  - a per-run request budget that counts every attempt, retries included;
 *  - 418 and 429 stop the run outright: no retry, Retry-After reported;
 *  - other failures retry a bounded number of times, with backoff.
 *
 * The transport, clock and sleep are injected. Nothing here touches the
 * network on its own, so tests can prove behaviour with no real request.
 */

export interface PublicHttpResponse {
  readonly status: number;
  header(name: string): string | null;
  text(): Promise<string>;
}

/** Performs one GET. Receives the full URL and the ONLY headers the scanner sends. */
export type PublicHttpTransport = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> }
) => Promise<PublicHttpResponse>;

export interface PublicRequestPolicy {
  /** Every attempt counts, retries included. The run stops when it is spent. */
  readonly maxRequests: number;
  /** Minimum gap between the starts of two requests. */
  readonly minSpacingMs: number;
  /** Retries per request for transport errors and 5xx. Never for 418/429/4xx. */
  readonly maxTransientRetries: number;
  /** First retry backoff; doubled each further retry. */
  readonly transientBackoffMs: number;
}

/** Deliberately slow. Configurable, but never below the floors. */
export const CONSERVATIVE_REQUEST_POLICY: PublicRequestPolicy = Object.freeze({
  maxRequests: 40,
  minSpacingMs: 1000,
  maxTransientRetries: 2,
  transientBackoffMs: 2000,
});

/** Hard limits no configuration can cross. */
export const REQUEST_POLICY_LIMITS = Object.freeze({
  minSpacingFloorMs: 250,
  maxRequestsCeiling: 500,
  maxTransientRetriesCeiling: 3,
});

export function assertRequestPolicy(policy: PublicRequestPolicy): PublicRequestPolicy {
  const { maxRequests, minSpacingMs, maxTransientRetries, transientBackoffMs } = policy;
  const fail = (message: string): never => {
    throw new ScannerDataError("INVALID_RANGE", `request policy: ${message}`);
  };
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > REQUEST_POLICY_LIMITS.maxRequestsCeiling) {
    fail(`maxRequests must be an integer 1..${REQUEST_POLICY_LIMITS.maxRequestsCeiling}`);
  }
  if (!Number.isSafeInteger(minSpacingMs) || minSpacingMs < REQUEST_POLICY_LIMITS.minSpacingFloorMs) {
    fail(`minSpacingMs must be an integer >= ${REQUEST_POLICY_LIMITS.minSpacingFloorMs}`);
  }
  if (
    !Number.isSafeInteger(maxTransientRetries) ||
    maxTransientRetries < 0 ||
    maxTransientRetries > REQUEST_POLICY_LIMITS.maxTransientRetriesCeiling
  ) {
    fail(`maxTransientRetries must be an integer 0..${REQUEST_POLICY_LIMITS.maxTransientRetriesCeiling}`);
  }
  if (!Number.isSafeInteger(transientBackoffMs) || transientBackoffMs < minSpacingMs) {
    fail("transientBackoffMs must be an integer >= minSpacingMs");
  }
  return policy;
}

export interface PublicFetchDeps {
  readonly transport: PublicHttpTransport;
  readonly baseUrl: string;
  readonly policy: PublicRequestPolicy;
  /** The caller's clock. Pacing and Retry-After dates are judged against it. */
  readonly nowMs: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** The headers the scanner sends — all of them. */
const REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({ Accept: "application/json" });

/** One run's request discipline. Not shared between runs. */
export class PublicRequestController {
  private requestsMade = 0;
  private lastStartMs: number | null = null;

  constructor(private readonly deps: PublicFetchDeps) {
    assertRequestPolicy(deps.policy);
  }

  get requestCount(): number {
    return this.requestsMade;
  }

  /** GET `url` and parse JSON, under the policy. */
  async getJson(url: string): Promise<unknown> {
    const { policy, transport, nowMs, sleep } = this.deps;
    for (let attempt = 0; ; attempt += 1) {
      if (this.requestsMade >= policy.maxRequests) {
        throw new ScannerDataError(
          "REQUEST_BUDGET_EXHAUSTED",
          `the request budget of ${policy.maxRequests} is spent; nothing further was sent`
        );
      }
      if (this.lastStartMs !== null) {
        const wait = this.lastStartMs + policy.minSpacingMs - nowMs();
        if (wait > 0) await sleep(wait);
      }
      this.lastStartMs = nowMs();
      this.requestsMade += 1;

      const retryable = attempt < policy.maxTransientRetries;
      const backOff = async () => sleep(policy.transientBackoffMs * 2 ** attempt);

      let response: PublicHttpResponse;
      try {
        response = await transport(url, { headers: REQUEST_HEADERS });
      } catch {
        if (retryable) {
          await backOff();
          continue;
        }
        throw new ScannerDataError("TRANSPORT_FAILED", "the request failed and the retry allowance is spent");
      }

      if (response.status === 418 || response.status === 429) {
        const retryAfterMs = parseRetryAfterMs(response.header("Retry-After"), nowMs());
        throw new ScannerDataError(
          response.status === 418 ? "IP_BANNED" : "RATE_LIMITED",
          `Binance answered ${response.status}; the run stopped without retrying` +
            (retryAfterMs === null ? "" : ` (Retry-After ${Math.ceil(retryAfterMs / 1000)}s)`),
          retryAfterMs
        );
      }
      if (response.status >= 500) {
        if (retryable) {
          await backOff();
          continue;
        }
        throw new ScannerDataError("HTTP_ERROR", `Binance answered ${response.status} and the retry allowance is spent`);
      }
      if (response.status !== 200) {
        throw new ScannerDataError("HTTP_ERROR", `Binance answered ${response.status}`);
      }

      const text = await response.text();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ScannerDataError("MALFORMED_RESPONSE", "the response body is not JSON");
      }
    }
  }
}

export interface ClosedKlineRangeRequest {
  readonly symbol: string;
  readonly interval: ScannerChartInterval;
  /** First bar's openTime, inclusive. Must be interval-aligned. */
  readonly startMs: number;
  /** End of the range, exclusive: the last bar opens at endMs - interval. */
  readonly endMs: number;
  /** Refuse any range wider than this many bars. No default: the caller states it. */
  readonly maxBars: number;
  /** Rows per page; Binance accepts up to 1500 for futures klines. */
  readonly pageLimit: number;
  /** A bar counts as closed only once server time has passed its close by this much. */
  readonly settleMs: number;
}

export interface ClosedKlineRangeResult {
  readonly klines: NativeKline[];
  readonly serverTimeMs: number;
  readonly requestsMade: number;
}

/**
 * Every CLOSED kline in [startMs, endMs), fetched page by page.
 *
 * Closure is judged by Binance's own clock, fetched first: a range whose last
 * bar has not closed by `serverTime - settleMs` is refused outright rather than
 * silently shortened. Pages advance by openTime; a page may overlap the
 * previous one only with identical rows, and a page that does not move forward
 * stops the run. Missing bars are returned as missing — gaps are judged by the
 * caller, never filled here.
 */
export async function fetchClosedFuturesKlines(
  deps: PublicFetchDeps,
  request: ClosedKlineRangeRequest
): Promise<ClosedKlineRangeResult> {
  const symbol = assertScannerSymbol(request.symbol);
  const intervalMs = intervalMsOf(request.interval);
  const { startMs, endMs, maxBars, pageLimit, settleMs } = request;
  const invalid = (message: string): never => {
    throw new ScannerDataError("INVALID_RANGE", message);
  };
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs >= endMs) {
    invalid("startMs and endMs must be integers with startMs < endMs");
  }
  if (startMs % intervalMs !== 0 || endMs % intervalMs !== 0) invalid("range bounds must be aligned to the chart interval");
  if (!Number.isSafeInteger(maxBars) || maxBars < 1) invalid("maxBars must be a positive integer");
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 1500) invalid("pageLimit must be 1..1500");
  if (!Number.isSafeInteger(settleMs) || settleMs < 0) invalid("settleMs must be a non-negative integer");
  const barCount = (endMs - startMs) / intervalMs;
  if (barCount > maxBars) {
    throw new ScannerDataError("RANGE_TOO_LARGE", `the range holds ${barCount} bars; the limit for this run is ${maxBars}`);
  }

  const controller = new PublicRequestController(deps);
  const serverTimeMs = parseServerTimePayload(await controller.getJson(buildPublicFuturesUrl(deps.baseUrl, SERVER_TIME_PATH)));
  const closedBefore = serverTimeMs - settleMs;
  // The last requested bar closes at endMs - 1.
  if (endMs - 1 >= closedBefore) {
    throw new ScannerDataError(
      "RANGE_NOT_CLOSED",
      `the range ends ${new Date(endMs).toISOString()}, which has not closed by Binance's clock`
    );
  }

  let collected: NativeKline[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = buildPublicFuturesUrl(deps.baseUrl, KLINES_PATH, {
      symbol,
      interval: request.interval,
      startTime: cursor,
      endTime: endMs - 1,
      limit: pageLimit,
    });
    const page = parseFuturesKlinesPayload(await controller.getJson(url), intervalMs);
    if (page.length === 0) break; // nothing further exists; gaps are the caller's to judge

    let previous = -Infinity;
    for (const kline of page) {
      if (kline.openTimeMs < startMs || kline.openTimeMs >= endMs) {
        throw new ScannerDataError(
          "OUT_OF_RANGE_ROW",
          `Binance returned a candle at ${new Date(kline.openTimeMs).toISOString()}, outside the requested range`
        );
      }
      if (kline.openTimeMs <= previous) throw new ScannerDataError("MALFORMED_RESPONSE", "a page is not strictly ordered");
      if (kline.closeTimeMs >= closedBefore) throw new ScannerDataError("RANGE_NOT_CLOSED", "a page contains a candle that has not closed");
      previous = kline.openTimeMs;
    }
    collected = mergeClosedKlines(collected, page);

    const nextCursor = page[page.length - 1].openTimeMs + intervalMs;
    if (nextCursor <= cursor) {
      throw new ScannerDataError("PAGINATION_STALLED", "a page did not advance past the previous one; the run stopped");
    }
    cursor = nextCursor;
  }

  return { klines: collected, serverTimeMs, requestsMade: controller.requestCount };
}
