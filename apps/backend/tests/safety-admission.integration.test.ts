import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";
import type { DynamicLeveragePlan } from "@trading-alert-dashboard/shared";

/**
 * Phase 5 integration tests against a real Postgres.
 *
 * Atomic reservation, per-profile advisory locking, bounded retries and
 * idempotency cannot be proven against a mocked client, so these run on the
 * real database. Every row is synthetic (SYNTHETIC_TAG) and removed in
 * afterAll. Binance is a hand-written read-only stub — no network call is made
 * anywhere in this file, and the stub records every call so the kill-switch
 * short-circuit can be asserted.
 */

const SYNTHETIC_TAG = "phase5-synthetic";

/**
 * Env must be set BEFORE config/env.ts is evaluated, so both the services and
 * the config module are pulled in with dynamic imports below. The connector
 * base URL is pointed at the testnet host so the synthetic TESTNET profile
 * matches the connector environment.
 */
process.env.EXECUTION_GLOBAL_KILL_SWITCH = "false";
process.env.EXECUTION_MAX_OPEN_POSITIONS = "1";
// Pinned WITH the hard cap, never separately: the env schema enforces
// soft <= hard, so leaving this to the operator's .env fails the whole suite
// at import the moment their soft target exceeds this fixture's 1.
process.env.EXECUTION_SOFT_OPEN_POSITION_TARGET = "1";
process.env.EXECUTION_MAX_PENDING_ENTRIES = "1";
process.env.EXECUTION_MAX_TOTAL_ACTIVE_TRADES = "1";
process.env.EXECUTION_MAX_TOTAL_PLANNED_RISK_USD = "1.50";
process.env.EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD = "5.00";
process.env.EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE = "1";
process.env.EXECUTION_MAX_ALERT_AGE_SECONDS = "300";
process.env.BINANCE_FUTURES_REST_BASE_URL = "https://testnet.binancefuture.com";
/**
 * ON for this file so the pre-entry standard take-profit rule is reachable at
 * all — with it OFF the modality resolves to ALGO and the rule is inert, which
 * is itself the flag-off guarantee and is asserted at the engine layer.
 *
 * Safe to set here: vitest runs each file in its own forked process, and `env`
 * is parsed once per process, so this cannot reach any other suite. Every other
 * test in this file leaves `takeProfit` null, where the rule cannot fire.
 */
process.env.EXECUTION_STANDARD_LIMIT_TAKE_PROFIT_ENABLED = "true";

// Integration state lives in the DEDICATED test database. The helper refuses
// to fall back to the runtime/canary database, so a misconfiguration fails the
// suite instead of quietly writing synthetic executions into runtime state.
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ExecutionService } = await import("../src/modules/execution/execution.service");
const { SafetyAdmissionService } = await import("../src/modules/execution/safety-admission.service");
const { SafetyPolicyService } = await import("../src/modules/execution/safety-policy.service");

type ExecutionServiceType = InstanceType<typeof ExecutionService>;
type SafetyAdmissionServiceType = InstanceType<typeof SafetyAdmissionService>;
type SafetyPolicyServiceType = InstanceType<typeof SafetyPolicyService>;

// ---------------------------------------------------------------------------
// Read-only Binance stub — GET-shaped data only, no network, no credentials.
// ---------------------------------------------------------------------------

const SYMBOL = "TESTBUSDT";

interface StubState {
  positionsSymbols: string[];
  openOrderSymbols: string[];
  availableBalance: string | null;
  positionMode: "HEDGE" | "ONE_WAY";
  assetMode: "SINGLE_ASSET" | "MULTI_ASSET";
  failAccount: boolean;
  failSymbol: boolean;
  minNotional: string | null;
  calls: string[];
}

const stub: StubState = {
  positionsSymbols: [],
  openOrderSymbols: [],
  availableBalance: "500.00",
  positionMode: "HEDGE",
  assetMode: "SINGLE_ASSET",
  failAccount: false,
  failSymbol: false,
  // What the connector reports as the symbol's authoritative minimum notional.
  // The admission gate must read THIS, never a constant of its own.
  minNotional: "5" as string | null,
  calls: [],
};

function resetStub() {
  stub.positionsSymbols = [];
  stub.openOrderSymbols = [];
  stub.availableBalance = "500.00";
  stub.positionMode = "HEDGE";
  stub.assetMode = "SINGLE_ASSET";
  stub.failAccount = false;
  stub.failSymbol = false;
  stub.minNotional = "5";
  stub.calls = [];
}

const readOnlyStub = {
  async getAccountSummary() {
    stub.calls.push("getAccountSummary");
    if (stub.failAccount) throw new Error("stubbed connector failure");
    return {
      connection: { ok: true, host: "testnet", serverTimeMs: Date.now(), serverTimeIso: "", clockOffsetMs: 0, roundTripMs: 1 },
      positionMode: stub.positionMode,
      assetMode: stub.assetMode,
      usdtWalletBalance: stub.availableBalance,
      usdtAvailableBalance: stub.availableBalance,
      nonZeroPositionCount: stub.positionsSymbols.length,
      openOrderCount: stub.openOrderSymbols.length,
      openOrderSymbols: stub.openOrderSymbols,
      positions: stub.positionsSymbols.map((symbol) => ({ symbol })),
      warnings: [],
    };
  },
  async inspectSymbol(symbol: string) {
    stub.calls.push(`inspectSymbol:${symbol}`);
    if (stub.failSymbol) throw new Error("stubbed connector failure");
    return {
      filters: {
        symbol,
        status: "TRADING",
        contractType: "PERPETUAL",
        quoteAsset: "USDT",
        marginAsset: "USDT",
        tickSize: "0.01",
        stepSize: "0.001",
        minNotional: stub.minNotional,
      },
      brackets: [{ bracket: 1, initialLeverage: 50, notionalCap: "10000", notionalFloor: "0", maintMarginRatio: "0.01", cum: "0" }],
      maxInitialLeverage: 50,
      accountSymbolConfig: null,
    };
  },
} as unknown as ConstructorParameters<typeof SafetyAdmissionService>[1];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let executions: ExecutionServiceType;
let admissions: SafetyAdmissionServiceType;
let policies: SafetyPolicyServiceType;
let profileId = "";
let otherProfileId = "";
const createdAlertIds: string[] = [];

