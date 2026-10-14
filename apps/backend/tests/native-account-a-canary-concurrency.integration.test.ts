import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * PRE-MERGE AUDIT, QUESTION 1: two different Native candidates for the SAME
 * account + symbol + side, at the same time.
 *
 * The hard case is the one an alert-specific adoption lease cannot cover: two
 * DIFFERENT plans (a 1D and a 1W touch on BTCUSDT from one source bar) are
 * claimed by two workers and evaluated concurrently. Both see empty occupancy,
 * and both must then try to establish durable occupancy (the execution row the
 * occupancy rule counts). At most one may succeed, and the loser must fail
 * closed deterministically.
 *
 * Getting that far requires Native execution ENABLED, so each test mutates the
 * hard switch to `true` in a TEST-ONLY module graph (vi.doMock + resetModules).
 * The production constant is untouched, and nothing here can reach an
 * exchange: the margin planner and the orchestrator are in-memory fakes, and
 * creation is database-only. Rows go to the dedicated `_test` database and are
 * removed by the owning profiles' tag.
 */

const TAG = "native-canary-race";
const SWITCH = "../src/modules/native-canary/native-execution-switch";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const fixtures = await import("./helpers/native-canary-fixtures");

const maybe = () => (available ? it : it.skip);
const ago = (ms: number) => new Date(Date.now() - ms);
let sequence = 0;

/**
 * The production module graph with ONLY the hard switch mutated to true and
 * the Native risk contracts replaced by a SYNTHETIC resolved Account A one
 * (M5: an UNRESOLVED contract would refuse every candidate before the race).
 */
async function enabledGraph() {
  vi.resetModules();
  vi.doMock(SWITCH, () => ({ NATIVE_EXECUTION_ENABLED: true }));
  vi.doMock(fixtures.RISK_CONTRACT_MODULE, fixtures.resolvedAContracts);
  return {
    canary: await import("../src/modules/native-canary/native-account-a-canary"),
    adoption: await import("../src/modules/native-canary/native-account-a-adoption"),
    executor: await import("../src/modules/execution/selected-plan-executor"),
    executions: await import("../src/modules/execution/execution.service"),
    plans: await import("../src/modules/extreme-rr/extreme-rr.service"),
  };
}

afterEach(() => {
  vi.doUnmock(SWITCH);
  vi.doUnmock(fixtures.RISK_CONTRACT_MODULE);
  vi.resetModules();
});

async function armedProfile(alias: string): Promise<string> {
  sequence += 1;
  const row = await prisma!.executionProfile.create({
    data: {
      name: `${TAG} ${alias} ${sequence}`,
      accountIdentifier: `${TAG}-${alias}-${sequence}`,
      environment: "TESTNET",
      isEnabled: true,
      safetyPolicy: { create: { killSwitchActive: false } },
    },
  });
  return row.id;
}

const boundProfileOf = (executionProfileId: string) => ({ executionProfileId, exchange: "BINANCE", product: "USDM_FUTURES", environment: "TESTNET" as const });

/**
 * One NATIVE alert row (as the emitter writes it) and its READY plan. The
 * trigger instant is the payload's own, so the alert is fresh at
 * fixtures.FRESH_NOW, the clock every pass below runs on.
 */
async function nativeAlertAndPlan(alert: ReturnType<typeof fixtures.canaryAlert>, direction: "LONG" | "SHORT") {
  sequence += 1;
  const triggeredAt = alert.triggeredAt!;
  const row = await prisma!.alert.create({
    data: {
      symbol: alert.symbol,
      assetType: "CRYPTO",
      exchange: "BINANCE",
      timeframe: "15m",
      price: alert.price,
      signal: direction,
      indicatorName: `${TAG}-${sequence}`,
      source: "NATIVE",
      sourceTimeframe: alert.sourceTimeframe,
      rawPayload: alert.rawPayload as object,
      triggeredAt,
    },
  });
  const plan = await prisma!.extremeRRPlan.create({
    data: {
      alertId: row.id,
      status: "READY",
      direction,
      entryPrice: fixtures.ENTRY_PRICE,
      cutoffAt: triggeredAt,
      timeframe: "15m",
      marketType: "USDM_PERPETUAL",
      templateName: fixtures.TEMPLATE.name,
      referenceCapital: fixtures.TEMPLATE.referenceCapital,
      riskPercent: fixtures.TEMPLATE.riskPercent,
      rewardRatio: fixtures.TEMPLATE.rewardRatio,
      riskAmount: fixtures.TEMPLATE.riskAmount,
      targetAmount: fixtures.TEMPLATE.targetAmount,
      candidates: fixtures.storedCandidates(direction) as object,
      selectedLookback: 100,
      generatedAt: triggeredAt,
      executionFanoutReadyAt: null,
    },
  });
  return { alertId: row.id, planId: plan.id, alert: { ...alert, id: row.id } };
}

