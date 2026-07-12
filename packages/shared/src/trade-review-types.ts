export type TradeReviewStatus =
  | "UNREVIEWED"
  | "IGNORED"
  | "OPEN"
  | "WIN"
  | "LOSS"
  | "BREAKEVEN";

/**
 * A trade review as serialized over the API. Prisma Decimal fields serialize
 * to strings (e.g. "0.004086") so small-cap price precision survives the
 * wire; keep them as strings in the frontend and only convert for display.
 * `id` is null in the default representation returned before any review has
 * been persisted for an alert.
 */
export interface TradeReview {
  id: string | null;
  alertId: string;
  status: TradeReviewStatus;
  entryPrice: string | null;
  exitPrice: string | null;
  notes: string | null;
  openedAt: string | null;
  closedAt: string | null;
  // Futures risk-planner inputs (derived values are never stored; the API
  // recomputes them into `futuresRiskPlan` on every read).
  stopLossPrice: string | null;
  takeProfitPrice: string | null;
  accountBalance: string | null;
  riskPercent: string | null;
  leverage: string | null;
  marginMode: import("./futures-risk").TradeMarginMode | null;
  liquidationPrice: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Shape returned by GET/PUT /api/alerts/:alertId/trade-review: the stored
 * review plus a freshly computed plan. `futuresRiskPlan` is null when the
 * planning inputs are incomplete or the alert has no tradable direction;
 * `futuresRiskPlanMessage` explains the non-directional case (WATCH/EXIT).
 */
export interface TradeReviewWithPlan extends TradeReview {
  futuresRiskPlan: import("./futures-risk").FuturesRiskPlan | null;
  futuresRiskPlanMessage: string | null;
}

export interface TradeReviewStats {
  totalReviewed: number;
  unreviewedAlerts: number;
  ignored: number;
  open: number;
  wins: number;
  losses: number;
  breakeven: number;
  decisiveTrades: number;
  /** wins / (wins + losses) * 100; null when there are no decisive trades. */
  winRate: number | null;
}
