import { Badge } from "../ui/Badge";
import { NATIVE_ALERT_BADGE_LABEL, NATIVE_ALERT_BADGE_TITLE } from "../../utils/alertSource";

/**
 * Marks an alert produced by the native scanner so it is never mistaken for a
 * TradingView alert. Render only when `isNativeAlert(alert)`.
 */
export function NativeBadge() {
  return (
    <Badge tone="blue" title={NATIVE_ALERT_BADGE_TITLE}>
      {NATIVE_ALERT_BADGE_LABEL}
    </Badge>
  );
}
