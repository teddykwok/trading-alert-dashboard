import { prisma } from "../../plugins/prisma";
import { logger } from "../../config/logger";
import { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import { BinanceUsdMExecutionClient } from "../binance/binance-execution.client";
import { SafetyAdmissionService } from "../execution/safety-admission.service";
import { EntryLifecycleService } from "../execution/entry-lifecycle.service";
import { ProtectionLifecycleService } from "../execution/protection-lifecycle.service";
import { CriticalAlertService } from "../execution/critical-alert.service";
import { ExecutionOrchestrator } from "../execution/execution-orchestrator";

/**
 * Phase 11A.1 — production registration of the execution orchestrator.
 *
 * Owns three things, in this order:
 *
 *   A. startup recovery  — once, eagerly, before periodic work begins;
 *   B. periodic reconciliation — a bounded tick on a conservative interval;
 *   C. the orchestrator instance new-signal admission uses.
 *
 * Constructing any of this has ZERO side effects: no Binance request, no
 * database write, no timer until `start…` is called. Importing the worker with
 * the live gates closed cannot place an order — every mutation still travels
 * through the Phase 6/7 services, which refuse while their own gates are shut.
 *
 * A failing tick is logged and swallowed. Reconciliation must never take down
 * the worker that also runs the alert pipeline.
 */

/**
 * Conservative on purpose. Entry reconciliation and protection checks each cost
 * Binance GET weight, and the lifecycle is already crash-safe, so polling
 * harder buys latency at the cost of rate-limit headroom. TTL expiry resolution
 * is bounded by this interval, which is well inside a LIMIT order's lifetime.
 */
export const RECONCILIATION_INTERVAL_MS = 30_000;

/**
 * Reduces wasted work when a tick outlives its interval. It is NOT the
 * correctness mechanism — that is the advisory locks and optimistic version
 * checks inside the lifecycle services, which also protect against a second
 * worker process this flag knows nothing about.
 */
let tickInFlight = false;

/** Built once and reused; holds no per-execution state between calls. */
export function createExecutionOrchestrator(): ExecutionOrchestrator {
  const readOnly = new BinanceReadOnlyService();
  const mutations = new BinanceUsdMExecutionClient({ readOnlyClient: undefined });
  const alerts = new CriticalAlertService(prisma, async () => {
    // Critical alerts are PERSISTED here and delivered by the Phase 9
    // dispatcher. Returning false leaves the row queued rather than letting a
    // Telegram problem surface inside a protection code path.
    return false;
  });

  return new ExecutionOrchestrator({
    prisma,
    readOnly,
    admission: new SafetyAdmissionService(prisma, readOnly),
    entry: new EntryLifecycleService(prisma, readOnly, mutations),
    protection: new ProtectionLifecycleService(prisma, readOnly, mutations, alerts),
  });
}

/** One bounded pass. Exported so tests can drive it without a timer. */
export async function runReconciliationTickOnce(
  orchestrator: ExecutionOrchestrator = createExecutionOrchestrator()
): Promise<void> {
  if (tickInFlight) {
    logger.debug("Execution reconciliation tick still running — skipping this interval");
    return;
  }
  tickInFlight = true;
  try {
    const result = await orchestrator.runExecutionReconciliationTick();
    if (result.inspected > 0) {
      logger.info(
        { inspected: result.inspected, advanced: result.advanced, recoveryPending: result.recoveryPending },
        "Execution reconciliation tick completed"
      );
    }
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message.slice(0, 300) : "unknown" },
      "Execution reconciliation tick threw — the alert pipeline is unaffected"
    );
  } finally {
    tickInFlight = false;
  }
}

/**
 * Runs startup recovery once, then starts the periodic tick.
 *
 * Recovery runs BEFORE the interval so a restart reconciles persisted work
 * before anything else competes for it. A recovery failure does not prevent the
 * scheduler starting — the next tick simply tries again.
 */
export function startExecutionOrchestrationScheduler(intervalMs = RECONCILIATION_INTERVAL_MS): NodeJS.Timeout {
  const orchestrator = createExecutionOrchestrator();

  void orchestrator
    .runStartupRecovery()
    .catch((error) =>
      logger.error(
        { error: error instanceof Error ? error.message.slice(0, 300) : "unknown" },
        "Execution startup recovery failed — periodic reconciliation will retry"
      )
    );

  const timer = setInterval(() => {
    void runReconciliationTickOnce(orchestrator);
  }, intervalMs);
  timer.unref?.();

  logger.info({ intervalMs }, "Execution orchestration scheduler started");
  return timer;
}

/** Test-only: clears the overlap guard between cases. */
export function resetOrchestrationTickGuardForTests(): void {
  tickInFlight = false;
}
