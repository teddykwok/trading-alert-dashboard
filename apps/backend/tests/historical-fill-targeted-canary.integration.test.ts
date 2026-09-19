import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

const { BinanceError } = await import("../src/modules/binance/binance.errors");

/**
 * The targeted one-window canary, end to end against a REAL Postgres.
 *
 * Every protection is the real one: the real campaign service, the real shared
 * weight budget, the real circuit breaker, the real claim and the real ledger.
 * The ONLY stub is the exchange reader, because the whole point of this slice
 * is that exactly one request would be made and none may be made from a test.
 *
 * What these prove is that a human-named window travels the same guarded route
 * a scheduled one does -- and that every refusal costs zero exchange requests.
 */

const TAG = "canary-orch";
const SYMBOL = "CANARYUSDT";
const DAY = 86_400_000;
const DAY_START = Date.UTC(2026, 8, 15);
const NOW = new Date("2026-09-18T12:00:00.000Z");
const CAP = 5;

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ExchangeFillIngestWindowService } = await import(
  "../src/modules/execution/exchange-fill-ingest-window.service"
);
const { ExchangeFillLedgerService } = await import(
  "../src/modules/execution/exchange-fill-ledger.service"
);
const { ExchangeFillOneWindowExecutor } = await import(
  "../src/modules/execution/exchange-fill-one-window-executor.service"
);
const { HistoricalFillCampaignService } = await import(
  "../src/modules/execution/historical-fill-campaign.service"
);
const { HistoricalFillCircuitBreakerService } = await import(
  "../src/modules/execution/historical-fill-circuit-breaker.service"
);
const { HistoricalFillWeightBudgetService } = await import(
  "../src/modules/execution/historical-fill-weight-budget.service"
);
const { HistoricalFillTargetedCanary } = await import(
  "../src/modules/execution/historical-fill-targeted-canary.service"
);

const maybe = () => (available ? it : it.skip);

let work: InstanceType<typeof ExchangeFillIngestWindowService>;
let ledger: InstanceType<typeof ExchangeFillLedgerService>;
let campaigns: InstanceType<typeof HistoricalFillCampaignService>;
let weightBudget: InstanceType<typeof HistoricalFillWeightBudgetService>;
let circuitBreaker: InstanceType<typeof HistoricalFillCircuitBreakerService>;
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

async function windowRow(executionProfileId: string, overrides: Record<string, unknown> = {}) {
  return prisma!.exchangeFillIngestWindow.create({
    data: {
      executionProfileId,
      symbol: SYMBOL,
      startTimeMs: BigInt(DAY_START),
      endTimeMs: BigInt(DAY_START + DAY - 1),
      ...overrides,
    },
  });
}

function trade(overrides: Record<string, unknown> = {}) {
  return {
    tradeId: "9001",
    orderId: "88001",
    symbol: SYMBOL,
    side: "SELL",
    positionSide: "LONG" as const,
    quantity: "68.8",
    price: "1.0925",
    quoteQuantity: "75.1640",
    realizedPnl: "2.24936",
    commission: "0.03006560",
    commissionAsset: "USDT",
    maker: false,
    timeMs: DAY_START + 12 * 3_600_000,
    ...overrides,
  };
}

/** The exchange, counted. Every test asserts how many times this was reached. */
function fakeReader(answer: () => unknown[] | never) {
  const listRecentTradesOnce = vi.fn(async () => answer() as never);
  return { listRecentTradesOnce };
}

/** The canary over entirely real services, bound to one test's own profile. */
function canaryFor(
  executionProfileId: string,
  reader: { listRecentTradesOnce: ReturnType<typeof vi.fn> },
  overrides: Record<string, unknown> = {}
) {
  return new HistoricalFillTargetedCanary({
    prisma: prisma!,
    executor: new ExchangeFillOneWindowExecutor({
      prisma: prisma!,
      reader: reader as never,
      ledger,
      work,
      bindProfile: async () =>
        ({ ok: true, context: { executionProfileId, environment: "TESTNET" } }) as never,
    }),
    campaigns,
    weightBudget,
    circuitBreaker,
    weightCap: CAP,
    bindProfile: async () =>
      ({ ok: true, context: { executionProfileId, environment: "TESTNET" } }) as never,
    ...overrides,
  } as never);
}

