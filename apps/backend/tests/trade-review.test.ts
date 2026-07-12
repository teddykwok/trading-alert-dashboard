import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  TradeReviewService,
  defaultTradeReview,
  resolveReviewTimestamps,
} from "../src/modules/trade-review/trade-review.service";
import { tradeReviewUpsertSchema } from "../src/modules/trade-review/trade-review.schema";
import { NotFoundError } from "../src/utils/errors";
import { NON_DIRECTIONAL_PLAN_MESSAGE } from "@trading-alert-dashboard/shared";

const NOW = new Date("2026-07-11T10:00:00Z");
const OPENED = new Date("2026-07-10T08:00:00Z");
const CLOSED = new Date("2026-07-10T20:00:00Z");

interface MockOptions {
  alertExists?: boolean;
  /** Alert.signal — the only source of plan direction. */
  signal?: string;
  existingReview?: Record<string, unknown> | null;
  groupBy?: Array<{ status: string; _count: { _all: number } }>;
  alertCount?: number;
}

function createMockPrisma(options: MockOptions = {}) {
  const upsert = vi.fn().mockImplementation(async ({ where, create, update }) => ({
    id: "review_1",
    alertId: where.alertId,
    ...(options.existingReview ?? {}),
    ...(options.existingReview ? update : create),
  }));

  return {
    alert: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          options.alertExists === false ? null : { id: "alert_1", signal: options.signal }
        ),
      count: vi.fn().mockResolvedValue(options.alertCount ?? 0),
    },
    tradeReview: {
      findUnique: vi.fn().mockResolvedValue(options.existingReview ?? null),
      upsert,
      groupBy: vi.fn().mockResolvedValue(options.groupBy ?? []),
    },
  } as unknown as PrismaClient;
}

function upsertDataOf(prisma: PrismaClient) {
  return (prisma.tradeReview.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveReviewTimestamps", () => {
  const empty = { openedAt: null, closedAt: null };

  it("OPEN sets openedAt once and clears closedAt", () => {
    expect(resolveReviewTimestamps("OPEN", empty, NOW)).toEqual({ openedAt: NOW, closedAt: null });
    // re-opening a closed trade keeps the original open time, clears close
    expect(resolveReviewTimestamps("OPEN", { openedAt: OPENED, closedAt: CLOSED }, NOW)).toEqual({
      openedAt: OPENED,
      closedAt: null,
    });
  });

  it("WIN/LOSS/BREAKEVEN set openedAt and closedAt when missing", () => {
    for (const status of ["WIN", "LOSS", "BREAKEVEN"] as const) {
      expect(resolveReviewTimestamps(status, empty, NOW)).toEqual({ openedAt: NOW, closedAt: NOW });
      expect(resolveReviewTimestamps(status, { openedAt: OPENED, closedAt: null }, NOW)).toEqual({
        openedAt: OPENED,
        closedAt: NOW,
      });
    }
  });

  it("corrections between final statuses keep the original timestamps", () => {
    expect(resolveReviewTimestamps("LOSS", { openedAt: OPENED, closedAt: CLOSED }, NOW)).toEqual({
      openedAt: OPENED,
      closedAt: CLOSED,
    });
  });

  it("IGNORED and UNREVIEWED clear execution timestamps", () => {
    for (const status of ["IGNORED", "UNREVIEWED"] as const) {
      expect(resolveReviewTimestamps(status, { openedAt: OPENED, closedAt: CLOSED }, NOW)).toEqual({
        openedAt: null,
        closedAt: null,
      });
    }
  });
});

