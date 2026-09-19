import { prisma } from "../../plugins/prisma";
import { configuredExchangeClientOptions } from "../execution/exchange-runtime-binding";
import { logger } from "../../config/logger";
import { BinanceReadOnlyClient } from "../binance/binance.client";
import { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import { BinanceUsdMExecutionClient } from "../binance/binance-execution.client";
import { SafetyAdmissionService } from "../execution/safety-admission.service";
import { EntryLifecycleService } from "../execution/entry-lifecycle.service";
import { ExecutionService } from "../execution/execution.service";
import { ProtectionLifecycleService } from "../execution/protection-lifecycle.service";
import { CriticalAlertService } from "../execution/critical-alert.service";
import { ExecutionOrchestrator } from "../execution/execution-orchestrator";
import type {
  ReconcileTickResult,
  ReconciliationRowDiagnostic,
} from "../execution/execution-orchestrator";

/**
 * Hard ceiling on published diagnostic rows.
 *
 * The batch is already bounded by EXECUTION_RECONCILE_BATCH_SIZE (max 50), so
 * this is a second, independent bound: telemetry that rides a heartbeat must
 * not be able to grow because a limit elsewhere was raised.
 */
const MAX_PUBLISHED_DIAGNOSTIC_ROWS = 50;

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
 * How long a single pass may remain in flight before the scheduler declares
 * itself STALLED.
 *
 * Six intervals. A pass costs one Binance read per inspected execution plus a
 * handful of queries, and startup recovery deliberately takes a larger batch,
 * so a legitimately slow pass can run well past one interval. Three minutes is
 * far outside that and far inside the time a human takes to notice.
 */
export const RECONCILIATION_STALL_MS = 180_000;

/**
 * Reduces wasted work when a tick outlives its interval. It is NOT the
 * correctness mechanism — that is the advisory locks and optimistic version
 * checks inside the lifecycle services, which also protect against a second
 * worker process this flag knows nothing about.
 *
 * It is, however, load-bearing for LIVENESS, and that is what the incident on
 * the first MAINNET commissioning exposed. The flag is cleared in a `finally`,
 * so a pass that THROWS always releases it — but a pass that never settles
 * never reaches the `finally` at all. The flag then stayed true forever, every
 * later interval took the early return, and the only trace was a `debug` line
 * nobody runs in production. The worker process stayed alive, the launcher
 * still reported it ON, and an open position stopped being reconciled in
 * silence.
 *
 * Which operation hung cannot be recovered from the incident now, but it does
 * not need to be: nothing on this path was bounded. Binance reads carry an
 * AbortController deadline, but the Prisma queries do not, and neither did the
 * heartbeat that would otherwise have exposed the stall.
 *
 * The flag is therefore now accompanied by the time the pass started, which is
 * all a watchdog needs to turn silent indefinite skipping into a loud, bounded,
 * fail-closed state.
 */
let tickInFlight = false;
let tickStartedAtMs: number | null = null;
let tickLabel: string | null = null;
let lastStallReportAtMs: number | null = null;

/** Built once and reused; holds no per-execution state between calls. */
export function createExecutionOrchestrator(): ExecutionOrchestrator {
  // EXPLICIT credentials for the configured profile. The constructors would
  // otherwise read them from the environment invisibly, which is exactly the
  // ambient selection a second account would turn into a wrong-key dispatch.
  const exchange = configuredExchangeClientOptions();
  const readOnly = new BinanceReadOnlyService(new BinanceReadOnlyClient(exchange));
  const mutations = new BinanceUsdMExecutionClient({ readOnlyClient: undefined, ...exchange });
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
    // Durable execution rows and events. The orchestrator uses it for one
    // thing only: recording that reconciling an execution threw.
    executions: new ExecutionService(prisma),
  });
}

/** Which pass ran. Both count as reconciliation activity. */
export type ReconciliationTrigger = "STARTUP" | "PERIODIC";

/**
 * The last pass, for attestation.
 *
 * Module state, exactly like the in-flight fields above, and for the same
 * reason: the scheduler is a singleton per process and this describes that
 * process. Nothing here is persisted — it is published on the heartbeat the
 * worker already sends, and a restart correctly resets it to "no pass yet".
 */
let lastTickStartedAtMs: number | null = null;
let lastTickCompletedAtMs: number | null = null;
let lastTickTrigger: ReconciliationTrigger | null = null;
let lastTickResult: ReconcileTickResult | null = null;

/**
 * What this process can honestly say about its reconciliation activity.
 *
 * Deliberately SEPARATE from `reconciliationHealth()`. Health decides whether
 * the runtime may be armed over and is consumed by the attestation interlock;
 * changing what it means would change launcher readiness, and a first tick
 * that has not happened yet must not make a SAFE start look unfit. This is
 * telemetry: it reports, it gates nothing.
 */
