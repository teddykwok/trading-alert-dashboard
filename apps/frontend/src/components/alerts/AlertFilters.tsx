import {
  ALERT_STATUSES,
  ASSET_TYPES,
  LEVEL_COLORS,
  SIGNAL_TYPES,
  SOURCE_TIMEFRAMES,
} from "@trading-alert-dashboard/shared";
import { Button } from "../ui/Button";
import { DIRECTIONAL_SIGNALS } from "../../hooks/useFilters";
import { classNames } from "../../utils/classNames";
import type { SignalType, SourceTimeframe } from "../../types/alert";
import type { AlertListQuery } from "../../types/api";

// Dropdown option value for the LONG+SHORT group. WATCH/EXIT remain fully
// selectable — they are just not part of the default "Long + Short only" view.
//
// This is a SIGNAL-DIRECTION filter (the `signals` query), for every source.
// It never meant execution eligibility: a NATIVE alert is LONG or SHORT and so
// matches it, while remaining dashboard-only. The label says what it does.
const DIRECTIONAL_OPTION = "DIRECTIONAL";
const DIRECTIONAL_KEY = [...DIRECTIONAL_SIGNALS].sort().join(",");

export const DIRECTIONAL_FILTER_LABEL = "Long + Short only";
export const DIRECTIONAL_FILTER_TITLE =
  "Signal direction filter: LONG + SHORT alerts from every source (WATCH/EXIT are available below). It is not an execution-eligibility filter — Native alerts are dashboard-only.";

/** Maps the current signals filter back to the <select> value. */
function signalSelectValue(signals: SignalType[] | undefined): string {
  if (!signals || signals.length === 0) return ""; // All signals
  if (signals.length === 1) return signals[0];
  return [...signals].sort().join(",") === DIRECTIONAL_KEY ? DIRECTIONAL_OPTION : "";
}

/** Maps a <select> value to the signals filter (undefined = all signals). */
function signalsForSelectValue(value: string): SignalType[] | undefined {
  if (value === "") return undefined;
  if (value === DIRECTIONAL_OPTION) return [...DIRECTIONAL_SIGNALS];
  return [value as SignalType];
}

/** Chip toggle: add/remove one TF; an emptied selection means "all" (undefined). */
function toggleSourceTimeframe(
  current: SourceTimeframe[] | undefined,
  tf: SourceTimeframe
): SourceTimeframe[] | undefined {
  const next = current?.includes(tf)
    ? current.filter((entry) => entry !== tf)
    : [...(current ?? []), tf];
  return next.length > 0 ? next : undefined;
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
        title={DIRECTIONAL_FILTER_TITLE}
      >
        <option value={DIRECTIONAL_OPTION}>{DIRECTIONAL_FILTER_LABEL}</option>
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

      {/* Multi-select source-timeframe chips (OR semantics): click to toggle,
          no selection = all source TFs. */}
      <div
        className="flex items-center gap-1 rounded-lg border border-surface-border bg-surface px-2 py-1"
        title="Timeframe the level originated on — select several; none = all"
      >
        <span className="pr-1 text-xs text-slate-500">Source TF</span>
        {SOURCE_TIMEFRAMES.map((tf) => {
          const selected = filters.sourceTimeframes?.includes(tf) ?? false;
          return (
            <button
              key={tf}
              type="button"
              aria-pressed={selected}
              onClick={() => setFilter("sourceTimeframes", toggleSourceTimeframe(filters.sourceTimeframes, tf))}
              className={classNames(
                "rounded-md px-1.5 py-0.5 text-xs transition-colors",
                selected
                  ? "bg-blue-600 font-semibold text-white"
                  : "text-slate-400 hover:bg-surface-border hover:text-slate-200"
              )}
            >
              {tf}
            </button>
          );
        })}
      </div>

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
