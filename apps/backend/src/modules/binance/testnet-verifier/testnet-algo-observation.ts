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

// The PRODUCTION identity comparator — imported, never re-implemented. Phase 20
// verified demo with its own weaker copy of these rules, which is exactly how
// Mainnet Canary #2's identity defect escaped. If this import ever disappears,
// the demo verifier has stopped proving the thing it exists to prove.
import {
  findProtectionIdentityMismatches,
  type ExpectedProtectionIdentity,
} from "../../execution/protection-lifecycle";

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

/**
 * Sanitized. Field NAMES and normalized values only — never a payload.
 *
 * Carries the FULL protection identity, not just the few fields the verifier
 * once checked for itself, because the whole set is handed to the production
 * comparator `findProtectionIdentityMismatches`.
 */
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
  // --- the rest of the production identity surface -------------------------
  readonly side: string | null;
  readonly quantity: string | null;
  readonly triggerPrice: string | null;
  readonly workingType: string | null;
  readonly priceProtect: boolean | null;
  readonly closePosition: boolean | null;
  /**
   * Reported by Binance on hedge-mode closing conditional orders even though
   * we never send it. Recorded so the production comparator sees exactly what
   * the exchange said — this is the field Mainnet Canary #2 turned on.
   */
  readonly reduceOnly: boolean | null;
  readonly productionQueryForm: IdentityLookup;
  readonly documentedQueryForm: IdentityLookup;
}

/** Identity fields either query form may report. */
export interface AlgoIdentityFields {
  readonly algoStatus?: string | null;
  readonly orderType?: string | null;
  readonly positionSide?: string | null;
  readonly symbol?: string | null;
  readonly side?: string | null;
  readonly quantity?: string | null;
  readonly triggerPrice?: string | null;
  readonly workingType?: string | null;
  readonly priceProtect?: boolean | null;
  readonly closePosition?: boolean | null;
  readonly reduceOnly?: boolean | null;
}

export interface AlgoIdentityInput {
  readonly clientAlgoId: string;
  readonly production: AlgoIdentityFields & { readonly lookup: IdentityLookup };
  readonly documented: AlgoIdentityFields & {
    readonly lookup: IdentityLookup;
    /** Only whether the key was present — never the payload itself. */
    readonly statusKeyPresent?: boolean;
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
    side: pick(production.side, documented.side),
    quantity: pick(production.quantity, documented.quantity),
    triggerPrice: pick(production.triggerPrice, documented.triggerPrice),
    workingType: pick(production.workingType, documented.workingType),
    priceProtect: pick(production.priceProtect, documented.priceProtect),
    closePosition: pick(production.closePosition, documented.closePosition),
    reduceOnly: pick(production.reduceOnly, documented.reduceOnly),
    productionQueryForm: production.lookup,
    documentedQueryForm: documented.lookup,
  };
}

/** Nothing is left to unwind for this identity. */
export function isResolved(observation: AlgoIdentityObservation): boolean {
  return observation.outcome === "ABSENT_CONFIRMED" || observation.outcome === "IDENTITY_FOUND_STATUS_TERMINAL";
}

/**
 * The FULL identity the verifier submitted, in the exact shape the production
 * comparator consumes. It is `ExpectedProtectionIdentity` minus `clientAlgoId`,
 * which the observation already carries.
 */
export type ProtectionExpectation = Omit<ExpectedProtectionIdentity, "clientAlgoId">;

export interface ConfirmationResult {
  readonly confirmed: boolean;
  readonly reason: string;
  /** Fields the PRODUCTION comparator rejected. Empty on a pass. */
  readonly identityMismatches: readonly string[];
}

/**
 * Confirms that an owned protection order is genuinely LIVE **and** that the
 * production identity rules accept it.
 *
 * WHY THIS DELEGATES.
 *
 * This function used to check symbol / positionSide / orderType itself. That
 * was a SECOND, weaker identity implementation living beside the real one, and
 * it is precisely why Phase 20 demo verification passed while Mainnet Canary
 * #2 failed: demo never exercised `findProtectionIdentityMismatches`, so it
 * never saw that the production comparator rejected a valid hedge-mode STOP
 * carrying `reduceOnly=true`.
 *
 * There is now ONE source of truth. Identity is decided entirely by the
 * production comparator; this function contributes only the thing the
 * comparator deliberately does not judge — whether the order is ACTIVE.
 */
export function confirmActiveProtection(
  observation: AlgoIdentityObservation,
  expected: ProtectionExpectation
): ConfirmationResult {
  if (observation.outcome !== "IDENTITY_FOUND_STATUS_ACTIVE") {
    return { confirmed: false, reason: `status outcome is ${observation.outcome}`, identityMismatches: [] };
  }

  // The production comparator, unmodified, on the real exchange response.
  const identityMismatches = findProtectionIdentityMismatches(
    { ...expected, clientAlgoId: observation.clientAlgoId },
    {
      clientAlgoId: observation.clientAlgoId,
      symbol: observation.symbol,
      orderType: observation.orderType,
      side: observation.side,
      positionSide: observation.positionSide,
      quantity: observation.quantity,
      triggerPrice: observation.triggerPrice,
      workingType: observation.workingType,
      priceProtect: observation.priceProtect,
      closePosition: observation.closePosition,
      reduceOnly: observation.reduceOnly,
    }
  );

  if (identityMismatches.length > 0) {
    return {
      confirmed: false,
      reason: `production identity comparator rejected: ${identityMismatches.join(", ")}`,
      identityMismatches,
    };
  }

  return {
    confirmed: true,
    reason: `active as ${observation.normalizedStatus}; production identity comparator accepted`,
    identityMismatches: [],
  };
}
