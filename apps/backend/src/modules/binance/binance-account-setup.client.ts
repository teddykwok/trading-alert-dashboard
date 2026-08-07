import { createHash } from "node:crypto";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { BinanceReadOnlyClient, buildCanonicalQuery, signQuery, type QueryParams } from "./binance.client";
import {
  ALLOWED_POSITION_MODE_PARAM,
  ALLOWED_TEST_ORDER_TIME_IN_FORCE,
  ALLOWED_TEST_ORDER_TYPE,
  BINANCE_ACCOUNT_SETUP_ENDPOINTS,
  TEST_ORDER_CLIENT_ID_PREFIX,
  isAllowedAccountSetupMutation,
  type BinanceAccountSetupEndpointName,
} from "./binance-account-setup.endpoints";
import { BinanceError, classifyBinanceFailure, registerBinanceRedactions, sanitizeBinanceText } from "./binance.errors";

/**
 * Phase 10 — narrowly scoped Binance USDⓈ-M OPERATOR MAINTENANCE client.
 *
 * A third client, separate from the Phase 2 read-only connector (which stays
 * structurally GET-only) and from the Phase 6/7 execution mutation client
 * (which cannot express these two operations). It can issue exactly two
 * documented (method, path) pairs and nothing else; there is no public generic
 * signed request method here either.
 *
 * ## What it can do
 *
 *  - POST /fapi/v1/positionSide/dual with dualSidePosition="true" — HEDGE ONLY.
 *    There is no constant, parameter or method anywhere in this file that can
 *    produce "false", so switching an account to One-way is not something this
 *    codebase can express.
 *  - POST /fapi/v1/order/test — Binance's NON-MATCHING validation endpoint. It
 *    never reaches the order book, so it cannot create, fill or rest an order.
 *
 * ## What it deliberately cannot do
 *
 * It has no access to POST /fapi/v1/order. The two endpoint names are separate
 * entries in a separate table, and `submitUsdMFuturesTestOrder` names the
 * `testOrder` entry directly — there is no branch, fallback or retry path that
 * can reach the real order endpoint, including on timeout.
 *
 * ## Authorization
 *
 * Both operations require a module-private branded context. The brand symbol is
 * never exported, so no caller outside this file can fabricate one; the two
 * factories are the only way in, and each performs its own gate check first.
 * There is no `bypassSafety` boolean and no generic "authorize anything" token.
 */

const REQUEST_TIMEOUT_MS = 10_000;

export type AccountSetupTransport = (url: string, init: RequestInit) => Promise<Response>;

/** Attempted mutation outside the two-pair allowlist. Thrown BEFORE dispatch. */
export class BinanceAccountSetupViolationError extends BinanceError {
  constructor(message: string) {
    super({ kind: "READ_ONLY_VIOLATION", message });
    this.name = "BinanceAccountSetupViolationError";
  }
}

/** The relevant Phase 10 gate is closed. Thrown BEFORE dispatch; zero traffic. */
export class BinanceAccountSetupDisabledError extends BinanceError {
  readonly reasonCode: "ACCOUNT_SETUP_MUTATIONS_DISABLED" | "TEST_ORDER_DISABLED";

  constructor(reasonCode: "ACCOUNT_SETUP_MUTATIONS_DISABLED" | "TEST_ORDER_DISABLED") {
    super({
      kind: "DISABLED",
      message:
        reasonCode === "ACCOUNT_SETUP_MUTATIONS_DISABLED"
          ? "Account-setup mutations are disabled (BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED is false)"
          : "Test orders are disabled (BINANCE_TEST_ORDER_ENABLED is false)",
    });
    this.name = "BinanceAccountSetupDisabledError";
    this.reasonCode = reasonCode;
  }
}

/** Module-private brand — never exported, so a context cannot be forged. */
const SETUP_BRAND = Symbol("binance-account-setup-authorization");

/**
 * Proof that the account-wide preflight passed: the gate is open, the account
 * currently holds no position and no open order, and the observed mode is
 * ONE_WAY. The counts are carried on the context so the client can re-assert
 * what was actually proven rather than trusting the caller's word.
 */
