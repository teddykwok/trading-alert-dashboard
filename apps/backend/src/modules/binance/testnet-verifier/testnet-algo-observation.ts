/**
 * How ONE owned Algo identity is observed, and what that observation is
 * allowed to prove.
 *
 * ## Why this module exists
 *
 * The first real demo run reported, for the take profit:
 *
 *     productionQueryFormAccepted = true
 *     documentedQueryFormAccepted = true
 *     status                      = null
 *
 * which reads like "the order was found but had no status". It is not. Those
 * two flags meant only "the query FORM was understood by the exchange", and a
 * documented `-2013 NO_SUCH_ORDER` answer set BOTH of them to true while
 * leaving the status null. The same three values are therefore produced by two
 * completely different realities — an order that exists without a readable
 * status, and an order that provably does not exist.
 *
 * Collapsing those is exactly the class of mistake this project has already
 * paid for once: conflating "absent" with "unknown" is what stranded the first
 * mainnet canary. So the observation is now explicit about which of the five
 * mutually exclusive outcomes occurred, and each query form reports its own
 * result separately.
 */

export type IdentityLookup =
  /** The exchange returned this exact identity. */
  | "FOUND"
  /** The exchange answered -2013 NO_SUCH_ORDER for this exact identity. */
  | "CONFIRMED_ABSENT"
  /** Timeout, network, 5xx, auth, malformed — nothing was established. */
  | "UNKNOWN"
  | "NOT_ATTEMPTED";

export type AlgoIdentityOutcome =
  | "IDENTITY_FOUND_STATUS_ACTIVE"
  | "IDENTITY_FOUND_STATUS_TERMINAL"
  /** The identity exists but its status is absent or unrecognised. */
  | "IDENTITY_FOUND_STATUS_MISSING"
  | "ABSENT_CONFIRMED"
  | "UNKNOWN";

/** Statuses that prove a conditional order is live and protecting. */
export const ACTIVE_ALGO_STATUSES: readonly string[] = ["NEW", "WORKING", "ACTIVE"];

/**
 * Statuses that prove it is finished. Both Binance spellings of "cancelled"
 * are accepted because the documentation and the wire have historically
 * disagreed, and guessing wrong in this direction would report a live order
 * as resolved.
 */
export const TERMINAL_ALGO_STATUSES: readonly string[] = [
  "CANCELED",
  "CANCELLED",
  "FILLED",
  "EXPIRED",
  "REJECTED",
];

/** Sanitized. Field NAMES and normalized values only — never a payload. */
export interface AlgoIdentityObservation {
  readonly clientAlgoId: string;
  readonly outcome: AlgoIdentityOutcome;
  readonly identityFound: boolean;
  /**
   * Whether the reply actually carried an `algoStatus` key. Derived from the
   * documented form, which is the only path that keeps the raw body — the
   * production path goes through the shared normalizer, which cannot report
   * the difference between "key absent" and "value unusable".
   */
  readonly rawStatusPresent: boolean | null;
  readonly normalizedStatus: string | null;
  readonly orderType: string | null;
  readonly positionSide: string | null;
  readonly symbol: string | null;
  readonly productionQueryForm: IdentityLookup;
  readonly documentedQueryForm: IdentityLookup;
}

export interface AlgoIdentityInput {
  readonly clientAlgoId: string;
  readonly production: {
    readonly lookup: IdentityLookup;
    readonly algoStatus?: string | null;
    readonly orderType?: string | null;
    readonly positionSide?: string | null;
    readonly symbol?: string | null;
  };
  readonly documented: {
    readonly lookup: IdentityLookup;
    /** Only whether the key was present — never the payload itself. */
    readonly statusKeyPresent?: boolean;
    readonly algoStatus?: string | null;
    readonly orderType?: string | null;
    readonly positionSide?: string | null;
    readonly symbol?: string | null;
  };
}

function normalizeStatus(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed === "" ? null : trimmed;
}

function pick<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) if (value !== null && value !== undefined) return value;
  return null;
}

/**
 * Combines the two exact-id lookups into ONE outcome.
 *
 * A `FOUND` from either form establishes existence. A `CONFIRMED_ABSENT` from
 * either form establishes absence — both are exact-identity queries answered
 * with the documented -2013. When the two forms CONTRADICT each other the
 * result is UNKNOWN: two disagreeing answers are not better evidence than one,
 * and neither may unlock a mutation.
 *
 * `UNKNOWN` never becomes absence. A query that failed is a query that failed.
 */
