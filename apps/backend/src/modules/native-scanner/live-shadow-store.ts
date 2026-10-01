import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import type { NativeImmediateCandidate, NativeSourceTf } from "@trading-alert-dashboard/shared";

import type { ScannerChartInterval, ScannerMarketType } from "./binance-public-futures";
import { canonicalJson, canonicalSha256 } from "./canonical-json";
import type { ReplayEvidenceClass } from "./historical-replay";
import { LiveShadowError } from "./live-shadow-checkpoint";

/**
 * Append-only, fsynced, local SHADOW evidence of the live scanner.
 *
 * Diagnostic only. No record here is actionable, none is a TradingView alert,
 * none is a dashboard Alert, and nothing here is read by anything that can
 * trade. A native level candidate is evidence; which of several candidates a
 * future emitter would deliver is deliberately not decided here.
 */

export const SHADOW_EVENT_SCHEMA = "teddy.native-scanner.live-shadow-event.v1";

/** SHADOW_LIVE_ONLY: observed live on a fully observed bar. The other two never were live. */
export type ShadowClassification = "SHADOW_LIVE_ONLY" | "QUARANTINED_CURRENT_BAR" | "REPLAYED_NON_ACTIONABLE";

interface ShadowRecordBase {
  readonly schema: typeof SHADOW_EVENT_SCHEMA;
  /** Deterministic identity: no wall clock, no sequence number. */
  readonly eventId: string;
  readonly lineageId: string;
  readonly marketType: ScannerMarketType;
  readonly symbol: string;
  readonly chartInterval: ScannerChartInterval;
  readonly barOpenTime: string;
  readonly barOpenTimeMs: number;
  /** Hard-coded: shadow evidence can never be acted on. */
  readonly actionable: false;
}

/** The FIRST live observation of one native level candidate on one bar. */
export interface LiveImmediateObservation extends ShadowRecordBase {
  readonly kind: "LIVE_IMMEDIATE_OBSERVATION";
  readonly classification: "SHADOW_LIVE_ONLY";
  readonly signal: NativeImmediateCandidate["signal"];
  readonly touchDirection: NativeImmediateCandidate["touchDirection"];
  readonly sourceTf: NativeSourceTf;
  readonly levelColor: NativeImmediateCandidate["levelColor"];
  readonly levelPrice: number;
  readonly levelKey: string;
  readonly level: NativeImmediateCandidate["level"];
  /** 0-based order in which this bar's native candidates were first observed (oldest level first within an update). */
  readonly candidateSequence: number;
  /** 1-based count of valid updates of this bar seen when it was first observed. */
  readonly updateSequence: number;
  readonly exchangeEventTimeMs: number;
  /** Provenance: local wall clock at observation. Not part of the identity. */
  readonly firstObservedAtMs: number;
  readonly ohlcSoFar: { readonly open: number; readonly high: number; readonly low: number; readonly close: number };
  readonly evidence: {
    readonly basis: "IMMEDIATE_INTRABAR";
    readonly evidenceClass: ReplayEvidenceClass;
    readonly proof: { readonly bandEnteredBeforeClosingUpdate: boolean; readonly levelPresentOnEveryUpdate: boolean };
  };
}

/** One committed causal bar and how its committed candidates relate to the live observations. */
export interface BarCloseCommitRecord extends ShadowRecordBase {
  readonly kind: "BAR_CLOSE_COMMIT";
  readonly classification: ShadowClassification;
  readonly finalBar: { readonly open: number; readonly high: number; readonly low: number; readonly close: number };
  readonly committedCandidates: readonly {
    readonly signal: string;
    readonly sourceTf: NativeSourceTf;
    readonly levelPrice: number;
    readonly levelKey: string;
    readonly liveObserved: boolean;
  }[];
  /** Live observations of this bar whose level did not commit at the close (e.g. closed through the band). */
  readonly liveObservationsNotCommitted: readonly string[];
  readonly hwmOpenTimeMs: number;
  readonly stateSha256: string;
  readonly causalInputSha256ThroughHwm: string;
}

export type ShadowRecord = LiveImmediateObservation | BarCloseCommitRecord;

export function observationEventId(parts: {
  lineageId: string;
  symbol: string;
  barOpenTimeMs: number;
  signal: string;
  sourceTf: string;
  levelKey: string;
}): string {
  return canonicalSha256({ kind: "LIVE_IMMEDIATE_OBSERVATION", ...parts });
}

export function commitEventId(parts: { lineageId: string; symbol: string; barOpenTimeMs: number }): string {
  return canonicalSha256({ kind: "BAR_CLOSE_COMMIT", ...parts });
}

function corrupt(message: string): never {
  throw new LiveShadowError("SHADOW_STORE_CORRUPT", message);
}

export class LiveShadowEventStore {
  readonly file: string;
  private readonly ids = new Set<string>();

  constructor(readonly dir: string) {
    this.file = path.join(dir, "events.jsonl");
    if (!existsSync(this.file)) return;
    const text = readFileSync(this.file, "utf8");
    if (text !== "" && !text.endsWith("\n")) corrupt("the event log ends in a torn line");
    for (const [index, line] of (text === "" ? [] : text.slice(0, -1).split("\n")).entries()) {
      let record: ShadowRecord;
      try {
        record = JSON.parse(line) as ShadowRecord;
      } catch {
        corrupt(`event log line ${index + 1} is not JSON`);
      }
      if (record.schema !== SHADOW_EVENT_SCHEMA || record.actionable !== false || typeof record.eventId !== "string") {
        corrupt(`event log line ${index + 1} is not a non-actionable shadow record`);
      }
      if (this.ids.has(record.eventId)) corrupt(`event log line ${index + 1} repeats event ${record.eventId}`);
      this.ids.add(record.eventId);
    }
  }

  has(eventId: string): boolean {
    return this.ids.has(eventId);
  }

  /** Appends and fsyncs one record. An event already stored is not written twice; returns false then. */
  append(record: ShadowRecord): boolean {
    if (record.actionable !== false) throw new LiveShadowError("INVALID_STATE", "a shadow record can never be actionable");
    if (this.ids.has(record.eventId)) return false;
    mkdirSync(this.dir, { recursive: true });
    const fd = openSync(this.file, "a");
    try {
      writeSync(fd, `${canonicalJson(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.ids.add(record.eventId);
    return true;
  }
}