const run = (canary: InstanceType<typeof HistoricalFillTargetedCanary>, windowId: string) =>
  canary.run({ workerId: "canary-op", windowId, now: NOW });

const rowOf = (id: string) =>
  prisma!.exchangeFillIngestWindow.findUniqueOrThrow({ where: { id } });

const reservationsFor = async (executionProfileId: string) =>
  prisma!.historicalFillWeightReservation.findMany({
    where: { bucket: { executionProfileId } },
  });

beforeAll(async () => {
  if (!prisma || !available) return;
  work = new ExchangeFillIngestWindowService(prisma);
  ledger = new ExchangeFillLedgerService(prisma);
  campaigns = new HistoricalFillCampaignService(prisma);
  weightBudget = new HistoricalFillWeightBudgetService(prisma);
  circuitBreaker = new HistoricalFillCircuitBreakerService(prisma);
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
    await prisma.exchangeFillLedger.deleteMany({
      where: { executionProfileId: { in: profiles } },
    });
    await prisma.historicalFillWeightReservation.deleteMany({
      where: { bucket: { executionProfileId: { in: profiles } } },
    });
    await prisma.historicalFillWeightBucket.deleteMany({
      where: { executionProfileId: { in: profiles } },
    });
    await prisma.historicalFillCircuitBreaker.deleteMany({
      where: { executionProfileId: { in: profiles } },
    });
    await prisma.historicalFillCampaign.deleteMany({
      where: { executionProfileId: { in: profiles } },
    });
    await prisma.exchangeFillIngestWindow.deleteMany({
      where: { executionProfileId: { in: profiles }, parentId: { not: null } },
    });
    await prisma.exchangeFillIngestWindow.deleteMany({
      where: { executionProfileId: { in: profiles } },
    });
    await prisma.executionSafetyPolicy.deleteMany({
      where: { executionProfileId: { in: profiles } },
    });
    await prisma.executionProfile.deleteMany({ where: { id: { in: profiles } } });
  }
  await prisma.$disconnect();
});

describe("one supervised request, through every existing protection", () => {
  maybe()("executes the named window and spends exactly one request", async () => {
    const target = await profile("happy");
    const wanted = await windowRow(target.id);
    await campaigns.createCampaign({ executionProfileId: target.id, maxDispatches: 1 });
    const reader = fakeReader(() => []);

    const result = await run(canaryFor(target.id, reader), wanted.id);

    expect(result.outcome).toBe("EXECUTED");
    expect(result.executorOutcome).toBe("COMPLETE");
    expect(result.userTradesRequests).toBe(1);
    expect(result.userTradesWeightUsed).toBe(5);
    expect(reader.listRecentTradesOnce).toHaveBeenCalledTimes(1);
    expect(result.windowId).toBe(wanted.id);
    expect(result.symbol).toBe(SYMBOL);
    // The cap-1 campaign spent its only slot and is therefore finished.
    expect(result.campaignStatus).toBe("EXHAUSTED");
    expect(result.dispatchesUsed).toBe(1);
    expect(result.maxDispatches).toBe(1);
    expect((await rowOf(wanted.id)).status).toBe("COMPLETE");
  });

  maybe()("charges the shared weight budget exactly once", async () => {
    const target = await profile("weight");
    const wanted = await windowRow(target.id);
    await campaigns.createCampaign({ executionProfileId: target.id, maxDispatches: 1 });

    await run(canaryFor(target.id, fakeReader(() => [])), wanted.id);

    const buckets = await prisma!.historicalFillWeightBucket.findMany({
      where: { executionProfileId: target.id },
    });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.weightUsed).toBe(5);
    expect(buckets[0]!.weightCap).toBe(CAP);
    const reservations = await reservationsFor(target.id);
    expect(reservations).toHaveLength(1);
    // A dispatch happened, so the grant is NOT released.
    expect(reservations[0]!.releasedAt).toBeNull();
  });

  maybe()("runs while the historical runtime flag is false", async () => {
    // The command never reads EXECUTION_FILL_RUNTIME_ENABLED. This asserts the
    // property that matters: an explicit invocation works in the dormant state
    // a canary is actually run in.
    const target = await profile("dormant");
    const wanted = await windowRow(target.id);
    await campaigns.createCampaign({ executionProfileId: target.id, maxDispatches: 1 });

    const result = await run(canaryFor(target.id, fakeReader(() => [])), wanted.id);

    expect(result.outcome).toBe("EXECUTED");
  });
});

