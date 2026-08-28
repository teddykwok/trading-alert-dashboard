import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { logger } from "../../config/logger";
import { AI_VISION_SYSTEM_PROMPT, buildVisionUserPrompt } from "./ai-vision.prompt";
import { validateAiVisionResponse } from "./ai-vision.schema";
import { AiVisionError } from "./ai-vision.types";
import type { AiVisionProvider, AnalyzeChartInput, AiVisionResult } from "./ai-vision.types";

const OPENAI_PROVIDER_NAME = "openai";
const DEFAULT_BASE_URL = "https://api.openai.com";

export interface OpenAiVisionConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxImageBytes: number;
  /** Overridable for tests; defaults to the real OpenAI API host. */
  baseUrl?: string;
}

function mimeTypeForImage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

/**
 * Real OpenAI vision provider. Reads the chart screenshot from disk, sends it
 * as a base64 data URL alongside the strict system prompt to the Chat
 * Completions API (JSON mode), then validates the structured response.
 *
 * Never falls back on its own — any failure throws AiVisionError, and
 * ai-vision.service.ts decides whether to fall back to mock (based on
 * AI_VISION_FALLBACK_TO_MOCK) or let the worker fail the alert.
 */
export class OpenAiVisionProvider implements AiVisionProvider {
  constructor(private readonly config: OpenAiVisionConfig) {}

  async analyze(input: AnalyzeChartInput): Promise<AiVisionResult> {
    if (!this.config.apiKey) {
      throw new AiVisionError("OPENAI_API_KEY is required to use the OpenAI vision provider");
    }

    const dataUrl = await this.readImageAsDataUrl(input.screenshotPath);
    const body = this.buildRequestBody(input, dataUrl);
    const content = await this.callOpenAi(body, input.context.symbol);

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new AiVisionError(
        `OpenAI vision response was not valid JSON: ${content.slice(0, 200)}`
      );
    }

    return validateAiVisionResponse(parsed, OPENAI_PROVIDER_NAME);
  }

  private async readImageAsDataUrl(screenshotPath: string): Promise<string> {
    let fileStat;
    try {
      fileStat = await stat(screenshotPath);
    } catch {
      throw new AiVisionError(`Screenshot not found for AI analysis: ${screenshotPath}`);
    }

    if (fileStat.size > this.config.maxImageBytes) {
      throw new AiVisionError(
        `Screenshot is too large for AI analysis (${fileStat.size} bytes > ${this.config.maxImageBytes} limit)`
      );
    }

    const buffer = await readFile(screenshotPath);
    const mime = mimeTypeForImage(screenshotPath);
    return `data:${mime};base64,${buffer.toString("base64")}`;
  }

  private buildRequestBody(input: AnalyzeChartInput, dataUrl: string): Record<string, unknown> {
    return {
      model: this.config.model,
      temperature: 0.2,
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: AI_VISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: buildVisionUserPrompt(input.context) },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    };
  }

  private async callOpenAi(body: Record<string, unknown>, symbol: string): Promise<string> {
    const baseUrl = this.config.baseUrl ?? DEFAULT_BASE_URL;
    const url = `${baseUrl}/v1/chat/completions`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    logger.info(
      { provider: OPENAI_PROVIDER_NAME, model: this.config.model, symbol },
      "Requesting OpenAI vision analysis"
    );

    // The deadline covers the RESPONSE BODY too, not just the headers.
    //
    // `clearTimeout` used to sit in a `finally` attached to the fetch alone, so
    // the abort was already disarmed by the time `response.json()` read the
    // stream. A server that returned headers and then stalled the body left
    // this call waiting forever — and because the vision worker runs
    // concurrency 2 while BullMQ keeps renewing a running job's lock, that is a
    // permanently occupied slot rather than a slow request. Reading the body
    // under the same signal is what makes AI_VISION_TIMEOUT_MS a bound on the
    // whole exchange.
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Authorization header is never logged.
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new AiVisionError(
          `OpenAI vision request failed with status ${response.status}${errorBody ? `: ${errorBody.slice(0, 300)}` : ""}`
        );
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;

      if (!content || typeof content !== "string") {
        throw new AiVisionError("OpenAI vision response did not contain message content");
      }

      logger.info({ provider: OPENAI_PROVIDER_NAME, symbol }, "Received OpenAI vision analysis");
      return content;
    } catch (error) {
      // Already shaped and already safe: a status or parse failure keeps its
      // own message instead of being relabelled as a transport failure.
      if (error instanceof AiVisionError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const detail =
        error instanceof Error && error.name === "AbortError"
          ? `timed out after ${this.config.timeoutMs}ms`
          : message;
      throw new AiVisionError(`OpenAI vision request failed: ${detail}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
