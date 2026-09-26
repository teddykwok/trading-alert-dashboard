import { randomUUID } from "node:crypto";

import { logger } from "../../config/logger";
import { prisma } from "../../plugins/prisma";
import { marginPlanServiceFromRuntime } from "../binance/binance-margin-plan.service";
import {
  bindConfiguredExchangeRuntime,
  profileProjectionOf,
} from "../execution/exchange-runtime-binding";
import { ExecutionService } from "../execution/execution.service";
import { SelectedPlanExecutor } from "../execution/selected-plan-executor";
import { ExtremeRRService } from "../extreme-rr/extreme-rr.service";
import { createRuntimeAttestationPublisher } from "../runtime/runtime-attestation";
import {
  createAttestationRedisClient,
  describeRedisFailure,
} from "../runtime/attestation-redis";
import {
  createExecutionOrchestrator,
  isReconciliationHealthy,
  reconciliationAttestation,
  startExecutionOrchestrationScheduler,
} from "./execution-orchestration.scheduler";
import { startHistoricalFillWorkerRuntime } from "./historical-fill-worker-runtime";
import {
  SelectedPlanAdoptionService,
  startSelectedPlanAdoptionScheduler,
} from "./selected-plan-adoption.service";

/**
 * Phase 11E — THE account execution runtime. One process, one account.
 *
 * ## Why this file exists
 *
 * Everything here used to live inside `vision-analysis.worker.ts`, behind the
 * 11D startup barrier. That was correct for one account and wrong for two:
 * the generic vision and extreme-RR queues are BullMQ competing consumers, so
 * running two copies of that worker would have made the account that trades a
 * signal whichever process happened to dequeue the generic job -- and the other
 * account would never have learned the opportunity existed.
 *
 * So the responsibilities are split by process rather than by profile inside
 * one process:
 *
 *   vision-analysis.worker.ts   ONE process, no account, generic analysis
 *   execution.worker.ts         ONE process PER account, this file
 *
 * This process consumes NO BullMQ queue. It discovers the durable plans the
 * generic worker produced, and decides about them as its own account. Another
 * account's execution worker discovers the SAME plans independently and reaches
 * its own verdict, which may legitimately differ.
 *
 * ## One runtime, deliberately
 *
 * Exactly one `bindConfiguredExchangeRuntime` call. There is no map of
 * runtimes, no profile parameter, and no way for a job, a request or an
 * operator to name an account: the identity comes from this process's
 * configuration and nowhere else. Two accounts means two of these processes,
 * each with its own environment.
 *
 * Which is also why the module-level scheduler state in
 * `execution-orchestration.scheduler` needs no change: Node module state is
 * per-process heap, and there is one profile per process.
 */

async function startExecutionRuntime(): Promise<void> {
  const bound = await bindConfiguredExchangeRuntime(prisma);
  if (!bound.ok) {
    // FAIL CLOSED. The reason code only -- never a key, a secret or an alias.
    // Nothing below has run, so no signed client exists, no orchestration is
    // scheduled, no adoption is polling and no attestation is published. An
    // operator cannot arm over a process that never bound an account.
    logger.error(
      { reasonCode: bound.reasonCode },
      "Account-bound runtime could not be established - this execution worker is NOT running"
    );
    return;
  }

  const runtime = bound.runtime;
  const boundProfile = profileProjectionOf(runtime);
  const workerId = `execution:${randomUUID()}`;

  const executor = new SelectedPlanExecutor({
    prisma,
    // Signed: the planner reads account summary and leverage brackets, so it
    // takes the BOUND runtime's credentials.
    marginPlanner: marginPlanServiceFromRuntime(runtime),
    executions: new ExecutionService(prisma),
    orchestrator: createExecutionOrchestrator(runtime),
    boundProfile,
  });

  // Phase 11A.1: startup execution recovery, then bounded periodic
  // reconciliation. Every mutation still travels through the Phase 6/7 gates,
  // so with the live gates closed this registers work that dispatches nothing.
  const orchestrationTimer = startExecutionOrchestrationScheduler(runtime);

  // Phase 11E: the replacement for the generic queue hop. Bounded, single
  // flight, and claimed per (plan, profile) BEFORE anything signed happens.
  const adoptionTimer = startSelectedPlanAdoptionScheduler(
    new SelectedPlanAdoptionService({
      prisma,
      boundProfile,
      executor,
      // READ-ONLY use: `getForAlert` returns the persisted plan. This process
      // never generates one -- that is the generic worker's job.
      plans: new ExtremeRRService(prisma),
      workerId,
    })
  );

  // Phase 9: historical fill ingestion, which is account-specific and
  // therefore belongs to this process. Dormant unless
  // EXECUTION_FILL_RUNTIME_ENABLED=true, and dormant means it builds nothing
  // at all -- no timer, no Prisma-backed service, no Binance client, no
  // campaign and no bootstrap.
  const historicalFillRuntime = startHistoricalFillWorkerRuntime(runtime);

  // Phase 12.4D-A.1: the execution WORKER attestation, now owned HERE rather
  // than by the generic worker. Activation requires one fresh BACKEND and one
  // fresh WORKER for the same account identity, and after 11E only an
  // account-bound process can be that WORKER. The heartbeat runs on its OWN
  // bounded connection, never a BullMQ one.
  const attestationRedis = createAttestationRedisClient({
    onError: (detail) => logger.error({ detail }, "Runtime attestation Redis connection error"),
  });

  const runtimeAttestation = createRuntimeAttestationPublisher({
    role: "WORKER",
    redis: attestationRedis.redis,
    // Phase 11F: the first beat waits for a writable link instead of racing
    // it. Without this a healthy worker logged a heartbeat failure on boot.
    waitUntilReady: attestationRedis.waitUntilReady,
    // A worker whose reconciliation has stalled -- or which never started
    // orchestrating at all -- stops attesting, so the fail-closed interlock
    // refuses to arm over it. This gates NEW activation only.
    healthy: isReconciliationHealthy,
    reconciliation: reconciliationAttestation,
    onWithdraw: () =>
      logger.error(
        {},
        "Runtime attestation WITHDRAWN — this execution worker is no longer fit to be counted " +
          "as a live runtime, so new live activation is blocked. " +
          "Controlled worker recovery is required; do NOT start another runtime stack " +
          "while this one is still active."
      ),
    onError: (error) =>
      logger.error({ detail: describeRedisFailure(error) }, "Runtime attestation heartbeat failed"),
  });
  runtimeAttestation.start();

  logger.info("Account execution worker started — orchestration and plan adoption running");

  // Owns ONLY what it created. It must never close the generic worker's queues,
  // and the generic worker must never withdraw this attestation.
  process.on("SIGTERM", async () => {
    await runtimeAttestation.stop();
    await attestationRedis.close();
    clearInterval(orchestrationTimer);
    clearInterval(adoptionTimer);
    // Before the shared Prisma client goes away: this stops future historical
    // ticks and then waits for one already running, so a claim and its
    // transaction are never torn out mid-flight.
    await historicalFillRuntime.stop();
    await prisma.$disconnect();
    process.exit(0);
  });
}

void startExecutionRuntime().catch((error) => {
  logger.error(
    { error: error instanceof Error ? error.message.slice(0, 300) : "unknown" },
    "Account execution worker bootstrap threw - execution is NOT running"
  );
});

/**
 * A process that never bound still needs to exit cleanly on a signal, and must
 * withdraw nothing it never published.
 */
process.on("SIGINT", () => {
  process.exit(0);
});
