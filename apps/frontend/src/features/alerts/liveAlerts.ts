import type { Alert } from "../../types/alert";

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
