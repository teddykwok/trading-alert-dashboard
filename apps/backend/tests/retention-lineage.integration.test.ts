import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * Retention vs execution lineage, against a REAL Postgres.
 *
 * The rule this proves cannot be proven by inspecting the where-clause object:
 * `{ extremeRRPlan: { is: { tradeExecutions: { none: {} } } } }` is a nested
 * relation filter on a NULLABLE one-to-one, and whether an alert with no plan
 * at all falls on the deletable or the protected side of it is decided by the
 * SQL Prisma generates, not by the literal. So every case here runs the actual
 * query and asserts which rows come back.
 *
 * Nothing here imports a Binance client or a mutation client, and every row is
 * synthetic and removed in afterAll.
 */

const TAG = "retention-lineage-synthetic";
const SYMBOL = "RETLUSDT";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { deletableAlertWhere, lineageProtectedAlertWhere, executionLineageWhere } = await import(
  "../src/modules/retention/retention.service"
);

const maybe = () => (available ? it : it.skip);

/** Well past any cutoff the tests use. */
const OLD = new Date("2020-01-01T00:00:00.000Z");
const CUTOFF = new Date("2020-06-01T00:00:00.000Z");

let profileId = "";
let sequence = 0;
const alertIds: string[] = [];

/** An aged, terminal alert: eligible on every pre-existing rule. */
async function agedAlert(note: string) {
  sequence += 1;
  const alert = await prisma!.alert.create({
    data: {
      symbol: SYMBOL,
      assetType: "CRYPTO",
      exchange: "SYNTHETIC",
      timeframe: "15m",
      price: 100,
      signal: "LONG",
      indicatorName: `${TAG}-${sequence}-${note}`,
      rawPayload: { note: TAG },
      triggeredAt: OLD,
      status: "ANALYZED",
      createdAt: OLD,
    },
  });
  alertIds.push(alert.id);
  return alert;
}

/** The plan row that carries the risk-template lineage. */
async function planFor(alertId: string) {
  return prisma!.extremeRRPlan.create({
    data: {
      alertId,
      direction: "LONG",
      entryPrice: "100",
      cutoffAt: OLD,
      timeframe: "15m",
      status: "READY",
      // The lineage that cannot be recovered once this row is gone.
      riskTemplateId: "template-1",
      templateName: "Standard 1%",
      referenceCapital: "1000",
      riskPercent: "1",
      rewardRatio: "2",
      riskAmount: "10",
      targetAmount: "20",
    },
  });
}

/** An execution pointing at that plan, as the executor creates it. */
async function executionFor(alertId: string, extremeRRPlanId: string) {
  return prisma!.tradeExecution.create({
    data: {
      executionProfileId: profileId,
      alertId,
      extremeRRPlanId,
      symbol: SYMBOL,
      direction: "LONG",
      positionSide: "LONG",
      selectedLookback: 200,
      signalTriggeredAt: OLD,
      status: "CLOSED_TP",
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
      liquidationBufferRatio: "0.5",
      decisionReasonCode: "SYNTHETIC",
    },
  });
}

const deletableIds = async () =>
  (await prisma!.alert.findMany({ where: deletableAlertWhere(CUTOFF), select: { id: true } })).map(
    (row) => row.id
  );

