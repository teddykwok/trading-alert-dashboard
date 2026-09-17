import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase, resolveTestDatabase } from "./helpers/test-database";
import {
  HistoricalFillWeightBudgetInvariantError,
  HistoricalFillWeightBudgetService,
  HISTORICAL_FILL_RESERVATION_WEIGHT,
  type HistoricalFillWeightReservation,
} from "../src/modules/execution/historical-fill-weight-budget.service";
import { HistoricalFillCampaignService } from "../src/modules/execution/historical-fill-campaign.service";
import { HISTORICAL_FILL_CAMPAIGN_LOCK_NAMESPACE } from "../src/modules/execution/historical-fill-campaign-lock";
import { profileLockKey } from "../src/modules/execution/profile-lock";

/**
 * Campaign-governed admission and refund, against a REAL Postgres.
 *
 * Every claim worth making here is about what the DATABASE guarantees when two
 * processes contend: that a slot and its weight commit together or not at all,
 * that a denial costs nothing, and that a refund gives back each of them
 * exactly once. None of that is provable against a mock, and contention is
 * driven through INDEPENDENT PrismaClients so the races are genuinely
 * cross-connection rather than one client racing itself.
 *
 * No Binance client is imported here or by the code under test, and nothing in
 * this suite performs network I/O.
 */

const TAG = "fill-campaign-admission-synthetic";

/** Plenty of minute weight, so campaign bounds are what the test is measuring. */
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
function contender(): HistoricalFillWeightBudgetService {
  return new HistoricalFillWeightBudgetService(independentClient());
}

let budget: HistoricalFillWeightBudgetService;
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

/** A profile with one ACTIVE campaign of the given size. */
async function withCampaign(suffix: string, maxDispatches: number) {
  const executionProfileId = await makeProfile(suffix);
  const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches });
  return { executionProfileId, campaignId: campaign.id };
}

/** Force a status the admission path will not produce on its own. */
async function forceStatus(campaignId: string, status: string): Promise<void> {
  await prisma!.$executeRawUnsafe(
    `UPDATE "HistoricalFillCampaign" SET "status" = $1::"HistoricalFillCampaignStatus" WHERE "id" = $2`,
    status,
    campaignId
  );
}

/** The accounting minute, from the same clock the service uses. */
async function currentBucketStart(): Promise<Date> {
  const rows = await prisma!.$queryRawUnsafe<Array<{ bucket: Date }>>(
    `SELECT date_trunc('minute', (now() AT TIME ZONE 'UTC')) AS bucket`
  );
  return rows[0].bucket;
}

async function campaignRow(campaignId: string) {
  return prisma!.historicalFillCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { status: true, dispatchesUsed: true, maxDispatches: true, endedAt: true },
  });
}

async function reservationsOf(campaignId: string) {
  return prisma!.historicalFillWeightReservation.findMany({
    where: { campaignId },
    select: { id: true, weight: true, releasedAt: true, campaignId: true },
  });
}

async function bucketOf(executionProfileId: string) {
  return prisma!.historicalFillWeightBucket.findFirst({
    where: { executionProfileId },
    orderBy: { bucketStart: "desc" },
    select: { id: true, weightCap: true, weightUsed: true, bucketStart: true },
  });
}

beforeAll(async () => {
  if (!prisma || !available) return;
  budget = new HistoricalFillWeightBudgetService(prisma);
  campaigns = new HistoricalFillCampaignService(prisma);
});

afterAll(async () => {
  if (prisma && available) {
    // Restrict everywhere, so leaves first: reservations, then the buckets and
    // campaigns they point at, then the profiles those belong to.
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

describe("admission requires exactly one ACTIVE campaign", () => {
  maybe()("refuses when the profile has never had a campaign", async () => {
    const executionProfileId = await makeProfile("no-campaign");
    const result = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });

    expect(result.outcome).toBe("NO_ACTIVE_FILL_CAMPAIGN");
    if (result.outcome !== "NO_ACTIVE_FILL_CAMPAIGN") throw new Error("unreachable");
    expect(result.campaignStatus).toBeNull();
    expect(result.campaignId).toBeNull();
    // The load-bearing half: no weight may be spent without a campaign.
    expect(await bucketOf(executionProfileId)).toBeNull();
  });

  maybe().each(["PAUSED", "EXHAUSTED", "COMPLETED", "ABORTED"])(
    "refuses a %s campaign, and does not call it budget exhaustion",
    async (status) => {
      const { executionProfileId, campaignId } = await withCampaign(`state-${status}`, 5);
      await forceStatus(campaignId, status);

      const result = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });

      // PAUSED/ABORTED/COMPLETED are states somebody chose; EXHAUSTED via this
      // path is a campaign that is simply not ACTIVE. None is a limit being hit
      // right now, and collapsing them would send an operator to the wrong fix.
      expect(result.outcome).toBe("NO_ACTIVE_FILL_CAMPAIGN");
      if (result.outcome !== "NO_ACTIVE_FILL_CAMPAIGN") throw new Error("unreachable");
      expect(result.campaignStatus).toBe(status);
      expect(result.campaignId).toBe(campaignId);

      const after = await campaignRow(campaignId);
      expect(after.dispatchesUsed).toBe(0);
      expect(await bucketOf(executionProfileId)).toBeNull();
    }
  );

  maybe()("never admits weight for a profile using another profile's campaign", async () => {
    // The campaign is the canonical owner of the account identity. A campaign
    // belonging to somebody else must not fund this profile's requests.
    const owner = await withCampaign("wrong-profile-owner", 5);
    const stranger = await makeProfile("wrong-profile-stranger");

    const result = await budget.admitCampaignDispatch({
      executionProfileId: stranger,
      weightCap: AMPLE_CAP,
    });

    expect(result.outcome).toBe("NO_ACTIVE_FILL_CAMPAIGN");
    expect((await campaignRow(owner.campaignId)).dispatchesUsed).toBe(0);
    expect(await bucketOf(stranger)).toBeNull();
    expect(await bucketOf(owner.executionProfileId)).toBeNull();
  });

  maybe()("refuses once the counter has reached the ceiling", async () => {
    const { executionProfileId, campaignId } = await withCampaign("at-ceiling", 2);
    await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    const final = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    expect(final.outcome).toBe("ADMITTED");

    // Now EXHAUSTED, so the next attempt is refused as a non-ACTIVE campaign.
    const third = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    expect(third.outcome).toBe("NO_ACTIVE_FILL_CAMPAIGN");
    expect((await campaignRow(campaignId)).dispatchesUsed).toBe(2);
    expect(await reservationsOf(campaignId)).toHaveLength(2);
  });
});

