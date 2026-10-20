import {
  SIGNAL_QUALITY_BURST_COUNT,
  SIGNAL_QUALITY_BURST_WINDOW_MS,
  SIGNAL_QUALITY_FLAGS,
  SIGNAL_QUALITY_PRECISION,
  type NativeExecutionIntegrityStatus,
  type SignalQualityFlag,
  type SignalQualityFlagDto,
  type SignalQualityRowDto,
} from "@trading-alert-dashboard/shared";

import type { SignalQualityFacts } from "./signal-quality-facts";
import { evaluateSignalOutcome, type OutcomeMarketData } from "./signal-quality-outcome";

/**
 * Assembles evaluated signal-quality rows from per-alert facts, an integrity
 * verdict, market data and the evaluation instant, then derives the
 * deterministic diagnostic flags that need the whole set (duplicates, repeats,
 * bursts). Pure.
 *
 * Repeats are not defects: Teddy legitimately re-arms after its cooldown, so a
 * second alert on the same symbol and side (EXPECTED_REPEAT) or on the same
 * level (SAME_LEVEL_REPEAT) is information. Only a REPEATED CANONICAL
 * IDENTITY — the same delivery key or the same shadow event on two rows, or a
 * row the ingestion itself counted as a duplicate — is a SUSPICIOUS_DUPLICATE.
 */

export interface IntegrityVerdict {
  readonly status: NativeExecutionIntegrityStatus;
  readonly reason: string;
}

export interface RowInput {
  readonly facts: SignalQualityFacts;
  /** Null when this request did not judge integrity (bounded); never assumed ELIGIBLE. */
  readonly integrity: IntegrityVerdict | null;
  readonly marketData: OutcomeMarketData;
  /** The instant this row is evaluated at: never after asOf, never past what its market data covers. */
  readonly evaluationEndMs: number;
}

const flag = (code: SignalQualityFlag, detail: string): SignalQualityFlagDto => ({ code, category: SIGNAL_QUALITY_FLAGS[code], detail });

/** Flags that need only the row itself. */
function ownFlags(input: RowInput, asOfMs: number): SignalQualityFlagDto[] {
  const { facts, integrity } = input;
  const out: SignalQualityFlagDto[] = [];
  if (!facts.payload.valid) out.push(flag("MALFORMED_PAYLOAD", facts.payload.problem ?? "malformed payload"));
  if (facts.payload.barStartMs === null) out.push(flag("MISSING_BAR_START", "the payload records no operational bar start"));
  if (facts.triggeredAtMs > facts.observedAtMs || facts.triggeredAtMs > asOfMs) {
    out.push(flag("FUTURE_TIMESTAMP", `triggeredAt is later than ${facts.triggeredAtMs > facts.observedAtMs ? "the instant the alert was persisted" : "the evaluation instant"}`));
  }
  if (facts.freshness.state === "STALE_AT_DELIVERY") out.push(flag("STALE_AT_DELIVERY", facts.freshness.reason ?? "stale by the M5 rule when persisted"));
  if (facts.freshness.state === "TIME_UNAVAILABLE") out.push(flag("FRESHNESS_EVIDENCE_INVALID", facts.freshness.reason ?? "no M5 freshness could be established"));
  if (facts.deliveryTiming === "DELAYED") out.push(flag("DELAYED_DELIVERY", `persisted ${Math.round(facts.deliveryLagMs / 1000)} s after its trigger (emitter backlog or recovery)`));
  if (facts.soakScope === "OBSERVED_DURING_SOAK_TRIGGERED_BEFORE_START") out.push(flag("TRIGGERED_BEFORE_SOAK", "triggered before the soak started; observed during it"));
  if (integrity !== null && integrity.status !== "ELIGIBLE") out.push(flag("INTEGRITY_NOT_ELIGIBLE", `${integrity.status}: ${integrity.reason}`));
  if (facts.plan.malformed) out.push(flag("PLAN_MALFORMED", facts.plan.geometry.available ? "malformed plan" : facts.plan.geometry.reason));
  else if (!facts.plan.geometry.available) out.push(flag("PLAN_UNAVAILABLE", facts.plan.geometry.reason));
  if (facts.duplicateCount > 0) out.push(flag("SUSPICIOUS_DUPLICATE", `the ingestion counted ${facts.duplicateCount} duplicate(s) of this alert`));
  return out;
}

/** Deterministic order: trigger time, then alert id. */
function byTrigger(a: SignalQualityFacts, b: SignalQualityFacts): number {
  return a.triggeredAtMs - b.triggeredAtMs || (a.alertId < b.alertId ? -1 : a.alertId > b.alertId ? 1 : 0);
}

