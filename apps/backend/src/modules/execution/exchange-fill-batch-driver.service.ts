import { BINANCE_READ_ONLY_ENDPOINTS } from "../binance/binance.endpoints";
import type {
  ExchangeFillOneWindowExecutor,
  FillIngestExecutionOutcome,
} from "./exchange-fill-one-window-executor.service";
import type { ExchangeFillRootBootstrap, FillRootBootstrapResult } from "./exchange-fill-root-bootstrap.service";
import type {
  HistoricalFillWeightReservation,
  HistoricalFillWeightReservationResult,
} from "./historical-fill-weight-budget.service";

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

/**
 * Whether an outcome proves a userTrades request was ATTEMPTED.
 *
 * Traced from the executor, not assumed. `PROFILE_UNAVAILABLE` returns at the
 * binding check and `NO_WORK` returns when no claim exists -- both strictly
 * before the single `listRecentTradesOnce` call. Every other outcome is only
 * reachable after that call has been made, including the failures: a request
 * that came back 429 or 5xx still spent its weight at the exchange.
 *
 * Exhaustive by type. A new executor outcome fails this object to compile,
 * which is the point -- a future union member must be classified deliberately
 * rather than silently defaulting to "free".
 */
const USER_TRADES_DISPATCH_ATTEMPTED: Record<FillIngestExecutionOutcome, boolean> = {
  PROFILE_UNAVAILABLE: false,
  NO_WORK: false,
  COMPLETE: true,
  INCOMPLETE_SKIPPED_ROWS: true,
  SPLIT: true,
  SATURATED_SINGLE_MILLISECOND: true,
  RETRY_SCHEDULED: true,
  ABANDONED: true,
  STALE_CLAIM: true,
};

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
  | "GLOBAL_USER_TRADES_WEIGHT_CAP_MISMATCH";

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

/** The bootstrap's own success summary, unaltered. */
export type FillRootBootstrapSummary = Extract<FillRootBootstrapResult, { outcome: "BOOTSTRAPPED" }>;

export type HistoricalFillBatchResult =
  | ({
      outcome: "PROFILE_UNAVAILABLE";
      /** Which half of the pass could not name the account. */
      stage: "BOOTSTRAP" | "EXECUTION";
      /** The binder's own code, carried through both layers unflattened. */
      reasonCode: string;
      /** Null when the bootstrap itself could not bind. */
      bootstrap: FillRootBootstrapSummary | null;
      executionInvocations: number;
      outcomes: FillBatchOutcomeCounts;
    } & UserTradesWeightAccounting)
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
    } & UserTradesWeightAccounting);

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
    reserve: (options: {
      executionProfileId: string;
      weightCap: number;
    }) => Promise<HistoricalFillWeightReservationResult>;
    releaseCertainNonDispatch: (reservation: HistoricalFillWeightReservation) => Promise<void>;
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

    const outcomes = emptyCounts();
    const budget = options.maxUserTradesWeight;
    let used = 0;

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
      };
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
        const shared = await this.deps.weightBudget.reserve({
          executionProfileId: bootstrap.executionProfileId,
          // Non-null by `assertGlobalUserTradesWeightCap` above, which refused
          // the pass before the bootstrap if a budget was wired without a cap.
          weightCap: options.globalUserTradesWeightPerMinute as number,
        });

        if (shared.outcome === "EXHAUSTED") {
          return this.settled(
            {
              outcome: "GLOBAL_USER_TRADES_WEIGHT_BUDGET_EXHAUSTED",
              bootstrap,
              executionInvocations,
              outcomes,
              ...weighed(budget, used),
            },
            0
          );
        }
        if (shared.outcome === "CAP_MISMATCH") {
          return this.settled(
            {
              outcome: "GLOBAL_USER_TRADES_WEIGHT_CAP_MISMATCH",
              bootstrap,
              executionInvocations,
              outcomes,
              ...weighed(budget, used),
            },
            0
          );
        }
        reservation = shared.reservation;
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
          await this.deps.weightBudget?.releaseCertainNonDispatch(reservation);
        }
      }

      // Nothing was eligible, so asking again can only produce the same answer.
      if (result.outcome === "NO_WORK") {
        return this.settled(
          { outcome: "NO_WORK", bootstrap, executionInvocations, outcomes, ...weighed(budget, used) },
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
        return this.settled(
          {
            outcome: "PROFILE_UNAVAILABLE",
            stage: "EXECUTION",
            reasonCode: result.reasonCode,
            bootstrap,
            executionInvocations,
            outcomes,
            ...weighed(budget, used),
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
    }

    return this.settled(
      {
        outcome: "MAX_WINDOWS_REACHED",
        bootstrap,
        executionInvocations,
        outcomes,
        ...weighed(budget, used),
      },
      0
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
