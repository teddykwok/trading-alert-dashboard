import { Prisma } from "@prisma/client";
import type { PrismaClient, TradingSession } from "@prisma/client";

import {
  derivedSessionStatus,
  releasesSessionSlot,
  remainingSessionBudget,
  sessionAdmissionState,
  type SessionAdmissionRefusal,
} from "./trading-session";

/**
 * Durable session accounting.
 *
 * ## The three hooks, and why there are only three
 *
 *   RESERVE  at admission, inside the SAME transaction and profile advisory
 *            lock that already reserves capacity, risk and margin. A slot is
 *            taken before an entry can possibly fill.
 *   OPEN     when an execution first obtains non-zero exposure, inside the
 *            SAME transaction that sets `firstFillAt`.
 *   RELEASE  when an execution reaches a terminal status having never filled.
 *
 * Each hook takes a transaction client, so session accounting commits or rolls
 * back with the lifecycle change that caused it. There is no window in which a
 * slot is reserved but the admission failed, or an execution is filled but its
 * slot is still RESERVED.
 *
 * ## Idempotency is the database's job, not the caller's
 *
 * `TradingSessionSlot.tradeExecutionId` is UNIQUE. That single constraint is
 * what makes every hook safe to attempt repeatedly: an execution cannot reserve
 * twice, and first-fill accounting can run from the normal reconcile, from
 * startup recovery, from an offline fill discovered after a restart or from a
 * cancel-lost race without ever counting the same trade again. No caller has to
 * remember to check first.
 *
 * ## Counters are maintained, never trusted alone
 *
 * `openedCount` and `reservedCount` exist so admission can decide with one
 * read, but they are only ever moved by a conditional UPDATE guarded on the
 * slot transition actually having happened. A counter is a cache of the slot
 * rows; the slot rows are the truth.
 */

/** Anything that can run a query inside a transaction. */
type Db = Pick<PrismaClient, "tradingSession" | "tradingSessionSlot" | "$executeRaw">;

export type SessionReservation =
  | { reserved: true; sessionId: string; slotId: string }
  | { reserved: false; reasonCode: SessionAdmissionRefusal; message: string };

export interface SessionView {
  id: string;
  status: string;
  tradeBudget: number | null;
  unlimited: boolean;
  openedCount: number;
  reservedCount: number;
  remaining: number | null;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
}

export function toSessionView(session: TradingSession, now: Date): SessionView {
  return {
    id: session.id,
    // Derived, so a session that ran out of time while nothing was watching
    // still reports EXPIRED the moment it is read.
    status: derivedSessionStatus(session, now),
    tradeBudget: session.tradeBudget,
    unlimited: session.unlimited,
    openedCount: session.openedCount,
    reservedCount: session.reservedCount,
    remaining: remainingSessionBudget(session),
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    endedAt: session.endedAt,
  };
}

