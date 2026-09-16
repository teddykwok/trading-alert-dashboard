import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The historical-fill batch configuration contract.
 *
 * Two values that a FUTURE scheduler will consume, and nothing that runs. The
 * env schema is exercised for real rather than mocked -- the schema is the
 * thing under test, and a stub of it would only prove the stub agrees with
 * itself -- and one scripted test proves the configured bound survives the trip
 * into the already-approved bounded driver.
 *
 * No database, no Binance, no timer.
 */

const MAX_KEY = "EXECUTION_FILL_BATCH_MAX_WINDOWS";
const INTERVAL_KEY = "EXECUTION_FILL_BATCH_INTERVAL_SECONDS";

const ORIGINAL_MAX = process.env[MAX_KEY];
const ORIGINAL_INTERVAL = process.env[INTERVAL_KEY];

const { HistoricalFillBatchDriver } = await import(
  "../src/modules/execution/exchange-fill-batch-driver.service"
);

/**
 * Re-parses the real env schema with the two keys present or genuinely absent.
 *
 * `resetModules` makes the module-level `safeParse` run again, which is also
 * how a malformed value reaches an operator in production: a throw at import,
 * before anything is constructed.
 */
async function loadEnv(values: Partial<Record<string, string | undefined>>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  const { env } = await import("../src/config/env");
  return env;
}

afterEach(() => {
  if (ORIGINAL_MAX === undefined) delete process.env[MAX_KEY];
  else process.env[MAX_KEY] = ORIGINAL_MAX;
  if (ORIGINAL_INTERVAL === undefined) delete process.env[INTERVAL_KEY];
  else process.env[INTERVAL_KEY] = ORIGINAL_INTERVAL;
  vi.resetModules();
});

describe("batch window bound", () => {
  it("defaults to 5 when the key is absent", async () => {
    const env = await loadEnv({ [MAX_KEY]: undefined, [INTERVAL_KEY]: undefined });

    expect(env[MAX_KEY]).toBe(5);
    expect(typeof env[MAX_KEY]).toBe("number");
    expect(Number.isSafeInteger(env[MAX_KEY])).toBe(true);
  });

  for (const [text, expected] of [
    ["1", 1],
    ["5", 5],
    ["100", 100],
    ["  7  ", 7],
  ] as const) {
    it(`accepts ${JSON.stringify(text)}`, async () => {
      const env = await loadEnv({ [MAX_KEY]: text });
      expect(env[MAX_KEY]).toBe(expected);
    });
  }

  for (const bad of ["0", "101", "-1", "2.5", "2.0", "abc", "5foo", "NaN", "Infinity", "", "1e2"]) {
    it(`refuses ${JSON.stringify(bad)} at startup`, async () => {
      // No clamp to 1 or 100, no fallback to 5, no prefix read of "5foo" as 5.
      await expect(loadEnv({ [MAX_KEY]: bad })).rejects.toThrow("Invalid environment variables");
    });
  }
});

describe("batch cadence", () => {
  it("defaults to 60 seconds when the key is absent", async () => {
    const env = await loadEnv({ [MAX_KEY]: undefined, [INTERVAL_KEY]: undefined });

    expect(env[INTERVAL_KEY]).toBe(60);
    expect(typeof env[INTERVAL_KEY]).toBe("number");
    expect(Number.isSafeInteger(env[INTERVAL_KEY])).toBe(true);
  });

  for (const [text, expected] of [
    ["10", 10],
    ["60", 60],
    ["300", 300],
    ["3600", 3600],
  ] as const) {
    it(`accepts ${JSON.stringify(text)} seconds`, async () => {
      const env = await loadEnv({ [INTERVAL_KEY]: text });
      expect(env[INTERVAL_KEY]).toBe(expected);
    });
  }

  for (const bad of ["0", "9", "3601", "-1", "10.5", "60s", "1e2", "NaN", "Infinity", ""]) {
    it(`refuses ${JSON.stringify(bad)} at startup`, async () => {
      await expect(loadEnv({ [INTERVAL_KEY]: bad })).rejects.toThrow(
        "Invalid environment variables"
      );
    });
  }

  it("is independent of the window bound", async () => {
    // Neither is derived from the other: one is work per pass, the other is
    // time between passes.
    const env = await loadEnv({ [MAX_KEY]: "9", [INTERVAL_KEY]: "11" });
    expect(env[MAX_KEY]).toBe(9);
    expect(env[INTERVAL_KEY]).toBe(11);
  });
});

