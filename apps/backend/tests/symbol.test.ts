import { describe, expect, it } from "vitest";
import { normalizeTradingSymbol } from "../src/utils/symbol";
import { ValidationError } from "../src/utils/errors";

describe("normalizeTradingSymbol", () => {
  it("keeps a bare symbol unchanged (uppercased)", () => {
    expect(normalizeTradingSymbol("BTCUSDT")).toEqual({
      rawSymbol: "BTCUSDT",
      normalizedSymbol: "BTCUSDT",
    });
  });

  it("strips a BINANCE: prefix into exchangeFromSymbol", () => {
    expect(normalizeTradingSymbol("BINANCE:BTCUSDT")).toEqual({
      rawSymbol: "BINANCE:BTCUSDT",
      normalizedSymbol: "BTCUSDT",
      exchangeFromSymbol: "BINANCE",
    });
  });

  it("strips a NASDAQ: prefix into exchangeFromSymbol", () => {
    expect(normalizeTradingSymbol("NASDAQ:AAPL")).toEqual({
      rawSymbol: "NASDAQ:AAPL",
      normalizedSymbol: "AAPL",
      exchangeFromSymbol: "NASDAQ",
    });
  });

  it("trims whitespace and uppercases both parts", () => {
    expect(normalizeTradingSymbol("  binance:btcusdt  ")).toEqual({
      rawSymbol: "  binance:btcusdt  ",
      normalizedSymbol: "BTCUSDT",
      exchangeFromSymbol: "BINANCE",
    });
  });

  it("rejects an empty symbol", () => {
    expect(() => normalizeTradingSymbol("")).toThrow(ValidationError);
    expect(() => normalizeTradingSymbol("   ")).toThrow(/must not be empty/);
  });

  it("rejects an exchange prefix with no symbol after the colon", () => {
    expect(() => normalizeTradingSymbol("BINANCE:")).toThrow(/no symbol/);
  });
});
