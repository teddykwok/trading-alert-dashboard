import type { FastifyInstance } from "fastify";

import { readSignalSourcesStatus } from "../modules/signal-sources/signal-sources.service";

/**
 * GET /api/signal-sources/status — read-only status of the two signal sources
 * (TradingView webhook ingestion and the Native scanner) for the dashboard.
 * Writes nothing; exposes no path, secret, pid or account.
 */
export async function signalSourcesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/signal-sources/status", async () => readSignalSourcesStatus({ prisma: app.prisma }));
}