describe("refusals cost zero exchange requests", () => {
  maybe()("refuses when no campaign exists", async () => {
    const target = await profile("nocampaign");
    const wanted = await windowRow(target.id);
    const reader = fakeReader(() => []);

    const result = await run(canaryFor(target.id, reader), wanted.id);

    expect(result.outcome).toBe("NO_ACTIVE_FILL_CAMPAIGN");
    expect(result.userTradesRequests).toBe(0);
    expect(reader.listRecentTradesOnce).not.toHaveBeenCalled();
    expect((await rowOf(wanted.id)).attempts).toBe(0);
    expect(await reservationsFor(target.id)).toHaveLength(0);
  });

  maybe()("refuses a paused campaign", async () => {
    const target = await profile("paused");
    const wanted = await windowRow(target.id);
    const campaign = await campaigns.createCampaign({
      executionProfileId: target.id,
      maxDispatches: 1,
    });
    await campaigns.pauseCampaign(campaign.id);
    const reader = fakeReader(() => []);

    const result = await run(canaryFor(target.id, reader), wanted.id);

    expect(result.outcome).toBe("NO_ACTIVE_FILL_CAMPAIGN");
    expect(result.campaignStatus).toBe("PAUSED");
    expect(reader.listRecentTradesOnce).not.toHaveBeenCalled();
  });

  maybe()("refuses a campaign that is not shaped for a single dispatch", async () => {
    const target = await profile("notcanary");
    const wanted = await windowRow(target.id);
    await campaigns.createCampaign({ executionProfileId: target.id, maxDispatches: 3 });
    const reader = fakeReader(() => []);

    const result = await run(canaryFor(target.id, reader), wanted.id);

    expect(result.outcome).toBe("CAMPAIGN_NOT_CANARY_SHAPED");
    expect(result.maxDispatches).toBe(3);
    expect(reader.listRecentTradesOnce).not.toHaveBeenCalled();
    expect(await reservationsFor(target.id)).toHaveLength(0);
  });

  maybe()("refuses when the circuit is OPEN, without claiming", async () => {
    const target = await profile("open");
    const wanted = await windowRow(target.id);
    const campaign = await campaigns.createCampaign({
      executionProfileId: target.id,
      maxDispatches: 1,
    });
    // HARD_CONFIGURATION trips at one observation.
    await circuitBreaker.observeDispatchOutcome({
      executionProfileId: target.id,
      campaignId: campaign.id,
      outcome: "ABANDONED",
      reasonCode: "AUTH",
    });
    const reader = fakeReader(() => []);

    const result = await run(canaryFor(target.id, reader), wanted.id);

    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    expect(result.circuit?.state).toBe("OPEN");
    expect(reader.listRecentTradesOnce).not.toHaveBeenCalled();
    expect((await rowOf(wanted.id)).attempts).toBe(0);
  });

  maybe()("fails closed when no global weight cap is configured", async () => {
    const target = await profile("nocap");
    const wanted = await windowRow(target.id);
    await campaigns.createCampaign({ executionProfileId: target.id, maxDispatches: 1 });
    const reader = fakeReader(() => []);

    const result = await run(
      canaryFor(target.id, reader, { weightCap: undefined }),
      wanted.id
    );

    expect(result.outcome).toBe("GLOBAL_WEIGHT_CAP_UNAVAILABLE");
    expect(reader.listRecentTradesOnce).not.toHaveBeenCalled();
    expect(await reservationsFor(target.id)).toHaveLength(0);
  });

  // A cap below one dispatch, and a cap that is not a whole number of them.
  for (const [label, weightCap] of [["below one dispatch", 4], ["not a multiple of five", 7]] as const) {
    maybe()(`fails closed on a cap ${label}`, async () => {
      const target = await profile(`badcap-${weightCap}`);
      const wanted = await windowRow(target.id);
      await campaigns.createCampaign({ executionProfileId: target.id, maxDispatches: 1 });
      const reader = fakeReader(() => []);

      const result = await run(canaryFor(target.id, reader, { weightCap }), wanted.id);

      expect(result.outcome).toBe("GLOBAL_WEIGHT_CAP_UNAVAILABLE");
      expect(reader.listRecentTradesOnce).not.toHaveBeenCalled();
    });
  }
});

