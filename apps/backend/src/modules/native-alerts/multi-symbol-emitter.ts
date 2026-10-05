import { createHash } from "node:crypto";

import type { ShadowRecord } from "../native-scanner/live-shadow-store";
import { RunMembershipError, parseMembershipJournal } from "../native-scanner/run-membership";
import type { SymbolHistoryOrigin } from "../native-scanner/scanner-lineage";
import {
  NATIVE_DELIVERY_V2_VERSION,
  ScannerProfileError,
  engineFingerprintOf,
  profileById,
  profileLineageIdFor,
  profileSummaryOf,
  type ProfileSummary,
  type ScannerProfile,
} from "../native-scanner/scanner-profile";
import type { SupervisorRunManifest } from "../native-scanner/supervisor-run-manifest";
import type { NativeDeliveryLedgerV2 } from "./native-alert-ledger";
import { NATIVE_DELIVERY_CHART_INTERVALS, NATIVE_DELIVERY_MARKET_TYPE, type NativeDeliveryChartInterval } from "./native-delivery-policy";
import { NativeDeliverySelectorV2, type NativeDeliveryContextV2, type NativeDeliveryDecisionV2, type NativeSkipReasonV2 } from "./native-delivery-policy-v2";
import { ShadowLogError, ShadowLogTail, type ShadowLogErrorCode } from "./shadow-log-reader";

/**
 * MULTI-SYMBOL NATIVE EMITTER — the fan-in core. Dashboard delivery only.
 *
 * It consumes exactly the symbols ACCEPTED by one pinned supervisor run (by
 * runId, profileId and engine fingerprint — never a directory glob), reads each
 * symbol's durable shadow log through the strict validator, applies the
 * profile's NATIVE_DELIVERY_V2 policy, and in COMMIT mode alone writes through
 * the idempotent delivery ledger.
 *
 *  - One LANE per symbol: its own validator, selector and cursor. Corrupt or
 *    mismatched evidence fails that lane alone; the others continue.
 *  - A BOUNDED queue, drained round-robin across lanes (fair; each lane's own
 *    order is its log order). Overflow is never a silent drop: it fails closed.
 *  - CURSORS (COMMIT only) advance only after a record is fully processed, and
 *    after a delivery only once the ledger transaction has committed. A crash
 *    between commit and cursor write replays harmlessly (the ledger is
 *    idempotent); a failed commit never moves the cursor past its event.
 *  - DRY_RUN writes nothing at all: no cursor, no ledger, no database. It may
 *    read the production cursors to show what COMMIT would do, never write them.
 *  - FIRST ACTIVATION never floods history: a lane without a production cursor
 *    is refused unless the operator explicitly activates it AT CURRENT EOF;
 *    everything before that point is historical and never delivered.
 *  - DYNAMIC UNIVERSE (manifest v2): a symbol the running supervisor onboards
 *    later is announced in the run's membership journal. The emitter binds it
 *    with exactly the manifest's checks (lineage rebuilt from the profile and
 *    the symbol's history origin, checkpoint identity) and activates it AT ITS
 *    CURRENT EOF the first time it binds it — the live frontier: the symbol's
 *    bootstrap replay never wrote a deliverable record, and nothing written
 *    before the binding is delivered. A corrupt journal stops new bindings only.
 *
 * Pure: every file, clock and database access is injected. It holds no
 * credential, selects no account and has no path to plans or execution.
 */

export type MultiEmitterMode = "DRY_RUN" | "COMMIT_DASHBOARD_ALERTS";

export const EMITTER_CURSOR_SCHEMA = "teddy.native-alerts.emitter-cursor.v1";
export const MULTI_EMITTER_STATUS_SCHEMA = "teddy.native-alerts.multi-symbol-emitter-status.v1";
export const MULTI_EMITTER_QUEUE_LIMITS = Object.freeze({ min: 10, max: 100_000 });

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const SHA = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Binding to one pinned supervisor run
// ---------------------------------------------------------------------------

export type RunBindingErrorCode = "RUN_ID_MISMATCH" | "NOT_A_PROFILE_RUN" | "PROFILE_MISMATCH" | "ENGINE_FINGERPRINT_MISMATCH" | "INTERVAL_UNSUPPORTED" | "NO_SYMBOLS";

export class RunBindingError extends Error {
  constructor(
    readonly code: RunBindingErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RunBindingError";
  }
}

export interface CheckpointIdentity {
  readonly lineageId: string;
  readonly symbol: string;
  readonly chartInterval: string;
  readonly marketType: string;
}

export interface LaneSpec {
  readonly symbol: string;
  readonly lineageId: string;
  /** Set when the symbol's binding already fails (lineage or checkpoint mismatch): the lane starts FAILED. */
  readonly bindingFailure: string | null;
}

export interface PinnedRun {
  readonly profile: ScannerProfile;
  readonly summary: ProfileSummary;
  readonly runId: string;
  readonly engineFingerprint: string;
  readonly chartInterval: NativeDeliveryChartInterval;
  readonly lanes: readonly LaneSpec[];
  /** Manifest v2: later joins are read from the run's membership journal. */
  readonly dynamicMembership?: boolean;
}

