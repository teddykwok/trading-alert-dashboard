import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { DynamicLeveragePlan, SourceTimeframe } from "@trading-alert-dashboard/shared";

import { connectTestDatabase } from "./helpers/test-database";
import { BAR0, M15, bar, commit, logOf, observation } from "./helpers/native-alert-fixtures";

/**
 * Teddy Aggressive delivery and the execution fences, against the TEST
 * database only.
 *
 *  - NATIVE_DELIVERY_V2 writes one Alert per (bar, source TF) slot through the
 *    same ledger table and unique key — no migration.
 *  - V2 never re-delivers a canonical shadow event a V1 row already delivered,
 *    and never recreates a deleted Alert. V1 rows are never touched.
 *  - The future execution policy (1D/1W) changes nothing: a NATIVE alert of
 *    ANY source timeframe, under EVERY profile (Teddy Aggressive and Teddy 7%
 *    All Active), is refused by the planner, adoption, execution creation and
 *    queue recovery, exactly as before.
 *
 * No Binance client is imported and no exchange request is made.
 */

const TAG = "native-profile-it";
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient = testDatabase;
const maybe = () => (available ? it : it.skip);

const { PrismaNativeDeliveryLedger } = await import("../src/modules/native-alerts/native-alert-ledger");
const { selectNativeDeliveries } = await import("../src/modules/native-alerts/native-delivery-policy");
const { selectNativeDeliveriesV2, ineligibilityOfV2 } = await import("../src/modules/native-alerts/native-delivery-policy-v2");
const { parseShadowEventLog } = await import("../src/modules/native-alerts/shadow-log-reader");
const { SCANNER_PROFILES, TEDDY_7_ALL_ACTIVE_V1, TEDDY_AGGRESSIVE_V1, profileSummaryOf } = await import("../src/modules/native-scanner/scanner-profile");
const { NativeAlertExecutionForbiddenError } = await import("../src/modules/alerts/alert-source");
const { ExtremeRRService } = await import("../src/modules/extreme-rr/extreme-rr.service");
const { SelectedPlanAdoptionService } = await import("../src/modules/jobs/selected-plan-adoption.service");
const { ExecutionService } = await import("../src/modules/execution/execution.service");
const { runAlertQueueRecoverySweep } = await import("../src/modules/jobs/alert-queue-recovery.service");
const { resetRecoverySweepGuardForTests } = await import("../src/modules/jobs/alert-queue-recovery.scheduler");
const { auditNativeAlert } = await import("../src/modules/native-audit/native-alert-audit");
const { lineageConfigOf } = await import("../src/modules/native-scanner/scanner-profile");

const T = TEDDY_AGGRESSIVE_V1;
const CONTEXT = { profile: profileSummaryOf(T), runId: "20261001T110000Z-1a2b3c4d" };
const LINEAGE = "3".repeat(64);
let sequence = 0;
const nextSymbol = () => `NPROF${++sequence}${Date.now() % 100000}USDT`;
const identity = (symbol: string) => ({ lineageId: LINEAGE, marketType: "USDM_PERPETUAL" as const, symbol, chartInterval: "15m" as const });

/** 1D, 1W and 1M live on one bar (and a 3M), then its commit. */
function sameBarLog(symbol: string) {
  return logOf([
    observation({ symbol, lineageId: LINEAGE, barMs: bar(1), sourceTf: "1D", levelPrice: 0.81, candidateSequence: 0, updateSequence: 2 }),
    observation({ symbol, lineageId: LINEAGE, barMs: bar(1), sourceTf: "1W", levelPrice: 0.79, candidateSequence: 1, updateSequence: 3, createdBarOpenTimeMs: BAR0 - 7 * 96 * M15 }),
    observation({ symbol, lineageId: LINEAGE, barMs: bar(1), sourceTf: "1M", levelPrice: 0.9, candidateSequence: 2, updateSequence: 4, createdBarOpenTimeMs: BAR0 - 30 * 96 * M15 }),
    observation({ symbol, lineageId: LINEAGE, barMs: bar(1), sourceTf: "3M", levelPrice: 0.95, candidateSequence: 3, updateSequence: 5, createdBarOpenTimeMs: BAR0 - 90 * 96 * M15 }),
    commit(bar(1), "SHADOW_LIVE_ONLY", LINEAGE, symbol),
  ]);
}

function v2Decisions(symbol: string) {
  return selectNativeDeliveriesV2(parseShadowEventLog(sameBarLog(symbol), identity(symbol)), T.delivery).flatMap((s) => (s.kind === "DELIVER" ? [s.decision] : []));
}

