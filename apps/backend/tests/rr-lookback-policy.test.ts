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
// Resolver: unreadable is NOT the same as invalid
// ---------------------------------------------------------------------------

describe("rr lookback: resolving the initial value for a NEW plan", () => {
  const prismaWithPolicy = (extremeRrLookbackCandles: unknown) =>
    ({
      executionProfile: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "profile-1",
            isEnabled: false,
            safetyPolicy: { extremeRrLookbackCandles },
          },
        ]),
      },
    }) as unknown as PrismaClient;

  it("falls back to 300 when NO profile or policy can be read", async () => {
    // The pre-feature situation: nothing has ever expressed a preference, and
    // the system planned at 300 before the column existed.
    const empty = {
      executionProfile: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    await expect(resolveInitialLookback(empty)).resolves.toBe(300);
  });

  it("falls back to 300 when the profile read THROWS", async () => {
    const broken = {
      executionProfile: { findMany: vi.fn().mockRejectedValue(new Error("db down")) },
    } as unknown as PrismaClient;
    await expect(resolveInitialLookback(broken)).resolves.toBe(300);
  });

  it("REFUSES rather than coercing when the stored value is unsupported", async () => {
    // Being unable to READ is not the same as holding a number nobody
    // recognises. Only the latter is a misconfiguration, and it must not
    // silently become 300.
    await expect(resolveInitialLookback(prismaWithPolicy(150))).rejects.toThrow(/not one of/);
    await expect(resolveInitialLookback(prismaWithPolicy(0))).rejects.toThrow(/refusing to plan/);
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
