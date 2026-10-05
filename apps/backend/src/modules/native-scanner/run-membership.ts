import { createHash } from "node:crypto";

import { assertScannerSymbol } from "./binance-public-futures";
import { canonicalJson } from "./canonical-json";
import type { MembershipChange } from "./live-shadow-supervisor";
import { RUN_ID_PATTERN } from "./supervisor-run-manifest";

/**
 * A dynamic-universe run's MEMBERSHIP JOURNAL: append-only, one canonical JSON
 * record per line, hash-chained, in the run's directory beside its immutable
 * manifest. The manifest names the start-up running set; this journal names
 * every change after it (JOINED, REACTIVATED, INACTIVE, QUARANTINED), so a
 * consumer pinned to the run (the multi-symbol emitter) learns of a newly
 * onboarded symbol — with the lineage and history origin it must verify —
 * without the run ever being restarted or its manifest rewritten.
 *
 * Pure: builds and validates records and text. Observational: actionable false.
 */

export const RUN_MEMBERSHIP_SCHEMA = "teddy.native-scanner.run-membership.v1";
export const RUN_MEMBERSHIP_JOURNAL_FILE = "membership.jsonl";
const GENESIS = "0".repeat(64);
const SHA = /^[0-9a-f]{64}$/;
const KINDS: readonly string[] = ["JOINED", "REACTIVATED", "INACTIVE", "QUARANTINED"];

export interface RunMembershipRecord extends MembershipChange {
  readonly schema: typeof RUN_MEMBERSHIP_SCHEMA;
  readonly runId: string;
  /** 1, 2, 3, ... with no gap. */
  readonly seq: number;
  /** SHA-256 of the previous line's text (genesis: 64 zeros): a rewritten journal never verifies. */
  readonly previousSha256: string;
  readonly actionable: false;
}

const KEYS = ["schema", "runId", "seq", "previousSha256", "kind", "symbol", "lineageId", "bootstrapInputSha256", "symbolHistoryOrigin", "reason", "at", "actionable"].sort();

export class RunMembershipError extends Error {
  readonly code = "RUN_MEMBERSHIP_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "RunMembershipError";
  }
}

const invalid = (message: string): never => {
  throw new RunMembershipError(message);
};

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The next journal line (with its newline) after `previousLine` (null for the first record). */
export function membershipLine(runId: string, seq: number, previousLine: string | null, change: MembershipChange): string {
  const record: RunMembershipRecord = {
    schema: RUN_MEMBERSHIP_SCHEMA,
    runId,
    seq,
    previousSha256: previousLine === null ? GENESIS : sha256(previousLine),
    kind: change.kind,
    symbol: change.symbol,
    lineageId: change.lineageId,
    bootstrapInputSha256: change.bootstrapInputSha256,
    symbolHistoryOrigin: change.symbolHistoryOrigin,
    reason: change.reason,
    at: change.at,
    actionable: false,
  };
  assertRecord(record, runId, seq, record.previousSha256);
  return `${canonicalJson(record)}\n`;
}

function assertRecord(r: RunMembershipRecord, runId: string, seq: number, previousSha256: string): void {
  if (r === null || typeof r !== "object" || canonicalJson(Object.keys(r).sort()) !== canonicalJson(KEYS)) invalid("a membership record has missing or extra fields");
  if (r.schema !== RUN_MEMBERSHIP_SCHEMA) invalid("unknown membership schema");
  if ((r.actionable as unknown) !== false) invalid("a membership record is never actionable");
  if (!RUN_ID_PATTERN.test(r.runId) || r.runId !== runId) invalid(`the record belongs to run ${String(r.runId)}, not ${runId}`);
  if (r.seq !== seq) invalid(`expected record ${seq}, found ${String(r.seq)}`);
  if (r.previousSha256 !== previousSha256) invalid(`record ${seq} does not chain to the record before it`);
  if (!KINDS.includes(r.kind)) invalid(`unknown membership change ${String(r.kind)}`);
  if (assertScannerSymbol(r.symbol) !== r.symbol) invalid("the record's symbol is not canonical");
  if (r.kind === "JOINED" || r.kind === "REACTIVATED") {
    if (typeof r.lineageId !== "string" || !SHA.test(r.lineageId) || typeof r.bootstrapInputSha256 !== "string" || !SHA.test(r.bootstrapInputSha256)) {
      invalid(`a ${r.kind} record must carry the symbol's lineage`);
    }
  }
  if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) invalid("the record's time is malformed");
}

export interface ParsedMembershipJournal {
  readonly records: readonly RunMembershipRecord[];
  /** Characters of complete, verified lines. A trailing partial line (a write in progress) is not counted. */
  readonly completeChars: number;
}

/** Parses and fully verifies a journal's text (null = no journal yet). Throws on anything unverifiable. */
export function parseMembershipJournal(text: string | null, runId: string): ParsedMembershipJournal {
  if (text === null || text === "") return { records: [], completeChars: 0 };
  const end = text.lastIndexOf("\n") + 1;
  const lines = text.slice(0, end).split("\n").slice(0, -1);
  const records: RunMembershipRecord[] = [];
  let previous = GENESIS;
  for (const [i, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalid(`membership line ${i + 1} is not JSON`);
    }
    const record = parsed as RunMembershipRecord;
    assertRecord(record, runId, i + 1, previous);
    if (canonicalJson(record) !== line) invalid(`membership line ${i + 1} is not canonical`);
    records.push(record);
    previous = sha256(line);
  }
  return { records, completeChars: end };
}
