import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase, resolveTestDatabase } from "./helpers/test-database";
import {
  HistoricalFillBatchDriver,
  type FillIngestExecutionOutcome,
} from "../src/modules/execution/exchange-fill-batch-driver.service";
import { HistoricalFillWeightBudgetService } from "../src/modules/execution/historical-fill-weight-budget.service";
import {
  HistoricalFillCampaignGate,
  type HistoricalFillCampaignGateResult,
} from "../src/modules/execution/historical-fill-campaign-gate.service";
import { HistoricalFillCampaignService } from "../src/modules/execution/historical-fill-campaign.service";
import { HistoricalFillCircuitBreakerService } from "../src/modules/execution/historical-fill-circuit-breaker.service";

/**
 * The circuit at the DRIVER seam, against a REAL Postgres.
 *
 * Two questions, and they are different questions. The first is what an OPEN
 * latch costs when the gate sees it: the answer must be nothing at all, not one
 * root written and not one window claimed. The second is what happens when the
 * gate does NOT see it -- because it was read a moment too early -- and that is
 * the one that proves the authoritative re-check inside admission is
 * load-bearing rather than belt-and-braces.
 *
 * The bootstrap and the executor are scripted, so NO Binance client is
 * constructed here or in the code under test and no request is ever issued.
 * The gate, the admission and the budget are the real implementations on the
 * real database.
 */

const TAG = "fill-circuit-driver-synthetic";
const AMPLE_CAP = 500;
const SYSTEMIC = { outcome: "ABANDONED", reasonCode: "AUTH" } as const;

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
let breaker: HistoricalFillCircuitBreakerService;

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

async function withCampaign(suffix: string, maxDispatches = 10) {
  const executionProfileId = await makeProfile(suffix);
  const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches });
  return { executionProfileId, campaignId: campaign.id };
}

/**
 * One simulated worker.
 *
 * `gateOverride` is how the STALE gate is produced: the real gate is resolved
 * first, its ACTIVE answer captured, and the driver then handed that captured
 * answer after the world has moved on. That reproduces the real race exactly --
 * an unlocked read that was true when taken -- without sleeping on a scheduler.
 */
function workerProcess(options: {
  executionProfileId: string;
  outcomes?: FillIngestExecutionOutcome[];
  gateOverride?: HistoricalFillCampaignGateResult;
  client?: PrismaClient;
}) {
  const client = options.client ?? independentClient();
  const queue = [...(options.outcomes ?? [])];

  const executeOne = vi.fn(async () => {
    const outcome = queue.shift() ?? "NO_WORK";
    return outcome === "PROFILE_UNAVAILABLE"
      ? { outcome, reasonCode: "PROFILE_NOT_FOUND" }
      : { outcome };
  });

  const bootstrapHistoricalRoots = vi.fn(async () => ({
    outcome: "BOOTSTRAPPED" as const,
    executionProfileId: options.executionProfileId,
    horizonDays: 30,
    symbolCount: 1,
    dayCount: 30,
    expectedRootCount: 30,
    alreadyCompatibleCount: 30,
    createdCount: 0,
    raceReconciledCount: 0,
  }));

  const gate = new HistoricalFillCampaignGate({
    prisma: client,
    // Injected because the real binder reads process configuration, which
    // cannot name a synthetic profile. Everything below it is real.
    bindProfile: async () =>
      ({ ok: true, context: { executionProfileId: options.executionProfileId } }) as never,
  });

  const campaignsDep =
    options.gateOverride === undefined
      ? gate
      : ({
          resolveForBatch: async () => options.gateOverride!,
          describeCampaign: (id: string) => gate.describeCampaign(id),
          completeIfDrained: (profile: string, id: string) => gate.completeIfDrained(profile, id),
        } as HistoricalFillCampaignGate);

  const driver = new HistoricalFillBatchDriver({
    bootstrap: { bootstrapHistoricalRoots } as never,
    executor: { executeOne } as never,
    weightBudget: new HistoricalFillWeightBudgetService(client),
    campaigns: campaignsDep,
  });

  return { driver, executeOne, bootstrapHistoricalRoots, gate };
}

