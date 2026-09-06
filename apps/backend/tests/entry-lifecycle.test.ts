import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BINANCE_ORDER_STATUSES,
  ENTRY_REASON_CODES,
  classifyMutationOutcome,
  decideReconciliation,
  entryDeadlineFrom,
  entryOrderSide,
  entryPositionSide,
  findOrderIdentityMismatches,
  isEntryTtlDue,
  mapExchangeToLocalOrderStatus,
  mapOrderToExecutionStatus,
  mergeFillProgress,
  normalizeExchangeOrderStatus,
  shouldCancelRemainder,
  type ExpectedOrderIdentity,
  type ObservedOrderIdentity,
} from "../src/modules/execution/entry-lifecycle";

/**
 * Phase 6 pure lifecycle tests. Everything is synthetic — no live symbols,
 * balances, positions or order ids.
 */

const SYNTHETIC_CLIENT_ID = "tad-en-1-0123456789ab";

function expected(overrides: Partial<ExpectedOrderIdentity> = {}): ExpectedOrderIdentity {
  return {
    symbol: "SYNTHUSDT",
    side: "BUY",
    positionSide: "LONG",
    orderType: "LIMIT",
    price: "100",
    originalQuantity: "0.375",
    clientOrderId: SYNTHETIC_CLIENT_ID,
    ...overrides,
  };
}

function observed(overrides: Partial<ObservedOrderIdentity> = {}): ObservedOrderIdentity {
  return {
    symbol: "SYNTHUSDT",
    side: "BUY",
    positionSide: "LONG",
    orderType: "LIMIT",
    price: "100.0",
    originalQuantity: "0.375000",
    clientOrderId: SYNTHETIC_CLIENT_ID,
    ...overrides,
  };
}

describe("side and position-side mapping", () => {
  it("maps LONG to BUY + LONG", () => {
    expect(entryOrderSide("LONG")).toBe("BUY");
    expect(entryPositionSide("LONG")).toBe("LONG");
  });

  it("maps SHORT to SELL + SHORT", () => {
    expect(entryOrderSide("SHORT")).toBe("SELL");
    expect(entryPositionSide("SHORT")).toBe("SHORT");
  });

  it("never produces BOTH (hedge mode only)", () => {
    expect(entryPositionSide("LONG")).not.toBe("BOTH");
    expect(entryPositionSide("SHORT")).not.toBe("BOTH");
  });
});

describe("exchange status normalization", () => {
  it("accepts every documented status", () => {
    for (const status of BINANCE_ORDER_STATUSES) {
      expect(normalizeExchangeOrderStatus(status)).toBe(status);
    }
  });

  it("is case and whitespace tolerant", () => {
    expect(normalizeExchangeOrderStatus(" filled ")).toBe("FILLED");
  });

  it("refuses to guess an unrecognised token", () => {
    expect(normalizeExchangeOrderStatus("SOMETHING_NEW")).toBeNull();
    expect(normalizeExchangeOrderStatus(null)).toBeNull();
    expect(normalizeExchangeOrderStatus(42)).toBeNull();
  });

  it("folds EXPIRED_IN_MATCH onto the local EXPIRED status", () => {
    expect(mapExchangeToLocalOrderStatus("EXPIRED_IN_MATCH")).toBe("EXPIRED");
    expect(mapExchangeToLocalOrderStatus("EXPIRED")).toBe("EXPIRED");
  });

  it("maps an unknown status to UNKNOWN rather than a lifecycle guess", () => {
    expect(mapExchangeToLocalOrderStatus(null)).toBe("UNKNOWN");
  });
});

