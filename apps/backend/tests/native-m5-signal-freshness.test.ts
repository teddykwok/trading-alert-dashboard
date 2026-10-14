import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decideNativeAccountACandidate, type NativeCanaryAlert } from "../src/modules/native-canary/native-account-a-canary";
import {
  NATIVE_ABSOLUTE_MAX_SIGNAL_AGE_MS,
  NATIVE_OPERATIONAL_BAR_MS,
  NATIVE_POST_CLOSE_FRESHNESS_MS,
  NATIVE_SIGNAL_REFUSAL_CODES,
  judgeNativeSignalFreshness,
  nativeSignalExpiryOf,
  nativeSignalLifetimeSpan,
  nativeSignalWindowOf,
} from "../src/modules/native-canary/native-signal-freshness";
import { NATIVE_DELIVERY_CHART_INTERVALS } from "../src/modules/native-alerts/native-delivery-policy";
import { NATIVE_CANARY_REASON_CODES } from "../src/modules/native-canary/native-account-a-canary";
import { classifySafetyReasonRetryability, evaluateSafetyAdmission, type ProposedExecution, type SafetyEvaluationInput } from "../src/modules/execution/safety-engine";
import {
  RISK_CONTRACT_MODULE,
  SOURCE_BAR,
  SOURCE_BAR_CLOSE,
  canaryAlert,
  cleanRecords,
  eligibleEvidence,
  favourableInput,
  integrityDto,
  readerOf,
  resolvedAContracts,
  type FixtureOptions,
} from "./helpers/native-canary-fixtures";

/**
 * MILESTONE 5, PART B: Native Signal Freshness V1.
 *
 * Deterministic clock tests, all on the fixture's operational 15m bar
 * (SOURCE_BAR = 2026-10-01T12:15Z, closing 12:30Z), with alerts built by the
 * REAL scanner -> delivery -> alert-draft pipeline, so the bar start under test
 * is the one the emitter persists. Letters are the milestone's freshness
 * matrix. The DB-backed half (adoption deferral, Phase 5, revalidation,
 * PREFLIGHT release) is in native-m5-risk-freshness.integration.test.ts.
 */

const BACKEND = path.resolve(__dirname, "..");
const SWITCH = "../src/modules/native-canary/native-execution-switch";
const S = 1000;
const MIN = 60 * S;
/** The one expiry every valid touch on SOURCE_BAR shares: bar close + 5 minutes. */
const EXPIRY = SOURCE_BAR_CLOSE + 5 * MIN;

const alertAt = (eventTimeMs: number, options: FixtureOptions = {}) => canaryAlert(cleanRecords({ ...options, eventTimeMs }), options);
const verdictAt = (alert: NativeCanaryAlert, nowMs: number) => judgeNativeSignalFreshness(nativeSignalWindowOf(alert), nowMs);
const freshAt = (alert: NativeCanaryAlert, nowMs: number) => verdictAt(alert, nowMs).fresh;
const reasonAt = (alert: NativeCanaryAlert, nowMs: number) => {
  const verdict = verdictAt(alert, nowMs);
  return verdict.fresh ? "FRESH" : verdict.reason;
};
/** A deep copy of the alert with its payload edited. */
function edited(alert: NativeCanaryAlert, edit: (payload: Record<string, any>, row: { triggeredAt: Date | null | undefined }) => void): NativeCanaryAlert {
  const payload = structuredClone(alert.rawPayload) as Record<string, any>;
  const row = { triggeredAt: alert.triggeredAt };
  edit(payload, row);
  return { ...alert, rawPayload: payload, triggeredAt: row.triggeredAt };
}

afterEach(() => {
  vi.doUnmock(SWITCH);
  vi.doUnmock(RISK_CONTRACT_MODULE);
  vi.resetModules();
});

// ===========================================================================
// The rule and its anchor
// ===========================================================================

