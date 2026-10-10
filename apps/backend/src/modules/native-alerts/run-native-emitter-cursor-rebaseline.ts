// MUST be the first import. A GENERIC process: this refuses to start if the
// environment holds ANY account credential, so it never has Account A/B keys in reach.
import "../../config/bootstrap-generic";

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { LiveCheckpointStore, LiveShadowError } from "../native-scanner/live-shadow-checkpoint";
import { RunMembershipError, parseMembershipJournal } from "../native-scanner/run-membership";
import { ScannerPathError, assertOutsideRepository, scannerRootDir } from "../native-scanner/scanner-paths";
import { LIVE_SHADOW_LOCK_FILE, ScannerLockError, acquireLiveShadowLock, type ScannerLock } from "../native-scanner/scanner-lock";
import { ScannerProfileError, liveShadowEngineDir, resolveScannerProfile } from "../native-scanner/scanner-profile";
import { parseRunManifest } from "../native-scanner/supervisor-run-manifest";
import type { CheckpointIdentity } from "./multi-symbol-emitter";
import { NATIVE_DELIVERY_MARKET_TYPE } from "./native-delivery-policy";
import {
  RebaselineRefusal,
  commitRebaseline,
  openOperations,
  prepareRebaseline,
  resumeRebaseline,
  type PreparedRebaseline,
  type RebaselineResult,
  type RebaselineSource,
} from "./native-emitter-cursor-rebaseline";
import { FileEmitterCursorStore, FileRebaselineStore, emitterCursorDir, emitterRebaselineDir, readTextIfExists } from "./native-emitter-state-files";
import { REBASELINE_CLI_USAGE, RebaselineCliUsageError, parseRebaselineCliArgs, type RebaselineCliRequest } from "./native-emitter-rebaseline-cli-args";

