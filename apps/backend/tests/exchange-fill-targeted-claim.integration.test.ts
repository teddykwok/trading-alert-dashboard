import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * `claimSpecificWindow` against a REAL Postgres.
 *
 * The claim is the ONLY authority protecting a targeted dispatch, so every
 * predicate it shares with the FIFO path is exercised here against real rows
 * and real concurrency rather than a stub. The governing rule under test is
 * that targeting narrows WHICH row is considered and never WHETHER it may be
 * claimed -- and that a refusal is a refusal, not a redirection to other work.
 */

const TAG = "targeted-claim";
const SYMBOL_A = "TGTAUSDT";
const SYMBOL_B = "TGTBUSDT";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ExchangeFillIngestWindowService, MAX_INGEST_ATTEMPTS, INGEST_CLAIM_LEASE_MS } =
  await import("../src/modules/execution/exchange-fill-ingest-window.service");

const maybe = () => (available ? it : it.skip);

const NOW = new Date("2026-09-18T12:00:00.000Z");
const DAY = 86_400_000;
const DAY_START = Date.UTC(2026, 8, 15);

let work: InstanceType<typeof ExchangeFillIngestWindowService>;
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

/** A window row written directly, so any state under test can be constructed. */
async function windowRow(
  executionProfileId: string,
  symbol: string,
  dayOffset: number,
  overrides: Record<string, unknown> = {}
) {
  const start = DAY_START + dayOffset * DAY;
  return prisma!.exchangeFillIngestWindow.create({
    data: {
      executionProfileId,
      symbol,
      startTimeMs: BigInt(start),
      endTimeMs: BigInt(start + DAY - 1),
      ...overrides,
    },
  });
}

const claimTarget = (executionProfileId: string, windowId: string, now: Date = NOW) =>
  work.claimSpecificWindow(prisma!, {
    executionProfileId,
    workerId: "canary-worker",
    windowId,
    now,
  });

const rowOf = (id: string) =>
  prisma!.exchangeFillIngestWindow.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  if (!prisma || !available) return;
  work = new ExchangeFillIngestWindowService(prisma);
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

describe("a named window is claimed, and only that window", () => {
  maybe()("claims the exact requested PENDING target", async () => {
    const target = await profile("exact");
    const wanted = await windowRow(target.id, SYMBOL_A, 0);

    const claim = await claimTarget(target.id, wanted.id);

    expect(claim).not.toBeNull();
    expect(claim!.windowId).toBe(wanted.id);
    expect(claim!.symbol).toBe(SYMBOL_A);
    expect(claim!.startTimeMs).toBe(DAY_START);
    expect(claim!.endTimeMs).toBe(DAY_START + DAY - 1);
    expect(claim!.attempt).toBe(1);
    expect(claim!.claimOwner).toBe("canary-worker");
  });

  maybe()("never touches an older FIFO-earlier window", async () => {
    const target = await profile("fifo");
    // Created FIRST, so `claimNextWindow` would have taken this one.
    const earlier = await windowRow(target.id, SYMBOL_A, 0);
    const wanted = await windowRow(target.id, SYMBOL_B, 1);

    const claim = await claimTarget(target.id, wanted.id);

    expect(claim!.windowId).toBe(wanted.id);
    const untouched = await rowOf(earlier.id);
    expect(untouched.attempts).toBe(0);
    expect(untouched.claimedAt).toBeNull();
    expect(untouched.claimOwner).toBeNull();
    expect(untouched.lastAttemptAt).toBeNull();
  });

  maybe()("sets attempts, lease, owner and last attempt exactly once", async () => {
    const target = await profile("fields");
    const wanted = await windowRow(target.id, SYMBOL_A, 0);

    await claimTarget(target.id, wanted.id);

    const row = await rowOf(wanted.id);
    expect(row.attempts).toBe(1);
    expect(row.claimedAt?.toISOString()).toBe(NOW.toISOString());
    expect(row.claimOwner).toBe("canary-worker");
    expect(row.lastAttemptAt?.toISOString()).toBe(NOW.toISOString());
    expect(row.status).toBe("PENDING");
  });
});

