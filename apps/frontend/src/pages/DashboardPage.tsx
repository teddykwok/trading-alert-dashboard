import { useMemo } from "react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { AlertFeed } from "../components/alerts/AlertFeed";
import { AlertFilters } from "../components/alerts/AlertFilters";
import { OutcomeSummary } from "../components/alerts/OutcomeSummary";
import { TradeDisciplineSummary } from "../components/alerts/TradeDisciplineSummary";
import { useAlerts } from "../hooks/useAlerts";
import { useAlertStats } from "../hooks/useAlertStats";
import { useSocketAlerts } from "../hooks/useSocketAlerts";
import { useFilters } from "../hooks/useFilters";
import type { Alert } from "../types/alert";

/**
 * Client-side guard on top of the server-side filters. Fetched pages already
 * match (the backend applies the same filters), so this only affects alerts
 * PREPENDED by the realtime socket — which bypass the server query — and
 * gives instant feedback on already-loaded alerts during the brief debounce
 * window after a filter change. For sourceTimeframe/levelColor it also keeps
 * matching legacy alerts on the parsed-note fallback via alertContext.
 */
function matchesFilters(alert: Alert, filters: ReturnType<typeof useFilters>["filters"]): boolean {
  if (filters.status && alert.status !== filters.status) return false;
  if (filters.signal && alert.signal !== filters.signal) return false;
  // Multi-signal filter from the dashboard dropdown: "Actionable only"
  // (the default) = ["LONG", "SHORT"]; a single choice = one-element array;
  // undefined = "All signals" (nothing excluded, WATCH/EXIT included).
  if (filters.signals && filters.signals.length > 0 && !filters.signals.includes(alert.signal)) {
    return false;
  }
  if (filters.assetType && alert.assetType !== filters.assetType) return false;
  if (filters.symbol && !alert.symbol.toLowerCase().includes(filters.symbol.toLowerCase())) return false;
  // Level-context filters match on alertContext, which the backend derives
  // from structured columns with a note-parsing fallback — so legacy alerts
  // whose metadata only lives in the note are filtered correctly too.
  if (filters.sourceTimeframe && alert.alertContext?.sourceTimeframe !== filters.sourceTimeframe) return false;
  // Multi-source-timeframe filter (OR semantics): the alert's level-origin TF
  // must be one of the selected values; undefined/empty = all source TFs.
  if (
    filters.sourceTimeframes &&
    filters.sourceTimeframes.length > 0 &&
    (alert.alertContext?.sourceTimeframe == null ||
      !filters.sourceTimeframes.includes(alert.alertContext.sourceTimeframe))
  ) {
    return false;
  }
  if (filters.levelColor && alert.alertContext?.levelColor !== filters.levelColor) return false;
  return true;
}

export function DashboardPage() {
  const { filters, setFilter, reset, hasActiveFilters } = useFilters();
  // Filters are sent to the server, so each page is "the next 100 matching
  // alerts" (page size = backend DASHBOARD_DEFAULT_LIMIT). loadMore appends
  // older retained alerts with the same filters.
  const { alerts, setAlerts, total, loading, loadingMore, hasMore, error, loadMore } =
    useAlerts(filters);
  useSocketAlerts(setAlerts);

  // Counted in the database over the whole day: independent of the list's
  // filters and of how many pages are loaded. Never derive these from
  // `alerts` — that is one filtered page, not today.
  const { stats } = useAlertStats();

  const filteredAlerts = useMemo(
    () => alerts.filter((alert) => matchesFilters(alert, filters)),
    [alerts, filters]
  );

  const statCards = [
    { label: "Total alerts today", value: stats?.total },
    { label: "Long signals", value: stats?.long },
    { label: "Short signals", value: stats?.short },
    { label: "AI analyzed", value: stats?.analyzed },
    { label: "Processing", value: stats?.processing },
    { label: "Failed", value: stats?.failed },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {statCards.map((card) => (
          <Card key={card.label} className="p-3">
            <p className="text-xs text-slate-500">{card.label}</p>
            <p className="mt-1 text-2xl font-semibold text-slate-100">{card.value ?? "…"}</p>
          </Card>
        ))}
      </div>

      <OutcomeSummary />

      <TradeDisciplineSummary />

      <AlertFilters filters={filters} setFilter={setFilter} reset={reset} hasActiveFilters={hasActiveFilters} />

      {error && <p className="text-center text-sm text-red-400">{error}</p>}

      {/* Scope of the list itself — the stat cards above cover the whole day. */}
      {!loading && filteredAlerts.length > 0 && (
        <p className="text-xs text-slate-500">
          Showing {filteredAlerts.length} of {total} matching alerts
        </p>
      )}

      <AlertFeed alerts={filteredAlerts} loading={loading} />

      {hasMore && (
        <div className="flex justify-center pb-2">
          <Button variant="secondary" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load older alerts"}
          </Button>
        </div>
      )}
    </div>
  );
}
