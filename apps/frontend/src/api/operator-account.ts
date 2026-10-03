import { ApiRequestError } from "./client";

/**
 * Which ACCOUNT an operator request targets.
 *
 * There is ONE frontend and TWO isolated account control planes. Every operator
 * request names exactly one of them, explicitly, in its path:
 *
 *   /api/operator/accounts/A/...   or   /api/operator/accounts/B/...
 *
 * The generic backend forwards that request to that account's loopback control
 * plane and nowhere else. There is no "ALL" target, no default account, and no
 * way to derive the account from a token, a port or a previous request.
 */

export const OPERATOR_ACCOUNTS = ["A", "B"] as const;
export type OperatorAccountId = (typeof OPERATOR_ACCOUNTS)[number];

export const OPERATOR_ACCOUNT_LABELS: Readonly<Record<OperatorAccountId, string>> = Object.freeze({
  A: "Account A",
  B: "Account B",
});

export function isOperatorAccountId(value: unknown): value is OperatorAccountId {
  return typeof value === "string" && (OPERATOR_ACCOUNTS as readonly string[]).includes(value);
}

/** Refuses anything but exactly "A" or "B" — including "ALL", lower case and empty. */
export function assertOperatorAccount(value: unknown): OperatorAccountId {
  if (!isOperatorAccountId(value)) throw new Error("an operator request must target exactly Account A or Account B");
  return value;
}

const OPERATOR_PREFIX = "/api/operator/";

/**
 * `/api/operator/<route>` for one account -> `/api/operator/accounts/<A|B>/<route>`.
 * Only an operator path may be scoped; the account is validated first.
 */
export function accountScopedOperatorPath(account: OperatorAccountId, path: string): string {
  const target = assertOperatorAccount(account);
  if (!path.startsWith(OPERATOR_PREFIX) || path.startsWith(`${OPERATOR_PREFIX}accounts/`)) {
    throw new Error(`refusing to scope a non-operator path: ${path}`);
  }
  return `${OPERATOR_PREFIX}accounts/${target}/${path.slice(OPERATOR_PREFIX.length)}`;
}

/** Liveness of one account's control plane through the gateway. Carries no credential. */
export const accountHealthPath = (account: OperatorAccountId) => `${OPERATOR_PREFIX}accounts/${assertOperatorAccount(account)}/health`;

/**
 * What a failed operator request says about the selected account.
 *
 * UNREACHABLE is never reported as a bad token: the gateway answers 503 when the
 * account's control plane is offline and 504 when it does not answer in time,
 * and a fetch that never reached the gateway is unreachable too.
 */
export type OperatorFailureKind = "UNAUTHORIZED" | "UNREACHABLE" | "ERROR";

export function classifyOperatorFailure(error: unknown): OperatorFailureKind {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return "UNAUTHORIZED";
    if (error.status === 503 || error.status === 504 || error.status === 502) return "UNREACHABLE";
    return "ERROR";
  }
  if (error instanceof TypeError) return "UNREACHABLE";
  return "ERROR";
}

/**
 * Whether a response may still update the UI: it must belong to the account
 * that is selected NOW and to the current request generation. A slow answer
 * from Account A can never land on Account B's screen.
 */
export function isCurrentAccountResponse(
  request: { readonly account: OperatorAccountId; readonly generation: number },
  current: { readonly account: OperatorAccountId | null; readonly generation: number }
): boolean {
  return current.account !== null && request.account === current.account && request.generation === current.generation;
}

/** The read-only overview's verdict for one account. */
export type AccountOverviewState = "ONLINE" | "AUTH_NEEDED" | "OFFLINE" | "UNKNOWN";

export function accountOverviewState(health: "UP" | "DOWN" | "UNKNOWN", hasToken: boolean): AccountOverviewState {
  if (health === "DOWN") return "OFFLINE";
  if (health === "UNKNOWN") return "UNKNOWN";
  return hasToken ? "ONLINE" : "AUTH_NEEDED";
}
