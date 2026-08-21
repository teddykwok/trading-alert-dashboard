import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase, databaseNameOf } from "./helpers/test-database";

/**
 * Phase 12.4C — `execution:arm-natural-window`, run for real against Postgres.
 *
 * This is the command that opens a profile for natural admission, so the suite
 * is built around one question: can anything here arm a profile that should not
 * be armed? Every refusal test asserts the profile is STILL disabled and the
 * kill switch STILL engaged afterwards, because a command that refuses loudly
 * but half-mutates is worse than one that never ran.
 *
 * Safety rests on the same footing as the Phase-11B/12.4A control suites: the
 * profile identity is overridden BEFORE any module reads config, and
 * `CanaryPreflightService` is replaced so nothing can reach Binance.
 */

const REAL_IDENTIFIER = "mainnet-canary-usdm";
const TEST_IDENTIFIER = `phase12c-arm-${randomBytes(6).toString("hex")}`;

const { prisma: testDatabase, available, name: testDatabaseName } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

if (databaseNameOf(process.env.DATABASE_URL ?? "") !== testDatabaseName) {
  throw new Error("Refusing to run: the CLI under test would not use the test database.");
}

/** The posture arming REQUIRES: env gates already open, mutation flags still shut. */
const ARMED_GATES = {
  EXECUTION_GLOBAL_KILL_SWITCH: "false",
  EXECUTION_LIVE_ENTRY_ENABLED: "true",
  EXECUTION_PROTECTION_READY: "true",
  BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED: "false",
  BINANCE_TEST_ORDER_ENABLED: "false",
  EXECUTION_AUTO_ADD_MARGIN_ENABLED: "false",
  EXECUTION_EMERGENCY_CLOSE_MODE: "DISABLED",
};

const OVERRIDDEN = ["EXECUTION_PROFILE_ACCOUNT_IDENTIFIER", "EXECUTION_PROFILE_ENVIRONMENT", ...Object.keys(ARMED_GATES)];
const originalEnv = new Map(OVERRIDDEN.map((key) => [key, process.env[key]]));
const originalArgv = process.argv;

/** The reviewed envelope. Arming refuses anything else. */
const REVIEWED_POLICY = {
  maxOpenPositions: 5,
  maxPendingEntries: 5,
  maxTotalActiveTrades: 5,
  maxActivePerSymbolSide: 1,
  softOpenPositionTarget: 3,
  maxTotalPlannedRiskUsd: "7.50",
  maxTotalIsolatedMarginUsd: "40.00",
};

let preflightFindings: { preparation: Array<{ code: string; detail: string }>; live: Array<{ code: string; detail: string }> } = {
  preparation: [],
  live: [],
};

/**
 * Phase 12.4D-A.1. Arm now consults runtime attestation, which is a Redis read
 * against processes that are deliberately NOT running in tests. Default PASS so
 * every pre-existing assertion still exercises what it was written for; the
 * interlock's own BLOCKED behaviour is driven explicitly below.
 */
const LIVE_GATES = {
  globalKillSwitch: false,
  liveEntryEnabled: true,
  protectionReady: true,
  accountSetupMutationsEnabled: false,
  testOrderEnabled: false,
  autoAddMarginEnabled: false,
  emergencyCloseMode: "DISABLED",
};
let attestationResult: {
  ok: boolean;
  reasonCode: string | null;
  message: string | null;
  backend: { role: string; freshCount: number; staleCount: number; gates: typeof LIVE_GATES | null; instanceId: string | null };
  worker: { role: string; freshCount: number; staleCount: number; gates: typeof LIVE_GATES | null; instanceId: string | null };
};
const passingAttestation = () => ({
  ok: true,
  reasonCode: null,
  message: null,
  backend: { role: "BACKEND", freshCount: 1, staleCount: 0, gates: LIVE_GATES, instanceId: "b1" },
  worker: { role: "WORKER", freshCount: 1, staleCount: 0, gates: LIVE_GATES, instanceId: "w1" },
});
attestationResult = passingAttestation();

async function loadControls(gates: Record<string, string> = ARMED_GATES) {
  vi.resetModules();
  process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = TEST_IDENTIFIER;
  process.env.EXECUTION_PROFILE_ENVIRONMENT = "MAINNET";
  Object.assign(process.env, gates);

  vi.doMock("../src/modules/runtime/runtime-attestation", async () => {
    const actual = await vi.importActual<typeof import("../src/modules/runtime/runtime-attestation")>(
      "../src/modules/runtime/runtime-attestation"
    );
    return {
      ...actual,
      // Only the one-shot CLI reader is replaced; nothing else is stubbed, so
      // the module's real key/schema/gate logic is still the thing under test
      // in runtime-attestation.test.ts.
      readRuntimeAttestationStatusOnce: async () => attestationResult,
    };
  });

  vi.doMock("../src/modules/execution/canary-preflight.service", () => ({
    REQUIRED_CONSECUTIVE_SIGNED_SUCCESSES: 3,
    CanaryPreflightService: class {
      async run() {
        return {
          preparationBlockers: preflightFindings.preparation,
          liveActivationBlockers: preflightFindings.live,
          gathered: {
            binance: { nonZeroPositionCount: 0, openOrderCount: 0 },
            local: { activeExecutionCount: 0, recoveryRequiredCount: 0 },
          },
        };
      }
    },
  }));

  return import("../src/modules/execution/run-canary-controls");
}

let captured: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn> | null = null;
const output = () => captured.join("\n");

let profileId = "";
let otherProfileId = "";

const argv = (...args: string[]) => {
  process.argv = ["node", "cli", ...args];
};

/** Everything arming must never touch, captured for exact comparison. */
async function untouchable() {
  const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });
  const windows = await prisma!.executionCanaryAuthorization.findMany({
    where: { executionProfileId: profileId },
    orderBy: { createdAt: "asc" },
  });
  return { policy, windows };
}

async function profileState() {
  const profile = await prisma!.executionProfile.findUniqueOrThrow({
    where: { id: profileId },
    include: { safetyPolicy: true },
  });
  return { isEnabled: profile.isEnabled, killSwitchActive: profile.safetyPolicy!.killSwitchActive };
}

/** The safe posture every test starts from: disabled profile, engaged kill switch. */
async function resetProfile(): Promise<void> {
  await prisma!.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
  await prisma!.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: otherProfileId } });
  await prisma!.executionSafetyPolicy.updateMany({
    where: { executionProfileId: profileId },
    data: { killSwitchActive: true, allowedSymbols: ["COWUSDT"], version: 3, ...REVIEWED_POLICY },
  });
  await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled: false } });
  preflightFindings = { preparation: [], live: [] };
}

interface WindowOptions {
  ttlMinutes?: number;
  maxClaims?: number;
  claimedCount?: number;
  directions?: Array<"LONG" | "SHORT">;
  revoked?: boolean;
  profile?: string;
  type?: "NATURAL_WINDOW" | "EXACT_SIGNAL";
}

