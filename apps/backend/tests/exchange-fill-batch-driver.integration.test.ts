import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * The bounded historical-fill driver.
 *
 * Two layers, deliberately. Most of this file scripts the executor's outcome
 * union directly, because the questions being asked -- how many times did it
 * ask, and what made it stop -- are questions about the DRIVER, and a real
 * exchange window cannot be made to return STALE_CLAIM on demand. One narrow
 * test then runs the real bootstrap and the real one-window executor against a
 * real Postgres, with only the exchange page reader faked, to prove the typed
 * handoff actually holds between the real components.
 *
 * No Binance request is made anywhere in this file or in the code under test,
 * and nothing here schedules anything.
 */

const TAG = "batch-driver";
const SYMBOL = "BATCHUSDT";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ExchangeFillLedgerService } = await import(
  "../src/modules/execution/exchange-fill-ledger.service"
);
const { ExchangeFillIngestWindowService, INGEST_CLAIM_LEASE_MS } = await import(
  "../src/modules/execution/exchange-fill-ingest-window.service"
);
const { ExchangeFillOneWindowExecutor, INGEST_RETRY_BACKOFF_MS } = await import(
  "../src/modules/execution/exchange-fill-one-window-executor.service"
);
const { BinanceError } = await import("../src/modules/binance/binance.errors");
const { ExchangeFillRootBootstrap } = await import(
  "../src/modules/execution/exchange-fill-root-bootstrap.service"
);
const { HistoricalFillBatchDriver, FillBatchRefusedError } = await import(
  "../src/modules/execution/exchange-fill-batch-driver.service"
);

const maybe = () => (available ? it : it.skip);

const NOW = new Date("2026-08-12T09:15:00.000Z");
const WORKER = "worker-a";

let work: InstanceType<typeof ExchangeFillIngestWindowService>;
let ledger: InstanceType<typeof ExchangeFillLedgerService>;
let sequence = 0;

/** A bootstrap that answers once, and records how often it was asked. */
function scriptedBootstrap(result: Record<string, unknown>) {
  const calls: Array<{ now: Date; horizonDays: number }> = [];
  return {
    calls,
    bootstrapHistoricalRoots: vi.fn(async (options: { now: Date; horizonDays: number }) => {
      calls.push(options);
      return result;
    }),
  };
}

const bootstrapped = {
  outcome: "BOOTSTRAPPED",
  executionProfileId: "profile-1",
  horizonDays: 2,
  symbolCount: 1,
  dayCount: 2,
  expectedRootCount: 2,
  alreadyCompatibleCount: 0,
  createdCount: 2,
  raceReconciledCount: 0,
} as const;

/**
 * An executor that returns a scripted outcome per call.
 *
 * Running past the end of the script THROWS rather than repeating the last
 * answer: an extra invocation is exactly the defect these tests exist to catch,
 * and a silent repeat would hide it.
 */
function scriptedExecutor(script: Array<Record<string, unknown>>) {
  const calls: Array<{ workerId: string; now?: Date; forwardedNowKey: boolean }> = [];
  return {
    calls,
    executeOne: vi.fn(async (options: { workerId: string; now?: Date }) => {
      calls.push({ ...options, forwardedNowKey: "now" in options });
      const next = script[calls.length - 1];
      if (next === undefined) {
        throw new Error(`executor invoked ${calls.length} times but only ${script.length} scripted`);
      }
      return next;
    }),
  };
}

const driverWith = (
  bootstrap: ReturnType<typeof scriptedBootstrap>,
  executor: ReturnType<typeof scriptedExecutor>
) => new HistoricalFillBatchDriver({ bootstrap, executor } as never);

const outcome = (name: string, extra: Record<string, unknown> = {}) => ({ outcome: name, ...extra });

/** Every count zero except the named ones. */
const counts = (overrides: Record<string, number> = {}) => ({
  COMPLETE: 0,
  INCOMPLETE_SKIPPED_ROWS: 0,
  SPLIT: 0,
  SATURATED_SINGLE_MILLISECOND: 0,
  RETRY_SCHEDULED: 0,
  ABANDONED: 0,
  STALE_CLAIM: 0,
  ...overrides,
});

