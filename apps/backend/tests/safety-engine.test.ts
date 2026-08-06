import { describe, expect, it } from "vitest";
import {
  CAPACITY_FREE_STATUSES,
  OPEN_POSITION_STATUSES,
  PENDING_ENTRY_STATUSES,
  TOTAL_ACTIVE_STATUSES,
  consumesNoCapacity,
  consumesOpenPosition,
  consumesPendingEntry,
  consumesTotalActive,
  symbolSideKey,
} from "../src/modules/execution/capacity-status";
import { TRADE_EXECUTION_STATUSES } from "../src/modules/execution/execution-status";
import {
  SAFETY_REASON_CODES,
  classifySafetyReasonRetryability,
  evaluateSafetyAdmission,
  resolveEffectivePolicy,
  type BinanceCapacitySnapshot,
  type EffectiveSafetyPolicy,
  type LocalCapacitySnapshot,
  type ProposedExecution,
  type SafetyEvaluationInput,
  type SafetyReasonCode,
  type SymbolStateSnapshot,
} from "../src/modules/execution/safety-engine";

/**
 * Phase 5 pure safety engine tests. Everything here is synthetic — no live
 * account values, symbols or balances.
 */

const EVALUATED_AT = new Date("2026-01-01T12:00:00.000Z");
const SIGNAL_AT = new Date("2026-01-01T11:59:00.000Z"); // 60s old

const SYMBOL = "SYNTHUSDT";

function proposed(overrides: Partial<ProposedExecution> = {}): ProposedExecution {
  return {
    executionId: "exec-synthetic-1",
    profileId: "profile-synthetic-1",
    symbol: SYMBOL,
    positionSide: "LONG",
    signalTriggeredAt: SIGNAL_AT,
    currentStatus: "PLAN_READY",
    riskBudgetUsd: "1.00",
    actualPlannedLoss: "0.98",
    estimatedInitialMargin: "2.00",
    maximumIsolatedMargin: "3.00",
    // LONG: liquidation must sit BELOW the required boundary.
    estimatedLiquidationPrice: "90",
    requiredLiquidationBoundary: "95",
    marginPlanStatus: "READY",
    selectedLeverage: 5,
    hasMarginPlanSnapshot: true,
    ...overrides,
  };
}

function policy(overrides: Partial<EffectiveSafetyPolicy> = {}): EffectiveSafetyPolicy {
  return {
    killSwitchActive: false,
    globalKillSwitchActive: false,
    profileKillSwitchActive: false,
    profileEnabled: true,
    policyPresent: true,
    environmentMatchesConnector: true,
    expectedPositionMode: "HEDGE",
    expectedMarginType: "ISOLATED",
    maxOpenPositions: 1,
    maxPendingEntries: 1,
    maxTotalActiveTrades: 1,
    maxTotalPlannedRiskUsd: "1.50",
    maxTotalIsolatedMarginUsd: "5.00",
    maxActivePerSymbolSide: 1,
    maxAlertAgeSeconds: 300,
    signalFutureToleranceSeconds: 5,
    allowedSymbols: [],
    ...overrides,
  };
}

function local(overrides: Partial<LocalCapacitySnapshot> = {}): LocalCapacitySnapshot {
  return {
    openPositionCount: 0,
    pendingEntryCount: 0,
    totalActiveCount: 0,
    reservedRiskUsd: "0",
    reservedMaximumMarginUsd: "0",
    activeSymbolSideKeys: [],
    pendingUnreflectedMarginUsd: "0",
    alreadyAdmitted: false,
    ...overrides,
  };
}

function binance(overrides: Partial<BinanceCapacitySnapshot> = {}): BinanceCapacitySnapshot {
  return {
    available: true,
    positionMode: "HEDGE",
    assetMode: "SINGLE_ASSET",
    usdtAvailableBalance: "100.00",
    symbolsWithPosition: [],
    symbolsWithOpenOrder: [],
    snapshotAt: EVALUATED_AT,
    ...overrides,
  };
}

function symbolState(overrides: Partial<SymbolStateSnapshot> = {}): SymbolStateSnapshot {
  return {
    available: true,
    exists: true,
    status: "TRADING",
    contractType: "PERPETUAL",
    hasFiltersSnapshot: true,
    hasBracketSnapshot: true,
    ...overrides,
  };
}

function evaluate(overrides: Partial<SafetyEvaluationInput> = {}) {
  return evaluateSafetyAdmission({
    evaluatedAt: EVALUATED_AT,
    proposed: proposed(),
    policy: policy(),
    local: local(),
    binance: binance(),
    symbolState: symbolState(),
    ...overrides,
  });
}

function reasonCodes(result: ReturnType<typeof evaluate>): SafetyReasonCode[] {
  return result.failedChecks.map((check) => check.reasonCode);
}

