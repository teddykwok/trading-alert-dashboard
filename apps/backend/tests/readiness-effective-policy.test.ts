import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  effectiveCanaryLimits,
  evaluateCanaryPreflight,
  type CanaryPolicyLimits,
  type CanaryPreflightInput,
} from "../src/modules/execution/canary-readiness";
import {
  evaluateSafetyAdmission,
  mergeCapacityLimits,
  policyReachabilityViolations,
  resolveEffectivePolicy,
  type BinanceCapacitySnapshot,
  type EffectiveSafetyPolicy,
  type LocalCapacitySnapshot,
  type ProposedExecution,
  type SymbolStateSnapshot,
} from "../src/modules/execution/safety-engine";

/**
 * Readiness and admission must never disagree about the limits.
 *
 * The model this file pins down:
 *
 *   ENV        an absolute hard ceiling the dashboard cannot exceed
 *   ROW        the operator-selected operational policy (Trading Policy Editor)
 *   EFFECTIVE  min(row, env) — the only thing either side is allowed to judge
 *
 * Readiness used to require the effective policy to EQUAL one historical
 * envelope (3 / 5 / 5 / 5 / 7.50 / 40), which refused every scaled policy the
 * editor exists to produce. It now validates the effective policy on its
 * merits. The risk that introduces is split-brain: readiness approving one
 * number while admission enforces another. These tests exist to close it.
 *
 * Everything here is synthetic. No profile, no database, no Binance call.
 */

const BACKEND = process.cwd();
const EVALUATED_AT = new Date("2026-01-01T12:00:00.000Z");

/** The live hard ceiling: 20 / 20 / 20 / 20 / 1 / 30 / 160. */
const ENV_CEILING: CanaryPolicyLimits = {
  maxOpenPositions: 20,
  maxPendingEntries: 20,
  maxTotalActiveTrades: 20,
  maxActivePerSymbolSide: 1,
  softOpenPositionTarget: 20,
  maxTotalPlannedRiskUsd: "30.00",
  maxTotalIsolatedMarginUsd: "160.00",
};

/** A stored policy that tries to exceed every ceiling it can. */
const OVER_CEILING: CanaryPolicyLimits = {
  maxOpenPositions: 50,
  maxPendingEntries: 50,
  maxTotalActiveTrades: 50,
  maxActivePerSymbolSide: 9,
  softOpenPositionTarget: 50,
  maxTotalPlannedRiskUsd: "500.00",
  maxTotalIsolatedMarginUsd: "5000.00",
};

/** The operator's intended scaled policy: 5 / 8 / 8 / 8 / 1 / 15 / 80. */
const SCALED_POLICY: CanaryPolicyLimits = {
  maxOpenPositions: 8,
  maxPendingEntries: 8,
  maxTotalActiveTrades: 8,
  maxActivePerSymbolSide: 1,
  softOpenPositionTarget: 5,
  maxTotalPlannedRiskUsd: "15.00",
  maxTotalIsolatedMarginUsd: "80.00",
};

/** The admission side's view of the same two inputs. */
function admissionEffective(env: CanaryPolicyLimits, row: CanaryPolicyLimits): EffectiveSafetyPolicy {
  return resolveEffectivePolicy(
    {
      killSwitchActive: false,
      maxAlertAgeSeconds: 300,
      signalFutureToleranceSeconds: 5,
      ...env,
    },
    {
      present: true,
      enabled: true,
      environmentMatchesConnector: true,
      killSwitchActive: false,
      expectedPositionMode: "HEDGE",
      expectedMarginType: "ISOLATED",
      maxAlertAgeSeconds: 300,
      allowedSymbols: [],
      allowedSourceTimeframes: ["1D", "1W", "1M", "3M", "6M", "12M"],
      ...row,
    }
  );
}

/** The readiness side's view of the same two inputs. */
const readinessEffective = effectiveCanaryLimits;

// ---------------------------------------------------------------------------
// TEST E — the editor cannot make readiness approve what admission won't use
// ---------------------------------------------------------------------------

