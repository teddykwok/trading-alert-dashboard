import { createHash } from "node:crypto";
import { SOURCE_TIMEFRAMES } from "@trading-alert-dashboard/shared";

import {
  SHADOW_EVENT_SCHEMA,
  commitEventId,
  observationEventId,
  type BarCloseCommitRecord,
  type LiveImmediateObservation,
  type ShadowRecord,
} from "../native-scanner/live-shadow-store";
import { canonicalJson } from "../native-scanner/canonical-json";
import { NATIVE_DELIVERY_CHART_INTERVALS, NATIVE_DELIVERY_MARKET_TYPE, type NativeDeliveryChartInterval } from "./native-delivery-policy";

/**
 * The native alert emitter's STRICT reader of the live shadow scanner's durable
 * `events.jsonl`.
 *
 * It is the emitter's only input. Volatile WebSocket callbacks never reach the
 * emitter; only records the scanner has already fsynced do. Every rule here
 * fails CLOSED: a log that is torn, rewritten, mis-identified, out of order, or
 * claims to be actionable stops the emitter before anything is delivered.
 *
 * Pure: it is handed text and returns records. No file system, clock or database.
 */

export type ShadowLogErrorCode =
  | "TORN_LINE"
  | "NOT_JSON"
  | "INVALID_SCHEMA"
  | "INVALID_EVENT_IDENTITY"
  | "DUPLICATE_EVENT_ID"
  | "CONFLICTING_DUPLICATE_EVENT_ID"
  | "ACTIONABLE_RECORD"
  | "LINEAGE_MISMATCH"
  | "MARKET_MISMATCH"
  | "SYMBOL_MISMATCH"
  | "INTERVAL_MISMATCH"
  | "IMPOSSIBLE_ORDERING"
  | "LOG_REWRITTEN";

export class ShadowLogError extends Error {
  constructor(
    readonly code: ShadowLogErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ShadowLogError";
  }
}

/** The one lineage, market, symbol and chart interval this emitter instance reads. */
export interface ShadowLogIdentity {
  readonly lineageId: string;
  readonly marketType: typeof NATIVE_DELIVERY_MARKET_TYPE;
  readonly symbol: string;
  readonly chartInterval: NativeDeliveryChartInterval;
}

const SHA = /^[0-9a-f]{64}$/;
const SYMBOL = /^[A-Z0-9]{3,30}$/;
const BASE_KEYS = ["schema", "kind", "eventId", "lineageId", "marketType", "symbol", "chartInterval", "barOpenTime", "barOpenTimeMs", "actionable", "classification"];
const OBSERVATION_KEYS = [
  ...BASE_KEYS,
  "signal",
  "touchDirection",
  "sourceTf",
  "levelColor",
  "levelPrice",
  "levelKey",
  "level",
  "candidateSequence",
  "updateSequence",
  "exchangeEventTimeMs",
  "firstObservedAtMs",
  "ohlcSoFar",
  "evidence",
].sort();
const COMMIT_KEYS = [
  ...BASE_KEYS,
  "finalBar",
  "committedCandidates",
  "liveObservationsNotCommitted",
  "hwmOpenTimeMs",
  "stateSha256",
  "causalInputSha256ThroughHwm",
].sort();
const LEVEL_KEYS = ["id", "condition", "htfPeriodStartMs", "createdBarIndex", "createdBarOpenTimeMs"].sort();
const OHLC_KEYS = ["open", "high", "low", "close"].sort();
const COMMIT_CLASSIFICATIONS = ["SHADOW_LIVE_ONLY", "QUARANTINED_CURRENT_BAR", "REPLAYED_NON_ACTIONABLE"];
const LIVE_EVIDENCE_CLASSES = ["PROVEN_INTRABAR_POSSIBLE", "POSSIBLE_ONLY"];