describe("an invalid target is refused before the campaign is spent", () => {
  maybe()("refuses a window id that does not exist", async () => {
    const target = await profile("notfound");
    await campaigns.createCampaign({ executionProfileId: target.id, maxDispatches: 1 });
    const reader = fakeReader(() => []);

    const result = await run(canaryFor(target.id, reader), "cxxxxxxxxxxxxxxxxxxxxxxxx");

    expect(result.outcome).toBe("TARGET_NOT_FOUND");
    expect(reader.listRecentTradesOnce).not.toHaveBeenCalled();
    // The campaign's single slot is untouched, so the operator can retry.
    const live = await campaigns.getLiveCampaign(target.id);
    expect(live?.dispatchesUsed).toBe(0);
    expect(live?.status).toBe("ACTIVE");
  });

  maybe()("refuses another profile's window without revealing it exists", async () => {
    const mine = await profile("mine");
    const stranger = await profile("stranger");
    const theirs = await windowRow(stranger.id);
    await campaigns.createCampaign({ executionProfileId: mine.id, maxDispatches: 1 });
    const reader = fakeReader(() => []);

    const result = await run(canaryFor(mine.id, reader), theirs.id);

    // Indistinguishable from "no such window", on purpose.
    expect(result.outcome).toBe("TARGET_NOT_FOUND");
    expect(reader.listRecentTradesOnce).not.toHaveBeenCalled();
    expect((await rowOf(theirs.id)).attempts).toBe(0);
  });

  const INELIGIBLE = [
    ["a COMPLETE window", { status: "COMPLETE" }, "NOT_PENDING"],
    ["an ABANDONED window", { status: "ABANDONED" }, "NOT_PENDING"],
    ["an attempts-exhausted window", { attempts: 5 }, "ATTEMPTS_EXHAUSTED"],
    [
      "a backing-off window",
      { nextEligibleAt: new Date(NOW.getTime() + 60_000) },
      "BACKOFF_ACTIVE",
    ],
    [
      "a freshly leased window",
      { attempts: 1, claimedAt: new Date(NOW.getTime() - 1_000), claimOwner: "other" },
      "LEASE_HELD",
    ],
  ] as const;

  for (const [label, overrides, ineligibility] of INELIGIBLE) {
    maybe()(`refuses ${label} before admission`, async () => {
      const target = await profile(`inelig-${ineligibility.toLowerCase()}`);
      const wanted = await windowRow(target.id, overrides as Record<string, unknown>);
      await campaigns.createCampaign({ executionProfileId: target.id, maxDispatches: 1 });
      const reader = fakeReader(() => []);

      const result = await run(canaryFor(target.id, reader), wanted.id);

      expect(result.outcome).toBe("TARGET_NOT_ELIGIBLE");
      expect(result.ineligibility).toBe(ineligibility);
      expect(reader.listRecentTradesOnce).not.toHaveBeenCalled();
      // Nothing spent: no reservation, and the slot is still available.
      expect(await reservationsFor(target.id)).toHaveLength(0);
      expect((await campaigns.getLiveCampaign(target.id))?.dispatchesUsed).toBe(0);
    });
  }
});

