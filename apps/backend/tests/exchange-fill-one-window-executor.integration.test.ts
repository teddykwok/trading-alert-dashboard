import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * One bounded ingestion attempt, against a REAL Postgres and a FAKE exchange.
 *
 * Every claim here is about what survives a crash, a rollback or an expired
 * lease, so none of it can be proven against a mocked database. Nothing in this
 * file or in the code under test opens a network socket: the reader is a typed
 * fake, and the only Binance types involved are the DTOs the normalizer already
 * produces.
 */

const TAG = "fill-executor";
const SYMBOL = "EXECUSDT";
const OTHER_SYMBOL = "EXECBTCUSDT";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { USER_TRADES_MAX_LIMIT } = await import("../src/modules/binance/user-trades-window-planner");
const { BinanceError } = await import("../src/modules/binance/binance.errors");

const {
  ExchangeFillLedgerService,
  FillLedgerConflictError,
  FillLedgerAttributionConflictError,
  FillLedgerInsertRaceError,
  FillLedgerRaceUnresolvedError,
} = await import("../src/modules/execution/exchange-fill-ledger.service");

const {
  ExchangeFillIngestWindowService,
  MAX_INGEST_ATTEMPTS,
  INGEST_CLAIM_LEASE_MS,
} = await import("../src/modules/execution/exchange-fill-ingest-window.service");

const {
  ExchangeFillOneWindowExecutor,
  INGEST_RETRY_BACKOFF_MS,
  FILL_INGEST_EXECUTION_REASON,
  FillIngestPlannerInvariantError,
} = await import("../src/modules/execution/exchange-fill-one-window-executor.service");

const maybe = () => (available ? it : it.skip);

type Executor = InstanceType<typeof ExchangeFillOneWindowExecutor>;
let ledger: InstanceType<typeof ExchangeFillLedgerService>;
let work: InstanceType<typeof ExchangeFillIngestWindowService>;
let sequence = 0;

/** One userTrades row, shaped exactly as the normalizer produces it. */
function trade(overrides: Record<string, unknown> = {}) {
  return {
    tradeId: "5001",
    orderId: "77001",
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
    timeMs: 1_757_000_000_000,
    ...overrides,
  };
}

/**
 * The exchange, faked at the one seam the executor is allowed to use.
 *
 * Carries BOTH entry points so a test can prove the retrying one is never
 * touched -- the executor's own dependency type only names the single-dispatch
 * method, and this is the behavioural half of that guarantee.
 */
function fakeReader(answer: () => unknown) {
  const calls: Array<{ symbol: string; options: Record<string, unknown> }> = [];
  const listRecentTrades = vi.fn(async () => {
    throw new Error("the executor must never use the retrying entry point");
  });
  const listRecentTradesOnce = vi.fn(async (symbol: string, options: Record<string, unknown>) => {
    calls.push({ symbol, options });
    const result = answer();
    if (result instanceof Error) throw result;
    return result as never;
  });
  return { listRecentTrades, listRecentTradesOnce, calls };
}

async function profile(alias: string) {
  const row = await prisma!.executionProfile.create({
    data: {
      name: `${TAG} ${alias}`,
      accountIdentifier: `${TAG}-${alias}`,
      environment: "TESTNET",
      isEnabled: false,
    },
  });
  return row.id;
}

/** A bound context for a profile the test created. */
const boundTo = (executionProfileId: string) =>
  async () => ({
    ok: true as const,
    context: { executionProfileId, environment: "TESTNET" } as never,
  });

function executorFor(
  executionProfileId: string,
  reader: ReturnType<typeof fakeReader>,
  overrides: Record<string, unknown> = {}
): Executor {
  return new ExchangeFillOneWindowExecutor({
    prisma: prisma!,
    reader,
    ledger,
    work,
    bindProfile: boundTo(executionProfileId),
    ...overrides,
  } as never);
}

function interval(spanMs = 86_400_000 - 1) {
  sequence += 1;
  return { startTimeMs: sequence * 10_000_000_000, endTimeMs: sequence * 10_000_000_000 + spanMs };
}

