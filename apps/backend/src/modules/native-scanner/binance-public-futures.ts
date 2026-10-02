import type { NativeKline } from "@trading-alert-dashboard/shared";

/**
 * Binance USD-M Futures PUBLIC market data, as the native scanner sees it.
 *
 * Scanner-owned on purpose. The analysis path's `market-data.service` can fall
 * back to mock candles, and its interval table is what decides which chart
 * timeframes the TradingView path accepts; neither belongs anywhere near a
 * signal generator.
 *
 * Everything here is PUBLIC and unsigned. There is no notion of a key, a
 * signature or an account in this file, and the URL builder below is an
 * allowlist: an endpoint or parameter it does not list cannot be expressed.
 */

export type ScannerMarketType = "USDM_PERPETUAL";
export const SCANNER_MARKET_TYPE: ScannerMarketType = "USDM_PERPETUAL";

/**
 * Chart intervals the scanner supports, and their length.
 *
 * Only 15m today: the preserved production evidence is 100% 15m. Adding an
 * interval is a reviewed change, not a parameter.
 */
export const SCANNER_CHART_INTERVALS = Object.freeze({ "15m": 15 * 60_000 } as const);
export type ScannerChartInterval = keyof typeof SCANNER_CHART_INTERVALS;

export type ScannerDataErrorCode =
  | "INVALID_SYMBOL"
  | "UNSUPPORTED_INTERVAL"
  | "UNTRUSTED_BASE_URL"
  | "FORBIDDEN_ENDPOINT"
  | "FORBIDDEN_PARAMETER"
  | "MALFORMED_ROW"
  | "MALFORMED_RESPONSE"
  | "INVALID_RANGE"
  | "RANGE_TOO_LARGE"
  | "RANGE_NOT_CLOSED"
  | "OUT_OF_RANGE_ROW"
  | "CONTRADICTORY_ROW"
  | "PAGINATION_STALLED"
  | "REQUEST_BUDGET_EXHAUSTED"
  | "RATE_LIMITED"
  | "IP_BANNED"
  | "HTTP_ERROR"
  | "TRANSPORT_FAILED";

/** A refusal. Nothing in the scanner's data layer repairs; it stops and says why. */
export class ScannerDataError extends Error {
  constructor(
    readonly code: ScannerDataErrorCode,
    message: string,
    /** Set for RATE_LIMITED / IP_BANNED when the response carried Retry-After. */
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "ScannerDataError";
  }
}

function refuse(code: ScannerDataErrorCode, message: string): never {
  throw new ScannerDataError(code, message);
}

/** One bare Binance symbol, e.g. "BTCUSDT". No exchange prefix, no ".P", no lists. */
export function assertScannerSymbol(symbol: unknown): string {
  if (typeof symbol !== "string" || !/^[A-Z0-9]{3,30}$/.test(symbol)) {
    refuse("INVALID_SYMBOL", "symbol must be ONE bare uppercase Binance symbol such as BTCUSDT");
  }
  return symbol;
}

export function intervalMsOf(interval: unknown): number {
  if (typeof interval !== "string" || !Object.prototype.hasOwnProperty.call(SCANNER_CHART_INTERVALS, interval)) {
    refuse("UNSUPPORTED_INTERVAL", `chart interval must be one of: ${Object.keys(SCANNER_CHART_INTERVALS).join(", ")}`);
  }
  return SCANNER_CHART_INTERVALS[interval as ScannerChartInterval];
}

// ---------------------------------------------------------------------------
// Endpoint allowlist
// ---------------------------------------------------------------------------

/** The only hosts the scanner will talk to: Binance USD-M Futures, mainnet. */
export const PUBLIC_FUTURES_HOSTS: readonly string[] = Object.freeze(["fapi.binance.com"]);

/**
 * The ONLY paths, and for each the ONLY query parameters, the scanner may send.
 * Order, account, position, user-data and every signed endpoint are absent, so
 * they cannot be built — not refused at run time, simply not expressible.
 */
const PUBLIC_ENDPOINTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "/fapi/v1/time": Object.freeze([]),
  "/fapi/v1/klines": Object.freeze(["symbol", "interval", "startTime", "endTime", "limit"]),
  // Universe discovery: contract metadata for every symbol. Unsigned, no parameters.
  "/fapi/v1/exchangeInfo": Object.freeze([]),
  // Advisory current price: latest trade price, all symbols in one request (or one symbol).
  "/fapi/v1/ticker/price": Object.freeze(["symbol"]),
});

export const KLINES_PATH = "/fapi/v1/klines";
export const SERVER_TIME_PATH = "/fapi/v1/time";
export const EXCHANGE_INFO_PATH = "/fapi/v1/exchangeInfo";
export const TICKER_PRICE_PATH = "/fapi/v1/ticker/price";

/** Normalises and checks a configured base URL: https, an allowed host, nothing else. */
export function assertPublicFuturesBaseUrl(baseUrl: unknown): string {
  let url: URL;
  try {
    url = new URL(String(baseUrl));
  } catch {
    refuse("UNTRUSTED_BASE_URL", "the futures base URL could not be parsed");
  }
  if (url.protocol !== "https:") refuse("UNTRUSTED_BASE_URL", "the futures base URL must use https");
  if (url.username !== "" || url.password !== "") refuse("UNTRUSTED_BASE_URL", "the futures base URL must not carry credentials");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    refuse("UNTRUSTED_BASE_URL", "the futures base URL must be an origin only");
  }
  if (url.port !== "" || !PUBLIC_FUTURES_HOSTS.includes(url.hostname)) {
    refuse("UNTRUSTED_BASE_URL", `the futures base URL host must be one of: ${PUBLIC_FUTURES_HOSTS.join(", ")}`);
  }
  return url.origin;
}

