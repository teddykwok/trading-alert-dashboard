import type { NativeAlertDelivery, Prisma, PrismaClient } from "@prisma/client";
import {
  reconstructImmediateCandidates,
  snapshotNativeEngineForNextBar,
  stepNativeEngine,
  SWITCHOVER_TRUNCATED_CLOSED_BARS,
  type NativeEngineState,
  type NativeKline,
  type NativeLevelDiagnostic,
} from "@trading-alert-dashboard/shared";

import { intervalMsOf } from "../native-scanner/binance-public-futures";
import { canonicalJson } from "../native-scanner/canonical-json";
import { readinessOf, type TriggerReadiness } from "../native-scanner/candidate-ranker";
import type { LineageConfig } from "../native-scanner/live-shadow-cli-args";
import { prepareLiveShadowState } from "../native-scanner/live-shadow-session";
import { observationEventId, type LiveImmediateObservation, type ShadowRecord } from "../native-scanner/live-shadow-store";
import { buildNativeAlertDraft } from "../native-alerts/native-alert-draft";
import { NativeDeliveryConflictError, assertSameProvenance } from "../native-alerts/native-alert-ledger";
import { NativeDeliverySelector, nativeDeliveryKey, type NativeDeliveryDecision } from "../native-alerts/native-delivery-policy";
import { ShadowLogError, parseShadowEventLog, type ShadowLogIdentity } from "../native-alerts/shadow-log-reader";

/**
 * READ-ONLY FORENSIC AUDIT of one delivered NATIVE alert.
 *
 * Every database read runs inside a Postgres READ ONLY transaction, so a write
 * — even an accidental one — is refused by the database itself. The audit
 * re-derives everything it can from durable evidence with the production
 * functions (strict shadow-log parser, delivery selector, delivery key,
 * provenance hash, Alert mapping, the live scanner's own state reconstruction)
 * and compares; anything it cannot establish is a FAIL, never a guess.
 */

export type Verdict = "PASS" | "FAIL";

export interface AuditSection {
  readonly verdict: Verdict;
  readonly findings: readonly string[];
}

export interface ArtifactCount {
  readonly table: string;
  readonly via: string;
  readonly count: number;
  readonly class: "EXPECTED_LEDGER" | "USER_ANNOTATION" | "EXECUTION_RELEVANT";
}

export interface DbSafety {
  readonly verdict: Verdict;
  readonly planCount: number | null;
  readonly tradeExecutionCount: number | null;
  readonly executionArtifactCount: number | null;
  readonly artifacts: readonly ArtifactCount[];
  readonly findings: readonly string[];
}

export interface LevelTimelineRow {
  readonly barOpenTime: string;
  readonly scannerBar: string;
  readonly level: string;
  readonly present: boolean;
  readonly armed: boolean | null;
  readonly armedReady: boolean | null;
  readonly oldEnough: boolean | null;
  readonly cooledDown: boolean | null;
  readonly approachSide: boolean | null;
  readonly readiness: TriggerReadiness | "ABSENT";
  readonly inBand: boolean | null;
  readonly immediateCandidate: boolean;
  readonly committedCandidate: boolean;
  readonly lastTouchBarIndex: number | null;
}

export interface NativeAlertAuditReport {
  readonly alertId: string;
  readonly alertMapping: AuditSection;
  readonly ledger: AuditSection;
  readonly shadowEvent: AuditSection;
  readonly provenance: AuditSection;
  readonly engineReadiness: AuditSection;
  readonly dbSafety: DbSafety;
  readonly proofLimits: { readonly proven: readonly string[]; readonly notProven: readonly string[] };
  readonly overall: Verdict;
}

// ---------------------------------------------------------------------------
// Read-only database access
// ---------------------------------------------------------------------------

type ReadOnlyTx = Prisma.TransactionClient;

/** Runs `fn` in a transaction the database itself refuses to write in. */
export async function withReadOnlyTransaction<T>(prisma: PrismaClient, fn: (tx: ReadOnlyTx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return fn(tx);
  });
}

