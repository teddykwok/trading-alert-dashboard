import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { BinanceReadOnlyClient, buildCanonicalQuery, signQuery, type QueryParams } from "./binance.client";
import {
  ALLOWED_ENTRY_ORDER_TYPE,
  ALLOWED_ENTRY_TIME_IN_FORCE,
  BINANCE_MUTATION_ENDPOINTS,
  FORBIDDEN_ENTRY_PARAMS,
  isAllowedMutation,
  type BinanceMutationEndpointName,
} from "./binance-execution.endpoints";
import { BinanceError, classifyBinanceFailure, registerBinanceRedactions, sanitizeBinanceText } from "./binance.errors";
// Pure helper (no Prisma, no I/O): lets the cancellation context prove that a
// client order id really belongs to the named execution's ENTRY reservation.
import { buildClientOrderId } from "../execution/execution-safety";

/**
 * Phase 6 — narrowly scoped Binance USDⓈ-M MUTATION client.
 *
 * Deliberately a SEPARATE class from the Phase 2 read-only client, which stays
 * structurally GET-only. This one can issue exactly four documented
 * (method, path) pairs and nothing else; there is no public generic signed
 * request method, so an arbitrary mutation cannot be expressed.
 *
 * It reuses the Phase 2 signer, credential handling, server-clock offset,
 * recvWindow, canonicalization, timeout handling and sanitized error shape via
 * the injected read-only client.
 *
 * ## Operation-aware authorization
 *
 * The two mutation classes have opposite risk profiles, so a single global
 * "everything needs the entry gates" check is wrong:
 *
 * - EXPOSURE_OR_CONFIGURATION (marginType, leverage, new order) INCREASES or
 *   configures exposure. Both EXECUTION_LIVE_ENTRY_ENABLED and
 *   EXECUTION_PROTECTION_READY must be true.
 * - RISK_REDUCING_RECOVERY (cancel) REDUCES exposure. Gating it would trap a
 *   pending entry: disabling live entry the moment an order is resting on the
 *   book would remove our ability to cancel the unfilled remainder at TTL.
 *   Turning the gates off must stop NEW exposure, not prevent risk reduction.
 *
 * Authorization is carried by branded context objects that only this module
 * can mint — there is no `bypassSafety` boolean, and the cancellation context
 * is bound to one specific already-reserved ENTRY order.
 */

const REQUEST_TIMEOUT_MS = 10_000;
/** Mutations are NEVER blind-retried: an ambiguous result is reconciled instead. */
const MAX_ATTEMPTS = 1;

export type MutationTransport = (url: string, init: RequestInit) => Promise<Response>;

/** Attempted mutation outside the four-pair allowlist. Thrown BEFORE dispatch. */
export class BinanceMutationViolationError extends BinanceError {
  constructor(message: string) {
    super({ kind: "READ_ONLY_VIOLATION", message });
    this.name = "BinanceMutationViolationError";
  }
}

/** Either live gate is false. Thrown BEFORE dispatch; zero network traffic. */
export class BinanceLiveEntryDisabledError extends BinanceError {
  readonly reasonCode: "LIVE_ENTRY_DISABLED" | "PROTECTION_NOT_READY";

  constructor(reasonCode: "LIVE_ENTRY_DISABLED" | "PROTECTION_NOT_READY") {
    super({
      kind: "DISABLED",
      message:
        reasonCode === "LIVE_ENTRY_DISABLED"
          ? "Live entry submission is disabled (EXECUTION_LIVE_ENTRY_ENABLED is false)"
          : "Protection is not ready (EXECUTION_PROTECTION_READY is false); no real entry may be placed",
    });
    this.name = "BinanceLiveEntryDisabledError";
    this.reasonCode = reasonCode;
  }
}

export interface BinanceExecutionClientOptions {
  readOnlyClient?: BinanceReadOnlyClient;
  baseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  recvWindowMs?: number;
  liveEntryEnabled?: boolean;
  protectionReady?: boolean;
  /** Injected in tests. The default is global fetch. */
  transport?: MutationTransport;
}

export interface AcknowledgedOrderDto {
  orderId: string | null;
  clientOrderId: string | null;
  symbol: string | null;
  status: string | null;
}

export interface LeverageChangeDto {
  leverage: number | null;
  maxNotionalValue: string | null;
  symbol: string | null;
}

/**
 * Module-private brand. Because this symbol is never exported, no caller
 * outside this file can construct a conforming authorization object — the
 * factories below are the only way in.
 */
const AUTHORIZATION_BRAND = Symbol("binance-mutation-authorization");

