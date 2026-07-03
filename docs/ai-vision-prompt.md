# AI Vision prompt

Source of truth: `apps/backend/src/modules/ai-vision/ai-vision.prompt.ts`.

## Why a strict system prompt

This dashboard is a personal research tool, not a signal-selling product. The prompt is written
so that any real AI Vision provider plugged in later (see `ai-vision.service.ts`) is constrained
the same way the mock provider's output already is:

- **No financial advice.** The model must never suggest buying, selling, or sizing a position.
- **Visual description only.** The model may describe:
  - possible reversal
  - possible continuation
  - support/resistance behavior
  - momentum quality
  - uncertainty
  - invalidation notes (what would prove the observed pattern wrong)
- **Structured JSON only** — no prose outside the JSON object, matching:

  ```ts
  interface AiVisionResult {
    bias: string;        // e.g. "bullish_continuation", "bearish_reversal", "neutral"
    confidence: number;  // 0 to 1
    pattern: string;     // 1-2 sentence description of visual structure
    summary: string;     // 1-2 sentence plain-language summary
    riskNotes: string[]; // invalidation notes / uncertainty callouts
    provider: string;    // which provider produced this ("mock" for the placeholder provider)
  }
  ```

## Mock provider

`AI_VISION_PROVIDER=mock` (the default) does **not** call any external API. It returns a fixed,
canned response **per alert signal** (`MOCK_ANALYSIS_BY_SIGNAL` in `ai-vision.service.ts`) so a
SHORT alert doesn't misleadingly come back bullish — this is still not real chart analysis, just
signal-aware placeholder text:

| Alert signal | `bias` |
| --- | --- |
| `LONG` | `bullish_continuation` |
| `SHORT` | `bearish_continuation` |
| `WATCH` | `neutral_watch` |
| `EXIT` | `risk_reduction` |

Every mock result also sets `provider: "mock"`, which is persisted on the alert as `aiProvider` and
surfaced in the frontend (a "Mock AI" badge on the alert card/detail page, plus a warning banner in
the AI Opinion panel) so it's never mistaken for real AI output.

It still builds the real prompt (`AI_VISION_SYSTEM_PROMPT` + `buildVisionUserPrompt(context)`) so
the wiring is identical to what a real provider will use — swapping in a real model is a matter
of sending that prompt + the screenshot to the model and parsing its JSON response.

## Plugging in a real provider

1. Read the screenshot at `input.screenshotPath` (e.g. as base64).
2. Send `AI_VISION_SYSTEM_PROMPT`, `buildVisionUserPrompt(input.context)`, and the image to your
   chosen vision-capable model.
3. Parse the model's JSON response into `AiVisionResult` (validate with Zod if you want extra
   safety against malformed model output).
4. Add a new case to `getAiVisionProvider()` in `ai-vision.service.ts` and a matching value to the
   `AI_VISION_PROVIDER` enum in `src/config/env.ts`.

No other file in the codebase needs to know which provider is active — that's the point of the
`AiVisionProvider` interface.
