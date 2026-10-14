import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_EXECUTION_INTEGRITY_STATUSES, parseNativeAccountPlanPolicy, type NativeExecutionIntegrityStatus } from "@trading-alert-dashboard/shared";

import {
  NATIVE_CANARY_REASON_CODES,
  NATIVE_CANARY_STAGES,
  assertNativeAccountAHandoff,
  decideNativeAccountACandidate,
  evaluateNativeAccountACandidate,
  judgeSameSymbolSideOccupancy,
  nativeRuntimeModeOf,
  nativeTradingStateOf,
  verifyNativeAccountAHandoff,
  type NativeCanaryInput,
  type NativeOccupancyRow,
} from "../src/modules/native-canary/native-account-a-canary";
import { nativeAccountSlotOf } from "../src/modules/native-canary/native-account-slot";
import { NATIVE_EXECUTION_ENABLED } from "../src/modules/native-canary/native-execution-switch";
import { evaluateNativeExecutionIntegrity } from "../src/modules/native-integrity/native-execution-integrity";
import { effectiveModeFromWire } from "../src/modules/operator/account-runtime-transition";
import { mapTradingSystemState } from "../src/modules/operator/trading-control.service";
import { bar } from "./helpers/native-alert-fixtures";
import {
  ACCOUNT_A_POLICY,
  ACCOUNT_B_POLICY,
  ARMED_PROFILE,
  CANARY_SYMBOL,
  LIVE_READY_GATES,
  SAFE_GATES,
  SOURCE_BAR,
  TEMPLATE,
  canaryAlert,
  candidateFor,
  cleanRecords,
  eligibleEvidence,
  evidenceOf,
  favourableInput,
  integrityDto,
  planFor,
  readerOf,
} from "./helpers/native-canary-fixtures";

/**
 * MILESTONE 4: the Native Account A canary, judged in isolation.
 *
 * Pure and structural only: no database, no scanner directory, no network,
 * no Binance client of any kind. The DB-backed half (durable adoption, the
 * creation fence, the entry-lifecycle final fence) is in
 * native-account-a-canary.integration.test.ts.
 *
 * The numbers in the test names are the milestone's required-test numbers.
 */

const BACKEND = path.resolve(__dirname, "..");

const decide = (input: NativeCanaryInput) => decideNativeAccountACandidate(input);
const refusalOf = (input: NativeCanaryInput) => {
  const decision = decide(input);
  if (decision.admitted) throw new Error("expected a refusal");
  return decision;
};

function row(over: Partial<NativeOccupancyRow> = {}): NativeOccupancyRow {
  return {
    id: "exec-1",
    alertId: "another-alert",
    symbol: CANARY_SYMBOL,
    status: "ENTRY_PENDING",
    direction: "LONG",
    positionSide: "LONG",
    requiresManualIntervention: false,
    entryOrders: [],
    ...over,
  };
}

// ===========================================================================
// The switch itself
// ===========================================================================

describe("the hard switch", () => {
  it("NATIVE_EXECUTION_ENABLED is false, in code", () => {
    expect(NATIVE_EXECUTION_ENABLED).toBe(false);
    const code = codeOf("src/modules/native-canary/native-execution-switch.ts");
    expect(code).toMatch(/export const NATIVE_EXECUTION_ENABLED = false as const;/);
    // A constant, not a reading: nothing in the module can change it.
    expect(code).not.toMatch(/process\.env|\benv\.|config\/env|import /);
  });
});

// ===========================================================================
// A. Native source + plan
// ===========================================================================

