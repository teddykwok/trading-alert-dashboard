import { BINANCE_READ_ONLY_ENDPOINTS } from "../binance/binance.endpoints";
// The dispatch-attempted table is a VALUE, and deliberately imported rather
// than restated: it is the single predicate deciding whether weight was spent,
// and a second copy here could drift from the one the operator canary applies.
// Safe as a value import -- the executor does not import this module back.
import { USER_TRADES_DISPATCH_ATTEMPTED } from "./exchange-fill-one-window-executor.service";
import type {
  ExchangeFillOneWindowExecutor,
  FillIngestExecutionOutcome,
  FillIngestExecutionResult,
} from "./exchange-fill-one-window-executor.service";
import type { ExchangeFillRootBootstrap, FillRootBootstrapResult } from "./exchange-fill-root-bootstrap.service";
// TYPE-ONLY, and load-bearing that it stays so: the weight budget imports
// `USER_TRADES_REQUEST_WEIGHT` from this file as a value, so a value import
// back would be a runtime cycle. Type imports are erased.
import type {
  HistoricalFillCampaignAdmissionResult,
  HistoricalFillWeightReservation,
} from "./historical-fill-weight-budget.service";
import type {
  HistoricalFillBatchCampaign,
  HistoricalFillCampaignGateResult,
} from "./historical-fill-campaign-gate.service";
import {
  circuitDenialOf,
  type HistoricalFillCircuitDenial,
  type HistoricalFillCircuitObservation,
} from "./historical-fill-circuit-breaker.service";
import type { HistoricalFillCampaignStatus } from "@prisma/client";

/**
 * ONE bounded pass of historical fill ingestion: make the work exist, then
 * spend a fixed number of attempts on it.
 *
 * ## Orchestration only
 *
 * Nothing here claims a window, talks to an exchange, writes a ledger row,
 * classifies a failure or decides a retry time. Those belong to the approved
 * bootstrap and one-window executor, and this driver's entire job is to decide
 * HOW MANY TIMES to ask and WHEN TO STOP ASKING.
 *
 * ## Bounded, and it returns
 *
 * There is no loop that can outlive its argument: the iteration count is the
 * caller's `maxWindows` and nothing extends it. The driver never sleeps, never
 * schedules itself and never decides when it runs again -- a caller invokes it,
 * it returns a summary, and that is the whole lifecycle.
 *
 * ## Two different clocks, deliberately
 *
 * `now` is the caller's instant and belongs to the BOOTSTRAP alone: which UTC
 * days are complete is a question about a fixed moment, and freezing it is what
 * makes a pass reproducible.
 *
 * ## The weight budget is about ONE endpoint
 *
 * A pass also carries a ceiling on the Binance REQUEST_WEIGHT it may spend on
 * `GET /fapi/v1/userTrades`, and on nothing else. It is NOT an account or IP
 * rate limiter: server-time syncs, orders, account reads, market data, other
 * workers and anything a human does by hand are all outside it. The names here
 * say `userTrades` everywhere precisely so this cannot be mistaken for a global
 * limiter it is not.
 *
 * Execution time is NOT that instant, and must not be. `claimNextWindow` writes
 * `claimedAt` and `scheduleRetry` writes `nextEligibleAt`, and both are later
 * compared against REAL time -- by this process and, more importantly, by other
 * workers that never saw this batch's `now`. Stamping a lease acquired ninety
 * seconds into a pass with the timestamp the pass STARTED at would backdate it:
 * a second worker computing `realNow - INGEST_CLAIM_LEASE_MS` would find the
 * fresh lease already expired and could take the window out from under a worker
 * still using it. The same backdating shortens a retry's real backoff, because
 * `nextEligibleAt = now + INGEST_RETRY_BACKOFF_MS` measured from a stale `now`
 * comes due early.
 *
 * So each iteration lets the executor resolve its own instant -- it already
 * does exactly that when `now` is omitted -- and this driver simply stops
 * forwarding a timestamp that is no longer true by the time it is used.
 */

/**
 * What ONE `/fapi/v1/userTrades` dispatch costs, taken from the endpoint
 * registry rather than restated. The registry is the repository's documented
 * weight table and is already pinned by its own test, so a change there moves
 * this budget with it instead of leaving two numbers to drift apart.
 */
export const USER_TRADES_REQUEST_WEIGHT = BINANCE_READ_ONLY_ENDPOINTS.userTrades.weight;


/** Why the pass stopped. Exactly one of these ends every invocation. */
export type FillBatchStopReason =
  | "NO_WORK"
  | "PROFILE_UNAVAILABLE"
  | "MAX_WINDOWS_REACHED"
  | "USER_TRADES_WEIGHT_BUDGET_EXHAUSTED"
  /**
   * The CROSS-PROCESS ceiling is full for this accounting minute.
   *
   * Deliberately distinct from `USER_TRADES_WEIGHT_BUDGET_EXHAUSTED`, which
   * means THIS pass spent its own local budget. The two need different
   * operator responses -- one says the batch did its configured work, the
   * other says other processes are already using the account's share -- so
   * collapsing them would destroy the only signal that distinguishes them.
   */
  | "GLOBAL_USER_TRADES_WEIGHT_BUDGET_EXHAUSTED"
  /** A configured ceiling disagrees with the one already in force. */
  | "GLOBAL_USER_TRADES_WEIGHT_CAP_MISMATCH"
  /**
   * No ACTIVE campaign authorises this account to spend anything.
   *
   * The ORDINARY way a bounded backfill stops. When a campaign takes its final
   * slot it becomes EXHAUSTED inside that same transaction, so the very next
   * pass finds no ACTIVE campaign and lands here -- not on
   * `CAMPAIGN_DISPATCH_BUDGET_EXHAUSTED`. It is equally what a paused, aborted,
   * completed or never-started profile produces, which is why the campaign
   * fields on the result carry the status: five stop reasons would say nothing
   * the metadata does not, and each would have to be kept in step forever.
   */
  | "NO_ACTIVE_FILL_CAMPAIGN"
  /**
   * An ACTIVE campaign with no slots left.
   *
   * Unreachable in ordinary flow, by construction -- the transaction that takes
   * the last slot marks the campaign EXHAUSTED -- so this is the fail-closed
   * path for a hand-edited or corrupted row. Kept distinct from the two weight
   * ceilings: "your budget is spent" and "this minute is busy" demand
   * completely different operator responses.
   */
  | "CAMPAIGN_DISPATCH_BUDGET_EXHAUSTED"
  /**
   * The profile's SYSTEMIC circuit is open, so the account is stopped entirely.
   *
   * Categorically different from every other stop reason here, and that is why
   * it is its own. The rest describe a bound being reached -- a budget, a
   * ceiling, a queue -- all of which are the system working as designed. This
   * one says a repeated fault was detected and an operator must look at it:
   * nothing will run for this account again, on any tick, until somebody
   * acknowledges the circuit. Folding it into `NO_ACTIVE_FILL_CAMPAIGN` would
   * turn a standing incident into an ordinary quiet pass.
   *
   * Reached two ways, and the result says which by whether `bootstrap` is null:
   * refused by the pre-bootstrap gate, or refused by the authoritative
   * admission after a stale gate let the pass get that far.
   */
  | "SYSTEMIC_CIRCUIT_OPEN";

