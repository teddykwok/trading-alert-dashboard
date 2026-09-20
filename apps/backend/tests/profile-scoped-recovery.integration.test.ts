import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";
import { ExecutionOrchestrator } from "../src/modules/execution/execution-orchestrator";
import { EntryRecoveryService } from "../src/modules/execution/entry-recovery.service";
import { ProtectionRecoveryService } from "../src/modules/execution/protection-recovery.service";
import { ShutdownDrainService } from "../src/modules/execution/shutdown-drain.service";
import type { ShutdownPosture } from "../src/modules/execution/shutdown-drain";
import { testProfileProjection } from "./helpers/bound-runtime";

/**
 * Phase 11C — one process, one account, and a database holding two.
 *
 * The hazard these tests exist for is not subtle. This process holds Account
 * A's Binance credentials. If any recovery or reconciliation path discovers a
 * TradeExecution belonging to Account B, the signed request it then makes is
 * authenticated as A: A's keys cancelling B's order, or installing protection
 * on a position A does not hold.
 *
 * So every case below has the same shape. Two profiles, EQUALLY eligible rows
 * under each, a process bound to one of them, and three assertions:
 *
 *   1. the bound profile's row was reached;
 *   2. the foreign row was not, by id;
 *   3. the foreign row is unchanged afterwards, field by field.
 *
 * No Binance client exists anywhere in this file. The lifecycle services are
 * recorders and the read-only service throws if anything touches it, so "no
 * signed call for B" is proved by construction rather than by mocking a
 * response.
 */

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const maybe = () => (available ? it : it.skip);

const TAG = `phase11c-${randomBytes(6).toString("hex")}`;
const createdProfileIds: string[] = [];

/** A throwaway profile with the safety policy every resolution requires. */
async function makeProfile(suffix: string): Promise<{ id: string; accountIdentifier: string }> {
  const accountIdentifier = `${TAG}-${suffix}`;
  const profile = await prisma!.executionProfile.create({
    data: { name: accountIdentifier, accountIdentifier, environment: "TESTNET" },
    select: { id: true },
  });
  await prisma!.executionSafetyPolicy.create({ data: { executionProfileId: profile.id } });
  createdProfileIds.push(profile.id);
  return { id: profile.id, accountIdentifier };
}

async function makeExecution(
  executionProfileId: string,
  status: string,
  overrides: Record<string, unknown> = {}
) {
  return prisma!.tradeExecution.create({
    data: {
      executionProfileId,
      symbol: "BTCUSDT",
      direction: "LONG",
      positionSide: "LONG",
      selectedLookback: 60,
      status: status as never,
      plannedEntryPrice: "100",
      calculatedStopLoss: "95",
      executableStopLoss: "95",
      riskBudgetUsd: "1.5",
      quantityRaw: "0.3",
      plannedQuantity: "0.3",
      quantityStepSize: "0.001",
      actualPlannedLoss: "1.5",
      unusedRiskBudget: "0",
      positionNotional: "30",
      targetIsolatedMargin: "3",
      maximumIsolatedMargin: "6",
      selectedLeverage: 10,
      estimatedInitialMargin: "3",
      liquidationBufferRatio: "2",
      ...overrides,
    },
  });
}

/** Everything about a row that a recovery path could possibly move. */
async function snapshot(executionId: string) {
  const row = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });
  return {
    status: row.status,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    requiresManualIntervention: row.requiresManualIntervention,
    decisionReasonCode: row.decisionReasonCode,
    sanitizedMessage: row.sanitizedMessage,
  };
}

/**
 * Lifecycle recorders.
 *
 * Every branch of the orchestrator's routing terminates in one of these, so an
 * execution id appearing here is an execution this process acted on.
 * `readOnly` throws because nothing in a correctly bound pass should reach it
 * from this file.
 */
function throwingExchange(): never {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`the read-only exchange service was reached: ${String(property)}`);
      },
    }
  ) as never;
}

/**
 * Counts how many times the exchange layer was reached.
 *
 * The services wrap their reads in an evidence helper that catches, so a
 * throwing stub proves a refusal but cannot prove an acceptance. Counting
 * property access proves both directions with the same instrument.
 */
function recordingExchange(): { service: never; reads: () => number } {
  let reads = 0;
  const service = new Proxy(
    {},
    {
      get() {
        reads += 1;
        return async () => {
          throw new Error("synthetic: no exchange in this suite");
        };
      },
    }
  ) as never;
  return { service, reads: () => reads };
}