/** The newest session for a profile, whatever its state. */
export async function findCurrentSession(
  db: Db,
  executionProfileId: string
): Promise<TradingSession | null> {
  return db.tradingSession.findFirst({
    where: { executionProfileId },
    // Ordered by `createdAt`, NOT `startedAt`.
    //
    // Both are written at the same moment, but only one of them is beyond an
    // application's reach: `createdAt` is `@default(now())` and is never set by
    // any caller, so it is the DATABASE's clock. `startedAt` is supplied by
    // Start Trading, so that a session's expiry and its window's expiry can be
    // derived from one instant — which means a backend whose clock had stepped
    // backwards could write a new session with a `startedAt` earlier than an
    // older one and make "newest" wrong.
    //
    // Ordering on the database's own clock keeps that impossible, and costs
    // nothing: the two values differ by milliseconds on every row.
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Takes one slot, or explains why it cannot.
 *
 * ## The race, and how it is resolved
 *
 * Two alerts reaching the last slot at the same instant must produce one
 * reservation and one refusal. That is settled by a CONDITIONAL UPDATE, not by
 * reading a count and writing it back:
 *
 *   UPDATE ... SET reservedCount = reservedCount + 1
 *   WHERE id = ? AND status = 'ACTIVE' AND expiresAt > now
 *     AND (unlimited OR openedCount + reservedCount < tradeBudget)
 *
 * Postgres evaluates that predicate against the row it is about to write, so
 * exactly one of two concurrent statements can match. The loser sees
 * `count === 0` and is refused. This holds without a new lock, across
 * processes, and would still hold if a second worker were ever introduced.
 *
 * In practice this also runs under the profile advisory lock the admission
 * transaction already holds — but it does not DEPEND on that lock, which is
 * what makes it safe if the lock's scope ever changes.
 */
export async function reserveSessionSlot(
  db: Db,
  input: {
    executionProfileId: string;
    /**
     * The session the AUTHORIZING window is linked to.
     *
     * Targeted by id rather than by "the newest session for this profile": an
     * older window must never be able to spend a newer session's budget, and
     * a stale window whose own session ended must refuse rather than silently
     * adopting whatever session happens to be current.
     */
    tradingSessionId: string | null;
    tradeExecutionId: string;
    now: Date;
  }
): Promise<SessionReservation> {
  // A session-backed window always names its session. A null here means the
  // link was lost, and that is refused rather than guessed at — falling back
  // to the profile's newest session would be exactly the silent substitution
  // this parameter exists to prevent.
  if (input.tradingSessionId === null) {
    return {
      reserved: false,
      reasonCode: "SESSION_REQUIRED",
      message: "This authorization names no trading session, so no new trade may be admitted.",
    };
  }

  const session = await db.tradingSession.findUnique({ where: { id: input.tradingSessionId } });
  if (!session || session.executionProfileId !== input.executionProfileId) {
    // Missing, or belonging to another profile. Fail closed: never fall back
    // to unlimited admissions because the session could not be found.
    return {
      reserved: false,
      reasonCode: "SESSION_REQUIRED",
      message: "The trading session for this authorization could not be read, so nothing is admitted.",
    };
  }

  // Cheap, honest pre-check: it produces the SPECIFIC refusal reason. The
  // conditional update below is what actually enforces the budget.
  const state = sessionAdmissionState(session, input.now);
  if (!state.admits) {
    return { reserved: false, reasonCode: state.reasonCode, message: state.message };
  }

  // An execution that already holds a slot keeps it. A redelivered admission
  // must not take a second one.
  const existing = await db.tradingSessionSlot.findUnique({
    where: { tradeExecutionId: input.tradeExecutionId },
  });
  if (existing) {
    return existing.state === "RELEASED"
      ? {
          reserved: false,
          reasonCode: "SESSION_BUDGET_EXHAUSTED",
          message: "This execution's session slot was already released; it is not re-reserved.",
        }
      : { reserved: true, sessionId: existing.tradingSessionId, slotId: existing.id };
  }

  /**
   * Raw SQL, deliberately.
   *
   * The predicate has to compare the row against ITSELF —
   * `openedCount + reservedCount < tradeBudget` — and Prisma's `where` can only
   * compare a column to a VALUE. Writing it in Prisma meant capturing the sum
   * read a moment earlier and comparing against that constant, which is exactly
   * the read-then-write race this feature exists to prevent: sixty concurrent
   * callers all read 0, all matched, and all incremented. A test caught it.
   *
   * Postgres evaluates this predicate against the current row under the row
   * lock the UPDATE itself takes, so concurrent statements serialize and only
   * as many as there is budget for can match.
   */
  const claimed = await db.$executeRaw`
    UPDATE "TradingSession"
    SET "reservedCount" = "reservedCount" + 1,
        "version" = "version" + 1,
        "updatedAt" = NOW()
    WHERE "id" = ${session.id}
      AND "status" = 'ACTIVE'
      AND "expiresAt" > ${input.now}
      AND ("unlimited" = true OR "openedCount" + "reservedCount" < "tradeBudget")
  `;

  if (claimed === 0) {
    // Lost the race, or the session changed underneath. Re-read so the reason
    // describes what is true now rather than what was true a moment ago.
    const fresh = await db.tradingSession.findUnique({ where: { id: session.id } });
    const refusal = fresh
      ? sessionAdmissionState(fresh, input.now)
      : ({ admits: false, reasonCode: "SESSION_REQUIRED", message: "The session disappeared." } as const);
    return refusal.admits
      ? {
          reserved: false,
          reasonCode: "SESSION_BUDGET_EXHAUSTED",
          message: "Another trade took the last session slot.",
        }
      : { reserved: false, reasonCode: refusal.reasonCode, message: refusal.message };
  }

  try {
    const slot = await db.tradingSessionSlot.create({
      data: { tradingSessionId: session.id, tradeExecutionId: input.tradeExecutionId, state: "RESERVED" },
    });
    return { reserved: true, sessionId: session.id, slotId: slot.id };
  } catch (error) {
    // A concurrent writer created the slot between the lookup and here. Give
    // back the increment we just took and adopt their row: one execution, one
    // slot, and the budget stays exact.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      await db.tradingSession.updateMany({
        where: { id: session.id, reservedCount: { gt: 0 } },
        data: { reservedCount: { decrement: 1 }, version: { increment: 1 } },
      });
      const adopted = await db.tradingSessionSlot.findUnique({
        where: { tradeExecutionId: input.tradeExecutionId },
      });
      if (adopted && adopted.state !== "RELEASED") {
        return { reserved: true, sessionId: adopted.tradingSessionId, slotId: adopted.id };
      }
      return {
        reserved: false,
        reasonCode: "SESSION_BUDGET_EXHAUSTED",
        message: "The session slot for this execution could not be established.",
      };
    }
    throw error;
  }
}

/**
 * Converts a reservation into an opened trade, exactly once.
 *
 * Called from the one transaction that sets `firstFillAt`, so every path that
 * can discover a first fill — normal reconcile, startup recovery, an offline
 * fill found after a restart, a cancel that lost to a fill — accounts for it
 * without any of them needing to know this exists.
 *
 * The conditional `state: "RESERVED"` is the idempotency: a second call finds
 * the slot already OPENED, matches nothing, and moves no counter. A trade
 * closing later never returns here, so `openedCount` only ever rises.
 */
