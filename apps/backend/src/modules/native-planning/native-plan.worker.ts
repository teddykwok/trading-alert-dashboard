// MUST be the first import: a GENERIC process. It holds no account and refuses
// to start carrying one (see config/bootstrap-generic).
import "../../config/bootstrap-generic";

import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma } from "../../plugins/prisma";
import { ExtremeRRService } from "../extreme-rr/extreme-rr.service";
import { NATIVE_EXTREME_RR_QUEUE_NAME, openNativePlanQueue, type NativePlanJobData } from "./native-plan-queue";
import { NATIVE_PLAN_RECOVERY_INTERVAL_MS, processNativePlanJob, runNativePlanRecoverySweep } from "./native-plan-processor";

/**
 * THE NATIVE PLANNING WORKER — `pnpm --filter @trading-alert-dashboard/backend native-alerts:plan-worker`.
 *
 * A separate generic process on purpose: the TradingView worker
 * (vision-analysis.worker.ts) and its queues are not touched, and the operator
 * decides when automatic Native planning runs. It consumes only the dedicated
 * Native planning queue, generates each requested alert's frozen plan with
 * public Binance candles, and stops there. PLANNING ONLY: no Telegram, no
 * screenshot, no AI vision, no adoption, no execution, no signed request.
 *
 * Until it runs, requested plans simply stay PENDING (shown as planning) and
 * their jobs wait in Redis; its startup sweep re-enqueues any PENDING Native
 * intent whose job was lost.
 */

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
const { queue, close: closeQueue } = openNativePlanQueue(connection);
const planner = new ExtremeRRService(prisma);

async function processJob(job: Job<NativePlanJobData>): Promise<void> {
  const outcome = await processNativePlanJob({ prisma, planner }, job.data.alertId);
  logger.info({ alertId: job.data.alertId, outcome }, "Native auto-planning job finished");
}

const worker = new Worker<NativePlanJobData>(NATIVE_EXTREME_RR_QUEUE_NAME, processJob, { connection, concurrency: 2 });
worker.on("failed", (job, error) => {
  logger.warn({ jobId: job?.id, attempt: job?.attemptsMade, error: error.message.slice(0, 300) }, "Native auto-planning job failed");
});

async function sweep(): Promise<void> {
  try {
    const summary = await runNativePlanRecoverySweep(prisma, queue);
    if (summary.inspected > 0) logger.info({ ...summary, outcomes: summary.outcomes.slice(0, 25) }, "Native planning recovery sweep");
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : "unknown" }, "Native planning recovery sweep failed (retried next tick)");
  }
}

void sweep();
const sweepTimer = setInterval(() => void sweep(), NATIVE_PLAN_RECOVERY_INTERVAL_MS);

logger.info({ queue: NATIVE_EXTREME_RR_QUEUE_NAME }, "Native planning worker started (PLANNING ONLY / NATIVE EXECUTION DISABLED)");

async function shutdown(): Promise<void> {
  clearInterval(sweepTimer);
  await worker.close();
  await closeQueue();
  connection.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
