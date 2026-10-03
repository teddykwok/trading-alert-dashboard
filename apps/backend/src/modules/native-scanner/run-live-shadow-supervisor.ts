// MUST be the first import. The supervisor is a GENERIC process: this refuses to
// start if the environment holds ANY account credential.
import "../../config/bootstrap-generic";

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { env } from "../../config/env";
import { EXCHANGE_INFO_PATH, SCANNER_MARKET_TYPE, ScannerDataError, assertPublicFuturesBaseUrl, buildPublicFuturesUrl } from "./binance-public-futures";
import { CandidateRankHaltError, GovernedPublicTransport } from "./candidate-rank-runner";
import { KlineCacheStore } from "./kline-cache";
import { PublicRequestController, REQUEST_POLICY_LIMITS, type PublicHttpTransport } from "./kline-fetcher";
import type { OpenPublicStream } from "./live-shadow-runner";
import { LiveShadowSupervisor, SupervisorConfigError, TargetNotReachedError, liveShadowDir, type SupervisorSelection, type SupervisorStatus } from "./live-shadow-supervisor";
import { SUPERVISOR_CLI_USAGE, SupervisorCliUsageError, parseSupervisorCliArgs } from "./live-shadow-supervisor-cli-args";
import { ScannerPathError, assertOutsideRepository, scannerKlineCacheDir, scannerRootDir } from "./scanner-paths";
import { acquireLiveShadowLock } from "./scanner-lock";
import {
  ENGINE_NAMESPACE_MANIFEST,
  ScannerProfileError,
  assertEngineNamespace,
  engineNamespaceDir,
  engineNamespaceManifestOf,
  liveShadowEngineDir,
  profileSummaryOf,
} from "./scanner-profile";
import { RunManifestError, SUPERVISOR_RUN_MANIFEST_SCHEMA, buildRunManifest, makeRunId, runManifestText } from "./supervisor-run-manifest";
import { UniverseSelectionError, parseExchangeInfoContracts, selectSymbols, selectUsdtPerpetualUniverse, universeWalk } from "./usdm-universe";

/**
 * MULTI-SYMBOL NATIVE LIVE-SHADOW SUPERVISOR — SHADOW ONLY.
 *
 *   DOTENV_CONFIG_PATH=<generic env file> pnpm --filter @trading-alert-dashboard/backend \
 *     scanner:live-shadow-supervisor --universe usdt-perpetual --max-symbols 5 <lineage flags>
 *
 * Public market data only. It writes each symbol's local shadow checkpoint and
 * event log, the public kline cache and an observational status file. It
 * creates no Alert, touches no database, queue or account, holds no credential
 * and calls no signed endpoint. This entrypoint is the only place the
 * supervisor uses the real network, the real clock or timers.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../../..");

/** Public REST transport: GET only, the scanner's own headers only, no redirects followed. */
const publicTransport: PublicHttpTransport = async (url, init) => {
  const response = await fetch(url, {
    method: "GET",
    headers: init.headers,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, header: (name) => response.headers.get(name), text: () => response.text() };
};

/** Public WebSocket: no headers of ours at all, so no key can ever be sent. */
const openPublicStream: OpenPublicStream = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => handlers.onOpen());
  socket.addEventListener("message", (event) => handlers.onMessage(typeof event.data === "string" ? event.data : String(event.data)));
  socket.addEventListener("error", () => handlers.onError("websocket error event"));
  socket.addEventListener("close", (event) => handlers.onClose(`code ${event.code}${event.reason ? ` ${event.reason}` : ""}`));
  return { close: () => socket.close() };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const iso = (ms: number) => new Date(ms).toISOString();

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function printSummary(status: SupervisorStatus, extra: Record<string, unknown>): void {
  const t = status.totals;
  console.log(
    `[${iso(Date.now())}] selected ${t.selected} | live ${t.liveEligible} | quarantined ${t.quarantined} | awaiting ${t.awaitingStream} | recovering ${t.recovering} | failed ${t.failed} | pending ${t.catchupPending} | ` +
      `observations ${t.liveObservations} | commits ${t.commits} | refused ${t.refusedMessages} | reconnects ${t.reconnects} | backpressure ${t.backpressureEvents} | REST ${t.restRequests}${t.restHalted ? " HALTED" : ""} | ${Object.entries(extra).map(([k, v]) => `${k} ${String(v)}`).join(" | ")}`
  );
}

