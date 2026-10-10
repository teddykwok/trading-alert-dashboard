import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import {
  NATIVE_PLAN_EXECUTION_STATUS,
  NATIVE_PLAN_INTEGRITY_SCAN_LIMIT,
  NATIVE_PLAN_PAGE_MAX_SIZE,
  type NativePlanListDto,
  type NativePlanPageDto,
} from "@trading-alert-dashboard/shared";

import { connectTestDatabase } from "./helpers/test-database";
import { buildNativeAlertDraftV2 } from "../src/modules/native-alerts/native-alert-draft";
import { selectNativeDeliveriesV2 } from "../src/modules/native-alerts/native-delivery-policy-v2";
import { fileSystemNativeScannerEvidence, type NativeExecutionProvenance, type NativeScannerEvidence } from "../src/modules/native-integrity/native-execution-integrity";
import { parseShadowEventLog } from "../src/modules/native-alerts/shadow-log-reader";
import { LIVE_CHECKPOINT_SCHEMA, LiveCheckpointStore } from "../src/modules/native-scanner/live-shadow-checkpoint";
import type { ShadowClassification, ShadowRecord } from "../src/modules/native-scanner/live-shadow-store";
import { TEDDY_7_ALL_ACTIVE_V1, engineFingerprintOf, liveShadowEngineDir, profileSummaryOf } from "../src/modules/native-scanner/scanner-profile";
import { makeRunId } from "../src/modules/native-scanner/supervisor-run-manifest";
import { M15, bar, commit, logOf, observation } from "./helpers/native-alert-fixtures";

/**
 * UI SCALABILITY V1: the PAGED read of Native plans behind Trading Control.
 *
 * 525 synthetic Native plans (the size of the live universe) plus one
 * TradingView plan, in the TEST database only. Proves: the original call is
 * unchanged; keyset pages are stable and deterministic; search and every filter
 * run in the database; counts match their scope; bounds and fail-closed query
 * validation; integrity filtering is bounded and resumable; and nothing is
 * written, queued or fetched — no Binance, no candle request, no plan job.
 */

const queue = vi.hoisted(() => ({ enqueueVisionAnalysis: vi.fn(async () => undefined), enqueueExtremeRRPlan: vi.fn(async () => undefined) }));
vi.mock("../src/modules/jobs/queue", () => queue);
const marketData = vi.hoisted(() => ({ getClosedCandlesBefore: vi.fn(async () => { throw new Error("a read-only page must never fetch candles"); }) }));
vi.mock("../src/modules/market-data/market-data.service", () => marketData);

const TAG = "native-plan-page-it";
const PREFIX = "NPGT";
const N = 525;
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0, 0);
const TIED = [100, 101, 102];
const TFS = ["1D", "1W", "1M", "3M"] as const;

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient = testDatabase;
const maybe = () => (available ? it : it.skip);

const { ExtremeRRService, decodeNativePlanCursor, encodeNativePlanCursor, readEachLaneOnce } = await import("../src/modules/extreme-rr/extreme-rr.service");
const { resolveNativeAccountPlanPolicies } = await import("../src/modules/native-planning/native-account-plan-policy");
const { extremeRRRoutes } = await import("../src/routes/extreme-rr.routes");
const { AppError } = await import("../src/utils/errors");

type Status = "PENDING" | "READY" | "INVALID" | "ERROR";
interface Row {
  id: string;
  symbol: string;
  triggeredAt: Date;
  sourceTimeframe: (typeof TFS)[number];
  direction: "LONG" | "SHORT";
  status: Status;
}

