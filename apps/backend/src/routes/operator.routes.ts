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
import { SourceTimeframeService } from "../modules/operator/source-timeframes.service";
import { ExtremeRrLookbackService } from "../modules/operator/extreme-rr-lookback.service";
import { PolicyEditorService } from "../modules/operator/policy-editor.service";
import { resolveSessionCapability } from "../modules/operator/session-capability";
import {
  SESSION_BUDGET_PRESETS,
  SESSION_DURATION_PRESET_MINUTES,
  SESSION_MAX_DURATION_MINUTES,
  SESSION_MAX_TRADE_BUDGET,
} from "../modules/execution/trading-session";
import type {
  AllowlistSaveResult,
  AllowlistValidationResult,
} from "../modules/operator/allowlist.service";
import { CANARY_AUTHORIZATION_MODES, type CanaryAuthorizationMode } from "../modules/execution/canary-readiness";
import {
  HistoricalFillOperationalSnapshotService,
  type HistoricalFillOperationalSnapshot,
} from "../modules/execution/historical-fill-operational-snapshot.service";
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
  /** Injected in tests so a snapshot can be scripted without seeding a queue. */
  historicalFillSnapshotFactory?: (prisma: PrismaClient) => HistoricalFillReader;
}

/** The one method the historical-fill route needs, so a test can supply it. */
export interface HistoricalFillReader {
  capture(options?: { now?: Date }): Promise<HistoricalFillOperationalSnapshot>;
}

/** A durable instant on the wire, or null. Never a Date, never a number. */
const isoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/**
 * The wire contract, written out field by field.
 *
 * This IS the allowlist. No route in this project declares a Fastify response
 * schema, so rather than introduce a serializer stack for one endpoint, the
 * body is CONSTRUCTED rather than forwarded: a property the snapshot grows
 * later cannot reach an operator's browser until someone adds it here on
 * purpose. Counts stay numbers; the four durable instants become ISO-8601
 * strings; a null instant stays null.
 */
function serializeHistoricalFillSnapshot(snapshot: HistoricalFillOperationalSnapshot) {
  if (snapshot.outcome === "PROFILE_UNAVAILABLE") {
    return {
      outcome: snapshot.outcome,
      capturedAt: snapshot.capturedAt.toISOString(),
      reasonCode: snapshot.reasonCode,
    };
  }

  const { windows, pending, ledger } = snapshot;
  return {
    outcome: snapshot.outcome,
    capturedAt: snapshot.capturedAt.toISOString(),
    executionProfileId: snapshot.executionProfileId,
    windows: {
      total: windows.total,
      roots: windows.roots,
      children: windows.children,
      distinctSymbolCount: windows.distinctSymbolCount,
      byStatus: {
        PENDING: windows.byStatus.PENDING,
        COMPLETE: windows.byStatus.COMPLETE,
        SPLIT: windows.byStatus.SPLIT,
        INCOMPLETE_SKIPPED_ROWS: windows.byStatus.INCOMPLETE_SKIPPED_ROWS,
        SATURATED_SINGLE_MILLISECOND: windows.byStatus.SATURATED_SINGLE_MILLISECOND,
        ABANDONED: windows.byStatus.ABANDONED,
      },
    },
    pending: {
      total: pending.total,
      claimableNow: pending.claimableNow,
      activeLease: pending.activeLease,
      staleLease: pending.staleLease,
      inBackoff: pending.inBackoff,
      attemptExhausted: pending.attemptExhausted,
      oldestPendingCreatedAt: isoOrNull(pending.oldestPendingCreatedAt),
      oldestClaimableCreatedAt: isoOrNull(pending.oldestClaimableCreatedAt),
      nextBackoffEligibleAt: isoOrNull(pending.nextBackoffEligibleAt),
    },
    ledger: {
      totalFills: ledger.totalFills,
      unattributedFills: ledger.unattributedFills,
    },
  };
}

