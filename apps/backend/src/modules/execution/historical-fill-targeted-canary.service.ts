import type { HistoricalFillCampaign, PrismaClient } from "@prisma/client";

import {
  bindConfiguredExecutionProfileEnvironment,
  type BinanceProfileBindingFailure,
  type BinanceProfileBindingResult,
} from "./binance-profile-binding";
import {
  INGEST_CLAIM_LEASE_MS,
  MAX_INGEST_ATTEMPTS,
} from "./exchange-fill-ingest-window.service";
import {
  USER_TRADES_DISPATCH_ATTEMPTED,
  type FillIngestExecutionResult,
} from "./exchange-fill-one-window-executor.service";
import type {
  HistoricalFillCircuitObservation,
  HistoricalFillCircuitSnapshot,
} from "./historical-fill-circuit-breaker.service";
import type {
  HistoricalFillCampaignAdmissionResult,
  HistoricalFillWeightReservation,
} from "./historical-fill-weight-budget.service";

/**
 * ONE named historical window, executed once, by a human who chose it.
 *
 * Everything the scheduled path does to protect the account, this does too, in
 * the same order and through the same services: the same campaign slot, the
 * same cross-process weight ceiling, the same systemic latch, the same claim
 * fencing and the same refund. It is not a faster route past any of them; it is
 * the ordinary route with the FIFO queue replaced by an operator's choice.
 *
 * ## What it deliberately does NOT have
 *
 * No bootstrap -- the root must already exist. No scheduler and no loop -- one
 * invocation is one attempt. No fallback -- a target that cannot be claimed
 * ends the command rather than quietly becoming some other window, because an
 * operator who names SKYUSDT and silently gets a different symbol has been lied
 * to with a real exchange request.
 *
 * ## Why the runtime flag is not consulted
 *
 * `EXECUTION_FILL_RUNTIME_ENABLED` governs whether a WORKER schedules dispatches
 * on its own. This command is a person typing it, so the flag is irrelevant to
 * whether it may run -- and requiring it would mean enabling the automatic
 * scheduler in order to make one supervised request, which is the opposite of
 * what a canary is for.
 */

/** How one canary invocation ended. Exactly one of these, always. */
export type TargetedCanaryOutcome =
  | "EXECUTED"
  | "PROFILE_UNAVAILABLE"
  | "GLOBAL_WEIGHT_CAP_UNAVAILABLE"
  | "TARGET_NOT_FOUND"
  | "TARGET_NOT_ELIGIBLE"
  | "NO_ACTIVE_FILL_CAMPAIGN"
  | "CAMPAIGN_NOT_CANARY_SHAPED"
  | "SYSTEMIC_CIRCUIT_OPEN"
  | "CAMPAIGN_DISPATCH_BUDGET_EXHAUSTED"
  | "GLOBAL_USER_TRADES_WEIGHT_EXHAUSTED"
  | "GLOBAL_USER_TRADES_WEIGHT_CAP_MISMATCH"
  | "TARGET_LOST_AFTER_ADMISSION";

/** Why a named window was refused before any budget was spent. */
export type TargetedCanaryIneligibility =
  | "NOT_PENDING"
  | "ATTEMPTS_EXHAUSTED"
  | "BACKOFF_ACTIVE"
  | "LEASE_HELD";

/** The operator-safe summary. Every field here is deliberate; see the CLI. */
export interface TargetedCanaryResult {
  outcome: TargetedCanaryOutcome;
  windowId: string;
  symbol: string | null;
  startTimeMs: number | null;
  endTimeMs: number | null;
  ineligibility: TargetedCanaryIneligibility | null;
  profileReasonCode: BinanceProfileBindingFailure | null;
  executorOutcome: string | null;
  executorReasonCode: string | null;
  /** 0 or 1. Never more, on any path. */
  userTradesRequests: 0 | 1;
  userTradesWeightUsed: number;
  campaignStatus: string | null;
  dispatchesUsed: number | null;
  maxDispatches: number | null;
  circuit: HistoricalFillCircuitSnapshot | null;
  circuitOpened: boolean;
}

/** Exactly the executor capability this canary may use. Nothing wider. */
export interface TargetedCanaryExecutor {
  executeSpecificWindow: (options: {
    workerId: string;
    windowId: string;
    now?: Date;
  }) => Promise<FillIngestExecutionResult>;
}

/** Exactly the campaign reads this canary may perform. It creates nothing. */
export interface TargetedCanaryCampaignService {
  getLiveCampaign: (executionProfileId: string) => Promise<HistoricalFillCampaign | null>;
  getCampaignStatus: (campaignId: string) => Promise<HistoricalFillCampaign | null>;
}

