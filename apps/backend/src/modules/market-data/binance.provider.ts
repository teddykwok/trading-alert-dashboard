import { env } from "../../config/env";
import { logger } from "../../config/logger";
import type { MarketType } from "../../utils/symbol";
import { MarketDataError, type MarketDataProvider, type OhlcvCandle } from "./market-data.types";

const DEFAULT_LIMIT = 120;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;

// TradingView webhook timeframes map 1:1 onto Binance's interval tokens for
// the timeframes this dashboard supports (valid on both spot and USD-M
// futures klines); kept as an explicit allow-list (rather than a passthrough)
// so unsupported values fail with a clear error instead of silently reaching
// Binance with a bad `interval`.
const TIMEFRAME_TO_BINANCE_INTERVAL: Record<string, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};

function toBinanceInterval(timeframe: string): string {
  const interval = TIMEFRAME_TO_BINANCE_INTERVAL[timeframe.toLowerCase()];
  if (!interval) {
    throw new MarketDataError(`Unsupported Binance interval: ${timeframe}`);
  }
  return interval;
}

/**
 * One row of Binance's kline response:
 * [openTime, open, high, low, close, volume, closeTime, quoteAssetVolume,
 *  numberOfTrades, takerBuyBaseVolume, takerBuyQuoteVolume, ignore]
 * https://binance-docs.github.io/apidocs/spot/en/#kline-candlestick-data
 */
function parseKlines(raw: unknown, symbol: string): OhlcvCandle[] {
  if (!Array.isArray(raw)) {
    throw new MarketDataError(`Unexpected Binance klines response shape for ${symbol}`);
  }

  return raw.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length < 6) {
      throw new MarketDataError(`Malformed kline entry at index ${index} for ${symbol}`);
    }

    const [openTimeMs, open, high, low, close, volume] = entry;

    const candle: OhlcvCandle = {
      time: Math.floor(Number(openTimeMs) / 1000),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    };

    if (Object.values(candle).some((value) => Number.isNaN(value))) {
      throw new MarketDataError(`Non-numeric OHLCV value in kline at index ${index} for ${symbol}`);
    }

    return candle;
  });
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function klinesUrl(marketType: MarketType, symbol: string, interval: string, limit: number): string {
  const query = `symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  return marketType === "futures"
    ? `${env.BINANCE_FUTURES_REST_BASE_URL}/fapi/v1/klines?${query}`
    : `${env.BINANCE_REST_BASE_URL}/api/v3/klines?${query}`;
}

/**
 * Real Binance public market data provider, no API key required:
 * - spot:    GET {BINANCE_REST_BASE_URL}/api/v3/klines
 * - futures: GET {BINANCE_FUTURES_REST_BASE_URL}/fapi/v1/klines (USD-M
 *            perpetuals, i.e. TradingView ".P" symbols)
 * Both endpoints share the same kline response shape and interval tokens.
 */
export class BinanceProvider implements MarketDataProvider {
  async getRecentCandles(
    symbol: string,
    timeframe: string,
    _referencePrice: number,
    marketType: MarketType = "spot",
    limit: number = DEFAULT_LIMIT
  ): Promise<OhlcvCandle[]> {
    const interval = toBinanceInterval(timeframe);
    const url = klinesUrl(marketType, symbol, interval, limit);

    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        logger.info(
          { provider: "binance", marketType, symbol, interval, limit, attempt },
          "Fetching Binance klines"
        );

        const response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new MarketDataError(
            `Binance ${marketType} klines request failed with status ${response.status}${body ? `: ${body}` : ""}`
          );
        }

        const json = await response.json();
        const candles = parseKlines(json, symbol);

        logger.info(
          { provider: "binance", marketType, symbol, interval, candleCount: candles.length },
          "Fetched Binance klines"
        );

        return candles;
      } catch (error) {
        lastError = error;
        const isLastAttempt = attempt === MAX_ATTEMPTS;
        const message = error instanceof Error ? error.message : String(error);

        logger.warn(
          { provider: "binance", marketType, symbol, interval, attempt, error: message },
          "Binance klines fetch attempt failed"
        );

        if (!isLastAttempt) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new MarketDataError(
      `Binance ${marketType} klines fetch failed for ${symbol} (${interval}) after ${MAX_ATTEMPTS} attempt(s): ${message}`
    );
  }
}