/** Proof that both live-entry gates were open. Required for every POST. */
export interface LiveEntryAuthorization {
  readonly [AUTHORIZATION_BRAND]: "LIVE_ENTRY";
}

/**
 * Permission to cancel ONE specific, already-reserved ENTRY order. It carries
 * the symbol and client order id itself, so the caller cannot substitute an
 * arbitrary symbol, client order id, exchange order id, role, generation or
 * external order after the context has been issued.
 */
export interface EntryCancellationContext {
  readonly [AUTHORIZATION_BRAND]: "ENTRY_CANCELLATION";
  readonly symbol: string;
  readonly clientOrderId: string;
  readonly executionId: string;
  readonly reason: EntryCancellationReason;
}

export type EntryCancellationReason = "TTL_DUE" | "OPERATOR_RECOVERY";

export interface AuthorizeEntryCancellationInput {
  executionId: string;
  symbol: string;
  /** Must equal the deterministic id for (executionId, ENTRY, 1). */
  clientOrderId: string;
  role: string;
  generation: number;
  reason: EntryCancellationReason;
}

export interface SubmitLimitEntryInput {
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  /** Exact frozen decimal string — never re-rounded here. */
  quantity: string;
  price: string;
  newClientOrderId: string;
}

/**
 * The four approved mutations, exposed as typed methods. Queries deliberately
 * live on the GET-only client.
 */
export class BinanceUsdMExecutionClient {
  private readonly readOnly: BinanceReadOnlyClient;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly recvWindowMs: number;
  private readonly liveEntryEnabled: boolean;
  private readonly protectionReady: boolean;
  private readonly transport: MutationTransport;
  /** Incremented on every real dispatch so tests can assert zero traffic. */
  private dispatchCount = 0;

