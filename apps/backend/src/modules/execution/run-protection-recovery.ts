import { PrismaClient } from "@prisma/client";

import { BinanceReadOnlyClient } from "../binance/binance.client";
import { configuredExchangeClientOptions } from "./exchange-runtime-binding";

import { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import { BinanceUsdMExecutionClient } from "../binance/binance-execution.client";
import { CriticalAlertService } from "./critical-alert.service";
import { ProtectionLifecycleService } from "./protection-lifecycle.service";
import { ProtectionRecoveryService } from "./protection-recovery.service";
import { runProtectionRecoveryCli } from "./protection-recovery-cli";
import { configuredProfileIdentity, resolveExecutionProfile } from "./execution-profile.service";

/**
 * Stranded protection recovery.
 *
 *   pnpm --filter @trading-alert-dashboard/backend execution:protection-recovery \
 *     evaluate <executionId>
 *
 *   pnpm --filter @trading-alert-dashboard/backend execution:protection-recovery \
 *     recover <executionId> --confirm-protection-recovery
 *
 * `evaluate` is read-only. `recover` re-gathers its own evidence and hands the
 * execution to the existing protection lifecycle, which decides what to submit.
 * Both take exactly one execution id: there is no bulk, wildcard or force mode,
 * and no dashboard control — this operation is rare enough and consequential
 * enough to want an operator at a terminal.
 *
 * The mutation-capable client is constructed ONLY for `recover`. Running
 * `evaluate` builds nothing that can place an order, so the read-only promise
 * is a property of the wiring rather than of a code path being careful.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const prisma = new PrismaClient();
  // EXPLICIT credentials for the configured profile: no constructor may
  // reach into the environment on its own.
  const exchange = configuredExchangeClientOptions();
  const readOnly = new BinanceReadOnlyService(new BinanceReadOnlyClient(exchange));

  try {
    // BIND FIRST, before any Binance client exists. A command that cannot say
    // which account it is acting as must not read the exchange or write a row.
    const resolution = await resolveExecutionProfile(prisma, configuredProfileIdentity());
    if (!resolution.ok) {
      console.error(`REFUSED (${resolution.reasonCode}): ${resolution.message}`);
      console.error("No exchange request was made and nothing was changed.");
      process.exitCode = 1;
      return;
    }
    const executionProfileId = resolution.profile.id;

    const protection =
      argv[0] === "recover"
        ? new ProtectionLifecycleService(
            prisma,
            readOnly,
            new BinanceUsdMExecutionClient({ readOnlyClient: undefined, ...exchange }),
            new CriticalAlertService(prisma, async () => {
              // Persist only. A Telegram problem must never surface inside a
              // protection code path, exactly as the scheduler wires it.
              return false;
            })
          )
        : undefined;

    const { exitCode } = await runProtectionRecoveryCli(argv, {
      prisma,
      recovery: new ProtectionRecoveryService(prisma, readOnly, executionProfileId),
      protection,
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
