import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { tmpdir } from "node:os";

import { connectTestDatabase } from "./helpers/test-database";
import { testProfileProjection } from "./helpers/bound-runtime";

/**
 * MILESTONE 6: NATIVE_DRY_ADMISSION_V1 against the REAL stack, on the
 * dedicated `_test` database only.
 *
 *  - TRAPS (sections 14/15): every signature (`createHmac`, the only signer),
 *    every network request (`fetch`), every call into the exchange adapters
 *    (read-only client, execution client, account-setup client), every
 *    file-system call, every queue and Redis construction, and a digest of
 *    EVERY table in the `_test` schema (row count and content hash, so an
 *    UPDATE is caught as well as an INSERT or DELETE). Each trap is shown to
 *    fire on a real call first, so a zero below means something.
 *  - AUTHORITY (section 13): the real executor, the real execution creation
 *    and the real adoption pass, handed every form of a dry result.
 *  - PARITY (section 17): the real adoption pass over seeded rows, against
 *    the dry admission over a snapshot read from the same rows.
 *  - KERNELS (section 6): the Phase 5 authorization and session functions,
 *    which read rows, against the pure judgments the dry admission asks.
 *
 * Rows are owned by `native-m6` tagged profiles and removed afterwards.
 */

const traps = vi.hoisted(() => ({ hmac: 0, fs: [] as string[], queue: 0, redis: 0 }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const createHmac = ((...args: Parameters<typeof actual.createHmac>) => {
    traps.hmac += 1;
    return actual.createHmac(...args);
  }) as typeof actual.createHmac;
  return { ...actual, default: { ...actual, createHmac }, createHmac };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const counted: Record<string, unknown> = {};
  for (const name of Object.keys(actual)) {
    const real = (actual as Record<string, unknown>)[name];
    if (typeof real !== "function" || /^[A-Z]/.test(name)) continue;
    counted[name] = (...args: unknown[]) => {
      traps.fs.push(name);
      return (real as (...a: unknown[]) => unknown)(...args);
    };
  }
  return { ...actual, ...counted, default: { ...actual, ...counted } };
});

vi.mock("bullmq", () => {
  class CountingQueue {
    constructor() {
      traps.queue += 1;
    }
    add() {
      traps.queue += 1;
      return Promise.resolve(undefined);
    }
    on() {
      return this;
    }
    close() {
      return Promise.resolve();
    }
  }
  return { Queue: CountingQueue, Worker: CountingQueue, QueueEvents: CountingQueue, FlowProducer: CountingQueue };
});

vi.mock("ioredis", () => {
  class CountingRedis {
    constructor() {
      traps.redis += 1;
    }
    duplicate() {
      return new CountingRedis();
    }
    on() {
      return this;
    }
    disconnect() {}
    quit() {
      return Promise.resolve();
    }
  }
  return { default: CountingRedis, Redis: CountingRedis };
});

const TAG = "native-m6";
const SENTINEL_KEY = "sentinel-api-key-must-never-be-sent";
const SENTINEL_SECRET = "sentinel-api-secret-must-never-sign";
const BASE_URL = "https://binance.invalid";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { evaluateNativeDryAdmission } = await import("../src/modules/native-canary/native-dry-admission");
const canary = await import("../src/modules/native-canary/native-account-a-canary");
const { NativeAccountAAdoptionService } = await import("../src/modules/native-canary/native-account-a-adoption");
const { loadNativeOccupancyRows } = await import("../src/modules/native-canary/native-occupancy");
const { ExtremeRRService } = await import("../src/modules/extreme-rr/extreme-rr.service");
const { ExecutionService } = await import("../src/modules/execution/execution.service");
const { SelectedPlanExecutor } = await import("../src/modules/execution/selected-plan-executor");
const { resolveAdmissionAuthorization } = await import("../src/modules/execution/safety-admission.service");
const { reserveSessionSlot } = await import("../src/modules/execution/trading-session.service");
const { judgeAdmissionAuthorization } = await import("../src/modules/execution/natural-authorization");
const { judgeSessionReservation } = await import("../src/modules/execution/trading-session");
const { NativeAlertExecutionForbiddenError } = await import("../src/modules/alerts/alert-source");
const { BinanceReadOnlyClient } = await import("../src/modules/binance/binance.client");
const { BinanceReadOnlyService } = await import("../src/modules/binance/binance-read-only.service");
const { BinanceUsdMExecutionClient } = await import("../src/modules/binance/binance-execution.client");
const { BinanceAccountSetupClient } = await import("../src/modules/binance/binance-account-setup.client");
const { fileSystemNativeScannerEvidence, nativeExecutionProvenanceOf } = await import("../src/modules/native-integrity/native-execution-integrity");
const fixtures = await import("./helpers/native-canary-fixtures");
const { bar } = await import("./helpers/native-alert-fixtures");

type Snapshot = Parameters<typeof evaluateNativeDryAdmission>[0];
type DryResult = ReturnType<typeof evaluateNativeDryAdmission>;

