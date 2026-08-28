import { Queue } from "bullmq";
import Redis from "ioredis";
import { EXTREME_RR_QUEUE_NAME, VISION_ANALYSIS_QUEUE_NAME } from "@trading-alert-dashboard/shared";
import { env } from "../../config/env";

// BullMQ requires this option to be null on any connection it manages.
export const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export interface VisionAnalysisJobData {
  alertId: string;
}

export const visionAnalysisQueue = new Queue<VisionAnalysisJobData>(VISION_ANALYSIS_QUEUE_NAME, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
});

/**
 * The vision job's identity: the alert's own id, and nothing else.
 *
 * This is what makes enqueueing idempotent, and it is enforced by Redis rather
 * than by us. `addStandardJob-9.lua` checks `EXISTS jobIdKey` before creating
 * anything and, when the id is already present, returns the existing job
 * through `handleDuplicatedJob` without adding a second one. That check happens
 * inside a single Lua script, so it is atomic across processes: a webhook and a
 * recovery sweep can call this at the same instant and exactly one job results.
 *
 * Alert ids are cuids (`[a-z0-9]+`), so they never contain the `:` that BullMQ
 * reserves for its own composite ids.
 *
 * The consequence worth stating plainly: nothing else in this repo needs a
 * lock, a claim table or an outbox to make vision enqueueing safe.
 */
export function visionAnalysisJobId(alertId: string): string {
  return alertId;
}

export async function enqueueVisionAnalysis(alertId: string): Promise<void> {
  await visionAnalysisQueue.add("analyze", { alertId }, { jobId: visionAnalysisJobId(alertId) });
}

export interface ExtremeRRJobData {
  alertId: string;
}

// Same connection/retry conventions as the vision queue — one worker process
// hosts both processors (see vision-analysis.worker.ts).
export const extremeRRQueue = new Queue<ExtremeRRJobData>(EXTREME_RR_QUEUE_NAME, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
});

export async function enqueueExtremeRRPlan(alertId: string): Promise<void> {
  await extremeRRQueue.add("generate", { alertId });
}
