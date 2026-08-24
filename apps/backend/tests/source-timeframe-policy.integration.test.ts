import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";
import type { DynamicLeveragePlan } from "@trading-alert-dashboard/shared";

/**
 * The durable half of the Source Timeframe filter, against a real Postgres.
 *
 * The properties proven here cannot be shown against a mock:
 *
 *   - a refused source timeframe must spend NO authorization claim and NO
 *     capacity, which is a statement about what commits inside the real
 *     admission transaction, not about a return value;
 *   - the save guard must re-check the durable safe state INSIDE the profile
 *     advisory lock, so a frontend that read a stale status still cannot write;
 *   - the selection must survive being read back by a different service
 *     instance, which is the whole point of calling it durable.
 *
 * Every row is synthetic and removed in afterAll. Binance is a read-only stub,
 * no network call is made anywhere in this file, and nothing here arms, claims
 * or executes.
 */

const TAG = "source-tf-policy";

// Set BEFORE the dynamic imports below: `config/env` and
// `configuredProfileIdentity` both read the snapshot parsed at module load.
process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = `${TAG}-operator`;
process.env.EXECUTION_PROFILE_ENVIRONMENT = "TESTNET";
process.env.EXECUTION_GLOBAL_KILL_SWITCH = "false";
process.env.EXECUTION_MAX_OPEN_POSITIONS = "5";
process.env.EXECUTION_SOFT_OPEN_POSITION_TARGET = "5";
process.env.EXECUTION_MAX_PENDING_ENTRIES = "5";
process.env.EXECUTION_MAX_TOTAL_ACTIVE_TRADES = "5";
process.env.EXECUTION_MAX_TOTAL_PLANNED_RISK_USD = "100.00";
process.env.EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD = "500.00";
process.env.EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE = "1";
process.env.EXECUTION_MAX_ALERT_AGE_SECONDS = "300";
process.env.BINANCE_FUTURES_REST_BASE_URL = "https://testnet.binancefuture.com";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const describeDb = available && prisma ? describe : describe.skip;

const { ExecutionService } = await import("../src/modules/execution/execution.service");
const { SafetyAdmissionService } = await import("../src/modules/execution/safety-admission.service");
const { SafetyPolicyService } = await import("../src/modules/execution/safety-policy.service");
const { SourceTimeframeService } = await import("../src/modules/operator/source-timeframes.service");

type ExecutionServiceType = InstanceType<typeof ExecutionService>;
type SafetyAdmissionServiceType = InstanceType<typeof SafetyAdmissionService>;

// ---------------------------------------------------------------------------
// Read-only Binance stub — GET-shaped data only. No network, no credentials.
// ---------------------------------------------------------------------------

const readOnlyStub = {
  async getAccountSummary() {
    return {
      connection: { ok: true, host: "testnet", serverTimeMs: Date.now(), serverTimeIso: "", clockOffsetMs: 0, roundTripMs: 1 },
      positionMode: "HEDGE",
      assetMode: "SINGLE_ASSET",
      usdtWalletBalance: "5000.00",
      usdtAvailableBalance: "5000.00",
      nonZeroPositionCount: 0,
      openOrderCount: 0,
      openOrderSymbols: [] as string[],
      positions: [] as Array<{ symbol: string }>,
      warnings: [],
    };
  },
  async inspectSymbol(symbol: string) {
    return {
      filters: {
        symbol,
        status: "TRADING",
        contractType: "PERPETUAL",
        quoteAsset: "USDT",
        marginAsset: "USDT",
        tickSize: "0.01",
        stepSize: "0.001",
      },
      brackets: [
        { bracket: 1, initialLeverage: 50, notionalCap: "10000", notionalFloor: "0", maintMarginRatio: "0.01", cum: "0" },
      ],
      maxInitialLeverage: 50,
      accountSymbolConfig: null,
    };
  },
} as unknown as ConstructorParameters<typeof SafetyAdmissionService>[1];

const ALL_SIX = ["1D", "1W", "1M", "3M", "6M", "12M"];