/** One symbol entry to bind: from the manifest, or from a JOINED membership record. */
export interface LaneEntry {
  readonly symbol: string;
  readonly lineageId: string;
  readonly bootstrapInputSha256: string;
  readonly symbolHistoryOrigin?: SymbolHistoryOrigin | null;
}

/**
 * Per-symbol binding: the profile's engine must rebuild exactly this lineage
 * (with the symbol's history origin, when the engine has one) and the
 * symbol's checkpoint must name it. A failure fails that lane only.
 */
export function bindLaneSpec(
  profile: ScannerProfile,
  chartInterval: string,
  entry: LaneEntry,
  checkpointOf: (symbol: string) => CheckpointIdentity | null
): LaneSpec {
  let bindingFailure: string | null = null;
  let rebuilt: string;
  try {
    rebuilt = profileLineageIdFor(profile, entry.symbol, entry.bootstrapInputSha256, entry.symbolHistoryOrigin ?? null);
  } catch (error) {
    if (!(error instanceof ScannerProfileError)) throw error;
    return { symbol: entry.symbol, lineageId: entry.lineageId, bindingFailure: `LINEAGE_MISMATCH: ${error.message}` };
  }
  if (rebuilt !== entry.lineageId) bindingFailure = `LINEAGE_MISMATCH: ${profile.profileId}'s engine rebuilds lineage ${rebuilt}, the run says ${entry.lineageId}`;
  else {
    const checkpoint = checkpointOf(entry.symbol);
    if (checkpoint === null) bindingFailure = "CHECKPOINT_MISSING: the symbol has no live-shadow checkpoint in the profile's engine namespace";
    else if (
      checkpoint.lineageId !== entry.lineageId ||
      checkpoint.symbol !== entry.symbol ||
      checkpoint.chartInterval !== chartInterval ||
      checkpoint.marketType !== NATIVE_DELIVERY_MARKET_TYPE
    ) {
      bindingFailure = `CHECKPOINT_MISMATCH: the checkpoint names lineage ${checkpoint.lineageId} (${checkpoint.symbol} ${checkpoint.chartInterval} ${checkpoint.marketType})`;
    }
  }
  return { symbol: entry.symbol, lineageId: entry.lineageId, bindingFailure };
}

/**
 * Binds to exactly one run. Run-level mismatches (run id, profile, engine
 * fingerprint, interval) refuse the whole binding. Per-symbol mismatches (a
 * lineage the profile's engine does not rebuild, a missing or different
 * checkpoint) fail only that symbol's lane.
 */
