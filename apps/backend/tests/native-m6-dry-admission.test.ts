import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionCanaryAuthorization } from "@prisma/client";

import {
  NATIVE_CANARY_STAGES,
  assertNativeAccountAHandoff,
  decideNativeAccountACandidate,
  nativeAccountAExecutionPolicy,
  nativeAccountGatesStage,
  nativeAccountStage,
  nativeCanaryIntegrityOf,
  nativeFenceStage,
  nativeFreshnessStage,
  nativeIntegrityStage,
  nativeOccupancyStage,
  nativePlanStage,
  nativeRiskStage,
  nativeSourceStage,
  nativeSourceTimeframeStage,
  verifyNativeAccountAHandoff,
  type NativeCanaryInput,
  type NativeCanaryStage,
  type NativeOccupancyRow,
} from "../src/modules/native-canary/native-account-a-canary";
import {
  NATIVE_DRY_ADMISSION_POLICY,
  NATIVE_DRY_DOWNSTREAM_STAGES,
  evaluateNativeDryAdmission,
  type NativeDryAdmission,
  type NativeDryAdmissionSnapshot,
  type NativeDryNaturalWindow,
  type NativeDryPhase5Facts,
} from "../src/modules/native-canary/native-dry-admission";
import { NATIVE_EXECUTION_ENABLED } from "../src/modules/native-canary/native-execution-switch";
import { NATIVE_RISK_CONTRACTS } from "../src/modules/native-canary/native-risk-contract";
import { judgeNativeSignalFreshness, nativeSignalWindowOf } from "../src/modules/native-canary/native-signal-freshness";
import { NativeAlertExecutionForbiddenError } from "../src/modules/alerts/alert-source";
import type { SessionReservationFacts } from "../src/modules/execution/trading-session";
import { bar } from "./helpers/native-alert-fixtures";
import {
  ACCOUNT_A_POLICY,
  ACCOUNT_B_POLICY,
  ARMED_PROFILE,
  CANARY_SYMBOL,
  ENTRY_PRICE,
  FRESH_NOW_MS,
  LIVE_READY_GATES,
  RISK_CONTRACT_MODULE,
  SAFE_GATES,
  SOURCE_BAR,
  SOURCE_BAR_CLOSE,
  TEMPLATE,
  UNRESOLVED_B,
  canaryAlert,
  candidateFor,
  cleanRecords,
  eligibleEvidence,
  evidenceOf,
  planFor,
  resolvedAContracts,
  type FixtureOptions,
} from "./helpers/native-canary-fixtures";

/**
 * MILESTONE 6: NATIVE_DRY_ADMISSION_V1, judged in isolation.
 *
 * Pure only: no database, no scanner directory, no network, no exchange
 * client. Every case is a deterministic snapshot built with the real
 * scanner -> delivery -> alert-draft pipeline, and every authoritative
 * verdict is compared with the PRODUCTION decision for the same facts
 * (`decideNativeAccountACandidate`, fed the way the adoption pass feeds it).
 *
 * The switch-on and resolved-risk graphs below are TEST-ONLY module graphs
 * (vi.doMock); the production constants are never touched.
 *
 * The traps (signing, network, file system, database, queue) and the real
 * executor/creation/adoption are in native-m6-dry-admission.integration
 * .test.ts; the import-closure audit is in native-m6-dry-admission
 * -structure.test.ts.
 */

const SWITCH = "../src/modules/native-canary/native-execution-switch";
const DRY = "../src/modules/native-canary/native-dry-admission";
const CANARY = "../src/modules/native-canary/native-account-a-canary";
const ALERT_SOURCE = "../src/modules/alerts/alert-source";

const PROFILE = "profile-account-a";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The fixture alert's Native expiry: its 15m bar's close + 5 minutes (the 20-minute cap does not bind). */
const EXPIRY = SOURCE_BAR_CLOSE + 5 * MIN;

