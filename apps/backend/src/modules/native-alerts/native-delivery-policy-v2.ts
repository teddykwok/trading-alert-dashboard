import { canonicalSha256 } from "../native-scanner/canonical-json";
import type { LiveImmediateObservation, ShadowRecord } from "../native-scanner/live-shadow-store";
import { NATIVE_DELIVERY_V2_VERSION, type DeliveryPolicy, type ProfileSummary } from "../native-scanner/scanner-profile";
import { NATIVE_DELIVERY_CHART_INTERVALS, NATIVE_DELIVERY_MARKET_TYPE } from "./native-delivery-policy";

/**
 * NATIVE_DELIVERY_V2 — which durable live-shadow observations become dashboard
 * Alerts under a profile's DeliveryPolicy.
 *
 * V1 delivers at most ONE Alert per bar. Once a dashboard-only timeframe (1M)
 * is deliverable, that rule would let a 1M touch silently suppress a distinct
 * 1D or 1W touch on the same bar. V2's slot is therefore source-timeframe
 * aware: at most one Alert per
 *
 *     (policy V2, lineage, market, symbol, chart interval, bar, SOURCE TIMEFRAME)
 *
 * — so one 1D, one 1W and one 1M Alert at most for a symbol's bar. Inside a
 * slot, the EARLIEST eligible observation in durable log order wins; later ones
 * are SUPERSEDED_SAME_SLOT. Which timeframes are deliverable comes from the
 * DeliveryPolicy alone — never from the execution policy, which decides nothing
 * here (nor anywhere today: native execution is hard-fenced in code).
 *
 * Unchanged from V1, deliberately: only LIVE_IMMEDIATE_OBSERVATION records,
 * only SHADOW_LIVE_ONLY, non-actionable, IMMEDIATE_INTRABAR evidence of an
 * allowed live class (PROVEN_INTRABAR_POSSIBLE and POSSIBLE_ONLY, each kept as
 * itself). V1 rows, keys and code are untouched: V2 is a separate key schema.
 *
 * The key holds no delivery-policy fingerprint, profile, run or wall clock: a
 * dashboard-only policy change can never re-deliver the same canonical event.
 * Pure: no clock, no file, no database.
 */

export const NATIVE_DELIVERY_KEY_SCHEMA_V2 = "teddy.native-alerts.delivery-key.v2" as const;
export const NATIVE_DELIVERY_PROVENANCE_SCHEMA_V2 = "teddy.native-alerts.delivery-provenance.v2" as const;

export interface DeliveryKeyPartsV2 {
  readonly lineageId: string;
  readonly marketType: string;
  readonly symbol: string;
  readonly chartInterval: string;
  readonly barOpenTimeMs: number;
  readonly sourceTf: string;
}

export function nativeDeliveryKeyV2(parts: DeliveryKeyPartsV2): string {
  return canonicalSha256({
    schema: NATIVE_DELIVERY_KEY_SCHEMA_V2,
    policyVersion: NATIVE_DELIVERY_V2_VERSION,
    lineageId: parts.lineageId,
    marketType: parts.marketType,
    symbol: parts.symbol,
    chartInterval: parts.chartInterval,
    barOpenTimeMs: parts.barOpenTimeMs,
    sourceTf: parts.sourceTf,
  });
}

/** Facts of the winning event only: no profile, run or policy fingerprint, so replay under a changed dashboard policy never contradicts. */
export interface NativeDeliveryProvenanceV2 {
  readonly schema: typeof NATIVE_DELIVERY_PROVENANCE_SCHEMA_V2;
  readonly policyVersion: typeof NATIVE_DELIVERY_V2_VERSION;
  readonly deliveryKey: string;
  readonly deliveryKeySchema: typeof NATIVE_DELIVERY_KEY_SCHEMA_V2;
  readonly lineageId: string;
  readonly marketType: string;
  readonly symbol: string;
  readonly chartInterval: string;
  readonly barOpenTimeMs: number;
  readonly sourceTf: LiveImmediateObservation["sourceTf"];
  readonly winningShadowEventId: string;
  readonly signal: LiveImmediateObservation["signal"];
  readonly touchDirection: LiveImmediateObservation["touchDirection"];
  readonly levelColor: LiveImmediateObservation["levelColor"];
  readonly levelPrice: number;
  readonly levelKey: string;
  readonly exchangeEventTimeMs: number;
  readonly candidateSequence: number;
  readonly updateSequence: number;
  readonly evidenceBasis: LiveImmediateObservation["evidence"]["basis"];
  readonly evidenceClass: LiveImmediateObservation["evidence"]["evidenceClass"];
}

export interface NativeDeliveryDecisionV2 {
  readonly policyVersion: typeof NATIVE_DELIVERY_V2_VERSION;
  readonly deliveryKey: string;
  readonly provenance: NativeDeliveryProvenanceV2;
  readonly provenanceSha256: string;
  readonly winner: LiveImmediateObservation;
}

/** Where a V2 delivery came from. Recorded on the Alert; in no key and no provenance hash. */
export interface NativeDeliveryContextV2 {
  readonly profile: ProfileSummary;
  readonly runId: string;
}

