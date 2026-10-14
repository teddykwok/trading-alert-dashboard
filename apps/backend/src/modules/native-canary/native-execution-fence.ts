import type { Prisma, PrismaClient, TradeExecution } from "@prisma/client";
import type { NativeExecutionIntegrityStatus } from "@trading-alert-dashboard/shared";

import { NATIVE_ALERT_SOURCE } from "../alerts/alert-source";
import {
  fileSystemNativeScannerEvidence,
  judgeNativeExecutionAdmission,
  nativeExecutionIntegrityOf,
  type NativeScannerEvidenceReader,
} from "../native-integrity/native-execution-integrity";
import type { NativeAccountSlot } from "./native-account-a-canary";
import { nativeAccountSlotOf } from "./native-account-slot";
import { NATIVE_EXECUTION_ENABLED } from "./native-execution-switch";
import { judgeNativeRiskReadiness, type NativeRiskRefusalCode } from "./native-risk-gate";
import { judgeNativeSignalFreshness, nativeSignalWindowOf, type NativeSignalFreshness } from "./native-signal-freshness";

/**
 * THE NATIVE FINAL FENCE.
 *
 * Every point at which a Native candidate could next cause a private exchange
 * request asks this module first, and asks it AGAIN at the next such point:
 *
 *   - the selected-plan executor, before the margin planner's signed reads;
 *   - the entry lifecycle, before revalidation's signed reads;
 *   - the entry lifecycle, before margin/leverage configuration starts;
 *   - the entry lifecycle, immediately before EACH exposure-increasing call
 *     (marginType, leverage, LIMIT entry), i.e. at the live-entry
 *     authorization boundary itself.
 *
 * Each ask is a fresh judgment: the hard-coded switch, then the source bar's
 * scanner evidence re-read from disk, then the code-fixed Native risk contract
 * against the risk budget the trade would use (native-risk-gate.ts). Nothing
 * is cached between asks, so a verdict reached upstream is never trusted
 * downstream.
 *
 * Today every Native ask is refused NATIVE_EXECUTION_DISABLED, because
 * NATIVE_EXECUTION_ENABLED is false; were the switch true, every ask would
 * still be refused NATIVE_RISK_UNRESOLVED, because no Native risk contract is
 * resolved. TradingView executions are recognised and passed through
 * untouched: for them this fence does not apply.
 *
 * The same module also answers Native SIGNAL FRESHNESS for the boundaries that
 * judge signal age (see the section at the end); that is a time judgment, kept
 * apart from the fence's admissibility judgment.
 *
 * Risk-REDUCING calls (the reconcile GET of an already-reserved order, a TTL or
 * operator cancellation, protection of an existing fill) are deliberately not
 * fenced, exactly as the live-entry gates do not fence them: an order that
 * might exist must always stay observable and cancellable.
 */

/**
 * Written into a Native execution's EXECUTION_CREATED event metadata, in the
 * same transaction that creates the execution. It keeps the execution
 * recognisable as Native after retention nulls its alertId.
 */
export const NATIVE_EXECUTION_MARKER = Object.freeze({ key: "alertSource", value: NATIVE_ALERT_SOURCE });

/** Where the fence reads the source bar's scanner evidence from, and which account it judges for. */
export interface NativeFenceRuntime {
  /** Null = no evidence in this process, so every Native ask is refused. */
  readonly evidence: NativeScannerEvidenceReader | null;
  /**
   * Which account THIS process is, for the Native risk contract. Absent means
   * unproven, which no contract covers, so every Native ask that gets past the
   * switch is refused NATIVE_RISK_UNRESOLVED.
   */
  readonly accountSlot?: NativeAccountSlot;
}

/** The process's own scanner tree (read only) and its own launch identity. */
export function nativeFenceRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): NativeFenceRuntime {
  return { evidence: fileSystemNativeScannerEvidence(env), accountSlot: nativeAccountSlotOf(env) };
}

export type NativeFenceRefusalCode = "NATIVE_EXECUTION_DISABLED" | "NATIVE_INTEGRITY_NOT_ELIGIBLE" | "NATIVE_SOURCE_AMBIGUOUS" | NativeRiskRefusalCode;

export interface NativeFenceRefusal {
  readonly applies: true;
  readonly admitted: false;
  readonly reasonCode: NativeFenceRefusalCode;
  readonly message: string;
  readonly integrity: NativeExecutionIntegrityStatus | null;
}

export type NativeFenceVerdict =
  /** Not a Native execution (TradingView, or a legacy row with no Native marker): this fence does not apply. */
  | { readonly applies: false }
  | { readonly applies: true; readonly admitted: true }
  | NativeFenceRefusal;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Whether an EXECUTION_CREATED metadata blob carries the Native marker. */
export function carriesNativeMarker(metadata: Prisma.JsonValue | null | undefined): boolean {
  return isObject(metadata) && metadata[NATIVE_EXECUTION_MARKER.key] === NATIVE_EXECUTION_MARKER.value;
}