function printTable(status: SupervisorStatus): void {
  console.log(`${"Symbol".padEnd(16)}${"Conn".padEnd(6)}${"Status".padEnd(12)}${"Readiness".padEnd(26)}${"HWM".padEnd(26)}Obs  Commits`);
  for (const s of status.symbols) {
    const commits = s.counters.commitsLive + s.counters.commitsQuarantined + s.counters.commitsReplayed;
    console.log(`${s.symbol.padEnd(16)}${String(s.connection).padEnd(6)}${s.status.padEnd(12)}${String(s.readiness).padEnd(26)}${String(s.hwm ?? "-").padEnd(26)}${String(s.counters.observations).padEnd(5)}${commits}${s.failure ? `  ${s.failure}` : ""}`);
  }
}

async function main(): Promise<void> {
  let options;
  try {
    options = parseSupervisorCliArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof SupervisorCliUsageError)) throw error;
    console.error(`REFUSED: ${error.message}\n\n${SUPERVISOR_CLI_USAGE}`);
    process.exitCode = 2;
    return;
  }

  console.log("NATIVE LIVE SHADOW SUPERVISOR");
  console.log("SHADOW ONLY");
  console.log("NO ALERT AUTHORITY");
  console.log("NO ORDER AUTHORITY");
  const gitHead = git(["rev-parse", "HEAD"]);
  console.log(`git ${gitHead}${git(["status", "--porcelain"]) === "" ? "" : " (worktree NOT clean)"}`);

  const root = assertOutsideRepository(scannerRootDir(process.env), REPO_ROOT);
  const runId = makeRunId(Date.now(), randomBytes(4).toString("hex"));
  const profile = options.profile === null ? null : profileSummaryOf(options.profile);
  if (profile !== null && options.profile !== null) {
    // The profile's own state namespace: verified (never shared with another engine), or created.
    const namespace = assertOutsideRepository(engineNamespaceDir(root, profile.engineFingerprint), REPO_ROOT);
    const manifestFile = path.join(namespace, ENGINE_NAMESPACE_MANIFEST);
    assertEngineNamespace(existsSync(manifestFile) ? readFileSync(manifestFile, "utf8") : null, profile.engineFingerprint);
    if (!existsSync(manifestFile)) {
      mkdirSync(namespace, { recursive: true });
      writeFileSync(`${manifestFile}.tmp`, `${JSON.stringify(engineNamespaceManifestOf(options.profile), null, 2)}\n`, "utf8");
      renameSync(`${manifestFile}.tmp`, manifestFile);
    }
    console.log(`profile: ${profile.profileLabel} (${profile.profileId})`);
    console.log(`  engine fingerprint:           ${profile.engineFingerprint}`);
    console.log(`  delivery-policy fingerprint:  ${profile.deliveryPolicyFingerprint}`);
    console.log(`  execution-policy fingerprint: ${profile.executionPolicyFingerprint}`);
    console.log(`  engine: min move ${profile.engine.minMovePercent}%, tolerance ${profile.engine.touchTolerancePercent}%, source TFs ${profile.engine.engineSourceTimeframes.join(",")}`);
    console.log(`  dashboard delivery TFs: ${profile.delivery.dashboardSourceTimeframes.join(",")} (${profile.delivery.policyVersion})`);
    console.log(`  future execution policy TFs: ${profile.execution.futureExecutionSourceTimeframes.join(",")} — ${profile.execution.notice}`);
    console.log(`  state namespace: ${namespace}`);
  }
  console.log(`run id: ${runId}`);
  const baseUrl = assertPublicFuturesBaseUrl(env.BINANCE_FUTURES_REST_BASE_URL);
  const governor = new GovernedPublicTransport(publicTransport, { maxTotalRequests: options.maxTotalRequests, minSpacingMs: options.minSpacingMs, nowMs: () => Date.now(), sleep });
  const fetchDeps = {
    transport: governor.transport,
    baseUrl,
    policy: { maxRequests: REQUEST_POLICY_LIMITS.maxRequestsCeiling, minSpacingMs: options.minSpacingMs, maxTransientRetries: 2, transientBackoffMs: Math.max(2_000, options.minSpacingMs) },
    nowMs: () => Date.now(),
    sleep,
  };

  // The same universe and selection rules as the ranker; explicit symbols must be active USDT perpetuals.
  const universe = selectUsdtPerpetualUniverse(parseExchangeInfoContracts(await new PublicRequestController(fetchDeps).getJson(buildPublicFuturesUrl(baseUrl, EXCHANGE_INFO_PATH))));
  // EXPLICIT: exactly the named symbols, never substituted. UNIVERSE: walk the universe and
  // accept SCANNER-ELIGIBLE symbols until --max-symbols are accepted, or all of them (--all-active).
  let selection: SupervisorSelection;
  if (options.selection.mode === "EXPLICIT") {
    const explicit = selectSymbols(universe, options.selection);
    selection = { mode: "EXPLICIT", candidates: explicit.contracts.map((c) => ({ symbol: c.symbol, onboardDateMs: c.onboardDateMs, required: true })) };
  } else {
    const walk = universeWalk(universe, options.selection).map(({ contract, required }) => ({ symbol: contract.symbol, onboardDateMs: contract.onboardDateMs, required }));
    selection = options.selection.maxSymbols === null ? { mode: "ALL_ACTIVE", candidates: walk } : { mode: "TARGET", candidates: walk, target: options.selection.maxSymbols };
  }
  const started = Date.now();
  const supervisor = new LiveShadowSupervisor(
    {
      lineage: options.lineage,
      selection,
      universeActive: universe.contracts.length,
      symbolsPerConnection: options.symbolsPerConnection,
      maxConnections: options.maxConnections,
      restConcurrency: options.restConcurrency,
      queueCapacity: options.queueCapacity,
      maxProcessingLagMs: options.maxProcessingLagMs,
      staleSymbolMs: options.staleSymbolMs,
      maxRecoveryAttempts: options.maxRecoveryAttempts,
      liveDirFor: (symbol) =>
        assertOutsideRepository(
          profile === null
            ? liveShadowDir(root, symbol, options.lineage.chartInterval)
            : liveShadowEngineDir(root, profile.engineFingerprint, SCANNER_MARKET_TYPE, symbol, options.lineage.chartInterval),
          REPO_ROOT
        ),
      runId,
      profile,
    },
    {
      openStream: openPublicStream,
      governor,
      fetchDeps,
      cache: new KlineCacheStore(assertOutsideRepository(scannerKlineCacheDir(process.env), REPO_ROOT)),
      acquireLock: (dir) => acquireLiveShadowLock(dir, { pid: process.pid, owner: "scanner:live-shadow-supervisor", startedAt: iso(started), isProcessAlive }),
      nowMs: () => Date.now(),
      nowIso: () => iso(Date.now()),
      schedule: (fn) => setImmediate(fn),
      log: (line) => console.log(`[${iso(Date.now())}] ${line}`),
    }
  );
  console.log(`universe active: ${universe.contracts.length}`);
  console.log(
    selection.mode === "TARGET"
      ? `target eligible: ${selection.target} (walking ${selection.candidates.length} candidates)`
      : selection.mode === "ALL_ACTIVE"
        ? `target: every scanner-eligible active symbol (${selection.candidates.length} candidates)`
        : `explicit symbols: ${selection.candidates.length}`
  );
  console.log(`interval: ${options.lineage.chartInterval}`);

  const statusDir = assertOutsideRepository(path.join(root, "live-shadow-supervisor"), REPO_ROOT);
  const statusFile = path.join(statusDir, "status.json");
  // Per-run files: the immutable manifest a pinned consumer binds to, and this run's own status.
  const runDir = assertOutsideRepository(path.join(statusDir, "runs", runId), REPO_ROOT);
  const runStatusFile = path.join(runDir, "status.json");
  const writeStatus = (status: SupervisorStatus) => {
    // Observational only: a failure here is logged and never touches scanning.
    const text = `${JSON.stringify({ ...status, gitHead, pid: process.pid, writtenAt: iso(Date.now()) }, null, 2)}\n`;
    for (const [dir, file] of [
      [statusDir, statusFile],
      [runDir, runStatusFile],
    ]) {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${file}.tmp`, text, "utf8");
        renameSync(`${file}.tmp`, file);
      } catch (error) {
        console.error(`status file not written (${error instanceof Error ? error.name : "unknown"}); scanning continues`);
      }
    }
  };

  let stopping = false;
  const stop = (why: string) => {
    if (stopping) return;
    stopping = true;
    supervisor.stop();
    const status = supervisor.status();
    writeStatus(status);
    printTable(status);
    console.log(`stopped (${why}); checkpoints and shadow evidence are on disk`);
    process.exit(0);
  };
  process.on("SIGINT", () => stop("operator stop"));

  await supervisor.start();
  const sel = supervisor.status().selection;
  // The run manifest: written ONCE (flag wx: never overwritten), after selection, so a pinned consumer
  // can bind to exactly this run's accepted symbols, profile and engine.
  const counts = sel ?? {
    mode: "EXPLICIT", universeActive: null, targetEligible: null, candidatesTested: 0, acceptedEligible: 0,
    skippedTooNew: 0, skippedInsufficientHistory: 0, skippedOther: 0, universeExhausted: true,
  };
  const manifest = buildRunManifest({
    schema: SUPERVISOR_RUN_MANIFEST_SCHEMA,
    runId,
    startedAt: supervisor.startedAt,
    gitHead,
    marketType: SCANNER_MARKET_TYPE,
    chartInterval: options.lineage.chartInterval,
    engineFingerprint: supervisor.engineFingerprint,
    profile,
    stateLayout: profile === null ? "LEGACY" : "ENGINE_NAMESPACE",
    selection: {
      mode: counts.mode,
      universeActive: counts.universeActive,
      targetEligible: counts.targetEligible,
      candidatesTested: counts.candidatesTested,
      acceptedEligible: supervisor.acceptedSymbols().length,
      skippedTooNew: counts.skippedTooNew,
      skippedInsufficientHistory: counts.skippedInsufficientHistory,
      skippedOther: counts.skippedOther,
      universeExhausted: counts.universeExhausted,
    },
    symbols: supervisor.acceptedSymbols(),
    actionable: false,
  });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "manifest.json"), runManifestText(manifest), { encoding: "utf8", flag: "wx" });
  console.log(`run manifest: ${path.join(runDir, "manifest.json")} (${manifest.body.symbols.length} symbols, sha256 ${manifest.bodySha256.slice(0, 12)})`);
  if (sel !== null) {
    console.log(`tested candidates: ${sel.candidatesTested}`);
    console.log(`accepted eligible: ${sel.acceptedEligible}`);
    console.log("skipped (never joined the running set):");
    console.log(`  too-new precheck: ${sel.skippedTooNew}`);
    console.log(`  insufficient history: ${sel.skippedInsufficientHistory}`);
    console.log(`  other: ${sel.skippedOther}`);
    console.log(`universe exhausted: ${sel.universeExhausted}`);
  }
  console.log(`connections: ${supervisor.status().connections.length} (${options.symbolsPerConnection} symbols per connection max)`);
  console.log(`startup complete in ${((Date.now() - started) / 1000).toFixed(1)}s; REST requests ${governor.requestsMade}`);
  printTable(supervisor.status());

  let lastSummary = Date.now();
  const cpuStart = process.cpuUsage();
  for (;;) {
    await sleep(1_000);
    if (stopping) return;
    supervisor.tick();
    if (options.durationMinutes !== null && Date.now() - started > options.durationMinutes * 60_000) return stop(`--duration-minutes ${options.durationMinutes} reached`);
    if (Date.now() - lastSummary >= options.statusEverySeconds * 1000) {
      lastSummary = Date.now();
      const status = supervisor.status();
      writeStatus(status);
      const cpu = process.cpuUsage(cpuStart);
      const extra = { rssMB: Math.round(process.memoryUsage().rss / 1e6), cpuSec: ((cpu.user + cpu.system) / 1e6).toFixed(1) };
      if (options.jsonStatus) console.log(JSON.stringify({ ...status, ...extra }));
      else printSummary(status, extra);
    }
  }
}

void main().catch((error: unknown) => {
  if (
    error instanceof ScannerDataError ||
    error instanceof ScannerPathError ||
    error instanceof UniverseSelectionError ||
    error instanceof SupervisorConfigError ||
    error instanceof CandidateRankHaltError ||
    error instanceof TargetNotReachedError ||
    error instanceof ScannerProfileError ||
    error instanceof RunManifestError
  ) {
    if (error instanceof TargetNotReachedError) {
      const s = error.summary;
      console.error(
        `target ${s.targetEligible ?? "all-active"}; accepted ${s.acceptedEligible}; tested ${s.candidatesTested}; remaining universe ${s.remainingUniverse}; requests used ${s.requestsUsed}; ` +
          `skipped too-new ${s.skippedTooNew}, insufficient history ${s.skippedInsufficientHistory}, other ${s.skippedOther}`
      );
    }
    const code = "code" in error ? ` (${String((error as { code: unknown }).code)})` : "";
    console.error(`REFUSED${code}: ${error.message}`);
  } else {
    console.error(`SUPERVISOR FAILED (${error instanceof Error ? error.name : "unknown"})`);
  }
  process.exitCode = 1;
});