describe("the bound is the whole point", () => {
  it("stops at maxWindows = 1 even when more work is available", async () => {
    const bootstrap = scriptedBootstrap(bootstrapped);
    // Two answers scripted, one slot allowed: a second call throws.
    const executor = scriptedExecutor([outcome("COMPLETE"), outcome("COMPLETE")]);

    const result = await driverWith(bootstrap, executor).runHistoricalFillBatch({
      workerId: WORKER,
      now: NOW,
      horizonDays: 2,
      maxWindows: 1,
      maxUserTradesWeight: 500,
    });

    expect(executor.calls).toHaveLength(1);
    expect(result).toEqual({
      outcome: "MAX_WINDOWS_REACHED",
      bootstrap: bootstrapped,
      executionInvocations: 1,
      outcomes: counts({ COMPLETE: 1 }),
      userTradesRequestWeightPerDispatch: 5,
      userTradesWeightBudget: 500,
      userTradesWeightUsed: 5,
      userTradesWeightRemaining: 495,
    });
  });

  it("never exceeds maxWindows = 3", async () => {
    const bootstrap = scriptedBootstrap(bootstrapped);
    const executor = scriptedExecutor([
      outcome("COMPLETE"),
      outcome("SPLIT"),
      outcome("COMPLETE"),
    ]);

    const result = await driverWith(bootstrap, executor).runHistoricalFillBatch({
      workerId: WORKER,
      now: NOW,
      horizonDays: 2,
      maxWindows: 3,
      maxUserTradesWeight: 500,
    });

    expect(executor.calls).toHaveLength(3);
    expect(result.executionInvocations).toBe(3);
    expect(result.outcome).toBe("MAX_WINDOWS_REACHED");
  });

  it("stops after exactly four when the work never runs out", async () => {
    const bootstrap = scriptedBootstrap(bootstrapped);
    const executor = scriptedExecutor([
      outcome("COMPLETE"),
      outcome("COMPLETE"),
      outcome("COMPLETE"),
      outcome("COMPLETE"),
    ]);

    const result = await driverWith(bootstrap, executor).runHistoricalFillBatch({
      workerId: WORKER,
      now: NOW,
      horizonDays: 2,
      maxWindows: 4,
      maxUserTradesWeight: 500,
    });

    expect(executor.calls).toHaveLength(4);
    expect(result).toEqual({
      outcome: "MAX_WINDOWS_REACHED",
      bootstrap: bootstrapped,
      executionInvocations: 4,
      outcomes: counts({ COMPLETE: 4 }),
      userTradesRequestWeightPerDispatch: 5,
      userTradesWeightBudget: 500,
      userTradesWeightUsed: 20,
      userTradesWeightRemaining: 480,
    });
  });

  for (const maxWindows of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`refuses maxWindows=${String(maxWindows)} before bootstrapping or executing`, async () => {
      const bootstrap = scriptedBootstrap(bootstrapped);
      const executor = scriptedExecutor([outcome("COMPLETE")]);

      await expect(
        driverWith(bootstrap, executor).runHistoricalFillBatch({
          workerId: WORKER,
          now: NOW,
          horizonDays: 2,
          maxWindows,
          maxUserTradesWeight: 500,
        })
      ).rejects.toBeInstanceOf(FillBatchRefusedError);

      // No clamp to 1, and nothing was created or requested on the way to
      // finding out the bound was unusable.
      expect(bootstrap.calls).toHaveLength(0);
      expect(executor.calls).toHaveLength(0);
    });
  }
});