const fail = (code: ShadowLogErrorCode, message: string): never => {
  throw new ShadowLogError(code, message);
};

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]) => canonicalJson(Object.keys(value).sort()) === canonicalJson(keys);
const isInt = (value: unknown): value is number => Number.isSafeInteger(value);
const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

function assertOhlc(value: unknown, at: string): void {
  if (!isObject(value) || !sameKeys(value, OHLC_KEYS) || !OHLC_KEYS.every((key) => isPositive(value[key]))) {
    fail("INVALID_SCHEMA", `${at} must be four positive finite prices`);
  }
}

/**
 * Validates records one at a time, in log order, carrying the cross-record
 * invariants (identity uniqueness and bar ordering) between calls.
 */
export class ShadowLogValidator {
  private readonly intervalMs: number;
  private readonly ids = new Map<string, string>();
  private lastCommitBarMs: number | null = null;
  private maxObservedBarMs: number | null = null;
  private openBar: { barOpenTimeMs: number; observations: number; updateSequence: number; exchangeEventTimeMs: number } | null = null;
  private count = 0;

  constructor(readonly identity: ShadowLogIdentity) {
    if (!SHA.test(identity.lineageId)) fail("LINEAGE_MISMATCH", "the expected lineage ID must be a SHA-256 hex digest");
    if (identity.marketType !== NATIVE_DELIVERY_MARKET_TYPE) fail("MARKET_MISMATCH", "only USDM_PERPETUAL is supported");
    if (!SYMBOL.test(identity.symbol)) fail("SYMBOL_MISMATCH", "the expected symbol must be one bare uppercase Binance symbol");
    if (!Object.prototype.hasOwnProperty.call(NATIVE_DELIVERY_CHART_INTERVALS, identity.chartInterval)) {
      fail("INTERVAL_MISMATCH", `chart interval must be one of: ${Object.keys(NATIVE_DELIVERY_CHART_INTERVALS).join(", ")}`);
    }
    this.intervalMs = NATIVE_DELIVERY_CHART_INTERVALS[identity.chartInterval];
  }

  get recordCount(): number {
    return this.count;
  }

