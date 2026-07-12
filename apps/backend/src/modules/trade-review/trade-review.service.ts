import type { Prisma, PrismaClient, SignalType, TradeReview, TradeReviewStatus } from "@prisma/client";
import {
  calculateFuturesRiskPlan,
  NON_DIRECTIONAL_PLAN_MESSAGE,
  type TradeMarginMode,
  type TradeReviewStats,
} from "@trading-alert-dashboard/shared";
import { TradeReviewRepository } from "./trade-review.repository";
import { NotFoundError } from "../../utils/errors";
import type { TradeReviewStatsQuery, TradeReviewUpsertInput } from "./trade-review.schema";

export interface ReviewTimestamps {
  openedAt: Date | null;
  closedAt: Date | null;
}

/**
 * Predictable execution timestamps per status transition:
 * - OPEN: openedAt is set once (kept on re-marking), closedAt is cleared —
 *   re-opening a closed trade means it is no longer closed.
 * - WIN / LOSS / BREAKEVEN: openedAt and closedAt are set if missing; a
 *   correction between final statuses (e.g. WIN -> LOSS) keeps the original
 *   timestamps rather than shifting them to "now".
 * - IGNORED / UNREVIEWED: no trade was executed, so execution timestamps are
 *   cleared. Prices and notes are never touched by status changes.
 */
export function resolveReviewTimestamps(
  status: TradeReviewStatus,
  existing: ReviewTimestamps,
  now: Date
): ReviewTimestamps {
  switch (status) {
    case "OPEN":
      return { openedAt: existing.openedAt ?? now, closedAt: null };
    case "WIN":
    case "LOSS":
    case "BREAKEVEN":
      return { openedAt: existing.openedAt ?? now, closedAt: existing.closedAt ?? now };
    case "IGNORED":
    case "UNREVIEWED":
      return { openedAt: null, closedAt: null };
  }
}

/** The shape returned when an alert has never been reviewed. */
export function defaultTradeReview(alertId: string) {
  return {
    id: null,
    alertId,
    status: "UNREVIEWED" as TradeReviewStatus,
    entryPrice: null,
    exitPrice: null,
    notes: null,
    openedAt: null,
    closedAt: null,
    stopLossPrice: null,
    takeProfitPrice: null,
    accountBalance: null,
    riskPercent: null,
    leverage: null,
    marginMode: null,
    liquidationPrice: null,
    createdAt: null,
    updatedAt: null,
  };
}

type StoredReview = TradeReview | ReturnType<typeof defaultTradeReview>;

function decimalToString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Recomputes the futures risk plan from the stored INPUTS on every read.
 * Direction comes exclusively from Alert.signal — never from AI output,
 * notes, or touch metadata. WATCH/EXIT alerts can store plan inputs but get
 * an explanatory message instead of a directional calculation. A null
 * marginMode is treated as ISOLATED for planning (the conservative default).
 */
function withRiskPlan<T extends StoredReview>(review: T, signal: SignalType | undefined) {
  const directional = signal === "LONG" || signal === "SHORT";

  if (!directional) {
    return { ...review, futuresRiskPlan: null, futuresRiskPlanMessage: NON_DIRECTIONAL_PLAN_MESSAGE };
  }

  const entryPrice = decimalToString(review.entryPrice);
  const stopLossPrice = decimalToString(review.stopLossPrice);
  const takeProfitPrice = decimalToString(review.takeProfitPrice);
  const accountBalance = decimalToString(review.accountBalance);
  const riskPercent = decimalToString(review.riskPercent);
  const leverage = decimalToString(review.leverage);

  const hasAllInputs =
    entryPrice && stopLossPrice && takeProfitPrice && accountBalance && riskPercent && leverage;

  if (!hasAllInputs) {
    return { ...review, futuresRiskPlan: null, futuresRiskPlanMessage: null };
  }

  const plan = calculateFuturesRiskPlan({
    direction: signal,
    entryPrice,
    stopLossPrice,
    takeProfitPrice,
    accountBalance,
    riskPercent,
    leverage,
    marginMode: (review.marginMode ?? "ISOLATED") as TradeMarginMode,
    liquidationPrice: decimalToString(review.liquidationPrice),
  });

  return { ...review, futuresRiskPlan: plan, futuresRiskPlanMessage: null };
}

