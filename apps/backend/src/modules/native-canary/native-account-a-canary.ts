import {
  NATIVE_PLAN_BUILTIN_DEFAULTS,
  parseNativeAccountPlanPolicy,
  previewNativeAccountPlan,
  type ExtremeRRCandidate,
  type ExtremeRRLookback,
  type ExtremeRRPlanDto,
  type ExtremeRRTemplateSnapshot,
  type NativeAccountPlanPolicy,
  type NativeExecutionIntegrityDto,
  type NativeExecutionIntegrityStatus,
} from "@trading-alert-dashboard/shared";

import { NATIVE_ALERT_SOURCE, NativeAlertExecutionForbiddenError } from "../alerts/alert-source";
import { CAPACITY_FREE_STATUSES, TOTAL_ACTIVE_STATUSES } from "../execution/capacity-status";
import type { TradeExecutionStatusName } from "../execution/execution-status";
import {
  judgeNativeExecutionAdmission,
  nativeExecutionIntegrityOf,
  type NativeIntegrityAlert,
  type NativeScannerEvidenceReader,
} from "../native-integrity/native-execution-integrity";
import type { RuntimeMode } from "../operator/account-runtime-transition";
import type { TradingSystemState } from "../operator/trading-control.service";
import { NATIVE_EXECUTION_ENABLED } from "./native-execution-switch";
import { judgeNativeRiskReadiness } from "./native-risk-gate";
import { judgeNativeSignalFreshness, nativeSignalRefusalCodeOf, nativeSignalWindowOf } from "./native-signal-freshness";

/**
 * NATIVE ACCOUNT A CANARY: the path a Native plan must traverse before it
 * could ever be handed to Account A's EXISTING executor.
 *
 *   ACCOUNT           this process is exactly Account A (never B, never a default);
 *   SOURCE            the alert is exactly NATIVE;
 *   SOURCE_TIMEFRAME  exactly 1D or 1W, and the durable payload agrees;
 *   PLAN              the alert's own READY plan. Account A's planner window
 *                     is fixed in code at 100 candles (a LOOKBACK WINDOW, never
 *                     a dollar amount), no process environment can steer it,
 *                     and it must equal the window the plan PERSISTS. The
 *                     candidate must be complete and sized;
 *   FRESHNESS         the signal is inside its Native lifetime, anchored to
 *                     the close of its operational 15m bar
 *                     (native-signal-freshness.ts), at the caller's `nowMs`;
 *   INTEGRITY         the source bar's final scanner evidence is ELIGIBLE;
 *   OCCUPANCY         no other Account A execution holds this symbol + side
 *                     (a pending LIMIT counts) and nothing on the symbol is
 *                     ambiguous;
 *   ACCOUNT_GATES     the existing deterministic Account A gates: runtime
 *                     LIVE_READY and profile ARMED;
 *   NATIVE_FENCE      judgeNativeExecutionAdmission with the hard-coded
 *                     switch. Today it refuses every candidate;
 *   RISK              an explicit Native risk contract for Account A admits the
 *                     plan's risk budget (native-risk-gate.ts). Both contracts
 *                     are UNRESOLVED in code, so it would refuse every candidate
 *                     the switch let through. It sits after the switch, which
 *                     therefore still wins while it is false.
 *
 * Everything here is pure: no database, no file, no network, no clock and no
 * environment. The caller loads the facts and supplies the evaluation instant;
 * this module only judges them, so the same facts always produce the same
 * verdict. Anything unknown, missing or contradictory is refused, never
 * assumed.
 *
 * The only way to obtain a NativeAccountAHandoff, the capability the executor
 * and execution creation demand, is `decideNativeAccountACandidate` admitting
 * a candidate, which requires NATIVE_EXECUTION_ENABLED and a RESOLVED Native
 * risk contract for Account A. Neither holds today, so no hand-off can exist
 * and no Native TradeExecution can be created.
 *
 * What this module does NOT decide: the natural-window claim, the session
 * budget, capacity limits and total risk/margin admission belong to the
 * existing Phase 5 SafetyAdmission, which a Native execution would pass
 * through under its own lock and with its own canonical reason codes. The
 * RISK stage is not that: it is the per-trade Native approval Phase 5 has no
 * notion of, and it never replaces any Phase 5 limit.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The only Native source timeframes the Account A canary could ever act on. */
export const NATIVE_CANARY_SOURCE_TIMEFRAMES = ["1D", "1W"] as const;
export type NativeCanarySourceTimeframe = (typeof NATIVE_CANARY_SOURCE_TIMEFRAMES)[number];

/** Which account THIS process is, from its launch environment. */
export type NativeAccountSlot = "ACCOUNT_A" | "ACCOUNT_B" | "GENERIC" | "UNKNOWN";

export const NATIVE_CANARY_STAGES = [
  "ACCOUNT",
  "SOURCE",
  "SOURCE_TIMEFRAME",
  "PLAN",
  "FRESHNESS",
  "INTEGRITY",
  "OCCUPANCY",
  "ACCOUNT_GATES",
  "NATIVE_FENCE",
  "RISK",
] as const;
export type NativeCanaryStage = (typeof NATIVE_CANARY_STAGES)[number];

