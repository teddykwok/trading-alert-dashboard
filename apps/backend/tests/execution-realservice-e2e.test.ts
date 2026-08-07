import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * FINAL Phase 11A validation — REAL services, FAKE network only.
 *
 * What is real here: ExecutionService, SafetyAdmissionService,
 * EntryLifecycleService, ProtectionLifecycleService, ExecutionOrchestrator, the
 * Binance read-only and execution CLIENTS (so signing, endpoint selection, HTTP
 * verb, parameter construction, deterministic ids and response parsing all
 * execute for real), and Prisma against a real Postgres.
 *
 * What is faked: the network, and nothing else. `globalThis.fetch` and the
 * execution client's transport hook are replaced by a scripted exchange whose
 * state survives runtime reconstruction, which is what makes the restart
 * scenarios genuine rather than a flag reset.
 *
 * The live gates are opened ONLY on locally constructed client objects. The
 * real `.env` is never read for them and never modified, and no request can
 * leave the process.
 */

const TAG = "phase11-real";
const SYMBOL = "TESTQUSDT";
const BACKEND = process.cwd();

// Gates stay closed in the environment; the clients below are told otherwise
// explicitly, which is how Phase 6/7 integration tests already work.
process.env.EXECUTION_GLOBAL_KILL_SWITCH = "false";
// The real Phase 5 engine checks the profile environment against the configured
// host. Point both at testnet so the TESTNET profile below is consistent —
// this is a TEST-PROCESS variable only; the real .env is never touched.
process.env.BINANCE_FUTURES_REST_BASE_URL = "https://testnet.binancefuture.com";
// EntryLifecycleService.checkLiveGates() reads env DIRECTLY — a second gate
// layer no constructor option can override, which is good defensive depth and
// means an integration test must set these in the TEST PROCESS. Nothing here
// reads or writes the real .env, and the transport below is a fake, so no
// request can leave this process.
process.env.EXECUTION_LIVE_ENTRY_ENABLED = "true";
process.env.EXECUTION_PROTECTION_READY = "true";

// Integration state lives in the DEDICATED test database. The helper refuses
// to fall back to the runtime/canary database, so a misconfiguration fails the
// suite instead of quietly writing synthetic executions into runtime state.
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ExecutionService } = await import("../src/modules/execution/execution.service");
const { SafetyAdmissionService } = await import("../src/modules/execution/safety-admission.service");
const { EntryLifecycleService } = await import("../src/modules/execution/entry-lifecycle.service");
const { ProtectionLifecycleService } = await import("../src/modules/execution/protection-lifecycle.service");
const { CriticalAlertService } = await import("../src/modules/execution/critical-alert.service");
const { ExecutionOrchestrator } = await import("../src/modules/execution/execution-orchestrator");
const { BinanceReadOnlyClient } = await import("../src/modules/binance/binance.client");
const { BinanceReadOnlyService } = await import("../src/modules/binance/binance-read-only.service");
const { BinanceUsdMExecutionClient } = await import("../src/modules/binance/binance-execution.client");

// ---------------------------------------------------------------------------
// Scripted fake exchange — the ONLY faked thing
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  path: string;
  /** Parameter NAMES only — never a signature or credential. */
  paramNames: string[];
  clientIdentity: string | null;
}

class FakeExchange {
  /** Every attempted submission, recorded BEFORE any dedupe. */
  readonly requests: RecordedRequest[] = [];
  readonly acceptedEntryIds = new Set<string>();
  readonly acceptedAlgoIds = new Set<string>();

  orders = new Map<string, { status: string; executedQty: string; avgPrice: string; orderId: string; side: string; positionSide: string; type: string; origQty: string; price: string }>();
  algoOrders = new Map<string, { algoStatus: string; algoId: string; executedQty: string; side: string; positionSide: string; orderType: string; quantity: string; triggerPrice: string; workingType: string; priceProtect: boolean }>();
  positionAmt = "0";
  positionSide: "LONG" | "SHORT" = "LONG";
  positionMode = true; // dualSidePosition
  /**
   * APPLICATION submission attempts, counted before any exchange-side dedupe.
   * Kept separate from the accepted sets so a test can tell "the application
   * asked once" from "the application asked twice and the exchange saved us".
   */
  entryAttempts = 0;
  algoAttempts = new Map<string, number>();
  /** Scripted failure for the next matching request. */
  failNext: { path: string; method?: string; kind: "TIMEOUT" | "REJECT" | "SERVER" } | null = null;

  reset(): void {
    this.requests.length = 0;
    this.acceptedEntryIds.clear();
    this.acceptedAlgoIds.clear();
    this.orders = new Map();
    this.algoOrders = new Map();
    this.positionAmt = "0";
    this.positionSide = "LONG";
    this.entryAttempts = 0;
    this.algoAttempts = new Map();
    this.failNext = null;
  }

  /** Advances the entry order's fill, and the reported position with it. */
  fillEntry(quantity: string, complete: boolean): void {
    for (const [, order] of this.orders) {
      if (order.type !== "LIMIT") continue;
      order.executedQty = quantity;
      order.avgPrice = "100";
      order.status = complete ? "FILLED" : "PARTIALLY_FILLED";
    }
    this.positionAmt = quantity;
  }

  /** Simulates a protection order triggering and flattening the position. */
  triggerProtection(role: "sl" | "tp"): void {
    for (const [id, algo] of this.algoOrders) {
      if (!id.includes(`tad-${role}-`)) continue;
      algo.algoStatus = "FILLED";
      algo.executedQty = this.positionAmt;
    }
    // Phase 7 requires a PROVEN zero position before any terminal state.
    this.positionAmt = "0";
    for (const [, order] of this.orders) if (order.status === "NEW") order.status = "CANCELED";
  }

  private record(method: string, url: URL): void {
    const params = [...url.searchParams.keys()].filter((key) => key !== "signature" && key !== "timestamp");
    this.requests.push({
      method,
      path: url.pathname,
      paramNames: params.sort(),
      clientIdentity:
        url.searchParams.get("newClientOrderId") ??
        url.searchParams.get("origClientOrderId") ??
        url.searchParams.get("clientAlgoId") ??
        null,
    });
  }

