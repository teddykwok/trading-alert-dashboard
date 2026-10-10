import { createHash } from "node:crypto";

import { canonicalJson, canonicalSha256 } from "../native-scanner/canonical-json";
import { symbolPathSegment } from "../native-scanner/exchange-symbol";
import { RunMembershipError, parseMembershipJournal } from "../native-scanner/run-membership";
import { NATIVE_DELIVERY_V2_VERSION } from "../native-scanner/scanner-profile";
import { parseRunManifest } from "../native-scanner/supervisor-run-manifest";
import { EMITTER_CURSOR_SCHEMA, bindLaneSpec, bindPinnedRun, cursorMismatch, type CheckpointIdentity, type EmitterCursor, type LaneSpec } from "./multi-symbol-emitter";
import { NATIVE_DELIVERY_MARKET_TYPE, type NativeDeliveryChartInterval } from "./native-delivery-policy";
import { ShadowLogError, ShadowLogTail } from "./shadow-log-reader";

/**
 * NATIVE_EMITTER_CURSOR_REBASELINE_V1 — the pure core.
 *
 * Advances every Native emitter PRODUCTION CURSOR of one pinned, STOPPED
 * supervisor run to the exact end of the last COMPLETE record of its durable
 * shadow log: "everything durable in this run is historical for delivery;
 * start future delivery after it". DELIVERY STATE ONLY.
 *
 * What it never does: evaluate a record for delivery (no delivery selector,
 * no winner, no eligibility), create an Alert, touch a database, a queue, a
 * dashboard push, a plan, Binance, an account or execution, or change any
 * scanner file. It reads the run's binding, each lane's log and cursor, and
 * writes cursors only through an injected store, under a durable transaction:
 *
 *   PREPARED   plan.json (immutable, hashed) + before/ (exact prior cursor bytes)
 *   COMMITTING cursors are being replaced, one atomic file at a time
 *   COMMITTED  result.json written; every lane verified at its target
 *   RECOVERY_REQUIRED  something that is neither "before" nor "target" was found
 *
 * Each lane's target cursor is a pure function of the plan and the operation's
 * creation time, so after a crash every lane is provably either untouched
 * (its before bytes) or done (its target bytes); anything else refuses.
 *
 * Pure: every file, clock and lock is injected (the CLI supplies them).
 */

export const REBASELINE_OPERATION = "NATIVE_EMITTER_CURSOR_REBASELINE_V1" as const;
export const REBASELINE_PLAN_SCHEMA = "teddy.native-alerts.emitter-cursor-rebaseline-plan.v1" as const;
export const REBASELINE_TRANSACTION_SCHEMA = "teddy.native-alerts.emitter-cursor-rebaseline-transaction.v1" as const;
export const REBASELINE_RESULT_SCHEMA = "teddy.native-alerts.emitter-cursor-rebaseline-result.v1" as const;

export type RebaselineAction = "ALREADY_AT_EOF" | "WOULD_ADVANCE" | "WOULD_INITIALIZE";
export type RebaselineTransactionState = "PREPARED" | "COMMITTING" | "COMMITTED" | "RECOVERY_REQUIRED";

export type RebaselineRefusalCode =
  | "NO_MANIFEST"
  | "MANIFEST_INVALID"
  | "RUN_BINDING"
  | "RUN_STATUS_UNKNOWN"
  | "RUN_NOT_STOPPED"
  | "MEMBERSHIP_INVALID"
  | "LANES_REFUSED"
  | "OPERATION_OPEN"
  | "PLAN_CHANGED"
  | "EVIDENCE_INVALID"
  | "RECOVERY_REQUIRED";

export interface LaneProblem {
  readonly symbol: string;
  readonly code: string;
  readonly detail: string;
}

export class RebaselineRefusal extends Error {
  constructor(
    readonly code: RebaselineRefusalCode,
    message: string,
    readonly lanes: readonly LaneProblem[] = []
  ) {
    super(message);
    this.name = "RebaselineRefusal";
  }
}