export interface HedgeModeAuthorization {
  readonly [SETUP_BRAND]: "SET_HEDGE_MODE";
  readonly observedPositionMode: "ONE_WAY";
  readonly nonZeroPositionCount: 0;
  readonly openOrderCount: 0;
}

export interface AuthorizeHedgeModeInput {
  /** The mode read from Binance immediately before authorizing. */
  observedPositionMode: string | null;
  nonZeroPositionCount: number;
  openOrderCount: number;
}

/** Proof that the test-order gate is open and the request was operator-driven. */
export interface TestOrderAuthorization {
  readonly [SETUP_BRAND]: "TEST_ORDER";
  readonly symbol: string;
  readonly side: "BUY" | "SELL";
  readonly positionSide: "LONG" | "SHORT";
  readonly quantity: string;
  readonly price: string;
  readonly clientOrderId: string;
}

export interface AuthorizeTestOrderInput {
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  /** Exact decimal strings, already validated against the symbol's filters. */
  quantity: string;
  price: string;
}

export interface BinanceAccountSetupClientOptions {
  readOnlyClient?: BinanceReadOnlyClient;
  baseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  recvWindowMs?: number;
  accountSetupMutationsEnabled?: boolean;
  testOrderEnabled?: boolean;
  /** Injected in tests. The default is global fetch. */
  transport?: AccountSetupTransport;
}

/**
 * A deterministic, non-identifying client id for a validation request.
 *
 * Namespaced `tadtest-*`, which cannot collide with the live `tad-<role>-*`
 * ids Phase 6/7 reserve, and derived from the request itself rather than from
 * any persisted execution — a Phase 10 request never borrows a real trade's
 * reserved id. Binance documents the format as
 * `^[\.A-Z\:/a-z0-9_-]{1,36}$`.
 */
export function buildTestOrderClientId(symbol: string, positionSide: string, quantity: string, price: string): string {
  const digest = createHash("sha256")
    .update(`${symbol}:${positionSide}:${quantity}:${price}`)
    .digest("hex")
    .slice(0, 16);
  return `${TEST_ORDER_CLIENT_ID_PREFIX}-${digest}`;
}

export class BinanceAccountSetupClient {
  private readonly readOnly: BinanceReadOnlyClient;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly recvWindowMs: number;
  private readonly accountSetupMutationsEnabled: boolean;
  private readonly testOrderEnabled: boolean;
  private readonly transport: AccountSetupTransport;
  /** Incremented on every real dispatch so tests can assert zero traffic. */
  private dispatchCount = 0;

