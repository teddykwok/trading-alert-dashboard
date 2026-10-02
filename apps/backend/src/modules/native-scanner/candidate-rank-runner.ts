import {
  NativeSignalInputError,
  SWITCHOVER_TRUNCATED_CLOSED_BARS,
  snapshotNativeEngineForNextBar,
  type NativeKline,
  type NativeSourceTf,
} from "@trading-alert-dashboard/shared";

import {
  EXCHANGE_INFO_PATH,
  SCANNER_MARKET_TYPE,
  SERVER_TIME_PATH,
  ScannerDataError,
  TICKER_PRICE_PATH,
  buildPublicFuturesUrl,
  intervalMsOf,
  parseServerTimePayload,
} from "./binance-public-futures";
import {
  CANDIDATE_RANK_NOTICE,
  CANDIDATE_RANK_SCHEMA,
  evaluateSymbol,
  parseTickerPrices,
  rankCandidates,
  signalConfigFingerprint,
  type CurrentPrice,
  type RankedCandidate,
  type RankingOptions,
  type SkipReason,
  type SkippedSymbol,
  type SymbolEvaluation,
} from "./candidate-ranker";
import { CompatReplayError } from "./compat-replay";
import { KlineCacheError, mergeClosedKlines, type LoadedKlineCache } from "./kline-cache";
import {
  PublicRequestController,
  REQUEST_POLICY_LIMITS,
  fetchClosedFuturesKlines,
  type PublicHttpResponse,
  type PublicHttpTransport,
  type PublicRequestPolicy,
} from "./kline-fetcher";
import type { LineageConfig } from "./live-shadow-cli-args";
import { LiveShadowError } from "./live-shadow-checkpoint";
import { prepareLiveShadowState } from "./live-shadow-session";
import { REPLAY_PAGE_LIMIT, REPLAY_SETTLE_MS } from "./replay-cli-args";
import { deriveHtfContextStartMs } from "./scanner-lineage";
import {
  UNIVERSE_NAME,
  parseExchangeInfoContracts,
  selectSymbols,
  selectUsdtPerpetualUniverse,
  type UniverseSelection,
  type UniverseSelectionSpec,
  type UsdmUniverse,
} from "./usdm-universe";

/**
 * READ-ONLY candidate ranking over the USD-M USDT-perpetual universe.
 *
 * For each selected symbol it rebuilds the committed engine state through the
 * SAME path the live shadow scanner uses (`prepareLiveShadowState`: Pine-
 * compatible historical reconstruction to the fixed switchover, then the
 * causal engine over every CLOSED bar up to one run-wide boundary), takes a
 * read-only diagnostic snapshot, and measures the current public price
 * against it. No partial bar ever enters the state: the boundary is the open
 * of the bar forming at Binance's own clock, and the cache holds closed bars only.
 *
 * Network discipline, because the same IP carries Account A/B traffic:
 *  - every request goes through ONE governed transport: strictly one at a
 *    time, a global minimum spacing, a global request budget;
 *  - a 418 or 429 anywhere halts the whole run (a global invariant), never
 *    retried and never followed by another request;
 *  - per-symbol work runs in a bounded pool, but the pool only overlaps CPU
 *    replay with the (still serial) network — it can never add a request burst.
 *
 * It writes nothing but the public kline cache. No database, queue, alert,
 * account or signed endpoint is reachable from here.
 */

export class CandidateRankHaltError extends Error {
  constructor(
    readonly code: "RATE_LIMITED" | "IP_BANNED" | "INVALID_STATE",
    message: string
  ) {
    super(message);
    this.name = "CandidateRankHaltError";
  }
}

export interface GovernorOptions {
  readonly maxTotalRequests: number;
  readonly minSpacingMs: number;
  readonly nowMs: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Hard ceiling on one run's total public requests, whatever is configured. */
export const MAX_TOTAL_REQUESTS_CEILING = 20_000;

/**
 * The single gate every public request of a run passes through. Serial,
 * spaced, budgeted; a 418/429 trips it permanently for the run.
 */
export class GovernedPublicTransport {
  private tail: Promise<unknown> = Promise.resolve();
  private lastStartMs: number | null = null;
  private made = 0;
  private haltedBy: CandidateRankHaltError | null = null;
  /** Held back for the run's final price request, so kline fetching can never starve it. */
  private reserved = 1;

