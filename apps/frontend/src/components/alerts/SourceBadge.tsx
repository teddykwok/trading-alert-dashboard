import { Badge } from "../ui/Badge";
import { NativeBadge } from "./NativeBadge";
import { SOURCE_KIND_DESCRIPTION, SOURCE_LABEL, sourceKindOf } from "../../features/alerts/signalPath";
import type { Alert } from "../../types/alert";

export const TRADINGVIEW_BADGE_TITLE = `${SOURCE_KIND_DESCRIPTION.TRADINGVIEW}: screenshot, AI vision and Extreme RR apply.`;

/** An actual TradingView webhook delivery. */
export function TradingViewBadge() {
  return (
    <Badge tone="gray" title={TRADINGVIEW_BADGE_TITLE}>
      {SOURCE_LABEL.TRADINGVIEW}
    </Badge>
  );
}

/**
 * Every alert names its source, so a mixed list never needs opening to tell a
 * TradingView delivery from Native scanner evidence.
 */
export function SourceBadge({ alert }: { alert: Pick<Alert, "source"> }) {
  return sourceKindOf(alert) === "NATIVE" ? <NativeBadge /> : <TradingViewBadge />;
}
