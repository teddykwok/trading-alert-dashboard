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
  /**
   * How many closed candles a NEW Extreme RR plan will search for its extreme.
   *
   * `valid` is false when the stored value is not one of the supported
   * lookbacks — the panel reports that rather than showing a number nobody
   * stored.
   */
  rrLookback: { stored: number; effective: number | null; valid: boolean; supported: number[] };
  authorization: {
    state: string;
    expiresAt: string;
    remainingTtlSeconds: number;
    maxClaims: number | null;
    claimedCount: number;
    remainingClaims: number;
  } | null;
  alertAgeLimitSeconds: number;
  /**
   * Cumulative SESSION accounting, deliberately separate from `capacity`.
   *
   * `capacity` is how much is open right now; this is how many trades the
   * session has opened out of how many it may. Merging them would put a fact
   * and a running total under one heading — the confusion the old CLAIMS row
   * created.
   */
  session: {
    id: string;
    status: string;
    tradeBudget: number | null;
    unlimited: boolean;
    openedCount: number;
    reservedCount: number;
    remaining: number | null;
    /**
     * Whether Resume may be offered. Decided by the SERVER: a session that
     * expired or exhausted itself while paused is not resumable however its
     * stored status reads, and the browser has no clock worth trusting for it.
     */
    resumable: boolean;
    startedAt: string;
    expiresAt: string;
    endedAt: string | null;
    remainingTtlSeconds: number;
  } | null;
  capacity: {
    pending: number;
    open: number;
    totalActive: number;
    desiredOpen: number;
    hardTotal: number;
    maxOpen: number;
    maxPending: number;
  };
  reservations: { riskUsd: string; riskLimitUsd: string; marginUsd: string; marginLimitUsd: string };
  latestExecution: {
    symbol: string;
    direction: string;
    status: string;
    reason: string | null;
    /** Frozen on the execution; names the timeframe a source-TF refusal was about. */
    sourceTimeframe: string | null;
    updatedAt: string;
  } | null;
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
 * Resume reopens LIVE admission, so it carries the same friction as starting.
 *
 * Pause deliberately has no phrase: it only ever makes the system safer, and
 * an operator reaching for it mid-incident should not have to type first.
 */
export const RESUME_TRADING_CONFIRMATION = "RESUME TRADING";

/**
 * The supervised window lengths the server accepts. Mirrored for the selector;
 * the server validates the submitted value independently and refuses anything
 * else, so this list decides what is OFFERED and never what is permitted.
 *
 * 1h / 6h / 12h / 24h / 3d / 7d / 30d. 30 days is the ceiling for a custom
 * value too — a session is finite by design, with one fixed start and one
 * fixed expiry, and nothing here renews it.
 */
export const START_TRADING_DURATION_CHOICES = [60, 360, 720, 1440, 4320, 10080, 43200] as const;
export type StartTradingDuration = (typeof START_TRADING_DURATION_CHOICES)[number];

/** The trade-budget presets offered beside a custom field. */
export const START_TRADING_BUDGET_CHOICES = [10, 50, 100, 200, 300] as const;

/**
 * What the server permits for a NEW session.
 *
 * `unlimitedPermitted` is the server's own answer, derived from the execution
 * profile AND the connector URL. The panel renders it; it never decides it. A
 * UI label saying "paper" is a claim, not evidence.
 */
export interface SessionCapabilityDto {
  unlimitedPermitted: boolean;
  profileEnvironment: string;
  connectorEnvironment: string;
  reason: string;
  durationPresetMinutes: number[];
  maxDurationMinutes: number;
  budgetPresets: number[];
  maxTradeBudget: number;
}

export function fetchSessionCapability(): Promise<SessionCapabilityDto> {
  return operatorApiClient.get<SessionCapabilityDto>(
    "/api/operator/trading-control/session-capability"
  );
}

/**
 * Opens a session.
 *
 * `unlimited` is a REQUEST, not an instruction: the server refuses it unless it
 * can itself prove the environment is non-live, and refuses outright rather
 * than downgrading to a finite budget.
 */
