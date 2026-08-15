import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ExecutionOrchestrator,
  RECONCILABLE_STATUSES,
  RECOVERY_REQUIRED_STATUSES,
} from "../src/modules/execution/execution-orchestrator";

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
}

function harness(options: {
  executions?: Array<Record<string, unknown>>;
  recoveryCount?: number;
  profile?: { id: string; found: boolean };
  admissionDecision?: string;
  mutationsPerCall?: number;
  /** Status the closure reconciliation leaves the execution in. */
  closureResultStatus?: string;
} = {}) {
  const calls: Call[] = [];
  const executions = options.executions ?? [];
  const mutations = options.mutationsPerCall ?? 0;
  const profileId = options.profile?.id ?? "profile-1";

  const record = (service: string, method: string) => async (input: { executionId: string; expectedVersion: number }) => {
    calls.push({ service, method, executionId: input.executionId, expectedVersion: input.expectedVersion });
    // The routing for PROTECTED branches on the status the call LEAVES the
    // execution in, so the stub has to model it. `closureResultStatus` lets a
    // test say "this reconciliation terminalized or escalated".
    const source = executions.find((row: { id: string }) => row.id === input.executionId);
    const status =
      method === "reconcileProtectionAndClosure" && options.closureResultStatus !== undefined
        ? options.closureResultStatus
        : (source?.status as string | undefined);
    return {
      mutationsDispatched: mutations,
      execution: { id: input.executionId, version: input.expectedVersion + 1, status },
      reasonCode: "OK",
    };
  };

  const prisma = {
    tradeExecution: {
      findMany: async () => executions,
      findUnique: async ({ where }: { where: { id: string } }) =>
        executions.find((e) => e.id === where.id) ?? null,
      count: async () => options.recoveryCount ?? 0,
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

  it("protects a filled entry", async () => {
    expect(await route("ENTRY_FILLED")).toEqual(["protection.ensureProtectionForExposure"]);
  });

  it("resumes a half-finished protection tranche rather than reserving a new one", async () => {
    expect(await route("PLACING_PROTECTION")).toEqual(["protection.resumeProtectionLifecycle"]);
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
      } as never,
      readOnly: {} as never,
      admission: {} as never,
      entry: {} as never,
      protection: {
        ensureProtectionForExposure: async (input: { executionId: string }) => {
          calls.push(input.executionId);
          if (input.executionId === "bad") throw new Error("exchange unavailable");
          return { mutationsDispatched: 0 };
        },
      } as never,
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
      } as never,
      readOnly: {} as never,
      admission: {} as never,
      entry: {} as never,
      protection: {} as never,
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
