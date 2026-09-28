// Phase 11F.1 -- MUST be the first import in this file.
//
// Static imports are hoisted and evaluated in source order. The generated
// Prisma client loads the repository `.env` at its own module initialization,
// and neither loader overrides what is already set -- so an import above this
// line would hand this process the repository's account instead of the one
// DOTENV_CONFIG_PATH names, with every log line reporting the wrong one.
import "../../config/bootstrap-account";

import { PrismaClient } from "@prisma/client";

import { BinanceReadOnlyClient } from "../binance/binance.client";
import {
  bindConfiguredExchangeRuntime,
  exchangeClientOptionsOf,
  profileProjectionOf,
} from "./exchange-runtime-binding";

import { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import { EntryRecoveryService } from "./entry-recovery.service";
import { runEntryRecoveryCli } from "./entry-recovery-cli";

/**
 * Stuck-entry recovery.
 *
 *   pnpm --filter @trading-alert-dashboard/backend execution:entry-recovery \
 *     evaluate <executionId>
 *
 *   pnpm --filter @trading-alert-dashboard/backend execution:entry-recovery \
 *     recover <executionId> --confirm-recover-proven-absent
 *
 * `evaluate` is read-only. `recover` re-gathers its own evidence and writes only
 * when every absence check passes. Both take exactly one execution id: there is
 * no bulk, wildcard or force mode, and no dashboard control — this operation is
 * rare enough and consequential enough to want an operator at a terminal.
 *
 * Only signed GETs ever reach Binance from here; the mutation client is not
 * imported, so this command is structurally incapable of placing or cancelling
 * an order.
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // BIND FIRST, and bind ONCE. No Binance client exists yet, and no row has
    // been read: a command that cannot prove which account it is must not do
    // either. The credentials below and the profile this command acts on are
    // the two halves of this one binding.
    const bound = await bindConfiguredExchangeRuntime(prisma);
    if (!bound.ok) {
      console.error(`REFUSED (${bound.reasonCode}): ${bound.message}`);
      console.error("No exchange client was constructed and nothing was changed.");
      process.exitCode = 1;
      return;
    }
    const runtime = bound.runtime;
    const exchange = exchangeClientOptionsOf(runtime);
    const boundProfile = profileProjectionOf(runtime);

    const { exitCode } = await runEntryRecoveryCli(process.argv.slice(2), {
      prisma,
      recovery: new EntryRecoveryService(
        prisma,
        new BinanceReadOnlyService(new BinanceReadOnlyClient(exchange)),
        boundProfile
      ),
    });
    process.exitCode = exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  // Sanitized: the message only, never a stack carrying request material.
  console.error(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