export type NativeSkipReasonV2 =
  /** A SHADOW_LIVE_ONLY bar commit: commits are never delivered on their own. */
  | "BAR_CLOSE_COMMIT_NEVER_DELIVERED"
  /** A QUARANTINED_CURRENT_BAR or REPLAYED_NON_ACTIONABLE commit: never live, never delivered. */
  | "REPLAY_OR_QUARANTINE_NON_ACTIONABLE"
  | "NOT_SHADOW_LIVE_ONLY"
  | "ACTIONABLE_RECORD"
  | "NOT_IMMEDIATE_INTRABAR"
  | "EVIDENCE_CLASS_NOT_ALLOWED"
  | "UNSUPPORTED_MARKET_OR_INTERVAL"
  /** Engine-only source timeframe under this DeliveryPolicy (e.g. 3M/6M/12M for Teddy Aggressive). */
  | "SOURCE_TF_NOT_DELIVERED"
  | "DUPLICATE_EVENT"
  | "SUPERSEDED_SAME_SLOT";

export type NativeSelectionV2 =
  | { readonly kind: "DELIVER"; readonly decision: NativeDeliveryDecisionV2 }
  | { readonly kind: "SKIP"; readonly eventId: string; readonly reason: NativeSkipReasonV2; readonly supersededBy: string | null; readonly sourceTf: string | null };

export function provenanceOfV2(winner: LiveImmediateObservation, deliveryKey: string): NativeDeliveryProvenanceV2 {
  return {
    schema: NATIVE_DELIVERY_PROVENANCE_SCHEMA_V2,
    policyVersion: NATIVE_DELIVERY_V2_VERSION,
    deliveryKey,
    deliveryKeySchema: NATIVE_DELIVERY_KEY_SCHEMA_V2,
    lineageId: winner.lineageId,
    marketType: winner.marketType,
    symbol: winner.symbol,
    chartInterval: winner.chartInterval,
    barOpenTimeMs: winner.barOpenTimeMs,
    sourceTf: winner.sourceTf,
    winningShadowEventId: winner.eventId,
    signal: winner.signal,
    touchDirection: winner.touchDirection,
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

/** Why a record is not deliverable on its own merits under `policy`, or null when it is. */
export function ineligibilityOfV2(record: ShadowRecord, policy: DeliveryPolicy): NativeSkipReasonV2 | null {
  if (record.kind !== "LIVE_IMMEDIATE_OBSERVATION") {
    return (record.classification as string) === "SHADOW_LIVE_ONLY" ? "BAR_CLOSE_COMMIT_NEVER_DELIVERED" : "REPLAY_OR_QUARANTINE_NON_ACTIONABLE";
  }
  if ((record.classification as string) !== "SHADOW_LIVE_ONLY") return "NOT_SHADOW_LIVE_ONLY";
  if ((record.actionable as unknown) !== false) return "ACTIONABLE_RECORD";
  if (record.evidence?.basis !== "IMMEDIATE_INTRABAR") return "NOT_IMMEDIATE_INTRABAR";
  if (!(policy.evidenceClasses as readonly string[]).includes(record.evidence.evidenceClass)) return "EVIDENCE_CLASS_NOT_ALLOWED";
  if (record.marketType !== NATIVE_DELIVERY_MARKET_TYPE || !Object.prototype.hasOwnProperty.call(NATIVE_DELIVERY_CHART_INTERVALS, record.chartInterval)) {
    return "UNSUPPORTED_MARKET_OR_INTERVAL";
  }
  if (!(policy.dashboardSourceTimeframes as readonly string[]).includes(record.sourceTf)) return "SOURCE_TF_NOT_DELIVERED";
  return null;
}

/**
 * Incremental V2 selection over ONE log's records in durable order. Feed every
 * record exactly in log order (including records before a cursor or an
 * activation cutover, so slot winners are known); a record's answer never
 * depends on anything after it.
 */
export class NativeDeliverySelectorV2 {
  private readonly seen = new Set<string>();
  /** deliveryKey (one source-TF slot) -> the winning observation's eventId. */
  private readonly winners = new Map<string, string>();

  constructor(private readonly policy: DeliveryPolicy) {
    if (policy.policyVersion !== NATIVE_DELIVERY_V2_VERSION) throw new Error(`the V2 selector cannot apply ${String(policy.policyVersion)}`);
  }

  consider(record: ShadowRecord): NativeSelectionV2 {
    const sourceTf = record.kind === "LIVE_IMMEDIATE_OBSERVATION" ? record.sourceTf : null;
    if (this.seen.has(record.eventId)) return { kind: "SKIP", eventId: record.eventId, reason: "DUPLICATE_EVENT", supersededBy: null, sourceTf };
    this.seen.add(record.eventId);

    const reason = ineligibilityOfV2(record, this.policy);
    if (reason !== null) return { kind: "SKIP", eventId: record.eventId, reason, supersededBy: null, sourceTf };
    const observation = record as LiveImmediateObservation;

    const deliveryKey = nativeDeliveryKeyV2(observation);
    const existing = this.winners.get(deliveryKey);
    if (existing !== undefined) return { kind: "SKIP", eventId: record.eventId, reason: "SUPERSEDED_SAME_SLOT", supersededBy: existing, sourceTf };
    this.winners.set(deliveryKey, observation.eventId);

    const provenance = provenanceOfV2(observation, deliveryKey);
    return {
      kind: "DELIVER",
      decision: { policyVersion: NATIVE_DELIVERY_V2_VERSION, deliveryKey, provenance, provenanceSha256: canonicalSha256(provenance), winner: observation },
    };
  }
}

/** Every V2 selection for a complete, already validated record list. */
export function selectNativeDeliveriesV2(records: readonly ShadowRecord[], policy: DeliveryPolicy): NativeSelectionV2[] {
  const selector = new NativeDeliverySelectorV2(policy);
  return records.map((record) => selector.consider(record));
}