describe("admission spends a slot and its weight together", () => {
  maybe()("first admission links the reservation to the campaign", async () => {
    const { executionProfileId, campaignId } = await withCampaign("first", 3);

    const result = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    expect(result.outcome).toBe("ADMITTED");
    if (result.outcome !== "ADMITTED") throw new Error("unreachable");

    expect(result.campaignId).toBe(campaignId);
    expect(result.dispatchesUsed).toBe(1);
    expect(result.maxDispatches).toBe(3);
    expect(result.campaignStatus).toBe("ACTIVE");
    expect(result.reservation.weight).toBe(HISTORICAL_FILL_RESERVATION_WEIGHT);
    expect(result.reservation.campaignId).toBe(campaignId);

    const rows = await reservationsOf(campaignId);
    expect(rows).toHaveLength(1);
    expect(rows[0].campaignId).toBe(campaignId);
    expect(rows[0].releasedAt).toBeNull();

    const bucket = await bucketOf(executionProfileId);
    expect(bucket?.weightUsed).toBe(HISTORICAL_FILL_RESERVATION_WEIGHT);

    const campaign = await campaignRow(campaignId);
    expect(campaign.status).toBe("ACTIVE");
    expect(campaign.dispatchesUsed).toBe(1);
    expect(campaign.endedAt).toBeNull();
  });

  maybe()("the final slot commits used, EXHAUSTED and endedAt atomically", async () => {
    // maxDispatches = 5, already at 4: the one admission below must produce
    // used=5 AND EXHAUSTED AND endedAt in a single commit. No observer may ever
    // see ACTIVE with every slot spent.
    const { executionProfileId, campaignId } = await withCampaign("final-slot", 5);
    for (let i = 0; i < 4; i += 1) {
      const step = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
      expect(step.outcome).toBe("ADMITTED");
    }
    expect((await campaignRow(campaignId)).status).toBe("ACTIVE");

    const result = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    expect(result.outcome).toBe("ADMITTED");
    if (result.outcome !== "ADMITTED") throw new Error("unreachable");
    expect(result.dispatchesUsed).toBe(5);
    expect(result.campaignStatus).toBe("EXHAUSTED");

    const campaign = await campaignRow(campaignId);
    expect(campaign.dispatchesUsed).toBe(5);
    expect(campaign.status).toBe("EXHAUSTED");
    expect(campaign.endedAt).toBeInstanceOf(Date);

    // The reservation stays perfectly valid even though the campaign has ended.
    const rows = await reservationsOf(campaignId);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.releasedAt === null)).toBe(true);
  });

  maybe()("fails closed if a campaign is somehow ACTIVE with no slots left", async () => {
    // Unreachable by design — the transaction that takes the last slot marks it
    // EXHAUSTED — so this is the fail-closed path for a hand-edited or corrupt
    // row. It is also what separates `< max` from `<= max`.
    const { executionProfileId, campaignId } = await withCampaign("forced-full", 2);
    await prisma!.$executeRawUnsafe(
      `UPDATE "HistoricalFillCampaign" SET "dispatchesUsed" = "maxDispatches" WHERE "id" = $1`,
      campaignId
    );

    const result = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    expect(result.outcome).toBe("CAMPAIGN_DISPATCH_BUDGET_EXHAUSTED");
    if (result.outcome !== "CAMPAIGN_DISPATCH_BUDGET_EXHAUSTED") throw new Error("unreachable");
    expect(result.dispatchesUsed).toBe(2);
    expect(result.maxDispatches).toBe(2);

    expect((await campaignRow(campaignId)).dispatchesUsed).toBe(2);
    expect(await bucketOf(executionProfileId)).toBeNull();
  });
});

