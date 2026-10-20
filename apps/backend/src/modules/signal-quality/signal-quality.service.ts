import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  EXTREME_RR_STATUSES,
  SIGNAL_QUALITY_DEFAULT_WINDOW_HOURS,
  SIGNAL_QUALITY_HORIZONS,
  SIGNAL_QUALITY_MAX_ALERTS,
  SIGNAL_QUALITY_MAX_WINDOW_HOURS,
  SIGNAL_QUALITY_POLICY,
  type ExtremeRRPlanStatus,
  type SignalQualityAuthority,
  type SignalQualityChartDto,
  type SignalQualityDetailDto,
  type SignalQualityFlag,
  type SignalQualityFreshnessState,
  type SignalQualityHorizonKey,
  type SignalQualityHorizonState,
  type SignalQualityIntegrityFilter,
  type SignalQualityPageDto,
  type SignalQualityPlanOutcome,
  type SignalQualityRowDto,
  type SignalQualitySampleDto,
  type SignalQualityScopeFilter,
  type SignalQualitySoakHealthDto,
  type SignalQualitySort,
  type SignalQualitySummaryDto,
  type SignalQualityTimeframeClass,
  type SignalQualityWindowDto,
} from "@trading-alert-dashboard/shared";

import { emitterRunDir } from "../native-alerts/native-emitter-state-files";
import { nativeExecutionIntegrityOf, type NativeScannerEvidence, type NativeScannerEvidenceReader } from "../native-integrity/native-execution-integrity";
import { scannerRootDir } from "../native-scanner/scanner-paths";
import { readLocalNativeStatus } from "../signal-sources/signal-sources.service";
import { ValidationError, NotFoundError } from "../../utils/errors";
import { aggregateSignalQuality } from "./signal-quality-aggregate";
import { signalQualityFactsOf, type SignalQualityAlertRow, type SignalQualityFacts, type SignalQualityPlanRow, type SignalQualitySoakWindow } from "./signal-quality-facts";
import { SignalQualityMarketData } from "./signal-quality-market-data";
import { MINUTE_MS, ceilMinute, outcomeBarRange, type OutcomeMarketData } from "./signal-quality-outcome";
import { buildRow, setFlags, type IntegrityVerdict, type RowInput } from "./signal-quality-rows";
import { deriveEmitterHealth, deriveScannerHealth } from "./signal-quality-soak-health";

/**
 * READ-ONLY signal-quality evaluation over persisted Native alerts.
 *
 * It reads Alert and ExtremeRRPlan rows (findMany / count / groupBy only),
 * rebuilds integrity from the machine-local scanner evidence (read only),
 * reads the scanner's and emitter's own status files, and fetches PUBLIC
 * market data through the bounded observatory adapter. It writes nothing:
 * no alert, plan, adoption, lease, execution, order, account gate or risk.
 * It holds no exchange credential and no execution capability.
 *
 * Bounds: one evaluation reads at most SIGNAL_QUALITY_MAX_ALERTS alerts (and
 * says when the window held more), judges integrity for at most
 * INTEGRITY_JUDGEMENTS_PER_EVALUATION of them (others are NOT_JUDGED, never
 * assumed), and loads market data only within the adapter's budget and a
 * deadline (others are NOT_LOADED, never guessed).
 */

export const INTEGRITY_JUDGEMENTS_PER_EVALUATION = 300;
export const INTEGRITY_CACHE_MS = 5 * 60_000;
export const MARKET_DATA_DEADLINE_MS = 8_000;
export const EVALUATION_CACHE_MS = 15_000;
const JUDGEMENTS_PER_TURN = 25;
const ROWS_PER_TURN = 200;
const HOUR_MS = 3_600_000;
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Each scanner lane is read once per evaluation and every alert of that lane is
 * judged against that one snapshot (the same pattern as the Native plan page).
 * The verdict is still nativeExecutionIntegrityOf, untouched.
 */
