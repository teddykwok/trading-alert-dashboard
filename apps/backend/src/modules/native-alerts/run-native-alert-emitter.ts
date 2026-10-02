// MUST be the first import. The emitter is a GENERIC process: this refuses to
// start if the environment holds ANY account credential, so it can never run
// with Account A/B keys in reach.
import "../../config/bootstrap-generic";

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

import { LiveCheckpointStore, LiveShadowError } from "../native-scanner/live-shadow-checkpoint";
import { ScannerPathError, assertOutsideRepository, scannerRootDir } from "../native-scanner/scanner-paths";
import { NATIVE_EMITTER_CLI_USAGE, NativeEmitterCliUsageError, parseNativeEmitterCliArgs, type NativeEmitterCliRequest } from "./native-alert-cli-args";
import { NativeAlertEmitter, runNativeEmitterLoop, type NativeEmitterEvent } from "./native-alert-emitter";
import { NativeDeliveryConflictError, PrismaNativeDeliveryLedger } from "./native-alert-ledger";
import { NATIVE_DELIVERY_MARKET_TYPE, NATIVE_DELIVERY_POLICY_VERSION, NATIVE_DELIVERY_V1_SOURCE_TFS } from "./native-delivery-policy";
import { ShadowLogError, ShadowLogTail, type ShadowLogIdentity } from "./shadow-log-reader";

/**
 * NATIVE ALERT EMITTER for ONE symbol, ONE chart interval and ONE lineage.
 *
 *   DOTENV_CONFIG_PATH=<generic env file> \
 *     pnpm --filter @trading-alert-dashboard/backend native-alerts:emitter \
 *       --symbol LDOUSDT --interval 15m --lineage-id <sha256> [--follow] [--commit-dashboard-alerts]
 *
 * Reads the live shadow scanner's DURABLE event log (never its socket) and, in
 * COMMIT mode only, writes one source=NATIVE dashboard Alert per bar through the
 * delivery ledger. It holds no Binance or account credential, calls no Binance
 * endpoint, selects no account, and enqueues no analysis, plan or execution
 * job. Native alerts are refused by every execution path in code.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
/** Follow mode: how many consecutive polls a partial final line may stay partial before it is a torn log. */
const FOLLOW_PENDING_TAIL_POLLS = 5;

