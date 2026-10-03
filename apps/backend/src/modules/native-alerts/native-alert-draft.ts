import { NATIVE_ALERT_SOURCE } from "../alerts/alert-source";
import type { CreateAlertInput } from "../alerts/alerts.types";
import { NATIVE_DELIVERY_POLICY_VERSION, type NativeDeliveryDecision } from "./native-delivery-policy";
import type { NativeDeliveryContextV2, NativeDeliveryDecisionV2 } from "./native-delivery-policy-v2";

/**
 * The canonical dashboard Alert for one NATIVE_DELIVERY_V1 decision.
 *
 * The row says plainly that it is NATIVE: `source`, the indicator name and the
 * payload all name the native scanner, it carries no webhook secret, and it
 * never claims to be — or to match — a TradingView alert. Level context is
 * written both as structured columns and as the canonical note, so the
 * dashboard's existing read path (`buildAlertContext`) shows it unchanged.
 */

/** Stable indicator identity for every native alert. Deliberately not the TradingView indicator's name. */
export const NATIVE_INDICATOR_NAME = "Native Level Scanner";

export const NATIVE_ALERT_EXCHANGE = "BINANCE";

export const NATIVE_ALERT_PAYLOAD_SCHEMA = "teddy.native-alerts.alert-payload.v1" as const;

/** The same `key=value | …` note the dashboard already parses for TradingView level alerts. */
export function nativeAlertNote(decision: NativeDeliveryDecision): string {
  const w = decision.winner;
  return [
    "eventType=LEVEL_TOUCHED",
    `levelColor=${w.levelColor}`,
    `sourceTf=${w.sourceTf}`,
    `touchDirection=${w.touchDirection}`,
    `levelPrice=${String(w.levelPrice)}`,
    `chartTf=${w.chartInterval}`,
    "alertTiming=Immediate",
  ].join(" | ");
}

export function buildNativeAlertDraft(decision: NativeDeliveryDecision): CreateAlertInput {
  const w = decision.winner;
  const p = decision.provenance;
  // The first moment the exchange's own stream showed the touch — never the
  // emitter's clock and never the database insert time.
  const triggeredAt = new Date(w.exchangeEventTimeMs);
  return {
    assetId: null,
    symbol: w.symbol,
    assetType: "CRYPTO",
    exchange: NATIVE_ALERT_EXCHANGE,
    timeframe: w.chartInterval,
    price: w.levelPrice,
    signal: w.signal,
    indicatorName: NATIVE_INDICATOR_NAME,
    indicatorValue: null,
    source: NATIVE_ALERT_SOURCE,
    triggeredAt,
    eventType: "LEVEL_TOUCHED",
    levelColor: w.levelColor,
    sourceTimeframe: w.sourceTf,
    touchDirection: w.touchDirection,
    rawPayload: {
      schema: NATIVE_ALERT_PAYLOAD_SCHEMA,
      source: NATIVE_ALERT_SOURCE,
      origin: "native-scanner live shadow evidence (not a TradingView alert)",
      symbol: w.symbol,
      exchange: NATIVE_ALERT_EXCHANGE,
      marketType: w.marketType,
      timeframe: w.chartInterval,
      signal: w.signal,
      price: w.levelPrice,
      note: nativeAlertNote(decision),
      barTime: w.barOpenTime,
      triggeredAt: triggeredAt.toISOString(),
      delivery: {
        policyVersion: NATIVE_DELIVERY_POLICY_VERSION,
        deliveryKey: decision.deliveryKey,
        deliveryKeySchema: p.deliveryKeySchema,
        provenanceSha256: decision.provenanceSha256,
        lineageId: w.lineageId,
        shadowEventId: w.eventId,
        levelKey: w.levelKey,
        evidenceBasis: w.evidence.basis,
        evidenceClass: w.evidence.evidenceClass,
        candidateSequence: w.candidateSequence,
        updateSequence: w.updateSequence,
        tradingViewEquivalenceClaimed: false,
      },
    },
  };
}