function refuse(reasonCode: NativeFenceRefusalCode, message: string, integrity: NativeExecutionIntegrityStatus | null): NativeFenceRefusal {
  return { applies: true, admitted: false, reasonCode, message, integrity };
}

/** The verdict when the fence applies (it always does to a candidate the caller says is Native). */
export type NativeFenceApplied = Exclude<NativeFenceVerdict, { readonly applies: false }>;

/**
 * The judgment itself, for a NATIVE alert whose durable payload is in hand.
 * `riskBudgetUsd` is the budget the trade would use: the hand-off's frozen
 * template amount in the executor, the execution's frozen riskBudgetUsd after
 * creation.
 */
function judgeNativeAlert(alert: { source: string; symbol: string; rawPayload: unknown }, runtime: NativeFenceRuntime, riskBudgetUsd: unknown): NativeFenceApplied {
  // Never throws for a Native alert: anything unreadable comes back UNREADABLE.
  const integrity = nativeExecutionIntegrityOf(alert, runtime.evidence);
  // The switch is read HERE, never passed in by a caller.
  const admission = judgeNativeExecutionAdmission({ nativeExecutionEnabled: NATIVE_EXECUTION_ENABLED, integrity });
  if (!admission.admitted) {
    if (admission.reason === "NATIVE_EXECUTION_DISABLED") {
      return refuse(
        "NATIVE_EXECUTION_DISABLED",
        "Native execution is hard-disabled in code (NATIVE_EXECUTION_ENABLED = false); no exchange request was made.",
        integrity.status
      );
    }
    return refuse(
      "NATIVE_INTEGRITY_NOT_ELIGIBLE",
      `The source bar's final scanner evidence is ${integrity.status}, not ELIGIBLE; no exchange request was made.`,
      integrity.status
    );
  }
  // The contract is read from code by the gate, for the account this process proved it is.
  const risk = judgeNativeRiskReadiness(runtime.accountSlot ?? "UNKNOWN", riskBudgetUsd);
  if (!risk.ready) return refuse(risk.reasonCode, risk.message, integrity.status);
  return { applies: true, admitted: true };
}

/**
 * For a Native ALERT that is about to enter the executor (no execution row
 * exists yet). Always applies: the caller says the alert is Native, and an
 * alert that turns out not to be is refused, never waved through.
 */
export async function nativeAlertFence(
  prisma: PrismaClient,
  alertId: string,
  runtime: NativeFenceRuntime,
  riskBudgetUsd: string
): Promise<NativeFenceApplied> {
  const alert = await prisma.alert.findUnique({ where: { id: alertId }, select: { source: true, symbol: true, rawPayload: true } });
  if (alert === null || alert.source !== NATIVE_ALERT_SOURCE) {
    return refuse("NATIVE_SOURCE_AMBIGUOUS", "The candidate's alert is missing or is no longer a NATIVE alert; nothing was sent.", null);
  }
  return judgeNativeAlert(alert, runtime, riskBudgetUsd);
}

/**
 * Whether an EXISTING execution is Native, from durable facts only.
 *
 * Native is recognised from either fact: the alert's own source, or the marker
 * the creating transaction wrote. Either one is enough. A marked row whose
 * alert is not NATIVE is AMBIGUOUS; a marked row whose alert is gone
 * (retention) is ALERT_GONE. A row with neither fact is TradingView (or a
 * legacy row): NOT_NATIVE.
 */
type NativeExecutionSource =
  | { readonly kind: "NOT_NATIVE" }
  | { readonly kind: "AMBIGUOUS" }
  | { readonly kind: "ALERT_GONE" }
  | { readonly kind: "NATIVE"; readonly alertId: string };

async function nativeExecutionSourceOf(prisma: PrismaClient, execution: { readonly id: string; readonly alertId: string | null }): Promise<NativeExecutionSource> {
  const alertId = execution.alertId;
  const [alert, created] = await Promise.all([
    alertId === null ? Promise.resolve(null) : prisma.alert.findUnique({ where: { id: alertId }, select: { source: true } }),
    prisma.executionEvent.findFirst({
      where: { tradeExecutionId: execution.id, eventType: "EXECUTION_CREATED" },
      orderBy: { sequenceNumber: "asc" },
      select: { metadata: true },
    }),
  ]);
  const markedNative = carriesNativeMarker(created?.metadata);
  const alertNative = alert?.source === NATIVE_ALERT_SOURCE;
  if (!markedNative && !alertNative) return { kind: "NOT_NATIVE" };
  if (alert !== null && !alertNative) return { kind: "AMBIGUOUS" };
  if (alert === null || alertId === null) return { kind: "ALERT_GONE" };
  return { kind: "NATIVE", alertId };
}

/**
 * For an EXISTING execution, immediately before an exposure-increasing
 * exchange call. Applies to every Native execution (see
 * `nativeExecutionSourceOf`); a row whose two facts contradict each other is
 * refused as ambiguous, and a TradingView row is not touched.
 */