/** Exactly the budget operations this canary may perform. */
export interface TargetedCanaryWeightBudget {
  admitCampaignDispatch: (options: {
    executionProfileId: string;
    weightCap: number;
  }) => Promise<HistoricalFillCampaignAdmissionResult>;
  releaseCertainNonDispatch: (reservation: HistoricalFillWeightReservation) => Promise<void>;
}

/**
 * Exactly the breaker operations this canary may perform.
 *
 * `readState` is the cheap pre-check and the reporting read; `observeDispatchOutcome`
 * is the activation hook. There is deliberately no `acknowledge` here: clearing
 * a latch is an operator decision of its own, and a canary that could clear one
 * on its way past would defeat the stop it exists to respect.
 */
export interface TargetedCanaryCircuitBreaker {
  readState: (options: { executionProfileId: string }) => Promise<HistoricalFillCircuitSnapshot>;
  observeDispatchOutcome: (options: {
    executionProfileId: string;
    campaignId: string;
    outcome: string;
    reasonCode?: string | null;
  }) => Promise<HistoricalFillCircuitObservation>;
}

export interface TargetedCanaryDependencies {
  prisma: PrismaClient;
  executor: TargetedCanaryExecutor;
  campaigns: TargetedCanaryCampaignService;
  weightBudget: TargetedCanaryWeightBudget;
  circuitBreaker: TargetedCanaryCircuitBreaker;
  /**
   * The configured cross-process ceiling, or undefined.
   *
   * Undefined is the ORDINARY case for this command: the env schema makes the
   * cap optional while `EXECUTION_FILL_RUNTIME_ENABLED` is false, which is
   * exactly the state a canary runs in. So it is carried as possibly-undefined
   * and refused explicitly below rather than defaulted -- a default here would
   * be this subsystem inventing a share of the account's exchange allowance
   * that nobody chose.
   */
  weightCap: number | undefined;
  bindProfile?: (prisma: PrismaClient) => Promise<BinanceProfileBindingResult>;
}

/** A campaign that exists solely to authorise ONE supervised request. */
const CANARY_MAX_DISPATCHES = 1;
const CANARY_DISPATCHES_USED = 0;

/** The weight one userTrades request costs, and the least a cap may therefore be. */
const CANARY_REQUEST_WEIGHT = 5;

function blank(windowId: string): TargetedCanaryResult {
  return {
    outcome: "EXECUTED",
    windowId,
    symbol: null,
    startTimeMs: null,
    endTimeMs: null,
    ineligibility: null,
    profileReasonCode: null,
    executorOutcome: null,
    executorReasonCode: null,
    userTradesRequests: 0,
    userTradesWeightUsed: 0,
    campaignStatus: null,
    dispatchesUsed: null,
    maxDispatches: null,
    circuit: null,
    circuitOpened: false,
  };
}

export class HistoricalFillTargetedCanary {
  private readonly bindProfile: (prisma: PrismaClient) => Promise<BinanceProfileBindingResult>;

  constructor(private readonly deps: TargetedCanaryDependencies) {
    this.bindProfile = deps.bindProfile ?? bindConfiguredExecutionProfileEnvironment;
  }

