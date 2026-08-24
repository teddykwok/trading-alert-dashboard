/**
 * Narrow internal DTOs. Raw Binance payloads never leave the module: every
 * service return value is one of these shapes, so added upstream fields are
 * ignored rather than leaking or breaking parsing.
 *
 * All exchange numerics are DECIMAL STRINGS. Values Binance sends as JSON
 * strings ("0.00100000") are preserved byte-for-byte; the few it sends as
 * JSON numbers are stringified without any arithmetic.
 */

export type BinancePositionMode = "HEDGE" | "ONE_WAY";
export type BinancePositionSide = "LONG" | "SHORT" | "BOTH";
export type BinanceMarginType = "ISOLATED" | "CROSS";
export type BinanceAssetMode = "MULTI_ASSET" | "SINGLE_ASSET";

export interface BinanceConnectionInfo {
  ok: boolean;
  /** Host only, never credentials, e.g. "fapi.binance.com". */
  host: string;
  serverTimeMs: number | null;
  serverTimeIso: string | null;
  clockOffsetMs: number | null;
  roundTripMs: number | null;
}

/** GET /fapi/v1/premiumIndex, narrowed to the two fields anything here needs. */
export interface BinanceMarkPriceDto {
  symbol: string;
  /** Decimal string, byte-for-byte as Binance sent it. Never null: a payload
   *  without a usable mark price fails closed rather than returning one. */
  markPrice: string;
}

export interface BinanceBalanceDto {
  asset: string;
  walletBalance: string | null;
  availableBalance: string | null;
  crossUnPnl: string | null;
}

export interface BinancePositionDto {
  symbol: string;
  positionSide: BinancePositionSide;
  positionAmt: string | null;
  entryPrice: string | null;
  markPrice: string | null;
  liquidationPrice: string | null;
  unrealizedProfit: string | null;
  notional: string | null;
  /** From positionRisk when present, else enriched from symbolConfig. */
  marginType: BinanceMarginType | null;
  leverage: string | null;
  isolatedMargin: string | null;
  isolatedWallet: string | null;
}

export interface BinanceOpenOrderDto {
  orderId: string | null;
  symbol: string;
  side: string | null;
  positionSide: BinancePositionSide | null;
  type: string | null;
  timeInForce: string | null;
  price: string | null;
  stopPrice: string | null;
  origQty: string | null;
  reduceOnly: boolean | null;
  closePosition: boolean | null;
}

export interface BinanceSymbolFiltersDto {
  symbol: string;
  status: string | null;
  contractType: string | null;
  /** PRICE_FILTER */
  tickSize: string | null;
  minPrice: string | null;
  maxPrice: string | null;
  /** LOT_SIZE */
  stepSize: string | null;
  minQty: string | null;
  maxQty: string | null;
  /** MARKET_LOT_SIZE */
  marketStepSize: string | null;
  marketMinQty: string | null;
  marketMaxQty: string | null;
  /** MIN_NOTIONAL, when supplied. */
  minNotional: string | null;
  orderTypes: string[];
  timeInForce: string[];
}

export interface BinanceLeverageBracketDto {
  bracket: number | null;
  initialLeverage: number | null;
  notionalCap: string | null;
  notionalFloor: string | null;
  maintMarginRatio: string | null;
  cum: string | null;
}

export interface BinanceSymbolInspectionDto {
  filters: BinanceSymbolFiltersDto;
  brackets: BinanceLeverageBracketDto[];
  /** Highest documented initialLeverage across the symbol's brackets. */
  maxInitialLeverage: number | null;
  /** Account-specific configuration for this symbol, when available. */
  accountSymbolConfig: {
    marginType: BinanceMarginType | null;
    leverage: string | null;
    maxNotionalValue: string | null;
    isAutoAddMargin: boolean | null;
  } | null;
}

export interface BinanceAccountSummaryDto {
  connection: BinanceConnectionInfo;
  positionMode: BinancePositionMode | null;
  assetMode: BinanceAssetMode | null;
  usdtWalletBalance: string | null;
  usdtAvailableBalance: string | null;
  nonZeroPositionCount: number;
  openOrderCount: number;
  /**
   * Distinct uppercase symbols with at least one open order. Symbols only —
   * no order ids, prices or quantities — so safety admission can block a
   * symbol that already has working orders without handling order detail.
   */
  openOrderSymbols: string[];
  positions: BinancePositionDto[];
  /** Sanitized, human-readable notes (e.g. the ONE_WAY mode warning). */
  warnings: string[];
}

/**
 * One order as returned by GET /fapi/v1/order. Only the fields the entry
 * lifecycle needs are normalized — no raw payload is ever carried forward.
 */
export interface BinanceQueriedOrderDto {
  orderId: string | null;
  clientOrderId: string | null;
  symbol: string | null;
  status: string | null;
  side: string | null;
  positionSide: BinancePositionSide | null;
  type: string | null;
  timeInForce: string | null;
  price: string | null;
  origQty: string | null;
  executedQty: string | null;
  /** Weighted average fill price ("avgPrice"). */
  averagePrice: string | null;
  reduceOnly: boolean | null;
  closePosition: boolean | null;
  updateTimeMs: number | null;
}

/**
 * One row of GET /fapi/v1/allOrders, reduced to what an absence proof needs.
 *
 * Deliberately narrow: identity and fill quantity only. Recovery asks "did
 * this client order id ever exist, and did anything trade?" — never anything
 * that would tempt a caller to reconstruct a plan from history.
 */
export interface BinanceHistoricalOrderDto {
  orderId: string | null;
  clientOrderId: string | null;
  status: string | null;
  side: string | null;
  positionSide: BinancePositionSide | null;
  origQty: string | null;
  executedQty: string | null;
  updateTimeMs: number | null;
}

/**
 * One row of GET /fapi/v1/userTrades — a FILL. Its presence is disqualifying
 * evidence for any release, so only what identifies it is carried.
 */
export interface BinanceUserTradeDto {
  tradeId: string | null;
  orderId: string | null;
  side: string | null;
  positionSide: BinancePositionSide | null;
  quantity: string | null;
  price: string | null;
  timeMs: number | null;
}

/**
 * One conditional (Algo) protection order from GET /fapi/v1/algoOrder. Algo
 * semantics differ from standard orders: it stays "working" until it triggers
 * and only then creates an actual order, so both identities are normalized.
 */
export interface BinanceAlgoOrderDto {
  algoId: string | null;
  clientAlgoId: string | null;
  symbol: string | null;
  algoStatus: string | null;
  algoType: string | null;
  side: string | null;
  positionSide: BinancePositionSide | null;
  orderType: string | null;
  quantity: string | null;
  triggerPrice: string | null;
  workingType: string | null;
  priceProtect: boolean | null;
  closePosition: boolean | null;
  reduceOnly: boolean | null;
  /** The standard order created once the conditional order triggered. */
  actualOrderId: string | null;
  executedQuantity: string | null;
  averagePrice: string | null;
  triggerTimeMs: number | null;
  updateTimeMs: number | null;
}

/** One ADD entry from GET /fapi/v1/positionMargin/history. */
export interface BinanceMarginHistoryEntryDto {
  symbol: string | null;
  positionSide: BinancePositionSide | null;
  amount: string | null;
  /** 1 = ADD, 2 = REMOVE. Only ADD is ever requested. */
  type: number | null;
  timeMs: number | null;
}
