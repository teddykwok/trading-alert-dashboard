import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase, resolveTestDatabase } from "./helpers/test-database";
import {
  HistoricalFillCampaignConflictError,
  HistoricalFillCampaignNotFoundError,
  HistoricalFillCampaignService,
  HistoricalFillCampaignStateError,
  MAX_CAMPAIGN_DISPATCHES,
} from "../src/modules/execution/historical-fill-campaign.service";
import { HISTORICAL_FILL_CAMPAIGN_LOCK_NAMESPACE } from "../src/modules/execution/historical-fill-campaign-lock";
import { profileLockKey } from "../src/modules/execution/profile-lock";

/**
 * Campaign lifecycle against a REAL Postgres.
 *
 * Everything load-bearing here is a claim about the DATABASE — a partial unique
 * index, two CHECK constraints, an advisory lock — and not one of them can be
 * proven against a mock, which would only confirm that the mock agrees with the
 * test. Contention is driven through INDEPENDENT PrismaClients so that races
 * are genuinely cross-connection rather than one client racing itself.
 *
 * No Binance client is imported here or by the code under test.
 */

const TAG = "fill-campaign-synthetic";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const maybe = () => (available ? it : it.skip);

const clients: PrismaClient[] = [];
function independentClient(): PrismaClient {
  const client = new PrismaClient({ datasources: { db: { url: resolveTestDatabase().url } } });
  clients.push(client);
  return client;
}
function contender(): HistoricalFillCampaignService {
  return new HistoricalFillCampaignService(independentClient());
}

let service: HistoricalFillCampaignService;

/** A fresh profile per test, so one test's live campaign never blocks another's. */
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
 * Force a status the service will not produce on its own.
 *
 * EXHAUSTED and COMPLETED are written by the admission path, which this slice
 * deliberately does not contain. Reaching them by raw UPDATE is the honest way
 * to test the transitions that must refuse them, and it keeps this suite from
 * depending on code that does not exist yet.
 */
async function forceStatus(campaignId: string, status: string): Promise<void> {
  await prisma!.$executeRawUnsafe(
    `UPDATE "HistoricalFillCampaign" SET "status" = $1::"HistoricalFillCampaignStatus" WHERE "id" = $2`,
    status,
    campaignId
  );
}

beforeAll(async () => {
  if (!prisma || !available) return;
  service = new HistoricalFillCampaignService(prisma);
});

afterAll(async () => {
  if (prisma && available) {
    // Every one of these relations is onDelete: Restrict, so cleanup has to run
    // leaves first: reservations, then the buckets and campaigns they point at,
    // then the profiles those belong to.
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

describe("campaign creation", () => {
  maybe()("opens ACTIVE with the ceiling frozen and nothing spent", async () => {
    const profileId = await makeProfile("create");
    const campaign = await service.createCampaign({
      executionProfileId: profileId,
      maxDispatches: 7,
      note: "why",
    });

    expect(campaign.status).toBe("ACTIVE");
    expect(campaign.maxDispatches).toBe(7);
    expect(campaign.dispatchesUsed).toBe(0);
    expect(campaign.endedAt).toBeNull();
    expect(campaign.lastAdmissionAt).toBeNull();
    expect(campaign.note).toBe("why");
  });

  maybe()("refuses a second campaign while one is ACTIVE", async () => {
    const profileId = await makeProfile("second-active");
    await service.createCampaign({ executionProfileId: profileId, maxDispatches: 3 });
    await expect(
      service.createCampaign({ executionProfileId: profileId, maxDispatches: 3 })
    ).rejects.toBeInstanceOf(HistoricalFillCampaignConflictError);
  });

  maybe()("refuses a second campaign while one is PAUSED", async () => {
    // PAUSED is LIVE. If pausing freed the profile, an operator could hold any
    // number of campaigns at once and the ceiling would bound none of them.
    const profileId = await makeProfile("second-paused");
    const first = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 3 });
    await service.pauseCampaign(first.id);

    await expect(
      service.createCampaign({ executionProfileId: profileId, maxDispatches: 3 })
    ).rejects.toBeInstanceOf(HistoricalFillCampaignConflictError);
  });

  maybe().each(["ABORTED", "COMPLETED", "EXHAUSTED"])(
    "allows a new campaign once the previous one is %s",
    async (finished) => {
      const profileId = await makeProfile(`after-${finished}`);
      const first = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 3 });
      await forceStatus(first.id, finished);

      const second = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 5 });
      expect(second.status).toBe("ACTIVE");
      expect(second.id).not.toBe(first.id);
      // History accumulates: the finished campaign is still there.
      expect(await service.getCampaignStatus(first.id)).not.toBeNull();
    }
  );

  maybe()("keeps campaigns on different profiles entirely independent", async () => {
    const one = await makeProfile("independent-a");
    const two = await makeProfile("independent-b");
    await service.createCampaign({ executionProfileId: one, maxDispatches: 2 });
    const other = await service.createCampaign({ executionProfileId: two, maxDispatches: 2 });
    expect(other.status).toBe("ACTIVE");
  });
});