const maybe = () => (available ? it : it.skip);
const NOW = fixtures.FRESH_NOW;
let sequence = 0;

// ---------------------------------------------------------------------------
// Network and exchange-adapter traps
// ---------------------------------------------------------------------------

interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly signed: boolean;
  readonly apiKey: boolean;
}
const seen: SeenRequest[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchTrap = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = (init?.headers ?? {}) as Record<string, string>;
  seen.push({ method: init?.method ?? "GET", path: url.pathname, signed: url.searchParams.has("signature"), apiKey: "X-MBX-APIKEY" in headers });
  if (url.pathname === "/fapi/v1/time") return json(200, { serverTime: Date.now() });
  return json(400, { code: -2015, msg: "Invalid API-key, IP, or permissions for action." });
});

/** Every method of every exchange adapter, spied. A call to any of them is an exchange call. */
const ADAPTERS = { BinanceReadOnlyClient, BinanceReadOnlyService, BinanceUsdMExecutionClient, BinanceAccountSetupClient } as Record<string, { prototype: object }>;
function spyOnAdapters(): () => string[] {
  const calls: string[] = [];
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    for (const method of Object.getOwnPropertyNames(adapter.prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(adapter.prototype, method);
      if (method === "constructor" || typeof descriptor?.value !== "function") continue;
      const original = descriptor.value as (...args: unknown[]) => unknown;
      vi.spyOn(adapter.prototype as Record<string, (...args: unknown[]) => unknown>, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
        calls.push(`${name}.${method}`);
        return original.apply(this, args);
      });
    }
  }
  return () => [...calls];
}