describe("order status to execution status", () => {
  const map = (localOrderStatus: Parameters<typeof mapOrderToExecutionStatus>[0]["localOrderStatus"], qty = "0", cancelCause?: "TTL" | "OPERATOR" | "UNKNOWN") =>
    mapOrderToExecutionStatus({ localOrderStatus, executedQuantity: qty, cancelCause });

  it("maps NEW to ENTRY_PENDING", () => {
    expect(map("NEW").executionStatus).toBe("ENTRY_PENDING");
  });

  it("maps PARTIALLY_FILLED to PARTIALLY_FILLED and flags exposure", () => {
    const result = map("PARTIALLY_FILLED", "0.100");
    expect(result.executionStatus).toBe("PARTIALLY_FILLED");
    expect(result.exposurePossible).toBe(true);
  });

  it("maps FILLED to ENTRY_FILLED", () => {
    const result = map("FILLED", "0.375");
    expect(result.executionStatus).toBe("ENTRY_FILLED");
    expect(result.requiresManualIntervention).toBe(false);
  });

  it("maps a TTL cancel with no fill to ENTRY_EXPIRED", () => {
    const result = map("CANCELED", "0", "TTL");
    expect(result.executionStatus).toBe("ENTRY_EXPIRED");
    expect(result.exposurePossible).toBe(false);
  });

  it("maps a confirmed operator cancel with no fill to CANCELED", () => {
    expect(map("CANCELED", "0", "OPERATOR").executionStatus).toBe("CANCELED");
  });

  it("maps EXPIRED with no fill to ENTRY_EXPIRED", () => {
    expect(map("EXPIRED", "0").executionStatus).toBe("ENTRY_EXPIRED");
  });

  it("maps REJECTED with no fill to FAILED", () => {
    const result = map("REJECTED", "0");
    expect(result.executionStatus).toBe("FAILED");
    expect(result.exposurePossible).toBe(false);
  });

  it("maps UNKNOWN to MANUAL_INTERVENTION because exposure cannot be ruled out", () => {
    const result = map("UNKNOWN", "0");
    expect(result.executionStatus).toBe("MANUAL_INTERVENTION");
    expect(result.exposurePossible).toBe(true);
  });
});

describe("partial fill safety rule", () => {
  it("never marks a cancelled partial fill as ENTRY_EXPIRED", () => {
    const result = mapOrderToExecutionStatus({
      localOrderStatus: "CANCELED",
      executedQuantity: "0.100",
      cancelCause: "TTL",
    });
    expect(result.executionStatus).not.toBe("ENTRY_EXPIRED");
    expect(result.executionStatus).toBe("MANUAL_INTERVENTION");
    expect(result.reasonCode).toBe("UNPROTECTED_PARTIAL_FILL");
    expect(result.requiresManualIntervention).toBe(true);
    expect(result.exposurePossible).toBe(true);
  });

  it("treats an expired order carrying a fill as unprotected exposure", () => {
    const result = mapOrderToExecutionStatus({ localOrderStatus: "EXPIRED", executedQuantity: "0.001" });
    expect(result.executionStatus).toBe("MANUAL_INTERVENTION");
    expect(result.reasonCode).toBe("UNPROTECTED_PARTIAL_FILL");
  });

  it("treats an unparseable executed quantity as a possible fill, never as zero", () => {
    const result = mapOrderToExecutionStatus({ localOrderStatus: "CANCELED", executedQuantity: "not-a-number" });
    expect(result.executionStatus).toBe("MANUAL_INTERVENTION");
  });

  it("still releases a genuinely zero fill", () => {
    for (const zero of ["0", "0.0", "0.000000000"]) {
      const result = mapOrderToExecutionStatus({ localOrderStatus: "CANCELED", executedQuantity: zero, cancelCause: "TTL" });
      expect(result.executionStatus).toBe("ENTRY_EXPIRED");
    }
  });
});

// ---------------------------------------------------------------------------
// Soft-target cancellation: the SAME order state, a different meaning
// ---------------------------------------------------------------------------

/**
 * A partial fill whose remainder we cancelled ON PURPOSE, because the profile
 * reached its soft open-position target, is not the same event as a partial
 * fill discovered when a plan's TTL ran out.
 *
 * Under TTL the remainder disappeared unexpectedly and the filled quantity is
 * an unprotected surprise, so a human is paged. Under the soft target we chose
 * to stop, protection is already being placed by the orchestrator on the same
 * tick, and paging a human would mean alerting on the system obeying its own
 * policy. The exchange evidence is identical; only the cause differs, so the
 * cause is what the mapping keys on.
 */
