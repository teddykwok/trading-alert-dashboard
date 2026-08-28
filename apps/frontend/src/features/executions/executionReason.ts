import { formatAlertAgeLimit } from "../operator/tradingControlPresentation";

/**
 * ONE place that turns a backend decision reason into operator English.
 *
 * Trading Control introduced this mapping for the latest execution; the
 * Executions table needs exactly the same sentences for every row. Keeping two
 * dictionaries would guarantee they drift — the same refusal would read one way
 * on the panel and another in the table, and an operator comparing them would
 * have to work out which was stale. So the vocabulary lives here and both
 * surfaces call it.
 *
 * It is deliberately DTO-agnostic: callers pass the few facts a sentence can
 * name, and anything they cannot supply is simply absent rather than guessed.
 */

/**
 * What a sentence is allowed to know.
 *
 * Everything except `status` and `reasonCode` is optional, because the two
 * surfaces genuinely carry different context: the Trading Control card knows
 * the effective alert-age limit, the executions list does not. A missing fact
 * makes the copy more general, never less true.
 */
export interface ExecutionReasonContext {
  status: string;
  /** The persisted `decisionReasonCode`. Null means there is nothing to say. */
  reasonCode: string | null;
  symbol?: string | null;
  direction?: string | null;
  sourceTimeframe?: string | null;
  /**
   * The effective freshness limit, when the caller has it.
   *
   * Absent is not a reason to invent one: the executions list has no policy
   * context, and hardcoding 300 in the frontend would put a second copy of a
   * configurable value in front of the operator. The stale-alert sentence
   * stays neutral instead.
   */
  alertAgeLimitSeconds?: number | null;
}

/**
 * Statuses whose reason code explains a REFUSAL.
 *
 * A healthy execution also carries a reason code — ENTRY_PENDING sits on
 * ENTRY_RECONCILED, which means "we read the exchange and the order is
 * resting". Rendering that under the word "Reason" would read as a problem
 * report for a trade that is working exactly as intended, so a reason is
 * offered only where something actually stopped.
 */
export const REFUSAL_STATUSES = new Set(["SKIPPED", "FAILED", "MANUAL_INTERVENTION", "ENTRY_EXPIRED"]);

/**
 * Turns an UNKNOWN code into something readable rather than hiding it.
 *
 * New reason codes ship with the backend, not with this file, so the mapping
 * must degrade instead of breaking: SOME_NEW_CODE becomes "Some new code".
 * That is worse than a written sentence and far better than a blank cell or a
 * crash, and the raw code stays available to the caller either way.
 */
