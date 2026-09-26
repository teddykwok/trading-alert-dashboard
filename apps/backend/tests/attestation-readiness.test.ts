import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RUNTIME_ATTESTATION_HEARTBEAT_MS,
  RUNTIME_ATTESTATION_TTL_MS,
  createRuntimeAttestationPublisher,
  type RuntimeAttestationRedis,
} from "../src/modules/runtime/runtime-attestation";

/**
 * Phase 11F — the first beat waits for a writable link.
 *
 * The heartbeat connection sets `enableOfflineQueue: false`, which is the right
 * bias — fail fast rather than queue a command forever — but it also means a
 * command issued while the socket is still connecting is rejected at once. The
 * publisher used to call `publishOnce()` the instant it started, racing a
 * connection ioredis establishes asynchronously, so a perfectly healthy runtime
 * logged "Runtime attestation heartbeat failed" on every boot and published
 * nothing until the next beat.
 *
 * Behavioural, against a fake transport that records the order of everything.
 */

interface Recorder {
  redis: RuntimeAttestationRedis;
  sets: string[];
  dels: string[];
}

function recordingRedis(): Recorder {
  const sets: string[] = [];
  const dels: string[] = [];
  return {
    sets,
    dels,
    redis: {
      set: async (key: string) => {
        sets.push(key);
        return "OK";
      },
      del: async (key: string) => {
        dels.push(key);
        return 1;
      },
      scan: async () => ["0", []] as [string, string[]],
    } as unknown as RuntimeAttestationRedis,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("attestation does not publish before the transport is ready", () => {
  it("issues NO set until readiness resolves, then publishes once", async () => {
    const { redis, sets } = recordingRedis();
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });

    const publisher = createRuntimeAttestationPublisher({
      role: "WORKER",
      redis,
      waitUntilReady: () => ready,
    });

    publisher.start();
    // The precise regression: a set here would be the racing first beat.
    await Promise.resolve();
    expect(sets).toEqual([]);

    release();
    await vi.waitFor(() => expect(sets).toHaveLength(1));
    expect(sets[0]).toBe(publisher.key);

    await publisher.stop();
  });

  it("publishes nothing at all when the link never becomes ready", async () => {
    const { redis, sets } = recordingRedis();
    const errors: unknown[] = [];

    const publisher = createRuntimeAttestationPublisher({
      role: "BACKEND",
      redis,
      waitUntilReady: () => Promise.reject(new Error("attestation redis did not become ready")),
      onError: (error) => errors.push(error),
    });

    publisher.start();
    await vi.waitFor(() => expect(errors).toHaveLength(1));

    // Fail closed: no key, so the activation interlock counts no runtime. The
    // failure is reported rather than swallowed.
    expect(sets).toEqual([]);

    await publisher.stop();
  });

  it("waits only for the FIRST beat, never for later ones", async () => {
    const { redis, sets } = recordingRedis();
    let readyCalls = 0;

    const publisher = createRuntimeAttestationPublisher({
      role: "WORKER",
      redis,
      waitUntilReady: async () => {
        readyCalls += 1;
      },
    });

    publisher.start();
    await vi.waitFor(() => expect(sets).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(RUNTIME_ATTESTATION_HEARTBEAT_MS * 2);
    expect(sets.length).toBeGreaterThanOrEqual(3);
    // A heartbeat that re-waited every time would stop being a heartbeat.
    expect(readyCalls).toBe(1);

    await publisher.stop();
  });

  it("needs no readiness hook at all when the transport is synchronous", () => {
    // Every existing test injects a fake transport that is ready by
    // construction; the option must stay optional for them.
    const { redis } = recordingRedis();
    expect(() =>
      createRuntimeAttestationPublisher({ role: "WORKER", redis }).start()
    ).not.toThrow();
  });
});

describe("the readiness fix changes nothing else", () => {
  it("keeps the TTL and cadence", () => {
    expect(RUNTIME_ATTESTATION_HEARTBEAT_MS).toBe(5_000);
    expect(RUNTIME_ATTESTATION_TTL_MS).toBe(15_000);
  });

  it("still withdraws when the health predicate says the runtime is unfit", async () => {
    const { redis, sets, dels } = recordingRedis();
    let healthy = true;
    const withdrawals: number[] = [];

    const publisher = createRuntimeAttestationPublisher({
      role: "WORKER",
      redis,
      waitUntilReady: async () => undefined,
      healthy: () => healthy,
      onWithdraw: () => withdrawals.push(1),
    });

    publisher.start();
    await vi.waitFor(() => expect(sets).toHaveLength(1));

    healthy = false;
    await publisher.publishOnce();

    expect(withdrawals).toHaveLength(1);
    // Withdrawal DELETES the key rather than letting it age out, closing the
    // window in which an operator could arm over a runtime known to be unfit.
    expect(dels).toContain(publisher.key);

    await publisher.stop();
  });

  it("deletes only its own instance key on stop", async () => {
    const { redis, dels } = recordingRedis();
    const a = createRuntimeAttestationPublisher({
      role: "BACKEND",
      redis,
      waitUntilReady: async () => undefined,
    });
    const b = createRuntimeAttestationPublisher({
      role: "BACKEND",
      redis,
      waitUntilReady: async () => undefined,
    });

    expect(a.key).not.toBe(b.key);

    await a.stop();
    expect(dels).toEqual([a.key]);
    // Stopping one control plane must never withdraw another's attestation.
    expect(`b withdrawn by a: ${dels.includes(b.key)}`).toBe("b withdrawn by a: false");
  });
});
