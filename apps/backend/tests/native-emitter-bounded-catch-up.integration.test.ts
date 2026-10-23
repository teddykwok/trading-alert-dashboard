import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SourceTimeframe } from "@trading-alert-dashboard/shared";

import { connectTestDatabase } from "./helpers/test-database";
import { BAR0, M15, bar, commit, logOf, observation } from "./helpers/native-alert-fixtures";

/**
 * BOUNDED CATCH-UP against the REAL delivery ledger, on the TEST database only:
 * a backlog three times the queue, a crash in the middle of it (the ledger
 * commits, the cursor write never happens), and a restart. The ledger's
 * idempotency is the final duplicate fence: every deliverable event becomes
 * exactly ONE dashboard Alert, however the catch-up is interrupted.
 */

const enqueueVisionAnalysis = vi.fn();
const enqueueExtremeRRPlan = vi.fn();
vi.mock("../src/modules/jobs/queue", () => ({ enqueueVisionAnalysis, enqueueExtremeRRPlan }));

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient = testDatabase;
const maybe = () => (available ? it : it.skip);

const { PrismaNativeDeliveryLedger } = await import("../src/modules/native-alerts/native-alert-ledger");
const { MultiSymbolNativeEmitter, bindPinnedRun, runMultiSymbolEmitter } = await import("../src/modules/native-alerts/multi-symbol-emitter");
const { TEDDY_AGGRESSIVE_V1, engineFingerprintOf, profileLineageIdFor, profileSummaryOf } = await import("../src/modules/native-scanner/scanner-profile");
const { SUPERVISOR_RUN_MANIFEST_SCHEMA, buildRunManifest } = await import("../src/modules/native-scanner/supervisor-run-manifest");

const PREFIX = "NAOCU";
const T = TEDDY_AGGRESSIVE_V1;
const RUN_ID = "20261023T000000Z-a0c0a0c0";
const BOOT = "c".repeat(64);
const lineageOf = (symbol: string) => profileLineageIdFor(T, symbol, BOOT);
const DELIVERABLE: SourceTimeframe[] = ["1D", "1W", "1M"];

async function cleanup(): Promise<void> {
  if (!available) return;
  await prisma.nativeAlertDelivery.deleteMany({ where: { symbol: { startsWith: PREFIX } } });
  await prisma.alert.deleteMany({ where: { symbol: { startsWith: PREFIX } } });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

function backlog(symbol: string, bars: number) {
  const lineageId = lineageOf(symbol);
  const records = [];
  for (let n = 1; n <= bars; n += 1) {
    DELIVERABLE.forEach((tf, i) =>
      records.push(observation({ symbol, lineageId, barMs: bar(n), sourceTf: tf, candidateSequence: i, updateSequence: 2 + i, eventTimeMs: bar(n) + 60_000 + i, levelPrice: 2 + i / 10, createdBarOpenTimeMs: BAR0 - (i + 1) * 30 * 96 * M15 }))
    );
    records.push(commit(bar(n), "SHADOW_LIVE_ONLY", lineageId, symbol));
  }
  return records;
}

describe("bounded catch-up over the real delivery ledger", () => {
  maybe()("a crash in the middle of a 3x-capacity catch-up, then a restart: every deliverable event is exactly ONE Alert", async () => {
    const symbols = [`${PREFIX}A${Date.now() % 100000}USDT`, `${PREFIX}B${Date.now() % 100000}USDT`].sort();
    const manifest = buildRunManifest({
      schema: SUPERVISOR_RUN_MANIFEST_SCHEMA,
      runId: RUN_ID,
      startedAt: "2026-10-23T00:00:00.000Z",
      gitHead: "test",
      marketType: "USDM_PERPETUAL",
      chartInterval: "15m",
      engineFingerprint: engineFingerprintOf(T),
      profile: profileSummaryOf(T),
      stateLayout: "ENGINE_NAMESPACE",
      selection: { mode: "TARGET", universeActive: 523, targetEligible: 2, candidatesTested: 2, acceptedEligible: 2, skippedTooNew: 0, skippedInsufficientHistory: 0, skippedOther: 0, universeExhausted: false },
      symbols: symbols.map((symbol) => ({ symbol, lineageId: lineageOf(symbol), bootstrapInputSha256: BOOT })),
      actionable: false,
    });
    const run = bindPinnedRun({
      manifest,
      expect: { profileId: T.profileId, runId: RUN_ID, engineFingerprint: engineFingerprintOf(T) },
      checkpointOf: (symbol) => ({ lineageId: lineageOf(symbol), symbol, chartInterval: "15m", marketType: "USDM_PERPETUAL" }),
    });
    const logs: Record<string, string> = Object.fromEntries(symbols.map((s) => [s, logOf([commit(bar(0), "QUARANTINED_CURRENT_BAR", lineageOf(s), s)])]));
    const store = new Map<string, unknown>();
    let failAfter: number | null = null;
    let saves = 0;
    const cursors = {
      load: (s: string) => (store.get(s) ?? null) as never,
      save: (c: { symbol: string }) => {
        if (failAfter !== null && saves >= failAfter) throw new Error("injected process death after the ledger commit, before the cursor write");
        saves += 1;
        store.set(c.symbol, c);
      },
    };
    const ledger = new PrismaNativeDeliveryLedger(prisma);
    const make = (activateAtEof: boolean) =>
      new MultiSymbolNativeEmitter({
        mode: "COMMIT_DASHBOARD_ALERTS",
        run,
        readLog: (s) => logs[s] ?? null,
        cursors,
        cursorWriter: cursors,
        ledger,
        baseline: "PRODUCTION_CURSOR",
        activateAtEof,
        queueCapacity: 10,
        pendingTailPolls: 0,
        nowIso: () => "2026-10-23T00:00:00.000Z",
        report: () => undefined,
      });
    const once = (emitter: InstanceType<typeof MultiSymbolNativeEmitter>) => runMultiSymbolEmitter(emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });

    await once(make(true)); // activation at EOF: nothing delivered
    const activated = new Map(store);
    for (const s of symbols) logs[s] += logOf(backlog(s, 5)); // 2 x 20 records (3x+ the queue), 30 deliveries
    const alerts = () => prisma.alert.count({ where: { symbol: { in: symbols } } });
    const deliveries = () => prisma.nativeAlertDelivery.count({ where: { symbol: { in: symbols } } });

    failAfter = saves + 7;
    await expect(once(make(false))).rejects.toThrow(/process death/);
    const afterCrash = await alerts();
    expect(afterCrash).toBeGreaterThan(0);
    expect(afterCrash).toBeLessThan(30);

    failAfter = null;
    const restart = make(false);
    await once(restart);
    expect(await alerts()).toBe(30);
    expect(await deliveries()).toBe(30);
    const keys = await prisma.nativeAlertDelivery.findMany({ where: { symbol: { in: symbols } }, select: { deliveryKey: true } });
    expect(new Set(keys.map((k) => k.deliveryKey)).size).toBe(30);
    const s = restart.status();
    expect(s.created).toBe(30 - afterCrash);
    expect(s.ledgerDuplicates).toBeGreaterThanOrEqual(1);
    expect(s.maxQueueDepth).toBeLessThanOrEqual(10);

    // A full replay from the activation cursors (a lost cursor file) still creates nothing new.
    store.clear();
    for (const [key, value] of activated) store.set(key, value);
    const replay = make(false);
    await once(replay);
    expect(replay.status()).toMatchObject({ created: 0, ledgerDuplicates: 30 });
    expect(await alerts()).toBe(30);
  });
});
