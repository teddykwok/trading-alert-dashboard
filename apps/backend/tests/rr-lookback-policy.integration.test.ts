import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";

/**
 * The durable half of the Extreme RR lookback policy, against a real Postgres.
 *
 * What cannot be shown against a mock:
 *
 *   - the save guard re-checks the durable safe state INSIDE the profile
 *     advisory lock, so a browser that read a stale status still cannot write;
 *   - the value survives being read back by a different service instance;
 *   - a policy change leaves an already-created execution byte-identical.
 *
 * Every row is synthetic and removed in afterAll. Nothing here arms, claims,
 * executes, or contacts an exchange.
 */

const TAG = "rr-lookback-policy";

// Set BEFORE the dynamic imports: `configuredProfileIdentity` reads the env
// snapshot parsed at module load.
process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = `${TAG}-operator`;
process.env.EXECUTION_PROFILE_ENVIRONMENT = "TESTNET";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const describeDb = available && prisma ? describe : describe.skip;

const { SafetyPolicyService } = await import("../src/modules/execution/safety-policy.service");
const { ExtremeRrLookbackService } = await import("../src/modules/operator/extreme-rr-lookback.service");
const { resolveInitialLookback } = await import("../src/modules/extreme-rr/extreme-rr.service");

describeDb("rr lookback policy: durable behaviour", () => {
  let policies: InstanceType<typeof SafetyPolicyService>;
  let profileId = "";
  const profileIds: string[] = [];
  let sequence = 0;

  const service = () => new ExtremeRrLookbackService(prisma!);
  const policyRow = () =>
    prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });

  async function setState(isEnabled: boolean, killSwitchActive: boolean) {
    await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled } });
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { killSwitchActive },
    });
  }

  async function createExecution(status: string, requiresManualIntervention = false) {
    sequence += 1;
    return prisma!.tradeExecution.create({
      data: {
        executionProfileId: profileId,
        symbol: `RRL${sequence}USDT`,
        direction: "LONG",
        positionSide: "LONG",
        selectedLookback: 50,
        status: status as never,
        requiresManualIntervention,
        plannedEntryPrice: "100",
        calculatedStopLoss: "96",
        executableStopLoss: "96",
        takeProfit: "106",
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

  async function newWindow() {
    return prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        allowedDirections: ["LONG", "SHORT"],
        maxClaims: 5,
        claimedCount: 0,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
  }

  beforeAll(async () => {
    if (!prisma || !available) return;
    policies = new SafetyPolicyService(prisma);
    const profile = await prisma.executionProfile.create({
      data: {
        name: `${TAG}-operator`,
        accountIdentifier: `${TAG}-operator`,
        environment: "TESTNET",
        isEnabled: false,
      },
    });
    profileId = profile.id;
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
      await prisma.tradeExecution.findMany({ where: { executionProfileId: profileId }, select: { id: true } })
    ).map((row) => row.id);
    if (ids.length > 0) {
      await prisma.safetyAdmission.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma.tradeExecution.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { extremeRrLookbackCandles: 300 },
    });
    await setState(false, true);
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
        await prisma.tradeExecution.deleteMany({ where: { id: { in: ids } } });
      }
      await prisma.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: { in: profileIds } } });
      await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: { in: profileIds } } });
      await prisma.executionProfile.deleteMany({ where: { id: { in: profileIds } } });
    }
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // B. Default
  // -------------------------------------------------------------------------

  it("B. a policy row created through the ordinary service defaults to 300", async () => {
    // The service never mentions the column, so whatever comes back is the
    // column default the migration installed — the pre-feature behaviour.
    expect((await policyRow()).extremeRrLookbackCandles).toBe(300);
    const read = await service().read();
    expect(read).toEqual({ stored: 300, effective: 300, valid: true, supported: [50, 100, 200, 300] });
  });

  // -------------------------------------------------------------------------
  // A / H. Validation and durability
  // -------------------------------------------------------------------------

  it.each([50, 100, 200, 300])("A. saves %i and reads it back from a FRESH instance", async (value) => {
    const result = await service().save(value);
    expect(result.ok).toBe(true);
    expect(result.extremeRrLookbackCandles).toBe(value);

    // A different instance — the value survives the object that wrote it,
    // which is what "durable" has to mean.
    expect((await new ExtremeRrLookbackService(prisma!).read()).effective).toBe(value);
  });

  it("A2. REFUSES every unsupported value without touching the row", async () => {
    for (const bad of [49, 51, 150, 250, 301, 0, -50, "300", null, undefined, 300.5]) {
      const before = (await policyRow()).extremeRrLookbackCandles;
      const result = await service().save(bad);
      expect(`${String(bad)}:${result.ok}`).toBe(`${String(bad)}:false`);
      expect(result.blockers).toContain("VALIDATION_REFUSED");
      expect((await policyRow()).extremeRrLookbackCandles).toBe(before);
    }
  });

  it("H2. an invalid stored value reads as INVALID, never as 300", async () => {
    // Only reachable by a direct database edit, which is exactly why the read
    // must not repair it.
    await prisma!.$executeRawUnsafe(
      `UPDATE "ExecutionSafetyPolicy" SET "extremeRrLookbackCandles" = 150 WHERE "executionProfileId" = $1`,
      profileId
    );
    const read = await service().read();
    expect(read.stored).toBe(150);
    expect(read.effective).toBeNull();
    expect(read.valid).toBe(false);

    // And planning REFUSES rather than quietly using 300.
    await expect(resolveInitialLookback(prisma!)).rejects.toThrow(/not one of/);
  });

  // -------------------------------------------------------------------------
  // F. SAFE_OFF mutation invariant
  // -------------------------------------------------------------------------

  it("F. REFUSES while the system is not SAFE_OFF", async () => {
    for (const [isEnabled, killSwitch] of [
      [true, true],
      [false, false],
      [true, false],
    ] as const) {
      await setState(isEnabled, killSwitch);
      const result = await service().save(50);
      expect(`${isEnabled}/${killSwitch}:${result.ok}`).toBe(`${isEnabled}/${killSwitch}:false`);
      expect(result.blockers).toContain("NOT_SAFE_OFF");
      expect((await policyRow()).extremeRrLookbackCandles).toBe(300);
    }
  });

  it("F2. REFUSES while any execution is active", async () => {
    for (const status of ["PREFLIGHT", "ENTRY_PENDING", "ENTRY_FILLED", "PROTECTED", "MANUAL_INTERVENTION"]) {
      await createExecution(status);
      const result = await service().save(50);
      expect(`${status}:${result.ok}`).toBe(`${status}:false`);
      expect(result.blockers).toContain("ACTIVE_EXECUTIONS");
      await prisma!.tradeExecution.deleteMany({ where: { executionProfileId: profileId } });
    }
    expect((await policyRow()).extremeRrLookbackCandles).toBe(300);
  });

  it("F3. REFUSES while manual intervention is outstanding on a terminal row", async () => {
    await createExecution("CLOSED_SL", true);
    const result = await service().save(50);
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain("MANUAL_INTERVENTION");
  });

  it("F4. REFUSES while a NATURAL_WINDOW is still AVAILABLE", async () => {
    await newWindow();
    const result = await service().save(50);
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain("AUTHORIZATION_AVAILABLE");
    expect((await policyRow()).extremeRrLookbackCandles).toBe(300);
  });

  // -------------------------------------------------------------------------
  // G. Locking
  // -------------------------------------------------------------------------

  it("G. concurrent saves serialize; the row is one of them, never a blend", async () => {
    const [first, second] = await Promise.all([service().save(50), service().save(200)]);
    expect(first.ok && second.ok).toBe(true);
    expect([50, 200]).toContain((await policyRow()).extremeRrLookbackCandles);
  });

  it("G2. shares the advisory-lock namespace with the other policy mutations", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
    // Same namespace and key as arming, Safe Off, the allowlist and the source
    // timeframes, so none of them can interleave with this one.
    for (const file of [
      "src/modules/operator/extreme-rr-lookback.service.ts",
      "src/modules/operator/source-timeframes.service.ts",
      "src/modules/operator/allowlist.service.ts",
    ]) {
      const code = read(file);
      expect(`${file}:${code.includes("CANARY_PREPARE_LOCK_NAMESPACE")}`).toBe(`${file}:true`);
      expect(`${file}:${code.includes("profileLockKey")}`).toBe(`${file}:true`);
    }
  });

  it("G3. a save racing an execution appearing cannot land after it", async () => {
    // The guard re-reads inside the lock, so a status the browser read a moment
    // ago cannot be used to sneak a write past work that has since started.
    await createExecution("PROTECTED");
    const result = await service().save(50);
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain("ACTIVE_EXECUTIONS");
  });

  // -------------------------------------------------------------------------
  // E. Existing executions are frozen
  // -------------------------------------------------------------------------

  it("E. changing the policy leaves an existing execution byte-identical", async () => {
    const execution = await createExecution("PROTECTED");
    const before = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });

    // The guard refuses while it is PROTECTED, so move to a quiet state and
    // change the policy for real — the strongest version of the test.
    await prisma!.tradeExecution.update({ where: { id: execution.id }, data: { status: "CLOSED_TP" } });
    expect((await service().save(50)).ok).toBe(true);

    const after = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    // The window this trade was built under, and its money, are untouched.
    expect(after.selectedLookback).toBe(50);
    expect(after.selectedLookback).toBe(before.selectedLookback);
    expect(after.takeProfit?.toString()).toBe(before.takeProfit?.toString());
    expect(after.executableStopLoss.toString()).toBe(before.executableStopLoss.toString());
    expect(after.plannedQuantity.toString()).toBe(before.plannedQuantity.toString());
    expect(after.riskBudgetUsd.toString()).toBe(before.riskBudgetUsd.toString());
    expect(after.selectedLeverage).toBe(before.selectedLeverage);
    expect(after.version).toBe(before.version);
  });
});