beforeEach(() => {
  seen.length = 0;
  fetchTrap.mockClear();
  vi.stubGlobal("fetch", fetchTrap);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The `_test` database digest: every table, row count and content hash
// ---------------------------------------------------------------------------

async function databaseDigest(): Promise<Record<string, { rows: number; hash: string | null }>> {
  const tables = await prisma!.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations' ORDER BY tablename`;
  const out: Record<string, { rows: number; hash: string | null }> = {};
  for (const { tablename } of tables) {
    const quoted = `"${tablename.replace(/"/g, '""')}"`;
    const [row] = await prisma!.$queryRawUnsafe<{ rows: number; hash: string | null }[]>(`SELECT count(*)::int AS rows, md5(string_agg(t::text, '|' ORDER BY t::text)) AS hash FROM ${quoted} t`);
    out[tablename] = row;
  }
  return out;
}

/** Lets anything fire-and-forget (a write, a request, a timer) settle before the traps are read. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

// ---------------------------------------------------------------------------
// Synthetic `_test` rows
// ---------------------------------------------------------------------------

async function armedProfile(alias: string): Promise<string> {
  sequence += 1;
  const created = await prisma!.executionProfile.create({
    data: {
      name: `${TAG} ${alias} ${sequence}`,
      accountIdentifier: `${TAG}-${alias}-${sequence}`,
      environment: "TESTNET",
      isEnabled: true,
      safetyPolicy: { create: { killSwitchActive: false } },
    },
  });
  return created.id;
}

interface SeedOptions {
  sourceTf?: "1D" | "1W";
  signal?: "LONG" | "SHORT";
  selectedLookback?: number;
}

async function nativePlan(options: SeedOptions = {}) {
  sequence += 1;
  const symbol = `M6N${sequence}USDT`;
  const signal = options.signal ?? "LONG";
  const records = fixtures.cleanRecords({ symbol, sourceTf: options.sourceTf ?? "1D", signal });
  const alert = fixtures.canaryAlert(records, { symbol, sourceTf: options.sourceTf ?? "1D", signal });
  const triggeredAt = alert.triggeredAt!;
  const created = await prisma!.alert.create({
    data: {
      symbol,
      assetType: "CRYPTO",
      exchange: "BINANCE",
      timeframe: "15m",
      price: alert.price,
      signal,
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
      direction: signal,
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
      candidates: fixtures.storedCandidates(signal) as object,
      selectedLookback: options.selectedLookback ?? 100,
      generatedAt: triggeredAt,
      executionFanoutReadyAt: null,
    },
  });
  return { alertId: created.id, planId: plan.id, symbol, records, triggeredAt };
}

/** A same-symbol, same-side pending LIMIT for the occupancy case (only an enabled state could create one; written directly). */
async function pendingLimit(profileId: string, symbol: string) {
  return prisma!.tradeExecution.create({
    data: {
      executionProfileId: profileId,
      alertId: null,
      symbol,
      direction: "LONG",
      positionSide: "LONG",
      selectedLookback: 100,
      status: "ENTRY_PENDING",
      version: 1,
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
}

const ALERT_SELECT = { id: true, source: true, symbol: true, signal: true, sourceTimeframe: true, triggeredAt: true, rawPayload: true } as const;

/**
 * TEST-ONLY: a dry-admission snapshot read from `_test` rows with the same
 * reads the adoption pass and Phase 5 make. The dry admission itself never
 * reads anything; this is the caller's job, and here the caller is a test.
 */
async function snapshotFromRows(alertId: string, profileId: string, evidence: Snapshot["scannerEvidence"], nowMs: number = NOW.getTime()): Promise<Snapshot> {
  const alert = await prisma!.alert.findUniqueOrThrow({ where: { id: alertId }, select: ALERT_SELECT });
  const plan = await new ExtremeRRService(prisma!).getForAlert(alertId);
  const occupancy = await loadNativeOccupancyRows(prisma!, profileId, alert.symbol);
  const profile = await prisma!.executionProfile.findUnique({ where: { id: profileId }, select: { isEnabled: true, safetyPolicy: { select: { killSwitchActive: true } } } });
  const authorizationCount = await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } });
  const exact = await prisma!.executionCanaryAuthorization.findFirst({ where: { executionProfileId: profileId, authorizationType: "EXACT_SIGNAL", consumedAlertId: alertId, revokedAt: null }, select: { id: true } });
  const window = await prisma!.executionCanaryAuthorization.findFirst({ where: { executionProfileId: profileId, authorizationType: "NATURAL_WINDOW" }, orderBy: { createdAt: "desc" } });
  const session = window?.tradingSessionId ? await prisma!.tradingSession.findUnique({ where: { id: window.tradingSessionId } }) : null;
  return {
    accountSlot: "ACCOUNT_A",
    executionProfileId: profileId,
    alert,
    plan,
    accountPlanPolicy: fixtures.ACCOUNT_A_POLICY,
    scannerEvidence: evidence,
    occupancy,
    accountGates: { environment: fixtures.LIVE_READY_GATES, profile: profile === null ? null : { isEnabled: profile.isEnabled, killSwitchActive: profile.safetyPolicy?.killSwitchActive ?? null } },
    phase5: { authorizationCount, exactBindingId: exact?.id ?? null, newestNaturalWindow: window as never, session },
    nowMs,
  };
}

/** The scanner evidence reader the adoption pass is given: one evidence blob per symbol. */
function evidenceBySymbol(entries: [string, ReturnType<typeof fixtures.evidenceOf>][]) {
  const bySymbol = new Map(entries);
  return (provenance: { symbol: string }) => {
    const evidence = bySymbol.get(provenance.symbol);
    if (evidence === undefined) throw new Error(`no evidence for ${provenance.symbol}`);
    return evidence;
  };
}

async function cleanup(): Promise<void> {
  if (!available) return;
  const profileIds = (await prisma!.executionProfile.findMany({ where: { accountIdentifier: { startsWith: TAG } }, select: { id: true } })).map((p) => p.id);
  const executionIds = (await prisma!.tradeExecution.findMany({ where: { executionProfileId: { in: profileIds } }, select: { id: true } })).map((r) => r.id);
  const sessionIds = (await prisma!.tradingSession.findMany({ where: { executionProfileId: { in: profileIds } }, select: { id: true } })).map((s) => s.id);
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
  await prisma!.tradingSessionSlot.deleteMany({ where: { tradingSessionId: { in: sessionIds } } });
  await prisma!.selectedPlanAdoption.deleteMany({ where: { executionProfileId: { in: profileIds } } });
  await prisma!.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: { in: profileIds } } });
  await prisma!.tradingSession.deleteMany({ where: { id: { in: sessionIds } } });
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
// Sections 14 and 15: the traps
// ===========================================================================

