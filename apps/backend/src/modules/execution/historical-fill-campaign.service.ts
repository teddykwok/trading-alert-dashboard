import {
  Prisma,
  type HistoricalFillCampaign,
  type HistoricalFillCampaignStatus,
  type PrismaClient,
} from "@prisma/client";

import { lockCampaignForProfile } from "./historical-fill-campaign-lock";

/**
 * The only bound on a historical backfill that survives the next tick.
 *
 * ## What it is for
 *
 * Every other limit in this subsystem is instantaneous. A request weighs five;
 * a batch may take a handful of windows and a few tens of weight; a minute has
 * a weight ceiling. Not one of them constrains the NEXT tick, so a runtime
 * that is simply left enabled keeps going until the work queue empties. Before
 * authorising a backfill an operator asks one question -- how much will this do
 * in total -- and until this table existed the system had no way to answer it.
 *
 * A campaign is that answer, held durably so it survives ticks, workers,
 * crashes and restarts.
 *
 * ## The unit is an ADMITTED DISPATCH
 *
 * Not an executor invocation, and not a completed request. What is being spent
 * is an exchange allowance, and it is spent the moment a request MAY leave the
 * process. An invocation that threw still counts, because the throw proves
 * nothing about whether the request went out. Only outcomes decided before the
 * transport is touched give their slot back. So the counter can overstate what
 * was really spent and can never understate it, which is the safe direction.
 *
 * ## What this module does NOT do
 *
 * It does not admit, spend, exhaust or refund. It creates campaigns, moves
 * them between lifecycle states an operator asks for, and reads them back.
 * Wiring campaigns into the weight budget and the batch driver is a separate
 * change, deliberately, so that the state machine can be proven on its own
 * before anything is allowed to consume it.
 */

/**
 * The hard ceiling on one campaign, mirrored by a database CHECK.
 *
 * One dispatch weighs 5, so a full campaign is at most 500 weight against an
 * account allowance measured in thousands per minute: large enough to be worth
 * running, small enough that nobody can mistake it for unbounded.
 *
 * It lives in BOTH places on purpose. This constant is the friendly refusal
 * callers get; the CHECK is the one a future CLI, operator route or psql
 * session cannot talk its way past.
 */
export const MAX_CAMPAIGN_DISPATCHES = 100;

/** A campaign that may still be acted on, and of which a profile may have one. */
export const LIVE_CAMPAIGN_STATUSES = ["ACTIVE", "PAUSED"] as const satisfies readonly HistoricalFillCampaignStatus[];

/**
 * The caller asked for something the campaign rules forbid.
 *
 * Deliberately distinct from a conflict and from a bad transition: a rejected
 * ceiling is an operator typo, and collapsing it into "there is already a
 * campaign" would send them looking for a campaign that does not exist.
 */
export class HistoricalFillCampaignValidationError extends Error {
  readonly reasonCode = "FILL_CAMPAIGN_INVALID";
  constructor(detail: string) {
    super(`Historical fill campaign request is invalid: ${detail}`);
    this.name = "HistoricalFillCampaignValidationError";
  }
}

/**
 * A live campaign already exists for this profile.
 *
 * Its own class because it is the one failure with an obvious operator action
 * -- finish, abort or resume the campaign you already have -- and because it is
 * raised both by the pre-check and by the unique index catching a race the
 * pre-check could not see. Callers must not have to tell those apart.
 */
export class HistoricalFillCampaignConflictError extends Error {
  readonly reasonCode = "FILL_CAMPAIGN_CONFLICT";
  constructor(detail: string) {
    super(`Historical fill campaign conflicts with an existing campaign: ${detail}`);
    this.name = "HistoricalFillCampaignConflictError";
  }
}

/**
 * The campaign exists but is not in a state this transition accepts.
 *
 * Reports the state found, never a row, so an operator can see why without the
 * error becoming a data channel.
 */
export class HistoricalFillCampaignStateError extends Error {
  readonly reasonCode = "FILL_CAMPAIGN_STATE";
  constructor(detail: string) {
    super(`Historical fill campaign is not in a state that allows this: ${detail}`);
    this.name = "HistoricalFillCampaignStateError";
  }
}

/** No campaign with that id. Separate from a state error: nothing to act on at all. */
export class HistoricalFillCampaignNotFoundError extends Error {
  readonly reasonCode = "FILL_CAMPAIGN_NOT_FOUND";
  constructor(campaignId: string) {
    super(`Historical fill campaign ${campaignId} does not exist`);
    this.name = "HistoricalFillCampaignNotFoundError";
  }
}

