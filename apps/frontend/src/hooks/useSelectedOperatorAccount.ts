import { useSyncExternalStore } from "react";

import type { OperatorAccountId } from "../api/operator-account";
import { getSelectedOperatorAccount, subscribeSelectedOperatorAccount } from "../features/operator/operatorAccountSelection";

/** The account Trading Control currently targets, or null when none has been chosen. */
export function useSelectedOperatorAccount(): OperatorAccountId | null {
  return useSyncExternalStore(subscribeSelectedOperatorAccount, getSelectedOperatorAccount, getSelectedOperatorAccount);
}
