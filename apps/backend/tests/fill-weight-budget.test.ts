import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The per-batch userTrades request-weight budget.
 *
 * Two questions: does configuration turn operator text into a trustworthy
 * ceiling, and does the bounded driver refuse to start an invocation it cannot
 * afford? Both are answered with scripted bootstrap/executor dependencies --
 * what is under test is the driver's budgeting policy, not claiming or the
 * exchange, and no Binance client is imported anywhere in this file.
 *
 * The budget covers GET /fapi/v1/userTrades and nothing else. It is not an
 * account or IP rate limiter, and no test here pretends otherwise.
 */

const WEIGHT_KEY = "EXECUTION_FILL_BATCH_MAX_USER_TRADES_WEIGHT";
const ORIGINAL = process.env[WEIGHT_KEY];

const { BINANCE_READ_ONLY_ENDPOINTS } = await import("../src/modules/binance/binance.endpoints");
const { HistoricalFillBatchDriver, USER_TRADES_REQUEST_WEIGHT, FillBatchRefusedError } =
  await import("../src/modules/execution/exchange-fill-batch-driver.service");

const WEIGHT = USER_TRADES_REQUEST_WEIGHT;
const NOW = new Date("2026-08-12T09:15:00.000Z");
const WORKER = "worker-a";

async function loadEnv(value: string | undefined) {
  if (value === undefined) delete process.env[WEIGHT_KEY];
  else process.env[WEIGHT_KEY] = value;
  vi.resetModules();
  const { env } = await import("../src/config/env");
  return env;
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[WEIGHT_KEY];
  else process.env[WEIGHT_KEY] = ORIGINAL;
  vi.resetModules();
});

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

/** Runs the real driver over scripted dependencies. */
function runWith(
  script: Array<Record<string, unknown>>,
  options: { maxWindows: number; maxUserTradesWeight: number; bootstrap?: Record<string, unknown> }
) {
  const executorCalls: Array<{ workerId: string; now?: Date; forwardedNowKey: boolean }> = [];
  const bootstrapCalls: Array<{ now: Date; horizonDays: number }> = [];
  const driver = new HistoricalFillBatchDriver({
    bootstrap: {
      bootstrapHistoricalRoots: async (o: { now: Date; horizonDays: number }) => {
        bootstrapCalls.push(o);
        return options.bootstrap ?? bootstrapped;
      },
    },
    executor: {
      executeOne: async (o: { workerId: string; now?: Date }) => {
        executorCalls.push({ ...o, forwardedNowKey: "now" in o });
        const next = script[executorCalls.length - 1];
        if (next === undefined) {
          throw new Error(
            `executor invoked ${executorCalls.length} times but only ${script.length} scripted`
          );
        }
        return next;
      },
    },
  } as never);

  return {
    executorCalls,
    bootstrapCalls,
    run: () =>
      driver.runHistoricalFillBatch({
        workerId: WORKER,
        now: NOW,
        horizonDays: 2,
        maxWindows: options.maxWindows,
        maxUserTradesWeight: options.maxUserTradesWeight,
      }),
  };
}

const outcome = (name: string, extra: Record<string, unknown> = {}) => ({ outcome: name, ...extra });
const repeat = (name: string, times: number) => Array.from({ length: times }, () => outcome(name));

/** Every invariant §14 demands, checked on whatever the driver returned. */
function assertAccounting(result: Record<string, unknown>, budget: number) {
  const used = result.userTradesWeightUsed as number;
  const remaining = result.userTradesWeightRemaining as number;
  expect(result.userTradesRequestWeightPerDispatch).toBe(WEIGHT);
  expect(result.userTradesWeightBudget).toBe(budget);
  expect(used).toBeGreaterThanOrEqual(0);
  expect(used).toBeLessThanOrEqual(budget);
  expect(used + remaining).toBe(budget);
  expect(used % WEIGHT).toBe(0);
}

