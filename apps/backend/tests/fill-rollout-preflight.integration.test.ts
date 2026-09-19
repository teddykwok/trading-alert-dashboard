import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * The preflight's durable reads, against a REAL Postgres.
 *
 * The verdict rules are unit-tested; what is proved here is that the four facts
 * the verdict rests on are read correctly from real rows -- and, just as
 * importantly, that reading them writes nothing.
 */

const TAG = "preflight";
const SYMBOL_A = "PREFAUSDT";
const SYMBOL_B = "PREFBUSDT";
const DAY = 86_400_000;
const DAY_START = Date.UTC(2026, 8, 15);

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { MAX_INGEST_ATTEMPTS } = await import(
  "../src/modules/execution/exchange-fill-ingest-window.service"
);
const { HistoricalFillCampaignService } = await import(
  "../src/modules/execution/historical-fill-campaign.service"
);
const { horizonSourceOf, readPreflightState, INGEST_HORIZON_KEY } = await import(
  "../src/modules/execution/run-fill-preflight"
);

const maybe = () => (available ? it : it.skip);

let campaigns: InstanceType<typeof HistoricalFillCampaignService>;
let sequence = 0;

async function profile(alias: string) {
  sequence += 1;
  return prisma!.executionProfile.create({
    data: {
      name: `${TAG} ${alias} ${sequence}`,
      accountIdentifier: `${TAG}-${alias}-${sequence}`,
      environment: "TESTNET",
      isEnabled: false,
      safetyPolicy: { create: {} },
    },
  });
}

async function execution(executionProfileId: string, symbol: string) {
  sequence += 1;
  return prisma!.tradeExecution.create({
    data: {
      executionProfileId, symbol, direction: "LONG", positionSide: "LONG",
      selectedLookback: 200, plannedEntryPrice: "1.06", calculatedStopLoss: "1.01",
      executableStopLoss: "1.01", takeProfit: "1.09", riskBudgetUsd: "3",
      quantityRaw: "68.8", plannedQuantity: "68.8", quantityStepSize: "0.1",
      actualPlannedLoss: "3", unusedRiskBudget: "0", positionNotional: "72.9",
      targetIsolatedMargin: "7.3", maximumIsolatedMargin: "10", selectedLeverage: 10,
      estimatedInitialMargin: "7.3", liquidationBufferRatio: "0.5",
      decisionReasonCode: `${TAG}-${sequence}`,
    },
  });
}

/** Each row gets its own day, so the natural-identity unique holds. */
async function windowRow(
  executionProfileId: string,
  dayOffset = 0,
  overrides: Record<string, unknown> = {}
) {
  const start = DAY_START + dayOffset * DAY;
  return prisma!.exchangeFillIngestWindow.create({
    data: {
      executionProfileId, symbol: SYMBOL_A,
      startTimeMs: BigInt(start), endTimeMs: BigInt(start + DAY - 1),
      ...overrides,
    },
  });
}

/** Every historical table this profile could touch, as one comparable shape. */
const countsFor = async (executionProfileId: string) => ({
  windows: await prisma!.exchangeFillIngestWindow.count({ where: { executionProfileId } }),
  campaigns: await prisma!.historicalFillCampaign.count({ where: { executionProfileId } }),
  breakers: await prisma!.historicalFillCircuitBreaker.count({ where: { executionProfileId } }),
  buckets: await prisma!.historicalFillWeightBucket.count({ where: { executionProfileId } }),
  executions: await prisma!.tradeExecution.count({ where: { executionProfileId } }),
  ledger: await prisma!.exchangeFillLedger.count({ where: { executionProfileId } }),
});

beforeAll(async () => {
  if (!prisma || !available) return;
  campaigns = new HistoricalFillCampaignService(prisma);
});

beforeEach(() => {
  sequence += 1;
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    const profiles = (
      await prisma.executionProfile.findMany({
        where: { accountIdentifier: { startsWith: TAG } },
        select: { id: true },
      })
    ).map((row) => row.id);
    await prisma.historicalFillCircuitBreaker.deleteMany({ where: { executionProfileId: { in: profiles } } });
    await prisma.historicalFillCampaign.deleteMany({ where: { executionProfileId: { in: profiles } } });
    await prisma.exchangeFillIngestWindow.deleteMany({ where: { executionProfileId: { in: profiles }, parentId: { not: null } } });
    await prisma.exchangeFillIngestWindow.deleteMany({ where: { executionProfileId: { in: profiles } } });
    await prisma.executionEvent.deleteMany({ where: { tradeExecution: { executionProfileId: { in: profiles } } } });
    await prisma.tradeExecution.deleteMany({ where: { executionProfileId: { in: profiles } } });
    await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: { in: profiles } } });
    await prisma.executionProfile.deleteMany({ where: { id: { in: profiles } } });
  }
  await prisma.$disconnect();
});

describe("horizon explicitness is read from raw key presence, never from the value", () => {
  // Deterministic: the raw record is injected, so nothing here depends on the
  // test machine's ambient environment or on what `.env` happens to contain.
  it("treats an absent key as DEFAULT", () => {
    expect(horizonSourceOf({})).toBe("DEFAULT");
  });

  it("treats an empty or whitespace value as DEFAULT", () => {
    expect(horizonSourceOf({ [INGEST_HORIZON_KEY]: "" })).toBe("DEFAULT");
    expect(horizonSourceOf({ [INGEST_HORIZON_KEY]: "   " })).toBe("DEFAULT");
  });

  it("treats an explicit 30 as EXPLICIT even though 30 is also the default", () => {
    // The distinction the whole gate exists for.
    expect(horizonSourceOf({ [INGEST_HORIZON_KEY]: "30" })).toBe("EXPLICIT");
  });

  it("treats an explicit 3 as EXPLICIT", () => {
    expect(horizonSourceOf({ [INGEST_HORIZON_KEY]: "3" })).toBe("EXPLICIT");
  });

  it("is unaffected by other keys being present", () => {
    expect(horizonSourceOf({ EXECUTION_FILL_RUNTIME_ENABLED: "true" })).toBe("DEFAULT");
  });
});

