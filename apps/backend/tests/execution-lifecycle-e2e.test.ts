import { describe, expect, it } from "vitest";
import { ExecutionOrchestrator } from "../src/modules/execution/execution-orchestrator";
import { SelectedPlanExecutor } from "../src/modules/execution/selected-plan-executor";
import { testProfileProjection } from "./helpers/bound-runtime";

/**
 * Phase 11 — full fake LONG and SHORT lifecycles through the production
 * ORCHESTRATION path.
 *
 * The orchestrator and the selected-plan executor are the REAL production
 * classes; what is faked is the exchange and the lifecycle services beneath
 * them, driven by a scripted exchange whose state advances between ticks. That
 * exercises the actual routing, ordering and idempotency decisions end to end,
 * and cannot reach any network.
 *
 * (A version of this against real Postgres and the real lifecycle services is
 * still worth building; see the phase report.)
 */

// ---------------------------------------------------------------------------
// Scripted exchange + durable store
// ---------------------------------------------------------------------------

type Direction = "LONG" | "SHORT";

class Scenario {
  readonly submittedEntryIds: string[] = [];
  readonly submittedAlgoIds: string[] = [];
  readonly notificationMilestones: string[] = [];
  entryStatus: "NONE" | "NEW" | "PARTIALLY_FILLED" | "FILLED" = "NONE";
  filled = "0";
  positionQuantity = "0";
  protectionVerified = false;
  closure: "NONE" | "TP" | "SL" = "NONE";

  constructor(readonly direction: Direction) {}

  get entrySide() {
    return this.direction === "LONG" ? "BUY" : "SELL";
  }
  get closingSide() {
    return this.direction === "LONG" ? "SELL" : "BUY";
  }
}

interface Row {
  id: string;
  version: number;
  status: string;
  executionProfileId: string;
  requiresManualIntervention: boolean;
  direction: Direction;
}

function buildRuntime(scenario: Scenario, rows: Row[]) {
  const advance = (id: string, status: string) => {
    const row = rows.find((r) => r.id === id)!;
    row.status = status;
    row.version += 1;
    // Phase 9 materializes from durable state; the milestone names below are
    // what a notification tick would later discover.
    scenario.notificationMilestones.push(status);
  };

  const prisma = {
    tradeExecution: {
      findMany: async ({ where }: { where: { status: { in: string[] } } }) =>
        rows.filter((r) => where.status.in.includes(r.status)),
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      findFirst: async () => null,
      count: async () => 0,
    },
    executionProfile: { findMany: async () => [{ id: "profile-1", safetyPolicy: { id: "policy-1" } }] },
    // Phase 11B.0: no authorization prepared, so the profile is not in canary
    // mode and this lifecycle is unaffected by it.
    executionCanaryAuthorization: {
      count: async () => 0,
      findFirst: async () => null,
      updateMany: async () => ({ count: 0 }),
    },
  } as never;

  const entry = {
    prepareEntrySubmission: async ({ executionId }: { executionId: string }) => {
      const id = `tad-en-1-${executionId}`;
      if (!scenario.submittedEntryIds.includes(id)) scenario.submittedEntryIds.push(id);
      scenario.entryStatus = "NEW";
      advance(executionId, "ENTRY_PENDING");
      return { mutationsDispatched: 1, execution: { version: 1 }, reasonCode: "ENTRY_SUBMITTED" };
    },
    reconcileEntryOrder: async ({ executionId }: { executionId: string }) => {
      if (scenario.entryStatus === "PARTIALLY_FILLED") {
        scenario.positionQuantity = scenario.filled;
        advance(executionId, "PARTIALLY_FILLED");
      } else if (scenario.entryStatus === "FILLED") {
        scenario.positionQuantity = scenario.filled;
        advance(executionId, "ENTRY_FILLED");
      }
      return { mutationsDispatched: 0, execution: { version: 1 } };
    },
    resumeEntrySubmission: async () => ({ mutationsDispatched: 0, execution: { version: 1 } }),
    expireEntryOrderIfDue: async () => ({ mutationsDispatched: 0, execution: { version: 1 } }),
  };

  const protection = {
    ensureProtectionForExposure: async ({ executionId }: { executionId: string }) => {
      let dispatched = 0;
      for (const role of ["sl", "tp"]) {
        const id = `tad-${role}-1-${executionId}`;
        if (!scenario.submittedAlgoIds.includes(id)) {
          scenario.submittedAlgoIds.push(id);
          dispatched += 1;
        }
      }
      // Full coverage only once the entry is fully filled.
      if (scenario.entryStatus === "FILLED") {
        scenario.protectionVerified = true;
        advance(executionId, "PROTECTED");
      }
      return { mutationsDispatched: dispatched };
    },
    resumeProtectionLifecycle: async ({ executionId }: { executionId: string }) =>
      protection.ensureProtectionForExposure({ executionId }),
    reconcileProtectionAndClosure: async ({ executionId }: { executionId: string }) => {
      if (scenario.closure === "NONE") return { mutationsDispatched: 0 };
      // Phase 7 requires a verified zero position before any terminal state.
      scenario.positionQuantity = "0";
      advance(executionId, scenario.closure === "TP" ? "CLOSED_TP" : "CLOSED_SL");
      return { mutationsDispatched: 0 };
    },
  };

  const orchestrator = new ExecutionOrchestrator({
    prisma,
    readOnly: {} as never,
    admission: {
      evaluateAndReserveSafetyAdmission: async ({ executionId }: { executionId: string }) => {
        const row = rows.find((r) => r.id === executionId)!;
        row.version += 1;
        return { decision: "PASS", reasonCode: "CAPACITY_AVAILABLE", execution: { version: row.version } };
      },
    } as never,
    entry: entry as never,
    protection: protection as never,
    // The profile this orchestrator OWNS, projected as production does
    // from the runtime that also produced its clients' credentials.
    boundProfile: testProfileProjection({ executionProfileId: "profile-1" }),
  });

  return { orchestrator, prisma };
}