describe("the userTrades request weight is taken, not guessed", () => {
  it("comes from the endpoint registry that documents it", () => {
    // One source of truth. The registry entry is already pinned by the Binance
    // read-only suite; this asserts the budget is denominated in that value
    // rather than a second copy of the number.
    expect(USER_TRADES_REQUEST_WEIGHT).toBe(BINANCE_READ_ONLY_ENDPOINTS.userTrades.weight);
    expect(BINANCE_READ_ONLY_ENDPOINTS.userTrades.path).toBe("/fapi/v1/userTrades");
    expect(USER_TRADES_REQUEST_WEIGHT).toBe(5);
  });

  it("A. defaults the budget to 25 when the key is absent", async () => {
    const env = await loadEnv(undefined);

    expect(env[WEIGHT_KEY]).toBe(25);
    expect(typeof env[WEIGHT_KEY]).toBe("number");
    expect(Number.isSafeInteger(env[WEIGHT_KEY])).toBe(true);
    // The default is exactly the default batch: 5 windows of one dispatch each.
    expect(env[WEIGHT_KEY]).toBe(5 * WEIGHT);
  });

  it("floors the range at exactly one dispatch", async () => {
    // Guards the config range against the registry drifting under it.
    await expect(loadEnv(String(WEIGHT))).resolves.toMatchObject({ [WEIGHT_KEY]: WEIGHT });
    await expect(loadEnv(String(WEIGHT - 1))).rejects.toThrow("Invalid environment variables");
  });

  for (const [text, expected] of [
    ["5", 5],
    ["25", 25],
    ["100", 100],
    ["500", 500],
    ["  25  ", 25],
  ] as const) {
    it(`B. accepts ${JSON.stringify(text)}`, async () => {
      const env = await loadEnv(text);
      expect(env[WEIGHT_KEY]).toBe(expected);
    });
  }

  for (const bad of ["0", "1", "4", "501", "-1", "5.0", "5.5", "25foo", "1e2", "NaN", "Infinity", ""]) {
    it(`B. refuses ${JSON.stringify(bad)} at startup`, async () => {
      // No clamp to 5 or 500, no fallback to 25, no prefix read of "25foo".
      await expect(loadEnv(bad)).rejects.toThrow("Invalid environment variables");
    });
  }
});

