import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "../src/config/logger";
import type { HistoricalFillBatchResult } from "../src/modules/execution/exchange-fill-batch-driver.service";
import type { HistoricalFillRuntimeTickResult } from "../src/modules/jobs/historical-fill-runtime";
import {
  createHistoricalFillScheduler,
  historicalFillIntervalMs,
  HISTORICAL_FILL_MAX_IN_FLIGHT_TICKS,
} from "../src/modules/jobs/historical-fill.scheduler";

/**
 * The recurring historical-fill loop.
 *
 * Fake timers throughout, following `worker-liveness`: a scheduler test that
 * waited real minutes would prove the same thing far more slowly. Every tick is
 * scripted, so no database, no Binance and no batch driver is reached.
 */

const WORKER_ID = "worker-1";
const INTERVAL_MS = 60_000;

const RESULT: HistoricalFillBatchResult = {
  outcome: "NO_WORK",
  bootstrap: {
    outcome: "BOOTSTRAPPED",
    executionProfileId: "profile-abc",
    horizonDays: 30,
    symbolCount: 0,
    dayCount: 30,
    expectedRootCount: 0,
    alreadyCompatibleCount: 0,
    createdCount: 0,
    raceReconciledCount: 0,
  },
  executionInvocations: 1,
  outcomes: {
    COMPLETE: 0,
    INCOMPLETE_SKIPPED_ROWS: 0,
    SPLIT: 0,
    SATURATED_SINGLE_MILLISECOND: 0,
    RETRY_SCHEDULED: 0,
    ABANDONED: 0,
    STALE_CLAIM: 0,
  },
  userTradesRequestWeightPerDispatch: 5,
  userTradesWeightBudget: 25,
  userTradesWeightUsed: 0,
  userTradesWeightRemaining: 25,
};

const RAN: HistoricalFillRuntimeTickResult = { status: "RAN", result: RESULT };

/** A driver factory that fails the test loudly if anything ever builds it. */
const forbiddenDriver = () => {
  throw new Error("The scheduler constructed a driver.");
};

function base(overrides: Record<string, unknown> = {}) {
  return {
    createDriver: forbiddenDriver as never,
    workerId: WORKER_ID,
    horizonDays: 30,
    maxWindows: 5,
    maxUserTradesWeight: 25,
    intervalMs: INTERVAL_MS,
    ...overrides,
  };
}

let info: ReturnType<typeof vi.spyOn>;
let debug: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  info = vi.spyOn(logger, "info").mockImplementation(() => logger);
  debug = vi.spyOn(logger, "debug").mockImplementation(() => logger);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a disabled scheduler never becomes a loop", () => {
  it("A+B+C+D+E. reports disabled, creates no timer and runs no tick", async () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const runTick = vi.fn(async () => RAN);

    const handle = createHistoricalFillScheduler(base({ runTick, enabled: false })).start();

    expect(handle).toEqual({ status: "DISABLED" });
    expect(setInterval).not.toHaveBeenCalled();
    expect(runTick).not.toHaveBeenCalled();

    // ...and time passing changes nothing, because nothing was scheduled.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 10);
    expect(runTick).not.toHaveBeenCalled();
    // The workerId was never handed to any work.
    expect(runTick.mock.calls).toHaveLength(0);
  });
});

