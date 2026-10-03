import { useEffect, useState } from "react";

import { signalSourcesApi, type SignalSourcesStatusDto } from "../api/signalSources.api";

export const SIGNAL_SOURCES_POLL_MS = 30_000;

/** Read-only status of both signal sources, polled while visible. */
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
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      read();
    }, SIGNAL_SOURCES_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { status, unreachable };
}
