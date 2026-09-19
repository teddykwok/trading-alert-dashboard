import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase, databaseNameOf } from "./helpers/test-database";

/**
 * Phase 11B.0 — the four operator commands, run for real against Postgres.
 *
 * Safety of this suite rests on two things:
 *
 *  1. `EXECUTION_PROFILE_ACCOUNT_IDENTIFIER` is overridden to a unique
 *     per-run value BEFORE any module reads config, so every command resolves
 *     a throwaway profile. The real `mainnet-canary-usdm` profile is never the
 *     one under test, and a final assertion proves it was left untouched.
 *  2. `CanaryPreflightService` is replaced, so nothing here can reach Binance —
 *     not even the read-only signed GETs the real preflight makes.
 *
 * Environment gates are frozen at import in `config/env`, so each scenario
 * resets the module registry and re-imports the commands with the gate values
 * that scenario needs. That is exactly how the real thing behaves: gates only
 * change on restart.
 */

const REAL_IDENTIFIER = "mainnet-canary-usdm";
const TEST_IDENTIFIER = `phase11b-controls-${randomBytes(6).toString("hex")}`;

// Integration state lives in the DEDICATED test database. The helper refuses
// to fall back to the runtime/canary database, so a misconfiguration fails the
// suite instead of quietly writing synthetic executions into runtime state.
const { prisma: testDatabase, available, name: testDatabaseName } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

// The commands under test construct their OWN PrismaClient with no datasource
// override, so they follow DATABASE_URL — which tests/setup.ts has already
// pinned to the test database for the whole process.
if (databaseNameOf(process.env.DATABASE_URL ?? "") !== testDatabaseName) {
  throw new Error("Refusing to run: the CLI under test would not use the test database.");
}

// --- Gate presets ----------------------------------------------------------

/** The posture the system must be in while PREPARING: everything still shut. */
const SAFE_GATES = {
  EXECUTION_GLOBAL_KILL_SWITCH: "true",
  EXECUTION_LIVE_ENTRY_ENABLED: "false",
  EXECUTION_PROTECTION_READY: "false",
  BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED: "false",
  BINANCE_TEST_ORDER_ENABLED: "false",
  EXECUTION_AUTO_ADD_MARGIN_ENABLED: "false",
  EXECUTION_EMERGENCY_CLOSE_MODE: "DISABLED",
};

/** The posture the operator must have reached in `.env` before ARMING. */
const ARMED_GATES = {
  ...SAFE_GATES,
  EXECUTION_GLOBAL_KILL_SWITCH: "false",
  EXECUTION_LIVE_ENTRY_ENABLED: "true",
  EXECUTION_PROTECTION_READY: "true",
};

/** What the (mocked) preflight reports. Mutated per scenario. */
let preflightBlockers: Array<{ code: string; detail: string }> = [];
let preflightCounts = { positions: 0, orders: 0, active: 0, recovery: 0 };

/**
 * Symbol validation is stubbed here so this suite reaches no network at all.
 * The validator's own behaviour — including that it only ever sends GET — is
 * proven against a real client with a faked transport in
 * `canary-symbol-validation.test.ts`.
 */
let symbolValidation: { ok: boolean; symbol?: string; reasonCode?: string; message?: string } = {
  ok: true,
  symbol: "BTCUSDT",
};
let symbolValidationCalls: string[] = [];

/**
 * Vitest reuses a worker across files, so every variable this suite overrides
 * is snapshotted and put back afterwards — a leaked profile identity would
 * silently retarget a later suite.
 */
const OVERRIDDEN = [
  "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER",
  "EXECUTION_PROFILE_ENVIRONMENT",
  "BINANCE_API_KEY",
  "BINANCE_API_SECRET",
  ...Object.keys(ARMED_GATES),
];
const originalEnv = new Map(OVERRIDDEN.map((key) => [key, process.env[key]]));

