import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";

/**
 * Durable evidence when reconciling ONE execution throws.
 *
 * ## Why this exists
 *
 * `reconcileOne` has always caught per-execution failures so a single bad row
 * cannot abort the batch. It logged the error and returned — and the launcher
 * spawns the worker with `stdio: "ignore"`, so on a real runtime that log line
 * goes to NUL. A MAINNET execution then sat filled and unprotected for over an
 * hour while its timeline's last entry predated the failures entirely: from
 * the outside, indistinguishable from a row nothing had tried to touch.
 *
 * These tests drive the REAL reconciliation tick — the function the worker's
 * timer calls — and assert on what survives in the database afterwards.
 * Nothing here calls the recorder directly.
 */

const TAG = "recon-evidence-synthetic";
const SYMBOL = "DIAGPUSDT";

const OVERRIDDEN = ["EXECUTION_PROFILE_ACCOUNT_IDENTIFIER", "EXECUTION_PROFILE_ENVIRONMENT"];
const originalEnv = new Map(OVERRIDDEN.map((key) => [key, process.env[key]]));
process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = `${TAG}-account`;
process.env.EXECUTION_PROFILE_ENVIRONMENT = "TESTNET";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ExecutionOrchestrator } = await import("../src/modules/execution/execution-orchestrator");
const { ExecutionService, RECONCILIATION_FAILURE_REASON_CODE } = await import(
  "../src/modules/execution/execution.service"
);

const maybe = () => (available ? it : it.skip);

let profileId = "";
let sequence = 0;

/** How the protection service behaves for this test. */
interface Behaviour {
  throwFor: Set<string>;
  throwMessage: string;
  /** Executions whose reconciliation succeeded, in call order. */
  handled: string[];
  /** Every exchange-shaped side effect the fakes were asked to perform. */
  sideEffects: string[];
}

const behaviour: Behaviour = {
  throwFor: new Set(),
  throwMessage: "positionRisk timed out after 10000ms",
  handled: [],
  sideEffects: [],
};

function resetBehaviour() {
  behaviour.throwFor = new Set();
  behaviour.throwMessage = "positionRisk timed out after 10000ms";
  behaviour.handled = [];
  behaviour.sideEffects = [];
}

/**
 * The orchestrator the worker builds, with the protection service faked so a
 * chosen execution throws exactly where a real transport would.
 *
 * Everything upstream — the selection query, the ordering, the batch, the
 * dispatch switch and the catch — is the real production code.
 */
function orchestrator(overrides: Record<string, unknown> = {}) {
  const protection = {
    reconcileProtectionAndClosure: async ({ executionId }: { executionId: string }) => {
      if (behaviour.throwFor.has(executionId)) throw new Error(behaviour.throwMessage);
      behaviour.handled.push(executionId);
      const row = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });
      return { mutationsDispatched: 0, execution: row };
    },
    ensureProtectionForExposure: async ({ executionId }: { executionId: string }) => {
      const row = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });
      // Nothing is protected in these tests; the point is the catch.
      return { mutationsDispatched: 0, execution: row, reasonCode: "POSITION_STATE_UNAVAILABLE", message: "unreadable" };
    },
    parkUnresolvedFilledExposure: async () => {
      behaviour.sideEffects.push("PARK");
      const row = { status: "MANUAL_INTERVENTION", version: 1 };
      return { mutationsDispatched: 0, execution: row };
    },
    attemptProtectionRecovery: async () => ({ mutationsDispatched: 0, execution: { status: "MANUAL_INTERVENTION", version: 1 } }),
    resumeProtectionLifecycle: async () => ({ mutationsDispatched: 0, execution: { status: "PLACING_PROTECTION", version: 1 } }),
    ...overrides,
  };

  return new ExecutionOrchestrator({
    prisma: prisma!,
    readOnly: {} as never,
    admission: {} as never,
    entry: {
      reconcileEntryOrder: async ({ executionId }: { executionId: string }) => {
        // Throws for the same ids as the protection fake, so a branch that
        // never reaches protection — ENTRY_PENDING, say — still exercises the
        // catch. The catch is status-agnostic and must stay that way.
        if (behaviour.throwFor.has(executionId)) throw new Error(behaviour.throwMessage);
        behaviour.sideEffects.push("RECONCILE_ENTRY");
        const row = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });
        return { mutationsDispatched: 0, execution: row };
      },
      expireEntryOrderIfDue: async () => {
        behaviour.sideEffects.push("EXPIRE_ENTRY");
        return { mutationsDispatched: 0, execution: { version: 1 } };
      },
      resumeEntrySubmission: async () => ({ mutationsDispatched: 0, execution: { version: 1 } }),
    } as never,
    protection: protection as never,
    // The real service: the recorder under test lives here, not in the
    // orchestrator, which writes nothing.
    executions: new ExecutionService(prisma!),
    profileIdentity: { accountIdentifier: `${TAG}-account`, environment: "TESTNET" },
  });
}

