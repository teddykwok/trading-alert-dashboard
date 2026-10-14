import {
  buildLeverageAnalysis,
  calculateExtremeMoney,
  parseNativeAccountPlanPolicy,
  type ExtremeRRCandidate,
  type ExtremeRRLookback,
  type ExtremeRRTemplateSnapshot,
  type NativeExecutionIntegrityDto,
  type NativeExecutionIntegrityStatus,
  type SourceTimeframe,
} from "@trading-alert-dashboard/shared";

import { buildNativeAlertDraftV2 } from "../../src/modules/native-alerts/native-alert-draft";
import { selectNativeDeliveriesV2 } from "../../src/modules/native-alerts/native-delivery-policy-v2";
import { parseShadowEventLog } from "../../src/modules/native-alerts/shadow-log-reader";
import type { NativeAccountGates, NativeCanaryAlert, NativeCanaryInput, NativeCanaryPlan } from "../../src/modules/native-canary/native-account-a-canary";
import type { NativeScannerEvidence, NativeScannerEvidenceReader } from "../../src/modules/native-integrity/native-execution-integrity";
import { canonicalSha256 } from "../../src/modules/native-scanner/canonical-json";
import { LIVE_CHECKPOINT_SCHEMA, type LiveCheckpointBody, type LiveCheckpointFile } from "../../src/modules/native-scanner/live-shadow-checkpoint";
import type { ShadowClassification, ShadowRecord } from "../../src/modules/native-scanner/live-shadow-store";
import { TEDDY_7_ALL_ACTIVE_V1, engineFingerprintOf, profileSummaryOf } from "../../src/modules/native-scanner/scanner-profile";
import { makeRunId } from "../../src/modules/native-scanner/supervisor-run-manifest";
import { M15, bar, commit as fixtureCommit, logOf, observation } from "./native-alert-fixtures";

/**
 * Native Account A canary fixtures. Synthetic, deterministic, and built with
 * the REAL scanner -> delivery -> alert-draft pipeline, so an alert's payload
 * is byte-for-byte what the native emitter would write. Nothing here reads a
 * real scanner directory, a database or the network.
 */

export const CANARY_PROFILE = TEDDY_7_ALL_ACTIVE_V1;
export const CANARY_FINGERPRINT = engineFingerprintOf(CANARY_PROFILE);
export const CANARY_LINEAGE = "c".repeat(64);
export const CANARY_SYMBOL = "CANARYAUSDT";
const RUN_ID = makeRunId(Date.UTC(2026, 9, 5, 7, 40), "1a2b3c4d");
const SWITCHOVER = bar(-100);
const STATE = "a".repeat(64);
const CAUSAL = "b".repeat(64);
/** The source bar every fixture alert is observed on. */
export const SOURCE_BAR = bar(1);
/** That operational 15m bar's close. */
export const SOURCE_BAR_CLOSE = SOURCE_BAR + M15;
/**
 * The canonical evaluation instant: one minute after the source bar closed,
 * inside its 5-minute Native post-close window, when ELIGIBLE evidence for
 * that bar can exist. Every fixture alert is fresh here.
 */
export const FRESH_NOW_MS = SOURCE_BAR_CLOSE + 60_000;
export const FRESH_NOW = new Date(FRESH_NOW_MS);

export interface FixtureOptions {
  sourceTf?: SourceTimeframe;
  signal?: "LONG" | "SHORT";
  symbol?: string;
  id?: string;
  /** Which live observation in the records the alert is for (0 = the first). */
  observation?: number;
  /** The touch's exchange event time (cleanRecords only); default SOURCE_BAR + 61.234s. */
  eventTimeMs?: number;
}

const commitOf = (barMs: number, classification: ShadowClassification = "SHADOW_LIVE_ONLY", symbol = CANARY_SYMBOL) =>
  fixtureCommit(barMs, classification, CANARY_LINEAGE, symbol);