  /** Parses and validates one complete line (without its newline). */
  acceptLine(line: string, lineNumber: number): ShadowRecord {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return fail("NOT_JSON", `line ${lineNumber} is not JSON`);
    }
    return this.accept(parsed, lineNumber, line);
  }

  accept(value: unknown, lineNumber: number, line: string = canonicalJson(value)): ShadowRecord {
    const at = `line ${lineNumber}`;
    if (!isObject(value)) return fail("INVALID_SCHEMA", `${at} is not a JSON object`);
    // Actionability first and on its own: it is the one claim that must never pass, whatever else is wrong.
    if (value.actionable !== false) return fail("ACTIONABLE_RECORD", `${at} is not a non-actionable shadow record`);
    if (value.schema !== SHADOW_EVENT_SCHEMA) return fail("INVALID_SCHEMA", `${at} has an unknown schema`);
    if (typeof value.eventId !== "string" || !SHA.test(value.eventId)) return fail("INVALID_EVENT_IDENTITY", `${at} has no valid eventId`);

    const previous = this.ids.get(value.eventId);
    if (previous !== undefined) {
      return previous === line
        ? fail("DUPLICATE_EVENT_ID", `${at} repeats event ${value.eventId}`)
        : fail("CONFLICTING_DUPLICATE_EVENT_ID", `${at} reuses event ${value.eventId} with different content`);
    }

    if (value.lineageId !== this.identity.lineageId) return fail("LINEAGE_MISMATCH", `${at} belongs to another lineage`);
    if (value.marketType !== this.identity.marketType) return fail("MARKET_MISMATCH", `${at} is for another market`);
    if (value.symbol !== this.identity.symbol) return fail("SYMBOL_MISMATCH", `${at} is for another symbol`);
    if (value.chartInterval !== this.identity.chartInterval) return fail("INTERVAL_MISMATCH", `${at} is for another chart interval`);
    if (!isInt(value.barOpenTimeMs) || value.barOpenTimeMs % this.intervalMs !== 0 || value.barOpenTimeMs <= 0) {
      return fail("INVALID_SCHEMA", `${at} has a bar open time that is not on a bar boundary`);
    }
    if (value.barOpenTime !== new Date(value.barOpenTimeMs).toISOString()) return fail("INVALID_SCHEMA", `${at} has inconsistent bar open times`);

    const record =
      value.kind === "LIVE_IMMEDIATE_OBSERVATION"
        ? this.acceptObservation(value, at)
        : value.kind === "BAR_CLOSE_COMMIT"
          ? this.acceptCommit(value, at)
          : fail("INVALID_SCHEMA", `${at} has an unknown record kind`);

    this.ids.set(record.eventId, line);
    this.count += 1;
    return record;
  }

  private acceptObservation(value: Record<string, unknown>, at: string): LiveImmediateObservation {
    if (!sameKeys(value, OBSERVATION_KEYS)) fail("INVALID_SCHEMA", `${at} has missing or extra observation fields`);
    if (value.classification !== "SHADOW_LIVE_ONLY") fail("INVALID_SCHEMA", `${at}: a live observation is always SHADOW_LIVE_ONLY`);
    if (value.signal !== "LONG" && value.signal !== "SHORT") fail("INVALID_SCHEMA", `${at} has an invalid signal`);
    if (value.touchDirection !== "FROM_ABOVE" && value.touchDirection !== "FROM_BELOW") fail("INVALID_SCHEMA", `${at} has an invalid touch direction`);
    if (value.levelColor !== "GREEN" && value.levelColor !== "RED") fail("INVALID_SCHEMA", `${at} has an invalid level color`);
    if (!(SOURCE_TIMEFRAMES as readonly unknown[]).includes(value.sourceTf)) fail("INVALID_SCHEMA", `${at} has an invalid source timeframe`);
    if (!isPositive(value.levelPrice)) fail("INVALID_SCHEMA", `${at} has an invalid level price`);
    const level = value.level;
    if (
      !isObject(level) ||
      !sameKeys(level, LEVEL_KEYS) ||
      !["GOR", "ROR", "GOG", "ROG"].includes(level.condition as string) ||
      !isInt(level.id) ||
      !isInt(level.htfPeriodStartMs) ||
      !isInt(level.createdBarIndex) ||
      !isInt(level.createdBarOpenTimeMs)
    ) {
      fail("INVALID_SCHEMA", `${at} has an invalid level`);
    }
    const lvl = level as Record<string, unknown>;
    if (value.levelKey !== `${value.sourceTf as string}:${lvl.condition as string}:${lvl.createdBarOpenTimeMs as number}`) {
      fail("INVALID_SCHEMA", `${at} has a level key that does not match its level`);
    }
    if (!isInt(value.candidateSequence) || value.candidateSequence < 0) fail("INVALID_SCHEMA", `${at} has an invalid candidate sequence`);
    if (!isInt(value.updateSequence) || value.updateSequence < 1) fail("INVALID_SCHEMA", `${at} has an invalid update sequence`);
    if (!isInt(value.exchangeEventTimeMs) || !isInt(value.firstObservedAtMs) || value.firstObservedAtMs < 0) {
      fail("INVALID_SCHEMA", `${at} has invalid observation times`);
    }
    assertOhlc(value.ohlcSoFar, `${at} ohlcSoFar`);
    const evidence = value.evidence;
    const proof = isObject(evidence) ? evidence.proof : null;
    if (
      !isObject(evidence) ||
      !sameKeys(evidence, ["basis", "evidenceClass", "proof"]) ||
      evidence.basis !== "IMMEDIATE_INTRABAR" ||
      !LIVE_EVIDENCE_CLASSES.includes(evidence.evidenceClass as string) ||
      !isObject(proof) ||
      !sameKeys(proof, ["bandEnteredBeforeClosingUpdate", "levelPresentOnEveryUpdate"]) ||
      typeof proof.bandEnteredBeforeClosingUpdate !== "boolean" ||
      typeof proof.levelPresentOnEveryUpdate !== "boolean"
    ) {
      fail("INVALID_SCHEMA", `${at} has invalid live evidence`);
    }

    const record = value as unknown as LiveImmediateObservation;
    const expectedId = observationEventId({
      lineageId: record.lineageId,
      symbol: record.symbol,
      barOpenTimeMs: record.barOpenTimeMs,
      signal: record.signal,
      sourceTf: record.sourceTf,
      levelKey: record.levelKey,
    });
    if (record.eventId !== expectedId) fail("INVALID_EVENT_IDENTITY", `${at}: eventId does not match the observation it identifies`);

    // ---- ordering ----------------------------------------------------------
    const bar = record.barOpenTimeMs;
    if (this.lastCommitBarMs !== null && bar <= this.lastCommitBarMs) {
      fail("IMPOSSIBLE_ORDERING", `${at} observes bar ${record.barOpenTime}, which was already committed`);
    }
    if (this.maxObservedBarMs !== null && bar < this.maxObservedBarMs) fail("IMPOSSIBLE_ORDERING", `${at} observes a bar older than one already observed`);
    if (record.exchangeEventTimeMs < bar) fail("IMPOSSIBLE_ORDERING", `${at} was observed before its bar opened`);
    if (this.openBar === null || this.openBar.barOpenTimeMs !== bar) {
      this.openBar = { barOpenTimeMs: bar, observations: 0, updateSequence: 0, exchangeEventTimeMs: bar };
    }
    const open = this.openBar;
    if (record.candidateSequence !== open.observations) {
      fail("IMPOSSIBLE_ORDERING", `${at} has candidate sequence ${record.candidateSequence}, expected ${open.observations}`);
    }
    if (record.updateSequence < open.updateSequence || record.exchangeEventTimeMs < open.exchangeEventTimeMs) {
      fail("IMPOSSIBLE_ORDERING", `${at} goes backwards in update order or event time within its bar`);
    }
    open.observations += 1;
    open.updateSequence = record.updateSequence;
    open.exchangeEventTimeMs = record.exchangeEventTimeMs;
    this.maxObservedBarMs = bar;
    return record;
  }

  private acceptCommit(value: Record<string, unknown>, at: string): BarCloseCommitRecord {
    if (!sameKeys(value, COMMIT_KEYS)) fail("INVALID_SCHEMA", `${at} has missing or extra commit fields`);
    if (!COMMIT_CLASSIFICATIONS.includes(value.classification as string)) fail("INVALID_SCHEMA", `${at} has an invalid classification`);
    assertOhlc(value.finalBar, `${at} finalBar`);
    if (!Array.isArray(value.committedCandidates) || !value.committedCandidates.every(isObject)) fail("INVALID_SCHEMA", `${at} has invalid committed candidates`);
    if (!Array.isArray(value.liveObservationsNotCommitted) || !value.liveObservationsNotCommitted.every((key) => typeof key === "string")) {
      fail("INVALID_SCHEMA", `${at} has invalid uncommitted observations`);
    }
    if (typeof value.stateSha256 !== "string" || !SHA.test(value.stateSha256) || typeof value.causalInputSha256ThroughHwm !== "string" || !SHA.test(value.causalInputSha256ThroughHwm)) {
      fail("INVALID_SCHEMA", `${at} has invalid state hashes`);
    }
    const record = value as unknown as BarCloseCommitRecord;
    if (record.hwmOpenTimeMs !== record.barOpenTimeMs + this.intervalMs) fail("INVALID_SCHEMA", `${at}: the high-water mark must be the bar after the committed one`);
    if (record.eventId !== commitEventId({ lineageId: record.lineageId, symbol: record.symbol, barOpenTimeMs: record.barOpenTimeMs })) {
      fail("INVALID_EVENT_IDENTITY", `${at}: eventId does not match the commit it identifies`);
    }
    if (this.lastCommitBarMs !== null && record.barOpenTimeMs <= this.lastCommitBarMs) fail("IMPOSSIBLE_ORDERING", `${at} commits a bar at or before the last committed bar`);
    if (this.maxObservedBarMs !== null && record.barOpenTimeMs < this.maxObservedBarMs) fail("IMPOSSIBLE_ORDERING", `${at} commits a bar older than one already observed live`);
    this.lastCommitBarMs = record.barOpenTimeMs;
    if (this.openBar?.barOpenTimeMs === record.barOpenTimeMs) this.openBar = null;
    return record;
  }
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Reads an append-only log incrementally. Each `read(text)` is handed the
 * WHOLE current file; bytes already consumed must be byte-identical (a
 * rewritten, truncated or replaced log is refused), and only complete lines
 * past them are validated and returned.
 *
 * A trailing partial line is either refused at once (`pendingTailPolls` 0: a
 * one-shot read) or tolerated for that many consecutive reads while the writer
 * finishes it, then refused.
 */
