import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * Historical fill root bootstrap composition, against a REAL Postgres.
 *
 * Composition is the thing under test, so the parts are the real parts: the
 * real day generator, the real symbol universe, the real overlap classifier and
 * the real root writer, over real rows. The two things that are driven rather
 * than observed are the profile BINDING -- which reads process configuration,
 * and whose failure taxonomy is exercised through the real binder -- and the
 * root writer, replaced only where a race or an outage has to happen on cue.
 *
 * Nothing here imports a Binance client and no exchange request is made
 * anywhere in it or in the code under test.
 */

const TAG = "root-bootstrap";
const SYMBOL_A = "BOOTAUSDT";
const SYMBOL_B = "BOOTBUSDT";
const SYMBOL_C = "BOOTCUSDT";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { DAY_MS, FillIngestHorizonRefusedError } = await import(
  "../src/modules/execution/exchange-fill-day-roots"
);
const { ExecutionSymbolLineageError } = await import(
  "../src/modules/execution/exchange-fill-symbol-universe"
);
const { ExchangeFillIngestWindowService } = await import(
  "../src/modules/execution/exchange-fill-ingest-window.service"
);
const {
  ExchangeFillRootBootstrap,
  FillRootStructuralOverlapError,
  FillRootRaceUnresolvedError,
} = await import("../src/modules/execution/exchange-fill-root-bootstrap.service");

const maybe = () => (available ? it : it.skip);

type WindowService = InstanceType<typeof ExchangeFillIngestWindowService>;

/**
 * A fixed instant, and the completed UTC days a horizon from it must produce.
 *
 * `NOW` is mid-morning on the 12th, so the 12th is the OPEN day and must never
 * be seeded; the newest completed day is the 11th.
 */
const NOW = new Date("2026-08-12T09:15:00.000Z");
const NEWEST_DAY_START = Date.UTC(2026, 7, 11);

/** The inclusive bounds of the Nth-newest completed day (0 = the 11th). */
const dayBack = (n: number) => ({
  startTimeMs: NEWEST_DAY_START - n * DAY_MS,
  endTimeMs: NEWEST_DAY_START - n * DAY_MS + DAY_MS - 1,
});

let work: WindowService;
let sequence = 0;

/** A profile the configured binder could resolve, with the policy it requires. */
async function profile(alias: string, environment: "TESTNET" | "MAINNET" = "TESTNET") {
  sequence += 1;
  const row = await prisma!.executionProfile.create({
    data: {
      name: `${TAG} ${alias} ${sequence}`,
      accountIdentifier: `${TAG}-${alias}-${sequence}`,
      environment,
      isEnabled: false,
      safetyPolicy: { create: {} },
    },
  });
  return row;
}

/** One durable execution, which is what puts a symbol in the universe. */
async function execution(executionProfileId: string, symbol: string) {
  sequence += 1;
  return prisma!.tradeExecution.create({
    data: {
      executionProfileId,
      symbol,
      direction: "LONG",
      positionSide: "LONG",
      selectedLookback: 200,
      plannedEntryPrice: "1.06",
      calculatedStopLoss: "1.01",
      executableStopLoss: "1.01",
      takeProfit: "1.09",
      riskBudgetUsd: "3",
      quantityRaw: "68.8",
      plannedQuantity: "68.8",
      quantityStepSize: "0.1",
      actualPlannedLoss: "3",
      unusedRiskBudget: "0",
      positionNotional: "72.9",
      targetIsolatedMargin: "7.3",
      maximumIsolatedMargin: "10",
      selectedLeverage: 10,
      estimatedInitialMargin: "7.3",
      liquidationBufferRatio: "0.5",
      decisionReasonCode: `${TAG}-${sequence}`,
    },
  });
}

