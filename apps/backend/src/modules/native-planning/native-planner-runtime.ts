import { createHeartbeatPublisher, type HeartbeatPublisher, type HeartbeatStore, type NativePlannerSweepView } from "./native-planner-heartbeat";
import type { NativePlanJobOutcome, NativePlanRecoverySummary } from "./native-plan-processor";

/**
 * The Native planner worker's LIFECYCLE, with every machine dependency
 * injected (BullMQ worker, Redis heartbeat store, database, clock), so start
 * and shutdown are behaviour-tested without a real Redis or Postgres.
 *
 * What it adds around the unchanged planning semantics (processor + sweep):
 *  - clear identity logs: role, queue, startup recovery sweep, shutdown;
 *  - a Redis heartbeat the generic backend's read-only status can read;
 *  - an IDEMPOTENT graceful shutdown: stop sweeping, close the BullMQ worker
 *    (it finishes its in-flight job and releases its connection), withdraw the
 *    heartbeat, close the queue and the connection, disconnect the database.
 *
 * It never decides anything about plans: the processor and the recovery sweep
 * are passed in exactly as they were.
 */

export const NATIVE_PLANNER_ROLE_NAME = "native-planner";

export interface NativePlannerWorkerHandle {
  isRunning(): boolean;
  close(): Promise<void>;
}

export interface NativePlannerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface NativePlannerRuntimeDeps {
  readonly queueName: string;
  readonly pid: number;
  /** Creates THE one BullMQ consumer for the dedicated Native queue, wired to `process`. */
  readonly createWorker: (process: (alertId: string) => Promise<NativePlanJobOutcome>) => NativePlannerWorkerHandle;
  readonly processJob: (alertId: string) => Promise<NativePlanJobOutcome>;
  readonly sweep: () => Promise<NativePlanRecoverySummary>;
  readonly heartbeatStore: HeartbeatStore;
  readonly closeQueue: () => Promise<void>;
  readonly closeConnection: () => Promise<void>;
  readonly disconnectDb: () => Promise<void>;
  readonly logger: NativePlannerLogger;
  readonly sweepIntervalMs: number;
  readonly heartbeatIntervalMs?: number;
  readonly now?: () => Date;
}

export interface NativePlannerRuntime {
  readonly heartbeat: HeartbeatPublisher;
  /** Idempotent: a second signal waits for the first shutdown. Resolves to the exit code. */
  shutdown(signal: string): Promise<number>;
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

export async function startNativePlannerRuntime(deps: NativePlannerRuntimeDeps): Promise<NativePlannerRuntime> {
  const now = deps.now ?? (() => new Date());
  const identity = { role: NATIVE_PLANNER_ROLE_NAME, queue: deps.queueName, nativeExecutionEnabled: false };
  deps.logger.info(identity, "Native planner worker starting (PLANNING ONLY / NATIVE EXECUTION DISABLED)");

  const worker = deps.createWorker(async (alertId) => {
    const outcome = await deps.processJob(alertId);
    deps.logger.info({ ...identity, alertId, outcome }, "Native auto-planning job finished");
    return outcome;
  });

  const heartbeat = createHeartbeatPublisher({
    store: deps.heartbeatStore,
    queue: deps.queueName,
    pid: deps.pid,
    consumerRunning: () => worker.isRunning(),
    now,
    intervalMs: deps.heartbeatIntervalMs,
    log: (line) => deps.logger.warn(identity, line),
  });
  await heartbeat.start();

  const runSweep = async (phase: NativePlannerSweepView["phase"]): Promise<void> => {
    try {
      const summary = await deps.sweep();
      const view: NativePlannerSweepView = {
        at: now().toISOString(),
        phase,
        inspected: summary.inspected,
        recovered: summary.recovered,
        alreadyQueued: summary.alreadyQueued,
        closedAsError: summary.closedAsError,
        queueUnavailable: summary.queueUnavailable,
      };
      heartbeat.recordSweep(view);
      // The startup sweep is always logged (an operator must be able to see it ran, even when it found nothing);
      // periodic sweeps only when they inspected something.
      if (phase === "STARTUP" || summary.inspected > 0) {
        deps.logger.info({ ...identity, ...view, outcomes: summary.outcomes.slice(0, 25) }, `Native planner ${phase === "STARTUP" ? "startup" : "periodic"} recovery sweep`);
      }
    } catch (error) {
      heartbeat.recordSweep({ errorName: errorName(error) });
      deps.logger.warn({ ...identity, phase, error: errorName(error) }, "Native planner recovery sweep failed (retried next tick)");
    }
    await heartbeat.publish();
  };

  await runSweep("STARTUP");
  const sweepTimer = setInterval(() => void runSweep("PERIODIC"), deps.sweepIntervalMs);
  sweepTimer.unref?.();
  deps.logger.info(identity, "Native planner worker started");

  let stopping: Promise<number> | null = null;
  return {
    heartbeat,
    shutdown(signal) {
      if (stopping) return stopping;
      stopping = (async () => {
        deps.logger.info({ ...identity, signal }, "Native planner worker stopping");
        clearInterval(sweepTimer);
        let code = 0;
        const step = async (name: string, run: () => Promise<void>) => {
          try {
            await run();
          } catch (error) {
            code = 1;
            deps.logger.warn({ ...identity, step: name, error: errorName(error) }, "Native planner shutdown step failed");
          }
        };
        // Order matters: the consumer first (finishes its in-flight job, takes no new one), then the heartbeat
        // (only once the consumer is gone may the worker stop claiming to be alive), then the shared connections.
        await step("worker", () => worker.close());
        await step("heartbeat", () => heartbeat.stop());
        await step("queue", () => deps.closeQueue());
        await step("connection", () => deps.closeConnection());
        await step("database", () => deps.disconnectDb());
        deps.logger.info({ ...identity, signal, exitCode: code }, "Native planner worker stopped");
        return code;
      })();
      return stopping;
    },
  };
}
