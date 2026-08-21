/**
 * The operator token, held in memory ONLY.
 *
 * Deliberately not localStorage, not sessionStorage, not a cookie, not the URL.
 * This token can arm a real-money account, so it must not survive the tab that
 * entered it: a refresh requires re-entry, which is the intended trade-off for
 * v1. Persisting it would leave a credential sitting in browser storage that
 * any XSS on this origin could read at leisure.
 *
 * Module scope rather than React state so non-component code (the API client)
 * can read it without prop-drilling, while it still dies with the page.
 */

let operatorToken: string | null = null;

/** Subscribers are notified so the UI can re-render when auth state changes. */
type Listener = (hasToken: boolean) => void;
const listeners = new Set<Listener>();

export function setOperatorToken(token: string | null): void {
  const trimmed = token?.trim() ?? "";
  operatorToken = trimmed.length > 0 ? trimmed : null;
  for (const listener of listeners) listener(operatorToken !== null);
}

export function clearOperatorToken(): void {
  setOperatorToken(null);
}

/** True when a token is held. Never exposes the value itself. */
export function hasOperatorToken(): boolean {
  return operatorToken !== null;
}

export function subscribeOperatorToken(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The Authorization header for operator requests, or an empty object.
 *
 * Returning headers rather than the raw token keeps the value from spreading
 * through call sites: callers attach it, they never hold or log it.
 */
export function operatorAuthHeaders(): Record<string, string> {
  return operatorToken === null ? {} : { Authorization: `Bearer ${operatorToken}` };
}
