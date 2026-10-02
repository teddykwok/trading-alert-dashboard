import type { Alert } from "../types/alert";

/**
 * Native alerts come from the in-house scanner, not TradingView. They are shown
 * on the dashboard and nowhere else: the backend refuses to plan or execute them.
 * An alert from a server that predates the `source` column is a TradingView alert.
 */
export function isNativeAlert(alert: Pick<Alert, "source">): boolean {
  return alert.source === "NATIVE";
}

export const NATIVE_ALERT_BADGE_LABEL = "Native";

export const NATIVE_ALERT_BADGE_TITLE =
  "Native scanner alert — dashboard only. Not a TradingView alert; plans and execution are disabled.";

export const NATIVE_ALERT_PLAN_NOTICE =
  "This is a native scanner alert. It is delivered to the dashboard only: Extreme RR plans and execution are hard-disabled for native alerts.";
