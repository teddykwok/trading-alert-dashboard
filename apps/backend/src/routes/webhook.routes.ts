import type { FastifyInstance } from "fastify";
import { handleTradingViewWebhook } from "../modules/webhook/webhook.service";

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/webhooks/tradingview", async (request, reply) => {
    const result = await handleTradingViewWebhook(app.prisma, request.body);
    return reply.code(202).send(result);
  });
}
