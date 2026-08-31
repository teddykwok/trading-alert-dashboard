import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RUNTIME_ATTESTATION_SCHEMA_VERSION,
  createRuntimeAttestationPublisher,
  readRuntimeDeploymentAttestationStatus,
  type ReconciliationAttestation,
  type RuntimeAttestationRedis,
  type RuntimeGateSnapshot,
} from "../src/modules/runtime/runtime-attestation";
import {
  reconciliationAttestation,
  reconciliationHealth,
  resetOrchestrationTickGuardForTests,
  runReconciliationTickOnce,
  runStartupRecoveryOnce,
} from "../src/modules/jobs/execution-orchestration.scheduler";
import type { ExecutionOrchestrator } from "../src/modules/execution/execution-orchestrator";

/**
 * Whether reconciliation is actually TICKING, as attested.
 *
 * `lastSeenAt` proves a process is publishing. For the WORKER that is a
 * different question from whether it is doing its job, and until now the two
 * were indistinguishable from outside the process: `reconciliationHealth()`
 * reports healthy whenever no pass is IN FLIGHT, which is equally true of a
 * worker mid-interval and a worker that has never run a pass at all.
 *
 * An investigation lost real time to that gap. These tests pin the distinction
 * so it cannot close again.
 *
 * Pure — no Redis server, no database, no timers left running.
 */

const GATES: RuntimeGateSnapshot = {
  globalKillSwitch: true,
  liveEntryEnabled: false,
  protectionReady: false,
  accountSetupMutationsEnabled: false,
  testOrderEnabled: false,
  autoAddMarginEnabled: false,
  emergencyCloseMode: "DISABLED",
};

const IDENTITY = { accountIdentifier: "synthetic-account", environment: "TESTNET" };

/** The two commands the publisher uses, with everything it wrote kept. */
function fakeRedis() {
  const store = new Map<string, string>();
  const redis: RuntimeAttestationRedis = {
    async set(key, value) {
      store.set(key, value);
      return "OK";
    },
    async del(key) {
      store.delete(key);
      return 1;
    },
    async scan(_cursor, _m, pattern, _c, _count) {
      const prefix = pattern.replace(/\*$/, "");
      return ["0", [...store.keys()].filter((key) => key.startsWith(prefix))];
    },
    async get(key) {
      return store.get(key) ?? null;
    },
  };
  return { redis, store };
}

/** An orchestrator whose tick behaviour each test scripts. */
function orchestratorReturning(
  result: Partial<{
    inspected: number;
    advanced: number;
    progressed: number;
    mutationsDispatched: number;
    recoveryPending: number;
    failed: boolean;
  }> = {},
  options: { throws?: boolean; hangs?: boolean } = {}
) {
  const full = {
    inspected: 0,
    advanced: 0,
    progressed: 0,
    mutationsDispatched: 0,
    recoveryPending: 0,
    failed: false,
    ...result,
  };
  const run = async () => {
    if (options.throws) throw new Error("tick exploded");
    if (options.hangs) await new Promise(() => undefined);
    return full;
  };
  return {
    runExecutionReconciliationTick: run,
    runStartupRecovery: run,
  } as unknown as ExecutionOrchestrator;
}

beforeEach(() => {
  resetOrchestrationTickGuardForTests();
});

afterEach(() => {
  resetOrchestrationTickGuardForTests();
  vi.restoreAllMocks();
});

// ===========================================================================
// T1 / T2 / T3 — the timestamps
// ===========================================================================