/** The mutation surface. Three actions, and deliberately nothing else. */
export interface TradingControlActor {
  startTrading(
    confirmation: unknown,
    durationMinutes?: unknown,
    tradeBudget?: unknown,
    unlimited?: unknown
  ): Promise<TradingControlActionResult>;
  stopNewTrades(): Promise<TradingControlActionResult>;
  pauseNewTrades(): Promise<TradingControlActionResult>;
  resumeNewTrades(confirmation: unknown): Promise<TradingControlActionResult>;
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
  const buildHistoricalFillSnapshot =
    options.historicalFillSnapshotFactory ??
    ((prisma: PrismaClient) => new HistoricalFillOperationalSnapshotService({ prisma }));

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

  // What the panel may OFFER for a new session. Read-only, and the SERVER's
  // answer: the browser never decides whether unlimited is permitted, it only
  // renders what this says.
  app.get(
    "/api/operator/trading-control/session-capability",
    { preHandler: requireOperatorAuth },
    async () => {
      const capability = resolveSessionCapability();
      return {
        unlimitedPermitted: capability.unlimitedPermitted,
        profileEnvironment: capability.profileEnvironment,
        connectorEnvironment: capability.connectorEnvironment,
        reason: capability.reason,
        durationPresetMinutes: [...SESSION_DURATION_PRESET_MINUTES],
        maxDurationMinutes: SESSION_MAX_DURATION_MINUTES,
        budgetPresets: [...SESSION_BUDGET_PRESETS],
        maxTradeBudget: SESSION_MAX_TRADE_BUDGET,
      };
    }
  );

  app.get("/api/operator/auth-check", { preHandler: requireOperatorAuth }, async () => ({
    authenticated: true,
  }));

