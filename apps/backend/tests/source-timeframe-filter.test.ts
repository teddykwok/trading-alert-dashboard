import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  SOURCE_TIMEFRAMES,
  normalizeSourceTimeframe,
} from "@trading-alert-dashboard/shared";
import { formatExecutionNotification } from "../src/modules/notifications/execution-notification-format";
import {
  CAPACITY_FREE_STATUSES,
  TOTAL_ACTIVE_STATUSES,
} from "../src/modules/execution/capacity-status";
import {
  SOURCE_TIMEFRAME_MAX_ENTRIES,
  describeStoredSelection,
  validateSourceTimeframeSelection,
} from "../src/modules/operator/source-timeframe-policy";
import {
  SAFETY_REASON_CODES,
  classifySafetyReasonRetryability,
  evaluateSafetyAdmission,
  resolveEffectivePolicy,
  type BinanceCapacitySnapshot,
  type EffectiveSafetyPolicy,
  type LocalCapacitySnapshot,
  type ProposedExecution,
  type SymbolStateSnapshot,
} from "../src/modules/execution/safety-engine";

/**
 * The Source Timeframe execution filter.
 *
 * The filter is on the timeframe the LEVEL originated on — the `sourceTf` the
 * Pine note carries — and NEVER on the chart timeframe the retest alert fired
 * on. A 15m alert against a 1W level is a 1W signal, and the whole feature is
 * meaningless if those two are ever conflated.
 *
 * Two rules carry the safety weight and are proven here from several angles:
 *
 *   1. an EMPTY policy admits nothing. This is the exact opposite of the
 *      symbol allowlist, where empty means "no extra restriction" — a footgun
 *      the repository already owns once and is deliberately not repeating.
 *   2. an unknown or missing source timeframe fails closed, rather than
 *      matching a policy or being guessed into one.
 *
 * Everything here is pure: no database, no Binance, no runtime.
 */

const BACKEND = process.cwd();
const EVALUATED_AT = new Date("2026-01-01T12:00:00.000Z");
const SIGNAL_AT = new Date("2026-01-01T11:59:00.000Z");
const SYMBOL = "SYNTHUSDT";

function proposed(overrides: Partial<ProposedExecution> = {}): ProposedExecution {
  return {
    executionId: "exec-1",
    profileId: "profile-1",
    symbol: SYMBOL,
    positionSide: "LONG",
    signalTriggeredAt: SIGNAL_AT,
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
    softOpenPositionTarget: 1,
    maxAlertAgeSeconds: 300,
    signalFutureToleranceSeconds: 5,
    allowedSymbols: [],
    allowedSourceTimeframes: [...SOURCE_TIMEFRAMES],
    ...overrides,
  };
}

const local = (overrides: Partial<LocalCapacitySnapshot> = {}): LocalCapacitySnapshot => ({
  openPositionCount: 0,
  pendingEntryCount: 0,
  totalActiveCount: 0,
  reservedRiskUsd: "0",
  reservedMaximumMarginUsd: "0",
  activeSymbolSideKeys: [],
  pendingUnreflectedMarginUsd: "0",
  alreadyAdmitted: false,
  ...overrides,
});

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

function evaluate(overrides: {
  proposed?: ProposedExecution;
  policy?: EffectiveSafetyPolicy;
  local?: LocalCapacitySnapshot;
} = {}) {
  return evaluateSafetyAdmission({
    evaluatedAt: EVALUATED_AT,
    proposed: overrides.proposed ?? proposed(),
    policy: overrides.policy ?? policy(),
    local: overrides.local ?? local(),
    binance: binance(),
    symbolState: symbolState(),
  });
}

const reasons = (result: ReturnType<typeof evaluate>) => result.failedChecks.map((check) => check.reasonCode);

