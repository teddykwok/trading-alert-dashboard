import { BinanceReadOnlyClient } from "./binance.client";
import { BinanceError } from "./binance.errors";
import type { BinanceDispatchMode } from "./binance.client";
import {
  asRow,
  asRows,
  findSymbolRow,
  isNonZeroPosition,
  maxInitialLeverage,
  normalizeAssetMode,
  normalizeBalances,
  normalizeLeverageBrackets,
  normalizeOpenAlgoOrders,
  normalizeOpenAlgoOrdersAccountWide,
  normalizeOpenOrders,
  normalizePositionMode,
  normalizePositions,
  normalizeAlgoOrder,
  normalizeMarginHistory,
  normalizeMarkPrice,
  normalizeHistoricalOrders,
  normalizeQueriedOrder,
  normalizeUserTrades,
  normalizeSymbolConfig,
  normalizeSymbolFilters,
} from "./binance.normalize";
import type {
  BinanceSymbolFiltersDto,
  BinanceAccountSummaryDto,
  BinanceAlgoOrderDto,
  BinanceConnectionInfo,
  BinanceMarkPriceDto,
  BinancePositionDto,
  BinanceHistoricalOrderDto,
  BinanceQueriedOrderDto,
  BinanceUserTradeDto,
  BinanceSymbolInspectionDto,
} from "./binance.types";

/** The mode this project's execution policy expects (see docs/binance-execution-policy.md). */
export const EXPECTED_POSITION_MODE = "HEDGE" as const;

export const ONE_WAY_MODE_WARNING = `WARNING: Expected ${EXPECTED_POSITION_MODE} mode, actual mode is ONE_WAY.`;

/**
 * Read-only Binance account/symbol inspection.
 *
 * Everything here is GET-only and side-effect free: no order is placed or
 * cancelled, no leverage / margin type / position mode is changed, nothing is
 * written to the database, and the alert pipeline is never touched. The
 * service exposes only reporting methods — there is no trading method to call.
 */
/** Binance's documented maximum page size for GET /fapi/v1/userTrades. */
const USER_TRADES_MAX_LIMIT = 1000;

/**
 * A millisecond timestamp, or nothing.
 *
 * Checked rather than coerced for the same reason the other guards are:
 * `String(NaN)` is "NaN", which Binance would reject as a puzzling malformed
 * request rather than as the caller bug it is.
 */
function assertTimestampMs(value: number | undefined, parameter: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BinanceError({
      kind: "MALFORMED_RESPONSE",
      message: `userTrades ${parameter} must be a non-negative integer of milliseconds`,
      endpoint: "userTrades",
    });
  }
}

/**
 * The bounded userTrades query contract.
 *
 * Exactly three shapes are supported -- a plain page, a time window, and a
 * targeted order -- and the wrapper enforces which combinations are legal
 * rather than merely describing them.
 */
export interface UserTradesQuery {
  limit?: number;
  startTimeMs?: number;
  endTimeMs?: number;
  /**
   * The EXCHANGE order id, as text. Kept as a string end to end: an int64 id
   * does not survive a JavaScript number, and this is an identity rather than
   * a quantity.
   */
  orderId?: string;
}

export class BinanceReadOnlyService {
  constructor(private readonly client: BinanceReadOnlyClient = new BinanceReadOnlyClient()) {}

  get isEnabled(): boolean {
    return this.client.isEnabled;
  }

  /** Ping + clock sync. Never throws for a *reachable* exchange. */
  async checkConnection(): Promise<BinanceConnectionInfo> {
    await this.client.request("ping");
    const sync = await this.client.syncTime();

    return {
      ok: true,
      host: this.client.host,
      serverTimeMs: sync.serverTimeMs,
      serverTimeIso: new Date(sync.serverTimeMs).toISOString(),
      clockOffsetMs: sync.offsetMs,
      roundTripMs: sync.roundTripMs,
    };
  }

