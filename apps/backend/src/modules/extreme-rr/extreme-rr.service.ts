import type {
  Alert,
  ExtremeRRPlan,
  Prisma,
  PrismaClient,
  SelectedPlanAdoption,
  SelectedPlanOutcome,
} from "@prisma/client";
import {
  EXTREME_RR_DEFAULT_LOOKBACK,
  EXTREME_RR_LOOKBACKS,
  EXTREME_RR_STATUSES,
  NATIVE_PLAN_INTEGRITY_SCAN_LIMIT,
  NATIVE_PLAN_PAGE_DEFAULT_SIZE,
  NATIVE_PLAN_PAGE_MAX_SIZE,
  isExtremeRRLookback,
  nativeIntegrityMatches,
  buildLeverageAnalysis,
  calculateExtremeCandidate,
  calculateExtremeMoney,
  calculateRiskTemplateAmounts,
  extremeOfDecimalStrings,
  type ExtremeRRCandidate,
  type ExtremeRRLeverage,
  type ExtremeRRLookback,
  type ExtremeRRPlanDto,
  type ExtremeRRPlanStatus,
  type ExtremeRRTemplateSnapshot,
  type NativeAccountPlanPolicy,
  type NativeExecutionIntegrityDto,
  type NativePlanIntegrityScan,
  type NativePlanListDto,
  type NativePlanListItemDto,
  type NativePlanPageDto,
  type NativePlanPageQuery,
  type NativePlanStatusCounts,
  type SelectedPlanAccountOutcomeDto,
  previewNativeAccountPlan,
  selectedPlanSummaryOf,
} from "@trading-alert-dashboard/shared";
import { getClosedCandlesBefore } from "../market-data/market-data.service";
import type { SnapshotCandle } from "../market-data/market-data.types";
import { RiskTemplateRepository } from "../risk-template/risk-template.repository";
import { inferMarketType, type MarketType } from "../../utils/symbol";
import { NotFoundError, ValidationError } from "../../utils/errors";
import { NATIVE_ALERT_SOURCE, assertNotNativeAlert } from "../alerts/alert-source";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import type { ExtremeRRSelectionInput } from "./extreme-rr.schema";
import { configuredNativeAccountPlanPolicies } from "../native-planning/native-account-plan-policy";
import {
  nativeExecutionIntegrityOf,
  type NativeScannerEvidence,
  type NativeScannerEvidenceReader,
} from "../native-integrity/native-execution-integrity";

/**
 * Injectable so tests can freeze the candle dataset. The default fetcher uses
 * real Binance data only (never mock candles) with the alert's triggeredAt as
 * the immutable cutoff.
 */
export type SnapshotCandleFetcher = (alert: Alert, cutoff: Date, limit: number) => Promise<SnapshotCandle[]>;

/** The only market a Native alert can come from: the scanner's Binance USD-M USDT perpetuals. */
const NATIVE_PLAN_MARKET = "USDM_PERPETUAL";

/**
 * Which Binance market an alert's plan candles come from.
 *
 * TRADINGVIEW: TradingView's ".P" perpetual suffix on the webhook symbol, as
 * always. NATIVE: the market the Native payload itself names; a Native symbol
 * carries no ".P", so the TradingView rule would silently pick SPOT. A Native
 * alert that does not name USDM_PERPETUAL yields null: the plan is refused
 * (ERROR) rather than planned against a guessed market.
 */
export function extremeRRMarketTypeOf(alert: Pick<Alert, "source" | "symbol" | "rawPayload">): MarketType | null {
  const payload = alert.rawPayload as { symbol?: unknown; marketType?: unknown } | null;
  if (alert.source === NATIVE_ALERT_SOURCE) return payload?.marketType === NATIVE_PLAN_MARKET ? "futures" : null;
  return inferMarketType(payload?.symbol ?? alert.symbol);
}

const defaultCandleFetcher: SnapshotCandleFetcher = (alert, cutoff, limit) => {
  const marketType = extremeRRMarketTypeOf(alert);
  if (marketType === null) {
    throw new Error(`Native alert ${alert.id} does not name its market (${NATIVE_PLAN_MARKET}); refusing to plan against a guessed market`);
  }
  return getClosedCandlesBefore(
    alert.assetType,
    alert.symbol,
    alert.timeframe,
    cutoff,
    alert.exchange,
    marketType,
    Math.max(...EXTREME_RR_LOOKBACKS)
  );
};