function readLaneOncePerEvaluation(reader: NativeScannerEvidenceReader): NativeScannerEvidenceReader {
  const lanes = new Map<string, NativeScannerEvidence>();
  return (provenance) => {
    const lane = JSON.stringify([provenance.profileId, provenance.engineFingerprint, provenance.marketType, provenance.symbol, provenance.chartInterval]);
    let evidence = lanes.get(lane);
    if (evidence === undefined) {
      evidence = reader(provenance);
      lanes.set(lane, evidence);
    }
    return evidence;
  };
}

export const AUTHORITY: SignalQualityAuthority = Object.freeze({ policy: SIGNAL_QUALITY_POLICY, authority: "NONE", nativeExecutionEnabled: false, monitoringOnly: true });

export interface SignalQualityFilters {
  readonly symbol?: string;
  readonly sourceTimeframe?: string;
  readonly direction?: "LONG" | "SHORT";
  readonly levelColor?: "GREEN" | "RED";
  readonly timeframeClass?: SignalQualityTimeframeClass;
  readonly integrity?: SignalQualityIntegrityFilter;
  readonly freshness?: SignalQualityFreshnessState;
  readonly planOutcome?: SignalQualityPlanOutcome;
  readonly horizon?: SignalQualityHorizonKey;
  readonly horizonState?: SignalQualityHorizonState;
  readonly flag?: SignalQualityFlag;
}

export interface SignalQualityQuery {
  readonly soakStartMs: number | null;
  readonly soakEndMs: number | null;
  readonly scope: SignalQualityScopeFilter;
  /** Explicit evaluation instant; defaults to now (rounded down to 15 s). Never in the future. */
  readonly asOfMs: number | null;
  readonly filters: SignalQualityFilters;
  readonly sort: SignalQualitySort;
  readonly offset: number;
  readonly pageSize: number;
}

export interface SignalQualityServiceDeps {
  readonly prisma: Pick<PrismaClient, "alert" | "extremeRRPlan">;
  readonly marketData: SignalQualityMarketData;
  /** Read-only scanner evidence for integrity; null = UNREADABLE (never eligible). */
  readonly integrityEvidence: NativeScannerEvidenceReader | null;
  readonly now?: () => number;
  readonly readScannerStatus?: () => string | null;
  readonly readEmitterStatus?: (runId: string) => string | null;
}

const ALERT_SELECT = {
  id: true,
  source: true,
  symbol: true,
  signal: true,
  sourceTimeframe: true,
  levelColor: true,
  touchDirection: true,
  price: true,
  triggeredAt: true,
  createdAt: true,
  duplicateCount: true,
  rawPayload: true,
  extremeRRPlan: { select: { status: true, direction: true, entryPrice: true, cutoffAt: true, generatedAt: true, candidates: true, selectedLookback: true, errorReason: true } },
} as const satisfies Prisma.AlertSelect;

type AlertWithPlan = SignalQualityAlertRow & { extremeRRPlan: SignalQualityPlanRow | null };

interface EvaluatedSet {
  readonly window: SignalQualityWindowDto;
  readonly sample: SignalQualitySampleDto;
  readonly rows: readonly SignalQualityRowDto[];
}

/** The emitter's COMMIT status for one supervisor run, read only. */
export function readLocalEmitterStatus(runId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(runId)) return null;
    const file = path.join(emitterRunDir(scannerRootDir(env), runId), "status-commit.json");
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

export class SignalQualityService {
  private readonly now: () => number;
  private readonly integrityCache = new Map<string, { verdict: IntegrityVerdict; atMs: number }>();
  private readonly evaluations = new Map<string, { atMs: number; set: Promise<EvaluatedSet> }>();

