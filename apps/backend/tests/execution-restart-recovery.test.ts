import { describe, expect, it } from "vitest";
import { ExecutionOrchestrator } from "../src/modules/execution/execution-orchestrator";

/**
 * Phase 11 — fresh-runtime crash/restart simulation.
 *
 * A "restart" here means EVERY runtime object is discarded and rebuilt: new
 * lifecycle services, a new orchestrator, a new scheduler-equivalent. What
 * survives is exactly what would survive a real process death — the persisted
 * execution rows and the exchange's own state, both modelled here by objects
 * that are deliberately passed across the restart boundary.
 *
 * Toggling a flag on a surviving service would prove nothing, so nothing here
 * does that.
 */

// ---------------------------------------------------------------------------
// Durable state that survives a "process death"
// ---------------------------------------------------------------------------

interface StoredExecution {
  id: string;
  version: number;
  status: string;
  executionProfileId: string;
  requiresManualIntervention: boolean;
}

/** The exchange. Survives restarts, exactly like the real one. */
class FakeExchange {
  /** clientOrderId -> order. A resubmission under a NEW id would show up here. */
  readonly orders = new Map<string, { status: string; executedQty: string }>();
  readonly algoOrders = new Map<string, { status: string }>();
  /** Every query, so "did it ask about the same id?" is answerable. */
  readonly queriedClientOrderIds: string[] = [];
  readonly submittedClientOrderIds: string[] = [];
  readonly submittedAlgoIds: string[] = [];
}

/** The database. Survives restarts. */
class FakeDatabase {
  constructor(public executions: StoredExecution[]) {}

  prismaLike() {
    return {
      tradeExecution: {
        findMany: async ({ where }: { where: { status: { in: string[] } } }) =>
          this.executions.filter((e) => where.status.in.includes(e.status)),
        findUnique: async ({ where }: { where: { id: string } }) =>
          this.executions.find((e) => e.id === where.id) ?? null,
        count: async () => 0,
      },
      executionProfile: {
        findMany: async () => [{ id: "profile-1", safetyPolicy: { id: "policy-1" } }],
      },
    } as never;
  }
}

/**
 * Builds an ENTIRELY FRESH runtime over surviving durable state. Every call
 * returns new service objects — this is the restart.
 */
function freshRuntime(db: FakeDatabase, exchange: FakeExchange) {
  const entry = {
    resumeEntrySubmission: async ({ executionId }: { executionId: string }) => {
      // Resume asks about the SAME deterministic id rather than submitting.
      const clientOrderId = `tad-en-1-${executionId}`;
      exchange.queriedClientOrderIds.push(clientOrderId);
      const existing = exchange.orders.get(clientOrderId);
      if (existing) {
        const row = db.executions.find((e) => e.id === executionId)!;
        row.status = existing.status === "FILLED" ? "ENTRY_FILLED" : "ENTRY_PENDING";
        row.version += 1;
      }
      return { mutationsDispatched: 0, execution: { version: 1 } };
    },
    reconcileEntryOrder: async ({ executionId }: { executionId: string }) => {
      exchange.queriedClientOrderIds.push(`tad-en-1-${executionId}`);
      return { mutationsDispatched: 0, execution: { version: 1 } };
    },
    expireEntryOrderIfDue: async () => ({ mutationsDispatched: 0, execution: { version: 1 } }),
    prepareEntrySubmission: async ({ executionId }: { executionId: string }) => {
      const clientOrderId = `tad-en-1-${executionId}`;
      exchange.submittedClientOrderIds.push(clientOrderId);
      exchange.orders.set(clientOrderId, { status: "NEW", executedQty: "0" });
      return { mutationsDispatched: 1, execution: { version: 1 }, reasonCode: "ENTRY_SUBMITTED" };
    },
  };

  const protection = {
    ensureProtectionForExposure: async ({ executionId }: { executionId: string }) => {
      const row = db.executions.find((e) => e.id === executionId)!;
      // Only reserve a tranche the exchange does not already have.
      const stopId = `tad-sl-1-${executionId}`;
      const tpId = `tad-tp-1-${executionId}`;
      let dispatched = 0;
      for (const id of [stopId, tpId]) {
        if (!exchange.algoOrders.has(id)) {
          exchange.algoOrders.set(id, { status: "NEW" });
          exchange.submittedAlgoIds.push(id);
          dispatched += 1;
        }
      }
      row.status = "PROTECTED";
      row.version += 1;
      return { mutationsDispatched: dispatched };
    },
    resumeProtectionLifecycle: async ({ executionId }: { executionId: string }) =>
      protection.ensureProtectionForExposure({ executionId }),
    reconcileProtectionAndClosure: async ({ executionId }: { executionId: string }) => {
      // Verified coverage is queried, never re-created.
      for (const id of [`tad-sl-1-${executionId}`, `tad-tp-1-${executionId}`]) {
        exchange.queriedClientOrderIds.push(id);
      }
      return { mutationsDispatched: 0 };
    },
  };

  const orchestrator = new ExecutionOrchestrator({
    prisma: db.prismaLike(),
    readOnly: {} as never,
    admission: {
      evaluateAndReserveSafetyAdmission: async ({ executionId }: { executionId: string }) => {
        const row = db.executions.find((e) => e.id === executionId)!;
        row.status = "PREFLIGHT";
        row.version += 1;
        return { decision: "PASS", reasonCode: "CAPACITY_AVAILABLE", execution: { version: row.version } };
      },
    } as never,
    entry: entry as never,
    protection: protection as never,
    profileIdentity: { accountIdentifier: "alias", environment: "TESTNET" },
  });

  return { orchestrator };
}

