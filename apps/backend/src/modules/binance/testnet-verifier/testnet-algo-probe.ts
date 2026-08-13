import type { BinanceErrorKind } from "../binance.errors";

/**
 * Interpretation of the signed Algo capability probe.
 *
 * The current official documentation states only that "most of the endpoints
 * can be used in the testnet platform" — there is no per-endpoint testnet
 * matrix and no statement about `/fapi/v1/algoOrder` on demo. Support is
 * therefore UNPROVEN until the exchange itself demonstrates it.
 *
 * Exactly ONE observation proves it: a signed GET for an identity that cannot
 * exist, answered with the documented `-2013 NO_SUCH_ORDER`. That single reply
 * simultaneously establishes three things:
 *
 *   1. the route exists and is served (not a 404 or a WAF page);
 *   2. the signature and API key were accepted (an unauthenticated request
 *      would have failed before order lookup);
 *   3. the queried identity is genuinely absent.
 *
 * Nothing else qualifies. In particular HTTP routing alone does not: a 200
 * from a proxy, an unknown 4xx, or a generic error page all leave the question
 * open, and "open" must never unlock mutation.
 */

export type AlgoProbeOutcome =
  /** -2013 on the verified demo host. The only unlocking result. */
  | "SUPPORTED"
  /** The route or the endpoint is definitively not there. */
  | "NOT_SUPPORTED"
  /** Transport, auth or rate-limit noise — we simply do not know yet. */
  | "INCONCLUSIVE";

export interface AlgoProbeObservation {
  /** null when the request unexpectedly SUCCEEDED. */
  readonly failure: {
    readonly kind: BinanceErrorKind;
    readonly httpStatus: number | null;
    readonly binanceCode: number | null;
  } | null;
}

/** NO_SUCH_ORDER — the documented "this exact id does not exist" answer. */
const NO_SUCH_ORDER = -2013;

/**
 * Kinds that describe the TRANSPORT or the CALLER rather than the endpoint.
 * None of them can establish that a route exists, whatever body accompanies
 * them — a gateway or WAF is free to attach an arbitrary JSON payload to a
 * 5xx, so a 503 carrying `-2013` is a contradiction, not an answer.
 */
const NON_ENDPOINT_KINDS: ReadonlySet<BinanceErrorKind> = new Set<BinanceErrorKind>([
  "TIMEOUT",
  "NETWORK",
  "SERVER",
  "RATE_LIMIT",
  "IP_BANNED",
  "TIMESTAMP",
  "AUTH",
  "PERMISSION",
  "IP_RESTRICTED",
  "MISSING_CREDENTIALS",
  "FUTURES_NOT_ENABLED",
  "DISABLED",
  "READ_ONLY_VIOLATION",
]);

function isClientErrorStatus(httpStatus: number | null): boolean {
  return httpStatus !== null && httpStatus >= 400 && httpStatus < 500;
}

export interface AlgoProbeResult {
  readonly outcome: AlgoProbeOutcome;
  readonly supported: boolean;
  readonly detail: string;
}

export function classifyAlgoProbe(observation: AlgoProbeObservation): AlgoProbeResult {
  const { failure } = observation;

  if (!failure) {
    // The probe id cannot correspond to a real order, so a 200 means we are
    // not talking to the endpoint we think we are. Never treat as support.
    return {
      outcome: "INCONCLUSIVE",
      supported: false,
      detail: "The probe identity returned a successful order payload, which is impossible; refusing to trust it.",
    };
  }

  const transportOrCaller = NON_ENDPOINT_KINDS.has(failure.kind);

  // THE ONLY UNLOCK. All three conditions are required together:
  //   · Binance code -2013 (the documented NO_SUCH_ORDER answer),
  //   · an HTTP 4xx, i.e. the SERVER answered about this request, and
  //   · a kind that describes the endpoint rather than the transport.
  // A 5xx carrying -2013 fails the second condition and a rate-limited reply
  // fails the third, so neither can unlock mutation.
  if (failure.binanceCode === NO_SUCH_ORDER && isClientErrorStatus(failure.httpStatus) && !transportOrCaller) {
    return {
      outcome: "SUPPORTED",
      supported: true,
      detail:
        `Signed GET /fapi/v1/algoOrder answered HTTP ${failure.httpStatus} with -2013 NO_SUCH_ORDER: ` +
        "route served, signature accepted, id absent.",
    };
  }

  if (failure.binanceCode === NO_SUCH_ORDER) {
    // -2013 in a reply that contradicts itself. Refuse rather than reconcile.
    return {
      outcome: "INCONCLUSIVE",
      supported: false,
      detail:
        `Probe returned -2013 in a contradictory response (kind=${failure.kind}, ` +
        `http=${failure.httpStatus ?? "—"}); a served 4xx is required, so support stays unproven.`,
    };
  }

  if (transportOrCaller) {
    return {
      outcome: "INCONCLUSIVE",
      supported: false,
      detail: `Probe could not be completed (${failure.kind}); Algo support remains unproven.`,
    };
  }

  // MALFORMED_RESPONSE covers an unknown 4xx and an unparseable body — the
  // shape a missing route produces. Definitively not proof of support.
  return {
    outcome: "NOT_SUPPORTED",
    supported: false,
    detail:
      `Signed GET /fapi/v1/algoOrder did not answer -2013 (kind=${failure.kind}, ` +
      `http=${failure.httpStatus ?? "—"}, code=${failure.binanceCode ?? "—"}).`,
  };
}
