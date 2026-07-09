import { describe, expect, it } from "vitest";
import {
  formatDynamicPrice,
  priceDecimalsFor,
  pricePrecisionFor,
} from "@trading-alert-dashboard/shared";

describe("formatDynamicPrice", () => {
  it("keeps large prices at two decimals (BTC-style)", () => {
    expect(formatDynamicPrice(62408)).toBe("62,408.00");
    expect(formatDynamicPrice(64250.5)).toBe("64,250.50");
  });

  it("preserves useful decimals for prices >= 1 without over-padding", () => {
    expect(formatDynamicPrice(1.2005)).toBe("1.2005");
    expect(formatDynamicPrice(1.5)).toBe("1.5");
  });

  it("shows five decimals for cent-range prices", () => {
    expect(formatDynamicPrice(0.03748)).toBe("0.03748");
  });

  it("shows six decimals for milli-range prices (TACUSDT.P case)", () => {
    expect(formatDynamicPrice(0.004086)).toBe("0.004086");
  });

  it("shows eight decimals for micro-range prices", () => {
    expect(formatDynamicPrice(0.00001234)).toBe("0.00001234");
  });

  it("shows up to ten decimals for dust-range prices instead of rounding to 0", () => {
    expect(formatDynamicPrice(0.0000001234)).toBe("0.0000001234");
  });

  it("keeps zero as 0", () => {
    expect(formatDynamicPrice(0)).toBe("0");
  });

  it("supports negative values with the same decimal rules", () => {
    expect(formatDynamicPrice(-0.004086)).toBe("-0.004086");
    expect(formatDynamicPrice(-62408)).toBe("-62,408.00");
  });
});

describe("priceDecimalsFor", () => {
  it("scales decimals with magnitude", () => {
    expect(priceDecimalsFor(62408)).toBe(2);
    expect(priceDecimalsFor(1.2345)).toBe(4);
    expect(priceDecimalsFor(0.03748)).toBe(5);
    expect(priceDecimalsFor(0.004086)).toBe(6);
    expect(priceDecimalsFor(0.00001234)).toBe(8);
    expect(priceDecimalsFor(0.0000001)).toBe(10);
  });
});

describe("pricePrecisionFor (lightweight-charts priceFormat)", () => {
  it("maps 0.004086 to precision 6 / minMove 0.000001", () => {
    expect(pricePrecisionFor(0.004086)).toEqual({ precision: 6, minMove: 0.000001 });
  });

  it("maps BTC-scale prices to precision 2 / minMove 0.01", () => {
    expect(pricePrecisionFor(62408)).toEqual({ precision: 2, minMove: 0.01 });
  });

  it("falls back to precision 2 for zero", () => {
    expect(pricePrecisionFor(0)).toEqual({ precision: 2, minMove: 0.01 });
  });
});