function recorders() {
  const touched: string[] = [];
  const record = () => async (input: { executionId: string; expectedVersion?: number }) => {
    touched.push(input.executionId);
    return {
      mutationsDispatched: 0,
      execution: {
        id: input.executionId,
        status: "ENTRY_PENDING",
        version: input.expectedVersion ?? 1,
      },
    };
  };
  return {
    touched,
    entry: {
      prepareEntrySubmission: record(),
      resumeEntrySubmission: record(),
      reconcileEntryOrder: record(),
      expireEntryOrderIfDue: record(),
      releaseUnrunnablePreflight: record(),
    } as never,
    protection: {
      ensureProtectionForExposure: record(),
      resumeProtectionLifecycle: record(),
      reconcileProtectionAndClosure: record(),
      attemptProtectionRecovery: record(),
    } as never,
    readOnly: throwingExchange(),
  };
}

function orchestratorBoundTo(executionProfileId: string) {
  const parts = recorders();
  const orchestrator = new ExecutionOrchestrator({
    prisma: prisma!,
    readOnly: parts.readOnly,
    admission: {
      evaluateAndReserveSafetyAdmission: async (input: {
        executionId: string;
        expectedVersion: number;
      }) => {
        parts.touched.push(input.executionId);
        return {
          decision: "REFUSE",
          reasonCode: "SYNTHETIC",
          execution: { id: input.executionId, version: input.expectedVersion },
        };
      },
    } as never,
    entry: parts.entry,
    protection: parts.protection,
    executions: { recordReconciliationFailure: async () => undefined } as never,
    // Bound as production binds: the projection of the runtime whose
    // credentials would have built this orchestrator's clients.
    boundProfile: testProfileProjection({ executionProfileId }),
  });
  return { orchestrator, touched: parts.touched };
}

afterAll(async () => {
  if (!prisma || !available) return;
  await prisma.tradeExecution.deleteMany({
    where: { executionProfileId: { in: createdProfileIds } },
  });
  await prisma.executionSafetyPolicy.deleteMany({
    where: { executionProfileId: { in: createdProfileIds } },
  });
  await prisma.executionProfile.deleteMany({ where: { id: { in: createdProfileIds } } });
});

// ---------------------------------------------------------------------------
// Periodic reconciliation and startup recovery
// ---------------------------------------------------------------------------

