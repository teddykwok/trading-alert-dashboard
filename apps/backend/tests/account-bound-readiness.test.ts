import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isReconciliationHealthy,
  reconciliationAttestation,
  reconciliationHealth,
  resetOrchestrationTickGuardForTests,
  runStartupRecoveryOnce,
  startExecutionOrchestrationScheduler,
} from "../src/modules/jobs/execution-orchestration.scheduler";
import { testBoundRuntime } from "./helpers/bound-runtime";

/**
 * Phase 11D final gate — a process may not advertise execution readiness
 * before its account-bound runtime exists.
 *
 * This is RUNTIME state, not wiring, and the distinction is the whole point.
 * Before 11D orchestration started at module load, so "no pass is in flight"
 * could only mean the healthy idle gap between ticks. It now starts behind an
 * account-binding barrier, and a process whose binding FAILED has no scheduler
 * at all -- which also has no pass in flight. From outside, a worker that
 * never bound an account and a healthy idle one would have looked identical,
 * and an operator arms real trading over that answer.
 *
 * `isReconciliationHealthy` is the predicate the attestation publisher
 * consults; the publisher stops asserting a fresh runtime of this role the
 * moment it returns false, and the activation interlock requires exactly one
 * fresh WORKER. So these three cases are the readiness chain end to end.
 */

describe("execution readiness follows the account-bound runtime", () => {
  beforeEach(() => {
    // A fresh process, as far as this module's state is concerned.
    resetOrchestrationTickGuardForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetOrchestrationTickGuardForTests();
  });

  it("A. while binding is PENDING, readiness is false", () => {
    // The barrier has not resolved, so the scheduler was never started. No
    // pass is in flight -- and that must not read as healthy.
    expect(reconciliationHealth().inFlight).toBe(false);
    expect(isReconciliationHealthy()).toBe(false);
  });

  it("A. and the reconciliation attestation shows no pass has begun", () => {
    const attestation = reconciliationAttestation();
    expect(attestation.lastTickStartedAt).toBeNull();
    expect(attestation.lastTickCompletedAt).toBeNull();
    expect(attestation.lastTickResult).toBeNull();
  });

  it("B. when binding FAILS and the scheduler never starts, readiness stays false", async () => {
    // The bootstrap's failure path: it returns before
    // startExecutionOrchestrationScheduler is ever called. Nothing else in the
    // worker can set this state, so simply not calling it IS that scenario.
    expect(isReconciliationHealthy()).toBe(false);

    // Even after time passes and other worker duties run.
    await Promise.resolve();
    expect(isReconciliationHealthy()).toBe(false);

    // And the stall detector still answers its own, different question: there
    // is no stalled pass, because there is no pass.
    expect(reconciliationHealth().healthy).toBe(true);
  });

  it("C. readiness becomes true only after the scheduler is started FROM a runtime", () => {
    expect(isReconciliationHealthy()).toBe(false);

    const timer = startExecutionOrchestrationScheduler(testBoundRuntime(), 60_000);
    try {
      expect(isReconciliationHealthy()).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });

  it("C. and it reverts to false for a fresh process that has not bound", () => {
    const timer = startExecutionOrchestrationScheduler(testBoundRuntime(), 60_000);
    clearInterval(timer);
    expect(isReconciliationHealthy()).toBe(true);

    // A restart whose binding fails must not inherit the previous answer.
    resetOrchestrationTickGuardForTests();
    expect(isReconciliationHealthy()).toBe(false);
  });

  it("a started-but-STALLED runtime is still unhealthy, as it always was", async () => {
    const timer = startExecutionOrchestrationScheduler(testBoundRuntime(), 60_000);
    try {
      // A pass that begins and never finishes: the pre-existing stall rule.
      let release: (() => void) | null = null;
      const hanging = runStartupRecoveryOnce({
        runStartupRecovery: async () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                inspected: 0,
                advanced: 0,
                progressed: 0,
                mutationsDispatched: 0,
                recoveryPending: 0,
                reconcilableTotal: null,
                cursorActive: false,
                failed: false,
                rows: [],
              });
          }),
      } as never);

      // Far beyond RECONCILIATION_STALL_MS.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
      expect(isReconciliationHealthy()).toBe(false);

      vi.restoreAllMocks();
      release?.();
      await hanging;
    } finally {
      clearInterval(timer);
    }
  });
});

describe("the readiness precondition cannot be set by anything else", () => {
  it("only starting the scheduler sets it, and only a reset clears it", () => {
    const source = readSchedulerSource();
    // The declaration, the start, and the test reset. Nothing else may
    // write it -- a fourth assignment is a new way to claim readiness.
    const assignments = source.match(/orchestrationStarted\s*=/g) ?? [];
    expect(assignments).toHaveLength(3);
    expect(source).toContain("let orchestrationStarted = false;");
    expect(source).toContain("orchestrationStarted = true;");
    expect(source).toContain("orchestrationStarted = false;");
    // Read by the readiness predicate, and by nothing that could widen it.
    expect(source).toContain("return orchestrationStarted && reconciliationHealth().healthy;");
  });

  it("the stall detector is deliberately NOT gated, so logs keep their meaning", () => {
    const source = readSchedulerSource();
    const at = source.indexOf("export function reconciliationHealth(");
    const body = source.slice(at, source.indexOf("\n}", at));
    expect(body).not.toContain("orchestrationStarted");
  });
});

function readSchedulerSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const backend = process.cwd().endsWith(path.join("apps", "backend"))
    ? process.cwd()
    : path.join(process.cwd(), "apps", "backend");
  return readFileSync(
    path.join(backend, "src", "modules", "jobs", "execution-orchestration.scheduler.ts"),
    "utf8"
  );
}
