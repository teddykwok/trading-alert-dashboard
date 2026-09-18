import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase, resolveTestDatabase } from "./helpers/test-database";
import {
  HistoricalFillBatchDriver,
  type FillIngestExecutionOutcome,
} from "../src/modules/execution/exchange-fill-batch-driver.service";
import { HistoricalFillWeightBudgetService } from "../src/modules/execution/historical-fill-weight-budget.service";
import { HistoricalFillCampaignGate } from "../src/modules/execution/historical-fill-campaign-gate.service";
import { HistoricalFillCampaignService } from "../src/modules/execution/historical-fill-campaign.service";
import { HistoricalFillCircuitBreakerService } from "../src/modules/execution/historical-fill-circuit-breaker.service";

/**
 * THE load-bearing proof: N worker processes do not multiply historical
 * exchange request production.
 *
 * Each simulated process gets its OWN PrismaClient, its OWN budget service and
 * its OWN driver — the only thing they share is the database, exactly as
 * separate worker processes would. A shared client would prove nothing.
 *
 * Executors are scripted, so no Binance client exists anywhere in this file or
 * in the code under test. What is measured is how much weight the drivers
 * COLLECTIVELY retain, which is precisely what would have been sent.
 *
 * Every dispatch now also passes the campaign gate, because the driver admits
 * through it. The campaign is deliberately sized far beyond anything these
 * tests can spend (100 slots against at most 30 possible dispatches), so the
 * SHARED MINUTE CEILING remains the only thing bounding the totals below —
 * which is the invariant this file exists to prove, and it is proven through
 * the campaign-aware path rather than around it.
 */

const TAG = "fill-weight-multiplication-synthetic";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const maybe = () => (available ? it : it.skip);

const clients: PrismaClient[] = [];
let profileId = "";

/**
 * One simulated worker process: own connection, own budget, own GATE, own driver.
 *
 * The database stays the only shared coordination point. A shared client, or a
 * shared gate, would prove only that one process agrees with itself.
 */
function workerProcess(outcome: FillIngestExecutionOutcome = "COMPLETE") {
  const client = new PrismaClient({ datasources: { db: { url: resolveTestDatabase().url } } });
  clients.push(client);
  return new HistoricalFillBatchDriver({
    // Required whenever a budget is wired. Real, on this worker's own client;
    // the default outcome here is COMPLETE, which the breaker treats as health.
    circuitBreaker: new HistoricalFillCircuitBreakerService(client),
    bootstrap: {
      bootstrapHistoricalRoots: async () => ({
        outcome: "BOOTSTRAPPED",
        executionProfileId: profileId,
        horizonDays: 30,
        symbolCount: 1,
        dayCount: 30,
        expectedRootCount: 30,
        alreadyCompatibleCount: 30,
        createdCount: 0,
        raceReconciledCount: 0,
      }),
    } as never,
    // Always a post-dispatch outcome, so every granted reservation is retained
    // — the worst case for aggregate production.
    executor: { executeOne: async () => ({ outcome }) } as never,
    weightBudget: new HistoricalFillWeightBudgetService(client),
    // The binder is injected because the real one reads process configuration,
    // which cannot name a synthetic profile. Everything below it is real: the
    // gate reads and writes the same campaign row every other worker sees.
    campaigns: new HistoricalFillCampaignGate({
      prisma: client,
      bindProfile: async () => ({ ok: true, context: { executionProfileId: profileId } }) as never,
    }),
  });
}

const runOne = (driver: HistoricalFillBatchDriver, cap: number) =>
  driver.runHistoricalFillBatch({
    workerId: `worker-${Math.random().toString(36).slice(2, 8)}`,
    now: new Date(),
    horizonDays: 30,
    // Each process's LOCAL budget is deliberately generous: 10 dispatches each.
    // Only the shared ceiling should bound the total.
    maxWindows: 10,
    maxUserTradesWeight: 50,
    globalUserTradesWeightPerMinute: cap,
  });

beforeAll(async () => {
  if (!prisma || !available) return;
  const profile = await prisma.executionProfile.create({
    data: {
      name: `${TAG} root`,
      exchange: "BINANCE",
      product: "USD_M_FUTURES",
      environment: "TESTNET",
      accountIdentifier: `${TAG}-${Date.now()}`,
    },
    select: { id: true },
  });
  profileId = profile.id;
  // Ample on purpose: 100 slots against at most 30 possible dispatches, so the
  // campaign can never be the bound these tests measure.
  await new HistoricalFillCampaignService(prisma).createCampaign({
    executionProfileId: profileId,
    maxDispatches: 100,
  });
});