/** THE function the worker's timer calls. */
const tick = (overrides: Record<string, unknown> = {}) =>
  orchestrator(overrides).runExecutionReconciliationTick();

const eventsOf = (executionId: string) =>
  prisma!.executionEvent.findMany({
    where: { tradeExecutionId: executionId },
    orderBy: { sequenceNumber: "asc" },
  });

const failureEventsOf = async (executionId: string) =>
  (await eventsOf(executionId)).filter(
    (event) => event.reasonCode === RECONCILIATION_FAILURE_REASON_CODE
  );

const reload = (id: string) => prisma!.tradeExecution.findUniqueOrThrow({ where: { id } });

/** A reconcilable execution with a prior timeline event, as production has. */
async function persistExecution(status = "ENTRY_FILLED") {
  sequence += 1;
  const execution = await prisma!.tradeExecution.create({
    data: {
      executionProfileId: profileId,
      symbol: SYMBOL,
      direction: "LONG",
      positionSide: "LONG",
      selectedLookback: 200,
      status: status as never,
      plannedEntryPrice: "100",
      calculatedStopLoss: "96",
      executableStopLoss: "96",
      riskBudgetUsd: "1.50",
      quantityRaw: "0.100",
      plannedQuantity: "0.100",
      quantityStepSize: "0.001",
      actualPlannedLoss: "1.50",
      unusedRiskBudget: "0",
      positionNotional: "10.00",
      targetIsolatedMargin: "8.00",
      maximumIsolatedMargin: "8.00",
      selectedLeverage: 10,
      estimatedInitialMargin: "8.00",
      estimatedLiquidationPrice: "90.1",
      requiredLiquidationBoundary: "94",
      liquidationBufferRatio: "0.5",
      filledQuantity: "0.100",
      averageFillPrice: "100",
      firstFillAt: new Date(),
      entryFilledAt: new Date(),
    },
  });

  // The timeline already carries the transition that produced this state, at
  // a sequence number equal to the execution's version — exactly as every
  // committing path in the repository writes it.
  await prisma!.executionEvent.create({
    data: {
      tradeExecutionId: execution.id,
      sequenceNumber: execution.version,
      eventType: "ENTRY_RECONCILED",
      fromStatus: "ENTRY_PENDING",
      toStatus: "ENTRY_FILLED",
      reasonCode: "ENTRY_RECONCILED",
      message: "Entry order is FILLED.",
    },
  });
  return execution;
}

async function reset() {
  const ids = (
    await prisma!.tradeExecution.findMany({ where: { executionProfileId: profileId }, select: { id: true } })
  ).map((row) => row.id);
  if (ids.length > 0) {
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: { in: ids } } });
    await prisma!.executionEvent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
    await prisma!.executionProtectionState.deleteMany({ where: { tradeExecutionId: { in: ids } } });
    await prisma!.binanceOrder.deleteMany({ where: { tradeExecutionId: { in: ids } } });
    await prisma!.tradeExecution.deleteMany({ where: { id: { in: ids } } });
  }
}

beforeAll(async () => {
  if (!prisma || !available) return;
  const profile = await prisma.executionProfile.create({
    data: {
      name: "Reconciliation evidence synthetic profile",
      accountIdentifier: `${TAG}-account`,
      environment: "TESTNET",
      isEnabled: true,
    },
  });
  profileId = profile.id;
  await prisma.executionSafetyPolicy.create({
    data: {
      executionProfileId: profileId,
      killSwitchActive: false,
      allowedSymbols: [SYMBOL],
      maxOpenPositions: 5, maxPendingEntries: 5, maxTotalActiveTrades: 5,
      maxActivePerSymbolSide: 1, softOpenPositionTarget: 3,
      maxTotalPlannedRiskUsd: "7.50", maxTotalIsolatedMarginUsd: "40.00",
    },
  });
});

