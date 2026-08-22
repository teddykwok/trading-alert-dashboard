import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";
import type { BinanceSymbolFiltersDto } from "../src/modules/binance/binance.types";
import type { SymbolMetadataIndex } from "../src/modules/operator/symbol-allowlist";

/**
 * The durable half of the allowlist feature.
 *
 * Every test runs against the guarded `_test` database and a FAKE metadata
 * index, so nothing here reaches MAINNET, the real policy row or the exchange.
 * The parsing and eligibility rules themselves are proven in
 * `symbol-allowlist.test.ts`; this file is about the mutation guard.
 */

const TEST_IDENTIFIER = "allowlist-service-test";
// Set BEFORE the dynamic import below: `configuredProfileIdentity` reads the
// env snapshot parsed at module load, not `process.env` at call time.
process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = TEST_IDENTIFIER;
process.env.EXECUTION_PROFILE_ENVIRONMENT = "MAINNET";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const describeDb = available && prisma ? describe : describe.skip;

const { AllowlistService } = await import("../src/modules/operator/allowlist.service");

const REVIEWED_POLICY = {
  maxOpenPositions: 5,
  maxPendingEntries: 5,
  maxTotalActiveTrades: 5,
  maxActivePerSymbolSide: 1,
  softOpenPositionTarget: 3,
  maxTotalPlannedRiskUsd: "7.50",
  maxTotalIsolatedMarginUsd: "40",
};

function filters(symbol: string, overrides: Partial<BinanceSymbolFiltersDto> = {}): BinanceSymbolFiltersDto {
  return {
    symbol,
    status: "TRADING",
    contractType: "PERPETUAL",
    tickSize: "0.10",
    minPrice: "0.10",
    maxPrice: "1000000",
    stepSize: "0.001",
    minQty: "0.001",
    maxQty: "1000",
    minNotional: "5",
    ...overrides,
  } as BinanceSymbolFiltersDto;
}

const METADATA: SymbolMetadataIndex = new Map(
  ["FHEUSDT", "COWUSDT", "BTCUSDT", "ETHUSDT"].map((symbol) => [symbol, filters(symbol)])
);

