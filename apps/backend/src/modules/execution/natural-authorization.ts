import type { CanaryDirection, ExecutionCanaryAuthorization } from "@prisma/client";

/**
 * Phase 12.2 — the NATURAL_WINDOW domain. PURE: no Prisma client, no fetch, no
 * clock read (callers pass `now`), no environment, no logging.
 *
 * ## What a natural window authorizes
 *
 *   PROFILE + DIRECTION + TIME + CUMULATIVE CLAIM BUDGET
 *
 * and nothing else. It deliberately names NO symbol. Which tickers can fire is
 * the operator's TradingView watchlist, maintained by hand; whether a symbol
 * that fired can actually be traded is settled by the checks the execution
 * stack already performs — Binance listing, contract type, margin and filter
 * eligibility, a valid deterministic plan, then safety admission. The backend
 * keeps no second copy of that watchlist, so nothing in this module reads
 * `ExecutionSafetyPolicy.allowedSymbols`, the `Asset` table, or any exchange.
 *
 * ## Nothing here is wired to production
 *
 * Phase 12.2 adds the primitives a future admission integration will call. No
 * production entrypoint calls them yet, and a tokenless TradingView alert is
 * still refused exactly as it was before this module existed.
 */

/**
 * The single source of truth for the maximum life of ANY authorization window.
 *
 * 60 minutes, matching the bound `execution:prepare-canary` already enforces on
 * exact authorizations. It is stated here as a named constant because the
 * natural path is the first to need it in the SERVICE layer — the exact path
 * still checks it in the CLI. Deliberately not "reuse or longer": a window
 * nobody is watching should shut on its own, and natural mode is the mode that
 * admits more than one trade.
 */
export const MAXIMUM_AUTHORIZATION_TTL_MINUTES = 60;

/** Every direction a natural window may name. There is no wildcard. */
export const NATURAL_DIRECTIONS = ["LONG", "SHORT"] as const satisfies readonly CanaryDirection[];

/**
 * An `ExecutionCanaryAuthorization` PROVEN to be a well-formed natural window.
 *
 * Narrowing to this type is what lets callers read `maxClaims` as a number
 * instead of `number | null`. A row that fails any invariant never narrows, so
 * a malformed window can only ever be refused — never coerced into a usable
 * one by a default.
 */
export type NaturalCanaryAuthorization = ExecutionCanaryAuthorization & {
  authorizationType: "NATURAL_WINDOW";
  allowedSymbol: null;
  allowedDirection: null;
  tokenHash: null;
  maxClaims: number;
};

/**
 * What a window is RIGHT NOW. Deliberately not called "active": the exact path
 * already owns that word, and "active" cannot distinguish a window that still
 * has budget from one that has spent it — a distinction an operator needs.
 *
 * Precedence is fixed and total, most-decisive first:
 *
 *   INVALID   the row contradicts its own declared mode; nothing else is read
 *   REVOKED   an operator shut it deliberately, which outranks mere expiry
 *   EXPIRED   its time ran out
 *   EXHAUSTED open and well-formed, but the cumulative budget is spent
 *   AVAILABLE open, well-formed, in date, with budget remaining
 */
export const NATURAL_WINDOW_STATES = ["AVAILABLE", "EXHAUSTED", "EXPIRED", "REVOKED", "INVALID"] as const;
export type NaturalWindowState = (typeof NATURAL_WINDOW_STATES)[number];

/**
 * Normalizes a proposed direction set: uppercased, de-duplicated, and ordered
 * canonically so two operators asking for the same thing store the same array.
 *
 * Returns null when the input is empty or names anything that is not a
 * `CanaryDirection`. Empty is a REJECTION, never "all directions" — an implicit
 * widening is exactly the failure mode a natural window must not have.
 */
export function normalizeNaturalDirections(input: readonly string[]): CanaryDirection[] | null {
  const seen = new Set<CanaryDirection>();
  for (const raw of input) {
    const candidate = String(raw).trim().toUpperCase();
    if (!(NATURAL_DIRECTIONS as readonly string[]).includes(candidate)) return null;
    seen.add(candidate as CanaryDirection);
  }
  if (seen.size === 0) return null;
  // Canonical order, not insertion order, so ["SHORT","LONG"] and
  // ["LONG","SHORT"] are the same stored window.
  return NATURAL_DIRECTIONS.filter((direction) => seen.has(direction));
}

/**
 * Whether a row is a well-formed natural window. FAIL CLOSED: every invariant
 * must hold, and the discriminator is read first — the mode a row DECLARES is
 * authoritative, never inferred from which columns happen to be populated.
 *
 * This says nothing about time, revocation or budget; see `naturalWindowState`.
 */