describe("a target lost after admission refunds exactly, and claims nothing else", () => {
  maybe()("issues zero requests and gives the slot and weight back", async () => {
    const target = await profile("lost");
    const wanted = await windowRow(target.id);
    // A second, perfectly claimable window. A fallback would take it.
    const decoy = await prisma!.exchangeFillIngestWindow.create({
      data: {
        executionProfileId: target.id,
        symbol: "DECOYUSDT",
        startTimeMs: BigInt(DAY_START - DAY),
        endTimeMs: BigInt(DAY_START - 1),
      },
    });
    await campaigns.createCampaign({ executionProfileId: target.id, maxDispatches: 1 });
    const reader = fakeReader(() => []);
    const canary = canaryFor(target.id, reader);

    // THE RACE: the target passes preflight, then somebody else finishes it
    // before the targeted claim runs. Driven deterministically by finishing it
    // between admission and claim.
    const admit = weightBudget.admitCampaignDispatch.bind(weightBudget);
    vi.spyOn(weightBudget, "admitCampaignDispatch").mockImplementationOnce(async (options) => {
      const admission = await admit(options);
      await prisma!.exchangeFillIngestWindow.update({
        where: { id: wanted.id },
        data: { status: "COMPLETE" },
      });
      return admission;
    });

    const result = await run(canary, wanted.id);

    expect(result.outcome).toBe("TARGET_LOST_AFTER_ADMISSION");
    expect(result.executorOutcome).toBe("NO_WORK");
    expect(result.userTradesRequests).toBe(0);
    expect(result.userTradesWeightUsed).toBe(0);
    expect(reader.listRecentTradesOnce).not.toHaveBeenCalled();

    // The decoy was never claimed: no fallback.
    const untouchedDecoy = await rowOf(decoy.id);
    expect(untouchedDecoy.attempts).toBe(0);
    expect(untouchedDecoy.claimOwner).toBeNull();

    // Exact refund through the existing service: the grant is released and the
    // minute's weight is back to zero.
    const reservations = await reservationsFor(target.id);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.releasedAt).not.toBeNull();
    const bucket = await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: target.id },
    });
    expect(bucket.weightUsed).toBe(0);
    // The slot came back, so the cap-1 campaign is ACTIVE and retryable.
    const live = await campaigns.getLiveCampaign(target.id);
    expect(live?.status).toBe("ACTIVE");
    expect(live?.dispatchesUsed).toBe(0);
    vi.restoreAllMocks();
  });
});

describe("the breaker observes the targeted result exactly as it observes a scheduled one", () => {
  maybe()("a healthy COMPLETE leaves the latch closed", async () => {
    const target = await profile("healthy");
    const wanted = await windowRow(target.id);
    await campaigns.createCampaign({ executionProfileId: target.id, maxDispatches: 1 });

    const result = await run(canaryFor(target.id, fakeReader(() => [])), wanted.id);

    expect(result.executorOutcome).toBe("COMPLETE");
    expect(result.circuit?.state).toBe("CLOSED");
    expect(result.circuitOpened).toBe(false);
  });

  maybe()("a hard configuration failure OPENS the latch on one observation", async () => {
    const target = await profile("auth");
    const wanted = await windowRow(target.id);
    await campaigns.createCampaign({ executionProfileId: target.id, maxDispatches: 1 });
    // A REAL BinanceError, which is what the executor classifies. AUTH is a
    // RETRYABLE kind, so the durable outcome is RETRY_SCHEDULED -- and it is
    // the HARD_CONFIGURATION family, which trips the latch at one observation.
    const reader = fakeReader(() => {
      throw new BinanceError({ kind: "AUTH" as never, message: "Binance AUTH", endpoint: "userTrades" });
    });

    const result = await run(canaryFor(target.id, reader), wanted.id);

    // The request WAS made -- it reached the exchange and failed there -- so
    // the weight is spent and never refunded.
    expect(reader.listRecentTradesOnce).toHaveBeenCalledTimes(1);
    expect(result.executorOutcome).toBe("RETRY_SCHEDULED");
    expect(result.executorReasonCode).toBe("AUTH");
    expect(result.userTradesRequests).toBe(1);
    expect(result.circuit?.state).toBe("OPEN");
    expect(result.circuitOpened).toBe(true);
    const reservations = await reservationsFor(target.id);
    expect(reservations[0]!.releasedAt).toBeNull();
  });

  maybe()("a saturated page splits and is observed as healthy", async () => {
    const target = await profile("split");
    const wanted = await windowRow(target.id);
    await campaigns.createCampaign({ executionProfileId: target.id, maxDispatches: 1 });
    // A full page: the planner must bisect rather than call the window proven.
    const full = Array.from({ length: 1000 }, (_, index) =>
      trade({ tradeId: `S${index}`, timeMs: DAY_START + index })
    );

    const result = await run(canaryFor(target.id, fakeReader(() => full)), wanted.id);

    expect(result.executorOutcome).toBe("SPLIT");
    expect(result.userTradesRequests).toBe(1);
    expect(result.circuit?.state).toBe("CLOSED");
    expect((await rowOf(wanted.id)).status).toBe("SPLIT");
  });
});

