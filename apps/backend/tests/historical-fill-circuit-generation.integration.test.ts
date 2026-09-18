import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase, resolveTestDatabase } from "./helpers/test-database";
import { HistoricalFillCircuitBreakerService } from "../src/modules/execution/historical-fill-circuit-breaker.service";
import { HistoricalFillCampaignService } from "../src/modules/execution/historical-fill-campaign.service";
import {
  HistoricalFillWeightBudgetService,
  HISTORICAL_FILL_RESERVATION_WEIGHT,
  type HistoricalFillWeightReservation,
} from "../src/modules/execution/historical-fill-weight-budget.service";

/**
 * The breaker EPOCH, against a REAL Postgres.
 *
 * Acknowledgement clears every other column on the breaker row, so a refund
 * arriving afterwards cannot tell -- from state alone -- whether its reservation
 * was granted before the episode or after it. The epoch is the one thing that
 * survives, and this file is the proof that it survives in exactly the right
 * places: it moves on the CLOSED -> OPEN transition and NOWHERE else, and a
 * refund reopens a campaign only when its grant belongs to the epoch still
 * running.
 *
 * Both halves matter equally. Fencing everything would be trivially "safe" and
 * would silently disable the one reactivation the design does allow, so the
 * converse -- that an ordinary post-recovery refund still reopens -- is proven
 * just as carefully as the fence itself.
 *
 * Contention runs through INDEPENDENT PrismaClients. No Binance client is
 * constructed here or in the code under test, and nothing performs network I/O.
 */

const TAG = "fill-circuit-generation-synthetic";
const AMPLE_CAP = 500;

/** One observation of this pair opens the latch: HARD_CONFIGURATION, threshold 1. */
const SYSTEMIC = { outcome: "ABANDONED", reasonCode: "AUTH" } as const;
/** Systemic but far below its threshold, so it builds a row without opening it. */
const STREAK = { outcome: "ABANDONED", reasonCode: "SERVER" } as const;

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const maybe = () => (available ? it : it.skip);

const clients: PrismaClient[] = [];
function independentClient(): PrismaClient {
  const client = new PrismaClient({ datasources: { db: { url: resolveTestDatabase().url } } });
  clients.push(client);
  return client;
}

let breaker: HistoricalFillCircuitBreakerService;
let campaigns: HistoricalFillCampaignService;
let budget: HistoricalFillWeightBudgetService;

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

function admit(executionProfileId: string) {
  return budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
}

async function admitted(executionProfileId: string): Promise<HistoricalFillWeightReservation> {
  const result = await admit(executionProfileId);
  if (result.outcome !== "ADMITTED") throw new Error(`expected ADMITTED, got ${result.outcome}`);
  return result.reservation;
}

async function openCircuit(executionProfileId: string, campaignId: string) {
  const observation = await breaker.observeDispatchOutcome({
    executionProfileId,
    campaignId,
    ...SYSTEMIC,
  });
  expect(observation.result).toBe("CIRCUIT_OPENED");
  return observation;
}

/** Force a campaign back to ACTIVE, so a test can measure the NEXT thing. */
async function forceActive(campaignId: string): Promise<void> {
  await prisma!.$executeRawUnsafe(
    `UPDATE "HistoricalFillCampaign" SET "status" = 'ACTIVE' WHERE "id" = $1`,
    campaignId
  );
}

async function generationOf(executionProfileId: string): Promise<number> {
  return (await breaker.readState({ executionProfileId })).generation;
}

async function reservationGeneration(reservationId: string): Promise<number> {
  const row = await prisma!.historicalFillWeightReservation.findUniqueOrThrow({
    where: { id: reservationId },
    select: { circuitGeneration: true },
  });
  return row.circuitGeneration;
}

async function breakerRow(executionProfileId: string) {
  return prisma!.historicalFillCircuitBreaker.findUnique({ where: { executionProfileId } });
}