function readyPlan(overrides: Partial<DynamicLeveragePlan> = {}): DynamicLeveragePlan {
  return {
    status: "READY",
    reason: null,
    reasonMessage: null,
    symbol: SYMBOL,
    direction: "LONG",
    entryPrice: "100",
    stopLoss: "96",
    calculatedStopLoss: "96",
    executableStopLoss: "96",
    stopAdjustment: "0",
    stopNormalization: null,
    stopLossSource: "CALCULATED",
    stopDistance: "4",
    riskBudgetUsd: "1.50",
    quantityRaw: "0.375",
    roundedQuantity: "0.375",
    quantityStepSize: "0.001",
    actualPlannedLoss: "1.5",
    unusedRiskBudget: "0",
    positionNotional: "37.5",
    minimumNotional: "5",
    targetMarginMultiplier: "2.5",
    maximumMarginMultiplier: "3.333333",
    targetIsolatedMargin: "3.75",
    maximumIsolatedMargin: "4.9999995",
    applicableBracket: null,
    maximumSupportedLeverage: 50,
    binanceMaximumSupportedLeverage: 50,
    userMaximumAutomationLeverage: 25,
    usableMaximumLeverage: 25,
    selectedLeverage: 10,
    estimatedInitialMargin: "3.75",
    estimatedLiquidationPrice: "90.1",
    requiredLiquidationBoundary: "94",
    liquidationBufferRatio: "0.5",
    liquidationDistance: "5.9",
    safetyBufferDistance: "2",
    marginDifferenceFromTarget: "0",
    candidates: [],
    warnings: [],
    ...overrides,
  } as DynamicLeveragePlan;
}

async function createSyntheticAlert(suffix: string, triggeredAt = new Date()): Promise<string> {
  const alert = await prisma!.alert.create({
    data: {
      symbol: SYMBOL,
      assetType: "CRYPTO",
      exchange: "SYNTHETIC",
      timeframe: "15m",
      sourceTimeframe: "1W",
      price: 100,
      signal: "LONG",
      indicatorName: `${SYNTHETIC_TAG}-${suffix}`,
      rawPayload: { note: SYNTHETIC_TAG },
      triggeredAt,
    },
  });
  createdAlertIds.push(alert.id);
  return alert.id;
}

let sequence = 0;
async function createExecution(options: {
  profile?: string;
  triggeredAt?: Date;
  plan?: Partial<DynamicLeveragePlan>;
  positionSide?: "LONG" | "SHORT";
  takeProfit?: string;
} = {}) {
  sequence += 1;
  const alertId = await createSyntheticAlert(`e${sequence}`, options.triggeredAt);
  return executions.createExecutionFromReadyPlan({
    executionProfileId: options.profile ?? profileId,
    alertId,
    plan: readyPlan(options.plan),
    positionSide: options.positionSide,
    takeProfit: options.takeProfit,
    selectedLookback: 200,
  });
}

beforeAll(async () => {
  if (!prisma || !available) return;

  executions = new ExecutionService(prisma);
  admissions = new SafetyAdmissionService(prisma, readOnlyStub);
  policies = new SafetyPolicyService(prisma);

  const profile = await prisma.executionProfile.create({
    data: {
      name: "Phase 5 synthetic profile",
      accountIdentifier: `${SYNTHETIC_TAG}-account`,
      environment: "TESTNET",
      isEnabled: true,
    },
  });
  profileId = profile.id;
  await policies.createForProfile(profileId, { killSwitchActive: false });

  const other = await prisma.executionProfile.create({
    data: {
      name: "Phase 5 synthetic profile B",
      accountIdentifier: `${SYNTHETIC_TAG}-account-b`,
      environment: "TESTNET",
      isEnabled: true,
    },
  });
  otherProfileId = other.id;
  await policies.createForProfile(otherProfileId, { killSwitchActive: false });
});

/** Frees capacity between tests without ever deleting execution history. */
afterEach(async () => {
  if (!prisma || !available) return;
  resetStub();
  await prisma.tradeExecution.updateMany({
    where: { executionProfileId: { in: [profileId, otherProfileId] }, status: { notIn: ["SKIPPED", "FAILED"] } },
    data: { status: "FAILED" },
  });
  await policies.getByProfileId(profileId).then(async (policy) => {
    if (policy && policy.killSwitchActive) {
      await policies.updateForProfile(profileId, policy.version, { killSwitchActive: false });
    }
  });
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    const ids = (
      await prisma.tradeExecution.findMany({
        where: { executionProfileId: { in: [profileId, otherProfileId] } },
        select: { id: true },
      })
    ).map((execution) => execution.id);
    if (ids.length > 0) {
      await prisma.safetyAdmission.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      // Phase 9 verification history is Restrict-linked audit data: it must go
      // before the execution it belongs to.
      // Phase 9 notifications are Restrict-linked; they must go first.
      await prisma.executionNotification.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.executionProtectionVerification.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.binanceOrder.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.tradeExecution.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.executionSafetyPolicy.deleteMany({
      where: { executionProfileId: { in: [profileId, otherProfileId] } },
    });
    await prisma.executionProfile.deleteMany({
      where: { accountIdentifier: { startsWith: `${SYNTHETIC_TAG}-account` } },
    });
    await prisma.alert.deleteMany({ where: { indicatorName: { startsWith: SYNTHETIC_TAG } } });
  }
  await prisma.$disconnect();
});