describe("the rule: anchored to the alert's persisted operational 15m bar", () => {
  it("the constants are the milestone's, and the operational bar is the only delivery interval", () => {
    expect(NATIVE_OPERATIONAL_BAR_MS).toBe(15 * MIN);
    expect(NATIVE_POST_CLOSE_FRESHNESS_MS).toBe(5 * MIN);
    expect(NATIVE_ABSOLUTE_MAX_SIGNAL_AGE_MS).toBe(20 * MIN);
    expect(NATIVE_DELIVERY_CHART_INTERVALS).toEqual({ "15m": NATIVE_OPERATIONAL_BAR_MS });
  });

  it("the bar start is the payload's own delivery.barStart (== barTime), never the source candle, and the trigger is the row's own instant", () => {
    const alert = alertAt(SOURCE_BAR + 61_234);
    const payload = alert.rawPayload as { barTime: string; triggeredAt: string; delivery: { barStart: string; sourceTimeframe: string } };
    const result = nativeSignalWindowOf(alert);
    if (!result.ok) throw new Error(result.reason);
    expect(result.window).toEqual({
      barStartMs: SOURCE_BAR,
      barCloseMs: SOURCE_BAR_CLOSE,
      triggeredAtMs: SOURCE_BAR + 61_234,
      postCloseExpiryMs: EXPIRY,
      absoluteExpiryMs: SOURCE_BAR + 61_234 + 20 * MIN,
      expiresAtMs: EXPIRY,
    });
    expect(Date.parse(payload.delivery.barStart)).toBe(SOURCE_BAR);
    expect(payload.barTime).toBe(payload.delivery.barStart);
    expect(Date.parse(payload.triggeredAt)).toBe(alert.triggeredAt!.getTime());
    // A 1W level's own candle started days earlier; it plays no part.
    const weekly = alertAt(SOURCE_BAR + 61_234, { sourceTf: "1W" });
    expect((weekly.rawPayload as { delivery: { sourceTimeframe: string } }).delivery.sourceTimeframe).toBe("1W");
    expect(nativeSignalWindowOf(weekly)).toEqual(result);
  });

  it("the formula alone: expiresAt = min(barStart + 15m + 5m, triggeredAt + 20m), and the 20-minute cap binds whenever the bar would outlive it", () => {
    expect(nativeSignalExpiryOf(SOURCE_BAR, SOURCE_BAR + 7 * MIN)).toMatchObject({ barCloseMs: SOURCE_BAR_CLOSE, postCloseExpiryMs: EXPIRY, absoluteExpiryMs: SOURCE_BAR + 27 * MIN, expiresAtMs: EXPIRY });
    // Were a bar start ever LATER than the touch (impossible for a real alert, refused below), the cap still holds the lifetime to 20 minutes from the touch.
    const capped = nativeSignalExpiryOf(SOURCE_BAR + 10 * MIN, SOURCE_BAR);
    expect(capped.postCloseExpiryMs).toBe(SOURCE_BAR + 30 * MIN);
    expect(capped.expiresAtMs).toBe(SOURCE_BAR + 20 * MIN);
    // For every valid touch (barStart <= triggeredAt) the post-close expiry is the earlier one.
    for (const offset of [0, 1, 7 * MIN, 15 * MIN - 1, 15 * MIN, 15 * MIN + 2 * S]) {
      const w = nativeSignalExpiryOf(SOURCE_BAR, SOURCE_BAR + offset);
      expect(w.postCloseExpiryMs <= w.absoluteExpiryMs, String(offset)).toBe(true);
      expect(w.expiresAtMs).toBe(EXPIRY);
    }
  });

  it("discovery's span is exactly the trigger instants that can still be fresh", () => {
    expect(nativeSignalLifetimeSpan(EXPIRY)).toEqual({ earliestTriggeredAtMs: EXPIRY - 20 * MIN, latestTriggeredAtMs: EXPIRY });
  });
});

// ===========================================================================
// A-I. The matrix
// ===========================================================================

describe("A-I. the freshness matrix, pinned to the millisecond", () => {
  it("A. a touch at the bar's open stays fresh through the close and 5 minutes past it, although it is then 20 minutes old", () => {
    const alert = alertAt(SOURCE_BAR);
    expect(freshAt(alert, SOURCE_BAR)).toBe(true);
    expect(freshAt(alert, SOURCE_BAR + 5 * MIN + 1)).toBe(true); // 300s after the touch: still fresh, the bar has not even closed
    expect(freshAt(alert, SOURCE_BAR_CLOSE)).toBe(true);
    expect(freshAt(alert, EXPIRY)).toBe(true);
    expect(reasonAt(alert, EXPIRY + 1)).toBe("STALE");
  });

  it("B. a touch in the middle of the bar has the same expiry", () => {
    const alert = alertAt(SOURCE_BAR + 7 * MIN + 30 * S);
    expect(freshAt(alert, SOURCE_BAR_CLOSE + 4 * MIN + 59 * S)).toBe(true);
    expect(freshAt(alert, EXPIRY)).toBe(true);
    expect(reasonAt(alert, EXPIRY + 1)).toBe("STALE");
  });

  it("C. a touch in the bar's final second has the same expiry: close + 300s, i.e. touch + 301s", () => {
    const touch = SOURCE_BAR_CLOSE - S;
    const alert = alertAt(touch);
    expect(freshAt(alert, touch + 301 * S)).toBe(true);
    expect(reasonAt(alert, touch + 301 * S + 1)).toBe("STALE");
  });

  it("D. a touch exactly AT the close boundary (the bar's closing update) is legal, stays on its bar, and gets close + 300s, never a next-bar window", () => {
    const alert = alertAt(SOURCE_BAR_CLOSE);
    const result = nativeSignalWindowOf(alert);
    expect(result).toMatchObject({ ok: true, window: { barStartMs: SOURCE_BAR, triggeredAtMs: SOURCE_BAR_CLOSE, expiresAtMs: EXPIRY } });
    expect(freshAt(alert, SOURCE_BAR_CLOSE)).toBe(true);
    expect(freshAt(alert, EXPIRY)).toBe(true);
    expect(reasonAt(alert, EXPIRY + 1)).toBe("STALE");
    // A closing update a little after the nominal close still belongs to the same bar and the same expiry.
    expect(nativeSignalWindowOf(alertAt(SOURCE_BAR_CLOSE + 2 * S))).toMatchObject({ ok: true, window: { barStartMs: SOURCE_BAR, expiresAtMs: EXPIRY } });
  });

  it("E/F/G. close + 299s is fresh, close + 300s exactly is fresh (inclusive), one millisecond later is stale", () => {
    const alert = alertAt(SOURCE_BAR + 61_234);
    expect(freshAt(alert, SOURCE_BAR_CLOSE + 299 * S)).toBe(true);
    expect(freshAt(alert, SOURCE_BAR_CLOSE + 300 * S)).toBe(true);
    const stale = verdictAt(alert, SOURCE_BAR_CLOSE + 300 * S + 1);
    expect(stale).toMatchObject({ fresh: false, reason: "STALE" });
    if (stale.fresh) throw new Error("unreachable");
    expect(stale.message).toContain(`expired at ${new Date(EXPIRY).toISOString()}`);
  });

  it("H. more than 20 minutes after the touch is never fresh, wherever in the bar the touch was", () => {
    for (const touch of [SOURCE_BAR, SOURCE_BAR + 7 * MIN, SOURCE_BAR_CLOSE - 1, SOURCE_BAR_CLOSE]) {
      expect(reasonAt(alertAt(touch), touch + 20 * MIN + 1), String(touch)).toBe("STALE");
    }
  });

  it("I. after a long downtime or a replay the signal is stale, and staleness never reverses", () => {
    const alert = alertAt(SOURCE_BAR + 61_234);
    for (const later of [EXPIRY + 1, EXPIRY + MIN, SOURCE_BAR + 60 * MIN, SOURCE_BAR + 6 * 60 * MIN, SOURCE_BAR + 30 * 24 * 60 * MIN]) {
      expect(reasonAt(alert, later), String(later)).toBe("STALE");
    }
  });
});

