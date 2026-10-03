import { assertOperatorAccount, type OperatorAccountId } from "../../api/operator-account";

/**
 * WHICH account Trading Control targets — one explicit choice, in memory only.
 *
 * There is deliberately no default: until the operator picks Account A or
 * Account B, nothing account-scoped is fetched and no control is offered. The
 * choice is not persisted, so a reload never silently re-targets an account the
 * operator did not just choose. There is no "ALL" value.
 */

let selected: OperatorAccountId | null = null;
type Listener = (account: OperatorAccountId | null) => void;
const listeners = new Set<Listener>();

export function getSelectedOperatorAccount(): OperatorAccountId | null {
  return selected;
}

/** Selects exactly one account, or clears the selection with null. Anything else is refused. */
export function selectOperatorAccount(account: OperatorAccountId | null): void {
  const next = account === null ? null : assertOperatorAccount(account);
  if (next === selected) return;
  selected = next;
  for (const listener of listeners) listener(selected);
}

export function subscribeSelectedOperatorAccount(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
