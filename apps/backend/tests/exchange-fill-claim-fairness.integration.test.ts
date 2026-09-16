import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * Which eligible window gets claimed next, against a REAL Postgres.
 *
 * Ordering is a property of stored rows and a real query planner, so none of it
 * can be proven against a mock: an in-memory sort would only prove the sort I
 * wrote, not the one the database performs. Every test here builds durable rows
 * whose natural insertion order CONTRADICTS the expected claim order, so a
 * missing `orderBy` cannot pass by accident.
 *
 * Fairness here means one thing only: deterministic, starvation-resistant FIFO
 * among rows that are ALREADY eligible. It is not a symbol scheduler, and it
 * never makes an ineligible row claimable.
 *
 * Nothing here imports a Binance client and no exchange request is made.
 */

const TAG = "claim-fairness";
const SYMBOL = "FAIRUSDT";
const SYMBOL_B = "FAIRBUSDT";
const SYMBOL_C = "FAIRCUSDT";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ExchangeFillIngestWindowService, INGEST_CLAIM_LEASE_MS, MAX_INGEST_ATTEMPTS } = await import(
  "../src/modules/execution/exchange-fill-ingest-window.service"
);

const maybe = () => (available ? it : it.skip);

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A fixed reference instant every row and every claim is measured against. */
const NOW = new Date("2026-08-12T09:15:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let work: InstanceType<typeof ExchangeFillIngestWindowService>;
let sequence = 0;

async function profile(alias: string) {
  sequence += 1;
  const row = await prisma!.executionProfile.create({
    data: {
      name: `${TAG} ${alias} ${sequence}`,
      accountIdentifier: `${TAG}-${alias}-${sequence}`,
      environment: "TESTNET",
      isEnabled: false,
    },
  });
  return row.id;
}

/**
 * One durable window, with `createdAt` written explicitly.
 *
 * `createdAt` defaults to now() but is an ordinary column, so a test can place
 * a row anywhere in the queue's history without waiting for real time to pass.
 */
async function windowRow(
  executionProfileId: string,
  options: {
    symbol?: string;
    startTimeMs: number;
    endTimeMs?: number;
    createdAt: Date;
    status?: "PENDING" | "COMPLETE" | "SPLIT" | "ABANDONED";
    attempts?: number;
    claimedAt?: Date | null;
    claimOwner?: string | null;
    nextEligibleAt?: Date | null;
  }
) {
  const row = await prisma!.exchangeFillIngestWindow.create({
    data: {
      executionProfileId,
      symbol: options.symbol ?? SYMBOL,
      startTimeMs: BigInt(options.startTimeMs),
      endTimeMs: BigInt(options.endTimeMs ?? options.startTimeMs + DAY_MS - 1),
      createdAt: options.createdAt,
      status: options.status ?? "PENDING",
      attempts: options.attempts ?? 0,
      claimedAt: options.claimedAt ?? null,
      claimOwner: options.claimOwner ?? null,
      nextEligibleAt: options.nextEligibleAt ?? null,
    },
  });
  return row.id;
}

/** Claims repeatedly at the SAME instant, returning the ids in queue order. */
async function claimOrder(executionProfileId: string, count: number, worker = "worker-a") {
  const ids: Array<string | null> = [];
  for (let i = 0; i < count; i += 1) {
    const claim = await work.claimNextWindow(prisma!, {
      executionProfileId,
      workerId: `${worker}-${i}`,
      now: NOW,
    });
    ids.push(claim?.windowId ?? null);
  }
  return ids;
}

const rowOf = async (id: string) =>
  prisma!.exchangeFillIngestWindow.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  if (!prisma || !available) return;
  work = new ExchangeFillIngestWindowService(prisma);
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
    await prisma.executionProfile.deleteMany({ where: { id: { in: profiles } } });
  }
  await prisma.$disconnect();
});