describe("an unknown throw keeps the slot and the weight", () => {
  maybe()("propagates, refunds nothing, and records no observation", async () => {
    const target = await profile("throw");
    const wanted = await windowRow(target.id);
    await campaigns.createCampaign({ executionProfileId: target.id, maxDispatches: 1 });
    const canary = canaryFor(target.id, fakeReader(() => []));
    // An invocation that may or may not have dispatched. Uncertain dispatch is
    // always counted as spent -- the exact policy the scheduled driver applies.
    vi.spyOn(
      (canary as unknown as { deps: { executor: { executeSpecificWindow: unknown } } }).deps.executor,
      "executeSpecificWindow" as never
    ).mockImplementationOnce(async () => {
      throw new Error("transport exploded mid-flight");
    });

    await expect(run(canary, wanted.id)).rejects.toThrow("transport exploded mid-flight");

    // Slot and weight RETAINED.
    const reservations = await reservationsFor(target.id);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.releasedAt).toBeNull();
    const bucket = await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: target.id },
    });
    expect(bucket.weightUsed).toBe(5);
    expect((await campaigns.getCampaignStatus((await campaigns.getLiveCampaign(target.id))?.id ?? ""))?.status ?? "EXHAUSTED").toBeDefined();
    // No observation was fabricated from a result that does not exist.
    const breaker = await prisma!.historicalFillCircuitBreaker.findUnique({
      where: { executionProfileId: target.id },
    });
    expect(breaker).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("a non-empty page reaches the same ledger path", () => {
  maybe()("inserts real fills and finalizes the window", async () => {
    const target = await profile("ledger");
    const wanted = await windowRow(target.id);
    await campaigns.createCampaign({ executionProfileId: target.id, maxDispatches: 1 });
    const reader = fakeReader(() => [
      trade({ tradeId: "7001", timeMs: DAY_START + 1_000 }),
      trade({ tradeId: "7002", timeMs: DAY_START + 2_000 }),
    ]);

    const result = await run(canaryFor(target.id, reader), wanted.id);

    expect(result.outcome).toBe("EXECUTED");
    expect(result.executorOutcome).toBe("COMPLETE");
    expect(result.userTradesRequests).toBe(1);
    const fills = await prisma!.exchangeFillLedger.findMany({
      where: { executionProfileId: target.id },
      orderBy: { exchangeTradeId: "asc" },
    });
    expect(fills).toHaveLength(2);
    expect(fills.map((row) => row.exchangeTradeId)).toEqual(["7001", "7002"]);
    expect(fills.every((row) => row.symbol === SYMBOL)).toBe(true);
    expect((await rowOf(wanted.id)).status).toBe("COMPLETE");
  });
});
