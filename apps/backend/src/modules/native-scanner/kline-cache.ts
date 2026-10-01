import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { NativeKline } from "@trading-alert-dashboard/shared";

import {
  ScannerDataError,
  assertClosedKlineGeometry,
  assertScannerSymbol,
  intervalMsOf,
  type ScannerChartInterval,
  type ScannerMarketType,
} from "./binance-public-futures";

/**
 * The scanner's machine-local store of CLOSED klines.
 *
 * Closed klines are immutable, so a cache is safe — but only if it can never
 * quietly become something else. Every row is canonical, keyed by openTime and
 * sorted; the file's SHA-256 is pinned in a manifest; and every failure to
 * prove that on load is a refusal, never a warning. A replay is only as
 * reproducible as the bytes it read.
 */

export const KLINE_CACHE_SCHEMA = "teddy.native-scanner.kline-cache.v1";

export type KlineCacheErrorCode = "CACHE_CORRUPT" | "CACHE_INTEGRITY_MISMATCH";

export class KlineCacheError extends Error {
  constructor(
    readonly code: KlineCacheErrorCode,
    message: string
  ) {
    super(message);
    this.name = "KlineCacheError";
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** One canonical line: `[openTimeMs,closeTimeMs,open,high,low,close]`. */
function canonicalLine(kline: NativeKline): string {
  return JSON.stringify([kline.openTimeMs, kline.closeTimeMs, kline.open, kline.high, kline.low, kline.close]);
}

/** The canonical byte form of a kline sequence: one line each, LF-terminated. */
export function serializeKlines(klines: readonly NativeKline[]): string {
  return klines.map((kline) => `${canonicalLine(kline)}\n`).join("");
}

function sameKline(a: NativeKline, b: NativeKline): boolean {
  return (
    a.openTimeMs === b.openTimeMs &&
    a.closeTimeMs === b.closeTimeMs &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close
  );
}

/**
 * Merges two sets of closed klines by openTime.
 *
 * An identical row seen twice is one row. The same openTime with ANY different
 * field is a contradiction about an immutable candle, and nothing downstream
 * can be trusted after one — so it throws rather than picking a side.
 */
export function mergeClosedKlines(existing: readonly NativeKline[], incoming: readonly NativeKline[]): NativeKline[] {
  const byOpen = new Map<number, NativeKline>();
  for (const kline of [...existing, ...incoming]) {
    const seen = byOpen.get(kline.openTimeMs);
    if (seen === undefined) {
      byOpen.set(kline.openTimeMs, kline);
    } else if (!sameKline(seen, kline)) {
      throw new ScannerDataError(
        "CONTRADICTORY_ROW",
        `two different candles claim openTime ${new Date(kline.openTimeMs).toISOString()}`
      );
    }
  }
  return [...byOpen.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
}

export interface KlineGap {
  /** openTime of the last bar before the gap. */
  readonly afterOpenTimeMs: number;
  /** openTime of the first bar after the gap. */
  readonly nextOpenTimeMs: number;
  readonly missingBars: number;
}

/** Every break in a sorted kline sequence. */
export function findKlineGaps(klines: readonly NativeKline[], intervalMs: number): KlineGap[] {
  const gaps: KlineGap[] = [];
  for (let i = 1; i < klines.length; i += 1) {
    const expected = klines[i - 1].openTimeMs + intervalMs;
    if (klines[i].openTimeMs !== expected) {
      gaps.push({
        afterOpenTimeMs: klines[i - 1].openTimeMs,
        nextOpenTimeMs: klines[i].openTimeMs,
        missingBars: (klines[i].openTimeMs - expected) / intervalMs,
      });
    }
  }
  return gaps;
}

function corrupt(message: string): never {
  throw new KlineCacheError("CACHE_CORRUPT", message);
}

/**
 * Parses cached rows, accepting ONLY the canonical form.
 *
 * Re-serialising and comparing is the strictest available check: any edit,
 * reordering, duplicate, stray whitespace or line-ending change is caught, not
 * tolerated.
 */
export function parseCachedKlines(text: string, intervalMs: number): NativeKline[] {
  if (text !== "" && !text.endsWith("\n")) corrupt("cache rows must end with a newline");
  const lines = text === "" ? [] : text.slice(0, -1).split("\n");
  const klines: NativeKline[] = [];
  for (const [index, line] of lines.entries()) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      corrupt(`cache row ${index + 1} is not JSON`);
    }
    if (!Array.isArray(row) || row.length !== 6) corrupt(`cache row ${index + 1} must have 6 fields`);
    const [openTimeMs, closeTimeMs, open, high, low, close] = row as number[];
    const kline: NativeKline = { openTimeMs, closeTimeMs, open, high, low, close };
    try {
      assertClosedKlineGeometry(kline, intervalMs);
    } catch (error) {
      corrupt(`cache row ${index + 1} is not a valid closed candle (${(error as Error).message})`);
    }
    if (klines.length > 0 && openTimeMs <= klines[klines.length - 1].openTimeMs) {
      corrupt(`cache row ${index + 1} is out of order or duplicated`);
    }
    klines.push(kline);
  }
  if (serializeKlines(klines) !== text) corrupt("cache rows are not in canonical form");
  return klines;
}

export interface KlineCacheManifest {
  readonly schema: typeof KLINE_CACHE_SCHEMA;
  readonly marketType: ScannerMarketType;
  readonly symbol: string;
  readonly interval: ScannerChartInterval;
  readonly rowCount: number;
  readonly firstOpenTime: string | null;
  readonly lastOpenTime: string | null;
  readonly gapCount: number;
  /** SHA-256 of the exact bytes of klines.jsonl. */
  readonly sha256: string;
  /** When this cache was last written. Provenance only; never hashed. */
  readonly writtenAt: string;
}

export interface LoadedKlineCache {
  readonly klines: NativeKline[];
  readonly manifest: KlineCacheManifest;
}

function writeAtomically(file: string, text: string): void {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, text, "utf8");
  renameSync(temporary, file);
}

