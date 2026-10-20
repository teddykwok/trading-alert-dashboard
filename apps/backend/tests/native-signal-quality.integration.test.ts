import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * M6.5 — the READ-ONLY signal-quality API against the dedicated `_test`
 * database (section 18). Rows are owned by `native-m65` tagged alerts and
 * removed afterwards. Market data comes from a fake public fetch that records
 * every URL; scanner evidence from a fake reader. The whole `_test` schema is
 * digested before and after every request kind: the API writes nothing.
 */

const TAG = "native-m65";
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { signalQualityRoutes } = await import("../src/routes/signal-quality.routes");
const { SignalQualityMarketData } = await import("../src/modules/signal-quality/signal-quality-market-data");
const { AppError } = await import("../src/utils/errors");
const fixtures = await import("./helpers/native-canary-fixtures");

const maybe = () => (available ? it : it.skip);
const MINUTE = 60_000;
const SOAK_START = fixtures.SOURCE_BAR - 3_600_000;
const SOAK_END = fixtures.SOURCE_BAR + 23 * 3_600_000;
const AS_OF = fixtures.SOURCE_BAR + 27 * 3_600_000;
const q = (extra = "") => `soakStart=${new Date(SOAK_START).toISOString()}&soakEnd=${new Date(SOAK_END).toISOString()}&asOf=${new Date(AS_OF).toISOString()}${extra}`;

const urls: string[] = [];
let tpAtMs = 0;

/** Binance's documented kline rows: flat at the plan entry, one TP touch, for every symbol. */
const fakePublicFetch = async (raw: string) => {
  urls.push(raw);
  const url = new URL(raw);
  const interval = url.searchParams.get("interval") === "15m" ? 15 * MINUTE : MINUTE;
  const start = Number(url.searchParams.get("startTime"));
  const end = Number(url.searchParams.get("endTime"));
  const limit = Number(url.searchParams.get("limit"));
  const rows: unknown[] = [];
  for (let t = start; t <= end && rows.length < limit; t += interval) {
    const high = t === tpAtMs ? "0.8400" : "0.8130";
    rows.push([t, "0.8123", high, "0.8120", "0.8125", "1", t + interval - 1, "1", 1, "1", "1", "0"]);
  }
  return { status: 200, headers: { get: () => null }, json: async () => rows };
};

let app: FastifyInstance;
const seeded: { id: string; symbol: string }[] = [];
const evidence = new Map<string, ReturnType<typeof fixtures.eligibleEvidence>>();

async function seedAlert(options: { symbol: string; signal?: "LONG" | "SHORT"; sourceTf?: "1D" | "1W" | "1M"; createdAt?: Date; triggeredAtShiftMs?: number; plan?: boolean }) {
  const records = fixtures.cleanRecords({ symbol: options.symbol, signal: options.signal, sourceTf: options.sourceTf });
  const alert = fixtures.canaryAlert(records, { symbol: options.symbol, signal: options.signal, sourceTf: options.sourceTf });
  evidence.set(options.symbol, fixtures.eligibleEvidence(records, options.symbol));
  const triggeredAt = alert.triggeredAt as Date;
  const created = await prisma!.alert.create({
    data: {
      symbol: options.symbol,
      assetType: "CRYPTO",
      exchange: "BINANCE",
      timeframe: "15m",
      price: alert.price,
      signal: options.signal ?? "LONG",
      indicatorName: TAG,
      source: "NATIVE",
      sourceTimeframe: alert.sourceTimeframe,
      levelColor: options.signal === "SHORT" ? "RED" : "GREEN",
      touchDirection: options.signal === "SHORT" ? "FROM_BELOW" : "FROM_ABOVE",
      rawPayload: alert.rawPayload as object,
      triggeredAt,
      createdAt: options.createdAt ?? new Date(triggeredAt.getTime() + 2_000),
    },
  });
  if (options.plan !== false) {
    await prisma!.extremeRRPlan.create({
      data: {
        alertId: created.id,
        status: "READY",
        direction: options.signal ?? "LONG",
        entryPrice: fixtures.ENTRY_PRICE,
        cutoffAt: triggeredAt,
        timeframe: "15m",
        marketType: "USDM_PERPETUAL",
        candidates: fixtures.storedCandidates(options.signal ?? "LONG") as object,
        selectedLookback: 100,
        generatedAt: triggeredAt,
      },
    });
  }
  seeded.push({ id: created.id, symbol: options.symbol });
  return { id: created.id, triggeredAt };
}

