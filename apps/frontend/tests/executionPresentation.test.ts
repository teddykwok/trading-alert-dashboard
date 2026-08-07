import { describe, expect, it } from "vitest";
import {
  ALERT_DELIVERY_STATUSES,
  EXECUTION_STATUSES,
  MARGIN_ADJUSTMENT_STATUSES,
  ORDER_STATUSES,
  PROTECTION_STATES,
  SAFETY_DECISIONS,
  presentAlertDelivery,
  presentExecutionStatus,
  presentExitReason,
  presentMarginAdjustment,
  presentOrderStatus,
  presentProtectionState,
  presentSafetyDecision,
} from "../src/features/executions/executionPresentation";
import {
  UNKNOWN_DISPLAY,
  decimalDifference,
  displayAggregatePnl,
  displayDecimal,
  displayInteger,
  displayNetPnl,
  displayTimestamp,
  isNegative,
  shortenId,
} from "../src/features/executions/executionFormat";
import { buildExecutionListQuery } from "../src/api/executions.api";

/**
 * Phase 8 frontend presentation tests. Pure logic only — no network, no DOM.
 */

// The backend enums, mirrored here so a backend addition that the frontend
// never learned about fails loudly instead of rendering as a neutral blank.
const BACKEND_EXECUTION_STATUSES = [
  "PLAN_READY", "PREFLIGHT", "ENTRY_SUBMITTING", "ENTRY_PENDING", "PARTIALLY_FILLED",
  "ENTRY_FILLED", "PLACING_PROTECTION", "PROTECTED", "ENTRY_EXPIRED", "CLOSED_TP",
  "CLOSED_SL", "CANCELED", "SKIPPED", "FAILED", "MANUAL_INTERVENTION", "CLOSED_EMERGENCY",
];
const BACKEND_PROTECTION_STATES = [
  "UNPROTECTED", "MARGIN_CHECK", "MARGIN_ADJUSTING", "PLACING_STOP", "STOP_VERIFIED",
  "PLACING_TAKE_PROFIT", "PROTECTED", "PROTECTION_INCOMPLETE", "EMERGENCY_CLOSING",
  "CLOSURE_CLEANUP", "CLOSED", "MANUAL_INTERVENTION",
];
const BACKEND_ORDER_STATUSES = [
  "PLANNED", "SUBMITTING", "NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "EXPIRED",
  "REJECTED", "UNKNOWN",
];

describe("status mapping completeness", () => {
  it("maps every backend execution status", () => {
    expect([...EXECUTION_STATUSES].sort()).toEqual([...BACKEND_EXECUTION_STATUSES].sort());
    for (const status of BACKEND_EXECUTION_STATUSES) {
      const presentation = presentExecutionStatus(status);
      expect(presentation.unknown, status).toBe(false);
      expect(presentation.label.length, status).toBeGreaterThan(0);
    }
  });

  it("maps every backend protection state", () => {
    expect([...PROTECTION_STATES].sort()).toEqual([...BACKEND_PROTECTION_STATES].sort());
    for (const state of BACKEND_PROTECTION_STATES) {
      expect(presentProtectionState(state)?.unknown, state).toBe(false);
    }
  });

  it("maps every backend order status", () => {
    expect([...ORDER_STATUSES].sort()).toEqual([...BACKEND_ORDER_STATUSES].sort());
    for (const status of BACKEND_ORDER_STATUSES) {
      expect(presentOrderStatus(status).unknown, status).toBe(false);
    }
  });

  it("maps every safety decision, delivery status and margin status", () => {
    for (const decision of SAFETY_DECISIONS) expect(presentSafetyDecision(decision).unknown).toBe(false);
    for (const status of ALERT_DELIVERY_STATUSES) expect(presentAlertDelivery(status).unknown).toBe(false);
    for (const status of MARGIN_ADJUSTMENT_STATUSES) expect(presentMarginAdjustment(status).unknown).toBe(false);
  });

  it("marks the states that need a human as critical", () => {
    expect(presentExecutionStatus("MANUAL_INTERVENTION").critical).toBe(true);
    expect(presentExecutionStatus("CLOSED_EMERGENCY").critical).toBe(true);
    expect(presentProtectionState("PROTECTION_INCOMPLETE")?.critical).toBe(true);
    expect(presentProtectionState("CLOSURE_CLEANUP")?.critical).toBe(true);
    expect(presentProtectionState("UNPROTECTED")?.critical).toBe(true);
    expect(presentAlertDelivery("FAILED").critical).toBe(true);
  });

  it("never styles an unknown future status as a success", () => {
    for (const present of [presentExecutionStatus, presentOrderStatus, presentSafetyDecision, presentAlertDelivery]) {
      const result = present("SOME_FUTURE_STATUS");
      expect(result.unknown).toBe(true);
      expect(result.tone).not.toBe("green");
      // The raw value stays visible rather than being swallowed.
      expect(result.label).toBe("SOME_FUTURE_STATUS");
    }
    const protection = presentProtectionState("SOME_FUTURE_STATE");
    expect(protection?.unknown).toBe(true);
    expect(protection?.tone).not.toBe("green");
  });

  it("returns null protection presentation only for a null state", () => {
    expect(presentProtectionState(null)).toBeNull();
    expect(presentProtectionState("PROTECTED")).not.toBeNull();
  });
});