describe("a denial after the increment costs nothing", () => {
  maybe()("rolls the campaign increment back when the minute is full", async () => {
    // The exact scenario from the design: used=4 of 5, global budget refuses.
    // The campaign must come out of this exactly as it went in — still ACTIVE,
    // still 4 — or a dispatch that never happened would have spent a slot.
    const { executionProfileId, campaignId } = await withCampaign("weight-denied", 5);
    await prisma!.historicalFillCampaign.update({
      where: { id: campaignId },
      data: { dispatchesUsed: 4 },
    });

    // A minute with no room left: cap 5, already spent.
    const bucketStart = await currentBucketStart();
    await prisma!.historicalFillWeightBucket.create({
      data: { executionProfileId, bucketStart, weightCap: 5, weightUsed: 5 },
    });

    const result = await budget.admitCampaignDispatch({ executionProfileId, weightCap: 5 });
    expect(result.outcome).toBe("GLOBAL_USER_TRADES_WEIGHT_EXHAUSTED");
    if (result.outcome !== "GLOBAL_USER_TRADES_WEIGHT_EXHAUSTED") throw new Error("unreachable");
    expect(result.weightCap).toBe(5);
    expect(result.weightUsed).toBe(5);

    const campaign = await campaignRow(campaignId);
    expect(campaign.dispatchesUsed).toBe(4);
    expect(campaign.status).toBe("ACTIVE");
    expect(campaign.endedAt).toBeNull();

    expect(await reservationsOf(campaignId)).toHaveLength(0);
    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(5);
  });

  maybe()("rolls the campaign increment back on a cap mismatch", async () => {
    // A bucket whose stored cap disagrees with the configured one is refused
    // and left exactly as found. Repairing it would raise a ceiling another
    // process is already counting against.
    const { executionProfileId, campaignId } = await withCampaign("cap-mismatch", 5);
    const bucketStart = await currentBucketStart();
    await prisma!.historicalFillWeightBucket.create({
      data: { executionProfileId, bucketStart, weightCap: 25, weightUsed: 0 },
    });

    const result = await budget.admitCampaignDispatch({ executionProfileId, weightCap: 50 });
    expect(result.outcome).toBe("CAP_MISMATCH");
    if (result.outcome !== "CAP_MISMATCH") throw new Error("unreachable");
    expect(result.storedCap).toBe(25);
    expect(result.configuredCap).toBe(50);

    const campaign = await campaignRow(campaignId);
    expect(campaign.dispatchesUsed).toBe(0);
    expect(campaign.status).toBe("ACTIVE");

    const bucket = await bucketOf(executionProfileId);
    expect(bucket!.weightCap).toBe(25);
    expect(bucket!.weightUsed).toBe(0);
    expect(await reservationsOf(campaignId)).toHaveLength(0);
  });

  maybe()("rolls the increment back on the campaign's very last slot too", async () => {
    // The nastiest version: the denied admission would have been the final one,
    // so a leaked increment would also leave the campaign wrongly EXHAUSTED.
    const { executionProfileId, campaignId } = await withCampaign("weight-denied-final", 1);
    const bucketStart = await currentBucketStart();
    await prisma!.historicalFillWeightBucket.create({
      data: { executionProfileId, bucketStart, weightCap: 5, weightUsed: 5 },
    });

    const result = await budget.admitCampaignDispatch({ executionProfileId, weightCap: 5 });
    expect(result.outcome).toBe("GLOBAL_USER_TRADES_WEIGHT_EXHAUSTED");

    const campaign = await campaignRow(campaignId);
    expect(campaign.status).toBe("ACTIVE");
    expect(campaign.dispatchesUsed).toBe(0);
    expect(campaign.endedAt).toBeNull();
  });
});

