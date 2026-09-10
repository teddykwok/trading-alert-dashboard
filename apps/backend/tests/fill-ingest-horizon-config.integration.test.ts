import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * The configured historical-fill horizon, and the one thing it is for.
 *
 * Two questions, deliberately in one file because the second is only meaningful
 * if the first holds: does the env schema turn operator text into a trustworthy
 * number, and does that number -- passed as an ordinary argument -- produce
 * exactly the canonical roots it claims?
 *
 * Nothing here schedules anything. There is no interval, no worker, no startup
 * hook and no automatic invocation: Phase 6 makes the horizon available, and
 * when ingestion actually runs is not decided here.
 */

const TAG = "horizon-config";
const SYMBOL = "HORIZONUSDT";
const KEY = "EXECUTION_FILL_INGEST_HORIZON_DAYS";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { DAY_MS, MIN_INGEST_HORIZON_DAYS, MAX_INGEST_HORIZON_DAYS } = await import(
  "../src/modules/execution/exchange-fill-day-roots"
);
const { ExchangeFillIngestWindowService } = await import(
  "../src/modules/execution/exchange-fill-ingest-window.service"
);
const { ExchangeFillRootBootstrap } = await import(
  "../src/modules/execution/exchange-fill-root-bootstrap.service"
);

const maybe = () => (available ? it : it.skip);

const NOW = new Date("2026-08-12T09:15:00.000Z");
const NEWEST_DAY_START = Date.UTC(2026, 7, 11);
const ORIGINAL = process.env[KEY];

let work: InstanceType<typeof ExchangeFillIngestWindowService>;
let sequence = 0;

/**
 * Re-parses the env schema with one value present or genuinely absent.
 *
 * The real module, not a mock: the schema IS the thing under test, and a stub
 * of it would prove only that the stub agrees with itself. `resetModules` makes
 * the module-level `safeParse` run again, which is also how a malformed value
 * reaches a caller in production -- as a throw at import, before anything runs.
 */
async function loadEnv(value: string | undefined) {
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  vi.resetModules();
  const { env } = await import("../src/config/env");
  return env;
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[KEY];
  else process.env[KEY] = ORIGINAL;
  vi.resetModules();
});

