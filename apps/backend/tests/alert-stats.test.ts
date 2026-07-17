import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { AlertsService } from "../src/modules/alerts/alerts.service";
import { statsQuerySchema } from "../src/routes/alerts.routes";

const FROM = new Date("2026-07-17T00:00:00+08:00");
const TO = new Date("2026-07-18T00:00:00+08:00");

type Group<K extends string, V extends string> = Record<K, V> & { _count: { _all: number } };

function createMockPrisma(
  statusGroups: Array<Group<"status", string>>,
  signalGroups: Array<Group<"signal", string>>
) {
  return {
    alert: {
      groupBy: vi
        .fn()
        .mockImplementation(({ by }: { by: string[] }) =>
          Promise.resolve(by[0] === "status" ? statusGroups : signalGroups)
        ),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  } as unknown as PrismaClient;
}

function statusGroup(status: string, count: number) {
  return { status, _count: { _all: count } } as Group<"status", string>;
}

function signalGroup(signal: string, count: number) {
  return { signal, _count: { _all: count } } as Group<"signal", string>;
}

describe("AlertsService.statsForRange", () => {
  it("counts a full day of far more than one page of alerts (no page-size undercount)", async () => {
    // 940 alerts today — far beyond DASHBOARD_DEFAULT_LIMIT (100) and beyond
    // DASHBOARD_MAX_LIMIT (200). The cards must still report the true totals.
    const prisma = createMockPrisma(
      [
        statusGroup("ANALYZED", 700),
        statusGroup("FAILED", 40),
        statusGroup("RECEIVED", 100),
        statusGroup("PROCESSING_SCREENSHOT", 60),
        statusGroup("ANALYZING_WITH_AI", 40),
      ],
      [
        signalGroup("LONG", 400),
        signalGroup("SHORT", 300),
        signalGroup("WATCH", 200),
        signalGroup("EXIT", 40),
      ]
    );
    const service = new AlertsService(prisma);

    const stats = await service.statsForRange({ from: FROM, to: TO });

    expect(stats.total).toBe(940);
    expect(stats.long).toBe(400);
    expect(stats.short).toBe(300);
    expect(stats.processing).toBe(200); // RECEIVED + PROCESSING_SCREENSHOT + ANALYZING_WITH_AI
    expect(stats.analyzed).toBe(700);
    expect(stats.failed).toBe(40);
    expect(stats.from).toBe(FROM.toISOString());
    expect(stats.to).toBe(TO.toISOString());
  });

  it("never loads alert rows to compute statistics", async () => {
    const prisma = createMockPrisma([statusGroup("ANALYZED", 500)], [signalGroup("LONG", 500)]);
    const service = new AlertsService(prisma);

    await service.statsForRange({ from: FROM, to: TO });

    // Aggregation happens in the database — fetching rows (and counting in JS)
    // is exactly the bug this endpoint exists to prevent.
    expect(prisma.alert.findMany).not.toHaveBeenCalled();
    expect(prisma.alert.groupBy).toHaveBeenCalledTimes(2);
  });

  it("scopes counts to the requested range only — list filters never apply", async () => {
    const prisma = createMockPrisma([], []);
    const service = new AlertsService(prisma);

    await service.statsForRange({ from: FROM, to: TO });

    const calls = (prisma.alert.groupBy as ReturnType<typeof vi.fn>).mock.calls;
    for (const [args] of calls) {
      // createdAt is the ONLY predicate: no symbol/signal/status filtering can
      // leak in from the dashboard's list filters.
      expect(args.where).toEqual({ createdAt: { gte: FROM, lt: TO } });
    }
    expect(calls.map(([args]) => args.by)).toEqual([["status"], ["signal"]]);
  });

  it("reports zeroes for a day with no alerts", async () => {
    const service = new AlertsService(createMockPrisma([], []));

    const stats = await service.statsForRange({ from: FROM, to: TO });

    expect(stats).toMatchObject({ total: 0, long: 0, short: 0, processing: 0, analyzed: 0, failed: 0 });
  });

  it("counts every status toward the total, including statuses without a card", async () => {
    const prisma = createMockPrisma(
      [statusGroup("ANALYZED", 120), statusGroup("IGNORED_DUPLICATE", 5)],
      [signalGroup("LONG", 125)]
    );
    const service = new AlertsService(prisma);

    const stats = await service.statsForRange({ from: FROM, to: TO });

    expect(stats.total).toBe(125);
    expect(stats.analyzed).toBe(120);
    expect(stats.processing).toBe(0);
  });
});

describe("statsQuerySchema", () => {
  it("coerces ISO instants sent by the client", () => {
    const parsed = statsQuerySchema.parse({
      from: "2026-07-17T00:00:00+08:00",
      to: "2026-07-18T00:00:00+08:00",
    });
    expect(parsed.from).toEqual(FROM);
    expect(parsed.to).toEqual(TO);
  });

  it("requires both bounds — the server cannot guess the viewer's timezone", () => {
    expect(statsQuerySchema.safeParse({}).success).toBe(false);
    expect(statsQuerySchema.safeParse({ from: FROM.toISOString() }).success).toBe(false);
  });

  it("rejects an inverted or empty range", () => {
    expect(
      statsQuerySchema.safeParse({ from: TO.toISOString(), to: FROM.toISOString() }).success
    ).toBe(false);
    expect(
      statsQuerySchema.safeParse({ from: FROM.toISOString(), to: FROM.toISOString() }).success
    ).toBe(false);
  });

  it("rejects unparseable dates", () => {
    expect(statsQuerySchema.safeParse({ from: "not-a-date", to: TO.toISOString() }).success).toBe(false);
  });
});