// ---------------------------------------------------------------------------
// Capacity classification
// ---------------------------------------------------------------------------

describe("capacity classification", () => {
  it("counts PARTIALLY_FILLED as both a pending entry and an open position", () => {
    expect(consumesPendingEntry("PARTIALLY_FILLED")).toBe(true);
    expect(consumesOpenPosition("PARTIALLY_FILLED")).toBe(true);
    expect(consumesTotalActive("PARTIALLY_FILLED")).toBe(true);
  });

  it("treats PLAN_READY as consuming no capacity until admission succeeds", () => {
    expect(consumesPendingEntry("PLAN_READY")).toBe(false);
    expect(consumesOpenPosition("PLAN_READY")).toBe(false);
    expect(consumesTotalActive("PLAN_READY")).toBe(false);
    expect(consumesNoCapacity("PLAN_READY")).toBe(true);
  });

  it("treats every terminal status as free capacity", () => {
    for (const status of ["ENTRY_EXPIRED", "CLOSED_TP", "CLOSED_SL", "CANCELED", "SKIPPED", "FAILED"] as const) {
      expect(consumesTotalActive(status)).toBe(false);
      expect(consumesNoCapacity(status)).toBe(true);
    }
  });

  it("counts MANUAL_INTERVENTION as an open position (exposure may exist)", () => {
    expect(consumesOpenPosition("MANUAL_INTERVENTION")).toBe(true);
    expect(consumesPendingEntry("MANUAL_INTERVENTION")).toBe(false);
  });

  it("classifies PREFLIGHT as pending-only", () => {
    expect(consumesPendingEntry("PREFLIGHT")).toBe(true);
    expect(consumesOpenPosition("PREFLIGHT")).toBe(false);
  });

  it("makes total-active exactly the union of pending and open", () => {
    const union = new Set<string>([...PENDING_ENTRY_STATUSES, ...OPEN_POSITION_STATUSES]);
    expect([...union].sort()).toEqual([...TOTAL_ACTIVE_STATUSES].sort());
  });

  it("classifies every known status exactly once as active or free", () => {
    for (const status of TRADE_EXECUTION_STATUSES) {
      const active = consumesTotalActive(status);
      const free = consumesNoCapacity(status);
      expect(active).toBe(!free);
    }
    expect(TOTAL_ACTIVE_STATUSES.length + CAPACITY_FREE_STATUSES.length).toBe(TRADE_EXECUTION_STATUSES.length);
  });

  it("builds a normalized uppercase symbol/side key", () => {
    expect(symbolSideKey(" synthusdt ", "long")).toBe("SYNTHUSDT:LONG");
  });
});

// ---------------------------------------------------------------------------
// Effective policy resolution
// ---------------------------------------------------------------------------

