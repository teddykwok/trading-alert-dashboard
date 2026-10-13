import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * MILESTONE 4: the Native Account A canary against REAL Postgres (the
 * dedicated `_test` database), with EVERY private exchange adapter replaced by
 * a trap that records and throws.
 *
 * What is real: the Native adoption service and its claim protocol, the plan
 * service, ExecutionService creation, SafetyAdmissionService (Phase 5) and the
 * EntryLifecycleService, all on Prisma. What is fake: the scanner evidence
 * (fixture bytes) and the exchange, which is a trap. A trap that is touched
 * fails the assertion that it was not: "zero private calls" is measured, not
 * assumed.
 *
 * Rows created here are synthetic and tagged; cleanup removes only rows owned
 * by profiles whose accountIdentifier carries the tag.
 *
 * The live-entry gates are opened in THIS TEST PROCESS only, exactly as the
 * real-service e2e suite does, so the entry lifecycle's own gate check passes
 * and the Native final fence is what has to refuse. Nothing reads or writes the
 * real .env, and the traps mean nothing could leave the process anyway.
 */

process.env.EXECUTION_GLOBAL_KILL_SWITCH = "false";
process.env.EXECUTION_LIVE_ENTRY_ENABLED = "true";
process.env.EXECUTION_PROTECTION_READY = "true";

const TAG = "native-canary-m4";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { NativeAccountAAdoptionService, NATIVE_ADOPTION_CLAIM_LEASE_MS } = await import("../src/modules/native-canary/native-account-a-adoption");
const { nativeExecutionFence } = await import("../src/modules/native-canary/native-execution-fence");
const { ExtremeRRService } = await import("../src/modules/extreme-rr/extreme-rr.service");
const { ExecutionService } = await import("../src/modules/execution/execution.service");
const { EntryLifecycleService } = await import("../src/modules/execution/entry-lifecycle.service");
const { SafetyAdmissionService } = await import("../src/modules/execution/safety-admission.service");
const { NativeAlertExecutionForbiddenError } = await import("../src/modules/alerts/alert-source");
const { env } = await import("../src/config/env");
const fixtures = await import("./helpers/native-canary-fixtures");
const { bar } = await import("./helpers/native-alert-fixtures");

const maybe = () => (available ? it : it.skip);
const ago = (ms: number) => new Date(Date.now() - ms);
const FRESH_MS = 30_000;
const EXPIRED_MS = (env.EXECUTION_MAX_ALERT_AGE_SECONDS + 600) * 1000;

let sequence = 0;

// ---------------------------------------------------------------------------
// Traps: every private adapter records and throws
// ---------------------------------------------------------------------------

interface Trap {
  readonly calls: string[];
}

/** Any property access is recorded; calling anything throws. */
function trap(name: string, allow: Record<string, unknown> = {}): Trap & Record<string, unknown> {
  const calls: string[] = [];
  return new Proxy({ calls } as Trap & Record<string, unknown>, {
    get: (target, key) => {
      if (key === "calls") return calls;
      if (typeof key === "string" && key in allow) return allow[key];
      if (key === "then") return undefined;
      calls.push(`${name}.${String(key)}`);
      return () => {
        throw new Error(`PRIVATE ADAPTER REACHED: ${name}.${String(key)}`);
      };
    },
  });
}

/** The exchange mutation client with both gates "open", so only the Native fence can refuse. */
const mutationTrap = () => trap("mutations", { blockedReason: null, mutationsDispatched: 0, isLiveMutationAllowed: true });
const readOnlyTrap = () => trap("readOnly");

function executorTrap() {
  const handle = vi.fn(async () => {
    throw new Error("PRIVATE ADAPTER REACHED: executor.handleNativeAccountACandidate");
  });
  return { handleNativeAccountACandidate: handle, calls: () => handle.mock.calls.length };
}

// ---------------------------------------------------------------------------
// Synthetic rows
// ---------------------------------------------------------------------------

