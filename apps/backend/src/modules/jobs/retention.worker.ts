import { Queue, Worker } from "bullmq";
import { bullConnection } from "./queue";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma } from "../../plugins/prisma";
import { ensureScreenshotDir } from "../../utils/file";
import { runRetentionCleanup } from "../retention/retention.service";

export const RETENTION_QUEUE_NAME = "data-retention";
const SCHEDULER_ID = "daily-data-retention";

/**
 * Schedules the daily retention cleanup using BullMQ's job scheduler
 * (upsertJobScheduler — available in the installed bullmq 5.79.x), with the
 * cron pattern and timezone from env (default 03:00 Asia/Singapore; BullMQ's
 * cron-parser handles the tz conversion). Runs inside the existing worker
 * process — no extra process, no cron dependency.
 *
 * Concurrency is 1 here, and runRetentionCleanup itself takes a Postgres
 * advisory lock, so even accidental duplicate worker processes cannot run two
 * destructive passes at once.
 *
 * When DATA_RETENTION_ENABLED=false the scheduler entry is REMOVED (not just
 * skipped) so no orphaned jobs pile up in Redis, and the vision-analysis
 * worker keeps running completely unaffected.
 */
export async function setupRetentionSchedule(): Promise<Worker | null> {
  const queue = new Queue(RETENTION_QUEUE_NAME, { connection: bullConnection });

  try {
    if (!env.DATA_RETENTION_ENABLED) {
      await queue.removeJobScheduler(SCHEDULER_ID).catch(() => undefined);
      logger.info("Data retention disabled (DATA_RETENTION_ENABLED=false) — no cleanup scheduled");
      return null;
    }

    await queue.upsertJobScheduler(
      SCHEDULER_ID,
      { pattern: env.DATA_CLEANUP_CRON, tz: env.DATA_CLEANUP_TIMEZONE },
      { name: "retention-cleanup" }
    );
  } finally {
    await queue.close();
  }

  const worker = new Worker(
    RETENTION_QUEUE_NAME,
    async () => {
      const screenshotDir = await ensureScreenshotDir();
      const report = await runRetentionCleanup(prisma, {
        dryRun: false,
        screenshotDir,
        screenshotRetentionDays: env.SCREENSHOT_RETENTION_DAYS,
        alertRetentionDays: env.ALERT_RETENTION_DAYS,
      });
      logger.info({ report }, "Scheduled data-retention cleanup finished");
    },
    { connection: bullConnection, concurrency: 1 }
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Data-retention job failed");
  });

  logger.info(
    { cron: env.DATA_CLEANUP_CRON, timezone: env.DATA_CLEANUP_TIMEZONE },
    "Data-retention cleanup scheduled"
  );
  return worker;
}