async function makeWindow(options: WindowOptions = {}) {
  const ttl = options.ttlMinutes ?? 30;
  const exact = options.type === "EXACT_SIGNAL";
  return prisma!.executionCanaryAuthorization.create({
    data: {
      executionProfileId: options.profile ?? profileId,
      authorizationType: options.type ?? "NATURAL_WINDOW",
      allowedDirections: exact ? [] : options.directions ?? ["LONG", "SHORT"],
      maxClaims: exact ? null : options.maxClaims ?? 5,
      claimedCount: options.claimedCount ?? 0,
      expiresAt: new Date(Date.now() + ttl * 60_000),
      revokedAt: options.revoked ? new Date() : null,
      ...(exact
        ? {
            allowedSymbol: "COWUSDT",
            allowedDirection: "LONG" as const,
            tokenHash: `arm-test-${randomBytes(8).toString("hex")}`,
          }
        : {}),
    },
  });
}

beforeEach(async () => {
  captured = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  });
  process.exitCode = undefined;
  if (available && profileId === "") {
    const profile = await prisma!.executionProfile.create({
      data: { name: TEST_IDENTIFIER, accountIdentifier: TEST_IDENTIFIER, environment: "MAINNET", isEnabled: false },
    });
    profileId = profile.id;
    await prisma!.executionSafetyPolicy.create({
      data: { executionProfileId: profileId, killSwitchActive: true, allowedSymbols: ["COWUSDT"], version: 3, ...REVIEWED_POLICY },
    });
    const other = await prisma!.executionProfile.create({
      data: {
        name: `${TEST_IDENTIFIER}-other`,
        accountIdentifier: `${TEST_IDENTIFIER}-other`,
        environment: "MAINNET",
        isEnabled: false,
      },
    });
    otherProfileId = other.id;
    await prisma!.executionSafetyPolicy.create({
      data: { executionProfileId: otherProfileId, killSwitchActive: true, allowedSymbols: ["COWUSDT"] },
    });
  }
  if (available) await resetProfile();
  attestationResult = passingAttestation();
});

afterEach(() => {
  logSpy?.mockRestore();
  process.argv = originalArgv;
  process.exitCode = undefined;
});

afterAll(async () => {
  if (!prisma) return;
  if (available && profileId !== "") {
    for (const id of [profileId, otherProfileId]) {
      await prisma.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: id } });
      await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: id } });
      await prisma.executionProfile.deleteMany({ where: { id } });
    }
  }
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.argv = originalArgv;
  await prisma.$disconnect();
});

const describeDb = available ? describe : describe.skip;

/** The same key production uses, imported so the test cannot drift from it. */
import { profileLockKey as profileLockKeyFor } from "../src/modules/execution/profile-lock";

const CONFIRM_ARM_FLAG = "--confirm-arm";

/** An active, unconsumed EXACT_SIGNAL authorization matching the allowlist. */
async function makeExactWindow() {
  return prisma!.executionCanaryAuthorization.create({
    data: {
      executionProfileId: profileId,
      authorizationType: "EXACT_SIGNAL",
      allowedSymbol: "COWUSDT",
      allowedDirection: "LONG",
      tokenHash: `exact-${randomBytes(8).toString("hex")}`,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    },
  });
}


// ---------------------------------------------------------------------------
// 1. Explicit intent
// ---------------------------------------------------------------------------

describeDb("arm-natural-window: explicit intent", () => {
  it("refuses without an explicit --id and names no window of its own", async () => {
    const before = await profileState();
    argv("--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("--id=<authorization-id>");
    expect(output()).toContain("no fuzzy selection");
    expect(process.exitCode).toBe(1);
    expect(await profileState()).toEqual(before);
  });

  it("refuses an id that does not exist", async () => {
    argv("--id=does-not-exist", "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("WINDOW_NOT_FOUND");
    expect(process.exitCode).toBe(1);
    expect(await profileState()).toEqual({ isEnabled: false, killSwitchActive: true });
  });
});

// ---------------------------------------------------------------------------
// 2. Dry run
// ---------------------------------------------------------------------------

describeDb("arm-natural-window: dry run", () => {
  it("writes nothing and shows exactly what it WOULD change", async () => {
    const window = await makeWindow();
    const before = await untouchable();
    const stateBefore = await profileState();

    argv(`--id=${window.id}`);
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    const text = output();
    expect(text).toContain("DRY RUN");
    expect(text).toContain("NO DATABASE WRITE WAS PERFORMED");
    // MAINNET is named unmistakably before anything could be written.
    expect(text).toContain("MAINNET — REAL FUNDS");
    expect(text).toContain(window.id);
    expect(text).toContain("NATURAL_WINDOW");
    expect(text).toMatch(/state\s+AVAILABLE/);
    expect(text).toMatch(/allowedDirections\s+\[LONG, SHORT\]/);
    expect(text).toMatch(/maxClaims\s+5/);
    expect(text).toMatch(/claimedCount\s+0/);
    expect(text).toMatch(/remainingClaims\s+5/);
    expect(text).toMatch(/allowedSymbols\s+\[COWUSDT\]/);
    expect(text).toContain("this command never writes allowedSymbols");
    expect(text).toContain("UNCHANGED — arming spends no claim");

    expect(await profileState()).toEqual(stateBefore);
    expect(await untouchable()).toEqual(before);
  });

  it("prints no secret of any kind", async () => {
    const window = await makeWindow();
    argv(`--id=${window.id}`);
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).not.toMatch(/tokenHash|DATABASE_URL|postgres:\/\//);
  });
});

// ---------------------------------------------------------------------------
// 3. Confirmation
// ---------------------------------------------------------------------------

describeDb("arm-natural-window: confirmation", () => {
  it.each(["--confirm", "--confirm-arm=true", "--confirmarm", "--conifrm-arm", "--force", "--yes"])(
    "%s does NOT arm — it falls through to a dry run",
    async (flag) => {
      const window = await makeWindow();
      argv(`--id=${window.id}`, flag);
      const { armNaturalCanary } = await loadControls();
      await armNaturalCanary();

      expect(output()).toContain("DRY RUN");
      expect(await profileState()).toEqual({ isEnabled: false, killSwitchActive: true });
    }
  );

  it("arms only with the exact --confirm-arm token", async () => {
    const window = await makeWindow();
    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("ARMED.");
    expect(await profileState()).toEqual({ isEnabled: true, killSwitchActive: false });
  });
});

// ---------------------------------------------------------------------------
// 4. What a confirmed arm mutates — and what it must not
// ---------------------------------------------------------------------------

describeDb("arm-natural-window: mutation scope", () => {
  it("changes ONLY isEnabled and killSwitchActive", async () => {
    const window = await makeWindow();
    const before = await untouchable();

    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    const after = await untouchable();
    // The authorization row is byte-identical: no claim, no version bump.
    expect(after.windows).toEqual(before.windows);
    // The policy differs by exactly one field. `updatedAt` is excluded because
    // Prisma maintains it automatically on any write to the row.
    const { updatedAt: _a, ...afterPolicy } = after.policy;
    const { updatedAt: _b, ...beforePolicy } = before.policy;
    expect({ ...afterPolicy, killSwitchActive: true }).toEqual(beforePolicy);
    expect(after.policy.version).toBe(before.policy.version);
    expect(after.policy.allowedSymbols).toEqual(["COWUSDT"]);
  });

  it("spends no claim and creates no execution or alert", async () => {
    const window = await makeWindow();
    const executionsBefore = await prisma!.tradeExecution.count();
    const alertsBefore = await prisma!.alert.count();

    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    const after = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
    expect(after.claimedCount).toBe(0);
    expect(after.version).toBe(window.version);
    expect(after.consumedAt).toBeNull();
    expect(await prisma!.tradeExecution.count()).toBe(executionsBefore);
    expect(await prisma!.alert.count()).toBe(alertsBefore);
  });

  it("is idempotent — a repeat arm reports ALREADY ARMED and toggles nothing", async () => {
    const window = await makeWindow();
    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();
    const afterFirst = await untouchable();

    captured = [];
    await armNaturalCanary();

    expect(output()).toContain("ALREADY ARMED");
    expect(await profileState()).toEqual({ isEnabled: true, killSwitchActive: false });
    expect(await untouchable()).toEqual(afterFirst);
  });
});

// ---------------------------------------------------------------------------
// 5. Window state refusals — every one leaves the profile safe
// ---------------------------------------------------------------------------

describeDb("arm-natural-window: window state refusals", () => {
  const safe = { isEnabled: false, killSwitchActive: true };

  it("refuses an EXACT_SIGNAL id", async () => {
    const exact = await makeWindow({ type: "EXACT_SIGNAL" });
    argv(`--id=${exact.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("WINDOW_NOT_NATURAL");
    expect(output()).toContain("execution:arm-canary");
    expect(await profileState()).toEqual(safe);
  });

  it("refuses a window belonging to another profile", async () => {
    const foreign = await makeWindow({ profile: otherProfileId });
    argv(`--id=${foreign.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("WINDOW_WRONG_PROFILE");
    expect(await profileState()).toEqual(safe);
  });

  it("refuses an expired window", async () => {
    const window = await makeWindow({ ttlMinutes: -5 });
    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("WINDOW_EXPIRED");
    expect(await profileState()).toEqual(safe);
  });

  it("refuses a revoked window", async () => {
    const window = await makeWindow({ revoked: true });
    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("WINDOW_REVOKED");
    expect(await profileState()).toEqual(safe);
  });

  it("refuses an exhausted window", async () => {
    const window = await makeWindow({ maxClaims: 5, claimedCount: 5 });
    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("WINDOW_EXHAUSTED");
    expect(await profileState()).toEqual(safe);
  });

  it("refuses a window with no direction, and does not repair it", async () => {
    const window = await makeWindow({ directions: [] });
    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toMatch(/WINDOW_DIRECTIONS_INVALID|WINDOW_INVALID/);
    const after = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
    expect(after.allowedDirections).toEqual([]);
    expect(await profileState()).toEqual(safe);
  });

  it("refuses a maxClaims that is not the pinned canary budget", async () => {
    const window = await makeWindow({ maxClaims: 4 });
    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("WINDOW_MAX_CLAIMS_MISMATCH");
    expect(await profileState()).toEqual(safe);
  });
});

// ---------------------------------------------------------------------------
// 6. Minimum remaining lifetime — boundary values
// ---------------------------------------------------------------------------

describeDb("arm-natural-window: minimum remaining lifetime", () => {
  it("refuses a window that is AVAILABLE but nearly closed", async () => {
    // 60s left: perfectly valid to admission, far too short to supervise.
    const window = await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        allowedDirections: ["LONG", "SHORT"],
        maxClaims: 5,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("WINDOW_TTL_TOO_LOW");
    expect(await profileState()).toEqual({ isEnabled: false, killSwitchActive: true });
  });

  it("accepts a window comfortably above the floor", async () => {
    const window = await makeWindow({ ttlMinutes: 10 });
    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("ARMED.");
  });
});

// ---------------------------------------------------------------------------
// 7. Policy and allowlist
// ---------------------------------------------------------------------------

describeDb("arm-natural-window: policy and allowlist", () => {
  const safe = { isEnabled: false, killSwitchActive: true };

  it("refuses when the persisted limits are no longer the reviewed envelope", async () => {
    const window = await makeWindow();
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { maxTotalIsolatedMarginUsd: "400.00" },
    });

    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("POLICY_ENVELOPE_MISMATCH");
    expect(await profileState()).toEqual(safe);
  });

  it("observes allowedSymbols and never writes them", async () => {
    const window = await makeWindow();
    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });
    expect(policy.allowedSymbols).toEqual(["COWUSDT"]);
    expect(output()).toMatch(/allowedSymbols\s+\[COWUSDT\]/);
  });
});