/**
 * The campaign this pass ran under, as it stood when the pass ended.
 *
 * Every field is null when no campaign exists for the account at all. After an
 * ordinary exhaustion or completion these still describe the campaign that just
 * finished, which is the whole point: an operator reading a summary after the
 * fact needs to see what happened, not an empty space where a live campaign
 * used to be.
 *
 * No `note`: it is free operator text, and a summary that is logged does not
 * carry arbitrary strings.
 */
export interface HistoricalFillCampaignAccounting {
  campaignId: string | null;
  campaignStatus: HistoricalFillCampaignStatus | null;
  campaignDispatchesUsed: number | null;
  campaignMaxDispatches: number | null;
  campaignDispatchesRemaining: number | null;
}

const NO_CAMPAIGN_ACCOUNTING: HistoricalFillCampaignAccounting = {
  campaignId: null,
  campaignStatus: null,
  campaignDispatchesUsed: null,
  campaignMaxDispatches: null,
  campaignDispatchesRemaining: null,
};

function campaignAccounting(
  campaign: HistoricalFillBatchCampaign | null
): HistoricalFillCampaignAccounting {
  if (campaign === null) return NO_CAMPAIGN_ACCOUNTING;
  return {
    campaignId: campaign.id,
    campaignStatus: campaign.status,
    campaignDispatchesUsed: campaign.dispatchesUsed,
    campaignMaxDispatches: campaign.maxDispatches,
    campaignDispatchesRemaining: campaign.dispatchesRemaining,
  };
}

/**
 * What the pass spent on userTrades, and what it had.
 *
 * `used` counts reservations that were KEPT. A speculative reservation refunded
 * because the invocation turned out to dispatch nothing never appears here, so
 * `used` stays an honest multiple of one dispatch.
 */
export interface UserTradesWeightAccounting {
  userTradesRequestWeightPerDispatch: number;
  userTradesWeightBudget: number;
  userTradesWeightUsed: number;
  userTradesWeightRemaining: number;
}

/**
 * How many invocations ended in each durable outcome.
 *
 * `NO_WORK` and `PROFILE_UNAVAILABLE` are deliberately absent: they are not
 * things that happened to a window, they are the reason the pass ended, and
 * counting them here would make "windows worked" mean two different things.
 */
export interface FillBatchOutcomeCounts {
  COMPLETE: number;
  INCOMPLETE_SKIPPED_ROWS: number;
  SPLIT: number;
  SATURATED_SINGLE_MILLISECOND: number;
  RETRY_SCHEDULED: number;
  ABANDONED: number;
  STALE_CLAIM: number;
}

/**
 * What the breaker reported about a trip THIS pass caused.
 *
 * Deliberately not the full snapshot. A transition is an event, and an event
 * needs the cause and the rule it met -- family, reason, how many in a row, and
 * what the bound was. `generation` is absent on purpose: it is internal fencing
 * state whose only consumer is the refund comparison, and an epoch number in an
 * operator log invites exactly the interpretation this design avoids.
 */
export interface HistoricalFillCircuitTransition {
  campaignId: string;
  failureFamily: string | null;
  lastReasonCode: string | null;
  consecutiveCount: number;
  /** The bound this family had to reach, as the breaker service reported it. */
  threshold: number | null;
  openedAt: Date | null;
}

/** The bootstrap's own success summary, unaltered. */
export type FillRootBootstrapSummary = Extract<FillRootBootstrapResult, { outcome: "BOOTSTRAPPED" }>;