describe("refund gives back both budgets, exactly once", () => {
  /** Admit one dispatch and hand back the reservation, as the driver would. */
  async function admitOne(executionProfileId: string): Promise<HistoricalFillWeightReservation> {
    const result = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    if (result.outcome !== "ADMITTED") throw new Error(`expected ADMITTED, got ${result.outcome}`);
    return result.reservation;
  }

  maybe()("returns the slot and the weight for a proven zero-dispatch outcome", async () => {
    // NO_WORK and PROFILE_UNAVAILABLE are the only outcomes that reach here:
    // both are decided before the transport is touched.
    const { executionProfileId, campaignId } = await withCampaign("refund-basic", 3);
    const reservation = await admitOne(executionProfileId);
    expect((await campaignRow(campaignId)).dispatchesUsed).toBe(1);

    await budget.releaseCertainNonDispatch(reservation);

    const campaign = await campaignRow(campaignId);
    expect(campaign.dispatchesUsed).toBe(0);
    expect(campaign.status).toBe("ACTIVE");
    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(0);

    const rows = await reservationsOf(campaignId);
    expect(rows).toHaveLength(1);
    expect(rows[0].releasedAt).toBeInstanceOf(Date);
  });

  maybe()("is idempotent: a second refund changes nothing", async () => {
    const { executionProfileId, campaignId } = await withCampaign("refund-twice", 3);
    const reservation = await admitOne(executionProfileId);

    await budget.releaseCertainNonDispatch(reservation);
    const afterFirst = await campaignRow(campaignId);
    await budget.releaseCertainNonDispatch(reservation);
    const afterSecond = await campaignRow(campaignId);

    // A duplicate must not give back a slot owed to a different outstanding
    // grant. The releasedAt CAS is the only thing standing between here and an
    // undercount of what has been spent.
    expect(afterSecond.dispatchesUsed).toBe(afterFirst.dispatchesUsed);
    expect(afterSecond.dispatchesUsed).toBe(0);
    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(0);
  });

  maybe()("reopens a campaign whose final slot is proven unspent", async () => {
    const { executionProfileId, campaignId } = await withCampaign("refund-reopen", 1);
    const reservation = await admitOne(executionProfileId);
    expect((await campaignRow(campaignId)).status).toBe("EXHAUSTED");

    await budget.releaseCertainNonDispatch(reservation);

    const campaign = await campaignRow(campaignId);
    expect(campaign.status).toBe("ACTIVE");
    expect(campaign.dispatchesUsed).toBe(0);
    // Reopened means it did not end after all.
    expect(campaign.endedAt).toBeNull();
    // And it is live again, so no second campaign may be opened beside it.
    expect((await campaigns.getLiveCampaign(executionProfileId))!.id).toBe(campaignId);
  });

  maybe()("refunds a PAUSED campaign without unpausing it", async () => {
    // Undoing a pause because a refund arrived would restart a backfill the
    // operator deliberately stopped.
    const { executionProfileId, campaignId } = await withCampaign("refund-paused", 3);
    const reservation = await admitOne(executionProfileId);
    await campaigns.pauseCampaign(campaignId);

    await budget.releaseCertainNonDispatch(reservation);

    const campaign = await campaignRow(campaignId);
    expect(campaign.status).toBe("PAUSED");
    expect(campaign.dispatchesUsed).toBe(0);
    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(0);
  });

  maybe()("refunds an ABORTED campaign without resurrecting it", async () => {
    const { executionProfileId, campaignId } = await withCampaign("refund-aborted", 3);
    const reservation = await admitOne(executionProfileId);
    await campaigns.abortCampaign(campaignId);

    await budget.releaseCertainNonDispatch(reservation);

    const campaign = await campaignRow(campaignId);
    expect(campaign.status).toBe("ABORTED");
    expect(campaign.dispatchesUsed).toBe(0);
    expect(campaign.endedAt).toBeInstanceOf(Date);
    // An aborted campaign is not live, and must not become live again.
    expect(await campaigns.getLiveCampaign(executionProfileId)).toBeNull();
  });

  maybe()("refuses to refund a COMPLETED campaign and rolls the whole release back", async () => {
    // COMPLETED means the queue was declared finished, which cannot be true
    // while a dispatch this campaign paid for was still unresolved. Treated as
    // corruption: nothing is written, and the reservation stays releasable once
    // somebody has repaired the books. The cost is that the weight stays
    // charged meanwhile — an OVERCOUNT, which is the safe direction.
    const { executionProfileId, campaignId } = await withCampaign("refund-completed", 3);
    const reservation = await admitOne(executionProfileId);
    await forceStatus(campaignId, "COMPLETED");

    await expect(budget.releaseCertainNonDispatch(reservation)).rejects.toBeInstanceOf(
      HistoricalFillWeightBudgetInvariantError
    );

    const campaign = await campaignRow(campaignId);
    expect(campaign.status).toBe("COMPLETED");
    expect(campaign.dispatchesUsed).toBe(1);
    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(HISTORICAL_FILL_RESERVATION_WEIGHT);
    // releasedAt rolled back with everything else: still outstanding.
    expect((await reservationsOf(campaignId))[0].releasedAt).toBeNull();
  });
});

describe("a late refund never disturbs a newer campaign", () => {
  maybe()("commits the refund but leaves the old campaign EXHAUSTED", async () => {
    // Campaign A spends its final slot and ends. B is opened. A's reservation
    // then proves zero-dispatch. A must get its slot and weight back, B must be
    // untouched, and A must NOT reopen — two live campaigns would be two
    // ceilings, which is the overspend the partial unique index prevents.
    const { executionProfileId, campaignId: a } = await withCampaign("late-refund", 1);
    const result = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    if (result.outcome !== "ADMITTED") throw new Error("unreachable");
    expect((await campaignRow(a)).status).toBe("EXHAUSTED");

    const b = await campaigns.createCampaign({ executionProfileId, maxDispatches: 4 });

    await budget.releaseCertainNonDispatch(result.reservation);

    const campaignA = await campaignRow(a);
    expect(campaignA.dispatchesUsed).toBe(0);
    expect(campaignA.status).toBe("EXHAUSTED");
    expect(campaignA.endedAt).toBeInstanceOf(Date);

    const campaignB = await campaignRow(b.id);
    expect(campaignB.status).toBe("ACTIVE");
    expect(campaignB.dispatchesUsed).toBe(0);

    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(0);
    expect((await reservationsOf(a))[0].releasedAt).toBeInstanceOf(Date);

    // Exactly one live campaign, and it is the new one.
    const live = await prisma!.historicalFillCampaign.findMany({
      where: { executionProfileId, status: { in: ["ACTIVE", "PAUSED"] } },
      select: { id: true },
    });
    expect(live.map((row) => row.id)).toEqual([b.id]);
  });

  maybe()("also stands down when the newer campaign is only PAUSED", async () => {
    // PAUSED is live too, so reopening beside it would be the same overspend.
    const { executionProfileId, campaignId: a } = await withCampaign("late-refund-paused", 1);
    const result = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    if (result.outcome !== "ADMITTED") throw new Error("unreachable");
    const b = await campaigns.createCampaign({ executionProfileId, maxDispatches: 4 });
    await campaigns.pauseCampaign(b.id);

    await budget.releaseCertainNonDispatch(result.reservation);

    expect((await campaignRow(a)).status).toBe("EXHAUSTED");
    expect((await campaignRow(a)).dispatchesUsed).toBe(0);
    expect((await campaignRow(b.id)).status).toBe("PAUSED");
  });
});