describe("E. readiness and admission observe the SAME effective values", () => {
  it("agree limit-for-limit when the stored policy exceeds every ceiling", () => {
    const readiness = readinessEffective(ENV_CEILING, OVER_CEILING);
    const admission = admissionEffective(ENV_CEILING, OVER_CEILING);

    for (const name of Object.keys(ENV_CEILING) as (keyof CanaryPolicyLimits)[]) {
      expect(String(readiness[name]), name).toBe(String(admission[name]));
      // And both are the ENV value, not the wider stored one.
      expect(String(readiness[name]), name).toBe(String(ENV_CEILING[name]));
    }
  });

  it("agree limit-for-limit for the scaled policy inside the ceiling", () => {
    const readiness = readinessEffective(ENV_CEILING, SCALED_POLICY);
    const admission = admissionEffective(ENV_CEILING, SCALED_POLICY);

    for (const name of Object.keys(ENV_CEILING) as (keyof CanaryPolicyLimits)[]) {
      expect(String(readiness[name]), name).toBe(String(admission[name]));
      // Here the ROW is the stricter side, so the row value governs.
      expect(String(readiness[name]), name).toBe(String(SCALED_POLICY[name]));
    }
  });

  it("share ONE implementation of the merge rather than two that agree today", () => {
    // Agreement by construction, not by coincidence. Both call the same
    // function, and neither restates the arithmetic.
    const readinessSource = readFileSync(
      path.join(BACKEND, "src/modules/execution/canary-readiness.ts"),
      "utf8"
    );
    expect(readinessSource).toContain("mergeCapacityLimits");
    expect(readinessSource).not.toMatch(/Math\.min\(/);

    const engineSource = readFileSync(path.join(BACKEND, "src/modules/execution/safety-engine.ts"), "utf8");
    // resolveEffectivePolicy spreads the shared merge instead of re-deriving.
    expect(engineSource).toContain("...mergeCapacityLimits(global, profile)");
  });

  it("readiness passes the capped policy AND admission enforces the cap", () => {
    // The end-to-end shape of the risk: an operator stores 50 open positions
    // under an env ceiling of 20. Readiness must not report a policy blocker
    // (the effective 20 is perfectly valid), and admission must refuse the
    // 21st trade rather than the 51st.
    const readiness = evaluateCanaryPreflight(preflight(ENV_CEILING, OVER_CEILING));
    expect(readiness.findings.filter((finding) => finding.code === "CANARY_BLOCKED_POLICY")).toHaveLength(0);

    const capped = admissionEffective(ENV_CEILING, OVER_CEILING);
    expect(capped.maxTotalActiveTrades).toBe(20);

    const atCap = evaluateSafetyAdmission({
      evaluatedAt: EVALUATED_AT,
      proposed: proposed(),
      policy: capped,
      local: local({ totalActiveCount: 20, openPositionCount: 20 }),
      binance: binance(),
      symbolState: symbolState(),
    });
    expect(atCap.decision).not.toBe("PASS");
    expect(atCap.failedChecks.map((check) => check.reasonCode)).toContain("TOTAL_ACTIVE_LIMIT_REACHED");

    // And one below the cap still passes, so the ceiling is a ceiling and not
    // a blanket refusal.
    const belowCap = evaluateSafetyAdmission({
      evaluatedAt: EVALUATED_AT,
      proposed: proposed(),
      policy: capped,
      local: local({ totalActiveCount: 19, openPositionCount: 19 }),
      binance: binance(),
      symbolState: symbolState(),
    });
    expect(belowCap.decision).toBe("PASS");
  });

  it("a stored money ceiling above the env cannot widen the reserved risk", () => {
    const capped = admissionEffective(ENV_CEILING, OVER_CEILING);
    expect(capped.maxTotalPlannedRiskUsd).toBe("30.00");

    const overRisk = evaluateSafetyAdmission({
      evaluatedAt: EVALUATED_AT,
      proposed: proposed(),
      policy: capped,
      local: local({ reservedRiskUsd: "29.50" }),
      binance: binance(),
      symbolState: symbolState(),
    });
    // 29.50 reserved + 1.00 proposed exceeds the env's 30.00, despite the row
    // claiming 500.00.
    expect(overRisk.failedChecks.map((check) => check.reasonCode)).toContain("TOTAL_RISK_LIMIT_REACHED");
  });
});

// ---------------------------------------------------------------------------
// TEST F — the same-symbol-side cap
// ---------------------------------------------------------------------------

describe("F. the same-symbol-side cap remains enforced", () => {
  it("stays at the env ceiling of 1 however wide the row is", () => {
    expect(readinessEffective(ENV_CEILING, OVER_CEILING).maxActivePerSymbolSide).toBe(1);
    expect(admissionEffective(ENV_CEILING, OVER_CEILING).maxActivePerSymbolSide).toBe(1);
  });

  it("refuses a second execution on the same symbol and side", () => {
    const capped = admissionEffective(ENV_CEILING, OVER_CEILING);
    const result = evaluateSafetyAdmission({
      evaluatedAt: EVALUATED_AT,
      proposed: proposed(),
      policy: capped,
      local: local({ activeSymbolSideKeys: ["SYNTHUSDT:LONG"], totalActiveCount: 1, openPositionCount: 1 }),
      binance: binance(),
      symbolState: symbolState(),
    });
    expect(result.decision).not.toBe("PASS");
    expect(result.failedChecks.map((check) => check.reasonCode)).toContain("SYMBOL_SIDE_ALREADY_ACTIVE");
  });

  it("still admits the OPPOSITE side of the same symbol", () => {
    // The cap is per symbol AND side, and this fix does not change that.
    const capped = admissionEffective(ENV_CEILING, OVER_CEILING);
    const result = evaluateSafetyAdmission({
      evaluatedAt: EVALUATED_AT,
      proposed: proposed(),
      policy: capped,
      local: local({ activeSymbolSideKeys: ["SYNTHUSDT:SHORT"], totalActiveCount: 1, openPositionCount: 1 }),
      binance: binance(),
      symbolState: symbolState(),
    });
    expect(result.decision).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// The shared reachability rules
// ---------------------------------------------------------------------------

describe("the reachability rules readiness and the policy writer share", () => {
  const reachable = {
    maxOpenPositions: 8,
    maxPendingEntries: 8,
    maxTotalActiveTrades: 8,
    softOpenPositionTarget: 5,
  };

  it("accepts the scaled operational policy", () => {
    expect(policyReachabilityViolations(reachable)).toEqual([]);
  });

  it("rejects a total below the open or pending cap", () => {
    expect(policyReachabilityViolations({ ...reachable, maxTotalActiveTrades: 5 })).toContain(
      "maxTotalActiveTrades must be >= maxOpenPositions."
    );
    expect(
      policyReachabilityViolations({ ...reachable, maxOpenPositions: 4, maxTotalActiveTrades: 5 })
    ).toContain("maxTotalActiveTrades must be >= maxPendingEntries.");
  });

  it("rejects a soft target above the hard cap", () => {
    expect(policyReachabilityViolations({ ...reachable, softOpenPositionTarget: 9 })).toContain(
      "softOpenPositionTarget must be <= maxOpenPositions."
    );
  });

  it("reports every violation, not just the first", () => {
    expect(
      policyReachabilityViolations({
        maxOpenPositions: 10,
        maxPendingEntries: 10,
        maxTotalActiveTrades: 1,
        softOpenPositionTarget: 20,
      })
    ).toHaveLength(3);
  });

  it("is the same function the merge feeds, so it judges EFFECTIVE limits", () => {
    // An env that clamps maxOpenPositions to 3 leaves a soft target of 5
    // untouched, because the soft ceiling is 20. The ROW is valid; the MERGE
    // is not — and only the merged view can see it.
    const merged = mergeCapacityLimits(
      { ...ENV_CEILING, maxOpenPositions: 3, maxAlertAgeSeconds: 300 },
      { ...SCALED_POLICY, maxAlertAgeSeconds: 300 }
    );
    expect(merged.maxOpenPositions).toBe(3);
    expect(merged.softOpenPositionTarget).toBe(5);
    expect(policyReachabilityViolations(merged)).toContain(
      "softOpenPositionTarget must be <= maxOpenPositions."
    );
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function proposed(overrides: Partial<ProposedExecution> = {}): ProposedExecution {
  return {
    executionId: "exec-readiness-policy-1",
    profileId: "profile-readiness-policy-1",
    symbol: "SYNTHUSDT",
    positionSide: "LONG",
    signalTriggeredAt: new Date(EVALUATED_AT.getTime() - 60_000),
    sourceTimeframe: "1W",
    currentStatus: "PLAN_READY",
    riskBudgetUsd: "1.00",
    actualPlannedLoss: "0.98",
    estimatedInitialMargin: "2.00",
    maximumIsolatedMargin: "3.00",
    estimatedLiquidationPrice: "90",
    requiredLiquidationBoundary: "95",
    marginPlanStatus: "READY",
    selectedLeverage: 5,
    hasMarginPlanSnapshot: true,
    plannedQuantity: "1",
    // Null by default so the standard-TP notional rule cannot fire in tests
    // that are about something else; the tests that exercise it opt in.
    takeProfit: null,
    intendedTakeProfitModality: null,
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
    usdtAvailableBalance: "1000.00",
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
    quoteAsset: "USDT",
    marginAsset: "USDT",
    minNotional: "5",
    hasFiltersSnapshot: true,
    hasBracketSnapshot: true,
    ...overrides,
  };
}

/** A readiness input whose ONLY interesting dimension is the policy. */
function preflight(global: CanaryPolicyLimits, profile: CanaryPolicyLimits): CanaryPreflightInput {
  return {
    infrastructure: {
      databaseReady: true,
      redisReady: true,
      executionWorkerReady: true,
      notificationSchedulerReady: true,
      executionOrchestrationWired: true,
    },
    binance: {
      connected: true,
      signedRequestWorks: true,
      consecutiveSignedSuccesses: 3,
      requiredConsecutiveSuccesses: 3,
      authenticationFailed: false,
      ipRestricted: false,
      positionMode: "HEDGE",
      assetMode: "SINGLE_ASSET",
      nonZeroPositionCount: 0,
      openOrderCount: 0,
    },
    local: {
      activeExecutionCount: 0,
      pendingEntryCount: 0,
      openPositionCount: 0,
      recoveryRequiredCount: 0,
    },
    policy: { global, profile },
    authorization: {
      mode: "EXACT_SIGNAL",
      available: true,
      exactPrepared: true,
      naturalState: null,
      naturalAllowedDirections: [],
      naturalMaxClaims: null,
      naturalClaimedCount: null,
    },
    gates: {
      globalKillSwitch: true,
      profileKillSwitchEngaged: true,
      liveEntryEnabled: false,
      protectionReady: false,
      accountSetupMutationsEnabled: false,
      testOrderEnabled: false,
      autoAddMarginEnabled: false,
      emergencyCloseMode: "DISABLED",
    },
  };
}
