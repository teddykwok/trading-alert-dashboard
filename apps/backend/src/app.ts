import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { env } from "./config/env";
import { loggerOptions } from "./config/logger";
import { prismaPlugin } from "./plugins/prisma";
import { socketPlugin } from "./plugins/socket";
import { rateLimitPlugin } from "./plugins/rate-limit";
import { healthRoutes } from "./routes/health.routes";
import { webhookRoutes } from "./routes/webhook.routes";
import { alertsRoutes } from "./routes/alerts.routes";
import { assetsRoutes } from "./routes/assets.routes";
import { settingsRoutes } from "./routes/settings.routes";
import { tradeReviewsRoutes } from "./routes/trade-reviews.routes";
import { tradeJournalsRoutes } from "./routes/trade-journals.routes";
import { riskTemplatesRoutes } from "./routes/risk-templates.routes";
import { extremeRRRoutes } from "./routes/extreme-rr.routes";
import { executionsRoutes } from "./routes/executions.routes";
import { operatorRoutes } from "./routes/operator.routes";
import { accountOperatorGatewayRoutes } from "./modules/operator/account-operator-gateway";
import { signalSourcesRoutes } from "./routes/signal-sources.routes";
import { AppError } from "./utils/errors";
import { ensureScreenshotDir } from "./utils/file";

/**
 * Phase 11F -- the two HTTP surfaces, and why they are separate processes.
 *
 * Every operator control service resolves its account the same way:
 * `resolveExecutionProfile(prisma, configuredProfileIdentity())`, from
 * PROCESS ENVIRONMENT, never from the request. That is deliberate -- a route
 * that accepted `executionProfileId` would be a profile enumeration API --
 * and it means one process can only ever control one account.
 *
 * The readiness route makes it stronger still: it reaches
 * `bindConfiguredExchangeRuntime` and performs SIGNED Binance reads, so the
 * process holding these routes holds an account's credentials.
 *
 * The generic surface holds none of that. It ingests the webhook, serves the
 * dashboard's reads and produces queue jobs -- work that belongs to no
 * account and must happen exactly once however many accounts exist.
 *
 * So the split is by PROCESS, matching the 11E worker split:
 *
 *   buildApp()               ONE process, no account   generic/public
 *   buildAccountControlApp() ONE process PER account   account control
 */

/** Plumbing both surfaces need. Neither of these touches an account. */
async function createBaseApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: loggerOptions });

  await app.register(cors, { origin: env.FRONTEND_URL });
  await app.register(rateLimitPlugin);
  await app.register(prismaPlugin);

  return app;
}

/**
 * The GENERIC/PUBLIC surface. Binds no account and holds no credential.
 *
 * It owns the TradingView webhook, and it is the ONLY composition that does:
 * a second ingester would duplicate Alert rows (suppression is a
 * read-then-write with no unique key behind it), duplicate vision jobs, and
 * duplicate plans (`enqueueExtremeRRPlan` sets no jobId).
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = await createBaseApp();
  await app.register(socketPlugin);

  const screenshotDir = await ensureScreenshotDir();
  await app.register(fastifyStatic, {
    root: path.resolve(screenshotDir),
    prefix: "/screenshots/",
    decorateReply: false,
  });

  await app.register(healthRoutes);
  await app.register(webhookRoutes);
  await app.register(alertsRoutes);
  await app.register(assetsRoutes);
  await app.register(settingsRoutes);
  await app.register(tradeReviewsRoutes);
  await app.register(tradeJournalsRoutes);
  await app.register(riskTemplatesRoutes);
  await app.register(extremeRRRoutes);
  // Reads only, and already multi-account: the journal filters by
  // executionProfileId as a QUERY, which is safe because it selects what to
  // display and never what to act on.
  await app.register(executionsRoutes);
  // Read-only status of the two signal sources (TradingView webhook, Native scanner).
  await app.register(signalSourcesRoutes);
  // The ONE frontend's same-origin path to exactly one account's loopback
  // control plane per request. Holds no credential and decides nothing: the
  // account control plane still authenticates and authorizes everything.
  await app.register(accountOperatorGatewayRoutes);

  registerErrorHandler(app);
  return app;
}

/**
 * The ACCOUNT CONTROL surface. One process, one configured account.
 *
 * Mounts the operator routes and nothing else. No webhook -- ingestion is
 * global and lives on the generic surface. No alert ingestion, no Socket.IO,
 * no screenshot static: an operator control plane serves control, and every
 * additional surface here would be a second copy of something global.
 */
export async function buildAccountControlApp(): Promise<FastifyInstance> {
  const app = await createBaseApp();

  // Process liveness only. It deliberately says nothing about whether this
  // process bound its account: `accountReady` is answered by the runtime
  // attestation and by the operator readiness route, both of which fail
  // closed. A 200 here means the process is up, never that it may trade.
  app.get("/health", async () => ({
    status: "ok",
    surface: "ACCOUNT_CONTROL",
    time: new Date().toISOString(),
  }));

  await app.register(operatorRoutes);

  registerErrorHandler(app);
  return app;
}

function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      const body: Record<string, unknown> = { error: error.name, message: error.message };
      if ("details" in error) body.details = (error as { details?: unknown }).details;
      return reply.code(error.statusCode).send(body);
    }

    if (error instanceof ZodError) {
      return reply.code(422).send({ error: "ValidationError", message: "Invalid request", details: error.flatten() });
    }

    app.log.error(error);
    return reply.code(500).send({ error: "InternalServerError", message: "Something went wrong" });
  });
}
