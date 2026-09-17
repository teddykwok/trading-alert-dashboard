import { Prisma, type PrismaClient } from "@prisma/client";

import { USER_TRADES_REQUEST_WEIGHT } from "./exchange-fill-batch-driver.service";

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
}

export type HistoricalFillWeightReservationResult =
  | { outcome: "GRANTED"; reservation: HistoricalFillWeightReservation }
  | { outcome: "EXHAUSTED"; bucketStart: Date; weightCap: number; weightUsed: number }
  | { outcome: "CAP_MISMATCH"; bucketStart: Date; storedCap: number; configuredCap: number };

export class HistoricalFillWeightBudgetService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The accounting minute, from the database clock.
   *
   * One short read, no transaction held across anything. `date_trunc` at the
   * database means two hosts whose clocks differ by seconds still resolve the
   * same bucket, which is the entire point.
   */
  private async currentBucketStart(): Promise<Date> {
    const rows = await this.prisma.$queryRaw<Array<{ bucket: Date }>>(
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
   * Reserves exactly one dispatch, or explains why it could not.
   *
   * ONE short transaction: the bucket increment and the reservation row commit
   * together or not at all, so there is no durable state where weight is
   * counted but nothing owns it, or a reservation exists that the bucket never
   * charged. No network call happens inside it.
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
        // Race-safe creation: two processes entering the same minute converge
        // on one row. Losing the insert means somebody else created the bucket
        // we are about to contend for, which is success.
        await tx.historicalFillWeightBucket.createMany({
          data: [
            {
              executionProfileId: options.executionProfileId,
              bucketStart,
              weightCap: options.weightCap,
            },
          ],
          skipDuplicates: true,
        });

        const bucket = await tx.historicalFillWeightBucket.findUnique({
          where: {
            executionProfileId_bucketStart: {
              executionProfileId: options.executionProfileId,
              bucketStart,
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
        // outright. Raising a ceiling another process is already counting
        // against would silently double what the account may spend.
        if (bucket.weightCap !== options.weightCap) {
          return {
            outcome: "CAP_MISMATCH" as const,
            bucketStart,
            storedCap: bucket.weightCap,
            configuredCap: options.weightCap,
          };
        }

        // The grant. `weightCap` is in the predicate as well as `weightUsed`,
        // so a drifted process cannot win the update even in a race.
        const granted = await tx.historicalFillWeightBucket.updateMany({
          where: {
            id: bucket.id,
            weightCap: options.weightCap,
            weightUsed: { lte: options.weightCap - weight },
          },
          data: { weightUsed: { increment: weight } },
        });

        if (granted.count !== 1) {
          const current = await tx.historicalFillWeightBucket.findUniqueOrThrow({
            where: { id: bucket.id },
            select: { weightCap: true, weightUsed: true },
          });
          return {
            outcome: "EXHAUSTED" as const,
            bucketStart,
            weightCap: current.weightCap,
            weightUsed: current.weightUsed,
          };
        }

        // The durable identity of THIS grant, written in the same transaction
        // as the weight it accounts for.
        const reservation = await tx.historicalFillWeightReservation.create({
          data: { bucketId: bucket.id, weight },
          select: { id: true },
        });

        return {
          outcome: "GRANTED" as const,
          reservation: {
            id: reservation.id,
            bucketId: bucket.id,
            executionProfileId: options.executionProfileId,
            bucketStart,
            weight,
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
   * Gives back a reservation whose dispatch is PROVEN not to have happened.
   *
   * Idempotent per reservation, and that is the whole point: the release is a
   * compare-and-set on the reservation row (`releasedAt IS NULL`), and the
   * bucket is decremented ONLY by the caller that won it. A second attempt --
   * from this process or any other, concurrently or minutes later -- matches
   * nothing and changes nothing.
   *
   * Releasing against the counter alone could not do this: `weightUsed >= 5`
   * is true whenever ANY reservation is outstanding, so a duplicate would give
   * back weight belonging to a different grant. That is an undercount, and an
   * undercount is the one error direction that lets the exchange allowance be
   * spent twice.
   *
   * Both statements are in one short transaction, so a crash mid-release
   * leaves either a whole release or none -- never a reservation marked
   * released whose weight is still counted, or weight given back by a
   * reservation that is still outstanding.
   */
  async releaseCertainNonDispatch(reservation: HistoricalFillWeightReservation): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
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

        // Whole, or not at all. Winning the CAS means this reservation WAS
        // outstanding, so its bucket must be able to fund the decrement; if it
        // cannot, the books were already wrong and committing here would make
        // that permanent -- the reservation would be marked released while its
        // weight stayed charged, and nothing could ever release it again.
        //
        // Throwing inside the transaction rolls the `releasedAt` CAS back with
        // it, so the reservation stays outstanding and stays releasable once
        // whoever corrupted the accounting has repaired it.
        if (decremented.count !== 1) {
          throw new HistoricalFillWeightBudgetInvariantError(
            `reservation ${reservation.id} was claimed for release but its bucket ` +
              `${reservation.bucketId} could not fund ${reservation.weight} weight`
          );
        }
      });
    } catch (error) {
      // An invariant violation is its own fact and travels unchanged; only a
      // genuine coordination failure becomes UNAVAILABLE.
      if (error instanceof HistoricalFillWeightBudgetInvariantError) throw error;
      throw new HistoricalFillWeightBudgetUnavailableError(
        error instanceof Error ? error.message.slice(0, 300) : "unknown"
      );
    }
  }

}
