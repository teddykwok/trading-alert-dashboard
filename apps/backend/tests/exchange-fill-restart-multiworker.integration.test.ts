import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase, resolveTestDatabase } from "./helpers/test-database";

/**
 * Restart and multi-worker durability, against a REAL Postgres.
 *
 * ## What a "process" is here
 *
 * Every correctness fact these tests rely on lives in the database, so a
 * process boundary is modelled as a SEPARATE PrismaClient plus a SEPARATE
 * service object graph. Nothing is shared between the two sides but the
 * database itself -- no JS references, no arrays, no mocked claim state. One
 * test additionally connects a throwaway client, does its work, disconnects it
 * and only then lets the other side look, which is as close to a real restart
 * as an in-process test can honestly get.
 *
 * ## What is NOT claimed
 *
 * The Slice 4 userTrades weight budget is PER BATCH and in memory. Two
 * concurrent batches may each spend their own ceiling, so the aggregate is the
 * sum. That is proven below rather than papered over: this is not a global
 * Binance IP rate limiter, and nothing here pretends it is.
 *
 * No exchange request is made anywhere: the one boundary the executor may use
 * is faked and counts its dispatches.
 */

const TAG = "restart-mw";
const SYMBOL = "RESTARTUSDT";
const SYMBOL_B = "RESTARTBUSDT";

const { prisma: clientA, available } = await connectTestDatabase();

const { ExchangeFillLedgerService } = await import(
  "../src/modules/execution/exchange-fill-ledger.service"
);
const {
  ExchangeFillIngestWindowService,
  INGEST_CLAIM_LEASE_MS,
  CLAIM_CANDIDATE_SCAN,
  StaleFillIngestClaimError,
} = await import("../src/modules/execution/exchange-fill-ingest-window.service");
const { ExchangeFillOneWindowExecutor, INGEST_RETRY_BACKOFF_MS } = await import(
  "../src/modules/execution/exchange-fill-one-window-executor.service"
);
const { ExchangeFillRootBootstrap } = await import(
  "../src/modules/execution/exchange-fill-root-bootstrap.service"
);
const { HistoricalFillBatchDriver, USER_TRADES_REQUEST_WEIGHT } = await import(
  "../src/modules/execution/exchange-fill-batch-driver.service"
);

const maybe = () => (available ? it : it.skip);

const DAY_MS = 86_400_000;
const NOW = new Date("2026-08-12T09:15:00.000Z");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

/** The second "process": its own client, its own pool, the same database. */
let clientB: PrismaClient;
let sequence = 0;

const boundTo = (executionProfileId: string) =>
  async () => ({ ok: true as const, context: { executionProfileId, environment: "TESTNET" } as never });

/** The exchange, faked at the one seam the executor may use, counting dispatches. */
function countingReader(answer: () => unknown = () => []) {
  const dispatches: string[] = [];
  return {
    dispatches,
    listRecentTrades: vi.fn(async () => {
      throw new Error("the executor must never use the retrying entry point");
    }),
    listRecentTradesOnce: vi.fn(async (symbol: string) => {
      dispatches.push(symbol);
      return answer() as never;
    }),
  };
}

/**
 * One whole service graph over one client -- the unit that a restart destroys
 * and reconstructs. Nothing is carried between graphs.
 */
function graph(
  client: PrismaClient,
  executionProfileId: string,
  reader: ReturnType<typeof countingReader> = countingReader()
) {
  const work = new ExchangeFillIngestWindowService(client);
  const ledger = new ExchangeFillLedgerService(client);
  const executor = new ExchangeFillOneWindowExecutor({
    prisma: client,
    reader,
    ledger,
    work,
    bindProfile: boundTo(executionProfileId),
  } as never);
  const bootstrap = new ExchangeFillRootBootstrap({
    prisma: client,
    work,
    bindProfile: boundTo(executionProfileId),
  } as never);
  const driver = new HistoricalFillBatchDriver({ bootstrap, executor });
  return { work, ledger, executor, bootstrap, driver, reader };
}

