import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Card } from "../components/ui/Card";
import { Disclosure } from "../components/ui/Disclosure";
import { TabList, TabPanel, type TabDefinition } from "../components/ui/Tabs";
import { AlertExecutionPanel } from "../features/executions/AlertExecutionPanel";
import { SignalBadge } from "../components/alerts/SignalBadge";
import { StatusBadge } from "../components/alerts/StatusBadge";
import { MockAiBadge } from "../components/alerts/MockAiBadge";
import { OpenAiBadge } from "../components/alerts/OpenAiBadge";
import { AiOpinionPanel } from "../components/alerts/AiOpinionPanel";
import { TradeOutcomePanel } from "../components/alerts/TradeOutcomePanel";
import { TradeJournalPanel } from "../components/alerts/TradeJournalPanel";
import { ExtremeRRPlanner } from "../components/alerts/ExtremeRRPlanner";
import { FuturesRiskPlanner } from "../components/alerts/FuturesRiskPlanner";
import { ScreenshotPreview } from "../components/charts/ScreenshotPreview";
import { alertsApi } from "../api/alerts.api";
import { parseFiltersFromSearch } from "../hooks/useFilters";
import { getSocket } from "../sockets/socket";
import { SOCKET_EVENTS } from "../sockets/socket-events";
import { formatDateTime } from "../utils/formatDate";
import { formatPrice } from "../utils/formatPrice";
import { formatMinMovementPercent, isTeddyIndicator } from "../utils/minMovement";
import type { Alert, AlertContext, AlertStatus } from "../types/alert";
import type { AlertNeighbor, AlertNeighborsResponse } from "../types/api";

/**
 * Trade Plan first: the planning workflow is what this page is for. Review &
 * Journal stays available but out of the way (the user's primary journal is
 * an external spreadsheet). Selection is local UI state only — a refresh
 * returns to Trade Plan by design.
 */
const WORKFLOW_TABS: TabDefinition[] = [
  { id: "plan", label: "Trade Plan" },
  { id: "review", label: "Review & Journal" },
  { id: "ai", label: "AI Vision" },
  { id: "execution", label: "Execution" },
];

const STATUS_TIMELINE: AlertStatus[] = [
  "RECEIVED",
  "PROCESSING_SCREENSHOT",
  "ANALYZING_WITH_AI",
  "ANALYZED",
];

