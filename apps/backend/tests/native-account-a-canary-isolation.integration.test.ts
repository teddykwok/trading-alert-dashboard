import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createHmac } from "node:crypto";

import { connectTestDatabase } from "./helpers/test-database";
import { testProfileProjection } from "./helpers/bound-runtime";

/**
 * PRE-MERGE AUDIT, QUESTION 2: can a Native candidate make the system contact
 * private Binance while NATIVE_EXECUTION_ENABLED is false?
 *
 * Everything is the PRODUCTION composition: real Binance read-only and
 * execution clients (real signing, real endpoint tables, real request
 * building), the real margin planner, executor, ExecutionService, Phase 5
 * SafetyAdmission, entry and protection lifecycles and orchestrator. The
 * clients hold SENTINEL credentials. Only the network is replaced, and every
 * layer that could contact Binance is counted at its lowest point:
 *
 *   - signature generation: every `createHmac` call (signQuery is the only
 *     signer in the codebase, and it keys the HMAC with the API secret);
 *   - credential use and private reads: every request, with whether it was
 *     signed and whether it carried the X-MBX-APIKEY header;
 *   - private mutations: the execution client's transport, which every POST
 *     and DELETE goes through.
 *
 * CASE A, a FRESH candidate (no reservation, no order, no exposure), must
 * produce zero of everything, and must leave nothing durable for recovery to
 * act on later.
 *
 * CASE B, a HISTORICAL durably-reserved Native execution (a row only a
 * previously enabled state could have created; written here directly), may
 * still make the risk-reducing reconcile READ the existing recovery invariant
 * requires, and nothing exposure-increasing.
 *
 * Rows go to the dedicated `_test` database only, owned by tagged profiles.
 */

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const spy = vi.fn((...args: Parameters<typeof actual.createHmac>) => actual.createHmac(...args));
  return { ...actual, default: { ...actual, createHmac: spy }, createHmac: spy };
});

// The live-entry gates are opened in THIS test process only, so that the
// Native fence (not a closed gate) is what has to refuse. The real .env is
// never read or written, and the network below is a trap.
process.env.EXECUTION_GLOBAL_KILL_SWITCH = "false";
process.env.EXECUTION_LIVE_ENTRY_ENABLED = "true";
process.env.EXECUTION_PROTECTION_READY = "true";

const TAG = "native-canary-iso";
const SENTINEL_KEY = "sentinel-api-key-must-never-be-sent";
const SENTINEL_SECRET = "sentinel-api-secret-must-never-sign";
const BASE_URL = "https://binance.invalid";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { NativeAccountAAdoptionService } = await import("../src/modules/native-canary/native-account-a-adoption");
const { BinanceReadOnlyClient } = await import("../src/modules/binance/binance.client");
const { BinanceReadOnlyService } = await import("../src/modules/binance/binance-read-only.service");
const { BinanceUsdMExecutionClient } = await import("../src/modules/binance/binance-execution.client");
const { BinanceMarginPlanService } = await import("../src/modules/binance/binance-margin-plan.service");
const { SelectedPlanExecutor } = await import("../src/modules/execution/selected-plan-executor");
const { ExecutionService } = await import("../src/modules/execution/execution.service");
const { SafetyAdmissionService } = await import("../src/modules/execution/safety-admission.service");
const { EntryLifecycleService } = await import("../src/modules/execution/entry-lifecycle.service");
const { ProtectionLifecycleService } = await import("../src/modules/execution/protection-lifecycle.service");
const { CriticalAlertService } = await import("../src/modules/execution/critical-alert.service");
const { ExecutionOrchestrator } = await import("../src/modules/execution/execution-orchestrator");
const { ExtremeRRService } = await import("../src/modules/extreme-rr/extreme-rr.service");
const { buildClientOrderId } = await import("../src/modules/execution/execution-safety");
const fixtures = await import("./helpers/native-canary-fixtures");

const maybe = () => (available ? it : it.skip);
let sequence = 0;

// ---------------------------------------------------------------------------
// The network trap
// ---------------------------------------------------------------------------

interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly signed: boolean;
  readonly apiKey: boolean;
  readonly query: URLSearchParams;
}
const seen: SeenRequest[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchTrap = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = (init?.headers ?? {}) as Record<string, string>;
  seen.push({ method: init?.method ?? "GET", path: url.pathname, signed: url.searchParams.has("signature"), apiKey: "X-MBX-APIKEY" in headers, query: url.searchParams });
  if (url.pathname === "/fapi/v1/time") return json(200, { serverTime: Date.now() });
  return json(400, { code: -2013, msg: "Order does not exist." });
});

