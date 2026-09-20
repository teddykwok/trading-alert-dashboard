import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * Phase 11E — one durable verdict per (plan, profile), against REAL Postgres.
 *
 * Everything this file proves is a property of stored rows, a unique index and
 * a conditional update, so none of it can be proven against a mock: an
 * in-memory map would only prove the bookkeeping I wrote, not the arbitration
 * the database performs. The unique index IS the winner-selection mechanism,
 * and `updateMany(... attempts)` IS the fence.
 *
 * The executor is a stub on purpose, and it is the ONLY stub here. It stands in
 * for the signed margin-plan reads and the admission path, because the subject
 * under test is which account gets to run those and how often — not what they
 * return. Its call COUNT is therefore an assertion in its own right: "the claim
 * precedes the expensive work" is only true if a worker that loses the claim
 * never calls it.
 *
 * Nothing here imports a Binance client, and no exchange request is made.
 */

const TAG = "adoption-11e";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { SelectedPlanAdoptionService, ADOPTION_CLAIM_LEASE_MS } = await import(
  "../src/modules/jobs/selected-plan-adoption.service"
);
const { ExtremeRRService } = await import("../src/modules/extreme-rr/extreme-rr.service");
const { env } = await import("../src/config/env");

type AdoptionService = InstanceType<typeof SelectedPlanAdoptionService>;
type Outcome = Awaited<ReturnType<AdoptionService["runOnce"]>>;

const maybe = () => (available ? it : it.skip);

/** Fixed reference instant, so no test depends on how long it takes to run. */
const ago = (ms: number) => new Date(Date.now() - ms);

/** Comfortably inside EXECUTION_MAX_ALERT_AGE_SECONDS. */
const FRESH_MS = 30_000;
/** Comfortably outside it, whatever the configured limit is. */
const EXPIRED_MS = (env.EXECUTION_MAX_ALERT_AGE_SECONDS + 600) * 1000;

let sequence = 0;

async function profile(alias: string): Promise<string> {
  sequence += 1;
  const row = await prisma!.executionProfile.create({
    data: {
      name: `${TAG} ${alias} ${sequence}`,
      accountIdentifier: `${TAG}-${alias}-${sequence}`,
      environment: "TESTNET",
      isEnabled: false,
    },
  });
  return row.id;
}

function boundProfileOf(executionProfileId: string) {
  return {
    executionProfileId,
    exchange: "BINANCE",
    product: "USDM_FUTURES",
    environment: "TESTNET" as const,
  };
}

interface PlanFixture {
  planId: string;
  alertId: string;
  symbol: string;
}

/**
 * One alert and its plan.
 *
 * `cutoffAt` is written explicitly because it is the freshness fence's input:
 * the production writer sets it to `alert.triggeredAt`, so a test that wants an
 * "old signal" places the row in the past rather than waiting for one.
 */
async function planFor(
  options: {
    agoMs?: number;
    status?: "READY" | "PENDING" | "INVALID";
    /**
     * Phase 11E rollout marker. Defaults to SET, because that is what the
     * 11E generic pipeline writes; pass false for a plan that reached READY
     * under the pre-11E worker, which is the replay case.
     */
    fanoutReady?: boolean;
  } = {}
): Promise<PlanFixture> {
  sequence += 1;
  const symbol = `ADOPT${sequence}USDT`;
  const triggeredAt = ago(options.agoMs ?? FRESH_MS);

  const alert = await prisma!.alert.create({
    data: {
      symbol,
      assetType: "CRYPTO",
      exchange: "SYNTHETIC",
      timeframe: "15m",
      price: 100,
      signal: "LONG",
      indicatorName: `${TAG}-${sequence}`,
      rawPayload: { note: TAG },
      triggeredAt,
    },
  });

  const plan = await prisma!.extremeRRPlan.create({
    data: {
      alertId: alert.id,
      status: options.status ?? "READY",
      direction: "LONG",
      entryPrice: "100",
      cutoffAt: triggeredAt,
      timeframe: "15m",
      selectedLookback: 300,
      generatedAt: triggeredAt,
      executionFanoutReadyAt: options.fanoutReady === false ? null : triggeredAt,
    },
  });

  return { planId: plan.id, alertId: alert.id, symbol };
}

type StubOutcome =
  | { handled: true; executionId: string; created: boolean; admitted: boolean; reasonCode: string | null }
  | { handled: false; reasonCode: string; message: string };

