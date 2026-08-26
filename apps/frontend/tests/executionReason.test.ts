import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  REFUSAL_STATUSES,
  describeExecutionReason,
  humanizeReasonCode,
  type ExecutionReasonContext,
} from "../src/features/executions/executionReason";

/**
 * Why an execution did not become an entry.
 *
 * The Executions table used to show `SKIPPED` and stop there. The reason code
 * was already on every row of the list payload and simply was not rendered, so
 * answering "why?" meant opening the execution detail or reading the journal.
 *
 * The sentences come from ONE shared vocabulary, also used by the Trading
 * Control card. Two dictionaries would drift, and the same refusal reading two
 * different ways on two screens is worse than terse text on both.
 */

const BACKEND = path.resolve(__dirname, "..");

function ctx(overrides: Partial<ExecutionReasonContext> = {}): ExecutionReasonContext {
  return {
    status: "SKIPPED",
    reasonCode: "SYMBOL_NOT_ALLOWED",
    symbol: "MTLUSDT",
    direction: "SHORT",
    sourceTimeframe: "1D",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A-E. The refusals an operator actually meets
// ---------------------------------------------------------------------------

describe("the reasons a SKIPPED execution can carry", () => {
  it("A. symbol not in the allowlist — and it names the symbol", () => {
    expect(describeExecutionReason(ctx())).toBe("MTLUSDT is not in the symbol allowlist");
  });

  it("B. source timeframe — and it names the timeframe", () => {
    // Naming the rule without its subject leaves the operator to go and look up
    // which timeframe it objected to.
    expect(describeExecutionReason(ctx({ reasonCode: "SOURCE_TIMEFRAME_NOT_ALLOWED" }))).toBe(
      "Source timeframe 1D is not allowed"
    );
    expect(
      describeExecutionReason(ctx({ reasonCode: "SOURCE_TIMEFRAME_NOT_ALLOWED", sourceTimeframe: null }))
    ).toBe("The signal’s source timeframe is not allowed");
  });

  it("C. stale alert — neutral without policy context, precise with it", () => {
    // The executions list carries no alert-age policy, so it must not invent
    // one; the Trading Control card does, and says the exact duration.
    expect(describeExecutionReason(ctx({ reasonCode: "ALERT_STALE" }))).toBe(
      "Alert was too old when it was evaluated"
    );
    expect(describeExecutionReason(ctx({ reasonCode: "ALERT_STALE", alertAgeLimitSeconds: 300 }))).toBe(
      "Alert is older than the execution limit of 5 min"
    );
  });

  it("D. authorization window — every state has its own sentence", () => {
    const cases: [string, RegExp][] = [
      ["NATURAL_AUTHORIZATION_REQUIRED", /Nothing currently authorizes/i],
      ["NATURAL_AUTHORIZATION_EXPIRED", /had expired/i],
      ["NATURAL_AUTHORIZATION_REVOKED", /had been revoked/i],
      ["NATURAL_AUTHORIZATION_EXHAUSTED", /no claims left/i],
      ["NATURAL_AUTHORIZATION_DIRECTION_NOT_ALLOWED", /does not admit SHORT/i],
    ];
    for (const [code, matcher] of cases) {
      expect(describeExecutionReason(ctx({ reasonCode: code })), code).toMatch(matcher);
    }
  });

  it("E. capacity — each limit reads as itself, not as one generic 'full'", () => {
    const cases: [string, RegExp][] = [
      ["OPEN_POSITION_LIMIT_REACHED", /open-position limit/i],
      ["SOFT_OPEN_TARGET_REACHED", /desired number of open positions/i],
      ["PENDING_ENTRY_LIMIT_REACHED", /pending-entry limit/i],
      ["TOTAL_ACTIVE_LIMIT_REACHED", /total active-trade limit/i],
      ["TOTAL_RISK_LIMIT_REACHED", /planned-risk limit/i],
      ["TOTAL_MARGIN_LIMIT_REACHED", /total margin limit/i],
      ["SYMBOL_SIDE_ALREADY_ACTIVE", /MTLUSDT SHORT execution is already active/i],
      ["SYMBOL_HAS_OPEN_POSITION_OR_ORDER", /already exists for MTLUSDT/i],
      ["INSUFFICIENT_AVAILABLE_BALANCE", /Available balance/i],
    ];
    for (const [code, matcher] of cases) {
      expect(describeExecutionReason(ctx({ reasonCode: code })), code).toMatch(matcher);
    }
  });

  it("covers the eligibility and gate codes this build can emit", () => {
    const cases: [string, RegExp][] = [
      ["USDT_ONLY_CONTRACT_REQUIRED", /USDT-only execution/i],
      ["UNSUPPORTED_SYMBOL", /not supported for Binance/i],
      ["SYMBOL_NOT_TRADING", /not currently trading/i],
      ["UNSUPPORTED_CONTRACT", /contract type is not supported/i],
      ["SOURCE_TIMEFRAME_UNAVAILABLE", /did not carry a recognised source timeframe/i],
      ["SIGNAL_TIME_UNAVAILABLE", /no trustworthy trigger time/i],
      ["DUPLICATE_EXECUTION", /already been executed/i],
      ["GLOBAL_KILL_SWITCH_ACTIVE", /global kill switch/i],
      ["PROFILE_KILL_SWITCH_ACTIVE", /SAFE state/i],
      ["PROFILE_DISABLED", /profile was disabled/i],
      ["RECOVERY_REQUIRED", /requires recovery/i],
      ["MARGIN_PLAN_NOT_READY", /margin and leverage plan/i],
      ["UNSAFE_LIQUIDATION_BUFFER", /liquidation buffer/i],
      ["ENTRY_SUBMISSION_REJECTED", /Binance rejected the entry order/i],
      ["ENTRY_TTL_EXPIRED", /expired before it filled/i],
      ["BINANCE_SYMBOL_STATE_UNAVAILABLE", /symbol data could not be read/i],
    ];
    for (const [code, matcher] of cases) {
      expect(describeExecutionReason(ctx({ reasonCode: code })), code).toMatch(matcher);
    }
  });
});

// ---------------------------------------------------------------------------
// F/G. Degrading safely
// ---------------------------------------------------------------------------

describe("F. an unknown code degrades instead of breaking", () => {
  it("humanizes a code this build has never seen", () => {
    // New codes ship with the backend, not with this file.
    expect(describeExecutionReason(ctx({ reasonCode: "SOME_FUTURE_POLICY_CODE" }))).toBe(
      "Some future policy code"
    );
  });

  it("never returns an empty string for any code shape", () => {
    for (const code of ["X", "_", "a_b", "SOME_FUTURE_POLICY_CODE", "lower_case_code"]) {
      expect(describeExecutionReason(ctx({ reasonCode: code })), code).toBeTruthy();
    }
    // A MULTI-token code is never echoed back as if it were prose. A
    // single-character code humanizes to itself, which is correct rather than a
    // gap — there is nothing to reword — and cannot come from this backend.
    for (const code of ["SOME_FUTURE_POLICY_CODE", "lower_case_code", "a_b"]) {
      expect(describeExecutionReason(ctx({ reasonCode: code })), code).not.toBe(code);
    }
    expect(humanizeReasonCode("   ")).toBe("Refused for an unspecified reason");
  });
});

describe("G. no reason is invented where none applies", () => {
  it("returns null when there is no reason code at all", () => {
    expect(describeExecutionReason(ctx({ reasonCode: null }))).toBeNull();
    expect(describeExecutionReason(ctx({ reasonCode: "" }))).toBeNull();
  });

  it("returns null for a healthy execution that is simply progressing", () => {
    // ENTRY_PENDING sits on ENTRY_RECONCILED, which means the order is resting
    // exactly as intended. Showing that under "Reason" would report a problem
    // for a trade that is working.
    for (const status of ["ENTRY_PENDING", "ENTRY_FILLED", "PROTECTED", "PLAN_READY", "PREFLIGHT", "CLOSED_TP"]) {
      expect(describeExecutionReason(ctx({ status, reasonCode: "ENTRY_RECONCILED" })), status).toBeNull();
    }
  });

  it("does show a reason for the terminal states an operator must act on", () => {
    for (const status of [...REFUSAL_STATUSES]) {
      expect(describeExecutionReason(ctx({ status })), status).toBeTruthy();
    }
    expect([...REFUSAL_STATUSES].sort()).toEqual(
      ["ENTRY_EXPIRED", "FAILED", "MANUAL_INTERVENTION", "SKIPPED"]
    );
  });

  it("stays truthful when the symbol is unknown", () => {
    // Never renders "null is not in the symbol allowlist".
    const reason = describeExecutionReason(ctx({ symbol: null }));
    expect(reason).toBe("This symbol is not in the symbol allowlist");
    expect(reason).not.toContain("null");
  });
});

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

describe("the Executions table renders it without lying", () => {
  const page = readFileSync(path.join(BACKEND, "src/pages/ExecutionsPage.tsx"), "utf8");

  it("has a Reason column beside Status", () => {
    expect(page).toContain('<th scope="col" className="px-3 py-2">Reason</th>');
    expect(page.indexOf("Status</th>")).toBeLessThan(page.indexOf("Reason</th>"));
    expect(page.indexOf("Reason</th>")).toBeLessThan(page.indexOf("Protection</th>"));
  });

  it("feeds the cell ONLY from the persisted reason code", () => {
    // Never inferred from status, symbol or timestamps in the frontend.
    expect(page).toContain("reasonCode={item.decisionReasonCode}");
    expect(page).toContain("describeExecutionReason({ status, reasonCode, symbol, direction })");
  });

  it("shows an em dash rather than a misleading reason", () => {
    expect(page).toContain('if (!reason) return <span className="text-slate-600">—</span>;');
  });

  it("keeps the raw code inspectable and the table compact", () => {
    expect(page).toContain("title={reasonCode ?");
    expect(page).toContain("truncate");
    expect(page).toContain("max-w-[22rem]");
  });

  it("passes no alert-age limit, so no config value is duplicated here", () => {
    // The list endpoint has no policy context; hardcoding 300 in the frontend
    // would put a second copy of a configurable value in front of the operator.
    // Asserted on the identifiers, not on the digits: a bare `300` also matches
    // Tailwind classes like `text-slate-300`, which say nothing about policy.
    expect(page).not.toMatch(/alertAgeLimitSeconds/);
    expect(page).not.toMatch(/formatAlertAgeLimit/);
  });
});

describe("H. the shared vocabulary is genuinely shared", () => {
  it("Trading Control delegates rather than keeping its own dictionary", () => {
    const tc = readFileSync(path.join(BACKEND, "src/features/operator/tradingControlPresentation.ts"), "utf8");
    expect(tc).toContain("describeExecutionReason({");
    // The switch moved out; only the adapter remains.
    expect(tc).not.toContain('case "SOURCE_TIMEFRAME_NOT_ALLOWED":');
    expect(tc).not.toContain('case "ALERT_STALE":');
  });

  it("there is exactly one reason dictionary in the frontend", () => {
    const shared = readFileSync(path.join(BACKEND, "src/features/executions/executionReason.ts"), "utf8");
    expect(shared).toContain('case "SOURCE_TIMEFRAME_NOT_ALLOWED":');
    expect(shared).toContain('case "USDT_ONLY_CONTRACT_REQUIRED":');
  });
});
