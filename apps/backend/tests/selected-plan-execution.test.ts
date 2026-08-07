import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SelectedPlanExecutor } from "../src/modules/execution/selected-plan-executor";
import { RECONCILABLE_STATUSES } from "../src/modules/execution/execution-orchestrator";

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
} = {}) {
  const creates: unknown[] = [];
  const admissions: string[] = [];
  let createCalls = 0;

  const executor = new SelectedPlanExecutor({
    prisma: {
      executionProfile: {
        findMany: async () =>
          options.profileFound === false ? [] : [{ id: "profile-1", safetyPolicy: { id: "policy-1" } }],
      },
      tradeExecution: {
        findFirst: async () => (options.existingExecutionId ? { id: options.existingExecutionId } : null),
      },
    } as never,
    marginPlanner: {
      planForSymbol: async () => ({
        status: options.marginStatus ?? "READY",
        selectedLeverage: options.marginStatus === "READY" || !options.marginStatus ? 21 : null,
        reason: null,
      }),
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
    profileIdentity: { accountIdentifier: "alias", environment: "TESTNET" },
  });

  return { executor, creates, admissions, createCalls: () => createCalls };
}

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

  it("creates nothing when no execution profile is available", async () => {
    const { executor, creates } = harness({ profileFound: false });
    const result = await executor.handleSelectedPlan(PLAN as never, "FRAXUSDT");
    expect((result as { reasonCode: string }).reasonCode).toBe("PROFILE_UNAVAILABLE");
    expect(creates).toHaveLength(0);
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
    expect(source).toMatch(/selectedPlanExecutor\.handleSelectedPlan\(/);
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
    expect(source).toContain("new BinanceMarginPlanService()");
    expect(source).toContain("new ExecutionService(prisma)");
    expect(source).toContain("createExecutionOrchestrator()");
  });

  it("registers startup recovery and the reconciliation scheduler", () => {
    const source = worker();
    expect(source).toContain("startExecutionOrchestrationScheduler()");
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