/**
 * The INITIAL `selectedLookback` a NEW plan starts on.
 *
 * Phase 11F -- GLOBAL, because the plan it shapes is global.
 *
 * Since 11E one ExtremeRRPlan is generated per alert and adopted
 * INDEPENDENTLY by every account. An input that belonged to one account's
 * ExecutionProfile therefore shaped a plan the other account would also
 * trade -- and after the 11F split the generic processes hold no account at
 * all, so reading a profile here would either fail or quietly mean
 * 'whichever account this process happens to be'.
 *
 * So the value is deployment configuration, read by whichever process is
 * generating: no profile, no database, no credentials.
 *
 * An unsupported value cannot reach here: `config/env` validates the key
 * against the same canonical vocabulary at parse time, so a process holding
 * one never starts. The check below is retained for two reasons that are
 * both real -- it NARROWS `number` to `ExtremeRRLookback` for the type, and
 * it keeps the refusal local to the exported, injectable resolver. It has
 * never been a fallback: quietly planning at 300 would build a trade from a
 * window the operator never chose.
 */
/** Injectable so a test can pin the window without touching configuration. */
export type InitialLookbackResolver = () => ExtremeRRLookback | Promise<ExtremeRRLookback>;

export function resolveInitialLookback(): ExtremeRRLookback {
  const stored: unknown = env.EXTREME_RR_LOOKBACK_CANDLES;
  if (!isExtremeRRLookback(stored)) {
    // Unreachable through configuration -- `config/env` already refused it --
    // and deliberately still here: it is what narrows the number to the
    // vocabulary type, and a refusal is never a coercion.
    throw new Error(
      `The configured Extreme RR lookback (${stored}) is not one of ` +
        `${EXTREME_RR_LOOKBACKS.join(", ")}; refusing to plan on an unrecognised window.`
    );
  }
  return stored;
}

/** Stored (frozen) candidate shape — the DTO candidate minus derived money. */
export type StoredCandidate = Omit<ExtremeRRCandidate, "money">;

/**
 * Builds the three frozen lookback candidates from ONE dataset of candles
 * that closed at or before the cutoff. Each candidate uses the trailing
 * (most recent) `lookback` candles of that same dataset. LONG candidates use
 * only the highest high; SHORT candidates use only the lowest low. Exported
 * for tests.
 */
export function buildCandidates(
  candles: SnapshotCandle[],
  direction: "LONG" | "SHORT",
  entryPrice: string,
  rewardRatio: string | null,
  cutoff: Date
): StoredCandidate[] {
  // Defense in depth: never let a candle that closed after the cutoff in,
  // regardless of what the fetcher returned.
  const cutoffMs = cutoff.getTime();
  const closed = candles
    .filter((candle) => candle.closeTimeMs <= cutoffMs)
    .sort((a, b) => a.openTimeMs - b.openTimeMs);

  return EXTREME_RR_LOOKBACKS.map((lookback) => {
    const subset = closed.slice(-lookback);
    const actualCandles = subset.length;

    if (actualCandles === 0) {
      return {
        requestedCandles: lookback,
        actualCandles: 0,
        complete: false,
        extremeType: direction === "LONG" ? "HIGHEST_HIGH" : "LOWEST_LOW",
        extremePrice: null,
        oldestCandleOpenTime: null,
        newestCandleCloseTime: null,
        valid: false,
        invalidReason: "No closed candles available before the alert",
        takeProfit: null,
        stopLoss: null,
        rewardDistance: null,
        riskDistance: null,
        riskRewardRatio: null,
      };
    }

    // LONG uses only the highs; SHORT uses only the lows.
    const extremePrice =
      direction === "LONG"
        ? extremeOfDecimalStrings(subset.map((candle) => candle.high), "max")
        : extremeOfDecimalStrings(subset.map((candle) => candle.low), "min");

    const geometry = calculateExtremeCandidate({
      direction,
      entryPrice,
      extremePrice,
      rewardRatio,
    });

    return {
      requestedCandles: lookback,
      actualCandles,
      complete: actualCandles === lookback,
      extremePrice,
      oldestCandleOpenTime: new Date(subset[0].openTimeMs).toISOString(),
      newestCandleCloseTime: new Date(subset[actualCandles - 1].closeTimeMs).toISOString(),
      ...geometry,
    };
  });
}

function decimalToString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * The alert's source, exactly as stored. Strict: a value that is neither
 * TRADINGVIEW nor NATIVE is a refusal, never a default, because the executor
 * admits only a plan that positively says TRADINGVIEW.
 */
function planAlertSourceOf(source: unknown): ExtremeRRPlanDto["alertSource"] {
  if (source === "TRADINGVIEW" || source === NATIVE_ALERT_SOURCE) return source;
  throw new Error(`Unknown alert source ${String(source)}; refusing to serialize the plan`);
}

/** How many Native plans the read-only list returns at most. */
export const NATIVE_PLAN_LIST_LIMIT = { default: 20, max: 50 } as const;

// ---------------------------------------------------------------------------
// Native plan PAGES (Trading Control's table). Read only, like the list above.
// ---------------------------------------------------------------------------

