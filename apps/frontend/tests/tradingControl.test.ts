import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TRADING_SYSTEM_STATES,
  formatTtl,
  presentAllowedSymbols,
  presentAttestation,
  presentAuthorization,
  presentBlockers,
  presentCapacity,
  presentLatestExecution,
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
    capacity: { pending: 1, open: 1, totalActive: 2, desiredOpen: 3, hardTotal: 5 },
    reservations: { riskUsd: "2.75", riskLimitUsd: "7.50", marginUsd: "7", marginLimitUsd: "40.00" },
    latestExecution: {
      symbol: "COWUSDT",
      direction: "LONG",
      status: "PROTECTED",
      reason: "PASS",
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
