import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { MarketDataError, type MarketDataProvider, type OhlcvCandle } from "./market-data.types";

const DEFAULT_LIMIT = 120;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;

// TradingView webhook timeframes map 1:1 onto Binance's interval tokens for
// the timeframes this dashboard supports; kept as an explicit allow-list
// (rather than a passthrough) so unsupported values fail with a clear error
// instead of silently reaching Binance with a bad `interval`.
const TIMEFRAME_TO_BINANCE_INTERVAL: Record<string, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
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

/**
 * Real Binance Spot public market data provider — GET /api/v3/klines.
 * Public market data endpoint, no API key required.
 */
export class BinanceProvider implements MarketDataProvider {
  async getRecentCandles(
    symbol: string,
    timeframe: string,
    _referencePrice: number,
    limit: number = DEFAULT_LIMIT
  ): Promise<OhlcvCandle[]> {
    const interval = toBinanceInterval(timeframe);
    const url = `${env.BINANCE_REST_BASE_URL}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;

    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        logger.info({ provider: "binance", symbol, interval, limit, attempt }, "Fetching Binance klines");

        const response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new MarketDataError(
            `Binance klines request failed with status ${response.status}${body ? `: ${body}` : ""}`
          );
        }

        const json = await response.json();
        const candles = parseKlines(json, symbol);

        logger.info(
          { provider: "binance", symbol, interval, candleCount: candles.length },
          "Fetched Binance klines"
        );

        return candles;
      } catch (error) {
        lastError = error;
        const isLastAttempt = attempt === MAX_ATTEMPTS;
        const message = error instanceof Error ? error.message : String(error);

        logger.warn(
          { provider: "binance", symbol, interval, attempt, error: message },
          "Binance klines fetch attempt failed"
        );

        if (!isLastAttempt) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new MarketDataError(
      `Binance klines fetch failed for ${symbol} (${interval}) after ${MAX_ATTEMPTS} attempt(s): ${message}`
    );
  }
}