const idOf = (i: number) => `npgt${String(i).padStart(4, "0")}z`;
const statusOf = (i: number): Status => (i % 50 === 9 ? "ERROR" : i % 50 === 19 ? "INVALID" : i % 10 === 4 ? "PENDING" : "READY");
const ROWS: Row[] = Array.from({ length: N }, (_, i) => ({
  id: idOf(i),
  // One Unicode symbol: its exact identity must survive search and display.
  symbol: i === 7 ? `币安人生${PREFIX}USDT` : `${PREFIX}${String(i).padStart(4, "0")}USDT`,
  triggeredAt: new Date(T0 - (TIED.includes(i) ? TIED[0] : i) * 60_000),
  sourceTimeframe: TFS[i % TFS.length],
  direction: i % 3 === 0 ? "SHORT" : "LONG",
  status: statusOf(i),
}));
const TV_ID = "npgttradingview0001z";

const candidate = (lookback: 50 | 100 | 200 | 300) => ({
  requestedCandles: lookback, actualCandles: lookback, complete: true, extremePrice: "1.5", oldestCandleOpenTime: null, newestCandleCloseTime: null, valid: true,
  invalidReason: null, extremeType: "HIGHEST_HIGH", takeProfit: "1.5", stopLoss: "1.1", rewardDistance: "0.2655", riskDistance: "0.1345", riskRewardRatio: "1.97",
});
const CANDIDATES = [candidate(50), candidate(100), candidate(200), candidate(300)];

function planData(alertId: string, row: Pick<Row, "direction" | "status" | "triggeredAt">) {
  return {
    alertId, status: row.status, direction: row.direction, entryPrice: "1.2345", cutoffAt: row.triggeredAt, timeframe: "15m", marketType: "USDM_PERPETUAL",
    candidates: row.status === "READY" ? CANDIDATES : row.status === "INVALID" ? CANDIDATES.map((c) => ({ ...c, valid: false, invalidReason: "fixture", stopLoss: null, takeProfit: null })) : undefined,
    selectedLookback: 100, errorReason: row.status === "ERROR" ? "fixture error" : null,
  } as const;
}

async function cleanup() {
  if (!available) return;
  await prisma.alert.deleteMany({ where: { OR: [{ indicatorName: TAG }, { symbol: { contains: PREFIX } }, { symbol: { startsWith: "NPGI" } }] } });
}

async function seed() {
  await prisma.alert.createMany({
    data: ROWS.map((row, i) => ({
      id: row.id, symbol: row.symbol, assetType: "CRYPTO" as const, exchange: "BINANCE", timeframe: "15m", price: 1.2345, signal: row.direction,
      indicatorName: TAG, source: "NATIVE" as const, sourceTimeframe: row.sourceTimeframe, triggeredAt: row.triggeredAt, rawPayload: { note: TAG, fixture: i },
    })),
  });
  await prisma.extremeRRPlan.createMany({ data: ROWS.map((row) => planData(row.id, row)) as never });
  // A TradingView plan whose symbol matches the search: it must never appear in a Native page.
  await prisma.alert.create({ data: { id: TV_ID, symbol: `${PREFIX}TVUSDT`, assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 1, signal: "LONG", indicatorName: TAG, sourceTimeframe: "1D", triggeredAt: new Date(T0 + 60_000), rawPayload: { note: TAG } } });
  await prisma.extremeRRPlan.create({ data: planData(TV_ID, { direction: "LONG", status: "READY", triggeredAt: new Date(T0) }) as never });
}

// Every Prisma operation the code under test performs, model and raw alike.
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

const policies = resolveNativeAccountPlanPolicies({});
const service = () => new ExtremeRRService(observed);
const tempRoots: string[] = [];
let app: FastifyInstance;
let savedLocalAppData: string | undefined;
const fetchSpy = vi.spyOn(globalThis, "fetch");

beforeAll(async () => {
  if (!available) return;
  await cleanup();
  await seed();
  // The route builds its integrity reader from process.env: point it at an EMPTY temp tree, never the real scanner.
  savedLocalAppData = process.env.LOCALAPPDATA;
  const local = mkdtempSync(path.join(tmpdir(), "native-plan-page-it-"));
  tempRoots.push(local);
  process.env.LOCALAPPDATA = local;
  app = Fastify();
  app.decorate("prisma", observed);
  await app.register(extremeRRRoutes);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: error.name, message: error.message });
    return reply.code(500).send({ error: "Internal", message: String(error) });
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = savedLocalAppData;
  tempRoots.forEach((root) => rmSync(root, { recursive: true, force: true }));
  if (available) {
    await app?.close();
    await cleanup();
    await prisma.$disconnect();
  }
});