const refuse = (code: RebaselineRefusalCode, message: string, lanes: readonly LaneProblem[] = []): never => {
  throw new RebaselineRefusal(code, message, lanes);
};
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const bySymbol = (a: { symbol: string }, b: { symbol: string }) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Read-only facts about the pinned run and its lanes. */
export interface RebaselineSource {
  readonly manifestText: string | null;
  /** The pinned run's own status.json. */
  readonly runStatusText: string | null;
  /** The membership journal the manifest names (null when it names none, or the file does not exist). */
  readonly membershipText: (journal: string) => string | null;
  /** A lane's shadow log, or null when absent. Throws when it cannot be read. */
  readonly readLog: (symbol: string) => string | null;
  readonly checkpointOf: (symbol: string) => CheckpointIdentity | null;
  /** The exact bytes of a lane's production cursor file, or null when none exists. */
  readonly readCursorFile: (symbol: string) => string | null;
  /** A LIVE writer holding the lane's scanner lock, or null (a lock whose owner is gone is not a writer). Throws when unknowable. */
  readonly liveWriterOf: (symbol: string) => string | null;
}

export interface RebaselineRequest {
  readonly profileId: string;
  readonly runId: string;
  readonly engineFingerprint: string;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface PlanLane {
  readonly symbol: string;
  /** The lane's path-safe file segment (an ASCII symbol is itself; anything else "u-<utf8 hex>"). */
  readonly segment: string;
  readonly lineageId: string;
  /** Exact end of the last complete record = the log's length (a partial tail is refused). */
  readonly eofChars: number;
  readonly eofSha256: string;
  readonly records: number;
  /** The production cursor as stored before the operation, with the SHA-256 of its exact file bytes; null when none existed. */
  readonly previous: { readonly cursor: EmitterCursor; readonly fileSha256: string } | null;
  readonly action: RebaselineAction;
  /** Characters of durable log the old cursor had not consumed (the whole log for a lane without a cursor). */
  readonly backlogChars: number;
}

export interface RebaselinePlanBody {
  readonly schema: typeof REBASELINE_PLAN_SCHEMA;
  readonly operation: typeof REBASELINE_OPERATION;
  readonly profileId: string;
  readonly runId: string;
  readonly engineFingerprint: string;
  readonly deliveryPolicyVersion: typeof NATIVE_DELIVERY_V2_VERSION;
  readonly marketType: typeof NATIVE_DELIVERY_MARKET_TYPE;
  readonly chartInterval: string;
  readonly runState: "STOPPED";
  readonly membership: { readonly dynamic: boolean; readonly records: number; readonly journalSha256: string | null };
  readonly lanes: readonly PlanLane[];
  readonly totals: {
    readonly lanes: number;
    readonly existingCursors: number;
    readonly missingCursors: number;
    readonly alreadyAtEof: number;
    readonly wouldAdvance: number;
    readonly wouldInitialize: number;
    readonly previousConsumedChars: number;
    readonly proposedEofChars: number;
    readonly backlogChars: number;
  };
}

export interface PreparedRebaseline {
  readonly body: RebaselinePlanBody;
  /** canonicalSha256(body): deterministic for the same durable facts. */
  readonly planSha256: string;
  /** Exact prior cursor bytes per symbol (the before/ evidence). */
  readonly beforeText: ReadonlyMap<string, string>;
}

function laneEof(spec: LaneSpec, chartInterval: NativeDeliveryChartInterval, text: string): { eofChars: number; records: number; boundaries: Set<number> } {
  const tail = new ShadowLogTail({ lineageId: spec.lineageId, marketType: NATIVE_DELIVERY_MARKET_TYPE, symbol: spec.symbol, chartInterval }, 0);
  // pendingTailPolls 0: a partial final line is TORN_LINE, never silently included or dropped.
  const entries = tail.readWithOffsets(text);
  const eofChars = entries.length === 0 ? 0 : entries[entries.length - 1].endChars;
  return { eofChars, records: entries.length, boundaries: new Set([0, ...entries.map((e) => e.endChars)]) };
}

/**
 * Every lane the normal multi-symbol emitter would bind for this run — the
 * manifest's, plus every valid later JOINED/REACTIVATED membership record —
 * through the SAME binding and journal verification. Any doubt refuses.
 */
function bindAllLanes(request: RebaselineRequest, source: RebaselineSource) {
  if (source.manifestText === null) refuse("NO_MANIFEST", `no manifest for supervisor run ${request.runId}`);
  let manifest;
  try {
    manifest = parseRunManifest(source.manifestText as string);
  } catch (error) {
    return refuse("MANIFEST_INVALID", error instanceof Error ? error.message : "unreadable manifest");
  }
  let run;
  try {
    run = bindPinnedRun({ manifest, expect: request, checkpointOf: source.checkpointOf });
  } catch (error) {
    return refuse("RUN_BINDING", `${(error as { code?: string }).code ?? "BINDING"}: ${error instanceof Error ? error.message : "binding failed"}`);
  }
  const lanes: LaneSpec[] = [...run.lanes];
  let membership = { dynamic: run.dynamicMembership === true, records: 0, journalSha256: null as string | null };
  const journal = manifest.body.membership ?? null;
  if (journal !== null) {
    const text = source.membershipText(journal.journal);
    let parsed;
    try {
      parsed = parseMembershipJournal(text, request.runId);
    } catch (error) {
      if (!(error instanceof RunMembershipError)) throw error;
      return refuse("MEMBERSHIP_INVALID", error.message);
    }
    // A stopped run's journal must end on a complete record: a partial line is an interrupted write, never "absent".
    if (text !== null && parsed.completeChars !== text.length) refuse("MEMBERSHIP_INVALID", "the membership journal ends in a partial line");
    membership = { dynamic: true, records: parsed.records.length, journalSha256: text === null ? null : sha256(text) };
    for (const record of parsed.records) {
      if (record.kind !== "JOINED" && record.kind !== "REACTIVATED") continue;
      const lineageId = record.lineageId as string;
      const known = lanes.find((l) => l.symbol === record.symbol);
      if (known !== undefined) {
        if (known.lineageId !== lineageId) lanes[lanes.indexOf(known)] = { ...known, bindingFailure: `LINEAGE_CHANGED: the run later names lineage ${lineageId} for this symbol` };
        continue;
      }
      lanes.push(
        bindLaneSpec(run.profile, run.chartInterval, { symbol: record.symbol, lineageId, bootstrapInputSha256: record.bootstrapInputSha256 as string, symbolHistoryOrigin: record.symbolHistoryOrigin }, source.checkpointOf)
      );
    }
  }
  return { run, lanes: lanes.sort(bySymbol), membership };
}

/**
 * PREFLIGHT: every lane, before anything is written. Run-level doubts refuse at
 * once; every lane-level doubt is collected and the whole operation refused.
 */
export function prepareRebaseline(request: RebaselineRequest, source: RebaselineSource): PreparedRebaseline {
  // The pinned run must be durably STOPPED: a running scanner would move EOF under us.
  if (source.runStatusText === null) refuse("RUN_STATUS_UNKNOWN", `supervisor run ${request.runId} has no status.json: its state is unknown`);
  let status: { runId?: unknown; runState?: unknown; engineFingerprint?: unknown };
  try {
    status = JSON.parse(source.runStatusText as string) as typeof status;
  } catch {
    return refuse("RUN_STATUS_UNKNOWN", `supervisor run ${request.runId}'s status.json is not JSON`);
  }
  if (status.runId !== request.runId || status.engineFingerprint !== request.engineFingerprint) {
    refuse("RUN_STATUS_UNKNOWN", `supervisor run ${request.runId}'s status.json names run ${String(status.runId)} / engine ${String(status.engineFingerprint)}`);
  }
  if (status.runState !== "STOPPED") refuse("RUN_NOT_STOPPED", `supervisor run ${request.runId} is ${String(status.runState)}, not STOPPED: its logs may still grow`);

  const { run, lanes, membership } = bindAllLanes(request, source);
  const problems: LaneProblem[] = [];
  const planLanes: PlanLane[] = [];
  const beforeText = new Map<string, string>();
  for (const spec of lanes) {
    const problem = (code: string, detail: string) => problems.push({ symbol: spec.symbol, code, detail });
    if (spec.bindingFailure !== null) {
      problem("BINDING", spec.bindingFailure);
      continue;
    }
    let writer: string | null;
    try {
      writer = source.liveWriterOf(spec.symbol);
    } catch (error) {
      problem("LOCK_UNKNOWN", error instanceof Error ? error.message : "the lane's scanner lock cannot be read");
      continue;
    }
    if (writer !== null) {
      problem("LIVE_WRITER", writer);
      continue;
    }
    let text: string | null;
    try {
      text = source.readLog(spec.symbol);
    } catch (error) {
      problem("LOG_UNREADABLE", error instanceof Error ? error.message : "unreadable");
      continue;
    }
    if (text === null) {
      problem("LOG_MISSING", "the accepted lane has no shadow log: unknown is not absent");
      continue;
    }
    let eof;
    try {
      eof = laneEof(spec, run.chartInterval, text);
    } catch (error) {
      if (!(error instanceof ShadowLogError)) throw error;
      problem(error.code, error.message);
      continue;
    }
    if (eof.eofChars !== text.length) {
      problem("TAIL_NOT_ON_RECORD_BOUNDARY", `the log is ${text.length} characters but its last complete record ends at ${eof.eofChars}`);
      continue;
    }
    const fileText = source.readCursorFile(spec.symbol);
    let previous: PlanLane["previous"] = null;
    if (fileText !== null) {
      let cursor: EmitterCursor;
      try {
        cursor = JSON.parse(fileText) as EmitterCursor;
      } catch {
        problem("CURSOR_UNREADABLE", "the production cursor is not JSON");
        continue;
      }
      const why = cursorMismatch(cursor, { profileId: run.profile.profileId, engineFingerprint: run.engineFingerprint, chartInterval: run.chartInterval, symbol: spec.symbol, lineageId: spec.lineageId });
      if (why !== null) {
        problem("CURSOR_MISMATCH", why);
        continue;
      }
      if (cursor.consumedChars > eof.eofChars) {
        problem("CURSOR_BEYOND_EOF", `the cursor consumed ${cursor.consumedChars} characters; the durable log ends at ${eof.eofChars}`);
        continue;
      }
      if (sha256(text.slice(0, cursor.consumedChars)) !== cursor.consumedSha256) {
        problem("LOG_REWRITTEN", "the log no longer matches the bytes the production cursor consumed");
        continue;
      }
      if (!eof.boundaries.has(cursor.consumedChars) || !eof.boundaries.has(cursor.activationChars)) {
        problem("CURSOR_NOT_ON_RECORD_BOUNDARY", `cursor positions ${cursor.consumedChars}/${cursor.activationChars} are not ends of complete records`);
        continue;
      }
      previous = { cursor, fileSha256: sha256(fileText) };
      beforeText.set(spec.symbol, fileText);
    }
    const action: RebaselineAction = previous === null ? "WOULD_INITIALIZE" : previous.cursor.consumedChars === eof.eofChars ? "ALREADY_AT_EOF" : "WOULD_ADVANCE";
    planLanes.push({
      symbol: spec.symbol,
      segment: symbolPathSegment(spec.symbol),
      lineageId: spec.lineageId,
      eofChars: eof.eofChars,
      eofSha256: sha256(text),
      records: eof.records,
      previous,
      action,
      backlogChars: eof.eofChars - (previous?.cursor.consumedChars ?? 0),
    });
  }
  if (problems.length > 0) refuse("LANES_REFUSED", `${problems.length} lane(s) cannot be rebaselined safely; nothing was written`, problems.sort(bySymbol));

  const count = (action: RebaselineAction) => planLanes.filter((l) => l.action === action).length;
  const body: RebaselinePlanBody = {
    schema: REBASELINE_PLAN_SCHEMA,
    operation: REBASELINE_OPERATION,
    profileId: run.profile.profileId,
    runId: run.runId,
    engineFingerprint: run.engineFingerprint,
    deliveryPolicyVersion: NATIVE_DELIVERY_V2_VERSION,
    marketType: NATIVE_DELIVERY_MARKET_TYPE,
    chartInterval: run.chartInterval,
    runState: "STOPPED",
    membership,
    lanes: planLanes,
    totals: {
      lanes: planLanes.length,
      existingCursors: planLanes.filter((l) => l.previous !== null).length,
      missingCursors: count("WOULD_INITIALIZE"),
      alreadyAtEof: count("ALREADY_AT_EOF"),
      wouldAdvance: count("WOULD_ADVANCE"),
      wouldInitialize: count("WOULD_INITIALIZE"),
      previousConsumedChars: planLanes.reduce((n, l) => n + (l.previous?.cursor.consumedChars ?? 0), 0),
      proposedEofChars: planLanes.reduce((n, l) => n + l.eofChars, 0),
      backlogChars: planLanes.reduce((n, l) => n + l.backlogChars, 0),
    },
  };
  return { body, planSha256: canonicalSha256(body), beforeText };
}

/** True when committing the plan would change nothing (every lane already at its EOF). */
export const isNoop = (body: RebaselinePlanBody) => body.lanes.every((l) => l.action === "ALREADY_AT_EOF");

/**
 * The cursor a lane will hold after the operation, or null when it does not
 * change. Deterministic: the plan plus the operation's creation time.
 *  - WOULD_ADVANCE: the stored cursor with ONLY its consumed position (and that
 *    prefix's hash) moved to EOF; activationChars / activatedAt /
 *    activatedByRunId keep their original first-activation meaning.
 *  - WOULD_INITIALIZE: a first activation AT EOF (exactly what --activate-at-eof
 *    does): consumed = activation = EOF; nothing before it is ever delivered.
 */
export function targetCursorOf(body: RebaselinePlanBody, lane: PlanLane, appliedAt: string): EmitterCursor | null {
  if (lane.action === "ALREADY_AT_EOF") return null;
  if (lane.action === "WOULD_ADVANCE") {
    const p = (lane.previous as NonNullable<PlanLane["previous"]>).cursor;
    return { ...p, consumedChars: lane.eofChars, consumedSha256: lane.eofSha256, updatedAt: appliedAt };
  }
  return {
    schema: EMITTER_CURSOR_SCHEMA,
    profileId: body.profileId,
    engineFingerprint: body.engineFingerprint,
    deliveryPolicyVersion: NATIVE_DELIVERY_V2_VERSION,
    marketType: NATIVE_DELIVERY_MARKET_TYPE,
    chartInterval: body.chartInterval,
    symbol: lane.symbol,
    lineageId: lane.lineageId,
    consumedChars: lane.eofChars,
    consumedSha256: lane.eofSha256,
    activationChars: lane.eofChars,
    activatedAt: appliedAt,
    activatedByRunId: body.runId,
    updatedAt: appliedAt,
  };
}

/** The bytes FileEmitterCursorStore.save writes for a cursor. */
export const cursorFileText = (cursor: EmitterCursor) => `${JSON.stringify(cursor)}\n`;

// ---------------------------------------------------------------------------
// The durable transaction
// ---------------------------------------------------------------------------

/** One operation's evidence directory and the production cursor files. */
export interface RebaselineStore {
  /** Operation ids already present for this cursor namespace. */
  listOperations(): string[];
  readEvidence(operationId: string, name: string): string | null;
  /** Exclusive create (never overwrites); throws if it exists. */
  writeEvidenceOnce(operationId: string, name: string, text: string): void;
  /** Durable atomic replace: the transaction state only. */
  replaceEvidence(operationId: string, name: string, text: string): void;
  readCursorFile(symbol: string): string | null;
  /** Durable atomic replace of one cursor file (FileEmitterCursorStore.save). */
  writeCursor(cursor: EmitterCursor): void;
}

export interface PlanFile {
  readonly schema: typeof REBASELINE_PLAN_SCHEMA;
  readonly operationId: string;
  readonly createdAt: string;
  readonly planSha256: string;
  readonly body: RebaselinePlanBody;
}

export interface TransactionFile {
  readonly schema: typeof REBASELINE_TRANSACTION_SCHEMA;
  readonly operationId: string;
  readonly planSha256: string;
  readonly state: RebaselineTransactionState;
  readonly updatedAt: string;
  readonly detail: string | null;
}

export interface RebaselineResult {
  readonly schema: typeof REBASELINE_RESULT_SCHEMA;
  readonly operation: typeof REBASELINE_OPERATION;
  readonly operationId: string;
  readonly planSha256: string;
  readonly profileId: string;
  readonly runId: string;
  readonly engineFingerprint: string;
  readonly state: "COMMITTED";
  readonly createdAt: string;
  readonly committedAt: string;
  readonly lanes: number;
  readonly advanced: number;
  readonly initialized: number;
  readonly alreadyAtEof: number;
  readonly cursorWrites: number;
  readonly resumedLanes: number;
  readonly laneOutcomes: readonly { readonly symbol: string; readonly outcome: "ADVANCED" | "INITIALIZED" | "ALREADY_AT_EOF"; readonly consumedChars: number }[];
  readonly alertsCreated: 0;
  readonly databaseOpened: false;
  readonly binanceCalled: false;
  readonly nativeExecution: "DISABLED_UNCHANGED";
}

export const PLAN_FILE = "plan.json";
export const TRANSACTION_FILE = "transaction.json";
export const RESULT_FILE = "result.json";
export const beforeFileOf = (segment: string) => `before/${segment}.json`;

export const operationIdOf = (createdAt: string, planSha256: string) => `${createdAt.replace(/[^0-9]/g, "").slice(0, 14)}Z-${planSha256.slice(0, 12)}`;

function readJson<T>(store: RebaselineStore, operationId: string, name: string): T | null {
  const text = store.readEvidence(operationId, name);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return refuse("EVIDENCE_INVALID", `${operationId}/${name} is not JSON`);
  }
}