export function humanizeReasonCode(code: string): string {
  const words = code.trim().replace(/_/g, " ").toLowerCase();
  if (!words) return "Refused for an unspecified reason";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Operator-facing copy for why an execution was refused.
 *
 * Returns null when there is nothing useful to say — no code, or a status that
 * is progressing normally — so a caller renders nothing at all rather than an
 * empty "Reason".
 *
 * Every sentence describes the OUTCOME in the operator's terms. It never names
 * an internal function, a table or a status enum, and it never invents a cause
 * the data does not carry: where the specific trigger is not persisted the copy
 * stays honestly general.
 */
export function describeExecutionReason(context: ExecutionReasonContext): string | null {
  if (!context.reasonCode) return null;
  if (!REFUSAL_STATUSES.has(context.status.toUpperCase())) return null;

  const code = context.reasonCode.trim().toUpperCase();
  const symbol = context.symbol ?? "This symbol";
  const direction = context.direction ?? "";
  const timeframe = context.sourceTimeframe ?? null;

  switch (code) {
    // --- Eligibility -------------------------------------------------------
    case "SOURCE_TIMEFRAME_NOT_ALLOWED":
      // The subject matters: naming the rule without the timeframe leaves the
      // operator to go and look up which one it objected to.
      return timeframe
        ? `Source timeframe ${timeframe} is not allowed`
        : "The signal’s source timeframe is not allowed";
    case "SOURCE_TIMEFRAME_UNAVAILABLE":
      return "This signal did not carry a recognised source timeframe";
    case "USDT_ONLY_CONTRACT_REQUIRED":
      return "This contract is not eligible for USDT-only execution";
    case "UNSUPPORTED_SYMBOL":
      return "Symbol is not supported for Binance USDⓈ-M Futures";
    case "SYMBOL_NOT_TRADING":
      return `${symbol} is not currently trading on Binance`;
    case "UNSUPPORTED_CONTRACT":
      return "This contract type is not supported for execution";
    case "SYMBOL_NOT_ALLOWED":
      return `${symbol} is not in the symbol allowlist`;

    // --- Freshness and duplication -----------------------------------------
    case "ALERT_STALE":
      // Worded so it can reuse the SAME formatter the policy row uses. Two
      // independent decompositions of one limit could disagree on the card —
      // "90-second" beside "1 min 30 sec" — which is exactly the kind of
      // inconsistency that makes an operator distrust the whole panel.
      return context.alertAgeLimitSeconds === null || context.alertAgeLimitSeconds === undefined
        ? "Alert was too old when it was evaluated"
        : `Alert is older than the execution limit of ${formatAlertAgeLimit(context.alertAgeLimitSeconds)}`;
    case "SIGNAL_TIME_UNAVAILABLE":
      return "This signal carried no trustworthy trigger time";
    case "DUPLICATE_EXECUTION":
      return "This alert had already been executed";
    case "SYMBOL_SIDE_ALREADY_ACTIVE":
      return `A ${symbol} ${direction} execution is already active`;
    case "SYMBOL_HAS_OPEN_POSITION_OR_ORDER":
      return `An open Binance position or order already exists for ${symbol}`;

    // --- Capacity ----------------------------------------------------------
    case "OPEN_POSITION_LIMIT_REACHED":
      return "The open-position limit was already reached";
    case "SOFT_OPEN_TARGET_REACHED":
      return "The desired number of open positions was already reached";
    case "PENDING_ENTRY_LIMIT_REACHED":
      return "The pending-entry limit was already reached";
    case "TOTAL_ACTIVE_LIMIT_REACHED":
      return "The total active-trade limit was already reached";
    case "TOTAL_RISK_LIMIT_REACHED":
      return "This trade would exceed the total planned-risk limit";
    case "TOTAL_MARGIN_LIMIT_REACHED":
      return "This trade would exceed the total margin limit";
    case "INSUFFICIENT_AVAILABLE_BALANCE":
      return "Available balance was below the margin this trade needed";

    // --- Planning ----------------------------------------------------------
    // Deliberately general. The engine records THAT planning refused, not which
    // of its several conditions did, so a specific cause here would be a guess
    // presented as a fact.
    case "MARGIN_PLAN_NOT_READY":
      return "A safe margin and leverage plan could not be produced for this trade";

    // --- Pre-execution refusals (SelectedPlanSkipReason) --------------------
    // These come from the selected-plan executor, which decides BEFORE any
    // execution exists. They live in this dictionary rather than a second one
    // so the same code reads identically wherever it is shown, and the wording
    // says "not executed" rather than "failed": nothing was ever sent to
    // Binance on any of these paths.
    case "PLAN_NOT_READY":
      return "The trade plan was not ready when it was evaluated";
    case "NO_SELECTED_CANDIDATE":
      return "The plan had no candidate for its selected lookback";
    case "CANDIDATE_INCOMPLETE":
      return "The selected plan was not a complete, valid, money-carrying plan";
    case "PROFILE_UNAVAILABLE":
      return "The execution profile could not be resolved at evaluation time";
    case "CANARY_AUTHORIZATION_REQUIRED":
      return "Nothing authorized this signal at evaluation time";
    case "CANARY_AUTHORIZATION_WRONG_SYMBOL":
      return "The authorization on record was for a different symbol";
    case "CANARY_AUTHORIZATION_WRONG_DIRECTION":
      return "The authorization on record was for the other direction";
    case "CANARY_AUTHORIZATION_ALREADY_CONSUMED":
      return "The authorization was already bound to a different execution";
    case "MARGIN_PLAN_SNAPSHOT_MISSING":
      return "This execution is missing its frozen margin plan";
    case "UNSAFE_LIQUIDATION_BUFFER":
      return "The liquidation buffer for this trade was not safe";

    // --- Trading state -------------------------------------------------------
    case "GLOBAL_KILL_SWITCH_ACTIVE":
      return "The global kill switch was active";
    case "PROFILE_KILL_SWITCH_ACTIVE":
      return "Trading was in a SAFE state, so no new trade was admitted";
    case "PROFILE_DISABLED":
      return "The execution profile was disabled";
    case "PROFILE_ENVIRONMENT_MISMATCH":
      return "The profile does not match the connected Binance environment";
    case "PROFILE_POLICY_UNAVAILABLE":
      return "The safety policy could not be read, so nothing was admitted";
    case "RECOVERY_REQUIRED":
      return "A previous execution requires recovery before new trades can be admitted";
    case "EXPECTED_HEDGE_MODE":
      return "The Binance account is not in Hedge mode";
    case "EXPECTED_SINGLE_ASSET_MODE":
      return "The Binance account is not in Single-Asset mode";
    case "EXPECTED_ISOLATED_MARGIN_TYPE":
      return "The symbol is not set to Isolated margin";

    // --- Authorization -------------------------------------------------------
    case "NATURAL_AUTHORIZATION_REQUIRED":
      return "Nothing currently authorizes this signal";
    case "NATURAL_AUTHORIZATION_EXPIRED":
      return "The authorization window had expired";
    case "NATURAL_AUTHORIZATION_REVOKED":
      return "The authorization window had been revoked";
    case "NATURAL_AUTHORIZATION_EXHAUSTED":
      return "The authorization window had no claims left";
    case "NATURAL_AUTHORIZATION_DIRECTION_NOT_ALLOWED":
      return `The authorization window does not admit ${direction} trades`;
    case "NATURAL_AUTHORIZATION_INVALID":
    case "NATURAL_AUTHORIZATION_CONFLICT":
      return "The authorization window could not be used for this signal";

    // --- Exchange readability ------------------------------------------------
    case "BINANCE_ACCOUNT_STATE_UNAVAILABLE":
      return "Binance account state could not be read, so nothing was admitted";
    case "BINANCE_SYMBOL_STATE_UNAVAILABLE":
      return "Binance symbol data could not be read, so nothing was admitted";

    // --- Entry lifecycle -----------------------------------------------------
    case "ENTRY_SUBMISSION_REJECTED":
      return "Binance rejected the entry order";
    case "ENTRY_SUBMISSION_ABANDONED":
      return "The entry was proven never to have reached Binance and was released";
    case "ENTRY_TTL_EXPIRED":
      return "The entry order expired before it filled";
    case "ENTRY_ORDER_NOT_FOUND":
      return "The entry order could not be found on Binance";
    case "ENTRY_ORDER_IDENTITY_MISMATCH":
      return "The entry order on Binance did not match this execution";
    case "EXTERNAL":
      return "The position was closed outside this system";

    default:
      return humanizeReasonCode(context.reasonCode);
  }
}
