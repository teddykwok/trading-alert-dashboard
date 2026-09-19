import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ExecutionOrchestrator,
  RECONCILABLE_STATUSES,
  RECOVERY_REQUIRED_STATUSES,
} from "../src/modules/execution/execution-orchestrator";
import { env } from "../src/config/env";

/**
 * Phase 11A.1 orchestration tests.
 *
 * Every lifecycle service is a recording fake, so what is proven here is the
 * ORCHESTRATION: which existing call runs for which persisted state, that new
 * work is refused while recovery is outstanding, and that no duplicate request
 * is produced. No Binance transport of any kind is constructed.
 */

const BACKEND = process.cwd();

/** Strips comments so a source assertion measures CODE, not documentation. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ---------------------------------------------------------------------------
// Recording fakes
// ---------------------------------------------------------------------------

interface Call {
  service: string;
  method: string;
  executionId: string;
  expectedVersion: number;
  /** Present only for entry cancellation, and the whole point of it. */
  recoveryReason?: string;
}

function harness(options: {
  executions?: Array<Record<string, unknown>>;
  recoveryCount?: number;
  profile?: { id: string; found: boolean };
  admissionDecision?: string;
  mutationsPerCall?: number;
  /** Status the closure reconciliation leaves the execution in. */
  closureResultStatus?: string;
  /**
   * Status an ENTRY call leaves the execution in.
   *
   * The real `reconcileEntryOrder` / `resumeEntrySubmission` return the row
   * they just committed, so a fill discovered during the call comes back as a
   * changed status. Without this the fake could only ever echo the status the
   * tick started with, which is exactly the case the same-tick protection path
   * must NOT fire on.
   */
  entryResultStatus?: string;
  /** Authoritative open-position count the soft-target check reads. */
  openPositionCount?: number;
  /** Effective soft target on the profile's policy row. */
  softOpenPositionTarget?: number;
  /** null = no policy row exists for the profile. */
  policyRow?: null;
  /** Reason code the closure reconciliation returns. */
  closureReasonCode?: string;
  /** Position observation the closure reconciliation reports. */
  closurePositionObservation?: "FLAT" | "NON_ZERO" | "UNAVAILABLE" | "NOT_READ";
  /** Execution id whose reconciliation throws, to exercise error capture. */
  throwForExecutionId?: string;
} = {}) {
  const calls: Call[] = [];
  const executions = options.executions ?? [];
  const mutations = options.mutationsPerCall ?? 0;
  const profileId = options.profile?.id ?? "profile-1";

  const record =
    (service: string, method: string) =>
    async (input: { executionId: string; expectedVersion: number; recoveryReason?: string }) => {
      calls.push({
        service,
        method,
        executionId: input.executionId,
        expectedVersion: input.expectedVersion,
        recoveryReason: input.recoveryReason,
      });
    // The routing for PROTECTED branches on the status the call LEAVES the
    // execution in, so the stub has to model it. `closureResultStatus` lets a
    // test say "this reconciliation terminalized or escalated".
    const source = executions.find((row: { id: string }) => row.id === input.executionId);
    const entryCall = method === "reconcileEntryOrder" || method === "resumeEntrySubmission";
    const status =
      method === "reconcileProtectionAndClosure" && options.closureResultStatus !== undefined
        ? options.closureResultStatus
        : entryCall && options.entryResultStatus !== undefined
          ? options.entryResultStatus
          : (source?.status as string | undefined);
    if (options.throwForExecutionId === input.executionId) {
      throw new TypeError("stubbed reconciliation failure");
    }
    return {
      mutationsDispatched: mutations,
      execution: { id: input.executionId, version: input.expectedVersion + 1, status },
      reasonCode:
        method === "reconcileProtectionAndClosure" && options.closureReasonCode !== undefined
          ? options.closureReasonCode
          : "OK",
      ...(method === "reconcileProtectionAndClosure" && options.closurePositionObservation !== undefined
        ? { positionObservation: options.closurePositionObservation }
        : {}),
    };
  };

  const prisma = {
    tradeExecution: {
      findMany: async () => executions,
      findUnique: async ({ where }: { where: { id: string } }) =>
        executions.find((e) => e.id === where.id) ?? null,
      // Two different counts share this stub: the recovery-required count and
      // the soft-target open-position count. `options.openPositionCount`
      // selects the latter, so a scenario can put the profile at its soft
      // target without inventing a second stub shape.
      count: async (args?: { where?: { status?: { in?: string[] } } }) =>
        args?.where?.status?.in?.includes("PROTECTED") && args.where.status.in.includes("ENTRY_FILLED")
          ? (options.openPositionCount ?? 0)
          : (options.recoveryCount ?? 0),
    },
    executionSafetyPolicy: {
      findUnique: async () =>
        options.policyRow === null
          ? null
          : {
              maxOpenPositions: 5,
              maxPendingEntries: 5,
              maxTotalActiveTrades: 5,
              maxActivePerSymbolSide: 1,
              maxAlertAgeSeconds: 300,
              softOpenPositionTarget: options.softOpenPositionTarget ?? 5,
              maxTotalPlannedRiskUsd: { toString: () => "7.50" },
              maxTotalIsolatedMarginUsd: { toString: () => "40.00" },
            },
    },
    executionProfile: {
      findMany: async () =>
        options.profile?.found === false
          ? []
          : [{ id: profileId, accountIdentifier: "alias", environment: "TESTNET", safetyPolicy: { id: "policy-1" } }],
    },
  } as never;

  const orchestrator = new ExecutionOrchestrator({
    prisma,
    readOnly: {} as never,
    admission: {
      evaluateAndReserveSafetyAdmission: async (input: { executionId: string; expectedVersion: number }) => {
        calls.push({
          service: "admission",
          method: "evaluateAndReserve",
          executionId: input.executionId,
          expectedVersion: input.expectedVersion,
        });
        return {
          decision: options.admissionDecision ?? "PASS",
          reasonCode: "CAPACITY_AVAILABLE",
          execution: { id: input.executionId, version: input.expectedVersion + 1 },
        };
      },
    } as never,
    entry: {
      prepareEntrySubmission: record("entry", "prepareEntrySubmission"),
      resumeEntrySubmission: record("entry", "resumeEntrySubmission"),
      reconcileEntryOrder: record("entry", "reconcileEntryOrder"),
      expireEntryOrderIfDue: record("entry", "expireEntryOrderIfDue"),
      releaseUnrunnablePreflight: record("entry", "releaseUnrunnablePreflight"),
    } as never,
    protection: {
      ensureProtectionForExposure: record("protection", "ensureProtectionForExposure"),
      resumeProtectionLifecycle: record("protection", "resumeProtectionLifecycle"),
      reconcileProtectionAndClosure: record("protection", "reconcileProtectionAndClosure"),
      attemptProtectionRecovery: record("protection", "attemptProtectionRecovery"),
    } as never,
    profileIdentity: { accountIdentifier: "alias", environment: "TESTNET" },
  });

  return { orchestrator, calls, profileId };
}