describe("soft-target cancellation semantics", () => {
  it("continues a soft-target partial fill into normal protection, with no manual intervention", () => {
    const result = mapOrderToExecutionStatus({
      localOrderStatus: "CANCELED",
      executedQuantity: "0.100",
      cancelCause: "SOFT_OPEN_TARGET",
    });
    // ENTRY_FILLED is the state the orchestrator routes straight into
    // ensureProtectionForExposure. It keeps the open-position slot and releases
    // the pending slot the now-cancelled remainder held.
    expect(result.executionStatus).toBe("ENTRY_FILLED");
    expect(result.reasonCode).toBe("ENTRY_RECONCILED");
    expect(result.requiresManualIntervention).toBe(false);
    expect(result.exposurePossible).toBe(true);
  });

  it("does NOT weaken the TTL mapping it sits beside", () => {
    // The same exchange evidence under the TTL cause still escalates.
    const ttl = mapOrderToExecutionStatus({
      localOrderStatus: "CANCELED",
      executedQuantity: "0.100",
      cancelCause: "TTL",
    });
    expect(ttl.executionStatus).toBe("MANUAL_INTERVENTION");
    expect(ttl.requiresManualIntervention).toBe(true);

    // An unspecified cause is still treated as the dangerous one.
    const unknown = mapOrderToExecutionStatus({ localOrderStatus: "CANCELED", executedQuantity: "0.100" });
    expect(unknown.executionStatus).toBe("MANUAL_INTERVENTION");
  });

  it("terminalizes a zero-fill soft-target cancellation as CANCELED, not ENTRY_EXPIRED", () => {
    // Nothing ever filled and nothing expired: we withdrew it deliberately.
    const result = mapOrderToExecutionStatus({
      localOrderStatus: "CANCELED",
      executedQuantity: "0",
      cancelCause: "SOFT_OPEN_TARGET",
    });
    expect(result.executionStatus).toBe("CANCELED");
    expect(result.requiresManualIntervention).toBe(false);
    expect(result.exposurePossible).toBe(false);
  });

  it("lets a FILLED order win the cancellation race, whatever the cause", () => {
    // The cancel lost: Binance says FILLED. That is authoritative exchange
    // reality and must become an ordinary open position, never a fabricated
    // CANCELED.
    for (const cause of ["SOFT_OPEN_TARGET", "TTL", "OPERATOR", undefined] as const) {
      const result = mapOrderToExecutionStatus({
        localOrderStatus: "FILLED",
        executedQuantity: "0.300",
        cancelCause: cause,
      });
      expect(result.executionStatus, String(cause)).toBe("ENTRY_FILLED");
      expect(result.requiresManualIntervention, String(cause)).toBe(false);
      expect(result.exposurePossible, String(cause)).toBe(true);
    }
  });

  it("leaves a still-working PARTIALLY_FILLED order alone until the cancel proves out", () => {
    // Before the cancellation is confirmed the order is still PARTIALLY_FILLED
    // on the exchange, and the execution stays in that state — protection runs
    // against the confirmed fill in the meantime.
    const result = mapOrderToExecutionStatus({
      localOrderStatus: "PARTIALLY_FILLED",
      executedQuantity: "0.100",
      cancelCause: "SOFT_OPEN_TARGET",
    });
    expect(result.executionStatus).toBe("PARTIALLY_FILLED");
    expect(result.requiresManualIntervention).toBe(false);
  });

  it("is a distinct cause, not a rename of an existing one", () => {
    const causes: Array<Parameters<typeof mapOrderToExecutionStatus>[0]["cancelCause"]> = [
      "TTL",
      "OPERATOR",
      "UNKNOWN",
      "SOFT_OPEN_TARGET",
    ];
    const outcomes = causes.map(
      (cancelCause) =>
        mapOrderToExecutionStatus({ localOrderStatus: "CANCELED", executedQuantity: "0.100", cancelCause })
          .executionStatus
    );
    // Only the soft-target cause avoids escalation.
    expect(outcomes).toEqual([
      "MANUAL_INTERVENTION",
      "MANUAL_INTERVENTION",
      "MANUAL_INTERVENTION",
      "ENTRY_FILLED",
    ]);
  });
});

describe("TTL evaluation", () => {
  const base = new Date("2026-01-01T12:00:00.000Z");

  it("derives the deadline from the submission instant", () => {
    expect(entryDeadlineFrom(base, 300).toISOString()).toBe("2026-01-01T12:05:00.000Z");
  });

  it("rejects a non-positive TTL", () => {
    expect(() => entryDeadlineFrom(base, 0)).toThrow(/positive safe integer/);
    expect(() => entryDeadlineFrom(base, 1.5)).toThrow();
  });

  it("is not due one millisecond before the deadline", () => {
    const deadline = entryDeadlineFrom(base, 300);
    expect(isEntryTtlDue(new Date(deadline.getTime() - 1), deadline)).toBe(false);
  });

  it("is due at the exact deadline", () => {
    const deadline = entryDeadlineFrom(base, 300);
    expect(isEntryTtlDue(deadline, deadline)).toBe(true);
  });

  it("is never due without a durable deadline", () => {
    expect(isEntryTtlDue(base, null)).toBe(false);
  });
});