export const NATIVE_ALERT_PAYLOAD_SCHEMA_V2 = "teddy.native-alerts.alert-payload.v2" as const;

/**
 * The canonical dashboard Alert for one NATIVE_DELIVERY_V2 decision: the same
 * columns and note as V1 (the dashboard's read path is unchanged), plus the
 * profile and run it came from in the payload. The profile block shows the
 * FUTURE execution policy as modelling only — it grants nothing; native
 * execution is hard-disabled in code for every source timeframe.
 */
export function buildNativeAlertDraftV2(decision: NativeDeliveryDecisionV2, context: NativeDeliveryContextV2): CreateAlertInput {
  const w = decision.winner;
  const p = decision.provenance;
  const profile = context.profile;
  const triggeredAt = new Date(w.exchangeEventTimeMs);
  const note = [
    "eventType=LEVEL_TOUCHED",
    `levelColor=${w.levelColor}`,
    `sourceTf=${w.sourceTf}`,
    `touchDirection=${w.touchDirection}`,
    `levelPrice=${String(w.levelPrice)}`,
    `chartTf=${w.chartInterval}`,
    "alertTiming=Immediate",
  ].join(" | ");
  return {
    assetId: null,
    symbol: w.symbol,
    assetType: "CRYPTO",
    exchange: NATIVE_ALERT_EXCHANGE,
    timeframe: w.chartInterval,
    price: w.levelPrice,
    signal: w.signal,
    indicatorName: NATIVE_INDICATOR_NAME,
    indicatorValue: null,
    source: NATIVE_ALERT_SOURCE,
    triggeredAt,
    eventType: "LEVEL_TOUCHED",
    levelColor: w.levelColor,
    sourceTimeframe: w.sourceTf,
    touchDirection: w.touchDirection,
    rawPayload: {
      schema: NATIVE_ALERT_PAYLOAD_SCHEMA_V2,
      source: NATIVE_ALERT_SOURCE,
      origin: "native-scanner live shadow evidence (not a TradingView alert)",
      actionable: false,
      symbol: w.symbol,
      exchange: NATIVE_ALERT_EXCHANGE,
      marketType: w.marketType,
      timeframe: w.chartInterval,
      signal: w.signal,
      price: w.levelPrice,
      note,
      barTime: w.barOpenTime,
      triggeredAt: triggeredAt.toISOString(),
      delivery: {
        policyVersion: decision.policyVersion,
        deliveryKey: decision.deliveryKey,
        deliveryKeySchema: p.deliveryKeySchema,
        provenanceSha256: decision.provenanceSha256,
        lineageId: w.lineageId,
        shadowEventId: w.eventId,
        levelKey: w.levelKey,
        sourceTimeframe: w.sourceTf,
        barStart: w.barOpenTime,
        evidenceBasis: w.evidence.basis,
        evidenceClass: w.evidence.evidenceClass,
        candidateSequence: w.candidateSequence,
        updateSequence: w.updateSequence,
        tradingViewEquivalenceClaimed: false,
      },
      profile: {
        profileId: profile.profileId,
        profileLabel: profile.profileLabel,
        runId: context.runId,
        engineFingerprint: profile.engineFingerprint,
        deliveryPolicyFingerprint: profile.deliveryPolicyFingerprint,
        executionPolicyFingerprint: profile.executionPolicyFingerprint,
        engineSourceTimeframes: [...profile.engine.engineSourceTimeframes],
        dashboardSourceTimeframes: [...profile.delivery.dashboardSourceTimeframes],
        futureExecutionSourceTimeframes: [...profile.execution.futureExecutionSourceTimeframes],
        futureExecutionNotice: profile.execution.notice,
        nativeExecutionEnabled: false,
        universeTargetEligible: profile.universe.targetEligible,
      },
    },
  };
}