describe("the budget bounds dispatches, maxWindows bounds invocations", () => {
  it("C. spends the whole default budget across a default batch", async () => {
    const harness = runWith(repeat("COMPLETE", 5), { maxWindows: 5, maxUserTradesWeight: 25 });

    const result = await harness.run();

    expect(harness.executorCalls).toHaveLength(5);
    expect(result).toMatchObject({
      outcome: "MAX_WINDOWS_REACHED",
      executionInvocations: 5,
      userTradesWeightUsed: 25,
      userTradesWeightRemaining: 0,
    });
    assertAccounting(result as never, 25);
  });

  it("D. stops on weight when weight is tighter than maxWindows", async () => {
    // A hundred windows allowed, but only five dispatches paid for. The sixth
    // invocation is never started -- the script would throw if it were.
    const harness = runWith(repeat("COMPLETE", 5), { maxWindows: 100, maxUserTradesWeight: 25 });

    const result = await harness.run();

    expect(harness.executorCalls).toHaveLength(5);
    expect(result).toMatchObject({
      outcome: "USER_TRADES_WEIGHT_BUDGET_EXHAUSTED",
      executionInvocations: 5,
      userTradesWeightUsed: 25,
      userTradesWeightRemaining: 0,
    });
    assertAccounting(result as never, 25);
  });

  it("E. stops on maxWindows when maxWindows is tighter than weight", async () => {
    const harness = runWith(repeat("COMPLETE", 3), { maxWindows: 3, maxUserTradesWeight: 500 });

    const result = await harness.run();

    expect(harness.executorCalls).toHaveLength(3);
    expect(result).toMatchObject({
      outcome: "MAX_WINDOWS_REACHED",
      executionInvocations: 3,
      userTradesWeightUsed: 15,
      userTradesWeightRemaining: 485,
    });
    assertAccounting(result as never, 500);
  });

  it("J. refuses a second invocation once a one-dispatch budget is spent", async () => {
    const harness = runWith([outcome("COMPLETE")], { maxWindows: 10, maxUserTradesWeight: WEIGHT });

    const result = await harness.run();

    // maxWindows had nine slots left; weight had none.
    expect(harness.executorCalls).toHaveLength(1);
    expect(result).toMatchObject({
      outcome: "USER_TRADES_WEIGHT_BUDGET_EXHAUSTED",
      executionInvocations: 1,
      userTradesWeightUsed: WEIGHT,
      userTradesWeightRemaining: 0,
    });
  });

  it("K. reaching maxWindows and the last of the weight together is MAX_WINDOWS_REACHED", async () => {
    // Both ceilings land on the same invocation. The requested invocation count
    // is what ran out, so weight exhaustion does not get to claim it.
    const harness = runWith(repeat("COMPLETE", 5), { maxWindows: 5, maxUserTradesWeight: 25 });

    const result = await harness.run();

    expect(result.outcome).toBe("MAX_WINDOWS_REACHED");
    expect(result.userTradesWeightRemaining).toBe(0);
  });

  it("M. never begins an invocation it cannot pay for", async () => {
    for (const [budget, maxWindows] of [
      [WEIGHT, 10],
      [2 * WEIGHT, 10],
      [3 * WEIGHT, 10],
      [10 * WEIGHT, 4],
    ] as const) {
      const affordable = Math.floor(budget / WEIGHT);
      const harness = runWith(repeat("COMPLETE", Math.min(affordable, maxWindows)), {
        maxWindows,
        maxUserTradesWeight: budget,
      });

      const result = await harness.run();

      expect(harness.executorCalls.length).toBeLessThanOrEqual(affordable);
      expect(harness.executorCalls).toHaveLength(Math.min(affordable, maxWindows));
      assertAccounting(result as never, budget);
    }
  });
});