async function profile(alias: string, state: "ARMED" | "SAFE_OFF" = "ARMED"): Promise<string> {
  sequence += 1;
  const row = await prisma!.executionProfile.create({
    data: {
      name: `${TAG} ${alias} ${sequence}`,
      accountIdentifier: `${TAG}-${alias}-${sequence}`,
      environment: "TESTNET",
      isEnabled: state === "ARMED",
      safetyPolicy: { create: { killSwitchActive: state !== "ARMED" } },
    },
  });
  return row.id;
}

const boundProfileOf = (executionProfileId: string) => ({ executionProfileId, exchange: "BINANCE", product: "USDM_FUTURES", environment: "TESTNET" as const });

interface NativeFixture {
  alertId: string;
  planId: string;
  symbol: string;
  records: ReturnType<typeof fixtures.cleanRecords>;
}

/** A NATIVE alert exactly as the emitter writes it, and its READY plan. */
async function nativePlan(options: { sourceTf?: "1D" | "1W" | "1M"; signal?: "LONG" | "SHORT"; agoMs?: number; status?: "READY" | "PENDING" } = {}): Promise<NativeFixture> {
  sequence += 1;
  const symbol = `CNRY${sequence}USDT`;
  const records = fixtures.cleanRecords({ sourceTf: options.sourceTf ?? "1D", signal: options.signal ?? "LONG", symbol });
  const alert = fixtures.canaryAlert(records, { symbol });
  const triggeredAt = ago(options.agoMs ?? FRESH_MS);
  const created = await prisma!.alert.create({
    data: {
      symbol,
      assetType: "CRYPTO",
      exchange: "BINANCE",
      timeframe: "15m",
      price: alert.price,
      signal: alert.signal as "LONG" | "SHORT",
      indicatorName: `${TAG}-${sequence}`,
      source: "NATIVE",
      sourceTimeframe: alert.sourceTimeframe,
      rawPayload: alert.rawPayload as object,
      triggeredAt,
    },
  });
  const direction = (options.signal ?? "LONG") as "LONG" | "SHORT";
  const plan = await prisma!.extremeRRPlan.create({
    data: {
      alertId: created.id,
      status: options.status ?? "READY",
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
      selectedLookback: 300,
      generatedAt: triggeredAt,
      // Native plans never carry the TradingView fan-out marker.
      executionFanoutReadyAt: null,
    },
  });
  return { alertId: created.id, planId: plan.id, symbol, records };
}

/** Scanner evidence per symbol, as the file-system reader would serve it. */
function evidenceBySymbol(entries: [string, ReturnType<typeof fixtures.evidenceOf>][]) {
  const map = new Map(entries);
  let reads = 0;
  const reader = (provenance: { symbol: string }) => {
    reads += 1;
    const found = map.get(provenance.symbol);
    if (found === undefined) throw new Error(`no evidence for ${provenance.symbol}`);
    return found;
  };
  return Object.assign(reader, { reads: () => reads });
}

function adoption(
  executionProfileId: string,
  executor: ReturnType<typeof executorTrap>,
  evidence: ReturnType<typeof evidenceBySymbol>,
  over: Partial<ConstructorParameters<typeof NativeAccountAAdoptionService>[0]> = {}
) {
  return new NativeAccountAAdoptionService({
    prisma: prisma!,
    boundProfile: boundProfileOf(executionProfileId),
    executor: executor as never,
    plans: new ExtremeRRService(prisma!),
    workerId: `worker-${sequence}`,
    accountSlot: "ACCOUNT_A",
    accountPlanPolicy: fixtures.ACCOUNT_A_POLICY,
    fence: { evidence: evidence as never },
    environmentGates: fixtures.LIVE_READY_GATES,
    ...over,
  });
}

const adoptionsOf = (planId: string) => prisma!.selectedPlanAdoption.findMany({ where: { extremeRRPlanId: planId }, orderBy: { createdAt: "asc" } });

