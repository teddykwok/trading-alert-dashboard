import { prisma } from "../../plugins/prisma";
import { logger } from "../../config/logger";
import {
  createExecutionNotificationService,
  type TickSummary,
} from "../notifications/execution-notification.service";

/**
 * Phase 9 runtime — the production invocation path for execution notifications.
 *
 * A bounded tick on a plain interval, following the same convention as
 * cleanup.worker.ts: the worker entrypoint starts it once and clears the timer
 * on shutdown. Deliberately NOT a second daemon process, not a BullMQ queue and
 * not an HTTP trigger.
 *
 * What one tick may do: read durable lifecycle history, write notification
 * intents and their checkpoints, and deliver Telegram messages. What it can
 * never do: reach Binance, submit or cancel an order, or write a
 * TradeExecution, BinanceOrder, ExecutionProtectionState, SafetyAdmission,
 * MarginAdjustmentIntent or ExecutionEvent row.
 *
 * A tick failure is logged and swallowed. Telegram being down, misconfigured or
 * switched off can never take down the worker that also runs the trading
 * pipeline.
 */

/**
 * Conservative on purpose. Execution notifications are observability, not a
 * trading signal: a message arriving up to a minute late costs nothing, while a
 * tight interval would hammer the database for no benefit. Recovery after long
 * downtime is handled by processing several bounded batches over successive
 * ticks, not by making the interval short.
 */
export const NOTIFICATION_TICK_INTERVAL_MS = 60_000;

/**
 * Guard against overlapping ticks. A slow Telegram endpoint can make one pass
 * outlast the interval; without this, ticks would pile up and compete for the
 * same claims. Delivery is claim-safe regardless, so this is about not wasting
 * work rather than about correctness.
 */
let tickInFlight = false;

/** One bounded pass. Exported so tests can drive it without a timer. */
export async function runNotificationTickOnce(): Promise<TickSummary | null> {
  if (tickInFlight) {
    logger.debug("Execution notification tick still running — skipping this interval");
    return null;
  }
  tickInFlight = true;
  try {
    const service = createExecutionNotificationService(prisma);
    const summary = await service.runExecutionNotificationTick();
    if (summary.notificationsCreated > 0 || summary.delivery.criticalDelivered > 0) {
      logger.info(
        {
          created: summary.notificationsCreated,
          criticalDelivered: summary.delivery.criticalDelivered,
          delivered: summary.delivery.notificationsDelivered,
        },
        "Execution notification tick completed"
      );
    }
    return summary;
  } catch (error) {
    // runExecutionNotificationTick already swallows its own failures; this is
    // the last line of defence so an unexpected throw (a dead database socket,
    // say) can never reach the worker's unhandled-rejection path.
    logger.error(
      { error: error instanceof Error ? error.message.slice(0, 300) : "unknown" },
      "Execution notification tick threw — trading is unaffected"
    );
    return null;
  } finally {
    tickInFlight = false;
  }
}

/**
 * Starts the interval and returns its timer so the caller can clear it on
 * shutdown. `unref()` keeps the timer from holding the process open on its own.
 */
export function startExecutionNotificationScheduler(
  intervalMs = NOTIFICATION_TICK_INTERVAL_MS
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void runNotificationTickOnce();
  }, intervalMs);
  timer.unref?.();
  logger.info({ intervalMs }, "Execution notification scheduler started");
  return timer;
}

/** Test-only: clears the overlap guard between cases. */
export function resetTickGuardForTests(): void {
  tickInFlight = false;
}
