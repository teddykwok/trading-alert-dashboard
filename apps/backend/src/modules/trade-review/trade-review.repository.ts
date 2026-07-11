import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Thin data-access layer over Prisma for trade reviews, mirroring
 * alerts.repository.ts: raw query-object construction lives here so the
 * service stays focused on business rules.
 */
export class TradeReviewRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findAlertById(alertId: string) {
    return this.prisma.alert.findUnique({ where: { id: alertId }, select: { id: true } });
  }

  findByAlertId(alertId: string) {
    return this.prisma.tradeReview.findUnique({ where: { alertId } });
  }

  upsert(
    alertId: string,
    create: Omit<Prisma.TradeReviewUncheckedCreateInput, "alertId">,
    update: Prisma.TradeReviewUncheckedUpdateInput
  ) {
    return this.prisma.tradeReview.upsert({
      where: { alertId },
      create: { alertId, ...create },
      update,
    });
  }

  countByStatus(alertWhere: Prisma.AlertWhereInput) {
    return this.prisma.tradeReview.groupBy({
      by: ["status"],
      _count: { _all: true },
      where: { alert: alertWhere },
    });
  }

  countAlerts(alertWhere: Prisma.AlertWhereInput) {
    return this.prisma.alert.count({ where: alertWhere });
  }
}
