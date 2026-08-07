import { PrismaClient } from "@prisma/client";
import { env } from "../../config/env";
import { configuredProfileIdentity, ensureExecutionProfile } from "./execution-profile.service";

/**
 * Execution profile bootstrap (Phase 11A.1) — operator only.
 *
 *   pnpm --filter @trading-alert-dashboard/backend execution:ensure-profile
 *
 * Creates the configured ExecutionProfile and its ExecutionSafetyPolicy if they
 * do not exist. Idempotent: running it again reports the existing rows and
 * changes nothing.
 *
 * It grants CAPACITY, never PERMISSION. The new profile is created disabled and
 * its kill switch engaged, both from the schema defaults, so nothing can be
 * admitted until an operator deliberately relaxes them in a later authorized
 * window.
 *
 * Contacts no Binance endpoint, creates no TradeExecution, and enables no gate.
 */

function line(label: string, value: string | number | boolean): void {
  console.log(`  ${label.padEnd(30)} ${String(value)}`);
}

async function main(): Promise<void> {
  const identity = configuredProfileIdentity();

  console.log("Execution profile bootstrap (Phase 11A.1) — creates capacity, never permission.");
  console.log("");

  if (identity.accountIdentifier === "") {
    console.log(
      "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER is empty.\n" +
        "Set it to a NON-SECRET operator-chosen alias (e.g. \"primary-futures\") and re-run.\n" +
        "It is never an API key, secret or account number."
    );
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  try {
    const result = await ensureExecutionProfile(prisma, identity);

    console.log(result.created ? "Profile CREATED." : "Profile already existed — nothing was changed.");
    console.log("");
    console.log("Identity");
    line("accountIdentifier", identity.accountIdentifier);
    line("environment", identity.environment);
    line("restBaseUrl", env.BINANCE_FUTURES_REST_BASE_URL);
    console.log("");
    console.log("Safety posture");
    line("profile isEnabled", result.isEnabled);
    line("killSwitchActive", result.killSwitchActive);
    console.log("");
    console.log("Capacity policy");
    line("maxOpenPositions", result.policy.maxOpenPositions);
    line("maxPendingEntries", result.policy.maxPendingEntries);
    line("maxTotalActiveTrades", result.policy.maxTotalActiveTrades);
    line("maxTotalPlannedRiskUsd", result.policy.maxTotalPlannedRiskUsd);
    line("maxTotalIsolatedMarginUsd", result.policy.maxTotalIsolatedMarginUsd);
    console.log("");
    console.log("No Binance endpoint was contacted. No execution gate was enabled.");
    console.log("The kill switch stays engaged until an explicitly authorized canary window.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`Profile bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
