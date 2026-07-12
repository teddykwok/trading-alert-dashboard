import type { FastifyInstance } from "fastify";
import { TradeJournalService } from "../modules/trade-journal/trade-journal.service";
import { tradeJournalUpsertSchema } from "../modules/trade-journal/trade-journal.schema";
import { ValidationError } from "../utils/errors";

export async function tradeJournalsRoutes(app: FastifyInstance): Promise<void> {
  const tradeJournalService = new TradeJournalService(app.prisma);

  // Returns the alert's journal, or a default all-unchecked representation
  // (id: null) when none exists. GET never creates a database row.
  app.get<{ Params: { alertId: string } }>(
    "/api/alerts/:alertId/trade-journal",
    async (request) => {
      return tradeJournalService.getForAlert(request.params.alertId);
    }
  );

  app.put<{ Params: { alertId: string } }>(
    "/api/alerts/:alertId/trade-journal",
    async (request) => {
      const parsed = tradeJournalUpsertSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid trade journal payload", parsed.error.flatten());
      }
      return tradeJournalService.upsertForAlert(request.params.alertId, parsed.data);
    }
  );

  app.get("/api/trade-journals/stats", async () => {
    return tradeJournalService.stats();
  });
}
