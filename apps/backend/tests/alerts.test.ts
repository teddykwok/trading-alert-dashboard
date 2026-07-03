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
  it("returns items and total, ordered newest first via the repository", async () => {
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
      expect.objectContaining({ orderBy: { createdAt: "desc" }, take: 50, skip: 0 })
    );
  });

  it("passes filter fields through to the repository query", async () => {
    const prisma = createMockPrisma([], 0);
    const service = new AlertsService(prisma);

    await service.list({ status: "ANALYZED", symbol: "BTCUSDT", limit: 10, offset: 5 });

    expect(prisma.alert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "ANALYZED", symbol: "BTCUSDT" }),
        take: 10,
        skip: 5,
      })
    );
  });
});