const IDENT = /^[A-Za-z0-9_]+$/;
/** Tables allowed to reference a native alert without implying any execution. */
const USER_ANNOTATION_TABLES = new Set(["TradeReview", "TradeJournal"]);
const LEDGER_TABLE = "NativeAlertDelivery";

/**
 * Every row anywhere in the schema attributable to `alertId`, found from the
 * catalogue rather than from what the code is believed to do:
 *  - every table with an `alertId` column;
 *  - every table with a `tradeExecutionId` column, through TradeExecution rows of this alert;
 *  - every table with an `extremeRRPlanId` column, through ExtremeRRPlan rows of this alert.
 */
export async function auditDbSafety(tx: ReadOnlyTx, alertId: string): Promise<DbSafety> {
  const findings: string[] = [];
  const artifacts: ArtifactCount[] = [];
  const columns = await tx.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_name IN ('alertId', 'tradeExecutionId', 'extremeRRPlanId')
      ORDER BY table_name, column_name`
  );
  if (!columns.some((c) => c.table_name === "TradeExecution" && c.column_name === "alertId")) {
    return { verdict: "FAIL", planCount: null, tradeExecutionCount: null, executionArtifactCount: null, artifacts, findings: ["schema has no TradeExecution.alertId column: the audit cannot reason about execution reachability"] };
  }
  const count = async (sql: string): Promise<number> => {
    const rows = await tx.$queryRawUnsafe<Array<{ n: number }>>(sql, alertId);
    const n = rows[0]?.n;
    if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new Error("count query returned no integer");
    return n;
  };
  for (const { table_name: table, column_name: column } of columns) {
    if (!IDENT.test(table) || !IDENT.test(column)) {
      findings.push(`unexpected identifier ${JSON.stringify(table)}.${JSON.stringify(column)}`);
      return { verdict: "FAIL", planCount: null, tradeExecutionCount: null, executionArtifactCount: null, artifacts, findings };
    }
    let sql: string;
    let via: string;
    if (column === "alertId") {
      sql = `SELECT count(*)::int AS n FROM "${table}" WHERE "alertId" = $1`;
      via = "alertId";
    } else if (column === "tradeExecutionId") {
      sql = `SELECT count(*)::int AS n FROM "${table}" WHERE "tradeExecutionId" IN (SELECT id FROM "TradeExecution" WHERE "alertId" = $1)`;
      via = "TradeExecution.alertId";
    } else {
      sql = `SELECT count(*)::int AS n FROM "${table}" WHERE "extremeRRPlanId" IN (SELECT id FROM "ExtremeRRPlan" WHERE "alertId" = $1)`;
      via = "ExtremeRRPlan.alertId";
    }
    const n = await count(sql);
    const cls: ArtifactCount["class"] =
      table === LEDGER_TABLE && column === "alertId" ? "EXPECTED_LEDGER" : USER_ANNOTATION_TABLES.has(table) && column === "alertId" ? "USER_ANNOTATION" : "EXECUTION_RELEVANT";
    artifacts.push({ table, via, count: n, class: cls });
  }
  const planCount = artifacts.filter((a) => a.table === "ExtremeRRPlan" && a.via === "alertId").reduce((s, a) => s + a.count, 0);
  const tradeExecutionCount = artifacts.filter((a) => a.table === "TradeExecution" && a.via === "alertId").reduce((s, a) => s + a.count, 0);
  const executionArtifactCount = artifacts
    .filter((a) => a.class === "EXECUTION_RELEVANT" && !(a.table === "ExtremeRRPlan" && a.via === "alertId") && !(a.table === "TradeExecution" && a.via === "alertId"))
    .reduce((s, a) => s + a.count, 0);
  const ledgerRows = artifacts.filter((a) => a.class === "EXPECTED_LEDGER").reduce((s, a) => s + a.count, 0);
  if (planCount !== 0) findings.push(`${planCount} ExtremeRRPlan row(s) reference this NATIVE alert`);
  if (tradeExecutionCount !== 0) findings.push(`${tradeExecutionCount} TradeExecution row(s) reference this NATIVE alert`);
  if (executionArtifactCount !== 0) findings.push(`${executionArtifactCount} other execution-relevant row(s) are attributable to this NATIVE alert`);
  if (ledgerRows !== 1) findings.push(`expected exactly 1 ledger row for this alert, found ${ledgerRows}`);
  return {
    verdict: findings.length === 0 ? "PASS" : "FAIL",
    planCount,
    tradeExecutionCount,
    executionArtifactCount,
    artifacts,
    findings,
  };
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

export interface AuditInputs {
  readonly alertId: string;
  /** The lineage configuration the scanner ran with (rebuilt lineage must hash to the ledger's). */
  readonly lineage: LineageConfig;
  /** The scanner's events.jsonl, whole, or null when absent. */
  readonly readShadowLog: (identity: ShadowLogIdentity) => string | null;
  /** The scanner checkpoint's lineageId, or null when absent. */
  readonly readCheckpointLineage: (identity: ShadowLogIdentity) => string | null;
  /** Local closed klines for the symbol (public cache), or null when absent. */
  readonly loadKlines: (symbol: string) => readonly NativeKline[] | null;
}

const pass = (findings: string[]): AuditSection => ({ verdict: findings.length === 0 ? "PASS" : "FAIL", findings });

export async function auditNativeAlert(prisma: PrismaClient, inputs: AuditInputs): Promise<NativeAlertAuditReport> {
  const db = await withReadOnlyTransaction(prisma, async (tx) => {
    const alert = await tx.alert.findUnique({ where: { id: inputs.alertId } });
    const byAlert = await tx.nativeAlertDelivery.findMany({ where: { alertId: inputs.alertId } });
    const sameKey = byAlert.length === 1 ? await tx.nativeAlertDelivery.count({ where: { deliveryKey: byAlert[0].deliveryKey } }) : null;
    const safety = await auditDbSafety(tx, inputs.alertId);
    return { alert, byAlert, sameKey, safety };
  });

  const mapping: string[] = [];
  const ledgerFindings: string[] = [];
  const shadow: string[] = [];
  const provenance: string[] = [];
  const readiness: string[] = [];
  const proven: string[] = [];
  const notProven: string[] = [];

  const finish = (): NativeAlertAuditReport => {
    const sections = { alertMapping: pass(mapping), ledger: pass(ledgerFindings), shadowEvent: pass(shadow), provenance: pass(provenance), engineReadiness: pass(readiness) };
    const overall: Verdict = Object.values(sections).every((s) => s.verdict === "PASS") && db.safety.verdict === "PASS" ? "PASS" : "FAIL";
    return { alertId: inputs.alertId, ...sections, dbSafety: db.safety, proofLimits: { proven, notProven }, overall };
  };

  // ---- 1. the alert ------------------------------------------------------
  const alert = db.alert;
  if (alert === null) {
    mapping.push("alert not found");
    ledgerFindings.push("no alert to audit");
    shadow.push("no alert to audit");
    provenance.push("no alert to audit");
    readiness.push("no alert to audit");
    return finish();
  }
  if (alert.source !== "NATIVE") mapping.push(`alert source is ${alert.source}, not NATIVE`);

  // ---- 2. the ledger -------------------------------------------------------
  if (db.byAlert.length !== 1) {
    ledgerFindings.push(`expected exactly one NativeAlertDelivery for this alert, found ${db.byAlert.length}`);
    shadow.push("no unique ledger row to follow");
    provenance.push("no unique ledger row to follow");
    readiness.push("no unique ledger row to follow");
    return finish();
  }
  const ledger: NativeAlertDelivery = db.byAlert[0];
  if (db.sameKey !== 1) ledgerFindings.push(`deliveryKey ${ledger.deliveryKey} has ${db.sameKey} ledger rows (must be exactly 1)`);
  if (ledger.policyVersion !== "NATIVE_DELIVERY_V1") {
    // This audit re-derives NATIVE_DELIVERY_V1 decisions from the legacy shadow tree. A row of any
    // other policy version is reported as not auditable here, never judged by V1's rules.
    const why = `policy version ${ledger.policyVersion} is not auditable by the NATIVE_DELIVERY_V1 audit`;
    ledgerFindings.push(why);
    shadow.push(why);
    provenance.push(why);
    readiness.push(why);
    return finish();
  }
  const identity: ShadowLogIdentity = {
    lineageId: ledger.lineageId,
    marketType: ledger.marketType as ShadowLogIdentity["marketType"],
    symbol: ledger.symbol,
    chartInterval: ledger.chartInterval as ShadowLogIdentity["chartInterval"],
  };
  if (ledger.symbol !== alert.symbol) ledgerFindings.push(`ledger symbol ${ledger.symbol} != alert symbol ${alert.symbol}`);
  if (ledger.chartInterval !== alert.timeframe) ledgerFindings.push(`ledger interval ${ledger.chartInterval} != alert timeframe ${alert.timeframe}`);

  // ---- 3. the durable shadow log, from byte 0 -----------------------------
  const checkpointLineage = inputs.readCheckpointLineage(identity);
  if (checkpointLineage === null) shadow.push("no scanner checkpoint found for this symbol/interval");
  else if (checkpointLineage !== ledger.lineageId) shadow.push(`scanner checkpoint lineage ${checkpointLineage} != ledger lineage ${ledger.lineageId}`);
  const text = inputs.readShadowLog(identity);
  let records: ShadowRecord[] = [];
  if (text === null) shadow.push("no shadow event log found for this symbol/interval");
  else {
    try {
      records = parseShadowEventLog(text, identity);
    } catch (error) {
      if (!(error instanceof ShadowLogError)) throw error;
      shadow.push(`the shadow log is refused by the strict parser: ${error.code} ${error.message}`);
    }
  }
  const winner = records.find((r): r is LiveImmediateObservation => r.eventId === ledger.winningShadowEventId && r.kind === "LIVE_IMMEDIATE_OBSERVATION");
  if (records.length > 0 && winner === undefined) shadow.push(`winning shadow event ${ledger.winningShadowEventId} is not a live observation in the log`);

  let decision: NativeDeliveryDecision | null = null;
  if (winner !== undefined) {
    // The selector over the WHOLE log must choose exactly this event for this key.
    const selector = new NativeDeliverySelector();
    for (const record of records) {
      const s = selector.consider(record);
      if (s.kind === "DELIVER" && s.decision.deliveryKey === ledger.deliveryKey) decision = s.decision;
    }
    if (decision === null) shadow.push("NATIVE_DELIVERY_V1 over the whole log selects nothing for this delivery key");
    else if (decision.winner.eventId !== winner.eventId) shadow.push(`NATIVE_DELIVERY_V1 selects ${decision.winner.eventId}, not the ledger's winner`);
  }

  // ---- 4/5. provenance, recomputed --------------------------------------------
  if (winner !== undefined && decision !== null) {
    const recomputedId = observationEventId({
      lineageId: winner.lineageId,
      symbol: winner.symbol,
      barOpenTimeMs: winner.barOpenTimeMs,
      signal: winner.signal,
      sourceTf: winner.sourceTf,
      levelKey: winner.levelKey,
    });
    if (recomputedId !== winner.eventId) provenance.push("the winning event's id does not recompute");
    const key = nativeDeliveryKey(winner);
    if (key !== ledger.deliveryKey) provenance.push(`delivery key recomputes to ${key}, ledger has ${ledger.deliveryKey}`);
    try {
      assertSameProvenance(ledger, decision);
    } catch (error) {
      if (!(error instanceof NativeDeliveryConflictError)) throw error;
      provenance.push(error.message);
    }
    if (ledger.barOpenTime.getTime() !== winner.barOpenTimeMs) provenance.push("ledger bar time != winning event bar time");

    // ---- 6. the Alert row is exactly the canonical mapping ---------------------
    const draft = buildNativeAlertDraft(decision);
    const fields: Array<[string, unknown, unknown]> = [
      ["symbol", alert.symbol, draft.symbol],
      ["assetType", alert.assetType, draft.assetType],
      ["exchange", alert.exchange, draft.exchange],
      ["timeframe", alert.timeframe, draft.timeframe],
      ["price (level)", alert.price, draft.price],
      ["signal", alert.signal, draft.signal],
      ["indicatorName", alert.indicatorName, draft.indicatorName],
      ["eventType", alert.eventType, draft.eventType],
      ["levelColor", alert.levelColor, draft.levelColor],
      ["sourceTimeframe", alert.sourceTimeframe, draft.sourceTimeframe],
      ["touchDirection", alert.touchDirection, draft.touchDirection],
      ["triggeredAt", alert.triggeredAt.getTime(), draft.triggeredAt.getTime()],
      ["source", alert.source, draft.source],
    ];
    for (const [field, stored, expected] of fields) if (stored !== expected) mapping.push(`${field}: stored ${String(stored)}, canonical ${String(expected)}`);
    if (canonicalJson(alert.rawPayload) !== canonicalJson(draft.rawPayload)) mapping.push("rawPayload differs from the canonical payload (barTime, policy, lineage, shadow event, provenance)");
    if (alert.triggeredAt.getTime() !== winner.exchangeEventTimeMs) mapping.push("triggeredAt is not the exchange event time of the first observation");
  } else if (winner !== undefined) {
    provenance.push("no delivery decision to compare against");
    mapping.push("no delivery decision to map");
  } else {
    provenance.push("no winning observation to recompute from");
    mapping.push("no winning observation to map");
  }

  // ---- 7/8/9. engine readiness from the live scanner's own reconstruction ----
  if (winner !== undefined) {
    const klines = inputs.loadKlines(winner.symbol);
    if (klines === null) readiness.push("no local kline cache for this symbol: committed state cannot be rebuilt");
    else {
      try {
        const plan = prepareLiveShadowState(
          klines,
          {
            symbol: winner.symbol,
            marketType: identity.marketType,
            chartInterval: identity.chartInterval,
            historyStartMs: inputs.lineage.historyStartMs,
            switchoverMs: inputs.lineage.switchoverMs,
            engine: inputs.lineage.engine,
            partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
            expectedLineageId: null,
          },
          winner.barOpenTimeMs,
          null
        );
        if (plan.lineageId !== ledger.lineageId) {
          readiness.push(`the rebuilt lineage ${plan.lineageId} != ledger lineage ${ledger.lineageId}: wrong config or changed bytes`);
        } else {
          explainReadiness(plan.state, winner, readiness, proven, notProven);
        }
      } catch (error) {
        readiness.push(`state reconstruction refused: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown"}`);
      }
    }
    const commit = records.find((r) => r.kind === "BAR_CLOSE_COMMIT" && r.barOpenTimeMs === winner.barOpenTimeMs);
    if (commit?.kind === "BAR_CLOSE_COMMIT") {
      const committed = commit.committedCandidates.some((c) => c.levelKey === winner.levelKey && c.signal === winner.signal);
      proven.push(`bar close commit ${commit.classification}: the level ${committed ? "ALSO committed at the bar close" : "did NOT commit at the bar close"}`);
    } else notProven.push("no bar close commit for the winning bar is in the log yet");
  }
  notProven.push(
    "that TradingView sent, or would have sent, an alert for this bar (no TradingView evidence is consulted)",
    "the individual trade that printed the band-entry price: only the stream's running OHLC at the observed update is persisted",
    "anything about execution: this alert is dashboard-only and execution for NATIVE alerts is refused in code"
  );
  return finish();
}

