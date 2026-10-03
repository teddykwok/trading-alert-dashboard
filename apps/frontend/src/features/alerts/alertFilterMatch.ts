import type { Alert } from "../../types/alert";
import type { AlertListQuery } from "../../types/api";

/**
 * Client-side guard on top of the server-side filters. Fetched pages already
 * match (the backend applies the same filters), so this only affects alerts
 * PREPENDED by the realtime socket — which bypass the server query — and gives
 * instant feedback on already-loaded alerts during the brief debounce window
 * after a filter change. For sourceTimeframe/levelColor it also keeps matching
 * legacy alerts on the parsed-note fallback via alertContext.
 *
 * Every filter is independent: the SOURCE filter (TradingView / Native) never
 * reinterprets the signal-direction filter, and vice versa.
 */
export function matchesFilters(alert: Alert, filters: AlertListQuery): boolean {
  if (filters.status && alert.status !== filters.status) return false;
  if (filters.signal && alert.signal !== filters.signal) return false;
  // Multi-signal filter from the dashboard dropdown: "Long + Short only" (a
  // signal-direction filter, the default) = ["LONG", "SHORT"]; a single choice
  // = one-element array; undefined = "All signals" (WATCH/EXIT included).
  if (filters.signals && filters.signals.length > 0 && !filters.signals.includes(alert.signal)) {
    return false;
  }
  // Source filter: an alert from a server that predates the column is TRADINGVIEW.
  if (filters.source && (alert.source ?? "TRADINGVIEW") !== filters.source) return false;
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
    (alert.alertContext?.sourceTimeframe == null || !filters.sourceTimeframes.includes(alert.alertContext.sourceTimeframe))
  ) {
    return false;
  }
  if (filters.levelColor && alert.alertContext?.levelColor !== filters.levelColor) return false;
  return true;
}