const get = async <T>(url: string): Promise<{ status: number; body: T }> => {
  const response = await app.inject({ method: "GET", url });
  return { status: response.statusCode, body: response.json() as T };
};
const page = (query: string) => get<NativePlanPageDto>(`/api/extreme-rr/native-plans?${query}`);

/** The expected order, built independently: JS sort by trigger time, ties by the database's own alertId order. */
async function expectedOrder(rows: readonly Row[]): Promise<string[]> {
  const dbIdOrder = (await prisma.alert.findMany({ where: { id: { in: rows.map((r) => r.id) } }, orderBy: { id: "desc" }, select: { id: true } })).map((r) => r.id);
  const rank = new Map(dbIdOrder.map((id, index) => [id, index]));
  return [...rows].sort((a, b) => b.triggeredAt.getTime() - a.triggeredAt.getTime() || (rank.get(a.id) as number) - (rank.get(b.id) as number)).map((r) => r.id);
}

/** Every page of a query, following nextCursor; also asserts each page's own invariants. */
async function walk(query: string, pageSize: number): Promise<{ ids: string[]; pages: NativePlanPageDto[] }> {
  const ids: string[] = [];
  const pages: NativePlanPageDto[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 200; guard += 1) {
    const response: { status: number; body: NativePlanPageDto } = await page(`${query}&pageSize=${pageSize}${cursor ? `&cursor=${cursor}` : ""}`);
    expect(response.status).toBe(200);
    const body = response.body;
    expect(body.items.length).toBeLessThanOrEqual(pageSize);
    expect(body.pagination.hasMore).toBe(body.pagination.nextCursor !== null);
    pages.push(body);
    ids.push(...body.items.map((item) => item.alertId));
    if (body.pagination.nextCursor === null) return { ids, pages };
    cursor = body.pagination.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

describe("UI scalability: the original Native plan list is unchanged", () => {
  maybe()("no query: exactly the original shape and items (20 most recently updated), no page fields", async () => {
    const { status, body } = await get<NativePlanListDto & Record<string, unknown>>("/api/extreme-rr/native-plans");
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["accountPolicies", "items", "nativeExecutionEnabled"]);
    expect(body.nativeExecutionEnabled).toBe(false);
    expect(body.items.length).toBeLessThanOrEqual(20);
    const direct = await new ExtremeRRService(prisma).listNativePlans(20, undefined, fileSystemNativeScannerEvidence(process.env));
    expect(body).toEqual(JSON.parse(JSON.stringify(direct)));
  });

  maybe()("?limit=5 still works the original way; limit stays bounded at 50", async () => {
    const five = await get<NativePlanListDto & Record<string, unknown>>("/api/extreme-rr/native-plans?limit=5");
    expect(five.status).toBe(200);
    expect(five.body.items).toHaveLength(5);
    expect("pagination" in five.body).toBe(false);
    expect((await get("/api/extreme-rr/native-plans?limit=51")).status).toBe(422);
    expect((await get("/api/extreme-rr/native-plans?limit=abc")).status).toBe(422);
  });
});

describe("UI scalability: Native plan pages", () => {
  maybe()("the first page: newest trigger first, page fields, counts, A 100 / B 300 planning defaults, PLANNING ONLY", async () => {
    const { status, body } = await page(`q=${PREFIX}&pageSize=50`);
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["accountPolicies", "items", "nativeExecutionEnabled", "pagination", "summary"]);
    expect(body.nativeExecutionEnabled).toBe(false);
    expect(body.items).toHaveLength(50);
    expect(body.items.map((item) => item.alertId)).toEqual((await expectedOrder(ROWS)).slice(0, 50));
    expect(body.items.every((item) => item.plan.execution === NATIVE_PLAN_EXECUTION_STATUS)).toBe(true);
    expect(body.accountPolicies).toEqual([
      { account: "A", state: "RESOLVED", lookback: 100, source: "BUILTIN_DEFAULT", reason: null },
      { account: "B", state: "RESOLVED", lookback: 300, source: "BUILTIN_DEFAULT", reason: null },
    ]);
    expect(body.pagination).toMatchObject({ order: "TRIGGERED_AT_DESC", pageSize: 50, cursor: null, hasMore: true, totalMatching: N, integrityScan: null });
    expect(body.summary.matchingFilters.total).toBe(N);
    expect(body.summary.allNativePlans.total).toBeGreaterThanOrEqual(N);
    // Integrity without provenance is UNREADABLE: never eligible.
    expect(new Set(body.items.map((item) => item.executionIntegrity.status))).toEqual(new Set(["UNREADABLE"]));
  });

  maybe()("525 plans walk in 50s and in 200s: every plan exactly once, in the deterministic order, TradingView never", async () => {
    const expected = await expectedOrder(ROWS);
    for (const size of [50, NATIVE_PLAN_PAGE_MAX_SIZE]) {
      const { ids, pages } = await walk(`q=${PREFIX}`, size);
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(N);
      expect(ids).not.toContain(TV_ID);
      expect(pages).toHaveLength(Math.ceil(N / size));
      expect(pages.every((p) => p.pagination.totalMatching === N)).toBe(true);
    }
  }, 120_000);

  maybe()("ties on triggeredAt break by alertId, and a page boundary inside the tie skips and repeats nothing", async () => {
    const expected = await expectedOrder(ROWS);
    const tieStart = expected.findIndex((id) => TIED.map(idOf).includes(id));
    expect(expected.slice(tieStart, tieStart + 3).sort()).toEqual(TIED.map(idOf).sort());
    // A page size that ends the first page in the middle of the three tied plans.
    const { ids } = await walk(`q=${PREFIX}`, tieStart + 2);
    expect(ids).toEqual(expected);
  }, 120_000);

  maybe()("keyset pages do not shift when a newer plan arrives between page requests", async () => {
    const first = (await page(`q=${PREFIX}&pageSize=40`)).body;
    const before = (await page(`q=${PREFIX}&pageSize=40&cursor=${first.pagination.nextCursor}`)).body.items.map((i) => i.alertId);
    const id = "npgtlatearrival0001z";
    await prisma.alert.create({ data: { id, symbol: `${PREFIX}LATEUSDT`, assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 1, signal: "LONG", indicatorName: TAG, source: "NATIVE", sourceTimeframe: "1D", triggeredAt: new Date(T0 + 3_600_000), rawPayload: { note: TAG } } });
    await prisma.extremeRRPlan.create({ data: planData(id, { direction: "LONG", status: "READY", triggeredAt: new Date(T0 + 3_600_000) }) as never });
    try {
      const after = (await page(`q=${PREFIX}&pageSize=40&cursor=${first.pagination.nextCursor}`)).body.items.map((i) => i.alertId);
      expect(after).toEqual(before);
      expect((await page(`q=${PREFIX}&pageSize=40`)).body.items[0].alertId).toBe(id);
    } finally {
      await prisma.alert.delete({ where: { id } });
    }
  });

  maybe()("search: symbol fragment (case-insensitive), a Unicode symbol, an exact alert id", async () => {
    const lower = (await page(`q=${PREFIX.toLowerCase()}&pageSize=10`)).body;
    expect(lower.pagination.totalMatching).toBe(N);
    const unicode = (await page(`q=${encodeURIComponent("币安人生")}&pageSize=10`)).body;
    expect(unicode.items.map((i) => [i.alertId, i.symbol])).toEqual([[idOf(7), `币安人生${PREFIX}USDT`]]);
    const exact = (await page(`q=${idOf(321)}&pageSize=10`)).body;
    expect(exact.items.map((i) => i.alertId)).toEqual([idOf(321)]);
    expect(exact.pagination.totalMatching).toBe(1);
  });

  maybe()("every filter alone and combined runs in the database, and the counts describe exactly that scope", async () => {
    const cases: Array<[string, (row: Row) => boolean]> = [
      ["sourceTimeframe=1W", (r) => r.sourceTimeframe === "1W"],
      ["direction=SHORT", (r) => r.direction === "SHORT"],
      ["planStatus=PENDING", (r) => r.status === "PENDING"],
      ["planStatus=ERROR", (r) => r.status === "ERROR"],
      ["sourceTimeframe=1M&direction=LONG&planStatus=READY", (r) => r.sourceTimeframe === "1M" && r.direction === "LONG" && r.status === "READY"],
      ["sourceTimeframe=12M", () => false],
    ];
    for (const [filters, keep] of cases) {
      const rows = ROWS.filter(keep);
      const { ids, pages } = await walk(`q=${PREFIX}&${filters}`, 100);
      expect(ids, filters).toEqual(await expectedOrder(rows));
      const summary = pages[0].summary.matchingFilters;
      expect(summary.total, filters).toBe(rows.length);
      expect(pages[0].pagination.totalMatching, filters).toBe(rows.length);
      for (const status of ["PENDING", "READY", "INVALID", "ERROR"] as const) {
        expect(summary.byPlanStatus[status], `${filters} ${status}`).toBe(rows.filter((r) => r.status === status).length);
      }
      expect(Object.values(summary.byPlanStatus).reduce((a, b) => a + b, 0)).toBe(summary.total);
    }
  }, 120_000);

  maybe()("bounds: pageSize 1..200; 0, 201 and non-integers are refused", async () => {
    expect((await page(`q=${PREFIX}&pageSize=${NATIVE_PLAN_PAGE_MAX_SIZE}`)).body.items).toHaveLength(NATIVE_PLAN_PAGE_MAX_SIZE);
    expect((await page(`q=${PREFIX}&pageSize=1`)).body.items).toHaveLength(1);
    for (const bad of ["0", "201", "5000", "-1", "1.5", "abc", ""]) expect((await page(`q=${PREFIX}&pageSize=${bad}`)).status, bad).toBe(422);
    // A page query without pageSize defaults to 50.
    expect((await page(`q=${PREFIX}`)).body.pagination.pageSize).toBe(50);
  });

  maybe()("invalid queries fail closed (422), never as an unfiltered page", async () => {
    const valid = encodeNativePlanCursor({ triggeredAt: new Date(T0), alertId: idOf(1) });
    const tampered = Buffer.from(JSON.stringify({ v: 1, t: new Date(T0).toISOString(), a: idOf(1), extra: true })).toString("base64url");
    const reordered = Buffer.from(JSON.stringify({ a: idOf(1), v: 1, t: new Date(T0).toISOString() })).toString("base64url");
    for (const bad of [
      "foo=1",
      "pageSize=10&planstatus=READY",
      "pageSize=10&direction=UP",
      "pageSize=10&sourceTimeframe=2D",
      "pageSize=10&planStatus=ready",
      "pageSize=10&integrity=BAD",
      "pageSize=10&q=BTC%25",
      "pageSize=10&q=BTC_USDT",
      "pageSize=10&q=BTC%20USDT",
      `pageSize=10&q=${"A".repeat(41)}`,
      "pageSize=10&q=A&q=B",
      "pageSize=10&limit=10",
      "pageSize=10&cursor=not-a-cursor",
      `pageSize=10&cursor=${tampered}`,
      `pageSize=10&cursor=${reordered}`,
      `pageSize=10&cursor=${valid}&cursor=${valid}`,
    ]) {
      const response = await app.inject({ method: "GET", url: `/api/extreme-rr/native-plans?${bad}` });
      expect(response.statusCode, bad).toBe(422);
    }
    expect((await page(`pageSize=10&cursor=${valid}`)).status).toBe(200);
  });

  it("the cursor codec round-trips and refuses anything it did not issue", () => {
    const position = { triggeredAt: new Date(T0 + 123), alertId: "cm1abcdefghijklmnopqrstu" };
    expect(decodeNativePlanCursor(encodeNativePlanCursor(position))).toEqual(position);
    for (const bad of ["", "%%%", Buffer.from("[]").toString("base64url"), Buffer.from(JSON.stringify({ v: 2, t: "x", a: "y" })).toString("base64url")]) {
      expect(() => decodeNativePlanCursor(bad), bad).toThrow(/cursor/);
    }
  });
});

