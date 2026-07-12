import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ALERT_STATUSES,
  ASSET_TYPES,
  LEVEL_COLORS,
  SIGNAL_TYPES,
  SOURCE_TIMEFRAMES,
} from "@trading-alert-dashboard/shared";
import { AlertsService } from "../modules/alerts/alerts.service";
import { withAlertContext } from "../modules/alerts/alert-context";
import { ValidationError } from "../utils/errors";

const listQuerySchema = z.object({
  status: z.enum(ALERT_STATUSES).optional(),
  symbol: z.string().min(1).optional(),
  signal: z.enum(SIGNAL_TYPES).optional(),
  assetType: z.enum(ASSET_TYPES).optional(),
  // Level-context filters: match the structured columns only, so alerts from
  // before those columns existed (all-null) are not returned by these filters.
  sourceTimeframe: z.enum(SOURCE_TIMEFRAMES).optional(),
  levelColor: z.enum(LEVEL_COLORS).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const statusUpdateSchema = z.object({
  status: z.enum(ALERT_STATUSES),
  errorMessage: z.string().optional(),
});

export async function alertsRoutes(app: FastifyInstance): Promise<void> {
  const alertsService = new AlertsService(app.prisma);

  app.get("/api/alerts", async (request) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.flatten());
    }

    const { items, total } = await alertsService.list(parsed.data);
    return {
      items: items.map(withAlertContext),
      total,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    };
  });

  app.get<{ Params: { id: string } }>("/api/alerts/:id", async (request) => {
    return withAlertContext(await alertsService.getByIdOrThrow(request.params.id));
  });

  app.patch<{ Params: { id: string } }>("/api/alerts/:id/status", async (request) => {
    const parsed = statusUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid status update", parsed.error.flatten());
    }
    return withAlertContext(
      await alertsService.setStatus(request.params.id, parsed.data.status, parsed.data.errorMessage)
    );
  });

  app.delete<{ Params: { id: string } }>("/api/alerts/:id", async (request, reply) => {
    await alertsService.delete(request.params.id);
    return reply.code(204).send();
  });
}