describe("an enabled scheduler runs on the configured cadence", () => {
  it("A+F. creates exactly one timer and does NOT tick at start", async () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const runTick = vi.fn(async () => RAN);

    const handle = createHistoricalFillScheduler(base({ runTick, enabled: true })).start();

    expect(handle.status).toBe("RUNNING");
    expect(setInterval).toHaveBeenCalledTimes(1);
    // The audited convention for a plain recurring sweep: `cleanup` and
    // `execution-notification` both wait an interval. The two schedulers that
    // do run at start run a distinct STARTUP RECOVERY pass, and historical fill
    // has none -- a stale lease is reclaimed by the next ordinary tick.
    expect(runTick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
    expect(runTick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runTick).toHaveBeenCalledTimes(1);
  });

  it("B. maps the configured seconds to milliseconds, never sub-second", async () => {
    expect(historicalFillIntervalMs(60)).toBe(60_000);
    expect(historicalFillIntervalMs(10)).toBe(10_000);
    expect(historicalFillIntervalMs(3600)).toBe(3_600_000);

    const setInterval = vi.spyOn(globalThis, "setInterval");
    createHistoricalFillScheduler(
      base({ runTick: vi.fn(async () => RAN), enabled: true, intervalMs: historicalFillIntervalMs(90) })
    ).start();

    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 90_000);
  });

  it("C+D+E. every tick goes through the runtime runner, with workerId unchanged", async () => {
    const runTick = vi.fn(async () => RAN);
    const now = new Date("2026-09-17T00:00:00.000Z");

    createHistoricalFillScheduler(base({ runTick, enabled: true, now: () => now })).start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(runTick).toHaveBeenCalledTimes(1);
    expect(runTick).toHaveBeenCalledWith({
      createDriver: expect.any(Function),
      workerId: WORKER_ID,
      now,
      horizonDays: 30,
      maxWindows: 5,
      maxUserTradesWeight: 25,
    });
    // The scheduler is not a second route to the driver: it never built one.
    // `forbiddenDriver` throws if called, and the runner is the only thing that
    // would ever call it.
    expect(runTick.mock.calls[0][0].createDriver).toBe(base().createDriver);
  });

  it("stamps a FRESH instant per tick, never one frozen at start", async () => {
    const runTick = vi.fn(async () => RAN);
    const instants = [new Date("2026-09-17T00:01:00.000Z"), new Date("2026-09-17T00:02:00.000Z")];
    let index = 0;

    createHistoricalFillScheduler(
      base({ runTick, enabled: true, now: () => instants[index++] })
    ).start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(runTick).toHaveBeenCalledTimes(2);
    expect(runTick.mock.calls[0][0].now).toBe(instants[0]);
    expect(runTick.mock.calls[1][0].now).toBe(instants[1]);
    expect(runTick.mock.calls[0][0].now).not.toBe(runTick.mock.calls[1][0].now);
  });

  it("G. does not hold the process open by itself", async () => {
    const handle = createHistoricalFillScheduler(
      base({ runTick: vi.fn(async () => RAN), enabled: true })
    ).start();

    expect(handle.status).toBe("RUNNING");
    // Same guarantee the alert-queue-recovery suite pins on its own scheduler.
    const source = (await import("node:fs")).readFileSync(
      "src/modules/jobs/historical-fill.scheduler.ts",
      "utf8"
    );
    expect(source).toContain("timer.unref?.();");
    expect(info).toHaveBeenCalledWith({ intervalMs: INTERVAL_MS }, "Historical fill scheduler started");
  });
});

describe("overlap: one tick at a time, never a backlog", () => {
  it("A+B+C+D. a second interval while one tick is unresolved is skipped", async () => {
    let release: (value: HistoricalFillRuntimeTickResult) => void = () => {};
    const runTick = vi.fn(
      () => new Promise<HistoricalFillRuntimeTickResult>((resolve) => (release = resolve))
    );

    createHistoricalFillScheduler(base({ runTick, enabled: true })).start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(runTick).toHaveBeenCalledTimes(1);

    // Four more opportunities pass while tick #1 is still unresolved.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 4);
    expect(runTick).toHaveBeenCalledTimes(HISTORICAL_FILL_MAX_IN_FLIGHT_TICKS);
    expect(debug).toHaveBeenCalledWith(
      "Historical fill tick still running — skipping this interval"
    );

    release(RAN);
    await vi.advanceTimersByTimeAsync(0);

    // D. No catch-up storm: the four skipped occurrences are gone, not queued.
    expect(runTick).toHaveBeenCalledTimes(1);
  });

  it("E. after the first tick settles, the next normal interval runs", async () => {
    let release: (value: HistoricalFillRuntimeTickResult) => void = () => {};
    const runTick = vi.fn(
      () => new Promise<HistoricalFillRuntimeTickResult>((resolve) => (release = resolve))
    );

    createHistoricalFillScheduler(base({ runTick, enabled: true })).start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(runTick).toHaveBeenCalledTimes(1);

    release(RAN);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(runTick).toHaveBeenCalledTimes(2);
  });
});