/** Operations of this cursor namespace that did not reach COMMITTED. */
export function openOperations(store: RebaselineStore): { operationId: string; state: RebaselineTransactionState | "PLANNED"; planSha256: string | null }[] {
  const open = [];
  for (const operationId of store.listOperations().sort()) {
    const tx = readJson<TransactionFile>(store, operationId, TRANSACTION_FILE);
    if (tx !== null && tx.state === "COMMITTED") continue;
    const plan = readJson<PlanFile>(store, operationId, PLAN_FILE);
    open.push({ operationId, state: tx?.state ?? ("PLANNED" as const), planSha256: plan?.planSha256 ?? null });
  }
  return open;
}

export interface CommitInput {
  readonly prepared: PreparedRebaseline;
  readonly expectedPlanSha256: string;
  readonly createdAt: string;
  readonly nowIso: () => string;
  readonly store: RebaselineStore;
  /** Re-reads one lane's log at the moment its cursor is written. */
  readonly readLog: (symbol: string) => string | null;
}

export type CommitOutcome = { readonly kind: "NOOP"; readonly planSha256: string } | { readonly kind: "COMMITTED"; readonly operationId: string; readonly result: RebaselineResult };

/**
 * COMMIT exactly the preflighted plan (a fresh operation). Refuses when the
 * plan is not the one the operator reviewed, or another operation is open.
 */
