import { PrismaClient } from "@prisma/client";

import { env } from "../../config/env";
import { bindConfiguredExchangeRuntime } from "../execution/exchange-runtime-binding";
import { accountConnectionFromRuntime } from "./binance-account-connection.service";

/**
 * Binance HEDGE MODE setup (Phase 10) — operator only.
 *
 *   pnpm --filter @trading-alert-dashboard/backend binance:set-hedge-mode
 *   pnpm --filter @trading-alert-dashboard/backend binance:set-hedge-mode --confirm-set-hedge-mode
 *
 * Without the flag this is a DRY RUN: it reports what it would do and sends no
 * POST. Two independent things must both be true before anything is dispatched:
 *
 *   1. BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED=true  (environment)
 *   2. --confirm-set-hedge-mode                      (explicit operator intent)
 *
 * The mutation itself additionally requires, checked against the live account:
 * zero non-zero positions and zero open orders ACROSS THE WHOLE USDⓈ-M account
 * — position mode is account-wide, so an unrelated symbol still blocks it.
 *
 * This command can only ever request HEDGE. There is no flag, argument or code
 * path anywhere that requests One-way. It never cancels an order, never closes
 * or reduces a position, and never rolls anything back.
 *
 * Prints no API key, no balance, no position detail, no symbol and no order id.
 */

const CONFIRM_FLAG = "--confirm-set-hedge-mode";

function line(label: string, value: string | number | boolean | null | undefined): void {
  console.log(`  ${label.padEnd(28)} ${value === null || value === undefined ? "—" : String(value)}`);
}

async function main(): Promise<void> {
  const confirmed = process.argv.includes(CONFIRM_FLAG);

  console.log("Binance HEDGE MODE setup (Phase 10) — operator maintenance.");
  console.log("This command can only request HEDGE. One-way is not expressible anywhere in this codebase.");
  console.log("");

  if (!env.BINANCE_READ_ONLY_ENABLED) {
    console.log("BINANCE_READ_ONLY_ENABLED is false — the account cannot be inspected. Nothing was sent.");
    return;
  }

  // BIND FIRST. This command reaches SIGNED endpoints, so the account it
  // acts as must be proven before any client exists -- not picked up from
  // whatever the environment happens to hold. The database handle is used
  // for the profile proof only and is released immediately.
  const prisma = new PrismaClient();
  const bound = await bindConfiguredExchangeRuntime(prisma).finally(() =>
    prisma.$disconnect()
  );
  if (!bound.ok) {
    console.error(`REFUSED (${bound.reasonCode}): ${bound.message}`);
    console.error("No exchange client was constructed and no request was made.");
    process.exitCode = 1;
    return;
  }

  const service = accountConnectionFromRuntime(bound.runtime);

  // Always show the operator the account state first, whether or not they
  // confirmed. Counts only — never a symbol, quantity, price or order id.
  const health = await service.checkAccountConnection();
  console.log("Preflight");
  // The REST host, not a credential — this is how the operator confirms they
  // are pointed at the account they think they are.
  line("environment", env.BINANCE_FUTURES_REST_BASE_URL);
  line("positionMode", health.positionMode);
  line("assetMode", health.assetMode);
  line("nonZeroPositionCount", health.nonZeroPositionCount);
  line("openOrderCount", health.openOrderCount);
  line("mutation gate", env.BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED);
  line("operator confirmation", confirmed);

  const permitted = health.accountSetupSafe && env.BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED && confirmed;
  line("mutation permitted", permitted);
  console.log("");

  if (health.positionMode === "HEDGE") {
    console.log("The account is already in HEDGE mode. No request was sent.");
    return;
  }
  if (!health.accountSetupSafe) {
    console.log(
      "ACCOUNT_SETUP_BLOCKED — the account is not empty, or its state could not be read.\n" +
        "No request was sent. Resolve any exposure or open orders yourself first;\n" +
        "this tool will never cancel or close anything on your behalf."
    );
    return;
  }
  if (!env.BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED) {
    console.log("BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED is false. No request was sent.");
    return;
  }
  if (!confirmed) {
    console.log(`DRY RUN — no request was sent. Re-run with ${CONFIRM_FLAG} to proceed.`);
    return;
  }

  const result = await service.ensureHedgeMode();
  console.log("Result");
  line("outcome", result.outcome);
  line("positionMode before", result.positionModeBefore);
  line("positionMode verified", result.positionModeAfter);
  line("requests dispatched", result.mutationsDispatched);
  console.log("");
  console.log(result.message);
  console.log("");
  console.log("Live trading remains disabled. Phase 10 does not start the live canary.");

  if (result.outcome !== "HEDGE_MODE_SET" && result.outcome !== "ALREADY_HEDGE") process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Hedge-mode setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
