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
