import { PrismaClient } from "@prisma/client";

import { env } from "../../config/env";
import { ExchangeFillIngestWindowService } from "./exchange-fill-ingest-window.service";
import { ExchangeFillRootBootstrap } from "./exchange-fill-root-bootstrap.service";
import { runFillBootstrapCli, type FillBootstrapCliResult } from "./fill-bootstrap-cli";

/**
 * The process wrapper for `execution:fill-bootstrap-roots`.
 *
 * Owns exactly what a process owns -- the Prisma client, the argv slice and the
 * exit code -- so the CLI module stays a pure function of its arguments and its
 * dependencies, matching every other execution command in this module.
 *
 * ## The composition IS the safety property
 *
 * Four things are constructed here and there is no fifth: a client, the window
 * writer, the root bootstrap, and the CLI. There is no campaign service, no
 * admission service, no shared weight budget, no circuit breaker, no one-window
 * executor, no Binance reader and no scheduler. A run of this command therefore
 * cannot spend a dispatch, reserve weight, trip a latch or reach the exchange,
 * because no object capable of any of those is ever built.
 *
 * That is why the horizon arrives from `env` rather than from argv, and why the
 * bootstrap is constructed WITHOUT a `bindProfile` override: the account is
 * whatever this process is configured and bound to, and nothing an operator can
 * type at a terminal changes it.
 */
export async function runFillBootstrapRootsCommand(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result: FillBootstrapCliResult = await runFillBootstrapCli(process.argv.slice(2), {
      bootstrap: new ExchangeFillRootBootstrap({
        prisma,
        work: new ExchangeFillIngestWindowService(prisma),
      }),
      horizonDays: env.EXECUTION_FILL_INGEST_HORIZON_DAYS,
    });
    process.exitCode = result.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}