describe("legacy reservations keep their pre-campaign behaviour", () => {
  maybe()("reserve() still creates a reservation with no campaign", async () => {
    // This is the remaining bypass, and the test says so out loud: weight is
    // spent with no campaign counting it.
    const executionProfileId = await makeProfile("legacy-reserve");
    const granted = await budget.reserve({ executionProfileId, weightCap: AMPLE_CAP });
    expect(granted.outcome).toBe("GRANTED");
    if (granted.outcome !== "GRANTED") throw new Error("unreachable");
    expect(granted.reservation.campaignId).toBeNull();

    const row = await prisma!.historicalFillWeightReservation.findUniqueOrThrow({
      where: { id: granted.reservation.id },
      select: { campaignId: true },
    });
    expect(row.campaignId).toBeNull();
  });

  maybe()("releases a null-campaign reservation with weight only", async () => {
    const executionProfileId = await makeProfile("legacy-release");
    const granted = await budget.reserve({ executionProfileId, weightCap: AMPLE_CAP });
    if (granted.outcome !== "GRANTED") throw new Error("unreachable");
    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(HISTORICAL_FILL_RESERVATION_WEIGHT);

    await budget.releaseCertainNonDispatch(granted.reservation);

    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(0);
    const row = await prisma!.historicalFillWeightReservation.findUniqueOrThrow({
      where: { id: granted.reservation.id },
      select: { releasedAt: true, campaignId: true },
    });
    expect(row.releasedAt).toBeInstanceOf(Date);
    expect(row.campaignId).toBeNull();
  });

  maybe()("stays idempotent for a legacy reservation", async () => {
    const executionProfileId = await makeProfile("legacy-release-twice");
    const granted = await budget.reserve({ executionProfileId, weightCap: AMPLE_CAP });
    if (granted.outcome !== "GRANTED") throw new Error("unreachable");

    await budget.releaseCertainNonDispatch(granted.reservation);
    await budget.releaseCertainNonDispatch(granted.reservation);

    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(0);
  });

  maybe()("leaves a campaign untouched when a legacy reservation is released", async () => {
    // A legacy release must not reach for a campaign that happens to exist.
    const { executionProfileId, campaignId } = await withCampaign("legacy-beside-campaign", 3);
    const admitted = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    if (admitted.outcome !== "ADMITTED") throw new Error("unreachable");
    const legacy = await budget.reserve({ executionProfileId, weightCap: AMPLE_CAP });
    if (legacy.outcome !== "GRANTED") throw new Error("unreachable");

    await budget.releaseCertainNonDispatch(legacy.reservation);

    // The campaign's own slot is still spent; only the legacy weight came back.
    expect((await campaignRow(campaignId)).dispatchesUsed).toBe(1);
    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(HISTORICAL_FILL_RESERVATION_WEIGHT);
  });
});

describe("corrupt accounting fails closed rather than repairing itself", () => {
  maybe()("rolls the whole release back when the campaign counter is already zero", async () => {
    const { executionProfileId, campaignId } = await withCampaign("invariant-campaign", 3);
    const admitted = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    if (admitted.outcome !== "ADMITTED") throw new Error("unreachable");

    // Somebody zeroed the counter behind our back.
    await prisma!.historicalFillCampaign.update({
      where: { id: campaignId },
      data: { dispatchesUsed: 0 },
    });

    await expect(budget.releaseCertainNonDispatch(admitted.reservation)).rejects.toBeInstanceOf(
      HistoricalFillWeightBudgetInvariantError
    );

    // Nothing was written — not the weight, and not releasedAt. The reservation
    // stays outstanding and stays releasable once the books are repaired.
    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(HISTORICAL_FILL_RESERVATION_WEIGHT);
    expect((await reservationsOf(campaignId))[0].releasedAt).toBeNull();
    expect((await campaignRow(campaignId)).dispatchesUsed).toBe(0);
  });

  maybe()("rolls the whole release back when the bucket cannot fund the weight", async () => {
    const { executionProfileId, campaignId } = await withCampaign("invariant-bucket", 3);
    const admitted = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    if (admitted.outcome !== "ADMITTED") throw new Error("unreachable");

    await prisma!.historicalFillWeightBucket.update({
      where: { id: admitted.reservation.bucketId },
      data: { weightUsed: 0 },
    });

    await expect(budget.releaseCertainNonDispatch(admitted.reservation)).rejects.toBeInstanceOf(
      HistoricalFillWeightBudgetInvariantError
    );

    // The campaign slot must NOT have been given back either.
    expect((await campaignRow(campaignId)).dispatchesUsed).toBe(1);
    expect((await reservationsOf(campaignId))[0].releasedAt).toBeNull();
  });

  maybe()("cannot delete a campaign out from under an outstanding reservation", async () => {
    const { executionProfileId, campaignId } = await withCampaign("invariant-fk", 2);
    await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });

    await expect(
      prisma!.historicalFillCampaign.delete({ where: { id: campaignId } })
    ).rejects.toThrow();
  });
});

