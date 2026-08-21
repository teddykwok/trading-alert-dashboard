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
