import { describe, expect, it, vi } from "vitest";

import {
  HistoricalFillBatchDriver,
  FillBatchRefusedError,
  USER_TRADES_REQUEST_WEIGHT,
  type FillIngestExecutionOutcome,
} from "../src/modules/execution/exchange-fill-batch-driver.service";
import type {
  HistoricalFillWeightReservation,
  HistoricalFillWeightReservationResult,
} from "../src/modules/execution/historical-fill-weight-budget.service";

/**
 * The SHARED ceiling, at the driver seam.
 *
 * Everything is scripted: the point is exactly WHEN the driver reserves,
 * when it releases, and what it does when it is refused. No database, no
 * Binance, no scheduler.
 *
 * The seam matters more than the arithmetic. `executeOne` is what claims a
 * window, so a denial that arrives before it costs nothing, and a denial that
 * arrived after it would have burned an ingest attempt for a reason having
 * nothing to do with the window.
 */

const PROFILE_ID = "profile-abc";
const BUCKET = new Date("2026-09-17T12:34:00.000Z");

const bootstrapped = {
  outcome: "BOOTSTRAPPED" as const,
  executionProfileId: PROFILE_ID,
  horizonDays: 30,
  symbolCount: 1,
  dayCount: 30,
  expectedRootCount: 30,
  alreadyCompatibleCount: 30,
  createdCount: 0,
  raceReconciledCount: 0,
};

function scripted(options: {
  outcomes?: FillIngestExecutionOutcome[];
  throwOn?: number;
  reserve?: () => Promise<HistoricalFillWeightReservationResult>;
  bootstrap?: unknown;
}) {
  const queue = [...(options.outcomes ?? [])];
  let calls = 0;
  const executeOne = vi.fn(async () => {
    calls += 1;
    if (options.throwOn === calls) throw new Error("executor exploded");
    const outcome = queue.shift() ?? "NO_WORK";
    return outcome === "PROFILE_UNAVAILABLE"
      ? { outcome, reasonCode: "PROFILE_NOT_FOUND" }
      : { outcome };
  });

  const granted: HistoricalFillWeightReservationResult = {
    outcome: "GRANTED",
    reservation: { executionProfileId: PROFILE_ID, bucketStart: BUCKET, weight: 5 },
  };
  const reserve = vi.fn(options.reserve ?? (async () => granted));
  const releaseCertainNonDispatch = vi.fn(async (_r: HistoricalFillWeightReservation) => undefined);

  const bootstrapHistoricalRoots = vi.fn(async () => options.bootstrap ?? bootstrapped);

  const driver = new HistoricalFillBatchDriver({
    bootstrap: { bootstrapHistoricalRoots } as never,
    executor: { executeOne } as never,
    weightBudget: { reserve, releaseCertainNonDispatch },
  });

  return { driver, executeOne, reserve, releaseCertainNonDispatch, bootstrapHistoricalRoots };
}

const run = (driver: HistoricalFillBatchDriver, overrides: Record<string, unknown> = {}) =>
  driver.runHistoricalFillBatch({
    workerId: "worker-1",
    now: new Date("2026-09-17T12:34:56.000Z"),
    horizonDays: 30,
    maxWindows: 5,
    maxUserTradesWeight: 25,
    globalUserTradesWeightPerMinute: 25,
    ...overrides,
  } as never);