/**
 * SYNTHETIC credentials, because `prepareCanary` composes a signed client.
 *
 * Composition fails closed when `BINANCE_API_KEY` or `BINANCE_API_SECRET` is
 * missing, which is correct and must stay that way; the test environment
 * configures neither. These two values exist only so the composition step
 * completes -- symbol validation is stubbed above, so nothing in this suite
 * reaches the network and these bytes never leave the process.
 *
 * They are snapshotted and restored with every other overridden variable.
 */
const SYNTHETIC_API_KEY = "canary-controls-test-api-key";
const SYNTHETIC_API_SECRET = "canary-controls-test-api-secret";

async function loadControls(gates: Record<string, string>) {
  vi.resetModules();
  process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = TEST_IDENTIFIER;
  process.env.EXECUTION_PROFILE_ENVIRONMENT = "MAINNET";
  process.env.BINANCE_API_KEY = SYNTHETIC_API_KEY;
  process.env.BINANCE_API_SECRET = SYNTHETIC_API_SECRET;
  Object.assign(process.env, gates);

  // Phase 12.4D-A.1: exact arm now consults runtime attestation, which is a
  // Redis read against processes deliberately not running in tests. PASS by
  // default so these historical exact-arm assertions keep testing what they
  // were written for; the interlock's own BLOCKED behaviour is covered in
  // natural-arm.integration.test.ts.
  vi.doMock("../src/modules/runtime/runtime-attestation", async () => {
    const actual = await vi.importActual<typeof import("../src/modules/runtime/runtime-attestation")>(
      "../src/modules/runtime/runtime-attestation"
    );
    const gates = {
      globalKillSwitch: false,
      liveEntryEnabled: true,
      protectionReady: true,
      accountSetupMutationsEnabled: false,
      testOrderEnabled: false,
      autoAddMarginEnabled: false,
      emergencyCloseMode: "DISABLED",
    };
    return {
      ...actual,
      readRuntimeAttestationStatusOnce: async () => ({
        ok: true,
        reasonCode: null,
        message: null,
        backend: { role: "BACKEND", freshCount: 1, staleCount: 0, gates, instanceId: "b1" },
        worker: { role: "WORKER", freshCount: 1, staleCount: 0, gates, instanceId: "w1" },
      }),
    };
  });

  vi.doMock("../src/modules/execution/canary-preflight.service", () => ({
    REQUIRED_CONSECUTIVE_SIGNED_SUCCESSES: 3,
    CanaryPreflightService: class {
      async run() {
        return {
          preparationBlockers: preflightBlockers,
          gathered: {
            binance: {
              nonZeroPositionCount: preflightCounts.positions,
              openOrderCount: preflightCounts.orders,
            },
            local: {
              activeExecutionCount: preflightCounts.active,
              recoveryRequiredCount: preflightCounts.recovery,
            },
          },
        };
      }
    },
  }));

  vi.doMock("../src/modules/execution/canary-symbol-validation", () => ({
    validateCanarySymbol: async (input: string) => {
      symbolValidationCalls.push(input);
      return symbolValidation.ok
        ? { ok: true, symbol: symbolValidation.symbol ?? input, filters: { stepSize: "0.001" } }
        : {
            ok: false,
            reasonCode: symbolValidation.reasonCode ?? "CANARY_SYMBOL_MALFORMED",
            message: symbolValidation.message ?? "rejected",
          };
    },
  }));

  return import("../src/modules/execution/run-canary-controls");
}

// --- Console capture -------------------------------------------------------

let captured: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn> | null = null;

function output(): string {
  return captured.join("\n");
}

// --- Fixtures --------------------------------------------------------------

const alertIds: string[] = [];
const executionIds: string[] = [];
let profileId = "";

async function resetProfile(options: { isEnabled?: boolean; killSwitchActive?: boolean; allowedSymbols?: string[] } = {}) {
  await prisma!.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
  await prisma!.tradeExecution.deleteMany({ where: { executionProfileId: profileId } });
  await prisma!.executionProfile.update({
    where: { id: profileId },
    data: { isEnabled: options.isEnabled ?? false },
  });
  await prisma!.executionSafetyPolicy.update({
    where: { executionProfileId: profileId },
    data: {
      killSwitchActive: options.killSwitchActive ?? true,
      allowedSymbols: options.allowedSymbols ?? [],
    },
  });
}