export function commitRebaseline(input: CommitInput): CommitOutcome {
  const { prepared, store } = input;
  const open = openOperations(store);
  if (open.length > 0) {
    const o = open[0];
    refuse("OPERATION_OPEN", `operation ${o.operationId} is ${o.state} (plan ${o.planSha256 ?? "unknown"}); complete it with --expect-plan-sha256 ${o.planSha256 ?? "<its plan hash>"} before any new rebaseline`);
  }
  if (prepared.planSha256 !== input.expectedPlanSha256) {
    refuse("PLAN_CHANGED", `the durable facts now produce plan ${prepared.planSha256}, not the reviewed ${input.expectedPlanSha256}; run the dry run again and review it`);
  }
  if (isNoop(prepared.body)) return { kind: "NOOP", planSha256: prepared.planSha256 };

  const operationId = operationIdOf(input.createdAt, prepared.planSha256);
  const planFile: PlanFile = { schema: REBASELINE_PLAN_SCHEMA, operationId, createdAt: input.createdAt, planSha256: prepared.planSha256, body: prepared.body };
  store.writeEvidenceOnce(operationId, PLAN_FILE, `${JSON.stringify(planFile, null, 2)}\n`);
  for (const lane of prepared.body.lanes) {
    if (lane.previous !== null) store.writeEvidenceOnce(operationId, beforeFileOf(lane.segment), prepared.beforeText.get(lane.symbol) as string);
  }
  writeState(store, operationId, prepared.planSha256, "PREPARED", input.nowIso(), null);
  return { kind: "COMMITTED", operationId, result: applyPlan(store, planFile, input.readLog, input.nowIso, false) };
}

