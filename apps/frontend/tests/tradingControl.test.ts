import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TRADING_SYSTEM_STATES,
  formatAlertAgeLimit,
  formatTtl,
  presentAllowedSymbols,
  presentAttestation,
  presentAuthorization,
  presentBlockers,
  presentCapacity,
  humanizeReasonCode,
  presentExecutionReason,
  presentLatestExecution,
  presentOpenCapacity,
  presentPendingCapacity,
  READINESS_NOT_CHECKED,
  presentReadiness,
  presentReadinessSnapshot,
  presentReservation,
  presentRuntime,
  presentSystemState,
} from "../src/features/operator/tradingControlPresentation";
import {
  REJECTED_MESSAGE,
  UNREACHABLE_MESSAGE,
  authenticateOperator,
  isSessionEnded,
} from "../src/features/operator/operatorSession";
import { ApiRequestError, operatorApiClient } from "../src/api/client";
import { clearOperatorToken, hasOperatorToken, operatorAuthHeaders } from "../src/api/operator-token";
import {
  fetchTradingControlReadiness,
  fetchTradingControlStatus,
  type TradingControlReadinessSnapshot,
  type TradingControlStatusDto,
} from "../src/api/operator";
import { TRADING_CONTROL_POLL_MS } from "../src/hooks/useTradingControl";

/**
 * The Trading Control panel's display and session logic.
 *
 * The repo has no DOM test environment, so — exactly as `executionPresentation`
 * already does — every display decision lives in a pure module and is asserted
 * here directly. The component is a thin mapping over these functions, so what
 * an operator is told about a real-money account is under test even though the
 * JSX is not rendered.
 */

const TOKEN = "operator-test-token-0123456789abcdef";

function readinessFixture(
  overrides: Partial<TradingControlReadinessSnapshot> = {}
): TradingControlReadinessSnapshot {
  return {
    mode: "NATURAL_WINDOW",
    generatedAt: "2026-08-21T12:00:00.000Z",
    preparationReady: true,
    liveActivationReady: false,
    summary: "CANARY_BLOCKED_GATE_STATE",
    preparationBlockers: [],
    liveActivationBlockers: [
      { code: "CANARY_BLOCKED_GATE_STATE", scope: "LIVE_ACTIVATION", detail: "EXECUTION_LIVE_ENTRY_ENABLED is false" },
    ],
    ...overrides,
  };
}

function statusFixture(overrides: Partial<TradingControlStatusDto> = {}): TradingControlStatusDto {
  return {
    generatedAt: "2026-08-21T12:00:00.000Z",
    systemState: "SAFE_OFF",
    profile: { environment: "MAINNET", isEnabled: false, killSwitchActive: true },
    environmentGates: { globalKillSwitch: true, liveEntryEnabled: false, protectionReady: false },
    runtimeAttestation: { status: "PASS", reasonCode: null, message: null, backendCount: 1, workerCount: 1 },
    allowedSymbols: ["COWUSDT"],
    // Chart timeframe is never involved: this is the LEVEL timeframe policy.
    // The Extreme RR lookback governing NEW plans, as persisted.
    rrLookback: { stored: 300, effective: 300, valid: true, supported: [50, 100, 200, 300] },
    sourceTimeframes: {
      enforceable: ["1W", "1M"],
      unrecognized: [],
      valid: true,
      supported: ["1D", "1W", "1M", "3M", "6M", "12M"],
    },
    authorization: {
      state: "AVAILABLE",
      expiresAt: "2026-08-21T12:10:00.000Z",
      remainingTtlSeconds: 600,
      maxClaims: 5,
      claimedCount: 2,
      remainingClaims: 3,
    },
    alertAgeLimitSeconds: 300,
    capacity: { pending: 1, open: 1, totalActive: 2, desiredOpen: 3, hardTotal: 5, maxOpen: 5, maxPending: 5 },
    reservations: { riskUsd: "2.75", riskLimitUsd: "7.50", marginUsd: "7", marginLimitUsd: "40.00" },
    latestExecution: {
      symbol: "COWUSDT",
      direction: "LONG",
      status: "PROTECTED",
      reason: "PASS",
      sourceTimeframe: "1W",
      updatedAt: "2026-08-21T11:59:00.000Z",
    },
    manualIntervention: { present: false, count: 0 },
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  clearOperatorToken();
});