async function createOutstandingExecution(status: string): Promise<string> {
  const execution = await prisma!.tradeExecution.create({
    data: {
      executionProfileId: profileId,
      symbol: "BTCUSDT",
      direction: "LONG",
      positionSide: "LONG",
      selectedLookback: 60,
      status: status as never,
      plannedEntryPrice: "100",
      calculatedStopLoss: "95",
      executableStopLoss: "95",
      riskBudgetUsd: "1.5",
      quantityRaw: "0.3",
      plannedQuantity: "0.3",
      quantityStepSize: "0.001",
      actualPlannedLoss: "1.5",
      unusedRiskBudget: "0",
      positionNotional: "30",
      targetIsolatedMargin: "3",
      maximumIsolatedMargin: "6",
      selectedLeverage: 10,
      estimatedInitialMargin: "3",
      liquidationBufferRatio: "2",
    },
  });
  executionIds.push(execution.id);
  return execution.id;
}

if (available) {
  const profile = await prisma!.executionProfile.create({
    data: { name: TEST_IDENTIFIER, accountIdentifier: TEST_IDENTIFIER, environment: "MAINNET" },
  });
  await prisma!.executionSafetyPolicy.create({ data: { executionProfileId: profile.id } });
  profileId = profile.id;
}

beforeEach(() => {
  captured = [];
  preflightBlockers = [];
  preflightCounts = { positions: 0, orders: 0, active: 0, recovery: 0 };
  symbolValidation = { ok: true, symbol: "BTCUSDT" };
  symbolValidationCalls = [];
  process.argv = ["node", "controls"];
  process.exitCode = undefined;
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  logSpy?.mockRestore();
  process.exitCode = undefined;
  vi.doUnmock("../src/modules/execution/canary-preflight.service");
  vi.doUnmock("../src/modules/execution/canary-symbol-validation");
});

