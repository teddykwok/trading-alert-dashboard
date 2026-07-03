import { describe, expect, it } from "vitest";
import { analyzeChart } from "../src/modules/ai-vision/ai-vision.service";

describe("analyzeChart (mock provider)", () => {
  it("returns a structured analysis result without calling any external API", async () => {
    const result = await analyzeChart({
      screenshotPath: "/tmp/fake-screenshot.png",
      context: { symbol: "BTCUSDT", timeframe: "1h", signal: "LONG", price: 64250.5 },
    });

    expect(result.bias).toBe("bullish_continuation");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(typeof result.pattern).toBe("string");
    expect(typeof result.summary).toBe("string");
    expect(Array.isArray(result.riskNotes)).toBe(true);
    expect(result.riskNotes.length).toBeGreaterThan(0);
  });
});