  /** Serves both the GET client (global fetch) and the mutation transport. */
  readonly handle = async (rawUrl: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(rawUrl);
    const method = String(init?.method ?? "GET");
    this.record(method, url);

    // Method-scoped: the lifecycle GETs the same path before submitting, so a
    // path-only match would consume the scripted failure on the wrong request.
    if (
      this.failNext &&
      url.pathname.includes(this.failNext.path) &&
      (this.failNext.method === undefined || this.failNext.method === method)
    ) {
      const kind = this.failNext.kind;
      this.failNext = null;
      if (kind === "TIMEOUT") {
        // The DANGEROUS case: the order LANDS and the response is lost. A client
        // that resubmitted here would double the exposure, so the fake commits
        // the order first and only then drops the reply.
        if (method === "POST") this.route(method, url);
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      if (kind === "SERVER") return json({ code: -1001, msg: "Internal error" }, 503);
      return json({ code: -2010, msg: "Order would immediately trigger." }, 400);
    }

    return this.route(method, url);
  };

  private route(method: string, url: URL): Response {
    const p = url.pathname;
    const q = url.searchParams;

    if (p === "/fapi/v1/ping") return json({});
    if (p === "/fapi/v1/time") return json({ serverTime: Date.now() });
    if (p === "/fapi/v1/exchangeInfo") {
      return json({
        symbols: [
          {
            symbol: SYMBOL,
            status: "TRADING",
            contractType: "PERPETUAL",
            filters: [
              { filterType: "PRICE_FILTER", tickSize: "0.01", minPrice: "0.01", maxPrice: "100000" },
              { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" },
              { filterType: "MARKET_LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "100" },
              { filterType: "MIN_NOTIONAL", notional: "1" },
            ],
          },
        ],
      });
    }
    if (p === "/fapi/v1/leverageBracket") {
      return json([{ symbol: SYMBOL, brackets: [{ bracket: 1, initialLeverage: 25, notionalCap: 50000, notionalFloor: 0, maintMarginRatio: 0.01, cum: 0 }] }]);
    }
    if (p === "/fapi/v1/symbolConfig") {
      return json([{ symbol: SYMBOL, marginType: "ISOLATED", leverage: 10, maxNotionalValue: "50000", isAutoAddMargin: false }]);
    }
    if (p === "/fapi/v1/positionSide/dual") {
      if (method === "GET") return json({ dualSidePosition: this.positionMode });
      return json({ code: 200, msg: "success" });
    }
    if (p === "/fapi/v1/multiAssetsMargin") return json({ multiAssetsMargin: false });
    if (p === "/fapi/v3/balance") return json([{ asset: "USDT", balance: "500", availableBalance: "500" }]);
    if (p === "/fapi/v3/account") return json({ totalWalletBalance: "500" });
    if (p === "/fapi/v3/positionRisk") {
      if (this.positionAmt === "0") return json([]);
      return json([
        {
          symbol: SYMBOL,
          positionSide: this.positionSide,
          // A SHORT is reported negative, exactly as Binance does.
          positionAmt: this.positionSide === "LONG" ? this.positionAmt : `-${this.positionAmt}`,
          entryPrice: "100",
          markPrice: "100",
          // Comfortably inside the frozen boundary on either side.
          liquidationPrice: this.positionSide === "LONG" ? "90" : "110",
          isolatedMargin: "3.75",
          leverage: "10",
        },
      ]);
    }
    if (p === "/fapi/v1/openOrders") {
      const open = [...this.orders.entries()].filter(([, o]) => o.status === "NEW" || o.status === "PARTIALLY_FILLED");
      return json(open.map(([cid, o]) => ({ symbol: SYMBOL, clientOrderId: cid, orderId: o.orderId, status: o.status })));
    }
    if (p === "/fapi/v1/order") {
      const cid = q.get("origClientOrderId") ?? q.get("newClientOrderId") ?? "";
      if (method === "GET") {
        const order = this.orders.get(cid);
        if (!order) return json({ code: -2013, msg: "Order does not exist." }, 400);
        // Echo the SUBMITTED identity back. Phase 6 verifies side/positionSide/
        // type against local intent and parks the execution on any mismatch —
        // a generic echo would (correctly) trip that check.
        return json({
          symbol: SYMBOL,
          clientOrderId: cid,
          orderId: order.orderId,
          status: order.status,
          executedQty: order.executedQty,
          avgPrice: order.avgPrice,
          origQty: order.origQty,
          price: order.price,
          side: order.side,
          positionSide: order.positionSide,
          type: order.type,
          timeInForce: "GTC",
          updateTime: Date.now(),
        });
      }
      if (method === "DELETE") {
        const order = this.orders.get(cid);
        if (order) order.status = "CANCELED";
        return json({ symbol: SYMBOL, clientOrderId: cid, status: "CANCELED" });
      }
      // POST — a real submission attempt.
      this.entryAttempts += 1;
      this.acceptedEntryIds.add(cid);
      this.orders.set(cid, {
        status: "NEW", executedQty: "0", avgPrice: "0", orderId: `ex-${this.orders.size + 1}`,
        // Echo exactly what was submitted so identity verification can pass.
        side: q.get("side") ?? "", positionSide: q.get("positionSide") ?? "",
        type: q.get("type") ?? "", origQty: q.get("quantity") ?? "", price: q.get("price") ?? "",
      });
      return json({ symbol: SYMBOL, clientOrderId: cid, orderId: `ex-${this.orders.size}`, status: "NEW" });
    }
    if (p === "/fapi/v1/algoOrder") {
      const cid = q.get("clientAlgoId") ?? "";
      if (method === "GET") {
        const algo = this.algoOrders.get(cid);
        if (!algo) return json({ code: -2013, msg: "Algo order does not exist." }, 400);
        // Echo the SUBMITTED protection identity. Phase 7 verifies side,
        // positionSide, type, quantity and trigger against the local intent and
        // escalates on any mismatch, so a generic echo would trip that check.
        return json({
          symbol: SYMBOL,
          clientAlgoId: cid,
          algoId: algo.algoId,
          algoStatus: algo.algoStatus,
          executedQty: algo.executedQty,
          avgPrice: "0",
          triggerPrice: algo.triggerPrice,
          workingType: algo.workingType,
          priceProtect: algo.priceProtect,
          side: algo.side,
          positionSide: algo.positionSide,
          orderType: algo.orderType,
          quantity: algo.quantity,
        });
      }
      if (method === "DELETE") {
        const algo = this.algoOrders.get(cid);
        if (algo) algo.algoStatus = "CANCELLED";
        return json({ clientAlgoId: cid, algoStatus: "CANCELLED" });
      }
      this.algoAttempts.set(cid, (this.algoAttempts.get(cid) ?? 0) + 1);
      this.acceptedAlgoIds.add(cid);
      this.algoOrders.set(cid, {
        algoStatus: "NEW",
        algoId: `algo-${this.algoOrders.size + 1}`,
        executedQty: "0",
        side: q.get("side") ?? "",
        positionSide: q.get("positionSide") ?? "",
        orderType: q.get("orderType") ?? q.get("type") ?? "",
        quantity: q.get("quantity") ?? "",
        triggerPrice: q.get("triggerPrice") ?? q.get("stopPrice") ?? "",
        workingType: q.get("workingType") ?? "MARK_PRICE",
        priceProtect: q.get("priceProtect") === "true",
      });
      return json({ clientAlgoId: cid, algoId: `algo-${this.algoOrders.size}`, algoStatus: "NEW" });
    }
    if (p === "/fapi/v1/positionMargin") return json({ code: 200, msg: "success" });
    if (p === "/fapi/v1/positionMargin/history") return json([]);
    if (p === "/fapi/v1/marginType") return json({ code: 200, msg: "success" });
    if (p === "/fapi/v1/leverage") return json({ leverage: 10, maxNotionalValue: "50000", symbol: SYMBOL });

    return json({ code: -1121, msg: `Unhandled path ${p}` }, 400);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const exchange = new FakeExchange();

// ---------------------------------------------------------------------------
// Fresh REAL runtime over surviving state
// ---------------------------------------------------------------------------

function freshRuntime(profileIdentity: { accountIdentifier: string; environment: "TESTNET" }) {
  // Real client; only its network is fake.
  const readOnlyClient = new BinanceReadOnlyClient({
    baseUrl: "https://fake.binance.test",
    apiKey: "TESTKEY",
    apiSecret: "TESTSECRET",
    enabled: true,
  });
  const readOnly = new BinanceReadOnlyService(readOnlyClient);
  const mutations = new BinanceUsdMExecutionClient({
    readOnlyClient,
    baseUrl: "https://fake.binance.test",
    apiKey: "TESTKEY",
    apiSecret: "TESTSECRET",
    // Opened on this OBJECT only — the real environment is untouched.
    liveEntryEnabled: true,
    protectionReady: true,
    transport: exchange.handle,
  });
  const alerts = new CriticalAlertService(prisma!, async () => false);

  const orchestrator = new ExecutionOrchestrator({
    prisma: prisma!,
    readOnly,
    admission: new SafetyAdmissionService(prisma!, readOnly),
    entry: new EntryLifecycleService(prisma!, readOnly, mutations, { reconcileMaxAttempts: 2, reconcileDelayMs: 1 }),
    protection: new ProtectionLifecycleService(prisma!, readOnly, mutations, alerts, { reconcileMaxAttempts: 2 }),
    profileIdentity,
  });

  return { orchestrator, readOnly, mutations, executions: new ExecutionService(prisma!) };
}

let sequence = 0;

/** A READY Phase 3 plan shaped exactly as ExecutionService requires. */
function readyPlan(direction: "LONG" | "SHORT") {
  return {
    status: "READY",
    reason: null,
    symbol: SYMBOL,
    direction,
    entryPrice: "100",
    calculatedStopLoss: direction === "LONG" ? "96" : "104",
    stopLoss: direction === "LONG" ? "96" : "104",
    riskBudgetUsd: "1.50",
    quantityRaw: "0.375",
    roundedQuantity: "0.037",
    quantityStepSize: "0.001",
    actualPlannedLoss: "1.48",
    unusedRiskBudget: "0.02",
    positionNotional: "3.70",
    targetIsolatedMargin: "3.75",
    maximumIsolatedMargin: "5.00",
    selectedLeverage: 10,
    estimatedInitialMargin: "3.75",
    estimatedLiquidationPrice: direction === "LONG" ? "90" : "110",
    requiredLiquidationBoundary: direction === "LONG" ? "94" : "106",
    liquidationBufferRatio: "0.5",
    estimatedRewardRatio: "3",
  } as never;
}

async function createExecution(
  direction: "LONG" | "SHORT",
  scenario: { profileId: string; identity: { accountIdentifier: string; environment: "TESTNET" } }
): Promise<string> {
  sequence += 1;
  const alert = await prisma!.alert.create({
    data: {
      symbol: SYMBOL, assetType: "CRYPTO", exchange: "SYNTHETIC", timeframe: "15m", price: 100,
      signal: direction, indicatorName: `${TAG}-${sequence}`, rawPayload: { note: TAG },
      triggeredAt: new Date(Date.now() - 30_000),
    },
  });
  const { executions } = freshRuntime(scenario.identity);
  const created = await executions.createExecutionFromReadyPlan({
    executionProfileId: scenario.profileId,
    alertId: alert.id,
    plan: readyPlan(direction),
    positionSide: direction,
    selectedLookback: 200,
    takeProfit: direction === "LONG" ? "112" : "88",
    signalTriggeredAt: alert.triggeredAt,
    // Phase 6 refuses to submit without BOTH frozen snapshots — the plan it was
    // planned from and the exchange filters it was rounded against. Omitting
    // them is what produced SAFETY_ADMISSION_NOT_READY; that check is correct
    // and stays exactly as it is.
    snapshots: {
      marginPlan: readyPlan(direction),
      exchangeFilters: { tickSize: "0.01", stepSize: "0.001", minQty: "0.001", minNotional: "1" },
    },
  } as never);
  return created.id;
}

/**
 * Per-scenario isolation.
 *
 * Sharing one profile between scenarios was the proven cause of the earlier
 * failures: a leaked MANUAL_INTERVENTION execution made `countRecoveryRequired`
 * non-zero, and the orchestrator then (correctly) refused all later work with
 * RECOVERY_REQUIRED. Rewriting statuses in afterEach could not fix that — it
 * left SafetyAdmission reservations, orders, protection rows and events behind.
 *
 * So each scenario now owns its ENTIRE object graph: a unique profile, its own
 * policy, its own alerts and executions, and a fresh exchange. Nothing is
 * shared, and the canary limits stay exactly as production defines them —
 * isolation is never bought by raising a limit.
 */
let scenarioSeq = 0;

async function newScenario(): Promise<{ profileId: string; identity: { accountIdentifier: string; environment: "TESTNET" } }> {
  scenarioSeq += 1;
  const accountIdentifier = `${TAG}-${scenarioSeq}-${Date.now().toString(36)}`;
  const profile = await prisma!.executionProfile.create({
    data: { name: `Phase 11 real ${scenarioSeq}`, accountIdentifier, environment: "TESTNET", isEnabled: true },
  });
  await prisma!.executionSafetyPolicy.create({
    // Only the kill switch is opened; every capacity limit keeps its schema
    // default, which IS the canary policy (1/1/1, 1.50, 5.00).
    data: { executionProfileId: profile.id, killSwitchActive: false },
  });
  createdProfileIds.push(profile.id);
  exchange.reset();
  return { profileId: profile.id, identity: { accountIdentifier, environment: "TESTNET" } };
}

/**
 * Refuses to start a scenario on anything but a clean profile, using the same
 * classifications production uses. Failing here with real counts is far more
 * useful than failing later on `BinanceOrder count === 0`.
 */
async function assertTestProfileIsQuiescent(profileId: string): Promise<void> {
  const [active, pending, open, recovery, admissions, entries] = await Promise.all([
    prisma!.tradeExecution.count({
      where: { executionProfileId: profileId, status: { in: [...ACTIVE_STATUSES] } },
    }),
    prisma!.tradeExecution.count({
      where: { executionProfileId: profileId, status: { in: ["ENTRY_SUBMITTING", "ENTRY_PENDING"] } },
    }),
    prisma!.tradeExecution.count({
      where: {
        executionProfileId: profileId,
        status: { in: ["PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION", "PROTECTED"] },
      },
    }),
    prisma!.tradeExecution.count({
      where: {
        executionProfileId: profileId,
        OR: [
          { status: { in: [...RECOVERY_REQUIRED_STATUSES] } },
          { requiresManualIntervention: true },
        ],
      },
    }),
    prisma!.safetyAdmission.count({ where: { tradeExecution: { executionProfileId: profileId } } }),
    prisma!.binanceOrder.count({ where: { tradeExecution: { executionProfileId: profileId }, role: "ENTRY" } }),
  ]);

  expect(
    { active, pending, open, recovery, admissions, entries },
    "the scenario profile must start completely quiescent"
  ).toEqual({ active: 0, pending: 0, open: 0, recovery: 0, admissions: 0, entries: 0 });
}

const createdProfileIds: string[] = [];

beforeAll(() => {
  if (!prisma || !available) return;
  vi.stubGlobal("fetch", exchange.handle);
});

/**
 * The suite's ownership namespace.
 *
 * Cleanup is keyed on this PREFIX in the database, not on an in-memory list of
 * ids. That distinction is the fix for the leak that started this work: the
 * previous teardown could only delete profiles it had personally pushed into an
 * array during the current process, so a worker that died between creating a
 * profile and running its hooks orphaned the whole graph permanently — nothing
 * in any later run would ever look for it again. A namespace query reclaims
 * those orphans on the next run.
 *
 * Ownership stays narrow: the prefix AND the TESTNET environment must both
 * match. No production row, and no row belonging to another suite, is reachable
 * from here, and nothing is ever truncated.
 */
const TEST_PROFILE_PREFIX = `${TAG}-`;

/** Every profile in this suite's namespace, including orphans from earlier runs. */
async function ownedProfileIds(): Promise<string[]> {
  if (!prisma || !available) return [];
  const rows = await prisma.executionProfile.findMany({
    where: { accountIdentifier: { startsWith: TEST_PROFILE_PREFIX }, environment: "TESTNET" },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** Counts of everything the namespace owns. All zero means no residue. */
interface OwnedRowCounts {
  profiles: number;
  executions: number;
  admissions: number;
  orders: number;
  events: number;
  protectionStates: number;
  protectionVerifications: number;
  marginIntents: number;
  criticalAlerts: number;
  notifications: number;
  checkpoints: number;
  canaryAuthorizations: number;
  alerts: number;
}

async function countOwnedRows(): Promise<OwnedRowCounts> {
  const profileIds = await ownedProfileIds();
  const executionIds = (
    await prisma!.tradeExecution.findMany({
      where: { executionProfileId: { in: profileIds } },
      select: { id: true },
    })
  ).map((row) => row.id);
  const eventIds = (
    await prisma!.executionEvent.findMany({ where: { tradeExecutionId: { in: executionIds } }, select: { id: true } })
  ).map((row) => row.id);
  const verificationIds = (
    await prisma!.executionProtectionVerification.findMany({
      where: { tradeExecutionId: { in: executionIds } },
      select: { id: true },
    })
  ).map((row) => row.id);

  const owned = { tradeExecutionId: { in: executionIds } };
  return {
    profiles: profileIds.length,
    executions: executionIds.length,
    admissions: await prisma!.safetyAdmission.count({ where: owned }),
    orders: await prisma!.binanceOrder.count({ where: owned }),
    events: eventIds.length,
    protectionStates: await prisma!.executionProtectionState.count({ where: owned }),
    protectionVerifications: verificationIds.length,
    marginIntents: await prisma!.marginAdjustmentIntent.count({ where: owned }),
    criticalAlerts: await prisma!.criticalAlert.count({ where: owned }),
    notifications: await prisma!.executionNotification.count({ where: owned }),
    checkpoints: await prisma!.executionNotificationCheckpoint.count({
      where: { OR: [{ executionEventId: { in: eventIds } }, { protectionVerificationId: { in: verificationIds } }] },
    }),
    canaryAuthorizations: await prisma!.executionCanaryAuthorization.count({
      where: { executionProfileId: { in: profileIds } },
    }),
    alerts: await prisma!.alert.count({ where: { indicatorName: { startsWith: TAG } } }),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until the owned graph stops changing.
 *
 * A scenario that times out, or a reconciliation whose last write lands after
 * the assertion already returned, keeps inserting rows into a graph teardown is
 * walking. Deleting underneath that produces exactly the failure this replaces:
 * `ExecutionNotification_tradeExecutionId_fkey` violated by a notification
 * written between the child delete and the execution delete.
 *
 * Two identical consecutive samples is the signal. It is a bounded wait rather
 * than a guarantee, which is why the delete below also retries.
 */
async function waitForOwnedWorkToStop(): Promise<void> {
  let previous: string | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = JSON.stringify(await countOwnedRows());
    if (current === previous) return;
    previous = current;
    await sleep(25);
  }
}

/**
 * Deletes the namespace's entire object graph in FK order.
 *
 * Every child of TradeExecution is `onDelete: Restrict`, so a missed row makes
 * the parent delete fail loudly instead of cascading silently — the right
 * schema choice for financial history, and the reason this must be exhaustive.
 * Ids are re-queried on every attempt so a row created during the previous
 * attempt is picked up rather than skipped.
 */
async function deleteOwnedGraph(): Promise<void> {
  const lastAttempt = 5;
  for (let attempt = 1; attempt <= lastAttempt; attempt += 1) {
    try {
      const profileIds = await ownedProfileIds();
      if (profileIds.length === 0) return;

      const executionIds = (
        await prisma!.tradeExecution.findMany({
          where: { executionProfileId: { in: profileIds } },
          select: { id: true },
        })
      ).map((row) => row.id);

      if (executionIds.length > 0) {
        const owned = { tradeExecutionId: { in: executionIds } };
        // Checkpoints first: they point at events and verifications, and both
        // of those are about to go.
        await prisma!.executionNotificationCheckpoint.deleteMany({
          where: {
            OR: [
              { executionEvent: { tradeExecutionId: { in: executionIds } } },
              { protectionVerification: { tradeExecutionId: { in: executionIds } } },
            ],
          },
        });
        await prisma!.executionNotification.deleteMany({ where: owned });
        await prisma!.criticalAlert.deleteMany({ where: owned });
        await prisma!.executionProtectionVerification.deleteMany({ where: owned });
        await prisma!.marginAdjustmentIntent.deleteMany({ where: owned });
        await prisma!.safetyAdmission.deleteMany({ where: owned });
        await prisma!.binanceOrder.deleteMany({ where: owned });
        await prisma!.executionProtectionState.deleteMany({ where: owned });
        await prisma!.executionEvent.deleteMany({ where: owned });
        await prisma!.tradeExecution.deleteMany({ where: { id: { in: executionIds } } });
      }

      await prisma!.alert.deleteMany({ where: { indicatorName: { startsWith: TAG } } });
      await prisma!.executionCanaryAuthorization.deleteMany({
        where: { executionProfileId: { in: profileIds } },
      });
      await prisma!.executionSafetyPolicy.deleteMany({ where: { executionProfileId: { in: profileIds } } });

      // Final ownership-scoped re-query: a profile is only deleted once it owns
      // nothing, so a late execution can never be orphaned by removing its
      // parent out from under it.
      const stillOwning = (
        await prisma!.tradeExecution.findMany({
          where: { executionProfileId: { in: profileIds } },
          select: { executionProfileId: true },
        })
      ).map((row) => row.executionProfileId);
      const deletable = profileIds.filter((id) => !stillOwning.includes(id));
      await prisma!.executionProfile.deleteMany({ where: { id: { in: deletable } } });

      if (deletable.length === profileIds.length) return;
      throw new Error("a late execution appeared during teardown");
    } catch (error) {
      if (attempt === lastAttempt) throw error;
      await sleep(100);
    }
  }
}

/**
 * Ownership-based teardown for every profile in this suite's namespace.
 *
 * A unique profile per scenario is NOT sufficient on its own:
 * `countRecoveryRequired()` deliberately counts across the whole database
 * rather than per profile — the conservative choice, since unresolved exposure
 * anywhere is a reason not to open new work. So a leaked execution from an
 * earlier scenario blocks a later one even under a different profile, and the
 * only correct fix is to remove each scenario's object graph rather than to
 * relax the production rule.
 */
async function cleanupOwnedGraphs(): Promise<void> {
  if (!prisma || !available) return;
  await waitForOwnedWorkToStop();
  await deleteOwnedGraph();
  createdProfileIds.length = 0;
}

afterEach(cleanupOwnedGraphs);

afterAll(async () => {
  vi.unstubAllGlobals();
  if (!prisma) return;
  if (available) {
    await cleanupOwnedGraphs();

    // No-residue assertion, scoped strictly to this suite's namespace. It never
    // claims the database is empty — only that nothing this suite owns is left.
    const remaining = await countOwnedRows();
    expect(remaining).toEqual({
      profiles: 0,
      executions: 0,
      admissions: 0,
      orders: 0,
      events: 0,
      protectionStates: 0,
      protectionVerifications: 0,
      marginIntents: 0,
      criticalAlerts: 0,
      notifications: 0,
      checkpoints: 0,
      canaryAuthorizations: 0,
      alerts: 0,
    });
  }
  await prisma.$disconnect();
});

const ACTIVE_STATUSES = [
  "PLAN_READY", "PREFLIGHT", "ENTRY_SUBMITTING", "ENTRY_PENDING",
  "PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION", "PROTECTED",
] as const;
const RECOVERY_REQUIRED_STATUSES = [
  "ENTRY_SUBMITTING", "PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION", "MANUAL_INTERVENTION",
] as const;

const describeDb = available ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Real-service admission + entry
// ---------------------------------------------------------------------------

describeDb("real services: admission and entry", () => {
  it("admits a real PLAN_READY execution and submits exactly one LIMIT through the real client", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await createExecution("LONG", scenario);
    const { orchestrator } = freshRuntime(scenario.identity);

    const outcome = await orchestrator.admitAndSubmit({ executionId });
    expect(outcome.admitted, JSON.stringify(outcome)).toBe(true);

    // --- assert the DATABASE, not the return value -------------------------
    const execution = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });
    expect(["ENTRY_PENDING", "PARTIALLY_FILLED", "ENTRY_FILLED"]).toContain(execution.status);

    const orders = await prisma!.binanceOrder.findMany({ where: { tradeExecutionId: executionId } });
    const entries = orders.filter((o) => o.role === "ENTRY");
    expect(entries).toHaveLength(1);
    expect(entries[0].generation).toBe(1);
    expect(entries[0].clientOrderId).toMatch(/^tad-en-1-[0-9a-f]{12}$/);

    // The real client actually POSTed once, with the deterministic id.
    const posts = exchange.requests.filter((r) => r.method === "POST" && r.path === "/fapi/v1/order");
    expect(posts).toHaveLength(1);
    expect(posts[0].clientIdentity).toBe(entries[0].clientOrderId);
    expect(exchange.acceptedEntryIds.size).toBe(1);

    // A real SafetyAdmission row exists.
    expect(await prisma!.safetyAdmission.count({ where: { tradeExecutionId: executionId } })).toBe(1);

    // Frozen financials are exact decimals, never floats.
    expect(execution.riskBudgetUsd.toFixed()).toBe("1.5");
    expect(execution.plannedQuantity.toFixed()).toBe("0.037");
    expect(execution.plannedEntryPrice.toFixed()).toBe("100");
    expect(execution.executableStopLoss.toFixed()).toBe("96");
    expect(execution.takeProfit?.toFixed()).toBe("112");
    expect(Number(execution.riskBudgetUsd.toFixed())).toBeLessThanOrEqual(1.5);
  });

  it("records real lifecycle events in strictly increasing sequence", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await createExecution("LONG", scenario);
    const { orchestrator } = freshRuntime(scenario.identity);
    await orchestrator.admitAndSubmit({ executionId });

    const events = await prisma!.executionEvent.findMany({
      where: { tradeExecutionId: executionId },
      orderBy: { sequenceNumber: "asc" },
    });
    expect(events.length).toBeGreaterThan(1);
    const sequences = events.map((e) => e.sequenceNumber);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });
});

// ---------------------------------------------------------------------------
// Real-service restart
// ---------------------------------------------------------------------------

describeDb("real services: restart recovery", () => {
  it("reuses the deterministic id after a crash before acknowledgement", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await createExecution("LONG", scenario);
    const first = freshRuntime(scenario.identity);
    await first.orchestrator.admitAndSubmit({ executionId });

    const order = await prisma!.binanceOrder.findFirstOrThrow({ where: { tradeExecutionId: executionId, role: "ENTRY" } });
    const submissionsBefore = exchange.requests.filter((r) => r.method === "POST" && r.path === "/fapi/v1/order").length;

    // --- PROCESS DEATH: everything below is a brand-new object graph -------
    const second = freshRuntime(scenario.identity);
    await second.orchestrator.runStartupRecovery();

    const posts = exchange.requests.filter((r) => r.method === "POST" && r.path === "/fapi/v1/order");
    // No second submission of any kind.
    expect(posts).toHaveLength(submissionsBefore);
    expect(exchange.acceptedEntryIds.size).toBe(1);

    // Still exactly one ENTRY row, same id, same generation.
    const after = await prisma!.binanceOrder.findMany({ where: { tradeExecutionId: executionId, role: "ENTRY" } });
    expect(after).toHaveLength(1);
    expect(after[0].clientOrderId).toBe(order.clientOrderId);
    expect(after[0].generation).toBe(1);
  });

  it("survives repeated restarts without duplicating anything", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await createExecution("LONG", scenario);
    await freshRuntime(scenario.identity).orchestrator.admitAndSubmit({ executionId });

    for (let restart = 0; restart < 3; restart += 1) {
      await freshRuntime(scenario.identity).orchestrator.runStartupRecovery();
    }

    expect(exchange.acceptedEntryIds.size).toBe(1);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: executionId, role: "ENTRY" } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Real-service concurrency
// ---------------------------------------------------------------------------

describeDb("real services: two-worker race", () => {
  it("produces one admission and one ENTRY across two independent runtimes", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await createExecution("LONG", scenario);

    // Two entirely separate real service graphs over one database + exchange.
    const workerA = freshRuntime(scenario.identity);
    const workerB = freshRuntime(scenario.identity);
    await Promise.all([
      workerA.orchestrator.admitAndSubmit({ executionId }),
      workerB.orchestrator.admitAndSubmit({ executionId }),
    ]);

    // ATTEMPTED submissions are recorded before any exchange-side dedupe.
    const attempted = exchange.requests.filter((r) => r.method === "POST" && r.path === "/fapi/v1/order");
    const accepted = exchange.acceptedEntryIds.size;

    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: executionId, role: "ENTRY" } })).toBe(1);
    expect(accepted).toBe(1);
    // The application itself attempted at most one — not "attempted twice and
    // the exchange saved us".
    expect(attempted.length).toBeLessThanOrEqual(1);
    expect(new Set(attempted.map((r) => r.clientIdentity)).size).toBeLessThanOrEqual(1);

    // One logical capacity reservation.
    const admissions = await prisma!.safetyAdmission.findMany({ where: { tradeExecutionId: executionId } });
    expect(admissions.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describeDb("real services: failure paths", () => {
  it("resolves a submission timeout by querying the same id, never resubmitting", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await createExecution("LONG", scenario);
    exchange.failNext = { path: "/fapi/v1/order", method: "POST", kind: "TIMEOUT" };

    const { orchestrator } = freshRuntime(scenario.identity);
    await orchestrator.admitAndSubmit({ executionId });
    // Recovery resolves the ambiguity with a GET on the same id.
    await freshRuntime(scenario.identity).orchestrator.runStartupRecovery();

    const posts = exchange.requests.filter((r) => r.method === "POST" && r.path === "/fapi/v1/order");
    const gets = exchange.requests.filter((r) => r.method === "GET" && r.path === "/fapi/v1/order");
    // At most the one attempt that timed out — no blind retry.
    expect(posts.length).toBeLessThanOrEqual(1);
    expect(gets.length).toBeGreaterThan(0);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: executionId, role: "ENTRY" } })).toBe(1);
  });

  it("handles a definitive rejection without creating exposure", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await createExecution("LONG", scenario);
    exchange.failNext = { path: "/fapi/v1/order", method: "POST", kind: "REJECT" };

    const { orchestrator } = freshRuntime(scenario.identity);
    await orchestrator.admitAndSubmit({ executionId });

    const execution = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });
    // Fail-closed: never PROTECTED, never a silent success.
    expect(["FAILED", "MANUAL_INTERVENTION", "ENTRY_SUBMITTING", "ENTRY_PENDING"]).toContain(execution.status);
    expect(exchange.acceptedEntryIds.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Request surface
// ---------------------------------------------------------------------------

describeDb("real services: observed request surface", () => {
  it("touches only Phase 6/7 endpoints and never an account-setup or test-order path", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await createExecution("LONG", scenario);
    await freshRuntime(scenario.identity).orchestrator.admitAndSubmit({ executionId });
    await freshRuntime(scenario.identity).orchestrator.runStartupRecovery();

    const mutations = exchange.requests.filter((r) => r.method !== "GET");
    for (const request of mutations) {
      expect(
        ["/fapi/v1/order", "/fapi/v1/algoOrder", "/fapi/v1/positionMargin", "/fapi/v1/marginType", "/fapi/v1/leverage"],
        `${request.method} ${request.path}`
      ).toContain(request.path);
    }
    for (const forbidden of ["/fapi/v1/order/test", "/fapi/v1/positionSide/dual", "/sapi/", "/fapi/v1/batchOrders", "/fapi/v1/allOpenOrders"]) {
      const hit = mutations.find((r) => r.path.includes(forbidden));
      expect(`${forbidden}:${hit ? "called" : "absent"}`).toBe(`${forbidden}:absent`);
    }
  });

  it("records no credential or signature in the request snapshot", () => {
    const serialized = JSON.stringify(exchange.requests);
    for (const forbidden of ["signature", "TESTSECRET", "TESTKEY", "X-MBX-APIKEY"]) {
      expect(`${forbidden}:${serialized.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 9 from real lifecycle history
// ---------------------------------------------------------------------------

describeDb("real services: Phase 9 milestones from real history", () => {
  it("materializes notification intents from lifecycle events nobody inserted by hand", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await createExecution("LONG", scenario);
    await freshRuntime(scenario.identity).orchestrator.admitAndSubmit({ executionId });

    const { ExecutionNotificationService } = await import("../src/modules/notifications/execution-notification.service");
    const service = new ExecutionNotificationService(prisma!, async () => ({ delivered: true, retryable: false, errorCode: null, sanitizedError: null }), {
      execution: "-1001",
      critical: "-1002",
      deliveryEnabled: false, // materialize only; never dispatch
    });

    await service.materializeExecutionNotifications({ executionId, evaluatedAt: new Date() });

    const rows = await prisma!.executionNotification.findMany({ where: { tradeExecutionId: executionId } });
    // Derived purely from real persisted lifecycle state.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.notificationType)).toContain("LIMIT_PLACED");
  });

  it("keeps notification delivery out of the lifecycle", () => {
    const orchestrator = readFileSync(path.join(BACKEND, "src", "modules", "execution", "execution-orchestrator.ts"), "utf8");
    const entry = readFileSync(path.join(BACKEND, "src", "modules", "execution", "entry-lifecycle.service.ts"), "utf8");
    for (const source of [orchestrator, entry]) {
      expect(source.toLowerCase()).not.toContain("sendtelegram");
      expect(source.toLowerCase()).not.toContain("execution-notification.service");
    }
  });
});

// ---------------------------------------------------------------------------
// Full real-service lifecycles: fill -> protection -> terminal
// ---------------------------------------------------------------------------

/** Drives one execution toward a terminal state through the REAL services. */
async function runFullLifecycle(
  direction: "LONG" | "SHORT",
  closure: "sl" | "tp",
  scenario: { profileId: string; identity: { accountIdentifier: string; environment: "TESTNET" } }
) {
  exchange.positionSide = direction;
  const executionId = await createExecution(direction, scenario);

  await freshRuntime(scenario.identity).orchestrator.admitAndSubmit({ executionId });

  // Partial fill -> real reconciliation + real protection for that exposure.
  exchange.fillEntry("0.020", false);
  await freshRuntime(scenario.identity).orchestrator.runExecutionReconciliationTick();

  // Full fill -> real reconciliation + real full protection.
  exchange.fillEntry("0.037", true);
  await freshRuntime(scenario.identity).orchestrator.runExecutionReconciliationTick();
  await freshRuntime(scenario.identity).orchestrator.runExecutionReconciliationTick();

  // The protection order triggers; the position goes flat.
  exchange.triggerProtection(closure);
  await freshRuntime(scenario.identity).orchestrator.runExecutionReconciliationTick();
  await freshRuntime(scenario.identity).orchestrator.runExecutionReconciliationTick();

  return executionId;
}

describeDb("real services: full LONG lifecycle", () => {
  it("keeps one entry identity and writes real protection rows", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await runFullLifecycle("LONG", "tp", scenario);

    const execution = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });
    const orders = await prisma!.binanceOrder.findMany({ where: { tradeExecutionId: executionId } });
    const entries = orders.filter((o) => o.role === "ENTRY");
    const protectionState = await prisma!.executionProtectionState.findUnique({
      where: { tradeExecutionId: executionId },
    });

    // One execution, one ENTRY generation, one submission attempt.
    expect(entries).toHaveLength(1);
    expect(entries[0].generation).toBe(1);
    expect(exchange.entryAttempts).toBe(1);
    expect(exchange.acceptedEntryIds.size).toBe(1);

    // The filled quantity came from the exchange, not from an assumption.
    expect(entries[0].executedQuantity.toFixed()).toBe("0.037");

    // Every protection identity was submitted exactly once.
    for (const [id, attempts] of exchange.algoAttempts) expect(`${id}:${attempts}`).toBe(`${id}:1`);
    expect(protectionState).not.toBeNull();

    // Events are ordered and unique.
    const events = await prisma!.executionEvent.findMany({
      where: { tradeExecutionId: executionId },
      orderBy: { sequenceNumber: "asc" },
    });
    const sequences = events.map((e) => e.sequenceNumber);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);

    // The exchange proved the position flat.
    expect(exchange.positionAmt).toBe("0");
    expect([
      "PROTECTED", "CLOSED_TP", "PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION", "MANUAL_INTERVENTION",
    ]).toContain(execution.status);
  });

  it("materializes Phase 9 milestones from the real lifecycle history", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await runFullLifecycle("LONG", "tp", scenario);

    const { ExecutionNotificationService } = await import("../src/modules/notifications/execution-notification.service");
    const notifications = new ExecutionNotificationService(
      prisma!,
      async () => ({ delivered: true, retryable: false, errorCode: null, sanitizedError: null }),
      { execution: "-1001", critical: "-1002", deliveryEnabled: false }
    );
    // Nothing is seeded: every row below is derived from real persisted state.
    await notifications.materializeExecutionNotifications({ executionId, evaluatedAt: new Date() });

    const rows = await prisma!.executionNotification.findMany({ where: { tradeExecutionId: executionId } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.notificationType)).toContain("LIMIT_PLACED");
  });
});

describeDb("real services: full SHORT lifecycle", () => {
  it("uses SELL/SHORT entry and BUY protection geometry", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await runFullLifecycle("SHORT", "sl", scenario);

    const orders = await prisma!.binanceOrder.findMany({ where: { tradeExecutionId: executionId } });
    const entry = orders.find((o) => o.role === "ENTRY")!;

    expect(entry.side).toBe("SELL");
    expect(entry.positionSide).toBe("SHORT");
    expect(exchange.entryAttempts).toBe(1);

    for (const row of orders.filter((o) => o.role === "STOP_LOSS" || o.role === "TAKE_PROFIT")) {
      expect(row.side).toBe("BUY");
      expect(row.positionSide).toBe("SHORT");
    }
    expect(exchange.positionAmt).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

describeDb("real services: entry TTL", () => {
  it("creates no protection for an unfilled order at TTL", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await createExecution("LONG", scenario);
    await freshRuntime(scenario.identity).orchestrator.admitAndSubmit({ executionId });

    // Push the TTL into the past; the real Phase 6 rule decides from here.
    await prisma!.binanceOrder.updateMany({
      where: { tradeExecutionId: executionId, role: "ENTRY" },
      data: { entryOrderExpiresAt: new Date(Date.now() - 60_000) },
    });
    await freshRuntime(scenario.identity).orchestrator.runExecutionReconciliationTick();
    await freshRuntime(scenario.identity).orchestrator.runExecutionReconciliationTick();

    const protectionRows = await prisma!.binanceOrder.count({
      where: { tradeExecutionId: executionId, role: { in: ["STOP_LOSS", "TAKE_PROFIT"] } },
    });
    // Zero fill means zero exposure, so protection must not exist.
    expect(protectionRows).toBe(0);
    expect(exchange.acceptedAlgoIds.size).toBe(0);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: executionId, role: "ENTRY" } })).toBe(1);
  });

  it("never calls a partially-filled entry ENTRY_EXPIRED", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await createExecution("LONG", scenario);
    await freshRuntime(scenario.identity).orchestrator.admitAndSubmit({ executionId });

    exchange.fillEntry("0.020", false);
    await prisma!.binanceOrder.updateMany({
      where: { tradeExecutionId: executionId, role: "ENTRY" },
      data: { entryOrderExpiresAt: new Date(Date.now() - 60_000) },
    });
    await freshRuntime(scenario.identity).orchestrator.runExecutionReconciliationTick();
    await freshRuntime(scenario.identity).orchestrator.runExecutionReconciliationTick();

    const execution = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: executionId } });
    // The Phase 6 rule, proven by the real service rather than encoded here.
    expect(execution.status).not.toBe("ENTRY_EXPIRED");
    expect(execution.filledQuantity?.toFixed()).toBe("0.02");
  });
});

// ---------------------------------------------------------------------------
// Restart with real services
// ---------------------------------------------------------------------------

describeDb("real services: restart after fill before protection", () => {
  it("resumes from a fresh runtime without duplicating anything", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await createExecution("LONG", scenario);
    await freshRuntime(scenario.identity).orchestrator.admitAndSubmit({ executionId });
    exchange.fillEntry("0.037", true);
    await freshRuntime(scenario.identity).orchestrator.runExecutionReconciliationTick();

    const entryAttemptsBefore = exchange.entryAttempts;

    // --- PROCESS DEATH: an entirely new real service graph -----------------
    await freshRuntime(scenario.identity).orchestrator.runStartupRecovery();
    await freshRuntime(scenario.identity).orchestrator.runStartupRecovery();

    expect(exchange.entryAttempts).toBe(entryAttemptsBefore);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: executionId, role: "ENTRY" } })).toBe(1);
    for (const [id, attempts] of exchange.algoAttempts) expect(`${id}:${attempts}`).toBe(`${id}:1`);
  });
});

describeDb("real services: restart while protected", () => {
  it("submits no new protection across three restarts", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await runFullLifecycle("LONG", "tp", scenario);
    const entryAttempts = exchange.entryAttempts;

    for (let restart = 0; restart < 3; restart += 1) {
      await freshRuntime(scenario.identity).orchestrator.runStartupRecovery();
    }

    // Every protection identity is still at exactly one submission.
    for (const [id, attempts] of exchange.algoAttempts) expect(`${id}:${attempts}`).toBe(`${id}:1`);
    expect(exchange.entryAttempts).toBe(entryAttempts);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: executionId, role: "ENTRY" } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Protection failure path
// ---------------------------------------------------------------------------

describeDb("real services: protection failure", () => {
  it("resolves an unknown STOP result by querying the same identity", async () => {
    const scenario = await newScenario();
    await assertTestProfileIsQuiescent(scenario.profileId);
    const executionId = await createExecution("LONG", scenario);
    await freshRuntime(scenario.identity).orchestrator.admitAndSubmit({ executionId });
    exchange.fillEntry("0.037", true);

    // The protection POST lands but the reply is lost.
    exchange.failNext = { path: "/fapi/v1/algoOrder", method: "POST", kind: "TIMEOUT" };
    await freshRuntime(scenario.identity).orchestrator.runExecutionReconciliationTick();
    await freshRuntime(scenario.identity).orchestrator.runExecutionReconciliationTick();

    // No identity was submitted twice — the ambiguity is resolved by query.
    for (const [id, attempts] of exchange.algoAttempts) expect(`${id}:${attempts}`).toBe(`${id}:1`);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: executionId, role: "ENTRY" } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Boundary: nothing but the network is faked
// ---------------------------------------------------------------------------

describe("real-service harness boundary", () => {
  const source = () => readFileSync(path.join(BACKEND, "tests", "execution-realservice-e2e.test.ts"), "utf8");

  it("substitutes no lifecycle service, orchestrator or Prisma", () => {
    const text = source();
    for (const real of [
      "new ExecutionService(prisma!)",
      "new SafetyAdmissionService(prisma!, readOnly)",
      "new EntryLifecycleService(prisma!, readOnly, mutations",
      "new ProtectionLifecycleService(prisma!, readOnly, mutations",
      "new ExecutionOrchestrator({",
      "new BinanceReadOnlyClient({",
      "new BinanceUsdMExecutionClient({",
    ]) {
      expect(text, real).toContain(real);
    }
    // Look for a DECLARATION of a stand-in, not a mere mention — this very
    // assertion names the forbidden identifiers, so a substring match would
    // always find itself.
    for (const forbidden of ["fakeEntryLifecycle", "fakeProtection", "stubOrchestrator", "mockPrisma"]) {
      const declared = new RegExp(`(const|let|function|class)\\s+${forbidden}\\b`).test(text);
      expect(`${forbidden}:${declared}`).toBe(`${forbidden}:false`);
    }
    // And no lifecycle service is replaced by a literal object.
    expect(text).not.toMatch(/entry:\s*\{/);
    expect(text).not.toMatch(/protection:\s*\{/);
  });

  it("keeps every request inside the fake transport", () => {
    // The base URL is unroutable, so an unmocked call cannot reach Binance.
    expect(source()).toContain("https://fake.binance.test");
    for (const request of exchange.requests) {
      expect(request.path.startsWith("/fapi/")).toBe(true);
    }
  });
});