/**
 * Two genuine alerts for the SAME symbol and side from ONE source bar: a 1D and
 * a 1W touch. V2 delivers one alert per source-timeframe slot, so both are
 * delivered, and both become ELIGIBLE at the same commit. This is the shape of
 * the hardest same-symbol + same-side race.
 */
export function sameBarRecords(options: { symbol?: string; signal?: "LONG" | "SHORT" } = {}): ShadowRecord[] {
  const symbol = options.symbol ?? CANARY_SYMBOL;
  const signal = options.signal ?? "LONG";
  return [
    commitOf(bar(0), "QUARANTINED_CURRENT_BAR", symbol),
    observation({ symbol, lineageId: CANARY_LINEAGE, sourceTf: "1D", signal, barMs: SOURCE_BAR, candidateSequence: 0, updateSequence: 2 }),
    observation({ symbol, lineageId: CANARY_LINEAGE, sourceTf: "1W", signal, barMs: SOURCE_BAR, candidateSequence: 1, updateSequence: 3, levelPrice: 0.8101, eventTimeMs: SOURCE_BAR + 95_000, createdBarOpenTimeMs: bar(0) - 7 * 96 * M15 }),
    commitOf(SOURCE_BAR, "SHADOW_LIVE_ONLY", symbol),
  ];
}

/** Readiness bar quarantined, the source bar observed live and committed live: the ELIGIBLE shape. */
export function cleanRecords(options: FixtureOptions = {}): ShadowRecord[] {
  const symbol = options.symbol ?? CANARY_SYMBOL;
  return [
    commitOf(bar(0), "QUARANTINED_CURRENT_BAR", symbol),
    observation({ symbol, lineageId: CANARY_LINEAGE, sourceTf: options.sourceTf ?? "1D", signal: options.signal ?? "LONG", barMs: SOURCE_BAR, eventTimeMs: options.eventTimeMs }),
    commitOf(SOURCE_BAR, "SHADOW_LIVE_ONLY", symbol),
  ];
}

/** The Alert row the real V2 pipeline writes for the observation in `records`. */
export function canaryAlert(records: readonly ShadowRecord[], options: FixtureOptions = {}): NativeCanaryAlert & { id: string; price: number } {
  const symbol = options.symbol ?? CANARY_SYMBOL;
  const observed = records.flatMap((r, i) => (r.kind === "LIVE_IMMEDIATE_OBSERVATION" ? [i] : []));
  const index = observed[options.observation ?? 0];
  if (index === undefined) throw new Error("fixture: no such observation");
  const parsed = parseShadowEventLog(logOf(records), { lineageId: CANARY_LINEAGE, marketType: "USDM_PERPETUAL", symbol, chartInterval: "15m" });
  const target = parsed[index];
  const decision = selectNativeDeliveriesV2(parsed, CANARY_PROFILE.delivery).flatMap((s) =>
    s.kind === "DELIVER" && s.decision.winner.eventId === target.eventId ? [s.decision] : []
  )[0];
  if (decision === undefined) throw new Error("fixture: the observation was not delivered");
  const draft = buildNativeAlertDraftV2(decision, { profile: profileSummaryOf(CANARY_PROFILE), runId: RUN_ID });
  return {
    id: options.id ?? `alert-${target.eventId.slice(0, 8)}`,
    source: draft.source,
    symbol: draft.symbol,
    signal: draft.signal,
    sourceTimeframe: draft.sourceTimeframe ?? null,
    triggeredAt: draft.triggeredAt ?? null,
    rawPayload: draft.rawPayload,
    price: draft.price,
  };
}