// ---------------------------------------------------------------------------
// 8. Preflight is required, and it is the NATURAL one
// ---------------------------------------------------------------------------

describeDb("arm-natural-window: preflight", () => {
  it("refuses when preparation is incomplete", async () => {
    const window = await makeWindow();
    preflightFindings = { preparation: [{ code: "CANARY_BLOCKED_BINANCE", detail: "signed request failed" }], live: [] };

    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("CANARY_BLOCKED_BINANCE");
    expect(await profileState()).toEqual({ isEnabled: false, killSwitchActive: true });
  });

  it("refuses when the natural authorization dimension itself fails", async () => {
    const window = await makeWindow();
    preflightFindings = {
      preparation: [],
      live: [{ code: "CANARY_BLOCKED_AUTHORIZATION", detail: "NATURAL_WINDOW_EXPIRED: expired" }],
    };

    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("CANARY_BLOCKED_AUTHORIZATION");
    expect(await profileState()).toEqual({ isEnabled: false, killSwitchActive: true });
  });

  it("still arms when the ONLY live blocker is the kill switch this command releases", async () => {
    // The staged model: demanding a READY verdict before arming would be
    // unsatisfiable, because the profile kill switch is itself a live blocker.
    const window = await makeWindow();
    preflightFindings = {
      preparation: [],
      live: [{ code: "CANARY_BLOCKED_KILL_SWITCH_STATE", detail: "profile kill switch engaged" }],
    };

    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("ARMED.");
  });
});

// ---------------------------------------------------------------------------
// 9. Environment gates are not database state
// ---------------------------------------------------------------------------

describeDb("arm-natural-window: environment gates", () => {
  it("refuses while the env activation gates are still closed", async () => {
    const window = await makeWindow();
    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls({
      ...ARMED_GATES,
      EXECUTION_GLOBAL_KILL_SWITCH: "true",
      EXECUTION_LIVE_ENTRY_ENABLED: "false",
      EXECUTION_PROTECTION_READY: "false",
    });
    await armNaturalCanary();

    expect(output()).toContain("environment activation gates");
    expect(output()).toContain("edit .env and restart FIRST");
    expect(await profileState()).toEqual({ isEnabled: false, killSwitchActive: true });
  });
});

// ---------------------------------------------------------------------------
// 10. Structural boundaries
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 11. Races — a passed dry run is never authorization for a later write
// ---------------------------------------------------------------------------

/**
 * Two genuinely different gaps are exercised here.
 *
 * OUTER: the CLI reads the window and policy, prints them, and only then opens
 * the transaction. Everything can change in between. These tests mutate the row
 * after capturing the expected versions, exactly as a concurrent operator would.
 *
 * INNER: inside the transaction, the policy is read and then updated. A commit
 * that lands between those two statements must lose. That one needs a real hook,
 * because sequential setup cannot reach between two statements of one function.
 */