/**
 * NATIVE EMITTER PRODUCTION CURSOR REBASELINE (NATIVE_EMITTER_CURSOR_REBASELINE_V1).
 *
 *   DOTENV_CONFIG_PATH=<generic env file> pnpm --filter @trading-alert-dashboard/backend \
 *     native-alerts:rebaseline-cursors --profile teddy-7-all-active --run-id <STOPPED run> --expect-engine-fingerprint <sha256>
 *
 * Advances the production delivery cursors of one STOPPED supervisor run's
 * lanes to the exact end of their durable shadow logs, so that delivery
 * resumes after that point and the old backlog is never delivered. DRY RUN by
 * default (writes nothing). Never evaluates a record for delivery, never
 * creates an Alert, never opens a database, never calls Binance, never touches
 * an account or execution, never changes a scanner checkpoint or log.
 * REBASELINE IS NOT A SCANNER RESET.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const BAR = "==============================================================";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function printPlan(prepared: PreparedRebaseline, request: RebaselineCliRequest): void {
  const b = prepared.body;
  const t = b.totals;
  console.log(`  profile              ${b.profileId}`);
  console.log(`  run                  ${b.runId} (${b.runState})`);
  console.log(`  engine fingerprint   ${b.engineFingerprint}`);
  console.log(`  membership           ${b.membership.dynamic ? `DYNAMIC journal, ${b.membership.records} record(s)` : "manifest only"}`);
  console.log(`  accepted symbols     ${t.lanes}`);
  console.log(`  existing cursors     ${t.existingCursors}`);
  console.log(`  missing cursors      ${t.missingCursors}`);
  console.log(`  alreadyAtEof         ${t.alreadyAtEof}`);
  console.log(`  wouldAdvance         ${t.wouldAdvance}`);
  console.log(`  wouldInitialize      ${t.wouldInitialize}`);
  console.log("  invalid/refused      0");
  console.log(`  old cursor chars     ${t.previousConsumedChars}`);
  console.log(`  proposed EOF chars   ${t.proposedEofChars} (backlog acknowledged: ${t.backlogChars} chars)`);
  console.log(`  plan hash            ${prepared.planSha256}`);
  const lanes = request.verbose ? b.lanes : [...b.lanes].filter((l) => l.backlogChars > 0).sort((x, y) => y.backlogChars - x.backlogChars || (x.symbol < y.symbol ? -1 : 1)).slice(0, request.top);
  if (lanes.length > 0) {
    console.log(request.verbose ? "  lanes:" : `  largest backlog lanes (top ${request.top}):`);
    for (const l of lanes) {
      console.log(`    ${l.action.padEnd(16)} ${l.symbol.padEnd(18)} cursor ${l.previous === null ? "none" : l.previous.cursor.consumedChars} -> EOF ${l.eofChars} (+${l.backlogChars})`);
    }
  }
}

function printCommitted(result: RebaselineResult, evidenceDir: string): void {
  console.log("REBASELINE COMMITTED");
  console.log(`  profile              ${result.profileId}`);
  console.log(`  runId                ${result.runId}`);
  console.log(`  fingerprint          ${result.engineFingerprint}`);
  console.log(`  symbols              ${result.lanes}`);
  console.log(`  advanced             ${result.advanced}`);
  console.log(`  initialized          ${result.initialized}`);
  console.log(`  alreadyAtEof         ${result.alreadyAtEof}`);
  console.log(`  cursor writes        ${result.cursorWrites}${result.resumedLanes > 0 ? ` (+${result.resumedLanes} already written before an interruption)` : ""}`);
  console.log(`  plan hash            ${result.planSha256}`);
  console.log(`  audit/result         ${path.join(evidenceDir, result.operationId, "result.json")}`);
  console.log("  Alerts created: 0");
  console.log("  Database opened: NO");
  console.log("  Binance called: NO");
  console.log("  Native execution: DISABLED / UNCHANGED");
}

async function main(): Promise<number> {
  let request: RebaselineCliRequest;
  try {
    request = parseRebaselineCliArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof RebaselineCliUsageError) {
      console.error(`native-alerts:rebaseline-cursors: ${error.message}\n${REBASELINE_CLI_USAGE}`);
      return 2;
    }
    throw error;
  }
  const commit = request.mode === "COMMIT_REBASELINE";
  console.log(BAR);
  console.log("NATIVE EMITTER PRODUCTION CURSOR REBASELINE");
  console.log(commit ? "PRODUCTION DELIVERY CURSORS WILL ADVANCE TO CURRENT DURABLE EOF" : "DRY RUN — WRITES NOTHING");
  console.log("NO ALERTS / NO DATABASE / NO BINANCE / NO EXECUTION");
  console.log(BAR);

  const root = assertOutsideRepository(scannerRootDir(process.env), REPO_ROOT);
  const profile = resolveScannerProfile(request.profileName);
  const runDir = path.join(root, "live-shadow-supervisor", "runs", request.runId);
  const manifestText = readTextIfExists(path.join(runDir, "manifest.json"));
  const chartInterval = manifestText === null ? null : parseRunManifest(manifestText).body.chartInterval;
  const dirOf = (symbol: string) => assertOutsideRepository(liveShadowEngineDir(root, request.engineFingerprint, NATIVE_DELIVERY_MARKET_TYPE, symbol, chartInterval ?? "15m"), REPO_ROOT);
  const cursorStore = new FileEmitterCursorStore(assertOutsideRepository(emitterCursorDir(root, profile.profileId, request.engineFingerprint, NATIVE_DELIVERY_MARKET_TYPE, chartInterval ?? "15m"), REPO_ROOT));
  const evidenceDir = assertOutsideRepository(emitterRebaselineDir(root, profile.profileId, request.engineFingerprint, NATIVE_DELIVERY_MARKET_TYPE, chartInterval ?? "15m"), REPO_ROOT);
  const store = new FileRebaselineStore(evidenceDir, cursorStore);
  const readLog = (symbol: string): string | null => {
    const file = path.join(dirOf(symbol), "events.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  };

  // An interrupted operation is completed (by its plan hash) or reported; a different one never starts beside it.
  const open = openOperations(store);
  if (open.length > 0 && !commit) {
    for (const o of open) console.log(`  OPEN OPERATION       ${o.operationId} ${o.state} plan ${o.planSha256 ?? "unknown"}`);
    console.log(`  Complete it with --commit-rebaseline --expect-plan-sha256 ${open[0].planSha256 ?? "<its plan hash>"} (evidence: ${evidenceDir}). Nothing was written.`);
    return 1;
  }

  const checkpointOf = (symbol: string): CheckpointIdentity | null => {
    try {
      const loaded = new LiveCheckpointStore(dirOf(symbol)).load();
      return loaded === null ? null : loaded.body;
    } catch (error) {
      if (!(error instanceof LiveShadowError)) throw error;
      return { lineageId: `CHECKPOINT_UNREADABLE (${error.code})`, symbol, chartInterval: chartInterval ?? "15m", marketType: NATIVE_DELIVERY_MARKET_TYPE };
    }
  };
  // Dry run: read-only inspection of each lane's scanner lock (a live owner is a writer; a dead owner's lock is stale).
  const inspectLock = (symbol: string): string | null => {
    const file = path.join(dirOf(symbol), LIVE_SHADOW_LOCK_FILE);
    if (!existsSync(file)) return null;
    let holder: { pid?: unknown; owner?: unknown };
    try {
      holder = JSON.parse(readFileSync(file, "utf8")) as typeof holder;
    } catch {
      throw new Error(`${file} cannot be read`);
    }
    if (typeof holder.pid !== "number" || !Number.isSafeInteger(holder.pid)) throw new Error(`${file} names no process id`);
    return isProcessAlive(holder.pid) ? `live process ${holder.pid} (${String(holder.owner)}) holds the lane's scanner lock` : null;
  };

  const locks: ScannerLock[] = [];
  const lockDeps = { pid: process.pid, owner: "native-alerts:rebaseline-cursors", startedAt: new Date(Date.now()).toISOString(), isProcessAlive };
  try {
    if (commit) {
      // One rebaseline at a time per cursor namespace, and no scanner writing any lane while we work.
      locks.push(acquireLiveShadowLock(evidenceDir, lockDeps));
      const manifest = manifestText === null ? null : parseRunManifest(manifestText);
      const membership = manifest?.body.membership ?? null;
      const journalSymbols = (() => {
        if (membership === null) return [];
        try {
          return parseMembershipJournal(readTextIfExists(path.join(runDir, membership.journal)), request.runId).records.map((r) => r.symbol);
        } catch (error) {
          if (!(error instanceof RunMembershipError)) throw error;
          return []; // the plan refuses an invalid journal before anything is written
        }
      })();
      // Lock every EXISTING lane directory of the manifest and the journal (a lane without one is refused by the
      // plan; the lock primitive would otherwise create the directory).
      for (const symbol of [...new Set([...(manifest?.body.symbols ?? []).map((s) => s.symbol), ...journalSymbols])].sort()) {
        if (existsSync(dirOf(symbol))) locks.push(acquireLiveShadowLock(dirOf(symbol), lockDeps));
      }
    }
    const source: RebaselineSource = {
      manifestText,
      runStatusText: readTextIfExists(path.join(runDir, "status.json")),
      membershipText: (journal) => readTextIfExists(path.join(runDir, journal)),
      readLog,
      checkpointOf,
      readCursorFile: (symbol) => cursorStore.loadText(symbol),
      // Commit holds every lane's lock itself, so no other writer can exist.
      liveWriterOf: commit ? () => null : inspectLock,
    };
    const nowIso = () => new Date(Date.now()).toISOString();

    if (commit && open.length > 0) {
      const target = open[0];
      console.log(`  resuming interrupted operation ${target.operationId} (${target.state})`);
      const result = resumeRebaseline({ store, operationId: target.operationId, expectedPlanSha256: request.expectPlanSha256 as string, nowIso, readLog });
      printCommitted(result, evidenceDir);
      return 0;
    }

    const prepared = prepareRebaseline({ profileId: profile.profileId, runId: request.runId, engineFingerprint: request.engineFingerprint }, source);
    printPlan(prepared, request);
    if (!commit) {
      if (request.json) console.log(JSON.stringify({ planSha256: prepared.planSha256, body: prepared.body }, null, 2));
      console.log(`  DRY RUN complete: nothing was written. To commit exactly this plan: --commit-rebaseline --expect-plan-sha256 ${prepared.planSha256}`);
      return 0;
    }
    const outcome = commitRebaseline({ prepared, expectedPlanSha256: request.expectPlanSha256 as string, createdAt: nowIso(), nowIso, store, readLog });
    if (outcome.kind === "NOOP") {
      console.log("REBASELINE NOOP: every lane is already at its durable EOF; nothing was written.");
      console.log("  Alerts created: 0 | Database opened: NO | Binance called: NO | Native execution: DISABLED / UNCHANGED");
      return 0;
    }
    printCommitted(outcome.result, evidenceDir);
    return 0;
  } finally {
    for (const lock of locks.reverse()) lock.release();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof RebaselineRefusal) {
      console.error(`native-alerts:rebaseline-cursors REFUSED (${error.code}): ${error.message}`);
      for (const lane of error.lanes.slice(0, 50)) console.error(`  ${lane.symbol} ${lane.code}: ${lane.detail}`);
      if (error.lanes.length > 50) console.error(`  ... and ${error.lanes.length - 50} more lane(s)`);
      process.exit(1);
    }
    const known = error instanceof ScannerLockError || error instanceof ScannerProfileError || error instanceof ScannerPathError || error instanceof LiveShadowError;
    const code = (error as { code?: unknown }).code;
    console.error(
      known
        ? `native-alerts:rebaseline-cursors REFUSED (${String(code ?? (error as Error).name)}): ${(error as Error).message}`
        : `native-alerts:rebaseline-cursors failed: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`
    );
    process.exit(1);
  });
