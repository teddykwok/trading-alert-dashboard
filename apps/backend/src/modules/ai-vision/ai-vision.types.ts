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