/**
 * RESUME an interrupted operation (PLANNED, PREPARED or COMMITTING) — the SAME
 * operation, by its plan hash; never a different one. RECOVERY_REQUIRED refuses.
 */
export function resumeRebaseline(input: { readonly store: RebaselineStore; readonly operationId: string; readonly expectedPlanSha256: string; readonly nowIso: () => string; readonly readLog: (symbol: string) => string | null }): RebaselineResult {
  const { store, operationId } = input;
  const plan = readJson<PlanFile>(store, operationId, PLAN_FILE);
  if (plan === null) return refuse("EVIDENCE_INVALID", `operation ${operationId} has no plan.json`);
  if (plan.planSha256 !== canonicalSha256(plan.body) || plan.operationId !== operationId) refuse("EVIDENCE_INVALID", `operation ${operationId}'s plan does not verify`);
  if (plan.planSha256 !== input.expectedPlanSha256) refuse("PLAN_CHANGED", `operation ${operationId} is plan ${plan.planSha256}, not ${input.expectedPlanSha256}`);
  const tx = readJson<TransactionFile>(store, operationId, TRANSACTION_FILE);
  if (tx?.state === "RECOVERY_REQUIRED") refuse("RECOVERY_REQUIRED", `operation ${operationId} needs investigation: ${tx.detail ?? "unknown"}`);
  if (tx?.state === "COMMITTED") refuse("EVIDENCE_INVALID", `operation ${operationId} is already COMMITTED`);
  // The before/ evidence must be complete and exact (a crash may have stopped mid-way through writing it).
  for (const lane of plan.body.lanes) {
    if (lane.previous === null) continue;
    const name = beforeFileOf(lane.segment);
    const saved = store.readEvidence(operationId, name);
    if (saved === null) {
      const current = store.readCursorFile(lane.symbol);
      if (current === null || sha256(current) !== lane.previous.fileSha256) refuse("RECOVERY_REQUIRED", `${lane.symbol}: its before-snapshot is missing and the current cursor is not the planned prior cursor`);
      store.writeEvidenceOnce(operationId, name, current as string);
    } else if (sha256(saved) !== lane.previous.fileSha256) {
      refuse("EVIDENCE_INVALID", `${lane.symbol}: its before-snapshot does not match the plan`);
    }
  }
  if (tx === null) writeState(store, operationId, plan.planSha256, "PREPARED", input.nowIso(), null);
  return applyPlan(store, plan, input.readLog, input.nowIso, true);
}

