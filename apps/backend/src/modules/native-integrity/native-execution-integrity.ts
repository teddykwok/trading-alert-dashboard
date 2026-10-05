import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { NativeExecutionIntegrityDto, NativeExecutionIntegrityStatus } from "@trading-alert-dashboard/shared";

import { NATIVE_ALERT_SOURCE } from "../alerts/alert-source";
import { LiveCheckpointStore, type LiveCheckpointFile } from "../native-scanner/live-shadow-checkpoint";
import { commitEventId, observationEventId, type BarCloseCommitRecord, type ShadowRecord } from "../native-scanner/live-shadow-store";
import { engineFingerprintOf, liveShadowEngineDir, profileById } from "../native-scanner/scanner-profile";
import { scannerRootDir } from "../native-scanner/scanner-paths";
import { NATIVE_ALERT_PAYLOAD_SCHEMA_V2 } from "../native-alerts/native-alert-draft";
import { NATIVE_DELIVERY_CHART_INTERVALS, NATIVE_DELIVERY_MARKET_TYPE, type NativeDeliveryChartInterval } from "../native-alerts/native-delivery-policy";
import { ShadowLogError, ShadowLogTail, type ShadowLogIdentity } from "../native-alerts/shadow-log-reader";

/**
 * NATIVE EXECUTION DATA INTEGRITY.
 *
 * A Native alert is delivered, shown and planned IMMEDIATELY, from a live
 * observation on a still-forming operational 15m bar. Nothing here changes or
 * delays that. This module answers a different, later question: did the
 * scanner's FINAL evidence for that bar turn out clean? Only then may a FUTURE
 * executor act on the alert — and today none may: Native execution stays
 * hard-disabled in code (alerts/alert-source.ts).
 *
 * The answer is rebuilt every time from durable evidence only — the alert's
 * immutable rawPayload provenance plus the scanner's fsynced event log and
 * hash-verified checkpoint. No process memory, no wall clock ("15 minutes
 * passed" proves nothing), no database write. An alert that is not ELIGIBLE
 * stays exactly as it is: the alert, its delivery row and its plan are history.
 *
 * TradingView alerts are never judged here.
 */

const SHA = /^[0-9a-f]{64}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Everything about the source bar the alert's own durable payload proves. */
export interface NativeExecutionProvenance {
  readonly lineageId: string;
  readonly shadowEventId: string;
  readonly marketType: typeof NATIVE_DELIVERY_MARKET_TYPE;
  readonly symbol: string;
  readonly chartInterval: NativeDeliveryChartInterval;
  readonly barOpenTimeMs: number;
  readonly levelKey: string;
  readonly profileId: string;
  readonly engineFingerprint: string;
}

/** The fields of an Alert row the evaluator reads. Nothing else is needed or trusted. */
export interface NativeIntegrityAlert {
  readonly source: string | null | undefined;
  readonly symbol: string;
  readonly rawPayload: unknown;
}

/**
 * The scanner's durable evidence for one provenance, as read from disk.
 * `checkpoint`: null = no checkpoint file; a string = present but unverifiable.
 */