describe("effective policy resolution", () => {
  const globalLimits = {
    killSwitchActive: false,
    maxOpenPositions: 2,
    maxPendingEntries: 2,
    maxTotalActiveTrades: 4,
    maxTotalPlannedRiskUsd: "1.50",
    maxTotalIsolatedMarginUsd: "5.00",
    maxActivePerSymbolSide: 2,
    maxAlertAgeSeconds: 300,
    signalFutureToleranceSeconds: 5,
  };
  const profileLimits = {
    present: true,
    enabled: true,
    environmentMatchesConnector: true,
    killSwitchActive: false,
    expectedPositionMode: "HEDGE" as const,
    expectedMarginType: "ISOLATED" as const,
    maxOpenPositions: 1,
    maxPendingEntries: 3,
    maxTotalActiveTrades: 2,
    maxTotalPlannedRiskUsd: "2.00",
    maxTotalIsolatedMarginUsd: "4.00",
    maxActivePerSymbolSide: 1,
    maxAlertAgeSeconds: 120,
    allowedSymbols: ["synthusdt"],
  };

  it("takes the stricter of global and profile for every limit", () => {
    const effective = resolveEffectivePolicy(globalLimits, profileLimits);
    expect(effective.maxOpenPositions).toBe(1);
    expect(effective.maxPendingEntries).toBe(2);
    expect(effective.maxTotalActiveTrades).toBe(2);
    expect(effective.maxTotalPlannedRiskUsd).toBe("1.50");
    expect(effective.maxTotalIsolatedMarginUsd).toBe("4.00");
    expect(effective.maxActivePerSymbolSide).toBe(1);
    expect(effective.maxAlertAgeSeconds).toBe(120);
  });

  it("uppercases the allowlist", () => {
    expect(resolveEffectivePolicy(globalLimits, profileLimits).allowedSymbols).toEqual(["SYNTHUSDT"]);
  });

  it("activates the effective kill switch when only the global switch is on", () => {
    const effective = resolveEffectivePolicy({ ...globalLimits, killSwitchActive: true }, profileLimits);
    expect(effective.killSwitchActive).toBe(true);
  });

  it("activates the effective kill switch when only the profile switch is on", () => {
    const effective = resolveEffectivePolicy(globalLimits, { ...profileLimits, killSwitchActive: true });
    expect(effective.killSwitchActive).toBe(true);
  });

  it("keeps the switch released only when both sides are released", () => {
    expect(resolveEffectivePolicy(globalLimits, profileLimits).killSwitchActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

describe("safety engine decisions", () => {
  it("passes a clean synthetic admission", () => {
    const result = evaluate();
    expect(result.decision).toBe("PASS");
    expect(result.reasonCode).toBeNull();
    expect(result.failedChecks).toHaveLength(0);
  });

  it("is deterministic for identical inputs", () => {
    expect(JSON.stringify(evaluate())).toBe(JSON.stringify(evaluate()));
  });

  it("reserves the FULL risk budget, not the reduced actual planned loss", () => {
    const result = evaluate();
    expect(result.proposedReservations.riskUsd).toBe("1.00");
    expect(result.proposedReservations.riskUsd).not.toBe("0.98");
  });

  it("reserves the MAXIMUM isolated margin, not the estimated initial margin", () => {
    const result = evaluate();
    expect(result.proposedReservations.marginUsd).toBe("3.00");
    expect(result.proposedReservations.marginUsd).not.toBe("2.00");
  });

  it("reports the projected capacity totals", () => {
    const result = evaluate({ local: local({ reservedRiskUsd: "0.25", reservedMaximumMarginUsd: "1.00" }) });
    expect(result.capacityProjected.reservedRiskUsd).toBe("1.25");
    expect(result.capacityProjected.reservedMarginUsd).toBe("4");
    expect(result.capacityProjected.pendingEntryCount).toBe(1);
    expect(result.capacityProjected.totalActiveCount).toBe(1);
  });

  it("never returns PASS when any check failed", () => {
    const result = evaluate({ policy: policy({ profileEnabled: false }) });
    expect(result.decision).not.toBe("PASS");
    expect(result.failedChecks.length).toBeGreaterThan(0);
  });

  it("records every failed check, not just the first", () => {
    const result = evaluate({
      policy: policy({ profileEnabled: false }),
      local: local({ openPositionCount: 1, totalActiveCount: 1 }),
    });
    expect(reasonCodes(result)).toContain("PROFILE_DISABLED");
    expect(reasonCodes(result)).toContain("OPEN_POSITION_LIMIT_REACHED");
    expect(result.reasonCode).toBe("PROFILE_DISABLED");
  });

  it("echoes the caller-supplied evaluatedAt", () => {
    expect(evaluate().evaluatedAt).toBe(EVALUATED_AT.toISOString());
  });
});

describe("kill switches", () => {
  it("reports GLOBAL_KILL_SWITCH_ACTIVE first when the global switch is on", () => {
    const result = evaluate({ policy: policy({ killSwitchActive: true, globalKillSwitchActive: true }) });
    expect(result.decision).toBe("SKIP");
    expect(result.reasonCode).toBe("GLOBAL_KILL_SWITCH_ACTIVE");
  });

  it("reports PROFILE_KILL_SWITCH_ACTIVE when only the profile switch is on", () => {
    const result = evaluate({ policy: policy({ killSwitchActive: true, profileKillSwitchActive: true }) });
    expect(result.decision).toBe("SKIP");
    expect(result.reasonCode).toBe("PROFILE_KILL_SWITCH_ACTIVE");
  });

  it("still SKIPs even when every other input is perfect", () => {
    const result = evaluate({ policy: policy({ killSwitchActive: true, globalKillSwitchActive: true }) });
    expect(result.decision).not.toBe("PASS");
  });
});

describe("profile checks", () => {
  it("fails closed with UNAVAILABLE when no policy exists", () => {
    const result = evaluate({ policy: policy({ policyPresent: false }) });
    expect(result.reasonCode).toBe("PROFILE_POLICY_UNAVAILABLE");
    expect(result.decision).toBe("UNAVAILABLE");
  });

  it("skips a disabled profile", () => {
    const result = evaluate({ policy: policy({ profileEnabled: false }) });
    expect(result.reasonCode).toBe("PROFILE_DISABLED");
    expect(result.decision).toBe("SKIP");
  });

  it("uses PROFILE_DISABLED only when the profile is actually disabled", () => {
    for (const mismatch of [
      policy({ environmentMatchesConnector: false }),
      policy({ expectedMarginType: "CROSS" }),
      policy({ expectedPositionMode: "ONE_WAY" }),
    ]) {
      expect(reasonCodes(evaluate({ policy: mismatch }))).not.toContain("PROFILE_DISABLED");
    }
  });

  it("reports PROFILE_ENVIRONMENT_MISMATCH when the connector environment differs", () => {
    const result = evaluate({ policy: policy({ environmentMatchesConnector: false }) });
    expect(result.reasonCode).toBe("PROFILE_ENVIRONMENT_MISMATCH");
    expect(result.decision).toBe("SKIP");
  });

  it("requires HEDGE position mode on the profile", () => {
    const result = evaluate({ policy: policy({ expectedPositionMode: "ONE_WAY" }) });
    expect(reasonCodes(result)).toContain("EXPECTED_HEDGE_MODE");
  });

  it("reports EXPECTED_ISOLATED_MARGIN_TYPE when the profile is not ISOLATED", () => {
    const result = evaluate({ policy: policy({ expectedMarginType: "CROSS" }) });
    expect(result.reasonCode).toBe("EXPECTED_ISOLATED_MARGIN_TYPE");
    expect(result.decision).toBe("SKIP");
  });
});

describe("signal freshness", () => {
  it("computes the age from the original signal time", () => {
    expect(evaluate().signalAgeSeconds).toBe(60);
  });

  it("terminally skips a legacy row with no signal time", () => {
    // Frozen data that can never appear later, so it is TERMINAL rather than
    // a retryable unavailability.
    const result = evaluate({ proposed: proposed({ signalTriggeredAt: null }) });
    expect(result.reasonCode).toBe("SIGNAL_TIME_UNAVAILABLE");
    expect(result.decision).toBe("SKIP");
    expect(result.signalAgeSeconds).toBeNull();
  });

  it("accepts an age exactly at the limit", () => {
    const at = new Date(EVALUATED_AT.getTime() - 300_000);
    const result = evaluate({ proposed: proposed({ signalTriggeredAt: at }) });
    expect(result.signalAgeSeconds).toBe(300);
    expect(result.decision).toBe("PASS");
  });

  it("rejects an age one second past the limit", () => {
    const at = new Date(EVALUATED_AT.getTime() - 301_000);
    const result = evaluate({ proposed: proposed({ signalTriggeredAt: at }) });
    expect(result.signalAgeSeconds).toBe(301);
    expect(result.reasonCode).toBe("ALERT_STALE");
    expect(result.decision).toBe("SKIP");
  });

  it("tolerates a signal a few seconds in the future (clock skew)", () => {
    const at = new Date(EVALUATED_AT.getTime() + 4_000);
    const result = evaluate({ proposed: proposed({ signalTriggeredAt: at }) });
    expect(result.signalAgeSeconds).toBe(-4);
    expect(result.decision).toBe("PASS");
  });

  it("rejects a signal far in the future as an untrustworthy timestamp", () => {
    const at = new Date(EVALUATED_AT.getTime() + 60_000);
    const result = evaluate({ proposed: proposed({ signalTriggeredAt: at }) });
    expect(result.reasonCode).toBe("SIGNAL_TIME_UNAVAILABLE");
  });

  it("floors sub-second ages rather than rounding up", () => {
    const at = new Date(EVALUATED_AT.getTime() - 1_900);
    expect(evaluate({ proposed: proposed({ signalTriggeredAt: at }) }).signalAgeSeconds).toBe(1);
  });
});

describe("duplicate protection", () => {
  it("refuses a second admission for an already-admitted execution", () => {
    const result = evaluate({ local: local({ alreadyAdmitted: true }) });
    expect(reasonCodes(result)).toContain("DUPLICATE_EXECUTION");
  });

  it("refuses an execution that is no longer PLAN_READY", () => {
    const result = evaluate({ proposed: proposed({ currentStatus: "PREFLIGHT" }) });
    expect(reasonCodes(result)).toContain("DUPLICATE_EXECUTION");
  });
});

describe("symbol checks", () => {
  it("skips a symbol outside a configured allowlist", () => {
    const result = evaluate({ policy: policy({ allowedSymbols: ["OTHERUSDT"] }) });
    expect(result.reasonCode).toBe("SYMBOL_NOT_ALLOWED");
  });

  it("accepts a symbol inside the allowlist regardless of case", () => {
    const result = evaluate({ policy: policy({ allowedSymbols: ["SYNTHUSDT"] }) });
    expect(result.decision).toBe("PASS");
  });

  it("reports UNSUPPORTED_SYMBOL for an unlisted symbol", () => {
    const result = evaluate({ symbolState: symbolState({ exists: false }) });
    expect(reasonCodes(result)).toContain("UNSUPPORTED_SYMBOL");
  });

  it("reports SYMBOL_NOT_TRADING for a halted symbol", () => {
    const result = evaluate({ symbolState: symbolState({ status: "BREAK" }) });
    expect(reasonCodes(result)).toContain("SYMBOL_NOT_TRADING");
  });

  it("reports UNSUPPORTED_CONTRACT for a non-perpetual contract", () => {
    const result = evaluate({ symbolState: symbolState({ contractType: "CURRENT_QUARTER" }) });
    expect(reasonCodes(result)).toContain("UNSUPPORTED_CONTRACT");
  });

  it("returns UNAVAILABLE when symbol state could not be read", () => {
    const result = evaluate({ symbolState: symbolState({ available: false }) });
    expect(result.reasonCode).toBe("BINANCE_SYMBOL_STATE_UNAVAILABLE");
    expect(result.decision).toBe("UNAVAILABLE");
  });

  it("treats an incomplete live filters read as retryable symbol state", () => {
    const result = evaluate({ symbolState: symbolState({ hasFiltersSnapshot: false }) });
    expect(reasonCodes(result)).toContain("BINANCE_SYMBOL_STATE_UNAVAILABLE");
    expect(result.decision).toBe("UNAVAILABLE");
  });

  it("treats an incomplete live bracket read as retryable symbol state", () => {
    const result = evaluate({ symbolState: symbolState({ hasBracketSnapshot: false }) });
    expect(reasonCodes(result)).toContain("BINANCE_SYMBOL_STATE_UNAVAILABLE");
    expect(result.decision).toBe("UNAVAILABLE");
  });

  it("terminally skips when the FROZEN margin plan snapshot is missing", () => {
    const result = evaluate({ proposed: proposed({ hasMarginPlanSnapshot: false }) });
    expect(result.reasonCode).toBe("MARGIN_PLAN_SNAPSHOT_MISSING");
    expect(result.decision).toBe("SKIP");
  });
});

describe("frozen margin plan", () => {
  it("reports MARGIN_PLAN_NOT_READY for a non-READY plan", () => {
    const result = evaluate({ proposed: proposed({ marginPlanStatus: "REJECTED" }) });
    expect(reasonCodes(result)).toContain("MARGIN_PLAN_NOT_READY");
  });

  it("reports MARGIN_PLAN_NOT_READY when no leverage was selected", () => {
    const result = evaluate({ proposed: proposed({ selectedLeverage: null }) });
    expect(reasonCodes(result)).toContain("MARGIN_PLAN_NOT_READY");
  });
});

describe("liquidation revalidation", () => {
  it("fails closed when the liquidation estimate is missing", () => {
    const result = evaluate({ proposed: proposed({ estimatedLiquidationPrice: null }) });
    expect(reasonCodes(result)).toContain("UNSAFE_LIQUIDATION_BUFFER");
  });

  it("fails closed when the required boundary is missing", () => {
    const result = evaluate({ proposed: proposed({ requiredLiquidationBoundary: null }) });
    expect(reasonCodes(result)).toContain("UNSAFE_LIQUIDATION_BUFFER");
  });

  it("rejects a LONG whose liquidation sits above the boundary", () => {
    const result = evaluate({
      proposed: proposed({ estimatedLiquidationPrice: "95.0000000001", requiredLiquidationBoundary: "95" }),
    });
    expect(reasonCodes(result)).toContain("UNSAFE_LIQUIDATION_BUFFER");
  });

  it("accepts a LONG exactly at the boundary", () => {
    const result = evaluate({
      proposed: proposed({ estimatedLiquidationPrice: "95", requiredLiquidationBoundary: "95" }),
    });
    expect(result.decision).toBe("PASS");
  });

  it("rejects a SHORT whose liquidation sits below the boundary", () => {
    const result = evaluate({
      proposed: proposed({
        positionSide: "SHORT",
        estimatedLiquidationPrice: "104.9999999999",
        requiredLiquidationBoundary: "105",
      }),
    });
    expect(reasonCodes(result)).toContain("UNSAFE_LIQUIDATION_BUFFER");
  });

  it("accepts a SHORT above the boundary", () => {
    const result = evaluate({
      proposed: proposed({
        positionSide: "SHORT",
        estimatedLiquidationPrice: "110",
        requiredLiquidationBoundary: "105",
      }),
    });
    expect(result.decision).toBe("PASS");
  });

  it("compares with arbitrary precision, not float arithmetic", () => {
    // 0.1 + 0.2 === 0.30000000000000004 as a float; as decimals this is a
    // strict, exact comparison and must fail.
    const result = evaluate({
      proposed: proposed({
        estimatedLiquidationPrice: "0.30000000000000004",
        requiredLiquidationBoundary: "0.3",
      }),
    });
    expect(reasonCodes(result)).toContain("UNSAFE_LIQUIDATION_BUFFER");
  });
});

describe("binance account state", () => {
  it("returns UNAVAILABLE when the account snapshot could not be read", () => {
    const result = evaluate({ binance: binance({ available: false }) });
    expect(reasonCodes(result)).toContain("BINANCE_ACCOUNT_STATE_UNAVAILABLE");
    expect(result.decision).toBe("UNAVAILABLE");
  });

  it("requires HEDGE mode on the account", () => {
    const result = evaluate({ binance: binance({ positionMode: "ONE_WAY" }) });
    expect(reasonCodes(result)).toContain("EXPECTED_HEDGE_MODE");
  });

  it("requires single-asset margin mode on the account", () => {
    const result = evaluate({ binance: binance({ assetMode: "MULTI_ASSET" }) });
    expect(reasonCodes(result)).toContain("EXPECTED_SINGLE_ASSET_MODE");
  });

  it("blocks a symbol that already has a Binance position, whatever the side", () => {
    const result = evaluate({ binance: binance({ symbolsWithPosition: [SYMBOL] }) });
    expect(reasonCodes(result)).toContain("SYMBOL_HAS_OPEN_POSITION_OR_ORDER");
  });

  it("blocks a symbol that already has a Binance open order", () => {
    const result = evaluate({ binance: binance({ symbolsWithOpenOrder: [SYMBOL] }) });
    expect(reasonCodes(result)).toContain("SYMBOL_HAS_OPEN_POSITION_OR_ORDER");
  });

  it("does not block a different symbol", () => {
    const result = evaluate({ binance: binance({ symbolsWithPosition: ["OTHERUSDT"] }) });
    expect(result.decision).toBe("PASS");
  });

  it("exposes the Binance snapshot timestamp for freshness auditing", () => {
    expect(evaluate().binanceSnapshotAt).toBe(EVALUATED_AT.toISOString());
  });
});

describe("capacity limits", () => {
  it("skips when the open-position limit is already reached", () => {
    const result = evaluate({ local: local({ openPositionCount: 1, totalActiveCount: 1 }) });
    expect(reasonCodes(result)).toContain("OPEN_POSITION_LIMIT_REACHED");
  });

  it("skips when the pending-entry limit is already reached", () => {
    const result = evaluate({ local: local({ pendingEntryCount: 1, totalActiveCount: 1 }) });
    expect(reasonCodes(result)).toContain("PENDING_ENTRY_LIMIT_REACHED");
  });

  it("skips when the total-active limit is already reached", () => {
    const result = evaluate({
      policy: policy({ maxOpenPositions: 5, maxPendingEntries: 5, maxTotalActiveTrades: 2 }),
      local: local({ totalActiveCount: 2, openPositionCount: 1, pendingEntryCount: 1 }),
    });
    expect(reasonCodes(result)).toContain("TOTAL_ACTIVE_LIMIT_REACHED");
  });

  it("allows the last free slot", () => {
    const result = evaluate({
      policy: policy({ maxOpenPositions: 2, maxPendingEntries: 2, maxTotalActiveTrades: 2 }),
      local: local({ totalActiveCount: 1, openPositionCount: 1, activeSymbolSideKeys: ["OTHERUSDT:LONG"] }),
    });
    expect(result.decision).toBe("PASS");
  });

  it("blocks a second active execution on the same symbol AND side", () => {
    const result = evaluate({ local: local({ activeSymbolSideKeys: [`${SYMBOL}:LONG`] }) });
    expect(reasonCodes(result)).toContain("SYMBOL_SIDE_ALREADY_ACTIVE");
  });

  it("allows the opposite side of the same symbol when slots remain", () => {
    const result = evaluate({
      policy: policy({ maxOpenPositions: 2, maxPendingEntries: 2, maxTotalActiveTrades: 2 }),
      local: local({
        totalActiveCount: 1,
        openPositionCount: 1,
        activeSymbolSideKeys: [`${SYMBOL}:SHORT`],
      }),
    });
    expect(result.decision).toBe("PASS");
  });
});

describe("risk and margin ceilings", () => {
  it("accepts a projected risk exactly at the ceiling", () => {
    const result = evaluate({
      proposed: proposed({ riskBudgetUsd: "1.50" }),
      local: local({ reservedRiskUsd: "0" }),
    });
    expect(result.decision).toBe("PASS");
  });

  it("rejects a projected risk one cent past the ceiling", () => {
    const result = evaluate({
      proposed: proposed({ riskBudgetUsd: "1.51" }),
    });
    expect(reasonCodes(result)).toContain("TOTAL_RISK_LIMIT_REACHED");
  });

  it("rejects when existing reservations push the projected risk over", () => {
    const result = evaluate({ local: local({ reservedRiskUsd: "0.51" }) });
    expect(reasonCodes(result)).toContain("TOTAL_RISK_LIMIT_REACHED");
  });

  it("accepts a projected margin exactly at the ceiling", () => {
    const result = evaluate({ proposed: proposed({ maximumIsolatedMargin: "5.00" }) });
    expect(result.decision).toBe("PASS");
  });

  it("rejects a projected margin past the ceiling", () => {
    const result = evaluate({ proposed: proposed({ maximumIsolatedMargin: "5.000000000001" }) });
    expect(reasonCodes(result)).toContain("TOTAL_MARGIN_LIMIT_REACHED");
  });

  it("sums decimals exactly (no float drift)", () => {
    const result = evaluate({
      policy: policy({ maxTotalPlannedRiskUsd: "0.3" }),
      proposed: proposed({ riskBudgetUsd: "0.2" }),
      local: local({ reservedRiskUsd: "0.1" }),
    });
    expect(result.capacityProjected.reservedRiskUsd).toBe("0.3");
    expect(reasonCodes(result)).not.toContain("TOTAL_RISK_LIMIT_REACHED");
  });
});

describe("available balance", () => {
  it("rejects when the effective available balance is below the required margin", () => {
    const result = evaluate({ binance: binance({ usdtAvailableBalance: "2.99" }) });
    expect(reasonCodes(result)).toContain("INSUFFICIENT_AVAILABLE_BALANCE");
  });

  it("accepts when the effective available balance exactly equals the required margin", () => {
    const result = evaluate({ binance: binance({ usdtAvailableBalance: "3.00" }) });
    expect(result.decision).toBe("PASS");
  });

  it("subtracts local reservations Binance does not yet reflect", () => {
    const result = evaluate({
      binance: binance({ usdtAvailableBalance: "4.00" }),
      local: local({ pendingUnreflectedMarginUsd: "2.00" }),
    });
    expect(reasonCodes(result)).toContain("INSUFFICIENT_AVAILABLE_BALANCE");
  });

  it("checks the MAXIMUM isolated margin, not the estimated initial margin", () => {
    // Available 2.50 covers the 2.00 estimate but not the 3.00 maximum.
    const result = evaluate({ binance: binance({ usdtAvailableBalance: "2.50" }) });
    expect(reasonCodes(result)).toContain("INSUFFICIENT_AVAILABLE_BALANCE");
  });

  it("returns UNAVAILABLE when the balance itself is missing", () => {
    const result = evaluate({ binance: binance({ usdtAvailableBalance: null }) });
    expect(reasonCodes(result)).toContain("BINANCE_ACCOUNT_STATE_UNAVAILABLE");
    expect(result.decision).toBe("UNAVAILABLE");
  });
});

describe("reason retryability classification", () => {
  it("classifies exactly the transient reasons as retryable", () => {
    const retryable = SAFETY_REASON_CODES.filter(
      (code) => classifySafetyReasonRetryability(code) === "RETRYABLE"
    );
    expect([...retryable].sort()).toEqual([
      "BINANCE_ACCOUNT_STATE_UNAVAILABLE",
      "BINANCE_SYMBOL_STATE_UNAVAILABLE",
      "CAPACITY_CONFLICT_RETRY",
      "PROFILE_POLICY_UNAVAILABLE",
    ]);
  });

  it("classifies permanently-frozen data failures as terminal", () => {
    for (const code of ["SIGNAL_TIME_UNAVAILABLE", "MARGIN_PLAN_SNAPSHOT_MISSING"] as const) {
      expect(classifySafetyReasonRetryability(code)).toBe("TERMINAL");
    }
  });

  it("classifies every ordinary policy refusal as terminal", () => {
    for (const code of [
      "GLOBAL_KILL_SWITCH_ACTIVE",
      "ALERT_STALE",
      "SYMBOL_NOT_ALLOWED",
      "OPEN_POSITION_LIMIT_REACHED",
      "TOTAL_RISK_LIMIT_REACHED",
      "UNSAFE_LIQUIDATION_BUFFER",
    ] as const) {
      expect(classifySafetyReasonRetryability(code)).toBe("TERMINAL");
    }
  });

  it("returns UNAVAILABLE only when EVERY failed check is retryable", () => {
    const result = evaluate({ binance: binance({ available: false }) });
    expect(result.failedChecks.every((c) => classifySafetyReasonRetryability(c.reasonCode) === "RETRYABLE")).toBe(true);
    expect(result.decision).toBe("UNAVAILABLE");
  });

  it("makes the whole decision terminal when a permanent failure hides behind a transient one", () => {
    // Connector down (retryable) AND the frozen plan snapshot missing
    // (permanent). Retrying would re-derive the same permanent refusal, so the
    // decision must be terminal immediately.
    const result = evaluate({
      binance: binance({ available: false }),
      proposed: proposed({ hasMarginPlanSnapshot: false }),
    });
    expect(reasonCodes(result)).toContain("BINANCE_ACCOUNT_STATE_UNAVAILABLE");
    expect(reasonCodes(result)).toContain("MARGIN_PLAN_SNAPSHOT_MISSING");
    expect(result.decision).toBe("SKIP");
    // The reported reason agrees with the decision.
    expect(result.reasonCode).toBe("MARGIN_PLAN_SNAPSHOT_MISSING");
  });
});

describe("reason code catalogue", () => {
  it("exposes exactly the 29 stable reason codes", () => {
    expect(SAFETY_REASON_CODES).toHaveLength(29);
    expect(new Set(SAFETY_REASON_CODES).size).toBe(29);
  });

  it("keeps a distinct code for each configuration mismatch", () => {
    for (const code of [
      "PROFILE_DISABLED",
      "PROFILE_ENVIRONMENT_MISMATCH",
      "EXPECTED_HEDGE_MODE",
      "EXPECTED_SINGLE_ASSET_MODE",
      "EXPECTED_ISOLATED_MARGIN_TYPE",
    ] as const) {
      expect(SAFETY_REASON_CODES).toContain(code);
    }
  });

  it("emits every code that the pure engine is responsible for", () => {
    const emitted = new Set<SafetyReasonCode>();
    const collect = (result: ReturnType<typeof evaluate>) =>
      reasonCodes(result).forEach((code) => emitted.add(code));

    collect(evaluate({ policy: policy({ killSwitchActive: true, globalKillSwitchActive: true }) }));
    collect(evaluate({ policy: policy({ killSwitchActive: true, profileKillSwitchActive: true }) }));
    collect(evaluate({ policy: policy({ profileEnabled: false }) }));
    collect(evaluate({ policy: policy({ environmentMatchesConnector: false }) }));
    collect(evaluate({ policy: policy({ expectedMarginType: "CROSS" }) }));
    collect(evaluate({ policy: policy({ policyPresent: false }) }));
    collect(evaluate({ proposed: proposed({ signalTriggeredAt: null }) }));
    collect(evaluate({ proposed: proposed({ signalTriggeredAt: new Date(EVALUATED_AT.getTime() - 400_000) }) }));
    collect(evaluate({ local: local({ alreadyAdmitted: true }) }));
    collect(evaluate({ policy: policy({ allowedSymbols: ["OTHERUSDT"] }) }));
    collect(evaluate({ symbolState: symbolState({ exists: false }) }));
    collect(evaluate({ symbolState: symbolState({ status: "BREAK" }) }));
    collect(evaluate({ symbolState: symbolState({ contractType: "CURRENT_QUARTER" }) }));
    collect(evaluate({ policy: policy({ expectedPositionMode: "ONE_WAY" }) }));
    collect(evaluate({ binance: binance({ assetMode: "MULTI_ASSET" }) }));
    collect(evaluate({ local: local({ activeSymbolSideKeys: [`${SYMBOL}:LONG`] }) }));
    collect(evaluate({ binance: binance({ symbolsWithPosition: [SYMBOL] }) }));
    collect(evaluate({ local: local({ openPositionCount: 1 }) }));
    collect(evaluate({ local: local({ pendingEntryCount: 1 }) }));
    collect(
      evaluate({
        policy: policy({ maxOpenPositions: 5, maxPendingEntries: 5, maxTotalActiveTrades: 1 }),
        local: local({ totalActiveCount: 1 }),
      })
    );
    collect(evaluate({ proposed: proposed({ riskBudgetUsd: "9.00" }) }));
    collect(evaluate({ proposed: proposed({ maximumIsolatedMargin: "9.00" }) }));
    collect(evaluate({ binance: binance({ usdtAvailableBalance: "0.01" }) }));
    collect(evaluate({ proposed: proposed({ estimatedLiquidationPrice: null }) }));
    collect(evaluate({ proposed: proposed({ marginPlanStatus: "REJECTED" }) }));
    collect(evaluate({ proposed: proposed({ hasMarginPlanSnapshot: false }) }));
    collect(evaluate({ binance: binance({ available: false }) }));
    collect(evaluate({ symbolState: symbolState({ available: false }) }));

    // CAPACITY_CONFLICT_RETRY is produced by the transactional service, not by
    // the pure engine, so it is exercised in the integration suite instead.
    const pureCodes = SAFETY_REASON_CODES.filter((code) => code !== "CAPACITY_CONFLICT_RETRY");
    expect([...emitted].sort()).toEqual([...pureCodes].sort());
  });
});
