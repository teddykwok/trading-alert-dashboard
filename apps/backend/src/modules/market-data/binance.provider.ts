import type { MarketDataProvider, OhlcvCandle } from "./market-data.types";

const CANDLE_COUNT = 80;
const VOLATILITY = 0.006; // crypto moves faster than equities

function timeframeToSeconds(timeframe: string): number {
  const match = /^(\d+)([mhd])$/i.exec(timeframe);
  if (!match) return 3600;
  const [, amount, unit] = match;
  const n = Number(amount);
  if (unit.toLowerCase() === "m") return n * 60;
  if (unit.toLowerCase() === "h") return n * 3600;
  return n * 86400;
}

/**
 * Mock Binance OHLCV provider. Generates a plausible-looking random walk
 * that ends at `referencePrice` so the rendered chart lines up with the
 * alert's trigger price.
 *
 * TODO: replace with a real call to Binance's public klines REST endpoint,
 * e.g. GET https://api.binance.com/api/v3/klines?symbol=...&interval=...
 */
export class BinanceProvider implements MarketDataProvider {
  async getRecentCandles(
    _symbol: string,
    timeframe: string,
    referencePrice: number
  ): Promise<OhlcvCandle[]> {
    const stepSeconds = timeframeToSeconds(timeframe);
    const now = Math.floor(Date.now() / 1000);
    const candles: OhlcvCandle[] = [];

    let price = referencePrice * (1 - VOLATILITY * (CANDLE_COUNT / 4));

    for (let i = CANDLE_COUNT - 1; i >= 0; i -= 1) {
      const time = now - i * stepSeconds;
      // Ease the walk toward referencePrice as it approaches "now" so the
      // final candle lands near the alert price instead of jumping there.
      const pull = Math.pow(1 - i / CANDLE_COUNT, 3) * 0.5;
      const drift = (Math.random() - 0.48) * VOLATILITY * price;
      const open = price;
      const pulled = open + (referencePrice - open) * pull;
      const close = i === 0 ? referencePrice : Math.max(0.01, pulled + drift);
      const high = Math.max(open, close) * (1 + Math.random() * VOLATILITY * 0.5);
      const low = Math.min(open, close) * (1 - Math.random() * VOLATILITY * 0.5);
      const volume = Math.random() * 1000;

      candles.push({ time, open, high, low, close, volume });
      price = close;
    }

    return candles;
  }
}
