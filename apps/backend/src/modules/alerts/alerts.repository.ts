import type { PrismaClient, Prisma } from "@prisma/client";
import type { AlertListFilter, CreateAlertInput } from "./alerts.types";

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

  findMany(filter: AlertListFilter) {
    const where: Prisma.AlertWhereInput = {
      status: filter.status,
      symbol: filter.symbol,
      signal: filter.signal,
      assetType: filter.assetType,
    };

    return this.prisma.alert.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: filter.limit,
      skip: filter.offset,
    });
  }

  count(filter: Omit<AlertListFilter, "limit" | "offset">) {
    return this.prisma.alert.count({
      where: {
        status: filter.status,
        symbol: filter.symbol,
        signal: filter.signal,
        assetType: filter.assetType,
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