export const NATIVE_CANARY_REASON_CODES = [
  // ACCOUNT
  "ACCOUNT_NOT_A",
  // SOURCE
  "SOURCE_NOT_NATIVE",
  // SOURCE_TIMEFRAME
  "SOURCE_TF_NOT_EXECUTABLE",
  // PLAN
  "PLAN_NOT_FOR_ALERT",
  "PLAN_NOT_READY",
  "PLAN_INCOMPLETE",
  "ACCOUNT_PLAN_UNRESOLVED",
  "PLAN_LOOKBACK_MISMATCH",
  // FRESHNESS (native-signal-freshness.ts's own refusal codes)
  "NATIVE_SIGNAL_STALE",
  "NATIVE_SIGNAL_TIME_UNAVAILABLE",
  // INTEGRITY (the canonical integrity status travels with the refusal)
  "INTEGRITY_PENDING_BAR_CLOSE",
  "INTEGRITY_INELIGIBLE",
  "INTEGRITY_UNREADABLE",
  // OCCUPANCY
  "SAME_SYMBOL_SIDE_OCCUPIED",
  // ACCOUNT_GATES
  "ACCOUNT_NOT_LIVE_READY",
  "ACCOUNT_NOT_ARMED",
  // NATIVE_FENCE: judgeNativeExecutionAdmission's own canonical reasons
  "NATIVE_EXECUTION_DISABLED",
  "NATIVE_INTEGRITY_NOT_ELIGIBLE",
  // RISK (native-risk-gate.ts's own refusal codes)
  "NATIVE_RISK_UNRESOLVED",
  "NATIVE_RISK_BUDGET_INVALID",
  "NATIVE_RISK_EXCEEDS_CONTRACT",
  // Any stage: unknown, missing or contradictory state
  "AMBIGUOUS_STATE",
] as const;
export type NativeCanaryReasonCode = (typeof NATIVE_CANARY_REASON_CODES)[number];

