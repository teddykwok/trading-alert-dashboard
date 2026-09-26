// Phase 11F.1 -- MUST be the first import in this file.
//
// Static imports are hoisted and evaluated in source order, and the generated
// Prisma client loads the repository `.env` at its own module initialization.
// Anything imported above this line would let that happen first, and a generic
// process would silently acquire the account credentials that file holds.
import "./config/bootstrap-generic";

import { buildApp } from "./app";
import { env } from "./config/env";

/**
 * Phase 11F -- THE GENERIC/PUBLIC backend. Binds no account.
 *
 * It ingests the TradingView webhook, serves the dashboard's reads and
 * produces queue jobs: work that belongs to no account and must happen
 * exactly once however many accounts exist. A second ingester would
 * duplicate Alert rows, vision jobs and plans.
 *
 * What it deliberately no longer does:
 *
 *   - mount the operator control routes. Those resolve their account from
 *     process environment and reach signed Binance reads, so they belong to
 *     an account-bound process (account-control.server.ts).
 *   - publish a BACKEND runtime attestation. Activation requires a fresh
 *     BACKEND and WORKER pair for ONE account identity; a process that binds
 *     no account attesting as that account's BACKEND would let the interlock
 *     count a runtime that cannot act. The generic worker has published none
 *     since 11E, and this is the same rule applied to the same kind of
 *     process.
 */

async function start(): Promise<void> {
  const app = await buildApp();

  try {
    await app.listen({ port: env.BACKEND_PORT, host: "0.0.0.0" });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  // No runtime attestation is published here. See the header: this process
  // binds no account, so it has no account identity to attest to, and the
  // BACKEND role now belongs to account-control.server.ts.
  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

start();
