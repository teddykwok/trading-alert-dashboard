import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { AI_VISION_SYSTEM_PROMPT, buildVisionUserPrompt } from "./ai-vision.prompt";
import { OpenAiVisionProvider } from "./openai.provider";
import type { AiVisionProvider, AnalyzeChartInput, AiVisionResult } from "./ai-vision.types";
import type { SignalType } from "@prisma/client";

const MOCK_PROVIDER_NAME = "mock";

type MockAnalysis = Omit<AiVisionResult, "provider">;

/**
 * Signal-aware mock responses. These are NOT real chart analysis — they are
 * keyed off the alert's own signal so a mock LONG alert doesn't misleadingly
 * come back bullish_continuation for every signal. Keep the wording aligned
 * with the strict prompt rules (visual structure + confirmation language,
 * never advice).
 */
const MOCK_ANALYSIS_BY_SIGNAL: Record<SignalType, MockAnalysis> = {
  LONG: {
    bias: "bullish_continuation",
    confidence: 0.72,
    pattern: "Price appears to be holding above a recent support zone with higher lows.",
    summary: "The mock chart visually leans bullish, but confirmation is still needed.",
    riskNotes: [
      "Possible fakeout near resistance.",
      "Volume confirmation is not available in the mock chart.",
    ],
  },
  SHORT: {
    bias: "bearish_continuation",
    confidence: 0.7,
    pattern: "Price appears to be forming lower highs with rejection near a resistance zone.",
    summary: "The mock chart visually leans bearish, but confirmation is still needed.",
    riskNotes: [
      "Possible bounce if support holds.",
      "Volume confirmation is not available in the mock chart.",
    ],
  },
  WATCH: {
    bias: "neutral_watch",
    confidence: 0.5,
    pattern: "Price is consolidating in a tight range with no clear directional structure yet.",
    summary: "The mock chart shows an unclear setup that needs more confirmation before a bias forms.",
    riskNotes: [
      "Direction could resolve either way on the next few candles.",
      "Volume confirmation is not available in the mock chart.",
    ],
  },
  EXIT: {
    bias: "risk_reduction",
    confidence: 0.65,
    pattern: "Momentum on the mock chart appears to be weakening, with a possible invalidation of the prior structure.",
    summary: "The mock chart suggests reducing exposure or waiting for a clearer setup.",
    riskNotes: [
      "Weakening momentum may still stabilize.",
      "Volume confirmation is not available in the mock chart.",
    ],
  },
};

/**
 * Mock provider: returns a structured, signal-aware analysis without calling
 * any external API. It still builds the real prompt (see ai-vision.prompt.ts)
 * so the wiring is identical to what a real provider will use.
 *
 * `provider: "mock"` is always included in the result so callers (and the
 * frontend) can clearly flag this as placeholder analysis, not real AI
 * output — see AiOpinionPanel/AlertCard for how that's surfaced. It's also
 * the fallback used by analyzeChart when a real provider fails and
 * AI_VISION_FALLBACK_TO_MOCK=true.
 */
export class MockAiVisionProvider implements AiVisionProvider {
  async analyze(input: AnalyzeChartInput): Promise<AiVisionResult> {
    // Prompt is constructed even in mock mode to keep the contract identical
    // to a real provider call.
    void AI_VISION_SYSTEM_PROMPT;
    void buildVisionUserPrompt(input.context);

    const analysis = MOCK_ANALYSIS_BY_SIGNAL[input.context.signal];

    return { ...analysis, provider: MOCK_PROVIDER_NAME };
  }
}

function getAiVisionProvider(): AiVisionProvider {
  switch (env.AI_VISION_PROVIDER) {
    case "openai":
      return new OpenAiVisionProvider({
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_VISION_MODEL,
        timeoutMs: env.AI_VISION_TIMEOUT_MS,
        maxImageBytes: env.AI_VISION_MAX_IMAGE_BYTES,
      });
    case "mock":
    default:
      return new MockAiVisionProvider();
  }
}

/**
 * Selects the configured provider and runs it. If a real provider fails and
 * AI_VISION_FALLBACK_TO_MOCK=true, log a warning and return a mock result
 * (tagged provider: "mock" so the dashboard shows it honestly). Otherwise the
 * error propagates and the worker marks the alert FAILED — we never silently
 * fake real analysis.
 */
export async function analyzeChart(input: AnalyzeChartInput): Promise<AiVisionResult> {
  const provider = getAiVisionProvider();

  try {
    return await provider.analyze(input);
  } catch (error) {
    const isRealProvider = env.AI_VISION_PROVIDER !== "mock";

    if (isRealProvider && env.AI_VISION_FALLBACK_TO_MOCK) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { provider: env.AI_VISION_PROVIDER, error: message },
        "AI vision provider failed — falling back to mock analysis (AI_VISION_FALLBACK_TO_MOCK=true)"
      );
      return new MockAiVisionProvider().analyze(input);
    }

    throw error;
  }
}
