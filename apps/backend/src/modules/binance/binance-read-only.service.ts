import { BinanceReadOnlyClient } from "./binance.client";
import { BinanceError } from "./binance.errors";
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
   */
  async listRecentTrades(
    symbol: string,
    options: { limit?: number; startTimeMs?: number } = {}
  ): Promise<BinanceUserTradeDto[]> {
    const payload = await this.client.request<unknown>("userTrades", {
      symbol: symbol.trim().toUpperCase(),
      limit: String(options.limit ?? 500),
      ...(options.startTimeMs === undefined ? {} : { startTime: String(options.startTimeMs) }),
    });
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
