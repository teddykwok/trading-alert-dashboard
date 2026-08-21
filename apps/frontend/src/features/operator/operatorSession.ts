import { ApiRequestError } from "../../api/client";
import { checkOperatorAuth } from "../../api/operator";
import { clearOperatorToken, setOperatorToken } from "../../api/operator-token";

/**
 * The operator sign-in flow, with no React in it.
 *
 * Kept separate from the hook so the rule that actually matters — a token that
 * has not been proven good does not stay in memory — is asserted directly
 * rather than through a rendered component.
 */

export type OperatorAuthState = "NOT_AUTHENTICATED" | "AUTHENTICATING" | "AUTHENTICATED" | "AUTH_FAILED";

export type AuthenticateOutcome =
  | { ok: true }
  | { ok: false; state: "AUTH_FAILED"; message: string };

export const REJECTED_MESSAGE = "That token was not accepted.";
export const UNREACHABLE_MESSAGE = "The operator API could not be reached.";

export async function authenticateOperator(
  token: string,
  probe: () => Promise<unknown> = checkOperatorAuth
): Promise<AuthenticateOutcome> {
  setOperatorToken(token);
  try {
    await probe();
    return { ok: true };
  } catch (error) {
    // Dropped on ANY failure, including a network error. A credential that has
    // not been proven good must not linger where the next request could send
    // it, and re-entry is cheap.
    clearOperatorToken();
    return {
      ok: false,
      state: "AUTH_FAILED",
      message: error instanceof ApiRequestError && error.status === 401 ? REJECTED_MESSAGE : UNREACHABLE_MESSAGE,
    };
  }
}

/**
 * Whether a failed status read means the session is over.
 *
 * A 401 mid-session means the server no longer accepts this token, so the panel
 * returns to the entry form instead of leaving stale numbers on screen beside a
 * quiet error.
 */
export function isSessionEnded(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401;
}