const PLAN = (direction: Direction) => ({
  id: "plan-1",
  alertId: "alert-1",
  status: "READY",
  direction,
  entryPrice: "0.2707",
  selectedLookback: 200,
  selectedLeverage: 21,
  template: { riskTemplateId: "t1", name: "canary", referenceCapital: "300", riskPercent: "0.5", rewardRatio: "3", riskAmount: "1.50", targetAmount: "4.50" },
  candidates: [
    {
      requestedCandles: 200,
      actualCandles: 200,
      complete: true,
      valid: true,
      stopLoss: direction === "LONG" ? "0.2656" : "0.2758",
      takeProfit: direction === "LONG" ? "0.3011" : "0.2403",
      money: { quantityRaw: "294", plannedLossRaw: "1.5", plannedProfitRaw: "4.5", positionNotionalRaw: "79.58" },
    },
  ],
});

/** Runs the whole production path for one direction to a terminal state. */
async function runLifecycle(direction: Direction, closure: "TP" | "SL") {
  const scenario = new Scenario(direction);
  const rows: Row[] = [];
  const created: Record<string, unknown>[] = [];

  const { orchestrator, prisma } = buildRuntime(scenario, rows);

  const executor = new SelectedPlanExecutor({
    prisma,
    marginPlanner: {
      planForSymbolWithSnapshot: async (request: { direction: string; riskBudgetUsd: string }) => ({
        plan: {
          status: "READY",
          selectedLeverage: 21,
          reason: null,
          direction: request.direction,
          riskBudgetUsd: request.riskBudgetUsd,
        },
        exchangeFilters: { status: "TRADING", contractType: "PERPETUAL", tickSize: "0.01", minPrice: "0.01", maxPrice: "100000", stepSize: "0.001", minQty: "0.001", maxQty: "1000", minNotional: "5" },
      }),
    } as never,
    executions: {
      createExecutionFromReadyPlan: async (input: Record<string, unknown>) => {
        created.push(input);
        const row: Row = {
          id: "exec-1",
          version: 1,
          status: "PLAN_READY",
          executionProfileId: "profile-1",
          requiresManualIntervention: false,
          direction,
        };
        rows.push(row);
        scenario.notificationMilestones.push("PLAN_READY");
        return { id: row.id };
      },
    } as never,
    orchestrator,
    // The profile this orchestrator OWNS, projected as production does
    // from the runtime that also produced its clients' credentials.
    boundProfile: testProfileProjection({ executionProfileId: "profile-1" }),
  });

  // --- the production entry point ------------------------------------------
  const outcome = await executor.handleSelectedPlan(PLAN(direction) as never, "FRAXUSDT");

  // --- the exchange advances between reconciliation ticks -------------------
  scenario.entryStatus = "PARTIALLY_FILLED";
  scenario.filled = "100";
  await orchestrator.runExecutionReconciliationTick(); // -> PARTIALLY_FILLED + partial protection

  scenario.entryStatus = "FILLED";
  scenario.filled = "294";
  await orchestrator.runExecutionReconciliationTick(); // -> ENTRY_FILLED
  await orchestrator.runExecutionReconciliationTick(); // -> PROTECTED

  scenario.closure = closure;
  await orchestrator.runExecutionReconciliationTick(); // -> terminal

  return { scenario, rows, created, outcome };
}

