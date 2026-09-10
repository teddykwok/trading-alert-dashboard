import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import { USER_TRADES_MAX_WINDOW_MS } from "../binance/user-trades-window-planner";

/**
 * Durable work state for bounded userTrades ingestion.
 *
 * This module owns the STATE MACHINE and nothing else. It issues no Binance
 * request, calls no ledger, schedules nothing and has no runtime caller: it is
 * the substrate a future executor will sit on, and it is deliberately testable
 * against a real database without either of those existing yet.
 *
 * ## What a window is
 *
 * One authoritative bounded SWEEP interval of one symbol's fill history in one
 * account, and whether that interval has been PROVEN exhausted. Roots are
 * deterministic intervals; a saturated parent bisects into exactly two children
 * that tile it. Completeness is DERIVED by walking those rows -- there is no
 * high-water cursor anywhere, because a second writable source of truth can
 * disagree with the first, and it would disagree in the dangerous direction.
 *
 * ## Transaction ownership -- read this before adding a method
 *
 * Every method here is one of exactly three kinds, and the kind is stated on
 * each one. There is no "maybe it uses the pooled client":
 *
 *  - PURE CAS: takes the client to use. One statement or a read followed by one
 *    conditional statement, so it is atomic whether the caller hands it the
 *    pooled client or an open transaction.
 *  - REQUIRES A CALLER TRANSACTION: multi-statement and only correct inside
 *    one. Takes `Prisma.TransactionClient` and opens nothing.
 *  - OWNS A TRANSACTION: convenience wrapper that opens exactly one and
 *    delegates. Never call it from inside another transaction.
 *
 * The future executor's shape is what this is built for:
 *
 *   BEGIN
 *     ledger.ingestUserTradesInTransaction(tx, ...)
 *     work.markComplete(tx, claim)
 *   COMMIT
 */

/** Attempts a window may spend before it is abandoned as untrustworthy. */
export const MAX_INGEST_ATTEMPTS = 5;

/**
 * How long a claim is honoured before another worker may take the row.
 *
 * Matches the delivery lease the notification dispatcher already uses. One
 * claim covers exactly one unit of work, so this only has to outlast a single
 * bounded exchange request and the transaction that records its result.
 */
export const INGEST_CLAIM_LEASE_MS = 60_000;

/**
 * How many eligible rows a single claim attempt will look at.
 *
 * NOT a bulk claim: exactly one row is ever claimed. This only decides how many
 * candidates are tried before giving up when other workers keep winning the
 * race, so a busy pool does not report "no work" while work exists.
 */
export const CLAIM_CANDIDATE_SCAN = 5;

/** Stable terminal reasons. Codes, never messages, and never a raw payload. */
export const FILL_INGEST_REASON = {
  /** The attempt budget ran out on an attempt that reported its own failure. */
  ATTEMPT_BUDGET_EXHAUSTED: "ATTEMPT_BUDGET_EXHAUSTED",
  /** The attempt budget ran out on an attempt that never came back. */
  ATTEMPT_BUDGET_EXHAUSTED_AFTER_STALE_LEASE: "ATTEMPT_BUDGET_EXHAUSTED_AFTER_STALE_LEASE",
  /** A returned economic row could not be represented, so the interval has a hole. */
  LEDGER_ROW_NOT_REPRESENTABLE: "LEDGER_ROW_NOT_REPRESENTABLE",
  /** A full page inside one millisecond: exhaustion is unprovable by time-windowing. */
  SATURATED_SINGLE_MILLISECOND: "SATURATED_SINGLE_MILLISECOND",
} as const;

export type FillIngestReasonCode = (typeof FILL_INGEST_REASON)[keyof typeof FILL_INGEST_REASON];

/**
 * A window whose bounds could never be a legal question for the exchange.
 *
 * Refused in the service rather than left to the database so the caller gets a
 * named reason; the CHECK constraints remain as the backstop for anything that
 * reaches SQL by another route.
 */