const execution = (overrides: Record<string, unknown> = {}) => ({
  id: "exec-1",
  symbol: "SYNTHUSDT",
  version: 3,
  status: "PLAN_READY",
  executionProfileId: "profile-1",
  requiresManualIntervention: false,
  ...overrides,
});

// ---------------------------------------------------------------------------
// A. Signal admission
// ---------------------------------------------------------------------------

describe("signal admission", () => {
  it("routes an eligible PLAN_READY execution through safety admission then entry", async () => {
    const { orchestrator, calls } = harness({ executions: [execution()] });
    const result = await orchestrator.admitAndSubmit({ executionId: "exec-1" });

    expect(result.admitted).toBe(true);
    expect(calls.map((c) => `${c.service}.${c.method}`)).toEqual([
      "admission.evaluateAndReserve",
      "entry.prepareEntrySubmission",
    ]);
    // Admission is given the version actually read, so a concurrent writer
    // invalidates it rather than admitting on stale state.
    expect(calls[0].expectedVersion).toBe(3);
  });

  it("never reaches the entry lifecycle when admission does not PASS", async () => {
    for (const decision of ["SKIP", "UNAVAILABLE", "RETRY_CONFLICT"]) {
      const { orchestrator, calls } = harness({ executions: [execution()], admissionDecision: decision });
      const result = await orchestrator.admitAndSubmit({ executionId: "exec-1" });

      expect(result.admitted, decision).toBe(false);
      expect(calls.map((c) => c.service), decision).toEqual(["admission"]);
    }
  });

  it("admits an execution only once — a replayed delivery is a no-op", async () => {
    // The second delivery sees a status that already left PLAN_READY.
    const { orchestrator, calls } = harness({ executions: [execution({ status: "ENTRY_PENDING" })] });
    const result = await orchestrator.admitAndSubmit({ executionId: "exec-1" });

    expect(result.admitted).toBe(false);
    expect((result as { reasonCode: string }).reasonCode).toBe("NOT_PLAN_READY");
    expect(calls).toHaveLength(0);
  });

  it("blocks when no profile is configured or found", async () => {
    const { orchestrator, calls } = harness({ executions: [execution()], profile: { id: "x", found: false } });
    const result = await orchestrator.admitAndSubmit({ executionId: "exec-1" });
    expect(result.admitted).toBe(false);
    expect(["PROFILE_NOT_FOUND", "PROFILE_NOT_CONFIGURED"]).toContain((result as { reasonCode: string }).reasonCode);
    expect(calls).toHaveLength(0);
  });

  it("refuses an execution belonging to a different profile", async () => {
    const { orchestrator, calls } = harness({ executions: [execution({ executionProfileId: "other-profile" })] });
    const result = await orchestrator.admitAndSubmit({ executionId: "exec-1" });
    expect((result as { reasonCode: string }).reasonCode).toBe("PROFILE_MISMATCH");
    expect(calls).toHaveLength(0);
  });

  it("refuses new work while unresolved recovery exists", async () => {
    const { orchestrator, calls } = harness({ executions: [execution()], recoveryCount: 1 });
    const result = await orchestrator.admitAndSubmit({ executionId: "exec-1" });

    expect(result.admitted).toBe(false);
    expect((result as { reasonCode: string }).reasonCode).toBe("RECOVERY_REQUIRED");
    // Local capacity looking free is not the same as the exchange being flat.
    expect(calls).toHaveLength(0);
  });

  it("has no bypass parameter of any kind", () => {
    // CODE only: the doc comment names these words precisely to record that
    // no such parameter exists.
    const source = stripComments(
      readFileSync(path.join(BACKEND, "src", "modules", "execution", "execution-orchestrator.ts"), "utf8")
    );
    for (const forbidden of ["bypass", "skipSafety", "force", "ignoreSafety", "overrideGate"]) {
      expect(`${forbidden}:${source.toLowerCase().includes(forbidden.toLowerCase())}`).toBe(`${forbidden}:false`);
    }
  });
});

// ---------------------------------------------------------------------------
// B. Reconciliation routing
// ---------------------------------------------------------------------------

