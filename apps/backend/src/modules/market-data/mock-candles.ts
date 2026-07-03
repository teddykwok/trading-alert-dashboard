import type { OhlcvCandle } from "./market-data.types";

const CANDLE_COUNT = 80;
const DEFAULT_VOLATILITY = 0.006;

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
 * Random-walk mock candle generator. Used as an explicit, opt-in fallback
 * for CRYPTO alerts when the real Binance provider fails and
 * MARKET_DATA_FALLBACK_TO_MOCK=true (see market-data.service.ts) — not used
 * by default. stocks.provider.ts has its own independent copy of this same
 * approach for its always-mock behavior.
 */
export function generateMockCandles(
  referencePrice: number,
  timeframe: string,
  volatility = DEFAULT_VOLATILITY
): OhlcvCandle[] {
  const stepSeconds = timeframeToSeconds(timeframe);
  const now = Math.floor(Date.now() / 1000);
  const candles: OhlcvCandle[] = [];

  let price = referencePrice * (1 - volatility * (CANDLE_COUNT / 4));

  for (let i = CANDLE_COUNT - 1; i >= 0; i -= 1) {
    const time = now - i * stepSeconds;
    const pull = Math.pow(1 - i / CANDLE_COUNT, 3) * 0.5;
    const drift = (Math.random() - 0.48) * volatility * price;
    const open = price;
    const pulled = open + (referencePrice - open) * pull;
    const close = i === 0 ? referencePrice : Math.max(0.01, pulled + drift);
    const high = Math.max(open, close) * (1 + Math.random() * volatility * 0.5);
    const low = Math.min(open, close) * (1 - Math.random() * volatility * 0.5);
    const volume = Math.random() * 1000;

    candles.push({ time, open, high, low, close, volume });
    price = close;
  }

  return candles;
}
