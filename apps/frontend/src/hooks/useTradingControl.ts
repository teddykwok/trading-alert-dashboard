import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchTradingControlReadiness,
  fetchTradingControlStatus,
  postPauseNewTrades,
  postResumeNewTrades,
  postSafeOff,
  postStartTrading,
  postStopNewTrades,
  type TradingControlActionResult,
  type TradingControlReadinessSnapshot,
  type TradingControlStatusDto,
} from "../api/operator";
import type { StartTradingDuration } from "../api/operator";
import type { TradingControlActionId } from "../features/operator/tradingControlActions";
import { START_WINDOW_MINUTES } from "../features/operator/tradingControlActions";
import { apiClient } from "../api/client";
import { accountHealthPath, isCurrentAccountResponse, type OperatorAccountId } from "../api/operator-account";
import { clearOperatorToken, hasOperatorToken } from "../api/operator-token";
import { controlPlaneStateFromFailure, type ControlPlaneState } from "../features/operator/accountControlState";
import {
  authenticateOperator,
  isSessionEnded,
  type OperatorAuthState,
} from "../features/operator/operatorSession";

export type { OperatorAuthState };

/**
 * How often the panel re-reads status.
 *
 * Only STATUS is on this timer, and status is cheap by construction: no
 * preflight, no exchange call. Readiness is never polled — it costs signed
 * reads of the live account, so it happens when the operator asks for it and at
 * no other time.
 */
export const TRADING_CONTROL_POLL_MS = 15_000;

export interface TradingControlHandle {
  /** The ONE account every request of this handle targets. */
  account: OperatorAccountId;
  /** The selected account's control plane: reachable, offline, unauthorized, error or still loading. */
  controlPlane: ControlPlaneState;
  authState: OperatorAuthState;
  authError: string | null;
  status: TradingControlStatusDto | null;
  statusError: string | null;
  loading: boolean;
  /** Null until the operator has explicitly asked. Never filled by the poll. */
  readiness: TradingControlReadinessSnapshot | null;
  readinessError: string | null;
  checkingReadiness: boolean;
  /** The action currently in flight, or null. Blocks a second submission. */
  pendingAction: TradingControlActionId | null;
  actionResult: TradingControlActionResult | null;
  actionError: string | null;
  authenticate: (token: string) => Promise<void>;
  signOut: () => void;
  refresh: () => Promise<void>;
  checkReadiness: () => Promise<void>;
  runAction: (
    id: TradingControlActionId,
    confirmation?: string,
    durationMinutes?: number,
    tradeBudget?: number,
    unlimited?: boolean
  ) => Promise<void>;
  dismissActionResult: () => void;
}

/**
 * Operator auth plus the polled Trading Control status, for ONE account.
 *
 * The token lives only in the in-memory per-account primitive; this hook never
 * copies it into React state, so it cannot end up in a component's props, a
 * devtools snapshot or a serialized error. Every request names `account`, and
 * every response is checked against the account and generation it was issued
 * for, so a late answer for Account A can never update Account B's panel. The
 * caller mounts one instance per account (keyed by account), so switching
 * accounts starts from a clean slate.
 */