beforeEach(() => {
  seen.length = 0;
  fetchTrap.mockClear();
  vi.mocked(createHmac).mockClear();
  vi.stubGlobal("fetch", fetchTrap);
});
afterEach(() => vi.unstubAllGlobals());

/** Every production class the composition below is built from. */
const PRODUCTION_GRAPH = {
  NativeAccountAAdoptionService,
  BinanceReadOnlyClient,
  BinanceReadOnlyService,
  BinanceUsdMExecutionClient,
  BinanceMarginPlanService,
  SelectedPlanExecutor,
  ExecutionService,
  SafetyAdmissionService,
  EntryLifecycleService,
  ProtectionLifecycleService,
  CriticalAlertService,
  ExecutionOrchestrator,
  ExtremeRRService,
};
type ProductionGraph = typeof PRODUCTION_GRAPH;

const SWITCH = "../src/modules/native-canary/native-execution-switch";

/**
 * M5: the SAME production graph, re-imported with the hard switch mutated to
 * true (and, optionally, a synthetic resolved Account A risk contract) in a
 * TEST-ONLY module graph. The production constants are untouched.
 */
async function enabledProductionGraph(options: { resolvedA?: boolean } = {}): Promise<ProductionGraph> {
  vi.resetModules();
  vi.doMock(SWITCH, () => ({ NATIVE_EXECUTION_ENABLED: true }));
  if (options.resolvedA) vi.doMock(fixtures.RISK_CONTRACT_MODULE, fixtures.resolvedAContracts);
  return {
    NativeAccountAAdoptionService: (await import("../src/modules/native-canary/native-account-a-adoption")).NativeAccountAAdoptionService,
    BinanceReadOnlyClient: (await import("../src/modules/binance/binance.client")).BinanceReadOnlyClient,
    BinanceReadOnlyService: (await import("../src/modules/binance/binance-read-only.service")).BinanceReadOnlyService,
    BinanceUsdMExecutionClient: (await import("../src/modules/binance/binance-execution.client")).BinanceUsdMExecutionClient,
    BinanceMarginPlanService: (await import("../src/modules/binance/binance-margin-plan.service")).BinanceMarginPlanService,
    SelectedPlanExecutor: (await import("../src/modules/execution/selected-plan-executor")).SelectedPlanExecutor,
    ExecutionService: (await import("../src/modules/execution/execution.service")).ExecutionService,
    SafetyAdmissionService: (await import("../src/modules/execution/safety-admission.service")).SafetyAdmissionService,
    EntryLifecycleService: (await import("../src/modules/execution/entry-lifecycle.service")).EntryLifecycleService,
    ProtectionLifecycleService: (await import("../src/modules/execution/protection-lifecycle.service")).ProtectionLifecycleService,
    CriticalAlertService: (await import("../src/modules/execution/critical-alert.service")).CriticalAlertService,
    ExecutionOrchestrator: (await import("../src/modules/execution/execution-orchestrator")).ExecutionOrchestrator,
    ExtremeRRService: (await import("../src/modules/extreme-rr/extreme-rr.service")).ExtremeRRService,
  };
}