describe("cross-process contention", () => {
  maybe()("N=1 campaign, two simultaneous admissions: exactly one wins", async () => {
    const { executionProfileId, campaignId } = await withCampaign("race-n1", 1);
    const [a, b] = [contender(), contender()];

    const results = await Promise.all([
      a.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP }),
      b.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP }),
    ]);

    expect(results.filter((r) => r.outcome === "ADMITTED")).toHaveLength(1);
    const campaign = await campaignRow(campaignId);
    expect(campaign.dispatchesUsed).toBe(1);
    expect(campaign.status).toBe("EXHAUSTED");
    expect(await reservationsOf(campaignId)).toHaveLength(1);
    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(HISTORICAL_FILL_RESERVATION_WEIGHT);
  });

  maybe()("N=5 campaign, ten simultaneous admissions: exactly five win", async () => {
    // Minute weight is deliberately ample, so the ONLY thing bounding this is
    // the campaign. Six winners would mean the ceiling is not a ceiling.
    const { executionProfileId, campaignId } = await withCampaign("race-n5", 5);
    const contenders = Array.from({ length: 10 }, () => contender());

    const results = await Promise.all(
      contenders.map((c) => c.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP }))
    );

    expect(results.filter((r) => r.outcome === "ADMITTED")).toHaveLength(5);
    const campaign = await campaignRow(campaignId);
    expect(campaign.dispatchesUsed).toBe(5);
    expect(campaign.status).toBe("EXHAUSTED");
    expect(campaign.endedAt).toBeInstanceOf(Date);
    expect(await reservationsOf(campaignId)).toHaveLength(5);
    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(
      5 * HISTORICAL_FILL_RESERVATION_WEIGHT
    );
  });

  maybe()("weight bounds the winners when it is tighter than the campaign", async () => {
    // Campaign allows 5, the minute allows 2. Exactly two admissions, and the
    // three refused ones must have rolled their increments back.
    const { executionProfileId, campaignId } = await withCampaign("race-weight-bound", 5);
    const bucketStart = await currentBucketStart();
    await prisma!.historicalFillWeightBucket.create({
      data: { executionProfileId, bucketStart, weightCap: 10, weightUsed: 0 },
    });
    const contenders = Array.from({ length: 5 }, () => contender());

    const results = await Promise.all(
      contenders.map((c) => c.admitCampaignDispatch({ executionProfileId, weightCap: 10 }))
    );

    expect(results.filter((r) => r.outcome === "ADMITTED")).toHaveLength(2);
    expect(
      results.filter((r) => r.outcome === "GLOBAL_USER_TRADES_WEIGHT_EXHAUSTED")
    ).toHaveLength(3);

    const campaign = await campaignRow(campaignId);
    expect(campaign.dispatchesUsed).toBe(2);
    expect(campaign.status).toBe("ACTIVE");
    expect(await reservationsOf(campaignId)).toHaveLength(2);
    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(10);
  });

  maybe()("two profiles do not bound each other", async () => {
    const one = await withCampaign("race-profile-a", 2);
    const two = await withCampaign("race-profile-b", 2);
    const [a, b] = [contender(), contender()];

    const results = await Promise.all([
      a.admitCampaignDispatch({ executionProfileId: one.executionProfileId, weightCap: AMPLE_CAP }),
      b.admitCampaignDispatch({ executionProfileId: two.executionProfileId, weightCap: AMPLE_CAP }),
      a.admitCampaignDispatch({ executionProfileId: one.executionProfileId, weightCap: AMPLE_CAP }),
      b.admitCampaignDispatch({ executionProfileId: two.executionProfileId, weightCap: AMPLE_CAP }),
    ]);

    expect(results.every((r) => r.outcome === "ADMITTED")).toBe(true);
    expect((await campaignRow(one.campaignId)).dispatchesUsed).toBe(2);
    expect((await campaignRow(two.campaignId)).dispatchesUsed).toBe(2);
  });
});