  constructor(options: BinanceAccountSetupClientOptions = {}) {
    this.readOnly = options.readOnlyClient ?? new BinanceReadOnlyClient();
    this.baseUrl = (options.baseUrl ?? env.BINANCE_FUTURES_REST_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? env.BINANCE_API_KEY;
    this.apiSecret = options.apiSecret ?? env.BINANCE_API_SECRET;
    this.recvWindowMs = options.recvWindowMs ?? env.BINANCE_RECV_WINDOW_MS;
    this.accountSetupMutationsEnabled =
      options.accountSetupMutationsEnabled ?? env.BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED;
    this.testOrderEnabled = options.testOrderEnabled ?? env.BINANCE_TEST_ORDER_ENABLED;
    this.transport = options.transport ?? ((url, init) => fetch(url, init));

    registerBinanceRedactions([this.apiKey, this.apiSecret]);
  }

  get mutationsDispatched(): number {
    return this.dispatchCount;
  }

  // -------------------------------------------------------------------------
  // Authorization factories — the only way to obtain a context
  // -------------------------------------------------------------------------

  /**
   * Issues permission for ONE hedge-mode change.
   *
   * Refuses (dispatching nothing) unless the gate is open, the account is
   * currently ONE_WAY, and BOTH account-wide counts are exactly zero. An
   * already-HEDGE account never reaches this factory — the caller returns
   * ALREADY_HEDGE without asking for authorization at all.
   */
  authorizeHedgeMode(input: AuthorizeHedgeModeInput): HedgeModeAuthorization {
    if (!this.accountSetupMutationsEnabled) {
      throw new BinanceAccountSetupDisabledError("ACCOUNT_SETUP_MUTATIONS_DISABLED");
    }
    if (input.observedPositionMode !== "ONE_WAY") {
      throw new BinanceAccountSetupViolationError(
        "Hedge-mode authorization requires a freshly observed ONE_WAY position mode."
      );
    }
    if (input.nonZeroPositionCount !== 0) {
      throw new BinanceAccountSetupViolationError(
        "Hedge-mode authorization requires zero non-zero positions across the whole USDⓈ-M account."
      );
    }
    if (input.openOrderCount !== 0) {
      throw new BinanceAccountSetupViolationError(
        "Hedge-mode authorization requires zero open orders across the whole USDⓈ-M account."
      );
    }
    return {
      [SETUP_BRAND]: "SET_HEDGE_MODE",
      observedPositionMode: "ONE_WAY",
      nonZeroPositionCount: 0,
      openOrderCount: 0,
    };
  }

  /**
   * Issues permission for ONE test-order validation. The client id is derived
   * here rather than accepted from the caller, so a real execution's reserved
   * id can never be smuggled onto a validation request.
   */
  authorizeTestOrder(input: AuthorizeTestOrderInput): TestOrderAuthorization {
    if (!this.testOrderEnabled) throw new BinanceAccountSetupDisabledError("TEST_ORDER_DISABLED");

    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol) throw new BinanceAccountSetupViolationError("A test order requires a symbol.");
    // Hedge mode requires positionSide, and the pairing is fixed: a validation
    // request must describe an opening trade, never a reducing one.
    if (input.positionSide === "LONG" && input.side !== "BUY") {
      throw new BinanceAccountSetupViolationError("A LONG test order must use side BUY.");
    }
    if (input.positionSide === "SHORT" && input.side !== "SELL") {
      throw new BinanceAccountSetupViolationError("A SHORT test order must use side SELL.");
    }
    if (!isPositiveDecimal(input.quantity)) {
      throw new BinanceAccountSetupViolationError("A test order requires a positive decimal quantity string.");
    }
    if (!isPositiveDecimal(input.price)) {
      throw new BinanceAccountSetupViolationError("A test order requires a positive decimal price string.");
    }

    return {
      [SETUP_BRAND]: "TEST_ORDER",
      symbol,
      side: input.side,
      positionSide: input.positionSide,
      quantity: input.quantity,
      price: input.price,
      clientOrderId: buildTestOrderClientId(symbol, input.positionSide, input.quantity, input.price),
    };
  }

  // -------------------------------------------------------------------------
  // The two approved operations
  // -------------------------------------------------------------------------

  /**
   * POST /fapi/v1/positionSide/dual with dualSidePosition="true".
   *
   * The parameter is hardcoded to the HEDGE constant: this method takes no mode
   * argument, so requesting One-way is not expressible.
   *
   * The caller must still VERIFY the result with a fresh GET — a success
   * response is never taken as proof, and neither is a timeout taken as proof
   * of failure.
   */
  async setHedgeMode(context: HedgeModeAuthorization): Promise<{ code: number | null; msg: string | null }> {
    if (context?.[SETUP_BRAND] !== "SET_HEDGE_MODE") {
      throw new BinanceAccountSetupViolationError("Setting hedge mode requires a service-issued authorization.");
    }
    // Re-checked at dispatch time, not only when the context was minted.
    if (!this.accountSetupMutationsEnabled) {
      throw new BinanceAccountSetupDisabledError("ACCOUNT_SETUP_MUTATIONS_DISABLED");
    }
    return this.mutate("setPositionMode", { dualSidePosition: ALLOWED_POSITION_MODE_PARAM });
  }

