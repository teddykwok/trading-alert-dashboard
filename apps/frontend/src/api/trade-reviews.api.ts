import { apiClient } from "./client";
import type { TradeReview, TradeReviewStats, TradeReviewStatus } from "@trading-alert-dashboard/shared";

/**
 * Prices travel as strings ("0.004086") so Decimal precision is preserved
 * end to end; `null` clears a stored value, omitting a field leaves it as-is.
 */
export interface TradeReviewUpsertInput {
  status?: TradeReviewStatus;
  entryPrice?: string | null;
  exitPrice?: string | null;
  notes?: string | null;
}

export const tradeReviewsApi = {
  getForAlert: (alertId: string) =>
    apiClient.get<TradeReview>(`/api/alerts/${alertId}/trade-review`),

  upsertForAlert: (alertId: string, input: TradeReviewUpsertInput) =>
    apiClient.put<TradeReview>(`/api/alerts/${alertId}/trade-review`, input),

  stats: () => apiClient.get<TradeReviewStats>("/api/trade-reviews/stats"),
};
