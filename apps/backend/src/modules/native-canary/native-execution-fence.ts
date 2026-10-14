import type { Prisma, PrismaClient } from "@prisma/client";
import type { NativeExecutionIntegrityStatus } from "@trading-alert-dashboard/shared";

import { NATIVE_ALERT_SOURCE } from "../alerts/alert-source";
import {
  fileSystemNativeScannerEvidence,
  judgeNativeExecutionAdmission,
  nativeExecutionIntegrityOf,
  type NativeScannerEvidenceReader,
} from "../native-integrity/native-execution-integrity";
import { NATIVE_EXECUTION_ENABLED } from "./native-execution-switch";

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
 * scanner evidence re-read from disk. Nothing is cached between asks, so a
 * verdict reached upstream is never trusted downstream.
 *
 * Today every Native ask is refused NATIVE_EXECUTION_DISABLED, because
 * NATIVE_EXECUTION_ENABLED is false. TradingView executions are recognised and
 * passed through untouched: for them this fence does not apply.
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

/** Where the fence reads the source bar's scanner evidence from. */
export interface NativeFenceRuntime {
  /** Null = no evidence in this process, so every Native ask is refused. */
  readonly evidence: NativeScannerEvidenceReader | null;
}

/** The process's own scanner tree (read only). */
export function nativeFenceRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): NativeFenceRuntime {
  return { evidence: fileSystemNativeScannerEvidence(env) };
}

export type NativeFenceRefusalCode = "NATIVE_EXECUTION_DISABLED" | "NATIVE_INTEGRITY_NOT_ELIGIBLE" | "NATIVE_SOURCE_AMBIGUOUS";

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

/** The judgment itself, for a NATIVE alert whose durable payload is in hand. */
function judgeNativeAlert(alert: { source: string; symbol: string; rawPayload: unknown }, runtime: NativeFenceRuntime): NativeFenceApplied {
  // Never throws for a Native alert: anything unreadable comes back UNREADABLE.
  const integrity = nativeExecutionIntegrityOf(alert, runtime.evidence);
  // The switch is read HERE, never passed in by a caller.
  const admission = judgeNativeExecutionAdmission({ nativeExecutionEnabled: NATIVE_EXECUTION_ENABLED, integrity });
  if (admission.admitted) return { applies: true, admitted: true };
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

/**
 * For a Native ALERT that is about to enter the executor (no execution row
 * exists yet). Always applies: the caller says the alert is Native, and an
 * alert that turns out not to be is refused, never waved through.
 */
export async function nativeAlertFence(prisma: PrismaClient, alertId: string, runtime: NativeFenceRuntime): Promise<NativeFenceApplied> {
  const alert = await prisma.alert.findUnique({ where: { id: alertId }, select: { source: true, symbol: true, rawPayload: true } });
  if (alert === null || alert.source !== NATIVE_ALERT_SOURCE) {
    return refuse("NATIVE_SOURCE_AMBIGUOUS", "The candidate's alert is missing or is no longer a NATIVE alert; nothing was sent.", null);
  }
  return judgeNativeAlert(alert, runtime);
}

/**
 * For an EXISTING execution, immediately before an exposure-increasing
 * exchange call.
 *
 * Native is recognised from either durable fact: the alert's own source, or
 * the marker the creating transaction wrote. Either one is enough to apply the
 * fence. A row whose two facts contradict each other is refused as ambiguous.
 * A row with neither fact is TradingView (or a legacy row), and the fence does
 * not apply.
 */
export async function nativeExecutionFence(
  prisma: PrismaClient,
  execution: { readonly id: string; readonly alertId: string | null },
  runtime: NativeFenceRuntime
): Promise<NativeFenceVerdict> {
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
  if (!markedNative && !alertNative) return { applies: false };

  if (alert !== null && !alertNative) {
    return refuse("NATIVE_SOURCE_AMBIGUOUS", "The execution carries the Native marker but its alert is not NATIVE; nothing was sent.", null);
  }
  if (alert === null || alertId === null) {
    // The alert is gone (retention), so its evidence cannot be read. The
    // judgment still runs: the switch is checked first, and a missing
    // evidence verdict can only refuse.
    const admission = judgeNativeExecutionAdmission({ nativeExecutionEnabled: NATIVE_EXECUTION_ENABLED, integrity: null });
    if (admission.admitted) return { applies: true, admitted: true };
    return admission.reason === "NATIVE_EXECUTION_DISABLED"
      ? refuse("NATIVE_EXECUTION_DISABLED", "Native execution is hard-disabled in code (NATIVE_EXECUTION_ENABLED = false); no exchange request was made.", null)
      : refuse("NATIVE_INTEGRITY_NOT_ELIGIBLE", "The Native execution's alert no longer exists, so its source bar cannot be verified; no exchange request was made.", null);
  }

  const full = await prisma.alert.findUnique({ where: { id: alertId }, select: { source: true, symbol: true, rawPayload: true } });
  if (full === null || full.source !== NATIVE_ALERT_SOURCE) {
    return refuse("NATIVE_SOURCE_AMBIGUOUS", "The Native execution's alert changed while it was being read; nothing was sent.", null);
  }
  return judgeNativeAlert(full, runtime);
}