export function useTradingControl(account: OperatorAccountId, pollMs: number = TRADING_CONTROL_POLL_MS): TradingControlHandle {
  const [authState, setAuthState] = useState<OperatorAuthState>(
    hasOperatorToken(account) ? "AUTHENTICATED" : "NOT_AUTHENTICATED"
  );
  const [controlPlane, setControlPlane] = useState<ControlPlaneState>("LOADING");
  const [authError, setAuthError] = useState<string | null>(null);
  const [status, setStatus] = useState<TradingControlStatusDto | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [readiness, setReadiness] = useState<TradingControlReadinessSnapshot | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [checkingReadiness, setCheckingReadiness] = useState(false);
  const [pendingAction, setPendingAction] = useState<TradingControlActionId | null>(null);
  const [actionResult, setActionResult] = useState<TradingControlActionResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Guards against a slow response from a previous token (or account)
  // overwriting state after the operator has signed out or switched.
  const generation = useRef(0);
  const currentAccount = useRef<OperatorAccountId>(account);
  currentAccount.current = account;
  const isCurrent = (requested: { account: OperatorAccountId; generation: number }) =>
    isCurrentAccountResponse(requested, { account: currentAccount.current, generation: generation.current });

  /** Token-free liveness of the selected account's control plane, so offline is shown truthfully before sign-in. */
  const probeHealth = useCallback(async () => {
    const mine = { account, generation: generation.current };
    try {
      await apiClient.get(accountHealthPath(account));
      if (isCurrent(mine)) setControlPlane((previous) => (previous === "UNAUTHORIZED" ? previous : "REACHABLE"));
    } catch (error) {
      if (isCurrent(mine)) setControlPlane(controlPlaneStateFromFailure(error));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isCurrent reads refs only
  }, [account]);

  /**
   * A 401 from EITHER operator route ends the session.
   *
   * The token is dropped and the panel returns to the entry form rather than
   * leaving stale numbers on screen beside a quiet error — on this card, stale
   * and current look identical.
   */
  const endSession = useCallback(() => {
    clearOperatorToken(account);
    setControlPlane("UNAUTHORIZED");
    setAuthState("AUTH_FAILED");
    setAuthError("The operator token was rejected. Enter it again.");
    setStatus(null);
    setReadiness(null);
    setReadinessError(null);
    setActionResult(null);
    setActionError(null);
  }, [account]);

  const refresh = useCallback(async () => {
    if (!hasOperatorToken(account)) return;
    const mine = { account, generation: generation.current };
    setLoading(true);
    try {
      const next = await fetchTradingControlStatus(account);
      if (!isCurrent(mine)) return;
      setStatus(next);
      setStatusError(null);
      setControlPlane("REACHABLE");
    } catch (error) {
      if (!isCurrent(mine)) return;
      if (isSessionEnded(error)) {
        endSession();
        return;
      }
      // Offline is not a bad token: the session stays, the panel says offline.
      setControlPlane(controlPlaneStateFromFailure(error));
      setStatusError(error instanceof Error ? error.message : "Status could not be read.");
    } finally {
      if (isCurrent(mine)) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isCurrent reads refs only
  }, [account, endSession]);

  /**
   * The explicit readiness check. Called from the button, never from the timer.
   *
   * This is the one operator request that can cost signed reads of the live
   * account, so nothing else in this hook may invoke it.
   */
  const checkReadiness = useCallback(async () => {
    if (!hasOperatorToken(account)) return;
    const mine = { account, generation: generation.current };
    setCheckingReadiness(true);
    try {
      const next = await fetchTradingControlReadiness(account);
      if (!isCurrent(mine)) return;
      setReadiness(next);
      setReadinessError(null);
    } catch (error) {
      if (!isCurrent(mine)) return;
      if (isSessionEnded(error)) {
        endSession();
        return;
      }
      setReadinessError(error instanceof Error ? error.message : "Readiness could not be checked.");
    } finally {
      if (isCurrent(mine)) setCheckingReadiness(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isCurrent reads refs only
  }, [account, endSession]);

  const authenticate = useCallback(
    async (token: string) => {
      generation.current += 1;
      const mine = { account, generation: generation.current };
      setAuthState("AUTHENTICATING");
      setAuthError(null);
      const outcome = await authenticateOperator(account, token);
      if (!isCurrent(mine)) return;
      if (!outcome.ok) {
        setAuthState(outcome.state);
        setAuthError(outcome.message);
        setControlPlane(outcome.reason === "REJECTED" ? "UNAUTHORIZED" : outcome.reason === "UNREACHABLE" ? "UNREACHABLE" : "ERROR");
        return;
      }
      setAuthState("AUTHENTICATED");
      setControlPlane("REACHABLE");
      await refresh();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isCurrent reads refs only
    [account, refresh]
  );

  /**
   * Runs ONE operator action, then refreshes status.
   *
   * `pendingAction` is set before the request and cleared after, which is what
   * makes a double click impossible from this side. The server's own advisory
   * lock and preparation exclusivity are the real guarantee; this only avoids
   * sending a pointless second request.
   *
   * The readiness snapshot is dropped afterwards rather than re-fetched: the
   * verdict it holds was computed before the state changed, and a stale READY
   * beside a freshly armed profile is worse than showing nothing. Readiness
   * stays a question the operator asks.
   */
  const runAction = useCallback(
    async (
      id: TradingControlActionId,
      confirmation?: string,
      durationMinutes: number = START_WINDOW_MINUTES,
      // Undefined means "the server's reviewed default", which is the
      // historical budget — an existing caller that says nothing about trades
      // is never silently widened.
      tradeBudget?: number,
      unlimited?: boolean
    ) => {
      if (!hasOperatorToken(account)) return;
      if (pendingAction !== null) return;
      const mine = { account, generation: generation.current };
      setPendingAction(id);
      setActionError(null);
      try {
        // One switch rather than a nested ternary: five actions is past the
        // point where the chain reads as a decision instead of a puzzle.
        let result;
        switch (id) {
          case "START":
            result = await postStartTrading(account, confirmation ?? "", durationMinutes, tradeBudget, unlimited);
            break;
          case "PAUSE_NEW_TRADES":
            result = await postPauseNewTrades(account);
            break;
          case "RESUME_NEW_TRADES":
            // The phrase is forwarded verbatim; the SERVER compares it. An
            // empty string is a refusal there, not a bypass here.
            result = await postResumeNewTrades(account, confirmation ?? "");
            break;
          case "STOP_NEW_TRADES":
            result = await postStopNewTrades(account);
            break;
          default:
            result = await postSafeOff(account);
            break;
        }
        if (!isCurrent(mine)) return;
        setActionResult(result);
        setReadiness(null);
      } catch (error) {
        if (!isCurrent(mine)) return;
        // Only a 401 ends the session. A refused control action is a conflict
        // with authoritative state, and logging the operator out for it would
        // be both wrong and infuriating.
        if (isSessionEnded(error)) {
          endSession();
          return;
        }
        setActionError(error instanceof Error ? error.message : "The action could not be completed.");
      } finally {
        if (isCurrent(mine)) setPendingAction(null);
      }
      await refresh();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isCurrent reads refs only
    [account, endSession, pendingAction, refresh]
  );

  const dismissActionResult = useCallback(() => {
    setActionResult(null);
    setActionError(null);
  }, []);

  const signOut = useCallback(() => {
    generation.current += 1;
    clearOperatorToken(account);
    setAuthState("NOT_AUTHENTICATED");
    setAuthError(null);
    setStatus(null);
    setStatusError(null);
    setReadiness(null);
    setReadinessError(null);
    setActionResult(null);
    setActionError(null);
    setPendingAction(null);
  }, [account]);

  // Before sign-in, poll only the token-free liveness route, so an offline
  // control plane reads as offline rather than as a bad token.
  useEffect(() => {
    if (authState === "AUTHENTICATED") return;
    void probeHealth();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void probeHealth();
    }, pollMs);
    return () => clearInterval(timer);
  }, [authState, pollMs, probeHealth]);

  useEffect(() => {
    if (authState !== "AUTHENTICATED") return;
    const timer = setInterval(() => {
      // Reading state for a tab nobody is looking at is pure waste, so a hidden
      // tab simply skips its turn.
      if (typeof document !== "undefined" && document.hidden) return;
      // STATUS only. Readiness is never on this timer.
      void refresh();
    }, pollMs);
    return () => clearInterval(timer);
  }, [authState, pollMs, refresh]);

  return {
    account,
    controlPlane,
    authState,
    authError,
    status,
    statusError,
    loading,
    readiness,
    readinessError,
    checkingReadiness,
    authenticate,
    signOut,
    refresh,
    checkReadiness,
    pendingAction,
    actionResult,
    actionError,
    runAction,
    dismissActionResult,
  };
}