  /**
   * Runs the canary for ONE named window.
   *
   * The ordering below is the scheduled path's ordering, with the cheap
   * refusals first so that an operator's typo costs nothing: the cap, the
   * account, the target, the campaign shape and the latch are all settled
   * BEFORE `admitCampaignDispatch` spends anything. Admission itself remains
   * the authority -- it re-reads the latch under the profile lock -- so the
   * checks above it are convenience, never the fence.
   */
  async run(options: { workerId: string; windowId: string; now?: Date }): Promise<TargetedCanaryResult> {
    const now = options.now ?? new Date();
    const result = blank(options.windowId);

    // FAIL CLOSED ON THE CEILING, before anything else is read.
    //
    // The env schema leaves this optional while the runtime is off, which is
    // the state this command runs in, so undefined is a configuration an
    // operator reaches by accident rather than an impossibility. Refusing here
    // means a canary can never dispatch against an unbounded shared budget.
    const weightCap = this.deps.weightCap;
    if (
      weightCap === undefined ||
      !Number.isInteger(weightCap) ||
      weightCap < CANARY_REQUEST_WEIGHT ||
      weightCap % CANARY_REQUEST_WEIGHT !== 0
    ) {
      return { ...result, outcome: "GLOBAL_WEIGHT_CAP_UNAVAILABLE" };
    }

    const binding = await this.bindProfile(this.deps.prisma);
    if (!binding.ok) {
      return { ...result, outcome: "PROFILE_UNAVAILABLE", profileReasonCode: binding.reasonCode };
    }
    const executionProfileId = binding.context.executionProfileId;

    // --- TARGET PREFLIGHT. Convenience, NOT the fence. -----------------------
    //
    // The authority is `claimSpecificWindow`'s compare-and-set, which runs
    // after admission and can still lose. This read exists so that an operator
    // naming a finished or mistyped window is told so without spending the
    // campaign's only slot on it.
    const target = await this.deps.prisma.exchangeFillIngestWindow.findFirst({
      where: { id: options.windowId, executionProfileId },
      select: {
        id: true, symbol: true, status: true, attempts: true,
        claimedAt: true, nextEligibleAt: true,
        startTimeMs: true, endTimeMs: true,
      },
    });
    // Absent, or another account's. The two are ONE answer on purpose: telling
    // an operator that an id exists but belongs elsewhere would confirm the
    // existence of another account's rows.
    if (target === null) return { ...result, outcome: "TARGET_NOT_FOUND" };

    const located: TargetedCanaryResult = {
      ...result,
      windowId: target.id,
      symbol: target.symbol,
      startTimeMs: Number(target.startTimeMs),
      endTimeMs: Number(target.endTimeMs),
    };

    const ineligible = this.ineligibility(target, now);
    if (ineligible !== null) {
      return { ...located, outcome: "TARGET_NOT_ELIGIBLE", ineligibility: ineligible };
    }

    // --- THE LATCH, BEFORE THE CAMPAIGN. ------------------------------------
    //
    // Ordered here for the same reason the batch driver's gate orders it here:
    // opening the circuit PAUSES the profile's ACTIVE campaign in the same
    // transaction, so a campaign check that ran first would report
    // NO_ACTIVE_FILL_CAMPAIGN -- the effect -- and send an operator to resume a
    // campaign when the thing that actually stopped this account is a latch
    // only an acknowledgement can clear. Cause before consequence.
    //
    // Advisory only: `admitCampaignDispatch` re-reads the latch under the
    // profile lock and that read is what decides. This one exists so an OPEN
    // circuit costs no transaction at all.
    const preCircuit = await this.deps.circuitBreaker.readState({ executionProfileId });
    if (preCircuit.state === "OPEN") {
      return { ...located, outcome: "SYSTEMIC_CIRCUIT_OPEN", circuit: preCircuit };
    }

    // --- CAMPAIGN SHAPE. One slot, unspent. ---------------------------------
    const live = await this.deps.campaigns.getLiveCampaign(executionProfileId);
    if (live === null || live.status !== "ACTIVE") {
      return {
        ...located,
        outcome: "NO_ACTIVE_FILL_CAMPAIGN",
        campaignStatus: live?.status ?? null,
        dispatchesUsed: live?.dispatchesUsed ?? null,
        maxDispatches: live?.maxDispatches ?? null,
      };
    }
    // A canary proves ONE request. A campaign that could authorise a second is
    // not a canary campaign, and running against one would leave a live budget
    // behind after the operator walked away.
    if (
      live.maxDispatches !== CANARY_MAX_DISPATCHES ||
      live.dispatchesUsed !== CANARY_DISPATCHES_USED
    ) {
      return {
        ...located,
        outcome: "CAMPAIGN_NOT_CANARY_SHAPED",
        campaignStatus: live.status,
        dispatchesUsed: live.dispatchesUsed,
        maxDispatches: live.maxDispatches,
      };
    }

    const gated: TargetedCanaryResult = {
      ...located,
      campaignStatus: live.status,
      dispatchesUsed: live.dispatchesUsed,
      maxDispatches: live.maxDispatches,
    };

    // --- AUTHORITATIVE ADMISSION. Slot and weight, together or neither. -----
    const admission = await this.deps.weightBudget.admitCampaignDispatch({
      executionProfileId,
      weightCap,
    });

    if (admission.outcome === "SYSTEMIC_CIRCUIT_OPEN") {
      // The pre-check said CLOSED and somebody opened it in between. Nothing
      // was spent: the admission unwound everything it had touched.
      return {
        ...gated,
        outcome: "SYSTEMIC_CIRCUIT_OPEN",
        circuit: await this.deps.circuitBreaker.readState({ executionProfileId }),
        campaignStatus:
          (await this.deps.campaigns.getCampaignStatus(live.id))?.status ?? gated.campaignStatus,
      };
    }
    if (admission.outcome === "NO_ACTIVE_FILL_CAMPAIGN") {
      return { ...gated, outcome: "NO_ACTIVE_FILL_CAMPAIGN", campaignStatus: admission.campaignStatus };
    }
    if (admission.outcome === "CAMPAIGN_DISPATCH_BUDGET_EXHAUSTED") {
      return {
        ...gated,
        outcome: "CAMPAIGN_DISPATCH_BUDGET_EXHAUSTED",
        dispatchesUsed: admission.dispatchesUsed,
        maxDispatches: admission.maxDispatches,
      };
    }
    if (admission.outcome === "GLOBAL_USER_TRADES_WEIGHT_EXHAUSTED") {
      return { ...gated, outcome: "GLOBAL_USER_TRADES_WEIGHT_EXHAUSTED" };
    }
    if (admission.outcome === "CAP_MISMATCH") {
      return { ...gated, outcome: "GLOBAL_USER_TRADES_WEIGHT_CAP_MISMATCH" };
    }

    const reservation = admission.reservation;
    const admitted: TargetedCanaryResult = {
      ...gated,
      campaignStatus: admission.campaignStatus,
      dispatchesUsed: admission.dispatchesUsed,
      maxDispatches: admission.maxDispatches,
    };

    // --- THE ONE ATTEMPT. -----------------------------------------------------
    //
    // No try/catch, deliberately and exactly as the scheduled driver does it.
    // An invocation that ends in an exception MAY have reached the exchange,
    // and uncertain dispatch is always counted as spent: the slot and the
    // weight stay retained, and no breaker observation is fabricated from a
    // result that does not exist.
    //
    // No `now` is passed. The executor resolves a fresh instant per invocation,
    // which is the only value a lease or a backoff may honestly be stamped with.
    const executed = await this.deps.executor.executeSpecificWindow({
      workerId: options.workerId,
      windowId: options.windowId,
    });

    const dispatched = USER_TRADES_DISPATCH_ATTEMPTED[executed.outcome];
    if (!dispatched) {
      // PROVEN zero dispatch. For this command that means the targeted claim
      // did not win -- the window was finished, leased or taken between the
      // preflight and the compare-and-set -- or the profile fell away. Either
      // way no request left this process, so the slot and the weight go back
      // through the existing refund service. No manual SQL, and no second
      // window is attempted.
      await this.deps.weightBudget.releaseCertainNonDispatch(reservation);
    }

    // --- THE ACTIVATION HOOK, after a durable result and after the refund. ---
    const observation = await this.deps.circuitBreaker.observeDispatchOutcome({
      executionProfileId,
      campaignId: admission.campaignId,
      // Verbatim. This command owns no families, no thresholds and no opinion
      // about which codes are systemic: it asks, and the breaker answers.
      outcome: executed.outcome,
      reasonCode: executed.reasonCode ?? null,
    });

    const settledCampaign = await this.deps.campaigns.getCampaignStatus(admission.campaignId);

    return {
      ...admitted,
      outcome: dispatched ? "EXECUTED" : "TARGET_LOST_AFTER_ADMISSION",
      executorOutcome: executed.outcome,
      executorReasonCode: executed.reasonCode ?? null,
      userTradesRequests: dispatched ? 1 : 0,
      userTradesWeightUsed: dispatched ? CANARY_REQUEST_WEIGHT : 0,
      campaignStatus: settledCampaign?.status ?? admitted.campaignStatus,
      dispatchesUsed: settledCampaign?.dispatchesUsed ?? admitted.dispatchesUsed,
      maxDispatches: settledCampaign?.maxDispatches ?? admitted.maxDispatches,
      // THE OBSERVATION'S OWN snapshot, not a fresh read. It is the latch as it
      // stood in the transaction that judged this result; re-reading could
      // report a state some later moment reached instead.
      circuit: observation.circuit,
      circuitOpened: observation.result === "CIRCUIT_OPENED",
    };
  }

  /**
   * The preflight's reading of the SAME predicates the claim will apply.
   *
   * Kept in the same order and with the same thresholds as
   * `claimSpecificWindow`, so that what an operator is told about a refusal is
   * what would actually have stopped the claim.
   */
  private ineligibility(
    target: { status: string; attempts: number; claimedAt: Date | null; nextEligibleAt: Date | null },
    now: Date
  ): TargetedCanaryIneligibility | null {
    if (target.status !== "PENDING") return "NOT_PENDING";
    if (target.attempts >= MAX_INGEST_ATTEMPTS) return "ATTEMPTS_EXHAUSTED";
    if (target.nextEligibleAt !== null && target.nextEligibleAt.getTime() > now.getTime()) {
      return "BACKOFF_ACTIVE";
    }
    if (
      target.claimedAt !== null &&
      target.claimedAt.getTime() >= now.getTime() - INGEST_CLAIM_LEASE_MS
    ) {
      return "LEASE_HELD";
    }
    return null;
  }
}
