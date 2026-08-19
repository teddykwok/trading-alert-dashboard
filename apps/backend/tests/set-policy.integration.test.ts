import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase, databaseNameOf } from "./helpers/test-database";

/**
 * `execution:set-policy` — the operator tool for the profile's monetary limits.
 *
 * The whole point of this command is that it is the ONLY sanctioned way to
 * change `maxTotalIsolatedMarginUsd` on a real profile, so these tests care
 * about three things above correctness of the printout:
 *
 *  1. Nothing is written without `--confirm`.
 *  2. Every write goes through `SafetyPolicyService.updateForProfile`, with the
 *     version that was read — a stale row must fail, not win.
 *  3. Only the requested column moves.
 *
 * Safety of the suite itself mirrors `canary-controls.integration.test.ts`:
 * `EXECUTION_PROFILE_ACCOUNT_IDENTIFIER` is redirected to a throwaway profile
 * in the dedicated test database before any module reads config, so the real
 * canary profile is not merely left alone — it does not exist here.
 */

const REAL_IDENTIFIER = "mainnet-canary-usdm";
const TEST_IDENTIFIER = `set-policy-${randomBytes(6).toString("hex")}`;

const { prisma: testDatabase, available, name: testDatabaseName } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

// The CLI builds its own PrismaClient from DATABASE_URL, so the process-wide
// URL must already point at the test database or nothing below is safe.
if (databaseNameOf(process.env.DATABASE_URL ?? "") !== testDatabaseName) {
  throw new Error("Refusing to run: the CLI under test would not use the test database.");
}

/** Env globals the CLI merges the row against. Deliberately the canary values. */
const GLOBALS = {
  EXECUTION_MAX_OPEN_POSITIONS: "1",
  EXECUTION_MAX_PENDING_ENTRIES: "1",
  EXECUTION_MAX_TOTAL_ACTIVE_TRADES: "1",
  EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE: "1",
  EXECUTION_MAX_TOTAL_PLANNED_RISK_USD: "1.50",
  EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD: "8.00",
};

const OVERRIDDEN = ["EXECUTION_PROFILE_ACCOUNT_IDENTIFIER", "EXECUTION_PROFILE_ENVIRONMENT", ...Object.keys(GLOBALS)];
const originalEnv = new Map(OVERRIDDEN.map((key) => [key, process.env[key]]));

async function loadCli(overrides: Record<string, string> = {}) {
  vi.resetModules();
  process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = TEST_IDENTIFIER;
  process.env.EXECUTION_PROFILE_ENVIRONMENT = "MAINNET";
  Object.assign(process.env, GLOBALS, overrides);
  return {
    cli: await import("../src/modules/execution/run-set-policy"),
    // The SAME module instance the CLI resolves, so a spy here is the spy the
    // command actually calls.
    service: await import("../src/modules/execution/safety-policy.service"),
  };
}

let captured: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn> | null = null;
const output = () => captured.join("\n");

let profileId = "";

/** Every column, so a test can prove exactly one of them moved. */
async function policySnapshot() {
  const row = await prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });
  return {
    killSwitchActive: row.killSwitchActive,
    maxOpenPositions: row.maxOpenPositions,
    maxPendingEntries: row.maxPendingEntries,
    maxTotalActiveTrades: row.maxTotalActiveTrades,
    maxActivePerSymbolSide: row.maxActivePerSymbolSide,
    maxAlertAgeSeconds: row.maxAlertAgeSeconds,
    maxTotalPlannedRiskUsd: row.maxTotalPlannedRiskUsd.toFixed(),
    maxTotalIsolatedMarginUsd: row.maxTotalIsolatedMarginUsd.toFixed(),
    allowedSymbols: row.allowedSymbols,
    version: row.version,
  };
}