describeDb("arm-natural-window: races", () => {
  const armInput = (window: { id: string; version: number }, policyVersion = 3) => ({
    executionProfileId: profileId,
    authorizationId: window.id,
    expectedWindowVersion: window.version,
    expectedPolicyVersion: policyVersion,
    expectedAllowedSymbols: ["COWUSDT"],
  });

  async function runArm(input: ReturnType<typeof armInput>) {
    const { armNaturalWindow } = await import("../src/modules/execution/natural-arm");
    return prisma!.$transaction((tx) => armNaturalWindow(tx, input));
  }

  it("A. refuses when the window EXPIRED between the dry run and the write", async () => {
    const window = await makeWindow({ ttlMinutes: 30 });
    const input = armInput(window);

    // The gap: the operator read an open window; it closed before they confirmed.
    await prisma!.executionCanaryAuthorization.update({
      where: { id: window.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const result = await runArm(input);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("WINDOW_EXPIRED");
    expect(await profileState()).toEqual({ isEnabled: false, killSwitchActive: true });
    expect((await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } })).claimedCount).toBe(0);
  });

  it("B. refuses when the window was REVOKED between the dry run and the write", async () => {
    const window = await makeWindow();
    const input = armInput(window);

    await prisma!.executionCanaryAuthorization.update({
      where: { id: window.id },
      data: { revokedAt: new Date() },
    });

    const result = await runArm(input);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("WINDOW_REVOKED");
    expect(await profileState()).toEqual({ isEnabled: false, killSwitchActive: true });
  });

  it("C. refuses when the budget/version moved between the dry run and the write", async () => {
    const window = await makeWindow();
    const input = armInput(window);

    // A claim landed: version moved, so the reviewed evaluation is stale even
    // though the window is still open and still has budget.
    await prisma!.executionCanaryAuthorization.update({
      where: { id: window.id },
      data: { claimedCount: 1, version: { increment: 1 } },
    });

    const result = await runArm(input);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("WINDOW_VERSION_CHANGED");
    expect(await profileState()).toEqual({ isEnabled: false, killSwitchActive: true });
    // The claim that raced us is untouched — arming never rewrites the row.
    expect((await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } })).claimedCount).toBe(1);
  });

  it("D. refuses when the POLICY changed between the dry run and the write", async () => {
    const window = await makeWindow();
    const input = armInput(window);

    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { version: { increment: 1 } },
    });

    const result = await runArm(input);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("POLICY_VERSION_CHANGED");
    expect(await profileState()).toEqual({ isEnabled: false, killSwitchActive: true });
  });

  it("D2. refuses when allowedSymbols changed between the dry run and the write", async () => {
    const window = await makeWindow();
    const input = armInput(window);

    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { allowedSymbols: ["COWUSDT", "HEMIUSDT"] },
    });

    const result = await runArm(input);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("ALLOWED_SYMBOLS_CHANGED");
    expect(await profileState()).toEqual({ isEnabled: false, killSwitchActive: true });
    // Refusing did not "fix" the allowlist either.
    const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });
    expect(policy.allowedSymbols).toEqual(["COWUSDT", "HEMIUSDT"]);
  });

  it("E. INNER: a policy commit landing between the read and the CAS loses", async () => {
    const window = await makeWindow();
    const state = { fired: false };

    const { armNaturalWindow } = await import("../src/modules/execution/natural-arm");

    // Wraps the transaction client so a competing commit lands in the real gap
    // between reading the policy and compare-and-setting the kill switch.
    const racing = (tx: never) => {
      const real = tx as unknown as {
        $executeRaw: (...args: never[]) => Promise<unknown>;
        executionCanaryAuthorization: { findUnique: (args: never) => Promise<unknown> };
        executionSafetyPolicy: { findUnique: (args: never) => Promise<unknown>; updateMany: (args: never) => Promise<{ count: number }> };
        executionProfile: { findUniqueOrThrow: (args: never) => Promise<unknown>; updateMany: (args: never) => Promise<unknown> };
      };
      return {
        $executeRaw: (...args: never[]) => real.$executeRaw(...args),
        executionCanaryAuthorization: {
          findUnique: (args: never) => real.executionCanaryAuthorization.findUnique(args),
        },
        executionSafetyPolicy: {
          findUnique: async (args: never) => {
            const row = await real.executionSafetyPolicy.findUnique(args);
            if (!state.fired) {
              state.fired = true;
              // A separate, autocommitting connection — a real competing writer.
              await prisma!.executionSafetyPolicy.update({
                where: { executionProfileId: profileId },
                data: { version: { increment: 1 } },
              });
            }
            return row;
          },
          updateMany: (args: never) => real.executionSafetyPolicy.updateMany(args),
        },
        executionProfile: {
          findUniqueOrThrow: (args: never) => real.executionProfile.findUniqueOrThrow(args),
          updateMany: (args: never) => real.executionProfile.updateMany(args),
        },
      } as unknown as Parameters<typeof armNaturalWindow>[0];
    };

    const result = await prisma!.$transaction((tx) => armNaturalWindow(racing(tx as never), armInput(window)));

    // The race genuinely happened, and the CAS refused rather than arming.
    expect(state.fired).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("POLICY_VERSION_CHANGED");
    expect(await profileState()).toEqual({ isEnabled: false, killSwitchActive: true });
  });

  it("F. no refusal ever leaves a half-applied profile", async () => {
    // isEnabled and killSwitchActive move together or not at all.
    for (const setup of ["expired", "revoked", "version", "policy"] as const) {
      await resetProfile();
      const window = await makeWindow();
      const input = armInput(window);
      if (setup === "expired") {
        await prisma!.executionCanaryAuthorization.update({ where: { id: window.id }, data: { expiresAt: new Date(0) } });
      } else if (setup === "revoked") {
        await prisma!.executionCanaryAuthorization.update({ where: { id: window.id }, data: { revokedAt: new Date() } });
      } else if (setup === "version") {
        await prisma!.executionCanaryAuthorization.update({ where: { id: window.id }, data: { version: { increment: 1 } } });
      } else {
        await prisma!.executionSafetyPolicy.update({
          where: { executionProfileId: profileId },
          data: { version: { increment: 1 } },
        });
      }

      const result = await runArm(input);
      expect(`${setup}:${result.ok}`).toBe(`${setup}:false`);
      const state = await profileState();
      expect(`${setup}:${state.isEnabled}:${state.killSwitchActive}`).toBe(`${setup}:false:true`);
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Disarm is authorization-type agnostic — pinned, not changed
// ---------------------------------------------------------------------------

/**
 * `disarmCanary` is the strongest fail-safe shutdown, and it is deliberately
 * NOT natural-aware: `revokeUnused` matches on `consumedAt: null, revokedAt:
 * null` with no authorizationType filter, so it revokes an open NATURAL_WINDOW
 * exactly as it revokes an unused exact one.
 *
 * That is conservative in the right direction — disarming ends the canary, and
 * an operator reaching for it should not have to also remember to close the
 * window. These tests exist so the behaviour is explicit rather than incidental:
 * if someone later makes revoke type-aware, this fails and forces the decision
 * back into review. There is deliberately no separate natural-disarm command.
 */
describeDb("disarm: natural window behaviour", () => {
  it("revokes an open natural window, without refunding or deleting it", async () => {
    const window = await makeWindow({ maxClaims: 5 });
    // A partially spent budget, so a refund would be visible if one happened.
    await prisma!.executionCanaryAuthorization.update({
      where: { id: window.id },
      data: { claimedCount: 2 },
    });

    const { disarmCanary } = await loadControls();
    await disarmCanary();

    const after = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
    expect(after.revokedAt).not.toBeNull();
    // The row survives and the ledger is untouched: claims are never refunded.
    expect(after.claimedCount).toBe(2);
    expect(after.maxClaims).toBe(5);
    expect(after.allowedDirections).toEqual(["LONG", "SHORT"]);
  });

  it("engages the kill switch and returns the profile to the safe posture", async () => {
    const window = await makeWindow();
    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary, disarmCanary } = await loadControls();
    await armNaturalCanary();
    expect(await profileState()).toEqual({ isEnabled: true, killSwitchActive: false });

    await disarmCanary();

    // No outstanding work in this fixture, so the clean shutdown applies.
    expect(await profileState()).toEqual({ isEnabled: false, killSwitchActive: true });
  });

  it("keeps the profile enabled when work is still outstanding, so recovery continues", async () => {
    // The documented recovery posture: new work is blocked by the kill switch,
    // but the profile stays intact because protection and reconciliation need it.
    const window = await makeWindow();
    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary, disarmCanary } = await loadControls();
    await armNaturalCanary();

    const alert = await prisma!.alert.create({
      data: {
        indicatorName: `${TEST_IDENTIFIER}-alert`,
        assetType: "CRYPTO",
        symbol: "COWUSDT",
        timeframe: "15m",
        price: 1,
        signal: "LONG",
        rawPayload: {},
        triggeredAt: new Date(),
      },
    });
    const outstanding = await prisma!.tradeExecution.create({
      data: {
        executionProfileId: profileId,
        alertId: alert.id,
        symbol: "COWUSDT",
        direction: "LONG",
        positionSide: "LONG",
        status: "PROTECTED",
        selectedLookback: 20,
        selectedLeverage: 5,
        plannedEntryPrice: "1",
        calculatedStopLoss: "0.9",
        executableStopLoss: "0.9",
        riskBudgetUsd: "1.5",
        quantityRaw: "1",
        plannedQuantity: "1",
        quantityStepSize: "0.001",
        actualPlannedLoss: "1.5",
        unusedRiskBudget: "0",
        positionNotional: "10",
        targetIsolatedMargin: "2",
        maximumIsolatedMargin: "2.5",
        estimatedInitialMargin: "2",
        liquidationBufferRatio: "1.5",
      },
    });

    await disarmCanary();

    const state = await profileState();
    // Kill switch ALWAYS engages; the profile stays enabled for recovery.
    expect(state.killSwitchActive).toBe(true);
    expect(state.isEnabled).toBe(true);
    expect(output()).toContain("CANARY_DISARMED_NEW_WORK_BLOCKED_RECOVERY_CONTINUES");

    // The live execution was neither cancelled nor closed.
    const still = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: outstanding.id } });
    expect(still.status).toBe("PROTECTED");

    await prisma!.tradeExecution.delete({ where: { id: outstanding.id } });
    await prisma!.alert.delete({ where: { id: alert.id } });
  });
});