/**
 * The file-backed cache, rooted wherever the caller says.
 *
 * Layout: `<root>/<marketType>/<SYMBOL>/<interval>/{klines.jsonl,manifest.json}`.
 * The production root is under %LOCALAPPDATA% (see scanner-paths.ts); tests
 * pass a private temporary directory.
 */
export class KlineCacheStore {
  constructor(readonly rootDir: string) {}

  pathsFor(marketType: ScannerMarketType, symbol: string, interval: ScannerChartInterval) {
    const dir = path.join(this.rootDir, marketType, assertScannerSymbol(symbol), interval);
    return { dir, rows: path.join(dir, "klines.jsonl"), manifest: path.join(dir, "manifest.json") };
  }

  /** The verified cache, or null when none exists. Anything partial or inconsistent throws. */
  load(marketType: ScannerMarketType, symbol: string, interval: ScannerChartInterval): LoadedKlineCache | null {
    const paths = this.pathsFor(marketType, symbol, interval);
    const hasRows = existsSync(paths.rows);
    const hasManifest = existsSync(paths.manifest);
    if (!hasRows && !hasManifest) return null;
    if (!hasRows || !hasManifest) corrupt("cache has rows without a manifest, or a manifest without rows");

    const text = readFileSync(paths.rows, "utf8");
    let manifest: KlineCacheManifest;
    try {
      manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as KlineCacheManifest;
    } catch {
      corrupt("cache manifest is not JSON");
    }
    if (
      manifest.schema !== KLINE_CACHE_SCHEMA ||
      manifest.marketType !== marketType ||
      manifest.symbol !== symbol ||
      manifest.interval !== interval
    ) {
      corrupt("cache manifest does not describe this market, symbol and interval");
    }
    if (sha256Hex(text) !== manifest.sha256) {
      throw new KlineCacheError("CACHE_INTEGRITY_MISMATCH", "cache rows do not match the manifest hash");
    }
    const klines = parseCachedKlines(text, intervalMsOf(interval));
    if (klines.length !== manifest.rowCount) corrupt("cache row count does not match the manifest");
    return { klines, manifest };
  }

  /** Writes rows first, then the manifest; a crash in between leaves a mismatch that load() refuses. */
  save(
    marketType: ScannerMarketType,
    symbol: string,
    interval: ScannerChartInterval,
    klines: readonly NativeKline[],
    writtenAt: string
  ): KlineCacheManifest {
    const intervalMs = intervalMsOf(interval);
    for (const kline of klines) assertClosedKlineGeometry(kline, intervalMs);
    const sorted = mergeClosedKlines([], klines);
    const text = serializeKlines(sorted);
    const manifest: KlineCacheManifest = {
      schema: KLINE_CACHE_SCHEMA,
      marketType,
      symbol,
      interval,
      rowCount: sorted.length,
      firstOpenTime: sorted.length > 0 ? new Date(sorted[0].openTimeMs).toISOString() : null,
      lastOpenTime: sorted.length > 0 ? new Date(sorted[sorted.length - 1].openTimeMs).toISOString() : null,
      gapCount: findKlineGaps(sorted, intervalMs).length,
      sha256: sha256Hex(text),
      writtenAt,
    };
    const paths = this.pathsFor(marketType, symbol, interval);
    mkdirSync(paths.dir, { recursive: true });
    writeAtomically(paths.rows, text);
    writeAtomically(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }
}