async function resetPolicy() {
  await prisma!.executionSafetyPolicy.update({
    where: { executionProfileId: profileId },
    data: {
      killSwitchActive: true,
      maxOpenPositions: 1,
      maxPendingEntries: 1,
      maxTotalActiveTrades: 1,
      maxActivePerSymbolSide: 1,
      maxAlertAgeSeconds: 300,
      maxTotalPlannedRiskUsd: "1.50",
      // The value the operator will actually be migrating away from.
      maxTotalIsolatedMarginUsd: "5.00",
      allowedSymbols: [],
    },
  });
}

if (available) {
  const profile = await prisma!.executionProfile.create({
    data: { name: TEST_IDENTIFIER, accountIdentifier: TEST_IDENTIFIER, environment: "MAINNET" },
  });
  await prisma!.executionSafetyPolicy.create({ data: { executionProfileId: profile.id } });
  profileId = profile.id;
}

beforeEach(async () => {
  captured = [];
  process.argv = ["node", "set-policy"];
  process.exitCode = undefined;
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  });
  if (available) await resetPolicy();
});

afterEach(() => {
  logSpy?.mockRestore();
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (!prisma) return;
  if (available && profileId) {
    await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionProfile.deleteMany({ where: { id: profileId } });
  }
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  await prisma.$disconnect();
});