interface Executor {
  handleSelectedPlan: ReturnType<typeof vi.fn>;
  calls: () => number;
}

/** An executor that answers immediately and counts how often it was asked. */
function executorReturning(outcome: StubOutcome | ((symbol: string) => StubOutcome)): Executor {
  const fn = vi.fn(async (_plan: unknown, symbol: string) =>
    typeof outcome === "function" ? outcome(symbol) : outcome
  );
  return { handleSelectedPlan: fn, calls: () => fn.mock.calls.length };
}

/** An executor held open at the point the signed margin-plan reads happen. */
function gatedExecutor(reasonCode: string): { executor: Executor; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fn = vi.fn(async () => {
    await gate;
    return { handled: false, reasonCode, message: reasonCode };
  });
  return { executor: { handleSelectedPlan: fn, calls: () => fn.mock.calls.length }, release };
}

const REFUSED: StubOutcome = {
  handled: false,
  reasonCode: "MARGIN_PLAN_NOT_READY",
  message: "synthetic refusal",
};

function serviceFor(executionProfileId: string, executor: Executor, workerId: string): AdoptionService {
  return new SelectedPlanAdoptionService({
    prisma: prisma!,
    boundProfile: boundProfileOf(executionProfileId),
    executor: executor as never,
    plans: new ExtremeRRService(prisma!),
    workerId,
  });
}

function adoptionsOf(planId: string) {
  return prisma!.selectedPlanAdoption.findMany({
    where: { extremeRRPlanId: planId },
    orderBy: { createdAt: "asc" },
  });
}

/** Ages a claim so the lease reads as expired, without waiting two minutes. */
async function expireClaim(adoptionId: string): Promise<void> {
  await prisma!.selectedPlanAdoption.update({
    where: { id: adoptionId },
    data: { claimedAt: ago(ADOPTION_CLAIM_LEASE_MS * 2) },
  });
}

async function cleanup(): Promise<void> {
  if (!available) return;
  // Explicit and ordered rather than leaning on the cascade. The profile
  // relation is Restrict, so an adoption row that outlives its own removal
  // path would fail teardown with a foreign-key error and hide whichever
  // assertion actually failed.
  await prisma!.selectedPlanAdoption.deleteMany({
    where: { executionProfile: { accountIdentifier: { startsWith: TAG } } },
  });
  await prisma!.alert.deleteMany({ where: { indicatorName: { startsWith: TAG } } });
  await prisma!.executionProfile.deleteMany({ where: { accountIdentifier: { startsWith: TAG } } });
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma?.$disconnect();
});

describe("selected plan adoption — per-profile durability", () => {
  maybe()("records a refusal as COMPLETED and never offers the plan again", async () => {
    const profileId = await profile("refusal");
    const plan = await planFor();
    const executor = executorReturning(REFUSED);
    const service = serviceFor(profileId, executor, "worker-refusal");

    const first: Outcome = await service.runOnce();
    expect(first).toMatchObject({ discovered: 1, claimed: 1, completed: 1 });

    const [row] = await adoptionsOf(plan.planId);
    expect(row.status).toBe("COMPLETED");
    expect(row.handled).toBe(false);
    expect(row.reasonCode).toBe("MARGIN_PLAN_NOT_READY");
    expect(row.executionId).toBeNull();
    // The lease is released on a terminal row: it is finished, not held.
    expect(row.claimedAt).toBeNull();
    expect(row.claimOwner).toBeNull();

    // THE point of the whole table: a refusal is evaluated once per profile.
    // Under the old queue a refusal returned rather than threw, so BullMQ's
    // `attempts: 2` never applied; this preserves that exactly.
    const second: Outcome = await service.runOnce();
    expect(second.discovered).toBe(0);
    expect(executor.calls()).toBe(1);
  });

  maybe()("records a handled outcome with its execution id", async () => {
    const profileId = await profile("handled");
    const plan = await planFor();
    const executor = executorReturning({
      handled: true,
      executionId: "exec-synthetic-1",
      created: true,
      admitted: false,
      reasonCode: null,
    });
    const service = serviceFor(profileId, executor, "worker-handled");

    await service.runOnce();

    const [row] = await adoptionsOf(plan.planId);
    expect(row.status).toBe("COMPLETED");
    expect(row.handled).toBe(true);
    expect(row.executionId).toBe("exec-synthetic-1");
    expect(row.message).toBeNull();
    expect(row.evaluatedAt).not.toBeNull();
    expect(row.completedAt).not.toBeNull();
  });
});

