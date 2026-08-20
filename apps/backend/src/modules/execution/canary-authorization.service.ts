import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { CanaryDirection, ExecutionCanaryAuthorization, PrismaClient } from "@prisma/client";
import {
  MAXIMUM_AUTHORIZATION_TTL_MINUTES,
  isNaturalWindow,
  isNaturalWindowOpen,
  naturalWindowAdmitsDirection,
  naturalWindowState,
  normalizeNaturalDirections,
} from "./natural-authorization";
import { profileLockKey } from "./profile-lock";

/**
 * Phase 11B.0 — one-shot live-canary authorization.
 *
 * Capacity limits stop the account over-trading; they do not say WHICH trade
 * was intended. `allowedSymbols` narrows the symbol but still admits either
 * direction and any number of signals on it. This service supplies the missing
 * identity: one profile, one symbol, one direction, one use, short-lived.
 *
 * It is strictly an ADDITIONAL guard. Nothing here can relax the global kill
 * switch, the profile kill switch, `isEnabled`, SafetyAdmission, capacity, the
 * $1.50 ceiling or the live-entry/protection gates. A match means "this is the
 * intended canary signal", never "skip the normal checks".
 */

/** Long enough that guessing is hopeless; short enough to read aloud once. */
const TOKEN_BYTES = 24;

/** Default prepared lifetime. Deliberately short: an unused window should shut. */
export const DEFAULT_AUTHORIZATION_TTL_MINUTES = 10;

/**
 * Arming refuses an authorization closer than this to expiry. Arming, running
 * a final preflight and sending the alert all take time; a window about to
 * close is worse than no window, because it invites a rushed retry.
 */
export const MINIMUM_REMAINING_LIFETIME_MS = 2 * 60 * 1000;

/**
 * Advisory-lock namespace for canary preparation, distinct from the entry,
 * protection and admission namespaces already in use.
 */
export const CANARY_PREPARE_LOCK_NAMESPACE = 0x11b0;

/**
 * Either the root client or a transaction client. Used by the readers that an
 * operator command may need to run inside its advisory-locked transaction.
 */
type AuthorizationReader = Pick<PrismaClient, "executionCanaryAuthorization"> | Prisma.TransactionClient;

/** Raised when a profile already holds an authorization that is still usable. */
export class CanaryAuthorizationAlreadyActiveError extends Error {
  readonly reasonCode = "CANARY_AUTHORIZATION_ALREADY_ACTIVE";

  constructor(readonly existing: ExecutionCanaryAuthorization) {
    super(
      `An active canary authorization already exists (${describeAuthorizationSubject(existing)}, ` +
        `expires ${existing.expiresAt.toISOString()}). Run execution:disarm-canary first.`
    );
    this.name = "CanaryAuthorizationAlreadyActiveError";
  }
}

export const AUTHORIZATION_FAILURES = [
  "CANARY_AUTHORIZATION_MISSING",
  "CANARY_AUTHORIZATION_UNKNOWN",
  "CANARY_AUTHORIZATION_EXPIRED",
  "CANARY_AUTHORIZATION_REVOKED",
  "CANARY_AUTHORIZATION_ALREADY_CONSUMED",
  "CANARY_AUTHORIZATION_WRONG_PROFILE",
  "CANARY_AUTHORIZATION_WRONG_SYMBOL",
  "CANARY_AUTHORIZATION_WRONG_DIRECTION",
  /**
   * The row is not a usable EXACT_SIGNAL authorization: either it declares a
   * different mode, or it declares EXACT_SIGNAL while missing one of the three
   * fields that mode requires.
   *
   * Additive, and reachable only by a row that should not exist. It is a
   * distinct code rather than a reused one because "structurally invalid" and
   * "wrong symbol" call for completely different operator responses.
   */
  "CANARY_AUTHORIZATION_NOT_EXACT",
] as const;

export type AuthorizationFailure = (typeof AUTHORIZATION_FAILURES)[number];