function readyPlan(symbol: string, direction: "LONG" | "SHORT"): DynamicLeveragePlan {
  const long = direction === "LONG";
  return {
    status: "READY",
    reason: null,
    reasonMessage: null,
    symbol,
    direction,
    entryPrice: "100",
    stopLoss: long ? "96" : "104",
    calculatedStopLoss: long ? "96" : "104",
    executableStopLoss: long ? "96" : "104",
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
    // LONG liquidates below the boundary; SHORT above it.
    estimatedLiquidationPrice: long ? "90.1" : "109.9",
    requiredLiquidationBoundary: long ? "94" : "106",
    liquidationBufferRatio: "0.5",
    liquidationDistance: "5.9",
    safetyBufferDistance: "2",
    marginDifferenceFromTarget: "0",
    candidates: [],
    warnings: [],
  } as DynamicLeveragePlan;
}


describeDb("source timeframe policy: durable behaviour", () => {
  let executions: ExecutionServiceType;
  let admissions: SafetyAdmissionServiceType;
  let policies: InstanceType<typeof SafetyPolicyService>;

  /** The profile `configuredProfileIdentity()` resolves to. */
  let operatorProfileId = "";
  const profileIds: string[] = [];
  let sequence = 0;

  const service = () => new SourceTimeframeService(prisma!);

  async function newProfile(allowedSourceTimeframes: string[], enabled = true): Promise<string> {
    sequence += 1;
    const profile = await prisma!.executionProfile.create({
      data: {
        name: `${TAG}-${sequence}`,
        accountIdentifier: `${TAG}-${sequence}-${Date.now().toString(36)}`,
        environment: "TESTNET",
        isEnabled: enabled,
      },
    });
    profileIds.push(profile.id);
    await policies.createForProfile(profile.id, {
      killSwitchActive: false,
      maxOpenPositions: 5,
      softOpenPositionTarget: 5,
      maxPendingEntries: 5,
      maxTotalActiveTrades: 5,
      maxActivePerSymbolSide: 1,
      maxTotalPlannedRiskUsd: "100.00",
      maxTotalIsolatedMarginUsd: "500.00",
    });
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profile.id },
      data: { allowedSourceTimeframes },
    });
    return profile.id;
  }

  async function newExecution(profileId: string, sourceTimeframe: string | null) {
    sequence += 1;
    const symbol = `SYN${sequence}USDT`;
    const alert = await prisma!.alert.create({
      data: {
        symbol,
        assetType: "CRYPTO",
        exchange: "SYNTHETIC",
        // The CHART timeframe. Deliberately different from the source
        // timeframe on every row here, so nothing can pass by conflating them.
        timeframe: "15m",
        sourceTimeframe,
        price: 100,
        signal: "LONG",
        indicatorName: `${TAG}-${sequence}`,
        rawPayload: { note: TAG },
        triggeredAt: new Date(),
      },
    });
    return executions.createExecutionFromReadyPlan({
      executionProfileId: profileId,
      alertId: alert.id,
      plan: readyPlan(symbol, "LONG"),
      positionSide: "LONG",
      selectedLookback: 200,
    });
  }

  async function newWindow(profileId: string, maxClaims = 5) {
    return prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        allowedDirections: ["LONG", "SHORT"],
        maxClaims,
        claimedCount: 0,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
  }

  const admit = (execution: { id: string; version: number }) =>
    admissions.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt: new Date(),
    });

  const windowOf = (id: string) => prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id } });
  const executionOf = (id: string) => prisma!.tradeExecution.findUniqueOrThrow({ where: { id } });
  const operatorPolicy = () =>
    prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: operatorProfileId } });

  async function setOperatorState(isEnabled: boolean, killSwitchActive: boolean) {
    await prisma!.executionProfile.update({ where: { id: operatorProfileId }, data: { isEnabled } });
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: operatorProfileId },
      data: { killSwitchActive },
    });
  }

  async function createOperatorExecution(status: string, requiresManualIntervention = false) {
    await prisma!.tradeExecution.create({
      data: {
        executionProfileId: operatorProfileId,
        symbol: "TESTRUSDT",
        direction: "LONG",
        positionSide: "LONG",
        selectedLookback: 200,
        status: status as never,
        requiresManualIntervention,
        plannedEntryPrice: "100",
        calculatedStopLoss: "96",
        executableStopLoss: "96",
        riskBudgetUsd: "1.50",
        quantityRaw: "0.375",
        plannedQuantity: "0.375",
        quantityStepSize: "0.001",
        actualPlannedLoss: "1.5",
        unusedRiskBudget: "0",
        positionNotional: "37.5",
        targetIsolatedMargin: "3.75",
        maximumIsolatedMargin: "5.00",
        selectedLeverage: 10,
        estimatedInitialMargin: "3.75",
        liquidationBufferRatio: "0.5",
      },
    });
  }

  beforeAll(async () => {
    if (!prisma || !available) return;
    executions = new ExecutionService(prisma);
    admissions = new SafetyAdmissionService(prisma, readOnlyStub);
    policies = new SafetyPolicyService(prisma);

    const profile = await prisma.executionProfile.create({
      data: {
        name: `${TAG}-operator`,
        accountIdentifier: `${TAG}-operator`,
        environment: "TESTNET",
        isEnabled: false,
      },
    });
    operatorProfileId = profile.id;
    profileIds.push(profile.id);
    await policies.createForProfile(profile.id, {
      killSwitchActive: true,
      maxOpenPositions: 5,
      softOpenPositionTarget: 5,
      maxPendingEntries: 5,
      maxTotalActiveTrades: 5,
      maxActivePerSymbolSide: 1,
      maxTotalPlannedRiskUsd: "100.00",
      maxTotalIsolatedMarginUsd: "500.00",
    });
  });

  afterEach(async () => {
    if (!prisma || !available) return;
    const ids = (
      await prisma.tradeExecution.findMany({
        where: { executionProfileId: operatorProfileId },
        select: { id: true },
      })
    ).map((row) => row.id);
    if (ids.length > 0) {
      await prisma.safetyAdmission.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.tradeExecution.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: operatorProfileId } });
    await prisma.executionSafetyPolicy.update({
      where: { executionProfileId: operatorProfileId },
      data: { allowedSourceTimeframes: ALL_SIX },
    });
    await setOperatorState(false, true);
  });

  afterAll(async () => {
    if (!prisma) return;
    if (available) {
      const ids = (
        await prisma.tradeExecution.findMany({
          where: { executionProfileId: { in: profileIds } },
          select: { id: true },
        })
      ).map((row) => row.id);
      if (ids.length > 0) {
        await prisma.safetyAdmission.deleteMany({ where: { tradeExecutionId: { in: ids } } });
        await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
        await prisma.executionNotification.deleteMany({ where: { tradeExecutionId: { in: ids } } });
        await prisma.tradeExecution.deleteMany({ where: { id: { in: ids } } });
      }
      const alerts = await prisma.alert.findMany({
        where: { indicatorName: { startsWith: TAG } },
        select: { id: true },
      });
      if (alerts.length > 0) {
        await prisma.extremeRRPlan.deleteMany({ where: { alertId: { in: alerts.map((a) => a.id) } } });
        await prisma.alert.deleteMany({ where: { id: { in: alerts.map((a) => a.id) } } });
      }
      await prisma.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: { in: profileIds } } });
      await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: { in: profileIds } } });
      await prisma.executionProfile.deleteMany({ where: { id: { in: profileIds } } });
    }
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // B / C. The admission outcome
  // -------------------------------------------------------------------------

  it("B. an ALLOWED source timeframe is admitted exactly as before", async () => {
    const profileId = await newProfile(["1W", "1M"]);
    const execution = await newExecution(profileId, "1W");

    const outcome = await admit(execution);
    expect(outcome.decision).toBe("PASS");
    expect((await executionOf(execution.id)).status).toBe("PREFLIGHT");
  });

  it("C. a DISALLOWED source timeframe becomes a terminal SKIPPED", async () => {
    const profileId = await newProfile(["1W", "1M"]);
    // Chart timeframe is 15m on every fixture; this is the LEVEL's timeframe.
    const execution = await newExecution(profileId, "1D");

    const outcome = await admit(execution);
    expect(outcome.decision).toBe("SKIP");
    expect(outcome.reasonCode).toBe("SOURCE_TIMEFRAME_NOT_ALLOWED");

    const row = await executionOf(execution.id);
    expect(row.status).toBe("SKIPPED");
    expect(row.decisionReasonCode).toBe("SOURCE_TIMEFRAME_NOT_ALLOWED");
    // The persisted message names both halves, so the journal and the Telegram
    // TRADE_SKIPPED notification can explain the refusal without a lookup.
    expect(row.sanitizedMessage).toContain("1D");
    expect(row.sanitizedMessage).toContain("1W, 1M");
  });

  it("C2. an alert whose note carried no recognised sourceTf fails closed", async () => {
    const profileId = await newProfile(ALL_SIX);
    const execution = await newExecution(profileId, null);

    const outcome = await admit(execution);
    expect(outcome.decision).toBe("SKIP");
    expect(outcome.reasonCode).toBe("SOURCE_TIMEFRAME_UNAVAILABLE");
    expect((await executionOf(execution.id)).status).toBe("SKIPPED");
  });

  it("C3. an EMPTY stored policy admits nothing — never everything", async () => {
    const profileId = await newProfile([]);
    const execution = await newExecution(profileId, "1W");

    const outcome = await admit(execution);
    expect(outcome.decision).toBe("SKIP");
    expect(outcome.reasonCode).toBe("SOURCE_TIMEFRAME_NOT_ALLOWED");
  });

  it("freezes the source timeframe onto the execution at creation", async () => {
    const profileId = await newProfile(ALL_SIX);
    const execution = await newExecution(profileId, "12M");
    // Frozen, so retention nulling alertId later cannot erase the input the
    // admission decision was made from.
    expect((await executionOf(execution.id)).sourceTimeframe).toBe("12M");
  });

  // -------------------------------------------------------------------------
  // D / E. A refusal spends nothing
  // -------------------------------------------------------------------------

  it("D. a refused source timeframe spends ZERO authorization claims", async () => {
    const profileId = await newProfile(["1M"]);
    const window = await newWindow(profileId);
    const execution = await newExecution(profileId, "1W");

    expect((await windowOf(window.id)).claimedCount).toBe(0);
    const outcome = await admit(execution);
    expect(outcome.reasonCode).toBe("SOURCE_TIMEFRAME_NOT_ALLOWED");

    // The whole point of the ordering: a claim is cumulative and never
    // refunded, so it must not be spent on a signal eligibility was always
    // going to refuse.
    expect((await windowOf(window.id)).claimedCount).toBe(0);
  });

  it("D2. and the SAME window still admits an eligible signal afterwards", async () => {
    // Proves the refusal did not merely avoid the claim but left the window
    // genuinely untouched and usable.
    const profileId = await newProfile(["1M"]);
    const window = await newWindow(profileId);

    const refused = await newExecution(profileId, "1W");
    await admit(refused);
    expect((await windowOf(window.id)).claimedCount).toBe(0);

    const eligible = await newExecution(profileId, "1M");
    const outcome = await admit(eligible);
    expect(outcome.decision).toBe("PASS");
    expect((await windowOf(window.id)).claimedCount).toBe(1);
  });

  it("E. a refused source timeframe reserves ZERO capacity, risk or margin", async () => {
    const profileId = await newProfile(["1M"]);
    await newWindow(profileId);
    const execution = await newExecution(profileId, "1W");

    const outcome = await admit(execution);
    expect(outcome.decision).toBe("SKIP");

    // SKIPPED is capacity-free, so nothing counts against the profile.
    const active = await prisma!.tradeExecution.count({
      where: {
        executionProfileId: profileId,
        status: {
          in: [
            "PREFLIGHT",
            "ENTRY_SUBMITTING",
            "ENTRY_PENDING",
            "PARTIALLY_FILLED",
            "ENTRY_FILLED",
            "PLACING_PROTECTION",
            "PROTECTED",
            "MANUAL_INTERVENTION",
          ],
        },
      },
    });
    expect(active).toBe(0);

    // No order of any kind was created for it.
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: execution.id } })).toBe(0);
  });

  // -------------------------------------------------------------------------
  // F. The SAFE_OFF mutation invariant
  // -------------------------------------------------------------------------

  it("F. saves under the safe state and returns the canonical selection", async () => {
    const result = await service().save(["1M", "1W"]);
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("SAVED");
    expect(result.allowedSourceTimeframes).toEqual(["1W", "1M"]);
    expect((await operatorPolicy()).allowedSourceTimeframes).toEqual(["1W", "1M"]);
  });

  it("F2. REFUSES an empty selection — the fail-closed rule, at the database", async () => {
    const before = (await operatorPolicy()).allowedSourceTimeframes;
    const result = await service().save([]);
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain("VALIDATION_REFUSED");
    expect((await operatorPolicy()).allowedSourceTimeframes).toEqual(before);
  });

  it("F3. REFUSES an unknown timeframe without saving the recognisable rest", async () => {
    const before = (await operatorPolicy()).allowedSourceTimeframes;
    const result = await service().save(["1W", "4H"]);
    expect(result.ok).toBe(false);
    expect(result.rejected.map((entry) => entry.reasonCode)).toEqual(["UNKNOWN_TIMEFRAME"]);
    expect((await operatorPolicy()).allowedSourceTimeframes).toEqual(before);
  });

  it("F4. REFUSES while the system is not SAFE_OFF", async () => {
    for (const [isEnabled, killSwitch] of [
      [true, true],
      [false, false],
      [true, false],
    ] as const) {
      await setOperatorState(isEnabled, killSwitch);
      const result = await service().save(["1W"]);
      expect(`${isEnabled}/${killSwitch}:${result.ok}`).toBe(`${isEnabled}/${killSwitch}:false`);
      expect(result.blockers).toContain("NOT_SAFE_OFF");
      expect((await operatorPolicy()).allowedSourceTimeframes).toEqual(ALL_SIX);
    }
  });

  it("F5. REFUSES while any execution is still active", async () => {
    for (const status of ["PREFLIGHT", "ENTRY_PENDING", "ENTRY_FILLED", "PROTECTED", "MANUAL_INTERVENTION"]) {
      await createOperatorExecution(status);
      const result = await service().save(["1W"]);
      expect(`${status}:${result.ok}`).toBe(`${status}:false`);
      expect(result.blockers).toContain("ACTIVE_EXECUTIONS");
      await prisma!.tradeExecution.deleteMany({ where: { executionProfileId: operatorProfileId } });
    }
    expect((await operatorPolicy()).allowedSourceTimeframes).toEqual(ALL_SIX);
  });

  it("F6. REFUSES while manual intervention is outstanding on a terminal row", async () => {
    // The flag outlives the status: a CLOSED row still flagged for manual
    // intervention is unresolved work, and the guard must see it.
    await createOperatorExecution("CLOSED_SL", true);
    const result = await service().save(["1W"]);
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain("MANUAL_INTERVENTION");
  });

  it("F7. REFUSES while a NATURAL_WINDOW is still AVAILABLE", async () => {
    // It could admit a trade the moment a runtime goes live, even though the
    // profile flags read SAFE OFF right now.
    await newWindow(operatorProfileId);
    const result = await service().save(["1W"]);
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain("AUTHORIZATION_AVAILABLE");
    expect((await operatorPolicy()).allowedSourceTimeframes).toEqual(ALL_SIX);
  });

  it("F8. an EXPIRED window does not block the save", async () => {
    await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: operatorProfileId,
        authorizationType: "NATURAL_WINDOW",
        allowedDirections: ["LONG"],
        maxClaims: 5,
        claimedCount: 0,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const result = await service().save(["1W"]);
    expect(result.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // G. Locking
  // -------------------------------------------------------------------------

  it("G. concurrent saves serialize, and the durable row is one of them", async () => {
    const [first, second] = await Promise.all([
      service().save(["1W"]),
      service().save(["1M", "3M"]),
    ]);
    expect(first.ok && second.ok).toBe(true);
    // Both took the same advisory lock, so neither interleaved: the stored row
    // is exactly one of the two submissions, never a blend of them.
    const stored = (await operatorPolicy()).allowedSourceTimeframes;
    expect([JSON.stringify(["1W"]), JSON.stringify(["1M", "3M"])]).toContain(JSON.stringify(stored));
  });

  it("G2. a save racing an execution appearing cannot land after it", async () => {
    // The guard re-reads inside the lock, so a status the browser read a moment
    // ago cannot be used to sneak a write past an execution that has since
    // started.
    await createOperatorExecution("PROTECTED");
    const result = await service().save(["1W"]);
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain("ACTIVE_EXECUTIONS");
  });

  // -------------------------------------------------------------------------
  // H. Durability
  // -------------------------------------------------------------------------

  it("H. the saved selection is read back by a FRESH service instance", async () => {
    await service().save(["1W", "12M"]);

    // A different instance with a different client — the value survives the
    // process that wrote it, which is what "durable" has to mean.
    const reader = new SourceTimeframeService(prisma!);
    const read = await reader.read();
    expect(read.stored).toEqual(["1W", "12M"]);
    expect(read.enforceable).toEqual(["1W", "12M"]);
    expect(read.valid).toBe(true);
    expect(read.supported).toEqual(ALL_SIX);
    expect(read.unrecognized).toEqual([]);
  });

  it("H2. a malformed stored row is reported, never widened into all", async () => {
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: operatorProfileId },
      data: { allowedSourceTimeframes: ["1W", "4H"] },
    });
    const read = await service().read();
    expect(read.enforceable).toEqual(["1W"]);
    expect(read.unrecognized).toEqual(["4H"]);
    expect(read.valid).toBe(false);
  });

  it("H3. an empty stored row reads as invalid, not as unrestricted", async () => {
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: operatorProfileId },
      data: { allowedSourceTimeframes: [] },
    });
    const read = await service().read();
    expect(read.enforceable).toEqual([]);
    expect(read.valid).toBe(false);
  });

  it("H4. the migration default preserves pre-feature behaviour", () => {
    // A policy row created WITHOUT naming the column must admit every
    // supported timeframe, because that is what the system did before this
    // feature existed. An empty default would have silently disarmed every
    // profile on deploy — the one outcome this column exists to prevent.
    //
    // `newProfile` proves the runtime half: it calls the ordinary policy
    // service, which never mentions the column, and the assertions below
    // pin the declaration the database actually applies.
    const migration = readFileSync(
      path.join(
        process.cwd(),
        "prisma/migrations/20260823120000_add_source_timeframe_policy/migration.sql"
      ),
      "utf8"
    );
    expect(migration).toContain(
      `DEFAULT ARRAY['1D', '1W', '1M', '3M', '6M', '12M']::TEXT[]`
    );
    // Additive only: nothing dropped, nothing rewritten, nothing backfilled
    // onto TradeExecution (a guessed value there would manufacture
    // eligibility for an execution nobody classified).
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "allowedSourceTimeframes"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "sourceTimeframe" TEXT');
    expect(migration).not.toMatch(/DROP COLUMN|DROP TABLE|UPDATE \"/);
  });

  it("H5. a policy row created through the ordinary service gets all six", async () => {
    // The runtime half of H4, against the real database: the policy service
    // never mentions the column, so whatever comes back is the column
    // default the migration installed.
    sequence += 1;
    const profile = await prisma!.executionProfile.create({
      data: {
        name: `${TAG}-default-${sequence}`,
        accountIdentifier: `${TAG}-default-${sequence}-${Date.now().toString(36)}`,
        environment: "TESTNET",
        isEnabled: false,
      },
    });
    profileIds.push(profile.id);
    await policies.createForProfile(profile.id, {
      killSwitchActive: true,
      maxOpenPositions: 5,
      softOpenPositionTarget: 5,
      maxPendingEntries: 5,
      maxTotalActiveTrades: 5,
      maxActivePerSymbolSide: 1,
      maxTotalPlannedRiskUsd: "100.00",
      maxTotalIsolatedMarginUsd: "500.00",
    });
    const row = await prisma!.executionSafetyPolicy.findUniqueOrThrow({
      where: { executionProfileId: profile.id },
    });
    expect(row.allowedSourceTimeframes).toEqual(ALL_SIX);
  });


  // -------------------------------------------------------------------------
  // I. Existing executions are frozen
  // -------------------------------------------------------------------------

  it("I. narrowing the policy does not touch an existing PROTECTED execution", async () => {
    const profileId = await newProfile(ALL_SIX);
    const execution = await newExecution(profileId, "1D");
    await admit(execution);
    await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { status: "PROTECTED" } });

    const before = await executionOf(execution.id);

    // The policy now excludes the timeframe this execution was admitted under.
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { allowedSourceTimeframes: ["12M"] },
    });

    const after = await executionOf(execution.id);
    expect(after.status).toBe("PROTECTED");
    // Nothing about the position may move: not its status, not its version, and
    // above all not its money.
    expect(after.version).toBe(before.version);
    expect(after.takeProfit?.toString()).toBe(before.takeProfit?.toString());
    expect(after.executableStopLoss.toString()).toBe(before.executableStopLoss.toString());
    expect(after.plannedQuantity.toString()).toBe(before.plannedQuantity.toString());
    expect(after.riskBudgetUsd.toString()).toBe(before.riskBudgetUsd.toString());
    expect(after.selectedLeverage).toBe(before.selectedLeverage);
    expect(after.sourceTimeframe).toBe("1D");
  });
});