async function campaignRow(campaignId: string) {
  return prisma!.historicalFillCampaign.findUniqueOrThrow({ where: { id: campaignId } });
}

async function activeCount(executionProfileId: string): Promise<number> {
  return prisma!.historicalFillCampaign.count({
    where: { executionProfileId, status: "ACTIVE" },
  });
}

async function weightUsed(executionProfileId: string): Promise<number> {
  const buckets = await prisma!.historicalFillWeightBucket.findMany({
    where: { executionProfileId },
    select: { weightUsed: true },
  });
  return buckets.reduce((total, bucket) => total + bucket.weightUsed, 0);
}

beforeAll(() => {
  if (!prisma) return;
  breaker = new HistoricalFillCircuitBreakerService(prisma);
  campaigns = new HistoricalFillCampaignService(prisma);
  budget = new HistoricalFillWeightBudgetService(prisma);
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()));
});

describe("the epoch moves on the transition, and nowhere else", () => {
  maybe()("an absent breaker row is logical generation 0, and stays absent", async () => {
    const { executionProfileId } = await withCampaign("absent-row");
    expect(await breakerRow(executionProfileId)).toBeNull();
    expect(await generationOf(executionProfileId)).toBe(0);

    const reservation = await admitted(executionProfileId);

    // The healthy path must still write NOTHING to the breaker: no row may be
    // created merely so that an epoch can be read.
    expect(await breakerRow(executionProfileId)).toBeNull();
    expect(await reservationGeneration(reservation.id)).toBe(0);
  });

  maybe()("a CLOSED streak row sits at generation 0, like absence", async () => {
    const { executionProfileId, campaignId } = await withCampaign("closed-streak");
    const streaked = await breaker.observeDispatchOutcome({
      executionProfileId,
      campaignId,
      ...STREAK,
    });
    expect(streaked.result).toBe("STREAK_UPDATED");

    const row = await breakerRow(executionProfileId);
    expect(row).not.toBeNull();
    expect(row!.state).toBe("CLOSED");
    // A streak is not an episode. The row exists; nothing has happened yet.
    expect(row!.generation).toBe(0);

    const reservation = await admitted(executionProfileId);
    expect(await reservationGeneration(reservation.id)).toBe(0);
  });

  maybe()("a healthy reset clears the streak and leaves the epoch alone", async () => {
    const { executionProfileId, campaignId } = await withCampaign("reset-retains");
    // Get to generation 1 first, so a reset that wrongly zeroed it would show.
    await openCircuit(executionProfileId, campaignId);
    await breaker.acknowledge({ executionProfileId });
    expect(await generationOf(executionProfileId)).toBe(1);

    await breaker.observeDispatchOutcome({ executionProfileId, campaignId, ...STREAK });
    expect((await breakerRow(executionProfileId))!.consecutiveCount).toBe(1);

    const recovered = await breaker.observeDispatchOutcome({
      executionProfileId,
      campaignId,
      outcome: "COMPLETE",
    });
    expect(recovered.result).toBe("STREAK_RESET");
    expect(recovered.circuit.consecutiveCount).toBe(0);
    // An episode that never happened cannot un-happen the ones that did.
    expect(recovered.circuit.generation).toBe(1);
  });

  maybe()("opening moves 0 -> 1 and acknowledgement retains it", async () => {
    const { executionProfileId, campaignId } = await withCampaign("open-then-ack");
    expect(await generationOf(executionProfileId)).toBe(0);

    const opened = await openCircuit(executionProfileId, campaignId);
    expect(opened.circuit.generation).toBe(1);

    const acknowledged = await breaker.acknowledge({ executionProfileId });
    expect(acknowledged.circuit.state).toBe("CLOSED");
    expect(acknowledged.circuit.openedAt).toBeNull();
    expect(acknowledged.circuit.failureFamily).toBeNull();
    expect(acknowledged.circuit.consecutiveCount).toBe(0);
    // Everything else is erased. This is the one survivor, and the only reason
    // a later refund can still tell which side of the episode it came from.
    expect(acknowledged.circuit.generation).toBe(1);
  });

  maybe()("late observations while OPEN write nothing at all", async () => {
    const { executionProfileId, campaignId } = await withCampaign("already-open-no-write");
    const opened = await openCircuit(executionProfileId, campaignId);
    const before = await breakerRow(executionProfileId);

    for (const late of [
      { outcome: "ABANDONED", reasonCode: "AUTH" },
      { outcome: "ABANDONED", reasonCode: "NETWORK" },
      { outcome: "RETRY_SCHEDULED", reasonCode: "TIMEOUT" },
      { outcome: "COMPLETE" },
      { outcome: "SPLIT" },
    ]) {
      const observation = await breaker.observeDispatchOutcome({
        executionProfileId,
        campaignId,
        ...late,
      });
      expect(observation.result).toBe("ALREADY_OPEN");
    }

    // Byte-for-byte identical, updatedAt included: a straggler may not rewrite
    // the snapshot, and it certainly may not advance the epoch.
    expect(await breakerRow(executionProfileId)).toEqual(before);
    expect(before!.generation).toBe(1);
    expect(opened.circuit.generation).toBe(1);
  });

  maybe()("a second episode reaches generation 2", async () => {
    const { executionProfileId, campaignId } = await withCampaign("second-episode");
    await openCircuit(executionProfileId, campaignId);
    await breaker.acknowledge({ executionProfileId });
    expect(await generationOf(executionProfileId)).toBe(1);

    await campaigns.resumeCampaign(campaignId);
    await openCircuit(executionProfileId, campaignId);
    expect(await generationOf(executionProfileId)).toBe(2);

    await breaker.acknowledge({ executionProfileId });
    expect(await generationOf(executionProfileId)).toBe(2);
  });
});

