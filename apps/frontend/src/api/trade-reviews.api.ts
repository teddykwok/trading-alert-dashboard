import { apiClient } from "./client";
import type {
  TradeMarginMode,
  TradeReviewStats,
  TradeReviewStatus,
  TradeReviewWithPlan,
} from "@trading-alert-dashboard/shared";

/**
 * Prices and other decimals travel as strings ("0.004086") so Decimal
 * precision is preserved end to end; `null` clears a stored value, omitting
 * a field leaves it as-is. Responses include a freshly computed
 * `futuresRiskPlan` (never stored server-side).
 */
export interface TradeReviewUpsertInput {
  status?: TradeReviewStatus;
  entryPrice?: string | null;
  exitPrice?: string | null;
  notes?: string | null;
  stopLossPrice?: string | null;
  takeProfitPrice?: string | null;
  accountBalance?: string | null;
  riskPercent?: string | null;
  leverage?: string | null;
  marginMode?: TradeMarginMode | null;
  liquidationPrice?: string | null;
}

export const tradeReviewsApi = {
  getForAlert: (alertId: string) =>
    apiClient.get<TradeReviewWithPlan>(`/api/alerts/${alertId}/trade-review`),

  upsertForAlert: (alertId: string, input: TradeReviewUpsertInput) =>
    apiClient.put<TradeReviewWithPlan>(`/api/alerts/${alertId}/trade-review`, input),

  stats: () => apiClient.get<TradeReviewStats>("/api/trade-reviews/stats"),
};
