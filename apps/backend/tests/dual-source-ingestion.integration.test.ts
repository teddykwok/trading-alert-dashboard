import { readFileSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectTestDatabase } from "./helpers/test-database";
import { BAR0, M15, bar, commit, logOf, observation } from "./helpers/native-alert-fixtures";

/**
 * TradingView and Native coexist as two DISTINCT sources, against the TEST
 * database only. Each has its own ingestion path, its own dedupe identity and
 * its own source column value; the API and socket serializers preserve the
 * source; the read-only Signal Sources status derives nothing it cannot prove.
 * No Binance client, no account, no execution.
 */

const TAG = "dual-source-it";
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient = testDatabase;
const maybe = () => (available ? it : it.skip);

const { handleTradingViewWebhook } = await import("../src/modules/webhook/webhook.service");
const { PrismaNativeDeliveryLedger } = await import("../src/modules/native-alerts/native-alert-ledger");
const { selectNativeDeliveriesV2 } = await import("../src/modules/native-alerts/native-delivery-policy-v2");
const { parseShadowEventLog } = await import("../src/modules/native-alerts/shadow-log-reader");
const { TEDDY_AGGRESSIVE_V1, profileSummaryOf } = await import("../src/modules/native-scanner/scanner-profile");
const { alertsRoutes } = await import("../src/routes/alerts.routes");
const { signalSourcesRoutes } = await import("../src/routes/signal-sources.routes");
const { withAlertContext } = await import("../src/modules/alerts/alert-context");
const { deriveNativeScannerStatus, readSignalSourcesStatus, NATIVE_STATUS_FRESHNESS_MS } = await import("../src/modules/signal-sources/signal-sources.service");

const LINEAGE = "4".repeat(64);
const CONTEXT = { profile: profileSummaryOf(TEDDY_AGGRESSIVE_V1), runId: "20261003T063843Z-c877ccf5" };
let seq = 0;
const nextSymbol = () => `DUALS${++seq}${Date.now() % 100000}USDT`;

function webhookPayload(symbol: string, extra: Record<string, unknown> = {}) {
  return {
    secret: process.env.WEBHOOK_SECRET,
    symbol,
    assetType: "crypto",
    timeframe: "15m",
    price: 1,
    signal: "LONG",
    indicatorName: TAG,
    triggeredAt: new Date().toISOString(),
    exchange: "BINANCE",
    note: "eventType=LEVEL_TOUCHED | levelColor=GREEN | sourceTf=1D | touchDirection=FROM_ABOVE | levelPrice=1 | chartTf=15m",
    ...extra,
  };
}

async function deliverNative(symbol: string, sourceTf: "1D" | "1W" | "1M" = "1W") {
  const identity = { lineageId: LINEAGE, marketType: "USDM_PERPETUAL" as const, symbol, chartInterval: "15m" as const };
  const log = logOf([
    observation({ symbol, lineageId: LINEAGE, barMs: bar(1), sourceTf, createdBarOpenTimeMs: BAR0 - 30 * 96 * M15 }),
    commit(bar(1), "SHADOW_LIVE_ONLY", LINEAGE, symbol),
  ]);
  const [decision] = selectNativeDeliveriesV2(parseShadowEventLog(log, identity), TEDDY_AGGRESSIVE_V1.delivery).flatMap((s) => (s.kind === "DELIVER" ? [s.decision] : []));
  const result = await new PrismaNativeDeliveryLedger(prisma).deliverV2(decision, CONTEXT);
  return { decision, result };
}

async function cleanup() {
  if (!available) return;
  await prisma.extremeRRPlan.deleteMany({ where: { alert: { symbol: { startsWith: "DUALS" } } } });
  await prisma.nativeAlertDelivery.deleteMany({ where: { symbol: { startsWith: "DUALS" } } });
  await prisma.alert.deleteMany({ where: { symbol: { startsWith: "DUALS" } } });
  await prisma.asset.deleteMany({ where: { symbol: { startsWith: "DUALS" } } });
}