export interface NativeCanaryRefusal {
  readonly admitted: false;
  readonly stage: NativeCanaryStage;
  readonly reasonCode: NativeCanaryReasonCode;
  readonly detail: string;
  /** The canonical integrity status, whenever one was known. */
  readonly integrity: NativeExecutionIntegrityStatus | null;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The Alert row fields the canary reads. */
export interface NativeCanaryAlert {
  readonly id: string;
  readonly source: string | null | undefined;
  readonly symbol: string;
  readonly signal: string | null | undefined;
  readonly sourceTimeframe: string | null | undefined;
  /** Alert.triggeredAt: the exchange event time of the touch. */
  readonly triggeredAt: Date | null | undefined;
  readonly rawPayload: unknown;
}

/** The persisted plan, exactly as the read-only plan service returns it. */
export type NativeCanaryPlan = Pick<
  ExtremeRRPlanDto,
  "id" | "alertId" | "alertSource" | "status" | "direction" | "entryPrice" | "candidates" | "template" | "errorReason" | "selectedLookback"
>;

/** One local execution on the candidate's symbol, as durable state holds it. */
export interface NativeOccupancyRow {
  readonly id: string;
  /** The alert that execution was created from (null once retention nulls it). */
  readonly alertId: string | null;
  readonly symbol: string;
  readonly status: string;
  readonly direction: string;
  readonly positionSide: string;
  readonly requiresManualIntervention: boolean;
  /** This execution's ENTRY orders (normally none or one). */
  readonly entryOrders: readonly { readonly status: string; readonly submissionUnknown: boolean }[];
}

/** The existing deterministic Account A gates, as this process loaded them. */
export interface NativeAccountGates {
  /** EXECUTION_GLOBAL_KILL_SWITCH / EXECUTION_LIVE_ENTRY_ENABLED / EXECUTION_PROTECTION_READY. */
  readonly environment: { readonly globalKillSwitch: unknown; readonly liveEntryEnabled: unknown; readonly protectionReady: unknown };
  /** The bound profile's durable flags; null when the profile could not be read. */
  readonly profile: { readonly isEnabled: unknown; readonly killSwitchActive: unknown } | null;
}

export interface NativeCanaryInput {
  readonly accountSlot: NativeAccountSlot;
  readonly executionProfileId: string;
  readonly alert: NativeCanaryAlert;
  /** Null when the alert has no plan. */
  readonly plan: NativeCanaryPlan | null;
  /**
   * Account A's Native planner-window policy (a lookback in candles, never
   * risk). Production builds it with `nativeAccountAExecutionPolicy`; anything
   * but the code-fixed built-in window is refused.
   */
  readonly accountPlanPolicy: NativeAccountPlanPolicy;
  /** The source bar's verdict, evaluated freshly by the caller; null when none could be produced. */
  readonly integrity: NativeExecutionIntegrityDto | null;
  /** Every local execution of this profile on the symbol that is not plainly finished; null when unread. */
  readonly occupancy: readonly NativeOccupancyRow[] | null;
  readonly accountGates: NativeAccountGates;
  /** The evaluation instant (epoch ms), supplied by the caller: this module never reads a clock. */
  readonly nowMs: number;
}

/** What survives every stage before the fence: the resolved Account A candidate. */
export interface NativeAccountACandidate {
  readonly executionProfileId: string;
  readonly alertId: string;
  readonly planId: string;
  readonly symbol: string;
  readonly direction: "LONG" | "SHORT";
  readonly sourceTimeframe: NativeCanarySourceTimeframe;
  readonly entryPrice: string;
  /** Account A's planner LOOKBACK WINDOW in candles (A = 100 by default). Never a dollar amount. */
  readonly lookback: ExtremeRRLookback;
  readonly candidate: ExtremeRRCandidate;
  readonly template: ExtremeRRTemplateSnapshot;
}

export type NativeCanaryEvaluation =
  | { readonly ok: false; readonly refusal: NativeCanaryRefusal }
  | { readonly ok: true; readonly candidate: NativeAccountACandidate };

// ---------------------------------------------------------------------------
// Occupancy: max ONE active or pending execution per symbol + side
// ---------------------------------------------------------------------------

/**
 * Statuses that hold the symbol + side for this rule. A PLAN_READY row counts
 * (it is waiting for admission) and so does a resting LIMIT (ENTRY_PENDING).
 * Derived from the canonical capacity groups, so a status added there is
 * classified here too.
 */
export const NATIVE_OCCUPYING_STATUSES: readonly TradeExecutionStatusName[] = [
  "PLAN_READY",
  ...TOTAL_ACTIVE_STATUSES.filter((status) => status !== "MANUAL_INTERVENTION"),
];

/** Finished statuses: free, unless their own entry order might still be live. */
export const NATIVE_FINISHED_STATUSES: readonly TradeExecutionStatusName[] = CAPACITY_FREE_STATUSES.filter((status) => status !== "PLAN_READY");

/** ENTRY order states in which an order may exist on the exchange. */
export const POSSIBLY_LIVE_ENTRY_ORDER_STATUSES = ["SUBMITTING", "NEW", "PARTIALLY_FILLED", "UNKNOWN"] as const;

export type NativeOccupancyVerdict =
  | { readonly occupied: false }
  | { readonly occupied: true; readonly reasonCode: "SAME_SYMBOL_SIDE_OCCUPIED" | "AMBIGUOUS_STATE"; readonly executionId: string | null; readonly detail: string };

const SIDES = new Set(["LONG", "SHORT"]);

/**
 * Same symbol + same side, from durable local state only.
 *
 *  - an unread state (null) is never treated as free;
 *  - MANUAL_INTERVENTION, the manual flag, a BOTH (one-way) position side, a
 *    direction that disagrees with its position side, an unknown status, or a
 *    finished row whose entry order might still be live: AMBIGUOUS on this
 *    symbol, whichever side it is on;
 *  - an occupying status on the SAME side: occupied;
 *  - the opposite side or another symbol: no collision under this rule.
 *
 * The candidate's OWN execution (same alert) is never its occupant: a retry
 * after a crash must find its execution, not be refused by it.
 *
 * "No row" proves only that nothing LOCAL holds the slot. Exchange exposure is
 * still checked later by the existing signed revalidation, which also refuses
 * any other local execution on the symbol, whichever side.
 *
 * This judgment is a READ. Taken alone it cannot stop two candidates that read
 * concurrently; `reserveNativeOccupancy` (native-occupancy.ts) repeats it under
 * a (profile, symbol, side) lock in the creating transaction, and that repeat
 * is the authoritative one.
 */
export function judgeSameSymbolSideOccupancy(
  rows: readonly NativeOccupancyRow[] | null,
  target: { readonly symbol: string; readonly positionSide: "LONG" | "SHORT"; readonly alertId?: string }
): NativeOccupancyVerdict {
  if (rows === null) {
    return { occupied: true, reasonCode: "AMBIGUOUS_STATE", executionId: null, detail: "Local execution state could not be read; an unread state is never treated as free." };
  }
  const symbol = target.symbol.trim().toUpperCase();
  const ambiguous: { id: string; why: string }[] = [];
  const occupying: string[] = [];
  for (const row of rows) {
    if (row.symbol.trim().toUpperCase() !== symbol) continue;
    if (target.alertId !== undefined && row.alertId !== null && row.alertId === target.alertId) continue;
    if (!SIDES.has(row.positionSide)) {
      ambiguous.push({ id: row.id, why: `position side ${row.positionSide} cannot be attributed to one side` });
      continue;
    }
    if (row.direction !== row.positionSide) {
      ambiguous.push({ id: row.id, why: `direction ${row.direction} disagrees with position side ${row.positionSide}` });
      continue;
    }
    if (row.status === "MANUAL_INTERVENTION" || row.requiresManualIntervention) {
      ambiguous.push({ id: row.id, why: "it needs manual intervention, so its exposure is unknown" });
      continue;
    }
    if ((NATIVE_OCCUPYING_STATUSES as readonly string[]).includes(row.status)) {
      if (row.positionSide === target.positionSide) occupying.push(row.id);
      continue;
    }
    if ((NATIVE_FINISHED_STATUSES as readonly string[]).includes(row.status)) {
      const live = row.entryOrders.some((o) => o.submissionUnknown || (POSSIBLY_LIVE_ENTRY_ORDER_STATUSES as readonly string[]).includes(o.status));
      if (live) ambiguous.push({ id: row.id, why: `it is ${row.status} but its entry order may still be live` });
      continue;
    }
    ambiguous.push({ id: row.id, why: `its status ${row.status} is not one this rule knows` });
  }
  const first = (ids: readonly string[]) => ids.reduce((a, b) => (b < a ? b : a));
  if (ambiguous.length > 0) {
    const id = first(ambiguous.map((a) => a.id));
    const why = ambiguous.find((a) => a.id === id)!.why;
    return { occupied: true, reasonCode: "AMBIGUOUS_STATE", executionId: id, detail: `Execution ${id} on ${symbol} is ambiguous: ${why}.` };
  }
  if (occupying.length > 0) {
    const id = first(occupying);
    return { occupied: true, reasonCode: "SAME_SYMBOL_SIDE_OCCUPIED", executionId: id, detail: `Execution ${id} already holds ${symbol} ${target.positionSide} for this account.` };
  }
  return { occupied: false };
}

// ---------------------------------------------------------------------------
// The existing deterministic account gates, in their canonical vocabulary
// ---------------------------------------------------------------------------

/**
 * The account's runtime mode from its three live-entry gates. Same mapping as
 * `effectiveModeFromWire`, and a test holds the two equal over every input.
 */
export function nativeRuntimeModeOf(environment: NativeAccountGates["environment"]): RuntimeMode | "INVALID" | "UNKNOWN" {
  const { globalKillSwitch: kill, liveEntryEnabled: live, protectionReady: protection } = environment;
  if (typeof kill !== "boolean" || typeof live !== "boolean" || typeof protection !== "boolean") return "UNKNOWN";
  if (kill && !live && !protection) return "SAFE";
  if (!kill && live && protection) return "LIVE_READY";
  return "INVALID";
}

/**
 * The profile's trading-system state. Same mapping as `mapTradingSystemState`,
 * and a test holds the two equal over every input.
 */
export function nativeTradingStateOf(profile: NativeAccountGates["profile"]): TradingSystemState {
  const isEnabled = profile?.isEnabled;
  const killSwitchActive = profile?.killSwitchActive;
  if (typeof isEnabled !== "boolean" || typeof killSwitchActive !== "boolean") return "UNKNOWN";
  if (!isEnabled && killSwitchActive) return "SAFE_OFF";
  if (isEnabled && !killSwitchActive) return "ARMED";
  if (isEnabled && killSwitchActive) return "SAFE_RECOVERY";
  return "INVALID";
}

// ---------------------------------------------------------------------------
// Account A's execution window: fixed in code, never taken from a process
// ---------------------------------------------------------------------------

/**
 * The planner-window policy the Account A canary EXECUTES with.
 *
 * A READY plan persists candidates for every window and one selected window;
 * it persists no per-account window. The per-account defaults (A 100, B 300)
 * are resolved at read time, and the optional NATIVE_PLAN_DEFAULT_LOOKBACK_A
 * override is a generic-process preview setting. If the Account A worker
 * resolved its window from ITS OWN environment, a mismatched account-a.env
 * could silently execute a different window than the plan and the preview
 * show.
 *
 * So execution never takes its window from any environment: it is the
 * user-approved built-in default, NATIVE_PLAN_BUILTIN_DEFAULTS.A (100
 * candles). An explicit override in the account process that agrees with it
 * changes nothing. Any other value is refused (INVALID), so a misconfigured
 * account-a.env is visible instead of silently ignored or obeyed. The decision
 * additionally requires the window to equal the plan's own persisted
 * selection.
 */
export function nativeAccountAExecutionPolicy(accountProcessOverride: unknown): NativeAccountPlanPolicy {
  const builtIn = parseNativeAccountPlanPolicy("A", undefined);
  if (accountProcessOverride === undefined || accountProcessOverride === null || accountProcessOverride === "") return builtIn;
  const parsed = parseNativeAccountPlanPolicy("A", accountProcessOverride);
  if (parsed.state === "RESOLVED" && parsed.lookback === NATIVE_PLAN_BUILTIN_DEFAULTS.A) return builtIn;
  const shown = typeof accountProcessOverride === "string" ? JSON.stringify(accountProcessOverride.slice(0, 16)) : typeof accountProcessOverride;
  return {
    account: "A",
    state: "INVALID",
    lookback: null,
    source: "ENV_OVERRIDE",
    reason: `This account process sets NATIVE_PLAN_DEFAULT_LOOKBACK_A=${shown}; Native execution takes no window from a process environment (Account A's is fixed at ${NATIVE_PLAN_BUILTIN_DEFAULTS.A} candles).`,
  };
}

// ---------------------------------------------------------------------------
// The stages
//
// Each stage is its own pure kernel, so the decision below and the Native dry
// admission (native-dry-admission.ts) judge a stage with the SAME code. The
// decision composes them in the documented order; nothing else defines what a
// stage means.
// ---------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** One stage's verdict: refused, or passed carrying what later stages need. */
export type NativeCanaryStageVerdict<T = null> =
  | { readonly ok: false; readonly refusal: NativeCanaryRefusal }
  | { readonly ok: true; readonly value: T };

function refusal(
  stage: NativeCanaryStage,
  reasonCode: NativeCanaryReasonCode,
  detail: string,
  integrity: NativeExecutionIntegrityStatus | null = null
): { readonly ok: false; readonly refusal: NativeCanaryRefusal } {
  return { ok: false, refusal: { admitted: false, stage, reasonCode, detail, integrity } };
}

const PASSED: { readonly ok: true; readonly value: null } = Object.freeze({ ok: true, value: null });

const INTEGRITY_REFUSALS: Readonly<Record<string, NativeCanaryReasonCode>> = Object.freeze({
  PENDING_BAR_CLOSE: "INTEGRITY_PENDING_BAR_CLOSE",
  UNREADABLE: "INTEGRITY_UNREADABLE",
  INELIGIBLE_REQUARANTINED: "INTEGRITY_INELIGIBLE",
  INELIGIBLE_GAP: "INTEGRITY_INELIGIBLE",
  INELIGIBLE_DUPLICATE: "INTEGRITY_INELIGIBLE",
  INELIGIBLE_CHECKPOINT_MISMATCH: "INTEGRITY_INELIGIBLE",
  INELIGIBLE_STALE_GENERATION: "INTEGRITY_INELIGIBLE",
});

/** ACCOUNT: exactly Account A, from this process's own launch identity, with Account A's policy. */
export function nativeAccountStage(accountSlot: NativeAccountSlot, policy: NativeAccountPlanPolicy): NativeCanaryStageVerdict {
  if (accountSlot === "UNKNOWN") {
    return refusal("ACCOUNT", "AMBIGUOUS_STATE", "This process could not prove which account it is; an unproven account is never Account A.");
  }
  if (accountSlot !== "ACCOUNT_A") {
    return refusal("ACCOUNT", "ACCOUNT_NOT_A", `This process is ${accountSlot}; the Native canary is Account A only.`);
  }
  if (policy.account !== "A") {
    return refusal("ACCOUNT", "AMBIGUOUS_STATE", `The planner-window policy offered belongs to account ${String(policy.account)}, not A.`);
  }
  return PASSED;
}

/** SOURCE: the alert is exactly NATIVE. */
export function nativeSourceStage(alert: Pick<NativeCanaryAlert, "source">): NativeCanaryStageVerdict {
  if (alert.source !== NATIVE_ALERT_SOURCE) {
    return refusal("SOURCE", "SOURCE_NOT_NATIVE", `The alert source is ${String(alert.source)}, not NATIVE.`);
  }
  return PASSED;
}

/** SOURCE_TIMEFRAME: exactly 1D or 1W, and the durable payload must agree. */
export function nativeSourceTimeframeStage(
  alert: Pick<NativeCanaryAlert, "sourceTimeframe" | "rawPayload">
): NativeCanaryStageVerdict<NativeCanarySourceTimeframe> {
  const tf = alert.sourceTimeframe;
  if (typeof tf !== "string" || !(NATIVE_CANARY_SOURCE_TIMEFRAMES as readonly string[]).includes(tf)) {
    return refusal("SOURCE_TIMEFRAME", "SOURCE_TF_NOT_EXECUTABLE", `Source timeframe ${JSON.stringify(tf ?? null)} is not executable; only 1D and 1W are.`);
  }
  const payloadTf = isObject(alert.rawPayload) && isObject(alert.rawPayload.delivery) ? alert.rawPayload.delivery.sourceTimeframe : undefined;
  if (payloadTf !== tf) {
    return refusal("SOURCE_TIMEFRAME", "AMBIGUOUS_STATE", `The alert says ${tf} but its durable payload says ${JSON.stringify(payloadTf ?? null)}.`);
  }
  return { ok: true, value: tf as NativeCanarySourceTimeframe };
}

/** What the PLAN stage resolves: Account A's candidate, from the plan's own persisted state. */
export interface NativeCanaryResolvedPlan {
  readonly planId: string;
  readonly direction: "LONG" | "SHORT";
  readonly entryPrice: string;
  /** Account A's planner LOOKBACK WINDOW in candles. Never a dollar amount. */
  readonly lookback: ExtremeRRLookback;
  readonly candidate: ExtremeRRCandidate;
  readonly template: ExtremeRRTemplateSnapshot;
}

/** PLAN: the alert's own READY plan, resolved for Account A's code-fixed window. */
export function nativePlanStage(
  alert: Pick<NativeCanaryAlert, "id" | "source" | "signal">,
  plan: NativeCanaryPlan | null,
  policy: NativeAccountPlanPolicy
): NativeCanaryStageVerdict<NativeCanaryResolvedPlan> {
  if (plan === null) return refusal("PLAN", "PLAN_NOT_READY", "The alert has no plan.");
  if (plan.alertId !== alert.id) return refusal("PLAN", "PLAN_NOT_FOR_ALERT", `Plan ${plan.id} belongs to alert ${plan.alertId}, not ${alert.id}.`);
  if (plan.alertSource !== alert.source) {
    return refusal("PLAN", "AMBIGUOUS_STATE", `The plan records source ${String(plan.alertSource)} but the alert is ${String(alert.source)}.`);
  }
  if (plan.status !== "READY") return refusal("PLAN", "PLAN_NOT_READY", `Plan is ${plan.status}${plan.errorReason ? `: ${plan.errorReason}` : ""}.`);
  if (plan.direction !== "LONG" && plan.direction !== "SHORT") {
    return refusal("PLAN", "AMBIGUOUS_STATE", `Plan direction ${String(plan.direction)} is not LONG or SHORT.`);
  }
  if (alert.signal !== plan.direction) {
    return refusal("PLAN", "AMBIGUOUS_STATE", `The alert signal ${String(alert.signal)} disagrees with the plan direction ${plan.direction}.`);
  }
  // Account A's window is the code-fixed built-in; nothing else may stand in for it.
  if (policy.state === "INVALID") return refusal("PLAN", "ACCOUNT_PLAN_UNRESOLVED", policy.reason);
  if (policy.lookback !== NATIVE_PLAN_BUILTIN_DEFAULTS.A || policy.source !== "BUILTIN_DEFAULT") {
    return refusal(
      "PLAN",
      "ACCOUNT_PLAN_UNRESOLVED",
      `Account A executes only its built-in ${NATIVE_PLAN_BUILTIN_DEFAULTS.A}-candle window; a ${String(policy.lookback)}-candle ${policy.source} policy cannot steer execution.`
    );
  }
  // The plan's PERSISTED window is authoritative for that plan: Account A never
  // executes a window the plan does not itself select.
  if (plan.selectedLookback !== policy.lookback) {
    return refusal(
      "PLAN",
      "PLAN_LOOKBACK_MISMATCH",
      `The plan persists the ${String(plan.selectedLookback)}-candle window, not Account A's ${policy.lookback}-candle window.`
    );
  }
  const preview = previewNativeAccountPlan(plan, policy);
  if (preview.state === "INVALID_POLICY") {
    return refusal("PLAN", "ACCOUNT_PLAN_UNRESOLVED", preview.reason ?? "Account A's planner-window override is invalid.");
  }
  if (preview.state === "PLAN_NOT_READY") return refusal("PLAN", "PLAN_NOT_READY", preview.reason ?? "The plan is not READY.");
  if (preview.state !== "RESOLVED" || preview.lookback === null) {
    return refusal("PLAN", "PLAN_INCOMPLETE", preview.reason ?? `No usable candidate for Account A's ${String(preview.lookback)}-candle window.`);
  }
  const lookback = preview.lookback;
  const matches = plan.candidates.filter((c) => c.requestedCandles === lookback);
  if (matches.length !== 1) {
    return refusal("PLAN", "AMBIGUOUS_STATE", `The plan holds ${matches.length} candidates for the ${lookback}-candle window, not exactly one.`);
  }
  const candidate = matches[0];
  if (candidate.complete !== true) {
    return refusal("PLAN", "PLAN_INCOMPLETE", `Only ${candidate.actualCandles} of ${lookback} candles were available for Account A's window.`);
  }
  if (plan.template === null) return refusal("PLAN", "PLAN_INCOMPLETE", "The plan carries no frozen risk-template snapshot, so it has no risk budget.");
  if (candidate.money === null || candidate.stopLoss === null || candidate.takeProfit === null) {
    return refusal("PLAN", "PLAN_INCOMPLETE", "Account A's candidate is not a complete, money-carrying plan.");
  }
  if (typeof plan.entryPrice !== "string" || plan.entryPrice.trim() === "") {
    return refusal("PLAN", "PLAN_INCOMPLETE", "The plan carries no entry price.");
  }
  return {
    ok: true,
    value: { planId: plan.id, direction: plan.direction, entryPrice: plan.entryPrice, lookback, candidate, template: plan.template },
  };
}

/**
 * FRESHNESS: inside the Native lifetime of its operational 15m bar, at `nowMs`
 * (native-signal-freshness.ts). Judged before integrity, so a bar still
 * forming is never refused merely because 300 seconds passed, and a signal
 * past its window is refused as stale, permanently, even if its bar never
 * closed cleanly.
 */
export function nativeFreshnessStage(alert: NativeCanaryAlert, nowMs: number): NativeCanaryStageVerdict {
  const freshness = judgeNativeSignalFreshness(nativeSignalWindowOf(alert), nowMs);
  if (!freshness.fresh) return refusal("FRESHNESS", nativeSignalRefusalCodeOf(freshness), `${freshness.message}.`);
  return PASSED;
}

/** INTEGRITY: only ELIGIBLE passes; the canonical integrity status travels with the refusal. */
export function nativeIntegrityStage(integrity: NativeExecutionIntegrityDto | null): NativeCanaryStageVerdict {
  if (integrity === null) return refusal("INTEGRITY", "INTEGRITY_UNREADABLE", "No integrity verdict could be produced for the source bar.");
  if (integrity.status !== "ELIGIBLE") {
    const code = INTEGRITY_REFUSALS[integrity.status];
    if (code === undefined) return refusal("INTEGRITY", "INTEGRITY_UNREADABLE", `Unknown integrity status ${JSON.stringify(integrity.status)}.`);
    return refusal("INTEGRITY", code, integrity.reason, integrity.status);
  }
  return PASSED;
}

/** OCCUPANCY: max one active/pending execution per symbol + side, from durable local state. */
export function nativeOccupancyStage(
  rows: readonly NativeOccupancyRow[] | null,
  target: { readonly symbol: string; readonly positionSide: "LONG" | "SHORT"; readonly alertId: string }
): NativeCanaryStageVerdict {
  const occupancy = judgeSameSymbolSideOccupancy(rows, target);
  if (occupancy.occupied) return refusal("OCCUPANCY", occupancy.reasonCode, occupancy.detail, "ELIGIBLE");
  return PASSED;
}

/** ACCOUNT_GATES: the existing deterministic Account A gates, runtime LIVE_READY and profile ARMED. */
export function nativeAccountGatesStage(gates: NativeAccountGates): NativeCanaryStageVerdict {
  const mode = nativeRuntimeModeOf(gates.environment);
  if (mode !== "LIVE_READY") {
    return refusal("ACCOUNT_GATES", "ACCOUNT_NOT_LIVE_READY", `Account A's runtime is ${mode}, not LIVE_READY.`, "ELIGIBLE");
  }
  const state = nativeTradingStateOf(gates.profile);
  if (state !== "ARMED") return refusal("ACCOUNT_GATES", "ACCOUNT_NOT_ARMED", `Account A's profile is ${state}, not ARMED.`, "ELIGIBLE");
  return PASSED;
}

/**
 * NATIVE_FENCE: judgeNativeExecutionAdmission with the hard-coded switch, read
 * HERE. Today it refuses every candidate NATIVE_EXECUTION_DISABLED.
 */
export function nativeFenceStage(integrity: NativeExecutionIntegrityDto | null): NativeCanaryStageVerdict {
  const admission = judgeNativeExecutionAdmission({ nativeExecutionEnabled: NATIVE_EXECUTION_ENABLED, integrity });
  if (admission.admitted) return PASSED;
  return refusal(
    "NATIVE_FENCE",
    admission.reason,
    admission.reason === "NATIVE_EXECUTION_DISABLED"
      ? "Native execution is hard-disabled in code (NATIVE_EXECUTION_ENABLED = false)."
      : `The source bar's integrity is ${String(admission.integrity)}, not ELIGIBLE.`,
    admission.integrity
  );
}

/** RISK: the code-fixed Native risk contract for this process's account admits the budget (native-risk-gate.ts). */
export function nativeRiskStage(accountSlot: NativeAccountSlot, riskBudgetUsd: unknown): NativeCanaryStageVerdict {
  const risk = judgeNativeRiskReadiness(accountSlot, riskBudgetUsd);
  if (!risk.ready) return refusal("RISK", risk.reasonCode, risk.message, "ELIGIBLE");
  return PASSED;
}

// ---------------------------------------------------------------------------
// What the adoption pass asks before (and instead of) deciding
// ---------------------------------------------------------------------------

/**
 * The integrity verdict the adoption feeds the decision: the source bar's
 * scanner evidence judged by the canonical evaluator, for a NATIVE alert only.
 * Anything else has no Native integrity (null), and its SOURCE stage refuses it.
 */
export function nativeCanaryIntegrityOf(alert: NativeIntegrityAlert, evidence: NativeScannerEvidenceReader | null): NativeExecutionIntegrityDto | null {
  if (alert.source !== NATIVE_ALERT_SOURCE) return null;
  return nativeExecutionIntegrityOf(alert, evidence);
}

/**
 * Whether the adoption pass DEFERS a candidate instead of deciding it: its
 * source bar is still forming (PENDING_BAR_CLOSE) and its signal is still
 * fresh. Nothing is written for a deferred candidate, and a later pass offers
 * it again. A forming bar whose signal is no longer fresh is never deferred:
 * the decision records its terminal FRESHNESS refusal.
 */
export function nativeAdoptionDefers(alert: NativeCanaryAlert, integrity: NativeExecutionIntegrityDto | null, nowMs: number): boolean {
  return integrity?.status === "PENDING_BAR_CLOSE" && judgeNativeSignalFreshness(nativeSignalWindowOf(alert), nowMs).fresh;
}

/**
 * Every stage except the hard fence and the risk contract, in order. The
 * first refusal wins and names its stage.
 */
export function evaluateNativeAccountACandidate(input: NativeCanaryInput): NativeCanaryEvaluation {
  const { alert, plan, accountPlanPolicy: policy } = input;

  const account = nativeAccountStage(input.accountSlot, policy);
  if (!account.ok) return account;
  const source = nativeSourceStage(alert);
  if (!source.ok) return source;
  const timeframe = nativeSourceTimeframeStage(alert);
  if (!timeframe.ok) return timeframe;
  const resolved = nativePlanStage(alert, plan, policy);
  if (!resolved.ok) return resolved;
  const freshness = nativeFreshnessStage(alert, input.nowMs);
  if (!freshness.ok) return freshness;
  const integrity = nativeIntegrityStage(input.integrity);
  if (!integrity.ok) return integrity;
  const occupancy = nativeOccupancyStage(input.occupancy, { symbol: alert.symbol, positionSide: resolved.value.direction, alertId: alert.id });
  if (!occupancy.ok) return occupancy;
  const gates = nativeAccountGatesStage(input.accountGates);
  if (!gates.ok) return gates;

  const value = resolved.value;
  return {
    ok: true,
    candidate: {
      executionProfileId: input.executionProfileId,
      alertId: alert.id,
      planId: value.planId,
      symbol: alert.symbol,
      direction: value.direction,
      sourceTimeframe: timeframe.value,
      entryPrice: value.entryPrice,
      lookback: value.lookback,
      candidate: value.candidate,
      template: value.template,
    },
  };
}

// ---------------------------------------------------------------------------
// The decision, and the only way to obtain a hand-off
// ---------------------------------------------------------------------------

/**
 * The capability the executor's Native entry point and execution creation
 * demand. Deep-frozen, and recognised only by identity: a structurally
 * identical object built anywhere else is refused.
 */
export interface NativeAccountAHandoff {
  readonly kind: "NATIVE_ACCOUNT_A_HANDOFF";
  readonly executionProfileId: string;
  readonly alertId: string;
  readonly planId: string;
  readonly symbol: string;
  readonly direction: "LONG" | "SHORT";
  readonly sourceTimeframe: NativeCanarySourceTimeframe;
  readonly entryPrice: string;
  /** Account A's planner LOOKBACK WINDOW in candles (A = 100 by default). Never a dollar amount. */
  readonly lookback: ExtremeRRLookback;
  readonly candidate: Readonly<ExtremeRRCandidate>;
  readonly template: Readonly<ExtremeRRTemplateSnapshot>;
  readonly integrity: "ELIGIBLE";
}

const ISSUED_HANDOFFS = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Module-private: called only by `decideNativeAccountACandidate`, after the full judgment admits. */
function issueHandoff(candidate: NativeAccountACandidate): NativeAccountAHandoff {
  const handoff: NativeAccountAHandoff = deepFreeze({
    kind: "NATIVE_ACCOUNT_A_HANDOFF",
    executionProfileId: candidate.executionProfileId,
    alertId: candidate.alertId,
    planId: candidate.planId,
    symbol: candidate.symbol,
    direction: candidate.direction,
    sourceTimeframe: candidate.sourceTimeframe,
    entryPrice: candidate.entryPrice,
    lookback: candidate.lookback,
    // Copies, so nothing the caller still holds can change what was decided.
    candidate: structuredClone(candidate.candidate),
    template: structuredClone(candidate.template),
    integrity: "ELIGIBLE",
  });
  ISSUED_HANDOFFS.add(handoff);
  return handoff;
}

export type NativeCanaryDecision =
  | NativeCanaryRefusal
  | { readonly admitted: true; readonly handoff: NativeAccountAHandoff };

/** The full judgment WITHOUT issuing anything: what the decision would do, as data. */
export type NativeCanaryJudgment =
  | NativeCanaryRefusal
  | { readonly admitted: true; readonly candidate: NativeAccountACandidate };

/**
 * Every stage, then the hard fence, then the Native risk contract: the whole
 * production judgment, and nothing else. The fence reads NATIVE_EXECUTION_ENABLED
 * itself and the risk gate reads the code-fixed contract itself; no caller can
 * supply either. With the switch false, a candidate that passes every earlier
 * stage is refused NATIVE_EXECUTION_DISABLED. With the switch true, an
 * UNRESOLVED contract refuses it NATIVE_RISK_UNRESOLVED instead.
 *
 * It issues NO hand-off, even when it admits: an admitted judgment is a plain
 * candidate, which neither the executor nor execution creation accepts. That
 * is what lets the Native dry admission ask the real judgment without ever
 * holding execution authority.
 */
export function judgeNativeAccountACandidate(input: NativeCanaryInput): NativeCanaryJudgment {
  const evaluated = evaluateNativeAccountACandidate(input);
  if (!evaluated.ok) return evaluated.refusal;
  const fence = nativeFenceStage(input.integrity);
  if (!fence.ok) {
    // Here every earlier stage has passed, and the refusal says so.
    return fence.refusal.reasonCode === "NATIVE_EXECUTION_DISABLED"
      ? { ...fence.refusal, detail: `Every stage before the hard fence passed; ${fence.refusal.detail}` }
      : fence.refusal;
  }
  // --- RISK: the plan's own risk budget, against Account A's Native contract --
  const risk = nativeRiskStage(input.accountSlot, evaluated.candidate.template.riskAmount);
  if (!risk.ok) return risk.refusal;
  return { admitted: true, candidate: evaluated.candidate };
}

/**
 * The judgment, then, only if it admits, the hand-off: the ONLY way to obtain
 * one. With the switch false no hand-off is ever issued.
 */
export function decideNativeAccountACandidate(input: NativeCanaryInput): NativeCanaryDecision {
  const judgment = judgeNativeAccountACandidate(input);
  if (!judgment.admitted) return judgment;
  return { admitted: true, handoff: issueHandoff(judgment.candidate) };
}

// ---------------------------------------------------------------------------
// Verifying a hand-off
// ---------------------------------------------------------------------------

export type NativeHandoffCheck =
  | { readonly ok: true; readonly handoff: NativeAccountAHandoff }
  | { readonly ok: false; readonly reasonCode: "HANDOFF_INVALID"; readonly message: string };

/** Accepts only a hand-off this module issued, for the given bound profile. */
export function verifyNativeAccountAHandoff(value: unknown, expected: { readonly executionProfileId: string }): NativeHandoffCheck {
  if (value === null || typeof value !== "object" || !ISSUED_HANDOFFS.has(value)) {
    return { ok: false, reasonCode: "HANDOFF_INVALID", message: "Not a hand-off issued by the Native Account A decision." };
  }
  const handoff = value as NativeAccountAHandoff;
  if (handoff.executionProfileId !== expected.executionProfileId) {
    return { ok: false, reasonCode: "HANDOFF_INVALID", message: "The hand-off was issued for a different execution profile." };
  }
  return { ok: true, handoff };
}

/**
 * The creation-time check. Throws the canonical Native fence error unless the
 * value is an issued hand-off for exactly this profile, alert, plan, symbol,
 * direction and planner window, the alert is NATIVE, and Native execution is
 * enabled in code. With the switch false it always throws.
 */
export function assertNativeAccountAHandoff(
  value: unknown,
  expected: {
    readonly executionProfileId: string;
    readonly alertId: string;
    readonly extremeRRPlanId: string | null;
    readonly source: string | null | undefined;
    readonly symbol: string;
    readonly direction: string;
    readonly selectedLookback: number;
  }
): asserts value is NativeAccountAHandoff {
  const check = verifyNativeAccountAHandoff(value, expected);
  const consistent =
    check.ok &&
    expected.source === NATIVE_ALERT_SOURCE &&
    check.handoff.alertId === expected.alertId &&
    check.handoff.planId === expected.extremeRRPlanId &&
    check.handoff.symbol.trim().toUpperCase() === expected.symbol.trim().toUpperCase() &&
    check.handoff.direction === expected.direction &&
    check.handoff.lookback === expected.selectedLookback;
  if (!NATIVE_EXECUTION_ENABLED || !consistent) throw new NativeAlertExecutionForbiddenError("execution", expected.alertId);
}

// ---------------------------------------------------------------------------
// The executor's Native outcome
// ---------------------------------------------------------------------------

export type NativeAccountARefusalCode = NativeCanaryReasonCode | "HANDOFF_INVALID" | "NATIVE_SOURCE_AMBIGUOUS" | "MARGIN_PLAN_NOT_READY";

export type NativeAccountAOutcome =
  | { readonly handled: true; readonly executionId: string; readonly created: boolean; readonly admitted: boolean; readonly reasonCode: string | null }
  | { readonly handled: false; readonly reasonCode: NativeAccountARefusalCode; readonly message: string };