export async function openSessionSlot(
  db: Db,
  input: { tradeExecutionId: string; openedAt: Date }
): Promise<{ opened: boolean; sessionId: string | null }> {
  const slot = await db.tradingSessionSlot.findUnique({
    where: { tradeExecutionId: input.tradeExecutionId },
  });
  // No slot means this execution predates sessions, or was admitted under a
  // legacy authorization. Accounting stays silent rather than inventing one.
  if (!slot || slot.state !== "RESERVED") return { opened: false, sessionId: slot?.tradingSessionId ?? null };

  const moved = await db.tradingSessionSlot.updateMany({
    where: { id: slot.id, state: "RESERVED" },
    data: { state: "OPENED", openedAt: input.openedAt },
  });
  if (moved.count === 0) return { opened: false, sessionId: slot.tradingSessionId };

  // The slot moved, so the counters move with it, in the same transaction.
  await db.tradingSession.updateMany({
    where: { id: slot.tradingSessionId, reservedCount: { gt: 0 } },
    data: { reservedCount: { decrement: 1 }, openedCount: { increment: 1 }, version: { increment: 1 } },
  });
  return { opened: true, sessionId: slot.tradingSessionId };
}

/**
 * Gives a slot back, exactly once.
 *
 * Only ever called for an execution that reached a terminal status having
 * never filled — `releasesSessionSlot` requires `firstFillAt` to be null, so a
 * partially filled entry that is later cancelled keeps its opened trade. A
 * trade that touched the exchange is not refundable.
 */
export async function releaseSessionSlot(
  db: Db,
  input: { tradeExecutionId: string; releasedAt: Date; reason: string }
): Promise<{ released: boolean; sessionId: string | null }> {
  const slot = await db.tradingSessionSlot.findUnique({
    where: { tradeExecutionId: input.tradeExecutionId },
  });
  if (!slot || slot.state !== "RESERVED") return { released: false, sessionId: slot?.tradingSessionId ?? null };

  const moved = await db.tradingSessionSlot.updateMany({
    where: { id: slot.id, state: "RESERVED" },
    data: {
      state: "RELEASED",
      releasedAt: input.releasedAt,
      // A reason code, never a raw error: this is operator-facing evidence.
      releaseReason: input.reason.slice(0, 200),
    },
  });
  if (moved.count === 0) return { released: false, sessionId: slot.tradingSessionId };

  await db.tradingSession.updateMany({
    where: { id: slot.tradingSessionId, reservedCount: { gt: 0 } },
    data: { reservedCount: { decrement: 1 }, version: { increment: 1 } },
  });
  return { released: true, sessionId: slot.tradingSessionId };
}

/**
 * Applies whichever accounting a terminal execution status calls for.
 *
 * One entry point so lifecycle callers do not have to reason about which hook
 * applies — they report what happened and this decides. Safe to call for any
 * status, including ones that mean nothing to sessions.
 */
export async function applySessionAccountingForStatus(
  db: Db,
  input: { tradeExecutionId: string; status: string; firstFillAt: Date | null; now: Date }
): Promise<void> {
  if (input.firstFillAt !== null) {
    await openSessionSlot(db, { tradeExecutionId: input.tradeExecutionId, openedAt: input.firstFillAt });
    return;
  }
  if (releasesSessionSlot(input.status, input.firstFillAt)) {
    await releaseSessionSlot(db, {
      tradeExecutionId: input.tradeExecutionId,
      releasedAt: input.now,
      reason: input.status,
    });
  }
}

/**
 * Ends the current session, if one is running.
 *
 * Called from Stop New Trades and from Safe Off — the controls an operator
 * already uses — rather than adding a competing stop. Revoking prohibits new
 * RESERVATIONS and nothing else:
 *
 *   - `openedCount` is untouched, so the session's history survives;
 *   - slots already RESERVED are left alone, so an entry still on the book
 *     resolves normally and converts to OPENED if it fills;
 *   - no execution is cancelled and no position is closed.
 *
 * Idempotent: a second call finds no ACTIVE row and changes nothing.
 */
export async function revokeCurrentSession(
  db: Db,
  executionProfileId: string,
  now: Date
): Promise<{ revoked: boolean; sessionId: string | null }> {
  // Asks for the ACTIVE session directly rather than for the newest one and
  // then checking whether it happens to be active.
  //
  // Start Trading guarantees at most one ACTIVE session per profile, so these
  // are the same row — but the first phrasing cannot be wrong even if that
  // guarantee were ever broken or if two rows sorted unexpectedly, and this is
  // the path Stop New Trades and Safe Off depend on.
  const session = await db.tradingSession.findFirst({
    where: { executionProfileId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });
  if (!session) return { revoked: false, sessionId: null };

  const moved = await db.tradingSession.updateMany({
    where: { id: session.id, status: "ACTIVE" },
    data: { status: "REVOKED", endedAt: now, version: { increment: 1 } },
  });
  return { revoked: moved.count > 0, sessionId: session.id };
}