function databaseName(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return "(DATABASE_URL not set)";
  try {
    return new URL(url).pathname.replace(/^\//, "") || "(unnamed)";
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

const short = (sha: string) => sha.slice(0, 12);

function describe(event: NativeEmitterEvent): string | null {
  if (event.type === "SKIPPED") {
    // Bar commits are never deliverable by design; listing each one is noise.
    if (event.reason === "BAR_CLOSE_COMMIT_NEVER_DELIVERED") return null;
    return `  skip     event=${short(event.eventId)} reason=${event.reason}${event.supersededBy ? ` winner=${short(event.supersededBy)}` : ""}`;
  }
  const w = event.decision.winner;
  return (
    `  ${event.result.padEnd(31)} bar=${w.barOpenTime} ${w.signal} ${w.sourceTf} ${w.levelColor} @ ${w.levelPrice}` +
    ` evidence=${w.evidence.evidenceClass} event=${short(w.eventId)} key=${short(event.decision.deliveryKey)}` +
    (event.alertId ? ` alert=${event.alertId}` : "")
  );
}

async function main(): Promise<number> {
  let request: NativeEmitterCliRequest;
  try {
    request = parseNativeEmitterCliArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof NativeEmitterCliUsageError) {
      console.error(`native-alerts:emitter: ${error.message}\n${NATIVE_EMITTER_CLI_USAGE}`);
      return 2;
    }
    throw error;
  }

  const shadowDir = assertOutsideRepository(
    request.shadowDir ?? path.join(scannerRootDir(process.env), "live-shadow", NATIVE_DELIVERY_MARKET_TYPE, request.symbol, request.chartInterval),
    REPO_ROOT
  );
  const eventsFile = path.join(shadowDir, "events.jsonl");
  const identity: ShadowLogIdentity = {
    lineageId: request.lineageId,
    marketType: NATIVE_DELIVERY_MARKET_TYPE,
    symbol: request.symbol,
    chartInterval: request.chartInterval,
  };

  // The scanner's own checkpoint must exist, verify, and name the same lineage.
  const checkpoint = new LiveCheckpointStore(shadowDir).load();
  if (checkpoint === null) {
    console.error(`native-alerts:emitter: no live-shadow checkpoint in ${shadowDir}; the scanner has not run for this symbol.`);
    return 1;
  }
  const body = checkpoint.body;
  if (body.lineageId !== identity.lineageId || body.symbol !== identity.symbol || body.chartInterval !== identity.chartInterval || body.marketType !== identity.marketType) {
    console.error("native-alerts:emitter: the scanner checkpoint is for a different lineage, symbol, interval or market. Refusing.");
    return 1;
  }

  const prisma = new PrismaClient();
  try {
    const ledger = new PrismaNativeDeliveryLedger(prisma);
    const status = await ledger.status({ lineageId: identity.lineageId, symbol: identity.symbol, chartInterval: identity.chartInterval });
    const commit = request.mode === "COMMIT_DASHBOARD_ALERTS";

    console.log("==============================================================");
    console.log("NATIVE ALERT EMITTER");
    console.log("DASHBOARD WRITES ONLY");
    console.log("EXECUTION FOR NATIVE ALERTS IS HARD-DISABLED");
    console.log("==============================================================");
    console.log(`  policy              ${NATIVE_DELIVERY_POLICY_VERSION}`);
    console.log(`  source TF allowlist ${NATIVE_DELIVERY_V1_SOURCE_TFS.join(",")} (1M/3M/6M/12M are never delivered)`);
    console.log(`  lineage             ${identity.lineageId}`);
    console.log(`  symbol              ${identity.symbol} (${identity.marketType})`);
    console.log(`  chart interval      ${identity.chartInterval}`);
    console.log(`  shadow log          ${eventsFile}${existsSync(eventsFile) ? "" : " (not written yet)"}`);
    console.log(`  checkpoint HWM      ${new Date(body.hwmOpenTimeMs).toISOString()}`);
    console.log(`  database            ${databaseName()}`);
    console.log(`  ledger              ${status.available ? "AVAILABLE" : "UNAVAILABLE"} — ${status.detail}`);
    console.log(`  mode                ${commit ? "COMMIT DASHBOARD ALERTS (writes source=NATIVE alerts)" : "DRY RUN (read-only; writes nothing)"}`);
    console.log(`  follow              ${request.follow ? `yes, every ${request.pollMs} ms` : "no (one catch-up pass)"}`);

    if (commit && !status.available) {
      console.error("native-alerts:emitter: COMMIT refused — the delivery ledger is unavailable. Nothing was written.");
      return 1;
    }

    const emitter = new NativeAlertEmitter({
      mode: request.mode,
      ledger: status.available ? ledger : null,
      report: (event) => {
        const line = describe(event);
        if (line !== null) console.log(line);
      },
    });
    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    await runNativeEmitterLoop({
      tail: new ShadowLogTail(identity, request.follow ? FOLLOW_PENDING_TAIL_POLLS : 0),
      readLog: () => (existsSync(eventsFile) ? readFileSync(eventsFile, "utf8") : null),
      emitter,
      follow: request.follow,
      pollMs: request.pollMs,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      shouldStop: () => stopping,
      onCaughtUp: () => console.log(`  caught up: ${emitter.tally.records} records${request.follow ? "; following" : ""}`),
    });

    const t = emitter.tally;
    console.log(
      `  done: records=${t.records} decisions=${t.decisions} created=${t.created} alreadyDelivered=${t.alreadyDelivered} wouldCreate=${t.wouldCreate} skipped=${JSON.stringify(t.skipped)}`
    );
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const known =
      error instanceof ShadowLogError ||
      error instanceof NativeDeliveryConflictError ||
      error instanceof LiveShadowError ||
      error instanceof ScannerPathError;
    const code = (error as { code?: unknown }).code;
    console.error(
      known
        ? `native-alerts:emitter REFUSED (${String(code ?? (error as Error).name)}): ${(error as Error).message}`
        : `native-alerts:emitter failed: ${error instanceof Error ? error.name : "unknown error"}`
    );
    process.exit(1);
  });