describe("only a real dispatch keeps its reservation", () => {
  it("F. refunds NO_WORK, which never reached the exchange", async () => {
    // The whole budget is one dispatch, and the speculative reservation briefly
    // consumed all of it. Giving it back is what stops this looking exhausted.
    const harness = runWith([outcome("NO_WORK")], { maxWindows: 100, maxUserTradesWeight: WEIGHT });

    const result = await harness.run();

    expect(harness.executorCalls).toHaveLength(1);
    expect(result).toMatchObject({
      outcome: "NO_WORK",
      executionInvocations: 1,
      userTradesWeightUsed: 0,
      userTradesWeightRemaining: WEIGHT,
    });
    assertAccounting(result as never, WEIGHT);
  });

  it("G. refunds an execution-phase profile loss and stops", async () => {
    const harness = runWith(
      [
        outcome("COMPLETE"),
        outcome("PROFILE_UNAVAILABLE", { reasonCode: "PROFILE_ENVIRONMENT_MISMATCH" }),
      ],
      { maxWindows: 10, maxUserTradesWeight: 100 }
    );

    const result = await harness.run();

    expect(harness.executorCalls).toHaveLength(2);
    expect(result).toMatchObject({
      outcome: "PROFILE_UNAVAILABLE",
      stage: "EXECUTION",
      reasonCode: "PROFILE_ENVIRONMENT_MISMATCH",
      // The invocation still counts under Slice 1 rules; only the weight is
      // given back, because the binding failed before any request.
      executionInvocations: 2,
      userTradesWeightUsed: WEIGHT,
      userTradesWeightRemaining: 100 - WEIGHT,
    });
    assertAccounting(result as never, 100);
  });

  it("H. spends nothing at all when the bootstrap cannot bind", async () => {
    const harness = runWith([outcome("COMPLETE")], {
      maxWindows: 10,
      maxUserTradesWeight: 100,
      bootstrap: { outcome: "PROFILE_UNAVAILABLE", reasonCode: "PROFILE_POLICY_MISSING" },
    });

    const result = await harness.run();

    expect(harness.executorCalls).toHaveLength(0);
    expect(result).toMatchObject({
      outcome: "PROFILE_UNAVAILABLE",
      stage: "BOOTSTRAP",
      executionInvocations: 0,
      userTradesWeightUsed: 0,
      userTradesWeightRemaining: 100,
    });
  });

  for (const failed of ["RETRY_SCHEDULED", "ABANDONED", "STALE_CLAIM"] as const) {
    it(`I. keeps the weight for ${failed}, which followed a real request`, async () => {
      // The request reached Binance and was charged there. A page that came
      // back useless is not a refund.
      const harness = runWith([outcome(failed)], { maxWindows: 1, maxUserTradesWeight: 100 });

      const result = await harness.run();

      expect(result.userTradesWeightUsed).toBe(WEIGHT);
      expect(result.outcomes[failed]).toBe(1);
      assertAccounting(result as never, 100);
    });
  }

  for (const dispatched of [
    "COMPLETE",
    "INCOMPLETE_SKIPPED_ROWS",
    "SPLIT",
    "SATURATED_SINGLE_MILLISECOND",
  ] as const) {
    it(`I. keeps the weight for ${dispatched}`, async () => {
      const harness = runWith([outcome(dispatched)], { maxWindows: 1, maxUserTradesWeight: 100 });

      const result = await harness.run();

      expect(result.userTradesWeightUsed).toBe(WEIGHT);
      assertAccounting(result as never, 100);
    });
  }

  it("L. conserves the budget across a mixed pass", async () => {
    const harness = runWith(
      [
        outcome("COMPLETE"),
        outcome("SPLIT"),
        outcome("RETRY_SCHEDULED"),
        outcome("STALE_CLAIM"),
        outcome("ABANDONED"),
        outcome("NO_WORK"),
      ],
      { maxWindows: 20, maxUserTradesWeight: 100 }
    );

    const result = await harness.run();

    expect(result.outcome).toBe("NO_WORK");
    // Six invocations, five of which dispatched.
    expect(result.executionInvocations).toBe(6);
    expect(result.userTradesWeightUsed).toBe(5 * WEIGHT);
    expect(result.userTradesWeightRemaining).toBe(100 - 5 * WEIGHT);
    assertAccounting(result as never, 100);
    // Invocations and weight are different quantities and must not be conflated.
    expect(result.executionInvocations).not.toBe(result.userTradesWeightUsed / WEIGHT);
  });
});

describe("an unusable budget is a misconfiguration, not an outcome", () => {
  for (const bad of [0, 1, WEIGHT - 1, -5, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`refuses maxUserTradesWeight=${String(bad)} before bootstrapping`, async () => {
      const harness = runWith([outcome("COMPLETE")], {
        maxWindows: 5,
        maxUserTradesWeight: bad as number,
      });

      await expect(harness.run()).rejects.toBeInstanceOf(FillBatchRefusedError);
      expect(harness.bootstrapCalls).toHaveLength(0);
      expect(harness.executorCalls).toHaveLength(0);
    });
  }

  it("leaves the Slice 1 clock contract untouched", async () => {
    const harness = runWith(repeat("COMPLETE", 2), { maxWindows: 2, maxUserTradesWeight: 100 });

    await harness.run();

    expect(harness.bootstrapCalls).toEqual([{ now: NOW, horizonDays: 2 }]);
    for (const call of harness.executorCalls) {
      expect(call.forwardedNowKey).toBe(false);
      expect(call.now).toBeUndefined();
    }
  });
});