async function cleanup(): Promise<void> {
  if (!available) return;
  await prisma!.alert.deleteMany({ where: { indicatorName: TAG } });
}

async function databaseDigest(): Promise<Record<string, { rows: number; hash: string | null }>> {
  const tables = await prisma!.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations' ORDER BY tablename`;
  const out: Record<string, { rows: number; hash: string | null }> = {};
  for (const { tablename } of tables) {
    const [row] = await prisma!.$queryRawUnsafe<{ rows: number; hash: string | null }[]>(`SELECT count(*)::int AS rows, md5(string_agg(t::text, '|' ORDER BY t::text)) AS hash FROM "${tablename.replace(/"/g, '""')}" t`);
    out[tablename] = row;
  }
  return out;
}

let longId = "";
let shortId = "";
let preSoakId = "";
let noPlanId = "";

beforeAll(async () => {
  if (!available) return;
  await cleanup();
  const long = await seedAlert({ symbol: "SQLONGUSDT" });
  longId = long.id;
  tpAtMs = Math.ceil(long.triggeredAt.getTime() / MINUTE) * MINUTE + 30 * MINUTE;
  shortId = (await seedAlert({ symbol: "SQSHORTUSDT", signal: "SHORT", sourceTf: "1W" })).id;
  noPlanId = (await seedAlert({ symbol: "SQMONTHUSDT", sourceTf: "1M", plan: false })).id;
  // A signal persisted during the soak but triggered before it (emitter backlog): seeded with a pre-soak trigger.
  const records = fixtures.cleanRecords({ symbol: "SQLATEUSDT" });
  const late = fixtures.canaryAlert(records, { symbol: "SQLATEUSDT" });
  evidence.set("SQLATEUSDT", fixtures.eligibleEvidence(records, "SQLATEUSDT"));
  const shifted = { ...(late.rawPayload as Record<string, unknown>) };
  const created = await prisma!.alert.create({
    data: {
      symbol: "SQLATEUSDT",
      assetType: "CRYPTO",
      exchange: "BINANCE",
      timeframe: "15m",
      price: late.price,
      signal: "LONG",
      indicatorName: TAG,
      source: "NATIVE",
      sourceTimeframe: late.sourceTimeframe,
      levelColor: "GREEN",
      rawPayload: shifted as object,
      triggeredAt: new Date(SOAK_START - 3_600_000),
      createdAt: new Date(SOAK_START + 10 * MINUTE),
    },
  });
  preSoakId = created.id;

  app = Fastify();
  app.decorate("prisma", prisma!);
  await app.register(signalQualityRoutes, {
    deps: {
      marketData: new SignalQualityMarketData({ fetch: fakePublicFetch }),
      integrityEvidence: (provenance) => {
        const e = evidence.get(provenance.symbol);
        if (e === undefined) throw new Error("no evidence");
        return e;
      },
      readScannerStatus: () => null,
      readEmitterStatus: () => null,
    },
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: error.name, message: error.message });
    return reply.code(500).send({ error: "Internal", message: error instanceof Error ? error.message : "failed" });
  });
  await app.ready();
});

afterAll(async () => {
  await cleanup();
  await app?.close();
  await prisma?.$disconnect();
});

describe("the signal-quality API is read-only", () => {
  maybe()("summary, page, detail, chart, export and soak health write nothing anywhere in the database", async () => {
    const before = await databaseDigest();
    for (const path of [
      `/api/signal-quality/summary?${q()}`,
      `/api/signal-quality/signals?${q("&pageSize=25")}`,
      `/api/signal-quality/signals/${longId}?asOf=${new Date(AS_OF).toISOString()}`,
      `/api/signal-quality/signals/${longId}/chart?asOf=${new Date(AS_OF).toISOString()}`,
      `/api/signal-quality/export?${q("&format=csv")}`,
      `/api/signal-quality/export?${q("&format=json")}`,
      "/api/signal-quality/soak-health",
    ]) {
      const response = await app.inject({ method: "GET", url: path });
      expect({ path, status: response.statusCode }).toEqual({ path, status: 200 });
    }
    expect(await databaseDigest()).toEqual(before);
  });

  maybe()("no route accepts POST, PUT, PATCH or DELETE", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      for (const path of ["/api/signal-quality/summary", "/api/signal-quality/signals", `/api/signal-quality/signals/${longId}`, "/api/signal-quality/export", "/api/signal-quality/soak-health"]) {
        const response = await app.inject({ method, url: path, payload: method === "DELETE" ? undefined : {} });
        expect({ method, path, status: response.statusCode }).toEqual({ method, path, status: 404 });
      }
    }
  });

  maybe()("every request to market data is a public Binance klines GET", async () => {
    expect(urls.length).toBeGreaterThan(0);
    for (const raw of urls) {
      const url = new URL(raw);
      expect([url.origin, url.pathname]).toEqual(["https://fapi.binance.com", "/fapi/v1/klines"]);
      expect(raw).not.toMatch(/signature|apiKey|timestamp|recvWindow/i);
    }
  });
});

