import type { TradingSession, TradingSessionStatus } from "@prisma/client";

/**
 * Trading sessions — pure domain. No Prisma client, no I/O, no clock of its
 * own: every function here is a function of its arguments, so the rules can be
 * tested without a database and cannot drift between callers.
 *
 * ## What a session is
 *
 * A bounded window of automated trading, measured in trades that ACTUALLY
 * obtained exposure. That is the whole point of the model, and it is what
 * `maxClaims` could not express: a claim is spent at admission and never
 * refunded, so an entry that never fills consumes budget permanently. A
 * session slot is RESERVED at admission and only becomes OPENED once the
 * execution first holds a non-zero position; an entry that dies unfilled gives
 * its slot back.
 *
 * ## What a session is NOT
 *
 * Not a concurrency limit, and not a loss limit. `ExecutionSafetyPolicy`
 * remains authoritative for how much may be open at once, for aggregate risk
 * and for margin. A budget of 100 alongside `maxTotalActiveTrades: 5` means at
 * most 100 trades in sequence and never more than 5 at a time. The session is
 * an ADDITIONAL gate; it relaxes nothing.
 */

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

/** Minutes in a day, so the multi-day presets read as what they are. */
const DAY_MINUTES = 24 * 60;

/** The operator-facing duration presets, in minutes. */
export const SESSION_DURATION_PRESET_MINUTES = [
  60,
  6 * 60,
  12 * 60,
  DAY_MINUTES,
  3 * DAY_MINUTES,
  7 * DAY_MINUTES,
  30 * DAY_MINUTES,
] as const;

/**
 * The longest session permitted: 30 days.
 *
 * It was 24 hours, and the reasoning then was that "a multi-day unattended
 * window is a different risk conversation, not a bigger number". That
 * conversation has now happened, and what makes 30 days safe is that a session
 * is not what bounds how much trading occurs:
 *
 *  - the TRADE BUDGET bounds it, in trades that actually obtained exposure,
 *    and remains finite and mandatory on a live account;
 *  - `ExecutionSafetyPolicy` still bounds concurrency, aggregate risk and
 *    margin, and a session relaxes none of it;
 *  - Stop New Trades, Safe Off, the kill switch and authorization revocation
 *    all end admission immediately, whatever duration remains.
 *
 * So duration decides how long PERMISSION may last, not how much may happen
 * during it. A 30-day session with a budget of 300 cannot open a 301st trade.
 *
 * Still FINITE, deliberately. This is not auto-renewal and not an unlimited
 * mode: one session, one fixed start, one fixed expiry, at most 30 days apart.
 */
export const SESSION_MAX_DURATION_MINUTES = 30 * DAY_MINUTES;

/** The shortest session worth starting. One minute; below that is a typo. */
export const SESSION_MIN_DURATION_MINUTES = 1;

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** The operator-facing trade-budget presets. */
export const SESSION_BUDGET_PRESETS = [10, 50, 100, 200, 300] as const;

/**
 * The largest finite budget accepted.
 *
 * Not a trading judgement — a storage and sanity bound. The column is a 32-bit
 * integer, and a budget larger than this is not a session anyone is
 * supervising; it is an unlimited session someone declined to name. Unlimited
 * has its own rule, and it is refused on live accounts.
 */
export const SESSION_MAX_TRADE_BUDGET = 10_000;

export type SessionDurationVerdict =
  | { ok: true; minutes: number }
  | { ok: false; reason: string };

/**
 * Validates a requested duration.
 *
 * Presets and custom values run through the SAME check: the presets are a UI
 * convenience, never a second code path that could admit what custom cannot.
 */
export function validateSessionDuration(raw: unknown): SessionDurationVerdict {
  // Never coerced. A numeric string is a refusal, exactly as it is for every
  // other operator input in this repository: a caller that sends "60" has a
  // bug, and quietly accepting it hides theirs.
  const minutes = raw;
  if (typeof minutes !== "number" || !Number.isSafeInteger(minutes)) {
    return { ok: false, reason: "Session duration must be a whole number of minutes." };
  }
  if (minutes < SESSION_MIN_DURATION_MINUTES) {
    return { ok: false, reason: `Session duration must be at least ${SESSION_MIN_DURATION_MINUTES} minute.` };
  }
  if (minutes > SESSION_MAX_DURATION_MINUTES) {
    return {
      ok: false,
      reason:
        `Session duration must not exceed ${SESSION_MAX_DURATION_MINUTES} minutes (30 days). ` +
        "A session is finite by design; there is no renewal and no unlimited duration.",
    };
  }
  return { ok: true, minutes };
}