const maybe = () => (available ? it : it.skip);

// ---------------------------------------------------------------------------

describe("signal timestamp provenance", () => {
  maybe()("freezes the original alert triggeredAt onto the execution", async () => {
    const triggeredAt = new Date(Date.now() - 30_000);
    const execution = await createExecution({ triggeredAt });
    expect(execution.signalTriggeredAt?.toISOString()).toBe(triggeredAt.toISOString());
  });

  maybe()("keeps signalTriggeredAt after retention nulls alertId", async () => {
    const execution = await createExecution();
    await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { alertId: null } });
    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.alertId).toBeNull();
    expect(reloaded.signalTriggeredAt).not.toBeNull();
  });

  maybe()("terminally skips a legacy row whose signal time is unknown", async () => {
    const execution = await createExecution();
    await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { signalTriggeredAt: null } });
    const eventsBefore = await prisma!.executionEvent.count({ where: { tradeExecutionId: execution.id } });

    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });

    // The frozen signal time can never appear later, so this is TERMINAL: a
    // retryable decision here would be retried forever.
    expect(outcome.decision).toBe("SKIP");
    expect(outcome.reasonCode).toBe("SIGNAL_TIME_UNAVAILABLE");
    expect(outcome.execution.status).toBe("SKIPPED");
    expect(outcome.execution.version).toBe(execution.version + 1);

    const admissionRows = await prisma!.safetyAdmission.findMany({
      where: { tradeExecutionId: execution.id },
    });
    expect(admissionRows).toHaveLength(1);
    expect(admissionRows[0].reasonCode).toBe("SIGNAL_TIME_UNAVAILABLE");
    expect(admissionRows[0].decision).toBe("SKIP");

    const events = await prisma!.executionEvent.findMany({
      where: { tradeExecutionId: execution.id },
      orderBy: { sequenceNumber: "asc" },
    });
    expect(events.length).toBe(eventsBefore + 1);
    const last = events[events.length - 1];
    expect(last.eventType).toBe("DECISION_RECORDED");
    expect(last.reasonCode).toBe("SIGNAL_TIME_UNAVAILABLE");
    expect(last.sequenceNumber).toBe(outcome.execution.version);
    expect(last.toStatus).toBe("SKIPPED");
  });

  maybe()("replays a stale retry of the terminal legacy skip without duplicating data", async () => {
    const execution = await createExecution();
    await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { signalTriggeredAt: null } });

    const first = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });
    const replay = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.decision).toBe("SKIP");
    expect(replay.reasonCode).toBe("SIGNAL_TIME_UNAVAILABLE");
    expect(await prisma!.safetyAdmission.count({ where: { tradeExecutionId: execution.id } })).toBe(1);
    expect(
      await prisma!.executionEvent.count({
        where: { tradeExecutionId: execution.id, eventType: "DECISION_RECORDED" },
      })
    ).toBe(1);
    expect(
      (await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } })).version
    ).toBe(first.execution.version);
  });
});

describe("admission reservation", () => {
  maybe()("reserves capacity by moving PLAN_READY to PREFLIGHT on PASS", async () => {
    const execution = await createExecution();
    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });

    expect(outcome.decision).toBe("PASS");
    expect(outcome.execution.status).toBe("PREFLIGHT");
    expect(outcome.execution.version).toBe(execution.version + 1);
  });

  maybe()("appends exactly one event with the bumped version as its sequence", async () => {
    const execution = await createExecution();
    const before = await prisma!.executionEvent.count({ where: { tradeExecutionId: execution.id } });

    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });

    const events = await prisma!.executionEvent.findMany({
      where: { tradeExecutionId: execution.id },
      orderBy: { sequenceNumber: "asc" },
    });
    expect(events.length).toBe(before + 1);
    const last = events[events.length - 1];
    expect(last.eventType).toBe("DECISION_RECORDED");
    expect(last.sequenceNumber).toBe(outcome.execution.version);
  });

  maybe()("transitions PLAN_READY to SKIPPED on a policy failure", async () => {
    const execution = await createExecution();
    stub.positionsSymbols = [SYMBOL];

    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });
    expect(outcome.decision).toBe("SKIP");
    expect(outcome.reasonCode).toBe("SYMBOL_HAS_OPEN_POSITION_OR_ORDER");
    expect(outcome.execution.status).toBe("SKIPPED");
    expect(outcome.execution.version).toBe(execution.version + 1);
  });

  maybe()("rejects a stale expectedVersion without reserving anything", async () => {
    const execution = await createExecution();
    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version + 5,
      evaluatedAt: new Date(),
      maxAttempts: 2,
    });
    expect(outcome.decision).toBe("RETRY_CONFLICT");
    expect(outcome.reasonCode).toBe("CAPACITY_CONFLICT_RETRY");

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("PLAN_READY");
    expect(reloaded.version).toBe(execution.version);
    expect(await prisma!.safetyAdmission.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
  });

  maybe()("never returns PASS without a committed PREFLIGHT reservation", async () => {
    const execution = await createExecution();
    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });
    if (outcome.decision === "PASS") {
      const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
      expect(reloaded.status).toBe("PREFLIGHT");
    }
  });
});

