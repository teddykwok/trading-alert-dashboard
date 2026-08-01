import { Badge } from "../ui/Badge";
import { formatMinMovementPercent, isTeddyIndicator } from "../../utils/minMovement";

/**
 * The teddy indicator's configured minimum higher-timeframe movement used to
 * create the level (indicatorValue in percentage points). A static script
 * setting — deliberately gray so it never reads as AI confidence or a trade
 * outcome. Renders nothing for non-teddy indicators and for historical teddy
 * alerts that sent 0.
 */
export function MinMovementBadge({
  indicatorName,
  value,
}: {
  indicatorName: string | null;
  value: number | null;
}) {
  if (!isTeddyIndicator(indicatorName)) return null;
  const formatted = formatMinMovementPercent(value);
  if (!formatted) return null;
  return (
    <Badge tone="gray" title="Minimum higher-timeframe price movement used to create this level">
      MOVE ≥{formatted}
    </Badge>
  );
}
