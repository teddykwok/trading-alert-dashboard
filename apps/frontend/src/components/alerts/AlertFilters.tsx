import { ALERT_STATUSES, ASSET_TYPES, SIGNAL_TYPES } from "@trading-alert-dashboard/shared";
import { Button } from "../ui/Button";
import type { AlertListQuery } from "../../types/api";

interface AlertFiltersProps {
  filters: AlertListQuery;
  setFilter: <K extends keyof AlertListQuery>(key: K, value: AlertListQuery[K]) => void;
  reset: () => void;
  hasActiveFilters: boolean;
}

const selectClass =
  "rounded-lg border border-surface-border bg-surface px-2.5 py-1.5 text-sm text-slate-200 focus:border-blue-500 focus:outline-none";

export function AlertFilters({ filters, setFilter, reset, hasActiveFilters }: AlertFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        placeholder="Symbol (e.g. BTCUSDT)"
        value={filters.symbol ?? ""}
        onChange={(e) => setFilter("symbol", e.target.value || undefined)}
        className={selectClass}
      />

      <select
        value={filters.signal ?? ""}
        onChange={(e) => setFilter("signal", (e.target.value || undefined) as AlertListQuery["signal"])}
        className={selectClass}
      >
        <option value="">All signals</option>
        {SIGNAL_TYPES.map((signal) => (
          <option key={signal} value={signal}>
            {signal}
          </option>
        ))}
      </select>

      <select
        value={filters.status ?? ""}
        onChange={(e) => setFilter("status", (e.target.value || undefined) as AlertListQuery["status"])}
        className={selectClass}
      >
        <option value="">All statuses</option>
        {ALERT_STATUSES.map((status) => (
          <option key={status} value={status}>
            {status}
          </option>
        ))}
      </select>

      <select
        value={filters.assetType ?? ""}
        onChange={(e) => setFilter("assetType", (e.target.value || undefined) as AlertListQuery["assetType"])}
        className={selectClass}
      >
        <option value="">All assets</option>
        {ASSET_TYPES.map((assetType) => (
          <option key={assetType} value={assetType}>
            {assetType}
          </option>
        ))}
      </select>

      {hasActiveFilters && (
        <Button variant="ghost" onClick={reset}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
