import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { AlertsService } from "../src/modules/alerts/alerts.service";
import { NotFoundError } from "../src/utils/errors";

const ANCHOR = {
  id: "cur",
  symbol: "BTCUSDT",
  createdAt: new Date("2026-07-15T12:00:00Z"),
};

/**
 * Mock Prisma for neighbor lookup. `findFirst` receives the real where/orderBy
 * built by the repository and answers like Postgres would for a three-alert
 * timeline (newer, ANCHOR, older): it inspects which direction is being asked
 * for via orderBy and returns the configured row for that side.
 */
function createNeighborPrisma(options: {
  current?: typeof ANCHOR | null;
  newer?: { id: string; symbol: string; createdAt: Date } | null;
  older?: { id: string; symbol: string; createdAt: Date } | null;
}) {
  const findFirst = vi.fn().mockImplementation(({ orderBy }) => {
    const ascending = orderBy[0].createdAt === "asc";
    return Promise.resolve(ascending ? options.newer ?? null : options.older ?? null);
  });
  return {
    prisma: {
      alert: {
        findUnique: vi.fn().mockResolvedValue(options.current === undefined ? ANCHOR : options.current),
        findFirst,
      },
    } as unknown as PrismaClient,
    findFirst,
  };
}

/** The where-clauses of the newer and older lookups, keyed by scan direction. */
function capturedWheres(findFirst: ReturnType<typeof vi.fn>) {
  const byDirection: Record<string, unknown> = {};
  for (const [args] of findFirst.mock.calls) {
    byDirection[args.orderBy[0].createdAt === "asc" ? "newer" : "older"] = args.where;
  }
  return byDirection as { newer: { AND: unknown[] }; older: { AND: unknown[] } };
}

describe("AlertsService.neighbors", () => {
  it("returns both neighbors with the boundary conditions anchored on createdAt/id", async () => {
    const newer = { id: "n1", symbol: "ETHUSDT", createdAt: new Date("2026-07-15T13:00:00Z") };
    const older = { id: "o1", symbol: "SOLUSDT", createdAt: new Date("2026-07-15T11:00:00Z") };
    const { prisma, findFirst } = createNeighborPrisma({ newer, older });
    const service = new AlertsService(prisma);

    const result = await service.neighbors("cur", {});

    expect(result).toEqual({ newer, older });
    const wheres = capturedWheres(findFirst);
    // Newer = sorts immediately BEFORE the anchor in createdAt DESC, id DESC:
    // strictly-newer createdAt, or same createdAt with greater id.
    expect(wheres.newer.AND[1]).toEqual({
      OR: [
        { createdAt: { gt: ANCHOR.createdAt } },
        { createdAt: ANCHOR.createdAt, id: { gt: "cur" } },
      ],
    });
    expect(wheres.older.AND[1]).toEqual({
      OR: [
        { createdAt: { lt: ANCHOR.createdAt } },
        { createdAt: ANCHOR.createdAt, id: { lt: "cur" } },
      ],
    });
  });

  it("scans toward the anchor so the IMMEDIATE neighbor wins, not the extremes", async () => {
    const { prisma, findFirst } = createNeighborPrisma({});
    const service = new AlertsService(prisma);

    await service.neighbors("cur", {});

    const newerCall = findFirst.mock.calls.find(([args]) => args.orderBy[0].createdAt === "asc");
    const olderCall = findFirst.mock.calls.find(([args]) => args.orderBy[0].createdAt === "desc");
    expect(newerCall?.[0].orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    expect(olderCall?.[0].orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    // Payload stays small: only identity fields are selected.
    expect(newerCall?.[0].select).toEqual({ id: true, symbol: true, createdAt: true });
  });

  it("returns newer: null at the newest boundary and older: null at the oldest", async () => {
    const older = { id: "o1", symbol: "SOLUSDT", createdAt: new Date("2026-07-15T11:00:00Z") };
    const { prisma } = createNeighborPrisma({ newer: null, older });
    const service = new AlertsService(prisma);
    expect(await service.neighbors("cur", {})).toEqual({ newer: null, older });

    const newer = { id: "n1", symbol: "ETHUSDT", createdAt: new Date("2026-07-15T13:00:00Z") };
    const oldest = createNeighborPrisma({ newer, older: null });
    expect(await new AlertsService(oldest.prisma).neighbors("cur", {})).toEqual({
      newer,
      older: null,
    });
  });

  it("breaks identical createdAt ties by id in both directions", async () => {
    const { prisma, findFirst } = createNeighborPrisma({});
    const service = new AlertsService(prisma);

    await service.neighbors("cur", {});

    const wheres = capturedWheres(findFirst);
    // Same-timestamp rows are still reachable: the equality branch compares id
    // with the same direction the list ordering uses (id DESC ⇒ newer = gt).
    expect(wheres.newer.AND[1]).toMatchObject({
      OR: expect.arrayContaining([{ createdAt: ANCHOR.createdAt, id: { gt: "cur" } }]),
    });
    expect(wheres.older.AND[1]).toMatchObject({
      OR: expect.arrayContaining([{ createdAt: ANCHOR.createdAt, id: { lt: "cur" } }]),
    });
  });

  it("applies the signal filter to both neighbor lookups", async () => {
    const { prisma, findFirst } = createNeighborPrisma({});
    await new AlertsService(prisma).neighbors("cur", { signals: ["SHORT"] });

    const wheres = capturedWheres(findFirst);
    expect(wheres.newer.AND[0]).toMatchObject({ signal: { in: ["SHORT"] } });
    expect(wheres.older.AND[0]).toMatchObject({ signal: { in: ["SHORT"] } });
  });

  it("applies the multi-source-timeframe filter to both neighbor lookups", async () => {
    const { prisma, findFirst } = createNeighborPrisma({});
    await new AlertsService(prisma).neighbors("cur", { sourceTimeframes: ["1W", "1M"] });

    const wheres = capturedWheres(findFirst);
    expect(wheres.newer.AND[0]).toMatchObject({ sourceTimeframe: { in: ["1W", "1M"] } });
    expect(wheres.older.AND[0]).toMatchObject({ sourceTimeframe: { in: ["1W", "1M"] } });
  });

  it("applies the level color filter to both neighbor lookups", async () => {
    const { prisma, findFirst } = createNeighborPrisma({});
    await new AlertsService(prisma).neighbors("cur", { levelColor: "GREEN" });

    const wheres = capturedWheres(findFirst);
    expect(wheres.newer.AND[0]).toMatchObject({ levelColor: "GREEN" });
    expect(wheres.older.AND[0]).toMatchObject({ levelColor: "GREEN" });
  });

  it("applies a combined filter set exactly as the list would", async () => {
    const { prisma, findFirst } = createNeighborPrisma({});
    await new AlertsService(prisma).neighbors("cur", {
      signals: ["SHORT"],
      sourceTimeframes: ["1W", "1M"],
      levelColor: "GREEN",
      assetType: "CRYPTO",
    });

    const wheres = capturedWheres(findFirst);
    for (const where of [wheres.newer, wheres.older]) {
      expect(where.AND[0]).toMatchObject({
        signal: { in: ["SHORT"] },
        sourceTimeframe: { in: ["1W", "1M"] },
        levelColor: "GREEN",
        assetType: "CRYPTO",
      });
    }
  });

  it("throws NotFoundError when the current alert does not exist", async () => {
    const { prisma, findFirst } = createNeighborPrisma({ current: null });
    const service = new AlertsService(prisma);

    await expect(service.neighbors("missing", {})).rejects.toBeInstanceOf(NotFoundError);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
