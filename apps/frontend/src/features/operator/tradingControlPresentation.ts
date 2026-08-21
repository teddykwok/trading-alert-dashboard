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

export function presentReservation(used: string, limit: string): string {
  return `${used} / ${limit} USD`;
}

export function presentLatestExecution(latest: TradingControlStatusDto["latestExecution"]): string {
  if (!latest) return "None";
  return `${latest.symbol} ${latest.direction} · ${latest.status}`;
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