/** The two halves `resolveEffectivePolicy` merges, at their reviewed values. */
const globalLimits = () => ({
  killSwitchActive: false,
  maxOpenPositions: 1,
  maxPendingEntries: 1,
  maxTotalActiveTrades: 1,
  maxTotalPlannedRiskUsd: "1.50",
  maxTotalIsolatedMarginUsd: "5.00",
  maxActivePerSymbolSide: 1,
  maxAlertAgeSeconds: 300,
  softOpenPositionTarget: 1,
  signalFutureToleranceSeconds: 5,
});

const profileLimits = (allowedSourceTimeframes: string[] | undefined) => ({
  present: true,
  enabled: true,
  environmentMatchesConnector: true,
  killSwitchActive: false,
  expectedPositionMode: "HEDGE" as const,
  expectedMarginType: "ISOLATED" as const,
  maxOpenPositions: 1,
  maxPendingEntries: 1,
  maxTotalActiveTrades: 1,
  maxTotalPlannedRiskUsd: "1.50",
  maxTotalIsolatedMarginUsd: "5.00",
  maxActivePerSymbolSide: 1,
  maxAlertAgeSeconds: 300,
  softOpenPositionTarget: 1,
  allowedSymbols: [] as string[],
  allowedSourceTimeframes: allowedSourceTimeframes as string[],
});

// ---------------------------------------------------------------------------
// A. Canonical vocabulary and validation
// ---------------------------------------------------------------------------

