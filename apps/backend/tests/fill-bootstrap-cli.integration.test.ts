import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * The standalone root bootstrap command against a REAL Postgres.
 *
 * The command's whole claim is about DURABLE EFFECT: that it materializes
 * canonical roots, that a second run adds nothing, and that it leaves every
 * other historical table -- campaigns, breakers, weight buckets, reservations --
 * exactly as it found them, along with the claim state of every window that was
 * already there. None of that can be shown with a stubbed client, so the parts
 * here are the real parts.
 *
 * Nothing in this file or in the code under test imports a Binance client, and
 * no exchange request is made anywhere in it.
 */

const TAG = "bootstrap-cli";
const SYMBOL_A = "BCLIAUSDT";
const SYMBOL_B = "BCLIBUSDT";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { DAY_MS } = await import("../src/modules/execution/exchange-fill-day-roots");
const { ExchangeFillIngestWindowService } = await import(
  "../src/modules/execution/exchange-fill-ingest-window.service"
);
const { ExchangeFillRootBootstrap } = await import(
  "../src/modules/execution/exchange-fill-root-bootstrap.service"
);
const { BOOTSTRAP_CLI_EXIT, runFillBootstrapCli } = await import(
  "../src/modules/execution/fill-bootstrap-cli"
);

const maybe = () => (available ? it : it.skip);

/** Mid-morning on the 18th: the 18th is OPEN, the newest completed day is the 17th. */
const NOW = new Date("2026-09-18T09:15:00.000Z");
const NEWEST_DAY_START = Date.UTC(2026, 8, 17);

/** The inclusive bounds of the Nth-newest completed day (0 = the 17th). */
const dayBack = (n: number) => ({
  startTimeMs: NEWEST_DAY_START - n * DAY_MS,
  endTimeMs: NEWEST_DAY_START - n * DAY_MS + DAY_MS - 1,
});

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

const boundTo = (executionProfileId: string) =>
  async () => ({
    ok: true as const,
    context: { executionProfileId, environment: "TESTNET" } as never,
  });

/** The command, over the real bootstrap, bound to one test's own profile. */
async function runCommand(
  executionProfileId: string | null,
  options: { horizonDays?: number; argv?: string[] } = {}
) {
  const lines: string[] = [];
  const bootstrap = new ExchangeFillRootBootstrap({
    prisma: prisma!,
    work,
    bindProfile:
      executionProfileId === null
        ? async () => ({ ok: false as const, reasonCode: "PROFILE_NOT_FOUND" as never })
        : boundTo(executionProfileId),
  } as never);

  const result = await runFillBootstrapCli(options.argv ?? [], {
    bootstrap,
    horizonDays: options.horizonDays ?? 3,
    now: () => NOW,
    out: (line) => lines.push(line),
  });
  return { ...result, lines, text: lines.join("\n") };
}