  /**
   * Durable historical-fill ingestion state, as FACTS.
   *
   * Reads only: counts, minimums and the configured profile's identity. It
   * claims nothing, seeds nothing, starts no batch and reaches no exchange.
   *
   * No request input of any kind is consulted -- no path parameter, no body and
   * notably no query. The account is whatever the process is bound to, and the
   * instant is the server's own: a caller who could pass `executionProfileId`
   * would have a profile enumeration API, and a caller who could pass `now`
   * could backdate a lease into looking expired. Neither is reachable because
   * neither is read.
   *
   * `PROFILE_UNAVAILABLE` is 200, not 401 or 503. It is a true statement about
   * configuration that the operator panel needs to render; authentication
   * already succeeded, and the server is working exactly as intended.
   *
   * `no-store` because this is live operational state: a cached copy would show
   * an operator a queue that has since moved.
   */
  app.get(
    "/api/operator/historical-fills/operations",
    { preHandler: requireOperatorAuth },
    async (request, reply) => {
      const snapshot = await buildHistoricalFillSnapshot(request.server.prisma).capture();
      reply.header("Cache-Control", "no-store");
      return serializeHistoricalFillSnapshot(snapshot);
    }
  );

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
        | {
            confirmation?: unknown;
            durationMinutes?: unknown;
            tradeBudget?: unknown;
            unlimited?: unknown;
          }
        | null
        | undefined;
      return runAction(request, reply, (actor) =>
        actor.startTrading(body?.confirmation, body?.durationMinutes, body?.tradeBudget, body?.unlimited)
      );
    }
  );

  app.post(
    "/api/operator/trading-control/stop-new-trades",
    { preHandler: requireOperatorAuth, ...OPERATOR_ACTION_RATE_LIMIT },
    async (request, reply) => runAction(request, reply, (actor) => actor.stopNewTrades())
  );

  /**
   * Pause takes no body and no confirmation phrase.
   *
   * It only ever makes the system safer, and an operator reaching for it while
   * something is going wrong should not have to type anything first. Operator
   * authentication and the action rate limit still apply, exactly as for stop.
   */
  app.post(
    "/api/operator/trading-control/pause-new-trades",
    { preHandler: requireOperatorAuth, ...OPERATOR_ACTION_RATE_LIMIT },
    async (request, reply) => runAction(request, reply, (actor) => actor.pauseNewTrades())
  );

  /** Resume reopens LIVE admission, so it is confirmed exactly as start is. */
  app.post(
    "/api/operator/trading-control/resume-new-trades",
    { preHandler: requireOperatorAuth, ...OPERATOR_ACTION_RATE_LIMIT },
    async (request, reply) => {
      const body = request.body as { confirmation?: unknown } | null | undefined;
      return runAction(request, reply, (actor) => actor.resumeNewTrades(body?.confirmation));
    }
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

  // --- Source-timeframe eligibility ---------------------------------------
  // Which SOURCE timeframe (the timeframe the level originated on) may create
  // a live execution. Reading stays available while armed so an operator can
  // always SEE what governs a live system; saving is refused unless the system
  // is SAFE_OFF and quiet, which the browser cannot check on its behalf.
  app.get(
    "/api/operator/trading-control/source-timeframes",
    { preHandler: requireOperatorAuth },
    async (request) => new SourceTimeframeService(request.server.prisma).read()
  );

  app.post(
    "/api/operator/trading-control/source-timeframes",
    { preHandler: requireOperatorAuth, ...OPERATOR_ACTION_RATE_LIMIT },
    async (request, reply) => {
      const body = request.body as { sourceTimeframes?: unknown } | null | undefined;
      const result = await new SourceTimeframeService(request.server.prisma).save(
        body?.sourceTimeframes
      );
      if (!result.ok) reply.code(409);
      return result;
    }
  );

  // --- Extreme RR lookback -------------------------------------------------
  // How many closed candles a NEW plan searches for its extreme. Reading stays
  // available while armed so an operator can always SEE what governs new
  // planning; saving is refused unless the system is SAFE_OFF and quiet.
  app.get(
    "/api/operator/trading-control/rr-lookback",
    { preHandler: requireOperatorAuth },
    async (request) => new ExtremeRrLookbackService(request.server.prisma).read()
  );

  app.post(
    "/api/operator/trading-control/rr-lookback",
    { preHandler: requireOperatorAuth, ...OPERATOR_ACTION_RATE_LIMIT },
    async (request, reply) => {
      const body = request.body as { lookbackCandles?: unknown } | null | undefined;
      const result = await new ExtremeRrLookbackService(request.server.prisma).save(
        body?.lookbackCandles
      );
      if (!result.ok) reply.code(409);
      return result;
    }
  );

  // --- Execution policy LIMITS --------------------------------------------
  // Reading and validating stay available while armed so an operator can see
  // and prepare an edit at any time; saving is refused unless the system is
  // SAFE_OFF and quiet, exactly as the allowlist and lookback editors are.
  //
  // These endpoints reach LIMITS only. Current open/pending/active counts and
  // reserved risk and margin are COUNTED from execution rows and have no
  // column to write, so there is deliberately nothing here that could set
  // them.
  app.get(
    "/api/operator/trading-control/policy",
    { preHandler: requireOperatorAuth },
    async (request) => new PolicyEditorService(request.server.prisma).read()
  );

  app.post(
    "/api/operator/trading-control/policy/validate",
    { preHandler: requireOperatorAuth, ...OPERATOR_ACTION_RATE_LIMIT },
    async (request, reply) => {
      const body = request.body as { policy?: unknown } | null | undefined;
      const result = await new PolicyEditorService(request.server.prisma).validate(body?.policy);
      if (!result.ok) reply.code(422);
      return result;
    }
  );

  app.post(
    "/api/operator/trading-control/policy",
    { preHandler: requireOperatorAuth, ...OPERATOR_ACTION_RATE_LIMIT },
    async (request, reply) => {
      const body = request.body as { policy?: unknown; expectedVersion?: unknown } | null | undefined;
      const result = await new PolicyEditorService(request.server.prisma).save(
        body?.policy,
        body?.expectedVersion
      );
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