describeDb("operator allowlist", () => {
  let profileId = "";

  const service = (loadMetadata: () => Promise<SymbolMetadataIndex> = async () => METADATA) =>
    new AllowlistService(prisma!, { loadMetadata });

  async function setProfile(isEnabled: boolean, killSwitchActive: boolean) {
    await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled } });
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { killSwitchActive },
    });
  }

  async function createExecution(status: string, requiresManualIntervention = false): Promise<void> {
    await prisma!.tradeExecution.create({
      data: {
        executionProfileId: profileId,
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

  const policy = () =>
    prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });

  beforeAll(async () => {
    const profile = await prisma!.executionProfile.create({
      data: {
        name: TEST_IDENTIFIER,
        accountIdentifier: TEST_IDENTIFIER,
        environment: "MAINNET",
        isEnabled: false,
      },
    });
    profileId = profile.id;
    await prisma!.executionSafetyPolicy.create({
      data: {
        executionProfileId: profileId,
        killSwitchActive: true,
        allowedSymbols: ["COWUSDT"],
        ...REVIEWED_POLICY,
      },
    });
  });

  afterEach(async () => {
    const ids = (
      await prisma!.tradeExecution.findMany({ where: { executionProfileId: profileId }, select: { id: true } })
    ).map((row) => row.id);
    if (ids.length > 0) {
      await prisma!.executionEvent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
      await prisma!.tradeExecution.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma!.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { allowedSymbols: ["COWUSDT"] },
    });
    await setProfile(false, true);
  });

  afterAll(async () => {
    await prisma!.executionSafetyPolicy.deleteMany({ where: { executionProfileId: profileId } });
    await prisma!.executionProfile.deleteMany({ where: { id: profileId } });
  });

  // --- validate: a dry run that must never write --------------------------

  it("validates without touching the durable policy", async () => {
    const before = (await policy()).allowedSymbols;
    const result = await service().validate("FHEUSDT.P\nBTCUSDT.P");

    expect(result.ok).toBe(true);
    expect(result.accepted).toEqual(["FHEUSDT", "BTCUSDT"]);
    expect(result.current).toEqual(["COWUSDT"]);
    expect((await policy()).allowedSymbols).toEqual(before);
  });

  it("refuses when exchange metadata cannot be read, rather than assuming", async () => {
    const result = await service(async () => {
      throw new Error("exchange unreachable");
    }).validate("FHEUSDT.P");

    expect(result.ok).toBe(false);
    expect(result.refusal).toContain("could not be read");
    expect((await policy()).allowedSymbols).toEqual(["COWUSDT"]);
  });

  // --- save: the durable mutation -----------------------------------------

  it("SAVES a validated list while SAFE_OFF and reports the new durable value", async () => {
    const result = await service().save("FHEUSDT.P, BTCUSDT.P, ETHUSDT.P");

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("SAVED");
    expect(result.allowedSymbols).toEqual(["FHEUSDT", "BTCUSDT", "ETHUSDT"]);
    expect((await policy()).allowedSymbols).toEqual(["FHEUSDT", "BTCUSDT", "ETHUSDT"]);
  });

  it("replaces the previous list rather than appending to it", async () => {
    await service().save("FHEUSDT.P");
    expect((await policy()).allowedSymbols).toEqual(["FHEUSDT"]);
    expect((await policy()).allowedSymbols).not.toContain("COWUSDT");
  });

  it("re-validates on save and never trusts a client claim", async () => {
    // The client sends raw text both times; there is no "already validated"
    // channel to abuse.
    const result = await service().save("NOPEUSDT\n<SYMBOL>");
    expect(result.ok).toBe(false);
    expect(result.blockers).toEqual(["VALIDATION_REFUSED"]);
    expect((await policy()).allowedSymbols).toEqual(["COWUSDT"]);
  });

  // --- the empty fail-safe, at the durable boundary ------------------------

  it("REFUSES to save an empty list, so [] can never mean allow-all", async () => {
    for (const raw of ["", "   ", "\n\n", "<SYMBOL>"]) {
      const result = await service().save(raw);
      expect(`${JSON.stringify(raw)}:${result.ok}`).toBe(`${JSON.stringify(raw)}:false`);
      expect((await policy()).allowedSymbols).toEqual(["COWUSDT"]);
    }
  });

  it("REFUSES a non-string body", async () => {
    for (const raw of [null, undefined, 42, {}, ["FHEUSDT"]]) {
      const result = await service().save(raw);
      expect(`${typeof raw}:${result.ok}`).toBe(`${typeof raw}:false`);
    }
    expect((await policy()).allowedSymbols).toEqual(["COWUSDT"]);
  });

  // --- the SAFE_OFF guard, enforced on the server --------------------------

  it("REJECTS a save while ARMED", async () => {
    await setProfile(true, false);
    const result = await service().save("FHEUSDT.P");

    expect(result.ok).toBe(false);
    expect(result.blockers).toEqual(["NOT_SAFE_OFF"]);
    expect((await policy()).allowedSymbols).toEqual(["COWUSDT"]);
  });

  it("REJECTS a save when the profile is enabled even with the kill switch on", async () => {
    await setProfile(true, true);
    const result = await service().save("FHEUSDT.P");
    expect(result.blockers).toEqual(["NOT_SAFE_OFF"]);
  });

  it("REJECTS a save when the kill switch is released even while disabled", async () => {
    await setProfile(false, false);
    const result = await service().save("FHEUSDT.P");
    expect(result.blockers).toEqual(["NOT_SAFE_OFF"]);
  });

  it("REJECTS a save while an execution is still active", async () => {
    for (const status of ["ENTRY_PENDING", "ENTRY_FILLED", "PROTECTED", "PLACING_PROTECTION"]) {
      await prisma!.tradeExecution.deleteMany({ where: { executionProfileId: profileId } });
      await createExecution(status);
      const result = await service().save("FHEUSDT.P");
      expect(`${status}:${result.ok}`).toBe(`${status}:false`);
      expect(`${status}:${result.blockers[0]}`).toBe(`${status}:ACTIVE_EXECUTIONS`);
      expect((await policy()).allowedSymbols).toEqual(["COWUSDT"]);
    }
  });

  it("REJECTS a save while manual intervention is outstanding", async () => {
    await createExecution("CLOSED_SL", true);
    const result = await service().save("FHEUSDT.P");

    expect(result.ok).toBe(false);
    expect(result.blockers).toEqual(["MANUAL_INTERVENTION"]);
    expect((await policy()).allowedSymbols).toEqual(["COWUSDT"]);
  });

  // --- durable recovery / critical conditions -----------------------------
  //
  // The repository's canonical "is durable state safe for an operator action"
  // helper is the launcher's `evaluateDurableSafety`. It refuses on four
  // things: not SAFE_OFF, an AVAILABLE window, active executions, manual
  // intervention, and outstanding RECOVERY_WARNINGS. These tests pin that the
  // allowlist save refuses on the same set — two of them indirectly, and the
  // indirection is what is proven here rather than assumed.

  it("REJECTS every FILLED_WITHOUT_VERIFIED_PROTECTION status, the recovery-required signal", async () => {
    // The warning is derived from exactly these three statuses, and every one
    // of them is inside TOTAL_ACTIVE_STATUSES — so the active-execution guard
    // already covers the recovery warning. This proves the relationship.
    for (const status of ["PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION"]) {
      await prisma!.tradeExecution.deleteMany({ where: { executionProfileId: profileId } });
      await createExecution(status);
      const result = await service().save("FHEUSDT.P");
      expect(`${status}:${result.ok}`).toBe(`${status}:false`);
      expect(`${status}:${result.blockers[0]}`).toBe(`${status}:ACTIVE_EXECUTIONS`);
      expect((await policy()).allowedSymbols).toEqual(["COWUSDT"]);
    }
  });

  it("REJECTS the MANUAL_INTERVENTION_REQUIRED signal by either of its two sources", async () => {
    // The preflight's recoveryRequiredCount uses this exact OR, so "recovery
    // required" and "manual intervention" are one condition in this repository.
    for (const [status, flag] of [
      ["MANUAL_INTERVENTION", false],
      ["CLOSED_SL", true],
    ] as const) {
      await prisma!.tradeExecution.deleteMany({ where: { executionProfileId: profileId } });
      await createExecution(status, flag);
      const result = await service().save("FHEUSDT.P");
      expect(`${status}:${result.ok}`).toBe(`${status}:false`);
      expect((await policy()).allowedSymbols).toEqual(["COWUSDT"]);
    }
  });

  it("REJECTS a save while a natural window is still AVAILABLE, even when SAFE_OFF", async () => {
    // Reachable: `execution:prepare-natural-window` prepares WITHOUT arming, so
    // the profile stays SAFE OFF while an authorization is live. Changing the
    // allowlist here would let that window admit symbols nobody reviewed.
    await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        allowedDirections: ["LONG", "SHORT"],
        maxClaims: 5,
        claimedCount: 0,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });

    const result = await service().save("FHEUSDT.P");

    expect(result.ok).toBe(false);
    expect(result.blockers).toEqual(["AUTHORIZATION_AVAILABLE"]);
    expect((await policy()).allowedSymbols).toEqual(["COWUSDT"]);
  });

  it("ALLOWS the save once that window is revoked, expired or exhausted", async () => {
    const base = {
      executionProfileId: profileId,
      authorizationType: "NATURAL_WINDOW" as const,
      allowedDirections: ["LONG", "SHORT"] as never,
      maxClaims: 5,
    };
    for (const [label, data] of [
      ["revoked", { ...base, claimedCount: 0, expiresAt: new Date(Date.now() + 30 * 60_000), revokedAt: new Date() }],
      ["expired", { ...base, claimedCount: 0, expiresAt: new Date(Date.now() - 60_000) }],
      ["exhausted", { ...base, claimedCount: 5, expiresAt: new Date(Date.now() + 30 * 60_000) }],
    ] as const) {
      await prisma!.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
      await prisma!.executionSafetyPolicy.update({
        where: { executionProfileId: profileId },
        data: { allowedSymbols: ["COWUSDT"] },
      });
      await prisma!.executionCanaryAuthorization.create({ data });

      const result = await service().save("FHEUSDT.P");
      expect(`${label}:${result.ok}`).toBe(`${label}:true`);
      expect(`${label}:${(await policy()).allowedSymbols.join(",")}`).toBe(`${label}:FHEUSDT`);
    }
  });

  it("ALLOWS a clean SAFE_OFF save once every condition is resolved", async () => {
    // The positive control for all four refusals above.
    await createExecution("CLOSED_TP");
    const result = await service().save("FHEUSDT.P, BTCUSDT.P");
    expect(result.ok).toBe(true);
    expect((await policy()).allowedSymbols).toEqual(["FHEUSDT", "BTCUSDT"]);
  });

  // --- what saving must NOT do --------------------------------------------

  it("creates NO authorization and changes NO trading state", async () => {
    const before = await prisma!.executionProfile.findUniqueOrThrow({ where: { id: profileId } });
    const result = await service().save("FHEUSDT.P");
    expect(result.ok).toBe(true);

    const after = await prisma!.executionProfile.findUniqueOrThrow({ where: { id: profileId } });
    const policyAfter = await policy();

    expect(after.isEnabled).toBe(before.isEnabled);
    expect(policyAfter.killSwitchActive).toBe(true);
    expect(
      await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })
    ).toBe(0);
  });

  it("leaves every risk, margin and capacity value untouched", async () => {
    const before = await policy();
    await service().save("FHEUSDT.P, BTCUSDT.P");
    const after = await policy();

    for (const field of [
      "maxOpenPositions",
      "maxPendingEntries",
      "maxTotalActiveTrades",
      "maxActivePerSymbolSide",
      "softOpenPositionTarget",
      "maxAlertAgeSeconds",
    ] as const) {
      expect(`${field}:${after[field]}`).toBe(`${field}:${before[field]}`);
    }
    expect(after.maxTotalPlannedRiskUsd.toString()).toBe(before.maxTotalPlannedRiskUsd.toString());
    expect(after.maxTotalIsolatedMarginUsd.toString()).toBe(before.maxTotalIsolatedMarginUsd.toString());
  });

  it("advances the policy version so a concurrent reader can notice", async () => {
    const before = (await policy()).version;
    await service().save("FHEUSDT.P");
    expect((await policy()).version).toBe(before + 1);
  });
});
