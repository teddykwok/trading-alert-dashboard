import { Link, useLocation } from "react-router-dom";
import { Card } from "../ui/Card";
import { SignalBadge } from "./SignalBadge";
import { StatusBadge } from "./StatusBadge";
import { MockAiBadge } from "./MockAiBadge";
import { OpenAiBadge } from "./OpenAiBadge";
import { MinMovementBadge } from "./MinMovementBadge";
import { DuplicateBadge } from "./DuplicateBadge";
import { OutcomeBadge } from "./OutcomeBadge";
import { LevelContextBadges } from "./LevelContextBadges";
import { ChecklistBadge } from "./ChecklistBadge";
import { ScreenshotPreview } from "../charts/ScreenshotPreview";
import { formatPrice } from "../../utils/formatPrice";
import { formatRelativeTime } from "../../utils/formatDate";
import type { Alert } from "../../types/alert";

export function AlertCard({ alert }: { alert: Alert }) {
  // Carry the dashboard's filter query into the detail URL so the detail page
  // can offer "Back to filtered results" and filter-aware Newer/Older
  // navigation — and so a refresh there doesn't lose the review context.
  const { search } = useLocation();
  return (
    <Link to={{ pathname: `/alerts/${alert.id}`, search }}>
      <Card className="flex gap-3 p-3 transition-colors hover:border-slate-600">
        <ScreenshotPreview
          screenshotUrl={alert.screenshotUrl}
          status={alert.status}
          alt={`${alert.symbol} chart`}
          className="h-16 w-28 flex-shrink-0"
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-100">{alert.symbol}</span>
            <span className="text-xs text-slate-500">{alert.timeframe}</span>
            <SignalBadge signal={alert.signal} />
            <StatusBadge status={alert.status} />
            {alert.aiProvider === "mock" && <MockAiBadge />}
            {alert.aiProvider === "openai" && <OpenAiBadge />}
            <MinMovementBadge indicatorName={alert.indicatorName} value={alert.indicatorValue} />
            {alert.duplicateCount > 0 && <DuplicateBadge count={alert.duplicateCount} />}
            {alert.tradeReview && alert.tradeReview.status !== "UNREVIEWED" && (
              <OutcomeBadge status={alert.tradeReview.status} />
            )}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <span>{formatPrice(alert.price)}</span>
            <span>{formatRelativeTime(alert.createdAt)}</span>
            <LevelContextBadges context={alert.alertContext} />
            <ChecklistBadge journal={alert.tradeJournal} />
          </div>

          {alert.aiSummary && (
            <p className="mt-1 line-clamp-1 text-xs text-slate-400">{alert.aiSummary}</p>
          )}
        </div>
      </Card>
    </Link>
  );
}
