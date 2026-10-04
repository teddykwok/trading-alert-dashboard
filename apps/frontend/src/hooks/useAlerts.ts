import { useCallback, useEffect, useRef, useState } from "react";
import { alertsApi } from "../api/alerts.api";
import { acceptLiveAlert, insertLiveAlert } from "../features/alerts/liveAlerts";
import type { Alert } from "../types/alert";
import type { AlertListQuery } from "../types/api";

function appendDeduped(existing: Alert[], incoming: Alert[]): Alert[] {
  const seen = new Set(existing.map((alert) => alert.id));
  return [...existing, ...incoming.filter((alert) => !seen.has(alert.id))];
}

/**
 * Server-paged alert list. No `limit` is sent — the backend's env-configured
 * default (DASHBOARD_DEFAULT_LIMIT, 100) decides the page size, so the page
 * size is tuned in ONE place. `loadMore` fetches the next offset with the
 * same server-side filters and appends, deduplicated by id.
 *
 * Why plain offset paging is safe here (newest-first, createdAt+id ordered):
 * a row INSERTED at the top between page requests shifts the window down, so
 * the next page re-serves the tail of the previous page — dedupe absorbs it,
 * nothing is skipped. Rows are only DELETED by the 03:00 retention job (from
 * the oldest end) or a manual delete, which can skip at most that many rows
 * for one paging session and self-heals on the next refetch. `hasMore`
 * re-reads `total` from every response, so it converges rather than sticking.
 *
 * Filter changes reset paging and refetch page one, debounced briefly so the
 * symbol search box doesn't fire a request per keystroke. A generation
 * counter discards responses from a superseded filter state, so a slow page-A
 * response can never overwrite (or append into) page-B results.
 */
export function useAlerts(filters: AlertListQuery) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Next server page offset. Tracked separately from alerts.length because
  // socket-pushed alerts are prepended locally and must not shift the
  // server-side paging window.
  const nextOffsetRef = useRef(0);
  // Bumped on every filter-driven refetch; in-flight responses that lost the
  // race check it before touching state.
  const generationRef = useRef(0);
  // Every alert id this list has already counted (REST pages + accepted live
  // alerts). The one place a live alert's uniqueness is decided.
  const knownIdsRef = useRef<Set<string>>(new Set());

  const filtersKey = JSON.stringify(filters);

  const refetch = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await alertsApi.list({ ...filters, offset: 0 });
      if (generation !== generationRef.current) return;
      nextOffsetRef.current = response.items.length;
      knownIdsRef.current = new Set(response.items.map((alert) => alert.id));
      setAlerts(response.items);
      setTotal(response.total);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load alerts");
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await alertsApi.list({ ...filters, offset: nextOffsetRef.current });
      if (generation !== generationRef.current) return;
      nextOffsetRef.current += response.items.length;
      for (const alert of response.items) knownIdsRef.current.add(alert.id);
      setTotal(response.total);
      setAlerts((previous) => appendDeduped(previous, response.items));
    } catch (err) {
      if (generation === generationRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load more alerts");
      }
    } finally {
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, loadingMore]);

  useEffect(() => {
    const timer = setTimeout(refetch, 250);
    return () => clearTimeout(timer);
  }, [refetch]);

  /**
   * A live socket alert: the card is inserted (or replaced) exactly as before,
   * and a GENUINELY new alert that matches the active filters adds one to the
   * server total. A duplicate frame changes neither the list length nor the
   * total. The server paging offset is deliberately left alone (see above): the
   * next page's re-served tail row is absorbed by dedupe, and the next refetch
   * replaces the total with the server's truth.
   */
  const applyLiveAlert = useCallback(
    (alert: Alert) => {
      const { totalDelta } = acceptLiveAlert(knownIdsRef.current, alert, filters);
      setAlerts((previous) => insertLiveAlert(previous, alert));
      if (totalDelta === 1) setTotal((current) => current + 1);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtersKey]
  );

  const hasMore = alerts.length > 0 && nextOffsetRef.current < total;

  return { alerts, setAlerts, total, loading, loadingMore, hasMore, error, refetch, loadMore, applyLiveAlert };
}
