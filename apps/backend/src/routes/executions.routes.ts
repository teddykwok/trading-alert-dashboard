import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ExecutionJournalService,
  MAX_PAGE_SIZE,
  type ExecutionListFilters,
} from "../modules/execution/execution-journal.service";
import { ValidationError } from "../utils/errors";

/**
 * Phase 8 — READ-ONLY execution journal routes.
 *
 * GET only. There is deliberately no POST/PUT/PATCH/DELETE here: the journal
 * observes persisted state and never changes an execution, and no Binance
 * connector is imported anywhere in this file, so a dashboard request can
 * never reach an exchange.
 *
 * These routes sit behind the same access model as every other dashboard
 * route (the private/Tailscale boundary plus the dashboard rate limit); the
 * boundary is not widened.
 */

const listQuerySchema = z.object({
  symbol: z.string().trim().min(1).max(32).optional(),
  direction: z.enum(["LONG", "SHORT"]).optional(),
  // Repeated query params arrive as arrays; a single value as a string.
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value])),
  protectionState: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value])),
  executionProfileId: z.string().trim().min(1).max(64).optional(),
  environment: z.enum(["MAINNET", "TESTNET"]).optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
  requiresManualIntervention: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
  lifecycle: z.enum(["active", "closed"]).optional(),
  page: z.coerce.number().int().positive().max(10_000).default(1),
  // Bounded so a caller cannot request an unbounded page.
  pageSize: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(25),
});

export async function executionsRoutes(app: FastifyInstance): Promise<void> {
  const service = new ExecutionJournalService(app.prisma);

  /** Paginated summaries. Never includes timelines. */
  app.get("/api/executions", async (request) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ValidationError("Invalid execution list query", parsed.error.flatten());
    }
    const filters = parsed.data as ExecutionListFilters;
    const [result, metrics] = await Promise.all([
      service.listExecutions(filters),
      service.getExecutionSummaryMetrics(filters),
    ]);
    return { ...result, metrics };
  });

  app.get<{ Params: { executionId: string } }>("/api/executions/:executionId", async (request) => {
    return service.getExecutionDetail(request.params.executionId);
  });

  /** Loaded only when a detail view is opened — never as part of the list. */
  app.get<{ Params: { executionId: string } }>("/api/executions/:executionId/timeline", async (request) => {
    return service.getExecutionTimeline(request.params.executionId);
  });

  /** null (200) when the alert has no execution — opening the tab creates nothing. */
  app.get<{ Params: { alertId: string } }>("/api/alerts/:alertId/execution", async (request) => {
    return service.getExecutionForAlert(request.params.alertId);
  });
}
