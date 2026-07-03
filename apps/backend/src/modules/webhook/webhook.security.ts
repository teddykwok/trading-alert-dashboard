import { timingSafeEqual } from "node:crypto";
import { env } from "../../config/env";

/**
 * Constant-time comparison against the configured WEBHOOK_SECRET, so
 * response timing can't be used to brute-force the secret character by
 * character.
 */
export function isValidWebhookSecret(candidate: string): boolean {
  const expected = Buffer.from(env.WEBHOOK_SECRET);
  const actual = Buffer.from(candidate);

  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
