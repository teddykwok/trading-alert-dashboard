import { randomUUID } from "node:crypto";

import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma } from "../../plugins/prisma";
import { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import { HistoricalFillBatchDriver } from "../execution/exchange-fill-batch-driver.service";
import { ExchangeFillLedgerService } from "../execution/exchange-fill-ledger.service";
import { ExchangeFillIngestWindowService } from "../execution/exchange-fill-ingest-window.service";
import { ExchangeFillOneWindowExecutor } from "../execution/exchange-fill-one-window-executor.service";
import { ExchangeFillRootBootstrap } from "../execution/exchange-fill-root-bootstrap.service";
import { HistoricalFillWeightBudgetService } from "../execution/historical-fill-weight-budget.service";
import { HistoricalFillCampaignGate } from "../execution/historical-fill-campaign-gate.service";
import {
  createHistoricalFillScheduler,
  historicalFillIntervalMs,
  type HistoricalFillSchedulerHandle,
} from "./historical-fill.scheduler";

/**
 * Where the historical-fill runtime is finally composed and started.
 *
 * This is the FIRST production start call-site in the whole feature, and it is
 * deliberately the only one: the worker calls this once, and nothing else may.
 *
 * ## Dormant by default
 *
 * `EXECUTION_FILL_RUNTIME_ENABLED` defaults false, and this returns before
 * constructing anything at all. A disabled worker therefore mints no identity,
 * builds no Prisma-backed service, opens no Binance client and creates no
 * timer -- so it never touches the historical tables, which is what makes this
 * safe to deploy while those migrations are still undeployed.
 *
 * ## No leader election, on purpose
 *
 * Several worker processes may each host a scheduler. That is allowed now:
 * window correctness comes from the claim CAS and its `attempts` fencing
 * token, and exchange request production is bounded across processes by the
 * shared Postgres weight budget. Electing one worker would add a failure mode
 * without adding a guarantee either of those does not already provide.
 */

/** Identity for one enabled runtime. Diagnostics and `claimOwner`, nothing more. */
export function createHistoricalFillWorkerId(): string {
  // A uuid, because it must be unique across machines without coordinating.
  // NOT a pid (reused after a restart), NOT a hostname (identical across
  // replicas), NOT a timestamp (two processes start in the same millisecond),
  // and never an account identifier or anything derived from a credential.
  // `claimOwner` is an unbounded TEXT column, so the readable prefix costs
  // nothing.
  return `historical-fill:${randomUUID()}`;
}

export interface HistoricalFillWorkerRuntime {
  status: "DISABLED" | "RUNNING";
  /** Present only while running; the identity every tick carries. */
  workerId?: string;
  /** Stops future ticks and awaits one already in flight. Safe to call twice. */
  stop: () => Promise<void>;
}

export interface HistoricalFillWorkerRuntimeOptions {
  /** Defaults to the configured gate; injectable so a test need not reload env. */
  enabled?: boolean;
  /** Injectable so tests assert on a deterministic identity. */
  workerId?: string;
  /** Injectable purely so a test can observe composition without a real graph. */
  createScheduler?: typeof createHistoricalFillScheduler;
}

/**
 * Starts the historical-fill runtime, or reports that it is dormant.
 *
 * Everything historical is built INSIDE the enabled branch. The gate is read
 * once, before any construction, so "disabled did nothing" is a property of
 * control flow rather than a promise about what those objects would have done.
 */
export function startHistoricalFillWorkerRuntime(
  options: HistoricalFillWorkerRuntimeOptions = {}
): HistoricalFillWorkerRuntime {
  const enabled = options.enabled ?? env.EXECUTION_FILL_RUNTIME_ENABLED;

  if (!enabled) {
    logger.info("Historical fill runtime disabled (EXECUTION_FILL_RUNTIME_ENABLED=false)");
    return { status: "DISABLED", stop: async () => undefined };
  }

  // Required by env validation whenever the gate is open; asserted here too
  // because a runtime that reached this line without a ceiling would contend
  // for a shared row without knowing what it is allowed to spend.
  const globalUserTradesWeightPerMinute = env.EXECUTION_FILL_GLOBAL_USER_TRADES_WEIGHT_PER_MINUTE;
  if (globalUserTradesWeightPerMinute === undefined) {
    throw new Error(
      "EXECUTION_FILL_GLOBAL_USER_TRADES_WEIGHT_PER_MINUTE is required when the historical fill runtime is enabled"
    );
  }

  const workerId = options.workerId ?? createHistoricalFillWorkerId();

  // ONE dependency graph for the whole enabled lifetime. Every one of these is
  // stateless with respect to a batch -- they hold the shared Prisma client and
  // a Binance client whose construction performs no request -- so rebuilding
  // them each interval would open clients for nothing. Nothing here has a
  // documented per-request lifecycle.
  //
  // The SHARED Prisma singleton, never a second pool: `plugins/prisma` exports
  // it precisely so this worker process can reuse it.
  const work = new ExchangeFillIngestWindowService(prisma);
  const ledger = new ExchangeFillLedgerService(prisma);
  const reader = new BinanceReadOnlyService();
  const executor = new ExchangeFillOneWindowExecutor({ prisma, reader, ledger, work });
  const bootstrap = new ExchangeFillRootBootstrap({ prisma, work });
  const weightBudget = new HistoricalFillWeightBudgetService(prisma);
  // The campaign gate, on the SAME Prisma singleton -- no second pool, no
  // scheduler of its own, and no worker-side control mutation: it reads the
  // campaign before the bootstrap and may only move an ACTIVE campaign to
  // COMPLETED once the queue is drained. Starting, pausing, resuming and
  // aborting stay entirely with the operator CLI.
  const campaigns = new HistoricalFillCampaignGate({ prisma });
  const driver = new HistoricalFillBatchDriver({ bootstrap, executor, weightBudget, campaigns });

  const scheduler = (options.createScheduler ?? createHistoricalFillScheduler)({
    // The runner owns the call; this only supplies what it may build.
    createDriver: () => driver,
    workerId,
    horizonDays: env.EXECUTION_FILL_INGEST_HORIZON_DAYS,
    maxWindows: env.EXECUTION_FILL_BATCH_MAX_WINDOWS,
    maxUserTradesWeight: env.EXECUTION_FILL_BATCH_MAX_USER_TRADES_WEIGHT,
    globalUserTradesWeightPerMinute,
    intervalMs: historicalFillIntervalMs(),
  });

  const handle: HistoricalFillSchedulerHandle = scheduler.start();

  return {
    status: "RUNNING",
    workerId,
    stop: async () => {
      // Close the door, then wait for a pass already inside it. The worker
      // disconnects the shared Prisma client right after this resolves.
      if (handle.status === "RUNNING") await handle.stopAndDrain();
    },
  };
}
