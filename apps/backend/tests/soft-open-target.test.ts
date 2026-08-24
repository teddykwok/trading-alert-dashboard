import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  classifySafetyReasonRetryability,
  evaluateSafetyAdmission,
  mergeCapacityLimits,
  type BinanceCapacitySnapshot,
  type EffectiveSafetyPolicy,
  type LocalCapacitySnapshot,
  type ProposedExecution,
  type SafetyCapacityLimits,
  type SafetyEvaluationInput,
  type SafetyReasonCode,
  type SymbolStateSnapshot,
} from "../src/modules/execution/safety-engine";
import { CAPACITY_FREE_STATUSES } from "../src/modules/execution/capacity-status";
import { RECONCILABLE_STATUSES } from "../src/modules/execution/execution-orchestrator";

/**
 * The SOFT open-position target.
 *
 * It governs exactly two things: NEW admission, and the orchestrator's
 * best-effort cancellation of remaining entry orders. It is deliberately NOT a
 * post-fill validity rule — a cancellation can lose the race against a fill,
 * and that fill is real money on a real exchange. Every test here exists to
 * keep those two responsibilities apart.
 *
 * The fixtures below use the INTENDED future topology (soft 3 / hard 5 / risk
 * 7.50 / margin 40.00) as test data only. Nothing in this branch activates it:
 * the shipped defaults stay at soft == hard == 1 and are asserted at the end.
 */

const EVALUATED_AT = new Date("2026-08-19T12:00:00.000Z");
const SIGNAL_AT = new Date("2026-08-19T11:59:30.000Z");

const BASE_LIMITS: SafetyCapacityLimits = {
  maxOpenPositions: 1,
  maxPendingEntries: 1,
  maxTotalActiveTrades: 1,
  maxActivePerSymbolSide: 1,
  maxAlertAgeSeconds: 300,
  softOpenPositionTarget: 1,
  maxTotalPlannedRiskUsd: "1.50",
  maxTotalIsolatedMarginUsd: "5.00",
};

const limits = (overrides: Partial<SafetyCapacityLimits> = {}): SafetyCapacityLimits => ({
  ...BASE_LIMITS,
  ...overrides,
});

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
    ...BASE_LIMITS,
    signalFutureToleranceSeconds: 5,
    allowedSymbols: [],
    allowedSourceTimeframes: ["1D", "1W", "1M", "3M", "6M", "12M"],
    ...overrides,
  };
}