describe("exit reason semantics", () => {
  it("prefers the persisted exit reason", () => {
    expect(presentExitReason("Manual close", "CLOSED_TP")).toBe("Manual close");
  });

  it("falls back only for unambiguous closed statuses", () => {
    expect(presentExitReason(null, "CLOSED_TP")).toBe("Take profit");
    expect(presentExitReason(null, "CLOSED_SL")).toBe("Stop loss");
    expect(presentExitReason(null, "CLOSED_EMERGENCY")).toBe("Emergency close");
  });

  it("invents no exit reason for a lifecycle outcome", () => {
    for (const status of ["FAILED", "SKIPPED", "CANCELED", "ENTRY_EXPIRED", "MANUAL_INTERVENTION", "PROTECTED"]) {
      expect(presentExitReason(null, status), status).toBeNull();
    }
  });
});

describe("null versus zero", () => {
  it("renders null as the unknown marker and zero as zero", () => {
    expect(displayDecimal(null).text).toBe(UNKNOWN_DISPLAY);
    expect(displayDecimal(null).known).toBe(false);
    expect(displayDecimal("0").text).toBe("0");
    expect(displayDecimal("0").known).toBe(true);
    expect(displayDecimal("0.00").text).toBe("0.00");
  });

  it("treats an integer zero as known", () => {
    expect(displayInteger(0)).toEqual({ text: "0", exact: "0", known: true });
    expect(displayInteger(null).known).toBe(false);
  });

  it("renders a null timestamp as unknown", () => {
    expect(displayTimestamp(null).known).toBe(false);
    expect(displayTimestamp("2026-01-01T12:00:00.000Z").known).toBe(true);
  });
});

describe("exact decimal display", () => {
  it("keeps a short value verbatim", () => {
    expect(displayDecimal("99.98").text).toBe("99.98");
  });

  it("truncates rather than rounds, and keeps the exact value available", () => {
    const result = displayDecimal("1.123456789012345", 8);
    expect(result.text).toBe("1.12345678…");
    // Truncated, not rounded to ...79: rounding would imply a value the
    // exchange never reported.
    expect(result.text).not.toContain("12345679");
    expect(result.exact).toBe("1.123456789012345");
  });

  it("detects a negative value for styling without altering it", () => {
    expect(isNegative("-1.5")).toBe(true);
    expect(isNegative("0")).toBe(false);
    expect(isNegative(null)).toBe(false);
  });
});

describe("differences", () => {
  it("computes a difference when both sides are known", () => {
    expect(decimalDifference("100", "99.98")).toBe("-0.02");
  });

  it("returns null when either side is unknown", () => {
    expect(decimalDifference("100", null)).toBeNull();
    expect(decimalDifference(null, "99.98")).toBeNull();
    expect(decimalDifference(null, null)).toBeNull();
  });

  it("returns an exact zero for identical values", () => {
    expect(decimalDifference("100", "100")).toBe("0");
  });
});