// ===========================================================================
// J-L. Fail closed on evidence
// ===========================================================================

describe("J-L. missing, malformed, impossible or unattributable evidence is refused, never assumed", () => {
  const base = alertAt(SOURCE_BAR + 61_234);
  const at = SOURCE_BAR_CLOSE + MIN; // fresh for the unedited alert
  const invalid = (alert: NativeCanaryAlert) => {
    const verdict = verdictAt(alert, at);
    return !verdict.fresh && verdict.reason === "EVIDENCE_INVALID" && verdict.window === null;
  };

  it("the unedited alert is fresh at the instant every case below is judged", () => {
    expect(freshAt(base, at)).toBe(true);
  });

  it("J. a missing bar start (or bar time, or payload) proves no window", () => {
    expect(invalid(edited(base, (p) => delete p.delivery.barStart))).toBe(true);
    expect(invalid(edited(base, (p) => delete p.barTime))).toBe(true);
    expect(invalid(edited(base, (p) => delete p.delivery))).toBe(true);
    expect(invalid({ ...base, rawPayload: null })).toBe(true);
    expect(invalid({ ...base, rawPayload: "{}" })).toBe(true);
    // An older payload schema carries no provenance to anchor to.
    expect(invalid(edited(base, (p) => (p.schema = "teddy.native-alerts.alert-payload.v1")))).toBe(true);
  });

  it("K. a malformed bar start proves no window: not exact ISO milliseconds, off a 15m boundary, disagreeing with barTime, or not the bar its own event hash names", () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(invalid(edited(base, (p) => ((p.delivery.barStart = iso(SOURCE_BAR).replace(".000Z", "Z")), (p.barTime = p.delivery.barStart))))).toBe(true);
    expect(invalid(edited(base, (p) => ((p.delivery.barStart = iso(SOURCE_BAR + 1)), (p.barTime = p.delivery.barStart))))).toBe(true);
    expect(invalid(edited(base, (p) => (p.barTime = iso(SOURCE_BAR - 15 * MIN))))).toBe(true);
    expect(invalid(edited(base, (p) => ((p.delivery.barStart = iso(SOURCE_BAR - 15 * MIN)), (p.barTime = p.delivery.barStart))))).toBe(true);
    expect(invalid(edited(base, (p) => ((p.delivery.barStart = "not a time"), (p.barTime = "not a time"))))).toBe(true);
    expect(invalid(edited(base, (p) => (p.timeframe = "1h")))).toBe(true);
  });

  it("L. an impossible or unattributable trigger instant proves no window", () => {
    // The touch before its own bar opened (row and payload agreeing): impossible.
    const early = edited(base, (p, row) => {
      row.triggeredAt = new Date(SOURCE_BAR - 1);
      p.triggeredAt = row.triggeredAt.toISOString();
    });
    expect(invalid(early)).toBe(true);
    const verdict = verdictAt(early, at);
    expect(!verdict.fresh && verdict.message).toMatch(/predates its own bar's open/);
    // The row and its payload disagreeing, in either direction, by one millisecond.
    expect(invalid(edited(base, (_p, row) => (row.triggeredAt = new Date(row.triggeredAt!.getTime() + 1))))).toBe(true);
    expect(invalid(edited(base, (p) => (p.triggeredAt = new Date(Date.parse(p.triggeredAt) - 1).toISOString())))).toBe(true);
    // No usable trigger instant at all.
    for (const triggeredAt of [null, undefined, new Date(Number.NaN)]) {
      expect(invalid({ ...base, triggeredAt }), String(triggeredAt)).toBe(true);
    }
    expect(invalid(edited(base, (p) => delete p.triggeredAt))).toBe(true);
    // An execution whose frozen copy is not its alert's instant.
    expect(judgeNativeSignalFreshness(nativeSignalWindowOf(base, { signalTriggeredAt: new Date(base.triggeredAt!.getTime() + 1) }), at)).toMatchObject({ fresh: false, reason: "EVIDENCE_INVALID" });
    expect(judgeNativeSignalFreshness(nativeSignalWindowOf(base, { signalTriggeredAt: null }), at)).toMatchObject({ fresh: false, reason: "EVIDENCE_INVALID" });
    expect(judgeNativeSignalFreshness(nativeSignalWindowOf(base, { signalTriggeredAt: base.triggeredAt! }), at)).toMatchObject({ fresh: true });
    // Not a NATIVE alert.
    for (const source of ["TRADINGVIEW", null, undefined]) expect(invalid({ ...base, source })).toBe(true);
  });

  it("L. a signal from the future is refused, with no clock-skew tolerance: one millisecond before the touch is not fresh", () => {
    const touch = base.triggeredAt!.getTime();
    expect(reasonAt(base, touch - 1)).toBe("TIME_IN_FUTURE");
    expect(freshAt(base, touch)).toBe(true);
  });

  it("an invalid evaluation instant is refused", () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) expect(reasonAt(base, now)).toBe("EVIDENCE_INVALID");
  });
});

