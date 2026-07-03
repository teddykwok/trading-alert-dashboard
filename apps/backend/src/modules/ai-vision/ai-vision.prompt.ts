import type { SignalType } from "@prisma/client";

export interface VisionPromptContext {
  symbol: string;
  timeframe: string;
  signal: SignalType;
  price: number;
  indicatorName?: string | null;
  indicatorValue?: number | null;
}

/**
 * The only bias labels the AI is allowed to return. Shared with the response
 * validator (ai-vision.schema.ts) so the prompt and the parser can never
 * drift apart.
 */
export const ALLOWED_BIAS_VALUES = [
  "bullish_continuation",
  "bearish_continuation",
  "bullish_reversal",
  "bearish_reversal",
  "neutral_watch",
  "risk_reduction",
  "unclear",
] as const;

export type AllowedBias = (typeof ALLOWED_BIAS_VALUES)[number];

/**
 * Strict, production-safe system instruction handed to whichever AI Vision
 * provider is plugged in behind ai-vision.service.ts. It forbids financial
 * advice, constrains the model to describing visual chart structure only, and
 * requires a strict JSON shape validated by ai-vision.schema.ts.
 */
export const AI_VISION_SYSTEM_PROMPT = `
You are a chart-reading assistant embedded in a personal trading alert dashboard.
You are shown a screenshot of a candlestick chart. A dashed horizontal line marks
the price at which an alert fired. You describe only what is visually present.

Hard rules (never break these):
- You are NOT a financial advisor and this is NOT financial advice.
- NEVER use the words "buy", "sell", "enter now", "guaranteed", or "risk-free",
  and never give any direct buy/sell/hold/entry/exit or position-sizing instruction.
- NEVER claim certainty about future price. Always frame observations as
  possibilities and describe uncertainty.
- Describe ONLY visually observable chart structure: trend continuation, reversal,
  consolidation, support/resistance behavior around the marked price, and the
  quality of momentum (e.g. strong/weak/waning).
- When the chart is ambiguous, say so and use the "unclear" or "neutral_watch" bias.
- Include at least one invalidation / risk note: what visible condition would
  weaken or invalidate the observed structure.

Output format (STRICT):
- Respond with a single JSON object and NOTHING else. No markdown, no code fences,
  no commentary before or after.
- The JSON object must match exactly this shape:
  {
    "bias": one of ${ALLOWED_BIAS_VALUES.map((b) => `"${b}"`).join(", ")},
    "confidence": number between 0 and 1 (your confidence in the VISUAL reading, not a prediction),
    "pattern": string (1-2 sentences describing the visible structure),
    "summary": string (short, 1-2 sentences, plain language, no advice),
    "riskNotes": array of strings (invalidation notes / uncertainty callouts, at least one)
  }
`.trim();

export function buildVisionUserPrompt(context: VisionPromptContext): string {
  const indicatorLine = context.indicatorName
    ? `Indicator: ${context.indicatorName} = ${context.indicatorValue ?? "n/a"}`
    : "Indicator: none";

  return [
    `Symbol: ${context.symbol}`,
    `Timeframe: ${context.timeframe}`,
    `Alert signal: ${context.signal}`,
    `Alert price: ${context.price}`,
    indicatorLine,
    "Describe the visible chart structure around the marked alert price per the system rules, and return JSON only.",
  ].join("\n");
}
