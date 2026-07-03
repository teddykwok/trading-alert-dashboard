import { useMemo } from "react";
import { Card } from "../components/ui/Card";
import { AlertFeed } from "../components/alerts/AlertFeed";
import { AlertFilters } from "../components/alerts/AlertFilters";
import { useAlerts } from "../hooks/useAlerts";
import { useSocketAlerts } from "../hooks/useSocketAlerts";
import { useFilters } from "../hooks/useFilters";
import type { Alert } from "../types/alert";

function isToday(value: string): boolean {
  const date = new Date(value);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function matchesFilters(alert: Alert, filters: ReturnType<typeof useFilters>["filters"]): boolean {
  if (filters.status && alert.status !== filters.status) return false;
  if (filters.signal && alert.signal !== filters.signal) return false;
  if (filters.assetType && alert.assetType !== filters.assetType) return false;
  if (filters.symbol && !alert.symbol.toLowerCase().includes(filters.symbol.toLowerCase())) return false;
  return true;
}

export function DashboardPage() {
  const { filters, setFilter, reset, hasActiveFilters } = useFilters();
  const { alerts, setAlerts, loading } = useAlerts({ limit: 200 });
  useSocketAlerts(setAlerts);

  const stats = useMemo(() => {
    const todayAlerts = alerts.filter((a) => isToday(a.createdAt));
    return {
      total: todayAlerts.length,
      long: todayAlerts.filter((a) => a.signal === "LONG").length,
      short: todayAlerts.filter((a) => a.signal === "SHORT").length,
      analyzed: todayAlerts.filter((a) => a.status === "ANALYZED").length,
      failed: todayAlerts.filter((a) => a.status === "FAILED").length,
    };
  }, [alerts]);

  const filteredAlerts = useMemo(
    () => alerts.filter((alert) => matchesFilters(alert, filters)),
    [alerts, filters]
  );

  const statCards = [
    { label: "Total alerts today", value: stats.total },
    { label: "Long signals", value: stats.long },
    { label: "Short signals", value: stats.short },
    { label: "AI analyzed", value: stats.analyzed },
    { label: "Failed", value: stats.failed },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {statCards.map((card) => (
          <Card key={card.label} className="p-3">
            <p className="text-xs text-slate-500">{card.label}</p>
            <p className="mt-1 text-2xl font-semibold text-slate-100">{card.value}</p>
          </Card>
        ))}
      </div>

      <AlertFilters filters={filters} setFilter={setFilter} reset={reset} hasActiveFilters={hasActiveFilters} />

      <AlertFeed alerts={filteredAlerts} loading={loading} />
    </div>
  );
}
