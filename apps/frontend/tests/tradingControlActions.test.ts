import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  START_ATTESTATION_WARNING,
  START_MAX_CLAIMS,
  START_PREREQUISITE_REASON,
  START_WINDOW_MINUTES,
  canEditAllowlist,
  describeAllowlist,
  describeAllowlistCounts,
  groupRejections,
  TRADING_CONTROL_ACTIONS,
  describeStartContext,
  describeStartPrerequisite,
  findAction,
  isActionRelevant,
  isConfirmationSatisfied,
  presentActionResult,
} from "../src/features/operator/tradingControlActions";
import { START_TRADING_DURATION_CHOICES } from "../src/api/operator";
import {
  RESUME_TRADING_CONFIRMATION,
  START_TRADING_CONFIRMATION,
  postSafeOff,
  postStartTrading,
  postStopNewTrades,
  type TradingControlStatusDto,
} from "../src/api/operator";
import { ApiRequestError, operatorApiClient } from "../src/api/client";
import { clearOperatorToken, hasOperatorToken } from "../src/api/operator-token";
import { authenticateOperator, isSessionEnded } from "../src/features/operator/operatorSession";

/**
 * The three operator actions, from the browser's side.
 *
 * These buttons can arm a real-money account, so the properties asserted here
 * are the ones that keep an operator honest with themselves: the confirmation
 * phrase must match exactly, a button must not be offered for a state where it
 * makes no sense, a refusal must be shown with the server's own words, and a
 * refused action must never be mistaken for a successful one.
 *
 * Pure modules only, per the repo's existing convention — no DOM framework was
 * added for this.
 */

const TOKEN = "operator-test-token-0123456789abcdef";

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
    authorization: null,
    capacity: { pending: 0, open: 0, totalActive: 0, desiredOpen: 3, hardTotal: 5 },
    reservations: { riskUsd: "0", riskLimitUsd: "7.5", marginUsd: "0", marginLimitUsd: "40" },
    latestExecution: null,
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
// The action table
// ---------------------------------------------------------------------------

