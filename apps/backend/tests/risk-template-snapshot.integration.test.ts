import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * Risk-template provenance, against a REAL Postgres.
 *
 * The executor tests prove the right object is HANDED to the service. This
 * proves the rest of the claim: that it is actually stored, that it survives
 * the lifecycle, and that editing the mutable RiskTemplate row afterwards
 * cannot reach back and rewrite what a finished trade was planned with.
 *
 * Nothing here imports a Binance client or a mutation client. Every row is
 * synthetic and removed in afterAll.
 */

const TAG = "risk-template-snapshot-synthetic";
const SYMBOL = "RTSNAPUSDT";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ExecutionService } = await import("../src/modules/execution/execution.service");

const maybe = () => (available ? it : it.skip);

type ExecutionServiceType = InstanceType<typeof ExecutionService>;
let executions: ExecutionServiceType;
let profileId = "";
let sequence = 0;

/** The V1 configuration a plan is generated from. */
const V1 = {
  riskTemplateId: "",
  name: "V1 conservative",
  referenceCapital: "300",
  riskPercent: "0.5",
  rewardRatio: "3",
  riskAmount: "1.5",
  targetAmount: "4.5",
};

function readyPlan() {
  return {
    status: "READY", reason: null, reasonMessage: null, symbol: SYMBOL, direction: "LONG",
    entryPrice: "100", stopLoss: "96", calculatedStopLoss: "96", executableStopLoss: "96",
    stopAdjustment: "0", stopNormalization: null, stopLossSource: "CALCULATED", stopDistance: "4",
    // The plan is sized from the template's riskAmount.
    riskBudgetUsd: V1.riskAmount,
    quantityRaw: "0.375", roundedQuantity: "0.375", quantityStepSize: "0.001",
    actualPlannedLoss: "1.5", unusedRiskBudget: "0", positionNotional: "37.5", minimumNotional: "5",
    targetMarginMultiplier: "2.5", maximumMarginMultiplier: "3.333333", targetIsolatedMargin: "3.75",
    maximumIsolatedMargin: "5.00", applicableBracket: null, maximumSupportedLeverage: 50,
    binanceMaximumSupportedLeverage: 50, userMaximumAutomationLeverage: 25, usableMaximumLeverage: 25,
    selectedLeverage: 10, estimatedInitialMargin: "3.75", estimatedLiquidationPrice: "90.1",
    requiredLiquidationBoundary: "94", liquidationBufferRatio: "0.5", liquidationDistance: "5.9",
    safetyBufferDistance: "2", marginDifferenceFromTarget: "0", candidates: [], warnings: [],
  };
}

/** One execution created with the given frozen template provenance. */
async function executionWith(template: Record<string, string | null>) {
  sequence += 1;
  const alert = await prisma!.alert.create({
    data: {
      symbol: SYMBOL, assetType: "CRYPTO", exchange: "SYNTHETIC", timeframe: "15m", price: 100,
      signal: "LONG", indicatorName: `${TAG}-${sequence}`, rawPayload: { note: TAG },
      triggeredAt: new Date(),
    },
  });
  return executions.createExecutionFromReadyPlan({
    executionProfileId: profileId,
    alertId: alert.id,
    plan: readyPlan() as never,
    positionSide: "LONG",
    takeProfit: "108",
    selectedLookback: 200,
    // The profile is disabled until an authorized window, exactly as in
    // production; the executor passes the same override.
    allowDisabledProfile: true,
    snapshots: { riskTemplate: template, exchangeFilters: { tickSize: "0.01" } },
  } as never);
}

const snapshotOf = async (id: string) =>
  (await prisma!.tradeExecution.findUniqueOrThrow({ where: { id } })).riskTemplateSnapshot;

beforeAll(async () => {
  if (!prisma || !available) return;
  executions = new ExecutionService(prisma);
  const profile = await prisma.executionProfile.create({
    data: {
      name: "Risk template snapshot profile",
      accountIdentifier: `${TAG}-account`,
      environment: "TESTNET",
      isEnabled: false,
    },
  });
  profileId = profile.id;
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    const ids = (
      await prisma.tradeExecution.findMany({ where: { executionProfileId: profileId }, select: { id: true } })
    ).map((row) => row.id);
    await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
    await prisma.tradeExecution.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionProfile.deleteMany({ where: { id: profileId } });
    await prisma.alert.deleteMany({ where: { indicatorName: { startsWith: TAG } } });
    await prisma.riskTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
  }
  await prisma.$disconnect();
});

