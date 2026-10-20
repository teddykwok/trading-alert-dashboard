import {
  SIGNAL_QUALITY_REALTIME_DELIVERY_MS,
  selectedPlanSummaryOf,
  type ExtremeRRPlanDto,
  type ExtremeRRPlanStatus,
  type SelectedPlanSummary,
  type SignalQualityDeliveryTiming,
  type SignalQualityFreshnessState,
  type SignalQualitySoakScope,
  type SignalQualityTimeframeClass,
} from "@trading-alert-dashboard/shared";

import { NATIVE_CANARY_SOURCE_TIMEFRAMES } from "../native-canary/native-account-a-canary";
import { judgeNativeSignalFreshness, nativeSignalWindowOf, type NativeSignalWindow } from "../native-canary/native-signal-freshness";
import type { OutcomePlan } from "./signal-quality-outcome";

/**
 * Per-alert ENGINE-QUALITY facts, read from what is already persisted: the
 * Native Alert row, its durable payload provenance, and its frozen selected
 * plan. Pure: nothing is fetched, written or recomputed.
 *
 * Reused, never copied:
 *  - freshness is M5's own rule (nativeSignalWindowOf + judgeNativeSignalFreshness),
 *    judged at the instant the alert was persisted;
 *  - the selected plan is the shared selectedPlanSummaryOf, over the plan row as stored;
 *  - the execution-policy timeframes are the canary's NATIVE_CANARY_SOURCE_TIMEFRAMES
 *    (a constant; the import performs no work and grants nothing).
 * Anything malformed is surfaced as such, never corrected.
 */

/** The Alert row fields the observatory reads. */
export interface SignalQualityAlertRow {
  readonly id: string;
  readonly source: string;
  readonly symbol: string;
  readonly signal: string;
  readonly sourceTimeframe: string | null;
  readonly levelColor: string | null;
  readonly touchDirection: string | null;
  readonly price: number;
  readonly triggeredAt: Date;
  readonly createdAt: Date;
  readonly duplicateCount: number;
  readonly rawPayload: unknown;
}

/** The ExtremeRRPlan row fields the observatory reads. */
export interface SignalQualityPlanRow {
  readonly status: ExtremeRRPlanStatus;
  readonly direction: string;
  readonly entryPrice: { toString(): string } | string;
  readonly cutoffAt: Date;
  readonly generatedAt: Date | null;
  readonly candidates: unknown;
  readonly selectedLookback: number;
  readonly errorReason: string | null;
}

export interface SignalQualitySoakWindow {
  readonly startMs: number;
  readonly endMs: number;
}

export interface PayloadFacts {
  readonly valid: boolean;
  readonly problem: string | null;
  readonly schema: string | null;
  readonly barStartMs: number | null;
  readonly deliveryKey: string | null;
  readonly levelKey: string | null;
  readonly shadowEventId: string | null;
  readonly evidenceClass: string | null;
  readonly evidenceBasis: string | null;
  readonly runId: string | null;
  readonly note: string | null;
  readonly delivery: Readonly<Record<string, unknown>> | null;
  readonly profile: Readonly<Record<string, unknown>> | null;
}

export interface PlanFacts {
  readonly exists: boolean;
  readonly malformed: boolean;
  readonly summary: SelectedPlanSummary | null;
  readonly generatedAt: string | null;
  readonly geometry: OutcomePlan;
}

export interface FreshnessFacts {
  readonly state: SignalQualityFreshnessState;
  readonly reason: string | null;
  readonly window: NativeSignalWindow | null;
}

