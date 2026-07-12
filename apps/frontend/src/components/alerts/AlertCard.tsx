import { Link } from "react-router-dom";
import { Card } from "../ui/Card";
import { SignalBadge } from "./SignalBadge";
import { StatusBadge } from "./StatusBadge";
import { MockAiBadge } from "./MockAiBadge";
import { OpenAiBadge } from "./OpenAiBadge";
import { DuplicateBadge } from "./DuplicateBadge";
import { OutcomeBadge } from "./OutcomeBadge";
import { LevelContextBadges } from "./LevelContextBadges";
import { ScreenshotPreview } from "../charts/ScreenshotPreview";
import { formatPrice } from "../../utils/formatPrice";
import { formatRelativeTime } from "../../utils/formatDate";
import type { Alert } from "../../types/alert";

export function AlertCard({ alert }: { alert: Alert }) {
  return (
    <Link to={`/alerts/${alert.id}`}>
      <Card className="flex gap-3 p-3 transition-colors hover:border-slate-600">
        <ScreenshotPreview
          screenshotUrl={alert.screenshotUrl}
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
            {alert.duplicateCount > 0 && <DuplicateBadge count={alert.duplicateCount} />}
            {alert.tradeReview && alert.tradeReview.status !== "UNREVIEWED" && (
              <OutcomeBadge status={alert.tradeReview.status} />
            )}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <span>{formatPrice(alert.price)}</span>
            <span>{formatRelativeTime(alert.createdAt)}</span>
            <LevelContextBadges context={alert.alertContext} />
          </div>

          {alert.aiSummary && (
            <p className="mt-1 line-clamp-1 text-xs text-slate-400">{alert.aiSummary}</p>
          )}
        </div>
      </Card>
    </Link>
  );
}
