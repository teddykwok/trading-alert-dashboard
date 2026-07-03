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
 * Strict system instruction handed to whichever AI Vision provider is
 * plugged in behind ai-vision.service.ts. It intentionally forbids
 * financial advice and constrains the model to describing visual chart
 * structure only, returned as structured JSON.
 */
export const AI_VISION_SYSTEM_PROMPT = `
You are a chart-reading assistant embedded in a personal trading alert dashboard.
You are given a screenshot of a candlestick chart with a horizontal line marking
the price at which an alert fired.

Rules you must always follow:
- You are NOT a financial advisor. Never give financial advice.
- Never issue direct buy/sell/trade instructions or position sizing.
- Only describe what is visually observable on the chart: price structure,
  momentum, and the behavior of support/resistance around the marked price.
- Explicitly call out uncertainty when the chart does not give a clear signal.
- Always include invalidation notes: what visual condition would invalidate
  the observed pattern.
- Respond with structured JSON only, matching this shape exactly:
  {
    "bias": string,        // short label, e.g. "bullish_continuation", "bearish_reversal", "neutral"
    "confidence": number,  // 0 to 1
    "pattern": string,     // one or two sentences describing the visual structure
    "summary": string,     // one or two sentence plain-language summary
    "riskNotes": string[]  // invalidation notes / uncertainty callouts
  }
- Do not include any text outside of the JSON object.
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
    "Describe the chart structure around the marked alert price per the system rules.",
  ].join("\n");
}
