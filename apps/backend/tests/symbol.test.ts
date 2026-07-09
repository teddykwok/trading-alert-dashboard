import { describe, expect, it } from "vitest";
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
