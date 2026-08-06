import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { DynamicLeveragePlan } from "@trading-alert-dashboard/shared";
import { ExecutionService, OptimisticLockError } from "../src/modules/execution/execution.service";

/**
 * Phase 4 integration tests against a real Postgres.
 *
 * Atomicity, optimistic locking, concurrency and unique constraints cannot be
 * proven with a mocked client, so these exercise the actual database. Every
 * row is synthetic (SYNTHETIC_TAG) and removed in afterAll; nothing here calls
 * Binance. If no database is reachable the whole suite skips rather than
 * failing the build.
 */

const SYNTHETIC_TAG = "phase4-synthetic";

// The vitest setup pins a test DATABASE_URL; use the real one from the backend
// .env so the suite runs against the developer's local database.
/**
 * Reads DATABASE_URL straight from the backend .env. The vitest setup pins a
 * placeholder test URL in process.env, so the file is the only reliable source
 * of the developer's real database; the file is parsed (not loaded) so nothing
 * else in the process is affected.
 */
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
const prisma = databaseUrl
  ? new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  : null;

/**
 * The connectivity probe MUST run at module scope: `it`/`it.skip` is chosen
 * when the describe blocks are collected, which happens before any beforeAll
 * hook, so deciding later would skip everything unconditionally.
 */
let available = false;
if (prisma) {
  try {
    await prisma.$queryRaw`SELECT 1`;
    available = true;
  } catch (error) {
    console.warn(
      `[phase4] Skipping execution integration tests — no database reachable: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }`
    );
  }
} else {
  console.warn("[phase4] Skipping execution integration tests — no DATABASE_URL could be resolved.");
}

let service: ExecutionService;
let profileId = "";
let alertId = "";
let secondAlertId = "";

function readyPlan(overrides: Partial<DynamicLeveragePlan> = {}): DynamicLeveragePlan {
  return {
    status: "READY",
    reason: null,
    reasonMessage: null,
    symbol: "TESTAUSDT",
    direction: "LONG",
    entryPrice: "100",
    stopLoss: "96",
    calculatedStopLoss: "96.0004",
    executableStopLoss: "96",
    stopAdjustment: "-0.0004",
    stopNormalization: "STOP_PRICE_NORMALIZED_TO_TICK",
    stopLossSource: "CALCULATED",
    stopDistance: "4",
    riskBudgetUsd: "1.50",
    quantityRaw: "0.375",
    roundedQuantity: "0.375",
    quantityStepSize: "0.001",
    actualPlannedLoss: "1.5",
    unusedRiskBudget: "0",
    positionNotional: "37.5",
    minimumNotional: "5",
    targetMarginMultiplier: "2.5",
    maximumMarginMultiplier: "3.333333",
    targetIsolatedMargin: "3.75",
    maximumIsolatedMargin: "4.9999995",
    applicableBracket: null,
    maximumSupportedLeverage: 50,
    binanceMaximumSupportedLeverage: 50,
    userMaximumAutomationLeverage: 25,
    usableMaximumLeverage: 25,
    selectedLeverage: 10,
    estimatedInitialMargin: "3.75",
    estimatedLiquidationPrice: "90.1",
    requiredLiquidationBoundary: "94",
    liquidationBufferRatio: "0.5",
    liquidationDistance: "5.9",
    safetyBufferDistance: "2",
    marginDifferenceFromTarget: "0",
    candidates: [],
    warnings: [],
    ...overrides,
  } as DynamicLeveragePlan;
}

async function createSyntheticAlert(suffix: string): Promise<string> {
  const alert = await prisma!.alert.create({
    data: {
      symbol: "TESTAUSDT",
      assetType: "CRYPTO",
      exchange: "SYNTHETIC",
      timeframe: "15m",
      price: 100,
      signal: "LONG",
      indicatorName: `${SYNTHETIC_TAG}-${suffix}`,
      rawPayload: { note: SYNTHETIC_TAG },
      triggeredAt: new Date(),
    },
  });
  return alert.id;
}

