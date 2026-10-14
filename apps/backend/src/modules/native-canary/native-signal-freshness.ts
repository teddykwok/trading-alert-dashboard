import { NATIVE_ALERT_SOURCE } from "../alerts/alert-source";
import { NATIVE_DELIVERY_CHART_INTERVALS } from "../native-alerts/native-delivery-policy";
import { nativeExecutionProvenanceOf } from "../native-integrity/native-execution-integrity";

/**
 * NATIVE SIGNAL FRESHNESS V1: how long a Native signal stays tradeable,
 * anchored to the close of the operational 15m bar it was observed on.
 *
 * Why not the 300-second rule: a Native alert is delivered immediately, from a
 * live observation on a still-forming 15m bar, but it may only be executed once
 * that bar's final scanner evidence is ELIGIBLE, which cannot happen before the
 * bar closes. A touch at the bar's open is therefore up to 15 minutes old
 * before it could ever be decided, and measured from the touch alone it would
 * expire while still PENDING_BAR_CLOSE. The TradingView rule
 * (EXECUTION_MAX_ALERT_AGE_SECONDS from triggeredAt) is unchanged and never
 * applies to a Native signal; this rule never applies to a TradingView one.
 *
 *   operationalBarClose = barStart + 15m
 *   postCloseExpiry     = operationalBarClose + 5m
 *   absoluteExpiry      = triggeredAt + 20m
 *   expiresAt           = min(postCloseExpiry, absoluteExpiry)
 *   fresh  <=>  triggeredAt <= now <= expiresAt      (millisecond precision)
 *
 * barStart is the alert's OWN durable provenance: rawPayload.delivery.barStart,
 * which must equal rawPayload.barTime, lie on an operational bar boundary and
 * agree with the payload's shadow-event hash (nativeExecutionProvenanceOf).
 * Never the 1D/1W/1M source candle, never the wall clock, never processing
 * time. triggeredAt is the exchange event time of the touching kline update,
 * and the Alert row and its payload must record the same instant.
 *
 * Boundaries, derived from the scanner's own event semantics rather than
 * tolerated:
 *  - a touch cannot predate its own bar (that kline did not exist yet). The
 *    scanner's log reader already refuses such an observation as
 *    IMPOSSIBLE_ORDERING (native-alerts/shadow-log-reader.ts), so
 *    triggeredAt < barStart is impossible evidence here too and is refused;
 *  - a touch MAY carry an event time at or after the bar's nominal close: the
 *    live session emits observations on the bar's closing update, which
 *    arrives then, and the reader imposes no upper bound. It is legitimate;
 *    it simply leaves less of the post-close window;
 *  - now == expiresAt is still fresh; one millisecond later is stale;
 *  - now < triggeredAt is a signal from the future and is refused, with no
 *    clock-skew tolerance.
 * Because triggeredAt >= barStart, postCloseExpiry <= absoluteExpiry for every
 * consistent alert. The 20-minute cap is defence in depth: it bounds the
 * lifetime from the touch even if a bar start were ever wrong.
 *
 * Pure and deterministic: the same alert and the same `nowMs` always give the
 * same verdict, so every site, retry and restart computes the same expiry.
 * Anything missing, unreadable, inconsistent, impossible or unattributable is
 * refused, never assumed.
 */

export const NATIVE_OPERATIONAL_BAR_MS = 15 * 60_000;
export const NATIVE_POST_CLOSE_FRESHNESS_MS = 5 * 60_000;
export const NATIVE_ABSOLUTE_MAX_SIGNAL_AGE_MS = 20 * 60_000;

/** The Alert row fields the rule reads. */
export interface NativeSignalAlert {
  readonly source: string | null | undefined;
  readonly symbol: string;
  readonly triggeredAt: Date | null | undefined;
  readonly rawPayload: unknown;
}

/** Everything the rule derives, in epoch milliseconds. */
export interface NativeSignalWindow {
  readonly barStartMs: number;
  readonly barCloseMs: number;
  readonly triggeredAtMs: number;
  readonly postCloseExpiryMs: number;
  readonly absoluteExpiryMs: number;
  readonly expiresAtMs: number;
}

export type NativeSignalWindowResult =
  | { readonly ok: true; readonly window: NativeSignalWindow }
  | { readonly ok: false; readonly reason: string };

export type NativeSignalFreshness =
  | { readonly fresh: true; readonly window: NativeSignalWindow }
  | {
      readonly fresh: false;
      /** STALE is permanent (time only moves past a fixed expiry); TIME_IN_FUTURE and EVIDENCE_INVALID prove no expiry. */
      readonly reason: "STALE" | "TIME_IN_FUTURE" | "EVIDENCE_INVALID";
      readonly window: NativeSignalWindow | null;
      readonly message: string;
    };

/** The canary vocabulary for a refusal: stale, or a signal time that cannot be trusted. */
export const NATIVE_SIGNAL_REFUSAL_CODES = ["NATIVE_SIGNAL_STALE", "NATIVE_SIGNAL_TIME_UNAVAILABLE"] as const;
export type NativeSignalRefusalCode = (typeof NATIVE_SIGNAL_REFUSAL_CODES)[number];

