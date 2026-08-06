import { env } from "../../config/env";
import { BinanceError } from "./binance.errors";
import { BinanceMarginPlanService } from "./binance-margin-plan.service";
import { formatMarginPlanLines } from "./margin-plan-format";

/**
 * Dynamic leverage / isolated margin planner — READ ONLY.
 *
 *   pnpm --filter @trading-alert-dashboard/backend binance:margin-plan -- \
 *     BTCUSDT LONG 0.2707 0.26563 1.50
 *
 * Reads symbol filters and account leverage brackets with GET requests only,
 * then runs the pure calculation engine. It never places or cancels an order
 * and never changes leverage, margin type or position mode: the leverage it
 * prints is a recommendation for you to apply manually, nothing more.
 */

const USAGE =
  "Usage: binance:margin-plan -- <SYMBOL> <LONG|SHORT> <entryPrice> <stopLoss> [riskBudgetUsd]";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const [symbol, directionArg, entryPrice, stopLoss, riskArg] = args;

  if (!symbol || !directionArg || !entryPrice || !stopLoss) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const direction = directionArg.toUpperCase();
  if (direction !== "LONG" && direction !== "SHORT") {
    console.error(`Direction must be LONG or SHORT (got "${directionArg}").\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  if (!env.BINANCE_READ_ONLY_ENABLED) {
    console.error(
      "Binance read-only connector is disabled. Set BINANCE_READ_ONLY_ENABLED=true with a " +
        "read-only API key in apps/backend/.env to fetch symbol filters and leverage brackets."
    );
    process.exitCode = 1;
    return;
  }

  const plan = await new BinanceMarginPlanService().planForSymbol({
    symbol,
    direction,
    entryPrice,
    stopLoss,
    riskBudgetUsd: riskArg ?? "1.50",
  });

  for (const line of formatMarginPlanLines(plan)) console.log(line);

  // Non-zero for anything that is not an actionable plan.
  if (plan.status !== "READY") process.exitCode = 1;
}

main().catch((error) => {
  if (error instanceof BinanceError) {
    console.error(`\nMargin plan failed [${error.kind}]: ${error.message}`);
  } else {
    console.error(`\nMargin plan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
});
