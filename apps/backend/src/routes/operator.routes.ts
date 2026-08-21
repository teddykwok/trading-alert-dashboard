import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";

import { requireOperatorAuth } from "../modules/operator/operator-auth";
import { TradingControlService } from "../modules/operator/trading-control.service";
import { CANARY_AUTHORIZATION_MODES, type CanaryAuthorizationMode } from "../modules/execution/canary-readiness";
import { ValidationError } from "../utils/errors";

/**
 * Operator-only routes. READ ONLY, all of them.
 *
 * Three GETs: the auth probe, the Trading Control status feed the dashboard
 * polls, and the explicit readiness check. Every one sits behind
 * `requireOperatorAuth`, and none of them writes anything.
 *
 * The auth probe deliberately reveals nothing operational — knowing a token is
 * valid must not itself leak trading state. Everything operational lives behind
 * the trading-control routes, which return the same sanitized figures the CLI
 * preflight prints: no account identifier, no credential, no token hash.
 *
 * Start / Stop New Trades / Safe Off do NOT exist here. Those are mutations and
 * they arrive only in a later, separately reviewed phase.
 */
export interface OperatorRoutesOptions {
  /**
   * How the trading-control reader is built.
   *
   * Injectable so a test can exercise the REAL route, guard and error handler
   * without a signed Binance round-trip. Production registration passes
   * nothing and gets the real service.
   */
  tradingControlFactory?: (prisma: PrismaClient) => TradingControlReader;
}

/** The read-only surface the routes need. Narrow on purpose: no mutation. */
export interface TradingControlReader {
  readStatus(): Promise<unknown>;
  readReadiness(mode?: CanaryAuthorizationMode): Promise<unknown>;
}

export async function operatorRoutes(
  app: FastifyInstance,
  options: OperatorRoutesOptions = {}
): Promise<void> {
  const buildTradingControl =
    options.tradingControlFactory ?? ((prisma: PrismaClient) => new TradingControlService(prisma));

  app.get("/api/operator/auth-check", { preHandler: requireOperatorAuth }, async () => ({
    authenticated: true,
  }));

  // The panel's polled feed, safe to call every few seconds: it resolves the
  // profile, counts capacity through the shared status groups and reads
  // attestation from Redis. It runs NO preflight and reaches NO exchange, and
  // it takes no mode because readiness is not its question to answer.
  app.get("/api/operator/trading-control/status", { preHandler: requireOperatorAuth }, async (request) => {
    const service = buildTradingControl(request.server.prisma);
    return service.readStatus();
  });

  // The explicit "Check Readiness" action, and the ONLY operator route that may
  // reach the exchange. It runs the same evaluator the CLI preflight runs,
  // including that command's signed READS. GET because it must not mutate, and
  // a verb that cannot mutate is worth more here than REST tidiness.
  app.get("/api/operator/trading-control/readiness", { preHandler: requireOperatorAuth }, async (request) => {
    const service = buildTradingControl(request.server.prisma);
    return service.readReadiness(resolveMode(request.query));
  });
}

/**
 * Resolves `?mode=`, FAIL CLOSED.
 *
 * `undefined` means "not supplied", and the service applies its own default —
 * the mode is named once, where it is decided, and this file stays free of
 * authorization vocabulary it has no business owning.
 *
 * A supplied value must be recognised exactly. An unrecognised one is refused
 * rather than falling back, for the same reason the preflight CLI refuses
 * `--mode=natrual`: silently answering a different question than the one asked
 * is how an operator ends up reading a confident verdict about a mode they are
 * not in.
 */
function resolveMode(query: unknown): CanaryAuthorizationMode | undefined {
  const raw = (query as { mode?: unknown } | null)?.mode;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !CANARY_AUTHORIZATION_MODES.includes(raw as CanaryAuthorizationMode)) {
    throw new ValidationError(
      `mode must be one of: ${CANARY_AUTHORIZATION_MODES.join(", ")}. Omit it for the default.`
    );
  }
  return raw as CanaryAuthorizationMode;
}
