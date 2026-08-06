import { AppError } from "../../utils/errors";

/**
 * Typed, sanitized Binance failures.
 *
 * Nothing here ever carries an API key, secret, signature or signed query
 * string: messages are built from the endpoint NAME plus Binance's own error
 * code/message, and `sanitizeBinanceText` is applied as a last line of defence
 * in case a credential ever reaches a string we are about to surface.
 */

export type BinanceErrorKind =
  | "DISABLED"
  | "MISSING_CREDENTIALS"
  | "AUTH"
  | "PERMISSION"
  | "IP_RESTRICTED"
  | "FUTURES_NOT_ENABLED"
  | "TIMESTAMP"
  | "RATE_LIMIT"
  | "IP_BANNED"
  | "SERVER"
  | "NETWORK"
  | "TIMEOUT"
  | "MALFORMED_RESPONSE"
  | "UNSUPPORTED_SYMBOL"
  | "READ_ONLY_VIOLATION";

/** Kinds that a bounded retry may help with. Auth/permission/validation never retry. */
const RETRYABLE_KINDS: ReadonlySet<BinanceErrorKind> = new Set<BinanceErrorKind>([
  "RATE_LIMIT",
  "SERVER",
  "NETWORK",
  "TIMEOUT",
]);

export interface BinanceErrorOptions {
  kind: BinanceErrorKind;
  message: string;
  /** Binance's own numeric code (e.g. -1021), when the body carried one. */
  binanceCode?: number | null;
  httpStatus?: number | null;
  /** From a Retry-After header, when present. */
  retryAfterMs?: number | null;
  endpoint?: string | null;
}

export class BinanceError extends AppError {
  readonly kind: BinanceErrorKind;
  readonly binanceCode: number | null;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
  readonly endpoint: string | null;

  constructor(options: BinanceErrorOptions) {
    // 502: a failure talking to an upstream exchange is not the caller's fault.
    super(sanitizeBinanceText(options.message), 502);
    this.name = "BinanceError";
    this.kind = options.kind;
    this.binanceCode = options.binanceCode ?? null;
    this.httpStatus = options.httpStatus ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.endpoint = options.endpoint ?? null;
  }

  get retryable(): boolean {
    return RETRYABLE_KINDS.has(this.kind);
  }
}

/**
 * Attempted use of a non-GET method or a non-allowlisted path. Thrown BEFORE
 * any network dispatch — the connector is structurally incapable of trading.
 */
export class BinanceReadOnlyViolationError extends BinanceError {
  constructor(message: string) {
    super({ kind: "READ_ONLY_VIOLATION", message });
    this.name = "BinanceReadOnlyViolationError";
  }
}

let redactions: string[] = [];

/**
 * Registers credential values that must never appear in surfaced text. Called
 * by the client at construction; kept module-local so nothing has to pass
 * secrets around to sanitize.
 */
export function registerBinanceRedactions(values: Array<string | null | undefined>): void {
  redactions = values.filter((value): value is string => typeof value === "string" && value.length >= 8);
}

/** Redacts registered credentials and any signature=… run from arbitrary text. */
export function sanitizeBinanceText(text: string): string {
  let output = text;
  for (const secret of redactions) {
    output = output.split(secret).join("***REDACTED***");
  }
  return output
    .replace(/signature=[A-Fa-f0-9]+/g, "signature=***REDACTED***")
    .replace(/X-MBX-APIKEY:\s*\S+/gi, "X-MBX-APIKEY: ***REDACTED***");
}

/**
 * Maps a Binance error body / HTTP status onto a typed kind, following the
 * documented error codes:
 *  -1003 too many requests · -1021 timestamp outside recvWindow
 *  -1022 invalid signature · -2014/-2015 bad key, permissions or IP
 *  -1121 invalid symbol   · HTTP 429 rate limit · 418 IP ban · 403 WAF
 */
export function classifyBinanceFailure(
  httpStatus: number,
  binanceCode: number | null,
  binanceMessage: string
): BinanceErrorKind {
  if (binanceCode !== null) {
    switch (binanceCode) {
      case -1003:
        return "RATE_LIMIT";
      case -1021:
        return "TIMESTAMP";
      case -1022:
        return "AUTH";
      case -2014:
        return "AUTH";
      case -2015:
        // One code covers "invalid key", "IP not allowed" and "no permission";
        // the message distinguishes them.
        if (/ip/i.test(binanceMessage)) return "IP_RESTRICTED";
        if (/permission/i.test(binanceMessage)) return "PERMISSION";
        return "AUTH";
      case -1121:
        return "UNSUPPORTED_SYMBOL";
      case -1000:
      case -1001:
        return "SERVER";
      default:
        break;
    }
    if (/futures/i.test(binanceMessage) && /not.*(enabled|open|allow)/i.test(binanceMessage)) {
      return "FUTURES_NOT_ENABLED";
    }
  }

  if (httpStatus === 429) return "RATE_LIMIT";
  if (httpStatus === 418) return "IP_BANNED";
  if (httpStatus === 403) return "PERMISSION";
  if (httpStatus === 401) return "AUTH";
  if (httpStatus >= 500) return "SERVER";
  return "MALFORMED_RESPONSE";
}