export interface CreateCampaignInput {
  executionProfileId: string;
  /** Total admissions this campaign may ever grant. Frozen at creation. */
  maxDispatches: number;
  /** Free operator text saying why this backfill is being run. Never a credential. */
  note?: string | null;
}

/**
 * Reject anything that is not a whole number in range, BEFORE it reaches SQL.
 *
 * `Number.isSafeInteger` rather than `Number.isInteger` because 2^53 and beyond
 * lose the ability to represent their own neighbours: a value that survived an
 * integer check there would be silently rounded on its way to an int4 column.
 * It also rejects NaN and both infinities for free -- NaN in particular would
 * pass any `>= 1 && <= 100` pair of comparisons by failing both of them, which
 * is exactly the kind of check that looks correct and is not.
 */
function assertDispatchCeiling(maxDispatches: number): void {
  if (!Number.isSafeInteger(maxDispatches)) {
    throw new HistoricalFillCampaignValidationError(
      `maxDispatches must be a whole number, received ${String(maxDispatches)}`
    );
  }
  if (maxDispatches < 1 || maxDispatches > MAX_CAMPAIGN_DISPATCHES) {
    throw new HistoricalFillCampaignValidationError(
      `maxDispatches must be between 1 and ${MAX_CAMPAIGN_DISPATCHES}, received ${maxDispatches}`
    );
  }
}

/** Postgres' unique-violation code, as Prisma surfaces it. */
const UNIQUE_VIOLATION = "P2002";

/**
 * Campaign lifecycle, owned by the database rather than by its callers.
 *
 * Every mutating method runs inside one short transaction that takes the
 * per-profile campaign lock first and re-reads the campaign afterwards. The
 * pre-lock read of a campaign's profile is safe because `executionProfileId`
 * is immutable -- the campaign's ACCOUNT never changes, only its state -- so
 * the value used to compute the lock key cannot be stale in a way that matters.
 */
