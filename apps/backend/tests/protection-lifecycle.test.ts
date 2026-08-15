import { describe, expect, it } from "vitest";
import {
  CRITICAL_REASON_CODES,
  PROTECTION_REASON_CODES,
  calculateCoverage,
  calculateMarginTopUp,
  classifyClosure,
  classifyPostCleanupPosition,
  closingSide,
  decideEntryRemainderCleanup,
  countsAsActiveCoverage,
  evaluateEmergencyCloseEligibility,
  evaluateLiquidationSafety,
  findProtectionIdentityMismatches,
  isCancellableProtection,
  isCriticalReason,
  isFullyProtected,
  isValidHedgePositionSide,
  isWithinMarginCap,
  normalizeAlgoStatus,
  normalizeOpenQuantity,
  planSiblingCancellation,
  prioritizeReasonCodes,
  protectionPositionSide,
  validateProtectionTriggers,
  type ExpectedProtectionIdentity,
  type ObservedProtectionIdentity,
} from "../src/modules/execution/protection-lifecycle";

/**
 * Phase 7 pure protection tests. Everything is synthetic — no live symbols,
 * balances, positions or order ids.
 */

function expectedIdentity(overrides: Partial<ExpectedProtectionIdentity> = {}): ExpectedProtectionIdentity {
  return {
    clientAlgoId: "tad-sl-1-0123456789ab",
    symbol: "SYNTHUSDT",
    orderType: "STOP_MARKET",
    side: "SELL",
    positionSide: "LONG",
    quantity: "0.100",
    triggerPrice: "96",
    workingType: "MARK_PRICE",
    priceProtect: false,
    ...overrides,
  };
}

function observedIdentity(overrides: Partial<ObservedProtectionIdentity> = {}): ObservedProtectionIdentity {
  return {
    clientAlgoId: "tad-sl-1-0123456789ab",
    symbol: "SYNTHUSDT",
    orderType: "STOP_MARKET",
    side: "SELL",
    positionSide: "LONG",
    quantity: "0.1",
    triggerPrice: "96.0",
    workingType: "MARK_PRICE",
    priceProtect: false,
    closePosition: false,
    reduceOnly: false,
    ...overrides,
  };
}

describe("closing side and hedge position side", () => {
  it("closes a LONG with SELL on positionSide LONG", () => {
    expect(closingSide("LONG")).toBe("SELL");
    expect(protectionPositionSide("LONG")).toBe("LONG");
  });

  it("closes a SHORT with BUY on positionSide SHORT", () => {
    expect(closingSide("SHORT")).toBe("BUY");
    expect(protectionPositionSide("SHORT")).toBe("SHORT");
  });

  it("never produces BOTH", () => {
    expect(protectionPositionSide("LONG")).not.toBe("BOTH");
    expect(protectionPositionSide("SHORT")).not.toBe("BOTH");
  });

  it("rejects a contradictory or BOTH position side", () => {
    expect(isValidHedgePositionSide("LONG", "LONG")).toBe(true);
    expect(isValidHedgePositionSide("LONG", "SHORT")).toBe(false);
    expect(isValidHedgePositionSide("LONG", "BOTH")).toBe(false);
  });
});

describe("open quantity normalization", () => {
  it("returns the absolute quantity for a matching LONG sign", () => {
    expect(normalizeOpenQuantity("0.250", "LONG")).toEqual({ quantity: "0.25", valid: true });
  });

  it("returns the absolute quantity for a matching SHORT sign", () => {
    expect(normalizeOpenQuantity("-0.250", "SHORT")).toEqual({ quantity: "0.25", valid: true });
  });

  it("rejects a sign that contradicts the direction", () => {
    expect(normalizeOpenQuantity("-0.25", "LONG").valid).toBe(false);
    expect(normalizeOpenQuantity("0.25", "SHORT").valid).toBe(false);
  });

  it("treats a flat position as valid and zero", () => {
    expect(normalizeOpenQuantity("0", "LONG")).toEqual({ quantity: "0", valid: true });
  });

  it("rejects a malformed decimal rather than assuming zero", () => {
    expect(normalizeOpenQuantity("not-a-number", "LONG").valid).toBe(false);
    expect(normalizeOpenQuantity(null, "LONG").valid).toBe(false);
  });
});

