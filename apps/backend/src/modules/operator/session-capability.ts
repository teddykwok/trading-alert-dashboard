import { env } from "../../config/env";
import { classifyBinanceFuturesEnvironment } from "../binance/binance-environment";

/**
 * Whether this installation may start an UNLIMITED trading session.
 *
 * ## The rule
 *
 * An unlimited session removes the only bound on how many trades an unattended
 * runtime may open. That is acceptable on an account where a mistake costs
 * nothing, and unacceptable on real money — so it is permitted ONLY when the
 * server can positively prove the execution environment is non-live.
 *
 * ## Why the browser is never asked
 *
 * A UI label saying "paper" is a claim, not evidence. The decision is made
 * here from two independent server-side facts, and BOTH must agree:
 *
 *   - the configured execution profile's environment, and
 *   - the environment the configured Binance base URL actually points at.
 *
 * Requiring both is what stops a TESTNET-labelled profile pointed at
 * `fapi.binance.com` from earning an unlimited budget.
 *
 * ## UNKNOWN is not permission
 *
 * `classifyBinanceFuturesEnvironment` returns UNKNOWN for a URL it does not
 * recognise, and its own history is the reason this matters: an earlier
 * heuristic answered MAINNET for anything unrecognised, so a misconfigured
 * connector silently satisfied a MAINNET check. Here the failure mode is
 * reversed and fails closed — anything this cannot prove is TESTNET is treated
 * as live, and unlimited is refused.
 */
export interface SessionCapability {
  /** True only when the server proves the environment is non-live. */
  unlimitedPermitted: boolean;
  /** The profile's declared environment. */
  profileEnvironment: string;
  /** What the configured connector URL actually points at. */
  connectorEnvironment: string;
  /** Operator-facing explanation. Never a URL, never a credential. */
  reason: string;
}

export function resolveSessionCapability(): SessionCapability {
  const profileEnvironment = env.EXECUTION_PROFILE_ENVIRONMENT;
  const connectorEnvironment = classifyBinanceFuturesEnvironment(env.BINANCE_FUTURES_REST_BASE_URL);

  const bothNonLive = profileEnvironment === "TESTNET" && connectorEnvironment === "TESTNET";

  return {
    unlimitedPermitted: bothNonLive,
    profileEnvironment,
    connectorEnvironment,
    reason: bothNonLive
      ? "The execution profile and the connector both resolve to TESTNET, so an unlimited session is permitted."
      : "An unlimited session requires the profile AND the connector to prove TESTNET. Choose a finite trade budget.",
  };
}