describe("the shared ceiling gates every executor invocation", () => {
  it("C. a denial returns the global outcome and never calls the executor", async () => {
    const { driver, executeOne, reserve, releaseCertainNonDispatch } = scripted({
      reserve: async () => ({
        outcome: "EXHAUSTED",
        bucketStart: BUCKET,
        weightCap: 25,
        weightUsed: 25,
      }),
    });

    const result = await run(driver);

    expect(result.outcome).toBe("GLOBAL_USER_TRADES_WEIGHT_BUDGET_EXHAUSTED");
    // The load-bearing assertion: no executor invocation, therefore no claim,
    // therefore no ingest attempt burned.
    expect(executeOne).not.toHaveBeenCalled();
    expect(result.executionInvocations).toBe(0);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(releaseCertainNonDispatch).not.toHaveBeenCalled();
    // Nothing was spent locally either.
    expect(result.userTradesWeightUsed).toBe(0);
  });

  it("J. a cap mismatch is distinguishable from an exhausted ceiling", async () => {
    const { driver, executeOne } = scripted({
      reserve: async () => ({
        outcome: "CAP_MISMATCH",
        bucketStart: BUCKET,
        storedCap: 25,
        configuredCap: 50,
      }),
    });

    const result = await run(driver, { globalUserTradesWeightPerMinute: 50 });

    expect(result.outcome).toBe("GLOBAL_USER_TRADES_WEIGHT_CAP_MISMATCH");
    expect(executeOne).not.toHaveBeenCalled();
  });

  it("J. the global outcome is never confused with the local one", async () => {
    // A local budget of 5 affords exactly ONE dispatch. The first iteration
    // spends it on a post-dispatch outcome, so the second iteration stops on
    // the LOCAL ceiling -- and must say so, not blame the shared one.
    const { driver, reserve } = scripted({ outcomes: ["COMPLETE"] });

    const result = await run(driver, { maxUserTradesWeight: 5, maxWindows: 5 });

    // One dispatch is affordable, so it runs; the second iteration stops local.
    expect(result.outcome).toBe("USER_TRADES_WEIGHT_BUDGET_EXHAUSTED");
    expect(result.outcome).not.toBe("GLOBAL_USER_TRADES_WEIGHT_BUDGET_EXHAUSTED");
    // Exactly one reservation: the local stop happened before a second.
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it("B. the local stop precedes any shared coordination mutation", async () => {
    const { driver, reserve, executeOne } = scripted({});

    // maxWindows 0 is refused outright; use a budget too small for one dispatch.
    await expect(run(driver, { maxUserTradesWeight: 4 })).rejects.toBeInstanceOf(
      FillBatchRefusedError
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(executeOne).not.toHaveBeenCalled();
  });
});

describe("release happens exactly when a dispatch is proven not to have happened", () => {
  it("D. NO_WORK releases the shared reservation and refunds locally", async () => {
    const { driver, executeOne, reserve, releaseCertainNonDispatch } = scripted({
      outcomes: ["NO_WORK"],
    });

    const result = await run(driver);

    expect(result.outcome).toBe("NO_WORK");
    expect(executeOne).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(releaseCertainNonDispatch).toHaveBeenCalledTimes(1);
    expect(releaseCertainNonDispatch).toHaveBeenCalledWith({
      executionProfileId: PROFILE_ID,
      bucketStart: BUCKET,
      weight: 5,
    });
    // The existing local refund is preserved exactly.
    expect(result.userTradesWeightUsed).toBe(0);
  });

  it("E. PROFILE_UNAVAILABLE from the executor releases too", async () => {
    const { driver, releaseCertainNonDispatch } = scripted({ outcomes: ["PROFILE_UNAVAILABLE"] });

    const result = await run(driver);

    expect(result.outcome).toBe("PROFILE_UNAVAILABLE");
    expect(releaseCertainNonDispatch).toHaveBeenCalledTimes(1);
    expect(result.userTradesWeightUsed).toBe(0);
  });

  const POST_DISPATCH: FillIngestExecutionOutcome[] = [
    "COMPLETE",
    "INCOMPLETE_SKIPPED_ROWS",
    "SPLIT",
    "SATURATED_SINGLE_MILLISECOND",
    "RETRY_SCHEDULED",
    "ABANDONED",
    "STALE_CLAIM",
  ];

  for (const outcome of POST_DISPATCH) {
    it(`F. ${outcome} keeps the reservation: the request reached the exchange`, async () => {
      const { driver, reserve, releaseCertainNonDispatch } = scripted({
        outcomes: [outcome, "NO_WORK"],
      });

      const result = await run(driver);

      expect(reserve).toHaveBeenCalledTimes(2);
      // Exactly one release, for the trailing NO_WORK — never for this outcome.
      expect(releaseCertainNonDispatch).toHaveBeenCalledTimes(1);
      expect(result.userTradesWeightUsed).toBe(USER_TRADES_REQUEST_WEIGHT);
    });
  }

  it("G. an executor throw keeps the reservation: uncertain dispatch is spent", async () => {
    const { driver, reserve, releaseCertainNonDispatch } = scripted({ throwOn: 1 });

    await expect(run(driver)).rejects.toThrow("executor exploded");

    expect(reserve).toHaveBeenCalledTimes(1);
    // No compensating refund. An invocation that threw may or may not have
    // dispatched, and an under-count spends the account's allowance twice.
    expect(releaseCertainNonDispatch).not.toHaveBeenCalled();
  });
});

describe("the rest of the driver contract is unchanged", () => {
  it("A. a bootstrap that cannot name the account reserves nothing", async () => {
    const { driver, reserve, executeOne } = scripted({
      bootstrap: { outcome: "PROFILE_UNAVAILABLE", reasonCode: "PROFILE_NOT_CONFIGURED" },
    });

    const result = await run(driver);

    expect(result.outcome).toBe("PROFILE_UNAVAILABLE");
    // The bucket is profile-scoped, so there is no account to charge and no
    // coordination row is created.
    expect(reserve).not.toHaveBeenCalled();
    expect(executeOne).not.toHaveBeenCalled();
  });

  it("A. the reservation is charged to the bootstrap's own profile", async () => {
    const { driver, reserve } = scripted({ outcomes: ["NO_WORK"] });

    await run(driver);

    expect(reserve).toHaveBeenCalledWith({ executionProfileId: PROFILE_ID, weightCap: 25 });
  });

  it("H. maxWindows precedence is unchanged", async () => {
    const { driver, executeOne, reserve } = scripted({
      outcomes: ["COMPLETE", "COMPLETE", "COMPLETE"],
    });

    const result = await run(driver, { maxWindows: 3, maxUserTradesWeight: 100 });

    expect(result.outcome).toBe("MAX_WINDOWS_REACHED");
    expect(executeOne).toHaveBeenCalledTimes(3);
    expect(reserve).toHaveBeenCalledTimes(3);
  });

  it("I. accounting stays exactly five per retained dispatch", async () => {
    const { driver } = scripted({ outcomes: ["COMPLETE", "SPLIT", "NO_WORK"] });

    const result = await run(driver, { maxUserTradesWeight: 100 });

    expect(result.userTradesWeightUsed).toBe(2 * USER_TRADES_REQUEST_WEIGHT);
    expect(result.userTradesRequestWeightPerDispatch).toBe(5);
  });

  it("a driver with no shared budget behaves exactly as before", async () => {
    const executeOne = vi.fn(async () => ({ outcome: "NO_WORK" as const }));
    const driver = new HistoricalFillBatchDriver({
      bootstrap: { bootstrapHistoricalRoots: vi.fn(async () => bootstrapped) } as never,
      executor: { executeOne } as never,
    });

    const result = await driver.runHistoricalFillBatch({
      workerId: "worker-1",
      now: new Date(),
      horizonDays: 30,
      maxWindows: 5,
      maxUserTradesWeight: 25,
    });

    expect(result.outcome).toBe("NO_WORK");
    expect(executeOne).toHaveBeenCalledTimes(1);
  });

  it("refuses a wired budget with no cap, and a cap with no budget", async () => {
    const { driver } = scripted({});
    await expect(run(driver, { globalUserTradesWeightPerMinute: undefined })).rejects.toBeInstanceOf(
      FillBatchRefusedError
    );

    const bare = new HistoricalFillBatchDriver({
      bootstrap: { bootstrapHistoricalRoots: vi.fn(async () => bootstrapped) } as never,
      executor: { executeOne: vi.fn() } as never,
    });
    await expect(
      bare.runHistoricalFillBatch({
        workerId: "w",
        now: new Date(),
        horizonDays: 30,
        maxWindows: 5,
        maxUserTradesWeight: 25,
        globalUserTradesWeightPerMinute: 25,
      })
    ).rejects.toBeInstanceOf(FillBatchRefusedError);
  });
});

describe("the frozen surfaces stayed frozen, and nothing runs by default", () => {
  const read = async (relative: string) =>
    (await import("node:fs")).readFileSync(relative, "utf8");


  it("the shared ceiling is enforced at the driver, never inside the executor", async () => {
    // The executor is the one place that claims a window. Gating there would
    // have burned an ingest attempt on a denial; gating at the driver cannot.
    const executor = await read("src/modules/execution/exchange-fill-one-window-executor.service.ts");
    for (const leaked of [
      "WeightBudget", "weightBudget", "reserve(", "bucketStart",
      "GLOBAL_USER_TRADES", "releaseCertainNonDispatch",
    ]) {
      expect(executor).not.toContain(leaked);
    }

    const work = await read("src/modules/execution/exchange-fill-ingest-window.service.ts");
    expect(work).not.toContain("weightBudget");
    expect(work).not.toContain("HistoricalFillWeightBucket");

    const reader = await read("src/modules/binance/binance-read-only.service.ts");
    expect(reader).not.toContain("weightBudget");
    expect(reader).not.toContain("historicalFillWeightBucket");
  });

  it("the budget service reaches no exchange, no scheduler and no window", async () => {
    const service = await read("src/modules/execution/historical-fill-weight-budget.service.ts");
    // Code-shaped tokens only: the file's own prose explains what it does NOT
    // limit, so a bare word search would find the promise, not a breach.
    for (const forbidden of [
      'from "../binance', "listRecentTrades(", "fetch(", "axios",
      "claimNextWindow(", "executeOne(", "setInterval(", "new PrismaClient(",
    ]) {
      expect(service).not.toContain(forbidden);
    }
  });

  it("a runtime-disabled process performs zero coordination work", async () => {
    // Dormancy is a property of the RUNNER, which returns before building a
    // driver at all -- so a disabled process cannot reach a reservation even
    // though this slice added one. Proven here at the seam: no driver, no
    // batch, therefore no bucket row and no query.
    const runtime = await read("src/modules/jobs/historical-fill-runtime.ts");
    expect(runtime).toContain('if (!enabled) return { status: "DISABLED" };');
    expect(runtime).not.toContain("weightBudget");
    expect(runtime).not.toContain("historicalFillWeightBucket");

    // And the scheduler still reaches the driver only through that runner.
    const scheduler = await read("src/modules/jobs/historical-fill.scheduler.ts");
    expect(scheduler).toContain("runHistoricalFillRuntimeTick");
    expect(scheduler).not.toContain("weightBudget");
    expect(scheduler).not.toContain("new HistoricalFillBatchDriver");
    expect(scheduler).not.toContain("exchange-fill-batch-driver");
  });

  it("no production module starts the scheduler, so nothing reaches any of this", async () => {
    for (const file of [
      "src/modules/jobs/vision-analysis.worker.ts",
      "src/server.ts",
      "src/app.ts",
    ]) {
      const source = await read(file);
      expect(source).not.toContain("historical-fill");
      expect(source).not.toContain("HistoricalFillWeightBudget");
    }
  });
});
