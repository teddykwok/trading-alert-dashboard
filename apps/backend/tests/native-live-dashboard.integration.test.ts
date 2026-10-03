import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient, type Alert } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SOCKET_EVENTS } from "@trading-alert-dashboard/shared";

import { connectTestDatabase, resolveTestDatabase } from "./helpers/test-database";
import { BAR0, M15, bar, commit, logOf, observation } from "./helpers/native-alert-fixtures";

/**
 * LIVE DASHBOARD PUSH for Native V2 deliveries, against the TEST database only.
 *
 * The push is presentation: it happens strictly AFTER the delivery transaction
 * commits, exactly once per Alert the call created, never for a rolled-back,
 * duplicate or other-policy delivery, and its failure cannot undo, duplicate
 * or re-deliver anything. It reuses the canonical `new_alert` event and the
 * `withAlertContext` serializer, and touches no TradingView pipeline.
 */

const enqueueVisionAnalysis = vi.fn();
const enqueueExtremeRRPlan = vi.fn();
vi.mock("../src/modules/jobs/queue", () => ({ enqueueVisionAnalysis, enqueueExtremeRRPlan }));
// The REAL Socket.IO Redis emitter (globally mocked in setup) so its publish path is exercised —
// against an in-memory publish function only; no Redis is ever contacted.
vi.unmock("@socket.io/redis-emitter");

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient = testDatabase;
const maybe = () => (available ? it : it.skip);

const { PrismaNativeDeliveryLedger } = await import("../src/modules/native-alerts/native-alert-ledger");
const { selectNativeDeliveries } = await import("../src/modules/native-alerts/native-delivery-policy");
const { selectNativeDeliveriesV2 } = await import("../src/modules/native-alerts/native-delivery-policy-v2");
const { parseShadowEventLog } = await import("../src/modules/native-alerts/shadow-log-reader");
const { MultiSymbolNativeEmitter, bindPinnedRun, runMultiSymbolEmitter } = await import("../src/modules/native-alerts/multi-symbol-emitter");
const { TEDDY_AGGRESSIVE_V1, engineFingerprintOf, profileLineageIdFor, profileSummaryOf } = await import("../src/modules/native-scanner/scanner-profile");
const { SUPERVISOR_RUN_MANIFEST_SCHEMA, buildRunManifest } = await import("../src/modules/native-scanner/supervisor-run-manifest");
const { withAlertContext } = await import("../src/modules/alerts/alert-context");
const { awaitableSocketEmit, createNativeAlertLivePublisher, refuseLiveNativeAlert } = await import("../src/modules/notifications/native-alert-live-publisher");

const T = TEDDY_AGGRESSIVE_V1;
const CONTEXT = { profile: profileSummaryOf(T), runId: "20261003T063843Z-c877ccf5" };
const LINEAGE = "5".repeat(64);
let seq = 0;
const nextSymbol = () => `NLIVE${++seq}${Date.now() % 100000}USDT`;

function decisionFor(symbol: string, sourceTf: "1D" | "1W" | "1M" = "1W", lineageId = LINEAGE) {
  const identity = { lineageId, marketType: "USDM_PERPETUAL" as const, symbol, chartInterval: "15m" as const };
  const log = logOf([observation({ symbol, lineageId, barMs: bar(1), sourceTf, createdBarOpenTimeMs: BAR0 - 30 * 96 * M15 }), commit(bar(1), "SHADOW_LIVE_ONLY", lineageId, symbol)]);
  const records = parseShadowEventLog(log, identity);
  const [decision] = selectNativeDeliveriesV2(records, T.delivery).flatMap((s) => (s.kind === "DELIVER" ? [s.decision] : []));
  return { decision, records };
}

