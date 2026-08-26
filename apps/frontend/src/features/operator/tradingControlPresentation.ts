import type {
  TradingControlReadinessSnapshot,
  TradingControlStatusDto,
  TradingSystemState,
} from "../../api/operator";

/**
 * Every display decision the Trading Control card makes, as pure functions.
 *
 * Same shape as `executionPresentation`: the component stays a thin mapping
 * over these, so what the operator is told about a real-money account is
 * asserted directly in tests rather than inferred from JSX.
 */

export type Tone = "green" | "red" | "yellow" | "gray" | "blue";

export interface Presented {
  label: string;
  tone: Tone;
}

export const TRADING_SYSTEM_STATES: TradingSystemState[] = [
  "SAFE_OFF",
  "ARMED",
  "SAFE_RECOVERY",
  "INVALID",
  "UNKNOWN",
];

/**
 * Green is "safe", never "trading".
 *
 * On an account that can lose real money the reassuring colour belongs to the
 * state where nothing can be opened. ARMED is amber because it is a state that
 * warrants attention, not congratulation.
 */
export function presentSystemState(state: TradingSystemState): Presented {
  switch (state) {
    case "SAFE_OFF":
      return { label: "SAFE OFF", tone: "green" };
    case "ARMED":
      return { label: "ARMED", tone: "yellow" };
    case "SAFE_RECOVERY":
      return { label: "SAFE RECOVERY", tone: "yellow" };
    case "INVALID":
      return { label: "INVALID", tone: "red" };
    default:
      // A state that could not be read is a red condition, not a neutral one.
      return { label: "UNKNOWN", tone: "red" };
  }
}

export function presentAttestation(status: TradingControlStatusDto["runtimeAttestation"]): Presented {
  if (status.status === "PASS") return { label: "PASS", tone: "green" };
  if (status.status === "UNAVAILABLE") return { label: "unavailable", tone: "gray" };
  return { label: "BLOCKED", tone: "red" };
}

/**
 * Online means a live process is publishing attestation right now.
 *
 * Read from the fresh role counts rather than from the verdict: a runtime can
 * be up and still fail attestation, and those are different facts an operator
 * needs to tell apart.
 */
export function presentRuntime(status: TradingControlStatusDto["runtimeAttestation"]): Presented {
  const online = status.backendCount > 0 || status.workerCount > 0;
  return online ? { label: "Online", tone: "blue" } : { label: "Offline", tone: "gray" };
}

export function presentReadiness(ready: boolean, scope: "PREPARATION" | "LIVE_ACTIVATION"): Presented {
  if (ready) return { label: "READY", tone: "green" };
  // A blocked LIVE ACTIVATION on a deliberately SAFE system is the expected
  // reading, so it is amber. Blocked PREPARATION means something is actually
  // wrong with the setup.
  return { label: "BLOCKED", tone: scope === "PREPARATION" ? "red" : "yellow" };
}

export function formatTtl(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

export function presentAuthorization(authorization: TradingControlStatusDto["authorization"]): {
  state: string;
  ttl: string;
  claims: string;
} {
  if (!authorization) return { state: "None", ttl: "—", claims: "—" };
  return {
    state: authorization.state,
    ttl: formatTtl(authorization.remainingTtlSeconds),
    // maxClaims can legitimately be null on a malformed row; showing an em dash
    // is honest, showing 0 would not be.
    claims: `${authorization.claimedCount} / ${authorization.maxClaims ?? "—"}`,
  };
}

export function presentAllowedSymbols(symbols: string[]): string {
  // [] means ALLOW ALL in the policy, which is the opposite of "nothing" and
  // must never be rendered as an empty line.
  return symbols.length === 0 ? "ALL (unrestricted)" : symbols.join(", ");
}

export function presentCapacity(capacity: TradingControlStatusDto["capacity"]): string {
  return `${capacity.totalActive} / ${capacity.hardTotal}`;
}

/**
 * Open positions against their own limit, with the SOFT target named separately.
 *
 * The target is where new admission stops; the limit is where it becomes
 * impossible. They are different numbers with different consequences, so
 * collapsing them into one fraction would tell the operator the wrong story
 * about how much room is left.
 */
export function presentOpenCapacity(capacity: TradingControlStatusDto["capacity"]): string {
  return `${capacity.open} / ${capacity.maxOpen} (target ${capacity.desiredOpen})`;
}

/** Pending entries against the PENDING limit, never the total-active one. */
export function presentPendingCapacity(capacity: TradingControlStatusDto["capacity"]): string {
  return `${capacity.pending} / ${capacity.maxPending}`;
}

/**
 * The freshness policy, as a duration an operator reads without converting.
 *
 * Deliberately describes the LIMIT and nothing else. It says nothing about how
 * old any particular signal was, and nothing about when a level was touched —
 * the timestamp the backend measures from is under separate review, and a
 * label like "signal age" would state a meaning this data has not been shown
 * to carry.
 */
export function formatAlertAgeLimit(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Not configured";
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes === 0) return `${rest} sec`;
  if (rest === 0) return `${minutes} min`;
  return `${minutes} min ${rest} sec`;
}