describe("a trade permanently remembers how it was sized", () => {
  maybe()("C. editing the RiskTemplate afterwards never changes a finished trade", async () => {
    // The whole product invariant, end to end against the database.
    const template = await prisma!.riskTemplate.create({
      data: {
        name: `${TAG}-A`,
        referenceCapital: V1.referenceCapital,
        riskPercent: V1.riskPercent,
        rewardRatio: V1.rewardRatio,
        isActive: true,
      },
    });
    const frozen = { ...V1, riskTemplateId: template.id, name: `${TAG}-A` };

    const execution = await executionWith(frozen);
    expect(await snapshotOf(execution.id)).toEqual(frozen);

    // The operator rewrites the template: different capital, different risk,
    // different RR. Exactly the drift that made history unreadable before.
    await prisma!.riskTemplate.update({
      where: { id: template.id },
      data: { referenceCapital: "10000", riskPercent: "5", rewardRatio: "1", name: `${TAG}-A-edited` },
    });

    // The trade still answers with what it was actually planned with.
    expect(await snapshotOf(execution.id)).toEqual(frozen);
  });

  maybe()("D. a V1 plan stays V1 even while the active template is already V2", async () => {
    // Plan generation and execution admission are separated in time, and the
    // template can change in between. The execution records the plan's
    // configuration, not the one that happens to be active when it is admitted.
    const template = await prisma!.riskTemplate.create({
      data: {
        name: `${TAG}-V2`,
        referenceCapital: "10000",
        riskPercent: "5",
        rewardRatio: "1",
        isActive: true,
      },
    });
    const v1 = { ...V1, riskTemplateId: template.id, name: `${TAG}-V1` };

    const execution = await executionWith(v1);

    const stored = (await snapshotOf(execution.id)) as Record<string, string>;
    expect(stored).toEqual(v1);
    // Emphatically NOT the row that is active right now.
    expect(stored.referenceCapital).not.toBe("10000");
    expect(stored.riskPercent).not.toBe("5");
    expect(stored.name).not.toBe(`${TAG}-V2`);
  });

  maybe()("the snapshot survives the lifecycle: actuals, transitions and closure", async () => {
    const frozen = { ...V1, riskTemplateId: "t-lifecycle" };
    const execution = await executionWith(frozen);

    const afterCreate = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    await executions.recordActuals({
      executionId: execution.id,
      averageFillPrice: "100.5",
      filledQuantity: "0.375",
      actualExitPrice: "108",
      realizedPnl: "3",
      exitReason: "TAKE_PROFIT",
      closedAt: new Date(),
    } as never);

    // Actuals moved, provenance did not.
    const after = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(after.averageFillPrice!.toString()).toBe("100.5");
    expect(after.riskTemplateSnapshot).toEqual(frozen);
    expect(after.riskTemplateSnapshot).toEqual(afterCreate.riskTemplateSnapshot);
  });

  maybe()("decimals are stored as exact strings, never floats", async () => {
    // A value no binary float represents exactly. It has to come back
    // character for character or the provenance is not the provenance.
    const frozen = {
      ...V1,
      riskTemplateId: "t-precision",
      referenceCapital: "1234.567890123456",
      riskPercent: "0.1",
      riskAmount: "1.234567890123456",
    };
    const execution = await executionWith(frozen);

    const stored = (await snapshotOf(execution.id)) as Record<string, unknown>;
    expect(stored).toEqual(frozen);
    for (const key of ["referenceCapital", "riskPercent", "rewardRatio", "riskAmount", "targetAmount"]) {
      expect(typeof stored[key]).toBe("string");
    }
  });

  maybe()("K. an execution created without provenance stores NULL, never a default", async () => {
    // Old rows and any future caller that has nothing to say. Unknown stays
    // unknown; it is never filled in from riskBudgetUsd or anything else.
    sequence += 1;
    const alert = await prisma!.alert.create({
      data: {
        symbol: SYMBOL, assetType: "CRYPTO", exchange: "SYNTHETIC", timeframe: "15m", price: 100,
        signal: "LONG", indicatorName: `${TAG}-${sequence}`, rawPayload: { note: TAG },
        triggeredAt: new Date(),
      },
    });
    const execution = await executions.createExecutionFromReadyPlan({
      executionProfileId: profileId,
      alertId: alert.id,
      plan: readyPlan() as never,
      positionSide: "LONG",
      takeProfit: "108",
      selectedLookback: 200,
    // The profile is disabled until an authorized window, exactly as in
    // production; the executor passes the same override.
    allowDisabledProfile: true,
      snapshots: { exchangeFilters: { tickSize: "0.01" } },
    } as never);

    const row = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(row.riskTemplateSnapshot).toBeNull();
    // The frozen derived numbers exist regardless, and are NOT provenance.
    expect(row.riskBudgetUsd.toString()).toBe("1.5");
  });

  maybe()("I. the snapshot explains the frozen numbers without duplicating them", async () => {
    // riskAmount IS the risk budget the planner was given. actualPlannedLoss
    // is deliberately a different quantity: it is what the ROUNDED position
    // actually risks, so equality is not an invariant and is not asserted.
    const frozen = { ...V1, riskTemplateId: "t-consistency" };
    const execution = await executionWith(frozen);

    const row = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const stored = (await snapshotOf(execution.id)) as Record<string, string>;
    expect(row.riskBudgetUsd.toString()).toBe(stored.riskAmount);
    // Same trade, different question — related, not equal by rule.
    expect(row.actualPlannedLoss.toString()).toBeDefined();
  });
});
