import { env } from "../../config/env";
import { logger } from "../../config/logger";
import {
  runHistoricalFillRuntimeTick,
  type HistoricalFillRuntimeTickOptions,
  type HistoricalFillRuntimeTickResult,
} from "./historical-fill-runtime";

/**
 * A recurring historical-fill batch loop -- built, but started by nobody.
 *
 * ## Still dormant
 *
 * This file creates no timer at import and holds no singleton. A loop exists
 * only after someone calls `start()` on an instance, and in this phase nothing
 * does: the worker does not import this module. The scheduler is therefore the
 * third dormant layer in a chain that still terminates in no caller at all --
 * driver, runner, scheduler, nobody.
 *
 * ## Why every tick goes back through the runner
 *
 * The scheduler never touches `HistoricalFillBatchDriver`. Each tick calls
 * `runHistoricalFillRuntimeTick`, which re-reads the gate, so disabling the
 * runtime stops work even on an instance somebody forgot to stop. The gate is
 * checked here too, at start: two independent refusals, and the outer one
 * avoids creating a timer that would only ever produce DISABLED results.
 *
 * ## Why start does not tick immediately
 *
 * `cleanup` and `execution-notification` both wait one interval. The two
 * schedulers that DO run something at start -- `execution-orchestration` and
 * `alert-queue-recovery` -- run an explicitly labelled STARTUP RECOVERY pass,
 * a different call from their periodic one, because a previous process may
 * have stranded work that nothing else will re-offer.
 *
 * Historical fill has no such duty. Work stranded by a crash is already
 * recovered durably: the lease goes stale, the window becomes claimable again,
 * and the next ordinary tick takes it. Nothing waits on a startup sweep. So
 * this follows the plain recurring pattern -- and, usefully for a rollout,
 * `start()` itself then issues no exchange request.
 */

/** One tick at a time, per instance. Never a queue of deferred catch-ups. */
export const HISTORICAL_FILL_MAX_IN_FLIGHT_TICKS = 1;

/** What a started scheduler gives back. */
export type HistoricalFillSchedulerHandle =
  | { status: "DISABLED" }
  | {
      status: "RUNNING";
      /** The house convention's own return value, so a caller can clearInterval it. */
      timer: NodeJS.Timeout;
      /** Idempotent: clears the interval once and refuses every later tick. */
      stop: () => void;
      /**
       * Stop, then wait for a tick that is ALREADY running to settle.
       *
       * Shutdown needs this because `stop()` only closes the door: a tick that
       * was already inside `executeOne` still holds the shared Prisma client,
       * and the worker disconnects that client moments later. Awaiting the
       * in-flight pass is what keeps a claim and its transaction from being
       * torn out from underneath -- there is no abort here, and there should
       * not be.
       *
       * Resolves immediately when nothing is running, and never rejects: a
       * failed tick is already the runner's own recorded incident, and it must
       * not turn shutdown into a failure.
       */
      stopAndDrain: () => Promise<void>;
    };

export interface HistoricalFillSchedulerOptions
  extends Pick<
    HistoricalFillRuntimeTickOptions,
    | "createDriver"
    | "horizonDays"
    | "maxWindows"
    | "maxUserTradesWeight"
    | "globalUserTradesWeightPerMinute"
  > {
  /**
   * Passed through to every tick, exactly as given.
   *
   * This module does NOT construct process identity -- no hostname, no pid, no
   * uuid, no timestamp. `workerId` becomes `claimOwner` on a durable row, and
   * how many processes may legitimately own that name is a multi-process policy
   * question a later slice owns. A scheduler that minted one would answer it by
   * accident.
   */
  workerId: string;
  /** Defaults to the configured cadence. Milliseconds, never sub-second. */
  intervalMs?: number;
  /** Defaults to the configured gate; injectable so a test need not reload env. */
  enabled?: boolean;
  /**
   * A FRESH instant per tick, never one frozen at start.
   *
   * Phase 7's clock contract lives or dies here: the batch stamps its bootstrap
   * with this value, and a scheduler that captured one `Date` at start would
   * hand every later batch an hour-old instant.
   */
  now?: () => Date;
  /** Injectable only so a test can observe the tick; production uses the runner. */
  runTick?: (options: HistoricalFillRuntimeTickOptions) => Promise<HistoricalFillRuntimeTickResult>;
}