/** A client whose ledger insert fails INSIDE the transaction, so the whole delivery rolls back. */
function faultyLedgerInsert(client: PrismaClient): PrismaClient {
  const failing = (delegate: object) =>
    new Proxy(delegate, {
      get(target, prop, receiver) {
        if (prop === "create") return async () => Promise.reject(new Error("injected failure inside the transaction"));
        return Reflect.get(target, prop, receiver);
      },
    });
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "$transaction") {
        return (fn: (tx: unknown) => Promise<unknown>) =>
          target.$transaction((tx) =>
            fn(new Proxy(tx, { get: (t, p, r) => (p === "nativeAlertDelivery" ? failing(Reflect.get(t, p, r) as object) : Reflect.get(t, p, r)) }))
          );
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

/** A SECOND connection: it can only see rows that have been COMMITTED. */
let observer: PrismaClient;

async function cleanup() {
  if (!available) return;
  await prisma.nativeAlertDelivery.deleteMany({ where: { symbol: { startsWith: "NLIVE" } } });
  await prisma.alert.deleteMany({ where: { symbol: { startsWith: "NLIVE" } } });
}

beforeAll(async () => {
  await cleanup();
  observer = new PrismaClient({ datasources: { db: { url: available ? resolveTestDatabase().url : "postgresql://x:x@127.0.0.1:1/x" } } });
});
afterAll(async () => {
  await cleanup();
  await observer.$disconnect();
  await prisma.$disconnect();
});

describe("the post-commit hook of the V2 delivery primitive", () => {
  maybe()("1. a committed delivery publishes exactly once, AFTER commit: a separate connection already sees the Alert and its ledger row", async () => {
    const symbol = nextSymbol();
    const { decision } = decisionFor(symbol);
    const seen: Array<{ alert: Alert; visibleAlert: boolean; visibleLedger: boolean }> = [];
    const ledger = new PrismaNativeDeliveryLedger(prisma, {
      onAlertCommitted: async (alert) => {
        seen.push({
          alert,
          visibleAlert: (await observer.alert.count({ where: { id: alert.id } })) === 1,
          visibleLedger: (await observer.nativeAlertDelivery.count({ where: { deliveryKey: decision.deliveryKey } })) === 1,
        });
      },
    });
    const result = await ledger.deliverV2(decision, CONTEXT);
    expect(result.outcome).toBe("CREATED");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ visibleAlert: true, visibleLedger: true });
    expect(seen[0].alert).toMatchObject({ id: result.alertId, source: "NATIVE", symbol, sourceTimeframe: "1W" });
    expect((seen[0].alert.rawPayload as { actionable: boolean }).actionable).toBe(false);
  });

  maybe()("2. a failed transaction publishes NOTHING and leaves no Alert", async () => {
    const symbol = nextSymbol();
    const { decision } = decisionFor(symbol);
    const calls: Alert[] = [];
    const ledger = new PrismaNativeDeliveryLedger(faultyLedgerInsert(prisma), { onAlertCommitted: (alert) => void calls.push(alert) });
    await expect(ledger.deliverV2(decision, CONTEXT)).rejects.toThrow(/injected failure/);
    expect(calls).toHaveLength(0);
    expect(await prisma.alert.count({ where: { symbol } })).toBe(0);
  });

  maybe()("3/4. a V2 duplicate, and an event a V1 row already delivered, publish NOTHING", async () => {
    const symbol = nextSymbol();
    const { decision } = decisionFor(symbol);
    const calls: Alert[] = [];
    const ledger = new PrismaNativeDeliveryLedger(prisma, { onAlertCommitted: (alert) => void calls.push(alert) });
    expect((await ledger.deliverV2(decision, CONTEXT)).outcome).toBe("CREATED");
    expect((await ledger.deliverV2(decision, CONTEXT)).outcome).toBe("ALREADY_DELIVERED");
    expect(calls).toHaveLength(1);

    const other = nextSymbol();
    const { records, decision: v2 } = decisionFor(other, "1D");
    const [v1] = selectNativeDeliveries(records).flatMap((s) => (s.kind === "DELIVER" ? [s.decision] : []));
    await new PrismaNativeDeliveryLedger(prisma).deliver(v1);
    expect((await ledger.deliverV2(v2, CONTEXT)).outcome).toBe("ALREADY_DELIVERED_UNDER_OTHER_POLICY");
    expect(calls).toHaveLength(1);
  });

  maybe()("5/6. a publisher that throws after commit cannot undo, duplicate or re-deliver: the Alert and ledger stay, a retry publishes nothing", async () => {
    const symbol = nextSymbol();
    const { decision } = decisionFor(symbol);
    let calls = 0;
    const ledger = new PrismaNativeDeliveryLedger(prisma, {
      onAlertCommitted: () => {
        calls += 1;
        throw new Error("socket transport down");
      },
    });
    const result = await ledger.deliverV2(decision, CONTEXT);
    expect(result.outcome).toBe("CREATED");
    expect(await prisma.alert.count({ where: { symbol, source: "NATIVE" } })).toBe(1);
    expect(await prisma.nativeAlertDelivery.count({ where: { deliveryKey: decision.deliveryKey } })).toBe(1);
    const retry = await ledger.deliverV2(decision, CONTEXT);
    expect(retry).toMatchObject({ outcome: "ALREADY_DELIVERED", alertId: result.alertId });
    expect(calls).toBe(1);
    expect(await prisma.alert.count({ where: { symbol } })).toBe(1);
    // Native never entered the TradingView pipeline.
    expect(enqueueVisionAnalysis).not.toHaveBeenCalled();
    expect(enqueueExtremeRRPlan).not.toHaveBeenCalled();
    expect(await prisma.extremeRRPlan.count({ where: { alertId: result.alertId as string } })).toBe(0);
  });

  maybe()("the real multi-symbol emitter publishes once per CREATED alert, for every symbol and deliverable source TF, and never for history or duplicates", async () => {
    const symbols = [nextSymbol(), nextSymbol()].sort();
    const BOOT = "c".repeat(64);
    const lineageOf = (s: string) => profileLineageIdFor(T, s, BOOT);
    const manifest = buildRunManifest({
      schema: SUPERVISOR_RUN_MANIFEST_SCHEMA, runId: CONTEXT.runId, startedAt: "2026-10-03T06:38:43.000Z", gitHead: "test", marketType: "USDM_PERPETUAL",
      chartInterval: "15m", engineFingerprint: engineFingerprintOf(T), profile: profileSummaryOf(T), stateLayout: "ENGINE_NAMESPACE",
      selection: { mode: "TARGET", universeActive: 523, targetEligible: 2, candidatesTested: 2, acceptedEligible: 2, skippedTooNew: 0, skippedInsufficientHistory: 0, skippedOther: 0, universeExhausted: false },
      symbols: symbols.map((symbol) => ({ symbol, lineageId: lineageOf(symbol), bootstrapInputSha256: BOOT })), actionable: false,
    });
    const run = bindPinnedRun({
      manifest,
      expect: { profileId: T.profileId, runId: CONTEXT.runId, engineFingerprint: engineFingerprintOf(T) },
      checkpointOf: (symbol) => ({ lineageId: lineageOf(symbol), symbol, chartInterval: "15m", marketType: "USDM_PERPETUAL" }),
    });
    const logs: Record<string, string> = Object.fromEntries(symbols.map((s) => [s, logOf([commit(bar(0), "QUARANTINED_CURRENT_BAR", lineageOf(s), s)])]));
    const store = new Map<string, unknown>();
    const cursors = { load: (s: string) => (store.get(s) ?? null) as never, save: (c: { symbol: string }) => void store.set(c.symbol, c) };
    const published: Alert[] = [];
    const ledger = new PrismaNativeDeliveryLedger(prisma, { onAlertCommitted: (alert) => void published.push(alert) });
    const make = (activateAtEof: boolean) =>
      new MultiSymbolNativeEmitter({
        mode: "COMMIT_DASHBOARD_ALERTS", run, readLog: (s) => logs[s] ?? null, cursors, cursorWriter: cursors, ledger, baseline: "PRODUCTION_CURSOR",
        activateAtEof, queueCapacity: 100, pendingTailPolls: 0, nowIso: () => "2026-10-03T12:00:00.000Z", report: () => undefined,
      });
    const once = (e: InstanceType<typeof MultiSymbolNativeEmitter>) => runMultiSymbolEmitter(e, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
    await once(make(true)); // first activation at EOF: history never published
    expect(published).toHaveLength(0);
    const afterActivation = new Map(store);
    for (const s of symbols) {
      logs[s] += logOf([
        observation({ symbol: s, lineageId: lineageOf(s), barMs: bar(1), sourceTf: "1D", candidateSequence: 0, updateSequence: 2 }),
        observation({ symbol: s, lineageId: lineageOf(s), barMs: bar(1), sourceTf: "1M", candidateSequence: 1, updateSequence: 3, createdBarOpenTimeMs: BAR0 - 30 * 96 * M15 }),
        observation({ symbol: s, lineageId: lineageOf(s), barMs: bar(1), sourceTf: "3M", candidateSequence: 2, updateSequence: 4, createdBarOpenTimeMs: BAR0 - 90 * 96 * M15 }),
        commit(bar(1), "SHADOW_LIVE_ONLY", lineageOf(s), s),
      ]);
    }
    await once(make(false));
    expect(published.map((a) => `${a.symbol}:${a.sourceTimeframe}`).sort()).toEqual(symbols.flatMap((s) => [`${s}:1D`, `${s}:1M`]).sort());
    expect(published.every((a) => a.source === "NATIVE")).toBe(true);
    // Reprocessing: rewind every cursor to the activation point (as after a crash before the cursor
    // write), so the SAME four events run through the ledger again. Ledger dedupe: no new Alert, no publish.
    store.clear();
    for (const [key, value] of afterActivation) store.set(key, value);
    const replay = make(false);
    await once(replay);
    expect(replay.status()).toMatchObject({ created: 0, ledgerDuplicates: 4 });
    expect(published).toHaveLength(4);
    for (const s of symbols) expect(await prisma.alert.count({ where: { symbol: s } })).toBe(2);
  });
});

