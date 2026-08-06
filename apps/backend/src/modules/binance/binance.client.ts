import { createHmac } from "node:crypto";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import {
  BINANCE_READ_ONLY_ENDPOINTS,
  FORBIDDEN_METHODS,
  READ_ONLY_METHOD,
  isAllowedReadOnlyPath,
  type BinanceEndpointName,
} from "./binance.endpoints";
import {
  BinanceError,
  BinanceReadOnlyViolationError,
  classifyBinanceFailure,
  registerBinanceRedactions,
  sanitizeBinanceText,
} from "./binance.errors";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3; // 1 initial + 2 bounded retries
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 4_000;
/** Re-sync the clock at most this often; also re-synced once after a -1021. */
const TIME_SYNC_TTL_MS = 5 * 60 * 1000;

export type QueryValue = string | number | boolean;
export type QueryParams = Record<string, QueryValue | undefined>;

export interface BinanceTimeSync {
  serverTimeMs: number;
  /** serverTime − localTime at the moment of sync (ms). */
  offsetMs: number;
  roundTripMs: number;
  syncedAt: number;
}

/**
 * The transport boundary. Throws BEFORE any network call if a caller ever
 * tries a non-GET method or a path outside the read-only allowlist. Exported
 * so tests can assert the guard directly.
 */
export function assertReadOnlyRequest(path: string, method: string): void {
  if (method !== READ_ONLY_METHOD) {
    throw new BinanceReadOnlyViolationError(
      `Blocked ${method} ${path}: the Binance connector is read-only and may only issue ${READ_ONLY_METHOD} requests`
    );
  }
  if (!isAllowedReadOnlyPath(path)) {
    throw new BinanceReadOnlyViolationError(
      `Blocked ${method} ${path}: path is not in the read-only endpoint allowlist`
    );
  }
}

/**
 * Canonical query string: keys sorted alphabetically, values URL-encoded.
 * Deterministic ordering makes the signature reproducible and testable, and
 * the exact string that is signed is the exact string that is sent.
 */
export function buildCanonicalQuery(params: QueryParams): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

export function signQuery(canonicalQuery: string, apiSecret: string): string {
  return createHmac("sha256", apiSecret).update(canonicalQuery).digest("hex");
}

function backoffDelayMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, 60_000);
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headers: Headers | undefined): number | null {
  const raw = headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

export interface BinanceClientOptions {
  baseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  recvWindowMs?: number;
  enabled?: boolean;
}

/**
 * Read-only Binance USDⓈ-M REST client.
 *
 * There is no `method` parameter anywhere in this class: `request()` hardcodes
 * GET and every call goes through `assertReadOnlyRequest`. It exposes no
 * placeOrder / cancelOrder / changeLeverage / changeMarginType /
 * changePositionMode method, so trading is structurally impossible here.
 */
export class BinanceReadOnlyClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly recvWindowMs: number;
  private readonly enabled: boolean;
  private timeSync: BinanceTimeSync | null = null;

  constructor(options: BinanceClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? env.BINANCE_FUTURES_REST_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? env.BINANCE_API_KEY;
    this.apiSecret = options.apiSecret ?? env.BINANCE_API_SECRET;
    this.recvWindowMs = options.recvWindowMs ?? env.BINANCE_RECV_WINDOW_MS;
    this.enabled = options.enabled ?? env.BINANCE_READ_ONLY_ENABLED;

    registerBinanceRedactions([this.apiKey, this.apiSecret]);
  }

  /** Host only — never credentials — for display in health output. */
  get host(): string {
    try {
      return new URL(this.baseUrl).host;
    } catch {
      return "unknown";
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get clockOffsetMs(): number {
    return this.timeSync?.offsetMs ?? 0;
  }

  get lastTimeSync(): BinanceTimeSync | null {
    return this.timeSync;
  }

  private assertUsable(signed: boolean): void {
    if (!this.enabled) {
      throw new BinanceError({
        kind: "DISABLED",
        message: "Binance read-only connector is disabled (set BINANCE_READ_ONLY_ENABLED=true to enable it)",
      });
    }
    if (signed && (!this.apiKey || !this.apiSecret)) {
      throw new BinanceError({
        kind: "MISSING_CREDENTIALS",
        message: "BINANCE_API_KEY and BINANCE_API_SECRET must both be set for signed read-only calls",
      });
    }
  }

  /**
   * Measures the offset between Binance's clock and ours so signed requests
   * carry a server-aligned timestamp. Uses the public /fapi/v1/time endpoint
   * and accounts for round-trip latency by sampling the local clock on both
   * sides of the call.
   */
  async syncTime(): Promise<BinanceTimeSync> {
    const startedAt = Date.now();
    const payload = await this.request<{ serverTime?: unknown }>("serverTime");
    const finishedAt = Date.now();

    const serverTimeMs = Number(payload?.serverTime);
    if (!Number.isFinite(serverTimeMs)) {
      throw new BinanceError({
        kind: "MALFORMED_RESPONSE",
        message: "Binance server time response did not contain a numeric serverTime",
        endpoint: "serverTime",
      });
    }

    const roundTripMs = finishedAt - startedAt;
    // Compare against the local midpoint of the request window.
    const localMidpoint = startedAt + Math.round(roundTripMs / 2);

    this.timeSync = {
      serverTimeMs,
      offsetMs: serverTimeMs - localMidpoint,
      roundTripMs,
      syncedAt: finishedAt,
    };
    return this.timeSync;
  }

  private async ensureFreshTimeSync(): Promise<void> {
    const stale = !this.timeSync || Date.now() - this.timeSync.syncedAt > TIME_SYNC_TTL_MS;
    if (stale) await this.syncTime();
  }

  /** Server-aligned timestamp for signed requests. */
  private signedTimestamp(): number {
    return Date.now() + this.clockOffsetMs;
  }

  /**
   * Issues one allowlisted GET. Signed endpoints get a canonical query with
   * timestamp + recvWindow, an HMAC-SHA256 signature and the API-key header.
   * Retries are bounded and only apply to retryable kinds (429/5xx/network);
   * auth, permission and validation failures fail fast. A single -1021 gets
   * one clock re-sync and one retry.
   */
  async request<T>(name: BinanceEndpointName, params: QueryParams = {}): Promise<T> {
    const endpoint = BINANCE_READ_ONLY_ENDPOINTS[name];
    this.assertUsable(endpoint.signed);

    if (endpoint.signed) await this.ensureFreshTimeSync();

    let resyncedOnce = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let query = buildCanonicalQuery(params);
      const headers: Record<string, string> = {};

      if (endpoint.signed) {
        const signedParams: QueryParams = {
          ...params,
          recvWindow: this.recvWindowMs,
          timestamp: this.signedTimestamp(),
        };
        query = buildCanonicalQuery(signedParams);
        // The signature covers exactly the string that is transmitted.
        query = `${query}&signature=${signQuery(query, this.apiSecret)}`;
        headers["X-MBX-APIKEY"] = this.apiKey;
      }

      const url = `${this.baseUrl}${endpoint.path}${query ? `?${query}` : ""}`;
      assertReadOnlyRequest(endpoint.path, READ_ONLY_METHOD);

      try {
        const response = await this.dispatch(url, headers);
        const weightUsed = response.headers?.get?.("x-mbx-used-weight-1m") ?? null;

        if (!response.ok) {
          throw await this.toBinanceError(response, name);
        }

        // Never log the URL (it carries the signature) — endpoint name only.
        logger.debug(
          { endpoint: name, status: response.status, weightUsed, attempt },
          "Binance read-only request completed"
        );

        return (await this.parseJson<T>(response, name)) as T;
      } catch (error) {
        const binanceError = this.asBinanceError(error, name);

        // A timestamp rejection is worth exactly one clock re-sync + retry.
        if (binanceError.kind === "TIMESTAMP" && !resyncedOnce) {
          resyncedOnce = true;
          await this.syncTime();
          continue;
        }

        const isLastAttempt = attempt === MAX_ATTEMPTS;
        if (!binanceError.retryable || isLastAttempt) throw binanceError;

        const delay = backoffDelayMs(attempt, binanceError.retryAfterMs);
        logger.warn(
          { endpoint: name, kind: binanceError.kind, attempt, delayMs: delay },
          "Binance read-only request failed — retrying"
        );
        await sleep(delay);
      }
    }

    // Unreachable: the loop either returns or throws.
    throw new BinanceError({ kind: "SERVER", message: "Binance request exhausted retries", endpoint: name });
  }

  private async dispatch(url: string, headers: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { method: READ_ONLY_METHOD, headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parseJson<T>(response: Response, endpoint: BinanceEndpointName): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      throw new BinanceError({
        kind: "MALFORMED_RESPONSE",
        message: "Binance returned a body that is not valid JSON",
        httpStatus: response.status,
        endpoint,
      });
    }
  }

  private async toBinanceError(response: Response, endpoint: BinanceEndpointName): Promise<BinanceError> {
    let code: number | null = null;
    let message = `HTTP ${response.status}`;

    try {
      const body = (await response.json()) as { code?: unknown; msg?: unknown };
      if (typeof body?.code === "number") code = body.code;
      if (typeof body?.msg === "string" && body.msg) message = body.msg;
    } catch {
      // Non-JSON error body (e.g. an HTML WAF page) — keep the status message.
    }

    const kind = classifyBinanceFailure(response.status, code, message);
    return new BinanceError({
      kind,
      // Endpoint NAME, never the signed URL.
      message: `Binance ${endpoint} failed: ${message}`,
      binanceCode: code,
      httpStatus: response.status,
      retryAfterMs: parseRetryAfterMs(response.headers),
      endpoint,
    });
  }

  private asBinanceError(error: unknown, endpoint: BinanceEndpointName): BinanceError {
    if (error instanceof BinanceError) return error;

    const raw = error instanceof Error ? error.message : String(error);
    const aborted = error instanceof Error && error.name === "AbortError";
    return new BinanceError({
      kind: aborted ? "TIMEOUT" : "NETWORK",
      message: aborted
        ? `Binance ${endpoint} timed out after ${REQUEST_TIMEOUT_MS} ms`
        : `Binance ${endpoint} request failed: ${sanitizeBinanceText(raw)}`,
      endpoint,
    });
  }
}

/** Re-exported so callers/tests can assert the guard set without importing internals. */
export { FORBIDDEN_METHODS };
