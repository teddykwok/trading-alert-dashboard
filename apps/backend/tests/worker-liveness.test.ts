import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The alive-but-stale worker.
 *
 * During the first MAINNET commissioning the worker reached a state nothing in
 * the system was able to report:
 *
 *   - the OS process existed, so the launcher printed `Worker ON`;
 *   - its runtime attestation had expired, so Trading Control refused to arm;
 *   - `Execution reconciliation tick completed` stopped appearing entirely;
 *   - a real FHEUSDT position stayed PROTECTED with two live reduce-only
 *     orders, and nothing reconciled it until the worker was restarted by hand.
 *
 * Two independent defects produced that, and both are structural rather than
 * incidental:
 *
 *   1. the heartbeat published over the BullMQ connection, which BullMQ
 *      requires to be built with `maxRetriesPerRequest: null` — the one setting
 *      under which ioredis never fails a queued command, so a publish could
 *      wait forever and raise nothing;
 *   2. the reconciliation single-flight flag is released in a `finally`, which
 *      a promise that never settles never reaches, so the flag latched true and
 *      every later interval took an early return logged only at `debug`.
 *
 * Every test here drives the real modules with injected doubles: no Redis
 * server, no database, no Binance, no runtime.
 */

// ---------------------------------------------------------------------------
// ioredis is replaced for THIS file so the attestation connection's real
// construction options can be inspected. The suite-wide mock in setup.ts has no
// constructor to interrogate.
// ---------------------------------------------------------------------------

const redisProbe = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>;
    listeners: string[];
    quits: number;
    disconnects: number;
    quitRejects: boolean;
    quitHangs: boolean;
  }>,
}));

vi.mock("ioredis", () => {
  class RecordingRedis {
    private readonly record: (typeof redisProbe.instances)[number];

    constructor(_url: string, options: Record<string, unknown> = {}) {
      this.record = {
        options,
        listeners: [],
        quits: 0,
        disconnects: 0,
        quitRejects: false,
        quitHangs: false,
      };
      redisProbe.instances.push(this.record);
    }
    on(event: string): this {
      this.record.listeners.push(event);
      return this;
    }
    async quit(): Promise<void> {
      this.record.quits += 1;
      if (this.record.quitRejects) throw new Error("connection is closed");
      if (this.record.quitHangs) await new Promise(() => undefined);
    }
    disconnect(): void {
      this.record.disconnects += 1;
    }
    duplicate(): RecordingRedis {
      return this;
    }
  }
  return { default: RecordingRedis };
});

import { logger } from "../src/config/logger";
import {
  ATTESTATION_REDIS_MAX_RETRIES_PER_REQUEST,
  ATTESTATION_REDIS_QUIT_TIMEOUT_MS,
  createAttestationRedisClient,
  describeRedisFailure,
} from "../src/modules/runtime/attestation-redis";
import {
  AttestationPublishTimeoutError,
  RUNTIME_ATTESTATION_PUBLISH_TIMEOUT_MS,
  createRuntimeAttestationPublisher,
  readRuntimeAttestationStatus,
  runtimeAttestationKey,
  type RuntimeAttestation,
  type RuntimeAttestationRedis,
  type RuntimeGateSnapshot,
  type RuntimeIdentity,
} from "../src/modules/runtime/runtime-attestation";
import {
  RECONCILIATION_STALL_MS,
  reconciliationHealth,
  reconciliationHealth,
  resetOrchestrationTickGuardForTests,
  runReconciliationTickOnce,
  runStartupRecoveryOnce,
} from "../src/modules/jobs/execution-orchestration.scheduler";
import {
  describeStaleHealth,
  evaluateStartPreconditions,
  judgeRoleHealth,
  presentStatus,
  renderStatus,
} from "../src/modules/operator/runtime-launcher";
import type { ExecutionOrchestrator, ReconcileTickResult } from "../src/modules/execution/execution-orchestrator";

const BACKEND = process.cwd();
const IDENTITY: RuntimeIdentity = { accountIdentifier: "test-account", environment: "MAINNET" };

const LIVE: RuntimeGateSnapshot = {
  globalKillSwitch: false,
  liveEntryEnabled: true,
  protectionReady: true,
  accountSetupMutationsEnabled: false,
  testOrderEnabled: false,
  autoAddMarginEnabled: false,
  emergencyCloseMode: "DISABLED",
};

/** In-memory Redis that can also be told to stop answering entirely. */
class FakeRedis implements RuntimeAttestationRedis {
  readonly store = new Map<string, string>();
  /** When true, every command returns a promise that NEVER settles. */
  hang = false;
  setCalls = 0;
  delCalls = 0;