describe("canonical queue order", () => {
  maybe()("A. claims the oldest created row first, whatever the intervals say", async () => {
    const id = await profile("fifo");
    const base = 20_000 * DAY_MS;
    // Interval order is the REVERSE of creation order, so ordering by bounds
    // alone -- or by creation descending -- produces the opposite answer.
    const newest = await windowRow(id, { createdAt: ago(HOUR_MS), startTimeMs: base });
    const middle = await windowRow(id, { createdAt: ago(2 * HOUR_MS), startTimeMs: base + DAY_MS });
    const oldest = await windowRow(id, {
      createdAt: ago(3 * HOUR_MS),
      startTimeMs: base + 2 * DAY_MS,
    });

    expect(await claimOrder(id, 3)).toEqual([oldest, middle, newest]);
  });

  maybe()("B. breaks a creation tie on the older interval", async () => {
    const id = await profile("interval-tie");
    const createdAt = ago(HOUR_MS);
    const base = 21_000 * DAY_MS;
    // Inserted newest-interval first.
    const later = await windowRow(id, { createdAt, startTimeMs: base + 2 * DAY_MS });
    const middle = await windowRow(id, { createdAt, startTimeMs: base + DAY_MS });
    const earlier = await windowRow(id, { createdAt, startTimeMs: base });

    expect(await claimOrder(id, 3)).toEqual([earlier, middle, later]);
  });

  maybe()("C. breaks a creation and interval tie on the symbol", async () => {
    const id = await profile("symbol-tie");
    const createdAt = ago(HOUR_MS);
    const startTimeMs = 22_000 * DAY_MS;
    // Same account, same interval, three symbols -- the natural key permits it
    // because `symbol` is part of that key. Inserted in reverse symbol order.
    const last = await windowRow(id, { createdAt, startTimeMs, symbol: SYMBOL });
    const middle = await windowRow(id, { createdAt, startTimeMs, symbol: SYMBOL_C });
    const first = await windowRow(id, { createdAt, startTimeMs, symbol: SYMBOL_B });

    expect(SYMBOL_B < SYMBOL_C && SYMBOL_C < SYMBOL).toBe(true);
    expect(await claimOrder(id, 3)).toEqual([first, middle, last]);
  });

  /**
   * D. The deepest tie the schema can actually produce.
   *
   * `id ASC` is the final guarantee of a TOTAL order, but it is unreachable by
   * construction: the natural key is
   * `(executionProfileId, symbol, startTimeMs, endTimeMs)`, so two rows that
   * tie on creation, interval start, symbol AND interval end cannot both exist.
   * The deepest reachable tie is therefore `endTimeMs`, proven here; `id`
   * remains in the ordering as the backstop that keeps the sort total even if
   * that uniqueness ever changed.
   */
  maybe()("D. breaks a creation, start and symbol tie on the shorter interval", async () => {
    const id = await profile("bounds-tie");
    const createdAt = ago(HOUR_MS);
    const startTimeMs = 23_000 * DAY_MS;
    const longest = await windowRow(id, { createdAt, startTimeMs, endTimeMs: startTimeMs + 3 * HOUR_MS });
    const middle = await windowRow(id, { createdAt, startTimeMs, endTimeMs: startTimeMs + 2 * HOUR_MS });
    const shortest = await windowRow(id, { createdAt, startTimeMs, endTimeMs: startTimeMs + HOUR_MS });

    expect(await claimOrder(id, 3)).toEqual([shortest, middle, longest]);
  });

  maybe()("K. attempts do not buy or lose a place in the queue", async () => {
    const id = await profile("attempts-neutral");
    const base = 24_000 * DAY_MS;
    // The older row has already failed twice and been released; the newer row
    // is untouched. Both are eligible, and age alone decides.
    const older = await windowRow(id, {
      createdAt: ago(3 * HOUR_MS),
      startTimeMs: base,
      attempts: 2,
    });
    const newer = await windowRow(id, { createdAt: ago(HOUR_MS), startTimeMs: base + DAY_MS });

    expect(MAX_INGEST_ATTEMPTS).toBeGreaterThan(2);
    expect(await claimOrder(id, 2)).toEqual([older, newer]);
  });
});