async function cleanup(): Promise<void> {
  if (!available) return;
  const strays = (await prisma.tradeExecution.findMany({ where: { executionProfile: { accountIdentifier: { startsWith: TAG } } }, select: { id: true } })).map((r) => r.id);
  if (strays.length > 0) {
    await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: strays } } });
    await prisma.tradeExecution.deleteMany({ where: { id: { in: strays } } });
  }
  await prisma.selectedPlanAdoption.deleteMany({ where: { executionProfile: { accountIdentifier: { startsWith: TAG } } } });
  await prisma.nativeAlertDelivery.deleteMany({ where: { symbol: { startsWith: "NPROF" } } });
  await prisma.alert.deleteMany({ where: { symbol: { startsWith: "NPROF" } } });
  await prisma.asset.deleteMany({ where: { symbol: { startsWith: "NPROF" } } });
  await prisma.executionProfile.deleteMany({ where: { accountIdentifier: { startsWith: TAG } } });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("NATIVE_DELIVERY_V2 through the real ledger (no migration)", () => {
  maybe()("one Alert per source-TF slot on the same bar (1D, 1W, 1M); 3M is never delivered; a replay creates nothing", async () => {
    const symbol = nextSymbol();
    const ledger = new PrismaNativeDeliveryLedger(prisma);
    const decisions = v2Decisions(symbol);
    expect(decisions.map((d) => d.winner.sourceTf)).toEqual(["1D", "1W", "1M"]);
    for (const d of decisions) expect((await ledger.deliverV2(d, CONTEXT)).outcome).toBe("CREATED");
    for (const d of decisions) expect((await ledger.deliverV2(d, CONTEXT)).outcome).toBe("ALREADY_DELIVERED");
    const alerts = await prisma.alert.findMany({ where: { symbol }, orderBy: { sourceTimeframe: "asc" } });
    expect(alerts.map((a) => a.sourceTimeframe).sort()).toEqual(["1D", "1M", "1W"]);
    for (const a of alerts) {
      expect(a).toMatchObject({ source: "NATIVE", exchange: "BINANCE", assetType: "CRYPTO", timeframe: "15m", status: "RECEIVED", eventType: "LEVEL_TOUCHED" });
      const payload = a.rawPayload as { actionable: boolean; delivery: { policyVersion: string }; profile: { profileId: string; nativeExecutionEnabled: boolean } };
      expect([payload.actionable, payload.delivery.policyVersion, payload.profile.profileId, payload.profile.nativeExecutionEnabled]).toEqual([false, "NATIVE_DELIVERY_V2", "TEDDY_AGGRESSIVE_V1", false]);
    }
    const rows = await prisma.nativeAlertDelivery.findMany({ where: { symbol } });
    expect(rows.map((r) => [r.policyVersion, r.deliveryKeySchema])).toEqual(Array(3).fill(["NATIVE_DELIVERY_V2", "teddy.native-alerts.delivery-key.v2"]));
  });

  maybe()("V2 never re-delivers an event a V1 row already delivered, and V1 rows are left byte-identical and still auditable as V1", async () => {
    const symbol = nextSymbol();
    const ledger = new PrismaNativeDeliveryLedger(prisma);
    const records = parseShadowEventLog(sameBarLog(symbol), identity(symbol));
    const v1 = selectNativeDeliveries(records).flatMap((s) => (s.kind === "DELIVER" ? [s.decision] : []));
    expect(v1.map((d) => d.winner.sourceTf)).toEqual(["1D"]);
    expect((await ledger.deliver(v1[0])).outcome).toBe("CREATED");
    const v1Before = await prisma.nativeAlertDelivery.findMany({ where: { symbol } });

    const results = await Promise.all(v2Decisions(symbol).map((d) => ledger.deliverV2(d, CONTEXT)));
    expect(results.map((r) => r.outcome)).toEqual(["ALREADY_DELIVERED_UNDER_OTHER_POLICY", "CREATED", "CREATED"]);
    expect(await prisma.alert.count({ where: { symbol, sourceTimeframe: "1D" } })).toBe(1);
    // The V1 row is unchanged, and still adoptable by V1 with identical provenance.
    const v1After = await prisma.nativeAlertDelivery.findMany({ where: { symbol, policyVersion: "NATIVE_DELIVERY_V1" } });
    expect(v1After).toEqual(v1Before);
    expect((await ledger.deliver(v1[0])).outcome).toBe("ALREADY_DELIVERED");
    expect(await ledger.lookup(v1[0])).toMatchObject({ state: "DELIVERED" });
  });

  maybe()("a deleted Alert is never recreated: neither by V2 replay of its own key, nor by V2 over a deleted V1 delivery", async () => {
    const symbol = nextSymbol();
    const ledger = new PrismaNativeDeliveryLedger(prisma);
    const [d1, d1w] = v2Decisions(symbol);
    const created = await ledger.deliverV2(d1, CONTEXT);
    await prisma.alert.delete({ where: { id: created.alertId as string } }); // retention's effect: the ledger row survives with alertId null
    expect((await ledger.deliverV2(d1, CONTEXT)).outcome).toBe("ALREADY_DELIVERED_ALERT_REMOVED");

    const symbol2 = nextSymbol();
    const records = parseShadowEventLog(sameBarLog(symbol2), identity(symbol2));
    const [v1] = selectNativeDeliveries(records).flatMap((s) => (s.kind === "DELIVER" ? [s.decision] : []));
    const v1Created = await ledger.deliver(v1);
    await prisma.alert.delete({ where: { id: v1Created.alertId as string } });
    const [v2For1D] = v2Decisions(symbol2);
    expect((await ledger.deliverV2(v2For1D, CONTEXT)).outcome).toBe("ALREADY_DELIVERED_UNDER_OTHER_POLICY");
    expect(await prisma.alert.count({ where: { symbol: { in: [symbol, symbol2] }, sourceTimeframe: "1D" } })).toBe(0);
    expect(d1w.winner.sourceTf).toBe("1W");
  });

  maybe()("the V1 audit reports a V2 row as not auditable by it, instead of judging it by V1's rules", async () => {
    const symbol = nextSymbol();
    const [d] = v2Decisions(symbol);
    const created = await new PrismaNativeDeliveryLedger(prisma).deliverV2(d, CONTEXT);
    const report = await auditNativeAlert(prisma, {
      alertId: created.alertId as string,
      lineage: lineageConfigOf(T.engine),
      readShadowLog: () => null,
      readCheckpointLineage: () => null,
      loadKlines: () => null,
    });
    expect(report.overall).toBe("FAIL");
    expect(report.ledger.verdict).toBe("FAIL");
    expect(JSON.stringify(report.ledger)).toMatch(/NATIVE_DELIVERY_V2 is not auditable by the NATIVE_DELIVERY_V1 audit/);
  });
});

