import { Badge } from "../ui/Badge";
import type { TradeReviewStatus } from "@trading-alert-dashboard/shared";

const OUTCOME_TONE: Record<TradeReviewStatus, "green" | "red" | "yellow" | "gray" | "blue"> = {
  UNREVIEWED: "gray",
  IGNORED: "gray",
  OPEN: "blue",
  WIN: "green",
  LOSS: "red",
  BREAKEVEN: "yellow",
};

/**
 * Manual trade-outcome badge. Callers should skip rendering for UNREVIEWED —
 * an unreviewed alert simply has no outcome yet.
 */
export function OutcomeBadge({ status }: { status: TradeReviewStatus }) {
  return <Badge tone={OUTCOME_TONE[status]}>{status}</Badge>;
}