let app: FastifyInstance;
beforeAll(async () => {
  await cleanup();
  app = Fastify();
  app.decorate("prisma", prisma);
  await app.register(alertsRoutes);
  await app.register(signalSourcesRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await cleanup();
  await prisma.$disconnect();
});

describe("two ingestion paths, two sources", () => {
  maybe()("a TradingView webhook creates source=TRADINGVIEW through its own path, with no Native ledger row", async () => {
    const symbol = nextSymbol();
    const result = await handleTradingViewWebhook(prisma, webhookPayload(symbol));
    const row = await prisma.alert.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.source).toBe("TRADINGVIEW");
    expect(await prisma.nativeAlertDelivery.count({ where: { alertId: row.id } })).toBe(0);
  });

  maybe()("a webhook cannot acquire Native lineage by sending profile/delivery keys: it stays TRADINGVIEW and gets no ledger row", async () => {
    const symbol = nextSymbol();
    const result = await handleTradingViewWebhook(
      prisma,
      webhookPayload(symbol, {
        source: "NATIVE",
        profile: { profileId: "TEDDY_AGGRESSIVE_V1", nativeExecutionEnabled: false },
        delivery: { policyVersion: "NATIVE_DELIVERY_V2" },
      })
    );
    const row = await prisma.alert.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.source).toBe("TRADINGVIEW");
    expect(await prisma.nativeAlertDelivery.count({ where: { symbol } })).toBe(0);
  });

  maybe()("the Native emitter creates source=NATIVE through the delivery ledger, never through the webhook", async () => {
    const symbol = nextSymbol();
    const { result, decision } = await deliverNative(symbol, "1M");
    const row = await prisma.alert.findUniqueOrThrow({ where: { id: result.alertId as string } });
    expect(row).toMatchObject({ source: "NATIVE", timeframe: "15m", sourceTimeframe: "1M", signal: "LONG" });
    const ledger = await prisma.nativeAlertDelivery.findUniqueOrThrow({ where: { deliveryKey: decision.deliveryKey } });
    expect(ledger.policyVersion).toBe("NATIVE_DELIVERY_V2");
    // Native skips the TradingView pipeline: no Extreme RR plan is ever scheduled for it.
    expect(await prisma.extremeRRPlan.count({ where: { alertId: row.id } })).toBe(0);
  });

  maybe()("the two dedupe identities are independent: neither source absorbs or blocks the other", async () => {
    const symbol = nextSymbol();
    const tv1 = await handleTradingViewWebhook(prisma, webhookPayload(symbol));
    const { result: native } = await deliverNative(symbol, "1W");
    expect(native.outcome).toBe("CREATED");
    // A repeat webhook is a TradingView duplicate of the TradingView row, never of the Native row.
    const tv2 = await handleTradingViewWebhook(prisma, webhookPayload(symbol));
    expect(tv2).toMatchObject({ id: tv1.id, duplicate: true });
    // A repeat Native delivery is idempotent on its own key.
    const { result: again } = await deliverNative(symbol, "1W");
    expect(again.outcome).toBe("ALREADY_DELIVERED");
    expect(await prisma.alert.count({ where: { symbol, source: "TRADINGVIEW" } })).toBe(1);
    expect(await prisma.alert.count({ where: { symbol, source: "NATIVE" } })).toBe(1);
  });
});