describe("A. Native source and plan", () => {
  it("1. a fully valid 1D candidate passes EVERY stage and structurally reaches the final admission, where the hard switch refuses it", () => {
    const input = favourableInput({ sourceTf: "1D" });
    const evaluated = evaluateNativeAccountACandidate(input);
    expect(evaluated.ok).toBe(true);
    expect(decide(input)).toEqual({
      admitted: false,
      stage: "NATIVE_FENCE",
      reasonCode: "NATIVE_EXECUTION_DISABLED",
      detail: "Every stage passed; Native execution is hard-disabled in code (NATIVE_EXECUTION_ENABLED = false).",
      integrity: "ELIGIBLE",
    });
  });

  it("1b. the same for a fully valid 1W candidate, and for a SHORT", () => {
    for (const options of [{ sourceTf: "1W" as const }, { sourceTf: "1D" as const, signal: "SHORT" as const }]) {
      const input = favourableInput(options);
      expect(evaluateNativeAccountACandidate(input).ok, JSON.stringify(options)).toBe(true);
      expect(refusalOf(input)).toMatchObject({ stage: "NATIVE_FENCE", reasonCode: "NATIVE_EXECUTION_DISABLED" });
    }
  });

  it("A1. Account A's plan is the candidate for ITS planner window (100 candles by default): a lookback, never a dollar amount", () => {
    const input = favourableInput();
    const evaluated = evaluateNativeAccountACandidate(input);
    if (!evaluated.ok) throw new Error(evaluated.refusal.detail);
    expect(ACCOUNT_A_POLICY).toMatchObject({ account: "A", state: "RESOLVED", lookback: 100, source: "BUILTIN_DEFAULT" });
    expect(evaluated.candidate.lookback).toBe(100);
    expect(evaluated.candidate.candidate).toEqual(candidateFor(100, "LONG"));
    // The risk budget is the plan's frozen template, untouched by the window.
    expect(evaluated.candidate.template).toEqual(TEMPLATE);
    expect(evaluated.candidate.template.riskAmount).toBe("1.50");
    // A valid override moves the WINDOW, and nothing else.
    const overridden = evaluateNativeAccountACandidate({ ...input, accountPlanPolicy: parseNativeAccountPlanPolicy("A", "50") });
    if (!overridden.ok) throw new Error(overridden.refusal.detail);
    expect([overridden.candidate.lookback, overridden.candidate.candidate.stopLoss]).toEqual([50, candidateFor(50, "LONG").stopLoss]);
    expect(overridden.candidate.template).toEqual(TEMPLATE);
  });

  it("2. Account B is refused at the first stage (and so are generic and unproven processes, and Account B's own policy)", () => {
    expect(refusalOf(favourableInput({}, { accountSlot: "ACCOUNT_B" }))).toMatchObject({ stage: "ACCOUNT", reasonCode: "ACCOUNT_NOT_A" });
    expect(refusalOf(favourableInput({}, { accountSlot: "GENERIC" }))).toMatchObject({ stage: "ACCOUNT", reasonCode: "ACCOUNT_NOT_A" });
    expect(refusalOf(favourableInput({}, { accountSlot: "UNKNOWN" }))).toMatchObject({ stage: "ACCOUNT", reasonCode: "AMBIGUOUS_STATE" });
    expect(refusalOf(favourableInput({}, { accountPlanPolicy: ACCOUNT_B_POLICY }))).toMatchObject({ stage: "ACCOUNT", reasonCode: "AMBIGUOUS_STATE" });
  });

  it("3. a non-NATIVE source is refused", () => {
    const input = favourableInput();
    for (const source of ["TRADINGVIEW", "native", "", null, undefined]) {
      expect(refusalOf({ ...input, alert: { ...input.alert, source } }), String(source)).toMatchObject({ stage: "SOURCE", reasonCode: "SOURCE_NOT_NATIVE" });
    }
  });

  it("4. a plan that is not READY is refused (PENDING, INVALID, ERROR, or no plan at all)", () => {
    const input = favourableInput();
    for (const status of ["PENDING", "INVALID", "ERROR"] as const) {
      expect(refusalOf({ ...input, plan: planFor(input.alert, { status }) }), status).toMatchObject({ stage: "PLAN", reasonCode: "PLAN_NOT_READY" });
    }
    expect(refusalOf({ ...input, plan: null })).toMatchObject({ stage: "PLAN", reasonCode: "PLAN_NOT_READY" });
  });

  it("5. an incomplete plan is refused: short history, no template, no money, no or invalid window candidate, no entry price", () => {
    const input = favourableInput();
    const withCandidate = (over: Parameters<typeof candidateFor>[2]) =>
      planFor(input.alert, { candidates: ([50, 100, 200, 300] as const).map((lb) => candidateFor(lb, "LONG", lb === 100 ? over : {})) });
    const cases: [string, NativeCanaryInput["plan"]][] = [
      ["short history", withCandidate({ complete: false, actualCandles: 61 })],
      ["no template", planFor(input.alert, { template: null })],
      ["no money", withCandidate({ money: null })],
      ["invalid candidate", withCandidate({ valid: false, invalidReason: "extreme on the wrong side", stopLoss: null, takeProfit: null })],
      ["no candidate for the window", planFor(input.alert, { candidates: [candidateFor(50, "LONG"), candidateFor(300, "LONG")] })],
      ["no entry price", planFor(input.alert, { entryPrice: "" })],
    ];
    for (const [name, plan] of cases) {
      expect(refusalOf({ ...input, plan }), name).toMatchObject({ stage: "PLAN", reasonCode: "PLAN_INCOMPLETE" });
    }
  });

  it("5b. the plan must be the alert's own, unambiguous, and resolvable for Account A", () => {
    const input = favourableInput();
    expect(refusalOf({ ...input, plan: planFor(input.alert, { alertId: "someone-else" }) })).toMatchObject({ stage: "PLAN", reasonCode: "PLAN_NOT_FOR_ALERT" });
    expect(refusalOf({ ...input, plan: planFor(input.alert, { alertSource: "TRADINGVIEW" }) })).toMatchObject({ stage: "PLAN", reasonCode: "AMBIGUOUS_STATE" });
    expect(refusalOf({ ...input, plan: planFor(input.alert, { direction: "SHORT" }) })).toMatchObject({ stage: "PLAN", reasonCode: "AMBIGUOUS_STATE" });
    const twice = planFor(input.alert, { candidates: [candidateFor(100, "LONG"), candidateFor(100, "LONG"), candidateFor(300, "LONG")] });
    expect(refusalOf({ ...input, plan: twice })).toMatchObject({ stage: "PLAN", reasonCode: "AMBIGUOUS_STATE" });
    // A mistyped override never falls back to the built-in 100.
    expect(refusalOf({ ...input, accountPlanPolicy: parseNativeAccountPlanPolicy("A", "100 ") })).toMatchObject({ stage: "PLAN", reasonCode: "ACCOUNT_PLAN_UNRESOLVED" });
  });

  it("6. a 1M source timeframe is refused", () => {
    const input = favourableInput({ sourceTf: "1M" });
    expect(input.alert.sourceTimeframe).toBe("1M");
    expect(refusalOf(input)).toMatchObject({ stage: "SOURCE_TIMEFRAME", reasonCode: "SOURCE_TF_NOT_EXECUTABLE" });
  });

  it("7. 3M, 6M and 12M source timeframes are refused", () => {
    // The 7% profile delivers only 1D/1W/1M to the dashboard (3M/6M/12M are
    // engine-only), so no real alert of these timeframes can exist today. A
    // hand-made row whose column and payload agree on the timeframe is the
    // strongest case: it is refused on the timeframe alone.
    const input = favourableInput();
    const payload = input.alert.rawPayload as { delivery: Record<string, unknown> };
    for (const sourceTf of ["3M", "6M", "12M"]) {
      const alert = { ...input.alert, sourceTimeframe: sourceTf, rawPayload: { ...payload, delivery: { ...payload.delivery, sourceTimeframe: sourceTf } } };
      expect(refusalOf({ ...input, alert }), sourceTf).toMatchObject({ stage: "SOURCE_TIMEFRAME", reasonCode: "SOURCE_TF_NOT_EXECUTABLE" });
    }
  });

  it("8. unknown, malformed and ambiguous source timeframes are refused (never normalised into 1D/1W)", () => {
    const input = favourableInput();
    for (const tf of ["1d", " 1D", "1D ", "1w", "4H", "15m", "", null, undefined, 1 as never]) {
      expect(refusalOf({ ...input, alert: { ...input.alert, sourceTimeframe: tf } }), String(tf)).toMatchObject({
        stage: "SOURCE_TIMEFRAME",
        reasonCode: "SOURCE_TF_NOT_EXECUTABLE",
      });
    }
    // The column and the durable payload must agree; disagreement is ambiguous, not a choice.
    const payload = input.alert.rawPayload as { delivery: Record<string, unknown> };
    const disagreeing = { ...input.alert, rawPayload: { ...payload, delivery: { ...payload.delivery, sourceTimeframe: "1W" } } };
    expect(refusalOf({ ...input, alert: disagreeing })).toMatchObject({ stage: "SOURCE_TIMEFRAME", reasonCode: "AMBIGUOUS_STATE" });
    const noPayload = { ...input.alert, rawPayload: { schema: "x" } };
    expect(refusalOf({ ...input, alert: noPayload })).toMatchObject({ stage: "SOURCE_TIMEFRAME", reasonCode: "AMBIGUOUS_STATE" });
  });
});