describe("UI scalability: integrity filtering is evaluated per page, bounded and resumable", () => {
  const PROFILE = TEDDY_7_ALL_ACTIVE_V1;
  const FINGERPRINT = engineFingerprintOf(PROFILE);
  const LINEAGE = "d".repeat(64);
  let local = "";
  let seq = 0;

  /** A real V2 Native alert on bar(1) with a READY plan, and its lane in the temp scanner tree. */
  async function scenario(finalClass: ShadowClassification | "OPEN", minutesAgo: number) {
    const symbol = `NPGI${++seq}USDT`;
    const obs = observation({ symbol, lineageId: LINEAGE, sourceTf: "1W", barMs: bar(1) });
    const records: ShadowRecord[] = [commit(bar(0), "QUARANTINED_CURRENT_BAR", LINEAGE, symbol), obs, ...(finalClass === "OPEN" ? [] : [commit(bar(1), finalClass, LINEAGE, symbol)])];
    const parsed = parseShadowEventLog(logOf(records), { lineageId: LINEAGE, marketType: "USDM_PERPETUAL", symbol, chartInterval: "15m" });
    const decision = selectNativeDeliveriesV2(parsed, PROFILE.delivery).flatMap((s) => (s.kind === "DELIVER" ? [s.decision] : []))[0];
    const draft = buildNativeAlertDraftV2(decision, { profile: profileSummaryOf(PROFILE), runId: makeRunId(Date.UTC(2026, 9, 1, 11, 0), "1a2b3c4d") });
    const triggeredAt = new Date(T0 - minutesAgo * 60_000);
    const alert = await prisma.alert.create({
      data: {
        symbol: draft.symbol, assetType: draft.assetType, exchange: draft.exchange, timeframe: draft.timeframe, price: draft.price, signal: draft.signal,
        indicatorName: TAG, source: draft.source, sourceTimeframe: draft.sourceTimeframe, eventType: draft.eventType, levelColor: draft.levelColor,
        touchDirection: draft.touchDirection, triggeredAt, rawPayload: draft.rawPayload as never,
      },
    });
    await prisma.extremeRRPlan.create({ data: planData(alert.id, { direction: draft.signal as "LONG" | "SHORT", status: "READY", triggeredAt }) as never });
    const dir = liveShadowEngineDir(path.join(local, "trading-alert-dashboard", "scanner"), FINGERPRINT, "USDM_PERPETUAL", symbol, "15m");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "events.jsonl"), logOf(records));
    const hwm = finalClass === "OPEN" ? bar(1) : bar(2);
    new LiveCheckpointStore(dir).save(
      {
        schema: LIVE_CHECKPOINT_SCHEMA, lineageId: LINEAGE, marketType: "USDM_PERPETUAL", symbol, chartInterval: "15m", compatibilitySwitchoverMs: bar(-100),
        stateSha256AtSwitchover: "e".repeat(64), hwmOpenTimeMs: hwm, lastCommittedBarOpenTimeMs: hwm - M15, causalBarCount: (hwm + 100 * M15 - bar(0)) / M15,
        causalInputSha256ThroughHwm: "b".repeat(64), stateSha256: "a".repeat(64),
      },
      "2026-10-01T12:31:00.000Z"
    );
    return alert.id;
  }

  maybe()("ELIGIBLE, PENDING BAR CLOSE and a fail-closed verdict filter apart; counts stay database-only and say so", async () => {
    local = mkdtempSync(path.join(tmpdir(), "native-plan-page-integrity-"));
    tempRoots.push(local);
    const eligible = await scenario("SHADOW_LIVE_ONLY", 1);
    const pending = await scenario("OPEN", 2);
    const blocked = await scenario("QUARANTINED_CURRENT_BAR", 3);
    const reader = fileSystemNativeScannerEvidence({ LOCALAPPDATA: local });
    const run = (integrity: "ELIGIBLE" | "PENDING_BAR_CLOSE" | "FAIL_CLOSED" | "INELIGIBLE_REQUARANTINED") =>
      service().listNativePlanPage({ q: "NPGI", integrity, pageSize: 50 }, policies, reader);

    const all = await service().listNativePlanPage({ q: "NPGI", pageSize: 50 }, policies, reader);
    expect(all.items.map((i) => [i.alertId, i.executionIntegrity.status])).toEqual([
      [eligible, "ELIGIBLE"],
      [pending, "PENDING_BAR_CLOSE"],
      [blocked, "INELIGIBLE_REQUARANTINED"],
    ]);
    expect((await run("ELIGIBLE")).items.map((i) => i.alertId)).toEqual([eligible]);
    expect((await run("PENDING_BAR_CLOSE")).items.map((i) => i.alertId)).toEqual([pending]);
    expect((await run("FAIL_CLOSED")).items.map((i) => i.alertId)).toEqual([blocked]);
    const exact = await run("INELIGIBLE_REQUARANTINED");
    expect(exact.items.map((i) => i.alertId)).toEqual([blocked]);
    expect(exact.pagination).toMatchObject({ totalMatching: null, hasMore: false, nextCursor: null, integrityScan: { scanned: 3, limit: NATIVE_PLAN_INTEGRITY_SCAN_LIMIT, exhausted: true } });
    // The counts never pretend to include the integrity filter.
    expect(exact.summary.matchingFilters.total).toBe(3);
  });

  maybe()("a filter nothing matches scans at most the limit per request, then resumes from where it stopped", async () => {
    // The 525 fixture plans carry no provenance: all UNREADABLE, none ELIGIBLE. 200 + 200 + 125 judged, never more per request.
    expect(NATIVE_PLAN_INTEGRITY_SCAN_LIMIT).toBe(NATIVE_PLAN_PAGE_MAX_SIZE);
    const scans: Array<{ scanned: number; limit: number; exhausted: boolean } | null> = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const result = await service().listNativePlanPage({ q: PREFIX, integrity: "ELIGIBLE", pageSize: 50, cursor }, policies, null);
      expect(result.items).toEqual([]);
      scans.push(result.pagination.integrityScan);
      expect(result.pagination.hasMore).toBe(result.pagination.nextCursor !== null);
      if (result.pagination.nextCursor === null) break;
      cursor = result.pagination.nextCursor;
    }
    const L = NATIVE_PLAN_INTEGRITY_SCAN_LIMIT;
    expect(scans).toEqual([
      { scanned: L, limit: L, exhausted: false },
      { scanned: L, limit: L, exhausted: false },
      { scanned: N - 2 * L, limit: L, exhausted: true },
    ]);
    // The fail-closed filter matches every one of them, a full page at a time.
    const failClosed = await walk(`q=${PREFIX}&integrity=FAIL_CLOSED`, 200);
    expect(failClosed.ids).toEqual(await expectedOrder(ROWS));
  }, 120_000);

  it("each lane's scanner evidence is read once per request; other lanes and profiles are read separately", () => {
    const calls: string[] = [];
    const evidence = { currentEngineFingerprint: null, eventLogText: null, checkpoint: null } satisfies NativeScannerEvidence;
    const once = readEachLaneOnce((p) => {
      calls.push(`${p.profileId}/${p.symbol}`);
      return evidence;
    });
    const lane = (symbol: string, barOpenTimeMs: number, profileId = "teddy-7-all-active") =>
      ({ lineageId: LINEAGE, shadowEventId: "f".repeat(64), marketType: "USDM_PERPETUAL", symbol, chartInterval: "15m", barOpenTimeMs, levelKey: "k", profileId, engineFingerprint: FINGERPRINT }) as NativeExecutionProvenance;
    expect(once(lane("AUSDT", bar(1)))).toBe(evidence);
    expect(once(lane("AUSDT", bar(2)))).toBe(evidence);
    once(lane("BUSDT", bar(1)));
    once(lane("AUSDT", bar(1), "teddy-aggressive"));
    expect(calls).toEqual(["teddy-7-all-active/AUSDT", "teddy-7-all-active/BUSDT", "teddy-aggressive/AUSDT"]);
  });
});

