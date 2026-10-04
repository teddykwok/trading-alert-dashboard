import type { FastifyInstance } from "fastify";

import { readNativePlannerStatus, type NativePlannerStatusDeps } from "../modules/native-planning/native-planner-status";

/**
 * GET /api/native-planner/status — READ-ONLY health/readiness of the separate
 * Native planner worker (heartbeat, connected queue consumers, job counts,
 * PENDING Native plans). Lets an operator tell "backend healthy" apart from
 * "Native auto-planning healthy". Writes nothing; exposes no pid, path, host,
 * secret or account; never starts the worker.
 */
export async function nativePlannerRoutes(app: FastifyInstance, opts: { deps?: NativePlannerStatusDeps } = {}): Promise<void> {
  let deps: NativePlannerStatusDeps | null = opts.deps ?? null;
  let close: (() => Promise<void>) | null = null;

  const realDeps = async (): Promise<NativePlannerStatusDeps> => {
    const { env } = await import("../config/env");
    const { default: IORedis } = await import("ioredis");
    const { Queue } = await import("bullmq");
    const { NATIVE_EXTREME_RR_QUEUE_NAME } = await import("../modules/native-planning/native-plan-queue");
    const { NATIVE_PLANNER_HEARTBEAT_KEY } = await import("../modules/native-planning/native-planner-heartbeat");
    // Its own bounded connection: a Redis that is down fails this read quickly and touches nothing else.
    const client = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
    client.on("error", () => undefined);
    // Read-only use only: job counts and connected workers. Nothing is ever added to this queue here.
    const queue = new Queue(NATIVE_EXTREME_RR_QUEUE_NAME, { connection: client });
    close = async () => {
      await queue.close().catch(() => undefined);
      client.disconnect();
    };
    return {
      queue: NATIVE_EXTREME_RR_QUEUE_NAME,
      readHeartbeat: () => client.get(NATIVE_PLANNER_HEARTBEAT_KEY),
      queueStats: async () => {
        const [workers, counts] = await Promise.all([queue.getWorkers(), queue.getJobCounts("waiting", "active", "delayed", "failed", "completed")]);
        return {
          connectedConsumers: workers.length,
          jobs: { waiting: counts.waiting ?? 0, active: counts.active ?? 0, delayed: counts.delayed ?? 0, failed: counts.failed ?? 0, completed: counts.completed ?? 0 },
        };
      },
      countPendingNativePlans: () => app.prisma.extremeRRPlan.count({ where: { status: "PENDING", alert: { source: "NATIVE" } } }),
    };
  };

  app.addHook("onClose", async () => {
    if (close) await close();
  });

  app.get("/api/native-planner/status", async () => {
    deps ??= await realDeps();
    return readNativePlannerStatus(deps);
  });
}
