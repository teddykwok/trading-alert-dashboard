import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * MILESTONE 5 against REAL Postgres (the dedicated `_test` database): the
 * Native risk contract and Native Signal Freshness V1 at every durable
 * boundary, with EVERY private exchange adapter a trap that records and
 * throws, so "no private call" is measured, not assumed.
 *
 *  - adoption: a still-forming bar is deferred only while its signal is fresh;
 *    discovery is bounded by the Native lifetime; an expired signal is refused
 *    STALE, terminally, at the same expiry however late or often it is retried;
 *  - risk, past the hard switch (a TEST-ONLY module graph): an UNRESOLVED
 *    contract refuses at the decision, and at F0/F2 before any signed read or
 *    exposure-increasing call;
 *  - revalidation, Phase 5 and PREFLIGHT release judge a Native execution by
 *    its bar-anchored expiry and a TradingView one by its unchanged 300s rule.
 *
 * The live-entry gates are opened in THIS test process only, so that the
 * Native judgments (not a closed gate) are what refuse. Rows are synthetic,
 * tagged, and removed by the owning profiles' tag.
 */

process.env.EXECUTION_GLOBAL_KILL_SWITCH = "false";
process.env.EXECUTION_LIVE_ENTRY_ENABLED = "true";
process.env.EXECUTION_PROTECTION_READY = "true";
process.env.EXECUTION_MAX_ALERT_AGE_SECONDS = "300";
// A sanctioned testnet origin, so a TESTNET profile matches the connector. Nothing here reaches any network.
process.env.BINANCE_FUTURES_REST_BASE_URL = "https://demo-fapi.binance.com";

const TAG = "native-m5";
const SWITCH = "../src/modules/native-canary/native-execution-switch";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { NativeAccountAAdoptionService, NATIVE_ADOPTION_CLAIM_LEASE_MS } = await import("../src/modules/native-canary/native-account-a-adoption");
const { ExtremeRRService } = await import("../src/modules/extreme-rr/extreme-rr.service");
const { EntryLifecycleService } = await import("../src/modules/execution/entry-lifecycle.service");
const { SafetyAdmissionService } = await import("../src/modules/execution/safety-admission.service");
const fixtures = await import("./helpers/native-canary-fixtures");

const maybe = () => (available ? it : it.skip);
const S = 1000;
const MIN = 60 * S;
const TOUCH = fixtures.SOURCE_BAR + 61_234;
/** Every fixture alert's expiry: its bar's close + 5 minutes. */
const EXPIRY = fixtures.SOURCE_BAR_CLOSE + 5 * MIN;
const at = (ms: number) => new Date(ms);
const iso = (ms: number) => new Date(ms).toISOString();

let sequence = 0;

// ---------------------------------------------------------------------------
// Traps
// ---------------------------------------------------------------------------

