import { PrismaClient } from "@prisma/client";

import { env } from "../../config/env";
// The weight of one userTrades call, taken from the ENDPOINT TABLE that
// defines it rather than re-exported through the batch driver. Same value,
// same single source of truth -- but importing it from the driver would pull
// the driver, the executor, the bootstrap, the campaign gate, the weight
// budget and the circuit breaker into this read-only command's graph.
import { BINANCE_READ_ONLY_ENDPOINTS } from "../binance/binance.endpoints";
import { MAX_INGEST_ATTEMPTS } from "./exchange-fill-ingest-window.service";
import { executionSymbolsForProfile } from "./exchange-fill-symbol-universe";
import {
  runFillRolloutPreflightCli,
  type HorizonSource,
  type PreflightCliResult,
  type PreflightConfig,
  type PreflightState,
} from "./fill-rollout-preflight-cli";

/**
 * The process wrapper for `execution:fill-rollout-preflight`.
 *
 * ## What is built, and what is conspicuously not
 *
 * Built: a Prisma client. That is the entire graph.
 *
 * NOT built: no Binance reader, no one-window executor, no targeted executor,
 * no batch driver, no root bootstrap, no weight budget, no campaign service,
 * no circuit breaker service, no ingest-window service and no scheduler. The
 * preflight deliberately holds NO object that can write, so "read-only" is a
 * property of the graph rather than a promise about how it is used.
 *
 * The four durable facts are read by `readPreflightState` below, which issues
 * plain SELECTs. The campaign and breaker SERVICES are not reused even though
 * their read methods are pure, because constructing them would hand this
 * command `acknowledge`, `observeDispatchOutcome` and the campaign transitions
 * as well.
 */

/** The raw environment, read AFTER `env` has imported `dotenv/config`. */
export type RawEnvironment = Record<string, string | undefined>;

export const INGEST_HORIZON_KEY = "EXECUTION_FILL_INGEST_HORIZON_DAYS";

/**
 * Whether the horizon was CHOSEN or merely defaulted.
 *
 * Read from raw key presence, never from the parsed number: the schema defaults
 * an absent key to 30, so an explicit 30 and an absent key are indistinguishable
 * downstream. Importing `env` first is load-bearing -- `config/env.ts` begins
 * with `import "dotenv/config"`, so by the time this runs, a key written in
 * `.env` is already present in `process.env` exactly as an exported shell
 * variable would be. An absent key is absent in both.
 */
export function horizonSourceOf(raw: RawEnvironment): HorizonSource {
  const value = raw[INGEST_HORIZON_KEY];
  return value === undefined || value.trim() === "" ? "DEFAULT" : "EXPLICIT";
}

/** The effective configuration this process would hand a runtime. */
export function preflightConfig(raw: RawEnvironment): PreflightConfig {
  return {
    runtimeEnabled: env.EXECUTION_FILL_RUNTIME_ENABLED,
    horizonDays: env.EXECUTION_FILL_INGEST_HORIZON_DAYS,
    horizonSource: horizonSourceOf(raw),
    intervalSeconds: env.EXECUTION_FILL_BATCH_INTERVAL_SECONDS,
    maxWindowsPerTick: env.EXECUTION_FILL_BATCH_MAX_WINDOWS,
    maxUserTradesWeightPerTick: env.EXECUTION_FILL_BATCH_MAX_USER_TRADES_WEIGHT,
    sharedUserTradesWeightPerMinute: env.EXECUTION_FILL_GLOBAL_USER_TRADES_WEIGHT_PER_MINUTE,
    userTradesWeightPerRequest: BINANCE_READ_ONLY_ENDPOINTS.userTrades.weight,
  };
}

/**
 * The four durable facts, as four SELECTs and nothing else.
 *
 * No transaction, no advisory lock, no upsert. The campaign read matches the
 * gate's own notion of "live" loosely on purpose -- it reports whatever status
 * stands so an operator can see PAUSED or EXHAUSTED rather than a bare "not
 * active" -- and the ACTIVE requirement itself lives in the CLI's blocker rules.
 *
 * The attempt-exhausted predicate is the operator snapshot's, restated here
 * rather than imported so this command needs no snapshot service: pending rows
 * at or above the attempt ceiling, which neither claim path can ever reach.
 */
export async function readPreflightState(
  prisma: PrismaClient,
  executionProfileId: string
): Promise<PreflightState> {
  const [symbols, campaign, circuit, attemptExhausted] = await Promise.all([
    executionSymbolsForProfile(prisma, executionProfileId),
    prisma.historicalFillCampaign.findFirst({
      where: { executionProfileId, status: { in: ["ACTIVE", "PAUSED"] } },
      select: { status: true, maxDispatches: true, dispatchesUsed: true },
    }),
    prisma.historicalFillCircuitBreaker.findUnique({
      where: { executionProfileId },
      select: { state: true },
    }),
    prisma.exchangeFillIngestWindow.count({
      where: {
        executionProfileId,
        status: "PENDING",
        attempts: { gte: MAX_INGEST_ATTEMPTS },
      },
    }),
  ]);

  return {
    symbolUniverseCount: symbols.length,
    campaignStatus: campaign?.status ?? null,
    campaignMaxDispatches: campaign?.maxDispatches ?? null,
    campaignDispatchesUsed: campaign?.dispatchesUsed ?? null,
    // An absent breaker row is a profile that has never tripped: CLOSED.
    circuitState: circuit?.state ?? "CLOSED",
    attemptExhaustedCount: attemptExhausted,
  };
}

export async function runFillRolloutPreflightCommand(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result: PreflightCliResult = await runFillRolloutPreflightCli(process.argv.slice(2), {
      prisma,
      config: preflightConfig(process.env),
      readState: (executionProfileId) => readPreflightState(prisma, executionProfileId),
    });
    process.exitCode = result.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}
