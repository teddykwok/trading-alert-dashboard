import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";
import { IDENTITY, logOf, observation } from "./helpers/native-alert-fixtures";

/**
 * NATIVE alert lifecycle, against the TEST database only:
 *  - dashboard stats never count dashboard-only NATIVE alerts as "processing";
 *  - old NATIVE alerts are deleted by retention under their own explicit rule,
 *    while TradingView retention is unchanged;
 *  - the delivery ledger survives the deletion, and re-reading the shadow log
 *    afterwards never recreates the Alert;
 *  - a NATIVE row can never shadow a TradingView duplicate.
 *
 * Every fixture is dated in 2001, so a real retention pass here can only reach
 * these rows (cutoff 2001-01-10): nothing another suite created qualifies.
 */

const TAG = "native-lifecycle-it";
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient = testDatabase;
const maybe = () => (available ? it : it.skip);

const { AlertsService } = await import("../src/modules/alerts/alerts.service");
const { runRetentionCleanup } = await import("../src/modules/retention/retention.service");
const { PrismaNativeDeliveryLedger } = await import("../src/modules/native-alerts/native-alert-ledger");
const { NativeAlertEmitter } = await import("../src/modules/native-alerts/native-alert-emitter");
const { selectNativeDeliveries } = await import("../src/modules/native-alerts/native-delivery-policy");
const { parseShadowEventLog } = await import("../src/modules/native-alerts/shadow-log-reader");

const OLD = (day: number) => new Date(Date.UTC(2001, 0, day, 12));
const NOW_2001 = new Date(Date.UTC(2001, 2, 1)); // 30-day cutoff: 2001-01-30
let seq = 0;
const nextSymbol = () => `NLIFE${++seq}${Date.now() % 100000}USDT`;

