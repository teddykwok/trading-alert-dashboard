import { assertScannerSymbol, intervalMsOf, type ScannerChartInterval } from "./binance-public-futures";

/**
 * Binance USD-M Futures PUBLIC kline stream, as the live shadow scanner sees it.
 *
 * One raw ("ws" mode) stream per run on the routed MARKET path:
 *   wss://fstream.binance.com/market/ws/<symbol>@kline_<interval>
 * Binance split USD-M WebSocket traffic into /public (high-frequency book
 * data), /market (regular market data — klines included) and /private (user
 * data). The legacy un-routed /ws/ URLs were decommissioned after 2026-04-23;
 * a legacy connection still opens but receives nothing from /market channels.
 *
 * There is no listen key, no user-data stream, no account and no API key here:
 * the URL builder below can express exactly one public market-data stream and
 * nothing else, and every message is validated into a narrow internal update
 * type before anything downstream sees it.
 */

export const PUBLIC_FUTURES_STREAM_HOST = "fstream.binance.com";
/** The routed path for regular market data in raw ("ws") mode. */
export const PUBLIC_FUTURES_MARKET_WS_PATH = "/market/ws/";
/** Binance's post-migration symbol-type discriminator: 1 = USD-M (UM), 2 = COIN-M (CM). */
export const USDM_SYMBOL_TYPE = 1;

export type LiveStreamErrorCode = "FORBIDDEN_STREAM" | "WRONG_EVENT" | "WRONG_SYMBOL" | "WRONG_INTERVAL" | "WRONG_MARKET" | "MALFORMED_KLINE";

export class LiveStreamError extends Error {
  constructor(
    readonly code: LiveStreamErrorCode,
    message: string
  ) {
    super(message);
    this.name = "LiveStreamError";
  }
}

function refuse(code: LiveStreamErrorCode, message: string): never {
  throw new LiveStreamError(code, message);
}

/** The one stream this scanner may open. */
export function buildPublicKlineStreamUrl(symbol: string, interval: ScannerChartInterval): string {
  const canonical = assertScannerSymbol(symbol);
  intervalMsOf(interval);
  return assertPublicKlineStreamUrl(
    `wss://${PUBLIC_FUTURES_STREAM_HOST}${PUBLIC_FUTURES_MARKET_WS_PATH}${canonical.toLowerCase()}@kline_${interval}`,
    canonical,
    interval
  );
}

/** Refuses any URL that is not exactly the public kline stream of `symbol` / `interval`. */
export function assertPublicKlineStreamUrl(raw: string, symbol: string, interval: ScannerChartInterval): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    refuse("FORBIDDEN_STREAM", "the stream URL could not be parsed");
  }
  if (url.protocol !== "wss:") refuse("FORBIDDEN_STREAM", "the stream must use wss");
  if (url.username !== "" || url.password !== "") refuse("FORBIDDEN_STREAM", "the stream URL must not carry credentials");
  if (url.hostname !== PUBLIC_FUTURES_STREAM_HOST || url.port !== "") refuse("FORBIDDEN_STREAM", `the stream host must be ${PUBLIC_FUTURES_STREAM_HOST}`);
  if (url.search !== "" || url.hash !== "") refuse("FORBIDDEN_STREAM", "the stream URL must have no query or fragment");
  // Exact routed market path in raw mode: no legacy /ws/, no /public/, no /stream mode.
  const expectedPath = `${PUBLIC_FUTURES_MARKET_WS_PATH}${symbol.toLowerCase()}@kline_${interval}`;
  if (url.pathname !== expectedPath) refuse("FORBIDDEN_STREAM", `the stream path must be exactly ${expectedPath}`);
  return url.toString();
}

/** One validated kline update: the bar's OHLC SO FAR (Binance sends cumulative values). */
export interface LiveKlineUpdate {
  readonly symbol: string;
  readonly interval: ScannerChartInterval;
  /** Exchange event time ("E"). */
  readonly eventTimeMs: number;
  readonly openTimeMs: number;
  readonly closeTimeMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Binance "x": true only on the bar's final, closed update. */
  readonly closed: boolean;
}

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

function decimal(value: unknown, field: string): number {
  if (typeof value !== "string" || !DECIMAL.test(value)) refuse("MALFORMED_KLINE", `${field} must be a decimal string`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) refuse("MALFORMED_KLINE", `${field} must be a positive finite number`);
  return parsed;
}

function integerTime(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) refuse("MALFORMED_KLINE", `${field} must be an integer time`);
  return value;
}

/** Validates one raw stream message for `symbol` / `interval`, or refuses it with an explicit code. */
export function parseKlineStreamMessage(raw: string, symbol: string, interval: ScannerChartInterval): LiveKlineUpdate {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    refuse("MALFORMED_KLINE", "the stream message is not JSON");
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) refuse("MALFORMED_KLINE", "the stream message is not an object");
  const m = message as Record<string, unknown>;
  if (m.e !== "kline") refuse("WRONG_EVENT", `unexpected stream event ${JSON.stringify(m.e)}`);
  if (m.s !== symbol) refuse("WRONG_SYMBOL", `stream symbol ${JSON.stringify(m.s)} is not ${symbol}`);
  const k = m.k;
  if (k === null || typeof k !== "object" || Array.isArray(k)) refuse("MALFORMED_KLINE", "the kline payload is missing");
  const kline = k as Record<string, unknown>;
  if (kline.s !== symbol) refuse("WRONG_SYMBOL", `kline symbol ${JSON.stringify(kline.s)} is not ${symbol}`);
  if (kline.i !== interval) refuse("WRONG_INTERVAL", `kline interval ${JSON.stringify(kline.i)} is not ${interval}`);
  // After the CM migration fstream can serve COIN-M symbols too. Kline payloads
  // carry no discriminator today (the exact USD-M symbol match above is the
  // identity check), but if Binance ever appends its st field it must say UM.
  for (const [where, value] of [
    ["st", m.st],
    ["k.st", kline.st],
  ] as const) {
    if (value !== undefined && value !== USDM_SYMBOL_TYPE) {
      refuse("WRONG_MARKET", `${where} ${JSON.stringify(value)} is not ${USDM_SYMBOL_TYPE} (USD-M)`);
    }
  }

  const intervalMs = intervalMsOf(interval);
  const eventTimeMs = integerTime(m.E, "E");
  const openTimeMs = integerTime(kline.t, "t");
  const closeTimeMs = integerTime(kline.T, "T");
  if (openTimeMs % intervalMs !== 0) refuse("MALFORMED_KLINE", "kline open time is not on an interval boundary");
  if (closeTimeMs !== openTimeMs + intervalMs - 1) refuse("MALFORMED_KLINE", "kline close time does not match its interval");
  const open = decimal(kline.o, "o");
  const high = decimal(kline.h, "h");
  const low = decimal(kline.l, "l");
  const close = decimal(kline.c, "c");
  if (low > high || low > Math.min(open, close) || high < Math.max(open, close)) {
    refuse("MALFORMED_KLINE", "kline must satisfy low <= open,close <= high");
  }
  if (typeof kline.x !== "boolean") refuse("MALFORMED_KLINE", "kline closed flag must be a boolean");
  return { symbol, interval, eventTimeMs, openTimeMs, closeTimeMs, open, high, low, close, closed: kline.x };
}
