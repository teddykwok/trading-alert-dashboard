import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ScannerDataError } from "./binance-public-futures";
import {
  buildCompatReplayManifest,
  compatReplayRanges,
  hasCompleteCompatRange,
  runCompatibilityReplay,
  selectCompatReplayBars,
  CompatReplayError,
  type CompatReplayManifest,
  type CompatReplayRequest,
} from "./compat-replay";
import type { ReplayRunnerDeps } from "./historical-replay-runner";
import { mergeClosedKlines } from "./kline-cache";

/**
 * Cache -> (optional fetch) -> compatibility replay -> evidence files.
 *
 * Every side effect is a dependency, exactly as for the causal replay runner:
 * with no fetcher the run is cache-only and cannot reach the network at all.
 * A fetch, when explicitly enabled, goes through Slice 2A's hardened public
 * kline fetcher and starts at htfContextStart, never later.
 */

export interface CompatRunOutcome {
  readonly manifest: CompatReplayManifest;
  readonly outputPath: string;
  readonly manifestPath: string;
  readonly fetched: { readonly requestsMade: number; readonly rows: number } | null;
}

export async function executeCompatibilityReplay(request: CompatReplayRequest, deps: ReplayRunnerDeps): Promise<CompatRunOutcome> {
  const { marketType, symbol, chartInterval } = request;
  const ranges = compatReplayRanges(request);
  let loaded = deps.cache.load(marketType, symbol, chartInterval);
  let fetched: CompatRunOutcome["fetched"] = null;

  if (loaded === null || !hasCompleteCompatRange(loaded.klines, request)) {
    if (deps.fetchRange === null) {
      if (loaded !== null) selectCompatReplayBars(loaded.klines, request); // throws the precise refusal
      throw new CompatReplayError(
        "INCOMPLETE_DATA",
        `no local cache holds ${symbol}; it needs every bar from ${new Date(ranges.htfContextStartMs).toISOString()} — rerun with --fetch`
      );
    }
    const result = await deps.fetchRange({
      symbol,
      interval: chartInterval,
      startMs: ranges.htfContextStartMs,
      endMs: ranges.endMs,
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

  const result = runCompatibilityReplay(loaded.klines, request);
  const createdAt = deps.nowIso();
  const dir = path.join(deps.outputDir, marketType, symbol, chartInterval);
  const base = `compat-${createdAt.replace(/[-:.]/g, "")}-${result.outputSha256.slice(0, 12)}`;
  const outputPath = path.join(dir, `${base}.jsonl`);
  const manifestPath = path.join(dir, `${base}.manifest.json`);
  const manifest = buildCompatReplayManifest(result, {
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