describe("persisted safety decision", () => {
  maybe()("stores a sanitized admission snapshot", async () => {
    const execution = await createExecution();
    const evaluatedAt = new Date();
    await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt,
    });

    const admission = await prisma!.safetyAdmission.findFirstOrThrow({
      where: { tradeExecutionId: execution.id },
    });
    expect(admission.decision).toBe("PASS");
    expect(admission.evaluatedAt.toISOString()).toBe(evaluatedAt.toISOString());
    expect(admission.evaluatedVersion).toBe(execution.version);
    expect(admission.reservedRiskUsd?.toString()).toBe("1.5");
    expect(admission.reservedMarginUsd?.toString()).toBe("4.9999995");
    expect(admission.binanceSnapshotAt).not.toBeNull();
    expect(admission.effectiveLimits).toMatchObject({ maxTotalActiveTrades: 1 });
    expect(admission.capacityBefore).toMatchObject({ totalActiveCount: 0 });
    expect(admission.capacityProjected).toMatchObject({ totalActiveCount: 1 });
  });

  maybe()("stores no credentials, signed queries or raw payloads", async () => {
    const execution = await createExecution();
    await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });

    const admission = await prisma!.safetyAdmission.findFirstOrThrow({
      where: { tradeExecutionId: execution.id },
    });
    const serialized = JSON.stringify(admission).toLowerCase();
    for (const forbidden of ["apikey", "apisecret", "signature", "x-mbx-apikey", "authorization", "secret=", "token"]) {
      expect(serialized).not.toContain(forbidden);
    }
    // Only a summary of the REQUESTED symbol is stored: never a position list
    // and never raw account/position fields. (Names like openPositionCount are
    // sanitized counts, so the check targets the leaking fields themselves.)
    for (const leaked of [
      "positionamt",
      "unrealizedprofit",
      "walletbalance",
      "availablebalance",
      "isolatedwallet",
      "entryprice",
      "liquidationprice",
      "marginasset",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(admission.symbolStateSummary).toMatchObject({ symbol: SYMBOL });
  });

  maybe()("does not duplicate history on an identical retry", async () => {
    const execution = await createExecution();
    const evaluatedAt = new Date();
    const first = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt,
    });
    const second = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt,
    });

    expect(second.decision).toBe(first.decision);
    expect(second.idempotentReplay).toBe(true);
    expect(await prisma!.safetyAdmission.count({ where: { tradeExecutionId: execution.id } })).toBe(1);
    expect(
      await prisma!.executionEvent.count({
        where: { tradeExecutionId: execution.id, eventType: "DECISION_RECORDED" },
      })
    ).toBe(1);
  });
});

describe("kill switch", () => {
  maybe()("skips without making any Binance call when the profile switch is active", async () => {
    const execution = await createExecution();
    const policy = await policies.getByProfileId(profileId);
    await policies.updateForProfile(profileId, policy!.version, { killSwitchActive: true });

    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });

    expect(outcome.decision).toBe("SKIP");
    expect(outcome.reasonCode).toBe("PROFILE_KILL_SWITCH_ACTIVE");
    expect(stub.calls).toHaveLength(0);
  });

  maybe()("does not touch existing executions when engaged", async () => {
    const running = await createExecution();
    await admissions.evaluateAndReserveSafetyAdmission({
      executionId: running.id,
      expectedVersion: running.version,
      evaluatedAt: new Date(),
    });
    const beforeStatus = (await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: running.id } })).status;

    const policy = await policies.getByProfileId(profileId);
    await policies.updateForProfile(profileId, policy!.version, { killSwitchActive: true });

    const blocked = await createExecution();
    await admissions.evaluateAndReserveSafetyAdmission({
      executionId: blocked.id,
      expectedVersion: blocked.version,
      evaluatedAt: new Date(),
    });

    const afterStatus = (await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: running.id } })).status;
    expect(afterStatus).toBe(beforeStatus);
    expect(afterStatus).toBe("PREFLIGHT");
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: running.id } })).toBe(0);
  });
});