/** A keyset position: the (triggeredAt, alertId) of the last plan a page returned or scanned. */
export interface NativePlanCursor {
  readonly triggeredAt: Date;
  readonly alertId: string;
}

const CURSOR_TEXT = /^[A-Za-z0-9_-]{1,256}$/;
const CURSOR_ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURSOR_ALERT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function encodeNativePlanCursor(position: NativePlanCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, t: position.triggeredAt.toISOString(), a: position.alertId }), "utf8").toString("base64url");
}

/**
 * Strict: only a cursor this API issued is accepted, byte for byte. Anything
 * else is refused, never silently read as "start from the newest page".
 */
export function decodeNativePlanCursor(raw: string): NativePlanCursor {
  const refuse = (): never => {
    throw new ValidationError("cursor is not a Native plan page cursor issued by this API");
  };
  if (!CURSOR_TEXT.test(raw)) return refuse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return refuse();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return refuse();
  const { v, t, a, ...rest } = parsed as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || v !== 1 || typeof t !== "string" || typeof a !== "string") return refuse();
  if (!CURSOR_ISO_MS.test(t) || !CURSOR_ALERT_ID.test(a)) return refuse();
  const position = { triggeredAt: new Date(t), alertId: a };
  if (Number.isNaN(position.triggeredAt.getTime()) || position.triggeredAt.toISOString() !== t) return refuse();
  if (encodeNativePlanCursor(position) !== raw) return refuse();
  return position;
}

const NATIVE_PLANS_ONLY: Prisma.ExtremeRRPlanWhereInput = { alert: { source: NATIVE_ALERT_SOURCE } };

/** Search and filters, in the database. Integrity is not here: it is never stored. */
function nativePlanFilterWhere(query: NativePlanPageQuery): Prisma.ExtremeRRPlanWhereInput {
  const and: Prisma.ExtremeRRPlanWhereInput[] = [NATIVE_PLANS_ONLY];
  // q is letters and digits only (validated), so it can never act as a LIKE pattern.
  if (query.q !== undefined) and.push({ OR: [{ alert: { symbol: { contains: query.q, mode: "insensitive" } } }, { alertId: query.q }] });
  if (query.sourceTimeframe !== undefined) and.push({ alert: { sourceTimeframe: query.sourceTimeframe } });
  if (query.direction !== undefined) and.push({ direction: query.direction });
  if (query.planStatus !== undefined) and.push({ status: query.planStatus });
  return { AND: and };
}

/** Strictly after `position` in NATIVE_PLAN_PAGE_ORDER. */
function olderThan(position: NativePlanCursor): Prisma.ExtremeRRPlanWhereInput {
  return {
    OR: [
      { alert: { triggeredAt: { lt: position.triggeredAt } } },
      { alert: { triggeredAt: position.triggeredAt }, alertId: { lt: position.alertId } },
    ],
  };
}

/** Newest trigger first; alertId breaks ties. Both immutable, so pages never shift under new alerts. */
const NATIVE_PLAN_PAGE_ORDER: Prisma.ExtremeRRPlanOrderByWithRelationInput[] = [{ alert: { triggeredAt: "desc" } }, { alertId: "desc" }];

/** Rows read per database round trip while the integrity filter scans. */
const NATIVE_PLAN_SCAN_CHUNK = 50;

/**
 * Integrity judgements per turn of the event loop. Each one reads and strictly
 * parses its lane's whole event log synchronously, so a large page is judged in
 * turns and other requests are served in between. Verdicts are unaffected.
 */
const NATIVE_PLAN_JUDGEMENTS_PER_TURN = 25;
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const NATIVE_PLAN_ALERT_FIELDS = { select: { source: true, symbol: true, sourceTimeframe: true, triggeredAt: true, rawPayload: true } } as const;

type NativePlanRow = PlanWithOutcome & { alert: Pick<Alert, "source" | "symbol" | "sourceTimeframe" | "triggeredAt" | "rawPayload"> };

const positionOf = (plan: NativePlanRow): NativePlanCursor => ({ triggeredAt: plan.alert.triggeredAt, alertId: plan.alertId });

/**
 * Each lane's scanner evidence is read once per request, and every alert of
 * that lane is judged against that one snapshot. The verdict rule is
 * untouched: the evidence is exactly what the reader returned.
 */