describe("stopping", () => {
  it("stops the moment the queue reports NO_WORK", async () => {
    const bootstrap = scriptedBootstrap(bootstrapped);
    const executor = scriptedExecutor([
      outcome("COMPLETE"),
      outcome("COMPLETE"),
      outcome("NO_WORK"),
    ]);

    const result = await driverWith(bootstrap, executor).runHistoricalFillBatch({
      workerId: WORKER,
      now: NOW,
      horizonDays: 2,
      maxWindows: 10,
      maxUserTradesWeight: 500,
    });

    // Three invocations out of a budget of ten: no spin on an empty queue.
    expect(executor.calls).toHaveLength(3);
    expect(result).toEqual({
      outcome: "NO_WORK",
      bootstrap: bootstrapped,
      executionInvocations: 3,
      outcomes: counts({ COMPLETE: 2 }),
      userTradesRequestWeightPerDispatch: 5,
      userTradesWeightBudget: 500,
      userTradesWeightUsed: 10,
      userTradesWeightRemaining: 490,
    });
  });

  it("performs zero executor calls when the bootstrap cannot bind a profile", async () => {
    const bootstrap = scriptedBootstrap({
      outcome: "PROFILE_UNAVAILABLE",
      reasonCode: "PROFILE_POLICY_MISSING",
    });
    const executor = scriptedExecutor([outcome("COMPLETE")]);

    const result = await driverWith(bootstrap, executor).runHistoricalFillBatch({
      workerId: WORKER,
      now: NOW,
      horizonDays: 2,
      maxWindows: 5,
      maxUserTradesWeight: 500,
    });

    expect(executor.calls).toHaveLength(0);
    expect(result).toEqual({
      outcome: "PROFILE_UNAVAILABLE",
      stage: "BOOTSTRAP",
      // The binder's own code, not a flattened one.
      reasonCode: "PROFILE_POLICY_MISSING",
      bootstrap: null,
      executionInvocations: 0,
      outcomes: counts(),
      userTradesRequestWeightPerDispatch: 5,
      userTradesWeightBudget: 500,
      userTradesWeightUsed: 0,
      userTradesWeightRemaining: 500,
    });
  });

  it("stops immediately when an executor loses the profile mid-pass", async () => {
    const bootstrap = scriptedBootstrap(bootstrapped);
    const executor = scriptedExecutor([
      outcome("COMPLETE"),
      outcome("PROFILE_UNAVAILABLE", { reasonCode: "PROFILE_ENVIRONMENT_MISMATCH" }),
    ]);

    const result = await driverWith(bootstrap, executor).runHistoricalFillBatch({
      workerId: WORKER,
      now: NOW,
      horizonDays: 2,
      maxWindows: 9,
      maxUserTradesWeight: 500,
    });

    // Two of nine spent, and the third never happened.
    expect(executor.calls).toHaveLength(2);
    expect(result).toEqual({
      outcome: "PROFILE_UNAVAILABLE",
      stage: "EXECUTION",
      reasonCode: "PROFILE_ENVIRONMENT_MISMATCH",
      bootstrap: bootstrapped,
      executionInvocations: 2,
      outcomes: counts({ COMPLETE: 1 }),
      userTradesRequestWeightPerDispatch: 5,
      userTradesWeightBudget: 500,
      userTradesWeightUsed: 5,
      userTradesWeightRemaining: 495,
    });
  });
});

describe("durable outcomes do not end the pass", () => {
  it("carries on after a retry without touching its timing", async () => {
    const bootstrap = scriptedBootstrap(bootstrapped);
    const executor = scriptedExecutor([
      outcome("RETRY_SCHEDULED", { windowId: "w1", reasonCode: "RATE_LIMITED" }),
      outcome("COMPLETE", { windowId: "w2" }),
      outcome("NO_WORK"),
    ]);

    const started = Date.now();
    const result = await driverWith(bootstrap, executor).runHistoricalFillBatch({
      workerId: WORKER,
      now: NOW,
      horizonDays: 2,
      maxWindows: 6,
      maxUserTradesWeight: 500,
    });

    expect(executor.calls).toHaveLength(3);
    expect(result.outcomes).toEqual(counts({ RETRY_SCHEDULED: 1, COMPLETE: 1 }));
    // It simply asked again, without sleeping. It also did not hand the
    // executor a timestamp: the window it just backed off is kept out of reach
    // by the durable `nextEligibleAt` the executor persisted from ITS OWN
    // clock, which is the only clock other workers can compare against.
    expect(Date.now() - started).toBeLessThan(1000);
    for (const call of executor.calls) {
      expect(call.now).toBeUndefined();
      expect(call.workerId).toBe(WORKER);
    }
  });

  it("counts every durable outcome exactly once and ends on NO_WORK", async () => {
    const bootstrap = scriptedBootstrap(bootstrapped);
    const executor = scriptedExecutor([
      outcome("COMPLETE"),
      outcome("SPLIT"),
      outcome("STALE_CLAIM"),
      outcome("INCOMPLETE_SKIPPED_ROWS"),
      outcome("SATURATED_SINGLE_MILLISECOND"),
      outcome("ABANDONED"),
      outcome("RETRY_SCHEDULED"),
      outcome("NO_WORK"),
    ]);

    const result = await driverWith(bootstrap, executor).runHistoricalFillBatch({
      workerId: WORKER,
      now: NOW,
      horizonDays: 2,
      maxWindows: 20,
      maxUserTradesWeight: 500,
    });

    expect(executor.calls).toHaveLength(8);
    expect(result).toEqual({
      outcome: "NO_WORK",
      bootstrap: bootstrapped,
      executionInvocations: 8,
      outcomes: counts({
        COMPLETE: 1,
        SPLIT: 1,
        STALE_CLAIM: 1,
        INCOMPLETE_SKIPPED_ROWS: 1,
        SATURATED_SINGLE_MILLISECOND: 1,
        ABANDONED: 1,
        RETRY_SCHEDULED: 1,
      }),
      userTradesRequestWeightPerDispatch: 5,
      userTradesWeightBudget: 500,
      userTradesWeightUsed: 35,
      userTradesWeightRemaining: 465,
    });
    // Conservation: seven counted windows plus the one call that said NO_WORK.
    const counted = Object.values(result.outcomes).reduce((a, b) => a + b, 0);
    expect(counted + 1).toBe(result.executionInvocations);
  });
});