  /**
   * Full read-only account snapshot. Optional signals (asset mode, per-symbol
   * config) degrade into warnings rather than failing the whole summary, so a
   * partially-permissioned key still produces a useful report.
   */
  async getAccountSummary(): Promise<BinanceAccountSummaryDto> {
    const warnings: string[] = [];
    const connection = await this.checkConnection();

    const [balancesRaw, positionModeRaw, positionsRaw, openOrdersRaw] = await Promise.all([
      this.client.request<unknown>("balance"),
      this.client.request<unknown>("positionMode"),
      this.client.request<unknown>("positionRisk"),
      this.client.request<unknown>("openOrders"),
    ]);

    const positionMode = normalizePositionMode(positionModeRaw);
    if (positionMode === "ONE_WAY") warnings.push(ONE_WAY_MODE_WARNING);
    if (positionMode === null) {
      warnings.push("Position mode could not be determined from the Binance response.");
    }

    // Optional extras — never fatal.
    const assetMode = await this.tryOptional(
      async () => normalizeAssetMode(await this.client.request<unknown>("multiAssetsMode")),
      "Asset mode unavailable",
      warnings
    );

    const balances = normalizeBalances(balancesRaw);
    const usdt = balances.find((balance) => balance.asset.toUpperCase() === "USDT") ?? null;
    if (!usdt) warnings.push("No USDT balance entry was returned for this account.");

    let positions = normalizePositions(positionsRaw).filter(isNonZeroPosition);
    positions = await this.enrichPositionConfig(positions, warnings);

    const openOrders = normalizeOpenOrders(openOrdersRaw);

    return {
      connection,
      positionMode,
      assetMode,
      usdtWalletBalance: usdt?.walletBalance ?? null,
      usdtAvailableBalance: usdt?.availableBalance ?? null,
      nonZeroPositionCount: positions.length,
      openOrderCount: openOrders.length,
      openOrderSymbols: [...new Set(openOrders.map((order) => order.symbol.trim().toUpperCase()))].sort(),
      positions,
      warnings,
    };
  }

  /**
   * Symbol filters + account-specific leverage brackets. Phase 2 deliberately
   * does NOT pick or recommend a leverage — that is Phase 3's job.
   */
  /**
   * Every listed USDⓈ-M symbol's filters, from ONE unsigned `exchangeInfo` GET.
   *
   * `inspectSymbol` is the right shape for one symbol and the wrong shape for
   * six hundred: it makes three calls each. Validating a pasted watchlist needs
   * the same metadata for many symbols at once, so this reads the full listing
   * a single time and lets the caller judge each symbol against the result.
   * Read-only, unsigned, and it fetches no per-symbol leverage or account
   * configuration because allowlist eligibility does not depend on either.
   */
  async listSymbolFilters(): Promise<Map<string, BinanceSymbolFiltersDto>> {
    const exchangeInfo = await this.client.request<unknown>("exchangeInfo");
    const index = new Map<string, BinanceSymbolFiltersDto>();
    for (const row of asRows(asRow(exchangeInfo).symbols)) {
      const filters = normalizeSymbolFilters(row);
      if (filters.symbol) index.set(filters.symbol.toUpperCase(), filters);
    }
    return index;
  }

  async inspectSymbol(symbol: string): Promise<BinanceSymbolInspectionDto> {
    const wanted = symbol.trim().toUpperCase();

    const exchangeInfo = await this.client.request<unknown>("exchangeInfo", { symbol: wanted });
    const symbolRow = findSymbolRow(exchangeInfo, wanted);
    if (!symbolRow) {
      throw new BinanceError({
        kind: "UNSUPPORTED_SYMBOL",
        message: `Symbol ${wanted} is not listed on Binance USDⓈ-M futures`,
        endpoint: "exchangeInfo",
      });
    }

    const filters = normalizeSymbolFilters(symbolRow);
    const bracketsRaw = await this.client.request<unknown>("leverageBracket", { symbol: wanted });
    const brackets = normalizeLeverageBrackets(bracketsRaw, wanted);

    const accountSymbolConfig = await this.tryOptional(
      async () => normalizeSymbolConfig(await this.client.request<unknown>("symbolConfig"), wanted),
      `Account symbol configuration unavailable for ${wanted}`,
      []
    );

    return {
      filters,
      brackets,
      maxInitialLeverage: maxInitialLeverage(brackets),
      accountSymbolConfig,
    };
  }

