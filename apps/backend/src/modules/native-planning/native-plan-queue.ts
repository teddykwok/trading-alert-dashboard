import { Queue, type ConnectionOptions } from "bullmq";

/**
 * The DEDICATED queue for automatic Native Extreme RR planning.
 *
 * Not the TradingView `extreme-rr-plan` queue: that queue's consumer sends the
 * plan's Telegram notification, and TradingView's lifecycle stays exactly as
 * it is. This queue's only consumer (native-plan.worker.ts) generates the
 * frozen plan and stops: no Telegram, no screenshot, no AI vision, no
 * adoption, no execution.
 */
export const NATIVE_EXTREME_RR_QUEUE_NAME = "native-extreme-rr-plan";

export interface NativePlanJobData {
  alertId: string;
}

/** The TradingView Extreme RR queue's own bounded retry convention, unchanged. */
export const NATIVE_PLAN_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: "exponential", delay: 3000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
} as const;

/**
 * The job's identity: the alert's own id. BullMQ refuses a second job with an
 * id that still exists, atomically inside Redis, so repeated requests, a
 * request racing a recovery sweep, or two emitters all collapse into one job.
 * (Alert ids are cuids: never the `:` BullMQ reserves.)
 */
export function nativePlanJobId(alertId: string): string {
  return alertId;
}

export type NativePlanJobState = "missing" | "waiting" | "active" | "delayed" | "completed" | "failed" | "unknown";

/** Exactly what the requester and the recovery sweep need. A test seam: the real Queue backs it. */
export interface NativePlanQueue {
  /** Idempotent per alert (see nativePlanJobId). */
  add(alertId: string): Promise<void>;
  /** "missing" when no job with that id exists in Redis. */
  stateOf(alertId: string): Promise<NativePlanJobState>;
}

const KNOWN_STATES = new Set<NativePlanJobState>(["waiting", "active", "delayed", "completed", "failed"]);

export function openNativePlanQueue(connection: ConnectionOptions): { queue: NativePlanQueue; close: () => Promise<void> } {
  const bull = new Queue<NativePlanJobData>(NATIVE_EXTREME_RR_QUEUE_NAME, { connection, defaultJobOptions: NATIVE_PLAN_JOB_OPTIONS });
  return {
    queue: {
      async add(alertId) {
        await bull.add("generate", { alertId }, { jobId: nativePlanJobId(alertId) });
      },
      async stateOf(alertId) {
        const job = await bull.getJob(nativePlanJobId(alertId));
        if (!job) return "missing";
        const state = String(await job.getState());
        return KNOWN_STATES.has(state as NativePlanJobState) ? (state as NativePlanJobState) : state === "prioritized" || state === "waiting-children" ? "waiting" : "unknown";
      },
    },
    close: () => bull.close(),
  };
}