export class TradeReviewService {
  private readonly repository: TradeReviewRepository;

  constructor(prisma: PrismaClient) {
    this.repository = new TradeReviewRepository(prisma);
  }

  private async getAlertOrThrow(alertId: string) {
    const alert = await this.repository.findAlertById(alertId);
    if (!alert) throw new NotFoundError(`Alert ${alertId} not found`);
    return alert;
  }

  async getForAlert(alertId: string) {
    const alert = await this.getAlertOrThrow(alertId);
    const review = await this.repository.findByAlertId(alertId);
    return withRiskPlan(review ?? defaultTradeReview(alertId), alert.signal);
  }

  /**
   * Upserts the review for an alert. Only fields present in the input are
   * written: `undefined` leaves a field untouched, an explicit `null` clears
   * it. Prices arrive as decimal-safe strings (preferred) or numbers and are
   * passed to Prisma's Decimal without float round-tripping. Derived plan
   * values are computed on the response, never persisted.
   */
  async upsertForAlert(alertId: string, input: TradeReviewUpsertInput) {
    const alert = await this.getAlertOrThrow(alertId);
    const existing = await this.repository.findByAlertId(alertId);

    const changes: Prisma.TradeReviewUncheckedUpdateInput = {};

    if (input.status !== undefined) {
      const timestamps = resolveReviewTimestamps(
        input.status,
        { openedAt: existing?.openedAt ?? null, closedAt: existing?.closedAt ?? null },
        new Date()
      );
      changes.status = input.status;
      changes.openedAt = timestamps.openedAt;
      changes.closedAt = timestamps.closedAt;
    }

    if (input.entryPrice !== undefined) changes.entryPrice = input.entryPrice;
    if (input.exitPrice !== undefined) changes.exitPrice = input.exitPrice;
    if (input.notes !== undefined) changes.notes = input.notes;
    if (input.stopLossPrice !== undefined) changes.stopLossPrice = input.stopLossPrice;
    if (input.takeProfitPrice !== undefined) changes.takeProfitPrice = input.takeProfitPrice;
    if (input.accountBalance !== undefined) changes.accountBalance = input.accountBalance;
    if (input.riskPercent !== undefined) changes.riskPercent = input.riskPercent;
    if (input.leverage !== undefined) changes.leverage = input.leverage;
    if (input.marginMode !== undefined) changes.marginMode = input.marginMode;
    if (input.liquidationPrice !== undefined) changes.liquidationPrice = input.liquidationPrice;

    const saved = await this.repository.upsert(
      alertId,
      changes as Omit<Prisma.TradeReviewUncheckedCreateInput, "alertId">,
      changes
    );

    return withRiskPlan(saved, alert.signal);
  }

  async stats(query: TradeReviewStatsQuery): Promise<TradeReviewStats> {
    const alertWhere: Prisma.AlertWhereInput = {
      symbol: query.symbol,
      timeframe: query.timeframe,
      signal: query.signal,
      createdAt:
        query.dateFrom || query.dateTo
          ? { gte: query.dateFrom, lte: query.dateTo }
          : undefined,
    };

    const [groups, totalAlerts] = await Promise.all([
      this.repository.countByStatus(alertWhere),
      this.repository.countAlerts(alertWhere),
    ]);

    const counts: Record<TradeReviewStatus, number> = {
      UNREVIEWED: 0,
      IGNORED: 0,
      OPEN: 0,
      WIN: 0,
      LOSS: 0,
      BREAKEVEN: 0,
    };
    for (const group of groups) {
      counts[group.status] = group._count._all;
    }

    const totalReviewed =
      counts.IGNORED + counts.OPEN + counts.WIN + counts.LOSS + counts.BREAKEVEN;
    const decisiveTrades = counts.WIN + counts.LOSS;

    return {
      totalReviewed,
      // Alerts with no review row at all, plus reviews reset to UNREVIEWED.
      unreviewedAlerts: Math.max(0, totalAlerts - totalReviewed),
      ignored: counts.IGNORED,
      open: counts.OPEN,
      wins: counts.WIN,
      losses: counts.LOSS,
      breakeven: counts.BREAKEVEN,
      decisiveTrades,
      winRate: decisiveTrades === 0 ? null : (counts.WIN / decisiveTrades) * 100,
    };
  }
}
