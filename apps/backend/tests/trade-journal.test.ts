import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { summarizeChecklist, TRADE_CHECKLIST_ITEMS } from "@trading-alert-dashboard/shared";
import {
  TradeJournalService,
  defaultTradeJournal,
} from "../src/modules/trade-journal/trade-journal.service";
import { tradeJournalUpsertSchema } from "../src/modules/trade-journal/trade-journal.schema";
import { NotFoundError } from "../src/utils/errors";

interface MockOptions {
  alertExists?: boolean;
  existingJournal?: Record<string, unknown> | null;
  counts?: [number, number];
  emotionGroups?: Array<{ emotion: string | null; _count: { _all: number } }>;
}

function createMockPrisma(options: MockOptions = {}) {
  const upsert = vi.fn().mockImplementation(async ({ where, create, update }) => ({
    id: "journal_1",
    alertId: where.alertId,
    ...defaultTradeJournal(where.alertId),
    ...(options.existingJournal ?? {}),
    ...(options.existingJournal ? update : create),
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

  const count = vi.fn();
  count.mockResolvedValueOnce(options.counts?.[0] ?? 0).mockResolvedValueOnce(options.counts?.[1] ?? 0);

  return {
    alert: {
      findUnique: vi
        .fn()
        .mockResolvedValue(options.alertExists === false ? null : { id: "alert_1" }),
    },
    tradeJournal: {
      findUnique: vi.fn().mockResolvedValue(options.existingJournal ?? null),
      upsert,
      count,
      groupBy: vi.fn().mockResolvedValue(options.emotionGroups ?? []),
    },
  } as unknown as PrismaClient;
}

function upsertArgsOf(prisma: PrismaClient) {
  return (prisma.tradeJournal.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("summarizeChecklist", () => {
  const allTrue = Object.fromEntries(TRADE_CHECKLIST_ITEMS.map((i) => [i.key, true]));

  it("reports 0/7 for an empty checklist", () => {
    const summary = summarizeChecklist({});

    expect(summary.completedCount).toBe(0);
    expect(summary.totalCount).toBe(7);
    expect(summary.completionPercentage).toBe(0);
    expect(summary.isComplete).toBe(false);
    expect(summary.incompleteItems).toEqual(TRADE_CHECKLIST_ITEMS.map((i) => i.key));
  });

  it("reports 4/7 with the correct incomplete keys and percentage", () => {
    const summary = summarizeChecklist({
      signalMatchesPlan: true,
      entryStopTargetDefined: true,
      riskWithinLimit: true,
      leverageReviewed: true,
      notFomo: false,
    });

    expect(summary.completedCount).toBe(4);
    expect(summary.completionPercentage).toBe(57); // round(4/7*100)
    expect(summary.isComplete).toBe(false);
    expect(summary.incompleteItems).toEqual(["notFomo", "notRevengeTrade", "acceptsPotentialLoss"]);
  });

  it("reports 7/7 complete", () => {
    const summary = summarizeChecklist(allTrue);

    expect(summary.completedCount).toBe(7);
    expect(summary.completionPercentage).toBe(100);
    expect(summary.isComplete).toBe(true);
    expect(summary.incompleteItems).toEqual([]);
  });

  it("derives only counts — no discipline/psychology score of any kind", () => {
    expect(Object.keys(summarizeChecklist(allTrue)).sort()).toEqual([
      "completedCount",
      "completionPercentage",
      "incompleteItems",
      "isComplete",
      "totalCount",
    ]);
  });
});

describe("tradeJournalUpsertSchema", () => {
  it("accepts confidence 1 and 5, rejects 0, 6, and non-integers", () => {
    expect(tradeJournalUpsertSchema.safeParse({ confidenceLevel: 1 }).success).toBe(true);
    expect(tradeJournalUpsertSchema.safeParse({ confidenceLevel: 5 }).success).toBe(true);
    expect(tradeJournalUpsertSchema.safeParse({ confidenceLevel: null }).success).toBe(true);
    expect(tradeJournalUpsertSchema.safeParse({ confidenceLevel: 0 }).success).toBe(false);
    expect(tradeJournalUpsertSchema.safeParse({ confidenceLevel: 6 }).success).toBe(false);
    expect(tradeJournalUpsertSchema.safeParse({ confidenceLevel: 3.5 }).success).toBe(false);
  });

  it("rejects an invalid emotion, accepts every defined emotion and null", () => {
    expect(tradeJournalUpsertSchema.safeParse({ emotion: "EUPHORIC" }).success).toBe(false);
    expect(tradeJournalUpsertSchema.safeParse({ emotion: "CALM" }).success).toBe(true);
    expect(tradeJournalUpsertSchema.safeParse({ emotion: "REVENGE" }).success).toBe(true);
    expect(tradeJournalUpsertSchema.safeParse({ emotion: null }).success).toBe(true);
  });

  it("requires checklist values to be booleans — null and strings are rejected", () => {
    expect(tradeJournalUpsertSchema.safeParse({ notFomo: true }).success).toBe(true);
    expect(tradeJournalUpsertSchema.safeParse({ notFomo: false }).success).toBe(true);
    expect(tradeJournalUpsertSchema.safeParse({ notFomo: null }).success).toBe(false);
    expect(tradeJournalUpsertSchema.safeParse({ notFomo: "true" }).success).toBe(false);
  });

  it("enforces documented text max lengths", () => {
    expect(
      tradeJournalUpsertSchema.safeParse({ reasonForEntry: "x".repeat(2000) }).success
    ).toBe(true);
    expect(
      tradeJournalUpsertSchema.safeParse({ reasonForEntry: "x".repeat(2001) }).success
    ).toBe(false);
    expect(
      tradeJournalUpsertSchema.safeParse({ preTradeNotes: "x".repeat(5001) }).success
    ).toBe(false);
  });
});

describe("TradeJournalService.getForAlert", () => {
  it("returns the default all-unchecked journal when none exists, without creating a row", async () => {
    const prisma = createMockPrisma({ existingJournal: null });
    const service = new TradeJournalService(prisma);

    const result = await service.getForAlert("alert_1");

    expect(result.id).toBeNull();
    expect(result.signalMatchesPlan).toBe(false);
    expect(result.emotion).toBeNull();
    expect(result.checklistSummary).toEqual({
      completedCount: 0,
      totalCount: 7,
      completionPercentage: 0,
      isComplete: false,
      incompleteItems: TRADE_CHECKLIST_ITEMS.map((i) => i.key),
    });
    // GET must never write.
    expect(prisma.tradeJournal.upsert).not.toHaveBeenCalled();
  });

  it("throws NotFoundError for a nonexistent alert", async () => {
    const prisma = createMockPrisma({ alertExists: false });
    const service = new TradeJournalService(prisma);

    await expect(service.getForAlert("missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("derives the summary from a stored journal", async () => {
    const prisma = createMockPrisma({
      existingJournal: {
        ...defaultTradeJournal("alert_1"),
        id: "journal_1",
        signalMatchesPlan: true,
        riskWithinLimit: true,
        notFomo: true,
        acceptsPotentialLoss: true,
      },
    });
    const service = new TradeJournalService(prisma);

    const result = await service.getForAlert("alert_1");

    expect(result.checklistSummary.completedCount).toBe(4);
    expect(result.checklistSummary.isComplete).toBe(false);
    expect(result.checklistSummary.incompleteItems).toEqual([
      "entryStopTargetDefined",
      "leverageReviewed",
      "notRevengeTrade",
    ]);
  });
});

describe("TradeJournalService.upsertForAlert", () => {
  it("throws NotFoundError for a nonexistent alert and writes nothing", async () => {
    const prisma = createMockPrisma({ alertExists: false });
    const service = new TradeJournalService(prisma);

    await expect(service.upsertForAlert("missing", { notFomo: true })).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(prisma.tradeJournal.upsert).not.toHaveBeenCalled();
  });

  it("creates a journal with only the provided fields", async () => {
    const prisma = createMockPrisma({ existingJournal: null });
    const service = new TradeJournalService(prisma);

    await service.upsertForAlert("alert_1", {
      signalMatchesPlan: true,
      emotion: "CALM",
      confidenceLevel: 4,
    });

    const args = upsertArgsOf(prisma);
    expect(args.where).toEqual({ alertId: "alert_1" });
    expect(args.create).toEqual({
      alertId: "alert_1",
      signalMatchesPlan: true,
      emotion: "CALM",
      confidenceLevel: 4,
    });
  });

  it("partial update: undefined fields are not written, so stored values persist", async () => {
    const prisma = createMockPrisma({
      existingJournal: { id: "journal_1", reasonForEntry: "retest of 12M level", emotion: "CALM" },
    });
    const service = new TradeJournalService(prisma);

    await service.upsertForAlert("alert_1", { notRevengeTrade: true });

    // The update object contains ONLY the supplied field — Prisma leaves
    // reasonForEntry / emotion untouched.
    expect(upsertArgsOf(prisma).update).toEqual({ notRevengeTrade: true });
  });

  it("null clears nullable fields", async () => {
    const prisma = createMockPrisma({
      existingJournal: { id: "journal_1", emotion: "FOMO", confidenceLevel: 2, lessonLearned: "x" },
    });
    const service = new TradeJournalService(prisma);

    await service.upsertForAlert("alert_1", {
      emotion: null,
      confidenceLevel: null,
      lessonLearned: null,
    });

    expect(upsertArgsOf(prisma).update).toEqual({
      emotion: null,
      confidenceLevel: null,
      lessonLearned: null,
    });
  });

  it("updates checklist booleans and returns the recomputed summary", async () => {
    const prisma = createMockPrisma({ existingJournal: null });
    const service = new TradeJournalService(prisma);

    const allChecked = Object.fromEntries(TRADE_CHECKLIST_ITEMS.map((i) => [i.key, true]));
    const result = await service.upsertForAlert("alert_1", allChecked);

    expect(result.checklistSummary.completedCount).toBe(7);
    expect(result.checklistSummary.isComplete).toBe(true);
    expect(result.checklistSummary.incompleteItems).toEqual([]);
  });
});

describe("TradeJournalService.stats", () => {
  it("returns plain counts and the most common emotion, ignoring null emotions", async () => {
    const prisma = createMockPrisma({
      counts: [10, 4],
      emotionGroups: [
        { emotion: null, _count: { _all: 5 } },
        { emotion: "CALM", _count: { _all: 3 } },
        { emotion: "FOMO", _count: { _all: 2 } },
      ],
    });
    const service = new TradeJournalService(prisma);

    expect(await service.stats()).toEqual({
      journals: 10,
      fullChecklists: 4,
      incompleteChecklists: 6,
      mostCommonEmotion: "CALM",
    });
  });

  it("counts full checklists with an all-seven-true filter", async () => {
    const prisma = createMockPrisma({ counts: [0, 0] });
    const service = new TradeJournalService(prisma);

    await service.stats();

    const countCalls = (prisma.tradeJournal.count as ReturnType<typeof vi.fn>).mock.calls;
    expect(countCalls[0][0]).toEqual({ where: {} }); // total journals: no filter
    expect(countCalls[1][0]).toEqual({
      where: Object.fromEntries(TRADE_CHECKLIST_ITEMS.map((i) => [i.key, true])),
    });
  });
});
