import type { SourceTimeframe } from "@trading-alert-dashboard/shared";

import { canonicalJson } from "../../src/modules/native-scanner/canonical-json";
import {
  SHADOW_EVENT_SCHEMA,
  commitEventId,
  observationEventId,
  type BarCloseCommitRecord,
  type LiveImmediateObservation,
  type ShadowClassification,
  type ShadowRecord,
} from "../../src/modules/native-scanner/live-shadow-store";
import type { ShadowLogIdentity } from "../../src/modules/native-alerts/shadow-log-reader";

/**
 * Shadow records exactly as the live scanner writes them — same schema, same
 * deterministic event identities — for a synthetic lineage. Nothing here reads
 * a real scanner directory.
 */

export const M15 = 15 * 60_000;
export const LINEAGE = "1".repeat(64);
export const OTHER_LINEAGE = "2".repeat(64);
export const SYMBOL = "LDOUSDT";
export const IDENTITY: ShadowLogIdentity = { lineageId: LINEAGE, marketType: "USDM_PERPETUAL", symbol: SYMBOL, chartInterval: "15m" };
/** 2026-10-01T12:00:00Z, a 15m boundary. */
export const BAR0 = Date.UTC(2026, 9, 1, 12, 0);
export const bar = (n: number) => BAR0 + n * M15;

export interface ObservationSpec {
  barMs?: number;
  sourceTf?: SourceTimeframe;
  signal?: "LONG" | "SHORT";
  levelPrice?: number;
  condition?: "GOR" | "ROR" | "GOG" | "ROG";
  createdBarOpenTimeMs?: number;
  candidateSequence?: number;
  updateSequence?: number;
  eventTimeMs?: number;
  evidenceClass?: "PROVEN_INTRABAR_POSSIBLE" | "POSSIBLE_ONLY";
  lineageId?: string;
  symbol?: string;
}

export function observation(spec: ObservationSpec = {}): LiveImmediateObservation {
  const barOpenTimeMs = spec.barMs ?? BAR0;
  const sourceTf = spec.sourceTf ?? "1D";
  const signal = spec.signal ?? "LONG";
  const condition = spec.condition ?? (signal === "LONG" ? "GOR" : "ROR");
  const createdBarOpenTimeMs = spec.createdBarOpenTimeMs ?? BAR0 - 96 * M15;
  const levelKey = `${sourceTf}:${condition}:${createdBarOpenTimeMs}`;
  const lineageId = spec.lineageId ?? LINEAGE;
  const symbol = spec.symbol ?? SYMBOL;
  const levelPrice = spec.levelPrice ?? 0.8123;
  const proven = (spec.evidenceClass ?? "PROVEN_INTRABAR_POSSIBLE") === "PROVEN_INTRABAR_POSSIBLE";
  return {
    schema: SHADOW_EVENT_SCHEMA,
    kind: "LIVE_IMMEDIATE_OBSERVATION",
    eventId: observationEventId({ lineageId, symbol, barOpenTimeMs, signal, sourceTf, levelKey }),
    lineageId,
    marketType: "USDM_PERPETUAL",
    symbol,
    chartInterval: "15m",
    barOpenTime: new Date(barOpenTimeMs).toISOString(),
    barOpenTimeMs,
    actionable: false,
    classification: "SHADOW_LIVE_ONLY",
    signal,
    touchDirection: signal === "LONG" ? "FROM_ABOVE" : "FROM_BELOW",
    sourceTf,
    levelColor: signal === "LONG" ? "GREEN" : "RED",
    levelPrice,
    levelKey,
    level: { id: 7, condition, htfPeriodStartMs: createdBarOpenTimeMs, createdBarIndex: 3, createdBarOpenTimeMs },
    candidateSequence: spec.candidateSequence ?? 0,
    updateSequence: spec.updateSequence ?? 2,
    exchangeEventTimeMs: spec.eventTimeMs ?? barOpenTimeMs + 61_234,
    firstObservedAtMs: (spec.eventTimeMs ?? barOpenTimeMs + 61_234) + 87,
    ohlcSoFar: { open: 0.83, high: 0.831, low: levelPrice, close: 0.82 },
    evidence: {
      basis: "IMMEDIATE_INTRABAR",
      evidenceClass: proven ? "PROVEN_INTRABAR_POSSIBLE" : "POSSIBLE_ONLY",
      proof: { bandEnteredBeforeClosingUpdate: proven, levelPresentOnEveryUpdate: true },
    },
  };
}

export function commit(barOpenTimeMs: number, classification: ShadowClassification = "SHADOW_LIVE_ONLY", lineageId = LINEAGE, symbol = SYMBOL): BarCloseCommitRecord {
  return {
    schema: SHADOW_EVENT_SCHEMA,
    kind: "BAR_CLOSE_COMMIT",
    eventId: commitEventId({ lineageId, symbol, barOpenTimeMs }),
    lineageId,
    marketType: "USDM_PERPETUAL",
    symbol,
    chartInterval: "15m",
    barOpenTime: new Date(barOpenTimeMs).toISOString(),
    barOpenTimeMs,
    actionable: false,
    classification,
    finalBar: { open: 0.83, high: 0.84, low: 0.81, close: 0.82 },
    committedCandidates: [{ signal: "LONG", sourceTf: "1D", levelPrice: 0.8123, levelKey: "1D:GOR:1", liveObserved: false }],
    liveObservationsNotCommitted: [],
    hwmOpenTimeMs: barOpenTimeMs + M15,
    stateSha256: "a".repeat(64),
    causalInputSha256ThroughHwm: "b".repeat(64),
  };
}

/** The bytes the scanner's store would write. */
export const lineOf = (record: unknown) => `${canonicalJson(record)}\n`;
export const logOf = (records: readonly unknown[]) => records.map(lineOf).join("");

/** A realistic multi-bar log: quarantined readiness bar, a live bar with 1M + two 1D + 1W, a live bar with one 1W, replayed recovery. */
export function realisticLog(): ShadowRecord[] {
  return [
    commit(bar(0), "QUARANTINED_CURRENT_BAR"),
    observation({ barMs: bar(1), sourceTf: "1M", levelPrice: 0.9, candidateSequence: 0, updateSequence: 2, createdBarOpenTimeMs: BAR0 - 30 * 96 * M15 }),
    observation({ barMs: bar(1), sourceTf: "1D", levelPrice: 0.81, candidateSequence: 1, updateSequence: 3 }),
    observation({ barMs: bar(1), sourceTf: "1D", levelPrice: 0.8, candidateSequence: 2, updateSequence: 3, createdBarOpenTimeMs: BAR0 - 2 * 96 * M15 }),
    observation({ barMs: bar(1), sourceTf: "1W", levelPrice: 0.79, candidateSequence: 3, updateSequence: 5, eventTimeMs: bar(1) + 200_000, createdBarOpenTimeMs: BAR0 - 7 * 96 * M15 }),
    commit(bar(1)),
    observation({ barMs: bar(2), sourceTf: "1W", signal: "SHORT", levelPrice: 0.95, candidateSequence: 0, updateSequence: 1, eventTimeMs: bar(2) + 1_000, createdBarOpenTimeMs: BAR0 - 7 * 96 * M15 }),
    commit(bar(2)),
    commit(bar(3), "REPLAYED_NON_ACTIONABLE"),
    commit(bar(4), "QUARANTINED_CURRENT_BAR"),
  ];
}