describe("the batch clock and the execution clock are different clocks", () => {
  it("freezes the caller's instant for the bootstrap and only the bootstrap", async () => {
    const bootstrap = scriptedBootstrap(bootstrapped);
    const executor = scriptedExecutor([outcome("COMPLETE"), outcome("COMPLETE"), outcome("NO_WORK")]);

    await driverWith(bootstrap, executor).runHistoricalFillBatch({
      workerId: WORKER,
      now: NOW,
      horizonDays: 4,
      maxWindows: 9,
      maxUserTradesWeight: 500,
    });

    // Which UTC days are complete is a question about a fixed moment.
    expect(bootstrap.calls).toEqual([{ now: NOW, horizonDays: 4 }]);
  });

  it("never pins an executor invocation to the batch timestamp", async () => {
    const bootstrap = scriptedBootstrap(bootstrapped);
    const executor = scriptedExecutor([
      outcome("COMPLETE"),
      outcome("RETRY_SCHEDULED"),
      outcome("COMPLETE"),
      outcome("NO_WORK"),
    ]);

    await driverWith(bootstrap, executor).runHistoricalFillBatch({
      workerId: WORKER,
      now: NOW,
      horizonDays: 2,
      maxWindows: 9,
      maxUserTradesWeight: 500,
    });

    expect(executor.calls).toHaveLength(4);
    for (const call of executor.calls) {
      // Not merely "not NOW" -- the key is absent entirely, so the executor
      // takes its own instant per invocation however long the pass has run.
      expect(call.forwardedNowKey).toBe(false);
      expect(call.now).toBeUndefined();
      expect(call.workerId).toBe(WORKER);
    }
  });
});

describe("the bootstrap runs once per pass", () => {
  it("is asked exactly once however many windows are worked", async () => {
    const bootstrap = scriptedBootstrap(bootstrapped);
    const executor = scriptedExecutor([
      outcome("COMPLETE"),
      outcome("COMPLETE"),
      outcome("COMPLETE"),
      outcome("COMPLETE"),
      outcome("COMPLETE"),
      outcome("NO_WORK"),
    ]);

    await driverWith(bootstrap, executor).runHistoricalFillBatch({
      workerId: WORKER,
      now: NOW,
      horizonDays: 7,
      maxWindows: 20,
      maxUserTradesWeight: 500,
    });

    expect(executor.calls).toHaveLength(6);
    // Once. Roots are idempotent, so re-deriving them per window would buy
    // nothing and cost a full horizon scan each time.
    expect(bootstrap.calls).toEqual([{ now: NOW, horizonDays: 7 }]);
  });
});

describe("errors are not outcomes", () => {
  it("propagates a bootstrap failure and executes nothing", async () => {
    const failure = new Error("connection terminated unexpectedly");
    const bootstrap = {
      calls: [],
      bootstrapHistoricalRoots: vi.fn(async () => {
        throw failure;
      }),
    };
    const executor = scriptedExecutor([outcome("COMPLETE")]);

    await expect(
      driverWith(bootstrap as never, executor).runHistoricalFillBatch({
        workerId: WORKER,
        now: NOW,
        horizonDays: 2,
        maxWindows: 5,
        maxUserTradesWeight: 500,
      })
    ).rejects.toBe(failure);

    // Not turned into NO_WORK, and not one window touched.
    expect(executor.calls).toHaveLength(0);
  });

  it("propagates an executor failure without a further invocation", async () => {
    const failure = new Error("could not serialize access due to concurrent update");
    const bootstrap = scriptedBootstrap(bootstrapped);
    const calls: Array<{ workerId: string; now: Date }> = [];
    const executor = {
      calls,
      executeOne: vi.fn(async (options: { workerId: string; now: Date }) => {
        calls.push(options);
        if (calls.length === 2) throw failure;
        return outcome("COMPLETE");
      }),
    };

    await expect(
      driverWith(bootstrap, executor as never).runHistoricalFillBatch({
        workerId: WORKER,
        now: NOW,
        horizonDays: 2,
        maxWindows: 5,
        maxUserTradesWeight: 500,
      })
    ).rejects.toBe(failure);

    expect(calls).toHaveLength(2);
  });
});