afterAll(async () => {
  if (prisma && available) {
    await prisma.historicalFillWeightReservation.deleteMany({
      where: { bucket: { executionProfile: { name: { startsWith: TAG } } } },
    });
    await prisma.historicalFillWeightBucket.deleteMany({
      where: { executionProfile: { name: { startsWith: TAG } } },
    });
    // Campaigns are referenced by reservations with onDelete: Restrict, so they
    // go after those and before the profiles that own them.
    await prisma.historicalFillCampaign.deleteMany({
      where: { executionProfile: { name: { startsWith: TAG } } },
    });
    await prisma.executionProfile.deleteMany({ where: { name: { startsWith: TAG } } });
  }
  await Promise.all(clients.map((client) => client.$disconnect()));
  await prisma?.$disconnect();
});

/** Total weight the drivers RETAINED, i.e. what would have reached Binance. */
async function aggregateRetained(cap: number, processes: number): Promise<number> {
  const results = await Promise.all(
    Array.from({ length: processes }, () => runOne(workerProcess(), cap))
  );
  return results.reduce((total, result) => total + result.userTradesWeightUsed, 0);
}

describe("historical request production does not multiply by worker count", () => {
  maybe()("1 worker: bounded by the shared ceiling", async () => {
    await prisma!.historicalFillWeightReservation.deleteMany({
      where: { bucket: { executionProfileId: profileId } },
    });
    await prisma!.historicalFillWeightBucket.deleteMany({ where: { executionProfileId: profileId } });

    const retained = await aggregateRetained(25, 1);

    expect(retained).toBeLessThanOrEqual(25);
    expect(retained).toBe(25);
  });

  maybe()("2 workers: still bounded by ONE ceiling, not two", async () => {
    await prisma!.historicalFillWeightReservation.deleteMany({
      where: { bucket: { executionProfileId: profileId } },
    });
    await prisma!.historicalFillWeightBucket.deleteMany({ where: { executionProfileId: profileId } });

    const retained = await aggregateRetained(25, 2);

    // Without coordination each process would have retained up to its own local
    // budget of 50, so the uncoordinated worst case is 100.
    expect(retained).toBeLessThanOrEqual(25);

    const row = await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: profileId },
    });
    expect(row.weightUsed).toBeLessThanOrEqual(25);
  });

  maybe()("3 workers: aggregate retained weight never exceeds the shared cap", async () => {
    await prisma!.historicalFillWeightReservation.deleteMany({
      where: { bucket: { executionProfileId: profileId } },
    });
    await prisma!.historicalFillWeightBucket.deleteMany({ where: { executionProfileId: profileId } });

    const retained = await aggregateRetained(25, 3);

    expect(retained).toBeLessThanOrEqual(25);

    const rows = await prisma!.historicalFillWeightBucket.findMany({
      where: { executionProfileId: profileId },
    });
    // One shared row per minute, not one per process.
    for (const row of rows) expect(row.weightUsed).toBeLessThanOrEqual(row.weightCap);
    const total = rows.reduce((sum, row) => sum + row.weightUsed, 0);
    expect(total).toBeLessThanOrEqual(25 * rows.length);
  });

  maybe()("a denied worker reports the GLOBAL stop, never the local one", async () => {
    await prisma!.historicalFillWeightReservation.deleteMany({
      where: { bucket: { executionProfileId: profileId } },
    });
    await prisma!.historicalFillWeightBucket.deleteMany({ where: { executionProfileId: profileId } });

    // Cap of exactly one dispatch: the first process takes it, the second is
    // refused by the shared ceiling while its own local budget is untouched.
    const first = await runOne(workerProcess(), 5);
    const second = await runOne(workerProcess(), 5);

    expect(first.userTradesWeightUsed).toBe(5);
    expect(second.outcome).toBe("GLOBAL_USER_TRADES_WEIGHT_BUDGET_EXHAUSTED");
    expect(second.executionInvocations).toBe(0);
    expect(second.userTradesWeightUsed).toBe(0);
  });
});