/** A TradeExecution row written DIRECTLY: the shape no code path can create for a NATIVE alert today. */
async function executionRow(options: {
  executionProfileId: string;
  alertId: string | null;
  symbol: string;
  status: "PLAN_READY" | "PREFLIGHT" | "ENTRY_SUBMITTING" | "ENTRY_PENDING" | "CANCELED";
  direction?: "LONG" | "SHORT";
  marker?: boolean;
}) {
  const direction = options.direction ?? "LONG";
  const row = await prisma!.tradeExecution.create({
    data: {
      executionProfileId: options.executionProfileId,
      alertId: options.alertId,
      symbol: options.symbol,
      direction,
      positionSide: direction,
      selectedLookback: 100,
      status: options.status,
      version: 1,
      signalTriggeredAt: ago(FRESH_MS),
      sourceTimeframe: "1D",
      plannedEntryPrice: "0.8123",
      calculatedStopLoss: "0.8043",
      executableStopLoss: "0.8043",
      riskBudgetUsd: "1.5",
      quantityRaw: "187.5",
      plannedQuantity: "187",
      quantityStepSize: "1",
      actualPlannedLoss: "1.496",
      unusedRiskBudget: "0.004",
      positionNotional: "151.9",
      targetIsolatedMargin: "15",
      maximumIsolatedMargin: "20",
      selectedLeverage: 10,
      estimatedInitialMargin: "15.19",
      liquidationBufferRatio: "2",
      marginPlanSnapshot: { synthetic: TAG },
      exchangeFiltersSnapshot: { synthetic: TAG },
    },
  });
  await prisma!.executionEvent.create({
    data: {
      tradeExecutionId: row.id,
      sequenceNumber: 1,
      eventType: "EXECUTION_CREATED",
      toStatus: "PLAN_READY",
      reasonCode: "PLAN_READY",
      message: "synthetic",
      metadata: { symbol: options.symbol, direction, selectedLeverage: 10, ...(options.marker ? { alertSource: "NATIVE" } : {}) },
    },
  });
  return row;
}