describe("a failed tick never kills the loop", () => {
  it("A+B+D+F. the rejection is contained and the next interval still runs", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const runTick = vi
      .fn<[], Promise<HistoricalFillRuntimeTickResult>>()
      .mockRejectedValueOnce(new Error("Historical fill batch invariant violated"))
      .mockResolvedValue(RAN);

    createHistoricalFillScheduler(base({ runTick, enabled: true })).start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(runTick).toHaveBeenCalledTimes(1);

    // The timer survived the rejection...
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(runTick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(runTick).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(0);
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });

  it("C. does not retry inside the same tick", async () => {
    const runTick = vi
      .fn<[], Promise<HistoricalFillRuntimeTickResult>>()
      .mockRejectedValue(new Error("nope"));

    createHistoricalFillScheduler(base({ runTick, enabled: true })).start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    // Exactly one attempt per interval. The window's own backoff is the only
    // retry policy there is.
    expect(runTick).toHaveBeenCalledTimes(1);
  });

  it("E. does not replace the runner's own failure record", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const runTick = vi
      .fn<[], Promise<HistoricalFillRuntimeTickResult>>()
      .mockRejectedValue(new Error("boom"));

    createHistoricalFillScheduler(base({ runTick, enabled: true })).start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    // The runner already logged `historical_fill_batch_failed` and rethrew; the
    // scheduler catches purely to keep the timer alive, and says nothing more.
    expect(error).not.toHaveBeenCalled();
    // Nor does it announce a success it did not have.
    for (const call of info.mock.calls) {
      expect(call[1]).not.toBe("Historical fill batch complete");
    }
  });
});

describe("stopping", () => {
  it("A+B. clears the interval and no later tick runs", async () => {
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const runTick = vi.fn(async () => RAN);

    const handle = createHistoricalFillScheduler(base({ runTick, enabled: true })).start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(runTick).toHaveBeenCalledTimes(1);

    if (handle.status !== "RUNNING") throw new Error("expected a running scheduler");
    handle.stop();

    expect(clearInterval).toHaveBeenCalledWith(handle.timer);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);
    expect(runTick).toHaveBeenCalledTimes(1);
  });

  it("C. stopping twice clears once and stays harmless", async () => {
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const handle = createHistoricalFillScheduler(
      base({ runTick: vi.fn(async () => RAN), enabled: true })
    ).start();

    if (handle.status !== "RUNNING") throw new Error("expected a running scheduler");
    handle.stop();
    handle.stop();
    handle.stop();

    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(info.mock.calls.filter((call) => call[0] === "Historical fill scheduler stopped")).toHaveLength(1);
  });

  it("D+E. an in-flight tick is left to settle, and nothing follows it", async () => {
    let release: (value: HistoricalFillRuntimeTickResult) => void = () => {};
    const runTick = vi.fn(
      () => new Promise<HistoricalFillRuntimeTickResult>((resolve) => (release = resolve))
    );

    const handle = createHistoricalFillScheduler(base({ runTick, enabled: true })).start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(runTick).toHaveBeenCalledTimes(1);

    if (handle.status !== "RUNNING") throw new Error("expected a running scheduler");
    handle.stop();

    // Not aborted: a claim and its transaction are mid-flight, and tearing that
    // up from the outside is exactly what the fencing design avoids.
    release(RAN);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(runTick).toHaveBeenCalledTimes(1);
  });

  it("F. a stale callback that fires after stop starts no work", async () => {
    const runTick = vi.fn(async () => RAN);
    let fire: () => void = () => {};
    const setInterval = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((callback: () => void) => {
        // Capture the callback so it can be fired AFTER stop, exactly as a
        // callback already queued on the event loop would be.
        fire = callback;
        return { unref: () => {} } as unknown as NodeJS.Timeout;
      }) as never);

    const handle = createHistoricalFillScheduler(base({ runTick, enabled: true })).start();
    expect(setInterval).toHaveBeenCalledTimes(1);

    if (handle.status !== "RUNNING") throw new Error("expected a running scheduler");
    handle.stop();

    fire();
    await vi.advanceTimersByTimeAsync(0);

    expect(runTick).not.toHaveBeenCalled();
  });
});

