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
  "This is a native scanner alert, delivered to the dashboard only. Its Extreme RR plan is planning only, generated on demand from the same frozen pre-alert candles; execution is hard-disabled for native alerts, for every source timeframe.";

/**
 * The native scanner PROFILE a native alert was delivered under, as recorded in
 * its payload (NATIVE_DELIVERY_V2). Display only: a profile is not an account,
 * and its future execution policy grants nothing — native execution stays
 * hard-disabled for every source timeframe. Null for anything else.
 */
export interface NativeProfileDisplay {
  profileId: string;
  profileLabel: string;
  runId: string;
  engineFingerprint: string;
  engineSourceTimeframes: string[];
  dashboardSourceTimeframes: string[];
  futureExecutionSourceTimeframes: string[];
  universeTargetEligible: number | null;
}

export const NATIVE_FUTURE_EXECUTION_NOTICE =
  "Future execution policy only — native execution is NOT enabled. It is hard-disabled for every source timeframe.";

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const stringList = (value: unknown): string[] | null => (Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null);

export function nativeProfileOf(alert: Pick<Alert, "source" | "rawPayload">): NativeProfileDisplay | null {
  if (!isNativeAlert(alert) || !isRecord(alert.rawPayload)) return null;
  const profile = alert.rawPayload.profile;
  if (!isRecord(profile)) return null;
  const engine = stringList(profile.engineSourceTimeframes);
  const delivery = stringList(profile.dashboardSourceTimeframes);
  const execution = stringList(profile.futureExecutionSourceTimeframes);
  const text = (key: string) => (typeof profile[key] === "string" ? (profile[key] as string) : null);
  const profileId = text("profileId");
  const profileLabel = text("profileLabel");
  const runId = text("runId");
  const engineFingerprint = text("engineFingerprint");
  if (profileId === null || profileLabel === null || runId === null || engineFingerprint === null || engine === null || delivery === null || execution === null) return null;
  // A payload claiming native execution is enabled is not shown as a valid profile at all.
  if (profile.nativeExecutionEnabled !== false) return null;
  const target = profile.universeTargetEligible;
  return {
    profileId,
    profileLabel,
    runId,
    engineFingerprint,
    engineSourceTimeframes: engine,
    dashboardSourceTimeframes: delivery,
    futureExecutionSourceTimeframes: execution,
    universeTargetEligible: typeof target === "number" && Number.isSafeInteger(target) ? target : null,
  };
}