describe("selected plan adoption — two accounts", () => {
  maybe()("lets each profile adopt the same plan independently", async () => {
    const profileA = await profile("A");
    const profileB = await profile("B");
    const plan = await planFor();

    const executorA = executorReturning(REFUSED);
    const executorB = executorReturning(REFUSED);

    await serviceFor(profileA, executorA, "worker-A").runOnce();
    // B must still see the plan: A's verdict is A's, and the discovery
    // predicate names the profile on BOTH halves.
    const summaryB: Outcome = await serviceFor(profileB, executorB, "worker-B").runOnce();

    expect(summaryB).toMatchObject({ discovered: 1, claimed: 1, completed: 1 });

    const rows = await adoptionsOf(plan.planId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.executionProfileId))).toEqual(new Set([profileA, profileB]));
    expect(executorA.calls()).toBe(1);
    expect(executorB.calls()).toBe(1);
  });

  maybe()("allows the two accounts to reach DIFFERENT verdicts", async () => {
    const profileA = await profile("A");
    const profileB = await profile("B");
    const plan = await planFor();

    await serviceFor(
      profileA,
      executorReturning({
        handled: true,
        executionId: "exec-A",
        created: true,
        admitted: true,
        reasonCode: null,
      }),
      "worker-A"
    ).runOnce();

    await serviceFor(
      profileB,
      executorReturning({ handled: false, reasonCode: "PROFILE_UNAVAILABLE", message: "B declines" }),
      "worker-B"
    ).runOnce();

    const rows = await adoptionsOf(plan.planId);
    const byProfile = new Map(rows.map((row) => [row.executionProfileId, row]));

    expect(byProfile.get(profileA)!.handled).toBe(true);
    expect(byProfile.get(profileA)!.executionId).toBe("exec-A");
    expect(byProfile.get(profileB)!.handled).toBe(false);
    expect(byProfile.get(profileB)!.reasonCode).toBe("PROFILE_UNAVAILABLE");
  });

  maybe()("is not dragged back by the OTHER profile's abandoned claim", async () => {
    // The reclaim half of discovery has to name this profile too, not just
    // the never-offered half. A stale PENDING row belonging to account B is
    // B's problem: if it could pull a plan back into A's pass, a plan A had
    // already finished would be rediscovered on every tick for as long as B
    // stayed down -- a permanent poll that the unique index would then bounce
    // with a constraint violation each time, silently.
    const profileA = await profile("A");
    const profileB = await profile("B");
    const plan = await planFor();

    const executorA = executorReturning(REFUSED);
    await serviceFor(profileA, executorA, "worker-A").runOnce();

    // B claims it and then goes away.
    await prisma!.selectedPlanAdoption.create({
      data: {
        extremeRRPlanId: plan.planId,
        executionProfileId: profileB,
        status: "PENDING",
        attempts: 1,
        claimedAt: ago(ADOPTION_CLAIM_LEASE_MS * 2),
        claimOwner: "worker-B-that-died",
      },
    });

    const again: Outcome = await serviceFor(profileA, executorA, "worker-A").runOnce();
    expect(again.discovered).toBe(0);
    // A's verdict is untouched, and A spent nothing a second time.
    expect(executorA.calls()).toBe(1);

    // And B's own worker still gets it back, which is the point of the lease.
    const recovered: Outcome = await serviceFor(
      profileB,
      executorReturning(REFUSED),
      "worker-B-replacement"
    ).runOnce();
    expect(recovered).toMatchObject({ discovered: 1, claimed: 1, completed: 1 });
  });

  maybe()("leaves the generic fanout marker untouched when one account finishes", async () => {
    // The marker is a fact about the PLAN, not a token an account spends.
    // If account A's adoption cleared it, B would be locked out of every
    // plan A happened to reach first -- silently, and permanently.
    const profileA = await profile("A");
    const profileB = await profile("B");
    const plan = await planFor({ fanoutReady: true });

    const before = await prisma!.extremeRRPlan.findUniqueOrThrow({ where: { id: plan.planId } });
    await serviceFor(profileA, executorReturning(REFUSED), "worker-A").runOnce();
    const after = await prisma!.extremeRRPlan.findUniqueOrThrow({ where: { id: plan.planId } });

    expect(after.executionFanoutReadyAt).not.toBeNull();
    expect(after.executionFanoutReadyAt?.toISOString()).toBe(
      before.executionFanoutReadyAt?.toISOString()
    );

    const forB: Outcome = await serviceFor(
      profileB,
      executorReturning(REFUSED),
      "worker-B"
    ).runOnce();
    expect(forB).toMatchObject({ discovered: 1, claimed: 1, completed: 1 });
  });

  maybe()("does not let one profile's COMPLETED row hide the plan from the other", async () => {
    const profileA = await profile("A");
    const profileB = await profile("B");
    await planFor();

    await serviceFor(profileA, executorReturning(REFUSED), "worker-A").runOnce();

    const rediscovered: Outcome = await serviceFor(profileB, executorReturning(REFUSED), "worker-B").runOnce();
    expect(rediscovered.discovered).toBe(1);
  });
});

