import type { FastifyInstance } from "fastify";

import { fileSystemNativeScannerEvidence } from "../modules/native-integrity/native-execution-integrity";
import { signalQualityCsv, signalQualityJson } from "../modules/signal-quality/signal-quality-export";
import { SignalQualityMarketData } from "../modules/signal-quality/signal-quality-market-data";
import { ALERT_ID, parseAsOfOnly, parseSignalQualityQuery } from "../modules/signal-quality/signal-quality-query";
import { SignalQualityService, type SignalQualityServiceDeps } from "../modules/signal-quality/signal-quality.service";
import { ValidationError } from "../utils/errors";

/**
 * NATIVE SIGNAL QUALITY OBSERVATORY — READ-ONLY routes. MONITORING ONLY.
 *
 * Every route is a GET. None creates, updates or deletes an alert, plan,
 * adoption, lease, execution, order, account gate or risk; none starts or
 * stops a process; none calls a signed exchange endpoint or holds a
 * credential. Market data comes from PUBLIC Binance klines through a bounded,
 * cached adapter; when it is unavailable the observatory says so and nothing
 * else changes. Every response carries authority NONE.
 */
export async function signalQualityRoutes(app: FastifyInstance, opts: { deps?: Partial<SignalQualityServiceDeps> } = {}): Promise<void> {
  const service = new SignalQualityService({
    prisma: opts.deps?.prisma ?? app.prisma,
    marketData: opts.deps?.marketData ?? new SignalQualityMarketData(),
    integrityEvidence: opts.deps?.integrityEvidence === undefined ? fileSystemNativeScannerEvidence(process.env) : opts.deps.integrityEvidence,
    now: opts.deps?.now,
    readScannerStatus: opts.deps?.readScannerStatus,
    readEmitterStatus: opts.deps?.readEmitterStatus,
  });

  app.get("/api/signal-quality/summary", async (request) => service.summary(parseSignalQualityQuery(request.query)));

  app.get("/api/signal-quality/signals", async (request) => service.page(parseSignalQualityQuery(request.query)));

  app.get<{ Params: { alertId: string } }>("/api/signal-quality/signals/:alertId", async (request) => {
    if (!ALERT_ID.test(request.params.alertId)) throw new ValidationError("alertId is not an alert id");
    return service.detail(request.params.alertId, parseAsOfOnly(request.query));
  });

  app.get<{ Params: { alertId: string } }>("/api/signal-quality/signals/:alertId/chart", async (request) => {
    if (!ALERT_ID.test(request.params.alertId)) throw new ValidationError("alertId is not an alert id");
    return service.chart(request.params.alertId, parseAsOfOnly(request.query));
  });

  app.get("/api/signal-quality/export", async (request, reply) => {
    const raw = { ...((request.query ?? {}) as Record<string, unknown>) };
    const format = raw.format ?? "csv";
    delete raw.format;
    if (format !== "csv" && format !== "json") throw new ValidationError("format must be csv or json");
    const { window, sample, rows } = await service.exportRows(parseSignalQualityQuery(raw));
    const stamp = window.asOf.replace(/[:.]/g, "-");
    if (format === "json") {
      return reply.header("content-type", "application/json; charset=utf-8").header("content-disposition", `attachment; filename="native-signal-quality-${stamp}.json"`).send(signalQualityJson(window, sample, rows));
    }
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="native-signal-quality-${stamp}.csv"`).send(signalQualityCsv(rows));
  });

  app.get("/api/signal-quality/soak-health", async () => service.soakHealth());
}
