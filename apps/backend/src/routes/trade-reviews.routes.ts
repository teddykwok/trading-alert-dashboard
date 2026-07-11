import type { FastifyInstance } from "fastify";
import { TradeReviewService } from "../modules/trade-review/trade-review.service";
import {
  tradeReviewStatsQuerySchema,
  tradeReviewUpsertSchema,
} from "../modules/trade-review/trade-review.schema";
import { ValidationError } from "../utils/errors";

export async function tradeReviewsRoutes(app: FastifyInstance): Promise<void> {
  const tradeReviewService = new TradeReviewService(app.prisma);

  // Returns the alert's review, or a default UNREVIEWED representation
  // (id: null) when the alert has never been reviewed — never a 500.
  app.get<{ Params: { alertId: string } }>(
    "/api/alerts/:alertId/trade-review",
    async (request) => {
      return tradeReviewService.getForAlert(request.params.alertId);
    }
  );

  app.put<{ Params: { alertId: string } }>(
    "/api/alerts/:alertId/trade-review",
    async (request) => {
      const parsed = tradeReviewUpsertSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid trade review payload", parsed.error.flatten());
      }
      return tradeReviewService.upsertForAlert(request.params.alertId, parsed.data);
    }
  );

  app.get("/api/trade-reviews/stats", async (request) => {
    const parsed = tradeReviewStatsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ValidationError("Invalid stats query", parsed.error.flatten());
    }
    return tradeReviewService.stats(parsed.data);
  });
}
