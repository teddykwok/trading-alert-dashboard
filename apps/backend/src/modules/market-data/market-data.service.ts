import type { AssetType } from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import type { MarketType } from "../../utils/symbol";
import { BinanceProvider } from "./binance.provider";
import { StocksProvider } from "./stocks.provider";
import { generateMockCandles } from "./mock-candles";
import { MarketDataError, type OhlcvCandle, type SnapshotCandle } from "./market-data.types";

const binanceProvider = new BinanceProvider();
const stocksProvider = new StocksProvider();

function shouldUseRealBinance(assetType: AssetType, exchange: string | null): boolean {
  return (
    env.MARKET_DATA_PROVIDER === "binance" &&
    assetType === "CRYPTO" &&
    (exchange ?? "").toUpperCase() === "BINANCE"
  );
}

/**
 * Picks the right market data source for an alert:
 * - CRYPTO on the BINANCE exchange -> real Binance klines (binance.provider.ts),
 *   hitting the spot or USD-M futures endpoint depending on `marketType`
 *   (TradingView ".P" perpetual symbols -> "futures").
 * - Everything else (STOCK, or crypto on another/unset exchange) -> mock provider.
 *
 * If the real Binance fetch fails, behavior is controlled by
 * MARKET_DATA_FALLBACK_TO_MOCK: when true, log a warning and return mock
 * candles instead; when false (default), rethrow so the caller (the worker)
 * marks the alert FAILED rather than silently rendering fake data.
 */
export async function getRecentCandles(
  assetType: AssetType,
  symbol: string,
  timeframe: string,
  referencePrice: number,
  exchange: string | null = null,
  marketType: MarketType = "spot"
): Promise<OhlcvCandle[]> {
  if (shouldUseRealBinance(assetType, exchange)) {
    try {
      return await binanceProvider.getRecentCandles(symbol, timeframe, referencePrice, marketType);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (env.MARKET_DATA_FALLBACK_TO_MOCK) {
        logger.warn(
          { provider: "binance", marketType, symbol, timeframe, error: message },
          "Binance market data fetch failed — falling back to mock candles (MARKET_DATA_FALLBACK_TO_MOCK=true)"
        );
        return generateMockCandles(referencePrice, timeframe);
      }

      throw new MarketDataError(`Market data fetch failed: ${message}`);
    }
  }

  return stocksProvider.getRecentCandles(symbol, timeframe, referencePrice);
}

/**
 * Frozen historical dataset for Extreme RR plans: candles that CLOSED at or
 * before `cutoff`. Deliberately NO mock fallback — a plan's SL/TP must never
 * be derived from synthetic candles, so anything that is not real Binance
 * data surfaces as a MarketDataError and the plan is marked ERROR instead.
 */
export async function getClosedCandlesBefore(
  assetType: AssetType,
  symbol: string,
  timeframe: string,
  cutoff: Date,
  exchange: string | null = null,
  marketType: MarketType = "spot",
  limit = 300
): Promise<SnapshotCandle[]> {
  if (!shouldUseRealBinance(assetType, exchange)) {
    throw new MarketDataError(
      `Historical Binance data is not available for ${symbol} (assetType=${assetType}, exchange=${exchange ?? "unset"}) — Extreme RR plans require real Binance candles`
    );
  }
  return binanceProvider.getClosedCandlesBefore(symbol, timeframe, cutoff, marketType, limit);
}