describe("operator actions: the five controls", () => {
  it("offers exactly Start, Pause, Resume, Stop and Safe Off", () => {
    expect(TRADING_CONTROL_ACTIONS.map((action) => action.label)).toEqual([
      "Start Trading",
      "Pause New Trades",
      "Resume New Trades",
      "Stop New Trades",
      "Safe Off",
    ]);
  });

  it("requires a typed phrase for the two that OPEN admission, and nothing else", () => {
    // Start and Resume are the only actions that let new trades be admitted,
    // so they are the only ones that earn the highest-friction confirmation.
    // Pause, Stop and Safe Off only ever reduce risk, and an operator reaching
    // for one during an incident should not have to type first.
    expect(findAction("START").requiredPhrase).toBe(START_TRADING_CONFIRMATION);
    expect(findAction("RESUME_NEW_TRADES").requiredPhrase).toBe(RESUME_TRADING_CONFIRMATION);
    expect(findAction("PAUSE_NEW_TRADES").requiredPhrase).toBeNull();
    expect(findAction("STOP_NEW_TRADES").requiredPhrase).toBeNull();
    expect(findAction("SAFE_OFF").requiredPhrase).toBeNull();
  });

  // TEST P -------------------------------------------------------------------
  it("P. offers Pause on an ACTIVE session and Resume on a PAUSED one", () => {
    const active = { status: "ACTIVE", resumable: false };
    const paused = { status: "PAUSED", resumable: true };

    // ARMED with a live session: Pause, not Resume.
    expect(isActionRelevant("PAUSE_NEW_TRADES", "ARMED", active)).toBe(true);
    expect(isActionRelevant("RESUME_NEW_TRADES", "ARMED", active)).toBe(false);

    // Paused: the kill switch is engaged, so the profile reads SAFE_RECOVERY.
    // Resume, not Pause.
    expect(isActionRelevant("RESUME_NEW_TRADES", "SAFE_RECOVERY", paused)).toBe(true);
    expect(isActionRelevant("PAUSE_NEW_TRADES", "SAFE_RECOVERY", paused)).toBe(false);

    // Safe Off stays reachable beside Resume — a paused session must always be
    // terminable without resuming it first.
    expect(isActionRelevant("SAFE_OFF", "SAFE_RECOVERY", paused)).toBe(true);
  });

  it("P2. never offers Resume for a terminal or absent session", () => {
    // The server's own verdict is the gate. A status string that says PAUSED
    // while `resumable` is false — a session that expired or exhausted itself
    // while paused — must not surface the button.
    for (const session of [
      null,
      { status: "REVOKED", resumable: false },
      { status: "EXPIRED", resumable: false },
      { status: "EXHAUSTED", resumable: false },
      { status: "ACTIVE", resumable: false },
      { status: "PAUSED", resumable: false },
    ]) {
      const label = session ? session.status : "none";
      expect(`${label}:${isActionRelevant("RESUME_NEW_TRADES", "SAFE_RECOVERY", session)}`).toBe(
        `${label}:false`
      );
    }
  });

  it("P3. never offers Pause once there is nothing resumable to pause", () => {
    // Pausing an expired or exhausted session would promise a resume that
    // cannot happen, so it is not offered.
    for (const status of ["EXPIRED", "EXHAUSTED", "REVOKED", "PAUSED"]) {
      expect(`${status}:${isActionRelevant("PAUSE_NEW_TRADES", "ARMED", { status, resumable: false })}`).toBe(
        `${status}:false`
      );
    }
    // And not when there is no session at all.
    expect(isActionRelevant("PAUSE_NEW_TRADES", "ARMED", null)).toBe(false);
  });

  it("P4. Start stays offered while a session is paused", () => {
    // Starting a NEW session is a legitimate choice during a pause — the
    // server ends the paused one rather than running two — so the panel must
    // not hide it.
    expect(isActionRelevant("START", "SAFE_RECOVERY", { status: "PAUSED", resumable: true })).toBe(true);
  });

  it("P5. describes Pause as keeping the session and Stop as ending it", () => {
    // The distinction the whole feature exists for. An operator must be able
    // to tell these apart from the dialog alone.
    const pause = findAction("PAUSE_NEW_TRADES").description;
    expect(pause).toContain("KEEPS the session");
    expect(pause).toContain("nothing is cancelled");
    expect(findAction("STOP_NEW_TRADES").description).toContain("ENDS the session");

    // And Resume must promise no reset of any kind.
    const resume = findAction("RESUME_NEW_TRADES").description;
    expect(resume).toContain("SAME paused session");
    expect(resume).toContain("original expiry");
    expect(resume).toContain("Nothing is reset");
  });

  it("does not describe Stop or Safe Off as closing positions", () => {
    // The most dangerous possible misunderstanding on this panel: believing a
    // button flattened the account when it only blocked new entries.
    for (const id of ["STOP_NEW_TRADES", "SAFE_OFF", "PAUSE_NEW_TRADES"] as const) {
      const text = findAction(id).description.toLowerCase();
      for (const forbidden of ["closes your position", "flatten", "market close", "liquidat"]) {
        expect(`${id}:${forbidden}:${text.includes(forbidden)}`).toBe(`${id}:${forbidden}:false`);
      }
    }
  });

  it("says plainly that existing positions keep being managed", () => {
    expect(findAction("STOP_NEW_TRADES").description).toContain("Blocks new entries");
    expect(findAction("STOP_NEW_TRADES").description).toContain("continue to be managed");
    expect(findAction("SAFE_OFF").description).toContain("revokes unused authorization");
    expect(findAction("SAFE_OFF").description).toContain("remain managed");
  });

  it("says Start places no order", () => {
    expect(findAction("START").description).toContain("No order is placed");
  });
});

// ---------------------------------------------------------------------------
// When each action is offered
// ---------------------------------------------------------------------------