  private stall<T>(): Promise<T> {
    return new Promise<T>(() => {
      /* deliberately never settles — a half-open socket, in one line */
    });
  }
  async set(key: string, value: string): Promise<unknown> {
    this.setCalls += 1;
    if (this.hang) return this.stall();
    this.store.set(key, value);
    return "OK";
  }
  async del(key: string): Promise<unknown> {
    this.delCalls += 1;
    if (this.hang) return this.stall();
    return this.store.delete(key) ? 1 : 0;
  }
  async get(key: string): Promise<string | null> {
    if (this.hang) return this.stall();
    return this.store.get(key) ?? null;
  }
  async scan(_cursor: string, _m: "MATCH", pattern: string): Promise<[string, string[]]> {
    if (this.hang) return this.stall();
    const prefix = pattern.replace(/\*$/, "");
    return ["0", [...this.store.keys()].filter((key) => key.startsWith(prefix))];
  }
}

const AT = new Date("2026-08-22T08:38:30.000Z");

function seedAttestation(redis: FakeRedis, role: "BACKEND" | "WORKER"): void {
  const record: RuntimeAttestation = {
    schemaVersion: 1,
    role,
    instanceId: `${role.toLowerCase()}-1`,
    startedAt: AT.toISOString(),
    lastSeenAt: AT.toISOString(),
    accountIdentifier: IDENTITY.accountIdentifier,
    environment: IDENTITY.environment,
    gates: LIVE,
  };
  redis.store.set(runtimeAttestationKey(IDENTITY, role, record.instanceId), JSON.stringify(record));
}

const TICK_RESULT: ReconcileTickResult = {
  inspected: 0,
  advanced: 0,
  mutationsDispatched: 0,
  recoveryPending: 0,
  failed: false,
};

/** An orchestrator double whose passes are driven by the test. */
interface FakeState {
  tickCalls: number;
  recoveryCalls: number;
  hangTick: boolean;
  hangRecovery: boolean;
  settleTick: null | (() => void);
  settleRecovery: null | (() => void);
}

function fakeOrchestrator() {
  const state: FakeState = {
    tickCalls: 0,
    recoveryCalls: 0,
    hangTick: false,
    hangRecovery: false,
    settleTick: null,
    settleRecovery: null,
  };
  const orchestrator = {
    async runExecutionReconciliationTick(): Promise<ReconcileTickResult> {
      state.tickCalls += 1;
      if (!state.hangTick) return TICK_RESULT;
      return new Promise<ReconcileTickResult>((resolve) => {
        // Releasing also clears the flag, so a pass that recovers is
        // followed by ordinary passes rather than another hang.
        state.settleTick = () => {
          state.hangTick = false;
          state.settleTick = null;
          resolve(TICK_RESULT);
        };
      });
    },
    async runStartupRecovery(): Promise<ReconcileTickResult> {
      state.recoveryCalls += 1;
      if (!state.hangRecovery) return TICK_RESULT;
      return new Promise<ReconcileTickResult>((resolve) => {
        state.settleRecovery = () => {
          state.hangRecovery = false;
          state.settleRecovery = null;
          resolve(TICK_RESULT);
        };
      });
    },
  } as unknown as ExecutionOrchestrator;
  return { orchestrator, state };
}

// ---------------------------------------------------------------------------
// A. The heartbeat can no longer wait forever
// ---------------------------------------------------------------------------

/**
 * Phase 11D note: these cases assert `reconciliationHealth().healthy`, the
 * STALL predicate, which is what this suite has always been about.
 *
 * `isReconciliationHealthy` -- the predicate the attestation publisher
 * consults -- now carries a SECOND precondition: that this process actually
 * started orchestrating for a bound account. These tests drive ticks directly
 * rather than through the scheduler, so that precondition is not met here and
 * asserting it would be testing the harness. It has its own suite:
 * tests/account-bound-readiness.test.ts.
 */