describe("atomic capacity under concurrency", () => {
  maybe()("admits exactly one of two simultaneous requests on the same profile", async () => {
    const first = await createExecution();
    const second = await createExecution({ positionSide: "SHORT", plan: { direction: "SHORT" } });

    const [a, b] = await Promise.all([
      admissions.evaluateAndReserveSafetyAdmission({
        executionId: first.id,
        expectedVersion: first.version,
        evaluatedAt: new Date(),
      }),
      admissions.evaluateAndReserveSafetyAdmission({
        executionId: second.id,
        expectedVersion: second.version,
        evaluatedAt: new Date(),
      }),
    ]);

    const decisions = [a.decision, b.decision].sort();
    expect(decisions).toEqual(["PASS", "SKIP"]);

    const reserved = await prisma!.tradeExecution.count({
      where: { executionProfileId: profileId, status: "PREFLIGHT" },
    });
    expect(reserved).toBe(1);
  });

  maybe()("admits exactly one of five simultaneous requests", async () => {
    const created = await Promise.all([
      createExecution(),
      createExecution(),
      createExecution(),
      createExecution(),
      createExecution(),
    ]);

    const outcomes = await Promise.all(
      created.map((execution) =>
        admissions.evaluateAndReserveSafetyAdmission({
          executionId: execution.id,
          expectedVersion: execution.version,
          evaluatedAt: new Date(),
        })
      )
    );

    expect(outcomes.filter((outcome) => outcome.decision === "PASS")).toHaveLength(1);
    expect(
      await prisma!.tradeExecution.count({ where: { executionProfileId: profileId, status: "PREFLIGHT" } })
    ).toBe(1);
  });

  maybe()("does not let one profile block another", async () => {
    const mine = await createExecution();
    const theirs = await createExecution({ profile: otherProfileId });

    const [a, b] = await Promise.all([
      admissions.evaluateAndReserveSafetyAdmission({
        executionId: mine.id,
        expectedVersion: mine.version,
        evaluatedAt: new Date(),
      }),
      admissions.evaluateAndReserveSafetyAdmission({
        executionId: theirs.id,
        expectedVersion: theirs.version,
        evaluatedAt: new Date(),
      }),
    ]);

    expect(a.decision).toBe("PASS");
    expect(b.decision).toBe("PASS");
  });

  maybe()("never deletes an existing execution when a limit is reached", async () => {
    const admitted = await createExecution();
    await admissions.evaluateAndReserveSafetyAdmission({
      executionId: admitted.id,
      expectedVersion: admitted.version,
      evaluatedAt: new Date(),
    });

    const blocked = await createExecution();
    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: blocked.id,
      expectedVersion: blocked.version,
      evaluatedAt: new Date(),
    });

    expect(outcome.decision).toBe("SKIP");
    expect(await prisma!.tradeExecution.findUnique({ where: { id: admitted.id } })).not.toBeNull();
    expect((await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: admitted.id } })).status).toBe("PREFLIGHT");
  });
});