function explainReadiness(preBar: NativeEngineState, winner: LiveImmediateObservation, findings: string[], proven: string[], notProven: string[]): void {
  const snapshot = snapshotNativeEngineForNextBar(preBar);
  const level = snapshot.levels.find((l) => l.id === winner.level.id);
  if (level === undefined) {
    findings.push(`level id ${winner.level.id} is not in the committed pre-bar state`);
    return;
  }
  const key = `${level.sourceTf}:${level.condition}:${level.createdBarOpenTimeMs}`;
  if (key !== winner.levelKey || level.price !== winner.levelPrice || level.color !== winner.levelColor) {
    findings.push(`the pre-bar level ${key} @ ${level.price} does not match the observation ${winner.levelKey} @ ${winner.levelPrice}`);
    return;
  }
  const { readiness, blockedBy } = readinessOf(snapshot, level);
  if (readiness !== "TRIGGER_READY") findings.push(`the level was ${readiness} for the bar (${blockedBy.join(", ")})`);
  else proven.push(describeLevel(level, snapshot.nextBarIndex, snapshot.previousClose));

  const o = winner.ohlcSoFar;
  const inBand = o.low <= level.upperBand && o.high >= level.lowerBand;
  if (!inBand) findings.push(`the persisted OHLC so far (low ${o.low}, high ${o.high}) is not inside [${level.lowerBand}, ${level.upperBand}]`);
  else proven.push(`band entry: persisted OHLC-so-far low ${o.low} / high ${o.high} at update ${winner.updateSequence} (exchange time ${new Date(winner.exchangeEventTimeMs).toISOString()}) is inside [${level.lowerBand}, ${level.upperBand}]`);

  // The engine itself, fed only persisted values, must reproduce the observation.
  const barSoFar: NativeKline = { openTimeMs: winner.barOpenTimeMs, closeTimeMs: winner.barOpenTimeMs + (preBar.intervalMs ?? 0) - 1, ...o };
  const reproduced = reconstructImmediateCandidates(preBar, barSoFar).find((c) => c.level.id === level.id);
  if (reproduced === undefined) findings.push("reconstructImmediateCandidates over the persisted pre-bar state and OHLC so far does NOT produce this level");
  else if (canonicalJson(reproduced.proof) !== canonicalJson(winner.evidence.proof)) findings.push("the reproduced candidate's proof flags differ from the persisted evidence");
  else proven.push(`reconstructImmediateCandidates reproduces the observation (${winner.evidence.evidenceClass}) from the persisted pre-bar state and OHLC so far`);
  if (winner.evidence.evidenceClass !== "PROVEN_INTRABAR_POSSIBLE") notProven.push("the evidence class is POSSIBLE_ONLY: closed-OHLC proof of an earlier band entry or level presence is missing");
}

