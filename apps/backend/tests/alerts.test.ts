import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { AlertsService } from "../src/modules/alerts/alerts.service";

function createMockPrisma(items: unknown[], total: number) {
  return {
    alert: {
      findMany: vi.fn().mockResolvedValue(items),
      count: vi.fn().mockResolvedValue(total),
    },
  } as unknown as PrismaClient;
}

describe("AlertsService.list", () => {
  it("returns items and total, ordered newest first with id tiebreak for stable paging", async () => {
    const items = [
      { id: "a2", symbol: "ETHUSDT", createdAt: new Date("2026-07-02T12:00:00Z") },
      { id: "a1", symbol: "BTCUSDT", createdAt: new Date("2026-07-02T11:00:00Z") },
    ];
    const prisma = createMockPrisma(items, 2);
    const service = new AlertsService(prisma);

    const result = await service.list({ limit: 50, offset: 0 });

    expect(result.items).toEqual(items);
    expect(result.total).toBe(2);
    expect(prisma.alert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
        skip: 0,
      })
    );
  });

  it("filters symbol as case-insensitive substring and pages via take/skip", async () => {
    const prisma = createMockPrisma([], 0);
    const service = new AlertsService(prisma);

    await service.list({ status: "ANALYZED", symbol: "btc", limit: 10, offset: 5 });

    expect(prisma.alert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "ANALYZED",
          symbol: { contains: "btc", mode: "insensitive" },
        }),
        take: 10,
        skip: 5,
      })
    );
  });

  it("applies the multi-signal filter as an in-list, winning over single signal", async () => {
    const prisma = createMockPrisma([], 0);
    const service = new AlertsService(prisma);

    await service.list({ signal: "WATCH", signals: ["LONG", "SHORT"], limit: 10, offset: 0 });

    expect(prisma.alert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ signal: { in: ["LONG", "SHORT"] } }),
      })
    );
  });

  it("uses the identical where-clause for count so total matches the paged filter", async () => {
    const prisma = createMockPrisma([], 0);
    const service = new AlertsService(prisma);

    await service.list({
      signals: ["LONG"],
      assetType: "CRYPTO",
      sourceTimeframe: "1D",
      levelColor: "RED",
      limit: 10,
      offset: 0,
    });

    const findManyWhere = (prisma.alert.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    const countWhere = (prisma.alert.count as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(countWhere).toEqual(findManyWhere);
    expect(findManyWhere).toEqual(
      expect.objectContaining({
        signal: { in: ["LONG"] },
        assetType: "CRYPTO",
        sourceTimeframe: "1D",
        levelColor: "RED",
      })
    );
  });
});
