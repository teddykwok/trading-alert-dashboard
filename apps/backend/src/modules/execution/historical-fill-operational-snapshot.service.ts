import { Prisma, type PrismaClient } from "@prisma/client";
import type { FillIngestWindowStatus, HistoricalFillCampaignStatus } from "@prisma/client";

import {
  bindConfiguredExecutionProfileEnvironment,
  type BinanceProfileBindingFailure,
  type BinanceProfileBindingResult,
} from "./binance-profile-binding";
import {
  INGEST_CLAIM_LEASE_MS,
  MAX_INGEST_ATTEMPTS,
} from "./exchange-fill-ingest-window.service";

/**
 * What historical fill ingestion currently LOOKS LIKE, and nothing else.
 *
 * ## Read only, and structurally so
 *
 * Every statement here is a count, a group or a minimum. There is no create,
 * update, delete or upsert anywhere in this file, no claim is taken, no root is
 * seeded, and no exchange is contacted. Asking what the queue looks like must
 * never change what it looks like.
 *
 * ## Facts, not verdicts
 *
 * Deliberately no health colour, severity, score or recommendation. A count of
 * attempt-exhausted rows is reported because it is true, not because this file
 * has an opinion about it -- interpreting these numbers is a later slice's job,
 * and baking a verdict in here would make that slice argue with this one.
 *
 * ## One profile, chosen the same way everything else chooses it
 *
 * The account is whatever the process is configured and bound to, resolved
 * through the same binder the bootstrap and the executor use. There is no
 * `executionProfileId` parameter: an operator snapshot that could be pointed at
 * another environment would be a quiet way to read the wrong account's history
 * and believe it.
 */

/** Every window status, exhaustively. A new enum member fails this to compile. */
const zeroStatusCounts = (): Record<FillIngestWindowStatus, number> => ({
  PENDING: 0,
  COMPLETE: 0,
  SPLIT: 0,
  INCOMPLETE_SKIPPED_ROWS: 0,
  SATURATED_SINGLE_MILLISECOND: 0,
  ABANDONED: 0,
});

export interface HistoricalFillWindowCounts {
  total: number;
  /** `parentId IS NULL` -- an original canonical day. */
  roots: number;
  /** `parentId IS NOT NULL` -- work a split produced. */
  children: number;
  distinctSymbolCount: number;
  byStatus: Record<FillIngestWindowStatus, number>;
}

/**
 * PENDING work, seen from several angles at once.
 *
 * These are ORTHOGONAL diagnostics, not a partition: one row can be counted by
 * more than one of them, and their sum is not `total` and is not meant to be.
 * `claimableNow` is the only one that answers "would a worker take this right
 * now", and it is the exact predicate `claimNextWindow` uses.
 */
export interface HistoricalFillPendingCounts {
  total: number;
  claimableNow: number;
  activeLease: number;
  staleLease: number;
  inBackoff: number;
  attemptExhausted: number;
  oldestPendingCreatedAt: Date | null;
  oldestClaimableCreatedAt: Date | null;
  nextBackoffEligibleAt: Date | null;
}

export interface HistoricalFillLedgerCounts {
  totalFills: number;
  /** `attribution = UNATTRIBUTED`: a real fill that matched no owned order. */
  unattributedFills: number;
}

/**
 * The backfill campaign an operator is most likely asking about.
 *
 * ## Which campaign this is
 *
 * The LIVE one (ACTIVE or PAUSED) when the profile has one -- at most one can
 * exist, enforced by a partial unique index. Otherwise the most recently
 * STARTED campaign, whatever became of it. That second half is the point: the
 * moment a campaign spends its final slot it becomes EXHAUSTED and stops being
 * live, and an operator opening the panel right then needs to see the campaign
 * that just ended rather than an empty space where it used to be. The same
 * holds for COMPLETED and ABORTED.
 *
 * Null only when the profile has never had a campaign at all.
 *
 * ## What it deliberately omits
 *
 * `note` is free operator text. This snapshot is served over HTTP and rendered,
 * so it carries counts, states and timestamps -- never an arbitrary string
 * somebody typed at a CLI.
 */
export interface HistoricalFillCampaignSnapshot {
  id: string;
  status: HistoricalFillCampaignStatus;
  maxDispatches: number;
  dispatchesUsed: number;
  dispatchesRemaining: number;
  startedAt: Date;
  lastAdmissionAt: Date | null;
  endedAt: Date | null;
}