export class FillIngestWindowRefusedError extends Error {
  readonly reasonCode = "FILL_INGEST_WINDOW_REFUSED";

  constructor(
    readonly detail: string,
    readonly startTimeMs: unknown,
    readonly endTimeMs: unknown
  ) {
    super(`Refused window [${String(startTimeMs)}, ${String(endTimeMs)}]: ${detail}`);
    this.name = "FillIngestWindowRefusedError";
  }
}

/**
 * A mutation presented by a worker that no longer holds the claim.
 *
 * THE load-bearing failure of this module. A worker whose lease expired while
 * its HTTP request was in flight comes back holding an answer about a window
 * another worker has since re-claimed; letting it write would advance durable
 * coverage from a stale observation. Raised rather than returned as a
 * falsy-success, so a caller inside a transaction aborts instead of committing.
 */
export class StaleFillIngestClaimError extends Error {
  readonly reasonCode = "FILL_INGEST_STALE_CLAIM";
  /** The work is not lost -- another attempt owns it. Never retry as this one. */
  readonly retryable = false;

  constructor(
    readonly windowId: string,
    readonly expectedAttempt: number,
    readonly detail = "the claim generation no longer matches"
  ) {
    super(
      `Window ${windowId} attempt ${expectedAttempt} may not act: ${detail}. ` +
        `Nothing was written.`
    );
    this.name = "StaleFillIngestClaimError";
  }
}

/** A split whose child already exists under a different parent. */
export class FillIngestChildLineageError extends Error {
  readonly reasonCode = "FILL_INGEST_CHILD_LINEAGE_CONFLICT";

  constructor(
    readonly windowId: string,
    readonly childId: string,
    readonly foundParentId: string | null
  ) {
    super(
      `Child ${childId} already exists under parent ${String(foundParentId)}, not ${windowId}; ` +
        `the split was refused and nothing was written.`
    );
    this.name = "FillIngestChildLineageError";
  }
}

/** An inclusive integer-millisecond interval, exactly as the planner speaks. */
export interface FillIngestWindowBounds {
  startTimeMs: number;
  endTimeMs: number;
}

/** Proof that this caller holds the current attempt on one window. */
export interface FillIngestWindowClaim extends FillIngestWindowBounds {
  windowId: string;
  executionProfileId: string;
  symbol: string;
  /** The fencing token. Every later mutation must present exactly this. */
  attempt: number;
  claimOwner: string;
}

export type RetryableFailureOutcome = "PENDING" | "ABANDONED";

/**
 * Exact millisecond bounds, or a named refusal.
 *
 * Checked BEFORE anything becomes a BigInt: a value JavaScript cannot hold
 * exactly has already lost the identity it is supposed to carry, so widening it
 * would only make the wrong number durable.
 */
export function assertBounds(startTimeMs: number, endTimeMs: number): void {
  const refuse = (detail: string): never => {
    throw new FillIngestWindowRefusedError(detail, startTimeMs, endTimeMs);
  };
  if (!Number.isSafeInteger(startTimeMs) || !Number.isSafeInteger(endTimeMs)) {
    refuse("bounds must be safe integer milliseconds");
  }
  if (startTimeMs < 0 || endTimeMs < 0) refuse("a millisecond before the epoch is not a time");
  if (endTimeMs < startTimeMs) refuse("the interval ends before it starts");
  if (endTimeMs - startTimeMs > USER_TRADES_MAX_WINDOW_MS) {
    refuse(`the span exceeds the documented ${USER_TRADES_MAX_WINDOW_MS}ms maximum`);
  }
}

/** BigInt back to the exact number the planner works in, or a refusal. */
export function toMs(value: bigint): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new FillIngestWindowRefusedError("stored bound is not a safe integer", value, value);
  }
  return asNumber;
}

/** Every column a terminal transition must leave settled. */
const TERMINAL_CLEARED = {
  claimedAt: null,
  claimOwner: null,
  nextEligibleAt: null,
} as const;

