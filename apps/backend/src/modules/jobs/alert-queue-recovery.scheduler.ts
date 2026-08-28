import { prisma } from "../../plugins/prisma";
import { logger } from "../../config/logger";
import { enqueueVisionAnalysis, visionAnalysisJobId, visionAnalysisQueue } from "./queue";
import {
  ALERT_QUEUE_RECOVERY_INTERVAL_MS,
  runAlertQueueRecoverySweep,
  type RecoverableJobQueue,
  type RecoverySweepSummary,
} from "./alert-queue-recovery.service";

/**
 * Runtime wiring for alert-queue recovery.
 *
 * Follows the same convention as `execution-notification.scheduler.ts` and
 * `cleanup.worker.ts`: the worker entrypoint starts it once and clears the
 * timer on shutdown. Deliberately not a second daemon, not a BullMQ queue of
 * its own, and not an HTTP trigger.
 *
 * ## Why startup AND periodic
 *
 * Startup alone is not enough, and the gap is easy to miss. The failure this
 * repairs is "Redis was unavailable while the backend kept accepting alerts" —
 * and Redis recovering does not restart anything. The backend stays up because
 * it never depended on Redis to persist a row; the worker stays up because it
 * never died, so worker supervision correctly leaves it alone. Without a
 * periodic sweep, those alerts would wait for an unrelated restart that may
 * never come.
 *
 * The startup pass still earns its place: it is what drains a backlog
 * immediately after a worker DOES restart, rather than one batch per minute.
 *
 * A tick failure is logged and swallowed. Recovery is repair work and must
 * never take down the worker that also runs the trading pipeline.
 */

/**
 * Adapter from the concrete BullMQ queue to the two calls a sweep makes.
 *
 * `add` goes through `enqueueVisionAnalysis`, deliberately — recovery and the
 * webhook must enqueue through exactly the same function, or the deterministic
 * jobId that makes them idempotent against each other could drift apart.
 */
export const visionRecoveryQueue: RecoverableJobQueue = {
  getJob: (jobId) => visionAnalysisQueue.getJob(jobId),
  add: (alertId) => enqueueVisionAnalysis(alertId),
};

/**
 * Guard against overlapping sweeps. Correctness does not depend on it — two
 * concurrent sweeps would still produce one job per alert, because the
 * deterministic jobId is resolved atomically inside Redis — but a slow sweep
 * outlasting its interval should not stack up passes competing for the same
 * rows.
 */
let sweepInFlight = false;

/** One bounded pass. Exported so tests can drive it without a timer. */
export async function runAlertQueueRecoveryOnce(
  queue: RecoverableJobQueue = visionRecoveryQueue,
  label = "periodic"
): Promise<RecoverySweepSummary | null> {
  if (sweepInFlight) {
    logger.debug({ label }, "Alert queue recovery sweep still running — skipping this interval");
    return null;
  }
  sweepInFlight = true;
  try {
    const summary = await runAlertQueueRecoverySweep(prisma, queue);

    if (summary.queueUnavailable) {
      // One line per sweep, never one per alert: an unreachable Redis would
      // otherwise produce a burst of identical errors every interval.
      logger.warn(
        { label, inspected: summary.inspected, recovered: summary.recovered },
        "Alert queue recovery could not reach the job queue — stranded alerts are unchanged and the next sweep retries"
      );
    } else if (summary.recovered > 0) {
      logger.info(
        {
          label,
          inspected: summary.inspected,
          recovered: summary.recovered,
          alreadyQueued: summary.alreadyQueued,
          // Ids only, and only for rows actually acted on.
          alertIds: summary.outcomes
            .filter((outcome) => outcome.disposition === "RECOVERED")
            .map((outcome) => outcome.alertId),
          oldestAgeMs: Math.max(...summary.outcomes.map((outcome) => outcome.ageMs)),
        },
        "Alert queue recovery re-queued alerts that had no vision job"
      );
    } else if (summary.inspected > 0) {
      logger.debug(
        { label, inspected: summary.inspected, alreadyQueued: summary.alreadyQueued },
        "Alert queue recovery found nothing to repair"
      );
    }

    return summary;
  } catch (error) {
    // Last line of defence: the sweep already swallows per-alert failures, so
    // reaching here means something like a dead database socket.
    logger.error(
      { label, error: error instanceof Error ? error.message.slice(0, 300) : "unknown" },
      "Alert queue recovery sweep threw — trading is unaffected"
    );
    return null;
  } finally {
    sweepInFlight = false;
  }
}

/**
 * Runs one sweep immediately, then starts the periodic one.
 *
 * The startup sweep is fire-and-forget: a worker must come up and start
 * consuming its queues whether or not recovery succeeds, and the interval will
 * try again regardless.
 */
export function startAlertQueueRecoveryScheduler(
  intervalMs = ALERT_QUEUE_RECOVERY_INTERVAL_MS
): NodeJS.Timeout {
  void runAlertQueueRecoveryOnce(visionRecoveryQueue, "startup");

  const timer = setInterval(() => {
    void runAlertQueueRecoveryOnce(visionRecoveryQueue, "periodic");
  }, intervalMs);
  timer.unref?.();

  logger.info({ intervalMs }, "Alert queue recovery scheduler started");
  return timer;
}

/** Test-only: clears the overlap guard between cases. */
export function resetRecoverySweepGuardForTests(): void {
  sweepInFlight = false;
}

/** Re-exported so callers have one import for the job identity contract. */
export { visionAnalysisJobId };