// ---------------------------------------------------------------------------
// 15. Runtime attestation interlock (Phase 12.4D-A.1)
// ---------------------------------------------------------------------------

/**
 * The Phase 4D-A finding, at the arm boundary.
 *
 * The `.env` on disk, and therefore this CLI's own snapshot, can say the
 * activation gates are open while the backend or worker that actually executes
 * trades is still running the snapshot IT parsed at startup. `environmentIsArmed()`
 * cannot see that — it only reads this process's configuration. These tests
 * prove arm refuses whenever the running processes cannot be shown to agree.
 */
describeDb("arm-natural-window: runtime attestation interlock", () => {
  const SAFE_STATE = { isEnabled: false, killSwitchActive: true };

  const blockedAttestation = (reasonCode: string, message: string, overrides: Record<string, unknown> = {}) => ({
    ...passingAttestation(),
    ok: false,
    reasonCode,
    message,
    ...overrides,
  });

  it("BLOCKS a confirmed arm when the backend is running a stale .env snapshot", async () => {
    // THE core Phase-4D-A regression: worker restarted, backend not.
    const window = await makeWindow();
    const before = await untouchable();
    attestationResult = blockedAttestation(
      "RUNTIME_ATTESTATION_MISMATCH",
      "the running processes loaded different execution gates than this command did; restart them after editing .env.",
      {
        backend: {
          role: "BACKEND",
          freshCount: 1,
          staleCount: 0,
          gates: { ...LIVE_GATES, globalKillSwitch: true, liveEntryEnabled: false, protectionReady: false },
          instanceId: "b1",
        },
      }
    );

    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("RUNTIME_ATTESTATION_MISMATCH");
    // Fails closed BEFORE any DB mutation.
    expect(await profileState()).toEqual(SAFE_STATE);
    const after = await untouchable();
    expect(after.windows).toEqual(before.windows);
    expect(after.policy.killSwitchActive).toBe(true);
    expect(after.policy.version).toBe(before.policy.version);
  });

  it.each([
    ["RUNTIME_ATTESTATION_MISSING", "no BACKEND runtime is attesting for this execution identity."],
    ["RUNTIME_ATTESTATION_STALE", "the WORKER runtime last reported more than 15s ago."],
    ["RUNTIME_ATTESTATION_DUPLICATE", "2 fresh BACKEND runtimes are attesting; exactly one is required."],
    ["RUNTIME_ATTESTATION_UNAVAILABLE", "runtime attestation could not be read (connection refused)."],
  ])("BLOCKS a confirmed arm on %s", async (reasonCode, message) => {
    const window = await makeWindow();
    attestationResult = blockedAttestation(reasonCode, message);

    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain(reasonCode);
    expect(await profileState()).toEqual(SAFE_STATE);
    // No claim, no authorization rewrite.
    const after = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
    expect(after.claimedCount).toBe(0);
    expect(after.version).toBe(window.version);
  });

  it("displays the attestation block in a DRY RUN, including each role's gates", async () => {
    const window = await makeWindow();
    argv(`--id=${window.id}`);
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    const text = output();
    expect(text).toContain("Runtime attestation");
    expect(text).toMatch(/backend instances\s+1 fresh \/ 0 stale/);
    expect(text).toMatch(/worker instances\s+1 fresh \/ 0 stale/);
    expect(text).toMatch(/result\s+PASS/);
    expect(text).toContain("DRY RUN");
  });

  it("shows BLOCKED and the reason in a dry run without hiding the mismatch", async () => {
    const window = await makeWindow();
    attestationResult = blockedAttestation("RUNTIME_ATTESTATION_DUPLICATE", "2 fresh WORKER runtimes are attesting; exactly one is required.");

    argv(`--id=${window.id}`);
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toMatch(/result\s+BLOCKED/);
    expect(output()).toContain("2 fresh WORKER runtimes");
  });

  it("still arms when attestation PASSES and every existing gate also passes", async () => {
    // Attestation must be an ADDITIONAL gate, never a replacement for one.
    const window = await makeWindow();
    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("ARMED.");
    expect(await profileState()).toEqual({ isEnabled: true, killSwitchActive: false });
  });

  it("does not let a PASSING attestation bypass any existing check", async () => {
    // Attestation PASS + expired window must still refuse on the window.
    const window = await makeWindow({ ttlMinutes: -5 });
    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("WINDOW_EXPIRED");
    expect(await profileState()).toEqual(SAFE_STATE);
  });

  it("never writes runtime presence — arm only reads it", () => {
    const controls = readFileSync(path.join(process.cwd(), "src/modules/execution/run-canary-controls.ts"), "utf8");
    // The publisher API must not be reachable from operator control code.
    for (const forbidden of ["createRuntimeAttestationPublisher", "publishOnce", ".start()", "runtimeAttestationKey"]) {
      expect(`${forbidden}:${controls.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("leaves CLOSE and DISARM independent of attestation", async () => {
    // A safety-off action must work when the runtime is missing or Redis is
    // down. If either ever consulted attestation, this fails.
    const controls = readFileSync(path.join(process.cwd(), "src/modules/execution/run-canary-controls.ts"), "utf8");
    const slice = (start: string, end?: string) => {
      const from = controls.indexOf(start);
      const to = end ? controls.indexOf(end, from) : controls.length;
      return controls.slice(from, to === -1 ? controls.length : to);
    };
    for (const [name, code] of [
      ["close", slice("export async function closeCanaryWindow", "export async function disarmCanary")],
      ["disarm", slice("export async function disarmCanary", "export async function armNaturalCanary")],
    ] as Array<[string, string]>) {
      expect(`${name}:${code.includes("evaluateRuntimeAttestation")}`).toBe(`${name}:false`);
    }

    // And behaviourally: with attestation hard-blocked, disarm still works.
    const window = await makeWindow();
    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary, disarmCanary } = await loadControls();
    await armNaturalCanary();
    expect(await profileState()).toEqual({ isEnabled: true, killSwitchActive: false });

    attestationResult = blockedAttestation("RUNTIME_ATTESTATION_UNAVAILABLE", "redis down");
    await disarmCanary();

    expect(await profileState()).toEqual(SAFE_STATE);
  });

  it("applies the SAME interlock to historical exact arm", async () => {
    // Exact arm opens the identical armed pair, so leaving it uninterlocked
    // would be a bypass of this entire feature.
    await makeExactWindow();
    attestationResult = blockedAttestation("RUNTIME_ATTESTATION_MISSING", "no WORKER runtime is attesting for this execution identity.");

    argv(CONFIRM_ARM_FLAG);
    const { armCanary } = await loadControls();
    await armCanary();

    expect(output()).toContain("RUNTIME_ATTESTATION_MISSING");
    expect(await profileState()).toEqual(SAFE_STATE);
  });

  it("exact arm still reaches its historical checks when attestation passes", async () => {
    // Proves the interlock did not replace exact arm's own contract: with no
    // authorization prepared it must still refuse for the historical reason.
    attestationResult = passingAttestation();
    argv(CONFIRM_ARM_FLAG);
    const { armCanary } = await loadControls();
    await armCanary();

    expect(output()).toMatch(/no active unexpired authorization/i);
    expect(await profileState()).toEqual(SAFE_STATE);
  });
});

describe("arm-natural-window: structural boundaries", () => {
  const armSource = readFileSync(path.join(process.cwd(), "src/modules/execution/natural-arm.ts"), "utf8");
  const controlsSource = readFileSync(path.join(process.cwd(), "src/modules/execution/run-canary-controls.ts"), "utf8");
  const armCli = controlsSource.slice(controlsSource.indexOf("export async function armNaturalCanary"));

  it("never claims, and exposes no path that could", () => {
    // Call-shaped and import-shaped, so the module's own prose about NOT
    // claiming cannot satisfy the assertion.
    // claimedCount/consumedAt are READ into the snapshot, so listing them here
    // would be imprecise; the exhaustive `data:` payload pin below is strictly
    // stronger and proves neither is ever written.
    for (const forbidden of ["claimNaturalWindow(", "consumedAt:"]) {
      expect(`${forbidden}:${armSource.includes(forbidden)}`).toBe(`${forbidden}:false`);
      expect(`cli ${forbidden}:${armCli.includes(forbidden)}`).toBe(`cli ${forbidden}:false`);
    }
    expect(armSource).not.toMatch(/import[^;]*claimNaturalWindow/);
  });

  it("never reaches the exchange, the webhook or the execution lifecycle", () => {
    for (const forbidden of [
      "binance",
      "Binance",
      "webhook",
      "tradeExecution.create",
      "entry-lifecycle",
      "protection-lifecycle",
      "selected-plan-executor",
    ]) {
      expect(`${forbidden}:${armSource.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("never writes allowedSymbols or the authorization row", () => {
    // Every `data:` payload in the module, listed exhaustively: arming writes
    // exactly two fields and nothing else. Naming allowedSymbols in a READ or a
    // message must not satisfy this, so the payloads themselves are pinned.
    const payloads = [...armSource.matchAll(/data:\s*\{([^}]*)\}/g)].map((match) => match[1].trim());
    expect(payloads).toEqual(["killSwitchActive: false", "isEnabled: true"]);
    expect(armSource).not.toMatch(/executionCanaryAuthorization\.(update|updateMany|create|delete)/);
  });

  it("keeps the historical exact arm natural-unaware", () => {
    const exactArm = controlsSource.slice(
      controlsSource.indexOf("export async function armCanary"),
      controlsSource.indexOf("export async function closeCanaryWindow")
    );
    for (const entry of ["NATURAL_WINDOW", "naturalWindowState", "armNaturalWindow", "maxClaims"]) {
      expect(`${entry}:${exactArm.includes(entry)}`).toBe(`${entry}:false`);
    }
  });

  it("has no force, skip or bypass flag", () => {
    for (const forbidden of ["--force", "--skip", "--ignore", "--bypass", "--yes"]) {
      expect(`${forbidden}:${armCli.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("never touches the real profile identity", async () => {
    if (!available) return;
    const real = await prisma!.executionProfile.findFirst({ where: { accountIdentifier: REAL_IDENTIFIER } });
    if (real) expect(real.id).not.toBe(profileId);
  });
});

// ---------------------------------------------------------------------------
// 13. Operator concurrency — real overlapping transactions
// ---------------------------------------------------------------------------

/**
 * These are the tests the Phase-4C review deliberately withheld until the
 * shared-lock fix was authorized. They do NOT simulate a race with sequential
 * calls: each one starts a real locked transaction, proves the competing
 * operator command is genuinely blocked while it is held, and only then lets
 * the first commit.
 *
 * The legitimate final pairs are:
 *
 *   SAFE OFF       isEnabled=false killSwitchActive=true
 *   SAFE BLOCKED   isEnabled=true  killSwitchActive=true
 *   ARMED          isEnabled=true  killSwitchActive=false
 *
 * SAFE BLOCKED is the normal result of an explicit `close-canary-window`, which
 * engages the kill switch and deliberately leaves the profile ENABLED — it
 * blocks new admission without disabling anything, and needs no outstanding
 * work to be legitimate. SAFE RECOVERY is the SAME persisted pair reached for a
 * different operational reason: disarm found outstanding work and kept the
 * profile enabled so reconciliation and protection could continue. The pair
 * alone therefore never proves which of the two happened, and no test here
 * treats true/true as evidence of outstanding work.
 *
 * `isEnabled=false, killSwitchActive=false` is not reachable and every test
 * below asserts the PAIR, never one field.
 */
describeDb("operator concurrency: serialized whole operations", () => {
  type State = { isEnabled: boolean; killSwitchActive: boolean };
  const SAFE_OFF: State = { isEnabled: false, killSwitchActive: true };
  const ARMED: State = { isEnabled: true, killSwitchActive: false };

  /** Holds the operator lock, runs `competitor`, and proves it was blocked. */
  async function raceUnderLock(
    inside: (tx: never) => Promise<unknown>,
    competitor: () => Promise<void>
  ): Promise<{ overlapped: boolean; competitorFinishedFirst: boolean }> {
    let released = false;
    let competitorFinishedFirst = false;
    let sawBlocked = false;
    let competing: Promise<void> | null = null;

    await prisma!.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x11b0}::int, ${profileLockKeyFor(profileId)}::int)`;
        // The competitor starts now and must NOT be able to finish. It is
        // deliberately NOT awaited inside the transaction: the whole point is
        // that it cannot proceed until this transaction commits.
        competing = competitor().then(() => {
          if (!released) competitorFinishedFirst = true;
        });
        await inside(tx as never);
        // Give the competitor a real chance to slip through if the lock is absent.
        await new Promise((resolve) => setTimeout(resolve, 300));
        sawBlocked = !competitorFinishedFirst;
        released = true;
      },
      { timeout: 20_000 }
    );

    await competing;
    return { overlapped: sawBlocked, competitorFinishedFirst };
  }

  it("I. natural ARM first, CLOSE waiting -> final SAFE, no claim, no row rewrite", async () => {
    const window = await makeWindow();
    const { armNaturalWindow } = await import("../src/modules/execution/natural-arm");
    const { closeCanaryWindow } = await loadControls();

    const race = await raceUnderLock(
      (tx) =>
        armNaturalWindow(tx as never, {
          executionProfileId: profileId,
          authorizationId: window.id,
          expectedWindowVersion: window.version,
          expectedPolicyVersion: 3,
          expectedAllowedSymbols: ["COWUSDT"],
        }),
      () => closeCanaryWindow()
    );

    // The overlap was real: close could not commit while the lock was held.
    expect(race.overlapped).toBe(true);
    expect(race.competitorFinishedFirst).toBe(false);

    // Close serialized AFTER the arm, so safety wins.
    expect(await profileState()).toEqual({ isEnabled: true, killSwitchActive: true });

    const after = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
    expect(after.claimedCount).toBe(0);
    expect(after.version).toBe(window.version);
  }, 30_000);

  it("J. CLOSE first, then natural ARM -> arm may legitimately proceed", async () => {
    // A completed close does NOT permanently forbid a later explicit arm.
    const window = await makeWindow();
    const { closeCanaryWindow } = await loadControls();
    await closeCanaryWindow();
    expect((await profileState()).killSwitchActive).toBe(true);

    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(await profileState()).toEqual(ARMED);
  });

  it("K. natural ARM first, DISARM waiting -> final SAFE OFF, window revoked, no refund", async () => {
    const window = await makeWindow({ maxClaims: 5 });
    await prisma!.executionCanaryAuthorization.update({ where: { id: window.id }, data: { claimedCount: 2 } });
    const { armNaturalWindow } = await import("../src/modules/execution/natural-arm");
    const { disarmCanary } = await loadControls();

    const race = await raceUnderLock(
      (tx) =>
        armNaturalWindow(tx as never, {
          executionProfileId: profileId,
          authorizationId: window.id,
          expectedWindowVersion: window.version,
          expectedPolicyVersion: 3,
          expectedAllowedSymbols: ["COWUSDT"],
        }),
      () => disarmCanary()
    );

    expect(race.overlapped).toBe(true);

    // Disarm serialized last, so the profile ends SAFE — the exact outcome the
    // unsynchronized version got wrong.
    expect(await profileState()).toEqual(SAFE_OFF);

    const after = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
    expect(after.revokedAt).not.toBeNull();
    expect(after.claimedCount).toBe(2);
    expect(after.maxClaims).toBe(5);
  }, 30_000);

  it("BLOCKS a competing disarm from committing in arm's read->write gap", async () => {
    // This is the ORIGINAL defect, reproduced precisely.
    //
    // Row locks alone cannot prevent it: at the moment arm has only READ the
    // window and policy it holds no row lock, so an unsynchronized disarm could
    // revoke the window, engage the kill switch and disable the profile, commit,
    // and still lose to arm's later CAS — because disarm leaves version
    // unchanged and killSwitchActive=true, exactly what the CAS expects.
    //
    // Only the advisory lock closes that gap, by making disarm wait at its own
    // lock acquisition instead of committing here.
    const window = await makeWindow();
    const { armNaturalWindow } = await import("../src/modules/execution/natural-arm");
    const { disarmCanary } = await loadControls();

    let disarmCommitted = false;
    let firedInGap = false;
    let pending: Promise<void> | null = null;

    const racing = (tx: never) => {
      const real = tx as unknown as {
        $executeRaw: (...a: never[]) => Promise<unknown>;
        executionCanaryAuthorization: { findUnique: (a: never) => Promise<unknown> };
        executionSafetyPolicy: { findUnique: (a: never) => Promise<unknown>; updateMany: (a: never) => Promise<{ count: number }> };
        executionProfile: { findUniqueOrThrow: (a: never) => Promise<unknown>; updateMany: (a: never) => Promise<unknown> };
      };
      return {
        $executeRaw: (...a: never[]) => real.$executeRaw(...a),
        executionCanaryAuthorization: { findUnique: (a: never) => real.executionCanaryAuthorization.findUnique(a) },
        executionSafetyPolicy: {
          findUnique: async (a: never) => {
            const row = await real.executionSafetyPolicy.findUnique(a);
            if (!firedInGap) {
              firedInGap = true;
              // Started but NOT awaited: awaiting it here would deadlock
              // against the lock this very transaction holds.
              pending = disarmCanary().then(() => {
                disarmCommitted = true;
              });
              await new Promise((resolve) => setTimeout(resolve, 400));
            }
            return row;
          },
          updateMany: (a: never) => real.executionSafetyPolicy.updateMany(a),
        },
        executionProfile: {
          findUniqueOrThrow: (a: never) => real.executionProfile.findUniqueOrThrow(a),
          updateMany: (a: never) => real.executionProfile.updateMany(a),
        },
      } as unknown as Parameters<typeof armNaturalWindow>[0];
    };

    await prisma!.$transaction(
      async (tx) =>
        armNaturalWindow(racing(tx as never), {
          executionProfileId: profileId,
          authorizationId: window.id,
          expectedWindowVersion: window.version,
          expectedPolicyVersion: 3,
          expectedAllowedSymbols: ["COWUSDT"],
        }),
      { timeout: 20_000 }
    );

    // The gap was genuinely entered, and disarm could NOT commit inside it.
    expect(firedInGap).toBe(true);
    expect(disarmCommitted).toBe(false);

    await pending;

    // Disarm serialized after the arm, so the profile ends SAFE.
    expect(await profileState()).toEqual({ isEnabled: false, killSwitchActive: true });
    const after = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
    expect(after.revokedAt).not.toBeNull();
    expect(after.claimedCount).toBe(0);
  }, 30_000);

  it("L. DISARM first, then natural ARM -> arm REFUSES on the revoked window", async () => {
    // Proves the lock protects REVALIDATION, not merely update ordering.
    const window = await makeWindow();
    const { disarmCanary } = await loadControls();
    await disarmCanary();

    argv(`--id=${window.id}`, "--confirm-arm");
    const { armNaturalCanary } = await loadControls();
    await armNaturalCanary();

    expect(output()).toContain("WINDOW_REVOKED");
    expect(await profileState()).toEqual(SAFE_OFF);
  });

  it("M. exact ARM first, CLOSE waiting -> final SAFE", async () => {
    const exact = await makeExactWindow();
    const { closeCanaryWindow } = await loadControls();

    const race = await raceUnderLock(
      async (tx) => {
        const t = tx as unknown as {
          executionProfile: { update: (a: unknown) => Promise<unknown> };
          executionSafetyPolicy: { update: (a: unknown) => Promise<unknown> };
        };
        await t.executionProfile.update({ where: { id: profileId }, data: { isEnabled: true } });
        await t.executionSafetyPolicy.update({
          where: { executionProfileId: profileId },
          data: { killSwitchActive: false },
        }, 30_000);
      },
      () => closeCanaryWindow()
    );

    expect(race.overlapped).toBe(true);
    expect(await profileState()).toEqual({ isEnabled: true, killSwitchActive: true });
    expect(exact.id).toBeTruthy();
  });

  it("N/O. DISARM first revokes the exact authorization, then exact ARM REFUSES", async () => {
    // The reason exact arm had to revalidate AFTER the lock: a pre-lock
    // findActive() snapshot still shows the authorization a concurrent disarm
    // has already revoked.
    await makeExactWindow();
    const { disarmCanary } = await loadControls();
    await disarmCanary();

    argv(CONFIRM_ARM_FLAG);
    const { armCanary } = await loadControls();
    await armCanary();

    expect(output()).toMatch(/no active unexpired authorization/i);
    expect(await profileState()).toEqual(SAFE_OFF);
  });

  it("O2. exact ARM revalidates AFTER the lock: a revoke during its lock-wait REFUSES", async () => {
    // The previous test is caught by exact arm's PRE-lock check, so it proves
    // nothing about revalidation. This one forces the real gap: arm completes
    // its pre-lock reads (which SEE a valid authorization), then blocks on the
    // operator lock while the authorization is revoked underneath it — exactly
    // what a concurrent disarm does. Only the post-lock re-read can catch that.
    await makeExactWindow();
    argv(CONFIRM_ARM_FLAG);
    const { armCanary } = await loadControls();

    let armFinished = false;
    let arming: Promise<void> | null = null;

    await prisma!.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x11b0}::int, ${profileLockKeyFor(profileId)}::int)`;

        // Arm starts now: its pre-lock reads succeed, then it waits here.
        arming = armCanary().then(() => {
          armFinished = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 600));
        // It must still be waiting — proof the lock is doing the serializing.
        expect(armFinished).toBe(false);

        // What a concurrent disarm does to the authorization, committed inside
        // the lock so arm can only observe it after acquiring the lock.
        await tx.executionCanaryAuthorization.updateMany({
          where: { executionProfileId: profileId, consumedAt: null, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      },
      { timeout: 20_000 }
    );

    await arming;

    // Arm re-read under the lock, saw the revocation, and refused.
    expect(output()).toMatch(/no active unexpired authorization/i);
    expect(await profileState()).toEqual({ isEnabled: false, killSwitchActive: true });
  }, 30_000);

  it("never commits the impossible isEnabled=false + killSwitch=false pair", async () => {
    const window = await makeWindow();
    const { disarmCanary, closeCanaryWindow, armNaturalCanary } = await loadControls();
    for (const step of ["close", "disarm", "arm"] as const) {
      if (step === "close") await closeCanaryWindow();
      else if (step === "disarm") await disarmCanary();
      else {
        argv(`--id=${window.id}`, "--confirm-arm");
        await armNaturalCanary();
      }
      const state = await profileState();
      const legitimate =
        (state.isEnabled === false && state.killSwitchActive === true) ||
        (state.isEnabled === true && state.killSwitchActive === true) ||
        (state.isEnabled === true && state.killSwitchActive === false);
      expect(`${step}:${state.isEnabled}:${state.killSwitchActive}:${legitimate}`).toBe(
        `${step}:${state.isEnabled}:${state.killSwitchActive}:true`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 14. All four operator mutations share ONE lock
// ---------------------------------------------------------------------------

describe("operator concurrency: shared lock namespace", () => {
  const controls = readFileSync(path.join(process.cwd(), "src/modules/execution/run-canary-controls.ts"), "utf8");
  const arm = readFileSync(path.join(process.cwd(), "src/modules/execution/natural-arm.ts"), "utf8");
  // CLOSE and DISARM were lifted out of the CLI so the operator HTTP routes run
  // the identical transaction. The lock assertions follow them to their new
  // home rather than being dropped.
  const actions = readFileSync(path.join(process.cwd(), "src/modules/execution/operator-actions.ts"), "utf8");

  const sliceOf = (source: string, start: string, end?: string) => {
    const from = source.indexOf(start);
    // Loudly, not silently: a missing anchor used to yield an empty slice, and
    // an empty slice satisfies every "does not contain" assertion below. That
    // is how a structural guard quietly stops guarding anything.
    if (from === -1) throw new Error(`slice anchor not found: ${start}`);
    const to = end ? source.indexOf(end, from) : source.length;
    return source.slice(from, to === -1 ? source.length : to);
  };

  it("every operator mutation takes the SAME shared namespace by reference", () => {
    const paths: Array<[string, string]> = [
      ["natural arm", arm],
      ["exact arm", sliceOf(controls, "export async function armCanary", "export async function closeCanaryWindow")],
      ["close", sliceOf(actions, "export async function closeCanaryWindowOperation", "export type DisarmOutcomeCode")],
      ["disarm", sliceOf(actions, "export async function disarmCanaryOperation")],
    ];
    for (const [name, code] of paths) {
      // By the shared exported constant and helper, never a bare 0x11b0, so a
      // future namespace change stays coherent across all four.
      expect(`${name}:lock`).toBe(`${name}:${code.includes("pg_advisory_xact_lock") ? "lock" : "MISSING"}`);
      expect(`${name}:const`).toBe(
        `${name}:${code.includes("CANARY_PREPARE_LOCK_NAMESPACE") ? "const" : "LITERAL_OR_MISSING"}`
      );
      expect(`${name}:key`).toBe(`${name}:${code.includes("profileLockKey(") ? "key" : "MISSING"}`);
    }
  });

  it("holds no network call while the operator lock is held", () => {
    // The Binance preflight must stay OUTSIDE the locked transaction.
    for (const [name, code] of [
      ["exact arm", sliceOf(controls, "const armOutcome = await prisma.$transaction", "if (!armOutcome.ok)")],
      ["close", sliceOf(actions, "export async function closeCanaryWindowOperation", "export type DisarmOutcomeCode")],
      ["disarm", sliceOf(actions, "export async function disarmCanaryOperation")],
    ] as Array<[string, string]>) {
      for (const forbidden of ["CanaryPreflightService", "binance", "fetch(", "axios"]) {
        expect(`${name}:${forbidden}:${code.includes(forbidden)}`).toBe(`${name}:${forbidden}:false`);
      }
    }
  });
});