  constructor(
    private readonly inner: PublicHttpTransport,
    private readonly options: GovernorOptions
  ) {
    if (!Number.isSafeInteger(options.maxTotalRequests) || options.maxTotalRequests < 4 || options.maxTotalRequests > MAX_TOTAL_REQUESTS_CEILING) {
      throw new ScannerDataError("INVALID_RANGE", `the total request budget must be 4..${MAX_TOTAL_REQUESTS_CEILING}`);
    }
    if (!Number.isSafeInteger(options.minSpacingMs) || options.minSpacingMs < REQUEST_POLICY_LIMITS.minSpacingFloorMs) {
      throw new ScannerDataError("INVALID_RANGE", `request spacing must be >= ${REQUEST_POLICY_LIMITS.minSpacingFloorMs} ms`);
    }
  }

  get requestsMade(): number {
    return this.made;
  }
  get budget(): number {
    return this.options.maxTotalRequests;
  }
  get exhausted(): boolean {
    return this.made >= this.options.maxTotalRequests - this.reserved;
  }
  /** Releases the held-back request; call only for the final price request. */
  releaseReserve(): void {
    this.reserved = 0;
  }
  get halt(): CandidateRankHaltError | null {
    return this.haltedBy;
  }

  readonly transport: PublicHttpTransport = (url, init) => {
    const run = this.tail.then(() => this.send(url, init));
    this.tail = run.catch(() => undefined);
    return run;
  };

  private async send(url: string, init: { readonly headers: Readonly<Record<string, string>> }): Promise<PublicHttpResponse> {
    if (this.haltedBy !== null) throw this.haltedBy;
    if (this.made >= this.options.maxTotalRequests - this.reserved) {
      throw new ScannerDataError("REQUEST_BUDGET_EXHAUSTED", `the run's total budget of ${this.options.maxTotalRequests} public requests is spent`);
    }
    if (this.lastStartMs !== null) {
      const wait = this.lastStartMs + this.options.minSpacingMs - this.options.nowMs();
      if (wait > 0) await this.options.sleep(wait);
    }
    this.lastStartMs = this.options.nowMs();
    this.made += 1;
    const response = await this.inner(url, init);
    if (response.status === 418 || response.status === 429) {
      this.haltedBy = new CandidateRankHaltError(
        response.status === 418 ? "IP_BANNED" : "RATE_LIMITED",
        `Binance answered ${response.status}; the whole run stopped and sent nothing further`
      );
    }
    return response;
  }
}

/**
 * `fn` over `items` with at most `limit` in flight. Results are by input index,
 * so completion order can never reorder them. A throw stops new work, waits for
 * work already started, then rethrows the first error.
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new ScannerDataError("INVALID_RANGE", "concurrency must be a positive integer");
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    for (;;) {
      if (failure !== null) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== null) throw (failure as { error: unknown }).error;
  return results;
}

export interface KlineCacheLike {
  load(marketType: typeof SCANNER_MARKET_TYPE, symbol: string, interval: LineageConfig["chartInterval"]): LoadedKlineCache | null;
  save(marketType: typeof SCANNER_MARKET_TYPE, symbol: string, interval: LineageConfig["chartInterval"], klines: readonly NativeKline[], writtenAt: string): unknown;
}

export interface CandidateRankRequest {
  readonly lineage: LineageConfig;
  readonly selection: UniverseSelectionSpec;
  readonly ranking: RankingOptions;
  readonly concurrency: number;
  /** Never fetch klines: symbols the cache cannot cover are skipped. */
  readonly cacheOnly: boolean;
  /** Stop after universe discovery and selection. */
  readonly universeOnly: boolean;
}

export interface CandidateRankDeps {
  readonly transport: PublicHttpTransport;
  readonly baseUrl: string;
  readonly maxTotalRequests: number;
  readonly minSpacingMs: number;
  readonly cache: KlineCacheLike;
  readonly nowMs: () => number;
  readonly nowIso: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  /** Progress lines only; never payloads. */
  readonly log: (line: string) => void;
}

export const PROGRESS_EVERY = 25;

interface SymbolOutcome {
  readonly evaluation: SymbolEvaluation | null;
  readonly skip: SkippedSymbol | null;
  readonly fetchedRequests: number;
  readonly fromCacheOnly: boolean;
}

