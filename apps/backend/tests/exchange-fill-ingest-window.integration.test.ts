import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * Durable ingestion work state, against a REAL Postgres.
 *
 * Every claim here is about what the DATABASE guarantees -- uniqueness, claim
 * exclusivity under real concurrency, atomic multi-row transitions, and the
 * refusal of a stale worker's write -- so none of it can be proven against a
 * mock. Nothing in this file imports a Binance client or the fill ledger, and
 * no exchange request is made anywhere in it or in the code under test.
 */

const TAG = "fill-ingest-window";
const SYMBOL = "WINDOWUSDT";
const OTHER_SYMBOL = "WINDOWBTCUSDT";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { USER_TRADES_MAX_WINDOW_MS, planUserTradesWindow } = await import(
  "../src/modules/binance/user-trades-window-planner"
);

const {
  ExchangeFillIngestWindowService,
  FillIngestWindowRefusedError,
  StaleFillIngestClaimError,
  FillIngestChildLineageError,
  MAX_INGEST_ATTEMPTS,
  INGEST_CLAIM_LEASE_MS,
  FILL_INGEST_REASON,
} = await import("../src/modules/execution/exchange-fill-ingest-window.service");

const maybe = () => (available ? it : it.skip);

type WindowService = InstanceType<typeof ExchangeFillIngestWindowService>;
let work: WindowService;
let sequence = 0;

/** A profile with a durable account+environment identity. */
async function profile(alias: string, environment: "TESTNET" | "MAINNET" = "TESTNET") {
  const row = await prisma!.executionProfile.create({
    data: { name: `${TAG} ${alias}`, accountIdentifier: `${TAG}-${alias}`, environment, isEnabled: false },
  });
  return row.id;
}

/** A distinct interval per call, so unrelated tests never collide. */
function interval(spanMs = 86_400_000 - 1): { startTimeMs: number; endTimeMs: number } {
  sequence += 1;
  const startTimeMs = sequence * 10_000_000_000;
  return { startTimeMs, endTimeMs: startTimeMs + spanMs };
}

const rowOf = async (id: string) =>
  prisma!.exchangeFillIngestWindow.findUniqueOrThrow({ where: { id } });

const windowsFor = async (executionProfileId: string) =>
  prisma!.exchangeFillIngestWindow.findMany({
    where: { executionProfileId },
    orderBy: [{ startTimeMs: "asc" }, { endTimeMs: "asc" }],
  });

/** Seeds one window and claims it, returning the live claim. */
async function seededClaim(executionProfileId: string, worker = "worker-a", symbol = SYMBOL) {
  const bounds = interval();
  await work.seedWindow(prisma!, { executionProfileId, symbol, ...bounds });
  const claim = await work.claimNextWindow(prisma!, { executionProfileId, workerId: worker });
  if (claim === null) throw new Error("expected a claim");
  return claim;
}

/** The canonical halves of a window, as both the planner and the service compute them. */
function canonicalHalves(bounds: { startTimeMs: number; endTimeMs: number }) {
  const mid = bounds.startTimeMs + Math.floor((bounds.endTimeMs - bounds.startTimeMs) / 2);
  return {
    left: { startTimeMs: bounds.startTimeMs, endTimeMs: mid },
    right: { startTimeMs: mid + 1, endTimeMs: bounds.endTimeMs },
  };
}

/** Ages a lease past the cutoff without waiting for wall-clock time. */
const expireLease = async (id: string) =>
  prisma!.exchangeFillIngestWindow.update({
    where: { id },
    data: { claimedAt: new Date(Date.now() - INGEST_CLAIM_LEASE_MS - 60_000) },
  });

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
    // Children first: the self relation is RESTRICT, exactly so lineage cannot
    // be removed out from under itself.
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

// ---------------------------------------------------------------------------
// Seeding — exact, idempotent, and refusing what could never be a question
// ---------------------------------------------------------------------------