describe("the id alone is never authority", () => {
  maybe()("refuses a window belonging to another profile", async () => {
    const mine = await profile("mine");
    const stranger = await profile("stranger");
    const theirs = await windowRow(stranger.id, SYMBOL_A, 0);

    // The id is correct and the row is perfectly claimable -- for its OWNER.
    const claim = await claimTarget(mine.id, theirs.id);

    expect(claim).toBeNull();
    const untouched = await rowOf(theirs.id);
    expect(untouched.attempts).toBe(0);
    expect(untouched.claimOwner).toBeNull();
  });

  maybe()("refuses an id that does not exist", async () => {
    const target = await profile("missing");
    // A well-formed id nothing was ever written under.
    expect(await claimTarget(target.id, "cxxxxxxxxxxxxxxxxxxxxxxxx")).toBeNull();
  });

  maybe()("never falls back to another claimable window", async () => {
    const target = await profile("nofallback");
    const available = await windowRow(target.id, SYMBOL_A, 0);

    const claim = await claimTarget(target.id, "cxxxxxxxxxxxxxxxxxxxxxxxx");

    expect(claim).toBeNull();
    // The queue was NOT empty. A fallback would have taken this.
    const untouched = await rowOf(available.id);
    expect(untouched.attempts).toBe(0);
    expect(untouched.claimedAt).toBeNull();
  });
});

describe("targeting narrows which row, never whether it may be claimed", () => {
  // Every terminal and blocked state the FIFO scan would have skipped. Naming
  // one must not promote it.
  const REFUSED_STATUSES = ["COMPLETE", "SPLIT", "ABANDONED"] as const;

  for (const status of REFUSED_STATUSES) {
    maybe()(`refuses a ${status} window`, async () => {
      const target = await profile(`status-${status.toLowerCase()}`);
      const wanted = await windowRow(target.id, SYMBOL_A, 0, { status });

      expect(await claimTarget(target.id, wanted.id)).toBeNull();
      const untouched = await rowOf(wanted.id);
      expect(untouched.attempts).toBe(0);
      expect(untouched.status).toBe(status);
    });
  }

  maybe()("refuses a window whose attempts are exhausted", async () => {
    const target = await profile("exhausted");
    const wanted = await windowRow(target.id, SYMBOL_A, 0, { attempts: MAX_INGEST_ATTEMPTS });

    expect(await claimTarget(target.id, wanted.id)).toBeNull();
    expect((await rowOf(wanted.id)).attempts).toBe(MAX_INGEST_ATTEMPTS);
  });

  maybe()("claims at exactly one attempt below the ceiling", async () => {
    // The boundary in the other direction, so the predicate is `<` and not `<=`.
    const target = await profile("boundary");
    const wanted = await windowRow(target.id, SYMBOL_A, 0, {
      attempts: MAX_INGEST_ATTEMPTS - 1,
    });

    const claim = await claimTarget(target.id, wanted.id);

    expect(claim).not.toBeNull();
    expect(claim!.attempt).toBe(MAX_INGEST_ATTEMPTS);
  });

  maybe()("refuses a window still inside its backoff", async () => {
    const target = await profile("backoff");
    const wanted = await windowRow(target.id, SYMBOL_A, 0, {
      nextEligibleAt: new Date(NOW.getTime() + 60_000),
    });

    expect(await claimTarget(target.id, wanted.id)).toBeNull();
    expect((await rowOf(wanted.id)).attempts).toBe(0);
  });

  maybe()("claims once the backoff has elapsed", async () => {
    const target = await profile("backoff-done");
    const wanted = await windowRow(target.id, SYMBOL_A, 0, {
      nextEligibleAt: new Date(NOW.getTime() - 1),
    });

    expect(await claimTarget(target.id, wanted.id)).not.toBeNull();
  });

  maybe()("refuses a window under a live lease", async () => {
    const target = await profile("leased");
    const wanted = await windowRow(target.id, SYMBOL_A, 0, {
      attempts: 1,
      claimedAt: new Date(NOW.getTime() - INGEST_CLAIM_LEASE_MS + 1_000),
      claimOwner: "other-worker",
    });

    expect(await claimTarget(target.id, wanted.id)).toBeNull();
    const untouched = await rowOf(wanted.id);
    expect(untouched.attempts).toBe(1);
    expect(untouched.claimOwner).toBe("other-worker");
  });

  maybe()("claims a window whose lease has gone stale, under the same threshold", async () => {
    const target = await profile("stale");
    const wanted = await windowRow(target.id, SYMBOL_A, 0, {
      attempts: 1,
      claimedAt: new Date(NOW.getTime() - INGEST_CLAIM_LEASE_MS - 1),
      claimOwner: "dead-worker",
    });

    const claim = await claimTarget(target.id, wanted.id);

    expect(claim).not.toBeNull();
    expect(claim!.attempt).toBe(2);
    const row = await rowOf(wanted.id);
    expect(row.claimOwner).toBe("canary-worker");
    expect(row.attempts).toBe(2);
  });
});