export function reconciliationAttestation(): {
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  lastTickTrigger: ReconciliationTrigger | null;
  lastTickResult: {
    inspected: number;
    attempted: number;
    progressed: number;
    recoveryPending: number;
    reconcilableTotal: number | null;
    cursorActive: boolean;
    rows: ReconciliationRowDiagnostic[];
  } | null;
} {
  return {
    lastTickStartedAt: lastTickStartedAtMs === null ? null : new Date(lastTickStartedAtMs).toISOString(),
    lastTickCompletedAt:
      lastTickCompletedAtMs === null ? null : new Date(lastTickCompletedAtMs).toISOString(),
    lastTickTrigger,
    lastTickResult:
      lastTickResult === null
        ? null
        : {
            inspected: lastTickResult.inspected,
            // `attempted` is what the tick log calls `advanced`: dispatches,
            // not progress. Named here as the operator already reads it.
            attempted: lastTickResult.advanced,
            progressed: lastTickResult.progressed,
            recoveryPending: lastTickResult.recoveryPending,
            // The whole pool, so `inspected` can be read as the fraction of it
            // one tick covers rather than as the amount of work outstanding.
            reconcilableTotal: lastTickResult.reconcilableTotal,
            cursorActive: lastTickResult.cursorActive,
            // Already bounded by the batch size where it is built; sliced again
            // here so the published payload can never grow if that ever changes.
            // `?? []` is not defensive padding: telemetry that can throw would
            // take down the heartbeat that carries the health signal, so a
            // result missing the field publishes an empty list instead.
            rows: (lastTickResult.rows ?? []).slice(0, MAX_PUBLISHED_DIAGNOSTIC_ROWS),
          },
  };
}

/**
 * Records that a COMPLETED pass produced this result.
 *
 * Only a pass that returned without failing reaches here, so a hung pass never
 * advances the completed timestamp and a failed one never publishes counters
 * that describe work it did not finish.
 */
function recordCompletedTick(trigger: ReconciliationTrigger, result: ReconcileTickResult): void {
  if (result.failed) return;
  lastTickCompletedAtMs = Date.now();
  lastTickTrigger = trigger;
  lastTickResult = result;
}

export interface ReconciliationHealth {
  /** False once the in-flight pass has outlived RECONCILIATION_STALL_MS. */
  healthy: boolean;
  inFlight: boolean;
  /** How long the current pass has been running; 0 when none is. */
  runningForMs: number;
  label: string | null;
}

/**
 * Whether reconciliation is still making progress.
 *
 * Computed from the in-flight timestamp on every call rather than from a flag
 * some other timer has to set, so it is correct between intervals — the
 * heartbeat asks five times more often than the scheduler runs.
 */
export function reconciliationHealth(nowMs: number = Date.now()): ReconciliationHealth {
  const runningForMs = tickInFlight && tickStartedAtMs !== null ? Math.max(0, nowMs - tickStartedAtMs) : 0;
  return {
    healthy: runningForMs <= RECONCILIATION_STALL_MS,
    inFlight: tickInFlight,
    runningForMs,
    label: tickLabel,
  };
}

/**
 * The predicate the WORKER runtime attestation publisher consults.
 *
 * A worker whose reconciliation has stopped must not go on advertising itself
 * as a live runtime, because the whole purpose of that advertisement is to let
 * an operator arm new trading over it.
 */
export function isReconciliationHealthy(): boolean {
  return reconciliationHealth().healthy;
}

/**
 * Reports an interval that found a pass already running.
 *
 * Below the stall bound this is ordinary and stays at `debug`. Above it the
 * message becomes an ERROR that names the consequence, because reconciliation
 * having stopped is not something an operator should have to enable debug
 * logging to discover. Repeats are rate-limited to one per stall window so a
 * wedged worker does not bury the rest of the log.
 *
 * The guidance deliberately does not say "restart the worker". The launcher
 * offers no per-role restart, and in this exact state its two controls both
 * refuse: Stop is gated on durable safety while an execution is active, and
 * Start refuses while a launcher-owned process is alive. Naming a control that
 * declines helps nobody mid-incident, and an operator who forced one anyway
 * would be reaching for a second stack. So this states what is true — recovery
 * is needed, and a second stack is not it — and leaves the how to the operator.
 */
