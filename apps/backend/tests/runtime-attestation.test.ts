import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  RUNTIME_ATTESTATION_HEARTBEAT_MS,
  RUNTIME_ATTESTATION_SCHEMA_VERSION,
  RUNTIME_ATTESTATION_TTL_MS,
  createRuntimeAttestationPublisher,
  gatesAreLive,
  readRuntimeAttestationStatus,
  runtimeAttestationKey,
  type RuntimeAttestation,
  type RuntimeAttestationRedis,
  type RuntimeGateSnapshot,
  type RuntimeIdentity,
} from "../src/modules/runtime/runtime-attestation";

/**
 * Phase 12.4D-A.1 — the operator activation interlock.
 *
 * The bug this exists for, in one sentence: an `execution:*` CLI parses `.env`
 * when it starts, but a backend and worker that started earlier are still using
 * the snapshot THEY parsed, so the CLI could report "gates armed" while the
 * processes that actually trade were running different configuration.
 *
 * Everything here runs against an in-memory Redis double and an injected clock,
 * so there are no sleeps, no Redis server, no running runtime and no MAINNET.
 */

const IDENTITY: RuntimeIdentity = { accountIdentifier: "test-account", environment: "MAINNET" };

/** The gate values a genuinely live-armed process would have loaded. */
const LIVE: RuntimeGateSnapshot = {
  globalKillSwitch: false,
  liveEntryEnabled: true,
  protectionReady: true,
  accountSetupMutationsEnabled: false,
  testOrderEnabled: false,
  autoAddMarginEnabled: false,
  emergencyCloseMode: "DISABLED",
};

/** The safe posture — what a process that was NOT restarted still holds. */
const SAFE: RuntimeGateSnapshot = {
  ...LIVE,
  globalKillSwitch: true,
  liveEntryEnabled: false,
  protectionReady: false,
};

/** Minimal in-memory Redis supporting exactly the four commands used. */
class FakeRedis implements RuntimeAttestationRedis {
  readonly store = new Map<string, string>();
  failOn: "none" | "scan" | "get" = "none";

  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return "OK";
  }
  async del(key: string): Promise<unknown> {
    return this.store.delete(key) ? 1 : 0;
  }
  async get(key: string): Promise<string | null> {
    if (this.failOn === "get") throw new Error("redis get failed");
    return this.store.get(key) ?? null;
  }
  async scan(cursor: string, _m: "MATCH", pattern: string): Promise<[string, string[]]> {
    if (this.failOn === "scan") throw new Error("redis scan failed");
    const prefix = pattern.replace(/\*$/, "");
    return ["0", [...this.store.keys()].filter((key) => key.startsWith(prefix))];
  }
}

const AT = new Date("2026-08-20T12:00:00.000Z");

function attestation(
  role: "BACKEND" | "WORKER",
  gates: RuntimeGateSnapshot,
  options: { instanceId?: string; lastSeenAt?: Date; identity?: RuntimeIdentity; schemaVersion?: number } = {}
): RuntimeAttestation {
  const identity = options.identity ?? IDENTITY;
  return {
    schemaVersion: options.schemaVersion ?? RUNTIME_ATTESTATION_SCHEMA_VERSION,
    role,
    instanceId: options.instanceId ?? `${role.toLowerCase()}-1`,
    startedAt: AT.toISOString(),
    lastSeenAt: (options.lastSeenAt ?? AT).toISOString(),
    accountIdentifier: identity.accountIdentifier,
    environment: identity.environment,
    gates,
  };
}

function seed(redis: FakeRedis, records: RuntimeAttestation[]): void {
  for (const record of records) {
    redis.store.set(
      runtimeAttestationKey(
        { accountIdentifier: record.accountIdentifier, environment: record.environment },
        record.role,
        record.instanceId
      ),
      JSON.stringify(record)
    );
  }
}

const read = (redis: FakeRedis, expected: RuntimeGateSnapshot = LIVE, now: Date = AT) =>
  readRuntimeAttestationStatus({ redis, identity: IDENTITY, expected, now });

// ---------------------------------------------------------------------------
// 1. The Phase-4D-A bug
// ---------------------------------------------------------------------------

