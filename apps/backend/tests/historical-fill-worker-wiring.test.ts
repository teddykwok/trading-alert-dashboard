import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "../src/config/logger";
import {
  createHistoricalFillWorkerId,
  startHistoricalFillWorkerRuntime,
} from "../src/modules/jobs/historical-fill-worker-runtime";

/**
 * The one production start call-site, and its dormancy.
 *
 * The central claim under test is NEGATIVE: with the gate closed, a worker
 * boot must construct nothing historical at all -- no identity, no service, no
 * client, no timer -- because the historical tables may not exist in the
 * environment this code is deployed to. That is proven by spying on the
 * scheduler factory and on `setInterval`, and by reading the source to show
 * every construction lives inside the enabled branch.
 */

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  info = vi.spyOn(logger, "info").mockImplementation(() => logger);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A scheduler factory that fails loudly if a disabled runtime ever builds one. */
const forbiddenScheduler = (() => {
  throw new Error("A disabled historical runtime created a scheduler.");
}) as never;

describe("a disabled worker builds nothing historical", () => {
  it("reports DISABLED, creates no scheduler and no timer", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");

    const runtime = startHistoricalFillWorkerRuntime({
      enabled: false,
      createScheduler: forbiddenScheduler,
    });

    expect(runtime.status).toBe("DISABLED");
    expect(setInterval).not.toHaveBeenCalled();
  });

  it("mints no worker identity while dormant", () => {
    const runtime = startHistoricalFillWorkerRuntime({
      enabled: false,
      createScheduler: forbiddenScheduler,
    });

    // `claimOwner` is an identity for work that will never happen here.
    expect(runtime.workerId).toBeUndefined();
  });

  it("stopping a dormant runtime is safe and repeatable", async () => {
    const runtime = startHistoricalFillWorkerRuntime({
      enabled: false,
      createScheduler: forbiddenScheduler,
    });

    await expect(runtime.stop()).resolves.toBeUndefined();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it("says so once, and never on a timer", () => {
    startHistoricalFillWorkerRuntime({ enabled: false, createScheduler: forbiddenScheduler });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe(
      "Historical fill runtime disabled (EXECUTION_FILL_RUNTIME_ENABLED=false)"
    );
  });

  it("every historical construction lives inside the enabled branch", async () => {
    const source = (await import("node:fs")).readFileSync(
      "src/modules/jobs/historical-fill-worker-runtime.ts",
      "utf8"
    );
    const enabledBranch = source.slice(source.indexOf("const workerId ="));

    // Each dependency is constructed only after the gate has been read and the
    // disabled branch has already returned.
    for (const constructed of [
      "new ExchangeFillIngestWindowService",
      "new ExchangeFillLedgerService",
      "new BinanceReadOnlyService",
      "new ExchangeFillOneWindowExecutor",
      "new ExchangeFillRootBootstrap",
      "new HistoricalFillWeightBudgetService",
      "new HistoricalFillBatchDriver",
    ]) {
      expect(source).toContain(constructed);
      expect(enabledBranch).toContain(constructed);
      // ...and nothing is built before the early return.
      expect(source.indexOf(constructed)).toBeGreaterThan(source.indexOf('if (!enabled)'));
    }
  });

  it("reuses the shared Prisma client and opens no second pool", async () => {
    const source = (await import("node:fs")).readFileSync(
      "src/modules/jobs/historical-fill-worker-runtime.ts",
      "utf8"
    );

    expect(source).toContain('import { prisma } from "../../plugins/prisma"');
    expect(source).not.toContain("new PrismaClient");
    expect(source).not.toContain("new Redis");
    expect(source).not.toContain("bullConnection");
  });
});

describe("an enabled worker starts exactly one scheduler", () => {
  const CAP = "EXECUTION_FILL_GLOBAL_USER_TRADES_WEIGHT_PER_MINUTE";
  const ORIGINAL_CAP = process.env[CAP];

  afterEach(() => {
    if (ORIGINAL_CAP === undefined) delete process.env[CAP];
    else process.env[CAP] = ORIGINAL_CAP;
  });

  /** Loads the composition module against a freshly parsed env. */
  async function loadRuntime(cap: string | undefined) {
    if (cap === undefined) delete process.env[CAP];
    else process.env[CAP] = cap;
    vi.resetModules();
    const { logger: fresh } = await import("../src/config/logger");
    vi.spyOn(fresh, "info").mockImplementation(() => fresh);
    return import("../src/modules/jobs/historical-fill-worker-runtime");
  }

  /** Captures what the runtime composed, without running any of it. */
  function capture() {
    const start = vi.fn(() => ({ status: "RUNNING" as const, timer: 0 as never, stop: vi.fn(), stopAndDrain: vi.fn(async () => undefined) }));
    const createScheduler = vi.fn(() => ({ start }));
    return { createScheduler, start };
  }

  it("starts one scheduler and carries the worker identity", async () => {
    const module = await loadRuntime("25");
    const { createScheduler, start } = capture();

    const runtime = module.startHistoricalFillWorkerRuntime({
      enabled: true,
      workerId: "worker-deterministic",
      createScheduler: createScheduler as never,
    });

    expect(runtime.status).toBe("RUNNING");
    expect(createScheduler).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(runtime.workerId).toBe("worker-deterministic");
    expect(createScheduler.mock.calls[0][0].workerId).toBe("worker-deterministic");
  });

  it("passes the shared ceiling and the configured bounds unchanged", async () => {
    const module = await loadRuntime("25");
    const { env } = await import("../src/config/env");
    const { createScheduler } = capture();

    module.startHistoricalFillWorkerRuntime({
      enabled: true,
      workerId: "w",
      createScheduler: createScheduler as never,
    });

    const composed = createScheduler.mock.calls[0][0];
    // The shared ceiling must reach the driver, or the driver refuses a wired
    // budget and the whole coordination layer is unreachable.
    expect(composed.globalUserTradesWeightPerMinute).toBe(
      env.EXECUTION_FILL_GLOBAL_USER_TRADES_WEIGHT_PER_MINUTE
    );
    expect(composed.horizonDays).toBe(env.EXECUTION_FILL_INGEST_HORIZON_DAYS);
    expect(composed.maxWindows).toBe(env.EXECUTION_FILL_BATCH_MAX_WINDOWS);
    expect(composed.maxUserTradesWeight).toBe(env.EXECUTION_FILL_BATCH_MAX_USER_TRADES_WEIGHT);
    expect(composed.intervalMs).toBe(env.EXECUTION_FILL_BATCH_INTERVAL_SECONDS * 1000);
  });

  it("supplies a driver FACTORY, never a batch call of its own", async () => {
    const module = await loadRuntime("25");
    const { createScheduler } = capture();

    module.startHistoricalFillWorkerRuntime({
      enabled: true,
      workerId: "w",
      createScheduler: createScheduler as never,
    });

    // The runner owns the call; the worker only says what may be built.
    expect(typeof createScheduler.mock.calls[0][0].createDriver).toBe("function");
  });

  it("refuses to run without the shared ceiling rather than sweeping unbudgeted", async () => {
    const module = await loadRuntime(undefined);

    // Fails closed. Reaching a batch without a ceiling would contend for a
    // shared row without knowing what it is allowed to spend.
    expect(() =>
      module.startHistoricalFillWorkerRuntime({ enabled: true, workerId: "w" })
    ).toThrow("EXECUTION_FILL_GLOBAL_USER_TRADES_WEIGHT_PER_MINUTE is required");
  });
});

describe("the worker identity", () => {
  it("is a uuid behind a readable prefix, and carries nothing sensitive", () => {
    const id = createHistoricalFillWorkerId();

    expect(id).toMatch(/^historical-fill:[0-9a-f-]{36}$/);
    // Not a pid, not a hostname, not a timestamp, and nothing account-derived.
    expect(id).not.toContain(String(process.pid));
    for (const leaked of ["apiKey", "secret", "token", "profile", "USDT", "@"]) {
      expect(id).not.toContain(leaked);
    }
  });

  it("is generated once per runtime, not per tick", async () => {
    process.env.EXECUTION_FILL_GLOBAL_USER_TRADES_WEIGHT_PER_MINUTE = "25";
    vi.resetModules();
    const module = await import("../src/modules/jobs/historical-fill-worker-runtime");
    const start = vi.fn(() => ({ status: "RUNNING" as const, timer: 0 as never, stop: vi.fn(), stopAndDrain: vi.fn(async () => undefined) }));
    const createScheduler = vi.fn(() => ({ start }));

    const runtime = module.startHistoricalFillWorkerRuntime({
      enabled: true,
      createScheduler: createScheduler as never,
    });

    // One identity, handed to the scheduler once and reused by every tick it
    // ever runs. `attempts` remains the fencing token; this is diagnostics.
    expect(runtime.workerId).toBe(createScheduler.mock.calls[0][0].workerId);
    expect(runtime.workerId).toMatch(/^historical-fill:/);
  });

  it("differs between independently created runtimes", () => {
    expect(createHistoricalFillWorkerId()).not.toBe(createHistoricalFillWorkerId());
  });
});

describe("shutdown drains before the shared client goes away", () => {
  it("awaits a tick that is already running, and starts no more", async () => {
    process.env.EXECUTION_FILL_GLOBAL_USER_TRADES_WEIGHT_PER_MINUTE = "25";
    vi.resetModules();
    const module = await import("../src/modules/jobs/historical-fill-worker-runtime");
    let drained = false;
    const stopAndDrain = vi.fn(async () => {
      drained = true;
    });
    const start = vi.fn(() => ({ status: "RUNNING" as const, timer: 0 as never, stop: vi.fn(), stopAndDrain }));

    const runtime = module.startHistoricalFillWorkerRuntime({
      enabled: true,
      workerId: "w",
      createScheduler: vi.fn(() => ({ start })) as never,
    });

    await runtime.stop();

    expect(stopAndDrain).toHaveBeenCalledTimes(1);
    expect(drained).toBe(true);
  });

  it("the worker drains BEFORE disconnecting the shared Prisma client", async () => {
    const worker = (await import("node:fs")).readFileSync(
      "src/modules/jobs/vision-analysis.worker.ts",
      "utf8"
    );

    const drainAt = worker.indexOf("await historicalFillRuntime.stop();");
    const disconnectAt = worker.indexOf("await prisma.$disconnect();");

    expect(drainAt).toBeGreaterThan(-1);
    expect(disconnectAt).toBeGreaterThan(-1);
    // The whole point: a claim and its transaction must not have the client
    // torn out from underneath them.
    expect(drainAt).toBeLessThan(disconnectAt);
  });
});

describe("the production chain stays singular", () => {
  const read = async (relative: string) =>
    (await import("node:fs")).readFileSync(relative, "utf8");

  it("the worker starts the runtime exactly once and calls nothing deeper", async () => {
    const worker = await read("src/modules/jobs/vision-analysis.worker.ts");

    expect(worker.match(/startHistoricalFillWorkerRuntime\(\)/g)).toHaveLength(1);
    // It wires composition; it never duplicates orchestration.
    for (const deeper of [
      "runHistoricalFillBatch",
      "executeOne",
      "listRecentTradesOnce",
      "createHistoricalFillScheduler",
      "runHistoricalFillRuntimeTick",
      "HistoricalFillWeightBudgetService",
      "userTrades",
    ]) {
      expect(worker).not.toContain(deeper);
    }
  });

  it("the driver is composed WITH the shared weight budget, never without it", async () => {
    const composition = await read("src/modules/jobs/historical-fill-worker-runtime.ts");

    // The structural guarantee, now widened by the campaign gate: the only
    // driver this worker builds carries BOTH the shared reservation authority
    // and the campaign that authorises spending it, so production wiring
    // cannot reach executeOne or Binance on an unbudgeted or uncounted path.
    expect(composition).toContain(
      "new HistoricalFillBatchDriver({ bootstrap, executor, weightBudget, campaigns })"
    );
    expect(composition).toContain("new HistoricalFillWeightBudgetService(prisma)");
    // Both on the SHARED client, never a second pool.
    expect(composition).toContain("new HistoricalFillCampaignGate({ prisma })");
    expect(composition).not.toContain("new HistoricalFillBatchDriver({ bootstrap, executor })");
    expect(composition).not.toContain(
      "new HistoricalFillBatchDriver({ bootstrap, executor, weightBudget })"
    );
  });

  it("no other production entry point starts it", async () => {
    for (const file of ["src/server.ts", "src/app.ts"]) {
      const source = await read(file);
      expect(source).not.toContain("historical-fill");
      expect(source).not.toContain("HistoricalFill");
    }
  });

  it("historical enablement is never tied to a trading flag", async () => {
    const composition = await read("src/modules/jobs/historical-fill-worker-runtime.ts");

    expect(composition).toContain("env.EXECUTION_FILL_RUNTIME_ENABLED");
    for (const trading of [
      "EXECUTION_GLOBAL_KILL_SWITCH",
      "EXECUTION_LIVE_ENTRY_ENABLED",
      "EXECUTION_PROTECTION_READY",
    ]) {
      expect(composition).not.toContain(trading);
    }
  });

  it("adds no leader election of any kind", async () => {
    const composition = await read("src/modules/jobs/historical-fill-worker-runtime.ts");
    const worker = await read("src/modules/jobs/vision-analysis.worker.ts");

    for (const source of [composition, worker]) {
      for (const elected of [
        "redlock", "pg_advisory", "tryAcquireLease", "electLeader", "SET NX", "tokenBucket",
      ]) {
        expect(source).not.toContain(elected);
      }
    }
  });
});
