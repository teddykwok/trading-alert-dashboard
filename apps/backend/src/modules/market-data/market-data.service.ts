import type { AssetType } from "@prisma/client";
import { BinanceProvider } from "./binance.provider";
import { StocksProvider } from "./stocks.provider";
import type { OhlcvCandle } from "./market-data.types";

const binanceProvider = new BinanceProvider();
const stocksProvider = new StocksProvider();

/**
 * Picks the right market data provider for an asset type. Both providers are
 * currently mocks (see their respective files for where to plug in real
 * market data APIs); callers don't need to know which provider is in use.
 */
export async function getRecentCandles(
  assetType: AssetType,
  symbol: string,
  timeframe: string,
  referencePrice: number
): Promise<OhlcvCandle[]> {
  const provider = assetType === "CRYPTO" ? binanceProvider : stocksProvider;
  return provider.getRecentCandles(symbol, timeframe, referencePrice);
}