describe("runtime attestation: the stale-env interlock", () => {
  it("BLOCKS when the backend is running an older .env snapshot than the CLI", async () => {
    // THE core regression. The operator edited .env, restarted the worker, and
    // forgot the backend. Both runtimes are present and fresh; the CLI's own
    // snapshot says live. Only the backend's loaded values disagree — and that
    // is precisely the case nothing could previously detect.
    const redis = new FakeRedis();
    seed(redis, [attestation("BACKEND", SAFE), attestation("WORKER", LIVE)]);

    const status = await read(redis, LIVE);

    expect(status.ok).toBe(false);
    expect(status.reasonCode).toBe("RUNTIME_ATTESTATION_MISMATCH");
    expect(status.backend.freshCount).toBe(1);
    expect(status.worker.freshCount).toBe(1);
    // The two runtimes disagreeing is the precise diagnosis and is reported
    // ahead of the CLI comparison, so the operator sees the real fault.
    expect(status.message).toContain("different execution gates");
  });

  it("BLOCKS when the worker is the stale one instead", async () => {
    const redis = new FakeRedis();
    seed(redis, [attestation("BACKEND", LIVE), attestation("WORKER", SAFE)]);

    const status = await read(redis, LIVE);

    expect(status.ok).toBe(false);
    expect(status.reasonCode).toBe("RUNTIME_ATTESTATION_MISMATCH");
  });

  it("BLOCKS when both runtimes agree with each other but not with the CLI", async () => {
    // Both processes still hold the safe snapshot; only the CLI re-read .env.
    const redis = new FakeRedis();
    seed(redis, [attestation("BACKEND", SAFE), attestation("WORKER", SAFE)]);

    const status = await read(redis, LIVE);

    expect(status.ok).toBe(false);
    expect(status.reasonCode).toBe("RUNTIME_ATTESTATION_MISMATCH");
  });

  it("BLOCKS when CLI and runtimes agree but the gates are not live-armed", async () => {
    // Everything is consistent — and consistently NOT armed. Consistency alone
    // must never be mistaken for readiness.
    const redis = new FakeRedis();
    seed(redis, [attestation("BACKEND", SAFE), attestation("WORKER", SAFE)]);

    const status = await read(redis, SAFE);

    expect(status.ok).toBe(false);
    expect(status.reasonCode).toBe("RUNTIME_ATTESTATION_MISMATCH");
    expect(status.message).toContain("required to arm");
  });
});

// ---------------------------------------------------------------------------
// 2. Missing, stale, duplicate
// ---------------------------------------------------------------------------

