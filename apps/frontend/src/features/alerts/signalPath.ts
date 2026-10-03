import type { Alert, AlertSource } from "../../types/alert";
import { isNativeAlert, nativeProfileOf } from "../../utils/alertSource";

/**
 * WHERE A SIGNAL CAME FROM, AND WHAT HAPPENED TO IT — per source, truthfully.
 *
 * Two distinct evidence sources share one dashboard and must never be
 * confused:
 *  - TRADINGVIEW: an ACTUAL TradingView webhook delivery. It runs the
 *    screenshot -> AI vision -> Extreme RR pipeline.
 *  - NATIVE: Native scanner EVIDENCE delivered through NATIVE_DELIVERY_V2. It
 *    is not a TradingView alert, runs no TradingView pipeline, and is never
 *    executed. Its evidence class (e.g. PROVEN_INTRABAR_POSSIBLE) says the
 *    touch was possible intrabar on live Binance data — never that TradingView
 *    sent anything.
 *
 * Only data the alert actually carries is shown; anything absent is "Not
 * recorded". Pure: rendering only maps these rows.
 */

export type AlertSourceKind = AlertSource;

export const SOURCE_LABEL: Readonly<Record<AlertSourceKind, string>> = Object.freeze({ TRADINGVIEW: "TradingView", NATIVE: "Native" });

export const SOURCE_KIND_DESCRIPTION: Readonly<Record<AlertSourceKind, string>> = Object.freeze({
  TRADINGVIEW: "Actual TradingView webhook delivery",
  NATIVE: "Native scanner evidence — not a TradingView alert",
});

/** An alert from a server that predates the source column is a TradingView alert. */
export function sourceKindOf(alert: Pick<Alert, "source">): AlertSourceKind {
  return isNativeAlert(alert) ? "NATIVE" : "TRADINGVIEW";
}

export type PathTone = "green" | "yellow" | "red" | "gray" | "blue";

export interface SignalPathRow {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly tone: PathTone;
}

const NOT_RECORDED = "Not recorded";

export const NATIVE_EVIDENCE_EXPLANATION: Readonly<Record<string, string>> = Object.freeze({
  PROVEN_INTRABAR_POSSIBLE: "The touch was proven possible intrabar on live Binance data. This is not proof that TradingView sent an alert.",
  POSSIBLE_ONLY: "The touch was possibly intrabar on live Binance data (weaker than proven). This is not a TradingView alert.",
});

export const NATIVE_PIPELINE_NOT_APPLICABLE = "Not applicable — Native alerts skip the TradingView screenshot and AI pipeline";
export const NATIVE_EXECUTION_DISABLED = "Disabled — dashboard only (actionable = false)";
export const NATIVE_PLAN_PLANNING_ONLY = "Planning only — generated on demand in Trade Plan; never executed";

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The NATIVE_DELIVERY_V2 facts an alert's payload records, or nulls. */
export function nativeDeliveryOf(alert: Pick<Alert, "source" | "rawPayload">): { policyVersion: string | null; evidenceClass: string | null; deliveryKey: string | null; actionable: boolean | null } {
  const payload = isRecord(alert.rawPayload) ? alert.rawPayload : {};
  const delivery = isRecord(payload.delivery) ? payload.delivery : {};
  const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    policyVersion: text(delivery.policyVersion),
    evidenceClass: text(delivery.evidenceClass),
    deliveryKey: text(delivery.deliveryKey),
    actionable: typeof payload.actionable === "boolean" ? payload.actionable : null,
  };
}

function tradingViewRows(alert: Alert): SignalPathRow[] {
  const screenshot: SignalPathRow = alert.screenshotUrl
    ? { label: "Screenshot", value: "Captured", tone: "green" }
    : alert.status === "ANALYZED"
      ? { label: "Screenshot", value: "Expired (retention)", tone: "gray" }
      : alert.status === "FAILED"
        ? { label: "Screenshot", value: "None", tone: "red" }
        : { label: "Screenshot", value: "Pending", tone: "yellow" };
  const analysis: SignalPathRow =
    alert.status === "ANALYZED"
      ? { label: "AI analysis", value: alert.aiProvider ? `Analyzed (${alert.aiProvider})` : "Analyzed", tone: "green" }
      : alert.status === "FAILED"
        ? { label: "AI analysis", value: "Failed", tone: "red" }
        : alert.status === "ANALYZING_WITH_AI"
          ? { label: "AI analysis", value: "In progress", tone: "blue" }
          : alert.status === "IGNORED_DUPLICATE"
            ? { label: "AI analysis", value: "Not analyzed (duplicate)", tone: "gray" }
            : { label: "AI analysis", value: "Pending", tone: "yellow" };
  const directional = alert.signal === "LONG" || alert.signal === "SHORT";
  return [
    { label: "Source", value: SOURCE_LABEL.TRADINGVIEW, detail: SOURCE_KIND_DESCRIPTION.TRADINGVIEW, tone: "blue" },
    screenshot,
    analysis,
    directional
      ? { label: "Extreme RR plan", value: "Generated for directional alerts — see Trade Plan", tone: "gray" }
      : { label: "Extreme RR plan", value: "Not applicable (LONG/SHORT only)", tone: "gray" },
    ...(alert.duplicateCount > 0 ? [{ label: "Duplicates", value: `${alert.duplicateCount} suppressed repeat(s)`, tone: "gray" as const }] : []),
  ];
}

function nativeRows(alert: Alert): SignalPathRow[] {
  const delivery = nativeDeliveryOf(alert);
  const profile = nativeProfileOf(alert);
  const evidence = delivery.evidenceClass;
  return [
    { label: "Source", value: "Native scanner", detail: SOURCE_KIND_DESCRIPTION.NATIVE, tone: "blue" },
    { label: "Delivery", value: delivery.policyVersion ?? NOT_RECORDED, tone: "gray" },
    { label: "Profile", value: profile ? `${profile.profileLabel} (${profile.profileId})` : NOT_RECORDED, tone: "gray" },
    { label: "Scanner run", value: profile?.runId ?? NOT_RECORDED, tone: "gray" },
    { label: "Engine fingerprint", value: profile ? profile.engineFingerprint.slice(0, 12) : NOT_RECORDED, tone: "gray" },
    { label: "Source timeframe", value: alert.sourceTimeframe ?? alert.alertContext?.sourceTimeframe ?? NOT_RECORDED, tone: "gray" },
    { label: "Evidence", value: evidence ?? NOT_RECORDED, detail: evidence ? NATIVE_EVIDENCE_EXPLANATION[evidence] : undefined, tone: "gray" },
    { label: "Screenshot & AI", value: NATIVE_PIPELINE_NOT_APPLICABLE, tone: "gray" },
    ...(alert.signal === "LONG" || alert.signal === "SHORT" ? [{ label: "Extreme RR plan", value: NATIVE_PLAN_PLANNING_ONLY, tone: "gray" as const }] : []),
    { label: "Execution", value: NATIVE_EXECUTION_DISABLED, tone: "red" },
  ];
}

/** The truthful pipeline for this alert's own source. */
export function signalPathRows(alert: Alert): SignalPathRow[] {
  return sourceKindOf(alert) === "NATIVE" ? nativeRows(alert) : tradingViewRows(alert);
}
