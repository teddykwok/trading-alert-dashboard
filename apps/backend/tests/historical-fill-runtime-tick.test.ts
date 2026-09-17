import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "../src/config/logger";
import type { HistoricalFillBatchResult } from "../src/modules/execution/exchange-fill-batch-driver.service";
import {
  HISTORICAL_FILL_BATCH_COMPLETE_EVENT,
  HISTORICAL_FILL_BATCH_FAILED_EVENT,
  runHistoricalFillRuntimeTick,
  summarizeHistoricalFillBatch,
} from "../src/modules/jobs/historical-fill-runtime";

/**
 * The gated single-tick runner.
 *
 * Everything is scripted: a fake driver factory stands in for the real one, so
 * a disabled tick can be proven to build NOTHING, and an enabled tick can be
 * proven to call the driver exactly once with exactly the options it was given.
 *
 * No database, no Binance, no timer, no scheduler.
 */

const WORKER_ID = "worker-1";

const BOOTSTRAP = {
  outcome: "BOOTSTRAPPED" as const,
  executionProfileId: "profile-abc",
  horizonDays: 30,
  symbolCount: 3,
  dayCount: 30,
  expectedRootCount: 90,
  alreadyCompatibleCount: 85,
  createdCount: 4,
  raceReconciledCount: 1,
};

const RESULT: HistoricalFillBatchResult = {
  outcome: "MAX_WINDOWS_REACHED",
  bootstrap: BOOTSTRAP,
  executionInvocations: 5,
  outcomes: {
    COMPLETE: 2,
    INCOMPLETE_SKIPPED_ROWS: 0,
    SPLIT: 1,
    SATURATED_SINGLE_MILLISECOND: 0,
    RETRY_SCHEDULED: 1,
    ABANDONED: 0,
    STALE_CLAIM: 1,
  },
  userTradesRequestWeightPerDispatch: 5,
  userTradesWeightBudget: 25,
  userTradesWeightUsed: 25,
  userTradesWeightRemaining: 0,
};

const OPTIONS = {
  workerId: WORKER_ID,
  now: new Date("2026-09-17T00:00:00.000Z"),
  horizonDays: 30,
  maxWindows: 5,
  maxUserTradesWeight: 25,
};

let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  info = vi.spyOn(logger, "info").mockImplementation(() => logger);
  error = vi.spyOn(logger, "error").mockImplementation(() => logger);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A driver factory that records whether it was ever built or called. */
function scripted(behaviour: () => Promise<HistoricalFillBatchResult>) {
  const runHistoricalFillBatch = vi.fn(behaviour);
  const createDriver = vi.fn(() => ({ runHistoricalFillBatch }));
  return { createDriver, runHistoricalFillBatch };
}