describe("periodic reconciliation sees only the bound profile", () => {
  maybe()("reconciles A and never discovers an equally eligible B", async () => {
    const a = await makeProfile("recon-a");
    const b = await makeProfile("recon-b");
    const rowA = await makeExecution(a.id, "ENTRY_PENDING");
    const rowB = await makeExecution(b.id, "ENTRY_PENDING");
    const before = await snapshot(rowB.id);

    const { orchestrator, touched } = orchestratorBoundTo(a.id);
    const result = await orchestrator.runExecutionReconciliationTick({ batchSize: 50 });

    expect(touched).toContain(rowA.id);
    expect(touched).not.toContain(rowB.id);
    expect(result.rows.map((row) => row.executionId)).not.toContain(rowB.id);
    expect(await snapshot(rowB.id)).toEqual(before);
  });

  maybe()("reverses cleanly: bound to B, A is the one left alone", async () => {
    const a = await makeProfile("reverse-a");
    const b = await makeProfile("reverse-b");
    const rowA = await makeExecution(a.id, "ENTRY_PENDING");
    const rowB = await makeExecution(b.id, "ENTRY_PENDING");
    const before = await snapshot(rowA.id);

    const { orchestrator, touched } = orchestratorBoundTo(b.id);
    await orchestrator.runExecutionReconciliationTick({ batchSize: 50 });

    expect(touched).toContain(rowB.id);
    expect(touched).not.toContain(rowA.id);
    expect(await snapshot(rowA.id)).toEqual(before);
  });

  maybe()("a dangerous foreign row is never discovered, so no signed action is possible", async () => {
    // ENTRY_FILLED with manual intervention is the state that most wants a
    // signed response: exposure exists and protection is not proven. Under a
    // foreign profile it must be invisible, not merely skipped later.
    const a = await makeProfile("danger-a");
    const b = await makeProfile("danger-b");
    const dangerous = await makeExecution(b.id, "ENTRY_FILLED", {
      requiresManualIntervention: true,
    });
    const before = await snapshot(dangerous.id);

    const { orchestrator, touched } = orchestratorBoundTo(a.id);
    const result = await orchestrator.runExecutionReconciliationTick({ batchSize: 50 });

    expect(touched).toHaveLength(0);
    expect(result.inspected).toBe(0);
    expect(result.mutationsDispatched).toBe(0);
    expect(await snapshot(dangerous.id)).toEqual(before);
  });

  maybe()("counts describe the bound profile, not the table", async () => {
    const a = await makeProfile("counts-a");
    const b = await makeProfile("counts-b");
    await makeExecution(b.id, "MANUAL_INTERVENTION", { requiresManualIntervention: true });
    await makeExecution(b.id, "ENTRY_SUBMITTING");

    const { orchestrator } = orchestratorBoundTo(a.id);

    expect(await orchestrator.countRecoveryRequired(a.id)).toBe(0);
    expect(await orchestrator.countReconcilable(a.id)).toBe(0);
    // The same call, aimed at B, proves the rows really are there.
    expect(await orchestrator.countRecoveryRequired(b.id)).toBe(2);
  });

  maybe()("startup recovery reports zero while another profile has work it cannot do", async () => {
    const a = await makeProfile("startup-a");
    const b = await makeProfile("startup-b");
    const foreign = await makeExecution(b.id, "PLACING_PROTECTION");
    const before = await snapshot(foreign.id);

    const { orchestrator, touched } = orchestratorBoundTo(a.id);
    const result = await orchestrator.runStartupRecovery();

    expect(result.recoveryPending).toBe(0);
    expect(result.inspected).toBe(0);
    expect(result.failed).toBe(false);
    expect(touched).toHaveLength(0);
    expect(await snapshot(foreign.id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Shutdown drain
// ---------------------------------------------------------------------------

describe("shutdown drain cancels only the bound profile's pending entries", () => {
  const POSTURE: ShutdownPosture = {
    systemState: "SAFE_OFF",
    authorizationState: null,
    manualInterventionCount: 0,
    openPositionCount: 0,
  };

  maybe()("evaluate targets A's pending entry and not B's", async () => {
    const a = await makeProfile("drain-a");
    const b = await makeProfile("drain-b");
    const rowA = await makeExecution(a.id, "ENTRY_PENDING");
    const rowB = await makeExecution(b.id, "ENTRY_PENDING");

    const report = await new ShutdownDrainService(prisma!, a.id).evaluate(POSTURE);
    const targeted = report.verdict.drained.map((row) => row.executionId);

    expect(targeted).toContain(rowA.id);
    expect(targeted).not.toContain(rowB.id);
  });

  maybe()("draining A cancels nothing belonging to B", async () => {
    const a = await makeProfile("drain2-a");
    const b = await makeProfile("drain2-b");
    const rowA = await makeExecution(a.id, "ENTRY_PENDING");
    const rowB = await makeExecution(b.id, "ENTRY_PENDING");
    const before = await snapshot(rowB.id);

    const cancelled: string[] = [];
    const entry = {
      expireEntryOrderIfDue: async (input: { executionId: string }) => {
        cancelled.push(input.executionId);
        return {
          mutationsDispatched: 1,
          execution: { id: input.executionId, status: "FAILED", version: 2 },
        };
      },
    } as never;

    await new ShutdownDrainService(prisma!, a.id).drain(POSTURE, entry);

    expect(cancelled).toEqual([rowA.id]);
    expect(cancelled).not.toContain(rowB.id);
    expect(await snapshot(rowB.id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Operator recovery commands
// ---------------------------------------------------------------------------

describe("operator recovery refuses an execution from another profile", () => {
  maybe()("entry recovery: FOREIGN_PROFILE, no exchange read, no write", async () => {
    const a = await makeProfile("entryrec-a");
    const b = await makeProfile("entryrec-b");
    const foreign = await makeExecution(b.id, "ENTRY_SUBMITTING");
    const before = await snapshot(foreign.id);

    const probe = recordingExchange();
    const service = new EntryRecoveryService(prisma!, probe.service, testProfileProjection({ executionProfileId: a.id }));

    // Not returned by the candidate lookup at all, so not a candidate.
    expect(await service.evaluate(foreign.id)).toBeNull();

    const result = await service.recover(foreign.id);
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("FOREIGN_PROFILE");
    // THE proof the row was never selected: the refusal cannot report a status,
    // because the service never held the row to read one from -- and the
    // blocker is the QUERY's wording, not the secondary guard's. Remove the
    // predicate and the row is loaded, the secondary guard fires instead, and
    // this assertion fails.
    expect(result.status).toBeNull();
    expect(result.blockers).toEqual(["execution belongs to another execution profile"]);
    // Ids and states only; never the other account's alias.
    expect(result.message).not.toContain(b.accountIdentifier);
    expect(JSON.stringify(result)).not.toContain(b.accountIdentifier);
    // No exchange property was so much as read.
    expect(probe.reads()).toBe(0);
    expect(await snapshot(foreign.id)).toEqual(before);
  });

  maybe()("entry recovery still accepts its own profile's row", async () => {
    const a = await makeProfile("entryrec-own");
    const b = await makeProfile("entryrec-own-b");
    const own = await makeExecution(a.id, "ENTRY_SUBMITTING");
    const foreign = await makeExecution(b.id, "ENTRY_SUBMITTING");

    // The SAME service, the SAME status, the SAME instrument -- only the
    // owning profile differs, so the contrast isolates exactly one variable.
    const mine = recordingExchange();
    expect(await new EntryRecoveryService(prisma!, mine.service, testProfileProjection({ executionProfileId: a.id })).evaluate(own.id)).not.toBeNull();
    expect(mine.reads()).toBeGreaterThan(0);

    const theirs = recordingExchange();
    expect(await new EntryRecoveryService(prisma!, theirs.service, testProfileProjection({ executionProfileId: a.id })).evaluate(foreign.id)).toBeNull();
    expect(theirs.reads()).toBe(0);
  });

  maybe()("protection recovery: FOREIGN_PROFILE, no exchange read, no write", async () => {
    const a = await makeProfile("protrec-a");
    const b = await makeProfile("protrec-b");
    const foreign = await makeExecution(b.id, "ENTRY_FILLED", {
      requiresManualIntervention: true,
    });
    const before = await snapshot(foreign.id);

    const probe = recordingExchange();
    const service = new ProtectionRecoveryService(prisma!, probe.service, testProfileProjection({ executionProfileId: a.id }));

    expect(await service.evaluate(foreign.id)).toBeNull();

    const result = await service.recover(foreign.id, {} as never);
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("FOREIGN_PROFILE");
    // Never selected, so there is no status or protection state to report, and
    // the blocker is the QUERY's wording rather than the secondary guard's.
    expect(result.status).toBeNull();
    expect(result.protectionState).toBeNull();
    expect(result.blockers).toEqual(["execution belongs to another execution profile"]);
    expect(JSON.stringify(result)).not.toContain(b.accountIdentifier);
    expect(probe.reads()).toBe(0);
    expect(await snapshot(foreign.id)).toEqual(before);
  });

  maybe()("protection recovery still accepts its own profile's row", async () => {
    const a = await makeProfile("protrec-own");
    const b = await makeProfile("protrec-own-b");
    const own = await makeExecution(a.id, "ENTRY_FILLED");
    const foreign = await makeExecution(b.id, "ENTRY_FILLED");

    const mine = recordingExchange();
    expect(
      await new ProtectionRecoveryService(prisma!, mine.service, testProfileProjection({ executionProfileId: a.id })).evaluate(own.id)
    ).not.toBeNull();
    expect(mine.reads()).toBeGreaterThan(0);

    const theirs = recordingExchange();
    expect(
      await new ProtectionRecoveryService(prisma!, theirs.service, testProfileProjection({ executionProfileId: a.id })).evaluate(foreign.id)
    ).toBeNull();
    expect(theirs.reads()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe("a missing execution stays distinguishable from a foreign one", () => {
  maybe()("an id that exists nowhere reports NOT_APPLICABLE, not FOREIGN_PROFILE", async () => {
    const a = await makeProfile("absent-a");
    const probe = recordingExchange();

    const entry = await new EntryRecoveryService(prisma!, probe.service, testProfileProjection({ executionProfileId: a.id })).recover(
      "execution-that-does-not-exist"
    );
    expect(entry.outcome).toBe("NOT_APPLICABLE");

    const protection = await new ProtectionRecoveryService(prisma!, probe.service, testProfileProjection({ executionProfileId: a.id })).recover(
      "execution-that-does-not-exist",
      {} as never
    );
    expect(protection.outcome).toBe("NOT_APPLICABLE");
    expect(probe.reads()).toBe(0);
  });
});

describe("an unbindable process does no work at all", () => {
  maybe()("a profile that owns nothing discovers nothing, and touches nothing", async () => {
    // Phase 11D moved the unbindable case to the worker's startup barrier:
    // an orchestrator cannot exist without a bound projection, so the
    // closest thing an orchestrator can now be handed is a profile with no
    // rows. It must still reach nothing and change nothing.
    const b = await makeProfile("unbound-b");
    const foreign = await makeExecution(b.id, "ENTRY_PENDING");
    const before = await snapshot(foreign.id);

    const { orchestrator, touched } = orchestratorBoundTo(`${TAG}-owns-nothing`);
    const result = await orchestrator.runExecutionReconciliationTick({ batchSize: 50 });

    expect(result.failed).toBe(false);
    expect(result.inspected).toBe(0);
    expect(result.rows).toEqual([]);
    expect(touched).toHaveLength(0);
    expect(await snapshot(foreign.id)).toEqual(before);
  });

  maybe()("startup recovery for such a profile reports an honest zero", async () => {
    const { orchestrator, touched } = orchestratorBoundTo(`${TAG}-also-owns-nothing`);
    const result = await orchestrator.runStartupRecovery();

    expect(result.failed).toBe(false);
    expect(result.inspected).toBe(0);
    expect(result.recoveryPending).toBe(0);
    expect(touched).toHaveLength(0);
  });

  maybe()("a database holding only foreign recoverable rows reads as no work", async () => {
    const a = await makeProfile("empty-a");
    const b = await makeProfile("empty-b");
    await makeExecution(b.id, "MANUAL_INTERVENTION", { requiresManualIntervention: true });

    const { orchestrator, touched } = orchestratorBoundTo(a.id);
    const result = await orchestrator.runExecutionReconciliationTick({ batchSize: 50 });

    expect(result.inspected).toBe(0);
    expect(result.recoveryPending).toBe(0);
    expect(result.reconcilableTotal).toBe(0);
    expect(touched).toHaveLength(0);
  });
});

/**
 * The SECONDARY guard, exercised on its own.
 *
 * With the database predicate in place no real query can hand these services
 * a foreign row, so the only way to prove the ownership assertion is still
 * load-bearing is to defeat the query and hand one over anyway.
 */
/**
 * Phase 11D — the bound context is the ONLY authority on environment.
 *
 * `gather` used to re-read the execution's ExecutionProfile row to discover
 * which environment to judge the connector against. That was a second source
 * of truth: a row edited after this process bound its runtime could move the
 * judgement to another account's environment while the credentials stayed the
 * same. The bound projection now answers, and the row is never consulted.
 */
describe("protection recovery judges the environment it was BOUND to", () => {
  const EXECUTION = {
    id: "env-authority-execution",
    symbol: "BTCUSDT",
    direction: "LONG",
    positionSide: "LONG",
    status: "ENTRY_FILLED",
    version: 1,
    executionProfileId: "the-bound-profile",
    requiresManualIntervention: true,
    filledQuantity: null,
    // Decimals the evidence gather reads; only their string form matters here.
    executableStopLoss: { toString: () => "95" },
    plannedQuantity: { toString: () => "0.3" },
  };

  /**
   * A prisma whose profile row CONTRADICTS the bound context, and which
   * records whether anything asked it.
   */
  function contradictingPrisma(asked: string[]) {
    return {
      tradeExecution: {
        findFirst: async () => EXECUTION,
        count: async () => 1,
      },
      executionProtectionState: { findUnique: async () => null },
      binanceOrder: { findMany: async () => [] },
      executionProfile: {
        findUnique: async () => {
          asked.push("executionProfile.findUnique");
          return { environment: "MAINNET" };
        },
      },
    } as never;
  }

  it("never asks the profile row, even when one would answer differently", async () => {
    const asked: string[] = [];
    const probe = recordingExchange();
    const service = new ProtectionRecoveryService(
      contradictingPrisma(asked),
      probe.service,
      testProfileProjection({
        executionProfileId: "the-bound-profile",
        // The BOUND environment. The row above claims MAINNET.
        environment: "TESTNET",
      })
    );

    const evaluated = await service.evaluate(EXECUTION.id);
    expect(evaluated).not.toBeNull();
    // THE assertion: the contradicting row was never consulted at all.
    expect(asked).toEqual([]);
  });

  it("judges the connector against the bound environment, not the row", async () => {
    const probe = recordingExchange();

    const boundToTestnet = new ProtectionRecoveryService(
      contradictingPrisma([]),
      probe.service,
      testProfileProjection({ executionProfileId: "the-bound-profile", environment: "TESTNET" })
    );
    const boundToMainnet = new ProtectionRecoveryService(
      contradictingPrisma([]),
      probe.service,
      testProfileProjection({ executionProfileId: "the-bound-profile", environment: "MAINNET" })
    );

    const asTestnet = await boundToTestnet.evaluate(EXECUTION.id);
    const asMainnet = await boundToMainnet.evaluate(EXECUTION.id);

    // Same row, same contradicting profile, same connector -- and a DIFFERENT
    // verdict, which is only possible if the bound context is what decided.
    expect(asTestnet?.evidence.environmentMatches).not.toEqual(
      asMainnet?.evidence.environmentMatches
    );
  });
});

describe("a row smuggled past the query predicate is still refused", () => {
  const FOREIGN_ROW = {
    id: "smuggled-execution",
    symbol: "BTCUSDT",
    direction: "LONG",
    positionSide: "LONG",
    status: "ENTRY_SUBMITTING",
    version: 1,
    executionProfileId: "a-completely-different-profile",
    requiresManualIntervention: false,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
  };

  /** A prisma that ignores the `where` and returns the foreign row regardless. */
  function leakyPrisma() {
    return {
      tradeExecution: {
        findFirst: async () => FOREIGN_ROW,
        count: async () => 1,
      },
    } as never;
  }

  it("entry recovery refuses it and reaches no exchange", async () => {
    const probe = recordingExchange();
    const service = new EntryRecoveryService(leakyPrisma(), probe.service, testProfileProjection({ executionProfileId: "the-bound-profile" }));

    expect(await service.evaluate(FOREIGN_ROW.id)).toBeNull();

    const result = await service.recover(FOREIGN_ROW.id);
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("FOREIGN_PROFILE");
    // The SECONDARY guard's wording: this row was loaded and then refused.
    expect(result.blockers).toEqual([
      "execution belongs to another execution profile (it bypassed the scoped query)",
    ]);
    expect(probe.reads()).toBe(0);
  });

  it("protection recovery refuses it and reaches no exchange", async () => {
    const probe = recordingExchange();
    const service = new ProtectionRecoveryService(
      leakyPrisma(),
      probe.service,
      "the-bound-profile"
    );

    expect(await service.evaluate(FOREIGN_ROW.id)).toBeNull();

    const result = await service.recover(FOREIGN_ROW.id, {} as never);
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("FOREIGN_PROFILE");
    expect(result.blockers).toEqual([
      "execution belongs to another execution profile (it bypassed the scoped query)",
    ]);
    expect(probe.reads()).toBe(0);
  });
});

describe("the row identity assertion refuses what discovery cannot produce", () => {
  it("a foreign row reaching the loop is refused, not reconciled", async () => {
    // Discovery cannot return this row. Handing it to the loop anyway is the
    // only way to exercise the defence in depth, and proves the assertion is
    // load-bearing rather than decorative.
    const touched: string[] = [];
    const orchestrator = new ExecutionOrchestrator({
      prisma: {
        tradeExecution: {
          findMany: async () => [
            {
              id: "smuggled",
              symbol: "BTCUSDT",
              status: "ENTRY_PENDING",
              version: 1,
              executionProfileId: "some-other-profile",
              requiresManualIntervention: false,
            },
          ],
          count: async () => 0,
        },
        executionProfile: {
          findMany: async () => [
            {
              id: "profile-bound",
              accountIdentifier: "alias",
              environment: "TESTNET",
              safetyPolicy: { id: "policy-1" },
            },
          ],
        },
      } as never,
      readOnly: {} as never,
      admission: {} as never,
      entry: {
        reconcileEntryOrder: async (input: { executionId: string }) => {
          touched.push(input.executionId);
          return { mutationsDispatched: 0 };
        },
        expireEntryOrderIfDue: async (input: { executionId: string }) => {
          touched.push(input.executionId);
          return { mutationsDispatched: 0 };
        },
      } as never,
      protection: {} as never,
      executions: { recordReconciliationFailure: async () => undefined } as never,
      boundProfile: testProfileProjection({ executionProfileId: "profile-bound" }),
    });

    const result = await orchestrator.runExecutionReconciliationTick({ batchSize: 10 });

    expect(touched).toHaveLength(0);
    expect(result.inspected).toBe(0);
    expect(result.failed).toBe(true);
    expect(result.rows.map((row) => row.reasonCode)).toEqual(["PROFILE_MISMATCH"]);
  });
});