describe("serialization and the source filter", () => {
  maybe()("GET /api/alerts filters by source, preserves source on every item, and never mixes them", async () => {
    const symbol = nextSymbol();
    const tv = await handleTradingViewWebhook(prisma, webhookPayload(symbol));
    const { result: native } = await deliverNative(symbol, "1W");
    const list = async (query: string) => (await app.inject({ method: "GET", url: `/api/alerts?symbol=${symbol}&${query}` })).json() as { items: Array<{ id: string; source: string; signal: string }>; total: number };
    const all = await list("");
    expect(all.items.map((i) => i.source).sort()).toEqual(["NATIVE", "TRADINGVIEW"]);
    expect((await list("source=TRADINGVIEW")).items.map((i) => [i.id, i.source])).toEqual([[tv.id, "TRADINGVIEW"]]);
    expect((await list("source=NATIVE")).items.map((i) => [i.id, i.source])).toEqual([[native.alertId, "NATIVE"]]);
    // Source composes with the signal-direction filter without reinterpreting it.
    expect((await list("source=NATIVE&signals=LONG,SHORT")).total).toBe(1);
    expect((await list("source=NATIVE&signals=WATCH")).total).toBe(0);
    // Unknown sources are refused, never silently widened to "all".
    for (const bad of ["ALL", "native", "WEBHOOK"]) {
      const res = await app.inject({ method: "GET", url: `/api/alerts?symbol=${symbol}&source=${bad}` });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
    // Neighbor navigation honours the same source filter.
    const neighbors = await app.inject({ method: "GET", url: `/api/alerts/${native.alertId}/neighbors?symbol=${symbol}&source=NATIVE` });
    expect(neighbors.json()).toEqual({ newer: null, older: null });
  });

  maybe()("the socket serializer and the detail route preserve source; a legacy TradingView row (no explicit source) reads as TRADINGVIEW", async () => {
    const symbol = nextSymbol();
    const legacy = await prisma.alert.create({
      data: { symbol, assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 1, signal: "SHORT", indicatorName: TAG, rawPayload: { note: "legacy" }, triggeredAt: new Date() },
    });
    expect(withAlertContext(legacy).source).toBe("TRADINGVIEW");
    const detail = await app.inject({ method: "GET", url: `/api/alerts/${legacy.id}` });
    expect(detail.json()).toMatchObject({ id: legacy.id, source: "TRADINGVIEW" });
    const { result } = await deliverNative(symbol, "1D");
    const nativeRow = await prisma.alert.findUniqueOrThrow({ where: { id: result.alertId as string } });
    expect(withAlertContext(nativeRow).source).toBe("NATIVE");
  });
});

describe("Signal Sources status: read-only and truthful", () => {
  maybe()("TradingView: 'READY' webhook and the last ACTUAL TradingView alert; Native deliveries are never counted as TradingView", async () => {
    const symbol = nextSymbol();
    await deliverNative(symbol, "1W");
    const before = await readSignalSourcesStatus({ prisma, readNativeStatus: () => null });
    expect(before.tradingView.webhook).toBe("READY");
    expect(before.tradingView.lastReceivedSymbol).not.toBe(symbol);
    expect(before.native.lastDeliveredSymbol).toBe(symbol);
    await handleTradingViewWebhook(prisma, webhookPayload(symbol));
    const after = await readSignalSourcesStatus({ prisma, readNativeStatus: () => null });
    expect(after.tradingView.lastReceivedSymbol).toBe(symbol);
    expect(after.native.state).toBe("UNKNOWN");
    const res = await app.inject({ method: "GET", url: "/api/signal-sources/status" });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toMatch(/LOCALAPPDATA|\\\\|"pid"|secret/i);
  });

  it("the Native state is RUNNING only when fresh and explicit; STOPPED, STALE and UNKNOWN otherwise", () => {
    const now = Date.parse("2026-10-03T12:00:00.000Z");
    const status = (over: Record<string, unknown>) =>
      JSON.stringify({
        schema: "teddy.native-scanner.live-shadow-supervisor-status.v3",
        runId: "20261003T063843Z-c877ccf5",
        engineFingerprint: "3e21f1c15207b03b91315767a4b54c92b0e6a21da33149c02c4ec0ee7c903998",
        profile: { profileId: "TEDDY_AGGRESSIVE_V1", profileLabel: "Teddy Aggressive" },
        selection: { targetEligible: 50, acceptedEligible: 50 },
        totals: { selected: 50, liveEligible: 50, failed: 0 },
        pid: 1234,
        ...over,
      });
    const fresh = new Date(now - 30_000).toISOString();
    const old = new Date(now - NATIVE_STATUS_FRESHNESS_MS - 1_000).toISOString();
    expect(deriveNativeScannerStatus(status({ runState: "RUNNING", writtenAt: fresh }), now)).toMatchObject({
      state: "RUNNING", profileId: "TEDDY_AGGRESSIVE_V1", profileLabel: "Teddy Aggressive", runId: "20261003T063843Z-c877ccf5",
      engineFingerprintPrefix: "3e21f1c15207", targetEligible: 50, acceptedEligible: 50, liveEligible: 50,
    });
    expect(deriveNativeScannerStatus(status({ runState: "RUNNING", writtenAt: old }), now).state).toBe("STALE");
    expect(deriveNativeScannerStatus(status({ runState: "STOPPED", writtenAt: old }), now).state).toBe("STOPPED");
    // A status from before run states existed never reads as running.
    expect(deriveNativeScannerStatus(status({ runState: undefined, writtenAt: fresh, schema: "teddy.native-scanner.live-shadow-supervisor-status.v2" }), now).state).toBe("UNKNOWN");
    expect(deriveNativeScannerStatus(status({ runState: undefined, writtenAt: old }), now).state).toBe("STALE");
    expect(deriveNativeScannerStatus(null, now).state).toBe("UNKNOWN");
    expect(deriveNativeScannerStatus("{not json", now).state).toBe("UNKNOWN");
    expect(deriveNativeScannerStatus(JSON.stringify({ schema: "other" }), now).state).toBe("UNKNOWN");
    expect(deriveNativeScannerStatus(status({ runState: "RUNNING", writtenAt: new Date(now + 3_600_000).toISOString() }), now).state).toBe("UNKNOWN");
    expect(JSON.stringify(deriveNativeScannerStatus(status({ runState: "RUNNING", writtenAt: fresh }), now))).not.toContain("1234");
  });

  it("static: the status module only reads (no database or file writes), and is mounted on the generic surface", () => {
    const service = readFileSync(path.join(process.cwd(), "src/modules/signal-sources/signal-sources.service.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(service).not.toMatch(/\.(create|update|upsert|delete|deleteMany|updateMany|createMany)\(|writeFile|appendFile|mkdir|rename|unlink/);
    const appSource = readFileSync(path.join(process.cwd(), "src/app.ts"), "utf8");
    const generic = appSource.slice(appSource.indexOf("export async function buildApp("), appSource.indexOf("export async function buildAccountControlApp("));
    expect(generic).toContain("await app.register(signalSourcesRoutes);");
  });
});