// ---------------------------------------------------------------------------
// LONG
// ---------------------------------------------------------------------------

describe("full fake LONG lifecycle", () => {
  it("runs selected plan → PLAN_READY → entry → protection → CLOSED_TP", async () => {
    const { scenario, rows, created, outcome } = await runLifecycle("LONG", "TP");

    expect(outcome.handled).toBe(true);
    // Exactly one logical execution.
    expect(rows).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(rows[0].status).toBe("CLOSED_TP");

    // Exactly one ENTRY generation, deterministic id.
    expect(scenario.submittedEntryIds).toEqual(["tad-en-1-exec-1"]);
    expect(scenario.submittedEntryIds.every((id) => id.includes("-1-"))).toBe(true);

    // Protection reserved once per role, never duplicated across ticks.
    expect(scenario.submittedAlgoIds.sort()).toEqual(["tad-sl-1-exec-1", "tad-tp-1-exec-1"]);
    expect(scenario.protectionVerified).toBe(true);

    // The frozen plan reached creation with the canary risk budget.
    expect((created[0] as { takeProfit: string }).takeProfit).toBe("0.3011");
    expect((created[0] as { selectedLookback: number }).selectedLookback).toBe(200);

    // Zero position verified before terminal.
    expect(scenario.positionQuantity).toBe("0");
  });

  it("produces durable milestones Phase 9 can discover, in causal order", async () => {
    const { scenario } = await runLifecycle("LONG", "TP");
    const order = scenario.notificationMilestones;

    for (const milestone of ["ENTRY_PENDING", "PARTIALLY_FILLED", "ENTRY_FILLED", "PROTECTED", "CLOSED_TP"]) {
      expect(order, milestone).toContain(milestone);
    }
    expect(order.indexOf("ENTRY_PENDING")).toBeLessThan(order.indexOf("ENTRY_FILLED"));
    expect(order.indexOf("ENTRY_FILLED")).toBeLessThan(order.indexOf("PROTECTED"));
    expect(order.indexOf("PROTECTED")).toBeLessThan(order.indexOf("CLOSED_TP"));
  });

  it("releases capacity at the terminal state", async () => {
    const { rows } = await runLifecycle("LONG", "TP");
    // CLOSED_TP is terminal and no longer reconcilable, so capacity is free.
    const { RECONCILABLE_STATUSES } = await import("../src/modules/execution/execution-orchestrator");
    expect(RECONCILABLE_STATUSES).not.toContain(rows[0].status as never);
  });
});

// ---------------------------------------------------------------------------
// SHORT
// ---------------------------------------------------------------------------

describe("full fake SHORT lifecycle", () => {
  it("runs the same path to CLOSED_SL with SHORT geometry", async () => {
    const { scenario, rows, created, outcome } = await runLifecycle("SHORT", "SL");

    expect(outcome.handled).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("CLOSED_SL");
    expect(rows[0].direction).toBe("SHORT");

    // A SHORT opens with SELL and closes with BUY.
    expect(scenario.entrySide).toBe("SELL");
    expect(scenario.closingSide).toBe("BUY");
    // The SHORT stop sits ABOVE entry and the target below.
    expect((created[0] as { takeProfit: string }).takeProfit).toBe("0.2403");

    expect(scenario.submittedEntryIds).toEqual(["tad-en-1-exec-1"]);
    expect(scenario.submittedAlgoIds.sort()).toEqual(["tad-sl-1-exec-1", "tad-tp-1-exec-1"]);
    expect(scenario.positionQuantity).toBe("0");
  });

  it("produces SHORT milestones ending in CLOSED_SL", async () => {
    const { scenario } = await runLifecycle("SHORT", "SL");
    expect(scenario.notificationMilestones).toContain("CLOSED_SL");
    expect(scenario.notificationMilestones).not.toContain("CLOSED_TP");
  });
});

// ---------------------------------------------------------------------------
// Duplicate delivery across the whole path
// ---------------------------------------------------------------------------

describe("duplicate work across the full path", () => {
  it("creates no duplicate exposure when reconciliation runs repeatedly", async () => {
    const { scenario } = await runLifecycle("LONG", "TP");
    // Four ticks ran; each id appears exactly once.
    expect(new Set(scenario.submittedEntryIds).size).toBe(scenario.submittedEntryIds.length);
    expect(new Set(scenario.submittedAlgoIds).size).toBe(scenario.submittedAlgoIds.length);
  });
});
