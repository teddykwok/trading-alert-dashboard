import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The SHARED historical ceiling's configuration contract.
 *
 * The real env schema is parsed rather than mocked -- the schema is the thing
 * under test. No database, no Binance, nothing that runs.
 */

const CAP = "EXECUTION_FILL_GLOBAL_USER_TRADES_WEIGHT_PER_MINUTE";
const GATE = "EXECUTION_FILL_RUNTIME_ENABLED";
const LOCAL = "EXECUTION_FILL_BATCH_MAX_USER_TRADES_WEIGHT";
const KEYS = [CAP, GATE, LOCAL];

const ORIGINAL = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

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
  for (const key of KEYS) {
    const original = ORIGINAL[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  vi.resetModules();
});

describe("the shared ceiling has no convenient default", () => {
  it("is absent when unset, so nothing can be enabled by accident", async () => {
    const env = await loadEnv({ [CAP]: undefined, [GATE]: "false" });

    expect(env[CAP]).toBeUndefined();
  });

  it("parses a valid multiple of one dispatch", async () => {
    for (const [raw, parsed] of [["5", 5], ["25", 25], ["500", 500]] as const) {
      const env = await loadEnv({ [CAP]: raw, [GATE]: "false" });
      expect(env[CAP]).toBe(parsed);
      expect(typeof env[CAP]).toBe("number");
    }
  });

  it("refuses anything that is not a whole multiple of one dispatch", async () => {
    // 27 would buy exactly the same five requests as 25 while reading as more.
    for (const bad of ["0", "1", "4", "7", "26", "27", "-5", "2.5", "abc", ""]) {
      await expect(loadEnv({ [CAP]: bad, [GATE]: "false" })).rejects.toThrow(
        "Invalid environment variables"
      );
    }
  });
});

describe("the ceiling is required exactly when the runtime may run", () => {
  it("fails startup when the runtime is enabled without a shared ceiling", async () => {
    await expect(loadEnv({ [GATE]: "true", [CAP]: undefined })).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it("starts when the runtime is enabled WITH a shared ceiling", async () => {
    const env = await loadEnv({ [GATE]: "true", [CAP]: "25" });

    expect(env[GATE]).toBe(true);
    expect(env[CAP]).toBe(25);
  });

  it("does not require the ceiling while the runtime is off", async () => {
    const env = await loadEnv({ [GATE]: "false", [CAP]: undefined });

    expect(env[GATE]).toBe(false);
    expect(env[CAP]).toBeUndefined();
  });
});

describe("the shared ceiling is not the per-batch budget", () => {
  it("is a distinct key that does not move with the local one", async () => {
    const env = await loadEnv({ [CAP]: "500", [LOCAL]: "25", [GATE]: "false" });

    expect(env[CAP]).toBe(500);
    expect(env[LOCAL]).toBe(25);
    expect(env[CAP]).not.toBe(env[LOCAL]);
  });

  it("neither is derived from the other in source", async () => {
    const source = (await import("node:fs")).readFileSync("src/config/env.ts", "utf8");

    expect(source).not.toContain(`${CAP}: env.${LOCAL}`);
    expect(source).not.toContain(`${LOCAL}: env.${CAP}`);
    // The local budget keeps its own untouched default.
    const env = await loadEnv({ [LOCAL]: undefined, [GATE]: "false", [CAP]: undefined });
    expect(env[LOCAL]).toBe(25);
  });
});
