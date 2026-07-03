import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenAiVisionProvider } from "../src/modules/ai-vision/openai.provider";
import { AiVisionError } from "../src/modules/ai-vision/ai-vision.types";

let tmpDir: string;
let screenshotPath: string;

const VALID_AI_RESPONSE = {
  bias: "bullish_continuation",
  confidence: 0.61,
  pattern: "Price is holding above a rising support line with higher lows.",
  summary: "The visible structure leans bullish but is not confirmed.",
  riskNotes: ["A close below the support line would weaken this read."],
};

function baseConfig(overrides: Partial<ConstructorParameters<typeof OpenAiVisionProvider>[0]> = {}) {
  return {
    apiKey: "test-key",
    model: "gpt-4o-mini",
    timeoutMs: 5000,
    maxImageBytes: 5_000_000,
    baseUrl: "https://openai.test",
    ...overrides,
  };
}

function mockFetchWithContent(content: string) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => "",
  }) as unknown as typeof fetch;
}

function contextInput() {
  return {
    screenshotPath,
    context: { symbol: "BTCUSDT", timeframe: "1h", signal: "LONG" as const, price: 64000 },
  };
}

const originalFetch = global.fetch;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "ai-vision-test-"));
  screenshotPath = path.join(tmpDir, "chart.png");
  await writeFile(screenshotPath, Buffer.from("fake-png-bytes"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("OpenAiVisionProvider", () => {
  it("throws when the API key is missing", async () => {
    const provider = new OpenAiVisionProvider(baseConfig({ apiKey: "" }));

    await expect(provider.analyze(contextInput())).rejects.toBeInstanceOf(AiVisionError);
    await expect(provider.analyze(contextInput())).rejects.toThrow(/OPENAI_API_KEY is required/);
  });

  it("parses a valid AI JSON response into an AiVisionResult tagged provider: openai", async () => {
    mockFetchWithContent(JSON.stringify(VALID_AI_RESPONSE));
    const provider = new OpenAiVisionProvider(baseConfig());

    const result = await provider.analyze(contextInput());

    expect(result).toEqual({ ...VALID_AI_RESPONSE, provider: "openai" });
  });

  it("sends the image and prompt to the chat completions endpoint with JSON mode", async () => {
    mockFetchWithContent(JSON.stringify(VALID_AI_RESPONSE));
    const provider = new OpenAiVisionProvider(baseConfig());

    await provider.analyze(contextInput());

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://openai.test/v1/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.response_format).toEqual({ type: "json_object" });
    const imagePart = body.messages[1].content.find((p: { type: string }) => p.type === "image_url");
    expect(imagePart.image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it("throws on an invalid (non-JSON) AI response", async () => {
    mockFetchWithContent("this is not json");
    const provider = new OpenAiVisionProvider(baseConfig());

    await expect(provider.analyze(contextInput())).rejects.toThrow(/not valid JSON/);
  });

  it("throws when the AI JSON fails schema validation (bad bias / out-of-range confidence)", async () => {
    mockFetchWithContent(
      JSON.stringify({ ...VALID_AI_RESPONSE, bias: "moon_soon", confidence: 5 })
    );
    const provider = new OpenAiVisionProvider(baseConfig());

    await expect(provider.analyze(contextInput())).rejects.toThrow(/failed validation/);
  });

  it("throws a clear error on a non-2xx response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => '{"error":{"message":"Invalid API key"}}',
    }) as unknown as typeof fetch;
    const provider = new OpenAiVisionProvider(baseConfig());

    await expect(provider.analyze(contextInput())).rejects.toThrow(/status 401/);
  });

  it("rejects an oversized screenshot before making a network request", async () => {
    global.fetch = vi.fn();
    const provider = new OpenAiVisionProvider(baseConfig({ maxImageBytes: 3 }));

    await expect(provider.analyze(contextInput())).rejects.toThrow(/too large/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
