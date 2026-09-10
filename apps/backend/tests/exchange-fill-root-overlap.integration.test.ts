import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * Canonical root-overlap protection, against a REAL Postgres.
 *
 * The whole point of this module is which STORED rows block a desired day, so
 * the identity half of the predicate -- account, symbol, parentless -- can only
 * be proven against real rows written through a real unique constraint. The
 * pure classifier is exercised in the same file without a database, because it
 * must keep answering when there is nothing to connect to.
 *
 * Nothing here imports a Binance client and no exchange request is made
 * anywhere in it or in the code under test.
 */

const TAG = "root-overlap";
const SYMBOL = "OVERLAPUSDT";
const OTHER_SYMBOL = "OVERLAPBTCUSDT";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { DAY_MS } = await import("../src/modules/execution/exchange-fill-day-roots");
const { FillIngestWindowRefusedError } = await import(
  "../src/modules/execution/exchange-fill-ingest-window.service"
);
const { readParentlessRootsOverlappingRange, classifyCanonicalRoot } = await import(
  "../src/modules/execution/exchange-fill-root-overlap"
);

type ParentlessRootWindow = Awaited<ReturnType<typeof readParentlessRootsOverlappingRange>>[number];

const maybe = () => (available ? it : it.skip);

/** A day-aligned epoch, so every interval below is exact integer arithmetic. */
const DAY_START = 20_000 * DAY_MS;
const DAY_END = DAY_START + DAY_MS - 1;
const HALF_DAY_MS = DAY_MS / 2;

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
 * One window row, written directly.
 *
 * Direct writes on purpose: a test has to be able to persist a root the
 * canonical seeding policy would never produce -- an arbitrary twelve-hour
 * straddle -- because that is exactly the shape this module exists to refuse.
 */
async function windowRow(
  executionProfileId: string,
  startTimeMs: number,
  endTimeMs: number,
  overrides: {
    symbol?: string;
    status?: "PENDING" | "COMPLETE" | "SPLIT" | "INCOMPLETE_SKIPPED_ROWS" | "SATURATED_SINGLE_MILLISECOND" | "ABANDONED";
    parentId?: string;
    attempts?: number;
    claimedAt?: Date;
    claimOwner?: string;
    nextEligibleAt?: Date;
    lastAttemptAt?: Date;
    lastErrorCode?: string;
    sanitizedLastError?: string;
  } = {}
) {
  const { symbol = SYMBOL, ...rest } = overrides;
  const row = await prisma!.exchangeFillIngestWindow.create({
    data: {
      executionProfileId,
      symbol,
      startTimeMs: BigInt(startTimeMs),
      endTimeMs: BigInt(endTimeMs),
      ...rest,
    },
  });
  return row.id;
}

/** The full production path: one horizon scan, then the pure verdict. */
async function classifyThroughDatabase(
  executionProfileId: string,
  desired: { startTimeMs: number; endTimeMs: number },
  options: { symbol?: string; range?: { startTimeMs: number; endTimeMs: number } } = {}
) {
  const symbol = options.symbol ?? SYMBOL;
  const range = options.range ?? desired;
  const roots = await readParentlessRootsOverlappingRange(prisma!, executionProfileId, symbol, range);
  return {
    roots,
    verdict: classifyCanonicalRoot({ executionProfileId, symbol, ...desired }, roots),
  };
}

const rowOf = async (id: string) =>
  prisma!.exchangeFillIngestWindow.findUniqueOrThrow({ where: { id } });

