import { env } from "../../config/env";
import { BinanceError } from "./binance.errors";
import { allowedReadOnlyPaths } from "./binance.endpoints";
import { BinanceReadOnlyService } from "./binance-read-only.service";
import { BinanceReadOnlyClient } from "./binance.client";
import { configuredExchangeClientOptions } from "../execution/exchange-runtime-binding";
import type { BinancePositionDto } from "./binance.types";

/**
 * Binance READ-ONLY health check.
 *
 *   pnpm --filter @trading-alert-dashboard/backend binance:read-only-check
 *   pnpm --filter @trading-alert-dashboard/backend binance:read-only-check BTCUSDT
 *
 * Issues only allowlisted GET requests: it can never place or cancel an
 * order, change leverage, margin type or position mode, and it writes nothing
 * to the database. Credentials are never printed.
 */

function line(label: string, value: string | number | null | undefined): void {
  console.log(`  ${label.padEnd(26)} ${value === null || value === undefined ? "—" : value}`);
}

/**
 * Renders one position as a short header plus two indented detail lines.
 *
 * Deliberately NOT one long line: a full position is ~150 characters, so a
 * single line wraps in a normal terminal and splits fields mid-token (which
 * is what made "· lev 5x ·" appear as "lev5x" in wrapped output). Keeping
 * each line well under 80 characters keeps every field — separators and all —
 * intact. Values are printed verbatim; no reformatting of exchange decimals.
 */
function positionLines(position: BinancePositionDto): string[] {
  const prices = [
    `amt ${position.positionAmt ?? "—"}`,
    `entry ${position.entryPrice ?? "—"}`,
    `mark ${position.markPrice ?? "—"}`,
    `liq ${position.liquidationPrice ?? "—"}`,
  ];

  const margin = [`${position.marginType ?? "—"}`, `lev ${position.leverage ?? "—"}x`];
  if (position.isolatedWallet) margin.push(`isoWallet ${position.isolatedWallet}`);
  if (position.isolatedMargin) margin.push(`isoMargin ${position.isolatedMargin}`);

  return [
    `  ${position.symbol} ${position.positionSide}`,
    `      ${prices.join(" · ")}`,
    `      ${margin.join(" · ")}`,
  ];
}

async function main(): Promise<void> {
  const symbol = process.argv.slice(2).find((arg) => !arg.startsWith("-"));

  console.log("Binance READ-ONLY check (Phase 2) — no order, leverage or margin change is possible.");
  // Wrapped rather than one long line, so terminals never split a path.
  const paths = allowedReadOnlyPaths();
  console.log(`Allowlisted GET endpoints (${paths.length}):`);
  for (let i = 0; i < paths.length; i += 3) console.log(`  ${paths.slice(i, i + 3).join("  ")}`);
  console.log("");

  if (!env.BINANCE_READ_ONLY_ENABLED) {
    console.log("Connector is DISABLED.");
    console.log("Enable it locally by setting these in apps/backend/.env (never commit real keys):");
    console.log("  BINANCE_READ_ONLY_ENABLED=true");
    console.log("  BINANCE_API_KEY=<read-only key>");
    console.log("  BINANCE_API_SECRET=<read-only secret>");
    console.log("Use a Binance API key with ONLY 'Enable Reading' permission (no trading, no withdrawals).");
    process.exitCode = 1;
    return;
  }

  const service = new BinanceReadOnlyService(
    new BinanceReadOnlyClient(configuredExchangeClientOptions())
  );

  const summary = await service.getAccountSummary();

  console.log("Connection");
  line("status", summary.connection.ok ? "OK" : "FAILED");
  line("host", summary.connection.host);
  line("server time", summary.connection.serverTimeIso);
  line("clock offset (ms)", summary.connection.clockOffsetMs);
  line("round trip (ms)", summary.connection.roundTripMs);
  line("recvWindow (ms)", env.BINANCE_RECV_WINDOW_MS);

  console.log("\nAccount");
  line("position mode", summary.positionMode ?? "unknown");
  line("asset mode", summary.assetMode ?? "unavailable");
  line("USDT wallet balance", summary.usdtWalletBalance);
  line("USDT available", summary.usdtAvailableBalance);
  line("open positions", summary.nonZeroPositionCount);
  line("open orders", summary.openOrderCount);

  if (summary.positions.length > 0) {
    console.log("\nPositions");
    for (const position of summary.positions) {
      for (const positionLine of positionLines(position)) console.log(positionLine);
    }
  }

  if (symbol) {
    const inspection = await service.inspectSymbol(symbol);
    console.log(`\nSymbol ${inspection.filters.symbol}`);
    line("status", inspection.filters.status);
    line("contract type", inspection.filters.contractType);
    line("tick size", inspection.filters.tickSize);
    line("step size", inspection.filters.stepSize);
    line("market step size", inspection.filters.marketStepSize);
    line("min / max qty", `${inspection.filters.minQty ?? "—"} / ${inspection.filters.maxQty ?? "—"}`);
    line("min notional", inspection.filters.minNotional);
    line("order types", inspection.filters.orderTypes.join(", ") || null);
    line("time in force", inspection.filters.timeInForce.join(", ") || null);
    line("leverage brackets", inspection.brackets.length);
    line("max initial leverage", inspection.maxInitialLeverage);
    if (inspection.brackets.length > 0) {
      const first = inspection.brackets[0];
      line("bracket 1 maint ratio", first.maintMarginRatio);
      line("bracket 1 notional cap", first.notionalCap);
    }
    if (inspection.accountSymbolConfig) {
      line("account margin type", inspection.accountSymbolConfig.marginType);
      line("account leverage", inspection.accountSymbolConfig.leverage);
    }
    console.log("  (Phase 2 does not choose a leverage — that is Phase 3.)");
  }

  if (summary.warnings.length > 0) {
    console.log("\nWarnings");
    for (const warning of summary.warnings) console.log(`  - ${warning}`);
  }

  console.log("\nRead-only check complete. Nothing was modified on Binance.");
}

main().catch((error) => {
  // BinanceError messages are already sanitized; never dump raw error objects
  // (they can contain request URLs carrying a signature).
  if (error instanceof BinanceError) {
    console.error(`\nBinance read-only check failed [${error.kind}]: ${error.message}`);
  } else {
    console.error(`\nBinance read-only check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
});
