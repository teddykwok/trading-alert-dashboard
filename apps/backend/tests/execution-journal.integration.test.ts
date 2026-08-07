import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * Phase 8 execution-journal tests against a real Postgres.
 *
 * Everything is synthetic and removed in afterAll. No Binance connector and no
 * mutation client is imported anywhere in this file or in the code under test,
 * so nothing here can reach an exchange.
 */

const TAG = "phase8-synthetic";
const SYMBOL = "TESTJUSDT";

// Integration state lives in the DEDICATED test database. The helper refuses
// to fall back to the runtime/canary database, so a misconfiguration fails the
// suite instead of quietly writing synthetic executions into runtime state.
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ExecutionJournalService, deriveNetPnl, MAX_PAGE_SIZE } = await import(
  "../src/modules/execution/execution-journal.service"
);
const { NotFoundError } = await import("../src/utils/errors");

type JournalService = InstanceType<typeof ExecutionJournalService>;

let journal: JournalService;
let profileId = "";
let secondProfileId = "";
const created: Record<string, string> = {};
let sequence = 0;

/** A planned execution with everything frozen and nothing actual yet. */
async function synthetic(options: {
  key: string;
  status?: string;
  direction?: "LONG" | "SHORT";
  withAlert?: boolean;
  actual?: Record<string, unknown>;
  protection?: Record<string, unknown> | null;
  profile?: string;
  manual?: boolean;
}) {
  sequence += 1;
  let alertId: string | null = null;
  if (options.withAlert !== false) {
    const alert = await prisma!.alert.create({
      data: {
        symbol: SYMBOL,
        assetType: "CRYPTO",
        exchange: "SYNTHETIC",
        timeframe: "15m",
        price: 100,
        signal: options.direction ?? "LONG",
        indicatorName: `${TAG}-${sequence}`,
        rawPayload: { note: TAG },
        triggeredAt: new Date(Date.now() - 60_000),
      },
    });
    alertId = alert.id;
  }

  const direction = options.direction ?? "LONG";
  const execution = await prisma!.tradeExecution.create({
    data: {
      executionProfileId: options.profile ?? profileId,
      alertId,
      symbol: SYMBOL,
      direction,
      positionSide: direction,
      selectedLookback: 200,
      signalTriggeredAt: new Date(Date.now() - 60_000),
      status: (options.status ?? "PLAN_READY") as never,
      requiresManualIntervention: options.manual ?? false,
      plannedEntryPrice: "100",
      calculatedStopLoss: "96",
      executableStopLoss: "96",
      takeProfit: "108",
      riskBudgetUsd: "1.50",
      quantityRaw: "0.375",
      plannedQuantity: "0.375",
      quantityStepSize: "0.001",
      actualPlannedLoss: "1.5",
      unusedRiskBudget: "0",
      positionNotional: "37.5",
      targetIsolatedMargin: "3.75",
      maximumIsolatedMargin: "5.00",
      selectedLeverage: 10,
      estimatedInitialMargin: "3.75",
      estimatedLiquidationPrice: "90.1",
      requiredLiquidationBoundary: "94",
      liquidationBufferRatio: "0.5",
      decisionReasonCode: "SYNTHETIC",
      ...(options.actual ?? {}),
    },
  });

  if (options.protection !== null) {
    await prisma!.executionProtectionState.create({
      data: {
        tradeExecutionId: execution.id,
        state: "UNPROTECTED",
        ...(options.protection ?? {}),
      } as never,
    });
  }

  created[options.key] = execution.id;
  return execution;
}

