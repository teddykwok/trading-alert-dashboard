import type {
  BinanceAssetMode,
  BinanceBalanceDto,
  BinanceLeverageBracketDto,
  BinanceMarginType,
  BinanceOpenOrderDto,
  BinancePositionDto,
  BinancePositionMode,
  BinanceAlgoOrderDto,
  BinanceMarginHistoryEntryDto,
  BinanceMarkPriceDto,
  BinancePositionSide,
  BinanceHistoricalOrderDto,
  BinanceQueriedOrderDto,
  BinanceUserTradeDto,
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

export function asRow(value: unknown): Row {
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

/** Ids may arrive as a JSON number or string; both render exactly. */
function idString(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
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

/**
 * TOLERANT position side, for rows whose DTO cannot hold an absence.
 *
 * Answers "BOTH" for anything it cannot read. That is correct for a POSITION,
 * where the field describes the row's own identity and ONE-WAY mode really
 * does report "BOTH" — but it is a fabricated answer, so it must never be used
 * for an accounting fact. See `strictPositionSide`.
 */
export function normalizePositionSide(value: unknown): BinancePositionSide {
  const upper = text(value)?.toUpperCase();
  return upper === "LONG" || upper === "SHORT" ? upper : "BOTH";
}

/**
 * STRICT position side, for economic facts that must not be invented.
 *
 * A FILL is an accounting row, not an identity: in HEDGE mode "BOTH" is not a
 * reading at all, and defaulting to it would record a side nobody reported and
 * make the row indistinguishable from a genuine ONE-WAY fill. An unreadable
 * value therefore returns null, so the ledger refuses the row as incomplete
 * instead of inserting a fabricated one.
 *
 * `text` already rejects every non-string, so an object, array, boolean or
 * number is unreadable rather than stringified. Case folding matches
 * `normalizePositionSide` exactly — this is stricter about WHICH values are
 * recognised, never about how they are spelled.
 */
export function strictPositionSide(value: unknown): BinancePositionSide | null {
  const upper = text(value)?.toUpperCase();
  return upper === "LONG" || upper === "SHORT" || upper === "BOTH" ? upper : null;
}

/**
 * STRICT exchange identity, for ids that become DURABLE keys.
 *
 * `String(value)` accepts everything, which is how `{}` becomes
 * "[object Object]", `[7]` becomes "7", `true` becomes "true" and an array
 * becomes "". Every one of those is a fabricated identity that looks entirely
 * plausible in a database column, and a fill ledger keyed on it would treat two
 * unrelated rows as the same trade or one trade as two.
 *
 * VALIDATION, NOT CANONICALIZATION. A digit string is returned byte-for-byte:
 * "00123" stays "00123" and a 19-digit id keeps every digit, because the
 * exchange's spelling of its own identity is the identity. Nothing here is
 * parsed, re-rendered or compared numerically.
 *
 * A JSON NUMBER is accepted only when JavaScript can represent it exactly.
 * `JSON.parse` has already rounded anything past 2^53 by the time this runs --
 * 9007199254740993 arrives as 9007199254740992 -- so an unsafe integer is
 * refused rather than stored as an authoritative id that is quietly off by one.
 * The string form remains the lossless path.
 */
export function strictExchangeId(value: unknown): string | null {
  // No trim: whitespace is not part of an id, and accepting " 12 " would force
  // a canonicalization decision this deliberately does not make.
  if (typeof value === "string") return /^\d+$/.test(value) ? value : null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  return null;
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
      clientOrderId: text(row.clientOrderId),
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
    // Read verbatim and NOT defaulted. `text()` yields null for an absent or
    // non-string field, and null must stay null all the way to the policy:
    // a contract whose collateral asset we could not read is unknown, not
    // acceptable, and certainly not inferrable from the ticker's spelling.
    quoteAsset: text(row.quoteAsset),
    marginAsset: text(row.marginAsset),
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

/**
 * GET /fapi/v1/premiumIndex for ONE symbol.
 *
 * Binance returns an object when `symbol` is supplied and an array when it is
 * not; both shapes are accepted, but the row must match the symbol that was
 * asked about — a reply about a different contract is never silently used.
 *
 * Returns null for anything unusable (missing, non-decimal, zero or negative
 * mark price, or a symbol mismatch). The caller turns that into a typed
 * failure: a trigger price must never be derived from a mark price we could
 * not read, so this fails closed rather than guessing.
 */
export function normalizeMarkPrice(payload: unknown, symbol: string): BinanceMarkPriceDto | null {
  const wanted = symbol.trim().toUpperCase();
  const rows = Array.isArray(payload) ? asRows(payload) : [asRow(payload)];
  const row = rows.find((entry) => text(entry.symbol)?.toUpperCase() === wanted);
  if (!row) return null;

  const markPrice = decimalString(row.markPrice);
  // A mark price of "0", "-1" or "abc" is not a price. Plain decimal literals
  // only — the same rule the rest of the decimal path enforces.
  if (!markPrice || !/^\d+(\.\d+)?$/.test(markPrice) || !/[1-9]/.test(markPrice)) return null;

  return { symbol: wanted, markPrice };
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

/**
 * Normalizes GET /fapi/v1/allOrders. Always a LIST; a non-list payload is an
 * empty result rather than a guess, because a malformed history must never
 * read as "no history" to a caller proving absence — the caller checks the
 * query SUCCEEDED separately.
 */
export function normalizeHistoricalOrders(payload: unknown): BinanceHistoricalOrderDto[] {
  if (!Array.isArray(payload)) return [];
  return asRows(payload).map((row) => {
    const updateTime = Number(row.updateTime ?? row.time);
    return {
      orderId: row.orderId === undefined || row.orderId === null ? null : String(row.orderId),
      clientOrderId: text(row.clientOrderId),
      status: text(row.status),
      side: text(row.side),
      positionSide: row.positionSide === undefined ? null : normalizePositionSide(row.positionSide),
      origQty: decimalString(row.origQty),
      executedQty: decimalString(row.executedQty),
      updateTimeMs: Number.isFinite(updateTime) ? updateTime : null,
    };
  });
}

/**
 * Normalizes GET /fapi/v1/userTrades. Same list discipline as above.
 *
 * CARDINALITY IS 1:1 AND LOAD-BEARING. `asRows` maps every element and never
 * filters, and every field reader below is total, so a null, scalar or garbage
 * element becomes a placeholder DTO rather than disappearing. Saturation is
 * measured against the number of rows the EXCHANGE returned, so a normalizer
 * that quietly dropped an unusable row would make a truncated page look short
 * and end a window that was never exhausted. Do not add a filter here.
 *
 * A non-array payload still answers `[]`; the userTrades WRAPPER refuses that
 * case before ever calling this, because "not a page" and "an empty page" are
 * different claims and only one of them may be treated as an answer.
 *
 * Both exchange identities go through `strictExchangeId` and the position side
 * through `strictPositionSide`: this endpoint feeds durable fill accounting, so
 * an unreadable field must arrive as an absence the ledger can refuse, never as
 * a plausible value it will store.
 */
export function normalizeUserTrades(payload: unknown): BinanceUserTradeDto[] {
  if (!Array.isArray(payload)) return [];
  return asRows(payload).map((row) => {
    const time = Number(row.time);
    return {
      // STRICT: the durable fill identity. An unreadable id is null, never a
      // stringified object, boolean or rounded double -- the ledger refuses a
      // fill with no identity, and a fabricated one would key a real economic
      // row to a trade that does not exist.
      tradeId: strictExchangeId(row.id),
      // STRICT for the same reason, but NOT required: the ledger records an
      // economic fill with no order id as UNATTRIBUTED, which is a legitimate
      // reading. What it must never hold is an order id nobody issued.
      orderId: strictExchangeId(row.orderId),
      symbol: text(row.symbol),
      side: text(row.side),
      // STRICT: an absent OR unreadable side is null, never a fabricated
      // "BOTH". The ledger skips such a row; recording it would put a side
      // nobody reported into the accounting substrate.
      positionSide: strictPositionSide(row.positionSide),
      quantity: decimalString(row.qty),
      price: decimalString(row.price),
      // Accounting fields, byte-exact. `decimalString` preserves the delivered
      // text, so a negative realized result and a long commission expansion
      // both survive; an absent field stays null rather than becoming 0.
      quoteQuantity: decimalString(row.quoteQty),
      realizedPnl: decimalString(row.realizedPnl),
      commission: decimalString(row.commission),
      commissionAsset: text(row.commissionAsset),
      maker: bool(row.maker),
      timeMs: Number.isFinite(time) ? time : null,
    };
  });
}

/**
 * Normalizes one Algo Order response. Decimals stay exact strings and the
 * algoStatus token is passed through verbatim — the pure protection module,
 * not this normalizer, decides what an unrecognised value means.
 */
export function normalizeAlgoOrder(payload: unknown): BinanceAlgoOrderDto {
  // Binance may answer with the row itself or with a single-entry list.
  const rows = Array.isArray(payload) ? asRows(payload) : [asRow(payload)];
  const row = (rows[0] ?? {}) as Row;
  const triggerTime = Number(row.triggerTime ?? row.bookTime);
  const updateTime = Number(row.updateTime ?? row.time);

  return {
    algoId: row.algoId === undefined || row.algoId === null ? null : String(row.algoId),
    clientAlgoId: text(row.clientAlgoId),
    symbol: text(row.symbol),
    algoStatus: text(row.algoStatus ?? row.status),
    algoType: text(row.algoType),
    side: text(row.side),
    positionSide: row.positionSide === undefined ? null : normalizePositionSide(row.positionSide),
    orderType: text(row.orderType ?? row.type ?? row.origType),
    quantity: decimalString(row.quantity ?? row.origQty),
    triggerPrice: decimalString(row.triggerPrice ?? row.stopPrice),
    workingType: text(row.workingType),
    priceProtect: bool(row.priceProtect),
    closePosition: bool(row.closePosition),
    reduceOnly: bool(row.reduceOnly),
    // The Query Algo Order response names the fields describing the standard
    // order the conditional order PRODUCED as `actualOrderId` / `actualQty` /
    // `actualPrice`. Reading only the standard-order names (`orderId`,
    // `executedQty`, `avgPrice`) left all three null for every algo fill —
    // which silently blanked `actualExitPrice` on a real CLOSED_TP/CLOSED_SL.
    // Documented names first, legacy names kept as a fallback.
    actualOrderId: idString(row.actualOrderId ?? row.orderId),
    executedQuantity: decimalString(row.actualQty ?? row.executedQty),
    averagePrice: decimalString(row.actualPrice ?? row.avgPrice),
    triggerTimeMs: Number.isFinite(triggerTime) ? triggerTime : null,
    updateTimeMs: Number.isFinite(updateTime) ? updateTime : null,
  };
}

/**
 * Normalizes GET /fapi/v1/openAlgoOrders for ONE requested symbol.
 *
 * FAILS CLOSED. Returns null — never a shorter list — for anything it cannot
 * fully read, because the caller uses the LENGTH of this array as proof that
 * no conditional orders exist. Silently dropping an unreadable row, or
 * turning a non-array body into `[]`, would let malformed data masquerade as
 * "the book is empty" and unlock a mutation run. That is the same
 * absent-versus-unknown conflation that stranded the first mainnet canary.
 *
 *   []                        -> [] (a genuine, readable zero)
 *   [validRow, validRow]      -> the normalized orders
 *   non-array payload         -> null
 *   any unreadable row        -> null (the WHOLE response is invalidated)
 *   any row for another symbol-> null
 *
 * The symbol check matters because this helper is only ever called with an
 * exact symbol: a non-empty row about a different contract means we are not
 * reading the book we asked about.
 */
export function normalizeOpenAlgoOrders(payload: unknown, symbol: string): BinanceAlgoOrderDto[] | null {
  if (!Array.isArray(payload)) return null;

  const wanted = symbol.trim().toUpperCase();
  if (wanted === "") return null;

  const orders: BinanceAlgoOrderDto[] = [];
  for (const raw of payload) {
    // A row must be a plain object; a primitive or nested array is unreadable.
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;

    const order = normalizeAlgoOrder(raw);
    // Minimum identity for COUNTING an open algo order: it must say which
    // contract it belongs to, and it must be addressable by at least one id.
    if (order.symbol === null || order.symbol.toUpperCase() !== wanted) return null;
    if (order.algoId === null && order.clientAlgoId === null) return null;

    orders.push(order);
  }

  return orders;
}

/** Normalizes position-margin change history rows (ADD reconciliation only). */
export function normalizeMarginHistory(payload: unknown): BinanceMarginHistoryEntryDto[] {
  return asRows(payload).map((row) => {
    const time = Number(row.time);
    const type = Number(row.type);
    return {
      symbol: text(row.symbol),
      positionSide: row.positionSide === undefined ? null : normalizePositionSide(row.positionSide),
      amount: decimalString(row.amount ?? row.deltaAmount),
      type: Number.isFinite(type) ? type : null,
      timeMs: Number.isFinite(time) ? time : null,
    };
  });
}