describe("the signal-quality API answers the observatory's questions", () => {
  maybe()("summary: counts with denominators, censoring, soak scopes and authority NONE", async () => {
    const response = await app.inject({ method: "GET", url: `/api/signal-quality/summary?${q()}` });
    const body = response.json();
    expect(body).toMatchObject({ policy: "NATIVE_SIGNAL_QUALITY_OBSERVATORY_V1", authority: "NONE", nativeExecutionEnabled: false, monitoringOnly: true });
    expect(body.counts.total).toBe(4);
    expect(body.counts.bySoakScope).toEqual({ OBSERVED_DURING_SOAK_TRIGGERED_BEFORE_START: 1, TRIGGERED_DURING_SOAK: 3 });
    expect(body.counts.byTimeframeClass).toEqual({ DASHBOARD_ONLY_TIMEFRAME: 1, EXECUTION_POLICY_TIMEFRAME: 3 });
    expect(body.plans.outcomes.TP_FIRST).toBe(1);
    expect(body.plans.tpBeforeSl.denominator).toBe(body.plans.outcomes.TP_FIRST + body.plans.outcomes.SL_FIRST);
    expect(body.plans.outcomes.PLAN_UNAVAILABLE).toBe(2); // the 1M alert has no plan; the late one has none either
    expect(body.sample).toMatchObject({ evaluated: 4, truncated: false, integrityJudged: 4 });
    expect(JSON.stringify(body)).not.toMatch(/NaN|Infinity/);
  });

  maybe()("the soak scope separates a pre-soak signal observed during the soak from real-time soak alerts", async () => {
    const realtime = (await app.inject({ method: "GET", url: `/api/signal-quality/summary?${q("&scope=TRIGGERED_DURING_SOAK")}` })).json();
    expect(realtime.counts.total).toBe(3);
    const late = (await app.inject({ method: "GET", url: `/api/signal-quality/signals?${q("&scope=OBSERVED_DURING_SOAK_TRIGGERED_BEFORE_START")}` })).json();
    expect(late.items.map((i: { alertId: string }) => i.alertId)).toEqual([preSoakId]);
    expect(late.items[0].flags.map((f: { code: string }) => f.code)).toEqual(expect.arrayContaining(["TRIGGERED_BEFORE_SOAK", "DELAYED_DELIVERY"]));
  });

  maybe()("page: bounded, sorted, filtered; the LONG alert resolved TP_FIRST at the plan's own 3R with matured horizons", async () => {
    const body = (await app.inject({ method: "GET", url: `/api/signal-quality/signals?${q("&direction=LONG&planOutcome=TP_FIRST")}` })).json();
    expect(body.pagination).toMatchObject({ offset: 0, total: 1, hasMore: false, sort: "TRIGGERED_DESC" });
    const item = body.items[0];
    expect(item).toMatchObject({ alertId: longId, direction: "LONG", timeframeClass: "EXECUTION_POLICY_TIMEFRAME", integrity: { judged: true, status: "ELIGIBLE" }, freshness: { state: "FRESH_AT_DELIVERY" } });
    expect(item.plan).toMatchObject({ outcome: "TP_FIRST", provenance: "EXISTING_SELECTED_PLAN", selectedLookback: 100 });
    expect(item.plan.rMultiple).toBeCloseTo(3, 9);
    expect(item.horizons.map((h: { state: string }) => h.state)).toEqual(["MATURED", "MATURED", "MATURED", "MATURED", "MATURED"]);
    const paged = (await app.inject({ method: "GET", url: `/api/signal-quality/signals?${q("&pageSize=1&offset=1&sort=SYMBOL_ASC")}` })).json();
    expect(paged.items).toHaveLength(1);
    expect(paged.pagination).toMatchObject({ offset: 1, pageSize: 1, total: 4, hasMore: true });
  });

  maybe()("detail carries the full canonical evidence and the M5 freshness window; chart never shows a bar past asOf", async () => {
    const detail = (await app.inject({ method: "GET", url: `/api/signal-quality/signals/${shortId}?asOf=${new Date(AS_OF).toISOString()}` })).json();
    expect(detail).toMatchObject({ authority: "NONE", row: { alertId: shortId, direction: "SHORT" } });
    expect(detail.evidence.delivery.barStart).toBe(new Date(fixtures.SOURCE_BAR).toISOString());
    expect(detail.freshnessWindow.expiresAt).toBe(new Date(fixtures.SOURCE_BAR_CLOSE + 5 * MINUTE).toISOString());
    const early = new Date(fixtures.SOURCE_BAR + 3 * 3_600_000).toISOString();
    const chart = (await app.inject({ method: "GET", url: `/api/signal-quality/signals/${longId}/chart?asOf=${early}` })).json();
    expect(chart).toMatchObject({ interval: "15m", authority: "NONE" });
    expect(chart.bars.length).toBeGreaterThan(0);
    for (const bar of chart.bars) expect(bar.time * 1000 + 15 * MINUTE).toBeLessThanOrEqual(Date.parse(early));
    expect(chart.horizonMarks.map((m: { key: string }) => m.key)).toEqual(["15m", "1h"]);
  });

  maybe()("an earlier asOf shows only what was knowable then: horizons still PENDING/PARTIAL, the plan PENDING", async () => {
    const asOf = new Date(fixtures.SOURCE_BAR + 20 * MINUTE).toISOString();
    const body = (await app.inject({ method: "GET", url: `/api/signal-quality/signals/${longId}?asOf=${asOf}` })).json();
    // Trigger at bar + 61 s, so the outcome starts at bar + 2 min: 18 minutes have closed by bar + 20 min.
    expect(body.row.horizons.map((h: { state: string }) => h.state)).toEqual(["MATURED", "PARTIAL", "PARTIAL", "PARTIAL", "PARTIAL"]);
    expect(body.row.plan.outcome).toBe("PENDING");
  });

  maybe()("export: CSV and JSON of the filtered rows, as attachments, with no credential", async () => {
    const csv = await app.inject({ method: "GET", url: `/api/signal-quality/export?${q("&format=csv&sourceTimeframe=1W")}` });
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.headers["content-disposition"]).toMatch(/attachment; filename="native-signal-quality-/);
    expect(csv.body.trim().split("\r\n")).toHaveLength(2);
    const json = (await app.inject({ method: "GET", url: `/api/signal-quality/export?${q("&format=json")}` })).json();
    expect(json).toMatchObject({ authority: "NONE", nativeExecutionEnabled: false });
    expect(json.rows).toHaveLength(4);
  });

  maybe()("refuses (422) unknown keys, bad values, a future asOf, a half soak window and an over-long one", async () => {
    const now = Date.now();
    for (const path of [
      "/api/signal-quality/summary?rogue=1",
      "/api/signal-quality/summary?direction=UP",
      `/api/signal-quality/summary?asOf=${new Date(now + 3_600_000).toISOString()}`,
      `/api/signal-quality/summary?soakStart=${new Date(SOAK_START).toISOString()}`,
      `/api/signal-quality/summary?soakStart=${new Date(SOAK_START).toISOString()}&soakEnd=${new Date(SOAK_START + 73 * 3_600_000).toISOString()}`,
      "/api/signal-quality/summary?scope=TRIGGERED_DURING_SOAK",
      "/api/signal-quality/signals?pageSize=1000",
      "/api/signal-quality/export?format=xlsx",
      "/api/signal-quality/signals/not%20an%20id",
      `/api/signal-quality/signals/${longId}?soakStart=x`,
    ]) {
      const response = await app.inject({ method: "GET", url: path });
      expect({ path, status: response.statusCode }).toEqual({ path, status: 422 });
    }
    expect((await app.inject({ method: "GET", url: "/api/signal-quality/signals/cldoesnotexist000000000000" })).statusCode).toBe(404);
  });

  maybe()("soak health degrades to UNKNOWN without status files and still counts alerts and plans", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/signal-quality/soak-health" })).json();
    expect(body).toMatchObject({ authority: "NONE", scanner: { state: "UNKNOWN" }, emitter: { state: "UNKNOWN" } });
    expect(body.plans.READY).toBeGreaterThanOrEqual(2);
    expect(noPlanId).not.toBe("");
  });
});