beforeAll(async () => {
  if (!prisma || !available) return;
  journal = new ExecutionJournalService(prisma);

  const profile = await prisma.executionProfile.create({
    data: { name: "Phase 8 profile", accountIdentifier: `${TAG}-account`, environment: "TESTNET", isEnabled: true },
  });
  profileId = profile.id;
  const second = await prisma.executionProfile.create({
    data: { name: "Phase 8 mainnet", accountIdentifier: `${TAG}-account-b`, environment: "MAINNET", isEnabled: false },
  });
  secondProfileId = second.id;

  // 1. PLAN_READY with no actuals.
  await synthetic({ key: "planReady" });
  // 2. SKIPPED with a safety decision.
  const skipped = await synthetic({ key: "skipped", status: "SKIPPED" });
  await prisma.safetyAdmission.create({
    data: {
      tradeExecutionId: skipped.id,
      evaluatedVersion: 1,
      evaluatedAt: new Date(),
      decision: "SKIP",
      reasonCode: "GLOBAL_KILL_SWITCH_ACTIVE",
      message: "Global execution kill switch is active.",
      signalAgeSeconds: 12,
      effectiveLimits: { maxTotalActiveTrades: 1, apiKey: "should-be-redacted" },
      capacityBefore: { totalActiveCount: 0 },
      capacityProjected: { totalActiveCount: 1 },
    },
  });
  // 3. ENTRY_PENDING.
  await synthetic({ key: "entryPending", status: "ENTRY_PENDING" });
  // 4. PARTIALLY_FILLED with protection.
  const partial = await synthetic({
    key: "partial",
    status: "PARTIALLY_FILLED",
    actual: { filledQuantity: "0.100", averageFillPrice: "99.98" },
    protection: { state: "PROTECTED", confirmedOpenQuantity: "0.100", protectedStopQuantity: "0.100", protectedTakeProfitQuantity: "0.100", currentGeneration: 1, liquidationSafe: true },
  });
  for (const [role, generation, type] of [
    ["STOP_LOSS", 1, "STOP_MARKET"],
    ["TAKE_PROFIT", 1, "TAKE_PROFIT_MARKET"],
    ["STOP_LOSS", 2, "STOP_MARKET"],
    ["TAKE_PROFIT", 2, "TAKE_PROFIT_MARKET"],
  ] as const) {
    await prisma.binanceOrder.create({
      data: {
        tradeExecutionId: partial.id,
        role,
        generation,
        clientOrderId: `${TAG}-${partial.id}-${role}-${generation}`,
        clientAlgoId: `${TAG}-${partial.id}-${role}-${generation}`,
        side: "SELL",
        positionSide: "LONG",
        orderType: type,
        originalQuantity: generation === 1 ? "0.100" : "0.150",
        triggerPrice: role === "STOP_LOSS" ? "96" : "108",
        workingType: role === "STOP_LOSS" ? "MARK_PRICE" : "CONTRACT_PRICE",
        priceProtect: false,
        status: "NEW",
        algoStatus: "NEW",
      },
    });
  }
  await prisma.binanceOrder.create({
    data: {
      tradeExecutionId: partial.id,
      role: "ENTRY",
      generation: 1,
      clientOrderId: `${TAG}-${partial.id}-ENTRY-1`,
      side: "BUY",
      positionSide: "LONG",
      orderType: "LIMIT",
      timeInForce: "GTC",
      price: "100",
      originalQuantity: "0.375",
      executedQuantity: "0.100",
      averageFillPrice: "99.98",
      status: "PARTIALLY_FILLED",
    },
  });
  await prisma.executionEvent.createMany({
    data: [
      { tradeExecutionId: partial.id, sequenceNumber: 1, eventType: "EXECUTION_CREATED", toStatus: "PLAN_READY", message: "created" },
      // Same createdAt as #3 on purpose: sequenceNumber must decide the order.
      { tradeExecutionId: partial.id, sequenceNumber: 2, eventType: "DECISION_RECORDED", fromStatus: "PLAN_READY", toStatus: "PREFLIGHT", createdAt: new Date("2026-01-01T00:00:00.000Z") },
      { tradeExecutionId: partial.id, sequenceNumber: 3, eventType: "ORDER_RESERVED", fromStatus: "PREFLIGHT", toStatus: "ENTRY_SUBMITTING", createdAt: new Date("2026-01-01T00:00:00.000Z"), metadata: { clientOrderId: "tad-en-1-abc", apiSecret: "super-secret-value", nested: { signature: "deadbeef" } } },
      { tradeExecutionId: partial.id, sequenceNumber: 4, eventType: "MANUAL_INTERVENTION_REQUIRED", fromStatus: "MANUAL_INTERVENTION", toStatus: "MANUAL_INTERVENTION", message: "same-status event" },
    ],
  });

  // 5. Fully PROTECTED.
  await synthetic({
    key: "protected",
    status: "PROTECTED",
    actual: { filledQuantity: "0.375", averageFillPrice: "100", actualLeverage: 10, actualIsolatedMargin: "3.75" },
    protection: { state: "PROTECTED", confirmedOpenQuantity: "0.375", protectedStopQuantity: "0.375", protectedTakeProfitQuantity: "0.375", currentGeneration: 1, liquidationSafe: true },
  });
  // 6. MANUAL_INTERVENTION.
  const manual = await synthetic({
    key: "manual",
    status: "MANUAL_INTERVENTION",
    manual: true,
    protection: { state: "PROTECTION_INCOMPLETE" },
  });
  await prisma.criticalAlert.create({
    data: {
      tradeExecutionId: manual.id,
      alertType: "STOP_NOT_VERIFIED",
      reasonCode: "STOP_NOT_VERIFIED",
      dedupeKey: `${TAG}-dedupe-1`,
      message: "CRITICAL: STOP_NOT_VERIFIED",
      details: { symbol: SYMBOL, requiredAction: "Place the stop manually." },
      status: "PENDING",
    },
  });
  await prisma.marginAdjustmentIntent.create({
    data: {
      tradeExecutionId: manual.id,
      attempt: 1,
      symbol: SYMBOL,
      positionSide: "LONG",
      amount: "1.25",
      baselineIsolatedMargin: "3.75",
      status: "RESULT_UNKNOWN",
      reasonCode: "MARGIN_TOP_UP_RESULT_UNKNOWN",
    },
  });

  // 7. CLOSED_TP with complete financials.
  await synthetic({
    key: "closedTp",
    status: "CLOSED_TP",
    actual: {
      filledQuantity: "0.375", averageFillPrice: "100", actualExitPrice: "108",
      realizedPnl: "3.00", tradingFeesUsd: "0.12", fundingPnlUsd: "-0.03",
      exitReason: "TAKE_PROFIT", closedAt: new Date(),
    },
    protection: { state: "CLOSED" },
  });
  // 8. CLOSED_SL with unknown fees/funding.
  await synthetic({
    key: "closedSl",
    status: "CLOSED_SL",
    actual: { filledQuantity: "0.375", realizedPnl: "-1.50", exitReason: "STOP_LOSS", closedAt: new Date() },
    protection: { state: "CLOSED" },
  });
  // 9. CLOSED_EMERGENCY.
  await synthetic({ key: "closedEmergency", status: "CLOSED_EMERGENCY", actual: { exitReason: "EMERGENCY" }, protection: { state: "CLOSED" } });
  // 10. Retention-nulled alertId, and a second profile/environment.
  await synthetic({ key: "retained", status: "CLOSED_TP", withAlert: false, profile: secondProfileId });
  // A SHORT for the direction filter.
  await synthetic({ key: "short", direction: "SHORT", status: "ENTRY_PENDING" });
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    const ids = (
      await prisma.tradeExecution.findMany({
        where: { executionProfileId: { in: [profileId, secondProfileId] } },
        select: { id: true },
      })
    ).map((row) => row.id);
    if (ids.length > 0) {
      await prisma.criticalAlert.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.marginAdjustmentIntent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.executionProtectionState.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.safetyAdmission.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.binanceOrder.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.tradeExecution.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.executionProfile.deleteMany({ where: { accountIdentifier: { startsWith: `${TAG}-account` } } });
    await prisma.alert.deleteMany({ where: { indicatorName: { startsWith: TAG } } });
  }
  await prisma.$disconnect();
});