describe("refund contention", () => {
  maybe()("two concurrent refunds of one reservation give back exactly one of each", async () => {
    const { executionProfileId, campaignId } = await withCampaign("race-refund-same", 3);
    const admitted = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    if (admitted.outcome !== "ADMITTED") throw new Error("unreachable");
    const [a, b] = [contender(), contender()];

    await Promise.all([
      a.releaseCertainNonDispatch(admitted.reservation),
      b.releaseCertainNonDispatch(admitted.reservation),
    ]);

    expect((await campaignRow(campaignId)).dispatchesUsed).toBe(0);
    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(0);
    const rows = await reservationsOf(campaignId);
    expect(rows).toHaveLength(1);
    expect(rows[0].releasedAt).toBeInstanceOf(Date);
  });

  maybe()("concurrent refunds of different reservations aggregate correctly", async () => {
    const { executionProfileId, campaignId } = await withCampaign("race-refund-many", 4);
    const reservations: HistoricalFillWeightReservation[] = [];
    for (let i = 0; i < 4; i += 1) {
      const step = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
      if (step.outcome !== "ADMITTED") throw new Error("unreachable");
      reservations.push(step.reservation);
    }
    expect((await campaignRow(campaignId)).dispatchesUsed).toBe(4);

    // Each reservation refunded twice, from two different connections.
    const refunders = reservations.map(() => contender());
    await Promise.all(
      reservations.flatMap((reservation, index) => [
        refunders[index].releaseCertainNonDispatch(reservation),
        contender().releaseCertainNonDispatch(reservation),
      ])
    );

    expect((await campaignRow(campaignId)).dispatchesUsed).toBe(0);
    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(0);
  });
});

describe("operator transitions race admission and refund safely", () => {
  maybe()("admission versus pause settles one way or the other, never both", async () => {
    const { executionProfileId, campaignId } = await withCampaign("race-admit-pause", 3);
    const admitter = contender();

    const [admission] = await Promise.allSettled([
      admitter.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP }),
      campaigns.pauseCampaign(campaignId),
    ]);

    const campaign = await campaignRow(campaignId);
    expect(campaign.status).toBe("PAUSED");
    if (admission.status === "fulfilled" && admission.value.outcome === "ADMITTED") {
      // Admission got the lock first: the slot is spent, then the pause landed.
      expect(campaign.dispatchesUsed).toBe(1);
    } else {
      // Pause got the lock first: admission saw a non-ACTIVE campaign.
      expect(campaign.dispatchesUsed).toBe(0);
      expect(await reservationsOf(campaignId)).toHaveLength(0);
    }
  });

  maybe()("admission versus abort never leaves a slot spent on a live campaign", async () => {
    const { executionProfileId, campaignId } = await withCampaign("race-admit-abort", 3);
    const admitter = contender();

    const [admission] = await Promise.allSettled([
      admitter.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP }),
      campaigns.abortCampaign(campaignId),
    ]);

    const campaign = await campaignRow(campaignId);
    expect(campaign.status).toBe("ABORTED");
    const admittedCount =
      admission.status === "fulfilled" && admission.value.outcome === "ADMITTED" ? 1 : 0;
    expect(campaign.dispatchesUsed).toBe(admittedCount);
    expect(await reservationsOf(campaignId)).toHaveLength(admittedCount);
  });

  maybe()("refund versus pause always ends PAUSED with the slot returned", async () => {
    const { executionProfileId, campaignId } = await withCampaign("race-refund-pause", 3);
    const admitted = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    if (admitted.outcome !== "ADMITTED") throw new Error("unreachable");
    const refunder = contender();

    await Promise.all([
      refunder.releaseCertainNonDispatch(admitted.reservation),
      campaigns.pauseCampaign(campaignId),
    ]);

    const campaign = await campaignRow(campaignId);
    // Whichever went first, a refund never unpauses.
    expect(campaign.status).toBe("PAUSED");
    expect(campaign.dispatchesUsed).toBe(0);
    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(0);
  });

  maybe()("refund versus abort always ends ABORTED with the slot returned", async () => {
    const { executionProfileId, campaignId } = await withCampaign("race-refund-abort", 3);
    const admitted = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    if (admitted.outcome !== "ADMITTED") throw new Error("unreachable");
    const refunder = contender();

    await Promise.all([
      refunder.releaseCertainNonDispatch(admitted.reservation),
      campaigns.abortCampaign(campaignId),
    ]);

    const campaign = await campaignRow(campaignId);
    // A refund never resurrects an abort.
    expect(campaign.status).toBe("ABORTED");
    expect(campaign.dispatchesUsed).toBe(0);
  });
});

