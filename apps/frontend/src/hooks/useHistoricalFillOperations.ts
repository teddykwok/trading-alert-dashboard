import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchHistoricalFillOperations,
  type HistoricalFillOperationsDto,
} from "../api/operator";
import type { OperatorAccountId } from "../api/operator-account";
import { hasOperatorToken, subscribeOperatorToken } from "../api/operator-token";
import { isSessionEnded } from "../features/operator/operatorSession";

/**
 * How often the panel re-reads the snapshot.
 *
 * Matches the Trading Control status cadence, because it is the same class of
 * read: counts and minimums from the local database, no preflight and no
 * exchange call. Declared separately rather than imported so the two panels can
 * diverge deliberately later instead of by accident.
 */
export const HISTORICAL_FILL_OPERATIONS_POLL_MS = 15_000;

export interface HistoricalFillOperationsHandle {
  snapshot: HistoricalFillOperationsDto | null;
  error: string | null;
  /** True only while a read is in flight with nothing yet to show. */
  loading: boolean;
  /** True while a refresh runs over an existing snapshot. */
  refreshing: boolean;
  authenticated: boolean;
  refresh: () => Promise<void>;
}

export const LOAD_FAILED_MESSAGE = "Unable to load historical fill operations.";

/**
 * The snapshot, polled while an operator session is held.
 *
 * READ ONLY. The only request this hook can make is the GET, and there is no
 * code path here that starts, retries, claims or repairs anything.
 *
 * One request at a time: a poll that arrives while a read is still running is
 * skipped rather than stacked, so a slow database cannot accumulate overlapping
 * queries. The timer is cleared on unmount and a late response from an
 * unmounted panel is discarded.
 */
export function useHistoricalFillOperations(account: OperatorAccountId): HistoricalFillOperationsHandle {
  const [snapshot, setSnapshot] = useState<HistoricalFillOperationsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [authenticated, setAuthenticated] = useState(() => hasOperatorToken(account));
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const read = useCallback(async () => {
    if (inFlight.current) return;
    if (!hasOperatorToken(account)) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const next = await fetchHistoricalFillOperations(account);
      if (!mounted.current) return;
      // The server snapshot REPLACES what was shown. Nothing is accumulated
      // client-side: the previous numbers describe a moment that has passed.
      setSnapshot(next);
      setError(null);
    } catch (caught) {
      if (!mounted.current) return;
      if (isSessionEnded(caught)) {
        // The same treatment every operator read gives a 401: the session is
        // over, so stale numbers are dropped rather than left on screen.
        setSnapshot(null);
        setError(null);
        return;
      }
      // A transport or server failure is reported as itself. It is never
      // rendered as zeros and never as PROFILE_UNAVAILABLE.
      setError(LOAD_FAILED_MESSAGE);
    } finally {
      inFlight.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, [account]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Only THIS account's token changes this panel's auth state.
  useEffect(
    () =>
      subscribeOperatorToken((changed, hasToken) => {
        if (changed === account) setAuthenticated(hasToken);
      }),
    [account]
  );

  useEffect(() => {
    if (!authenticated) {
      setSnapshot(null);
      setError(null);
      return;
    }
    void read();
    const timer = window.setInterval(() => void read(), HISTORICAL_FILL_OPERATIONS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [authenticated, read]);

  return {
    snapshot,
    error,
    loading: authenticated && snapshot === null && error === null,
    refreshing,
    authenticated,
    refresh: read,
  };
}
