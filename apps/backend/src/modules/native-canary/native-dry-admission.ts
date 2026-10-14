import type { ExecutionCanaryAuthorization } from "@prisma/client";
import type { NativeAccountPlanPolicy, NativeExecutionIntegrityStatus } from "@trading-alert-dashboard/shared";

import { isSessionBackedWindow, judgeAdmissionAuthorization, type AdmissionAuthorization } from "../execution/natural-authorization";
import { judgeSessionReservation, type SessionReservationFacts } from "../execution/trading-session";
import type { NativeScannerEvidence } from "../native-integrity/native-execution-integrity";
import {
  NATIVE_CANARY_STAGES,
  judgeNativeAccountACandidate,
  nativeAccountGatesStage,
  nativeAccountStage,
  nativeAdoptionDefers,
  nativeCanaryIntegrityOf,
  nativeFenceStage,
  nativeFreshnessStage,
  nativeIntegrityStage,
  nativeOccupancyStage,
  nativePlanStage,
  nativeRiskStage,
  nativeSourceStage,
  nativeSourceTimeframeStage,
  type NativeAccountGates,
  type NativeAccountSlot,
  type NativeCanaryAlert,
  type NativeCanaryPlan,
  type NativeCanaryReasonCode,
  type NativeCanaryStage,
  type NativeCanaryStageVerdict,
  type NativeOccupancyRow,
} from "./native-account-a-canary";

/**
 * NATIVE DRY ADMISSION V1: what the production Native Account A admission
 * would say about one candidate, as data. OBSERVATION ONLY.
 *
 * It answers one question: if this candidate were evaluated at `nowMs`, which
 * admission stages pass, which stage is the authoritative production blocker,
 * and what the pure gates after it would say. It creates no execution
 * authority of any kind.
 *
 * AUTHORITATIVE: `judgeNativeAccountACandidate`, the production judgment
 * itself (ACCOUNT, SOURCE, SOURCE_TIMEFRAME, PLAN, FRESHNESS, INTEGRITY,
 * OCCUPANCY, ACCOUNT_GATES, NATIVE_FENCE, RISK, in that order), stopping at
 * its first refusal; plus whether the adoption pass would DEFER the candidate
 * (`nativeAdoptionDefers`) instead of recording that verdict. Both are the
 * production functions, not copies, and the integrity verdict comes from the
 * canonical evaluator over the snapshot's scanner evidence.
 *
 * DIAGNOSTIC, never authoritative: each stage after the terminal one, judged
 * alone by its own production kernel; Phase 5's authorization and session
 * judgments (`judgeAdmissionAuthorization`, `judgeSessionReservation`); and an
 * explicit NOT_EVALUABLE entry for every later gate that needs the exchange,
 * a database lock or an exchange mutation. A diagnostic never changes the
 * verdict.
 *
 * Pure: the snapshot holds every fact, already read by the caller. The
 * evaluator reads no database, file, network, exchange, environment, queue or
 * clock, writes nothing, and the same snapshot always gives the same
 * deep-frozen result. The result names stages and reasons only: no candidate,
 * quantity, order or exchange id, lease, token, credential or hand-off. Its
 * `authority` is "NONE": the hand-off verifier, execution creation and the
 * executor accept only an identity-registered hand-off from
 * `decideNativeAccountACandidate`, which this module never calls.
 *
 * What it does not model: discovery (a database query whose predicates the
 * judgment re-checks: READY in PLAN, NATIVE in SOURCE, 1D/1W in
 * SOURCE_TIMEFRAME, the trigger-time window in FRESHNESS) and the adoption
 * row's idempotency (a plan already decided for the profile is never decided
 * again).
 */

export const NATIVE_DRY_ADMISSION_POLICY = "NATIVE_DRY_ADMISSION_V1";

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/**
 * The profile's newest natural window, as Phase 5 reads it. A natural window
 * carries no token hash (a row that did would be INVALID), so the snapshot
 * holds no credential material.
 */
export type NativeDryNaturalWindow = ExecutionCanaryAuthorization & { readonly tokenHash: null };

/** The facts Phase 5 loads under its lock to judge authorization, captured once. */
export interface NativeDryPhase5Facts {
  /** How many authorization rows of ANY kind the profile has on record. */
  readonly authorizationCount: number;
  /** The id of an unrevoked EXACT_SIGNAL binding naming this alert, or null. */
  readonly exactBindingId: string | null;
  /** The profile's newest NATURAL_WINDOW row, whatever its state, or null when it has none. */
  readonly newestNaturalWindow: NativeDryNaturalWindow | null;
  /** The trading session loaded for that window's `tradingSessionId`; null when there is no such row. */
  readonly session: SessionReservationFacts | null;
}