  /**
   * POST /fapi/v1/order/test — validation only.
   *
   * LIMIT + GTC are hardcoded constants, `positionSide` is mandatory (hedge
   * mode), and every forbidden parameter is simply absent from the payload
   * rather than being conditionally omitted. There is no code path from here to
   * POST /fapi/v1/order.
   */
  async submitUsdMFuturesTestOrder(context: TestOrderAuthorization): Promise<Record<string, unknown>> {
    if (context?.[SETUP_BRAND] !== "TEST_ORDER") {
      throw new BinanceAccountSetupViolationError("A test order requires a service-issued authorization.");
    }
    if (!this.testOrderEnabled) throw new BinanceAccountSetupDisabledError("TEST_ORDER_DISABLED");

    return this.mutate<Record<string, unknown>>("testOrder", {
      symbol: context.symbol,
      side: context.side,
      positionSide: context.positionSide,
      type: ALLOWED_TEST_ORDER_TYPE,
      timeInForce: ALLOWED_TEST_ORDER_TIME_IN_FORCE,
      quantity: context.quantity,
      price: context.price,
      newClientOrderId: context.clientOrderId,
      // Deliberately absent: reduceOnly, closePosition, stopPrice,
      // activationPrice, callbackRate, priceMatch, goodTillDate, workingType,
      // priceProtect, selfTradePreventionMode.
    });
  }

  // -------------------------------------------------------------------------
  // Internals — private on purpose: no generic signed mutation is reachable.
  // -------------------------------------------------------------------------

  private assertCredentials(): void {
    if (!this.apiKey || !this.apiSecret) {
      throw new BinanceError({
        kind: "MISSING_CREDENTIALS",
        message: "BINANCE_API_KEY and BINANCE_API_SECRET must both be set for signed maintenance requests",
      });
    }
  }

  private async mutate<T>(name: BinanceAccountSetupEndpointName, params: QueryParams): Promise<T> {
    const endpoint = BINANCE_ACCOUNT_SETUP_ENDPOINTS[name];

    this.assertCredentials();

    // Structural allowlist, still before any dispatch.
    if (!isAllowedAccountSetupMutation(endpoint.method, endpoint.path)) {
      throw new BinanceAccountSetupViolationError(
        `Blocked ${endpoint.method} ${endpoint.path}: not in the Phase 10 maintenance allowlist`
      );
    }

    // Server-aligned timestamp via the Phase 2 clock offset.
    await this.readOnly.syncTime().catch(() => undefined);
    const timestamp = Date.now() + this.readOnly.clockOffsetMs;

    const canonical = buildCanonicalQuery({ ...params, recvWindow: this.recvWindowMs, timestamp });
    const query = `${canonical}&signature=${signQuery(canonical, this.apiSecret)}`;
    const url = `${this.baseUrl}${endpoint.path}?${query}`;

    try {
      const response = await this.dispatch(url, endpoint.method);
      if (!response.ok) throw await this.toBinanceError(response, name);

      // Endpoint NAME only — the URL carries the signature and must never be
      // logged.
      logger.debug({ endpoint: name, status: response.status }, "Binance maintenance request completed");
      return await this.parseJson<T>(response, name);
    } catch (error) {
      throw this.asBinanceError(error, name);
    }
  }

  private async dispatch(url: string, method: "POST"): Promise<Response> {
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

  private async parseJson<T>(response: Response, endpoint: BinanceAccountSetupEndpointName): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      // POST /fapi/v1/order/test documents an empty object on success; some
      // gateways return an empty body. Neither is an error.
      return {} as T;
    }
  }

  private async toBinanceError(
    response: Response,
    endpoint: BinanceAccountSetupEndpointName
  ): Promise<BinanceError> {
    let code: number | null = null;
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { code?: unknown; msg?: unknown };
      if (typeof body?.code === "number") code = body.code;
      // Only the documented `msg` string is kept — never the whole body, which
      // can echo the signed request back.
      if (typeof body?.msg === "string" && body.msg) message = sanitizeBinanceText(body.msg);
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

  private asBinanceError(error: unknown, endpoint: BinanceAccountSetupEndpointName): BinanceError {
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

/** Plain positive decimal literal — no float parsing, no exponent form. */
function isPositiveDecimal(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(String(value).trim()) && /[1-9]/.test(String(value));
}