describe("mutation outcome classification", () => {
  it("treats a timeout as an unknown result, never a failure", () => {
    expect(classifyMutationOutcome({ kind: "TIMEOUT" })).toBe("RESULT_UNKNOWN");
  });

  it("treats a connection reset as an unknown result", () => {
    expect(classifyMutationOutcome({ kind: "NETWORK" })).toBe("RESULT_UNKNOWN");
  });

  it("treats a 5xx as an unknown result, not a confirmed failure", () => {
    expect(classifyMutationOutcome({ kind: "SERVER", httpStatus: 502 })).toBe("RESULT_UNKNOWN");
  });

  it("treats 429 and 418 as retryable under backoff", () => {
    expect(classifyMutationOutcome({ kind: "RATE_LIMIT", httpStatus: 429 })).toBe("QUERY_RETRYABLE");
    expect(classifyMutationOutcome({ kind: "IP_BANNED", httpStatus: 418 })).toBe("QUERY_RETRYABLE");
  });

  it("treats auth and permission failures as confirmed rejections", () => {
    for (const kind of ["AUTH", "PERMISSION", "IP_RESTRICTED", "DISABLED"]) {
      expect(classifyMutationOutcome({ kind })).toBe("CONFIRMED_REJECTED");
    }
  });

  it("recognises a duplicate client order id as a conflict, on standard-order submission only", () => {
    // -4116 is DUPLICATED_CLIENT_ORDER_ID, documented for clientOrderId.
    expect(classifyMutationOutcome({ kind: "MALFORMED_RESPONSE", binanceCode: -4116 }, "SUBMIT_ORDER")).toBe(
      "CONFLICT"
    );
    // The algo family has no established duplicate semantic for clientAlgoId,
    // so it stays ambiguous and is resolved by querying the same id.
    expect(classifyMutationOutcome({ kind: "MALFORMED_RESPONSE", binanceCode: -4116 }, "SUBMIT_ALGO")).toBe(
      "RESULT_UNKNOWN"
    );
    // -4015 is INVALID_CL_ORD_ID_LEN — a malformed-id validation error that
    // must never claim an order exists.
    expect(classifyMutationOutcome({ kind: "REQUEST_INVALID", binanceCode: -4015 }, "SUBMIT_ORDER")).toBe(
      "CONFIRMED_REJECTED"
    );
  });

  it("recognises the documented order-absent codes per operation", () => {
    // -2013 NO_SUCH_ORDER proves absence for both a query and a cancel.
    expect(classifyMutationOutcome({ kind: "MALFORMED_RESPONSE", binanceCode: -2013 }, "QUERY")).toBe(
      "NOT_FOUND_CONFIRMED"
    );
    expect(classifyMutationOutcome({ kind: "MALFORMED_RESPONSE", binanceCode: -2013 }, "CANCEL")).toBe(
      "NOT_FOUND_CONFIRMED"
    );
    // -2011 CANCEL_REJECTED is documented in the cancel context only.
    expect(classifyMutationOutcome({ kind: "MALFORMED_RESPONSE", binanceCode: -2011 }, "CANCEL")).toBe(
      "NOT_FOUND_CONFIRMED"
    );
    expect(classifyMutationOutcome({ kind: "MALFORMED_RESPONSE", binanceCode: -2011 }, "QUERY")).not.toBe(
      "NOT_FOUND_CONFIRMED"
    );
  });

  it("treats no failure as accepted", () => {
    expect(classifyMutationOutcome(null)).toBe("CONFIRMED_ACCEPTED");
  });

  it("defaults an unrecognised kind to unknown rather than success", () => {
    expect(classifyMutationOutcome({ kind: "SOMETHING_ELSE" })).toBe("RESULT_UNKNOWN");
  });
});

describe("order identity", () => {
  it("accepts a matching order despite decimal formatting differences", () => {
    expect(findOrderIdentityMismatches(expected(), observed())).toEqual([]);
  });

  it("rejects a different symbol", () => {
    expect(findOrderIdentityMismatches(expected(), observed({ symbol: "OTHERUSDT" }))).toContain("symbol");
  });

  it("rejects a different side", () => {
    expect(findOrderIdentityMismatches(expected(), observed({ side: "SELL" }))).toContain("side");
  });

  it("rejects a different positionSide", () => {
    expect(findOrderIdentityMismatches(expected(), observed({ positionSide: "SHORT" }))).toContain("positionSide");
  });

  it("rejects a different price", () => {
    expect(findOrderIdentityMismatches(expected(), observed({ price: "101" }))).toContain("price");
  });

  it("rejects a different original quantity", () => {
    expect(findOrderIdentityMismatches(expected(), observed({ originalQuantity: "0.5" }))).toContain("originalQuantity");
  });

  it("rejects a different client order id", () => {
    expect(findOrderIdentityMismatches(expected(), observed({ clientOrderId: "tad-en-2-ffffffffffff" }))).toContain(
      "clientOrderId"
    );
  });

  it("rejects a different order type", () => {
    expect(findOrderIdentityMismatches(expected(), observed({ orderType: "MARKET" }))).toContain("orderType");
  });

  it("rejects missing fields rather than treating them as matching", () => {
    const mismatches = findOrderIdentityMismatches(expected(), observed({ price: null, originalQuantity: null }));
    expect(mismatches).toContain("price");
    expect(mismatches).toContain("originalQuantity");
  });
});