describe("liquidation safety", () => {
  const evaluate = (direction: "LONG" | "SHORT", actual: string | null, boundary: string | null = "94") =>
    evaluateLiquidationSafety({ direction, actualLiquidationPrice: actual, requiredBoundary: boundary });

  it("accepts a LONG liquidation below the boundary", () => {
    expect(evaluate("LONG", "90").safe).toBe(true);
  });

  it("accepts exact equality for a LONG", () => {
    expect(evaluate("LONG", "94").safe).toBe(true);
  });

  it("rejects a LONG liquidation above the boundary", () => {
    const result = evaluate("LONG", "94.0000000001");
    expect(result.safe).toBe(false);
    expect(result.reasonCode).toBe("LIQUIDATION_BUFFER_UNSAFE");
  });

  it("accepts a SHORT liquidation above the boundary", () => {
    expect(evaluate("SHORT", "110", "106").safe).toBe(true);
  });

  it("accepts exact equality for a SHORT", () => {
    expect(evaluate("SHORT", "106", "106").safe).toBe(true);
  });

  it("rejects a SHORT liquidation below the boundary", () => {
    expect(evaluate("SHORT", "105.9999999999", "106").safe).toBe(false);
  });

  it("fails closed on missing, zero or malformed data", () => {
    for (const actual of [null, "0", "not-a-number"]) {
      const result = evaluate("LONG", actual);
      expect(result.safe).toBe(false);
      expect(result.reasonCode).toBe("LIQUIDATION_PRICE_UNAVAILABLE");
    }
    expect(evaluate("LONG", "90", null).safe).toBe(false);
  });

  it("compares with exact decimals, not floats", () => {
    expect(evaluate("LONG", "0.30000000000000004", "0.3").safe).toBe(false);
  });
});

describe("coverage arithmetic", () => {
  it("reports the missing delta for both legs", () => {
    const coverage = calculateCoverage({
      confirmedOpenQuantity: "0.25",
      activeStopQuantity: "0.10",
      activeTakeProfitQuantity: "0.10",
    });
    expect(coverage.missingStopQuantity).toBe("0.15");
    expect(coverage.missingTakeProfitQuantity).toBe("0.15");
    expect(coverage.missingQuantity).toBe("0.15");
    expect(coverage.fullyCovered).toBe(false);
  });

  it("declares full cover only on exact equality", () => {
    expect(
      calculateCoverage({ confirmedOpenQuantity: "0.25", activeStopQuantity: "0.25", activeTakeProfitQuantity: "0.25" })
        .fullyCovered
    ).toBe(true);
    expect(
      calculateCoverage({ confirmedOpenQuantity: "0.25", activeStopQuantity: "0.24", activeTakeProfitQuantity: "0.25" })
        .fullyCovered
    ).toBe(false);
  });

  it("flags over-protection instead of accepting it", () => {
    const coverage = calculateCoverage({
      confirmedOpenQuantity: "0.10",
      activeStopQuantity: "0.20",
      activeTakeProfitQuantity: "0.10",
    });
    expect(coverage.overProtected).toBe(true);
    expect(isFullyProtected({ confirmedOpenQuantity: "0.10", activeStopQuantity: "0.20", activeTakeProfitQuantity: "0.10" })).toBe(
      false
    );
  });

  it("never declares protection with zero exposure", () => {
    expect(isFullyProtected({ confirmedOpenQuantity: "0", activeStopQuantity: "0", activeTakeProfitQuantity: "0" })).toBe(
      false
    );
  });

  it("takes the larger gap when the legs differ", () => {
    const coverage = calculateCoverage({
      confirmedOpenQuantity: "0.25",
      activeStopQuantity: "0.25",
      activeTakeProfitQuantity: "0.10",
    });
    expect(coverage.missingQuantity).toBe("0.15");
  });

  it("sums exact decimals without float drift", () => {
    const coverage = calculateCoverage({
      confirmedOpenQuantity: "0.3",
      activeStopQuantity: "0.1",
      activeTakeProfitQuantity: "0.2",
    });
    expect(coverage.missingStopQuantity).toBe("0.2");
    expect(coverage.missingTakeProfitQuantity).toBe("0.1");
  });
});

