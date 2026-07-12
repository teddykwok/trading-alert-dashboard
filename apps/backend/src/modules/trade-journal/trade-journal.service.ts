import type { Prisma, PrismaClient, TradeJournal } from "@prisma/client";
import {
  summarizeChecklist,
  TRADE_CHECKLIST_ITEMS,
  type TradeDisciplineStats,
  type TradeEmotion,
} from "@trading-alert-dashboard/shared";
import { TradeJournalRepository } from "./trade-journal.repository";
import { NotFoundError } from "../../utils/errors";
import type { TradeJournalUpsertInput } from "./trade-journal.schema";

/**
 * The shape returned when an alert has never been journaled: every checklist
 * item unchecked, every psychology field empty. GET never creates a row.
 */
export function defaultTradeJournal(alertId: string) {
  return {
    id: null,
    alertId,
    signalMatchesPlan: false,
    entryStopTargetDefined: false,
    riskWithinLimit: false,
    leverageReviewed: false,
    notFomo: false,
    notRevengeTrade: false,
    acceptsPotentialLoss: false,
    emotion: null as TradeEmotion | null,
    confidenceLevel: null as number | null,
    reasonForEntry: null as string | null,
    preTradeNotes: null as string | null,
    postTradeReflection: null as string | null,
    lessonLearned: null as string | null,
    createdAt: null as Date | null,
    updatedAt: null as Date | null,
  };
}

type StoredJournal = TradeJournal | ReturnType<typeof defaultTradeJournal>;

/**
 * Attaches the derived checklist summary. Always computed from the stored
 * booleans on read — never persisted, never weighted, never a "score".
 */
function withChecklistSummary<T extends StoredJournal>(journal: T) {
  return { ...journal, checklistSummary: summarizeChecklist(journal) };
}

export class TradeJournalService {
  private readonly repository: TradeJournalRepository;

  constructor(prisma: PrismaClient) {
    this.repository = new TradeJournalRepository(prisma);
  }

  private async assertAlertExists(alertId: string) {
    const alert = await this.repository.findAlertById(alertId);
    if (!alert) throw new NotFoundError(`Alert ${alertId} not found`);
  }

  async getForAlert(alertId: string) {
    await this.assertAlertExists(alertId);
    const journal = await this.repository.findByAlertId(alertId);
    return withChecklistSummary(journal ?? defaultTradeJournal(alertId));
  }

  /**
   * Upserts the journal for an alert. Only fields present in the input are
   * written: `undefined` leaves a field untouched, an explicit `null` clears
   * a nullable field (checklist booleans are non-nullable by schema). The
   * checklist summary is recomputed on the response, never persisted.
   */
  async upsertForAlert(alertId: string, input: TradeJournalUpsertInput) {
    await this.assertAlertExists(alertId);

    const changes: Prisma.TradeJournalUncheckedUpdateInput = {};

    if (input.signalMatchesPlan !== undefined) changes.signalMatchesPlan = input.signalMatchesPlan;
    if (input.entryStopTargetDefined !== undefined) changes.entryStopTargetDefined = input.entryStopTargetDefined;
    if (input.riskWithinLimit !== undefined) changes.riskWithinLimit = input.riskWithinLimit;
    if (input.leverageReviewed !== undefined) changes.leverageReviewed = input.leverageReviewed;
    if (input.notFomo !== undefined) changes.notFomo = input.notFomo;
    if (input.notRevengeTrade !== undefined) changes.notRevengeTrade = input.notRevengeTrade;
    if (input.acceptsPotentialLoss !== undefined) changes.acceptsPotentialLoss = input.acceptsPotentialLoss;
    if (input.emotion !== undefined) changes.emotion = input.emotion;
    if (input.confidenceLevel !== undefined) changes.confidenceLevel = input.confidenceLevel;
    if (input.reasonForEntry !== undefined) changes.reasonForEntry = input.reasonForEntry;
    if (input.preTradeNotes !== undefined) changes.preTradeNotes = input.preTradeNotes;
    if (input.postTradeReflection !== undefined) changes.postTradeReflection = input.postTradeReflection;
    if (input.lessonLearned !== undefined) changes.lessonLearned = input.lessonLearned;

    const saved = await this.repository.upsert(
      alertId,
      changes as Omit<Prisma.TradeJournalUncheckedCreateInput, "alertId">,
      changes
    );

    return withChecklistSummary(saved);
  }

  /**
   * Plain counts for the dashboard strip. Deliberately no outcome joins and
   * no win-rate correlation — that is future analytics, computed elsewhere.
   */
  async stats(): Promise<TradeDisciplineStats> {
    const allChecked = Object.fromEntries(
      TRADE_CHECKLIST_ITEMS.map((item) => [item.key, true])
    ) as Prisma.TradeJournalWhereInput;

    const [journals, fullChecklists, emotionGroups] = await Promise.all([
      this.repository.count(),
      this.repository.count(allChecked),
      this.repository.countByEmotion(),
    ]);

    let mostCommonEmotion: TradeEmotion | null = null;
    let highest = 0;
    for (const group of emotionGroups) {
      if (group.emotion !== null && group._count._all > highest) {
        highest = group._count._all;
        mostCommonEmotion = group.emotion;
      }
    }

    return {
      journals,
      fullChecklists,
      incompleteChecklists: journals - fullChecklists,
      mostCommonEmotion,
    };
  }
}
