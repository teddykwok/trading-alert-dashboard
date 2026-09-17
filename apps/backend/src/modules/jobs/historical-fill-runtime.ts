import { env } from "../../config/env";
import { logger } from "../../config/logger";
import type {
  FillBatchOutcomeCounts,
  FillBatchStopReason,
  HistoricalFillBatchResult,
} from "../execution/exchange-fill-batch-driver.service";

/**
 * ONE historical-fill batch, gated, and observable when it runs.
 *
 * ## Dormant by construction
 *
 * Nothing in production calls this. There is no timer here, no cron, no startup
 * hook and no module-level work -- the file only declares what a tick WOULD do.
 * Even with `EXECUTION_FILL_RUNTIME_ENABLED=true`, a batch happens only because
 * something explicitly called `runHistoricalFillRuntimeTick`, and in this phase
 * nothing does.
 *
 * ## Why the gate is checked before anything is built
 *
 * The driver arrives as a FACTORY, not an instance. A disabled tick never calls
 * it, so a dormant runtime constructs no bootstrap, no executor, no ledger and
 * no Binance reader -- "disabled did nothing" is then a property of the control
 * flow rather than a promise about what those objects would have done.
 *
 * ## Why this exists at all
 *
 * The rollout audit found the batch result was computed and then discarded: an
 * invoked batch produced no evidence that it had run, failed, or spent exchange
 * weight. One structured summary per enabled tick closes exactly that gap, and
 * nothing more. Row-level diagnosis is deliberately still absent.
 *
 * ## What this does NOT change
 *
 * The userTrades weight budget remains PER BATCH, IN MEMORY and PER PROCESS.
 * It is not an IP or account limiter, and logging it does not make it one: two
 * processes each spend their own full budget. No limiter, no token bucket and
 * no header-driven throttle is introduced here.
 */

/** The stable machine name for a completed batch. */
export const HISTORICAL_FILL_BATCH_COMPLETE_EVENT = "historical_fill_batch_complete";

/** The stable machine name for a batch that threw. */
export const HISTORICAL_FILL_BATCH_FAILED_EVENT = "historical_fill_batch_failed";

/** Matches the orchestration scheduler's own cap on relayed error text. */
const MAX_LOGGED_ERROR_LENGTH = 300;

/** The bootstrap's counts, which are numbers and carry no identity. */
export interface HistoricalFillBootstrapSummary {
  horizonDays: number;
  symbolCount: number;
  dayCount: number;
  expectedRootCount: number;
  alreadyCompatibleCount: number;
  createdCount: number;
  raceReconciledCount: number;
}

/**
 * Exactly what one completed batch is allowed to say.
 *
 * An explicit shape, never a spread of the driver result: the result carries an
 * `executionProfileId` inside its bootstrap summary, and a summary that
 * splatted whatever it was handed would leak the next field somebody adds.
 */
export interface HistoricalFillBatchSummary {
  event: typeof HISTORICAL_FILL_BATCH_COMPLETE_EVENT;
  workerId: string;
  outcome: FillBatchStopReason;
  /** Present only when the pass could not name the account. */
  profileUnavailableStage?: "BOOTSTRAP" | "EXECUTION";
  profileUnavailableReasonCode?: string;
  executionInvocations: number;
  /**
   * Dispatches, derived rather than counted separately: the driver's own
   * invariant proves `used` is an exact multiple of one dispatch's weight, so
   * this division is total and cannot disagree with the weight beside it.
   */
  userTradesRequests: number;
  userTradesWeightUsed: number;
  userTradesWeightBudget: number;
  userTradesWeightRemaining: number;
  outcomes: FillBatchOutcomeCounts;
  /** Null when the bootstrap itself could not bind the profile. */
  bootstrap: HistoricalFillBootstrapSummary | null;
}

/**
 * Turns a driver result into the only fields a log may carry.
 *
 * Pure, so the contract can be asserted without running a batch or a logger.
 */
