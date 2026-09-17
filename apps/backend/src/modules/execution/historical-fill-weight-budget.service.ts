import {
  Prisma,
  type HistoricalFillCampaignStatus,
  type PrismaClient,
} from "@prisma/client";

import { USER_TRADES_REQUEST_WEIGHT } from "./exchange-fill-batch-driver.service";
import { lockCampaignForProfile } from "./historical-fill-campaign-lock";

/**
 * The CROSS-PROCESS ceiling on historical userTrades request weight.
 *
 * ## What this bounds, and what it does not
 *
 * Historical `/fapi/v1/userTrades` production, for ONE account, inside one
 * accounting minute. Market data, order entry, account reads, canary and every
 * CLI are outside it and always will be -- this is not an IP limiter, not
 * account-wide budgeting, and its fixed minute is not Binance's rolling
 * window. It bounds what this subsystem produces, which is the only thing it
 * can honestly promise.
 *
 * ## Why the database clock
 *
 * Every contender must agree on which minute it is in. Host clocks do not
 * agree, and nothing in this deployment enforces that they do, so a bucket
 * derived from `new Date()` would let two skewed processes spend two ceilings
 * while each believed it respected one. The bucket therefore comes from
 * Postgres -- the one clock all contenders share.
 *
 * ## Why reservation, not ownership
 *
 * A lease says who MAY run; it cannot stop a process that already started from
 * reaching the exchange, because Binance never checks our token. A reservation
 * gates the local act of sending, immediately before the send, which is the
 * only place the production of an external request can actually be fenced.
 *
 * ## Conservative by construction
 *
 * Weight is reserved BEFORE the work and given back only when a dispatch is
 * PROVEN not to have happened. A crash between reservation and dispatch burns
 * five weight, and that is the correct trade: an over-count costs one request
 * of throughput, an under-count spends the exchange allowance twice.
 */

/** One dispatch, and the only quantity this service ever moves. */
export const HISTORICAL_FILL_RESERVATION_WEIGHT = USER_TRADES_REQUEST_WEIGHT;

/**
 * A coordination failure, surfaced rather than returned.
 *
 * Deliberately NOT a denial: "the ceiling is full" and "the ceiling could not
 * be read" must never look alike, or an outage would quietly read as a budget
 * that happens to be busy and the batch would stop for the wrong reason.
 */
export class HistoricalFillWeightBudgetUnavailableError extends Error {
  readonly reasonCode = "FILL_WEIGHT_BUDGET_UNAVAILABLE";
  constructor(detail: string) {
    super(`Historical fill weight budget could not be reserved: ${detail}`);
    this.name = "HistoricalFillWeightBudgetUnavailableError";
  }
}

/**
 * Durable accounting reached a state this service cannot produce.
 *
 * Deliberately NOT a denial and NOT an outage: `EXHAUSTED` means the ceiling is
 * full, `UNAVAILABLE` means it could not be read, and this means the books
 * disagree with themselves -- an outstanding reservation whose bucket cannot
 * fund the weight it is owed. Collapsing it into either of the others would
 * hide a corruption behind a number that reads as ordinary.
 *
 * Carries ids and counts only; never a row, a credential or a raw database
 * message.
 */
export class HistoricalFillWeightBudgetInvariantError extends Error {
  readonly reasonCode = "FILL_WEIGHT_BUDGET_INVARIANT";
  constructor(detail: string) {
    super(`Historical fill weight budget invariant violated: ${detail}`);
    this.name = "HistoricalFillWeightBudgetInvariantError";
  }
}

/**
 * Identity of a granted reservation.
 *
 * `id` is the durable one. The counter is an aggregate -- it knows five weight
 * is spent, not WHOSE -- so releasing against it alone could not tell a first
 * release of this reservation from a second, and a duplicate would give back
 * weight still owed to a different outstanding grant. The row named here is
 * what makes release idempotent; the bucket fields travel with it so a release
 * arriving after the minute boundary still moves the minute that granted it.
 */
export interface HistoricalFillWeightReservation {
  id: string;
  bucketId: string;
  executionProfileId: string;
  bucketStart: Date;
  weight: number;
  /**
   * The campaign this grant was charged to, when one governed it.
   *
   * INFORMATIONAL ONLY, and optional so that every existing caller and fixture
   * keeps compiling unchanged. Release never trusts it: it re-reads the value
   * from the reservation row, because the row is what the refund must actually
   * agree with and a caller-supplied id could be stale, wrong, or absent.
   */
  campaignId?: string | null;
}

