import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Alert, PrismaClient } from "@prisma/client";

import {
  EXTREME_RR_DEFAULT_LOOKBACK,
  EXTREME_RR_LOOKBACKS,
  isExtremeRRLookback,
} from "@trading-alert-dashboard/shared";
import { describeStoredLookback } from "../src/modules/operator/extreme-rr-lookback.service";
import { ExtremeRRService, resolveInitialLookback } from "../src/modules/extreme-rr/extreme-rr.service";

/**
 * The durable Extreme RR lookback policy.
 *
 * The value chooses ONE thing: which candidate a NEW plan starts on. Every
 * supported lookback is still calculated and frozen on every plan from a single
 * candle dataset, so this policy can never reach a plan that already exists and
 * can never reach an execution.
 *
 * The rule carrying the safety weight: an unsupported stored value is INVALID
 * configuration, not a request to fall back. Quietly planning at 300 would
 * build a trade from a window nobody selected, so planning refuses instead.
 *
 * Everything here is pure — no database, no Binance, no runtime.
 */

const BACKEND = process.cwd();
// `configuredProfileIdentity()` reads the import-time env snapshot, and an
// empty identifier short-circuits the resolver before it queries anything.
process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER ||= "rr-lookback-test";
const MINUTE = 60_000;
const CUTOFF = new Date("2026-01-01T12:00:00.000Z");

// ---------------------------------------------------------------------------
// A. Validation
// ---------------------------------------------------------------------------

