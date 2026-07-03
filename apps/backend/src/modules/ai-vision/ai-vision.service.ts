import { env } from "../../config/env";
import { AI_VISION_SYSTEM_PROMPT, buildVisionUserPrompt } from "./ai-vision.prompt";
import type { AiVisionProvider, AnalyzeChartInput, AiVisionResult } from "./ai-vision.types";

/**
 * Mock provider: returns a fixed, structured analysis without calling any
 * external API. It still builds the real prompt (see ai-vision.prompt.ts)
 * so the wiring is identical to what a real provider will use.
 *
 * To plug in a real provider (e.g. an Anthropic/OpenAI vision model):
 *   1. Read the screenshot at input.screenshotPath as base64.
 *   2. Send it + AI_VISION_SYSTEM_PROMPT + buildVisionUserPrompt(context) to the model.
 *   3. Parse the model's JSON response into AiVisionResult.
 *   4. Add a case for it in getAiVisionProvider() below.
 */
class MockAiVisionProvider implements AiVisionProvider {
  async analyze(input: AnalyzeChartInput): Promise<AiVisionResult> {
    // Prompt is constructed even in mock mode to keep the contract identical
    // to a real provider call.
    void AI_VISION_SYSTEM_PROMPT;
    void buildVisionUserPrompt(input.context);

    return {
      bias: "bullish_continuation",
      confidence: 0.72,
      pattern:
        "Price appears to be holding above a recent support zone with higher lows.",
      summary:
        "The chart visually supports possible continuation, but confirmation is still needed.",
      riskNotes: [
        "Possible fakeout near resistance.",
        "Volume confirmation is not available in the mock chart.",
      ],
    };
  }
}

function getAiVisionProvider(): AiVisionProvider {
  switch (env.AI_VISION_PROVIDER) {
    case "mock":
    default:
      return new MockAiVisionProvider();
  }
}

export async function analyzeChart(input: AnalyzeChartInput): Promise<AiVisionResult> {
  const provider = getAiVisionProvider();
  return provider.analyze(input);
}