/** A profile the real bootstrap and the real executor can both be bound to. */
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

beforeAll(async () => {
  if (!prisma || !available) return;
  work = new ExchangeFillIngestWindowService(prisma);
  ledger = new ExchangeFillLedgerService(prisma);
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
    await prisma.exchangeFillLedger.deleteMany({
      where: { executionProfileId: { in: profiles } },
    });
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
 * The real components, wired together, against a real Postgres.
 *
 * Only the exchange page reader is faked -- it is the one edge that would leave
 * the machine. Everything else is the approved code: the bootstrap derives and
 * creates the roots, the executor claims them through the real durable queue,
 * and the driver only decides how many times to ask.
 */
describe("real bootstrap and real executor, bounded", () => {
  maybe()("turns configured history into durable, worked windows", async () => {
    const executionProfileId = await profile("end-to-end");
    await execution(executionProfileId, SYMBOL);

    const readerCalls: string[] = [];
    const reader = {
      listRecentTrades: vi.fn(async () => {
        throw new Error("the executor must never use the retrying entry point");
      }),
      // An empty page is a short page, which proves the interval exhausted.
      listRecentTradesOnce: vi.fn(async (symbol: string) => {
        readerCalls.push(symbol);
        return [];
      }),
    };

    const bootstrap = new ExchangeFillRootBootstrap({
      prisma: prisma!,
      work,
      bindProfile: boundTo(executionProfileId),
    } as never);
    const executor = new ExchangeFillOneWindowExecutor({
      prisma: prisma!,
      reader,
      ledger,
      work,
      bindProfile: boundTo(executionProfileId),
    } as never);

    const result = await new HistoricalFillBatchDriver({ bootstrap, executor }).runHistoricalFillBatch(
      { workerId: WORKER, now: NOW, horizonDays: 2, maxWindows: 5, maxUserTradesWeight: 500 }
    );

    // Two canonical roots existed because the bootstrap made them, and the
    // driver spent three of its five slots: two windows plus the empty answer.
    expect(result.outcome).toBe("NO_WORK");
    if (result.outcome !== "NO_WORK") throw new Error("unreachable");
    expect(result.bootstrap).toMatchObject({
      outcome: "BOOTSTRAPPED",
      executionProfileId,
      symbolCount: 1,
      dayCount: 2,
      createdCount: 2,
    });
    expect(result.executionInvocations).toBe(3);
    expect(result.outcomes).toEqual(counts({ COMPLETE: 2 }));

    // One faked exchange read per window, and no real request anywhere.
    expect(readerCalls).toEqual([SYMBOL, SYMBOL]);

    const rows = await prisma!.exchangeFillIngestWindow.findMany({
      where: { executionProfileId },
      orderBy: { startTimeMs: "asc" },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("COMPLETE");
      expect(row.attempts).toBe(1);
      expect(row.claimOwner).toBeNull();
    }
  });

  maybe()("respects the bound against real durable work", async () => {
    const executionProfileId = await profile("bounded");
    await execution(executionProfileId, SYMBOL);

    const reader = {
      listRecentTrades: vi.fn(),
      listRecentTradesOnce: vi.fn(async () => []),
    };
    const bootstrap = new ExchangeFillRootBootstrap({
      prisma: prisma!,
      work,
      bindProfile: boundTo(executionProfileId),
    } as never);
    const executor = new ExchangeFillOneWindowExecutor({
      prisma: prisma!,
      reader,
      ledger,
      work,
      bindProfile: boundTo(executionProfileId),
    } as never);

    // Five days of roots, but only two slots to spend on them.
    const result = await new HistoricalFillBatchDriver({ bootstrap, executor }).runHistoricalFillBatch(
      { workerId: WORKER, now: NOW, horizonDays: 5, maxWindows: 2, maxUserTradesWeight: 500 }
    );

    expect(result.outcome).toBe("MAX_WINDOWS_REACHED");
    expect(result.executionInvocations).toBe(2);
    expect(reader.listRecentTradesOnce).toHaveBeenCalledTimes(2);

    const done = await prisma!.exchangeFillIngestWindow.count({
      where: { executionProfileId, status: "COMPLETE" },
    });
    const pending = await prisma!.exchangeFillIngestWindow.count({
      where: { executionProfileId, status: "PENDING" },
    });
    // The rest stayed durable and untouched, waiting for another pass.
    expect(done).toBe(2);
    expect(pending).toBe(3);
  });
});

/**
 * The lease and the backoff are written for OTHER workers to read.
 *
 * Both are compared against real time by processes that never saw this batch's
 * `now`, so the only safe value to stamp them with is the instant the write
 * actually happened. `NOW` here is deliberately weeks in the past: if the
 * driver were still forwarding it, every timestamp below would land there and
 * the assertions would be unmistakable about it.
 */
describe("durable timestamps come from the execution clock", () => {
  maybe()("stamps a lease with real time, not the batch timestamp", async () => {
    const executionProfileId = await profile("lease-safety");
    await execution(executionProfileId, SYMBOL);
    const reader = { listRecentTrades: vi.fn(), listRecentTradesOnce: vi.fn(async () => []) };

    const before = Date.now();
    await new HistoricalFillBatchDriver({
      bootstrap: new ExchangeFillRootBootstrap({
        prisma: prisma!, work, bindProfile: boundTo(executionProfileId),
      } as never),
      executor: new ExchangeFillOneWindowExecutor({
        prisma: prisma!, reader, ledger, work, bindProfile: boundTo(executionProfileId),
      } as never),
    }).runHistoricalFillBatch({ workerId: WORKER, now: NOW, horizonDays: 2, maxWindows: 5, maxUserTradesWeight: 500 });
    const after = Date.now();

    const rows = await prisma!.exchangeFillIngestWindow.findMany({ where: { executionProfileId } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const stamped = row.lastAttemptAt!.getTime();
      // Written during the pass, by the executor's own clock.
      expect(stamped).toBeGreaterThanOrEqual(before);
      expect(stamped).toBeLessThanOrEqual(after);
      // A second worker computing `realNow - INGEST_CLAIM_LEASE_MS` sees a
      // LIVE lease here...
      expect(after - stamped).toBeLessThan(INGEST_CLAIM_LEASE_MS);
      // ...whereas the batch timestamp is far past that threshold, which is
      // exactly the window-stealing the old forwarding would have opened.
      expect(after - NOW.getTime()).toBeGreaterThan(INGEST_CLAIM_LEASE_MS);
      expect(stamped).not.toBe(NOW.getTime());
    }
  });

  maybe()("measures a retry backoff from real time, not the batch timestamp", async () => {
    const executionProfileId = await profile("retry-backoff");
    await execution(executionProfileId, SYMBOL);
    const reader = {
      listRecentTrades: vi.fn(),
      listRecentTradesOnce: vi.fn(async () => {
        throw new BinanceError({ kind: "SERVER" as never, message: "boom", endpoint: "userTrades" });
      }),
    };

    const before = Date.now();
    const result = await new HistoricalFillBatchDriver({
      bootstrap: new ExchangeFillRootBootstrap({
        prisma: prisma!, work, bindProfile: boundTo(executionProfileId),
      } as never),
      executor: new ExchangeFillOneWindowExecutor({
        prisma: prisma!, reader, ledger, work, bindProfile: boundTo(executionProfileId),
      } as never),
    }).runHistoricalFillBatch({ workerId: WORKER, now: NOW, horizonDays: 2, maxWindows: 5, maxUserTradesWeight: 500 });
    const after = Date.now();

    expect(result.outcomes).toEqual(counts({ RETRY_SCHEDULED: 2 }));

    const rows = await prisma!.exchangeFillIngestWindow.findMany({ where: { executionProfileId } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const eligible = row.nextEligibleAt!.getTime();
      // A full backoff measured from when the failure actually happened.
      expect(eligible).toBeGreaterThanOrEqual(before + INGEST_RETRY_BACKOFF_MS);
      expect(eligible).toBeLessThanOrEqual(after + INGEST_RETRY_BACKOFF_MS);
      // Anchored to the batch start it would already be due -- a backoff that
      // expired before it began.
      expect(eligible).not.toBe(NOW.getTime() + INGEST_RETRY_BACKOFF_MS);
      expect(eligible).toBeGreaterThan(Date.now());
    }
  });
});
