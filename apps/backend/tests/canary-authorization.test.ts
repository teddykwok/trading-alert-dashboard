import { readFileSync } from "node:fs";
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

const { CanaryAuthorizationService, hashCanaryToken, describeAuthorization } = await import(
  "../src/modules/execution/canary-authorization.service"
);

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
    const disarm = source.slice(source.indexOf("export async function disarmCanary"));
    const close = source.slice(source.indexOf("export async function closeCanaryWindow"), source.indexOf("export async function disarmCanary"));
    expect(disarm).not.toContain("--confirm");
    expect(close).not.toContain("--confirm");
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
    ]) {
      const source = readFileSync(path.join(BACKEND, "src", "modules", "execution", file), "utf8");
      // No injected profile, no injected preflight — the command always
      // resolves the configured identity itself.
      expect(source).toContain(`${fn}()`);
    }
  });

  it("keeps the authorization as an ADDITIONAL guard, never a bypass", () => {
    const source = readCode(path.join(BACKEND, "src", "modules", "execution", "selected-plan-executor.ts"));

    // The canary check only ever refuses; it grants nothing.
    const block = source.slice(source.indexOf("const canaryMode"), source.indexOf("const marginPlan"));
    expect(block).toContain("handled: false");
    expect(block).not.toContain("handled: true");
    expect(block).not.toMatch(/allowDisabledProfile|killSwitch|bypass|skip/i);

    // Admission still runs afterwards, unconditionally.
    expect(source).toContain("this.deps.orchestrator.admitAndSubmit({ executionId })");
    expect(source.indexOf("admitAndSubmit")).toBeGreaterThan(source.indexOf("const canaryMode"));
  });

  it("runs where the real canary profile does not exist", async () => {
    if (!available) return;
    // Isolation, proven rather than asserted after the fact: this suite runs
    // against the dedicated test database, so the real profile is not reachable
    // from it at all.
    expect(await prisma!.executionProfile.count({ where: { accountIdentifier: "mainnet-canary-usdm" } })).toBe(0);
  });
});
