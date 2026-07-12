import { isHigherSourceTimeframe } from "@trading-alert-dashboard/shared";
import { Badge } from "../ui/Badge";
import type { AlertContext } from "../../types/alert";

const TOUCH_DIRECTION_LABEL: Record<string, string> = {
  FROM_ABOVE: "From above",
  FROM_BELOW: "From below",
};

/**
 * Compact source-level badges for alert cards: the timeframe the level
 * ORIGINATED on (e.g. "LVL 12M") plus its color as text ("RED"/"GREEN"), so
 * meaning never relies on color alone. Deliberately distinct in style and
 * position from the plain chart-timeframe text next to the symbol.
 */
export function LevelContextBadges({ context }: { context: AlertContext | null | undefined }) {
  if (!context || (!context.sourceTimeframe && !context.levelColor)) return null;

  const directionLabel = context.touchDirection
    ? TOUCH_DIRECTION_LABEL[context.touchDirection]
    : undefined;

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {context.sourceTimeframe && (
        <Badge tone="blue" title="Timeframe the level originated on">
          LVL {context.sourceTimeframe}
        </Badge>
      )}
      {context.levelColor && (
        <Badge tone={context.levelColor === "GREEN" ? "green" : "red"}>
          {context.levelColor}
        </Badge>
      )}
      {isHigherSourceTimeframe(context.sourceTimeframe) && (
        <Badge tone="gray" title="Level from a higher timeframe (3M/6M/12M)">
          HIGHER TF
        </Badge>
      )}
      {directionLabel && <span className="text-xs text-slate-500">{directionLabel}</span>}
    </span>
  );
}