const runBatch = (driver: HistoricalFillBatchDriver, overrides: Record<string, unknown> = {}) =>
  driver.runHistoricalFillBatch({
    workerId: `${TAG}-worker`,
    now: new Date(),
    horizonDays: 30,
    maxWindows: 3,
    maxUserTradesWeight: 50,
    globalUserTradesWeightPerMinute: AMPLE_CAP,
    ...overrides,
  } as never);

beforeAll(() => {
  if (!prisma) return;
  campaigns = new HistoricalFillCampaignService(prisma);
  breaker = new HistoricalFillCircuitBreakerService(prisma);
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()));
});

describe("an OPEN latch stops the pass BEFORE the bootstrap", () => {
  maybe()("writes nothing, calls nothing, and says why", async () => {
    const { executionProfileId, campaignId } = await withCampaign("gate-open");
    const opened = await breaker.observeDispatchOutcome({
      executionProfileId,
      campaignId,
      ...SYSTEMIC,
    });
    expect(opened.result).toBe("CIRCUIT_OPENED");

    const worker = workerProcess({ executionProfileId });
    const result = await runBatch(worker.driver);

    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    expect(result.bootstrap).toBeNull();
    expect(result.executionInvocations).toBe(0);
    // THE MANDATORY PART: not one call to either side of the pass.
    expect(worker.bootstrapHistoricalRoots).not.toHaveBeenCalled();
    expect(worker.executeOne).not.toHaveBeenCalled();

    // And not one row anywhere.
    expect(
      await prisma!.historicalFillWeightBucket.count({ where: { executionProfileId } })
    ).toBe(0);
    expect(await prisma!.historicalFillWeightReservation.count({ where: { campaignId } })).toBe(0);
    const campaign = await prisma!.historicalFillCampaign.findUniqueOrThrow({
      where: { id: campaignId },
    });
    expect(campaign.dispatchesUsed).toBe(0);
    expect(campaign.lastAdmissionAt).toBeNull();
    expect(result.userTradesWeightUsed).toBe(0);
  });

  maybe()("reports the gate's own snapshot, unaltered", async () => {
    const { executionProfileId, campaignId } = await withCampaign("gate-open-metadata");
    const opened = await breaker.observeDispatchOutcome({
      executionProfileId,
      campaignId,
      ...SYSTEMIC,
    });

    const result = await runBatch(workerProcess({ executionProfileId }).driver);
    if (result.outcome !== "SYSTEMIC_CIRCUIT_OPEN") throw new Error("unreachable");

    expect(result.circuit).toEqual({
      state: "OPEN",
      failureFamily: "HARD_CONFIGURATION",
      lastReasonCode: "AUTH",
      consecutiveCount: 1,
      openedAt: opened.circuit.openedAt,
    });
    // The campaign the trip paused is still described, so an operator reading
    // the summary sees WHICH backfill was stopped.
    expect(result.campaignId).toBe(campaignId);
    expect(result.campaignStatus).toBe("PAUSED");
  });

  maybe()("the gate OUTRANKS an ACTIVE campaign", async () => {
    // Corruption, or a state an older race left behind. The campaign says go,
    // the latch says stop, and the latch must win.
    const { executionProfileId, campaignId } = await withCampaign("gate-open-outranks");
    await breaker.observeDispatchOutcome({ executionProfileId, campaignId, ...SYSTEMIC });
    await prisma!.$executeRawUnsafe(
      `UPDATE "HistoricalFillCampaign" SET "status" = 'ACTIVE' WHERE "id" = $1`,
      campaignId
    );

    const worker = workerProcess({ executionProfileId });
    const gateResult = await worker.gate.resolveForBatch();
    expect(gateResult.outcome).toBe("CIRCUIT_OPEN");

    const result = await runBatch(worker.driver);
    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    expect(worker.bootstrapHistoricalRoots).not.toHaveBeenCalled();
  });

  maybe()("a CLOSED latch leaves the gate exactly as it was", async () => {
    const { executionProfileId } = await withCampaign("gate-closed-unchanged");
    const worker = workerProcess({ executionProfileId });

    const gateResult = await worker.gate.resolveForBatch();
    expect(gateResult.outcome).toBe("ACTIVE");

    const result = await runBatch(worker.driver, { maxWindows: 1 });
    expect(result.outcome).toBe("NO_WORK");
    expect(worker.bootstrapHistoricalRoots).toHaveBeenCalledTimes(1);
    expect(worker.executeOne).toHaveBeenCalledTimes(1);
  });
});

