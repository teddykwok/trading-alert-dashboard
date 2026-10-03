import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { judgeRoleMode, type RuntimeMode } from "../src/modules/operator/account-runtime-transition";
import { expectedGateSnapshotFor } from "../src/modules/operator/runtime-launcher";
import {
  RUNTIME_ATTESTATION_SCHEMA_VERSION,
  gatesAreLive,
  readRuntimeAttestationStatus,
  readRuntimeDeploymentAttestationStatus,
  runtimeAttestationKey,
  type RuntimeAttestation,
  type RuntimeAttestationRedis,
  type RuntimeGateSnapshot,
  type RuntimeIdentity,
} from "../src/modules/runtime/runtime-attestation";

/**
 * The launcher SAFE-transition attestation defect, fixed.
 *
 * Before: the worker leg of a transition required the control plane's ARMING
 * verdict (`runtimeAttestation`, which adds `gatesAreLive()`), so a healthy
 * return-to-SAFE could never verify. After: the worker leg is proven by the
 * DEPLOYMENT attestation, judged against the target mode's exact gates. These
 * tests use the real attestation readers over an in-memory store.
 */

const IDENTITY: RuntimeIdentity = { accountIdentifier: "acct-a-test", environment: "MAINNET" };
const AT = new Date("2026-10-03T12:00:00.000Z");
const SAFE = expectedGateSnapshotFor("SAFE");
const LIVE_READY = expectedGateSnapshotFor("LIVE_READY");

class FakeRedis implements RuntimeAttestationRedis {
  readonly store = new Map<string, string>();
  failScan = false;
  async set(key: string, value: string) {
    this.store.set(key, value);
    return "OK";
  }
  async del(key: string) {
    return this.store.delete(key) ? 1 : 0;
  }
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async scan(_cursor: string, _m: "MATCH", pattern: string): Promise<[string, string[]]> {
    if (this.failScan) throw new Error("redis scan failed");
    const prefix = pattern.replace(/\*$/, "");
    return ["0", [...this.store.keys()].filter((key) => key.startsWith(prefix))];
  }
}

function record(role: "BACKEND" | "WORKER", gates: RuntimeGateSnapshot, opts: { instanceId?: string; lastSeenAt?: Date } = {}): RuntimeAttestation {
  return {
    schemaVersion: RUNTIME_ATTESTATION_SCHEMA_VERSION,
    role,
    instanceId: opts.instanceId ?? `${role.toLowerCase()}-1`,
    startedAt: AT.toISOString(),
    lastSeenAt: (opts.lastSeenAt ?? AT).toISOString(),
    accountIdentifier: IDENTITY.accountIdentifier,
    environment: IDENTITY.environment,
    gates,
  };
}

function store(...records: RuntimeAttestation[]): FakeRedis {
  const redis = new FakeRedis();
  for (const r of records) redis.store.set(runtimeAttestationKey(IDENTITY, r.role, r.instanceId), JSON.stringify(r));
  return redis;
}

/** Exactly what the launcher now reads: the deployment status for the TARGET mode's gates. */
const deploymentFor = (redis: FakeRedis, mode: RuntimeMode) =>
  readRuntimeDeploymentAttestationStatus({ redis, identity: IDENTITY, expected: expectedGateSnapshotFor(mode), now: AT });

/** A control-plane status body as the account control plane serves it. */
function controlStatus(gates: RuntimeGateSnapshot, systemState = "SAFE_OFF", arming: "PASS" | "BLOCKED" = "BLOCKED") {
  return {
    systemState,
    environmentGates: { globalKillSwitch: gates.globalKillSwitch, liveEntryEnabled: gates.liveEntryEnabled, protectionReady: gates.protectionReady },
    // The ARMING verdict: what the old verifier wrongly required to be PASS.
    runtimeAttestation: { status: arming },
  };
}

const worker = "account-a-worker" as const;
const control = "account-a-control" as const;

