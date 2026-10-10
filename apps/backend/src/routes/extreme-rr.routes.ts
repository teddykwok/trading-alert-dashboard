import type { FastifyInstance } from "fastify";
import { NATIVE_PLAN_PAGE_QUERY_KEYS } from "@trading-alert-dashboard/shared";
import { ExtremeRRService, NATIVE_PLAN_LIST_LIMIT } from "../modules/extreme-rr/extreme-rr.service";
import { extremeRRSelectionSchema, nativePlanPageQuerySchema } from "../modules/extreme-rr/extreme-rr.schema";
import { fileSystemNativeScannerEvidence } from "../modules/native-integrity/native-execution-integrity";
import { ValidationError } from "../utils/errors";

const PAGE_KEYS: ReadonlySet<string> = new Set(NATIVE_PLAN_PAGE_QUERY_KEYS);

export async function extremeRRRoutes(app: FastifyInstance): Promise<void> {
  const service = new ExtremeRRService(app.prisma);
  // Read only: the machine-local scanner evidence behind each Native item's execution-integrity line.
  const integrityEvidence = fileSystemNativeScannerEvidence(process.env);

  // Returns the alert's plan, or null when none exists yet (e.g. alerts that
  // predate the feature) — the UI then offers a manual "Generate plan".
  app.get<{ Params: { alertId: string } }>(
    "/api/alerts/:alertId/extreme-rr",
    async (request) => {
      return service.getForAlert(request.params.alertId);
    }
  );

  // READ ONLY: the most recent Native plans, each as its selected, frozen
  // summary, for Trading Control to display. Generates and writes nothing;
  // every item says PLANNING ONLY / EXECUTION DISABLED, plus a read-only
  // execution data-integrity status that grants nothing.
  //
  // Two shapes on one route. With none of NATIVE_PLAN_PAGE_QUERY_KEYS it is the
  // original list (optionally `limit`), unchanged. With any of them it is a
  // PAGE: search and filters, newest trigger first, keyset-paged, plus
  // `pagination` and `summary`. Unknown keys are refused in both shapes.
  app.get<{ Querystring: Record<string, unknown> }>("/api/extreme-rr/native-plans", async (request) => {
    const query = request.query ?? {};
    const keys = Object.keys(query);
    const unknown = keys.filter((key) => key !== "limit" && !PAGE_KEYS.has(key));
    if (unknown.length > 0) {
      throw new ValidationError(`Unknown query parameter(s): ${unknown.join(", ")}. Allowed: limit, or ${[...PAGE_KEYS].join(", ")}`);
    }
    if (!keys.some((key) => PAGE_KEYS.has(key))) {
      const raw = query.limit as string | undefined;
      if (raw !== undefined && !/^\d{1,3}$/.test(raw)) {
        throw new ValidationError(`limit must be an integer 1..${NATIVE_PLAN_LIST_LIMIT.max}`);
      }
      return service.listNativePlans(raw === undefined ? NATIVE_PLAN_LIST_LIMIT.default : Number(raw), undefined, integrityEvidence);
    }
    if (keys.includes("limit")) {
      throw new ValidationError("limit belongs to the original list; a page query takes pageSize");
    }
    const parsed = nativePlanPageQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new ValidationError("Invalid Native plan page query", parsed.error.flatten());
    }
    return service.listNativePlanPage(parsed.data, undefined, integrityEvidence);
  });

  // Manual generation for eligible (LONG/SHORT) alerts — TradingView and
  // Native alike (a new Native alert is also planned automatically by the separate,
  // planning-only Native planning worker; never the TradingView queue). Always uses the
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
