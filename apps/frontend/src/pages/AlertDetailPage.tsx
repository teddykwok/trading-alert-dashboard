import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Card } from "../components/ui/Card";
import { SignalBadge } from "../components/alerts/SignalBadge";
import { StatusBadge } from "../components/alerts/StatusBadge";
import { MockAiBadge } from "../components/alerts/MockAiBadge";
import { OpenAiBadge } from "../components/alerts/OpenAiBadge";
import { AiOpinionPanel } from "../components/alerts/AiOpinionPanel";
import { TradeOutcomePanel } from "../components/alerts/TradeOutcomePanel";
import { FuturesRiskPlanner } from "../components/alerts/FuturesRiskPlanner";
import { ScreenshotPreview } from "../components/charts/ScreenshotPreview";
import { alertsApi } from "../api/alerts.api";
import { getSocket } from "../sockets/socket";
import { SOCKET_EVENTS } from "../sockets/socket-events";
import { formatDateTime } from "../utils/formatDate";
import { formatPrice } from "../utils/formatPrice";
import type { Alert, AlertContext, AlertStatus } from "../types/alert";

const STATUS_TIMELINE: AlertStatus[] = [
  "RECEIVED",
  "PROCESSING_SCREENSHOT",
  "ANALYZING_WITH_AI",
  "ANALYZED",
];

export function AlertDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [alert, setAlert] = useState<Alert | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    alertsApi
      .getById(id)
      .then(setAlert)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load alert"))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const socket = getSocket();

    function handleUpdate(updated: Alert) {
      if (updated.id === id) setAlert(updated);
    }

    socket.on(SOCKET_EVENTS.ALERT_UPDATED, handleUpdate);
    socket.on(SOCKET_EVENTS.ALERT_FAILED, handleUpdate);
    socket.on(SOCKET_EVENTS.ALERT_DUPLICATE, handleUpdate);

    return () => {
      socket.off(SOCKET_EVENTS.ALERT_UPDATED, handleUpdate);
      socket.off(SOCKET_EVENTS.ALERT_FAILED, handleUpdate);
      socket.off(SOCKET_EVENTS.ALERT_DUPLICATE, handleUpdate);
    };
  }, [id]);

  if (loading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!alert) return <p className="text-sm text-slate-500">Alert not found.</p>;

  const currentIndex = STATUS_TIMELINE.indexOf(alert.status);
  const marketDataSource =
    alert.assetType === "CRYPTO" && alert.exchange?.toUpperCase() === "BINANCE"
      ? "Binance (real)"
      : "Mock";

  return (
    <div className="flex flex-col gap-5">
      <Link to="/" className="text-xs text-slate-500 hover:text-slate-300">
        ← Back to dashboard
      </Link>

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold text-slate-100">{alert.symbol}</h1>
        <span className="text-sm text-slate-500">{alert.timeframe}</span>
        <SignalBadge signal={alert.signal} />
        <StatusBadge status={alert.status} />
        {alert.aiProvider === "mock" && <MockAiBadge />}
        {alert.aiProvider === "openai" && <OpenAiBadge />}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="flex flex-col gap-5 lg:col-span-2">
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-200">Chart screenshot</h2>
            <ScreenshotPreview
              screenshotUrl={alert.screenshotUrl}
              alt={`${alert.symbol} chart`}
              className="h-auto w-full"
            />
          </Card>

          <FuturesRiskPlanner alert={alert} />

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-200">Raw webhook payload</h2>
            <pre className="max-h-80 overflow-auto rounded-lg bg-surface p-3 text-xs text-slate-400">
              {JSON.stringify(alert.rawPayload, null, 2)}
            </pre>
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-200">Alert metadata</h2>
            <dl className="space-y-2 text-sm">
              <Row label="Price" value={formatPrice(alert.price)} />
              <Row label="Asset type" value={alert.assetType} />
              <Row label="Exchange" value={alert.exchange ?? "—"} />
              <Row label="Market data source" value={marketDataSource} />
              <Row label="Indicator" value={alert.indicatorName ?? "—"} />
              <Row
                label="Indicator value"
                value={alert.indicatorValue !== null ? String(alert.indicatorValue) : "—"}
              />
              <Row label="Triggered at" value={formatDateTime(alert.triggeredAt)} />
              <Row label="Received at" value={formatDateTime(alert.createdAt)} />
            </dl>
          </Card>

          {alert.alertContext && <LevelContextCard context={alert.alertContext} />}

          <TradeOutcomePanel alertId={alert.id} />

          <AiOpinionPanel alert={alert} />

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-200">Status timeline</h2>
            {alert.status === "FAILED" ? (
              <p className="text-sm text-red-400">Failed: {alert.errorMessage}</p>
            ) : (
              <ol className="space-y-2">
                {STATUS_TIMELINE.map((status, index) => (
                  <li key={status} className="flex items-center gap-2 text-sm">
                    <span
                      className={
                        index <= currentIndex
                          ? "h-2 w-2 rounded-full bg-blue-500"
                          : "h-2 w-2 rounded-full bg-surface-border"
                      }
                    />
                    <span className={index <= currentIndex ? "text-slate-200" : "text-slate-600"}>
                      {status.replace(/_/g, " ")}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  LEVEL_TOUCHED: "Level touched",
  LEVEL_CREATED: "Level created",
};

const DIRECTION_LABEL: Record<string, string> = {
  FROM_ABOVE: "From above",
  FROM_BELOW: "From below",
  UNKNOWN: "Unknown",
};

const COLOR_LABEL: Record<string, string> = {
  GREEN: "Green",
  RED: "Red",
};

/**
 * Structured level metadata from the Pine webhook note. "Source timeframe"
 * is where the red/green line originated (1D…12M); "Chart timeframe" is the
 * chart the alert fired on — shown together here precisely so the two are
 * never confused.
 */
function LevelContextCard({ context }: { context: AlertContext }) {
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-200">Level context</h2>
      <dl className="space-y-2 text-sm">
        <Row label="Event" value={context.eventType ? EVENT_LABEL[context.eventType] : "—"} />
        <Row label="Source timeframe" value={context.sourceTimeframe ?? "—"} />
        <Row label="Level color" value={context.levelColor ? COLOR_LABEL[context.levelColor] : "—"} />
        <Row
          label="Touch direction"
          value={context.touchDirection ? DIRECTION_LABEL[context.touchDirection] : "—"}
        />
        <Row
          label="Level price"
          value={context.levelPrice !== null ? formatPrice(context.levelPrice) : "—"}
        />
        <Row label="Chart timeframe" value={context.chartTimeframe ?? "—"} />
      </dl>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-200">{value}</dd>
    </div>
  );
}