  // -------------------------------------------------------------------------
  // Phase 6 query accessors — still GET-only, still side-effect free.
  // -------------------------------------------------------------------------

  /**
   * GET /fapi/v1/order by origClientOrderId. This is how an ambiguous
   * submission or cancellation is resolved: the same deterministic id is asked
   * about rather than a new order being created.
   */
  async queryOrderByClientOrderId(symbol: string, origClientOrderId: string): Promise<BinanceQueriedOrderDto> {
    const payload = await this.client.request<unknown>("order", {
      symbol: symbol.trim().toUpperCase(),
      origClientOrderId,
    });
    return normalizeQueriedOrder(payload);
  }

  /**
   * GET /fapi/v1/premiumIndex — public, unsigned, weight 1 with a symbol.
   *
   * The only way to read a mark price BEFORE a position exists. Fails closed:
   * an unreadable, zero or mismatched mark price throws rather than returning
   * a value a trigger price could be derived from.
   */
  async getMarkPrice(symbol: string): Promise<BinanceMarkPriceDto> {
    const wanted = symbol.trim().toUpperCase();
    const payload = await this.client.request<unknown>("premiumIndex", { symbol: wanted });
    const markPrice = normalizeMarkPrice(payload, wanted);
    if (!markPrice) {
      throw new BinanceError({
        kind: "MALFORMED_RESPONSE",
        message: `Binance returned no usable mark price for ${wanted}`,
        endpoint: "premiumIndex",
      });
    }
    return markPrice;
  }

  /** GET /fapi/v1/symbolConfig for one symbol (margin type, leverage, caps). */
  async getSymbolConfiguration(symbol: string) {
    const payload = await this.client.request<unknown>("symbolConfig", { symbol: symbol.trim().toUpperCase() });
    return normalizeSymbolConfig(payload, symbol);
  }

  /** GET /fapi/v1/openOrders, optionally narrowed to one symbol. */
  async getOpenOrders(symbol?: string) {
    const params = symbol ? { symbol: symbol.trim().toUpperCase() } : {};
    return normalizeOpenOrders(await this.client.request<unknown>("openOrders", params));
  }

  /**
   * GET /fapi/v1/algoOrder by clientAlgoId. Resolving an ambiguous protection
   * submission or cancellation always asks about the SAME deterministic id
   * rather than creating another order.
   */
  async queryAlgoOrderByClientAlgoId(symbol: string, clientAlgoId: string) {
    const payload = await this.client.request<unknown>("algoOrder", {
      symbol: symbol.trim().toUpperCase(),
      clientAlgoId,
    });
    return normalizeAlgoOrder(payload);
  }

  /**
   * GET /fapi/v1/openAlgoOrders for ONE symbol — current open conditional
   * orders.
   *
   * Read-only. It is how a baseline proves the conditional book is empty
   * without ever reaching for a cancel-all endpoint.
   *
   * The symbol is REQUIRED, for two reasons. Binance charges weight 1 for the
   * per-symbol form and weight 40 for the all-symbols form, and the endpoint
   * table here declares 1 — so an accidental all-symbols call would silently
   * consume 40× its declared budget. And `buildCanonicalQuery` DROPS empty
   * values, so an empty string would not fail loudly, it would quietly become
   * that all-symbols request. An explicit guard closes both.
   *
   * Throws MALFORMED_RESPONSE when the reply cannot be fully read, so a caller
   * can always tell "no open orders" from "we could not see the book".
   */
  async getOpenAlgoOrders(symbol: string): Promise<BinanceAlgoOrderDto[]> {
    const wanted = symbol.trim().toUpperCase();
    if (wanted === "") {
      throw new BinanceError({
        kind: "MALFORMED_RESPONSE",
        message: "getOpenAlgoOrders requires an explicit symbol; the all-symbols form is not exposed here",
        endpoint: "openAlgoOrders",
      });
    }

    const payload = await this.client.request<unknown>("openAlgoOrders", { symbol: wanted });
    const orders = normalizeOpenAlgoOrders(payload, wanted);
    if (orders === null) {
      throw new BinanceError({
        kind: "MALFORMED_RESPONSE",
        message: `Binance returned an unreadable open Algo order list for ${wanted}`,
        endpoint: "openAlgoOrders",
      });
    }
    return orders;
  }