function describeLevel(level: NativeLevelDiagnostic, nextBar: number, previousClose: number | null): string {
  return (
    `${level.sourceTf} ${level.color} ${level.price} (id ${level.id}) TRIGGER_READY for bar index ${nextBar}: ` +
    `armed at ${level.armedBarIndex} (age ${nextBar - level.armedBarIndex}), created at ${level.createdBarIndex} (age ${nextBar - level.createdBarIndex}), ` +
    `last touch ${level.lastTouchBarIndex < 0 ? "never" : `${level.lastTouchBarIndex} (${nextBar - level.lastTouchBarIndex} bars ago)`}, ` +
    `close[1] ${previousClose} ${level.color === "GREEN" ? ">" : "<"} ${level.color === "GREEN" ? `upper ${level.upperBand}` : `lower ${level.lowerBand}`} — ` +
    `band [${level.lowerBand}, ${level.upperBand}], expected ${level.retestSignal} ${level.retestSignal === "LONG" ? "FROM_ABOVE" : "FROM_BELOW"}`
  );
}

// ---------------------------------------------------------------------------
// Bar-by-bar level timeline (canonical engine only)
// ---------------------------------------------------------------------------

export interface LevelSelector {
  readonly sourceTf: string;
  readonly color: "GREEN" | "RED";
  readonly price: number;
}

