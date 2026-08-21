import type { FastifyInstance } from "fastify";

import { requireOperatorAuth } from "../modules/operator/operator-auth";

/**
 * Operator-only routes.
 *
 * Currently ONE read-only probe whose sole purpose is to prove the auth
 * boundary works end to end. It deliberately reveals nothing operational: no
 * profile state, no gates, no symbols, no counts. Knowing the token is valid
 * must not itself be a source of information about the trading system.
 *
 * Trading Control status and the start/stop/safe-off actions are NOT here yet —
 * they arrive in a later reviewed phase, behind this same guard.
 */
export async function operatorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/operator/auth-check", { preHandler: requireOperatorAuth }, async () => ({
    authenticated: true,
  }));
}