beforeAll(async () => {
  if (!prisma || !available) return;

  service = new ExecutionService(prisma);

  const profile = await prisma.executionProfile.create({
    data: {
      name: "Phase 4 synthetic profile",
      accountIdentifier: `${SYNTHETIC_TAG}-account`,
      environment: "TESTNET",
      isEnabled: true,
    },
  });
  profileId = profile.id;
  alertId = await createSyntheticAlert("a");
  secondAlertId = await createSyntheticAlert("b");
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    // Restrictive FKs mean order matters: events -> orders -> executions.
    const executions = await prisma.tradeExecution.findMany({
      where: { executionProfileId: profileId },
      select: { id: true },
    });
    const ids = executions.map((execution) => execution.id);
    if (ids.length > 0) {
      await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.binanceOrder.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.tradeExecution.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.executionProfile.deleteMany({ where: { accountIdentifier: `${SYNTHETIC_TAG}-account` } });
    await prisma.alert.deleteMany({ where: { indicatorName: { startsWith: SYNTHETIC_TAG } } });
  }
  await prisma.$disconnect();
});

// Resolved at collection time — see the module-scope probe above.
const maybe = () => (available ? it : it.skip);

describe("execution creation and idempotency", () => {
  maybe()("creates PLAN_READY at version 1 with the initial event", async () => {
    const execution = await service.createExecutionFromReadyPlan({
      executionProfileId: profileId,
      alertId,
      plan: readyPlan(),
      snapshots: { extremeRRCandidate: { requestedCandles: 300 } },
    });

    expect(execution.status).toBe("PLAN_READY");
    expect(execution.version).toBe(1);
    expect(execution.selectedLookback).toBe(300);
    // Frozen decimal strings survive the round trip exactly.
    expect(String(execution.plannedEntryPrice)).toBe("100");
    expect(String(execution.executableStopLoss)).toBe("96");
    expect(String(execution.calculatedStopLoss)).toBe("96.0004");
    expect(String(execution.positionNotional)).toBe("37.5");
    expect(execution.selectedLeverage).toBe(10);

    const events = await service.listEvents(execution.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sequenceNumber: 1, eventType: "EXECUTION_CREATED", toStatus: "PLAN_READY" });
  });

  maybe()("returns the existing execution on an identical retry", async () => {
    const first = await service.createExecutionFromReadyPlan({ executionProfileId: profileId, alertId, plan: readyPlan(), selectedLookback: 300 });
    const second = await service.createExecutionFromReadyPlan({ executionProfileId: profileId, alertId, plan: readyPlan(), selectedLookback: 300 });

    expect(second.id).toBe(first.id);
    const count = await prisma!.tradeExecution.count({ where: { alertId, executionProfileId: profileId } });
    expect(count).toBe(1);
  });

  maybe()("rejects a conflicting retry with different frozen values", async () => {
    await expect(
      service.createExecutionFromReadyPlan({
        executionProfileId: profileId,
        alertId,
        plan: readyPlan({ entryPrice: "101", selectedLeverage: 12 }),
        selectedLookback: 300,
      })
    ).rejects.toThrow(/different frozen plan values/);
  });

  maybe()("refuses a non-READY plan", async () => {
    for (const status of ["SKIPPED", "INVALID", "LIQUIDATION_ESTIMATE_UNAVAILABLE"] as const) {
      await expect(
        service.createExecutionFromReadyPlan({
          executionProfileId: profileId,
          alertId: secondAlertId,
          plan: readyPlan({ status }),
          selectedLookback: 300,
        })
      ).rejects.toThrow(/Only a READY margin plan/);
    }
  });

  maybe()("refuses a READY plan without a selected leverage", async () => {
    await expect(
      service.createExecutionFromReadyPlan({
        executionProfileId: profileId,
        alertId: secondAlertId,
        plan: readyPlan({ selectedLeverage: null }),
        selectedLookback: 300,
      })
    ).rejects.toThrow(/selected leverage/);
  });

  maybe()("refuses a disabled profile unless the explicit override is used", async () => {
    const disabled = await prisma!.executionProfile.create({
      data: {
        name: "Phase 4 disabled",
        accountIdentifier: `${SYNTHETIC_TAG}-account-disabled`,
        environment: "TESTNET",
        isEnabled: false,
      },
    });

    await expect(
      service.createExecutionFromReadyPlan({
        executionProfileId: disabled.id,
        alertId: secondAlertId,
        plan: readyPlan(),
        selectedLookback: 300,
      })
    ).rejects.toThrow(/disabled/);

    const created = await service.createExecutionFromReadyPlan({
      executionProfileId: disabled.id,
      alertId: secondAlertId,
      plan: readyPlan(),
      allowDisabledProfile: true,
      selectedLookback: 300,
    });
    expect(created.status).toBe("PLAN_READY");

    await prisma!.executionEvent.deleteMany({ where: { tradeExecutionId: created.id } });
    await prisma!.tradeExecution.delete({ where: { id: created.id } });
    await prisma!.executionProfile.delete({ where: { id: disabled.id } });
  });

  maybe()("enforces profile uniqueness on exchange+environment+accountIdentifier", async () => {
    await expect(
      prisma!.executionProfile.create({
        data: {
          name: "duplicate",
          accountIdentifier: `${SYNTHETIC_TAG}-account`,
          environment: "TESTNET",
          isEnabled: false,
        },
      })
    ).rejects.toThrow();
  });
});