export type HistoricalFillWeightReservationResult =
  | { outcome: "GRANTED"; reservation: HistoricalFillWeightReservation }
  | { outcome: "EXHAUSTED"; bucketStart: Date; weightCap: number; weightUsed: number }
  | { outcome: "CAP_MISMATCH"; bucketStart: Date; storedCap: number; configuredCap: number };

/**
 * Why a campaign-governed dispatch was or was not admitted.
 *
 * The denials are kept apart on purpose. "There is no campaign", "the campaign
 * is paused", "the campaign has spent its slots" and "this minute is full"
 * call for four different operator actions, and a caller that saw one code for
 * all of them would report the wrong one three times out of four. In
 * particular a PAUSED, ABORTED or COMPLETED campaign is NOT budget exhaustion:
 * those are states somebody chose, and exhaustion is a limit being reached.
 */
export type HistoricalFillCampaignAdmissionResult =
  | {
      outcome: "ADMITTED";
      reservation: HistoricalFillWeightReservation;
      campaignId: string;
      /** Counts AFTER this admission, so `dispatchesUsed === maxDispatches` means it was the last. */
      dispatchesUsed: number;
      maxDispatches: number;
      /** EXHAUSTED when this admission took the final slot; otherwise ACTIVE. */
      campaignStatus: HistoricalFillCampaignStatus;
    }
  | {
      outcome: "NO_ACTIVE_FILL_CAMPAIGN";
      /**
       * The state that stood in the way, when a campaign exists at all.
       *
       * Null means no campaign has ever been opened for this profile. Anything
       * else names what an operator would have to change.
       */
      campaignStatus: HistoricalFillCampaignStatus | null;
      campaignId: string | null;
    }
  | {
      outcome: "CAMPAIGN_DISPATCH_BUDGET_EXHAUSTED";
      campaignId: string;
      dispatchesUsed: number;
      maxDispatches: number;
    }
  | {
      outcome: "GLOBAL_USER_TRADES_WEIGHT_EXHAUSTED";
      bucketStart: Date;
      weightCap: number;
      weightUsed: number;
    }
  | { outcome: "CAP_MISMATCH"; bucketStart: Date; storedCap: number; configuredCap: number };

/** Every admission outcome that must leave the database exactly as it found it. */
type HistoricalFillCampaignAdmissionDenial = Exclude<
  HistoricalFillCampaignAdmissionResult,
  { outcome: "ADMITTED" }
>;

/**
 * Carries a denial OUT of the transaction by unwinding it.
 *
 * Load-bearing, and the reason it is a throw rather than a return. Returning a
 * denial from the transaction callback would COMMIT whatever the transaction
 * had already written -- and by the time the weight budget can refuse, the
 * campaign slot has already been incremented. A committed denial would
 * therefore spend a slot on a dispatch that never happened, permanently, which
 * is exactly the "both or neither" guarantee this admission exists to provide.
 *
 * Throwing rolls the increment back; the catch below turns it into an ordinary
 * result so callers still see a denial rather than an exception.
 */
class HistoricalFillCampaignAdmissionRollback extends Error {
  constructor(readonly denial: HistoricalFillCampaignAdmissionDenial) {
    super(`historical fill campaign admission rolled back: ${denial.outcome}`);
    this.name = "HistoricalFillCampaignAdmissionRollback";
  }
}