describe("a STALE gate is caught by the authoritative admission", () => {
  maybe()("refuses at admission and never reaches the executor", async () => {
    const { executionProfileId, campaignId } = await withCampaign("stale-gate");

    // The gate is resolved HERE, while the latch is still closed -- a real,
    // truthful ACTIVE answer.
    const reader = workerProcess({ executionProfileId });
    const stale = await reader.gate.resolveForBatch();
    expect(stale.outcome).toBe("ACTIVE");

    // ...and the world moves on, exactly as another worker would move it.
    const opened = await breaker.observeDispatchOutcome({
      executionProfileId,
      campaignId,
      ...SYSTEMIC,
    });
    expect(opened.result).toBe("CIRCUIT_OPENED");

    const worker = workerProcess({ executionProfileId, gateOverride: stale });
    const result = await runBatch(worker.driver);

    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    // THE PROOF: the re-check inside admission is what stopped this, and it
    // stopped it before the request rather than after.
    expect(worker.executeOne).not.toHaveBeenCalled();
    expect(result.executionInvocations).toBe(0);

    // The bootstrap DID run -- the gate waved the pass through before the trip
    // -- and the result says so rather than pretending otherwise.
    expect(worker.bootstrapHistoricalRoots).toHaveBeenCalledTimes(1);
    expect(result.bootstrap).not.toBeNull();

    // Nothing was spent by the denial.
    const campaign = await prisma!.historicalFillCampaign.findUniqueOrThrow({
      where: { id: campaignId },
    });
    expect(campaign.dispatchesUsed).toBe(0);
    expect(campaign.lastAdmissionAt).toBeNull();
    expect(await prisma!.historicalFillWeightReservation.count({ where: { campaignId } })).toBe(0);
    expect(result.userTradesWeightUsed).toBe(0);
  });

  maybe()("reports the ADMISSION's snapshot and the campaign as it now stands", async () => {
    const { executionProfileId, campaignId } = await withCampaign("stale-gate-metadata");
    const reader = workerProcess({ executionProfileId });
    const stale = await reader.gate.resolveForBatch();
    if (stale.outcome !== "ACTIVE") throw new Error("unreachable");
    expect(stale.campaign.status).toBe("ACTIVE");

    const opened = await breaker.observeDispatchOutcome({
      executionProfileId,
      campaignId,
      ...SYSTEMIC,
    });

    const result = await runBatch(
      workerProcess({ executionProfileId, gateOverride: stale }).driver
    );
    if (result.outcome !== "SYSTEMIC_CIRCUIT_OPEN") throw new Error("unreachable");

    expect(result.circuit.openedAt).toEqual(opened.circuit.openedAt);
    expect(result.circuit.lastReasonCode).toBe("AUTH");
    // NOT the gate's stale ACTIVE: the trip paused it, and the summary must
    // say what is true rather than what was read.
    expect(result.campaignId).toBe(campaignId);
    expect(result.campaignStatus).toBe("PAUSED");
  });
});