describe("T1-T3. reconciliation tick timestamps", () => {
  it("T1. before any pass, nothing is claimed", () => {
    const telemetry = reconciliationAttestation();
    expect(telemetry.lastTickStartedAt).toBeNull();
    expect(telemetry.lastTickCompletedAt).toBeNull();
    expect(telemetry.lastTickTrigger).toBeNull();
    expect(telemetry.lastTickResult).toBeNull();
  });

  it("T2. a startup pass populates both timestamps and names itself STARTUP", async () => {
    await runStartupRecoveryOnce(orchestratorReturning({ inspected: 3 }));

    const telemetry = reconciliationAttestation();
    expect(telemetry.lastTickStartedAt).not.toBeNull();
    expect(telemetry.lastTickCompletedAt).not.toBeNull();
    expect(telemetry.lastTickTrigger).toBe("STARTUP");
    // Both are ISO, matching every other attestation timestamp.
    expect(Number.isNaN(Date.parse(telemetry.lastTickStartedAt!))).toBe(false);
    expect(Number.isNaN(Date.parse(telemetry.lastTickCompletedAt!))).toBe(false);
    // Completion cannot precede the start it belongs to.
    expect(Date.parse(telemetry.lastTickCompletedAt!)).toBeGreaterThanOrEqual(
      Date.parse(telemetry.lastTickStartedAt!)
    );
  });

  it("T3. a later periodic pass advances them and re-labels the trigger", async () => {
    await runStartupRecoveryOnce(orchestratorReturning({ inspected: 3 }));
    const afterStartup = reconciliationAttestation();

    // A real clock gap, so "advanced" is measurable rather than coincidental.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runReconciliationTickOnce(orchestratorReturning({ inspected: 7 }));
    const afterPeriodic = reconciliationAttestation();

    expect(Date.parse(afterPeriodic.lastTickStartedAt!)).toBeGreaterThan(
      Date.parse(afterStartup.lastTickStartedAt!)
    );
    expect(Date.parse(afterPeriodic.lastTickCompletedAt!)).toBeGreaterThan(
      Date.parse(afterStartup.lastTickCompletedAt!)
    );
    expect(afterPeriodic.lastTickTrigger).toBe("PERIODIC");
    // "Startup ran, the interval never fired" is exactly what this makes
    // readable, so the two must remain distinguishable.
    expect(afterStartup.lastTickTrigger).toBe("STARTUP");
  });
});

// ===========================================================================
// T4 / T9 — what must NOT count as a completion
// ===========================================================================

describe("T4/T9. only a finished pass advances the completed timestamp", () => {
  it("T4. a pass that throws advances started, never completed", async () => {
    await runStartupRecoveryOnce(orchestratorReturning({ inspected: 1 }));
    const before = reconciliationAttestation();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // runSingleFlight catches, so this resolves — but nothing completed.
    await runReconciliationTickOnce(orchestratorReturning({}, { throws: true }));

    const after = reconciliationAttestation();
    expect(Date.parse(after.lastTickStartedAt!)).toBeGreaterThan(
      Date.parse(before.lastTickStartedAt!)
    );
    // Unmoved: the gap between started and completed is the signal.
    expect(after.lastTickCompletedAt).toBe(before.lastTickCompletedAt);
    expect(after.lastTickResult).toEqual(before.lastTickResult);
  });

  it("T4b. a tick that reports failed does not publish its counters", async () => {
    // The tick catches its own errors and returns `failed: true` rather than
    // throwing. That is not a completed pass either.
    await runReconciliationTickOnce(orchestratorReturning({ inspected: 9, failed: true }));

    const telemetry = reconciliationAttestation();
    expect(telemetry.lastTickStartedAt).not.toBeNull();
    expect(telemetry.lastTickCompletedAt).toBeNull();
    expect(telemetry.lastTickResult).toBeNull();
  });

  it("T9. a suppressed overlapping pass fabricates no start and no completion", async () => {
    await runReconciliationTickOnce(orchestratorReturning({ inspected: 2 }));
    const before = reconciliationAttestation();

    // Leave a pass in flight, then ask for another: the guard refuses it.
    const hanging = runReconciliationTickOnce(orchestratorReturning({}, { hangs: true }));
    void hanging;
    const startedByHang = reconciliationAttestation().lastTickStartedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await runReconciliationTickOnce(orchestratorReturning({ inspected: 99 }));

    const after = reconciliationAttestation();
    // The suppressed pass changed nothing at all.
    expect(after.lastTickStartedAt).toBe(startedByHang);
    expect(after.lastTickCompletedAt).toBe(before.lastTickCompletedAt);
    expect(after.lastTickResult?.inspected).toBe(2);
  });
});