export interface NativeScannerEvidence {
  /** The engine fingerprint the alert's profile has in THIS code, or null when the profile no longer exists. */
  readonly currentEngineFingerprint: string | null;
  /** events.jsonl as read, or null when it does not exist. */
  readonly eventLogText: string | null;
  readonly checkpoint: LiveCheckpointFile | null | { readonly unverifiable: string };
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The alert's provenance, or why it does not prove one (old payloads, hand-made rows, anything partial). */
export function nativeExecutionProvenanceOf(alert: NativeIntegrityAlert): { ok: true; provenance: NativeExecutionProvenance } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  const raw = alert.rawPayload;
  if (!isObject(raw)) return no("the alert carries no Native payload");
  if (raw.schema !== NATIVE_ALERT_PAYLOAD_SCHEMA_V2) return no(`payload schema ${JSON.stringify(raw.schema)} does not carry profile/run provenance`);
  const delivery = raw.delivery;
  const profile = raw.profile;
  if (!isObject(delivery) || !isObject(profile)) return no("the payload has no delivery or profile provenance");
  const { lineageId, shadowEventId, levelKey, sourceTimeframe, barStart } = delivery;
  const { profileId, engineFingerprint } = profile;
  if (raw.symbol !== alert.symbol) return no("the payload symbol is not the alert's symbol");
  if (raw.marketType !== NATIVE_DELIVERY_MARKET_TYPE) return no("the payload names no supported market");
  if (typeof raw.timeframe !== "string" || !Object.prototype.hasOwnProperty.call(NATIVE_DELIVERY_CHART_INTERVALS, raw.timeframe)) {
    return no("the payload names no supported operational chart interval");
  }
  const chartInterval = raw.timeframe as NativeDeliveryChartInterval;
  if (typeof lineageId !== "string" || !SHA.test(lineageId)) return no("the payload has no scanner lineage");
  if (typeof shadowEventId !== "string" || !SHA.test(shadowEventId)) return no("the payload has no shadow event identity");
  if (typeof engineFingerprint !== "string" || !SHA.test(engineFingerprint)) return no("the payload has no engine fingerprint");
  if (typeof profileId !== "string" || profileId === "") return no("the payload has no scanner profile");
  if (typeof levelKey !== "string" || typeof sourceTimeframe !== "string" || (raw.signal !== "LONG" && raw.signal !== "SHORT")) {
    return no("the payload has no level identity");
  }
  if (typeof barStart !== "string" || !ISO_MS.test(barStart) || raw.barTime !== barStart) return no("the payload names no single source bar");
  const barOpenTimeMs = Date.parse(barStart);
  if (!Number.isSafeInteger(barOpenTimeMs) || barOpenTimeMs % NATIVE_DELIVERY_CHART_INTERVALS[chartInterval] !== 0) {
    return no("the payload's source bar is not on an operational bar boundary");
  }
  // The shadow event identity is a hash of exactly these fields: a payload whose parts disagree proves nothing.
  const expected = observationEventId({ lineageId, symbol: alert.symbol, barOpenTimeMs, signal: raw.signal, sourceTf: sourceTimeframe, levelKey });
  if (expected !== shadowEventId) return no("the payload's shadow event identity does not match its own bar, level and lineage");
  return {
    ok: true,
    provenance: { lineageId, shadowEventId, marketType: NATIVE_DELIVERY_MARKET_TYPE, symbol: alert.symbol, chartInterval, barOpenTimeMs, levelKey, profileId, engineFingerprint },
  };
}

const result = (status: NativeExecutionIntegrityStatus, reason: string, barOpenTimeMs: number | null): NativeExecutionIntegrityDto => ({
  status,
  reason,
  barOpenTime: barOpenTimeMs === null ? null : new Date(barOpenTimeMs).toISOString(),
});

const DUPLICATE_CODES = new Set(["DUPLICATE_EVENT_ID", "CONFLICTING_DUPLICATE_EVENT_ID"]);

/**
 * The execution-integrity verdict for ONE Native alert. Pure and deterministic:
 * the same alert and the same evidence always give the same answer, and
 * nothing is written anywhere.
 *
 * ELIGIBLE only when the evidence proves, for the alert's bar B:
 *  - the alert's own live observation is in the strict, single-lineage log;
 *  - exactly one BAR_CLOSE_COMMIT for B exists, classified SHADOW_LIVE_ONLY
 *    (not quarantined, not replayed);
 *  - the commit for B - 1 bar exists too (no hole before B);
 *  - the verified checkpoint is this lineage, is not behind that commit, and
 *    agrees with the newest commit when it sits exactly there;
 *  - the alert's engine generation is the current one.
 * Anything else blocks; anything unknown is UNREADABLE, never eligible.
 */