beforeAll(() => {
  // Guards the arithmetic every interval below is built from.
  expect(DAY_START % DAY_MS).toBe(0);
  expect(DAY_END - DAY_START).toBe(DAY_MS - 1);
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

describe("canonical root compatibility", () => {
  maybe()("reports MISSING when the account holds no rows at all", async () => {
    const executionProfileId = await profile("empty");

    const { roots, verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    expect(roots).toEqual([]);
    expect(verdict).toEqual({ kind: "MISSING" });
  });

  maybe()("reports MISSING when every existing root is a different day", async () => {
    const executionProfileId = await profile("other-days");
    await windowRow(executionProfileId, DAY_START - 3 * DAY_MS, DAY_START - 2 * DAY_MS - 1);
    await windowRow(executionProfileId, DAY_START + DAY_MS, DAY_START + 2 * DAY_MS - 1);

    const { verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    expect(verdict).toEqual({ kind: "MISSING" });
  });

  const STATUSES = [
    "PENDING",
    "COMPLETE",
    "SPLIT",
    "INCOMPLETE_SKIPPED_ROWS",
    "SATURATED_SINGLE_MILLISECOND",
    "ABANDONED",
  ] as const;

  for (const status of STATUSES) {
    maybe()(`accepts an exactly equal root in status ${status} and mutates nothing`, async () => {
      const executionProfileId = await profile(`exact-${status}`);
      const windowId = await windowRow(executionProfileId, DAY_START, DAY_END, {
        status,
        attempts: 4,
        lastAttemptAt: new Date("2026-08-11T09:00:00.000Z"),
        lastErrorCode: "USER_TRADES_DISPATCH_FAILED",
        sanitizedLastError: "upstream refused",
      });
      const before = await rowOf(windowId);

      const { verdict } = await classifyThroughDatabase(executionProfileId, {
        startTimeMs: DAY_START,
        endTimeMs: DAY_END,
      });

      expect(verdict).toEqual({ kind: "COMPATIBLE_EXISTING_ROOT", windowId });

      // Every column, including the ones a careless "repair" would reset.
      const after = await rowOf(windowId);
      expect(after).toEqual(before);
      expect(after.status).toBe(status);
      expect(after.attempts).toBe(4);
      expect(after.lastErrorCode).toBe("USER_TRADES_DISPATCH_FAILED");
      expect(after.sanitizedLastError).toBe("upstream refused");
    });
  }

  maybe()("leaves a live lease on an exactly equal root untouched", async () => {
    const executionProfileId = await profile("exact-leased");
    const claimedAt = new Date("2026-08-11T10:00:00.000Z");
    const nextEligibleAt = new Date("2026-08-11T10:05:00.000Z");
    const windowId = await windowRow(executionProfileId, DAY_START, DAY_END, {
      status: "PENDING",
      attempts: 2,
      claimedAt,
      claimOwner: "worker-a",
      nextEligibleAt,
    });
    const before = await rowOf(windowId);

    const { verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    expect(verdict).toEqual({ kind: "COMPATIBLE_EXISTING_ROOT", windowId });
    const after = await rowOf(windowId);
    expect(after).toEqual(before);
    expect(after.claimedAt).toEqual(claimedAt);
    expect(after.claimOwner).toBe("worker-a");
    expect(after.nextEligibleAt).toEqual(nextEligibleAt);
  });
});

describe("structural overlap", () => {
  maybe()("refuses a day straddled by an arbitrary parentless root", async () => {
    const executionProfileId = await profile("straddle");
    // The exact collision the natural key cannot see: different bounds, so the
    // unique constraint would admit both trees.
    const straddleId = await windowRow(
      executionProfileId,
      DAY_START - HALF_DAY_MS,
      DAY_START + HALF_DAY_MS
    );

    const { verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    expect(verdict).toEqual({
      kind: "STRUCTURAL_ROOT_OVERLAP",
      executionProfileId,
      symbol: SYMBOL,
      desired: { startTimeMs: DAY_START, endTimeMs: DAY_END },
      overlaps: [
        {
          windowId: straddleId,
          startTimeMs: DAY_START - HALF_DAY_MS,
          endTimeMs: DAY_START + HALF_DAY_MS,
        },
      ],
    });
  });

  maybe()("refuses when an EXACT root and a crossing root both exist", async () => {
    const executionProfileId = await profile("exact-plus-crossing");
    const crossingId = await windowRow(
      executionProfileId,
      DAY_START - HALF_DAY_MS,
      DAY_START + HALF_DAY_MS
    );
    const exactId = await windowRow(executionProfileId, DAY_START, DAY_END);

    const { verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    // The exactly-equal row is NOT a permission slip while a neighbour still
    // claims the same hours.
    expect(verdict.kind).toBe("STRUCTURAL_ROOT_OVERLAP");
    if (verdict.kind !== "STRUCTURAL_ROOT_OVERLAP") throw new Error("unreachable");
    expect(verdict.overlaps.map((root) => root.windowId)).toEqual([crossingId, exactId]);
  });

  maybe()("reports every incompatible root, not just the first", async () => {
    const executionProfileId = await profile("many");
    const leftId = await windowRow(executionProfileId, DAY_START - HALF_DAY_MS, DAY_START + 1);
    const insideId = await windowRow(executionProfileId, DAY_START + 1, DAY_END - 1);
    const rightId = await windowRow(executionProfileId, DAY_END - 1, DAY_END + HALF_DAY_MS);

    const { verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    expect(verdict.kind).toBe("STRUCTURAL_ROOT_OVERLAP");
    if (verdict.kind !== "STRUCTURAL_ROOT_OVERLAP") throw new Error("unreachable");
    expect(verdict.overlaps.map((root) => root.windowId)).toEqual([leftId, insideId, rightId]);
  });

  maybe()("refuses a root that strictly contains the desired day", async () => {
    const executionProfileId = await profile("containing");
    const containingId = await windowRow(
      executionProfileId,
      DAY_START - HALF_DAY_MS,
      DAY_END + HALF_DAY_MS
    );

    const { verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    expect(verdict.kind).toBe("STRUCTURAL_ROOT_OVERLAP");
    if (verdict.kind !== "STRUCTURAL_ROOT_OVERLAP") throw new Error("unreachable");
    expect(verdict.overlaps.map((root) => root.windowId)).toEqual([containingId]);
  });

  maybe()("refuses a root strictly contained by the desired day", async () => {
    const executionProfileId = await profile("contained");
    const containedId = await windowRow(executionProfileId, DAY_START + 1, DAY_END - 1);

    const { verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    expect(verdict.kind).toBe("STRUCTURAL_ROOT_OVERLAP");
    if (verdict.kind !== "STRUCTURAL_ROOT_OVERLAP") throw new Error("unreachable");
    expect(verdict.overlaps.map((root) => root.windowId)).toEqual([containedId]);
  });
});

describe("inclusive boundaries", () => {
  maybe()("counts a root ending on exactly the desired first millisecond", async () => {
    const executionProfileId = await profile("touch-start");
    const touchingId = await windowRow(executionProfileId, DAY_START - HALF_DAY_MS, DAY_START);

    const { verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    // One shared millisecond is a shared millisecond.
    expect(verdict.kind).toBe("STRUCTURAL_ROOT_OVERLAP");
    if (verdict.kind !== "STRUCTURAL_ROOT_OVERLAP") throw new Error("unreachable");
    expect(verdict.overlaps.map((root) => root.windowId)).toEqual([touchingId]);
  });

  maybe()("counts a root starting on exactly the desired last millisecond", async () => {
    const executionProfileId = await profile("touch-end");
    const touchingId = await windowRow(executionProfileId, DAY_END, DAY_END + HALF_DAY_MS);

    const { verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    expect(verdict.kind).toBe("STRUCTURAL_ROOT_OVERLAP");
    if (verdict.kind !== "STRUCTURAL_ROOT_OVERLAP") throw new Error("unreachable");
    expect(verdict.overlaps.map((root) => root.windowId)).toEqual([touchingId]);
  });

  maybe()("ignores a root ending one millisecond before the desired day", async () => {
    const executionProfileId = await profile("adjacent-before");
    await windowRow(executionProfileId, DAY_START - HALF_DAY_MS, DAY_START - 1);

    const { verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    // Adjacency is not overlap: this is the ordinary previous UTC day.
    expect(verdict).toEqual({ kind: "MISSING" });
  });

  maybe()("ignores a root starting one millisecond after the desired day", async () => {
    const executionProfileId = await profile("adjacent-after");
    await windowRow(executionProfileId, DAY_END + 1, DAY_END + HALF_DAY_MS);

    const { verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    expect(verdict).toEqual({ kind: "MISSING" });
  });

  maybe()("treats two adjacent canonical days as independently seedable", async () => {
    const executionProfileId = await profile("adjacent-days");
    const previousId = await windowRow(executionProfileId, DAY_START - DAY_MS, DAY_START - 1);

    const previous = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START - DAY_MS,
      endTimeMs: DAY_START - 1,
    });
    const current = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    expect(previous.verdict).toEqual({ kind: "COMPATIBLE_EXISTING_ROOT", windowId: previousId });
    expect(current.verdict).toEqual({ kind: "MISSING" });
  });
});

describe("identity isolation", () => {
  maybe()("ignores an overlapping root belonging to another execution profile", async () => {
    const executionProfileId = await profile("mine");
    const otherProfileId = await profile("theirs");
    await windowRow(otherProfileId, DAY_START - HALF_DAY_MS, DAY_START + HALF_DAY_MS);

    const { roots, verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    // Two accounts may sweep the same symbol over the same range independently.
    expect(roots).toEqual([]);
    expect(verdict).toEqual({ kind: "MISSING" });
  });

  maybe()("ignores an overlapping root on another symbol of the same profile", async () => {
    const executionProfileId = await profile("two-symbols");
    await windowRow(executionProfileId, DAY_START - HALF_DAY_MS, DAY_START + HALF_DAY_MS, {
      symbol: OTHER_SYMBOL,
    });

    const { roots, verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    // userTrades is per-symbol, so the same interval on two symbols is two
    // independent questions.
    expect(roots).toEqual([]);
    expect(verdict).toEqual({ kind: "MISSING" });
  });
});

describe("descendants are not roots", () => {
  maybe()("keeps an exactly equal root compatible even after it was split", async () => {
    const executionProfileId = await profile("split-tree");
    const rootId = await windowRow(executionProfileId, DAY_START, DAY_END, { status: "SPLIT" });
    const mid = DAY_START + Math.floor((DAY_END - DAY_START) / 2);
    await windowRow(executionProfileId, DAY_START, mid, { parentId: rootId });
    await windowRow(executionProfileId, mid + 1, DAY_END, { parentId: rootId });

    const { roots, verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    // Three rows cover this day; exactly one of them is a root.
    expect(roots.map((root) => root.windowId)).toEqual([rootId]);
    expect(verdict).toEqual({ kind: "COMPATIBLE_EXISTING_ROOT", windowId: rootId });
  });

  maybe()("ignores descendants of a root that does not reach the desired day", async () => {
    const executionProfileId = await profile("split-elsewhere");
    const rootId = await windowRow(executionProfileId, DAY_START - DAY_MS, DAY_START - 1, {
      status: "SPLIT",
    });
    const mid = DAY_START - DAY_MS + Math.floor((DAY_MS - 1) / 2);
    await windowRow(executionProfileId, DAY_START - DAY_MS, mid, { parentId: rootId });
    await windowRow(executionProfileId, mid + 1, DAY_START - 1, { parentId: rootId });

    const { roots, verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    expect(roots).toEqual([]);
    expect(verdict).toEqual({ kind: "MISSING" });
  });

  maybe()("reports the offending ROOT, never its children, on a straddling tree", async () => {
    const executionProfileId = await profile("straddling-tree");
    const rootId = await windowRow(
      executionProfileId,
      DAY_START - HALF_DAY_MS,
      DAY_START + HALF_DAY_MS,
      { status: "SPLIT" }
    );
    const mid = DAY_START - HALF_DAY_MS + Math.floor(DAY_MS / 2);
    await windowRow(executionProfileId, DAY_START - HALF_DAY_MS, mid, { parentId: rootId });
    await windowRow(executionProfileId, mid + 1, DAY_START + HALF_DAY_MS, { parentId: rootId });

    const { verdict } = await classifyThroughDatabase(executionProfileId, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    expect(verdict.kind).toBe("STRUCTURAL_ROOT_OVERLAP");
    if (verdict.kind !== "STRUCTURAL_ROOT_OVERLAP") throw new Error("unreachable");
    // One collision reported once, at the level a human can act on.
    expect(verdict.overlaps.map((root) => root.windowId)).toEqual([rootId]);
  });
});

describe("horizon scan", () => {
  maybe()("answers a sixty-day horizon from a single query", async () => {
    const executionProfileId = await profile("horizon");
    const horizonDays = 60;
    const oldestStartMs = DAY_START - (horizonDays - 1) * DAY_MS;
    const exactId = await windowRow(executionProfileId, DAY_START - DAY_MS, DAY_START - 1);
    const straddleId = await windowRow(
      executionProfileId,
      oldestStartMs + HALF_DAY_MS,
      oldestStartMs + DAY_MS + HALF_DAY_MS
    );

    // A sixty-day span is a legal SCAN and an illegal window: the seven-day cap
    // limits what may be asked of an exchange, and nothing is asked here.
    const roots = await readParentlessRootsOverlappingRange(prisma!, executionProfileId, SYMBOL, {
      startTimeMs: oldestStartMs,
      endTimeMs: DAY_END,
    });

    expect(roots.map((root) => root.windowId)).toEqual([straddleId, exactId]);

    const verdicts = [];
    for (let startTimeMs = oldestStartMs; startTimeMs <= DAY_START; startTimeMs += DAY_MS) {
      verdicts.push(
        classifyCanonicalRoot(
          { executionProfileId, symbol: SYMBOL, startTimeMs, endTimeMs: startTimeMs + DAY_MS - 1 },
          roots
        )
      );
    }

    expect(verdicts).toHaveLength(horizonDays);
    expect(verdicts[0]!.kind).toBe("STRUCTURAL_ROOT_OVERLAP");
    expect(verdicts[1]!.kind).toBe("STRUCTURAL_ROOT_OVERLAP");
    expect(verdicts[2]!.kind).toBe("MISSING");
    expect(verdicts[horizonDays - 2]).toEqual({
      kind: "COMPATIBLE_EXISTING_ROOT",
      windowId: exactId,
    });
    expect(verdicts[horizonDays - 1]).toEqual({ kind: "MISSING" });
  });

  maybe()("returns roots in start, end, id order regardless of insertion order", async () => {
    const executionProfileId = await profile("ordering");
    // Inserted newest-first, and the two same-start rows are inserted
    // longest-first, so insertion order contradicts the required order twice.
    const lateId = await windowRow(executionProfileId, DAY_START + 1, DAY_END);
    const wideId = await windowRow(executionProfileId, DAY_START, DAY_END + HALF_DAY_MS);
    const narrowId = await windowRow(executionProfileId, DAY_START, DAY_END);

    const roots = await readParentlessRootsOverlappingRange(prisma!, executionProfileId, SYMBOL, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    expect(roots.map((root) => root.windowId)).toEqual([narrowId, wideId, lateId]);
  });

  maybe()("hands back plain numbers, never Prisma BigInt", async () => {
    const executionProfileId = await profile("bigint");
    await windowRow(executionProfileId, DAY_START, DAY_END);

    const roots = await readParentlessRootsOverlappingRange(prisma!, executionProfileId, SYMBOL, {
      startTimeMs: DAY_START,
      endTimeMs: DAY_END,
    });

    expect(typeof roots[0]!.startTimeMs).toBe("number");
    expect(typeof roots[0]!.endTimeMs).toBe("number");
    expect(roots[0]!.startTimeMs).toBe(DAY_START);
    expect(roots[0]!.endTimeMs).toBe(DAY_END);
    // A BigInt anywhere in the shape would throw here, which is exactly what a
    // report or an API payload would do in production.
    expect(() => JSON.stringify(roots)).not.toThrow();
  });
});

/**
 * No database. These hold whether Postgres is reachable or not, because a pure
 * verdict and a refusal must not depend on infrastructure being up.
 */
describe("pure classification", () => {
  type Client = Parameters<typeof readParentlessRootsOverlappingRange>[0];

  const root = (windowId: string, startTimeMs: number, endTimeMs: number): ParentlessRootWindow => ({
    windowId,
    startTimeMs,
    endTimeMs,
  });

  const desired = { executionProfileId: "profile-1", symbol: SYMBOL };

  /** A client that fails the test if it is ever asked for anything. */
  const forbiddenClient = {
    exchangeFillIngestWindow: {
      findMany: () => {
        throw new Error("the database must not be touched");
      },
    },
  } as unknown as Client;

  it("preserves the order it was handed rather than re-sorting", () => {
    const verdict = classifyCanonicalRoot(
      { ...desired, startTimeMs: DAY_START, endTimeMs: DAY_END },
      [
        root("b", DAY_START - HALF_DAY_MS, DAY_START + 1),
        root("a", DAY_START + 2, DAY_END),
      ]
    );

    expect(verdict.kind).toBe("STRUCTURAL_ROOT_OVERLAP");
    if (verdict.kind !== "STRUCTURAL_ROOT_OVERLAP") throw new Error("unreachable");
    expect(verdict.overlaps.map((row) => row.windowId)).toEqual(["b", "a"]);
  });

  it("ignores scanned roots belonging to other days of the same horizon", () => {
    const roots = [
      root("day-minus-2", DAY_START - 2 * DAY_MS, DAY_START - DAY_MS - 1),
      root("day-minus-1", DAY_START - DAY_MS, DAY_START - 1),
      root("day-plus-1", DAY_START + DAY_MS, DAY_START + 2 * DAY_MS - 1),
    ];

    expect(
      classifyCanonicalRoot({ ...desired, startTimeMs: DAY_START, endTimeMs: DAY_END }, roots)
    ).toEqual({ kind: "MISSING" });
    expect(
      classifyCanonicalRoot(
        { ...desired, startTimeMs: DAY_START - DAY_MS, endTimeMs: DAY_START - 1 },
        roots
      )
    ).toEqual({ kind: "COMPATIBLE_EXISTING_ROOT", windowId: "day-minus-1" });
  });

  it("refuses two rows with identical exact bounds", () => {
    const verdict = classifyCanonicalRoot({ ...desired, startTimeMs: DAY_START, endTimeMs: DAY_END }, [
      root("first", DAY_START, DAY_END),
      root("second", DAY_START, DAY_END),
    ]);

    // Unreachable through the unique constraint, and still not compatible: two
    // rows for one interval is a structural question, not a pick-one.
    expect(verdict.kind).toBe("STRUCTURAL_ROOT_OVERLAP");
  });

  it("refuses desired bounds through the window validator, before any verdict", () => {
    const cases: Array<[string, number, number]> = [
      ["ends before it starts", DAY_END, DAY_START],
      ["not a safe integer", DAY_START + 0.5, DAY_END],
      ["before the epoch", -1, DAY_END],
      ["wider than the userTrades span", DAY_START, DAY_START + 8 * DAY_MS],
    ];

    for (const [, startTimeMs, endTimeMs] of cases) {
      expect(() =>
        classifyCanonicalRoot({ ...desired, startTimeMs, endTimeMs }, [])
      ).toThrow(FillIngestWindowRefusedError);
    }
  });

  it("accepts a scan range far wider than any single window", async () => {
    const rows: Array<{ id: string; startTimeMs: bigint; endTimeMs: bigint }> = [];
    const client = {
      exchangeFillIngestWindow: { findMany: async () => rows },
    } as unknown as Client;

    await expect(
      readParentlessRootsOverlappingRange(client, "profile-1", SYMBOL, {
        startTimeMs: DAY_START - 59 * DAY_MS,
        endTimeMs: DAY_END,
      })
    ).resolves.toEqual([]);
  });

  it("refuses an impossible scan range before issuing a query", async () => {
    await expect(
      readParentlessRootsOverlappingRange(forbiddenClient, "profile-1", SYMBOL, {
        startTimeMs: DAY_END,
        endTimeMs: DAY_START,
      })
    ).rejects.toBeInstanceOf(FillIngestWindowRefusedError);

    await expect(
      readParentlessRootsOverlappingRange(forbiddenClient, "profile-1", SYMBOL, {
        startTimeMs: DAY_START + 0.5,
        endTimeMs: DAY_END,
      })
    ).rejects.toBeInstanceOf(FillIngestWindowRefusedError);

    await expect(
      readParentlessRootsOverlappingRange(forbiddenClient, "profile-1", SYMBOL, {
        startTimeMs: -1,
        endTimeMs: DAY_END,
      })
    ).rejects.toBeInstanceOf(FillIngestWindowRefusedError);
  });

  it("propagates an infrastructure failure instead of reporting MISSING", async () => {
    const failure = new Error("connection terminated unexpectedly");
    const client = {
      exchangeFillIngestWindow: {
        findMany: async () => {
          throw failure;
        },
      },
    } as unknown as Client;

    await expect(
      readParentlessRootsOverlappingRange(client, "profile-1", SYMBOL, {
        startTimeMs: DAY_START,
        endTimeMs: DAY_END,
      })
    ).rejects.toBe(failure);
  });

  it("refuses a stored bound that is not a safe integer", async () => {
    const client = {
      exchangeFillIngestWindow: {
        findMany: async () => [
          { id: "corrupt", startTimeMs: BigInt(Number.MAX_SAFE_INTEGER) + 2n, endTimeMs: 0n },
        ],
      },
    } as unknown as Client;

    await expect(
      readParentlessRootsOverlappingRange(client, "profile-1", SYMBOL, {
        startTimeMs: DAY_START,
        endTimeMs: DAY_END,
      })
    ).rejects.toBeInstanceOf(FillIngestWindowRefusedError);
  });
});