  constructor(private readonly deps: SignalQualityServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  // --- the window --------------------------------------------------------------

  resolveWindow(query: Pick<SignalQualityQuery, "soakStartMs" | "soakEndMs" | "scope" | "asOfMs">): { window: SignalQualityWindowDto; soak: SignalQualitySoakWindow | null; asOfMs: number; startMs: number; endMs: number } {
    const nowMs = this.now();
    const asOfMs = query.asOfMs ?? Math.floor(nowMs / 15_000) * 15_000;
    if (!Number.isFinite(asOfMs) || asOfMs > nowMs) throw new ValidationError("asOf must not be in the future: the observatory never uses data after now");
    let soak: SignalQualitySoakWindow | null = null;
    let startMs: number;
    let endMs: number;
    if (query.soakStartMs !== null || query.soakEndMs !== null) {
      if (query.soakStartMs === null || query.soakEndMs === null) throw new ValidationError("soakStart and soakEnd are given together");
      if (query.soakEndMs <= query.soakStartMs) throw new ValidationError("soakEnd must be after soakStart");
      if (query.soakEndMs - query.soakStartMs > SIGNAL_QUALITY_MAX_WINDOW_HOURS * HOUR_MS) throw new ValidationError(`a soak window is at most ${SIGNAL_QUALITY_MAX_WINDOW_HOURS} hours`);
      soak = { startMs: query.soakStartMs, endMs: query.soakEndMs };
      startMs = query.soakStartMs;
      endMs = Math.min(query.soakEndMs, asOfMs);
    } else {
      if (query.scope !== "ALL") throw new ValidationError("a soak scope needs soakStart and soakEnd");
      endMs = asOfMs;
      startMs = asOfMs - SIGNAL_QUALITY_DEFAULT_WINDOW_HOURS * HOUR_MS;
    }
    const iso = (ms: number) => new Date(ms).toISOString();
    return {
      window: { soakStart: soak ? iso(soak.startMs) : null, soakEnd: soak ? iso(soak.endMs) : null, windowStart: iso(startMs), windowEnd: iso(endMs), scope: query.scope, asOf: iso(asOfMs) },
      soak,
      asOfMs,
      startMs,
      endMs,
    };
  }

  private async readAlerts(where: Prisma.AlertWhereInput, take: number): Promise<AlertWithPlan[]> {
    const rows = await this.deps.prisma.alert.findMany({ where, orderBy: [{ triggeredAt: "desc" }, { id: "desc" }], take, select: ALERT_SELECT });
    return rows as unknown as AlertWithPlan[];
  }

  // --- integrity (bounded, cached, never assumed) --------------------------------

  private async judgeIntegrity(alerts: readonly AlertWithPlan[], priority: ReadonlySet<string>): Promise<Map<string, IntegrityVerdict>> {
    const out = new Map<string, IntegrityVerdict>();
    const nowMs = this.now();
    const reader = this.deps.integrityEvidence === null ? null : readLaneOncePerEvaluation(this.deps.integrityEvidence);
    const ordered = [...alerts.filter((a) => priority.has(a.id)), ...alerts.filter((a) => !priority.has(a.id))];
    let judged = 0;
    for (const alert of ordered) {
      const cached = this.integrityCache.get(alert.id);
      if (cached && nowMs - cached.atMs < INTEGRITY_CACHE_MS) {
        out.set(alert.id, cached.verdict);
        continue;
      }
      if (judged >= INTEGRITY_JUDGEMENTS_PER_EVALUATION) continue;
      if (judged > 0 && judged % JUDGEMENTS_PER_TURN === 0) await nextTurn();
      judged += 1;
      const dto = nativeExecutionIntegrityOf(alert, reader);
      const verdict = { status: dto.status, reason: dto.reason };
      this.integrityCache.set(alert.id, { verdict, atMs: nowMs });
      out.set(alert.id, verdict);
    }
    if (this.integrityCache.size > 20_000) {
      for (const [id, entry] of this.integrityCache) if (nowMs - entry.atMs >= INTEGRITY_CACHE_MS) this.integrityCache.delete(id);
    }
    return out;
  }

  // --- market data (bounded, never guessed) ----------------------------------------

  private async marketDataFor(facts: readonly SignalQualityFacts[], asOfMs: number, priority: ReadonlySet<string>): Promise<Map<string, { marketData: OutcomeMarketData; evaluationEndMs: number }>> {
    const ranges = facts.map((f) => ({ facts: f, range: outcomeBarRange(f.triggeredAtMs) }));
    const wanted = [...ranges.filter((r) => priority.has(r.facts.alertId)), ...ranges.filter((r) => !priority.has(r.facts.alertId))];
    await this.deps.marketData.ensure(
      wanted.map((r) => ({ symbol: r.facts.symbol, fromMs: r.range.fromMs, toMs: Math.min(r.range.toMs, asOfMs) })),
      this.now() + MARKET_DATA_DEADLINE_MS
    );
    const out = new Map<string, { marketData: OutcomeMarketData; evaluationEndMs: number }>();
    for (const { facts: f, range } of ranges) {
      const view = this.deps.marketData.view({ symbol: f.symbol, fromMs: range.fromMs, toMs: range.toMs });
      // Never past the evaluation instant, nor past what the data covers.
      out.set(f.alertId, { marketData: view.marketData, evaluationEndMs: view.coveredThroughMs === null ? asOfMs : Math.min(asOfMs, view.coveredThroughMs) });
    }
    return out;
  }

  private async evaluateAlerts(alerts: readonly AlertWithPlan[], soak: SignalQualitySoakWindow | null, asOfMs: number, priority: ReadonlySet<string>): Promise<{ rows: SignalQualityRowDto[]; judged: number }> {
    const facts: SignalQualityFacts[] = [];
    for (const alert of alerts) {
      const f = signalQualityFactsOf(alert, alert.extremeRRPlan, soak);
      if (f !== null) facts.push(f);
    }
    const integrity = await this.judgeIntegrity(alerts, priority);
    const market = await this.marketDataFor(facts, asOfMs, priority);
    // Each row is evaluated at the instant its data covers (never later than asOf), so a row whose
    // data stops early reports PARTIAL rather than a gap that does not exist.
    const inputs: RowInput[] = facts.map((f) => {
      const m = market.get(f.alertId) as { marketData: OutcomeMarketData; evaluationEndMs: number };
      return { facts: f, integrity: integrity.get(f.alertId) ?? null, marketData: m.marketData, evaluationEndMs: m.evaluationEndMs };
    });
    // Set-level flags once, then rows in chunks: the backend also serves webhooks, so a large window yields to the event loop.
    const flags = setFlags(inputs.map((i) => i.facts));
    const rows: SignalQualityRowDto[] = [];
    for (let i = 0; i < inputs.length; i += 1) {
      if (i > 0 && i % ROWS_PER_TURN === 0) await nextTurn();
      rows.push(buildRow(inputs[i], flags.get(inputs[i].facts.alertId) ?? [], asOfMs));
    }
    rows.sort((a, b) => (a.triggeredAt < b.triggeredAt ? 1 : a.triggeredAt > b.triggeredAt ? -1 : a.alertId < b.alertId ? 1 : -1));
    return { rows, judged: integrity.size };
  }

  /** One evaluated set for the window, shared briefly by summary, page and export. */
  async evaluate(query: SignalQualityQuery, priorityIds: readonly string[] = []): Promise<EvaluatedSet> {
    const resolved = this.resolveWindow(query);
    const key = JSON.stringify([resolved.window.soakStart, resolved.window.soakEnd, resolved.window.windowStart, resolved.window.windowEnd, resolved.asOfMs]);
    const nowMs = this.now();
    const cached = this.evaluations.get(key);
    if (cached && nowMs - cached.atMs < EVALUATION_CACHE_MS) return cached.set;
    const promise = this.evaluateFresh(resolved, new Set(priorityIds));
    this.evaluations.set(key, { atMs: nowMs, set: promise });
    promise.catch(() => this.evaluations.delete(key));
    for (const [k, v] of this.evaluations) if (nowMs - v.atMs >= EVALUATION_CACHE_MS) this.evaluations.delete(k);
    return promise;
  }

  private async evaluateFresh(resolved: ReturnType<SignalQualityService["resolveWindow"]>, priority: ReadonlySet<string>): Promise<EvaluatedSet> {
    const { soak, asOfMs, startMs, endMs } = resolved;
    const base: Prisma.AlertWhereInput = { source: "NATIVE", signal: { in: ["LONG", "SHORT"] }, createdAt: { lte: new Date(asOfMs) }, triggeredAt: { lte: new Date(asOfMs) } };
    const window: Prisma.AlertWhereInput =
      soak === null
        ? { triggeredAt: { gte: new Date(startMs), lte: new Date(endMs) } }
        : { OR: [{ triggeredAt: { gte: new Date(startMs), lt: new Date(soak.endMs) } }, { createdAt: { gte: new Date(startMs), lt: new Date(soak.endMs) } }] };
    const alerts = await this.readAlerts({ AND: [base, window] }, SIGNAL_QUALITY_MAX_ALERTS + 1);
    const truncated = alerts.length > SIGNAL_QUALITY_MAX_ALERTS;
    const kept = alerts.slice(0, SIGNAL_QUALITY_MAX_ALERTS);
    const { rows, judged } = await this.evaluateAlerts(kept, soak, asOfMs, priority);
    const marketData = { LOADED: 0, NOT_LOADED: 0, UNAVAILABLE: 0 };
    for (const row of rows) marketData[row.marketData.status] += 1;
    return {
      window: resolved.window,
      sample: { evaluated: rows.length, truncated, limit: SIGNAL_QUALITY_MAX_ALERTS, marketData, integrityJudged: judged, integrityNotJudged: rows.length - judged },
      rows,
    };
  }

  // --- filters, sort, page -----------------------------------------------------------

  static applyFilters(rows: readonly SignalQualityRowDto[], query: Pick<SignalQualityQuery, "scope" | "filters">): SignalQualityRowDto[] {
    const f = query.filters;
    return rows.filter((row) => {
      if (query.scope !== "ALL" && row.soakScope !== query.scope) return false;
      if (f.symbol !== undefined && row.symbol.toUpperCase() !== f.symbol.toUpperCase()) return false;
      if (f.sourceTimeframe !== undefined && row.sourceTimeframe !== f.sourceTimeframe) return false;
      if (f.direction !== undefined && row.direction !== f.direction) return false;
      if (f.levelColor !== undefined && row.levelColor !== f.levelColor) return false;
      if (f.timeframeClass !== undefined && row.timeframeClass !== f.timeframeClass) return false;
      if (f.integrity !== undefined) {
        const key = !row.integrity.judged ? "NOT_JUDGED" : row.integrity.status === "ELIGIBLE" ? "ELIGIBLE" : "NOT_ELIGIBLE";
        if (key !== f.integrity) return false;
      }
      if (f.freshness !== undefined && row.freshness.state !== f.freshness) return false;
      if (f.planOutcome !== undefined && row.plan.outcome !== f.planOutcome) return false;
      if (f.horizonState !== undefined) {
        const h = row.horizons.find((x) => x.key === (f.horizon ?? "24h"));
        if (h === undefined || h.state !== f.horizonState) return false;
      }
      if (f.flag !== undefined && !row.flags.some((x) => x.code === f.flag)) return false;
      return true;
    });
  }

  static sortRows(rows: readonly SignalQualityRowDto[], sort: SignalQualitySort): SignalQualityRowDto[] {
    const byTriggerDesc = (a: SignalQualityRowDto, b: SignalQualityRowDto) => (a.triggeredAt < b.triggeredAt ? 1 : a.triggeredAt > b.triggeredAt ? -1 : a.alertId < b.alertId ? 1 : a.alertId > b.alertId ? -1 : 0);
    const nullsLast = (x: number | null) => (x === null ? Number.NEGATIVE_INFINITY : x);
    const mfe24 = (r: SignalQualityRowDto) => {
      const h = r.horizons.find((x) => x.key === "24h");
      return h && h.state === "MATURED" ? h.mfePct : null;
    };
    const compare: Record<SignalQualitySort, (a: SignalQualityRowDto, b: SignalQualityRowDto) => number> = {
      TRIGGERED_DESC: byTriggerDesc,
      TRIGGERED_ASC: (a, b) => -byTriggerDesc(a, b),
      SYMBOL_ASC: (a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : byTriggerDesc(a, b)),
      R_DESC: (a, b) => nullsLast(b.plan.rMultiple) - nullsLast(a.plan.rMultiple) || byTriggerDesc(a, b),
      MFE_24H_DESC: (a, b) => nullsLast(mfe24(b)) - nullsLast(mfe24(a)) || byTriggerDesc(a, b),
    };
    return [...rows].sort(compare[sort]);
  }

  async summary(query: SignalQualityQuery): Promise<SignalQualitySummaryDto> {
    const set = await this.evaluate(query);
    const rows = SignalQualityService.applyFilters(set.rows, query);
    return { ...AUTHORITY, window: set.window, sample: set.sample, ...aggregateSignalQuality(rows) };
  }

  async page(query: SignalQualityQuery): Promise<SignalQualityPageDto> {
    const set = await this.evaluate(query);
    const rows = SignalQualityService.sortRows(SignalQualityService.applyFilters(set.rows, query), query.sort);
    const items = rows.slice(query.offset, query.offset + query.pageSize);
    return {
      ...AUTHORITY,
      window: set.window,
      sample: set.sample,
      items,
      pagination: { offset: query.offset, pageSize: query.pageSize, total: rows.length, hasMore: query.offset + query.pageSize < rows.length, sort: query.sort },
    };
  }

  async exportRows(query: SignalQualityQuery): Promise<{ window: SignalQualityWindowDto; sample: SignalQualitySampleDto; rows: SignalQualityRowDto[] }> {
    const set = await this.evaluate(query);
    return { window: set.window, sample: set.sample, rows: SignalQualityService.sortRows(SignalQualityService.applyFilters(set.rows, query), query.sort) };
  }

  // --- one alert ----------------------------------------------------------------------

  private async alertOrThrow(alertId: string): Promise<AlertWithPlan> {
    const [alert] = await this.readAlerts({ id: alertId, source: "NATIVE" }, 1);
    if (alert === undefined) throw new NotFoundError(`Native alert ${alertId} not found`);
    return alert;
  }

  /** One alert, evaluated with its neighbours on the same symbol (repeats are judged within the 24 h before it). */
  async detail(alertId: string, asOfInput: number | null): Promise<SignalQualityDetailDto> {
    const alert = await this.alertOrThrow(alertId);
    const { asOfMs } = this.resolveWindow({ soakStartMs: null, soakEndMs: null, scope: "ALL", asOfMs: asOfInput });
    if (alert.createdAt.getTime() > asOfMs) throw new ValidationError("the alert did not exist yet at asOf");
    const t = alert.triggeredAt.getTime();
    const neighbours = await this.readAlerts(
      { source: "NATIVE", symbol: alert.symbol, signal: { in: ["LONG", "SHORT"] }, triggeredAt: { gte: new Date(t - 24 * HOUR_MS), lte: new Date(t) }, createdAt: { lte: new Date(asOfMs) } },
      200
    );
    const set = neighbours.some((a) => a.id === alert.id) ? neighbours : [alert, ...neighbours];
    const { rows } = await this.evaluateAlerts(set, null, asOfMs, new Set([alert.id]));
    const row = rows.find((r) => r.alertId === alert.id);
    if (row === undefined) throw new NotFoundError(`Native alert ${alertId} is not a LONG/SHORT signal`);
    const facts = signalQualityFactsOf(alert, alert.extremeRRPlan, null) as SignalQualityFacts;
    const w = facts.freshness.window;
    const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
    return {
      ...AUTHORITY,
      asOf: new Date(asOfMs).toISOString(),
      row,
      evidence: { payloadSchema: facts.payload.schema, delivery: facts.payload.delivery, profile: facts.payload.profile, note: facts.payload.note },
      freshnessWindow: { barStart: iso(w?.barStartMs ?? facts.payload.barStartMs), barClose: iso(w?.barCloseMs), postCloseExpiry: iso(w?.postCloseExpiryMs), absoluteExpiry: iso(w?.absoluteExpiryMs), expiresAt: iso(w?.expiresAtMs) },
    };
  }

  /** 15-minute bars around one alert, never past asOf; before and after the signal are marked by signalTime. */
  async chart(alertId: string, asOfInput: number | null): Promise<SignalQualityChartDto> {
    const alert = await this.alertOrThrow(alertId);
    const { asOfMs } = this.resolveWindow({ soakStartMs: null, soakEndMs: null, scope: "ALL", asOfMs: asOfInput });
    const facts = signalQualityFactsOf(alert, alert.extremeRRPlan, null);
    if (facts === null) throw new NotFoundError(`Native alert ${alertId} is not a LONG/SHORT signal`);
    const t = facts.triggeredAtMs;
    const S = ceilMinute(t);
    const result = await this.deps.marketData.chartBars(facts.symbol, t - 12 * HOUR_MS, Math.min(S + 24 * HOUR_MS + 15 * MINUTE_MS, asOfMs));
    const geometry = facts.plan.geometry;
    return {
      ...AUTHORITY,
      alertId,
      interval: "15m",
      asOf: new Date(asOfMs).toISOString(),
      signalTime: new Date(t).toISOString(),
      bars: "bars" in result ? result.bars.filter((b) => b.time * 1000 + 15 * MINUTE_MS <= asOfMs) : [],
      levelPrice: facts.levelPrice,
      entry: geometry.available ? geometry.entry : null,
      stopLoss: geometry.available ? geometry.stopLoss : null,
      takeProfit: geometry.available ? geometry.takeProfit : null,
      horizonMarks: SIGNAL_QUALITY_HORIZONS.map((h) => ({ key: h.key, time: new Date(S + h.minutes * MINUTE_MS).toISOString() })).filter((m) => Date.parse(m.time) <= asOfMs),
      marketData: "bars" in result ? { status: "LOADED", reason: null } : { status: "UNAVAILABLE", reason: result.error },
    };
  }

  // --- soak health ----------------------------------------------------------------------

  async soakHealth(): Promise<SignalQualitySoakHealthDto> {
    const nowMs = this.now();
    const scanner = deriveScannerHealth((this.deps.readScannerStatus ?? readLocalNativeStatus)(), nowMs);
    const emitterText = scanner.runId === null ? null : (this.deps.readEmitterStatus ?? readLocalEmitterStatus)(scanner.runId);
    const [last, lastHour, last24h, groups] = await Promise.all([
      this.deps.prisma.alert.findFirst({ where: { source: "NATIVE" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true } }),
      this.deps.prisma.alert.count({ where: { source: "NATIVE", createdAt: { gte: new Date(nowMs - HOUR_MS) } } }),
      this.deps.prisma.alert.count({ where: { source: "NATIVE", createdAt: { gte: new Date(nowMs - 24 * HOUR_MS) } } }),
      this.deps.prisma.extremeRRPlan.groupBy({ by: ["status"], where: { alert: { source: "NATIVE" } }, _count: { _all: true } }),
    ]);
    const plans = Object.fromEntries(EXTREME_RR_STATUSES.map((s) => [s, 0])) as Record<ExtremeRRPlanStatus, number>;
    for (const g of groups) plans[g.status] = g._count._all;
    return {
      ...AUTHORITY,
      generatedAt: new Date(nowMs).toISOString(),
      scanner,
      emitter: deriveEmitterHealth(emitterText, nowMs),
      alerts: { lastDeliveredAt: last ? last.createdAt.toISOString() : null, lastHour, last24h },
      plans,
    };
  }
}