/**
 * The configured bound, carried into the approved driver as an ordinary number.
 *
 * Scripted dependencies on purpose: what is under test is that the typed env
 * value becomes the driver's ceiling, not anything about claiming or exchanges.
 */
describe("the configured bound drives one bounded batch", () => {
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

  it("invokes the executor exactly EXECUTION_FILL_BATCH_MAX_WINDOWS times", async () => {
    const env = await loadEnv({ [MAX_KEY]: "3" });
    const maxWindows: number = env[MAX_KEY];

    const bootstrapCalls: Array<{ now: Date; horizonDays: number }> = [];
    const executorCalls: Array<{ workerId: string; now?: Date; forwardedNowKey: boolean }> = [];
    const now = new Date("2026-08-12T09:15:00.000Z");

    const driver = new HistoricalFillBatchDriver({
      bootstrap: {
        bootstrapHistoricalRoots: async (options: { now: Date; horizonDays: number }) => {
          bootstrapCalls.push(options);
          return bootstrapped;
        },
      },
      // More work than the bound allows, so only the bound can stop it.
      executor: {
        executeOne: async (options: { workerId: string; now?: Date }) => {
          executorCalls.push({ ...options, forwardedNowKey: "now" in options });
          return { outcome: "COMPLETE" };
        },
      },
    } as never);

    const result = await driver.runHistoricalFillBatch({
      workerId: "worker-a",
      now,
      horizonDays: 2,
      maxWindows,
      maxUserTradesWeight: 500,
    });

    expect(maxWindows).toBe(3);
    expect(executorCalls).toHaveLength(3);
    expect(result).toMatchObject({
      outcome: "MAX_WINDOWS_REACHED",
      executionInvocations: 3,
      outcomes: {
        COMPLETE: 3,
        INCOMPLETE_SKIPPED_ROWS: 0,
        SPLIT: 0,
        SATURATED_SINGLE_MILLISECOND: 0,
        RETRY_SCHEDULED: 0,
        ABANDONED: 0,
        STALE_CLAIM: 0,
      },
    });

    // The Slice 1 clock contract is untouched by this slice: the bootstrap
    // still receives the caller's fixed instant, and the executor still
    // receives no `now` at all so it resolves fresh real time per invocation.
    expect(bootstrapCalls).toEqual([{ now, horizonDays: 2 }]);
    for (const call of executorCalls) {
      expect(call.forwardedNowKey).toBe(false);
      expect(call.now).toBeUndefined();
    }
  });

  it("still refuses a bound the driver itself rejects", async () => {
    // Config caps at 100 and the driver independently demands a safe integer
    // >= 1. Both checks exist; neither is load-bearing alone.
    const driver = new HistoricalFillBatchDriver({
      bootstrap: {
        bootstrapHistoricalRoots: async () => {
          throw new Error("bootstrap must not run for an unusable bound");
        },
      },
      executor: {
        executeOne: async () => {
          throw new Error("executor must not run for an unusable bound");
        },
      },
    } as never);

    await expect(
      driver.runHistoricalFillBatch({
        workerId: "worker-a",
        now: new Date("2026-08-12T09:15:00.000Z"),
        horizonDays: 2,
        maxWindows: 0,
        maxUserTradesWeight: 500,
      })
    ).rejects.toMatchObject({ reasonCode: "FILL_BATCH_REFUSED" });
  });

  it("declares a cadence without scheduling anything", async () => {
    // The real globals, watched across a real config load: declaring a cadence
    // must arm nothing. (That NOTHING in production reads the value yet is a
    // separate claim, proven by the call-site audit.)
    const interval = vi.spyOn(globalThis, "setInterval");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    try {
      const env = await loadEnv({ [INTERVAL_KEY]: "30" });

      expect(env[INTERVAL_KEY]).toBe(30);
      expect(interval).not.toHaveBeenCalled();
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      interval.mockRestore();
      timeout.mockRestore();
    }
  });
});