function writeState(store: RebaselineStore, operationId: string, planSha256: string, state: RebaselineTransactionState, at: string, detail: string | null): void {
  const tx: TransactionFile = { schema: REBASELINE_TRANSACTION_SCHEMA, operationId, planSha256, state, updatedAt: at, detail };
  store.replaceEvidence(operationId, TRANSACTION_FILE, `${JSON.stringify(tx, null, 2)}\n`);
}

/** COMMITTING: each lane is verified to be exactly "before" or exactly "target", its log unchanged; then written. */
function applyPlan(store: RebaselineStore, plan: PlanFile, readLog: (symbol: string) => string | null, nowIso: () => string, resuming: boolean): RebaselineResult {
  const { operationId, planSha256, body } = plan;
  const recovery = (detail: string): never => {
    writeState(store, operationId, planSha256, "RECOVERY_REQUIRED", nowIso(), detail);
    return refuse("RECOVERY_REQUIRED", `operation ${operationId}: ${detail}`);
  };
  writeState(store, operationId, planSha256, "COMMITTING", nowIso(), null);
  let cursorWrites = 0;
  let resumedLanes = 0;
  for (const lane of body.lanes) {
    const target = targetCursorOf(body, lane, plan.createdAt);
    const current = store.readCursorFile(lane.symbol);
    const beforeSha = lane.previous?.fileSha256 ?? null;
    if (target === null) {
      // ALREADY_AT_EOF: must still be exactly the prior cursor.
      if (current === null || sha256(current) !== beforeSha) recovery(`${lane.symbol}: its cursor changed although the plan leaves it unchanged`);
      continue;
    }
    const targetText = cursorFileText(target);
    if (current === targetText) {
      resumedLanes += 1;
      continue;
    }
    const untouched = beforeSha === null ? current === null : current !== null && sha256(current) === beforeSha;
    if (!untouched) recovery(`${lane.symbol}: its cursor is neither the planned prior cursor nor the planned target (a foreign change)`);
    let text: string | null;
    try {
      text = readLog(lane.symbol);
    } catch {
      text = null;
    }
    if (text === null || text.length !== lane.eofChars || sha256(text) !== lane.eofSha256) recovery(`${lane.symbol}: its durable log changed after the plan was made`);
    store.writeCursor(target);
    cursorWrites += 1;
  }
  // Every lane verified at its final state before COMMITTED is claimed.
  const laneOutcomes = body.lanes.map((lane) => {
    const target = targetCursorOf(body, lane, plan.createdAt);
    const current = store.readCursorFile(lane.symbol);
    if (target === null ? current === null || sha256(current) !== lane.previous?.fileSha256 : current !== cursorFileText(target)) recovery(`${lane.symbol}: not at its planned final state after the commit`);
    return { symbol: lane.symbol, outcome: lane.action === "WOULD_ADVANCE" ? ("ADVANCED" as const) : lane.action === "WOULD_INITIALIZE" ? ("INITIALIZED" as const) : ("ALREADY_AT_EOF" as const), consumedChars: lane.eofChars };
  });
  const result: RebaselineResult = {
    schema: REBASELINE_RESULT_SCHEMA,
    operation: REBASELINE_OPERATION,
    operationId,
    planSha256,
    profileId: body.profileId,
    runId: body.runId,
    engineFingerprint: body.engineFingerprint,
    state: "COMMITTED",
    createdAt: plan.createdAt,
    committedAt: nowIso(),
    lanes: body.lanes.length,
    advanced: laneOutcomes.filter((l) => l.outcome === "ADVANCED").length,
    initialized: laneOutcomes.filter((l) => l.outcome === "INITIALIZED").length,
    alreadyAtEof: laneOutcomes.filter((l) => l.outcome === "ALREADY_AT_EOF").length,
    cursorWrites,
    resumedLanes: resuming ? resumedLanes : 0,
    laneOutcomes,
    alertsCreated: 0,
    databaseOpened: false,
    binanceCalled: false,
    nativeExecution: "DISABLED_UNCHANGED",
  };
  if (store.readEvidence(operationId, RESULT_FILE) === null) store.writeEvidenceOnce(operationId, RESULT_FILE, `${canonicalJson(result)}\n`);
  writeState(store, operationId, planSha256, "COMMITTED", nowIso(), null);
  return result;
}
