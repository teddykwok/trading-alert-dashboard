import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The historical-fill runtime gate.
 *
 * One boolean that decides whether a tick may run a batch at all. The real env
 * schema is parsed rather than mocked -- the schema IS the thing under test,
 * and a stub would only prove the stub agrees with itself.
 *
 * No database, no Binance, no timer, and nothing that runs a batch.
 */

const GATE = "EXECUTION_FILL_RUNTIME_ENABLED";
const KILL = "EXECUTION_GLOBAL_KILL_SWITCH";
const LIVE = "EXECUTION_LIVE_ENTRY_ENABLED";
const PROTECTION = "EXECUTION_PROTECTION_READY";
const KEYS = [GATE, KILL, LIVE, PROTECTION];

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

describe("the historical-fill runtime gate", () => {
  it("A. defaults to false when the key is absent", async () => {
    const env = await loadEnv({ [GATE]: undefined });

    expect(env[GATE]).toBe(false);
    expect(typeof env[GATE]).toBe("boolean");
  });

  it("B. parses an explicit \"false\" as false", async () => {
    const env = await loadEnv({ [GATE]: "false" });

    expect(env[GATE]).toBe(false);
  });

  it("C. parses an explicit \"true\" as true", async () => {
    const env = await loadEnv({ [GATE]: "true" });

    expect(env[GATE]).toBe(true);
  });

  it("D. refuses a near-miss instead of silently choosing a value", async () => {
    // The Phase 10 maintenance-gate doctrine: a switch that authorizes real
    // exchange requests must never be decided by a typo. "TRUE" reading as
    // false would be lucky rather than correct, and "1" reading as true would
    // be a sweep nobody configured.
    for (const bad of ["TRUE", "True", "1", "0", "yes", "no", "on", "off", "", " true"]) {
      await expect(loadEnv({ [GATE]: bad })).rejects.toThrow("Invalid environment variables");
    }
  });
});

describe("the gate is nobody else's flag", () => {
  it("E+F+G. opening every trading gate leaves the historical runtime dormant", async () => {
    // The exact production-dangerous confusion: an operator opens a trading
    // window and an exchange sweep starts that nobody asked for.
    const env = await loadEnv({
      [GATE]: undefined,
      [KILL]: "false",
      [LIVE]: "true",
      [PROTECTION]: "true",
    });

    expect(env[GATE]).toBe(false);
    expect(env[LIVE]).toBe(true);
    expect(env[PROTECTION]).toBe(true);
    expect(env[KILL]).toBe(false);
  });

  it("E+F+G. closing every trading gate leaves an enabled historical runtime enabled", async () => {
    // And the reverse: historical ingestion is a read-only sweep, so the
    // trading gates being shut is not a reason it cannot run.
    const env = await loadEnv({
      [GATE]: "true",
      [KILL]: "true",
      [LIVE]: "false",
      [PROTECTION]: "false",
    });

    expect(env[GATE]).toBe(true);
    expect(env[KILL]).toBe(true);
    expect(env[LIVE]).toBe(false);
    expect(env[PROTECTION]).toBe(false);
  });

  it("E+F+G. the gate is a distinct key, not an alias", async () => {
    const env = await loadEnv({ [GATE]: "true", [KILL]: "true", [LIVE]: "false", [PROTECTION]: "false" });

    // Four independent keys: no two of them move together.
    expect(env[GATE]).not.toBe(env[LIVE]);
    expect(env[GATE]).not.toBe(env[PROTECTION]);
    expect(env[GATE]).toBe(env[KILL]);
    // ...and the source never derives one from another.
    const source = (await import("node:fs")).readFileSync("src/config/env.ts", "utf8");
    expect(source).not.toContain(`${GATE}: z.boolean()`);
    for (const other of [KILL, LIVE, PROTECTION]) {
      expect(source).not.toContain(`${GATE}: env.${other}`);
      expect(source).not.toContain(`${other} && `);
    }
  });
});
