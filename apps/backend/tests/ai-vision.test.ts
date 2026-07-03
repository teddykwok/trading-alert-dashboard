import { describe, expect, it } from "vitest";
import { analyzeChart } from "../src/modules/ai-vision/ai-vision.service";

function contextFor(signal: "LONG" | "SHORT" | "WATCH" | "EXIT") {
  return {
    screenshotPath: "/tmp/fake-screenshot.png",
    context: { symbol: "BTCUSDT", timeframe: "1h", signal, price: 64250.5 },
  };
}

describe("analyzeChart (mock provider)", () => {
  it("returns a structured analysis result without calling any external API", async () => {
    const result = await analyzeChart(contextFor("LONG"));

    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(typeof result.pattern).toBe("string");
    expect(typeof result.summary).toBe("string");
    expect(Array.isArray(result.riskNotes)).toBe(true);
    expect(result.riskNotes.length).toBeGreaterThan(0);
    expect(result.provider).toBe("mock");
  });

  it("returns bullish_continuation for LONG", async () => {
    const result = await analyzeChart(contextFor("LONG"));
    expect(result.bias).toBe("bullish_continuation");
  });

  it("returns bearish_continuation for SHORT", async () => {
    const result = await analyzeChart(contextFor("SHORT"));
    expect(result.bias).toBe("bearish_continuation");
  });

  it("returns neutral_watch for WATCH", async () => {
    const result = await analyzeChart(contextFor("WATCH"));
    expect(result.bias).toBe("neutral_watch");
  });

  it("returns risk_reduction for EXIT", async () => {
    const result = await analyzeChart(contextFor("EXIT"));
    expect(result.bias).toBe("risk_reduction");
  });

  it("marks every mock result with provider: mock", async () => {
    for (const signal of ["LONG", "SHORT", "WATCH", "EXIT"] as const) {
      const result = await analyzeChart(contextFor(signal));
      expect(result.provider).toBe("mock");
    }
  });
});
