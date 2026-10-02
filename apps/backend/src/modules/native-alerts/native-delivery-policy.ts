import type { SourceTimeframe } from "@trading-alert-dashboard/shared";

import { canonicalSha256 } from "../native-scanner/canonical-json";
import type { LiveImmediateObservation, ShadowRecord } from "../native-scanner/live-shadow-store";

/**
 * NATIVE_DELIVERY_V1 — which durable live-shadow observation, if any, becomes
 * the ONE dashboard Alert for a bar.
 *
 * Pure: no clock, no file, no database. Decisions depend only on the records
 * given and their order, and each decision depends only on the records BEFORE
 * it — so reading a log from the start after a restart, or following it as it
 * grows, selects exactly the same winners.
 *
 *  - Only a LIVE_IMMEDIATE_OBSERVATION can be delivered. A BAR_CLOSE_COMMIT is
 *    never delivered on its own, whatever its classification.
 *  - The observation must be SHADOW_LIVE_ONLY, non-actionable, IMMEDIATE_INTRABAR
 *    evidence. QUARANTINED_CURRENT_BAR and REPLAYED_NON_ACTIONABLE are never
 *    live; bootstrap, catch-up and gap recovery produce no observations at all.
 *  - Its source timeframe must be 1D or 1W. 1M/3M/6M/12M levels still take part
 *    in the scanner's registration and state; they are simply not delivered.
 *  - At most one Alert per (policy, lineage, market, symbol, chart interval,
 *    bar): the EARLIEST eligible observation in the scanner's durable order
 *    (file order, which is update order then candidate order) wins; later ones
 *    on that bar are recorded as superseded.
 *
 * This selects among NATIVE candidates only. It does not claim that TradingView
 * would have sent the same alert, or any alert, for the bar.
 */

export const NATIVE_DELIVERY_POLICY_VERSION = "NATIVE_DELIVERY_V1" as const;
export const NATIVE_DELIVERY_KEY_SCHEMA = "teddy.native-alerts.delivery-key.v1" as const;
export const NATIVE_DELIVERY_PROVENANCE_SCHEMA = "teddy.native-alerts.delivery-provenance.v1" as const;

/** Level origin timeframes NATIVE_DELIVERY_V1 delivers. Everything else is not delivered. */
export const NATIVE_DELIVERY_V1_SOURCE_TFS: readonly SourceTimeframe[] = Object.freeze(["1D", "1W"] as const);

/** Chart intervals a native alert may be delivered for, and their length. */
export const NATIVE_DELIVERY_CHART_INTERVALS = Object.freeze({ "15m": 15 * 60_000 } as const);
export type NativeDeliveryChartInterval = keyof typeof NATIVE_DELIVERY_CHART_INTERVALS;

export const NATIVE_DELIVERY_MARKET_TYPE = "USDM_PERPETUAL" as const;

export interface DeliveryKeyParts {
  readonly lineageId: string;
  readonly marketType: string;
  readonly symbol: string;
  readonly chartInterval: string;
  readonly barOpenTimeMs: number;
}

/**
 * The idempotency key: a versioned canonical hash of exactly the fields that
 * define "one Alert per bar". No wall clock, no process state, no candidate
 * detail — two different candidates on one bar share one key by design.
 */
export function nativeDeliveryKey(parts: DeliveryKeyParts): string {
  return canonicalSha256({
    schema: NATIVE_DELIVERY_KEY_SCHEMA,
    policyVersion: NATIVE_DELIVERY_POLICY_VERSION,
    lineageId: parts.lineageId,
    marketType: parts.marketType,
    symbol: parts.symbol,
    chartInterval: parts.chartInterval,
    barOpenTimeMs: parts.barOpenTimeMs,
  });
}

/** Which observation won, under which policy. Hashed; an existing key whose hash differs is a contradiction. */
export interface NativeDeliveryProvenance {
  readonly schema: typeof NATIVE_DELIVERY_PROVENANCE_SCHEMA;
  readonly policyVersion: typeof NATIVE_DELIVERY_POLICY_VERSION;
  readonly deliveryKey: string;
  readonly deliveryKeySchema: typeof NATIVE_DELIVERY_KEY_SCHEMA;
  readonly lineageId: string;
  readonly marketType: string;
  readonly symbol: string;
  readonly chartInterval: string;
  readonly barOpenTimeMs: number;
  readonly winningShadowEventId: string;
  readonly signal: LiveImmediateObservation["signal"];
  readonly touchDirection: LiveImmediateObservation["touchDirection"];
  readonly sourceTf: LiveImmediateObservation["sourceTf"];
  readonly levelColor: LiveImmediateObservation["levelColor"];
  readonly levelPrice: number;
  readonly levelKey: string;
  readonly exchangeEventTimeMs: number;
  readonly candidateSequence: number;
  readonly updateSequence: number;
  readonly evidenceBasis: LiveImmediateObservation["evidence"]["basis"];
  /** PROVEN_INTRABAR_POSSIBLE and POSSIBLE_ONLY are both live observations; which one is kept, never collapsed. */
  readonly evidenceClass: LiveImmediateObservation["evidence"]["evidenceClass"];
}

