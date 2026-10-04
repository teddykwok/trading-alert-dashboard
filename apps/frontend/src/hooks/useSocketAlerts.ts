import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { getSocket } from "../sockets/socket";
import { SOCKET_EVENTS } from "../sockets/socket-events";
import { insertLiveAlert } from "../features/alerts/liveAlerts";
import type { Alert } from "../types/alert";

/**
 * Wires the shared Socket.IO connection to an alerts state setter:
 * - new_alert: prepend to the feed (or hand it to `onNewAlert`, which owns the
 *   list's uniqueness and total bookkeeping, e.g. useAlerts().applyLiveAlert)
 * - alert_updated / alert_failed / alert_duplicate: patch the matching alert in place
 */
export function useSocketAlerts(setAlerts: Dispatch<SetStateAction<Alert[]>>, onNewAlert?: (alert: Alert) => void): void {
  useEffect(() => {
    const socket = getSocket();

    function handleNewAlert(alert: Alert) {
      if (onNewAlert) onNewAlert(alert);
      else setAlerts((prev) => insertLiveAlert(prev, alert));
    }

    function handleAlertUpdated(alert: Alert) {
      setAlerts((prev) => prev.map((a) => (a.id === alert.id ? alert : a)));
    }

    socket.on(SOCKET_EVENTS.NEW_ALERT, handleNewAlert);
    socket.on(SOCKET_EVENTS.ALERT_UPDATED, handleAlertUpdated);
    socket.on(SOCKET_EVENTS.ALERT_FAILED, handleAlertUpdated);
    socket.on(SOCKET_EVENTS.ALERT_DUPLICATE, handleAlertUpdated);

    return () => {
      socket.off(SOCKET_EVENTS.NEW_ALERT, handleNewAlert);
      socket.off(SOCKET_EVENTS.ALERT_UPDATED, handleAlertUpdated);
      socket.off(SOCKET_EVENTS.ALERT_FAILED, handleAlertUpdated);
      socket.off(SOCKET_EVENTS.ALERT_DUPLICATE, handleAlertUpdated);
    };
  }, [setAlerts, onNewAlert]);
}