  /**
   * GET /fapi/v1/openAlgoOrders with NO symbol — the whole conditional book.
   *
   * Takes no argument, deliberately: this is the account-wide form and there
   * is no symbol it could be narrowed by. It goes out under its own endpoint
   * descriptor, `openAlgoOrdersAccountWide`, whose declared weight is 40 --
   * the price Binance actually charges for the all-symbols variant.
   *
   * This is the only read that can prove the conditional book EMPTY. A
   * per-symbol sweep proves it empty for the symbols it asked about, which is
   * a different and weaker claim: an orphan on a symbol nobody thought to ask
   * about reads as absence.
   *
   * Throws MALFORMED_RESPONSE when the reply cannot be fully read, so a caller
   * can always tell "no open orders" from "we could not see the book".
   */
  async getOpenAlgoOrdersAccountWide(): Promise<BinanceAlgoOrderDto[]> {
    const payload = await this.client.request<unknown>("openAlgoOrdersAccountWide", {});
    const orders = normalizeOpenAlgoOrdersAccountWide(payload);
    if (orders === null) {
      throw new BinanceError({
        kind: "MALFORMED_RESPONSE",
        message: "Binance returned an unreadable account-wide open Algo order list",
        endpoint: "openAlgoOrdersAccountWide",
      });
    }
    return orders;
  }

  /** GET /fapi/v1/positionMargin/history — reconciliation of an ADD only. */
  async getPositionMarginHistory(symbol: string, positionSide?: string) {
    const payload = await this.client.request<unknown>("positionMarginHistory", {
      symbol: symbol.trim().toUpperCase(),
      // 1 = ADD. History is never read for removals.
      type: 1,
      ...(positionSide ? { positionSide: positionSide.toUpperCase() } : {}),
    });
    return normalizeMarginHistory(payload);
  }

  /**
   * GET /fapi/v3/positionRisk narrowed to ONE symbol and positionSide. Returns
   * only that row so no unrelated position or account-wide data is carried
   * into the protection lifecycle.
   */
  async getPositionForSide(symbol: string, positionSide: string): Promise<BinancePositionDto | null> {
    const wanted = positionSide.trim().toUpperCase();
    const rows = normalizePositions(
      await this.client.request<unknown>("positionRisk", { symbol: symbol.trim().toUpperCase() })
    );
    const matching = rows.filter((row) => (row.positionSide ?? "").toUpperCase() === wanted);
    // More than one row for the same side is contradictory, never merged.
    if (matching.length !== 1) return null;
    return matching[0];
  }

  /**
   * GET /fapi/v1/allOrders — the symbol's recent order history.
   *
   * Exists for ONE purpose: proving an entry that was never confirmed also
   * never existed. A Query Order answering NO_SUCH_ORDER is a statement
   * about what Binance still retains; history is what distinguishes that
   * from an order that existed and aged out of the lookup window.
   *
   * Returns only the identity fields absence needs — never a raw payload.
   */
  async listRecentOrders(
    symbol: string,
    options: { limit?: number; startTimeMs?: number } = {}
  ): Promise<BinanceHistoricalOrderDto[]> {
    const payload = await this.client.request<unknown>("allOrders", {
      symbol: symbol.trim().toUpperCase(),
      // Binance caps this at 1000; the default of 500 covers any realistic
      // recovery window without paging.
      limit: String(options.limit ?? 500),
      ...(options.startTimeMs === undefined ? {} : { startTime: String(options.startTimeMs) }),
    });
    return normalizeHistoricalOrders(payload);
  }