function trap(name: string, allow: Record<string, unknown> = {}): { calls: string[] } & Record<string, unknown> {
  const calls: string[] = [];
  return new Proxy({ calls } as { calls: string[] } & Record<string, unknown>, {
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
const mutationTrap = () => trap("mutations", { blockedReason: null, mutationsDispatched: 0, isLiveMutationAllowed: true });
const readOnlyTrap = () => trap("readOnly");
/** A flat exchange for the PREFLIGHT release's flatness proof; records every read. */
function flatReadOnly() {
  const calls: string[] = [];
  return { calls, getPositionRisk: async () => (calls.push("getPositionRisk"), []), getOpenOrders: async () => (calls.push("getOpenOrders"), []) };
}
function executorTrap() {
  const handle = vi.fn(async () => {
    throw new Error("PRIVATE ADAPTER REACHED: executor.handleNativeAccountACandidate");
  });
  return { handleNativeAccountACandidate: handle, calls: () => handle.mock.calls.length };
}

// ---------------------------------------------------------------------------
// Synthetic rows
// ---------------------------------------------------------------------------

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

interface NativeFixture {
  alertId: string;
  planId: string;
  symbol: string;
  records: ReturnType<typeof fixtures.cleanRecords>;
  triggeredAt: Date;
}

/** A NATIVE alert exactly as the emitter writes it (trigger instant included), and its READY plan. */
async function nativePlan(options: { eventTimeMs?: number } = {}): Promise<NativeFixture> {
  sequence += 1;
  const symbol = `MFIVE${sequence}USDT`;
  const records = fixtures.cleanRecords({ symbol, eventTimeMs: options.eventTimeMs });
  const alert = fixtures.canaryAlert(records, { symbol });
  const triggeredAt = alert.triggeredAt!;
  const created = await prisma!.alert.create({
    data: {
      symbol,
      assetType: "CRYPTO",
      exchange: "BINANCE",
      timeframe: "15m",
      price: alert.price,
      signal: "LONG",
      indicatorName: `${TAG}-${sequence}`,
      source: "NATIVE",
      sourceTimeframe: alert.sourceTimeframe,
      rawPayload: alert.rawPayload as object,
      triggeredAt,
    },
  });
  const plan = await prisma!.extremeRRPlan.create({
    data: {
      alertId: created.id,
      status: "READY",
      direction: "LONG",
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
      candidates: fixtures.storedCandidates("LONG") as object,
      selectedLookback: 100,
      generatedAt: triggeredAt,
      executionFanoutReadyAt: null,
    },
  });
  return { alertId: created.id, planId: plan.id, symbol, records, triggeredAt };
}

/** A TradingView alert row (no Native payload). */
async function tradingViewAlert(triggeredAt: Date) {
  sequence += 1;
  return prisma!.alert.create({
    data: { symbol: `MFTV${sequence}USDT`, assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 1, signal: "LONG", indicatorName: `${TAG}-tv-${sequence}`, sourceTimeframe: "1D", rawPayload: { note: TAG }, triggeredAt },
  });
}

/**
 * A TradeExecution written DIRECTLY: no code path can create one for a NATIVE
 * alert while the switch is false. `admitted` adds the committed PASS
 * admission revalidation requires (PREFLIGHT at version 2, as admission leaves it).
 */
async function executionRow(options: {
  executionProfileId: string;
  alertId: string;
  symbol: string;
  status: "PLAN_READY" | "PREFLIGHT" | "ENTRY_SUBMITTING";
  signalTriggeredAt: Date;
  native: boolean;
  admitted?: boolean;
}) {
  const version = options.admitted ? 2 : 1;
  const row = await prisma!.tradeExecution.create({
    data: {
      executionProfileId: options.executionProfileId,
      alertId: options.alertId,
      symbol: options.symbol,
      direction: "LONG",
      positionSide: "LONG",
      selectedLookback: 100,
      status: options.status,
      version,
      signalTriggeredAt: options.signalTriggeredAt,
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
      // Inside the default safety policy's limits, so only the Native judgments decide.
      targetIsolatedMargin: "3",
      maximumIsolatedMargin: "4",
      selectedLeverage: 50,
      estimatedInitialMargin: "3.04",
      estimatedLiquidationPrice: "0.73",
      requiredLiquidationBoundary: "0.79",
      liquidationBufferRatio: "2",
      marginPlanSnapshot: { status: "READY", synthetic: TAG },
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
      metadata: { symbol: options.symbol, ...(options.native ? { alertSource: "NATIVE" } : {}) },
    },
  });
  if (options.admitted) {
    await prisma!.safetyAdmission.create({
      data: { tradeExecutionId: row.id, evaluatedVersion: 1, evaluatedAt: options.signalTriggeredAt, decision: "PASS", reasonCode: null, reservedRiskUsd: "1.5", reservedMarginUsd: "4" },
    });
  }
  return row;
}

function adoption(executionProfileId: string, executor: ReturnType<typeof executorTrap>, evidence: unknown, Service = NativeAccountAAdoptionService, plans: unknown = new ExtremeRRService(prisma!)) {
  return new Service({
    prisma: prisma!,
    boundProfile: boundProfileOf(executionProfileId),
    executor: executor as never,
    plans: plans as never,
    workerId: `m5-worker-${sequence}`,
    accountSlot: "ACCOUNT_A",
    accountPlanPolicy: fixtures.ACCOUNT_A_POLICY,
    fence: { evidence: evidence as never, accountSlot: "ACCOUNT_A" },
    environmentGates: fixtures.LIVE_READY_GATES,
  });
}

const eligible = (p: NativeFixture) => fixtures.readerOf(fixtures.eligibleEvidence(p.records, p.symbol));
const pending = (p: NativeFixture) => fixtures.readerOf(fixtures.evidenceOf(p.records.slice(0, 2), fixtures.SOURCE_BAR, p.symbol));
const adoptionsOf = (planId: string) => prisma!.selectedPlanAdoption.findMany({ where: { extremeRRPlanId: planId }, orderBy: { createdAt: "asc" } });

async function cleanup(): Promise<void> {
  if (!available) return;
  const profileIds = (await prisma!.executionProfile.findMany({ where: { accountIdentifier: { startsWith: TAG } }, select: { id: true } })).map((p) => p.id);
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
afterEach(async () => {
  vi.doUnmock(SWITCH);
  vi.doUnmock(fixtures.RISK_CONTRACT_MODULE);
  vi.resetModules();
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  await prisma?.$disconnect();
});

/** The production graph with the hard switch (and optionally the contracts) mutated, for tests past the switch. */
async function graph(options: { resolvedA?: boolean } = {}) {
  vi.resetModules();
  vi.doMock(SWITCH, () => ({ NATIVE_EXECUTION_ENABLED: true }));
  if (options.resolvedA) vi.doMock(fixtures.RISK_CONTRACT_MODULE, fixtures.resolvedAContracts);
  return {
    adoption: await import("../src/modules/native-canary/native-account-a-adoption"),
    entry: await import("../src/modules/execution/entry-lifecycle.service"),
  };
}

// ===========================================================================
// Adoption: freshness composes with PENDING_BAR_CLOSE
// ===========================================================================

describe("adoption: a forming bar waits only while its signal is fresh; an expired one is refused STALE, terminally", () => {
  maybe()("M. PENDING_BAR_CLOSE 10 minutes after the touch (twice the 300s rule) is deferred, not refused: nothing is written", async () => {
    const profileId = await armedProfile("pending");
    const plan = await nativePlan();
    const executor = executorTrap();
    expect(await adoption(profileId, executor, pending(plan)).runOnce(undefined, at(TOUCH + 10 * MIN))).toMatchObject({ discovered: 1, deferred: 1, claimed: 0, completed: 0 });
    expect(await adoptionsOf(plan.planId)).toHaveLength(0);
    expect(executor.calls()).toBe(0);
  });

  maybe()("N. PENDING -> ELIGIBLE immediately after the close: the next pass decides it, and only the hard switch refuses", async () => {
    const profileId = await armedProfile("pending-eligible");
    const plan = await nativePlan({ eventTimeMs: fixtures.SOURCE_BAR });
    expect(await adoption(profileId, executorTrap(), pending(plan)).runOnce(undefined, at(fixtures.SOURCE_BAR_CLOSE - 1))).toMatchObject({ deferred: 1 });
    const executor = executorTrap();
    expect(await adoption(profileId, executor, eligible(plan)).runOnce(undefined, at(fixtures.SOURCE_BAR_CLOSE + 1))).toMatchObject({ claimed: 1, completed: 1 });
    expect((await adoptionsOf(plan.planId))[0]).toMatchObject({ status: "COMPLETED", handled: false, reasonCode: "NATIVE_EXECUTION_DISABLED" });
    expect(executor.calls()).toBe(0);
  });

  maybe()("a bar that never became decidable within the window is NOT deferred past its expiry: it is refused STALE at FRESHNESS, once, and never offered again", async () => {
    const profileId = await armedProfile("pending-expired");
    const plan = await nativePlan();
    const executor = executorTrap();
    const service = adoption(profileId, executor, pending(plan));
    expect(await service.runOnce(undefined, at(EXPIRY + 1))).toMatchObject({ discovered: 1, deferred: 0, claimed: 1, completed: 1 });
    const [row] = await adoptionsOf(plan.planId);
    expect(row).toMatchObject({ status: "COMPLETED", handled: false, reasonCode: "NATIVE_SIGNAL_STALE", executionId: null });
    expect(row.message).toMatch(new RegExp(`^FRESHNESS: Native signal expired at ${iso(EXPIRY).replace(/\./g, "\\.")}`));
    expect(await service.runOnce(undefined, at(EXPIRY + 2 * MIN))).toMatchObject({ discovered: 0 });
    expect(executor.calls()).toBe(0);
  });

  maybe()("an ELIGIBLE signal discovered inside its 20-minute lifetime but after its bar's window is refused STALE; the executor is never entered", async () => {
    const profileId = await armedProfile("eligible-expired");
    const plan = await nativePlan();
    const executor = executorTrap();
    await adoption(profileId, executor, eligible(plan)).runOnce(undefined, at(EXPIRY + 1));
    expect((await adoptionsOf(plan.planId))[0]).toMatchObject({ reasonCode: "NATIVE_SIGNAL_STALE", handled: false });
    expect(executor.calls()).toBe(0);
    expect(await prisma!.tradeExecution.count({ where: { executionProfileId: profileId } })).toBe(0);
  });

  maybe()("discovery is bounded by the 20-minute Native lifetime, inclusively, not by 300 seconds", async () => {
    const plan = await nativePlan();
    const exactly = await armedProfile("lifetime-edge");
    // Exactly 20 minutes after the touch: still discovered (and refused STALE, its bar's window long closed).
    expect(await adoption(exactly, executorTrap(), eligible(plan)).runOnce(undefined, at(TOUCH + 20 * MIN))).toMatchObject({ discovered: 1, completed: 1 });
    const beyond = await armedProfile("lifetime-beyond");
    expect(await adoption(beyond, executorTrap(), eligible(plan)).runOnce(undefined, at(TOUCH + 20 * MIN + 1))).toMatchObject({ discovered: 0 });
    // And a touch only 299s old is offered while still forming (deferred), where 300s would have been the old limit.
    const young = await armedProfile("lifetime-young");
    expect(await adoption(young, executorTrap(), pending(plan)).runOnce(undefined, at(TOUCH + 299 * S))).toMatchObject({ discovered: 1, deferred: 1 });
  });

  maybe()("R. a crashed claim reclaimed later is judged against the SAME fixed expiry: a lease delay never extends the window", async () => {
    const early = await nativePlan();
    const profileA = await armedProfile("reclaim-fresh");
    // Crashed at the close; reclaimed one lease later (close + 121s): still inside close + 300s.
    await prisma!.selectedPlanAdoption.create({ data: { extremeRRPlanId: early.planId, executionProfileId: profileA, status: "PENDING", attempts: 1, claimedAt: at(fixtures.SOURCE_BAR_CLOSE), claimOwner: "crashed" } });
    expect(await adoption(profileA, executorTrap(), eligible(early)).runOnce(undefined, at(fixtures.SOURCE_BAR_CLOSE + NATIVE_ADOPTION_CLAIM_LEASE_MS + S))).toMatchObject({ claimed: 1, completed: 1 });
    expect((await adoptionsOf(early.planId))[0]).toMatchObject({ attempts: 2, reasonCode: "NATIVE_EXECUTION_DISABLED" });

    const late = await nativePlan();
    const profileB = await armedProfile("reclaim-stale");
    // Crashed at close + 200s (fresh then); reclaimed one lease later (close + 321s): the same expiry has passed.
    await prisma!.selectedPlanAdoption.create({ data: { extremeRRPlanId: late.planId, executionProfileId: profileB, status: "PENDING", attempts: 1, claimedAt: at(fixtures.SOURCE_BAR_CLOSE + 200 * S), claimOwner: "crashed" } });
    // (The pass also offers `early`, which profile B has never evaluated; only `late`'s reclaimed row matters here.)
    await adoption(profileB, executorTrap(), eligible(late)).runOnce(undefined, at(fixtures.SOURCE_BAR_CLOSE + 200 * S + NATIVE_ADOPTION_CLAIM_LEASE_MS + S));
    const [row] = await adoptionsOf(late.planId);
    expect(row).toMatchObject({ attempts: 2, reasonCode: "NATIVE_SIGNAL_STALE" });
    expect(row.message).toContain(`expired at ${iso(EXPIRY)}`);
  });
});

// ===========================================================================
// Risk, past the hard switch (TEST-ONLY module graph)
// ===========================================================================

describe("9-11. past the switch, an UNRESOLVED Native risk contract refuses before any private call", () => {
  maybe()("9. through the adoption: every other stage passes and the decision refuses at RISK; the executor is never entered and nothing is created", async () => {
    const g = await graph();
    const profileId = await armedProfile("risk-adoption");
    const plan = await nativePlan();
    const executor = executorTrap();
    expect(await adoption(profileId, executor, eligible(plan), g.adoption.NativeAccountAAdoptionService).runOnce(undefined, fixtures.FRESH_NOW)).toMatchObject({ claimed: 1, completed: 1 });
    const [row] = await adoptionsOf(plan.planId);
    expect(row).toMatchObject({ status: "COMPLETED", handled: false, reasonCode: "NATIVE_RISK_UNRESOLVED", executionId: null });
    expect(row.message).toMatch(/^RISK: Native risk for Account A is UNRESOLVED: No Native risk amount has been approved for Account A\./);
    expect(executor.calls()).toBe(0);
    expect(await prisma!.tradeExecution.count({ where: { executionProfileId: profileId } })).toBe(0);
  });

  maybe()("9/10/11. F0: a Native PREFLIGHT execution is refused NATIVE_RISK_UNRESOLVED before revalidation: zero signed reads, zero mutations, nothing reserved", async () => {
    const g = await graph();
    const profileId = await armedProfile("risk-f0");
    const plan = await nativePlan();
    const execution = await executionRow({ executionProfileId: profileId, alertId: plan.alertId, symbol: plan.symbol, status: "PREFLIGHT", signalTriggeredAt: plan.triggeredAt, native: true, admitted: true });
    const readOnly = readOnlyTrap();
    const mutations = mutationTrap();
    const entry = new g.entry.EntryLifecycleService(prisma!, readOnly as never, mutations as never, { nativeFence: { evidence: eligible(plan), accountSlot: "ACCOUNT_A" } });
    const outcome = await entry.prepareEntrySubmission({ executionId: execution.id, expectedVersion: 2, evaluatedAt: fixtures.FRESH_NOW });
    expect(outcome).toMatchObject({ ok: false, reasonCode: "NATIVE_RISK_UNRESOLVED", mutationsDispatched: 0, order: null });
    expect(readOnly.calls).toEqual([]);
    expect(mutations.calls).toEqual([]);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
    expect((await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } })).status).toBe("PREFLIGHT");
  });

  maybe()("10/11. F2: a reserved Native execution may still be reconciled (risk-reducing GET), but margin type, leverage and the LIMIT entry are refused NATIVE_RISK_UNRESOLVED: zero mutations", async () => {
    const g = await graph();
    const profileId = await armedProfile("risk-f2");
    const plan = await nativePlan();
    const execution = await executionRow({ executionProfileId: profileId, alertId: plan.alertId, symbol: plan.symbol, status: "ENTRY_SUBMITTING", signalTriggeredAt: plan.triggeredAt, native: true });
    await prisma!.binanceOrder.create({
      data: { tradeExecutionId: execution.id, role: "ENTRY", generation: 1, clientOrderId: `m5-${execution.id}`, side: "BUY", positionSide: "LONG", orderType: "LIMIT", timeInForce: "GTC", price: "0.8123", originalQuantity: "187", executedQuantity: "0", status: "SUBMITTING" },
    });
    const readOnly = readOnlyTrap();
    const mutations = mutationTrap();
    const entry = new g.entry.EntryLifecycleService(prisma!, readOnly as never, mutations as never, { nativeFence: { evidence: eligible(plan), accountSlot: "ACCOUNT_A" } });
    const outcome = await entry.resumeEntrySubmission({ executionId: execution.id, expectedVersion: 1, evaluatedAt: fixtures.FRESH_NOW });
    expect(outcome).toMatchObject({ ok: false, reasonCode: "NATIVE_RISK_UNRESOLVED", mutationsDispatched: 0 });
    expect(readOnly.calls).toEqual(["readOnly.queryOrderByClientOrderId"]);
    expect(mutations.calls).toEqual([]);
  });
});

// ===========================================================================
// Revalidation (past the switch, with a synthetic resolved contract)
// ===========================================================================

describe("revalidation: a Native execution is judged by its bar-anchored expiry, a TradingView one by 300 seconds, both before any signed read", () => {
  maybe()("Q. a stale Native signal is refused before revalidation's first signed read; an identical execution still fresh goes straight on to that read", async () => {
    const g = await graph({ resolvedA: true });
    const profileId = await armedProfile("revalidate-native");
    const run = async (evaluatedAt: Date) => {
      const plan = await nativePlan();
      const execution = await executionRow({ executionProfileId: profileId, alertId: plan.alertId, symbol: plan.symbol, status: "PREFLIGHT", signalTriggeredAt: plan.triggeredAt, native: true, admitted: true });
      const readOnly = readOnlyTrap();
      const mutations = mutationTrap();
      const entry = new g.entry.EntryLifecycleService(prisma!, readOnly as never, mutations as never, { nativeFence: { evidence: eligible(plan), accountSlot: "ACCOUNT_A" } });
      const outcome = await entry.prepareEntrySubmission({ executionId: execution.id, expectedVersion: 2, evaluatedAt });
      return { outcome, readOnly, mutations };
    };
    const stale = await run(at(EXPIRY + 1));
    expect(stale.outcome).toMatchObject({ ok: false, reasonCode: "SIGNAL_OR_ENTRY_DEADLINE_EXPIRED", mutationsDispatched: 0 });
    expect(stale.outcome.message).toContain(`Native signal expired at ${iso(EXPIRY)}`);
    expect(stale.readOnly.calls).toEqual([]);
    expect(stale.mutations.calls).toEqual([]);
    // 19 minutes after the touch, beyond 300s but inside the bar's window: freshness passes and the very next thing is the signed read.
    const fresh = await run(at(EXPIRY));
    expect(fresh.outcome).toMatchObject({ ok: false, reasonCode: "SYMBOL_STATE_CHANGED" });
    expect(fresh.readOnly.calls).toEqual(["readOnly.getAccountSummary"]);
    expect(fresh.mutations.calls).toEqual([]);
  });

  maybe()("O. TradingView revalidation is unchanged: 301s old is expired before any read, 299s old goes on to the signed read", async () => {
    const profileId = await armedProfile("revalidate-tv");
    const evaluatedAt = at(Date.now());
    const run = async (ageMs: number) => {
      const alert = await tradingViewAlert(at(evaluatedAt.getTime() - ageMs));
      const execution = await executionRow({ executionProfileId: profileId, alertId: alert.id, symbol: alert.symbol, status: "PREFLIGHT", signalTriggeredAt: alert.triggeredAt, native: false, admitted: true });
      const readOnly = readOnlyTrap();
      const entry = new EntryLifecycleService(prisma!, readOnly as never, mutationTrap() as never, { nativeFence: { evidence: null } });
      return { outcome: await entry.prepareEntrySubmission({ executionId: execution.id, expectedVersion: 2, evaluatedAt }), readOnly };
    };
    const old = await run(301 * S);
    expect(old.outcome).toMatchObject({ ok: false, reasonCode: "SIGNAL_OR_ENTRY_DEADLINE_EXPIRED", message: "Signal is 301s old." });
    expect(old.readOnly.calls).toEqual([]);
    const young = await run(299 * S);
    expect(young.outcome).toMatchObject({ ok: false, reasonCode: "SYMBOL_STATE_CHANGED" });
    expect(young.readOnly.calls).toEqual(["readOnly.getAccountSummary"]);
  });
});

// ===========================================================================
// Phase 5
// ===========================================================================

describe("Phase 5: a stale Native signal is refused terminally without an exchange read; TradingView keeps its rule", () => {
  maybe()("Q. stale Native: SKIP ALERT_STALE with zero exchange reads; the same execution fresh does read; R. a retry is judged against the same expiry", async () => {
    const service = (readOnly: unknown) => new SafetyAdmissionService(prisma!, readOnly as never);

    const stalePlan = await nativePlan();
    const staleRow = await executionRow({ executionProfileId: await armedProfile("phase5-stale"), alertId: stalePlan.alertId, symbol: stalePlan.symbol, status: "PLAN_READY", signalTriggeredAt: stalePlan.triggeredAt, native: true });
    const staleRead = readOnlyTrap();
    const stale = await service(staleRead).evaluateAndReserveSafetyAdmission({ executionId: staleRow.id, expectedVersion: 1, evaluatedAt: at(EXPIRY + 1) });
    expect(stale).toMatchObject({ decision: "SKIP", reasonCode: "ALERT_STALE" });
    expect(stale.result!.failedChecks.find((c) => c.reasonCode === "ALERT_STALE")!.message).toContain(`Native signal expired at ${iso(EXPIRY)}`);
    expect(staleRead.calls).toEqual([]);
    expect((await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: staleRow.id } })).status).toBe("SKIPPED");

    // An identical execution, fresh (and 19 minutes old): no freshness failure, and Phase 5 goes on to its read (a trap here, so UNAVAILABLE, retryable).
    const plan = await nativePlan();
    const freshRow = await executionRow({ executionProfileId: await armedProfile("phase5-fresh"), alertId: plan.alertId, symbol: plan.symbol, status: "PLAN_READY", signalTriggeredAt: plan.triggeredAt, native: true });
    const freshRead = readOnlyTrap();
    const fresh = await service(freshRead).evaluateAndReserveSafetyAdmission({ executionId: freshRow.id, expectedVersion: 1, evaluatedAt: at(EXPIRY) });
    expect(fresh.decision).toBe("UNAVAILABLE");
    expect(fresh.result!.failedChecks.map((c) => c.reasonCode)).not.toContain("ALERT_STALE");
    expect(fresh.result!.failedChecks.map((c) => c.reasonCode)).not.toContain("SIGNAL_TIME_UNAVAILABLE");
    expect(freshRead.calls).toContain("readOnly.getAccountSummary");

    // The retry of that UNAVAILABLE decision, a moment after the expiry: the same fixed expiry, now passed.
    const retryRead = readOnlyTrap();
    const retry = await service(retryRead).evaluateAndReserveSafetyAdmission({ executionId: freshRow.id, expectedVersion: 2, evaluatedAt: at(EXPIRY + 1) });
    expect(retry).toMatchObject({ decision: "SKIP", reasonCode: "ALERT_STALE" });
    expect(retry.result!.message).toContain(`Native signal expired at ${iso(EXPIRY)}`);
    expect(retryRead.calls).toEqual([]);
  });

  maybe()("unprovable Native evidence is SIGNAL_TIME_UNAVAILABLE (terminal), also without an exchange read", async () => {
    const profileId = await armedProfile("phase5-unprovable");
    const plan = await nativePlan();
    // The row's frozen signal time disagrees with its alert's own instant.
    const row = await executionRow({ executionProfileId: profileId, alertId: plan.alertId, symbol: plan.symbol, status: "PLAN_READY", signalTriggeredAt: at(plan.triggeredAt.getTime() + 1), native: true });
    const readOnly = readOnlyTrap();
    const outcome = await new SafetyAdmissionService(prisma!, readOnly as never).evaluateAndReserveSafetyAdmission({ executionId: row.id, expectedVersion: 1, evaluatedAt: fixtures.FRESH_NOW });
    expect(outcome).toMatchObject({ decision: "SKIP", reasonCode: "SIGNAL_TIME_UNAVAILABLE" });
    expect(readOnly.calls).toEqual([]);
  });

  maybe()("O. TradingView Phase 5 is unchanged: 301s old is ALERT_STALE and, exactly as before, the exchange state is still read", async () => {
    const profileId = await armedProfile("phase5-tv");
    const evaluatedAt = at(Date.now());
    const alert = await tradingViewAlert(at(evaluatedAt.getTime() - 301 * S));
    const row = await executionRow({ executionProfileId: profileId, alertId: alert.id, symbol: alert.symbol, status: "PLAN_READY", signalTriggeredAt: alert.triggeredAt, native: false });
    const readOnly = readOnlyTrap();
    const outcome = await new SafetyAdmissionService(prisma!, readOnly as never).evaluateAndReserveSafetyAdmission({ executionId: row.id, expectedVersion: 1, evaluatedAt });
    expect(outcome).toMatchObject({ decision: "SKIP", reasonCode: "ALERT_STALE" });
    expect(outcome.result!.signalAgeSeconds).toBe(301);
    expect(readOnly.calls).toContain("readOnly.getAccountSummary");
  });
});

