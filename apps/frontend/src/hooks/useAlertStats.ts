import { useCallback, useEffect, useRef, useState } from "react";
import type { AlertStats } from "@trading-alert-dashboard/shared";
import { alertsApi } from "../api/alerts.api";
import { getSocket } from "../sockets/socket";
import { SOCKET_EVENTS } from "../sockets/socket-events";

/** One refetch per burst of alerts rather than one per alert (2–6/min arrive). */
const REFRESH_DEBOUNCE_MS = 1000;

/**
 * The viewer's local day as ISO instants: [start of today, start of tomorrow).
 * Day arithmetic goes through the Date constructor so month/year rollover and
 * DST shifts are handled by the platform.
 */
export function todayRange(now: Date = new Date()): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

/**
 * Today's alert statistics, counted in the database.
 *
 * Deliberately takes no list filters and no loaded alerts: the cards describe
 * the whole day, so neither the 100-alert page size nor the feed's filters can
 * change them. The range is recomputed per request, so a dashboard left open
 * across midnight rolls over on the next refresh.
 */
export function useAlertStats() {
  const [stats, setStats] = useState<AlertStats | null>(null);
  const [error, setError] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const refresh = useCallback(async () => {
    try {
      setStats(await alertsApi.stats(todayRange()));
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void refresh();

    const socket = getSocket();
    function scheduleRefresh() {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
    }

    // A new alert changes the totals; status transitions move an alert between
    // the processing/analyzed/failed cards. ALERT_DUPLICATE is not subscribed:
    // a suppressed duplicate only increments a counter on an existing alert,
    // so no count changes.
    socket.on(SOCKET_EVENTS.NEW_ALERT, scheduleRefresh);
    socket.on(SOCKET_EVENTS.ALERT_UPDATED, scheduleRefresh);
    socket.on(SOCKET_EVENTS.ALERT_FAILED, scheduleRefresh);

    return () => {
      clearTimeout(timerRef.current);
      socket.off(SOCKET_EVENTS.NEW_ALERT, scheduleRefresh);
      socket.off(SOCKET_EVENTS.ALERT_UPDATED, scheduleRefresh);
      socket.off(SOCKET_EVENTS.ALERT_FAILED, scheduleRefresh);
    };
  }, [refresh]);

  return { stats, error, refresh };
}
