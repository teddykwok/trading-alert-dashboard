import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { ExecutionCanaryAuthorization, PrismaClient } from "@prisma/client";
import { profileLockKey } from "./safety-admission.service";

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
const CANARY_PREPARE_LOCK_NAMESPACE = 0x11b0;

/** Raised when a profile already holds an authorization that is still usable. */
export class CanaryAuthorizationAlreadyActiveError extends Error {
  readonly reasonCode = "CANARY_AUTHORIZATION_ALREADY_ACTIVE";

  constructor(readonly existing: ExecutionCanaryAuthorization) {
    super(
      `An active canary authorization already exists for ${existing.allowedSymbol} ${existing.allowedDirection} ` +
        `(expires ${existing.expiresAt.toISOString()}). Run execution:disarm-canary first.`
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
] as const;

export type AuthorizationFailure = (typeof AUTHORIZATION_FAILURES)[number];

export type ConsumeResult =
  | { ok: true; authorization: ExecutionCanaryAuthorization; replay: boolean }
  | { ok: false; reasonCode: AuthorizationFailure; message: string };

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

      const active = await tx.executionCanaryAuthorization.findFirst({
        where: {
          executionProfileId: input.executionProfileId,
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: "desc" },
      });
      if (active) throw new CanaryAuthorizationAlreadyActiveError(active);

      const created = await tx.executionCanaryAuthorization.create({
        data: {
          executionProfileId: input.executionProfileId,
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
  async countActive(executionProfileId: string, now = new Date()): Promise<number> {
    return this.prisma.executionCanaryAuthorization.count({
      where: { executionProfileId, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
    });
  }

  /** The single active (unconsumed, unrevoked, unexpired) authorization, if any. */
  async findActive(executionProfileId: string, now = new Date()): Promise<ExecutionCanaryAuthorization | null> {
    return this.prisma.executionCanaryAuthorization.findFirst({
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
  async listForProfile(executionProfileId: string): Promise<ExecutionCanaryAuthorization[]> {
    return this.prisma.executionCanaryAuthorization.findMany({
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
  async revokeUnused(executionProfileId: string, now = new Date()): Promise<number> {
    const revoked = await this.prisma.executionCanaryAuthorization.updateMany({
      where: { executionProfileId, consumedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    return revoked.count;
  }
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
