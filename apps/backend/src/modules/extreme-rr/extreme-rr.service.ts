import type { Alert, ExtremeRRPlan, PrismaClient, SelectedPlanOutcome } from "@prisma/client";
import {
  EXTREME_RR_DEFAULT_LOOKBACK,
  EXTREME_RR_LOOKBACKS,
  isExtremeRRLookback,
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
} from "@trading-alert-dashboard/shared";
import { getClosedCandlesBefore } from "../market-data/market-data.service";
import type { SnapshotCandle } from "../market-data/market-data.types";
import { RiskTemplateRepository } from "../risk-template/risk-template.repository";
import { inferMarketType } from "../../utils/symbol";
import { NotFoundError, ValidationError } from "../../utils/errors";
import {
  configuredProfileIdentity,
  resolveExecutionProfile,
} from "../execution/execution-profile.service";
import { logger } from "../../config/logger";
import type { ExtremeRRSelectionInput } from "./extreme-rr.schema";

/**
 * Injectable so tests can freeze the candle dataset. The default fetcher uses
 * real Binance data only (never mock candles) with the alert's triggeredAt as
 * the immutable cutoff.
 */
export type SnapshotCandleFetcher = (alert: Alert, cutoff: Date, limit: number) => Promise<SnapshotCandle[]>;

const defaultCandleFetcher: SnapshotCandleFetcher = (alert, cutoff, limit) => {
  const rawPayloadSymbol = (alert.rawPayload as { symbol?: unknown } | null)?.symbol;
  const marketType = inferMarketType(rawPayloadSymbol ?? alert.symbol);
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
 * Read from the operator's durable policy on the configured execution
 * profile — the same single profile every other operator policy resolves to,
 * so there is no ambiguity about which one governs a plan.
 *
 * Two deliberate behaviours:
 *
 *   - a profile or policy that cannot be resolved yields the shipped default,
 *     because that is genuinely the pre-feature behaviour and an unconfigured
 *     system planned at 300 before this column existed;
 *   - a policy row that HOLDS an unsupported number THROWS. It is invalid
 *     configuration, not a request to fall back, and quietly planning at 300
 *     would build a trade from a window the operator never chose. Both
 *     callers already treat a throw as a recorded, non-fatal failure, so the
 *     alert still ingests and nothing is planned on a guess.
 */
export type InitialLookbackResolver = () => Promise<ExtremeRRLookback>;

export async function resolveInitialLookback(prisma: PrismaClient): Promise<ExtremeRRLookback> {
  let stored: unknown;
  try {
    const resolution = await resolveExecutionProfile(prisma, configuredProfileIdentity());
    // No profile, or no policy row, is the PRE-FEATURE situation: nothing has
    // ever expressed a preference, and the system planned at 300 before this
    // column existed. Being unable to READ is not the same as holding a value
    // nobody recognises, and only the latter is a misconfiguration.
    if (!resolution.ok) return EXTREME_RR_DEFAULT_LOOKBACK;
    stored = resolution.profile.safetyPolicy?.extremeRrLookbackCandles;
  } catch {
    return EXTREME_RR_DEFAULT_LOOKBACK;
  }
  if (stored === undefined || stored === null) return EXTREME_RR_DEFAULT_LOOKBACK;
  if (!isExtremeRRLookback(stored)) {
    // Invalid configuration. Refusing here is the whole point: quietly using
    // 300 would build a trade from a window the operator never chose, and both
    // callers already record a throw as a non-fatal, visible failure.
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

type PlanWithOutcome = ExtremeRRPlan & { selectedPlanOutcome?: SelectedPlanOutcome | null };

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
    private readonly resolveLookback: InitialLookbackResolver = () => resolveInitialLookback(prisma)
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
    const direction = ExtremeRRService.assertDirectional(alert);

    const existing = await this.prisma.extremeRRPlan.findUnique({
      where: { alertId },
      include: { selectedPlanOutcome: true },
    });
    if (existing?.status === "READY") {
      return this.serialize(existing);
    }

    const cutoff = alert.triggeredAt;
    const entryPrice = String(alert.price);
    const rawPayloadSymbol = (alert.rawPayload as { symbol?: unknown } | null)?.symbol;
    const marketType = inferMarketType(rawPayloadSymbol ?? alert.symbol);

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

      const saved = await this.prisma.extremeRRPlan.upsert({
        where: { alertId },
        create: {
          alertId,
          ...baseData,
          status,
          candidates: candidates as object[],
          errorReason: null,
          generatedAt: new Date(),
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
          // Regeneration produces a new outcome — reset the Telegram cycle so
          // the new result may notify once. (READY plans never reach here;
          // they short-circuit above, so a sent notification stays sent.)
          telegramStatus: null,
          telegramNotifiedAt: null,
          telegramLastError: null,
        },
        include: { selectedPlanOutcome: true },
      });
      return this.serialize(saved);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ alertId, error: message }, "Extreme RR plan generation failed");

      const saved = await this.prisma.extremeRRPlan.upsert({
        where: { alertId },
        create: { alertId, ...baseData, status: "ERROR", errorReason: message },
        update: {
          ...baseData,
          status: "ERROR",
          errorReason: message,
          // Same reset as the success path: a regenerated outcome starts a
          // fresh (single) notification cycle.
          telegramStatus: null,
          telegramNotifiedAt: null,
          telegramLastError: null,
        },
        include: { selectedPlanOutcome: true },
      });
      return this.serialize(saved);
    }
  }

  /** Plan for the alert, or null when none exists (e.g. pre-feature alerts). */
  async getForAlert(alertId: string): Promise<ExtremeRRPlanDto | null> {
    await this.getAlertOrThrow(alertId);
    const plan = await this.prisma.extremeRRPlan.findUnique({
      where: { alertId },
      include: { selectedPlanOutcome: true },
    });
    return plan ? this.serialize(plan) : null;
  }

  /** Persists the lookback/leverage selection (the only client-writable fields). */
  async updateSelection(alertId: string, input: ExtremeRRSelectionInput): Promise<ExtremeRRPlanDto> {
    await this.getAlertOrThrow(alertId);
    const plan = await this.prisma.extremeRRPlan.findUnique({ where: { alertId } });
    if (!plan) throw new NotFoundError(`No Extreme RR plan exists for alert ${alertId}`);

    const updated = await this.prisma.extremeRRPlan.update({
      where: { alertId },
      data: {
        ...(input.selectedLookback !== undefined ? { selectedLookback: input.selectedLookback } : {}),
        ...(input.selectedLeverage !== undefined ? { selectedLeverage: input.selectedLeverage } : {}),
      },
      include: { selectedPlanOutcome: true },
    });
    return this.serialize(updated);
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
  private serialize(plan: PlanWithOutcome): ExtremeRRPlanDto {
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
      executionOutcome: plan.selectedPlanOutcome
        ? {
            handled: plan.selectedPlanOutcome.handled,
            reasonCode: plan.selectedPlanOutcome.reasonCode,
            message: plan.selectedPlanOutcome.message,
            executionId: plan.selectedPlanOutcome.executionId,
            evaluatedAt: plan.selectedPlanOutcome.evaluatedAt.toISOString(),
          }
        : null,
      generatedAt: plan.generatedAt?.toISOString() ?? null,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    };
  }
}
