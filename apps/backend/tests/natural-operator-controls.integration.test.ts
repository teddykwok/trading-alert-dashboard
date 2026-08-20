import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase, databaseNameOf } from "./helpers/test-database";

/**
 * Phase 12.4A — the natural-window operator commands, run for real against
 * Postgres.
 *
 * Safety rests on the same two things the Phase-11B control suite relies on:
 * the profile identity is overridden to a throwaway value BEFORE any module
 * reads config, and `CanaryPreflightService` is replaced so nothing here can
 * reach Binance. A final assertion proves the real `mainnet-canary-usdm`
 * profile was never touched.
 */

const REAL_IDENTIFIER = "mainnet-canary-usdm";
const TEST_IDENTIFIER = `phase12a-natural-${randomBytes(6).toString("hex")}`;

const { prisma: testDatabase, available, name: testDatabaseName } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

// The commands build their OWN PrismaClient with no datasource override, so
// they follow DATABASE_URL — which tests/setup.ts pins to the test database.
if (databaseNameOf(process.env.DATABASE_URL ?? "") !== testDatabaseName) {
  throw new Error("Refusing to run: the CLI under test would not use the test database.");
}

/** Everything still shut: the posture a window is prepared in. */
const SAFE_GATES = {
  EXECUTION_GLOBAL_KILL_SWITCH: "true",
  EXECUTION_LIVE_ENTRY_ENABLED: "false",
  EXECUTION_PROTECTION_READY: "false",
  BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED: "false",
  BINANCE_TEST_ORDER_ENABLED: "false",
  EXECUTION_AUTO_ADD_MARGIN_ENABLED: "false",
  EXECUTION_EMERGENCY_CLOSE_MODE: "DISABLED",
};

const OVERRIDDEN = ["EXECUTION_PROFILE_ACCOUNT_IDENTIFIER", "EXECUTION_PROFILE_ENVIRONMENT", ...Object.keys(SAFE_GATES)];
const originalEnv = new Map(OVERRIDDEN.map((key) => [key, process.env[key]]));
const originalArgv = process.argv;

async function loadControls() {
  vi.resetModules();
  process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = TEST_IDENTIFIER;
  process.env.EXECUTION_PROFILE_ENVIRONMENT = "MAINNET";
  Object.assign(process.env, SAFE_GATES);

  // Nothing in this suite may reach Binance, not even a read. The gathered
  // shape mirrors the real one because `armCanary` reports counts from it.
  vi.doMock("../src/modules/execution/canary-preflight.service", () => ({
    REQUIRED_CONSECUTIVE_SIGNED_SUCCESSES: 3,
    CanaryPreflightService: class {
      async run() {
        return {
          preparationBlockers: [],
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

async function resetProfile(): Promise<void> {
  await prisma!.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
  await prisma!.executionSafetyPolicy.updateMany({
    where: { executionProfileId: profileId },
    data: { killSwitchActive: true, allowedSymbols: ["COWUSDT"] },
  });
  await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled: false } });
}

/** Snapshot of everything the natural commands must never touch. */
async function untouchableSnapshot() {
  const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });
  const profile = await prisma!.executionProfile.findUniqueOrThrow({ where: { id: profileId } });
  return { policy, isEnabled: profile.isEnabled };
}

const windowsOf = () =>
  prisma!.executionCanaryAuthorization.findMany({
    where: { executionProfileId: profileId, authorizationType: "NATURAL_WINDOW" },
    orderBy: { createdAt: "desc" },
  });

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
      data: { executionProfileId: profileId, killSwitchActive: true, allowedSymbols: ["COWUSDT"] },
    });
  }
  if (available) await resetProfile();
});

afterEach(() => {
  logSpy?.mockRestore();
  process.argv = originalArgv;
  process.exitCode = undefined;
});

afterAll(async () => {
  if (!prisma) return;
  if (available && profileId !== "") {
    await prisma.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionProfile.deleteMany({ where: { id: profileId } });
  }
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.argv = originalArgv;
  await prisma.$disconnect();
});

const describeDb = available ? describe : describe.skip;

const argv = (...args: string[]) => {
  process.argv = ["node", "cli", ...args];
};

// ---------------------------------------------------------------------------
// 23. Prepare — dry run
// ---------------------------------------------------------------------------

