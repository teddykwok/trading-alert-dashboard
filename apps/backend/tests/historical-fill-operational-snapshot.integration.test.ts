import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * The historical-fill operational snapshot, against a REAL Postgres.
 *
 * Every number this service reports is an aggregate the database computes, so
 * none of it can be proven against a mock: a stubbed count would only prove the
 * stub agrees with itself. The boundary predicates in particular -- a lease
 * exactly one lease-length old, a backoff expiring exactly now -- are the kind
 * of thing that is right or wrong by one millisecond, and only real SQL
 * comparisons settle them.
 *
 * Nothing here imports a Binance client and no exchange request is made.
 */

const TAG = "fill-snapshot";
const SYMBOL = "SNAPUSDT";
const SYMBOL_B = "SNAPBUSDT";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const {
  ExchangeFillIngestWindowService,
  INGEST_CLAIM_LEASE_MS,
  MAX_INGEST_ATTEMPTS,
} = await import("../src/modules/execution/exchange-fill-ingest-window.service");
const { HistoricalFillOperationalSnapshotService } = await import(
  "../src/modules/execution/historical-fill-operational-snapshot.service"
);

const maybe = () => (available ? it : it.skip);

const DAY_MS = 86_400_000;
/** The one instant every classification below is measured against. */
const NOW = new Date("2026-08-12T09:15:00.000Z");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const STALE_BEFORE = at(-INGEST_CLAIM_LEASE_MS);

let sequence = 0;

const boundTo = (executionProfileId: string) =>
  async () => ({ ok: true as const, context: { executionProfileId, environment: "TESTNET" } as never });

const snapshotFor = (executionProfileId: string, overrides: Record<string, unknown> = {}) =>
  new HistoricalFillOperationalSnapshotService({
    prisma: prisma!,
    bindProfile: boundTo(executionProfileId),
    ...overrides,
  } as never);

async function profile(alias: string) {
  sequence += 1;
  const row = await prisma!.executionProfile.create({
    data: {
      name: `${TAG} ${alias} ${sequence}`,
      accountIdentifier: `${TAG}-${alias}-${sequence}`,
      environment: "TESTNET",
      isEnabled: false,
      safetyPolicy: { create: {} },
    },
  });
  return row.id;
}

/** One durable window, every operational field placeable by the test. */
async function windowRow(
  executionProfileId: string,
  options: Record<string, unknown> & { startTimeMs: number }
) {
  const { startTimeMs, symbol = SYMBOL, endTimeMs, ...rest } = options;
  const row = await prisma!.exchangeFillIngestWindow.create({
    data: {
      executionProfileId,
      symbol: symbol as string,
      startTimeMs: BigInt(startTimeMs),
      endTimeMs: BigInt((endTimeMs as number) ?? startTimeMs + DAY_MS - 1),
      ...rest,
    },
  });
  return row.id;
}

/** One durable fill. `attribution` is the column the snapshot counts. */
async function fillRow(
  executionProfileId: string,
  tradeId: string,
  attribution: "OWNED_ORDER" | "UNATTRIBUTED" | "AMBIGUOUS" = "UNATTRIBUTED"
) {
  return prisma!.exchangeFillLedger.create({
    data: {
      executionProfileId,
      symbol: SYMBOL,
      exchangeTradeId: tradeId,
      attribution,
      side: "SELL",
      positionSide: "LONG",
      quantity: "68.8",
      price: "1.0925",
      tradeTime: new Date("2026-08-11T12:00:00.000Z"),
    },
  });
}

