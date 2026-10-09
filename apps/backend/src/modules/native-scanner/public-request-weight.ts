import { EXCHANGE_INFO_PATH, KLINES_PATH, SERVER_TIME_PATH, TICKER_PRICE_PATH } from "./binance-public-futures";

/**
 * Binance USD-M Futures REQUEST WEIGHT of one public GET, from its URL alone.
 *
 * The IP limit is a weight budget (REQUEST_WEIGHT 2400 / minute) shared by
 * every process on this machine — the scanner AND Account A/B. Counting
 * requests alone is the wrong unit: a 1000-row klines page costs five times a
 * 99-row one. Unknown endpoints are charged the highest klines weight, so an
 * omission can only make the scanner slower, never louder.
 *
 * Source: Binance USD-M Futures REST docs (GET /fapi/v1/klines weight by LIMIT:
 * [1,100) 1, [100,500) 2, [500,1000] 5, > 1000 10; /fapi/v1/time 1;
 * /fapi/v1/exchangeInfo 1; /fapi/v1/ticker/price 1 with a symbol, 2 without).
 */
export const BINANCE_FUTURES_IP_WEIGHT_PER_MINUTE = 2_400;
export const UNKNOWN_ENDPOINT_WEIGHT = 10;

export function klinesWeightForLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) return UNKNOWN_ENDPOINT_WEIGHT;
  if (limit < 100) return 1;
  if (limit < 500) return 2;
  if (limit <= 1000) return 5;
  return 10;
}

export function publicRequestWeight(url: string): number {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return UNKNOWN_ENDPOINT_WEIGHT;
  }
  switch (parsed.pathname) {
    case SERVER_TIME_PATH:
    case EXCHANGE_INFO_PATH:
      return 1;
    case TICKER_PRICE_PATH:
      return parsed.searchParams.has("symbol") ? 1 : 2;
    case KLINES_PATH: {
      // Binance's default limit is 500 when none is sent.
      const raw = parsed.searchParams.get("limit");
      return klinesWeightForLimit(raw === null ? 500 : Number(raw));
    }
    default:
      return UNKNOWN_ENDPOINT_WEIGHT;
  }
}

/** Binance's public response header reporting the IP's request weight used in the current minute. Read, never sent. */
export const USED_WEIGHT_HEADER = "X-MBX-USED-WEIGHT-1M";

/**
 * OBSERVATION ONLY: the header as a plain non-negative integer, or null when it
 * is absent or malformed ("", "abc", "1e4", "-3", "12.5"). Never guessed, never
 * zero for "unknown". Decisions do not use this parse.
 */
export function parseUsedWeightHeader(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  return Number(trimmed);
}