/**
 * For each bar in [fromMs, toMs], the committed pre-bar gates of every level
 * matching `selectors`, whether the bar's range entered its band, and whether
 * the canonical engine produced an Immediate and/or committed candidate. The
 * shadow log says what the live scanner was doing on that bar.
 */
export function levelTimeline(
  klines: readonly NativeKline[],
  lineage: LineageConfig,
  symbol: string,
  fromMs: number,
  toMs: number,
  selectors: readonly LevelSelector[],
  records: readonly ShadowRecord[]
): { readonly lineageId: string; readonly rows: readonly LevelTimelineRow[] } {
  const intervalMs = intervalMsOf(lineage.chartInterval);
  if (!(toMs >= fromMs)) throw new Error("the timeline must end at or after its start");
  const plan = prepareLiveShadowState(
    klines,
    { symbol, marketType: "USDM_PERPETUAL", chartInterval: lineage.chartInterval, historyStartMs: lineage.historyStartMs, switchoverMs: lineage.switchoverMs, engine: lineage.engine, partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS, expectedLineageId: null },
    fromMs,
    null
  );
  const scannerBar = (ms: number): string => {
    const commit = records.find((r) => r.kind === "BAR_CLOSE_COMMIT" && r.barOpenTimeMs === ms);
    if (commit !== undefined) return commit.classification;
    const firstLogged = records.find((r) => r.kind === "BAR_CLOSE_COMMIT");
    if (firstLogged !== undefined && ms < firstLogged.barOpenTimeMs) return "BEFORE_SCANNER_READINESS (committed at start-up replay; never live, never logged)";
    return "NOT_LOGGED";
  };
  let state = plan.state;
  const rows: LevelTimelineRow[] = [];
  for (let t = fromMs; t <= toMs; t += intervalMs) {
    const bar = klines.find((k) => k.openTimeMs === t);
    if (bar === undefined) throw new Error(`no cached bar at ${new Date(t).toISOString()}`);
    const snap = snapshotNativeEngineForNextBar(state);
    const immediate = reconstructImmediateCandidates(state, bar);
    const step = stepNativeEngine(state, bar);
    for (const selector of selectors) {
      // Oldest matching level: the one Pine's retest loop reaches first.
      const level = snap.levels.find((l) => l.sourceTf === selector.sourceTf && l.color === selector.color && l.price === selector.price);
      const name = `${selector.sourceTf} ${selector.color} ${selector.price}`;
      if (level === undefined) {
        rows.push({ barOpenTime: new Date(t).toISOString(), scannerBar: scannerBar(t), level: name, present: false, armed: null, armedReady: null, oldEnough: null, cooledDown: null, approachSide: null, readiness: "ABSENT", inBand: null, immediateCandidate: false, committedCandidate: false, lastTouchBarIndex: null });
        continue;
      }
      rows.push({
        barOpenTime: new Date(t).toISOString(),
        scannerBar: scannerBar(t),
        level: name,
        present: true,
        armed: level.armed,
        armedReady: level.gates.armedReady,
        oldEnough: level.gates.oldEnough,
        cooledDown: level.gates.cooledDown,
        approachSide: level.gates.approachSide,
        readiness: readinessOf(snap, level).readiness,
        inBand: bar.low <= level.upperBand && bar.high >= level.lowerBand,
        immediateCandidate: immediate.some((c) => c.level.id === level.id),
        committedCandidate: step.candidates.some((c) => c.level.id === level.id),
        lastTouchBarIndex: level.lastTouchBarIndex < 0 ? null : level.lastTouchBarIndex,
      });
    }
    state = step.state;
  }
  return { lineageId: plan.lineageId, rows };
}
