import { ValidationError } from "./errors";

/**
 * Which Binance market a symbol trades on. TradingView marks USD-M perpetual
 * futures with a ".P" suffix (e.g. "BINANCE:GRASSUSDT.P"); everything else is
 * treated as spot.
 */
export type MarketType = "spot" | "futures";

const PERPETUAL_SUFFIX = ".P";

export interface NormalizedTradingSymbol {
  /** The input exactly as received (trimmed only for emptiness checking). */
  rawSymbol: string;
  /** Uppercased symbol with any EXCHANGE: prefix and .P suffix stripped, e.g. "BTCUSDT". */
  normalizedSymbol: string;
  /** Uppercased exchange parsed from an "EXCHANGE:SYMBOL" prefix, if present. */
  exchangeFromSymbol?: string;
  /** "futures" when the raw symbol carries TradingView's ".P" perpetual suffix, else "spot". */
  marketType: MarketType;
}

function hasPerpetualSuffix(symbol: string): boolean {
  return symbol.toUpperCase().endsWith(PERPETUAL_SUFFIX);
}

/**
 * Never-throwing marketType inference for contexts where the symbol has
 * already been validated (e.g. the worker re-deriving marketType from an
 * alert's stored rawPayload.symbol). Non-string or empty input infers "spot".
 */
export function inferMarketType(value: unknown): MarketType {
  return typeof value === "string" && hasPerpetualSuffix(value.trim()) ? "futures" : "spot";
}

/**
 * Normalizes a TradingView-style symbol. TradingView's {{ticker}} placeholder
 * usually sends a bare symbol ("BTCUSDT"), but {{exchange}}:{{ticker}} setups
 * and some alert templates send prefixed forms like "BINANCE:BTCUSDT" or
 * "NASDAQ:AAPL", and perpetual futures tickers carry a ".P" suffix
 * ("BINANCE:GRASSUSDT.P"). Downstream consumers (the Binance klines provider,
 * duplicate suppression, Asset upsert) all need the bare uppercase symbol;
 * the ".P" is folded into `marketType` instead.
 */
export function normalizeTradingSymbol(input: string): NormalizedTradingSymbol {
  const rawSymbol = input;
  const trimmed = input.trim();

  if (!trimmed) {
    throw new ValidationError("Symbol must not be empty", { field: "symbol" });
  }

  const colonIndex = trimmed.indexOf(":");
  const exchangePart = colonIndex === -1 ? "" : trimmed.slice(0, colonIndex).trim();
  let symbolPart = colonIndex === -1 ? trimmed : trimmed.slice(colonIndex + 1).trim();

  if (!symbolPart) {
    throw new ValidationError(`Symbol "${input}" has an exchange prefix but no symbol`, {
      field: "symbol",
    });
  }

  const marketType: MarketType = hasPerpetualSuffix(symbolPart) ? "futures" : "spot";
  if (marketType === "futures") {
    symbolPart = symbolPart.slice(0, -PERPETUAL_SUFFIX.length).trim();
    if (!symbolPart) {
      throw new ValidationError(`Symbol "${input}" has a ".P" suffix but no symbol`, {
        field: "symbol",
      });
    }
  }

  return {
    rawSymbol,
    normalizedSymbol: symbolPart.toUpperCase(),
    exchangeFromSymbol: exchangePart ? exchangePart.toUpperCase() : undefined,
    marketType,
  };
}
