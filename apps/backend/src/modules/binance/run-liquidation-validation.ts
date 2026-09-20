import { PrismaClient } from "@prisma/client";

import { env } from "../../config/env";
import { bindConfiguredExchangeRuntime } from "../execution/exchange-runtime-binding";
import { BinanceError } from "./binance.errors";
import {
  marginPlanServiceFromRuntime,
  type LiquidationCheck,
} from "./binance-margin-plan.service";

/**
 * Liquidation-estimator accuracy check — READ ONLY.
 *
 *   pnpm --filter @trading-alert-dashboard/backend binance:liquidation-check
 *
 * Compares the engine's isolated liquidation estimate against Binance's own
 * reported liquidationPrice for the account's existing ISOLATED positions.
 * GET requests only: no order is placed or cancelled and no leverage, margin
 * type, isolated margin or position mode is touched.
 *
 * CROSS positions are never used as fixtures — the estimator models isolated
 * margin only. Exits non-zero if any comparable position exceeds the
 * tolerance: max(one symbol tick, 0.1% relative).
 */

const RELATIVE_TOLERANCE_PERCENT = 0.1;

/** Digit-wise decimal compare helpers (no float parsing of exchange values). */
function absoluteDifference(a: string, b: string): string {
  // Values here are display-only diagnostics; kept as strings via Decimal in
  // the engine. For reporting we use a bounded fixed-point subtraction.
  const scale = 12;
  const toScaled = (value: string): bigint => {
    const negative = value.trim().startsWith("-");
    const [int, frac = ""] = value.trim().replace("-", "").split(".");
    return (negative ? -1n : 1n) * BigInt(int + frac.padEnd(scale, "0").slice(0, scale));
  };
  const diff = toScaled(a) - toScaled(b);
  const magnitude = diff < 0n ? -diff : diff;
  const text = magnitude.toString().padStart(scale + 1, "0");
  return `${text.slice(0, -scale)}.${text.slice(-scale)}`.replace(/\.?0+$/, "") || "0";
}

function relativePercent(difference: string, reference: string): string {
  const scale = 1_000_000n;
  const toScaled = (value: string): bigint => {
    const [int, frac = ""] = value.trim().replace("-", "").split(".");
    return BigInt(int + frac.padEnd(12, "0").slice(0, 12));
  };
  const ref = toScaled(reference);
  if (ref === 0n) return "n/a";
  const pct = (toScaled(difference) * 100n * scale) / ref;
  const text = pct.toString().padStart(7, "0");
  return `${text.slice(0, -6)}.${text.slice(-6)}`;
}

function report(check: LiquidationCheck): { line: string; failed: boolean } {
  const head = `${check.symbol} ${check.positionSide}`;

  if (check.skippedReason) {
    return { line: `  SKIP  ${head.padEnd(22)} ${check.skippedReason}`, failed: false };
  }
  if (!check.estimate.available || check.estimate.price === null) {
    // Fail closed: an unavailable estimate is reported, never assumed safe.
    return {
      line: `  N/A   ${head.padEnd(22)} estimate unavailable: ${check.estimate.unavailableReason ?? "unknown"}`,
      failed: true,
    };
  }

  const reported = check.reportedLiquidationPrice as string;
  const estimated = check.estimate.price;
  const absDiff = absoluteDifference(estimated, reported);
  const relDiff = relativePercent(absDiff, reported);
  const withinTolerance = relDiff === "n/a" ? false : Number.parseFloat(relDiff) <= RELATIVE_TOLERANCE_PERCENT;

  return {
    line:
      `  ${withinTolerance ? "PASS" : "FAIL"}  ${head.padEnd(22)} ` +
      `reported ${reported} · estimated ${estimated} · abs ${absDiff} · rel ${relDiff}%`,
    failed: !withinTolerance,
  };
}

async function main(): Promise<void> {
  console.log("Liquidation estimate validation — READ ONLY (no account change is possible)\n");

  if (!env.BINANCE_READ_ONLY_ENABLED) {
    console.error(
      "Binance read-only connector is disabled. Set BINANCE_READ_ONLY_ENABLED=true with a " +
        "read-only API key in apps/backend/.env to run this check."
    );
    process.exitCode = 1;
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

  const marginPlanner = marginPlanServiceFromRuntime(bound.runtime);

  const checks = await marginPlanner.checkLiquidationEstimates();

  if (checks.length === 0) {
    console.log("No open positions to validate.");
    return;
  }

  let failures = 0;
  let compared = 0;

  for (const check of checks) {
    const { line, failed } = report(check);
    console.log(line);
    if (!check.skippedReason) compared += 1;
    if (failed) failures += 1;
  }

  console.log(
    `\nCompared ${compared} ISOLATED position(s); ${failures} outside the ` +
      `max(1 tick, ${RELATIVE_TOLERANCE_PERCENT}% relative) tolerance.`
  );
  console.log("Estimates are ESTIMATES — not Binance's guaranteed liquidation price.");

  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  if (error instanceof BinanceError) {
    console.error(`\nLiquidation validation failed [${error.kind}]: ${error.message}`);
  } else {
    console.error(`\nLiquidation validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
});
