// MUST be the first import. The scanner is a GENERIC process: this refuses to
// start if the environment holds ANY account credential, so a replay can never
// run with Account A/B keys in reach — whichever env file it was launched with.
import "../../config/bootstrap-generic";

import { execFileSync } from "node:child_process";
import path from "node:path";

import { env } from "../../config/env";
import { assertPublicFuturesBaseUrl, ScannerDataError } from "./binance-public-futures";
import { KlineCacheError, KlineCacheStore } from "./kline-cache";
import { fetchClosedFuturesKlines, type PublicHttpTransport } from "./kline-fetcher";
import { executeHistoricalReplay } from "./historical-replay-runner";
import {
  REPLAY_CLI_USAGE,
  REPLAY_PAGE_LIMIT,
  REPLAY_SETTLE_MS,
  ReplayCliUsageError,
  parseReplayCliArgs,
} from "./replay-cli-args";
import { ScannerPathError, assertOutsideRepository, scannerKlineCacheDir, scannerReplayDir } from "./scanner-paths";

/**
 * Historical replay of ONE symbol through the native signal engine.
 *
 *   DOTENV_CONFIG_PATH=<generic env file> \
 *     pnpm --filter @trading-alert-dashboard/backend scanner:replay --symbol BTCUSDT ... [--fetch]
 *
 * Reads public Binance USD-M klines (only with --fetch), keeps them in the
 * machine-local cache, and writes candidate EVIDENCE as JSONL plus a manifest
 * under %LOCALAPPDATA%. It creates no Alert, touches no database, queue or
 * account, and holds no credential. This is the only module in the scanner
 * that may use the real network or the real clock.
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
    options = parseReplayCliArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof ReplayCliUsageError)) throw error;
    console.error(`REFUSED: ${error.message}\n\n${REPLAY_CLI_USAGE}`);
    process.exitCode = 2;
    return;
  }

  const cacheDir = assertOutsideRepository(scannerKlineCacheDir(process.env), REPO_ROOT);
  const replayDir = assertOutsideRepository(scannerReplayDir(process.env), REPO_ROOT);
  const baseUrl = assertPublicFuturesBaseUrl(env.BINANCE_FUTURES_REST_BASE_URL);
  const { policy } = options;

  const outcome = await executeHistoricalReplay(options.request, {
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
  console.log("NATIVE HISTORICAL REPLAY — evidence only. No Alert was created and nothing was traded.");
  console.log(`  symbol / market / interval   ${manifest.symbol} / ${manifest.marketType} / ${manifest.chartInterval}`);
  console.log(`  warmup / output / end        ${manifest.warmupStart} / ${manifest.outputStart} / ${manifest.end}`);
  console.log(`  incomplete at warmup start   ${manifest.incompleteAtWarmupStart.join(",") || "(none)"}`);
  console.log(`  network                      ${outcome.fetched ? `${outcome.fetched.requestsMade} public request(s), ${outcome.fetched.rows} rows` : "none (cache only)"}`);
  console.log(`  replayed bars                ${manifest.input.replayBarCount}  sha256 ${manifest.input.replayBarsSha256}`);
  console.log(`  candidates by basis          ${JSON.stringify(manifest.counts.byBasis)}`);
  console.log(`  immediate by evidence class  ${JSON.stringify(manifest.counts.immediateByClass)}`);
  console.log(`  excluded during warmup       ${JSON.stringify(manifest.warmupCandidatesExcluded)}`);
  console.log(`  output                       ${outcome.outputPath}`);
  console.log(`  output sha256                ${manifest.output.sha256}`);
  console.log(`  manifest                     ${outcome.manifestPath}`);
}

void main().catch((error: unknown) => {
  if (
    error instanceof ScannerDataError ||
    error instanceof KlineCacheError ||
    error instanceof ScannerPathError
  ) {
    const code = "code" in error ? ` (${String((error as { code: unknown }).code)})` : "";
    console.error(`REFUSED${code}: ${error.message}`);
  } else {
    console.error(`REPLAY FAILED (${error instanceof Error ? error.name : "unknown"})`);
  }
  process.exitCode = 1;
});