describe("starting twice", () => {
  it("returns the same handle and never owns two loops", async () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const runTick = vi.fn(async () => RAN);
    const scheduler = createHistoricalFillScheduler(base({ runTick, enabled: true }));

    const first = scheduler.start();
    const second = scheduler.start();
    const third = scheduler.start();

    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);

    // One loop means one tick per interval, not three.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(runTick).toHaveBeenCalledTimes(1);
  });

  it("a disabled scheduler is idempotent too", async () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const scheduler = createHistoricalFillScheduler(
      base({ runTick: vi.fn(async () => RAN), enabled: false })
    );

    expect(scheduler.start()).toBe(scheduler.start());
    expect(setInterval).not.toHaveBeenCalled();
  });
});

describe("the scheduler exists, and nobody starts it", () => {
  const read = async (relative: string) =>
    (await import("node:fs")).readFileSync(relative, "utf8");

  const codeOf = (source: string) =>
    source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
      })
      .join("\n");

  it("A. no production module constructs or starts it", async () => {
    // The whole point of this slice: the loop is built and left dormant. Wiring
    // it is Slice 3's decision, because it settles process identity and how
    // many processes may sweep one account at once.
    const files = [
      "src/modules/jobs/vision-analysis.worker.ts",
      "src/server.ts",
      "src/app.ts",
    ];
    for (const file of files) {
      const source = await read(file);
      expect(source).not.toContain("historical-fill.scheduler");
      expect(source).not.toContain("createHistoricalFillScheduler");
      expect(source).not.toContain("historical-fill-runtime");
      expect(source).not.toContain("runHistoricalFillRuntimeTick");
    }
  });

  it("E. starts nothing at import: every timer lives inside start()", async () => {
    const code = codeOf(await read("src/modules/jobs/historical-fill.scheduler.ts"));

    // The only setInterval is inside the returned start(), after the gate.
    expect(code.match(/setInterval/g)).toHaveLength(1);
    expect(code).not.toMatch(/^setInterval/m);
    expect(code).not.toMatch(/^void /m);
    expect(code).not.toContain("process.on");
    // No hidden singleton that a later import could resurrect.
    expect(code).not.toMatch(/^(const|let) \w+ = createHistoricalFillScheduler/m);
  });

  it("F. adds no CLI and no operator endpoint", async () => {
    const code = codeOf(await read("src/modules/jobs/historical-fill.scheduler.ts"));

    for (const surface of ["app.post", "app.get", "fastify", "process.argv", "commander", "yargs"]) {
      expect(code).not.toContain(surface);
    }
    const routes = await read("src/routes/operator.routes.ts");
    expect(routes).not.toContain("historical-fill.scheduler");
    expect(routes).not.toContain("createHistoricalFillScheduler");
  });

  it("G. reaches the driver only through the Slice 1 runner", async () => {
    const code = codeOf(await read("src/modules/jobs/historical-fill.scheduler.ts"));

    expect(code).toContain("runHistoricalFillRuntimeTick");
    // Never the driver itself: the runner is the per-tick gate, and bypassing
    // it would let a scheduler nobody stopped keep sweeping a disabled runtime.
    for (const bypass of [
      "HistoricalFillBatchDriver",
      "runHistoricalFillBatch",
      "exchange-fill-batch-driver",
      "ExchangeFillRootBootstrap",
      "ExchangeFillOneWindowExecutor",
      "prisma",
    ]) {
      expect(code).not.toContain(bypass);
    }
  });

  it("generates no worker identity of its own", async () => {
    const code = codeOf(await read("src/modules/jobs/historical-fill.scheduler.ts"));

    // workerId arrives from the caller and is passed through. Minting one here
    // would silently answer a multi-process question Slice 3 owns.
    for (const minted of ["hostname", "process.pid", "randomUUID", "Math.random", "uuid", "nanoid"]) {
      expect(code).not.toContain(minted);
    }
    expect(code).toContain("workerId: options.workerId");
  });

  it("adds no global rate limiter", async () => {
    const code = codeOf(await read("src/modules/jobs/historical-fill.scheduler.ts"));

    for (const limiter of ["redis", "Redis", "tokenBucket", "rateLimit", "advisoryLock", "leader"]) {
      expect(code).not.toContain(limiter);
    }
  });
});