export type HistoricalFillBatchResult =
  | ({
      outcome: "PROFILE_UNAVAILABLE";
      /**
       * Which layer could not name the account.
       *
       * `CAMPAIGN` is the earliest: the campaign gate binds before the
       * bootstrap, so a profile that cannot be resolved is now caught before a
       * single root is written rather than after.
       */
      stage: "CAMPAIGN" | "BOOTSTRAP" | "EXECUTION";
      /** The binder's own code, carried through both layers unflattened. */
      reasonCode: string;
      /** Null when the bootstrap itself could not bind. */
      bootstrap: FillRootBootstrapSummary | null;
      executionInvocations: number;
      outcomes: FillBatchOutcomeCounts;
    } & UserTradesWeightAccounting &
      HistoricalFillCampaignAccounting)
  | ({
      /**
       * Stopped before the bootstrap because nothing authorises this account.
       *
       * `bootstrap` is null and not a summary: the pass did not run one. That is
       * the load-bearing part of this arm -- no roots, no claims, no requests.
       */
      outcome: "NO_ACTIVE_FILL_CAMPAIGN" | "CAMPAIGN_DISPATCH_BUDGET_EXHAUSTED";
      bootstrap: null;
      executionInvocations: number;
      outcomes: FillBatchOutcomeCounts;
    } & UserTradesWeightAccounting &
      HistoricalFillCampaignAccounting)
  | ({
      /**
       * Stopped because the account's systemic circuit is OPEN.
       *
       * `bootstrap` is nullable here and NOT always null, which is the honest
       * shape rather than a tidy one: the gate refuses before the bootstrap and
       * reports null, while the stale-gate race is refused at admission, by
       * which point roots have already been written. Roots are idempotent and
       * cost nothing, so that is acceptable -- but claiming null would be a
       * summary that said no work was done when some was.
       *
       * What is guaranteed on BOTH paths is the part that matters: no campaign
       * slot, no minute weight, no reservation row and no executor invocation
       * attributable to this denial.
       */
      outcome: "SYSTEMIC_CIRCUIT_OPEN";
      bootstrap: FillRootBootstrapSummary | null;
      executionInvocations: number;
      outcomes: FillBatchOutcomeCounts;
      /**
       * The latch that stopped the pass, from whichever check refused it: the
       * gate's advisory read, or the admission's authoritative locked one.
       * Never the two mixed, and never invented.
       */
      circuit: HistoricalFillCircuitDenial;
      /**
       * Set ONLY when THIS pass performed the CLOSED -> OPEN transition.
       *
       * Null on both already-open paths -- the gate's and the admission's -- and
       * null when a late observation returns ALREADY_OPEN, because in all three
       * the latch was already closed over by someone else. It is what lets the
       * runtime log the trip exactly once per episode instead of once per tick,
       * which is the difference between an alert and a stream.
       *
       * Every field comes from the breaker service's own return. The driver does
       * not decide the family or the threshold, so nothing here can drift away
       * from the rule that actually fired. Carries no generation, no account
       * identifier, no raw error and no exchange payload.
       */
      circuitOpened: HistoricalFillCircuitTransition | null;
    } & UserTradesWeightAccounting &
      HistoricalFillCampaignAccounting)
  | ({
      outcome:
        | "NO_WORK"
        | "MAX_WINDOWS_REACHED"
        | "USER_TRADES_WEIGHT_BUDGET_EXHAUSTED"
        | "GLOBAL_USER_TRADES_WEIGHT_BUDGET_EXHAUSTED"
        | "GLOBAL_USER_TRADES_WEIGHT_CAP_MISMATCH";
      bootstrap: FillRootBootstrapSummary;
      executionInvocations: number;
      outcomes: FillBatchOutcomeCounts;
    } & UserTradesWeightAccounting &
      HistoricalFillCampaignAccounting);

/** The bound is not configuration here; a caller must state it. */
export class FillBatchRefusedError extends Error {
  readonly reasonCode = "FILL_BATCH_REFUSED";
  constructor(readonly detail: string) {
    super(`Refused to run a historical fill batch: ${detail}`);
    this.name = "FillBatchRefusedError";
  }
}

/** A counting or contract bug in this file, surfaced rather than returned. */
export class FillBatchInvariantError extends Error {
  readonly reasonCode = "FILL_BATCH_INVARIANT";
  constructor(detail: string) {
    super(`Historical fill batch invariant violated: ${detail}`);
    this.name = "FillBatchInvariantError";
  }
}

export interface HistoricalFillBatchDependencies {
  bootstrap: ExchangeFillRootBootstrap;
  executor: ExchangeFillOneWindowExecutor;
  /**
   * The shared ceiling, when one is configured.
   *
   * Optional so the driver keeps working exactly as before for every caller
   * that has none -- but when it IS present, no executor invocation happens
   * without a grant. Reserving HERE rather than inside the executor is what
   * keeps a denial free of consequence: `executeOne` claims the window, so a
   * denial that arrived any later would have burned an ingest attempt for a
   * reason that has nothing to do with the window.
   */
  weightBudget?: {
    admitCampaignDispatch: (options: {
      executionProfileId: string;
      weightCap: number;
    }) => Promise<HistoricalFillCampaignAdmissionResult>;
    releaseCertainNonDispatch: (reservation: HistoricalFillWeightReservation) => Promise<void>;
  };
  /**
   * The campaign gate, required whenever a weight budget is wired.
   *
   * It answers "may this account spend anything at all" BEFORE the bootstrap,
   * which is the only place that question can be asked without already having
   * written something. Wiring a budget without it is refused outright rather
   * than silently degraded, because a driver that admitted dispatches with no
   * campaign to count them is precisely the bypass this slice closes.
   */
  campaigns?: {
    resolveForBatch: () => Promise<HistoricalFillCampaignGateResult>;
    describeCampaign: (campaignId: string) => Promise<HistoricalFillBatchCampaign | null>;
    completeIfDrained: (
      executionProfileId: string,
      campaignId: string
    ) => Promise<HistoricalFillCampaignStatus>;
  };
  /**
   * The systemic latch, required whenever a campaign-governed budget is wired.
   *
   * Until this existed the breaker could refuse work but nothing could ever
   * OPEN it: the gate and the admission both read a latch that only a human
   * could set. This is the seam that lets repeated systemic failures stop the
   * account by themselves, and it is required rather than optional for exactly
   * that reason -- a scheduled loop that admits, dispatches and admits again
   * with no observer in between is the unbounded burn the whole breaker exists
   * to prevent, and it must not be constructible.
   *
   * The driver hands over the executor's outcome and reason UNTOUCHED. It forms
   * no opinion about families, thresholds or what counts as systemic; the
   * breaker service is the only classifier, and duplicating its rules here is
   * how the two would eventually disagree.
   */
  circuitBreaker?: {
    observeDispatchOutcome: (options: {
      executionProfileId: string;
      campaignId: string;
      outcome: string;
      reasonCode?: string | null;
    }) => Promise<HistoricalFillCircuitObservation>;
  };
}

