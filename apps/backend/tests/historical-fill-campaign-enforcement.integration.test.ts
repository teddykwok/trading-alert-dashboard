import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase, resolveTestDatabase } from "./helpers/test-database";
import {
  FillBatchInvariantError,
  HistoricalFillBatchDriver,
  type FillIngestExecutionOutcome,
} from "../src/modules/execution/exchange-fill-batch-driver.service";
import { HistoricalFillWeightBudgetService } from "../src/modules/execution/historical-fill-weight-budget.service";
import { HistoricalFillCampaignGate } from "../src/modules/execution/historical-fill-campaign-gate.service";
import { HistoricalFillCampaignService } from "../src/modules/execution/historical-fill-campaign.service";

/**
 * END-TO-END campaign enforcement at the driver seam, against a REAL Postgres.
 *
 * The campaign is the only bound in this subsystem that survives the next tick,
 * so the questions worth asking are all about what happens ACROSS batches: does
 * a profile with no campaign write anything at all, does an exhausted campaign
 * stay exhausted, does a pause take effect without restarting a worker. None of
 * that can be answered by a single call, and none of it can be answered against
 * a mocked budget -- the whole guarantee lives in durable rows.
 *
 * The bootstrap and the executor are scripted, so NO Binance client is
 * constructed here or in the code under test and no request is ever issued.
 * Everything between them -- the gate, the admission, the refund, the
 * completion predicate -- is the real implementation on the real database.
 */

const TAG = "fill-campaign-enforcement-synthetic";

/** Ample minute weight, so the CAMPAIGN is what these tests measure. */
const AMPLE_CAP = 500;

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const maybe = () => (available ? it : it.skip);

const clients: PrismaClient[] = [];
function independentClient(): PrismaClient {
  const client = new PrismaClient({ datasources: { db: { url: resolveTestDatabase().url } } });
  clients.push(client);
  return client;
}

let campaigns: HistoricalFillCampaignService;