// ===========================================================================
// M, N, P, Q (decision level). Freshness and integrity compose causally
// ===========================================================================

describe("M/N/P/Q. the decision: freshness composes with integrity and source timeframe", () => {
  const touch = SOURCE_BAR + 61_234;

  it("M. a bar still forming (PENDING_BAR_CLOSE) is never refused for age: 10 minutes after the touch it is refused only as PENDING, which the adoption defers", () => {
    const input = favourableInput({}, { integrity: integrityDto("PENDING_BAR_CLOSE"), nowMs: touch + 10 * MIN });
    expect(decideNativeAccountACandidate(input)).toMatchObject({ admitted: false, stage: "INTEGRITY", reasonCode: "INTEGRITY_PENDING_BAR_CLOSE" });
  });

  it("M. if integrity has not become executable by the expiry, the refusal is STALE, at FRESHNESS", () => {
    const input = favourableInput({}, { integrity: integrityDto("PENDING_BAR_CLOSE"), nowMs: EXPIRY + 1 });
    expect(decideNativeAccountACandidate(input)).toMatchObject({ admitted: false, stage: "FRESHNESS", reasonCode: "NATIVE_SIGNAL_STALE" });
  });

  it("N. PENDING -> ELIGIBLE immediately after the close: a touch 15 minutes old passes FRESHNESS and INTEGRITY, and only the hard fence refuses", () => {
    const early = favourableInput({ eventTimeMs: SOURCE_BAR }, { nowMs: SOURCE_BAR_CLOSE + 1 });
    expect(decideNativeAccountACandidate(early)).toMatchObject({ admitted: false, stage: "NATIVE_FENCE", reasonCode: "NATIVE_EXECUTION_DISABLED" });
    expect(decideNativeAccountACandidate({ ...early, nowMs: EXPIRY })).toMatchObject({ stage: "NATIVE_FENCE" });
    expect(decideNativeAccountACandidate({ ...early, nowMs: EXPIRY + 1 })).toMatchObject({ stage: "FRESHNESS", reasonCode: "NATIVE_SIGNAL_STALE" });
  });

  it("the decision refuses every unusable time verdict at FRESHNESS with the canonical codes", () => {
    const input = favourableInput();
    expect(decideNativeAccountACandidate({ ...input, nowMs: input.alert.triggeredAt!.getTime() - 1 })).toMatchObject({ stage: "FRESHNESS", reasonCode: "NATIVE_SIGNAL_TIME_UNAVAILABLE" });
    expect(decideNativeAccountACandidate({ ...input, alert: { ...input.alert, triggeredAt: null } })).toMatchObject({ stage: "FRESHNESS", reasonCode: "NATIVE_SIGNAL_TIME_UNAVAILABLE" });
    for (const code of NATIVE_SIGNAL_REFUSAL_CODES) expect((NATIVE_CANARY_REASON_CODES as readonly string[]).includes(code)).toBe(true);
  });

  it("P. Native 1M (and 3M/6M/12M) still fail SOURCE_TF_NOT_EXECUTABLE, fresh or stale: the timeframe stage comes first", () => {
    const monthly = favourableInput({ sourceTf: "1M" });
    expect(decideNativeAccountACandidate(monthly)).toMatchObject({ stage: "SOURCE_TIMEFRAME", reasonCode: "SOURCE_TF_NOT_EXECUTABLE" });
    expect(decideNativeAccountACandidate({ ...monthly, nowMs: EXPIRY + 60 * MIN })).toMatchObject({ stage: "SOURCE_TIMEFRAME", reasonCode: "SOURCE_TF_NOT_EXECUTABLE" });
    for (const sourceTimeframe of ["3M", "6M", "12M"]) {
      const input = favourableInput();
      expect(decideNativeAccountACandidate({ ...input, alert: { ...input.alert, sourceTimeframe } }), sourceTimeframe).toMatchObject({ stage: "SOURCE_TIMEFRAME", reasonCode: "SOURCE_TF_NOT_EXECUTABLE" });
    }
  });

  it("Q. a stale candidate is refused in the pure decision, so nothing downstream exists for it; past the switch (test graph) the executor refuses it before the signed planner", async () => {
    vi.resetModules();
    vi.doMock(SWITCH, () => ({ NATIVE_EXECUTION_ENABLED: true }));
    vi.doMock(RISK_CONTRACT_MODULE, resolvedAContracts);
    const canary = await import("../src/modules/native-canary/native-account-a-canary");
    const { SelectedPlanExecutor } = await import("../src/modules/execution/selected-plan-executor");
    const input = favourableInput();
    expect(canary.decideNativeAccountACandidate({ ...input, nowMs: EXPIRY + 1 })).toMatchObject({ admitted: false, stage: "FRESHNESS", reasonCode: "NATIVE_SIGNAL_STALE" });
    const decision = canary.decideNativeAccountACandidate(input);
    if (!decision.admitted) throw new Error(`fixture: ${decision.reasonCode}`);
    const touched: string[] = [];
    const trap = (name: string) => new Proxy({}, { get: (_t, key) => (touched.push(`${name}.${String(key)}`), () => { throw new Error(`${name} reached`); }) });
    const prisma = { alert: { findUnique: async () => ({ source: "NATIVE", symbol: input.alert.symbol, triggeredAt: input.alert.triggeredAt, rawPayload: input.alert.rawPayload }) } };
    const executor = new SelectedPlanExecutor({
      prisma: prisma as never,
      marginPlanner: trap("marginPlanner") as never,
      executions: trap("executions") as never,
      orchestrator: trap("orchestrator") as never,
      boundProfile: { executionProfileId: "profile-account-a", exchange: "BINANCE", product: "USDM_FUTURES", environment: "TESTNET" } as never,
      nativeFence: { evidence: readerOf(eligibleEvidence(cleanRecords())), accountSlot: "ACCOUNT_A" },
    });
    // The hand-off was decided while fresh; by the time it reaches the executor the window has closed.
    expect(await executor.handleNativeAccountACandidate(decision.handoff, new Date(EXPIRY + 1))).toMatchObject({ handled: false, reasonCode: "NATIVE_SIGNAL_STALE" });
    expect(await executor.handleNativeAccountACandidate(decision.handoff, new Date(input.alert.triggeredAt!.getTime() - 1))).toMatchObject({ handled: false, reasonCode: "NATIVE_SIGNAL_TIME_UNAVAILABLE" });
    expect(touched).toEqual([]);
  });
});