afterAll(async () => {
  if (!prisma) return;
  if (available && profileId) {
    await prisma.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.tradeExecution.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionProfile.deleteMany({ where: { id: profileId } });
    await prisma.alert.deleteMany({ where: { id: { in: alertIds } } });
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
// prepare
// ---------------------------------------------------------------------------

describeDb("execution:prepare-canary", () => {
  beforeEach(async () => {
    await resetProfile();
  });

  it("prepares one authorization and narrows allowedSymbols to exactly that symbol", async () => {
    process.argv = ["node", "controls", "--symbol=BTCUSDT", "--direction=LONG"];
    const { prepareCanary } = await loadControls(SAFE_GATES);
    await prepareCanary();

    const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });
    const rows = await prisma!.executionCanaryAuthorization.findMany({ where: { executionProfileId: profileId } });

    expect(output()).toContain("PREPARED.");
    expect(policy.allowedSymbols).toEqual(["BTCUSDT"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ allowedSymbol: "BTCUSDT", allowedDirection: "LONG", consumedAt: null });
  });

  it("never leaves allowedSymbols empty, which would mean allow ALL", async () => {
    process.argv = ["node", "controls", "--symbol=BTCUSDT", "--direction=LONG"];
    const { prepareCanary } = await loadControls(SAFE_GATES);
    await prepareCanary();

    const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });
    expect(policy.allowedSymbols.length).toBe(1);
  });

  it("arms nothing: the profile stays disabled with its kill switch engaged", async () => {
    process.argv = ["node", "controls", "--symbol=BTCUSDT", "--direction=LONG"];
    const { prepareCanary } = await loadControls(SAFE_GATES);
    await prepareCanary();

    const profile = await prisma!.executionProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: { safetyPolicy: true },
    });
    expect(profile.isEnabled).toBe(false);
    expect(profile.safetyPolicy?.killSwitchActive).toBe(true);
  });

  it("shows the authorization exactly once and marks it as one-time", async () => {
    process.argv = ["node", "controls", "--symbol=BTCUSDT", "--direction=LONG"];
    const { prepareCanary } = await loadControls(SAFE_GATES);
    await prepareCanary();

    const row = await prisma!.executionCanaryAuthorization.findFirstOrThrow({ where: { executionProfileId: profileId } });
    expect(output()).toContain("ONE-TIME AUTHORIZATION");
    // The stored hash must never be printed.
    expect(output()).not.toContain(row.tokenHash);
    // Exactly one non-empty token-shaped line.
    const tokenLines = captured.filter((entry) => /^\s{2}[A-Za-z0-9_-]{30,}$/.test(entry));
    expect(tokenLines).toHaveLength(1);
  });

  it("refuses a direction other than LONG or SHORT", async () => {
    process.argv = ["node", "controls", "--symbol=BTCUSDT", "--direction=BOTH"];
    const { prepareCanary } = await loadControls(SAFE_GATES);
    await prepareCanary();

    expect(output()).toContain("Usage:");
    expect(process.exitCode).toBe(1);
    expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(0);
  });

  it("refuses a missing symbol", async () => {
    process.argv = ["node", "controls", "--direction=LONG"];
    const { prepareCanary } = await loadControls(SAFE_GATES);
    await prepareCanary();

    expect(process.exitCode).toBe(1);
    expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(0);
  });

  it("refuses an absurd time-to-live", async () => {
    process.argv = ["node", "controls", "--symbol=BTCUSDT", "--direction=LONG", "--ttl-minutes=600"];
    const { prepareCanary } = await loadControls(SAFE_GATES);
    await prepareCanary();

    expect(output()).toContain("--ttl-minutes must be between 1 and 60.");
    expect(process.exitCode).toBe(1);
  });

  it("refuses to prepare while an activation gate is already open", async () => {
    process.argv = ["node", "controls", "--symbol=BTCUSDT", "--direction=LONG"];
    const { prepareCanary } = await loadControls({ ...SAFE_GATES, EXECUTION_LIVE_ENTRY_ENABLED: "true" });
    await prepareCanary();

    expect(output()).toContain("BLOCKED");
    expect(output()).toContain("environment activation gates are not all still safe");
    expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(0);
  });

  it("refuses to prepare while the profile is already enabled", async () => {
    await resetProfile({ isEnabled: true });
    process.argv = ["node", "controls", "--symbol=BTCUSDT", "--direction=LONG"];
    const { prepareCanary } = await loadControls(SAFE_GATES);
    await prepareCanary();

    expect(output()).toContain("profile is already enabled");
    expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(0);
  });

  it("refuses to prepare while the profile kill switch is disengaged", async () => {
    await resetProfile({ killSwitchActive: false });
    process.argv = ["node", "controls", "--symbol=BTCUSDT", "--direction=LONG"];
    const { prepareCanary } = await loadControls(SAFE_GATES);
    await prepareCanary();

    expect(output()).toContain("profile kill switch is already disengaged");
    expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(0);
  });

  it("validates the symbol before touching the database at all", async () => {
    symbolValidation = { ok: false, reasonCode: "CANARY_SYMBOL_MALFORMED", message: "not a Binance symbol" };
    process.argv = ["node", "controls", "--symbol=<SYMBOL>", "--direction=LONG"];
    const { prepareCanary } = await loadControls(SAFE_GATES);
    await prepareCanary();

    const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });
    expect(output()).toContain("CANARY_SYMBOL_MALFORMED");
    expect(process.exitCode).toBe(1);
    // Neither the allowlist nor the authorization table moved.
    expect(policy.allowedSymbols).toEqual([]);
    expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(0);
  });

  it("reports an unlisted symbol without changing anything", async () => {
    symbolValidation = { ok: false, reasonCode: "CANARY_SYMBOL_NOT_LISTED", message: "FOOBAR is not listed" };
    process.argv = ["node", "controls", "--symbol=FOOBAR", "--direction=LONG"];
    const { prepareCanary } = await loadControls(SAFE_GATES);
    await prepareCanary();

    const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });
    expect(output()).toContain("CANARY_SYMBOL_NOT_LISTED");
    expect(policy.allowedSymbols).toEqual([]);
    expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(0);
  });

  it("uses the validator's normalized symbol for both the allowlist and the authorization", async () => {
    symbolValidation = { ok: true, symbol: "ETHUSDT" };
    process.argv = ["node", "controls", "--symbol=BINANCE:ETHUSDT.P", "--direction=SHORT"];
    const { prepareCanary } = await loadControls(SAFE_GATES);
    await prepareCanary();

    const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });
    const row = await prisma!.executionCanaryAuthorization.findFirstOrThrow({ where: { executionProfileId: profileId } });
    expect(policy.allowedSymbols).toEqual(["ETHUSDT"]);
    expect(row.allowedSymbol).toBe("ETHUSDT");
    expect(symbolValidationCalls).toContain("BINANCE:ETHUSDT.P");
  });

  it("refuses a second preparation while one is active, and changes nothing", async () => {
    process.argv = ["node", "controls", "--symbol=BTCUSDT", "--direction=LONG"];
    const { prepareCanary } = await loadControls(SAFE_GATES);
    await prepareCanary();

    symbolValidation = { ok: true, symbol: "ETHUSDT" };
    process.argv = ["node", "controls", "--symbol=ETHUSDT", "--direction=SHORT"];
    await prepareCanary();

    const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });
    const rows = await prisma!.executionCanaryAuthorization.findMany({ where: { executionProfileId: profileId } });

    expect(output()).toContain("CANARY_AUTHORIZATION_ALREADY_ACTIVE");
    expect(output()).toContain("execution:disarm-canary");
    expect(process.exitCode).toBe(1);
    // The first window survives untouched — never silently replaced.
    expect(rows).toHaveLength(1);
    expect(rows[0].allowedSymbol).toBe("BTCUSDT");
    expect(rows[0].revokedAt).toBeNull();
    expect(policy.allowedSymbols).toEqual(["BTCUSDT"]);
  });

  it("leaves the allowlist unchanged when the authorization insert is refused", async () => {
    process.argv = ["node", "controls", "--symbol=BTCUSDT", "--direction=LONG"];
    const { prepareCanary } = await loadControls(SAFE_GATES);
    await prepareCanary();

    // A second prepare for a different symbol must not half-apply: the
    // allowlist update shares the authorization's transaction.
    symbolValidation = { ok: true, symbol: "ETHUSDT" };
    process.argv = ["node", "controls", "--symbol=ETHUSDT", "--direction=LONG"];
    await prepareCanary();

    const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });
    expect(policy.allowedSymbols).toEqual(["BTCUSDT"]);
  });

  it("propagates preflight blockers instead of overriding them", async () => {
    preflightBlockers = [{ code: "BINANCE_OPEN_ORDERS_PRESENT", detail: "2 open orders" }];
    process.argv = ["node", "controls", "--symbol=BTCUSDT", "--direction=LONG"];
    const { prepareCanary } = await loadControls(SAFE_GATES);
    await prepareCanary();

    expect(output()).toContain("BINANCE_OPEN_ORDERS_PRESENT");
    expect(process.exitCode).toBe(1);
    expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// arm
// ---------------------------------------------------------------------------

describeDb("execution:arm-canary", () => {
  async function prepared(ttlMinutes = 10) {
    await resetProfile({ allowedSymbols: ["BTCUSDT"] });
    const { CanaryAuthorizationService } = await import("../src/modules/execution/canary-authorization.service");
    return new CanaryAuthorizationService(prisma!).prepare({
      executionProfileId: profileId,
      symbol: "BTCUSDT",
      direction: "LONG",
      ttlMinutes,
    });
  }

  it("arms only with the explicit confirmation flag", async () => {
    await prepared();
    process.argv = ["node", "controls", "--confirm-arm"];
    const { armCanary } = await loadControls(ARMED_GATES);
    await armCanary();

    const profile = await prisma!.executionProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: { safetyPolicy: true },
    });
    expect(output()).toContain("ARMED.");
    expect(profile.isEnabled).toBe(true);
    expect(profile.safetyPolicy?.killSwitchActive).toBe(false);
  });

  it("is a dry run without the confirmation flag", async () => {
    await prepared();
    const { armCanary } = await loadControls(ARMED_GATES);
    await armCanary();

    const profile = await prisma!.executionProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: { safetyPolicy: true },
    });
    expect(output()).toContain("DRY RUN");
    expect(profile.isEnabled).toBe(false);
    expect(profile.safetyPolicy?.killSwitchActive).toBe(true);
  });

  it("refuses to arm without a prepared authorization", async () => {
    await resetProfile({ allowedSymbols: ["BTCUSDT"] });
    process.argv = ["node", "controls", "--confirm-arm"];
    const { armCanary } = await loadControls(ARMED_GATES);
    await armCanary();

    const profile = await prisma!.executionProfile.findUniqueOrThrow({ where: { id: profileId } });
    expect(output()).toContain("no active unexpired authorization is prepared");
    expect(profile.isEnabled).toBe(false);
  });

  it("refuses to arm on an authorization about to expire", async () => {
    const { authorization } = await prepared();
    await prisma!.executionCanaryAuthorization.update({
      where: { id: authorization.id },
      data: { expiresAt: new Date(Date.now() + 30_000) },
    });
    process.argv = ["node", "controls", "--confirm-arm"];
    const { armCanary } = await loadControls(ARMED_GATES);
    await armCanary();

    const profile = await prisma!.executionProfile.findUniqueOrThrow({ where: { id: profileId } });
    expect(output()).toContain("too close to expiry");
    expect(profile.isEnabled).toBe(false);
  });

  it("refuses to arm while the environment gates are still shut", async () => {
    await prepared();
    process.argv = ["node", "controls", "--confirm-arm"];
    const { armCanary } = await loadControls(SAFE_GATES);
    await armCanary();

    const profile = await prisma!.executionProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: { safetyPolicy: true },
    });
    expect(output()).toContain("edit .env and restart FIRST");
    expect(profile.isEnabled).toBe(false);
    expect(profile.safetyPolicy?.killSwitchActive).toBe(true);
  });

  it("refuses to arm when the allowlist does not match the authorization exactly", async () => {
    await prepared();
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { allowedSymbols: ["BTCUSDT", "ETHUSDT"] },
    });
    process.argv = ["node", "controls", "--confirm-arm"];
    const { armCanary } = await loadControls(ARMED_GATES);
    await armCanary();

    const profile = await prisma!.executionProfile.findUniqueOrThrow({ where: { id: profileId } });
    expect(output()).toContain("the symbol allowlist does not match the authorization exactly");
    expect(profile.isEnabled).toBe(false);
  });

  it("refuses to arm with zero active authorizations, even when records exist", async () => {
    await prepared();
    // Revoked: a record on file, but no window.
    await prisma!.executionCanaryAuthorization.updateMany({
      where: { executionProfileId: profileId },
      data: { revokedAt: new Date() },
    });
    process.argv = ["node", "controls", "--confirm-arm"];
    const { armCanary } = await loadControls(ARMED_GATES);
    await armCanary();

    const profile = await prisma!.executionProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: { safetyPolicy: true },
    });
    expect(output()).toContain("no active unexpired authorization is prepared");
    expect(profile.isEnabled).toBe(false);
    expect(profile.safetyPolicy?.killSwitchActive).toBe(true);
  });

  it("refuses to arm with more than one active authorization", async () => {
    const { authorization } = await prepared();
    // Bypass the exclusivity guard directly to prove arm re-checks it itself
    // rather than trusting prepare to have behaved.
    await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        allowedSymbol: authorization.allowedSymbol,
        allowedDirection: authorization.allowedDirection,
        tokenHash: `second-${Date.now()}`,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });

    process.argv = ["node", "controls", "--confirm-arm"];
    const { armCanary } = await loadControls(ARMED_GATES);
    await armCanary();

    const profile = await prisma!.executionProfile.findUniqueOrThrow({ where: { id: profileId } });
    expect(output()).toContain("2 authorizations are active; exactly one is required");
    expect(output()).toContain("BLOCKED — nothing was changed:");
    expect(profile.isEnabled).toBe(false);
  });

  it("reports the active authorization count in its preconditions", async () => {
    await prepared();
    const { armCanary } = await loadControls(ARMED_GATES);
    await armCanary();

    expect(output()).toMatch(/active authorization count\s+1/);
  });

  it("refuses to arm on a preflight blocker, with no way to override it", async () => {
    await prepared();
    preflightBlockers = [{ code: "BINANCE_POSITION_OPEN", detail: "1 non-zero position" }];
    process.argv = ["node", "controls", "--confirm-arm", "--force", "--ignore-preflight"];
    const { armCanary } = await loadControls(ARMED_GATES);
    await armCanary();

    const profile = await prisma!.executionProfile.findUniqueOrThrow({ where: { id: profileId } });
    expect(output()).toContain("BINANCE_POSITION_OPEN");
    expect(output()).toContain("BLOCKED — nothing was changed:");
    expect(profile.isEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// close window
// ---------------------------------------------------------------------------

describeDb("execution:close-canary-window", () => {
  beforeEach(async () => {
    await resetProfile({ isEnabled: true, killSwitchActive: false, allowedSymbols: ["BTCUSDT"] });
  });

  it("engages the profile kill switch with no confirmation flag", async () => {
    const { closeCanaryWindow } = await loadControls(ARMED_GATES);
    await closeCanaryWindow();

    const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });
    expect(policy.killSwitchActive).toBe(true);
    expect(output()).toContain("CLOSED");
  });

  it("leaves an in-flight execution completely untouched", async () => {
    const executionId = await createOutstandingExecution("ENTRY_PENDING");
    const before = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });

    const { closeCanaryWindow } = await loadControls(ARMED_GATES);
    await closeCanaryWindow();

    const after = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);
    expect(output()).toContain("It was NOT cancelled and NOT closed.");
  });

  it("does not disable the profile, so recovery can continue", async () => {
    await createOutstandingExecution("PROTECTED");
    const { closeCanaryWindow } = await loadControls(ARMED_GATES);
    await closeCanaryWindow();

    const profile = await prisma!.executionProfile.findUniqueOrThrow({ where: { id: profileId } });
    expect(profile.isEnabled).toBe(true);
  });

  it("reports a clean close when nothing is outstanding", async () => {
    const { closeCanaryWindow } = await loadControls(ARMED_GATES);
    await closeCanaryWindow();

    expect(output()).toContain("No live execution remains.");
  });

  it("does not revoke a consumed authorization's binding", async () => {
    const { CanaryAuthorizationService } = await import("../src/modules/execution/canary-authorization.service");
    const service = new CanaryAuthorizationService(prisma!);
    const { token } = await service.prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" });
    const alert = await prisma!.alert.create({
      data: {
        symbol: "BTCUSDT", assetType: "CRYPTO", timeframe: "15m", price: 100, signal: "LONG",
        rawPayload: {}, triggeredAt: new Date(),
      },
    });
    alertIds.push(alert.id);
    await service.consume({
      token, executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG", alertId: alert.id,
    });

    const { closeCanaryWindow } = await loadControls(ARMED_GATES);
    await closeCanaryWindow();

    const row = await prisma!.executionCanaryAuthorization.findFirstOrThrow({ where: { executionProfileId: profileId } });
    expect(row.consumedAlertId).toBe(alert.id);
    expect(row.revokedAt).toBeNull();
  });

  it("is idempotent", async () => {
    const { closeCanaryWindow } = await loadControls(ARMED_GATES);
    await closeCanaryWindow();
    await closeCanaryWindow();

    const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });
    expect(policy.killSwitchActive).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// disarm