describe("the fence stops resurrection without disabling reactivation", () => {
  /** Final slot spent, campaign EXHAUSTED, one reservation still outstanding. */
  async function finalSlot(suffix: string, maxDispatches = 1) {
    const { executionProfileId, campaignId } = await withCampaign(suffix, maxDispatches);
    const reservation = await admitted(executionProfileId);
    expect((await campaignRow(campaignId)).status).toBe("EXHAUSTED");
    return { executionProfileId, campaignId, reservation };
  }

  maybe()("a grant from the CURRENT epoch still reopens, exactly as before", async () => {
    // THE CONVERSE PROOF. A fence that blocked everything would look safe and
    // would quietly delete the one reactivation the design allows.
    const { executionProfileId, campaignId, reservation } = await finalSlot("current-epoch");
    expect(await reservationGeneration(reservation.id)).toBe(0);
    expect(await generationOf(executionProfileId)).toBe(0);

    await budget.releaseCertainNonDispatch(reservation);

    expect((await campaignRow(campaignId)).status).toBe("ACTIVE");
    expect(await activeCount(executionProfileId)).toBe(1);
  });

  maybe()("a grant made AFTER recovery reopens, proving the fence is not permanent", async () => {
    const { executionProfileId, campaignId } = await withCampaign("post-recovery", 1);
    // Episode one, acknowledged. The profile has history now.
    await openCircuit(executionProfileId, campaignId);
    await breaker.acknowledge({ executionProfileId });
    expect(await generationOf(executionProfileId)).toBe(1);

    // The operator explicitly puts the campaign back to work.
    await campaigns.resumeCampaign(campaignId);
    const reservation = await admitted(executionProfileId);
    expect(await reservationGeneration(reservation.id)).toBe(1);
    expect((await campaignRow(campaignId)).status).toBe("EXHAUSTED");

    // No episode since. 1 === 1, so the established rule applies untouched.
    await budget.releaseCertainNonDispatch(reservation);

    expect((await campaignRow(campaignId)).status).toBe("ACTIVE");
    expect(await activeCount(executionProfileId)).toBe(1);
  });

  maybe()("across TWO episodes, each stale grant is fenced and each fresh one is not", async () => {
    const { executionProfileId, campaignId } = await withCampaign("multi-episode", 1);

    // R0 belongs to epoch 0.
    const r0 = await admitted(executionProfileId);
    expect(await reservationGeneration(r0.id)).toBe(0);

    await openCircuit(executionProfileId, campaignId);
    await breaker.acknowledge({ executionProfileId });
    expect(await generationOf(executionProfileId)).toBe(1);

    // Late R0 refund: 0 !== 1. Accounting yes, reopening no.
    await budget.releaseCertainNonDispatch(r0);
    expect((await campaignRow(campaignId)).status).toBe("EXHAUSTED");
    expect((await campaignRow(campaignId)).dispatchesUsed).toBe(0);
    expect(await activeCount(executionProfileId)).toBe(0);

    // The operator restarts. R1 belongs to epoch 1.
    await forceActive(campaignId);
    const r1 = await admitted(executionProfileId);
    expect(await reservationGeneration(r1.id)).toBe(1);

    await openCircuit(executionProfileId, campaignId);
    await breaker.acknowledge({ executionProfileId });
    expect(await generationOf(executionProfileId)).toBe(2);

    // Late R1 refund: 1 !== 2. Fenced again, one epoch later.
    await budget.releaseCertainNonDispatch(r1);
    expect((await campaignRow(campaignId)).status).toBe("EXHAUSTED");
    expect(await activeCount(executionProfileId)).toBe(0);

    // R2 belongs to epoch 2, and would reactivate on its own terms.
    await forceActive(campaignId);
    const r2 = await admitted(executionProfileId);
    expect(await reservationGeneration(r2.id)).toBe(2);
  });

  maybe()("the fence never blocks the accounting refund itself", async () => {
    const { executionProfileId, campaignId, reservation } = await finalSlot("accounting-intact");
    await openCircuit(executionProfileId, campaignId);
    await breaker.acknowledge({ executionProfileId });
    expect(await weightUsed(executionProfileId)).toBe(HISTORICAL_FILL_RESERVATION_WEIGHT);

    await budget.releaseCertainNonDispatch(reservation);

    // Every part of the refund lands. Only the reopening is withheld.
    expect(await weightUsed(executionProfileId)).toBe(0);
    expect((await campaignRow(campaignId)).dispatchesUsed).toBe(0);
    const released = await prisma!.historicalFillWeightReservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(released.releasedAt).not.toBeNull();
    expect((await campaignRow(campaignId)).status).toBe("EXHAUSTED");
  });

  maybe()("a replacement campaign still wins over a stale refund", async () => {
    // `otherLive` and the epoch fence are independent guards; neither may be
    // relied on to cover the other, and together they must not misbehave.
    const { executionProfileId, campaignId, reservation } = await finalSlot("replacement");
    await openCircuit(executionProfileId, campaignId);
    await breaker.acknowledge({ executionProfileId });
    const replacement = await campaigns.createCampaign({
      executionProfileId,
      maxDispatches: 5,
    });

    await budget.releaseCertainNonDispatch(reservation);

    expect((await campaignRow(campaignId)).status).toBe("EXHAUSTED");
    expect((await campaignRow(replacement.id)).status).toBe("ACTIVE");
    expect(await activeCount(executionProfileId)).toBe(1);
  });
});

