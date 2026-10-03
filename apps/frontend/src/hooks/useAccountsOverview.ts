import { useCallback, useEffect, useState } from "react";

import { apiClient } from "../api/client";
import {
  OPERATOR_ACCOUNTS,
  accountHealthPath,
  accountOverviewState,
  classifyOperatorFailure,
  type AccountOverviewState,
  type OperatorAccountId,
} from "../api/operator-account";
import { hasOperatorToken, subscribeOperatorToken } from "../api/operator-token";

export const ACCOUNTS_OVERVIEW_POLL_MS = 15_000;

type Health = "UP" | "DOWN" | "UNKNOWN";

/**
 * READ-ONLY state of both accounts for the overview: liveness through the
 * gateway's token-free health route, plus whether THIS tab holds a token for
 * the account. It sends no credential and can mutate nothing.
 */
export function useAccountsOverview(): Record<OperatorAccountId, AccountOverviewState> {
  const [health, setHealth] = useState<Record<OperatorAccountId, Health>>({ A: "UNKNOWN", B: "UNKNOWN" });
  const [, setTokenTick] = useState(0);

  const probe = useCallback(async () => {
    const results = await Promise.all(
      OPERATOR_ACCOUNTS.map(async (account): Promise<[OperatorAccountId, Health]> => {
        try {
          await apiClient.get(accountHealthPath(account));
          return [account, "UP"];
        } catch (error) {
          return [account, classifyOperatorFailure(error) === "UNREACHABLE" ? "DOWN" : "UNKNOWN"];
        }
      })
    );
    setHealth(Object.fromEntries(results) as Record<OperatorAccountId, Health>);
  }, []);

  useEffect(() => {
    void probe();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void probe();
    }, ACCOUNTS_OVERVIEW_POLL_MS);
    return () => clearInterval(timer);
  }, [probe]);

  useEffect(() => subscribeOperatorToken(() => setTokenTick((tick) => tick + 1)), []);

  return {
    A: accountOverviewState(health.A, hasOperatorToken("A")),
    B: accountOverviewState(health.B, hasOperatorToken("B")),
  };
}