const describeDb = available ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describeDb("execution:set-policy — dry run", () => {
  it("writes NOTHING without --confirm and says so", async () => {
    const before = await policySnapshot();
    process.argv = ["node", "set-policy", "--max-total-isolated-margin-usd=8.00"];
    const { cli } = await loadCli();
    await cli.setPolicy();

    expect(output()).toContain("DRY RUN");
    expect(output()).toContain("NO DATABASE WRITE WAS PERFORMED");
    expect(await policySnapshot()).toEqual(before);
    // A dry run is a successful operation, not a failure.
    expect(process.exitCode).toBeUndefined();
  });

  it("reports current, proposed, global, effective-now and effective-after", async () => {
    process.argv = ["node", "set-policy", "--max-total-isolated-margin-usd=8.00"];
    const { cli } = await loadCli();
    await cli.setPolicy();

    const text = output();
    expect(text).toMatch(/current row\s+5/);
    expect(text).toMatch(/proposed row\s+8/);
    expect(text).toMatch(/global \(env\)\s+8\.00/);
    // The whole reason this branch exists: 8.00 global clamped to 5.00 by the
    // row today, and 8.00 after the change.
    expect(text).toMatch(/effective now\s+5/);
    expect(text).toMatch(/effective after\s+8/);
    expect(text).toMatch(/canary requires\s+8\.00/);
  });

  it("names MAINNET before any confirmation", async () => {
    process.argv = ["node", "set-policy", "--max-total-isolated-margin-usd=8.00"];
    const { cli } = await loadCli();
    await cli.setPolicy();

    expect(output()).toContain("MAINNET — REAL FUNDS");
    // Environment must be printed BEFORE the dry-run verdict, not after it.
    expect(output().indexOf("MAINNET")).toBeLessThan(output().indexOf("DRY RUN"));
  });

  it("rejects a malformed value during the dry run, before any --confirm exists", async () => {
    const before = await policySnapshot();
    for (const bad of ["-1", "0", "abc", "NaN", ""]) {
      captured = [];
      process.exitCode = undefined;
      process.argv = ["node", "set-policy", `--max-total-isolated-margin-usd=${bad}`];
      const { cli } = await loadCli();
      await cli.setPolicy();
      expect(output(), bad).toMatch(/INVALID|No policy value was requested/);
      expect(process.exitCode, bad).toBe(1);
    }
    expect(await policySnapshot()).toEqual(before);
  });

  it("fails closed when no field is requested", async () => {
    process.argv = ["node", "set-policy"];
    const { cli } = await loadCli();
    await cli.setPolicy();
    expect(output()).toContain("No policy value was requested");
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Confirmed write
// ---------------------------------------------------------------------------

describeDb("execution:set-policy — --confirm", () => {
  it("applies 5.00 -> 8.00 through SafetyPolicyService.updateForProfile", async () => {
    const before = await policySnapshot();
    const { cli, service } = await loadCli();
    const spy = vi.spyOn(service.SafetyPolicyService.prototype, "updateForProfile");

    process.argv = ["node", "set-policy", "--max-total-isolated-margin-usd=8.00", "--confirm"];
    await cli.setPolicy();

    expect(spy).toHaveBeenCalledTimes(1);
    // Called with the profile id, the version that was READ, and only the
    // requested field.
    expect(spy.mock.calls[0][0]).toBe(profileId);
    expect(spy.mock.calls[0][1]).toBe(before.version);
    expect(spy.mock.calls[0][2]).toEqual({ maxTotalIsolatedMarginUsd: "8.00" });

    const after = await policySnapshot();
    expect(after.maxTotalIsolatedMarginUsd).toBe("8");
    expect(after.version).toBe(before.version + 1);
    expect(output()).toContain("APPLIED");
    expect(process.exitCode).toBeUndefined();
  });

  it("changes ONLY the requested column", async () => {
    const before = await policySnapshot();
    process.argv = ["node", "set-policy", "--max-total-isolated-margin-usd=8.00", "--confirm"];
    const { cli } = await loadCli();
    await cli.setPolicy();

    const after = await policySnapshot();
    expect(after).toEqual({
      ...before,
      maxTotalIsolatedMarginUsd: "8",
      version: before.version + 1,
    });
    // Capacity, kill switch and the allowlist are untouched by construction.
    expect(after.maxTotalActiveTrades).toBe(1);
    expect(after.maxOpenPositions).toBe(1);
    expect(after.maxPendingEntries).toBe(1);
    expect(after.maxActivePerSymbolSide).toBe(1);
    expect(after.maxTotalPlannedRiskUsd).toBe("1.5");
    expect(after.killSwitchActive).toBe(true);
    expect(after.allowedSymbols).toEqual([]);
  });

  it("refuses a STALE version rather than overwriting another operator", async () => {
    const before = await policySnapshot();
    const { cli, service } = await loadCli();
    // Simulate a concurrent change: the CLI reads a version that is no longer
    // the row's. The service's conditional update must match zero rows.
    vi.spyOn(service.SafetyPolicyService.prototype, "getByProfileId").mockImplementation(async () => {
      const row = await prisma!.executionSafetyPolicy.findUniqueOrThrow({
        where: { executionProfileId: profileId },
      });
      return { ...row, version: row.version + 7 };
    });

    process.argv = ["node", "set-policy", "--max-total-isolated-margin-usd=8.00", "--confirm"];
    await cli.setPolicy();

    expect(output()).toContain("NOT APPLIED");
    expect(output()).toMatch(/changed since it was read|stale/i);
    expect(process.exitCode).toBe(1);
    // The row is exactly as it was — no partial write, no version bump.
    expect(await policySnapshot()).toEqual(before);
  });

  it("rejects a malformed value even with --confirm", async () => {
    const before = await policySnapshot();
    process.argv = ["node", "set-policy", "--max-total-isolated-margin-usd=-8", "--confirm"];
    const { cli } = await loadCli();
    await cli.setPolicy();

    expect(output()).toContain("NOT APPLIED");
    expect(process.exitCode).toBe(1);
    expect(await policySnapshot()).toEqual(before);
  });

  it("can also move the planned-risk cap, the only other supported field", async () => {
    const before = await policySnapshot();
    process.argv = ["node", "set-policy", "--max-total-planned-risk-usd=1.50", "--confirm"];
    const { cli } = await loadCli();
    await cli.setPolicy();

    const after = await policySnapshot();
    expect(after.maxTotalPlannedRiskUsd).toBe("1.5");
    expect(after.maxTotalIsolatedMarginUsd).toBe(before.maxTotalIsolatedMarginUsd);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed profile resolution
// ---------------------------------------------------------------------------

describeDb("execution:set-policy — profile resolution", () => {
  it("fails closed when no profile matches, and creates nothing", async () => {
    const profilesBefore = await prisma!.executionProfile.count();
    process.argv = ["node", "set-policy", "--max-total-isolated-margin-usd=8.00", "--confirm"];
    const { cli } = await loadCli({ EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: `absent-${randomBytes(4).toString("hex")}` });
    await cli.setPolicy();

    expect(output()).toContain("Profile could not be resolved");
    expect(process.exitCode).toBe(1);
    expect(await prisma!.executionProfile.count()).toBe(profilesBefore);
  });

  it("fails closed when the profile identity is not configured", async () => {
    process.argv = ["node", "set-policy", "--max-total-isolated-margin-usd=8.00", "--confirm"];
    const { cli } = await loadCli({ EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "" });
    await cli.setPolicy();

    expect(output()).toContain("PROFILE_NOT_CONFIGURED");
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Blast radius
// ---------------------------------------------------------------------------

describe("execution:set-policy — blast radius", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/modules/execution/run-set-policy.ts"),
    "utf8"
  );
  /** Comments describe the guarantees; only executable code can break them. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("touches no Binance module and issues no HTTP request", () => {
    for (const forbidden of ["fetch(", "axios", "https://", "BinanceReadOnlyService", "BinanceAccountConnection"]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    // The real guarantee: its imports are execution-module and config only, so
    // no Binance client can be constructed even indirectly.
    const imports = [...source.matchAll(/^import .*? from "(.+?)";$/gm)].map((match) => match[1]);
    expect(imports.sort()).toEqual([
      "../../config/env",
      "./canary-readiness",
      "./execution-profile.service",
      "./execution.service",
      "./safety-policy.service",
      "@prisma/client",
    ]);
  });

  it("performs NO direct Prisma mutation — every write goes through the service", () => {
    // The only Prisma use is constructing the client the service is given.
    for (const forbidden of [
      "executionSafetyPolicy.update",
      "executionSafetyPolicy.updateMany",
      "executionSafetyPolicy.create",
      "executionSafetyPolicy.upsert",
      "executionSafetyPolicy.delete",
      "$executeRaw",
      "$queryRaw",
      "$transaction",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    expect(code).toContain("policies.updateForProfile(profile.id, current.version, requested)");
  });

  it("exposes ONLY the two monetary fields, and no escape hatch", () => {
    expect(code).toContain("max-total-isolated-margin-usd");
    expect(code).toContain("max-total-planned-risk-usd");
    // Exactly two supported flags — capacity, the kill switch and the
    // allowlist are deliberately not reachable from this command.
    const flags = [...code.matchAll(/flag: "([a-z-]+)"/g)].map((match) => match[1]);
    expect(flags.sort()).toEqual(["max-total-isolated-margin-usd", "max-total-planned-risk-usd"]);
    const fields = [...code.matchAll(/field: "([A-Za-z]+)"/g)].map((match) => match[1]);
    expect(fields.sort()).toEqual(["maxTotalIsolatedMarginUsd", "maxTotalPlannedRiskUsd"]);
    // The update payload is built ONLY from that list, so nothing else can
    // reach the service. (killSwitchActive is displayed for context, never set.)
    expect(code).toContain("requested[supported.field] = raw");
    for (const forbidden of ["allowedSymbols", "maxAlertAgeSeconds", "requested.killSwitchActive"]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    // No bypass of the confirmation or the version check.
    for (const forbidden of ["--force", "--skip", "--ignore", "--yes"]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("is registered as a package script", () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.scripts["execution:set-policy"]).toBe("tsx src/modules/execution/run-set-policy-cli.ts");
  });
});

// ---------------------------------------------------------------------------
// The real profile
// ---------------------------------------------------------------------------

describeDb("the real canary profile", () => {
  it("is structurally out of this suite's reach", async () => {
    expect(testDatabaseName.endsWith("_test")).toBe(true);
    expect(await prisma!.executionProfile.count({ where: { accountIdentifier: REAL_IDENTIFIER } })).toBe(0);
  });
});
