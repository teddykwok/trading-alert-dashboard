// MUST be the first import. The emitter is a GENERIC process: this refuses to
// start if the environment holds ANY account credential, so it can never run
// with Account A/B keys in reach.
import "../../config/bootstrap-generic";

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { LiveCheckpointStore, LiveShadowError } from "../native-scanner/live-shadow-checkpoint";
import { ScannerPathError, assertOutsideRepository, scannerRootDir } from "../native-scanner/scanner-paths";
import { ScannerProfileError, liveShadowEngineDir, resolveScannerProfile } from "../native-scanner/scanner-profile";
import { RunManifestError, parseRunManifest } from "../native-scanner/supervisor-run-manifest";
import { MULTI_EMITTER_CLI_USAGE, MultiEmitterCliUsageError, parseMultiEmitterCliArgs, type MultiEmitterCliRequest } from "./multi-emitter-cli-args";
import {
  MultiSymbolNativeEmitter,
  NotActivatedError,
  QueueOverflowError,
  RunBindingError,
  bindPinnedRun,
  runMultiSymbolEmitter,
  type CheckpointIdentity,
  type MultiEmitterEvent,
} from "./multi-symbol-emitter";
import { NativeDeliveryConflictError, type NativeDeliveryLedgerV2 } from "./native-alert-ledger";
import { NATIVE_DELIVERY_MARKET_TYPE } from "./native-delivery-policy";
import { FileEmitterCursorStore, emitterCursorDir, emitterRunDir, readTextIfExists, writeFileDurably } from "./native-emitter-state-files";