/** A window row written directly, including shapes the writer would refuse. */
async function windowRow(
  executionProfileId: string,
  symbol: string,
  startTimeMs: number,
  endTimeMs: number,
  overrides: Record<string, unknown> = {}
) {
  const row = await prisma!.exchangeFillIngestWindow.create({
    data: {
      executionProfileId,
      symbol,
      startTimeMs: BigInt(startTimeMs),
      endTimeMs: BigInt(endTimeMs),
      ...overrides,
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

/** The service under test, bound to one test's own profile. */
function bootstrapFor(executionProfileId: string, overrides: Record<string, unknown> = {}) {
  return new ExchangeFillRootBootstrap({
    prisma: prisma!,
    work,
    bindProfile: boundTo(executionProfileId),
    ...overrides,
  } as never);
}

/** Every window row of a profile, in the natural reading order. */
const windowsOf = async (executionProfileId: string) =>
  prisma!.exchangeFillIngestWindow.findMany({
    where: { executionProfileId },
    orderBy: [{ symbol: "asc" }, { startTimeMs: "asc" }, { endTimeMs: "asc" }],
  });

const countWindows = async (executionProfileId: string) =>
  prisma!.exchangeFillIngestWindow.count({ where: { executionProfileId } });

/** `[symbol, startMs, endMs]` triples, which is what the assertions compare. */
const shapeOf = (rows: Array<{ symbol: string; startTimeMs: bigint; endTimeMs: bigint }>) =>
  rows.map((row) => [row.symbol, Number(row.startTimeMs), Number(row.endTimeMs)]);

beforeAll(async () => {
  if (!prisma || !available) return;
  work = new ExchangeFillIngestWindowService(prisma);
  // Guards the arithmetic every expectation below is built from.
  expect(NEWEST_DAY_START % DAY_MS).toBe(0);
  expect(new Date(NEWEST_DAY_START).toISOString()).toBe("2026-08-11T00:00:00.000Z");
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
    await prisma.executionEvent.deleteMany({
      where: { tradeExecution: { executionProfileId: { in: profiles } } },
    });
    await prisma.tradeExecution.deleteMany({ where: { executionProfileId: { in: profiles } } });
    await prisma.executionSafetyPolicy.deleteMany({
      where: { executionProfileId: { in: profiles } },
    });
    await prisma.executionProfile.deleteMany({ where: { id: { in: profiles } } });
  }
  await prisma.$disconnect();
});

describe("profile binding gates everything", () => {
  const ORIGINAL_IDENTIFIER = process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER;
  const ORIGINAL_ENVIRONMENT = process.env.EXECUTION_PROFILE_ENVIRONMENT;
  const ORIGINAL_BASE_URL = process.env.BINANCE_FUTURES_REST_BASE_URL;

  /**
   * A prisma stub that answers ONLY the profile lookup.
   *
   * That is the zero-write proof. If bootstrap ever reached for the symbol
   * universe or a window table on a failed binding, the property would be
   * undefined and the call would throw rather than quietly pass.
   */
  function profileOnlyPrisma(rows: Array<Record<string, unknown>>) {
    return {
      executionProfile: { findMany: vi.fn(async () => rows) },
    } as unknown as PrismaClient;
  }

  const profileRow = (
    environment: "TESTNET" | "MAINNET",
    overrides: Record<string, unknown> = {}
  ) => ({
    id: "profile-under-test",
    accountIdentifier: "primary-futures",
    environment,
    isEnabled: true,
    safetyPolicy: { id: "policy-1" },
    ...overrides,
  });

  /**
   * Runs the REAL binder by driving process configuration and re-importing the
   * module graph, exactly as the binder's own suite does. Nothing is injected
   * past the public signature, so the production construction path is the one
   * under test.
   */
  async function bootstrapWithRealBinder(
    connector: string,
    client: PrismaClient,
    options: { now?: Date; horizonDays?: number } = {}
  ) {
    process.env.BINANCE_FUTURES_REST_BASE_URL = connector;
    vi.resetModules();
    const [{ ExchangeFillRootBootstrap: Service }, { ExchangeFillIngestWindowService: Work }] =
      await Promise.all([
        import("../src/modules/execution/exchange-fill-root-bootstrap.service"),
        import("../src/modules/execution/exchange-fill-ingest-window.service"),
      ]);
    const service = new Service({ prisma: client, work: new Work(client) });
    return service.bootstrapHistoricalRoots({
      now: options.now ?? NOW,
      horizonDays: options.horizonDays ?? 2,
    });
  }

  let MAINNET_ORIGIN: string;
  let TESTNET_ORIGIN: string;

  beforeAll(async () => {
    ({ BINANCE_MAINNET_FUTURES_ORIGIN: MAINNET_ORIGIN } = await import(
      "../src/modules/binance/binance-environment"
    ));
    ({ BINANCE_TESTNET_ORIGIN: TESTNET_ORIGIN } = await import(
      "../src/modules/binance/testnet-verifier/testnet-config"
    ));
  });

  beforeEach(() => {
    process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = "primary-futures";
    process.env.EXECUTION_PROFILE_ENVIRONMENT = "MAINNET";
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_IDENTIFIER === undefined) delete process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER;
    else process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = ORIGINAL_IDENTIFIER;
    if (ORIGINAL_ENVIRONMENT === undefined) delete process.env.EXECUTION_PROFILE_ENVIRONMENT;
    else process.env.EXECUTION_PROFILE_ENVIRONMENT = ORIGINAL_ENVIRONMENT;
    if (ORIGINAL_BASE_URL === undefined) delete process.env.BINANCE_FUTURES_REST_BASE_URL;
    else process.env.BINANCE_FUTURES_REST_BASE_URL = ORIGINAL_BASE_URL;
    vi.resetModules();
  });

  it("refuses with PROFILE_NOT_CONFIGURED and never opens a query", async () => {
    process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = "";
    const client = profileOnlyPrisma([]);

    const result = await bootstrapWithRealBinder(MAINNET_ORIGIN, client);

    expect(result).toEqual({ outcome: "PROFILE_UNAVAILABLE", reasonCode: "PROFILE_NOT_CONFIGURED" });
    expect(client.executionProfile.findMany).not.toHaveBeenCalled();
  });

  it("refuses with PROFILE_NOT_FOUND", async () => {
    const result = await bootstrapWithRealBinder(MAINNET_ORIGIN, profileOnlyPrisma([]));

    expect(result).toEqual({ outcome: "PROFILE_UNAVAILABLE", reasonCode: "PROFILE_NOT_FOUND" });
  });

  it("refuses with PROFILE_AMBIGUOUS", async () => {
    const result = await bootstrapWithRealBinder(
      MAINNET_ORIGIN,
      profileOnlyPrisma([profileRow("MAINNET"), profileRow("MAINNET", { id: "second" })])
    );

    expect(result).toEqual({ outcome: "PROFILE_UNAVAILABLE", reasonCode: "PROFILE_AMBIGUOUS" });
  });

  it("refuses with PROFILE_POLICY_MISSING", async () => {
    const result = await bootstrapWithRealBinder(
      MAINNET_ORIGIN,
      profileOnlyPrisma([profileRow("MAINNET", { safetyPolicy: null })])
    );

    expect(result).toEqual({ outcome: "PROFILE_UNAVAILABLE", reasonCode: "PROFILE_POLICY_MISSING" });
  });

  it("refuses with PROFILE_ENVIRONMENT_MISMATCH", async () => {
    process.env.EXECUTION_PROFILE_ENVIRONMENT = "TESTNET";
    const result = await bootstrapWithRealBinder(
      MAINNET_ORIGIN,
      profileOnlyPrisma([profileRow("TESTNET")])
    );

    expect(result).toEqual({
      outcome: "PROFILE_UNAVAILABLE",
      reasonCode: "PROFILE_ENVIRONMENT_MISMATCH",
    });
  });

  it("propagates a database failure from the binder instead of calling it unavailable", async () => {
    const failure = new Error("connection terminated unexpectedly");
    const client = {
      executionProfile: {
        findMany: vi.fn(async () => {
          throw failure;
        }),
      },
    } as unknown as PrismaClient;

    // A database that cannot answer has not said "misconfigured".
    await expect(bootstrapWithRealBinder(MAINNET_ORIGIN, client)).rejects.toBe(failure);
  });

  maybe()("binds the CONFIGURED profile, never another profile that has executions", async () => {
    const bound = await profile("configured");
    const stranger = await profile("stranger");
    await execution(bound.id, SYMBOL_A);
    await execution(stranger.id, SYMBOL_B);

    process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = bound.accountIdentifier;
    process.env.EXECUTION_PROFILE_ENVIRONMENT = "TESTNET";

    const result = await bootstrapWithRealBinder(TESTNET_ORIGIN, prisma!, { horizonDays: 1 });

    expect(result).toMatchObject({
      outcome: "BOOTSTRAPPED",
      executionProfileId: bound.id,
      symbolCount: 1,
      createdCount: 1,
    });
    expect(shapeOf(await windowsOf(bound.id))).toEqual([
      [SYMBOL_A, dayBack(0).startTimeMs, dayBack(0).endTimeMs],
    ]);
    // The other account was never touched.
    expect(await countWindows(stranger.id)).toBe(0);
  });
});

describe("composing the expected workset", () => {
  maybe()("succeeds with nothing to do when the account has never executed", async () => {
    const { id } = await profile("no-executions");

    const result = await bootstrapFor(id).bootstrapHistoricalRoots({ now: NOW, horizonDays: 30 });

    expect(result).toEqual({
      outcome: "BOOTSTRAPPED",
      executionProfileId: id,
      horizonDays: 30,
      symbolCount: 0,
      dayCount: 30,
      expectedRootCount: 0,
      alreadyCompatibleCount: 0,
      createdCount: 0,
      raceReconciledCount: 0,
    });
    expect(await countWindows(id)).toBe(0);
  });

  maybe()("creates the single completed day for a single symbol", async () => {
    const { id } = await profile("one-by-one");
    await execution(id, SYMBOL_A);

    const result = await bootstrapFor(id).bootstrapHistoricalRoots({ now: NOW, horizonDays: 1 });

    expect(result).toMatchObject({
      symbolCount: 1,
      dayCount: 1,
      expectedRootCount: 1,
      alreadyCompatibleCount: 0,
      createdCount: 1,
      raceReconciledCount: 0,
    });
    expect(shapeOf(await windowsOf(id))).toEqual([
      [SYMBOL_A, dayBack(0).startTimeMs, dayBack(0).endTimeMs],
    ]);
  });

  maybe()("creates every completed day and never the open one", async () => {
    const { id } = await profile("many-days");
    await execution(id, SYMBOL_A);

    const result = await bootstrapFor(id).bootstrapHistoricalRoots({ now: NOW, horizonDays: 3 });

    expect(result).toMatchObject({ dayCount: 3, expectedRootCount: 3, createdCount: 3 });
    expect(shapeOf(await windowsOf(id))).toEqual([
      [SYMBOL_A, dayBack(2).startTimeMs, dayBack(2).endTimeMs],
      [SYMBOL_A, dayBack(1).startTimeMs, dayBack(1).endTimeMs],
      [SYMBOL_A, dayBack(0).startTimeMs, dayBack(0).endTimeMs],
    ]);

    const rows = await windowsOf(id);
    // Exact inclusive UTC-day bounds, and the day `NOW` falls in is absent.
    expect(new Date(Number(rows[2]!.startTimeMs)).toISOString()).toBe("2026-08-11T00:00:00.000Z");
    expect(new Date(Number(rows[2]!.endTimeMs)).toISOString()).toBe("2026-08-11T23:59:59.999Z");
    expect(new Date(Number(rows[0]!.startTimeMs)).toISOString()).toBe("2026-08-09T00:00:00.000Z");
    for (const row of rows) {
      expect(Number(row.endTimeMs)).toBeLessThan(Date.UTC(2026, 7, 12));
    }
  });

  maybe()("covers the Cartesian product of symbols and days", async () => {
    const { id } = await profile("product");
    // Written out of order, and twice each: the universe is distinct and sorted.
    await execution(id, SYMBOL_C);
    await execution(id, SYMBOL_A);
    await execution(id, SYMBOL_B);
    await execution(id, SYMBOL_A);

    const result = await bootstrapFor(id).bootstrapHistoricalRoots({ now: NOW, horizonDays: 2 });

    expect(result).toMatchObject({
      symbolCount: 3,
      dayCount: 2,
      expectedRootCount: 6,
      createdCount: 6,
      alreadyCompatibleCount: 0,
      raceReconciledCount: 0,
    });
    expect(shapeOf(await windowsOf(id))).toEqual([
      [SYMBOL_A, dayBack(1).startTimeMs, dayBack(1).endTimeMs],
      [SYMBOL_A, dayBack(0).startTimeMs, dayBack(0).endTimeMs],
      [SYMBOL_B, dayBack(1).startTimeMs, dayBack(1).endTimeMs],
      [SYMBOL_B, dayBack(0).startTimeMs, dayBack(0).endTimeMs],
      [SYMBOL_C, dayBack(1).startTimeMs, dayBack(1).endTimeMs],
      [SYMBOL_C, dayBack(0).startTimeMs, dayBack(0).endTimeMs],
    ]);
  });

  maybe()("is idempotent: a replay creates nothing and mutates nothing", async () => {
    const { id } = await profile("replay");
    await execution(id, SYMBOL_A);
    await execution(id, SYMBOL_B);

    const first = await bootstrapFor(id).bootstrapHistoricalRoots({ now: NOW, horizonDays: 3 });
    expect(first).toMatchObject({ expectedRootCount: 6, createdCount: 6 });
    const before = await windowsOf(id);

    const second = await bootstrapFor(id).bootstrapHistoricalRoots({ now: NOW, horizonDays: 3 });

    expect(second).toMatchObject({
      expectedRootCount: 6,
      alreadyCompatibleCount: 6,
      createdCount: 0,
      raceReconciledCount: 0,
    });
    // Same rows, same ids, same every column -- no duplicates and no churn.
    expect(await windowsOf(id)).toEqual(before);
  });

  maybe()("conserves the expected count across all three outcomes", async () => {
    const { id } = await profile("conservation");
    await execution(id, SYMBOL_A);
    await windowRow(id, SYMBOL_A, dayBack(1).startTimeMs, dayBack(1).endTimeMs);

    const result = await bootstrapFor(id).bootstrapHistoricalRoots({ now: NOW, horizonDays: 3 });

    expect(result.outcome).toBe("BOOTSTRAPPED");
    if (result.outcome !== "BOOTSTRAPPED") throw new Error("unreachable");
    expect(result.alreadyCompatibleCount).toBe(1);
    expect(result.createdCount).toBe(2);
    expect(result.raceReconciledCount).toBe(0);
    expect(
      result.alreadyCompatibleCount + result.createdCount + result.raceReconciledCount
    ).toBe(result.expectedRootCount);
  });
});

describe("the preflight barrier", () => {
  maybe()("writes NOTHING when the conflict is the very last expected root", async () => {
    const { id } = await profile("late-conflict");
    await execution(id, SYMBOL_A);
    await execution(id, SYMBOL_B);
    await execution(id, SYMBOL_C);
    // Last symbol in sort order, newest day in horizon order: every one of the
    // eight expected roots before it is MISSING and perfectly creatable.
    const blockerId = await windowRow(
      id,
      SYMBOL_C,
      dayBack(0).startTimeMs + 1,
      dayBack(0).endTimeMs
    );

    await expect(
      bootstrapFor(id).bootstrapHistoricalRoots({ now: NOW, horizonDays: 3 })
    ).rejects.toBeInstanceOf(FillRootStructuralOverlapError);

    // The blocker, and not one root more.
    const rows = await windowsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(blockerId);
  });

  maybe()("carries every conflict as evidence, in workset order", async () => {
    const { id } = await profile("evidence");
    await execution(id, SYMBOL_A);
    await execution(id, SYMBOL_B);
    const straddleA = await windowRow(
      id,
      SYMBOL_A,
      dayBack(1).startTimeMs + DAY_MS / 2,
      dayBack(0).startTimeMs + DAY_MS / 2
    );
    const containedB = await windowRow(
      id,
      SYMBOL_B,
      dayBack(0).startTimeMs + 1,
      dayBack(0).endTimeMs - 1
    );

    const error = await bootstrapFor(id)
      .bootstrapHistoricalRoots({ now: NOW, horizonDays: 2 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FillRootStructuralOverlapError);
    if (!(error instanceof FillRootStructuralOverlapError)) throw new Error("unreachable");
    expect(error.reasonCode).toBe("FILL_ROOT_STRUCTURAL_OVERLAP");
    expect(error.executionProfileId).toBe(id);
    // A straddle hits both of symbol A's days; symbol B's contained root hits one.
    expect(
      error.conflicts.map((conflict) => [conflict.symbol, conflict.desired.startTimeMs])
    ).toEqual([
      [SYMBOL_A, dayBack(1).startTimeMs],
      [SYMBOL_A, dayBack(0).startTimeMs],
      [SYMBOL_B, dayBack(0).startTimeMs],
    ]);
    expect(error.conflicts[0]!.overlaps.map((row) => row.windowId)).toEqual([straddleA]);
    expect(error.conflicts[2]!.overlaps.map((row) => row.windowId)).toEqual([containedB]);
    expect(await windowsOf(id)).toHaveLength(2);
  });

  maybe()("refuses when an exact root sits beside a crossing root", async () => {
    const { id } = await profile("exact-plus-crossing");
    await execution(id, SYMBOL_A);
    await windowRow(id, SYMBOL_A, dayBack(0).startTimeMs, dayBack(0).endTimeMs);
    await windowRow(
      id,
      SYMBOL_A,
      dayBack(0).startTimeMs - DAY_MS / 2,
      dayBack(0).startTimeMs + DAY_MS / 2
    );

    await expect(
      bootstrapFor(id).bootstrapHistoricalRoots({ now: NOW, horizonDays: 1 })
    ).rejects.toBeInstanceOf(FillRootStructuralOverlapError);

    // The exact root is not a permission slip, and nothing new was written.
    expect(await countWindows(id)).toBe(2);
  });
});

describe("existing exact roots are never touched", () => {
  maybe()("leaves every persisted field of every status exactly as stored", async () => {
    const { id } = await profile("immutable");
    await execution(id, SYMBOL_A);

    const leasedId = await windowRow(id, SYMBOL_A, dayBack(0).startTimeMs, dayBack(0).endTimeMs, {
      status: "PENDING",
      attempts: 3,
      claimedAt: new Date("2026-08-11T10:00:00.000Z"),
      claimOwner: "worker-a",
      nextEligibleAt: new Date("2026-08-11T10:05:00.000Z"),
      lastAttemptAt: new Date("2026-08-11T09:59:00.000Z"),
      lastErrorCode: "USER_TRADES_DISPATCH_FAILED",
      sanitizedLastError: "upstream refused",
    });
    await windowRow(id, SYMBOL_A, dayBack(1).startTimeMs, dayBack(1).endTimeMs, {
      status: "COMPLETE",
      attempts: 1,
    });
    const splitId = await windowRow(id, SYMBOL_A, dayBack(2).startTimeMs, dayBack(2).endTimeMs, {
      status: "SPLIT",
      attempts: 2,
    });
    const mid = dayBack(2).startTimeMs + Math.floor((DAY_MS - 1) / 2);
    await windowRow(id, SYMBOL_A, dayBack(2).startTimeMs, mid, { parentId: splitId });
    await windowRow(id, SYMBOL_A, mid + 1, dayBack(2).endTimeMs, { parentId: splitId });
    await windowRow(id, SYMBOL_A, dayBack(3).startTimeMs, dayBack(3).endTimeMs, {
      status: "ABANDONED",
      attempts: 5,
      lastErrorCode: "USER_TRADES_DISPATCH_FAILED",
    });

    const before = await windowsOf(id);

    const result = await bootstrapFor(id).bootstrapHistoricalRoots({ now: NOW, horizonDays: 4 });

    expect(result).toMatchObject({
      expectedRootCount: 4,
      alreadyCompatibleCount: 4,
      createdCount: 0,
      raceReconciledCount: 0,
    });
    // Every column of every row, split children included. No status reset, no
    // lease clearing, no attempt rewind, no updatedAt churn.
    expect(await windowsOf(id)).toEqual(before);
    const leased = await prisma!.exchangeFillIngestWindow.findUniqueOrThrow({
      where: { id: leasedId },
    });
    expect(leased.status).toBe("PENDING");
    expect(leased.attempts).toBe(3);
    expect(leased.claimOwner).toBe("worker-a");
    expect(leased.lastErrorCode).toBe("USER_TRADES_DISPATCH_FAILED");
  });
});

describe("invalid input refuses before anything is written", () => {
  maybe()("propagates a durable symbol lineage fault", async () => {
    const { id } = await profile("bad-symbol");
    await execution(id, SYMBOL_A);
    // A value the canonical write path would never have produced.
    await execution(id, "bootausdt");

    await expect(
      bootstrapFor(id).bootstrapHistoricalRoots({ now: NOW, horizonDays: 2 })
    ).rejects.toBeInstanceOf(ExecutionSymbolLineageError);

    // Not even the valid symbol's roots were seeded.
    expect(await countWindows(id)).toBe(0);
  });

  for (const horizonDays of [0, 61, 2.5, -1, Number.NaN]) {
    maybe()(`refuses horizonDays=${String(horizonDays)} and writes nothing`, async () => {
      const { id } = await profile(`horizon-${String(horizonDays)}`);
      await execution(id, SYMBOL_A);

      await expect(
        bootstrapFor(id).bootstrapHistoricalRoots({ now: NOW, horizonDays })
      ).rejects.toBeInstanceOf(FillIngestHorizonRefusedError);

      expect(await countWindows(id)).toBe(0);
    });
  }

  maybe()("refuses an invalid `now` and writes nothing", async () => {
    const { id } = await profile("bad-now");
    await execution(id, SYMBOL_A);

    await expect(
      bootstrapFor(id).bootstrapHistoricalRoots({ now: new Date("not a date"), horizonDays: 2 })
    ).rejects.toBeInstanceOf(FillIngestHorizonRefusedError);

    expect(await countWindows(id)).toBe(0);
  });
});

/**
 * The exact natural-identity race, forced rather than waited for.
 *
 * `seedWindow` inserts with `skipDuplicates`, so a lost race is reported as
 * `created === false` with the insert's own transaction committed -- there is no
 * P2002 to catch and no aborted scope to avoid querying. These drive that
 * signal deterministically through the existing `work` dependency.
 */
describe("losing the exact-root race", () => {
  /** Runs `before` inside the seed, then performs the real seed. */
  const racingWork = (before: (input: { symbol: string; startTimeMs: number }) => Promise<void>) =>
    ({
      seedWindow: async (client: unknown, input: never) => {
        await before(input);
        return work.seedWindow(client as never, input);
      },
    }) as never;

  /** Reports "already there" without writing anything at all. */
  const lyingWork = () => ({ seedWindow: async () => ({ id: "phantom", created: false }) }) as never;

  maybe()("reconciles a competitor's identical root without claiming it", async () => {
    const { id } = await profile("race-win");
    await execution(id, SYMBOL_A);
    let competitorId = "";

    const service = bootstrapFor(id, {
      work: racingWork(async (input) => {
        if (input.startTimeMs !== dayBack(0).startTimeMs) return;
        competitorId = await windowRow(
          id,
          SYMBOL_A,
          dayBack(0).startTimeMs,
          dayBack(0).endTimeMs,
          { status: "COMPLETE", attempts: 1 }
        );
      }),
    });

    const result = await service.bootstrapHistoricalRoots({ now: NOW, horizonDays: 2 });

    expect(result).toMatchObject({
      outcome: "BOOTSTRAPPED",
      expectedRootCount: 2,
      alreadyCompatibleCount: 0,
      createdCount: 1,
      raceReconciledCount: 1,
    });
    // Exactly one durable root for the contested day, and it is the winner's,
    // still carrying the winner's status.
    const contested = await prisma!.exchangeFillIngestWindow.findMany({
      where: { executionProfileId: id, startTimeMs: BigInt(dayBack(0).startTimeMs) },
    });
    expect(contested).toHaveLength(1);
    expect(contested[0]!.id).toBe(competitorId);
    expect(contested[0]!.status).toBe("COMPLETE");
    expect(contested[0]!.attempts).toBe(1);
  });

  maybe()("refuses when the promised winner is not durable", async () => {
    const { id } = await profile("race-phantom");
    await execution(id, SYMBOL_A);

    // "A conflict happened" is not "the root exists".
    await expect(
      bootstrapFor(id, { work: lyingWork() }).bootstrapHistoricalRoots({
        now: NOW,
        horizonDays: 1,
      })
    ).rejects.toBeInstanceOf(FillRootRaceUnresolvedError);

    expect(await countWindows(id)).toBe(0);
  });

  maybe()("refuses when the winner wrote something structurally wrong", async () => {
    const { id } = await profile("race-structural");
    await execution(id, SYMBOL_A);

    const service = bootstrapFor(id, {
      work: racingWork(async () => {
        // The winner takes the exact identity -- which is what makes our own
        // insert report "already there" -- AND leaves a crossing root behind it.
        await windowRow(id, SYMBOL_A, dayBack(0).startTimeMs, dayBack(0).endTimeMs);
        await windowRow(
          id,
          SYMBOL_A,
          dayBack(0).startTimeMs - DAY_MS / 2,
          dayBack(0).startTimeMs + DAY_MS / 2
        );
      }),
    });

    await expect(
      service.bootstrapHistoricalRoots({ now: NOW, horizonDays: 1 })
    ).rejects.toBeInstanceOf(FillRootStructuralOverlapError);
  });

  maybe()("propagates an unrelated database failure from the writer", async () => {
    const { id } = await profile("race-infra");
    await execution(id, SYMBOL_A);
    const failure = new Error("could not serialize access due to concurrent update");

    await expect(
      bootstrapFor(id, {
        work: {
          seedWindow: async () => {
            throw failure;
          },
        } as never,
      }).bootstrapHistoricalRoots({ now: NOW, horizonDays: 1 })
    ).rejects.toBe(failure);
  });
});

describe("partial progress is resumable progress", () => {
  maybe()("keeps the roots it managed to create, then finishes on retry", async () => {
    const { id } = await profile("resumable");
    await execution(id, SYMBOL_A);
    const outage = new Error("connection terminated unexpectedly");

    // The older day seeds normally; the newer one hits an outage.
    const flaky = {
      seedWindow: async (client: unknown, input: { startTimeMs: number }) => {
        if (input.startTimeMs === dayBack(0).startTimeMs) throw outage;
        return work.seedWindow(client as never, input as never);
      },
    } as never;

    await expect(
      bootstrapFor(id, { work: flaky }).bootstrapHistoricalRoots({ now: NOW, horizonDays: 2 })
    ).rejects.toBe(outage);

    // Partial, durable, and canonical -- which is exactly why it is safe.
    expect(shapeOf(await windowsOf(id))).toEqual([
      [SYMBOL_A, dayBack(1).startTimeMs, dayBack(1).endTimeMs],
    ]);

    const retry = await bootstrapFor(id).bootstrapHistoricalRoots({ now: NOW, horizonDays: 2 });

    expect(retry).toMatchObject({
      expectedRootCount: 2,
      alreadyCompatibleCount: 1,
      createdCount: 1,
      raceReconciledCount: 0,
    });
    // Complete coverage, and the first root was not written twice.
    expect(shapeOf(await windowsOf(id))).toEqual([
      [SYMBOL_A, dayBack(1).startTimeMs, dayBack(1).endTimeMs],
      [SYMBOL_A, dayBack(0).startTimeMs, dayBack(0).endTimeMs],
    ]);
  });
});
