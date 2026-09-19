import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import { env } from "../../config/env";
import { ExchangeFillIngestWindowService } from "./exchange-fill-ingest-window.service";
import { ExchangeFillLedgerService } from "./exchange-fill-ledger.service";
import { ExchangeFillOneWindowExecutor } from "./exchange-fill-one-window-executor.service";
import { HistoricalFillCampaignService } from "./historical-fill-campaign.service";
import { HistoricalFillCircuitBreakerService } from "./historical-fill-circuit-breaker.service";
import { HistoricalFillTargetedCanary } from "./historical-fill-targeted-canary.service";
import { HistoricalFillWeightBudgetService } from "./historical-fill-weight-budget.service";
import { runFillWindowCanaryCli, type CanaryCliResult } from "./fill-window-canary-cli";

/**
 * The process wrapper for `execution:fill-window-canary`.
 *
 * ## What is built, and what is conspicuously not
 *
 * Built: the window service, the ledger, the read-only reader, the one-window
 * executor, the campaign service, the shared weight budget and the circuit
 * breaker -- every protection the scheduled path has, on one Prisma client.
 *
 * NOT built: `ExchangeFillRootBootstrap`, `HistoricalFillBatchDriver` and the
 * scheduler. This command cannot materialize roots, cannot loop over windows
 * and cannot schedule anything, because none of those objects exists in the
 * graph it is handed.
 *
 * ## Why the runtime flag is not read here
 *
 * `EXECUTION_FILL_RUNTIME_ENABLED` decides whether a worker dispatches on its
 * own. This is a person running one command, so it is deliberately not
 * consulted -- requiring it would mean switching the automatic scheduler on in
 * order to make a single supervised request.
 *
 * The weight ceiling IS read, and is passed through possibly-undefined on
 * purpose: the schema leaves it optional while the runtime is off, and the
 * canary refuses rather than invents one.
 */
export async function runFillWindowCanaryCommand(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const work = new ExchangeFillIngestWindowService(prisma);
    const ledger = new ExchangeFillLedgerService(prisma);
    const reader = new BinanceReadOnlyService();

    const result: CanaryCliResult = await runFillWindowCanaryCli(process.argv.slice(2), {
      canary: new HistoricalFillTargetedCanary({
        prisma,
        executor: new ExchangeFillOneWindowExecutor({ prisma, reader, ledger, work }),
        campaigns: new HistoricalFillCampaignService(prisma),
        weightBudget: new HistoricalFillWeightBudgetService(prisma),
        circuitBreaker: new HistoricalFillCircuitBreakerService(prisma),
        weightCap: env.EXECUTION_FILL_GLOBAL_USER_TRADES_WEIGHT_PER_MINUTE,
      }),
      // Unique per invocation, and readable as an operator action in
      // `claimOwner`. Never a pid, a hostname or anything from a credential.
      workerId: `historical-fill-canary:${randomUUID()}`,
    });
    process.exitCode = result.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}
