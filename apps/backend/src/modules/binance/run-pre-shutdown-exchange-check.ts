// Phase 11I.1 -- MUST be the first import in this file.
//
// Static imports are hoisted and evaluated in source order. The generated
// Prisma client loads the repository `.env` at its own module initialization,
// and neither loader overrides what is already set -- so an import above this
// line would hand this process the repository's account instead of the one
// DOTENV_CONFIG_PATH names, with every log line reporting the wrong one.
import "../../config/bootstrap-account";

import { PrismaClient } from "@prisma/client";

import { env } from "../../config/env";
import {
  bindConfiguredExchangeRuntime,
  exchangeClientOptionsOf,
} from "../execution/exchange-runtime-binding";
import { BinanceReadOnlyService } from "./binance-read-only.service";
import { BinanceReadOnlyClient } from "./binance.client";
import {
  collectPreShutdownCounts,
  evaluatePreShutdownExchange,
  renderPreShutdownReport,
} from "./pre-shutdown-exchange-check";

/**
 * Pre-shutdown exchange check for ONE account.
 *
 *   DOTENV_CONFIG_PATH=<account file> \
 *     pnpm --filter @trading-alert-dashboard/backend binance:pre-shutdown-check
 *
 * Positively proves the exchange holds nothing before an intentional runtime
 * shutdown. Three ACCOUNT-WIDE allowlisted GETs and nothing else: it cannot
 * place, cancel, close or configure anything, and it writes nothing to the
 * database.
 *
 * It reports COUNTS. No balance, no symbol, no order id, no quantity, no
 * account identifier -- a shutdown decision needs to know whether the book is
 * empty, not what is in it.
 *
 * Exit 0 means PASS. Every other outcome, including a read it could not make,
 * exits non-zero.
 */
async function main(): Promise<void> {
  if (!env.BINANCE_READ_ONLY_ENABLED) {
    console.error("REFUSED: BINANCE_READ_ONLY_ENABLED is false, so no read-only connector exists.");
    console.error("No exchange client was constructed and no request was made.");
    process.exitCode = 1;
    return;
  }

  // BIND FIRST. Every read below is SIGNED, so read-only does not mean
  // account-independent: the account has to be proven before asking.
  const prisma = new PrismaClient();
  try {
    const bound = await bindConfiguredExchangeRuntime(prisma);
    if (!bound.ok) {
      console.error(`REFUSED (${bound.reasonCode}): ${bound.message}`);
      console.error("No exchange client was constructed and no request was made.");
      process.exitCode = 1;
      return;
    }

    const service = new BinanceReadOnlyService(
      new BinanceReadOnlyClient(exchangeClientOptionsOf(bound.runtime))
    );

    // Account-wide, all three. No symbol is passed anywhere: the completeness
    // of this proof must not depend on a symbol list being complete.
    const counts = await collectPreShutdownCounts({
      getPositionRisk: () => service.getPositionRisk(),
      getOpenOrders: () => service.getOpenOrders(),
      getOpenAlgoOrdersAccountWide: () => service.getOpenAlgoOrdersAccountWide(),
    });
    const verdict = evaluatePreShutdownExchange(counts);
    for (const line of renderPreShutdownReport(counts, verdict)) console.log(line);
    if (!verdict.pass) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  // Reason TYPE only: a Binance error message can carry an endpoint, and a
  // Prisma one can carry a connection string.
  console.error(`PRE-SHUTDOWN CHECK FAILED (${error instanceof Error ? error.name : "unknown"})`);
  console.error("Treat this as BLOCKED: nothing about the exchange was proved.");
  process.exitCode = 1;
});