describe("horizon configuration", () => {
  it("defaults to 30 completed days when the key is absent", async () => {
    const env = await loadEnv(undefined);

    expect(env[KEY]).toBe(30);
    expect(typeof env[KEY]).toBe("number");
    expect(Number.isSafeInteger(env[KEY])).toBe(true);
  });

  it("accepts the domain's own boundaries and an ordinary value", async () => {
    for (const [text, expected] of [
      ["1", 1],
      ["7", 7],
      ["30", 30],
      ["60", 60],
    ] as const) {
      const env = await loadEnv(text);
      expect(env[KEY], text).toBe(expected);
    }
  });

  it("uses the domain constants rather than a second copy of the range", async () => {
    expect(MIN_INGEST_HORIZON_DAYS).toBe(1);
    expect(MAX_INGEST_HORIZON_DAYS).toBe(60);
    await expect(loadEnv(String(MIN_INGEST_HORIZON_DAYS))).resolves.toMatchObject({ [KEY]: 1 });
    await expect(loadEnv(String(MAX_INGEST_HORIZON_DAYS))).resolves.toMatchObject({ [KEY]: 60 });
    await expect(loadEnv(String(MAX_INGEST_HORIZON_DAYS + 1))).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it("trims, because every other validated string in the schema does", async () => {
    const env = await loadEnv("  30  ");
    expect(env[KEY]).toBe(30);
  });

  for (const bad of [
    "0",
    "61",
    "-1",
    "2.5",
    "2.0",
    "abc",
    "30days",
    " 30x ",
    "NaN",
    "Infinity",
    "",
    "1e2",
    "+30",
    "0x1E",
  ]) {
    it(`refuses ${JSON.stringify(bad)} at startup instead of guessing`, async () => {
      // The throw is the point: no clamp to 1 or 60, no fallback to 30, no
      // truncation of "2.5" to 2 and no prefix read of "30days" as 30.
      await expect(loadEnv(bad)).rejects.toThrow("Invalid environment variables");
    });
  }
});

/** A profile the test owns, with the policy a binding requires. */
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
  async () => ({ ok: true as const, context: { executionProfileId, environment: "TESTNET" } as never });

const bootstrapFor = (executionProfileId: string) =>
  new ExchangeFillRootBootstrap({
    prisma: prisma!,
    work,
    bindProfile: boundTo(executionProfileId),
  } as never);

const windowsOf = async (executionProfileId: string) =>
  prisma!.exchangeFillIngestWindow.findMany({
    where: { executionProfileId },
    orderBy: [{ symbol: "asc" }, { startTimeMs: "asc" }],
  });

const countWindows = async (executionProfileId: string) =>
  prisma!.exchangeFillIngestWindow.count({ where: { executionProfileId } });

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

/**
 * The whole integration contract, and all of it.
 *
 * Configuration produces a plain number; that number is handed to the approved
 * bootstrap as an ordinary argument, together with an explicit `now`. No clock
 * is read on either side of the boundary, which is what keeps the closed-UTC-day
 * result deterministic.
 */
describe("the configured horizon drives the bootstrap", () => {
  maybe()("the absent-key default of 30 produces 30 completed roots", async () => {
    const id = await profile("default");
    await execution(id, SYMBOL);

    const env = await loadEnv(undefined);
    const horizonDays: number = env[KEY];
    const result = await bootstrapFor(id).bootstrapHistoricalRoots({ now: NOW, horizonDays });

    expect(horizonDays).toBe(30);
    expect(result).toMatchObject({ horizonDays: 30, dayCount: 30, expectedRootCount: 30, createdCount: 30 });

    const rows = await windowsOf(id);
    expect(rows).toHaveLength(30);
    // Newest completed day is the 11th; the open 12th is absent entirely.
    expect(Number(rows[29]!.startTimeMs)).toBe(NEWEST_DAY_START);
    expect(Number(rows[0]!.startTimeMs)).toBe(NEWEST_DAY_START - 29 * DAY_MS);
    for (const row of rows) {
      expect(Number(row.endTimeMs)).toBeLessThan(Date.UTC(2026, 7, 12));
    }
  });

  maybe()("a configured 3 produces exactly 3 canonical roots", async () => {
    const id = await profile("custom");
    await execution(id, SYMBOL);

    const env = await loadEnv("3");
    const result = await bootstrapFor(id).bootstrapHistoricalRoots({
      now: NOW,
      horizonDays: env[KEY],
    });

    expect(env[KEY]).toBe(3);
    expect(result).toMatchObject({ horizonDays: 3, dayCount: 3, expectedRootCount: 3, createdCount: 3 });

    const rows = await windowsOf(id);
    expect(
      rows.map((row) => [
        new Date(Number(row.startTimeMs)).toISOString(),
        new Date(Number(row.endTimeMs)).toISOString(),
      ])
    ).toEqual([
      ["2026-08-09T00:00:00.000Z", "2026-08-09T23:59:59.999Z"],
      ["2026-08-10T00:00:00.000Z", "2026-08-10T23:59:59.999Z"],
      ["2026-08-11T00:00:00.000Z", "2026-08-11T23:59:59.999Z"],
    ]);
  });

  maybe()("the maximum horizon of 60 crosses the boundary intact", async () => {
    const id = await profile("max");
    await execution(id, SYMBOL);

    const env = await loadEnv("60");
    const result = await bootstrapFor(id).bootstrapHistoricalRoots({
      now: NOW,
      horizonDays: env[KEY],
    });

    expect(env[KEY]).toBe(MAX_INGEST_HORIZON_DAYS);
    expect(result).toMatchObject({ horizonDays: 60, dayCount: 60, expectedRootCount: 60, createdCount: 60 });
    expect(await countWindows(id)).toBe(60);
  });

  maybe()("a malformed horizon refuses before the bootstrap is ever invoked", async () => {
    const id = await profile("refused");
    await execution(id, SYMBOL);
    const service = bootstrapFor(id);
    const invoked = vi.spyOn(service, "bootstrapHistoricalRoots");

    // The production-shaped order: configuration is read FIRST, so a malformed
    // value never reaches a profile binding, a symbol query or a root write.
    await expect(
      (async () => {
        const env = await loadEnv("61");
        return service.bootstrapHistoricalRoots({ now: NOW, horizonDays: env[KEY] });
      })()
    ).rejects.toThrow("Invalid environment variables");

    expect(invoked).not.toHaveBeenCalled();
    expect(await countWindows(id)).toBe(0);
  });
});