const windowsOf = async (executionProfileId: string) =>
  prisma!.exchangeFillIngestWindow.findMany({
    where: { executionProfileId },
    orderBy: [{ symbol: "asc" }, { startTimeMs: "asc" }],
  });

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
    // Children first: the self relation is RESTRICT, exactly so lineage cannot
    // be removed out from under itself.
    await prisma.exchangeFillIngestWindow.deleteMany({
      where: { executionProfileId: { in: profiles }, parentId: { not: null } },
    });
    await prisma.exchangeFillIngestWindow.deleteMany({
      where: { executionProfileId: { in: profiles } },
    });
    await prisma.historicalFillCampaign.deleteMany({
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

describe("materializing the missing day of a partially covered horizon", () => {
  maybe()("creates exactly the roots that were missing, and reports the split", async () => {
    // The production shape in miniature: two symbols already covered for the
    // two newest completed days, and a horizon of three that reaches one day
    // further back. Only the third day is new.
    const target = await profile("partial");
    await execution(target.id, SYMBOL_A);
    await execution(target.id, SYMBOL_B);
    for (const symbol of [SYMBOL_A, SYMBOL_B]) {
      for (const back of [0, 1]) {
        await work.seedWindow(prisma!, { executionProfileId: target.id, symbol, ...dayBack(back) });
      }
    }
    expect(await prisma!.exchangeFillIngestWindow.count({ where: { executionProfileId: target.id } })).toBe(4);

    const run = await runCommand(target.id, { horizonDays: 3 });

    expect(run.exitCode).toBe(BOOTSTRAP_CLI_EXIT.OK);
    expect(run.text).toContain("outcome              BOOTSTRAPPED");
    expect(run.text).toContain("symbols              2");
    expect(run.text).toContain("days                 3");
    expect(run.text).toContain("expected roots       6");
    expect(run.text).toContain("already compatible   4");
    expect(run.text).toContain("created              2");
    expect(run.text).toContain("race reconciled      0");

    const rows = await windowsOf(target.id);
    expect(rows).toHaveLength(6);
    // The two new rows are the OLDEST day, for both symbols.
    const oldest = rows.filter((row) => Number(row.startTimeMs) === dayBack(2).startTimeMs);
    expect(oldest.map((row) => row.symbol).sort()).toEqual([SYMBOL_A, SYMBOL_B]);
  });

  maybe()("creates nothing on an identical second run", async () => {
    const target = await profile("idempotent");
    await execution(target.id, SYMBOL_A);

    const first = await runCommand(target.id, { horizonDays: 3 });
    expect(first.text).toContain("created              3");

    const before = await windowsOf(target.id);
    const second = await runCommand(target.id, { horizonDays: 3 });

    expect(second.exitCode).toBe(BOOTSTRAP_CLI_EXIT.OK);
    expect(second.text).toContain("created              0");
    expect(second.text).toContain("already compatible   3");
    expect(second.text).toContain("race reconciled      0");

    // Not merely "the same count": the same rows, unchanged field for field.
    const after = await windowsOf(target.id);
    expect(after).toEqual(before);
  });

  maybe()("leaves every pre-existing row byte-identical, including its timestamps", async () => {
    const target = await profile("stable");
    await execution(target.id, SYMBOL_A);
    await work.seedWindow(prisma!, {
      executionProfileId: target.id,
      symbol: SYMBOL_A,
      ...dayBack(0),
    });
    const before = await windowsOf(target.id);

    await runCommand(target.id, { horizonDays: 3 });

    const survivor = (await windowsOf(target.id)).find((row) => row.id === before[0]!.id);
    // `updatedAt` would move if any write helper had touched the row at all.
    expect(survivor).toEqual(before[0]);
  });
});

describe("the new roots carry untouched claim state", () => {
  maybe()("seeds PENDING rows with no attempt, no lease and no owner", async () => {
    const target = await profile("defaults");
    await execution(target.id, SYMBOL_A);

    await runCommand(target.id, { horizonDays: 3 });

    const rows = await windowsOf(target.id);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(0);
      expect(row.claimedAt).toBeNull();
      expect(row.claimOwner).toBeNull();
      expect(row.nextEligibleAt).toBeNull();
      expect(row.lastAttemptAt).toBeNull();
      expect(row.lastErrorCode).toBeNull();
      // Roots, not children: a bootstrap never creates a split.
      expect(row.parentId).toBeNull();
    }
  });

  maybe()("never claims or advances an existing window it finds", async () => {
    const target = await profile("noclaim");
    await execution(target.id, SYMBOL_A);
    const seeded = await work.seedWindow(prisma!, {
      executionProfileId: target.id,
      symbol: SYMBOL_A,
      ...dayBack(0),
    });
    // A row mid-flight: leased, attempted and backing off. A bootstrap that
    // touched claim state would disturb a window another worker owns.
    await prisma!.exchangeFillIngestWindow.update({
      where: { id: seeded.id },
      data: {
        attempts: 2,
        claimedAt: new Date("2026-09-18T09:14:00.000Z"),
        claimOwner: "worker-under-test",
        nextEligibleAt: new Date("2026-09-18T09:30:00.000Z"),
      },
    });
    const before = await prisma!.exchangeFillIngestWindow.findUniqueOrThrow({ where: { id: seeded.id } });

    await runCommand(target.id, { horizonDays: 3 });

    const after = await prisma!.exchangeFillIngestWindow.findUniqueOrThrow({ where: { id: seeded.id } });
    expect(after).toEqual(before);
    expect(after.attempts).toBe(2);
    expect(after.claimOwner).toBe("worker-under-test");
  });
});

describe("no campaign is required, created or consumed", () => {
  maybe()("materializes a full horizon with zero campaigns in existence", async () => {
    const target = await profile("nocampaign");
    await execution(target.id, SYMBOL_A);
    expect(await prisma!.historicalFillCampaign.count({ where: { executionProfileId: target.id } })).toBe(0);

    const run = await runCommand(target.id, { horizonDays: 3 });

    expect(run.exitCode).toBe(BOOTSTRAP_CLI_EXIT.OK);
    expect(run.text).toContain("created              3");
    // Still none: the command neither needed one nor made one.
    expect(await prisma!.historicalFillCampaign.count({ where: { executionProfileId: target.id } })).toBe(0);
  });

  maybe()("leaves every other historical table exactly as it found it", async () => {
    const target = await profile("untouched");
    await execution(target.id, SYMBOL_A);

    const before = {
      campaigns: await prisma!.historicalFillCampaign.count(),
      breakers: await prisma!.historicalFillCircuitBreaker.count(),
      buckets: await prisma!.historicalFillWeightBucket.count(),
      reservations: await prisma!.historicalFillWeightReservation.count(),
      ledger: await prisma!.exchangeFillLedger.count(),
    };

    const run = await runCommand(target.id, { horizonDays: 3 });
    expect(run.exitCode).toBe(BOOTSTRAP_CLI_EXIT.OK);

    expect({
      campaigns: await prisma!.historicalFillCampaign.count(),
      breakers: await prisma!.historicalFillCircuitBreaker.count(),
      buckets: await prisma!.historicalFillWeightBucket.count(),
      reservations: await prisma!.historicalFillWeightReservation.count(),
      ledger: await prisma!.exchangeFillLedger.count(),
    }).toEqual(before);
  });

  maybe()("does not disturb an existing campaign's dispatch accounting", async () => {
    const target = await profile("campaign-intact");
    await execution(target.id, SYMBOL_A);
    const campaign = await prisma!.historicalFillCampaign.create({
      data: { executionProfileId: target.id, maxDispatches: 3, status: "PAUSED" },
    });

    await runCommand(target.id, { horizonDays: 3 });

    const after = await prisma!.historicalFillCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(after).toEqual(campaign);
    expect(after.dispatchesUsed).toBe(0);
    expect(after.status).toBe("PAUSED");
  });
});

describe("the account is the bound account and nothing else", () => {
  maybe()("materializes only for the bound profile, ignoring another's symbols", async () => {
    const target = await profile("bound");
    const stranger = await profile("stranger");
    await execution(target.id, SYMBOL_A);
    // The stranger's symbol exists in the table, but not for this account.
    await execution(stranger.id, SYMBOL_B);

    const run = await runCommand(target.id, { horizonDays: 3 });

    expect(run.text).toContain("symbols              1");
    const mine = await windowsOf(target.id);
    expect(mine).toHaveLength(3);
    expect([...new Set(mine.map((row) => row.symbol))]).toEqual([SYMBOL_A]);
    // The other account gained nothing at all.
    expect(await prisma!.exchangeFillIngestWindow.count({ where: { executionProfileId: stranger.id } })).toBe(0);
  });

  maybe()("writes nothing at all when the profile cannot be bound", async () => {
    const target = await profile("unbound");
    await execution(target.id, SYMBOL_A);
    const before = await prisma!.exchangeFillIngestWindow.count();

    const run = await runCommand(null, { horizonDays: 3 });

    expect(run.exitCode).toBe(BOOTSTRAP_CLI_EXIT.REFUSED);
    expect(run.text).toContain("PROFILE_UNAVAILABLE");
    expect(run.text).toContain("PROFILE_NOT_FOUND");
    expect(await prisma!.exchangeFillIngestWindow.count()).toBe(before);
  });

  maybe()("writes nothing when the invocation is refused for usage", async () => {
    const target = await profile("usage");
    await execution(target.id, SYMBOL_A);
    const before = await prisma!.exchangeFillIngestWindow.count();

    const run = await runCommand(target.id, { horizonDays: 3, argv: ["--profile=someone-else"] });

    expect(run.exitCode).toBe(BOOTSTRAP_CLI_EXIT.USAGE);
    expect(await prisma!.exchangeFillIngestWindow.count()).toBe(before);
  });
});

describe("the configured horizon decides how far back roots reach", () => {
  maybe()("a horizon of 1 materializes only the newest completed day", async () => {
    const target = await profile("horizon-1");
    await execution(target.id, SYMBOL_A);

    const run = await runCommand(target.id, { horizonDays: 1 });

    expect(run.text).toContain("days                 1");
    const rows = await windowsOf(target.id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.startTimeMs)).toBe(dayBack(0).startTimeMs);
    expect(Number(rows[0]!.endTimeMs)).toBe(dayBack(0).endTimeMs);
  });

  maybe()("a horizon of 3 reaches exactly three completed days, newest first excluded", async () => {
    const target = await profile("horizon-3");
    await execution(target.id, SYMBOL_A);

    await runCommand(target.id, { horizonDays: 3 });

    const starts = (await windowsOf(target.id)).map((row) => Number(row.startTimeMs)).sort();
    expect(starts).toEqual([dayBack(2).startTimeMs, dayBack(1).startTimeMs, dayBack(0).startTimeMs].sort());
    // The OPEN day is never seeded.
    expect(starts).not.toContain(Date.UTC(2026, 8, 18));
  });
});