export type ConsumeResult =
  | { ok: true; authorization: ExecutionCanaryAuthorization; replay: boolean }
  | { ok: false; reasonCode: AuthorizationFailure; message: string };

// ---------------------------------------------------------------------------
// EXACT_SIGNAL row integrity
// ---------------------------------------------------------------------------

/**
 * An `ExecutionCanaryAuthorization` PROVEN to be a usable exact-signal
 * authorization: it declares EXACT_SIGNAL and carries all three fields that
 * mode requires.
 *
 * Phase 12.1 relaxed `allowedSymbol`, `allowedDirection` and `tokenHash` to
 * nullable so the same table can also hold a NATURAL_WINDOW. That is a schema
 * change, not a licence for exact-mode code to start coping with absent
 * identity — an exact row missing its symbol is a corrupt row, and the only
 * safe reading of a corrupt authorization is "no authorization".
 *
 * This type is how that stays honest: exact-mode code narrows to it FIRST and
 * then dereferences without a null check, so the compiler refuses any path
 * that treats a null as merely a different value to compare against.
 */
export type ExactCanaryAuthorization = ExecutionCanaryAuthorization & {
  authorizationType: "EXACT_SIGNAL";
  allowedSymbol: string;
  allowedDirection: CanaryDirection;
  tokenHash: string;
};

/**
 * Whether a row is a usable exact-signal authorization. FAIL CLOSED: anything
 * that is not provably one — a natural window, or an exact row with a missing
 * field — returns false and is refused by every exact-mode caller.
 *
 * The discriminator is authoritative. This never infers the mode from which
 * columns are populated; it reads `authorizationType` and then checks that the
 * row honours what it claims to be.
 *
 * Deliberately NOT a general dispatcher: it says nothing about natural windows
 * beyond "this is not an exact one". Nothing in this phase admits one.
 */
export function isExactAuthorization(
  authorization: ExecutionCanaryAuthorization
): authorization is ExactCanaryAuthorization {
  return (
    authorization.authorizationType === "EXACT_SIGNAL" &&
    authorization.allowedSymbol !== null &&
    authorization.allowedDirection !== null &&
    authorization.tokenHash !== null
  );
}

/**
 * A short, non-secret description of what an authorization admits, for operator
 * messages. Never includes the token or its hash.
 *
 * A row that is not a valid exact authorization is described as exactly that
 * rather than being rendered as "null null", which reads like a defect in the
 * message instead of a defect in the row.
 */
export function describeAuthorizationSubject(authorization: ExecutionCanaryAuthorization): string {
  return isExactAuthorization(authorization)
    ? `${authorization.allowedSymbol} ${authorization.allowedDirection}`
    : `${authorization.authorizationType}`;
}

/** SHA-256. The raw token is never stored, logged or returned after prepare. */
export function hashCanaryToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}

export function generateCanaryToken(): string {
  // URL-safe so it survives a TradingView alert body without escaping.
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export interface PrepareInput {
  executionProfileId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  ttlMinutes?: number;
  now?: Date;
}

export interface PrepareResult {
  authorization: ExecutionCanaryAuthorization;
  /** Shown to the operator EXACTLY once. Never persisted in this form. */
  token: string;
}

// ---------------------------------------------------------------------------
// Phase 12.2 — NATURAL_WINDOW contracts
// ---------------------------------------------------------------------------

export interface PrepareNaturalWindowInput {
  executionProfileId: string;
  /** Non-empty. Normalized and de-duplicated; empty is a rejection. */
  allowedDirections: readonly string[];
  /** CUMULATIVE budget for the window's whole life. >= 1, never unlimited. */
  maxClaims: number;
  ttlMinutes?: number;
  now?: Date;
}

/** Raised when a proposed natural window could never be a valid one. */
export class NaturalWindowValidationError extends Error {
  readonly reasonCode = "NATURAL_WINDOW_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "NaturalWindowValidationError";
  }
}