describe("source timeframe: the canonical vocabulary", () => {
  it("is exactly the six operator-facing choices, and is shared, not redeclared", () => {
    expect([...SOURCE_TIMEFRAMES]).toEqual(["1D", "1W", "1M", "3M", "6M", "12M"]);

    // ONE vocabulary. A second literal list in the policy or engine would be
    // free to drift from what the webhook note parser accepts.
    for (const file of [
      "src/modules/operator/source-timeframe-policy.ts",
      "src/modules/operator/source-timeframes.service.ts",
      "src/modules/execution/safety-engine.ts",
    ]) {
      const code = readFileSync(path.join(BACKEND, file), "utf8");
      expect(`${file}:${/\[\s*"1D"\s*,\s*"1W"/.test(code)}`).toBe(`${file}:false`);
    }
  });

  it("normalizes case but NEVER promotes a bare unit into a canonical value", () => {
    expect(normalizeSourceTimeframe("1w")).toBe("1W");
    expect(normalizeSourceTimeframe("  12m  ")).toBe("12M");
    // The Pine script could plausibly emit these; guessing would manufacture
    // eligibility for a timeframe nobody recognised.
    for (const bare of ["D", "W", "M", "1h", "15m", "", "  ", "1Y"]) {
      expect(`${bare}:${normalizeSourceTimeframe(bare)}`).toBe(`${bare}:null`);
    }
    expect(normalizeSourceTimeframe(null)).toBeNull();
    expect(normalizeSourceTimeframe(42)).toBeNull();
  });

  it("accepts every single choice and any non-empty combination", () => {
    for (const timeframe of SOURCE_TIMEFRAMES) {
      const result = validateSourceTimeframeSelection([timeframe]);
      expect(`${timeframe}:${result.ok}`).toBe(`${timeframe}:true`);
      expect(result.accepted).toEqual([timeframe]);
    }
    for (const combination of [
      ["1W"],
      ["1W", "1M"],
      ["1D", "1W", "1M"],
      ["12M", "1D"],
      [...SOURCE_TIMEFRAMES],
    ]) {
      expect(validateSourceTimeframeSelection(combination).ok).toBe(true);
    }
  });

  it("returns the selection in canonical order, whatever order it arrives in", () => {
    const result = validateSourceTimeframeSelection(["12M", "1D", "3M", "1W"]);
    expect(result.accepted).toEqual(["1D", "1W", "3M", "12M"]);
  });

  it("canonicalizes duplicates rather than refusing them", () => {
    // Two spellings of one timeframe are one choice; a checkbox list cannot
    // express anything else, so refusing would be a false alarm.
    const result = validateSourceTimeframeSelection(["1W", "1w", " 1W "]);
    expect(result.ok).toBe(true);
    expect(result.accepted).toEqual(["1W"]);
    expect(result.counts.duplicates).toBe(2);
  });

  it("REFUSES an unknown value outright instead of saving the recognisable rest", () => {
    // A partial save would be a policy nobody chose, and the operator cannot
    // see what was dropped from a checkbox list that still looks correct.
    const result = validateSourceTimeframeSelection(["1W", "4H"]);
    expect(result.ok).toBe(false);
    expect(result.rejected.map((entry) => entry.reasonCode)).toEqual(["UNKNOWN_TIMEFRAME"]);
    expect(result.refusal).toContain("not recognised");
  });

  it("REFUSES an empty selection — empty is never allow-all", () => {
    const result = validateSourceTimeframeSelection([]);
    expect(result.ok).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(result.refusal).toContain("At least one source timeframe");
    // The refusal must say what empty would MEAN, not merely that it is empty.
    expect(result.refusal).toContain("admit NO signal");
  });

  it("REFUSES non-array and oversized input", () => {
    for (const bad of [null, undefined, "1W", 7, {}]) {
      expect(validateSourceTimeframeSelection(bad).ok).toBe(false);
    }
    const huge = Array.from({ length: SOURCE_TIMEFRAME_MAX_ENTRIES + 1 }, () => "1W");
    expect(validateSourceTimeframeSelection(huge).ok).toBe(false);
  });

  it("reports a stored policy honestly rather than repairing it", () => {
    expect(describeStoredSelection(["1W", "1M"])).toEqual({
      enforceable: ["1W", "1M"],
      unrecognized: [],
      valid: true,
    });
    // Empty and malformed are both INVALID, and neither becomes "all".
    expect(describeStoredSelection([]).valid).toBe(false);
    expect(describeStoredSelection([]).enforceable).toEqual([]);
    expect(describeStoredSelection(null).valid).toBe(false);

    const mixed = describeStoredSelection(["1W", "4H"]);
    expect(mixed.enforceable).toEqual(["1W"]);
    expect(mixed.unrecognized).toEqual(["4H"]);
    expect(mixed.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B/C. The admission rule
// ---------------------------------------------------------------------------

describe("source timeframe: admission", () => {
  it("B. an ALLOWED source timeframe passes exactly as before", () => {
    const result = evaluate({ policy: policy({ allowedSourceTimeframes: ["1W"] }) });
    expect(result.decision).toBe("PASS");
    expect(reasons(result)).toEqual([]);
  });

  it("C. a DISALLOWED source timeframe is a terminal SKIP", () => {
    const result = evaluate({ policy: policy({ allowedSourceTimeframes: ["1M", "3M"] }) });
    expect(result.decision).toBe("SKIP");
    expect(result.reasonCode).toBe("SOURCE_TIMEFRAME_NOT_ALLOWED");
    // The message names both halves, so the operator does not have to go and
    // look up what the policy was at the time.
    expect(result.message).toContain("1W");
    expect(result.message).toContain("1M, 3M");
  });

  it("distinguishes the CHART timeframe from the level's source timeframe", () => {
    // The scenario from the specification: a 15m retest of a 1W level. Nothing
    // in the engine consults a chart timeframe, and this proves the decision
    // tracks sourceTimeframe alone.
    const allowsWeekly = policy({ allowedSourceTimeframes: ["1W"] });
    expect(evaluate({ proposed: proposed({ sourceTimeframe: "1W" }), policy: allowsWeekly }).decision).toBe("PASS");
    expect(evaluate({ proposed: proposed({ sourceTimeframe: "1D" }), policy: allowsWeekly }).decision).toBe("SKIP");
  });

  it("fails CLOSED when the source timeframe is missing or unrecognised", () => {
    for (const value of [null, "", "   ", "4H", "W"]) {
      const result = evaluate({ proposed: proposed({ sourceTimeframe: value }) });
      expect(`${value}:${result.decision}`).toBe(`${value}:SKIP`);
      expect(result.reasonCode).toBe(
        value === null || value === "" || value === "   "
          ? "SOURCE_TIMEFRAME_UNAVAILABLE"
          : "SOURCE_TIMEFRAME_NOT_ALLOWED"
      );
    }
  });

  it("an EMPTY policy admits NOTHING — the opposite of the symbol allowlist", () => {
    // The single most important assertion in this file. `allowedSymbols: []`
    // means "no extra restriction"; `allowedSourceTimeframes: []` must mean
    // "nothing is eligible", or an operator who cleared the list would silently
    // arm every timeframe instead of none.
    for (const timeframe of SOURCE_TIMEFRAMES) {
      const result = evaluate({
        proposed: proposed({ sourceTimeframe: timeframe }),
        policy: policy({ allowedSourceTimeframes: [] }),
      });
      expect(`${timeframe}:${result.decision}`).toBe(`${timeframe}:SKIP`);
      expect(result.reasonCode).toBe("SOURCE_TIMEFRAME_NOT_ALLOWED");
    }
    // And the same input under an allow-all symbol list still PASSES, proving
    // the two lists really do read their emptiness differently.
    expect(evaluate({ policy: policy({ allowedSymbols: [] }) }).decision).toBe("PASS");
  });

  it("tolerates a hand-edited policy row's casing at the BOUNDARY, not in the rule", () => {
    // The engine compares canonical strings and owns no vocabulary; casing is
    // resolved once, where the durable row enters, so there is exactly one
    // place that decides what a stored value means.
    const lower = resolveEffectivePolicy(globalLimits(), profileLimits([" 1w "]));
    expect(lower.allowedSourceTimeframes).toEqual(["1W"]);
    expect(evaluate({ policy: policy({ allowedSourceTimeframes: lower.allowedSourceTimeframes }) }).decision).toBe(
      "PASS"
    );
    // An unrecognised stored value survives canonicalization as itself and
    // therefore matches no signal: it admits nothing.
    const bare = resolveEffectivePolicy(globalLimits(), profileLimits(["W"]));
    expect(evaluate({ policy: policy({ allowedSourceTimeframes: bare.allowedSourceTimeframes }) }).decision).toBe(
      "SKIP"
    );
  });

  it("both codes are TERMINAL, so an ineligible signal is never revived", () => {
    for (const code of ["SOURCE_TIMEFRAME_NOT_ALLOWED", "SOURCE_TIMEFRAME_UNAVAILABLE"] as const) {
      expect(SAFETY_REASON_CODES).toContain(code);
      expect(classifySafetyReasonRetryability(code)).toBe("TERMINAL");
    }
  });

  it("carries the policy column through resolveEffectivePolicy", () => {
    const resolved = resolveEffectivePolicy(globalLimits(), profileLimits([" 1w ", "1M"]));
    expect(resolved.allowedSourceTimeframes).toEqual(["1W", "1M"]);
  });

  it("treats an ABSENT policy column as admitting nothing", () => {
    // A profile with no policy row is already refused by
    // PROFILE_POLICY_UNAVAILABLE, but eligibility must never be the thing that
    // defaults permissive if that rule ever moves.
    const resolved = resolveEffectivePolicy(globalLimits(), profileLimits(undefined));
    expect(resolved.allowedSourceTimeframes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D/E. Ordering: the rule runs before anything is spent
// ---------------------------------------------------------------------------

describe("source timeframe: spends nothing when it refuses", () => {
  const admission = readFileSync(
    path.join(BACKEND, "src/modules/execution/safety-admission.service.ts"),
    "utf8"
  );

  it("D. the natural-window claim is reachable only on PASS", () => {
    // The structural proof that a refused source timeframe cannot spend a
    // claim: the claim lives inside `if (result.decision === "PASS")`, and the
    // engine has already returned SKIP by then. Asserted on the source because
    // the ordering — not any individual value — is what makes it true.
    const claimAt = admission.indexOf("claimNaturalWindow(tx");
    const guardAt = admission.indexOf('if (result.decision === "PASS")');
    expect(guardAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(guardAt);

    // And the evaluation that can produce our SKIP happens before that guard.
    expect(admission.indexOf("evaluateSafetyAdmission({")).toBeLessThan(guardAt);
  });

  it("E. a refusal never reaches PREFLIGHT, so no capacity is reserved", () => {
    // Status is PREFLIGHT only for PASS; every SKIP lands in SKIPPED, which
    // capacity-status counts as free.
    expect(admission).toContain(
      'result.decision === "PASS" ? "PREFLIGHT" : result.decision === "SKIP" ? "SKIPPED" : "PLAN_READY"'
    );
    expect([...TOTAL_ACTIVE_STATUSES]).not.toContain("SKIPPED");
    expect([...CAPACITY_FREE_STATUSES]).toContain("SKIPPED");
  });

  it("E2. the decision carries no reservation of its own", () => {
    const result = evaluate({ policy: policy({ allowedSourceTimeframes: ["1M"] }) });
    expect(result.decision).toBe("SKIP");
    // The engine is pure — it reserves nothing and mutates nothing. Proven by
    // the local snapshot being untouched by evaluation.
    const before = local();
    evaluate({ policy: policy({ allowedSourceTimeframes: ["1M"] }), local: before });
    expect(before).toEqual(local());
  });

  it("I. reconciliation and protection never consult eligibility", () => {
    // The filter is an ADMISSION policy. A later policy change must not
    // reinterpret an execution that already exists, so nothing on the
    // protection or reconciliation path may read it.
    for (const file of [
      "src/modules/execution/protection-lifecycle.service.ts",
      "src/modules/execution/entry-lifecycle.service.ts",
      "src/modules/execution/execution-orchestrator.ts",
      "src/modules/jobs/execution-orchestration.scheduler.ts",
    ]) {
      const code = readFileSync(path.join(BACKEND, file), "utf8");
      expect(`${file}:${code.includes("allowedSourceTimeframes")}`).toBe(`${file}:false`);
      expect(`${file}:${code.includes("SOURCE_TIMEFRAME_NOT_ALLOWED")}`).toBe(`${file}:false`);
    }
  });

  it("freezes the value on the execution, exactly as signalTriggeredAt is frozen", () => {
    // Retention may null alertId, so an admission input that lives only on the
    // alert can vanish. The frozen copy is what makes the decision stable.
    const service = readFileSync(path.join(BACKEND, "src/modules/execution/execution.service.ts"), "utf8");
    expect(service).toContain("sourceTimeframe: normalizeSourceTimeframe(alert.sourceTimeframe)");
    const schema = readFileSync(path.join(BACKEND, "prisma/schema.prisma"), "utf8");
    const model = /model TradeExecution \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    expect(model).toContain("sourceTimeframe   String?");
  });
});

// ---------------------------------------------------------------------------
// Presentation of a refusal
// ---------------------------------------------------------------------------

describe("source timeframe: how a refusal reads", () => {
  it("renders through the EXISTING TRADE_SKIPPED path, with no new notification type", () => {
    // Reusing the established skip presentation is the point: a refused
    // signal is already a terminal SKIPPED, so it needs no channel of its own
    // and produces no extra Telegram traffic.
    const rendered = formatExecutionNotification(
      {
        type: "TRADE_SKIPPED",
        symbol: "FHEUSDT",
        positionSide: "LONG",
        reasonCode: "SOURCE_TIMEFRAME_NOT_ALLOWED",
        explanation:
          "Source timeframe 1D is not enabled for execution (allowed: 1W, 1M).",
      } as never,
      "ref-1"
    );
    expect(rendered).toContain("TRADE SKIPPED");
    expect(rendered).toContain("Reason: SOURCE_TIMEFRAME_NOT_ALLOWED");
    // Both halves of the decision are legible without a lookup.
    expect(rendered).toContain("1D");
    expect(rendered).toContain("1W, 1M");
  });
});