export class ExchangeFillIngestWindowService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * PURE CAS. Records one exact interval, once.
   *
   * Idempotent through the natural unique key rather than through a caller's
   * check, because the callers that matter are precisely the ones running again
   * after a restart. `skipDuplicates` is correct HERE and nowhere near the fill
   * ledger: a window row carries bounds and no economic facts, so a row that
   * already exists under the same natural key IS this row, and there is nothing
   * to compare.
   *
   * Deliberately exact-interval only. Day grids, retention horizons and symbol
   * discovery are seeding POLICY and belong to a later pure module; this
   * primitive exists to make whatever that policy decides restart-safe.
   */
  async seedWindow(
    client: Prisma.TransactionClient,
    input: { executionProfileId: string; symbol: string } & FillIngestWindowBounds
  ): Promise<{ id: string; created: boolean }> {
    assertBounds(input.startTimeMs, input.endTimeMs);
    const identity = {
      executionProfileId: input.executionProfileId,
      symbol: input.symbol,
      startTimeMs: BigInt(input.startTimeMs),
      endTimeMs: BigInt(input.endTimeMs),
    };

    const inserted = await client.exchangeFillIngestWindow.createMany({
      data: [identity],
      skipDuplicates: true,
    });

    const row = await client.exchangeFillIngestWindow.findUniqueOrThrow({
      where: {
        executionProfileId_symbol_startTimeMs_endTimeMs: identity,
      },
      select: { id: true },
    });

    return { id: row.id, created: inserted.count === 1 };
  }

  /**
   * PURE CAS. Leases exactly ONE window, immediately before its caller would
   * spend one exchange request on it.
   *
   * Just-in-time on purpose. Claiming a batch and working through it makes
   * every lease after the first a statement about a moment that has passed: by
   * the time the twentieth row is reached its lease may have expired, another
   * worker may hold it, and both would issue the same request.
   *
   * `attempts` increments HERE, not on failure. A worker that dies mid-request
   * has still spent an attempt, so a window that reliably kills its worker
   * cannot loop forever -- and the incremented value is handed back as the
   * fencing token that every later mutation must present.
   */
  async claimNextWindow(
    client: Prisma.TransactionClient,
    options: { executionProfileId: string; workerId: string; now?: Date }
  ): Promise<FillIngestWindowClaim | null> {
    const now = options.now ?? new Date();
    const staleBefore = new Date(now.getTime() - INGEST_CLAIM_LEASE_MS);

    const candidates = await client.exchangeFillIngestWindow.findMany({
      where: {
        executionProfileId: options.executionProfileId,
        status: "PENDING",
        attempts: { lt: MAX_INGEST_ATTEMPTS },
        AND: [
          { OR: [{ nextEligibleAt: null }, { nextEligibleAt: { lte: now } }] },
          { OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }] },
        ],
      },
      // Newest first: the most recently settled interval is the one anything
      // downstream is waiting on, and a split child is newer-or-equal to the
      // rest of its region, so a tree is finished before older backlog starts.
      orderBy: [{ startTimeMs: "desc" }, { id: "asc" }],
      take: CLAIM_CANDIDATE_SCAN,
      select: {
        id: true, symbol: true, startTimeMs: true, endTimeMs: true,
        attempts: true, claimedAt: true,
      },
    });

    for (const candidate of candidates) {
      const won = await client.exchangeFillIngestWindow.updateMany({
        where: {
          id: candidate.id,
          status: "PENDING",
          // Both halves of the generation: the exact attempt count we read, and
          // the exact lease we saw. A racing worker changes both, and its
          // change is what makes this update match nothing.
          attempts: candidate.attempts,
          claimedAt: candidate.claimedAt,
        },
        data: {
          attempts: { increment: 1 },
          claimedAt: now,
          claimOwner: options.workerId,
          lastAttemptAt: now,
        },
      });
      if (won.count !== 1) continue;

      return {
        windowId: candidate.id,
        executionProfileId: options.executionProfileId,
        symbol: candidate.symbol,
        startTimeMs: toMs(candidate.startTimeMs),
        endTimeMs: toMs(candidate.endTimeMs),
        attempt: candidate.attempts + 1,
        claimOwner: options.workerId,
      };
    }

    return null;
  }

  /**
   * The fencing predicate every claimed mutation shares.
   *
   * `attempts` is the generation token: it only ever increments, and only
   * inside a successful claim, so a worker holding attempt 4 can never match a
   * row that has been re-claimed as attempt 5. `claimOwner` is corroboration
   * rather than the mechanism -- it costs nothing and makes the intent legible.
   */
  private static fence(claim: FillIngestWindowClaim) {
    return {
      id: claim.windowId,
      status: "PENDING",
      attempts: claim.attempt,
      claimOwner: claim.claimOwner,
    } as const;
  }

  /**
   * PURE CAS. Records that this attempt failed and decides what that costs.
   *
   * Below the budget the row stays PENDING with its lease released and its
   * backoff persisted -- persisted, because an in-process delay dies with the
   * process and a restart after a rate limit would re-request everything at
   * once. At the budget it goes straight to ABANDONED: `attempts` was already
   * incremented at claim, so this attempt WAS the last one and there is nothing
   * left to wait for.
   *
   * A stale claimant is refused. Its failure is not news about a window that
   * someone else is now working.
   */
  async recordRetryableFailure(
    client: Prisma.TransactionClient,
    claim: FillIngestWindowClaim,
    failure: { reasonCode: string; sanitizedError?: string | null; nextEligibleAt?: Date | null }
  ): Promise<RetryableFailureOutcome> {
    const exhausted = claim.attempt >= MAX_INGEST_ATTEMPTS;

    const applied = await client.exchangeFillIngestWindow.updateMany({
      where: ExchangeFillIngestWindowService.fence(claim),
      data: exhausted
        ? {
            status: "ABANDONED",
            ...TERMINAL_CLEARED,
            lastErrorCode: FILL_INGEST_REASON.ATTEMPT_BUDGET_EXHAUSTED,
            sanitizedLastError: failure.sanitizedError ?? null,
          }
        : {
            claimedAt: null,
            claimOwner: null,
            lastErrorCode: failure.reasonCode,
            sanitizedLastError: failure.sanitizedError ?? null,
            nextEligibleAt: failure.nextEligibleAt ?? null,
          },
    });

    if (applied.count !== 1) {
      throw new StaleFillIngestClaimError(claim.windowId, claim.attempt);
    }
    return exhausted ? "ABANDONED" : "PENDING";
  }

  /**
   * PURE CAS. The window is proven exhausted.
   *
   * Designed to be one statement in the caller's transaction, beside the ledger
   * writes it is a claim about: COMPLETE means the page's every representable
   * economic row was durably recorded in the SAME crash-consistent unit, and a
   * separate commit could not mean that.
   *
   * Success clears the transient failure metadata. A window that succeeded on
   * its third try must not read as an error afterwards.
   */
  async markComplete(client: Prisma.TransactionClient, claim: FillIngestWindowClaim): Promise<void> {
    await this.terminate(client, claim, {
      status: "COMPLETE",
      lastErrorCode: null,
      sanitizedLastError: null,
    });
  }

  /**
   * PURE CAS. Terminal KNOWN GAP: the page proved exhaustion, but at least one
   * returned row could not be represented.
   *
   * Deliberately not a retry. A malformed row from the exchange is malformed
   * forever, so retrying would spend the budget reproducing the same hole and
   * end in ABANDONED -- throwing away the completeness of every good row
   * alongside it. The good rows stay recorded; only the CLAIM of wholeness is
   * withheld, and it is withheld explicitly.
   */
  async markIncompleteSkippedRows(
    client: Prisma.TransactionClient,
    claim: FillIngestWindowClaim,
    sanitizedDetail?: string | null
  ): Promise<void> {
    await this.terminate(client, claim, {
      status: "INCOMPLETE_SKIPPED_ROWS",
      lastErrorCode: FILL_INGEST_REASON.LEDGER_ROW_NOT_REPRESENTABLE,
      sanitizedLastError: sanitizedDetail ?? null,
    });
  }

  /**
   * PURE CAS. Terminal KNOWN GAP: a full page inside one millisecond.
   *
   * There is no smaller window to ask for, so time-windowing cannot prove
   * exhaustion at all. Recorded as its own state rather than as COMPLETE,
   * because reporting it as complete would be the same silent loss dressed as
   * a success.
   */
  async markSaturatedSingleMillisecond(
    client: Prisma.TransactionClient,
    claim: FillIngestWindowClaim,
    sanitizedDetail?: string | null
  ): Promise<void> {
    await this.terminate(client, claim, {
      status: "SATURATED_SINGLE_MILLISECOND",
      lastErrorCode: FILL_INGEST_REASON.SATURATED_SINGLE_MILLISECOND,
      sanitizedLastError: sanitizedDetail ?? null,
    });
  }

  /**
   * PURE CAS. Terminal: this attempt learned something a retry cannot repair.
   *
   * The other terminals each describe a specific finding about the interval.
   * This one describes a finding about the EVIDENCE: the exchange contradicted
   * its own contract, the account cannot be read at all, or the economics that
   * came back disagree with economics already recorded under the same immutable
   * identity. Re-asking reproduces it exactly, so spending the rest of the
   * attempt budget to arrive at the same answer only delays the moment an
   * operator can see it.
   *
   * Fenced like every other transition, which is what stops a worker whose
   * lease expired mid-request from abandoning a window another attempt now
   * owns. `attempts` and `lastAttemptAt` are deliberately RETAINED: the
   * abandonment happened on a specific attempt, and erasing how many were spent
   * would hide whether this was a first-look refusal or a worn-out window.
   *
   * ABANDONED is the one terminal an operator is expected to re-open by hand,
   * so the reason is recorded rather than merely the status.
   */
  async markAbandoned(
    client: Prisma.TransactionClient,
    claim: FillIngestWindowClaim,
    reason: { reasonCode: string; sanitizedError?: string | null }
  ): Promise<void> {
    await this.terminate(client, claim, {
      status: "ABANDONED",
      lastErrorCode: reason.reasonCode,
      sanitizedLastError: reason.sanitizedError ?? null,
    });
  }

  /** The shared terminal write: fenced, lease cleared, backoff cleared. */
  private async terminate(
    client: Prisma.TransactionClient,
    claim: FillIngestWindowClaim,
    outcome: {
      status: "COMPLETE" | "INCOMPLETE_SKIPPED_ROWS" | "SATURATED_SINGLE_MILLISECOND" | "ABANDONED";
      lastErrorCode: string | null;
      sanitizedLastError: string | null;
    }
  ): Promise<void> {
    const applied = await client.exchangeFillIngestWindow.updateMany({
      where: ExchangeFillIngestWindowService.fence(claim),
      data: { ...outcome, ...TERMINAL_CLEARED },
    });
    if (applied.count !== 1) {
      throw new StaleFillIngestClaimError(claim.windowId, claim.attempt);
    }
  }

  /**
   * REQUIRES A CALLER TRANSACTION. The parent saturated: bisect it.
   *
   * Both children and the parent's transition commit together or not at all.
   * There is no instant at which a parent is SPLIT with one child, and none at
   * which children exist while the parent is still claimable -- a partially
   * committed split would be a coverage hole that looks like progress.
   *
   * Children INHERIT the account and symbol from the claimed parent; they are
   * never taken from the caller. The caller supplies only the two intervals the
   * planner produced, and even those are checked to tile the parent exactly, so
   * a caller cannot smuggle an unrelated range into an authoritative tree.
   */
  async splitWindowInTransaction(
    tx: Prisma.TransactionClient,
    claim: FillIngestWindowClaim,
    children: { left: FillIngestWindowBounds; right: FillIngestWindowBounds }
  ): Promise<{ leftId: string; rightId: string }> {
    const { left, right } = children;

    /**
     * A single millisecond has no halves.
     *
     * The planner answers SATURATED_SINGLE_MILLISECOND here rather than SPLIT,
     * so reaching this is a caller bug -- but the tree is authoritative, and a
     * caller bug must not be able to put an empty or duplicated child into it.
     */
    if (claim.startTimeMs >= claim.endTimeMs) {
      throw new FillIngestWindowRefusedError(
        "a single-millisecond window has no halves and can never be split",
        claim.startTimeMs,
        claim.endTimeMs
      );
    }

    assertBounds(left.startTimeMs, left.endTimeMs);
    assertBounds(right.startTimeMs, right.endTimeMs);

    /**
     * THE CANONICAL SPLIT, not merely a gap-free one.
     *
     * Checking only that the children tile the parent would accept
     * [0, 25] + [26, 100] for a parent of [0, 100] -- a perfectly gapless
     * partition, and a different tree. That matters because the whole design
     * rests on the split being DETERMINISTIC: a rolled-back split is re-derived
     * from arithmetic and must come back byte-identical for the unique key to
     * absorb it, and two workers bisecting the same parent must produce the
     * same two children rather than two overlapping subdivisions of one
     * interval. An arbitrary partition also terminates unpredictably: halving
     * reaches one millisecond in a bounded number of steps, shaving one does
     * not.
     *
     * The midpoint is duplicated from the planner's private splitter rather
     * than exported from it -- that module is deliberately pure and its
     * splitting stays an internal detail. A test pins the two together for
     * representative windows so the duplication cannot drift silently.
     */
    const mid = claim.startTimeMs + Math.floor((claim.endTimeMs - claim.startTimeMs) / 2);
    if (
      left.startTimeMs !== claim.startTimeMs ||
      left.endTimeMs !== mid ||
      right.startTimeMs !== mid + 1 ||
      right.endTimeMs !== claim.endTimeMs
    ) {
      throw new FillIngestWindowRefusedError(
        `children must be the canonical split of [${claim.startTimeMs}, ${claim.endTimeMs}], ` +
          `which is [${claim.startTimeMs}, ${mid}] and [${mid + 1}, ${claim.endTimeMs}]`,
        left.startTimeMs,
        right.endTimeMs
      );
    }

    const identityOf = (bounds: FillIngestWindowBounds) => ({
      executionProfileId: claim.executionProfileId,
      symbol: claim.symbol,
      startTimeMs: BigInt(bounds.startTimeMs),
      endTimeMs: BigInt(bounds.endTimeMs),
    });
    const leftIdentity = identityOf(left);
    const rightIdentity = identityOf(right);

    /**
     * `skipDuplicates` is safe for a WORK child and would be a defect on the
     * fill ledger. A child carries bounds and no economic facts, and the bounds
     * determine the node uniquely inside one authoritative tree, so a row that
     * already holds this natural key IS this child -- there is nothing to
     * compare and nothing to lose. Never an error, so it cannot abort the
     * caller's transaction either.
     */
    await tx.exchangeFillIngestWindow.createMany({
      data: [
        { ...leftIdentity, parentId: claim.windowId },
        { ...rightIdentity, parentId: claim.windowId },
      ],
      skipDuplicates: true,
    });

    // What actually exists now, and whose it is. `skipDuplicates` kept whatever
    // was already there, so lineage is VERIFIED rather than assumed: converging
    // on a replay of our own split is fine, adopting somebody else's tree is
    // not.
    const settled = await Promise.all(
      [leftIdentity, rightIdentity].map((identity) =>
        tx.exchangeFillIngestWindow.findUniqueOrThrow({
          where: { executionProfileId_symbol_startTimeMs_endTimeMs: identity },
          select: { id: true, parentId: true },
        })
      )
    );
    for (const child of settled) {
      if (child.parentId !== claim.windowId) {
        throw new FillIngestChildLineageError(claim.windowId, child.id, child.parentId);
      }
    }

    const applied = await tx.exchangeFillIngestWindow.updateMany({
      where: ExchangeFillIngestWindowService.fence(claim),
      data: {
        status: "SPLIT",
        ...TERMINAL_CLEARED,
        lastErrorCode: null,
        sanitizedLastError: null,
      },
    });
    if (applied.count !== 1) {
      throw new StaleFillIngestClaimError(claim.windowId, claim.attempt);
    }

    return { leftId: settled[0].id, rightId: settled[1].id };
  }

  /**
   * OWNS A TRANSACTION. The same split for a caller that has none of its own.
   *
   * Never call this from inside another transaction -- use
   * `splitWindowInTransaction` there, so the split commits with whatever else
   * the caller is doing.
   */
  async splitWindow(
    claim: FillIngestWindowClaim,
    children: { left: FillIngestWindowBounds; right: FillIngestWindowBounds }
  ): Promise<{ leftId: string; rightId: string }> {
    return this.prisma.$transaction((tx) => this.splitWindowInTransaction(tx, claim, children));
  }

  /**
   * PURE CAS. Closes the budget on attempts that never came back.
   *
   * The zombie this exists for: a worker claims the LAST attempt, taking the
   * row to `attempts = MAX`, then dies before recording anything. Its lease
   * expires and the row sits PENDING at MAX forever -- the claim query requires
   * `attempts < MAX`, so nothing will ever look at it again, and it silently
   * stops being a known gap that anyone can see.
   *
   * ISSUES NO REQUEST. Pure database work, so it costs no exchange weight and
   * can run at the top of any cycle.
   *
   * A LIVE lease at MAX is deliberately untouched: that worker still has its
   * full lease to come back and report, and taking the row from it would be the
   * same stale-write hazard in reverse. A row at MAX with no lease at all
   * cannot arise from this state machine -- reaching MAX always terminalizes --
   * but it is finalized too, because if one ever exists it is unreachable by
   * every other path.
   */
  async finalizeStaleExhausted(
    client: Prisma.TransactionClient,
    options: { executionProfileId: string; now?: Date; limit?: number }
  ): Promise<string[]> {
    const now = options.now ?? new Date();
    const staleBefore = new Date(now.getTime() - INGEST_CLAIM_LEASE_MS);

    const candidates = await client.exchangeFillIngestWindow.findMany({
      where: {
        executionProfileId: options.executionProfileId,
        status: "PENDING",
        attempts: { gte: MAX_INGEST_ATTEMPTS },
        OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
      },
      orderBy: [{ startTimeMs: "desc" }, { id: "asc" }],
      take: options.limit ?? 50,
      select: { id: true, claimedAt: true },
    });

    const finalized: string[] = [];
    for (const candidate of candidates) {
      const applied = await client.exchangeFillIngestWindow.updateMany({
        // Re-assert the exact lease observed, so a worker that legitimately
        // re-claimed between the read and this write is never overwritten.
        where: {
          id: candidate.id,
          status: "PENDING",
          attempts: { gte: MAX_INGEST_ATTEMPTS },
          claimedAt: candidate.claimedAt,
        },
        data: {
          status: "ABANDONED",
          ...TERMINAL_CLEARED,
          lastErrorCode: FILL_INGEST_REASON.ATTEMPT_BUDGET_EXHAUSTED_AFTER_STALE_LEASE,
          sanitizedLastError: null,
        },
      });
      if (applied.count === 1) finalized.push(candidate.id);
    }

    return finalized;
  }
}