describe("monotonic fill progress", () => {
  it("accepts a forward move", () => {
    const result = mergeFillProgress(
      { executedQuantity: "0.1", averageFillPrice: "100" },
      { executedQuantity: "0.2", averageFillPrice: "100.5" }
    );
    expect(result.executedQuantity).toBe("0.2");
    expect(result.averageFillPrice).toBe("100.5");
    expect(result.regressionIgnored).toBe(false);
  });

  it("ignores a backwards move and flags it", () => {
    const result = mergeFillProgress(
      { executedQuantity: "0.3", averageFillPrice: "100" },
      { executedQuantity: "0.1", averageFillPrice: "99" }
    );
    expect(result.executedQuantity).toBe("0.3");
    expect(result.averageFillPrice).toBe("100");
    expect(result.regressionIgnored).toBe(true);
  });

  it("never clears an already recorded average fill price", () => {
    const result = mergeFillProgress(
      { executedQuantity: "0.1", averageFillPrice: "100" },
      { executedQuantity: "0.1", averageFillPrice: null }
    );
    expect(result.averageFillPrice).toBe("100");
  });

  it("ignores a zero average fill price reported alongside a fill", () => {
    const result = mergeFillProgress(
      { executedQuantity: "0.1", averageFillPrice: "100" },
      { executedQuantity: "0.2", averageFillPrice: "0" }
    );
    expect(result.averageFillPrice).toBe("100");
  });

  it("keeps the previous value when the exchange reports nothing", () => {
    const result = mergeFillProgress(
      { executedQuantity: "0.25", averageFillPrice: "100" },
      { executedQuantity: null, averageFillPrice: null }
    );
    expect(result.executedQuantity).toBe("0.25");
    expect(result.regressionIgnored).toBe(false);
  });

  it("compares with exact decimals, not floats", () => {
    const result = mergeFillProgress(
      { executedQuantity: "0.30000000000000004", averageFillPrice: null },
      { executedQuantity: "0.3", averageFillPrice: null }
    );
    expect(result.executedQuantity).toBe("0.30000000000000004");
    expect(result.regressionIgnored).toBe(true);
  });
});