describe("a disabled tick does nothing at all", () => {
  it("A. returns the typed DISABLED result", async () => {
    const { createDriver } = scripted(async () => RESULT);

    const outcome = await runHistoricalFillRuntimeTick({ ...OPTIONS, createDriver, enabled: false });

    expect(outcome).toEqual({ status: "DISABLED" });
  });

  it("B+C+D+E. never builds or calls the driver, so nothing downstream can run", async () => {
    const { createDriver, runHistoricalFillBatch } = scripted(async () => RESULT);

    await runHistoricalFillRuntimeTick({ ...OPTIONS, createDriver, enabled: false });

    // The batch is never invoked...
    expect(runHistoricalFillBatch).not.toHaveBeenCalled();
    // ...and the factory is never even called, so no bootstrap, executor,
    // ledger, claim service or Binance reader is constructed. Every downstream
    // effect is unreachable by construction rather than by promise.
    expect(createDriver).not.toHaveBeenCalled();
  });

  it("F+G. stays silent: no completion log and no failure log", async () => {
    const { createDriver } = scripted(async () => RESULT);

    await runHistoricalFillRuntimeTick({ ...OPTIONS, createDriver, enabled: false });

    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("an enabled tick runs exactly one batch", () => {
  it("A+B+C+D. invokes the driver once, with the exact options it was given", async () => {
    const { createDriver, runHistoricalFillBatch } = scripted(async () => RESULT);

    await runHistoricalFillRuntimeTick({ ...OPTIONS, createDriver, enabled: true });

    expect(createDriver).toHaveBeenCalledTimes(1);
    expect(runHistoricalFillBatch).toHaveBeenCalledTimes(1);
    // The Phase 7 contract, unchanged and unembellished: the driver still owns
    // the bootstrap clock, and nothing here reaches past it to the executor.
    expect(runHistoricalFillBatch).toHaveBeenCalledWith({
      workerId: WORKER_ID,
      now: OPTIONS.now,
      horizonDays: 30,
      maxWindows: 5,
      maxUserTradesWeight: 25,
    });
  });

  it("E. returns the driver result without losing information", async () => {
    const { createDriver } = scripted(async () => RESULT);

    const outcome = await runHistoricalFillRuntimeTick({ ...OPTIONS, createDriver, enabled: true });

    expect(outcome.status).toBe("RAN");
    expect(outcome.status === "RAN" && outcome.result).toBe(RESULT);
  });

  it("F. emits exactly one completion log and no failure log", async () => {
    const { createDriver } = scripted(async () => RESULT);

    await runHistoricalFillRuntimeTick({ ...OPTIONS, createDriver, enabled: true });

    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(info.mock.calls[0][1]).toBe("Historical fill batch complete");
  });

  it("G. the summary values are exactly the result's own", async () => {
    const { createDriver } = scripted(async () => RESULT);

    await runHistoricalFillRuntimeTick({ ...OPTIONS, createDriver, enabled: true });

    expect(info.mock.calls[0][0]).toEqual({
      event: HISTORICAL_FILL_BATCH_COMPLETE_EVENT,
      workerId: WORKER_ID,
      outcome: "MAX_WINDOWS_REACHED",
      executionInvocations: 5,
      // 25 spent at 5 per dispatch is five requests, derived from the two
      // numbers beside it rather than counted separately.
      userTradesRequests: 5,
      userTradesWeightUsed: 25,
      userTradesWeightBudget: 25,
      userTradesWeightRemaining: 0,
      outcomes: {
        COMPLETE: 2,
        INCOMPLETE_SKIPPED_ROWS: 0,
        SPLIT: 1,
        SATURATED_SINGLE_MILLISECOND: 0,
        RETRY_SCHEDULED: 1,
        ABANDONED: 0,
        STALE_CLAIM: 1,
      },
      bootstrap: {
        horizonDays: 30,
        symbolCount: 3,
        dayCount: 30,
        expectedRootCount: 90,
        alreadyCompatibleCount: 85,
        createdCount: 4,
        raceReconciledCount: 1,
      },
    });
  });
});

describe("the completion summary is an allowlist", () => {
  it("H. carries no identifier, credential or exchange payload", async () => {
    const summary = summarizeHistoricalFillBatch(WORKER_ID, RESULT);
    const serialized = JSON.stringify(summary);

    // The result's bootstrap carries the profile id; the summary does not.
    expect(RESULT.bootstrap?.executionProfileId).toBe("profile-abc");
    expect(serialized).not.toContain("profile-abc");
    expect(summary.bootstrap).not.toHaveProperty("executionProfileId");
    for (const leaked of [
      "apiKey", "apiSecret", "secret", "token", "password", "signature",
      "DATABASE_URL", "Bearer", "claimOwner", "sanitizedLastError",
      "price", "quantity", "realizedPnl", "commission", "exchangeTradeId",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    // `symbolCount` is a COUNT, never a symbol: the summary says how many the
    // bootstrap saw and never which ones, so no instrument is named here.
    expect(typeof summary.bootstrap?.symbolCount).toBe("number");
    expect(serialized).not.toMatch(/[A-Z]{2,10}USDT/);
  });

  it("H. the key set is fixed, never a spread of whatever the driver returned", async () => {
    const summary = summarizeHistoricalFillBatch(WORKER_ID, RESULT);

    expect(Object.keys(summary).sort()).toEqual([
      "bootstrap", "event", "executionInvocations", "outcome", "outcomes",
      "userTradesRequests", "userTradesWeightBudget", "userTradesWeightRemaining",
      "userTradesWeightUsed", "workerId",
    ]);
    // A field added to the driver result later cannot appear here by accident.
    const polluted = { ...RESULT, internalCursor: "leak-me", rawBody: [1, 2, 3] };
    expect(JSON.stringify(summarizeHistoricalFillBatch(WORKER_ID, polluted))).not.toContain("leak");
    expect(JSON.stringify(summarizeHistoricalFillBatch(WORKER_ID, polluted))).not.toContain("rawBody");
  });

  it("H. request count and weight are read from their OWN fields, not a lookalike", async () => {
    // Deliberately chosen so every number is distinguishable: a pass that ended
    // on NO_WORK spent one invocation that dispatched nothing and was refunded,
    // so invocations (4) and requests (3) differ, and used (15) differs from
    // budget (25). With the obvious-looking fixture -- 5 invocations, 25 of 25
    // spent -- reading `executionInvocations` or `userTradesWeightBudget` by
    // mistake would produce the identical number and prove nothing.
    const distinguishable: HistoricalFillBatchResult = {
      outcome: "NO_WORK",
      bootstrap: BOOTSTRAP,
      executionInvocations: 4,
      outcomes: {
        COMPLETE: 2,
        INCOMPLETE_SKIPPED_ROWS: 0,
        SPLIT: 1,
        SATURATED_SINGLE_MILLISECOND: 0,
        RETRY_SCHEDULED: 0,
        ABANDONED: 0,
        STALE_CLAIM: 0,
      },
      userTradesRequestWeightPerDispatch: 5,
      userTradesWeightBudget: 25,
      userTradesWeightUsed: 15,
      userTradesWeightRemaining: 10,
    };

    const summary = summarizeHistoricalFillBatch(WORKER_ID, distinguishable);

    expect(summary.userTradesRequests).toBe(3);
    expect(summary.userTradesRequests).not.toBe(summary.executionInvocations);
    expect(summary.userTradesWeightUsed).toBe(15);
    expect(summary.userTradesWeightUsed).not.toBe(summary.userTradesWeightBudget);
    expect(summary.userTradesWeightBudget).toBe(25);
    expect(summary.userTradesWeightRemaining).toBe(10);
    expect(summary.executionInvocations).toBe(4);
  });

  it("carries the binder's reason only when the pass could not name the account", async () => {
    const unavailable: HistoricalFillBatchResult = {
      outcome: "PROFILE_UNAVAILABLE",
      stage: "BOOTSTRAP",
      reasonCode: "PROFILE_NOT_CONFIGURED",
      bootstrap: null,
      executionInvocations: 0,
      outcomes: { ...RESULT.outcomes, COMPLETE: 0, SPLIT: 0, RETRY_SCHEDULED: 0, STALE_CLAIM: 0 },
      userTradesRequestWeightPerDispatch: 5,
      userTradesWeightBudget: 25,
      userTradesWeightUsed: 0,
      userTradesWeightRemaining: 25,
    };

    const summary = summarizeHistoricalFillBatch(WORKER_ID, unavailable);

    expect(summary.profileUnavailableStage).toBe("BOOTSTRAP");
    expect(summary.profileUnavailableReasonCode).toBe("PROFILE_NOT_CONFIGURED");
    expect(summary.bootstrap).toBeNull();
    expect(summary.userTradesRequests).toBe(0);
    // A pass that spent nothing must not look like one that did.
    expect(summarizeHistoricalFillBatch(WORKER_ID, RESULT)).not.toHaveProperty(
      "profileUnavailableStage"
    );
  });
});

describe("a batch that throws is reported, not absorbed", () => {
  const boom = () => new Error("Historical fill batch invariant violated: 3 of 25 leaves 22, not 0");

  it("A+F. invokes the driver exactly once and never calls it again", async () => {
    const { createDriver, runHistoricalFillBatch } = scripted(async () => {
      throw boom();
    });

    await expect(
      runHistoricalFillRuntimeTick({ ...OPTIONS, createDriver, enabled: true })
    ).rejects.toThrow("invariant violated");

    expect(createDriver).toHaveBeenCalledTimes(1);
    expect(runHistoricalFillBatch).toHaveBeenCalledTimes(1);
  });

  it("B+D. emits one structured failure log and no success log", async () => {
    const { createDriver } = scripted(async () => {
      throw boom();
    });

    await expect(
      runHistoricalFillRuntimeTick({ ...OPTIONS, createDriver, enabled: true })
    ).rejects.toThrow();

    expect(error).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
    expect(error.mock.calls[0][1]).toBe("Historical fill batch failed");
    expect(error.mock.calls[0][0]).toEqual({
      event: HISTORICAL_FILL_BATCH_FAILED_EVENT,
      workerId: WORKER_ID,
      error: "Historical fill batch invariant violated: 3 of 25 leaves 22, not 0",
    });
  });

  it("C. rethrows the original error, unwrapped", async () => {
    const original = boom();
    const { createDriver } = scripted(async () => {
      throw original;
    });

    await expect(
      runHistoricalFillRuntimeTick({ ...OPTIONS, createDriver, enabled: true })
    ).rejects.toBe(original);
  });

  it("E. never retries: the window's own backoff owns that", async () => {
    let calls = 0;
    const { createDriver, runHistoricalFillBatch } = scripted(async () => {
      calls += 1;
      throw boom();
    });

    await expect(
      runHistoricalFillRuntimeTick({ ...OPTIONS, createDriver, enabled: true })
    ).rejects.toThrow();

    expect(calls).toBe(1);
    expect(runHistoricalFillBatch).toHaveBeenCalledTimes(1);
  });

  it("truncates a hostile error rather than relaying it whole", async () => {
    const { createDriver } = scripted(async () => {
      throw new Error("x".repeat(5000));
    });

    await expect(
      runHistoricalFillRuntimeTick({ ...OPTIONS, createDriver, enabled: true })
    ).rejects.toThrow();

    expect((error.mock.calls[0][0] as { error: string }).error).toHaveLength(300);
  });

  it("reports a non-Error throw without pretending to know what it was", async () => {
    const { createDriver } = scripted(async () => {
      throw "a string, somehow";
    });

    await expect(
      runHistoricalFillRuntimeTick({ ...OPTIONS, createDriver, enabled: true })
    ).rejects.toBe("a string, somehow");

    expect((error.mock.calls[0][0] as { error: string }).error).toBe("unknown");
  });
});

describe("nothing invokes the runtime automatically", () => {
  const read = (relative: string) =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require("node:fs") as typeof import("node:fs")).readFileSync(relative, "utf8");

  it("the runtime module starts no timer and runs nothing at import", async () => {
    const source = read("src/modules/jobs/historical-fill-runtime.ts");
    const code = source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
      })
      .join("\n");

    for (const forbidden of ["setInterval", "setTimeout", "cron", "unref", "process.on"]) {
      expect(code).not.toContain(forbidden);
    }
    // No module-level fire-and-forget: every call sits inside an exported
    // function, so importing this file starts nothing.
    expect(code).not.toMatch(/^void /m);
    expect(code).not.toMatch(/^runHistoricalFillRuntimeTick\(/m);
  });

  it("no production module calls the tick runner", () => {
    // The worker is the only place a recurring job is ever started, and it does
    // not know this module exists.
    const worker = read("src/modules/jobs/vision-analysis.worker.ts");
    expect(worker).not.toContain("historical-fill-runtime");
    expect(worker).not.toContain("runHistoricalFillRuntimeTick");

    const server = read("src/server.ts");
    expect(server).not.toContain("historical-fill-runtime");
    expect(server).not.toContain("runHistoricalFillRuntimeTick");

    const app = read("src/app.ts");
    expect(app).not.toContain("historical-fill-runtime");
  });
});

describe("the gate the runner actually reads", () => {
  const GATE = "EXECUTION_FILL_RUNTIME_ENABLED";
  const KILL = "EXECUTION_GLOBAL_KILL_SWITCH";
  const LIVE = "EXECUTION_LIVE_ENTRY_ENABLED";
  const PROTECTION = "EXECUTION_PROTECTION_READY";
  const KEYS = [GATE, KILL, LIVE, PROTECTION];
  const ORIGINAL = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of KEYS) {
      const original = ORIGINAL[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    vi.resetModules();
  });

  /** Loads the runtime module against a freshly parsed env, logger silenced. */
  async function loadRuntime(values: Record<string, string>) {
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    vi.resetModules();
    const { logger: fresh } = await import("../src/config/logger");
    vi.spyOn(fresh, "info").mockImplementation(() => fresh);
    vi.spyOn(fresh, "error").mockImplementation(() => fresh);
    return import("../src/modules/jobs/historical-fill-runtime");
  }

  it("with no explicit flag, a closed historical gate keeps the tick dormant", async () => {
    // Every trading gate wide open, historical gate shut. A runner that read
    // the kill switch (or either live gate) would start an exchange sweep here.
    const runtime = await loadRuntime({
      [GATE]: "false",
      [KILL]: "false",
      [LIVE]: "true",
      [PROTECTION]: "true",
    });
    const { createDriver, runHistoricalFillBatch } = scripted(async () => RESULT);

    const outcome = await runtime.runHistoricalFillRuntimeTick({ ...OPTIONS, createDriver });

    expect(outcome).toEqual({ status: "DISABLED" });
    expect(createDriver).not.toHaveBeenCalled();
    expect(runHistoricalFillBatch).not.toHaveBeenCalled();
  });

  it("with no explicit flag, an open historical gate runs despite shut trading gates", async () => {
    // The mirror image: historical ingestion is a read-only sweep, so a closed
    // kill switch is not a reason it cannot run.
    const runtime = await loadRuntime({
      [GATE]: "true",
      [KILL]: "true",
      [LIVE]: "false",
      [PROTECTION]: "false",
    });
    const { createDriver, runHistoricalFillBatch } = scripted(async () => RESULT);

    const outcome = await runtime.runHistoricalFillRuntimeTick({ ...OPTIONS, createDriver });

    expect(outcome.status).toBe("RAN");
    expect(runHistoricalFillBatch).toHaveBeenCalledTimes(1);
  });

  it("the runner names no trading flag at all", async () => {
    const source = (await import("node:fs")).readFileSync(
      "src/modules/jobs/historical-fill-runtime.ts",
      "utf8"
    );
    const code = source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
      })
      .join("\n");

    expect(code).toContain("env.EXECUTION_FILL_RUNTIME_ENABLED");
    for (const trading of [
      "EXECUTION_GLOBAL_KILL_SWITCH",
      "EXECUTION_LIVE_ENTRY_ENABLED",
      "EXECUTION_PROTECTION_READY",
      "killSwitchActive",
    ]) {
      expect(code).not.toContain(trading);
    }
    // Exactly one env read: the gate. Nothing else is consulted.
    expect(code.match(/env\./g)).toHaveLength(1);
  });
});