export class HistoricalFillWeightBudgetService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The accounting minute, from the database clock.
   *
   * One short read, no transaction held across anything. `date_trunc` at the
   * database means two hosts whose clocks differ by seconds still resolve the
   * same bucket, which is the entire point.
   */
  private async currentBucketStart(
    client: Prisma.TransactionClient | PrismaClient = this.prisma
  ): Promise<Date> {
    const rows = await client.$queryRaw<Array<{ bucket: Date }>>(
      Prisma.sql`SELECT date_trunc('minute', (now() AT TIME ZONE 'UTC')) AS bucket`
    );
    const bucket = rows[0]?.bucket;
    if (!(bucket instanceof Date) || Number.isNaN(bucket.getTime())) {
      throw new HistoricalFillWeightBudgetUnavailableError(
        "the database did not return a usable accounting minute"
      );
    }
    return bucket;
  }

  /**
   * Reserves exactly one dispatch against the MINUTE ONLY, with no campaign.
   *
   * ONE short transaction: the bucket increment and the reservation row commit
   * together or not at all, so there is no durable state where weight is
   * counted but nothing owns it, or a reservation exists that the bucket never
   * charged. No network call happens inside it.
   *
   * ## TRANSITIONAL -- THIS IS THE REMAINING CAMPAIGN BYPASS
   *
   * This method bounds the minute and nothing else. A dispatch admitted through
   * it is counted by NO campaign, so it is subject to no bound that survives
   * the next tick. The batch driver still calls exactly this, which means the
   * campaign guarantee is NOT yet in force anywhere in production.
   *
   * It is kept only so this branch stays compilable and the driver keeps
   * working while the rewire lands. `admitCampaignDispatch` is the method that
   * replaces it, and the driver must be moved onto that before this branch may
   * reach main.
   *
   * @deprecated Use {@link HistoricalFillWeightBudgetService.admitCampaignDispatch}.
   *   Retained for the existing batch-driver call site only.
   */
  async reserve(options: {
    executionProfileId: string;
    weightCap: number;
  }): Promise<HistoricalFillWeightReservationResult> {
    const weight = HISTORICAL_FILL_RESERVATION_WEIGHT;

    try {
      // Inside the guard: a database that cannot answer "which minute is it"
      // is an outage, and an outage must never surface as a denial.
      const bucketStart = await this.currentBucketStart();

      return await this.prisma.$transaction(async (tx) => {
        const step = await this.reserveWeightWithin(tx, {
          executionProfileId: options.executionProfileId,
          weightCap: options.weightCap,
          bucketStart,
          weight,
        });

        if (!step.ok) {
          return step.denial.kind === "CAP_MISMATCH"
            ? {
                outcome: "CAP_MISMATCH" as const,
                bucketStart,
                storedCap: step.denial.storedCap,
                configuredCap: options.weightCap,
              }
            : {
                outcome: "EXHAUSTED" as const,
                bucketStart,
                weightCap: step.denial.weightCap,
                weightUsed: step.denial.weightUsed,
              };
        }

        // The durable identity of THIS grant, written in the same transaction
        // as the weight it accounts for. No campaign: this is the legacy path,
        // and `campaignId` stays NULL exactly as it did before campaigns.
        const reservation = await tx.historicalFillWeightReservation.create({
          data: { bucketId: step.bucketId, weight },
          select: { id: true },
        });

        return {
          outcome: "GRANTED" as const,
          reservation: {
            id: reservation.id,
            bucketId: step.bucketId,
            executionProfileId: options.executionProfileId,
            bucketStart,
            weight,
            campaignId: null,
          },
        };
      });
    } catch (error) {
      if (error instanceof HistoricalFillWeightBudgetUnavailableError) throw error;
      throw new HistoricalFillWeightBudgetUnavailableError(
        error instanceof Error ? error.message.slice(0, 300) : "unknown"
      );
    }
  }


  /**
   * The minute's weight, reserved on whichever transaction the caller owns.
   *
   * Extracted so the legacy path and the campaign-governed path share ONE
   * implementation of the fixed-UTC-minute bucket, the cap-in-force check and
   * the conditional increment. Two copies would eventually disagree, and the
   * thing they would disagree about is how much of a real account's exchange
   * allowance may be spent.
   *
   * Returns a denial rather than throwing, because its two callers must do
   * different things with one: the legacy path returns it, the campaign path
   * has an increment to unwind first.
   */
  private async reserveWeightWithin(
    tx: Prisma.TransactionClient,
    options: {
      executionProfileId: string;
      weightCap: number;
      bucketStart: Date;
      weight: number;
    }
  ): Promise<
    | { ok: true; bucketId: string }
    | {
        ok: false;
        denial:
          | { kind: "CAP_MISMATCH"; storedCap: number }
          | { kind: "EXHAUSTED"; weightCap: number; weightUsed: number };
      }
  > {
    // Race-safe creation: two processes entering the same minute converge on
    // one row. Losing the insert means somebody else created the bucket we are
    // about to contend for, which is success.
    await tx.historicalFillWeightBucket.createMany({
      data: [
        {
          executionProfileId: options.executionProfileId,
          bucketStart: options.bucketStart,
          weightCap: options.weightCap,
        },
      ],
      skipDuplicates: true,
    });

    const bucket = await tx.historicalFillWeightBucket.findUnique({
      where: {
        executionProfileId_bucketStart: {
          executionProfileId: options.executionProfileId,
          bucketStart: options.bucketStart,
        },
      },
      select: { id: true, weightCap: true, weightUsed: true },
    });
    if (bucket === null) {
      throw new HistoricalFillWeightBudgetUnavailableError(
        "the accounting bucket could not be resolved after creation"
      );
    }

    // A configured ceiling that disagrees with the one in force is refused
    // outright, and the stored bucket is left exactly as found. Raising a
    // ceiling another process is already counting against would silently
    // double what the account may spend, and "repairing" it here would do
    // precisely that under a friendlier name.
    if (bucket.weightCap !== options.weightCap) {
      return { ok: false, denial: { kind: "CAP_MISMATCH", storedCap: bucket.weightCap } };
    }

    // The grant. `weightCap` is in the predicate as well as `weightUsed`, so a
    // drifted process cannot win the update even in a race.
    const granted = await tx.historicalFillWeightBucket.updateMany({
      where: {
        id: bucket.id,
        weightCap: options.weightCap,
        weightUsed: { lte: options.weightCap - options.weight },
      },
      data: { weightUsed: { increment: options.weight } },
    });

    if (granted.count !== 1) {
      const current = await tx.historicalFillWeightBucket.findUniqueOrThrow({
        where: { id: bucket.id },
        select: { weightCap: true, weightUsed: true },
      });
      return {
        ok: false,
        denial: { kind: "EXHAUSTED", weightCap: current.weightCap, weightUsed: current.weightUsed },
      };
    }

    return { ok: true, bucketId: bucket.id };
  }

  /**
   * Reserves ONE campaign-governed historical dispatch, or explains why not.
   *
   * ## Both or neither
   *
   * The campaign slot and the minute's weight are taken in ONE transaction. A
   * slot spent without weight would let a campaign run out while nothing was
   * ever sent; weight spent without a slot would put a dispatch outside the
   * only bound that spans ticks. Every denial after the campaign increment
   * therefore unwinds it -- see the rollback error above for why that has to be
   * a throw and not a return.
   *
   * ## Row access order, as the code actually does it
   *
   * campaign advisory lock -> clock -> CAMPAIGN row -> BUCKET row -> RESERVATION
   * insert.
   *
   * This is genuinely the reverse of the refund path, which goes RESERVATION ->
   * BUCKET -> CAMPAIGN. Two transactions taking the same rows in opposite
   * orders is the textbook deadlock, and the per-profile advisory lock is what
   * makes it safe: both sides take it FIRST, so for one profile an admission
   * and a refund never interleave at all. The order is written down here
   * because it is what the code does, not because it is tidy.
   *
   * ## No network I/O
   *
   * Nothing in this transaction talks to anything but Postgres, so the lock is
   * held for microseconds and never across an exchange call.
   */
  async admitCampaignDispatch(options: {
    executionProfileId: string;
    weightCap: number;
  }): Promise<HistoricalFillCampaignAdmissionResult> {
    const weight = HISTORICAL_FILL_RESERVATION_WEIGHT;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // FIRST, always. Everything below is campaign-aware budget mutation.
        await lockCampaignForProfile(tx, options.executionProfileId);

        const bucketStart = await this.currentBucketStart(tx);

        // `findMany` rather than `findFirst`: the partial unique index makes two
        // ACTIVE rows impossible, so seeing them means the index is gone or the
        // table was edited by hand. Fail closed rather than pick one.
        const active = await tx.historicalFillCampaign.findMany({
          where: { executionProfileId: options.executionProfileId, status: "ACTIVE" },
          select: { id: true, dispatchesUsed: true, maxDispatches: true },
        });
        if (active.length > 1) {
          throw new HistoricalFillWeightBudgetInvariantError(
            `profile ${options.executionProfileId} has ${active.length} ACTIVE campaigns`
          );
        }

        const campaign = active[0];
        if (!campaign) {
          // Say WHAT stood in the way. A paused or aborted campaign is a state
          // somebody chose, and must never read as a limit being reached.
          const blocking = await tx.historicalFillCampaign.findFirst({
            where: { executionProfileId: options.executionProfileId },
            orderBy: { startedAt: "desc" },
            select: { id: true, status: true },
          });
          throw new HistoricalFillCampaignAdmissionRollback({
            outcome: "NO_ACTIVE_FILL_CAMPAIGN",
            campaignStatus: blocking?.status ?? null,
            campaignId: blocking?.id ?? null,
          });
        }

        if (campaign.dispatchesUsed >= campaign.maxDispatches) {
          throw new HistoricalFillCampaignAdmissionRollback({
            outcome: "CAMPAIGN_DISPATCH_BUDGET_EXHAUSTED",
            campaignId: campaign.id,
            dispatchesUsed: campaign.dispatchesUsed,
            maxDispatches: campaign.maxDispatches,
          });
        }

        const dispatchesUsed = campaign.dispatchesUsed + 1;
        const isFinalSlot = dispatchesUsed === campaign.maxDispatches;

        // The final slot and the state change commit TOGETHER. No committed
        // state where a campaign is ACTIVE with every slot spent can exist,
        // because nothing can observe those two facts apart.
        const claimed = await tx.historicalFillCampaign.updateMany({
          where: {
            id: campaign.id,
            status: "ACTIVE",
            dispatchesUsed: campaign.dispatchesUsed,
            maxDispatches: campaign.maxDispatches,
          },
          data: {
            dispatchesUsed: { increment: 1 },
            ...(isFinalSlot ? { status: "EXHAUSTED" as const, endedAt: new Date() } : {}),
          },
        });
        // Under the advisory lock nothing else can move this campaign, so a
        // miss here is corruption rather than contention.
        if (claimed.count !== 1) {
          throw new HistoricalFillWeightBudgetInvariantError(
            `campaign ${campaign.id} could not be advanced from ${campaign.dispatchesUsed} under its own lock`
          );
        }

        // The SAME weight step the legacy path uses -- one implementation, so a
        // campaign-governed dispatch and a legacy one can never disagree about
        // which minute it is or what the cap in force is.
        const weightStep = await this.reserveWeightWithin(tx, {
          executionProfileId: options.executionProfileId,
          weightCap: options.weightCap,
          bucketStart,
          weight,
        });
        if (!weightStep.ok) {
          // Unwinds the campaign increment above. A denial here must cost
          // nothing: the campaign has to come out of this exactly as it went in.
          throw new HistoricalFillCampaignAdmissionRollback(
            weightStep.denial.kind === "CAP_MISMATCH"
              ? {
                  outcome: "CAP_MISMATCH",
                  bucketStart,
                  storedCap: weightStep.denial.storedCap,
                  configuredCap: options.weightCap,
                }
              : {
                  outcome: "GLOBAL_USER_TRADES_WEIGHT_EXHAUSTED",
                  bucketStart,
                  weightCap: weightStep.denial.weightCap,
                  weightUsed: weightStep.denial.weightUsed,
                }
          );
        }

        const reservation = await tx.historicalFillWeightReservation.create({
          data: { bucketId: weightStep.bucketId, weight, campaignId: campaign.id },
          select: { id: true },
        });

        return {
          outcome: "ADMITTED" as const,
          reservation: {
            id: reservation.id,
            bucketId: weightStep.bucketId,
            executionProfileId: options.executionProfileId,
            bucketStart,
            weight,
            campaignId: campaign.id,
          },
          campaignId: campaign.id,
          dispatchesUsed,
          maxDispatches: campaign.maxDispatches,
          campaignStatus: (isFinalSlot ? "EXHAUSTED" : "ACTIVE") as HistoricalFillCampaignStatus,
        };
      });
    } catch (error) {
      // A denial that unwound the transaction becomes an ordinary result again.
      if (error instanceof HistoricalFillCampaignAdmissionRollback) return error.denial;
      if (error instanceof HistoricalFillWeightBudgetInvariantError) throw error;
      if (error instanceof HistoricalFillWeightBudgetUnavailableError) throw error;
      throw new HistoricalFillWeightBudgetUnavailableError(
        error instanceof Error ? error.message.slice(0, 300) : "unknown"
      );
    }
  }

  /**
   * Gives back a reservation whose dispatch is PROVEN not to have happened.
   *
   * ## One idempotency gate, still
   *
   * The compare-and-set on `releasedAt IS NULL` remains the SOLE gate, exactly
   * as it was before campaigns existed. Everything a refund gives back -- the
   * minute's weight, and now the campaign's slot -- hangs off that one CAS, so
   * a second attempt from any process at any time matches nothing and changes
   * nothing. Adding a second gate for the campaign would create two facts that
   * could disagree.
   *
   * ## Whole, or not at all
   *
   * Winning the CAS means this reservation WAS outstanding, so both decrements
   * must be possible. If either cannot happen exactly once the books were
   * already wrong, and committing would make that permanent -- a reservation
   * marked released whose weight or slot is still charged, which nothing could
   * ever give back. Throwing rolls `releasedAt` back with it, so the
   * reservation stays outstanding and stays releasable after repair.
   *
   * ## Row access order, as the code actually does it
   *
   * campaign advisory lock -> RESERVATION -> BUCKET -> CAMPAIGN.
   *
   * That is the reverse of admission's CAMPAIGN -> BUCKET -> RESERVATION. The
   * advisory lock, taken first by both, is the only reason those opposite
   * orders cannot deadlock. A legacy reservation takes no campaign lock and
   * touches no campaign row, so it cannot close a cycle either.
   */
  async releaseCertainNonDispatch(reservation: HistoricalFillWeightReservation): Promise<void> {
    // Read before locking, deliberately. Both values are immutable once the
    // reservation exists -- a grant never changes which campaign it was charged
    // to, and a campaign never changes account -- so this cannot go stale in a
    // way that matters, and it is what tells us whether a campaign lock is
    // needed at all.
    const linked = await this.readCampaignLink(reservation.id);

    if (linked === null) {
      // Legacy grant, or a reservation that no longer exists. Byte-for-byte the
      // pre-campaign path: no campaign lookup, no campaign lock, no decrement.
      await this.releaseWeightOnly(reservation);
      return;
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // FIRST. Serializes this refund against every admission, pause, resume,
        // abort and create for the same profile.
        await lockCampaignForProfile(tx, linked.executionProfileId);

        const claimed = await tx.historicalFillWeightReservation.updateMany({
          where: { id: reservation.id, releasedAt: null },
          data: { releasedAt: new Date() },
        });
        // Already released. Nothing to give back, and nothing to correct.
        if (claimed.count !== 1) return;

        const decremented = await tx.historicalFillWeightBucket.updateMany({
          where: { id: reservation.bucketId, weightUsed: { gte: reservation.weight } },
          data: { weightUsed: { decrement: reservation.weight } },
        });
        if (decremented.count !== 1) {
          throw new HistoricalFillWeightBudgetInvariantError(
            `reservation ${reservation.id} was claimed for release but its bucket ` +
              `${reservation.bucketId} could not fund ${reservation.weight} weight`
          );
        }

        const refunded = await tx.historicalFillCampaign.updateMany({
          where: { id: linked.campaignId, dispatchesUsed: { gte: 1 } },
          data: { dispatchesUsed: { decrement: 1 } },
        });
        if (refunded.count !== 1) {
          throw new HistoricalFillWeightBudgetInvariantError(
            `reservation ${reservation.id} was claimed for release but campaign ` +
              `${linked.campaignId} had no dispatch to give back`
          );
        }

        await this.reactivateIfFreed(tx, linked);
      });
    } catch (error) {
      if (error instanceof HistoricalFillWeightBudgetInvariantError) throw error;
      throw new HistoricalFillWeightBudgetUnavailableError(
        error instanceof Error ? error.message.slice(0, 300) : "unknown"
      );
    }
  }

  /** The reservation's campaign and that campaign's account, or null for a legacy grant. */
  private async readCampaignLink(
    reservationId: string
  ): Promise<{ campaignId: string; executionProfileId: string } | null> {
    const row = await this.prisma.historicalFillWeightReservation.findUnique({
      where: { id: reservationId },
      // The campaign is the CANONICAL owner of the profile identity. The
      // reservation deliberately does not carry a second copy, because a
      // duplicate would create an invariant nothing enforces.
      select: { campaignId: true, campaign: { select: { executionProfileId: true } } },
    });
    if (!row?.campaignId || !row.campaign) return null;
    return { campaignId: row.campaignId, executionProfileId: row.campaign.executionProfileId };
  }

  /** The pre-campaign release, unchanged: CAS the reservation, decrement the bucket. */
  private async releaseWeightOnly(reservation: HistoricalFillWeightReservation): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.historicalFillWeightReservation.updateMany({
          where: { id: reservation.id, releasedAt: null },
          data: { releasedAt: new Date() },
        });
        if (claimed.count !== 1) return;

        const decremented = await tx.historicalFillWeightBucket.updateMany({
          where: { id: reservation.bucketId, weightUsed: { gte: reservation.weight } },
          data: { weightUsed: { decrement: reservation.weight } },
        });
        if (decremented.count !== 1) {
          throw new HistoricalFillWeightBudgetInvariantError(
            `reservation ${reservation.id} was claimed for release but its bucket ` +
              `${reservation.bucketId} could not fund ${reservation.weight} weight`
          );
        }
      });
    } catch (error) {
      if (error instanceof HistoricalFillWeightBudgetInvariantError) throw error;
      throw new HistoricalFillWeightBudgetUnavailableError(
        error instanceof Error ? error.message.slice(0, 300) : "unknown"
      );
    }
  }

  /**
   * Reopens a campaign whose final slot has just been proven unspent.
   *
   * The ONE reactivation the design allows, and it is not an operator action:
   * it happens only when a refund has established that the dispatch its last
   * slot paid for never reached the exchange. `resumeCampaign` deliberately
   * refuses EXHAUSTED for exactly this reason -- a person may not undo a
   * ceiling, a proven fact may.
   *
   * What each state means here:
   *
   * - ACTIVE    the campaign never ended; the counter is back, nothing to do.
   * - PAUSED    somebody paused it. The slot returns, the pause stands. Undoing
   *             a pause because a refund arrived would restart a backfill the
   *             operator stopped.
   * - ABORTED   hard terminal. The slot returns, the abort stands, and nothing
   *             here may resurrect it.
   * - EXHAUSTED the only reopenable state, and only if the profile has no other
   *             live campaign -- reopening beside one would be two live
   *             campaigns, each with its own ceiling, which is the exact
   *             overspend the partial unique index exists to prevent. When one
   *             does exist the refund still COMMITS; only the reopening is
   *             skipped.
   * - COMPLETED impossible for an outstanding reservation: COMPLETED means the
   *             queue was declared finished, which cannot be true while a
   *             dispatch this campaign paid for was still unresolved. Treated
   *             as corruption and thrown, which rolls the whole refund back and
   *             leaves the reservation releasable after repair. The cost is that
   *             the weight stays charged until somebody looks -- an OVERCOUNT,
   *             which is the safe direction, and the alternative would be
   *             silently editing a finished campaign's record.
   */
  private async reactivateIfFreed(
    tx: Prisma.TransactionClient,
    linked: { campaignId: string; executionProfileId: string }
  ): Promise<void> {
    const campaign = await tx.historicalFillCampaign.findUniqueOrThrow({
      where: { id: linked.campaignId },
      select: { status: true, dispatchesUsed: true, maxDispatches: true },
    });

    if (campaign.status === "COMPLETED") {
      throw new HistoricalFillWeightBudgetInvariantError(
        `campaign ${linked.campaignId} is COMPLETED but had an outstanding reservation to refund`
      );
    }

    if (campaign.status !== "EXHAUSTED") return;
    if (campaign.dispatchesUsed >= campaign.maxDispatches) return;

    const otherLive = await tx.historicalFillCampaign.count({
      where: {
        executionProfileId: linked.executionProfileId,
        status: { in: ["ACTIVE", "PAUSED"] },
        id: { not: linked.campaignId },
      },
    });
    if (otherLive > 0) return;

    // Conditional on EXHAUSTED so this can never race an operator's abort into
    // an accidental reopening, even though the lock already excludes one.
    await tx.historicalFillCampaign.updateMany({
      where: { id: linked.campaignId, status: "EXHAUSTED" },
      data: { status: "ACTIVE", endedAt: null },
    });
  }
}
