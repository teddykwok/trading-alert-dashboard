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

export async function enqueueVisionAnalysis(alertId: string): Promise<void> {
  await visionAnalysisQueue.add("analyze", { alertId });
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
