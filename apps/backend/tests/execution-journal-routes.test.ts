import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";

/**
 * Phase 8 route-layer tests.
 *
 * Only the journal routes are registered on a bare Fastify instance, so the
 * test exercises the real HTTP boundary (validation, 404s, GET-only) without
 * pulling in Redis, sockets or static file serving.
 */

const TAG = "phase8-routes";
const SYMBOL = "TESTRUSDT";

function resolveDatabaseUrl(): string | null {
  for (const candidate of [path.join(process.cwd(), ".env"), path.join(process.cwd(), "apps", "backend", ".env")]) {
    try {
      const match = /^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m.exec(readFileSync(candidate, "utf8"));
      if (match) return match[1].trim();
    } catch {
      // Try the next candidate path.
    }
  }
  return process.env.DATABASE_URL ?? null;
}

const databaseUrl = resolveDatabaseUrl();
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;

let available = false;
if (prisma) {
  try {
    await prisma.$queryRaw`SELECT 1`;
    available = true;
  } catch {
    console.warn("[phase8] Skipping journal route tests - no database reachable.");
  }
} else {
  console.warn("[phase8] Skipping journal route tests - no DATABASE_URL.");
}

const { executionsRoutes } = await import("../src/routes/executions.routes");
const { AppError } = await import("../src/utils/errors");

let app: FastifyInstance;
let profileId = "";
let executionId = "";

beforeAll(async () => {
  if (!prisma || !available) return;

  app = Fastify();
  app.decorate("prisma", prisma);
  await app.register(executionsRoutes);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: error.name, message: error.message });
    }
    return reply.code(500).send({ error: "Internal", message: "failed" });
  });
  await app.ready();

  const profile = await prisma.executionProfile.create({
    data: { name: "Phase 8 routes", accountIdentifier: `${TAG}-account`, environment: "TESTNET" },
  });
  profileId = profile.id;

  const execution = await prisma.tradeExecution.create({
    data: {
      executionProfileId: profileId, symbol: SYMBOL, direction: "LONG", positionSide: "LONG",
      selectedLookback: 200, status: "PLAN_READY",
      plannedEntryPrice: "100", calculatedStopLoss: "96", executableStopLoss: "96",
      riskBudgetUsd: "1.50", quantityRaw: "0.375", plannedQuantity: "0.375", quantityStepSize: "0.001",
      actualPlannedLoss: "1.5", unusedRiskBudget: "0", positionNotional: "37.5",
      targetIsolatedMargin: "3.75", maximumIsolatedMargin: "5.00", selectedLeverage: 10,
      estimatedInitialMargin: "3.75", liquidationBufferRatio: "0.5",
    },
  });
  executionId = execution.id;
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    const ids = (await prisma.tradeExecution.findMany({ where: { executionProfileId: profileId }, select: { id: true } })).map((row) => row.id);
    if (ids.length > 0) {
      await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.tradeExecution.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.executionProfile.deleteMany({ where: { accountIdentifier: `${TAG}-account` } });
    await app.close();
  }
  await prisma.$disconnect();
});

const maybe = () => (available ? it : it.skip);

describe("journal routes", () => {
  maybe()("lists executions with metrics", async () => {
    const response = await app.inject({ method: "GET", url: `/api/executions?executionProfileId=${profileId}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.metrics).toBeDefined();
    expect(body.pageSize).toBe(25);
  });

  maybe()("rejects an invalid page size rather than silently clamping at the boundary", async () => {
    const response = await app.inject({ method: "GET", url: "/api/executions?pageSize=0" });
    expect(response.statusCode).toBe(422);
  });

  maybe()("rejects an unknown direction value", async () => {
    const response = await app.inject({ method: "GET", url: "/api/executions?direction=SIDEWAYS" });
    expect(response.statusCode).toBe(422);
  });

  maybe()("rejects an over-large page size instead of silently serving it", async () => {
    const response = await app.inject({ method: "GET", url: "/api/executions?pageSize=5000" });
    expect(response.statusCode).toBe(422);
  });

  maybe()("returns a detail document", async () => {
    const response = await app.inject({ method: "GET", url: `/api/executions/${executionId}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(executionId);
    expect(typeof body.planned.entryPrice).toBe("string");
    expect(body.actual.realizedPnl).toBeNull();
    expect(body.actual.netPnlUsd).toBeNull();
  });

  maybe()("returns 404 for an unknown execution", async () => {
    const response = await app.inject({ method: "GET", url: "/api/executions/no-such-id" });
    expect(response.statusCode).toBe(404);
  });

  maybe()("returns 404 for an unknown timeline", async () => {
    const response = await app.inject({ method: "GET", url: "/api/executions/no-such-id/timeline" });
    expect(response.statusCode).toBe(404);
  });

  maybe()("returns an empty timeline array for an execution with no events", async () => {
    const response = await app.inject({ method: "GET", url: `/api/executions/${executionId}/timeline` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  maybe()("returns null for an alert with no execution", async () => {
    const response = await app.inject({ method: "GET", url: "/api/alerts/no-such-alert/execution" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });

  maybe()("exposes no write verb on any journal route", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url: "/api/executions" });
      expect(response.statusCode, method).toBe(404);
      const detail = await app.inject({ method, url: `/api/executions/${executionId}` });
      expect(detail.statusCode, `${method} detail`).toBe(404);
    }
  });
});