describe("net PnL", () => {
  const base = { realizedPnl: "10", tradingFeesUsd: "0.5", fundingPnlUsd: "-0.2", netPnlUsd: "9.3" };

  it("shows the net result when every component is known", () => {
    const result = displayNetPnl(base);
    expect(result.known).toBe(true);
    expect(result.text).toBe("9.3");
    expect(result.missingComponents).toEqual([]);
  });

  it("shows nothing when fees are unknown", () => {
    const result = displayNetPnl({ ...base, tradingFeesUsd: null, netPnlUsd: null });
    expect(result.known).toBe(false);
    expect(result.text).toBe(UNKNOWN_DISPLAY);
    expect(result.missingComponents).toContain("trading fees");
  });

  it("shows nothing when funding is unknown", () => {
    const result = displayNetPnl({ ...base, fundingPnlUsd: null, netPnlUsd: null });
    expect(result.missingComponents).toContain("funding PnL");
    expect(result.text).toBe(UNKNOWN_DISPLAY);
  });

  it("never assembles a partial net result client-side", () => {
    // Even if a (wrong) backend sent a net value with a missing component.
    const result = displayNetPnl({ ...base, tradingFeesUsd: null, netPnlUsd: "9.3" });
    expect(result.known).toBe(false);
  });

  it("treats a zero fee as known, not missing", () => {
    const result = displayNetPnl({ realizedPnl: "10", tradingFeesUsd: "0", fundingPnlUsd: "0", netPnlUsd: "10" });
    expect(result.known).toBe(true);
    expect(result.missingComponents).toEqual([]);
  });
});

describe("aggregate realized PnL", () => {
  it("labels a complete sum without a caveat", () => {
    const result = displayAggregatePnl({ knownRealizedPnl: "12.5", closedWithKnownPnl: 3, closedWithUnknownPnl: 0 });
    expect(result.text).toBe("12.5");
    expect(result.complete).toBe(true);
    expect(result.caveat).toBeNull();
  });

  it("states how many closed executions are unknown", () => {
    const result = displayAggregatePnl({ knownRealizedPnl: "12.5", closedWithKnownPnl: 3, closedWithUnknownPnl: 2 });
    expect(result.complete).toBe(false);
    expect(result.caveat).toContain("2");
    expect(result.caveat).toMatch(/partial/i);
  });

  it("shows unknown rather than 0 when nothing is known", () => {
    const result = displayAggregatePnl({ knownRealizedPnl: "0", closedWithKnownPnl: 0, closedWithUnknownPnl: 4 });
    expect(result.text).toBe(UNKNOWN_DISPLAY);
    expect(result.complete).toBe(false);
  });
});

describe("id shortening", () => {
  it("keeps a short id intact", () => {
    expect(shortenId("tad-en-1-abc").text).toBe("tad-en-1-abc");
  });

  it("shortens a long id but keeps the exact value", () => {
    const result = shortenId("tad-en-1-0123456789abcdef0123");
    expect(result.text).toContain("…");
    expect(result.exact).toBe("tad-en-1-0123456789abcdef0123");
  });

  it("renders a null id as unknown", () => {
    expect(shortenId(null).known).toBe(false);
  });
});

describe("list query building", () => {
  it("omits empty filters", () => {
    expect(buildExecutionListQuery({})).toBe("");
    expect(buildExecutionListQuery({ symbol: "" })).toBe("");
  });

  it("serializes scalars and repeats arrays", () => {
    const query = buildExecutionListQuery({ symbol: "BTCUSDT", status: ["PROTECTED", "CLOSED_TP"], page: 2 });
    expect(query).toContain("symbol=BTCUSDT");
    expect(query.match(/status=/g)).toHaveLength(2);
    expect(query).toContain("page=2");
  });

  it("serializes the manual-intervention and lifecycle filters", () => {
    const query = buildExecutionListQuery({ requiresManualIntervention: true, lifecycle: "closed" });
    expect(query).toContain("requiresManualIntervention=true");
    expect(query).toContain("lifecycle=closed");
  });
});