const emptyCounts = (): FillBatchOutcomeCounts => ({
  COMPLETE: 0,
  INCOMPLETE_SKIPPED_ROWS: 0,
  SPLIT: 0,
  SATURATED_SINGLE_MILLISECOND: 0,
  RETRY_SCHEDULED: 0,
  ABANDONED: 0,
  STALE_CLAIM: 0,
});

const sum = (counts: FillBatchOutcomeCounts): number =>
  Object.values(counts).reduce((total, value) => total + value, 0);

/** The weight half of every result, derived in one place so it cannot disagree. */
const weighed = (budget: number, used: number): UserTradesWeightAccounting => ({
  userTradesRequestWeightPerDispatch: USER_TRADES_REQUEST_WEIGHT,
  userTradesWeightBudget: budget,
  userTradesWeightUsed: used,
  userTradesWeightRemaining: budget - used,
});

export class HistoricalFillBatchDriver {
  constructor(private readonly deps: HistoricalFillBatchDependencies) {}

  /**
   * Runs ONE bounded pass and returns. It never schedules another.
   *
   * `maxWindows` bounds EXECUTOR INVOCATIONS, not successful transitions. A
   * window that was claimed and then abandoned, split, retried or found stale
   * still cost a claim and possibly an exchange request, so it spends a slot --
   * bounding only the successes would bound nothing an exchange can feel.
   */
  async runHistoricalFillBatch(options: {
    workerId: string;
    now: Date;
    horizonDays: number;
    maxWindows: number;
    maxUserTradesWeight: number;
    /**
     * The SHARED per-minute ceiling. Required exactly when a `weightBudget`
     * dependency is present, and meaningless without one.
     */
    globalUserTradesWeightPerMinute?: number;
  }): Promise<HistoricalFillBatchResult> {
    // Refused BEFORE the bootstrap: an unusable bound is not a reason to create
    // roots, and it is certainly not a reason to spend an exchange request.
    assertMaxWindows(options.maxWindows);
    assertUserTradesWeightBudget(options.maxUserTradesWeight);
    assertGlobalUserTradesWeightCap(
      this.deps.weightBudget !== undefined,
      options.globalUserTradesWeightPerMinute
    );
    assertCampaignGate(this.deps.weightBudget !== undefined, this.deps.campaigns !== undefined);
    assertCircuitObserver(
      this.deps.weightBudget !== undefined,
      this.deps.circuitBreaker !== undefined
    );

    const outcomes = emptyCounts();
    const budget = options.maxUserTradesWeight;
    let used = 0;

    // THE CAMPAIGN GATE, BEFORE THE BOOTSTRAP.
    //
    // Everything past this point writes something: the bootstrap creates roots,
    // `executeOne` claims a window and burns an ingest attempt. An account that
    // nothing authorises must leave no trace at all, so the question is asked
    // here, where the only thing that has happened is two reads.
    let campaign: HistoricalFillBatchCampaign | null = null;
    let campaignProfileId: string | null = null;
    if (this.deps.campaigns !== undefined) {
      const gate = await this.deps.campaigns.resolveForBatch();

      if (gate.outcome === "PROFILE_UNAVAILABLE") {
        return {
          outcome: "PROFILE_UNAVAILABLE",
          stage: "CAMPAIGN",
          reasonCode: gate.reasonCode,
          bootstrap: null,
          executionInvocations: 0,
          outcomes,
          ...weighed(budget, used),
          ...NO_CAMPAIGN_ACCOUNTING,
        };
      }

      if (gate.outcome === "CIRCUIT_OPEN") {
        // The whole value of the pre-bootstrap check, cashed in here: this
        // returns before `bootstrapHistoricalRoots` is called even once, so a
        // stopped account writes NO roots, claims NO window, burns NO ingest
        // attempt, reserves NO weight and issues NO request.
        //
        // The breaker snapshot is the GATE'S, carried through unaltered. It is
        // the only one this path ever read, and mixing it with anything else
        // would report a latch state that no single moment ever held.
        return this.settled(
          {
            outcome: "SYSTEMIC_CIRCUIT_OPEN",
            bootstrap: null,
            executionInvocations: 0,
            outcomes,
            ...weighed(budget, used),
            ...campaignAccounting(gate.campaign),
            circuit: gate.circuit,
            // The gate found the latch ALREADY closed over, so this pass caused
            // no transition and must not log one.
            circuitOpened: null,
          },
          0
        );
      }

      if (gate.outcome === "NO_ACTIVE_CAMPAIGN") {
        // Zero roots, zero claims, zero reservations, zero requests. The
        // campaign metadata still says WHICH of the five situations this is.
        return this.settled(
          {
            outcome: "NO_ACTIVE_FILL_CAMPAIGN",
            bootstrap: null,
            executionInvocations: 0,
            outcomes,
            ...weighed(budget, used),
            ...campaignAccounting(gate.campaign),
          },
          0
        );
      }

      campaign = gate.campaign;
      campaignProfileId = gate.executionProfileId;
    }

    // Exactly once per pass. Roots are canonical and idempotent, so repeating
    // this per window would add a full horizon scan per iteration and answer
    // the same question every time.
    const bootstrap = await this.deps.bootstrap.bootstrapHistoricalRoots({
      now: options.now,
      horizonDays: options.horizonDays,
    });

    if (bootstrap.outcome === "PROFILE_UNAVAILABLE") {
      // Not one executor call. A process that cannot name its account has no
      // business claiming that account's windows.
      return {
        outcome: "PROFILE_UNAVAILABLE",
        stage: "BOOTSTRAP",
        reasonCode: bootstrap.reasonCode,
        bootstrap: null,
        executionInvocations: 0,
        outcomes,
        ...weighed(budget, used),
        ...campaignAccounting(campaign),
      };
    }

    // THE ACCOUNT MUST BE THE SAME ACCOUNT.
    //
    // The gate and the bootstrap bind independently -- deliberately, because
    // neither may trust a profile handed down by the other. That independence
    // is only safe if they agree, and if configuration changed between the two
    // binds they might not. A campaign belonging to one account must never
    // authorise dispatches charged to another, so a disagreement stops the pass
    // here: after the bootstrap's idempotent root writes, but BEFORE any
    // admission, any claim and any request.
    if (campaignProfileId !== null && campaignProfileId !== bootstrap.executionProfileId) {
      throw new FillBatchInvariantError(
        `the campaign gate bound execution profile ${campaignProfileId} but the bootstrap bound ` +
          `${bootstrap.executionProfileId}; refusing to spend one account's campaign on another`
      );
    }

    let executionInvocations = 0;

    for (let attempt = 0; attempt < options.maxWindows; attempt += 1) {
      // The invocation bound is checked FIRST, by the loop itself. Reaching it
      // is MAX_WINDOWS_REACHED even when the last invocation also happened to
      // spend the last of the weight: the caller's requested number of
      // invocations is what ran out.
      //
      // Then the budget, BEFORE the call rather than after it. `executeOne`
      // may claim a window and dispatch immediately, so starting one without
      // enough weight reserved for a dispatch is how a ceiling gets exceeded.
      // There is no "try and see".
      if (budget - used < USER_TRADES_REQUEST_WEIGHT) {
        return this.settled(
          {
            outcome: "USER_TRADES_WEIGHT_BUDGET_EXHAUSTED",
            bootstrap,
            executionInvocations,
            outcomes,
            ...weighed(budget, used),
            ...campaignAccounting(campaign),
          },
          0
        );
      }

      // The SHARED ceiling, when one is configured. Ordered after the local
      // check deliberately: a pass that cannot afford a dispatch locally has no
      // business touching a row other processes are contending for, and
      // ordering it this way keeps `USER_TRADES_WEIGHT_BUDGET_EXHAUSTED`
      // meaning exactly what it meant before this existed.
      //
      // A denial here costs nothing: `executeOne` is what claims a window, and
      // it has not been called yet, so no ingest attempt is burned and no
      // window is touched.
      let reservation: HistoricalFillWeightReservation | null = null;
      if (this.deps.weightBudget !== undefined) {
        // ONE admission, taking the campaign slot and the minute's weight
        // together or neither. There is no path here that spends one without
        // the other, and no path that reaches the exchange without both.
        const admission = await this.deps.weightBudget.admitCampaignDispatch({
          executionProfileId: bootstrap.executionProfileId,
          // Non-null by `assertGlobalUserTradesWeightCap` above, which refused
          // the pass before the bootstrap if a budget was wired without a cap.
          weightCap: options.globalUserTradesWeightPerMinute as number,
        });

        if (admission.outcome === "SYSTEMIC_CIRCUIT_OPEN") {
          // THE STALE-GATE RACE, refused by the authority.
          //
          // The gate said ACTIVE a moment ago and another worker has opened the
          // circuit since. That read was unlocked, so it was allowed to be
          // wrong; this one was taken under the profile lock in the transaction
          // that would have spent the slot, and it is the one that counts. The
          // pass therefore stops HERE, before `executeOne`, with nothing spent:
          // the admission unwound whatever it had touched, so no slot, no
          // weight and no reservation row exist for it.
          //
          // The bootstrap already ran -- the gate waved this pass through
          // before the circuit opened -- and that is reported honestly rather
          // than nulled. Roots are idempotent and no request followed them.
          //
          // The campaign is RE-READ rather than carried from the gate. Opening
          // the circuit pauses the ACTIVE campaign in the same transaction, so
          // the gate's snapshot now describes a state that no longer exists;
          // reporting it would put a status in an operator's summary that was
          // untrue by the time it was written. Null when it cannot be read is
          // the one honest answer available.
          const stopped =
            campaign !== null && this.deps.campaigns !== undefined
              ? await this.deps.campaigns.describeCampaign(campaign.id)
              : campaign;
          return this.settled(
            {
              outcome: "SYSTEMIC_CIRCUIT_OPEN",
              bootstrap,
              executionInvocations,
              outcomes,
              ...weighed(budget, used),
              ...campaignAccounting(stopped),
              // The ADMISSION'S snapshot, read under the lock. Deliberately not
              // the gate's, which is known stale on exactly this path.
              circuit: admission.circuit,
              // Another worker opened it; this pass only discovered that.
              circuitOpened: null,
            },
            0
          );
        }
        if (admission.outcome === "NO_ACTIVE_FILL_CAMPAIGN") {
          // The campaign ended UNDER us -- an operator paused or aborted it, or
          // another worker took its last slot -- between the pre-bootstrap gate
          // and this locked admission.
          //
          // The gate's snapshot is therefore STALE by definition here, and the
          // admission result carries only an id and a status. Reporting the
          // stale counts, or inventing zeros to fill the gap, would put numbers
          // in an operator's summary that were never true of any moment. So the
          // campaign is re-read, and if it cannot be read the counts are null --
          // "not known" -- which is the one honest answer available.
          const settledCampaign =
            admission.campaignId === null
              ? null
              : ((await this.deps.campaigns?.describeCampaign(admission.campaignId)) ?? null);
          return this.settled(
            {
              outcome: "NO_ACTIVE_FILL_CAMPAIGN",
              bootstrap: null,
              executionInvocations,
              outcomes,
              ...weighed(budget, used),
              ...campaignAccounting(settledCampaign),
            },
            0
          );
        }
        if (admission.outcome === "CAMPAIGN_DISPATCH_BUDGET_EXHAUSTED") {
          return this.settled(
            {
              outcome: "CAMPAIGN_DISPATCH_BUDGET_EXHAUSTED",
              bootstrap: null,
              executionInvocations,
              outcomes,
              ...weighed(budget, used),
              // These counts ARE authoritative: the budget service read them
              // from the row under its own lock and returned them unchanged.
              ...campaignAccounting({
                id: admission.campaignId,
                status: "ACTIVE",
                dispatchesUsed: admission.dispatchesUsed,
                maxDispatches: admission.maxDispatches,
                dispatchesRemaining: Math.max(
                  0,
                  admission.maxDispatches - admission.dispatchesUsed
                ),
              }),
            },
            0
          );
        }
        if (admission.outcome === "GLOBAL_USER_TRADES_WEIGHT_EXHAUSTED") {
          // 2B.2 unwound the campaign increment, so nothing was spent. The
          // campaign accounting below is the one the gate read, unchanged.
          return this.settled(
            {
              outcome: "GLOBAL_USER_TRADES_WEIGHT_BUDGET_EXHAUSTED",
              bootstrap,
              executionInvocations,
              outcomes,
              ...weighed(budget, used),
              ...campaignAccounting(campaign),
            },
            0
          );
        }
        if (admission.outcome === "CAP_MISMATCH") {
          return this.settled(
            {
              outcome: "GLOBAL_USER_TRADES_WEIGHT_CAP_MISMATCH",
              bootstrap,
              executionInvocations,
              outcomes,
              ...weighed(budget, used),
              ...campaignAccounting(campaign),
            },
            0
          );
        }

        reservation = admission.reservation;
        // What the campaign looks like AFTER this admission, including the
        // EXHAUSTED it may have just entered by taking its final slot.
        campaign = {
          id: admission.campaignId,
          status: admission.campaignStatus,
          dispatchesUsed: admission.dispatchesUsed,
          maxDispatches: admission.maxDispatches,
          dispatchesRemaining: Math.max(0, admission.maxDispatches - admission.dispatchesUsed),
        };
      }

      // Reserved conservatively: assume the dispatch happens, and give the
      // weight back only once the outcome PROVES it did not.
      used += USER_TRADES_REQUEST_WEIGHT;

      // No `now`. The executor resolves a fresh instant per invocation, which
      // is the only value a lease or a backoff may honestly be stamped with.
      const result = await this.deps.executor.executeOne({ workerId: options.workerId });
      executionInvocations += 1;

      if (!USER_TRADES_DISPATCH_ATTEMPTED[result.outcome]) {
        // Proven zero-dispatch. A failed REQUEST is never refunded here -- it
        // reached the exchange and spent its weight there.
        used -= USER_TRADES_REQUEST_WEIGHT;
        // The shared ceiling is given back under the SAME predicate, so the
        // two budgets can never disagree about whether a request happened. An
        // executor THROW deliberately does not reach here: an invocation that
        // ended in an exception may or may not have dispatched, and uncertain
        // dispatch is always counted as spent.
        if (reservation !== null) {
          // REFUND FIRST, ALWAYS BEFORE COMPLETION. Marking a campaign COMPLETED
          // while one of its reservations is still outstanding would make the
          // refund that follows hit 2B.2's deliberately fail-closed COMPLETED
          // branch, which throws and rolls the release back -- stranding the
          // weight and the slot for good. The ordering is the whole reason that
          // situation is unreachable in ordinary operation.
          await this.deps.weightBudget?.releaseCertainNonDispatch(reservation);
          // A refund gives a slot back and may reopen a campaign that this very
          // pass exhausted, so the snapshot is now stale.
          if (campaign !== null && this.deps.campaigns !== undefined) {
            campaign = (await this.deps.campaigns.describeCampaign(campaign.id)) ?? campaign;
          }
        }
      }

      // THE ACTIVATION HOOK.
      //
      // Placed HERE, and the position is the whole design:
      //
      //   admission -> executeOne -> DURABLE RESULT -> refund -> OBSERVE -> ...
      //
      // After the executor, because only a returned result is a durable fact
      // about a window; the executor owns that truth and this must never run
      // inside its transaction. After the refund, because a proven zero-dispatch
      // must have given its slot and weight back before anything else looks at
      // the campaign. And before every remaining branch, so no path can reach a
      // second admission without having asked.
      //
      // The outcome and reason go across UNTOUCHED. This driver has no table of
      // families, no threshold and no notion of which codes are systemic -- it
      // asks, and the breaker service answers.
      const observation = await this.observeOutcome(campaign, campaignProfileId, result);

      // Nothing was eligible, so asking again can only produce the same answer.
      if (result.outcome === "NO_WORK") {
        // The queue is empty from this worker's point of view, which is the one
        // moment worth asking whether the CAMPAIGN is finished. Only an ACTIVE
        // campaign with zero PENDING rows may complete; the gate owns that rule,
        // and returns what is actually true afterwards.
        if (campaign !== null && campaignProfileId !== null && this.deps.campaigns !== undefined) {
          const status = await this.deps.campaigns.completeIfDrained(campaignProfileId, campaign.id);
          campaign = { ...campaign, status };
        }
        // NO_WORK is NEUTRAL to the breaker -- it was decided before the
        // transport was touched -- so it can never open the latch. It can still
        // discover one another worker opened, and that outranks an empty queue
        // as the reason this account stopped.
        if (stopsForCircuit(observation)) {
          return this.circuitStop(observation, bootstrap, executionInvocations, outcomes, budget, used, campaign, 1);
        }
        return this.settled(
          {
            outcome: "NO_WORK",
            bootstrap,
            executionInvocations,
            outcomes,
            ...weighed(budget, used),
            ...campaignAccounting(campaign),
          },
          1
        );
      }

      // The executor binds the profile independently of the bootstrap, so this
      // can appear mid-pass if configuration changed underneath us.
      if (result.outcome === "PROFILE_UNAVAILABLE") {
        if (result.reasonCode === undefined) {
          throw new FillBatchInvariantError(
            "the executor reported PROFILE_UNAVAILABLE without a reason code"
          );
        }
        if (stopsForCircuit(observation)) {
          return this.circuitStop(observation, bootstrap, executionInvocations, outcomes, budget, used, campaign, 1);
        }
        return this.settled(
          {
            outcome: "PROFILE_UNAVAILABLE",
            stage: "EXECUTION",
            reasonCode: result.reasonCode,
            bootstrap,
            executionInvocations,
            outcomes,
            ...weighed(budget, used),
            ...campaignAccounting(campaign),
          },
          1
        );
      }

      // Everything else -- COMPLETE, SPLIT, RETRY_SCHEDULED, ABANDONED, both
      // known-gap terminals and STALE_CLAIM -- is a durable fact about ONE
      // window that the executor has already finished writing. None of them
      // ends the pass, and none of them is retried here: the next iteration
      // asks the durable queue for whatever is eligible now, which is how a
      // split's children and a backed-off window get their correct turn.
      outcomes[result.outcome] += 1;

      // STOP, AFTER COUNTING. The triggering result is already durable and its
      // request already reached the exchange, so dropping it from the summary
      // would understate exactly the spending this driver exists to bound -- the
      // count above happens first for that reason.
      //
      // CIRCUIT_OPENED means this pass tripped it; ALREADY_OPEN means another
      // worker did while this request was in flight. Operationally they are the
      // same instruction: no further admission, on this tick or any other, until
      // somebody acknowledges.
      if (stopsForCircuit(observation)) {
        return this.circuitStop(observation, bootstrap, executionInvocations, outcomes, budget, used, campaign, 0);
      }
    }

    return this.settled(
      {
        outcome: "MAX_WINDOWS_REACHED",
        bootstrap,
        executionInvocations,
        outcomes,
        ...weighed(budget, used),
        ...campaignAccounting(campaign),
      },
      0
    );
  }