const stored = (status: string, id = "exec-1"): StoredExecution => ({
  id,
  version: 3,
  status,
  executionProfileId: "profile-1",
  requiresManualIntervention: false,
});

// ---------------------------------------------------------------------------
// A. Crash after Binance accepted the entry, before local acknowledgement
// ---------------------------------------------------------------------------

describe("restart after entry acceptance", () => {
  it("queries the same deterministic id and submits no second order", async () => {
    const db = new FakeDatabase([stored("ENTRY_SUBMITTING")]);
    const exchange = new FakeExchange();
    // The exchange already has the order; the local row never learned that.
    exchange.orders.set("tad-en-1-exec-1", { status: "NEW", executedQty: "0" });

    // --- PROCESS DEATH: every runtime object below is brand new -------------
    const { orchestrator } = freshRuntime(db, exchange);
    await orchestrator.runStartupRecovery();

    expect(exchange.queriedClientOrderIds).toContain("tad-en-1-exec-1");
    // No resubmission of any kind, under any id.
    expect(exchange.submittedClientOrderIds).toEqual([]);
    expect(exchange.orders.size).toBe(1);
    // The lifecycle continued from the reconciled state.
    expect(db.executions[0].status).toBe("ENTRY_PENDING");
  });

  it("creates no new ENTRY generation", async () => {
    const db = new FakeDatabase([stored("ENTRY_SUBMITTING")]);
    const exchange = new FakeExchange();
    exchange.orders.set("tad-en-1-exec-1", { status: "NEW", executedQty: "0" });

    const first = freshRuntime(db, exchange);
    await first.orchestrator.runStartupRecovery();
    // A second restart must be just as safe as the first.
    const second = freshRuntime(db, exchange);
    await second.orchestrator.runStartupRecovery();

    const entryIds = [...exchange.orders.keys()].filter((id) => id.startsWith("tad-en-"));
    expect(entryIds).toEqual(["tad-en-1-exec-1"]);
    expect(entryIds.every((id) => id.includes("-1-"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. Crash after fill, before protection completed
// ---------------------------------------------------------------------------

describe("restart after fill before protection", () => {
  it("resumes protection for the surviving exposure", async () => {
    const db = new FakeDatabase([stored("ENTRY_FILLED")]);
    const exchange = new FakeExchange();
    exchange.orders.set("tad-en-1-exec-1", { status: "FILLED", executedQty: "294" });

    const { orchestrator } = freshRuntime(db, exchange);
    await orchestrator.runStartupRecovery();

    expect(db.executions[0].status).toBe("PROTECTED");
    expect(exchange.submittedAlgoIds.sort()).toEqual(["tad-sl-1-exec-1", "tad-tp-1-exec-1"]);
  });

  it("does not duplicate a STOP that is already verified", async () => {
    const db = new FakeDatabase([stored("PLACING_PROTECTION")]);
    const exchange = new FakeExchange();
    exchange.orders.set("tad-en-1-exec-1", { status: "FILLED", executedQty: "294" });
    // The STOP landed before the crash; the TP did not.
    exchange.algoOrders.set("tad-sl-1-exec-1", { status: "NEW" });

    const { orchestrator } = freshRuntime(db, exchange);
    await orchestrator.runStartupRecovery();

    // Only the missing TP was submitted.
    expect(exchange.submittedAlgoIds).toEqual(["tad-tp-1-exec-1"]);
    expect([...exchange.algoOrders.keys()].sort()).toEqual(["tad-sl-1-exec-1", "tad-tp-1-exec-1"]);
  });
});

// ---------------------------------------------------------------------------
// C. Crash while already PROTECTED
// ---------------------------------------------------------------------------

describe("restart while protected", () => {
  it("queries the persisted protection identities and creates nothing", async () => {
    const db = new FakeDatabase([stored("PROTECTED")]);
    const exchange = new FakeExchange();
    exchange.orders.set("tad-en-1-exec-1", { status: "FILLED", executedQty: "294" });
    exchange.algoOrders.set("tad-sl-1-exec-1", { status: "NEW" });
    exchange.algoOrders.set("tad-tp-1-exec-1", { status: "NEW" });

    const { orchestrator } = freshRuntime(db, exchange);
    await orchestrator.runStartupRecovery();

    expect(exchange.queriedClientOrderIds).toContain("tad-sl-1-exec-1");
    expect(exchange.queriedClientOrderIds).toContain("tad-tp-1-exec-1");
    // Existing protection stays authoritative — nothing new was submitted.
    expect(exchange.submittedAlgoIds).toEqual([]);
    expect(exchange.algoOrders.size).toBe(2);
  });

  it("is safe across repeated restarts", async () => {
    const db = new FakeDatabase([stored("PROTECTED")]);
    const exchange = new FakeExchange();
    exchange.algoOrders.set("tad-sl-1-exec-1", { status: "NEW" });
    exchange.algoOrders.set("tad-tp-1-exec-1", { status: "NEW" });

    for (let restart = 0; restart < 3; restart += 1) {
      const { orchestrator } = freshRuntime(db, exchange);
      await orchestrator.runStartupRecovery();
    }

    expect(exchange.submittedAlgoIds).toEqual([]);
    expect(exchange.algoOrders.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// D. PLAN_READY survives without BullMQ
// ---------------------------------------------------------------------------

describe("PLAN_READY startup discovery", () => {
  it("admits a persisted PLAN_READY execution whose original job disappeared", async () => {
    const db = new FakeDatabase([stored("PLAN_READY")]);
    const exchange = new FakeExchange();

    // No BullMQ delivery here at all — only startup recovery.
    const { orchestrator } = freshRuntime(db, exchange);
    await orchestrator.runStartupRecovery();

    expect(exchange.submittedClientOrderIds).toEqual(["tad-en-1-exec-1"]);
    expect(db.executions[0].status).not.toBe("PLAN_READY");
  });
});

// ---------------------------------------------------------------------------
// E. Two fresh workers
// ---------------------------------------------------------------------------

describe("two fresh workers", () => {
  it("produce at most one logical ENTRY identity", async () => {
    const db = new FakeDatabase([stored("PLAN_READY")]);
    const exchange = new FakeExchange();

    // Two independently constructed runtimes over the same durable state.
    const workerA = freshRuntime(db, exchange);
    const workerB = freshRuntime(db, exchange);
    await Promise.all([workerA.orchestrator.runStartupRecovery(), workerB.orchestrator.runStartupRecovery()]);

    const entryIds = new Set(exchange.submittedClientOrderIds);
    // The id is deterministic, so even a racing duplicate addresses the SAME
    // order rather than creating a second one.
    expect(entryIds.size).toBe(1);
    expect([...entryIds]).toEqual(["tad-en-1-exec-1"]);
    expect(exchange.orders.size).toBe(1);
  });

  it("do not duplicate protection", async () => {
    const db = new FakeDatabase([stored("ENTRY_FILLED")]);
    const exchange = new FakeExchange();

    const workerA = freshRuntime(db, exchange);
    const workerB = freshRuntime(db, exchange);
    await Promise.all([workerA.orchestrator.runStartupRecovery(), workerB.orchestrator.runStartupRecovery()]);

    expect(exchange.algoOrders.size).toBe(2);
    expect(new Set(exchange.submittedAlgoIds).size).toBe(2);
  });
});