describe("seeding one exact interval", () => {
  maybe()("A. the first seed inserts exactly one row, PENDING and unclaimed", async () => {
    const id = await profile("seed-first");
    const bounds = interval();

    const seeded = await work.seedWindow(prisma!, { executionProfileId: id, symbol: SYMBOL, ...bounds });

    expect(seeded.created).toBe(true);
    const rows = await windowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "PENDING", attempts: 0, claimedAt: null, claimOwner: null,
      nextEligibleAt: null, parentId: null, symbol: SYMBOL,
    });
    // The bounds come back as the exact integers they went in as.
    expect(Number(rows[0].startTimeMs)).toBe(bounds.startTimeMs);
    expect(Number(rows[0].endTimeMs)).toBe(bounds.endTimeMs);
  });

  maybe()("B. seeding the same interval again is idempotent", async () => {
    const id = await profile("seed-idempotent");
    const bounds = interval();
    const args = { executionProfileId: id, symbol: SYMBOL, ...bounds };

    const first = await work.seedWindow(prisma!, args);
    const second = await work.seedWindow(prisma!, args);
    const third = await work.seedWindow(prisma!, args);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(await windowsFor(id)).toHaveLength(1);
  });

  maybe()("B2. a re-seed never resets progress on the existing row", async () => {
    // The restart case: the seeder runs again while the row is mid-flight.
    const id = await profile("seed-no-reset");
    const bounds = interval();
    const args = { executionProfileId: id, symbol: SYMBOL, ...bounds };
    await work.seedWindow(prisma!, args);
    const claim = await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "w" });

    await work.seedWindow(prisma!, args);

    const row = await rowOf(claim!.windowId);
    expect(row.attempts).toBe(1);
    expect(row.claimOwner).toBe("w");
  });

  maybe()("C. the same interval on a different SYMBOL is independent", async () => {
    const id = await profile("seed-symbol");
    const bounds = interval();

    const a = await work.seedWindow(prisma!, { executionProfileId: id, symbol: SYMBOL, ...bounds });
    const b = await work.seedWindow(prisma!, { executionProfileId: id, symbol: OTHER_SYMBOL, ...bounds });

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
    expect(await windowsFor(id)).toHaveLength(2);
  });

  maybe()("D. the same interval on a different PROFILE is independent", async () => {
    const first = await profile("seed-profile-a");
    const second = await profile("seed-profile-b");
    const bounds = interval();

    const a = await work.seedWindow(prisma!, { executionProfileId: first, symbol: SYMBOL, ...bounds });
    const b = await work.seedWindow(prisma!, { executionProfileId: second, symbol: SYMBOL, ...bounds });

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(await windowsFor(first)).toHaveLength(1);
    expect(await windowsFor(second)).toHaveLength(1);
  });

  maybe()("E. reversed, negative or non-integer bounds are refused", async () => {
    const id = await profile("seed-refused");
    const seed = (startTimeMs: number, endTimeMs: number) =>
      work.seedWindow(prisma!, { executionProfileId: id, symbol: SYMBOL, startTimeMs, endTimeMs });

    await expect(seed(2_000, 1_000)).rejects.toBeInstanceOf(FillIngestWindowRefusedError);
    await expect(seed(-1, 1_000)).rejects.toBeInstanceOf(FillIngestWindowRefusedError);
    await expect(seed(0, -1)).rejects.toBeInstanceOf(FillIngestWindowRefusedError);
    await expect(seed(1.5, 2_000)).rejects.toBeInstanceOf(FillIngestWindowRefusedError);
    await expect(seed(0, Number.NaN)).rejects.toBeInstanceOf(FillIngestWindowRefusedError);
    await expect(seed(0, Number.MAX_SAFE_INTEGER + 2)).rejects.toBeInstanceOf(
      FillIngestWindowRefusedError
    );
    expect(await windowsFor(id)).toEqual([]);
  });

  maybe()("F. a span longer than the documented maximum is refused", async () => {
    const id = await profile("seed-span");

    await expect(
      work.seedWindow(prisma!, {
        executionProfileId: id, symbol: SYMBOL,
        startTimeMs: 0, endTimeMs: USER_TRADES_MAX_WINDOW_MS + 1,
      })
    ).rejects.toBeInstanceOf(FillIngestWindowRefusedError);

    // Exactly the maximum is legal.
    const exact = await work.seedWindow(prisma!, {
      executionProfileId: id, symbol: SYMBOL,
      startTimeMs: 0, endTimeMs: USER_TRADES_MAX_WINDOW_MS,
    });
    expect(exact.created).toBe(true);
  });

  maybe()("F2. the SQL span constraint is the same number as the planner's constant", async () => {
    // The migration must carry a literal; this pins the two together so the
    // database cannot start disagreeing with the module that owns the rule.
    const id = await profile("seed-span-sql");
    const row = await prisma!.exchangeFillIngestWindow.create({
      data: {
        executionProfileId: id, symbol: SYMBOL,
        startTimeMs: BigInt(0), endTimeMs: BigInt(USER_TRADES_MAX_WINDOW_MS),
      },
    });
    expect(Number(row.endTimeMs)).toBe(USER_TRADES_MAX_WINDOW_MS);

    // One millisecond more is refused by PostgreSQL, not by the service.
    await expect(
      prisma!.exchangeFillIngestWindow.create({
        data: {
          executionProfileId: id, symbol: OTHER_SYMBOL,
          startTimeMs: BigInt(0), endTimeMs: BigInt(USER_TRADES_MAX_WINDOW_MS + 1),
        },
      })
    ).rejects.toThrow();
  });

  maybe()("G. a zero timestamp and a single-millisecond window are both legal", async () => {
    const id = await profile("seed-zero");

    const zero = await work.seedWindow(prisma!, {
      executionProfileId: id, symbol: SYMBOL, startTimeMs: 0, endTimeMs: 0,
    });
    const oneMs = await work.seedWindow(prisma!, {
      executionProfileId: id, symbol: OTHER_SYMBOL, startTimeMs: 99, endTimeMs: 99,
    });

    expect(zero.created).toBe(true);
    expect(oneMs.created).toBe(true);
    const rows = await windowsFor(id);
    expect(rows.map((row) => Number(row.startTimeMs)).sort((a, b) => a - b)).toEqual([0, 99]);
  });

  maybe()("the database refuses half a lease", async () => {
    // Structural truth, enforced where it cannot be forgotten.
    const id = await profile("seed-claim-pair");
    const bounds = interval();
    const seeded = await work.seedWindow(prisma!, { executionProfileId: id, symbol: SYMBOL, ...bounds });

    await expect(
      prisma!.exchangeFillIngestWindow.update({
        where: { id: seeded.id },
        data: { claimedAt: new Date() },
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Claiming — one row, immediately before the request it pays for
// ---------------------------------------------------------------------------

describe("claiming exactly one window", () => {
  maybe()("H/I/J. an eligible window is claimed, burning exactly one attempt", async () => {
    const id = await profile("claim-basic");
    const bounds = interval();
    const seeded = await work.seedWindow(prisma!, { executionProfileId: id, symbol: SYMBOL, ...bounds });

    const claim = await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-1" });

    expect(claim).not.toBeNull();
    expect(claim).toMatchObject({
      windowId: seeded.id, executionProfileId: id, symbol: SYMBOL,
      attempt: 1, claimOwner: "worker-1",
      startTimeMs: bounds.startTimeMs, endTimeMs: bounds.endTimeMs,
    });

    const row = await rowOf(seeded.id);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);
    expect(row.claimOwner).toBe("worker-1");
    expect(row.claimedAt).not.toBeNull();
    expect(row.lastAttemptAt).not.toBeNull();
  });

  maybe()("claiming with nothing eligible returns null rather than inventing work", async () => {
    const id = await profile("claim-empty");
    expect(await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "w" })).toBeNull();
  });

  maybe()("K. a LIVE lease cannot be taken by another worker", async () => {
    const id = await profile("claim-live-lease");
    await seededClaim(id, "worker-1");

    expect(await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-2" })).toBeNull();
  });

  maybe()("L. a STALE lease is reclaimable while attempts remain", async () => {
    const id = await profile("claim-stale-lease");
    const first = await seededClaim(id, "worker-1");
    await expireLease(first.windowId);

    const second = await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-2" });

    expect(second).not.toBeNull();
    expect(second!.windowId).toBe(first.windowId);
    expect(second!.attempt).toBe(2);
    expect((await rowOf(first.windowId)).claimOwner).toBe("worker-2");
  });

  maybe()("a window at the attempt ceiling is no longer claimable", async () => {
    const id = await profile("claim-exhausted");
    const claim = await seededClaim(id, "worker-1");
    await prisma!.exchangeFillIngestWindow.update({
      where: { id: claim.windowId },
      data: { attempts: MAX_INGEST_ATTEMPTS, claimedAt: null, claimOwner: null },
    });

    expect(await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "w" })).toBeNull();
  });

  maybe()("M. two workers racing one window: exactly one wins", async () => {
    const id = await profile("claim-race");
    const bounds = interval();
    await work.seedWindow(prisma!, { executionProfileId: id, symbol: SYMBOL, ...bounds });

    const [a, b] = await Promise.all([
      work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-a" }),
      work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-b" }),
    ]);

    const winners = [a, b].filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    const rows = await windowsFor(id);
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].claimOwner).toBe(winners[0]!.claimOwner);
  });

  maybe()("M2. five workers racing one window still produce one attempt", async () => {
    const id = await profile("claim-race-five");
    const bounds = interval();
    await work.seedWindow(prisma!, { executionProfileId: id, symbol: SYMBOL, ...bounds });

    const claims = await Promise.all(
      ["w1", "w2", "w3", "w4", "w5"].map((workerId) =>
        work.claimNextWindow(prisma!, { executionProfileId: id, workerId })
      )
    );

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect((await windowsFor(id))[0].attempts).toBe(1);
  });

  maybe()("N/O. a future backoff blocks the claim; a due one permits it", async () => {
    const id = await profile("claim-backoff");
    const bounds = interval();
    const seeded = await work.seedWindow(prisma!, { executionProfileId: id, symbol: SYMBOL, ...bounds });
    await prisma!.exchangeFillIngestWindow.update({
      where: { id: seeded.id },
      data: { nextEligibleAt: new Date(Date.now() + 3_600_000) },
    });

    expect(await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "w" })).toBeNull();

    await prisma!.exchangeFillIngestWindow.update({
      where: { id: seeded.id },
      data: { nextEligibleAt: new Date(Date.now() - 1_000) },
    });

    const claim = await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "w" });
    expect(claim).not.toBeNull();
  });

  maybe()("a claim never crosses an account boundary", async () => {
    const mine = await profile("claim-mine");
    const theirs = await profile("claim-theirs");
    const bounds = interval();
    await work.seedWindow(prisma!, { executionProfileId: theirs, symbol: SYMBOL, ...bounds });

    expect(await work.claimNextWindow(prisma!, { executionProfileId: mine, workerId: "w" })).toBeNull();
    expect(await work.claimNextWindow(prisma!, { executionProfileId: theirs, workerId: "w" })).not.toBeNull();
  });

  maybe()("a terminal window is never claimed again", async () => {
    const id = await profile("claim-terminal");
    const claim = await seededClaim(id, "worker-1");
    await work.markComplete(prisma!, claim);

    expect(await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "w" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Claim fencing — LOAD BEARING
// ---------------------------------------------------------------------------

describe("a stale claimant cannot advance durable coverage", () => {
  /** Worker A holds attempt 1; its lease expires; Worker B takes attempt 2. */
  async function overtaken() {
    const id = await profile(`fence-${(sequence += 1)}`);
    const workerA = await seededClaim(id, "worker-a");
    expect(workerA.attempt).toBe(1);

    await expireLease(workerA.windowId);
    const workerB = await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-b" });
    expect(workerB!.attempt).toBe(2);

    return { id, workerA, workerB: workerB! };
  }

  maybe()("P/Q. the reclaim advances the generation", async () => {
    const { workerA, workerB } = await overtaken();

    expect(workerB.windowId).toBe(workerA.windowId);
    expect(workerB.attempt).toBe(workerA.attempt + 1);
    expect((await rowOf(workerA.windowId)).claimOwner).toBe("worker-b");
  });

  maybe()("R. the stale worker cannot COMPLETE", async () => {
    const { workerA } = await overtaken();

    await expect(work.markComplete(prisma!, workerA)).rejects.toBeInstanceOf(StaleFillIngestClaimError);

    const row = await rowOf(workerA.windowId);
    expect(row.status).toBe("PENDING");
    expect(row.claimOwner).toBe("worker-b");
  });

  maybe()("S. the stale worker cannot SPLIT", async () => {
    const { workerA } = await overtaken();
    const mid = workerA.startTimeMs + Math.floor((workerA.endTimeMs - workerA.startTimeMs) / 2);

    await expect(
      work.splitWindow(workerA, {
        left: { startTimeMs: workerA.startTimeMs, endTimeMs: mid },
        right: { startTimeMs: mid + 1, endTimeMs: workerA.endTimeMs },
      })
    ).rejects.toBeInstanceOf(StaleFillIngestClaimError);

    expect((await rowOf(workerA.windowId)).status).toBe("PENDING");
    // And no child was left behind by the rolled-back attempt.
    expect(await prisma!.exchangeFillIngestWindow.count({ where: { parentId: workerA.windowId } })).toBe(0);
  });

  maybe()("T. the stale worker cannot record a retry failure", async () => {
    const { workerA } = await overtaken();

    await expect(
      work.recordRetryableFailure(prisma!, workerA, { reasonCode: "HTTP_5XX" })
    ).rejects.toBeInstanceOf(StaleFillIngestClaimError);

    const row = await rowOf(workerA.windowId);
    // Worker B's lease is intact and no error was attributed to it.
    expect(row.claimOwner).toBe("worker-b");
    expect(row.claimedAt).not.toBeNull();
    expect(row.lastErrorCode).toBeNull();
  });

  maybe()("the stale worker cannot mark a known gap either", async () => {
    const { workerA } = await overtaken();

    await expect(work.markIncompleteSkippedRows(prisma!, workerA)).rejects.toBeInstanceOf(
      StaleFillIngestClaimError
    );
    await expect(work.markSaturatedSingleMillisecond(prisma!, workerA)).rejects.toBeInstanceOf(
      StaleFillIngestClaimError
    );

    expect((await rowOf(workerA.windowId)).status).toBe("PENDING");
  });

  maybe()("U. the CURRENT claimant may transition", async () => {
    const { workerB } = await overtaken();

    await work.markComplete(prisma!, workerB);

    const row = await rowOf(workerB.windowId);
    expect(row.status).toBe("COMPLETE");
    expect(row.attempts).toBe(2);
  });

  maybe()("the ATTEMPT NUMBER is the fence, even when the owner is unchanged", async () => {
    // Isolates the token. A worker identity is stable across a restart or a
    // reconnect, so the SAME id can legitimately hold a later attempt on the
    // same row -- and then the owner column distinguishes nothing. Only the
    // generation does, which is why it is what every mutation must present.
    const id = await profile("fence-same-owner");
    const first = await seededClaim(id, "worker-a");
    await expireLease(first.windowId);
    const second = await work.claimNextWindow(prisma!, {
      executionProfileId: id,
      workerId: "worker-a",
    });

    expect(second!.claimOwner).toBe(first.claimOwner);
    expect(second!.attempt).toBe(first.attempt + 1);

    for (const attempt of [
      () => work.markComplete(prisma!, first),
      () => work.markIncompleteSkippedRows(prisma!, first),
      () => work.markSaturatedSingleMillisecond(prisma!, first),
      () => work.recordRetryableFailure(prisma!, first, { reasonCode: "HTTP_5XX" }),
      () =>
        work.splitWindow(first, canonicalHalves(first)),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(StaleFillIngestClaimError);
    }

    const row = await rowOf(first.windowId);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(2);
    expect(row.claimedAt).not.toBeNull();
    expect(row.lastErrorCode).toBeNull();
    // And the live generation still works.
    await work.markComplete(prisma!, second!);
    expect((await rowOf(first.windowId)).status).toBe("COMPLETE");
  });

  maybe()("a forged attempt number is refused in both directions", async () => {
    const id = await profile("fence-forged");
    const claim = await seededClaim(id, "worker-a");

    await expect(work.markComplete(prisma!, { ...claim, attempt: 0 })).rejects.toBeInstanceOf(
      StaleFillIngestClaimError
    );
    await expect(work.markComplete(prisma!, { ...claim, attempt: 99 })).rejects.toBeInstanceOf(
      StaleFillIngestClaimError
    );
    await expect(
      work.markComplete(prisma!, { ...claim, claimOwner: "somebody-else" })
    ).rejects.toBeInstanceOf(StaleFillIngestClaimError);

    expect((await rowOf(claim.windowId)).status).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// Retry, abandonment, and the attempt that never came back
// ---------------------------------------------------------------------------

describe("retryable failure and the attempt budget", () => {
  maybe()("V. below the budget the row stays PENDING with its lease released", async () => {
    const id = await profile("retry-below");
    const claim = await seededClaim(id, "worker-a");
    const due = new Date(Date.now() + 30_000);

    const outcome = await work.recordRetryableFailure(prisma!, claim, {
      reasonCode: "RATE_LIMITED",
      sanitizedError: "429 from the exchange",
      nextEligibleAt: due,
    });

    expect(outcome).toBe("PENDING");
    const row = await rowOf(claim.windowId);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);
    expect(row.claimedAt).toBeNull();
    expect(row.claimOwner).toBeNull();
    expect(row.lastErrorCode).toBe("RATE_LIMITED");
    expect(row.sanitizedLastError).toBe("429 from the exchange");
    expect(row.nextEligibleAt!.getTime()).toBe(due.getTime());
  });

  maybe()("a released row is claimable again once its backoff is due", async () => {
    const id = await profile("retry-reclaim");
    const claim = await seededClaim(id, "worker-a");
    await work.recordRetryableFailure(prisma!, claim, {
      reasonCode: "HTTP_5XX",
      nextEligibleAt: new Date(Date.now() - 1_000),
    });

    const again = await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-b" });

    expect(again).not.toBeNull();
    expect(again!.attempt).toBe(2);
  });

  maybe()("W. failing ON the last attempt abandons immediately", async () => {
    const id = await profile("retry-exhaust");
    const claim = await seededClaim(id, "worker-a");
    await prisma!.exchangeFillIngestWindow.update({
      where: { id: claim.windowId },
      data: { attempts: MAX_INGEST_ATTEMPTS },
    });

    const outcome = await work.recordRetryableFailure(
      prisma!,
      { ...claim, attempt: MAX_INGEST_ATTEMPTS },
      { reasonCode: "HTTP_5XX", sanitizedError: "still failing" }
    );

    expect(outcome).toBe("ABANDONED");
    const row = await rowOf(claim.windowId);
    expect(row.status).toBe("ABANDONED");
    expect(row.claimedAt).toBeNull();
    expect(row.claimOwner).toBeNull();
    expect(row.nextEligibleAt).toBeNull();
    expect(row.lastErrorCode).toBe(FILL_INGEST_REASON.ATTEMPT_BUDGET_EXHAUSTED);
  });
});

describe("the attempt that never came back", () => {
  /** Claims until the row sits at MAX with a live lease, then walks away. */
  async function crashedOnLastAttempt(alias: string) {
    const id = await profile(alias);
    const claim = await seededClaim(id, "worker-a");
    await prisma!.exchangeFillIngestWindow.update({
      where: { id: claim.windowId },
      data: { attempts: MAX_INGEST_ATTEMPTS },
    });
    return { id, claim: { ...claim, attempt: MAX_INGEST_ATTEMPTS } };
  }

  maybe()("X. immediately after the crash the row is still a LEASED PENDING row", async () => {
    const { id, claim } = await crashedOnLastAttempt("zombie-fresh");

    const row = await rowOf(claim.windowId);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(MAX_INGEST_ATTEMPTS);
    expect(row.claimedAt).not.toBeNull();
    // Unreachable by the claim query, because the budget is spent.
    expect(await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "w" })).toBeNull();
  });

  maybe()("Z. the finalizer will not touch a LIVE last-attempt lease", async () => {
    // That worker still has its whole lease to come back and report.
    const { id, claim } = await crashedOnLastAttempt("zombie-live");

    expect(await work.finalizeStaleExhausted(prisma!, { executionProfileId: id })).toEqual([]);

    expect((await rowOf(claim.windowId)).status).toBe("PENDING");
  });

  maybe()("Y. once the lease is stale the finalizer abandons it, with no request", async () => {
    const { id, claim } = await crashedOnLastAttempt("zombie-stale");
    await expireLease(claim.windowId);

    const finalized = await work.finalizeStaleExhausted(prisma!, { executionProfileId: id });

    expect(finalized).toEqual([claim.windowId]);
    const row = await rowOf(claim.windowId);
    expect(row.status).toBe("ABANDONED");
    expect(row.claimedAt).toBeNull();
    expect(row.claimOwner).toBeNull();
    expect(row.nextEligibleAt).toBeNull();
    expect(row.lastErrorCode).toBe(FILL_INGEST_REASON.ATTEMPT_BUDGET_EXHAUSTED_AFTER_STALE_LEASE);
  });

  maybe()("AA. no PENDING row at the budget ceiling survives a finalizer pass", async () => {
    // The zombie proof. Every way a row can reach MAX and stay PENDING is
    // enumerated here, and none of them is still PENDING afterwards.
    const id = await profile("zombie-none-remain");
    const made: string[] = [];
    for (const owner of ["crash-1", "crash-2", "crash-3"]) {
      const claim = await seededClaim(id, owner);
      await prisma!.exchangeFillIngestWindow.update({
        where: { id: claim.windowId },
        data: { attempts: MAX_INGEST_ATTEMPTS },
      });
      await expireLease(claim.windowId);
      made.push(claim.windowId);
    }
    // Plus the state this machine cannot produce, covered defensively: at the
    // ceiling with no lease at all.
    const orphan = await seededClaim(id, "orphan");
    await prisma!.exchangeFillIngestWindow.update({
      where: { id: orphan.windowId },
      data: { attempts: MAX_INGEST_ATTEMPTS, claimedAt: null, claimOwner: null },
    });
    made.push(orphan.windowId);

    const finalized = await work.finalizeStaleExhausted(prisma!, { executionProfileId: id });

    expect(finalized.sort()).toEqual(made.sort());
    const stillPending = await prisma!.exchangeFillIngestWindow.count({
      where: { executionProfileId: id, status: "PENDING", attempts: { gte: MAX_INGEST_ATTEMPTS } },
    });
    expect(stillPending).toBe(0);
  });

  maybe()("the finalizer is idempotent and leaves ordinary work alone", async () => {
    const id = await profile("zombie-idempotent");
    const { claim } = await crashedOnLastAttempt("zombie-idempotent-row");
    await expireLease(claim.windowId);
    const healthy = await work.seedWindow(prisma!, {
      executionProfileId: id, symbol: SYMBOL, ...interval(),
    });

    await work.finalizeStaleExhausted(prisma!, { executionProfileId: id });
    const second = await work.finalizeStaleExhausted(prisma!, { executionProfileId: id });

    expect(second).toEqual([]);
    expect((await rowOf(healthy.id)).status).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// COMPLETE
// ---------------------------------------------------------------------------

describe("the COMPLETE transition", () => {
  maybe()("AB/AC. the active claimant completes, and the row is left settled", async () => {
    const id = await profile("complete-basic");
    const claim = await seededClaim(id, "worker-a");
    // A previous attempt's transient failure is still on the row.
    await prisma!.exchangeFillIngestWindow.update({
      where: { id: claim.windowId },
      data: { lastErrorCode: "HTTP_5XX", sanitizedLastError: "earlier blip", nextEligibleAt: new Date() },
    });

    await work.markComplete(prisma!, claim);

    const row = await rowOf(claim.windowId);
    expect(row.status).toBe("COMPLETE");
    expect(row.claimedAt).toBeNull();
    expect(row.claimOwner).toBeNull();
    expect(row.nextEligibleAt).toBeNull();
    // A window that succeeded on its third try must not read as an error.
    expect(row.lastErrorCode).toBeNull();
    expect(row.sanitizedLastError).toBeNull();
  });

  maybe()("AD. a stale claimant cannot complete", async () => {
    const id = await profile("complete-stale");
    const claim = await seededClaim(id, "worker-a");
    await expireLease(claim.windowId);
    await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-b" });

    await expect(work.markComplete(prisma!, claim)).rejects.toBeInstanceOf(StaleFillIngestClaimError);
    expect((await rowOf(claim.windowId)).status).toBe("PENDING");
  });

  maybe()("AE. COMPLETE cannot transition again", async () => {
    const id = await profile("complete-immutable");
    const claim = await seededClaim(id, "worker-a");
    await work.markComplete(prisma!, claim);

    for (const attempt of [
      () => work.markComplete(prisma!, claim),
      () => work.markIncompleteSkippedRows(prisma!, claim),
      () => work.markSaturatedSingleMillisecond(prisma!, claim),
      () => work.recordRetryableFailure(prisma!, claim, { reasonCode: "HTTP_5XX" }),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(StaleFillIngestClaimError);
    }
    expect((await rowOf(claim.windowId)).status).toBe("COMPLETE");
  });

  maybe()("AF. the completion rolls back with the caller's transaction", async () => {
    // The property this whole slice exists for: the future executor writes the
    // page's fills and this transition in ONE transaction, so a failure after
    // it must not leave an interval marked proven.
    const id = await profile("complete-rollback");
    const claim = await seededClaim(id, "worker-a");

    await expect(
      prisma!.$transaction(async (tx) => {
        await work.markComplete(tx, claim);
        throw new Error("the caller's own work failed after the transition");
      })
    ).rejects.toThrow(/the caller's own work failed/);

    const row = await rowOf(claim.windowId);
    expect(row.status).toBe("PENDING");
    expect(row.claimOwner).toBe("worker-a");
  });

  maybe()("and commits with it when the caller succeeds", async () => {
    const id = await profile("complete-commit");
    const claim = await seededClaim(id, "worker-a");

    await prisma!.$transaction(async (tx) => {
      await work.markComplete(tx, claim);
    });

    expect((await rowOf(claim.windowId)).status).toBe("COMPLETE");
  });
});

// ---------------------------------------------------------------------------
// SPLIT — atomic, or not at all
// ---------------------------------------------------------------------------

describe("the SPLIT transition", () => {
  /** The planner's own bisection, computed the same way it does. */
  const halves = (claim: { startTimeMs: number; endTimeMs: number }) => {
    const mid = claim.startTimeMs + Math.floor((claim.endTimeMs - claim.startTimeMs) / 2);
    return {
      left: { startTimeMs: claim.startTimeMs, endTimeMs: mid },
      right: { startTimeMs: mid + 1, endTimeMs: claim.endTimeMs },
    };
  };

  maybe()("AG/AH/AI/AJ/AK/AL. one atomic split leaves a terminal parent and two ready children", async () => {
    const id = await profile("split-basic");
    const claim = await seededClaim(id, "worker-a");
    const children = halves(claim);

    const { leftId, rightId } = await work.splitWindow(claim, children);

    const parent = await rowOf(claim.windowId);
    expect(parent.status).toBe("SPLIT");
    expect(parent.claimedAt).toBeNull();
    expect(parent.claimOwner).toBeNull();
    expect(parent.lastErrorCode).toBeNull();

    const kids = await prisma!.exchangeFillIngestWindow.findMany({
      where: { parentId: claim.windowId },
      orderBy: { startTimeMs: "asc" },
    });
    expect(kids).toHaveLength(2);
    expect(kids.map((row) => row.id)).toEqual([leftId, rightId]);
    for (const kid of kids) {
      expect(kid.status).toBe("PENDING");
      expect(kid.attempts).toBe(0);
      expect(kid.claimedAt).toBeNull();
      expect(kid.claimOwner).toBeNull();
      // Inherited from the parent, never taken from the caller.
      expect(kid.executionProfileId).toBe(id);
      expect(kid.symbol).toBe(SYMBOL);
    }
    // They tile the parent exactly: same edges, abutting, nothing shared or lost.
    expect(Number(kids[0].startTimeMs)).toBe(claim.startTimeMs);
    expect(Number(kids[1].endTimeMs)).toBe(claim.endTimeMs);
    expect(Number(kids[1].startTimeMs)).toBe(Number(kids[0].endTimeMs) + 1);
  });

  maybe()("a child is ordinary work, claimable in its own right", async () => {
    const id = await profile("split-child-claimable");
    const claim = await seededClaim(id, "worker-a");
    await work.splitWindow(claim, halves(claim));

    const childClaim = await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-b" });

    expect(childClaim).not.toBeNull();
    expect(childClaim!.windowId).not.toBe(claim.windowId);
    expect(childClaim!.attempt).toBe(1);
  });

  maybe()("AM. replaying the identical split converges rather than duplicating", async () => {
    // A rolled-back split is re-derived from pure arithmetic, so the children
    // come back byte-identical and the unique key absorbs them.
    const id = await profile("split-replay");
    const claim = await seededClaim(id, "worker-a");
    const children = halves(claim);
    await prisma!.exchangeFillIngestWindow.createMany({
      data: [children.left, children.right].map((bounds) => ({
        executionProfileId: id, symbol: SYMBOL, parentId: claim.windowId,
        startTimeMs: BigInt(bounds.startTimeMs), endTimeMs: BigInt(bounds.endTimeMs),
      })),
    });

    const { leftId, rightId } = await work.splitWindow(claim, children);

    expect((await rowOf(claim.windowId)).status).toBe("SPLIT");
    const kids = await prisma!.exchangeFillIngestWindow.findMany({ where: { parentId: claim.windowId } });
    expect(kids).toHaveLength(2);
    expect(kids.map((row) => row.id).sort()).toEqual([leftId, rightId].sort());
  });

  maybe()("AN. a failure after the children are written commits nothing", async () => {
    const id = await profile("split-rollback");
    const claim = await seededClaim(id, "worker-a");
    const children = halves(claim);

    await expect(
      prisma!.$transaction(async (tx) => {
        await work.splitWindowInTransaction(tx, claim, children);
        throw new Error("the caller failed after the split");
      })
    ).rejects.toThrow(/the caller failed after the split/);

    // No half-split: no child, and the parent is still claimable work.
    expect(await prisma!.exchangeFillIngestWindow.count({ where: { parentId: claim.windowId } })).toBe(0);
    const parent = await rowOf(claim.windowId);
    expect(parent.status).toBe("PENDING");
    expect(parent.claimOwner).toBe("worker-a");
  });

  maybe()("AO. a stale claimant cannot split, and leaves no child behind", async () => {
    const id = await profile("split-stale");
    const claim = await seededClaim(id, "worker-a");
    await expireLease(claim.windowId);
    await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-b" });

    await expect(work.splitWindow(claim, halves(claim))).rejects.toBeInstanceOf(
      StaleFillIngestClaimError
    );

    expect(await prisma!.exchangeFillIngestWindow.count({ where: { parentId: claim.windowId } })).toBe(0);
    expect((await rowOf(claim.windowId)).status).toBe("PENDING");
  });

  maybe()("AP. a child already owned by a DIFFERENT parent is refused explicitly", async () => {
    // skipDuplicates must never become a way to adopt somebody else's tree.
    const id = await profile("split-lineage");
    const claim = await seededClaim(id, "worker-a");
    const children = halves(claim);
    const impostor = await work.seedWindow(prisma!, {
      executionProfileId: id, symbol: SYMBOL, ...interval(),
    });
    await prisma!.exchangeFillIngestWindow.create({
      data: {
        executionProfileId: id, symbol: SYMBOL, parentId: impostor.id,
        startTimeMs: BigInt(children.left.startTimeMs),
        endTimeMs: BigInt(children.left.endTimeMs),
      },
    });

    await expect(work.splitWindow(claim, children)).rejects.toBeInstanceOf(FillIngestChildLineageError);

    expect((await rowOf(claim.windowId)).status).toBe("PENDING");
    // And the right-hand child the split would have created was rolled back.
    const rightExists = await prisma!.exchangeFillIngestWindow.count({
      where: {
        executionProfileId: id, symbol: SYMBOL,
        startTimeMs: BigInt(children.right.startTimeMs),
        endTimeMs: BigInt(children.right.endTimeMs),
      },
    });
    expect(rightExists).toBe(0);
  });

  maybe()("children that do not tile the parent are refused", async () => {
    const id = await profile("split-tiling");
    const claim = await seededClaim(id, "worker-a");
    const { left, right } = halves(claim);

    const bad = [
      { left: { ...left, startTimeMs: left.startTimeMs + 1 }, right },
      { left, right: { ...right, endTimeMs: right.endTimeMs - 1 } },
      { left, right: { ...right, startTimeMs: left.endTimeMs } },
      { left, right: { ...right, startTimeMs: left.endTimeMs + 2 } },
    ];
    for (const children of bad) {
      await expect(work.splitWindow(claim, children)).rejects.toBeInstanceOf(
        FillIngestWindowRefusedError
      );
    }

    expect(await prisma!.exchangeFillIngestWindow.count({ where: { parentId: claim.windowId } })).toBe(0);
  });

  maybe()("a SPLIT parent is terminal and is retained as lineage", async () => {
    const id = await profile("split-parent-terminal");
    const claim = await seededClaim(id, "worker-a");
    await work.splitWindow(claim, halves(claim));

    await expect(work.markComplete(prisma!, claim)).rejects.toBeInstanceOf(StaleFillIngestClaimError);
    const parent = await rowOf(claim.windowId);
    expect(parent.status).toBe("SPLIT");
    expect(await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "w" })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Known coverage gaps
// ---------------------------------------------------------------------------

describe("terminal known gaps", () => {
  const gaps = [
    {
      label: "AQ. INCOMPLETE_SKIPPED_ROWS",
      status: "INCOMPLETE_SKIPPED_ROWS" as const,
      reason: FILL_INGEST_REASON.LEDGER_ROW_NOT_REPRESENTABLE,
      mark: (claim: Parameters<WindowService["markComplete"]>[1]) =>
        work.markIncompleteSkippedRows(prisma!, claim, "1 row unusable"),
    },
    {
      label: "AR. SATURATED_SINGLE_MILLISECOND",
      status: "SATURATED_SINGLE_MILLISECOND" as const,
      reason: FILL_INGEST_REASON.SATURATED_SINGLE_MILLISECOND,
      mark: (claim: Parameters<WindowService["markComplete"]>[1]) =>
        work.markSaturatedSingleMillisecond(prisma!, claim, "1000 rows in one ms"),
    },
  ];

  for (const gap of gaps) {
    maybe()(`${gap.label} is terminal, settled and self-explaining`, async () => {
      const id = await profile(`gap-${gap.status}`);
      const claim = await seededClaim(id, "worker-a");
      // AT: a stale transient failure is sitting on the row.
      await prisma!.exchangeFillIngestWindow.update({
        where: { id: claim.windowId },
        data: { lastErrorCode: "HTTP_5XX", sanitizedLastError: "earlier blip", nextEligibleAt: new Date() },
      });

      await gap.mark(claim);

      const row = await rowOf(claim.windowId);
      expect(row.status).toBe(gap.status);
      // AS: the lease and the backoff are cleared.
      expect(row.claimedAt).toBeNull();
      expect(row.claimOwner).toBeNull();
      expect(row.nextEligibleAt).toBeNull();
      // AT: the transient reason is REPLACED by the terminal one.
      expect(row.lastErrorCode).toBe(gap.reason);
      expect(row.sanitizedLastError).not.toBe("earlier blip");
      // AU: no children.
      expect(await prisma!.exchangeFillIngestWindow.count({ where: { parentId: claim.windowId } })).toBe(0);
      // AV: and it can never become COMPLETE.
      await expect(work.markComplete(prisma!, claim)).rejects.toBeInstanceOf(StaleFillIngestClaimError);
      expect((await rowOf(claim.windowId)).status).toBe(gap.status);
    });
  }

  maybe()("a known gap is never claimed again", async () => {
    const id = await profile("gap-not-claimable");
    const claim = await seededClaim(id, "worker-a");
    await work.markIncompleteSkippedRows(prisma!, claim);

    expect(await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "w" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Terminal immutability, exhaustively
// ---------------------------------------------------------------------------

describe("no terminal status regresses", () => {
  const terminals = [
    { status: "COMPLETE", reach: (c: any) => work.markComplete(prisma!, c) },
    { status: "INCOMPLETE_SKIPPED_ROWS", reach: (c: any) => work.markIncompleteSkippedRows(prisma!, c) },
    { status: "SATURATED_SINGLE_MILLISECOND", reach: (c: any) => work.markSaturatedSingleMillisecond(prisma!, c) },
  ];

  for (const terminal of terminals) {
    maybe()(`${terminal.status} refuses every further transition`, async () => {
      const id = await profile(`immutable-${terminal.status}`);
      const claim = await seededClaim(id, "worker-a");
      await terminal.reach(claim);

      const attempts = [
        () => work.markComplete(prisma!, claim),
        () => work.markIncompleteSkippedRows(prisma!, claim),
        () => work.markSaturatedSingleMillisecond(prisma!, claim),
        () => work.recordRetryableFailure(prisma!, claim, { reasonCode: "HTTP_5XX" }),
        () =>
          work.splitWindow(claim, canonicalHalves(claim)),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toBeInstanceOf(StaleFillIngestClaimError);
      }

      expect((await rowOf(claim.windowId)).status).toBe(terminal.status);
      expect(await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "w" })).toBeNull();
    });
  }

  maybe()("a terminal row is refused even if it still carries a matching claim", async () => {
    // Isolates the STATUS guard. In ordinary operation every terminal
    // transition clears the lease, so the owner column alone would already
    // refuse a later write -- which means the status check is never the thing
    // being tested. Here the row is forced into a state a manual edit or a
    // future bug could produce: terminal, but still holding the exact claim the
    // worker presents. Only "you may transition a PENDING row" can refuse it.
    const id = await profile("immutable-status-guard");
    const claim = await seededClaim(id, "worker-a");
    await work.markComplete(prisma!, claim);
    await prisma!.exchangeFillIngestWindow.update({
      where: { id: claim.windowId },
      data: { claimedAt: new Date(), claimOwner: claim.claimOwner },
    });

    const row = await rowOf(claim.windowId);
    expect(row.status).toBe("COMPLETE");
    expect(row.attempts).toBe(claim.attempt);
    expect(row.claimOwner).toBe(claim.claimOwner);

    for (const attempt of [
      () => work.markComplete(prisma!, claim),
      () => work.markIncompleteSkippedRows(prisma!, claim),
      () => work.markSaturatedSingleMillisecond(prisma!, claim),
      () => work.recordRetryableFailure(prisma!, claim, { reasonCode: "HTTP_5XX" }),
      () =>
        work.splitWindow(claim, canonicalHalves(claim)),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(StaleFillIngestClaimError);
    }

    expect((await rowOf(claim.windowId)).status).toBe("COMPLETE");
    expect(await prisma!.exchangeFillIngestWindow.count({ where: { parentId: claim.windowId } })).toBe(0);
  });

  maybe()("ABANDONED does not return to PENDING by itself", async () => {
    const id = await profile("immutable-abandoned");
    const claim = await seededClaim(id, "worker-a");
    await prisma!.exchangeFillIngestWindow.update({
      where: { id: claim.windowId },
      data: { attempts: MAX_INGEST_ATTEMPTS },
    });
    await work.recordRetryableFailure(
      prisma!,
      { ...claim, attempt: MAX_INGEST_ATTEMPTS },
      { reasonCode: "HTTP_5XX" }
    );
    expect((await rowOf(claim.windowId)).status).toBe("ABANDONED");

    await expect(
      work.recordRetryableFailure(prisma!, { ...claim, attempt: MAX_INGEST_ATTEMPTS }, { reasonCode: "X" })
    ).rejects.toBeInstanceOf(StaleFillIngestClaimError);
    await expect(work.markComplete(prisma!, claim)).rejects.toBeInstanceOf(StaleFillIngestClaimError);
    expect(await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "w" })).toBeNull();
    expect(await work.finalizeStaleExhausted(prisma!, { executionProfileId: id })).toEqual([]);

    expect((await rowOf(claim.windowId)).status).toBe("ABANDONED");
  });

  maybe()("a SPLIT parent refuses every further transition too", async () => {
    const id = await profile("immutable-split");
    const claim = await seededClaim(id, "worker-a");
    const mid = claim.startTimeMs + Math.floor((claim.endTimeMs - claim.startTimeMs) / 2);
    await work.splitWindow(claim, {
      left: { startTimeMs: claim.startTimeMs, endTimeMs: mid },
      right: { startTimeMs: mid + 1, endTimeMs: claim.endTimeMs },
    });

    await expect(work.markComplete(prisma!, claim)).rejects.toBeInstanceOf(StaleFillIngestClaimError);
    await expect(
      work.recordRetryableFailure(prisma!, claim, { reasonCode: "HTTP_5XX" })
    ).rejects.toBeInstanceOf(StaleFillIngestClaimError);

    expect((await rowOf(claim.windowId)).status).toBe("SPLIT");
  });
});

// ---------------------------------------------------------------------------
// Only the CANONICAL split is a split
// ---------------------------------------------------------------------------

describe("split children must be the planner's canonical halves", () => {
  /** A parent with exact bounds, claimed and ready to split. */
  async function parentOf(alias: string, startTimeMs: number, endTimeMs: number) {
    const id = await profile(`canonical-${alias}`);
    await work.seedWindow(prisma!, { executionProfileId: id, symbol: SYMBOL, startTimeMs, endTimeMs });
    const claim = await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-a" });
    return { id, claim: claim! };
  }

  const canonical = (startTimeMs: number, endTimeMs: number) => {
    const mid = startTimeMs + Math.floor((endTimeMs - startTimeMs) / 2);
    return {
      left: { startTimeMs, endTimeMs: mid },
      right: { startTimeMs: mid + 1, endTimeMs },
    };
  };

  maybe()("A. the canonical halves of [0,100] are accepted", async () => {
    const { id, claim } = await parentOf("accept-100", 0, 100);

    await work.splitWindow(claim, {
      left: { startTimeMs: 0, endTimeMs: 50 },
      right: { startTimeMs: 51, endTimeMs: 100 },
    });

    expect((await rowOf(claim.windowId)).status).toBe("SPLIT");
    const kids = await prisma!.exchangeFillIngestWindow.findMany({
      where: { parentId: claim.windowId },
      orderBy: { startTimeMs: "asc" },
    });
    expect(kids.map((k) => [Number(k.startTimeMs), Number(k.endTimeMs)])).toEqual([[0, 50], [51, 100]]);
    expect(await windowsFor(id)).toHaveLength(3);
  });

  maybe()("B/C/G. a NON-CANONICAL exact tiling is refused, and nothing is written", async () => {
    // Every one of these is a perfectly gapless partition of [0,100]. None of
    // them is the split, because the split has to be deterministic: a
    // re-derived child must come back byte-identical, and two workers
    // bisecting one parent must not produce two different subdivisions.
    const nonCanonical = [
      { label: "B. [0,25] + [26,100]", left: { startTimeMs: 0, endTimeMs: 25 }, right: { startTimeMs: 26, endTimeMs: 100 } },
      { label: "C. [0,0] + [1,100]", left: { startTimeMs: 0, endTimeMs: 0 }, right: { startTimeMs: 1, endTimeMs: 100 } },
      { label: "[0,99] + [100,100]", left: { startTimeMs: 0, endTimeMs: 99 }, right: { startTimeMs: 100, endTimeMs: 100 } },
      { label: "[0,49] + [50,100]", left: { startTimeMs: 0, endTimeMs: 49 }, right: { startTimeMs: 50, endTimeMs: 100 } },
      { label: "[0,51] + [52,100]", left: { startTimeMs: 0, endTimeMs: 51 }, right: { startTimeMs: 52, endTimeMs: 100 } },
    ];

    for (const attempt of nonCanonical) {
      const { claim } = await parentOf(`refuse-${attempt.label.replace(/\W+/g, "")}`, 0, 100);

      await expect(
        work.splitWindow(claim, { left: attempt.left, right: attempt.right })
      ).rejects.toBeInstanceOf(FillIngestWindowRefusedError);

      // G: the parent is still claimable work and no child was committed.
      const parent = await rowOf(claim.windowId);
      expect(parent.status).toBe("PENDING");
      expect(parent.claimOwner).toBe("worker-a");
      expect(
        await prisma!.exchangeFillIngestWindow.count({ where: { parentId: claim.windowId } })
      ).toBe(0);
    }
  });

  maybe()("D/E. the halves of a two- and a three-millisecond parent", async () => {
    const two = await parentOf("two-ms", 10, 11);
    await work.splitWindow(two.claim, {
      left: { startTimeMs: 10, endTimeMs: 10 },
      right: { startTimeMs: 11, endTimeMs: 11 },
    });
    expect((await rowOf(two.claim.windowId)).status).toBe("SPLIT");

    const three = await parentOf("three-ms", 10, 12);
    await work.splitWindow(three.claim, {
      left: { startTimeMs: 10, endTimeMs: 11 },
      right: { startTimeMs: 12, endTimeMs: 12 },
    });
    expect((await rowOf(three.claim.windowId)).status).toBe("SPLIT");
    const kids = await prisma!.exchangeFillIngestWindow.findMany({
      where: { parentId: three.claim.windowId },
      orderBy: { startTimeMs: "asc" },
    });
    // The extra millisecond goes LEFT, exactly as floor division puts it.
    expect(kids.map((k) => [Number(k.startTimeMs), Number(k.endTimeMs)])).toEqual([[10, 11], [12, 12]]);
  });

  maybe()("D2. the other three-millisecond partition is refused", async () => {
    const { claim } = await parentOf("three-ms-wrong", 10, 12);

    await expect(
      work.splitWindow(claim, {
        left: { startTimeMs: 10, endTimeMs: 10 },
        right: { startTimeMs: 11, endTimeMs: 12 },
      })
    ).rejects.toBeInstanceOf(FillIngestWindowRefusedError);

    expect((await rowOf(claim.windowId)).status).toBe("PENDING");
  });

  maybe()("F. a single-millisecond parent can never be split", async () => {
    // The planner answers SATURATED_SINGLE_MILLISECOND here; this is the
    // repository refusing to be talked into an empty or duplicated child by a
    // caller that got it wrong.
    const { claim } = await parentOf("single-ms", 10, 10);

    for (const children of [
      { left: { startTimeMs: 10, endTimeMs: 10 }, right: { startTimeMs: 10, endTimeMs: 10 } },
      { left: { startTimeMs: 10, endTimeMs: 10 }, right: { startTimeMs: 11, endTimeMs: 11 } },
      { left: { startTimeMs: 10, endTimeMs: 9 }, right: { startTimeMs: 10, endTimeMs: 10 } },
    ]) {
      await expect(work.splitWindow(claim, children)).rejects.toBeInstanceOf(
        FillIngestWindowRefusedError
      );
    }

    expect((await rowOf(claim.windowId)).status).toBe("PENDING");
    expect(await prisma!.exchangeFillIngestWindow.count({ where: { parentId: claim.windowId } })).toBe(0);
    // The right answer for this window is the known gap, and it still works.
    await work.markSaturatedSingleMillisecond(prisma!, claim);
    expect((await rowOf(claim.windowId)).status).toBe("SATURATED_SINGLE_MILLISECOND");
  });
});

describe("H. the service's canonical split is the planner's canonical split", () => {
  /** The planner's own answer for a saturated observation of one window. */
  function plannerHalves(startTimeMs: number, endTimeMs: number) {
    const decision = planUserTradesWindow({
      window: { startTimeMs, endTimeMs },
      limit: 1000,
      // A full page: the only observation that produces SPLIT.
      returnedRowCount: 1000,
    });
    if (decision.kind !== "SPLIT") throw new Error(`expected SPLIT, got ${decision.kind}`);
    return { left: decision.left, right: decision.right };
  }

  const representative: Array<[number, number]> = [
    [0, 1],
    [0, 2],
    [0, 100],
    [10, 11],
    [10, 12],
    [1, 1_000_000],
    [1_757_000_000_000, 1_757_000_000_001],
    [1_757_000_000_000, 1_757_086_399_999],
    [0, USER_TRADES_MAX_WINDOW_MS],
  ];

  maybe()("the repository accepts exactly what the planner produces", async () => {
    // The midpoint is duplicated inside the work-state service rather than
    // exported from the planner, whose splitter stays private. This is what
    // makes the duplication visible if either side ever drifts.
    for (const [startTimeMs, endTimeMs] of representative) {
      const id = await profile(`planner-tie-${startTimeMs}-${endTimeMs}`);
      await work.seedWindow(prisma!, { executionProfileId: id, symbol: SYMBOL, startTimeMs, endTimeMs });
      const claim = await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "w" });

      const halves = plannerHalves(startTimeMs, endTimeMs);
      await work.splitWindow(claim!, halves);

      const kids = await prisma!.exchangeFillIngestWindow.findMany({
        where: { parentId: claim!.windowId },
        orderBy: { startTimeMs: "asc" },
      });
      expect(kids.map((k) => [Number(k.startTimeMs), Number(k.endTimeMs)])).toEqual([
        [halves.left.startTimeMs, halves.left.endTimeMs],
        [halves.right.startTimeMs, halves.right.endTimeMs],
      ]);
      expect((await rowOf(claim!.windowId)).status).toBe("SPLIT");
    }
  });

  maybe()("and refuses anything one millisecond off the planner's answer", async () => {
    // Both directions, so a midpoint that drifts either way is caught.
    for (const [startTimeMs, endTimeMs] of representative.filter(([s, e]) => e - s >= 3)) {
      const halves = plannerHalves(startTimeMs, endTimeMs);
      const drifted = [
        {
          left: { ...halves.left, endTimeMs: halves.left.endTimeMs - 1 },
          right: { ...halves.right, startTimeMs: halves.right.startTimeMs - 1 },
        },
        {
          left: { ...halves.left, endTimeMs: halves.left.endTimeMs + 1 },
          right: { ...halves.right, startTimeMs: halves.right.startTimeMs + 1 },
        },
      ];

      for (const children of drifted) {
        const id = await profile(`planner-drift-${(sequence += 1)}`);
        await work.seedWindow(prisma!, { executionProfileId: id, symbol: SYMBOL, startTimeMs, endTimeMs });
        const claim = await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "w" });

        await expect(work.splitWindow(claim!, children)).rejects.toBeInstanceOf(
          FillIngestWindowRefusedError
        );
        expect((await rowOf(claim!.windowId)).status).toBe("PENDING");
      }
    }
  });

  maybe()("a single-millisecond window is SATURATED to the planner, never SPLIT", async () => {
    // The two modules agree about where splitting stops, which is what makes
    // the repository's refusal of a single-ms parent a backstop rather than a
    // disagreement.
    const decision = planUserTradesWindow({
      window: { startTimeMs: 10, endTimeMs: 10 },
      limit: 1000,
      returnedRowCount: 1000,
    });
    expect(decision.kind).toBe("SATURATED_SINGLE_MILLISECOND");
  });
});

// ---------------------------------------------------------------------------
// ABANDONED as a deliberate finding, not an exhausted budget
// ---------------------------------------------------------------------------

describe("markAbandoned terminalizes a live claimed attempt", () => {
  maybe()("A/B/C/I. the active claimant abandons, and the row is left settled", async () => {
    const id = await profile("abandon-active");
    const claim = await seededClaim(id, "worker-a");
    // A previous attempt's transient failure and backoff are on the row.
    await prisma!.exchangeFillIngestWindow.update({
      where: { id: claim.windowId },
      data: {
        lastErrorCode: "HTTP_5XX",
        sanitizedLastError: "earlier blip",
        nextEligibleAt: new Date(Date.now() + 60_000),
      },
    });
    const before = await rowOf(claim.windowId);

    await work.markAbandoned(prisma!, claim, {
      reasonCode: "FILL_LEDGER_IDENTITY_CONFLICT",
      sanitizedError: "stored and incoming disagree on price",
    });

    const row = await rowOf(claim.windowId);
    expect(row.status).toBe("ABANDONED");
    // B: the lease and the backoff are gone.
    expect(row.claimedAt).toBeNull();
    expect(row.claimOwner).toBeNull();
    expect(row.nextEligibleAt).toBeNull();
    // C: the terminal reason REPLACES the transient one.
    expect(row.lastErrorCode).toBe("FILL_LEDGER_IDENTITY_CONFLICT");
    expect(row.sanitizedLastError).toBe("stored and incoming disagree on price");
    // I: how many attempts were spent, and when, is retained -- a first-look
    // refusal and a worn-out window are different things.
    expect(row.attempts).toBe(claim.attempt);
    expect(row.lastAttemptAt!.getTime()).toBe(before.lastAttemptAt!.getTime());
  });

  maybe()("abandons on the FIRST attempt, without spending the budget", async () => {
    // The whole point of the primitive: retrying this evidence cannot repair
    // it, so waiting for the attempt budget only delays the operator seeing it.
    const id = await profile("abandon-first-attempt");
    const claim = await seededClaim(id, "worker-a");
    expect(claim.attempt).toBe(1);

    await work.markAbandoned(prisma!, claim, { reasonCode: "REQUEST_INVALID" });

    const row = await rowOf(claim.windowId);
    expect(row.status).toBe("ABANDONED");
    expect(row.attempts).toBe(1);
    expect(row.attempts).toBeLessThan(MAX_INGEST_ATTEMPTS);
  });

  maybe()("D. an omitted detail is null, never an invented message", async () => {
    const id = await profile("abandon-no-detail");
    const claim = await seededClaim(id, "worker-a");

    await work.markAbandoned(prisma!, claim, { reasonCode: "UNSUPPORTED_SYMBOL" });

    const row = await rowOf(claim.windowId);
    expect(row.lastErrorCode).toBe("UNSUPPORTED_SYMBOL");
    expect(row.sanitizedLastError).toBeNull();
  });

  maybe()("D. only what the caller sanitized is stored", async () => {
    // The service persists the phrase it is handed and adds nothing: no URL, no
    // query string, no header. Sanitizing is the caller's job and this pins
    // that the column is not enriched behind its back.
    const id = await profile("abandon-sanitized");
    const claim = await seededClaim(id, "worker-a");

    await work.markAbandoned(prisma!, claim, {
      reasonCode: "AUTH",
      sanitizedError: "Binance rejected the credentials",
    });

    const row = await rowOf(claim.windowId);
    expect(row.sanitizedLastError).toBe("Binance rejected the credentials");
    for (const secret of ["signature=", "X-MBX-APIKEY", "apiKey", "secret", "https://"]) {
      expect(row.sanitizedLastError).not.toContain(secret);
      expect(row.lastErrorCode).not.toContain(secret);
    }
  });

  maybe()("an abandoned window is never claimed again", async () => {
    const id = await profile("abandon-not-claimable");
    const claim = await seededClaim(id, "worker-a");
    await work.markAbandoned(prisma!, claim, { reasonCode: "REQUEST_INVALID" });

    expect(await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "w" })).toBeNull();
  });
});

describe("markAbandoned is fenced like every other transition", () => {
  maybe()("E. a stale attempt cannot abandon the newer one", async () => {
    // The load-bearing case. A worker whose lease expired mid-request comes
    // back holding a permanent-looking failure about a window somebody else now
    // owns; abandoning it would destroy live work from stale evidence.
    const id = await profile("abandon-stale");
    const workerA = await seededClaim(id, "worker-a");
    await expireLease(workerA.windowId);
    const workerB = await work.claimNextWindow(prisma!, {
      executionProfileId: id,
      workerId: "worker-b",
    });
    const before = await rowOf(workerA.windowId);

    await expect(
      work.markAbandoned(prisma!, workerA, { reasonCode: "AUTH" })
    ).rejects.toBeInstanceOf(StaleFillIngestClaimError);

    // Worker B's row is byte-equivalent to what it was.
    const after = await rowOf(workerA.windowId);
    expect(after.status).toBe("PENDING");
    expect(after.attempts).toBe(2);
    expect(after.attempts).toBe(before.attempts);
    expect(after.claimOwner).toBe(workerB!.claimOwner);
    expect(after.claimedAt!.getTime()).toBe(before.claimedAt!.getTime());
    expect(after.nextEligibleAt).toBe(before.nextEligibleAt);
    expect(after.lastErrorCode).toBe(before.lastErrorCode);
    expect(after.sanitizedLastError).toBe(before.sanitizedLastError);
  });

  maybe()("F. the SAME worker id on a newer attempt still fences the old one", async () => {
    // Isolates the token: a stable worker identity across a restart makes the
    // owner column useless, and only the generation can refuse.
    const id = await profile("abandon-same-owner");
    const first = await seededClaim(id, "worker-a");
    await expireLease(first.windowId);
    const second = await work.claimNextWindow(prisma!, {
      executionProfileId: id,
      workerId: "worker-a",
    });
    expect(second!.claimOwner).toBe(first.claimOwner);
    expect(second!.attempt).toBe(first.attempt + 1);

    await expect(
      work.markAbandoned(prisma!, first, { reasonCode: "AUTH" })
    ).rejects.toBeInstanceOf(StaleFillIngestClaimError);
    expect((await rowOf(first.windowId)).status).toBe("PENDING");

    // And the live generation may abandon.
    await work.markAbandoned(prisma!, second!, { reasonCode: "AUTH" });
    expect((await rowOf(first.windowId)).status).toBe("ABANDONED");
  });

  maybe()("a forged attempt or owner is refused", async () => {
    const id = await profile("abandon-forged");
    const claim = await seededClaim(id, "worker-a");

    for (const forged of [
      { ...claim, attempt: 0 },
      { ...claim, attempt: 99 },
      { ...claim, claimOwner: "somebody-else" },
    ]) {
      await expect(
        work.markAbandoned(prisma!, forged, { reasonCode: "AUTH" })
      ).rejects.toBeInstanceOf(StaleFillIngestClaimError);
    }
    expect((await rowOf(claim.windowId)).status).toBe("PENDING");
  });

  maybe()("G. no terminal row can be abandoned or regressed", async () => {
    const terminals = [
      { status: "COMPLETE", reach: (c: any) => work.markComplete(prisma!, c) },
      { status: "INCOMPLETE_SKIPPED_ROWS", reach: (c: any) => work.markIncompleteSkippedRows(prisma!, c) },
      { status: "SATURATED_SINGLE_MILLISECOND", reach: (c: any) => work.markSaturatedSingleMillisecond(prisma!, c) },
      { status: "ABANDONED", reach: (c: any) => work.markAbandoned(prisma!, c, { reasonCode: "AUTH" }) },
    ];

    for (const terminal of terminals) {
      const id = await profile(`abandon-immutable-${terminal.status}`);
      const claim = await seededClaim(id, "worker-a");
      await terminal.reach(claim);

      await expect(
        work.markAbandoned(prisma!, claim, { reasonCode: "REQUEST_INVALID" })
      ).rejects.toBeInstanceOf(StaleFillIngestClaimError);
      await expect(work.markComplete(prisma!, claim)).rejects.toBeInstanceOf(StaleFillIngestClaimError);

      expect((await rowOf(claim.windowId)).status).toBe(terminal.status);
    }
  });

  maybe()("G. a SPLIT parent cannot be abandoned", async () => {
    const id = await profile("abandon-split-parent");
    const claim = await seededClaim(id, "worker-a");
    await work.splitWindow(claim, canonicalHalves(claim));

    await expect(
      work.markAbandoned(prisma!, claim, { reasonCode: "AUTH" })
    ).rejects.toBeInstanceOf(StaleFillIngestClaimError);

    expect((await rowOf(claim.windowId)).status).toBe("SPLIT");
  });

  maybe()("G. a terminal row is refused even while carrying a matching claim", async () => {
    // Isolates the STATUS guard, since a terminal transition normally clears
    // the owner and that alone would refuse.
    const id = await profile("abandon-status-guard");
    const claim = await seededClaim(id, "worker-a");
    await work.markComplete(prisma!, claim);
    await prisma!.exchangeFillIngestWindow.update({
      where: { id: claim.windowId },
      data: { claimedAt: new Date(), claimOwner: claim.claimOwner },
    });

    await expect(
      work.markAbandoned(prisma!, claim, { reasonCode: "AUTH" })
    ).rejects.toBeInstanceOf(StaleFillIngestClaimError);
    expect((await rowOf(claim.windowId)).status).toBe("COMPLETE");
  });

  maybe()("H. it rolls back with the caller's transaction", async () => {
    // So a future executor may terminalize inside the same atomic unit as
    // whatever else it decided.
    const id = await profile("abandon-rollback");
    const claim = await seededClaim(id, "worker-a");
    const before = await rowOf(claim.windowId);

    await expect(
      prisma!.$transaction(async (tx) => {
        await work.markAbandoned(tx, claim, { reasonCode: "AUTH" });
        throw new Error("the caller's own work failed after the transition");
      })
    ).rejects.toThrow(/the caller's own work failed/);

    const after = await rowOf(claim.windowId);
    expect(after.status).toBe("PENDING");
    expect(after.claimOwner).toBe("worker-a");
    expect(after.attempts).toBe(before.attempts);
    expect(after.claimedAt!.getTime()).toBe(before.claimedAt!.getTime());
    expect(after.lastErrorCode).toBeNull();
  });

  maybe()("and commits with it when the caller succeeds", async () => {
    const id = await profile("abandon-commit");
    const claim = await seededClaim(id, "worker-a");

    await prisma!.$transaction(async (tx) => {
      await work.markAbandoned(tx, claim, { reasonCode: "REQUEST_INVALID" });
    });

    expect((await rowOf(claim.windowId)).status).toBe("ABANDONED");
  });
});
