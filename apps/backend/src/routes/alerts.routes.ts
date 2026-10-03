import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ALERT_SOURCES,
  ALERT_STATUSES,
  ASSET_TYPES,
  LEVEL_COLORS,
  SIGNAL_TYPES,
  SOURCE_TIMEFRAMES,
} from "@trading-alert-dashboard/shared";
import { AlertsService } from "../modules/alerts/alerts.service";
import { withAlertContext } from "../modules/alerts/alert-context";
import { ValidationError } from "../utils/errors";
import { env } from "../config/env";

// Exported for tests. Page size defaults/caps are env-driven
// (DASHBOARD_DEFAULT_LIMIT / DASHBOARD_MAX_LIMIT): the default is one page,
// not the accessible history — older retained alerts are reached via offset.
export const listQuerySchema = z.object({
  status: z.enum(ALERT_STATUSES).optional(),
  symbol: z.string().min(1).optional(),
  signal: z.enum(SIGNAL_TYPES).optional(),
  // Comma-separated multi-signal filter, e.g. "LONG,SHORT" for the
  // dashboard's "Long + Short only" (signal-direction) view. Wins over
  // `signal` when present.
  signals: z
    .string()
    .min(1)
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
    )
    .pipe(z.array(z.enum(SIGNAL_TYPES)).min(1).optional()),
  assetType: z.enum(ASSET_TYPES).optional(),
  // Level-context filters: match the structured columns only, so alerts from
  // before those columns existed (all-null) are not returned by these filters.
  sourceTimeframe: z.enum(SOURCE_TIMEFRAMES).optional(),
  // Comma-separated multi-source-timeframe filter (OR semantics), e.g.
  // "1D,1W". Wins over `sourceTimeframe` when present.
  sourceTimeframes: z
    .string()
    .min(1)
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
    )
    .pipe(z.array(z.enum(SOURCE_TIMEFRAMES)).min(1).optional()),
  levelColor: z.enum(LEVEL_COLORS).optional(),
  // Which SOURCE produced the alert: an actual TradingView webhook delivery, or
  // Native scanner evidence. Absent = both. Independent of every other filter.
  source: z.enum(ALERT_SOURCES).optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(env.DASHBOARD_MAX_LIMIT)
    .default(env.DASHBOARD_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Neighbor lookup accepts the list's filter set but never paging — neighbors
 * are position-based, not page-based. Exported for tests.
 */
export const neighborsQuerySchema = listQuerySchema.omit({ limit: true, offset: true });

/**
 * Stat-card range. Both bounds are REQUIRED and explicit: "today" depends on
 * the viewer's timezone, which the server cannot infer, so the client sends
 * the exact instants bounding its local day. Exported for tests.
 */
export const statsQuerySchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((value) => value.from < value.to, { message: "`from` must be before `to`" });

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

  // Registered before "/api/alerts/:id" so the static segment reads
  // unambiguously as a collection-level resource, not an alert id.
  app.get("/api/alerts/stats", async (request) => {
    const parsed = statsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ValidationError("Invalid stats query", parsed.error.flatten());
    }
    return alertsService.statsForRange(parsed.data);
  });

  app.get<{ Params: { id: string } }>("/api/alerts/:id", async (request) => {
    return withAlertContext(await alertsService.getByIdOrThrow(request.params.id));
  });

  // Adjacent alerts (dashboard ordering: createdAt DESC, id DESC) within the
  // supplied filter set. Powers the detail page's filter-aware Newer/Older
  // navigation without depending on what pages the browser happens to have
  // loaded. 404s when the current alert doesn't exist; `newer`/`older` are
  // null at the respective boundary.
  app.get<{ Params: { id: string } }>("/api/alerts/:id/neighbors", async (request) => {
    const parsed = neighborsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.flatten());
    }
    return alertsService.neighbors(request.params.id, parsed.data);
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