describe("sections 14/15: a dry evaluation reaches no signer, network, exchange adapter, file, database row, queue or Redis", () => {
  maybe()("controls: each trap fires on a real call (a signed read, a scanner-tree read, a queue and a Redis construction)", async () => {
    const adapterCalls = spyOnAdapters();
    const before = { hmac: traps.hmac, fs: traps.fs.length, queue: traps.queue, redis: traps.redis };

    const client = new BinanceReadOnlyClient({ baseUrl: BASE_URL, apiKey: SENTINEL_KEY, apiSecret: SENTINEL_SECRET, enabled: true });
    await new BinanceReadOnlyService(client).queryOrderByClientOrderId("BTCUSDT", "m6-control").catch(() => undefined);
    expect(traps.hmac).toBeGreaterThan(before.hmac);
    expect(seen.some((r) => r.signed && r.apiKey)).toBe(true);
    expect(adapterCalls()).toEqual(expect.arrayContaining(["BinanceReadOnlyService.queryOrderByClientOrderId", "BinanceReadOnlyClient.request"]));

    const records = fixtures.cleanRecords();
    const provenance = nativeExecutionProvenanceOf(fixtures.canaryAlert(records));
    if (!provenance.ok) throw new Error("fixture provenance");
    fileSystemNativeScannerEvidence({ LOCALAPPDATA: tmpdir() })(provenance.provenance);
    expect(traps.fs.length).toBeGreaterThan(before.fs);

    new (await import("bullmq")).Queue("m6-control");
    new (await import("ioredis")).default();
    expect([traps.queue, traps.redis]).toEqual([before.queue + 1, before.redis + 1]);
  });

  maybe()("100 evaluations of every snapshot, fixture-built and read from `_test` rows: 0 signatures, 0 requests, 0 adapter calls, 0 file operations, 0 queue or Redis use, and a byte-identical database", async () => {
    // Facts first, outside the window: rows, then snapshots read from them.
    const profileId = await armedProfile("trap");
    const fresh = await nativePlan();
    const weekly = await nativePlan({ sourceTf: "1W" });
    const session = await prisma!.tradingSession.create({ data: { executionProfileId: profileId, tradeBudget: 3, expiresAt: new Date(NOW.getTime() + 86_400_000) } });
    await prisma!.executionCanaryAuthorization.create({
      data: { executionProfileId: profileId, authorizationType: "NATURAL_WINDOW", allowedDirections: ["LONG", "SHORT"], maxClaims: 5, expiresAt: new Date(NOW.getTime() + 86_400_000), tradingSessionId: session.id },
    });
    const snapshots: Snapshot[] = [
      await snapshotFromRows(fresh.alertId, profileId, fixtures.eligibleEvidence(fresh.records, fresh.symbol)),
      await snapshotFromRows(weekly.alertId, profileId, fixtures.evidenceOf(weekly.records.slice(0, 2), fixtures.SOURCE_BAR, weekly.symbol)),
      await snapshotFromRows(fresh.alertId, profileId, null, NOW.getTime() + 3_600_000),
      { ...(await snapshotFromRows(fresh.alertId, profileId, fixtures.eligibleEvidence(fresh.records, fresh.symbol))), accountSlot: "ACCOUNT_B", accountPlanPolicy: fixtures.ACCOUNT_B_POLICY },
      { ...(await snapshotFromRows(fresh.alertId, profileId, fixtures.eligibleEvidence(fresh.records, fresh.symbol))), plan: null, phase5: null },
    ];
    const expected = snapshots.map((s) => evaluateNativeDryAdmission(s));
    expect(expected[0].authoritative).toMatchObject({ terminalStage: "NATIVE_FENCE", reason: "NATIVE_EXECUTION_DISABLED" });
    expect(expected[1].authoritative).toMatchObject({ terminalStage: "INTEGRITY", adoption: "DEFER" });
    const adapterCalls = spyOnAdapters();
    const digestBefore = await databaseDigest();
    await settle();

    // --- the window: dry evaluations only ---------------------------------
    const before = { hmac: traps.hmac, fs: traps.fs.length, queue: traps.queue, redis: traps.redis };
    for (let run = 0; run < 100; run += 1) {
      snapshots.forEach((s, i) => expect(evaluateNativeDryAdmission(s)).toStrictEqual(expected[i]));
    }
    await settle();
    const after = { hmac: traps.hmac, fs: traps.fs.length, queue: traps.queue, redis: traps.redis };
    // -----------------------------------------------------------------------

    expect(after).toEqual(before); // signatures 0, file operations 0, queue 0, Redis 0
    expect(seen).toEqual([]); // requests 0: no key sent, no private read, no public read
    expect(adapterCalls()).toEqual([]); // no adapter: no signed read, leverage, margin mode, entry, stop, TP or cancel
    expect(await databaseDigest()).toEqual(digestBefore); // no INSERT, UPDATE, DELETE, claim, lease, cursor or ledger write
  });
});

// ===========================================================================
// Section 13, dry authority: the real executor, creation and adoption
// ===========================================================================

const SWITCH = "../src/modules/native-canary/native-execution-switch";

/** The executor, its creation path and the canary, in a TEST-ONLY graph with the switch on and a synthetic resolved A. */
async function enabledGraph() {
  vi.resetModules();
  vi.doMock(SWITCH, () => ({ NATIVE_EXECUTION_ENABLED: true }));
  vi.doMock(fixtures.RISK_CONTRACT_MODULE, fixtures.resolvedAContracts);
  return {
    evaluate: (await import("../src/modules/native-canary/native-dry-admission")).evaluateNativeDryAdmission,
    SelectedPlanExecutor: (await import("../src/modules/execution/selected-plan-executor")).SelectedPlanExecutor,
    ExecutionService: (await import("../src/modules/execution/execution.service")).ExecutionService,
    Forbidden: (await import("../src/modules/alerts/alert-source")).NativeAlertExecutionForbiddenError,
  };
}
const PRODUCTION_GRAPH = { evaluate: evaluateNativeDryAdmission, SelectedPlanExecutor, ExecutionService, Forbidden: NativeAlertExecutionForbiddenError };

