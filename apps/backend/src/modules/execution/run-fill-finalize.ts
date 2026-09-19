import { PrismaClient } from "@prisma/client";

import { ExchangeFillIngestWindowService } from "./exchange-fill-ingest-window.service";
import { runFillFinalizeExhaustedCli, type FinalizeCliResult } from "./fill-finalize-exhausted-cli";

/**
 * The process wrapper for `execution:fill-window-finalize-exhausted`.
 *
 * ## What is built, and what is conspicuously not
 *
 * Built: a Prisma client and the ingest-window service. That is the whole
 * graph, and it is the whole point.
 *
 * NOT built: no Binance reader, no one-window executor, no batch driver, no
 * root bootstrap, no weight budget, no campaign service, no circuit breaker and
 * no scheduler. This command cannot reach the exchange, cannot spend request
 * weight, cannot move a campaign, cannot touch the latch and cannot materialize
 * a root -- because no object capable of any of those is ever constructed.
 *
 * The runtime gate is deliberately not consulted: a person running one bounded
 * database repair should not have to switch an automatic scheduler on to do it,
 * and this command starts nothing either way.
 */
export async function runFillWindowFinalizeExhaustedCommand(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result: FinalizeCliResult = await runFillFinalizeExhaustedCli(process.argv.slice(2), {
      prisma,
      work: new ExchangeFillIngestWindowService(prisma),
    });
    process.exitCode = result.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}