// ===========================================================================
// Integrity: only ELIGIBLE passes
// ===========================================================================

describe("integrity: only ELIGIBLE passes the integrity stage", () => {
  const records = cleanRecords();
  const alert = canaryAlert(records);
  const real = (ev: ReturnType<typeof evidenceOf>) => evaluateNativeExecutionIntegrity(alert, ev);

  it("9. ELIGIBLE, as the REAL evaluator derives it from durable scanner evidence, passes the integrity stage", () => {
    const verdict = real(eligibleEvidence(records));
    expect(verdict.status).toBe("ELIGIBLE");
    const input = favourableInput({}, { integrity: verdict });
    expect(evaluateNativeAccountACandidate(input).ok).toBe(true);
    expect(refusalOf(input).stage).toBe("NATIVE_FENCE");
  });

  // Each status is produced by the REAL evaluator from a real evidence shape,
  // then fed through the decision. The DTO-only twin below covers every status.
  const shapes: [string, NativeExecutionIntegrityStatus, () => ReturnType<typeof evidenceOf>][] = [
    ["10. PENDING_BAR_CLOSE (source bar still forming)", "PENDING_BAR_CLOSE", () => evidenceOf(records.slice(0, 2), SOURCE_BAR)],
    ["11. re-quarantined (the bar was finally committed as quarantined)", "INELIGIBLE_REQUARANTINED", () => evidenceOf([...records.slice(0, 2), cleanRecordsCommit("QUARANTINED_CURRENT_BAR")], bar(2))],
    ["12. gap (no committed bar before the source bar)", "INELIGIBLE_GAP", () => evidenceOf(records.slice(1), bar(2))],
    ["13. duplicate (the source bar committed twice)", "INELIGIBLE_DUPLICATE", () => evidenceOf([...records, records[2]], bar(2))],
    ["14. checkpoint mismatch (checkpoint behind the alert's own bar)", "INELIGIBLE_CHECKPOINT_MISMATCH", () => evidenceOf(records.slice(0, 2), bar(0))],
    ["15. stale generation (engine fingerprint no longer current)", "INELIGIBLE_STALE_GENERATION", () => evidenceOf(records, bar(2), CANARY_SYMBOL, { currentEngineFingerprint: "f".repeat(64) })],
    ["16. unreadable (no event log)", "UNREADABLE", () => evidenceOf(null, bar(2))],
  ];
  for (const [name, status, shape] of shapes) {
    it(`${name} is refused at the integrity stage`, () => {
      const verdict = real(shape());
      expect(verdict.status).toBe(status);
      const refusal = refusalOf(favourableInput({}, { integrity: verdict }));
      expect(refusal.stage).toBe("INTEGRITY");
      expect(refusal.integrity).toBe(status);
      expect(refusal.reasonCode).toBe(status === "PENDING_BAR_CLOSE" ? "INTEGRITY_PENDING_BAR_CLOSE" : status === "UNREADABLE" ? "INTEGRITY_UNREADABLE" : "INTEGRITY_INELIGIBLE");
    });
  }

  it("10-16b. every non-ELIGIBLE canonical status, a missing verdict and an unknown status are all refused", () => {
    for (const status of NATIVE_EXECUTION_INTEGRITY_STATUSES.filter((s) => s !== "ELIGIBLE")) {
      expect(refusalOf(favourableInput({}, { integrity: integrityDto(status) })), status).toMatchObject({ stage: "INTEGRITY", integrity: status });
    }
    expect(refusalOf(favourableInput({}, { integrity: null }))).toMatchObject({ stage: "INTEGRITY", reasonCode: "INTEGRITY_UNREADABLE", integrity: null });
    expect(refusalOf(favourableInput({}, { integrity: integrityDto("eligible" as never) }))).toMatchObject({ stage: "INTEGRITY", reasonCode: "INTEGRITY_UNREADABLE" });
  });
});

function cleanRecordsCommit(classification: "QUARANTINED_CURRENT_BAR" | "REPLAYED_NON_ACTIONABLE") {
  const [, , commit] = cleanRecords();
  return { ...commit, classification };
}

// ===========================================================================
// C. Occupancy: max one active/pending per symbol + side
// ===========================================================================