describe("reconciliation routing", () => {
  const route = async (status: string) => {
    const { orchestrator, calls } = harness({ executions: [execution({ status, version: 5 })] });
    await orchestrator.runExecutionReconciliationTick();
    return calls.map((c) => `${c.service}.${c.method}`);
  };

  it("resumes an ambiguous submission rather than submitting again", async () => {
    expect(await route("ENTRY_SUBMITTING")).toEqual(["entry.resumeEntrySubmission"]);
  });

  it("reconciles a resting order and then lets Phase 6 decide on TTL", async () => {
    expect(await route("ENTRY_PENDING")).toEqual(["entry.reconcileEntryOrder", "entry.expireEntryOrderIfDue"]);
  });

  it("reconciles the fill before protecting a partial position", async () => {
    // Order matters: protection must measure against the latest confirmed fill.
    expect(await route("PARTIALLY_FILLED")).toEqual([
      "entry.reconcileEntryOrder",
      "protection.ensureProtectionForExposure",
    ]);
  });

  it("reconciles closure BEFORE protecting a filled entry", async () => {
    // Same order as PLACING_PROTECTION and PROTECTED, and load-bearing for the
    // same reason: a position that filled and then closed appears on a real
    // exchange as a MISSING positionRisk row, and closure is the only path
    // that reads absence as flat. Protection reads it as
    // POSITION_NOT_FOUND_AFTER_FILL and parks the execution for a human
    // instead — a detour, when CLOSED_EXTERNAL is already a legal transition
    // straight from ENTRY_FILLED.
    expect(await route("ENTRY_FILLED")).toEqual([
      "protection.reconcileProtectionAndClosure",
      "protection.ensureProtectionForExposure",
    ]);
  });

  it("reconciles closure BEFORE resuming a half-finished protection tranche", async () => {
    // Same order, and same reason, as PROTECTED below. An entry that filled
    // and then closed on the exchange leaves the position flat, and closure is
    // the ONLY path that reads a missing position row as flat. Resuming first
    // sent that case to ensureProtectionForExposure, which parked it as
    // POSITION_NOT_FOUND_AFTER_FILL — or, when the row existed with quantity
    // zero, simply never progressed. Both left the execution holding capacity
    // forever after the trade was over.
    expect(await route("PLACING_PROTECTION")).toEqual([
      "protection.reconcileProtectionAndClosure",
      "protection.resumeProtectionLifecycle",
    ]);
  });

  it("watches a protected position for closure", async () => {
    // Closure FIRST (it owns the flat case), then the health/repair pass while
    // exposure remains. See the PROTECTED case in the orchestrator for why the
    // order is load-bearing.
    expect(await route("PROTECTED")).toEqual([
      "protection.reconcileProtectionAndClosure",
      "protection.ensureProtectionForExposure",
    ]);
  });

  // -------------------------------------------------------------------------
  // PROTECTED routing — the adversarial-review blocker.
  //
  // Closure reconciliation returns early while exposure remains and performs
  // NO coverage measurement, liquidation check, margin top-up or repair. If
  // PROTECTED routed only there, a stop cancelled out from under a live
  // position would never be detected. These pin both halves and their order.
  // -------------------------------------------------------------------------

  it("runs the health/repair pass after closure while a PROTECTED position is still open", async () => {
    const routed = await route("PROTECTED");
    // Closure must be FIRST: only it reads a missing positionRisk row as flat.
    expect(routed.indexOf("protection.reconcileProtectionAndClosure")).toBeLessThan(
      routed.indexOf("protection.ensureProtectionForExposure")
    );
    expect(routed).toContain("protection.ensureProtectionForExposure");
  });

  it("skips the health pass when closure already terminalized the execution", async () => {
    for (const terminal of ["CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY", "CLOSED_EXTERNAL"]) {
      const { orchestrator, calls } = harness({
        executions: [execution({ status: "PROTECTED", version: 5 })],
        closureResultStatus: terminal,
      });
      await orchestrator.runExecutionReconciliationTick();
      expect(calls.map((c) => `${c.service}.${c.method}`), terminal).toEqual([
        "protection.reconcileProtectionAndClosure",
      ]);
    }
  });

  it("skips the health pass when closure escalated to MANUAL_INTERVENTION", async () => {
    // A parked execution must not have protection auto-placed underneath it.
    const { orchestrator, calls } = harness({
      executions: [execution({ status: "PROTECTED", version: 5 })],
      closureResultStatus: "MANUAL_INTERVENTION",
    });
    await orchestrator.runExecutionReconciliationTick();
    expect(calls.map((c) => `${c.service}.${c.method}`)).toEqual(["protection.reconcileProtectionAndClosure"]);
  });

  it("threads the post-closure version into the health pass", async () => {
    const { orchestrator, calls } = harness({ executions: [execution({ status: "PROTECTED", version: 5 })] });
    await orchestrator.runExecutionReconciliationTick();

    const closure = calls.find((c) => c.method === "reconcileProtectionAndClosure")!;
    const health = calls.find((c) => c.method === "ensureProtectionForExposure")!;
    expect(closure.expectedVersion).toBe(5);
    // The health pass must not CAS against a version closure already consumed.
    expect(health.expectedVersion).toBe(6);
  });

  it("reconciles closure BEFORE considering recovery for a parked execution", async () => {
    // Same load-bearing order as PROTECTED: a flat position appears as a
    // MISSING position row, and only closure reads that as flat. Recovery must
    // never be the one to interpret that absence.
    expect(await route("MANUAL_INTERVENTION")).toEqual([
      "protection.reconcileProtectionAndClosure",
      "protection.attemptProtectionRecovery",
    ]);
  });

  it("never attempts recovery once closure has terminalized a parked execution", async () => {
    for (const terminal of ["CLOSED_TP", "CLOSED_SL", "CLOSED_EXTERNAL", "CLOSED_EMERGENCY"]) {
      const { orchestrator, calls } = harness({
        executions: [execution({ status: "MANUAL_INTERVENTION", version: 5 })],
        closureResultStatus: terminal,
      });
      await orchestrator.runExecutionReconciliationTick();
      expect(calls.map((c) => `${c.service}.${c.method}`), terminal).toEqual([
        "protection.reconcileProtectionAndClosure",
      ]);
    }
  });

  it("threads the post-closure version into the recovery attempt", async () => {
    const { orchestrator, calls } = harness({
      executions: [execution({ status: "MANUAL_INTERVENTION", version: 5 })],
    });
    await orchestrator.runExecutionReconciliationTick();

    expect(calls.find((c) => c.method === "reconcileProtectionAndClosure")!.expectedVersion).toBe(5);
    // Recovery must not CAS against a version closure already consumed.
    expect(calls.find((c) => c.method === "attemptProtectionRecovery")!.expectedVersion).toBe(6);
  });

  it("discovers a PREFLIGHT execution and routes it through the existing entry recovery", async () => {
    // The gap that stranded a real canary: PREFLIGHT was reconcilable in
    // `resumeEntrySubmission` but no tick ever looked for it.
    expect(RECONCILABLE_STATUSES).toContain("PREFLIGHT");
    expect(await route("PREFLIGHT")).toEqual([
      "entry.resumeEntrySubmission",
      "entry.releaseUnrunnablePreflight",
    ]);
  });

  it("gives PREFLIGHT no second order path of its own", () => {
    const source = stripComments(
      readFileSync(path.join(BACKEND, "src", "modules", "execution", "execution-orchestrator.ts"), "utf8")
    );
    const block = source.slice(source.indexOf('case "PREFLIGHT"'), source.indexOf('case "ENTRY_SUBMITTING"'));
    // Coordination only: it calls the lifecycle service and decides nothing.
    expect(block).toContain("this.deps.entry.resumeEntrySubmission(input)");
    expect(block).toContain("this.deps.entry.releaseUnrunnablePreflight(input)");
    expect(block).not.toMatch(/prisma|updateMany|CANCELED|killSwitch|env\./);
  });

  it("does not treat PREFLIGHT as unresolved exposure", () => {
    // PREFLIGHT has provably reserved nothing, so it must not block new work
    // the way a possibly-open order does.
    expect(RECOVERY_REQUIRED_STATUSES).not.toContain("PREFLIGHT" as never);
  });

  it("touches no terminal execution", async () => {
    for (const status of ["CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY", "ENTRY_EXPIRED", "SKIPPED", "FAILED", "CANCELED"]) {
      expect(RECONCILABLE_STATUSES).not.toContain(status as never);
    }
  });

  it("passes each execution's own persisted version to the lifecycle", async () => {
    const { orchestrator, calls } = harness({ executions: [execution({ status: "ENTRY_FILLED", version: 9 })] });
    await orchestrator.runExecutionReconciliationTick();
    expect(calls[0].expectedVersion).toBe(9);
  });

  it("continues the batch when one execution fails", async () => {
    const calls: string[] = [];
    const orchestrator = new ExecutionOrchestrator({
      prisma: {
        tradeExecution: {
          findMany: async () => [execution({ id: "bad", status: "ENTRY_FILLED" }), execution({ id: "good", status: "ENTRY_FILLED" })],
          count: async () => 0,
        },
        // The tick BINDS before it discovers: a fake prisma driving one has to
        // be able to resolve the configured profile, or the tick correctly
        // refuses before reaching the rows this case is about.
        executionProfile: {
          findMany: async () => [
            { id: "profile-1", accountIdentifier: "alias", environment: "TESTNET", safetyPolicy: { id: "policy-1" } },
          ],
        },
      } as never,
      readOnly: {} as never,
      admission: {} as never,
      entry: {} as never,
      // The recorder the catch delegates to. Supplied so this fake matches
      // production; the orchestrator also guards the call, so a fake without
      // it would still not abort the batch.
      executions: { recordReconciliationFailure: async () => undefined } as never,
      protection: {
        // Closure runs first for ENTRY_FILLED and finds the position still
        // open, so it writes nothing and hands back the unchanged execution —
        // which is what routes the tick on to protection below.
        reconcileProtectionAndClosure: async (input: { executionId: string }) => ({
          mutationsDispatched: 0,
          execution: { id: input.executionId, status: "ENTRY_FILLED", version: 1 },
        }),
        ensureProtectionForExposure: async (input: { executionId: string }) => {
          calls.push(input.executionId);
          if (input.executionId === "bad") throw new Error("exchange unavailable");
          return { mutationsDispatched: 0 };
        },
      } as never,
      profileIdentity: { accountIdentifier: "alias", environment: "TESTNET" },
    });

    const result = await orchestrator.runExecutionReconciliationTick();
    expect(calls).toEqual(["bad", "good"]);
    expect(result.inspected).toBe(2);
    expect(result.failed).toBe(false);
  });

  it("never throws out of a tick", async () => {
    const orchestrator = new ExecutionOrchestrator({
      prisma: {
        tradeExecution: {
          findMany: async () => {
            throw new Error("database gone");
          },
          count: async () => 0,
        },
        // The tick BINDS before it discovers: a fake prisma driving one has to
        // be able to resolve the configured profile, or the tick correctly
        // refuses before reaching the rows this case is about.
        executionProfile: {
          findMany: async () => [
            { id: "profile-1", accountIdentifier: "alias", environment: "TESTNET", safetyPolicy: { id: "policy-1" } },
          ],
        },
      } as never,
      readOnly: {} as never,
      admission: {} as never,
      entry: {} as never,
      protection: {} as never,
      profileIdentity: { accountIdentifier: "alias", environment: "TESTNET" },
    });
    const result = await orchestrator.runExecutionReconciliationTick();
    expect(result.failed).toBe(true);
    expect(result.inspected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C. Startup recovery
// ---------------------------------------------------------------------------

describe("startup recovery", () => {
  it("discovers every state that may carry unresolved exposure", () => {
    for (const status of ["ENTRY_SUBMITTING", "PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION", "MANUAL_INTERVENTION"]) {
      expect(RECOVERY_REQUIRED_STATUSES).toContain(status as never);
    }
    // ENTRY_PENDING and PROTECTED are reconcilable but not "unresolved": a
    // resting order and verified protection are both known, safe states.
    expect(RECONCILABLE_STATUSES).toContain("ENTRY_PENDING");
    expect(RECOVERY_REQUIRED_STATUSES).not.toContain("ENTRY_PENDING" as never);
  });

  it("reconciles each recoverable state through its existing service", async () => {
    for (const status of RECONCILABLE_STATUSES) {
      const { orchestrator, calls } = harness({ executions: [execution({ status })] });
      await orchestrator.runStartupRecovery();
      expect(calls.length, status).toBeGreaterThan(0);
    }
  });

  it("is idempotent — the same code path as an ordinary tick", async () => {
    const { orchestrator, calls } = harness({ executions: [execution({ status: "PROTECTED" })] });
    await orchestrator.runStartupRecovery();
    const first = calls.length;
    await orchestrator.runStartupRecovery();

    // A second run reconciles the same rows and adds nothing new beyond the
    // repeated (idempotent) service calls — the same sequence, twice.
    expect(calls.length).toBe(first * 2);
    const routed = calls.map((c) => `${c.service}.${c.method}`);
    expect(routed.slice(first)).toEqual(routed.slice(0, first));
  });

  it("reports outstanding recovery so new work stays blocked", async () => {
    const { orchestrator } = harness({ executions: [execution({ status: "ENTRY_FILLED" })], recoveryCount: 2 });
    const result = await orchestrator.runStartupRecovery();
    expect(result.recoveryPending).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// D. Boundary
// ---------------------------------------------------------------------------

describe("orchestrator boundary", () => {
  const ORCHESTRATOR = path.join(BACKEND, "src", "modules", "execution", "execution-orchestrator.ts");
  const SCHEDULER = path.join(BACKEND, "src", "modules", "jobs", "execution-orchestration.scheduler.ts");
  const PROFILE = path.join(BACKEND, "src", "modules", "execution", "execution-profile.service.ts");

  const readCode = (file: string) =>
    readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("duplicates no risk, quantity, leverage or protection mathematics", () => {
    const source = readCode(ORCHESTRATOR);
    for (const forbidden of [
      "Decimal",
      "riskBudget",
      "quantityRaw",
      "stepSize",
      "tickSize",
      "leverage",
      "liquidation",
      "stopPrice",
      "notional",
    ]) {
      expect(`${forbidden}:${source.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("constructs no Binance request and imports no client", () => {
    const source = readCode(ORCHESTRATOR);
    for (const forbidden of ["fapi/", "fetch(", "binance-execution.client", "binance.client", "X-MBX-APIKEY"]) {
      expect(`${forbidden}:${source.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("formats and sends no Telegram", () => {
    for (const file of [ORCHESTRATOR, PROFILE]) {
      const source = readCode(file);
      for (const forbidden of ["telegram", "sendMessage", "notification"]) {
        expect(`${path.basename(file)}:${forbidden}:${source.toLowerCase().includes(forbidden)}`).toBe(
          `${path.basename(file)}:${forbidden}:false`
        );
      }
    }
  });

  it("re-implements no lifecycle state transition", () => {
    const source = readCode(ORCHESTRATOR);
    // It routes on status but never writes one.
    expect(source).not.toContain("canTransition");
    // It READS status to route (`where: { status: { in: ... } }`) but never
    // writes one: no update, create or transition call exists anywhere.
    expect(source).not.toContain(".update(");
    expect(source).not.toContain(".updateMany(");
    expect(source).not.toContain(".create(");
    expect(source).not.toContain("transition(");
  });

  it("checks no gate itself and adds no master gate", () => {
    const source = readCode(ORCHESTRATOR);
    for (const gate of [
      "EXECUTION_LIVE_ENTRY_ENABLED",
      "EXECUTION_PROTECTION_READY",
      "EXECUTION_GLOBAL_KILL_SWITCH",
      "EXECUTION_AUTO_ADD_MARGIN_ENABLED",
      "EXECUTION_EMERGENCY_CLOSE_MODE",
    ]) {
      expect(`${gate}:${source.includes(gate)}`).toBe(`${gate}:false`);
    }
  });

  it("stores no credential in the profile", () => {
    const source = readCode(PROFILE);
    for (const forbidden of ["apiKey", "apiSecret", "BINANCE_API_KEY", "BINANCE_API_SECRET", "secret"]) {
      expect(`${forbidden}:${source.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    const schema = readFileSync(path.join(BACKEND, "prisma", "schema.prisma"), "utf8");
    const model = /model ExecutionProfile \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    for (const forbidden of ["apiKey", "apiSecret", "token", "password"]) {
      expect(`${forbidden}:${model.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("registers no HTTP route", () => {
    const app = readFileSync(path.join(BACKEND, "src", "app.ts"), "utf8");
    for (const forbidden of ["orchestrat", "ensure-profile", "force-live"]) {
      expect(`${forbidden}:${app.toLowerCase().includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("is registered in the production worker with startup recovery first", () => {
    const worker = readFileSync(path.join(BACKEND, "src", "modules", "jobs", "vision-analysis.worker.ts"), "utf8");
    expect(worker).toContain("startExecutionOrchestrationScheduler()");
    expect(worker.match(/startExecutionOrchestrationScheduler\(\)/g)).toHaveLength(1);
    expect(worker.slice(worker.indexOf('process.on("SIGTERM"'))).toContain("clearInterval(orchestrationTimer)");

    const scheduler = readCode(SCHEDULER);
    // Recovery is kicked off before the interval is created.
    expect(scheduler.indexOf("runStartupRecovery")).toBeLessThan(scheduler.indexOf("setInterval"));
    expect(scheduler.match(/setInterval/g)).toHaveLength(1);
  });

  it("documents that the in-memory guard is not the correctness mechanism", () => {
    const scheduler = readFileSync(SCHEDULER, "utf8");
    expect(scheduler).toMatch(/NOT the\s+\* correctness mechanism/);
    expect(scheduler).toContain("advisory locks");
  });
});

// ---------------------------------------------------------------------------
// E. Construction has no side effects
// ---------------------------------------------------------------------------

describe("construction safety", () => {
  it("creates no timer, request or write when the orchestrator is constructed", async () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    const { orchestrator } = harness();
    expect(orchestrator).toBeInstanceOf(ExecutionOrchestrator);
    expect(setInterval).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    setInterval.mockRestore();
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// F. Soft open-position target
// ---------------------------------------------------------------------------

/**
 * The orchestrator is the only place that can notice "we have enough open
 * positions now", because it is the only loop that runs whether or not a new
 * alert arrives. It reads the authoritative persisted count every tick — no
 * in-memory counter — so the behaviour is identical after a restart and a
 * repeated tick is a no-op rather than a second cancellation.
 *
 * What it must NEVER do is let that decision reach protection. A position that
 * has already filled is real money on a real exchange; the soft target governs
 * admission and entry cancellation only.
 */
describe("soft open-position target", () => {
  /**
   * The EFFECTIVE target is min(env global, profile row), and the test process
   * runs on the shipped env default of 1. So a row saying 3 still yields an
   * effective target of 1 — which is exactly the clamp the last test in this
   * block pins. "At target" therefore means any open position at all.
   */
  const atTarget = (executions: Array<Record<string, unknown>>) =>
    harness({ executions, openPositionCount: 3, softOpenPositionTarget: 3 });

  /** Below the effective target: nothing open at all. */
  const belowTarget = (executions: Array<Record<string, unknown>>) =>
    harness({ executions, openPositionCount: 0, softOpenPositionTarget: 3 });

  const cancelCall = (calls: Call[]) => calls.find((c) => c.method === "expireEntryOrderIfDue");

  it("withdraws a resting entry with the SOFT_OPEN_TARGET reason once the target is reached", async () => {
    const { orchestrator, calls } = atTarget([execution({ status: "ENTRY_PENDING", version: 5 })]);
    await orchestrator.runExecutionReconciliationTick();

    expect(calls.map((c) => `${c.service}.${c.method}`)).toEqual([
      "entry.reconcileEntryOrder",
      "entry.expireEntryOrderIfDue",
    ]);
    // The reason is what keeps the terminal mapping correct downstream.
    expect(cancelCall(calls)?.recoveryReason).toBe("SOFT_OPEN_TARGET");
  });

  it("leaves the TTL path alone while the profile is below its target", async () => {
    const { orchestrator, calls } = belowTarget([execution({ status: "ENTRY_PENDING", version: 5 })]);
    await orchestrator.runExecutionReconciliationTick();

    // Still reconciled and still offered to Phase 6 — but with no reason, so
    // only the plan TTL can cancel it.
    expect(cancelCall(calls)).toBeDefined();
    expect(cancelCall(calls)?.recoveryReason).toBeUndefined();
  });

  it("PROTECTS a partial fill BEFORE withdrawing its remainder", async () => {
    const { orchestrator, calls } = atTarget([execution({ status: "PARTIALLY_FILLED", version: 5 })]);
    await orchestrator.runExecutionReconciliationTick();

    const order = calls.map((c) => `${c.service}.${c.method}`);
    expect(order).toEqual([
      "entry.reconcileEntryOrder",
      "protection.ensureProtectionForExposure",
      "entry.expireEntryOrderIfDue",
    ]);
    // Ordering is the safety property: the filled quantity must never wait on
    // a cancellation that can fail, time out or return UNKNOWN.
    expect(order.indexOf("protection.ensureProtectionForExposure")).toBeLessThan(
      order.indexOf("entry.expireEntryOrderIfDue")
    );
    expect(cancelCall(calls)?.recoveryReason).toBe("SOFT_OPEN_TARGET");
  });

  it("does not touch a partial fill remainder while below the target", async () => {
    const { orchestrator, calls } = belowTarget([execution({ status: "PARTIALLY_FILLED", version: 5 })]);
    await orchestrator.runExecutionReconciliationTick();

    expect(calls.map((c) => `${c.service}.${c.method}`)).toEqual([
      "entry.reconcileEntryOrder",
      "protection.ensureProtectionForExposure",
    ]);
  });

  it("never attempts entry cancellation for ENTRY_FILLED or ENTRY_SUBMITTING", async () => {
    // ENTRY_FILLED has no working order left to cancel. ENTRY_SUBMITTING may or
    // may not have produced an order at all, so UNKNOWN != ABSENT: it is
    // resumed and queried, never cancelled on a guess.
    for (const status of ["ENTRY_FILLED", "ENTRY_SUBMITTING"]) {
      const { orchestrator, calls } = atTarget([execution({ status, version: 5 })]);
      await orchestrator.runExecutionReconciliationTick();
      expect(cancelCall(calls), status).toBeUndefined();
    }
  });

  it("keeps protecting every filled execution when the target is exceeded", async () => {
    // Five already-admitted entries have all filled: open count 5 against a
    // soft target of 3. Every one of them must still reach protection — the
    // soft target is not a post-fill validity rule.
    const filled = [1, 2, 3, 4, 5].map((n) =>
      execution({ id: `exec-${n}`, status: "ENTRY_FILLED", version: 5 })
    );
    const { orchestrator, calls } = harness({
      executions: filled,
      openPositionCount: 5,
      softOpenPositionTarget: 3,
    });
    await orchestrator.runExecutionReconciliationTick();

    const protectedIds = calls
      .filter((c) => c.method === "ensureProtectionForExposure")
      .map((c) => c.executionId);
    expect(protectedIds).toEqual(["exec-1", "exec-2", "exec-3", "exec-4", "exec-5"]);
    // #4 and #5 are the ones a naive cap would have refused.
    expect(protectedIds).toContain("exec-4");
    expect(protectedIds).toContain("exec-5");
    // And nothing tried to cancel an entry that no longer exists.
    expect(cancelCall(calls)).toBeUndefined();
  });

  it("protects the mixed aftermath of a lost cancellation race", async () => {
    // Cancellation reached #4 and #5 too late: they filled. #6 and #7 were
    // still resting and are withdrawn. All of it happens in ONE tick.
    const { orchestrator, calls } = harness({
      executions: [
        execution({ id: "filled-4", status: "ENTRY_FILLED", version: 5 }),
        execution({ id: "filled-5", status: "PARTIALLY_FILLED", version: 5 }),
        execution({ id: "resting-6", status: "ENTRY_PENDING", version: 5 }),
        execution({ id: "resting-7", status: "ENTRY_PENDING", version: 5 }),
      ],
      openPositionCount: 5,
      softOpenPositionTarget: 3,
    });
    await orchestrator.runExecutionReconciliationTick();

    const protectedIds = calls
      .filter((c) => c.method === "ensureProtectionForExposure")
      .map((c) => c.executionId);
    expect(protectedIds).toContain("filled-4");
    expect(protectedIds).toContain("filled-5");

    const cancelled = calls
      .filter((c) => c.method === "expireEntryOrderIfDue")
      .map((c) => `${c.executionId}:${c.recoveryReason}`);
    expect(cancelled).toEqual([
      "filled-5:SOFT_OPEN_TARGET",
      "resting-6:SOFT_OPEN_TARGET",
      "resting-7:SOFT_OPEN_TARGET",
    ]);
    // The already-filled entry is never offered for cancellation.
    expect(cancelled.some((entry) => entry.startsWith("filled-4"))).toBe(false);
  });

  it("is idempotent: a repeated tick issues the same calls, never a second kind", async () => {
    const build = () => atTarget([execution({ status: "ENTRY_PENDING", version: 5 })]);
    const first = build();
    await first.orchestrator.runExecutionReconciliationTick();
    const second = build();
    await second.orchestrator.runExecutionReconciliationTick();

    const shape = (calls: Call[]) => calls.map((c) => `${c.service}.${c.method}:${c.recoveryReason ?? "-"}`);
    expect(shape(second.calls)).toEqual(shape(first.calls));
    // Idempotence itself lives in the durable cancellation machinery, which
    // records cancelRequestedAt before the POST and re-queries afterwards.
  });

  it("keeps reconciling when the soft-target check cannot be evaluated", async () => {
    // No policy row: the probe cannot prove the target is reached. That must
    // cost a cancellation, never the whole tick — protection has to run.
    const { orchestrator, calls } = harness({
      executions: [execution({ status: "ENTRY_FILLED", version: 5 })],
      policyRow: null,
    });
    const result = await orchestrator.runExecutionReconciliationTick();

    expect(result.failed).toBe(false);
    expect(calls.map((c) => c.method)).toContain("ensureProtectionForExposure");
    expect(cancelCall(calls)).toBeUndefined();
  });

  it("targets ENTRY orders only — no protection call can cancel anything", () => {
    const source = stripComments(
      readFileSync(path.join(BACKEND, "src", "modules", "execution", "execution-orchestrator.ts"), "utf8")
    );
    // The soft-target reason is passed to the ENTRY lifecycle and nowhere else.
    const uses = source.match(/SOFT_OPEN_TARGET/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const forbidden of [
      "protection.cancel",
      "cancelProtection",
      "cancelSibling",
      "STOP_LOSS",
      "TAKE_PROFIT",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    // Cancellation is only ever requested through the one entry primitive.
    expect(source).toContain("this.deps.entry.expireEntryOrderIfDue");
  });

  it("reads the authoritative count from the shared capacity classification", () => {
    const source = stripComments(
      readFileSync(path.join(BACKEND, "src", "modules", "execution", "execution-orchestrator.ts"), "utf8")
    );
    // Not a private status list, and not its own min-merge.
    expect(source).toContain("OPEN_POSITION_STATUSES");
    expect(source).toContain("mergeCapacityLimits");
    expect(source).not.toMatch(/Math\.min\(/);
  });

  it("uses the STRICTER of the env global and the profile row", () => {
    // The row says 3 and the global says 1, so the effective target is 1 and
    // ONE open position already closes admission. This is the same min-merge
    // admission applies; the orchestrator must not read the row alone, or it
    // would keep placing entries the safety engine would refuse.
    //
    // The global comes from tests/setup.ts, which pins it for the whole suite.
    // This asserts the FIXTURE, not the operator's .env — reading their real
    // value here is what made this test fail once MAINNET moved to 3.
    expect(env.EXECUTION_SOFT_OPEN_POSITION_TARGET).toBe(1);

    const { orchestrator: below, calls: belowCalls } = harness({
      executions: [execution({ status: "ENTRY_PENDING", version: 5 })],
      openPositionCount: 0,
      softOpenPositionTarget: 3,
    });
    const { orchestrator: at, calls: atCalls } = harness({
      executions: [execution({ status: "ENTRY_PENDING", version: 5 })],
      openPositionCount: 1,
      softOpenPositionTarget: 3,
    });

    return Promise.all([below.runExecutionReconciliationTick(), at.runExecutionReconciliationTick()]).then(() => {
      expect(cancelCall(belowCalls)?.recoveryReason).toBeUndefined();
      // One open position is already at the EFFECTIVE target of 1.
      expect(cancelCall(atCalls)?.recoveryReason).toBe("SOFT_OPEN_TARGET");
    });
  });
});

// ---------------------------------------------------------------------------
// S. Same-tick protection of a confirmed fill
// ---------------------------------------------------------------------------

/**
 * A fill discovered during a pass is protected during that pass.
 *
 * `ENTRY_PENDING` used to reconcile, commit the fill and return, so protection
 * waited for whichever later tick next routed the row: one cursor cycle to find
 * the fill, another to act on it. These pin the continuation and, just as
 * importantly, pin what must NOT trigger it — the gate reads the status the
 * entry call COMMITTED, never the one the tick started with.
 */
describe("S. same-tick protection", () => {
  const pass = async (options: {
    status: string;
    entryResultStatus?: string;
    openPositionCount?: number;
    softOpenPositionTarget?: number;
  }) => {
    const { orchestrator, calls } = harness({
      executions: [execution({ status: options.status, version: 5 })],
      entryResultStatus: options.entryResultStatus,
      openPositionCount: options.openPositionCount,
      softOpenPositionTarget: options.softOpenPositionTarget,
    });
    await orchestrator.runExecutionReconciliationTick();
    return { calls, names: calls.map((c) => `${c.service}.${c.method}`) };
  };

  it("S1. protects a resting order that filled during this pass", async () => {
    const { names } = await pass({ status: "ENTRY_PENDING", entryResultStatus: "ENTRY_FILLED" });

    // One pass, not two: the protection call happens here rather than on the
    // next visit. And nothing tries to expire an order that just filled.
    expect(names).toEqual(["entry.reconcileEntryOrder", "protection.ensureProtectionForExposure"]);
  });

  it("S2. protects a resting order that partially filled during this pass", async () => {
    const { names } = await pass({ status: "ENTRY_PENDING", entryResultStatus: "PARTIALLY_FILLED" });

    // Same continuation. How MUCH to protect is not decided here — the
    // protection service sizes it from the live exchange position.
    expect(names).toEqual(["entry.reconcileEntryOrder", "protection.ensureProtectionForExposure"]);
  });

  it("S3. protects a fill discovered while resolving an ambiguous submission", async () => {
    const { names } = await pass({ status: "ENTRY_SUBMITTING", entryResultStatus: "ENTRY_FILLED" });

    expect(names).toEqual(["entry.resumeEntrySubmission", "protection.ensureProtectionForExposure"]);
  });

  it("S4. hands protection the version the ENTRY call committed, not the tick's", async () => {
    const { calls } = await pass({ status: "ENTRY_PENDING", entryResultStatus: "ENTRY_FILLED" });

    // The tick read version 5; the entry call committed 6. Protecting on 5
    // would CAS against state the entry call already superseded.
    expect(calls[0].expectedVersion).toBe(5);
    expect(calls[1].expectedVersion).toBe(6);
  });

  it("S5. never protects on the status the tick STARTED with", async () => {
    // The whole point of the gate. A resting order, an expired one, a
    // cancelled one and one parked for a human all reach the same conclusion:
    // no confirmed exposure, so no protection call. Eligibility comes from
    // what reconciliation committed, never from "it was ENTRY_PENDING and an
    // order existed".
    for (const status of ["ENTRY_PENDING", "ENTRY_SUBMITTING"]) {
      for (const committed of ["ENTRY_PENDING", "ENTRY_EXPIRED", "CANCELED", "MANUAL_INTERVENTION"]) {
        const { names } = await pass({ status, entryResultStatus: committed });
        expect(names.join(","), `${status}->${committed}`).not.toContain(
          "protection.ensureProtectionForExposure"
        );
      }
    }
  });

  it("S6. an unfilled resting order still reaches the Phase 6 TTL decision", async () => {
    const { names } = await pass({ status: "ENTRY_PENDING", entryResultStatus: "ENTRY_PENDING" });

    // Unchanged behaviour for the common case.
    expect(names).toEqual(["entry.reconcileEntryOrder", "entry.expireEntryOrderIfDue"]);
  });

  it("S7. withdraws the remainder only after protection, and only at the soft target", async () => {
    const { calls, names } = await pass({
      status: "ENTRY_PENDING",
      entryResultStatus: "PARTIALLY_FILLED",
      openPositionCount: 5,
      softOpenPositionTarget: 1,
    });

    // PROTECT FIRST. The withdrawal is cause-tagged so it can never be read
    // back as an unprotected partial fill, and it runs on the version
    // PROTECTION committed rather than the entry call's.
    expect(names).toEqual([
      "entry.reconcileEntryOrder",
      "protection.ensureProtectionForExposure",
      "entry.expireEntryOrderIfDue",
    ]);
    expect(calls[2].recoveryReason).toBe("SOFT_OPEN_TARGET");
    expect(calls[2].expectedVersion).toBe(calls[1].expectedVersion + 1);
  });

  it("S8. routes the three exposure-bearing entry states through ONE sequence", async () => {
    // PARTIALLY_FILLED already reconciled then protected; the other two now do
    // the same. Sharing one helper is what stops them drifting apart again.
    const source = stripComments(
      readFileSync(path.join(BACKEND, "src", "modules", "execution", "execution-orchestrator.ts"), "utf8")
    );
    expect(source.match(/this\.protectConfirmedFill\(/g) ?? []).toHaveLength(3);
    // And exactly one place actually calls the protection entry point for it.
    expect(
      source.match(/protection\.ensureProtectionForExposure\(\{\s*\.\.\.input,\s*expectedVersion: reconciledExecution\.version/g) ?? []
    ).toHaveLength(1);
  });
});


// ---------------------------------------------------------------------------
// Bounded reconciliation diagnostics
// ---------------------------------------------------------------------------

describe("a tick reports which rows it served and what they decided", () => {
  /**
   * These exist because a live incident could not be diagnosed: an execution
   * that is "reached and does nothing" and one that is "never reached" leave
   * identical durable state, and the launcher discards worker stdout, so the
   * per-row log line goes to NUL. The counters alone cannot separate them.
   */
  const rows = (result: { rows: Array<Record<string, unknown>> }) => result.rows;

  it("A. captures the served ids exactly, in order", async () => {
    const { orchestrator } = harness({
      executions: [
        execution({ id: "a", status: "PROTECTED" }),
        execution({ id: "b", status: "ENTRY_PENDING" }),
        execution({ id: "c", status: "MANUAL_INTERVENTION" }),
      ],
    });
    const result = await orchestrator.runExecutionReconciliationTick();
    expect(rows(result).map((row) => row.executionId)).toEqual(["a", "b", "c"]);
    expect(result.inspected).toBe(3);
    // Selection is answerable without inferring it from durable writes.
    expect(rows(result).map((row) => row.statusBefore)).toEqual([
      "PROTECTED",
      "ENTRY_PENDING",
      "MANUAL_INTERVENTION",
    ]);
  });

  it("B. never reports more rows than the batch served", async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      execution({ id: `e${index}`, status: "PROTECTED" })
    );
    const { orchestrator } = harness({ executions: many });
    const result = await orchestrator.runExecutionReconciliationTick({ batchSize: 4 });
    // The stub returns every row, so this pins the bound to what was SERVED.
    expect(rows(result).length).toBe(result.inspected);
    expect(rows(result).length).toBeLessThanOrEqual(many.length);
  });

  it("C. makes POSITION_STATE_UNAVAILABLE visible", async () => {
    const { orchestrator } = harness({
      executions: [execution({ id: "zro", status: "MANUAL_INTERVENTION" })],
      closureResultStatus: "MANUAL_INTERVENTION",
      closureReasonCode: "POSITION_STATE_UNAVAILABLE",
      closurePositionObservation: "UNAVAILABLE",
    });
    const result = await orchestrator.runExecutionReconciliationTick();
    expect(rows(result)[0]).toMatchObject({
      executionId: "zro",
      statusBefore: "MANUAL_INTERVENTION",
      reasonCode: "POSITION_STATE_UNAVAILABLE",
      positionObservation: "UNAVAILABLE",
      errorCode: null,
    });
  });

  it("D. makes the write-free 'position still open' return visible", async () => {
    // Same status and the same absence of durable change as C — only the
    // diagnostic separates them, which is the whole point.
    const { orchestrator } = harness({
      executions: [execution({ id: "zro", status: "MANUAL_INTERVENTION" })],
      closureResultStatus: "MANUAL_INTERVENTION",
      closureReasonCode: "PROTECTION_COVERAGE_INCOMPLETE",
      closurePositionObservation: "NON_ZERO",
    });
    const result = await orchestrator.runExecutionReconciliationTick();
    expect(rows(result)[0]).toMatchObject({
      reasonCode: "PROTECTION_COVERAGE_INCOMPLETE",
      positionObservation: "NON_ZERO",
    });
  });

  it("E. makes a flat closure visible", async () => {
    const { orchestrator } = harness({
      executions: [execution({ id: "zro", status: "MANUAL_INTERVENTION" })],
      closureResultStatus: "CLOSED_TP",
      closureReasonCode: "PROTECTION_VERIFIED",
      closurePositionObservation: "FLAT",
    });
    const result = await orchestrator.runExecutionReconciliationTick();
    expect(rows(result)[0]).toMatchObject({
      reasonCode: "PROTECTION_VERIFIED",
      positionObservation: "FLAT",
      errorCode: null,
    });
  });

  it("F. makes a per-row throw visible, by class name only", async () => {
    const { orchestrator } = harness({
      executions: [execution({ id: "boom", status: "MANUAL_INTERVENTION" })],
      throwForExecutionId: "boom",
    });
    const result = await orchestrator.runExecutionReconciliationTick();
    expect(rows(result)[0].errorCode).toBe("TypeError");
    // The row is still reported rather than vanishing with the exception.
    expect(rows(result)[0].executionId).toBe("boom");
    // And the throw is still swallowed: the batch completes as before.
    expect(result.failed).toBe(false);
  });

  it("G. adds no exchange call of its own", async () => {
    const { orchestrator, calls } = harness({
      executions: [execution({ id: "zro", status: "MANUAL_INTERVENTION" })],
      closureResultStatus: "MANUAL_INTERVENTION",
    });
    await orchestrator.runExecutionReconciliationTick();
    // Exactly the calls the routing already made — the diagnostic reads values
    // those calls returned and never asks the exchange anything itself.
    expect(calls.map((call) => call.method)).toEqual([
      "reconcileProtectionAndClosure",
      "attemptProtectionRecovery",
    ]);
  });

  it("H. leaves cursor and selection semantics untouched", async () => {
    const many = Array.from({ length: 6 }, (_, index) =>
      execution({ id: `e${index}`, status: "PROTECTED" })
    );
    const { orchestrator } = harness({ executions: many });
    const full = await orchestrator.runExecutionReconciliationTick({ batchSize: 6 });
    // A full window keeps the cursor; the diagnostic does not disturb it.
    expect(full.cursorActive).toBe(true);
    const short = await orchestrator.runExecutionReconciliationTick({ batchSize: 10 });
    expect(short.cursorActive).toBe(false);
  });

  it("I. carries ids and enums only — never a secret-bearing field", async () => {
    const { orchestrator } = harness({
      executions: [execution({ id: "zro", status: "MANUAL_INTERVENTION" })],
      closureResultStatus: "MANUAL_INTERVENTION",
    });
    const result = await orchestrator.runExecutionReconciliationTick();
    expect(Object.keys(rows(result)[0]).sort()).toEqual([
      "errorCode",
      "executionId",
      "positionObservation",
      "reasonCode",
      "statusBefore",
    ]);
    // The symbol is deliberately absent: the id answers the question and a
    // symbol would add a second, more legible identifier for no gain.
    expect(JSON.stringify(rows(result))).not.toContain("SYNTHUSDT");
    const serialized = JSON.stringify(rows(result));
    for (const forbidden of ["apiKey", "secret", "signature", "authorization", "token", "postgres", "redis", "http"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