/** The production runtime, composed exactly as the account worker composes it, on sentinel credentials. */
function productionRuntime(executionProfileId: string, evidence: ReturnType<typeof fixtures.readerOf>, graph: ProductionGraph = PRODUCTION_GRAPH) {
  const {
    BinanceReadOnlyClient,
    BinanceReadOnlyService,
    BinanceUsdMExecutionClient,
    BinanceMarginPlanService,
    SelectedPlanExecutor,
    ExecutionService,
    SafetyAdmissionService,
    EntryLifecycleService,
    ProtectionLifecycleService,
    CriticalAlertService,
    ExecutionOrchestrator,
  } = graph;
  const readOnlyClient = new BinanceReadOnlyClient({ baseUrl: BASE_URL, apiKey: SENTINEL_KEY, apiSecret: SENTINEL_SECRET, enabled: true });
  const readOnly = new BinanceReadOnlyService(readOnlyClient);
  const transport = vi.fn(async () => {
    throw new Error("PRIVATE MUTATION TRANSPORT REACHED");
  });
  const mutations = new BinanceUsdMExecutionClient({
    readOnlyClient,
    baseUrl: BASE_URL,
    apiKey: SENTINEL_KEY,
    apiSecret: SENTINEL_SECRET,
    liveEntryEnabled: true,
    protectionReady: true,
    transport,
  });
  const boundProfile = testProfileProjection({ executionProfileId });
  const entry = new EntryLifecycleService(prisma!, readOnly, mutations, { reconcileMaxAttempts: 1, reconcileDelayMs: 1, nativeFence: { evidence, accountSlot: "ACCOUNT_A" } });
  const orchestrator = new ExecutionOrchestrator({
    prisma: prisma!,
    readOnly,
    admission: new SafetyAdmissionService(prisma!, readOnly),
    entry,
    protection: new ProtectionLifecycleService(prisma!, readOnly, mutations, new CriticalAlertService(prisma!, async () => false), { reconcileMaxAttempts: 1 }),
    boundProfile,
  });
  const executor = new SelectedPlanExecutor({
    prisma: prisma!,
    marginPlanner: new BinanceMarginPlanService(readOnly),
    executions: new ExecutionService(prisma!),
    orchestrator,
    boundProfile,
    nativeFence: { evidence, accountSlot: "ACCOUNT_A" },
  });
  return { readOnly, mutations, transport, entry, orchestrator, executor, boundProfile };
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

async function nativePlan() {
  sequence += 1;
  const symbol = `ISO${sequence}USDT`;
  const records = fixtures.cleanRecords({ symbol });
  const alert = fixtures.canaryAlert(records, { symbol });
  // The payload's own trigger instant: fresh at fixtures.FRESH_NOW, the clock CASE A runs on.
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
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma?.$disconnect();
});