const windowsFor = async (executionProfileId: string) =>
  prisma!.exchangeFillIngestWindow.findMany({
    where: { executionProfileId },
    orderBy: [{ startTimeMs: "asc" }, { endTimeMs: "asc" }],
  });

const fillsFor = async (executionProfileId: string) =>
  prisma!.exchangeFillLedger.findMany({ where: { executionProfileId } });

const rowOf = async (id: string) =>
  prisma!.exchangeFillIngestWindow.findUniqueOrThrow({ where: { id } });

/** A profile with one seeded window, ready to be claimed. */
async function seeded(alias: string, bounds = interval(), symbol = SYMBOL) {
  const id = await profile(alias);
  const window = await work.seedWindow(prisma!, { executionProfileId: id, symbol, ...bounds });
  return { id, windowId: window.id, bounds };
}

/** Ages a lease past the cutoff without waiting for wall-clock time. */
const expireLease = async (id: string) =>
  prisma!.exchangeFillIngestWindow.update({
    where: { id },
    data: { claimedAt: new Date(Date.now() - INGEST_CLAIM_LEASE_MS - 60_000) },
  });

beforeAll(async () => {
  if (!prisma || !available) return;
  ledger = new ExchangeFillLedgerService(prisma);
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
    await prisma.exchangeFillLedger.deleteMany({ where: { executionProfileId: { in: profiles } } });
    await prisma.exchangeFillIngestWindow.deleteMany({
      where: { executionProfileId: { in: profiles }, parentId: { not: null } },
    });
    await prisma.exchangeFillIngestWindow.deleteMany({ where: { executionProfileId: { in: profiles } } });
    await prisma.executionProfile.deleteMany({ where: { id: { in: profiles } } });
  }
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Claiming and the one request
// ---------------------------------------------------------------------------

describe("one invocation, one window, one request", () => {
  maybe()("A. nothing eligible means NO_WORK and no exchange call at all", async () => {
    const id = await profile("no-work");
    const reader = fakeReader(() => []);

    const result = await executorFor(id, reader).executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("NO_WORK");
    expect(reader.listRecentTradesOnce).not.toHaveBeenCalled();
    expect(await fillsFor(id)).toEqual([]);
  });

  maybe()("B. a binding failure claims nothing and calls nothing", async () => {
    // A configuration failure is not evidence about a window, so it must not
    // spend one of the window's five attempts.
    const { id, windowId } = await seeded("binding-failure");
    const reader = fakeReader(() => []);
    const executor = executorFor(id, reader, {
      bindProfile: async () => ({ ok: false, reasonCode: "PROFILE_ENVIRONMENT_MISMATCH", message: "no" }),
    });

    const result = await executor.executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("PROFILE_UNAVAILABLE");
    expect(result.reasonCode).toBe("PROFILE_ENVIRONMENT_MISMATCH");
    expect(reader.listRecentTradesOnce).not.toHaveBeenCalled();
    const row = await rowOf(windowId);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(0);
    expect(row.claimedAt).toBeNull();
  });

  maybe()("C. work belonging to another profile is never claimed", async () => {
    const mine = await profile("scope-mine");
    const theirs = await seeded("scope-theirs");
    const reader = fakeReader(() => []);

    const result = await executorFor(mine, reader).executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("NO_WORK");
    expect((await rowOf(theirs.windowId)).attempts).toBe(0);
  });

  maybe()("D/E/AC/AD. exactly one single-dispatch call, with the claim's own bounds", async () => {
    const { id, bounds } = await seeded("request-shape");
    const reader = fakeReader(() => []);

    await executorFor(id, reader).executeOne({ workerId: "worker-a" });

    expect(reader.listRecentTradesOnce).toHaveBeenCalledTimes(1);
    // AD: the retrying entry point is never touched.
    expect(reader.listRecentTrades).not.toHaveBeenCalled();
    expect(reader.calls[0].symbol).toBe(SYMBOL);
    expect(reader.calls[0].options).toEqual({
      startTimeMs: bounds.startTimeMs,
      endTimeMs: bounds.endTimeMs,
      limit: USER_TRADES_MAX_LIMIT,
    });
    // No orderId, no fromId, no pagination knob.
    expect(Object.keys(reader.calls[0].options).sort()).toEqual(["endTimeMs", "limit", "startTimeMs"]);
  });
});

// ---------------------------------------------------------------------------
// What a page proves
// ---------------------------------------------------------------------------

describe("a short page proves the interval", () => {
  maybe()("F/Q. an empty page is COMPLETE with no ledger rows", async () => {
    const { id, windowId } = await seeded("empty-page");
    const reader = fakeReader(() => []);

    const result = await executorFor(id, reader).executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("COMPLETE");
    expect(result.returnedRowCount).toBe(0);
    expect(result.ledger).toMatchObject({ inserted: 0, duplicates: 0, skipped: 0 });
    expect((await rowOf(windowId)).status).toBe("COMPLETE");
    expect(await fillsFor(id)).toEqual([]);
  });

  maybe()("G. a short valid page commits the fills AND the completion together", async () => {
    const { id, windowId } = await seeded("short-page");
    const reader = fakeReader(() => [trade({ tradeId: "6001" }), trade({ tradeId: "6002" })]);

    const result = await executorFor(id, reader).executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("COMPLETE");
    expect(result.ledger).toMatchObject({ inserted: 2, duplicates: 0, skipped: 0 });
    const rows = await fillsFor(id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.exchangeTradeId).sort()).toEqual(["6001", "6002"]);
    const window = await rowOf(windowId);
    expect(window.status).toBe("COMPLETE");
    expect(window.claimedAt).toBeNull();
    expect(window.claimOwner).toBeNull();
  });

  maybe()("H. a short page with an unusable row is a KNOWN GAP, not COMPLETE", async () => {
    // The good rows stay recorded; only the claim of wholeness is withheld.
    const { id, windowId } = await seeded("short-page-skipped");
    const reader = fakeReader(() => [
      trade({ tradeId: "6101" }),
      trade({ tradeId: null }),
      trade({ tradeId: "6102" }),
    ]);

    const result = await executorFor(id, reader).executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("INCOMPLETE_SKIPPED_ROWS");
    expect(result.ledger).toMatchObject({ inserted: 2, duplicates: 0, skipped: 1 });
    expect(await fillsFor(id)).toHaveLength(2);
    expect((await rowOf(windowId)).status).toBe("INCOMPLETE_SKIPPED_ROWS");
    // AB: a known gap creates no children.
    expect(await prisma!.exchangeFillIngestWindow.count({ where: { parentId: windowId } })).toBe(0);
  });
});