describe("operator actions: relevance follows the authoritative system state", () => {
  it.each([
    ["START", "SAFE_OFF", true],
    ["START", "ARMED", false],
    ["START", "SAFE_RECOVERY", true],
    ["STOP_NEW_TRADES", "ARMED", true],
    ["STOP_NEW_TRADES", "SAFE_OFF", false],
    ["STOP_NEW_TRADES", "SAFE_RECOVERY", false],
    ["SAFE_OFF", "ARMED", true],
    ["SAFE_OFF", "SAFE_RECOVERY", true],
    ["SAFE_OFF", "SAFE_OFF", false],
    ["SAFE_OFF", "INVALID", true],
  ] as const)("%s in %s -> %s", (id, state, expected) => {
    expect(isActionRelevant(id, state)).toBe(expected);
  });

  it("still offers Start while the panel shows blockers", () => {
    // The server is the authority on readiness, and its refusal carries far
    // better information than a greyed-out button does.
    expect(isActionRelevant("START", "SAFE_OFF")).toBe(true);
  });

  it("offers Safe Off wherever the profile may still be enabled", () => {
    // Including INVALID, which is exactly the state an operator most needs a
    // way out of.
    expect(isActionRelevant("SAFE_OFF", "INVALID")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The deployment prerequisite
// ---------------------------------------------------------------------------

describe("operator actions: the runtime activation prerequisite", () => {
  const safeGates = { globalKillSwitch: true, liveEntryEnabled: false, protectionReady: false };
  const liveGates = { globalKillSwitch: false, liveEntryEnabled: true, protectionReady: true };
  const passing = { status: "PASS" as const, reasonCode: null, message: null, backendCount: 1, workerCount: 1 };

  it("is NOT satisfied while the runtime is SAFE", () => {
    // The panel must never let an operator believe Start alone will bring the
    // runtime up live. These gates are process environment variables and no
    // part of this application writes them.
    const prerequisite = describeStartPrerequisite({ environmentGates: safeGates, runtimeAttestation: passing });
    expect(prerequisite.ready).toBe(false);
    expect(prerequisite.reason).toBe(START_PREREQUISITE_REASON);
  });

  it("explains the prerequisite without naming a file, path, command or secret", () => {
    const text = START_PREREQUISITE_REASON.toLowerCase();
    for (const forbidden of [".env", "export ", "pnpm", "npm ", "token", "password", "c:\\", "/api/"]) {
      expect(`${forbidden}:${text.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // And it says what to do, not merely that something is wrong.
    expect(START_PREREQUISITE_REASON).toContain("live-ready");
  });

  it("does not claim Start Trading changes the runtime gates", () => {
    const text = `${START_PREREQUISITE_REASON} ${findAction("START").description}`.toLowerCase();
    for (const forbidden of ["will enable", "turns on the runtime", "restarts", "start trading will make"]) {
      expect(`${forbidden}:${text.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("is satisfied once the runtime is live-ready", () => {
    const prerequisite = describeStartPrerequisite({ environmentGates: liveGates, runtimeAttestation: passing });
    expect(prerequisite).toEqual({ ready: true, reason: null, warning: null });
  });

  it.each([
    ["kill switch still engaged", { ...liveGates, globalKillSwitch: true }],
    ["live entry off", { ...liveGates, liveEntryEnabled: false }],
    ["protection not ready", { ...liveGates, protectionReady: false }],
  ])("refuses when %s", (_label, gates) => {
    expect(describeStartPrerequisite({ environmentGates: gates, runtimeAttestation: passing }).ready).toBe(false);
  });

  it("treats an unread status as NOT ready", () => {
    // Before the first poll the panel knows nothing, and unknown is never ready.
    expect(describeStartPrerequisite(null).ready).toBe(false);
  });

  it("surfaces blocked attestation as a warning, never as the disabler", () => {
    // The server is the authority on whether attestation blocks, and it can be
    // transiently unreadable. Showing it is useful; disabling on it is not.
    const prerequisite = describeStartPrerequisite({
      environmentGates: liveGates,
      runtimeAttestation: { status: "BLOCKED", reasonCode: "RUNTIME_ATTESTATION_STALE", message: null, backendCount: 0, workerCount: 1 },
    });
    expect(prerequisite.ready).toBe(true);
    expect(prerequisite.warning).toBe(START_ATTESTATION_WARNING);
  });

  it("keeps Stop New Trades and Safe Off reachable regardless", () => {
    // They only ever reduce risk. Gating them on a deployment prerequisite
    // would remove the operator's way out at the worst possible moment.
    const card = readFileSync(
      path.join(process.cwd(), "src/components/operator/TradingControlCard.tsx"),
      "utf8"
    );
    expect(card).toContain('action.id !== "START" || startPrerequisite.ready');
  });

  it("leaves the backend as the final authority", () => {
    // The frontend gate is UX. Nothing here relaxes a server-side check, and
    // the action still carries the phrase the server re-validates.
    expect(findAction("START").requiredPhrase).toBe(START_TRADING_CONFIRMATION);
    // State-based relevance is untouched: Start is still relevant on a SAFE
    // system, so the prerequisite is an ADDITIONAL condition, not a rewrite.
    expect(isActionRelevant("START", "SAFE_OFF")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

describe("operator actions: the START TRADING phrase", () => {
  const start = findAction("START");

  it("accepts only the exact phrase", () => {
    expect(isConfirmationSatisfied(start, "START TRADING")).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["lowercase", "start trading"],
    ["padded", " START TRADING "],
    ["truncated", "START TRADIN"],
    ["extra word", "START TRADING NOW"],
    ["underscored", "START_TRADING"],
  ])("refuses a %s phrase", (_label, typed) => {
    expect(isConfirmationSatisfied(start, typed)).toBe(false);
  });

  it("needs no phrase for Stop or Safe Off", () => {
    expect(isConfirmationSatisfied(findAction("STOP_NEW_TRADES"), "")).toBe(true);
    expect(isConfirmationSatisfied(findAction("SAFE_OFF"), "")).toBe(true);
  });
});

describe("operator actions: the Start dialog shows authoritative context", () => {
  it("reads every figure from the status the server sent", () => {
    const context = describeStartContext(statusFixture());
    expect(context).toEqual({
      environment: "MAINNET",
      allowedSymbols: "COWUSDT",
      allowedSymbolCount: 1,
      allowedSymbolsPreview: "COWUSDT",
      riskLimit: "0 / 7.5 USD",
      marginLimit: "0 / 40 USD",
      desiredOpen: 3,
      hardTotal: 5,
      maxClaims: START_MAX_CLAIMS,
      windowMinutes: START_WINDOW_MINUTES,
      // The PERSISTED eligibility policy. Enumerated exhaustively so a new
      // figure cannot appear in the arming dialog without being reviewed here.
      sourceTimeframes: "1W, 1M",
      sourceTimeframesValid: true,
      // The PERSISTED planning window, enumerated exhaustively so a new figure
      // cannot appear in the arming dialog without being reviewed here.
      rrLookback: "300 candles",
      rrLookbackValid: true,
    });
  });

  it("advertises the reviewed first-live window", () => {
    expect(`${START_WINDOW_MINUTES}/${START_MAX_CLAIMS}`).toBe("60/5");
  });

  it("never renders an unrestricted allowlist as nothing", () => {
    const context = describeStartContext(statusFixture({ allowedSymbols: [] }));
    expect(context.allowedSymbols).toBe("ALL (unrestricted)");
    expect(context.allowedSymbolCount).toBe(0);
    expect(context.allowedSymbolsPreview).toBe("ALL (unrestricted)");
  });

  it("summarizes a large allowlist as a count plus a preview", () => {
    const many = Array.from({ length: 428 }, (_, i) => `SYM${i}USDT`);
    const context = describeStartContext(statusFixture({ allowedSymbols: many }));
    expect(context.allowedSymbolCount).toBe(428);
    expect(context.allowedSymbolsPreview).toContain("+422 more");
  });
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

describe("operator actions: how a result reads", () => {
  it("never dresses a refusal as a success", () => {
    const presented = presentActionResult({
      ok: false,
      outcome: "BLOCKED",
      message: "Start refused.",
      blockers: ["ENVIRONMENT_GATES_NOT_ARMED: edit .env and restart first"],
    });
    expect(presented.tone).not.toBe("green");
    expect(presented.headline).toBe("BLOCKED");
    // The server's own words, not a rewrite.
    expect(presented.detail).toContain("ENVIRONMENT_GATES_NOT_ARMED: edit .env and restart first");
  });

  it("flags a prepared-but-not-armed window as the loudest condition", () => {
    // A window exists while the profile is safe. That is a state the operator
    // must act on, and it is not the same as a clean refusal.
    const presented = presentActionResult({
      ok: false,
      outcome: "WINDOW_PREPARED_NOT_ARMED",
      message: "A natural window was prepared but arming refused.",
      blockers: ["POLICY_VERSION_MOVED: the policy changed"],
    });
    expect(presented.tone).toBe("red");
  });

  it("does not paint ARMED green", () => {
    // Same rule as the system badge: green means safe, never trading.
    const presented = presentActionResult({ ok: true, outcome: "ARMED", message: "Armed.", blockers: [] });
    expect(presented.tone).toBe("yellow");
  });

  it("paints a return to safety green", () => {
    expect(presentActionResult({ ok: true, outcome: "SAFE_OFF", message: "Safe off.", blockers: [] }).tone).toBe(
      "green"
    );
  });
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

describe("operator actions: requests", () => {
  function stubFetch(status = 200, body: unknown = { ok: true, outcome: "ARMED", blockers: [] }) {
    const calls: Array<[string, RequestInit]> = [];
    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
    });
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  }

  it("posts the confirmation phrase in the body and the token in the header", async () => {
    const calls = stubFetch();
    await authenticateOperator(TOKEN, async () => ({ authenticated: true }));

    await postStartTrading(START_TRADING_CONFIRMATION);

    const [url, init] = calls[0];
    expect(url).toBe("/api/operator/trading-control/start");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ confirmation: "START TRADING" });
    // The credential travels in the header, never in the body a proxy logs.
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.body as string).not.toContain(TOKEN);
  });

  it("posts stop and safe-off with no credential in the payload", async () => {
    const calls = stubFetch();
    await authenticateOperator(TOKEN, async () => ({ authenticated: true }));

    await postStopNewTrades();
    await postSafeOff();

    expect(calls.map(([url]) => url)).toEqual([
      "/api/operator/trading-control/stop-new-trades",
      "/api/operator/trading-control/safe-off",
    ]);
    for (const [, init] of calls) {
      expect(init.body as string).not.toContain(TOKEN);
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("refuses to post the operator token to a non-operator path", async () => {
    await authenticateOperator(TOKEN, async () => ({ authenticated: true }));
    for (const path of ["/api/executions", "/api/alerts", "https://example.com/api/operator/start"]) {
      expect(() => operatorApiClient.post(path, {})).toThrow(/non-operator path/);
    }
  });

  it("never puts the phrase or the token in the URL", async () => {
    const calls = stubFetch();
    await authenticateOperator(TOKEN, async () => ({ authenticated: true }));
    await postStartTrading(START_TRADING_CONFIRMATION);
    const [url] = calls[0];
    expect(url).not.toContain("START");
    expect(url).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Session behaviour
// ---------------------------------------------------------------------------

describe("operator actions: failures and the operator session", () => {
  it("ends the session on 401 only", () => {
    expect(isSessionEnded(new ApiRequestError(401))).toBe(true);
    // A refused control action is a conflict with authoritative state. Logging
    // the operator out for it would be both wrong and infuriating.
    for (const status of [409, 422, 429, 500, 503]) {
      expect(`${status}:${isSessionEnded(new ApiRequestError(status))}`).toBe(`${status}:false`);
    }
  });

  it("keeps the token when an action is refused", async () => {
    await authenticateOperator(TOKEN, async () => ({ authenticated: true }));
    expect(hasOperatorToken()).toBe(true);
    // A 409 does not touch the credential.
    expect(isSessionEnded(new ApiRequestError(409))).toBe(false);
    expect(hasOperatorToken()).toBe(true);
  });

  it("never persists the token while acting", async () => {
    const store = new Map<string, string>();
    const fake = {
      setItem: vi.fn((k: string, v: string) => void store.set(k, v)),
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    };
    vi.stubGlobal("localStorage", fake);
    vi.stubGlobal("sessionStorage", fake);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) }));

    await authenticateOperator(TOKEN, async () => ({ authenticated: true }));
    await postStartTrading(START_TRADING_CONFIRMATION);

    expect(fake.setItem).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Structural
// ---------------------------------------------------------------------------

describe("operator actions: structural guarantees", () => {
  const src = (relative: string) => readFileSync(path.join(process.cwd(), "src", relative), "utf8");

  it("blocks a duplicate submission while one action is in flight", () => {
    const hook = src("hooks/useTradingControl.ts");
    expect(hook).toContain("if (pendingAction !== null) return;");

    // The BUTTON ROW specifically, not merely the file: the confirmation dialog
    // also reads this flag, so a whole-file match would keep passing after the
    // buttons stopped honouring it.
    const card = src("components/operator/TradingControlCard.tsx");
    const buttonRow = card.slice(
      card.indexOf("TRADING_CONTROL_ACTIONS.map("),
      card.indexOf("})}", card.indexOf("TRADING_CONTROL_ACTIONS.map("))
    );
    expect(buttonRow.length).toBeGreaterThan(0);
    expect(buttonRow).toContain("pendingAction !== null");
  });

  it("refreshes status after every action", () => {
    const hook = src("hooks/useTradingControl.ts");
    const runAction = hook.slice(hook.indexOf("const runAction"));
    expect(runAction).toContain("await refresh()");
  });

  it("does not resume automatic readiness polling", () => {
    // Readiness stays a question the operator asks. The timer body must still
    // call refresh and nothing else.
    const hook = src("hooks/useTradingControl.ts");
    const timer = hook.slice(hook.indexOf("setInterval("), hook.indexOf("}, pollMs)"));
    expect(timer).toContain("void refresh()");
    expect(timer).not.toContain("checkReadiness");
    expect(timer).not.toContain("fetchTradingControlReadiness");
    expect(timer).not.toContain("runAction");
  });

  it("drops the stale readiness snapshot after an action", () => {
    // The verdict was computed before the state changed. A stale READY beside a
    // freshly armed profile is worse than showing nothing.
    const hook = src("hooks/useTradingControl.ts");
    const runAction = hook.slice(hook.indexOf("const runAction"), hook.indexOf("const dismissActionResult"));
    expect(runAction).toContain("setReadiness(null)");
  });

  it("keeps the credential out of every action payload", () => {
    const api = src("api/operator.ts");
    for (const forbidden of ["token:", "operatorToken", "Authorization:"]) {
      expect(`${forbidden}:${api.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

// ---------------------------------------------------------------------------
// The operator-managed allowlist and the supervised duration selector
// ---------------------------------------------------------------------------

describe("operator actions: the allowlist editor", () => {
  const status = (overrides: Record<string, unknown> = {}) =>
    ({
      systemState: "SAFE_OFF",
      capacity: { pending: 0, open: 0, totalActive: 0, desiredOpen: 3, hardTotal: 5 },
      manualIntervention: { present: false, count: 0 },
      ...overrides,
    }) as never;

  it("renders an empty allowlist as UNRESTRICTED, never as nothing", () => {
    // Empty means ALL to the admission engine; showing "none" would invert it.
    expect(describeAllowlist([])).toBe("ALL (unrestricted)");
  });

  it("shows a short list in full", () => {
    expect(describeAllowlist(["FHEUSDT", "BTCUSDT"])).toBe("FHEUSDT, BTCUSDT");
  });

  it("previews a long list concisely instead of hundreds of badges", () => {
    const many = Array.from({ length: 428 }, (_, i) => `SYM${i}USDT`);
    const rendered = describeAllowlist(many);
    expect(rendered).toContain("+422 more");
    expect(rendered.length).toBeLessThan(120);
  });

  it("offers editing only while SAFE OFF and quiet", () => {
    expect(canEditAllowlist(status()).allowed).toBe(true);
    expect(canEditAllowlist(null).allowed).toBe(false);
    expect(canEditAllowlist(status({ systemState: "ARMED" })).allowed).toBe(false);
    expect(canEditAllowlist(status({ systemState: "SAFE_RECOVERY" })).allowed).toBe(false);
    expect(
      canEditAllowlist(status({ capacity: { pending: 1, open: 0, totalActive: 1, desiredOpen: 3, hardTotal: 5 } }))
        .allowed
    ).toBe(false);
    expect(canEditAllowlist(status({ manualIntervention: { present: true, count: 1 } })).allowed).toBe(false);
  });

  it("explains why editing is unavailable rather than silently disabling", () => {
    expect(canEditAllowlist(status({ systemState: "ARMED" })).reason).toContain("SAFE OFF");
    expect(
      canEditAllowlist(status({ manualIntervention: { present: true, count: 2 } })).reason
    ).toContain("Manual intervention");
  });

  it("lists the counts in the order the operator reads them", () => {
    const lines = describeAllowlistCounts({
      input: 572,
      normalized: 560,
      valid: 430,
      duplicates: 12,
      rejected: 130,
    });
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("572");
    expect(lines[2]).toContain("430");
    expect(lines.join("\n")).not.toContain("USDT");
  });

  it("groups rejections by reason so a large paste stays readable", () => {
    const rejected = [
      { reasonCode: "INVALID_SYNTAX" },
      { reasonCode: "NOT_FUTURES_ELIGIBLE" },
      { reasonCode: "NOT_FUTURES_ELIGIBLE" },
      { reasonCode: "UNSUPPORTED_CONTRACT" },
    ];
    expect(groupRejections(rejected)).toEqual([
      { reasonCode: "NOT_FUTURES_ELIGIBLE", count: 2 },
      { reasonCode: "INVALID_SYNTAX", count: 1 },
      { reasonCode: "UNSUPPORTED_CONTRACT", count: 1 },
    ]);
  });
});

describe("operator actions: the supervised duration selector", () => {
  it("offers exactly the reviewed choices with 60 as the default", () => {
    // Session lengths since Phase 2, and not exhaustive: a CUSTOM duration is
    // accepted beside them, bounded by the 30-day ceiling rather than by an
    // enumeration. Presets and custom values share one validator on the
    // server, so a preset is a convenience and never a second code path.
    expect([...START_TRADING_DURATION_CHOICES]).toEqual([60, 360, 720, 1440, 4320, 10080, 43200]);
    // The DEFAULT is deliberately still one hour. Widening what an operator
    // may ask for must not widen what an unchanged caller receives.
    expect(START_WINDOW_MINUTES).toBe(60);
    expect(START_TRADING_DURATION_CHOICES).toContain(START_WINDOW_MINUTES);
  });

  it("never offers more than the reviewed maximum", () => {
    expect(Math.max(...START_TRADING_DURATION_CHOICES)).toBe(30 * 24 * 60);
  });

  it("keeps maxClaims server-controlled at 5", () => {
    expect(START_MAX_CLAIMS).toBe(5);
  });
});
