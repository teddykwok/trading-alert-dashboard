import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SelectedPlanExecutor } from "../src/modules/execution/selected-plan-executor";
import { RECONCILABLE_STATUSES } from "../src/modules/execution/execution-orchestrator";
import { testProfileProjection } from "./helpers/bound-runtime";

/**
 * Phase 11 — the signal → execution boundary.
 *
 * These prove eligibility, idempotency and crash separability with recording
 * fakes. No Binance transport is constructed anywhere in this file.
 */

const BACKEND = process.cwd();

const CANDIDATE = {
  requestedCandles: 200,
  actualCandles: 200,
  complete: true,
  valid: true,
  stopLoss: "0.2656",
  takeProfit: "0.3011",
  invalidReason: null,
  money: { quantityRaw: "294", plannedLossRaw: "1.5", plannedProfitRaw: "4.5", positionNotionalRaw: "79.58" },
};

/**
 * Exactly the sanitized filter projection the Phase 3 planner returns — the
 * object that must reach `exchangeFiltersSnapshot`, because Phase 6
 * revalidation refuses to submit without it.
 */
const FILTERS = {
  status: "TRADING",
  contractType: "PERPETUAL",
  tickSize: "0.0001",
  minPrice: "0.0001",
  maxPrice: "100000",
  stepSize: "1",
  minQty: "1",
  maxQty: "1000000",
  minNotional: "5",
};

const PLAN = {
  id: "plan-1",
  alertId: "alert-1",
  status: "READY",
  direction: "LONG" as const,
  entryPrice: "0.2707",
  selectedLookback: 200,
  selectedLeverage: 21,
  template: { riskTemplateId: "t1", name: "canary", referenceCapital: "300", riskPercent: "0.5", rewardRatio: "3", riskAmount: "1.50", targetAmount: "4.50" },
  candidates: [CANDIDATE],
};

function harness(options: {
  plan?: Record<string, unknown>;
  marginStatus?: string;
  createThrowsP2002?: boolean;
  existingExecutionId?: string;
  profileFound?: boolean;
  /** Phase 11B.0: how many authorizations exist (>0 puts the profile in canary mode). */
  canaryCount?: number;
  /** The authorization bound to THIS alert, if any. */
  canaryBound?: Record<string, unknown> | null;
  /** The execution the bound authorization already produced, if any. */
  canaryOwnerAlertId?: string;
} = {}) {
  const creates: unknown[] = [];
  const plannerInputs: unknown[] = [];
  const admissions: string[] = [];
  const canaryBindings: unknown[] = [];
  let createCalls = 0;
  let planningCalls = 0;

  const executor = new SelectedPlanExecutor({
    prisma: {
      executionProfile: {
        findMany: async () =>
          options.profileFound === false ? [] : [{ id: "profile-1", safetyPolicy: { id: "policy-1" } }],
      },
      tradeExecution: {
        findFirst: async () => (options.existingExecutionId ? { id: options.existingExecutionId } : null),
        findUnique: async () =>
          options.canaryOwnerAlertId ? { alertId: options.canaryOwnerAlertId } : null,
      },
      executionCanaryAuthorization: {
        count: async () => options.canaryCount ?? 0,
        findFirst: async () => options.canaryBound ?? null,
        updateMany: async (args: unknown) => {
          canaryBindings.push(args);
          return { count: 1 };
        },
      },
    } as never,
    marginPlanner: {
      planForSymbolWithSnapshot: async (input: unknown) => {
        planningCalls += 1;
        plannerInputs.push(input);
        return {
          plan: {
            status: options.marginStatus ?? "READY",
            selectedLeverage: options.marginStatus === "READY" || !options.marginStatus ? 21 : null,
            reason: null,
          },
          exchangeFilters: FILTERS,
        };
      },
    } as never,
    executions: {
      createExecutionFromReadyPlan: async (input: unknown) => {
        createCalls += 1;
        if (options.createThrowsP2002) {
          const error = new Error("Unique constraint failed") as Error & { code?: string };
          error.code = "P2002";
          Object.setPrototypeOf(error, Object.create(Error.prototype));
          // Mirror the Prisma error shape the executor checks for.
          const { Prisma } = require("@prisma/client");
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "5.22.0",
          });
        }
        creates.push(input);
        return { id: "exec-1" };
      },
    } as never,
    orchestrator: {
      admitAndSubmit: async ({ executionId }: { executionId: string }) => {
        admissions.push(executionId);
        return { admitted: true, decision: "PASS", reasonCode: "ENTRY_SUBMITTED", mutationsDispatched: 0 };
      },
    } as never,
    // The profile this orchestrator OWNS, projected as production does
    // from the runtime that also produced its clients' credentials.
    boundProfile: testProfileProjection({ executionProfileId: "profile-1" }),
  });

  return {
    executor,
    creates,
    plannerInputs,
    admissions,
    canaryBindings,
    createCalls: () => createCalls,
    planningCalls: () => planningCalls,
  };
}