export function postStartTrading(
  confirmation: string,
  durationMinutes: number,
  tradeBudget?: number,
  unlimited?: boolean
): Promise<TradingControlActionResult> {
  return operatorApiClient.post("/api/operator/trading-control/start", {
    confirmation,
    durationMinutes,
    ...(unlimited ? { unlimited: true } : tradeBudget !== undefined ? { tradeBudget } : {}),
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

export interface RrLookbackPolicyDto {
  stored: number;
  effective: number | null;
  valid: boolean;
  supported: number[];
}

export interface RrLookbackSaveDto {
  ok: boolean;
  outcome: "SAVED" | "BLOCKED";
  blockers: string[];
  message: string;
  extremeRrLookbackCandles: number | null;
}

/** The policy in force. A read, so it stays available in any system state. */
export function getRrLookback(): Promise<RrLookbackPolicyDto> {
  return operatorApiClient.get("/api/operator/trading-control/rr-lookback");
}

/**
 * The mutation. The server re-validates the value and re-checks the durable
 * safe state inside its transaction, so nothing here asserts that a previous
 * read is still true.
 */
export function postRrLookback(lookbackCandles: number): Promise<RrLookbackSaveDto> {
  return operatorApiClient.post("/api/operator/trading-control/rr-lookback", {
    lookbackCandles,
  });
}


export function postStopNewTrades(): Promise<TradingControlActionResult> {
  return operatorApiClient.post("/api/operator/trading-control/stop-new-trades");
}

/** Pause sends no body: there is no phrase to confirm. */
export function postPauseNewTrades(): Promise<TradingControlActionResult> {
  return operatorApiClient.post("/api/operator/trading-control/pause-new-trades");
}

export function postResumeNewTrades(confirmation: string): Promise<TradingControlActionResult> {
  return operatorApiClient.post("/api/operator/trading-control/resume-new-trades", { confirmation });
}

export function postSafeOff(): Promise<TradingControlActionResult> {
  return operatorApiClient.post("/api/operator/trading-control/safe-off");
}

// ---------------------------------------------------------------------------
// Execution policy LIMITS
// ---------------------------------------------------------------------------

/**
 * The limits the policy editor may write.
 *
 * A subset of the durable safety policy on purpose. The kill switch is a
 * trading CONTROL owned by Start Trading / Safe Off, and the symbol allowlist
 * has its own reviewed editor; neither is reachable from here.
 */
export const EDITABLE_POLICY_FIELDS = [
  "softOpenPositionTarget",
  "maxOpenPositions",
  "maxPendingEntries",
  "maxTotalActiveTrades",
  "maxActivePerSymbolSide",
  "maxTotalPlannedRiskUsd",
  "maxTotalIsolatedMarginUsd",
] as const;

export type EditablePolicyField = (typeof EDITABLE_POLICY_FIELDS)[number];

/**
 * One limit, as stored and as actually enforced.
 *
 * The two differ because the engine takes `min(env, policy)` for every limit —
 * the environment can only tighten. `cappedByEnv` is what lets the panel say
 * so, instead of showing a stored number that governs nothing.
 */
export interface PolicyFieldDto {
  stored: string;
  effective: string;
  envCeiling: string;
  cappedByEnv: boolean;
}

export interface PolicyReadDto {
  ok: boolean;
  /** Optimistic-lock token; the save echoes it back. */
  version: number | null;
  fields: Record<EditablePolicyField, PolicyFieldDto> | null;
  blockers: string[];
  editable: boolean;
  message: string;
}

export interface PolicyChangeDto {
  field: EditablePolicyField;
  from: string;
  to: string;
}

export interface PolicyValidationDto {
  ok: boolean;
  changes: PolicyChangeDto[];
  refusal: string | null;
}

export interface PolicySaveDto {
  ok: boolean;
  outcome: "SAVED" | "BLOCKED";
  blockers: string[];
  message: string;
  changes: PolicyChangeDto[];
  version: number | null;
}

/** Current limits plus whether they may be edited. Writes nothing. */
export function fetchPolicy(): Promise<PolicyReadDto> {
  return operatorApiClient.get<PolicyReadDto>("/api/operator/trading-control/policy");
}

/**
 * Dry run for the review step. Writes nothing, so it is safe in any system
 * state, and it runs the SAME validator the save runs — a draft this accepts
 * is one the save accepts.
 */
export function postValidatePolicy(policy: Record<string, unknown>): Promise<PolicyValidationDto> {
  return operatorApiClient.post("/api/operator/trading-control/policy/validate", { policy });
}

/**
 * The mutation. Sends the draft again rather than the validated diff: the
 * server re-validates inside its own lock, so there is no "already checked"
 * claim for a client to make.
 */
export function postSavePolicy(
  policy: Record<string, unknown>,
  expectedVersion: number
): Promise<PolicySaveDto> {
  return operatorApiClient.post("/api/operator/trading-control/policy", { policy, expectedVersion });
}
