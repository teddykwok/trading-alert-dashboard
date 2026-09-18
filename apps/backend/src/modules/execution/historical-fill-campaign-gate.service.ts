import type { HistoricalFillCampaignStatus, PrismaClient } from "@prisma/client";

import {
  bindConfiguredExecutionProfileEnvironment,
  type BinanceProfileBindingFailure,
  type BinanceProfileBindingResult,
} from "./binance-profile-binding";
import { lockCampaignForProfile } from "./historical-fill-campaign-lock";
import {
  circuitDenialOf,
  readCircuitState,
  type HistoricalFillCircuitDenial,
} from "./historical-fill-circuit-breaker.service";

/**
 * The campaign a historical batch is running under, and the queue question
 * that decides whether it is finished.
 *
 * ## Why this is its own seam
 *
 * The batch driver must answer "is there a campaign?" BEFORE it bootstraps
 * roots, and bootstrap is the thing that resolves the account. So the gate has
 * to bind the profile itself. It binds through exactly the same binder the
 * bootstrap uses -- `bindConfiguredExecutionProfileEnvironment`, which takes no
 * profile id precisely so no caller can point it at an account it was not
 * authorized to touch -- which means the two binds agree unless configuration
 * changes mid-pass. That is the same independence the bootstrap and the
 * executor already have, and it is deliberate: each layer proves the account
 * for itself rather than trusting a value handed down.
 *
 * ## EXHAUSTED and COMPLETED are not the same fact
 *
 * EXHAUSTED means the BUDGET ended the campaign: every slot an operator
 * authorised was spent. COMPLETED means the QUEUE drained first. Collapsing
 * them would destroy the only signal that says whether a backfill finished its
 * work or merely ran out of permission, so this service will only ever move an
 * ACTIVE campaign to COMPLETED, and never touches one that is already EXHAUSTED.
 */

/** What the driver needs to know about the campaign it is running under. */
export interface HistoricalFillBatchCampaign {
  id: string;
  status: HistoricalFillCampaignStatus;
  dispatchesUsed: number;
  maxDispatches: number;
  dispatchesRemaining: number;
}

export type HistoricalFillCampaignGateResult =
  | { outcome: "PROFILE_UNAVAILABLE"; reasonCode: BinanceProfileBindingFailure }
  | {
      /**
       * The profile's systemic latch is OPEN. Nothing may run, and CIRCUIT_OPEN
       * WINS over every campaign state.
       *
       * Reported before the bootstrap, which is the entire value of asking here
       * rather than only at admission: a stopped account writes no roots, claims
       * no window, burns no ingest attempt and issues no request. Admission
       * remains the authoritative check, because this read is unlocked and can
       * go stale between here and there.
       *
       * An ACTIVE campaign alongside an OPEN latch should be unreachable --
       * opening pauses the current ACTIVE campaign in the same transaction --
       * so if one is seen here it is corruption or an older race, and the
       * refusal is still the right answer. The campaign is reported as metadata,
       * never as authority.
       */
      outcome: "CIRCUIT_OPEN";
      executionProfileId: string;
      /**
       * The most recent campaign, for context, or null if the profile never had
       * one. Best-effort and advisory: it is a second unlocked read, so it may
       * not be perfectly coherent with the latch beside it. Nothing decides
       * anything on it.
       */
      campaign: HistoricalFillBatchCampaign | null;
      circuit: HistoricalFillCircuitDenial;
    }
  | {
      outcome: "ACTIVE";
      executionProfileId: string;
      campaign: HistoricalFillBatchCampaign;
    }
  | {
      outcome: "NO_ACTIVE_CAMPAIGN";
      executionProfileId: string;
      /**
       * The most recent campaign, whatever became of it, or null if the profile
       * has never had one.
       *
       * Carried so an operator can tell "nobody ever started a backfill" from
       * "it is paused", "it spent its budget", "it finished" and "somebody
       * aborted it" WITHOUT five separate stop reasons. After an ordinary
       * exhaustion this is what still shows what just happened.
       */
      campaign: HistoricalFillBatchCampaign | null;
    };

function describe(campaign: {
  id: string;
  status: HistoricalFillCampaignStatus;
  dispatchesUsed: number;
  maxDispatches: number;
}): HistoricalFillBatchCampaign {
  return {
    id: campaign.id,
    status: campaign.status,
    dispatchesUsed: campaign.dispatchesUsed,
    maxDispatches: campaign.maxDispatches,
    dispatchesRemaining: Math.max(0, campaign.maxDispatches - campaign.dispatchesUsed),
  };
}

export interface HistoricalFillCampaignGateDependencies {
  prisma: PrismaClient;
  /** Injectable only so tests can drive a binding failure; the default is the real binder. */
  bindProfile?: (prisma: PrismaClient) => Promise<BinanceProfileBindingResult>;
}

export class HistoricalFillCampaignGate {
  private readonly bindProfile: (prisma: PrismaClient) => Promise<BinanceProfileBindingResult>;

  constructor(private readonly deps: HistoricalFillCampaignGateDependencies) {
    this.bindProfile = deps.bindProfile ?? bindConfiguredExecutionProfileEnvironment;
  }

