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


export interface CanaryFindingDto {
  code: string;
  scope: "PREPARATION" | "LIVE_ACTIVATION";
  detail: string;
}

export interface TradingControlReadinessDto {
  preparationReady: boolean;
  liveActivationReady: boolean;
  summary: string;
  preparationBlockers: CanaryFindingDto[];
  liveActivationBlockers: CanaryFindingDto[];
}

export type TradingSystemState = "SAFE_OFF" | "ARMED" | "SAFE_RECOVERY" | "INVALID" | "UNKNOWN";

export interface TradingControlStatusDto {
  generatedAt: string;
  systemState: TradingSystemState;
  profile: { environment: string; isEnabled: boolean | null; killSwitchActive: boolean | null } | null;
  environmentGates: { globalKillSwitch: boolean; liveEntryEnabled: boolean; protectionReady: boolean };
  runtimeAttestation: {
    status: "PASS" | "BLOCKED" | "UNAVAILABLE";
    reasonCode: string | null;
    message: string | null;
    backendCount: number;
    workerCount: number;
  };
  allowedSymbols: string[];
  authorization: {
    state: string;
    expiresAt: string;
    remainingTtlSeconds: number;
    maxClaims: number | null;
    claimedCount: number;
    remainingClaims: number;
  } | null;
  capacity: { pending: number; open: number; totalActive: number; desiredOpen: number; hardTotal: number };
  reservations: { riskUsd: string; riskLimitUsd: string; marginUsd: string; marginLimitUsd: string };
  latestExecution: { symbol: string; direction: string; status: string; reason: string | null; updatedAt: string } | null;
  manualIntervention: { present: boolean; count: number };
  warnings: { code: string; detail: string }[];
}

export type TradingControlReadinessSnapshot = TradingControlReadinessDto & {
  mode: string;
  generatedAt: string;
};

/**
 * The polled feed. Cheap by construction: the server runs no preflight and
 * reaches no exchange for this.
 */
export function fetchTradingControlStatus(): Promise<TradingControlStatusDto> {
  return operatorApiClient.get<TradingControlStatusDto>("/api/operator/trading-control/status");
}

/**
 * The explicit check. This is the only operator request that can cost a signed
 * exchange read, so it is never put on a timer.
 */
export function fetchTradingControlReadiness(): Promise<TradingControlReadinessSnapshot> {
  return operatorApiClient.get("/api/operator/trading-control/readiness");
}


// ---------------------------------------------------------------------------
// Operator actions
// ---------------------------------------------------------------------------

export type TradingControlActionOutcome =
  | "ARMED"
  | "ALREADY_ARMED"
  | "NEW_TRADES_BLOCKED"
  | "SAFE_OFF"
  | "SAFE_RECOVERY"
  | "BLOCKED"
  | "WINDOW_PREPARED_NOT_ARMED";

export interface TradingControlActionResult {
  ok: boolean;
  outcome: TradingControlActionOutcome;
  systemState: TradingSystemState;
  profile: { environment: string; isEnabled: boolean; killSwitchActive: boolean | null } | null;
  authorization: {
    id: string;
    state: string;
    expiresAt: string;
    maxClaims: number | null;
    claimedCount: number;
    remainingClaims: number;
  } | null;
  outstandingExecutions: number | null;
  authorizationsRevoked: number | null;
  blockers: string[];
  message: string;
}

/**
 * The exact phrase the server demands. Sent verbatim; the server re-checks it,
 * so this is a courtesy to the operator rather than the security boundary.
 */
export const START_TRADING_CONFIRMATION = "START TRADING";

export function postStartTrading(confirmation: string): Promise<TradingControlActionResult> {
  return operatorApiClient.post("/api/operator/trading-control/start", { confirmation });
}

export function postStopNewTrades(): Promise<TradingControlActionResult> {
  return operatorApiClient.post("/api/operator/trading-control/stop-new-trades");
}

export function postSafeOff(): Promise<TradingControlActionResult> {
  return operatorApiClient.post("/api/operator/trading-control/safe-off");
}