/**
 * Builds one public request URL, or refuses.
 *
 * Parameters are emitted in the allowlist's order, so the same request is
 * always the same string.
 */
export function buildPublicFuturesUrl(
  baseUrl: string,
  path: string,
  params: Readonly<Record<string, string | number>> = {}
): string {
  const origin = assertPublicFuturesBaseUrl(baseUrl);
  const allowed = Object.prototype.hasOwnProperty.call(PUBLIC_ENDPOINTS, path) ? PUBLIC_ENDPOINTS[path] : null;
  if (allowed === null) refuse("FORBIDDEN_ENDPOINT", `${path} is not a public market-data endpoint the scanner may call`);
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) refuse("FORBIDDEN_PARAMETER", `parameter "${key}" is not allowed on ${path}`);
  }
  const query = new URLSearchParams();
  for (const key of allowed) {
    if (!(key in params)) continue;
    const value = params[key];
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      refuse("FORBIDDEN_PARAMETER", `parameter "${key}" must be an integer`);
    }
    query.set(key, String(value));
  }
  const search = query.toString();
  return `${origin}${path}${search === "" ? "" : `?${search}`}`;
}

// ---------------------------------------------------------------------------
// Strict row parsing
// ---------------------------------------------------------------------------

/** A plain non-negative decimal as Binance prints prices: "0.44610000", "64000.5". */
const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

/** Number of fields in a Binance kline row (documented layout). */
export const BINANCE_KLINE_ROW_LENGTH = 12;

function price(value: unknown, field: string): number {
  if (typeof value !== "string" || !DECIMAL.test(value)) refuse("MALFORMED_ROW", `${field} must be a decimal string`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) refuse("MALFORMED_ROW", `${field} must be a finite price > 0`);
  return parsed;
}

/**
 * Refuses a kline whose geometry is impossible for a CLOSED `intervalMs` bar.
 * Shared by the network parser and the cache reader, so both apply one rule.
 */
export function assertClosedKlineGeometry(kline: NativeKline, intervalMs: number): void {
  const { openTimeMs, closeTimeMs, open, high, low, close } = kline;
  if (!Number.isSafeInteger(openTimeMs) || !Number.isSafeInteger(closeTimeMs)) {
    refuse("MALFORMED_ROW", "open and close times must be integers");
  }
  if (closeTimeMs <= openTimeMs) refuse("MALFORMED_ROW", "closeTime must be after openTime");
  if (closeTimeMs !== openTimeMs + intervalMs - 1) refuse("MALFORMED_ROW", "closeTime does not match the chart interval");
  if (openTimeMs % intervalMs !== 0) refuse("MALFORMED_ROW", "openTime is not aligned to the chart interval");
  for (const value of [open, high, low, close]) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) refuse("MALFORMED_ROW", "prices must be finite and > 0");
  }
  if (high < low) refuse("MALFORMED_ROW", "high is below low");
  if (high < Math.max(open, close)) refuse("MALFORMED_ROW", "high is below open or close");
  if (low > Math.min(open, close)) refuse("MALFORMED_ROW", "low is above open or close");
}

/**
 * One Binance Futures kline row:
 *   [openTime, open, high, low, close, volume, closeTime, quoteVolume,
 *    trades, takerBuyBase, takerBuyQuote, ignore]
 * Prices are decimal strings; times are integers. Converted with plain
 * `Number`, which is what Pine's doubles need.
 */
export function parseFuturesKlineRow(row: unknown, intervalMs: number): NativeKline {
  if (!Array.isArray(row) || row.length !== BINANCE_KLINE_ROW_LENGTH) {
    refuse("MALFORMED_ROW", `a kline row must be an array of ${BINANCE_KLINE_ROW_LENGTH} fields`);
  }
  const kline: NativeKline = {
    openTimeMs: row[0] as number,
    closeTimeMs: row[6] as number,
    open: price(row[1], "open"),
    high: price(row[2], "high"),
    low: price(row[3], "low"),
    close: price(row[4], "close"),
  };
  assertClosedKlineGeometry(kline, intervalMs);
  return kline;
}

export function parseFuturesKlinesPayload(payload: unknown, intervalMs: number): NativeKline[] {
  if (!Array.isArray(payload)) refuse("MALFORMED_RESPONSE", "a klines response must be an array");
  return payload.map((row) => parseFuturesKlineRow(row, intervalMs));
}

export function parseServerTimePayload(payload: unknown): number {
  const serverTime = (payload as { serverTime?: unknown } | null)?.serverTime;
  if (typeof serverTime !== "number" || !Number.isSafeInteger(serverTime) || serverTime <= 0) {
    refuse("MALFORMED_RESPONSE", "the server time response must carry an integer serverTime");
  }
  return serverTime;
}

/**
 * Retry-After as milliseconds, or null when absent or unreadable.
 * Accepts delta-seconds ("120") or an HTTP-date, judged against `nowMs`.
 */
export function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at) || !/[A-Za-z]/.test(trimmed)) return null;
  return Math.max(0, at - nowMs);
}