describe("C. same symbol + same side occupancy", () => {
  const LONG = { symbol: CANARY_SYMBOL, positionSide: "LONG" as const };

  it("17. a same-symbol, same-side pending LIMIT (ENTRY_PENDING) blocks", () => {
    expect(judgeSameSymbolSideOccupancy([row({ status: "ENTRY_PENDING" })], LONG)).toMatchObject({ occupied: true, reasonCode: "SAME_SYMBOL_SIDE_OCCUPIED", executionId: "exec-1" });
    expect(refusalOf(favourableInput({}, { occupancy: [row({ status: "ENTRY_PENDING" })] }))).toMatchObject({ stage: "OCCUPANCY", reasonCode: "SAME_SYMBOL_SIDE_OCCUPIED" });
  });

  it("18. a same-symbol, same-side active execution blocks, in every active or about-to-be-active status", () => {
    for (const status of ["PLAN_READY", "PREFLIGHT", "ENTRY_SUBMITTING", "PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION", "PROTECTED"]) {
      expect(judgeSameSymbolSideOccupancy([row({ status })], LONG), status).toMatchObject({ occupied: true, reasonCode: "SAME_SYMBOL_SIDE_OCCUPIED" });
    }
    // Symbol case and padding cannot hide a holder.
    expect(judgeSameSymbolSideOccupancy([row({ symbol: ` ${CANARY_SYMBOL.toLowerCase()} ` })], LONG).occupied).toBe(true);
  });

  it("19. a different symbol does not collide", () => {
    expect(judgeSameSymbolSideOccupancy([row({ symbol: "OTHERUSDT", status: "PROTECTED" })], LONG)).toEqual({ occupied: false });
    expect(evaluateNativeAccountACandidate(favourableInput({}, { occupancy: [row({ symbol: "OTHERUSDT" })] })).ok).toBe(true);
  });

  it("20. the opposite side does not collide under this rule", () => {
    const short = row({ direction: "SHORT", positionSide: "SHORT", status: "ENTRY_PENDING" });
    expect(judgeSameSymbolSideOccupancy([short], LONG)).toEqual({ occupied: false });
    expect(evaluateNativeAccountACandidate(favourableInput({}, { occupancy: [short] })).ok).toBe(true);
  });

  it("21. ambiguous or contradictory state fails closed, on either side", () => {
    const ambiguous: [string, readonly NativeOccupancyRow[] | null][] = [
      ["state could not be read", null],
      ["manual intervention (same side)", [row({ status: "MANUAL_INTERVENTION" })]],
      ["manual intervention (opposite side)", [row({ status: "MANUAL_INTERVENTION", direction: "SHORT", positionSide: "SHORT" })]],
      ["manual flag on a finished row", [row({ status: "CANCELED", requiresManualIntervention: true })]],
      ["one-way BOTH position side", [row({ positionSide: "BOTH" })]],
      ["direction disagrees with position side", [row({ direction: "SHORT", positionSide: "LONG" })]],
      ["unknown status", [row({ status: "SOMETHING_NEW" })]],
      ...(["SUBMITTING", "NEW", "PARTIALLY_FILLED", "UNKNOWN"] as const).map(
        (status): [string, NativeOccupancyRow[]] => [`finished row whose entry order is ${status}`, [row({ status: "CANCELED", entryOrders: [{ status, submissionUnknown: false }] })]]
      ),
      ["finished row whose entry submission was never resolved", [row({ status: "FAILED", entryOrders: [{ status: "CANCELED", submissionUnknown: true }] })]],
    ];
    for (const [name, rows] of ambiguous) {
      expect(judgeSameSymbolSideOccupancy(rows, LONG), name).toMatchObject({ occupied: true, reasonCode: "AMBIGUOUS_STATE" });
      expect(refusalOf(favourableInput({}, { occupancy: rows })), name).toMatchObject({ stage: "OCCUPANCY", reasonCode: "AMBIGUOUS_STATE" });
    }
    // Ambiguity outranks plain occupancy, and the verdict does not depend on row order.
    const mixed = [row({ id: "b", status: "PROTECTED" }), row({ id: "a", status: "MANUAL_INTERVENTION" })];
    expect(judgeSameSymbolSideOccupancy(mixed, LONG)).toMatchObject({ reasonCode: "AMBIGUOUS_STATE", executionId: "a" });
    expect(judgeSameSymbolSideOccupancy([...mixed].reverse(), LONG)).toEqual(judgeSameSymbolSideOccupancy(mixed, LONG));
  });

  it("22b. the candidate's OWN execution (same alert) is never its occupant, so a retry finds it instead of being refused by it", () => {
    const own = row({ alertId: "alert-x", status: "PLAN_READY" });
    expect(judgeSameSymbolSideOccupancy([own], { ...LONG, alertId: "alert-x" })).toEqual({ occupied: false });
    // Anyone else's execution, or one whose alert retention has nulled, still holds the slot.
    expect(judgeSameSymbolSideOccupancy([own], { ...LONG, alertId: "alert-y" })).toMatchObject({ occupied: true, reasonCode: "SAME_SYMBOL_SIDE_OCCUPIED" });
    expect(judgeSameSymbolSideOccupancy([row({ alertId: null, status: "PLAN_READY" })], { ...LONG, alertId: "alert-x" })).toMatchObject({ occupied: true });
    // And an ambiguous own row is skipped only because it is the candidate itself.
    expect(judgeSameSymbolSideOccupancy([row({ alertId: "alert-x", status: "MANUAL_INTERVENTION" })], { ...LONG, alertId: "alert-x" })).toEqual({ occupied: false });
  });

  it("21b. finished rows whose orders are provably finished are free", () => {
    for (const status of ["ENTRY_EXPIRED", "CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY", "CLOSED_EXTERNAL", "CANCELED", "SKIPPED", "FAILED"]) {
      expect(judgeSameSymbolSideOccupancy([row({ status, entryOrders: [{ status: "FILLED", submissionUnknown: false }, { status: "CANCELED", submissionUnknown: false }] })], LONG), status).toEqual({ occupied: false });
    }
  });
});

// ===========================================================================
// D. The existing deterministic Account A gates still apply
// ===========================================================================

describe("D. the existing Account A gates cannot be skipped", () => {
  it("24. not LIVE_READY or not ARMED refuses a candidate that is otherwise fully valid", () => {
    for (const environment of [SAFE_GATES, { globalKillSwitch: false, liveEntryEnabled: true, protectionReady: false }, { globalKillSwitch: "false", liveEntryEnabled: true, protectionReady: true }]) {
      expect(refusalOf(favourableInput({}, { accountGates: { environment, profile: ARMED_PROFILE } })), JSON.stringify(environment)).toMatchObject({
        stage: "ACCOUNT_GATES",
        reasonCode: "ACCOUNT_NOT_LIVE_READY",
      });
    }
    for (const profile of [null, { isEnabled: false, killSwitchActive: true }, { isEnabled: true, killSwitchActive: true }, { isEnabled: false, killSwitchActive: false }, { isEnabled: true, killSwitchActive: null }]) {
      expect(refusalOf(favourableInput({}, { accountGates: { environment: LIVE_READY_GATES, profile } })), JSON.stringify(profile)).toMatchObject({
        stage: "ACCOUNT_GATES",
        reasonCode: "ACCOUNT_NOT_ARMED",
      });
    }
  });

  it("24b. the gate vocabulary is the canonical one: identical to effectiveModeFromWire and mapTradingSystemState on every input", () => {
    const values = [true, false, null, undefined, "true"] as const;
    for (const kill of values) for (const live of values) for (const protection of values) {
      const environment = { globalKillSwitch: kill, liveEntryEnabled: live, protectionReady: protection };
      const canonical = effectiveModeFromWire({ environmentGates: environment });
      expect(nativeRuntimeModeOf(environment), JSON.stringify(environment)).toBe(canonical ?? "UNKNOWN");
    }
    for (const isEnabled of values) for (const killSwitchActive of values) {
      expect(nativeTradingStateOf({ isEnabled, killSwitchActive })).toBe(mapTradingSystemState(isEnabled as never, killSwitchActive as never));
    }
    expect(nativeTradingStateOf(null)).toBe("UNKNOWN");
  });
});

