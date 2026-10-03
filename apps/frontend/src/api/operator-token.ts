import { assertOperatorAccount, type OperatorAccountId } from "./operator-account";

/**
 * Operator tokens, held in memory ONLY, one per ACCOUNT.
 *
 * Deliberately not localStorage, not sessionStorage, not a cookie, not the URL.
 * A token can arm a real-money account, so it must not survive the tab that
 * entered it: a refresh requires re-entry, which is the intended trade-off.
 * Persisting it would leave a credential sitting in browser storage that any
 * XSS on this origin could read at leisure.
 *
 * Each account has its own slot. Account A's token is only ever attached to a
 * request that targets Account A, and Account B's only to Account B, so
 * switching accounts can never send one account's credential to the other.
 *
 * Module scope rather than React state so non-component code (the API client)
 * can read it without prop-drilling, while it still dies with the page.
 */

const tokens = new Map<OperatorAccountId, string>();

/** Subscribers are notified so the UI can re-render when an account's auth state changes. */
type Listener = (account: OperatorAccountId, hasToken: boolean) => void;
const listeners = new Set<Listener>();

export function setOperatorToken(account: OperatorAccountId, token: string | null): void {
  const target = assertOperatorAccount(account);
  const trimmed = token?.trim() ?? "";
  if (trimmed.length > 0) tokens.set(target, trimmed);
  else tokens.delete(target);
  for (const listener of listeners) listener(target, tokens.has(target));
}

export function clearOperatorToken(account: OperatorAccountId): void {
  setOperatorToken(account, null);
}

/** Forgets every account's token (e.g. on page teardown in tests). */
export function clearAllOperatorTokens(): void {
  for (const account of [...tokens.keys()]) clearOperatorToken(account);
}

/** True when a token is held for this account. Never exposes the value itself. */
export function hasOperatorToken(account: OperatorAccountId): boolean {
  return tokens.has(assertOperatorAccount(account));
}

export function subscribeOperatorToken(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The Authorization header for ONE account's operator requests, or an empty object.
 *
 * Returning headers rather than the raw token keeps the value from spreading
 * through call sites: callers attach it, they never hold or log it.
 */
export function operatorAuthHeaders(account: OperatorAccountId): Record<string, string> {
  const token = tokens.get(assertOperatorAccount(account));
  return token === undefined ? {} : { Authorization: `Bearer ${token}` };
}
