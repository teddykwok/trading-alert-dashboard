import type {
  BinanceAssetMode,
  BinanceBalanceDto,
  BinanceLeverageBracketDto,
  BinanceMarginType,
  BinanceOpenOrderDto,
  BinancePositionDto,
  BinancePositionMode,
  BinancePositionSide,
  BinanceQueriedOrderDto,
  BinanceSymbolFiltersDto,
} from "./binance.types";

/**
 * Field-tolerant normalizers.
 *
 * Every reader takes `unknown`, picks only the fields it knows and ignores
 * everything else, so new Binance fields never break parsing and raw payloads
 * never escape the module.
 *
 * DECIMAL POLICY
 * --------------
 * Prices, quantities, margins, balances, liquidation prices and position
 * amounts are carried as decimal STRINGS and are never passed through
 * `Number()`, `parseFloat()`, `parseInt()` or any arithmetic. Whatever
 * Binance sends as a JSON string is returned byte-for-byte, including trailing
 * zeros ("0.10") and Binance's own long averages — `entryPrice` is a computed
 * average that Binance serializes as a full double expansion (a value shaped
 * like "0.30000000000000004"). That expansion is produced on Binance's side
 * and is NOT a local rounding artifact; shortening it here would misreport
 * the real average entry price.
 *
 * LIMITATION: if Binance ever sends one of these fields as a JSON *number*,
 * `JSON.parse` has already converted the wire literal to a double before this
 * module sees it, so byte-exact preservation is impossible for that field. We
 * do not pretend otherwise: the value is rendered with no further float math
 * (only textual expansion of exponent notation) and should be treated as
 * approximate. Today the only account field observed to arrive as a number is
 * `symbolConfig.leverage` (a small integer, exact either way).
 */

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  return value !== null && typeof value === "object" ? (value as Row) : {};
}

export function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(asRow) : [];
}

/**
 * Rewrites exponent notation into plain decimal form using string surgery
 * only — no arithmetic on the value itself. `String(1.2e-7)` would otherwise
 * surface as "1.2e-7", which is not a usable price string.
 * The exponent itself is an integer offset, never a decimal value.
 */
