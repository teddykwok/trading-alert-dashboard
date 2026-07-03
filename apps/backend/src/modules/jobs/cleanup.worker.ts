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
    const updated = await prisma.alert.update({
      where: { id: alert.id },
      data: { status: "FAILED", errorMessage: "Processing timed out and was cleaned up." },
    });
    await notifyAlertFailed(updated);
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