describe("the epoch is settled by the lock, not by a clock", () => {
  maybe()("six concurrent hard failures advance the epoch exactly once", async () => {
    const { executionProfileId, campaignId } = await withCampaign("six-concurrent");
    const rivals = Array.from({ length: 6 }, () =>
      new HistoricalFillCircuitBreakerService(independentClient())
    );

    const results = await Promise.all(
      rivals.map((rival) =>
        rival.observeDispatchOutcome({ executionProfileId, campaignId, ...SYSTEMIC })
      )
    );

    const opened = results.filter((r) => r.result === "CIRCUIT_OPENED");
    const already = results.filter((r) => r.result === "ALREADY_OPEN");
    expect(opened).toHaveLength(1);
    expect(already).toHaveLength(5);

    const row = await breakerRow(executionProfileId);
    expect(row!.state).toBe("OPEN");
    // ONE transition, one increment -- not six.
    expect(row!.generation).toBe(1);

    await breaker.acknowledge({ executionProfileId });
    expect(await generationOf(executionProfileId)).toBe(1);

    await forceActive(campaignId);
    await openCircuit(executionProfileId, campaignId);
    expect(await generationOf(executionProfileId)).toBe(2);
  });

  maybe()("admission and opening race to the same lock, and tag correctly", async () => {
    let admittedRounds = 0;
    let deniedRounds = 0;

    for (let round = 0; round < 6; round += 1) {
      const { executionProfileId, campaignId } = await withCampaign(`admit-race-${round}`);
      const rivalBudget = new HistoricalFillWeightBudgetService(independentClient());
      const rivalBreaker = new HistoricalFillCircuitBreakerService(independentClient());

      const [admission] = await Promise.all([
        rivalBudget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP }),
        rivalBreaker.observeDispatchOutcome({ executionProfileId, campaignId, ...SYSTEMIC }),
      ]);

      // The breaker ends at 1 whichever side won the lock.
      expect(await generationOf(executionProfileId)).toBe(1);

      if (admission.outcome === "ADMITTED") {
        // Admission won the lock, so its grant belongs to the epoch BEFORE the
        // trip -- and is therefore correctly fenced from reopening later.
        admittedRounds += 1;
        expect(await reservationGeneration(admission.reservation.id)).toBe(0);
      } else {
        // The trip won, so there is no reservation to tag at all.
        deniedRounds += 1;
        expect(admission.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
        expect(
          await prisma!.historicalFillWeightReservation.count({ where: { campaignId } })
        ).toBe(0);
      }
      expect(await activeCount(executionProfileId)).toBe(0);
    }

    expect(admittedRounds + deniedRounds).toBe(6);
  });

  maybe()("acknowledgement racing a refund is safe in both orders", async () => {
    for (let round = 0; round < 4; round += 1) {
      const { executionProfileId, campaignId } = await withCampaign(`ack-refund-${round}`, 1);
      const reservation = await admitted(executionProfileId);
      await openCircuit(executionProfileId, campaignId);

      const rivalBudget = new HistoricalFillWeightBudgetService(independentClient());
      const rivalBreaker = new HistoricalFillCircuitBreakerService(independentClient());

      await Promise.all([
        rivalBudget.releaseCertainNonDispatch(reservation),
        rivalBreaker.acknowledge({ executionProfileId }),
      ]);

      // Refund first => the OPEN veto held. Ack first => the epoch fence held.
      // Either way the accounting is paid back and nothing became runnable.
      const row = await campaignRow(campaignId);
      expect(row.dispatchesUsed).toBe(0);
      expect(await weightUsed(executionProfileId)).toBe(0);
      expect(row.status).toBe("EXHAUSTED");
      expect(await activeCount(executionProfileId)).toBe(0);
      expect(await generationOf(executionProfileId)).toBe(1);
    }
  });

  maybe()("opening racing a refund is safe in both orders", async () => {
    for (let round = 0; round < 4; round += 1) {
      const { executionProfileId, campaignId } = await withCampaign(`open-refund-${round}`, 1);
      const reservation = await admitted(executionProfileId);

      const rivalBudget = new HistoricalFillWeightBudgetService(independentClient());
      const rivalBreaker = new HistoricalFillCircuitBreakerService(independentClient());

      await Promise.all([
        rivalBudget.releaseCertainNonDispatch(reservation),
        rivalBreaker.observeDispatchOutcome({ executionProfileId, campaignId, ...SYSTEMIC }),
      ]);

      // Refund first: generations matched, so it may have reopened -- and the
      // trip then paused whatever was ACTIVE. Trip first: the OPEN veto held.
      // The invariant is the same either way.
      expect((await breaker.readState({ executionProfileId })).state).toBe("OPEN");
      expect(await generationOf(executionProfileId)).toBe(1);
      expect(await activeCount(executionProfileId)).toBe(0);
      expect((await campaignRow(campaignId)).dispatchesUsed).toBe(0);
      expect(await weightUsed(executionProfileId)).toBe(0);
    }
  });
});

