import {
  ALERT_STATUSES,
  ASSET_TYPES,
  LEVEL_COLORS,
  SIGNAL_TYPES,
  SOURCE_TIMEFRAMES,
} from "@trading-alert-dashboard/shared";
import { Button } from "../ui/Button";
import { ACTIONABLE_SIGNALS } from "../../hooks/useFilters";
import type { SignalType } from "../../types/alert";
import type { AlertListQuery } from "../../types/api";

// Dropdown option value for the LONG+SHORT group. WATCH/EXIT remain fully
// selectable — they are just not part of the default "Actionable only" view.
const ACTIONABLE_OPTION = "ACTIONABLE";
const ACTIONABLE_KEY = [...ACTIONABLE_SIGNALS].sort().join(",");

/** Maps the current signals filter back to the <select> value. */
function signalSelectValue(signals: SignalType[] | undefined): string {
  if (!signals || signals.length === 0) return ""; // All signals
  if (signals.length === 1) return signals[0];
  return [...signals].sort().join(",") === ACTIONABLE_KEY ? ACTIONABLE_OPTION : "";
}

/** Maps a <select> value to the signals filter (undefined = all signals). */
function signalsForSelectValue(value: string): SignalType[] | undefined {
  if (value === "") return undefined;
  if (value === ACTIONABLE_OPTION) return [...ACTIONABLE_SIGNALS];
  return [value as SignalType];
}

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
        value={signalSelectValue(filters.signals)}
        onChange={(e) => setFilter("signals", signalsForSelectValue(e.target.value))}
        className={selectClass}
        title="Actionable only = LONG + SHORT; WATCH/EXIT are still available below"
      >
        <option value={ACTIONABLE_OPTION}>Actionable only</option>
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

      <select
        value={filters.sourceTimeframe ?? ""}
        onChange={(e) =>
          setFilter("sourceTimeframe", (e.target.value || undefined) as AlertListQuery["sourceTimeframe"])
        }
        className={selectClass}
        title="Timeframe the level originated on"
      >
        <option value="">All source TFs</option>
        {SOURCE_TIMEFRAMES.map((tf) => (
          <option key={tf} value={tf}>
            Level {tf}
          </option>
        ))}
      </select>

      <select
        value={filters.levelColor ?? ""}
        onChange={(e) => setFilter("levelColor", (e.target.value || undefined) as AlertListQuery["levelColor"])}
        className={selectClass}
      >
        <option value="">All level colors</option>
        {LEVEL_COLORS.map((color) => (
          <option key={color} value={color}>
            {color === "GREEN" ? "Green" : "Red"}
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
