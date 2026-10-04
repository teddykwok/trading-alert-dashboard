import type { Alert } from "../../types/alert";
import type { AlertListQuery } from "../../types/api";
import { matchesFilters } from "./alertFilterMatch";

/**
 * A live `new_alert` (TradingView or Native — the same canonical event) goes to
 * the top of the feed. The canonical Alert ID is the identity: an alert already
 * present from the REST load, a refetch or an earlier push is REPLACED, never
 * shown twice. Visibility under the current filters is decided by the page's
 * filter matcher, not here. The socket is a low-latency hint; the database (via
 * the next REST load) stays the truth.
 */
export function insertLiveAlert(prev: Alert[], alert: Alert): Alert[] {
  return [alert, ...prev.filter((a) => a.id !== alert.id)];
}

/**
 * Whether a live alert is GENUINELY new to this list, and what it does to the
 * server's "matching alerts" total.
 *
 * `known` holds every alert id this list has already counted — every id from
 * the REST pages plus every live alert accepted since. It is the single place
 * uniqueness is decided, so a duplicate socket frame (or a push for an alert the
 * REST load already returned) never counts twice. Only a new alert that matches
 * the active filters adds one to the total: the total is "matching alerts", and
 * a hidden alert is not one of them. A refetch replaces `known` and the total
 * with the server's truth, so any drift reconciles on the next load.
 *
 * Mutates `known` (it is a ref's Set, deliberately outside React state so the
 * decision runs exactly once per frame even under StrictMode's double-invoked
 * state updaters).
 */
export function acceptLiveAlert(known: Set<string>, alert: Alert, filters: AlertListQuery): { isNew: boolean; totalDelta: 0 | 1 } {
  if (known.has(alert.id)) return { isNew: false, totalDelta: 0 };
  known.add(alert.id);
  return { isNew: true, totalDelta: matchesFilters(alert, filters) ? 1 : 0 };
}