export function bindPinnedRun(input: {
  readonly manifest: SupervisorRunManifest;
  readonly expect: { readonly profileId: string; readonly runId: string; readonly engineFingerprint: string };
  readonly checkpointOf: (symbol: string) => CheckpointIdentity | null;
}): PinnedRun {
  const body = input.manifest.body;
  if (body.runId !== input.expect.runId) throw new RunBindingError("RUN_ID_MISMATCH", `the manifest is run ${body.runId}, not the pinned ${input.expect.runId}`);
  if (body.profile === null) throw new RunBindingError("NOT_A_PROFILE_RUN", `run ${body.runId} is a legacy explicit-flag run; the multi-symbol emitter consumes profile runs only`);
  if (body.profile.profileId !== input.expect.profileId) {
    throw new RunBindingError("PROFILE_MISMATCH", `run ${body.runId} executed profile ${body.profile.profileId}, not the pinned ${input.expect.profileId}`);
  }
  const profile = profileById(input.expect.profileId);
  const codeFingerprint = engineFingerprintOf(profile);
  for (const [what, value] of [
    ["the pinned", input.expect.engineFingerprint],
    ["the run manifest's", body.engineFingerprint],
    ["the run's profile", body.profile.engineFingerprint],
  ] as const) {
    if (value !== codeFingerprint) {
      throw new RunBindingError("ENGINE_FINGERPRINT_MISMATCH", `${what} engine fingerprint ${value} is not ${profile.profileId}'s engine ${codeFingerprint}`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(NATIVE_DELIVERY_CHART_INTERVALS, body.chartInterval)) {
    throw new RunBindingError("INTERVAL_UNSUPPORTED", `chart interval ${body.chartInterval} is not deliverable`);
  }
  if (body.symbols.length === 0) throw new RunBindingError("NO_SYMBOLS", `run ${body.runId} accepted no symbols`);
  const lanes: LaneSpec[] = body.symbols.map((s) => bindLaneSpec(profile, body.chartInterval, s, input.checkpointOf));
  return {
    profile,
    summary: profileSummaryOf(profile),
    runId: body.runId,
    engineFingerprint: codeFingerprint,
    chartInterval: body.chartInterval as NativeDeliveryChartInterval,
    lanes,
    dynamicMembership: body.membership !== undefined && body.membership !== null,
  };
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

/** A lane's PRODUCTION position. Everything at or before `consumedChars` is processed; nothing after it is. */
export interface EmitterCursor {
  readonly schema: typeof EMITTER_CURSOR_SCHEMA;
  readonly profileId: string;
  readonly engineFingerprint: string;
  readonly deliveryPolicyVersion: typeof NATIVE_DELIVERY_V2_VERSION;
  readonly marketType: typeof NATIVE_DELIVERY_MARKET_TYPE;
  readonly chartInterval: string;
  readonly symbol: string;
  readonly lineageId: string;
  readonly consumedChars: number;
  /** SHA-256 of the log's first consumedChars characters: a rewritten log can never be resumed. */
  readonly consumedSha256: string;
  /** Where first activation put the lane: records ending at or before here are historical and never delivered. */
  readonly activationChars: number;
  readonly activatedAt: string;
  readonly activatedByRunId: string;
  readonly updatedAt: string;
}

export interface EmitterCursorReader {
  load(symbol: string): EmitterCursor | null;
}

export interface EmitterCursorWriter {
  /** Durable (atomic replace). Called only in COMMIT mode. */
  save(cursor: EmitterCursor): void;
}

const CURSOR_KEYS = [
  "schema",
  "profileId",
  "engineFingerprint",
  "deliveryPolicyVersion",
  "marketType",
  "chartInterval",
  "symbol",
  "lineageId",
  "consumedChars",
  "consumedSha256",
  "activationChars",
  "activatedAt",
  "activatedByRunId",
  "updatedAt",
].sort();

/** Why a stored cursor cannot be used for this lane, or null when it can. */
export function cursorMismatch(cursor: EmitterCursor, expected: { profileId: string; engineFingerprint: string; chartInterval: string; symbol: string; lineageId: string }): string | null {
  if (cursor === null || typeof cursor !== "object" || JSON.stringify(Object.keys(cursor).sort()) !== JSON.stringify(CURSOR_KEYS)) return "the cursor has missing or extra fields";
  if (cursor.schema !== EMITTER_CURSOR_SCHEMA) return "unknown cursor schema";
  if (cursor.deliveryPolicyVersion !== NATIVE_DELIVERY_V2_VERSION) return `cursor is for ${String(cursor.deliveryPolicyVersion)}, not ${NATIVE_DELIVERY_V2_VERSION}`;
  if (cursor.marketType !== NATIVE_DELIVERY_MARKET_TYPE) return "cursor is for another market";
  for (const field of ["profileId", "engineFingerprint", "chartInterval", "symbol", "lineageId"] as const) {
    if (cursor[field] !== expected[field]) return `cursor ${field} is ${String(cursor[field])}, not ${expected[field]}`;
  }
  if (!Number.isSafeInteger(cursor.consumedChars) || !Number.isSafeInteger(cursor.activationChars) || cursor.activationChars < 0 || cursor.consumedChars < cursor.activationChars) {
    return "cursor positions are invalid";
  }
  if (!SHA.test(cursor.consumedSha256)) return "cursor hash is malformed";
  return null;
}

// ---------------------------------------------------------------------------
// The emitter
// ---------------------------------------------------------------------------

export class QueueOverflowError extends Error {
  readonly code = "EMITTER_QUEUE_OVERFLOW";

  constructor(message: string) {
    super(message);
    this.name = "QueueOverflowError";
  }
}

export class NotActivatedError extends Error {
  readonly code = "NOT_ACTIVATED";

  constructor(message: string) {
    super(message);
    this.name = "NotActivatedError";
  }
}

export type MultiEmitterEvent =
  | { readonly type: "LANE_FAILED"; readonly symbol: string; readonly code: string; readonly message: string }
  | { readonly type: "LANE_JOINED"; readonly symbol: string; readonly seq: number; readonly lineageId: string }
  | { readonly type: "MEMBERSHIP_INVALID"; readonly message: string }
  | { readonly type: "LANE_ACTIVATED"; readonly symbol: string; readonly activationChars: number; readonly historicalRecords: number }
  | { readonly type: "SKIPPED"; readonly symbol: string; readonly eventId: string; readonly reason: NativeSkipReasonV2; readonly sourceTf: string | null }
  | {
      readonly type: "DECISION";
      readonly symbol: string;
      readonly mode: MultiEmitterMode;
      /** COMMIT: what the ledger did. DRY_RUN: always WOULD_CREATE (the database is never consulted). */
      readonly result: "CREATED" | "ALREADY_DELIVERED" | "ALREADY_DELIVERED_ALERT_REMOVED" | "ALREADY_DELIVERED_UNDER_OTHER_POLICY" | "WOULD_CREATE";
      readonly alertId: string | null;
      readonly decision: NativeDeliveryDecisionV2;
    };

export interface MultiEmitterDeps {
  readonly mode: MultiEmitterMode;
  readonly run: PinnedRun;
  readonly readLog: (symbol: string) => string | null;
  readonly cursors: EmitterCursorReader;
  /** COMMIT only. DRY_RUN must pass null: it can never write a cursor. */
  readonly cursorWriter: EmitterCursorWriter | null;
  /** COMMIT only. DRY_RUN must pass null: it never touches the database. */
  readonly ledger: NativeDeliveryLedgerV2 | null;
  /**
   * PRODUCTION_CURSOR: resume from each lane's production cursor (COMMIT), or
   * show what COMMIT would do from it (DRY_RUN; a lane without one is treated
   * as if activated at current EOF, in memory only).
   * DRY_RUN_FROM_START: diagnostic evaluation of the whole log (DRY_RUN only).
   */
  readonly baseline: "PRODUCTION_CURSOR" | "DRY_RUN_FROM_START";
  /** COMMIT only: activate lanes that have no production cursor AT CURRENT EOF. Never replays history. */
  readonly activateAtEof: boolean;
  readonly queueCapacity: number;
  /** How many consecutive polls a partial final line may stay partial before it is a torn log. */
  readonly pendingTailPolls: number;
  readonly nowIso: () => string;
  readonly report: (event: MultiEmitterEvent) => void;
  /** Dynamic-universe runs: the run's membership journal text (null when none exists yet). */
  readonly readMembership?: () => string | null;
  /** Dynamic-universe runs: a joined symbol's checkpoint identity (the same rule as the manifest's lanes). */
  readonly checkpointOf?: (symbol: string) => CheckpointIdentity | null;
}

type FailureClass = "LINEAGE_OR_PROFILE_MISMATCH" | "MALFORMED";

interface Lane {
  readonly symbol: string;
  readonly lineageId: string;
  readonly tail: ShadowLogTail;
  readonly selector: NativeDeliverySelectorV2;
  state: "HEALTHY" | "FAILED";
  failure: string | null;
  failureClass: FailureClass | null;
  /** The latest full log text read. */
  text: string;
  /** Every record ending at or before this has been processed. */
  processedChars: number;
  /** The production cursor position persisted (COMMIT) or loaded (DRY_RUN); null when none. */
  savedChars: number | null;
  /** Records ending at or before this are never delivered: historical (activation) or already processed (restart). */
  baselineChars: number;
  activationChars: number;
  activatedAt: string | null;
  activatedByRunId: string | null;
  /** True once the baseline is established and the first read verified. Only such a lane ever persists a cursor. */
  baselined: boolean;
  /** The lane's items awaiting processing, in log order. */
  readonly pending: { readonly record: ShadowRecord; readonly endChars: number }[];
}

const MISMATCH_CODES: readonly ShadowLogErrorCode[] = ["LINEAGE_MISMATCH", "MARKET_MISMATCH", "SYMBOL_MISMATCH", "INTERVAL_MISMATCH"];

function emptyTally() {
  return {
    eventsRead: 0,
    eventsEligible: 0,
    eventsSkipped: 0,
    wouldCreate: 0,
    created: 0,
    ledgerDuplicates: 0,
    historicalBeforeActivation: 0,
    alreadyProcessedBeforeRestart: 0,
    skipReasons: {} as Partial<Record<NativeSkipReasonV2, number>>,
    eligibleBySourceTf: {} as Record<string, number>,
    skippedBySourceTf: {} as Record<string, Partial<Record<NativeSkipReasonV2, number>>>,
    cursorWrites: 0,
  };
}

export class MultiSymbolNativeEmitter {
  private readonly lanes: Lane[];
  private readonly context: NativeDeliveryContextV2;
  /** The last membership record absorbed, and why absorbing stopped (a journal that does not verify). */
  private membershipSeq = 0;
  private membershipFailure: string | null = null;
  private queueDepth = 0;
  private maxQueueDepth = 0;
  private rotation = 0;
  private initialized = false;
  private stoppedWithPending = 0;
  readonly tally = emptyTally();

  constructor(private readonly deps: MultiEmitterDeps) {
    const commit = deps.mode === "COMMIT_DASHBOARD_ALERTS";
    if (!commit && (deps.cursorWriter !== null || deps.ledger !== null)) throw new Error("DRY_RUN never writes a cursor and never touches the database");
    if (commit && (deps.cursorWriter === null || deps.ledger === null)) throw new Error("COMMIT requires the production cursor store and the delivery ledger");
    if (!commit && deps.activateAtEof) throw new Error("activation is a COMMIT action; DRY_RUN never activates");
    if (commit && deps.baseline !== "PRODUCTION_CURSOR") throw new Error("COMMIT always resumes from production cursors; historical replay is not a COMMIT mode");
    if (!Number.isSafeInteger(deps.queueCapacity) || deps.queueCapacity < MULTI_EMITTER_QUEUE_LIMITS.min || deps.queueCapacity > MULTI_EMITTER_QUEUE_LIMITS.max) {
      throw new Error(`queue capacity must be ${MULTI_EMITTER_QUEUE_LIMITS.min}..${MULTI_EMITTER_QUEUE_LIMITS.max}`);
    }
    this.context = { profile: deps.run.summary, runId: deps.run.runId };
    this.lanes = [...deps.run.lanes].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)).map((spec) => this.makeLane(spec));
    for (const spec of deps.run.lanes) {
      if (spec.bindingFailure !== null) this.failLane(this.lane(spec.symbol), "BINDING", spec.bindingFailure, "LINEAGE_OR_PROFILE_MISMATCH");
    }
  }

  private makeLane(spec: LaneSpec): Lane {
    return {
      symbol: spec.symbol,
      lineageId: spec.lineageId,
      tail: new ShadowLogTail({ lineageId: spec.lineageId, marketType: NATIVE_DELIVERY_MARKET_TYPE, symbol: spec.symbol, chartInterval: this.deps.run.chartInterval }, this.deps.pendingTailPolls),
      selector: new NativeDeliverySelectorV2(this.deps.run.profile.delivery),
      state: "HEALTHY",
      failure: null,
      failureClass: null,
      text: "",
      processedChars: 0,
      savedChars: null,
      baselineChars: 0,
      activationChars: 0,
      activatedAt: null,
      activatedByRunId: null,
      baselined: false,
      pending: [],
    };
  }

  private lane(symbol: string): Lane {
    return this.lanes.find((l) => l.symbol === symbol) as Lane;
  }

  private failLane(lane: Lane, code: string, message: string, failureClass: FailureClass): void {
    if (lane.state === "FAILED") return;
    lane.state = "FAILED";
    lane.failure = `${code}: ${message}`;
    lane.failureClass = failureClass;
    this.deps.report({ type: "LANE_FAILED", symbol: lane.symbol, code, message });
  }

  private refuseLaneRead(lane: Lane, error: unknown): void {
    if (!(error instanceof ShadowLogError)) throw error;
    this.failLane(lane, error.code, error.message, MISMATCH_CODES.includes(error.code) ? "LINEAGE_OR_PROFILE_MISMATCH" : "MALFORMED");
  }

  private expectedCursorIdentity(lane: Lane) {
    return { profileId: this.deps.run.profile.profileId, engineFingerprint: this.deps.run.engineFingerprint, chartInterval: this.deps.run.chartInterval, symbol: lane.symbol, lineageId: lane.lineageId };
  }

  private cursorFor(lane: Lane, consumedChars: number): EmitterCursor {
    return {
      schema: EMITTER_CURSOR_SCHEMA,
      profileId: this.deps.run.profile.profileId,
      engineFingerprint: this.deps.run.engineFingerprint,
      deliveryPolicyVersion: NATIVE_DELIVERY_V2_VERSION,
      marketType: NATIVE_DELIVERY_MARKET_TYPE,
      chartInterval: this.deps.run.chartInterval,
      symbol: lane.symbol,
      lineageId: lane.lineageId,
      consumedChars,
      consumedSha256: sha256(lane.text.slice(0, consumedChars)),
      activationChars: lane.activationChars,
      activatedAt: lane.activatedAt as string,
      activatedByRunId: lane.activatedByRunId as string,
      updatedAt: this.deps.nowIso(),
    };
  }

  /** COMMIT only: persist a lane's processed position. Never ahead of what was processed. */
  private persist(lane: Lane): void {
    if (this.deps.cursorWriter === null || !lane.baselined) return;
    if (lane.savedChars !== null && lane.processedChars <= lane.savedChars) return;
    this.deps.cursorWriter.save(this.cursorFor(lane, lane.processedChars));
    lane.savedChars = lane.processedChars;
    this.tally.cursorWrites += 1;
  }

  /**
   * Loads or establishes every lane's baseline, then reads each log once:
   * records up to the baseline only rebuild slot state; later ones are queued.
   * Refuses the whole start, before writing anything, if COMMIT finds a lane
   * that was never activated and activation was not requested.
   */
  async initialize(): Promise<void> {
    if (this.initialized) throw new Error("already initialized");
    this.initialized = true;
    const commit = this.deps.mode === "COMMIT_DASHBOARD_ALERTS";

    // Pass 1: decide every baseline; refuse before any write.
    const plans: { lane: Lane; cursor: EmitterCursor | null; text: string }[] = [];
    for (const lane of this.lanes) {
      if (lane.state === "FAILED") continue;
      const cursor = this.deps.cursors.load(lane.symbol);
      if (cursor !== null) {
        const why = cursorMismatch(cursor, this.expectedCursorIdentity(lane));
        if (why !== null) {
          this.failLane(lane, "CURSOR_MISMATCH", why, "LINEAGE_OR_PROFILE_MISMATCH");
          continue;
        }
      }
      if (commit && cursor === null && !this.deps.activateAtEof) {
        throw new NotActivatedError(
          `${lane.symbol} has no production cursor. Persistent delivery must be activated explicitly (--activate-at-eof), which starts AT CURRENT EOF and never replays history.`
        );
      }
      plans.push({ lane, cursor, text: this.deps.readLog(lane.symbol) ?? "" });
    }

    // Pass 2: baselines (and, for COMMIT, durable first activation at EOF).
    for (const { lane, cursor, text } of plans) this.baselineLane(lane, cursor, text);
    // Symbols the run onboarded after its manifest (a restart picks up every earlier join).
    this.absorbMembership();
  }

  /** Establishes one lane's baseline from its production cursor, or activates it at its current EOF. */
  private baselineLane(lane: Lane, cursor: EmitterCursor | null, text: string): void {
    const commit = this.deps.mode === "COMMIT_DASHBOARD_ALERTS";
    lane.text = text;
    const eof = text.lastIndexOf("\n") + 1;
    if (this.deps.baseline === "DRY_RUN_FROM_START") {
      lane.baselineChars = 0;
      lane.activationChars = 0;
    } else if (cursor !== null) {
      if (text.length < cursor.consumedChars || sha256(text.slice(0, cursor.consumedChars)) !== cursor.consumedSha256) {
        this.failLane(lane, "LOG_REWRITTEN", "the log no longer matches the bytes the production cursor consumed", "MALFORMED");
        return;
      }
      lane.baselineChars = cursor.consumedChars;
      lane.activationChars = cursor.activationChars;
      lane.activatedAt = cursor.activatedAt;
      lane.activatedByRunId = cursor.activatedByRunId;
      lane.savedChars = cursor.consumedChars;
    } else {
      // First activation (COMMIT, durable) or its in-memory preview (DRY_RUN): at current EOF.
      lane.baselineChars = eof;
      lane.activationChars = eof;
      lane.activatedAt = this.deps.nowIso();
      lane.activatedByRunId = this.deps.run.runId;
    }

    let entries: { record: ShadowRecord; endChars: number }[];
    try {
      entries = lane.tail.readWithOffsets(text);
    } catch (error) {
      this.refuseLaneRead(lane, error);
      return;
    }
    if (lane.baselineChars > 0 && !entries.some((e) => e.endChars === lane.baselineChars)) {
      this.failLane(lane, "CURSOR_NOT_ON_RECORD_BOUNDARY", `position ${lane.baselineChars} is not the end of a complete record`, "MALFORMED");
      return;
    }
    lane.processedChars = lane.baselineChars;
    let historical = 0;
    for (const entry of entries) {
      if (entry.endChars > lane.baselineChars) {
        this.admit(lane, [entry]);
        continue;
      }
      // Before the baseline: rebuild slot state only. Nothing here is ever delivered.
      this.tally.eventsRead += 1;
      lane.selector.consider(entry.record);
      if (entry.endChars <= lane.activationChars) {
        this.tally.historicalBeforeActivation += 1;
        historical += 1;
      } else this.tally.alreadyProcessedBeforeRestart += 1;
    }
    lane.baselined = true;
    if (commit && cursor === null) {
      this.deps.report({ type: "LANE_ACTIVATED", symbol: lane.symbol, activationChars: lane.activationChars, historicalRecords: historical });
      this.persist(lane);
    }
  }

  /**
   * Binds every symbol the run's membership journal announced since the last
   * call (JOINED / REACTIVATED). A new lane is verified exactly like a manifest
   * lane and activated at its current EOF; a known symbol must keep its lineage.
   */
  private absorbMembership(): void {
    if (this.deps.run.dynamicMembership !== true || this.deps.readMembership === undefined || this.membershipFailure !== null) return;
    let records;
    try {
      records = parseMembershipJournal(this.deps.readMembership(), this.deps.run.runId).records;
    } catch (error) {
      if (!(error instanceof RunMembershipError)) throw error;
      // Fail closed for new bindings only; every lane already bound keeps running.
      this.membershipFailure = error.message;
      this.deps.report({ type: "MEMBERSHIP_INVALID", message: error.message });
      return;
    }
    for (const record of records) {
      if (record.seq <= this.membershipSeq) continue;
      this.membershipSeq = record.seq;
      if (record.kind !== "JOINED" && record.kind !== "REACTIVATED") continue;
      const lineageId = record.lineageId as string;
      const known = this.lanes.find((l) => l.symbol === record.symbol);
      if (known !== undefined) {
        if (known.lineageId !== lineageId) this.failLane(known, "LINEAGE_CHANGED", `the run now names lineage ${lineageId} for this symbol`, "LINEAGE_OR_PROFILE_MISMATCH");
        continue;
      }
      const spec = bindLaneSpec(
        this.deps.run.profile,
        this.deps.run.chartInterval,
        { symbol: record.symbol, lineageId, bootstrapInputSha256: record.bootstrapInputSha256 as string, symbolHistoryOrigin: record.symbolHistoryOrigin },
        this.deps.checkpointOf ?? (() => null)
      );
      const lane = this.makeLane(spec);
      this.lanes.push(lane);
      this.lanes.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
      this.deps.report({ type: "LANE_JOINED", symbol: lane.symbol, seq: record.seq, lineageId });
      if (spec.bindingFailure !== null) {
        this.failLane(lane, "BINDING", spec.bindingFailure, "LINEAGE_OR_PROFILE_MISMATCH");
        continue;
      }
      const cursor = this.deps.cursors.load(lane.symbol);
      if (cursor !== null) {
        const why = cursorMismatch(cursor, this.expectedCursorIdentity(lane));
        if (why !== null) {
          this.failLane(lane, "CURSOR_MISMATCH", why, "LINEAGE_OR_PROFILE_MISMATCH");
          continue;
        }
      }
      this.baselineLane(lane, cursor, this.deps.readLog(lane.symbol) ?? "");
    }
  }

  /** Adds a lane's new records to the bounded queue, or fails closed. */
  private admit(lane: Lane, entries: readonly { record: ShadowRecord; endChars: number }[]): void {
    if (this.queueDepth + entries.length > this.deps.queueCapacity) {
      throw new QueueOverflowError(
        `${lane.symbol} would put ${this.queueDepth + entries.length} records in a queue bounded at ${this.deps.queueCapacity}; stopping with every cursor at its last processed record`
      );
    }
    for (const entry of entries) lane.pending.push(entry);
    this.queueDepth += entries.length;
    this.maxQueueDepth = Math.max(this.maxQueueDepth, this.queueDepth);
  }

  /** One cycle: read every healthy lane (sorted order), then drain fairly. */
  async poll(shouldStop: () => boolean = () => false): Promise<void> {
    if (!this.initialized) throw new Error("initialize first");
    this.absorbMembership();
    for (const lane of this.lanes) {
      if (lane.state === "FAILED") continue;
      const text = this.deps.readLog(lane.symbol);
      let entries: { record: ShadowRecord; endChars: number }[];
      try {
        entries = lane.tail.readWithOffsets(text);
      } catch (error) {
        this.refuseLaneRead(lane, error);
        continue;
      }
      if (text !== null) lane.text = text;
      this.admit(lane, entries);
    }
    await this.drain(shouldStop);
  }

  /** Round-robin across lanes with pending work, one record per turn; each lane in its log order. */
  async drain(shouldStop: () => boolean = () => false): Promise<void> {
    while (this.queueDepth > 0) {
      if (shouldStop()) break;
      const active = this.lanes.filter((l) => l.pending.length > 0);
      const lane = active[this.rotation % active.length];
      this.rotation += 1;
      const item = lane.pending[0];
      await this.process(lane, item.record, item.endChars);
      lane.pending.shift();
      this.queueDepth -= 1;
    }
    for (const lane of this.lanes) this.persist(lane);
  }

  /** Graceful stop: everything processed is persisted; queued, unprocessed records are dropped and re-read next start. */
  stop(): void {
    for (const lane of this.lanes) this.persist(lane);
    this.stoppedWithPending = this.queueDepth;
    for (const lane of this.lanes) lane.pending.length = 0;
    this.queueDepth = 0;
  }

  private async process(lane: Lane, record: ShadowRecord, endChars: number): Promise<void> {
    this.tally.eventsRead += 1;
    const selection = lane.selector.consider(record);
    if (selection.kind === "SKIP") {
      this.tally.eventsSkipped += 1;
      this.tally.skipReasons[selection.reason] = (this.tally.skipReasons[selection.reason] ?? 0) + 1;
      if (selection.sourceTf !== null) {
        const byTf = (this.tally.skippedBySourceTf[selection.sourceTf] ??= {});
        byTf[selection.reason] = (byTf[selection.reason] ?? 0) + 1;
      }
      this.deps.report({ type: "SKIPPED", symbol: lane.symbol, eventId: selection.eventId, reason: selection.reason, sourceTf: selection.sourceTf });
      lane.processedChars = endChars;
      return;
    }
    const decision = selection.decision;
    this.tally.eventsEligible += 1;
    this.tally.eligibleBySourceTf[decision.winner.sourceTf] = (this.tally.eligibleBySourceTf[decision.winner.sourceTf] ?? 0) + 1;
    if (this.deps.mode === "DRY_RUN" || this.deps.ledger === null) {
      this.tally.wouldCreate += 1;
      this.deps.report({ type: "DECISION", symbol: lane.symbol, mode: this.deps.mode, result: "WOULD_CREATE", alertId: null, decision });
      lane.processedChars = endChars;
      return;
    }
    // COMMIT: the ledger transaction first; the cursor moves only after it committed.
    const result = await this.deps.ledger.deliverV2(decision, this.context);
    if (result.outcome === "CREATED") this.tally.created += 1;
    else this.tally.ledgerDuplicates += 1;
    this.deps.report({ type: "DECISION", symbol: lane.symbol, mode: this.deps.mode, result: result.outcome, alertId: result.alertId, decision });
    lane.processedChars = endChars;
    this.persist(lane);
  }

  status() {
    const s = this.deps.run.summary;
    const t = this.tally;
    const reasons = t.skipReasons;
    const n = (r: NativeSkipReasonV2) => reasons[r] ?? 0;
    return {
      schema: MULTI_EMITTER_STATUS_SCHEMA,
      notice: ["DASHBOARD DELIVERY ONLY", "NATIVE EXECUTION IS HARD-DISABLED", "NOT A TRADINGVIEW ALERT"],
      actionable: false as const,
      mode: this.deps.mode,
      profileId: s.profileId,
      profileLabel: s.profileLabel,
      runId: this.deps.run.runId,
      engineFingerprint: this.deps.run.engineFingerprint,
      deliveryPolicyFingerprint: s.deliveryPolicyFingerprint,
      executionPolicyFingerprint: s.executionPolicyFingerprint,
      deliveryPolicyVersion: s.delivery.policyVersion,
      dashboardSourceTimeframes: s.delivery.dashboardSourceTimeframes,
      futureExecutionPolicy: { sourceTimeframes: s.execution.futureExecutionSourceTimeframes, nativeExecutionEnabled: false, notice: s.execution.notice },
      membership: { dynamic: this.deps.run.dynamicMembership === true, recordsAbsorbed: this.membershipSeq, failure: this.membershipFailure },
      symbolsTracked: this.lanes.length,
      symbolsHealthy: this.lanes.filter((l) => l.state === "HEALTHY").length,
      symbolsFailed: this.lanes.filter((l) => l.state === "FAILED").length,
      eventsRead: t.eventsRead,
      eventsEligible: t.eventsEligible,
      eventsSkipped: t.eventsSkipped,
      skipCounts: {
        deliveryTfNotAllowed: n("SOURCE_TF_NOT_DELIVERED"),
        evidenceNotAllowed: n("NOT_SHADOW_LIVE_ONLY") + n("ACTIONABLE_RECORD") + n("NOT_IMMEDIATE_INTRABAR") + n("EVIDENCE_CLASS_NOT_ALLOWED") + n("UNSUPPORTED_MARKET_OR_INTERVAL"),
        replayOrNonActionable: n("REPLAY_OR_QUARANTINE_NON_ACTIONABLE"),
        barCloseCommit: n("BAR_CLOSE_COMMIT_NEVER_DELIVERED"),
        duplicateSlotOrKey: n("SUPERSEDED_SAME_SLOT") + n("DUPLICATE_EVENT"),
        lineageOrProfileMismatch: this.lanes.filter((l) => l.failureClass === "LINEAGE_OR_PROFILE_MISMATCH").length,
        malformed: this.lanes.filter((l) => l.failureClass === "MALFORMED").length,
        historicalBeforeActivationCutover: t.historicalBeforeActivation,
        alreadyProcessedBeforeRestart: t.alreadyProcessedBeforeRestart,
      },
      skipReasons: { ...reasons },
      eligibleBySourceTf: { ...t.eligibleBySourceTf },
      skippedBySourceTf: JSON.parse(JSON.stringify(t.skippedBySourceTf)) as Record<string, Partial<Record<NativeSkipReasonV2, number>>>,
      wouldCreate: t.wouldCreate,
      created: t.created,
      ledgerDuplicates: t.ledgerDuplicates,
      queueDepth: this.queueDepth,
      maxQueueDepth: this.maxQueueDepth,
      queueCapacity: this.deps.queueCapacity,
      stoppedWithPending: this.stoppedWithPending,
      cursors: {
        kind:
          this.deps.mode === "COMMIT_DASHBOARD_ALERTS"
            ? ("PRODUCTION" as const)
            : this.deps.baseline === "DRY_RUN_FROM_START"
              ? ("STATELESS_FROM_START" as const)
              : ("PRODUCTION_READ_ONLY" as const),
        writes: t.cursorWrites,
        lanes: this.lanes.map((l) => ({
          symbol: l.symbol,
          state: l.state,
          failure: l.failure,
          lineageId: l.lineageId,
          baselineChars: l.baselineChars,
          activationChars: l.activationChars,
          processedChars: l.processedChars,
          productionCursorChars: l.savedChars,
          pending: l.pending.length,
        })),
      },
    };
  }
}

export type MultiEmitterStatus = ReturnType<MultiSymbolNativeEmitter["status"]>;

export interface MultiEmitterLoop {
  readonly follow: boolean;
  readonly pollMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly shouldStop: () => boolean;
  /** Called after every cycle (status file, run-state check). Returning "END" ends the loop. */
  readonly afterCycle?: () => "CONTINUE" | "END";
}

/** Initialize, catch up once, then (follow) poll until stopped. Always ends through `stop()`. */
export async function runMultiSymbolEmitter(emitter: MultiSymbolNativeEmitter, loop: MultiEmitterLoop): Promise<void> {
  try {
    await emitter.initialize();
    await emitter.drain(loop.shouldStop);
    if (loop.afterCycle?.() === "END" || !loop.follow) return;
    while (!loop.shouldStop()) {
      await loop.sleep(loop.pollMs);
      if (loop.shouldStop()) break;
      await emitter.poll(loop.shouldStop);
      if (loop.afterCycle?.() === "END") break;
    }
  } finally {
    emitter.stop();
  }
}