export function evaluateNativeExecutionIntegrity(alert: NativeIntegrityAlert, evidence: NativeScannerEvidence): NativeExecutionIntegrityDto {
  if (alert.source !== NATIVE_ALERT_SOURCE) {
    // A programming error, not a verdict: the rule is Native-only, and TradingView never reaches it.
    throw new Error(`execution-integrity is a Native-only rule; a ${String(alert.source)} alert was passed`);
  }
  const parsed = nativeExecutionProvenanceOf(alert);
  if (!parsed.ok) return result("UNREADABLE", `Insufficient durable provenance: ${parsed.reason}.`, null);
  const p = parsed.provenance;
  const B = p.barOpenTimeMs;
  const intervalMs = NATIVE_DELIVERY_CHART_INTERVALS[p.chartInterval];

  if (evidence.currentEngineFingerprint === null) return result("INELIGIBLE_STALE_GENERATION", `Profile ${p.profileId} no longer exists in this code.`, B);
  if (evidence.currentEngineFingerprint !== p.engineFingerprint) {
    return result("INELIGIBLE_STALE_GENERATION", "The alert came from an engine generation that is no longer current.", B);
  }

  const checkpoint = evidence.checkpoint;
  if (checkpoint === null) return result("UNREADABLE", "The scanner has no checkpoint for this symbol.", B);
  if ("unverifiable" in checkpoint) return result("INELIGIBLE_CHECKPOINT_MISMATCH", `The scanner checkpoint does not verify: ${checkpoint.unverifiable}`, B);
  const body = checkpoint.body;
  if (body.lineageId !== p.lineageId) return result("INELIGIBLE_STALE_GENERATION", "The scanner checkpoint belongs to a different lineage than the alert.", B);
  if (body.marketType !== p.marketType || body.symbol !== p.symbol || body.chartInterval !== p.chartInterval) {
    return result("INELIGIBLE_CHECKPOINT_MISMATCH", "The scanner checkpoint is for a different market, symbol or interval.", B);
  }

  if (evidence.eventLogText === null) return result("UNREADABLE", "The scanner event log for this symbol does not exist.", B);
  const identity: ShadowLogIdentity = { lineageId: p.lineageId, marketType: p.marketType, symbol: p.symbol, chartInterval: p.chartInterval };
  let records: ShadowRecord[];
  try {
    // One trailing partial line is the writer mid-append: it is not evidence yet, so it is left unread (not refused).
    records = new ShadowLogTail(identity, 1).read(evidence.eventLogText);
  } catch (error) {
    if (!(error instanceof ShadowLogError)) return result("UNREADABLE", "The scanner event log could not be read.", B);
    if (DUPLICATE_CODES.has(error.code)) return result("INELIGIBLE_DUPLICATE", `The scanner event log repeats an event identity (${error.code}).`, B);
    if (error.code === "LINEAGE_MISMATCH") return result("INELIGIBLE_STALE_GENERATION", "The scanner event log holds another lineage.", B);
    return result("UNREADABLE", `The scanner event log fails strict validation (${error.code}).`, B);
  }

  if (!records.some((r) => r.kind === "LIVE_IMMEDIATE_OBSERVATION" && r.eventId === p.shadowEventId)) {
    return result("UNREADABLE", "The alert's live observation is not in the scanner event log.", B);
  }
  const commits = records.filter((r): r is BarCloseCommitRecord => r.kind === "BAR_CLOSE_COMMIT");
  const commitIdOf = (barOpenTimeMs: number) => commitEventId({ lineageId: p.lineageId, symbol: p.symbol, barOpenTimeMs });
  const commitsOfB = commits.filter((c) => c.barOpenTimeMs === B);
  if (commitsOfB.length > 1) return result("INELIGIBLE_DUPLICATE", "The source bar was committed more than once.", B);
  const commit = commitsOfB[0];

  if (commit === undefined) {
    if (body.hwmOpenTimeMs < B) return result("INELIGIBLE_CHECKPOINT_MISMATCH", "The scanner checkpoint is behind the alert's own observed bar.", B);
    if (body.hwmOpenTimeMs === B) return result("PENDING_BAR_CLOSE", "The source bar has not been committed by the scanner yet.", B);
    return result("UNREADABLE", "The scanner moved past the source bar without a durable commit record for it.", B);
  }
  if (commit.eventId !== commitIdOf(B)) return result("UNREADABLE", "The source bar's commit has an unexpected identity.", B);
  if (commit.classification !== "SHADOW_LIVE_ONLY") {
    return result("INELIGIBLE_REQUARANTINED", `The source bar was finally committed ${commit.classification}, not live.`, B);
  }
  if (!commits.some((c) => c.barOpenTimeMs === B - intervalMs)) {
    return result("INELIGIBLE_GAP", "No committed bar immediately precedes the source bar in the scanner evidence.", B);
  }
  // The scanner saves its checkpoint BEFORE appending the commit, and the log is read first: a checkpoint behind ANY durable commit was rewound.
  const newest = commits[commits.length - 1];
  if (body.hwmOpenTimeMs < newest.hwmOpenTimeMs) return result("INELIGIBLE_CHECKPOINT_MISMATCH", "The scanner checkpoint is behind a durable commit (rewound or restored).", B);
  if (body.hwmOpenTimeMs === newest.hwmOpenTimeMs && (body.stateSha256 !== newest.stateSha256 || body.causalInputSha256ThroughHwm !== newest.causalInputSha256ThroughHwm)) {
    return result("INELIGIBLE_CHECKPOINT_MISMATCH", "The scanner checkpoint disagrees with the newest committed bar.", B);
  }
  return result("ELIGIBLE", "The source bar closed and was committed live, contiguous and checkpoint-consistent.", B);
}

// ---------------------------------------------------------------------------
// Read-only evidence loading
// ---------------------------------------------------------------------------