describe("selected plan adoption — the claim", () => {
  maybe()("hides a plan from the same profile while a fresh claim is held", async () => {
    const profileId = await profile("lease");
    const plan = await planFor();

    // A claim taken moments ago by another worker for the same profile.
    await prisma!.selectedPlanAdoption.create({
      data: {
        extremeRRPlanId: plan.planId,
        executionProfileId: profileId,
        status: "PENDING",
        attempts: 1,
        claimedAt: new Date(),
        claimOwner: "worker-elsewhere",
      },
    });

    const executor = executorReturning(REFUSED);
    const summary: Outcome = await serviceFor(profileId, executor, "worker-late").runOnce();

    expect(summary.discovered).toBe(0);
    // The whole reason the claim exists: no signed read is attempted.
    expect(executor.calls()).toBe(0);
  });

  maybe()("reclaims a plan whose lease expired, incrementing the fencing token", async () => {
    const profileId = await profile("stale");
    const plan = await planFor();

    const abandoned = await prisma!.selectedPlanAdoption.create({
      data: {
        extremeRRPlanId: plan.planId,
        executionProfileId: profileId,
        status: "PENDING",
        attempts: 1,
        claimedAt: ago(ADOPTION_CLAIM_LEASE_MS * 2),
        claimOwner: "worker-that-died",
      },
    });

    const executor = executorReturning(REFUSED);
    const summary: Outcome = await serviceFor(profileId, executor, "worker-reclaimer").runOnce();

    expect(summary).toMatchObject({ discovered: 1, claimed: 1, completed: 1 });

    const row = await prisma!.selectedPlanAdoption.findUniqueOrThrow({ where: { id: abandoned.id } });
    expect(row.status).toBe("COMPLETED");
    expect(row.attempts).toBe(2);
    expect(executor.calls()).toBe(1);
  });

  maybe()("refuses a stalled owner's verdict after a reclaimer has finished", async () => {
    const profileId = await profile("fence");
    const plan = await planFor();

    // The stalled worker: it claims, then blocks inside the executor exactly
    // where the signed margin-plan reads would be.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stalledExecutor: Executor = (() => {
      const fn = vi.fn(async () => {
        await gate;
        return { handled: false, reasonCode: "CANDIDATE_INCOMPLETE", message: "stalled owner" };
      });
      return { handleSelectedPlan: fn, calls: () => fn.mock.calls.length };
    })();

    const stalled = serviceFor(profileId, stalledExecutor, "worker-stalled").runOnce();

    // Let the claim land, then age it so the reclaimer is entitled to it.
    await vi.waitFor(async () => {
      const rows = await adoptionsOf(plan.planId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("PENDING");
    });
    const [claimed] = await adoptionsOf(plan.planId);
    await expireClaim(claimed.id);

    await serviceFor(
      profileId,
      executorReturning({ handled: false, reasonCode: "PROFILE_UNAVAILABLE", message: "reclaimer" }),
      "worker-reclaimer"
    ).runOnce();

    release();
    const stalledSummary: Outcome = await stalled;

    // It claimed and evaluated, but its terminal write was fenced out.
    expect(stalledSummary.claimed).toBe(1);
    expect(stalledSummary.completed).toBe(0);
    expect(stalledSummary.skipped).toBe(1);

    const row = await prisma!.selectedPlanAdoption.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(row.status).toBe("COMPLETED");
    expect(row.attempts).toBe(2);
    // The RECLAIMER's verdict stands. The stalled owner overwrote nothing.
    expect(row.reasonCode).toBe("PROFILE_UNAVAILABLE");
  });

  maybe()("refuses the previous owner even while the row is still PENDING", async () => {
    // The stalled-owner test below proves the pair of guards together. This
    // one isolates the FENCING TOKEN: the reclaimer has taken the row but
    // has not finished, so the row is still PENDING and the status check
    // cannot save anything. Only `attempts` can, and it has to.
    const profileId = await profile("token");
    const plan = await planFor();

    const stalled = gatedExecutor("CANDIDATE_INCOMPLETE");
    const reclaimer = gatedExecutor("PROFILE_UNAVAILABLE");

    const stalledPass = serviceFor(profileId, stalled.executor, "worker-stalled").runOnce();
    await vi.waitFor(async () => {
      const [row] = await adoptionsOf(plan.planId);
      expect(row?.attempts).toBe(1);
    });
    const [claimed] = await adoptionsOf(plan.planId);
    await expireClaim(claimed.id);

    const reclaimPass = serviceFor(profileId, reclaimer.executor, "worker-reclaimer").runOnce();
    await vi.waitFor(async () => {
      const row = await prisma!.selectedPlanAdoption.findUniqueOrThrow({ where: { id: claimed.id } });
      expect(row.attempts).toBe(2);
    });

    // The stalled owner finishes FIRST, against a row that is still PENDING.
    stalled.release();
    const stalledSummary: Outcome = await stalledPass;
    expect(stalledSummary).toMatchObject({ claimed: 1, completed: 0, skipped: 1 });

    const midway = await prisma!.selectedPlanAdoption.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(midway.status).toBe("PENDING");
    expect(midway.reasonCode).toBeNull();

    reclaimer.release();
    const reclaimSummary: Outcome = await reclaimPass;
    expect(reclaimSummary).toMatchObject({ claimed: 1, completed: 1 });

    const final = await prisma!.selectedPlanAdoption.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(final.status).toBe("COMPLETED");
    expect(final.reasonCode).toBe("PROFILE_UNAVAILABLE");
  });

  maybe()("gives an expired lease to exactly one of two reclaimers", async () => {
    // Both see the same stale row and the same attempts value. If the
    // reclaim did not re-assert that value, both would win and both would
    // spend signed request weight on one plan -- the waste the claim exists
    // to prevent, and the one thing the terminal fence cannot undo.
    const profileId = await profile("two-reclaimers");
    const plan = await planFor();

    const abandoned = await prisma!.selectedPlanAdoption.create({
      data: {
        extremeRRPlanId: plan.planId,
        executionProfileId: profileId,
        status: "PENDING",
        attempts: 1,
        claimedAt: ago(ADOPTION_CLAIM_LEASE_MS * 2),
        claimOwner: "worker-that-died",
      },
    });

    const first = executorReturning(REFUSED);
    const second = executorReturning(REFUSED);
    const [a, b]: Outcome[] = await Promise.all([
      serviceFor(profileId, first, "reclaimer-1").runOnce(),
      serviceFor(profileId, second, "reclaimer-2").runOnce(),
    ]);

    expect(a.claimed + b.claimed).toBe(1);
    expect(first.calls() + second.calls()).toBe(1);

    const row = await prisma!.selectedPlanAdoption.findUniqueOrThrow({ where: { id: abandoned.id } });
    expect(row.status).toBe("COMPLETED");
    expect(row.attempts).toBe(2);
  });

  maybe()("gives one plan to exactly one of two concurrent passes for the same profile", async () => {
    const profileId = await profile("race");
    const plan = await planFor();

    const first = executorReturning(REFUSED);
    const second = executorReturning(REFUSED);

    const [a, b]: Outcome[] = await Promise.all([
      serviceFor(profileId, first, "worker-1").runOnce(),
      serviceFor(profileId, second, "worker-2").runOnce(),
    ]);

    // One row, decided by the unique index rather than by timing.
    const rows = await adoptionsOf(plan.planId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("COMPLETED");

    expect(a.claimed + b.claimed).toBe(1);
    // And the loser spent NOTHING: the claim is the fence, not the execution row.
    expect(first.calls() + second.calls()).toBe(1);
  });

  maybe()("converges on ONE execution when a crash follows creation", async () => {
    // The crash this recovers: the claim is held, the executor has already
    // created the TradeExecution, and the process dies before the terminal
    // write. The row stays PENDING and its lease returns the plan.
    //
    // What makes the retry safe is NOT this table. It is that the executor
    // adopts the existing row on P2002 rather than creating a second, and
    // that admitAndSubmit refuses anything that has left PLAN_READY -- both
    // proved in selected-plan-execution.test.ts and
    // execution-orchestration.test.ts. What adoption must add is that the
    // retry converges on the SAME execution and records it exactly once.
    const profileId = await profile("crash-after-create");
    const plan = await planFor();

    let call = 0;
    const executor: Executor = (() => {
      const fn = vi.fn(async () => {
        call += 1;
        if (call === 1) {
          // Created, then the process died before the verdict was written.
          throw new Error("synthetic crash after execution creation");
        }
        // The retry re-enters the executor, which adopts the row it finds.
        return {
          handled: true,
          executionId: "exec-adopted",
          created: false,
          admitted: false,
          reasonCode: "NOT_PLAN_READY",
        };
      });
      return { handleSelectedPlan: fn, calls: () => fn.mock.calls.length };
    })();

    await serviceFor(profileId, executor, "worker-crashed").runOnce();
    const [pending] = await adoptionsOf(plan.planId);
    expect(pending.status).toBe("PENDING");
    expect(pending.executionId).toBeNull();

    await expireClaim(pending.id);
    const recovered: Outcome = await serviceFor(profileId, executor, "worker-resumed").runOnce();
    expect(recovered).toMatchObject({ claimed: 1, completed: 1 });

    // ONE row, ONE execution id, and the attempt count says it took two
    // passes rather than pretending it took one.
    const rows = await adoptionsOf(plan.planId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("COMPLETED");
    expect(rows[0].executionId).toBe("exec-adopted");
    expect(rows[0].attempts).toBe(2);
    expect(executor.calls()).toBe(2);
  });

  maybe()("converges on ONE execution when a crash follows creation", async () => {
    // The crash this recovers: the claim is held, the executor has already
    // created the TradeExecution, and the process dies before the terminal
    // write. The row stays PENDING and its lease returns the plan.
    //
    // What makes the retry safe is NOT this table. It is that the executor
    // adopts the existing row on P2002 rather than creating a second, and
    // that admitAndSubmit refuses anything that has left PLAN_READY -- both
    // proved in selected-plan-execution.test.ts and
    // execution-orchestration.test.ts. What adoption must add is that the
    // retry converges on the SAME execution and records it exactly once.
    const profileId = await profile("crash-after-create");
    const plan = await planFor();

    let call = 0;
    const executor: Executor = (() => {
      const fn = vi.fn(async () => {
        call += 1;
        if (call === 1) {
          // Created, then the process died before the verdict was written.
          throw new Error("synthetic crash after execution creation");
        }
        // The retry re-enters the executor, which adopts the row it finds.
        return {
          handled: true,
          executionId: "exec-adopted",
          created: false,
          admitted: false,
          reasonCode: "NOT_PLAN_READY",
        };
      });
      return { handleSelectedPlan: fn, calls: () => fn.mock.calls.length };
    })();

    await serviceFor(profileId, executor, "worker-crashed").runOnce();
    const [pending] = await adoptionsOf(plan.planId);
    expect(pending.status).toBe("PENDING");
    expect(pending.executionId).toBeNull();

    await expireClaim(pending.id);
    const recovered: Outcome = await serviceFor(profileId, executor, "worker-resumed").runOnce();
    expect(recovered).toMatchObject({ claimed: 1, completed: 1 });

    // ONE row, ONE execution id, and the attempt count says it took two
    // passes rather than pretending it took one.
    const rows = await adoptionsOf(plan.planId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("COMPLETED");
    expect(rows[0].executionId).toBe("exec-adopted");
    expect(rows[0].attempts).toBe(2);
    expect(executor.calls()).toBe(2);
  });

  maybe()("leaves the row claimable when evaluation throws", async () => {
    const profileId = await profile("throw");
    const plan = await planFor();

    const throwing: Executor = (() => {
      const fn = vi.fn(async () => {
        throw new Error("synthetic evaluation failure");
      });
      return { handleSelectedPlan: fn, calls: () => fn.mock.calls.length };
    })();

    const summary: Outcome = await serviceFor(profileId, throwing, "worker-crash").runOnce();
    expect(summary).toMatchObject({ claimed: 1, completed: 0 });

    const [pending] = await adoptionsOf(plan.planId);
    expect(pending.status).toBe("PENDING");
    expect(pending.attempts).toBe(1);

    // Held, not lost: the lease is what returns it, and only once it expires.
    const tooSoon: Outcome = await serviceFor(profileId, executorReturning(REFUSED), "worker-next").runOnce();
    expect(tooSoon.discovered).toBe(0);

    await expireClaim(pending.id);
    const recovered: Outcome = await serviceFor(profileId, executorReturning(REFUSED), "worker-next").runOnce();
    expect(recovered).toMatchObject({ discovered: 1, claimed: 1, completed: 1 });

    const [finished] = await adoptionsOf(plan.planId);
    expect(finished.status).toBe("COMPLETED");
    expect(finished.attempts).toBe(2);
  });
});

describe("selected plan adoption — what is eligible at all", () => {
  maybe()("never adopts a plan older than the signal-lifetime limit", async () => {
    const profileId = await profile("expired");
    await planFor({ agoMs: EXPIRED_MS });

    const executor = executorReturning(REFUSED);
    const summary: Outcome = await serviceFor(profileId, executor, "worker-expired").runOnce();

    // This is the historical-replay fence. Every plan that existed before this
    // worker was introduced is older than the limit, so a first start adopts
    // nothing at all.
    expect(summary.discovered).toBe(0);
    expect(executor.calls()).toBe(0);
  });

  maybe()("adopts a plan inside the signal-lifetime window", async () => {
    const profileId = await profile("fresh");
    await planFor({ agoMs: FRESH_MS });

    const summary: Outcome = await serviceFor(profileId, executorReturning(REFUSED), "worker-fresh").runOnce();
    expect(summary.discovered).toBe(1);
  });

  maybe()("never adopts a fresh READY plan that predates the 11E rollout", async () => {
    // THE case signal lifetime cannot catch. The pre-11E worker evaluated
    // this plan and refused it: no TradeExecution, no adoption row, and the
    // cutoff is still well inside the signal lifetime. Nothing but the
    // rollout marker distinguishes it from new work, and evaluating it again
    // would re-spend signed account reads and could decide differently.
    const profileId = await profile("pre-rollout");
    await planFor({ agoMs: FRESH_MS, fanoutReady: false });

    const executor = executorReturning(REFUSED);
    const summary: Outcome = await serviceFor(profileId, executor, "worker-rollout").runOnce();

    expect(summary.discovered).toBe(0);
    expect(executor.calls()).toBe(0);
  });

  maybe()("adopts a READY plan generated after the rollout", async () => {
    const profileId = await profile("post-rollout");
    await planFor({ agoMs: FRESH_MS, fanoutReady: true });

    const summary: Outcome = await serviceFor(
      profileId,
      executorReturning(REFUSED),
      "worker-rollout"
    ).runOnce();
    expect(summary).toMatchObject({ discovered: 1, claimed: 1, completed: 1 });
  });

  maybe()("still refuses a marked plan that is outside the signal lifetime", async () => {
    // The two fences are independent: the rollout marker says which
    // architecture produced the plan, the lifetime says whether the signal
    // is still worth trading. Passing one does not excuse the other.
    const profileId = await profile("marked-but-old");
    await planFor({ agoMs: EXPIRED_MS, fanoutReady: true });

    const executor = executorReturning(REFUSED);
    const summary: Outcome = await serviceFor(profileId, executor, "worker-old").runOnce();
    expect(summary.discovered).toBe(0);
    expect(executor.calls()).toBe(0);
  });

  maybe()("never adopts a plan that is not READY", async () => {
    const profileId = await profile("pending-plan");
    await planFor({ status: "PENDING" });

    const executor = executorReturning(REFUSED);
    const summary: Outcome = await serviceFor(profileId, executor, "worker-nonready").runOnce();

    expect(summary.discovered).toBe(0);
    expect(executor.calls()).toBe(0);
  });

  maybe()("bounds one pass to the requested batch size", async () => {
    const profileId = await profile("batch");
    await planFor();
    await planFor();
    await planFor();

    const executor = executorReturning(REFUSED);
    const summary: Outcome = await serviceFor(profileId, executor, "worker-batch").runOnce(2);

    expect(summary.discovered).toBe(2);
    expect(executor.calls()).toBe(2);
  });
});

describe("selected plan adoption — what the API reports", () => {
  const plans = () => new ExtremeRRService(prisma!);

  maybe()("writes no singleton SelectedPlanOutcome row", async () => {
    // Phase 11E: SelectedPlanOutcome is keyed alertId UNIQUE with an upsert
    // writer, so it can hold exactly ONE verdict per plan. A second account
    // writing through it would overwrite the first, and the dashboard would
    // show whichever account finished last as though it were the system's
    // decision. New per-account evaluations go to SelectedPlanAdoption and
    // nowhere else.
    const profileId = await profile("no-singleton");
    const plan = await planFor();

    await serviceFor(profileId, executorReturning(REFUSED), "worker-1").runOnce();

    const singleton = await prisma!.selectedPlanOutcome.findUnique({
      where: { alertId: plan.alertId },
    });
    expect(singleton).toBeNull();

    // The canonical row is there instead.
    const [adoption] = await adoptionsOf(plan.planId);
    expect(adoption.status).toBe("COMPLETED");
    expect(adoption.executionProfileId).toBe(profileId);
  });

  maybe()("keeps BOTH accounts recoverable, and claims no overall verdict", async () => {
    const profileA = await profile("A");
    const profileB = await profile("B");
    const plan = await planFor();

    await serviceFor(
      profileA,
      executorReturning({
        handled: true,
        executionId: "exec-A",
        created: true,
        admitted: true,
        reasonCode: null,
      }),
      "worker-A"
    ).runOnce();
    await serviceFor(
      profileB,
      executorReturning({
        handled: false,
        reasonCode: "PROFILE_UNAVAILABLE",
        message: "B declines",
      }),
      "worker-B"
    ).runOnce();

    const dto = await plans().getForAlert(plan.alertId);

    // Both verdicts survive, independently and in full.
    expect(dto!.executionOutcomes).toHaveLength(2);
    const byProfile = new Map(
      dto!.executionOutcomes.map((outcome) => [outcome.executionProfileId, outcome])
    );
    expect(byProfile.get(profileA)).toMatchObject({
      handled: true,
      executionId: "exec-A",
    });
    expect(byProfile.get(profileB)).toMatchObject({
      handled: false,
      reasonCode: "PROFILE_UNAVAILABLE",
    });

    // And NOTHING presents one of them as the answer. Latest-wins, first-wins
    // and any other arbitrary pick are all excluded by this being null.
    expect(dto!.executionOutcome).toBeNull();
  });

  maybe()("still reports a singular outcome when exactly one account evaluated", async () => {
    // The compatibility contract: today's single-account deployment sees the
    // same field it always saw, because with one account there IS one answer.
    const profileId = await profile("single");
    const plan = await planFor();

    await serviceFor(profileId, executorReturning(REFUSED), "worker-1").runOnce();

    const dto = await plans().getForAlert(plan.alertId);
    expect(dto!.executionOutcomes).toHaveLength(1);
    expect(dto!.executionOutcome).toMatchObject({
      handled: false,
      reasonCode: "MARGIN_PLAN_NOT_READY",
    });
    // The singular projection is exactly the one account's verdict.
    expect(dto!.executionOutcome!.reasonCode).toBe(dto!.executionOutcomes[0].reasonCode);
  });

  maybe()("falls back to the legacy row for a historical plan with no adoptions", async () => {
    // Pre-11E plans were evaluated by an architecture that wrote only the
    // singleton. Their explanation must not disappear because the table that
    // replaced it is empty for them.
    const plan = await planFor({ fanoutReady: false });
    await prisma!.selectedPlanOutcome.create({
      data: {
        alertId: plan.alertId,
        extremeRRPlanId: plan.planId,
        handled: false,
        reasonCode: "CANDIDATE_INCOMPLETE",
        message: "historical refusal",
        executionId: null,
        evaluatedAt: ago(FRESH_MS),
      },
    });

    const dto = await plans().getForAlert(plan.alertId);
    expect(dto!.executionOutcomes).toEqual([]);
    expect(dto!.executionOutcome).toMatchObject({
      handled: false,
      reasonCode: "CANDIDATE_INCOMPLETE",
      message: "historical refusal",
    });
  });

  maybe()("a PENDING claim is not reported as a verdict", async () => {
    // A claim in progress is not a decision. Reporting one would invent an
    // outcome no account has reached.
    const profileId = await profile("in-flight");
    const plan = await planFor();
    await prisma!.selectedPlanAdoption.create({
      data: {
        extremeRRPlanId: plan.planId,
        executionProfileId: profileId,
        status: "PENDING",
        attempts: 1,
        claimedAt: new Date(),
        claimOwner: "worker-in-flight",
      },
    });

    const dto = await plans().getForAlert(plan.alertId);
    expect(dto!.executionOutcomes).toEqual([]);
    expect(dto!.executionOutcome).toBeNull();
  });
});