describe("TradeReviewService.getForAlert", () => {
  it("returns a default UNREVIEWED representation when no review exists", async () => {
    const prisma = createMockPrisma({ existingReview: null, signal: "LONG" });
    const service = new TradeReviewService(prisma);

    const result = await service.getForAlert("alert_1");

    expect(result).toEqual({
      ...defaultTradeReview("alert_1"),
      futuresRiskPlan: null, // planner inputs incomplete -> no computed plan
      futuresRiskPlanMessage: null,
    });
    expect(result.status).toBe("UNREVIEWED");
    expect(result.id).toBeNull();
  });

  it("throws NotFoundError for a nonexistent alert", async () => {
    const prisma = createMockPrisma({ alertExists: false });
    const service = new TradeReviewService(prisma);

    await expect(service.getForAlert("missing")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("TradeReviewService.upsertForAlert", () => {
  it("creates an OPEN review with openedAt set and closedAt null", async () => {
    const prisma = createMockPrisma({ existingReview: null });
    const service = new TradeReviewService(prisma);

    await service.upsertForAlert("alert_1", { status: "OPEN" });

    const { create } = upsertDataOf(prisma);
    expect(create.status).toBe("OPEN");
    expect(create.openedAt).toBeInstanceOf(Date);
    expect(create.closedAt).toBeNull();
  });

  it("updates OPEN to WIN, keeping openedAt and setting closedAt", async () => {
    const prisma = createMockPrisma({
      existingReview: { status: "OPEN", openedAt: OPENED, closedAt: null },
    });
    const service = new TradeReviewService(prisma);

    await service.upsertForAlert("alert_1", { status: "WIN" });

    const { update } = upsertDataOf(prisma);
    expect(update.status).toBe("WIN");
    expect(update.openedAt).toEqual(OPENED);
    expect(update.closedAt).toBeInstanceOf(Date);
  });

  it("updates OPEN to LOSS", async () => {
    const prisma = createMockPrisma({
      existingReview: { status: "OPEN", openedAt: OPENED, closedAt: null },
    });
    const service = new TradeReviewService(prisma);

    await service.upsertForAlert("alert_1", { status: "LOSS" });

    expect(upsertDataOf(prisma).update.status).toBe("LOSS");
  });

  it("supports BREAKEVEN and IGNORED", async () => {
    const prisma = createMockPrisma({ existingReview: null });
    const service = new TradeReviewService(prisma);

    await service.upsertForAlert("alert_1", { status: "BREAKEVEN" });
    expect(upsertDataOf(prisma).create.status).toBe("BREAKEVEN");

    vi.clearAllMocks();
    const prisma2 = createMockPrisma({ existingReview: null });
    const service2 = new TradeReviewService(prisma2);
    await service2.upsertForAlert("alert_1", { status: "IGNORED" });
    const { create } = upsertDataOf(prisma2);
    expect(create.status).toBe("IGNORED");
    expect(create.openedAt).toBeNull();
    expect(create.closedAt).toBeNull();
  });

  it("allows correcting a final status (WIN -> LOSS) without moving closedAt", async () => {
    const prisma = createMockPrisma({
      existingReview: { status: "WIN", openedAt: OPENED, closedAt: CLOSED },
    });
    const service = new TradeReviewService(prisma);

    await service.upsertForAlert("alert_1", { status: "LOSS" });

    const { update } = upsertDataOf(prisma);
    expect(update.status).toBe("LOSS");
    expect(update.openedAt).toEqual(OPENED);
    expect(update.closedAt).toEqual(CLOSED);
  });

  it("does not touch prices or notes when only the status changes", async () => {
    const prisma = createMockPrisma({
      existingReview: { status: "OPEN", entryPrice: "0.004086", notes: "keep me" },
    });
    const service = new TradeReviewService(prisma);

    await service.upsertForAlert("alert_1", { status: "WIN" });

    const { update } = upsertDataOf(prisma);
    expect(update).not.toHaveProperty("entryPrice");
    expect(update).not.toHaveProperty("exitPrice");
    expect(update).not.toHaveProperty("notes");
  });

  it("passes decimal price strings through without float round-tripping", async () => {
    for (const price of ["62408", "0.004086", "0.00001234"]) {
      const prisma = createMockPrisma({ existingReview: null });
      const service = new TradeReviewService(prisma);

      await service.upsertForAlert("alert_1", { entryPrice: price, exitPrice: price });

      const { create } = upsertDataOf(prisma);
      expect(create.entryPrice).toBe(price); // exact string, no precision loss
      expect(create.exitPrice).toBe(price);
    }
  });

  it("clears a price on explicit null but leaves omitted fields untouched", async () => {
    const prisma = createMockPrisma({
      existingReview: { status: "OPEN", entryPrice: "1.5", exitPrice: "2.5" },
    });
    const service = new TradeReviewService(prisma);

    await service.upsertForAlert("alert_1", { entryPrice: null });

    const { update } = upsertDataOf(prisma);
    expect(update.entryPrice).toBeNull();
    expect(update).not.toHaveProperty("exitPrice");
    expect(update).not.toHaveProperty("status");
  });

  it("throws NotFoundError for a nonexistent alert", async () => {
    const prisma = createMockPrisma({ alertExists: false });
    const service = new TradeReviewService(prisma);

    await expect(service.upsertForAlert("missing", { status: "OPEN" })).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(prisma.tradeReview.upsert).not.toHaveBeenCalled();
  });
});

describe("TradeReviewService.upsertForAlert — futures risk plan fields", () => {
  it("saves every planner field with exact decimal strings", async () => {
    const prisma = createMockPrisma({ existingReview: null, signal: "LONG" });
    const service = new TradeReviewService(prisma);

    await service.upsertForAlert("alert_1", {
      entryPrice: "0.004086",
      stopLossPrice: "0.003950",
      takeProfitPrice: "0.004358",
      accountBalance: "1000",
      riskPercent: "1",
      leverage: "25",
      marginMode: "ISOLATED",
      liquidationPrice: "0.003900",
    });

    const { create } = upsertDataOf(prisma);
    expect(create.entryPrice).toBe("0.004086"); // exact strings, no float trip
    expect(create.stopLossPrice).toBe("0.003950");
    expect(create.takeProfitPrice).toBe("0.004358");
    expect(create.accountBalance).toBe("1000");
    expect(create.riskPercent).toBe("1");
    expect(create.leverage).toBe("25");
    expect(create.marginMode).toBe("ISOLATED");
    expect(create.liquidationPrice).toBe("0.003900");
  });

  it("partial update touches only the provided planner fields", async () => {
    const prisma = createMockPrisma({
      existingReview: { status: "OPEN", stopLossPrice: "95", leverage: "25" },
      signal: "LONG",
    });
    const service = new TradeReviewService(prisma);

    await service.upsertForAlert("alert_1", { leverage: "100" });

    const { update } = upsertDataOf(prisma);
    expect(update.leverage).toBe("100");
    expect(update).not.toHaveProperty("stopLossPrice");
    expect(update).not.toHaveProperty("takeProfitPrice");
    expect(update).not.toHaveProperty("accountBalance");
    expect(update).not.toHaveProperty("status");
  });

  it("clears optional planner fields on explicit null", async () => {
    const prisma = createMockPrisma({
      existingReview: { liquidationPrice: "90", takeProfitPrice: "110" },
      signal: "LONG",
    });
    const service = new TradeReviewService(prisma);

    await service.upsertForAlert("alert_1", { liquidationPrice: null, takeProfitPrice: null });

    const { update } = upsertDataOf(prisma);
    expect(update.liquidationPrice).toBeNull();
    expect(update.takeProfitPrice).toBeNull();
  });
});

describe("TradeReviewService — computed futuresRiskPlan", () => {
  const LONG_PLAN_REVIEW = {
    status: "OPEN",
    entryPrice: "100",
    stopLossPrice: "95",
    takeProfitPrice: "110",
    accountBalance: "1000",
    riskPercent: "1",
    leverage: "25",
    marginMode: "ISOLATED",
    liquidationPrice: null,
  };

  it("attaches a computed plan for a LONG alert", async () => {
    const prisma = createMockPrisma({ existingReview: LONG_PLAN_REVIEW, signal: "LONG" });
    const service = new TradeReviewService(prisma);

    const result = await service.getForAlert("alert_1");

    expect(result.futuresRiskPlanMessage).toBeNull();
    expect(result.futuresRiskPlan?.valid).toBe(true);
    expect(result.futuresRiskPlan?.riskBudget).toBe("10");
    expect(result.futuresRiskPlan?.positionQuantity).toBe("2");
    expect(result.futuresRiskPlan?.positionNotional).toBe("200");
    expect(result.futuresRiskPlan?.requiredMargin).toBe("8");
    expect(result.futuresRiskPlan?.riskRewardRatio).toBe("2");
  });

  it("attaches a computed plan for a SHORT alert", async () => {
    const prisma = createMockPrisma({
      existingReview: { ...LONG_PLAN_REVIEW, stopLossPrice: "105", takeProfitPrice: "90" },
      signal: "SHORT",
    });
    const service = new TradeReviewService(prisma);

    const result = await service.getForAlert("alert_1");

    expect(result.futuresRiskPlan?.valid).toBe(true);
    expect(result.futuresRiskPlan?.positionQuantity).toBe("2");
    expect(result.futuresRiskPlan?.expectedProfitAtTakeProfit).toBe("20");
  });

  it("returns the directional message instead of a plan for WATCH alerts", async () => {
    const prisma = createMockPrisma({ existingReview: LONG_PLAN_REVIEW, signal: "WATCH" });
    const service = new TradeReviewService(prisma);

    const result = await service.getForAlert("alert_1");

    expect(result.futuresRiskPlan).toBeNull();
    expect(result.futuresRiskPlanMessage).toBe(NON_DIRECTIONAL_PLAN_MESSAGE);
    // plan inputs are still stored/returned for later use
    expect(result.entryPrice).toBe("100");
  });

  it("returns a null plan without a message when inputs are incomplete", async () => {
    const prisma = createMockPrisma({
      existingReview: { ...LONG_PLAN_REVIEW, accountBalance: null },
      signal: "LONG",
    });
    const service = new TradeReviewService(prisma);

    const result = await service.getForAlert("alert_1");

    expect(result.futuresRiskPlan).toBeNull();
    expect(result.futuresRiskPlanMessage).toBeNull();
  });

  it("also enriches the upsert response with the plan", async () => {
    const prisma = createMockPrisma({ existingReview: LONG_PLAN_REVIEW, signal: "LONG" });
    const service = new TradeReviewService(prisma);

    const result = await service.upsertForAlert("alert_1", { leverage: "100" });

    expect(result.futuresRiskPlan?.valid).toBe(true);
    expect(result.futuresRiskPlan?.requiredMargin).toBe("2"); // 200 / 100
    // leverage change: risk/size identical to the 25x plan
    expect(result.futuresRiskPlan?.riskBudget).toBe("10");
    expect(result.futuresRiskPlan?.positionQuantity).toBe("2");
    expect(result.futuresRiskPlan?.positionNotional).toBe("200");
  });
});

describe("tradeReviewUpsertSchema — planner fields", () => {
  it("rejects invalid marginMode and leverage below 1", () => {
    expect(tradeReviewUpsertSchema.safeParse({ marginMode: "HEDGE" }).success).toBe(false);
    expect(tradeReviewUpsertSchema.safeParse({ leverage: "0" }).success).toBe(false);
    expect(tradeReviewUpsertSchema.safeParse({ leverage: 0.5 }).success).toBe(false);
  });

  it("accepts valid planner payloads", () => {
    expect(
      tradeReviewUpsertSchema.safeParse({
        stopLossPrice: "0.003950",
        takeProfitPrice: "0.004358",
        accountBalance: "1000",
        riskPercent: "1",
        leverage: "25",
        marginMode: "CROSS",
        liquidationPrice: null,
      }).success
    ).toBe(true);
  });
});

describe("tradeReviewUpsertSchema", () => {
  it("rejects an invalid status", () => {
    expect(tradeReviewUpsertSchema.safeParse({ status: "MOON" }).success).toBe(false);
  });

  it("rejects malformed or non-positive prices", () => {
    expect(tradeReviewUpsertSchema.safeParse({ entryPrice: "abc" }).success).toBe(false);
    expect(tradeReviewUpsertSchema.safeParse({ entryPrice: "-1" }).success).toBe(false);
    expect(tradeReviewUpsertSchema.safeParse({ entryPrice: "0" }).success).toBe(false);
    expect(tradeReviewUpsertSchema.safeParse({ entryPrice: -5 }).success).toBe(false);
  });

  it("accepts decimal strings, numbers, nulls, and omitted fields", () => {
    expect(tradeReviewUpsertSchema.safeParse({ entryPrice: "0.004086" }).success).toBe(true);
    expect(tradeReviewUpsertSchema.safeParse({ entryPrice: 62408 }).success).toBe(true);
    expect(tradeReviewUpsertSchema.safeParse({ entryPrice: null }).success).toBe(true);
    expect(tradeReviewUpsertSchema.safeParse({}).success).toBe(true);
  });
});

describe("TradeReviewService.stats", () => {
  const FULL_GROUPS = [
    { status: "WIN", _count: { _all: 2 } },
    { status: "LOSS", _count: { _all: 1 } },
    { status: "OPEN", _count: { _all: 3 } },
    { status: "IGNORED", _count: { _all: 4 } },
    { status: "BREAKEVEN", _count: { _all: 1 } },
    { status: "UNREVIEWED", _count: { _all: 5 } },
  ];

  it("computes counts and the win rate from decisive trades only", async () => {
    const prisma = createMockPrisma({ groupBy: FULL_GROUPS, alertCount: 20 });
    const service = new TradeReviewService(prisma);

    const stats = await service.stats({});

    expect(stats.totalReviewed).toBe(11); // everything except UNREVIEWED rows
    expect(stats.unreviewedAlerts).toBe(9); // 20 alerts - 11 reviewed
    expect(stats.ignored).toBe(4);
    expect(stats.open).toBe(3);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.breakeven).toBe(1);
    expect(stats.decisiveTrades).toBe(3);
    // winRate = wins / (wins + losses) * 100 — open/ignored/breakeven excluded
    expect(stats.winRate).toBeCloseTo((2 / 3) * 100, 5);
  });

  it("returns null winRate when there are no decisive trades", async () => {
    const prisma = createMockPrisma({
      groupBy: [
        { status: "OPEN", _count: { _all: 2 } },
        { status: "BREAKEVEN", _count: { _all: 1 } },
      ],
      alertCount: 5,
    });
    const service = new TradeReviewService(prisma);

    const stats = await service.stats({});

    expect(stats.decisiveTrades).toBe(0);
    expect(stats.winRate).toBeNull();
  });

  it("passes filters through to the alert relation query", async () => {
    const prisma = createMockPrisma({ groupBy: [], alertCount: 0 });
    const service = new TradeReviewService(prisma);
    const dateFrom = new Date("2026-07-01T00:00:00Z");
    const dateTo = new Date("2026-07-11T00:00:00Z");

    await service.stats({ symbol: "BTCUSDT", timeframe: "1h", signal: "LONG", dateFrom, dateTo });

    const expectedAlertWhere = {
      symbol: "BTCUSDT",
      timeframe: "1h",
      signal: "LONG",
      createdAt: { gte: dateFrom, lte: dateTo },
    };
    expect(prisma.tradeReview.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { alert: expectedAlertWhere } })
    );
    expect(prisma.alert.count).toHaveBeenCalledWith({ where: expectedAlertWhere });
  });
});
