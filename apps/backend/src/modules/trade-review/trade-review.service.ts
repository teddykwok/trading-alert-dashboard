import type { Prisma, PrismaClient, TradeReview, TradeReviewStatus } from "@prisma/client";
import type { TradeReviewStats } from "@trading-alert-dashboard/shared";
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
    createdAt: null,
    updatedAt: null,
  };
}

export class TradeReviewService {
  private readonly repository: TradeReviewRepository;

  constructor(prisma: PrismaClient) {
    this.repository = new TradeReviewRepository(prisma);
  }

  private async ensureAlertExists(alertId: string): Promise<void> {
    const alert = await this.repository.findAlertById(alertId);
    if (!alert) throw new NotFoundError(`Alert ${alertId} not found`);
  }

  async getForAlert(alertId: string): Promise<TradeReview | ReturnType<typeof defaultTradeReview>> {
    await this.ensureAlertExists(alertId);
    const review = await this.repository.findByAlertId(alertId);
    return review ?? defaultTradeReview(alertId);
  }

  /**
   * Upserts the review for an alert. Only fields present in the input are
   * written: `undefined` leaves a field untouched, an explicit `null` clears
   * it. Prices arrive as decimal-safe strings (preferred) or numbers and are
   * passed to Prisma's Decimal without float round-tripping.
   */
  async upsertForAlert(alertId: string, input: TradeReviewUpsertInput): Promise<TradeReview> {
    await this.ensureAlertExists(alertId);
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

    return this.repository.upsert(
      alertId,
      changes as Omit<Prisma.TradeReviewUncheckedCreateInput, "alertId">,
      changes
    );
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
