// MUST be the first import. The scanner is a GENERIC process: this refuses to
// start if the environment holds ANY account credential, so a replay can never
// run with Account A/B keys in reach — whichever env file it was launched with.
import "../../config/bootstrap-generic";

import { execFileSync } from "node:child_process";
import path from "node:path";

import { env } from "../../config/env";
import { assertPublicFuturesBaseUrl, ScannerDataError } from "./binance-public-futures";
import { CompatReplayError } from "./compat-replay";
import { COMPAT_REPLAY_CLI_USAGE, CompatReplayCliUsageError, parseCompatReplayCliArgs } from "./compat-replay-cli-args";
import { executeCompatibilityReplay } from "./compat-replay-runner";
import { KlineCacheError, KlineCacheStore } from "./kline-cache";
import { fetchClosedFuturesKlines, type PublicHttpTransport } from "./kline-fetcher";
import { REPLAY_PAGE_LIMIT, REPLAY_SETTLE_MS } from "./replay-cli-args";
import { ScannerLineageError } from "./scanner-lineage";
import { ScannerPathError, assertOutsideRepository, scannerKlineCacheDir, scannerReplayDir } from "./scanner-paths";

/**
 * COMPATIBILITY replay of ONE symbol: Pine-compatible historical bootstrap up
 * to a fixed switchover, then the approved causal engine.
 *
 *   DOTENV_CONFIG_PATH=<generic env file> \
 *     pnpm --filter @trading-alert-dashboard/backend scanner:compat-replay --symbol LDOUSDT ... [--fetch]
 *
 * Reads public Binance USD-M klines (only with --fetch), keeps them in the
 * machine-local cache, and writes non-actionable EVIDENCE as JSONL plus a
 * manifest v2 under %LOCALAPPDATA%. It creates no Alert, touches no database,
 * queue or account, and holds no credential. Like scanner:replay's CLI, this
 * entrypoint is the only place its run may use the real network or clock.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../../..");

/** The real transport: GET only, the scanner's own headers only, no redirects followed. */
const publicTransport: PublicHttpTransport = async (url, init) => {
  const response = await fetch(url, {
    method: "GET",
    headers: init.headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, header: (name) => response.headers.get(name), text: () => response.text() };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

async function main(): Promise<void> {
  let options;
  try {
    options = parseCompatReplayCliArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof CompatReplayCliUsageError)) throw error;
    console.error(`REFUSED: ${error.message}\n\n${COMPAT_REPLAY_CLI_USAGE}`);
    process.exitCode = 2;
    return;
  }

  const cacheDir = assertOutsideRepository(scannerKlineCacheDir(process.env), REPO_ROOT);
  const replayDir = assertOutsideRepository(scannerReplayDir(process.env), REPO_ROOT);
  const baseUrl = assertPublicFuturesBaseUrl(env.BINANCE_FUTURES_REST_BASE_URL);
  const { policy } = options;

  const outcome = await executeCompatibilityReplay(options.request, {
    cache: new KlineCacheStore(cacheDir),
    fetchRange: options.fetch
      ? (request) =>
          fetchClosedFuturesKlines({ transport: publicTransport, baseUrl, policy, nowMs: () => Date.now(), sleep }, request)
      : null,
    outputDir: replayDir,
    nowIso: () => new Date().toISOString(),
    gitHead: git(["rev-parse", "HEAD"]),
    gitWorktreeClean: git(["status", "--porcelain"]) === "",
    maxBars: options.maxBars,
    pageLimit: REPLAY_PAGE_LIMIT,
    settleMs: REPLAY_SETTLE_MS,
  });

  const { manifest } = outcome;
  console.log("NATIVE COMPATIBILITY REPLAY — evidence only. Nothing is actionable; no Alert was created; nothing was traded.");
  console.log(`  lineage                      ${manifest.identity.lineageId}`);
  console.log(`  symbol / market / interval   ${manifest.identity.lineage.symbol} / ${manifest.identity.lineage.marketType} / ${manifest.identity.lineage.chartInterval}`);
  console.log(`  context / history            ${manifest.input.htfContextStart} / ${manifest.input.historyStart}`);
  console.log(`  switchover / end             ${manifest.input.compatibilitySwitchover} / ${manifest.input.replayEnd}`);
  console.log(`  network                      ${outcome.fetched ? `${outcome.fetched.requestsMade} public request(s), ${outcome.fetched.rows} rows` : "none (cache only)"}`);
  console.log(`  bootstrap input sha256       ${manifest.input.bootstrapInputSha256}`);
  console.log(`  state sha256 at switchover   ${manifest.bootstrap.stateSha256AtSwitchover}`);
  console.log(`  bootstrap registrations      ${manifest.bootstrap.registrationCount} ${JSON.stringify(manifest.bootstrap.registrationsByTf)}`);
  console.log(`  causal input sha256          ${manifest.input.causalInputSha256}`);
  console.log(`  candidates by basis          ${JSON.stringify(manifest.causalReplay.byBasis)}`);
  console.log(`  immediate by evidence class  ${JSON.stringify(manifest.causalReplay.immediateByClass)}`);
  console.log(`  state sha256 at end          ${manifest.causalReplay.stateSha256AtEnd}`);
  console.log(`  output                       ${outcome.outputPath}`);
  console.log(`  output sha256                ${manifest.output.sha256}`);
  console.log(`  manifest                     ${outcome.manifestPath}`);
}

void main().catch((error: unknown) => {
  if (
    error instanceof ScannerDataError ||
    error instanceof KlineCacheError ||
    error instanceof ScannerPathError ||
    error instanceof CompatReplayError ||
    error instanceof ScannerLineageError
  ) {
    const code = "code" in error ? ` (${String((error as { code: unknown }).code)})` : "";
    console.error(`REFUSED${code}: ${error.message}`);
  } else {
    console.error(`COMPATIBILITY REPLAY FAILED (${error instanceof Error ? error.name : "unknown"})`);
  }
  process.exitCode = 1;
});