/** End (exclusive) of the contiguous run of bars starting exactly at `fromMs`, below `limitMs`. */
export function contiguousEnd(klines: readonly NativeKline[], fromMs: number, limitMs: number, intervalMs: number): number {
  let expected = fromMs;
  for (const k of klines) {
    if (k.openTimeMs < expected) continue;
    if (k.openTimeMs !== expected || k.openTimeMs >= limitMs) break;
    expected += intervalMs;
  }
  return expected;
}

function skip(symbol: string, reason: SkipReason, detail: string, fetchedRequests = 0): SymbolOutcome {
  return { evaluation: null, skip: { symbol, reason, detail }, fetchedRequests, fromCacheOnly: false };
}

export type CacheFillOutcome =
  | { readonly kind: "OK"; readonly klines: NativeKline[]; readonly fetchedRequests: number }
  | { readonly kind: "SKIP"; readonly reason: SkipReason; readonly detail: string; readonly fetchedRequests: number };

export interface CacheFillRequest {
  readonly symbol: string;
  readonly chartInterval: LineageConfig["chartInterval"];
  /** Every bar from here … */
  readonly contextStartMs: number;
  /** … to here (exclusive) must be cached, contiguous and closed. */
  readonly endMs: number;
  readonly cache: KlineCacheLike;
  readonly fetchDeps: Parameters<typeof fetchClosedFuturesKlines>[0];
  readonly governor: GovernedPublicTransport;
  readonly cacheOnly: boolean;
  readonly nowIso: () => string;
}

/**
 * The public kline cache for one symbol, filled (through the run's governed
 * transport) so that every CLOSED bar of [contextStartMs, endMs) is present
 * and contiguous — or a machine-readable reason it cannot be. A corrupt cache
 * is reported and never overwritten; a 418/429 halts the whole run.
 */
export async function fillClosedBarCache(args: CacheFillRequest): Promise<CacheFillOutcome> {
  const { symbol, chartInterval, contextStartMs, endMs, cache, governor } = args;
  const intervalMs = intervalMsOf(chartInterval);
  const skipped = (reason: SkipReason, detail: string, fetchedRequests = 0): CacheFillOutcome => ({ kind: "SKIP", reason, detail, fetchedRequests });

  let loaded: LoadedKlineCache | null;
  try {
    loaded = cache.load(SCANNER_MARKET_TYPE, symbol, chartInterval);
  } catch (error) {
    // A corrupt cache is reported and left untouched — never overwritten.
    if (error instanceof KlineCacheError || error instanceof ScannerDataError) return skipped("CACHE_UNUSABLE", `${error.name}: ${error.message}`);
    throw error;
  }
  let klines = loaded?.klines ?? [];
  let trustedEndMs = contiguousEnd(klines, contextStartMs, endMs, intervalMs);
  let fetchedRequests = 0;

  if (trustedEndMs < endMs) {
    if (args.cacheOnly) return skipped("CACHE_ONLY_MISSING_DATA", `the cache covers closed bars only to ${new Date(trustedEndMs).toISOString()}`);
    if (governor.exhausted) return skipped("REQUEST_BUDGET_EXHAUSTED", "the run's public request budget was spent before this symbol");
    try {
      const result = await fetchClosedFuturesKlines(args.fetchDeps, {
        symbol,
        interval: chartInterval,
        startMs: trustedEndMs,
        endMs,
        maxBars: Math.max(1, (endMs - trustedEndMs) / intervalMs),
        pageLimit: REPLAY_PAGE_LIMIT,
        settleMs: REPLAY_SETTLE_MS,
      });
      fetchedRequests = result.requestsMade;
      if (result.klines.length > 0) {
        klines = mergeClosedKlines(klines, result.klines);
        cache.save(SCANNER_MARKET_TYPE, symbol, chartInterval, klines, args.nowIso());
        // Replay the verified cache, never memory.
        klines = cache.load(SCANNER_MARKET_TYPE, symbol, chartInterval)?.klines ?? [];
      }
    } catch (error) {
      if (governor.halt !== null) throw governor.halt;
      if (error instanceof ScannerDataError) {
        if (error.code === "REQUEST_BUDGET_EXHAUSTED") return skipped("REQUEST_BUDGET_EXHAUSTED", error.message, fetchedRequests);
        if (error.code === "INVALID_SYMBOL") return skipped("UNSUPPORTED_SYMBOL", error.message);
        if (error.code === "CONTRADICTORY_ROW") return skipped("CACHE_UNUSABLE", `fetched bars contradict the cache: ${error.message}`);
        return skipped("PUBLIC_FETCH_FAILED", `${error.code}: ${error.message}`, fetchedRequests);
      }
      if (error instanceof KlineCacheError) return skipped("CACHE_UNUSABLE", error.message);
      throw error;
    }
    trustedEndMs = contiguousEnd(klines, contextStartMs, endMs, intervalMs);
  }

  if (trustedEndMs < endMs) {
    const first = klines.find((k) => k.openTimeMs >= contextStartMs);
    return first === undefined || first.openTimeMs > contextStartMs
      ? skipped("INSUFFICIENT_HISTORY", `no contiguous data from the HTF context start ${new Date(contextStartMs).toISOString()}`, fetchedRequests)
      : skipped("INCOMPLETE_DATA", `closed bars are contiguous only to ${new Date(trustedEndMs).toISOString()}`, fetchedRequests);
  }
  return { kind: "OK", klines, fetchedRequests };
}