describe("runtime attestation: presence and topology", () => {
  it("BLOCKS when the backend is missing", async () => {
    const redis = new FakeRedis();
    seed(redis, [attestation("WORKER", LIVE)]);
    const status = await read(redis);
    expect(status.reasonCode).toBe("RUNTIME_ATTESTATION_MISSING");
    expect(status.message).toContain("BACKEND");
  });

  it("BLOCKS when the worker is missing", async () => {
    const redis = new FakeRedis();
    seed(redis, [attestation("BACKEND", LIVE)]);
    const status = await read(redis);
    expect(status.reasonCode).toBe("RUNTIME_ATTESTATION_MISSING");
    expect(status.message).toContain("WORKER");
  });

  it("BLOCKS when nothing is attesting at all", async () => {
    const status = await read(new FakeRedis());
    expect(status.ok).toBe(false);
    expect(status.reasonCode).toBe("RUNTIME_ATTESTATION_MISSING");
  });

  it("BLOCKS a stale backend, and reports STALE rather than MISSING", async () => {
    const redis = new FakeRedis();
    const old = new Date(AT.getTime() - RUNTIME_ATTESTATION_TTL_MS - 1);
    seed(redis, [attestation("BACKEND", LIVE, { lastSeenAt: old }), attestation("WORKER", LIVE)]);

    const status = await read(redis);

    expect(status.reasonCode).toBe("RUNTIME_ATTESTATION_STALE");
    expect(status.backend.freshCount).toBe(0);
    expect(status.backend.staleCount).toBe(1);
  });

  it("BLOCKS a stale worker", async () => {
    const redis = new FakeRedis();
    const old = new Date(AT.getTime() - RUNTIME_ATTESTATION_TTL_MS - 1);
    seed(redis, [attestation("BACKEND", LIVE), attestation("WORKER", LIVE, { lastSeenAt: old })]);

    const status = await read(redis);

    expect(status.reasonCode).toBe("RUNTIME_ATTESTATION_STALE");
    expect(status.worker.staleCount).toBe(1);
  });

  it("BLOCKS two fresh backends — no newest-wins", async () => {
    const redis = new FakeRedis();
    seed(redis, [
      attestation("BACKEND", LIVE, { instanceId: "b1" }),
      // A newer, equally valid second instance. Choosing it would silently
      // authorise a topology nobody intended.
      attestation("BACKEND", LIVE, { instanceId: "b2", lastSeenAt: new Date(AT.getTime() + 1000) }),
      attestation("WORKER", LIVE),
    ]);

    const status = await read(redis, LIVE, new Date(AT.getTime() + 1000));

    expect(status.ok).toBe(false);
    expect(status.reasonCode).toBe("RUNTIME_ATTESTATION_DUPLICATE");
    expect(status.backend.freshCount).toBe(2);
  });

  it("BLOCKS two fresh workers", async () => {
    const redis = new FakeRedis();
    seed(redis, [
      attestation("BACKEND", LIVE),
      attestation("WORKER", LIVE, { instanceId: "w1" }),
      attestation("WORKER", LIVE, { instanceId: "w2" }),
    ]);

    const status = await read(redis);

    expect(status.reasonCode).toBe("RUNTIME_ATTESTATION_DUPLICATE");
    expect(status.worker.freshCount).toBe(2);
  });

  it("PASSES with exactly one fresh backend and one fresh worker, both live", async () => {
    const redis = new FakeRedis();
    seed(redis, [attestation("BACKEND", LIVE), attestation("WORKER", LIVE)]);

    const status = await read(redis, LIVE);

    expect(status.ok).toBe(true);
    expect(status.reasonCode).toBeNull();
    expect(status.backend.freshCount).toBe(1);
    expect(status.worker.freshCount).toBe(1);
  });

  it("ignores a stale duplicate while exactly one instance is fresh", async () => {
    // A restarted process leaves its predecessor's key behind until TTL. That
    // is normal and must not be read as a duplicate.
    const redis = new FakeRedis();
    const old = new Date(AT.getTime() - RUNTIME_ATTESTATION_TTL_MS - 1);
    seed(redis, [
      attestation("BACKEND", LIVE, { instanceId: "old", lastSeenAt: old }),
      attestation("BACKEND", LIVE, { instanceId: "new" }),
      attestation("WORKER", LIVE),
    ]);

    const status = await read(redis, LIVE);

    expect(status.ok).toBe(true);
    expect(status.backend.freshCount).toBe(1);
    expect(status.backend.staleCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Freshness boundary
// ---------------------------------------------------------------------------

describe("runtime attestation: freshness boundary", () => {
  const at = (offsetMs: number) => new Date(AT.getTime() + offsetMs);

  it.each([
    [0, true],
    [RUNTIME_ATTESTATION_HEARTBEAT_MS, true],
    [RUNTIME_ATTESTATION_TTL_MS, true],
    [RUNTIME_ATTESTATION_TTL_MS + 1, false],
  ])("age %ims -> fresh=%s", async (ageMs, expectedFresh) => {
    // Exactly at the TTL is still fresh; one millisecond past it is not.
    const redis = new FakeRedis();
    seed(redis, [attestation("BACKEND", LIVE), attestation("WORKER", LIVE)]);

    const status = await read(redis, LIVE, at(ageMs));

    expect(`${ageMs}:${status.ok}`).toBe(`${ageMs}:${expectedFresh}`);
  });

  it("treats a far-future lastSeenAt as untrustworthy rather than fresh", async () => {
    // Clock skew must not be able to manufacture permanent freshness.
    const redis = new FakeRedis();
    seed(redis, [
      attestation("BACKEND", LIVE, { lastSeenAt: new Date(AT.getTime() + RUNTIME_ATTESTATION_TTL_MS * 10) }),
      attestation("WORKER", LIVE),
    ]);

    const status = await read(redis, LIVE);

    expect(status.ok).toBe(false);
    expect(status.backend.staleCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Payload integrity
// ---------------------------------------------------------------------------

describe("runtime attestation: payload integrity", () => {
  it("BLOCKS an unknown schemaVersion", async () => {
    const redis = new FakeRedis();
    seed(redis, [attestation("BACKEND", LIVE, { schemaVersion: 999 }), attestation("WORKER", LIVE)]);
    const status = await read(redis);
    expect(status.ok).toBe(false);
    expect(status.reasonCode).toBe("RUNTIME_ATTESTATION_MISMATCH");
  });

  it("BLOCKS a malformed payload", async () => {
    const redis = new FakeRedis();
    seed(redis, [attestation("WORKER", LIVE)]);
    redis.store.set(runtimeAttestationKey(IDENTITY, "BACKEND", "b1"), "{not json");
    const status = await read(redis);
    expect(status.ok).toBe(false);
    expect(status.reasonCode).toBe("RUNTIME_ATTESTATION_MISMATCH");
  });

  it("does not let another environment or account satisfy readiness", async () => {
    const redis = new FakeRedis();
    seed(redis, [
      attestation("BACKEND", LIVE, { identity: { accountIdentifier: "test-account", environment: "TESTNET" } }),
      attestation("WORKER", LIVE, { identity: { accountIdentifier: "other-account", environment: "MAINNET" } }),
    ]);

    const status = await read(redis, LIVE);

    // Neither record is scoped to the requested identity, so nothing is found.
    expect(status.ok).toBe(false);
    expect(status.reasonCode).toBe("RUNTIME_ATTESTATION_MISSING");
  });
});

// ---------------------------------------------------------------------------
// 5. Infrastructure failure fails closed
// ---------------------------------------------------------------------------

describe("runtime attestation: infrastructure failure", () => {
  it.each(["scan", "get"] as const)("a Redis %s failure is UNAVAILABLE, never PASS", async (failOn) => {
    const redis = new FakeRedis();
    seed(redis, [attestation("BACKEND", LIVE), attestation("WORKER", LIVE)]);
    redis.failOn = failOn;

    const status = await read(redis, LIVE);

    expect(status.ok).toBe(false);
    expect(status.reasonCode).toBe("RUNTIME_ATTESTATION_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// 6. Publisher: process snapshot and identity
// ---------------------------------------------------------------------------

describe("runtime attestation: publisher", () => {
  it("keeps the snapshot captured at construction even as the environment changes", async () => {
    // The invariant that makes the whole interlock meaningful: a running process
    // attests what it LOADED, not what the file says now. If this ever changed,
    // a stale runtime would start reporting values it is not running on and the
    // interlock would quietly certify the exact mismatch it exists to catch.
    const redis = new FakeRedis();
    const captured: RuntimeGateSnapshot = { ...SAFE };
    const publisher = createRuntimeAttestationPublisher({
      role: "BACKEND",
      redis,
      identity: IDENTITY,
      gates: captured,
      now: () => AT,
    });

    await publisher.publishOnce();

    // The world moves on: .env is edited to the live values.
    captured.globalKillSwitch = false;
    captured.liveEntryEnabled = true;
    captured.protectionReady = true;

    await publisher.publishOnce();

    const raw = redis.store.get(publisher.key) as string;
    const published = JSON.parse(raw) as RuntimeAttestation;
    // Still the snapshot this process started with.
    expect(published.gates.globalKillSwitch).toBe(true);
    expect(published.gates.liveEntryEnabled).toBe(false);
    expect(published.gates.protectionReady).toBe(false);
  });

  it("never re-reads configuration from disk", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/modules/runtime/runtime-attestation.ts"),
      "utf8"
    );
    // Usage-shaped, so the module's own prose explaining that it never dumps
    // process.env cannot satisfy the assertion.
    for (const forbidden of ["readFileSync", "dotenv", "process.env.", "process.env["]) {
      expect(`${forbidden}:${source.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("keeps one instanceId across heartbeats and advances only lastSeenAt", async () => {
    const redis = new FakeRedis();
    let clock = AT;
    const publisher = createRuntimeAttestationPublisher({
      role: "WORKER",
      redis,
      identity: IDENTITY,
      gates: LIVE,
      now: () => clock,
    });

    await publisher.publishOnce();
    const first = JSON.parse(redis.store.get(publisher.key) as string) as RuntimeAttestation;
    clock = new Date(AT.getTime() + RUNTIME_ATTESTATION_HEARTBEAT_MS);
    await publisher.publishOnce();
    const second = JSON.parse(redis.store.get(publisher.key) as string) as RuntimeAttestation;

    expect(second.instanceId).toBe(first.instanceId);
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.lastSeenAt).not.toBe(first.lastSeenAt);
    expect(redis.store.size).toBe(1);
  });

  it("gives a restarted process a different instanceId", () => {
    const redis = new FakeRedis();
    const first = createRuntimeAttestationPublisher({ role: "BACKEND", redis, identity: IDENTITY, gates: LIVE });
    const second = createRuntimeAttestationPublisher({ role: "BACKEND", redis, identity: IDENTITY, gates: LIVE });
    expect(second.instanceId).not.toBe(first.instanceId);
  });

  it("removes its own key on graceful stop", async () => {
    const redis = new FakeRedis();
    const publisher = createRuntimeAttestationPublisher({ role: "BACKEND", redis, identity: IDENTITY, gates: LIVE });
    await publisher.publishOnce();
    expect(redis.store.size).toBe(1);

    await publisher.stop();

    expect(redis.store.size).toBe(0);
  });

  it("publishes with a TTL so a crashed process expires without cleanup", async () => {
    const calls: unknown[][] = [];
    const recording: RuntimeAttestationRedis = {
      set: async (...args: unknown[]) => {
        calls.push(args);
        return "OK";
      },
      del: async () => 1,
      get: async () => null,
      scan: async () => ["0", []],
    } as unknown as RuntimeAttestationRedis;

    const publisher = createRuntimeAttestationPublisher({
      role: "BACKEND",
      redis: recording,
      identity: IDENTITY,
      gates: LIVE,
    });
    await publisher.publishOnce();

    expect(calls[0][2]).toBe("PX");
    expect(calls[0][3]).toBe(RUNTIME_ATTESTATION_TTL_MS);
  });
});

// ---------------------------------------------------------------------------
// 7. Secrets and contract
// ---------------------------------------------------------------------------

describe("runtime attestation: secrets and contract", () => {
  const source = readFileSync(path.join(process.cwd(), "src/modules/runtime/runtime-attestation.ts"), "utf8");

  it("cannot serialize any credential", async () => {
    const redis = new FakeRedis();
    const publisher = createRuntimeAttestationPublisher({
      role: "BACKEND",
      redis,
      identity: IDENTITY,
      gates: LIVE,
    });
    await publisher.publishOnce();
    const raw = redis.store.get(publisher.key) as string;

    for (const forbidden of ["API_KEY", "SECRET", "DATABASE_URL", "REDIS_URL", "token", "tokenHash", "password"]) {
      expect(`${forbidden}:${raw.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // The payload is exactly the declared fields — no extras.
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(
      ["accountIdentifier", "environment", "gates", "instanceId", "lastSeenAt", "role", "schemaVersion", "startedAt"]
    );
  });

  it("names no credential env var anywhere in the module", () => {
    for (const forbidden of [
      "BINANCE_API_KEY",
      "BINANCE_API_SECRET",
      "WEBHOOK_SECRET",
      "DATABASE_URL",
      "REDIS_PASSWORD",
      "tokenHash",
    ]) {
      expect(`${forbidden}:${source.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("uses SCAN, never KEYS", () => {
    expect(source).toContain(".scan(");
    expect(source).not.toMatch(/\.keys\(/);
  });

  it("is not imported by any runtime execution-authority module", () => {
    // The interlock is operator tooling. Admission authority must not depend on
    // a heartbeat, or a Redis outage could stop protecting a live position.
    for (const file of [
      "safety-engine.ts",
      "safety-admission.service.ts",
      "selected-plan-executor.ts",
      "execution-orchestrator.ts",
      "capacity-status.ts",
      "entry-lifecycle.service.ts",
      "protection-lifecycle.service.ts",
    ]) {
      const code = readFileSync(path.join(process.cwd(), "src/modules/execution", file), "utf8");
      expect(`${file}:${code.includes("runtime-attestation")}`).toBe(`${file}:false`);
    }
  });

  it("pins the reviewed heartbeat and TTL contract", () => {
    expect(RUNTIME_ATTESTATION_HEARTBEAT_MS).toBe(5_000);
    expect(RUNTIME_ATTESTATION_TTL_MS).toBe(15_000);
    expect(RUNTIME_ATTESTATION_SCHEMA_VERSION).toBe(1);
  });

  it("requires every live gate, not merely the three headline ones", () => {
    expect(gatesAreLive(LIVE)).toBe(true);
    for (const [field, value] of [
      ["globalKillSwitch", true],
      ["liveEntryEnabled", false],
      ["protectionReady", false],
      ["accountSetupMutationsEnabled", true],
      ["testOrderEnabled", true],
      ["autoAddMarginEnabled", true],
      ["emergencyCloseMode", "ENABLED"],
    ] as const) {
      expect(`${field}:${gatesAreLive({ ...LIVE, [field]: value })}`).toBe(`${field}:false`);
    }
  });
});