describe("trigger and filter validation", () => {
  const base = {
    direction: "LONG" as const,
    stopTriggerPrice: "96",
    takeProfitTriggerPrice: "108",
    workingPrice: "100",
    tickSize: "0.01",
    stepSize: "0.001",
    minQty: "0.001",
    quantity: "0.100",
  };

  it("accepts a valid LONG protection pair", () => {
    expect(validateProtectionTriggers(base).valid).toBe(true);
  });

  it("rejects a LONG stop at or above the working price", () => {
    expect(validateProtectionTriggers({ ...base, stopTriggerPrice: "100" }).reasonCode).toBe("STOP_TRIGGER_INVALID");
    expect(validateProtectionTriggers({ ...base, stopTriggerPrice: "101" }).reasonCode).toBe("STOP_TRIGGER_INVALID");
  });

  it("rejects a LONG take profit at or below the working price", () => {
    expect(validateProtectionTriggers({ ...base, takeProfitTriggerPrice: "100" }).reasonCode).toBe(
      "TAKE_PROFIT_TRIGGER_INVALID"
    );
  });

  it("accepts a valid SHORT protection pair", () => {
    const result = validateProtectionTriggers({
      ...base,
      direction: "SHORT",
      stopTriggerPrice: "104",
      takeProfitTriggerPrice: "92",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a SHORT stop at or below the working price", () => {
    expect(
      validateProtectionTriggers({ ...base, direction: "SHORT", stopTriggerPrice: "100", takeProfitTriggerPrice: "92" })
        .reasonCode
    ).toBe("STOP_TRIGGER_INVALID");
  });

  it("rejects a trigger that does not match the tick size", () => {
    expect(validateProtectionTriggers({ ...base, stopTriggerPrice: "96.005" }).reasonCode).toBe(
      "PROTECTION_FILTER_MISMATCH"
    );
  });

  it("rejects a quantity that does not match the step size", () => {
    expect(validateProtectionTriggers({ ...base, quantity: "0.1005" }).reasonCode).toBe(
      "PROTECTION_QUANTITY_UNSUPPORTED"
    );
  });

  it("rejects a quantity below the minimum", () => {
    expect(validateProtectionTriggers({ ...base, quantity: "0.0005", stepSize: "0.0001" }).reasonCode).toBe(
      "PROTECTION_QUANTITY_UNSUPPORTED"
    );
  });

  it("fails closed when the working price is unavailable", () => {
    expect(validateProtectionTriggers({ ...base, workingPrice: null }).reasonCode).toBe("POSITION_STATE_UNAVAILABLE");
  });
});

describe("algo status normalization", () => {
  it("treats NEW and WORKING as active coverage", () => {
    for (const raw of ["NEW", "WORKING", " working "]) {
      expect(normalizeAlgoStatus(raw)).toBe("ACTIVE");
      expect(countsAsActiveCoverage(normalizeAlgoStatus(raw))).toBe(true);
    }
  });

  it("distinguishes TRIGGERED from FILLED", () => {
    expect(normalizeAlgoStatus("TRIGGERED")).toBe("TRIGGERED");
    expect(countsAsActiveCoverage("TRIGGERED")).toBe(false);
    expect(normalizeAlgoStatus("FILLED")).toBe("FILLED");
  });

  it("accepts both Binance cancellation spellings", () => {
    expect(normalizeAlgoStatus("CANCELLED")).toBe("CANCELED");
    expect(normalizeAlgoStatus("CANCELED")).toBe("CANCELED");
  });

  it("refuses to guess an unrecognised token", () => {
    expect(normalizeAlgoStatus("SOMETHING_NEW")).toBe("UNKNOWN");
    expect(normalizeAlgoStatus(null)).toBe("UNKNOWN");
    expect(countsAsActiveCoverage("UNKNOWN")).toBe(false);
  });

  it("allows cancelling only an active or triggered order", () => {
    expect(isCancellableProtection("ACTIVE")).toBe(true);
    expect(isCancellableProtection("TRIGGERED")).toBe(true);
    for (const status of ["FILLED", "CANCELED", "EXPIRED", "REJECTED", "UNKNOWN"] as const) {
      expect(isCancellableProtection(status)).toBe(false);
    }
  });
});

describe("protection identity", () => {
  it("accepts a matching order despite decimal formatting differences", () => {
    expect(findProtectionIdentityMismatches(expectedIdentity(), observedIdentity())).toEqual([]);
  });

  it("rejects every contradictory field", () => {
    const cases: Array<[Partial<ObservedProtectionIdentity>, string]> = [
      [{ clientAlgoId: "tad-sl-2-ffffffffffff" }, "clientAlgoId"],
      [{ symbol: "OTHERUSDT" }, "symbol"],
      [{ orderType: "TAKE_PROFIT_MARKET" }, "orderType"],
      [{ side: "BUY" }, "side"],
      [{ positionSide: "SHORT" }, "positionSide"],
      [{ quantity: "0.2" }, "quantity"],
      [{ triggerPrice: "95" }, "triggerPrice"],
      [{ workingType: "CONTRACT_PRICE" }, "workingType"],
      [{ priceProtect: true }, "priceProtect"],
    ];
    for (const [override, field] of cases) {
      expect(findProtectionIdentityMismatches(expectedIdentity(), observedIdentity(override))).toContain(field);
    }
  });

  it("rejects closePosition=true outright", () => {
    // closePosition ignores our tranche quantity and closes the whole
    // position, so it genuinely contradicts the intent.
    expect(findProtectionIdentityMismatches(expectedIdentity(), observedIdentity({ closePosition: true }))).toContain(
      "closePosition"
    );
  });

  // -------------------------------------------------------------------------
  // Mainnet Canary #2 (execution cmssohd070004t9h226c92lfn).
  //
  // Binance's Algo Service sets reduceOnly ITSELF on a hedge-mode closing
  // conditional order and reports it back as true, even though we never send
  // it. The historical order tad-sl-1-ed8fa3f5d4f2 matched on every other
  // field and was rejected on this alone; the take profit was then never
  // submitted, because submitTranche returns before TP when the STOP is
  // unverified. These three tests pin the corrected semantics.
  // -------------------------------------------------------------------------

  it("A. accepts reduceOnly=true when every other field matches", () => {
    // The exact mainnet shape. reduceOnly=true is strictly risk-reducing.
    expect(findProtectionIdentityMismatches(expectedIdentity(), observedIdentity({ reduceOnly: true }))).toEqual([]);
  });

  it("B. still rejects closePosition=true", () => {
    expect(findProtectionIdentityMismatches(expectedIdentity(), observedIdentity({ closePosition: true }))).toEqual([
      "closePosition",
    ]);
  });

  it("C. reports closePosition as the only mismatch when BOTH flags are true", () => {
    const mismatches = findProtectionIdentityMismatches(
      expectedIdentity(),
      observedIdentity({ reduceOnly: true, closePosition: true })
    );
    expect(mismatches).toEqual(["closePosition"]);
    expect(mismatches).not.toContain("reduceOnly");
  });

  it("never reports reduceOnly as a mismatch for any observed value", () => {
    for (const reduceOnly of [true, false, null]) {
      expect(
        findProtectionIdentityMismatches(expectedIdentity(), observedIdentity({ reduceOnly })),
        String(reduceOnly)
      ).not.toContain("reduceOnly");
    }
  });

  it("keeps every genuine contradiction detectable alongside reduceOnly=true", () => {
    // The relaxation must not blind the comparator to a real substitution.
    for (const [override, field] of [
      [{ clientAlgoId: "tad-sl-2-ffffffffffff" }, "clientAlgoId"],
      [{ quantity: "0.2" }, "quantity"],
      [{ triggerPrice: "95" }, "triggerPrice"],
      [{ workingType: "CONTRACT_PRICE" }, "workingType"],
      [{ positionSide: "SHORT" }, "positionSide"],
    ] as const) {
      expect(
        findProtectionIdentityMismatches(expectedIdentity(), observedIdentity({ ...override, reduceOnly: true })),
        field
      ).toContain(field);
    }
  });

  it("treats missing decimals as a mismatch, not a match", () => {
    const mismatches = findProtectionIdentityMismatches(
      expectedIdentity(),
      observedIdentity({ quantity: null, triggerPrice: null })
    );
    expect(mismatches).toContain("quantity");
    expect(mismatches).toContain("triggerPrice");
  });
});

describe("margin top-up allowance", () => {
  const base = {
    maximumIsolatedMargin: "5.00",
    verifiedCurrentIsolatedMargin: "3.00",
    availableBalance: "100",
    autoAddMarginEnabled: true,
  };

  it("allows exactly the remaining allowance", () => {
    const result = calculateMarginTopUp(base);
    expect(result.allowed).toBe(true);
    expect(result.amount).toBe("2");
    expect(result.remainingAllowance).toBe("2");
  });

  it("refuses when auto-margin is disabled", () => {
    const result = calculateMarginTopUp({ ...base, autoAddMarginEnabled: false });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("AUTO_MARGIN_DISABLED");
  });

  it("refuses when the frozen budget is exhausted", () => {
    const result = calculateMarginTopUp({ ...base, verifiedCurrentIsolatedMargin: "5.00" });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("MARGIN_BUDGET_EXHAUSTED");
  });

  it("never exceeds the frozen maximum even after repeated attempts", () => {
    // Each attempt recomputes from the VERIFIED current margin, so the total
    // can never accumulate past the cap.
    let current = "3.00";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = calculateMarginTopUp({ ...base, verifiedCurrentIsolatedMargin: current });
      if (!result.allowed) break;
      current = String(Number(current) + Number(result.amount));
    }
    expect(isWithinMarginCap(current, "5.00")).toBe(true);
  });

  it("caps the amount at the available balance", () => {
    const result = calculateMarginTopUp({ ...base, availableBalance: "0.5" });
    expect(result.allowed).toBe(true);
    expect(result.amount).toBe("0.5");
  });

  it("refuses when the balance cannot fund anything", () => {
    expect(calculateMarginTopUp({ ...base, availableBalance: "0" }).reasonCode).toBe("INSUFFICIENT_MARGIN_BALANCE");
  });

  it("fails closed when the current margin is unknown", () => {
    const result = calculateMarginTopUp({ ...base, verifiedCurrentIsolatedMargin: null });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("MARGIN_STATE_UNAVAILABLE");
  });

  it("rejects a verified margin above the cap", () => {
    expect(isWithinMarginCap("5.000000000001", "5.00")).toBe(false);
    expect(isWithinMarginCap("5.00", "5.00")).toBe(true);
    expect(isWithinMarginCap(null, "5.00")).toBe(false);
  });
});

describe("emergency close eligibility", () => {
  const base = {
    mode: "ON_UNVERIFIED_STOP" as const,
    confirmedOpenQuantity: "0.25",
    activeStopQuantity: "0",
    stopVerified: false,
    positionIdentityKnown: true,
    reconciliationAttemptsExhausted: true,
    conclusiveStopFailure: false,
  };

  it("is eligible when every condition holds", () => {
    expect(evaluateEmergencyCloseEligibility(base).eligible).toBe(true);
  });

  it("accepts a conclusive stop failure without pretending attempts were spent", () => {
    // A rejection or a contradictory identity is authoritative immediately; no
    // reconciliation attempt was made, and the input must not claim otherwise.
    const result = evaluateEmergencyCloseEligibility({
      ...base,
      reconciliationAttemptsExhausted: false,
      conclusiveStopFailure: true,
    });
    expect(result.eligible).toBe(true);
  });

  it("refuses when neither the budget ran out nor the failure was conclusive", () => {
    // "We could not tell" — the only honest answer for an unreadable stop — can
    // never authorize a market close.
    const result = evaluateEmergencyCloseEligibility({
      ...base,
      reconciliationAttemptsExhausted: false,
      conclusiveStopFailure: false,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasonCode).toBe("STOP_SUBMISSION_RESULT_UNKNOWN");
  });

  it("stays fail-closed in DISABLED mode however strong the evidence", () => {
    for (const evidence of [
      { reconciliationAttemptsExhausted: true, conclusiveStopFailure: false },
      { reconciliationAttemptsExhausted: false, conclusiveStopFailure: true },
      { reconciliationAttemptsExhausted: true, conclusiveStopFailure: true },
    ]) {
      const result = evaluateEmergencyCloseEligibility({ ...base, ...evidence, mode: "DISABLED" });
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("EMERGENCY_CLOSE_DISABLED");
    }
  });

  it("is never eligible in DISABLED mode", () => {
    const result = evaluateEmergencyCloseEligibility({ ...base, mode: "DISABLED" });
    expect(result.eligible).toBe(false);
    expect(result.reasonCode).toBe("EMERGENCY_CLOSE_DISABLED");
  });

  it("is not eligible without exposure", () => {
    expect(evaluateEmergencyCloseEligibility({ ...base, confirmedOpenQuantity: "0" }).eligible).toBe(false);
  });

  it("is not eligible when a verified stop already covers the position", () => {
    const result = evaluateEmergencyCloseEligibility({ ...base, stopVerified: true, activeStopQuantity: "0.25" });
    expect(result.eligible).toBe(false);
    expect(result.reasonCode).toBe("EMERGENCY_CLOSE_NOT_ELIGIBLE");
  });

  it("is not eligible before the reconciliation budget is exhausted", () => {
    expect(evaluateEmergencyCloseEligibility({ ...base, reconciliationAttemptsExhausted: false }).eligible).toBe(false);
  });

  it("is not eligible when the position identity is unknown", () => {
    const result = evaluateEmergencyCloseEligibility({ ...base, positionIdentityKnown: false });
    expect(result.reasonCode).toBe("POSITION_IDENTITY_MISMATCH");
  });
});

describe("closure classification", () => {
  it("does not report closure while exposure remains", () => {
    const result = classifyClosure({
      stopStatus: null,
      takeProfitStatus: "FILLED",
      emergencyFilled: false,
      remainingPositionQuantity: "0.10",
    });
    expect(result.positionClosed).toBe(false);
    expect(result.partialProtectionExit).toBe(true);
    expect(result.reasonCode).toBe("PARTIAL_PROTECTION_EXIT");
    expect(result.reason).toBe("NONE");
  });

  it("reports a take-profit closure only when the position is flat", () => {
    const result = classifyClosure({
      stopStatus: null,
      takeProfitStatus: "FILLED",
      emergencyFilled: false,
      remainingPositionQuantity: "0",
    });
    expect(result.positionClosed).toBe(true);
    expect(result.reason).toBe("TAKE_PROFIT");
  });

  it("reports a stop closure when flat", () => {
    expect(
      classifyClosure({ stopStatus: "FILLED", takeProfitStatus: null, emergencyFilled: false, remainingPositionQuantity: "0" })
        .reason
    ).toBe("STOP_LOSS");
  });

  it("prefers the emergency reason when an emergency order filled", () => {
    expect(
      classifyClosure({ stopStatus: "FILLED", takeProfitStatus: null, emergencyFilled: true, remainingPositionQuantity: "0" })
        .reason
    ).toBe("EMERGENCY");
  });

  it("treats an unreadable remaining quantity as not closed", () => {
    expect(
      classifyClosure({ stopStatus: null, takeProfitStatus: "FILLED", emergencyFilled: false, remainingPositionQuantity: "oops" })
        .positionClosed
    ).toBe(false);
  });
});

describe("sibling cancellation planning", () => {
  const siblings = [
    { clientAlgoId: "a", role: "STOP_LOSS" as const, generation: 1, status: "ACTIVE" as const },
    { clientAlgoId: "b", role: "TAKE_PROFIT" as const, generation: 1, status: "FILLED" as const },
    { clientAlgoId: "c", role: "STOP_LOSS" as const, generation: 2, status: "ACTIVE" as const },
    { clientAlgoId: "d", role: "TAKE_PROFIT" as const, generation: 2, status: "ACTIVE" as const },
  ];

  it("cancels every cancellable sibling across generations once flat", () => {
    const plan = planSiblingCancellation({ siblings, positionClosed: true });
    expect(plan.cancel.map((entry) => entry.clientAlgoId).sort()).toEqual(["a", "c", "d"]);
    expect(plan.blocked).toEqual([]);
  });

  it("never cancels anything while the position is still open", () => {
    const plan = planSiblingCancellation({ siblings, positionClosed: false });
    expect(plan.cancel).toEqual([]);
    // Including the only stop protecting the open exposure.
    expect(plan.blocked.map((entry) => entry.clientAlgoId)).toContain("a");
  });

  it("never plans to cancel an already-filled order", () => {
    const plan = planSiblingCancellation({ siblings, positionClosed: true });
    expect(plan.cancel.map((entry) => entry.clientAlgoId)).not.toContain("b");
  });
});

describe("reason code prioritization", () => {
  it("surfaces the most dangerous condition first", () => {
    expect(prioritizeReasonCodes(["AUTO_MARGIN_DISABLED", "STOP_NOT_VERIFIED"])).toBe("STOP_NOT_VERIFIED");
    expect(prioritizeReasonCodes(["PROTECTION_COVERAGE_INCOMPLETE", "LIQUIDATION_BUFFER_UNSAFE"])).toBe(
      "LIQUIDATION_BUFFER_UNSAFE"
    );
  });

  it("falls back to the first code when none are critical", () => {
    expect(prioritizeReasonCodes(["AUTO_MARGIN_DISABLED", "MARGIN_BUDGET_EXHAUSTED"])).toBe("AUTO_MARGIN_DISABLED");
  });

  it("returns null for an empty set", () => {
    expect(prioritizeReasonCodes([])).toBeNull();
  });

  it("classifies unprotected-exposure conditions as critical", () => {
    for (const code of ["STOP_NOT_VERIFIED", "LIQUIDATION_BUFFER_UNSAFE", "PARTIAL_PROTECTION_EXIT"] as const) {
      expect(isCriticalReason(code)).toBe(true);
    }
    expect(isCriticalReason("AUTO_MARGIN_DISABLED")).toBe(false);
  });

  it("exposes every required stable reason code", () => {
    for (const code of [
      "PROTECTION_NOT_ENABLED",
      "EXECUTION_HAS_NO_CONFIRMED_FILL",
      "POSITION_STATE_UNAVAILABLE",
      "POSITION_NOT_FOUND_AFTER_FILL",
      "POSITION_IDENTITY_MISMATCH",
      "POSITION_QUANTITY_MISMATCH",
      "PROTECTION_FILTER_MISMATCH",
      "STOP_TRIGGER_INVALID",
      "TAKE_PROFIT_TRIGGER_INVALID",
      "PROTECTION_QUANTITY_UNSUPPORTED",
      "LIQUIDATION_PRICE_UNAVAILABLE",
      "LIQUIDATION_BUFFER_UNSAFE",
      "MARGIN_STATE_UNAVAILABLE",
      "MARGIN_BUDGET_EXHAUSTED",
      "AUTO_MARGIN_DISABLED",
      "INSUFFICIENT_MARGIN_BALANCE",
      "MARGIN_TOP_UP_SUBMITTING",
      "MARGIN_TOP_UP_REJECTED",
      "MARGIN_TOP_UP_RESULT_UNKNOWN",
      "MARGIN_TOP_UP_VERIFICATION_FAILED",
      "STOP_INTENT_CONFLICT",
      "STOP_SUBMISSION_REJECTED",
      "STOP_SUBMISSION_RESULT_UNKNOWN",
      "STOP_QUERY_UNAVAILABLE",
      "STOP_IDENTITY_MISMATCH",
      "STOP_NOT_VERIFIED",
      "TAKE_PROFIT_INTENT_CONFLICT",
      "TAKE_PROFIT_SUBMISSION_REJECTED",
      "TAKE_PROFIT_SUBMISSION_RESULT_UNKNOWN",
      "TAKE_PROFIT_QUERY_UNAVAILABLE",
      "TAKE_PROFIT_IDENTITY_MISMATCH",
      "TAKE_PROFIT_NOT_VERIFIED",
      "PROTECTION_COVERAGE_INCOMPLETE",
      "PROTECTION_GENERATION_CONFLICT",
      "EMERGENCY_CLOSE_DISABLED",
      "EMERGENCY_CLOSE_NOT_ELIGIBLE",
      "EMERGENCY_CLOSE_SUBMISSION_REJECTED",
      "EMERGENCY_CLOSE_RESULT_UNKNOWN",
      "EMERGENCY_CLOSE_VERIFICATION_FAILED",
      "SIBLING_CANCELLATION_REJECTED",
      "SIBLING_CANCELLATION_RESULT_UNKNOWN",
      "SIBLING_CLEANUP_INCOMPLETE",
      "PARTIAL_PROTECTION_EXIT",
      "CAPACITY_OR_VERSION_CONFLICT",
      "MANUAL_REVIEW_REQUIRED",
    ] as const) {
      expect(PROTECTION_REASON_CODES).toContain(code);
    }
  });

  it("has no duplicate codes and a non-empty critical set", () => {
    expect(new Set(PROTECTION_REASON_CODES).size).toBe(PROTECTION_REASON_CODES.length);
    expect(CRITICAL_REASON_CODES.length).toBeGreaterThan(0);
  });
});

describe("incremental tranches", () => {
  it("protects 0.10 first, then exactly the 0.15 delta", () => {
    const first = calculateCoverage({
      confirmedOpenQuantity: "0.10",
      activeStopQuantity: "0",
      activeTakeProfitQuantity: "0",
    });
    expect(first.missingQuantity).toBe("0.1");

    const second = calculateCoverage({
      confirmedOpenQuantity: "0.25",
      activeStopQuantity: "0.10",
      activeTakeProfitQuantity: "0.10",
    });
    expect(second.missingQuantity).toBe("0.15");

    // Aggregate after generation 2 covers the whole position.
    const aggregate = calculateCoverage({
      confirmedOpenQuantity: "0.25",
      activeStopQuantity: "0.25",
      activeTakeProfitQuantity: "0.25",
    });
    expect(aggregate.fullyCovered).toBe(true);
    expect(aggregate.missingQuantity).toBe("0");
  });

  it("creates no further tranche when coverage already matches", () => {
    expect(
      calculateCoverage({ confirmedOpenQuantity: "0.25", activeStopQuantity: "0.25", activeTakeProfitQuantity: "0.25" })
        .missingQuantity
    ).toBe("0");
  });
});

// ===========================================================================
// Entry-remainder cleanup before terminal closure
// ===========================================================================

describe("entry remainder cleanup decisions", () => {
  const decide = (
    entryStatus: Parameters<typeof decideEntryRemainderCleanup>[0]["entryStatus"],
    overrides: Partial<Parameters<typeof decideEntryRemainderCleanup>[0]> = {}
  ) => decideEntryRemainderCleanup({ entryStatus, entryStateUnavailable: false, identityMismatches: [], ...overrides });

  it("needs no cleanup for an entry that is already terminal", () => {
    for (const status of ["FILLED", "CANCELED", "EXPIRED", "REJECTED"] as const) {
      expect(decide(status).action).toBe("NO_REMAINDER");
    }
  });

  it("cancels a still-working entry before closure", () => {
    for (const status of ["NEW", "PARTIALLY_FILLED"] as const) {
      expect(decide(status).action).toBe("CANCEL_REMAINDER");
    }
  });

  it("blocks closure when the entry state cannot be read", () => {
    const result = decide("NEW", { entryStateUnavailable: true });
    expect(result.action).toBe("BLOCK_UNRESOLVED");
    expect(result.reasonCode).toBe("ENTRY_ORDER_STATE_UNAVAILABLE_DURING_CLOSURE");
  });

  it("blocks closure on a contradictory entry identity rather than cancelling it", () => {
    const result = decide("NEW", { identityMismatches: ["side"] });
    expect(result.action).toBe("BLOCK_UNRESOLVED");
    expect(result.reasonCode).toBe("ENTRY_REMAINDER_CLEANUP_FAILED");
  });

  it("blocks closure on an unknown entry status", () => {
    expect(decide("UNKNOWN").action).toBe("BLOCK_UNRESOLVED");
  });
});

describe("post-cleanup position classification", () => {
  it("accepts a genuinely flat position", () => {
    expect(classifyPostCleanupPosition("0").action).toBe("NO_REMAINDER");
  });

  it("detects a refill during cancellation", () => {
    const result = classifyPostCleanupPosition("0.05");
    expect(result.action).toBe("REFILLED_RECOVER_PROTECTION");
    expect(result.reasonCode).toBe("ENTRY_REFILLED_DURING_CLOSURE");
  });

  it("treats an unreadable quantity as unresolved, never as flat", () => {
    expect(classifyPostCleanupPosition("oops").action).toBe("BLOCK_UNRESOLVED");
  });

  it("classifies the new closure codes as critical", () => {
    for (const code of [
      "ENTRY_REFILLED_DURING_CLOSURE",
      "ENTRY_REMAINDER_CLEANUP_FAILED",
      "ENTRY_ORDER_STATE_UNAVAILABLE_DURING_CLOSURE",
    ] as const) {
      expect(PROTECTION_REASON_CODES).toContain(code);
      expect(isCriticalReason(code)).toBe(true);
    }
  });
});