export function checkpointBody(hwmOpenTimeMs: number, symbol = CANARY_SYMBOL, over: Partial<LiveCheckpointBody> = {}): LiveCheckpointBody {
  return {
    schema: LIVE_CHECKPOINT_SCHEMA,
    lineageId: CANARY_LINEAGE,
    marketType: "USDM_PERPETUAL",
    symbol,
    chartInterval: "15m",
    compatibilitySwitchoverMs: SWITCHOVER,
    stateSha256AtSwitchover: "e".repeat(64),
    hwmOpenTimeMs,
    lastCommittedBarOpenTimeMs: hwmOpenTimeMs - M15,
    causalBarCount: (hwmOpenTimeMs - SWITCHOVER) / M15,
    causalInputSha256ThroughHwm: CAUSAL,
    stateSha256: STATE,
    ...over,
  };
}

const checkpointFile = (body: LiveCheckpointBody): LiveCheckpointFile => ({ body, bodySha256: canonicalSha256(body), writtenAt: "2026-10-05T12:00:00.000Z" });

/** Scanner evidence as the file-system reader would return it. */
export function evidenceOf(records: readonly ShadowRecord[] | null, hwm: number | null, symbol = CANARY_SYMBOL, over: Partial<NativeScannerEvidence> = {}): NativeScannerEvidence {
  return {
    currentEngineFingerprint: CANARY_FINGERPRINT,
    eventLogText: records === null ? null : logOf(records),
    checkpoint: hwm === null ? null : checkpointFile(checkpointBody(hwm, symbol)),
    ...over,
  };
}

/** A reader that serves one fixed evidence blob, counting reads. */
export function readerOf(evidence: NativeScannerEvidence): NativeScannerEvidenceReader & { reads: () => number } {
  let reads = 0;
  const reader = (() => {
    reads += 1;
    return evidence;
  }) as NativeScannerEvidenceReader & { reads: () => number };
  reader.reads = () => reads;
  return reader;
}

/** The ELIGIBLE evidence for `cleanRecords`: the checkpoint sits on the commit after the source bar. */
export const eligibleEvidence = (records: readonly ShadowRecord[], symbol = CANARY_SYMBOL) => evidenceOf(records, bar(2), symbol);