// ===========================================================================
// The execution fences, per source timeframe
// ===========================================================================

async function nativeAlert(symbol: string, sourceTimeframe: SourceTimeframe, triggeredAt = new Date(Date.now() - 30_000), profileId = "TEDDY_AGGRESSIVE_V1") {
  return prisma.alert.create({
    data: {
      symbol, assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 100, signal: "LONG", indicatorName: "Native Level Scanner",
      rawPayload: { source: "NATIVE", profile: { profileId, futureExecutionSourceTimeframes: ["1D", "1W"], nativeExecutionEnabled: false } },
      triggeredAt, source: "NATIVE", sourceTimeframe, eventType: "LEVEL_TOUCHED",
    },
  });
}

async function forcedReadyPlan(alertId: string, cutoffAt: Date) {
  return prisma.extremeRRPlan.create({
    data: { alertId, status: "READY", direction: "LONG", entryPrice: "100", cutoffAt, timeframe: "15m", selectedLookback: 300, generatedAt: cutoffAt, executionFanoutReadyAt: cutoffAt },
  });
}

async function profile(alias: string) {
  sequence += 1;
  return prisma.executionProfile.create({ data: { name: `${TAG} ${alias} ${sequence}`, accountIdentifier: `${TAG}-${alias}-${sequence}`, environment: "TESTNET", isEnabled: true } });
}

function readyMarginPlan(symbol: string): DynamicLeveragePlan {
  return {
    status: "READY", reason: null, reasonMessage: null, symbol, direction: "LONG", entryPrice: "100", stopLoss: "96", calculatedStopLoss: "96", executableStopLoss: "96",
    stopAdjustment: "0", stopNormalization: null, stopLossSource: "CALCULATED", stopDistance: "4", riskBudgetUsd: "1.50", quantityRaw: "0.250", roundedQuantity: "0.250",
    quantityStepSize: "0.001", actualPlannedLoss: "1.0", unusedRiskBudget: "0", positionNotional: "25", minimumNotional: "5", targetMarginMultiplier: "2.5",
    maximumMarginMultiplier: "3.333333", targetIsolatedMargin: "2.50", maximumIsolatedMargin: "5.00", applicableBracket: null, maximumSupportedLeverage: 50,
    binanceMaximumSupportedLeverage: 50, userMaximumAutomationLeverage: 25, usableMaximumLeverage: 25, selectedLeverage: 10, estimatedInitialMargin: "2.50",
    estimatedLiquidationPrice: "90.1", requiredLiquidationBoundary: "94", liquidationBufferRatio: "0.5", liquidationDistance: "5.9", safetyBufferDistance: "2",
    marginDifferenceFromTarget: "0", candidates: [], warnings: [],
  } as unknown as DynamicLeveragePlan;
}

