/**
 * EXCHANGE SYMBOL IDENTITY — what a Binance USD-M symbol string may be, and how
 * it is spelled on disk and on the WebSocket.
 *
 * Trust model. A symbol is an EXCHANGE identity only because Binance's own
 * public exchangeInfo lists it (TRADING, PERPETUAL, quoteAsset USDT). The exact
 * string Binance returns is the identity — never rewritten, transliterated or
 * aliased. Operators can still name only bare ASCII symbols on the command line
 * (usdm-universe.ts `assertRequestedSymbols`), so an arbitrary Unicode string
 * typed by a person can never become a scanned symbol; a Unicode symbol enters
 * a run only from the exchangeInfo snapshot of an EXCHANGE_INFO_UNICODE universe.
 *
 * Shape (defence in depth, whatever the source):
 *  - ASCII: exactly /^[A-Z0-9]{3,30}$/ (the historical scanner rule, unchanged);
 *  - Unicode: NFC-normalised, 3..30 code points, every code point an ASCII
 *    upper-case letter or digit, or a NON-ASCII letter/number that has NO case
 *    (e.g. CJK). A non-ASCII letter with case is refused: Binance lower-cases
 *    stream names and only the caseless form is proven (see klineStreamNameOf).
 *    Separators, punctuation, marks, whitespace and controls are impossible, so
 *    no symbol can traverse a path, split a stream list or break a URL.
 */

export const ASCII_SCANNER_SYMBOL = /^[A-Z0-9]{3,30}$/;
const ASCII_ALNUM = /^[A-Z0-9]$/;
const LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u;
const MIN_CODE_POINTS = 3;
const MAX_CODE_POINTS = 30;

export const isAsciiScannerSymbol = (symbol: unknown): symbol is string => typeof symbol === "string" && ASCII_SCANNER_SYMBOL.test(symbol);

/** Why `symbol` is not an acceptable Unicode exchange symbol, or null when it is. ASCII symbols are judged by the ASCII rule instead. */
export function unicodeExchangeSymbolProblem(symbol: unknown): string | null {
  if (typeof symbol !== "string") return "not a string";
  if (symbol.normalize("NFC") !== symbol) return "not NFC-normalised";
  const points = [...symbol];
  if (points.length < MIN_CODE_POINTS || points.length > MAX_CODE_POINTS) return `must have ${MIN_CODE_POINTS}..${MAX_CODE_POINTS} code points`;
  let nonAscii = 0;
  for (const c of points) {
    if (ASCII_ALNUM.test(c)) continue;
    if ((c.codePointAt(0) as number) < 0x80) return `contains the ASCII character ${JSON.stringify(c)}`;
    if (!LETTER_OR_NUMBER.test(c)) return `contains U+${(c.codePointAt(0) as number).toString(16).toUpperCase()}, which is not a letter or number`;
    if (c.toLowerCase() !== c || c.toUpperCase() !== c) return `contains the cased letter U+${(c.codePointAt(0) as number).toString(16).toUpperCase()}; only caseless non-ASCII letters have a proven stream name`;
    nonAscii += 1;
  }
  return nonAscii === 0 ? "has no non-ASCII character (an ASCII symbol must match the ASCII rule)" : null;
}

/** ASCII or a valid Unicode exchange shape. Shape only: it never proves Binance lists the symbol. */
export const isScannerSymbolShape = (symbol: unknown): symbol is string => isAsciiScannerSymbol(symbol) || unicodeExchangeSymbolProblem(symbol) === null;

/** Windows device names, refused as bare path segments (case-insensitive file system). */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/;
/** The prefix of an encoded segment: lower case and a hyphen, neither of which an ASCII symbol can contain. */
export const ENCODED_SYMBOL_SEGMENT_PREFIX = "u-";

/**
 * The deterministic, path-safe directory / file stem for a symbol.
 *  - an ASCII symbol is itself (every existing state, cache and cursor path is unchanged);
 *  - anything else is "u-" + the lower-case hex of its UTF-8 bytes: reversible,
 *    collision-free (an ASCII symbol never contains "-" or lower case, and hex
 *    is case-insensitive-safe), and free of any character a file system could
 *    reinterpret. The exact symbol is never derived from the path: it is kept
 *    verbatim inside every file.
 */
export function symbolPathSegment(symbol: string): string {
  if (isAsciiScannerSymbol(symbol) && !WINDOWS_RESERVED.test(symbol)) return symbol;
  if (!isScannerSymbolShape(symbol)) throw new Error(`not a scanner symbol: ${JSON.stringify(symbol)}`);
  return `${ENCODED_SYMBOL_SEGMENT_PREFIX}${Buffer.from(symbol, "utf8").toString("hex")}`;
}

/** The exact symbol a path segment encodes (inverse of symbolPathSegment). */
export function symbolFromPathSegment(segment: string): string {
  if (!segment.startsWith(ENCODED_SYMBOL_SEGMENT_PREFIX)) {
    if (!isAsciiScannerSymbol(segment)) throw new Error(`not a symbol path segment: ${JSON.stringify(segment)}`);
    return segment;
  }
  const hex = segment.slice(ENCODED_SYMBOL_SEGMENT_PREFIX.length);
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) throw new Error(`not a symbol path segment: ${JSON.stringify(segment)}`);
  const symbol = Buffer.from(hex, "hex").toString("utf8");
  if (symbolPathSegment(symbol) !== segment) throw new Error(`not a canonical symbol path segment: ${JSON.stringify(segment)}`);
  return symbol;
}

/**
 * The public kline stream name Binance serves for `symbol`: the symbol
 * lower-cased, then "@kline_<interval>". For ASCII this is the long-standing
 * form; for a caseless Unicode symbol lower-casing touches only its ASCII part
 * (币安人生USDT -> 币安人生usdt@kline_15m). That exact form was verified on
 * the public routed /market/stream endpoint on 2026-10-05: Binance delivered
 * `stream: "币安人生usdt@kline_15m"` with `s` and `k.s` equal to the exact
 * symbol. The URL carries it percent-encoded as UTF-8 (WHATWG URL rules).
 */
export function klineStreamNameOf(symbol: string, interval: string): string {
  if (!isScannerSymbolShape(symbol)) throw new Error(`not a scanner symbol: ${JSON.stringify(symbol)}`);
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