// ===========================================================================
// T5 — the regression the whole file exists for
// ===========================================================================

describe("T5. heartbeat activity is not reconciliation activity", () => {
  it("T5. lastSeenAt advances while the tick timestamps stay absent", async () => {
    const { redis, store } = fakeRedis();
    const publisher = createRuntimeAttestationPublisher({
      role: "WORKER",
      redis,
      identity: IDENTITY,
      gates: GATES,
      reconciliation: reconciliationAttestation,
    });

    await publisher.publishOnce();
    const first = JSON.parse([...store.values()][0]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await publisher.publishOnce();
    const second = JSON.parse([...store.values()][0]);

    // The heartbeat is unmistakably alive...
    expect(Date.parse(second.lastSeenAt)).toBeGreaterThan(Date.parse(first.lastSeenAt));
    // ...and reconciliation has provably never run. Before this field existed,
    // these two payloads were identical in every respect that mattered, and a
    // worker that never ticked looked exactly like a healthy one.
    expect(second.reconciliation.lastTickStartedAt).toBeNull();
    expect(second.reconciliation.lastTickCompletedAt).toBeNull();
    expect(second.reconciliation.lastTickResult).toBeNull();
    // And health still says healthy, which is precisely why it is not enough.
    expect(reconciliationHealth().healthy).toBe(true);
  });

  it("T5b. once a pass completes, the same payload proves it", async () => {
    const { redis, store } = fakeRedis();
    const publisher = createRuntimeAttestationPublisher({
      role: "WORKER",
      redis,
      identity: IDENTITY,
      gates: GATES,
      reconciliation: reconciliationAttestation,
    });

    await runReconciliationTickOnce(
      orchestratorReturning({ inspected: 4, advanced: 2, progressed: 1, recoveryPending: 3 })
    );
    await publisher.publishOnce();

    const payload = JSON.parse([...store.values()][0]) as {
      reconciliation: ReconciliationAttestation;
    };
    expect(payload.reconciliation.lastTickCompletedAt).not.toBeNull();
    expect(payload.reconciliation.lastTickTrigger).toBe("PERIODIC");
    expect(payload.reconciliation.lastTickResult).toEqual({
      inspected: 4,
      attempted: 2,
      progressed: 1,
      recoveryPending: 3,
    });
  });
});

// ===========================================================================
// T6 / T7 — compatibility
// ===========================================================================

describe("T6-T7. the attestation contract is unchanged", () => {
  it("T6. a BACKEND payload carries no reconciliation field and stays valid", async () => {
    const { redis, store } = fakeRedis();
    const publisher = createRuntimeAttestationPublisher({
      role: "BACKEND",
      redis,
      identity: IDENTITY,
      gates: GATES,
      // No `reconciliation` provider: the backend runs no scheduler.
    });

    await publisher.publishOnce();
    const payload = JSON.parse([...store.values()][0]);

    expect(payload.role).toBe("BACKEND");
    expect("reconciliation" in payload).toBe(false);
    expect(payload.schemaVersion).toBe(RUNTIME_ATTESTATION_SCHEMA_VERSION);
  });

  it("T7. the schema version is unchanged and both shapes still read back", async () => {
    // Optional fields only: the parser validates what it requires and passes
    // the rest through, so no version bump is needed and none is made.
    expect(RUNTIME_ATTESTATION_SCHEMA_VERSION).toBe(1);

    const { redis } = fakeRedis();
    const backend = createRuntimeAttestationPublisher({
      role: "BACKEND", redis, identity: IDENTITY, gates: GATES,
    });
    const worker = createRuntimeAttestationPublisher({
      role: "WORKER", redis, identity: IDENTITY, gates: GATES,
      reconciliation: reconciliationAttestation,
    });
    await backend.publishOnce();
    await worker.publishOnce();

    // The DEPLOYMENT reader, which answers "are both roles present and in
    // agreement?". Not the arming reader, which additionally demands LIVE
    // gates and correctly refuses these SAFE ones.
    const status = await readRuntimeDeploymentAttestationStatus({
      redis, identity: IDENTITY, expected: GATES,
    });

    // The existing reader is untouched by the new field.
    expect(status.ok).toBe(true);
    expect(status.backend.freshCount).toBe(1);
    expect(status.worker.freshCount).toBe(1);
  });

  it("T7b. a payload WITHOUT the field is still accepted by the reader", async () => {
    // Exactly what an older worker publishes. Written directly so the test
    // does not depend on being able to construct an old publisher.
    const { redis, store } = fakeRedis();
    const legacy = {
      schemaVersion: RUNTIME_ATTESTATION_SCHEMA_VERSION,
      role: "WORKER",
      instanceId: "legacy01",
      startedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      accountIdentifier: IDENTITY.accountIdentifier,
      environment: IDENTITY.environment,
      gates: GATES,
    };
    store.set(
      `runtime:attestation:${IDENTITY.accountIdentifier}:${IDENTITY.environment}:WORKER:legacy01`,
      JSON.stringify(legacy)
    );
    const backend = createRuntimeAttestationPublisher({
      role: "BACKEND", redis, identity: IDENTITY, gates: GATES,
    });
    await backend.publishOnce();

    const status = await readRuntimeDeploymentAttestationStatus({
      redis, identity: IDENTITY, expected: GATES,
    });
    expect(status.ok).toBe(true);
    expect(status.worker.freshCount).toBe(1);
  });
});

// ===========================================================================
// T8 / T10 — counters, and the health contract
// ===========================================================================

describe("T8/T10. counters and unchanged health semantics", () => {
  it("T8. counters describe the most recently COMPLETED pass only", async () => {
    await runReconciliationTickOnce(
      orchestratorReturning({ inspected: 10, advanced: 5, progressed: 5, recoveryPending: 0 })
    );
    expect(reconciliationAttestation().lastTickResult).toEqual({
      inspected: 10, attempted: 5, progressed: 5, recoveryPending: 0,
    });

    // A failing pass must not overwrite them with its own numbers.
    await runReconciliationTickOnce(
      orchestratorReturning({ inspected: 99, advanced: 99, progressed: 99, recoveryPending: 99, failed: true })
    );
    expect(reconciliationAttestation().lastTickResult).toEqual({
      inspected: 10, attempted: 5, progressed: 5, recoveryPending: 0,
    });

    // A later good pass replaces them wholesale.
    await runReconciliationTickOnce(
      orchestratorReturning({ inspected: 1, advanced: 0, progressed: 0, recoveryPending: 2 })
    );
    expect(reconciliationAttestation().lastTickResult).toEqual({
      inspected: 1, attempted: 0, progressed: 0, recoveryPending: 2,
    });
  });

  it("T10. stall health is untouched by this change", () => {
    // Nothing here gates activation. Health still answers only "is a pass
    // hung?", so a SAFE start whose first tick has not happened yet is not
    // made to look unfit.
    const idle = reconciliationHealth();
    expect(idle.healthy).toBe(true);
    expect(idle.inFlight).toBe(false);
    expect(idle.runningForMs).toBe(0);
    expect(idle.label).toBeNull();
  });

  it("T10b. a pass in flight is still reported as in flight", async () => {
    void runReconciliationTickOnce(orchestratorReturning({}, { hangs: true }));
    // Let the guard take hold.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const health = reconciliationHealth();
    expect(health.inFlight).toBe(true);
    expect(health.label).toBe("reconciliation tick");
    // Still healthy: three minutes is the stall threshold, not five ms.
    expect(health.healthy).toBe(true);
  });
});