// ===========================================================================
// PREFLIGHT release
// ===========================================================================

describe("PREFLIGHT release: only a PROVEN stale Native verdict terminalizes; TradingView keeps its rule", () => {
  async function release(row: { id: string; version: number }, evaluatedAt: Date) {
    const readOnly = flatReadOnly();
    const entry = new EntryLifecycleService(prisma!, readOnly as never, mutationTrap() as never, { nativeFence: { evidence: null } });
    const outcome = await entry.releaseUnrunnablePreflight({ executionId: row.id, expectedVersion: row.version, evaluatedAt });
    return { outcome, reads: readOnly.calls, status: (await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: row.id } })).status };
  }

  maybe()("a stale Native PREFLIGHT execution is SKIPPED with the Native expiry; a fresh one, and one whose evidence proves nothing, are left alone without an exchange read", async () => {
    const profileId = await armedProfile("release-native");
    const row = async (frozenOffsetMs = 0) => {
      const plan = await nativePlan();
      return executionRow({ executionProfileId: profileId, alertId: plan.alertId, symbol: plan.symbol, status: "PREFLIGHT", signalTriggeredAt: at(plan.triggeredAt.getTime() + frozenOffsetMs), native: true });
    };

    const fresh = await release(await row(), at(EXPIRY));
    expect(fresh).toMatchObject({ outcome: { ok: false, reasonCode: "SAFETY_ADMISSION_NOT_READY" }, reads: [], status: "PREFLIGHT" });

    const stale = await release(await row(), at(EXPIRY + 1));
    expect(stale.outcome).toMatchObject({ ok: true, reasonCode: "PREFLIGHT_SKIPPED_SIGNAL_EXPIRED" });
    expect(stale.outcome.message).toContain(`This execution can never be submitted: Native signal expired at ${iso(EXPIRY)}`);
    expect(stale.status).toBe("SKIPPED");
    // Terminalizing still requires the existing risk-reducing flatness proof.
    expect(stale.reads.sort()).toEqual(["getOpenOrders", "getPositionRisk"]);

    // Hours later, but the frozen time is not the alert's: nothing is proven, so nothing is terminalized.
    expect(await release(await row(-1), at(EXPIRY + 6 * 60 * MIN))).toMatchObject({ outcome: { ok: false, reasonCode: "SAFETY_ADMISSION_NOT_READY" }, reads: [], status: "PREFLIGHT" });
  });

  maybe()("O. a TradingView PREFLIGHT execution keeps the 300s rule: 301s old is SKIPPED, 299s old is left alone", async () => {
    const profileId = await armedProfile("release-tv");
    const evaluatedAt = at(Date.now());
    const old = await tradingViewAlert(at(evaluatedAt.getTime() - 301 * S));
    const oldRow = await executionRow({ executionProfileId: profileId, alertId: old.id, symbol: old.symbol, status: "PREFLIGHT", signalTriggeredAt: old.triggeredAt, native: false });
    const released = await release(oldRow, evaluatedAt);
    expect(released.outcome).toMatchObject({ ok: true, reasonCode: "PREFLIGHT_SKIPPED_SIGNAL_EXPIRED" });
    expect(released.outcome.message).toContain("the signal is 301s old, beyond the 300s limit");
    const young = await tradingViewAlert(at(evaluatedAt.getTime() - 299 * S));
    const youngRow = await executionRow({ executionProfileId: profileId, alertId: young.id, symbol: young.symbol, status: "PREFLIGHT", signalTriggeredAt: young.triggeredAt, native: false });
    expect(await release(youngRow, evaluatedAt)).toMatchObject({ outcome: { ok: false, reasonCode: "SAFETY_ADMISSION_NOT_READY" }, status: "PREFLIGHT" });
  });
});
