import { AlertCard } from "./AlertCard";
import { EmptyState } from "../ui/EmptyState";
import type { Alert } from "../../types/alert";

interface AlertFeedProps {
  alerts: Alert[];
  loading: boolean;
}

export function AlertFeed({ alerts, loading }: AlertFeedProps) {
  if (loading && alerts.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-500">Loading alerts…</p>;
  }

  if (alerts.length === 0) {
    return (
      <EmptyState
        title="No alerts yet"
        description="Fire a TradingView webhook (or use the curl example on the Settings page) to see live alerts appear here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {alerts.map((alert) => (
        <AlertCard key={alert.id} alert={alert} />
      ))}
    </div>
  );
}
