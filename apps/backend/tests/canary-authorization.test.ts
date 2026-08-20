import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * Phase 11B.0 — one-shot canary authorization, against a real Postgres.
 *
 * Everything uses test-owned profiles. The REAL profile
 * (`mainnet-canary-usdm`) is never read, prepared, armed or modified here, and
 * no Binance call of any kind is made.
 */

const TAG = "phase11b-auth";

// Integration state lives in the DEDICATED test database. The helper refuses
// to fall back to the runtime/canary database, so a misconfiguration fails the
// suite instead of quietly writing synthetic executions into runtime state.
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const {
  CanaryAuthorizationAlreadyActiveError,
  CanaryAuthorizationService,
  hashCanaryToken,
  describeAuthorization,
  describeAuthorizationSubject,
  describeAuthorizationWindow,
  isAuthorizationActive,
  isExactAuthorization,
} = await import("../src/modules/execution/canary-authorization.service");

const profileIds: string[] = [];
const alertIds: string[] = [];
let seq = 0;

async function newProfile(): Promise<string> {
  seq += 1;
  const profile = await prisma!.executionProfile.create({
    data: {
      name: `${TAG}-${seq}`,
      accountIdentifier: `${TAG}-${seq}-${Date.now().toString(36)}`,
      environment: "TESTNET",
    },
  });
  await prisma!.executionSafetyPolicy.create({ data: { executionProfileId: profile.id } });
  profileIds.push(profile.id);
  return profile.id;
}

async function newAlert(signal: "LONG" | "SHORT" = "LONG"): Promise<string> {
  seq += 1;
  const alert = await prisma!.alert.create({
    data: {
      symbol: "BTCUSDT", assetType: "CRYPTO", exchange: "SYNTHETIC", timeframe: "15m", price: 100,
      signal, indicatorName: `${TAG}-${seq}`, rawPayload: { note: TAG }, triggeredAt: new Date(),
    },
  });
  alertIds.push(alert.id);
  return alert.id;
}

const service = () => new CanaryAuthorizationService(prisma!);

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    await prisma.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: { in: profileIds } } });
    await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: { in: profileIds } } });
    await prisma.executionProfile.deleteMany({ where: { id: { in: profileIds } } });
    await prisma.alert.deleteMany({ where: { id: { in: alertIds } } });
  }
  await prisma.$disconnect();
});

const describeDb = available ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

