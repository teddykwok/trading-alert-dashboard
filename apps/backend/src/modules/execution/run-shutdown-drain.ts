import { PrismaClient } from "@prisma/client";

import { BinanceReadOnlyClient } from "../binance/binance.client";
import {
  bindConfiguredExchangeRuntime,
  exchangeClientOptionsOf,
  profileProjectionOf,
} from "./exchange-runtime-binding";

import { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import { BinanceUsdMExecutionClient } from "../binance/binance-execution.client";
import { EntryLifecycleService } from "./entry-lifecycle.service";
import { TradingControlService } from "../operator/trading-control.service";
import { ShutdownDrainService } from "./shutdown-drain.service";
import { runShutdownDrainCli } from "./shutdown-drain-cli";
import type { ShutdownPosture } from "./shutdown-drain";

/**
 * Prepare the runtime for an intentional shutdown.
 *
 *   pnpm --filter @trading-alert-dashboard/backend execution:prepare-shutdown evaluate
 *   pnpm --filter @trading-alert-dashboard/backend execution:prepare-shutdown drain \
 *     --confirm-cancel-pending-entries
 *
 * `evaluate` is read-only. `drain` cancels Teddy-owned pending ENTRY orders
 * through the existing entry lifecycle and then reports whether the runtime may
 * be stopped. It never closes a position and never touches a protection order.
 *
 * The mutation-capable client is constructed ONLY for `drain`, so running
 * `evaluate` builds nothing that can reach the exchange with a write.
 *
 * LIMITATION: this makes an INTENTIONAL shutdown safe. It cannot help if the
 * operating system suspends or kills the process first — closing the lid
 * without running this gives it no opportunity to execute.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
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

    const entry =
      argv[0] === "drain"
        ? new EntryLifecycleService(
            prisma,
            new BinanceReadOnlyService(new BinanceReadOnlyClient(exchange)),
            new BinanceUsdMExecutionClient({ readOnlyClient: undefined, ...exchange })
          )
        : undefined;

    /**
     * The posture comes from the SAME status contract the dashboard and the
     * launcher read. Nothing here derives a second opinion about whether the
     * system is safe.
     */
    const readPosture = async (): Promise<ShutdownPosture> => {
      try {
        const status = await new TradingControlService(prisma).readStatus();
        return {
          systemState: status.systemState,
          authorizationState: status.authorization?.state ?? null,
          manualInterventionCount: status.manualIntervention.count,
          openPositionCount: status.capacity.open,
        };
      } catch {
        // Message deliberately dropped: it can carry a connection string. An
        // unreadable posture refuses rather than being assumed safe.
        return {
          systemState: null,
          authorizationState: null,
          manualInterventionCount: null,
          openPositionCount: null,
        };
      }
    };

    const { exitCode } = await runShutdownDrainCli(argv, {
      prisma,
      drain: new ShutdownDrainService(prisma, boundProfile.executionProfileId),
      readPosture,
      entry,
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