describe("lock-order probe", () => {
  maybe()(
    "mixes admission, refund and every operator transition without deadlocking",
    async () => {
      // Load-bearing. Admission takes CAMPAIGN -> BUCKET -> RESERVATION; refund
      // takes RESERVATION -> BUCKET -> CAMPAIGN. Those are opposite orders, and
      // the ONLY reason they cannot deadlock is that both take the per-profile
      // advisory lock first. This probe drives all six operations at the same
      // profile from independent connections and insists every one settles.
      const { executionProfileId, campaignId } = await withCampaign("deadlock-probe", 100);
      const outstanding: HistoricalFillWeightReservation[] = [];
      for (let i = 0; i < 6; i += 1) {
        const step = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
        if (step.outcome !== "ADMITTED") throw new Error("unreachable");
        outstanding.push(step.reservation);
      }

      const budgets = Array.from({ length: 6 }, () => contender());
      const campaignClients = Array.from({ length: 4 }, () =>
        new HistoricalFillCampaignService(independentClient())
      );

      const rounds: Promise<unknown>[] = [];
      for (let round = 0; round < 3; round += 1) {
        rounds.push(
          ...budgets.map((b) => b.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP })),
          ...outstanding.map((reservation, index) =>
            budgets[index].releaseCertainNonDispatch(reservation)
          ),
          campaignClients[0].pauseCampaign(campaignId),
          campaignClients[1].resumeCampaign(campaignId),
          campaignClients[2].createCampaign({ executionProfileId, maxDispatches: 3 }),
          campaignClients[3].abortCampaign(campaignId)
        );
      }

      const settled = await Promise.allSettled(rounds);

      // Conflicts are expected and fine; a DEADLOCK is not. Postgres reports
      // 40P01, and a lock-order bug here would surface as exactly that.
      const deadlocked = settled
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => String(r.reason?.message ?? r.reason))
        .filter((message) => /deadlock|40P01/i.test(message));
      expect(deadlocked).toEqual([]);

      // And the accounting still agrees with itself afterwards.
      const campaign = await campaignRow(campaignId);
      expect(campaign.dispatchesUsed).toBeGreaterThanOrEqual(0);
      expect(campaign.dispatchesUsed).toBeLessThanOrEqual(campaign.maxDispatches);

      const live = await prisma!.historicalFillCampaign.count({
        where: { executionProfileId, status: { in: ["ACTIVE", "PAUSED"] } },
      });
      expect(live).toBeLessThanOrEqual(1);

      // Weight and outstanding reservations must still reconcile exactly.
      const bucket = await bucketOf(executionProfileId);
      const outstandingWeight = await prisma!.historicalFillWeightReservation.aggregate({
        where: { bucketId: bucket!.id, releasedAt: null },
        _sum: { weight: true },
      });
      expect(bucket!.weightUsed).toBe(outstandingWeight._sum.weight ?? 0);
    },
    60_000
  );
});

describe("the campaign advisory lock is really taken", () => {
  /**
   * Hold the profile's campaign lock from an independent connection.
   *
   * Deterministic, unlike the probe above: the probe can only show that a
   * deadlock did not happen this time, whereas this shows that the lock is
   * actually acquired on each path that claims to acquire it.
   */
  function holdCampaignLock(executionProfileId: string, holdMs: number) {
    const client = independentClient();
    let signalHeld: () => void;
    const held = new Promise<void>((resolve) => (signalHeld = resolve));
    let releasedAt = 0;

    const done = client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HISTORICAL_FILL_CAMPAIGN_LOCK_NAMESPACE}::int, ${profileLockKey(
        executionProfileId
      )}::int)`;
      signalHeld();
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      releasedAt = Date.now();
    });

    return { held, done, releasedAt: () => releasedAt };
  }

  maybe()("admission waits for the lock before touching any campaign row", async () => {
    const { executionProfileId } = await withCampaign("lock-admit", 3);
    const holder = holdCampaignLock(executionProfileId, 700);
    await holder.held;

    const finished = contender()
      .admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP })
      .then((result) => ({ at: Date.now(), result }));
    const [{ at, result }] = await Promise.all([finished, holder.done]);

    expect(result.outcome).toBe("ADMITTED");
    expect(at).toBeGreaterThanOrEqual(holder.releasedAt());
  });

  maybe()("a campaign-aware refund waits for the same lock", async () => {
    // Without this the refund could run its RESERVATION -> BUCKET -> CAMPAIGN
    // sequence while an admission held CAMPAIGN and wanted BUCKET, which is the
    // deadlock the fixed lock order exists to make impossible.
    const { executionProfileId } = await withCampaign("lock-refund", 3);
    const admitted = await budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP });
    if (admitted.outcome !== "ADMITTED") throw new Error("unreachable");

    const holder = holdCampaignLock(executionProfileId, 700);
    await holder.held;

    const finished = contender()
      .releaseCertainNonDispatch(admitted.reservation)
      .then(() => Date.now());
    const [at] = await Promise.all([finished, holder.done]);

    expect(at).toBeGreaterThanOrEqual(holder.releasedAt());
  });

  maybe()("a legacy refund takes no campaign lock at all", async () => {
    // The pre-campaign path must stay exactly as it was. It touches no campaign
    // row, so it cannot close a lock cycle and must not be made to wait for one.
    const executionProfileId = await makeProfile("lock-legacy-refund");
    const granted = await budget.reserve({ executionProfileId, weightCap: AMPLE_CAP });
    if (granted.outcome !== "GRANTED") throw new Error("unreachable");

    const holder = holdCampaignLock(executionProfileId, 900);
    await holder.held;

    const startedAt = Date.now();
    await contender().releaseCertainNonDispatch(granted.reservation);
    expect(Date.now() - startedAt).toBeLessThan(700);

    expect((await bucketOf(executionProfileId))!.weightUsed).toBe(0);
    await holder.done;
  });
});
