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
 * The maximum life of a window that has NOTHING counting its trades.
 *
 * 24 hours. It was 60 minutes, and the reasoning for that bound was sound at
 * the time: "a window nobody is watching should shut on its own, and natural
 * mode is the mode that admits more than one trade."
 *
 * This value is deliberately UNCHANGED by the move to 30-day sessions. It
 * governs the LEGACY natural window — one prepared by the operator CLI with no
 * `tradingSessionId` — and a legacy window really is bounded only by
 * `maxClaims` and by time. Nothing else stops it, so time has to.
 */
export const MAXIMUM_AUTHORIZATION_TTL_MINUTES = 24 * 60;

/**
 * The maximum life of a SESSION-BACKED window: 30 days.
 *
 * Longer than the legacy bound because a different thing is doing the
 * bounding. A session-backed window spends no claims at all; every admission
 * through it reserves a slot in a TradingSession whose trade budget is finite
 * and, on a live account, mandatory. The window says trading is PERMITTED and
 * until when; the session says how many trades that permission may produce.
 *
 * So the risk a 24-hour cap was protecting against — an unattended window
 * quietly admitting trade after trade — is already answered by the budget, and
 * a 30-day cap does not reopen it. A 30-day window backed by a budget of 300
 * cannot open a 301st trade.
 *
 * It must be AT LEAST the maximum session duration, or a long session would
 * silently stop trading when its window expired first. That relationship is
 * asserted in the tests rather than left to two constants agreeing by luck.
 */
export const MAXIMUM_SESSION_BACKED_AUTHORIZATION_TTL_MINUTES = 30 * 24 * 60;

/**
 * The TTL ceiling that applies to a window, given what backs it.
 *
 * One function rather than two call-site conditionals, so no caller can pick
 * the wrong ceiling and no future caller has to remember the rule exists.
 */
export function maximumAuthorizationTtlMinutes(sessionBacked: boolean): number {
  return sessionBacked
    ? MAXIMUM_SESSION_BACKED_AUTHORIZATION_TTL_MINUTES
    : MAXIMUM_AUTHORIZATION_TTL_MINUTES;
}

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

/**
 * Whether this window's quantitative bound comes from a TradingSession.
 *
 * A SESSION-BACKED window answers only permission questions — is it live, is
 * the direction admitted, has it been revoked. HOW MANY trades it may produce
 * is the session's budget, counted in trades that actually obtained exposure.
 *
 * A LEGACY window (no session link) keeps the historical `maxClaims` behaviour
 * untouched: a cumulative, never-refunded cap on ADMISSIONS.
 *
 * The distinction is a stored link, never an inference, so a legacy window and
 * a new session coexisting on one profile can never be confused for each other.
 */
export function isSessionBackedWindow(
  authorization: Pick<ExecutionCanaryAuthorization, "tradingSessionId">
): boolean {
  return authorization.tradingSessionId !== null;
}

/**
 * The window state that admission should ACT on.
 *
 * Identical to `naturalWindowState` for a legacy window. For a session-backed
 * one it never reports EXHAUSTED, because `claimedCount` is not that window's
 * budget — the session is, and a claim is never spent against it. Without this
 * a 100-trade session would still stop at the fifth ADMISSION, which is the
 * precise bug sessions exist to remove.
 *
 * Every other state is unchanged: revoked is revoked, expired is expired, and
 * a malformed row is still INVALID.
 */
export function effectiveNaturalWindowState(
  authorization: ExecutionCanaryAuthorization,
  now: Date
): NaturalWindowState {
  const state = naturalWindowState(authorization, now);
  if (state === "EXHAUSTED" && isSessionBackedWindow(authorization)) return "AVAILABLE";
  return state;
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