/** Releases every party at once, only when all of them have arrived. */
function barrier(parties: number, timeoutMs = 15_000) {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  return {
    arrivals: () => arrived,
    async arrive(): Promise<void> {
      arrived += 1;
      if (arrived >= parties) release();
      await Promise.race([
        open,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("barrier timeout: the other candidate never reached the margin planner")), timeoutMs)),
      ]);
    },
  };
}

/** The READY margin plan an in-memory planner returns: no exchange, no signing. */
function readyMarginPlan(request: { symbol: string; direction: "LONG" | "SHORT"; entryPrice: string; stopLoss: string; riskBudgetUsd: string }) {
  return {
    status: "READY",
    reason: null,
    symbol: request.symbol,
    direction: request.direction,
    entryPrice: request.entryPrice,
    stopLoss: request.stopLoss,
    calculatedStopLoss: request.stopLoss,
    riskBudgetUsd: request.riskBudgetUsd,
    quantityRaw: "187.5",
    roundedQuantity: "187",
    quantityStepSize: "1",
    actualPlannedLoss: "1.496",
    unusedRiskBudget: "0.004",
    positionNotional: "151.9",
    targetIsolatedMargin: "15",
    maximumIsolatedMargin: "20",
    selectedLeverage: 10,
    estimatedInitialMargin: "15.19",
    estimatedLiquidationPrice: "0.73",
    requiredLiquidationBoundary: "0.79",
    liquidationBufferRatio: "2",
  };
}

const FILTERS = { tickSize: "0.0001", stepSize: "1", minQty: "1", minNotional: "5", status: "TRADING", contractType: "PERPETUAL" };

async function cleanup(): Promise<void> {
  if (!available) return;
  const profileIds = (await prisma!.executionProfile.findMany({ where: { accountIdentifier: { startsWith: TAG } }, select: { id: true } })).map((p) => p.id);
  const executionIds = (await prisma!.tradeExecution.findMany({ where: { executionProfileId: { in: profileIds } }, select: { id: true } })).map((r) => r.id);
  if (executionIds.length > 0) {
    await prisma!.executionEvent.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
    await prisma!.tradeExecution.deleteMany({ where: { id: { in: executionIds } } });
  }
  await prisma!.selectedPlanAdoption.deleteMany({ where: { executionProfileId: { in: profileIds } } });
  await prisma!.alert.deleteMany({ where: { indicatorName: { startsWith: TAG } } });
  await prisma!.executionSafetyPolicy.deleteMany({ where: { executionProfileId: { in: profileIds } } });
  await prisma!.executionProfile.deleteMany({ where: { id: { in: profileIds } } });
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma?.$disconnect();
});

const occupantsOf = (executionProfileId: string, symbol: string, positionSide: "LONG" | "SHORT") =>
  prisma!.tradeExecution.findMany({ where: { executionProfileId, symbol, positionSide } });

