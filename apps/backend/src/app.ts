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
import { AppError } from "./utils/errors";
import { ensureScreenshotDir } from "./utils/file";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: loggerOptions });

  await app.register(cors, { origin: env.FRONTEND_URL });
  await app.register(rateLimitPlugin);
  await app.register(prismaPlugin);
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
  await app.register(executionsRoutes);

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

  return app;
}