describe("UNAVAILABLE is retryable, never terminal", () => {
  maybe()("keeps the execution in PLAN_READY when the account snapshot fails", async () => {
    const execution = await createExecution();
    stub.failAccount = true;

    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });
    expect(outcome.decision).toBe("UNAVAILABLE");
    expect(outcome.reasonCode).toBe("BINANCE_ACCOUNT_STATE_UNAVAILABLE");
    expect(outcome.execution.status).toBe("PLAN_READY");

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("PLAN_READY");
  });

  maybe()("keeps the execution in PLAN_READY when the symbol cannot be inspected", async () => {
    const execution = await createExecution();
    stub.failSymbol = true;

    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });
    expect(outcome.decision).toBe("UNAVAILABLE");
    expect(outcome.reasonCode).toBe("BINANCE_SYMBOL_STATE_UNAVAILABLE");
    expect(outcome.execution.status).toBe("PLAN_READY");
  });

  maybe()("increments the version exactly once and records exactly one admission and event", async () => {
    const execution = await createExecution();
    const eventsBefore = await prisma!.executionEvent.count({ where: { tradeExecutionId: execution.id } });
    stub.failAccount = true;

    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });

    expect(outcome.execution.version).toBe(execution.version + 1);
    expect(await prisma!.safetyAdmission.count({ where: { tradeExecutionId: execution.id } })).toBe(1);

    const events = await prisma!.executionEvent.findMany({
      where: { tradeExecutionId: execution.id },
      orderBy: { sequenceNumber: "asc" },
    });
    expect(events.length).toBe(eventsBefore + 1);
    const last = events[events.length - 1];
    expect(last.eventType).toBe("DECISION_RECORDED");
    expect(last.sequenceNumber).toBe(outcome.execution.version);
    expect(last.fromStatus).toBe("PLAN_READY");
    expect(last.toStatus).toBe("PLAN_READY");
  });

  maybe()("replays a stale retry without duplicating admissions or events", async () => {
    const execution = await createExecution();
    stub.failAccount = true;
    const first = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });

    // Same (now stale) expectedVersion: must replay, not re-record.
    const replay = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.decision).toBe("UNAVAILABLE");
    expect(await prisma!.safetyAdmission.count({ where: { tradeExecutionId: execution.id } })).toBe(1);
    expect(
      await prisma!.executionEvent.count({
        where: { tradeExecutionId: execution.id, eventType: "DECISION_RECORDED" },
      })
    ).toBe(1);
    expect(
      (await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } })).version
    ).toBe(first.execution.version);
  });

  maybe()("lets a retry with the NEW version reach PASS and PREFLIGHT", async () => {
    const execution = await createExecution();
    stub.failAccount = true;
    const first = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });
    expect(first.decision).toBe("UNAVAILABLE");

    stub.failAccount = false;
    const retry = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: first.execution.version,
      evaluatedAt: new Date(),
    });

    expect(retry.decision).toBe("PASS");
    expect(retry.execution.status).toBe("PREFLIGHT");
    expect(retry.execution.version).toBe(first.execution.version + 1);
    expect(await prisma!.safetyAdmission.count({ where: { tradeExecutionId: execution.id } })).toBe(2);
  });

  maybe()("lets a retry with the NEW version terminate in SKIPPED", async () => {
    const execution = await createExecution();
    stub.failSymbol = true;
    const first = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });
    expect(first.decision).toBe("UNAVAILABLE");

    stub.failSymbol = false;
    stub.openOrderSymbols = [SYMBOL];
    const retry = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: first.execution.version,
      evaluatedAt: new Date(),
    });

    expect(retry.decision).toBe("SKIP");
    expect(retry.reasonCode).toBe("SYMBOL_HAS_OPEN_POSITION_OR_ORDER");
    expect(retry.execution.status).toBe("SKIPPED");
  });

  maybe()("admits only one of two concurrent UNAVAILABLE attempts", async () => {
    const execution = await createExecution();
    stub.failAccount = true;

    const [a, b] = await Promise.all([
      admissions.evaluateAndReserveSafetyAdmission({
        executionId: execution.id,
        expectedVersion: execution.version,
        evaluatedAt: new Date(),
        maxAttempts: 1,
      }),
      admissions.evaluateAndReserveSafetyAdmission({
        executionId: execution.id,
        expectedVersion: execution.version,
        evaluatedAt: new Date(),
        maxAttempts: 1,
      }),
    ]);

    // Exactly one recorded the attempt; the loser either lost the conditional
    // update (RETRY_CONFLICT) or replayed the winner's stored decision.
    const recorded = [a, b].filter((outcome) => outcome.decision === "UNAVAILABLE" && !outcome.idempotentReplay);
    expect(recorded).toHaveLength(1);
    expect(await prisma!.safetyAdmission.count({ where: { tradeExecutionId: execution.id } })).toBe(1);
    expect(
      (await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } })).version
    ).toBe(execution.version + 1);
  });

  maybe()("rolls back the version increment and admission when the event insert fails", async () => {
    const execution = await createExecution();
    stub.failAccount = true;

    // Squat on the sequence number the attempt will need, so the event insert
    // violates the (tradeExecutionId, sequenceNumber) unique constraint.
    await prisma!.executionEvent.create({
      data: {
        tradeExecutionId: execution.id,
        sequenceNumber: execution.version + 1,
        eventType: "DECISION_RECORDED",
        message: "sequence squatter",
      },
    });

    await expect(
      admissions.evaluateAndReserveSafetyAdmission({
        executionId: execution.id,
        expectedVersion: execution.version,
        evaluatedAt: new Date(),
      })
    ).rejects.toThrow();

    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.version).toBe(execution.version);
    expect(reloaded.status).toBe("PLAN_READY");
    expect(await prisma!.safetyAdmission.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
  });

  maybe()("terminates instead of retrying when an immutable snapshot is permanently missing", async () => {
    const execution = await createExecution();
    // Simulate an execution frozen without its plan snapshot, with the
    // connector ALSO down: the permanent failure must win.
    await prisma!.$executeRaw`UPDATE "TradeExecution" SET "marginPlanSnapshot" = NULL WHERE "id" = ${execution.id}`;
    stub.failAccount = true;

    const first = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });
    expect(first.decision).toBe("SKIP");
    expect(first.reasonCode).toBe("MARGIN_PLAN_SNAPSHOT_MISSING");
    expect(first.execution.status).toBe("SKIPPED");

    // Terminal means terminal: a retry with the new version cannot re-enter
    // the loop, because the row is no longer PLAN_READY.
    const retry = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: first.execution.version,
      evaluatedAt: new Date(),
      maxAttempts: 2,
    });
    expect(retry.decision).toBe("RETRY_CONFLICT");
    expect(
      (await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } })).status
    ).toBe("SKIPPED");
    expect(await prisma!.safetyAdmission.count({ where: { tradeExecutionId: execution.id } })).toBe(1);
  });

  maybe()("changes no exposure or order on any terminal or retryable decision", async () => {
    const admitted = await createExecution();
    await admissions.evaluateAndReserveSafetyAdmission({
      executionId: admitted.id,
      expectedVersion: admitted.version,
      evaluatedAt: new Date(),
    });

    const legacy = await createExecution();
    await prisma!.tradeExecution.update({ where: { id: legacy.id }, data: { signalTriggeredAt: null } });
    await admissions.evaluateAndReserveSafetyAdmission({
      executionId: legacy.id,
      expectedVersion: legacy.version,
      evaluatedAt: new Date(),
    });

    const transient = await createExecution();
    stub.failAccount = true;
    await admissions.evaluateAndReserveSafetyAdmission({
      executionId: transient.id,
      expectedVersion: transient.version,
      evaluatedAt: new Date(),
    });

    // The already-reserved execution is untouched, and no local order row was
    // created or removed by any decision path.
    expect((await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: admitted.id } })).status).toBe("PREFLIGHT");
    expect(
      await prisma!.binanceOrder.count({ where: { tradeExecution: { executionProfileId: profileId } } })
    ).toBe(0);
    expect(await prisma!.tradeExecution.findUnique({ where: { id: legacy.id } })).not.toBeNull();
    expect(await prisma!.tradeExecution.findUnique({ where: { id: transient.id } })).not.toBeNull();
  });

  maybe()("keeps CAPACITY_CONFLICT_RETRY non-terminal and retryable", async () => {
    const execution = await createExecution();

    const conflict = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version + 7,
      evaluatedAt: new Date(),
      maxAttempts: 2,
    });
    expect(conflict.decision).toBe("RETRY_CONFLICT");
    expect(conflict.reasonCode).toBe("CAPACITY_CONFLICT_RETRY");
    expect(conflict.execution.status).toBe("PLAN_READY");
    expect(conflict.execution.version).toBe(execution.version);

    const retry = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });
    expect(retry.decision).toBe("PASS");
    expect(retry.execution.status).toBe("PREFLIGHT");
  });
});