async function alertRow(data: { symbol: string; source: "NATIVE" | "TRADINGVIEW"; status?: "RECEIVED" | "ANALYZED"; createdAt?: Date; indicatorName?: string }) {
  return prisma.alert.create({
    data: {
      symbol: data.symbol,
      assetType: "CRYPTO",
      exchange: "BINANCE",
      timeframe: "15m",
      price: 1,
      signal: "LONG",
      indicatorName: data.indicatorName ?? TAG,
      rawPayload: { tag: TAG },
      triggeredAt: data.createdAt ?? new Date(),
      source: data.source,
      status: data.status ?? "RECEIVED",
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
}

/** A real ledger-delivered NATIVE alert for `symbol`, then aged into 2001. */
async function deliveredNative(symbol: string, createdAt: Date) {
  const records = parseShadowEventLog(logOf([observation({ symbol })]), { ...IDENTITY, symbol });
  const [selection] = selectNativeDeliveries(records);
  if (selection.kind !== "DELIVER") throw new Error("fixture must deliver");
  const result = await new PrismaNativeDeliveryLedger(prisma).deliver(selection.decision);
  await prisma.alert.update({ where: { id: result.alertId as string }, data: { createdAt } });
  return { alertId: result.alertId as string, decision: selection.decision, records };
}

async function cleanup() {
  if (!available) return;
  await prisma.nativeAlertDelivery.deleteMany({ where: { symbol: { startsWith: "NLIFE" } } });
  await prisma.alert.deleteMany({ where: { symbol: { startsWith: "NLIFE" } } });
  await prisma.asset.deleteMany({ where: { symbol: { startsWith: "NLIFE" } } });
}

const dirs: string[] = [];
beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe("dashboard statistics are source-aware", () => {
  maybe()("a NATIVE alert counts in total and long, never in processing; TradingView processing is unchanged", async () => {
    const range = { from: OLD(25), to: OLD(26) }; // after the retention test's cutoff
    const service = new AlertsService(prisma);
    const before = await service.statsForRange(range);
    await alertRow({ symbol: nextSymbol(), source: "TRADINGVIEW", createdAt: new Date(OLD(25).getTime() + 1_000) });
    await alertRow({ symbol: nextSymbol(), source: "NATIVE", createdAt: new Date(OLD(25).getTime() + 2_000) });
    await alertRow({ symbol: nextSymbol(), source: "NATIVE", createdAt: new Date(OLD(25).getTime() + 3_000) });
    const after = await service.statsForRange(range);
    expect(after.total - before.total).toBe(3);
    expect(after.long - before.long).toBe(3);
    expect(after.processing - before.processing).toBe(1); // only the TradingView RECEIVED alert
    expect(after.analyzed - before.analyzed).toBe(0);
  });
});

describe("retention is source-aware and keeps the ledger", () => {
  maybe()("old NATIVE alerts are deleted, the ledger row survives with alertId null, and re-reading the log never recreates them", async () => {
    const symbol = nextSymbol();
    const delivered = await deliveredNative(symbol, OLD(5));
    const tvReceived = await alertRow({ symbol: nextSymbol(), source: "TRADINGVIEW", createdAt: OLD(5) });
    const nativeWithOpenReview = await alertRow({ symbol: nextSymbol(), source: "NATIVE", createdAt: OLD(5) });
    await prisma.tradeReview.create({ data: { alertId: nativeWithOpenReview.id, status: "OPEN" } });
    const nativeRecent = await alertRow({ symbol: nextSymbol(), source: "NATIVE", createdAt: OLD(20) }); // newer than the 2001-01-10 cutoff
    const screenshotDir = mkdtempSync(path.join(tmpdir(), "native-retention-"));
    dirs.push(screenshotDir);
    const options = { screenshotDir, screenshotRetentionDays: 30, alertRetentionDays: 50, now: NOW_2001 }; // cutoff 2001-01-10

    const dry = await runRetentionCleanup(prisma, { ...options, dryRun: true });
    expect(dry.nativeAlertsSelected).toBe(1);
    expect(dry.skippedNativeOpenUserState).toBe(1);
    expect(dry.nativeAlertsDeleted).toBe(0);
    expect(await prisma.alert.count({ where: { id: delivered.alertId } })).toBe(1);

    const real = await runRetentionCleanup(prisma, { ...options, dryRun: false });
    expect(real.nativeAlertsDeleted).toBe(1);
    expect(await prisma.alert.count({ where: { id: delivered.alertId } })).toBe(0);
    // TradingView RECEIVED: never deleted (the TradingView rule is unchanged).
    expect(await prisma.alert.count({ where: { id: tvReceived.id } })).toBe(1);
    // Open user state and alerts newer than the cutoff are kept.
    expect(await prisma.alert.count({ where: { id: nativeWithOpenReview.id } })).toBe(1);
    expect(await prisma.alert.count({ where: { id: nativeRecent.id } })).toBe(1);

    // The ledger survives the deletion: SetNull, not cascade.
    const ledger = await prisma.nativeAlertDelivery.findUniqueOrThrow({ where: { deliveryKey: delivered.decision.deliveryKey } });
    expect(ledger.alertId).toBeNull();
    expect(ledger.winningShadowEventId).toBe(delivered.decision.winner.eventId);

    // Re-reading the same shadow log from byte 0: nothing is recreated.
    const emitter = new NativeAlertEmitter({ mode: "COMMIT_DASHBOARD_ALERTS", ledger: new PrismaNativeDeliveryLedger(prisma), report: () => undefined });
    await emitter.process(delivered.records);
    expect(emitter.tally).toMatchObject({ created: 0, alreadyDelivered: 1 });
    expect(await prisma.alert.count({ where: { symbol } })).toBe(0);
    expect(await prisma.nativeAlertDelivery.count({ where: { symbol } })).toBe(1);
  });
});

describe("TradingView duplicate suppression ignores NATIVE rows", () => {
  maybe()("a newer NATIVE row cannot hide an older TradingView duplicate", async () => {
    const { handleTradingViewWebhook } = await import("../src/modules/webhook/webhook.service");
    const symbol = nextSymbol();
    const indicatorName = `${TAG}-dup`;
    const olderTv = await alertRow({ symbol, source: "TRADINGVIEW", indicatorName, createdAt: new Date(Date.now() - 20_000) });
    // Newest row for the same duplicate keys is NATIVE.
    await alertRow({ symbol, source: "NATIVE", indicatorName, createdAt: new Date(Date.now() - 2_000) });
    const result = await handleTradingViewWebhook(prisma, {
      secret: process.env.WEBHOOK_SECRET,
      symbol,
      assetType: "crypto",
      timeframe: "15m",
      price: 1,
      signal: "LONG",
      indicatorName,
      triggeredAt: new Date().toISOString(),
      exchange: "BINANCE",
    });
    expect(result).toMatchObject({ id: olderTv.id, status: "IGNORED_DUPLICATE", duplicate: true });
    expect(await prisma.alert.count({ where: { symbol, source: "TRADINGVIEW" } })).toBe(1);
    const native = await prisma.alert.findFirstOrThrow({ where: { symbol, source: "NATIVE" } });
    expect(native.duplicateCount).toBe(0); // a NATIVE row is never bumped as a TradingView duplicate
  });
});