  constructor(options: BinanceExecutionClientOptions = {}) {
    this.readOnly = options.readOnlyClient ?? new BinanceReadOnlyClient();
    this.baseUrl = (options.baseUrl ?? env.BINANCE_FUTURES_REST_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? env.BINANCE_API_KEY;
    this.apiSecret = options.apiSecret ?? env.BINANCE_API_SECRET;
    this.recvWindowMs = options.recvWindowMs ?? env.BINANCE_RECV_WINDOW_MS;
    this.liveEntryEnabled = options.liveEntryEnabled ?? env.EXECUTION_LIVE_ENTRY_ENABLED;
    this.protectionReady = options.protectionReady ?? env.EXECUTION_PROTECTION_READY;
    this.transport = options.transport ?? ((url, init) => fetch(url, init));

    registerBinanceRedactions([this.apiKey, this.apiSecret]);
  }

  get mutationsDispatched(): number {
    return this.dispatchCount;
  }

  /** True only when BOTH gates are open. */
  get isLiveMutationAllowed(): boolean {
    return this.liveEntryEnabled && this.protectionReady;
  }

  /** The blocking gate, or null when mutations are permitted. */
  get blockedReason(): "LIVE_ENTRY_DISABLED" | "PROTECTION_NOT_READY" | null {
    if (!this.liveEntryEnabled) return "LIVE_ENTRY_DISABLED";
    if (!this.protectionReady) return "PROTECTION_NOT_READY";
    return null;
  }

  // -------------------------------------------------------------------------
  // Authorization factories — the only way to obtain a mutation context
  // -------------------------------------------------------------------------

  /**
   * Issues proof that both live-entry gates are open. Throws (dispatching
   * nothing) when either is closed, so an exposure-increasing POST is
   * impossible without it.
   */
  authorizeLiveEntry(): LiveEntryAuthorization {
    const blocked = this.blockedReason;
    if (blocked) throw new BinanceLiveEntryDisabledError(blocked);
    return { [AUTHORIZATION_BRAND]: "LIVE_ENTRY" };
  }

  /**
   * Issues permission to cancel one already-reserved ENTRY order.
   *
   * Deliberately NOT gated on the live-entry switches: this is the risk
   * REDUCING direction, and a resting order must stay cancellable at TTL even
   * after the gates are turned off. The narrowing is structural instead — the
   * request must name ENTRY generation 1 and carry exactly the deterministic
   * client order id derived from that execution, so an arbitrary or external
   * order cannot be addressed.
   */
  authorizeEntryCancellation(input: AuthorizeEntryCancellationInput): EntryCancellationContext {
    if (input.role !== "ENTRY") {
      throw new BinanceMutationViolationError("Only an ENTRY order may be cancelled by the entry lifecycle.");
    }
    if (input.generation !== 1) {
      throw new BinanceMutationViolationError("Only ENTRY generation 1 may be cancelled by the entry lifecycle.");
    }
    if (!input.executionId || !input.symbol) {
      throw new BinanceMutationViolationError("A cancellation context requires a persisted execution and symbol.");
    }
    const expected = buildClientOrderId(input.executionId, "ENTRY", 1);
    if (input.clientOrderId !== expected) {
      // Proves the id belongs to this execution's own reservation rather than
      // being supplied by the caller.
      throw new BinanceMutationViolationError(
        "The client order id does not match this execution's reserved ENTRY order."
      );
    }
    if (input.reason !== "TTL_DUE" && input.reason !== "OPERATOR_RECOVERY") {
      throw new BinanceMutationViolationError("A cancellation context requires an explicit recovery reason.");
    }

    return {
      [AUTHORIZATION_BRAND]: "ENTRY_CANCELLATION",
      symbol: input.symbol.trim().toUpperCase(),
      clientOrderId: input.clientOrderId,
      executionId: input.executionId,
      reason: input.reason,
    };
  }

  // -------------------------------------------------------------------------
  // The four approved mutations
  // -------------------------------------------------------------------------

  /** POST /fapi/v1/marginType — ISOLATED only; CROSSED is not expressible. */
  async setIsolatedMarginType(
    authorization: LiveEntryAuthorization,
    symbol: string
  ): Promise<{ code: number | null; msg: string | null }> {
    this.assertLiveEntryAuthorization(authorization);
    return this.mutate("setMarginType", { symbol: symbol.trim().toUpperCase(), marginType: "ISOLATED" });
  }

  /** POST /fapi/v1/leverage — sends the exact integer it is given. */
  async setInitialLeverage(
    authorization: LiveEntryAuthorization,
    symbol: string,
    leverage: number
  ): Promise<LeverageChangeDto> {
    this.assertLiveEntryAuthorization(authorization);
    if (!Number.isSafeInteger(leverage) || leverage < 1) {
      throw new BinanceMutationViolationError("Leverage must be a positive integer; no clamping is performed.");
    }
    const payload = await this.mutate<Record<string, unknown>>("setLeverage", {
      symbol: symbol.trim().toUpperCase(),
      leverage,
    });
    return {
      leverage: typeof payload?.leverage === "number" ? payload.leverage : null,
      maxNotionalValue:
        typeof payload?.maxNotionalValue === "string" || typeof payload?.maxNotionalValue === "number"
          ? String(payload.maxNotionalValue)
          : null,
      symbol: typeof payload?.symbol === "string" ? payload.symbol : null,
    };
  }

  /**
   * POST /fapi/v1/order — one plain LIMIT/GTC entry, ACK response.
   *
   * The order TYPE is allowlisted separately from the path, so a protection or
   * MARKET order cannot be smuggled through this method, and every parameter
   * that belongs to a non-entry order is explicitly absent.
   */
  async submitLimitEntry(
    authorization: LiveEntryAuthorization,
    input: SubmitLimitEntryInput
  ): Promise<AcknowledgedOrderDto> {
    this.assertLiveEntryAuthorization(authorization);
    const params: QueryParams = {
      symbol: input.symbol.trim().toUpperCase(),
      side: input.side,
      positionSide: input.positionSide,
      type: ALLOWED_ENTRY_ORDER_TYPE,
      timeInForce: ALLOWED_ENTRY_TIME_IN_FORCE,
      // Exact frozen decimal strings — no Number(), no rounding, no re-format.
      quantity: input.quantity,
      price: input.price,
      newClientOrderId: input.newClientOrderId,
      newOrderRespType: "ACK",
    };

    for (const forbidden of FORBIDDEN_ENTRY_PARAMS) {
      if (forbidden in params) {
        throw new BinanceMutationViolationError(`Parameter "${forbidden}" is not permitted on a Phase 6 entry.`);
      }
    }

    const payload = await this.mutate<Record<string, unknown>>("newOrder", params);
    return {
      orderId: payload?.orderId === undefined || payload?.orderId === null ? null : String(payload.orderId),
      clientOrderId: typeof payload?.clientOrderId === "string" ? payload.clientOrderId : null,
      symbol: typeof payload?.symbol === "string" ? payload.symbol : null,
      status: typeof payload?.status === "string" ? payload.status : null,
    };
  }

  /**
   * DELETE /fapi/v1/order — cancels the reserved ENTRY order by its own
   * deterministic client id.
   *
   * There is deliberately no generic ungated cancel: the symbol and client
   * order id come from the context, never from the call site, so this cannot
   * be pointed at an arbitrary or external order. Cancelling a partially
   * filled order removes only the unfilled remainder — Binance never closes
   * the filled portion, and no opposite order is ever submitted.
   */
  async cancelReservedEntryOrder(context: EntryCancellationContext): Promise<AcknowledgedOrderDto> {
    if (context?.[AUTHORIZATION_BRAND] !== "ENTRY_CANCELLATION") {
      throw new BinanceMutationViolationError(
        "Cancellation requires a service-issued entry cancellation context."
      );
    }
    const payload = await this.mutate<Record<string, unknown>>("cancelOrder", {
      symbol: context.symbol,
      origClientOrderId: context.clientOrderId,
    });
    return {
      orderId: payload?.orderId === undefined || payload?.orderId === null ? null : String(payload.orderId),
      clientOrderId: typeof payload?.clientOrderId === "string" ? payload.clientOrderId : null,
      symbol: typeof payload?.symbol === "string" ? payload.symbol : null,
      status: typeof payload?.status === "string" ? payload.status : null,
    };
  }

  // -------------------------------------------------------------------------
  // Internals — private on purpose: no generic signed mutation is reachable.
  // -------------------------------------------------------------------------

  /**
   * Re-checked on EVERY exposure-increasing call, not just when the context
   * was minted: the gates may have been switched off in between.
   */
  private assertLiveEntryAuthorization(authorization: LiveEntryAuthorization): void {
    if (authorization?.[AUTHORIZATION_BRAND] !== "LIVE_ENTRY") {
      throw new BinanceMutationViolationError(
        "This operation requires a service-issued live-entry authorization."
      );
    }
    const blocked = this.blockedReason;
    if (blocked) throw new BinanceLiveEntryDisabledError(blocked);
  }

  private assertCredentials(): void {
    if (!this.apiKey || !this.apiSecret) {
      throw new BinanceError({
        kind: "MISSING_CREDENTIALS",
        message: "BINANCE_API_KEY and BINANCE_API_SECRET must both be set for signed mutations",
      });
    }
  }

  private async mutate<T>(name: BinanceMutationEndpointName, params: QueryParams): Promise<T> {
    const endpoint = BINANCE_MUTATION_ENDPOINTS[name];

    // Authorization has already been proven by the caller's context; only
    // credentials remain to check before any network traffic.
    this.assertCredentials();

    // Then the structural allowlist, still before any dispatch.
    if (!isAllowedMutation(endpoint.method, endpoint.path)) {
      throw new BinanceMutationViolationError(
        `Blocked ${endpoint.method} ${endpoint.path}: not in the Phase 6 mutation allowlist`
      );
    }

    // Server-aligned timestamp via the Phase 2 clock offset.
    await this.readOnly.syncTime().catch(() => undefined);
    const timestamp = Date.now() + this.readOnly.clockOffsetMs;

    const canonical = buildCanonicalQuery({ ...params, recvWindow: this.recvWindowMs, timestamp });
    // The signature covers exactly the string that is transmitted.
    const query = `${canonical}&signature=${signQuery(canonical, this.apiSecret)}`;
    const url = `${this.baseUrl}${endpoint.path}?${query}`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.dispatch(url, endpoint.method);
        if (!response.ok) throw await this.toBinanceError(response, name);

        // Endpoint NAME only — the URL carries the signature.
        logger.debug({ endpoint: name, status: response.status, attempt }, "Binance mutation completed");
        return (await this.parseJson<T>(response, name)) as T;
      } catch (error) {
        throw this.asBinanceError(error, name);
      }
    }

    throw new BinanceError({ kind: "SERVER", message: "Binance mutation exhausted attempts", endpoint: name });
  }

  private async dispatch(url: string, method: "POST" | "DELETE"): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    this.dispatchCount += 1;
    try {
      return await this.transport(url, {
        method,
        headers: { "X-MBX-APIKEY": this.apiKey },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parseJson<T>(response: Response, endpoint: BinanceMutationEndpointName): Promise<T> {
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

  private async toBinanceError(response: Response, endpoint: BinanceMutationEndpointName): Promise<BinanceError> {
    let code: number | null = null;
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { code?: unknown; msg?: unknown };
      if (typeof body?.code === "number") code = body.code;
      if (typeof body?.msg === "string" && body.msg) message = body.msg;
    } catch {
      // Non-JSON error body — keep the status message.
    }

    return new BinanceError({
      kind: classifyBinanceFailure(response.status, code, message),
      message: `Binance ${endpoint} failed: ${message}`,
      binanceCode: code,
      httpStatus: response.status,
      endpoint,
    });
  }

  private asBinanceError(error: unknown, endpoint: BinanceMutationEndpointName): BinanceError {
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