export async function runCandidateRank(request: CandidateRankRequest, deps: CandidateRankDeps) {
  const { lineage } = request;
  const intervalMs = intervalMsOf(lineage.chartInterval);
  const governor = new GovernedPublicTransport(deps.transport, {
    maxTotalRequests: deps.maxTotalRequests,
    minSpacingMs: deps.minSpacingMs,
    nowMs: deps.nowMs,
    sleep: deps.sleep,
  });
  // Per-call discipline is still the hardened fetcher's own; the governor is the run-wide cap.
  const policy: PublicRequestPolicy = {
    maxRequests: REQUEST_POLICY_LIMITS.maxRequestsCeiling,
    minSpacingMs: deps.minSpacingMs,
    maxTransientRetries: 2,
    transientBackoffMs: Math.max(2_000, deps.minSpacingMs),
  };
  const fetchDeps = { transport: governor.transport, baseUrl: deps.baseUrl, policy, nowMs: deps.nowMs, sleep: deps.sleep };
  const single = new PublicRequestController(fetchDeps);
  const rethrowHalt = (error: unknown): never => {
    throw governor.halt ?? error;
  };

  // ---- universe ------------------------------------------------------------
  const exchangeInfo = await single.getJson(buildPublicFuturesUrl(deps.baseUrl, EXCHANGE_INFO_PATH)).catch(rethrowHalt);
  const universe: UsdmUniverse = selectUsdtPerpetualUniverse(parseExchangeInfoContracts(exchangeInfo));
  const selection: UniverseSelection = selectSymbols(universe, request.selection);
  deps.log(`${UNIVERSE_NAME} universe`);
  deps.log(`active symbols: ${universe.contracts.length} (listed ${universe.totalListed})`);
  deps.log(`selected: ${selection.symbols.length}${selection.truncatedByMaxSymbols > 0 ? ` (${selection.truncatedByMaxSymbols} left out by --max-symbols)` : ""}`);

  const base = {
    schema: CANDIDATE_RANK_SCHEMA,
    notice: CANDIDATE_RANK_NOTICE,
    actionable: false as const,
    universe: {
      name: universe.name,
      totalListed: universe.totalListed,
      eligible: universe.contracts.length,
      excluded: universe.excluded,
      identicalDuplicatesCollapsed: universe.identicalDuplicatesCollapsed,
      selection: {
        spec: request.selection,
        selected: selection.symbols.length,
        truncatedByMaxSymbols: selection.truncatedByMaxSymbols,
        symbols: selection.symbols,
      },
    },
  };
  if (request.universeOnly) {
    return { ...base, generatedAt: deps.nowIso(), contracts: selection.contracts, requests: { made: governor.requestsMade, budget: governor.budget } };
  }

  // ---- one run-wide committed boundary, by Binance's clock ------------------
  const serverTimeMs = parseServerTimePayload(await single.getJson(buildPublicFuturesUrl(deps.baseUrl, SERVER_TIME_PATH)).catch(rethrowHalt));
  // Open time of the bar FORMING at Binance's clock (minus settle): every bar before it is closed.
  const boundaryMs = Math.floor((serverTimeMs - REPLAY_SETTLE_MS) / intervalMs) * intervalMs;
  if (!(boundaryMs > lineage.switchoverMs)) {
    throw new CandidateRankHaltError("INVALID_STATE", "no closed bar exists after the switchover yet");
  }
  const contextStartMs = deriveHtfContextStartMs(lineage.historyStartMs, lineage.engine.enabledSourceTfs, lineage.engine.calendar);
  deps.log(`committed through bar ${new Date(boundaryMs - intervalMs).toISOString()} (forming bar ${new Date(boundaryMs).toISOString()})`);

  // ---- per symbol, bounded --------------------------------------------------
  let processed = 0;
  const outcomes = await mapBounded(selection.contracts, request.concurrency, async (contract): Promise<SymbolOutcome> => {
    const outcome = await evaluateOne(contract.symbol, contract.displaySymbol, contract.onboardDateMs);
    processed += 1;
    if (processed % PROGRESS_EVERY === 0 || processed === selection.contracts.length) {
      deps.log(`processed ${processed}/${selection.contracts.length} (requests ${governor.requestsMade}/${governor.budget})`);
    }
    return outcome;
  });

  async function evaluateOne(symbol: string, displaySymbol: string, onboardDateMs: number | null): Promise<SymbolOutcome> {
    if (governor.halt !== null) throw governor.halt;
    if (onboardDateMs !== null && onboardDateMs > contextStartMs) {
      return skip(symbol, "INSUFFICIENT_HISTORY", `listed ${new Date(onboardDateMs).toISOString()}, after the HTF context start ${new Date(contextStartMs).toISOString()}`);
    }

    const filled = await fillClosedBarCache({
      symbol,
      chartInterval: lineage.chartInterval,
      contextStartMs,
      endMs: boundaryMs,
      cache: deps.cache,
      fetchDeps,
      governor,
      cacheOnly: request.cacheOnly,
      nowIso: deps.nowIso,
    });
    if (filled.kind === "SKIP") return skip(symbol, filled.reason, filled.detail, filled.fetchedRequests);
    const { klines, fetchedRequests } = filled;

    try {
      // The live scanner's own reconstruction, over CLOSED bars before the boundary only.
      const plan = prepareLiveShadowState(
        klines,
        {
          symbol,
          marketType: SCANNER_MARKET_TYPE,
          chartInterval: lineage.chartInterval,
          historyStartMs: lineage.historyStartMs,
          switchoverMs: lineage.switchoverMs,
          engine: lineage.engine,
          partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
          expectedLineageId: null,
        },
        boundaryMs,
        null
      );
      // The committed state ends exactly at the last CLOSED bar.
      if (plan.hwmOpenTimeMs !== boundaryMs || plan.state.lastBar?.openTimeMs !== boundaryMs - intervalMs) {
        throw new CandidateRankHaltError("INVALID_STATE", `${symbol}: the committed state does not end at the last closed bar`);
      }
      return {
        evaluation: { symbol, displaySymbol, lineageId: plan.lineageId, snapshot: snapshotNativeEngineForNextBar(plan.state), config: plan.state.config },
        skip: null,
        fetchedRequests,
        fromCacheOnly: fetchedRequests === 0,
      };
    } catch (error) {
      if (error instanceof CandidateRankHaltError) throw error;
      if (error instanceof CompatReplayError) {
        return skip(symbol, error.code === "INSUFFICIENT_HTF_CONTEXT" ? "INSUFFICIENT_HISTORY" : "INCOMPLETE_DATA", error.message, fetchedRequests);
      }
      if (error instanceof LiveShadowError || error instanceof NativeSignalInputError) {
        return skip(symbol, "REPLAY_REFUSED", `${error.name}: ${error.message}`, fetchedRequests);
      }
      throw error;
    }
  }

  // ---- advisory prices: one public request for every symbol -----------------
  const evaluations = outcomes.flatMap((o) => (o.evaluation === null ? [] : [o.evaluation]));
  let prices = new Map<string, CurrentPrice>();
  let priceError: string | null = null;
  if (evaluations.length > 0) {
    try {
      governor.releaseReserve();
      prices = parseTickerPrices(await single.getJson(buildPublicFuturesUrl(deps.baseUrl, TICKER_PRICE_PATH)));
    } catch (error) {
      if (governor.halt !== null) throw governor.halt;
      if (!(error instanceof ScannerDataError)) throw error;
      priceError = `${error.code}: ${error.message}`;
    }
  }

  // ---- rank -------------------------------------------------------------------
  const skipped: SkippedSymbol[] = outcomes.flatMap((o) => (o.skip === null ? [] : [o.skip]));
  const rows: Omit<RankedCandidate, "rank">[] = [];
  const priceTimes: number[] = [];
  for (const evaluation of evaluations) {
    const price = prices.get(evaluation.symbol);
    if (price === undefined) {
      skipped.push({ symbol: evaluation.symbol, reason: "PRICE_UNAVAILABLE", detail: priceError ?? "no public price for this symbol" });
      continue;
    }
    if (price.observedAtMs !== null) priceTimes.push(price.observedAtMs);
    const symbolRows = evaluateSymbol(evaluation, price, request.ranking.deliverySourceTfs);
    if (symbolRows.length === 0) {
      skipped.push({ symbol: evaluation.symbol, reason: "NO_DELIVERABLE_ACTIVE_LEVEL", detail: `no registered ${request.ranking.deliverySourceTfs.join("/")} level` });
      continue;
    }
    if (!request.ranking.includeNotReady && !symbolRows.some((row) => row.triggerReadiness === "TRIGGER_READY")) {
      skipped.push({ symbol: evaluation.symbol, reason: "NO_TRIGGER_READY_LEVEL", detail: `${symbolRows.length} ${request.ranking.deliverySourceTfs.join("/")} level(s), none trigger-ready` });
    }
    rows.push(...symbolRows);
  }
  skipped.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const candidates = rankCandidates(rows, request.ranking);

  const skippedByReason: Partial<Record<SkipReason, number>> = {};
  for (const s of skipped) skippedByReason[s.reason] = (skippedByReason[s.reason] ?? 0) + 1;
  const latestPriceMs = priceTimes.length > 0 ? Math.max(...priceTimes) : null;
  const rankableSymbols = new Set(rows.filter((r) => request.ranking.includeNotReady || r.triggerReadiness === "TRIGGER_READY").map((r) => r.symbol));
  deps.log(`rankable ${rankableSymbols.size}`);
  deps.log(`skipped ${skipped.filter((s) => !rankableSymbols.has(s.symbol)).length}`);

  return {
    ...base,
    generatedAt: deps.nowIso(),
    config: {
      signal: signalConfigFingerprint({
        marketType: SCANNER_MARKET_TYPE,
        chartInterval: lineage.chartInterval,
        historyStartMs: lineage.historyStartMs,
        switchoverMs: lineage.switchoverMs,
        engine: lineage.engine,
        partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
      }),
      ranking: request.ranking,
      deliverySourceTfsAreNativeDeliveryV1: sameTfs(request.ranking.deliverySourceTfs, ["1D", "1W"]),
    },
    committedState: {
      boundary: "every bar before the forming bar is closed and committed; the forming bar is never committed",
      lastCommittedBarOpenTime: new Date(boundaryMs - intervalMs).toISOString(),
      evaluatedForFormingBarOpenTime: new Date(boundaryMs).toISOString(),
      binanceServerTimeAtBoundary: new Date(serverTimeMs).toISOString(),
    },
    price: {
      source: "binance-usdm-public/fapi/v1/ticker/price",
      meaning: "latest public trade price; advisory proximity input only — NOT a committed scanner close",
      latestObservedAt: latestPriceMs === null ? null : new Date(latestPriceMs).toISOString(),
      // > 0: the price was observed after the evaluated bar closed; readiness may have moved since. Rerun for a fresh view.
      barsAfterEvaluatedBar: latestPriceMs === null ? null : Math.max(0, Math.floor((latestPriceMs - boundaryMs) / intervalMs)),
      error: priceError,
    },
    counts: {
      selected: selection.symbols.length,
      evaluated: evaluations.length,
      rankableSymbols: rankableSymbols.size,
      rankedRows: candidates.length,
      skipped: skipped.length,
      skippedByReason,
      symbolsServedFromCacheOnly: outcomes.filter((o) => o.fromCacheOnly).length,
    },
    candidates,
    skipped,
    requests: { made: governor.requestsMade, budget: governor.budget, minSpacingMs: deps.minSpacingMs },
  };
}

function sameTfs(a: readonly NativeSourceTf[], b: readonly NativeSourceTf[]): boolean {
  return a.length === b.length && a.every((tf) => b.includes(tf));
}

export type CandidateRankReport = Awaited<ReturnType<typeof runCandidateRank>>;