async function cleanup(): Promise<void> {
  if (!available) return;
  const profiles = await prisma!.executionProfile.findMany({ where: { accountIdentifier: { startsWith: TAG } }, select: { id: true } });
  const profileIds = profiles.map((p) => p.id);
  const executionIds = (await prisma!.tradeExecution.findMany({ where: { executionProfileId: { in: profileIds } }, select: { id: true } })).map((r) => r.id);
  if (executionIds.length > 0) {
    const owned = { tradeExecutionId: { in: executionIds } };
    await prisma!.executionNotificationCheckpoint.deleteMany({ where: { executionEvent: { tradeExecutionId: { in: executionIds } } } });
    await prisma!.executionNotification.deleteMany({ where: owned });
    await prisma!.criticalAlert.deleteMany({ where: owned });
    await prisma!.safetyAdmission.deleteMany({ where: owned });
    await prisma!.binanceOrder.deleteMany({ where: owned });
    await prisma!.executionEvent.deleteMany({ where: owned });
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

// ===========================================================================
// B. Durable, idempotent Account A adoption
// ===========================================================================

describe("B. Native Account A adoption: durable intent, one verdict per (plan, profile)", () => {
  maybe()("1/25/26. a fully valid candidate with every gate favourable traverses every stage and is refused at the hard fence; the executor and every private adapter are untouched", async () => {
    const profileId = await profile("valid");
    const plan = await nativePlan({ sourceTf: "1D" });
    const evidence = evidenceBySymbol([[plan.symbol, fixtures.eligibleEvidence(plan.records, plan.symbol)]]);
    const executor = executorTrap();

    const summary = await adoption(profileId, executor, evidence).runOnce();
    expect(summary).toMatchObject({ discovered: 1, deferred: 0, claimed: 1, completed: 1 });

    const [row] = await adoptionsOf(plan.planId);
    expect(row).toMatchObject({ status: "COMPLETED", handled: false, reasonCode: "NATIVE_EXECUTION_DISABLED", executionId: null, claimedAt: null, claimOwner: null });
    expect(row.message).toMatch(/^NATIVE_FENCE: Every stage passed/);
    expect(executor.calls()).toBe(0);
    expect(evidence.reads()).toBeGreaterThan(0);
    // Nothing downstream exists: no execution, no order, no admission.
    expect(await prisma!.tradeExecution.count({ where: { executionProfileId: profileId } })).toBe(0);
  });

  maybe()("1b. the same for 1W and for SHORT", async () => {
    const profileId = await profile("valid-1w");
    const w = await nativePlan({ sourceTf: "1W" });
    const s = await nativePlan({ sourceTf: "1D", signal: "SHORT" });
    const evidence = evidenceBySymbol([
      [w.symbol, fixtures.eligibleEvidence(w.records, w.symbol)],
      [s.symbol, fixtures.eligibleEvidence(s.records, s.symbol)],
    ]);
    const executor = executorTrap();
    expect(await adoption(profileId, executor, evidence).runOnce()).toMatchObject({ discovered: 2, completed: 2 });
    for (const p of [w, s]) expect((await adoptionsOf(p.planId))[0].reasonCode).toBe("NATIVE_EXECUTION_DISABLED");
    expect(executor.calls()).toBe(0);
  });

  maybe()("22. a retry evaluates nothing twice: the second pass discovers nothing and the row is unchanged", async () => {
    const profileId = await profile("retry");
    const plan = await nativePlan();
    const evidence = evidenceBySymbol([[plan.symbol, fixtures.eligibleEvidence(plan.records, plan.symbol)]]);
    const executor = executorTrap();
    const service = adoption(profileId, executor, evidence);
    await service.runOnce();
    const before = await adoptionsOf(plan.planId);
    expect(await service.runOnce()).toMatchObject({ discovered: 0, claimed: 0, completed: 0 });
    expect(await adoptionsOf(plan.planId)).toEqual(before);
    expect(before).toHaveLength(1);
    expect(executor.calls()).toBe(0);
  });

  maybe()("23. restart: a crash between claim and verdict is finished by a NEW worker, still one durable intent", async () => {
    const profileId = await profile("restart");
    const plan = await nativePlan();
    // The crashed worker's claim: PENDING, attempts 1, lease long expired.
    await prisma!.selectedPlanAdoption.create({
      data: { extremeRRPlanId: plan.planId, executionProfileId: profileId, status: "PENDING", attempts: 1, claimedAt: ago(NATIVE_ADOPTION_CLAIM_LEASE_MS * 2), claimOwner: "crashed-worker" },
    });
    const evidence = evidenceBySymbol([[plan.symbol, fixtures.eligibleEvidence(plan.records, plan.symbol)]]);
    const restarted = adoption(profileId, executorTrap(), evidence, { workerId: "restarted-worker" });
    expect(await restarted.runOnce()).toMatchObject({ discovered: 1, claimed: 1, completed: 1 });
    const rows = await adoptionsOf(plan.planId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "COMPLETED", attempts: 2, reasonCode: "NATIVE_EXECUTION_DISABLED" });
  });

  maybe()("23b. two workers racing for the same plan create exactly one intent and one verdict", async () => {
    const profileId = await profile("race");
    const plan = await nativePlan();
    const evidence = evidenceBySymbol([[plan.symbol, fixtures.eligibleEvidence(plan.records, plan.symbol)]]);
    const [a, b] = await Promise.all([adoption(profileId, executorTrap(), evidence, { workerId: "w-a" }).runOnce(), adoption(profileId, executorTrap(), evidence, { workerId: "w-b" }).runOnce()]);
    expect(a.completed + b.completed).toBe(1);
    expect(await adoptionsOf(plan.planId)).toHaveLength(1);
  });

  maybe()("23c. a live lease is never stolen", async () => {
    const profileId = await profile("lease");
    const plan = await nativePlan();
    await prisma!.selectedPlanAdoption.create({
      data: { extremeRRPlanId: plan.planId, executionProfileId: profileId, status: "PENDING", attempts: 1, claimedAt: ago(1_000), claimOwner: "busy-worker" },
    });
    const evidence = evidenceBySymbol([[plan.symbol, fixtures.eligibleEvidence(plan.records, plan.symbol)]]);
    expect(await adoption(profileId, executorTrap(), evidence).runOnce()).toMatchObject({ discovered: 0 });
    expect((await adoptionsOf(plan.planId))[0]).toMatchObject({ status: "PENDING", attempts: 1, claimOwner: "busy-worker" });
  });

  maybe()("10. a source bar still forming is deferred, not refused: nothing is written, and a later pass decides it", async () => {
    const profileId = await profile("deferred");
    const plan = await nativePlan();
    const pending = evidenceBySymbol([[plan.symbol, fixtures.evidenceOf(plan.records.slice(0, 2), fixtures.SOURCE_BAR, plan.symbol)]]);
    expect(await adoption(profileId, executorTrap(), pending).runOnce()).toMatchObject({ discovered: 1, deferred: 1, claimed: 0 });
    expect(await adoptionsOf(plan.planId)).toHaveLength(0);
    const closed = evidenceBySymbol([[plan.symbol, fixtures.eligibleEvidence(plan.records, plan.symbol)]]);
    expect(await adoption(profileId, executorTrap(), closed).runOnce()).toMatchObject({ completed: 1 });
    expect((await adoptionsOf(plan.planId))[0].reasonCode).toBe("NATIVE_EXECUTION_DISABLED");
  });

  maybe()("11-16. a finally-ineligible source bar is a terminal, durable refusal with the canonical status", async () => {
    const profileId = await profile("ineligible");
    const plan = await nativePlan();
    const requarantined = fixtures.evidenceOf([...plan.records.slice(0, 2), { ...plan.records[2], classification: "QUARANTINED_CURRENT_BAR" } as never], bar(2), plan.symbol);
    const evidence = evidenceBySymbol([[plan.symbol, requarantined]]);
    expect(await adoption(profileId, executorTrap(), evidence).runOnce()).toMatchObject({ completed: 1 });
    const [row] = await adoptionsOf(plan.planId);
    expect(row).toMatchObject({ reasonCode: "INTEGRITY_INELIGIBLE", handled: false });
    expect(row.message).toMatch(/^INTEGRITY: /);
  });

  maybe()("2/27. an Account B process records ACCOUNT_NOT_A and never reaches its executor or any adapter", async () => {
    const profileId = await profile("account-b");
    const plan = await nativePlan();
    const evidence = evidenceBySymbol([[plan.symbol, fixtures.eligibleEvidence(plan.records, plan.symbol)]]);
    const executor = executorTrap();
    await adoption(profileId, executor, evidence, { accountSlot: "ACCOUNT_B", accountPlanPolicy: fixtures.ACCOUNT_B_POLICY }).runOnce();
    expect((await adoptionsOf(plan.planId))[0]).toMatchObject({ reasonCode: "ACCOUNT_NOT_A", handled: false });
    expect(executor.calls()).toBe(0);
  });

  maybe()("17/20/21. occupancy is read from durable local state: a pending LIMIT on the same side blocks, the opposite side does not, a possibly-live order on a finished row is ambiguous", async () => {
    const sameSide = await profile("occupied");
    const a = await nativePlan();
    await executionRow({ executionProfileId: sameSide, alertId: null, symbol: a.symbol, status: "ENTRY_PENDING", direction: "LONG" });
    const ev = (p: NativeFixture) => evidenceBySymbol([[p.symbol, fixtures.eligibleEvidence(p.records, p.symbol)]]);
    await adoption(sameSide, executorTrap(), ev(a)).runOnce();
    expect((await adoptionsOf(a.planId))[0].reasonCode).toBe("SAME_SYMBOL_SIDE_OCCUPIED");

    const opposite = await profile("opposite");
    const b = await nativePlan();
    await executionRow({ executionProfileId: opposite, alertId: null, symbol: b.symbol, status: "ENTRY_PENDING", direction: "SHORT" });
    await adoption(opposite, executorTrap(), ev(b)).runOnce();
    expect((await adoptionsOf(b.planId))[0].reasonCode).toBe("NATIVE_EXECUTION_DISABLED");

    const contradictory = await profile("contradictory");
    const c = await nativePlan();
    const finished = await executionRow({ executionProfileId: contradictory, alertId: null, symbol: c.symbol, status: "CANCELED", direction: "LONG" });
    await prisma!.binanceOrder.create({
      data: { tradeExecutionId: finished.id, role: "ENTRY", generation: 1, clientOrderId: `x-${finished.id}`, side: "BUY", positionSide: "LONG", orderType: "LIMIT", originalQuantity: "1", executedQuantity: "0", status: "NEW" },
    });
    await adoption(contradictory, executorTrap(), ev(c)).runOnce();
    expect((await adoptionsOf(c.planId))[0].reasonCode).toBe("AMBIGUOUS_STATE");
  });

  maybe()("24. the account's own gates come from durable state: a SAFE_OFF profile is refused, and so is a SAFE runtime", async () => {
    const off = await profile("safe-off", "SAFE_OFF");
    const plan = await nativePlan();
    const evidence = evidenceBySymbol([[plan.symbol, fixtures.eligibleEvidence(plan.records, plan.symbol)]]);
    await adoption(off, executorTrap(), evidence).runOnce();
    expect((await adoptionsOf(plan.planId))[0].reasonCode).toBe("ACCOUNT_NOT_ARMED");

    const armed = await profile("safe-runtime");
    const other = await nativePlan();
    const ev2 = evidenceBySymbol([[other.symbol, fixtures.eligibleEvidence(other.records, other.symbol)]]);
    await adoption(armed, executorTrap(), ev2, { environmentGates: fixtures.SAFE_GATES }).runOnce();
    expect((await adoptionsOf(other.planId))[0].reasonCode).toBe("ACCOUNT_NOT_LIVE_READY");
  });

  maybe()("discovery offers only fresh, READY, NATIVE 1D/1W plans, and never a TradingView plan", async () => {
    const profileId = await profile("discovery");
    const stale = await nativePlan({ agoMs: EXPIRED_MS });
    const monthly = await nativePlan({ sourceTf: "1M" });
    const pendingPlan = await nativePlan({ status: "PENDING" });
    sequence += 1;
    const tvAlert = await prisma!.alert.create({
      data: { symbol: `TV${sequence}USDT`, assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 1, signal: "LONG", indicatorName: `${TAG}-tv-${sequence}`, sourceTimeframe: "1D", rawPayload: { note: TAG }, triggeredAt: ago(FRESH_MS) },
    });
    await prisma!.extremeRRPlan.create({ data: { alertId: tvAlert.id, status: "READY", direction: "LONG", entryPrice: "1", cutoffAt: ago(FRESH_MS), timeframe: "15m", executionFanoutReadyAt: ago(FRESH_MS) } });
    const evidence = evidenceBySymbol([]);
    expect(await adoption(profileId, executorTrap(), evidence).runOnce()).toMatchObject({ discovered: 0, claimed: 0 });
    for (const p of [stale, monthly, pendingPlan]) expect(await adoptionsOf(p.planId)).toHaveLength(0);
    expect(evidence.reads()).toBe(0);
  });
});

// ===========================================================================
// The creation fence
// ===========================================================================

describe("creation: a NATIVE alert cannot own a TradeExecution while the switch is false", () => {
  const marginPlan = {
    status: "READY",
    reason: null,
    symbol: "PLACEHOLDER",
    direction: "LONG",
    entryPrice: "0.8123",
    stopLoss: "0.8043",
    calculatedStopLoss: "0.8043",
    riskBudgetUsd: "1.5",
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

  maybe()("without a hand-off, and with a forged one, creation throws the Native fence error and writes nothing", async () => {
    const profileId = await profile("creation");
    const plan = await nativePlan();
    const service = new ExecutionService(prisma!);
    const base = { executionProfileId: profileId, alertId: plan.alertId, extremeRRPlanId: plan.planId, plan: { ...marginPlan, symbol: plan.symbol } as never, selectedLookback: 100 };
    await expect(service.createExecutionFromReadyPlan(base)).rejects.toBeInstanceOf(NativeAlertExecutionForbiddenError);
    const forged = Object.freeze({ kind: "NATIVE_ACCOUNT_A_HANDOFF", executionProfileId: profileId, alertId: plan.alertId, planId: plan.planId, symbol: plan.symbol, direction: "LONG", lookback: 100, integrity: "ELIGIBLE" });
    await expect(service.createExecutionFromReadyPlan({ ...base, nativeAccountA: forged as never })).rejects.toBeInstanceOf(NativeAlertExecutionForbiddenError);
    expect(await prisma!.tradeExecution.count({ where: { alertId: plan.alertId } })).toBe(0);
  });
});

// ===========================================================================
// 29/30. The entry lifecycle's final fence, on rows no code path can create
// ===========================================================================

describe("29/30. the entry lifecycle refuses a Native execution before any private call", () => {
  const evaluatedAt = () => new Date();

  async function nativeExecution(status: "PREFLIGHT" | "ENTRY_SUBMITTING", options: { alert?: boolean } = {}) {
    const profileId = await profile(`entry-${status.toLowerCase()}`);
    const plan = await nativePlan();
    const execution = await executionRow({ executionProfileId: profileId, alertId: options.alert === false ? null : plan.alertId, symbol: plan.symbol, status, marker: true });
    return { profileId, plan, execution };
  }

  maybe()("F0: a Native PREFLIGHT execution is refused before revalidation: zero signed reads, zero mutations, nothing reserved, status unchanged", async () => {
    const { plan, execution } = await nativeExecution("PREFLIGHT");
    const readOnly = readOnlyTrap();
    const mutations = mutationTrap();
    const evidence = evidenceBySymbol([[plan.symbol, fixtures.eligibleEvidence(plan.records, plan.symbol)]]);
    const entry = new EntryLifecycleService(prisma!, readOnly as never, mutations as never, { nativeFence: { evidence: evidence as never } });

    for (const run of [() => entry.prepareEntrySubmission({ executionId: execution.id, expectedVersion: 1, evaluatedAt: evaluatedAt() }), () => entry.resumeEntrySubmission({ executionId: execution.id, expectedVersion: 1, evaluatedAt: evaluatedAt() })]) {
      const outcome = await run();
      expect(outcome).toMatchObject({ ok: false, reasonCode: "NATIVE_EXECUTION_DISABLED", mutationsDispatched: 0, order: null });
    }
    expect(readOnly.calls).toEqual([]);
    expect(mutations.calls).toEqual([]);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
    expect((await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } })).status).toBe("PREFLIGHT");
    // The judgment re-read the evidence on every ask; nothing was cached.
    expect(evidence.reads()).toBe(2);
  });

  maybe()("F2: a Native ENTRY_SUBMITTING execution may still be RECONCILED (risk-reducing GET), but configuration and submission are refused: zero mutations", async () => {
    const { plan, execution } = await nativeExecution("ENTRY_SUBMITTING");
    await prisma!.binanceOrder.create({
      data: { tradeExecutionId: execution.id, role: "ENTRY", generation: 1, clientOrderId: `x-${execution.id}`, side: "BUY", positionSide: "LONG", orderType: "LIMIT", timeInForce: "GTC", price: "0.8123", originalQuantity: "187", executedQuantity: "0", status: "SUBMITTING" },
    });
    const readOnly = readOnlyTrap();
    const mutations = mutationTrap();
    const evidence = evidenceBySymbol([[plan.symbol, fixtures.eligibleEvidence(plan.records, plan.symbol)]]);
    const entry = new EntryLifecycleService(prisma!, readOnly as never, mutations as never, { nativeFence: { evidence: evidence as never } });
    const outcome = await entry.resumeEntrySubmission({ executionId: execution.id, expectedVersion: 1, evaluatedAt: evaluatedAt() });
    expect(outcome).toMatchObject({ ok: false, reasonCode: "NATIVE_EXECUTION_DISABLED", mutationsDispatched: 0 });
    // The only thing attempted was the order lookup that finds an order which might exist.
    expect(readOnly.calls).toEqual(["readOnly.queryOrderByClientOrderId"]);
    expect(mutations.calls).toEqual([]);
  });

  maybe()("a Native execution whose alert is gone is still recognised by its creation marker, and still refused", async () => {
    const { execution } = await nativeExecution("PREFLIGHT", { alert: false });
    const readOnly = readOnlyTrap();
    const mutations = mutationTrap();
    const entry = new EntryLifecycleService(prisma!, readOnly as never, mutations as never, { nativeFence: { evidence: null } });
    const outcome = await entry.prepareEntrySubmission({ executionId: execution.id, expectedVersion: 1, evaluatedAt: evaluatedAt() });
    expect(outcome).toMatchObject({ ok: false, reasonCode: "NATIVE_EXECUTION_DISABLED" });
    expect([...readOnly.calls, ...mutations.calls]).toEqual([]);
  });

  maybe()("28. a TradingView execution is not touched by the fence; a TradingView alert carrying the Native marker is refused as ambiguous", async () => {
    const profileId = await profile("tv");
    sequence += 1;
    const tv = await prisma!.alert.create({
      data: { symbol: `TVF${sequence}USDT`, assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 1, signal: "LONG", indicatorName: `${TAG}-tvf-${sequence}`, rawPayload: { note: TAG }, triggeredAt: ago(FRESH_MS) },
    });
    const clean = await executionRow({ executionProfileId: profileId, alertId: tv.id, symbol: tv.symbol, status: "PREFLIGHT" });
    const legacy = await executionRow({ executionProfileId: profileId, alertId: null, symbol: tv.symbol, status: "CANCELED" });
    const runtime = { evidence: null };
    expect(await nativeExecutionFence(prisma!, clean, runtime)).toEqual({ applies: false });
    expect(await nativeExecutionFence(prisma!, legacy, runtime)).toEqual({ applies: false });
    const tv2 = await prisma!.alert.create({
      data: { symbol: `TVG${sequence}USDT`, assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 1, signal: "LONG", indicatorName: `${TAG}-tvg-${sequence}`, rawPayload: { note: TAG }, triggeredAt: ago(FRESH_MS) },
    });
    const contradictory = await executionRow({ executionProfileId: profileId, alertId: tv2.id, symbol: tv2.symbol, status: "PREFLIGHT", marker: true });
    expect(await nativeExecutionFence(prisma!, contradictory, runtime)).toMatchObject({ applies: true, admitted: false, reasonCode: "NATIVE_SOURCE_AMBIGUOUS" });
  });

  maybe()("24. Phase 5 still applies to a Native row: a kill-switched profile is refused by SafetyAdmission without any exchange read", async () => {
    const profileId = await profile("phase5", "SAFE_OFF");
    const plan = await nativePlan();
    const execution = await executionRow({ executionProfileId: profileId, alertId: plan.alertId, symbol: plan.symbol, status: "PLAN_READY", marker: true });
    const readOnly = readOnlyTrap();
    const outcome = await new SafetyAdmissionService(prisma!, readOnly as never).evaluateAndReserveSafetyAdmission({ executionId: execution.id, expectedVersion: 1, evaluatedAt: new Date() });
    expect(outcome.decision).not.toBe("PASS");
    expect(readOnly.calls).toEqual([]);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
  });
});