// ===========================================================================
// O. Phase 5: the Native verdict replaces the age rule only for Native
// ===========================================================================

describe("O + Phase 5 engine. TradingView keeps 300 seconds from triggeredAt; a Native execution is judged by its verdict", () => {
  const EVALUATED_AT = new Date("2026-01-01T12:00:00.000Z");
  function input(proposed: Partial<ProposedExecution>): SafetyEvaluationInput {
    return {
      evaluatedAt: EVALUATED_AT,
      proposed: {
        executionId: "exec-m5",
        profileId: "profile-m5",
        symbol: "SYNTHUSDT",
        positionSide: "LONG",
        signalTriggeredAt: new Date(EVALUATED_AT.getTime() - 60 * S),
        sourceTimeframe: "1D",
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
        takeProfit: null,
        intendedTakeProfitModality: null,
        ...proposed,
      },
      policy: {
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
        allowedSourceTimeframes: ["1D", "1W", "1M", "3M", "6M", "12M"],
      },
      local: { openPositionCount: 0, pendingEntryCount: 0, totalActiveCount: 0, reservedRiskUsd: "0", reservedMaximumMarginUsd: "0", activeSymbolSideKeys: [], pendingUnreflectedMarginUsd: "0", alreadyAdmitted: false },
      binance: { available: true, positionMode: "HEDGE", assetMode: "SINGLE_ASSET", usdtAvailableBalance: "100.00", symbolsWithPosition: [], symbolsWithOpenOrder: [], snapshotAt: EVALUATED_AT },
      symbolState: { available: true, exists: true, status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT", marginAsset: "USDT", minNotional: "5", hasFiltersSnapshot: true, hasBracketSnapshot: true },
    };
  }
  const ageMs = (ms: number) => ({ signalTriggeredAt: new Date(EVALUATED_AT.getTime() - ms) });
  const freshness = (result: ReturnType<typeof evaluateSafetyAdmission>) => result.failedChecks.filter((c) => c.reasonCode === "ALERT_STALE" || c.reasonCode === "SIGNAL_TIME_UNAVAILABLE");

  it("O. TradingView (no Native verdict): 300s old passes, 300.999s passes (whole seconds), 301s is ALERT_STALE, beyond the 5s future tolerance is SIGNAL_TIME_UNAVAILABLE", () => {
    expect(evaluateSafetyAdmission(input(ageMs(300 * S))).decision).toBe("PASS");
    expect(evaluateSafetyAdmission(input(ageMs(300 * S + 999))).decision).toBe("PASS");
    expect(evaluateSafetyAdmission(input(ageMs(301 * S)))).toMatchObject({ decision: "SKIP", reasonCode: "ALERT_STALE", signalAgeSeconds: 301 });
    expect(evaluateSafetyAdmission(input(ageMs(-5 * S))).decision).toBe("PASS");
    expect(evaluateSafetyAdmission(input(ageMs(-6 * S)))).toMatchObject({ decision: "SKIP", reasonCode: "SIGNAL_TIME_UNAVAILABLE" });
    expect(evaluateSafetyAdmission(input({ signalTriggeredAt: null }))).toMatchObject({ decision: "SKIP", reasonCode: "SIGNAL_TIME_UNAVAILABLE" });
  });

  it("Native fresh: no freshness failure even at 19 minutes old, which the 300s rule would refuse; the age is still reported", () => {
    const result = evaluateSafetyAdmission(input({ ...ageMs(19 * MIN), nativeSignalFreshness: { fresh: true } }));
    expect(result.decision).toBe("PASS");
    expect(result.signalAgeSeconds).toBe(19 * 60);
    expect(freshness(result)).toEqual([]);
  });

  it("Native stale is ALERT_STALE and Native unprovable/future is SIGNAL_TIME_UNAVAILABLE, both terminal, even when only seconds old", () => {
    const stale = evaluateSafetyAdmission(input({ ...ageMs(10 * S), nativeSignalFreshness: { fresh: false, reason: "STALE", message: "Native signal expired at X" } }));
    expect(stale).toMatchObject({ decision: "SKIP", reasonCode: "ALERT_STALE" });
    expect(freshness(stale)).toEqual([{ reasonCode: "ALERT_STALE", message: "Native signal expired at X." }]);
    for (const reason of ["TIME_IN_FUTURE", "EVIDENCE_INVALID"] as const) {
      const refused = evaluateSafetyAdmission(input({ ...ageMs(10 * S), nativeSignalFreshness: { fresh: false, reason, message: "m" } }));
      expect(refused, reason).toMatchObject({ decision: "SKIP", reasonCode: "SIGNAL_TIME_UNAVAILABLE" });
    }
    expect(classifySafetyReasonRetryability("ALERT_STALE")).toBe("TERMINAL");
    expect(classifySafetyReasonRetryability("SIGNAL_TIME_UNAVAILABLE")).toBe("TERMINAL");
  });

  it("a Native verdict wins over the TradingView rule in both directions, so the two rules can never be mixed for one execution", () => {
    // Fresh by 300s but Native-stale: refused. Stale by 300s but Native-fresh: not refused for age.
    expect(evaluateSafetyAdmission(input({ ...ageMs(S), nativeSignalFreshness: { fresh: false, reason: "STALE", message: "m" } })).reasonCode).toBe("ALERT_STALE");
    expect(freshness(evaluateSafetyAdmission(input({ ...ageMs(900 * S), nativeSignalFreshness: { fresh: true } })))).toEqual([]);
  });
});

// ===========================================================================
// R. Retries are deterministic
// ===========================================================================

describe("R. every retry, restart and site computes the same expiry", () => {
  it("the window depends only on persisted evidence: recomputed, re-derived from an execution's frozen time, or judged at any instant, the expiry is identical", () => {
    const alert = alertAt(SOURCE_BAR + 61_234);
    const first = nativeSignalWindowOf(alert);
    const again = nativeSignalWindowOf(structuredClone(alert));
    const fromExecution = nativeSignalWindowOf(alert, { signalTriggeredAt: new Date(alert.triggeredAt!.getTime()) });
    expect(again).toEqual(first);
    expect(fromExecution).toEqual(first);
    const expiries = [SOURCE_BAR + MIN, SOURCE_BAR_CLOSE, EXPIRY, EXPIRY + 1, EXPIRY + 60 * MIN].map((now) => verdictAt(alert, now).window?.expiresAtMs);
    expect(new Set(expiries)).toEqual(new Set([EXPIRY]));
  });

  it("the same instant always gives the same verdict, word for word, and the decision too", () => {
    const alert = alertAt(SOURCE_BAR + 61_234);
    expect(verdictAt(alert, EXPIRY + 1)).toEqual(verdictAt(alert, EXPIRY + 1));
    const input = favourableInput({}, { nowMs: EXPIRY + 1 });
    expect(decideNativeAccountACandidate(input)).toEqual(decideNativeAccountACandidate(structuredClone(input)));
  });

  it("verdicts are monotonic: fresh up to the expiry, stale at every instant after it", () => {
    const alert = alertAt(SOURCE_BAR + 61_234);
    const touch = alert.triggeredAt!.getTime();
    for (let now = touch; now <= EXPIRY + 10 * MIN; now += 7_919) {
      expect(reasonAt(alert, now), new Date(now).toISOString()).toBe(now <= EXPIRY ? "FRESH" : "STALE");
    }
  });
});

// ===========================================================================
// Structure: one canonical helper, every Native site converted, TradingView unchanged
// ===========================================================================

describe("structural proofs: the Native freshness helper is the only one, and TradingView's rule is untouched", () => {
  const productionCode = productionSources().map((rel) => ({ rel, code: codeOf(rel) }));
  const filesWith = (needle: string) => productionCode.filter((f) => f.code.includes(needle)).map((f) => f.rel).sort();

  it("the formula's constants and comparison live in ONE module, and only Native modules call it", () => {
    expect(filesWith("NATIVE_POST_CLOSE_FRESHNESS_MS")).toEqual(["src/modules/native-canary/native-signal-freshness.ts"]);
    expect(filesWith("NATIVE_ABSOLUTE_MAX_SIGNAL_AGE_MS")).toEqual(["src/modules/native-canary/native-signal-freshness.ts"]);
    // (Since M6 the adoption's deferral asks the canary's `nativeAdoptionDefers`, so it no longer names the helper.)
    expect(filesWith("judgeNativeSignalFreshness(")).toEqual([
      "src/modules/native-canary/native-account-a-canary.ts",
      "src/modules/native-canary/native-execution-fence.ts",
      "src/modules/native-canary/native-signal-freshness.ts",
    ]);
    expect(filesWith("nativeSignalLifetimeSpan(")).toEqual(["src/modules/native-canary/native-account-a-adoption.ts", "src/modules/native-canary/native-signal-freshness.ts"]);
    expect(filesWith("nativeExecutionSignalFreshness(")).toEqual([
      "src/modules/execution/entry-lifecycle.service.ts",
      "src/modules/execution/safety-admission.service.ts",
      "src/modules/native-canary/native-execution-fence.ts",
    ]);
    expect(filesWith("nativeAlertSignalFreshness(")).toEqual(["src/modules/execution/selected-plan-executor.ts", "src/modules/native-canary/native-execution-fence.ts"]);
  });

  it("the helper never reads a clock, the environment or processing time: its only time input is the caller's instant", () => {
    const code = codeOf("src/modules/native-canary/native-signal-freshness.ts");
    expect(code).not.toMatch(/Date\.now\(|new Date\(\)|performance\.now|process\.|\benv\b|config\/env|firstObservedAt|createdAt|receivedAt|updatedAt/);
    const imports = [...code.matchAll(/^import .*? from "([^"]+)";$/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(["../alerts/alert-source", "../native-alerts/native-delivery-policy", "../native-integrity/native-execution-integrity"]);
  });

  it("every Native site asks the helper before its first private read, and the adoption no longer uses the 300-second floor", () => {
    const adoption = codeOf("src/modules/native-canary/native-account-a-adoption.ts");
    expect(adoption).not.toContain("EXECUTION_MAX_ALERT_AGE_SECONDS");
    expect(adoption).toContain("cutoffAt: this.lifetimeWindow(now),");
    expect(adoption).toContain("if (preview !== null && nativeAdoptionDefers(preview, this.integrityOf(preview), clock().getTime())) {");

    const canary = codeOf("src/modules/native-canary/native-account-a-canary.ts");
    // The deferral: a forming bar waits only while its signal is fresh.
    const defers = canary.slice(canary.indexOf("export function nativeAdoptionDefers("), canary.indexOf("export function evaluateNativeAccountACandidate("));
    expect(defers).toContain('return integrity?.status === "PENDING_BAR_CLOSE" && judgeNativeSignalFreshness(nativeSignalWindowOf(alert), nowMs).fresh;');
    // The decision's FRESHNESS stage sits between PLAN and INTEGRITY, at the caller's instant.
    const evaluate = canary.slice(canary.indexOf("export function evaluateNativeAccountACandidate("), canary.indexOf("export interface NativeAccountAHandoff"));
    const stages = [
      "nativePlanStage(alert, plan, policy)",
      "nativeFreshnessStage(alert, input.nowMs)",
      "if (!freshness.ok) return freshness;",
      "nativeIntegrityStage(input.integrity)",
    ].map((n) => evaluate.indexOf(n));
    expect(stages.every((p) => p > -1)).toBe(true);
    expect([...stages].sort((a, b) => a - b)).toEqual(stages);
    const freshnessStage = canary.slice(canary.indexOf("export function nativeFreshnessStage("), canary.indexOf("export function nativeIntegrityStage("));
    expect(freshnessStage).toContain("judgeNativeSignalFreshness(nativeSignalWindowOf(alert), nowMs)");
    expect(freshnessStage).toContain('if (!freshness.fresh) return refusal("FRESHNESS", nativeSignalRefusalCodeOf(freshness)');

    const executor = codeOf("src/modules/execution/selected-plan-executor.ts");
    const native = executor.slice(executor.indexOf("async handleNativeAccountACandidate("));
    expect(native.indexOf("await nativeAlertSignalFreshness(this.deps.prisma, handoff.alertId, evaluatedAt)")).toBeGreaterThan(native.indexOf("await nativeAlertFence("));
    expect(native.indexOf("await nativeAlertSignalFreshness(")).toBeLessThan(native.indexOf("this.deps.marginPlanner.planForSymbolWithSnapshot("));

    const admission = codeOf("src/modules/execution/safety-admission.service.ts");
    const verdict = admission.indexOf("await nativeExecutionSignalFreshness(this.prisma, execution, input.evaluatedAt)");
    expect(verdict).toBeGreaterThan(-1);
    expect(verdict).toBeLessThan(admission.indexOf("await this.readBinanceState(execution.symbol)"));
    expect(admission).toMatch(/killSwitched \|\| nativeNotFresh\s*\n?\s*\? \{ binance: UNAVAILABLE_BINANCE, symbolState: UNAVAILABLE_SYMBOL \}/);
    expect(admission).toContain("...(nativeSignalFreshness === null ? {} : { nativeSignalFreshness }),");

    const entry = codeOf("src/modules/execution/entry-lifecycle.service.ts");
    const revalidate = entry.slice(entry.indexOf("private async revalidate("));
    expect(revalidate.indexOf("await nativeExecutionSignalFreshness(this.prisma, execution, input.evaluatedAt)")).toBeGreaterThan(-1);
    expect(revalidate.indexOf("await nativeExecutionSignalFreshness(")).toBeLessThan(revalidate.indexOf("await this.readOnly.getAccountSummary()"));
    const deadline = entry.slice(entry.indexOf("private async preflightDeadlinePassed("), entry.indexOf("private checkLiveGates("));
    expect(deadline).toContain("await nativeExecutionSignalFreshness(this.prisma, execution, evaluatedAt)");
    expect(deadline).toContain('!native.freshness.fresh && native.freshness.reason === "STALE"');
  });

  it("TradingView's rule is byte-for-byte where it was: the 300-second branch in revalidation, PREFLIGHT release, the engine and the TradingView adoption", () => {
    const entry = codeOf("src/modules/execution/entry-lifecycle.service.ts");
    expect(entry).toContain('return fail("SIGNAL_OR_ENTRY_DEADLINE_EXPIRED", "The original signal time is unknown.");');
    expect(entry).toContain("const ageSeconds = Math.floor((input.evaluatedAt.getTime() - execution.signalTriggeredAt.getTime()) / 1000);");
    expect(entry).toContain("if (ageSeconds > env.EXECUTION_MAX_ALERT_AGE_SECONDS) {");
    expect(entry).toContain("return fail(\"SIGNAL_OR_ENTRY_DEADLINE_EXPIRED\", `Signal is ${ageSeconds}s old.`);");
    expect(entry).toContain("const ageSeconds = Math.floor((evaluatedAt.getTime() - execution.signalTriggeredAt.getTime()) / 1000);");
    expect(entry).toContain("return `the signal is ${ageSeconds}s old, beyond the ${env.EXECUTION_MAX_ALERT_AGE_SECONDS}s limit`;");
    const engine = codeOf("src/modules/execution/safety-engine.ts");
    expect(engine).toContain("if (signalAgeSeconds < -policy.signalFutureToleranceSeconds) {");
    expect(engine).toContain("} else if (signalAgeSeconds > policy.maxAlertAgeSeconds) {");
    // The TradingView adoption pass knows nothing Native and still measures 300 seconds from triggeredAt.
    const tv = codeOf("src/modules/jobs/selected-plan-adoption.service.ts");
    expect(tv).not.toMatch(/native-canary|native-signal-freshness|nativeSignal|NATIVE_/);
    expect(tv).toContain("return new Date(now.getTime() - env.EXECUTION_MAX_ALERT_AGE_SECONDS * 1000);");
    // And only the files above changed their freshness behaviour: no other production file names the Native rule.
    expect(filesWith("native-signal-freshness").sort()).toEqual([
      "src/modules/execution/safety-admission.service.ts",
      "src/modules/execution/selected-plan-executor.ts",
      "src/modules/native-canary/native-account-a-adoption.ts",
      "src/modules/native-canary/native-account-a-canary.ts",
      "src/modules/native-canary/native-execution-fence.ts",
    ]);
  });

  it("the pure engine still imports nothing new and reads no clock", () => {
    const engine = codeOf("src/modules/execution/safety-engine.ts");
    expect([...engine.matchAll(/^import .*? from "([^"]+)";$/gm)].map((m) => m[1]).sort()).toEqual(["./capacity-status", "./take-profit-notional", "@prisma/client"]);
    expect(engine).not.toMatch(/Date\.now\(\)|new Date\(\)/);
  });
});

// ---------------------------------------------------------------------------

function codeOf(relative: string): string {
  return readFileSync(path.join(BACKEND, relative), "utf8")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function productionSources(dir = path.join(BACKEND, "src")): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return productionSources(full);
    return full.endsWith(".ts") ? [path.relative(BACKEND, full).split(path.sep).join("/")] : [];
  });
}