/**
 * Why a claim was refused. Every one is FAIL CLOSED and leaves `claimedCount`
 * untouched.
 *
 * Deliberately NOT mapped onto `SafetyReasonCode` here. Translating these into
 * admission decisions is the integration phase's job, and doing it early would
 * put natural vocabulary inside the safety engine before anything calls it.
 */
export const NATURAL_CLAIM_FAILURES = [
  "NATURAL_WINDOW_NOT_FOUND",
  "NOT_NATURAL",
  "MALFORMED_NATURAL_WINDOW",
  "REVOKED",
  "EXPIRED",
  "EXHAUSTED",
  "DIRECTION_NOT_ALLOWED",
  "VERSION_CONFLICT",
] as const;

export type NaturalClaimFailure = (typeof NATURAL_CLAIM_FAILURES)[number];

export type NaturalClaimResult =
  | { ok: true; authorization: ExecutionCanaryAuthorization }
  | { ok: false; reasonCode: NaturalClaimFailure; message: string };

export interface ClaimNaturalWindowInput {
  authorizationId: string;
  /** The version the caller evaluated. A stale one refuses rather than racing. */
  expectedVersion: number;
  direction: string;
  /** Explicit instant — this primitive never reads a clock. */
  evaluatedAt: Date;
}

/**
 * The ONE definition of "this profile already has a window open", shared by
 * every preparation path.
 *
 * Deliberately type-agnostic. An EXACT_SIGNAL row is open while unconsumed,
 * unrevoked and in date; a NATURAL_WINDOW never sets `consumedAt` at all, so
 * the same predicate covers it without a clause about modes. That is what
 * makes exact and natural preparation mutually exclusive through ONE mechanism
 * rather than two that could disagree: whichever window is open blocks the
 * other kind from being prepared beside it.
 *
 * Must be called inside the transaction that holds the per-profile advisory
 * lock; on its own it is a read that a concurrent writer could invalidate.
 */