export type HistoricalFillOperationalSnapshot =
  | {
      outcome: "PROFILE_UNAVAILABLE";
      capturedAt: Date;
      /** The binder's own code, carried through unflattened. */
      reasonCode: BinanceProfileBindingFailure;
    }
  | {
      outcome: "READY";
      capturedAt: Date;
      executionProfileId: string;
      windows: HistoricalFillWindowCounts;
      pending: HistoricalFillPendingCounts;
      ledger: HistoricalFillLedgerCounts;
      /** Null only when this profile has never had a campaign. */
      campaign: HistoricalFillCampaignSnapshot | null;
    };

const CAMPAIGN_SNAPSHOT_FIELDS = {
  id: true,
  status: true,
  maxDispatches: true,
  dispatchesUsed: true,
  startedAt: true,
  lastAdmissionAt: true,
  endedAt: true,
} as const;

/** Never a spread: `note` must not reach an HTTP response by accident. */
function describeCampaignSnapshot(
  campaign: {
    id: string;
    status: HistoricalFillCampaignStatus;
    maxDispatches: number;
    dispatchesUsed: number;
    startedAt: Date;
    lastAdmissionAt: Date | null;
    endedAt: Date | null;
  } | null
): HistoricalFillCampaignSnapshot | null {
  if (campaign === null) return null;
  return {
    id: campaign.id,
    status: campaign.status,
    maxDispatches: campaign.maxDispatches,
    dispatchesUsed: campaign.dispatchesUsed,
    dispatchesRemaining: Math.max(0, campaign.maxDispatches - campaign.dispatchesUsed),
    startedAt: campaign.startedAt,
    lastAdmissionAt: campaign.lastAdmissionAt,
    endedAt: campaign.endedAt,
  };
}

/** A counting bug in this file, surfaced rather than reported as fact. */
export class HistoricalFillSnapshotInvariantError extends Error {
  readonly reasonCode = "HISTORICAL_FILL_SNAPSHOT_INVARIANT";
  constructor(detail: string) {
    super(`Historical fill snapshot invariant violated: ${detail}`);
    this.name = "HistoricalFillSnapshotInvariantError";
  }
}

export interface HistoricalFillSnapshotDependencies {
  prisma: PrismaClient;
  /**
   * How the configured profile is bound. Injectable only so tests can drive a
   * binding failure; the default is the real binder, which takes no profile id
   * precisely so a caller cannot name one.
   */
  bindProfile?: (prisma: PrismaClient) => Promise<BinanceProfileBindingResult>;
}

export class HistoricalFillOperationalSnapshotService {
  private readonly bindProfile: (prisma: PrismaClient) => Promise<BinanceProfileBindingResult>;

  constructor(private readonly deps: HistoricalFillSnapshotDependencies) {
    this.bindProfile = deps.bindProfile ?? bindConfiguredExecutionProfileEnvironment;
  }

