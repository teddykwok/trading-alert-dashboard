import { useEffect, useState } from "react";
import { Card } from "../ui/Card";
import { tradeReviewsApi } from "../../api/trade-reviews.api";
import type { TradeReviewStats } from "@trading-alert-dashboard/shared";

/**
 * Compact manual-outcome summary for the dashboard. Win rate counts only
 * decisive trades: wins / (wins + losses). Ignored, open, unreviewed, and
 * breakeven never affect it.
 */
export function OutcomeSummary() {
  const [stats, setStats] = useState<TradeReviewStats | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    tradeReviewsApi
      .stats()
      .then(setStats)
      .catch(() => setError(true));
  }, []);

  if (error) return null; // non-essential widget — fail quietly

  const items = [
    { label: "Reviewed", value: stats ? String(stats.totalReviewed) : "…" },
    { label: "Open", value: stats ? String(stats.open) : "…" },
    { label: "Wins", value: stats ? String(stats.wins) : "…", className: "text-green-400" },
    { label: "Losses", value: stats ? String(stats.losses) : "…", className: "text-red-400" },
    { label: "Breakeven", value: stats ? String(stats.breakeven) : "…" },
    {
      label: "Win rate",
      value: stats ? (stats.winRate === null ? "—" : `${stats.winRate.toFixed(1)}%`) : "…",
    },
  ];

  return (
    <Card className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Trade outcomes
      </span>
      {items.map((item) => (
        <span key={item.label} className="text-xs text-slate-500">
          {item.label}:{" "}
          <span className={`font-semibold ${item.className ?? "text-slate-200"}`}>{item.value}</span>
        </span>
      ))}
    </Card>
  );
}