async function assertNoActiveWindow(
  tx: Prisma.TransactionClient,
  executionProfileId: string,
  now: Date
): Promise<void> {
  const active = await tx.executionCanaryAuthorization.findFirst({
    where: { executionProfileId, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (active) throw new CanaryAuthorizationAlreadyActiveError(active);
}

export class CanaryAuthorizationService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Creates one unconsumed, short-lived authorization and returns its raw token
   * once. Only the hash reaches the database.
   *
   * At most ONE authorization may be active per profile. Two windows open at
   * the same time means two signals could each look legitimate, and the
   * operator can no longer say which one the canary is — so a second prepare
   * fails rather than replacing the first. Replacement is deliberately not
   * offered: silently revoking a window the operator may have already pasted
   * into an alert is worse than making them run `execution:disarm-canary`.
   *
   * Exclusivity is enforced with a transactional advisory lock keyed on the
   * profile, the same mechanism Phase 5 admission uses. A partial unique index
   * cannot express it: "active" depends on `expiresAt > now`, and an expired
   * row must not block a fresh preparation.
   *
   * `alsoInTransaction` runs inside the same transaction, so a caller can
   * narrow `allowedSymbols` and create the authorization atomically — either
   * both land or neither does.
   */
  async prepare(
    input: PrepareInput,
    alsoInTransaction?: (tx: Prisma.TransactionClient) => Promise<void>
  ): Promise<PrepareResult> {
    const now = input.now ?? new Date();
    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol) throw new Error("A canary authorization requires a symbol.");
    if (input.direction !== "LONG" && input.direction !== "SHORT") {
      throw new Error("A canary authorization requires direction LONG or SHORT.");
    }

    const token = generateCanaryToken();
    const authorization = await this.prisma.$transaction(async (tx) => {
      // Serialize preparation per profile: two concurrent commands must not
      // both observe "no active authorization" and both insert one.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CANARY_PREPARE_LOCK_NAMESPACE}::int, ${profileLockKey(
        input.executionProfileId
      )}::int)`;

      await assertNoActiveWindow(tx, input.executionProfileId, now);

      const created = await tx.executionCanaryAuthorization.create({
        data: {
          executionProfileId: input.executionProfileId,
          // Stated, not inherited. The column defaults to EXACT_SIGNAL, but a
          // default is what historical rows get; a row this code writes should
          // say which mode it meant. `prepare` creates exact authorizations and
          // only exact authorizations.
          authorizationType: "EXACT_SIGNAL",
          allowedSymbol: symbol,
          allowedDirection: input.direction,
          tokenHash: hashCanaryToken(token),
          expiresAt: new Date(now.getTime() + (input.ttlMinutes ?? DEFAULT_AUTHORIZATION_TTL_MINUTES) * 60_000),
        },
      });

      if (alsoInTransaction) await alsoInTransaction(tx);
      return created;
    });

    return { authorization, token };
  }

  /** How many authorizations are active right now. Should never exceed one. */
  /**
   * The four readers below accept an optional client so an operator command
   * holding the profile advisory lock can read INSIDE its own transaction.
   * Omitting it keeps the historical root-client behaviour for every existing
   * caller. A read that escaped the lock would be exactly the stale snapshot
   * the operator serialization contract exists to prevent.
   */
  async countActive(executionProfileId: string, now = new Date(), client: AuthorizationReader = this.prisma): Promise<number> {
    return client.executionCanaryAuthorization.count({
      where: { executionProfileId, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
    });
  }

  /** The single active (unconsumed, unrevoked, unexpired) authorization, if any. */
  async findActive(
    executionProfileId: string,
    now = new Date(),
    client: AuthorizationReader = this.prisma
  ): Promise<ExecutionCanaryAuthorization | null> {
    return client.executionCanaryAuthorization.findFirst({
      where: {
        executionProfileId,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Everything prepared for this profile, newest first. Read-only. */
  async listForProfile(
    executionProfileId: string,
    client: AuthorizationReader = this.prisma
  ): Promise<ExecutionCanaryAuthorization[]> {
    return client.executionCanaryAuthorization.findMany({
      where: { executionProfileId },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Validates and ATOMICALLY consumes an authorization, binding it to one
   * alert.
   *
   * The one-shot guarantee is a conditional `updateMany` that only matches a
   * row still holding `consumedAt: null` — not an in-memory check. Two
   * concurrent workers therefore produce exactly one winner; the loser sees
   * zero rows updated and fails closed.
   *
   * Binding is deliberately distinct from the execution SUCCEEDING. Once bound
   * to alert X, a crash leaves X recoverable, and a replay carrying the same
   * token for the same alert is accepted as a replay (never a second binding)
   * while any other alert is refused.
   */
  async consume(input: {
    token: string | null | undefined;
    executionProfileId: string;
    symbol: string;
    direction: string;
    alertId: string;
    now?: Date;
  }): Promise<ConsumeResult> {
    const now = input.now ?? new Date();

    if (!input.token || input.token.trim() === "") {
      return {
        ok: false,
        reasonCode: "CANARY_AUTHORIZATION_MISSING",
        message: "No canary authorization accompanied this signal.",
      };
    }

    const tokenHash = hashCanaryToken(input.token);
    const existing = await this.prisma.executionCanaryAuthorization.findUnique({ where: { tokenHash } });
    if (!existing) {
      return {
        ok: false,
        reasonCode: "CANARY_AUTHORIZATION_UNKNOWN",
        message: "The supplied canary authorization does not exist.",
      };
    }

    // STRUCTURE before identity before state. A row that is not a usable exact
    // authorization cannot be compared against a symbol at all, so asking
    // "wrong symbol?" of it would report a mismatch and hide the real problem.
    //
    // Unreachable through the normal path — a natural window has a null
    // tokenHash and can never be found by this lookup — and that is the point:
    // it holds if the row is ever reached another way.
    if (!isExactAuthorization(existing)) {
      return {
        ok: false,
        reasonCode: "CANARY_AUTHORIZATION_NOT_EXACT",
        message: "The authorization is not a usable exact-signal authorization.",
      };
    }

    // Identity checks BEFORE state checks, so a wrong-symbol replay of an
    // already-consumed token still reports the identity mismatch first.
    if (existing.executionProfileId !== input.executionProfileId) {
      return {
        ok: false,
        reasonCode: "CANARY_AUTHORIZATION_WRONG_PROFILE",
        message: "The authorization belongs to a different execution profile.",
      };
    }
    if (existing.allowedSymbol !== input.symbol.trim().toUpperCase()) {
      return {
        ok: false,
        reasonCode: "CANARY_AUTHORIZATION_WRONG_SYMBOL",
        message: `The authorization admits ${existing.allowedSymbol}, not this symbol.`,
      };
    }
    if (existing.allowedDirection !== input.direction.trim().toUpperCase()) {
      return {
        ok: false,
        reasonCode: "CANARY_AUTHORIZATION_WRONG_DIRECTION",
        message: `The authorization admits ${existing.allowedDirection}, not this direction.`,
      };
    }
    if (existing.revokedAt !== null) {
      return { ok: false, reasonCode: "CANARY_AUTHORIZATION_REVOKED", message: "The authorization was revoked." };
    }

    // A replay of the SAME alert is not a second use — it is the same use
    // arriving twice, which BullMQ redelivery makes routine.
    if (existing.consumedAt !== null) {
      if (existing.consumedAlertId === input.alertId) {
        return { ok: true, authorization: existing, replay: true };
      }
      return {
        ok: false,
        reasonCode: "CANARY_AUTHORIZATION_ALREADY_CONSUMED",
        message: "The authorization is already bound to a different signal.",
      };
    }

    if (existing.expiresAt <= now) {
      return { ok: false, reasonCode: "CANARY_AUTHORIZATION_EXPIRED", message: "The authorization has expired." };
    }

    // --- The atomic one-shot claim ----------------------------------------
    const claimed = await this.prisma.executionCanaryAuthorization.updateMany({
      where: {
        id: existing.id,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now, consumedAlertId: input.alertId },
    });

    if (claimed.count !== 1) {
      // Another worker won between the read and the update.
      const current = await this.prisma.executionCanaryAuthorization.findUnique({ where: { id: existing.id } });
      if (current?.consumedAlertId === input.alertId) {
        return { ok: true, authorization: current, replay: true };
      }
      return {
        ok: false,
        reasonCode: "CANARY_AUTHORIZATION_ALREADY_CONSUMED",
        message: "The authorization was consumed concurrently by another signal.",
      };
    }

    return {
      ok: true,
      authorization: await this.prisma.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: existing.id } }),
      replay: false,
    };
  }

  /** Records which execution a consumed authorization produced. */
  async bindExecution(authorizationId: string, executionId: string): Promise<void> {
    await this.prisma.executionCanaryAuthorization.updateMany({
      where: { id: authorizationId, consumedExecutionId: null },
      data: { consumedExecutionId: executionId },
    });
  }

  /** Revokes every unused authorization for a profile. Returns how many. */
  async revokeUnused(executionProfileId: string, now = new Date(), client: AuthorizationReader = this.prisma): Promise<number> {
    const revoked = await client.executionCanaryAuthorization.updateMany({
      where: { executionProfileId, consumedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    return revoked.count;
  }

  // -------------------------------------------------------------------------
  // Phase 12.2 — NATURAL_WINDOW primitives. NOT WIRED TO PRODUCTION.
  //
  // No CLI, route, worker or execution path calls anything below. They exist so
  // the later admission integration has a reviewed, tested foundation to call
  // from inside the transaction it already holds.
  // -------------------------------------------------------------------------

  /**
   * Opens ONE natural window: a profile-scoped, expiring, revocable
   * authorization for a set of directions with a cumulative claim budget.
   *
   * It creates no token, names no symbol, and touches nothing outside this
   * table — not `ExecutionSafetyPolicy.allowedSymbols`, not the profile gates,
   * not capacity. A natural window authorizes PROFILE + DIRECTION + TIME +
   * BUDGET; which symbols are tradable stays the execution stack's business.
   *
   * Exclusivity is the SAME advisory lock and the SAME predicate exact
   * preparation uses, so an open window of either kind blocks the other.
   */
  async prepareNaturalWindow(input: PrepareNaturalWindowInput): Promise<ExecutionCanaryAuthorization> {
    const now = input.now ?? new Date();

    const directions = normalizeNaturalDirections(input.allowedDirections);
    if (directions === null) {
      throw new NaturalWindowValidationError(
        "A natural window requires at least one direction, and every entry must be LONG or SHORT. " +
          "An empty set is a rejection, never 'all directions'."
      );
    }
    if (!Number.isSafeInteger(input.maxClaims) || input.maxClaims < 1) {
      throw new NaturalWindowValidationError(
        "maxClaims must be a whole number of at least 1. There is deliberately no unlimited mode."
      );
    }
    const ttlMinutes = input.ttlMinutes ?? DEFAULT_AUTHORIZATION_TTL_MINUTES;
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > MAXIMUM_AUTHORIZATION_TTL_MINUTES) {
      throw new NaturalWindowValidationError(
        `ttlMinutes must be between 1 and ${MAXIMUM_AUTHORIZATION_TTL_MINUTES}. A window nobody is watching must shut on its own.`
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CANARY_PREPARE_LOCK_NAMESPACE}::int, ${profileLockKey(
        input.executionProfileId
      )}::int)`;

      await assertNoActiveWindow(tx, input.executionProfileId, now);

      return tx.executionCanaryAuthorization.create({
        data: {
          executionProfileId: input.executionProfileId,
          authorizationType: "NATURAL_WINDOW",
          // Explicitly absent, not merely unset: a natural window names no
          // symbol, no single direction and holds no secret.
          allowedSymbol: null,
          allowedDirection: null,
          tokenHash: null,
          allowedDirections: directions,
          maxClaims: input.maxClaims,
          claimedCount: 0,
          version: 1,
          expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
        },
      });
    });
  }

  /** The open natural window for a profile, if one exists. */
  async findNaturalWindow(
    executionProfileId: string,
    now = new Date()
  ): Promise<ExecutionCanaryAuthorization | null> {
    const row = await this.prisma.executionCanaryAuthorization.findFirst({
      where: {
        executionProfileId,
        authorizationType: "NATURAL_WINDOW",
        revokedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
    });
    // Open means well-formed too: a row that contradicts its own mode is not a
    // window an operator can act on.
    return row !== null && isNaturalWindowOpen(row, now) ? row : null;
  }

  /**
   * Shuts one natural window. Idempotent: revoking an already-revoked window
   * reports false rather than raising, matching how `revokeUnused` treats rows
   * it does not move.
   *
   * Scoped to the profile AND to NATURAL_WINDOW, so it can never touch an exact
   * row. The row is never deleted, `claimedCount` is never reset and the
   * directions and budget stay readable — revocation shuts the door on FUTURE
   * claims and rewrites no history.
   */
  async revokeNaturalWindow(
    executionProfileId: string,
    authorizationId: string,
    now = new Date()
  ): Promise<boolean> {
    const revoked = await this.prisma.executionCanaryAuthorization.updateMany({
      where: {
        id: authorizationId,
        executionProfileId,
        authorizationType: "NATURAL_WINDOW",
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
    return revoked.count === 1;
  }
}

/**
 * Phase 12.2 — the guarded natural claim. NOT CALLED BY PRODUCTION.
 *
 * ## Why it takes a client instead of opening a transaction
 *
 * The claim must eventually commit or roll back TOGETHER with the capacity
 * reservation in `SafetyAdmissionService.attempt()`, which already runs inside
 * one transaction holding a per-profile advisory lock. So this takes that
 * caller's `tx` rather than starting its own: a claim spent on a trade that
 * capacity then refuses is exactly the waste the design exists to prevent.
 *
 * ## What it guarantees ON ITS OWN
 *
 * The conditional `updateMany` is the whole mechanism — a losing writer updates
 * zero rows and is refused. That alone bounds `claimedCount` at `maxClaims` and
 * makes the version CAS authoritative, WITHOUT any lock.
 *
 * ## What it does NOT guarantee on its own
 *
 * Serializing many contenders so that exactly N of N+k succeed in one pass is a
 * property of the CALLER's advisory lock and retry loop, not of this function.
 * Phase 2 deliberately adds no second lock to fake it; see the concurrency
 * tests, which pin the honest contract.
 *
 * On success `claimedCount` and `version` each increment by one. `consumedAt`,
 * `consumedAlertId` and `consumedExecutionId` are NEVER touched — those belong
 * to one-shot exact consumption, and a natural claim is a cumulative counter.
 * There is no path here or anywhere that decrements `claimedCount`.
 */
export async function claimNaturalWindow(
  client: Prisma.TransactionClient,
  input: ClaimNaturalWindowInput
): Promise<NaturalClaimResult> {
  const refuse = (reasonCode: NaturalClaimFailure, message: string): NaturalClaimResult => ({
    ok: false,
    reasonCode,
    message,
  });

  const window = await client.executionCanaryAuthorization.findUnique({
    where: { id: input.authorizationId },
  });
  if (!window) return refuse("NATURAL_WINDOW_NOT_FOUND", "No authorization exists with that id.");

  // Structure before state before identity before version, so the reported
  // reason names the most decisive problem rather than the first one checked.
  if (window.authorizationType !== "NATURAL_WINDOW") {
    return refuse("NOT_NATURAL", "The authorization is not a natural window.");
  }
  if (!isNaturalWindow(window)) {
    return refuse("MALFORMED_NATURAL_WINDOW", "The natural window contradicts its own declared mode.");
  }

  const state = naturalWindowState(window, input.evaluatedAt);
  if (state === "REVOKED") return refuse("REVOKED", "The natural window was revoked.");
  if (state === "EXPIRED") return refuse("EXPIRED", "The natural window has expired.");
  if (state === "EXHAUSTED") {
    return refuse(
      "EXHAUSTED",
      `The natural window has spent its whole budget (${window.claimedCount}/${window.maxClaims}).`
    );
  }

  if (!naturalWindowAdmitsDirection(window, input.direction, input.evaluatedAt)) {
    return refuse(
      "DIRECTION_NOT_ALLOWED",
      `The window admits ${window.allowedDirections.join("/")}, not ${String(input.direction).toUpperCase()}.`
    );
  }

  if (window.version !== input.expectedVersion) {
    return refuse("VERSION_CONFLICT", "The window changed after it was evaluated.");
  }

  // --- The atomic claim ----------------------------------------------------
  //
  // Prisma cannot compare two columns, so `claimedCount < maxClaims` is
  // expressed against the budget READ above, as a literal. That substitution is
  // only honest if the row still holds the budget it was read with — so the
  // predicate ALSO asserts `maxClaims` equals that value.
  //
  // Leaning on the version guard alone would be wrong. It proves `version` did
  // not move; it does not prove `maxClaims` did not. A write that shrank the
  // budget without bumping the version — a manual correction, a repair script,
  // a future code path that forgets the convention — would leave the stale
  // literal authorizing a spend the current row can no longer afford:
  //
  //     read    maxClaims 5, claimedCount 0, version 3   -> AVAILABLE
  //     meanwhile              maxClaims 2, claimedCount 2, version 3
  //     update  claimedCount(2) < 5 and version = 3      -> would GRANT
  //             leaving claimedCount 3 against a budget of 2
  //
  // The equality costs one clause and removes the dependency on every future
  // writer remembering to bump a counter. On a real-money primitive that trade
  // is not close.
  const claimed = await client.executionCanaryAuthorization.updateMany({
    where: {
      id: window.id,
      authorizationType: "NATURAL_WINDOW",
      revokedAt: null,
      expiresAt: { gt: input.evaluatedAt },
      // The budget must still be the one the ceiling below was derived from.
      maxClaims: window.maxClaims,
      claimedCount: { lt: window.maxClaims },
      version: input.expectedVersion,
    },
    data: { claimedCount: { increment: 1 }, version: { increment: 1 } },
  });

  if (claimed.count !== 1) {
    // Another writer won between the read and the update. Nothing was spent.
    return refuse("VERSION_CONFLICT", "The window was claimed concurrently by another evaluation.");
  }

  return {
    ok: true,
    authorization: await client.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } }),
  };
}

