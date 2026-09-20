import { PrismaClient } from "@prisma/client";

import { env } from "../../config/env";
import { bindConfiguredExchangeRuntime } from "../execution/exchange-runtime-binding";
import { accountConnectionFromRuntime } from "./binance-account-connection.service";

/**
 * Binance TEST ORDER validation (Phase 10) — operator only.
 *
 *   pnpm --filter @trading-alert-dashboard/backend binance:test-order \
 *     --symbol=BTCUSDT --side=LONG --quantity=0.002 --price=50000 --confirm-test-order
 *
 * Sends POST /fapi/v1/order/test, Binance's NON-MATCHING validation endpoint.
 * It validates the request and returns; it never reaches the order book, so no
 * order is created, rests or fills. There is no code path from here to
 * POST /fapi/v1/order — not on success, not on rejection, not on timeout.
 *
 * Nothing is hardcoded: symbol, side, quantity and price must all be supplied.
 * Values are validated against the symbol's own filters LOCALLY first and are
 * never silently rounded — a price off the tick grid is rejected, not snapped.
 *
 * Requires BINANCE_TEST_ORDER_ENABLED=true plus --confirm-test-order.
 */

const CONFIRM_FLAG = "--confirm-test-order";

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  const match = process.argv.find((entry) => entry.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : null;
}

function line(label: string, value: string | number | boolean | null | undefined): void {
  console.log(`  ${label.padEnd(28)} ${value === null || value === undefined ? "—" : String(value)}`);
}

async function main(): Promise<void> {
  const symbol = arg("symbol");
  const side = (arg("side") ?? "").toUpperCase();
  const quantity = arg("quantity");
  const price = arg("price");
  const confirmed = process.argv.includes(CONFIRM_FLAG);

  console.log("Binance TEST ORDER validation (Phase 10) — POST /fapi/v1/order/test.");
  console.log("This endpoint is NON-MATCHING: it validates a request and creates no order.");
  console.log("");

  if (!symbol || !quantity || !price || (side !== "LONG" && side !== "SHORT")) {
    console.log(
      "Usage: binance:test-order --symbol=BTCUSDT --side=LONG|SHORT --quantity=<exact> --price=<exact> " +
        `${CONFIRM_FLAG}`
    );
    console.log("Every value is required; nothing is defaulted to a live symbol, size or price.");
    process.exitCode = 1;
    return;
  }

  if (!env.BINANCE_READ_ONLY_ENABLED) {
    console.log("BINANCE_READ_ONLY_ENABLED is false — the symbol cannot be inspected. Nothing was sent.");
    return;
  }

  console.log("Request");
  line("symbol", symbol.toUpperCase());
  line("positionSide", side);
  line("side", side === "LONG" ? "BUY" : "SELL");
  line("type", "LIMIT");
  line("timeInForce", "GTC");
  line("quantity", quantity);
  line("price", price);
  line("test-order gate", env.BINANCE_TEST_ORDER_ENABLED);
  line("operator confirmation", confirmed);
  console.log("");

  if (!env.BINANCE_TEST_ORDER_ENABLED) {
    console.log("BINANCE_TEST_ORDER_ENABLED is false. No request was sent.");
    return;
  }
  if (!confirmed) {
    console.log(`DRY RUN — no request was sent. Re-run with ${CONFIRM_FLAG} to proceed.`);
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
  const result = await service.validateTestOrder({
    symbol,
    positionSide: side,
    quantity,
    price,
  });

  console.log("Result");
  line("outcome", result.outcome);
  line("realOpenOrdersChanged", result.realOpenOrdersChanged);
  line("openOrderCount before", result.openOrderCountBefore);
  line("openOrderCount after", result.openOrderCountAfter);
  line("test client id", result.clientOrderId);
  line("requests dispatched", result.mutationsDispatched);
  if (result.validationViolations.length > 0) line("local violations", result.validationViolations.join(", "));
  console.log("");
  console.log(result.message);
  console.log("");

  if (result.outcome === "TEST_ORDER_VALIDATED") {
    console.log("What this proves: authentication, request signing, clock sync and the parameters are accepted,");
    console.log("and the key carries the permission this endpoint requires.");
    console.log("What it does NOT prove: that a real order would fill, that future balance will suffice,");
    console.log("that the symbol state will stay unchanged, or that SL/TP placement works.");
  }
  console.log("Live trading remains disabled. Phase 10 does not start the live canary.");

  if (result.outcome !== "TEST_ORDER_VALIDATED") process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Test-order validation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
