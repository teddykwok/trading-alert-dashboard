import { apiClient } from "./client";
import type {
  TradeDisciplineStats,
  TradeEmotion,
  TradeJournalWithSummary,
} from "@trading-alert-dashboard/shared";

/**
 * `undefined` (omitted) preserves a stored value, `null` clears a nullable
 * field. Checklist booleans are never null — unchecked is `false`. Responses
 * include a freshly derived `checklistSummary` (never stored server-side).
 */
export interface TradeJournalUpsertInput {
  signalMatchesPlan?: boolean;
  entryStopTargetDefined?: boolean;
  riskWithinLimit?: boolean;
  leverageReviewed?: boolean;
  notFomo?: boolean;
  notRevengeTrade?: boolean;
  acceptsPotentialLoss?: boolean;
  emotion?: TradeEmotion | null;
  confidenceLevel?: number | null;
  reasonForEntry?: string | null;
  preTradeNotes?: string | null;
  postTradeReflection?: string | null;
  lessonLearned?: string | null;
}

export const tradeJournalsApi = {
  getForAlert: (alertId: string) =>
    apiClient.get<TradeJournalWithSummary>(`/api/alerts/${alertId}/trade-journal`),

  upsertForAlert: (alertId: string, input: TradeJournalUpsertInput) =>
    apiClient.put<TradeJournalWithSummary>(`/api/alerts/${alertId}/trade-journal`, input),

  stats: () => apiClient.get<TradeDisciplineStats>("/api/trade-journals/stats"),
};