describe("the compare-and-set is the authority", () => {
  maybe()("lets exactly one of two concurrent targeted claims win", async () => {
    const target = await profile("race");
    const wanted = await windowRow(target.id, SYMBOL_A, 0);

    const [first, second] = await Promise.all([
      work.claimSpecificWindow(prisma!, {
        executionProfileId: target.id,
        workerId: "worker-one",
        windowId: wanted.id,
        now: NOW,
      }),
      work.claimSpecificWindow(prisma!, {
        executionProfileId: target.id,
        workerId: "worker-two",
        windowId: wanted.id,
        now: NOW,
      }),
    ]);

    const winners = [first, second].filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    // ONE increment, not two: the loser matched nothing and wrote nothing.
    const row = await rowOf(wanted.id);
    expect(row.attempts).toBe(1);
    expect(row.claimOwner).toBe(winners[0]!.claimOwner);
  });

  maybe()("resolves a genuine read-read/write-write interleaving with one winner", async () => {
    // THE CAS'S OWN SCENARIO, and the reason the fences exist.
    //
    // The previous test cannot reach it: the first claim finishes before the
    // second even reads, so the read-side lease predicate refuses and the
    // compare-and-set is never consulted. Here BOTH claims read the same stale
    // generation first -- a row whose lease expired, so both see it as
    // claimable with identical `attempts` and `claimedAt` -- and only the
    // compare-and-set can decide between them.
    const target = await profile("cas");
    const wanted = await windowRow(target.id, SYMBOL_A, 0, {
      attempts: 1,
      claimedAt: new Date(NOW.getTime() - INGEST_CLAIM_LEASE_MS - 5_000),
      claimOwner: "dead-worker",
    });
    // A perfectly claimable DECOY, so that a loser silently falling back to
    // the FIFO queue would be visible here rather than indistinguishable from
    // a clean refusal.
    const decoy = await windowRow(target.id, SYMBOL_B, 1);

    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        work.claimSpecificWindow(prisma!, {
          executionProfileId: target.id,
          workerId: `racer-${index}`,
          windowId: wanted.id,
          now: NOW,
        })
      )
    );

    const winners = attempts.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    // Exactly ONE increment survived, from exactly one winner.
    const row = await rowOf(wanted.id);
    expect(row.attempts).toBe(2);
    expect(row.claimOwner).toBe(winners[0]!.claimOwner);
    expect(winners[0]!.attempt).toBe(2);
    // Every loser returned null and claimed NOTHING ELSE.
    const untouchedDecoy = await rowOf(decoy.id);
    expect(untouchedDecoy.attempts).toBe(0);
    expect(untouchedDecoy.claimedAt).toBeNull();
    expect(untouchedDecoy.claimOwner).toBeNull();
  });

  /**
   * A client that mutates the row BETWEEN the candidate read and the
   * compare-and-set.
   *
   * `claimSpecificWindow` touches exactly two delegate methods, so this narrow
   * stand-in is enough to drive the one interleaving that decides whether each
   * fence is individually load-bearing. It is TEST instrumentation through the
   * service's own injectable client -- production code is untouched, and there
   * is no sleep or timing assumption anywhere in it.
   */
  function clientInterferingAfterRead(after: () => Promise<unknown>) {
    return {
      exchangeFillIngestWindow: {
        findFirst: async (args: never) => {
          const candidate = await prisma!.exchangeFillIngestWindow.findFirst(args);
          await after();
          return candidate;
        },
        updateMany: (args: never) => prisma!.exchangeFillIngestWindow.updateMany(args),
      },
    } as never;
  }

  /** A stale lease, so the row is claimable and BOTH fence values are non-trivial. */
  const staleLeased = (executionProfileId: string) =>
    windowRow(executionProfileId, SYMBOL_A, 0, {
      attempts: 1,
      claimedAt: new Date(NOW.getTime() - INGEST_CLAIM_LEASE_MS - 5_000),
      claimOwner: "dead-worker",
    });

  maybe()("the attempts fence alone refuses when only attempts moved", async () => {
    const target = await profile("fence-attempts");
    const wanted = await staleLeased(target.id);
    const original = await rowOf(wanted.id);

    // ONLY `attempts` changes; `claimedAt` is left exactly as it was read.
    const claim = await work.claimSpecificWindow(
      clientInterferingAfterRead(() =>
        prisma!.exchangeFillIngestWindow.update({
          where: { id: wanted.id },
          data: { attempts: { increment: 1 } },
        })
      ),
      { executionProfileId: target.id, workerId: "racer", windowId: wanted.id, now: NOW }
    );

    expect(claim).toBeNull();
    const after = await rowOf(wanted.id);
    // The interfering write stands; the claim added nothing on top of it.
    expect(after.attempts).toBe(original.attempts + 1);
    expect(after.claimedAt?.toISOString()).toBe(original.claimedAt?.toISOString());
    expect(after.claimOwner).toBe("dead-worker");
  });

  maybe()("the claimedAt fence alone refuses when only the lease moved", async () => {
    const target = await profile("fence-lease");
    const wanted = await staleLeased(target.id);
    const original = await rowOf(wanted.id);
    // Still stale, so the row stays eligible -- only the VALUE differs, which
    // means nothing but the fence itself can refuse this claim.
    const movedLease = new Date(NOW.getTime() - INGEST_CLAIM_LEASE_MS - 9_000);

    const claim = await work.claimSpecificWindow(
      clientInterferingAfterRead(() =>
        prisma!.exchangeFillIngestWindow.update({
          where: { id: wanted.id },
          data: { claimedAt: movedLease },
        })
      ),
      { executionProfileId: target.id, workerId: "racer", windowId: wanted.id, now: NOW }
    );

    expect(claim).toBeNull();
    const after = await rowOf(wanted.id);
    expect(after.claimedAt?.toISOString()).toBe(movedLease.toISOString());
    // `attempts` never moved, so only the lease fence could have refused.
    expect(after.attempts).toBe(original.attempts);
    expect(after.claimOwner).toBe("dead-worker");
  });

  maybe()("a second sequential claim of the same window is refused", async () => {
    const target = await profile("twice");
    const wanted = await windowRow(target.id, SYMBOL_A, 0);

    expect(await claimTarget(target.id, wanted.id)).not.toBeNull();
    // The lease it just took is live, so the window is its own blocker.
    expect(await claimTarget(target.id, wanted.id)).toBeNull();
    expect((await rowOf(wanted.id)).attempts).toBe(1);
  });
});
