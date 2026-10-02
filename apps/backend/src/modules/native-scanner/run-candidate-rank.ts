// MUST be the first import. The ranker is a GENERIC process: this refuses to
// start if the environment holds ANY account credential.
import "../../config/bootstrap-generic";

import path from "node:path";

import { env } from "../../config/env";
import { ScannerDataError, assertPublicFuturesBaseUrl } from "./binance-public-futures";
import { CandidateRankCliUsageError, CANDIDATE_RANK_CLI_USAGE, parseCandidateRankCliArgs } from "./candidate-rank-cli-args";
import { CandidateRankHaltError, runCandidateRank } from "./candidate-rank-runner";
import { CANDIDATE_RANK_NOTICE, formatCandidateTable } from "./candidate-ranker";
import { KlineCacheStore } from "./kline-cache";
import type { PublicHttpTransport } from "./kline-fetcher";
import { ScannerPathError, assertOutsideRepository, scannerKlineCacheDir } from "./scanner-paths";
import { UniverseSelectionError } from "./usdm-universe";

/**
 * READ-ONLY CANDIDATE RANKING over the Binance USD-M USDT-perpetual universe.
 *
 *   DOTENV_CONFIG_PATH=<generic env file> \
 *     pnpm --filter @trading-alert-dashboard/backend scanner:candidate-rank --universe usdt-perpetual ... [--json]
 *
 * Public market data only. It writes the public kline cache and prints a
 * ranking; it creates no Alert, touches no database, queue or account, holds
 * no credential and calls no signed endpoint. This entrypoint is the only place
 * the ranker uses the real network, the real clock or timers.
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  let options;
  try {
    options = parseCandidateRankCliArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof CandidateRankCliUsageError)) throw error;
    console.error(`REFUSED: ${error.message}\n\n${CANDIDATE_RANK_CLI_USAGE}`);
    process.exitCode = 2;
    return;
  }
  // In --json mode stdout carries the report only; everything else goes to stderr.
  const say = options.json ? (line: string) => console.error(line) : (line: string) => console.log(line);
  for (const line of CANDIDATE_RANK_NOTICE) say(line);

  const cache = new KlineCacheStore(assertOutsideRepository(scannerKlineCacheDir(process.env), REPO_ROOT));
  const startedMs = Date.now();
  const report = await runCandidateRank(options.request, {
    transport: publicTransport,
    baseUrl: assertPublicFuturesBaseUrl(env.BINANCE_FUTURES_REST_BASE_URL),
    maxTotalRequests: options.maxTotalRequests,
    minSpacingMs: options.minSpacingMs,
    cache,
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    sleep,
    log: (line) => say(line),
  });
  const elapsedS = ((Date.now() - startedMs) / 1000).toFixed(1);

  if (options.json) {
    console.log(JSON.stringify({ ...report, elapsedSeconds: Number(elapsedS) }, null, 2));
    return;
  }
  if (!("candidates" in report)) {
    for (const c of report.contracts) console.log(`  ${c.symbol.padEnd(16)} base ${c.baseAsset.padEnd(10)} ${c.contractType} ${c.status}`);
    console.log(`requests ${report.requests.made}; elapsed ${elapsedS}s`);
    return;
  }
  console.log("");
  console.log(`config ${report.config.signal.sha256}; delivery TFs ${report.config.ranking.deliverySourceTfs.join(",")}${report.config.deliverySourceTfsAreNativeDeliveryV1 ? " (NATIVE_DELIVERY_V1)" : " (NOT the delivery policy)"}`);
  console.log(`committed through ${report.committedState.lastCommittedBarOpenTime}; evaluated for forming bar ${report.committedState.evaluatedForFormingBarOpenTime}`);
  console.log(`price: ${report.price.source}, latest ${report.price.latestObservedAt ?? "n/a"} (advisory; ${report.price.barsAfterEvaluatedBar ?? 0} bar(s) after the evaluated bar)`);
  console.log("");
  for (const line of formatCandidateTable(report.candidates)) console.log(line);
  if (report.candidates.length === 0) console.log("(no candidates)");
  console.log("");
  console.log(`selected ${report.counts.selected}; evaluated ${report.counts.evaluated}; rankable symbols ${report.counts.rankableSymbols}; skipped ${report.counts.skipped}`);
  console.log(`skipped by reason ${JSON.stringify(report.counts.skippedByReason)}`);
  console.log(`requests ${report.requests.made}/${report.requests.budget} (spacing ${report.requests.minSpacingMs} ms); cache-only symbols ${report.counts.symbolsServedFromCacheOnly}; elapsed ${elapsedS}s`);
  for (const line of CANDIDATE_RANK_NOTICE) console.log(line);
}

void main().catch((error: unknown) => {
  if (error instanceof CandidateRankHaltError || error instanceof ScannerDataError || error instanceof ScannerPathError || error instanceof UniverseSelectionError) {
    const code = "code" in error ? ` (${String((error as { code: unknown }).code)})` : "";
    console.error(`REFUSED${code}: ${error.message}`);
  } else {
    console.error(`CANDIDATE RANK FAILED (${error instanceof Error ? error.name : "unknown"})`);
  }
  process.exitCode = 1;
});
