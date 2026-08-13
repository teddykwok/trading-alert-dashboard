// Populates process.env from .env and NOTHING else. Deliberately not
// `config/env`, which parses and validates the production configuration at
// import time and is what every Binance client falls back to. Loading the raw
// values here is what makes the production-credential collision check real:
// without it the comparison would silently pass because the production names
// would not be present at all.
import "dotenv/config";
import { resolve } from "node:path";
import { createTestnetMutationClients, createTestnetProbeClients } from "./testnet-verifier/testnet-clients";
import { resolveTestnetConfig } from "./testnet-verifier/testnet-config";
import { deriveIdentities, generateRunId } from "./testnet-verifier/testnet-identities";
import { formatProbeReport, formatRunReport } from "./testnet-verifier/testnet-report";
import { FileStateStore } from "./testnet-verifier/testnet-state";
import { runProbe, runVerification, type VerifierOptions } from "./testnet-verifier/testnet-verifier";

/**
 * Binance USDⓈ-M TESTNET protection verifier (Phase 20B) — operator only.
 *
 *   MODE A (always run this first):
 *     pnpm --filter @trading-alert-dashboard/backend binance:testnet-protection-verify -- \
 *       --probe-only --symbol=BTCUSDT
 *
 *   MODE B:
 *     pnpm --filter @trading-alert-dashboard/backend binance:testnet-protection-verify -- \
 *       --confirm-testnet-mutations --symbol=BTCUSDT --trigger-offset-bps=1000
 *
 * This file deliberately does NOT import `config/env`. That module parses
 * production environment variables at import time and every Binance client
 * constructor falls back to it, so the verifier reads only its own
 * BINANCE_TESTNET_* names straight from `process.env` and passes every option
 * explicitly.
 *
 * It also imports no Prisma, starts no scheduler and touches no database.
 */

const PROBE_FLAG = "--probe-only";
const CONFIRM_FLAG = "--confirm-testnet-mutations";
const DEFAULT_STATE_FILE = ".testnet-verifier-state.json";

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  const match = process.argv.find((entry) => entry.startsWith(prefix));
  if (match) return match.slice(prefix.length).trim();
  // Also accept the space-separated form: --symbol BTCUSDT
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) {
    const next = process.argv[index + 1];
    if (next && !next.startsWith("--")) return next.trim();
  }
  return null;
}

function numeric(name: string): number | null {
  const raw = arg(name);
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function main(): Promise<void> {
  const probeOnly = process.argv.includes(PROBE_FLAG);
  const confirmed = process.argv.includes(CONFIRM_FLAG);
  const symbol = arg("symbol");

  console.log("Binance USDⓈ-M TESTNET protection verifier (Phase 20B).");
  console.log("Demo host only. The production execution profile, scheduler and gates are never used.");
  console.log(
    "Production credentials are never used for requests; they are read only for the testnet " +
      "credential-collision guard, and are never printed."
  );
  console.log("");

  if (probeOnly === confirmed) {
    console.error(`Choose exactly one mode: ${PROBE_FLAG} or ${CONFIRM_FLAG}.`);
    process.exitCode = 1;
    return;
  }
  if (!symbol) {
    console.error("--symbol is required and has no default.");
    process.exitCode = 1;
    return;
  }

  // ---- Fail-closed gate. No client exists yet. ---------------------------
  const decision = resolveTestnetConfig({
    BINANCE_TESTNET_PROTECTION_VERIFY: process.env.BINANCE_TESTNET_PROTECTION_VERIFY,
    BINANCE_TESTNET_API_KEY: process.env.BINANCE_TESTNET_API_KEY,
    BINANCE_TESTNET_API_SECRET: process.env.BINANCE_TESTNET_API_SECRET,
    BINANCE_TESTNET_BASE_URL: process.env.BINANCE_TESTNET_BASE_URL,
    BINANCE_API_KEY: process.env.BINANCE_API_KEY,
    BINANCE_API_SECRET: process.env.BINANCE_API_SECRET,
  });

  if (!decision.ok) {
    console.error(`REFUSED (${decision.reasonCode}): ${decision.message}`);
    console.error("No Binance client was constructed and no request was made.");
    process.exitCode = 1;
    return;
  }

  const triggerOffsetBps = numeric("trigger-offset-bps");
  if (!probeOnly && triggerOffsetBps === null) {
    console.error("--trigger-offset-bps is required in mutation mode and has no default.");
    process.exitCode = 1;
    return;
  }

  const stateStore = new FileStateStore(resolve(process.cwd(), arg("state-file") ?? DEFAULT_STATE_FILE));
  // A resume MUST reuse the persisted runId so the same identities are derived.
  const existing = stateStore.read();
  const runId = existing?.runId ?? generateRunId();
  const identities = deriveIdentities(runId);

  const options: VerifierOptions = {
    mode: probeOnly ? "PROBE_ONLY" : "MUTATE",
    symbol,
    triggerOffsetBps: triggerOffsetBps ?? 0,
    entryCrossBps: numeric("entry-cross-bps") ?? 20,
    fillPollAttempts: numeric("fill-poll-attempts") ?? 10,
    fillPollIntervalMs: numeric("fill-poll-interval-ms") ?? 1_000,
  };
  const log = (line: string) => console.log(`  · ${line}`);

  if (probeOnly) {
    // PROBE-ONLY builds READ-ONLY clients. `createTestnetProbeClients` never
    // references BinanceUsdMExecutionClient, so no live-gated mutation client
    // exists anywhere in this process — a stronger guarantee than "the probe
    // code path does not call one".
    const probeClients = createTestnetProbeClients(decision.config);
    const probe = await runProbe(options, {
      readOnly: probeClients.readOnly,
      documented: probeClients.documented,
      identities,
      log,
    });
    for (const line of formatProbeReport(probe, {
      host: decision.config.baseUrl,
      symbol: symbol.toUpperCase(),
      runId,
    })) {
      console.log(line);
    }
    console.log("");
    console.log(
      probe.ALGO_QUERY_ENDPOINT_SUPPORTED
        ? "FINAL: PROBE_PASS — the Algo query route is proven on the demo host."
        : "FINAL: NOT_SUPPORTED — Algo support was not proven. Mutation mode will refuse to run."
    );
    console.log("");
    // Probe mode never mutates, so it never leaves state behind.
    process.exitCode = probe.ALGO_QUERY_ENDPOINT_SUPPORTED ? 0 : 1;
    return;
  }

  // Only the mutation path constructs an execution client.
  const clients = createTestnetMutationClients(decision.config);
  const report = await runVerification(options, {
    readOnly: clients.readOnly,
    mutations: clients.mutations,
    documented: clients.documented,
    state: stateStore,
    identities,
    now: () => new Date(),
    sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
    log,
  });
  for (const line of formatRunReport(report)) console.log(line);
  if (report.stateRetained) {
    console.log(`State retained at ${stateStore.filePath} — re-run to resume the SAME identities.`);
  }
  process.exitCode = report.verdict === "PASS" ? 0 : 1;
}

main().catch((error: unknown) => {
  // Never print the error object itself: a thrown fetch error can embed the
  // request URL, which carries the signature.
  console.error(`Verifier aborted: ${error instanceof Error ? error.name : "unknown error"}`);
  process.exitCode = 1;
});