describe("ordering never overrides eligibility", () => {
  maybe()("E. a backed-off retry waits its turn out, however old it is", async () => {
    const id = await profile("retry-waiting");
    const base = 25_000 * DAY_MS;
    const waiting = await windowRow(id, {
      createdAt: ago(10 * HOUR_MS),
      startTimeMs: base,
      attempts: 1,
      nextEligibleAt: new Date(NOW.getTime() + 5 * 60_000),
    });
    const eligible = await windowRow(id, { createdAt: ago(HOUR_MS), startTimeMs: base + DAY_MS });

    expect(await claimOrder(id, 2)).toEqual([eligible, null]);

    // The old row was not touched on the way past it.
    const row = await rowOf(waiting);
    expect(row.attempts).toBe(1);
    expect(row.claimedAt).toBeNull();
    expect(row.claimOwner).toBeNull();
    expect(row.status).toBe("PENDING");
  });

  maybe()("F. the same retry regains its original place once the backoff expires", async () => {
    const id = await profile("retry-due");
    const base = 26_000 * DAY_MS;
    // Identical to E except the backoff has now elapsed. Its createdAt was
    // never rewritten by the failure, so it goes back to the FRONT.
    const waited = await windowRow(id, {
      createdAt: ago(10 * HOUR_MS),
      startTimeMs: base,
      attempts: 1,
      nextEligibleAt: new Date(NOW.getTime() - 60_000),
    });
    const newer = await windowRow(id, { createdAt: ago(HOUR_MS), startTimeMs: base + DAY_MS });

    expect(await claimOrder(id, 2)).toEqual([waited, newer]);
  });

  maybe()("H. an active lease is invisible and a stale one rejoins the same queue", async () => {
    const id = await profile("lease-state");
    const base = 27_000 * DAY_MS;
    const active = await windowRow(id, {
      createdAt: ago(10 * HOUR_MS),
      startTimeMs: base,
      attempts: 1,
      claimedAt: NOW,
      claimOwner: "worker-live",
    });
    const staleOlder = await windowRow(id, {
      createdAt: ago(5 * HOUR_MS),
      startTimeMs: base + DAY_MS,
      attempts: 1,
      claimedAt: new Date(NOW.getTime() - INGEST_CLAIM_LEASE_MS - 60_000),
      claimOwner: "worker-gone",
    });
    const staleNewer = await windowRow(id, {
      createdAt: ago(2 * HOUR_MS),
      startTimeMs: base + 2 * DAY_MS,
      attempts: 1,
      claimedAt: new Date(NOW.getTime() - INGEST_CLAIM_LEASE_MS - 60_000),
      claimOwner: "worker-gone",
    });

    // Stale rows take their ordinary place by age -- there is no "stale first"
    // or "stale last" class -- and the live lease is never offered at all,
    // even though it is the oldest row of the three.
    expect(await claimOrder(id, 3)).toEqual([staleOlder, staleNewer, null]);

    const untouched = await rowOf(active);
    expect(untouched.claimOwner).toBe("worker-live");
    expect(untouched.attempts).toBe(1);
  });

  maybe()("terminal and exhausted rows stay out of the queue however old", async () => {
    const id = await profile("ineligible");
    const base = 28_000 * DAY_MS;
    await windowRow(id, { createdAt: ago(20 * HOUR_MS), startTimeMs: base, status: "COMPLETE" });
    await windowRow(id, {
      createdAt: ago(19 * HOUR_MS),
      startTimeMs: base + DAY_MS,
      status: "ABANDONED",
    });
    await windowRow(id, {
      createdAt: ago(18 * HOUR_MS),
      startTimeMs: base + 2 * DAY_MS,
      attempts: MAX_INGEST_ATTEMPTS,
    });
    const onlyEligible = await windowRow(id, {
      createdAt: ago(HOUR_MS),
      startTimeMs: base + 3 * DAY_MS,
    });

    expect(await claimOrder(id, 2)).toEqual([onlyEligible, null]);
  });
});