const maybe = () => (available ? it : it.skip);
const listMine = (filters = {}) => journal.listExecutions({ executionProfileId: profileId, ...filters });

// ===========================================================================

describe("net PnL derivation", () => {
  it("computes a net result only when every component is known", () => {
    expect(deriveNetPnl("10", "0.5", "-0.2")).toBe("9.3");
    expect(deriveNetPnl("10", "0", "0")).toBe("10");
  });

  it("returns null when any component is unknown", () => {
    expect(deriveNetPnl(null, "0.5", "-0.2")).toBeNull();
    expect(deriveNetPnl("10", null, "-0.2")).toBeNull();
    expect(deriveNetPnl("10", "0.5", null)).toBeNull();
  });

  it("never treats an unknown fee as zero", () => {
    // If unknown fees were silently 0 this would return "10".
    expect(deriveNetPnl("10", null, "0")).toBeNull();
  });
});

describe("list endpoint", () => {
  maybe()("returns summaries only, with no timeline", async () => {
    const result = await listMine();
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item).not.toHaveProperty("events");
      expect(item).not.toHaveProperty("timeline");
      expect(item).not.toHaveProperty("planned");
    }
  });

  maybe()("orders by most recently updated, with id as a stable tiebreak", async () => {
    const result = await listMine({ pageSize: 50 });
    const keys = result.items.map((item) => `${item.updatedAt}|${item.id}`);
    expect([...keys].sort().reverse()).toEqual(keys);
  });

  maybe()("paginates", async () => {
    const first = await listMine({ page: 1, pageSize: 2 });
    const second = await listMine({ page: 2, pageSize: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(second.items[0].id).not.toBe(first.items[0].id);
    expect(first.total).toBe(second.total);
  });

  maybe()("bounds the page size", async () => {
    const result = await journal.listExecutions({ executionProfileId: profileId, pageSize: 5000 });
    expect(result.pageSize).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });

  maybe()("filters by symbol, direction, status and manual intervention", async () => {
    expect((await listMine({ symbol: SYMBOL })).items.length).toBeGreaterThan(0);
    expect((await listMine({ symbol: "NOSUCHUSDT" })).items).toHaveLength(0);

    const shorts = await listMine({ direction: "SHORT" });
    expect(shorts.items.every((item) => item.direction === "SHORT")).toBe(true);
    expect(shorts.items.length).toBe(1);

    const skipped = await listMine({ status: ["SKIPPED"] });
    expect(skipped.items.every((item) => item.status === "SKIPPED")).toBe(true);

    const manual = await listMine({ requiresManualIntervention: true });
    expect(manual.items.every((item) => item.requiresManualIntervention)).toBe(true);
    expect(manual.items.length).toBe(1);
  });

  maybe()("filters by protection state and profile", async () => {
    const protectedOnly = await listMine({ protectionState: ["PROTECTED"] });
    expect(protectedOnly.items.every((item) => item.protectionState === "PROTECTED")).toBe(true);
    expect(protectedOnly.items.length).toBeGreaterThanOrEqual(2);

    const other = await journal.listExecutions({ executionProfileId: secondProfileId });
    expect(other.items.every((item) => item.profile.id === secondProfileId)).toBe(true);
  });

  maybe()("filters by environment and date range", async () => {
    const mainnet = await journal.listExecutions({ environment: "MAINNET", executionProfileId: secondProfileId });
    expect(mainnet.items.every((item) => item.profile.environment === "MAINNET")).toBe(true);

    const future = await listMine({ createdFrom: new Date(Date.now() + 86_400_000) });
    expect(future.items).toHaveLength(0);
    const past = await listMine({ createdFrom: new Date(Date.now() - 86_400_000) });
    expect(past.items.length).toBeGreaterThan(0);
  });

  maybe()("filters active versus closed", async () => {
    const closed = await listMine({ lifecycle: "closed" });
    expect(closed.items.every((item) => ["CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY", "SKIPPED"].includes(item.status))).toBe(true);

    const active = await listMine({ lifecycle: "active" });
    expect(active.items.every((item) => !["CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY", "SKIPPED", "FAILED", "CANCELED", "ENTRY_EXPIRED"].includes(item.status))).toBe(true);
  });

  maybe()("returns exact decimal strings and preserves null", async () => {
    const result = await listMine({ pageSize: 50 });
    const planReady = result.items.find((item) => item.id === created.planReady)!;
    expect(typeof planReady.plannedEntryPrice).toBe("string");
    expect(planReady.plannedEntryPrice).toBe("100");
    // No actuals yet — these stay null and are NOT zeroed.
    expect(planReady.averageFillPrice).toBeNull();
    expect(planReady.filledQuantity).toBeNull();
    expect(planReady.actualLeverage).toBeNull();
    expect(planReady.realizedPnl).toBeNull();
  });

  maybe()("exposes profile name and environment but never the account identifier", async () => {
    const result = await listMine({ pageSize: 50 });
    const serialized = JSON.stringify(result);
    expect(result.items[0].profile.name).toBe("Phase 8 profile");
    expect(serialized).not.toContain("accountIdentifier");
    expect(serialized).not.toContain(`${TAG}-account`);
  });
});

