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
import { clearOperatorToken, hasOperatorToken } from "../api/operator-token";
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
 * Operator auth plus the polled Trading Control status.
 *
 * The token lives only in the in-memory primitive; this hook never copies it
 * into React state, so it cannot end up in a component's props, a devtools
 * snapshot or a serialized error.
 */
export function useTradingControl(pollMs: number = TRADING_CONTROL_POLL_MS): TradingControlHandle {
  const [authState, setAuthState] = useState<OperatorAuthState>(
    hasOperatorToken() ? "AUTHENTICATED" : "NOT_AUTHENTICATED"
  );
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

  // Guards against a slow response from a previous token overwriting state
  // after the operator has already signed out.
  const generation = useRef(0);

  /**
   * A 401 from EITHER operator route ends the session.
   *
   * The token is dropped and the panel returns to the entry form rather than
   * leaving stale numbers on screen beside a quiet error — on this card, stale
   * and current look identical.
   */
  const endSession = useCallback(() => {
    clearOperatorToken();
    setAuthState("AUTH_FAILED");
    setAuthError("The operator token was rejected. Enter it again.");
    setStatus(null);
    setReadiness(null);
    setReadinessError(null);
    setActionResult(null);
    setActionError(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!hasOperatorToken()) return;
    const mine = generation.current;
    setLoading(true);
    try {
      const next = await fetchTradingControlStatus();
      if (generation.current !== mine) return;
      setStatus(next);
      setStatusError(null);
    } catch (error) {
      if (generation.current !== mine) return;
      if (isSessionEnded(error)) {
        endSession();
        return;
      }
      setStatusError(error instanceof Error ? error.message : "Status could not be read.");
    } finally {
      if (generation.current === mine) setLoading(false);
    }
  }, [endSession]);

  /**
   * The explicit readiness check. Called from the button, never from the timer.
   *
   * This is the one operator request that can cost signed reads of the live
   * account, so nothing else in this hook may invoke it.
   */
  const checkReadiness = useCallback(async () => {
    if (!hasOperatorToken()) return;
    const mine = generation.current;
    setCheckingReadiness(true);
    try {
      const next = await fetchTradingControlReadiness();
      if (generation.current !== mine) return;
      setReadiness(next);
      setReadinessError(null);
    } catch (error) {
      if (generation.current !== mine) return;
      if (isSessionEnded(error)) {
        endSession();
        return;
      }
      setReadinessError(error instanceof Error ? error.message : "Readiness could not be checked.");
    } finally {
      if (generation.current === mine) setCheckingReadiness(false);
    }
  }, [endSession]);

  const authenticate = useCallback(
    async (token: string) => {
      generation.current += 1;
      setAuthState("AUTHENTICATING");
      setAuthError(null);
      const outcome = await authenticateOperator(token);
      if (!outcome.ok) {
        setAuthState(outcome.state);
        setAuthError(outcome.message);
        return;
      }
      setAuthState("AUTHENTICATED");
      await refresh();
    },
    [refresh]
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
      if (!hasOperatorToken()) return;
      if (pendingAction !== null) return;
      const mine = generation.current;
      setPendingAction(id);
      setActionError(null);
      try {
        // One switch rather than a nested ternary: five actions is past the
        // point where the chain reads as a decision instead of a puzzle.
        let result;
        switch (id) {
          case "START":
            result = await postStartTrading(confirmation ?? "", durationMinutes, tradeBudget, unlimited);
            break;
          case "PAUSE_NEW_TRADES":
            result = await postPauseNewTrades();
            break;
          case "RESUME_NEW_TRADES":
            // The phrase is forwarded verbatim; the SERVER compares it. An
            // empty string is a refusal there, not a bypass here.
            result = await postResumeNewTrades(confirmation ?? "");
            break;
          case "STOP_NEW_TRADES":
            result = await postStopNewTrades();
            break;
          default:
            result = await postSafeOff();
            break;
        }
        if (generation.current !== mine) return;
        setActionResult(result);
        setReadiness(null);
      } catch (error) {
        if (generation.current !== mine) return;
        // Only a 401 ends the session. A refused control action is a conflict
        // with authoritative state, and logging the operator out for it would
        // be both wrong and infuriating.
        if (isSessionEnded(error)) {
          endSession();
          return;
        }
        setActionError(error instanceof Error ? error.message : "The action could not be completed.");
      } finally {
        if (generation.current === mine) setPendingAction(null);
      }
      await refresh();
    },
    [endSession, pendingAction, refresh]
  );

  const dismissActionResult = useCallback(() => {
    setActionResult(null);
    setActionError(null);
  }, []);

  const signOut = useCallback(() => {
    generation.current += 1;
    clearOperatorToken();
    setAuthState("NOT_AUTHENTICATED");
    setAuthError(null);
    setStatus(null);
    setStatusError(null);
    setReadiness(null);
    setReadinessError(null);
    setActionResult(null);
    setActionError(null);
    setPendingAction(null);
  }, []);

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
