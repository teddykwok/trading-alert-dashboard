import type { ExchangeFillOneWindowExecutor } from "./exchange-fill-one-window-executor.service";
import type { ExchangeFillRootBootstrap, FillRootBootstrapResult } from "./exchange-fill-root-bootstrap.service";

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

/** Why the pass stopped. Exactly one of these ends every invocation. */
export type FillBatchStopReason = "NO_WORK" | "PROFILE_UNAVAILABLE" | "MAX_WINDOWS_REACHED";

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
  | {
      outcome: "PROFILE_UNAVAILABLE";
      /** Which half of the pass could not name the account. */
      stage: "BOOTSTRAP" | "EXECUTION";
      /** The binder's own code, carried through both layers unflattened. */
      reasonCode: string;
      /** Null when the bootstrap itself could not bind. */
      bootstrap: FillRootBootstrapSummary | null;
      executionInvocations: number;
      outcomes: FillBatchOutcomeCounts;
    }
  | {
      outcome: "NO_WORK" | "MAX_WINDOWS_REACHED";
      bootstrap: FillRootBootstrapSummary;
      executionInvocations: number;
      outcomes: FillBatchOutcomeCounts;
    };

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
  }): Promise<HistoricalFillBatchResult> {
    // Refused BEFORE the bootstrap: an unusable bound is not a reason to create
    // roots, and it is certainly not a reason to spend an exchange request.
    assertMaxWindows(options.maxWindows);

    const outcomes = emptyCounts();

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
      };
    }

    let executionInvocations = 0;

    for (let attempt = 0; attempt < options.maxWindows; attempt += 1) {
      // No `now`. The executor resolves a fresh instant per invocation, which
      // is the only value a lease or a backoff may honestly be stamped with.
      const result = await this.deps.executor.executeOne({ workerId: options.workerId });
      executionInvocations += 1;

      // Nothing was eligible, so asking again can only produce the same answer.
      if (result.outcome === "NO_WORK") {
        return this.settled({ outcome: "NO_WORK", bootstrap, executionInvocations, outcomes }, 1);
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
      { outcome: "MAX_WINDOWS_REACHED", bootstrap, executionInvocations, outcomes },
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