/**
 * MULTI-SYMBOL NATIVE ALERT EMITTER, pinned to ONE supervisor run of ONE profile.
 *
 *   DOTENV_CONFIG_PATH=<generic env file> pnpm --filter @trading-alert-dashboard/backend \
 *     native-alerts:multi-emitter --profile <teddy-aggressive|teddy-7-all-active> --run-id <id> --expect-engine-fingerprint <sha256> [--follow]
 *
 * Reads only the durable shadow logs of the symbols that run ACCEPTED, inside
 * the profile's engine namespace. DRY RUN (the default) writes nothing — no
 * database row, no cursor — and never opens a database connection. COMMIT is a
 * separate, explicit operator decision. It holds no Binance or account
 * credential, calls no Binance endpoint, selects no account and has no path to
 * plans, adoption or execution: native alerts are refused by every execution
 * path in code, whatever their source timeframe.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const FOLLOW_PENDING_TAIL_POLLS = 5;
const short = (sha: string) => sha.slice(0, 12);

function describe(event: MultiEmitterEvent): string | null {
  if (event.type === "SKIPPED") {
    // Bar commits are never deliverable by design; listing each one is noise.
    if (event.reason === "BAR_CLOSE_COMMIT_NEVER_DELIVERED" || event.reason === "REPLAY_OR_QUARANTINE_NON_ACTIONABLE") return null;
    return `  skip     ${event.symbol} event=${short(event.eventId)} tf=${event.sourceTf ?? "-"} reason=${event.reason}`;
  }
  if (event.type === "LANE_FAILED") return `  LANE FAILED ${event.symbol} ${event.code}: ${event.message}`;
  if (event.type === "LANE_JOINED") return `  joined   ${event.symbol} (membership record ${event.seq}, lineage ${short(event.lineageId)}): activates at its current EOF`;
  if (event.type === "MEMBERSHIP_INVALID") return `  MEMBERSHIP JOURNAL INVALID: ${event.message} — no further symbol is bound; bound lanes continue`;
  if (event.type === "LANE_ACTIVATED") return `  activated ${event.symbol} at char ${event.activationChars} (${event.historicalRecords} historical records never delivered)`;
  const w = event.decision.winner;
  return (
    `  ${event.result.padEnd(36)} ${event.symbol} bar=${w.barOpenTime} ${w.signal} ${w.sourceTf} ${w.levelColor} @ ${w.levelPrice}` +
    ` evidence=${w.evidence.evidenceClass} event=${short(w.eventId)} key=${short(event.decision.deliveryKey)}` +
    (event.alertId ? ` alert=${event.alertId}` : "")
  );
}

async function main(): Promise<number> {
  let request: MultiEmitterCliRequest;
  try {
    request = parseMultiEmitterCliArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof MultiEmitterCliUsageError) {
      console.error(`native-alerts:multi-emitter: ${error.message}\n${MULTI_EMITTER_CLI_USAGE}`);
      return 2;
    }
    throw error;
  }

  const root = assertOutsideRepository(scannerRootDir(process.env), REPO_ROOT);
  const profile = resolveScannerProfile(request.profileName);
  const supervisorRunDir = path.join(root, "live-shadow-supervisor", "runs", request.runId);
  const manifestText = readTextIfExists(path.join(supervisorRunDir, "manifest.json"));
  if (manifestText === null) {
    console.error(`native-alerts:multi-emitter: no manifest for supervisor run ${request.runId}. Refusing.`);
    return 1;
  }
  const manifest = parseRunManifest(manifestText);
  const dirOf = (symbol: string) =>
    assertOutsideRepository(liveShadowEngineDir(root, request.engineFingerprint, NATIVE_DELIVERY_MARKET_TYPE, symbol, manifest.body.chartInterval), REPO_ROOT);

  const checkpointOf = (symbol: string): CheckpointIdentity | null => {
    try {
      const loaded = new LiveCheckpointStore(dirOf(symbol)).load();
      return loaded === null ? null : loaded.body;
    } catch (error) {
      if (!(error instanceof LiveShadowError)) throw error;
      return { lineageId: `CHECKPOINT_UNREADABLE (${error.code})`, symbol, chartInterval: manifest.body.chartInterval, marketType: NATIVE_DELIVERY_MARKET_TYPE };
    }
  };
  const run = bindPinnedRun({
    manifest,
    expect: { profileId: profile.profileId, runId: request.runId, engineFingerprint: request.engineFingerprint },
    checkpointOf,
  });
  // A dynamic-universe run announces later joins in its membership journal (named by the manifest).
  const membershipFile = manifest.body.membership == null ? null : path.join(supervisorRunDir, manifest.body.membership.journal);
  const commit = request.mode === "COMMIT_DASHBOARD_ALERTS";

  console.log("==============================================================");
  console.log("NATIVE MULTI-SYMBOL EMITTER");
  console.log(commit ? "DASHBOARD WRITES ONLY" : "DRY RUN — WRITES NOTHING, OPENS NO DATABASE");
  console.log("EXECUTION FOR NATIVE ALERTS IS HARD-DISABLED");
  console.log("==============================================================");
  const s = run.summary;
  console.log(`  profile              ${s.profileLabel} (${s.profileId})`);
  console.log(`  pinned run           ${run.runId}`);
  console.log(`  engine fingerprint   ${run.engineFingerprint}`);
  console.log(`  delivery policy      ${s.delivery.policyVersion} ${s.deliveryPolicyFingerprint}`);
  console.log(`  dashboard TFs        ${s.delivery.dashboardSourceTimeframes.join(",")} (engine-only: ${s.engine.engineSourceTimeframes.filter((tf) => !s.delivery.dashboardSourceTimeframes.includes(tf)).join(",")})`);
  console.log(`  future execution     ${s.execution.futureExecutionSourceTimeframes.join(",")} — ${s.execution.notice}`);
  console.log(`  symbols              ${run.lanes.length} accepted by the run (${run.lanes.filter((l) => l.bindingFailure !== null).length} failing binding)`);
  console.log(`  membership           ${membershipFile === null ? "fixed at start-up (manifest only)" : "DYNAMIC: later joins from the run's membership journal, each activated at its current EOF"}`);
  console.log(`  mode                 ${commit ? "COMMIT DASHBOARD ALERTS" : request.baseline === "DRY_RUN_FROM_START" ? "DRY RUN (whole logs, stateless)" : "DRY RUN (from production cursors, read-only)"}`);
  if (commit) console.log("  auto-planning        PENDING plan intent + Native planning queue per committed alert (generated by native-alerts:plan-worker; PLANNING ONLY)");
  console.log(`  follow               ${request.follow ? `yes, every ${request.pollMs} ms` : "no (one catch-up pass)"}`);

  const cursorStore = new FileEmitterCursorStore(assertOutsideRepository(emitterCursorDir(root, profile.profileId, run.engineFingerprint, NATIVE_DELIVERY_MARKET_TYPE, run.chartInterval), REPO_ROOT));
  let ledger: NativeDeliveryLedgerV2 | null = null;
  let disconnect: () => Promise<void> = async () => undefined;
  if (commit) {
    // Loaded only for COMMIT: a dry run never even constructs a database client.
    const { PrismaClient } = await import("@prisma/client");
    const { PrismaNativeDeliveryLedger } = await import("./native-alert-ledger");
    // The live dashboard push for each COMMITTED delivery (presentation only, post-commit, never fatal).
    const { openNativeAlertLivePublisher } = await import("../notifications/native-alert-live-publisher");
    const live = await openNativeAlertLivePublisher((line) => console.warn(`  ${line}`));
    const prisma = new PrismaClient();
    // Automatic Native PLANNING request for each COMMITTED delivery: a PENDING plan intent plus one
    // job on the dedicated Native planning queue. Post-commit, never fatal, no HTTP; the plan itself
    // is generated later by the separate Native planning worker. PLANNING ONLY.
    const { afterNativeAlertCommitted, openNativePlanRequester } = await import("../native-planning/native-plan-request");
    const planning = await openNativePlanRequester(prisma, (line) => console.warn(`  ${line}`));
    disconnect = async () => {
      live.close();
      await planning.close();
      await prisma.$disconnect();
    };
    // The push and the planning request run concurrently and independently: the push never waits on planning.
    const prismaLedger = new PrismaNativeDeliveryLedger(prisma, { onAlertCommitted: (alert) => afterNativeAlertCommitted(alert, live.publisher, planning.requester) });
    const status = await prismaLedger.status({ lineageId: run.lanes[0].lineageId, symbol: run.lanes[0].symbol, chartInterval: run.chartInterval });
    if (!status.available) {
      console.error(`native-alerts:multi-emitter: COMMIT refused — the delivery ledger is unavailable (${status.detail}). Nothing was written.`);
      await disconnect();
      return 1;
    }
    ledger = prismaLedger;
  }

  const emitter = new MultiSymbolNativeEmitter({
    mode: request.mode,
    run,
    readLog: (symbol) => {
      const file = path.join(dirOf(symbol), "events.jsonl");
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    },
    cursors: cursorStore,
    cursorWriter: commit ? cursorStore : null,
    ledger,
    baseline: request.baseline,
    activateAtEof: request.activateAtEof,
    queueCapacity: request.queueCapacity,
    pendingTailPolls: request.follow ? FOLLOW_PENDING_TAIL_POLLS : 0,
    nowIso: () => new Date(Date.now()).toISOString(),
    ...(membershipFile === null ? {} : { readMembership: () => readTextIfExists(membershipFile), checkpointOf }),
    report: (event) => {
      const line = describe(event);
      if (line !== null) console.log(line);
    },
  });

  const statusFile = assertOutsideRepository(path.join(emitterRunDir(root, run.runId), `status-${commit ? "commit" : "dry-run"}.json`), REPO_ROOT);
  const writeStatus = () => {
    try {
      writeFileDurably(statusFile, `${JSON.stringify({ ...emitter.status(), pid: process.pid, writtenAt: new Date(Date.now()).toISOString() }, null, 2)}\n`);
    } catch (error) {
      console.error(`status file not written (${error instanceof Error ? error.name : "unknown"}); the emitter continues`);
    }
  };

  let stopping = false;
  process.once("SIGINT", () => (stopping = true));
  process.once("SIGTERM", () => (stopping = true));
  const started = Date.now();
  let lastStatus = 0;
  try {
    await runMultiSymbolEmitter(emitter, {
      follow: request.follow,
      pollMs: request.pollMs,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      shouldStop: () => stopping || (request.durationMinutes !== null && Date.now() - started > request.durationMinutes * 60_000),
      afterCycle: () => {
        if (Date.now() - lastStatus >= request.statusEverySeconds * 1000) {
          lastStatus = Date.now();
          writeStatus();
          const t = emitter.status();
          console.log(
            `[${new Date(Date.now()).toISOString()}] symbols ${t.symbolsHealthy}/${t.symbolsTracked} healthy | read ${t.eventsRead} | eligible ${t.eventsEligible} ${JSON.stringify(t.eligibleBySourceTf)} | ` +
              `skipped ${t.eventsSkipped} | wouldCreate ${t.wouldCreate} | created ${t.created} | queue ${t.queueDepth}/${t.queueCapacity} (max ${t.maxQueueDepth})`
          );
        }
        // A pinned emitter never outlives its run: a later run must be pinned explicitly.
        const runStatus = readTextIfExists(path.join(supervisorRunDir, "status.json"));
        if (runStatus !== null && (JSON.parse(runStatus) as { runState?: string }).runState === "STOPPED") {
          console.log(`  pinned supervisor run ${run.runId} has STOPPED; the emitter ends with it`);
          return "END";
        }
        return "CONTINUE";
      },
    });
  } finally {
    writeStatus();
    await disconnect();
  }
  const t = emitter.status();
  console.log(
    `  done: read=${t.eventsRead} eligible=${t.eventsEligible} skipped=${t.eventsSkipped} wouldCreate=${t.wouldCreate} created=${t.created} ledgerDuplicates=${t.ledgerDuplicates} ` +
      `cursorWrites=${t.cursors.writes} skipCounts=${JSON.stringify(t.skipCounts)}`
  );
  console.log(`  status file: ${statusFile}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const known =
      error instanceof RunBindingError ||
      error instanceof RunManifestError ||
      error instanceof ScannerProfileError ||
      error instanceof NotActivatedError ||
      error instanceof QueueOverflowError ||
      error instanceof NativeDeliveryConflictError ||
      error instanceof LiveShadowError ||
      error instanceof ScannerPathError;
    const code = (error as { code?: unknown }).code;
    console.error(
      known
        ? `native-alerts:multi-emitter REFUSED (${String(code ?? (error as Error).name)}): ${(error as Error).message}`
        : `native-alerts:multi-emitter failed: ${error instanceof Error ? error.name : "unknown error"}`
    );
    process.exit(1);
  });