// ===========================================================================
// E. The hard fence and the hand-off capability
// ===========================================================================

describe("E. the hard fence", () => {
  it("25. Native disabled: the final refusal is NATIVE_EXECUTION_DISABLED and no hand-off exists anywhere in the decision", () => {
    const decision = decide(favourableInput());
    expect(decision).toMatchObject({ admitted: false, stage: "NATIVE_FENCE", reasonCode: "NATIVE_EXECUTION_DISABLED" });
    expect("handoff" in decision).toBe(false);
  });

  it("25b. a forged hand-off (structurally perfect, built outside the decision) is refused by every check", () => {
    const evaluated = evaluateNativeAccountACandidate(favourableInput());
    if (!evaluated.ok) throw new Error("fixture");
    const forged = Object.freeze({ kind: "NATIVE_ACCOUNT_A_HANDOFF", ...evaluated.candidate, integrity: "ELIGIBLE" });
    expect(verifyNativeAccountAHandoff(forged, { executionProfileId: "profile-account-a" })).toMatchObject({ ok: false, reasonCode: "HANDOFF_INVALID" });
    expect(() =>
      assertNativeAccountAHandoff(forged, {
        executionProfileId: "profile-account-a",
        alertId: evaluated.candidate.alertId,
        extremeRRPlanId: evaluated.candidate.planId,
        source: "NATIVE",
        symbol: evaluated.candidate.symbol,
        direction: evaluated.candidate.direction,
        selectedLookback: 100,
      })
    ).toThrow(/NATIVE alert/);
    for (const value of [null, undefined, {}, "handoff", 1]) {
      expect(verifyNativeAccountAHandoff(value, { executionProfileId: "x" }).ok).toBe(false);
    }
  });

  it("the decision is deterministic and does not mutate its input", () => {
    const input = favourableInput();
    const snapshot = JSON.stringify(input);
    const first = decide(input);
    expect(decide(input)).toEqual(first);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("the earliest failing stage is the one reported, in the documented order", () => {
    expect(NATIVE_CANARY_STAGES).toEqual(["ACCOUNT", "SOURCE", "SOURCE_TIMEFRAME", "PLAN", "INTEGRITY", "OCCUPANCY", "ACCOUNT_GATES", "NATIVE_FENCE"]);
    const everythingWrong = favourableInput({ sourceTf: "1M" }, {
      accountSlot: "ACCOUNT_B",
      plan: null,
      integrity: integrityDto("PENDING_BAR_CLOSE"),
      occupancy: null,
      accountGates: { environment: SAFE_GATES, profile: null },
    });
    expect(refusalOf(everythingWrong)).toMatchObject({ stage: "ACCOUNT", reasonCode: "ACCOUNT_NOT_A" });
    expect(refusalOf({ ...everythingWrong, accountSlot: "ACCOUNT_A" })).toMatchObject({ stage: "SOURCE_TIMEFRAME" });
    // Every code a refusal can carry is in the published catalogue.
    expect(new Set(NATIVE_CANARY_REASON_CODES).size).toBe(NATIVE_CANARY_REASON_CODES.length);
  });
});

// ===========================================================================
// Account identity
// ===========================================================================

describe("B. this process's account comes from its launch file, with no fallback", () => {
  const LOCAL = "C:\\Users\\someone\\AppData\\Local";
  const file = (alias: string) => path.join(LOCAL, "trading-alert-dashboard", "env", `${alias}.env`);

  it("only exactly account-a.env is Account A", () => {
    expect(nativeAccountSlotOf({ LOCALAPPDATA: LOCAL, DOTENV_CONFIG_PATH: file("account-a") })).toBe("ACCOUNT_A");
    expect(nativeAccountSlotOf({ LOCALAPPDATA: LOCAL, DOTENV_CONFIG_PATH: file("account-a").toUpperCase() })).toBe("ACCOUNT_A");
    expect(nativeAccountSlotOf({ LOCALAPPDATA: LOCAL, DOTENV_CONFIG_PATH: file("account-b") })).toBe("ACCOUNT_B");
    expect(nativeAccountSlotOf({ LOCALAPPDATA: LOCAL, DOTENV_CONFIG_PATH: file("generic") })).toBe("GENERIC");
  });

  it("anything else is UNKNOWN, never a default account", () => {
    for (const env of [
      {},
      { LOCALAPPDATA: LOCAL },
      { DOTENV_CONFIG_PATH: file("account-a") },
      { LOCALAPPDATA: LOCAL, DOTENV_CONFIG_PATH: "" },
      { LOCALAPPDATA: LOCAL, DOTENV_CONFIG_PATH: "C:\\elsewhere\\account-a.env" },
      { LOCALAPPDATA: LOCAL, DOTENV_CONFIG_PATH: file("account-c") },
      { LOCALAPPDATA: LOCAL, DOTENV_CONFIG_PATH: path.join(BACKEND, ".env") },
    ] as NodeJS.ProcessEnv[]) {
      expect(nativeAccountSlotOf(env), JSON.stringify(env)).toBe("UNKNOWN");
    }
  });
});

// ===========================================================================
// 28-30. Structure: TradingView untouched, every mutation fenced
// ===========================================================================

describe("28. TradingView is structurally untouched", () => {
  it("handleSelectedPlan names nothing Native-canary, and its own fence is still first", () => {
    const executor = codeOf("src/modules/execution/selected-plan-executor.ts");
    const tv = executor.slice(executor.indexOf("async handleSelectedPlan("), executor.indexOf("async handleNativeAccountACandidate("));
    expect(tv.indexOf("if (plan.alertSource !== EXECUTABLE_ALERT_SOURCE) {")).toBeGreaterThan(0);
    for (const native of ["nativeAlertFence", "Handoff", "handoff", "nativeFence", "NATIVE_EXECUTION_ENABLED", "native-canary"]) {
      expect(`${native}:${tv.includes(native)}`).toBe(`${native}:false`);
    }
  });

  it("creation keeps the original TradingView fence on every path that carries no hand-off, and marks only Native rows", () => {
    const execution = codeOf("src/modules/execution/execution.service.ts");
    const create = execution.slice(execution.indexOf("async createExecutionFromReadyPlan("), execution.indexOf("tx.tradeExecution.create("));
    const branch = create.slice(create.indexOf("const native = input.nativeAccountA !== undefined;"));
    expect(branch).toMatch(/if \(native\) \{\s+assertNativeAccountAHandoff\(input\.nativeAccountA, \{/);
    expect(branch).toMatch(/\} else \{\s+assertExecutableAlertSource\(\{ id: input\.alertId, source: alert\.source \}, "execution"\);\s+\}/);
    expect(execution).toContain("...(native ? { [NATIVE_EXECUTION_MARKER.key]: NATIVE_EXECUTION_MARKER.value } : {}),");
  });

  it("the TradingView adoption pass and the generic worker import nothing Native-canary", () => {
    for (const rel of ["src/modules/jobs/selected-plan-adoption.service.ts", "src/modules/jobs/vision-analysis.worker.ts", "src/modules/webhook/webhook.service.ts"]) {
      expect(`${rel}:${codeOf(rel).includes("native-canary")}`).toBe(`${rel}:false`);
    }
  });
});

describe("29/30. no Native path reaches a private mutation without the admission judgment, which sits immediately before it", () => {
  const entry = codeOf("src/modules/execution/entry-lifecycle.service.ts");

  it("30. EVERY exposure-increasing call site is preceded, with nothing awaited in between, by the Native final fence", () => {
    const sites = [...entry.matchAll(/this\.mutations\.authorizeLiveEntry\(\)/g)].map((m) => m.index!);
    expect(sites).toHaveLength(3);
    for (const site of sites) {
      const fence = entry.lastIndexOf("await this.nativeFenceRefusal(execution);", site);
      expect(fence).toBeGreaterThan(-1);
      const between = entry.slice(fence + "await this.nativeFenceRefusal(execution);".length, site);
      // Inside the same method, and the only await left is the mutation call itself.
      expect(between).not.toMatch(/private async |async [a-zA-Z]+\(/);
      expect(between.match(/\bawait\b/g) ?? []).toHaveLength(1);
      expect(between).toMatch(/await this\.mutations\.(setIsolatedMarginType|setInitialLeverage|submitLimitEntry)\($/);
    }
  });

  it("29. the fence also precedes revalidation's signed reads, the reservation, and configuration", () => {
    const prepare = entry.slice(entry.indexOf("async prepareEntrySubmission("), entry.indexOf("async resumeEntrySubmission("));
    const f0 = prepare.indexOf("await this.nativeFenceRefusal(target)");
    expect(f0).toBeGreaterThan(prepare.indexOf("const gate = this.checkLiveGates();"));
    expect(f0).toBeLessThan(prepare.indexOf("await this.revalidate(input)"));
    expect(f0).toBeLessThan(prepare.indexOf("await this.reserveEntryIntent(input)"));
    const resume = entry.slice(entry.indexOf("private async continueAfterReservation("), entry.indexOf("private async ensureIsolatedMargin("));
    const f2 = resume.indexOf("await this.nativeFenceRefusal(execution)");
    expect(f2).toBeGreaterThan(resume.indexOf("order.submissionUnknownAt !== null"));
    expect(f2).toBeLessThan(resume.indexOf("await this.ensureIsolatedMargin(execution)"));
    // The helper asks the fence module, which asks judgeNativeExecutionAdmission with the hard switch.
    const helper = entry.slice(entry.indexOf("private async nativeFenceRefusal("));
    const helperEnd = helper.search(/\r?\n {2}\}\r?\n/);
    expect(helperEnd).toBeGreaterThan(0);
    expect(helper.slice(0, helperEnd)).toContain("await nativeExecutionFence(this.prisma, execution, this.nativeFence);");
    const fence = codeOf("src/modules/native-canary/native-execution-fence.ts");
    expect(fence.match(/judgeNativeExecutionAdmission\(\{ nativeExecutionEnabled: NATIVE_EXECUTION_ENABLED, integrity/g)).toHaveLength(2);
  });

  it("29b. the executor's Native entry point fences before its first signed request, and reaches execution only through the existing machinery", () => {
    const executor = codeOf("src/modules/execution/selected-plan-executor.ts");
    const native = executor.slice(executor.indexOf("async handleNativeAccountACandidate("));
    const order = ["verifyNativeAccountAHandoff(", "await nativeAlertFence(", "this.deps.marginPlanner.planForSymbolWithSnapshot(", "this.deps.executions.createExecutionFromReadyPlan(", "this.deps.orchestrator.admitAndSubmit({ executionId })"];
    const positions = order.map((needle) => native.indexOf(needle));
    expect(positions.every((p) => p > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(native).toContain("if (!fence.admitted) return");
    // No canary pre-check, no claim, and no way around Phase 5 or the entry lifecycle.
    for (const absent of ["executionCanaryAuthorization", "allowDisabledProfile", "prepareEntrySubmission", "evaluateAndReserveSafetyAdmission", "mutations"]) {
      expect(`${absent}:${native.includes(absent)}`).toBe(`${absent}:false`);
    }
  });

  it("29c. a hand-off is issued in exactly one place, only after the judgment admits", () => {
    const canary = codeOf("src/modules/native-canary/native-account-a-canary.ts");
    expect(canary.match(/issueHandoff\(/g)).toHaveLength(2); // the definition and its one call
    const decideBody = canary.slice(canary.indexOf("export function decideNativeAccountACandidate("));
    const judge = decideBody.indexOf("judgeNativeExecutionAdmission({ nativeExecutionEnabled: NATIVE_EXECUTION_ENABLED");
    const refuse = decideBody.indexOf("if (!admission.admitted) {");
    const issue = decideBody.indexOf("issueHandoff(evaluated.candidate)");
    expect(judge).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(judge);
    expect(issue).toBeGreaterThan(refuse);
    expect(canary).not.toMatch(/export function issueHandoff/);
  });

  it("29d. only the entry lifecycle (and the standalone TESTNET verifier, which takes no alert) can reach an exposure-increasing call", () => {
    const callers = productionSources().filter((rel) => rel !== "src/modules/binance/binance-execution.client.ts" && /\.(submitLimitEntry|setInitialLeverage|setIsolatedMarginType)\(|authorizeLiveEntry\(\)/.test(codeOf(rel)));
    expect(callers.sort()).toEqual(["src/modules/binance/testnet-verifier/testnet-verifier.ts", "src/modules/execution/entry-lifecycle.service.ts"]);
    const verifier = codeOf("src/modules/binance/testnet-verifier/testnet-verifier.ts");
    expect(verifier).not.toMatch(/alerts\/|extreme-rr|native-|selected-plan|adoption/);
  });

  it("the Native modules perform no exchange I/O of their own and add no route, UI control or migration", () => {
    const dir = path.join(BACKEND, "src/modules/native-canary");
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["native-account-a-adoption.ts", "native-account-a-canary.ts", "native-account-slot.ts", "native-execution-fence.ts", "native-execution-switch.ts", "native-occupancy.ts"]);
    for (const file of files) {
      // The only raw SQL is the occupancy module's own advisory lock, checked below.
      const code = codeOf(`src/modules/native-canary/${file}`).replace(/\$executeRaw`SELECT pg_advisory_xact_lock\(\$\{NATIVE_OCCUPANCY_LOCK_NAMESPACE\}::int, /g, "");
      expect({ file, hit: code.match(/binance|fetch\(|fastify|\.post\(|\.get\("\/|createHmac|X-MBX|BINANCE_API|apiSecret|\$executeRaw|\$queryRaw|writeFile|appendFile/i)?.[0] ?? null }).toEqual({ file, hit: null });
    }
    const app = readFileSync(path.join(BACKEND, "src/app.ts"), "utf8");
    expect(app).not.toContain("native-canary");
  });
});

// ===========================================================================
// Pre-merge audit: the serialization point and the plan-authoritative window
// ===========================================================================

describe("pre-merge audit: (account, symbol, side) is serialized where occupancy is established", () => {
  it("Q1. exactly one production module creates a TradeExecution, and its Native branch reserves the slot under the keyed lock INSIDE the creating transaction, before the insert", () => {
    const creators = productionSources().filter((rel) => /tradeExecution\.(create|createMany|upsert)\(/.test(codeOf(rel)));
    expect(creators).toEqual(["src/modules/execution/execution.service.ts"]);
    const execution = codeOf("src/modules/execution/execution.service.ts");
    const create = execution.slice(execution.indexOf("async createExecutionFromReadyPlan("), execution.indexOf("private resolveSelectedLookback("));
    const tx = create.indexOf("return this.prisma.$transaction(async (tx) => {");
    const reserve = create.indexOf("await reserveNativeOccupancy(tx, {");
    const insert = create.indexOf("await tx.tradeExecution.create({");
    expect(tx).toBeGreaterThan(-1);
    expect(reserve).toBeGreaterThan(tx);
    expect(insert).toBeGreaterThan(reserve);
    // Guarded by the Native hand-off alone, with nothing else in between.
    expect(create.slice(tx + "return this.prisma.$transaction(async (tx) => {".length, reserve)).toMatch(/^\s*if \(native\) \{\s*$/);
  });

  it("Q1. the lock is transaction-scoped, keyed by profile + symbol + side, in a namespace no other lock uses, and the occupancy re-read follows it", () => {
    const occupancy = codeOf("src/modules/native-canary/native-occupancy.ts");
    const body = occupancy.slice(occupancy.indexOf("export async function reserveNativeOccupancy("));
    const lock = body.indexOf("pg_advisory_xact_lock(${NATIVE_OCCUPANCY_LOCK_NAMESPACE}::int, ${nativeOccupancyLockKey(");
    const read = body.indexOf("await loadNativeOccupancyRows(tx,");
    const judge = body.indexOf("judgeSameSymbolSideOccupancy(rows,");
    expect(lock).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(lock);
    expect(judge).toBeGreaterThan(read);
    const namespaces = productionSources().flatMap((rel) => [...codeOf(rel).matchAll(/const (\w*LOCK_NAMESPACE) = (0x[0-9a-f]+);/gi)].map((m) => m[2].toLowerCase()));
    expect(namespaces).toContain("0xa7e1");
    expect(new Set(namespaces).size).toBe(namespaces.length);
  });

  it("Q1. no alternate Native entry point: only the Native adoption calls the executor's Native method, and only creation reserves the slot", () => {
    expect(productionSources().filter((rel) => codeOf(rel).includes(".handleNativeAccountACandidate("))).toEqual(["src/modules/native-canary/native-account-a-adoption.ts"]);
    expect(productionSources().filter((rel) => codeOf(rel).includes("reserveNativeOccupancy(")).sort()).toEqual([
      "src/modules/execution/execution.service.ts",
      "src/modules/native-canary/native-occupancy.ts",
    ]);
    // The executor turns a lost race into a terminal refusal, before admission.
    const executor = codeOf("src/modules/execution/selected-plan-executor.ts");
    const native = executor.slice(executor.indexOf("async handleNativeAccountACandidate("));
    expect(native.indexOf("if (error instanceof NativeOccupancyConflictError) {")).toBeGreaterThan(-1);
    expect(native.indexOf("if (error instanceof NativeOccupancyConflictError) {")).toBeLessThan(native.indexOf("this.deps.orchestrator.admitAndSubmit("));
  });
});

// ===========================================================================
// The adoption scheduler is dormant
// ===========================================================================

describe("the Native Account A adoption scheduler is dormant", () => {
  it("starts nothing, touches nothing and returns null for Account A, Account B and an unknown process", async () => {
    const { startNativeAccountAAdoptionScheduler } = await import("../src/modules/native-canary/native-account-a-adoption");
    const touched: string[] = [];
    const trap = (name: string) => new Proxy({}, { get: (_t, key) => (touched.push(`${name}.${String(key)}`), () => { throw new Error(`${name} reached`); }) });
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const LOCAL = "C:\\Users\\someone\\AppData\\Local";
    for (const alias of ["account-a", "account-b", "generic", "nothing"]) {
      const timer = await startNativeAccountAAdoptionScheduler({
        prisma: trap("prisma") as never,
        boundProfile: { executionProfileId: "p", exchange: "BINANCE", product: "USDM_FUTURES", environment: "TESTNET" } as never,
        executor: trap("executor") as never,
        plans: trap("plans") as never,
        workerId: "w",
        processEnv: { LOCALAPPDATA: LOCAL, DOTENV_CONFIG_PATH: path.join(LOCAL, "trading-alert-dashboard", "env", `${alias}.env`) },
      });
      expect(timer, alias).toBeNull();
    }
    expect(setInterval).not.toHaveBeenCalled();
    expect(touched).toEqual([]);
    setInterval.mockRestore();
  });

  it("the worker wires it only through that starter, and clears it on shutdown", () => {
    const worker = codeOf("src/modules/jobs/execution.worker.ts");
    expect(worker.match(/startNativeAccountAAdoptionScheduler\(/g)).toHaveLength(1);
    expect(worker).toContain("if (nativeAdoptionTimer !== null) clearInterval(nativeAdoptionTimer);");
    expect(worker).not.toMatch(/NativeAccountAAdoptionService|decideNativeAccountACandidate|nativeAccountSlotOf/);
    const adoption = codeOf("src/modules/native-canary/native-account-a-adoption.ts");
    const starter = adoption.slice(adoption.indexOf("export async function startNativeAccountAAdoptionScheduler("));
    expect(starter.indexOf("if (!NATIVE_EXECUTION_ENABLED) return null;")).toBeGreaterThan(-1);
    expect(starter.indexOf("if (!NATIVE_EXECUTION_ENABLED) return null;")).toBeLessThan(starter.indexOf("new NativeAccountAAdoptionService("));
    expect(starter.indexOf('if (accountSlot !== "ACCOUNT_A") return null;')).toBeLessThan(starter.indexOf("new NativeAccountAAdoptionService("));
  });
});

// ===========================================================================
// Mutation sensitivity: the refusal really is the switch
// ===========================================================================

describe("mutation sensitivity (the switch is what refuses; the tests above are not vacuous)", () => {
  afterEach(() => {
    vi.doUnmock("../src/modules/native-canary/native-execution-switch");
    vi.resetModules();
  });

  it("with the switch mutated to true in a TEST module graph, the same favourable input is admitted with a verifiable hand-off; nothing else changes", async () => {
    vi.resetModules();
    vi.doMock("../src/modules/native-canary/native-execution-switch", () => ({ NATIVE_EXECUTION_ENABLED: true }));
    const mutated = await import("../src/modules/native-canary/native-account-a-canary");
    const input = favourableInput();
    const decision = mutated.decideNativeAccountACandidate(input);
    if (!decision.admitted) throw new Error(`expected admission, got ${decision.reasonCode}`);
    expect(decision.handoff).toMatchObject({ kind: "NATIVE_ACCOUNT_A_HANDOFF", lookback: 100, integrity: "ELIGIBLE", symbol: CANARY_SYMBOL, direction: "LONG" });
    expect(Object.isFrozen(decision.handoff) && Object.isFrozen(decision.handoff.candidate)).toBe(true);
    expect(mutated.verifyNativeAccountAHandoff(decision.handoff, { executionProfileId: "profile-account-a" }).ok).toBe(true);
    // A hand-off from the mutated graph is still nothing to the REAL module.
    expect(verifyNativeAccountAHandoff(decision.handoff, { executionProfileId: "profile-account-a" }).ok).toBe(false);
    // Every other stage still refuses exactly as before.
    expect(mutated.decideNativeAccountACandidate({ ...input, accountSlot: "ACCOUNT_B" })).toMatchObject({ admitted: false, reasonCode: "ACCOUNT_NOT_A" });
    expect(mutated.decideNativeAccountACandidate({ ...input, integrity: integrityDto("PENDING_BAR_CLOSE") })).toMatchObject({ admitted: false, reasonCode: "INTEGRITY_PENDING_BAR_CLOSE" });
  });

  it("with the switch mutated to true, the executor's Native entry point still asks the fence first, and the first dependency it would reach is the signed margin planner", async () => {
    vi.resetModules();
    vi.doMock("../src/modules/native-canary/native-execution-switch", () => ({ NATIVE_EXECUTION_ENABLED: true }));
    const canary = await import("../src/modules/native-canary/native-account-a-canary");
    const { SelectedPlanExecutor } = await import("../src/modules/execution/selected-plan-executor");
    const records = cleanRecords();
    const input = favourableInput();
    const decision = canary.decideNativeAccountACandidate(input);
    if (!decision.admitted) throw new Error("fixture");
    const touched: string[] = [];
    const trap = (name: string) => new Proxy({}, { get: (_t, key) => (touched.push(`${name}.${String(key)}`), () => { throw new Error(`${name} reached`); }) });
    // Ineligible evidence at the executor's fence: refused there, before anything signed.
    const prisma = { alert: { findUnique: async () => ({ source: "NATIVE", symbol: input.alert.symbol, rawPayload: input.alert.rawPayload }) } };
    const executor = (reader: ReturnType<typeof readerOf>) =>
      new SelectedPlanExecutor({
        prisma: prisma as never,
        marginPlanner: trap("marginPlanner") as never,
        executions: trap("executions") as never,
        orchestrator: trap("orchestrator") as never,
        boundProfile: { executionProfileId: "profile-account-a", exchange: "BINANCE", product: "USDM_FUTURES", environment: "TESTNET" } as never,
        nativeFence: { evidence: reader },
      });
    const pending = await executor(readerOf(evidenceOf(records.slice(0, 2), SOURCE_BAR))).handleNativeAccountACandidate(decision.handoff);
    expect(pending).toMatchObject({ handled: false, reasonCode: "NATIVE_INTEGRITY_NOT_ELIGIBLE" });
    expect(touched).toEqual([]);
    // Eligible evidence: the fence admits and the very next thing is the signed planner (a trap here).
    await expect(executor(readerOf(eligibleEvidence(records))).handleNativeAccountACandidate(decision.handoff)).rejects.toThrow("marginPlanner reached");
    expect(touched).toEqual(["marginPlanner.planForSymbolWithSnapshot"]);
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