  /**
   * GET /fapi/v1/userTrades — the symbol's fill history.
   *
   * An order can be gone from the book and still have traded. Absence is not
   * provable without asking whether anything filled, so this is the second
   * half of the same question, never a convenience.
   *
   * Exactly three shapes are supported, and the method REFUSES anything else:
   *
   *   RECENT    symbol [+ limit]                       — the pre-existing form
   *   BOUNDED   symbol + startTimeMs [+ endTimeMs] [+ limit]
   *   TARGETED  symbol + orderId [+ limit]
   *
   * A targeted read asks what one order did; a bounded read asks what happened
   * in one window. They are different questions, and the wrapper will not mix
   * them. All three still issue exactly ONE request: paging a window is a
   * decision about which windows to ask for, and it belongs to whatever owns
   * that decision, not to a method whose job is to ask once and report the
   * answer.
   *
   * `fromId` is deliberately absent. Binance documents that it cannot be
   * combined with a time range, and documents neither its inclusivity nor any
   * ordering guarantee — so it cannot carry a losslessness argument, and
   * exposing it would invite one to be built on it.
   *
   * The arguments are checked rather than coerced. Every guard here exists
   * because the alternative is a request that SUCCEEDS while meaning something
   * else: a `NaN` bound serializes to the literal "NaN", a blank `orderId` is
   * dropped by the canonical query builder and quietly becomes an unbounded
   * sweep, and a `limit` the exchange will not honour breaks the only signal a
   * caller has for whether it saw a whole page.
   */
  /**
   * One bounded page of this account's fills, with the client's ordinary
   * transport retry. Unchanged, and what every existing caller gets.
   */
  async listRecentTrades(symbol: string, options: UserTradesQuery = {}): Promise<BinanceUserTradeDto[]> {
    return this.userTradesPage(symbol, options, "BOUNDED_RETRY");
  }

  /**
   * The same page, dispatched to the network EXACTLY ONCE.
   *
   * For a caller that owns a DURABLE retry budget -- one where an attempt is
   * counted in the database, backed off in the database and eventually
   * abandoned in the database. Transport retry inside such an attempt makes
   * that budget a lie: "five attempts" would silently mean up to fifteen
   * requests, and the weight a cycle spends would stop being knowable from the
   * number of windows it worked.
   *
   * Every failure is classified and thrown, including the timestamp rejection
   * that would otherwise buy a re-sync and a second dispatch. Success
   * normalization, the query contract and the non-array refusal are identical
   * to `listRecentTrades` -- this controls transport redispatch and nothing
   * else.
   */
  async listRecentTradesOnce(symbol: string, options: UserTradesQuery = {}): Promise<BinanceUserTradeDto[]> {
    return this.userTradesPage(symbol, options, "SINGLE_DISPATCH");
  }

  private async userTradesPage(
    symbol: string,
    options: UserTradesQuery,
    dispatchMode: BinanceDispatchMode
  ): Promise<BinanceUserTradeDto[]> {
    const wanted = symbol.trim().toUpperCase();
    const limit = options.limit ?? 500;

    // Binance caps this at 1000. Refused rather than clamped: a caller that
    // asked for more than the exchange will return needs to know its page was
    // never whole, and silently answering a smaller question is how a gap
    // becomes invisible.
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > USER_TRADES_MAX_LIMIT) {
      throw new BinanceError({
        kind: "MALFORMED_RESPONSE",
        message: `userTrades limit must be an integer between 1 and ${USER_TRADES_MAX_LIMIT}`,
        endpoint: "userTrades",
      });
    }
    assertTimestampMs(options.startTimeMs, "startTime");
    assertTimestampMs(options.endTimeMs, "endTime");
    if (options.orderId !== undefined && !/^\d+$/.test(options.orderId)) {
      // Also catches a clientOrderId passed by mistake, which is a live
      // hazard: `tad-ec-1-…` is the id an emergency close is RECOVERED by, and
      // sending it here would query the wrong thing entirely.
      throw new BinanceError({
        kind: "MALFORMED_RESPONSE",
        message: "userTrades orderId must be the exchange order id, as digits",
        endpoint: "userTrades",
      });
    }