export interface NativeDeliveryDecision {
  readonly deliveryKey: string;
  readonly provenance: NativeDeliveryProvenance;
  readonly provenanceSha256: string;
  readonly winner: LiveImmediateObservation;
}

export type NativeSkipReason =
  | "BAR_CLOSE_COMMIT_NEVER_DELIVERED"
  | "NOT_SHADOW_LIVE_ONLY"
  | "ACTIONABLE_RECORD"
  | "NOT_IMMEDIATE_INTRABAR"
  | "SOURCE_TF_NOT_DELIVERED"
  | "UNSUPPORTED_MARKET_OR_INTERVAL"
  | "DUPLICATE_EVENT"
  | "SUPERSEDED_SAME_BAR";

export type NativeSelection =
  | { readonly kind: "DELIVER"; readonly decision: NativeDeliveryDecision }
  | { readonly kind: "SKIP"; readonly eventId: string; readonly reason: NativeSkipReason; readonly supersededBy: string | null };

export function provenanceOf(winner: LiveImmediateObservation, deliveryKey: string): NativeDeliveryProvenance {
  return {
    schema: NATIVE_DELIVERY_PROVENANCE_SCHEMA,
    policyVersion: NATIVE_DELIVERY_POLICY_VERSION,
    deliveryKey,
    deliveryKeySchema: NATIVE_DELIVERY_KEY_SCHEMA,
    lineageId: winner.lineageId,
    marketType: winner.marketType,
    symbol: winner.symbol,
    chartInterval: winner.chartInterval,
    barOpenTimeMs: winner.barOpenTimeMs,
    winningShadowEventId: winner.eventId,
    signal: winner.signal,
    touchDirection: winner.touchDirection,
    sourceTf: winner.sourceTf,
    levelColor: winner.levelColor,
    levelPrice: winner.levelPrice,
    levelKey: winner.levelKey,
    exchangeEventTimeMs: winner.exchangeEventTimeMs,
    candidateSequence: winner.candidateSequence,
    updateSequence: winner.updateSequence,
    evidenceBasis: winner.evidence.basis,
    evidenceClass: winner.evidence.evidenceClass,
  };
}

/** Why one observation is not deliverable on its own merits, or null when it is. */
export function ineligibilityOf(record: ShadowRecord): NativeSkipReason | null {
  if (record.kind !== "LIVE_IMMEDIATE_OBSERVATION") return "BAR_CLOSE_COMMIT_NEVER_DELIVERED";
  if ((record.classification as string) !== "SHADOW_LIVE_ONLY") return "NOT_SHADOW_LIVE_ONLY";
  if ((record.actionable as unknown) !== false) return "ACTIONABLE_RECORD";
  if (record.evidence?.basis !== "IMMEDIATE_INTRABAR") return "NOT_IMMEDIATE_INTRABAR";
  if (record.marketType !== NATIVE_DELIVERY_MARKET_TYPE || !Object.prototype.hasOwnProperty.call(NATIVE_DELIVERY_CHART_INTERVALS, record.chartInterval)) {
    return "UNSUPPORTED_MARKET_OR_INTERVAL";
  }
  if (!(NATIVE_DELIVERY_V1_SOURCE_TFS as readonly string[]).includes(record.sourceTf)) return "SOURCE_TF_NOT_DELIVERED";
  return null;
}

/**
 * Incremental NATIVE_DELIVERY_V1 selection over records in durable order.
 * Feed every record exactly in log order; the answer for a record never
 * depends on anything after it.
 */
export class NativeDeliverySelector {
  private readonly seen = new Set<string>();
  /** deliveryKey -> the winning observation's eventId. */
  private readonly winners = new Map<string, string>();

  consider(record: ShadowRecord): NativeSelection {
    if (this.seen.has(record.eventId)) return { kind: "SKIP", eventId: record.eventId, reason: "DUPLICATE_EVENT", supersededBy: null };
    this.seen.add(record.eventId);

    const reason = ineligibilityOf(record);
    if (reason !== null) return { kind: "SKIP", eventId: record.eventId, reason, supersededBy: null };
    const observation = record as LiveImmediateObservation;

    const deliveryKey = nativeDeliveryKey(observation);
    const existing = this.winners.get(deliveryKey);
    if (existing !== undefined) return { kind: "SKIP", eventId: record.eventId, reason: "SUPERSEDED_SAME_BAR", supersededBy: existing };
    this.winners.set(deliveryKey, observation.eventId);

    const provenance = provenanceOf(observation, deliveryKey);
    return { kind: "DELIVER", decision: { deliveryKey, provenance, provenanceSha256: canonicalSha256(provenance), winner: observation } };
  }
}

/** Every selection for a complete, already validated record list. */
export function selectNativeDeliveries(records: readonly ShadowRecord[]): NativeSelection[] {
  const selector = new NativeDeliverySelector();
  return records.map((record) => selector.consider(record));
}