  /**
   * Reports ONE durable executor result to the breaker, or nothing at all.
   *
   * Returns null when there is no campaign to attribute the outcome to -- the
   * legacy composition with no budget and no gate -- because the breaker's
   * lineage check exists precisely so that a trip can never be opened for a
   * profile on the strength of a request no campaign owned.
   *
   * ## Not caught, deliberately
   *
   * If this throws, the batch throws. A failure here means the process does not
   * KNOW whether systemic protection was recorded, and the only safe reading of
   * "I don't know" is to stop: swallowing it would let the loop admit again
   * against a fault that may have just tripped the latch, which is the burn this
   * whole subsystem exists to bound. An error is not NO_CHANGE.
   */
  private async observeOutcome(
    campaign: HistoricalFillBatchCampaign | null,
    executionProfileId: string | null,
    result: FillIngestExecutionResult
  ): Promise<HistoricalFillCircuitObservation | null> {
    if (this.deps.circuitBreaker === undefined) return null;
    if (campaign === null || executionProfileId === null) return null;
    return this.deps.circuitBreaker.observeDispatchOutcome({
      // The profile the GATE bound and the bootstrap independently agreed with,
      // checked against each other before any admission happened. The breaker
      // re-proves the campaign's lineage itself rather than trusting either.
      executionProfileId,
      campaignId: campaign.id,
      // Passed through verbatim. No mapping, no normalisation, no opinion.
      outcome: result.outcome,
      reasonCode: result.reasonCode ?? null,
    });
  }