describe("Q2. a disabled Native candidate never creates a reason to contact private Binance", () => {
  maybe()("CASE A: a FRESH candidate through the full production composition: 0 signatures, 0 credential use, 0 private reads, 0 mutations, and nothing durable left for recovery", async () => {
    const profileId = await armedProfile("fresh");
    const plan = await nativePlan();
    const evidence = fixtures.readerOf(fixtures.eligibleEvidence(plan.records, plan.symbol));
    const runtime = productionRuntime(profileId, evidence);
    const entryPoint = vi.spyOn(runtime.executor, "handleNativeAccountACandidate");
    const adoption = new NativeAccountAAdoptionService({
      prisma: prisma!,
      boundProfile: runtime.boundProfile,
      executor: runtime.executor,
      plans: new ExtremeRRService(prisma!),
      workerId: "account-a-worker",
      accountSlot: "ACCOUNT_A",
      accountPlanPolicy: fixtures.ACCOUNT_A_POLICY,
      fence: { evidence, accountSlot: "ACCOUNT_A" },
      environmentGates: fixtures.LIVE_READY_GATES,
    });

    expect(await adoption.runOnce(undefined, fixtures.FRESH_NOW)).toMatchObject({ discovered: 1, claimed: 1, completed: 1 });
    expect(await prisma!.selectedPlanAdoption.findFirstOrThrow({ where: { extremeRRPlanId: plan.planId } })).toMatchObject({ handled: false, reasonCode: "NATIVE_EXECUTION_DISABLED" });

    // The executor (holder of the signed planner and the orchestrator) was never entered.
    expect(entryPoint).not.toHaveBeenCalled();
    expect(vi.mocked(createHmac)).not.toHaveBeenCalled(); // signed request generation: 0, secret never used
    expect(seen).toEqual([]); // no request of ANY kind: key never sent, no private read
    expect(runtime.transport).not.toHaveBeenCalled(); // private mutations: 0
    expect(runtime.mutations.mutationsDispatched).toBe(0);

    // Nothing durable that recovery could later act on.
    expect(await prisma!.tradeExecution.count({ where: { executionProfileId: profileId } })).toBe(0);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecution: { executionProfileId: profileId } } })).toBe(0);
    expect(await prisma!.selectedPlanAdoption.count({ where: { executionProfileId: profileId, status: "PENDING" } })).toBe(0);
    // And the real reconciler, over this profile, finds nothing and sends nothing.
    const tick = await runtime.orchestrator.runExecutionReconciliationTick({ evaluatedAt: new Date() });
    expect(tick.inspected).toBe(0);
    expect(vi.mocked(createHmac)).not.toHaveBeenCalled();
    expect(seen).toEqual([]);

    // Handed a forged capability directly, the executor refuses before touching anything.
    entryPoint.mockRestore();
    const forged = Object.freeze({ kind: "NATIVE_ACCOUNT_A_HANDOFF", executionProfileId: profileId, alertId: plan.alertId, planId: plan.planId, symbol: plan.symbol, direction: "LONG", lookback: 100, integrity: "ELIGIBLE" });
    expect(await runtime.executor.handleNativeAccountACandidate(forged as never, fixtures.FRESH_NOW)).toMatchObject({ handled: false, reasonCode: "HANDOFF_INVALID" });
    expect(vi.mocked(createHmac)).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    expect(runtime.transport).not.toHaveBeenCalled();
  });

  maybe()("CASE B: a HISTORICAL durably-reserved Native execution: exactly ONE signed read (its own order, by its deterministic client id) remains reachable; configuration and submission are refused; 0 mutations", async () => {
    const profileId = await armedProfile("historical");
    const plan = await nativePlan();
    const evidence = fixtures.readerOf(fixtures.eligibleEvidence(plan.records, plan.symbol));
    const runtime = productionRuntime(profileId, evidence);
    // Only a previously ENABLED state could have created these rows; they are written directly.
    const execution = await prisma!.tradeExecution.create({
      data: {
        executionProfileId: profileId,
        alertId: plan.alertId,
        symbol: plan.symbol,
        direction: "LONG",
        positionSide: "LONG",
        selectedLookback: 100,
        status: "ENTRY_SUBMITTING",
        version: 1,
        signalTriggeredAt: plan.triggeredAt,
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
      data: { tradeExecutionId: execution.id, sequenceNumber: 1, eventType: "EXECUTION_CREATED", toStatus: "PLAN_READY", reasonCode: "PLAN_READY", message: "synthetic", metadata: { alertSource: "NATIVE" } },
    });
    const clientOrderId = buildClientOrderId(execution.id, "ENTRY", 1);
    await prisma!.binanceOrder.create({
      data: { tradeExecutionId: execution.id, role: "ENTRY", generation: 1, clientOrderId, side: "BUY", positionSide: "LONG", orderType: "LIMIT", timeInForce: "GTC", price: "0.8123", originalQuantity: "187", executedQuantity: "0", status: "SUBMITTING" },
    });

    const outcome = await runtime.entry.resumeEntrySubmission({ executionId: execution.id, expectedVersion: 1, evaluatedAt: new Date() });
    expect(outcome).toMatchObject({ ok: false, reasonCode: "NATIVE_EXECUTION_DISABLED", mutationsDispatched: 0 });

    // Exactly: one public clock sync, then ONE signed GET of THIS execution's own order.
    expect(seen.map((r) => [r.method, r.path, r.signed, r.apiKey])).toEqual([
      ["GET", "/fapi/v1/time", false, false],
      ["GET", "/fapi/v1/order", true, true],
    ]);
    expect(seen[1].query.get("origClientOrderId")).toBe(clientOrderId);
    expect(seen[1].query.get("symbol")).toBe(plan.symbol);
    expect(vi.mocked(createHmac)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createHmac).mock.calls[0]).toEqual(["sha256", SENTINEL_SECRET]);
    // Nothing exposure-increasing: no transport call, no marginType/leverage/order POST.
    expect(runtime.transport).not.toHaveBeenCalled();
    expect(runtime.mutations.mutationsDispatched).toBe(0);
    const order = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: execution.id } });
    expect([order.submittedAt, order.submissionUnknownAt, order.status]).toEqual([null, null, "SUBMITTING"]);
  });
});

// ===========================================================================
// M5: the Native risk contract, past the hard switch, on the same real stack
// ===========================================================================

