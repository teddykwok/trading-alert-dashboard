import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ScannerDataError } from "../src/modules/native-scanner/binance-public-futures";
import {
  KlineCacheError,
  KlineCacheStore,
  findKlineGaps,
  mergeClosedKlines,
  parseCachedKlines,
  serializeKlines,
  sha256Hex,
} from "../src/modules/native-scanner/kline-cache";
import { FIFTEEN_MINUTES_MS as I, T_2025_01_01, forbidRealNetwork, plainKlines } from "./helpers/native-scanner-fakes";

/**
 * Slice 2A — the closed-kline cache. Written only inside a private temporary
 * directory, removed afterwards; the machine-local scanner directory is never
 * touched by a test.
 */

let restoreNetwork: () => void;
let root: string;
beforeAll(() => {
  restoreNetwork = forbidRealNetwork();
  root = mkdtempSync(path.join(tmpdir(), "native-scanner-cache-"));
});
afterAll(() => {
  restoreNetwork();
  rmSync(root, { recursive: true, force: true });
});

const M = "USDM_PERPETUAL" as const;
const AT = "2026-10-01T00:00:00.000Z";
let seq = 0;
/** A fresh store per test, so tests never see each other's files. */
const freshStore = () => new KlineCacheStore(path.join(root, `case-${(seq += 1)}`));

function codeOf(thunk: () => unknown): string | null {
  try {
    thunk();
    return null;
  } catch (error) {
    if (error instanceof KlineCacheError || error instanceof ScannerDataError) return error.code;
    return `unexpected: ${String(error)}`;
  }
}

const data = plainKlines(T_2025_01_01, 300);