describe("split children queue behind the backlog", () => {
  maybe()("G. a real split's children do not cut ahead of older eligible roots", async () => {
    const id = await profile("split-fairness");
    const base = 29_000 * DAY_MS;

    // A real split, through the real mechanism: seed one root, claim it, and
    // let the service create the children. They are written NOW, so they are
    // the newest rows in the account by construction.
    const parentStart = base + 5 * DAY_MS;
    const parentEnd = parentStart + DAY_MS - 1;
    await work.seedWindow(prisma!, {
      executionProfileId: id,
      symbol: SYMBOL,
      startTimeMs: parentStart,
      endTimeMs: parentEnd,
    });
    const parentClaim = await work.claimNextWindow(prisma!, {
      executionProfileId: id,
      workerId: "worker-split",
      now: NOW,
    });
    expect(parentClaim).not.toBeNull();
    const mid = parentStart + Math.floor((parentEnd - parentStart) / 2);
    await work.splitWindow(parentClaim!, {
      left: { startTimeMs: parentStart, endTimeMs: mid },
      right: { startTimeMs: mid + 1, endTimeMs: parentEnd },
    });

    // Two roots that were already waiting when the split happened. Written
    // afterwards here, but durably OLDER, which is the state under test.
    const rootA = await windowRow(id, { createdAt: ago(3 * HOUR_MS), startTimeMs: base });
    const rootB = await windowRow(id, { createdAt: ago(2 * HOUR_MS), startTimeMs: base + DAY_MS });

    const children = await prisma!.exchangeFillIngestWindow.findMany({
      where: { executionProfileId: id, parentId: parentClaim!.windowId },
      orderBy: { startTimeMs: "asc" },
      select: { id: true },
    });
    expect(children).toHaveLength(2);

    // The older backlog is drained first; the children take their turn after.
    expect(await claimOrder(id, 4)).toEqual([
      rootA,
      rootB,
      children[0]!.id,
      children[1]!.id,
    ]);

    // The split parent itself is terminal and never re-offered.
    expect((await rowOf(parentClaim!.windowId)).status).toBe("SPLIT");
  });
});

describe("concurrent claims stay atomic", () => {
  maybe()("I. two workers racing two rows take one each, fenced", async () => {
    const id = await profile("race-two-rows");
    const base = 30_000 * DAY_MS;
    const older = await windowRow(id, { createdAt: ago(3 * HOUR_MS), startTimeMs: base });
    const newer = await windowRow(id, {
      createdAt: ago(2 * HOUR_MS),
      startTimeMs: base + DAY_MS,
    });

    const [a, b] = await Promise.all([
      work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-a", now: NOW }),
      work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-b", now: NOW }),
    ]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Which worker got which row is not asserted -- the mechanism is optimistic
    // compare-and-set, so either may win the first candidate. That they are
    // DISTINCT is the invariant.
    expect(new Set([a!.windowId, b!.windowId]).size).toBe(2);
    expect([a!.windowId, b!.windowId].sort()).toEqual([older, newer].sort());

    for (const row of [await rowOf(older), await rowOf(newer)]) {
      // Exactly one generation was burned on each row.
      expect(row.attempts).toBe(1);
      expect(row.claimedAt).not.toBeNull();
      expect(["worker-a", "worker-b"]).toContain(row.claimOwner);
      expect(row.status).toBe("PENDING");
    }
    expect(a!.attempt).toBe(1);
    expect(b!.attempt).toBe(1);
  });

  maybe()("J. two workers racing ONE row produce exactly one owner", async () => {
    const id = await profile("race-one-row");
    const only = await windowRow(id, {
      createdAt: ago(3 * HOUR_MS),
      startTimeMs: 31_000 * DAY_MS,
    });

    const results = await Promise.all([
      work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-a", now: NOW }),
      work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-b", now: NOW }),
    ]);

    const winners = results.filter((claim) => claim !== null);
    const losers = results.filter((claim) => claim === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]!.windowId).toBe(only);

    // The loser neither burned a second generation nor overwrote the owner.
    const row = await rowOf(only);
    expect(row.attempts).toBe(1);
    expect(row.claimOwner).toBe(winners[0]!.claimOwner);
    expect(row.claimedAt).toEqual(NOW);
    expect(row.status).toBe("PENDING");
  });
});