describe("rr lookback: the supported vocabulary", () => {
  it("is exactly 50/100/200/300, and 300 remains the shipped default", () => {
    expect([...EXTREME_RR_LOOKBACKS]).toEqual([50, 100, 200, 300]);
    expect(EXTREME_RR_DEFAULT_LOOKBACK).toBe(300);
  });

  it("accepts every supported value and nothing else", () => {
    for (const value of EXTREME_RR_LOOKBACKS) {
      expect(`${value}:${isExtremeRRLookback(value)}`).toBe(`${value}:true`);
    }
    // Neighbours of every boundary, plus the shapes an API could smuggle in.
    for (const bad of [49, 51, 99, 101, 150, 199, 201, 250, 299, 301, 400, 0, -50, 1, 30]) {
      expect(`${bad}:${isExtremeRRLookback(bad)}`).toBe(`${bad}:false`);
    }
    for (const bad of ["300", null, undefined, NaN, Infinity, 300.5, {}, [300], true]) {
      expect(`${String(bad)}:${isExtremeRRLookback(bad)}`).toBe(`${String(bad)}:false`);
    }
  });

  it("reports a stored value honestly rather than repairing it", () => {
    expect(describeStoredLookback(50)).toEqual({
      stored: 50,
      effective: 50,
      valid: true,
      supported: [50, 100, 200, 300],
    });

    // The single most important assertion here: an unsupported row is INVALID
    // and its effective value is null — never silently 300.
    for (const bad of [150, 0, -1, 301]) {
      const described = describeStoredLookback(bad);
      expect(`${bad}:${described.valid}`).toBe(`${bad}:false`);
      expect(`${bad}:${described.effective}`).toBe(`${bad}:null`);
    }
    expect(describeStoredLookback(undefined).valid).toBe(false);
    expect(describeStoredLookback(null).effective).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Resolver: GLOBAL configuration, and invalid is still refused
// ---------------------------------------------------------------------------

describe("rr lookback: resolving the initial value for a NEW plan", () => {
  /**
   * Phase 11F moved this input off the ExecutionProfile.
   *
   * Since 11E one ExtremeRRPlan is generated per alert and adopted
   * INDEPENDENTLY by every account, so a window owned by one account's policy
   * shaped a plan the other account would also trade. It is deployment
   * configuration now, and the resolver takes no database at all.
   *
   * `env` is frozen at module import, so each case re-imports the module under
   * a pinned environment rather than mutating a value already read.
   */
  async function resolveUnder(value: string | undefined) {
    const previous = process.env.EXTREME_RR_LOOKBACK_CANDLES;
    if (value === undefined) delete process.env.EXTREME_RR_LOOKBACK_CANDLES;
    else process.env.EXTREME_RR_LOOKBACK_CANDLES = value;
    vi.resetModules();
    try {
      const module = await import("../src/modules/extreme-rr/extreme-rr.service");
      return module.resolveInitialLookback();
    } finally {
      if (previous === undefined) delete process.env.EXTREME_RR_LOOKBACK_CANDLES;
      else process.env.EXTREME_RR_LOOKBACK_CANDLES = previous;
      vi.resetModules();
    }
  }

  it("uses the GLOBAL configured window", async () => {
    await expect(resolveUnder("200")).resolves.toBe(200);
    await expect(resolveUnder("50")).resolves.toBe(50);
  });

  it("falls back to 300 when nothing is configured", async () => {
    // The pre-feature situation: nothing has ever expressed a preference, and
    // the system planned at 300 before this was configurable.
    await expect(resolveUnder(undefined)).resolves.toBe(300);
  });

  it("REFUSES an unsupported value at CONFIG PARSE, before any plan", async () => {
    // The regression this closes: 500 used to pass startup, let all four
    // processes become operational, and only fail when the first alert tried
    // to generate a plan -- long after a rollout would have been accepted.
    //
    // `config/env` throws while the module graph loads, so the failure
    // arrives here, at import, rather than at generation time.
    await expect(resolveUnder("150")).rejects.toThrow(/Invalid environment variables/);
  });

  it("needs no database, no profile and no credentials", async () => {
    // The generic runtimes hold none of those after the 11F split, and plan
    // generation happens there.
    const previous = { ...process.env };
    for (const key of [
      "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER",
      "BINANCE_API_KEY",
      "BINANCE_API_SECRET",
    ]) {
      delete process.env[key];
    }
    process.env.EXTREME_RR_LOOKBACK_CANDLES = "100";
    vi.resetModules();
    try {
      const module = await import("../src/modules/extreme-rr/extreme-rr.service");
      // Synchronous, and takes no arguments: there is nothing to pass a
      // PrismaClient to any more.
      expect(module.resolveInitialLookback.length).toBe(0);
      expect(module.resolveInitialLookback()).toBe(100);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previous);
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// C/D. New-plan initialization and freeze
// ---------------------------------------------------------------------------

function makeCandles(count: number, high: string) {
  return Array.from({ length: count }, (_, index) => ({
    openTimeMs: CUTOFF.getTime() - (count - index) * MINUTE,
    closeTimeMs: CUTOFF.getTime() - (count - index - 1) * MINUTE,
    high,
    low: "50",
  }));
}

function harness(policyLookback: number) {
  const stored: Record<string, unknown> = {};
  const alert = {
    id: "alert-1",
    symbol: "SYNTHUSDT",
    assetType: "CRYPTO",
    timeframe: "15m",
    price: 100,
    signal: "LONG",
    triggeredAt: CUTOFF,
    rawPayload: {},
    exchange: null,
  } as unknown as Alert;

  const prisma = {
    alert: { findUnique: vi.fn().mockResolvedValue(alert) },
    riskTemplate: { findFirst: vi.fn().mockResolvedValue(null) },
    extremeRRPlan: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }) => {
        Object.assign(stored, data);
        return {
          ...data,
          id: "plan-1",
          candidates: data.candidates ?? null,
          createdAt: CUTOFF,
          updatedAt: CUTOFF,
          generatedAt: CUTOFF,
          cutoffAt: CUTOFF,
          selectedLeverage: null,
        };
      }),
      upsert: vi.fn().mockImplementation(({ create }) => {
        Object.assign(stored, create);
        // `serialize` reads these; the real row always has them.
        return {
          ...create,
          id: "plan-1",
          createdAt: CUTOFF,
          updatedAt: CUTOFF,
          generatedAt: CUTOFF,
          cutoffAt: CUTOFF,
          selectedLeverage: null,
          telegramStatus: null,
          telegramNotifiedAt: null,
          telegramLastError: null,
        };
      }),
    },
  } as unknown as PrismaClient;

  const service = new ExtremeRRService(
    prisma,
    async () => makeCandles(300, "200"),
    async () => policyLookback as never
  );
  return { service, stored, alert, prisma };
}

describe("rr lookback: a NEW plan starts on the policy value", () => {
  it.each([50, 100, 200, 300])("policy %i -> new plan selectedLookback = %i", async (policy) => {
    const { service, stored } = harness(policy);
    await service.generateForAlert("alert-1");
    expect(stored.selectedLookback).toBe(policy);
  });

  it("still calculates and freezes EVERY supported candidate, not just the selected one", async () => {
    // The policy chooses a starting point; it must never narrow what the plan
    // knows, or the per-alert planner would have nothing to switch to.
    const { service, stored } = harness(50);
    await service.generateForAlert("alert-1");
    const candidates = stored.candidates as Array<{ requestedCandles: number }>;
    expect(candidates.map((c) => c.requestedCandles)).toEqual([50, 100, 200, 300]);
  });

  it("ensurePendingPlan also seeds the policy value, not the shipped constant", async () => {
    const { service, stored, alert } = harness(200);
    await service.ensurePendingPlan(alert);
    expect(stored.selectedLookback).toBe(200);
  });
});

describe("rr lookback: existing plans are frozen", () => {
  it("D. regeneration NEVER rewrites an existing plan's selectedLookback", () => {
    // Structural, because it is a property of the upsert rather than of any one
    // run: `selectedLookback` appears in the create branch and must never
    // appear in the update branch, or regenerating an old alert would silently
    // re-point it at today's policy.
    const source = readFileSync(
      path.join(BACKEND, "src/modules/extreme-rr/extreme-rr.service.ts"),
      "utf8"
    );
    const upsert = source.slice(source.indexOf("extremeRRPlan.upsert({"));
    const createBranch = upsert.slice(upsert.indexOf("create: {"), upsert.indexOf("update: {"));
    const updateBranch = upsert.slice(upsert.indexOf("update: {"), upsert.indexOf("return this.serialize(saved)"));

    expect(createBranch).toContain("selectedLookback: initialLookback");
    expect(updateBranch).not.toContain("selectedLookback");
  });

  it("E. no protection or reconciliation path consults the policy", () => {
    // The policy is a PLANNING input. A protection tick that read it could
    // re-derive a live trade's numbers from today's setting.
    for (const file of [
      "src/modules/execution/protection-lifecycle.service.ts",
      "src/modules/execution/entry-lifecycle.service.ts",
      "src/modules/execution/execution-orchestrator.ts",
      "src/modules/jobs/execution-orchestration.scheduler.ts",
      "src/modules/execution/safety-engine.ts",
    ]) {
      const code = readFileSync(path.join(BACKEND, file), "utf8");
      expect(`${file}:${code.includes("extremeRrLookbackCandles")}`).toBe(`${file}:false`);
      expect(`${file}:${code.includes("resolveInitialLookback")}`).toBe(`${file}:false`);
    }
  });

  it("the per-alert planner selection remains a separate, still-writable concept", () => {
    // Global policy = the INITIAL choice for a NEW plan.
    // plan.selectedLookback = the current choice for THAT plan.
    const service = readFileSync(
      path.join(BACKEND, "src/modules/extreme-rr/extreme-rr.service.ts"),
      "utf8"
    );
    expect(service).toContain("async updateSelection(");
    const schema = readFileSync(
      path.join(BACKEND, "src/modules/extreme-rr/extreme-rr.schema.ts"),
      "utf8"
    );
    expect(schema).toContain("selectedLookback");
  });
});

// ---------------------------------------------------------------------------
// B. Migration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 11F: the window is GLOBAL, and nothing may quietly re-own it
// ---------------------------------------------------------------------------

describe("rr lookback: global ownership cannot be taken back", () => {
  const codeOf = (relative: string) =>
    readFileSync(path.join(BACKEND, relative), "utf8")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/\/\*[\s\S]*?\*\//g, "");

  const GENERATION = "src/modules/extreme-rr/extreme-rr.service.ts";
  const OPERATOR = "src/modules/operator/extreme-rr-lookback.service.ts";
  const ROUTES = "src/routes/operator.routes.ts";

  it("plan generation resolves no account identity and no profile", () => {
    // The whole point. Since 11E one plan is generated per alert and adopted
    // independently by every account, so an input owned by one account's
    // profile shaped a plan the other account would also trade. After the
    // 11F split the generic runtimes hold no account at all, so reading a
    // profile here would silently mean 'whichever account this process is'.
    const code = codeOf(GENERATION);
    for (const forbidden of [
      "configuredProfileIdentity",
      "resolveExecutionProfile",
      "extremeRrLookbackCandles",
      "execution-profile.service",
    ]) {
      expect(`${forbidden} in plan generation: ${code.includes(forbidden)}`).toBe(
        `${forbidden} in plan generation: false`
      );
    }
    expect(code).toContain("env.EXTREME_RR_LOOKBACK_CANDLES");
  });

  it("the resolver takes no arguments, so no caller can aim it at a profile", () => {
    // A signature that still accepted a PrismaClient would leave the door
    // open for a caller to hand it a per-account read again.
    expect(resolveInitialLookback.length).toBe(0);
  });

  it("the operator control reports the global window and writes nothing", () => {
    const code = codeOf(OPERATOR);
    expect(code).toContain("env.EXTREME_RR_LOOKBACK_CANDLES");
    // No write of the legacy column, and no profile resolution left.
    for (const forbidden of [
      "executionSafetyPolicy.update",
      "extremeRrLookbackCandles: requested",
      "configuredProfileIdentity",
      "resolveExecutionProfile",
    ]) {
      expect(`${forbidden} in operator control: ${code.includes(forbidden)}`).toBe(
        `${forbidden} in operator control: false`
      );
    }
  });

  it("both operator endpoints stay behind the operator auth boundary", () => {
    // Moving a value to global configuration must not make reading or
    // attempting to write it public. Both handlers keep the same preHandler
    // every other operator route uses.
    const routes = codeOf(ROUTES);
    const block = routes.slice(
      routes.indexOf('"/api/operator/trading-control/rr-lookback"'),
      routes.indexOf('"/api/operator/trading-control/policy"')
    );
    expect(block.match(/requireOperatorAuth/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("the legacy column is marked, and read by nothing that plans", () => {
    const schema = readFileSync(path.join(BACKEND, "prisma/schema.prisma"), "utf8");
    expect(schema).toContain("LEGACY_UNUSED since Phase 11F");
    // Retained because dropping it needs a migration this slice does not
    // carry -- but nothing may read it to shape a plan.
    expect(schema).toContain("extremeRrLookbackCandles Int @default(300)");
  });
});

// ---------------------------------------------------------------------------
// Phase 11F: invalid configuration fails BEFORE runtime acceptance
// ---------------------------------------------------------------------------

describe("rr lookback: configuration is validated at parse time", () => {
  /**
   * Loads `config/env` under a pinned value and reports what happened.
   *
   * `env` is parsed once at module import and throws on a bad schema, so this
   * is the same code path every process takes at startup: a rejection here is
   * a process that never becomes operational.
   */
  async function parseUnder(value: string | undefined) {
    const previous = process.env.EXTREME_RR_LOOKBACK_CANDLES;
    if (value === undefined) delete process.env.EXTREME_RR_LOOKBACK_CANDLES;
    else process.env.EXTREME_RR_LOOKBACK_CANDLES = value;
    vi.resetModules();
    try {
      const module = await import("../src/config/env");
      return { ok: true as const, value: module.env.EXTREME_RR_LOOKBACK_CANDLES };
    } catch (error) {
      return { ok: false as const, error: error as Error };
    } finally {
      if (previous === undefined) delete process.env.EXTREME_RR_LOOKBACK_CANDLES;
      else process.env.EXTREME_RR_LOOKBACK_CANDLES = previous;
      vi.resetModules();
    }
  }

  it.each(EXTREME_RR_LOOKBACKS)("%i is accepted", async (supported) => {
    const result = await parseUnder(String(supported));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(supported);
  });

  it.each([500, 150, 301, 0, -1, -300])(
    "%i is REFUSED at parse, so no process becomes operational",
    async (unsupported) => {
      const result = await parseUnder(String(unsupported));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/Invalid environment variables/);
    }
  );

  it("an unset value keeps the shipped default", async () => {
    const result = await parseUnder(undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(300);
  });

  it("the GENERIC backend cannot reach a healthy start on a bad value", async () => {
    // server.ts imports config/env at module load, so the throw happens before
    // buildApp, before listen and before anything reports health. Proven by
    // loading the same module the entrypoint loads first.
    const result = await parseUnder("500");
    expect(result.ok).toBe(false);

    const server = readFileSync(path.join(BACKEND, "src/server.ts"), "utf8");
    const envImport = server.indexOf('from "./config/env"');
    expect(envImport).toBeGreaterThan(-1);
    // Imported, not lazily required inside start(): a deferred read would let
    // the process listen first and fail afterwards.
    expect(server.indexOf("async function start(")).toBeGreaterThan(envImport);
  });

  it("validates against the canonical vocabulary, not a second copy", async () => {
    // A literal [50, 100, 200, 300] in the env schema would be a second
    // vocabulary, free to drift from the one the planner uses.
    const raw = readFileSync(path.join(BACKEND, "src/config/env.ts"), "utf8");
    // Comments may NAME the vocabulary; code may not re-declare it.
    const source = raw
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).toContain("isExtremeRRLookback");
    expect(source).toContain("EXTREME_RR_LOOKBACKS");
    expect(source).toContain("refine(isExtremeRRLookback");
    expect(`literal vocabulary in env schema: ${/\[\s*50\s*,\s*100\s*,\s*200\s*,\s*300\s*\]/.test(source)}`).toBe(
      `literal vocabulary in env schema: false`
    );
  });
});

describe("rr lookback: the migration", () => {
  const migration = readFileSync(
    path.join(BACKEND, "prisma/migrations/20260824090000_add_extreme_rr_lookback_policy/migration.sql"),
    "utf8"
  );

  it("is additive only and defaults existing rows to 300", () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "extremeRrLookbackCandles" INTEGER NOT NULL DEFAULT 300');
    expect(migration).not.toMatch(/DROP |TRUNCATE|DELETE FROM|CREATE TABLE|ALTER COLUMN|RENAME/);
  });

  it("backfills no plan and no execution", () => {
    // Their own frozen `selectedLookback` is the truth about what each row was
    // built from; rewriting it here would change what a past trade claims.
    // Comments may NAME those tables; only executable SQL may not touch them.
    const sql = migration
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).not.toContain("ExtremeRRPlan");
    expect(sql).not.toContain("TradeExecution");
    expect(sql).not.toMatch(/UPDATE\s+"/);
    expect(sql.match(/ALTER TABLE/g) ?? []).toHaveLength(1);
  });
});
