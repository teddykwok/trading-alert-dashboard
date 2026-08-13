import { buildCanonicalQuery, signQuery, type QueryParams } from "../binance.client";
import { classifyBinanceFailure, type BinanceErrorKind } from "../binance.errors";
import { BINANCE_TESTNET_ORIGIN } from "./testnet-config";

/**
 * TESTNET-ONLY signed requests in the DOCUMENTED parameter form.
 *
 * The current official Query Algo Order / Cancel Algo Order pages list only
 * `algoId` | `clientAlgoId` | `recvWindow` | `timestamp`, with the rule
 * "Either algoId or clientAlgoId must be sent." They do NOT list `symbol` —
 * which the production read-only service and the production cancel both send.
 *
 * This module exists to make that difference OBSERVABLE rather than to fix it.
 * It is confined to the verifier directory, it re-asserts the demo origin
 * before every dispatch, and nothing in the production execution path imports
 * it. It must never be promoted into the lifecycle without evidence.
 */

export type DocumentedFormOutcome =
  /** HTTP 2xx. */
  | "ACCEPTED"
  /** The exchange answered definitively — including a documented -2013. */
  | "REJECTED"
  /** Transport/server noise: nothing was established. */
  | "AMBIGUOUS";

export interface DocumentedFormResult {
  readonly outcome: DocumentedFormOutcome;
  readonly httpStatus: number | null;
  readonly binanceCode: number | null;
  readonly kind: BinanceErrorKind | null;
  /** Parsed JSON body on success. Never a raw error payload. */
  readonly payload: Record<string, unknown> | null;
}

/** Injected in tests. The default is global fetch, used only by the CLI. */
export type VerifierTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface DocumentedFormClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly recvWindowMs: number;
  readonly transport: VerifierTransport;
  /** Server-aligned clock offset, supplied by the caller's read-only client. */
  readonly clockOffsetMs: () => number;
}

const REQUEST_TIMEOUT_MS = 10_000;
const ALGO_ORDER_PATH = "/fapi/v1/algoOrder";

export class DocumentedFormClient {
  private dispatchCount = 0;

  constructor(private readonly options: DocumentedFormClientOptions) {
    // Belt and braces: the caller has already validated the origin, but this
    // class can sign and dispatch, so it re-checks rather than trusting.
    if (options.baseUrl !== BINANCE_TESTNET_ORIGIN) {
      throw new Error(`DocumentedFormClient refuses any origin other than ${BINANCE_TESTNET_ORIGIN}.`);
    }
  }

  get dispatched(): number {
    return this.dispatchCount;
  }

  /** GET /fapi/v1/algoOrder — clientAlgoId only, exactly as documented. */
  async queryByClientAlgoId(clientAlgoId: string): Promise<DocumentedFormResult> {
    return this.send("GET", { clientAlgoId });
  }

  /**
   * DELETE /fapi/v1/algoOrder — clientAlgoId only, exactly as documented.
   *
   * The RESCUE path. Reachable only after the production cancel form has been
   * DEFINITIVELY rejected on its parameter contract, and only for an identity
   * this run derived.
   */
  async cancelByClientAlgoId(clientAlgoId: string): Promise<DocumentedFormResult> {
    return this.send("DELETE", { clientAlgoId });
  }

  private async send(method: "GET" | "DELETE", params: QueryParams): Promise<DocumentedFormResult> {
    const canonical = buildCanonicalQuery({
      ...params,
      recvWindow: this.options.recvWindowMs,
      timestamp: Date.now() + this.options.clockOffsetMs(),
    });
    // The signature covers exactly the string that is transmitted. The URL is
    // built here and never returned, logged or reported.
    const url = `${this.options.baseUrl}${ALGO_ORDER_PATH}?${canonical}&signature=${signQuery(
      canonical,
      this.options.apiSecret
    )}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    this.dispatchCount += 1;

    let response: Response;
    try {
      response = await this.options.transport(url, {
        method,
        headers: { "X-MBX-APIKEY": this.options.apiKey },
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return { outcome: "AMBIGUOUS", httpStatus: null, binanceCode: null, kind: aborted ? "TIMEOUT" : "NETWORK", payload: null };
    } finally {
      clearTimeout(timeout);
    }

    let body: Record<string, unknown> | null = null;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }

    if (response.ok) {
      return { outcome: "ACCEPTED", httpStatus: response.status, binanceCode: null, kind: null, payload: body };
    }

    const binanceCode = typeof body?.code === "number" ? body.code : null;
    const message = typeof body?.msg === "string" ? body.msg : `HTTP ${response.status}`;
    const kind = classifyBinanceFailure(response.status, binanceCode, message);
    // A 5xx or a rate limit tells us nothing; a coded 4xx is a real answer.
    const ambiguous = kind === "SERVER" || kind === "RATE_LIMIT" || kind === "IP_BANNED";

    return {
      outcome: ambiguous ? "AMBIGUOUS" : "REJECTED",
      httpStatus: response.status,
      binanceCode,
      kind,
      payload: null,
    };
  }
}
