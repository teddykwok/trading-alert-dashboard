import { useEffect, useState } from "react";
import { TRADE_EMOTION_LABELS, type TradeDisciplineStats } from "@trading-alert-dashboard/shared";
import { Card } from "../ui/Card";
import { tradeJournalsApi } from "../../api/trade-journals.api";

/**
 * Compact journal counts for the dashboard. Plain tallies only — no
 * correlation with outcomes and no claim that completion or any emotion
 * predicts performance.
 */
export function TradeDisciplineSummary() {
  const [stats, setStats] = useState<TradeDisciplineStats | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    tradeJournalsApi
      .stats()
      .then(setStats)
      .catch(() => setError(true));
  }, []);

  if (error) return null; // non-essential widget — fail quietly
  if (stats && stats.journals === 0) return null; // nothing journaled yet

  const items = [
    { label: "Journals", value: stats ? String(stats.journals) : "…" },
    { label: "Full checklists", value: stats ? String(stats.fullChecklists) : "…" },
    { label: "Incomplete", value: stats ? String(stats.incompleteChecklists) : "…" },
    {
      label: "Most common emotion",
      value: stats
        ? stats.mostCommonEmotion
          ? TRADE_EMOTION_LABELS[stats.mostCommonEmotion]
          : "—"
        : "…",
    },
  ];

  return (
    <Card className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Trade discipline
      </span>
      {items.map((item) => (
        <span key={item.label} className="text-xs text-slate-500">
          {item.label}: <span className="font-semibold text-slate-200">{item.value}</span>
        </span>
      ))}
    </Card>
  );
}