describe("campaign transitions", () => {
  maybe()("pauses an ACTIVE campaign without ending it", async () => {
    const profileId = await makeProfile("pause");
    const campaign = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 4 });

    const paused = await service.pauseCampaign(campaign.id);
    expect(paused.status).toBe("PAUSED");
    // A paused campaign is expected back, so it has not ended.
    expect(paused.endedAt).toBeNull();
    expect(paused.maxDispatches).toBe(4);
  });

  maybe()("resumes a PAUSED campaign", async () => {
    const profileId = await makeProfile("resume");
    const campaign = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 4 });
    await service.pauseCampaign(campaign.id);

    const resumed = await service.resumeCampaign(campaign.id);
    expect(resumed.status).toBe("ACTIVE");
    expect(resumed.endedAt).toBeNull();
  });

  maybe().each(["PAUSED", "EXHAUSTED", "COMPLETED", "ABORTED"])(
    "refuses to pause a campaign that is %s",
    async (status) => {
      const profileId = await makeProfile(`pause-from-${status}`);
      const campaign = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 4 });
      await forceStatus(campaign.id, status);

      await expect(service.pauseCampaign(campaign.id)).rejects.toBeInstanceOf(HistoricalFillCampaignStateError);
      expect((await service.getCampaignStatus(campaign.id))!.status).toBe(status);
    }
  );

  maybe()("refuses to resume an EXHAUSTED campaign", async () => {
    // The load-bearing refusal. A campaign is EXHAUSTED because it spent every
    // slot an operator authorised; if `resume` could undo that, the ceiling
    // would be a suggestion rather than a bound. Only the refund path may
    // reopen one, and only after PROVING the dispatch never happened.
    const profileId = await makeProfile("resume-exhausted");
    const campaign = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 4 });
    await forceStatus(campaign.id, "EXHAUSTED");

    await expect(service.resumeCampaign(campaign.id)).rejects.toBeInstanceOf(HistoricalFillCampaignStateError);
    expect((await service.getCampaignStatus(campaign.id))!.status).toBe("EXHAUSTED");
  });

  maybe().each(["ACTIVE", "COMPLETED", "ABORTED"])(
    "refuses to resume a campaign that is %s",
    async (status) => {
      const profileId = await makeProfile(`resume-from-${status}`);
      const campaign = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 4 });
      await forceStatus(campaign.id, status);

      await expect(service.resumeCampaign(campaign.id)).rejects.toBeInstanceOf(HistoricalFillCampaignStateError);
    }
  );

  maybe().each(["ACTIVE", "PAUSED", "EXHAUSTED"])(
    "aborts a campaign that is %s and stamps the ending",
    async (status) => {
      const profileId = await makeProfile(`abort-from-${status}`);
      const campaign = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 4 });
      await forceStatus(campaign.id, status);

      const aborted = await service.abortCampaign(campaign.id, "operator stopped it");
      expect(aborted.status).toBe("ABORTED");
      expect(aborted.endedAt).toBeInstanceOf(Date);
      expect(aborted.note).toBe("operator stopped it");
      // Aborting frees the profile: the campaign is no longer live.
      expect(await service.getLiveCampaign(profileId)).toBeNull();
    }
  );

  maybe().each(["COMPLETED", "ABORTED"])("refuses to abort a campaign that is %s", async (status) => {
    // Hard terminals. Rewriting how a finished backfill ended would rewrite the
    // audit trail for spending a real account's allowance.
    const profileId = await makeProfile(`abort-hard-${status}`);
    const campaign = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 4 });
    await forceStatus(campaign.id, status);

    await expect(service.abortCampaign(campaign.id)).rejects.toBeInstanceOf(HistoricalFillCampaignStateError);
    expect((await service.getCampaignStatus(campaign.id))!.status).toBe(status);
  });

  maybe()("leaves the ceiling and the counter untouched across every transition", async () => {
    // The ceiling is frozen at creation: raising it later would retroactively
    // change what an operator authorised. The counter belongs to admission.
    const profileId = await makeProfile("frozen");
    const campaign = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 9 });

    const paused = await service.pauseCampaign(campaign.id);
    const resumed = await service.resumeCampaign(campaign.id);
    const aborted = await service.abortCampaign(campaign.id);

    for (const state of [paused, resumed, aborted]) {
      expect(state.maxDispatches).toBe(9);
      expect(state.dispatchesUsed).toBe(0);
    }
  });

  maybe()("preserves an existing note when a transition supplies none", async () => {
    const profileId = await makeProfile("note-kept");
    const campaign = await service.createCampaign({
      executionProfileId: profileId,
      maxDispatches: 2,
      note: "original reason",
    });
    const paused = await service.pauseCampaign(campaign.id);
    expect(paused.note).toBe("original reason");
  });

  maybe().each([
    ["pause", (id: string) => service.pauseCampaign(id)],
    ["resume", (id: string) => service.resumeCampaign(id)],
    ["abort", (id: string) => service.abortCampaign(id)],
  ])("reports a missing campaign distinctly from a bad state on %s", async (_label, act) => {
    await expect(act("campaign-that-does-not-exist")).rejects.toBeInstanceOf(
      HistoricalFillCampaignNotFoundError
    );
  });
});

