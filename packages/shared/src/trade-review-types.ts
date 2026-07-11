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
  createdAt: string | null;
  updatedAt: string | null;
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