describe("closed-kline cache", () => {
  // 20.
  it("round-trips exactly: canonical bytes, pinned hash, identical klines", () => {
    const store = freshStore();
    const manifest = store.save(M, "BTCUSDT", "15m", data, AT);
    const paths = store.pathsFor(M, "BTCUSDT", "15m");
    const bytes = readFileSync(paths.rows, "utf8");
    expect(bytes).toBe(serializeKlines(data));
    expect(manifest).toMatchObject({
      rowCount: 300,
      sha256: sha256Hex(bytes),
      gapCount: 0,
      firstOpenTime: new Date(T_2025_01_01).toISOString(),
      lastOpenTime: new Date(T_2025_01_01 + 299 * I).toISOString(),
    });
    expect(store.load(M, "BTCUSDT", "15m")).toEqual({ klines: data, manifest });
  });

  it("has nothing to load when nothing was ever written", () => {
    expect(freshStore().load(M, "BTCUSDT", "15m")).toBeNull();
  });

  // 21.
  it("merges by openTime into one sorted sequence", () => {
    const merged = mergeClosedKlines(data.slice(0, 200), [...data.slice(150, 300)].reverse());
    expect(merged).toEqual(data);
  });

  // 22.
  it("an exact duplicate is a no-op, in memory and on disk", () => {
    expect(mergeClosedKlines(data, data)).toEqual(data);
    const store = freshStore();
    const first = store.save(M, "BTCUSDT", "15m", data, AT);
    const again = store.save(M, "BTCUSDT", "15m", mergeClosedKlines(store.load(M, "BTCUSDT", "15m")!.klines, data), AT);
    expect(again.sha256).toBe(first.sha256);
  });

  // 23.
  it.each([
    ["close", { close: data[10].close + 0.01 }],
    ["high", { high: data[10].high + 1 }],
    ["closeTime", { closeTimeMs: data[10].closeTimeMs - 1 }],
  ])("refuses the same openTime with a different %s", (_label, patch) => {
    expect(codeOf(() => mergeClosedKlines(data, [{ ...data[10], ...patch }]))).toBe("CONTRADICTORY_ROW");
  });

  // 24.
  it("finds every gap and records the count", () => {
    const holed = [...data.slice(0, 100), ...data.slice(103, 200), ...data.slice(201)];
    expect(findKlineGaps(holed, I)).toEqual([
      { afterOpenTimeMs: data[99].openTimeMs, nextOpenTimeMs: data[103].openTimeMs, missingBars: 3 },
      { afterOpenTimeMs: data[199].openTimeMs, nextOpenTimeMs: data[201].openTimeMs, missingBars: 1 },
    ]);
    expect(freshStore().save(M, "BTCUSDT", "15m", holed, AT).gapCount).toBe(2);
  });

  // 25.
  it("refuses rows that no longer match the manifest hash", () => {
    const store = freshStore();
    store.save(M, "BTCUSDT", "15m", data, AT);
    const paths = store.pathsFor(M, "BTCUSDT", "15m");
    const bytes = readFileSync(paths.rows, "utf8");
    writeFileSync(paths.rows, bytes.replace(String(data[5].close), String(data[5].close + 0.001)));
    expect(codeOf(() => store.load(M, "BTCUSDT", "15m"))).toBe("CACHE_INTEGRITY_MISMATCH");
  });

  it("refuses a manifest whose hash was altered", () => {
    const store = freshStore();
    store.save(M, "BTCUSDT", "15m", data, AT);
    const paths = store.pathsFor(M, "BTCUSDT", "15m");
    const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
    writeFileSync(paths.manifest, JSON.stringify({ ...manifest, sha256: "0".repeat(64) }));
    expect(codeOf(() => store.load(M, "BTCUSDT", "15m"))).toBe("CACHE_INTEGRITY_MISMATCH");
  });

  // 26. Each case re-pins the hash so only the content check can catch it.
  it.each([
    ["non-canonical whitespace", (rows: string) => rows.replace("],", "] ,").replace(",", ", ")],
    ["CRLF line endings", (rows: string) => rows.replace(/\n/g, "\r\n")],
    ["a missing trailing newline", (rows: string) => rows.slice(0, -1)],
    ["rows out of order", (rows: string) => { const l = rows.slice(0, -1).split("\n"); [l[0], l[1]] = [l[1], l[0]]; return `${l.join("\n")}\n`; }],
    ["a duplicated row", (rows: string) => { const l = rows.slice(0, -1).split("\n"); return `${[l[0], ...l].join("\n")}\n`; }],
    ["a non-JSON row", (rows: string) => `oops\n${rows}`],
    ["a row of the wrong width", (rows: string) => rows.replace(/^\[([^\]]*)\]/, "[$1,1]")],
    ["impossible geometry", (rows: string) => { const l = rows.slice(0, -1).split("\n"); const r = JSON.parse(l[0]); r[3] = r[4] - 1; l[0] = JSON.stringify(r); return `${l.join("\n")}\n`; }],
  ])("refuses a malformed cache: %s", (_label, mutate) => {
    const store = freshStore();
    store.save(M, "BTCUSDT", "15m", data, AT);
    const paths = store.pathsFor(M, "BTCUSDT", "15m");
    const rows = mutate(readFileSync(paths.rows, "utf8"));
    writeFileSync(paths.rows, rows);
    const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
    writeFileSync(paths.manifest, JSON.stringify({ ...manifest, sha256: sha256Hex(rows) }));
    expect(codeOf(() => store.load(M, "BTCUSDT", "15m"))).toBe("CACHE_CORRUPT");
  });

  it.each([
    ["rows without a manifest", (p: { rows: string; manifest: string }) => rmSync(p.manifest)],
    ["a manifest without rows", (p: { rows: string; manifest: string }) => rmSync(p.rows)],
    ["a manifest that is not JSON", (p: { rows: string; manifest: string }) => writeFileSync(p.manifest, "{")],
    ["a manifest for another symbol", (p: { rows: string; manifest: string }) => {
      const m = JSON.parse(readFileSync(p.manifest, "utf8"));
      writeFileSync(p.manifest, JSON.stringify({ ...m, symbol: "ETHUSDT" }));
    }],
    ["a row count that disagrees", (p: { rows: string; manifest: string }) => {
      const m = JSON.parse(readFileSync(p.manifest, "utf8"));
      writeFileSync(p.manifest, JSON.stringify({ ...m, rowCount: m.rowCount + 1 }));
    }],
  ])("refuses %s", (_label, damage) => {
    const store = freshStore();
    store.save(M, "BTCUSDT", "15m", data, AT);
    damage(store.pathsFor(M, "BTCUSDT", "15m"));
    expect(codeOf(() => store.load(M, "BTCUSDT", "15m"))).toBe("CACHE_CORRUPT");
  });

  it("refuses to save a contradiction or an invalid candle, leaving the previous cache intact", () => {
    const store = freshStore();
    const before = store.save(M, "BTCUSDT", "15m", data, AT);
    expect(codeOf(() => store.save(M, "BTCUSDT", "15m", [...data, { ...data[3], low: data[3].low - 1 }], AT))).toBe(
      "CONTRADICTORY_ROW"
    );
    expect(codeOf(() => store.save(M, "BTCUSDT", "15m", [{ ...data[0], high: data[0].low - 1 }], AT))).toBe("MALFORMED_ROW");
    expect(store.load(M, "BTCUSDT", "15m")?.manifest.sha256).toBe(before.sha256);
  });

  it("cannot be steered outside its root by a symbol", () => {
    expect(codeOf(() => freshStore().pathsFor(M, "../../etc", "15m"))).toBe("INVALID_SYMBOL");
  });

  it("parses only the canonical form directly as well", () => {
    expect(parseCachedKlines(serializeKlines(data), I)).toEqual(data);
    expect(parseCachedKlines("", I)).toEqual([]);
  });
});