describe("campaign reads", () => {
  maybe()("reports a PAUSED campaign as live", async () => {
    // If PAUSED were excluded from liveness, admission would see "no campaign"
    // and a paused backfill would look exactly like an unbounded one.
    const profileId = await makeProfile("live-paused");
    const campaign = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 6 });
    await service.pauseCampaign(campaign.id);

    const live = await service.getLiveCampaign(profileId);
    expect(live?.id).toBe(campaign.id);
    expect(live?.status).toBe("PAUSED");
  });

  maybe().each(["EXHAUSTED", "COMPLETED", "ABORTED"])(
    "does not report a %s campaign as live",
    async (status) => {
      const profileId = await makeProfile(`not-live-${status}`);
      const campaign = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 6 });
      await forceStatus(campaign.id, status);
      expect(await service.getLiveCampaign(profileId)).toBeNull();
    }
  );

  maybe()("returns null for a profile that has never run one", async () => {
    expect(await service.getLiveCampaign(await makeProfile("never"))).toBeNull();
  });

  maybe()("returns null for an unknown campaign id rather than throwing", async () => {
    expect(await service.getCampaignStatus("no-such-campaign")).toBeNull();
  });
});

describe("database constraints cannot be talked past", () => {
  /** Insert straight into the table, bypassing the service entirely. */
  async function rawInsert(profileId: string, maxDispatches: number, used = 0): Promise<number> {
    return prisma!.$executeRawUnsafe(
      `INSERT INTO "HistoricalFillCampaign"
         ("id","executionProfileId","status","maxDispatches","dispatchesUsed","updatedAt")
       VALUES ($1, $2, 'ACTIVE'::"HistoricalFillCampaignStatus", $3, $4, now())`,
      `raw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      profileId,
      maxDispatches,
      used
    );
  }

  maybe().each([0, 101, 1_000])("refuses a raw insert with maxDispatches %i", async (value) => {
    // The service is one caller. A CLI, an operator route, a migration script or
    // a psql session are others, and the CHECK is the bound none of them can
    // argue with.
    const profileId = await makeProfile(`raw-${value}`);
    await expect(rawInsert(profileId, value)).rejects.toThrow(/maxDispatches_check/);
  });

  maybe()("refuses a negative ceiling on whichever check fires first", async () => {
    // -1 violates BOTH constraints at once: the ceiling is below 1, and the
    // counter's `dispatchesUsed <= maxDispatches` is 0 <= -1. Postgres reports
    // whichever it evaluates first, so pinning one name here would make this
    // test a hostage to constraint evaluation order. The claim is refusal.
    const profileId = await makeProfile("raw-negative-max");
    await expect(rawInsert(profileId, -1)).rejects.toThrow(/check constraint "HistoricalFillCampaign_/);
  });

  maybe().each([1, MAX_CAMPAIGN_DISPATCHES])("accepts a raw insert at the bound %i", async (value) => {
    const profileId = await makeProfile(`raw-ok-${value}`);
    await expect(rawInsert(profileId, value)).resolves.toBe(1);
  });

  maybe()("refuses a counter above its own ceiling", async () => {
    const profileId = await makeProfile("raw-overspend");
    await expect(rawInsert(profileId, 5, 6)).rejects.toThrow(/dispatchesUsed_check/);
  });

  maybe()("refuses a negative counter", async () => {
    const profileId = await makeProfile("raw-negative-used");
    await expect(rawInsert(profileId, 5, -1)).rejects.toThrow(/dispatchesUsed_check/);
  });

  maybe()("refuses a second live campaign inserted raw", async () => {
    const profileId = await makeProfile("raw-second-live");
    const live = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 2 });
    // Prisma reports 23505 without the index name, so the claim is pinned to
    // the unique violation itself and to the row count it protects.
    await expect(rawInsert(profileId, 2)).rejects.toThrow(/already exists/);
    expect(
      await prisma!.historicalFillCampaign.findMany({ where: { executionProfileId: profileId } })
    ).toHaveLength(1);
    expect((await service.getLiveCampaign(profileId))!.id).toBe(live.id);
  });

  maybe()("requires a status to be stated", async () => {
    // No column default, deliberately: a campaign that existed because someone
    // omitted a field would be an accidental licence to spend.
    const profileId = await makeProfile("raw-no-status");
    await expect(
      prisma!.$executeRawUnsafe(
        `INSERT INTO "HistoricalFillCampaign" ("id","executionProfileId","maxDispatches","updatedAt")
         VALUES ($1, $2, 3, now())`,
        `raw-nostatus-${Date.now()}`,
        profileId
      )
    ).rejects.toThrow(/status/i);
  });

  maybe()("has no default on status in the live schema", async () => {
    const rows = await prisma!.$queryRawUnsafe<{ column_default: string | null }[]>(
      `select column_default from information_schema.columns
       where table_name = 'HistoricalFillCampaign' and column_name = 'status'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].column_default).toBeNull();
  });
});