  /**
   * The campaign this pass may spend from, resolved before anything is written.
   *
   * Read-only by construction: it binds, it reads, and it returns. A pass that
   * has no campaign must leave the database exactly as it found it, and the
   * cheapest way to guarantee that is for this call to be incapable of writing.
   */
  async resolveForBatch(): Promise<HistoricalFillCampaignGateResult> {
    const binding = await this.bindProfile(this.deps.prisma);
    if (!binding.ok) {
      // The binder's exact reason, unflattened, and not one row read further.
      return { outcome: "PROFILE_UNAVAILABLE", reasonCode: binding.reasonCode };
    }
    const executionProfileId = binding.context.executionProfileId;

    // THE LATCH IS ASKED FIRST, and it OUTRANKS every campaign state.
    //
    // Ordered ahead of the ACTIVE lookup on purpose. Asking about the campaign
    // first and the circuit second would leave a reachable shape in which a
    // stale or corrupted ACTIVE row returns ACTIVE while the account is stopped
    // -- and the driver would bootstrap on it. Asked in this order, no campaign
    // state can outvote an open circuit.
    //
    // Unlocked and read-only, like the rest of this method. That makes it a
    // FAST FAIL-CLOSED PATH rather than the decision: its value is saving the
    // bootstrap, the claim and the request. The admission that follows re-reads
    // the same latch under the profile lock and is the authority.
    const circuit = await readCircuitState(this.deps.prisma, executionProfileId);
    if (circuit.state === "OPEN") {
      // Context only, and gathered AFTER the refusal is already decided: this
      // second read cannot change the answer, it can only describe it.
      const latest = await this.latestCampaign(executionProfileId);
      return {
        outcome: "CIRCUIT_OPEN",
        executionProfileId,
        campaign: latest,
        circuit: circuitDenialOf(circuit),
      };
    }

    const active = await this.deps.prisma.historicalFillCampaign.findFirst({
      where: { executionProfileId, status: "ACTIVE" },
      select: { id: true, status: true, dispatchesUsed: true, maxDispatches: true },
    });
    if (active) {
      return { outcome: "ACTIVE", executionProfileId, campaign: describe(active) };
    }

    return {
      outcome: "NO_ACTIVE_CAMPAIGN",
      executionProfileId,
      campaign: await this.latestCampaign(executionProfileId),
    };
  }

  /** The profile's most recent campaign, whatever became of it, or null. */
  private async latestCampaign(
    executionProfileId: string
  ): Promise<HistoricalFillBatchCampaign | null> {
    const latest = await this.deps.prisma.historicalFillCampaign.findFirst({
      where: { executionProfileId },
      orderBy: { startedAt: "desc" },
      select: { id: true, status: true, dispatchesUsed: true, maxDispatches: true },
    });
    return latest ? describe(latest) : null;
  }

  /**
   * One campaign by id, as it stands right now.
   *
   * A single primary-key read with no binding: the driver uses it after a
   * refund, because a refund gives a slot back and may have reopened a campaign
   * that its own final admission had just exhausted. Reporting the counts as
   * they were BEFORE the refund would overstate what the account spent, in
   * exactly the passes that spent nothing.
   */
  async describeCampaign(campaignId: string): Promise<HistoricalFillBatchCampaign | null> {
    const campaign = await this.deps.prisma.historicalFillCampaign.findUnique({
      where: { id: campaignId },
      select: { id: true, status: true, dispatchesUsed: true, maxDispatches: true },
    });
    return campaign ? describe(campaign) : null;
  }

  /**
   * Moves an ACTIVE campaign to COMPLETED once the queue holds no PENDING work.
   *
   * ## The predicate is PENDING rows, with no attempts filter
   *
   * Every PENDING row blocks completion: one waiting out a retry backoff, one
   * currently leased by another worker, and — the case worth stating — one that
   * has exhausted its ingest attempts. An attempt-exhausted row is still a
   * declared gap in coverage; calling the campaign COMPLETE while it sits there
   * would turn "we gave up on this window" into "we finished". Terminal rows do
   * NOT block: ABANDONED, INCOMPLETE_SKIPPED_ROWS and
   * SATURATED_SINGLE_MILLISECOND are finished facts, and the operator surfaces
   * them through the existing window-issue interpretation, not through this.
   *
   * ## Only ACTIVE may complete
   *
   * Under the same per-profile advisory lock every campaign transition takes,
   * so the read and the write cannot straddle an operator's pause or abort. A
   * campaign that is PAUSED, ABORTED, already COMPLETED, or EXHAUSTED is left
   * exactly as it is — EXHAUSTED especially: its budget ended it, and quietly
   * relabelling that as COMPLETED because the queue later happened to drain
   * would erase the distinction the two states exist to draw.
   *
   * Returns the campaign's status afterwards, so the caller reports what is
   * true rather than what it assumed.
   */
  async completeIfDrained(
    executionProfileId: string,
    campaignId: string
  ): Promise<HistoricalFillCampaignStatus> {
    return this.deps.prisma.$transaction(async (tx) => {
      await lockCampaignForProfile(tx, executionProfileId);

      const campaign = await tx.historicalFillCampaign.findUnique({
        where: { id: campaignId },
        select: { status: true },
      });
      if (!campaign) {
        throw new HistoricalFillCampaignGateInvariantError(
          `campaign ${campaignId} vanished while a batch was running under it`
        );
      }
      if (campaign.status !== "ACTIVE") return campaign.status;

      const pending = await tx.exchangeFillIngestWindow.count({
        where: { executionProfileId, status: "PENDING" },
      });
      if (pending > 0) return campaign.status;

      const completed = await tx.historicalFillCampaign.updateMany({
        where: { id: campaignId, status: "ACTIVE" },
        data: { status: "COMPLETED", endedAt: new Date() },
      });
      return completed.count === 1 ? "COMPLETED" : campaign.status;
    });
  }
}

/** A contract bug in this file, surfaced rather than reported as fact. */
export class HistoricalFillCampaignGateInvariantError extends Error {
  readonly reasonCode = "HISTORICAL_FILL_CAMPAIGN_GATE_INVARIANT";
  constructor(detail: string) {
    super(`Historical fill campaign gate invariant violated: ${detail}`);
    this.name = "HistoricalFillCampaignGateInvariantError";
  }
}
