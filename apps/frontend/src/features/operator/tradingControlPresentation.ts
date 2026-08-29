import type {
  TradingControlReadinessSnapshot,
  TradingControlStatusDto,
  TradingSystemState,
} from "../../api/operator";
import { describeExecutionReason, humanizeReasonCode } from "../executions/executionReason";

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

/**
 * The authorization countdown, in the largest two units that fit.
 *
 * Seconds-level precision is what a short supervised window needs, and it is
 * preserved exactly for anything under an hour. A session-backed window can
 * now live thirty days, and "43200m 0s" is not a countdown anyone can read, so
 * longer windows step up to hours and days.
 */
export function formatTtl(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const whole = Math.floor(seconds);
  const days = Math.floor(whole / 86_400);
  if (days > 0) return `${days}d ${Math.floor((whole % 86_400) / 3600)}h`;
  const hours = Math.floor(whole / 3600);
  if (hours > 0) return `${hours}h ${Math.floor((whole % 3600) / 60)}m`;
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
 * Operator-facing copy for why the latest execution was refused.
 *
 * The vocabulary itself lives in `describeExecutionReason`, shared with the
 * Executions table. This adapter only supplies what the Trading Control DTO
 * happens to know — including the effective alert-age limit, which keeps the
 * stale-alert sentence and the policy row reading the same duration.
 *
 * Behaviour is unchanged: the same statuses qualify, the same sentences come
 * back, and an unknown code still degrades to humanized text.
 */
export function presentExecutionReason(
  latest: TradingControlStatusDto["latestExecution"],
  alertAgeLimitSeconds: number
): string | null {
  if (!latest) return null;
  return describeExecutionReason({
    status: latest.status,
    reasonCode: latest.reason,
    symbol: latest.symbol,
    direction: latest.direction,
    sourceTimeframe: latest.sourceTimeframe,
    alertAgeLimitSeconds,
  });
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

/**
 * Re-exported so callers that already imported it from here keep working.
 * The implementation moved to the shared module with the rest of the
 * vocabulary; splitting it would have meant two fallbacks to keep in step.
 */
export { humanizeReasonCode };
