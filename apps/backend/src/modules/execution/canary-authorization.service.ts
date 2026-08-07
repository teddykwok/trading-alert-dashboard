import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { ExecutionCanaryAuthorization, PrismaClient } from "@prisma/client";

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
   */
  async prepare(input: PrepareInput): Promise<PrepareResult> {
    const now = input.now ?? new Date();
    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol) throw new Error("A canary authorization requires a symbol.");
    if (input.direction !== "LONG" && input.direction !== "SHORT") {
      throw new Error("A canary authorization requires direction LONG or SHORT.");
    }

    const token = generateCanaryToken();
    const authorization = await this.prisma.executionCanaryAuthorization.create({
      data: {
        executionProfileId: input.executionProfileId,
        allowedSymbol: symbol,
        allowedDirection: input.direction,
        tokenHash: hashCanaryToken(token),
        expiresAt: new Date(now.getTime() + (input.ttlMinutes ?? DEFAULT_AUTHORIZATION_TTL_MINUTES) * 60_000),
      },
    });

    return { authorization, token };
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

/** Sanitized view for operator output — never the token or its hash. */
export interface CanaryAuthorizationStatus {
  prepared: boolean;
  symbol: string | null;
  direction: string | null;
  expiresAt: string | null;
  expired: boolean;
  consumed: boolean;
  revoked: boolean;
}

export function describeAuthorization(
  authorization: ExecutionCanaryAuthorization | null,
  now = new Date()
): CanaryAuthorizationStatus {
  if (!authorization) {
    return { prepared: false, symbol: null, direction: null, expiresAt: null, expired: false, consumed: false, revoked: false };
  }
  return {
    prepared: true,
    symbol: authorization.allowedSymbol,
    direction: authorization.allowedDirection,
    expiresAt: authorization.expiresAt.toISOString(),
    expired: authorization.expiresAt <= now,
    consumed: authorization.consumedAt !== null,
    revoked: authorization.revokedAt !== null,
  };
}

/** Never let a Prisma unique collision surface as an opaque crash. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
