import { z } from "zod";
import {
  TRADE_CONFIDENCE_MAX,
  TRADE_CONFIDENCE_MIN,
  TRADE_EMOTIONS,
  TRADE_JOURNAL_TEXT_LIMITS,
} from "@trading-alert-dashboard/shared";

/**
 * Upsert payload for PUT /api/alerts/:alertId/trade-journal.
 *
 * Same field semantics as the trade-review schema: `undefined` preserves the
 * stored value, explicit `null` clears a nullable field. Checklist booleans
 * are NOT nullable — a checkbox is either checked or not; "clearing" one
 * means sending `false`.
 */
const checklistBool = z.boolean().optional();

/** Empty/whitespace-only text is treated as null (cleared), like the UI sends. */
const journalText = (maxLength: number) => z.string().max(maxLength).nullable().optional();

export const tradeJournalUpsertSchema = z.object({
  signalMatchesPlan: checklistBool,
  entryStopTargetDefined: checklistBool,
  riskWithinLimit: checklistBool,
  leverageReviewed: checklistBool,
  notFomo: checklistBool,
  notRevengeTrade: checklistBool,
  acceptsPotentialLoss: checklistBool,

  emotion: z.enum(TRADE_EMOTIONS).nullable().optional(),
  confidenceLevel: z
    .number()
    .int("must be an integer")
    .min(TRADE_CONFIDENCE_MIN, `must be between ${TRADE_CONFIDENCE_MIN} and ${TRADE_CONFIDENCE_MAX}`)
    .max(TRADE_CONFIDENCE_MAX, `must be between ${TRADE_CONFIDENCE_MIN} and ${TRADE_CONFIDENCE_MAX}`)
    .nullable()
    .optional(),

  reasonForEntry: journalText(TRADE_JOURNAL_TEXT_LIMITS.reasonForEntry),
  preTradeNotes: journalText(TRADE_JOURNAL_TEXT_LIMITS.preTradeNotes),
  postTradeReflection: journalText(TRADE_JOURNAL_TEXT_LIMITS.postTradeReflection),
  lessonLearned: journalText(TRADE_JOURNAL_TEXT_LIMITS.lessonLearned),
});

export type TradeJournalUpsertInput = z.infer<typeof tradeJournalUpsertSchema>;