describe("transitions, locking and atomicity", () => {
  async function freshExecution(suffix: string) {
    const newAlertId = await createSyntheticAlert(suffix);
    return service.createExecutionFromReadyPlan({
      executionProfileId: profileId,
      alertId: newAlertId,
      plan: readyPlan(),
      selectedLookback: 300,
    });
  }

  maybe()("increments version by one and appends exactly one ordered event", async () => {
    const execution = await freshExecution("t1");

    const next = await service.transition({
      executionId: execution.id,
      expectedVersion: execution.version,
      targetStatus: "PREFLIGHT",
      eventType: "STATUS_CHANGED",
      reasonCode: "PREFLIGHT_STARTED",
    });

    expect(next.version).toBe(2);
    expect(next.status).toBe("PREFLIGHT");

    const events = await service.listEvents(execution.id);
    expect(events.map((e) => e.sequenceNumber)).toEqual([1, 2]);
    expect(events[1]).toMatchObject({ fromStatus: "PLAN_READY", toStatus: "PREFLIGHT" });
  });

  maybe()("rejects a stale expectedVersion", async () => {
    const execution = await freshExecution("t2");
    await service.transition({
      executionId: execution.id,
      expectedVersion: 1,
      targetStatus: "PREFLIGHT",
      eventType: "STATUS_CHANGED",
    });

    await expect(
      service.transition({
        executionId: execution.id,
        expectedVersion: 1, // stale
        targetStatus: "ENTRY_SUBMITTING",
        eventType: "STATUS_CHANGED",
      })
    ).rejects.toBeInstanceOf(OptimisticLockError);

    const events = await service.listEvents(execution.id);
    expect(events).toHaveLength(2); // no event written for the failed attempt
  });

  maybe()("lets only one of two concurrent transitions succeed", async () => {
    const execution = await freshExecution("t3");

    const results = await Promise.allSettled([
      service.transition({
        executionId: execution.id,
        expectedVersion: 1,
        targetStatus: "PREFLIGHT",
        eventType: "STATUS_CHANGED",
      }),
      service.transition({
        executionId: execution.id,
        expectedVersion: 1,
        targetStatus: "SKIPPED",
        eventType: "DECISION_RECORDED",
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const after = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(after.version).toBe(2); // incremented exactly once

    const events = await service.listEvents(execution.id);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.sequenceNumber)).size).toBe(2);
  });

  maybe()("rolls back the status change when the event cannot be written", async () => {
    const execution = await freshExecution("t4");

    // Occupy the sequence number the transition will need, forcing the event
    // insert to violate the unique constraint inside the transaction.
    await prisma!.executionEvent.create({
      data: {
        tradeExecutionId: execution.id,
        sequenceNumber: 2,
        eventType: "DECISION_RECORDED",
        message: "pre-existing sequence holder",
      },
    });

    await expect(
      service.transition({
        executionId: execution.id,
        expectedVersion: 1,
        targetStatus: "PREFLIGHT",
        eventType: "STATUS_CHANGED",
      })
    ).rejects.toThrow();

    const after = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(after.status).toBe("PLAN_READY"); // rolled back
    expect(after.version).toBe(1);
  });

  maybe()("refuses an invalid transition before touching the database", async () => {
    const execution = await freshExecution("t5");

    await expect(
      service.transition({
        executionId: execution.id,
        expectedVersion: 1,
        targetStatus: "PROTECTED",
        eventType: "STATUS_CHANGED",
      })
    ).rejects.toThrow(/not an allowed transition/);

    const after = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(after.version).toBe(1);
    expect(await service.listEvents(execution.id)).toHaveLength(1);
  });

  maybe()("sanitizes credential-like metadata before storing an event", async () => {
    const execution = await freshExecution("t6");

    await service.transition({
      executionId: execution.id,
      expectedVersion: 1,
      targetStatus: "PREFLIGHT",
      eventType: "STATUS_CHANGED",
      metadata: { apiKey: "AAA", nested: { signature: "BBB" }, note: "keep" },
    });

    const events = await service.listEvents(execution.id);
    const stored = JSON.stringify(events[1].metadata);
    expect(stored).not.toContain("AAA");
    expect(stored).not.toContain("BBB");
    expect(stored).toContain("keep");
  });
});

describe("order reservation", () => {
  maybe()("creates only a local row, idempotently, with a deterministic id", async () => {
    const newAlertId = await createSyntheticAlert("o1");
    const execution = await service.createExecutionFromReadyPlan({
      executionProfileId: profileId,
      alertId: newAlertId,
      plan: readyPlan(),
      selectedLookback: 300,
    });

    const entryArgs = {
      executionId: execution.id,
      role: "ENTRY",
      side: "BUY",
      positionSide: "LONG",
      orderType: "LIMIT",
      originalQuantity: "0.375",
      price: "100",
    } as const;

    const first = await service.reserveOrder({ ...entryArgs, expectedVersion: 1 });
    // Idempotent retry: returns the existing row and bumps nothing.
    const retry = await service.reserveOrder({ ...entryArgs, expectedVersion: 2 });

    expect(retry.id).toBe(first.id);
    expect(first.status).toBe("PLANNED");
    expect(first.exchangeOrderId).toBeNull(); // nothing was ever submitted
    expect(first.submittedAt).toBeNull();
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(1);

    const afterRetry = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(afterRetry.version).toBe(2); // one bump for the single real reservation

    // Conflicting retry is refused.
    await expect(
      service.reserveOrder({ ...entryArgs, expectedVersion: 2, originalQuantity: "0.999" })
    ).rejects.toThrow(/different parameters/);

    // Distinct roles and generations coexist as separate historical rows.
    const stop = await service.reserveOrder({
      executionId: execution.id,
      expectedVersion: 2,
      role: "STOP_LOSS",
      side: "SELL",
      positionSide: "LONG",
      orderType: "STOP_MARKET",
      originalQuantity: "0.375",
      stopPrice: "96",
    });
    const stopGen2 = await service.reserveOrder({
      executionId: execution.id,
      expectedVersion: 3,
      role: "STOP_LOSS",
      generation: 2,
      side: "SELL",
      positionSide: "LONG",
      orderType: "STOP_MARKET",
      originalQuantity: "0.375",
      stopPrice: "95",
    });

    expect(new Set([first.clientOrderId, stop.clientOrderId, stopGen2.clientOrderId]).size).toBe(3);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(3);

    const events = await service.listEvents(execution.id);
    expect(events.filter((e) => e.eventType === "ORDER_RESERVED")).toHaveLength(3);
    // Sequence numbers track version exactly: 1 create, then 2/3/4.
    expect(events.map((e) => e.sequenceNumber)).toEqual([1, 2, 3, 4]);
    const final = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(final.version).toBe(4);
  });

  maybe()("rejects a stale expectedVersion and writes nothing", async () => {
    const newAlertId = await createSyntheticAlert("o2");
    const execution = await service.createExecutionFromReadyPlan({
      executionProfileId: profileId,
      alertId: newAlertId,
      plan: readyPlan(),
      selectedLookback: 200,
    });

    await expect(
      service.reserveOrder({
        executionId: execution.id,
        expectedVersion: 99,
        role: "ENTRY",
        side: "BUY",
        positionSide: "LONG",
        orderType: "LIMIT",
        originalQuantity: "0.375",
        price: "100",
      })
    ).rejects.toBeInstanceOf(OptimisticLockError);

    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
    expect(await service.listEvents(execution.id)).toHaveLength(1);
  });

  maybe()("lets only one of two concurrent reservations succeed", async () => {
    const newAlertId = await createSyntheticAlert("o3");
    const execution = await service.createExecutionFromReadyPlan({
      executionProfileId: profileId,
      alertId: newAlertId,
      plan: readyPlan(),
      selectedLookback: 100,
    });

    // Two DIFFERENT roles racing on the same version: an unsafe
    // MAX(sequenceNumber)+1 allocator would hand both the same sequence.
    const results = await Promise.allSettled([
      service.reserveOrder({
        executionId: execution.id,
        expectedVersion: 1,
        role: "ENTRY",
        side: "BUY",
        positionSide: "LONG",
        orderType: "LIMIT",
        originalQuantity: "0.375",
        price: "100",
      }),
      service.reserveOrder({
        executionId: execution.id,
        expectedVersion: 1,
        role: "TAKE_PROFIT",
        side: "SELL",
        positionSide: "LONG",
        orderType: "TAKE_PROFIT_MARKET",
        originalQuantity: "0.375",
        stopPrice: "110",
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const after = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(after.version).toBe(2); // exactly one increment
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(1);

    const events = await service.listEvents(execution.id);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.sequenceNumber)).size).toBe(2);
  });
});

describe("selectedLookback provenance", () => {
  maybe()("accepts exactly 100, 200 and 300", async () => {
    for (const lookback of [100, 200, 300] as const) {
      const newAlertId = await createSyntheticAlert(`lb-ok-${lookback}`);
      const execution = await service.createExecutionFromReadyPlan({
        executionProfileId: profileId,
        alertId: newAlertId,
        plan: readyPlan(),
        selectedLookback: lookback,
      });
      expect(execution.selectedLookback).toBe(lookback);
    }
  });

  maybe()("accepts a lookback carried by the candidate snapshot", async () => {
    const newAlertId = await createSyntheticAlert("lb-snapshot");
    const execution = await service.createExecutionFromReadyPlan({
      executionProfileId: profileId,
      alertId: newAlertId,
      plan: readyPlan(),
      snapshots: { extremeRRCandidate: { requestedCandles: 200 } },
    });
    expect(execution.selectedLookback).toBe(200);
  });

  maybe()("rejects a missing, zero or arbitrary lookback and persists nothing", async () => {
    const cases: Array<{ label: string; lookback?: number }> = [
      { label: "missing" },
      { label: "zero", lookback: 0 },
      { label: "50", lookback: 50 },
      { label: "400", lookback: 400 },
      { label: "150", lookback: 150 },
    ];

    for (const { label, lookback } of cases) {
      const newAlertId = await createSyntheticAlert(`lb-bad-${label}`);

      await expect(
        service.createExecutionFromReadyPlan({
          executionProfileId: profileId,
          alertId: newAlertId,
          plan: readyPlan(),
          ...(lookback === undefined ? {} : { selectedLookback: lookback }),
        }),
        label
      ).rejects.toThrow(/selectedLookback must be one of 100, 200, 300/);

      // Failed creation leaves no execution and no event behind.
      const executions = await prisma!.tradeExecution.findMany({ where: { alertId: newAlertId } });
      expect(executions, label).toHaveLength(0);
      const events = await prisma!.executionEvent.count({
        where: { tradeExecution: { alertId: newAlertId } },
      });
      expect(events, label).toBe(0);
    }
  });

  maybe()("never persists 0 for any execution", async () => {
    const zeroes = await prisma!.tradeExecution.count({
      where: { executionProfileId: profileId, selectedLookback: 0 },
    });
    expect(zeroes).toBe(0);
  });
});

describe("actual values and planned immutability", () => {
  maybe()("records actuals without altering any planned field", async () => {
    const newAlertId = await createSyntheticAlert("v1");
    const execution = await service.createExecutionFromReadyPlan({
      executionProfileId: profileId,
      alertId: newAlertId,
      plan: readyPlan(),
      selectedLookback: 300,
    });

    const updated = await service.recordActuals({
      executionId: execution.id,
      expectedVersion: execution.version,
      submittedEntryPrice: "100",
      averageFillPrice: "99.98",
      filledQuantity: "0.2",
      actualLeverage: 10,
      actualIsolatedMargin: "3.7",
      reportedLiquidationPrice: "90.05",
      entrySubmittedAt: new Date(),
    });

    expect(String(updated.averageFillPrice)).toBe("99.98");
    expect(String(updated.filledQuantity)).toBe("0.2");
    expect(updated.version).toBe(2);

    // Planned block is byte-identical.
    expect(String(updated.plannedEntryPrice)).toBe(String(execution.plannedEntryPrice));
    expect(String(updated.executableStopLoss)).toBe(String(execution.executableStopLoss));
    expect(String(updated.plannedQuantity)).toBe(String(execution.plannedQuantity));
    expect(String(updated.positionNotional)).toBe(String(execution.positionNotional));
    expect(String(updated.riskBudgetUsd)).toBe(String(execution.riskBudgetUsd));
    expect(updated.selectedLeverage).toBe(execution.selectedLeverage);
    expect(updated.selectedLookback).toBe(execution.selectedLookback);

    const events = await service.listEvents(execution.id);
    expect(events[events.length - 1].eventType).toBe("ACTUALS_UPDATED");
  });

  maybe()("records an exit result including a negative realized PnL", async () => {
    const newAlertId = await createSyntheticAlert("v2");
    const execution = await service.createExecutionFromReadyPlan({
      executionProfileId: profileId,
      alertId: newAlertId,
      plan: readyPlan(),
      selectedLookback: 300,
    });

    const updated = await service.recordActuals({
      executionId: execution.id,
      expectedVersion: 1,
      actualExitPrice: "96",
      realizedPnl: "-1.4994",
      exitReason: "STOP_LOSS",
      closedAt: new Date(),
    });

    expect(String(updated.realizedPnl)).toBe("-1.4994");
    expect(updated.exitReason).toBe("STOP_LOSS");
  });

  maybe()("rejects invalid decimals, negatives and stale versions", async () => {
    const newAlertId = await createSyntheticAlert("v3");
    const execution = await service.createExecutionFromReadyPlan({
      executionProfileId: profileId,
      alertId: newAlertId,
      plan: readyPlan(),
      selectedLookback: 300,
    });

    for (const bad of ["NaN", "Infinity", "1e-7", "abc"]) {
      await expect(
        service.recordActuals({ executionId: execution.id, expectedVersion: 1, averageFillPrice: bad })
      ).rejects.toThrow();
    }
    await expect(
      service.recordActuals({ executionId: execution.id, expectedVersion: 1, filledQuantity: "-1" })
    ).rejects.toThrow(/must not be negative/);
    await expect(
      service.recordActuals({ executionId: execution.id, expectedVersion: 1, actualLeverage: 0 })
    ).rejects.toThrow(/positive integer/);
    await expect(
      service.recordActuals({ executionId: execution.id, expectedVersion: 99, averageFillPrice: "100" })
    ).rejects.toBeInstanceOf(OptimisticLockError);

    const after = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(after.version).toBe(1);
  });
});
