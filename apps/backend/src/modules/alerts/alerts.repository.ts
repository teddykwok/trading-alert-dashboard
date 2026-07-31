import type { PrismaClient, Prisma } from "@prisma/client";
import type {
  AlertListFilter,
  AlertNeighbor,
  AlertNeighborFilter,
  AlertStatsRange,
  CreateAlertInput,
  DuplicateLookupInput,
} from "./alerts.types";

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

  /**
   * Shared list/count where-clause. Server-side filtering is what keeps
   * offset paging honest: a page is always "the next N matching alerts",
   * never a browser-side subset of an arbitrary window.
   * - symbol: case-insensitive substring, matching the dashboard search box.
   * - signals (multi, e.g. actionable LONG+SHORT) wins over single `signal`.
   * - sourceTimeframes (multi, OR across level-origin timeframes) wins over
   *   single `sourceTimeframe`.
   *
   * Also the predicate for neighbor lookup (findNewer/findOlder), so "next
   * matching alert" can never drift from what the list itself would show.
   */
  private listWhere(filter: AlertNeighborFilter): Prisma.AlertWhereInput {
    return {
      status: filter.status,
      symbol: filter.symbol
        ? { contains: filter.symbol, mode: "insensitive" }
        : undefined,
      signal: filter.signals?.length ? { in: filter.signals } : filter.signal,
      assetType: filter.assetType,
      sourceTimeframe: filter.sourceTimeframes?.length
        ? { in: filter.sourceTimeframes }
        : filter.sourceTimeframe,
      levelColor: filter.levelColor,
    };
  }

  findMany(filter: AlertListFilter) {
    return this.prisma.alert.findMany({
      where: this.listWhere(filter),
      // `id` tiebreak makes paging deterministic when alerts share the same
      // createdAt timestamp (bursts arrive within the same millisecond).
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: filter.limit,
      skip: filter.offset,
      // Manual trade-review status and journal checklist ride along so alert
      // cards can show outcome / "Checklist n/7" badges without a request per
      // alert. The summary itself is derived client-side from the booleans.
      include: {
        tradeReview: { select: { status: true } },
        tradeJournal: {
          select: {
            signalMatchesPlan: true,
            entryStopTargetDefined: true,
            riskWithinLimit: true,
            leverageReviewed: true,
            notFomo: true,
            notRevengeTrade: true,
            acceptsPotentialLoss: true,
            emotion: true,
          },
        },
      },
    });
  }

  count(filter: AlertNeighborFilter) {
    return this.prisma.alert.count({ where: this.listWhere(filter) });
  }

  /**
   * Neighbor lookup in the dashboard's canonical ordering
   * (createdAt DESC, id DESC), anchored on the current alert's createdAt/id.
   *
   * "Newer" = the closest matching row that sorts immediately BEFORE the
   * anchor: strictly greater createdAt, or the same createdAt with a greater
   * id (the same tiebreak the list uses). Scanning ascending and taking the
   * first row yields the immediate neighbor, not the newest overall.
   */
  findNewerNeighbor(
    anchor: { createdAt: Date; id: string },
    filter: AlertNeighborFilter
  ): Promise<AlertNeighbor | null> {
    return this.prisma.alert.findFirst({
      where: {
        AND: [
          this.listWhere(filter),
          {
            OR: [
              { createdAt: { gt: anchor.createdAt } },
              { createdAt: anchor.createdAt, id: { gt: anchor.id } },
            ],
          },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, symbol: true, createdAt: true },
    });
  }

  /** "Older" = the closest matching row that sorts immediately AFTER the anchor. */
  findOlderNeighbor(
    anchor: { createdAt: Date; id: string },
    filter: AlertNeighborFilter
  ): Promise<AlertNeighbor | null> {
    return this.prisma.alert.findFirst({
      where: {
        AND: [
          this.listWhere(filter),
          {
            OR: [
              { createdAt: { lt: anchor.createdAt } },
              { createdAt: anchor.createdAt, id: { lt: anchor.id } },
            ],
          },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, symbol: true, createdAt: true },
    });
  }

  /**
   * Stat-card aggregation. Note the deliberate absence of listWhere: the
   * cards count the whole day regardless of the list filters, and the range
   * is the ONLY predicate.
   */
  private rangeWhere(range: AlertStatsRange): Prisma.AlertWhereInput {
    return { createdAt: { gte: range.from, lt: range.to } };
  }

  /**
   * Counts are aggregated by Postgres (GROUP BY), so the whole day is counted
   * without ever loading alert rows — the result size is bounded by the number
   * of distinct statuses, not by how many alerts exist.
   */
  groupByStatus(range: AlertStatsRange) {
    return this.prisma.alert.groupBy({
      by: ["status"],
      _count: { _all: true },
      where: this.rangeWhere(range),
    });
  }

  groupBySignal(range: AlertStatsRange) {
    return this.prisma.alert.groupBy({
      by: ["signal"],
      _count: { _all: true },
      where: this.rangeWhere(range),
    });
  }

  update(id: string, data: Prisma.AlertUpdateInput) {
    return this.prisma.alert.update({ where: { id }, data });
  }

  delete(id: string) {
    return this.prisma.alert.delete({ where: { id } });
  }
}