export type SessionBudgetVerdict =
  | { ok: true; tradeBudget: number | null; unlimited: boolean }
  | { ok: false; reason: string };

/**
 * Validates a requested trade budget.
 *
 * `unlimitedPermitted` is decided by the SERVER from the execution
 * environment, never from anything the browser said. A request for unlimited
 * on an account the server cannot prove is non-live is refused outright rather
 * than silently downgraded to a finite budget — quietly trading a different
 * configuration from the one asked for is worse than refusing.
 */
export function validateSessionBudget(
  raw: unknown,
  options: { unlimited?: unknown; unlimitedPermitted: boolean }
): SessionBudgetVerdict {
  if (options.unlimited === true) {
    if (!options.unlimitedPermitted) {
      return {
        ok: false,
        reason:
          "An unlimited session is not permitted on this execution environment. " +
          "Choose a finite trade budget.",
      };
    }
    return { ok: true, tradeBudget: null, unlimited: true };
  }

  const budget = raw;
  if (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget < 1) {
    return { ok: false, reason: "Trade budget must be a whole number of at least 1." };
  }
  if (budget > SESSION_MAX_TRADE_BUDGET) {
    return { ok: false, reason: `Trade budget must not exceed ${SESSION_MAX_TRADE_BUDGET}.` };
  }
  return { ok: true, tradeBudget: budget, unlimited: false };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type SessionAdmissionRefusal =
  | "SESSION_REQUIRED"
  | "SESSION_EXPIRED"
  | "SESSION_REVOKED"
  | "SESSION_BUDGET_EXHAUSTED"
  | "SESSION_PAUSED";

/**
 * The statuses a session may be stopped in, and what that means.
 *
 * PAUSED is the ONLY non-terminal one. REVOKED, EXPIRED and EXHAUSTED are
 * ends: the budget, the clock or the operator finished the session, and the
 * next step is a NEW session rather than a continuation of this one.
 *
 * That distinction is the whole safety argument for Resume. Resuming a paused
 * session continues something the operator already reviewed — same budget,
 * same expiry, same counts. "Resuming" a terminal one would be resurrection:
 * it would have to invent a new expiry or a new budget, which is Start
 * Trading's job and carries Start Trading's clean-state requirement.
 */
export const TERMINAL_SESSION_STATUSES = ["REVOKED", "EXPIRED", "EXHAUSTED"] as const;

/**
 * Whether this session can be resumed RIGHT NOW.
 *
 * Deliberately judged from `derivedSessionStatus` rather than from the stored
 * column, so a session that expired or exhausted itself WHILE PAUSED is not
 * resumable even though its column still says PAUSED. Nothing sweeps those
 * rows, so the stored value alone would be a stale promise.
 */
export function isResumableSession(
  session: Pick<
    TradingSession,
    "status" | "expiresAt" | "tradeBudget" | "unlimited" | "openedCount" | "reservedCount"
  >,
  now: Date
): boolean {
  return derivedSessionStatus(session, now) === "PAUSED";
}

/**
 * Whether a session may admit a new trade right now, and if not, why.
 *
 * Time is checked BEFORE budget, so a session that both expired and ran out
 * reports the expiry: the operator's next action differs — one needs a new
 * window, the other needs a bigger budget — and reporting the wrong one sends
 * them to the wrong control.
 *
 * A REVOKED or EXPIRED session refuses NEW admission and nothing else.
 * Executions already admitted stay managed and protected by the existing
 * lifecycle; a session ending is not a reason to close a position.
 */
export function sessionAdmissionState(
  session: Pick<
    TradingSession,
    "status" | "expiresAt" | "tradeBudget" | "unlimited" | "openedCount" | "reservedCount"
  >,
  now: Date
): { admits: true } | { admits: false; reasonCode: SessionAdmissionRefusal; message: string } {
  if (session.status === "REVOKED") {
    return { admits: false, reasonCode: "SESSION_REVOKED", message: "The trading session was stopped." };
  }
  if (session.status === "EXPIRED" || session.expiresAt <= now) {
    return { admits: false, reasonCode: "SESSION_EXPIRED", message: "The trading session has ended." };
  }
  // PAUSED is reported AFTER expiry and budget, and before nothing else,
  // because the operator's next action is what these codes are for. A paused
  // session that also expired needs a NEW session, not a Resume — so expiry
  // wins. A paused session with budget left needs Resume, and says so.
  //
  // Note this is the second gate, not the only one: `reserveSessionSlot`'s
  // conditional UPDATE already requires `status = 'ACTIVE'`, so a paused
  // session cannot reserve even if some future caller skipped this function.
  if (session.unlimited) {
    return session.status === "PAUSED"
      ? { admits: false, reasonCode: "SESSION_PAUSED", message: PAUSED_MESSAGE }
      : { admits: true };
  }

  const budget = session.tradeBudget;
  if (budget === null) {
    // A finite session with no budget is a contradiction, not a licence.
    return {
      admits: false,
      reasonCode: "SESSION_BUDGET_EXHAUSTED",
      message: "The session carries no trade budget, so it admits nothing.",
    };
  }
  if (session.openedCount + session.reservedCount >= budget) {
    return {
      admits: false,
      reasonCode: "SESSION_BUDGET_EXHAUSTED",
      message: `The session's trade budget of ${budget} is fully used or reserved.`,
    };
  }
  if (session.status === "PAUSED") {
    return { admits: false, reasonCode: "SESSION_PAUSED", message: PAUSED_MESSAGE };
  }
  return { admits: true };
}

const PAUSED_MESSAGE =
  "New trades are paused. The session is intact — resume it to admit again.";

/** Slots still available. Null means unlimited, which is not a number. */
export function remainingSessionBudget(
  session: Pick<TradingSession, "tradeBudget" | "unlimited" | "openedCount" | "reservedCount">
): number | null {
  if (session.unlimited || session.tradeBudget === null) return null;
  return Math.max(0, session.tradeBudget - session.openedCount - session.reservedCount);
}

/**
 * The status a session should now be showing.
 *
 * Derived rather than stored-and-hoped-for, so a session that ran out of time
 * while nothing was watching still reports EXPIRED the moment it is read.
 * REVOKED is an operator fact and always wins; EXHAUSTED is reported only
 * while time remains, because after that expiry is the more useful truth.
 */
export function derivedSessionStatus(
  session: Pick<
    TradingSession,
    "status" | "expiresAt" | "tradeBudget" | "unlimited" | "openedCount" | "reservedCount"
  >,
  now: Date
): TradingSessionStatus {
  if (session.status === "REVOKED") return "REVOKED";
  if (session.expiresAt <= now) return "EXPIRED";
  const remaining = remainingSessionBudget(session);
  if (remaining !== null && remaining <= 0) return "EXHAUSTED";
  // PAUSED is reported LAST of the stopped states, so it is reported only when
  // the session is genuinely resumable. That makes "status === PAUSED" a
  // sufficient condition for offering Resume, in the panel and in the service,
  // rather than something each caller has to re-qualify.
  if (session.status === "PAUSED") return "PAUSED";
  return "ACTIVE";
}

/**
 * Whether a terminal execution status means the entry died WITHOUT ever
 * obtaining exposure, so its slot goes back to the budget.
 *
 * Deliberately paired with a `firstFillAt` check at the call site rather than
 * trusted alone: a partially filled entry can still reach a cancelled state,
 * and that trade DID happen. Status answers "is it over"; `firstFillAt`
 * answers "did it ever touch the exchange", and only both together decide.
 */
export const SESSION_RELEASING_STATUSES: readonly string[] = Object.freeze([
  "ENTRY_EXPIRED",
  "CANCELED",
  "SKIPPED",
  "FAILED",
]);

export function releasesSessionSlot(status: string, firstFillAt: Date | null): boolean {
  if (firstFillAt !== null) return false;
  return SESSION_RELEASING_STATUSES.includes(status);
}
