import { env } from "../../config/env";
import { allowedAccountSetupPairs } from "./binance-account-setup.endpoints";
import { BinanceAccountConnectionService } from "./binance-account-connection.service";

/**
 * Binance ACCOUNT HEALTH check (Phase 10).
 *
 *   pnpm --filter @trading-alert-dashboard/backend binance:account-health
 *   pnpm --filter @trading-alert-dashboard/backend binance:account-health ETHUSDT
 *
 * Strictly READ-ONLY: it issues only allowlisted GET requests and changes
 * nothing — not position mode, not asset mode, not leverage, not margin type,
 * and no order. Safe to run against a real account at any time.
 *
 * Prints sanitized counts only. No balance, no position symbol or quantity, no
 * order id, no account alias, no API key and no signed URL ever reaches stdout.
 */

function line(label: string, value: string | number | boolean | null | undefined): void {
  const rendered = value === null || value === undefined ? "—" : String(value);
  console.log(`  ${label.padEnd(32)} ${rendered}`);
}

async function main(): Promise<void> {
  const symbol = (process.argv.slice(2).find((arg) => !arg.startsWith("-")) ?? "BTCUSDT").toUpperCase();

  console.log("Binance ACCOUNT HEALTH (Phase 10) — read-only. Nothing is changed.");
  console.log(`Phase 10 maintenance endpoints (not used by this command): ${allowedAccountSetupPairs().join("  ")}`);
  console.log("");

  if (!env.BINANCE_READ_ONLY_ENABLED) {
    console.log("BINANCE_READ_ONLY_ENABLED is false — set it to true (with credentials) to run this check.");
    return;
  }

  const service = new BinanceAccountConnectionService();
  const health = await service.checkAccountConnection(symbol);

  console.log("Connectivity");
  line("connected", health.connected);
  line("serverTimeReachable", health.serverTimeReachable);
  line("signedRequestWorks", health.signedRequestWorks);
  line("futuresAccountReachable", health.futuresAccountReachable);
  line("clockOffsetMs", health.clockOffsetMs);
  console.log("");

  console.log("Account configuration");
  line("positionMode", health.positionMode);
  line("assetMode", health.assetMode);
  line("symbolConfigReachable", `${health.symbolConfigReachable} (${symbol})`);
  line("leverageBracketReachable", `${health.leverageBracketReachable} (${symbol})`);
  console.log("");

  console.log("Account-wide state (counts only)");
  line("nonZeroPositionCount", health.nonZeroPositionCount);
  line("openOrderCount", health.openOrderCount);
  line("accountSetupSafe", health.accountSetupSafe);
  console.log("");

  console.log("Gates");
  line("accountSetupMutations", health.accountSetupMutationsConfigured);
  line("testOrderCapability", health.testOrderCapabilityConfigured);
  line("liveEntryEnabled", health.liveEntryEnabled);
  line("protectionReady", health.protectionReady);
  console.log("");

  console.log("Readiness");
  line("state", health.readinessState);
  line("codes", health.readinessCodes.join(", "));
  line("checkedAt", health.checkedAt);

  if (health.warnings.length > 0) {
    console.log("");
    console.log("Warnings");
    for (const warning of health.warnings) console.log(`  - ${warning}`);
  }

  console.log("");
  if (!health.accountSetupSafe && ((health.nonZeroPositionCount ?? 0) > 0 || (health.openOrderCount ?? 0) > 0)) {
    console.log(
      "ACCOUNT_SETUP_BLOCKED: existing exposure or open orders are present. Hedge-mode setup will refuse to run.\n" +
        "Decide what to do with that exposure yourself — this tool will never cancel or close anything."
    );
  }
  console.log("Live trading remains disabled. Phase 10 does not start the live canary.");
}

main().catch((error) => {
  // Kind/message only; BinanceError text is already sanitized and carries no
  // credential, signed URL or request body.
  console.error(`Account health check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
