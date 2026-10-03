import { ApiRequestError } from "../../api/client";
import { checkOperatorAuth } from "../../api/operator";
import { OPERATOR_ACCOUNT_LABELS, classifyOperatorFailure, type OperatorAccountId } from "../../api/operator-account";
import { clearOperatorToken, setOperatorToken } from "../../api/operator-token";

/**
 * The operator sign-in flow, with no React in it.
 *
 * Kept separate from the hook so the rules that actually matter are asserted
 * directly rather than through a rendered component:
 *  - a token that has not been proven good does not stay in memory;
 *  - a token is entered FOR ONE ACCOUNT and only ever probed against it;
 *  - an unreachable control plane is never reported as a rejected token.
 */

export type OperatorAuthState = "NOT_AUTHENTICATED" | "AUTHENTICATING" | "AUTHENTICATED" | "AUTH_FAILED";

export type AuthenticateOutcome =
  | { ok: true }
  | { ok: false; state: "AUTH_FAILED"; reason: "REJECTED" | "UNREACHABLE" | "ERROR"; message: string };

export const REJECTED_MESSAGE = "That token was not accepted.";
export const UNREACHABLE_MESSAGE = "The operator API could not be reached.";

/** The account-specific wording of an unreachable control plane. */
export const unreachableMessageFor = (account: OperatorAccountId) =>
  `${OPERATOR_ACCOUNT_LABELS[account]} control plane is offline or unreachable. ${UNREACHABLE_MESSAGE}`;

export async function authenticateOperator(
  account: OperatorAccountId,
  token: string,
  probe: () => Promise<unknown> = () => checkOperatorAuth(account)
): Promise<AuthenticateOutcome> {
  setOperatorToken(account, token);
  try {
    await probe();
    return { ok: true };
  } catch (error) {
    // Dropped on ANY failure, including a network error. A credential that has
    // not been proven good must not linger where the next request could send
    // it, and re-entry is cheap.
    clearOperatorToken(account);
    const kind = classifyOperatorFailure(error);
    return kind === "UNAUTHORIZED"
      ? { ok: false, state: "AUTH_FAILED", reason: "REJECTED", message: REJECTED_MESSAGE }
      : kind === "UNREACHABLE"
        ? { ok: false, state: "AUTH_FAILED", reason: "UNREACHABLE", message: unreachableMessageFor(account) }
        : { ok: false, state: "AUTH_FAILED", reason: "ERROR", message: UNREACHABLE_MESSAGE };
  }
}

/**
 * Whether a failed status read means the session is over.
 *
 * A 401 mid-session means the server no longer accepts this token, so the panel
 * returns to the entry form instead of leaving stale numbers on screen beside a
 * quiet error. An offline control plane is NOT a session end.
 */
export function isSessionEnded(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401;
}