afterEach(() => {
  vi.doUnmock(SWITCH);
  vi.doUnmock(RISK_CONTRACT_MODULE);
  vi.resetModules();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

function naturalWindow(over: Partial<ExecutionCanaryAuthorization> = {}): NativeDryNaturalWindow {
  return {
    id: "window-1",
    executionProfileId: PROFILE,
    authorizationType: "NATURAL_WINDOW",
    allowedSymbol: null,
    allowedDirection: null,
    tokenHash: null,
    allowedDirections: ["LONG", "SHORT"],
    tradingSessionId: "session-1",
    maxClaims: 5,
    claimedCount: 0,
    version: 1,
    expiresAt: new Date(FRESH_NOW_MS + DAY),
    createdAt: new Date(FRESH_NOW_MS - DAY),
    consumedAt: null,
    consumedAlertId: null,
    consumedExecutionId: null,
    revokedAt: null,
    ...over,
  } as NativeDryNaturalWindow;
}

function tradingSession(over: Partial<SessionReservationFacts> = {}): SessionReservationFacts {
  return {
    id: "session-1",
    executionProfileId: PROFILE,
    status: "ACTIVE",
    expiresAt: new Date(FRESH_NOW_MS + DAY),
    tradeBudget: 3,
    unlimited: false,
    openedCount: 0,
    reservedCount: 0,
    ...over,
  };
}

function phase5(over: Partial<NativeDryPhase5Facts> = {}): NativeDryPhase5Facts {
  return { authorizationCount: 1, exactBindingId: null, newestNaturalWindow: naturalWindow(), session: tradingSession(), ...over };
}

/** Every fact favourable at FRESH_NOW: Account A, ELIGIBLE evidence, LIVE_READY + ARMED, an open session-backed window. */
function snapshot(options: FixtureOptions = {}, over: Partial<NativeDryAdmissionSnapshot> = {}): NativeDryAdmissionSnapshot {
  const records = cleanRecords(options);
  const alert = canaryAlert(records, options);
  return {
    accountSlot: "ACCOUNT_A",
    executionProfileId: PROFILE,
    alert,
    plan: planFor(alert),
    accountPlanPolicy: ACCOUNT_A_POLICY,
    scannerEvidence: eligibleEvidence(records, options.symbol),
    occupancy: [],
    accountGates: { environment: LIVE_READY_GATES, profile: ARMED_PROFILE },
    phase5: phase5(),
    nowMs: FRESH_NOW_MS,
    ...over,
  };
}

/** The same snapshot with the source bar's scanner evidence replaced. */
function withEvidence(shape: (records: ReturnType<typeof cleanRecords>) => NativeDryAdmissionSnapshot["scannerEvidence"], over: Partial<NativeDryAdmissionSnapshot> = {}) {
  const records = cleanRecords();
  return snapshot({}, { scannerEvidence: shape(records), ...over });
}

/** A deep copy of the alert with its payload (and row trigger instant) edited. */
function editedAlert(s: NativeDryAdmissionSnapshot, edit: (payload: Record<string, any>, row: { triggeredAt: Date | null | undefined }) => void): NativeDryAdmissionSnapshot {
  const payload = structuredClone(s.alert.rawPayload) as Record<string, any>;
  const row = { triggeredAt: s.alert.triggeredAt };
  edit(payload, row);
  return { ...s, alert: { ...s.alert, rawPayload: payload, triggeredAt: row.triggeredAt } };
}

function row(over: Partial<NativeOccupancyRow> = {}): NativeOccupancyRow {
  return {
    id: "exec-1",
    alertId: "another-alert",
    symbol: CANARY_SYMBOL,
    status: "ENTRY_PENDING",
    direction: "LONG",
    positionSide: "LONG",
    requiresManualIntervention: false,
    entryOrders: [{ status: "NEW", submissionUnknown: false }],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The production oracle
// ---------------------------------------------------------------------------

type CanaryModule = typeof import("../src/modules/native-canary/native-account-a-canary");
type DryModule = typeof import("../src/modules/native-canary/native-dry-admission");
const PRODUCTION = {
  canary: {
    decideNativeAccountACandidate,
    verifyNativeAccountAHandoff,
    assertNativeAccountAHandoff,
    nativeCanaryIntegrityOf,
    nativeAccountStage,
    nativeSourceStage,
    nativeSourceTimeframeStage,
    nativePlanStage,
    nativeFreshnessStage,
    nativeIntegrityStage,
    nativeOccupancyStage,
    nativeAccountGatesStage,
    nativeFenceStage,
    nativeRiskStage,
  } as unknown as CanaryModule,
  dry: { evaluateNativeDryAdmission } as unknown as DryModule,
  Forbidden: NativeAlertExecutionForbiddenError,
};
type Graph = typeof PRODUCTION;

/**
 * A TEST-ONLY module graph: the hard switch on and, optionally, a synthetic
 * Native risk contract table. Nothing outside this graph sees either.
 */
async function testGraph(contracts?: () => unknown): Promise<Graph> {
  vi.resetModules();
  vi.doMock(SWITCH, () => ({ NATIVE_EXECUTION_ENABLED: true }));
  if (contracts) vi.doMock(RISK_CONTRACT_MODULE, contracts);
  return { canary: await import(CANARY), dry: await import(DRY), Forbidden: (await import(ALERT_SOURCE)).NativeAlertExecutionForbiddenError };
}

const syntheticA = (maxRiskPerTradeUsd: string) => () => ({
  NATIVE_RISK_CONTRACTS: Object.freeze({ A: Object.freeze({ state: "RESOLVED", account: "A", maxRiskPerTradeUsd }), B: UNRESOLVED_B }),
});

/** Exactly what the adoption pass feeds the production decision for the same facts. */
function productionInputOf(s: NativeDryAdmissionSnapshot, graph: Graph = PRODUCTION): NativeCanaryInput {
  const evidence = s.scannerEvidence;
  return {
    accountSlot: s.accountSlot,
    executionProfileId: s.executionProfileId,
    alert: s.alert,
    plan: s.plan,
    accountPlanPolicy: s.accountPlanPolicy,
    integrity: graph.canary.nativeCanaryIntegrityOf(s.alert, evidence === null ? null : () => evidence),
    occupancy: s.occupancy,
    accountGates: s.accountGates,
    nowMs: s.nowMs,
  };
}

/** The adoption pass's deferral, re-derived from its definition. */
function defers(s: NativeDryAdmissionSnapshot): boolean {
  return productionInputOf(s).integrity?.status === "PENDING_BAR_CLOSE" && judgeNativeSignalFreshness(nativeSignalWindowOf(s.alert), s.nowMs).fresh;
}

/** One stage's production kernel, judged alone, on the facts the dry admission was given. */
function kernel(stage: NativeCanaryStage, s: NativeDryAdmissionSnapshot, graph: Graph = PRODUCTION) {
  const c = graph.canary;
  const integrity = productionInputOf(s, graph).integrity;
  const side = s.plan?.direction === "LONG" || s.plan?.direction === "SHORT" ? s.plan.direction : null;
  switch (stage) {
    case "ACCOUNT":
      return c.nativeAccountStage(s.accountSlot, s.accountPlanPolicy);
    case "SOURCE":
      return c.nativeSourceStage(s.alert);
    case "SOURCE_TIMEFRAME":
      return c.nativeSourceTimeframeStage(s.alert);
    case "PLAN":
      return c.nativePlanStage(s.alert, s.plan, s.accountPlanPolicy);
    case "FRESHNESS":
      return c.nativeFreshnessStage(s.alert, s.nowMs);
    case "INTEGRITY":
      return c.nativeIntegrityStage(integrity);
    case "OCCUPANCY":
      return side === null ? null : c.nativeOccupancyStage(s.occupancy, { symbol: s.alert.symbol, positionSide: side, alertId: s.alert.id });
    case "ACCOUNT_GATES":
      return c.nativeAccountGatesStage(s.accountGates);
    case "NATIVE_FENCE":
      return c.nativeFenceStage(integrity);
    case "RISK":
      return c.nativeRiskStage(s.accountSlot, s.plan?.template?.riskAmount);
  }
}

const diag = (r: NativeDryAdmission, stage: string) => {
  const found = r.diagnostics.find((d) => d.stage === stage);
  if (found === undefined) throw new Error(`no ${stage} diagnostic`);
  return found;
};

const AUTHORITATIVE_KEYS = ["admitted", "adoption", "detail", "integrity", "passedStages", "reason", "terminalStage"];
const DIAGNOSTIC_KEYS = ["authoritative", "detail", "reason", "stage", "status"];

/**
 * The dry result for `s`, after proving it is the production verdict:
 *  - authoritative == the production decision for the same facts, field by field;
 *  - every passed stage's kernel passes and the terminal one refuses with that code;
 *  - each tail diagnostic is exactly its stage's kernel, judged alone;
 *  - the shape is the documented one, deep-frozen, authority NONE, and it
 *    never verifies as a hand-off.
 */
function dryWithParity(s: NativeDryAdmissionSnapshot, graph: Graph = PRODUCTION): NativeDryAdmission {
  const r = graph.dry.evaluateNativeDryAdmission(s);
  const decision = graph.canary.decideNativeAccountACandidate(productionInputOf(s, graph));
  const terminal = decision.admitted ? null : decision;
  const passed = terminal === null ? [...NATIVE_CANARY_STAGES] : NATIVE_CANARY_STAGES.slice(0, NATIVE_CANARY_STAGES.indexOf(terminal.stage));

  expect(r.authoritative).toEqual({
    admitted: decision.admitted,
    adoption: defers(s) ? "DEFER" : "DECIDE",
    terminalStage: terminal?.stage ?? null,
    reason: terminal?.reasonCode ?? null,
    detail: terminal?.detail ?? null,
    integrity: terminal?.integrity ?? null,
    passedStages: passed,
  });
  for (const stage of passed) expect({ stage, ok: kernel(stage, s, graph)?.ok }).toEqual({ stage, ok: true });
  if (terminal !== null) {
    const own = kernel(terminal.stage, s, graph);
    // The fence's terminal detail adds "every stage before it passed"; its code is the kernel's.
    expect(own !== null && !own.ok && own.refusal.reasonCode).toBe(terminal.reasonCode);
  }

  const tail = terminal === null ? [] : NATIVE_CANARY_STAGES.slice(NATIVE_CANARY_STAGES.indexOf(terminal.stage) + 1);
  expect(r.diagnostics.map((d) => d.stage)).toEqual([...tail, ...NATIVE_DRY_DOWNSTREAM_STAGES]);
  for (const stage of tail) {
    const verdict = kernel(stage, s, graph);
    const d = diag(r, stage);
    if (verdict === null) expect(d).toMatchObject({ status: "NOT_EVALUABLE", reason: "NO_PLAN_DIRECTION" });
    else if (verdict.ok) expect(d).toMatchObject({ status: "PASS", reason: "PASSED" });
    else expect(d).toMatchObject({ status: "REFUSE", reason: verdict.refusal.reasonCode, detail: verdict.refusal.detail });
  }

  expect(Object.keys(r).sort()).toEqual(["authoritative", "authority", "diagnostics", "evaluatedAt", "policy"]);
  expect(Object.keys(r.authoritative).sort()).toEqual(AUTHORITATIVE_KEYS);
  for (const d of r.diagnostics) {
    expect(Object.keys(d).sort()).toEqual(DIAGNOSTIC_KEYS);
    expect(d.authoritative).toBe(false);
    expect(["PASS", "REFUSE", "NOT_EVALUABLE"]).toContain(d.status);
    expect(typeof d.reason === "string" && typeof d.detail === "string" && d.detail.length > 0).toBe(true);
  }
  expect(r.policy).toBe("NATIVE_DRY_ADMISSION_V1");
  expect(r.authority).toBe("NONE");
  expect(r.evaluatedAt).toBe(new Date(s.nowMs).toISOString());
  expect([Object.isFrozen(r), Object.isFrozen(r.authoritative), Object.isFrozen(r.authoritative.passedStages), Object.isFrozen(r.diagnostics), r.diagnostics.every(Object.isFrozen)]).toEqual([true, true, true, true, true]);
  expect(graph.canary.verifyNativeAccountAHandoff(r, { executionProfileId: s.executionProfileId })).toMatchObject({ ok: false, reasonCode: "HANDOFF_INVALID" });
  // The same facts, judged again, give the same result.
  expect(graph.dry.evaluateNativeDryAdmission(s)).toStrictEqual(r);
  return r;
}

const verdictOf = (r: NativeDryAdmission) => [r.authoritative.terminalStage, r.authoritative.reason];

// ===========================================================================
// The contract
// ===========================================================================

describe("the dry admission contract", () => {
  it("the production verdict for an otherwise-admissible Account A candidate: every stage passes until the hard fence, which refuses NATIVE_EXECUTION_DISABLED", () => {
    const r = dryWithParity(snapshot());
    expect(NATIVE_EXECUTION_ENABLED).toBe(false);
    expect(r).toEqual({
      policy: NATIVE_DRY_ADMISSION_POLICY,
      authority: "NONE",
      evaluatedAt: new Date(FRESH_NOW_MS).toISOString(),
      authoritative: {
        admitted: false,
        adoption: "DECIDE",
        terminalStage: "NATIVE_FENCE",
        reason: "NATIVE_EXECUTION_DISABLED",
        detail: "Every stage before the hard fence passed; Native execution is hard-disabled in code (NATIVE_EXECUTION_ENABLED = false).",
        integrity: "ELIGIBLE",
        passedStages: ["ACCOUNT", "SOURCE", "SOURCE_TIMEFRAME", "PLAN", "FRESHNESS", "INTEGRITY", "OCCUPANCY", "ACCOUNT_GATES"],
      },
      diagnostics: [
        { stage: "RISK", status: "REFUSE", reason: "NATIVE_RISK_UNRESOLVED", detail: "Native risk for Account A is UNRESOLVED: No Native risk amount has been approved for Account A. No exchange request was made.", authoritative: false },
        { stage: "EXECUTOR_MARGIN_PLAN", status: "NOT_EVALUABLE", reason: "REQUIRES_EXCHANGE_READS", detail: expect.any(String), authoritative: false },
        { stage: "EXECUTION_CREATION", status: "NOT_EVALUABLE", reason: "REQUIRES_DATABASE_LOCK", detail: expect.any(String), authoritative: false },
        { stage: "PHASE5_SAFETY_ENGINE", status: "NOT_EVALUABLE", reason: "REQUIRES_EXCHANGE_READS", detail: expect.any(String), authoritative: false },
        { stage: "PHASE5_AUTHORIZATION", status: "PASS", reason: "AUTHORIZATION_NATURAL", detail: expect.any(String), authoritative: false },
        { stage: "PHASE5_SESSION_BUDGET", status: "PASS", reason: "SESSION_SLOT_AVAILABLE", detail: expect.any(String), authoritative: false },
        { stage: "ENTRY_LIFECYCLE", status: "NOT_EVALUABLE", reason: "REQUIRES_EXCHANGE_MUTATIONS", detail: expect.any(String), authoritative: false },
      ],
    });
  });

  it("a diagnostic never replaces the verdict: a later PASS leaves the terminal refusal standing, and a later REFUSE adds no second blocker", () => {
    // SAFE runtime: the verdict is ACCOUNT_GATES; the later Phase 5 PASS changes nothing.
    const safe = dryWithParity(snapshot({}, { accountGates: { environment: SAFE_GATES, profile: ARMED_PROFILE } }));
    expect(verdictOf(safe)).toEqual(["ACCOUNT_GATES", "ACCOUNT_NOT_LIVE_READY"]);
    expect(diag(safe, "PHASE5_AUTHORIZATION").status).toBe("PASS");
    expect(diag(safe, "NATIVE_FENCE")).toMatchObject({ status: "REFUSE", reason: "NATIVE_EXECUTION_DISABLED", detail: "Native execution is hard-disabled in code (NATIVE_EXECUTION_ENABLED = false)." });
    // Several later refusals: still exactly one authoritative stage, the first in production order.
    const many = dryWithParity(snapshot({}, { accountGates: { environment: SAFE_GATES, profile: null }, phase5: phase5({ newestNaturalWindow: null }) }));
    expect(verdictOf(many)).toEqual(["ACCOUNT_GATES", "ACCOUNT_NOT_LIVE_READY"]);
    expect(many.diagnostics.filter((d) => d.status === "REFUSE").map((d) => d.stage)).toEqual(["NATIVE_FENCE", "RISK", "PHASE5_AUTHORIZATION"]);
    expect(many.authoritative.passedStages).not.toContain("ACCOUNT_GATES");
    for (const d of many.diagnostics) expect(many.authoritative.passedStages).not.toContain(d.stage);
  });

  it("the evaluation instant is the snapshot's and nothing else; an instant that is not one is refused loudly", () => {
    expect(evaluateNativeDryAdmission(snapshot({}, { nowMs: EXPIRY })).evaluatedAt).toBe(new Date(EXPIRY).toISOString());
    for (const nowMs of [Number.NaN, 1.5, Number.POSITIVE_INFINITY, 9e15, "1" as never, undefined as never]) {
      expect(() => evaluateNativeDryAdmission(snapshot({}, { nowMs })), String(nowMs)).toThrow(RangeError);
    }
  });
});

// ===========================================================================
// The required matrix (section 13), each case compared with production
// ===========================================================================

type Expected = { terminal: [NativeCanaryStage, string] | null; adoption?: "DEFER" | "DECIDE"; integrity?: string | null; diagnostics?: Record<string, [string, string]> };
type Case = [name: string, facts: () => NativeDryAdmissionSnapshot, expected: Expected];

const FENCE: [NativeCanaryStage, string] = ["NATIVE_FENCE", "NATIVE_EXECUTION_DISABLED"];
const RISK_A_UNRESOLVED: Record<string, [string, string]> = { RISK: ["REFUSE", "NATIVE_RISK_UNRESOLVED"] };

function runMatrix(cases: Case[]) {
  for (const [name, facts, expected] of cases) {
    it(name, () => {
      const r = dryWithParity(facts());
      expect(verdictOf(r)).toEqual(expected.terminal ?? [null, null]);
      if (expected.adoption) expect(r.authoritative.adoption).toBe(expected.adoption);
      if (expected.integrity !== undefined) expect(r.authoritative.integrity).toBe(expected.integrity);
      for (const [stage, [status, reason]] of Object.entries(expected.diagnostics ?? {})) {
        expect({ stage, status: diag(r, stage).status, reason: diag(r, stage).reason }).toEqual({ stage, status, reason });
      }
    });
  }
}

const payloadTf = (s: NativeDryAdmissionSnapshot, tf: string): NativeDryAdmissionSnapshot => {
  const payload = s.alert.rawPayload as { delivery: Record<string, unknown> };
  return { ...s, alert: { ...s.alert, sourceTimeframe: tf, rawPayload: { ...payload, delivery: { ...payload.delivery, sourceTimeframe: tf } } } };
};

describe("account and source", () => {
  runMatrix([
    ["Account A, valid Native: through every stage to the hard fence", () => snapshot(), { terminal: FENCE, diagnostics: RISK_A_UNRESOLVED }],
    ["Account B is refused at ACCOUNT, and its own Native risk shows UNRESOLVED", () => snapshot({}, { accountSlot: "ACCOUNT_B", accountPlanPolicy: ACCOUNT_B_POLICY }), { terminal: ["ACCOUNT", "ACCOUNT_NOT_A"], diagnostics: { RISK: ["REFUSE", "NATIVE_RISK_UNRESOLVED"], NATIVE_FENCE: ["REFUSE", "NATIVE_EXECUTION_DISABLED"] } }],
    ["Account B with Account A's window policy is still Account B", () => snapshot({}, { accountSlot: "ACCOUNT_B" }), { terminal: ["ACCOUNT", "ACCOUNT_NOT_A"] }],
    ["a generic process is refused", () => snapshot({}, { accountSlot: "GENERIC" }), { terminal: ["ACCOUNT", "ACCOUNT_NOT_A"], diagnostics: RISK_A_UNRESOLVED }],
    ["an unproven process is refused as ambiguous", () => snapshot({}, { accountSlot: "UNKNOWN" }), { terminal: ["ACCOUNT", "AMBIGUOUS_STATE"], diagnostics: RISK_A_UNRESOLVED }],
    ["Account A offered Account B's policy is ambiguous", () => snapshot({}, { accountPlanPolicy: ACCOUNT_B_POLICY }), { terminal: ["ACCOUNT", "AMBIGUOUS_STATE"] }],
    ["a TradingView alert is refused at SOURCE (and has no Native integrity)", () => { const s = snapshot(); return { ...s, alert: { ...s.alert, source: "TRADINGVIEW" } }; }, { terminal: ["SOURCE", "SOURCE_NOT_NATIVE"], diagnostics: { INTEGRITY: ["REFUSE", "INTEGRITY_UNREADABLE"], FRESHNESS: ["REFUSE", "NATIVE_SIGNAL_TIME_UNAVAILABLE"] } }],
    ["a missing or lower-case source is not NATIVE", () => { const s = snapshot(); return { ...s, alert: { ...s.alert, source: "native" } }; }, { terminal: ["SOURCE", "SOURCE_NOT_NATIVE"] }],
    ["a null source is not NATIVE", () => { const s = snapshot(); return { ...s, alert: { ...s.alert, source: null } }; }, { terminal: ["SOURCE", "SOURCE_NOT_NATIVE"] }],
    ["a forged NATIVE row (its event hash disagrees with its level) proves no signal time and no integrity", () => editedAlert(snapshot(), (p) => (p.delivery.levelKey = "forged-level")), { terminal: ["FRESHNESS", "NATIVE_SIGNAL_TIME_UNAVAILABLE"], diagnostics: { INTEGRITY: ["REFUSE", "INTEGRITY_UNREADABLE"] } }],
  ]);
});

describe("source timeframe: 1D and 1W only", () => {
  runMatrix([
    ["1D is executable", () => snapshot({ sourceTf: "1D" }), { terminal: FENCE }],
    ["1W is executable", () => snapshot({ sourceTf: "1W" }), { terminal: FENCE }],
    ["1M (dashboard-deliverable) is refused SOURCE_TF_NOT_EXECUTABLE", () => snapshot({ sourceTf: "1M" }), { terminal: ["SOURCE_TIMEFRAME", "SOURCE_TF_NOT_EXECUTABLE"] }],
    ["3M (engine-only) is refused", () => payloadTf(snapshot(), "3M"), { terminal: ["SOURCE_TIMEFRAME", "SOURCE_TF_NOT_EXECUTABLE"] }],
    ["6M (engine-only) is refused", () => payloadTf(snapshot(), "6M"), { terminal: ["SOURCE_TIMEFRAME", "SOURCE_TF_NOT_EXECUTABLE"] }],
    ["12M (engine-only) is refused", () => payloadTf(snapshot(), "12M"), { terminal: ["SOURCE_TIMEFRAME", "SOURCE_TF_NOT_EXECUTABLE"] }],
    ["a column that disagrees with its durable payload is ambiguous, never a choice", () => { const s = snapshot(); return { ...s, alert: { ...s.alert, sourceTimeframe: "1W" } }; }, { terminal: ["SOURCE_TIMEFRAME", "AMBIGUOUS_STATE"] }],
  ]);
  it("1M is refused before anything about its plan or evidence is consulted", () => {
    const r = dryWithParity(snapshot({ sourceTf: "1M" }, { plan: null, scannerEvidence: null }));
    expect(r.authoritative.passedStages).toEqual(["ACCOUNT", "SOURCE"]);
  });
});

describe("plan", () => {
  runMatrix([
    ["a valid READY plan with Account A's 100-candle window passes", () => snapshot(), { terminal: FENCE }],
    ["a missing plan is refused; its side is unknown, so occupancy and Phase 5 are NOT_EVALUABLE", () => snapshot({}, { plan: null }), { terminal: ["PLAN", "PLAN_NOT_READY"], diagnostics: { OCCUPANCY: ["NOT_EVALUABLE", "NO_PLAN_DIRECTION"], PHASE5_AUTHORIZATION: ["NOT_EVALUABLE", "NO_PLAN_DIRECTION"], PHASE5_SESSION_BUDGET: ["NOT_EVALUABLE", "AUTHORIZATION_NOT_ADMITTED"], RISK: ["REFUSE", "NATIVE_RISK_UNRESOLVED"] } }],
    ["a plan that is not READY is refused", () => { const s = snapshot(); return { ...s, plan: planFor(s.alert, { status: "FAILED", errorReason: "klines unavailable" }) }; }, { terminal: ["PLAN", "PLAN_NOT_READY"] }],
    ["a plan for another alert is refused", () => { const s = snapshot(); return { ...s, plan: planFor(s.alert, { alertId: "someone-else" }) }; }, { terminal: ["PLAN", "PLAN_NOT_FOR_ALERT"] }],
    ["a malformed direction is ambiguous (and gives no side to judge occupancy by)", () => { const s = snapshot(); return { ...s, plan: planFor(s.alert, { direction: "UP" as never }) }; }, { terminal: ["PLAN", "AMBIGUOUS_STATE"], diagnostics: { OCCUPANCY: ["NOT_EVALUABLE", "NO_PLAN_DIRECTION"] } }],
    ["a direction that disagrees with the signal is ambiguous", () => { const s = snapshot(); return { ...s, plan: planFor(s.alert, { direction: "SHORT" }) }; }, { terminal: ["PLAN", "AMBIGUOUS_STATE"] }],
    ["an incomplete window is refused", () => { const s = snapshot(); return { ...s, plan: planFor(s.alert, { candidates: [candidateFor(100, "LONG", { complete: false, actualCandles: 80 })] }) }; }, { terminal: ["PLAN", "PLAN_INCOMPLETE"] }],
    ["a plan with no frozen risk template is refused", () => { const s = snapshot(); return { ...s, plan: planFor(s.alert, { template: null }) }; }, { terminal: ["PLAN", "PLAN_INCOMPLETE"] }],
    ["a plan with no entry price is refused", () => { const s = snapshot(); return { ...s, plan: planFor(s.alert, { entryPrice: " " }) }; }, { terminal: ["PLAN", "PLAN_INCOMPLETE"] }],
    ["two candidates for the 100-candle window are ambiguous", () => { const s = snapshot(); return { ...s, plan: planFor(s.alert, { candidates: [candidateFor(100, "LONG"), candidateFor(100, "LONG")] }) }; }, { terminal: ["PLAN", "AMBIGUOUS_STATE"] }],
    ["a plan persisting the 300-candle window is refused for Account A", () => { const s = snapshot(); return { ...s, plan: planFor(s.alert, { selectedLookback: 300 }) }; }, { terminal: ["PLAN", "PLAN_LOOKBACK_MISMATCH"] }],
    ["a plan persisting the 50-candle window is refused for Account A", () => { const s = snapshot(); return { ...s, plan: planFor(s.alert, { selectedLookback: 50 }) }; }, { terminal: ["PLAN", "PLAN_LOOKBACK_MISMATCH"] }],
    ["an account-process override of the window never steers it (300 is INVALID)", () => snapshot({}, { accountPlanPolicy: nativeAccountAExecutionPolicy("300") }), { terminal: ["PLAN", "ACCOUNT_PLAN_UNRESOLVED"] }],
  ]);

  it("the lookback is a window, never money: no window choice changes the risk judgment, and no window number appears as a budget", () => {
    const base = snapshot();
    const risks = [100, 300, 50].map((selectedLookback) => diag(evaluateNativeDryAdmission({ ...base, plan: planFor(base.alert, { selectedLookback }) }), "RISK"));
    for (const risk of risks) expect(risk).toEqual(risks[0]);
    expect(risks[0].detail).not.toMatch(/\b(100|300|50)\b/);
    expect(nativeAccountAExecutionPolicy(undefined)).toMatchObject({ account: "A", lookback: 100, source: "BUILTIN_DEFAULT" });
    expect(ACCOUNT_B_POLICY).toMatchObject({ account: "B", lookback: 300 });
  });
});

describe("integrity: derived by the canonical evaluator from the snapshot's scanner evidence", () => {
  const records = cleanRecords();
  const commitAs = (classification: "QUARANTINED_CURRENT_BAR") => ({ ...records[2], classification });
  runMatrix([
    ["ELIGIBLE passes", () => withEvidence((r) => eligibleEvidence(r)), { terminal: FENCE }],
    ["PENDING_BAR_CLOSE while the signal is fresh: refused at INTEGRITY, and the adoption pass DEFERS it", () => withEvidence((r) => evidenceOf(r.slice(0, 2), SOURCE_BAR)), { terminal: ["INTEGRITY", "INTEGRITY_PENDING_BAR_CLOSE"], adoption: "DEFER", integrity: "PENDING_BAR_CLOSE" }],
    ["re-quarantined", () => withEvidence((r) => evidenceOf([...r.slice(0, 2), commitAs("QUARANTINED_CURRENT_BAR")], bar(2))), { terminal: ["INTEGRITY", "INTEGRITY_INELIGIBLE"], adoption: "DECIDE", integrity: "INELIGIBLE_REQUARANTINED" }],
    ["a gap before the source bar", () => withEvidence((r) => evidenceOf(r.slice(1), bar(2))), { terminal: ["INTEGRITY", "INTEGRITY_INELIGIBLE"], integrity: "INELIGIBLE_GAP" }],
    ["a duplicate commit", () => withEvidence((r) => evidenceOf([...r, r[2]], bar(2))), { terminal: ["INTEGRITY", "INTEGRITY_INELIGIBLE"], integrity: "INELIGIBLE_DUPLICATE" }],
    ["a checkpoint mismatch", () => withEvidence((r) => evidenceOf(r.slice(0, 2), bar(0))), { terminal: ["INTEGRITY", "INTEGRITY_INELIGIBLE"], integrity: "INELIGIBLE_CHECKPOINT_MISMATCH" }],
    ["a stale engine generation", () => withEvidence((r) => evidenceOf(r, bar(2), CANARY_SYMBOL, { currentEngineFingerprint: "f".repeat(64) })), { terminal: ["INTEGRITY", "INTEGRITY_INELIGIBLE"], integrity: "INELIGIBLE_STALE_GENERATION" }],
    ["an unreadable event log", () => withEvidence(() => evidenceOf(null, bar(2))), { terminal: ["INTEGRITY", "INTEGRITY_UNREADABLE"], integrity: "UNREADABLE" }],
    ["no scanner evidence at all", () => withEvidence(() => null), { terminal: ["INTEGRITY", "INTEGRITY_UNREADABLE"], integrity: "UNREADABLE" }],
  ]);
  for (const [name, terminal] of [["each ineligible verdict still shows the hard fence and the unresolved risk behind it", ["INTEGRITY", "INTEGRITY_INELIGIBLE"]]] as const) {
    it(name, () => {
      const r = dryWithParity(withEvidence((r) => evidenceOf(r.slice(1), bar(2))));
      expect(verdictOf(r)).toEqual(terminal);
      expect(diag(r, "NATIVE_FENCE")).toMatchObject({ status: "REFUSE", reason: "NATIVE_EXECUTION_DISABLED" });
      expect(diag(r, "RISK")).toMatchObject({ status: "REFUSE", reason: "NATIVE_RISK_UNRESOLVED" });
      expect(diag(r, "OCCUPANCY").status).toBe("PASS");
    });
  }
});

describe("freshness: the M5 rule, reused", () => {
  const touch = () => snapshot().alert.triggeredAt!.getTime();
  runMatrix([
    ["fresh", () => snapshot(), { terminal: FENCE }],
    ["exactly at expiry is still fresh", () => snapshot({}, { nowMs: EXPIRY }), { terminal: FENCE }],
    ["one millisecond after expiry is stale", () => snapshot({}, { nowMs: EXPIRY + 1 }), { terminal: ["FRESHNESS", "NATIVE_SIGNAL_STALE"] }],
    ["a signal from the future (one millisecond before its touch) proves no time", () => snapshot({}, { nowMs: touch() - 1 }), { terminal: ["FRESHNESS", "NATIVE_SIGNAL_TIME_UNAVAILABLE"] }],
    ["a missing barStart proves no time (and no integrity)", () => editedAlert(snapshot(), (p) => delete p.delivery.barStart), { terminal: ["FRESHNESS", "NATIVE_SIGNAL_TIME_UNAVAILABLE"], diagnostics: { INTEGRITY: ["REFUSE", "INTEGRITY_UNREADABLE"] } }],
    ["a touch before its own bar opened is impossible", () => editedAlert(snapshot(), (p, r) => { r.triggeredAt = new Date(SOURCE_BAR - 1); p.triggeredAt = r.triggeredAt.toISOString(); }), { terminal: ["FRESHNESS", "NATIVE_SIGNAL_TIME_UNAVAILABLE"] }],
    ["a row whose trigger instant disagrees with its payload proves no time", () => editedAlert(snapshot(), (_p, r) => (r.triggeredAt = new Date(r.triggeredAt!.getTime() + 1))), { terminal: ["FRESHNESS", "NATIVE_SIGNAL_TIME_UNAVAILABLE"] }],
    ["after a long downtime (six hours) the signal is permanently stale", () => snapshot({}, { nowMs: SOURCE_BAR_CLOSE + 6 * HOUR }), { terminal: ["FRESHNESS", "NATIVE_SIGNAL_STALE"], adoption: "DECIDE" }],
    ["a replayed old alert a day later is stale too", () => snapshot({}, { nowMs: SOURCE_BAR_CLOSE + DAY }), { terminal: ["FRESHNESS", "NATIVE_SIGNAL_STALE"] }],
    ["a bar still forming at exact expiry is deferred, not refused", () => withEvidence((r) => evidenceOf(r.slice(0, 2), SOURCE_BAR), { nowMs: EXPIRY }), { terminal: ["INTEGRITY", "INTEGRITY_PENDING_BAR_CLOSE"], adoption: "DEFER" }],
    ["a bar still forming one millisecond past expiry is DECIDED stale: no endless deferral", () => withEvidence((r) => evidenceOf(r.slice(0, 2), SOURCE_BAR), { nowMs: EXPIRY + 1 }), { terminal: ["FRESHNESS", "NATIVE_SIGNAL_STALE"], adoption: "DECIDE" }],
  ]);
});

describe("occupancy: max one active or pending execution per account + symbol + side", () => {
  runMatrix([
    ["none passes", () => snapshot({}, { occupancy: [] }), { terminal: FENCE }],
    ["a pending LIMIT on the same symbol and side is refused", () => snapshot({}, { occupancy: [row()] }), { terminal: ["OCCUPANCY", "SAME_SYMBOL_SIDE_OCCUPIED"], integrity: "ELIGIBLE" }],
    ["a PLAN_READY row on the same side is refused too", () => snapshot({}, { occupancy: [row({ status: "PLAN_READY", entryOrders: [] })] }), { terminal: ["OCCUPANCY", "SAME_SYMBOL_SIDE_OCCUPIED"] }],
    ["the opposite side does not collide (existing semantics)", () => snapshot({}, { occupancy: [row({ direction: "SHORT", positionSide: "SHORT" })] }), { terminal: FENCE }],
    ["another symbol does not collide (existing semantics)", () => snapshot({}, { occupancy: [row({ symbol: "OTHERUSDT" })] }), { terminal: FENCE }],
    ["an ENTRY_EXPIRED execution whose order is finished frees the slot", () => snapshot({}, { occupancy: [row({ status: "ENTRY_EXPIRED", entryOrders: [{ status: "CANCELED", submissionUnknown: false }] })] }), { terminal: FENCE }],
    ["an ENTRY_EXPIRED execution whose entry order may still be live is ambiguous", () => snapshot({}, { occupancy: [row({ status: "ENTRY_EXPIRED", entryOrders: [{ status: "NEW", submissionUnknown: false }] })] }), { terminal: ["OCCUPANCY", "AMBIGUOUS_STATE"] }],
    ["an ENTRY_EXPIRED execution whose submission is unknown is ambiguous", () => snapshot({}, { occupancy: [row({ status: "ENTRY_EXPIRED", entryOrders: [{ status: "CANCELED", submissionUnknown: true }] })] }), { terminal: ["OCCUPANCY", "AMBIGUOUS_STATE"] }],
    ["a status the rule does not know is ambiguous, never free", () => snapshot({}, { occupancy: [row({ status: "EXPIRED" })] }), { terminal: ["OCCUPANCY", "AMBIGUOUS_STATE"] }],
    ["the candidate's own execution (a retry after a crash) is never its occupant", () => { const s = snapshot(); return { ...s, occupancy: [row({ alertId: s.alert.id })] }; }, { terminal: FENCE }],
    ["manual intervention on the symbol is ambiguous, whichever side", () => snapshot({}, { occupancy: [row({ direction: "SHORT", positionSide: "SHORT", status: "MANUAL_INTERVENTION" })] }), { terminal: ["OCCUPANCY", "AMBIGUOUS_STATE"] }],
    ["unread occupancy is never free", () => snapshot({}, { occupancy: null }), { terminal: ["OCCUPANCY", "AMBIGUOUS_STATE"] }],
  ]);
});

// ===========================================================================
// SAFE != LIVE_READY != ARMED, and Phase 5 (section 12)
// ===========================================================================

describe("account safety: SAFE, LIVE_READY and ARMED stay distinct, and Phase 5 is never bypassed", () => {
  runMatrix([
    ["SAFE (kill on, entry off, protection off) is refused NOT LIVE_READY", () => snapshot({}, { accountGates: { environment: SAFE_GATES, profile: ARMED_PROFILE } }), { terminal: ["ACCOUNT_GATES", "ACCOUNT_NOT_LIVE_READY"] }],
    ["an INVALID mixture of gates is not LIVE_READY", () => snapshot({}, { accountGates: { environment: { globalKillSwitch: true, liveEntryEnabled: true, protectionReady: true }, profile: ARMED_PROFILE } }), { terminal: ["ACCOUNT_GATES", "ACCOUNT_NOT_LIVE_READY"] }],
    ["unreadable gates are not LIVE_READY", () => snapshot({}, { accountGates: { environment: { globalKillSwitch: "false", liveEntryEnabled: true, protectionReady: true }, profile: ARMED_PROFILE } }), { terminal: ["ACCOUNT_GATES", "ACCOUNT_NOT_LIVE_READY"] }],
    ["LIVE_READY but SAFE_OFF is not ARMED", () => snapshot({}, { accountGates: { environment: LIVE_READY_GATES, profile: { isEnabled: false, killSwitchActive: true } } }), { terminal: ["ACCOUNT_GATES", "ACCOUNT_NOT_ARMED"] }],
    ["LIVE_READY but SAFE_RECOVERY is not ARMED", () => snapshot({}, { accountGates: { environment: LIVE_READY_GATES, profile: { isEnabled: true, killSwitchActive: true } } }), { terminal: ["ACCOUNT_GATES", "ACCOUNT_NOT_ARMED"] }],
    ["LIVE_READY with an unreadable profile is not ARMED", () => snapshot({}, { accountGates: { environment: LIVE_READY_GATES, profile: null } }), { terminal: ["ACCOUNT_GATES", "ACCOUNT_NOT_ARMED"] }],
    ["ARMED and valid: the gates pass and the hard fence refuses", () => snapshot(), { terminal: FENCE, diagnostics: { PHASE5_AUTHORIZATION: ["PASS", "AUTHORIZATION_NATURAL"], PHASE5_SESSION_BUDGET: ["PASS", "SESSION_SLOT_AVAILABLE"] } }],
    ["ARMED outside the natural window (expired)", () => snapshot({}, { phase5: phase5({ newestNaturalWindow: naturalWindow({ expiresAt: new Date(FRESH_NOW_MS) }) }) }), { terminal: FENCE, diagnostics: { PHASE5_AUTHORIZATION: ["REFUSE", "NATURAL_AUTHORIZATION_EXPIRED"], PHASE5_SESSION_BUDGET: ["NOT_EVALUABLE", "AUTHORIZATION_NOT_ADMITTED"] } }],
    ["ARMED with the window revoked", () => snapshot({}, { phase5: phase5({ newestNaturalWindow: naturalWindow({ revokedAt: new Date(FRESH_NOW_MS - MIN) }) }) }), { terminal: FENCE, diagnostics: { PHASE5_AUTHORIZATION: ["REFUSE", "NATURAL_AUTHORIZATION_REVOKED"] } }],
    ["ARMED with no window prepared on an authorization-controlled profile", () => snapshot({}, { phase5: phase5({ newestNaturalWindow: null }) }), { terminal: FENCE, diagnostics: { PHASE5_AUTHORIZATION: ["REFUSE", "NATURAL_AUTHORIZATION_REQUIRED"] } }],
    ["ARMED with a window that admits only the other side", () => snapshot({}, { phase5: phase5({ newestNaturalWindow: naturalWindow({ allowedDirections: ["SHORT"] }) }) }), { terminal: FENCE, diagnostics: { PHASE5_AUTHORIZATION: ["REFUSE", "NATURAL_AUTHORIZATION_DIRECTION_NOT_ALLOWED"] } }],
    ["ARMED with a malformed window", () => snapshot({}, { phase5: phase5({ newestNaturalWindow: naturalWindow({ allowedDirections: [] }) }) }), { terminal: FENCE, diagnostics: { PHASE5_AUTHORIZATION: ["REFUSE", "NATURAL_AUTHORIZATION_INVALID"] } }],
    ["ARMED with a legacy window whose claims are spent", () => snapshot({}, { phase5: phase5({ newestNaturalWindow: naturalWindow({ tradingSessionId: null, claimedCount: 5 }) }) }), { terminal: FENCE, diagnostics: { PHASE5_AUTHORIZATION: ["REFUSE", "NATURAL_AUTHORIZATION_EXHAUSTED"] } }],
    ["ARMED with the session's trade budget exhausted", () => snapshot({}, { phase5: phase5({ session: tradingSession({ openedCount: 2, reservedCount: 1 }) }) }), { terminal: FENCE, diagnostics: { PHASE5_AUTHORIZATION: ["PASS", "AUTHORIZATION_NATURAL"], PHASE5_SESSION_BUDGET: ["REFUSE", "SESSION_BUDGET_EXHAUSTED"] } }],
    ["ARMED with the session expired", () => snapshot({}, { phase5: phase5({ session: tradingSession({ expiresAt: new Date(FRESH_NOW_MS) }) }) }), { terminal: FENCE, diagnostics: { PHASE5_SESSION_BUDGET: ["REFUSE", "SESSION_EXPIRED"] } }],
    ["ARMED with the session paused", () => snapshot({}, { phase5: phase5({ session: tradingSession({ status: "PAUSED" }) }) }), { terminal: FENCE, diagnostics: { PHASE5_SESSION_BUDGET: ["REFUSE", "SESSION_PAUSED"] } }],
    ["ARMED with the session stopped", () => snapshot({}, { phase5: phase5({ session: tradingSession({ status: "REVOKED" }) }) }), { terminal: FENCE, diagnostics: { PHASE5_SESSION_BUDGET: ["REFUSE", "SESSION_REVOKED"] } }],
    ["ARMED with the window's session missing", () => snapshot({}, { phase5: phase5({ session: null }) }), { terminal: FENCE, diagnostics: { PHASE5_SESSION_BUDGET: ["REFUSE", "SESSION_REQUIRED"] } }],
    ["ARMED with a session that belongs to another profile", () => snapshot({}, { phase5: phase5({ session: tradingSession({ executionProfileId: "another-profile" }) }) }), { terminal: FENCE, diagnostics: { PHASE5_SESSION_BUDGET: ["REFUSE", "SESSION_REQUIRED"] } }],
    ["a captured session that is not the one the window names is never substituted", () => snapshot({}, { phase5: phase5({ session: tradingSession({ id: "a-newer-session" }) }) }), { terminal: FENCE, diagnostics: { PHASE5_SESSION_BUDGET: ["REFUSE", "SESSION_REQUIRED"] } }],
    ["an unlimited active session admits", () => snapshot({}, { phase5: phase5({ session: tradingSession({ unlimited: true, tradeBudget: null, openedCount: 50 }) }) }), { terminal: FENCE, diagnostics: { PHASE5_SESSION_BUDGET: ["PASS", "SESSION_SLOT_AVAILABLE"] } }],
    ["an unlimited session that is paused does not", () => snapshot({}, { phase5: phase5({ session: tradingSession({ unlimited: true, tradeBudget: null, status: "PAUSED" }) }) }), { terminal: FENCE, diagnostics: { PHASE5_SESSION_BUDGET: ["REFUSE", "SESSION_PAUSED"] } }],
    ["a finite session with no budget admits nothing", () => snapshot({}, { phase5: phase5({ session: tradingSession({ tradeBudget: null }) }) }), { terminal: FENCE, diagnostics: { PHASE5_SESSION_BUDGET: ["REFUSE", "SESSION_BUDGET_EXHAUSTED"] } }],
    ["a legacy window reserves no session slot", () => snapshot({}, { phase5: phase5({ newestNaturalWindow: naturalWindow({ tradingSessionId: null }), session: null }) }), { terminal: FENCE, diagnostics: { PHASE5_AUTHORIZATION: ["PASS", "AUTHORIZATION_NATURAL"], PHASE5_SESSION_BUDGET: ["PASS", "NO_SESSION_SLOT_REQUIRED"] } }],
    ["a profile with no authorization history is LEGACY", () => snapshot({}, { phase5: phase5({ authorizationCount: 0, newestNaturalWindow: null, session: null }) }), { terminal: FENCE, diagnostics: { PHASE5_AUTHORIZATION: ["PASS", "AUTHORIZATION_LEGACY"], PHASE5_SESSION_BUDGET: ["PASS", "NO_SESSION_SLOT_REQUIRED"] } }],
    ["an exact-signal binding for the alert wins outright", () => snapshot({}, { phase5: phase5({ exactBindingId: "exact-1", newestNaturalWindow: null }) }), { terminal: FENCE, diagnostics: { PHASE5_AUTHORIZATION: ["PASS", "AUTHORIZATION_EXACT"], PHASE5_SESSION_BUDGET: ["PASS", "NO_SESSION_SLOT_REQUIRED"] } }],
    ["Phase 5 facts not captured: both Phase 5 diagnostics are NOT_EVALUABLE", () => snapshot({}, { phase5: null }), { terminal: FENCE, diagnostics: { PHASE5_AUTHORIZATION: ["NOT_EVALUABLE", "PHASE5_FACTS_NOT_CAPTURED"], PHASE5_SESSION_BUDGET: ["NOT_EVALUABLE", "AUTHORIZATION_NOT_ADMITTED"] } }],
  ]);

  it("the Phase 5 refusal texts are the production ones", () => {
    const expired = evaluateNativeDryAdmission(snapshot({}, { phase5: phase5({ newestNaturalWindow: naturalWindow({ expiresAt: new Date(FRESH_NOW_MS) }) }) }));
    expect(diag(expired, "PHASE5_AUTHORIZATION").detail).toBe("The natural window has expired.");
    const exhausted = evaluateNativeDryAdmission(snapshot({}, { phase5: phase5({ session: tradingSession({ openedCount: 2, reservedCount: 1 }) }) }));
    expect(diag(exhausted, "PHASE5_SESSION_BUDGET").detail).toBe("The session's trade budget of 3 is fully used or reserved.");
  });
});

// ===========================================================================
// Risk: production UNRESOLVED; synthetic contracts in TEST-ONLY graphs
// ===========================================================================

describe("risk", () => {
  it("production: Account A and Account B are UNRESOLVED, and the dry tail says so for each", () => {
    expect(NATIVE_RISK_CONTRACTS.A.state).toBe("UNRESOLVED");
    expect(NATIVE_RISK_CONTRACTS.B.state).toBe("UNRESOLVED");
    expect(diag(evaluateNativeDryAdmission(snapshot()), "RISK")).toMatchObject({ status: "REFUSE", reason: "NATIVE_RISK_UNRESOLVED", detail: expect.stringContaining("Account A is UNRESOLVED") });
    const b = evaluateNativeDryAdmission(snapshot({}, { accountSlot: "ACCOUNT_B", accountPlanPolicy: ACCOUNT_B_POLICY }));
    expect(diag(b, "RISK")).toMatchObject({ status: "REFUSE", reason: "NATIVE_RISK_UNRESOLVED", detail: expect.stringContaining("Account B is UNRESOLVED") });
    // Whatever the plan's budget, an UNRESOLVED contract refuses first.
    const base = snapshot();
    for (const riskAmount of ["1.50", "abc", "-1", "", "999999999"]) {
      const s = { ...base, plan: planFor(base.alert, { template: { ...TEMPLATE, riskAmount } }) };
      expect(diag(evaluateNativeDryAdmission(s), "RISK").reason, riskAmount).toBe("NATIVE_RISK_UNRESOLVED");
    }
  });

  it("test-only: with the switch on, an UNRESOLVED contract becomes the authoritative blocker at RISK", async () => {
    const graph = await testGraph();
    const r = dryWithParity(snapshot(), graph);
    expect(verdictOf(r)).toEqual(["RISK", "NATIVE_RISK_UNRESOLVED"]);
    expect(r.authoritative.passedStages).toContain("NATIVE_FENCE");
  });

  it("test-only: a synthetic resolved contract admits a budget at or below its cap", async () => {
    const atCap = await testGraph(syntheticA(TEMPLATE.riskAmount));
    expect(dryWithParity(snapshot(), atCap).authoritative).toMatchObject({ admitted: true, terminalStage: null, reason: null });
    const above = await testGraph(resolvedAContracts);
    expect(dryWithParity(snapshot(), above).authoritative.admitted).toBe(true);
  });

  it("test-only: a budget above the synthetic cap is refused NATIVE_RISK_EXCEEDS_CONTRACT", async () => {
    const graph = await testGraph(syntheticA("1.49"));
    const r = dryWithParity(snapshot(), graph);
    expect(verdictOf(r)).toEqual(["RISK", "NATIVE_RISK_EXCEEDS_CONTRACT"]);
  });

  it("test-only: an invalid budget is refused NATIVE_RISK_BUDGET_INVALID", async () => {
    const graph = await testGraph(resolvedAContracts);
    const base = snapshot();
    for (const riskAmount of ["abc", "-1", "0", "", "1e3", " 1.50"]) {
      const r = dryWithParity({ ...base, plan: planFor(base.alert, { template: { ...TEMPLATE, riskAmount } }) }, graph);
      expect(verdictOf(r), riskAmount).toEqual(["RISK", "NATIVE_RISK_BUDGET_INVALID"]);
    }
  });

  it("test-only: the cap is compared with the plan's risk budget, never its 100-candle window", async () => {
    // 1.50 <= 50 < 100: were the window the budget, this would exceed.
    const graph = await testGraph(syntheticA("50"));
    expect(dryWithParity(snapshot(), graph).authoritative.admitted).toBe(true);
    const below = await testGraph(syntheticA("1"));
    const r = dryWithParity(snapshot(), below);
    expect(verdictOf(r)).toEqual(["RISK", "NATIVE_RISK_EXCEEDS_CONTRACT"]);
    expect(r.authoritative.detail).toContain(`${TEMPLATE.riskAmount} USDT`);
    expect(r.authoritative.detail).not.toMatch(/\b100\b/);
  });

  it("test-only: Account B stays refused at ACCOUNT, and its contract stays UNRESOLVED, beside a resolved A", async () => {
    const graph = await testGraph(resolvedAContracts);
    const r = dryWithParity(snapshot({}, { accountSlot: "ACCOUNT_B", accountPlanPolicy: ACCOUNT_B_POLICY }), graph);
    expect(verdictOf(r)).toEqual(["ACCOUNT", "ACCOUNT_NOT_A"]);
    expect(diag(r, "RISK")).toMatchObject({ status: "REFUSE", reason: "NATIVE_RISK_UNRESOLVED" });
  });

  it("no synthetic contract reaches production: the production table is still UNRESOLVED and frozen after every test graph", () => {
    expect(NATIVE_RISK_CONTRACTS).toEqual({
      A: { state: "UNRESOLVED", account: "A", reason: "No Native risk amount has been approved for Account A." },
      B: { state: "UNRESOLVED", account: "B", reason: "No Native risk amount has been approved for Account B." },
    });
    expect(Object.isFrozen(NATIVE_RISK_CONTRACTS) && Object.isFrozen(NATIVE_RISK_CONTRACTS.A) && Object.isFrozen(NATIVE_RISK_CONTRACTS.B)).toBe(true);
  });
});

// ===========================================================================
// The hard fence, and section 12's synthetic fully-admissible snapshot
// ===========================================================================

describe("the hard Native fence is authoritative, and no environment overrides it", () => {
  it("with the code switch false, every otherwise-admissible snapshot stops at NATIVE_FENCE", () => {
    for (const s of [snapshot(), snapshot({ sourceTf: "1W" }), snapshot({ signal: "SHORT" }), snapshot({}, { phase5: null }), snapshot({}, { nowMs: EXPIRY })]) {
      expect(verdictOf(dryWithParity(s))).toEqual(FENCE);
    }
  });

  it("no environment variable enables Native execution or resolves Native risk for the dry admission", async () => {
    const keys = [
      "NATIVE_EXECUTION_ENABLED",
      "NATIVE_EXECUTION",
      "NATIVE_DRY_ADMISSION_AUTHORITY",
      "NATIVE_RISK_PER_TRADE_USD",
      "NATIVE_RISK_A",
      "NATIVE_MAX_RISK_PER_TRADE_USD",
      "NATIVE_MAX_RISK_PER_TRADE_USD_A",
      "NATIVE_ACCOUNT_A_RISK_USD",
    ];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) process.env[k] = k.includes("RISK") ? "5" : "true";
      vi.resetModules();
      const dry = (await import(DRY)) as DryModule;
      const r = dry.evaluateNativeDryAdmission(snapshot());
      expect(verdictOf(r)).toEqual(FENCE);
      expect(diag(r, "RISK").reason).toBe("NATIVE_RISK_UNRESOLVED");
      expect(r.authority).toBe("NONE");
    } finally {
      for (const k of keys) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
    }
  });
});

describe("section 12: a synthetic fully-admissible snapshot (TEST-ONLY graph) is admitted, and still carries no authority", () => {
  it("every stage passes, Phase 5's pure gates pass, and the exchange-bound gates stay NOT_EVALUABLE", async () => {
    const graph = await testGraph(resolvedAContracts);
    const r = dryWithParity(snapshot(), graph);
    expect(r.authoritative).toEqual({ admitted: true, adoption: "DECIDE", terminalStage: null, reason: null, detail: null, integrity: null, passedStages: [...NATIVE_CANARY_STAGES] });
    expect(r.diagnostics.map((d) => [d.stage, d.status, d.reason])).toEqual([
      ["EXECUTOR_MARGIN_PLAN", "NOT_EVALUABLE", "REQUIRES_EXCHANGE_READS"],
      ["EXECUTION_CREATION", "NOT_EVALUABLE", "REQUIRES_DATABASE_LOCK"],
      ["PHASE5_SAFETY_ENGINE", "NOT_EVALUABLE", "REQUIRES_EXCHANGE_READS"],
      ["PHASE5_AUTHORIZATION", "PASS", "AUTHORIZATION_NATURAL"],
      ["PHASE5_SESSION_BUDGET", "PASS", "SESSION_SLOT_AVAILABLE"],
      ["ENTRY_LIFECYCLE", "NOT_EVALUABLE", "REQUIRES_EXCHANGE_MUTATIONS"],
    ]);
    expect(r.authority).toBe("NONE");
  });

  it("an admitted dry verdict does not hide Phase 5: outside the window, or out of budget, the diagnostic refuses", async () => {
    const graph = await testGraph(resolvedAContracts);
    const outside = dryWithParity(snapshot({}, { phase5: phase5({ newestNaturalWindow: naturalWindow({ expiresAt: new Date(FRESH_NOW_MS) }) }) }), graph);
    expect([outside.authoritative.admitted, diag(outside, "PHASE5_AUTHORIZATION").reason]).toEqual([true, "NATURAL_AUTHORIZATION_EXPIRED"]);
    const spent = dryWithParity(snapshot({}, { phase5: phase5({ session: tradingSession({ openedCount: 3 }) }) }), graph);
    expect([spent.authoritative.admitted, diag(spent, "PHASE5_SESSION_BUDGET").reason]).toEqual([true, "SESSION_BUDGET_EXHAUSTED"]);
  });
});

// ===========================================================================
// Dry authority: none, in any form
// ===========================================================================

describe("dry authority: the result can never act as a hand-off", () => {
  const HANDOFF_FIELDS = (s: NativeDryAdmissionSnapshot) => ({
    kind: "NATIVE_ACCOUNT_A_HANDOFF",
    executionProfileId: s.executionProfileId,
    alertId: s.alert.id,
    planId: s.plan!.id,
    symbol: s.alert.symbol,
    direction: "LONG",
    sourceTimeframe: "1D",
    entryPrice: ENTRY_PRICE,
    lookback: 100,
    candidate: candidateFor(100, "LONG"),
    template: TEMPLATE,
    integrity: "ELIGIBLE",
  });
  const expected = (s: NativeDryAdmissionSnapshot) => ({ executionProfileId: s.executionProfileId, alertId: s.alert.id, extremeRRPlanId: s.plan!.id, source: "NATIVE", symbol: s.alert.symbol, direction: "LONG", selectedLookback: 100 });

  function forms(r: NativeDryAdmission, s: NativeDryAdmissionSnapshot): unknown[] {
    const fabricated = Object.freeze({ ...HANDOFF_FIELDS(s), ...r });
    const wrapped = Object.freeze({ ...r, ...HANDOFF_FIELDS(s) });
    return [r, structuredClone(r), JSON.parse(JSON.stringify(r)), fabricated, wrapped, JSON.parse(JSON.stringify(wrapped)), r.authoritative, ...r.diagnostics];
  }

  for (const [label, graphOf] of [
    ["production graph (switch false)", async () => PRODUCTION],
    ["TEST-ONLY graph with the switch on and a synthetic resolved contract, where the dry verdict ADMITS", async () => testGraph(resolvedAContracts)],
  ] as const) {
    it(`${label}: the real verifier and the creation assertion refuse the result, its copies, its parts and every fabrication from it`, async () => {
      const graph = await graphOf();
      const s = snapshot();
      const r = graph.dry.evaluateNativeDryAdmission(s);
      for (const form of forms(r, s)) {
        expect(graph.canary.verifyNativeAccountAHandoff(form, { executionProfileId: s.executionProfileId })).toMatchObject({ ok: false, reasonCode: "HANDOFF_INVALID" });
        expect(() => graph.canary.assertNativeAccountAHandoff(form, expected(s))).toThrow(graph.Forbidden);
      }
    });
  }

  it("control: in the TEST-ONLY graph a REAL hand-off verifies, and its serialized copy no longer does", async () => {
    const graph = await testGraph(resolvedAContracts);
    const s = snapshot();
    const decision = graph.canary.decideNativeAccountACandidate(productionInputOf(s, graph));
    if (!decision.admitted) throw new Error("expected the test graph to admit");
    expect(graph.canary.verifyNativeAccountAHandoff(decision.handoff, { executionProfileId: s.executionProfileId }).ok).toBe(true);
    expect(graph.canary.verifyNativeAccountAHandoff(JSON.parse(JSON.stringify(decision.handoff)), { executionProfileId: s.executionProfileId }).ok).toBe(false);
    // The dry result for the very same facts admits, and holds nothing the verifier accepts.
    const r = graph.dry.evaluateNativeDryAdmission(s);
    expect(r.authoritative.admitted).toBe(true);
    expect(graph.canary.verifyNativeAccountAHandoff(r, { executionProfileId: s.executionProfileId }).ok).toBe(false);
  });

  it("the result names stages and reasons only: no candidate, price, quantity, budget, order, lease, token or credential", () => {
    const cases = [snapshot(), snapshot({}, { plan: null }), snapshot({}, { occupancy: [row()] }), snapshot({}, { accountGates: { environment: SAFE_GATES, profile: ARMED_PROFILE } })];
    for (const s of cases) {
      const json = JSON.stringify(evaluateNativeDryAdmission(s));
      for (const forbidden of [/handoff/i, /"kind"/, /quantity/i, /notional/i, /orderId/i, /clientOrderId/i, /lease/i, /claimOwner/i, /token/i, /apiKey/i, /secret/i, /signature/i, /"candidate"/, /"money"/, /"template"/]) {
        expect({ forbidden: String(forbidden), hit: forbidden.test(json) }).toEqual({ forbidden: String(forbidden), hit: false });
      }
      for (const value of [ENTRY_PRICE, TEMPLATE.riskAmount, TEMPLATE.referenceCapital, candidateFor(100, "LONG").stopLoss!, candidateFor(100, "LONG").takeProfit!]) {
        expect({ value, hit: json.includes(value) }).toEqual({ value, hit: false });
      }
    }
  });
});

// ===========================================================================
// Determinism and idempotence (section 16)
// ===========================================================================

describe("determinism: same facts, same instant, same result; nothing consumed", () => {
  const all = (): NativeDryAdmissionSnapshot[] => [
    snapshot(),
    snapshot({}, { accountSlot: "ACCOUNT_B", accountPlanPolicy: ACCOUNT_B_POLICY }),
    snapshot({ sourceTf: "1M" }),
    snapshot({}, { plan: null }),
    withEvidence((r) => evidenceOf(r.slice(0, 2), SOURCE_BAR)),
    snapshot({}, { nowMs: EXPIRY + 1 }),
    snapshot({}, { occupancy: [row()] }),
    snapshot({}, { accountGates: { environment: SAFE_GATES, profile: ARMED_PROFILE } }),
    snapshot({}, { phase5: phase5({ session: tradingSession({ openedCount: 3 }) }) }),
  ];

  for (const runs of [1, 10, 100]) {
    it(`${runs} evaluation(s) of every snapshot deep-equal the first, byte for byte`, () => {
      for (const s of all()) {
        const first = evaluateNativeDryAdmission(s);
        const json = JSON.stringify(first);
        for (let i = 0; i < runs; i += 1) {
          const again = evaluateNativeDryAdmission(s);
          expect(again).toStrictEqual(first);
          expect(JSON.stringify(again)).toBe(json);
        }
      }
    });
  }

  it("the wall clock, randomness and identifiers play no part: the same snapshot under two different system clocks gives the same result", () => {
    const uuid = vi.spyOn(globalThis.crypto, "randomUUID");
    const random = vi.spyOn(Math, "random");
    const results: string[] = [];
    for (const wall of [Date.UTC(2020, 0, 1), Date.UTC(2031, 5, 15, 3, 4, 5)]) {
      vi.useFakeTimers({ now: wall });
      results.push(JSON.stringify(all().map((s) => evaluateNativeDryAdmission(s))));
      vi.useRealTimers();
    }
    expect(results[0]).toBe(results[1]);
    expect(uuid).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });

  it("the snapshot is never mutated: a deep-frozen snapshot evaluates, and an unfrozen one is unchanged afterwards", () => {
    const deepFreeze = <T>(value: T): T => {
      if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
      }
      return value;
    };
    for (const s of all()) {
      const before = structuredClone(s);
      evaluateNativeDryAdmission(s);
      expect(s).toStrictEqual(before);
      expect(() => evaluateNativeDryAdmission(deepFreeze(structuredClone(s)))).not.toThrow();
    }
  });

  it("results share no object with the snapshot (nothing the caller holds can change a verdict after the fact)", () => {
    const s = snapshot();
    const r = evaluateNativeDryAdmission(s);
    const reachable = new Set<unknown>();
    const walk = (v: unknown) => {
      if (v !== null && typeof v === "object" && !reachable.has(v)) {
        reachable.add(v);
        Object.values(v as Record<string, unknown>).forEach(walk);
      }
    };
    walk(s);
    const shared: unknown[] = [];
    const scan = (v: unknown) => {
      if (v !== null && typeof v === "object") {
        if (reachable.has(v)) shared.push(v);
        Object.values(v as Record<string, unknown>).forEach(scan);
      }
    };
    scan(r);
    expect(shared).toEqual([]);
  });
});