export class HistoricalFillCampaignService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Open a campaign, ACTIVE, with its ceiling frozen.
   *
   * The pre-check inside the lock gives operators a clear conflict error; the
   * unique index gives correctness. Both are kept because they answer different
   * questions: the check explains, the index enforces. A create racing another
   * create on a profile with no campaign at all passes both pre-checks, and the
   * index is what makes one of them lose.
   */
  async createCampaign(input: CreateCampaignInput): Promise<HistoricalFillCampaign> {
    assertDispatchCeiling(input.maxDispatches);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockCampaignForProfile(tx, input.executionProfileId);

        const live = await tx.historicalFillCampaign.findFirst({
          where: { executionProfileId: input.executionProfileId, status: { in: [...LIVE_CAMPAIGN_STATUSES] } },
          select: { id: true, status: true },
        });
        if (live) {
          throw new HistoricalFillCampaignConflictError(
            `profile ${input.executionProfileId} already has campaign ${live.id} in state ${live.status}`
          );
        }

        return await tx.historicalFillCampaign.create({
          data: {
            executionProfileId: input.executionProfileId,
            // Stated, never defaulted: a campaign that existed because a field
            // was omitted would be an accidental licence to spend.
            status: "ACTIVE",
            maxDispatches: input.maxDispatches,
            note: input.note ?? null,
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) {
        throw new HistoricalFillCampaignConflictError(
          `profile ${input.executionProfileId} already has a live campaign`
        );
      }
      throw error;
    }
  }

  /**
   * Stop granting slots without giving them up.
   *
   * PAUSED is a LIVE state: the campaign still owns its remaining slots and
   * still occupies its profile's one live slot, so pausing is emphatically not
   * a way to start a second campaign beside the first.
   */
  async pauseCampaign(campaignId: string): Promise<HistoricalFillCampaign> {
    return this.transition(campaignId, {
      from: ["ACTIVE"],
      to: "PAUSED",
      // Not an ending. A paused campaign is expected back.
      endedAt: "unchanged",
    });
  }

  /**
   * Put a paused campaign back to work.
   *
   * ONLY from PAUSED. EXHAUSTED is refused on purpose: a campaign reaches it by
   * spending every slot an operator authorised, and letting `resume` undo that
   * would turn the ceiling into a suggestion. The single reactivation the
   * design does allow belongs to the refund path, which reopens a campaign only
   * when it has just PROVEN that the dispatch its final slot paid for never
   * happened. That is a fact about reality; this is a person clicking a button.
   *
   * Status alone is the condition, and that is complete rather than lax: a
   * campaign reaches its ceiling inside the very transaction that grants its
   * last slot, and that transaction marks it EXHAUSTED. A PAUSED campaign with
   * no slots left therefore cannot exist to be resumed.
   */
  async resumeCampaign(campaignId: string): Promise<HistoricalFillCampaign> {
    return this.transition(campaignId, {
      from: ["PAUSED"],
      to: "ACTIVE",
      endedAt: "unchanged",
    });
  }

  /**
   * End a campaign for good.
   *
   * Accepts the two live states and EXHAUSTED -- an operator finishing off a
   * campaign that spent its allowance is ordinary, and doing so is exactly how
   * they declare that no refund should ever reopen it.
   *
   * Refuses COMPLETED and ABORTED, which are hard terminals. Re-aborting an
   * abort is harmless but rewriting a COMPLETED campaign is not: it would
   * rewrite the record of how a finished backfill ended, and this table is the
   * audit trail for spending a real account's allowance.
   */
  async abortCampaign(campaignId: string, note?: string | null): Promise<HistoricalFillCampaign> {
    return this.transition(campaignId, {
      from: ["ACTIVE", "PAUSED", "EXHAUSTED"],
      to: "ABORTED",
      endedAt: "now",
      note,
    });
  }

  /**
   * The one campaign a profile may currently be acting on, or null.
   *
   * `findFirst` rather than `findUnique` because the uniqueness lives in a
   * partial index Prisma cannot model, so there is no generated unique
   * accessor to call. The index still guarantees at most one row matches.
   */
  async getLiveCampaign(executionProfileId: string): Promise<HistoricalFillCampaign | null> {
    return this.prisma.historicalFillCampaign.findFirst({
      where: { executionProfileId, status: { in: [...LIVE_CAMPAIGN_STATUSES] } },
    });
  }

  /** One campaign by id, whatever its state, or null. Read-only and unlocked. */
  async getCampaignStatus(campaignId: string): Promise<HistoricalFillCampaign | null> {
    return this.prisma.historicalFillCampaign.findUnique({ where: { id: campaignId } });
  }

  /**
   * The one place a campaign's status moves.
   *
   * Under the profile lock, and with the accepted states re-proven in the
   * UPDATE's own WHERE clause rather than only in the preceding read. The lock
   * already excludes the interleaving, so the conditional update is defence in
   * depth -- but it is the difference between a transition that is correct
   * because of a lock somebody might later move, and one that is correct on its
   * own terms.
   *
   * `maxDispatches` and `dispatchesUsed` are never in `data`. The ceiling is
   * frozen at creation because raising it later would retroactively change what
   * an operator authorised, and the counter belongs to admission alone.
   */
  private async transition(
    campaignId: string,
    spec: {
      from: readonly HistoricalFillCampaignStatus[];
      to: HistoricalFillCampaignStatus;
      endedAt: "now" | "unchanged";
      note?: string | null;
    }
  ): Promise<HistoricalFillCampaign> {
    // The profile is immutable, so reading it before the lock cannot go stale.
    const existing = await this.prisma.historicalFillCampaign.findUnique({
      where: { id: campaignId },
      select: { executionProfileId: true },
    });
    if (!existing) throw new HistoricalFillCampaignNotFoundError(campaignId);

    return this.prisma.$transaction(async (tx) => {
      await lockCampaignForProfile(tx, existing.executionProfileId);

      const current = await tx.historicalFillCampaign.findUnique({
        where: { id: campaignId },
        select: { status: true },
      });
      if (!current) throw new HistoricalFillCampaignNotFoundError(campaignId);
      if (!spec.from.includes(current.status)) {
        throw new HistoricalFillCampaignStateError(
          `campaign ${campaignId} is ${current.status}, expected one of ${spec.from.join(", ")}`
        );
      }

      const moved = await tx.historicalFillCampaign.updateMany({
        where: { id: campaignId, status: { in: [...spec.from] } },
        data: {
          status: spec.to,
          ...(spec.endedAt === "now" ? { endedAt: new Date() } : {}),
          ...(spec.note === undefined ? {} : { note: spec.note }),
        },
      });
      if (moved.count !== 1) {
        throw new HistoricalFillCampaignStateError(
          `campaign ${campaignId} left ${spec.from.join(", ")} while being moved to ${spec.to}`
        );
      }

      const updated = await tx.historicalFillCampaign.findUnique({ where: { id: campaignId } });
      if (!updated) throw new HistoricalFillCampaignNotFoundError(campaignId);
      return updated;
    });
  }
}
