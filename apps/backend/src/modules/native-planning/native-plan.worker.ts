// MUST be the first import: a GENERIC process. It holds no account and refuses
// to start carrying one (see config/bootstrap-generic).
import "../../config/bootstrap-generic";

import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma } from "../../plugins/prisma";
import { installFatalHandlers } from "../runtime/worker-liveness";
import { ExtremeRRService } from "../extreme-rr/extreme-rr.service";
import { NATIVE_EXTREME_RR_QUEUE_NAME, openNativePlanQueue, type NativePlanJobData } from "./native-plan-queue";
import { NATIVE_PLAN_RECOVERY_INTERVAL_MS, processNativePlanJob, runNativePlanRecoverySweep } from "./native-plan-processor";
import { startNativePlannerRuntime } from "./native-planner-runtime";

/**
 * THE NATIVE PLANNER WORKER — `pnpm --filter @trading-alert-dashboard/backend native-alerts:plan-worker`.
 *
 * A separate GENERIC process and role (`native-planner`): not the generic
 * backend, not the TradingView analysis worker (vision-analysis.worker.ts and
 * its queues are untouched), not an account worker. It is deliberately NOT part
 * of `pnpm dev`; run it explicitly, or start/supervise it from the runtime
 * launcher's optional "Native Planner" actions (never part of Start SAFE).
 *
 * It consumes only the dedicated Native planning queue, generates each
 * requested alert's frozen plan with public Binance candles, and stops there.
 * PLANNING ONLY: no Telegram, no screenshot, no AI vision, no adoption, no
 * execution, no signed request. Needs only the generic environment
 * (DATABASE_URL, REDIS_URL, EXTREME_RR_LOOKBACK_CANDLES default); no account key.
 *
 * Until it runs, requested plans stay PENDING (shown as PLANNING) and their
 * jobs wait in Redis; its startup sweep re-enqueues any PENDING Native intent
 * whose job was lost.
 */

// A crash is recorded (redacted) and exits non-zero, so supervision sees it and restarts by role.
installFatalHandlers();

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
const { queue, close: closeQueue } = openNativePlanQueue(connection);
const planner = new ExtremeRRService(prisma);

void (async () => {
  const runtime = await startNativePlannerRuntime({
    queueName: NATIVE_EXTREME_RR_QUEUE_NAME,
    pid: process.pid,
    createWorker: (run) => {
      const worker = new Worker<NativePlanJobData>(NATIVE_EXTREME_RR_QUEUE_NAME, async (job: Job<NativePlanJobData>) => {
        await run(job.data.alertId);
      }, { connection, concurrency: 2 });
      worker.on("failed", (job, error) => {
        logger.warn({ role: "native-planner", jobId: job?.id, attempt: job?.attemptsMade, error: error.message.slice(0, 300) }, "Native auto-planning job failed");
      });
      worker.on("error", (error) => {
        logger.warn({ role: "native-planner", error: error.name }, "Native planner worker connection error");
      });
      return { isRunning: () => worker.isRunning(), close: () => worker.close() };
    },
    processJob: (alertId) => processNativePlanJob({ prisma, planner }, alertId),
    sweep: () => runNativePlanRecoverySweep(prisma, queue),
    heartbeatStore: {
      set: (key, value, ttlSeconds) => connection.set(key, value, "EX", ttlSeconds),
      get: (key) => connection.get(key),
      del: (key) => connection.del(key),
    },
    closeQueue,
    closeConnection: async () => {
      await connection.quit().catch(() => connection.disconnect());
    },
    disconnectDb: () => prisma.$disconnect(),
    logger,
    sweepIntervalMs: NATIVE_PLAN_RECOVERY_INTERVAL_MS,
  });

  const stop = (signal: string) => {
    void runtime.shutdown(signal).then((code) => process.exit(code));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
})();
