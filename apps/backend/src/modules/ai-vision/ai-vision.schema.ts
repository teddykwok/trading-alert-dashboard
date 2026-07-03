import { z } from "zod";
import { ALLOWED_BIAS_VALUES } from "./ai-vision.prompt";
import { AiVisionError } from "./ai-vision.types";
import type { AiVisionResult } from "./ai-vision.types";

/**
 * Shape a real provider's JSON response must match before we trust it. Kept
 * strict on `bias` (allow-list) and `confidence` (0..1) so a malformed or
 * off-spec model response fails loudly rather than persisting garbage on the
 * alert.
 */
export const aiVisionResponseSchema = z.object({
  bias: z.enum(ALLOWED_BIAS_VALUES),
  confidence: z.number().min(0).max(1),
  pattern: z.string().min(1),
  summary: z.string().min(1),
  riskNotes: z.array(z.string().min(1)).min(1),
});

/**
 * Parses + validates raw model output (already JSON-parsed) into an
 * AiVisionResult tagged with the given provider. Throws AiVisionError with a
 * readable message on any validation failure.
 */
export function validateAiVisionResponse(raw: unknown, provider: string): AiVisionResult {
  const result = aiVisionResponseSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new AiVisionError(`AI vision response failed validation: ${issues}`);
  }

  return { ...result.data, provider };
}