describe("execution stays hard-fenced for NATIVE alerts of every source timeframe", () => {
  beforeEach(() => resetRecoverySweepGuardForTests());

  it("every registered profile is in this matrix, and none can enable native execution", () => {
    expect(Object.values(SCANNER_PROFILES).map((p) => p.profileId).sort()).toEqual(["TEDDY_7_ALL_ACTIVE_V1", "TEDDY_AGGRESSIVE_V1"]);
    for (const p of Object.values(SCANNER_PROFILES)) expect(p.execution.nativeExecutionEnabled).toBe(false);
  });

  for (const p of [T, TEDDY_7_ALL_ACTIVE_V1]) {
    it.each([
      ["1D", true],
      ["1W", true],
      ["1M", true],
      ["3M", false],
      ["6M", false],
      ["12M", false],
    ] as const)(`%s: dashboard-deliverable=%s under ${p.label} — decided by the DeliveryPolicy alone`, (tf, deliverable) => {
      const record = parseShadowEventLog(logOf([observation({ symbol: "LDOUSDT", lineageId: LINEAGE, sourceTf: tf })]), identity("LDOUSDT"))[0];
      expect(ineligibilityOfV2(record, p.delivery) === null).toBe(deliverable);
      // The future execution policy is modelling only: it lists 1D/1W and enables nothing.
      expect(p.execution.nativeExecutionEnabled).toBe(false);
    });
  }

  for (const [profileId, tf] of [T.profileId, TEDDY_7_ALL_ACTIVE_V1.profileId].flatMap((id) => (["1D", "1W", "1M", "3M", "6M", "12M"] as const).map((t) => [id, t] as const))) {
    maybe()(`${profileId} Native ${tf}: planner, adoption, execution creation and queue recovery all refuse it`, async () => {
      const symbol = nextSymbol();
      const alert = await nativeAlert(symbol, tf, undefined, profileId);
      // Planner: refused before any candle fetch.
      const fetchCandles = vi.fn(async () => {
        throw new Error("a Binance kline fetch was attempted for a NATIVE alert");
      });
      const planner = new ExtremeRRService(prisma, fetchCandles, async () => 300 as const);
      await expect(planner.ensurePendingPlan(alert)).rejects.toBeInstanceOf(NativeAlertExecutionForbiddenError);
      expect(fetchCandles).not.toHaveBeenCalled();
      // Execution creation: refused before any write.
      const p = await profile(`exec-${tf}`);
      await expect(
        new ExecutionService(prisma).createExecutionFromReadyPlan({ executionProfileId: p.id, alertId: alert.id, plan: readyMarginPlan(symbol), positionSide: "LONG", selectedLookback: 300 })
      ).rejects.toBeInstanceOf(NativeAlertExecutionForbiddenError);
      expect(await prisma.tradeExecution.count({ where: { alertId: alert.id } })).toBe(0);
      // Adoption: even a forced READY plan is never discovered, so the signed-read executor is never called.
      const plan = await forcedReadyPlan(alert.id, alert.triggeredAt);
      const executor = { handleSelectedPlan: vi.fn(async () => ({ handled: false, reasonCode: "MARGIN_PLAN_NOT_READY", message: "stub" })) };
      const adoption = new SelectedPlanAdoptionService({
        prisma,
        boundProfile: { executionProfileId: (await profile(`adopt-${tf}`)).id, exchange: "BINANCE", product: "USDM_FUTURES", environment: "TESTNET" },
        executor: executor as never,
        plans: new ExtremeRRService(prisma),
        workerId: `native-profile-fence-${tf}`,
      });
      await adoption.runOnce(500);
      expect(executor.handleSelectedPlan.mock.calls.some((call) => (call as unknown[])[1] === symbol)).toBe(false);
      expect(await prisma.selectedPlanAdoption.count({ where: { extremeRRPlanId: plan.id } })).toBe(0);
      // Queue recovery: never re-queued.
      const old = new Date(Date.now() - 10 * 60_000);
      await prisma.alert.update({ where: { id: alert.id }, data: { createdAt: old } });
      const added: string[] = [];
      await runAlertQueueRecoverySweep(prisma, { getJob: async () => null, add: async (id: string) => void added.push(id) }, { batchSize: 10_000 });
      expect(added).not.toContain(alert.id);
    });
  }
});