afterEach(async () => {
  resetBehaviour();
  if (!prisma || !available) return;
  await reset();
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    await reset();
    await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionProfile.deleteMany({ where: { id: profileId } });
  }
  await prisma.$disconnect();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ===========================================================================
// D1 / D8 — evidence, through the production tick
// ===========================================================================

describe("D1. a reconciliation throw leaves durable evidence", () => {
  maybe()("D1/D8. the real tick records one FAILURE_RECORDED event", async () => {
    const execution = await persistExecution();
    behaviour.throwFor.add(execution.id);

    const result = await tick();

    // The tick itself survived and reported honestly.
    expect(result.failed).toBe(false);
    expect(result.inspected).toBe(1);

    const failures = await failureEventsOf(execution.id);
    expect(failures).toHaveLength(1);
    const [event] = failures;
    expect(event.eventType).toBe("FAILURE_RECORDED");
    expect(event.reasonCode).toBe("RECONCILIATION_FAILED");
    expect(event.message).toBe(behaviour.throwMessage);
    // The state at the moment of failure, for diagnosis.
    expect(event.fromStatus).toBe("ENTRY_FILLED");
    const metadata = event.metadata as { executionVersion: number; status: string };
    expect(metadata.status).toBe("ENTRY_FILLED");
    expect(metadata.executionVersion).toBe(execution.version);
    // No transition is claimed: nothing moved.
    expect(event.toStatus).toBeNull();
  });

  maybe()("D1b. it appends AFTER the existing timeline rather than colliding", async () => {
    // Elsewhere a sequence number IS the version its transaction produced, so
    // the current version is already taken by the last real transition. The
    // recorder must not try to reuse it.
    const execution = await persistExecution();
    behaviour.throwFor.add(execution.id);

    await tick();

    const events = await eventsOf(execution.id);
    expect(events).toHaveLength(2);
    expect(events[0].eventType).toBe("ENTRY_RECONCILED");
    expect(events[1].eventType).toBe("FAILURE_RECORDED");
    expect(events[1].sequenceNumber).toBe(events[0].sequenceNumber + 1);
  });
});

// ===========================================================================
// D2 — batch isolation
// ===========================================================================

describe("D2. one failure does not stop the batch", () => {
  maybe()("D2. A throws and is recorded; B still reconciles", async () => {
    const failing = await persistExecution();
    const healthy = await persistExecution();
    behaviour.throwFor.add(failing.id);

    const result = await tick();

    expect(result.inspected).toBe(2);
    expect(result.failed).toBe(false);
    // B was handled despite A throwing.
    expect(behaviour.handled).toContain(healthy.id);
    expect(behaviour.handled).not.toContain(failing.id);
    // And only A carries evidence.
    expect(await failureEventsOf(failing.id)).toHaveLength(1);
    expect(await failureEventsOf(healthy.id)).toHaveLength(0);
  });
});

// ===========================================================================
// D3 / D4 — deduplication
// ===========================================================================

describe("D3-D4. repeated failures do not flood the timeline", () => {
  maybe()("D3. ten identical ticks record exactly one event", async () => {
    const execution = await persistExecution();
    behaviour.throwFor.add(execution.id);

    for (let index = 0; index < 10; index += 1) await tick();

    // Not ten. Not one per 30-second tick. Exactly one.
    expect(await failureEventsOf(execution.id)).toHaveLength(1);
    expect(await eventsOf(execution.id)).toHaveLength(2);
  });

  maybe()("D4. a materially different error is recorded as a new event", async () => {
    const execution = await persistExecution();
    behaviour.throwFor.add(execution.id);

    await tick();
    behaviour.throwMessage = "ECONNRESET while reading positionRisk";
    await tick();
    await tick();

    const failures = await failureEventsOf(execution.id);
    expect(failures).toHaveLength(2);
    expect(failures[0].message).toBe("positionRisk timed out after 10000ms");
    expect(failures[1].message).toBe("ECONNRESET while reading positionRisk");
  });

  maybe()("D4b. the same error after the execution moved is recorded again", async () => {
    // Dedup is scoped to (execution, failure, STATE). Once the execution's
    // version changes the failure is a new fact, not a repeat.
    const execution = await persistExecution();
    behaviour.throwFor.add(execution.id);

    await tick();
    expect(await failureEventsOf(execution.id)).toHaveLength(1);

    await prisma!.tradeExecution.update({
      where: { id: execution.id },
      data: { version: { increment: 1 } },
    });
    await tick();

    expect(await failureEventsOf(execution.id)).toHaveLength(2);
  });
});

// ===========================================================================
// D5 — the diagnostic must never break the tick
// ===========================================================================

describe("D5. recording failure is itself contained", () => {
  maybe()("D5. a broken recorder does not crash the tick or the batch", async () => {
    const failing = await persistExecution();
    const healthy = await persistExecution();
    behaviour.throwFor.add(failing.id);

    // Break the event write for every execution.
    const realCreate = prisma!.executionEvent.create.bind(prisma!.executionEvent);
    (prisma!.executionEvent as { create: unknown }).create = async () => {
      throw new Error("event table unavailable");
    };

    const result = await tick();

    (prisma!.executionEvent as { create: unknown }).create = realCreate;

    // The tick completed, the batch continued, nothing was rethrown.
    expect(result.failed).toBe(false);
    expect(result.inspected).toBe(2);
    expect(behaviour.handled).toContain(healthy.id);
    // No evidence was persisted, which is the honest outcome.
    expect(await failureEventsOf(failing.id)).toHaveLength(0);
    // And the execution was not touched by the attempt.
    expect((await reload(failing.id)).status).toBe("ENTRY_FILLED");
  });
});

// ===========================================================================
// D6 — sanitization and truncation
// ===========================================================================

describe("D6. the stored message is bounded and sanitized", () => {
  maybe()("D6. a very long error is truncated to the existing 200-char bound", async () => {
    const execution = await persistExecution();
    behaviour.throwFor.add(execution.id);
    behaviour.throwMessage = "E".repeat(5000);

    await tick();

    const [event] = await failureEventsOf(execution.id);
    expect(event.message).toHaveLength(200);
  });

  maybe()("D6b. credential-shaped fragments never reach the metadata", async () => {
    // The message bound is the existing one; the METADATA goes through the
    // repository's own sanitizer, so a careless future field cannot leak.
    const execution = await persistExecution();
    behaviour.throwFor.add(execution.id);

    await tick();

    const [event] = await failureEventsOf(execution.id);
    const serialized = JSON.stringify(event.metadata);
    expect(serialized).not.toMatch(/signature=/i);
    expect(serialized).not.toMatch(/X-MBX-APIKEY/i);
    // Only the three diagnostic fields are stored.
    expect(Object.keys(event.metadata as object).sort()).toEqual([
      "evaluatedAt",
      "executionVersion",
      "status",
    ]);
  });
});

// ===========================================================================
// D7 — no lifecycle side effects
// ===========================================================================

describe("D7. recording evidence changes nothing about the execution", () => {
  maybe()("D7. status, version and accounting are untouched", async () => {
    const execution = await persistExecution();
    behaviour.throwFor.add(execution.id);
    const before = await reload(execution.id);

    await tick();

    const after = await reload(execution.id);
    // Not terminalized, not parked, not protected, not moved at all.
    expect(after.status).toBe("ENTRY_FILLED");
    expect(after.version).toBe(before.version);
    expect(after.requiresManualIntervention).toBe(false);
    expect(after.exitReason).toBeNull();
    expect(after.closedAt).toBeNull();
    expect(after.filledQuantity?.toString()).toBe(before.filledQuantity?.toString());
    // Nothing was sent anywhere.
    expect(behaviour.sideEffects).toEqual([]);
    // And no operator alert was raised: this is a diagnostic, not a new hazard.
    expect(
      await prisma!.criticalAlert.count({ where: { tradeExecutionId: execution.id } })
    ).toBe(0);
  });

  maybe()("D7b. the failure is recorded for any reconcilable status, not just one", async () => {
    // The catch is status-agnostic and must stay that way — the next unknown
    // throw may not be on an ENTRY_FILLED row.
    for (const status of ["ENTRY_PENDING", "PLACING_PROTECTION", "PROTECTED"]) {
      await reset();
      const execution = await persistExecution(status);
      behaviour.throwFor.add(execution.id);

      await tick();

      const failures = await failureEventsOf(execution.id);
      expect(`${status}:${failures.length}`).toBe(`${status}:1`);
      expect(`${status}:${failures[0].fromStatus}`).toBe(`${status}:${status}`);
    }
  });
});