beforeAll(async () => {
  if (!prisma || !available) return;
  // Guards the arithmetic every boundary case below is built from.
  expect(STALE_BEFORE.getTime()).toBe(NOW.getTime() - INGEST_CLAIM_LEASE_MS);
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
    await prisma.exchangeFillLedger.deleteMany({ where: { executionProfileId: { in: profiles } } });
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

describe("the profile gates everything", () => {
  it("A. an unresolved binding returns the exact reason and reads no workset", async () => {
    // A client that answers NOTHING. If the snapshot reached for windows or
    // fills after a failed binding, the property would be undefined and this
    // would throw rather than pass.
    const blind = {} as PrismaClient;
    const service = new HistoricalFillOperationalSnapshotService({
      prisma: blind,
      bindProfile: async () => ({
        ok: false as const,
        reasonCode: "PROFILE_POLICY_MISSING" as const,
        message: "no policy",
      }),
    } as never);

    const snapshot = await service.capture({ now: NOW });

    expect(snapshot).toEqual({
      outcome: "PROFILE_UNAVAILABLE",
      capturedAt: NOW,
      reasonCode: "PROFILE_POLICY_MISSING",
    });
  });

  for (const reasonCode of [
    "PROFILE_NOT_CONFIGURED",
    "PROFILE_NOT_FOUND",
    "PROFILE_AMBIGUOUS",
    "PROFILE_POLICY_MISSING",
    "PROFILE_ENVIRONMENT_MISMATCH",
  ] as const) {
    it(`A. preserves the binder's ${reasonCode} unflattened`, async () => {
      const service = new HistoricalFillOperationalSnapshotService({
        prisma: {} as PrismaClient,
        bindProfile: async () => ({ ok: false as const, reasonCode, message: "x" }),
      } as never);

      const snapshot = await service.capture({ now: NOW });

      expect(snapshot.outcome).toBe("PROFILE_UNAVAILABLE");
      if (snapshot.outcome !== "PROFILE_UNAVAILABLE") throw new Error("unreachable");
      expect(snapshot.reasonCode).toBe(reasonCode);
    });
  }

  maybe()("N. never counts another execution profile's rows", async () => {
    const mine = await profile("isolation-mine");
    const theirs = await profile("isolation-theirs");
    await windowRow(mine, { startTimeMs: 60_000 * DAY_MS });
    await windowRow(theirs, { startTimeMs: 60_000 * DAY_MS, symbol: SYMBOL_B });
    await windowRow(theirs, { startTimeMs: 61_000 * DAY_MS, status: "COMPLETE" });
    await fillRow(theirs, "iso-1");

    const snapshot = await snapshotFor(mine).capture({ now: NOW });

    expect(snapshot.outcome).toBe("READY");
    if (snapshot.outcome !== "READY") throw new Error("unreachable");
    expect(snapshot.executionProfileId).toBe(mine);
    expect(snapshot.windows.total).toBe(1);
    expect(snapshot.windows.byStatus.COMPLETE).toBe(0);
    expect(snapshot.windows.distinctSymbolCount).toBe(1);
    expect(snapshot.ledger.totalFills).toBe(0);
  });

  maybe()("B. an empty profile is READY with zeros and nulls, never NO_WORK", async () => {
    const id = await profile("empty");

    const snapshot = await snapshotFor(id).capture({ now: NOW });

    expect(snapshot).toEqual({
      outcome: "READY",
      capturedAt: NOW,
      executionProfileId: id,
      windows: {
        total: 0,
        roots: 0,
        children: 0,
        distinctSymbolCount: 0,
        byStatus: {
          PENDING: 0,
          COMPLETE: 0,
          SPLIT: 0,
          INCOMPLETE_SKIPPED_ROWS: 0,
          SATURATED_SINGLE_MILLISECOND: 0,
          ABANDONED: 0,
        },
      },
      pending: {
        total: 0,
        claimableNow: 0,
        activeLease: 0,
        staleLease: 0,
        inBackoff: 0,
        attemptExhausted: 0,
        oldestPendingCreatedAt: null,
        oldestClaimableCreatedAt: null,
        nextBackoffEligibleAt: null,
      },
      ledger: { totalFills: 0, unattributedFills: 0 },
    });
  });
});

describe("window counts", () => {
  maybe()("C+D. every status is counted, and the totals conserve", async () => {
    const id = await profile("status-counts");
    const base = 62_000 * DAY_MS;
    const statuses = [
      "PENDING",
      "COMPLETE",
      "SPLIT",
      "INCOMPLETE_SKIPPED_ROWS",
      "SATURATED_SINGLE_MILLISECOND",
      "ABANDONED",
    ] as const;
    // One of each status, plus a second PENDING so the counts are not all 1.
    let offset = 0;
    for (const status of statuses) {
      await windowRow(id, { startTimeMs: base + offset * DAY_MS, status });
      offset += 1;
    }
    const parentId = await windowRow(id, { startTimeMs: base + 90 * DAY_MS, status: "SPLIT" });
    await windowRow(id, { startTimeMs: base + 91 * DAY_MS, parentId });
    await windowRow(id, { startTimeMs: base + 92 * DAY_MS, parentId });

    const snapshot = await snapshotFor(id).capture({ now: NOW });
    if (snapshot.outcome !== "READY") throw new Error("unreachable");

    expect(snapshot.windows.byStatus).toEqual({
      PENDING: 3, // the seeded one plus two children
      COMPLETE: 1,
      SPLIT: 2,
      INCOMPLETE_SKIPPED_ROWS: 1,
      SATURATED_SINGLE_MILLISECOND: 1,
      ABANDONED: 1,
    });
    // Sum of the status map is the total.
    const summed = Object.values(snapshot.windows.byStatus).reduce((a, b) => a + b, 0);
    expect(summed).toBe(snapshot.windows.total);
    expect(snapshot.windows.total).toBe(9);
    // Roots and children partition the same total.
    expect(snapshot.windows.roots).toBe(7);
    expect(snapshot.windows.children).toBe(2);
    expect(snapshot.windows.roots + snapshot.windows.children).toBe(snapshot.windows.total);
  });

  maybe()("L. distinct symbols are counted, not window rows", async () => {
    const id = await profile("symbols");
    const base = 63_000 * DAY_MS;
    await windowRow(id, { startTimeMs: base, symbol: SYMBOL });
    await windowRow(id, { startTimeMs: base + DAY_MS, symbol: SYMBOL });
    await windowRow(id, { startTimeMs: base + 2 * DAY_MS, symbol: SYMBOL });
    await windowRow(id, { startTimeMs: base, symbol: SYMBOL_B });

    const snapshot = await snapshotFor(id).capture({ now: NOW });
    if (snapshot.outcome !== "READY") throw new Error("unreachable");

    expect(snapshot.windows.total).toBe(4);
    expect(snapshot.windows.distinctSymbolCount).toBe(2); // duplicates do not inflate
  });
});

describe("pending diagnostics use the claim doctrine exactly", () => {
  /**
   * E+F+G+H. One profile carrying every interesting combination at once, so
   * the classifications are proven against each other rather than in isolation.
   */
  maybe()("classifies each boundary row exactly as claimNextWindow would", async () => {
    const id = await profile("claimability");
    const base = 64_000 * DAY_MS;
    let slot = 0;
    const row = (options: Record<string, unknown>) => {
      slot += 1;
      return windowRow(id, { startTimeMs: base + slot * DAY_MS, ...options });
    };

    // --- claimable ---------------------------------------------------------
    const freshUnclaimed = await row({});
    const backoffExactlyNow = await row({ nextEligibleAt: NOW });
    const backoffPast = await row({ nextEligibleAt: at(-1) });
    const leaseJustStale = await row({ claimedAt: at(-INGEST_CLAIM_LEASE_MS - 1), claimOwner: "w" });
    const attemptsBelowMax = await row({ attempts: MAX_INGEST_ATTEMPTS - 1 });
    // --- NOT claimable -----------------------------------------------------
    // A lease exactly one lease-length old is still ACTIVE: the predicate is
    // `claimedAt < staleBefore`, not `<=`.
    const leaseExactlyAtBoundary = await row({ claimedAt: STALE_BEFORE, claimOwner: "w" });
    const leaseActive = await row({ claimedAt: at(-1000), claimOwner: "w" });
    const inBackoffByOneMs = await row({ nextEligibleAt: at(1) });
    const exhausted = await row({ attempts: MAX_INGEST_ATTEMPTS });
    const terminal = await row({ status: "COMPLETE" });

    const snapshot = await snapshotFor(id).capture({ now: NOW });
    if (snapshot.outcome !== "READY") throw new Error("unreachable");

    expect(snapshot.pending.total).toBe(9); // everything except the COMPLETE row
    expect(snapshot.pending.claimableNow).toBe(5);

    // F. The lease boundary, both sides of it.
    expect(snapshot.pending.activeLease).toBe(2); // exactly-at-boundary + active
    expect(snapshot.pending.staleLease).toBe(1); // one millisecond older
    // G. The backoff boundary, both sides of it.
    expect(snapshot.pending.inBackoff).toBe(1); // only the +1ms row
    // H. Attempt exhaustion is reported as a fact, with no verdict attached.
    expect(snapshot.pending.attemptExhausted).toBe(1);

    // Orthogonal diagnostics never exceed the pending population.
    for (const metric of [
      snapshot.pending.claimableNow,
      snapshot.pending.activeLease,
      snapshot.pending.staleLease,
      snapshot.pending.inBackoff,
      snapshot.pending.attemptExhausted,
    ]) {
      expect(metric).toBeLessThanOrEqual(snapshot.pending.total);
    }

    // The real claim path agrees, row for row. Draining the queue at the same
    // instant must yield exactly the rows the snapshot called claimable.
    const work = new ExchangeFillIngestWindowService(prisma!);
    const claimed: string[] = [];
    for (;;) {
      const claim = await work.claimNextWindow(prisma!, {
        executionProfileId: id,
        workerId: `drain-${claimed.length}`,
        now: NOW,
      });
      if (claim === null) break;
      claimed.push(claim.windowId);
    }
    expect(claimed.length).toBe(snapshot.pending.claimableNow);
    expect(new Set(claimed)).toEqual(
      new Set([freshUnclaimed, backoffExactlyNow, backoffPast, leaseJustStale, attemptsBelowMax])
    );
    expect(claimed).not.toContain(leaseExactlyAtBoundary);
    expect(claimed).not.toContain(leaseActive);
    expect(claimed).not.toContain(inBackoffByOneMs);
    expect(claimed).not.toContain(exhausted);
    expect(claimed).not.toContain(terminal);
  });
});

describe("queue timing", () => {
  maybe()("I+J+K. reports the right minimum for each distinct question", async () => {
    const id = await profile("timing");
    const base = 65_000 * DAY_MS;

    // The OLDEST pending row is deliberately NOT claimable: it is in backoff.
    // A snapshot that answered "oldest claimable" with "oldest pending" would
    // tell an operator work is starting sooner than it is.
    await windowRow(id, {
      startTimeMs: base,
      createdAt: at(-10 * 3_600_000),
      nextEligibleAt: at(30 * 60_000),
    });
    await windowRow(id, {
      startTimeMs: base + DAY_MS,
      createdAt: at(-5 * 3_600_000),
      nextEligibleAt: at(10 * 60_000),
    });
    // The oldest CLAIMABLE row, newer than both of those.
    await windowRow(id, { startTimeMs: base + 2 * DAY_MS, createdAt: at(-2 * 3_600_000) });
    await windowRow(id, { startTimeMs: base + 3 * DAY_MS, createdAt: at(-1 * 3_600_000) });
    // Terminal rows never influence any of these minimums, however old.
    await windowRow(id, {
      startTimeMs: base + 4 * DAY_MS,
      createdAt: at(-99 * 3_600_000),
      status: "COMPLETE",
    });

    const snapshot = await snapshotFor(id).capture({ now: NOW });
    if (snapshot.outcome !== "READY") throw new Error("unreachable");

    expect(snapshot.pending.oldestPendingCreatedAt).toEqual(at(-10 * 3_600_000));
    expect(snapshot.pending.oldestClaimableCreatedAt).toEqual(at(-2 * 3_600_000));
    // The EARLIEST future backoff, not the latest and not a past one.
    expect(snapshot.pending.nextBackoffEligibleAt).toEqual(at(10 * 60_000));
    // Durable instants, not derived "age seconds".
    expect(snapshot.pending.oldestPendingCreatedAt).toBeInstanceOf(Date);
  });

  maybe()("K. reports no next backoff when nothing is waiting", async () => {
    const id = await profile("no-backoff");
    await windowRow(id, { startTimeMs: 66_000 * DAY_MS, nextEligibleAt: at(-1) });

    const snapshot = await snapshotFor(id).capture({ now: NOW });
    if (snapshot.outcome !== "READY") throw new Error("unreachable");

    expect(snapshot.pending.nextBackoffEligibleAt).toBeNull();
    expect(snapshot.pending.inBackoff).toBe(0);
    expect(snapshot.pending.claimableNow).toBe(1);
  });
});

describe("ledger visibility", () => {
  maybe()("M. counts fills and the unattributed subset, and no economics", async () => {
    const id = await profile("ledger");
    await fillRow(id, "L-1", "OWNED_ORDER");
    await fillRow(id, "L-2", "UNATTRIBUTED");
    await fillRow(id, "L-3", "UNATTRIBUTED");
    await fillRow(id, "L-4", "AMBIGUOUS");

    const snapshot = await snapshotFor(id).capture({ now: NOW });
    if (snapshot.outcome !== "READY") throw new Error("unreachable");

    expect(snapshot.ledger.totalFills).toBe(4);
    // Exactly the UNATTRIBUTED enum value -- AMBIGUOUS is a different state and
    // is not folded in.
    expect(snapshot.ledger.unattributedFills).toBe(2);
    // No economics escape into an operational snapshot.
    expect(Object.keys(snapshot.ledger).sort()).toEqual(["totalFills", "unattributedFills"]);
    expect(JSON.stringify(snapshot)).not.toContain("realizedPnl");
    expect(JSON.stringify(snapshot)).not.toContain("quantity");
  });
});

describe("the snapshot only looks", () => {
  maybe()("O+P+Q. changes nothing, uses the one supplied instant, touches no exchange", async () => {
    const id = await profile("read-only");
    const base = 67_000 * DAY_MS;
    await windowRow(id, { startTimeMs: base, claimedAt: at(-1000), claimOwner: "w", attempts: 2 });
    await windowRow(id, { startTimeMs: base + DAY_MS, nextEligibleAt: at(60_000) });
    await windowRow(id, { startTimeMs: base + 2 * DAY_MS, status: "COMPLETE" });
    await fillRow(id, "RO-1", "OWNED_ORDER");

    const windowsBefore = await prisma!.exchangeFillIngestWindow.findMany({
      where: { executionProfileId: id },
      orderBy: { startTimeMs: "asc" },
    });
    const fillsBefore = await prisma!.exchangeFillLedger.findMany({
      where: { executionProfileId: id },
    });

    // Any outbound HTTP would be a defect; there is no Binance dependency to
    // inject here at all, so this also proves the service needs none.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const first = await snapshotFor(id).capture({ now: NOW });
      const second = await snapshotFor(id).capture({ now: NOW });

      // P. The same instant produces the same classifications, every time.
      expect(second).toEqual(first);
      if (first.outcome !== "READY") throw new Error("unreachable");
      expect(first.capturedAt).toEqual(NOW);
      expect(first.pending.activeLease).toBe(1);
      expect(first.pending.inBackoff).toBe(1);

      // A LATER instant reclassifies the same rows, proving `now` is what is
      // being used rather than the wall clock.
      const later = await snapshotFor(id).capture({
        now: at(INGEST_CLAIM_LEASE_MS + 120_000),
      });
      if (later.outcome !== "READY") throw new Error("unreachable");
      expect(later.pending.activeLease).toBe(0);
      expect(later.pending.staleLease).toBe(1);
      expect(later.pending.inBackoff).toBe(0);

      expect(fetchSpy).not.toHaveBeenCalled(); // Q
    } finally {
      fetchSpy.mockRestore();
    }

    // O. Byte-for-byte the same rows, including updatedAt.
    expect(
      await prisma!.exchangeFillIngestWindow.findMany({
        where: { executionProfileId: id },
        orderBy: { startTimeMs: "asc" },
      })
    ).toEqual(windowsBefore);
    expect(
      await prisma!.exchangeFillLedger.findMany({ where: { executionProfileId: id } })
    ).toEqual(fillsBefore);
  });
});
