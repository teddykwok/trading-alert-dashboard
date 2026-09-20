import { prisma } from "../../plugins/prisma";
import { logger } from "../../config/logger";
import { notifyAlertFailed } from "../notifications/notification.service";

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Safety net for alerts whose worker process crashed or hung mid-pipeline
 * (stuck in PROCESSING_SCREENSHOT or ANALYZING_WITH_AI). Marks them FAILED
 * so they don't sit in a "processing forever" state on the dashboard.
 */
export async function cleanupStaleAlerts(): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_THRESHOLD_MS);

  const staleAlerts = await prisma.alert.findMany({
    where: {
      status: { in: ["PROCESSING_SCREENSHOT", "ANALYZING_WITH_AI"] },
      updatedAt: { lt: staleBefore },
    },
  });

  for (const alert of staleAlerts) {
    // CONDITIONAL. The sweep runs on a timer in a process that may not be the
    // only one: an unconditional update let two sweeps both write FAILED and
    // both send the Telegram message, because the second had no way to learn
    // the first had already claimed the row. Re-asserting the exact status we
    // read makes the database decide, and only the winner notifies.
    const won = await prisma.alert.updateMany({
      where: {
        id: alert.id,
        // The same eligibility this pass selected on. A row that left the
        // stuck states in the meantime is no longer stale, and a row another
        // sweep already failed no longer matches either.
        status: alert.status,
      },
      data: { status: "FAILED", errorMessage: "Processing timed out and was cleaned up." },
    });
    if (won.count !== 1) continue;

    const updated = await prisma.alert.findUnique({ where: { id: alert.id } });
    if (updated) await notifyAlertFailed(updated);
    logger.warn({ alertId: alert.id }, "Marked stale alert as FAILED");
  }
}

export function startCleanupScheduler(): NodeJS.Timeout {
  return setInterval(() => {
    cleanupStaleAlerts().catch((error) => {
      logger.error({ error }, "Cleanup sweep failed");
    });
  }, CHECK_INTERVAL_MS);
}
