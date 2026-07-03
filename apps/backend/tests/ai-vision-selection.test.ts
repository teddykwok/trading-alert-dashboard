import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Provider selection, the OpenAI-key startup guard, and fallback-to-mock all
 * depend on env vars that config/env.ts reads once at module load. To exercise
 * different combinations we mutate process.env and force a fresh import via
 * vi.resetModules() (same pattern as market-data-fallback.test.ts).
 */

let tmpDir: string;
let screenshotPath: string;

const VALID_AI_RESPONSE = {
  bias: "bearish_continuation",
  confidence: 0.55,
  pattern: "Lower highs into a resistance zone.",
  summary: "The visible structure leans bearish but is unconfirmed.",
  riskNotes: ["A reclaim of the resistance would invalidate this."],
};

const originalFetch = global.fetch;
const savedEnv = {
  AI_VISION_PROVIDER: process.env.AI_VISION_PROVIDER,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  AI_VISION_FALLBACK_TO_MOCK: process.env.AI_VISION_FALLBACK_TO_MOCK,
};

function input() {
  return {
    screenshotPath,
    context: { symbol: "ETHUSDT", timeframe: "1h", signal: "SHORT" as const, price: 3500 },
  };
}

function mockFetchOkJson(content: string) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => "",
  }) as unknown as typeof fetch;
}

function mockFetchFails() {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status: 500,
    json: async () => ({}),
    text: async () => "Internal Server Error",
  }) as unknown as typeof fetch;
}

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "ai-vision-select-"));
  screenshotPath = path.join(tmpDir, "chart.png");
  await writeFile(screenshotPath, Buffer.from("fake-png-bytes"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function restoreEnv(key: keyof typeof savedEnv) {
  const value = savedEnv[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  global.fetch = originalFetch;
  restoreEnv("AI_VISION_PROVIDER");
  restoreEnv("OPENAI_API_KEY");
  restoreEnv("AI_VISION_FALLBACK_TO_MOCK");
  vi.resetModules();
});

describe("AI vision provider selection", () => {
  it("uses the mock provider by default (AI_VISION_PROVIDER=mock)", async () => {
    process.env.AI_VISION_PROVIDER = "mock";
    vi.resetModules();

    const { analyzeChart } = await import("../src/modules/ai-vision/ai-vision.service");
    const result = await analyzeChart(input());

    expect(result.provider).toBe("mock");
  });

  it("uses the OpenAI provider when AI_VISION_PROVIDER=openai and a key is set", async () => {
    process.env.AI_VISION_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();
    mockFetchOkJson(JSON.stringify(VALID_AI_RESPONSE));

    const { analyzeChart } = await import("../src/modules/ai-vision/ai-vision.service");
    const result = await analyzeChart(input());

    expect(result.provider).toBe("openai");
    expect(result.bias).toBe("bearish_continuation");
  });

  it("fails startup validation when AI_VISION_PROVIDER=openai but OPENAI_API_KEY is empty", async () => {
    process.env.AI_VISION_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "";
    vi.resetModules();

    await expect(import("../src/config/env")).rejects.toThrow(/Invalid environment variables/);
  });

  it("propagates the error (worker will FAIL the alert) when OpenAI fails and fallback is off", async () => {
    process.env.AI_VISION_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.AI_VISION_FALLBACK_TO_MOCK = "false";
    vi.resetModules();
    mockFetchFails();

    const { analyzeChart } = await import("../src/modules/ai-vision/ai-vision.service");

    await expect(analyzeChart(input())).rejects.toThrow(/status 500/);
  });

  it("falls back to a mock result when OpenAI fails and AI_VISION_FALLBACK_TO_MOCK=true", async () => {
    process.env.AI_VISION_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.AI_VISION_FALLBACK_TO_MOCK = "true";
    vi.resetModules();
    mockFetchFails();

    const { analyzeChart } = await import("../src/modules/ai-vision/ai-vision.service");
    const result = await analyzeChart(input());

    expect(result.provider).toBe("mock");
    // SHORT signal -> signal-aware mock bias
    expect(result.bias).toBe("bearish_continuation");
  });
});
