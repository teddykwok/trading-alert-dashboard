import type { FastifyInstance } from "fastify";
import { ExtremeRRService } from "../modules/extreme-rr/extreme-rr.service";
import { extremeRRSelectionSchema } from "../modules/extreme-rr/extreme-rr.schema";
import { ValidationError } from "../utils/errors";

export async function extremeRRRoutes(app: FastifyInstance): Promise<void> {
  const service = new ExtremeRRService(app.prisma);

  // Returns the alert's plan, or null when none exists yet (e.g. alerts that
  // predate the feature) — the UI then offers a manual "Generate plan".
  app.get<{ Params: { alertId: string } }>(
    "/api/alerts/:alertId/extreme-rr",
    async (request) => {
      return service.getForAlert(request.params.alertId);
    }
  );

  // Manual generation for eligible (LONG/SHORT) alerts. Always uses the
  // alert's ORIGINAL triggeredAt as the candle cutoff; a READY plan is
  // returned unchanged (frozen). Generation failures come back as a plan
  // with status ERROR, never as a 500.
  app.post<{ Params: { alertId: string } }>(
    "/api/alerts/:alertId/extreme-rr/generate",
    async (request) => {
      return service.generateForAlert(request.params.alertId);
    }
  );

  // The only client-writable fields: selectedLookback (100/200/300) and
  // selectedLeverage (5/10/15/20/25 or null). Any SL/TP/quantity/margin sent
  // by a client is stripped — the server recalculates everything.
  app.patch<{ Params: { alertId: string } }>(
    "/api/alerts/:alertId/extreme-rr",
    async (request) => {
      const parsed = extremeRRSelectionSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid Extreme RR selection", parsed.error.flatten());
      }
      return service.updateSelection(request.params.alertId, parsed.data);
    }
  );
}