export function nativeSignalRefusalCodeOf(verdict: Extract<NativeSignalFreshness, { fresh: false }>): NativeSignalRefusalCode {
  return verdict.reason === "STALE" ? "NATIVE_SIGNAL_STALE" : "NATIVE_SIGNAL_TIME_UNAVAILABLE";
}

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The formula alone, total over its inputs and validating nothing (that is
 * `nativeSignalWindowOf`'s job). Kept separate so the absolute cap is pinned
 * on its own: for a valid alert it can never bind, because the bar cannot
 * start after the touch.
 */
export function nativeSignalExpiryOf(barStartMs: number, triggeredAtMs: number): NativeSignalWindow {
  const barCloseMs = barStartMs + NATIVE_OPERATIONAL_BAR_MS;
  const postCloseExpiryMs = barCloseMs + NATIVE_POST_CLOSE_FRESHNESS_MS;
  const absoluteExpiryMs = triggeredAtMs + NATIVE_ABSOLUTE_MAX_SIGNAL_AGE_MS;
  return { barStartMs, barCloseMs, triggeredAtMs, postCloseExpiryMs, absoluteExpiryMs, expiresAtMs: Math.min(postCloseExpiryMs, absoluteExpiryMs) };
}

/**
 * The window a Native alert's own durable evidence proves, or why it proves
 * none. `frozen` is an execution's copy of the signal time (TradeExecution
 * .signalTriggeredAt); when given, it must be the alert's instant exactly.
 */
export function nativeSignalWindowOf(alert: NativeSignalAlert, frozen?: { readonly signalTriggeredAt: Date | null }): NativeSignalWindowResult {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (alert.source !== NATIVE_ALERT_SOURCE) return no(`the alert source is ${String(alert.source)}, not NATIVE`);
  const parsed = nativeExecutionProvenanceOf(alert);
  if (!parsed.ok) return no(`the alert proves no operational bar (${parsed.reason})`);
  const { barOpenTimeMs: barStartMs, chartInterval } = parsed.provenance;
  if (NATIVE_DELIVERY_CHART_INTERVALS[chartInterval] !== NATIVE_OPERATIONAL_BAR_MS) {
    return no(`the alert's bar interval ${chartInterval} is not the 15m operational bar`);
  }
  const triggeredAt = alert.triggeredAt;
  if (!(triggeredAt instanceof Date) || !Number.isSafeInteger(triggeredAt.getTime())) return no("the alert carries no valid trigger instant");
  const triggeredAtMs = triggeredAt.getTime();
  const recorded = isObject(alert.rawPayload) ? alert.rawPayload.triggeredAt : undefined;
  if (typeof recorded !== "string" || !ISO_MS.test(recorded) || Date.parse(recorded) !== triggeredAtMs) {
    return no("the alert's trigger instant is not the one its own durable payload records");
  }
  if (frozen !== undefined && (!(frozen.signalTriggeredAt instanceof Date) || frozen.signalTriggeredAt.getTime() !== triggeredAtMs)) {
    return no("the execution's frozen signal time is not its alert's trigger instant");
  }
  if (triggeredAtMs < barStartMs) {
    return no(`the touch at ${iso(triggeredAtMs)} predates its own bar's open at ${iso(barStartMs)}, which is impossible`);
  }
  return { ok: true, window: nativeSignalExpiryOf(barStartMs, triggeredAtMs) };
}

/** The verdict at `nowMs`. The only place the Native freshness comparison is made. */
export function judgeNativeSignalFreshness(result: NativeSignalWindowResult, nowMs: number): NativeSignalFreshness {
  if (!result.ok) {
    return { fresh: false, reason: "EVIDENCE_INVALID", window: null, message: `Native signal freshness cannot be established: ${result.reason}` };
  }
  const w = result.window;
  if (!Number.isSafeInteger(nowMs)) {
    return { fresh: false, reason: "EVIDENCE_INVALID", window: w, message: "Native signal freshness cannot be established: the evaluation instant is not a valid time" };
  }
  if (nowMs > w.expiresAtMs) {
    return {
      fresh: false,
      reason: "STALE",
      window: w,
      message:
        `Native signal expired at ${iso(w.expiresAtMs)} (its 15m bar ${iso(w.barStartMs)} closed at ${iso(w.barCloseMs)}; ` +
        `window close + ${NATIVE_POST_CLOSE_FRESHNESS_MS / 1000}s, capped at touch ${iso(w.triggeredAtMs)} + ${NATIVE_ABSOLUTE_MAX_SIGNAL_AGE_MS / 1000}s); evaluated at ${iso(nowMs)}`,
    };
  }
  if (nowMs < w.triggeredAtMs) {
    return {
      fresh: false,
      reason: "TIME_IN_FUTURE",
      window: w,
      message: `Native signal time ${iso(w.triggeredAtMs)} is after the evaluation instant ${iso(nowMs)}; a future-dated signal is refused, with no clock-skew tolerance`,
    };
  }
  return { fresh: true, window: w };
}

/**
 * The only trigger instants that can be fresh at `nowMs`: fresh implies
 * triggeredAt <= now <= triggeredAt + 20m. A superset filter for discovery;
 * the verdict itself is always `judgeNativeSignalFreshness`.
 */
export function nativeSignalLifetimeSpan(nowMs: number): { readonly earliestTriggeredAtMs: number; readonly latestTriggeredAtMs: number } {
  return { earliestTriggeredAtMs: nowMs - NATIVE_ABSOLUTE_MAX_SIGNAL_AGE_MS, latestTriggeredAtMs: nowMs };
}
