import { ValidationError } from "./errors";

export interface NormalizedTradingSymbol {
  /** The input exactly as received (trimmed only for emptiness checking). */
  rawSymbol: string;
  /** Uppercased symbol with any EXCHANGE: prefix stripped, e.g. "BTCUSDT". */
  normalizedSymbol: string;
  /** Uppercased exchange parsed from an "EXCHANGE:SYMBOL" prefix, if present. */
  exchangeFromSymbol?: string;
}

/**
 * Normalizes a TradingView-style symbol. TradingView's {{ticker}} placeholder
 * usually sends a bare symbol ("BTCUSDT"), but {{exchange}}:{{ticker}} setups
 * and some alert templates send prefixed forms like "BINANCE:BTCUSDT" or
 * "NASDAQ:AAPL". Downstream consumers (the Binance klines provider, duplicate
 * suppression, Asset upsert) all need the bare uppercase symbol.
 */
export function normalizeTradingSymbol(input: string): NormalizedTradingSymbol {
  const rawSymbol = input;
  const trimmed = input.trim();

  if (!trimmed) {
    throw new ValidationError("Symbol must not be empty", { field: "symbol" });
  }

  const colonIndex = trimmed.indexOf(":");

  if (colonIndex === -1) {
    return { rawSymbol, normalizedSymbol: trimmed.toUpperCase() };
  }

  const exchangePart = trimmed.slice(0, colonIndex).trim();
  const symbolPart = trimmed.slice(colonIndex + 1).trim();

  if (!symbolPart) {
    throw new ValidationError(`Symbol "${input}" has an exchange prefix but no symbol`, {
      field: "symbol",
    });
  }

  return {
    rawSymbol,
    normalizedSymbol: symbolPart.toUpperCase(),
    exchangeFromSymbol: exchangePart ? exchangePart.toUpperCase() : undefined,
  };
}