describe("SAFE and LIVE_READY transitions verify DEPLOYMENT, not arming", () => {
  it("1. a healthy SAFE deployment PASSES the worker leg, although gatesAreLive() is false and the arming verdict is BLOCKED", async () => {
    const redis = store(record("BACKEND", SAFE), record("WORKER", SAFE));
    expect(gatesAreLive(SAFE)).toBe(false);
    // The arming reader refuses this pair -- correctly, it is SAFE.
    expect((await readRuntimeAttestationStatus({ redis, identity: IDENTITY, expected: SAFE, now: AT })).ok).toBe(false);
    const verdict = judgeRoleMode("ACCOUNT_A", worker, "SAFE", { controlStatus: controlStatus(SAFE, "SAFE_OFF", "BLOCKED"), deployment: await deploymentFor(redis, "SAFE") });
    expect(verdict).toEqual({ ok: true });
  });

  it("2. a MISSING worker attestation fails SAFE", async () => {
    const redis = store(record("BACKEND", SAFE));
    const verdict = judgeRoleMode("ACCOUNT_A", worker, "SAFE", { controlStatus: controlStatus(SAFE), deployment: await deploymentFor(redis, "SAFE") });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.reason).toMatch(/has not attested to the SAFE deployment/);
    expect(verdict.ok ? "" : verdict.reason).toMatch(/MISSING/);
  });

  it("2b. unreadable attestation (null, or a store that fails) fails closed — unknown is never healthy", async () => {
    expect(judgeRoleMode("ACCOUNT_A", worker, "SAFE", { controlStatus: controlStatus(SAFE), deployment: null }).ok).toBe(false);
    const broken = store(record("BACKEND", SAFE), record("WORKER", SAFE));
    broken.failScan = true;
    const verdict = judgeRoleMode("ACCOUNT_A", worker, "SAFE", { controlStatus: controlStatus(SAFE), deployment: await deploymentFor(broken, "SAFE") });
    expect(verdict.ok ? "" : verdict.reason).toMatch(/UNAVAILABLE/);
    expect(judgeRoleMode("ACCOUNT_A", worker, "SAFE", { controlStatus: null, deployment: await deploymentFor(store(record("BACKEND", SAFE), record("WORKER", SAFE)), "SAFE") }).ok).toBe(false);
  });

  it("3. a STALE, DUPLICATED or MISMATCHED worker attestation fails SAFE", async () => {
    const stale = store(record("BACKEND", SAFE), record("WORKER", SAFE, { lastSeenAt: new Date(AT.getTime() - 60_000) }));
    const dup = store(record("BACKEND", SAFE), record("WORKER", SAFE), record("WORKER", SAFE, { instanceId: "worker-2" }));
    const mismatched = store(record("BACKEND", SAFE), record("WORKER", { ...SAFE, testOrderEnabled: true }));
    for (const [label, redis, code] of [
      ["stale", stale, /STALE/],
      ["duplicate", dup, /DUPLICATE/],
      ["mismatch", mismatched, /MISMATCH/],
    ] as const) {
      const verdict = judgeRoleMode("ACCOUNT_A", worker, "SAFE", { controlStatus: controlStatus(SAFE), deployment: await deploymentFor(redis, "SAFE") });
      expect({ label, ok: verdict.ok }).toEqual({ label, ok: false });
      expect(verdict.ok ? "" : verdict.reason).toMatch(code);
    }
  });

  it("4. the wrong mode or role fails: a LIVE_READY pair for a SAFE target, a control plane still running LIVE_READY, a non-SAFE_OFF state, a foreign role", async () => {
    const liveReadyPair = store(record("BACKEND", LIVE_READY), record("WORKER", LIVE_READY));
    expect(judgeRoleMode("ACCOUNT_A", worker, "SAFE", { controlStatus: controlStatus(SAFE), deployment: await deploymentFor(liveReadyPair, "SAFE") }).ok).toBe(false);
    const safePair = store(record("BACKEND", SAFE), record("WORKER", SAFE));
    const deployment = await deploymentFor(safePair, "SAFE");
    expect(judgeRoleMode("ACCOUNT_A", worker, "SAFE", { controlStatus: controlStatus(LIVE_READY), deployment }).ok).toBe(false);
    expect(judgeRoleMode("ACCOUNT_A", worker, "SAFE", { controlStatus: controlStatus(SAFE, "LIVE_ARMED"), deployment }).ok).toBe(false);
    expect(judgeRoleMode("ACCOUNT_A", "account-b-worker", "SAFE", { controlStatus: controlStatus(SAFE), deployment }).ok).toBe(false);
    expect(judgeRoleMode("ACCOUNT_B", worker, "SAFE", { controlStatus: controlStatus(SAFE), deployment }).ok).toBe(false);
    // Only BACKENDs, no WORKER role at all: never a deployment.
    const twoBackends = store(record("BACKEND", SAFE), record("BACKEND", SAFE, { instanceId: "backend-2" }));
    expect(judgeRoleMode("ACCOUNT_A", worker, "SAFE", { controlStatus: controlStatus(SAFE), deployment: await deploymentFor(twoBackends, "SAFE") }).ok).toBe(false);
  });

  it("5. LIVE_READY verifies its own exact deployment, and a SAFE pair can never pass as LIVE_READY", async () => {
    const pair = store(record("BACKEND", LIVE_READY), record("WORKER", LIVE_READY));
    expect(judgeRoleMode("ACCOUNT_A", worker, "LIVE_READY", { controlStatus: controlStatus(LIVE_READY), deployment: await deploymentFor(pair, "LIVE_READY") })).toEqual({ ok: true });
    const safePair = store(record("BACKEND", SAFE), record("WORKER", SAFE));
    expect(judgeRoleMode("ACCOUNT_A", worker, "LIVE_READY", { controlStatus: controlStatus(LIVE_READY), deployment: await deploymentFor(safePair, "LIVE_READY") }).ok).toBe(false);
    // LIVE_READY's exact snapshot implies every live gate: not weaker than the old arming check for this mode.
    expect(gatesAreLive(LIVE_READY)).toBe(true);
  });

  it("the CONTROL leg needs no worker yet, but still requires the right loaded mode and SAFE_OFF", () => {
    expect(judgeRoleMode("ACCOUNT_A", control, "SAFE", { controlStatus: controlStatus(SAFE), deployment: null })).toEqual({ ok: true });
    expect(judgeRoleMode("ACCOUNT_A", control, "SAFE", { controlStatus: controlStatus(LIVE_READY), deployment: null }).ok).toBe(false);
    expect(judgeRoleMode("ACCOUNT_A", control, "SAFE", { controlStatus: { systemState: "SAFE_OFF" }, deployment: null }).ok).toBe(false);
  });
});