export function AlertDetailPage() {
  const { id } = useParams<{ id: string }>();
  // The dashboard's filter query travels in this page's URL (not router
  // state), so the review context survives refreshes and can be handed back
  // to "/" or to a neighboring alert unchanged.
  const { search } = useLocation();
  const [alert, setAlert] = useState<Alert | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [neighbors, setNeighbors] = useState<AlertNeighborsResponse | null>(null);
  const [neighborsLoading, setNeighborsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<string>(WORKFLOW_TABS[0].id);

  const filterQuery = useMemo(() => parseFiltersFromSearch(new URLSearchParams(search)), [search]);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    alertsApi
      .getById(id)
      .then(setAlert)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load alert"))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setNeighborsLoading(true);
    setNeighbors(null);
    alertsApi
      .neighbors(id, filterQuery)
      .then((response) => {
        if (!cancelled) setNeighbors(response);
      })
      .catch(() => {
        // Neighbor navigation is an extra — a failure here must never break
        // the alert detail itself. Both directions just stay unavailable.
      })
      .finally(() => {
        if (!cancelled) setNeighborsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, filterQuery]);

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
  const isDirectional = alert.signal === "LONG" || alert.signal === "SHORT";

  /**
   * Rendered once, in whichever core-context column keeps the two balanced:
   * the chart is shorter than the context stack when a level-context card is
   * present, so the timeline joins the chart column there; without it the
   * context column is already the same height as the chart and the timeline
   * belongs beside it.
   */
  const statusTimelineCard = (
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
  );
  const marketDataSource =
    alert.assetType === "CRYPTO" && alert.exchange?.toUpperCase() === "BINANCE"
      ? "Binance (real)"
      : "Mock";

  return (
    <div className="flex flex-col gap-5">
      {/* Filter-aware review navigation: both neighbors and the back link keep
          the filter query, so the whole loop stays inside the same filtered
          result set. */}
      <div className="flex items-center justify-between gap-2 text-xs">
        <NeighborLink
          direction="newer"
          neighbor={neighbors?.newer ?? null}
          loading={neighborsLoading}
          search={search}
        />
        <Link
          to={{ pathname: "/", search }}
          // Router-state hint (NOT a URL param — scroll position is UI state,
          // not a filter): tells the dashboard this is a return from alert
          // review, so it may restore its saved pagination depth + scrollY.
          state={{ restoreDashboardScroll: true }}
          className="text-slate-500 hover:text-slate-300"
        >
          {search ? "Back to filtered results" : "Back to dashboard"}
        </Link>
        <NeighborLink
          direction="older"
          neighbor={neighbors?.older ?? null}
          loading={neighborsLoading}
          search={search}
        />
      </div>

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
              status={alert.status}
              alt={`${alert.symbol} chart`}
              className="h-auto w-full"
            />
          </Card>

          {alert.alertContext && statusTimelineCard}
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
              {/* teddy alerts carry the script's minimum-movement threshold in
                  indicatorValue (percentage points); historical teddy alerts
                  hardcoded 0, which means "not recorded" — never a real 0%.
                  Other indicators keep the generic raw-value row. */}
              {isTeddyIndicator(alert.indicatorName) ? (
                <Row
                  label="Minimum movement"
                  value={formatMinMovementPercent(alert.indicatorValue) ?? "Not recorded"}
                />
              ) : (
                <Row
                  label="Indicator value"
                  value={alert.indicatorValue !== null ? String(alert.indicatorValue) : "—"}
                />
              )}
              <Row label="Triggered at" value={formatDateTime(alert.triggeredAt)} />
              <Row label="Received at" value={formatDateTime(alert.createdAt)} />
            </dl>
          </Card>

          {alert.alertContext && <LevelContextCard context={alert.alertContext} />}

          {!alert.alertContext && statusTimelineCard}
        </div>
      </div>

      {/* Primary workflow. Both panels stay mounted after first activation
          (see TabPanel), so switching tabs never discards unsaved input or
          refetches — and the review/journal panels make no request at all
          until their tab is opened. */}
      <div className="flex flex-col gap-4">
        <TabList tabs={WORKFLOW_TABS} activeId={activeTab} onChange={setActiveTab} label="Alert workflow" />

        <TabPanel id="plan" activeId={activeTab}>
          <ExtremeRRPlanner alert={alert} />

          {!isDirectional && (
            <Card className="p-4">
              <p className="text-sm text-slate-500">
                Extreme RR plans are generated for LONG and SHORT alerts only. Use the manual
                calculator below to work through this alert by hand.
              </p>
            </Card>
          )}

          {/* Secondary: the manual what-if calculator, collapsed by default. */}
          <Disclosure
            title="Manual Risk Calculator"
            description="Optional manual calculation and saved review values"
          >
            <FuturesRiskPlanner alert={alert} embedded />
          </Disclosure>
        </TabPanel>

        <TabPanel id="review" activeId={activeTab}>
          <TradeOutcomePanel alertId={alert.id} />
          <TradeJournalPanel alertId={alert.id} />
        </TabPanel>

        {/*
          The Execution tab was declared in WORKFLOW_TABS and its panel was
          imported, but no TabPanel ever rendered it — so clicking "Execution"
          showed an empty area. That is why an alert with no execution looked
          like it had simply vanished from the pipeline.
        */}
        <TabPanel id="execution" activeId={activeTab}>
          <AlertExecutionPanel alert={alert} />
        </TabPanel>

        <TabPanel id="ai" activeId={activeTab}>
          <AiOpinionPanel alert={alert} />
        </TabPanel>
      </div>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-200">Raw webhook payload</h2>
        <pre className="max-h-80 overflow-auto rounded-lg bg-surface p-3 text-xs text-slate-400">
          {JSON.stringify(alert.rawPayload, null, 2)}
        </pre>
      </Card>
    </div>
  );
}

/**
 * One side of the Newer/Older navigation. "Newer/Older" (not Previous/Next)
 * because the dashboard is ordered newest-first — direction is unambiguous.
 * Rendered as inert text while neighbors load (subtle: same label, dimmed)
 * and when there is no neighbor in that direction.
 */
function NeighborLink({
  direction,
  neighbor,
  loading,
  search,
}: {
  direction: "newer" | "older";
  neighbor: AlertNeighbor | null;
  loading: boolean;
  search: string;
}) {
  const label = direction === "newer" ? "← Newer alert" : "Older alert →";
  if (loading) {
    return <span className="animate-pulse text-slate-700">{label}</span>;
  }
  if (!neighbor) {
    return (
      <span aria-disabled="true" className="cursor-default select-none text-slate-700">
        {label}
      </span>
    );
  }
  return (
    <Link
      to={{ pathname: `/alerts/${neighbor.id}`, search }}
      title={neighbor.symbol}
      className="text-slate-400 hover:text-slate-200"
    >
      {label}
    </Link>
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
