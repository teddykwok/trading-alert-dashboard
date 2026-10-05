import { judgeNativePlannerHeartbeat, type NativePlannerWorkerView } from "./native-planner-heartbeat";

/**
 * READ-ONLY health/readiness of the Native planner worker, for operators who
 * need to tell "backend healthy" apart from "Native auto-planning healthy".
 *
 * Three independent pieces of evidence, each degrading to null on its own
 * rather than failing the whole read:
 *  - the worker's own Redis heartbeat (fresh / stale / absent);
 *  - BullMQ's view of the dedicated queue: connected consumers and job counts;
 *  - the database: how many Native plans are still PENDING (waiting to be planned).
 *
 * It writes nothing, starts nothing, and exposes no pid, path, host, secret or
 * account. It never claims execution: nativeExecutionEnabled is always false.
 */

export interface NativePlannerJobCounts {
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
  readonly completed: number;
}

export interface NativePlannerStatusDto {
  readonly generatedAt: string;
  readonly role: "native-planner";
  readonly queue: string;
  readonly nativeExecutionEnabled: false;
  /** The worker is a separate, explicitly started process: never implied by the backend being up. */
  readonly startedBy: "EXPLICIT_COMMAND_OR_LAUNCHER";
  readonly worker: NativePlannerWorkerView;
  /** BullMQ-connected consumers of the Native queue; null when Redis could not be asked. */
  readonly connectedConsumers: number | null;
  readonly jobs: NativePlannerJobCounts | null;
  /** Native plans whose automatic generation has not finished yet; null when the database could not be read. */
  readonly pendingNativePlans: number | null;
  /**
   * READY  - fresh heartbeat, consumer running, at least one connected consumer;
   * DEGRADED - some evidence says running, some does not (or could not be read);
   * DOWN   - no heartbeat and no connected consumer.
   */
  readonly readiness: "READY" | "DEGRADED" | "DOWN";
}

/** How long a status read waits for its own Redis connection to become ready. Bounded: never a hang. */
export const NATIVE_PLANNER_STATUS_REDIS_READY_TIMEOUT_MS = 2_000;

/** The slice of an ioredis client the readiness wait needs (ioredis satisfies it; tests use an EventEmitter). */
export interface ReadinessClient {
  readonly status: string;
  once(event: "ready" | "end", listener: () => void): unknown;
  removeListener(event: "ready" | "end", listener: () => void): unknown;
}

const redisError = (name: string, message: string) => Object.assign(new Error(message), { name });

/**
 * Resolves once the client is READY, or rejects -- immediately for a client that
 * has ENDED, otherwise after `timeoutMs`. It never retries and never spins: a
 * genuinely unreachable Redis is reported as such (the status then reads
 * DEGRADED / UNREADABLE), while a connection that is merely still establishing
 * on the first request after startup is waited for instead of read too early.
 */
export function waitForRedisReady(client: ReadinessClient, timeoutMs: number = NATIVE_PLANNER_STATUS_REDIS_READY_TIMEOUT_MS): Promise<void> {
  if (client.status === "ready") return Promise.resolve();
  if (client.status === "end") return Promise.reject(redisError("RedisEnded", "the Redis connection has ended"));
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      client.removeListener("ready", onReady);
      client.removeListener("end", onEnd);
    };
    function onReady() {
      cleanup();
      resolve();
    }
    function onEnd() {
      cleanup();
      reject(redisError("RedisEnded", "the Redis connection has ended"));
    }
    client.once("ready", onReady);
    client.once("end", onEnd);
    timer = setTimeout(() => {
      cleanup();
      reject(redisError("RedisNotReady", `the Redis connection was not ready within ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
  });
}

export interface NativePlannerStatusDeps {
  readonly queue: string;
  /**
   * Resolves when the Redis connection the two Redis reads below use is ready
   * (bounded). When it rejects, those reads are NOT attempted: the heartbeat
   * reads UNREADABLE and the queue stats null, so a real outage stays truthful
   * and nothing waits on a connection that is not there.
   */
  readonly redisReady?: () => Promise<void>;
  readonly readHeartbeat: () => Promise<string | null>;
  readonly queueStats: () => Promise<{ readonly connectedConsumers: number; readonly jobs: NativePlannerJobCounts }>;
  readonly countPendingNativePlans: () => Promise<number>;
  readonly now?: () => Date;
}

export async function readNativePlannerStatus(deps: NativePlannerStatusDeps): Promise<NativePlannerStatusDto> {
  const now = (deps.now ?? (() => new Date()))();
  // The route's own Redis connection may still be establishing (first request after startup): wait for it, bounded.
  let redisNotReady: string | null = null;
  if (deps.redisReady) {
    try {
      await deps.redisReady();
    } catch (error) {
      redisNotReady = error instanceof Error ? error.message : "the Redis connection is not ready";
    }
  }
  const notReady = () => Promise.reject(redisError("RedisNotReady", redisNotReady ?? "not ready"));
  const [heartbeat, stats, pending] = await Promise.allSettled([
    redisNotReady === null ? deps.readHeartbeat() : notReady(),
    redisNotReady === null ? deps.queueStats() : notReady(),
    deps.countPendingNativePlans(),
  ]);
  const worker: NativePlannerWorkerView =
    heartbeat.status === "fulfilled"
      ? judgeNativePlannerHeartbeat(heartbeat.value, now.getTime())
      : {
          state: "UNREADABLE",
          reason: redisNotReady === null ? "The Native planner heartbeat could not be read from Redis." : `The Native planner heartbeat could not be read: ${redisNotReady}.`,
          startedAt: null,
          lastHeartbeatAt: null,
          ageSeconds: null,
          consumerRunning: null,
          lastSweep: null,
          lastSweepError: null,
        };
  const connectedConsumers = stats.status === "fulfilled" ? stats.value.connectedConsumers : null;
  const jobs = stats.status === "fulfilled" ? stats.value.jobs : null;
  const pendingNativePlans = pending.status === "fulfilled" ? pending.value : null;

  const readiness: NativePlannerStatusDto["readiness"] =
    worker.state === "RUNNING" && connectedConsumers !== null && connectedConsumers > 0
      ? "READY"
      : worker.state === "OFF" && connectedConsumers === 0
        ? "DOWN"
        : "DEGRADED";

  return {
    generatedAt: now.toISOString(),
    role: "native-planner",
    queue: deps.queue,
    nativeExecutionEnabled: false,
    startedBy: "EXPLICIT_COMMAND_OR_LAUNCHER",
    worker,
    connectedConsumers,
    jobs,
    pendingNativePlans,
    readiness,
  };
}