async function makeProfile(suffix: string): Promise<string> {
  const profile = await prisma!.executionProfile.create({
    data: {
      name: `${TAG} ${suffix}`,
      exchange: "BINANCE",
      product: "USD_M_FUTURES",
      environment: "TESTNET",
      accountIdentifier: `${TAG}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
    select: { id: true },
  });
  return profile.id;
}

/**
 * One simulated worker: its own connection, budget, gate and driver.
 *
 * `bootstrapProfileId` defaults to the gate's profile; passing a different one
 * is how the gate/bootstrap disagreement is driven.
 */
function workerProcess(options: {
  executionProfileId: string;
  outcomes?: FillIngestExecutionOutcome[];
  throwOn?: number;
  bootstrapProfileId?: string;
  client?: PrismaClient;
}) {
  const client = options.client ?? independentClient();
  const queue = [...(options.outcomes ?? [])];
  let calls = 0;

  const executeOne = vi.fn(async () => {
    calls += 1;
    if (options.throwOn === calls) throw new Error("executor exploded");
    const outcome = queue.shift() ?? "NO_WORK";
    return outcome === "PROFILE_UNAVAILABLE"
      ? { outcome, reasonCode: "PROFILE_NOT_FOUND" }
      : { outcome };
  });

  const bootstrapHistoricalRoots = vi.fn(async () => ({
    outcome: "BOOTSTRAPPED" as const,
    executionProfileId: options.bootstrapProfileId ?? options.executionProfileId,
    horizonDays: 30,
    symbolCount: 1,
    dayCount: 30,
    expectedRootCount: 30,
    alreadyCompatibleCount: 30,
    createdCount: 0,
    raceReconciledCount: 0,
  }));

  const driver = new HistoricalFillBatchDriver({
    bootstrap: { bootstrapHistoricalRoots } as never,
    executor: { executeOne } as never,
    weightBudget: new HistoricalFillWeightBudgetService(client),
    campaigns: new HistoricalFillCampaignGate({
      prisma: client,
      // Injected because the real binder reads process configuration, which
      // cannot name a synthetic profile. Everything below it is real.
      bindProfile: async () =>
        ({ ok: true, context: { executionProfileId: options.executionProfileId } }) as never,
    }),
  });

  return { driver, executeOne, bootstrapHistoricalRoots };
}

const runBatch = (
  driver: HistoricalFillBatchDriver,
  overrides: Record<string, unknown> = {}
) =>
  driver.runHistoricalFillBatch({
    workerId: `worker-${Math.random().toString(36).slice(2, 8)}`,
    now: new Date(),
    horizonDays: 30,
    maxWindows: 5,
    maxUserTradesWeight: 50,
    globalUserTradesWeightPerMinute: AMPLE_CAP,
    ...overrides,
  } as never);

async function campaignRow(campaignId: string) {
  return prisma!.historicalFillCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { status: true, dispatchesUsed: true, maxDispatches: true, endedAt: true },
  });
}

/** Reservations whose weight is still charged, i.e. dispatches that count. */
async function retainedReservations(executionProfileId: string): Promise<number> {
  return prisma!.historicalFillWeightReservation.count({
    where: { bucket: { executionProfileId }, releasedAt: null },
  });
}

/** A PENDING window, in whichever awkward state the test needs. */
async function pendingWindow(
  executionProfileId: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const start = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1_000_000));
  await prisma!.exchangeFillIngestWindow.create({
    data: {
      executionProfileId,
      symbol: `SYN${Math.floor(Math.random() * 1_000_000)}USDT`,
      startTimeMs: start,
      endTimeMs: start + 1000n,
      status: "PENDING",
      ...overrides,
    },
  });
}

beforeAll(async () => {
  if (!prisma || !available) return;
  campaigns = new HistoricalFillCampaignService(prisma);
});

afterAll(async () => {
  if (prisma && available) {
    await prisma.exchangeFillIngestWindow.deleteMany({
      where: { executionProfile: { name: { startsWith: TAG } } },
    });
    await prisma.historicalFillWeightReservation.deleteMany({
      where: { bucket: { executionProfile: { name: { startsWith: TAG } } } },
    });
    await prisma.historicalFillWeightBucket.deleteMany({
      where: { executionProfile: { name: { startsWith: TAG } } },
    });
    await prisma.historicalFillCampaign.deleteMany({
      where: { executionProfile: { name: { startsWith: TAG } } },
    });
    await prisma.executionProfile.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.$disconnect();
  }
  await Promise.all(clients.map((client) => client.$disconnect()));
});

describe("nothing happens without an ACTIVE campaign", () => {
  maybe()("no campaign: zero bootstrap, zero claim, zero reservation, zero request", async () => {
    // THE regression this slice exists to prevent. A runtime left enabled with
    // no campaign must not create a single root, because bootstrap on a fresh
    // profile seeds a root per symbol per day and that is the expensive,
    // hard-to-undo half of a backfill.
    const executionProfileId = await makeProfile("no-campaign");
    const { driver, executeOne, bootstrapHistoricalRoots } = workerProcess({ executionProfileId });

    const result = await runBatch(driver);

    expect(result.outcome).toBe("NO_ACTIVE_FILL_CAMPAIGN");
    expect(bootstrapHistoricalRoots).not.toHaveBeenCalled();
    expect(executeOne).not.toHaveBeenCalled();
    expect(result.bootstrap).toBeNull();
    expect(result.executionInvocations).toBe(0);
    expect(result.userTradesWeightUsed).toBe(0);
    // Campaign metadata is all null: there has never been one to describe.
    expect(result.campaignId).toBeNull();
    expect(result.campaignStatus).toBeNull();
    expect(result.campaignDispatchesUsed).toBeNull();
    expect(result.campaignMaxDispatches).toBeNull();
    expect(result.campaignDispatchesRemaining).toBeNull();
    // And nothing durable was written.
    expect(await prisma!.historicalFillWeightBucket.count({ where: { executionProfileId } })).toBe(0);
    expect(await prisma!.exchangeFillIngestWindow.count({ where: { executionProfileId } })).toBe(0);
  });

  maybe().each(["PAUSED", "EXHAUSTED", "COMPLETED", "ABORTED"])(
    "%s campaign: zero bootstrap and zero request, with the status reported",
    async (status) => {
      const executionProfileId = await makeProfile(`state-${status}`);
      const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 5 });
      await prisma!.$executeRawUnsafe(
        `UPDATE "HistoricalFillCampaign" SET "status" = $1::"HistoricalFillCampaignStatus" WHERE "id" = $2`,
        status,
        campaign.id
      );
      const { driver, executeOne, bootstrapHistoricalRoots } = workerProcess({ executionProfileId });

      const result = await runBatch(driver);

      expect(result.outcome).toBe("NO_ACTIVE_FILL_CAMPAIGN");
      expect(bootstrapHistoricalRoots).not.toHaveBeenCalled();
      expect(executeOne).not.toHaveBeenCalled();
      // The metadata is what tells the five situations apart without five
      // separate stop reasons.
      expect(result.campaignStatus).toBe(status);
      expect(result.campaignId).toBe(campaign.id);
      expect(result.campaignDispatchesUsed).toBe(0);
      expect(result.campaignMaxDispatches).toBe(5);
      expect(await prisma!.historicalFillWeightBucket.count({ where: { executionProfileId } })).toBe(0);
    }
  );

  maybe()("an ACTIVE campaign bootstraps normally", async () => {
    const executionProfileId = await makeProfile("active-bootstrap");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 5 });
    const { driver, bootstrapHistoricalRoots } = workerProcess({
      executionProfileId,
      outcomes: ["COMPLETE"],
    });

    const result = await runBatch(driver, { maxWindows: 1 });

    expect(bootstrapHistoricalRoots).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("MAX_WINDOWS_REACHED");
    expect(result.bootstrap).not.toBeNull();
    expect(result.campaignId).toBe(campaign.id);
    expect(result.campaignDispatchesUsed).toBe(1);
    expect(result.campaignDispatchesRemaining).toBe(4);
  });

  maybe()("fails closed when the gate and the bootstrap bind different accounts", async () => {
    // Two independent binds are only safe if they agree. A campaign belonging
    // to one account must never authorise dispatches charged to another.
    const executionProfileId = await makeProfile("gate-profile");
    const otherProfileId = await makeProfile("bootstrap-profile");
    await campaigns.createCampaign({ executionProfileId, maxDispatches: 5 });
    const { driver, executeOne } = workerProcess({
      executionProfileId,
      bootstrapProfileId: otherProfileId,
      outcomes: ["COMPLETE"],
    });

    await expect(runBatch(driver)).rejects.toBeInstanceOf(FillBatchInvariantError);
    // Stopped before admission and before the executor: no slot, no weight.
    expect(executeOne).not.toHaveBeenCalled();
    expect(await retainedReservations(executionProfileId)).toBe(0);
    expect(await retainedReservations(otherProfileId)).toBe(0);
  });
});

describe("the campaign bounds dispatches ACROSS batches", () => {
  maybe()("N=1: exactly one dispatch, however many batches run", async () => {
    const executionProfileId = await makeProfile("across-n1");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 1 });
    const client = independentClient();

    // Five separate passes on the same worker, as five scheduler ticks would be.
    const results = [];
    for (let tick = 0; tick < 5; tick += 1) {
      const { driver } = workerProcess({
        executionProfileId,
        outcomes: ["COMPLETE", "COMPLETE", "COMPLETE"],
        client,
      });
      results.push(await runBatch(driver, { maxWindows: 3 }));
    }

    const dispatched = results.reduce((total, r) => total + r.userTradesWeightUsed / 5, 0);
    expect(dispatched).toBe(1);
    const row = await campaignRow(campaign.id);
    expect(row.dispatchesUsed).toBe(1);
    expect(row.status).toBe("EXHAUSTED");
    expect(row.endedAt).toBeInstanceOf(Date);
    // Every tick after the first stops on the gate, before the bootstrap.
    expect(results.slice(1).every((r) => r.outcome === "NO_ACTIVE_FILL_CAMPAIGN")).toBe(true);
    expect(results.slice(1).every((r) => r.bootstrap === null)).toBe(true);
    expect(await retainedReservations(executionProfileId)).toBe(1);
  });

  maybe()("N=1 with maxWindows=5: the window bound does not buy extra dispatches", async () => {
    const executionProfileId = await makeProfile("n1-windows5");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 1 });
    const { driver, executeOne } = workerProcess({
      executionProfileId,
      outcomes: ["COMPLETE", "COMPLETE", "COMPLETE", "COMPLETE", "COMPLETE"],
    });

    const result = await runBatch(driver, { maxWindows: 5 });

    // One admitted dispatch, then the campaign is EXHAUSTED and the second
    // iteration's admission finds no ACTIVE campaign.
    expect(executeOne).toHaveBeenCalledTimes(1);
    expect(result.userTradesWeightUsed).toBe(5);
    expect(result.outcome).toBe("NO_ACTIVE_FILL_CAMPAIGN");
    expect((await campaignRow(campaign.id)).dispatchesUsed).toBe(1);
  });

  maybe()("N=5 with maxWindows=1: five ticks each dispatch once, the sixth dispatches none", async () => {
    const executionProfileId = await makeProfile("n5-windows1");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 5 });
    const client = independentClient();

    const dispatchedPerTick: number[] = [];
    for (let tick = 0; tick < 6; tick += 1) {
      const { driver } = workerProcess({ executionProfileId, outcomes: ["COMPLETE"], client });
      const result = await runBatch(driver, { maxWindows: 1 });
      dispatchedPerTick.push(result.userTradesWeightUsed / 5);
    }

    expect(dispatchedPerTick).toEqual([1, 1, 1, 1, 1, 0]);
    const row = await campaignRow(campaign.id);
    expect(row.dispatchesUsed).toBe(5);
    expect(row.status).toBe("EXHAUSTED");
    expect(await retainedReservations(executionProfileId)).toBe(5);
  });

  maybe()("the local weight ceiling stops the pass BEFORE any campaign slot is spent", async () => {
    // A pass that cannot afford a dispatch locally has no business touching a
    // campaign other processes are contending for.
    const executionProfileId = await makeProfile("local-weight");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 5 });
    const { driver, executeOne } = workerProcess({
      executionProfileId,
      outcomes: ["COMPLETE", "COMPLETE"],
    });

    // A local budget of 5 affords exactly one dispatch; the second iteration
    // stops on the LOCAL ceiling.
    const result = await runBatch(driver, { maxWindows: 5, maxUserTradesWeight: 5 });

    expect(result.outcome).toBe("USER_TRADES_WEIGHT_BUDGET_EXHAUSTED");
    expect(executeOne).toHaveBeenCalledTimes(1);
    // Exactly one slot spent, not two: the local stop burned nothing.
    expect((await campaignRow(campaign.id)).dispatchesUsed).toBe(1);
    expect(await retainedReservations(executionProfileId)).toBe(1);
  });

  maybe()("a global-weight denial invokes no executor and consumes no campaign slot", async () => {
    const executionProfileId = await makeProfile("global-weight");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 5 });
    // A minute with no room left.
    const bucketStart = (
      await prisma!.$queryRawUnsafe<Array<{ bucket: Date }>>(
        `SELECT date_trunc('minute', (now() AT TIME ZONE 'UTC')) AS bucket`
      )
    )[0].bucket;
    await prisma!.historicalFillWeightBucket.create({
      data: { executionProfileId, bucketStart, weightCap: 5, weightUsed: 5 },
    });
    const { driver, executeOne } = workerProcess({ executionProfileId, outcomes: ["COMPLETE"] });

    const result = await runBatch(driver, { globalUserTradesWeightPerMinute: 5 });

    expect(result.outcome).toBe("GLOBAL_USER_TRADES_WEIGHT_BUDGET_EXHAUSTED");
    expect(executeOne).not.toHaveBeenCalled();
    // 2B.2 unwound the increment, so the campaign is untouched and still ACTIVE.
    const row = await campaignRow(campaign.id);
    expect(row.dispatchesUsed).toBe(0);
    expect(row.status).toBe("ACTIVE");
  });
});

describe("NO_WORK refunds first, and only then may complete", () => {
  maybe()("refunds both budgets and completes when no PENDING work remains", async () => {
    const executionProfileId = await makeProfile("nowork-complete");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 5 });
    const { driver } = workerProcess({ executionProfileId, outcomes: ["NO_WORK"] });

    const result = await runBatch(driver);

    expect(result.outcome).toBe("NO_WORK");
    // The refund happened: the slot came back and the weight came back.
    const row = await campaignRow(campaign.id);
    expect(row.dispatchesUsed).toBe(0);
    expect(await retainedReservations(executionProfileId)).toBe(0);
    // And only THEN did completion run.
    expect(row.status).toBe("COMPLETED");
    expect(row.endedAt).toBeInstanceOf(Date);
    expect(result.campaignStatus).toBe("COMPLETED");
  });

  maybe()("a refund never lands on a COMPLETED campaign, because it runs first", async () => {
    // 2B.2 makes refunding a COMPLETED campaign a fail-closed invariant throw.
    // The driver's ordering is why that is unreachable: with completion first,
    // this batch would raise instead of returning, and the weight and the slot
    // would both be stranded with releasedAt still null.
    const executionProfileId = await makeProfile("nowork-order");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 5 });
    const { driver } = workerProcess({ executionProfileId, outcomes: ["NO_WORK"] });

    await expect(runBatch(driver)).resolves.toMatchObject({ outcome: "NO_WORK" });

    const reservations = await prisma!.historicalFillWeightReservation.findMany({
      where: { campaignId: campaign.id },
      select: { releasedAt: true },
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0].releasedAt).toBeInstanceOf(Date);
    expect((await campaignRow(campaign.id)).status).toBe("COMPLETED");
  });

  maybe().each([
    ["a plain unclaimed row", {}],
    ["a row waiting out a retry backoff", { nextEligibleAt: new Date(Date.now() + 3_600_000) }],
    ["a row currently leased by another worker", { claimedAt: new Date(), claimOwner: "worker-x" }],
    ["a row that has exhausted its ingest attempts", { attempts: 5 }],
  ])("does not complete while %s is still PENDING", async (_label, overrides) => {
    // The predicate is PENDING rows with NO attempts filter. An
    // attempt-exhausted row is a declared gap in coverage; calling the campaign
    // COMPLETE while it sits there would turn "we gave up" into "we finished".
    const executionProfileId = await makeProfile("nowork-pending");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 5 });
    await pendingWindow(executionProfileId, overrides as Record<string, unknown>);
    const { driver } = workerProcess({ executionProfileId, outcomes: ["NO_WORK"] });

    const result = await runBatch(driver);

    const row = await campaignRow(campaign.id);
    expect(row.dispatchesUsed).toBe(0);
    expect(row.status).toBe("ACTIVE");
    expect(row.endedAt).toBeNull();
    expect(result.campaignStatus).toBe("ACTIVE");
  });

  maybe()("completes even when terminal rows exist, because those are finished facts", async () => {
    const executionProfileId = await makeProfile("nowork-terminal");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 5 });
    for (const status of ["ABANDONED", "INCOMPLETE_SKIPPED_ROWS", "SATURATED_SINGLE_MILLISECOND"]) {
      await pendingWindow(executionProfileId, { status });
    }
    const { driver } = workerProcess({ executionProfileId, outcomes: ["NO_WORK"] });

    await runBatch(driver);

    expect((await campaignRow(campaign.id)).status).toBe("COMPLETED");
  });

  maybe()("never relabels an EXHAUSTED campaign as COMPLETED", async () => {
    // EXHAUSTED means the budget ended it; COMPLETED means the queue drained
    // first. A campaign that spends its last slot and then finds an empty queue
    // must stay EXHAUSTED.
    const executionProfileId = await makeProfile("exhausted-not-completed");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 1 });
    const { driver } = workerProcess({ executionProfileId, outcomes: ["COMPLETE", "NO_WORK"] });

    await runBatch(driver, { maxWindows: 3 });

    const row = await campaignRow(campaign.id);
    expect(row.status).toBe("EXHAUSTED");
    expect(row.dispatchesUsed).toBe(1);
  });
});

describe("outcomes that are not proven zero-dispatch keep their slot", () => {
  maybe()("PROFILE_UNAVAILABLE refunds both budgets but never completes", async () => {
    const executionProfileId = await makeProfile("profile-unavailable");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 5 });
    const { driver } = workerProcess({ executionProfileId, outcomes: ["PROFILE_UNAVAILABLE"] });

    const result = await runBatch(driver);

    expect(result.outcome).toBe("PROFILE_UNAVAILABLE");
    const row = await campaignRow(campaign.id);
    // Refunded — the executor never reached the transport.
    expect(row.dispatchesUsed).toBe(0);
    expect(await retainedReservations(executionProfileId)).toBe(0);
    // But an unusable profile is not a drained queue.
    expect(row.status).toBe("ACTIVE");
    expect(row.endedAt).toBeNull();
  });

  maybe()("a throw keeps the slot and the weight: dispatch is UNKNOWN, not absent", async () => {
    const executionProfileId = await makeProfile("throw");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 5 });
    const { driver } = workerProcess({ executionProfileId, throwOn: 1 });

    await expect(runBatch(driver)).rejects.toThrow("executor exploded");

    const row = await campaignRow(campaign.id);
    // An exception proves nothing about whether the request went out, so the
    // slot stays spent. Over-counting costs throughput; under-counting spends
    // the account's allowance twice.
    expect(row.dispatchesUsed).toBe(1);
    expect(await retainedReservations(executionProfileId)).toBe(1);
  });

  maybe()("a throw on the final slot leaves the campaign EXHAUSTED", async () => {
    const executionProfileId = await makeProfile("throw-final");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 1 });
    const { driver } = workerProcess({ executionProfileId, throwOn: 1 });

    await expect(runBatch(driver)).rejects.toThrow("executor exploded");

    const row = await campaignRow(campaign.id);
    expect(row.status).toBe("EXHAUSTED");
    expect(row.dispatchesUsed).toBe(1);
  });

  maybe().each([
    "SPLIT",
    "RETRY_SCHEDULED",
    "INCOMPLETE_SKIPPED_ROWS",
    "SATURATED_SINGLE_MILLISECOND",
    "ABANDONED",
    "STALE_CLAIM",
  ])("%s consumes one campaign slot per invocation and is never refunded", async (outcome) => {
    const executionProfileId = await makeProfile(`retain-${outcome}`);
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 5 });
    const { driver } = workerProcess({
      executionProfileId,
      outcomes: [outcome as FillIngestExecutionOutcome, outcome as FillIngestExecutionOutcome],
    });

    await runBatch(driver, { maxWindows: 2 });

    // Two invocations, two dispatches, two slots. A split's child and a retried
    // window each need their own admission next time round.
    const row = await campaignRow(campaign.id);
    expect(row.dispatchesUsed).toBe(2);
    expect(await retainedReservations(executionProfileId)).toBe(2);
  });
});

describe("many workers share one campaign", () => {
  maybe()("N=1: four concurrent workers produce exactly one dispatch", async () => {
    const executionProfileId = await makeProfile("multi-n1");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 1 });
    const workers = Array.from({ length: 4 }, () =>
      workerProcess({ executionProfileId, outcomes: ["COMPLETE", "COMPLETE"] })
    );

    const results = await Promise.all(
      workers.map(({ driver }) => runBatch(driver, { maxWindows: 2 }))
    );

    const dispatched = results.reduce((total, r) => total + r.userTradesWeightUsed / 5, 0);
    expect(dispatched).toBe(1);
    const row = await campaignRow(campaign.id);
    expect(row.dispatchesUsed).toBe(1);
    expect(row.status).toBe("EXHAUSTED");
    expect(await retainedReservations(executionProfileId)).toBe(1);
  });

  maybe()("N=5: eight concurrent workers produce exactly five dispatches", async () => {
    const executionProfileId = await makeProfile("multi-n5");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 5 });
    const workers = Array.from({ length: 8 }, () =>
      workerProcess({
        executionProfileId,
        outcomes: ["COMPLETE", "COMPLETE", "COMPLETE"],
      })
    );

    const results = await Promise.all(
      workers.map(({ driver }) => runBatch(driver, { maxWindows: 3 }))
    );

    const dispatched = results.reduce((total, r) => total + r.userTradesWeightUsed / 5, 0);
    expect(dispatched).toBe(5);
    const row = await campaignRow(campaign.id);
    expect(row.dispatchesUsed).toBe(5);
    expect(row.status).toBe("EXHAUSTED");
    expect(await retainedReservations(executionProfileId)).toBe(5);
  });
});

describe("operator control takes effect without restarting a worker", () => {
  maybe()("pause stops the next batch; resume lets it spend the remainder", async () => {
    // THE safe runtime pause: the runtime stays enabled and the worker keeps
    // running. Only a durable row changed, and the next tick observes it.
    const executionProfileId = await makeProfile("pause-resume");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 5 });
    const client = independentClient();

    const first = workerProcess({ executionProfileId, outcomes: ["COMPLETE"], client });
    await runBatch(first.driver, { maxWindows: 1 });
    expect((await campaignRow(campaign.id)).dispatchesUsed).toBe(1);

    await campaigns.pauseCampaign(campaign.id);

    const paused = workerProcess({ executionProfileId, outcomes: ["COMPLETE"], client });
    const pausedResult = await runBatch(paused.driver, { maxWindows: 1 });
    expect(pausedResult.outcome).toBe("NO_ACTIVE_FILL_CAMPAIGN");
    expect(paused.bootstrapHistoricalRoots).not.toHaveBeenCalled();
    expect(paused.executeOne).not.toHaveBeenCalled();
    expect((await campaignRow(campaign.id)).dispatchesUsed).toBe(1);

    await campaigns.resumeCampaign(campaign.id);

    const resumed = workerProcess({ executionProfileId, outcomes: ["COMPLETE"], client });
    await runBatch(resumed.driver, { maxWindows: 1 });
    const row = await campaignRow(campaign.id);
    expect(row.dispatchesUsed).toBe(2);
    expect(row.status).toBe("ACTIVE");
  });

  maybe()("abort prevents every future admission", async () => {
    const executionProfileId = await makeProfile("abort");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 5 });
    const client = independentClient();

    const before = workerProcess({ executionProfileId, outcomes: ["COMPLETE"], client });
    await runBatch(before.driver, { maxWindows: 1 });

    await campaigns.abortCampaign(campaign.id, "operator stopped it");

    const after = workerProcess({ executionProfileId, outcomes: ["COMPLETE"], client });
    const result = await runBatch(after.driver, { maxWindows: 3 });

    expect(result.outcome).toBe("NO_ACTIVE_FILL_CAMPAIGN");
    expect(result.campaignStatus).toBe("ABORTED");
    expect(after.executeOne).not.toHaveBeenCalled();
    // The in-flight dispatch from before the abort keeps its slot.
    const row = await campaignRow(campaign.id);
    expect(row.dispatchesUsed).toBe(1);
    expect(row.status).toBe("ABORTED");
  });

  maybe()("a late zero-dispatch refund after an abort never resurrects the campaign", async () => {
    const executionProfileId = await makeProfile("abort-late-refund");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 1 });
    const budget = new HistoricalFillWeightBudgetService(prisma!);

    const admitted = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    if (admitted.outcome !== "ADMITTED") throw new Error("unreachable");
    expect((await campaignRow(campaign.id)).status).toBe("EXHAUSTED");

    await campaigns.abortCampaign(campaign.id);
    await budget.releaseCertainNonDispatch(admitted.reservation);

    const row = await campaignRow(campaign.id);
    // The counter comes back, the abort stands.
    expect(row.dispatchesUsed).toBe(0);
    expect(row.status).toBe("ABORTED");
    expect(await campaigns.getLiveCampaign(executionProfileId)).toBeNull();

    // And a later batch still admits nothing.
    const { driver, executeOne } = workerProcess({ executionProfileId, outcomes: ["COMPLETE"] });
    const result = await runBatch(driver);
    expect(result.outcome).toBe("NO_ACTIVE_FILL_CAMPAIGN");
    expect(executeOne).not.toHaveBeenCalled();
  });
});