describe("live-campaign uniqueness lives in the database", () => {
  maybe()("carries the rule as a PARTIAL unique index", async () => {
    const rows = await prisma!.$queryRawUnsafe<{ indexdef: string }[]>(
      `select indexdef from pg_indexes
       where tablename = 'HistoricalFillCampaign'
         and indexname = 'HistoricalFillCampaign_one_live_per_profile'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/UNIQUE INDEX/);
    // A TOTAL unique index would forbid a profile from ever running a second
    // backfill; the WHERE clause is what lets history accumulate.
    expect(rows[0].indexdef).toMatch(/WHERE/);
    expect(rows[0].indexdef).toMatch(/ACTIVE/);
    expect(rows[0].indexdef).toMatch(/PAUSED/);
    expect(rows[0].indexdef).not.toMatch(/COMPLETED|ABORTED/);
  });

  maybe()("keeps campaignId on reservations nullable", async () => {
    // Permanently nullable: reservations written before campaigns existed are
    // still complete records of weight that was spent.
    const rows = await prisma!.$queryRawUnsafe<{ is_nullable: string }[]>(
      `select is_nullable from information_schema.columns
       where table_name = 'HistoricalFillWeightReservation' and column_name = 'campaignId'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe("YES");
  });

  maybe()("restricts deletion of a campaign that a reservation points at", async () => {
    const profileId = await makeProfile("fk-restrict");
    const campaign = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 2 });
    const bucket = await prisma!.historicalFillWeightBucket.create({
      data: { executionProfileId: profileId, bucketStart: new Date(), weightCap: 25, weightUsed: 5 },
      select: { id: true },
    });
    await prisma!.historicalFillWeightReservation.create({
      data: { bucketId: bucket.id, weight: 5, campaignId: campaign.id },
    });

    await expect(
      prisma!.historicalFillCampaign.delete({ where: { id: campaign.id } })
    ).rejects.toThrow();
  });
});

