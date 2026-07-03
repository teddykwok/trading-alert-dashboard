import type { AssetType } from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { BinanceProvider } from "./binance.provider";
import { StocksProvider } from "./stocks.provider";
import { generateMockCandles } from "./mock-candles";
import { MarketDataError, type OhlcvCandle } from "./market-data.types";

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
 * - CRYPTO on the BINANCE exchange -> real Binance klines (binance.provider.ts).
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
  exchange: string | null = null
): Promise<OhlcvCandle[]> {
  if (shouldUseRealBinance(assetType, exchange)) {
    try {
      return await binanceProvider.getRecentCandles(symbol, timeframe, referencePrice);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (env.MARKET_DATA_FALLBACK_TO_MOCK) {
        logger.warn(
          { provider: "binance", symbol, timeframe, error: message },
          "Binance market data fetch failed — falling back to mock candles (MARKET_DATA_FALLBACK_TO_MOCK=true)"
        );
        return generateMockCandles(referencePrice, timeframe);
      }

      throw new MarketDataError(`Market data fetch failed: ${message}`);
    }
  }

  return stocksProvider.getRecentCandles(symbol, timeframe, referencePrice);
}
