import type { PrismaClient, Prisma } from "@prisma/client";
import type { AlertListFilter, CreateAlertInput, DuplicateLookupInput } from "./alerts.types";

/**
 * Thin data-access layer over Prisma. Keeps raw `where`/`data` object
 * construction out of the service layer so alerts.service.ts can stay
 * focused on orchestration and business rules.
 */
export class AlertsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(input: CreateAlertInput) {
    return this.prisma.alert.create({ data: input });
  }

  findById(id: string) {
    return this.prisma.alert.findUnique({ where: { id } });
  }

  /**
   * Finds the most recent alert matching all duplicate-detection fields
   * (symbol, assetType, timeframe, signal, indicatorName) created within
   * the suppression window. Returns null when there's no recent match, in
   * which case the caller should create a brand new alert as usual.
   */
  findRecentDuplicate(input: DuplicateLookupInput) {
    return this.prisma.alert.findFirst({
      where: {
        symbol: input.symbol,
        assetType: input.assetType,
        timeframe: input.timeframe,
        signal: input.signal,
        indicatorName: input.indicatorName,
        createdAt: { gte: input.since },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  incrementDuplicate(id: string) {
    return this.prisma.alert.update({
      where: { id },
      data: {
        duplicateCount: { increment: 1 },
        lastDuplicateAt: new Date(),
      },
    });
  }

  findMany(filter: AlertListFilter) {
    const where: Prisma.AlertWhereInput = {
      status: filter.status,
      symbol: filter.symbol,
      signal: filter.signal,
      assetType: filter.assetType,
      sourceTimeframe: filter.sourceTimeframe,
      levelColor: filter.levelColor,
    };

    return this.prisma.alert.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: filter.limit,
      skip: filter.offset,
      // Manual trade-review status rides along so alert cards can show an
      // outcome badge without a request per alert.
      include: { tradeReview: { select: { status: true } } },
    });
  }

  count(filter: Omit<AlertListFilter, "limit" | "offset">) {
    return this.prisma.alert.count({
      where: {
        status: filter.status,
        symbol: filter.symbol,
        signal: filter.signal,
        assetType: filter.assetType,
        sourceTimeframe: filter.sourceTimeframe,
        levelColor: filter.levelColor,
      },
    });
  }

  update(id: string, data: Prisma.AlertUpdateInput) {
    return this.prisma.alert.update({ where: { id }, data });
  }

  delete(id: string) {
    return this.prisma.alert.delete({ where: { id } });
  }
}