describe("the live publisher: canonical event, validated, never fatal", () => {
  const nativeRow = (over: Partial<Alert> = {}): Alert =>
    ({
      id: "cmus4a41l0002148ss6qjwhr9", symbol: "ALICEUSDT", source: "NATIVE", status: "RECEIVED", signal: "LONG", timeframe: "15m", sourceTimeframe: "1M",
      levelColor: "GREEN", eventType: "LEVEL_TOUCHED", touchDirection: "FROM_ABOVE", rawPayload: { actionable: false, note: "eventType=LEVEL_TOUCHED | levelColor=GREEN | sourceTf=1M | touchDirection=FROM_ABOVE | levelPrice=0.1 | chartTf=15m" },
      ...over,
    }) as unknown as Alert;

  it("publishes the SAME event and serializer a TradingView alert uses, carrying source=NATIVE and actionable=false", async () => {
    const emits: Array<[string, unknown]> = [];
    const publisher = createNativeAlertLivePublisher({ emit: async (e, p) => void emits.push([e, p]), log: () => undefined });
    expect(await publisher.publishCommitted(nativeRow())).toBe("PUBLISHED");
    expect(emits).toHaveLength(1);
    expect(emits[0][0]).toBe(SOCKET_EVENTS.NEW_ALERT);
    expect(emits[0][1]).toEqual(withAlertContext(nativeRow()));
    expect(emits[0][1]).toMatchObject({ source: "NATIVE", rawPayload: { actionable: false }, alertContext: { sourceTimeframe: "1M" } });
    // The TradingView path emits this same event through the same serializer.
    const socketEvents = readFileSync(path.join(process.cwd(), "src/modules/notifications/socket-events.ts"), "utf8");
    expect(socketEvents).toContain("emitter.emit(SOCKET_EVENTS.NEW_ALERT, withAlertContext(alert));");
  });

  it("refuses anything that is not a committed, non-actionable NATIVE row — a TradingView row, a malformed id, an actionable payload", async () => {
    const emits: unknown[] = [];
    const lines: string[] = [];
    const publisher = createNativeAlertLivePublisher({ emit: async (_e, p) => void emits.push(p), log: (l) => lines.push(l) });
    for (const bad of [
      nativeRow({ source: "TRADINGVIEW" }),
      nativeRow({ id: "../../etc/passwd" }),
      nativeRow({ id: "X".repeat(25) }),
      nativeRow({ rawPayload: { actionable: true } as never }),
      nativeRow({ rawPayload: null as never }),
    ]) {
      expect(await publisher.publishCommitted(bad)).toBe("REFUSED");
    }
    expect(emits).toHaveLength(0);
    expect(refuseLiveNativeAlert(nativeRow())).toBeNull();
    expect(lines.join(" ")).not.toMatch(/ALICEUSDT|passwd/);
  });

  it("a failing or hanging transport is reported, never thrown, and logs no content", async () => {
    const lines: string[] = [];
    const failing = createNativeAlertLivePublisher({ emit: async () => Promise.reject(Object.assign(new Error("redis://user:secret@host"), { name: "ConnectionError" })), log: (l) => lines.push(l) });
    await expect(failing.publishCommitted(nativeRow())).resolves.toBe("FAILED");
    const hanging = createNativeAlertLivePublisher({ emit: () => new Promise(() => undefined), log: (l) => lines.push(l), timeoutMs: 50 });
    await expect(hanging.publishCommitted(nativeRow())).resolves.toBe("FAILED");
    expect(lines.join(" ")).toMatch(/ConnectionError/);
    expect(lines.join(" ")).toMatch(/TimeoutError/);
    expect(lines.join(" ")).not.toMatch(/secret|redis:\/\/|ALICEUSDT/);
  });

  it("the Socket.IO Redis emitter's publish is awaited (so failures are caught) on the adapter's broadcast channel", async () => {
    const published: Array<[string, Buffer | string]> = [];
    const ok = awaitableSocketEmit({ publish: async (c, m) => void published.push([c, m]) });
    await ok(SOCKET_EVENTS.NEW_ALERT, withAlertContext(nativeRow()));
    expect(published).toHaveLength(1);
    expect(published[0][0]).toBe("socket.io#/#");
    const body = Buffer.from(published[0][1] as Buffer).toString("latin1");
    expect(body).toContain("new_alert");
    expect(body).toContain("cmus4a41l0002148ss6qjwhr9");
    const broken = awaitableSocketEmit({ publish: async () => Promise.reject(new Error("down")) });
    await expect(broken(SOCKET_EVENTS.NEW_ALERT, {})).rejects.toThrow("down");
  });
});
