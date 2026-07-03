import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetType } from "@prisma/client";

/**
 * MARKET_DATA_FALLBACK_TO_MOCK is read once at module load time in
 * config/env.ts, so exercising both branches means mutating process.env and
 * forcing a fresh import via vi.resetModules() between assertions.
 */

const originalFetch = global.fetch;
const originalFallbackEnv = process.env.MARKET_DATA_FALLBACK_TO_MOCK;

function mockFetchAlwaysFails() {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status: 500,
    text: async () => "Internal Server Error",
    json: async () => ({ msg: "Internal Server Error" }),
  }) as unknown as typeof fetch;
}

afterEach(() => {
  global.fetch = originalFetch;
  if (originalFallbackEnv === undefined) {
    delete process.env.MARKET_DATA_FALLBACK_TO_MOCK;
  } else {
    process.env.MARKET_DATA_FALLBACK_TO_MOCK = originalFallbackEnv;
  }
  vi.resetModules();
});

describe("market-data.service fallback behavior", () => {
  it("falls back to mock candles when MARKET_DATA_FALLBACK_TO_MOCK=true and Binance fails", async () => {
    process.env.MARKET_DATA_FALLBACK_TO_MOCK = "true";
    vi.resetModules();
    mockFetchAlwaysFails();

    const { getRecentCandles } = await import("../src/modules/market-data/market-data.service");
    const candles = await getRecentCandles("CRYPTO" as AssetType, "BTCUSDT", "1h", 64200, "BINANCE");

    expect(candles.length).toBeGreaterThan(0);
    expect(candles[candles.length - 1].close).toBeCloseTo(64200, 0);
  });

  it("rethrows a 'Market data fetch failed' error when MARKET_DATA_FALLBACK_TO_MOCK=false (default)", async () => {
    process.env.MARKET_DATA_FALLBACK_TO_MOCK = "false";
    vi.resetModules();
    mockFetchAlwaysFails();

    const { getRecentCandles } = await import("../src/modules/market-data/market-data.service");

    await expect(
      getRecentCandles("CRYPTO" as AssetType, "BTCUSDT", "1h", 64200, "BINANCE")
    ).rejects.toThrow("Market data fetch failed:");
  });
});