function proposed(overrides: Partial<ProposedExecution> = {}): ProposedExecution {
  return {
    executionId: "exec-1",
    profileId: "profile-1",
    symbol: "BTCUSDT",
    positionSide: "LONG",
    signalTriggeredAt: SIGNAL_AT,
    sourceTimeframe: "1W",
    currentStatus: "PLAN_READY",
    riskBudgetUsd: "1.50",
    actualPlannedLoss: "1.50",
    estimatedInitialMargin: "6.00",
    maximumIsolatedMargin: "7.9999995",
    estimatedLiquidationPrice: "90",
    requiredLiquidationBoundary: "92",
    marginPlanStatus: "READY",
    selectedLeverage: 5,
    hasMarginPlanSnapshot: true,
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

const binance = (): BinanceCapacitySnapshot => ({
  available: true,
  positionMode: "HEDGE",
  assetMode: "SINGLE_ASSET",
  usdtAvailableBalance: "500.00",
  symbolsWithPosition: [],
  symbolsWithOpenOrder: [],
  snapshotAt: EVALUATED_AT,
});

const symbolState = (): SymbolStateSnapshot => ({
  available: true,
  exists: true,
  status: "TRADING",
  contractType: "PERPETUAL",
  quoteAsset: "USDT",
  marginAsset: "USDT",
  hasFiltersSnapshot: true,
  hasBracketSnapshot: true,
});

const evaluate = (overrides: Partial<SafetyEvaluationInput> = {}) =>
  evaluateSafetyAdmission({
    evaluatedAt: EVALUATED_AT,
    proposed: proposed(),
    policy: policy(),
    local: local(),
    binance: binance(),
    symbolState: symbolState(),
    ...overrides,
  });

const reasonCodes = (result: ReturnType<typeof evaluate>): SafetyReasonCode[] =>
  result.failedChecks.map((check) => check.reasonCode);

/** The intended future topology, as a fixture only. */
const topology = () =>
  policy({
    softOpenPositionTarget: 3,
    maxOpenPositions: 5,
    maxPendingEntries: 5,
    maxTotalActiveTrades: 5,
    maxActivePerSymbolSide: 1,
    maxTotalPlannedRiskUsd: "7.50",
    maxTotalIsolatedMarginUsd: "40.00",
  });

/** N already-active executions, each reserving one $1.50 trade's worth. */
const occupied = (open: number, pending: number) =>
  local({
    openPositionCount: open,
    pendingEntryCount: pending,
    totalActiveCount: open + pending,
    reservedRiskUsd: new Prisma.Decimal("1.50").times(open + pending).toString(),
    reservedMaximumMarginUsd: new Prisma.Decimal("7.9999995").times(open + pending).toString(),
  });

// ---------------------------------------------------------------------------
// The shared-slot ladder
// ---------------------------------------------------------------------------

describe("soft open target: five shared active slots", () => {
  it("admits the fifth trade from 0+4, 1+3 and 2+2", () => {
    for (const [open, pending] of [
      [0, 4],
      [1, 3],
      [2, 2],
    ]) {
      const result = evaluate({ policy: topology(), local: occupied(open, pending) });
      expect(reasonCodes(result), `${open} open + ${pending} pending`).toEqual([]);
      expect(result.decision).toBe("PASS");
      expect(result.capacityProjected.totalActiveCount).toBe(5);
    }
  });

  it("rejects a sixth once five slots are taken, whatever the split", () => {
    for (const [open, pending] of [
      [0, 5],
      [1, 4],
      [2, 3],
    ]) {
      const codes = reasonCodes(evaluate({ policy: topology(), local: occupied(open, pending) }));
      expect(codes, `${open} open + ${pending} pending`).toContain("TOTAL_ACTIVE_LIMIT_REACHED");
    }
  });
});

// ---------------------------------------------------------------------------
// The soft gate itself
// ---------------------------------------------------------------------------

describe("soft open target: admission gate", () => {
  it("stops NEW admission at 3 open even though two hard slots remain", () => {
    const result = evaluate({ policy: topology(), local: occupied(3, 0) });
    const codes = reasonCodes(result);
    expect(codes).toContain("SOFT_OPEN_TARGET_REACHED");
    // The HARD cap is 5 and is NOT what rejected this.
    expect(codes).not.toContain("OPEN_POSITION_LIMIT_REACHED");
    expect(result.decision).toBe("SKIP");
  });

  it("treats 3 open + 2 pending as a valid transient state, not a defect", () => {
    // What the world looks like while cancellations are in flight. Only the NEW
    // execution is refused; the two pending ones are reported, not invalidated.
    const result = evaluate({ policy: topology(), local: occupied(3, 2) });
    expect(reasonCodes(result)).toContain("SOFT_OPEN_TARGET_REACHED");
    expect(result.capacityBefore.openPositionCount).toBe(3);
    expect(result.capacityBefore.pendingEntryCount).toBe(2);
  });

  it("still refuses new work at 5 open after the cancellation race is lost", () => {
    const codes = reasonCodes(evaluate({ policy: topology(), local: occupied(5, 0) }));
    // Both limits speak now, and both are reported so the operator sees why.
    expect(codes).toContain("SOFT_OPEN_TARGET_REACHED");
    expect(codes).toContain("OPEN_POSITION_LIMIT_REACHED");
  });

  it("changes nothing when soft == hard == 1, the shipped default", () => {
    // Sized for the DEFAULT policy, whose aggregate margin ceiling is 5.00.
    const single = proposed({ maximumIsolatedMargin: "4.9999995" });
    expect(reasonCodes(evaluate({ proposed: single }))).toEqual([]);
    const codes = reasonCodes(
      evaluate({ proposed: single, local: local({ openPositionCount: 1, totalActiveCount: 1 }) })
    );
    expect(codes).toContain("SOFT_OPEN_TARGET_REACHED");
    expect(codes).toContain("OPEN_POSITION_LIMIT_REACHED");
  });

  it("takes the STRICTER soft target from global and profile", () => {
    expect(
      mergeCapacityLimits(limits({ softOpenPositionTarget: 3 }), limits({ softOpenPositionTarget: 5 }))
        .softOpenPositionTarget
    ).toBe(3);
    expect(
      mergeCapacityLimits(limits({ softOpenPositionTarget: 5 }), limits({ softOpenPositionTarget: 2 }))
        .softOpenPositionTarget
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// No queue
// ---------------------------------------------------------------------------

describe("soft open target: no deferred candidate queue", () => {
  it("is TERMINAL, so the rejected candidate is SKIPPED and never revived", () => {
    expect(classifySafetyReasonRetryability("SOFT_OPEN_TARGET_REACHED")).toBe("TERMINAL");

    const result = evaluate({ policy: topology(), local: occupied(3, 0) });
    // SKIP (not UNAVAILABLE) is what makes the admission service persist
    // SKIPPED rather than leaving the row PLAN_READY for another attempt.
    expect(result.decision).toBe("SKIP");
    expect(result.reasonCode).toBe("SOFT_OPEN_TARGET_REACHED");

    // And SKIPPED is terminal in both senses that matter: it frees capacity and
    // the orchestrator never picks it up again.
    expect(CAPACITY_FREE_STATUSES).toContain("SKIPPED");
    expect(RECONCILABLE_STATUSES).not.toContain("SKIPPED" as never);
  });

  it("writes SKIPPED for the soft target exactly as the admission service maps SKIP", () => {
    // Mirrors safety-admission.service: PASS -> PREFLIGHT, SKIP -> SKIPPED,
    // UNAVAILABLE -> PLAN_READY (retry). Only the middle one applies here.
    const decision = evaluate({ policy: topology(), local: occupied(3, 0) }).decision;
    const persisted = decision === "PASS" ? "PREFLIGHT" : decision === "SKIP" ? "SKIPPED" : "PLAN_READY";
    expect(persisted).toBe("SKIPPED");
  });
});

// ---------------------------------------------------------------------------
// Portfolio arithmetic at the worst case
// ---------------------------------------------------------------------------

describe("soft open target: portfolio arithmetic", () => {
  it("fits exactly five $1.50 executions under a 7.50 planned-risk cap", () => {
    const fifth = evaluate({ policy: topology(), local: occupied(0, 4) });
    expect(fifth.capacityProjected.reservedRiskUsd).toBe("7.5");
    expect(reasonCodes(fifth)).not.toContain("TOTAL_RISK_LIMIT_REACHED");

    const sixth = evaluate({ policy: topology(), local: local({ reservedRiskUsd: "7.50" }) });
    expect(sixth.capacityProjected.reservedRiskUsd).toBe("9");
    expect(reasonCodes(sixth)).toContain("TOTAL_RISK_LIMIT_REACHED");
  });

  it("fits five MAXIMUM margin reservations under a 40.00 aggregate cap", () => {
    const fifth = evaluate({ policy: topology(), local: occupied(0, 4) });
    // 5 x 7.9999995, exact in Decimal — never a float sum.
    expect(fifth.capacityProjected.reservedMarginUsd).toBe("39.9999975");
    expect(new Prisma.Decimal(fifth.capacityProjected.reservedMarginUsd).lessThanOrEqualTo("40.00")).toBe(true);
    expect(reasonCodes(fifth)).not.toContain("TOTAL_MARGIN_LIMIT_REACHED");

    const sixth = evaluate({ policy: topology(), local: local({ reservedMaximumMarginUsd: "39.9999975" }) });
    expect(sixth.capacityProjected.reservedMarginUsd).toBe("47.999997");
    expect(reasonCodes(sixth)).toContain("TOTAL_MARGIN_LIMIT_REACHED");
  });

  it("reserves the MAXIMUM margin, not the selected one, for every slot", () => {
    // 5 x estimatedInitialMargin (6.00) would be 30.00 and would fit a much
    // smaller cap. The conservative reservation is what 40.00 is sized for.
    const fifth = evaluate({ policy: topology(), local: occupied(0, 4) });
    expect(fifth.capacityProjected.reservedMarginUsd).not.toBe("30");
  });
});

// ---------------------------------------------------------------------------
// Identity invariants that must survive more slots
// ---------------------------------------------------------------------------

describe("soft open target: symbol/side identity", () => {
  it("rejects a second execution on the same symbol AND side with four slots free", () => {
    const codes = reasonCodes(
      evaluate({
        policy: topology(),
        proposed: proposed({ symbol: "BTCUSDT", positionSide: "LONG" }),
        local: local({ activeSymbolSideKeys: ["BTCUSDT:LONG"], totalActiveCount: 1, pendingEntryCount: 1 }),
      })
    );
    expect(codes).toContain("SYMBOL_SIDE_ALREADY_ACTIVE");
  });

  it("allows the opposite HEDGE side and a different symbol", () => {
    for (const proposal of [
      proposed({ symbol: "BTCUSDT", positionSide: "SHORT" }),
      proposed({ symbol: "ETHUSDT", positionSide: "LONG" }),
    ]) {
      const codes = reasonCodes(
        evaluate({
          policy: topology(),
          proposed: proposal,
          local: local({ activeSymbolSideKeys: ["BTCUSDT:LONG"], totalActiveCount: 1, pendingEntryCount: 1 }),
        })
      );
      expect(codes, `${proposal.symbol}:${proposal.positionSide}`).not.toContain("SYMBOL_SIDE_ALREADY_ACTIVE");
    }
  });
});

// ---------------------------------------------------------------------------
// Shipped defaults stay inert
// ---------------------------------------------------------------------------

describe("soft open target: shipped configuration", () => {
  const BACKEND = process.cwd();
  const read = (relative: string) => readFileSync(path.join(BACKEND, relative), "utf8");

  it("defaults to 1 everywhere, so adding the field changes nothing", () => {
    expect(read("src/config/env.ts")).toContain(
      "EXECUTION_SOFT_OPEN_POSITION_TARGET: z.coerce.number().int().positive().default(1)"
    );
    expect(read("prisma/schema.prisma")).toMatch(/softOpenPositionTarget Int @default\(1\)/);
    for (const file of [".env.example", "../../.env.example"]) {
      expect(read(file), file).toContain("EXECUTION_SOFT_OPEN_POSITION_TARGET=1");
      // A shipped example must never arm the future topology for a copier.
      expect(read(file), file).not.toMatch(/^EXECUTION_SOFT_OPEN_POSITION_TARGET=(?!1\s*$).+$/m);
    }
  });

  it("refuses a soft target above the hard cap at startup", () => {
    expect(read("src/config/env.ts")).toContain(
      "EXECUTION_SOFT_OPEN_POSITION_TARGET must be <= EXECUTION_MAX_OPEN_POSITIONS"
    );
  });

  it("ships the migration as an additive, defaulted column", () => {
    const migration = read("prisma/migrations/20260819120000_add_soft_open_position_target/migration.sql");
    expect(migration).toContain('ALTER TABLE "ExecutionSafetyPolicy"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "softOpenPositionTarget" INTEGER NOT NULL DEFAULT 1');
    // Additive only: nothing is dropped, renamed or retyped.
    for (const forbidden of ["DROP", "ALTER COLUMN", "RENAME", "DELETE", "UPDATE "]) {
      expect(migration.toUpperCase(), forbidden).not.toContain(forbidden);
    }
  });

  it("leaves the capacity limits themselves untouched at 1/1/1/1", () => {
    const envSource = read("src/config/env.ts");
    for (const [name, value] of [
      ["EXECUTION_MAX_OPEN_POSITIONS", "1"],
      ["EXECUTION_MAX_PENDING_ENTRIES", "1"],
      ["EXECUTION_MAX_TOTAL_ACTIVE_TRADES", "1"],
      ["EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE", "1"],
    ]) {
      expect(envSource, name).toMatch(new RegExp(`${name}:[^\\n]*\\.default\\(${value}\\)`));
    }
    expect(envSource).toMatch(/EXECUTION_MAX_TOTAL_PLANNED_RISK_USD: positiveDecimalString\.default\("1\.50"\)/);
    expect(envSource).toMatch(/EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD: positiveDecimalString\.default\("5\.00"\)/);
  });
});