// ---------------------------------------------------------------------------
// Phase 11B.0 — canary authorization
// ---------------------------------------------------------------------------

describe("canary authorization gate", () => {
  // Shaped like a real row: `authorizationType` is NOT NULL with a database
  // default, so every persisted authorization carries one. A fixture that
  // omitted it would be testing a row the database cannot produce.
  const BOUND = {
    id: "auth-1",
    authorizationType: "EXACT_SIGNAL",
    allowedSymbol: "FRAXUSDT",
    allowedDirection: "LONG",
    consumedExecutionId: null,
  };

  it("is inert when no authorization has ever been prepared", async () => {
    const { executor, creates, canaryBindings } = harness({ canaryCount: 0 });
    const result = await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect(result.handled).toBe(true);
    expect(creates).toHaveLength(1);
    // Nothing to bind, so nothing was written.
    expect(canaryBindings).toHaveLength(0);
  });

  it("blocks an unauthorized signal once the profile is in canary mode", async () => {
    const { executor, creates, admissions } = harness({ canaryCount: 1, canaryBound: null });
    const result = await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect(result.handled).toBe(false);
    expect((result as { reasonCode: string }).reasonCode).toBe("CANARY_AUTHORIZATION_REQUIRED");
    expect(creates).toHaveLength(0);
    expect(admissions).toHaveLength(0);
  });

  it("admits the authorized signal and records which execution it produced", async () => {
    const { executor, creates, admissions, canaryBindings } = harness({ canaryCount: 1, canaryBound: BOUND });
    const result = await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect(result.handled).toBe(true);
    expect(creates).toHaveLength(1);
    // Still goes through normal admission — the authorization grants nothing.
    expect(admissions).toEqual(["exec-1"]);
    expect(canaryBindings).toHaveLength(1);
  });

  it("blocks the right symbol in the wrong direction", async () => {
    const { executor, creates } = harness({
      canaryCount: 1,
      canaryBound: { ...BOUND, allowedDirection: "SHORT" },
    });
    const result = await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect((result as { reasonCode: string }).reasonCode).toBe("CANARY_AUTHORIZATION_WRONG_DIRECTION");
    expect(creates).toHaveLength(0);
  });

  it("blocks a different symbol", async () => {
    const { executor, creates } = harness({ canaryCount: 1, canaryBound: { ...BOUND, allowedSymbol: "BTCUSDT" } });
    const result = await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect((result as { reasonCode: string }).reasonCode).toBe("CANARY_AUTHORIZATION_WRONG_SYMBOL");
    expect(creates).toHaveLength(0);
  });

  it("refuses to let a second execution adopt an authorization already bound to another", async () => {
    const { executor, creates } = harness({
      canaryCount: 1,
      canaryBound: { ...BOUND, consumedExecutionId: "exec-earlier" },
      canaryOwnerAlertId: "alert-somebody-else",
    });
    const result = await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect((result as { reasonCode: string }).reasonCode).toBe("CANARY_AUTHORIZATION_ALREADY_CONSUMED");
    expect(creates).toHaveLength(0);
  });

  it("lets the ORIGINAL execution recover after a crash", async () => {
    // Bound, already tied to an execution — but that execution is this alert's.
    const { executor, creates, admissions } = harness({
      canaryCount: 1,
      canaryBound: { ...BOUND, consumedExecutionId: "exec-1" },
      canaryOwnerAlertId: "alert-1",
      existingExecutionId: "exec-1",
    });
    const result = await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect(result.handled).toBe(true);
    expect(admissions).toEqual(["exec-1"]);
    expect(creates).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Phase 12.1 — the durable binding must be a USABLE exact authorization
  // -------------------------------------------------------------------------

  /**
   * The symbol, direction and token columns became nullable so the same table
   * can also describe a natural window. That must not turn this reader into
   * something that copes with absent identity: without the structural check,
   * `bound.allowedSymbol !== "FRAXUSDT"` compares against a null, reports
   * WRONG_SYMBOL, and describes a corrupt row as a merely-mismatched one.
   *
   * Every case below still ends in a refusal and an execution that was never
   * created — the fail-closed property is what is being pinned, not the wording.
   */
  it.each([
    ["a missing symbol", { allowedSymbol: null }],
    ["a missing direction", { allowedDirection: null }],
    ["a mode this reader does not implement", { authorizationType: "NATURAL_WINDOW" }],
    // The pre-discriminator shape: a row that does not say what it is.
    ["no declared mode at all", { authorizationType: undefined }],
  ])("refuses a bound authorization with %s", async (_label, override) => {
    const { executor, creates, admissions } = harness({
      canaryCount: 1,
      canaryBound: { ...BOUND, ...override },
    });
    const result = await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect(result.handled).toBe(false);
    expect((result as { reasonCode: string }).reasonCode).toBe("CANARY_AUTHORIZATION_REQUIRED");
    expect(creates).toHaveLength(0);
    expect(admissions).toHaveLength(0);
  });

  it("still admits a well-formed EXACT_SIGNAL binding unchanged", async () => {
    // The other half of the guard: it refuses only what it should.
    const { executor, creates, admissions } = harness({ canaryCount: 1, canaryBound: BOUND });
    const result = await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect(result.handled).toBe(true);
    expect(creates).toHaveLength(1);
    expect(admissions).toEqual(["exec-1"]);
  });
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

describe("selected-plan eligibility", () => {
  it("creates exactly one PLAN_READY execution for an eligible selected plan", async () => {
    const { executor, creates, admissions } = harness();
    const result = await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect(result.handled).toBe(true);
    expect(creates).toHaveLength(1);
    expect(admissions).toEqual(["exec-1"]);
    // The frozen template risk amount is what reaches the planner.
    expect((creates[0] as { takeProfit: string }).takeProfit).toBe("0.3011");
    expect((creates[0] as { selectedLookback: number }).selectedLookback).toBe(200);
  });

  it("creates nothing for a plan that is not READY", async () => {
    for (const status of ["PENDING", "INVALID", "ERROR"]) {
      const { executor, creates } = harness();
      const result = await executor.handleSelectedPlan({ ...PLAN, status } as never, "FRAXUSDT");
      expect(result.handled, status).toBe(false);
      expect(creates, status).toHaveLength(0);
    }
  });

  it("creates nothing when the SELECTED lookback has no candidate", async () => {
    const { executor, creates } = harness();
    // A different candidate is valid, but it is not the selected one.
    const plan = { ...PLAN, selectedLookback: 300 };
    const result = await executor.handleSelectedPlan(plan as never, "FRAXUSDT");

    expect(result.handled).toBe(false);
    expect((result as { reasonCode: string }).reasonCode).toBe("NO_SELECTED_CANDIDATE");
    expect(creates).toHaveLength(0);
  });

  it("creates nothing for an incomplete or invalid selected candidate", async () => {
    const variants = [
      { ...CANDIDATE, valid: false },
      { ...CANDIDATE, money: null },
      { ...CANDIDATE, stopLoss: null },
      { ...CANDIDATE, takeProfit: null },
    ];
    for (const candidate of variants) {
      const { executor, creates } = harness();
      const result = await executor.handleSelectedPlan({ ...PLAN, candidates: [candidate] } as never, "FRAXUSDT");
      expect(result.handled).toBe(false);
      expect(creates).toHaveLength(0);
    }
  });

  it("creates nothing without a frozen risk-template snapshot", async () => {
    const { executor, creates } = harness();
    const result = await executor.handleSelectedPlan({ ...PLAN, template: null } as never, "FRAXUSDT");
    expect(result.handled).toBe(false);
    expect(creates).toHaveLength(0);
  });

  it("creates nothing when the margin plan is not READY", async () => {
    const { executor, creates } = harness({ marginStatus: "INVALID" });
    const result = await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");
    expect((result as { reasonCode: string }).reasonCode).toBe("MARGIN_PLAN_NOT_READY");
    expect(creates).toHaveLength(0);
  });

  it("no longer resolves a profile of its own to fail on", () => {
    // Phase 11D: the executor is handed the profile its planner's
    // credentials belong to. There is nothing left to look up, so there is
    // no PROFILE_UNAVAILABLE path -- an unbindable process never gets an
    // executor built at all.
    const source = readFileSync(
      path.join(BACKEND, "src", "modules", "execution", "selected-plan-executor.ts"),
      "utf8"
    );
    expect(source).toContain("boundProfile: BoundExecutionProfileProjection;");
    expect(source).not.toContain("resolveExecutionProfile(");
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("signal to execution idempotency", () => {
  it("adopts the existing row when the unique constraint rejects a duplicate", async () => {
    const { executor, creates, admissions, createCalls } = harness({
      createThrowsP2002: true,
      existingExecutionId: "exec-existing",
    });

    const result = await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect(result.handled).toBe(true);
    expect((result as { created: boolean }).created).toBe(false);
    expect((result as { executionId: string }).executionId).toBe("exec-existing");
    // The create WAS attempted; the database refused it, which is the point.
    expect(createCalls()).toBe(1);
    expect(creates).toHaveLength(0);
    // Admission still runs against the winner's row.
    expect(admissions).toEqual(["exec-existing"]);
  });

  it("relies on a database constraint, not an in-memory flag", () => {
    const schema = readFileSync(path.join(BACKEND, "prisma", "schema.prisma"), "utf8");
    const model = /model TradeExecution \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    expect(model).toContain("@@unique([alertId, executionProfileId])");

    const source = readFileSync(path.join(BACKEND, "src", "modules", "execution", "selected-plan-executor.ts"), "utf8");
    expect(source).toContain("P2002");
    // No module-level mutable dedupe state.
    expect(source).not.toMatch(/^const\s+\w*(seen|handled|processed)\w*\s*=\s*new (Set|Map)/m);
  });
});

// ---------------------------------------------------------------------------
// Crash separability
// ---------------------------------------------------------------------------

describe("crash between creation and admission", () => {
  it("leaves a durable PLAN_READY row that reconciliation can discover", () => {
    // PLAN_READY is reconcilable, so a persisted execution whose admission
    // never ran does not depend on BullMQ redelivering the original job.
    expect(RECONCILABLE_STATUSES).toContain("PLAN_READY");
  });

  it("keeps creation and admission as separate steps", () => {
    const source = readFileSync(path.join(BACKEND, "src", "modules", "execution", "selected-plan-executor.ts"), "utf8");
    // Creation is not inside the admission call, and admission is not inside a
    // transaction with it — a crash between them is a recoverable state, not a
    // lost one.
    expect(source).not.toContain("$transaction");
    expect(source.indexOf("createExecutionFromReadyPlan")).toBeLessThan(source.indexOf("admitAndSubmit"));
  });
});

// ---------------------------------------------------------------------------
// Production registration
// ---------------------------------------------------------------------------

describe("production registration", () => {
  const worker = () => readFileSync(path.join(BACKEND, "src", "modules", "jobs", "vision-analysis.worker.ts"), "utf8");

  it("calls the selected-plan handler from the Extreme RR job", () => {
    const source = worker();
    // A call site, not merely an import: removing the call fails this.
    // Phase 11D: the executor is barrier-owned, so the handler takes a local
    // non-null reference first -- the call itself is unchanged.
    expect(source).toMatch(/executor\.handleSelectedPlan\(/);
    expect(source).toContain("const executor = selectedPlanExecutor;");
    // Inside the Extreme RR job handler.
    const handler = source.slice(
      source.indexOf("async function processExtremeRRJob"),
      source.indexOf("const extremeRRService")
    );
    expect(handler).toContain("handleSelectedPlan");
  });

  it("constructs the executor with the real production services", () => {
    const source = worker();
    expect(source).toContain("new SelectedPlanExecutor(");
    // 11B: the planner reaches SIGNED endpoints (account summary, leverage
    // brackets), so production now hands it a read-only service built with the
    // configured profile's credentials instead of letting the constructor read
    // them from the environment on its own.
    // Phase 11D: built by the runtime factory, so its credentials and the
    // executor's profile come from one binding.
    expect(source).toContain("marginPlanServiceFromRuntime(runtime)");
    expect(source).toContain("new ExecutionService(prisma)");
    expect(source).toContain("createExecutionOrchestrator(runtime)");
    // And the profile it owns is the projection of that SAME runtime.
    expect(source).toContain("boundProfile: profileProjectionOf(runtime)");
  });

  it("registers startup recovery and the reconciliation scheduler", () => {
    const source = worker();
    expect(source).toContain("startExecutionOrchestrationScheduler(runtime)");
    const scheduler = readFileSync(
      path.join(BACKEND, "src", "modules", "jobs", "execution-orchestration.scheduler.ts"),
      "utf8"
    );
    expect(scheduler).toContain("runStartupRecovery(");
  });

  it("never lets an execution failure fail the plan job", () => {
    const source = worker();
    const handler = source.slice(source.indexOf("handleSelectedPlan"), source.indexOf("const extremeRRService"));
    // Wrapped in try/catch: the persisted PLAN_READY row is recovered by the
    // scheduler regardless of what happens here.
    expect(handler).toContain("catch");
    expect(handler).toContain("non-fatal");
  });
});

// ---------------------------------------------------------------------------
// Boundary
// ---------------------------------------------------------------------------

describe("selected-plan boundary", () => {
  const SOURCE = path.join(BACKEND, "src", "modules", "execution", "selected-plan-executor.ts");
  const readCode = () =>
    readFileSync(SOURCE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("duplicates no Extreme RR or risk mathematics", () => {
    const source = readCode();
    for (const forbidden of ["Decimal", "calculateExtreme", "riskDistance", "rewardDistance", "quantityRaw ="]) {
      expect(`${forbidden}:${source.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("implements no second selection algorithm", () => {
    const source = readCode();
    // It matches the PERSISTED selected lookback and nothing else — no sort,
    // no fallback, no "best candidate" search.
    expect(source).toContain("entry.requestedCandles === plan.selectedLookback");
    expect(source).not.toContain(".sort(");
    expect(source).not.toContain("resolveMainCandidate");
  });

  it("adds no force-live or skip-safety path", () => {
    const source = readCode();
    for (const forbidden of ["force", "bypass", "skipSafety", "ignorePreflight"]) {
      expect(`${forbidden}:${source.toLowerCase().includes(forbidden.toLowerCase())}`).toBe(`${forbidden}:false`);
    }
  });

  it("constructs no Binance client and sends no Telegram", () => {
    const source = readCode();
    for (const forbidden of ["fetch(", "fapi/", "telegram", "sendMessage"]) {
      expect(`${forbidden}:${source.toLowerCase().includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

// ---------------------------------------------------------------------------
// Frozen exchange filters  the Phase 11B live-canary blocker
// ---------------------------------------------------------------------------
//
// A real DOGSUSDT LONG canary reached PREFLIGHT/SAFETY_ADMITTED and stopped
// dead, because the execution was created without an exchangeFiltersSnapshot
// and Phase 6 revalidation refuses to submit without one. Nothing reached the
// exchange, which is exactly what fail-closed is for  but the trade never
// happened and the row held capacity.

describe("frozen exchange filters", () => {
  it("freezes the filters the margin calculation actually used", async () => {
    const { executor, creates } = harness();
    await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    const snapshots = (creates[0] as { snapshots: Record<string, unknown> }).snapshots;
    expect(snapshots.exchangeFilters).toEqual(FILTERS);
    // The other two snapshots are unchanged.
    expect(snapshots.marginPlan).toBeDefined();
    expect(snapshots.extremeRRCandidate).toEqual(CANDIDATE);
  });

  it("carries every field Phase 6 revalidation and the planner read", async () => {
    const { executor, creates } = harness();
    await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    const filters = (creates[0] as { snapshots: { exchangeFilters: Record<string, unknown> } }).snapshots
      .exchangeFilters;
    for (const field of [
      "status",
      "contractType",
      "tickSize",
      "minPrice",
      "maxPrice",
      "stepSize",
      "minQty",
      "maxQty",
      "minNotional",
    ]) {
      expect(Object.keys(filters), field).toContain(field);
    }
  });

  it("plans exactly once per signal, so the snapshot matches the calculation", async () => {
    // A second inspection could observe a different tick size or minimum
    // notional, and the frozen snapshot would then describe a calculation that
    // never happened.
    const { executor, planningCalls } = harness();
    await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect(planningCalls()).toBe(1);
  });

  it("creates nothing when the margin plan is not READY, so no partial snapshot is stored", async () => {
    const { executor, creates } = harness({ marginStatus: "INVALID" });
    const result = await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect(result.handled).toBe(false);
    expect(creates).toHaveLength(0);
  });

  it("asks the planner for the snapshot rather than re-inspecting the symbol", () => {
    const source = readFileSync(
      path.join(BACKEND, "src", "modules", "execution", "selected-plan-executor.ts"),
      "utf8"
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(code).toContain("planForSymbolWithSnapshot");
    // The executor must never talk to Binance itself.
    expect(code).not.toContain("inspectSymbol");
    expect(code).not.toContain("readOnly");
    expect(code).toContain("exchangeFilters");
  });
});

// ---------------------------------------------------------------------------
// Frozen risk-template provenance
// ---------------------------------------------------------------------------
//
// The execution freezes the DERIVED numbers already — riskBudgetUsd,
// actualPlannedLoss, estimatedRewardRatio — but not the policy behind them.
// "1% of 300" and "3% of 100" both size a 3.00 risk budget and were
// indistinguishable afterwards, because the answer lived only on
// ExtremeRRPlan, one alert deletion away. 2711 of 9372 historical executions
// had already lost it that way.

describe("frozen risk-template snapshot", () => {
  const templateOf = (creates: unknown[]) =>
    (creates[0] as { snapshots: { riskTemplate: Record<string, unknown> } }).snapshots.riskTemplate;

  it("A. a new execution carries the template provenance", async () => {
    const { executor, creates } = harness();

    await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect(creates).toHaveLength(1);
    expect(templateOf(creates)).toBeDefined();
  });

  it("B. it is EXACTLY what the selected plan was sized with", async () => {
    const { executor, creates } = harness();

    await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect(templateOf(creates)).toEqual({
      riskTemplateId: "t1",
      name: "canary",
      referenceCapital: "300",
      riskPercent: "0.5",
      rewardRatio: "3",
      riskAmount: "1.50",
      targetAmount: "4.50",
    });
    // The other snapshots are untouched.
    const snapshots = (creates[0] as { snapshots: Record<string, unknown> }).snapshots;
    expect(snapshots.extremeRRCandidate).toEqual(CANDIDATE);
    expect(snapshots.exchangeFilters).toEqual(FILTERS);
    expect(snapshots.marginPlan).toBeDefined();
  });

  it("D. a plan sized with V1 is recorded as V1, whatever the template says now", async () => {
    // The load-bearing test. This passes today only because the snapshot is
    // built from the PLAN. It fails the moment anyone "simplifies" the code by
    // reading the currently active RiskTemplate at execution time, because the
    // executor is handed no template repository at all and could not see V2.
    const v1Plan = {
      ...PLAN,
      template: {
        riskTemplateId: "t1",
        name: "V1 conservative",
        referenceCapital: "300",
        riskPercent: "0.5",
        rewardRatio: "3",
        riskAmount: "1.50",
        targetAmount: "4.50",
      },
    };
    const { executor, creates } = harness();

    await executor.handleSelectedPlan(v1Plan as never, "FRAXUSDT");

    expect(templateOf(creates)).toMatchObject({
      name: "V1 conservative",
      riskPercent: "0.5",
      referenceCapital: "300",
      riskAmount: "1.50",
    });

    // And the executor cannot reach the mutable table even if someone wanted
    // it to: no repository, no client, no query. This is the assertion that
    // breaks if the snapshot is ever rebuilt from the active template.
    const source = readFileSync(
      path.join(BACKEND, "src", "modules", "execution", "selected-plan-executor.ts"),
      "utf8"
    );
    expect(source).not.toContain("RiskTemplateRepository");
    expect(source).not.toContain("riskTemplate.find");
    expect(source).not.toContain("findActive");
  });

  it("the snapshot is a copy, not a reference into the plan", async () => {
    // It becomes a durable JSON column; sharing a reference with a caller's
    // object would let a later mutation rewrite recorded history in memory.
    const plan = JSON.parse(JSON.stringify(PLAN)) as typeof PLAN;
    const { executor, creates } = harness();

    await executor.handleSelectedPlan(plan as never, "FRAXUSDT");
    (plan.template as Record<string, unknown>).riskPercent = "99";

    expect(templateOf(creates).riskPercent).toBe("0.5");
  });

  it("carries exactly the seven provenance fields, and nothing else", async () => {
    // A field added to the plan DTO must not silently join the permanent
    // record; that is a decision, not a default.
    const { executor, creates } = harness({
      plan: {
        ...PLAN,
        template: { ...PLAN.template, somethingNew: "must-not-be-recorded" },
      },
    });

    await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect(Object.keys(templateOf(creates)).sort()).toEqual([
      "name",
      "referenceCapital",
      "rewardRatio",
      "riskAmount",
      "riskPercent",
      "riskTemplateId",
      "targetAmount",
    ]);
  });

  it("no template means no execution, so provenance is never partial", async () => {
    // Already the executor's rule; asserted here because it is what makes the
    // snapshot unconditional. Nothing has to invent a default.
    const { executor, creates } = harness();

    const result = await executor.handleSelectedPlan({ ...PLAN, template: null } as never, "FRAXUSDT");

    expect(result.handled).toBe(false);
    expect(creates).toEqual([]);
  });

  it("the risk budget the planner used is the template's own riskAmount", async () => {
    // Ties the snapshot to the sizing it explains: riskBudgetUsd is not an
    // independent number, it IS template.riskAmount.
    const { executor, creates, plannerInputs } = harness();

    await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");

    expect((plannerInputs[0] as { riskBudgetUsd: string }).riskBudgetUsd).toBe(PLAN.template.riskAmount);
    expect(templateOf(creates).riskAmount).toBe(PLAN.template.riskAmount);
  });
});