describe("summary metrics", () => {
  maybe()("sums only known realized PnL and states how many are unknown", async () => {
    const metrics = await journal.getExecutionSummaryMetrics({ executionProfileId: profileId });
    // closedTp 3.00 + closedSl -1.50 = 1.50; closedEmergency and skipped are unknown.
    expect(metrics.knownRealizedPnl).toBe("1.5");
    expect(metrics.closedWithKnownPnl).toBe(2);
    expect(metrics.closedWithUnknownPnl).toBeGreaterThan(0);
  });

  maybe()("counts protected, manual-intervention and closed executions", async () => {
    const metrics = await journal.getExecutionSummaryMetrics({ executionProfileId: profileId });
    expect(metrics.protectedCount).toBeGreaterThanOrEqual(2);
    expect(metrics.manualInterventionCount).toBe(1);
    expect(metrics.closedCount).toBeGreaterThanOrEqual(4);
  });
});

describe("detail endpoint", () => {
  maybe()("returns the complete frozen plan with exact strings", async () => {
    const detail = await journal.getExecutionDetail(created.planReady);
    expect(detail.planned.entryPrice).toBe("100");
    expect(detail.planned.executableStopLoss).toBe("96");
    expect(detail.planned.riskBudgetUsd).toBe("1.5");
    expect(detail.planned.maximumIsolatedMargin).toBe("5");
    expect(detail.planned.selectedLeverage).toBe(10);
    expect(typeof detail.planned.positionNotional).toBe("string");
  });

  maybe()("leaves every unknown actual null", async () => {
    const detail = await journal.getExecutionDetail(created.planReady);
    for (const value of Object.values(detail.actual)) {
      if (typeof value === "number") continue;
      expect(value).toBeNull();
    }
  });

  maybe()("derives net PnL only when fees and funding are known", async () => {
    const complete = await journal.getExecutionDetail(created.closedTp);
    expect(complete.actual.realizedPnl).toBe("3");
    expect(complete.actual.tradingFeesUsd).toBe("0.12");
    expect(complete.actual.fundingPnlUsd).toBe("-0.03");
    expect(complete.actual.netPnlUsd).toBe("2.85");

    const partial = await journal.getExecutionDetail(created.closedSl);
    expect(partial.actual.realizedPnl).toBe("-1.5");
    expect(partial.actual.tradingFeesUsd).toBeNull();
    expect(partial.actual.fundingPnlUsd).toBeNull();
    // No fake net result from partial data.
    expect(partial.actual.netPnlUsd).toBeNull();
  });

  maybe()("returns the entry order and every protection generation", async () => {
    const detail = await journal.getExecutionDetail(created.partial);
    expect(detail.entryOrder?.role).toBe("ENTRY");
    expect(detail.entryOrder?.executedQuantity).toBe("0.1");
    expect(detail.protectionOrders).toHaveLength(4);
    expect([...new Set(detail.protectionOrders.map((order) => order.generation))].sort()).toEqual([1, 2]);
    expect(detail.protectionOrders.every((order) => order.clientAlgoId !== null)).toBe(true);
  });

  maybe()("returns protection state with coverage gaps", async () => {
    const detail = await journal.getExecutionDetail(created.partial);
    expect(detail.protection?.state).toBe("PROTECTED");
    expect(detail.protection?.confirmedOpenQuantity).toBe("0.1");
    expect(detail.protection?.stopCoverageGap).toBe("0");
    expect(detail.protection?.liquidationSafe).toBe(true);
  });

  maybe()("returns safety admissions, margin intents and critical alerts", async () => {
    const skipped = await journal.getExecutionDetail(created.skipped);
    expect(skipped.safetyAdmissions).toHaveLength(1);
    expect(skipped.safetyAdmissions[0].decision).toBe("SKIP");
    expect(skipped.safetyAdmissions[0].reasonCode).toBe("GLOBAL_KILL_SWITCH_ACTIVE");

    const manual = await journal.getExecutionDetail(created.manual);
    expect(manual.marginAdjustments).toHaveLength(1);
    expect(manual.marginAdjustments[0].amount).toBe("1.25");
    expect(manual.criticalAlerts).toHaveLength(1);
    expect(manual.criticalAlerts[0].alertType).toBe("STOP_NOT_VERIFIED");
  });

  maybe()("still loads a retention-nulled execution", async () => {
    const detail = await journal.getExecutionDetail(created.retained);
    expect(detail.alertId).toBeNull();
    // It works entirely from the execution's own frozen data.
    expect(detail.planned.entryPrice).toBe("100");
    expect(detail.profile.environment).toBe("MAINNET");
  });

  maybe()("throws NotFound for an unknown id", async () => {
    await expect(journal.getExecutionDetail("no-such-execution")).rejects.toBeInstanceOf(NotFoundError);
  });

  maybe()("leaks no credentials, balances or raw payloads", async () => {
    const detail = await journal.getExecutionDetail(created.skipped);
    const serialized = JSON.stringify(detail).toLowerCase();
    for (const forbidden of [
      "apikey", "apisecret", "signature", "authorization", "x-mbx",
      "walletbalance", "availablebalance", "accountidentifier", "telegram",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  maybe()("emits no Prisma Decimal instances into JSON", async () => {
    const detail = await journal.getExecutionDetail(created.closedTp);
    const roundTripped = JSON.parse(JSON.stringify(detail));
    // A Prisma Decimal would serialize as an object with `d`/`e`/`s`.
    expect(typeof roundTripped.planned.entryPrice).toBe("string");
    expect(typeof roundTripped.actual.realizedPnl).toBe("string");
    expect(roundTripped.planned.entryPrice).not.toHaveProperty("d");
  });

  maybe()("returns ISO-8601 timestamps", async () => {
    const detail = await journal.getExecutionDetail(created.closedTp);
    expect(detail.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(detail.actual.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(detail.actual.firstFillAt).toBeNull();
  });
});

describe("execution for alert", () => {
  maybe()("returns the execution when one exists", async () => {
    const detail = await journal.getExecutionDetail(created.planReady);
    const byAlert = await journal.getExecutionForAlert(detail.alertId!);
    expect(byAlert?.id).toBe(created.planReady);
  });

  maybe()("returns null for an alert with no execution and creates nothing", async () => {
    const alert = await prisma!.alert.create({
      data: {
        symbol: SYMBOL, assetType: "CRYPTO", exchange: "SYNTHETIC", timeframe: "15m", price: 100,
        signal: "LONG", indicatorName: `${TAG}-orphan`, rawPayload: { note: TAG }, triggeredAt: new Date(),
      },
    });
    // Scoped to this suite's synthetic symbol: other suites share the database
    // and run in parallel, so a global count would measure their rows too.
    const scope = { where: { OR: [{ symbol: SYMBOL }, { alertId: alert.id }] } };
    const before = await prisma!.tradeExecution.count(scope);
    expect(await journal.getExecutionForAlert(alert.id)).toBeNull();
    // Opening the tab must never materialise an execution.
    expect(await prisma!.tradeExecution.count(scope)).toBe(before);
  });
});

describe("timeline", () => {
  maybe()("orders by sequenceNumber, not timestamp", async () => {
    const timeline = await journal.getExecutionTimeline(created.partial);
    expect(timeline.map((event) => event.sequenceNumber)).toEqual([1, 2, 3, 4]);
    // Events 2 and 3 share a createdAt, so only sequenceNumber can order them.
    expect(timeline[1].createdAt).toBe(timeline[2].createdAt);
    expect(timeline[1].eventType).toBe("DECISION_RECORDED");
    expect(timeline[2].eventType).toBe("ORDER_RESERVED");
  });

  maybe()("keeps same-status events visible", async () => {
    const timeline = await journal.getExecutionTimeline(created.partial);
    const sameStatus = timeline.find((event) => event.fromStatus === event.toStatus);
    expect(sameStatus).toBeDefined();
    expect(sameStatus!.eventType).toBe("MANUAL_INTERVENTION_REQUIRED");
  });

  maybe()("shows no duplicate sequence numbers", async () => {
    const timeline = await journal.getExecutionTimeline(created.partial);
    expect(new Set(timeline.map((event) => event.sequenceNumber)).size).toBe(timeline.length);
  });

  maybe()("redacts secret-like nested metadata keys", async () => {
    const timeline = await journal.getExecutionTimeline(created.partial);
    const withMetadata = timeline.find((event) => event.sequenceNumber === 3)!;
    const serialized = JSON.stringify(withMetadata.metadata);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("deadbeef");
    // The credential-like KEY is dropped at the DTO boundary, not just its value.
    expect(serialized.toLowerCase()).not.toContain("apisecret");
    expect(serialized.toLowerCase()).not.toContain("signature");
    // A harmless key survives.
    expect(serialized).toContain("tad-en-1-abc");
  });

  maybe()("returns an empty array rather than throwing for an execution with no events", async () => {
    const timeline = await journal.getExecutionTimeline(created.planReady);
    expect(Array.isArray(timeline)).toBe(true);
    expect(timeline).toHaveLength(0);
  });

  maybe()("throws NotFound for an unknown execution", async () => {
    await expect(journal.getExecutionTimeline("no-such-execution")).rejects.toBeInstanceOf(NotFoundError);
  });
});
