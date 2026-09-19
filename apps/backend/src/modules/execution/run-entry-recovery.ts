import { PrismaClient } from "@prisma/client";

import { BinanceReadOnlyClient } from "../binance/binance.client";
import { configuredExchangeClientOptions } from "./exchange-runtime-binding";

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
    const { exitCode } = await runEntryRecoveryCli(process.argv.slice(2), {
      prisma,
      recovery: new EntryRecoveryService(
        prisma,
        new BinanceReadOnlyService(new BinanceReadOnlyClient(configuredExchangeClientOptions()))
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
