export interface OhlcvCandle {
  time: number; // unix seconds, required by Lightweight Charts
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