describe("UI scalability: a page read writes nothing and reaches no exchange", () => {
  async function snapshot() {
    const [alerts, plans, deliveries, outcomes, adoptions, executions, orders, admissions] = await Promise.all([
      prisma.alert.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
      prisma.extremeRRPlan.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
      prisma.nativeAlertDelivery.count(),
      prisma.selectedPlanOutcome.count(),
      prisma.selectedPlanAdoption.count(),
      prisma.tradeExecution.count(),
      prisma.binanceOrder.count(),
      prisma.safetyAdmission.count(),
    ]);
    return JSON.stringify({ alerts, plans, deliveries, outcomes, adoptions, executions, orders, admissions });
  }

  maybe()("only reads: every Prisma operation is a read; every table is unchanged; no fetch, no candles, no queue", async () => {
    const before = await snapshot();
    operations.length = 0;
    fetchSpy.mockClear();
    for (const query of [
      `q=${PREFIX}&pageSize=200`,
      `q=${PREFIX}&sourceTimeframe=1D&direction=LONG&planStatus=READY&pageSize=50`,
      `q=${PREFIX}&integrity=FAIL_CLOSED&pageSize=100`,
      `q=${PREFIX}&integrity=ELIGIBLE&pageSize=50`,
      "pageSize=50",
    ]) {
      expect((await page(query)).status, query).toBe(200);
    }
    expect((await get("/api/extreme-rr/native-plans")).status).toBe(200);
    expect(operations.length).toBeGreaterThan(0);
    const verbs = new Set(operations.map((op) => op.split(".")[1]));
    for (const verb of verbs) expect(["findMany", "findFirst", "findUnique", "groupBy", "count"], verb).toContain(verb);
    expect(operations.some((op) => op.startsWith("$raw"))).toBe(false);
    expect(await snapshot()).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(marketData.getClosedCandlesBefore).not.toHaveBeenCalled();
    expect(queue.enqueueExtremeRRPlan).not.toHaveBeenCalled();
    expect(queue.enqueueVisionAnalysis).not.toHaveBeenCalled();
  });

  it("the route and the page code import no Binance client, kline fetcher, queue or execution module", () => {
    const root = path.resolve(__dirname, "..", "src");
    const imports = (rel: string) => [...readFileSync(path.join(root, rel), "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const rel of ["routes/extreme-rr.routes.ts", "modules/extreme-rr/extreme-rr.schema.ts"]) {
      for (const entry of imports(rel)) expect(entry, `${rel} imports ${entry}`).not.toMatch(/binance|kline|jobs\/|\/execution\/|operator|account-control|socket/i);
    }
    const service = readFileSync(path.join(root, "modules/extreme-rr/extreme-rr.service.ts"), "utf8");
    const pageCode = service.slice(service.indexOf("async listNativePlanPage("), service.indexOf("/** One list item, identical for the original list and for a page. */"));
    expect(pageCode.length).toBeGreaterThan(1000);
    expect(pageCode).not.toMatch(/fetchCandles|getClosedCandlesBefore|fetch\(|\.create\(|\.update\(|\.upsert\(|\.delete\(|createMany|updateMany|deleteMany|\$executeRaw|\$transaction|enqueue/);
    expect(pageCode).toContain("nativeExecutionEnabled: false");
  });
});
