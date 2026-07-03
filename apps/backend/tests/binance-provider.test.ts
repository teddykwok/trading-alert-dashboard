import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BinanceProvider } from "../src/modules/market-data/binance.provider";

function makeKline(openTimeMs: number, open: string, high: string, low: string, close: string, volume: string) {
  return [
    openTimeMs,
    open,
    high,
    low,
    close,
    volume,
    openTimeMs + 3_599_999, // close time
    "1000000.00", // quote asset volume
    500, // number of trades
    "10.0", // taker buy base volume
    "500000.0", // taker buy quote volume
    "0", // ignore
  ];
}

const SAMPLE_KLINES = [
  makeKline(1_700_000_000_000, "64000.00", "64500.00", "63800.00", "64200.00", "123.456"),
  makeKline(1_700_003_600_000, "64200.00", "64700.00", "64100.00", "64550.00", "98.7"),
];

const originalFetch = global.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetchOk(body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch;
}

function mockFetchError(status: number, body: string) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  }) as unknown as typeof fetch;
}

describe("BinanceProvider", () => {
  it("converts Binance kline response into Candle objects correctly", async () => {
    mockFetchOk(SAMPLE_KLINES);
    const provider = new BinanceProvider();

    const candles = await provider.getRecentCandles("BTCUSDT", "1h", 64200);

    expect(candles).toEqual([
      { time: 1_700_000_000, open: 64000, high: 64500, low: 63800, close: 64200, volume: 123.456 },
      { time: 1_700_003_600, open: 64200, high: 64700, low: 64100, close: 64550, volume: 98.7 },
    ]);
  });

  it("requests the correct symbol, interval, and default limit", async () => {
    mockFetchOk(SAMPLE_KLINES);
    const provider = new BinanceProvider();

    await provider.getRecentCandles("ETHUSDT", "4h", 3500);

    const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/v3/klines");
    expect(calledUrl).toContain("symbol=ETHUSDT");
    expect(calledUrl).toContain("interval=4h");
    expect(calledUrl).toContain("limit=120");
  });

  it("throws on an unsupported interval without making a network request", async () => {
    global.fetch = vi.fn();
    const provider = new BinanceProvider();

    await expect(provider.getRecentCandles("BTCUSDT", "30m", 64200)).rejects.toThrow(
      "Unsupported Binance interval: 30m"
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("throws a clear error on a non-2xx response", async () => {
    mockFetchError(400, JSON.stringify({ code: -1121, msg: "Invalid symbol." }));
    const provider = new BinanceProvider();

    await expect(provider.getRecentCandles("NOTREAL", "1h", 100)).rejects.toThrow(/status 400/);
  });
});