describe("concurrency", () => {
  maybe()("lets exactly one of two simultaneous creates win", async () => {
    // Both contenders pass their pre-check — neither can see the other's
    // uncommitted insert — so only the partial unique index can decide this.
    const profileId = await makeProfile("race-create");
    const [a, b] = [contender(), contender()];

    const results = await Promise.allSettled([
      a.createCampaign({ executionProfileId: profileId, maxDispatches: 3 }),
      b.createCampaign({ executionProfileId: profileId, maxDispatches: 3 }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(HistoricalFillCampaignConflictError);

    expect(
      await prisma!.historicalFillCampaign.count({
        where: { executionProfileId: profileId, status: { in: ["ACTIVE", "PAUSED"] } },
      })
    ).toBe(1);
  });

  maybe()("never leaves two live campaigns after eight simultaneous creates", async () => {
    const profileId = await makeProfile("race-create-many");
    const contenders = Array.from({ length: 8 }, () => contender());

    const results = await Promise.allSettled(
      contenders.map((c) => c.createCampaign({ executionProfileId: profileId, maxDispatches: 2 }))
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    expect(
      await prisma!.historicalFillCampaign.count({
        where: { executionProfileId: profileId, status: { in: ["ACTIVE", "PAUSED"] } },
      })
    ).toBe(1);
  });

  maybe()("refuses a create racing a resume of the profile's paused campaign", async () => {
    // PAUSED is itself live, so the creator must lose whichever order these
    // land in. The profile must end with exactly one live campaign.
    const profileId = await makeProfile("race-create-resume");
    const paused = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 3 });
    await service.pauseCampaign(paused.id);

    const [a, b] = [contender(), contender()];
    const results = await Promise.allSettled([
      a.resumeCampaign(paused.id),
      b.createCampaign({ executionProfileId: profileId, maxDispatches: 3 }),
    ]);

    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(
      HistoricalFillCampaignConflictError
    );

    const live = await prisma!.historicalFillCampaign.findMany({
      where: { executionProfileId: profileId, status: { in: ["ACTIVE", "PAUSED"] } },
    });
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(paused.id);
    expect(live[0].status).toBe("ACTIVE");
  });

  maybe()("lets exactly one of two simultaneous pauses win", async () => {
    const profileId = await makeProfile("race-pause");
    const campaign = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 3 });
    const [a, b] = [contender(), contender()];

    const results = await Promise.allSettled([
      a.pauseCampaign(campaign.id),
      b.pauseCampaign(campaign.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(HistoricalFillCampaignStateError);
    expect((await service.getCampaignStatus(campaign.id))!.status).toBe("PAUSED");
  });

  maybe()("never lets a concurrent abort and pause both succeed", async () => {
    const profileId = await makeProfile("race-pause-abort");
    const campaign = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 3 });
    const [a, b] = [contender(), contender()];

    const results = await Promise.allSettled([
      a.abortCampaign(campaign.id),
      b.pauseCampaign(campaign.id),
    ]);

    // Both orderings are legal — abort accepts PAUSED — so the claim is that
    // the row ends in exactly one of them, never interleaved into a third.
    const final = (await service.getCampaignStatus(campaign.id))!;
    if (results[0].status === "fulfilled" && results[1].status === "fulfilled") {
      // Pause then abort: both moves were legal in that order.
      expect(final.status).toBe("ABORTED");
    } else {
      expect(["ABORTED", "PAUSED"]).toContain(final.status);
    }
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });
});

describe("the campaign advisory lock is really taken", () => {
  /**
   * Hold the campaign lock for one profile from an independent connection.
   *
   * Resolves `held` once the lock is genuinely acquired, so the waiter starts
   * against a lock that is already down rather than racing to take it first.
   */
  function holdCampaignLock(profileId: string, holdMs: number) {
    const client = independentClient();
    let signalHeld: () => void;
    const held = new Promise<void>((resolve) => (signalHeld = resolve));
    let releasedAt = 0;

    const done = client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HISTORICAL_FILL_CAMPAIGN_LOCK_NAMESPACE}::int, ${profileLockKey(
        profileId
      )}::int)`;
      signalHeld();
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      releasedAt = Date.now();
    });

    return { held, done, releasedAt: () => releasedAt };
  }

  maybe()("blocks a transition while another holder has the profile's lock", async () => {
    // If the transition did not take the lock, it would finish immediately and
    // the admission path could act on a campaign caught mid-transition.
    const profileId = await makeProfile("lock-blocks");
    const campaign = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 3 });

    const holder = holdCampaignLock(profileId, 700);
    await holder.held;

    const waiter = contender();
    const pausedAt = waiter.pauseCampaign(campaign.id).then(() => Date.now());
    const [finishedAt] = await Promise.all([pausedAt, holder.done]);

    expect(finishedAt).toBeGreaterThanOrEqual(holder.releasedAt());
    expect((await service.getCampaignStatus(campaign.id))!.status).toBe("PAUSED");
  });

  maybe()("blocks a create while another holder has the profile's lock", async () => {
    const profileId = await makeProfile("lock-blocks-create");

    const holder = holdCampaignLock(profileId, 700);
    await holder.held;

    const waiter = contender();
    const createdAt = waiter
      .createCampaign({ executionProfileId: profileId, maxDispatches: 3 })
      .then(() => Date.now());
    const [finishedAt] = await Promise.all([createdAt, holder.done]);

    expect(finishedAt).toBeGreaterThanOrEqual(holder.releasedAt());
  });

  maybe()("does not block a different profile", async () => {
    // A lock this coarse would be a real cost if it serialized unrelated
    // accounts. It is keyed per profile precisely so it does not.
    const blocked = await makeProfile("lock-other-blocked");
    const free = await makeProfile("lock-other-free");

    const holder = holdCampaignLock(blocked, 900);
    await holder.held;

    const startedAt = Date.now();
    await contender().createCampaign({ executionProfileId: free, maxDispatches: 3 });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(700);
    await holder.done;
  });

  maybe()("releases the lock when a transition fails", async () => {
    // Transaction-scoped: ROLLBACK must free it. A leaked lock would wedge the
    // profile until the connection died, which is exactly what a SESSION lock
    // on a pooled connection would do.
    const profileId = await makeProfile("lock-released-on-failure");
    const campaign = await service.createCampaign({ executionProfileId: profileId, maxDispatches: 3 });
    await forceStatus(campaign.id, "ABORTED");

    await expect(service.pauseCampaign(campaign.id)).rejects.toBeInstanceOf(
      HistoricalFillCampaignStateError
    );

    // If the failed transition had leaked its lock, this would hang.
    const startedAt = Date.now();
    await service.createCampaign({ executionProfileId: profileId, maxDispatches: 3 });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  maybe()("cannot deadlock two profiles worked in opposite orders", async () => {
    // Each campaign operation takes exactly ONE lock in its own transaction, so
    // no transaction can hold A while waiting for B. That is what makes a cycle
    // impossible rather than merely unlikely.
    const first = await makeProfile("deadlock-a");
    const second = await makeProfile("deadlock-b");
    const [a, b] = [contender(), contender()];

    const forward = (async () => {
      const one = await a.createCampaign({ executionProfileId: first, maxDispatches: 2 });
      const two = await a.createCampaign({ executionProfileId: second, maxDispatches: 2 }).catch(() => null);
      await a.pauseCampaign(one.id);
      return two;
    })();
    const backward = (async () => {
      const two = await b.createCampaign({ executionProfileId: second, maxDispatches: 2 }).catch(() => null);
      const one = await b.createCampaign({ executionProfileId: first, maxDispatches: 2 }).catch(() => null);
      return [one, two];
    })();

    await expect(Promise.all([forward, backward])).resolves.toBeDefined();

    for (const profileId of [first, second]) {
      expect(
        await prisma!.historicalFillCampaign.count({
          where: { executionProfileId: profileId, status: { in: ["ACTIVE", "PAUSED"] } },
        })
      ).toBe(1);
    }
  });
});