describe("Q1. two concurrent Native candidates for Account A + BTCUSDT + LONG", () => {
  maybe()("through the whole path, with two workers: both pass every gate before either inserts, at most ONE establishes occupancy, the loser is refused SAME_SYMBOL_SIDE_OCCUPIED", async () => {
    const graph = await enabledGraph();
    const profileId = await armedProfile("race");
    const records = fixtures.sameBarRecords({ symbol: "BTCUSDT", signal: "LONG" });
    const x = await nativeAlertAndPlan(fixtures.canaryAlert(records, { symbol: "BTCUSDT", observation: 0 }), "LONG");
    const y = await nativeAlertAndPlan(fixtures.canaryAlert(records, { symbol: "BTCUSDT", observation: 1 }), "LONG");
    expect([x.alert.sourceTimeframe, y.alert.sourceTimeframe]).toEqual(["1D", "1W"]);
    const evidence = fixtures.readerOf(fixtures.eligibleEvidence(records, "BTCUSDT"));

    // Both candidates must reach the signed margin planner (i.e. pass the
    // decision, its advisory occupancy check and the executor's fence) before
    // EITHER may insert: the planner holds each one until both have arrived.
    const gate = barrier(2);
    const marginPlanner = {
      planForSymbolWithSnapshot: vi.fn(async (request: Parameters<typeof readyMarginPlan>[0]) => {
        await gate.arrive();
        return { plan: readyMarginPlan(request), exchangeFilters: FILTERS };
      }),
    };
    const orchestrator = { admitAndSubmit: vi.fn(async () => ({ admitted: false, decision: null, reasonCode: "TEST_HALTED_BEFORE_ADMISSION", message: "the test stops at admission" })) };
    const worker = (workerId: string) =>
      new graph.adoption.NativeAccountAAdoptionService({
        prisma: prisma!,
        boundProfile: boundProfileOf(profileId),
        executor: new graph.executor.SelectedPlanExecutor({
          prisma: prisma!,
          marginPlanner: marginPlanner as never,
          executions: new graph.executions.ExecutionService(prisma!),
          orchestrator: orchestrator as never,
          boundProfile: boundProfileOf(profileId),
          nativeFence: { evidence, accountSlot: "ACCOUNT_A" },
        }),
        plans: new graph.plans.ExtremeRRService(prisma!),
        workerId,
        accountSlot: "ACCOUNT_A",
        accountPlanPolicy: fixtures.ACCOUNT_A_POLICY,
        fence: { evidence, accountSlot: "ACCOUNT_A" },
        environmentGates: fixtures.LIVE_READY_GATES,
      });

    await Promise.all([worker("account-a-worker-1").runOnce(undefined, fixtures.FRESH_NOW), worker("account-a-worker-2").runOnce(undefined, fixtures.FRESH_NOW)]);

    expect(gate.arrivals()).toBe(2);
    expect(marginPlanner.planForSymbolWithSnapshot).toHaveBeenCalledTimes(2);
    const occupants = await occupantsOf(profileId, "BTCUSDT", "LONG");
    expect(occupants).toHaveLength(1);
    const verdicts = await prisma!.selectedPlanAdoption.findMany({ where: { executionProfileId: profileId }, orderBy: { reasonCode: "asc" } });
    expect(verdicts.map((v) => [v.status, v.handled, v.reasonCode])).toEqual([
      ["COMPLETED", false, "SAME_SYMBOL_SIDE_OCCUPIED"],
      ["COMPLETED", true, "TEST_HALTED_BEFORE_ADMISSION"],
    ]);
    // Each plan was claimed and evaluated exactly once: X and Y were the two
    // racers, not one plan evaluated twice through a stolen lease.
    expect(verdicts.map((v) => [v.extremeRRPlanId, v.attempts]).sort()).toEqual([[x.planId, 1], [y.planId, 1]].sort());
    // The winner's verdict names the one occupant; the loser reached no admission.
    expect(verdicts.find((v) => v.handled)!.executionId).toBe(occupants[0].id);
    expect(orchestrator.admitAndSubmit).toHaveBeenCalledTimes(1);
  });

  maybe()("at the creation boundary itself, repeatedly: exactly one of two concurrent creations commits, the other is rejected with a typed occupancy conflict", async () => {
    const graph = await enabledGraph();
    const { NativeOccupancyConflictError } = await import("../src/modules/native-canary/native-occupancy");
    for (let round = 0; round < 5; round += 1) {
      const profileId = await armedProfile(`create-${round}`);
      const records = fixtures.sameBarRecords({ symbol: "BTCUSDT", signal: "LONG" });
      const candidates = await Promise.all([0, 1].map((observation) => nativeAlertAndPlan(fixtures.canaryAlert(records, { symbol: "BTCUSDT", observation }), "LONG")));
      const handoffs = candidates.map((c) => {
        const decision = graph.canary.decideNativeAccountACandidate({
          ...fixtures.favourableInput({ symbol: "BTCUSDT" }),
          executionProfileId: profileId,
          alert: c.alert,
          plan: fixtures.planFor(c.alert, { id: c.planId }),
        });
        if (!decision.admitted) throw new Error(`fixture: ${decision.reasonCode}`);
        return decision.handoff;
      });
      const service = new graph.executions.ExecutionService(prisma!);
      const settled = await Promise.allSettled(
        handoffs.map((handoff) =>
          service.createExecutionFromReadyPlan({
            executionProfileId: profileId,
            alertId: handoff.alertId,
            extremeRRPlanId: handoff.planId,
            plan: readyMarginPlan({ symbol: handoff.symbol, direction: handoff.direction, entryPrice: handoff.entryPrice, stopLoss: handoff.candidate.stopLoss!, riskBudgetUsd: handoff.template.riskAmount }) as never,
            takeProfit: handoff.candidate.takeProfit,
            selectedLookback: handoff.lookback,
            nativeAccountA: handoff,
          })
        )
      );
      const fulfilled = settled.filter((s) => s.status === "fulfilled");
      const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
      expect(fulfilled, `round ${round}`).toHaveLength(1);
      expect(rejected, `round ${round}`).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(NativeOccupancyConflictError);
      expect(rejected[0].reason).toMatchObject({ reasonCode: "SAME_SYMBOL_SIDE_OCCUPIED" });
      expect(await occupantsOf(profileId, "BTCUSDT", "LONG"), `round ${round}`).toHaveLength(1);
    }
  });

  maybe()("a reclaim never steals a LIVE lease, even when discovery hands it a claim made a moment ago; an EXPIRED lease is reclaimed exactly once", async () => {
    // The REAL module (switch false): the claim protocol is the same either way.
    const { NativeAccountAAdoptionService, NATIVE_ADOPTION_CLAIM_LEASE_MS } = await import("../src/modules/native-canary/native-account-a-adoption");
    const { ExtremeRRService } = await import("../src/modules/extreme-rr/extreme-rr.service");
    const profileId = await armedProfile("lease");
    const c = await nativeAlertAndPlan(fixtures.canaryAlert(fixtures.cleanRecords({ symbol: "BTCUSDT" }), { symbol: "BTCUSDT" }), "LONG");
    const live = await prisma!.selectedPlanAdoption.create({
      data: { extremeRRPlanId: c.planId, executionProfileId: profileId, status: "PENDING", attempts: 1, claimedAt: new Date(), claimOwner: "live-worker" },
    });
    const service = (workerId: string) =>
      new NativeAccountAAdoptionService({
        prisma: prisma!,
        boundProfile: boundProfileOf(profileId),
        executor: { handleNativeAccountACandidate: vi.fn() } as never,
        plans: new ExtremeRRService(prisma!),
        workerId,
        accountSlot: "ACCOUNT_A",
        accountPlanPolicy: fixtures.ACCOUNT_A_POLICY,
        fence: { evidence: null },
        environmentGates: fixtures.LIVE_READY_GATES,
      }) as unknown as { claim(candidate: object, now: Date): Promise<string | null> };
    // Exactly the stale view the race produced: the live row, with its real attempts value.
    const candidate = { planId: c.planId, alertId: c.alertId, adoptionId: live.id, attempts: 1 };
    expect(await service("thief").claim(candidate, new Date())).toBeNull();
    expect(await prisma!.selectedPlanAdoption.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({ attempts: 1, claimOwner: "live-worker", status: "PENDING" });

    await prisma!.selectedPlanAdoption.update({ where: { id: live.id }, data: { claimedAt: ago(NATIVE_ADOPTION_CLAIM_LEASE_MS * 2) } });
    const results = await Promise.all([service("reclaimer-1").claim(candidate, new Date()), service("reclaimer-2").claim(candidate, new Date())]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect((await prisma!.selectedPlanAdoption.findUniqueOrThrow({ where: { id: live.id } })).attempts).toBe(2);
  });

  maybe()("the lock is keyed by account + symbol + SIDE: the opposite side and another symbol are not serialized against BTCUSDT LONG", async () => {
    const graph = await enabledGraph();
    const profileId = await armedProfile("keys");
    const long = await nativeAlertAndPlan(fixtures.canaryAlert(fixtures.cleanRecords({ symbol: "BTCUSDT", signal: "LONG" }), { symbol: "BTCUSDT" }), "LONG");
    const short = await nativeAlertAndPlan(fixtures.canaryAlert(fixtures.cleanRecords({ symbol: "BTCUSDT", signal: "SHORT" }), { symbol: "BTCUSDT" }), "SHORT");
    const eth = await nativeAlertAndPlan(fixtures.canaryAlert(fixtures.cleanRecords({ symbol: "ETHUSDT", signal: "LONG" }), { symbol: "ETHUSDT" }), "LONG");
    const service = new graph.executions.ExecutionService(prisma!);
    const settled = await Promise.allSettled(
      [long, short, eth].map((c) => {
        const direction = c.alert.signal as "LONG" | "SHORT";
        const decision = graph.canary.decideNativeAccountACandidate({
          ...fixtures.favourableInput({ symbol: c.alert.symbol, signal: direction }),
          executionProfileId: profileId,
          alert: c.alert,
          plan: fixtures.planFor(c.alert, { id: c.planId }),
        });
        if (!decision.admitted) throw new Error(`fixture: ${decision.reasonCode}`);
        const h = decision.handoff;
        return service.createExecutionFromReadyPlan({
          executionProfileId: profileId,
          alertId: h.alertId,
          extremeRRPlanId: h.planId,
          plan: readyMarginPlan({ symbol: h.symbol, direction: h.direction, entryPrice: h.entryPrice, stopLoss: h.candidate.stopLoss!, riskBudgetUsd: h.template.riskAmount }) as never,
          takeProfit: h.candidate.takeProfit,
          selectedLookback: h.lookback,
          nativeAccountA: h,
        });
      })
    );
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
  });

  maybe()("a retry of the SAME candidate stays idempotent: its own execution is never its occupant, a concurrent duplicate loses on the unique key, one row remains", async () => {
    const graph = await enabledGraph();
    const profileId = await armedProfile("retry");
    const c = await nativeAlertAndPlan(fixtures.canaryAlert(fixtures.cleanRecords({ symbol: "BTCUSDT" }), { symbol: "BTCUSDT" }), "LONG");
    const decision = graph.canary.decideNativeAccountACandidate({
      ...fixtures.favourableInput({ symbol: "BTCUSDT" }),
      executionProfileId: profileId,
      alert: c.alert,
      plan: fixtures.planFor(c.alert, { id: c.planId }),
    });
    if (!decision.admitted) throw new Error("fixture");
    const h = decision.handoff;
    const service = new graph.executions.ExecutionService(prisma!);
    const create = () =>
      service.createExecutionFromReadyPlan({
        executionProfileId: profileId,
        alertId: h.alertId,
        extremeRRPlanId: h.planId,
        plan: readyMarginPlan({ symbol: h.symbol, direction: h.direction, entryPrice: h.entryPrice, stopLoss: h.candidate.stopLoss!, riskBudgetUsd: h.template.riskAmount }) as never,
        takeProfit: h.candidate.takeProfit,
        selectedLookback: h.lookback,
        nativeAccountA: h,
      });
    const settled = await Promise.allSettled([create(), create()]);
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    // Either the second saw the first and returned it, or it lost the unique
    // (alertId, profile) race. Never an occupancy refusal against itself.
    for (const r of rejected) expect((r.reason as { code?: string }).code).toBe("P2002");
    const first = await create();
    expect(await occupantsOf(profileId, "BTCUSDT", "LONG")).toHaveLength(1);
    expect((await occupantsOf(profileId, "BTCUSDT", "LONG"))[0].id).toBe(first.id);
  });
});
