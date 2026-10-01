import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ScannerDataError } from "./binance-public-futures";
import { mergeClosedKlines, type KlineCacheStore } from "./kline-cache";
import type { ClosedKlineRangeRequest, ClosedKlineRangeResult } from "./kline-fetcher";
import {
  buildReplayManifest,
  runHistoricalReplay,
  selectReplayBars,
  type HistoricalReplayRequest,
  type ReplayManifest,
} from "./historical-replay";

/**
 * Cache -> (optional fetch) -> replay -> evidence files.
 *
 * Every side effect is a dependency: the cache store, the fetcher, the output
 * directory, the clock and the git identity. With no fetcher the run is
 * cache-only and cannot reach the network at all.
 */

export interface ReplayRunnerDeps {
  readonly cache: KlineCacheStore;
  /** Null = cache-only. */
  readonly fetchRange: ((request: ClosedKlineRangeRequest) => Promise<ClosedKlineRangeResult>) | null;
  readonly outputDir: string;
  /** Provenance only. */
  readonly nowIso: () => string;
  readonly gitHead: string;
  readonly gitWorktreeClean: boolean;
  readonly maxBars: number;
  readonly pageLimit: number;
  readonly settleMs: number;
}

export interface ReplayRunOutcome {
  readonly manifest: ReplayManifest;
  readonly outputPath: string;
  readonly manifestPath: string;
  readonly fetched: { readonly requestsMade: number; readonly rows: number } | null;
}

export async function executeHistoricalReplay(
  request: HistoricalReplayRequest,
  deps: ReplayRunnerDeps
): Promise<ReplayRunOutcome> {
  const { marketType, symbol, chartInterval } = request;
  let loaded = deps.cache.load(marketType, symbol, chartInterval);
  let fetched: ReplayRunOutcome["fetched"] = null;

  if (loaded === null || selectReplayBars(loaded.klines, request) === null) {
    if (deps.fetchRange === null) {
      throw new ScannerDataError(
        "INVALID_RANGE",
        "the local cache does not hold every bar of the requested range; rerun with --fetch to fetch it"
      );
    }
    const result = await deps.fetchRange({
      symbol,
      interval: chartInterval,
      startMs: request.warmupStartMs,
      endMs: request.endMs,
      maxBars: deps.maxBars,
      pageLimit: deps.pageLimit,
      settleMs: deps.settleMs,
    });
    fetched = { requestsMade: result.requestsMade, rows: result.klines.length };
    // A contradiction with anything already cached stops the run here.
    const merged = mergeClosedKlines(loaded?.klines ?? [], result.klines);
    deps.cache.save(marketType, symbol, chartInterval, merged, deps.nowIso());
    // Re-read from disk: the replay consumes the verified cache, never memory.
    loaded = deps.cache.load(marketType, symbol, chartInterval);
    if (loaded === null) throw new ScannerDataError("MALFORMED_RESPONSE", "the cache could not be read back after writing");
  }

  const result = runHistoricalReplay(loaded.klines, request);
  const createdAt = deps.nowIso();
  const dir = path.join(deps.outputDir, marketType, symbol, chartInterval);
  const base = `replay-${createdAt.replace(/[-:.]/g, "")}-${result.outputSha256.slice(0, 12)}`;
  const outputPath = path.join(dir, `${base}.jsonl`);
  const manifestPath = path.join(dir, `${base}.manifest.json`);
  const manifest = buildReplayManifest(request, result, {
    createdAt,
    gitHead: deps.gitHead,
    gitWorktreeClean: deps.gitWorktreeClean,
    cacheSha256: loaded.manifest.sha256,
    cacheRowCount: loaded.manifest.rowCount,
    outputFile: path.basename(outputPath),
  });

  mkdirSync(dir, { recursive: true });
  // "wx": an existing file is never overwritten.
  writeFileSync(outputPath, result.jsonl, { encoding: "utf8", flag: "wx" });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { manifest, outputPath, manifestPath, fetched };
}
