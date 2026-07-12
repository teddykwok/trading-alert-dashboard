import {
  summarizeChecklist,
  TRADE_EMOTION_LABELS,
  type TradeChecklist,
  type TradeEmotion,
} from "@trading-alert-dashboard/shared";
import { Badge } from "../ui/Badge";

/**
 * Compact "Checklist n/7" badge for alert cards, shown only when a journal
 * row exists. A neutral count — completion is not presented as good or bad.
 */
export function ChecklistBadge({
  journal,
}: {
  journal: (TradeChecklist & { emotion: TradeEmotion | null }) | null | undefined;
}) {
  if (!journal) return null;

  const summary = summarizeChecklist(journal);

  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone="gray">
        Checklist {summary.completedCount}/{summary.totalCount}
      </Badge>
      {journal.emotion && (
        <span className="text-xs text-slate-500">{TRADE_EMOTION_LABELS[journal.emotion]}</span>
      )}
    </span>
  );
}
