import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";

import { env } from "../config/env";
import { requireOperatorAuth } from "../modules/operator/operator-auth";
import {
  START_TRADING_CONFIRMATION,
  TradingControlActionsService,
  type TradingControlActionResult,
} from "../modules/operator/trading-control-actions.service";
import { TradingControlService } from "../modules/operator/trading-control.service";
import { AllowlistService } from "../modules/operator/allowlist.service";
import type {
  AllowlistSaveResult,
  AllowlistValidationResult,
} from "../modules/operator/allowlist.service";
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
/**
 * Operator MUTATION budget.
 *
 * Follows the webhook route's convention of overriding the global dashboard
 * policy per route, but far stricter: these three actions arm and disarm a
 * real-money account, and a human uses them a handful of times an hour. The
 * read-only status poll deliberately keeps the generous dashboard budget.
 */
const OPERATOR_ACTION_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: env.OPERATOR_ACTION_RATE_LIMIT_MAX,
      timeWindow: env.OPERATOR_ACTION_RATE_LIMIT_WINDOW,
    },
  },
} as const;

export interface OperatorRoutesOptions {
  /**
   * How the trading-control reader is built.
   *
   * Injectable so a test can exercise the REAL route, guard and error handler
   * without a signed Binance round-trip. Production registration passes
   * nothing and gets the real service.
   */
  tradingControlFactory?: (prisma: PrismaClient) => TradingControlReader;
  /** Injected in tests so no real preflight, Redis read or profile write happens. */
  tradingControlActionsFactory?: (prisma: PrismaClient) => TradingControlActor;
  /** Injected in tests so allowlist validation never reaches the exchange. */
  allowlistFactory?: (prisma: PrismaClient) => AllowlistManager;
}

/** The mutation surface. Three actions, and deliberately nothing else. */
export interface TradingControlActor {
  startTrading(confirmation: unknown, durationMinutes?: unknown): Promise<TradingControlActionResult>;
  stopNewTrades(): Promise<TradingControlActionResult>;
  safeOff(): Promise<TradingControlActionResult>;
}

/** Allowlist management: one dry run, one write. Nothing else. */
export interface AllowlistManager {
  validate(raw: unknown): Promise<AllowlistValidationResult>;
  save(raw: unknown): Promise<AllowlistSaveResult>;
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
  const buildTradingControlActions =
    options.tradingControlActionsFactory ??
    ((prisma: PrismaClient) => new TradingControlActionsService(prisma));
  const buildAllowlist =
    options.allowlistFactory ?? ((prisma: PrismaClient) => new AllowlistService(prisma));

  /**
   * Every mutation answers the same way: the action's own sanitized result, and
   * HTTP 409 when it refused. 409 rather than 400 because a refusal is almost
   * always a CONFLICT with authoritative state — gates shut, attestation
   * failing, a window already active — not a malformed request. The operator
   * session must survive it, which is exactly what distinguishes it from 401.
   */
  const runAction = async (
    request: FastifyRequest,
    reply: FastifyReply,
    run: (actor: TradingControlActor) => Promise<TradingControlActionResult>
  ): Promise<TradingControlActionResult> => {
    const result = await run(buildTradingControlActions(request.server.prisma));
    if (!result.ok) reply.code(409);
    return result;
  };

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

  // --- Operator ACTIONS ---------------------------------------------------
  // Three POSTs, each behind the operator guard and the strict mutation budget.
  // Each one delegates to the SAME function the operator CLI calls; none of
  // them contains control logic of its own.

  app.post(
    "/api/operator/trading-control/start",
    { preHandler: requireOperatorAuth, ...OPERATOR_ACTION_RATE_LIMIT },
    async (request, reply) => {
      // The confirmation phrase is validated by the service, on the server.
      // The browser dialog is a courtesy, never the boundary.
      const body = request.body as
        | { confirmation?: unknown; durationMinutes?: unknown }
        | null
        | undefined;
      return runAction(request, reply, (actor) =>
        actor.startTrading(body?.confirmation, body?.durationMinutes)
      );
    }
  );

  app.post(
    "/api/operator/trading-control/stop-new-trades",
    { preHandler: requireOperatorAuth, ...OPERATOR_ACTION_RATE_LIMIT },
    async (request, reply) => runAction(request, reply, (actor) => actor.stopNewTrades())
  );

  app.post(
    "/api/operator/trading-control/safe-off",
    { preHandler: requireOperatorAuth, ...OPERATOR_ACTION_RATE_LIMIT },
    async (request, reply) => runAction(request, reply, (actor) => actor.safeOff())
  );

  // --- Allowlist management ----------------------------------------------
  // Validation is a DRY RUN and writes nothing, so it stays available even
  // while armed: an operator may prepare a list before deciding to go safe.
  // Saving is a mutation and the service refuses it unless the system is
  // SAFE_OFF and quiet — a check the browser cannot perform on its behalf.
  app.post(
    "/api/operator/trading-control/allowlist/validate",
    { preHandler: requireOperatorAuth, ...OPERATOR_ACTION_RATE_LIMIT },
    async (request, reply) => {
      const body = request.body as { symbols?: unknown } | null | undefined;
      const result = await buildAllowlist(request.server.prisma).validate(body?.symbols);
      if (!result.ok) reply.code(422);
      return result;
    }
  );

  app.post(
    "/api/operator/trading-control/allowlist",
    { preHandler: requireOperatorAuth, ...OPERATOR_ACTION_RATE_LIMIT },
    async (request, reply) => {
      const body = request.body as { symbols?: unknown } | null | undefined;
      const result = await buildAllowlist(request.server.prisma).save(body?.symbols);
      if (!result.ok) reply.code(409);
      return result;
    }
  );
}

/** Exposed so the panel can render the exact phrase it must send. */
export { START_TRADING_CONFIRMATION };

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