function reportBusyInterval(label: string, nowMs: number): void {
  const runningForMs = tickStartedAtMs === null ? 0 : Math.max(0, nowMs - tickStartedAtMs);
  if (runningForMs <= RECONCILIATION_STALL_MS) {
    logger.debug(
      { skipped: label, running: tickLabel, runningForMs },
      "Execution reconciliation tick still running — skipping this interval"
    );
    return;
  }
  if (lastStallReportAtMs !== null && nowMs - lastStallReportAtMs < RECONCILIATION_STALL_MS) return;
  lastStallReportAtMs = nowMs;
  logger.error(
    { running: tickLabel, runningForMs, stallMs: RECONCILIATION_STALL_MS },
    "Execution reconciliation is STALLED — the pass in flight has not settled, so no execution is " +
      "being reconciled and open positions and their protection orders are NOT being maintained. " +
      "This worker has withdrawn its runtime attestation, so new live activation is blocked. " +
      "Controlled worker recovery is required; do NOT start another runtime stack while the " +
      "launcher-owned runtime is still active."
  );
}

/**
 * Runs ONE pass under the single-flight guard.
 *
 * The guard is never released from the outside, and that is deliberate. A
 * stalled pass may still be inside a lifecycle service, holding a Postgres
 * advisory lock or waiting on a Binance mutation whose outcome is not yet
 * known; starting a replacement pass over the same executions is precisely the
 * race that could cancel protection twice or terminalize an execution whose
 * exchange state is still moving. So a stall is escalated and made visible —
 * it is never papered over by running another pass on top of it.
 */
async function runSingleFlight(label: string, run: () => Promise<void>): Promise<void> {
  const startedAtMs = Date.now();

  if (tickInFlight) {
    reportBusyInterval(label, startedAtMs);
    return;
  }

  tickInFlight = true;
  tickStartedAtMs = startedAtMs;
  tickLabel = label;
  // Stamped only after the busy check above, so a suppressed overlapping pass
  // is never mistaken for one that ran.
  lastTickStartedAtMs = startedAtMs;
  try {
    await run();
  } catch (error) {
    logger.error(
      { pass: label, error: error instanceof Error ? error.message.slice(0, 300) : "unknown" },
      `Execution ${label} threw — the alert pipeline is unaffected`
    );
  } finally {
    const ranForMs = Date.now() - startedAtMs;
    tickInFlight = false;
    tickStartedAtMs = null;
    tickLabel = null;
    lastStallReportAtMs = null;
    // A stall that ends is still an incident: say so, at the same level the
    // stall itself was reported, so the log shows both edges.
    if (ranForMs > RECONCILIATION_STALL_MS) {
      logger.error(
        { pass: label, ranForMs },
        "Execution reconciliation recovered after a stall — runtime attestation resumes on the next heartbeat"
      );
    }
  }
}

/** One bounded pass. Exported so tests can drive it without a timer. */
export async function runReconciliationTickOnce(
  orchestrator: ExecutionOrchestrator = createExecutionOrchestrator()
): Promise<void> {
  await runSingleFlight("reconciliation tick", async () => {
    const result = await orchestrator.runExecutionReconciliationTick();
    recordCompletedTick("PERIODIC", result);
    if (result.inspected > 0) {
      logger.info(
        {
          inspected: result.inspected,
          // `attempted` names what `advanced` always counted: dispatches, not
          // progress. `progressed` is the one that answers whether anything
          // actually moved — a stuck row now reads attempted>0 progressed=0
          // instead of looking like healthy activity.
          attempted: result.advanced,
          progressed: result.progressed,
          recoveryPending: result.recoveryPending,
        },
        "Execution reconciliation tick completed"
      );
    }
  });
}

/**
 * Startup recovery, under the SAME single-flight guard as the periodic tick.
 *
 * Recovery and a tick reconcile the same executions through the same services,
 * so they were never safe to overlap; before, only the interval was guarded and
 * a recovery still running at 30s was joined by a tick. Sharing the guard also
 * means a recovery that never settles is caught by the same watchdog instead of
 * being invisible, which matters most: recovery is what resolves an open
 * position after a restart.
 */
export async function runStartupRecoveryOnce(orchestrator: ExecutionOrchestrator): Promise<void> {
  await runSingleFlight("startup recovery", async () => {
    // Startup recovery IS a reconciliation pass — it runs the same tick with a
    // larger batch — so it counts. Distinguishing it from the periodic pass is
    // what makes "recovery ran but the interval never fired" readable.
    const result = await orchestrator.runStartupRecovery();
    recordCompletedTick("STARTUP", result);
  });
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

  void runStartupRecoveryOnce(orchestrator).catch((error) =>
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

/** Test-only: clears the overlap guard and its watchdog state between cases. */
export function resetOrchestrationTickGuardForTests(): void {
  tickInFlight = false;
  tickStartedAtMs = null;
  tickLabel = null;
  lastStallReportAtMs = null;
  // The telemetry is module state too, so it has to be cleared here or a test
  // inherits the previous one's passes and "no tick has ever run" becomes
  // unassertable.
  lastTickStartedAtMs = null;
  lastTickCompletedAtMs = null;
  lastTickTrigger = null;
  lastTickResult = null;
}
