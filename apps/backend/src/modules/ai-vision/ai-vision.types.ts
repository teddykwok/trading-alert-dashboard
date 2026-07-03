import type { AiVisionResult } from "@trading-alert-dashboard/shared";
import type { VisionPromptContext } from "./ai-vision.prompt";

export type { AiVisionResult };

export interface AnalyzeChartInput {
  screenshotPath: string;
  context: VisionPromptContext;
}

/**
 * Provider abstraction. Any real AI Vision integration (OpenAI, Anthropic,
 * Gemini, etc.) implements this interface and gets selected in
 * ai-vision.service.ts based on AI_VISION_PROVIDER — nothing else in the
 * codebase should know which provider is active.
 */
export interface AiVisionProvider {
  analyze(input: AnalyzeChartInput): Promise<AiVisionResult>;
}

/**
 * Thrown by real AI vision providers for anything that prevents returning a
 * valid analysis: missing credentials, oversized image, timeout, non-2xx
 * response, or a response that fails validation. Caught by
 * ai-vision.service.ts, which either falls back to a mock result
 * (AI_VISION_FALLBACK_TO_MOCK=true) or lets it propagate to the worker,
 * which marks the alert FAILED.
 */
export class AiVisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiVisionError";
  }
}