describe("M5. past the hard switch (TEST-ONLY graph), an UNRESOLVED Native risk contract keeps the production composition silent", () => {
  afterEach(() => {
    vi.doUnmock(SWITCH);
    vi.doUnmock(fixtures.RISK_CONTRACT_MODULE);
    vi.resetModules();
  });

  maybe()("CASE C: a fresh candidate is refused at RISK and a historical Native PREFLIGHT execution at F0: 0 signatures, 0 credential use, 0 requests, 0 mutations", async () => {
    const graph = await enabledProductionGraph();
    const profileId = await armedProfile("risk-unresolved");
    const plan = await nativePlan();
    const evidence = fixtures.readerOf(fixtures.eligibleEvidence(plan.records, plan.symbol));
    const runtime = productionRuntime(profileId, evidence, graph);
    const entryPoint = vi.spyOn(runtime.executor, "handleNativeAccountACandidate");
    const adoption = new graph.NativeAccountAAdoptionService({
      prisma: prisma!,
      boundProfile: runtime.boundProfile,
      executor: runtime.executor,
      plans: new graph.ExtremeRRService(prisma!),
      workerId: "account-a-worker",
      accountSlot: "ACCOUNT_A",
      accountPlanPolicy: fixtures.ACCOUNT_A_POLICY,
      fence: { evidence, accountSlot: "ACCOUNT_A" },
      environmentGates: fixtures.LIVE_READY_GATES,
    });

    expect(await adoption.runOnce(undefined, fixtures.FRESH_NOW)).toMatchObject({ discovered: 1, claimed: 1, completed: 1 });
    expect(await prisma!.selectedPlanAdoption.findFirstOrThrow({ where: { extremeRRPlanId: plan.planId } })).toMatchObject({ handled: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
    expect(entryPoint).not.toHaveBeenCalled();

    // A Native PREFLIGHT execution only an enabled AND risk-resolved past could have created, written directly.
    const execution = await prisma!.tradeExecution.create({
      data: {
        executionProfileId: profileId,
        alertId: plan.alertId,
        symbol: plan.symbol,
        direction: "LONG",
        positionSide: "LONG",
        selectedLookback: 100,
        status: "PREFLIGHT",
        version: 2,
        signalTriggeredAt: plan.triggeredAt,
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
      data: { tradeExecutionId: execution.id, sequenceNumber: 1, eventType: "EXECUTION_CREATED", toStatus: "PLAN_READY", reasonCode: "PLAN_READY", message: "synthetic", metadata: { alertSource: "NATIVE" } },
    });
    const outcome = await runtime.entry.prepareEntrySubmission({ executionId: execution.id, expectedVersion: 2, evaluatedAt: fixtures.FRESH_NOW });
    expect(outcome).toMatchObject({ ok: false, reasonCode: "NATIVE_RISK_UNRESOLVED", mutationsDispatched: 0, order: null });

    expect(vi.mocked(createHmac)).not.toHaveBeenCalled(); // no signature, the secret never used
    expect(seen).toEqual([]); // no request of any kind: no key sent, no private read
    expect(runtime.transport).not.toHaveBeenCalled(); // no mutation
    expect(runtime.mutations.mutationsDispatched).toBe(0);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
    expect(await prisma!.tradeExecution.count({ where: { executionProfileId: profileId } })).toBe(1);
  });

  maybe()("CASE D (the trap is live): with a SYNTHETIC resolved contract the same fresh candidate does reach the margin planner and the exchange, so the silence above is the risk gate's doing", async () => {
    const graph = await enabledProductionGraph({ resolvedA: true });
    const profileId = await armedProfile("risk-resolved-synthetic");
    const plan = await nativePlan();
    const evidence = fixtures.readerOf(fixtures.eligibleEvidence(plan.records, plan.symbol));
    const runtime = productionRuntime(profileId, evidence, graph);
    const entryPoint = vi.spyOn(runtime.executor, "handleNativeAccountACandidate");
    const adoption = new graph.NativeAccountAAdoptionService({
      prisma: prisma!,
      boundProfile: runtime.boundProfile,
      executor: runtime.executor,
      plans: new graph.ExtremeRRService(prisma!),
      workerId: "account-a-worker",
      accountSlot: "ACCOUNT_A",
      accountPlanPolicy: fixtures.ACCOUNT_A_POLICY,
      fence: { evidence, accountSlot: "ACCOUNT_A" },
      environmentGates: fixtures.LIVE_READY_GATES,
    });
    await adoption.runOnce(undefined, fixtures.FRESH_NOW);
    expect(entryPoint).toHaveBeenCalledTimes(1);
    // The planner went to the exchange at once, and the trap recorded it. The stub
    // answers its first (public) metadata read with an error, so planning stops
    // there, before its signed reads (CASE B proves a signature IS counted when
    // one happens). Nothing was ever mutated, and nothing was created.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.method === "GET")).toBe(true);
    expect(runtime.transport).not.toHaveBeenCalled();
    expect(runtime.mutations.mutationsDispatched).toBe(0);
    expect(await prisma!.tradeExecution.count({ where: { executionProfileId: profileId } })).toBe(0);
  });
});
