import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * UI SCALABILITY V1: the execution journal's search, source filter, account
 * (profile) options and combined filters. READ ONLY, TEST database only.
 *
 * No Native-sourced execution is created: Native execution is hard-disabled,
 * so the Native source filter must simply find none.
 */

const TAG = "ui-scal-journal";
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient = testDatabase;
const maybe = () => (available ? it : it.skip);

const { executionsRoutes } = await import("../src/routes/executions.routes");
const { AppError } = await import("../src/utils/errors");

const operations: string[] = [];
const observed = (available
  ? prisma.$extends({
      query: {
        async $allOperations({ model, operation, args, query }) {
          operations.push(`${model ?? "$raw"}.${operation}`);
          return query(args);
        },
      },
    })
  : prisma) as unknown as PrismaClient;

let app: FastifyInstance;
let profileId = "";
const ids: Record<string, string> = {};

const base = {
  positionSide: "LONG" as const, selectedLookback: 100, plannedEntryPrice: "100", calculatedStopLoss: "96", executableStopLoss: "96",
  riskBudgetUsd: "1.50", quantityRaw: "0.375", plannedQuantity: "0.375", quantityStepSize: "0.001", actualPlannedLoss: "1.5", unusedRiskBudget: "0",
  positionNotional: "37.5", targetIsolatedMargin: "3.75", maximumIsolatedMargin: "5.00", selectedLeverage: 10, estimatedInitialMargin: "3.75", liquidationBufferRatio: "0.5",
};

async function cleanup() {
  if (!available) return;
  const profiles = await prisma.executionProfile.findMany({ where: { accountIdentifier: { startsWith: TAG } }, select: { id: true } });
  const executionIds = (await prisma.tradeExecution.findMany({ where: { executionProfileId: { in: profiles.map((p) => p.id) } }, select: { id: true } })).map((r) => r.id);
  if (executionIds.length > 0) {
    await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
    await prisma.tradeExecution.deleteMany({ where: { id: { in: executionIds } } });
  }
  await prisma.executionProfile.deleteMany({ where: { accountIdentifier: { startsWith: TAG } } });
  await prisma.alert.deleteMany({ where: { indicatorName: TAG } });
}

beforeAll(async () => {
  if (!available) return;
  await cleanup();
  const profile = await prisma.executionProfile.create({ data: { name: "UI scal profile", accountIdentifier: `${TAG}-account`, environment: "TESTNET" } });
  profileId = profile.id;
  const alert = await prisma.alert.create({ data: { symbol: "UISCALBTCUSDT", assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 100, signal: "LONG", indicatorName: TAG, rawPayload: { note: TAG }, triggeredAt: new Date() } });
  ids.alert = alert.id;
  ids.linked = (await prisma.tradeExecution.create({ data: { ...base, executionProfileId: profileId, alertId: alert.id, symbol: "UISCALBTCUSDT", direction: "LONG", status: "PROTECTED" } })).id;
  ids.closed = (await prisma.tradeExecution.create({ data: { ...base, executionProfileId: profileId, symbol: "UISCALETHUSDT", direction: "SHORT", positionSide: "SHORT", status: "CLOSED_TP" } })).id;
  ids.skipped = (await prisma.tradeExecution.create({ data: { ...base, executionProfileId: profileId, symbol: "UISCALSOLUSDT", direction: "LONG", status: "SKIPPED" } })).id;

  app = Fastify();
  app.decorate("prisma", observed);
  await app.register(executionsRoutes);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: error.name, message: error.message });
    return reply.code(500).send({ error: "Internal", message: String(error) });
  });
  await app.ready();
});

afterAll(async () => {
  if (available) {
    await app?.close();
    await cleanup();
    await prisma.$disconnect();
  }
});

interface ListBody {
  items: Array<{ id: string; alertSource: string | null; status: string; profile: Record<string, unknown> }>;
  total: number;
  profiles: Array<Record<string, unknown>>;
}
const list = async (query: string) => {
  const response = await app.inject({ method: "GET", url: `/api/executions?executionProfileId=${profileId}&${query}` });
  return { status: response.statusCode, body: response.json() as ListBody };
};
const idsOf = (body: ListBody) => body.items.map((item) => item.id).sort();

describe("execution journal: search, source, account options, combined filters (read only)", () => {
  maybe()("q matches a symbol fragment case-insensitively, an exact execution id, or an exact alert id", async () => {
    expect(idsOf((await list("q=uiscal")).body)).toEqual([ids.linked, ids.closed, ids.skipped].sort());
    expect(idsOf((await list("q=ETH")).body)).toEqual([ids.closed]);
    expect(idsOf((await list(`q=${ids.skipped}`)).body)).toEqual([ids.skipped]);
    expect(idsOf((await list(`q=${ids.alert}`)).body)).toEqual([ids.linked]);
    expect((await list("q=NOSUCHTHING")).body.total).toBe(0);
  });

  maybe()("source comes from the linked alert: TradingView finds the linked one, Native finds none, unlinked rows show null", async () => {
    const tv = (await list("source=TRADINGVIEW")).body;
    expect(idsOf(tv)).toEqual([ids.linked]);
    expect(tv.items[0].alertSource).toBe("TRADINGVIEW");
    expect((await list("source=NATIVE")).body.total).toBe(0);
    const all = (await list("pageSize=50")).body;
    expect(all.items.find((item) => item.id === ids.closed)?.alertSource).toBeNull();
  });

  maybe()("status and lifecycle combine (AND): a status the lifecycle excludes yields nothing", async () => {
    expect((await list("status=PROTECTED&lifecycle=closed")).body.total).toBe(0);
    expect(idsOf((await list("status=CLOSED_TP&lifecycle=closed")).body)).toEqual([ids.closed]);
    expect(idsOf((await list("status=PROTECTED&lifecycle=active")).body)).toEqual([ids.linked]);
    expect(idsOf((await list("lifecycle=closed")).body)).toEqual([ids.closed, ids.skipped].sort());
  });

  maybe()("the account options list profiles with executions — name and environment only, never the account identifier", async () => {
    const body = (await list("pageSize=25")).body;
    const mine = body.profiles.find((p) => p.id === profileId);
    expect(mine).toEqual({ id: profileId, name: "UI scal profile", environment: "TESTNET" });
    expect(JSON.stringify(body)).not.toContain(`${TAG}-account`);
    expect(JSON.stringify(body)).not.toContain("accountIdentifier");
  });

  maybe()("an invalid search or source is refused (422), never ignored", async () => {
    for (const bad of ["q=BTC%25", "q=BTC%20USDT", "q=BTC_USDT", `q=${"A".repeat(65)}`, "source=BINANCE", "source=native"]) {
      expect((await list(bad)).status, bad).toBe(422);
    }
  });

  maybe()("a list request only reads", async () => {
    operations.length = 0;
    expect((await list("q=uiscal&source=TRADINGVIEW&status=PROTECTED&lifecycle=active&pageSize=100")).status).toBe(200);
    expect(operations.length).toBeGreaterThan(0);
    for (const op of operations) expect(["findMany", "findFirst", "findUnique", "count"], op).toContain(op.split(".")[1]);
  });
});