export function integrityDto(status: NativeExecutionIntegrityStatus): NativeExecutionIntegrityDto {
  return { status, reason: `fixture ${status}`, barOpenTime: new Date(SOURCE_BAR).toISOString() };
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export const TEMPLATE: ExtremeRRTemplateSnapshot = Object.freeze({
  riskTemplateId: "tpl-canary",
  name: "canary template",
  referenceCapital: "300",
  riskPercent: "0.5",
  rewardRatio: "3",
  riskAmount: "1.50",
  targetAmount: "4.50",
});

export const ENTRY_PRICE = "0.8123";

/** One candidate per window; risk and reward distances differ per window so a wrong pick is visible. */
export function candidateFor(lookback: ExtremeRRLookback, direction: "LONG" | "SHORT", over: Partial<ExtremeRRCandidate> = {}): ExtremeRRCandidate {
  const risk = { 50: "0.004", 100: "0.008", 200: "0.016", 300: "0.032" }[lookback];
  const reward = (Number(risk) * 3).toFixed(3);
  const entry = Number(ENTRY_PRICE);
  const stopLoss = (direction === "LONG" ? entry - Number(risk) : entry + Number(risk)).toFixed(4);
  const takeProfit = (direction === "LONG" ? entry + Number(reward) : entry - Number(reward)).toFixed(4);
  const money = calculateExtremeMoney({ entryPrice: ENTRY_PRICE, riskDistance: risk, rewardDistance: reward, riskAmount: TEMPLATE.riskAmount });
  return {
    requestedCandles: lookback,
    actualCandles: lookback,
    complete: true,
    extremePrice: takeProfit,
    oldestCandleOpenTime: null,
    newestCandleCloseTime: null,
    valid: true,
    invalidReason: null,
    extremeType: direction === "LONG" ? "HIGHEST_HIGH" : "LOWEST_LOW",
    takeProfit,
    stopLoss,
    rewardDistance: reward,
    riskDistance: risk,
    riskRewardRatio: "3",
    money: { ...money, leverage: buildLeverageAnalysis(money.positionNotionalRaw, TEMPLATE.riskAmount) },
    ...over,
  };
}

export function planFor(alert: NativeCanaryAlert, over: Partial<NativeCanaryPlan> = {}): NativeCanaryPlan {
  const direction = (alert.signal === "SHORT" ? "SHORT" : "LONG") as "LONG" | "SHORT";
  return {
    id: `plan-${alert.id}`,
    alertId: alert.id,
    alertSource: "NATIVE",
    status: "READY",
    direction,
    entryPrice: ENTRY_PRICE,
    candidates: ([50, 100, 200, 300] as const).map((lookback) => candidateFor(lookback, direction)),
    template: TEMPLATE,
    errorReason: null,
    // What a plan persists when the generic process plans with
    // EXTREME_RR_LOOKBACK_CANDLES=100, as production does.
    selectedLookback: 100,
    ...over,
  };
}

/** The candidates as ExtremeRRPlan.candidates stores them (money is derived on read). */
export function storedCandidates(direction: "LONG" | "SHORT") {
  return ([50, 100, 200, 300] as const).map((lookback) => {
    const { money: _money, ...stored } = candidateFor(lookback, direction);
    return stored;
  });
}

// ---------------------------------------------------------------------------
// Account facts
// ---------------------------------------------------------------------------

export const ACCOUNT_A_POLICY = parseNativeAccountPlanPolicy("A", undefined);
export const ACCOUNT_B_POLICY = parseNativeAccountPlanPolicy("B", undefined);

export const LIVE_READY_GATES: NativeAccountGates["environment"] = Object.freeze({ globalKillSwitch: false, liveEntryEnabled: true, protectionReady: true });
export const SAFE_GATES: NativeAccountGates["environment"] = Object.freeze({ globalKillSwitch: true, liveEntryEnabled: false, protectionReady: false });
export const ARMED_PROFILE = Object.freeze({ isEnabled: true, killSwitchActive: false });

/**
 * Every fact favourable, evaluated at FRESH_NOW: the only thing left to refuse
 * is the hard switch (and, behind it, the UNRESOLVED Native risk contract).
 */
export function favourableInput(options: FixtureOptions = {}, over: Partial<NativeCanaryInput> = {}): NativeCanaryInput & { alert: NativeCanaryAlert & { id: string } } {
  const records = cleanRecords(options);
  const alert = canaryAlert(records, options);
  return {
    accountSlot: "ACCOUNT_A",
    executionProfileId: "profile-account-a",
    alert,
    plan: planFor(alert),
    accountPlanPolicy: ACCOUNT_A_POLICY,
    integrity: integrityDto("ELIGIBLE"),
    occupancy: [],
    accountGates: { environment: LIVE_READY_GATES, profile: ARMED_PROFILE },
    nowMs: FRESH_NOW_MS,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Native risk contracts, for TEST-ONLY module graphs
// ---------------------------------------------------------------------------

/** The production contract module, mocked only inside a test module graph. */
export const RISK_CONTRACT_MODULE = "../src/modules/native-canary/native-risk-contract";

/**
 * A SYNTHETIC resolved Account A contract. It exists only in tests, it is far
 * above the fixture template's risk budget on purpose (so it can only ever
 * cap, never size), and production code can never see it: the production
 * table stays UNRESOLVED for both accounts.
 */
export const SYNTHETIC_RESOLVED_A = Object.freeze({ state: "RESOLVED" as const, account: "A" as const, maxRiskPerTradeUsd: "999999" });
export const UNRESOLVED_B = Object.freeze({ state: "UNRESOLVED" as const, account: "B" as const, reason: "test: B stays unresolved" });

/** The factory a test graph passes to vi.doMock(RISK_CONTRACT_MODULE, ...). */
export const resolvedAContracts = () => ({ NATIVE_RISK_CONTRACTS: Object.freeze({ A: SYNTHETIC_RESOLVED_A, B: UNRESOLVED_B }) });