/** Reads one provenance's evidence. Read only: never takes the scanner lock, never writes. */
export type NativeScannerEvidenceReader = (provenance: NativeExecutionProvenance) => NativeScannerEvidence;

/**
 * Evidence from the machine-local scanner tree (%LOCALAPPDATA%). The log is
 * read BEFORE the checkpoint: the scanner saves the checkpoint before it
 * appends the matching commit, so this order never pairs a commit with an
 * older checkpoint. A read that races the writer can only come back less
 * eligible (UNREADABLE), never more.
 */
export function fileSystemNativeScannerEvidence(env: NodeJS.ProcessEnv): NativeScannerEvidenceReader {
  const fingerprints = new Map<string, string | null>();
  const currentFingerprint = (profileId: string): string | null => {
    if (!fingerprints.has(profileId)) {
      let value: string | null;
      try {
        value = engineFingerprintOf(profileById(profileId));
      } catch {
        value = null;
      }
      fingerprints.set(profileId, value);
    }
    return fingerprints.get(profileId) ?? null;
  };
  return (provenance) => {
    const currentEngineFingerprint = currentFingerprint(provenance.profileId);
    let dir: string;
    try {
      dir = liveShadowEngineDir(scannerRootDir(env), provenance.engineFingerprint, provenance.marketType, provenance.symbol, provenance.chartInterval);
    } catch {
      return { currentEngineFingerprint, eventLogText: null, checkpoint: null };
    }
    const logFile = path.join(dir, "events.jsonl");
    let eventLogText: string | null = null;
    try {
      eventLogText = existsSync(logFile) ? readFileSync(logFile, "utf8") : null;
    } catch {
      eventLogText = null;
    }
    let checkpoint: NativeScannerEvidence["checkpoint"];
    try {
      checkpoint = new LiveCheckpointStore(dir).load();
    } catch (error) {
      checkpoint = { unverifiable: error instanceof Error ? error.message : "unreadable" };
    }
    return { currentEngineFingerprint, eventLogText, checkpoint };
  };
}

/** Reader + evaluator for one Native alert; never throws for one (anything unreadable is UNREADABLE). */
export function nativeExecutionIntegrityOf(alert: NativeIntegrityAlert, reader: NativeScannerEvidenceReader | null): NativeExecutionIntegrityDto {
  if (alert.source !== NATIVE_ALERT_SOURCE) throw new Error(`execution-integrity is a Native-only rule; a ${String(alert.source)} alert was passed`);
  const parsed = nativeExecutionProvenanceOf(alert);
  if (!parsed.ok) return result("UNREADABLE", `Insufficient durable provenance: ${parsed.reason}.`, null);
  if (reader === null) return result("UNREADABLE", "No scanner evidence is available to this process.", parsed.provenance.barOpenTimeMs);
  try {
    return evaluateNativeExecutionIntegrity(alert, reader(parsed.provenance));
  } catch {
    return result("UNREADABLE", "The scanner evidence could not be evaluated.", parsed.provenance.barOpenTimeMs);
  }
}

// ---------------------------------------------------------------------------
// FUTURE admission guard (pure; wired into nothing)
// ---------------------------------------------------------------------------

export type NativeExecutionAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: "NATIVE_EXECUTION_DISABLED" | "NATIVE_INTEGRITY_NOT_ELIGIBLE"; readonly integrity: NativeExecutionIntegrityStatus | null };

/**
 * What a FUTURE Native executor must ask immediately before its FIRST
 * irreversible exchange mutation (canary, signed/private call, margin, order),
 * after every normal admission check. It is not called by anything today.
 *
 * Both conditions are required, in this order: the hard execution switch
 * first (false in this code, so nothing is ever admitted), then integrity —
 * which only ELIGIBLE passes. The integrity verdict can only ADD a refusal; it
 * can never stand in for the execution switch. TradingView never comes here.
 */
export function judgeNativeExecutionAdmission(input: { readonly nativeExecutionEnabled: boolean; readonly integrity: NativeExecutionIntegrityDto | null }): NativeExecutionAdmission {
  if (input.nativeExecutionEnabled !== true) return { admitted: false, reason: "NATIVE_EXECUTION_DISABLED", integrity: input.integrity?.status ?? null };
  if (input.integrity === null || input.integrity.status !== "ELIGIBLE") {
    return { admitted: false, reason: "NATIVE_INTEGRITY_NOT_ELIGIBLE", integrity: input.integrity?.status ?? null };
  }
  return { admitted: true };
}