describeDb("prepare-natural-window: dry run", () => {
  it("writes nothing and reports exactly what it WOULD create", async () => {
    const before = await untouchableSnapshot();
    argv("--directions=LONG,SHORT", "--max-claims=5", "--ttl-minutes=30");
    const { prepareNaturalWindow } = await loadControls();
    await prepareNaturalWindow();

    const text = output();
    expect(text).toContain("DRY RUN");
    expect(text).toContain("NO DATABASE WRITE WAS PERFORMED");
    expect(text).toContain("NATURAL_WINDOW");
    expect(text).toMatch(/allowedDirections\s+\[LONG, SHORT\]/);
    expect(text).toMatch(/maxClaims\s+5/);
    expect(text).toMatch(/claimedCount\s+0/);
    expect(text).toMatch(/version\s+1/);
    expect(text).toMatch(/ttlMinutes\s+30/);
    // Projected, never reserved: the label and the value both say so.
    expect(text).toContain("expiresAt (projected)");
    expect(text).toContain("nothing is reserved until --confirm");
    // MAINNET is named unmistakably before anything could be written.
    expect(text).toContain("MAINNET — REAL FUNDS");

    // Nothing created, nothing touched.
    expect(await windowsOf()).toHaveLength(0);
    expect(await untouchableSnapshot()).toEqual(before);
  });

  it("prints no token, because a natural window has none", async () => {
    argv("--directions=LONG", "--max-claims=5");
    const { prepareNaturalWindow } = await loadControls();
    await prepareNaturalWindow();

    expect(output()).toContain("none — natural authorization is server-side");
    expect(output()).not.toMatch(/tokenHash|[A-Za-z0-9_-]{30,}/);
  });

  it("rejects an invalid direction set, budget or TTL without touching the database", async () => {
    const before = await untouchableSnapshot();
    for (const args of [
      ["--directions=", "--max-claims=5"],
      ["--directions=BOTH", "--max-claims=5"],
      ["--directions=*", "--max-claims=5"],
      ["--directions=LONG", "--max-claims=0"],
      ["--directions=LONG", "--max-claims=-1"],
      ["--directions=LONG", "--max-claims=2.5"],
      ["--directions=LONG", "--max-claims=5", "--ttl-minutes=61"],
      ["--directions=LONG", "--max-claims=5", "--ttl-minutes=0"],
    ]) {
      captured = [];
      process.exitCode = undefined;
      argv(...args, "--confirm");
      const { prepareNaturalWindow } = await loadControls();
      await prepareNaturalWindow();
      expect(output(), args.join(" ")).toMatch(/BLOCKED|Usage:/);
      expect(process.exitCode, args.join(" ")).toBe(1);
    }
    expect(await windowsOf()).toHaveLength(0);
    expect(await untouchableSnapshot()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 24. Prepare — confirmed
// ---------------------------------------------------------------------------

describeDb("prepare-natural-window: confirmed", () => {
  it("creates exactly one correctly shaped NATURAL_WINDOW", async () => {
    const before = await untouchableSnapshot();
    argv("--directions=SHORT,LONG,LONG", "--max-claims=5", "--ttl-minutes=30", "--confirm");
    const { prepareNaturalWindow } = await loadControls();
    await prepareNaturalWindow();

    expect(output()).toContain("APPLIED.");
    const windows = await windowsOf();
    expect(windows).toHaveLength(1);
    const window = windows[0];
    expect(window.authorizationType).toBe("NATURAL_WINDOW");
    // No token, no singular symbol or direction.
    expect(window.tokenHash).toBeNull();
    expect(window.allowedSymbol).toBeNull();
    expect(window.allowedDirection).toBeNull();
    // Canonicalized and de-duplicated by the domain helper.
    expect(window.allowedDirections).toEqual(["LONG", "SHORT"]);
    expect(window.maxClaims).toBe(5);
    expect(window.claimedCount).toBe(0);
    expect(window.version).toBe(1);
    expect(window.consumedAt).toBeNull();
    expect(window.revokedAt).toBeNull();
    expect(window.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(window.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60_000);

    // 17. The policy and the gates are untouched — allowedSymbols especially.
    const after = await untouchableSnapshot();
    expect(after).toEqual(before);
    expect(after.policy.allowedSymbols).toEqual(["COWUSDT"]);
  });

  it("supports a single-direction window", async () => {
    argv("--directions=SHORT", "--max-claims=2", "--confirm");
    const { prepareNaturalWindow } = await loadControls();
    await prepareNaturalWindow();
    expect((await windowsOf())[0].allowedDirections).toEqual(["SHORT"]);
  });
});

// ---------------------------------------------------------------------------
// 25. Exclusivity — surfaced, never re-implemented in the CLI
// ---------------------------------------------------------------------------

describeDb("prepare-natural-window: exclusivity", () => {
  const prepare = async (...args: string[]) => {
    argv(...args);
    const { prepareNaturalWindow } = await loadControls();
    await prepareNaturalWindow();
  };

  it("an open natural window blocks a replacement", async () => {
    await prepare("--directions=LONG", "--max-claims=5", "--confirm");
    captured = [];
    await prepare("--directions=SHORT", "--max-claims=5", "--confirm");

    expect(output()).toContain("NOT APPLIED");
    expect(output()).toContain("CANARY_AUTHORIZATION_ALREADY_ACTIVE");
    expect(process.exitCode).toBe(1);
    expect(await windowsOf()).toHaveLength(1);
  });

  it("an EXHAUSTED but unexpired window still blocks a replacement", async () => {
    await prepare("--directions=LONG", "--max-claims=2", "--confirm");
    const [window] = await windowsOf();
    await prisma!.executionCanaryAuthorization.update({
      where: { id: window.id },
      data: { claimedCount: 2, version: 3 },
    });

    captured = [];
    await prepare("--directions=LONG", "--max-claims=5", "--confirm");
    expect(output()).toContain("NOT APPLIED");
    // The spent budget is NOT silently refilled by a second window.
    expect(await windowsOf()).toHaveLength(1);
  });

  it("an active EXACT authorization blocks natural preparation", async () => {
    await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "EXACT_SIGNAL",
        allowedSymbol: "COWUSDT",
        allowedDirection: "LONG",
        tokenHash: `exact-${randomBytes(6).toString("hex")}`,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    await prepare("--directions=LONG", "--max-claims=5", "--confirm");
    expect(output()).toContain("NOT APPLIED");
    expect(await windowsOf()).toHaveLength(0);
  });

  it("revoking releases the exclusivity", async () => {
    await prepare("--directions=LONG", "--max-claims=5", "--confirm");
    const [first] = await windowsOf();
    await prisma!.executionCanaryAuthorization.update({
      where: { id: first.id },
      data: { revokedAt: new Date() },
    });

    captured = [];
    await prepare("--directions=SHORT", "--max-claims=5", "--confirm");
    expect(output()).toContain("APPLIED.");
    expect(await windowsOf()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 26. Inspection
// ---------------------------------------------------------------------------

describeDb("show-authorization", () => {
  const show = async () => {
    argv();
    const { showAuthorization } = await loadControls();
    await showAuthorization();
  };

  const makeWindow = (overrides: Record<string, unknown> = {}) =>
    prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        allowedDirections: ["LONG", "SHORT"],
        maxClaims: 5,
        expiresAt: new Date(Date.now() + 600_000),
        ...overrides,
      },
    });

  it.each([
    ["AVAILABLE", {}],
    ["EXHAUSTED", { claimedCount: 5 }],
    ["EXPIRED", { expiresAt: new Date(Date.now() - 1000) }],
    ["REVOKED", { revokedAt: new Date() }],
    // A row declaring NATURAL_WINDOW while holding exact identity.
    ["INVALID", { allowedSymbol: "BTCUSDT" }],
  ])("reports state %s", async (state, overrides) => {
    await makeWindow(overrides);
    await show();

    const text = output();
    expect(text).toContain("NATURAL_WINDOW");
    expect(text).toMatch(new RegExp(`state\\s+${state}`));
    expect(text).toContain("read only");
  });

  it("reports the budget, directions and expiry without any secret", async () => {
    await makeWindow({ claimedCount: 2 });
    await show();

    const text = output();
    expect(text).toMatch(/allowedDirections\s+\[LONG, SHORT\]/);
    expect(text).toMatch(/maxClaims\s+5/);
    expect(text).toMatch(/claimedCount\s+2/);
    expect(text).toMatch(/remainingClaims\s+3/);
    expect(text).toContain("expiresAt");
    expect(text).not.toMatch(/tokenHash/);
  });

  it("never prints an exact token hash, and mutates nothing", async () => {
    const hash = `secret-${randomBytes(8).toString("hex")}`;
    await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "EXACT_SIGNAL",
        allowedSymbol: "COWUSDT",
        allowedDirection: "LONG",
        tokenHash: hash,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const before = await untouchableSnapshot();
    await show();

    expect(output()).not.toContain(hash);
    expect(output()).toContain("EXACT_SIGNAL");
    expect(await untouchableSnapshot()).toEqual(before);
    // Still exactly the one row it read.
    expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(1);
  });

  it("says so plainly when nothing is prepared", async () => {
    await show();
    expect(output()).toMatch(/none prepared/);
  });
});

// ---------------------------------------------------------------------------
// 27. Revoke
// ---------------------------------------------------------------------------

describeDb("revoke-natural-window", () => {
  const revoke = async (...args: string[]) => {
    argv(...args);
    const { revokeNaturalWindow } = await loadControls();
    await revokeNaturalWindow();
  };

  const openWindow = () =>
    prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        allowedDirections: ["LONG"],
        maxClaims: 5,
        claimedCount: 2,
        version: 3,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

  it("dry run mutates nothing", async () => {
    const window = await openWindow();
    await revoke();

    expect(output()).toContain("DRY RUN");
    expect(output()).toContain("NO DATABASE WRITE WAS PERFORMED");
    const after = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
    expect(after.revokedAt).toBeNull();
  });

  it("confirmed revoke sets revokedAt and preserves everything else", async () => {
    const window = await openWindow();
    await revoke("--confirm");

    expect(output()).toContain("APPLIED.");
    const after = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
    expect(after.revokedAt).not.toBeNull();
    // The row survives with its audit facts: no deletion, NO REFUND.
    expect(after.claimedCount).toBe(2);
    expect(after.maxClaims).toBe(5);
    expect(after.allowedDirections).toEqual(["LONG"]);
    expect(await prisma!.executionCanaryAuthorization.count({ where: { id: window.id } })).toBe(1);
  });

  it("a second revoke is safe and idempotent", async () => {
    const window = await openWindow();
    await revoke("--confirm");
    const firstRevokedAt = (
      await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } })
    ).revokedAt;

    captured = [];
    await revoke(`--id=${window.id}`, "--confirm");
    expect(output()).toContain("ALREADY REVOKED");
    const after = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
    expect(after.revokedAt).toEqual(firstRevokedAt);
    expect(after.claimedCount).toBe(2);
  });

  it("refuses an id that is not a natural window on this profile", async () => {
    const exact = await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "EXACT_SIGNAL",
        allowedSymbol: "COWUSDT",
        allowedDirection: "LONG",
        tokenHash: `exact-${randomBytes(6).toString("hex")}`,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await revoke(`--id=${exact.id}`, "--confirm");

    expect(output()).toContain("BLOCKED");
    expect(process.exitCode).toBe(1);
    expect(
      (await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: exact.id } })).revokedAt
    ).toBeNull();
  });

  it("blocks cleanly when nothing is open", async () => {
    await revoke("--confirm");
    expect(output()).toContain("BLOCKED");
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describeDb("operator isolation", () => {
  it("never reaches the real MAINNET profile", async () => {
    expect(await prisma!.executionProfile.count({ where: { accountIdentifier: REAL_IDENTIFIER } })).toBe(0);
    expect(TEST_IDENTIFIER).not.toBe(REAL_IDENTIFIER);
  });
});

// ---------------------------------------------------------------------------
// Phase 12.4A review — arm-canary must NOT become natural-aware
// ---------------------------------------------------------------------------

describeDb("arm boundary", () => {
  const openNaturalWindow = () =>
    prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        allowedDirections: ["LONG", "SHORT"],
        maxClaims: 5,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

  it("refuses to arm on a natural window alone, even with everything else aligned", async () => {
    // Phase 4A deliberately did NOT generalize arm-canary. A prepared natural
    // window plus an aligned CANARY_POLICY must not add up to "armed": natural
    // live activation is a later, separately reviewed step.
    //
    // The mechanism is already fail-closed: arm compares the profile allowlist
    // against `active.allowedSymbol`, and a natural window's is null, so the
    // comparison can never match.
    await openNaturalWindow();
    argv("--confirm-arm");
    const { armCanary } = await loadControls();
    await armCanary();

    expect(output()).toContain("BLOCKED");
    expect(process.exitCode).toBe(1);

    // Nothing was armed: the profile stays disabled and the kill switch engaged.
    const profile = await prisma!.executionProfile.findUniqueOrThrow({ where: { id: profileId } });
    const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({
      where: { executionProfileId: profileId },
    });
    expect(profile.isEnabled).toBe(false);
    expect(policy.killSwitchActive).toBe(true);
  });

  it("spends no natural claim when arming is attempted", async () => {
    const window = await openNaturalWindow();
    argv("--confirm-arm");
    const { armCanary } = await loadControls();
    await armCanary();

    const after = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
    expect(after.claimedCount).toBe(0);
    expect(after.version).toBe(1);
    expect(after.revokedAt).toBeNull();
  });

  it("keeps arm-canary structurally unaware of natural mode", async () => {
    // Stronger than the behavioural cases: the command names no natural
    // concept at all, so it cannot acquire natural semantics by accident.
    const source = readFileSync(
      path.join(process.cwd(), "src", "modules", "execution", "run-canary-controls.ts"),
      "utf8"
    );
    const start = source.indexOf("export async function armCanary");
    const end = source.indexOf("export async function", start + 1);
    const arm = source.slice(start, end === -1 ? undefined : end);
    for (const forbidden of [
      "NATURAL_WINDOW",
      "prepareNaturalWindow",
      "revokeNaturalWindow",
      "findNaturalWindow",
      "claimNaturalWindow",
      "describeNaturalWindow",
      "allowedDirections",
      "maxClaims",
      "CANARY_NATURAL_MAX_CLAIMS",
    ]) {
      expect(`arm:${forbidden}:${arm.includes(forbidden)}`).toBe(`arm:${forbidden}:false`);
    }
  });

  it("does not let a natural preflight leak into a later arm", async () => {
    // No process-memory coupling: --mode is resolved per invocation and
    // persisted nowhere, so inspecting natural readiness cannot change what a
    // plain arm-canary does afterwards.
    const controls = await loadControls();
    const source = readFileSync(
      path.join(process.cwd(), "src", "modules", "execution", "run-canary-preflight.ts"),
      "utf8"
    );
    // The mode is a local const, never module-level state.
    expect(source).not.toMatch(/^let\s+mode/m);
    expect(source).not.toMatch(/globalThis|process\.env\[/);
    expect(typeof controls.armCanary).toBe("function");

    await openNaturalWindow();
    argv("--confirm-arm");
    await controls.armCanary();
    expect(output()).toContain("BLOCKED");
  });
});

// ---------------------------------------------------------------------------
// Phase 12.4A review — a mistyped confirmation can never write
// ---------------------------------------------------------------------------

describeDb("confirmation typo safety", () => {
  it.each([
    "--comfirm",
    "--confirm=true",
    "--confirm=1",
    "--confirmed",
    "-confirm",
    "--CONFIRM",
    "confirm",
  ])("prepare treats %s as NOT confirmed and writes nothing", async (flag) => {
    // Matching is exact string equality on "--confirm", so anything close but
    // wrong falls through to the dry run rather than to a write.
    argv("--directions=LONG", "--max-claims=5", flag);
    const { prepareNaturalWindow } = await loadControls();
    await prepareNaturalWindow();

    expect(output()).toContain("DRY RUN");
    expect(output()).toContain("NO DATABASE WRITE WAS PERFORMED");
    expect(await windowsOf()).toHaveLength(0);
  });

  it("revoke treats a mistyped confirmation as NOT confirmed", async () => {
    const window = await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        allowedDirections: ["LONG"],
        maxClaims: 5,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    argv("--comfirm");
    const { revokeNaturalWindow } = await loadControls();
    await revokeNaturalWindow();

    expect(output()).toContain("DRY RUN");
    expect(
      (await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } })).revokedAt
    ).toBeNull();
  });
});
