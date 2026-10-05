import type { NativeExecutionIntegrityDto, NativeExecutionIntegrityStatus } from "@trading-alert-dashboard/shared";

/**
 * How Trading Control shows a Native plan's EXECUTION DATA INTEGRITY: whether
 * the scanner's final evidence for the alert's source 15m bar turned out clean.
 * Pure, display only. Even ELIGIBLE grants nothing — Native execution stays
 * disabled — and a blocked alert and its plan stay on screen as history.
 */

export const NATIVE_EXECUTION_INTEGRITY_HEADING = "Execution data integrity";

/** Shown beside ELIGIBLE so a clean bar is never read as a permission. */
export const NATIVE_INTEGRITY_GRANTS_NOTHING = "Data integrity only: Native execution remains disabled.";

const LABEL: Readonly<Record<NativeExecutionIntegrityStatus, string>> = Object.freeze({
  PENDING_BAR_CLOSE: "PENDING BAR CLOSE",
  ELIGIBLE: "ELIGIBLE",
  INELIGIBLE_REQUARANTINED: "BLOCKED — RE-QUARANTINED",
  INELIGIBLE_GAP: "BLOCKED — GAP",
  INELIGIBLE_DUPLICATE: "BLOCKED — DUPLICATE",
  INELIGIBLE_CHECKPOINT_MISMATCH: "BLOCKED — CHECKPOINT MISMATCH",
  INELIGIBLE_STALE_GENERATION: "BLOCKED — STALE GENERATION",
  UNREADABLE: "UNREADABLE",
});

export interface NativeExecutionIntegrityView {
  readonly label: string;
  readonly tone: "green" | "blue" | "yellow" | "red";
  readonly detail: string;
}

/** A missing or unrecognised status is shown as UNREADABLE: never as eligible. */
export function presentNativeExecutionIntegrity(integrity: NativeExecutionIntegrityDto | null | undefined): NativeExecutionIntegrityView {
  const status = integrity?.status;
  if (integrity == null || status === undefined || !Object.prototype.hasOwnProperty.call(LABEL, status)) {
    return { label: LABEL.UNREADABLE, tone: "yellow", detail: "No execution-integrity evidence was returned." };
  }
  if (status === "ELIGIBLE") return { label: LABEL.ELIGIBLE, tone: "green", detail: `${integrity.reason} ${NATIVE_INTEGRITY_GRANTS_NOTHING}` };
  if (status === "PENDING_BAR_CLOSE") return { label: LABEL.PENDING_BAR_CLOSE, tone: "blue", detail: integrity.reason };
  if (status === "UNREADABLE") return { label: LABEL.UNREADABLE, tone: "yellow", detail: integrity.reason };
  return { label: LABEL[status], tone: "red", detail: integrity.reason };
}
