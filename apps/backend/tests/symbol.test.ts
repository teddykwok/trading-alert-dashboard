import { describe, expect, it } from "vitest";
import { getSymbolInputError } from "@trading-alert-dashboard/shared";
import { inferMarketType, normalizeTradingSymbol } from "../src/utils/symbol";
import { ValidationError } from "../src/utils/errors";

describe("normalizeTradingSymbol", () => {
  it("keeps a bare symbol unchanged (uppercased), defaulting to spot", () => {
    expect(normalizeTradingSymbol("BTCUSDT")).toEqual({
      rawSymbol: "BTCUSDT",
      normalizedSymbol: "BTCUSDT",
      exchangeFromSymbol: undefined,
      marketType: "spot",
    });
  });

  it("strips a BINANCE: prefix into exchangeFromSymbol", () => {
    expect(normalizeTradingSymbol("BINANCE:BTCUSDT")).toEqual({
      rawSymbol: "BINANCE:BTCUSDT",
      normalizedSymbol: "BTCUSDT",
      exchangeFromSymbol: "BINANCE",
      marketType: "spot",
    });
  });

  it("strips a NASDAQ: prefix into exchangeFromSymbol", () => {
    expect(normalizeTradingSymbol("NASDAQ:AAPL")).toEqual({
      rawSymbol: "NASDAQ:AAPL",
      normalizedSymbol: "AAPL",
      exchangeFromSymbol: "NASDAQ",
      marketType: "spot",
    });
  });

  it("trims whitespace and uppercases both parts", () => {
    expect(normalizeTradingSymbol("  binance:btcusdt  ")).toEqual({
      rawSymbol: "  binance:btcusdt  ",
      normalizedSymbol: "BTCUSDT",
      exchangeFromSymbol: "BINANCE",
      marketType: "spot",
    });
  });

  it("rejects an empty symbol", () => {
    expect(() => normalizeTradingSymbol("")).toThrow(ValidationError);
    expect(() => normalizeTradingSymbol("   ")).toThrow(/must not be empty/);
  });

  it("rejects an exchange prefix with no symbol after the colon", () => {
    expect(() => normalizeTradingSymbol("BINANCE:")).toThrow(/no symbol/);
  });

  describe("multi-symbol paste guard", () => {
    it("rejects comma-separated watchlist pastes", () => {
      expect(() => normalizeTradingSymbol("BTCUSDT,ETHUSDT")).toThrow(ValidationError);
      expect(() => normalizeTradingSymbol("BTCUSDT, ETHUSDT, SOLUSDT")).toThrow(/single ticker/);
      expect(() => normalizeTradingSymbol("BINANCE:BTCUSDT,BINANCE:ETHUSDT")).toThrow(ValidationError);
    });

    it("rejects internal whitespace and newlines", () => {
      expect(() => normalizeTradingSymbol("BTCUSDT ETHUSDT")).toThrow(ValidationError);
      expect(() => normalizeTradingSymbol("BTCUSDT\nETHUSDT")).toThrow(ValidationError);
    });

    it("rejects absurdly long symbols", () => {
      expect(() => normalizeTradingSymbol("A".repeat(65))).toThrow(/at most 64/);
    });

    it("still accepts legitimate single tickers", () => {
      expect(normalizeTradingSymbol("1000XECUSDT").normalizedSymbol).toBe("1000XECUSDT");
      expect(normalizeTradingSymbol("AAPL").normalizedSymbol).toBe("AAPL");
      expect(normalizeTradingSymbol("BINANCE:1000XECUSDT.P")).toMatchObject({
        normalizedSymbol: "1000XECUSDT",
        marketType: "futures",
      });
    });
  });

  describe("perpetual futures (.P) symbols", () => {
    it("normalizes BINANCE:GRASSUSDT.P to GRASSUSDT with marketType futures", () => {
      expect(normalizeTradingSymbol("BINANCE:GRASSUSDT.P")).toEqual({
        rawSymbol: "BINANCE:GRASSUSDT.P",
        normalizedSymbol: "GRASSUSDT",
        exchangeFromSymbol: "BINANCE",
        marketType: "futures",
      });
    });

    it("normalizes a bare GRASSUSDT.P to futures", () => {
      expect(normalizeTradingSymbol("GRASSUSDT.P")).toEqual({
        rawSymbol: "GRASSUSDT.P",
        normalizedSymbol: "GRASSUSDT",
        exchangeFromSymbol: undefined,
        marketType: "futures",
      });
    });

    it("normalizes BINANCE:APEUSDT.P to APEUSDT / futures", () => {
      const result = normalizeTradingSymbol("BINANCE:APEUSDT.P");
      expect(result.normalizedSymbol).toBe("APEUSDT");
      expect(result.marketType).toBe("futures");
      expect(result.exchangeFromSymbol).toBe("BINANCE");
    });

    it("detects a lowercase .p suffix", () => {
      const result = normalizeTradingSymbol("binance:skyaiusdt.p");
      expect(result.normalizedSymbol).toBe("SKYAIUSDT");
      expect(result.marketType).toBe("futures");
    });

    it("rejects a .P suffix with no symbol", () => {
      expect(() => normalizeTradingSymbol("BINANCE:.P")).toThrow(ValidationError);
    });
  });
});

describe("getSymbolInputError (shared UI/API guard)", () => {
  it("accepts single tickers, with or without exchange prefix or .P suffix", () => {
    for (const symbol of ["BTCUSDT", "ETHUSDT", "1000XECUSDT", "AAPL", "BINANCE:BTCUSDT", "BINANCE:GRASSUSDT.P", "BRK.B", "BTC-USD"]) {
      expect(getSymbolInputError(symbol)).toBeNull();
    }
  });

  it("tolerates outer whitespace (callers trim before storing)", () => {
    expect(getSymbolInputError("  BTCUSDT  ")).toBeNull();
  });

  it("rejects empty, pasted lists, whitespace, newlines, and overlong input", () => {
    expect(getSymbolInputError("")).toMatch(/required/);
    expect(getSymbolInputError("   ")).toMatch(/required/);
    expect(getSymbolInputError("BTCUSDT,ETHUSDT")).toMatch(/single ticker/);
    expect(getSymbolInputError("BTCUSDT; ETHUSDT")).toMatch(/single ticker/);
    expect(getSymbolInputError("BTCUSDT ETHUSDT")).toMatch(/single ticker/);
    expect(getSymbolInputError("BTCUSDT\nETHUSDT")).toMatch(/single ticker/);
    expect(getSymbolInputError("A".repeat(65))).toMatch(/at most 64/);
  });
});

describe("inferMarketType", () => {
  it("infers futures for .P symbols (raw or prefixed)", () => {
    expect(inferMarketType("BINANCE:GRASSUSDT.P")).toBe("futures");
    expect(inferMarketType("GRASSUSDT.P")).toBe("futures");
    expect(inferMarketType("apeusdt.p")).toBe("futures");
  });

  it("infers spot for everything else, never throwing", () => {
    expect(inferMarketType("BTCUSDT")).toBe("spot");
    expect(inferMarketType("BINANCE:BTCUSDT")).toBe("spot");
    expect(inferMarketType("")).toBe("spot");
    expect(inferMarketType(undefined)).toBe("spot");
    expect(inferMarketType(null)).toBe("spot");
    expect(inferMarketType(42)).toBe("spot");
  });
});