export function isNaturalWindow(
  authorization: ExecutionCanaryAuthorization
): authorization is NaturalCanaryAuthorization {
  if (authorization.authorizationType !== "NATURAL_WINDOW") return false;

  // A natural window carries no exact-signal identity. A row holding any of
  // these is self-contradictory, not a window with extra information.
  if (authorization.allowedSymbol !== null) return false;
  if (authorization.allowedDirection !== null) return false;
  if (authorization.tokenHash !== null) return false;

  // Directions: non-empty, all valid, no duplicates.
  const directions = authorization.allowedDirections;
  if (!Array.isArray(directions) || directions.length === 0) return false;
  if (!directions.every((d) => (NATURAL_DIRECTIONS as readonly string[]).includes(d))) return false;
  if (new Set(directions).size !== directions.length) return false;

  // Budget: an explicit whole number of at least one. There is no
  // representation for "unlimited", so null is malformed rather than infinite.
  const { maxClaims, claimedCount } = authorization;
  if (maxClaims === null || !Number.isSafeInteger(maxClaims) || maxClaims < 1) return false;
  if (!Number.isSafeInteger(claimedCount) || claimedCount < 0) return false;
  // Spending past the ceiling can only mean the counter was written by
  // something other than the guarded claim, so the row is not trustworthy.
  if (claimedCount > maxClaims) return false;

  if (!Number.isSafeInteger(authorization.version) || authorization.version < 1) return false;

  // Expiry is mandatory in BOTH modes; a window with no usable instant cannot
  // be reasoned about at all.
  if (!(authorization.expiresAt instanceof Date) || Number.isNaN(authorization.expiresAt.getTime())) return false;

  return true;
}

/** The window's state at `now`, by the fixed precedence documented above. */
export function naturalWindowState(
  authorization: ExecutionCanaryAuthorization,
  now: Date
): NaturalWindowState {
  if (!isNaturalWindow(authorization)) return "INVALID";
  if (authorization.revokedAt !== null) return "REVOKED";
  if (authorization.expiresAt <= now) return "EXPIRED";
  if (authorization.claimedCount >= authorization.maxClaims) return "EXHAUSTED";
  return "AVAILABLE";
}

/** Well-formed, unrevoked and in date — says nothing about remaining budget. */
export function isNaturalWindowOpen(authorization: ExecutionCanaryAuthorization, now: Date): boolean {
  const state = naturalWindowState(authorization, now);
  return state === "AVAILABLE" || state === "EXHAUSTED";
}

/** Open AND still holding budget: the only state a new claim may be attempted from. */
export function isNaturalWindowAvailable(authorization: ExecutionCanaryAuthorization, now: Date): boolean {
  return naturalWindowState(authorization, now) === "AVAILABLE";
}

/** Claims left before the window is exhausted. Zero for any unusable window. */
export function remainingNaturalClaims(authorization: ExecutionCanaryAuthorization, now: Date): number {
  if (!isNaturalWindowAvailable(authorization, now)) return 0;
  return (authorization as NaturalCanaryAuthorization).maxClaims - authorization.claimedCount;
}

/**
 * Whether this window admits a signal in `direction`.
 *
 * Requires the window to be AVAILABLE and the direction to appear EXPLICITLY in
 * `allowedDirections`. LONG and SHORT are never implicitly enabled — a window
 * prepared for LONG refuses SHORT even though both are valid enum members.
 *
 * Reads no symbol, no allowlist and no exchange: direction eligibility and
 * symbol tradability are separate concerns, and this function owns only the
 * former.
 */
export function naturalWindowAdmitsDirection(
  authorization: ExecutionCanaryAuthorization,
  direction: string,
  now: Date
): boolean {
  if (!isNaturalWindowAvailable(authorization, now)) return false;
  const wanted = String(direction).trim().toUpperCase();
  if (!(NATURAL_DIRECTIONS as readonly string[]).includes(wanted)) return false;
  return authorization.allowedDirections.includes(wanted as CanaryDirection);
}

/** Sanitized operator-facing view. A natural window has no secret to omit. */
export interface NaturalWindowStatus {
  state: NaturalWindowState;
  allowedDirections: CanaryDirection[];
  maxClaims: number | null;
  claimedCount: number;
  remainingClaims: number;
  expiresAt: string;
  version: number;
}

export function describeNaturalWindow(
  authorization: ExecutionCanaryAuthorization,
  now: Date
): NaturalWindowStatus {
  return {
    state: naturalWindowState(authorization, now),
    allowedDirections: [...authorization.allowedDirections],
    maxClaims: authorization.maxClaims,
    claimedCount: authorization.claimedCount,
    remainingClaims: remainingNaturalClaims(authorization, now),
    expiresAt: authorization.expiresAt.toISOString(),
    version: authorization.version,
  };
}
