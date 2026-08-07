import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * Phase 11A.1 profile bootstrap tests against a real Postgres.
 *
 * Bootstrap grants CAPACITY, never PERMISSION: the assertions below are mostly
 * about what stays off. No Binance endpoint is contacted anywhere in this file.
 */

const TAG = "phase11-bootstrap";
const BACKEND = process.cwd();

// Integration state lives in the DEDICATED test database. The helper refuses
// to fall back to the runtime/canary database, so a misconfiguration fails the
// suite instead of quietly writing synthetic executions into runtime state.
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ensureExecutionProfile, resolveExecutionProfile } = await import(
  "../src/modules/execution/execution-profile.service"
);

const identity = { accountIdentifier: `${TAG}-alias`, environment: "TESTNET" as const };
const createdProfileIds: string[] = [];

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: { in: createdProfileIds } } });
    await prisma.executionProfile.deleteMany({ where: { id: { in: createdProfileIds } } });
  }
  await prisma.$disconnect();
});

const describeDb = available ? describe : describe.skip;

describeDb("profile bootstrap", () => {
  it("creates the profile and its policy when absent", async () => {
    const result = await ensureExecutionProfile(prisma!, identity);
    createdProfileIds.push(result.profileId);

    expect(result.created).toBe(true);
    expect(result.profileId).toBeTruthy();
  });

  it("is idempotent — a second run changes nothing", async () => {
    const first = await ensureExecutionProfile(prisma!, identity);
    const second = await ensureExecutionProfile(prisma!, identity);
    createdProfileIds.push(first.profileId);

    expect(second.created).toBe(false);
    expect(second.profileId).toBe(first.profileId);
    expect(await prisma!.executionProfile.count({ where: { accountIdentifier: identity.accountIdentifier } })).toBe(1);
    expect(await prisma!.executionSafetyPolicy.count({ where: { executionProfileId: first.profileId } })).toBe(1);
  });

  it("engages the kill switch and leaves the profile disabled", async () => {
    const result = await ensureExecutionProfile(prisma!, identity);
    createdProfileIds.push(result.profileId);

    // Capacity, not permission.
    expect(result.killSwitchActive).toBe(true);
    expect(result.isEnabled).toBe(false);
  });

  it("applies exactly the Phase 11 canary capacity", async () => {
    const result = await ensureExecutionProfile(prisma!, identity);
    createdProfileIds.push(result.profileId);

    expect(result.policy.maxOpenPositions).toBe(1);
    expect(result.policy.maxPendingEntries).toBe(1);
    expect(result.policy.maxTotalActiveTrades).toBe(1);
    expect(result.policy.maxTotalPlannedRiskUsd).toBe("1.5");
    expect(result.policy.maxTotalIsolatedMarginUsd).toBe("5");
  });

  it("resolves the configured profile once it exists", async () => {
    const created = await ensureExecutionProfile(prisma!, identity);
    createdProfileIds.push(created.profileId);

    const resolution = await resolveExecutionProfile(prisma!, identity);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.profile.id).toBe(created.profileId);
      expect(resolution.profile.safetyPolicy?.killSwitchActive).toBe(true);
    }
  });

  it("fails closed when no identity is configured", async () => {
    const resolution = await resolveExecutionProfile(prisma!, { accountIdentifier: "", environment: "TESTNET" });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.reasonCode).toBe("PROFILE_NOT_CONFIGURED");
  });

  it("fails closed when the configured profile does not exist", async () => {
    const resolution = await resolveExecutionProfile(prisma!, {
      accountIdentifier: `${TAG}-missing`,
      environment: "TESTNET",
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.reasonCode).toBe("PROFILE_NOT_FOUND");
  });

  it("stores no credential on the profile row", async () => {
    const created = await ensureExecutionProfile(prisma!, identity);
    createdProfileIds.push(created.profileId);

    const row = await prisma!.executionProfile.findUniqueOrThrow({ where: { id: created.profileId } });
    const serialized = JSON.stringify(row);
    for (const forbidden of ["apiKey", "apiSecret", "secret", "token", "password"]) {
      expect(`${forbidden}:${serialized.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("creates no TradeExecution", async () => {
    const before = await prisma!.tradeExecution.count();
    const created = await ensureExecutionProfile(prisma!, identity);
    createdProfileIds.push(created.profileId);
    expect(await prisma!.tradeExecution.count()).toBe(before);
  });
});

describe("bootstrap boundary", () => {
  const SERVICE = path.join(BACKEND, "src", "modules", "execution", "execution-profile.service.ts");
  const CLI = path.join(BACKEND, "src", "modules", "execution", "run-ensure-profile.ts");

  const readCode = (file: string) =>
    readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("contacts no Binance endpoint", () => {
    for (const file of [SERVICE, CLI]) {
      const source = readCode(file);
      // "Binance USDⓈ-M" appears as a human-readable PROFILE NAME; what must
      // be absent is any endpoint, client or request.
      for (const forbidden of ["fapi/", "fetch(", "binance-", "BinanceReadOnly", "BinanceUsdM"]) {
        expect(`${path.basename(file)}:${forbidden}:${source.includes(forbidden)}`).toBe(
          `${path.basename(file)}:${forbidden}:false`
        );
      }
    }
  });

  it("enables no gate and disengages no kill switch", () => {
    for (const file of [SERVICE, CLI]) {
      const source = readCode(file);
      for (const forbidden of [
        "killSwitchActive: false",
        "isEnabled: true",
        "EXECUTION_LIVE_ENTRY_ENABLED",
        "EXECUTION_PROTECTION_READY",
        "EXECUTION_GLOBAL_KILL_SWITCH",
      ]) {
        expect(`${path.basename(file)}:${forbidden}:${source.includes(forbidden)}`).toBe(
          `${path.basename(file)}:${forbidden}:false`
        );
      }
    }
  });

  it("relies on schema defaults rather than restating the limits", () => {
    const source = readCode(SERVICE);
    // The create call passes only the foreign key; every limit and both
    // switches come from the schema, so they cannot drift.
    expect(source).toContain("data: { executionProfileId: profile.id }");
    // The create payload itself carries no limit. The result object legitimately
    // reads them back for display, so only the write is inspected.
    const createCall = /executionSafetyPolicy\.create\(\{[\s\S]*?\}\)/.exec(source)?.[0] ?? "";
    expect(createCall).not.toBe("");
    for (const limit of ["maxOpenPositions", "maxTotalPlannedRiskUsd", "killSwitchActive"]) {
      expect(`${limit}:${createCall.includes(limit)}`).toBe(`${limit}:false`);
    }
  });

  it("is reachable only through an operator CLI, never HTTP", () => {
    const app = readFileSync(path.join(BACKEND, "src", "app.ts"), "utf8");
    expect(app).not.toContain("ensureExecutionProfile");
    const scripts = JSON.parse(readFileSync(path.join(BACKEND, "package.json"), "utf8")).scripts as Record<string, string>;
    expect(scripts["execution:ensure-profile"]).toContain("run-ensure-profile.ts");
  });
});