export function readEachLaneOnce(reader: NativeScannerEvidenceReader): NativeScannerEvidenceReader {
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

type PlanWithOutcome = ExtremeRRPlan & {
  selectedPlanOutcome?: SelectedPlanOutcome | null;
  /** Phase 11E: the canonical per-account verdicts. */
  selectedPlanAdoptions?: SelectedPlanAdoption[];
};

/**
 * What every read of a plan fetches alongside it.
 *
 * Phase 11E: the per-account rows are canonical, so they are not optional
 * enrichment -- a read that omitted them would silently report an evaluated
 * plan as unevaluated. COMPLETED only: a PENDING row is a claim in progress,
 * and showing one as a verdict would invent an outcome nobody reached.
 */
const PLAN_OUTCOME_INCLUDE = {
  selectedPlanOutcome: true,
  selectedPlanAdoptions: {
    where: { status: "COMPLETED" as const },
    // Stable between reads. Deliberately NOT by time: ordering by when an
    // account happened to finish is the first step towards treating the last
    // one as the answer.
    orderBy: { executionProfileId: "asc" as const },
  },
} as const;

/**
 * The singular compatibility field, or null when projecting one would lie.
 *
 * Phase 11E made the per-account rows canonical. This exists so a UI and an
 * API written when there was one account keep working unchanged -- and so
 * they stop showing a singular answer the moment there is no longer one to
 * give. Picking the latest, the first, or any other arbitrary account would
 * present that account's refusal as the system's verdict.
 */
function projectSingularOutcome(
  accounts: SelectedPlanAccountOutcomeDto[],
  legacy: SelectedPlanOutcome | null
): ExtremeRRPlanDto["executionOutcome"] {
  if (accounts.length === 1) {
    const only = accounts[0];
    return {
      handled: only.handled,
      reasonCode: only.reasonCode,
      message: only.message,
      executionId: only.executionId,
      evaluatedAt: only.evaluatedAt,
    };
  }
  // Two or more: there is no overall verdict, and inventing one is the exact
  // failure this projection exists to avoid.
  if (accounts.length > 1) return null;
  // None: a pre-11E plan may still carry its historical explanation.
  return legacy
    ? {
        handled: legacy.handled,
        reasonCode: legacy.reasonCode,
        message: legacy.message,
        executionId: legacy.executionId,
        evaluatedAt: legacy.evaluatedAt.toISOString(),
      }
    : null;
}

export class ExtremeRRService {
  private readonly riskTemplates: RiskTemplateRepository;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly fetchCandles: SnapshotCandleFetcher = defaultCandleFetcher,
    /**
     * Injectable for the same reason the candle fetcher is: it lets the plan
     * geometry be tested without a database, and lets a test state the policy
     * a plan was generated under instead of staging one.
     */
    private readonly resolveLookback: InitialLookbackResolver = resolveInitialLookback
  ) {
    this.riskTemplates = new RiskTemplateRepository(prisma);
  }

  private async getAlertOrThrow(alertId: string): Promise<Alert> {
    const alert = await this.prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) throw new NotFoundError(`Alert ${alertId} not found`);
    return alert;
  }

  private static assertDirectional(alert: Alert): "LONG" | "SHORT" {
    if (alert.signal !== "LONG" && alert.signal !== "SHORT") {
      throw new ValidationError(
        `Extreme RR plans require a LONG or SHORT alert (got ${alert.signal})`
      );
    }
    return alert.signal;
  }

  /**
   * Creates the PENDING plan row when an actionable alert is persisted, so
   * the UI can show lifecycle status immediately. Never overwrites an
   * existing plan.
   */
  async ensurePendingPlan(alert: Alert): Promise<void> {
    // A NATIVE alert never enters the TradingView planning queue: it has its
    // own dedicated, planning-only Native queue and PENDING intent
    // (modules/native-planning) with no Telegram, or is generated on demand
    // (generateForAlert).
    assertNotNativeAlert(alert, "queued Extreme RR planning");
    const direction = ExtremeRRService.assertDirectional(alert);
    const existing = await this.prisma.extremeRRPlan.findUnique({ where: { alertId: alert.id } });
    if (existing) return;

    await this.prisma.extremeRRPlan.create({
      data: {
        alertId: alert.id,
        status: "PENDING",
        direction,
        entryPrice: String(alert.price),
        cutoffAt: alert.triggeredAt,
        timeframe: alert.timeframe,
        // The operator's in-force policy, not the shipped constant. This is
        // the ONE moment a plan's lookback is chosen for it; from here on the
        // row owns its own value and a later policy change cannot reach it.
        selectedLookback: await this.resolveLookback(),
      },
    });
  }

  /**
   * Generates (or regenerates) the frozen plan for an alert:
   * - the cutoff is ALWAYS the alert's original triggeredAt, so historical
   *   generation and retries reproduce the same immutable dataset;
   * - a READY plan is returned as-is (frozen — regeneration is pointless);
   * - data-layer failures are recorded as status ERROR on the plan and
   *   returned, never thrown — a failed plan must not break anything else.
   */
  async generateForAlert(alertId: string): Promise<ExtremeRRPlanDto> {
    const alert = await this.getAlertOrThrow(alertId);
    // TradingView and Native alike: one planner, one formula, one cutoff rule.
    // A NATIVE plan is planning only — it never carries the fan-out marker
    // (below), and every execution path refuses it by source.
    const native = alert.source === NATIVE_ALERT_SOURCE;
    const alertSource = planAlertSourceOf(alert.source);
    const direction = ExtremeRRService.assertDirectional(alert);

    const existing = await this.prisma.extremeRRPlan.findUnique({
      where: { alertId },
      include: PLAN_OUTCOME_INCLUDE,
    });
    if (existing?.status === "READY") {
      return this.serialize(existing, alertSource);
    }

    const cutoff = alert.triggeredAt;
    const entryPrice = String(alert.price);
    const marketType = extremeRRMarketTypeOf(alert);

    // Snapshot the ACTIVE template at generation time. Later template edits
    // never touch this plan; explicit regeneration re-snapshots by design.
    const activeTemplate = await this.riskTemplates.findActive();
    const templateSnapshot = activeTemplate
      ? {
          riskTemplateId: activeTemplate.id,
          templateName: activeTemplate.name,
          referenceCapital: String(activeTemplate.referenceCapital),
          riskPercent: String(activeTemplate.riskPercent),
          rewardRatio: String(activeTemplate.rewardRatio),
          ...calculateRiskTemplateAmounts(
            String(activeTemplate.referenceCapital),
            String(activeTemplate.riskPercent),
            String(activeTemplate.rewardRatio)
          ),
        }
      : null;

    const baseData = {
      status: "PENDING" as const,
      direction,
      entryBasis: "ALERT_PRICE",
      entryPrice,
      cutoffAt: cutoff,
      timeframe: alert.timeframe,
      marketType,
      riskTemplateId: templateSnapshot?.riskTemplateId ?? null,
      templateName: templateSnapshot?.templateName ?? null,
      referenceCapital: templateSnapshot?.referenceCapital ?? null,
      riskPercent: templateSnapshot?.riskPercent ?? null,
      rewardRatio: templateSnapshot?.rewardRatio ?? null,
      riskAmount: templateSnapshot?.riskAmount ?? null,
      targetAmount: templateSnapshot?.targetAmount ?? null,
    };

    try {
      // Inside the try on purpose: an invalid persisted policy is recorded as
      // a plan ERROR with its reason, exactly as a data-layer failure is, so
      // nothing is planned on a fallback nobody chose.
      const initialLookback = await this.resolveLookback();
      // The canonical entry is the alert price: never a current price, never a fallback.
      if (!Number.isFinite(alert.price) || alert.price <= 0) {
        throw new Error(`The alert has no usable canonical entry price (${String(alert.price)})`);
      }
      const candles = await this.fetchCandles(alert, cutoff, Math.max(...EXTREME_RR_LOOKBACKS));
      const candidates = buildCandidates(
        candles,
        direction,
        entryPrice,
        templateSnapshot?.rewardRatio ?? null,
        cutoff
      );

      const status: ExtremeRRPlanStatus = candidates.some((candidate) => candidate.valid)
        ? "READY"
        : "INVALID";

      // Phase 11E -- the generic fanout eligibility marker.
      //
      // Written in the SAME durable transition that makes the plan READY, so
      // a plan is never executable-looking for a moment before it is marked,
      // and never marked without being READY. INVALID gets null explicitly:
      // a plan that regenerates from READY-looking to INVALID must not keep
      // an eligibility it no longer earns.
      //
      // Every plan that reached READY BEFORE this code existed keeps null
      // forever, because generateForAlert returns an existing READY plan
      // untouched (above) rather than regenerating it. That is the rollout
      // fence: those plans were already evaluated once, under an
      // architecture with nowhere to record that they had been.
      //
      // A NATIVE plan never gets it, READY or not: planning visibility is not
      // execution eligibility.
      const executionFanoutReadyAt = status === "READY" && !native ? new Date() : null;

      const saved = await this.prisma.extremeRRPlan.upsert({
        where: { alertId },
        create: {
          alertId,
          ...baseData,
          status,
          candidates: candidates as object[],
          errorReason: null,
          generatedAt: new Date(),
          executionFanoutReadyAt,
          // Only on CREATE. The update branch below deliberately omits
          // selectedLookback so regenerating an existing plan preserves the
          // choice that plan was made under.
          selectedLookback: initialLookback,
        },
        update: {
          ...baseData,
          status,
          candidates: candidates as object[],
          errorReason: null,
          generatedAt: new Date(),
          executionFanoutReadyAt,
          // Regeneration produces a new outcome — reset the Telegram cycle so
          // the new result may notify once. (READY plans never reach here;
          // they short-circuit above, so a sent notification stays sent.)
          telegramStatus: null,
          telegramNotifiedAt: null,
          telegramLastError: null,
        },
        include: PLAN_OUTCOME_INCLUDE,
      });
      return this.serialize(saved, alertSource);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ alertId, error: message }, "Extreme RR plan generation failed");

      const saved = await this.prisma.extremeRRPlan.upsert({
        where: { alertId },
        create: {
          alertId,
          ...baseData,
          status: "ERROR",
          errorReason: message,
          // An ERROR plan is not eligible for account fanout, ever.
          executionFanoutReadyAt: null,
        },
        update: {
          ...baseData,
          status: "ERROR",
          errorReason: message,
          executionFanoutReadyAt: null,
          // Same reset as the success path: a regenerated outcome starts a
          // fresh (single) notification cycle.
          telegramStatus: null,
          telegramNotifiedAt: null,
          telegramLastError: null,
        },
        include: PLAN_OUTCOME_INCLUDE,
      });
      return this.serialize(saved, alertSource);
    }
  }

  /** Plan for the alert, or null when none exists (e.g. pre-feature alerts). */
  async getForAlert(alertId: string): Promise<ExtremeRRPlanDto | null> {
    const alert = await this.getAlertOrThrow(alertId);
    const plan = await this.prisma.extremeRRPlan.findUnique({
      where: { alertId },
      include: PLAN_OUTCOME_INCLUDE,
    });
    return plan ? this.serialize(plan, planAlertSourceOf(alert.source)) : null;
  }

  /**
   * The most recently updated Native plans, each as its selected, frozen
   * summary plus each account's DEFAULT-lookback preview. READ ONLY: it
   * generates nothing and writes nothing (no plan, no selection, no adoption),
   * and every item says NATIVE_PLAN_EXECUTION_STATUS.
   */
  async listNativePlans(
    limit: number = NATIVE_PLAN_LIST_LIMIT.default,
    policies?: readonly NativeAccountPlanPolicy[],
    // Read-only scanner evidence for each item's execution-integrity line; none = UNREADABLE (never eligible).
    integrityEvidence: NativeScannerEvidenceReader | null = null
  ): Promise<NativePlanListDto> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > NATIVE_PLAN_LIST_LIMIT.max) {
      throw new ValidationError(`limit must be an integer 1..${NATIVE_PLAN_LIST_LIMIT.max}`);
    }
    const accountPolicies = [...(policies ?? (await configuredNativeAccountPlanPolicies()))];
    const plans = await this.prisma.extremeRRPlan.findMany({
      where: { alert: { source: NATIVE_ALERT_SOURCE } },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: limit,
      include: { ...PLAN_OUTCOME_INCLUDE, alert: { select: { source: true, symbol: true, sourceTimeframe: true, triggeredAt: true, rawPayload: true } } },
    });
    return {
      nativeExecutionEnabled: false,
      accountPolicies,
      items: plans.map((plan) => this.nativePlanItemOf(plan, accountPolicies, nativeExecutionIntegrityOf(plan.alert, integrityEvidence))),
    };
  }

  /**
   * One PAGE of Native plans for Trading Control's table: search and filters
   * in the database, newest trigger first, keyset-paged, with plan-status
   * counts over the whole data set and over the filtered set. READ ONLY,
   * exactly like listNativePlans: it generates, selects, adopts and writes
   * nothing, and every item still says NATIVE_PLAN_EXECUTION_STATUS.
   *
   * Integrity is rebuilt from scanner files for the plans on the page only.
   * With the integrity filter, plans are judged newest first until the page is
   * full or NATIVE_PLAN_INTEGRITY_SCAN_LIMIT plans were judged; the response
   * says how many were, and its next cursor resumes from the last one.
   */
  async listNativePlanPage(
    query: NativePlanPageQuery,
    policies?: readonly NativeAccountPlanPolicy[],
    integrityEvidence: NativeScannerEvidenceReader | null = null
  ): Promise<NativePlanPageDto> {
    const pageSize = query.pageSize ?? NATIVE_PLAN_PAGE_DEFAULT_SIZE;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > NATIVE_PLAN_PAGE_MAX_SIZE) {
      throw new ValidationError(`pageSize must be an integer 1..${NATIVE_PLAN_PAGE_MAX_SIZE}`);
    }
    const start = query.cursor === undefined ? null : decodeNativePlanCursor(query.cursor);
    const accountPolicies = [...(policies ?? (await configuredNativeAccountPlanPolicies()))];
    const filtered = nativePlanFilterWhere(query);
    const after = (position: NativePlanCursor | null): Prisma.ExtremeRRPlanWhereInput =>
      position === null ? filtered : { AND: [filtered, olderThan(position)] };
    const read = (position: NativePlanCursor | null, take: number): Promise<NativePlanRow[]> =>
      this.prisma.extremeRRPlan.findMany({ where: after(position), orderBy: NATIVE_PLAN_PAGE_ORDER, take, include: { alert: NATIVE_PLAN_ALERT_FIELDS } });
    const reader = integrityEvidence === null ? null : readEachLaneOnce(integrityEvidence);
    const judge = (plan: NativePlanRow): NativeExecutionIntegrityDto => nativeExecutionIntegrityOf(plan.alert, reader);

    const [allNativePlans, matchingFilters] = await Promise.all([
      this.nativePlanStatusCounts(NATIVE_PLANS_ONLY),
      this.nativePlanStatusCounts(filtered),
    ]);

    const page: Array<{ plan: NativePlanRow; integrity: NativeExecutionIntegrityDto }> = [];
    let last: NativePlanCursor | null = null;
    let hasMore: boolean;
    let integrityScan: NativePlanIntegrityScan | null = null;

    if (query.integrity === undefined) {
      const rows = await read(start, pageSize + 1);
      hasMore = rows.length > pageSize;
      for (const plan of rows.slice(0, pageSize)) {
        if (page.length > 0 && page.length % NATIVE_PLAN_JUDGEMENTS_PER_TURN === 0) await nextTurn();
        page.push({ plan, integrity: judge(plan) });
      }
      last = page.length > 0 ? positionOf(page[page.length - 1].plan) : null;
    } else {
      const wanted = query.integrity;
      let scanned = 0;
      let position = start;
      let reachedEnd = false;
      scan: while (scanned < NATIVE_PLAN_INTEGRITY_SCAN_LIMIT) {
        const take = Math.min(NATIVE_PLAN_SCAN_CHUNK, NATIVE_PLAN_INTEGRITY_SCAN_LIMIT - scanned);
        const rows = await read(position, take);
        for (const plan of rows) {
          if (scanned > 0 && scanned % NATIVE_PLAN_JUDGEMENTS_PER_TURN === 0) await nextTurn();
          scanned += 1;
          position = positionOf(plan);
          const integrity = judge(plan);
          if (nativeIntegrityMatches(wanted, integrity.status)) {
            page.push({ plan, integrity });
            if (page.length === pageSize) break scan;
          }
        }
        if (rows.length < take) {
          reachedEnd = true;
          break;
        }
      }
      hasMore =
        !reachedEnd &&
        position !== null &&
        (await this.prisma.extremeRRPlan.findFirst({ where: after(position), orderBy: NATIVE_PLAN_PAGE_ORDER, select: { id: true } })) !== null;
      last = position;
      integrityScan = { scanned, limit: NATIVE_PLAN_INTEGRITY_SCAN_LIMIT, exhausted: !hasMore };
    }

    return {
      nativeExecutionEnabled: false,
      accountPolicies,
      items: page.map(({ plan, integrity }) => this.nativePlanItemOf(plan, accountPolicies, integrity)),
      pagination: {
        order: "TRIGGERED_AT_DESC",
        pageSize,
        cursor: query.cursor ?? null,
        nextCursor: hasMore && last !== null ? encodeNativePlanCursor(last) : null,
        hasMore,
        totalMatching: query.integrity === undefined ? matchingFilters.total : null,
        integrityScan,
      },
      summary: { allNativePlans, matchingFilters },
    };
  }

  /** Every plan status present as a key (0 when none), counted in the database. */
  private async nativePlanStatusCounts(where: Prisma.ExtremeRRPlanWhereInput): Promise<NativePlanStatusCounts> {
    const groups = await this.prisma.extremeRRPlan.groupBy({ by: ["status"], where, _count: { _all: true } });
    const byPlanStatus = Object.fromEntries(EXTREME_RR_STATUSES.map((status) => [status, 0])) as Record<ExtremeRRPlanStatus, number>;
    let total = 0;
    for (const group of groups) {
      byPlanStatus[group.status] = group._count._all;
      total += group._count._all;
    }
    return { total, byPlanStatus };
  }

  /** One list item, identical for the original list and for a page. */
  private nativePlanItemOf(
    plan: NativePlanRow,
    accountPolicies: readonly NativeAccountPlanPolicy[],
    executionIntegrity: NativeExecutionIntegrityDto
  ): NativePlanListItemDto {
    const dto = this.serialize(plan, planAlertSourceOf(plan.alert.source));
    return {
      alertId: plan.alertId,
      symbol: plan.alert.symbol,
      sourceTimeframe: plan.alert.sourceTimeframe,
      triggeredAt: plan.alert.triggeredAt.toISOString(),
      plan: selectedPlanSummaryOf(dto),
      availableLookbacks: dto.status === "READY" ? dto.candidates.filter((c) => c.valid).map((c) => c.requestedCandles) : [],
      // Each account from its OWN policy; the plan's global selectedLookback is not consulted.
      accountDefaults: accountPolicies.map((policy) => previewNativeAccountPlan(dto, policy)),
      executionIntegrity,
    };
  }

  /** Persists the lookback/leverage selection (the only client-writable fields). */
  async updateSelection(alertId: string, input: ExtremeRRSelectionInput): Promise<ExtremeRRPlanDto> {
    const alert = await this.getAlertOrThrow(alertId);
    const plan = await this.prisma.extremeRRPlan.findUnique({ where: { alertId } });
    if (!plan) throw new NotFoundError(`No Extreme RR plan exists for alert ${alertId}`);

    const updated = await this.prisma.extremeRRPlan.update({
      where: { alertId },
      data: {
        ...(input.selectedLookback !== undefined ? { selectedLookback: input.selectedLookback } : {}),
        ...(input.selectedLeverage !== undefined ? { selectedLeverage: input.selectedLeverage } : {}),
      },
      include: PLAN_OUTCOME_INCLUDE,
    });
    return this.serialize(updated, planAlertSourceOf(alert.source));
  }

  /**
   * Serializes a stored plan: frozen fields pass through as exact strings and
   * money management (quantity, planned PnL, notional, margin per leverage
   * preset) is recomputed from those frozen fields on every read — never
   * stored, never client-supplied, never derived from an account balance.
   */
  /**
   * A stored plan, optionally with its recorded execution verdict.
   *
   * The relation is optional so a query that does not ask for it still type
   * checks and simply reports no outcome — which is the truthful answer for a
   * plan whose executor never ran.
   */
  private serialize(plan: PlanWithOutcome, alertSource: ExtremeRRPlanDto["alertSource"]): ExtremeRRPlanDto {
    const riskAmount = decimalToString(plan.riskAmount);
    const template: ExtremeRRTemplateSnapshot | null = plan.templateName
      ? {
          riskTemplateId: plan.riskTemplateId,
          name: plan.templateName,
          referenceCapital: decimalToString(plan.referenceCapital) ?? "0",
          riskPercent: decimalToString(plan.riskPercent) ?? "0",
          rewardRatio: decimalToString(plan.rewardRatio) ?? "0",
          riskAmount: riskAmount ?? "0",
          targetAmount: decimalToString(plan.targetAmount) ?? "0",
        }
      : null;

    // Canonical. One entry per profile that FINISHED evaluating this plan,
    // and two accounts disagreeing is a correct result rather than a
    // conflict, so nothing here merges or ranks them.
    const accountOutcomes: SelectedPlanAccountOutcomeDto[] = (plan.selectedPlanAdoptions ?? []).map(
      (adoption) => ({
        executionProfileId: adoption.executionProfileId,
        // Nullable in the row only because it is unset while a claim is
        // PENDING; a COMPLETED row always carries it, and only COMPLETED rows
        // are fetched.
        handled: adoption.handled ?? false,
        reasonCode: adoption.reasonCode,
        message: adoption.message,
        executionId: adoption.executionId,
        evaluatedAt: (adoption.evaluatedAt ?? adoption.updatedAt).toISOString(),
      })
    );

    const stored = (plan.candidates as unknown as StoredCandidate[] | null) ?? [];
    const entryPrice = decimalToString(plan.entryPrice) ?? "0";

    const candidates: ExtremeRRCandidate[] = stored.map((candidate) => {
      if (!candidate.valid || !candidate.riskDistance || !candidate.rewardDistance || riskAmount === null) {
        return { ...candidate, money: null };
      }
      const money = calculateExtremeMoney({
        entryPrice,
        riskDistance: candidate.riskDistance,
        rewardDistance: candidate.rewardDistance,
        riskAmount,
      });
      return {
        ...candidate,
        money: { ...money, leverage: buildLeverageAnalysis(money.positionNotionalRaw, riskAmount) },
      };
    });

    return {
      id: plan.id,
      alertId: plan.alertId,
      alertSource,
      status: plan.status,
      direction: plan.direction as "LONG" | "SHORT",
      entryBasis: "ALERT_PRICE",
      entryPrice,
      cutoffAt: plan.cutoffAt.toISOString(),
      timeframe: plan.timeframe,
      template,
      candidates,
      selectedLookback: plan.selectedLookback as ExtremeRRLookback,
      selectedLeverage: (plan.selectedLeverage as ExtremeRRLeverage | null) ?? null,
      precision: "UNROUNDED",
      leverageLimitVerified: false,
      errorReason: plan.errorReason,
      // Historical evidence, passed through verbatim. Deliberately NOT derived
      // from anything current: the whole point is that a plan refused at 12:00
      // still says why at 15:00, whatever the system looks like by then.
      executionOutcomes: accountOutcomes,
      executionOutcome: projectSingularOutcome(accountOutcomes, plan.selectedPlanOutcome ?? null),
      generatedAt: plan.generatedAt?.toISOString() ?? null,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    };
  }
}