export async function nativeExecutionFence(
  prisma: PrismaClient,
  execution: Pick<TradeExecution, "id" | "alertId" | "riskBudgetUsd">,
  runtime: NativeFenceRuntime
): Promise<NativeFenceVerdict> {
  const source = await nativeExecutionSourceOf(prisma, execution);
  if (source.kind === "NOT_NATIVE") return { applies: false };

  if (source.kind === "AMBIGUOUS") {
    return refuse("NATIVE_SOURCE_AMBIGUOUS", "The execution carries the Native marker but its alert is not NATIVE; nothing was sent.", null);
  }
  if (source.kind === "ALERT_GONE") {
    // The alert is gone (retention), so its evidence cannot be read. The
    // judgment still runs: the switch is checked first, and a missing
    // evidence verdict can only refuse.
    const admission = judgeNativeExecutionAdmission({ nativeExecutionEnabled: NATIVE_EXECUTION_ENABLED, integrity: null });
    if (admission.admitted) return { applies: true, admitted: true };
    return admission.reason === "NATIVE_EXECUTION_DISABLED"
      ? refuse("NATIVE_EXECUTION_DISABLED", "Native execution is hard-disabled in code (NATIVE_EXECUTION_ENABLED = false); no exchange request was made.", null)
      : refuse("NATIVE_INTEGRITY_NOT_ELIGIBLE", "The Native execution's alert no longer exists, so its source bar cannot be verified; no exchange request was made.", null);
  }

  const full = await prisma.alert.findUnique({ where: { id: source.alertId }, select: { source: true, symbol: true, rawPayload: true } });
  if (full === null || full.source !== NATIVE_ALERT_SOURCE) {
    return refuse("NATIVE_SOURCE_AMBIGUOUS", "The Native execution's alert changed while it was being read; nothing was sent.", null);
  }
  // toFixed: the exact decimal, never exponent notation.
  return judgeNativeAlert(full, runtime, execution.riskBudgetUsd?.toFixed());
}

// ---------------------------------------------------------------------------
// Native signal freshness, where a boundary judges signal age
// ---------------------------------------------------------------------------

const SIGNAL_SELECT = { source: true, symbol: true, triggeredAt: true, rawPayload: true } as const;

const noWindow = (reason: string, nowMs: number): NativeSignalFreshness => judgeNativeSignalFreshness({ ok: false, reason }, nowMs);

/**
 * The executor's question, immediately before its first signed request: is the
 * candidate's signal still fresh at `evaluatedAt`? Always applies; a missing or
 * non-NATIVE alert proves no window and is refused.
 */
export async function nativeAlertSignalFreshness(prisma: PrismaClient, alertId: string, evaluatedAt: Date): Promise<NativeSignalFreshness> {
  const alert = await prisma.alert.findUnique({ where: { id: alertId }, select: SIGNAL_SELECT });
  if (alert === null) return noWindow("the candidate's alert no longer exists", evaluatedAt.getTime());
  return judgeNativeSignalFreshness(nativeSignalWindowOf(alert), evaluatedAt.getTime());
}

/**
 * For an EXISTING execution, wherever signal age is judged (Phase 5 admission,
 * entry revalidation, PREFLIGHT release). NOT_NATIVE executions get
 * `applies: false` and keep their own unchanged rule; every Native execution
 * gets the Native verdict. The execution's frozen signalTriggeredAt must be
 * its alert's own instant, and an execution whose alert is ambiguous or gone
 * proves no window.
 */
export async function nativeExecutionSignalFreshness(
  prisma: PrismaClient,
  execution: Pick<TradeExecution, "id" | "alertId" | "signalTriggeredAt">,
  evaluatedAt: Date
): Promise<{ readonly applies: false } | { readonly applies: true; readonly freshness: NativeSignalFreshness }> {
  const source = await nativeExecutionSourceOf(prisma, execution);
  if (source.kind === "NOT_NATIVE") return { applies: false };
  const nowMs = evaluatedAt.getTime();
  if (source.kind === "AMBIGUOUS") return { applies: true, freshness: noWindow("the execution carries the Native marker but its alert is not NATIVE", nowMs) };
  if (source.kind === "ALERT_GONE") return { applies: true, freshness: noWindow("the Native execution's alert no longer exists, so its bar cannot be proven", nowMs) };
  const alert = await prisma.alert.findUnique({ where: { id: source.alertId }, select: SIGNAL_SELECT });
  if (alert === null || alert.source !== NATIVE_ALERT_SOURCE) {
    return { applies: true, freshness: noWindow("the Native execution's alert changed while it was being read", nowMs) };
  }
  return { applies: true, freshness: judgeNativeSignalFreshness(nativeSignalWindowOf(alert, { signalTriggeredAt: execution.signalTriggeredAt }), nowMs) };
}
