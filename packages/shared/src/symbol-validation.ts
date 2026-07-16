/**
 * Guard against obviously invalid symbol input — most importantly a whole
 * watchlist pasted into one field ("BTCUSDT, ETHUSDT, SOLUSDT…"), which has
 * produced a comma-separated "asset" in production.
 *
 * This is deliberately a blocklist, not an allowlist: exchange tickers vary
 * too much to enumerate safely (BRK.B, ES1!, BTC-USD, 1000XECUSDT,
 * BINANCE:GRASSUSDT.P), but no real ticker contains whitespace or a list
 * separator. Used by the Add-asset UI, the assets API, and webhook symbol
 * normalization.
 */

export const SYMBOL_INPUT_MAX_LENGTH = 64;

const LIST_SEPARATOR_OR_WHITESPACE = /[\s,;]/;

/**
 * Returns a human-readable error for an invalid symbol input, or null when
 * the value looks like a single ticker. Leading/trailing whitespace is
 * tolerated (callers trim before storing); internal whitespace is not.
 */
export function getSymbolInputError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Symbol is required";
  }
  if (trimmed.length > SYMBOL_INPUT_MAX_LENGTH) {
    return `Symbol must be at most ${SYMBOL_INPUT_MAX_LENGTH} characters`;
  }
  if (LIST_SEPARATOR_OR_WHITESPACE.test(trimmed)) {
    return "Symbol must be a single ticker without spaces or commas (e.g. BTCUSDT or BINANCE:BTCUSDT)";
  }
  return null;
}
