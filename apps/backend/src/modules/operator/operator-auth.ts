import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

import { env } from "../../config/env";
import { UnauthorizedError } from "../../utils/errors";

/**
 * The authentication boundary for operator-only control endpoints.
 *
 * Why this exists at all: every execution safety layer in this project —
 * natural authorization, the policy CAS, the shared operator advisory lock, the
 * runtime-attestation interlock — sits BEHIND the operator commands. They all
 * assume the caller is the operator at a local terminal. Exposing those same
 * actions over HTTP removes that assumption, so the boundary has to be restored
 * explicitly before any control route may exist.
 *
 * Deliberately NOT the TradingView webhook secret: that value is shared with an
 * external service and travels inside alert bodies, so it is the wrong kind of
 * credential for "may arm a real-money account".
 *
 * There is no user model, no session and no role table here on purpose. One
 * server-side token, compared in constant time, is the smallest thing that
 * actually closes the hole.
 */

const BEARER_PREFIX = "bearer ";

/**
 * Constant-time token comparison.
 *
 * Mirrors `webhook.security.ts`: `timingSafeEqual` throws on length mismatch,
 * so lengths are compared first — and that early return is itself the reason a
 * length check alone cannot leak the token, since it reveals only the length,
 * never the bytes.
 *
 * An unset `OPERATOR_API_TOKEN` returns false for every candidate, so an
 * unconfigured deployment has NO operator API rather than an open one.
 */
export function isValidOperatorToken(candidate: string): boolean {
  const configured = env.OPERATOR_API_TOKEN;
  if (!configured) return false;
  if (!candidate) return false;

  const expected = Buffer.from(configured);
  const actual = Buffer.from(candidate);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * Extracts the bearer token from an Authorization header.
 *
 * Returns null rather than throwing for every malformed shape, so the caller
 * emits one identical refusal regardless of HOW the header was wrong. A caller
 * must not be able to distinguish "no header" from "wrong scheme" from "wrong
 * token" — that difference is free reconnaissance.
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const trimmed = header.trim();
  if (trimmed.toLowerCase().startsWith(BEARER_PREFIX) === false) return null;
  const token = trimmed.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Fastify preHandler for operator-only routes.
 *
 *   app.get("/api/operator/thing", { preHandler: requireOperatorAuth }, handler)
 *
 * Applied per route, never globally: the dashboard's ordinary read APIs keep
 * working untouched, and only routes that explicitly opt in are protected.
 *
 * The refusal message is a fixed string. It never echoes the supplied header,
 * never says whether a token was configured, and never distinguishes the
 * failure mode.
 */
export async function requireOperatorAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractBearerToken(request.headers.authorization);
  if (token === null || !isValidOperatorToken(token)) {
    // Thrown, not returned: the app's error handler turns AppError into the
    // standard body shape, so this matches every other 401 in the project.
    throw new UnauthorizedError("Operator authorization required");
  }
}