describe("configuration mismatch reason codes", () => {
  maybe()("uses PROFILE_DISABLED only when the profile is actually disabled", async () => {
    const execution = await createExecution();
    await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled: false } });

    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });
    expect(outcome.reasonCode).toBe("PROFILE_DISABLED");

    await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled: true } });
  });

  maybe()("uses PROFILE_ENVIRONMENT_MISMATCH for a mismatched environment", async () => {
    await prisma!.executionProfile.update({ where: { id: profileId }, data: { environment: "MAINNET" } });
    const execution = await createExecution();

    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });
    expect(outcome.reasonCode).toBe("PROFILE_ENVIRONMENT_MISMATCH");
    expect(outcome.decision).toBe("SKIP");

    await prisma!.executionProfile.update({ where: { id: profileId }, data: { environment: "TESTNET" } });
  });

  maybe()("uses EXPECTED_ISOLATED_MARGIN_TYPE for a non-ISOLATED profile", async () => {
    await prisma!.executionProfile.update({ where: { id: profileId }, data: { expectedMarginType: "CROSS" } });
    const execution = await createExecution();

    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });
    expect(outcome.reasonCode).toBe("EXPECTED_ISOLATED_MARGIN_TYPE");
    expect(outcome.decision).toBe("SKIP");

    await prisma!.executionProfile.update({ where: { id: profileId }, data: { expectedMarginType: "ISOLATED" } });
  });

  maybe()("uses EXPECTED_HEDGE_MODE when the real Binance position mode is not HEDGE", async () => {
    const execution = await createExecution();
    stub.positionMode = "ONE_WAY";

    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });
    expect(outcome.reasonCode).toBe("EXPECTED_HEDGE_MODE");
  });

  maybe()("uses EXPECTED_SINGLE_ASSET_MODE when the real Binance asset mode is multi-asset", async () => {
    const execution = await createExecution();
    stub.assetMode = "MULTI_ASSET";

    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });
    expect(outcome.reasonCode).toBe("EXPECTED_SINGLE_ASSET_MODE");
  });
});

describe("safety policy administration", () => {
  maybe()("defaults to a fail-closed policy", async () => {
    const profile = await prisma!.executionProfile.create({
      data: {
        name: "Phase 5 synthetic profile C",
        accountIdentifier: `${SYNTHETIC_TAG}-account-c`,
        environment: "TESTNET",
      },
    });
    const policy = await policies.createForProfile(profile.id);

    expect(policy.killSwitchActive).toBe(true);
    expect(policy.maxOpenPositions).toBe(1);
    expect(policy.maxTotalPlannedRiskUsd.toString()).toBe("1.5");
    expect(policy.maxTotalIsolatedMarginUsd.toString()).toBe("5");
    expect(policy.maxAlertAgeSeconds).toBe(300);
    expect(policy.allowedSymbols).toEqual([]);

    await prisma!.executionSafetyPolicy.deleteMany({ where: { executionProfileId: profile.id } });
    await prisma!.executionProfile.delete({ where: { id: profile.id } });
  });

  maybe()("rejects a stale policy version", async () => {
    const policy = await policies.getByProfileId(profileId);
    await expect(
      policies.updateForProfile(profileId, policy!.version + 3, { maxAlertAgeSeconds: 120 })
    ).rejects.toThrow(/modified concurrently/i);
  });

  maybe()("rejects an unreachable limit combination", async () => {
    const policy = await policies.getByProfileId(profileId);
    await expect(
      policies.updateForProfile(profileId, policy!.version, { maxOpenPositions: 5 })
    ).rejects.toThrow(/maxTotalActiveTrades must be >= maxOpenPositions/);
  });

  maybe()("rejects a soft open target above the hard cap", async () => {
    // Unreachable by construction: the hard limit would reject first, so the
    // row would claim a policy it does not implement.
    const policy = await policies.getByProfileId(profileId);
    await expect(
      policies.updateForProfile(profileId, policy!.version, { softOpenPositionTarget: 5 })
    ).rejects.toThrow(/softOpenPositionTarget must be <= maxOpenPositions/);
  });

  maybe()("rejects a soft open target below 1", async () => {
    const policy = await policies.getByProfileId(profileId);
    for (const invalid of [0, -1, 1.5]) {
      await expect(
        policies.updateForProfile(profileId, policy!.version, { softOpenPositionTarget: invalid })
      ).rejects.toThrow(/softOpenPositionTarget must be a positive safe integer/);
    }
  });

  maybe()("checks the soft target against the MERGED row, not just this call", async () => {
    // Raising both together is legal; the invariant is evaluated on the result.
    const policy = await policies.getByProfileId(profileId);
    const updated = await policies.updateForProfile(profileId, policy!.version, {
      maxOpenPositions: 3,
      maxPendingEntries: 3,
      maxTotalActiveTrades: 3,
      softOpenPositionTarget: 2,
    });
    expect(updated.softOpenPositionTarget).toBe(2);
    expect(updated.maxOpenPositions).toBe(3);

    // Now lowering the hard cap ALONE would strand the soft target above it.
    await expect(
      policies.updateForProfile(profileId, updated.version, { maxOpenPositions: 1 })
    ).rejects.toThrow(/softOpenPositionTarget must be <= maxOpenPositions/);

    // Put the row back so later tests see the fixture they expect.
    await policies.updateForProfile(profileId, updated.version, {
      maxOpenPositions: 1,
      maxPendingEntries: 1,
      maxTotalActiveTrades: 1,
      softOpenPositionTarget: 1,
    });
  });

  maybe()("defaults an existing row to a soft target of 1", async () => {
    const policy = await policies.getByProfileId(profileId);
    expect(policy!.softOpenPositionTarget).toBe(1);
  });

  maybe()("normalizes and validates the symbol allowlist", async () => {
    const policy = await policies.getByProfileId(profileId);
    const updated = await policies.updateForProfile(profileId, policy!.version, {
      allowedSymbols: [" testbusdt ", "TESTBUSDT", "otherusdt"],
    });
    expect(updated.allowedSymbols).toEqual(["OTHERUSDT", "TESTBUSDT"]);

    await expect(
      policies.updateForProfile(profileId, updated.version, { allowedSymbols: ["bad symbol!"] })
    ).rejects.toThrow(/invalid symbol/i);

    await policies.updateForProfile(profileId, updated.version, { allowedSymbols: [] });
  });
});