describe("the legacy grant is untouched by any of this", () => {
  /**
   * A reservation with no campaign, exactly as production still holds one from
   * before campaigns existed. It must keep releasing through the pre-campaign
   * path: no campaign read, no breaker read, no epoch comparison, no row
   * created, and certainly no reactivation.
   */
  async function legacyReservation(suffix: string) {
    const executionProfileId = await makeProfile(suffix);
    const bucket = await prisma!.historicalFillWeightBucket.create({
      data: {
        executionProfileId,
        bucketStart: new Date(Date.UTC(2026, 8, 18, 10, 0, 0)),
        weightCap: AMPLE_CAP,
        weightUsed: HISTORICAL_FILL_RESERVATION_WEIGHT,
      },
      select: { id: true, bucketStart: true },
    });
    const row = await prisma!.historicalFillWeightReservation.create({
      data: { bucketId: bucket.id, weight: HISTORICAL_FILL_RESERVATION_WEIGHT },
      select: { id: true, circuitGeneration: true },
    });
    return {
      executionProfileId,
      bucketId: bucket.id,
      row,
      reservation: {
        id: row.id,
        bucketId: bucket.id,
        executionProfileId,
        bucketStart: bucket.bucketStart,
        weight: HISTORICAL_FILL_RESERVATION_WEIGHT,
      } satisfies HistoricalFillWeightReservation,
    };
  }

  maybe()("defaults to generation 0 without anyone writing it", async () => {
    const { row } = await legacyReservation("legacy-default");
    // The column's DEFAULT is the backward-compatibility value, and epoch 0 is
    // the truth for a grant that predates the breaker entirely.
    expect(row.circuitGeneration).toBe(0);
  });

  maybe()("releases through the pre-campaign path, with no breaker involvement", async () => {
    const { executionProfileId, reservation } = await legacyReservation("legacy-release");
    expect(await weightUsed(executionProfileId)).toBe(HISTORICAL_FILL_RESERVATION_WEIGHT);

    await budget.releaseCertainNonDispatch(reservation);

    const released = await prisma!.historicalFillWeightReservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(released.releasedAt).not.toBeNull();
    expect(await weightUsed(executionProfileId)).toBe(0);
    // No breaker row was consulted, and none was created.
    expect(await breakerRow(executionProfileId)).toBeNull();
  });

  maybe()("releases identically even while the profile's circuit is OPEN", async () => {
    // The strongest form: an OPEN latch must not reach a grant that belongs to
    // no campaign, because that path never touches campaign accounting at all.
    const { executionProfileId, reservation } = await legacyReservation("legacy-open");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 2 });
    await openCircuit(executionProfileId, campaign.id);
    expect(await generationOf(executionProfileId)).toBe(1);

    await budget.releaseCertainNonDispatch(reservation);

    const released = await prisma!.historicalFillWeightReservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(released.releasedAt).not.toBeNull();
    expect(await weightUsed(executionProfileId)).toBe(0);
    // The campaign is untouched: a legacy grant owes it nothing.
    expect((await campaignRow(campaign.id)).dispatchesUsed).toBe(0);
    expect((await breaker.readState({ executionProfileId })).generation).toBe(1);
  });

  maybe()("is idempotent, exactly as before", async () => {
    const { executionProfileId, reservation } = await legacyReservation("legacy-idempotent");
    await budget.releaseCertainNonDispatch(reservation);
    await budget.releaseCertainNonDispatch(reservation);
    // The second release matches nothing and gives nothing back twice.
    expect(await weightUsed(executionProfileId)).toBe(0);
  });
});
