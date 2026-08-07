import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BinanceReadOnlyClient } from "../src/modules/binance/binance.client";
import { BinanceReadOnlyService } from "../src/modules/binance/binance-read-only.service";
import { validateCanarySymbol } from "../src/modules/execution/canary-symbol-validation";

/**
 * Phase 11B.0 — canary symbol validation.
 *
 * Real client, real endpoint selection, real signing, real response parsing.
 * ONLY the network is faked, so "GET" here means the code actually chose GET
 * rather than a test asserting its own stub.
 *
 * The case that motivated this: the literal placeholder `<SYMBOL>` was accepted
 * and written into the real profile's `allowedSymbols`.
 */

interface RecordedRequest {
  method: string;
  path: string;
  symbol: string | null;
}

let recorded: RecordedRequest[] = [];

/** exchangeInfo rows keyed by symbol. Absent key = not listed. */
let listing: Record<string, unknown> = {};

function symbolRow(symbol: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    symbol,
    status: "TRADING",
    contractType: "PERPETUAL",
    orderTypes: ["LIMIT", "MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET"],
    timeInForce: ["GTC", "IOC", "FOK", "GTX"],
    filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.10", minPrice: "0.10", maxPrice: "4000000" },
      { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" },
      { filterType: "MARKET_LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "100" },
      { filterType: "MIN_NOTIONAL", notional: "5" },
    ],
    ...overrides,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  recorded = [];
  listing = { BTCUSDT: symbolRow("BTCUSDT"), ETHUSDT: symbolRow("ETHUSDT") };

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const symbol = url.searchParams.get("symbol");
    recorded.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, symbol });

    if (url.pathname === "/fapi/v1/time") return json({ serverTime: Date.now() });
    if (url.pathname === "/fapi/v1/ping") return json({});
    if (url.pathname === "/fapi/v1/exchangeInfo") {
      const rows = symbol ? [listing[symbol]].filter(Boolean) : Object.values(listing);
      return json({ symbols: rows });
    }
    if (url.pathname === "/fapi/v1/leverageBracket") {
      return json([{ symbol, brackets: [{ bracket: 1, initialLeverage: 125, notionalCap: 50000 }] }]);
    }
    if (url.pathname === "/fapi/v1/symbolConfig") return json([]);
    return json({});
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function validator(): BinanceReadOnlyService {
  return new BinanceReadOnlyService(
    new BinanceReadOnlyClient({
      baseUrl: "https://testnet.binancefuture.com",
      apiKey: "test-key",
      apiSecret: "test-secret",
      enabled: true,
    })
  );
}

describe("canary symbol validation", () => {
  it("accepts a listed, tradable perpetual", async () => {
    const result = await validateCanarySymbol("BTCUSDT", validator());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.symbol).toBe("BTCUSDT");
      expect(result.filters.stepSize).toBe("0.001");
    }
  });

  it("rejects the literal placeholder <SYMBOL> without asking the exchange", async () => {
    const result = await validateCanarySymbol("<SYMBOL>", validator());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("CANARY_SYMBOL_MALFORMED");
    // Malformed input never reaches the network at all.
    expect(recorded).toEqual([]);
  });

  it("rejects other template and punctuation shapes", async () => {
    for (const candidate of ["{{ticker}}", "$SYMBOL", "BTC-USDT", "btc usdt", "", "   ", "SYM"]) {
      const result = await validateCanarySymbol(candidate, validator());
      expect(`${candidate}:${result.ok}`).toBe(`${candidate}:false`);
    }
  });

  it("rejects a symbol Binance does not list", async () => {
    const result = await validateCanarySymbol("FOOBAR", validator());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("CANARY_SYMBOL_NOT_LISTED");
  });

  it("rejects a listed symbol that is not TRADING", async () => {
    listing.BTCUSDT = symbolRow("BTCUSDT", { status: "BREAK" });
    const result = await validateCanarySymbol("BTCUSDT", validator());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("CANARY_SYMBOL_NOT_TRADING");
  });

  it("rejects a non-perpetual contract", async () => {
    listing.BTCUSDT = symbolRow("BTCUSDT", { contractType: "CURRENT_QUARTER" });
    const result = await validateCanarySymbol("BTCUSDT", validator());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("CANARY_SYMBOL_NOT_PERPETUAL");
  });

  it("rejects a symbol missing the filters the planner needs", async () => {
    listing.BTCUSDT = symbolRow("BTCUSDT", {
      filters: [{ filterType: "PRICE_FILTER", tickSize: "0.10", minPrice: "0.10", maxPrice: "40000" }],
    });
    const result = await validateCanarySymbol("BTCUSDT", validator());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe("CANARY_SYMBOL_FILTERS_INCOMPLETE");
      expect(result.message).toMatch(/stepSize|minQty|minNotional/);
    }
  });

  it("fails closed when the exchange cannot be reached", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network unreachable");
    });
    const result = await validateCanarySymbol("BTCUSDT", validator());

    // An unreachable exchange is a reason not to open a window, never a reason
    // to assume the symbol is fine.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("CANARY_SYMBOL_LOOKUP_FAILED");
  });

  it("normalizes a TradingView-style perpetual ticker", async () => {
    const result = await validateCanarySymbol("BINANCE:ETHUSDT.P", validator());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.symbol).toBe("ETHUSDT");
  });

  it("sends GET only — no Binance mutation is possible", async () => {
    await validateCanarySymbol("BTCUSDT", validator());

    expect(recorded.length).toBeGreaterThan(0);
    for (const request of recorded) {
      expect(`${request.path}:${request.method}`).toBe(`${request.path}:GET`);
    }
    // And only metadata endpoints were touched.
    const paths = [...new Set(recorded.map((request) => request.path))].sort();
    for (const seen of paths) {
      expect(seen).toMatch(/^\/fapi\/v1\/(time|ping|exchangeInfo|leverageBracket|symbolConfig)$/);
    }
  });

  it("hardcodes no symbol", async () => {
    // ETHUSDT validates exactly as BTCUSDT does; nothing is special-cased.
    const eth = await validateCanarySymbol("ETHUSDT", validator());
    expect(eth.ok).toBe(true);

    listing.ETHUSDT = symbolRow("ETHUSDT", { status: "BREAK" });
    const halted = await validateCanarySymbol("ETHUSDT", validator());
    expect(halted.ok).toBe(false);
  });
});