/** Every form a dry result could be smuggled in as. */
function dryForms(result: DryResult, plan: { alertId: string; planId: string; symbol: string }, profileId: string): unknown[] {
  const handoffShape = {
    kind: "NATIVE_ACCOUNT_A_HANDOFF",
    executionProfileId: profileId,
    alertId: plan.alertId,
    planId: plan.planId,
    symbol: plan.symbol,
    direction: "LONG",
    sourceTimeframe: "1D",
    entryPrice: fixtures.ENTRY_PRICE,
    lookback: 100,
    candidate: fixtures.candidateFor(100, "LONG"),
    template: fixtures.TEMPLATE,
    integrity: "ELIGIBLE",
  };
  const wrapped = Object.freeze({ ...result, ...handoffShape });
  return [result, structuredClone(result), JSON.parse(JSON.stringify(result)), wrapped, JSON.parse(JSON.stringify(wrapped)), Object.freeze({ ...handoffShape, ...result })];
}

const MARGIN_PLAN = {
  status: "READY",
  reason: null,
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

describe("section 13: a dry result cannot be verified, executed, created, adopted or turned into an order", () => {
  afterEach(() => {
    vi.doUnmock(SWITCH);
    vi.doUnmock(fixtures.RISK_CONTRACT_MODULE);
    vi.resetModules();
  });

  for (const [label, graphOf] of [
    ["production graph (switch false)", async () => PRODUCTION_GRAPH],
    ["TEST-ONLY graph (switch on, synthetic resolved A), where the dry verdict ADMITS", enabledGraph],
  ] as const) {
    maybe()(`${label}: the real executor refuses every form HANDOFF_INVALID before touching any dependency, and creation throws the Native fence error; nothing is written`, async () => {
      const graph = await graphOf();
      const profileId = await armedProfile("authority");
      const plan = await nativePlan();
      const snapshot = await snapshotFromRows(plan.alertId, profileId, fixtures.eligibleEvidence(plan.records, plan.symbol));
      const result = graph.evaluate(snapshot);
      expect(result.authority).toBe("NONE");
      expect(result.authoritative.admitted).toBe(label.startsWith("TEST-ONLY"));

      const touched: string[] = [];
      const trap = (name: string) => new Proxy({}, { get: (_t, key) => (touched.push(`${name}.${String(key)}`), () => { throw new Error(`${name} reached`); }) });
      const executor = new graph.SelectedPlanExecutor({
        prisma: trap("prisma") as never,
        marginPlanner: trap("marginPlanner") as never,
        executions: trap("executions") as never,
        orchestrator: trap("orchestrator") as never,
        boundProfile: testProfileProjection({ executionProfileId: profileId }),
        nativeFence: { evidence: fixtures.readerOf(fixtures.eligibleEvidence(plan.records, plan.symbol)), accountSlot: "ACCOUNT_A" },
      });
      const creation = new graph.ExecutionService(prisma!);
      const digestBefore = await databaseDigest();
      const hmacBefore = traps.hmac;

      for (const form of dryForms(result, plan, profileId)) {
        expect(await executor.handleNativeAccountACandidate(form as never, NOW)).toMatchObject({ handled: false, reasonCode: "HANDOFF_INVALID" });
        await expect(
          creation.createExecutionFromReadyPlan({ executionProfileId: profileId, alertId: plan.alertId, extremeRRPlanId: plan.planId, plan: { ...MARGIN_PLAN, symbol: plan.symbol } as never, selectedLookback: 100, nativeAccountA: form as never })
        ).rejects.toBeInstanceOf(graph.Forbidden);
      }

      expect(touched).toEqual([]); // the executor never reached its database, planner, creation or orchestrator
      expect(traps.hmac).toBe(hmacBefore);
      expect(seen).toEqual([]);
      expect(await prisma!.tradeExecution.count({ where: { executionProfileId: profileId } })).toBe(0); // no execution row
      expect(await prisma!.binanceOrder.count({ where: { tradeExecution: { executionProfileId: profileId } } })).toBe(0); // no order, so no order id
      expect(await databaseDigest()).toEqual(digestBefore);
    });
  }

  maybe()("a dry evaluation claims nothing: no adoption row or lease appears, and the real adoption pass still finds and decides the plan afterwards", async () => {
    const profileId = await armedProfile("adoption");
    const plan = await nativePlan();
    const evidence = fixtures.eligibleEvidence(plan.records, plan.symbol);
    const snapshot = await snapshotFromRows(plan.alertId, profileId, evidence);
    for (let i = 0; i < 10; i += 1) evaluateNativeDryAdmission(snapshot);
    await settle();
    expect(await prisma!.selectedPlanAdoption.count({ where: { executionProfileId: profileId } })).toBe(0);

    const executorTrap = { handleNativeAccountACandidate: vi.fn(async () => { throw new Error("executor reached"); }) };
    const adoption = new NativeAccountAAdoptionService({
      prisma: prisma!,
      boundProfile: testProfileProjection({ executionProfileId: profileId }),
      executor: executorTrap as never,
      plans: new ExtremeRRService(prisma!),
      workerId: "m6-adoption",
      accountSlot: "ACCOUNT_A",
      accountPlanPolicy: fixtures.ACCOUNT_A_POLICY,
      fence: { evidence: evidenceBySymbol([[plan.symbol, evidence]]), accountSlot: "ACCOUNT_A" },
      environmentGates: fixtures.LIVE_READY_GATES,
    });
    await adoption.runOnce(50, NOW);
    expect(executorTrap.handleNativeAccountACandidate).not.toHaveBeenCalled();
    const row = await prisma!.selectedPlanAdoption.findFirstOrThrow({ where: { executionProfileId: profileId, extremeRRPlanId: plan.planId } });
    const result = evaluateNativeDryAdmission(snapshot);
    expect([row.handled, row.reasonCode, row.message]).toEqual([false, result.authoritative.reason, `${result.authoritative.terminalStage}: ${result.authoritative.detail}`]);
  });
});

// ===========================================================================
// Section 17: the dry verdict IS the real adoption pass's verdict
// ===========================================================================

describe("section 17: over the same `_test` rows, the dry admission says exactly what the real adoption pass records", () => {
  maybe()("fence, integrity, deferral, plan window and occupancy: identical stage, code and message; the deferred candidate is left unclaimed", async () => {
    const profileId = await armedProfile("parity");
    const fresh = await nativePlan();
    const weekly = await nativePlan({ sourceTf: "1W" });
    const short = await nativePlan({ signal: "SHORT" });
    const pending = await nativePlan();
    const gap = await nativePlan();
    const window300 = await nativePlan({ selectedLookback: 300 });
    const occupied = await nativePlan();
    await pendingLimit(profileId, occupied.symbol);

    const evidence: [string, ReturnType<typeof fixtures.evidenceOf>][] = [
      [fresh.symbol, fixtures.eligibleEvidence(fresh.records, fresh.symbol)],
      [weekly.symbol, fixtures.eligibleEvidence(weekly.records, weekly.symbol)],
      [short.symbol, fixtures.eligibleEvidence(short.records, short.symbol)],
      [pending.symbol, fixtures.evidenceOf(pending.records.slice(0, 2), fixtures.SOURCE_BAR, pending.symbol)],
      [gap.symbol, fixtures.evidenceOf(gap.records.slice(1), bar(2), gap.symbol)],
      [window300.symbol, fixtures.eligibleEvidence(window300.records, window300.symbol)],
      [occupied.symbol, fixtures.eligibleEvidence(occupied.records, occupied.symbol)],
    ];
    const bySymbol = new Map(evidence);
    const seeded = [fresh, weekly, short, pending, gap, window300, occupied];

    // The dry admission first, from snapshots read from the rows...
    const dry = new Map<string, DryResult>();
    for (const plan of seeded) dry.set(plan.planId, evaluateNativeDryAdmission(await snapshotFromRows(plan.alertId, profileId, bySymbol.get(plan.symbol)!)));

    // ...then the real adoption pass over the same rows, at the same instant.
    const executorTrap = { handleNativeAccountACandidate: vi.fn(async () => { throw new Error("executor reached"); }) };
    const adoption = new NativeAccountAAdoptionService({
      prisma: prisma!,
      boundProfile: testProfileProjection({ executionProfileId: profileId }),
      executor: executorTrap as never,
      plans: new ExtremeRRService(prisma!),
      workerId: "m6-parity",
      accountSlot: "ACCOUNT_A",
      accountPlanPolicy: fixtures.ACCOUNT_A_POLICY,
      fence: { evidence: evidenceBySymbol(evidence), accountSlot: "ACCOUNT_A" },
      environmentGates: fixtures.LIVE_READY_GATES,
    });
    // Asserted on this profile's rows below, not on pass totals another suite's leftovers could move.
    expect((await adoption.runOnce(50, NOW)).deferred).toBeGreaterThanOrEqual(1);
    expect(executorTrap.handleNativeAccountACandidate).not.toHaveBeenCalled();

    const verdicts: Record<string, unknown> = {};
    for (const plan of seeded) {
      const result = dry.get(plan.planId)!;
      const row = await prisma!.selectedPlanAdoption.findFirst({ where: { extremeRRPlanId: plan.planId, executionProfileId: profileId } });
      if (result.authoritative.adoption === "DEFER") {
        expect(row).toBeNull();
      } else {
        expect(row).not.toBeNull();
        expect([row!.status, row!.handled, row!.reasonCode, row!.message]).toEqual(["COMPLETED", false, result.authoritative.reason, `${result.authoritative.terminalStage}: ${result.authoritative.detail}`]);
      }
      verdicts[plan.symbol] = [result.authoritative.adoption, result.authoritative.terminalStage, result.authoritative.reason];
    }
    expect(Object.values(verdicts)).toEqual([
      ["DECIDE", "NATIVE_FENCE", "NATIVE_EXECUTION_DISABLED"],
      ["DECIDE", "NATIVE_FENCE", "NATIVE_EXECUTION_DISABLED"],
      ["DECIDE", "NATIVE_FENCE", "NATIVE_EXECUTION_DISABLED"],
      ["DEFER", "INTEGRITY", "INTEGRITY_PENDING_BAR_CLOSE"],
      ["DECIDE", "INTEGRITY", "INTEGRITY_INELIGIBLE"],
      ["DECIDE", "PLAN", "PLAN_LOOKBACK_MISMATCH"],
      ["DECIDE", "OCCUPANCY", "SAME_SYMBOL_SIDE_OCCUPIED"],
    ]);
  });
});

// ===========================================================================
// Section 6: the extracted Phase 5 kernels decide what the I/O functions decide
// ===========================================================================

describe("section 6: resolveAdmissionAuthorization and reserveSessionSlot judge exactly through the pure kernels the dry admission asks", () => {
  maybe()("authorization: LEGACY, NATURAL, REVOKED, EXPIRED, DIRECTION_NOT_ALLOWED, INVALID and EXACT, read from rows, equal the kernel and the dry diagnostic", async () => {
    const profileId = await armedProfile("authorization");
    const plan = await nativePlan();
    const at = NOW;
    const day = 86_400_000;
    const session = await prisma!.tradingSession.create({ data: { executionProfileId: profileId, tradeBudget: 3, expiresAt: new Date(at.getTime() + day) } });
    const steps: [string, () => Promise<unknown>, string][] = [
      ["no history", async () => undefined, "LEGACY"],
      ["an open session-backed window", () => prisma!.executionCanaryAuthorization.create({ data: { executionProfileId: profileId, authorizationType: "NATURAL_WINDOW", allowedDirections: ["LONG", "SHORT"], maxClaims: 5, expiresAt: new Date(at.getTime() + day), tradingSessionId: session.id, createdAt: new Date(at.getTime() - 50_000) } }), "NATURAL"],
      ["a newer window, revoked", () => prisma!.executionCanaryAuthorization.create({ data: { executionProfileId: profileId, authorizationType: "NATURAL_WINDOW", allowedDirections: ["LONG"], maxClaims: 5, expiresAt: new Date(at.getTime() + day), revokedAt: new Date(at.getTime() - 1000), createdAt: new Date(at.getTime() - 40_000) } }), "NATURAL_AUTHORIZATION_REVOKED"],
      ["a newer window, expired", () => prisma!.executionCanaryAuthorization.create({ data: { executionProfileId: profileId, authorizationType: "NATURAL_WINDOW", allowedDirections: ["LONG"], maxClaims: 5, expiresAt: at, createdAt: new Date(at.getTime() - 30_000) } }), "NATURAL_AUTHORIZATION_EXPIRED"],
      ["a newer window for the other side", () => prisma!.executionCanaryAuthorization.create({ data: { executionProfileId: profileId, authorizationType: "NATURAL_WINDOW", allowedDirections: ["SHORT"], maxClaims: 5, expiresAt: new Date(at.getTime() + day), createdAt: new Date(at.getTime() - 20_000) } }), "NATURAL_AUTHORIZATION_DIRECTION_NOT_ALLOWED"],
      ["a newer, malformed window", () => prisma!.executionCanaryAuthorization.create({ data: { executionProfileId: profileId, authorizationType: "NATURAL_WINDOW", allowedDirections: [], maxClaims: 5, expiresAt: new Date(at.getTime() + day), createdAt: new Date(at.getTime() - 10_000) } }), "NATURAL_AUTHORIZATION_INVALID"],
      ["an exact binding for the alert", () => prisma!.executionCanaryAuthorization.create({ data: { executionProfileId: profileId, authorizationType: "EXACT_SIGNAL", allowedSymbol: plan.symbol, allowedDirection: "LONG", expiresAt: new Date(at.getTime() + day), consumedAlertId: plan.alertId, consumedAt: at } }), "EXACT"],
    ];
    for (const [name, step, expected] of steps) {
      await step();
      const execution = { alertId: plan.alertId, executionProfileId: profileId, positionSide: "LONG" as const };
      const resolved = await resolveAdmissionAuthorization(prisma! as never, execution, at);
      const snapshot = await snapshotFromRows(plan.alertId, profileId, fixtures.eligibleEvidence(plan.records, plan.symbol));
      const facts = snapshot.phase5!;
      const kernel = judgeAdmissionAuthorization({ authorizationCount: facts.authorizationCount, exactBindingId: facts.exactBindingId, newestNaturalWindow: facts.newestNaturalWindow }, "LONG", at);
      expect({ name, resolved }).toEqual({ name, resolved: kernel });
      const diagnostic = evaluateNativeDryAdmission(snapshot).diagnostics.find((d) => d.stage === "PHASE5_AUTHORIZATION")!;
      expect({ name, code: resolved.ok ? resolved.mode : resolved.reasonCode }).toEqual({ name, code: expected });
      expect({ name, diagnostic: [diagnostic.status, diagnostic.reason] }).toEqual({ name, diagnostic: resolved.ok ? ["PASS", `AUTHORIZATION_${resolved.mode}`] : ["REFUSE", resolved.reasonCode] });
      if (!resolved.ok) expect(diagnostic.detail).toBe(resolved.message);
    }
  });

  maybe()("session: every refusal reserveSessionSlot makes from rows equals the kernel and the dry diagnostic, and the admitting case reserves exactly where both admit", async () => {
    const profileId = await armedProfile("session");
    const otherProfileId = await armedProfile("session-other");
    const at = NOW;
    const day = 86_400_000;
    const base = { executionProfileId: profileId, tradeBudget: 3, expiresAt: new Date(at.getTime() + day) };
    const cases: [string, () => Promise<string | null>, string][] = [
      ["no session named", async () => null, "SESSION_REQUIRED"],
      ["a session that does not exist", async () => "c-m6-missing-session", "SESSION_REQUIRED"],
      ["another profile's session", async () => (await prisma!.tradingSession.create({ data: { ...base, executionProfileId: otherProfileId } })).id, "SESSION_REQUIRED"],
      ["a stopped session", async () => (await prisma!.tradingSession.create({ data: { ...base, status: "REVOKED" } })).id, "SESSION_REVOKED"],
      ["an expired session", async () => (await prisma!.tradingSession.create({ data: { ...base, expiresAt: at } })).id, "SESSION_EXPIRED"],
      ["a spent session", async () => (await prisma!.tradingSession.create({ data: { ...base, openedCount: 2, reservedCount: 1 } })).id, "SESSION_BUDGET_EXHAUSTED"],
      ["a paused session", async () => (await prisma!.tradingSession.create({ data: { ...base, status: "PAUSED" } })).id, "SESSION_PAUSED"],
      ["an active session with budget", async () => (await prisma!.tradingSession.create({ data: base })).id, "RESERVED"],
    ];
    for (const [name, make, expected] of cases) {
      const tradingSessionId = await make();
      const loaded = tradingSessionId === null ? null : await prisma!.tradingSession.findUnique({ where: { id: tradingSessionId } });
      const kernel = judgeSessionReservation({ executionProfileId: profileId, tradingSessionId, session: loaded, now: at });
      // The dry diagnostic for a session-backed window naming that session.
      const window = { ...fixturesWindow(profileId, at), tradingSessionId };
      const plan = await nativePlan();
      const snapshot = { ...(await snapshotFromRows(plan.alertId, profileId, fixtures.eligibleEvidence(plan.records, plan.symbol))), phase5: { authorizationCount: 1, exactBindingId: null, newestNaturalWindow: window as never, session: loaded } };
      const diagnostic = evaluateNativeDryAdmission(snapshot).diagnostics.find((d) => d.stage === "PHASE5_SESSION_BUDGET")!;

      const reservation = await reserveSessionSlot(prisma! as never, { executionProfileId: profileId, tradingSessionId, tradeExecutionId: `m6-slot-${name.replace(/\W+/g, "-")}`, now: at });
      if (tradingSessionId === null) {
        // A window naming no session is a LEGACY window: Phase 5 never asks for a slot, so the dry diagnostic says so.
        expect({ name, reservation }).toEqual({ name, reservation: { reserved: false, reasonCode: expected, message: kernel.admits ? "(kernel admitted)" : kernel.message } });
        expect({ name, diagnostic: [diagnostic.status, diagnostic.reason] }).toEqual({ name, diagnostic: ["PASS", "NO_SESSION_SLOT_REQUIRED"] });
      } else if (expected === "RESERVED") {
        expect({ name, reserved: reservation.reserved, kernel: kernel.admits, diagnostic: [diagnostic.status, diagnostic.reason] }).toEqual({ name, reserved: true, kernel: true, diagnostic: ["PASS", "SESSION_SLOT_AVAILABLE"] });
      } else {
        expect({ name, reservation }).toEqual({ name, reservation: { reserved: false, reasonCode: expected, message: kernel.admits ? "(kernel admitted)" : kernel.message } });
        expect({ name, diagnostic: [diagnostic.status, diagnostic.reason, diagnostic.detail] }).toEqual({ name, diagnostic: ["REFUSE", expected, reservation.reserved ? "" : reservation.message] });
      }
    }
  });
});

/** An open session-backed natural window for `profileId`, as a row would read. */
function fixturesWindow(profileId: string, at: Date) {
  return {
    id: "c-m6-window",
    executionProfileId: profileId,
    authorizationType: "NATURAL_WINDOW",
    allowedSymbol: null,
    allowedDirection: null,
    tokenHash: null,
    allowedDirections: ["LONG", "SHORT"],
    tradingSessionId: null as string | null,
    maxClaims: 5,
    claimedCount: 0,
    version: 1,
    expiresAt: new Date(at.getTime() + 86_400_000),
    createdAt: new Date(at.getTime() - 60_000),
    consumedAt: null,
    consumedAlertId: null,
    consumedExecutionId: null,
    revokedAt: null,
  };
}