/**
 * The single definition of "active", used by every reader.
 *
 * All three must hold. Any one of them failing means the authorization can
 * never admit a signal again, whatever else is true of the row.
 */
export function isAuthorizationActive(authorization: ExecutionCanaryAuthorization, now = new Date()): boolean {
  return authorization.consumedAt === null && authorization.revokedAt === null && authorization.expiresAt > now;
}

/**
 * Sanitized view for operator output — never the token or its hash.
 *
 * `prepared` means "an authorization is ACTIVE", not "a row exists". The
 * earlier version conflated the two and could print `prepared = true` beside
 * `revoked = true`, which reads as an open window that is also shut. An
 * operator glancing at that line has to reason about a contradiction at
 * exactly the moment they should not have to.
 */
export interface CanaryAuthorizationStatus {
  /** True only when an ACTIVE authorization exists. */
  prepared: boolean;
  /** Fields of the active authorization, or of the latest record for context. */
  symbol: string | null;
  direction: string | null;
  expiresAt: string | null;
  expired: boolean;
  consumed: boolean;
  revoked: boolean;
  /** Never above 1. Shown so an operator can see the invariant holding. */
  activeCount: number;
  /** Historical rows are never deleted; this is how many exist. */
  onRecord: number;
  /** True when nothing is active but history exists — the "shut window" case. */
  latestIsHistoricalOnly: boolean;
}