// ---------------------------------------------------------------------------

describeDb("execution:disarm-canary", () => {
  beforeEach(async () => {
    await resetProfile({ isEnabled: true, killSwitchActive: false, allowedSymbols: ["BTCUSDT"] });
  });

  it("returns a clean profile to fully disabled and killed", async () => {
    const { disarmCanary } = await loadControls(ARMED_GATES);
    await disarmCanary();

    const profile = await prisma!.executionProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: { safetyPolicy: true },
    });
    expect(output()).toContain("CANARY_DISARMED_CLEAN");
    expect(profile.isEnabled).toBe(false);
    expect(profile.safetyPolicy?.killSwitchActive).toBe(true);
  });

  it("revokes an unused authorization", async () => {
    const { CanaryAuthorizationService } = await import("../src/modules/execution/canary-authorization.service");
    await new CanaryAuthorizationService(prisma!).prepare({
      executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG",
    });

    const { disarmCanary } = await loadControls(ARMED_GATES);
    await disarmCanary();

    const row = await prisma!.executionCanaryAuthorization.findFirstOrThrow({ where: { executionProfileId: profileId } });
    expect(row.revokedAt).not.toBeNull();
    expect(output()).toContain("authorizations revoked");
  });

  it("blocks new work but keeps the profile alive while exposure exists", async () => {
    await createOutstandingExecution("PROTECTED");
    const { disarmCanary } = await loadControls(ARMED_GATES);
    await disarmCanary();

    const profile = await prisma!.executionProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: { safetyPolicy: true },
    });
    expect(output()).toContain("CANARY_DISARMED_NEW_WORK_BLOCKED_RECOVERY_CONTINUES");
    // New admission is impossible...
    expect(profile.safetyPolicy?.killSwitchActive).toBe(true);
    // ...but reconciliation and protection still have a profile to work with.
    expect(profile.isEnabled).toBe(true);
  });

  it("treats a manual-intervention execution as outstanding exposure", async () => {
    const executionId = await createOutstandingExecution("PLAN_READY");
    await prisma!.tradeExecution.update({ where: { id: executionId }, data: { requiresManualIntervention: true } });

    const { disarmCanary } = await loadControls(ARMED_GATES);
    await disarmCanary();

    expect(output()).toContain("CANARY_DISARMED_NEW_WORK_BLOCKED_RECOVERY_CONTINUES");
  });

  it("never widens the symbol allowlist back to allow-all", async () => {
    const { disarmCanary } = await loadControls(ARMED_GATES);
    await disarmCanary();

    const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });
    expect(policy.allowedSymbols).toEqual(["BTCUSDT"]);
  });

  it("cancels nothing and closes nothing", async () => {
    const executionId = await createOutstandingExecution("ENTRY_FILLED");
    const before = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });

    const { disarmCanary } = await loadControls(ARMED_GATES);
    await disarmCanary();

    const after = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);
    expect(output()).toContain("nothing was cancelled");
  });

  it("is idempotent", async () => {
    const { disarmCanary } = await loadControls(ARMED_GATES);
    await disarmCanary();
    await disarmCanary();

    const profile = await prisma!.executionProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: { safetyPolicy: true },
    });
    expect(profile.isEnabled).toBe(false);
    expect(profile.safetyPolicy?.killSwitchActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The real profile
// ---------------------------------------------------------------------------

describeDb("the real canary profile", () => {
  it("is structurally out of this suite's reach", async () => {
    // Stronger than asserting the real profile is still safe: it proves the
    // suite runs somewhere the real profile does not exist at all, so no
    // command it invokes could have resolved it even by mistake.
    expect(testDatabaseName.endsWith("_test")).toBe(true);
    expect(await prisma!.executionProfile.count({ where: { accountIdentifier: REAL_IDENTIFIER } })).toBe(0);
  });

  it("touched exactly one profile, its own", async () => {
    const profiles = await prisma!.executionProfile.findMany({ select: { id: true, accountIdentifier: true } });
    const foreign = profiles.filter((row) => row.id !== profileId && !row.accountIdentifier.startsWith("phase11"));
    expect(foreign).toEqual([]);
  });
});