export function summarizeHistoricalFillBatch(
  workerId: string,
  result: HistoricalFillBatchResult
): HistoricalFillBatchSummary {
  const summary: HistoricalFillBatchSummary = {
    event: HISTORICAL_FILL_BATCH_COMPLETE_EVENT,
    workerId,
    outcome: result.outcome,
    executionInvocations: result.executionInvocations,
    userTradesRequests: result.userTradesWeightUsed / result.userTradesRequestWeightPerDispatch,
    userTradesWeightUsed: result.userTradesWeightUsed,
    userTradesWeightBudget: result.userTradesWeightBudget,
    userTradesWeightRemaining: result.userTradesWeightRemaining,
    outcomes: { ...result.outcomes },
    bootstrap:
      result.bootstrap === null
        ? null
        : {
            horizonDays: result.bootstrap.horizonDays,
            symbolCount: result.bootstrap.symbolCount,
            dayCount: result.bootstrap.dayCount,
            expectedRootCount: result.bootstrap.expectedRootCount,
            alreadyCompatibleCount: result.bootstrap.alreadyCompatibleCount,
            createdCount: result.bootstrap.createdCount,
            raceReconciledCount: result.bootstrap.raceReconciledCount,
          },
  };

  // Only this outcome carries them, and only here are they meaningful.
  if (result.outcome === "PROFILE_UNAVAILABLE") {
    summary.profileUnavailableStage = result.stage;
    summary.profileUnavailableReasonCode = result.reasonCode;
  }

  return summary;
}

/** What one tick did. A disabled tick is a result, not an error. */
export type HistoricalFillRuntimeTickResult =
  | { status: "DISABLED" }
  | { status: "RAN"; result: HistoricalFillBatchResult };

export interface HistoricalFillRuntimeTickOptions {
  /**
   * Built ONLY if the gate is open. Identity of the caller's dependencies is
   * the caller's business; this module decides whether they are needed at all.
   */
  createDriver: () => {
    runHistoricalFillBatch: (options: {
      workerId: string;
      now: Date;
      horizonDays: number;
      maxWindows: number;
      maxUserTradesWeight: number;
    }) => Promise<HistoricalFillBatchResult>;
  };
  /**
   * The claim identity, passed straight through to the driver.
   *
   * Deliberately an INPUT and never generated here. `workerId` becomes
   * `claimOwner` on a durable row, and this repository has no worker-identity
   * convention to borrow; inventing one (a hostname, a pid) inside a helper
   * would quietly make that helper the owner of a decision the eventual caller
   * has to make. Fencing does not depend on it -- `attempts` is the token --
   * so passing it through costs nothing and settles nothing prematurely.
   */
  workerId: string;
  now: Date;
  horizonDays: number;
  maxWindows: number;
  maxUserTradesWeight: number;
  /** Defaults to the configured gate; injectable so a test need not reload env. */
  enabled?: boolean;
}

/**
 * Runs at most ONE batch, and says what happened.
 *
 * No loop, no retry and no follow-up tick. A window's retry and backoff are
 * durable state the executor already owns; re-running here would spend exchange
 * weight the budget just declared finished.
 */
export async function runHistoricalFillRuntimeTick(
  options: HistoricalFillRuntimeTickOptions
): Promise<HistoricalFillRuntimeTickResult> {
  const enabled = options.enabled ?? env.EXECUTION_FILL_RUNTIME_ENABLED;

  // Before the factory, before the driver, before anything. A dormant runtime
  // is silent too: a tick that does nothing has nothing to report, and saying
  // so on every call would bury the one line that matters.
  if (!enabled) return { status: "DISABLED" };

  const driver = options.createDriver();

  let result: HistoricalFillBatchResult;
  try {
    result = await driver.runHistoricalFillBatch({
      workerId: options.workerId,
      now: options.now,
      horizonDays: options.horizonDays,
      maxWindows: options.maxWindows,
      maxUserTradesWeight: options.maxUserTradesWeight,
    });
  } catch (error) {
    // Reported, then re-thrown unchanged. A failure that became a result would
    // be indistinguishable from a pass that legitimately did no work.
    logger.error(
      {
        event: HISTORICAL_FILL_BATCH_FAILED_EVENT,
        workerId: options.workerId,
        error: error instanceof Error ? error.message.slice(0, MAX_LOGGED_ERROR_LENGTH) : "unknown",
      },
      "Historical fill batch failed"
    );
    throw error;
  }

  logger.info(
    summarizeHistoricalFillBatch(options.workerId, result),
    "Historical fill batch complete"
  );

  return { status: "RAN", result };
}
