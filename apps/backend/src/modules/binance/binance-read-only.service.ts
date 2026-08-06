import { BinanceReadOnlyClient } from "./binance.client";
import { BinanceError } from "./binance.errors";
import {
  findSymbolRow,
  isNonZeroPosition,
  maxInitialLeverage,
  normalizeAssetMode,
  normalizeBalances,
  normalizeLeverageBrackets,
  normalizeOpenOrders,
  normalizePositionMode,
  normalizePositions,
  normalizeSymbolConfig,
  normalizeSymbolFilters,
} from "./binance.normalize";
import type {
  BinanceAccountSummaryDto,
  BinanceConnectionInfo,
  BinancePositionDto,
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