// ---------------------------------------------------------------------------
// The FLOCKUSDT deadlock, through the real admission service
// ---------------------------------------------------------------------------

describe("a standard take profit that could never be placed never reaches entry", () => {
  /**
   * The exact production geometry, driven through the REAL
   * SafetyAdmissionService against a real database — not the pure engine in
   * isolation. What this proves that the unit tests cannot is the WIRING: the
   * authoritative minimum notional actually travels from the connector read to
   * the decision, the frozen target and planned quantity are the ones the plan
   * carries, and the modality is resolved from durable rows.
   *
   * SHORT 121 @ 0.05548, frozen target 0.03691, floor 5.
   * 121 x 0.03691 = 4.46611 < 5.
   *
   * In production this filled, verified its stop, could never place its target,
   * and parked at PLACING_PROTECTION — which held countRecoveryRequired() above
   * zero and globally refused every later admission until a human intervened.
   */
  const FLOCK_PLAN = {
    direction: "SHORT" as const,
    entryPrice: "0.05548",
    stopLoss: "0.06786",
    calculatedStopLoss: "0.06786",
    executableStopLoss: "0.06786",
    stopDistance: "0.01238",
    quantityRaw: "121",
    roundedQuantity: "121",
    quantityStepSize: "1",
    positionNotional: "6.71308",
    // SHORT geometry: liquidation sits ABOVE the required boundary, which is
    // the safe direction for a short. The fixture's defaults are LONG-shaped.
    estimatedLiquidationPrice: "0.08",
    requiredLiquidationBoundary: "0.075",
    liquidationDistance: "0.02452",
  };

  const flockExecution = () =>
    createExecution({ plan: FLOCK_PLAN, positionSide: "SHORT", takeProfit: "0.03691" });

  maybe()("refuses it terminally, naming the minimum notional and not the trigger", async () => {
    stub.minNotional = "5";
    const execution = await flockExecution();

    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });

    expect(outcome.decision).toBe("SKIP");
    expect(outcome.reasonCode).toBe("PROTECTION_QUANTITY_UNSUPPORTED");

    // The durable decision an operator reads must name the real condition.
    const admission = await prisma!.safetyAdmission.findFirstOrThrow({
      where: { tradeExecutionId: execution.id },
    });
    expect(admission.decision).toBe("SKIP");
    expect(admission.reasonCode).toBe("PROTECTION_QUANTITY_UNSUPPORTED");
    expect(admission.message).toMatch(/minimum notional/i);
    expect(admission.message).not.toMatch(/trigger/i);

    // Nothing was spent: no capacity, no risk, no margin reservation.
    expect(admission.reservedRiskUsd === null || admission.reservedRiskUsd.toString() === "0").toBe(true);
    expect(admission.reservedMarginUsd === null || admission.reservedMarginUsd.toString() === "0").toBe(true);

    // No entry was reserved, no protection generation minted, and the
    // execution never entered a recovery-required state.
    const reloaded = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("SKIPPED");
    expect(reloaded.requiresManualIntervention).toBe(false);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
    expect(
      await prisma!.executionProtectionState.count({ where: { tradeExecutionId: execution.id } })
    ).toBe(0);
  });

  maybe()("reads the floor from the connector rather than any constant of its own", async () => {
    // The same plan against a symbol whose floor is BELOW the notional. If the
    // gate ever hardcoded 5 — or stopped reading the connector — this admits
    // nothing and the test fails.
    stub.minNotional = "4";
    const execution = await flockExecution();

    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });

    expect(outcome.decision).toBe("PASS");
    expect(stub.calls.some((call) => call.startsWith("inspectSymbol:"))).toBe(true);
  });

  maybe()("admits a target worth exactly the floor", async () => {
    // 121 x 0.04132... is awkward; use the floor exactly: 100 x 0.05 = 5.00.
    stub.minNotional = "5";
    const execution = await createExecution({
      plan: { ...FLOCK_PLAN, quantityRaw: "100", roundedQuantity: "100", positionNotional: "5.548" },
      positionSide: "SHORT",
      takeProfit: "0.05",
    });

    const outcome = await admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });

    expect(outcome.decision).toBe("PASS");
  });

  maybe()("a PLAN_READY execution has no take-profit lineage to be ambiguous about", async () => {
    // The invariant the STANDARD-only predicate rests on: nothing in production
    // writes a TAKE_PROFIT row before admission, so the lineage is NONE and
    // configuration decides. If that ever changed, an AMBIGUOUS lineage would
    // resolve to null and this gate would stop firing — so it is pinned here.
    const execution = await flockExecution();
    expect(execution.status).toBe("PLAN_READY");
    expect(
      await prisma!.binanceOrder.count({
        where: { tradeExecutionId: execution.id, role: "TAKE_PROFIT" },
      })
    ).toBe(0);
  });
});