export function presentReservation(used: string, limit: string): string {
  return `${used} / ${limit} USD`;
}

export function presentLatestExecution(latest: TradingControlStatusDto["latestExecution"]): string {
  if (!latest) return "None";
  return `${latest.symbol} ${latest.direction} · ${latest.status}`;
}

/**
 * Statuses whose reason code explains a REFUSAL.
 *
 * A healthy execution also carries a reason code — ENTRY_PENDING sits on
 * ENTRY_RECONCILED, which means "we read the exchange and the order is
 * resting". Rendering that under the word "Reason:" would read as a problem
 * report for a trade that is working exactly as intended, so the line appears
 * only where something actually stopped.
 */
const REFUSAL_STATUSES = new Set(["SKIPPED", "FAILED", "MANUAL_INTERVENTION", "ENTRY_EXPIRED"]);

/**
 * Turns an UNKNOWN code into something readable rather than hiding it.
 *
 * New reason codes ship with the backend, not with this file, so the mapping
 * must degrade instead of breaking: SOME_NEW_CODE becomes "Some new code".
 * That is worse than a written sentence and far better than a blank line or a
 * crash, and the raw code stays available in the row's tooltip.
 */
export function humanizeReasonCode(code: string): string {
  const words = code.trim().replace(/_/g, " ").toLowerCase();
  if (!words) return "Refused for an unspecified reason";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Operator-facing copy for why the latest execution was refused.
 *
 * Returns null when there is nothing useful to say — no execution, no code, or
 * a status that is progressing normally — so the card renders no line at all
 * rather than an empty "Reason:".
 *
 * Every sentence describes the OUTCOME in the operator's terms. It never names
 * an internal function, a table or a status enum, and it never invents a cause
 * the data does not carry: where the specific trigger is not persisted the copy
 * stays honestly general.
 */
export function presentExecutionReason(
  latest: TradingControlStatusDto["latestExecution"],
  alertAgeLimitSeconds: number
): string | null {
  if (!latest || !latest.reason) return null;
  if (!REFUSAL_STATUSES.has(latest.status.toUpperCase())) return null;

  const code = latest.reason.trim().toUpperCase();
  const { symbol, direction } = latest;
  const timeframe = latest.sourceTimeframe;

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
      return `Alert is older than the execution limit of ${formatAlertAgeLimit(alertAgeLimitSeconds)}`;
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
      return humanizeReasonCode(latest.reason);
  }
}

/** Preparation first, then live activation — the order the operator reads them. */
export function presentBlockers(readiness: TradingControlReadinessSnapshot) {
  return [...readiness.preparationBlockers, ...readiness.liveActivationBlockers];
}

export const READINESS_NOT_CHECKED = "Not checked yet";

/**
 * Readiness is the answer to a question the operator asked, not a live reading.
 *
 * Before the first explicit check there is no verdict at all, and the panel says
 * so. Showing READY or BLOCKED without having asked would be inventing a safety
 * conclusion, which is worse than showing nothing — and showing a stale one from
 * an earlier session would be worse still.
 */
export function presentReadinessSnapshot(
  snapshot: TradingControlReadinessSnapshot | null,
  scope: "PREPARATION" | "LIVE_ACTIVATION"
): Presented {
  if (!snapshot) return { label: READINESS_NOT_CHECKED, tone: "gray" };
  const ready = scope === "PREPARATION" ? snapshot.preparationReady : snapshot.liveActivationReady;
  return presentReadiness(ready, scope);
}
