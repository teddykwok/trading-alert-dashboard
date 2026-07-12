import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Thin data-access layer over Prisma for trade journals, mirroring
 * trade-review.repository.ts.
 */
export class TradeJournalRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findAlertById(alertId: string) {
    return this.prisma.alert.findUnique({
      where: { id: alertId },
      select: { id: true },
    });
  }

  findByAlertId(alertId: string) {
    return this.prisma.tradeJournal.findUnique({ where: { alertId } });
  }

  upsert(
    alertId: string,
    create: Omit<Prisma.TradeJournalUncheckedCreateInput, "alertId">,
    update: Prisma.TradeJournalUncheckedUpdateInput
  ) {
    return this.prisma.tradeJournal.upsert({
      where: { alertId },
      create: { alertId, ...create },
      update,
    });
  }

  count(where: Prisma.TradeJournalWhereInput = {}) {
    return this.prisma.tradeJournal.count({ where });
  }

  countByEmotion() {
    return this.prisma.tradeJournal.groupBy({
      by: ["emotion"],
      _count: { _all: true },
    });
  }
}
