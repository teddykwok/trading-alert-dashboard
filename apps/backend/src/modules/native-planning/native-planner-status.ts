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

export interface NativePlannerStatusDeps {
  readonly queue: string;
  readonly readHeartbeat: () => Promise<string | null>;
  readonly queueStats: () => Promise<{ readonly connectedConsumers: number; readonly jobs: NativePlannerJobCounts }>;
  readonly countPendingNativePlans: () => Promise<number>;
  readonly now?: () => Date;
}

export async function readNativePlannerStatus(deps: NativePlannerStatusDeps): Promise<NativePlannerStatusDto> {
  const now = (deps.now ?? (() => new Date()))();
  const [heartbeat, stats, pending] = await Promise.allSettled([deps.readHeartbeat(), deps.queueStats(), deps.countPendingNativePlans()]);
  const worker: NativePlannerWorkerView =
    heartbeat.status === "fulfilled"
      ? judgeNativePlannerHeartbeat(heartbeat.value, now.getTime())
      : { state: "UNREADABLE", reason: "The Native planner heartbeat could not be read from Redis.", startedAt: null, lastHeartbeatAt: null, ageSeconds: null, consumerRunning: null, lastSweep: null, lastSweepError: null };
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