describe("6. ARMED stays strict", () => {
  it("the arming reader still requires live gates: a healthy SAFE or partial pair can never arm", async () => {
    const safePair = store(record("BACKEND", SAFE), record("WORKER", SAFE));
    const arming = await readRuntimeAttestationStatus({ redis: safePair, identity: IDENTITY, expected: SAFE, now: AT });
    expect(arming.ok).toBe(false);
    expect(arming.message).toMatch(/required to arm/);
    const livePair = store(record("BACKEND", LIVE_READY), record("WORKER", LIVE_READY));
    expect((await readRuntimeAttestationStatus({ redis: livePair, identity: IDENTITY, expected: LIVE_READY, now: AT })).ok).toBe(true);
    const halfLive = { ...LIVE_READY, emergencyCloseMode: "CLOSE_ALL" };
    const half = store(record("BACKEND", halfLive), record("WORKER", halfLive));
    expect((await readRuntimeAttestationStatus({ redis: half, identity: IDENTITY, expected: halfLive, now: AT })).ok).toBe(false);
  });

  it("every arming caller still uses the arming reader; the gatesAreLive check is untouched", () => {
    const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
    for (const rel of [
      "src/modules/operator/trading-control-actions.service.ts",
      "src/modules/operator/trading-control.service.ts",
      "src/modules/execution/run-canary-controls.ts",
      "src/modules/execution/run-canary-preflight.ts",
    ]) {
      expect(`${rel}:${read(rel).includes("readRuntimeAttestationStatusOnce")}`).toBe(`${rel}:true`);
      expect(`${rel}:${read(rel).includes("readRuntimeDeploymentAttestationStatus")}`).toBe(`${rel}:false`);
    }
    const attestation = read("src/modules/runtime/runtime-attestation.ts");
    expect(attestation).toContain("if (!gatesAreLive(status.backend.gates as RuntimeGateSnapshot)) {");
  });

  it("the transition verifier never consults the arming verdict again", () => {
    const launcher = readFileSync(path.join(process.cwd(), "src/modules/operator/run-runtime-launcher.ts"), "utf8");
    const verify = launcher.slice(launcher.indexOf("async function verifyRoleMode("), launcher.indexOf("async function readDeploymentForMode("));
    expect(verify).toContain("judgeRoleMode(account, role, mode, { controlStatus, deployment })");
    expect(verify).not.toMatch(/runtimeAttestation/);
    expect(launcher).toContain("expected: expectedGateSnapshotFor(mode),");
  });
});