/** Every fact the dry admission judges, read beforehand by the caller. */
export interface NativeDryAdmissionSnapshot {
  readonly accountSlot: NativeAccountSlot;
  readonly executionProfileId: string;
  readonly alert: NativeCanaryAlert;
  /** Null when the alert has no plan. */
  readonly plan: NativeCanaryPlan | null;
  /** Account A's planner-window policy (a lookback in candles, never money). */
  readonly accountPlanPolicy: NativeAccountPlanPolicy;
  /** The source bar's scanner evidence, already read; null when none was available. */
  readonly scannerEvidence: NativeScannerEvidence | null;
  /** The profile's local executions on the symbol; null when unread. */
  readonly occupancy: readonly NativeOccupancyRow[] | null;
  readonly accountGates: NativeAccountGates;
  /** Null when the snapshot did not capture them: both Phase 5 diagnostics are then NOT_EVALUABLE. */
  readonly phase5: NativeDryPhase5Facts | null;
  /** The evaluation instant (epoch ms). Required: the evaluator never reads a clock. */
  readonly nowMs: number;
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

/** The gates after the judgment, in production order. */
export const NATIVE_DRY_DOWNSTREAM_STAGES = [
  "EXECUTOR_MARGIN_PLAN",
  "EXECUTION_CREATION",
  "PHASE5_SAFETY_ENGINE",
  "PHASE5_AUTHORIZATION",
  "PHASE5_SESSION_BUDGET",
  "ENTRY_LIFECYCLE",
] as const;
export type NativeDryDownstreamStage = (typeof NATIVE_DRY_DOWNSTREAM_STAGES)[number];

export type NativeDryDiagnosticStage = NativeCanaryStage | NativeDryDownstreamStage;
export type NativeDryDiagnosticStatus = "PASS" | "REFUSE" | "NOT_EVALUABLE";

export interface NativeDryDiagnostic {
  readonly stage: NativeDryDiagnosticStage;
  readonly status: NativeDryDiagnosticStatus;
  /** A refusal's canonical production code; otherwise this module's own PASS or NOT_EVALUABLE code. */
  readonly reason: string;
  readonly detail: string;
  readonly authoritative: false;
}

export interface NativeDryAdmission {
  readonly policy: typeof NATIVE_DRY_ADMISSION_POLICY;
  /** Never anything else: this result cannot be used to execute. */
  readonly authority: "NONE";
  readonly evaluatedAt: string;
  readonly authoritative: {
    /** True only when every production stage admits, which needs the hard switch on. */
    readonly admitted: boolean;
    /**
     * What the adoption pass would do now. DEFER: the source bar is still
     * forming and the signal is still fresh, so nothing is claimed or recorded
     * and a later pass offers it again. DECIDE: the verdict below is recorded.
     */
    readonly adoption: "DEFER" | "DECIDE";
    /** The stage of the first refusal; null when admitted. */
    readonly terminalStage: NativeCanaryStage | null;
    readonly reason: NativeCanaryReasonCode | null;
    readonly detail: string | null;
    /** The canonical integrity status the refusal carries, whenever one was known. */
    readonly integrity: NativeExecutionIntegrityStatus | null;
    /** Every stage before the terminal one, in production order. */
    readonly passedStages: readonly NativeCanaryStage[];
  };
  /** Never authoritative. */
  readonly diagnostics: readonly NativeDryDiagnostic[];
}

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

const STAGE_PASSES: Readonly<Record<NativeCanaryStage, string>> = Object.freeze({
  ACCOUNT: "This process is Account A, with Account A's planner-window policy.",
  SOURCE: "The alert is NATIVE.",
  SOURCE_TIMEFRAME: "The source timeframe is executable and its durable payload agrees.",
  PLAN: "The alert's own READY plan resolves Account A's code-fixed window to a complete candidate.",
  FRESHNESS: "The signal is inside its Native lifetime at the evaluation instant.",
  INTEGRITY: "The source bar's final scanner evidence is ELIGIBLE.",
  OCCUPANCY: "No other local execution holds this symbol and side, and nothing on the symbol is ambiguous.",
  ACCOUNT_GATES: "Account A's runtime is LIVE_READY and its profile is ARMED.",
  NATIVE_FENCE: "Native execution is enabled in code and the source bar is ELIGIBLE.",
  RISK: "Account A's Native risk contract admits the plan's risk budget.",
});

const UNEVALUABLE_GATES: Readonly<Record<"EXECUTOR_MARGIN_PLAN" | "EXECUTION_CREATION" | "PHASE5_SAFETY_ENGINE" | "ENTRY_LIFECYCLE", readonly [string, string]>> = Object.freeze({
  EXECUTOR_MARGIN_PLAN: [
    "REQUIRES_EXCHANGE_READS",
    "The executor sizes its margin plan from the exchange's symbol rules and signed account reads; a dry admission makes no exchange request.",
  ],
  EXECUTION_CREATION: [
    "REQUIRES_DATABASE_LOCK",
    "Creation re-checks the hand-off and repeats OCCUPANCY under the (profile, symbol, side) lock in its own transaction; a dry admission holds no hand-off, takes no lock and creates nothing.",
  ],
  PHASE5_SAFETY_ENGINE: [
    "REQUIRES_EXCHANGE_READS",
    "Admission refuses while any execution needs recovery, then judges local capacity and the account's signed exchange state under its lock; a dry admission reads neither.",
  ],
  ENTRY_LIFECYCLE: [
    "REQUIRES_EXCHANGE_MUTATIONS",
    "The entry lifecycle revalidates against signed reads, then sets margin type and leverage and submits the order, each behind the Native fence; a dry admission makes none of these calls.",
  ],
});

const AUTHORIZATION_PASSES: Readonly<Record<"LEGACY" | "EXACT" | "NATURAL", string>> = Object.freeze({
  LEGACY: "The profile has no authorization history, so admission keeps its pre-authorization behaviour.",
  EXACT: "A durable exact-signal binding names this alert.",
  NATURAL: "The newest natural window is available and admits this side.",
});

function diagnostic(stage: NativeDryDiagnosticStage, status: NativeDryDiagnosticStatus, reason: string, detail: string): NativeDryDiagnostic {
  return { stage, status, reason, detail, authoritative: false };
}

function fromVerdict(stage: NativeCanaryStage, verdict: NativeCanaryStageVerdict<unknown>): NativeDryDiagnostic {
  return verdict.ok
    ? diagnostic(stage, "PASS", "PASSED", STAGE_PASSES[stage])
    : diagnostic(stage, "REFUSE", verdict.refusal.reasonCode, verdict.refusal.detail);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * The dry admission for one snapshot. Pure and total over well-formed
 * snapshots; a `nowMs` that is not an instant throws, since there is nothing
 * to evaluate at.
 */
export function evaluateNativeDryAdmission(snapshot: NativeDryAdmissionSnapshot): NativeDryAdmission {
  const evaluatedAt = new Date(snapshot.nowMs);
  if (!Number.isSafeInteger(snapshot.nowMs) || Number.isNaN(evaluatedAt.getTime())) {
    throw new RangeError("The dry admission needs an epoch-millisecond evaluation instant.");
  }

  // The integrity verdict exactly as the adoption derives it, from evidence already read.
  const evidence = snapshot.scannerEvidence;
  const integrity = nativeCanaryIntegrityOf(snapshot.alert, evidence === null ? null : () => evidence);

  // --- AUTHORITATIVE: the production judgment, unchanged -----------------
  const judgment = judgeNativeAccountACandidate({
    accountSlot: snapshot.accountSlot,
    executionProfileId: snapshot.executionProfileId,
    alert: snapshot.alert,
    plan: snapshot.plan,
    accountPlanPolicy: snapshot.accountPlanPolicy,
    integrity,
    occupancy: snapshot.occupancy,
    accountGates: snapshot.accountGates,
    nowMs: snapshot.nowMs,
  });
  const terminal = judgment.admitted ? null : judgment;
  const passedCount = terminal === null ? NATIVE_CANARY_STAGES.length : NATIVE_CANARY_STAGES.indexOf(terminal.stage);

  // --- DIAGNOSTIC: the stages after the terminal one, each alone ---------
  const planDirection = snapshot.plan?.direction;
  const direction = planDirection === "LONG" || planDirection === "SHORT" ? planDirection : null;
  const noDirection = (stage: NativeDryDiagnosticStage, what: string) =>
    diagnostic(stage, "NOT_EVALUABLE", "NO_PLAN_DIRECTION", `${what} is judged for the plan's side, and the snapshot has no LONG or SHORT plan.`);

  const stageDiagnostic = (stage: NativeCanaryStage): NativeDryDiagnostic => {
    switch (stage) {
      case "ACCOUNT":
        return fromVerdict(stage, nativeAccountStage(snapshot.accountSlot, snapshot.accountPlanPolicy));
      case "SOURCE":
        return fromVerdict(stage, nativeSourceStage(snapshot.alert));
      case "SOURCE_TIMEFRAME":
        return fromVerdict(stage, nativeSourceTimeframeStage(snapshot.alert));
      case "PLAN":
        return fromVerdict(stage, nativePlanStage(snapshot.alert, snapshot.plan, snapshot.accountPlanPolicy));
      case "FRESHNESS":
        return fromVerdict(stage, nativeFreshnessStage(snapshot.alert, snapshot.nowMs));
      case "INTEGRITY":
        return fromVerdict(stage, nativeIntegrityStage(integrity));
      case "OCCUPANCY":
        if (direction === null) return noDirection(stage, "Occupancy");
        return fromVerdict(stage, nativeOccupancyStage(snapshot.occupancy, { symbol: snapshot.alert.symbol, positionSide: direction, alertId: snapshot.alert.id }));
      case "ACCOUNT_GATES":
        return fromVerdict(stage, nativeAccountGatesStage(snapshot.accountGates));
      case "NATIVE_FENCE":
        return fromVerdict(stage, nativeFenceStage(integrity));
      case "RISK":
        // The plan's own frozen risk budget (never its lookback); absent, the gate judges it invalid.
        return fromVerdict(stage, nativeRiskStage(snapshot.accountSlot, snapshot.plan?.template?.riskAmount));
    }
  };

  // --- DIAGNOSTIC: Phase 5's pure authorization and session judgments ----
  const phase5 = snapshot.phase5;
  let authorization: AdmissionAuthorization | null = null;
  let authorizationDiagnostic: NativeDryDiagnostic;
  if (phase5 === null) {
    authorizationDiagnostic = diagnostic("PHASE5_AUTHORIZATION", "NOT_EVALUABLE", "PHASE5_FACTS_NOT_CAPTURED", "The snapshot carries no authorization facts.");
  } else if (direction === null) {
    authorizationDiagnostic = noDirection("PHASE5_AUTHORIZATION", "Admission authorization");
  } else {
    authorization = judgeAdmissionAuthorization(
      { authorizationCount: phase5.authorizationCount, exactBindingId: phase5.exactBindingId, newestNaturalWindow: phase5.newestNaturalWindow },
      direction,
      evaluatedAt
    );
    authorizationDiagnostic = authorization.ok
      ? diagnostic("PHASE5_AUTHORIZATION", "PASS", `AUTHORIZATION_${authorization.mode}`, AUTHORIZATION_PASSES[authorization.mode])
      : diagnostic("PHASE5_AUTHORIZATION", "REFUSE", authorization.reasonCode, authorization.message);
  }

  let sessionDiagnostic: NativeDryDiagnostic;
  if (phase5 === null || authorization === null || !authorization.ok) {
    sessionDiagnostic = diagnostic(
      "PHASE5_SESSION_BUDGET",
      "NOT_EVALUABLE",
      "AUTHORIZATION_NOT_ADMITTED",
      "Admission reserves a session slot only after the authorization admits."
    );
  } else if (authorization.mode !== "NATURAL" || !isSessionBackedWindow(authorization.window)) {
    sessionDiagnostic = diagnostic(
      "PHASE5_SESSION_BUDGET",
      "PASS",
      "NO_SESSION_SLOT_REQUIRED",
      authorization.mode === "NATURAL"
        ? "A legacy natural window is bounded by its own claims, judged with the authorization; it reserves no session slot."
        : `A ${authorization.mode} authorization reserves no session slot.`
    );
  } else {
    const reservation = judgeSessionReservation({
      executionProfileId: snapshot.executionProfileId,
      tradingSessionId: authorization.window.tradingSessionId,
      session: phase5.session,
      now: evaluatedAt,
    });
    sessionDiagnostic = reservation.admits
      ? diagnostic("PHASE5_SESSION_BUDGET", "PASS", "SESSION_SLOT_AVAILABLE", "The window's trading session is active and has budget left.")
      : diagnostic("PHASE5_SESSION_BUDGET", "REFUSE", reservation.reasonCode, reservation.message);
  }

  const marker = (stage: keyof typeof UNEVALUABLE_GATES) => diagnostic(stage, "NOT_EVALUABLE", UNEVALUABLE_GATES[stage][0], UNEVALUABLE_GATES[stage][1]);

  return deepFreeze<NativeDryAdmission>({
    policy: NATIVE_DRY_ADMISSION_POLICY,
    authority: "NONE",
    evaluatedAt: evaluatedAt.toISOString(),
    authoritative: {
      admitted: terminal === null,
      adoption: nativeAdoptionDefers(snapshot.alert, integrity, snapshot.nowMs) ? "DEFER" : "DECIDE",
      terminalStage: terminal === null ? null : terminal.stage,
      reason: terminal === null ? null : terminal.reasonCode,
      detail: terminal === null ? null : terminal.detail,
      integrity: terminal === null ? null : terminal.integrity,
      passedStages: NATIVE_CANARY_STAGES.slice(0, passedCount),
    },
    diagnostics: [
      ...NATIVE_CANARY_STAGES.slice(passedCount + 1).map(stageDiagnostic),
      marker("EXECUTOR_MARGIN_PLAN"),
      marker("EXECUTION_CREATION"),
      marker("PHASE5_SAFETY_ENGINE"),
      authorizationDiagnostic,
      sessionDiagnostic,
      marker("ENTRY_LIFECYCLE"),
    ],
  });
}