beforeAll(async () => {
  if (!prisma || !available) return;
  const profile = await prisma.executionProfile.create({
    data: {
      name: "Retention lineage profile",
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
    await prisma.tradeExecution.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.alert.deleteMany({ where: { indicatorName: { startsWith: TAG } } });
    await prisma.executionProfile.deleteMany({ where: { id: profileId } });
  }
  await prisma.$disconnect();
});

describe("retention never deletes an alert an execution still needs", () => {
  maybe()("CASE A. a plan linked to an execution protects its alert", async () => {
    const alert = await agedAlert("case-a");
    const plan = await planFor(alert.id);
    const execution = await executionFor(alert.id, plan.id);

    // Eligible on every pre-existing rule: old enough, terminal, no review and
    // no journal. Only lineage holds it back.
    expect(await deletableIds()).not.toContain(alert.id);

    // And it is reported as exactly that, not as unfinished user state.
    const protectedRows = await prisma!.alert.findMany({
      where: lineageProtectedAlertWhere(CUTOFF),
      select: { id: true },
    });
    expect(protectedRows.map((row) => row.id)).toContain(alert.id);

    // The lineage itself is intact and still reachable from the execution.
    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({
      where: { id: execution.id },
      include: { extremeRRPlan: true },
    });
    expect(reloaded.extremeRRPlanId).toBe(plan.id);
    expect(reloaded.extremeRRPlan!.riskTemplateId).toBe("template-1");
    expect(reloaded.extremeRRPlan!.riskPercent!.toString()).toBe("1");
    expect(reloaded.extremeRRPlan!.referenceCapital!.toString()).toBe("1000");
  });

  maybe()("CASE A2. deleting it WOULD have destroyed the lineage", async () => {
    // The counterfactual, run on a throwaway alert so the cascade is observed
    // rather than assumed. This is what the predicate is preventing.
    const alert = await agedAlert("case-a2");
    const plan = await planFor(alert.id);
    const execution = await executionFor(alert.id, plan.id);

    await prisma!.alert.delete({ where: { id: alert.id } });

    const survivor = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    // The execution survives, which is exactly why the loss is silent.
    expect(survivor.id).toBe(execution.id);
    expect(survivor.riskBudgetUsd.toString()).toBe("1.5");
    // But its origin is gone, permanently and unrecoverably.
    expect(survivor.alertId).toBeNull();
    expect(survivor.extremeRRPlanId).toBeNull();
    expect(await prisma!.extremeRRPlan.findUnique({ where: { id: plan.id } })).toBeNull();

    await prisma!.tradeExecution.delete({ where: { id: execution.id } });
  });

  maybe()("CASE B. a plan NO execution used stays disposable", async () => {
    // The rule that keeps retention bounded. A plan that was generated and
    // never executed is a candidate, not history.
    const alert = await agedAlert("case-b");
    await planFor(alert.id);

    expect(await deletableIds()).toContain(alert.id);
    const protectedRows = await prisma!.alert.findMany({
      where: lineageProtectedAlertWhere(CUTOFF),
      select: { id: true },
    });
    expect(protectedRows.map((row) => row.id)).not.toContain(alert.id);
  });

  maybe()("CASE B2. a plan with a SelectedPlanOutcome refusal stays disposable", async () => {
    // handled=false is a pre-execution refusal: it names no execution, so
    // nothing durable depends on it.
    const alert = await agedAlert("case-b2");
    const plan = await planFor(alert.id);
    await prisma!.selectedPlanOutcome.create({
      data: {
        alertId: alert.id,
        extremeRRPlanId: plan.id,
        handled: false,
        reasonCode: "SYMBOL_NOT_ALLOWED",
        message: "Synthetic refusal.",
        evaluatedAt: OLD,
      },
    });

    expect(await deletableIds()).toContain(alert.id);
  });

  maybe()("CASE B3. a SelectedPlanOutcome that names an execution is protected", async () => {
    // Same alert, but the plan was actually executed. The outcome row carries
    // the admission verdict for a real trade and cascades from both the alert
    // and the plan, so the SAME condition has to cover it.
    const alert = await agedAlert("case-b3");
    const plan = await planFor(alert.id);
    const execution = await executionFor(alert.id, plan.id);
    await prisma!.selectedPlanOutcome.create({
      data: {
        alertId: alert.id,
        extremeRRPlanId: plan.id,
        handled: true,
        reasonCode: "ADMITTED",
        message: "Synthetic admission.",
        executionId: execution.id,
        evaluatedAt: OLD,
      },
    });

    expect(await deletableIds()).not.toContain(alert.id);
  });

  maybe()("CASE C. an ordinary old terminal alert is deleted as before", async () => {
    const alert = await agedAlert("case-c");

    // No plan at all: the nullable relation must fall on the deletable side.
    expect(await deletableIds()).toContain(alert.id);
  });

  maybe()("CASE D. age, status and review rules are untouched", async () => {
    const recent = await prisma!.alert.create({
      data: {
        symbol: SYMBOL, assetType: "CRYPTO", exchange: "SYNTHETIC", timeframe: "15m", price: 100,
        signal: "LONG", indicatorName: `${TAG}-recent`, rawPayload: { note: TAG },
        triggeredAt: new Date(), status: "ANALYZED",
      },
    });
    alertIds.push(recent.id);

    const nonTerminal = await agedAlert("non-terminal");
    await prisma!.alert.update({ where: { id: nonTerminal.id }, data: { status: "RECEIVED" } });

    const openReview = await agedAlert("open-review");
    await prisma!.tradeReview.create({ data: { alertId: openReview.id, status: "OPEN" } });

    const finalReview = await agedAlert("final-review");
    await prisma!.tradeReview.create({ data: { alertId: finalReview.id, status: "WIN" } });

    const deletable = await deletableIds();
    expect(deletable).not.toContain(recent.id); // too new
    expect(deletable).not.toContain(nonTerminal.id); // not terminal
    expect(deletable).not.toContain(openReview.id); // user still has it open
    expect(deletable).toContain(finalReview.id); // finalized: releasable as before
  });

  maybe()("the two skip reasons never double count the same alert", async () => {
    // Lineage AND an open review. It must be reported once, as user state.
    const alert = await agedAlert("both-reasons");
    const plan = await planFor(alert.id);
    await executionFor(alert.id, plan.id);
    await prisma!.tradeReview.create({ data: { alertId: alert.id, status: "OPEN" } });

    expect(await deletableIds()).not.toContain(alert.id);
    const protectedRows = await prisma!.alert.findMany({
      where: lineageProtectedAlertWhere(CUTOFF),
      select: { id: true },
    });
    // Excluded from the lineage count because the user-state rule already
    // holds it, so `agedTerminal - deletable - lineage` stays exact.
    expect(protectedRows.map((row) => row.id)).not.toContain(alert.id);
  });

  maybe()("the protecting condition is exactly one relation hop", () => {
    expect(executionLineageWhere()).toEqual({
      extremeRRPlan: { is: { tradeExecutions: { some: {} } } },
    });
  });
});
