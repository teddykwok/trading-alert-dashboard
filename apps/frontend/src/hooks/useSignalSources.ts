import { useEffect, useState } from "react";

import { applyLiveNativeDelivery, signalSourcesApi, type SignalSourcesStatusDto } from "../api/signalSources.api";
import { getSocket } from "../sockets/socket";
import { SOCKET_EVENTS } from "../sockets/socket-events";
import type { Alert } from "../types/alert";

export const SIGNAL_SOURCES_POLL_MS = 30_000;

/**
 * Read-only status of both signal sources, polled while visible. A live NATIVE
 * `new_alert` also moves the Native "Last delivered" immediately (see
 * applyLiveNativeDelivery); the poll stays the truth.
 */
export function useSignalSources(): { status: SignalSourcesStatusDto | null; unreachable: boolean } {
  const [status, setStatus] = useState<SignalSourcesStatusDto | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      signalSourcesApi
        .status()
        .then((next) => {
          if (cancelled) return;
          setStatus(next);
          setUnreachable(false);
        })
        .catch(() => {
          if (!cancelled) setUnreachable(true);
        });
    };
    read();
    // The same canonical event the dashboard card is built from.
    const socket = getSocket();
    const onNewAlert = (alert: Alert) => {
      if (!cancelled) setStatus((previous) => applyLiveNativeDelivery(previous, alert));
    };
    socket.on(SOCKET_EVENTS.NEW_ALERT, onNewAlert);
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      read();
    }, SIGNAL_SOURCES_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      socket.off(SOCKET_EVENTS.NEW_ALERT, onNewAlert);
    };
  }, []);

  return { status, unreachable };
}
