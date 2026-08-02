import type { Alert, ExtremeRRPlan, PrismaClient } from "@prisma/client";
import {
  EXTREME_RR_DEFAULT_LOOKBACK,
  EXTREME_RR_LOOKBACKS,
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

export class ExtremeRRService {
  private readonly riskTemplates: RiskTemplateRepository;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly fetchCandles: SnapshotCandleFetcher = defaultCandleFetcher
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
        selectedLookback: EXTREME_RR_DEFAULT_LOOKBACK,
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

    const existing = await this.prisma.extremeRRPlan.findUnique({ where: { alertId } });
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
        },
        update: {
          ...baseData,
          status,
          candidates: candidates as object[],
          errorReason: null,
          generatedAt: new Date(),
        },
      });
      return this.serialize(saved);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ alertId, error: message }, "Extreme RR plan generation failed");

      const saved = await this.prisma.extremeRRPlan.upsert({
        where: { alertId },
        create: { alertId, ...baseData, status: "ERROR", errorReason: message },
        update: { ...baseData, status: "ERROR", errorReason: message },
      });
      return this.serialize(saved);
    }
  }

  /** Plan for the alert, or null when none exists (e.g. pre-feature alerts). */
  async getForAlert(alertId: string): Promise<ExtremeRRPlanDto | null> {
    await this.getAlertOrThrow(alertId);
    const plan = await this.prisma.extremeRRPlan.findUnique({ where: { alertId } });
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
    });
    return this.serialize(updated);
  }

  /**
   * Serializes a stored plan: frozen fields pass through as exact strings and
   * money management (quantity, planned PnL, notional, margin per leverage
   * preset) is recomputed from those frozen fields on every read — never
   * stored, never client-supplied, never derived from an account balance.
   */
  private serialize(plan: ExtremeRRPlan): ExtremeRRPlanDto {
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
      generatedAt: plan.generatedAt?.toISOString() ?? null,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    };
  }
}
