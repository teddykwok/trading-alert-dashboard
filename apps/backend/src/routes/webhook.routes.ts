import type { FastifyInstance } from "fastify";
import { handleTradingViewWebhook } from "../modules/webhook/webhook.service";
import { env } from "../config/env";

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/webhooks/tradingview",
    {
      // The only internet-facing route (Cloudflare tunnel), so it keeps its own
      // strict budget instead of sharing the generous dashboard one. Overrides
      // the global policy in plugins/rate-limit.ts; tune via env.
      config: {
        rateLimit: {
          max: env.WEBHOOK_RATE_LIMIT_MAX,
          timeWindow: env.WEBHOOK_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const result = await handleTradingViewWebhook(app.prisma, request.body);
      return reply.code(202).send(result);
    }
  );
}
