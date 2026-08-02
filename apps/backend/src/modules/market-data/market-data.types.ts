export interface OhlcvCandle {
  time: number; // unix seconds, required by Lightweight Charts
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * A COMPLETED candle for Extreme RR snapshots. Unlike OhlcvCandle (chart
 * rendering, plain numbers), high/low stay exact decimal STRINGS straight
 * from Binance so extremes never round-trip through floats, and closeTime is
 * kept so "closed before the alert's triggeredAt" can be enforced.
 */
export interface SnapshotCandle {
  openTimeMs: number;
  closeTimeMs: number;
  high: string;
  low: string;
}

export interface MarketDataProvider {
  getRecentCandles(symbol: string, timeframe: string, referencePrice: number): Promise<OhlcvCandle[]>;
}

/**
 * Thrown by market data providers (e.g. binance.provider.ts) on anything
 * that prevents returning real candles: unsupported interval, non-2xx
 * response, malformed payload, timeout, or exhausted retries. Caught by
 * market-data.service.ts, which either falls back to mock candles
 * (MARKET_DATA_FALLBACK_TO_MOCK=true) or lets it propagate to the worker,
 * which marks the alert FAILED.
 */
export class MarketDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketDataError";
  }
}