export interface SignalQualityFacts {
  readonly alertId: string;
  readonly symbol: string;
  readonly direction: "LONG" | "SHORT";
  readonly sourceTimeframe: string | null;
  readonly timeframeClass: SignalQualityTimeframeClass;
  readonly levelColor: "GREEN" | "RED" | null;
  readonly touchDirection: string | null;
  readonly levelPrice: number | null;
  readonly triggeredAtMs: number;
  readonly observedAtMs: number;
  readonly deliveryLagMs: number;
  readonly deliveryTiming: SignalQualityDeliveryTiming;
  readonly soakScope: SignalQualitySoakScope;
  readonly duplicateCount: number;
  readonly payload: PayloadFacts;
  readonly freshness: FreshnessFacts;
  readonly plan: PlanFacts;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NATIVE_PAYLOAD_SCHEMA_PREFIX = "teddy.native-alerts.alert-payload.";

export function payloadFactsOf(rawPayload: unknown): PayloadFacts {
  const empty = { schema: null, barStartMs: null, deliveryKey: null, levelKey: null, shadowEventId: null, evidenceClass: null, evidenceBasis: null, runId: null, note: null, delivery: null, profile: null };
  if (!isRecord(rawPayload)) return { ...empty, valid: false, problem: "the alert carries no payload object" };
  const schema = str(rawPayload.schema);
  const delivery = isRecord(rawPayload.delivery) ? rawPayload.delivery : null;
  const profile = isRecord(rawPayload.profile) ? rawPayload.profile : null;
  const barStartRaw = delivery?.barStart;
  const barStartMs = typeof barStartRaw === "string" && ISO_MS.test(barStartRaw) && Number.isFinite(Date.parse(barStartRaw)) ? Date.parse(barStartRaw) : null;
  const facts = {
    schema,
    barStartMs,
    deliveryKey: str(delivery?.deliveryKey),
    levelKey: str(delivery?.levelKey),
    shadowEventId: str(delivery?.shadowEventId),
    evidenceClass: str(delivery?.evidenceClass),
    evidenceBasis: str(delivery?.evidenceBasis),
    runId: str(profile?.runId),
    note: str(rawPayload.note),
    delivery,
    profile,
  };
  if (schema === null || !schema.startsWith(NATIVE_PAYLOAD_SCHEMA_PREFIX)) return { ...facts, valid: false, problem: `payload schema ${JSON.stringify(schema)} is not a Native alert payload` };
  if (delivery === null) return { ...facts, valid: false, problem: "the payload has no delivery provenance" };
  if (facts.deliveryKey === null || facts.shadowEventId === null) return { ...facts, valid: false, problem: "the payload has no delivery key or shadow event identity" };
  return { ...facts, valid: true, problem: null };
}

/** M5 freshness, judged at the instant the alert was persisted. The rule is M5's; nothing here changes it. */
export function freshnessFactsOf(alert: SignalQualityAlertRow): FreshnessFacts {
  const window = nativeSignalWindowOf({ source: alert.source, symbol: alert.symbol, triggeredAt: alert.triggeredAt, rawPayload: alert.rawPayload });
  const verdict = judgeNativeSignalFreshness(window, alert.createdAt.getTime());
  if (verdict.fresh) return { state: "FRESH_AT_DELIVERY", reason: null, window: verdict.window };
  return { state: verdict.reason === "STALE" ? "STALE_AT_DELIVERY" : "TIME_UNAVAILABLE", reason: verdict.message, window: verdict.window };
}

export function timeframeClassOf(sourceTimeframe: string | null): SignalQualityTimeframeClass {
  return sourceTimeframe !== null && (NATIVE_CANARY_SOURCE_TIMEFRAMES as readonly string[]).includes(sourceTimeframe) ? "EXECUTION_POLICY_TIMEFRAME" : "DASHBOARD_ONLY_TIMEFRAME";
}

export function deliveryTimingOf(deliveryLagMs: number): SignalQualityDeliveryTiming {
  return deliveryLagMs <= SIGNAL_QUALITY_REALTIME_DELIVERY_MS ? "REALTIME" : "DELAYED";
}

/**
 * How an alert relates to the soak window [start, end): triggered inside it,
 * or triggered BEFORE it but persisted inside it (emitter backlog / recovery),
 * or neither. Recovery never creates alerts for replayed bars; a late delivery
 * is the only way a pre-soak signal can appear during the soak.
 */
export function soakScopeOf(triggeredAtMs: number, observedAtMs: number, soak: SignalQualitySoakWindow | null): SignalQualitySoakScope {
  if (soak === null) return "NO_SOAK_WINDOW";
  if (triggeredAtMs >= soak.startMs && triggeredAtMs < soak.endMs) return "TRIGGERED_DURING_SOAK";
  if (triggeredAtMs < soak.startMs && observedAtMs >= soak.startMs && observedAtMs < soak.endMs) return "OBSERVED_DURING_SOAK_TRIGGERED_BEFORE_START";
  return "OUTSIDE_SOAK";
}

function storedCandidatesWellFormed(candidates: unknown): boolean {
  return Array.isArray(candidates) && candidates.every((c) => isRecord(c) && typeof c.requestedCandles === "number" && typeof c.valid === "boolean");
}

/** The existing selected plan, exactly as persisted and selected. Never recalculated. */
export function planFactsOf(plan: SignalQualityPlanRow | null, direction: "LONG" | "SHORT"): PlanFacts {
  if (plan === null) return { exists: false, malformed: false, summary: null, generatedAt: null, geometry: { available: false, reason: "the alert has no plan" } };
  const generatedAt = plan.generatedAt === null ? null : plan.generatedAt.toISOString();
  if (plan.status === "READY" && !storedCandidatesWellFormed(plan.candidates)) {
    return { exists: true, malformed: true, summary: null, generatedAt, geometry: { available: false, reason: "the plan's stored candidates are malformed" } };
  }
  const dto = {
    alertSource: "NATIVE",
    status: plan.status,
    selectedLookback: plan.selectedLookback,
    direction: plan.direction,
    entryPrice: String(plan.entryPrice),
    cutoffAt: plan.cutoffAt.toISOString(),
    candidates: Array.isArray(plan.candidates) ? plan.candidates : [],
    errorReason: plan.errorReason,
  } as unknown as ExtremeRRPlanDto;
  const summary = selectedPlanSummaryOf(dto);
  if (summary.state !== "SELECTED" || summary.stopLoss === null || summary.takeProfit === null) {
    return { exists: true, malformed: false, summary, generatedAt, geometry: { available: false, reason: summary.reason ?? `the selected plan is ${summary.state}` } };
  }
  if (plan.direction !== direction) {
    return { exists: true, malformed: true, summary, generatedAt, geometry: { available: false, reason: `the plan direction ${plan.direction} disagrees with the alert direction ${direction}` } };
  }
  const entry = Number(summary.entryPrice);
  const stopLoss = Number(summary.stopLoss);
  const takeProfit = Number(summary.takeProfit);
  return { exists: true, malformed: false, summary, generatedAt, geometry: { available: true, entry, stopLoss, takeProfit } };
}

/** Every per-alert fact, or null when the alert is not a LONG/SHORT Native alert (never evaluated). */
export function signalQualityFactsOf(alert: SignalQualityAlertRow, plan: SignalQualityPlanRow | null, soak: SignalQualitySoakWindow | null): SignalQualityFacts | null {
  if (alert.source !== "NATIVE" || (alert.signal !== "LONG" && alert.signal !== "SHORT")) return null;
  const direction = alert.signal;
  const triggeredAtMs = alert.triggeredAt.getTime();
  const observedAtMs = alert.createdAt.getTime();
  const deliveryLagMs = observedAtMs - triggeredAtMs;
  const levelPrice = Number.isFinite(alert.price) && alert.price > 0 ? alert.price : null;
  return {
    alertId: alert.id,
    symbol: alert.symbol,
    direction,
    sourceTimeframe: alert.sourceTimeframe,
    timeframeClass: timeframeClassOf(alert.sourceTimeframe),
    levelColor: alert.levelColor === "GREEN" || alert.levelColor === "RED" ? alert.levelColor : null,
    touchDirection: alert.touchDirection,
    levelPrice,
    triggeredAtMs,
    observedAtMs,
    deliveryLagMs,
    deliveryTiming: deliveryTimingOf(deliveryLagMs),
    soakScope: soakScopeOf(triggeredAtMs, observedAtMs, soak),
    duplicateCount: alert.duplicateCount,
    payload: payloadFactsOf(alert.rawPayload),
    freshness: freshnessFactsOf(alert),
    plan: planFactsOf(plan, direction),
  };
}