/** Flags that need the whole evaluated set. */
export function setFlags(all: readonly SignalQualityFacts[]): Map<string, SignalQualityFlagDto[]> {
  const out = new Map<string, SignalQualityFlagDto[]>(all.map((f) => [f.alertId, []]));
  const push = (id: string, value: SignalQualityFlagDto) => out.get(id)?.push(value);

  const byKey = new Map<string, string[]>();
  const byEvent = new Map<string, string[]>();
  for (const f of all) {
    if (f.payload.deliveryKey !== null) byKey.set(f.payload.deliveryKey, [...(byKey.get(f.payload.deliveryKey) ?? []), f.alertId]);
    if (f.payload.shadowEventId !== null) byEvent.set(f.payload.shadowEventId, [...(byEvent.get(f.payload.shadowEventId) ?? []), f.alertId]);
  }
  for (const [key, ids] of byKey) if (ids.length > 1) for (const id of ids) push(id, flag("SUSPICIOUS_DUPLICATE", `delivery key ${key.slice(0, 12)}… is on ${ids.length} alerts`));
  for (const [event, ids] of byEvent) if (ids.length > 1) for (const id of ids) push(id, flag("SUSPICIOUS_DUPLICATE", `shadow event ${event.slice(0, 12)}… is on ${ids.length} alerts`));

  const ordered = [...all].sort(byTrigger);
  const seenSide = new Map<string, SignalQualityFacts[]>();
  const seenLevel = new Set<string>();
  for (const f of ordered) {
    const side = `${f.symbol}|${f.direction}`;
    const earlier = seenSide.get(side) ?? [];
    const distinct = earlier.filter((e) => e.payload.deliveryKey !== f.payload.deliveryKey && e.payload.shadowEventId !== f.payload.shadowEventId);
    if (distinct.length > 0) push(f.alertId, flag("EXPECTED_REPEAT", `${distinct.length} earlier alert(s) on ${f.symbol} ${f.direction} in this window (Teddy may legitimately re-arm)`));
    const level = f.payload.levelKey === null ? null : `${side}|${f.sourceTimeframe ?? "?"}|${f.payload.levelKey}`;
    if (level !== null && seenLevel.has(level)) push(f.alertId, flag("SAME_LEVEL_REPEAT", "an earlier alert in this window touched the same level"));
    const recent = [...earlier, f].filter((e) => f.triggeredAtMs - e.triggeredAtMs < SIGNAL_QUALITY_BURST_WINDOW_MS);
    if (recent.length >= SIGNAL_QUALITY_BURST_COUNT) push(f.alertId, flag("SYMBOL_SIDE_BURST", `${recent.length} alerts on ${f.symbol} ${f.direction} within ${SIGNAL_QUALITY_BURST_WINDOW_MS / 60_000} minutes`));
    seenSide.set(side, [...earlier, f]);
    if (level !== null) seenLevel.add(level);
  }
  return out;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** One evaluated row. Deterministic for the same inputs and `asOfMs`. */
export function buildRow(input: RowInput, setLevelFlags: readonly SignalQualityFlagDto[], asOfMs: number): SignalQualityRowDto {
  const { facts, integrity, marketData } = input;
  const outcome = evaluateSignalOutcome({
    signal: { direction: facts.direction, triggeredAtMs: facts.triggeredAtMs, referencePrice: facts.levelPrice },
    plan: facts.plan.geometry,
    marketData,
    evaluationEndMs: Math.min(input.evaluationEndMs, asOfMs),
  });
  const summary = facts.plan.summary;
  const flags = [...ownFlags(input, asOfMs), ...setLevelFlags];
  return {
    alertId: facts.alertId,
    symbol: facts.symbol,
    direction: facts.direction,
    sourceTimeframe: facts.sourceTimeframe,
    timeframeClass: facts.timeframeClass,
    levelColor: facts.levelColor,
    touchDirection: facts.touchDirection,
    levelPrice: facts.levelPrice,
    triggeredAt: new Date(facts.triggeredAtMs).toISOString(),
    observedAt: new Date(facts.observedAtMs).toISOString(),
    deliveryLagMs: facts.deliveryLagMs,
    deliveryTiming: facts.deliveryTiming,
    soakScope: facts.soakScope,
    barStart: iso(facts.payload.barStartMs),
    triggerOffsetInBarMs: facts.payload.barStartMs === null ? null : facts.triggeredAtMs - facts.payload.barStartMs,
    evidenceClass: facts.payload.evidenceClass,
    evidenceBasis: facts.payload.evidenceBasis,
    deliveryKey: facts.payload.deliveryKey,
    levelKey: facts.payload.levelKey,
    shadowEventId: facts.payload.shadowEventId,
    runId: facts.payload.runId,
    freshness: { state: facts.freshness.state, expiresAt: iso(facts.freshness.window?.expiresAtMs ?? null), reason: facts.freshness.reason },
    integrity: integrity === null ? { judged: false, status: null, reason: null } : { judged: true, status: integrity.status, reason: integrity.reason },
    reference: facts.levelPrice === null ? { price: null, source: "UNAVAILABLE" } : { price: facts.levelPrice, source: "CANONICAL_LEVEL_PRICE" },
    marketData: { status: marketData.status, precision: SIGNAL_QUALITY_PRECISION, reason: marketData.status === "LOADED" ? null : marketData.reason },
    horizons: outcome.horizons,
    plan: {
      available: facts.plan.geometry.available,
      state: summary === null ? "NO_PLAN" : summary.state,
      planStatus: summary?.planStatus ?? null,
      selectedLookback: summary?.selectedLookback ?? null,
      entry: summary?.entryPrice ?? null,
      stopLoss: summary?.stopLoss ?? null,
      takeProfit: summary?.takeProfit ?? null,
      plannedRiskReward: summary?.riskRewardRatio ?? null,
      generatedAt: facts.plan.generatedAt,
      cutoffAt: summary?.cutoffAt ?? null,
      provenance: "EXISTING_SELECTED_PLAN",
      outcome: outcome.plan.outcome,
      rMultiple: outcome.plan.rMultiple,
      resolvedAt: iso(outcome.plan.resolvedAtMs),
      reason: outcome.plan.reason,
    },
    flags,
  };
}

/** Every row of one evaluated set, in deterministic trigger order (newest first). */
export function buildRows(inputs: readonly RowInput[], asOfMs: number): SignalQualityRowDto[] {
  const flags = setFlags(inputs.map((i) => i.facts));
  return [...inputs]
    .sort((a, b) => byTrigger(b.facts, a.facts))
    .map((input) => buildRow(input, flags.get(input.facts.alertId) ?? [], asOfMs));
}