describe("reconciliation decisions", () => {
  const decide = (overrides: Partial<Parameters<typeof decideReconciliation>[0]> = {}) =>
    decideReconciliation({
      queryOutcome: "CONFIRMED_ACCEPTED",
      identityMismatches: [],
      attempt: 1,
      maxAttempts: 5,
      exposurePossible: true,
      ...overrides,
    });

  it("applies a confirmed order state", () => {
    expect(decide().action).toBe("APPLY_ORDER_STATE");
  });

  it("escalates a contradictory identity instead of rewriting intent", () => {
    const result = decide({ identityMismatches: ["side"] });
    expect(result.action).toBe("ESCALATE_MANUAL");
    expect(result.reasonCode).toBe("ENTRY_ORDER_IDENTITY_MISMATCH");
  });

  it("retries a temporarily unavailable query within budget", () => {
    expect(decide({ queryOutcome: "QUERY_RETRYABLE", attempt: 2 }).action).toBe("RETRY_QUERY");
  });

  it("escalates an unresolved query once the budget is spent and exposure is possible", () => {
    const result = decide({ queryOutcome: "RESULT_UNKNOWN", attempt: 5, maxAttempts: 5 });
    expect(result.action).toBe("ESCALATE_MANUAL");
    expect(result.reasonCode).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("queries again on a duplicate client order id rather than minting a new one", () => {
    const result = decide({ queryOutcome: "CONFLICT" });
    expect(result.action).toBe("RETRY_QUERY");
    expect(result.reasonCode).toBe("ENTRY_INTENT_CONFLICT");
  });

  it("only permits resubmission of the SAME id after the full confirmation window", () => {
    expect(decide({ queryOutcome: "NOT_FOUND_CONFIRMED", attempt: 1 }).action).toBe("RETRY_QUERY");
    expect(decide({ queryOutcome: "NOT_FOUND_CONFIRMED", attempt: 5, maxAttempts: 5 }).action).toBe(
      "RESUBMIT_SAME_CLIENT_ORDER_ID"
    );
  });

  it("never claims the order is absent while exposure is possible", () => {
    const result = decide({ queryOutcome: "RESULT_UNKNOWN", attempt: 9, maxAttempts: 5, exposurePossible: true });
    expect(result.action).not.toBe("STOP_NOT_FOUND");
  });
});

describe("cancellation guard", () => {
  it("permits cancelling an open or partially filled order", () => {
    expect(shouldCancelRemainder("NEW")).toBe(true);
    expect(shouldCancelRemainder("PARTIALLY_FILLED")).toBe(true);
  });

  it("never permits cancelling a filled order", () => {
    expect(shouldCancelRemainder("FILLED")).toBe(false);
  });

  it("never permits cancelling an already closed order", () => {
    for (const status of ["CANCELED", "EXPIRED", "REJECTED", "UNKNOWN"] as const) {
      expect(shouldCancelRemainder(status)).toBe(false);
    }
  });
});

describe("reason codes", () => {
  it("exposes every required stable code", () => {
    for (const code of [
      "LIVE_ENTRY_DISABLED",
      "PROTECTION_NOT_READY",
      "EXECUTION_NOT_PREFLIGHT",
      "SAFETY_ADMISSION_NOT_READY",
      "KILL_SWITCH_RECHECK_ACTIVE",
      "SIGNAL_OR_ENTRY_DEADLINE_EXPIRED",
      "SYMBOL_STATE_CHANGED",
      "SYMBOL_EXPOSURE_CHANGED",
      "POSITION_MODE_MISMATCH",
      "ASSET_MODE_MISMATCH",
      "MARGIN_TYPE_CONFIGURATION_FAILED",
      "MARGIN_TYPE_RESULT_UNKNOWN",
      "MARGIN_TYPE_VERIFICATION_MISMATCH",
      "LEVERAGE_CONFIGURATION_FAILED",
      "LEVERAGE_RESULT_UNKNOWN",
      "LEVERAGE_VERIFICATION_MISMATCH",
      "LEVERAGE_NOTIONAL_LIMIT_MISMATCH",
      "ENTRY_INTENT_CONFLICT",
      "ENTRY_SUBMISSION_REJECTED",
      "ENTRY_SUBMISSION_RESULT_UNKNOWN",
      "ENTRY_ORDER_QUERY_UNAVAILABLE",
      "ENTRY_ORDER_NOT_FOUND",
      "ENTRY_ORDER_IDENTITY_MISMATCH",
      "ENTRY_STATUS_UNSUPPORTED",
      "ENTRY_TTL_EXPIRED",
      "ENTRY_CANCEL_REJECTED",
      "ENTRY_CANCEL_RESULT_UNKNOWN",
      "PARTIAL_FILL_REMAINDER_CANCELED",
      "UNPROTECTED_PARTIAL_FILL",
      "CAPACITY_OR_VERSION_CONFLICT",
      "MANUAL_REVIEW_REQUIRED",
    ] as const) {
      expect(ENTRY_REASON_CODES).toContain(code);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(ENTRY_REASON_CODES).size).toBe(ENTRY_REASON_CODES.length);
  });
});


describe("a terminal partial fill that cannot carry its standard take profit is a human's", () => {
  /**
   * The Layer 2 hole, as a mapping regression.
   *
   * Layer 1 refuses a PLAN whose full quantity cannot support its STANDARD take
   * profit — 100 x 0.06 = 6 against a floor of 5 passes, so this plan is
   * admitted. The entry then fills only 50, and the soft open target withdraws
   * the remainder, freezing the confirmed quantity at 50: 50 x 0.06 = 3, below
   * the floor. The target can now never be placed.
   *
   * The old mapping promoted that into an ordinary ENTRY_FILLED position. The
   * protection lifecycle then verified a stop, refused the target, and parked
   * at PLACING_PROTECTION forever — holding countRecoveryRequired() above zero
   * and globally refusing every new admission. Silently.
   */
  it("routes it to MANUAL_INTERVENTION instead of ordinary ENTRY_FILLED", () => {
    const result = mapOrderToExecutionStatus({
      localOrderStatus: "CANCELED",
      executedQuantity: "50",
      cancelCause: "SOFT_OPEN_TARGET",
      standardTakeProfitFeasibility: "UNPLACEABLE",
    });

    expect(result.executionStatus).toBe("MANUAL_INTERVENTION");
    expect(result.requiresManualIntervention).toBe(true);
    // The exposure is REAL and must keep being reconciled and protected.
    expect(result.exposurePossible).toBe(true);
  });

  it("names the condition accurately and never blames the trigger", () => {
    const result = mapOrderToExecutionStatus({
      localOrderStatus: "CANCELED",
      executedQuantity: "50",
      cancelCause: "SOFT_OPEN_TARGET",
      standardTakeProfitFeasibility: "UNPLACEABLE",
    });
    // The same identifier Layer 1 and the protection lifecycle already use for
    // an under-minimum-notional take profit.
    expect(result.reasonCode).toBe("PROTECTION_QUANTITY_UNSUPPORTED");
    expect(result.reasonCode).not.toBe("TAKE_PROFIT_TRIGGER_INVALID");
    // Distinct from the generic unprotected-partial case, so an operator can
    // tell "nothing is protecting this" from "the target cannot exist".
    expect(result.reasonCode).not.toBe("UNPROTECTED_PARTIAL_FILL");
  });

  it("leaves a FEASIBLE terminal partial exactly as it was", () => {
    // Equality with the floor and anything above it both resolve PLACEABLE, and
    // an absent value is the historical call shape. All must be untouched.
    for (const feasibility of ["PLACEABLE", "NOT_APPLICABLE", undefined] as const) {
      const result = mapOrderToExecutionStatus({
        localOrderStatus: "CANCELED",
        executedQuantity: "50",
        cancelCause: "SOFT_OPEN_TARGET",
        standardTakeProfitFeasibility: feasibility,
      });
      expect(result.executionStatus, String(feasibility)).toBe("ENTRY_FILLED");
      expect(result.reasonCode, String(feasibility)).toBe("ENTRY_RECONCILED");
      expect(result.requiresManualIntervention, String(feasibility)).toBe(false);
    }
  });

  it("does not touch a still-working partial fill, however small", () => {
    // The order is still PARTIALLY_FILLED on the exchange and can still grow
    // past the floor. Killing it here would destroy a perfectly good trade.
    const result = mapOrderToExecutionStatus({
      localOrderStatus: "PARTIALLY_FILLED",
      executedQuantity: "20",
      cancelCause: "SOFT_OPEN_TARGET",
      standardTakeProfitFeasibility: "UNPLACEABLE",
    });
    expect(result.executionStatus).toBe("PARTIALLY_FILLED");
    expect(result.requiresManualIntervention).toBe(false);
  });

  it("changes nothing about a zero-fill withdrawal", () => {
    const result = mapOrderToExecutionStatus({
      localOrderStatus: "CANCELED",
      executedQuantity: "0",
      cancelCause: "SOFT_OPEN_TARGET",
      standardTakeProfitFeasibility: "UNPLACEABLE",
    });
    // No exposure was ever created, so there is nothing to park.
    expect(result.executionStatus).toBe("CANCELED");
    expect(result.requiresManualIntervention).toBe(false);
    expect(result.exposurePossible).toBe(false);
  });

  it("changes nothing about the causes that already escalate", () => {
    // TTL / OPERATOR / UNKNOWN already route to MANUAL_INTERVENTION with their
    // own reason. Layer 2 must not rewrite their diagnosis.
    for (const cause of ["TTL", "OPERATOR", "UNKNOWN"] as const) {
      const result = mapOrderToExecutionStatus({
        localOrderStatus: "CANCELED",
        executedQuantity: "50",
        cancelCause: cause,
        standardTakeProfitFeasibility: "UNPLACEABLE",
      });
      expect(result.executionStatus, cause).toBe("MANUAL_INTERVENTION");
      expect(result.reasonCode, cause).toBe("UNPROTECTED_PARTIAL_FILL");
    }
  });

  it("never overrides an authoritative FILLED", () => {
    // The cancel lost the race and the order filled completely. That is real
    // exchange reality and the quantity is the FULL planned one, which Layer 1
    // already proved can carry its target.
    const result = mapOrderToExecutionStatus({
      localOrderStatus: "FILLED",
      executedQuantity: "100",
      cancelCause: "SOFT_OPEN_TARGET",
      standardTakeProfitFeasibility: "UNPLACEABLE",
    });
    expect(result.executionStatus).toBe("ENTRY_FILLED");
    expect(result.requiresManualIntervention).toBe(false);
  });
});


describe("both terminal-partial routes are covered by construction", () => {
  const SERVICE = readFileSync(
    path.join(process.cwd(), "src", "modules", "execution", "entry-lifecycle.service.ts"),
    "utf8"
  );

  it("has exactly one call site, and it supplies the feasibility fact", () => {
    /**
     * The analysis found TWO production routes to a SOFT_OPEN_TARGET terminal
     * partial — `protectConfirmedFill` after a PARTIALLY_FILLED reconcile, and
     * `expireEntryOrderIfDue` when its pre-cancel re-query discovers a fill.
     * Both reach the mapping through `applyOrderState`, so covering that one
     * call site covers both. Pinned here because patching one caller and
     * missing the other is exactly how the hole would reopen.
     */
    const callSites = SERVICE.match(/mapOrderToExecutionStatus\(/g) ?? [];
    expect(callSites).toHaveLength(1);
    expect(SERVICE).toContain("standardTakeProfitFeasibility: await this.terminalPartialTakeProfitFeasibility(");
  });

  it("resolves feasibility only at the terminal boundary", () => {
    // The resolver returns true for anything that is not a withdrawn, filled,
    // soft-target cancellation, so an ordinary reconcile costs no extra read
    // and a still-resting partial is never judged.
    const body = SERVICE.slice(SERVICE.indexOf("private async terminalPartialTakeProfitFeasibility"));
    expect(body).toContain('if (localStatus !== "CANCELED" || cancelCause !== "SOFT_OPEN_TARGET") return "NOT_APPLICABLE";');
    expect(body).toContain('if (execution.takeProfit === null) return "NOT_APPLICABLE";');
    expect(body).toContain('if (modality !== "STANDARD") return "NOT_APPLICABLE";');
    // An unobtained floor must never answer PLACEABLE.
    expect(body).toContain('return "UNKNOWN";');
  });

  it("reuses the shared floor predicate rather than restating it", () => {
    expect(SERVICE).toContain("standardTakeProfitMeetsMinNotional({");
    // No second copy of the arithmetic anywhere in this service.
    expect(SERVICE).not.toMatch(/greaterThanOrEqualTo\(new D\(.*minNotional/);
  });
});


describe("an unestablished take-profit floor is never treated as a yes", () => {
  /**
   * The boundary commits to RETAINING exposure, so feasibility must be proven.
   * A connector read that failed proves nothing, and "we could not find out"
   * must not share a disposition with "yes".
   */
  it("parks a terminal partial when the floor could not be established", () => {
    const result = mapOrderToExecutionStatus({
      localOrderStatus: "CANCELED",
      executedQuantity: "50",
      cancelCause: "SOFT_OPEN_TARGET",
      standardTakeProfitFeasibility: "UNKNOWN",
    });
    expect(result.executionStatus).toBe("MANUAL_INTERVENTION");
    expect(result.requiresManualIntervention).toBe(true);
    expect(result.exposurePossible).toBe(true);
  });

  it("says the symbol state could not be read, not that the notional is too small", () => {
    const result = mapOrderToExecutionStatus({
      localOrderStatus: "CANCELED",
      executedQuantity: "50",
      cancelCause: "SOFT_OPEN_TARGET",
      standardTakeProfitFeasibility: "UNKNOWN",
    });
    // Claiming PROTECTION_QUANTITY_UNSUPPORTED would assert a floor we never
    // obtained. SYMBOL_STATE_CHANGED is this service's established reason for
    // exactly "Symbol state could not be read."
    expect(result.reasonCode).toBe("SYMBOL_STATE_CHANGED");
    expect(result.reasonCode).not.toBe("PROTECTION_QUANTITY_UNSUPPORTED");
  });

  it("keeps UNKNOWN and PLACEABLE on opposite sides of the promotion", () => {
    const dispositions = (["PLACEABLE", "NOT_APPLICABLE", "UNPLACEABLE", "UNKNOWN"] as const).map(
      (feasibility) =>
        mapOrderToExecutionStatus({
          localOrderStatus: "CANCELED",
          executedQuantity: "50",
          cancelCause: "SOFT_OPEN_TARGET",
          standardTakeProfitFeasibility: feasibility,
        }).executionStatus
    );
    // Only a positively established yes promotes.
    expect(dispositions).toEqual([
      "ENTRY_FILLED",
      "ENTRY_FILLED",
      "MANUAL_INTERVENTION",
      "MANUAL_INTERVENTION",
    ]);
  });

  it("does not park a still-working partial fill when the floor is unknown", () => {
    // The remainder can still fill and the quantity can still grow. A transient
    // connector failure must not terminalise a healthy, live entry.
    const result = mapOrderToExecutionStatus({
      localOrderStatus: "PARTIALLY_FILLED",
      executedQuantity: "20",
      cancelCause: "SOFT_OPEN_TARGET",
      standardTakeProfitFeasibility: "UNKNOWN",
    });
    expect(result.executionStatus).toBe("PARTIALLY_FILLED");
    expect(result.requiresManualIntervention).toBe(false);
  });

  it("changes nothing about a zero-fill withdrawal when the floor is unknown", () => {
    const result = mapOrderToExecutionStatus({
      localOrderStatus: "CANCELED",
      executedQuantity: "0",
      cancelCause: "SOFT_OPEN_TARGET",
      standardTakeProfitFeasibility: "UNKNOWN",
    });
    expect(result.executionStatus).toBe("CANCELED");
    expect(result.requiresManualIntervention).toBe(false);
  });
});
