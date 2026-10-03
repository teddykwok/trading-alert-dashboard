import { presentNativeScanner, presentTradingViewSource } from "../../api/signalSources.api";
import { useSignalSources } from "../../hooks/useSignalSources";
import { formatDateTime } from "../../utils/formatDate";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";

/**
 * Signal Sources — compact, read-only, truthful.
 *
 * TradingView keeps no connection and sends no heartbeat, so its line says
 * "Webhook ready" and when an actual alert last arrived; silence is normal.
 * The Native scanner line shows RUNNING only for a fresh, explicitly running
 * supervisor status — otherwise STOPPED, STALE or UNKNOWN.
 */
export function SignalSourcesCard() {
  const { status, unreachable } = useSignalSources();
  const tv = presentTradingViewSource(status, unreachable);
  const native = presentNativeScanner(status);
  const lastTv = status?.tradingView.lastReceivedAt ? formatDateTime(status.tradingView.lastReceivedAt) : tv.last;
  const lastNative = status?.native.lastDeliveredAt ? formatDateTime(status.native.lastDeliveredAt) : "No Native alert delivered yet";

  return (
    <Card className="grid gap-3 p-3 sm:grid-cols-2" data-testid="signal-sources">
      <div className="space-y-1 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-200">TradingView</span>
          <Badge tone={tv.tone}>{tv.webhook}</Badge>
        </div>
        <p className="text-slate-400">
          Last received: <span className="text-slate-300">{lastTv}</span>
        </p>
      </div>
      <div className="space-y-1 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-200">Native scanner</span>
          <Badge tone={native.tone} title={status?.native.reason}>
            {native.state}
          </Badge>
        </div>
        <p className="text-slate-400">
          Profile: <span className="text-slate-300">{native.profile}</span> · Run:{" "}
          <span className="text-slate-300">{native.run}</span>
        </p>
        <p className="text-slate-400">
          Eligible: <span className="text-slate-300">{native.eligible}</span> · Live:{" "}
          <span className="text-slate-300">{native.live}</span> · Last delivered:{" "}
          <span className="text-slate-300">{lastNative}</span>
        </p>
        <p className="text-slate-500">Dashboard only — Native execution is disabled.</p>
      </div>
    </Card>
  );
}