const EMPTY_STATUS: CanaryAuthorizationStatus = {
  prepared: false,
  symbol: null,
  direction: null,
  expiresAt: null,
  expired: false,
  consumed: false,
  revoked: false,
  activeCount: 0,
  onRecord: 0,
  latestIsHistoricalOnly: false,
};

/**
 * Describes the whole authorization window from every record on file.
 *
 * When nothing is active the latest historical row is still shown — an
 * operator wants to know what the last window was for — but `prepared` is
 * false and `activeCount` is zero, so the state cannot be misread.
 */
export function describeAuthorizationWindow(
  authorizations: ExecutionCanaryAuthorization[],
  now = new Date()
): CanaryAuthorizationStatus {
  if (authorizations.length === 0) return EMPTY_STATUS;

  const byNewest = [...authorizations].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const active = byNewest.filter((entry) => isAuthorizationActive(entry, now));
  const shown = active[0] ?? byNewest[0];

  return {
    prepared: active.length > 0,
    symbol: shown.allowedSymbol,
    direction: shown.allowedDirection,
    expiresAt: shown.expiresAt.toISOString(),
    expired: shown.expiresAt <= now,
    consumed: shown.consumedAt !== null,
    revoked: shown.revokedAt !== null,
    activeCount: active.length,
    onRecord: authorizations.length,
    latestIsHistoricalOnly: active.length === 0,
  };
}

/** Single-row convenience wrapper. `prepared` still means ACTIVE. */
export function describeAuthorization(
  authorization: ExecutionCanaryAuthorization | null,
  now = new Date()
): CanaryAuthorizationStatus {
  return describeAuthorizationWindow(authorization ? [authorization] : [], now);
}

/** Never let a Prisma unique collision surface as an opaque crash. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