  /**
   * Ends the pass because the account's circuit is open.
   *
   * Re-reads the campaign rather than reporting the snapshot this pass was
   * holding. Opening the latch moves the CURRENT ACTIVE campaign to PAUSED in
   * the same transaction, so a pre-observation snapshot says ACTIVE about a row
   * that is no longer ACTIVE -- and a campaign whose final slot this very
   * invocation spent is EXHAUSTED and must stay EXHAUSTED, not be reported as
   * paused. Null when it cannot be read, which is "not known" rather than an
   * invented zero.
   */
  private async circuitStop(
    observation: HistoricalFillCircuitObservation,
    bootstrap: FillRootBootstrapSummary,
    executionInvocations: number,
    outcomes: FillBatchOutcomeCounts,
    budget: number,
    used: number,
    campaign: HistoricalFillBatchCampaign | null,
    terminalInvocations: 0 | 1
  ): Promise<HistoricalFillBatchResult> {
    const settledCampaign =
      campaign !== null && this.deps.campaigns !== undefined
        ? await this.deps.campaigns.describeCampaign(campaign.id)
        : campaign;

    return this.settled(
      {
        outcome: "SYSTEMIC_CIRCUIT_OPEN",
        bootstrap,
        executionInvocations,
        outcomes,
        ...weighed(budget, used),
        ...campaignAccounting(settledCampaign),
        // The breaker's own post-transaction snapshot, which is OPEN on both
        // paths that reach here.
        circuit: circuitDenialOf(observation.circuit),
        // ONLY a real transition earns the dedicated event downstream.
        circuitOpened:
          observation.result === "CIRCUIT_OPENED" && campaign !== null
            ? {
                campaignId: campaign.id,
                failureFamily: observation.circuit.failureFamily,
                lastReasonCode: observation.circuit.lastReasonCode,
                consecutiveCount: observation.circuit.consecutiveCount,
                threshold: observation.threshold,
                openedAt: observation.circuit.openedAt,
              }
            : null,
      },
      terminalInvocations
    );
  }

