import {
  SIGNAL_QUALITY_HORIZONS,
  SIGNAL_QUALITY_PRECISION,
  type SignalQualityHorizonState,
  type SignalQualityPlanOutcome,
  type SignalQualityRowDto,
} from "@trading-alert-dashboard/shared";

import type { SignalQualityAlertRow, SignalQualityPlanRow } from "../../src/modules/signal-quality/signal-quality-facts";
import { ENTRY_PRICE, canaryAlert, cleanRecords, storedCandidates, type FixtureOptions } from "./native-canary-fixtures";

/**
 * Signal-quality fixtures. Alerts come from the REAL scanner -> delivery ->
 * alert-draft pipeline (native-canary-fixtures), so their payload, barStart and
 * M5 freshness evidence are exactly what the emitter writes. Rows for the
 * aggregate tests are hand-made so each number is chosen, not incidental.
 */

export interface AlertRowOptions extends FixtureOptions {
  /** Persisted this long after the trigger (default 2 s). */
  lagMs?: number;
  duplicateCount?: number;
}

export function alertRow(options: AlertRowOptions = {}): SignalQualityAlertRow {
  const alert = canaryAlert(cleanRecords(options), options);
  const triggeredAt = alert.triggeredAt as Date;
  return {
    id: alert.id,
    source: "NATIVE",
    symbol: alert.symbol,
    signal: alert.signal as string,
    sourceTimeframe: alert.sourceTimeframe ?? null,
    levelColor: options.signal === "SHORT" ? "RED" : "GREEN",
    touchDirection: options.signal === "SHORT" ? "FROM_BELOW" : "FROM_ABOVE",
    price: alert.price,
    triggeredAt,
    createdAt: new Date(triggeredAt.getTime() + (options.lagMs ?? 2_000)),
    duplicateCount: options.duplicateCount ?? 0,
    rawPayload: alert.rawPayload,
  };
}

export function planRow(direction: "LONG" | "SHORT", over: Partial<SignalQualityPlanRow> = {}): SignalQualityPlanRow {
  return {
    status: "READY",
    direction,
    entryPrice: ENTRY_PRICE,
    cutoffAt: new Date(Date.UTC(2026, 9, 1, 12, 16)),
    generatedAt: new Date(Date.UTC(2026, 9, 1, 12, 16, 1)),
    candidates: storedCandidates(direction),
    selectedLookback: 100,
    errorReason: null,
    ...over,
  };
}

export interface RowSpec {
  id?: string;
  symbol?: string;
  direction?: "LONG" | "SHORT";
  sourceTimeframe?: string | null;
  timeframeClass?: SignalQualityRowDto["timeframeClass"];
  levelColor?: "GREEN" | "RED" | null;
  triggeredAt?: string;
  outcome?: SignalQualityPlanOutcome;
  r?: number | null;
  /** State and metrics for every horizon (default MATURED with zeros). */
  horizon?: { state: SignalQualityHorizonState; mfe?: number | null; mae?: number | null; ret?: number | null };
  h24?: { state: SignalQualityHorizonState; mfe?: number | null; mae?: number | null; ret?: number | null };
  integrity?: SignalQualityRowDto["integrity"];
  levelKey?: string | null;
  evidenceClass?: string | null;
}

let counter = 0;

/** A hand-made evaluated row: every number chosen by the test. */
export function row(spec: RowSpec = {}): SignalQualityRowDto {
  counter += 1;
  const base = spec.horizon ?? { state: "MATURED", mfe: 0, mae: 0, ret: 0 };
  return {
    alertId: spec.id ?? `row-${counter}`,
    symbol: spec.symbol ?? "AAAUSDT",
    direction: spec.direction ?? "LONG",
    sourceTimeframe: spec.sourceTimeframe === undefined ? "1D" : spec.sourceTimeframe,
    timeframeClass: spec.timeframeClass ?? "EXECUTION_POLICY_TIMEFRAME",
    levelColor: spec.levelColor === undefined ? "GREEN" : spec.levelColor,
    touchDirection: "FROM_ABOVE",
    levelPrice: 100,
    triggeredAt: spec.triggeredAt ?? new Date(Date.UTC(2026, 9, 1, 12, 0) + counter * 60_000).toISOString(),
    observedAt: spec.triggeredAt ?? new Date(Date.UTC(2026, 9, 1, 12, 0, 2) + counter * 60_000).toISOString(),
    deliveryLagMs: 2_000,
    deliveryTiming: "REALTIME",
    soakScope: "NO_SOAK_WINDOW",
    barStart: null,
    triggerOffsetInBarMs: null,
    evidenceClass: spec.evidenceClass === undefined ? "PROVEN_INTRABAR_POSSIBLE" : spec.evidenceClass,
    evidenceBasis: null,
    deliveryKey: `key-${counter}`,
    levelKey: spec.levelKey === undefined ? null : spec.levelKey,
    shadowEventId: `event-${counter}`,
    runId: null,
    freshness: { state: "FRESH_AT_DELIVERY", expiresAt: null, reason: null },
    integrity: spec.integrity ?? { judged: true, status: "ELIGIBLE", reason: "fixture" },
    reference: { price: 100, source: "CANONICAL_LEVEL_PRICE" },
    marketData: { status: "LOADED", precision: SIGNAL_QUALITY_PRECISION, reason: null },
    horizons: SIGNAL_QUALITY_HORIZONS.map((h) => {
      const x = h.key === "24h" && spec.h24 ? spec.h24 : base;
      return { key: h.key, state: x.state, expectedMinutes: h.minutes, observedMinutes: h.minutes, missingMinutes: 0, mfePct: x.mfe ?? null, maePct: x.mae ?? null, returnPct: x.ret ?? null, reason: null };
    }),
    plan: {
      available: true,
      state: "SELECTED",
      planStatus: "READY",
      selectedLookback: 100,
      entry: "100",
      stopLoss: "98",
      takeProfit: "106",
      plannedRiskReward: "3",
      generatedAt: null,
      cutoffAt: null,
      provenance: "EXISTING_SELECTED_PLAN",
      outcome: spec.outcome ?? "PENDING",
      rMultiple: spec.r === undefined ? (spec.outcome === "TP_FIRST" ? 3 : spec.outcome === "SL_FIRST" ? -1 : null) : spec.r,
      resolvedAt: null,
      reason: null,
    },
    flags: [],
  };
}

/** Deep check that nothing a response would serialize is NaN or ±Infinity. */
export function nonFiniteNumbersIn(value: unknown, at = "$"): string[] {
  if (typeof value === "number") return Number.isFinite(value) ? [] : [at];
  if (Array.isArray(value)) return value.flatMap((v, i) => nonFiniteNumbersIn(v, `${at}[${i}]`));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => nonFiniteNumbersIn(v, `${at}.${k}`));
  return [];
}