export function observeAlgoIdentity(input: AlgoIdentityInput): AlgoIdentityObservation {
  const { production, documented } = input;

  const found = production.lookup === "FOUND" || documented.lookup === "FOUND";
  const absent = production.lookup === "CONFIRMED_ABSENT" || documented.lookup === "CONFIRMED_ABSENT";

  const normalizedStatus = normalizeStatus(pick(production.algoStatus, documented.algoStatus));
  const orderType = pick(production.orderType, documented.orderType);
  const positionSide = pick(production.positionSide, documented.positionSide);
  const symbol = pick(production.symbol, documented.symbol);
  const rawStatusPresent =
    documented.lookup === "FOUND" ? (documented.statusKeyPresent ?? false) : null;

  let outcome: AlgoIdentityOutcome;
  if (found && absent) {
    // One form says it exists, the other says it does not. Refuse to choose.
    outcome = "UNKNOWN";
  } else if (found) {
    if (normalizedStatus === null) outcome = "IDENTITY_FOUND_STATUS_MISSING";
    else if (ACTIVE_ALGO_STATUSES.includes(normalizedStatus)) outcome = "IDENTITY_FOUND_STATUS_ACTIVE";
    else if (TERMINAL_ALGO_STATUSES.includes(normalizedStatus)) outcome = "IDENTITY_FOUND_STATUS_TERMINAL";
    // A status we do not recognise is not a status we may act on.
    else outcome = "IDENTITY_FOUND_STATUS_MISSING";
  } else if (absent) {
    outcome = "ABSENT_CONFIRMED";
  } else {
    outcome = "UNKNOWN";
  }

  return {
    clientAlgoId: input.clientAlgoId,
    outcome,
    identityFound: found && !absent,
    rawStatusPresent,
    normalizedStatus,
    orderType,
    positionSide,
    symbol,
    productionQueryForm: production.lookup,
    documentedQueryForm: documented.lookup,
  };
}

/** Nothing is left to unwind for this identity. */
export function isResolved(observation: AlgoIdentityObservation): boolean {
  return observation.outcome === "ABSENT_CONFIRMED" || observation.outcome === "IDENTITY_FOUND_STATUS_TERMINAL";
}

export interface ProtectionExpectation {
  readonly symbol: string;
  readonly positionSide: "LONG" | "SHORT";
  readonly orderType: "STOP_MARKET" | "TAKE_PROFIT_MARKET";
}

export interface ConfirmationResult {
  readonly confirmed: boolean;
  readonly reason: string;
}

/**
 * Confirms that an owned protection order is genuinely LIVE.
 *
 * A matching `clientAlgoId` alone is NOT confirmation — that was the flaw the
 * first demo run exposed. Every field the exchange documents for this response
 * must agree with what we asked for, and the status must be a recognised
 * ACTIVE value. Anything else fails safe: the caller re-queries boundedly and,
 * if still unresolved, stops. It never resubmits and never proceeds to the
 * take profit.
 */
export function confirmActiveProtection(
  observation: AlgoIdentityObservation,
  expected: ProtectionExpectation
): ConfirmationResult {
  if (observation.outcome !== "IDENTITY_FOUND_STATUS_ACTIVE") {
    return { confirmed: false, reason: `status outcome is ${observation.outcome}` };
  }
  if (observation.symbol !== null && observation.symbol.toUpperCase() !== expected.symbol.toUpperCase()) {
    return { confirmed: false, reason: `symbol ${observation.symbol} does not match ${expected.symbol}` };
  }
  if (observation.symbol === null) return { confirmed: false, reason: "the reply carried no symbol" };
  if (observation.positionSide !== expected.positionSide) {
    return { confirmed: false, reason: `positionSide ${observation.positionSide ?? "—"} is not ${expected.positionSide}` };
  }
  if (observation.orderType !== expected.orderType) {
    return { confirmed: false, reason: `orderType ${observation.orderType ?? "—"} is not ${expected.orderType}` };
  }
  return { confirmed: true, reason: `active as ${observation.normalizedStatus}` };
}