  /**
   * Returns a result only if its own arithmetic holds.
   *
   * `executionInvocations` must equal every counted outcome plus the single
   * terminal invocation that produced NO_WORK or PROFILE_UNAVAILABLE, which is
   * counted nowhere else. A summary that quietly loses an executor call would
   * understate exactly the thing this driver exists to bound.
   */
  private settled<T extends HistoricalFillBatchResult>(result: T, terminalInvocations: 0 | 1): T {
    const accounted = sum(result.outcomes) + terminalInvocations;
    if (accounted !== result.executionInvocations) {
      throw new FillBatchInvariantError(
        `${result.executionInvocations} executor invocation(s) but ${accounted} accounted for`
      );
    }

    const { userTradesWeightBudget: budget, userTradesWeightUsed: weightUsed } = result;
    if (weightUsed < 0 || weightUsed > budget) {
      throw new FillBatchInvariantError(`userTrades weight ${weightUsed} is outside 0..${budget}`);
    }
    if (weightUsed % USER_TRADES_REQUEST_WEIGHT !== 0) {
      throw new FillBatchInvariantError(
        `userTrades weight ${weightUsed} is not a multiple of ${USER_TRADES_REQUEST_WEIGHT}`
      );
    }
    if (result.userTradesWeightRemaining !== budget - weightUsed) {
      throw new FillBatchInvariantError(
        `userTrades weight ${weightUsed} of ${budget} leaves ${budget - weightUsed}, not ` +
          `${result.userTradesWeightRemaining}`
      );
    }
    return result;
  }
}