  /**
   * One coherent picture of the durable queue.
   *
   * `now` is resolved ONCE and is the only clock this snapshot has: it stamps
   * `capturedAt`, it computes the stale-lease threshold, and it decides what is
   * in backoff. Reading the wall clock again partway through would let a row be
   * counted as leased by one metric and expired by the next, and the operator
   * would be looking at a moment that never existed.
   */
  async capture(options: { now?: Date } = {}): Promise<HistoricalFillOperationalSnapshot> {
    const capturedAt = options.now ?? new Date();

    const binding = await this.bindProfile(this.deps.prisma);
    if (!binding.ok) {
      // Nothing is read about any workset. A process that cannot name its
      // account has no business reporting that account's queue, and guessing
      // one would show an operator another environment's history.
      return { outcome: "PROFILE_UNAVAILABLE", capturedAt, reasonCode: binding.reasonCode };
    }
    const executionProfileId = binding.context.executionProfileId;

    const staleBefore = new Date(capturedAt.getTime() - INGEST_CLAIM_LEASE_MS);

    /**
     * The claim predicate, spelled exactly as `claimNextWindow` spells it.
     *
     * `lte` on the backoff and `lt` on the lease are not stylistic: a row whose
     * backoff expires exactly now IS claimable, and a lease acquired exactly
     * one lease-length ago is still ACTIVE. An integration test claims through
     * the real service over the same rows and asserts the two agree, so this
     * cannot quietly drift into a second, kinder definition.
     */
    const claimable: Prisma.ExchangeFillIngestWindowWhereInput = {
      executionProfileId,
      status: "PENDING",
      attempts: { lt: MAX_INGEST_ATTEMPTS },
      AND: [
        { OR: [{ nextEligibleAt: null }, { nextEligibleAt: { lte: capturedAt } }] },
        { OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }] },
      ],
    };
    const pendingOnly: Prisma.ExchangeFillIngestWindowWhereInput = {
      executionProfileId,
      status: "PENDING",
    };

    /**
     * ONE transaction, at REPEATABLE READ.
     *
     * Every number below is taken from the same database snapshot, so a window
     * cannot be COMPLETE in one count and PENDING in the next while a worker
     * commits underneath. Read-only, so there is nothing to serialize against
     * and no retry to write: REPEATABLE READ is exactly enough, and SERIALIZABLE
     * would only buy conflict handling this transaction can never need.
     */
    const [
      statusGroups,
      roots,
      children,
      symbolGroups,
      claimableNow,
      activeLease,
      staleLease,
      inBackoff,
      attemptExhausted,
      oldestPending,
      oldestClaimable,
      nextBackoff,
      totalFills,
      unattributedFills,
      liveCampaign,
      latestCampaign,
    ] = await this.deps.prisma.$transaction(
      async (tx) =>
        Promise.all([
          tx.exchangeFillIngestWindow.groupBy({
            by: ["status"],
            where: { executionProfileId },
            _count: { _all: true },
          }),
          tx.exchangeFillIngestWindow.count({ where: { executionProfileId, parentId: null } }),
          tx.exchangeFillIngestWindow.count({
            where: { executionProfileId, parentId: { not: null } },
          }),
          // Grouped rather than selected: one row per symbol, never one per
          // window, so a long history cannot materialize itself in memory.
          tx.exchangeFillIngestWindow.groupBy({ by: ["symbol"], where: { executionProfileId } }),
          tx.exchangeFillIngestWindow.count({ where: claimable }),
          tx.exchangeFillIngestWindow.count({
            where: { ...pendingOnly, claimedAt: { gte: staleBefore } },
          }),
          tx.exchangeFillIngestWindow.count({
            where: { ...pendingOnly, claimedAt: { lt: staleBefore } },
          }),
          tx.exchangeFillIngestWindow.count({
            where: { ...pendingOnly, nextEligibleAt: { gt: capturedAt } },
          }),
          tx.exchangeFillIngestWindow.count({
            where: { ...pendingOnly, attempts: { gte: MAX_INGEST_ATTEMPTS } },
          }),
          tx.exchangeFillIngestWindow.aggregate({
            where: pendingOnly,
            _min: { createdAt: true },
          }),
          tx.exchangeFillIngestWindow.aggregate({ where: claimable, _min: { createdAt: true } }),
          tx.exchangeFillIngestWindow.aggregate({
            where: { ...pendingOnly, nextEligibleAt: { gt: capturedAt } },
            _min: { nextEligibleAt: true },
          }),
          tx.exchangeFillLedger.count({ where: { executionProfileId } }),
          tx.exchangeFillLedger.count({
            where: { executionProfileId, attribution: "UNATTRIBUTED" },
          }),
          // Inside the SAME snapshot as the counts, so the campaign an operator
          // reads cannot belong to a different instant than the queue beside it.
          // Live first; the ordering makes ACTIVE and PAUSED sort ahead of every
          // terminal state, and the newest start wins among equals.
          tx.historicalFillCampaign.findFirst({
            where: { executionProfileId, status: { in: ["ACTIVE", "PAUSED"] } },
            select: CAMPAIGN_SNAPSHOT_FIELDS,
          }),
          tx.historicalFillCampaign.findFirst({
            where: { executionProfileId },
            orderBy: { startedAt: "desc" },
            select: CAMPAIGN_SNAPSHOT_FIELDS,
          }),
        ]),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );

    const byStatus = zeroStatusCounts();
    for (const group of statusGroups) byStatus[group.status] = group._count._all;
    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);

    if (roots + children !== total) {
      throw new HistoricalFillSnapshotInvariantError(
        `${roots} root(s) plus ${children} child(ren) is not the ${total} window(s) counted`
      );
    }

    return {
      outcome: "READY",
      capturedAt,
      executionProfileId,
      campaign: describeCampaignSnapshot(liveCampaign ?? latestCampaign),
      windows: { total, roots, children, distinctSymbolCount: symbolGroups.length, byStatus },
      pending: {
        total: byStatus.PENDING,
        claimableNow,
        activeLease,
        staleLease,
        inBackoff,
        attemptExhausted,
        oldestPendingCreatedAt: oldestPending._min.createdAt ?? null,
        oldestClaimableCreatedAt: oldestClaimable._min.createdAt ?? null,
        nextBackoffEligibleAt: nextBackoff._min.nextEligibleAt ?? null,
      },
      ledger: { totalFills, unattributedFills },
    };
  }
}