export function expandExponentialNotation(rendered: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(rendered);
  if (!match) return rendered;

  const [, sign, intPart, fracPart = "", exponentText] = match;
  const exponent = Number.parseInt(exponentText, 10); // integer offset only
  const digits = `${intPart}${fracPart}`;
  const pointIndex = intPart.length + exponent;

  if (pointIndex <= 0) return `${sign}0.${"0".repeat(-pointIndex)}${digits}`;
  if (pointIndex >= digits.length) return `${sign}${digits}${"0".repeat(pointIndex - digits.length)}`;
  return `${sign}${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
}

/**
 * Decimal passthrough.
 *
 * A JSON string is returned EXACTLY as Binance sent it (after trimming
 * surrounding whitespace only) — no conversion, no rounding, no reformatting.
 * A JSON number can only be handled approximately; see the module docstring.
 */
export function decimalString(value: unknown): string | null {
  if (typeof value === "string") {
    // Byte-exact: "0.10" stays "0.10", "-25" stays "-25", and a long
    // expansion like "0.30000000000000004" stays exactly as delivered.
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Defensive fallback. `Number.isFinite` is a type guard, not a
    // conversion; `String()` renders the double JSON.parse already produced
    // and expandExponentialNotation reshapes text only. Precision was lost
    // upstream in JSON.parse — this value is approximate by construction.
    return expandExponentialNotation(String(value));
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/**
 * Whole-number metadata ONLY (bracket index, initialLeverage) — never a
 * price, quantity, margin, balance or position amount. Those stay strings via
 * `decimalString`. The regex guarantees an integer literal, so this
 * conversion carries no decimal-precision risk.
 */
function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

export function normalizePositionSide(value: unknown): BinancePositionSide {
  const upper = text(value)?.toUpperCase();
  return upper === "LONG" || upper === "SHORT" ? upper : "BOTH";
}

export function normalizeMarginType(value: unknown): BinanceMarginType | null {
  const upper = text(value)?.toUpperCase();
  if (!upper) return null;
  if (upper === "ISOLATED") return "ISOLATED";
  if (upper === "CROSS" || upper === "CROSSED") return "CROSS";
  return null;
}

/**
 * Position mode comes from the ACCOUNT setting (`GET /fapi/v1/positionSide/dual`),
 * never from project configuration.
 */
export function normalizePositionMode(payload: unknown): BinancePositionMode | null {
  const dual = bool(asRow(payload).dualSidePosition);
  if (dual === null) return null;
  return dual ? "HEDGE" : "ONE_WAY";
}

export function normalizeAssetMode(payload: unknown): BinanceAssetMode | null {
  const multi = bool(asRow(payload).multiAssetsMargin);
  if (multi === null) return null;
  return multi ? "MULTI_ASSET" : "SINGLE_ASSET";
}

export function normalizeBalances(payload: unknown): BinanceBalanceDto[] {
  return asRows(payload)
    .map((row) => ({
      asset: text(row.asset) ?? "",
      walletBalance: decimalString(row.balance ?? row.walletBalance),
      availableBalance: decimalString(row.availableBalance),
      crossUnPnl: decimalString(row.crossUnPnl),
    }))
    .filter((balance) => balance.asset !== "");
}

/**
 * v3 positionRisk dropped per-symbol configuration, so `marginType`/`leverage`
 * are read when present and otherwise left null for the caller to enrich from
 * symbolConfig. LONG and SHORT rows stay separate entries — they are never
 * merged, so hedge-mode positions remain distinct.
 */
export function normalizePositions(payload: unknown): BinancePositionDto[] {
  return asRows(payload)
    .map((row) => ({
      symbol: text(row.symbol) ?? "",
      positionSide: normalizePositionSide(row.positionSide),
      positionAmt: decimalString(row.positionAmt),
      entryPrice: decimalString(row.entryPrice),
      markPrice: decimalString(row.markPrice),
      liquidationPrice: decimalString(row.liquidationPrice),
      unrealizedProfit: decimalString(row.unRealizedProfit ?? row.unrealizedProfit),
      notional: decimalString(row.notional),
      marginType: normalizeMarginType(row.marginType),
      leverage: decimalString(row.leverage),
      isolatedMargin: decimalString(row.isolatedMargin),
      isolatedWallet: decimalString(row.isolatedWallet),
    }))
    .filter((position) => position.symbol !== "");
}

/** A position is "open" when its amount is a non-zero decimal. */
export function isNonZeroPosition(position: BinancePositionDto): boolean {
  const amount = position.positionAmt;
  if (amount === null) return false;
  // String test — no float comparison.
  return /[1-9]/.test(amount);
}

export function normalizeOpenOrders(payload: unknown): BinanceOpenOrderDto[] {
  return asRows(payload)
    .map((row) => ({
      orderId: decimalString(row.orderId),
      symbol: text(row.symbol) ?? "",
      side: text(row.side),
      positionSide: row.positionSide === undefined ? null : normalizePositionSide(row.positionSide),
      type: text(row.type ?? row.origType),
      timeInForce: text(row.timeInForce),
      price: decimalString(row.price),
      stopPrice: decimalString(row.stopPrice),
      origQty: decimalString(row.origQty),
      reduceOnly: bool(row.reduceOnly),
      closePosition: bool(row.closePosition),
    }))
    .filter((order) => order.symbol !== "");
}

function filterOf(filters: Row[], type: string): Row | undefined {
  return filters.find((filter) => text(filter.filterType) === type);
}

/**
 * Pulls the documented filters out of one exchangeInfo symbol entry. Tick and
 * step sizes stay exactly as Binance formats them (e.g. "0.00100000").
 */
export function normalizeSymbolFilters(symbolRow: unknown): BinanceSymbolFiltersDto {
  const row = asRow(symbolRow);
  const filters = asRows(row.filters);

  const price = filterOf(filters, "PRICE_FILTER") ?? {};
  const lot = filterOf(filters, "LOT_SIZE") ?? {};
  const marketLot = filterOf(filters, "MARKET_LOT_SIZE") ?? {};
  const notional = filterOf(filters, "MIN_NOTIONAL") ?? {};

  return {
    symbol: text(row.symbol) ?? "",
    status: text(row.status ?? row.contractStatus),
    contractType: text(row.contractType),
    tickSize: decimalString(price.tickSize),
    minPrice: decimalString(price.minPrice),
    maxPrice: decimalString(price.maxPrice),
    stepSize: decimalString(lot.stepSize),
    minQty: decimalString(lot.minQty),
    maxQty: decimalString(lot.maxQty),
    marketStepSize: decimalString(marketLot.stepSize),
    marketMinQty: decimalString(marketLot.minQty),
    marketMaxQty: decimalString(marketLot.maxQty),
    minNotional: decimalString(notional.notional ?? notional.minNotional),
    orderTypes: Array.isArray(row.orderTypes) ? row.orderTypes.filter((t): t is string => typeof t === "string") : [],
    timeInForce: Array.isArray(row.timeInForce) ? row.timeInForce.filter((t): t is string => typeof t === "string") : [],
  };
}

export function findSymbolRow(exchangeInfo: unknown, symbol: string): Row | undefined {
  const wanted = symbol.trim().toUpperCase();
  return asRows(asRow(exchangeInfo).symbols).find((row) => text(row.symbol)?.toUpperCase() === wanted);
}

export function normalizeLeverageBrackets(payload: unknown, symbol: string): BinanceLeverageBracketDto[] {
  const wanted = symbol.trim().toUpperCase();
  const entry = asRows(payload).find((row) => text(row.symbol)?.toUpperCase() === wanted);
  if (!entry) return [];

  return asRows(entry.brackets).map((row) => ({
    bracket: integer(row.bracket),
    initialLeverage: integer(row.initialLeverage),
    notionalCap: decimalString(row.notionalCap),
    notionalFloor: decimalString(row.notionalFloor),
    maintMarginRatio: decimalString(row.maintMarginRatio),
    cum: decimalString(row.cum),
  }));
}

/** Highest documented initialLeverage across the symbol's brackets. */
export function maxInitialLeverage(brackets: BinanceLeverageBracketDto[]): number | null {
  const values = brackets
    .map((bracket) => bracket.initialLeverage)
    .filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

export function normalizeSymbolConfig(payload: unknown, symbol: string) {
  const wanted = symbol.trim().toUpperCase();
  const entry = asRows(payload).find((row) => text(row.symbol)?.toUpperCase() === wanted);
  if (!entry) return null;

  return {
    marginType: normalizeMarginType(entry.marginType),
    leverage: decimalString(entry.leverage),
    maxNotionalValue: decimalString(entry.maxNotionalValue),
    isAutoAddMargin: bool(entry.isAutoAddMargin),
  };
}

/**
 * Normalizes one GET /fapi/v1/order response. Decimal fields stay exact
 * strings; the status token is passed through verbatim so the pure lifecycle
 * module — not this normalizer — decides what an unrecognised value means.
 */
export function normalizeQueriedOrder(payload: unknown): BinanceQueriedOrderDto {
  const row = asRow(payload);
  const updateTime = Number(row.updateTime ?? row.time);

  return {
    orderId: row.orderId === undefined || row.orderId === null ? null : String(row.orderId),
    clientOrderId: text(row.clientOrderId),
    symbol: text(row.symbol),
    status: text(row.status),
    side: text(row.side),
    positionSide: row.positionSide === undefined ? null : normalizePositionSide(row.positionSide),
    type: text(row.type ?? row.origType),
    timeInForce: text(row.timeInForce),
    price: decimalString(row.price),
    origQty: decimalString(row.origQty),
    executedQty: decimalString(row.executedQty),
    averagePrice: decimalString(row.avgPrice),
    reduceOnly: bool(row.reduceOnly),
    closePosition: bool(row.closePosition),
    updateTimeMs: Number.isFinite(updateTime) ? updateTime : null,
  };
}