async function profile(alias: string) {
  sequence += 1;
  const row = await clientA!.executionProfile.create({
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

async function execution(executionProfileId: string, symbol: string) {
  sequence += 1;
  return clientA!.tradeExecution.create({
    data: {
      executionProfileId, symbol, direction: "LONG", positionSide: "LONG",
      selectedLookback: 200, plannedEntryPrice: "1.06", calculatedStopLoss: "1.01",
      executableStopLoss: "1.01", takeProfit: "1.09", riskBudgetUsd: "3",
      quantityRaw: "68.8", plannedQuantity: "68.8", quantityStepSize: "0.1",
      actualPlannedLoss: "3", unusedRiskBudget: "0", positionNotional: "72.9",
      targetIsolatedMargin: "7.3", maximumIsolatedMargin: "10", selectedLeverage: 10,
      estimatedInitialMargin: "7.3", liquidationBufferRatio: "0.5",
      decisionReasonCode: `${TAG}-${sequence}`,
    },
  });
}

/** One durable window written directly, so a test can place durable history. */
async function windowRow(
  executionProfileId: string,
  options: Record<string, unknown> & { startTimeMs: number }
) {
  const { startTimeMs, symbol = SYMBOL, endTimeMs, ...rest } = options;
  const row = await clientA!.exchangeFillIngestWindow.create({
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

const trade = (overrides: Record<string, unknown> = {}) => ({
  tradeId: "5001", orderId: "77001", symbol: SYMBOL, side: "SELL",
  positionSide: "LONG" as const, quantity: "68.8", price: "1.0925",
  quoteQuantity: "75.1640", realizedPnl: "2.24936", commission: "0.03006560",
  commissionAsset: "USDT", maker: false, timeMs: 1_757_000_000_000,
  ...overrides,
});

const rowOf = async (client: PrismaClient, id: string) =>
  client.exchangeFillIngestWindow.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  if (!clientA || !available) return;
  clientB = new PrismaClient({ datasources: { db: { url: resolveTestDatabase().url } } });
  await clientB.$queryRawUnsafe("select 1");
});

afterAll(async () => {
  if (!clientA) return;
  if (available) {
    const profiles = (
      await clientA.executionProfile.findMany({
        where: { accountIdentifier: { startsWith: TAG } },
        select: { id: true },
      })
    ).map((row) => row.id);
    await clientA.exchangeFillLedger.deleteMany({ where: { executionProfileId: { in: profiles } } });
    await clientA.exchangeFillIngestWindow.deleteMany({
      where: { executionProfileId: { in: profiles }, parentId: { not: null } },
    });
    await clientA.exchangeFillIngestWindow.deleteMany({
      where: { executionProfileId: { in: profiles } },
    });
    await clientA.executionEvent.deleteMany({
      where: { tradeExecution: { executionProfileId: { in: profiles } } },
    });
    await clientA.tradeExecution.deleteMany({ where: { executionProfileId: { in: profiles } } });
    await clientA.executionSafetyPolicy.deleteMany({
      where: { executionProfileId: { in: profiles } },
    });
    await clientA.executionProfile.deleteMany({ where: { id: { in: profiles } } });
  }
  if (clientB) await clientB.$disconnect();
  await clientA.$disconnect();
});

describe("restart recovers from durable state alone", () => {
  maybe()("A. a genuinely new process sees work an earlier one only seeded", async () => {
    const id = await profile("pending-survives");

    // A throwaway client that is CONNECTED, writes, and is then DISCONNECTED.
    // Whatever it knew dies with it.
    const ephemeral = new PrismaClient({ datasources: { db: { url: resolveTestDatabase().url } } });
    const seeded = await new ExchangeFillIngestWindowService(ephemeral).seedWindow(ephemeral, {
      executionProfileId: id,
      symbol: SYMBOL,
      startTimeMs: 40_000 * DAY_MS,
      endTimeMs: 40_000 * DAY_MS + DAY_MS - 1,
    });
    await ephemeral.$disconnect();

    // A different client, a different service graph, no initialization step.
    const claim = await graph(clientB, id).work.claimNextWindow(clientB, {
      executionProfileId: id,
      workerId: "worker-B",
      now: NOW,
    });

    expect(claim).not.toBeNull();
    expect(claim!.windowId).toBe(seeded.id);
    expect(claim!.attempt).toBe(1);
  });

  maybe()("B. an active lease still blocks a fresh process", async () => {
    const id = await profile("active-lease");
    await windowRow(id, { startTimeMs: 41_000 * DAY_MS });

    const owned = await graph(clientA!, id).work.claimNextWindow(clientA!, {
      executionProfileId: id,
      workerId: "worker-A",
      now: NOW,
    });
    expect(owned).not.toBeNull();

    // Graph A is discarded. A fresh graph on a different client looks half a
    // lease later and must see somebody else's live work.
    const stolen = await graph(clientB, id).work.claimNextWindow(clientB, {
      executionProfileId: id,
      workerId: "worker-B",
      now: at(INGEST_CLAIM_LEASE_MS / 2),
    });

    expect(stolen).toBeNull();
    const row = await rowOf(clientB, owned!.windowId);
    expect(row.claimOwner).toBe("worker-A");
    expect(row.attempts).toBe(1);
    expect(row.status).toBe("PENDING");
  });

  maybe()("C+D. a stale lease is reclaimed, and the old claimant is fenced out", async () => {
    const id = await profile("stale-then-zombie");
    await windowRow(id, { startTimeMs: 42_000 * DAY_MS });

    const graphA = graph(clientA!, id);
    const claimA = await graphA.work.claimNextWindow(clientA!, {
      executionProfileId: id,
      workerId: "worker-A",
      now: NOW,
    });
    expect(claimA!.attempt).toBe(1);

    // C. Strictly beyond the existing lease, a fresh process takes it over.
    const graphB = graph(clientB, id);
    const claimB = await graphB.work.claimNextWindow(clientB, {
      executionProfileId: id,
      workerId: "worker-B",
      now: at(INGEST_CLAIM_LEASE_MS + 60_000),
    });

    expect(claimB).not.toBeNull();
    expect(claimB!.windowId).toBe(claimA!.windowId); // the same row, not a new one
    expect(claimB!.attempt).toBe(2); // exactly one further generation
    const reclaimed = await rowOf(clientB, claimB!.windowId);
    expect(reclaimed.claimOwner).toBe("worker-B");
    expect(reclaimed.attempts).toBe(2);
    expect(reclaimed.claimedAt).toEqual(at(INGEST_CLAIM_LEASE_MS + 60_000));

    // D. The pre-restart process wakes up holding generation 1 and tries to
    // finish the work it thinks it owns.
    await expect(graphA.work.markComplete(clientA!, claimA!)).rejects.toBeInstanceOf(
      StaleFillIngestClaimError
    );
    const untouched = await rowOf(clientB, claimB!.windowId);
    expect(untouched.status).toBe("PENDING");
    expect(untouched.claimOwner).toBe("worker-B");
    expect(untouched.attempts).toBe(2);

    // The current owner's generation still works.
    await graphB.work.markComplete(clientB, claimB!);
    expect((await rowOf(clientB, claimB!.windowId)).status).toBe("COMPLETE");
  });

  maybe()("M. fencing survives two processes sharing one workerId", async () => {
    const id = await profile("same-worker-id");
    await windowRow(id, { startTimeMs: 43_000 * DAY_MS });
    const SHARED = "worker-shared";

    const graphA = graph(clientA!, id);
    const claimA = await graphA.work.claimNextWindow(clientA!, {
      executionProfileId: id,
      workerId: SHARED,
      now: NOW,
    });
    const graphB = graph(clientB, id);
    const claimB = await graphB.work.claimNextWindow(clientB, {
      executionProfileId: id,
      workerId: SHARED,
      now: at(INGEST_CLAIM_LEASE_MS + 60_000),
    });

    // `claimOwner` is identical, so it distinguishes nothing here. `attempts`
    // still does, and it is the token every fenced mutation must present.
    expect(claimA!.claimOwner).toBe(claimB!.claimOwner);
    expect(claimA!.attempt).toBe(1);
    expect(claimB!.attempt).toBe(2);

    await expect(graphA.work.markComplete(clientA!, claimA!)).rejects.toBeInstanceOf(
      StaleFillIngestClaimError
    );
    await graphB.work.markComplete(clientB, claimB!);
    expect((await rowOf(clientB, claimB!.windowId)).status).toBe("COMPLETE");
  });
});

describe("durable transitions outlive the process that made them", () => {
  maybe()("E. a persisted backoff still gates a fresh process, then releases it", async () => {
    const id = await profile("retry-durable");
    await windowRow(id, { startTimeMs: 44_000 * DAY_MS });

    const graphA = graph(clientA!, id);
    const claimA = await graphA.work.claimNextWindow(clientA!, {
      executionProfileId: id,
      workerId: "worker-A",
      now: NOW,
    });
    // The REAL retry transition, not a hand-written row.
    const settled = await graphA.work.recordRetryableFailure(clientA!, claimA!, {
      reasonCode: "SERVER",
      sanitizedError: "upstream refused",
      nextEligibleAt: at(INGEST_RETRY_BACKOFF_MS),
    });
    expect(settled).toBe("PENDING");
    const created = (await rowOf(clientA!, claimA!.windowId)).createdAt;

    const graphB = graph(clientB, id);
    // Before the backoff expires, a brand new process cannot pick it up.
    expect(
      await graphB.work.claimNextWindow(clientB, {
        executionProfileId: id,
        workerId: "worker-B",
        now: at(INGEST_RETRY_BACKOFF_MS - 1000),
      })
    ).toBeNull();

    // After it expires, the same durable row comes back -- same id, same
    // createdAt, so its place in the fairness queue was never rewritten.
    const claimB = await graphB.work.claimNextWindow(clientB, {
      executionProfileId: id,
      workerId: "worker-B",
      now: at(INGEST_RETRY_BACKOFF_MS),
    });
    expect(claimB).not.toBeNull();
    expect(claimB!.windowId).toBe(claimA!.windowId);
    expect(claimB!.attempt).toBe(2);
    expect((await rowOf(clientB, claimB!.windowId)).createdAt).toEqual(created);
  });

  for (const status of [
    "COMPLETE",
    "SPLIT",
    "INCOMPLETE_SKIPPED_ROWS",
    "SATURATED_SINGLE_MILLISECOND",
    "ABANDONED",
  ] as const) {
    maybe()(`F. ${status} work is never reclaimed by a fresh process`, async () => {
      const id = await profile(`terminal-${status}`);
      await windowRow(id, { startTimeMs: 45_000 * DAY_MS, status, attempts: 1 });

      const claim = await graph(clientB, id).work.claimNextWindow(clientB, {
        executionProfileId: id,
        workerId: "worker-B",
        now: at(10 * INGEST_CLAIM_LEASE_MS),
      });

      expect(claim).toBeNull();
    });
  }

  maybe()("G. a split survives: parent terminal, children ordinary work", async () => {
    const id = await profile("split-survives");
    const start = 46_000 * DAY_MS;
    const end = start + DAY_MS - 1;
    const graphA = graph(clientA!, id);
    await graphA.work.seedWindow(clientA!, {
      executionProfileId: id,
      symbol: SYMBOL,
      startTimeMs: start,
      endTimeMs: end,
    });
    const parent = await graphA.work.claimNextWindow(clientA!, {
      executionProfileId: id,
      workerId: "worker-A",
      now: NOW,
    });
    const mid = start + Math.floor((end - start) / 2);
    // The REAL split transition.
    await graphA.work.splitWindow(parent!, {
      left: { startTimeMs: start, endTimeMs: mid },
      right: { startTimeMs: mid + 1, endTimeMs: end },
    });

    // Fresh process, different client.
    const graphB = graph(clientB, id);
    const rows = await clientB.exchangeFillIngestWindow.findMany({
      where: { executionProfileId: id },
      orderBy: [{ parentId: "asc" }, { startTimeMs: "asc" }],
    });

    expect(rows).toHaveLength(3); // no duplicate children, no re-split
    const parentRow = rows.find((row) => row.id === parent!.windowId)!;
    expect(parentRow.status).toBe("SPLIT");
    const children = rows.filter((row) => row.parentId === parent!.windowId);
    expect(children).toHaveLength(2);
    for (const child of children) expect(child.status).toBe("PENDING");
    // They tile the parent exactly -- no gap, no overlap.
    expect(Number(children[0]!.startTimeMs)).toBe(start);
    expect(Number(children[1]!.endTimeMs)).toBe(end);
    expect(Number(children[1]!.startTimeMs)).toBe(Number(children[0]!.endTimeMs) + 1);

    // Both children are ordinary claimable work for the new process, oldest
    // interval first per the Slice 3 ordering.
    const first = await graphB.work.claimNextWindow(clientB, {
      executionProfileId: id, workerId: "worker-B", now: at(60_000),
    });
    const second = await graphB.work.claimNextWindow(clientB, {
      executionProfileId: id, workerId: "worker-B", now: at(60_000),
    });
    expect([first!.windowId, second!.windowId]).toEqual([children[0]!.id, children[1]!.id]);
    expect(
      await graphB.work.claimNextWindow(clientB, {
        executionProfileId: id, workerId: "worker-B", now: at(60_000),
      })
    ).toBeNull();
  });
});

describe("the bounded driver resumes across instances", () => {
  maybe()("H. a new instance continues durable progress and repeats none of it", async () => {
    const id = await profile("driver-resume");
    await execution(id, SYMBOL);

    // Instance A: one window only, then the whole graph is discarded.
    const graphA = graph(clientA!, id, countingReader());
    const first = await graphA.driver.runHistoricalFillBatch({
      workerId: "worker-A", now: NOW, horizonDays: 3, maxWindows: 1, maxUserTradesWeight: 100,
    });
    expect(first).toMatchObject({
      outcome: "MAX_WINDOWS_REACHED",
      executionInvocations: 1,
      userTradesWeightUsed: USER_TRADES_REQUEST_WEIGHT,
    });
    expect(first.bootstrap).toMatchObject({ createdCount: 3, alreadyCompatibleCount: 0 });
    expect(graphA.reader.dispatches).toHaveLength(1);

    // Instance B: fresh client, fresh services, no knowledge of A.
    const graphB = graph(clientB, id, countingReader());
    const second = await graphB.driver.runHistoricalFillBatch({
      workerId: "worker-B", now: NOW, horizonDays: 3, maxWindows: 10, maxUserTradesWeight: 100,
    });

    // Bootstrap is idempotent: the three roots already exist, none recreated.
    expect(second.bootstrap).toMatchObject({
      createdCount: 0,
      alreadyCompatibleCount: 3,
      raceReconciledCount: 0,
    });
    // Only the two windows A left behind were worked, then the queue emptied.
    expect(second.outcome).toBe("NO_WORK");
    expect(graphB.reader.dispatches).toHaveLength(2);
    expect(second.outcomes.COMPLETE).toBe(2);

    const rows = await clientB.exchangeFillIngestWindow.findMany({
      where: { executionProfileId: id },
    });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe("COMPLETE");
      expect(row.attempts).toBe(1); // nothing was worked twice
      // The batch instant is weeks in the past; the lease timestamps are not.
      // A driver that forwarded its frozen `now` into the executor would
      // backdate every claim here, which is what makes a live lease look
      // expired to the next process.
      expect(row.lastAttemptAt!.getTime()).toBeGreaterThan(NOW.getTime());
      expect(Date.now() - row.lastAttemptAt!.getTime()).toBeLessThan(INGEST_CLAIM_LEASE_MS);
    }
  });

  maybe()("a fresh instance still cannot exceed its own userTrades budget", async () => {
    const id = await profile("driver-budget");
    await execution(id, SYMBOL);

    // Ten window slots, but only one dispatch paid for. The budget, not the
    // window bound, must be what stops the pass.
    const graphB = graph(clientB, id, countingReader());
    const result = await graphB.driver.runHistoricalFillBatch({
      workerId: "worker-B",
      now: NOW,
      horizonDays: 4,
      maxWindows: 10,
      maxUserTradesWeight: USER_TRADES_REQUEST_WEIGHT,
    });

    expect(result.outcome).toBe("USER_TRADES_WEIGHT_BUDGET_EXHAUSTED");
    expect(result.executionInvocations).toBe(1);
    expect(result.userTradesWeightUsed).toBe(USER_TRADES_REQUEST_WEIGHT);
    expect(result.userTradesWeightRemaining).toBe(0);
    expect(graphB.reader.dispatches).toHaveLength(1);

    // Three of the four roots are still durable, untouched work.
    const pending = await clientB.exchangeFillIngestWindow.count({
      where: { executionProfileId: id, status: "PENDING" },
    });
    expect(pending).toBe(3);
  });
});

describe("two processes on one profile", () => {
  maybe()("I. concurrent bootstraps of the same horizon converge", async () => {
    const id = await profile("concurrent-bootstrap");
    await execution(id, SYMBOL);
    await execution(id, SYMBOL_B);

    const [a, b] = await Promise.all([
      graph(clientA!, id).bootstrap.bootstrapHistoricalRoots({ now: NOW, horizonDays: 4 }),
      graph(clientB, id).bootstrap.bootstrapHistoricalRoots({ now: NOW, horizonDays: 4 }),
    ]);

    // Both succeed. Neither reports a structural collision for what is, by
    // construction, the IDENTICAL canonical workset.
    expect(a.outcome).toBe("BOOTSTRAPPED");
    expect(b.outcome).toBe("BOOTSTRAPPED");
    if (a.outcome !== "BOOTSTRAPPED" || b.outcome !== "BOOTSTRAPPED") throw new Error("unreachable");
    expect(a.expectedRootCount).toBe(8); // 2 symbols x 4 completed days
    expect(b.expectedRootCount).toBe(8);
    expect(a.createdCount + a.alreadyCompatibleCount + a.raceReconciledCount).toBe(8);
    expect(b.createdCount + b.alreadyCompatibleCount + b.raceReconciledCount).toBe(8);

    // Exactly one durable row per canonical identity: no duplicates, and no
    // second overlapping tree.
    const rows = await clientB.exchangeFillIngestWindow.findMany({
      where: { executionProfileId: id },
      select: { symbol: true, startTimeMs: true, endTimeMs: true, parentId: true },
    });
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.parentId === null)).toBe(true);
    const keys = rows.map((row) => `${row.symbol}:${row.startTimeMs}:${row.endTimeMs}`);
    expect(new Set(keys).size).toBe(8);
  });
});

describe("two workers racing durable work", () => {
  maybe()("J. one eligible row yields one owner and one dispatch", async () => {
    const id = await profile("race-one-row");
    await execution(id, SYMBOL);
    await graph(clientA!, id).bootstrap.bootstrapHistoricalRoots({ now: NOW, horizonDays: 1 });

    const graphA = graph(clientA!, id, countingReader());
    const graphB = graph(clientB, id, countingReader());
    const [a, b] = await Promise.all([
      graphA.driver.runHistoricalFillBatch({
        workerId: "worker-A", now: NOW, horizonDays: 1, maxWindows: 1, maxUserTradesWeight: 5,
      }),
      graphB.driver.runHistoricalFillBatch({
        workerId: "worker-B", now: NOW, horizonDays: 1, maxWindows: 1, maxUserTradesWeight: 5,
      }),
    ]);

    // Exactly one exchange request between the two of them.
    expect(graphA.reader.dispatches.length + graphB.reader.dispatches.length).toBe(1);

    // One driver worked the window; the other found nothing and was refunded.
    expect([a.outcome, b.outcome].sort()).toEqual(["MAX_WINDOWS_REACHED", "NO_WORK"]);
    const worked = [a, b].find((r) => r.outcome === "MAX_WINDOWS_REACHED")!;
    const idle = [a, b].find((r) => r.outcome === "NO_WORK")!;
    expect(worked.userTradesWeightUsed).toBe(USER_TRADES_REQUEST_WEIGHT);
    expect(idle.userTradesWeightUsed).toBe(0);

    // One row, one generation, one owner, one durable transition.
    const rows = await clientB.exchangeFillIngestWindow.findMany({
      where: { executionProfileId: id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(1); // exactly one generation was burned
    expect(rows[0]!.status).toBe("COMPLETE");
    // A terminal transition clears the lease, so the winner's name is gone by
    // design. The single generation above, and the single dispatch, are what
    // prove exactly one worker ever owned it.
    expect(rows[0]!.claimOwner).toBeNull();
    expect(rows[0]!.claimedAt).toBeNull();
  });

  maybe()("K+L. two eligible rows split between workers, with independent budgets", async () => {
    const id = await profile("race-two-rows");
    await execution(id, SYMBOL);
    await graph(clientA!, id).bootstrap.bootstrapHistoricalRoots({ now: NOW, horizonDays: 2 });

    const graphA = graph(clientA!, id, countingReader());
    const graphB = graph(clientB, id, countingReader());
    const [a, b] = await Promise.all([
      graphA.driver.runHistoricalFillBatch({
        workerId: "worker-A", now: NOW, horizonDays: 2, maxWindows: 1, maxUserTradesWeight: 5,
      }),
      graphB.driver.runHistoricalFillBatch({
        workerId: "worker-B", now: NOW, horizonDays: 2, maxWindows: 1, maxUserTradesWeight: 5,
      }),
    ]);

    // K. Each driver honoured ITS OWN ceiling.
    for (const result of [a, b]) {
      expect(result.executionInvocations).toBeLessThanOrEqual(1);
      expect(result.userTradesWeightUsed).toBeLessThanOrEqual(5);
      expect(result.userTradesWeightBudget).toBe(5);
    }

    // L. The aggregate is the SUM of two independent budgets. This is the
    // documented limitation, proven rather than hidden: there is no shared
    // counter anywhere, so two concurrent batches of 5 legitimately spend 10.
    const aggregate = a.userTradesWeightUsed + b.userTradesWeightUsed;
    expect(graphA.reader.dispatches.length + graphB.reader.dispatches.length).toBe(2);
    expect(aggregate).toBe(2 * USER_TRADES_REQUEST_WEIGHT);
    expect(aggregate).toBe(10);
    expect(aggregate).toBeGreaterThan(5);

    // Two DISTINCT rows, one generation each, no duplicate ownership.
    const rows = await clientB.exchangeFillIngestWindow.findMany({
      where: { executionProfileId: id },
      orderBy: { startTimeMs: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    for (const row of rows) {
      expect(row.status).toBe("COMPLETE");
      expect(row.attempts).toBe(1); // one generation each, never two
      expect(row.claimOwner).toBeNull(); // terminal transitions release the lease
    }
    // The work really was SPLIT between the two processes: each one dispatched
    // for exactly one window rather than one worker taking both.
    expect(graphA.reader.dispatches).toHaveLength(1);
    expect(graphB.reader.dispatches).toHaveLength(1);
  });
});

describe("economic facts survive restart without duplicating", () => {
  maybe()("N. replaying the same fill from a fresh process is a no-op", async () => {
    const id = await profile("ledger-replay");
    await execution(id, SYMBOL);
    const fill = trade({ tradeId: "990001", orderId: "990100" });

    // Process A ingests one fill through the real ledger.
    const firstReport = await graph(clientA!, id).ledger.ingestUserTrades(id, [fill]);
    expect(firstReport).toMatchObject({ inserted: 1, duplicates: 0, skipped: 0 });

    // A fresh process, fresh client, replays the identical exchange fact --
    // which is exactly what a restart mid-window causes.
    const replayReport = await graph(clientB, id).ledger.ingestUserTrades(id, [fill]);
    expect(replayReport).toMatchObject({ inserted: 0, duplicates: 1, skipped: 0 });

    // The natural identity holds: one durable economic row, not two.
    const rows = await clientB.exchangeFillLedger.findMany({
      where: { executionProfileId: id, exchangeTradeId: "990001" },
    });
    expect(rows).toHaveLength(1);
  });
});

describe("bounded candidate scan is contention, not starvation", () => {
  maybe()("a worker beaten on every scanned candidate finds work on its next attempt", async () => {
    const id = await profile("candidate-scan");
    const base = 50_000 * DAY_MS;
    // One more eligible row than a single scan will look at.
    const total = CLAIM_CANDIDATE_SCAN + 1;
    for (let i = 0; i < total; i += 1) {
      await windowRow(id, { startTimeMs: base + i * DAY_MS, createdAt: at(-(total - i) * 60_000) });
    }

    const work = graph(clientA!, id).work;
    // Drain exactly the rows one scan can see, so the next attempt's first
    // scan is entirely made of rows this "worker" cannot have.
    const drained: string[] = [];
    for (let i = 0; i < CLAIM_CANDIDATE_SCAN; i += 1) {
      const claim = await work.claimNextWindow(clientA!, {
        executionProfileId: id, workerId: `filler-${i}`, now: NOW,
      });
      drained.push(claim!.windowId);
    }
    expect(drained).toHaveLength(CLAIM_CANDIDATE_SCAN);

    // A fresh independent process now re-reads the queue and finds the row
    // that lay beyond the earlier scan. The bound costs a round trip under
    // contention; it never removes work from the queue.
    const late = await graph(clientB, id).work.claimNextWindow(clientB, {
      executionProfileId: id, workerId: "worker-late", now: NOW,
    });

    expect(late).not.toBeNull();
    expect(drained).not.toContain(late!.windowId);
    expect(CLAIM_CANDIDATE_SCAN).toBe(5);
  });
});