describe("a full page subdivides the interval", () => {
  /** A saturated page whose rows collapse to ONE durable fill. */
  const identicalFullPage = () => Array.from({ length: USER_TRADES_MAX_LIMIT }, () => trade({ tradeId: "7001" }));

  maybe()("I/Z. 1000 occurrences of ONE fill still SPLIT the parent", async () => {
    // The strongest regression in the slice. If the executor measured fullness
    // by inserted rows it would see 1, call the page short, and mark an
    // interval proven that was truncated at a thousand.
    const { id, windowId, bounds } = await seeded("full-page");
    const reader = fakeReader(identicalFullPage);

    const result = await executorFor(id, reader).executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("SPLIT");
    expect(result.returnedRowCount).toBe(USER_TRADES_MAX_LIMIT);
    expect(result.ledger).toMatchObject({ inserted: 1, duplicates: 999, skipped: 0 });
    expect(await fillsFor(id)).toHaveLength(1);

    const parent = await rowOf(windowId);
    expect(parent.status).toBe("SPLIT");

    const children = await prisma!.exchangeFillIngestWindow.findMany({
      where: { parentId: windowId },
      orderBy: { startTimeMs: "asc" },
    });
    expect(children).toHaveLength(2);
    const mid = bounds.startTimeMs + Math.floor((bounds.endTimeMs - bounds.startTimeMs) / 2);
    expect(children.map((c) => [Number(c.startTimeMs), Number(c.endTimeMs)])).toEqual([
      [bounds.startTimeMs, mid],
      [mid + 1, bounds.endTimeMs],
    ]);
    for (const child of children) {
      expect(child.status).toBe("PENDING");
      expect(child.attempts).toBe(0);
      expect(child.symbol).toBe(SYMBOL);
      expect(child.executionProfileId).toBe(id);
    }
  });

  maybe()("AB. the children are NOT executed by the same invocation", async () => {
    const { id, windowId } = await seeded("no-recursion");
    const reader = fakeReader(identicalFullPage);

    await executorFor(id, reader).executeOne({ workerId: "worker-a" });

    // One request, for the parent only. The children are ordinary pending work.
    expect(reader.listRecentTradesOnce).toHaveBeenCalledTimes(1);
    const children = await prisma!.exchangeFillIngestWindow.findMany({ where: { parentId: windowId } });
    expect(children.every((child) => child.status === "PENDING" && child.attempts === 0)).toBe(true);
  });

  maybe()("J/AA. a full page containing an unusable row is still SPLIT", async () => {
    // The parent is proof of SUBDIVISION, not of economic completeness. Its
    // children re-query the same milliseconds and whichever leaf finally
    // returns a short page carrying that row records the hole, at the narrowest
    // interval that isolates it.
    const { id, windowId } = await seeded("full-page-skipped");
    const page = [
      ...Array.from({ length: USER_TRADES_MAX_LIMIT - 1 }, () => trade({ tradeId: "7101" })),
      trade({ tradeId: null }),
    ];
    const reader = fakeReader(() => page);

    const result = await executorFor(id, reader).executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("SPLIT");
    expect(result.ledger).toMatchObject({ inserted: 1, duplicates: 998, skipped: 1 });
    // AA: conservation across every path.
    const report = result.ledger!;
    expect(report.inserted + report.duplicates + report.skipped).toBe(USER_TRADES_MAX_LIMIT);
    expect(report.attributionEnriched).toBeLessThanOrEqual(report.duplicates);

    expect((await rowOf(windowId)).status).toBe("SPLIT");
    expect(await prisma!.exchangeFillIngestWindow.count({ where: { parentId: windowId } })).toBe(2);
  });

  maybe()("K. a full page inside ONE millisecond is a terminal known gap", async () => {
    const bounds = interval(0);
    expect(bounds.startTimeMs).toBe(bounds.endTimeMs);
    const { id, windowId } = await seeded("single-ms", bounds);
    const reader = fakeReader(identicalFullPage);

    const result = await executorFor(id, reader).executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("SATURATED_SINGLE_MILLISECOND");
    // Even with nothing skipped, this is never COMPLETE.
    expect(result.ledger).toMatchObject({ skipped: 0 });
    expect((await rowOf(windowId)).status).toBe("SATURATED_SINGLE_MILLISECOND");
    expect(await fillsFor(id)).toHaveLength(1);
    expect(await prisma!.exchangeFillIngestWindow.count({ where: { parentId: windowId } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pages that are not answers
// ---------------------------------------------------------------------------

describe("a page that contradicts the request is refused whole", () => {
  maybe()("L. a foreign symbol abandons the window and writes nothing", async () => {
    // Inserting it would put another symbol's economics in; filtering it out
    // would turn a broken answer into a short page and mark THIS window proven.
    const { id, windowId } = await seeded("symbol-mismatch");
    const reader = fakeReader(() => [
      trade({ tradeId: "8001" }),
      trade({ tradeId: "8002", symbol: OTHER_SYMBOL }),
    ]);

    const result = await executorFor(id, reader).executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("ABANDONED");
    expect(result.reasonCode).toBe(FILL_INGEST_EXECUTION_REASON.SYMBOL_MISMATCH);
    expect(reader.listRecentTradesOnce).toHaveBeenCalledTimes(1);
    // Not even the well-formed row from the same page.
    expect(await fillsFor(id)).toEqual([]);
    const window = await rowOf(windowId);
    expect(window.status).toBe("ABANDONED");
    expect(window.lastErrorCode).toBe(FILL_INGEST_EXECUTION_REASON.SYMBOL_MISMATCH);
    expect(await prisma!.exchangeFillIngestWindow.count({ where: { parentId: windowId } })).toBe(0);
  });

  maybe()("a NULL symbol is unusable, not foreign, and stays the ledger's business", async () => {
    // Nothing is fabricated into an unreadable row; it is skipped as incomplete
    // exactly as it would be anywhere else.
    const { id, windowId } = await seeded("symbol-null");
    const reader = fakeReader(() => [trade({ tradeId: "8101" }), trade({ tradeId: "8102", symbol: null })]);

    const result = await executorFor(id, reader).executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("INCOMPLETE_SKIPPED_ROWS");
    expect(result.ledger).toMatchObject({ inserted: 1, skipped: 1 });
    expect((await rowOf(windowId)).status).toBe("INCOMPLETE_SKIPPED_ROWS");
  });

  maybe()("M. more rows than the limit allowed abandons the window", async () => {
    // The endpoint broke its own contract. The planner refuses the observation
    // and this is the one refusal a real response can produce.
    const { id, windowId } = await seeded("row-count-exceeds");
    const reader = fakeReader(() =>
      Array.from({ length: USER_TRADES_MAX_LIMIT + 1 }, (_, index) => trade({ tradeId: `9${index}` }))
    );

    const result = await executorFor(id, reader).executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("ABANDONED");
    expect(result.reasonCode).toBe(FILL_INGEST_EXECUTION_REASON.ROW_COUNT_EXCEEDS_LIMIT);
    expect(await fillsFor(id)).toEqual([]);
    expect((await rowOf(windowId)).status).toBe("ABANDONED");
    expect(await prisma!.exchangeFillIngestWindow.count({ where: { parentId: windowId } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Request failures
// ---------------------------------------------------------------------------

describe("a failed request never touches the ledger", () => {
  const binance = (kind: string) =>
    new BinanceError({ kind: kind as never, message: `Binance ${kind}`, endpoint: "userTrades" });

  const RETRYABLE = [
    "RATE_LIMIT", "SERVER", "NETWORK", "TIMEOUT", "TIMESTAMP",
    "IP_BANNED", "IP_RESTRICTED", "AUTH", "PERMISSION", "MISSING_CREDENTIALS",
    "FUTURES_NOT_ENABLED", "DISABLED", "READ_ONLY_VIOLATION", "MALFORMED_RESPONSE",
  ];
  const TERMINAL = ["REQUEST_INVALID", "UNSUPPORTED_SYMBOL", "ORDER_NOT_FOUND", "ORDER_REJECTED"];

  maybe()("N. every reviewed retryable kind schedules a durable backoff", async () => {
    for (const kind of RETRYABLE) {
      const { id, windowId } = await seeded(`retry-${kind}`);
      const reader = fakeReader(() => binance(kind));
      const now = new Date();

      const result = await executorFor(id, reader).executeOne({ workerId: "worker-a", now });

      expect(result.outcome).toBe("RETRY_SCHEDULED");
      expect(result.reasonCode).toBe(kind);
      expect(await fillsFor(id)).toEqual([]);
      const row = await rowOf(windowId);
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(1);
      expect(row.claimedAt).toBeNull();
      expect(row.claimOwner).toBeNull();
      expect(row.lastErrorCode).toBe(kind);
      expect(row.nextEligibleAt!.getTime()).toBe(now.getTime() + INGEST_RETRY_BACKOFF_MS);
    }
  });

  maybe()("O. every reviewed terminal kind abandons the window", async () => {
    for (const kind of TERMINAL) {
      const { id, windowId } = await seeded(`terminal-${kind}`);
      const reader = fakeReader(() => binance(kind));

      const result = await executorFor(id, reader).executeOne({ workerId: "worker-a" });

      expect(result.outcome).toBe("ABANDONED");
      expect(result.reasonCode).toBe(kind);
      expect(await fillsFor(id)).toEqual([]);
      const row = await rowOf(windowId);
      expect(row.status).toBe("ABANDONED");
      expect(row.attempts).toBe(1);
      expect(row.lastErrorCode).toBe(kind);
    }
  });

  maybe()("P. a retryable failure ON the last attempt abandons instead", async () => {
    const { id, windowId } = await seeded("retry-exhausted");
    await prisma!.exchangeFillIngestWindow.update({
      where: { id: windowId },
      data: { attempts: MAX_INGEST_ATTEMPTS - 1 },
    });
    const reader = fakeReader(() => binance("SERVER"));

    const result = await executorFor(id, reader).executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("ABANDONED");
    const row = await rowOf(windowId);
    expect(row.status).toBe("ABANDONED");
    expect(row.attempts).toBe(MAX_INGEST_ATTEMPTS);
  });

  maybe()("AE. an unclassified error is rethrown, never guessed at", async () => {
    const { id, windowId } = await seeded("unknown-error");
    const reader = fakeReader(() => new Error("something nobody classified"));

    await expect(
      executorFor(id, reader).executeOne({ workerId: "worker-a" })
    ).rejects.toThrow(/something nobody classified/);

    // No false durable classification: the lease simply stands until it expires.
    const row = await rowOf(windowId);
    expect(row.status).toBe("PENDING");
    expect(row.lastErrorCode).toBeNull();
    expect(row.nextEligibleAt).toBeNull();
    expect(row.claimOwner).toBe("worker-a");
    expect(await fillsFor(id)).toEqual([]);
  });

  maybe()("the persisted detail carries no credential", async () => {
    const { id, windowId } = await seeded("sanitized-error");
    const reader = fakeReader(
      () =>
        new BinanceError({
          kind: "SERVER" as never,
          message: "Binance userTrades request failed: signature=deadbeefcafe1234",
          endpoint: "userTrades",
        })
    );

    await executorFor(id, reader).executeOne({ workerId: "worker-a" });

    const row = await rowOf(windowId);
    expect(row.sanitizedLastError).toContain("***REDACTED***");
    expect(row.sanitizedLastError).not.toContain("deadbeefcafe1234");
    expect(row.sanitizedLastError!.length).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// Ledger failures inside the transaction
// ---------------------------------------------------------------------------

describe("a failed transaction commits neither fills nor coverage", () => {
  /** A ledger whose ingestion always throws, at the point the real one would. */
  const throwingLedger = (error: Error) =>
    ({
      ingestUserTradesInTransaction: async () => {
        throw error;
      },
    }) as never;

  maybe()("Q. an insert race rolls back and schedules a retry", async () => {
    const { id, windowId } = await seeded("insert-race");
    const reader = fakeReader(() => [trade({ tradeId: "1201" })]);
    const now = new Date();
    const executor = executorFor(id, reader, {
      ledger: throwingLedger(new FillLedgerInsertRaceError(id, 1)),
    });

    const result = await executor.executeOne({ workerId: "worker-a", now });

    expect(result.outcome).toBe("RETRY_SCHEDULED");
    expect(result.reasonCode).toBe("FILL_LEDGER_INSERT_RACE");
    expect(await fillsFor(id)).toEqual([]);
    const row = await rowOf(windowId);
    expect(row.status).toBe("PENDING");
    expect(row.claimedAt).toBeNull();
    expect(row.nextEligibleAt!.getTime()).toBe(now.getTime() + INGEST_RETRY_BACKOFF_MS);
  });

  maybe()("R. an unresolved race rolls back and schedules a retry", async () => {
    const { id, windowId } = await seeded("race-unresolved");
    const reader = fakeReader(() => [trade({ tradeId: "1301" })]);
    const executor = executorFor(id, reader, {
      ledger: throwingLedger(new FillLedgerRaceUnresolvedError(id, SYMBOL, "1301")),
    });

    const result = await executor.executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("RETRY_SCHEDULED");
    expect(result.reasonCode).toBe("FILL_LEDGER_RACE_UNRESOLVED");
    expect((await rowOf(windowId)).status).toBe("PENDING");
    expect(await fillsFor(id)).toEqual([]);
  });

  maybe()("S. an economic identity conflict is TERMINAL, not a retry", async () => {
    // Asking again reproduces it exactly, so the window is put where an
    // operator can see it rather than spending four more attempts.
    const { id, windowId } = await seeded("identity-conflict");
    const reader = fakeReader(() => [trade({ tradeId: "1401" })]);
    const executor = executorFor(id, reader, {
      ledger: throwingLedger(new FillLedgerConflictError(id, SYMBOL, "1401", ["price"])),
    });

    const result = await executor.executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("ABANDONED");
    expect(result.reasonCode).toBe("FILL_LEDGER_IDENTITY_CONFLICT");
    expect(await fillsFor(id)).toEqual([]);
    const row = await rowOf(windowId);
    expect(row.status).toBe("ABANDONED");
    expect(row.lastErrorCode).toBe("FILL_LEDGER_IDENTITY_CONFLICT");
    expect(row.attempts).toBe(1);
  });

  maybe()("T. an attribution conflict is TERMINAL too", async () => {
    const { id, windowId } = await seeded("attribution-conflict");
    const reader = fakeReader(() => [trade({ tradeId: "1501" })]);
    const executor = executorFor(id, reader, {
      ledger: throwingLedger(new FillLedgerAttributionConflictError(id, SYMBOL, "1501", "a", "b")),
    });

    const result = await executor.executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("ABANDONED");
    expect(result.reasonCode).toBe("FILL_LEDGER_ATTRIBUTION_CONFLICT");
    expect((await rowOf(windowId)).status).toBe("ABANDONED");
  });

  maybe()("Y. a failure between the fills and the transition rolls BOTH back", async () => {
    // The property the single transaction exists for. Real ledger, real rows
    // written inside the transaction, then the work transition throws.
    const { id, windowId } = await seeded("forced-rollback");
    const reader = fakeReader(() => [trade({ tradeId: "1601" }), trade({ tradeId: "1602" })]);
    const executor = executorFor(id, reader, {
      work: new Proxy(work, {
        get(target, property, receiver) {
          if (property !== "markComplete") return Reflect.get(target, property, receiver);
          return async () => {
            throw new Error("the transition failed after the fills were written");
          };
        },
      }),
    });

    await expect(executor.executeOne({ workerId: "worker-a" })).rejects.toThrow(
      /the transition failed after the fills were written/
    );

    // No state where the fills are durable and the window is not.
    expect(await fillsFor(id)).toEqual([]);
    const row = await rowOf(windowId);
    expect(row.status).toBe("PENDING");
    expect(row.claimOwner).toBe("worker-a");
  });

  maybe()("a report that does not conserve its input fails closed", async () => {
    const { id, windowId } = await seeded("report-invariant");
    const reader = fakeReader(() => [trade({ tradeId: "1701" }), trade({ tradeId: "1702" })]);
    const executor = executorFor(id, reader, {
      ledger: {
        // Claims one row was handled when two were given.
        ingestUserTradesInTransaction: async () => ({
          inserted: 1, duplicates: 0, skipped: 0,
          unattributed: 0, ambiguous: 0, attributionEnriched: 0, skippedReasons: [],
        }),
      } as never,
    });

    await expect(executor.executeOne({ workerId: "worker-a" })).rejects.toThrow(
      /did not conserve its input/
    );

    expect(await fillsFor(id)).toEqual([]);
    expect((await rowOf(windowId)).status).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// The stale-response proofs — the point of the slice
// ---------------------------------------------------------------------------

describe("a stale response never becomes durable truth", () => {
  async function racedExecution(alias: string, page: () => unknown, bounds = interval()) {
    const { id, windowId } = await seeded(alias, bounds);
    let stolen: { claimOwner: string | null; attempt: number } | null = null;

    const reader = fakeReader(() => page());
    // Age A's lease and let B reclaim, DURING A's request.
    const original = reader.listRecentTradesOnce.getMockImplementation()!;
    reader.listRecentTradesOnce.mockImplementation(async (symbol: string, options: never) => {
      await expireLease(windowId);
      const b = await work.claimNextWindow(prisma!, {
        executionProfileId: id,
        workerId: "worker-b",
      });
      stolen = { claimOwner: b!.claimOwner, attempt: b!.attempt };
      return original(symbol, options);
    });

    const result = await executorFor(id, reader).executeOne({ workerId: "worker-a" });
    return { id, windowId, result, stolen: stolen! };
  }

  maybe()("U. a stale SHORT page rolls its ledger rows back", async () => {
    const { id, windowId, result, stolen } = await racedExecution("stale-short", () => [
      trade({ tradeId: "2001" }),
      trade({ tradeId: "2002" }),
    ]);

    expect(result.outcome).toBe("STALE_CLAIM");
    expect(result.attempt).toBe(1);
    expect(stolen.attempt).toBe(2);

    // Nothing of A's survived.
    expect(await fillsFor(id)).toEqual([]);
    const row = await rowOf(windowId);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(2);
    expect(row.claimOwner).toBe("worker-b");
    expect(row.claimedAt).not.toBeNull();
    expect(await prisma!.exchangeFillIngestWindow.count({ where: { parentId: windowId } })).toBe(0);
  });

  maybe()("V. a stale FULL page rolls back its rows AND its children", async () => {
    const { id, windowId, result, stolen } = await racedExecution("stale-split", () =>
      Array.from({ length: USER_TRADES_MAX_LIMIT }, () => trade({ tradeId: "2101" }))
    );

    expect(result.outcome).toBe("STALE_CLAIM");
    expect(stolen.attempt).toBe(2);

    expect(await fillsFor(id)).toEqual([]);
    expect(await prisma!.exchangeFillIngestWindow.count({ where: { parentId: windowId } })).toBe(0);
    const row = await rowOf(windowId);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(2);
    expect(row.claimOwner).toBe("worker-b");
  });

  maybe()("W. a stale RETRY recorder leaves the newer claim byte-equivalent", async () => {
    const { id, windowId } = await seeded("stale-retry");
    const reader = fakeReader(
      () => new BinanceError({ kind: "SERVER" as never, message: "boom", endpoint: "userTrades" })
    );
    let before: Awaited<ReturnType<typeof rowOf>> | null = null;
    reader.listRecentTradesOnce.mockImplementation(async () => {
      await expireLease(windowId);
      await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-b" });
      before = await rowOf(windowId);
      throw new BinanceError({ kind: "SERVER" as never, message: "boom", endpoint: "userTrades" });
    });

    const result = await executorFor(id, reader).executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("STALE_CLAIM");
    const after = await rowOf(windowId);
    expect(after.status).toBe("PENDING");
    expect(after.attempts).toBe(before!.attempts);
    expect(after.claimOwner).toBe(before!.claimOwner);
    expect(after.claimedAt!.getTime()).toBe(before!.claimedAt!.getTime());
    expect(after.nextEligibleAt).toBe(before!.nextEligibleAt);
    expect(after.lastErrorCode).toBe(before!.lastErrorCode);
    expect(after.sanitizedLastError).toBe(before!.sanitizedLastError);
  });

  maybe()("X. a stale PERMANENT failure cannot abandon the newer attempt", async () => {
    const { id, windowId } = await seeded("stale-abandon");
    const reader = fakeReader(() => []);
    let before: Awaited<ReturnType<typeof rowOf>> | null = null;
    reader.listRecentTradesOnce.mockImplementation(async () => {
      await expireLease(windowId);
      await work.claimNextWindow(prisma!, { executionProfileId: id, workerId: "worker-b" });
      before = await rowOf(windowId);
      throw new BinanceError({
        kind: "REQUEST_INVALID" as never,
        message: "invalid",
        endpoint: "userTrades",
      });
    });

    const result = await executorFor(id, reader).executeOne({ workerId: "worker-a" });

    expect(result.outcome).toBe("STALE_CLAIM");
    const after = await rowOf(windowId);
    expect(after.status).toBe("PENDING");
    expect(after.attempts).toBe(before!.attempts);
    expect(after.claimOwner).toBe(before!.claimOwner);
    expect(after.claimedAt!.getTime()).toBe(before!.claimedAt!.getTime());
  });

  maybe()("a stale SYMBOL-MISMATCH page cannot abandon the newer attempt either", async () => {
    const { id, windowId, result } = await racedExecution("stale-symbol", () => [
      trade({ tradeId: "2201", symbol: OTHER_SYMBOL }),
    ]);

    expect(result.outcome).toBe("STALE_CLAIM");
    const row = await rowOf(windowId);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(2);
    expect(row.claimOwner).toBe("worker-b");
    expect(await fillsFor(id)).toEqual([]);
  });
});