afterEach(() => {
  clearOperatorToken();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// State rendering
// ---------------------------------------------------------------------------

describe("trading control panel: the locked state model", () => {
  it.each([
    ["SAFE_OFF", "SAFE OFF", "green"],
    ["ARMED", "ARMED", "yellow"],
    ["SAFE_RECOVERY", "SAFE RECOVERY", "yellow"],
    ["INVALID", "INVALID", "red"],
    ["UNKNOWN", "UNKNOWN", "red"],
  ] as const)("renders %s as %s in %s", (state, label, tone) => {
    expect(presentSystemState(state)).toEqual({ label, tone });
  });

  it("gives the reassuring colour to SAFE OFF, never to ARMED", () => {
    // On an account that can lose real money, green must mean "nothing can be
    // opened" — not "we are trading".
    expect(presentSystemState("SAFE_OFF").tone).toBe("green");
    expect(presentSystemState("ARMED").tone).not.toBe("green");
  });

  it("renders every state the backend can send", () => {
    for (const state of TRADING_SYSTEM_STATES) {
      const presented = presentSystemState(state);
      expect(`${state}:${presented.label.length > 0}`).toBe(`${state}:true`);
    }
  });

  it("warns loudly on INVALID and on UNKNOWN", () => {
    // INVALID is a combination no operator command commits, and UNKNOWN means
    // the panel could not read the profile at all. Neither may look calm.
    expect(presentSystemState("INVALID").tone).toBe("red");
    expect(presentSystemState("UNKNOWN").tone).toBe("red");
  });
});

describe("trading control panel: runtime and attestation are separate facts", () => {
  it("reports Online from fresh role counts, not from the verdict", () => {
    // A runtime can be up and still fail attestation. Collapsing the two would
    // hide "running but misconfigured", which is the case that matters.
    const blockedButUp = {
      status: "BLOCKED" as const,
      reasonCode: "RUNTIME_ATTESTATION_MISMATCH",
      message: "gates differ",
      backendCount: 1,
      workerCount: 1,
    };
    expect(presentRuntime(blockedButUp).label).toBe("Online");
    expect(presentAttestation(blockedButUp)).toEqual({ label: "BLOCKED", tone: "red" });
  });

  it("reports Offline when nothing is publishing", () => {
    const down = { status: "BLOCKED" as const, reasonCode: "RUNTIME_ATTESTATION_MISSING", message: null, backendCount: 0, workerCount: 0 };
    expect(presentRuntime(down).label).toBe("Offline");
  });

  it("shows an unreadable attestation as unavailable rather than passing", () => {
    const unavailable = { status: "UNAVAILABLE" as const, reasonCode: null, message: null, backendCount: 0, workerCount: 0 };
    expect(presentAttestation(unavailable).label).toBe("unavailable");
    expect(presentAttestation(unavailable).tone).not.toBe("green");
  });
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

describe("trading control panel: readiness", () => {
  it("separates preparation from live activation", () => {
    expect(presentReadiness(true, "PREPARATION")).toEqual({ label: "READY", tone: "green" });
    expect(presentReadiness(false, "LIVE_ACTIVATION")).toEqual({ label: "BLOCKED", tone: "yellow" });
  });

  it("treats blocked PREPARATION as more serious than blocked LIVE ACTIVATION", () => {
    // A SAFE production system is expected to show live activation blocked.
    // Blocked preparation means the setup itself is wrong.
    expect(presentReadiness(false, "PREPARATION").tone).toBe("red");
    expect(presentReadiness(false, "LIVE_ACTIVATION").tone).toBe("yellow");
  });

  it("lists preparation blockers before live-activation blockers, verbatim", () => {
    const readiness = readinessFixture({
      preparationReady: false,
      liveActivationReady: false,
      summary: "CANARY_BLOCKED_POLICY",
      preparationBlockers: [{ code: "CANARY_BLOCKED_POLICY", scope: "PREPARATION", detail: "PROFILE_POLICY_MISMATCH" }],
      liveActivationBlockers: [
        { code: "CANARY_BLOCKED_KILL_SWITCH_STATE", scope: "LIVE_ACTIVATION", detail: "kill switch engaged" },
      ],
    });
    const blockers = presentBlockers(readiness);
    expect(blockers.map((b) => b.scope)).toEqual(["PREPARATION", "LIVE_ACTIVATION"]);
    // Not reworded in the browser: two vocabularies for one safety condition is
    // how an operator ends up unable to match the panel to the CLI.
    expect(blockers[0].detail).toBe("PROFILE_POLICY_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// Window, capacity, reservations
// ---------------------------------------------------------------------------

describe("trading control panel: window TTL and claims", () => {
  it.each([
    [0, "0s"],
    [-30, "0s"],
    [45, "45s"],
    [60, "1m 0s"],
    [600, "10m 0s"],
    [3661, "61m 1s"],
  ])("formats %s seconds as %s", (seconds, expected) => {
    expect(formatTtl(seconds)).toBe(expected);
  });

  it("shows claims as claimed over maximum", () => {
    expect(presentAuthorization(statusFixture().authorization)).toEqual({
      state: "AVAILABLE",
      ttl: "10m 0s",
      claims: "2 / 5",
    });
  });

  it("says None rather than inventing a window", () => {
    expect(presentAuthorization(null)).toEqual({ state: "None", ttl: "—", claims: "—" });
  });

  it("renders an expired window as EXPIRED with a zero countdown", () => {
    const expired = presentAuthorization({
      state: "EXPIRED",
      expiresAt: "2026-08-21T11:00:00.000Z",
      remainingTtlSeconds: 0,
      maxClaims: 5,
      claimedCount: 0,
      remainingClaims: 0,
    });
    expect(`${expired.state}:${expired.ttl}`).toBe("EXPIRED:0s");
  });
});

describe("trading control panel: capacity, risk and margin", () => {
  it("shows total active against the hard total", () => {
    expect(presentCapacity(statusFixture().capacity)).toBe("2 / 5");
  });

  it("shows reservations against their limits", () => {
    const status = statusFixture();
    expect(presentReservation(status.reservations.riskUsd, status.reservations.riskLimitUsd)).toBe("2.75 / 7.50 USD");
    expect(presentReservation(status.reservations.marginUsd, status.reservations.marginLimitUsd)).toBe("7 / 40.00 USD");
  });

  it("renders an empty allowed-symbol list as ALLOW ALL, never as nothing", () => {
    // [] means unrestricted in the policy. Rendering it as a blank line would
    // invert the meaning of the most important line on the card.
    expect(presentAllowedSymbols([])).toBe("ALL (unrestricted)");
    expect(presentAllowedSymbols(["COWUSDT"])).toBe("COWUSDT");
  });

  it("renders the latest execution, or None", () => {
    expect(presentLatestExecution(statusFixture().latestExecution)).toBe("COWUSDT LONG · PROTECTED");
    expect(presentLatestExecution(null)).toBe("None");
  });
});

// ---------------------------------------------------------------------------
// Why the latest execution was refused
// ---------------------------------------------------------------------------

/**
 * A refused execution, shaped as the status endpoint sends one.
 *
 * SKIPPED by default because that is the state the reason line exists for; the
 * healthy states are asserted separately below.
 */
function refused(overrides: Partial<NonNullable<TradingControlStatusDto["latestExecution"]>> = {}) {
  return {
    symbol: "ELSAUSDT",
    direction: "SHORT",
    status: "SKIPPED",
    reason: "SOURCE_TIMEFRAME_NOT_ALLOWED",
    sourceTimeframe: "1D",
    updatedAt: "2026-08-25T03:07:04.000Z",
    ...overrides,
  };
}

describe("latest execution: explaining a refusal", () => {
  it("A. names the timeframe a source-timeframe refusal was actually about", () => {
    // The whole point of the line. Naming the rule without its subject leaves
    // the operator to go and look up which timeframe it objected to.
    expect(presentExecutionReason(refused(), 300)).toBe("Source timeframe 1D is not allowed");
    expect(presentExecutionReason(refused({ sourceTimeframe: "3M" }), 300)).toBe(
      "Source timeframe 3M is not allowed"
    );
  });

  it("A2. stays truthful when the execution carries no source timeframe", () => {
    // Never renders "Source timeframe null is not allowed".
    const presented = presentExecutionReason(refused({ sourceTimeframe: null }), 300);
    expect(presented).toBe("The signal’s source timeframe is not allowed");
    expect(presented).not.toContain("null");
  });

  it("B. explains the USDT-only contract policy", () => {
    const presented = presentExecutionReason(refused({ reason: "USDT_ONLY_CONTRACT_REQUIRED" }), 300);
    expect(presented).toBe("This contract is not eligible for USDT-only execution");
  });

  it("C. explains an unsupported Binance Futures symbol", () => {
    const presented = presentExecutionReason(refused({ reason: "UNSUPPORTED_SYMBOL" }), 300);
    expect(presented).toBe("Symbol is not supported for Binance USDⓈ-M Futures");
  });

  it("D. states the stale-alert limit from policy rather than a hardcoded number", () => {
    // The limit is configurable, so the copy reads it instead of asserting a
    // duration that could quietly become wrong.
    expect(presentExecutionReason(refused({ reason: "ALERT_STALE" }), 300)).toBe(
      "Alert is older than the execution limit of 5 min"
    );
    expect(presentExecutionReason(refused({ reason: "ALERT_STALE" }), 600)).toBe(
      "Alert is older than the execution limit of 10 min"
    );
    // A non-round limit stays honest rather than rounding to the nearest minute.
    expect(presentExecutionReason(refused({ reason: "ALERT_STALE" }), 90)).toBe(
      "Alert is older than the execution limit of 1 min 30 sec"
    );
    // One formatter, so the sentence and the policy row can never disagree
    // about the same limit in front of the operator.
    for (const seconds of [300, 600, 90, 45, 3661]) {
      expect(presentExecutionReason(refused({ reason: "ALERT_STALE" }), seconds), String(seconds)).toContain(
        formatAlertAgeLimit(seconds)
      );
    }
  });

  it("E. includes the real symbol and side for a same-symbol-side refusal", () => {
    expect(presentExecutionReason(refused({ reason: "SYMBOL_SIDE_ALREADY_ACTIVE" }), 300)).toBe(
      "A ELSAUSDT SHORT execution is already active"
    );
    expect(
      presentExecutionReason(
        refused({ reason: "SYMBOL_HAS_OPEN_POSITION_OR_ORDER", symbol: "ENJUSDT" })
      )
    ).toBe("An open Binance position or order already exists for ENJUSDT");
  });

  it("F. degrades safely for a reason code this build has never seen", () => {
    // New codes ship with the backend, not with this file. An unknown one must
    // read as something rather than crashing or rendering a blank line.
    const presented = presentExecutionReason(refused({ reason: "SOME_FUTURE_POLICY_CODE" }), 300);
    expect(presented).toBe("Some future policy code");
    expect(presented).not.toBe("");
  });

  it("F2. never returns an empty string for any catalogued or malformed code", () => {
    const codes = [
      "SOURCE_TIMEFRAME_NOT_ALLOWED", "SOURCE_TIMEFRAME_UNAVAILABLE", "USDT_ONLY_CONTRACT_REQUIRED",
      "UNSUPPORTED_SYMBOL", "SYMBOL_NOT_TRADING", "UNSUPPORTED_CONTRACT", "SYMBOL_NOT_ALLOWED",
      "ALERT_STALE", "SIGNAL_TIME_UNAVAILABLE", "DUPLICATE_EXECUTION", "SYMBOL_SIDE_ALREADY_ACTIVE",
      "SYMBOL_HAS_OPEN_POSITION_OR_ORDER", "OPEN_POSITION_LIMIT_REACHED", "SOFT_OPEN_TARGET_REACHED",
      "PENDING_ENTRY_LIMIT_REACHED", "TOTAL_ACTIVE_LIMIT_REACHED", "TOTAL_RISK_LIMIT_REACHED",
      "TOTAL_MARGIN_LIMIT_REACHED", "INSUFFICIENT_AVAILABLE_BALANCE", "MARGIN_PLAN_NOT_READY",
      "MARGIN_PLAN_SNAPSHOT_MISSING", "UNSAFE_LIQUIDATION_BUFFER", "GLOBAL_KILL_SWITCH_ACTIVE",
      "PROFILE_KILL_SWITCH_ACTIVE", "PROFILE_DISABLED", "PROFILE_ENVIRONMENT_MISMATCH",
      "PROFILE_POLICY_UNAVAILABLE", "RECOVERY_REQUIRED", "EXPECTED_HEDGE_MODE",
      "EXPECTED_SINGLE_ASSET_MODE", "EXPECTED_ISOLATED_MARGIN_TYPE", "NATURAL_AUTHORIZATION_REQUIRED",
      "NATURAL_AUTHORIZATION_INVALID", "NATURAL_AUTHORIZATION_REVOKED", "NATURAL_AUTHORIZATION_EXPIRED",
      "NATURAL_AUTHORIZATION_EXHAUSTED", "NATURAL_AUTHORIZATION_DIRECTION_NOT_ALLOWED",
      "NATURAL_AUTHORIZATION_CONFLICT", "BINANCE_ACCOUNT_STATE_UNAVAILABLE",
      "BINANCE_SYMBOL_STATE_UNAVAILABLE", "CAPACITY_CONFLICT_RETRY", "ENTRY_SUBMISSION_REJECTED",
      "ENTRY_SUBMISSION_ABANDONED", "ENTRY_TTL_EXPIRED", "ENTRY_ORDER_NOT_FOUND",
      "ENTRY_ORDER_IDENTITY_MISMATCH", "EXTERNAL", "totally_unknown",
    ];
    for (const reason of codes) {
      const presented = presentExecutionReason(refused({ reason }), 300);
      expect(presented, reason).toBeTruthy();
      expect((presented ?? "").length, reason).toBeGreaterThan(3);
      // Operator copy, never a raw enum echoed back at them.
      expect(presented, reason).not.toBe(reason);
    }
  });

  it("F3. degenerate input still never renders a blank Reason line", () => {
    // The guarantee is non-blank, not eloquence: a one-character code cannot
    // come from this backend's catalogue, and inventing a special case for it
    // would be complexity bought for input that does not occur.
    for (const reason of ["x", "_", "A_B"]) {
      expect(presentExecutionReason(refused({ reason }), 300), reason).toBeTruthy();
    }
  });

  it("G. shows NO reason for a healthy execution that is simply progressing", () => {
    // ENTRY_PENDING sits on ENTRY_RECONCILED, which means the order is resting
    // exactly as intended. Printing that under "Reason:" would report a problem
    // for a trade that is working.
    for (const status of ["ENTRY_PENDING", "ENTRY_FILLED", "PROTECTED", "PLAN_READY", "PREFLIGHT"]) {
      expect(presentExecutionReason(refused({ status, reason: "ENTRY_RECONCILED" }), 300), status).toBeNull();
    }
    expect(presentExecutionReason(statusFixture().latestExecution, 300)).toBeNull();
  });

  it("G2. does show a reason for the terminal states an operator must act on", () => {
    for (const status of ["SKIPPED", "FAILED", "MANUAL_INTERVENTION", "ENTRY_EXPIRED"]) {
      expect(presentExecutionReason(refused({ status }), 300), status).toBeTruthy();
    }
  });

  it("H. shows nothing when there is no execution, and leaves the empty state alone", () => {
    expect(presentExecutionReason(null, 300)).toBeNull();
    expect(presentLatestExecution(null)).toBe("None");
    // A refusal with no persisted code must not render a dangling label.
    expect(presentExecutionReason(refused({ reason: null }), 300)).toBeNull();
    expect(presentExecutionReason(refused({ reason: "" }), 300)).toBeNull();
  });

  it("H2. leaves the headline line exactly as it was", () => {
    // The reason is additive: the symbol/side/status line an operator already
    // scans for must not move or change shape.
    expect(presentLatestExecution(refused())).toBe("ELSAUSDT SHORT · SKIPPED");
  });

  it("humanizeReasonCode turns any shape into readable text", () => {
    expect(humanizeReasonCode("SOME_NEW_CODE")).toBe("Some new code");
    expect(humanizeReasonCode("SINGLE")).toBe("Single");
    expect(humanizeReasonCode("   ")).toBe("Refused for an unspecified reason");
  });
});

describe("latest execution reason: presentation only", () => {
  it("renders the reason as a secondary line and keeps the raw code on hover", () => {
    const card = readFileSync(
      path.join(process.cwd(), "src/components/operator/TradingControlCard.tsx"),
      "utf8"
    );
    // Secondary styling, not a new error box.
    expect(card).toContain("Reason: {executionReason}");
    expect(card).toContain("text-xs font-normal leading-snug text-slate-400");
    // The raw code stays reachable without putting jargon on the card.
    expect(card).toContain("title={status.latestExecution?.reason ?? undefined}");
    // Rendered only when there is something to say.
    expect(card).toContain("{executionReason && (");
  });

  it("derives its copy from persisted fields only — it parses no prose", () => {
    const presentation = readFileSync(
      path.join(process.cwd(), "src/features/operator/tradingControlPresentation.ts"),
      "utf8"
    );
    // The backend keeps additional failed checks only as a prose sentence, and
    // scraping that would break the moment the wording changed. The reason line
    // is built from the structured code and context, or not at all.
    for (const forbidden of ["sanitizedMessage", "\\bsplit(", "match(/", "indexOf("]) {
      expect(`${forbidden}:${presentation.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

describe("trading control panel: readiness is an answer, not a reading", () => {
  it("says Not checked yet before the operator has asked", () => {
    // Showing READY or BLOCKED without having asked would be inventing a safety
    // conclusion, which is worse than showing nothing.
    for (const scope of ["PREPARATION", "LIVE_ACTIVATION"] as const) {
      const presented = presentReadinessSnapshot(null, scope);
      expect(presented.label).toBe(READINESS_NOT_CHECKED);
      // And it must not borrow the reassuring colour while saying it.
      expect(presented.tone).not.toBe("green");
    }
  });

  it("renders the verdict once a snapshot exists", () => {
    const snapshot = readinessFixture();
    expect(presentReadinessSnapshot(snapshot, "PREPARATION")).toEqual({ label: "READY", tone: "green" });
    expect(presentReadinessSnapshot(snapshot, "LIVE_ACTIVATION")).toEqual({ label: "BLOCKED", tone: "yellow" });
  });
});

// ---------------------------------------------------------------------------
// The status / readiness cost boundary
// ---------------------------------------------------------------------------

describe("trading control panel: polling calls status only", () => {
  function stubFetch() {
    const calls: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      calls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => (url.endsWith("/readiness") ? readinessFixture() : statusFixture()),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  }

  it("polls the cheap status route and never the readiness route", async () => {
    const calls = stubFetch();
    await authenticateOperator(TOKEN, async () => ({ authenticated: true }));

    // Ten polls, exactly as the fifteen-second timer would drive them.
    for (let poll = 0; poll < 10; poll += 1) await fetchTradingControlStatus();

    expect(calls).toHaveLength(10);
    expect(calls.every((url) => url === "/api/operator/trading-control/status")).toBe(true);
    // The route that can cost signed exchange reads is never on the timer.
    expect(calls.some((url) => url.endsWith("/readiness"))).toBe(false);
  });

  it("hits the readiness route only when explicitly asked", async () => {
    const calls = stubFetch();
    await authenticateOperator(TOKEN, async () => ({ authenticated: true }));

    await fetchTradingControlStatus();
    expect(calls.filter((url) => url.endsWith("/readiness"))).toHaveLength(0);

    await fetchTradingControlReadiness();
    expect(calls.filter((url) => url.endsWith("/readiness"))).toEqual([
      "/api/operator/trading-control/readiness",
    ]);
  });

  it("sends the operator token to the readiness route too", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => readinessFixture() });
    vi.stubGlobal("fetch", fetchMock);
    await authenticateOperator(TOKEN, async () => ({ authenticated: true }));

    await fetchTradingControlReadiness();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("keeps the poll interval slow enough to be polite", () => {
    // Not a magic number for its own sake: this is the timer the operator's
    // browser runs against their own backend, and it must stay in seconds.
    expect(TRADING_CONTROL_POLL_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("carries no readiness verdict on the polled payload", () => {
    // The panel must not be able to render a readiness answer it never asked
    // for, or a stale one from a previous check.
    expect("readiness" in statusFixture()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The locked future actions
// ---------------------------------------------------------------------------

describe("trading control panel: the actions are no longer placeholders", () => {
  it("no longer exports a locked-placeholder table", () => {
    // Superseded, not dropped: the three actions are real now and live in
    // `tradingControlActions`, asserted in tradingControlActions.test.ts. A
    // leftover placeholder list would be a second source of truth about what
    // the panel offers.
    const presentation = readFileSync(
      path.join(process.cwd(), "src/features/operator/tradingControlPresentation.ts"),
      "utf8"
    );
    expect(presentation).not.toContain("LOCKED_ACTIONS");
    expect(presentation).not.toContain("LOCKED_ACTION_HINT");
  });
});

// ---------------------------------------------------------------------------
// Operator session
// ---------------------------------------------------------------------------

describe("trading control panel: operator sign-in", () => {
  it("keeps the token when the probe accepts it", async () => {
    const outcome = await authenticateOperator(TOKEN, async () => ({ authenticated: true }));
    expect(outcome).toEqual({ ok: true });
    expect(hasOperatorToken()).toBe(true);
    expect(operatorAuthHeaders()).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("drops the token when the server rejects it", async () => {
    const outcome = await authenticateOperator(TOKEN, async () => {
      throw new ApiRequestError(401, { error: "UnauthorizedError", message: "Operator authorization required" });
    });
    expect(outcome).toEqual({ ok: false, state: "AUTH_FAILED", message: REJECTED_MESSAGE });
    // A credential that has not been proven good must not linger where the next
    // request could send it.
    expect(hasOperatorToken()).toBe(false);
  });

  it("drops the token on a network failure too, and says so differently", async () => {
    const outcome = await authenticateOperator(TOKEN, async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(outcome).toEqual({ ok: false, state: "AUTH_FAILED", message: UNREACHABLE_MESSAGE });
    expect(hasOperatorToken()).toBe(false);
  });

  it("never puts the token in the failure message", async () => {
    const outcome = await authenticateOperator(TOKEN, async () => {
      throw new ApiRequestError(401, { error: "UnauthorizedError", message: "nope" });
    });
    expect(JSON.stringify(outcome)).not.toContain(TOKEN.slice(0, 12));
  });

  it("ends the session on a mid-session 401 and on nothing else", () => {
    expect(isSessionEnded(new ApiRequestError(401))).toBe(true);
    expect(isSessionEnded(new ApiRequestError(500))).toBe(false);
    expect(isSessionEnded(new Error("offline"))).toBe(false);
  });

  it("never persists the token to browser storage", async () => {
    const store = new Map<string, string>();
    const fake = {
      setItem: vi.fn((k: string, v: string) => void store.set(k, v)),
      getItem: vi.fn((k: string) => store.get(k) ?? null),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    };
    vi.stubGlobal("localStorage", fake);
    vi.stubGlobal("sessionStorage", fake);

    await authenticateOperator(TOKEN, async () => ({ authenticated: true }));

    expect(fake.setItem).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

describe("trading control panel: requests", () => {
  it("sends the bearer token to the status route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => statusFixture() });
    vi.stubGlobal("fetch", fetchMock);
    await authenticateOperator(TOKEN, async () => ({ authenticated: true }));

    await fetchTradingControlStatus();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/operator/trading-control/status");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("still refuses to send the operator token anywhere else", async () => {
    await authenticateOperator(TOKEN, async () => ({ authenticated: true }));
    for (const path of ["/api/executions", "/api/alerts", "https://example.com/api/operator/status"]) {
      expect(() => operatorApiClient.get(path)).toThrow(/non-operator path/);
    }
  });
});

// ---------------------------------------------------------------------------
// Scannability: policy, capacity and grouping
// ---------------------------------------------------------------------------

describe("trading policy: the alert age limit is shown as POLICY", () => {
  it("A/B. formats the effective limit, never a hardcoded five minutes", () => {
    expect(formatAlertAgeLimit(300)).toBe("5 min");
    expect(formatAlertAgeLimit(600)).toBe("10 min");
    expect(formatAlertAgeLimit(60)).toBe("1 min");
  });

  it("C. formats a non-round duration without lying about it", () => {
    expect(formatAlertAgeLimit(90)).toBe("1 min 30 sec");
    expect(formatAlertAgeLimit(45)).toBe("45 sec");
    expect(formatAlertAgeLimit(3661)).toBe("61 min 1 sec");
  });

  it("C2. degrades safely rather than rendering a nonsense duration", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatAlertAgeLimit(bad), String(bad)).toBe("Not configured");
    }
  });

  it("reads the value straight from the status feed", () => {
    const status = statusFixture({ alertAgeLimitSeconds: 900 });
    expect(formatAlertAgeLimit(status.alertAgeLimitSeconds)).toBe("15 min");
  });

  it("J. never labels the limit as a touch time or a signal age", () => {
    // The timestamp the backend measures age FROM is under separate review, so
    // the panel states the RULE and claims nothing about when a level was
    // touched or how old any particular signal was.
    const card = readFileSync(
      path.join(process.cwd(), "src/components/operator/TradingControlCard.tsx"),
      "utf8"
    );
    const presentation = readFileSync(
      path.join(process.cwd(), "src/features/operator/tradingControlPresentation.ts"),
      "utf8"
    );
    for (const forbidden of ["Touch time", "touchedAt", "Signal age", "triggeredAt", "seconds after touch"]) {
      expect(`card ${forbidden}:${card.includes(forbidden)}`).toBe(`card ${forbidden}:false`);
      expect(`presentation ${forbidden}:${presentation.includes(forbidden)}`).toBe(
        `presentation ${forbidden}:false`
      );
    }
    expect(card).toContain('<Row label="Alert Age Limit">');
  });
});

describe("capacity: each count against the limit that governs it", () => {
  it("H. shows open, pending and active with their own denominators", () => {
    const capacity = statusFixture().capacity;
    // Pending entries measured against the TOTAL-active limit would read as
    // more headroom than the operator actually has.
    expect(presentOpenCapacity(capacity)).toBe("1 / 5 (target 3)");
    expect(presentPendingCapacity(capacity)).toBe("1 / 5");
    expect(presentCapacity(capacity)).toBe("2 / 5");
  });

  it("keeps the soft target distinct from the hard limit", () => {
    const capacity = statusFixture({
      capacity: { pending: 2, open: 3, totalActive: 5, desiredOpen: 3, hardTotal: 5, maxOpen: 5, maxPending: 5 },
    }).capacity;
    const presented = presentOpenCapacity(capacity);
    expect(presented).toContain("3 / 5");
    expect(presented).toContain("target 3");
  });

  it("derives no totals of its own", () => {
    // Every number on the card comes from the backend read model. A second
    // frontend computation could disagree with admission, which is the one
    // thing a capacity display must never do.
    const presentation = readFileSync(
      path.join(process.cwd(), "src/features/operator/tradingControlPresentation.ts"),
      "utf8"
    );
    for (const forbidden of ["reduce(", "filter(", " + 1", "Number("]) {
      expect(`${forbidden}:${presentation.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

describe("trading control layout: grouped, and nothing lost", () => {
  const card = readFileSync(
    path.join(process.cwd(), "src/components/operator/TradingControlCard.tsx"),
    "utf8"
  );

  it("G. groups the rows into the order an operator asks in", () => {
    // "Capacity" was split in two. It used to hold observed counts AND the
    // limits they are measured against under one heading, which is precisely
    // the conflation the policy editor must not inherit: one half is fact and
    // read-only, the other is settings. The rows themselves are unchanged and
    // still pinned by G2 below.
    for (const title of [
      "System",
      "Trading Policy",
      "Authorization",
      "Current Exposure",
      "Policy Limits",
      "Latest Execution",
    ]) {
      expect(card).toContain(`<Section title="${title}">`);
    }
    // The order matters: safety first, outcome last, and the limits sit
    // immediately after the exposure they govern.
    const at = (title: string) => card.indexOf(`<Section title="${title}">`);
    expect(at("System")).toBeLessThan(at("Trading Policy"));
    expect(at("Trading Policy")).toBeLessThan(at("Authorization"));
    expect(at("Authorization")).toBeLessThan(at("Current Exposure"));
    expect(at("Current Exposure")).toBeLessThan(at("Policy Limits"));
    expect(at("Policy Limits")).toBeLessThan(at("Latest Execution"));
  });

  it("G2. keeps every row that existed before the regrouping", () => {
    for (const label of [
      "System", "Runtime", "Attestation", "Preparation", "Live Activation",
      "Allowed Symbols", "Source TFs", "RR lookback", "Natural Window", "TTL",
      "Active", "Risk", "Margin",
      // "Claims" moved OUT of Current Exposure and into its own
      // "Authorization (internal)" section as "Window claims". It never
      // measured trade progress — a claim is spent at admission and never
      // refunded — and standing beside the exposure counts it read as though
      // it did. Session > Opened is the operator-facing progress now.
      "Window claims",
    ]) {
      expect(card, label).toContain(`<Row label="${label}">`);
    }
  });

  it("I. keeps every safety-critical action and its confirmation flow", () => {
    const page = readFileSync(
      path.join(process.cwd(), "src/components/operator/TradingControlCard.tsx"),
      "utf8"
    );
    // Nothing in this feature may remove or rename an operator action.
    for (const marker of ["Check Readiness", "Blockers ("]) {
      expect(page, marker).toContain(marker);
    }
  });

  it("keeps the section heading quieter than the state it labels", () => {
    // A group label must never compete with SAFE OFF or BLOCKED.
    expect(card).toContain('className="text-[10px] font-semibold uppercase tracking-widest text-slate-500"');
    expect(card).toContain('<Badge tone={system.tone}>{system.label}</Badge>');
  });

  it("J. lets the reason wrap instead of overflowing", () => {
    expect(card).toContain("min-w-0 text-right text-sm text-slate-200");
    expect(card).toContain("text-xs font-normal leading-snug text-slate-400");
  });
});
