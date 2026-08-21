import { operatorApiClient } from "./client";

/**
 * The operator control API surface.
 *
 * Exactly one read-only probe today. Its only job is to answer "is the token I
 * am holding accepted?" so the UI can tell an operator they are authenticated
 * without any control action existing yet. Start/stop/safe-off arrive in a
 * later reviewed phase, behind the same server-side guard.
 */
export interface OperatorAuthCheck {
  authenticated: boolean;
}

export function checkOperatorAuth(): Promise<OperatorAuthCheck> {
  return operatorApiClient.get<OperatorAuthCheck>("/api/operator/auth-check");
}
