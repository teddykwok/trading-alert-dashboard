import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigationType } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { AlertFeed } from "../components/alerts/AlertFeed";
import { AlertFilters } from "../components/alerts/AlertFilters";
import { OutcomeSummary } from "../components/alerts/OutcomeSummary";
import { TradeDisciplineSummary } from "../components/alerts/TradeDisciplineSummary";
import { SignalSourcesCard } from "../components/alerts/SignalSourcesCard";
import { matchesFilters } from "../features/alerts/alertFilterMatch";
import { useAlerts } from "../hooks/useAlerts";
import { useAlertStats } from "../hooks/useAlertStats";
import { useSocketAlerts } from "../hooks/useSocketAlerts";
import { canonicalFilterSearch, useFilters } from "../hooks/useFilters";
import {
  loadDashboardScrollState,
  saveDashboardScrollState,
} from "../utils/dashboardScrollState";

export function DashboardPage() {
  const { filters, setFilter, reset, hasActiveFilters } = useFilters();
  // Filters are sent to the server, so each page is "the next 100 matching
  // alerts" (page size = backend DASHBOARD_DEFAULT_LIMIT). loadMore appends
  // older retained alerts with the same filters.
  const { alerts, setAlerts, total, loading, loadingMore, hasMore, error, loadMore, applyLiveAlert } =
    useAlerts(filters);
  // A live alert updates the card list AND, when genuinely new and matching, the total.
  useSocketAlerts(setAlerts, applyLiveAlert);

  const location = useLocation();
  const navigationType = useNavigationType();
  // Identity of the current filter context — keys the per-view scroll state
  // so one filtered view's position can never leak into another's.
  const canonicalSearch = useMemo(() => canonicalFilterSearch(filters), [filters]);

  // Restore only when REVISITING from an alert-review context: the detail
  // page's "Back to filtered results" link tags its navigation with router
  // state, and browser Back arrives as a POP. Fresh pushes (sidebar click,
  // filter link) start at the top as usual. Decided once at mount — read in
  // the state initializer so it runs before any effect can write storage.
  const [restorePlan] = useState(() => {
    const fromReview =
      (location.state as { restoreDashboardScroll?: boolean } | null)?.restoreDashboardScroll ===
      true;
    if (!fromReview && navigationType !== "POP") return null;
    const saved = loadDashboardScrollState(canonicalSearch);
    return saved ? { ...saved, key: canonicalSearch } : null;
  });
  const restoreDoneRef = useRef(false);

  // Latest values for the unmount save, without re-subscribing any effect.
  const saveStateRef = useRef({ canonicalSearch, loadedCount: alerts.length });
  saveStateRef.current = { canonicalSearch, loadedCount: alerts.length };

  // Last user-driven scroll position, kept fresh by a passive listener. The
  // unmount save MUST read this ref, never live window.scrollY: unmount
  // happens during a route swap, when the dashboard's tall DOM is being (or
  // has been) replaced by the next page's short one — reading the live value
  // then can only see the browser's already-clamped ~0, and it forces a
  // reflow against the mutated document.
  const lastScrollYRef = useRef(0);

  // Save on unmount — this covers opening an AlertCard and every other way of
  // leaving the dashboard. A LAYOUT effect, not a passive one: its cleanup
  // runs synchronously inside React's commit, before the browser can reflow
  // the shrunken document and dispatch a clamp scroll event that would
  // overwrite the ref with 0. Nothing to save before the first page has
  // rendered (also keeps StrictMode's simulated unmount from writing a bogus
  // zero state).
  useLayoutEffect(() => {
    lastScrollYRef.current = window.scrollY;
    const onScroll = () => {
      lastScrollYRef.current = window.scrollY;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      const { canonicalSearch: key, loadedCount } = saveStateRef.current;
      if (loadedCount > 0) {
        saveDashboardScrollState(key, { scrollY: lastScrollYRef.current, loadedCount });
      }
    };
  }, []);

  // Restoration state machine, driven by the list's own loading state:
  // 1) wait for the (debounced) first page, 2) replay "Load older alerts"
  // through the normal loadMore path — keeping its generation/stale-response
  // protection — until the previous depth is reached or the data runs out,
  // 3) after that content renders, apply the saved scrollY once, clamped to
  // the actual document height. restoreDoneRef guarantees a single final
  // scroll and makes an infinite load/restore loop impossible.
  useEffect(() => {
    if (!restorePlan || restoreDoneRef.current) return;
    // A filter change mid-restore switches context; the plan belongs to the
    // old view, so abandon it rather than fight the new fetch.
    if (canonicalSearch !== restorePlan.key) {
      restoreDoneRef.current = true;
      return;
    }
    if (loading || loadingMore) return;
    if (alerts.length < restorePlan.loadedCount && hasMore) {
      loadMore();
      return;
    }
    restoreDoneRef.current = true;
    requestAnimationFrame(() => {
      const maxY = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, Math.min(restorePlan.scrollY, Math.max(0, maxY)));
    });
  }, [restorePlan, canonicalSearch, alerts.length, loading, loadingMore, hasMore, loadMore]);

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

      {/* Where signals come from: TradingView webhook and the Native scanner. Read-only. */}
      <SignalSourcesCard />

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