describe("the durable facts are read correctly", () => {
  maybe()("counts distinct symbols for the bound profile only", async () => {
    const target = await profile("symbols");
    const stranger = await profile("stranger");
    // Duplicates must collapse; another account's symbols must not appear.
    await execution(target.id, SYMBOL_A);
    await execution(target.id, SYMBOL_A);
    await execution(target.id, SYMBOL_B);
    await execution(stranger.id, "OTHERUSDT");

    const state = await readPreflightState(prisma!, target.id);

    expect(state.symbolUniverseCount).toBe(2);
    expect((await readPreflightState(prisma!, stranger.id)).symbolUniverseCount).toBe(1);
  });

  maybe()("reports an ACTIVE campaign with its budget", async () => {
    const target = await profile("active");
    const campaign = await campaigns.createCampaign({
      executionProfileId: target.id,
      maxDispatches: 3,
    });

    const state = await readPreflightState(prisma!, target.id);

    expect(state.campaignStatus).toBe("ACTIVE");
    expect(state.campaignMaxDispatches).toBe(3);
    expect(state.campaignDispatchesUsed).toBe(0);
    expect(campaign.status).toBe("ACTIVE");
  });

  maybe()("reports PAUSED as PAUSED, not as ACTIVE", async () => {
    const target = await profile("paused");
    const campaign = await campaigns.createCampaign({
      executionProfileId: target.id,
      maxDispatches: 1,
    });
    await campaigns.pauseCampaign(campaign.id);

    expect((await readPreflightState(prisma!, target.id)).campaignStatus).toBe("PAUSED");
  });

  maybe()("reports no campaign at all as null", async () => {
    const target = await profile("nocampaign");

    const state = await readPreflightState(prisma!, target.id);

    expect(state.campaignStatus).toBeNull();
    expect(state.campaignMaxDispatches).toBeNull();
    expect(state.campaignDispatchesUsed).toBeNull();
  });

  maybe()("treats an ABORTED campaign as no live campaign", async () => {
    const target = await profile("aborted");
    const campaign = await campaigns.createCampaign({
      executionProfileId: target.id,
      maxDispatches: 1,
    });
    await campaigns.abortCampaign(campaign.id, null);

    expect((await readPreflightState(prisma!, target.id)).campaignStatus).toBeNull();
  });

  maybe()("reports an absent breaker row as CLOSED", async () => {
    const target = await profile("noscircuit");

    expect((await readPreflightState(prisma!, target.id)).circuitState).toBe("CLOSED");
  });

  maybe()("reports an OPEN breaker row as OPEN", async () => {
    const target = await profile("opencircuit");
    await prisma!.historicalFillCircuitBreaker.create({
      data: { executionProfileId: target.id, state: "OPEN", openedAt: new Date() },
    });

    expect((await readPreflightState(prisma!, target.id)).circuitState).toBe("OPEN");
  });

  maybe()("counts only pending windows at or above the attempt ceiling", async () => {
    const target = await profile("exhausted");
    await windowRow(target.id, 0, { attempts: MAX_INGEST_ATTEMPTS, claimedAt: new Date(), claimOwner: "w" });
    await windowRow(target.id, 1, { attempts: MAX_INGEST_ATTEMPTS - 1 });
    await windowRow(target.id, 2, { status: "ABANDONED", attempts: MAX_INGEST_ATTEMPTS });
    await windowRow(target.id, 3, { status: "COMPLETE", attempts: MAX_INGEST_ATTEMPTS });

    expect((await readPreflightState(prisma!, target.id)).attemptExhaustedCount).toBe(1);
  });

  maybe()("reports zero exhausted windows on a healthy profile", async () => {
    const target = await profile("healthy");
    await windowRow(target.id);

    expect((await readPreflightState(prisma!, target.id)).attemptExhaustedCount).toBe(0);
  });
});

describe("reading the state writes nothing", () => {
  maybe()("leaves every historical table exactly as it found it", async () => {
    const target = await profile("nowrite");
    await execution(target.id, SYMBOL_A);
    await campaigns.createCampaign({ executionProfileId: target.id, maxDispatches: 2 });
    const stuck = await windowRow(target.id, 0, {
      attempts: MAX_INGEST_ATTEMPTS,
      claimedAt: new Date(),
      claimOwner: "dead-worker",
    });
    const before = await countsFor(target.id);
    const windowBefore = await prisma!.exchangeFillIngestWindow.findUniqueOrThrow({
      where: { id: stuck.id },
    });

    // Twice, so even an idempotent-looking write would show up.
    await readPreflightState(prisma!, target.id);
    await readPreflightState(prisma!, target.id);

    expect(await countsFor(target.id)).toEqual(before);
    // Field-for-field, including updatedAt -- any touch would move it.
    expect(
      await prisma!.exchangeFillIngestWindow.findUniqueOrThrow({ where: { id: stuck.id } })
    ).toEqual(windowBefore);
    // No weight bucket was created by asking about the cap.
    expect(before.buckets).toBe(0);
  });
});
