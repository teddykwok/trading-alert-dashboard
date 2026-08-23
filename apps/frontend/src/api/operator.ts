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
  /**
   * The SOURCE timeframes admission will accept — the timeframe the LEVEL
   * originated on, never the chart timeframe the alert fired on.
   *
   * `valid` is false when the stored policy admits nothing or carries an
   * unrecognised value. The panel reports that rather than widening it.
   */
  sourceTimeframes: {
    enforceable: string[];
    unrecognized: string[];
    valid: boolean;
    supported: string[];
  };
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

/**
 * The supervised window lengths the server accepts. Mirrored for the selector;
 * the server validates the submitted value independently and refuses anything
 * else, so this list decides what is OFFERED and never what is permitted.
 */
export const START_TRADING_DURATION_CHOICES = [15, 30, 60] as const;
export type StartTradingDuration = (typeof START_TRADING_DURATION_CHOICES)[number];

export function postStartTrading(
  confirmation: string,
  durationMinutes: StartTradingDuration
): Promise<TradingControlActionResult> {
  return operatorApiClient.post("/api/operator/trading-control/start", {
    confirmation,
    durationMinutes,
  });
}

// --- Allowlist management ---------------------------------------------------

export interface AllowlistRejectedEntry {
  input: string;
  symbol: string | null;
  reasonCode: string;
  detail: string;
}

export interface AllowlistCounts {
  input: number;
  normalized: number;
  valid: number;
  duplicates: number;
  rejected: number;
}

export interface AllowlistValidationDto {
  ok: boolean;
  counts: AllowlistCounts;
  accepted: string[];
  rejected: AllowlistRejectedEntry[];
  refusal: string | null;
  current: string[];
}

export interface AllowlistSaveDto {
  ok: boolean;
  outcome: "SAVED" | "BLOCKED";
  blockers: string[];
  message: string;
  allowedSymbols: string[] | null;
  counts: AllowlistCounts | null;
  rejected: AllowlistRejectedEntry[];
}

/** Dry run. Writes nothing, so it is safe to call in any system state. */
export function postValidateAllowlist(symbols: string): Promise<AllowlistValidationDto> {
  return operatorApiClient.post("/api/operator/trading-control/allowlist/validate", { symbols });
}

/**
 * The mutation. Sends the RAW text again rather than the validated list: the
 * server re-parses and re-validates, so there is no "already checked" claim
 * for a client to make.
 */
export function postSaveAllowlist(symbols: string): Promise<AllowlistSaveDto> {
  return operatorApiClient.post("/api/operator/trading-control/allowlist", { symbols });
}

export interface SourceTimeframePolicyDto {
  stored: string[];
  enforceable: string[];
  unrecognized: string[];
  valid: boolean;
  supported: string[];
}

export interface SourceTimeframeSaveDto {
  ok: boolean;
  outcome: "SAVED" | "BLOCKED";
  blockers: string[];
  message: string;
  allowedSourceTimeframes: string[] | null;
  counts: { input: number; valid: number; duplicates: number; rejected: number } | null;
  rejected: { input: string; reasonCode: string; detail: string }[];
}

/** The policy in force. A read, so it stays available in any system state. */
export function getSourceTimeframes(): Promise<SourceTimeframePolicyDto> {
  return operatorApiClient.get("/api/operator/trading-control/source-timeframes");
}

/**
 * The mutation. The server re-validates the selection from scratch and
 * re-checks the durable safe state inside its transaction, so nothing here
 * asserts that a previous read is still true.
 */
export function postSourceTimeframes(
  sourceTimeframes: readonly string[]
): Promise<SourceTimeframeSaveDto> {
  return operatorApiClient.post("/api/operator/trading-control/source-timeframes", {
    sourceTimeframes: [...sourceTimeframes],
  });
}

export function postStopNewTrades(): Promise<TradingControlActionResult> {
  return operatorApiClient.post("/api/operator/trading-control/stop-new-trades");
}

export function postSafeOff(): Promise<TradingControlActionResult> {
  return operatorApiClient.post("/api/operator/trading-control/safe-off");
}
