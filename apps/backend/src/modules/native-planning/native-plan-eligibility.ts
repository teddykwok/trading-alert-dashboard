import { NATIVE_ALERT_SOURCE } from "../alerts/alert-source";
import { NATIVE_DELIVERY_V2_VERSION } from "../native-scanner/scanner-profile";

/**
 * WHICH alerts automatic Native planning may ever touch. Pure.
 *
 * Exactly one kind: a committed NATIVE alert that the Native delivery policy
 * V2 delivered to the dashboard — non-actionable, V2 payload, and backed by
 * its own V2 ledger row under the same delivery key — with a LONG or SHORT
 * signal. Everything else is refused, including a TRADINGVIEW alert (its
 * planning, Telegram and execution lifecycle belong to the TradingView
 * pipeline alone) and an alert with an unknown or missing source.
 */

/** The only delivery policy whose alerts are auto-planned. */
export const NATIVE_AUTO_PLAN_POLICY_VERSION = NATIVE_DELIVERY_V2_VERSION;

export type NativeAutoPlanRefusal =
  | "NOT_NATIVE"
  | "NOT_DASHBOARD_ONLY"
  | "NOT_V2_DELIVERY"
  | "NO_DELIVERY_LEDGER"
  | "LEDGER_MISMATCH"
  | "NOT_DIRECTIONAL";

export interface NativeAutoPlanSubject {
  readonly id: string;
  readonly source: unknown;
  readonly signal: unknown;
  readonly rawPayload: unknown;
  /** The alert's ledger row, or null when it has none. */
  readonly nativeDelivery: { readonly deliveryKey: string; readonly policyVersion: string; readonly alertId: string | null } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Why this alert must not be auto-planned, or null when it may. */
export function nativeAutoPlanRefusal(alert: NativeAutoPlanSubject): NativeAutoPlanRefusal | null {
  // Allowlist: anything that is not positively NATIVE (TRADINGVIEW, unknown, missing) is refused first.
  if (alert.source !== NATIVE_ALERT_SOURCE) return "NOT_NATIVE";
  const payload = isRecord(alert.rawPayload) ? alert.rawPayload : null;
  if (payload === null || payload.source !== NATIVE_ALERT_SOURCE || payload.actionable !== false) return "NOT_DASHBOARD_ONLY";
  const delivery = isRecord(payload.delivery) ? payload.delivery : null;
  if (delivery === null || delivery.policyVersion !== NATIVE_AUTO_PLAN_POLICY_VERSION || typeof delivery.deliveryKey !== "string") return "NOT_V2_DELIVERY";
  const ledger = alert.nativeDelivery;
  if (ledger === null) return "NO_DELIVERY_LEDGER";
  if (ledger.alertId !== alert.id || ledger.policyVersion !== NATIVE_AUTO_PLAN_POLICY_VERSION || ledger.deliveryKey !== delivery.deliveryKey) return "LEDGER_MISMATCH";
  if (alert.signal !== "LONG" && alert.signal !== "SHORT") return "NOT_DIRECTIONAL";
  return null;
}