describe("worker liveness: attestation cannot hang", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("REJECTS a publish that never settles instead of waiting forever", async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    redis.hang = true;
    const publisher = createRuntimeAttestationPublisher({
      role: "WORKER",
      redis,
      identity: IDENTITY,
      gates: LIVE,
    });

    const publish = publisher.publishOnce();
    // Attach the assertion before advancing so the rejection is never orphaned.
    const settled = expect(publish).rejects.toBeInstanceOf(AttestationPublishTimeoutError);
    await vi.advanceTimersByTimeAsync(RUNTIME_ATTESTATION_PUBLISH_TIMEOUT_MS + 1);
    await settled;
    expect(redis.setCalls).toBe(1);
  });

  it("reports the stall through onError and keeps beating", async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    redis.hang = true;
    const errors: unknown[] = [];
    const publisher = createRuntimeAttestationPublisher({
      role: "WORKER",
      redis,
      identity: IDENTITY,
      gates: LIVE,
      onError: (error) => errors.push(error),
    });

    publisher.start();
    // Two beats, each of which times out rather than piling up unresolved.
    await vi.advanceTimersByTimeAsync(RUNTIME_ATTESTATION_PUBLISH_TIMEOUT_MS + 1);
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.every((error) => error instanceof AttestationPublishTimeoutError)).toBe(true);

    const stopped = publisher.stop();
    await vi.advanceTimersByTimeAsync(RUNTIME_ATTESTATION_PUBLISH_TIMEOUT_MS + 1);
    await stopped;
  });

  it("a shutdown cannot hang on an unresponsive Redis either", async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    const publisher = createRuntimeAttestationPublisher({
      role: "WORKER",
      redis,
      identity: IDENTITY,
      gates: LIVE,
      onError: () => undefined,
    });
    await publisher.publishOnce();
    redis.hang = true;

    const stopped = publisher.stop();
    await vi.advanceTimersByTimeAsync(RUNTIME_ATTESTATION_PUBLISH_TIMEOUT_MS + 1);
    await expect(stopped).resolves.toBeUndefined();
  });

  it("still publishes normally when Redis answers", async () => {
    const redis = new FakeRedis();
    const publisher = createRuntimeAttestationPublisher({
      role: "WORKER",
      redis,
      identity: IDENTITY,
      gates: LIVE,
    });
    await publisher.publishOnce();
    expect(redis.store.has(publisher.key)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A2. The connection itself is bounded, and is NOT the BullMQ one
// ---------------------------------------------------------------------------

describe("worker liveness: the attestation connection is isolated and bounded", () => {
  beforeEach(() => {
    redisProbe.instances.length = 0;
  });

  it("never builds the heartbeat connection with the option that caused the hang", () => {
    createAttestationRedisClient();
    const [created] = redisProbe.instances;

    // The precise defect: BullMQ requires null here, and ioredis only fails a
    // queued command when this is a NUMBER (built/redis/event_handler.js).
    expect(created.options.maxRetriesPerRequest).not.toBeNull();
    expect(typeof created.options.maxRetriesPerRequest).toBe("number");
    expect(ATTESTATION_REDIS_MAX_RETRIES_PER_REQUEST).toBeGreaterThan(0);
    // A command issued while the link is down fails rather than queueing.
    expect(created.options.enableOfflineQueue).toBe(false);
    expect(typeof created.options.connectTimeout).toBe("number");
  });

  it("attaches an error listener, so a Redis blip cannot kill the process", () => {
    createAttestationRedisClient();
    expect(redisProbe.instances[0].listeners).toContain("error");
  });

  it("routes connection errors through a sanitizer that cannot print a URL", () => {
    const seen: string[] = [];
    createAttestationRedisClient({ onError: (detail) => seen.push(detail) });
    // Exercise the sanitizer directly with an error shaped like ioredis's.
    const error = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:6379"), { code: "ECONNREFUSED" });
    const detail = describeRedisFailure(error);
    expect(detail).toBe("Error(ECONNREFUSED)");
    expect(detail).not.toContain("6379");
    expect(detail).not.toContain("10.0.0.5");
    expect(describeRedisFailure(new AttestationPublishTimeoutError(2000))).toBe(
      "AttestationPublishTimeoutError"
    );
    expect(seen).toEqual([]);
  });

  it("closes cleanly, and still tears down when QUIT is refused", async () => {
    const first = createAttestationRedisClient();
    await first.close();
    expect(redisProbe.instances[0].quits).toBe(1);

    const second = createAttestationRedisClient();
    redisProbe.instances[1].quitRejects = true;
    await expect(second.close()).resolves.toBeUndefined();
    expect(redisProbe.instances[1].disconnects).toBe(1);
  });

  it("tears the socket down when QUIT never answers, so shutdown cannot hang", async () => {
    vi.useFakeTimers();
    try {
      const client = createAttestationRedisClient();
      redisProbe.instances[0].quitHangs = true;

      const closed = client.close();
      await vi.advanceTimersByTimeAsync(ATTESTATION_REDIS_QUIT_TIMEOUT_MS + 1);
      await expect(closed).resolves.toBeUndefined();
      expect(redisProbe.instances[0].disconnects).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an unreadable Redis as UNKNOWN health, never as a silent runtime", () => {
    // The reader reports zero fresh instances for every role when it could
    // not reach Redis at all, which by count alone is indistinguishable from
    // a process that has stopped attesting. The launcher must not blame the
    // processes for an infrastructure failure.
    const cli = readFileSync(path.join(BACKEND, "src/modules/operator/run-runtime-launcher.ts"), "utf8");
    expect(cli).toContain('if (status.reasonCode === "RUNTIME_ATTESTATION_UNAVAILABLE") return null;');
  });

  it("neither runtime heartbeats over the BullMQ connection any more", () => {
    for (const file of ["src/modules/jobs/execution.worker.ts", "src/server.ts"]) {
      const source = readFileSync(path.join(BACKEND, file), "utf8");
      const publisher = source.slice(source.indexOf("createRuntimeAttestationPublisher({"));
      expect(`${file}:${publisher.includes("bullConnection")}`).toBe(`${file}:false`);
      expect(`${file}:${source.includes("createAttestationRedisClient")}`).toBe(`${file}:true`);
      // The dedicated connection is released on shutdown.
      expect(`${file}:${source.includes("attestationRedis.close()")}`).toBe(`${file}:true`);
    }
  });

  it("the generic worker publishes no runtime attestation at all", () => {
    // Phase 11E: the WORKER role means an ACCOUNT-bound process now. The
    // generic worker binds no account, so a deployment could run it alone
    // with no account executing -- and an attestation from it would say the
    // opposite, letting the activation interlock count a runtime that
    // cannot trade. It must publish nothing, not publish something weaker.
    const generic = readFileSync(path.join(BACKEND, "src/modules/jobs/vision-analysis.worker.ts"), "utf8");
    for (const forbidden of [
      "createRuntimeAttestationPublisher",
      "createAttestationRedisClient",
      "runtimeAttestation",
      "isReconciliationHealthy",
    ]) {
      expect(`${forbidden} in generic worker: ${generic.includes(forbidden)}`).toBe(
        `${forbidden} in generic worker: false`
      );
    }
  });

  it("leaves the BullMQ connection's own requirement untouched", () => {
    const queue = readFileSync(path.join(BACKEND, "src/modules/jobs/queue.ts"), "utf8");
    expect(queue).toContain("maxRetriesPerRequest: null");
  });
});

// ---------------------------------------------------------------------------
// B–E. Reconciliation single-flight, stall detection and recovery
// ---------------------------------------------------------------------------

describe("worker liveness: reconciliation cannot latch silently", () => {
  beforeEach(() => {
    resetOrchestrationTickGuardForTests();
    vi.useFakeTimers();
    vi.setSystemTime(AT);
  });

  afterEach(() => {
    resetOrchestrationTickGuardForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const errorSpy = () => vi.spyOn(logger, "error").mockImplementation(() => logger);
  const messages = (spy: ReturnType<typeof errorSpy>) =>
    spy.mock.calls.map((call) => String(call[1] ?? call[0]));

  // -- C. the healthy path is unchanged ------------------------------------

  it("C. a healthy tick runs, completes, and leaves nothing in flight", async () => {
    const { orchestrator, state } = fakeOrchestrator();
    await runReconciliationTickOnce(orchestrator);

    expect(state.tickCalls).toBe(1);
    expect(reconciliationHealth().inFlight).toBe(false);
    expect(reconciliationHealth().healthy).toBe(true);

    // And the next interval is free to run.
    await runReconciliationTickOnce(orchestrator);
    expect(state.tickCalls).toBe(2);
  });

  // -- D. a throwing pass still self-heals ---------------------------------

  it("D. a REJECTING tick is logged, releases the guard and lets the next one run", async () => {
    const spy = errorSpy();
    const orchestrator = {
      runExecutionReconciliationTick: vi
        .fn()
        .mockRejectedValueOnce(new Error("binance read failed"))
        .mockResolvedValueOnce(TICK_RESULT),
    } as unknown as ExecutionOrchestrator;

    await runReconciliationTickOnce(orchestrator);
    expect(messages(spy).join("\n")).toContain("threw");
    expect(reconciliationHealth().inFlight).toBe(false);
    expect(reconciliationHealth().healthy).toBe(true);

    await runReconciliationTickOnce(orchestrator);
    expect(orchestrator.runExecutionReconciliationTick).toHaveBeenCalledTimes(2);
  });

  // -- E. single-flight is preserved ---------------------------------------

  it("E. a second interval never overlaps a pass that is still running", async () => {
    const { orchestrator, state } = fakeOrchestrator();
    state.hangTick = true;

    const pending = runReconciliationTickOnce(orchestrator);
    await Promise.resolve();
    expect(state.tickCalls).toBe(1);
    expect(reconciliationHealth().inFlight).toBe(true);

    // Three more intervals fire while the first is unfinished.
    await runReconciliationTickOnce(orchestrator);
    await runReconciliationTickOnce(orchestrator);
    await runReconciliationTickOnce(orchestrator);
    expect(state.tickCalls).toBe(1);

    state.settleTick?.();
    await pending;
    expect(reconciliationHealth().inFlight).toBe(false);
  });

  it("E2. a stalled pass is NOT overlapped either — the guard is never force-released", async () => {
    const spy = errorSpy();
    const { orchestrator, state } = fakeOrchestrator();
    state.hangTick = true;

    const pending = runReconciliationTickOnce(orchestrator);
    await Promise.resolve();

    vi.setSystemTime(new Date(AT.getTime() + RECONCILIATION_STALL_MS + 1));
    await runReconciliationTickOnce(orchestrator);

    // Loudly reported, and still exactly one pass has ever been started.
    expect(messages(spy).join("\n")).toContain("STALLED");
    expect(state.tickCalls).toBe(1);

    state.settleTick?.();
    await pending;
  });

  // -- B. the never-settling pass -----------------------------------------

  it("B. a tick that NEVER settles becomes unhealthy and is reported at ERROR", async () => {
    const spy = errorSpy();
    const { orchestrator, state } = fakeOrchestrator();
    state.hangTick = true;

    const pending = runReconciliationTickOnce(orchestrator);
    await Promise.resolve();

    // Still inside the allowance: ordinary, quiet, and still healthy.
    vi.setSystemTime(new Date(AT.getTime() + RECONCILIATION_STALL_MS));
    await runReconciliationTickOnce(orchestrator);
    expect(reconciliationHealth().healthy).toBe(true);
    expect(messages(spy)).toEqual([]);

    // One millisecond past it: unhealthy, and said out loud.
    vi.setSystemTime(new Date(AT.getTime() + RECONCILIATION_STALL_MS + 1));
    expect(reconciliationHealth().healthy).toBe(false);
    await runReconciliationTickOnce(orchestrator);

    const text = messages(spy).join("\n");
    expect(text).toContain("STALLED");
    // The consequence is named, not just the condition.
    expect(text).toContain("withdrawn its runtime attestation");
    expect(text).toContain("NOT being maintained");
    expect(text).toContain("new live activation is blocked");

    // And the guidance is safe under the launcher's actual semantics. There is
    // no per-role restart control, and in this state Stop is refused (durable
    // safety, execution active) while Start is refused (owned process alive) —
    // so naming a restart would send the operator at a control that declines,
    // or at the one genuinely unsafe action: a second stack.
    expect(text).toContain("Controlled worker recovery is required");
    expect(text).toContain("do NOT start another runtime stack");
    for (const forbidden of ["Restart the worker", "restart the worker"]) {
      expect(`${forbidden}:${text.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }

    state.settleTick?.();
    await pending;
  });

  it("B2. the stall report is rate-limited, then repeats once per window", async () => {
    const spy = errorSpy();
    const { orchestrator, state } = fakeOrchestrator();
    state.hangTick = true;

    const pending = runReconciliationTickOnce(orchestrator);
    await Promise.resolve();

    vi.setSystemTime(new Date(AT.getTime() + RECONCILIATION_STALL_MS + 1));
    await runReconciliationTickOnce(orchestrator);
    expect(messages(spy).filter((line) => line.includes("STALLED"))).toHaveLength(1);

    // Several more intervals inside the same window add nothing.
    for (const offset of [30_000, 60_000, 90_000]) {
      vi.setSystemTime(new Date(AT.getTime() + RECONCILIATION_STALL_MS + 1 + offset));
      await runReconciliationTickOnce(orchestrator);
    }
    expect(messages(spy).filter((line) => line.includes("STALLED"))).toHaveLength(1);

    // A full window later it says so again, so the log keeps showing it.
    vi.setSystemTime(new Date(AT.getTime() + RECONCILIATION_STALL_MS * 2 + 2));
    await runReconciliationTickOnce(orchestrator);
    expect(messages(spy).filter((line) => line.includes("STALLED"))).toHaveLength(2);

    state.settleTick?.();
    await pending;
  });

  it("B3. a stall that ends restores health and says so", async () => {
    const spy = errorSpy();
    const { orchestrator, state } = fakeOrchestrator();
    state.hangTick = true;

    const pending = runReconciliationTickOnce(orchestrator);
    await Promise.resolve();

    vi.setSystemTime(new Date(AT.getTime() + RECONCILIATION_STALL_MS + 1));
    expect(reconciliationHealth().healthy).toBe(false);

    state.settleTick?.();
    await pending;

    expect(reconciliationHealth().healthy).toBe(true);
    expect(reconciliationHealth().inFlight).toBe(false);
    expect(messages(spy).join("\n")).toContain("recovered after a stall");

    // And the scheduler is usable again.
    await runReconciliationTickOnce(orchestrator);
    expect(state.tickCalls).toBe(2);
  });

  // -- G. startup recovery ------------------------------------------------

  it("G. startup recovery shares the guard, so a tick cannot run on top of it", async () => {
    const { orchestrator, state } = fakeOrchestrator();
    state.hangRecovery = true;

    const pending = runStartupRecoveryOnce(orchestrator);
    await Promise.resolve();
    expect(state.recoveryCalls).toBe(1);
    expect(reconciliationHealth().label).toBe("startup recovery");

    await runReconciliationTickOnce(orchestrator);
    expect(state.tickCalls).toBe(0);

    state.settleRecovery?.();
    await pending;

    await runReconciliationTickOnce(orchestrator);
    expect(state.tickCalls).toBe(1);
  });

  it("G2. a startup recovery that never settles is caught by the same watchdog", async () => {
    const spy = errorSpy();
    const { orchestrator, state } = fakeOrchestrator();
    state.hangRecovery = true;

    const pending = runStartupRecoveryOnce(orchestrator);
    await Promise.resolve();

    vi.setSystemTime(new Date(AT.getTime() + RECONCILIATION_STALL_MS + 1));
    expect(reconciliationHealth().healthy).toBe(false);
    await runReconciliationTickOnce(orchestrator);
    expect(messages(spy).join("\n")).toContain("STALLED");

    state.settleRecovery?.();
    await pending;
  });
});

// ---------------------------------------------------------------------------
// F. The link between worker health and the activation interlock
// ---------------------------------------------------------------------------

describe("worker liveness: an unhealthy worker cannot be armed over", () => {
  it("F. an unhealthy publisher WITHDRAWS, and the arming reader then refuses", async () => {
    const redis = new FakeRedis();
    seedAttestation(redis, "BACKEND");

    let healthy = true;
    const withdrawals: number[] = [];
    const publisher = createRuntimeAttestationPublisher({
      role: "WORKER",
      redis,
      identity: IDENTITY,
      gates: LIVE,
      now: () => AT,
      healthy: () => healthy,
      onWithdraw: () => withdrawals.push(1),
    });

    // Healthy: attesting, and the interlock passes.
    await publisher.publishOnce();
    const armed = await readRuntimeAttestationStatus({
      redis,
      identity: IDENTITY,
      expected: LIVE,
      now: AT,
    });
    expect(armed.ok).toBe(true);

    // Reconciliation stalls.
    healthy = false;
    await publisher.publishOnce();
    expect(redis.store.has(publisher.key)).toBe(false);
    expect(withdrawals).toHaveLength(1);

    const blocked = await readRuntimeAttestationStatus({
      redis,
      identity: IDENTITY,
      expected: LIVE,
      now: AT,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.reasonCode).toBe("RUNTIME_ATTESTATION_MISSING");
    expect(blocked.message).toContain("WORKER");

    // Repeated beats keep it withdrawn without re-announcing it.
    await publisher.publishOnce();
    expect(withdrawals).toHaveLength(1);

    // And recovery re-attests without a restart.
    healthy = true;
    await publisher.publishOnce();
    const restored = await readRuntimeAttestationStatus({
      redis,
      identity: IDENTITY,
      expected: LIVE,
      now: AT,
    });
    expect(restored.ok).toBe(true);
  });

  it("F2. withdrawal changes only presence — never the attested payload", async () => {
    const redis = new FakeRedis();
    let healthy = true;
    const publisher = createRuntimeAttestationPublisher({
      role: "WORKER",
      redis,
      identity: IDENTITY,
      gates: LIVE,
      now: () => AT,
      healthy: () => healthy,
    });

    await publisher.publishOnce();
    const before = redis.store.get(publisher.key) as string;
    healthy = false;
    await publisher.publishOnce();
    healthy = true;
    await publisher.publishOnce();

    // Same instanceId, same frozen gates — a withdrawal is not a restart.
    expect(redis.store.get(publisher.key)).toBe(before);
  });

  it("F3. the BACKEND publisher declares no health predicate", () => {
    // The backend runs no reconciliation, so it has nothing to report and must
    // not start withdrawing for a condition it cannot observe.
    const server = readFileSync(path.join(BACKEND, "src/server.ts"), "utf8");
    const publisher = server.slice(server.indexOf("createRuntimeAttestationPublisher({"));
    expect(publisher.slice(0, publisher.indexOf("});"))).not.toContain("healthy:");
  });

  it("F4. the WORKER publisher is wired to reconciliation health", () => {
    const worker = readFileSync(path.join(BACKEND, "src/modules/jobs/execution.worker.ts"), "utf8");
    const publisher = worker.slice(worker.indexOf("createRuntimeAttestationPublisher({"));
    expect(publisher).toContain("healthy: isReconciliationHealthy");
  });

  it("F4b. the withdrawal ERROR carries the same safe guidance as the stall ERROR", () => {
    // These two fire together. Fixing only one would put the safe wording and
    // the unsafe wording side by side in the same incident log.
    const worker = readFileSync(path.join(BACKEND, "src/modules/jobs/execution.worker.ts"), "utf8");
    // `onError:` also appears earlier, on the connection factory, so the end of
    // the block is the first one AFTER the withdrawal handler begins.
    const start = worker.indexOf("onWithdraw:");
    const withdrawal = worker.slice(start, worker.indexOf("onError:", start));

    expect(withdrawal).toContain("new live activation is blocked");
    expect(withdrawal).toContain("Controlled worker recovery is required");
    expect(withdrawal).toContain("do NOT start another runtime stack");
    for (const forbidden of ["Restart the worker", "restart the worker"]) {
      expect(`${forbidden}:${withdrawal.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("F5. attestation is still absent from every execution-authority module", () => {
    // Withdrawal must gate ARMING only. Protection and reconciliation of an
    // already-admitted execution must never depend on a heartbeat.
    for (const file of [
      "safety-engine.ts",
      "safety-admission.service.ts",
      "execution-orchestrator.ts",
      "protection-lifecycle.service.ts",
      "entry-lifecycle.service.ts",
    ]) {
      const code = readFileSync(path.join(BACKEND, "src/modules/execution", file), "utf8");
      expect(`${file}:${code.includes("runtime-attestation")}`).toBe(`${file}:false`);
    }
    // The scheduler exposes health; it does not read or publish attestation.
    const scheduler = readFileSync(
      path.join(BACKEND, "src/modules/jobs/execution-orchestration.scheduler.ts"),
      "utf8"
    );
    expect(scheduler).not.toContain("runtime-attestation");
  });
});

// ---------------------------------------------------------------------------
// The launcher no longer implies health from a PID
// ---------------------------------------------------------------------------

describe("worker liveness: the launcher separates process from health", () => {
  const base = {
    diskMode: "LIVE_READY" as const,
    backendPortOpen: true,
    frontendPortOpen: true,
    operatorToken: "CONFIGURED" as const,
  };
  const role = (freshCount: number) => ({ freshCount, gates: null });

  it("reports the incident state as ON but STALE", () => {
    const view = presentStatus({
      ...base,
      running: { backend: true, worker: true, frontend: true },
      attestationRoles: { backend: role(1), worker: role(0) },
    });
    expect(view.worker).toBe("ON");
    expect(view.health.worker).toBe("STALE");
    expect(view.health.backend).toBe("HEALTHY");

    const rendered = renderStatus(view).join("\n");
    expect(rendered).toContain("process ON");
    expect(rendered).toContain("health STALE");
    expect(rendered).toContain("WORKER process is running but not attesting");
  });

  // -------------------------------------------------------------------------
  // Operator guidance.
  //
  // Human review caught the first version of this warning ending
  // "Restart the runtime." In the exact state it fires, that is guidance the
  // launcher cannot honour: Stop is refused while an execution is active and
  // Start is refused while a launcher-owned process is alive. Naming a generic
  // restart invites an operator to force the one action that is genuinely
  // unsafe — a second stack — and no guard should have to be the thing that
  // saves them from following the tool's own advice.
  // -------------------------------------------------------------------------

  it("never tells the operator to blindly restart the runtime", () => {
    const text = describeStaleHealth(
      presentStatus({
        ...base,
        running: { backend: true, worker: true, frontend: true },
        attestationRoles: { backend: role(1), worker: role(0) },
      })
    ).join("\n");

    for (const forbidden of [
      "Restart the runtime",
      "restart the runtime",
      "Restart the stack",
    ]) {
      expect(`${forbidden}:${text.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("warns that execution reconciliation may be impaired", () => {
    const text = describeStaleHealth(
      presentStatus({
        ...base,
        running: { backend: true, worker: true, frontend: true },
        attestationRoles: { backend: role(1), worker: role(0) },
      })
    ).join("\n");

    expect(text).toContain("Execution reconciliation may be impaired");
    expect(text).toContain("protection orders may not be maintained");
    expect(text).toContain("keep new trading blocked");
  });

  it("tells the operator NOT to start a second stack, and says both controls refuse", () => {
    const text = describeStaleHealth(
      presentStatus({
        ...base,
        running: { backend: true, worker: true, frontend: true },
        attestationRoles: { backend: role(1), worker: role(0) },
      })
    ).join("\n");

    expect(text).toContain("Do NOT Start SAFE or Start LIVE-READY");
    expect(text).toContain("Stop Runtime & Return SAFE is refused");
    // Never phrased as a recommendation to start anything.
    expect(text).not.toMatch(/(?<!Do NOT )Start LIVE-READY (again|now|to)/);
  });

  it("the guidance is TRUE: the launcher really does refuse a second start", () => {
    // The warning asserts the launcher refuses. Prove that against the real
    // guard rather than trusting the prose to stay in step with it.
    const owned = evaluateStartPreconditions({
      recordedProcessesAlive: 1,
      backendPortOpen: true,
      frontendPortOpen: true,
    });
    expect(owned.ok).toBe(false);
    expect(owned.ok === false && owned.reason).toContain("already running");
  });

  it("blames the right role — a stale BACKEND does not claim reconciliation stopped", () => {
    const text = describeStaleHealth(
      presentStatus({
        ...base,
        running: { backend: true, worker: true, frontend: true },
        attestationRoles: { backend: role(0), worker: role(1) },
      })
    ).join("\n");

    expect(text).toContain("BACKEND process is running but not attesting");
    expect(text).not.toContain("Execution reconciliation may be impaired");
    expect(text).toContain("Activation readiness cannot be confirmed");
  });

  it("HEALTHY produces no warning at all", () => {
    const view = presentStatus({
      ...base,
      running: { backend: true, worker: true, frontend: true },
      attestationRoles: { backend: role(1), worker: role(1) },
    });
    expect(describeStaleHealth(view)).toEqual([]);
    expect(renderStatus(view).join("\n")).not.toContain("WARNING: the");
  });

  it("DUPLICATE is reported as its own state, not folded into STALE", () => {
    const view = presentStatus({
      ...base,
      running: { backend: true, worker: true, frontend: true },
      attestationRoles: { backend: role(1), worker: role(2) },
    });
    expect(view.health.worker).toBe("DUPLICATE");
    expect(describeStaleHealth(view)).toEqual([]);
  });

  it("says UNKNOWN rather than HEALTHY when attestation could not be read", () => {
    const view = presentStatus({
      ...base,
      running: { backend: true, worker: true, frontend: true },
      attestationRoles: null,
    });
    expect(view.health.worker).toBe("UNKNOWN");
    // An unreadable attestation store is never presented as proof that the
    // worker itself went silent, so it raises no stale guidance.
    expect(describeStaleHealth(view)).toEqual([]);
    expect(renderStatus(view).join("\n")).not.toContain("running but not attesting");
  });

  it("judges each role from ownership AND its heartbeat", () => {
    expect(judgeRoleHealth(false, role(0))).toBe("OFF");
    expect(judgeRoleHealth(false, null)).toBe("OFF");
    expect(judgeRoleHealth(true, null)).toBe("UNKNOWN");
    expect(judgeRoleHealth(true, role(0))).toBe("STALE");
    expect(judgeRoleHealth(true, role(1))).toBe("HEALTHY");
    expect(judgeRoleHealth(true, role(2))).toBe("DUPLICATE");
  });

  it("still renders no secret", () => {
    const rendered = renderStatus(
      presentStatus({
        ...base,
        running: { backend: true, worker: true, frontend: true },
        attestation: "BLOCKED",
        attestationRoles: { backend: role(1), worker: role(0) },
      })
    ).join("\n");
    for (const secret of ["postgresql://", "redis://", "operator-token", "password"]) {
      expect(`${secret}:${rendered.includes(secret)}`).toBe(`${secret}:false`);
    }
  });
});