describeDb("prepare", () => {
  it("creates one unconsumed authorization, normalizing the symbol", async () => {
    const profileId = await newProfile();
    const { authorization, token } = await service().prepare({
      executionProfileId: profileId, symbol: "  btcusdt ", direction: "LONG",
    });

    expect(token.length).toBeGreaterThan(20);
    expect(authorization.allowedSymbol).toBe("BTCUSDT");
    expect(authorization.allowedDirection).toBe("LONG");
    expect(authorization.consumedAt).toBeNull();
    expect(authorization.revokedAt).toBeNull();
    expect(authorization.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("stores only a hash, never the raw token", async () => {
    const profileId = await newProfile();
    const { authorization, token } = await service().prepare({
      executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG",
    });

    expect(authorization.tokenHash).toBe(hashCanaryToken(token));
    expect(authorization.tokenHash).not.toBe(token);
    expect(JSON.stringify(authorization)).not.toContain(token);
  });

  it("rejects a direction that is not LONG or SHORT", async () => {
    const profileId = await newProfile();
    await expect(
      service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "BOTH" as never })
    ).rejects.toThrow(/LONG or SHORT/);
  });

  it("sanitizes its status view", async () => {
    const profileId = await newProfile();
    const { authorization } = await service().prepare({
      executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG",
    });
    const status = describeAuthorization(authorization);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(authorization.tokenHash);
    expect(status).toMatchObject({ prepared: true, symbol: "BTCUSDT", direction: "LONG", consumed: false });
  });
});

// ---------------------------------------------------------------------------
// Active vs historical
// ---------------------------------------------------------------------------

describeDb("active/prepared semantics", () => {
  it("reports prepared=false for a REVOKED authorization, while keeping the record", async () => {
    const profileId = await newProfile();
    await service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" });
    await service().revokeUnused(profileId);

    const rows = await service().listForProfile(profileId);
    const status = describeAuthorizationWindow(rows);

    // The contradiction this replaces: prepared=true beside revoked=true.
    expect(status.prepared).toBe(false);
    expect(status.revoked).toBe(true);
    expect(status.activeCount).toBe(0);
    // History is never deleted.
    expect(status.onRecord).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it("reports prepared=false for an EXPIRED authorization", async () => {
    const profileId = await newProfile();
    const { authorization } = await service().prepare({
      executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG",
    });
    await prisma!.executionCanaryAuthorization.update({
      where: { id: authorization.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const status = describeAuthorizationWindow(await service().listForProfile(profileId));
    expect(status.prepared).toBe(false);
    expect(status.expired).toBe(true);
    expect(status.revoked).toBe(false);
    expect(status.activeCount).toBe(0);
    expect(status.onRecord).toBe(1);
  });

  it("reports prepared=false for a CONSUMED authorization", async () => {
    const profileId = await newProfile();
    const { token } = await service().prepare({
      executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG",
    });
    await service().consume({
      token, executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG", alertId: await newAlert(),
    });

    const status = describeAuthorizationWindow(await service().listForProfile(profileId));
    expect(status.prepared).toBe(false);
    expect(status.consumed).toBe(true);
    expect(status.activeCount).toBe(0);
    expect(status.onRecord).toBe(1);
  });

  it("reports prepared=true for exactly one valid active authorization", async () => {
    const profileId = await newProfile();
    await service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" });

    const status = describeAuthorizationWindow(await service().listForProfile(profileId));
    expect(status.prepared).toBe(true);
    expect(status.activeCount).toBe(1);
    expect(status.consumed).toBe(false);
    expect(status.revoked).toBe(false);
    expect(status.expired).toBe(false);
    expect(status.symbol).toBe("BTCUSDT");
  });

  it("keeps every historical record visible and shows the latest for context", async () => {
    const profileId = await newProfile();
    await service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" });
    await service().revokeUnused(profileId);
    await service().prepare({ executionProfileId: profileId, symbol: "ETHUSDT", direction: "SHORT" });
    await service().revokeUnused(profileId);

    const status = describeAuthorizationWindow(await service().listForProfile(profileId));
    expect(status.onRecord).toBe(2);
    expect(status.activeCount).toBe(0);
    expect(status.prepared).toBe(false);
    expect(status.latestIsHistoricalOnly).toBe(true);
    // The newest record is the one described.
    expect(status.symbol).toBe("ETHUSDT");
  });

  it("prefers the ACTIVE record over a newer inactive one when describing", async () => {
    const profileId = await newProfile();
    const { authorization: older } = await service().prepare({
      executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG",
    });
    // A newer row that is already revoked must not shadow the live one.
    await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        allowedSymbol: "ETHUSDT",
        allowedDirection: "SHORT",
        tokenHash: `synthetic-${Date.now()}`,
        expiresAt: new Date(Date.now() + 600_000),
        revokedAt: new Date(),
        createdAt: new Date(older.createdAt.getTime() + 1000),
      },
    });

    const status = describeAuthorizationWindow(await service().listForProfile(profileId));
    expect(status.prepared).toBe(true);
    expect(status.symbol).toBe("BTCUSDT");
    expect(status.activeCount).toBe(1);
    expect(status.onRecord).toBe(2);
  });

  it("agrees with the single definition of active", async () => {
    const profileId = await newProfile();
    const { authorization } = await service().prepare({
      executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG",
    });
    expect(isAuthorizationActive(authorization)).toBe(true);
    expect(isAuthorizationActive({ ...authorization, revokedAt: new Date() })).toBe(false);
    expect(isAuthorizationActive({ ...authorization, consumedAt: new Date() })).toBe(false);
    expect(isAuthorizationActive({ ...authorization, expiresAt: new Date(Date.now() - 1) })).toBe(false);
  });

  it("describes an empty history as nothing prepared", () => {
    const status = describeAuthorizationWindow([]);
    expect(status).toMatchObject({ prepared: false, activeCount: 0, onRecord: 0, symbol: null });
  });
});

// ---------------------------------------------------------------------------
// One active authorization at a time
// ---------------------------------------------------------------------------

describeDb("exclusive preparation", () => {
  it("refuses a second prepare while one is active", async () => {
    const profileId = await newProfile();
    await service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" });

    await expect(
      service().prepare({ executionProfileId: profileId, symbol: "ETHUSDT", direction: "LONG" })
    ).rejects.toThrow(/already exists/);

    // The first window is untouched — never silently replaced.
    const rows = await service().listForProfile(profileId);
    expect(rows).toHaveLength(1);
    expect(rows[0].allowedSymbol).toBe("BTCUSDT");
    expect(rows[0].revokedAt).toBeNull();
  });

  it("carries the operator reason code and points at disarm", async () => {
    const profileId = await newProfile();
    await service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" });

    await service()
      .prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" })
      .then(() => expect.unreachable("a second prepare must not succeed"))
      .catch((error) => {
        expect(error).toBeInstanceOf(CanaryAuthorizationAlreadyActiveError);
        expect(error.reasonCode).toBe("CANARY_AUTHORIZATION_ALREADY_ACTIVE");
        expect(error.message).toContain("execution:disarm-canary");
      });
  });

  it("allows a fresh prepare once the previous one is revoked", async () => {
    const profileId = await newProfile();
    await service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" });
    await service().revokeUnused(profileId);

    const second = await service().prepare({ executionProfileId: profileId, symbol: "ETHUSDT", direction: "SHORT" });
    expect(second.authorization.allowedSymbol).toBe("ETHUSDT");
    expect(await service().countActive(profileId)).toBe(1);
    // Both records survive.
    expect(await service().listForProfile(profileId)).toHaveLength(2);
  });

  it("allows a fresh prepare once the previous one has expired", async () => {
    const profileId = await newProfile();
    const { authorization } = await service().prepare({
      executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG",
    });
    await prisma!.executionCanaryAuthorization.update({
      where: { id: authorization.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // Expiry is time-based, which is why a partial unique index cannot express
    // this rule and the advisory lock does.
    await expect(
      service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" })
    ).resolves.toBeTruthy();
    expect(await service().countActive(profileId)).toBe(1);
  });

  it("never produces two active authorizations under concurrent prepares", async () => {
    const profileId = await newProfile();
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        service().prepare({
          executionProfileId: profileId,
          symbol: index % 2 === 0 ? "BTCUSDT" : "ETHUSDT",
          direction: "LONG",
        })
      )
    );

    const fulfilled = attempts.filter((entry) => entry.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(await service().countActive(profileId)).toBe(1);
    expect(await service().listForProfile(profileId)).toHaveLength(1);
  });

  it("keeps profiles independent", async () => {
    const first = await newProfile();
    const second = await newProfile();
    await service().prepare({ executionProfileId: first, symbol: "BTCUSDT", direction: "LONG" });

    // A window on one profile must not block a different profile.
    await expect(
      service().prepare({ executionProfileId: second, symbol: "BTCUSDT", direction: "LONG" })
    ).resolves.toBeTruthy();
    expect(await service().countActive(first)).toBe(1);
    expect(await service().countActive(second)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Authorization matching
// ---------------------------------------------------------------------------

describeDb("authorization matching", () => {
  async function prepared(direction: "LONG" | "SHORT" = "LONG", symbol = "BTCUSDT") {
    const profileId = await newProfile();
    const { token, authorization } = await service().prepare({ executionProfileId: profileId, symbol, direction });
    return { profileId, token, authorization };
  }

  it("accepts the correct symbol and direction", async () => {
    const { profileId, token } = await prepared();
    const result = await service().consume({
      token, executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG", alertId: await newAlert(),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects the wrong symbol", async () => {
    const { profileId, token } = await prepared();
    const result = await service().consume({
      token, executionProfileId: profileId, symbol: "ETHUSDT", direction: "LONG", alertId: await newAlert(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("CANARY_AUTHORIZATION_WRONG_SYMBOL");
  });

  it("rejects SHORT when LONG was authorized", async () => {
    const { profileId, token } = await prepared("LONG");
    const result = await service().consume({
      token, executionProfileId: profileId, symbol: "BTCUSDT", direction: "SHORT", alertId: await newAlert("SHORT"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("CANARY_AUTHORIZATION_WRONG_DIRECTION");
  });

  it("rejects a missing token", async () => {
    const { profileId } = await prepared();
    for (const token of [null, undefined, ""]) {
      const result = await service().consume({
        token, executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG", alertId: await newAlert(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe("CANARY_AUTHORIZATION_MISSING");
    }
  });

  it("rejects an unknown token", async () => {
    const { profileId } = await prepared();
    const result = await service().consume({
      token: "not-a-real-authorization", executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG", alertId: await newAlert(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("CANARY_AUTHORIZATION_UNKNOWN");
  });

  it("rejects an expired authorization", async () => {
    const profileId = await newProfile();
    const { token, authorization } = await service().prepare({
      executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG",
    });
    await prisma!.executionCanaryAuthorization.update({
      where: { id: authorization.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const result = await service().consume({
      token, executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG", alertId: await newAlert(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("CANARY_AUTHORIZATION_EXPIRED");
  });

  it("rejects a revoked authorization", async () => {
    const { profileId, token } = await prepared();
    await service().revokeUnused(profileId);
    const result = await service().consume({
      token, executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG", alertId: await newAlert(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("CANARY_AUTHORIZATION_REVOKED");
  });

  it("rejects an authorization belonging to another profile", async () => {
    const { token } = await prepared();
    const otherProfile = await newProfile();
    const result = await service().consume({
      token, executionProfileId: otherProfile, symbol: "BTCUSDT", direction: "LONG", alertId: await newAlert(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("CANARY_AUTHORIZATION_WRONG_PROFILE");
  });
});

// ---------------------------------------------------------------------------
// One-shot semantics
// ---------------------------------------------------------------------------

describeDb("one-shot consumption", () => {
  it("cannot authorize a second, different signal", async () => {
    const profileId = await newProfile();
    const { token } = await service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" });

    const first = await service().consume({
      token, executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG", alertId: await newAlert(),
    });
    const second = await service().consume({
      token, executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG", alertId: await newAlert(),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reasonCode).toBe("CANARY_AUTHORIZATION_ALREADY_CONSUMED");
  });

  it("treats a redelivery of the SAME alert as a replay, not a second use", async () => {
    const profileId = await newProfile();
    const { token } = await service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" });
    const alertId = await newAlert();

    const first = await service().consume({ token, executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG", alertId });
    const replay = await service().consume({ token, executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG", alertId });

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.replay).toBe(true);
    // Still exactly one binding.
    const row = await prisma!.executionCanaryAuthorization.findFirstOrThrow({ where: { executionProfileId: profileId } });
    expect(row.consumedAlertId).toBe(alertId);
  });

  it("admits at most one of five concurrent DIFFERENT signals", async () => {
    const profileId = await newProfile();
    const { token } = await service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" });
    const alerts = await Promise.all([newAlert(), newAlert(), newAlert(), newAlert(), newAlert()]);

    const results = await Promise.all(
      alerts.map((alertId) =>
        service().consume({ token, executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG", alertId })
      )
    );

    // The guarantee is a conditional updateMany, not an in-memory flag.
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(4);
    const row = await prisma!.executionCanaryAuthorization.findFirstOrThrow({ where: { executionProfileId: profileId } });
    expect(alerts).toContain(row.consumedAlertId);
  });

  it("keeps the binding after a crash, and still refuses a different signal", async () => {
    const profileId = await newProfile();
    const { token } = await service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" });
    const boundAlert = await newAlert();
    await service().consume({ token, executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG", alertId: boundAlert });

    // "Crash": a completely fresh service object over the same durable rows.
    const afterRestart = new CanaryAuthorizationService(prisma!);
    const sameSignal = await afterRestart.consume({
      token, executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG", alertId: boundAlert,
    });
    const otherSignal = await afterRestart.consume({
      token, executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG", alertId: await newAlert(),
    });

    // The intended execution stays recoverable...
    expect(sameSignal.ok).toBe(true);
    // ...but the authorization is not transferable.
    expect(otherSignal.ok).toBe(false);
  });

  it("finds no active authorization once consumed", async () => {
    const profileId = await newProfile();
    const { token } = await service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" });
    expect(await service().findActive(profileId)).not.toBeNull();

    await service().consume({ token, executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG", alertId: await newAlert() });
    expect(await service().findActive(profileId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Boundary
// ---------------------------------------------------------------------------

describe("canary control boundary", () => {
  const BACKEND = process.cwd();
  const CONTROLS = path.join(BACKEND, "src", "modules", "execution", "run-canary-controls.ts");
  const SERVICE = path.join(BACKEND, "src", "modules", "execution", "canary-authorization.service.ts");

  const readCode = (file: string) =>
    readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("offers no force or skip-safety path", () => {
    const source = readCode(CONTROLS);
    for (const forbidden of ["--force", "--skip-safety", "--ignore-preflight", "--ignore-position", "--ignore-orders", "--disable-protection"]) {
      expect(`${forbidden}:${source.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("cannot select an arbitrary profile", () => {
    const source = readCode(CONTROLS);
    // Always the configured identity; never a --profile-id argument.
    expect(source).toContain("configuredProfileIdentity()");
    expect(source).not.toContain("--profile-id");
    expect(source).not.toMatch(/arg\(\s*"profile/);
  });

  it("never edits the environment", () => {
    const source = readCode(CONTROLS);
    // It READS gates (and tells the operator to edit .env by hand); it must
    // never write a file or mutate process.env itself.
    for (const forbidden of ["writeFileSync", "appendFileSync", "node:fs", 'from "fs"', "process.env ="]) {
      expect(`${forbidden}:${source.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    expect(source).not.toMatch(/process\.env\.\w+\s*=[^=]/);
  });

  it("sends nothing to Binance", () => {
    for (const file of [CONTROLS, SERVICE]) {
      const source = readCode(file);
      for (const forbidden of ["fetch(", "fapi/", "binance-execution", "BinanceUsdM", "sapi/"]) {
        expect(`${path.basename(file)}:${forbidden}:${source.includes(forbidden)}`).toBe(
          `${path.basename(file)}:${forbidden}:false`
        );
      }
    }
  });

  it("never logs the token", () => {
    const source = readCode(SERVICE);
    for (const call of [...source.matchAll(/logger\.\w+\(([\s\S]{0,200}?)\)/g)].map((m) => m[1])) {
      expect(call).not.toContain("token");
    }
    // The controls print the token exactly once, deliberately, to stdout.
    expect(readCode(CONTROLS).match(/\$\{token\}/g) ?? []).toHaveLength(1);
  });

  it("exposes no HTTP or Telegram arm surface", () => {
    const app = readFileSync(path.join(BACKEND, "src", "app.ts"), "utf8");
    for (const forbidden of ["canary", "arm", "authorization"]) {
      expect(`${forbidden}:${app.toLowerCase().includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("strips the authorization from the persisted webhook payload", () => {
    const webhook = readFileSync(path.join(BACKEND, "src", "modules", "webhook", "webhook.service.ts"), "utf8");
    // rawPayload is rendered verbatim on the alert page, so the token must not
    // survive into it.
    expect(webhook).toContain("canaryAuthorization: _canary");
  });

  it("requires an explicit confirmation flag to arm, and none to reach safety", () => {
    const source = readFileSync(CONTROLS, "utf8");
    expect(source).toContain("--confirm-arm");
    // Bounded to the FUNCTION, not to end-of-file. Phase 12.4A appended the
    // natural-window commands after disarmCanary, and those legitimately take
    // --confirm: preparing a window is a write. What must stay true is that the
    // two EMERGENCY paths — close-window and disarm — need no flag at all, so an
    // operator can reach safety in a hurry.
    const disarmStart = source.indexOf("export async function disarmCanary");
    const afterDisarm = source.indexOf("export async function", disarmStart + 1);
    const disarm = source.slice(disarmStart, afterDisarm === -1 ? undefined : afterDisarm);
    const close = source.slice(source.indexOf("export async function closeCanaryWindow"), disarmStart);
    expect(disarm).not.toContain("--confirm");
    expect(close).not.toContain("--confirm");
    // ...and the natural WRITE commands DO require confirmation, through the
    // shared CONFIRM constant rather than a scattered literal.
    expect(source).toContain('const CONFIRM = "--confirm";');
    for (const fn of ["prepareNaturalWindow", "revokeNaturalWindow"]) {
      const start = source.indexOf(`export async function ${fn}`);
      const end = source.indexOf("export async function", start + 1);
      const body = source.slice(start, end === -1 ? undefined : end);
      expect(`${fn}:${body.includes("process.argv.includes(CONFIRM)")}`).toBe(`${fn}:true`);
    }
    // The read-only inspector must NOT ask for confirmation — it writes nothing.
    const show = source.slice(source.indexOf("export async function showAuthorization"));
    expect(show.slice(0, show.indexOf("export async function", 1))).not.toContain("CONFIRM");
  });

  it("never widens the symbol allowlist back to allow-all", () => {
    const source = readCode(CONTROLS);
    expect(source).not.toMatch(/allowedSymbols:\s*\[\s*\]/);
  });

  it("wires each CLI entrypoint to its command with no arguments at all", () => {
    for (const [file, fn] of [
      ["run-prepare-canary.ts", "prepareCanary"],
      ["run-arm-canary.ts", "armCanary"],
      ["run-close-canary-window.ts", "closeCanaryWindow"],
      ["run-disarm-canary.ts", "disarmCanary"],
      ["run-prepare-natural-window.ts", "prepareNaturalWindow"],
      ["run-show-authorization.ts", "showAuthorization"],
      ["run-revoke-natural-window.ts", "revokeNaturalWindow"],
    ]) {
      const source = readFileSync(path.join(BACKEND, "src", "modules", "execution", file), "utf8");
      // No injected profile, no injected preflight — the command always
      // resolves the configured identity itself.
      expect(source).toContain(`${fn}()`);
    }
  });

  it("keeps the authorization as an ADDITIONAL guard, never a bypass", () => {
    const source = readCode(path.join(BACKEND, "src", "modules", "execution", "selected-plan-executor.ts"));

    // The authorization check only ever refuses; it grants nothing. The block
    // ends where Phase 3 planning begins — anchored on the planner call, which
    // is stable, rather than on a local variable name.
    //
    // Phase 12.3 renamed the opening variable `canaryMode` ->
    // `authorizationsOnRecord`, because it no longer means "exact-only mode":
    // it means "this profile is authorization-controlled", which may now be
    // satisfied by an exact binding OR a natural window. The assertions below
    // are unchanged — only the anchor moved.
    const blockStart = source.indexOf("const authorizationsOnRecord");
    expect(blockStart).toBeGreaterThan(0);
    const blockEnd = source.indexOf("this.deps.marginPlanner");
    expect(blockEnd).toBeGreaterThan(0);
    const block = source.slice(blockStart, blockEnd);
    expect(block).toContain("handled: false");
    expect(block).not.toContain("handled: true");
    expect(block).not.toMatch(/allowDisabledProfile|killSwitch|bypass|skip/i);

    // The precheck reads the window; it must never spend a claim. The claim
    // belongs to SafetyAdmission, inside its transaction, and nowhere else.
    expect(block).not.toContain("claimNaturalWindow");
    expect(block).not.toContain("claimedCount");
    expect(block).not.toMatch(/\.update|\.updateMany|\.create\(/);

    // Admission still runs afterwards, unconditionally.
    expect(source).toContain("this.deps.orchestrator.admitAndSubmit({ executionId })");
    expect(source.indexOf("admitAndSubmit")).toBeGreaterThan(blockStart);
  });

  it("runs where the real canary profile does not exist", async () => {
    if (!available) return;
    // Isolation, proven rather than asserted after the fact: this suite runs
    // against the dedicated test database, so the real profile is not reachable
    // from it at all.
    expect(await prisma!.executionProfile.count({ where: { accountIdentifier: "mainnet-canary-usdm" } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 12.1 — the authorization-type discriminator (SCHEMA ONLY)
// ---------------------------------------------------------------------------

/**
 * `ExecutionCanaryAuthorization` can now describe two shapes. Phase 12.1 adds
 * only the representation: nothing creates, reads or admits a NATURAL_WINDOW.
 *
 * The property these tests defend is backward compatibility. Real authorization
 * rows exist on MAINNET and every one of them must keep meaning exactly what it
 * meant before the column existed — which is a claim about a DEFAULT, so it is
 * tested against a real database rather than a mock.
 */
describeDb("authorization type: exact-mode compatibility", () => {
  it("A. prepare still creates an EXACT_SIGNAL authorization", async () => {
    const profileId = await newProfile();
    const { authorization } = await service().prepare({
      executionProfileId: profileId,
      symbol: "BTCUSDT",
      direction: "LONG",
    });

    expect(authorization.authorizationType).toBe("EXACT_SIGNAL");
    // The three fields that mode requires are all present and unchanged.
    expect(authorization.allowedSymbol).toBe("BTCUSDT");
    expect(authorization.allowedDirection).toBe("LONG");
    expect(authorization.tokenHash).not.toBeNull();
    // ...and none of the natural-window fields carry anything.
    expect(authorization.allowedDirections).toEqual([]);
    expect(authorization.maxClaims).toBeNull();
    expect(authorization.claimedCount).toBe(0);
    expect(authorization.version).toBe(1);
  });

  it("F. defaults to EXACT_SIGNAL for a row that never named a mode", async () => {
    // The historical case, reproduced exactly: an INSERT listing only the
    // columns that existed before this phase. Without the default this write
    // would fail outright; with a different default the assertion below
    // catches it. That is the whole point of the test.
    const profileId = await newProfile();
    const id = `legacy-${Date.now().toString(36)}`;
    await prisma!.$executeRawUnsafe(`
      INSERT INTO "ExecutionCanaryAuthorization"
        ("id","executionProfileId","allowedSymbol","allowedDirection","tokenHash","expiresAt","createdAt")
      VALUES ('${id}','${profileId}','ETHUSDT','SHORT','${id}-hash', NOW() + interval '1 hour', NOW())`);

    const row = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id } });
    expect(row.authorizationType).toBe("EXACT_SIGNAL");
    // Nothing about the historical row was rewritten...
    expect(row.allowedSymbol).toBe("ETHUSDT");
    expect(row.allowedDirection).toBe("SHORT");
    expect(row.tokenHash).toBe(`${id}-hash`);
    // ...and it acquired the inert defaults, not a usable window.
    expect(row.allowedDirections).toEqual([]);
    expect(row.maxClaims).toBeNull();
    expect(row.claimedCount).toBe(0);
    expect(row.version).toBe(1);
    // Such a row is a fully usable exact authorization, exactly as before.
    expect(isExactAuthorization(row)).toBe(true);
  });

  it("G. exposes the natural-window fields without populating them", async () => {
    const profileId = await newProfile();
    const { authorization } = await service().prepare({
      executionProfileId: profileId,
      symbol: "BTCUSDT",
      direction: "LONG",
    });

    // Representable at the Prisma level — the schema really did change...
    for (const field of ["allowedDirections", "maxClaims", "claimedCount", "version"]) {
      expect(Object.keys(authorization)).toContain(field);
    }
    // ...while an empty direction set and an absent budget admit nothing.
    expect(authorization.allowedDirections).toHaveLength(0);
    expect(authorization.maxClaims).toBeNull();
  });

  it("H. can persist a NATURAL_WINDOW row that no production code can use", async () => {
    // Proves the schema is capable and the runtime is not. Written directly
    // through Prisma because NO service method creates one.
    const profileId = await newProfile();
    const window = await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        allowedDirections: ["LONG", "SHORT"],
        maxClaims: 5,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    expect(window.tokenHash).toBeNull();
    expect(window.allowedSymbol).toBeNull();
    expect(window.allowedDirection).toBeNull();
    expect(window.allowedDirections).toEqual(["LONG", "SHORT"]);
    expect(window.maxClaims).toBe(5);
    expect(window.claimedCount).toBe(0);
    expect(window.version).toBe(1);

    // The exact reader refuses it — it is not a usable exact authorization...
    expect(isExactAuthorization(window)).toBe(false);
    // ...and no token can reach it, because it has no hash to look up.
    const byToken = await service().consume({
      token: "anything-at-all",
      executionProfileId: profileId,
      symbol: "BTCUSDT",
      direction: "LONG",
      alertId: await newAlert(),
    });
    expect(byToken.ok).toBe(false);
    if (!byToken.ok) expect(byToken.reasonCode).toBe("CANARY_AUTHORIZATION_UNKNOWN");
  });

  it("H. lets many tokenless windows coexist under the UNIQUE tokenHash index", async () => {
    // PostgreSQL treats NULLs as distinct, so relaxing the column did not cost
    // the one-token-one-row guarantee exact mode depends on.
    const profileId = await newProfile();
    const make = () =>
      prisma!.executionCanaryAuthorization.create({
        data: {
          executionProfileId: profileId,
          authorizationType: "NATURAL_WINDOW",
          allowedDirections: ["LONG"],
          maxClaims: 1,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });

    await expect(Promise.all([make(), make(), make()])).resolves.toHaveLength(3);

    // The uniqueness that DOES still bite: two rows cannot share a real hash.
    const hash = `dup-${Date.now().toString(36)}`;
    const exact = () =>
      prisma!.executionCanaryAuthorization.create({
        data: {
          executionProfileId: profileId,
          allowedSymbol: "BTCUSDT",
          allowedDirection: "LONG",
          tokenHash: hash,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
    await exact();
    await expect(exact()).rejects.toThrow();
  });

  it("D. refuses a token whose row declares EXACT_SIGNAL but is missing a field", async () => {
    // Synthetic and impossible through any service call: the row claims a mode
    // it does not honour. Reaching it needs a real tokenHash, which is what
    // makes the structural check observable here.
    const profileId = await newProfile();
    const token = `broken-${Date.now().toString(36)}`;
    const id = `broken-row-${Date.now().toString(36)}`;
    await prisma!.executionCanaryAuthorization.create({
      data: {
        id,
        executionProfileId: profileId,
        authorizationType: "EXACT_SIGNAL",
        // allowedSymbol deliberately absent.
        allowedDirection: "LONG",
        tokenHash: hashCanaryToken(token),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const outcome = await service().consume({
      token,
      executionProfileId: profileId,
      symbol: "BTCUSDT",
      direction: "LONG",
      alertId: await newAlert(),
    });

    expect(outcome.ok).toBe(false);
    // Reported as structurally invalid, NOT as a symbol mismatch: a null is
    // not "some other symbol", and an operator needs to be told which it is.
    if (!outcome.ok) expect(outcome.reasonCode).toBe("CANARY_AUTHORIZATION_NOT_EXACT");
    // Nothing was bound, so the row cannot become usable by having been tried.
    expect((await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id } })).consumedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 12.1 — exact-row assertion, and runtime inertness
// ---------------------------------------------------------------------------

describe("exact-row assertion", () => {
  const base = {
    id: "a",
    executionProfileId: "p",
    authorizationType: "EXACT_SIGNAL",
    allowedSymbol: "BTCUSDT",
    allowedDirection: "LONG",
    tokenHash: "hash",
    allowedDirections: [],
    maxClaims: null,
    claimedCount: 0,
    version: 1,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    consumedAt: null,
    consumedAlertId: null,
    consumedExecutionId: null,
    revokedAt: null,
  } as never;

  it("accepts a complete EXACT_SIGNAL row", () => {
    expect(isExactAuthorization(base)).toBe(true);
  });

  it.each([
    ["symbol", { allowedSymbol: null }],
    ["direction", { allowedDirection: null }],
    ["token hash", { tokenHash: null }],
  ])("fails closed when an EXACT_SIGNAL row is missing its %s", (_label, override) => {
    expect(isExactAuthorization({ ...(base as object), ...override } as never)).toBe(false);
  });

  it("reads the discriminator, never the populated columns", () => {
    // A row carrying every exact field is STILL not exact if it says it is not.
    // The alternative — inferring the mode from which columns happen to be
    // filled in — is what would let a malformed window pass as authorization.
    expect(isExactAuthorization({ ...(base as object), authorizationType: "NATURAL_WINDOW" } as never)).toBe(false);
    // And a natural-shaped row is not rescued by its natural fields.
    expect(
      isExactAuthorization({
        ...(base as object),
        authorizationType: "NATURAL_WINDOW",
        allowedSymbol: null,
        allowedDirection: null,
        tokenHash: null,
        allowedDirections: ["LONG", "SHORT"],
        maxClaims: 5,
      } as never)
    ).toBe(false);
  });

  it("describes a non-exact row by its mode rather than as 'null null'", () => {
    expect(describeAuthorizationSubject(base)).toBe("BTCUSDT LONG");
    expect(
      describeAuthorizationSubject({
        ...(base as object),
        authorizationType: "NATURAL_WINDOW",
        allowedSymbol: null,
      } as never)
    ).toBe("NATURAL_WINDOW");
  });
});

describe("natural authorization: runtime boundary", () => {
  const BACKEND = process.cwd();
  const SRC = path.join(BACKEND, "src");

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(dir, entry.name))
        : entry.name.endsWith(".ts")
          ? [path.join(dir, entry.name)]
          : []
    );

  /** Production source with comments removed — intent lives in code, not prose. */
  const productionCode = walk(SRC).map((file) => ({
    file: path.relative(BACKEND, file).replace(/\\/g, "/"),
    code: readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
  }));

  const codeOf = (file: string) => productionCode.find((entry) => entry.file === file)!.code;

  /**
   * ## Why the Phase-12.2 assertions here were REPLACED, not extended
   *
   * Phase 12.2 asserted that NO execution entrypoint imported the natural
   * module, called any natural primitive, or named NATURAL_WINDOW. That was the
   * correct pin while natural mode was inert: it stated "this cannot change
   * live execution behaviour", and it was true.
   *
   * Phase 12.3 is precisely the change those assertions forbade. Keeping them
   * would have been keeping a test that says the feature must not exist, which
   * no amount of correct implementation can satisfy — so they are replaced
   * rather than loosened.
   *
   * What replaces them is narrower and, for a real-money system, stronger: the
   * dependency is now permitted in exactly TWO production files and forbidden
   * everywhere else. Specifically:
   *
   *   REPLACED  "keeps every execution entrypoint free of the natural-window
   *             module"            -> ALLOWED/FORBIDDEN split below
   *   REPLACED  "calls no natural primitive from any execution entrypoint"
   *                                -> "the claim exists in exactly one place"
   *   REPLACED  "confines the natural primitives to the two Phase-12 modules"
   *                                -> confined to the FOUR modules, named
   *   REPLACED  "leaves the canary-mode predicate exactly as it was"
   *                                -> the predicate is now type-aware by
   *                                   design; what is pinned instead is that
   *                                   historical rows still gate the profile
   *   REPLACED  "keeps safety admission free of authorization entirely"
   *                                -> admission OWNS authorization; the engine
   *                                   stays pure instead
   *   KEPT      the domain module's purity and Option-B boundary, unchanged
   */

  /** The only production files permitted to know natural authorization exists. */
  const ALLOWED = [
    // The RUNTIME half (Phase 12.2/12.3): these can admit and claim.
    "src/modules/execution/natural-authorization.ts",
    "src/modules/execution/canary-authorization.service.ts",
    "src/modules/execution/selected-plan-executor.ts",
    "src/modules/execution/safety-admission.service.ts",
    // The OPERATOR READ/PREPARE half (Phase 12.4A): these prepare, inspect,
    // revoke and report. None of them admits, claims or executes anything, so
    // they widen what an operator can SEE without widening what the runtime DOES.
    "src/modules/execution/run-canary-controls.ts",
    "src/modules/execution/run-prepare-natural-window.ts",
    "src/modules/execution/run-show-authorization.ts",
    "src/modules/execution/run-revoke-natural-window.ts",
    "src/modules/execution/run-canary-preflight.ts",
    // PRIVILEGED OPERATOR ACTIVATION (Phase 12.4C). These are a DIFFERENT
    // category from everything above: arming opens a real-money profile for
    // admission, so it is a state-changing control, NOT an inspection one. It
    // earns its place on this list not by being harmless but by being bounded —
    // it never claims, never writes the authorization row, never reaches the
    // exchange, and writes exactly two profile/policy fields, all pinned
    // structurally in natural-arm.integration.test.ts. It reads the natural
    // domain classifier for the same reason the inspector does.
    "src/modules/execution/natural-arm.ts",
    "src/modules/execution/run-arm-natural-window.ts",
    "src/modules/execution/canary-readiness.ts",
    "src/modules/execution/canary-preflight.service.ts",
  ];

  /**
   * Files that must stay ignorant of it. Protection and reconciliation are the
   * load-bearing entries: authorization gates NEW admission only, so a window
   * expiring must never be able to stop a live position being protected.
   */
  const FORBIDDEN = [
    "src/modules/execution/safety-engine.ts",
    "src/modules/execution/execution-orchestrator.ts",
    "src/modules/execution/capacity-status.ts",
    "src/modules/execution/entry-lifecycle.ts",
    "src/modules/execution/entry-lifecycle.service.ts",
    "src/modules/execution/protection-lifecycle.ts",
    "src/modules/execution/protection-lifecycle.service.ts",
    "src/modules/execution/execution.service.ts",
    "src/modules/webhook/webhook.service.ts",
    "src/modules/webhook/webhook.schema.ts",
    "src/modules/jobs/vision-analysis.worker.ts",
  ];

  const NATURAL_SYMBOLS = [
    "natural-authorization",
    "claimNaturalWindow",
    "prepareNaturalWindow",
    "revokeNaturalWindow",
    "findNaturalWindow",
    "naturalWindowAdmitsDirection",
    "naturalWindowState",
    "isNaturalWindowAvailable",
    "NATURAL_WINDOW",
  ];

  it("keeps protection, reconciliation and the webhook ignorant of authorization", () => {
    for (const file of FORBIDDEN) {
      for (const symbol of NATURAL_SYMBOLS) {
        expect(`${file}:${symbol}:${codeOf(file).includes(symbol)}`).toBe(`${file}:${symbol}:false`);
      }
    }
  });

  it("keeps the pure safety engine free of any authorization concept", () => {
    // The engine gains the reason CODES (it owns the catalogue) but must never
    // read a window: it has no Prisma client and no lock, so an authorization
    // decision taken there could not be atomic with the claim.
    const engine = codeOf("src/modules/execution/safety-engine.ts");
    for (const forbidden of ["executionCanaryAuthorization", "claimNaturalWindow", "natural-authorization"]) {
      expect(`${forbidden}:${engine.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("confines every natural symbol to the four permitted modules", () => {
    for (const symbol of NATURAL_SYMBOLS) {
      const offenders = productionCode
        .filter((entry) => entry.code.includes(symbol) && !ALLOWED.includes(entry.file))
        .map((entry) => entry.file);
      expect(`${symbol}: ${offenders.join(", ")}`).toBe(`${symbol}: `);
    }
  });

  it("spends the claim in EXACTLY one production place", () => {
    // The single most important structural fact in Phase 3: one call site, and
    // it is inside the transaction that also reserves capacity.
    // Call sites only — the `export async function claimNaturalWindow(` in the
    // Phase-2 service is the definition, not a caller.
    const callers = productionCode.filter((entry) =>
      /(?<!function\s)claimNaturalWindow\s*\(/.test(entry.code.replace(/export async function claimNaturalWindow/g, ""))
    );
    expect(callers.map((entry) => entry.file)).toEqual(["src/modules/execution/safety-admission.service.ts"]);

    const admission = codeOf("src/modules/execution/safety-admission.service.ts");
    // It is passed the TRANSACTION client, not the service-level client, so it
    // commits or rolls back with the reservation.
    expect(admission).toMatch(/claimNaturalWindow\(tx,/);
    // And it opens no transaction of its own beside the admission one.
    expect((admission.match(/\$transaction/g) ?? []).length).toBe(1);
  });

  it("never claims from the selected-plan precheck", () => {
    // The precheck runs before margin planning, so a claim there could be spent
    // on a plan that is about to be rejected — and claims are never refunded.
    const executor = codeOf("src/modules/execution/selected-plan-executor.ts");
    expect(executor).not.toContain("claimNaturalWindow");
    expect(executor).not.toContain("claimedCount");
    // It reads the window and nothing else: no write to the authorization table
    // beyond the pre-existing exact `consumedExecutionId` binding.
    const authorizationWrites = [...executor.matchAll(/executionCanaryAuthorization\.(\w+)/g)].map((m) => m[1]);
    expect(authorizationWrites.sort()).toEqual(["count", "findFirst", "findFirst", "updateMany"]);
  });

  it("still requires authorization for a profile with only historical rows", () => {
    // The predicate became type-aware, but its GATE did not move: any row on
    // record still means the profile is authorization-controlled. A profile
    // whose windows have all been consumed or revoked does not become open.
    const executor = codeOf("src/modules/execution/selected-plan-executor.ts");
    expect(executor).toContain("const authorizationsOnRecord = await");
    expect(executor).toContain("if (authorizationsOnRecord > 0) {");
    // Counting is still unfiltered — history counts, exactly as before.
    const predicate = executor.slice(
      executor.indexOf("const authorizationsOnRecord"),
      executor.indexOf("if (authorizationsOnRecord > 0)")
    );
    for (const forbidden of ["authorizationType", "revokedAt", "expiresAt", "consumedAt"]) {
      expect(`${forbidden}:${predicate.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("keeps the natural domain free of symbol, watchlist and exchange authority", () => {
    // The locked Option-B boundary, asserted on the module itself: a natural
    // window authorizes PROFILE + DIRECTION + TIME + BUDGET, never a ticker.
    const domain = codeOf("src/modules/execution/natural-authorization.ts");
    for (const forbidden of [
      "allowedSymbols",
      "Asset",
      "watchlist",
      "exchangeInfo",
      "BinanceReadOnly",
      "symbol",
      "fetch(",
    ]) {
      expect(`${forbidden}:${domain.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }

    // Purity, stated precisely: the module may import TYPES from @prisma/client
    // (CanaryDirection, ExecutionCanaryAuthorization) but must issue no query
    // and hold no client. The import it does have is `import type`.
    expect(domain).toContain('import type { CanaryDirection, ExecutionCanaryAuthorization } from "@prisma/client"');
    for (const forbidden of [
      "PrismaClient",
      "TransactionClient",
      "prisma.",
      "$transaction",
      "findFirst",
      "findMany",
      "findUnique",
      "updateMany",
      "create(",
    ]) {
      expect(`${forbidden}:${domain.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // And no clock read — every function takes `now` from its caller.
    expect(domain).not.toMatch(/new Date\(\s*\)/);
  });

  it("reads the window under the advisory lock, never before it", () => {
    // Ordering is the correctness argument: a window read before the lock could
    // be claimed by a concurrent admission between the read and the update.
    const admission = codeOf("src/modules/execution/safety-admission.service.ts");
    const lock = admission.indexOf("pg_advisory_xact_lock");
    const resolve = admission.indexOf("resolveAdmissionAuthorization(tx");
    const claim = admission.indexOf("claimNaturalWindow(tx");
    expect(lock).toBeGreaterThan(0);
    expect(resolve).toBeGreaterThan(lock);
    expect(claim).toBeGreaterThan(resolve);
  });
});