export interface HistoricalFillScheduler {
  /** Idempotent: a second call returns the first handle, never a second timer. */
  start: () => HistoricalFillSchedulerHandle;
}

/** Seconds to milliseconds. The schema already refuses anything sub-second. */
export function historicalFillIntervalMs(
  seconds: number = env.EXECUTION_FILL_BATCH_INTERVAL_SECONDS
): number {
  return seconds * 1000;
}

/**
 * Builds a scheduler instance. Building one starts nothing.
 *
 * State lives in this closure rather than at module scope -- the house
 * schedulers keep their in-flight flag in a module variable because exactly one
 * of each is ever started, and an instance that shared that flag with another
 * instance would report a phantom overlap.
 */
export function createHistoricalFillScheduler(
  options: HistoricalFillSchedulerOptions
): HistoricalFillScheduler {
  const runTick = options.runTick ?? runHistoricalFillRuntimeTick;
  const clock = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? historicalFillIntervalMs();

  let started: HistoricalFillSchedulerHandle | null = null;
  let tickInFlight = false;
  let stopped = false;
  /** The pass currently running, so shutdown can await exactly that one. */
  let inFlightTick: Promise<void> | null = null;

  /**
   * ONE pass, under the single-flight guard.
   *
   * The guard is released in `finally` and never from outside. A rejection is
   * caught and swallowed HERE and nowhere else: the runner already logged the
   * batch failure with its own event and rethrew, so re-logging it would double
   * every incident in the log, and letting it escape would kill the interval
   * over a failure the window's own backoff is already handling.
   */
  async function tickOnce(): Promise<void> {
    if (stopped) return;

    if (tickInFlight) {
      // The house wording, and `debug` like every other scheduler: a skip is
      // normal operation, not an incident.
      logger.debug("Historical fill tick still running — skipping this interval");
      return;
    }

    tickInFlight = true;
    try {
      // Nothing else is allowed to await this; `run()` below records the
      // promise so a drain can wait for THIS pass and no other.
      await runTick({
        createDriver: options.createDriver,
        workerId: options.workerId,
        now: clock(),
        horizonDays: options.horizonDays,
        maxWindows: options.maxWindows,
        maxUserTradesWeight: options.maxUserTradesWeight,
        globalUserTradesWeightPerMinute: options.globalUserTradesWeightPerMinute,
      });
    } catch {
      // Deliberately empty. See above: the runner owns the failure record, and
      // the next ordinary interval is the only retry there is.
    } finally {
      tickInFlight = false;
    }
  }

  /**
   * Runs one pass and remembers it while it is in flight.
   *
   * `tickOnce` already swallows failures, so this promise settles rather than
   * rejects, which is what makes `stopAndDrain` safe to await unguarded.
   */
  function run(): void {
    const pass = tickOnce().finally(() => {
      inFlightTick = null;
    });
    inFlightTick = pass;
  }

  return {
    start(): HistoricalFillSchedulerHandle {
      // A second start returns the first answer. One instance can never own two
      // loops, whatever a caller does.
      if (started !== null) return started;

      const enabled = options.enabled ?? env.EXECUTION_FILL_RUNTIME_ENABLED;

      // No timer at all when the runtime is off. The runner would refuse every
      // tick anyway, so a loop here would be a heartbeat that only ever decides
      // to do nothing.
      if (!enabled) {
        started = { status: "DISABLED" };
        return started;
      }

      const timer = setInterval(() => {
        void run();
      }, intervalMs);
      timer.unref?.();

      const stop = () => {
        // Latched before clearing, so a callback already queued for this turn
        // finds the scheduler closed and starts no work.
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        logger.info("Historical fill scheduler stopped");
      };

      // Close the door first, then wait for whoever is already inside. The
      // order matters: draining before stopping would let the interval start
      // another pass while we waited for the previous one.
      const stopAndDrain = async () => {
        stop();
        await inFlightTick;
      };

      logger.info({ intervalMs }, "Historical fill scheduler started");

      started = { status: "RUNNING", timer, stop, stopAndDrain };
      return started;
    },
  };
}