/**
 * The bound, checked as strictly as a durable one.
 *
 * Deliberately NOT read from configuration in this slice: a driver that
 * defaulted its own ceiling would let a caller who forgot to state one still
 * issue exchange requests, and how big a pass may be is a decision that has not
 * been made yet.
 */
/**
 * The userTrades ceiling, checked like the window bound.
 *
 * A pass that cannot afford a single dispatch is a misconfiguration rather than
 * an outcome, so it is refused here instead of returning "exhausted" having
 * done nothing. Configuration validates this range too; neither check is
 * load-bearing alone.
 */
function assertUserTradesWeightBudget(maxUserTradesWeight: number): void {
  if (!Number.isSafeInteger(maxUserTradesWeight)) {
    throw new FillBatchRefusedError(
      `maxUserTradesWeight must be a safe integer, received ${String(maxUserTradesWeight)}`
    );
  }
  if (maxUserTradesWeight < USER_TRADES_REQUEST_WEIGHT) {
    throw new FillBatchRefusedError(
      `maxUserTradesWeight must be at least one dispatch (${USER_TRADES_REQUEST_WEIGHT}), ` +
        `received ${maxUserTradesWeight}`
    );
  }
}

/**
 * The shared ceiling, refused as strictly as the local one.
 *
 * A wired budget with no cap is a misconfiguration, not an outcome: it would
 * mean a process contending for a shared row without knowing what it is
 * allowed. Refused before the bootstrap, like every other unusable bound.
 */
function assertGlobalUserTradesWeightCap(
  budgetWired: boolean,
  cap: number | undefined
): void {
  if (!budgetWired) {
    if (cap !== undefined) {
      throw new FillBatchRefusedError(
        "globalUserTradesWeightPerMinute was given without a shared weight budget to enforce it"
      );
    }
    return;
  }
  if (cap === undefined) {
    throw new FillBatchRefusedError(
      "a shared weight budget was wired without globalUserTradesWeightPerMinute"
    );
  }
  if (!Number.isSafeInteger(cap)) {
    throw new FillBatchRefusedError(
      `globalUserTradesWeightPerMinute must be a safe integer, received ${String(cap)}`
    );
  }
  if (cap < USER_TRADES_REQUEST_WEIGHT) {
    throw new FillBatchRefusedError(
      `globalUserTradesWeightPerMinute must be at least one dispatch ` +
        `(${USER_TRADES_REQUEST_WEIGHT}), received ${cap}`
    );
  }
}

/**
 * A wired weight budget without a campaign gate is refused outright.
 *
 * Not degraded, not defaulted. A budget with no gate would admit dispatches
 * that no campaign counts -- the exact bypass this slice exists to close -- and
 * the cheapest place to make that impossible is before the pass does anything.
 */
/**
 * A campaign-governed loop may not run without something watching its outcomes.
 *
 * Refused at the top of the pass, before the gate and before the bootstrap, so
 * a misassembled scheduled path fails loudly on its first tick instead of
 * quietly dispatching forever with no systemic protection. Symmetric to the
 * gate check above and for the same reason: the dangerous composition is the
 * one that LOOKS complete.
 *
 * The converse is refused too. An observer with no budget would watch a loop
 * that admits nothing through a campaign, which means it could pause campaigns
 * on the strength of dispatches no campaign ever authorised.
 */
/**
 * Whether an observation means this pass must not admit anything further.
 *
 * Two results, one instruction. CIRCUIT_OPENED is this pass tripping the latch;
 * ALREADY_OPEN is discovering that someone else did while this request was in
 * flight. Neither may be followed by another admission.
 *
 * A null observation means nothing was watching -- the legacy uncampaigned
 * composition -- and never stops the loop.
 */
function stopsForCircuit(
  observation: HistoricalFillCircuitObservation | null
): observation is HistoricalFillCircuitObservation {
  if (observation === null) return false;
  return observation.result === "CIRCUIT_OPENED" || observation.result === "ALREADY_OPEN";
}

function assertCircuitObserver(budgetWired: boolean, breakerWired: boolean): void {
  if (budgetWired && !breakerWired) {
    throw new FillBatchRefusedError(
      "a shared weight budget was wired without a circuit breaker to observe its dispatches"
    );
  }
  if (!budgetWired && breakerWired) {
    throw new FillBatchRefusedError(
      "a circuit breaker was wired without a shared weight budget whose dispatches it would observe"
    );
  }
}

function assertCampaignGate(budgetWired: boolean, gateWired: boolean): void {
  if (budgetWired && !gateWired) {
    throw new FillBatchRefusedError(
      "a shared weight budget was wired without a campaign gate to authorise its dispatches"
    );
  }
  if (!budgetWired && gateWired) {
    throw new FillBatchRefusedError(
      "a campaign gate was wired without a shared weight budget to admit through"
    );
  }
}

function assertMaxWindows(maxWindows: number): void {
  if (!Number.isSafeInteger(maxWindows)) {
    throw new FillBatchRefusedError(
      `maxWindows must be a safe integer, received ${String(maxWindows)}`
    );
  }
  if (maxWindows < 1) {
    throw new FillBatchRefusedError(`maxWindows must be at least 1, received ${maxWindows}`);
  }
}