    /**
     * EXACTLY ONE QUESTION PER CALL.
     *
     * The options type can spell combinations this wrapper does not support,
     * and TypeScript cannot express "these fields are mutually exclusive"
     * without a union that every existing caller would have to be rewritten
     * for. So the contract is enforced here instead of merely described.
     *
     * A targeted read asks what ONE order did; a bounded read asks what
     * happened in ONE window. Mixing them is not a richer question — Binance
     * documents no interaction between `orderId` and a time range, so the
     * result would rest on behaviour nobody has specified, and the ingestion
     * built on top would inherit that. An end bound with no start is the same
     * problem in miniature: it names a window with no beginning, and the
     * repair architecture only ever asks for explicit ones.
     *
     * Refused locally rather than sent and interpreted: an unsupported request
     * that happens to return plausible rows is the worst outcome, because it
     * looks like an answer.
     */
    if (options.orderId !== undefined && (options.startTimeMs !== undefined || options.endTimeMs !== undefined)) {
      throw new BinanceError({
        kind: "MALFORMED_RESPONSE",
        message: "userTrades takes either an orderId or a time window, never both",
        endpoint: "userTrades",
      });
    }
    if (options.endTimeMs !== undefined && options.startTimeMs === undefined) {
      throw new BinanceError({
        kind: "MALFORMED_RESPONSE",
        message: "userTrades endTime requires an explicit startTime",
        endpoint: "userTrades",
      });
    }

    // `undefined` is dropped by `buildCanonicalQuery`, so an absent option
    // emits no parameter at all rather than an empty or literal one.
    const payload = await this.client.request<unknown>(
      "userTrades",
      {
        symbol: wanted,
        limit: String(limit),
        startTime: options.startTimeMs === undefined ? undefined : String(options.startTimeMs),
        endTime: options.endTimeMs === undefined ? undefined : String(options.endTimeMs),
        orderId: options.orderId,
      },
      dispatchMode
    );

    /**
     * A PAGE IS A LIST. Anything else is not an empty page.
     *
     * `parseJson` only proves the body was valid JSON, and a non-2xx status is
     * already an error, so what arrives here is any successfully parsed value:
     * an object, a string, a number, a boolean, null. The normalizer answers
     * `[]` for all of them, and `[]` is a legitimate reading -- a window in
     * which nothing traded. Letting the two collapse is the worst outcome this
     * endpoint has: a page that was never a page would be counted as zero rows,
     * fall short of the requested limit, and durably mark an interval of fill
     * history as exhaustively seen. Refused instead, so it retries as an
     * ordinary transport failure rather than looking like an answer.
     */
    if (!Array.isArray(payload)) {
      throw new BinanceError({
        kind: "MALFORMED_RESPONSE",
        message: "userTrades returned a body that is not a list",
        endpoint: "userTrades",
      });
    }

    return normalizeUserTrades(payload);
  }

  /** GET /fapi/v3/positionRisk, non-zero positions only. */
  async getPositionRisk(symbol?: string): Promise<BinancePositionDto[]> {
    const params = symbol ? { symbol: symbol.trim().toUpperCase() } : {};
    return normalizePositions(await this.client.request<unknown>("positionRisk", params)).filter(isNonZeroPosition);
  }

  /**
   * v3 positionRisk no longer carries per-symbol configuration, so leverage
   * and margin type are filled in from the documented symbolConfig endpoint
   * when the position rows did not already supply them.
   */
  private async enrichPositionConfig(
    positions: BinancePositionDto[],
    warnings: string[]
  ): Promise<BinancePositionDto[]> {
    const needsConfig = positions.some((position) => position.marginType === null || position.leverage === null);
    if (!needsConfig || positions.length === 0) return positions;

    const configRaw = await this.tryOptional(
      async () => this.client.request<unknown>("symbolConfig"),
      "Per-symbol configuration (margin type / leverage) unavailable",
      warnings
    );
    if (configRaw === null) return positions;

    return positions.map((position) => {
      const config = normalizeSymbolConfig(configRaw, position.symbol);
      if (!config) return position;
      return {
        ...position,
        marginType: position.marginType ?? config.marginType,
        leverage: position.leverage ?? config.leverage,
      };
    });
  }

  /** Runs an optional read; on failure records a sanitized warning and returns null. */
  private async tryOptional<T>(
    run: () => Promise<T>,
    warningPrefix: string,
    warnings: string[]
  ): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      const detail = error instanceof BinanceError ? error.kind : "unknown error";
      warnings.push(`${warningPrefix} (${detail}).`);
      return null;
    }
  }
}