export class ShadowLogTail {
  private consumedChars = 0;
  private consumedSha256 = sha256("");
  private lines = 0;
  private pendingTail: { text: string; polls: number } | null = null;
  readonly validator: ShadowLogValidator;

  constructor(
    identity: ShadowLogIdentity,
    private readonly pendingTailPolls: number
  ) {
    this.validator = new ShadowLogValidator(identity);
  }

  get linesRead(): number {
    return this.lines;
  }

  /** `text` null: the log does not exist (yet). Returns the newly completed records, validated. */
  read(text: string | null): ShadowRecord[] {
    return this.readWithOffsets(text).map((entry) => entry.record);
  }

  /** Characters of the log consumed so far (always a line boundary). */
  get consumedLength(): number {
    return this.consumedChars;
  }

  /**
   * As `read`, with each record's END offset: the character position just past
   * its newline. A cursor that stores such an offset always sits on a line
   * boundary, after a record that was completely processed.
   */
  readWithOffsets(text: string | null): { readonly record: ShadowRecord; readonly endChars: number }[] {
    if (text === null) {
      if (this.consumedChars > 0) fail("LOG_REWRITTEN", "the event log disappeared after it was read");
      return [];
    }
    if (text.length < this.consumedChars || sha256(text.slice(0, this.consumedChars)) !== this.consumedSha256) {
      fail("LOG_REWRITTEN", "bytes of the event log that were already read have changed: it is append-only");
    }
    const end = text.lastIndexOf("\n") + 1;
    const tail = text.slice(Math.max(end, this.consumedChars));
    if (tail !== "") {
      const polls = this.pendingTail?.text === tail ? this.pendingTail.polls + 1 : 1;
      if (polls > this.pendingTailPolls) fail("TORN_LINE", "the event log ends in a torn line");
      this.pendingTail = { text: tail, polls };
    } else {
      this.pendingTail = null;
    }
    if (end <= this.consumedChars) return [];

    const fresh = text.slice(this.consumedChars, end - 1).split("\n");
    const records: { record: ShadowRecord; endChars: number }[] = [];
    let position = this.consumedChars;
    for (const line of fresh) {
      this.lines += 1;
      if (line === "") fail("TORN_LINE", `line ${this.lines} is empty`);
      position += line.length + 1;
      records.push({ record: this.validator.acceptLine(line, this.lines), endChars: position });
    }
    this.consumedChars = end;
    this.consumedSha256 = sha256(text.slice(0, end));
    return records;
  }
}

/** One-shot: every record of a complete log, validated, or a refusal. */
export function parseShadowEventLog(text: string, identity: ShadowLogIdentity): ShadowRecord[] {
  return new ShadowLogTail(identity, 0).read(text);
}
