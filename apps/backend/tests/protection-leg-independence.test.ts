import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  calculateCoverage,
  isFullyProtected,
  validateProtectionTriggers,
  type TriggerValidationInput,
} from "../src/modules/execution/protection-lifecycle";

/**
 * A take profit that can no longer be placed must never cost the stop-loss.
 *
 * ## The incident
 *
 * ENJUSDT SHORT filled at 0.02811 while the runtime was offline. By the time
 * the worker restarted, price had fallen to ~0.02652 — THROUGH the 0.02726
 * take-profit target. That is the trade working: the position was in profit.
 *
 * But a SHORT take profit must sit below the working price to rest as a pending
 * trigger, so the frozen 0.02726 was no longer placeable. `validateProtectionTriggers`
 * returned ONE combined verdict for both legs, the caller read `!valid`, and
 * neither order was submitted. The stop at 0.02868 — valid the entire time, and
 * the only thing standing between a live 2631-unit position and an unbounded
 * loss — was never attempted. The execution parked at MANUAL_INTERVENTION with
 * no protection whatsoever.
 *
 * Reaching your profit target is not a reason to lose your stop. These tests
 * pin the legs apart.
 */

// ---------------------------------------------------------------------------
// The incident's exact numbers
// ---------------------------------------------------------------------------

/** ENJUSDT SHORT, as frozen on the real execution. */
const ENJ: TriggerValidationInput = {
  direction: "SHORT",
  stopTriggerPrice: "0.02868",
  takeProfitTriggerPrice: "0.02726",
  // Mark price when the worker came back and tried to protect.
  workingPrice: "0.02652",
  tickSize: "0.00001",
  stepSize: "1",
  minQty: "1",
  quantity: "2631",
};

describe("J. the ENJUSDT regression, with its real numbers", () => {
  const verdict = validateProtectionTriggers(ENJ);

  it("classifies the take profit as unplaceable", () => {
    // Price has already gone past it, so it would trigger immediately.
    expect(verdict.takeProfit.valid).toBe(false);
    expect(verdict.takeProfit.reasonCode).toBe("TAKE_PROFIT_TRIGGER_INVALID");
    expect(verdict.takeProfit.message).toBe("A SHORT take profit must sit below the current working price.");
  });

  it("classifies the STOP as valid — it always was", () => {
    // 0.02868 sits above the 0.02652 mark: a SHORT stop that has not been hit.
    expect(verdict.stop.valid).toBe(true);
    expect(verdict.stop.reasonCode).toBeNull();
  });

  it("the combined verdict still reports the plan as not wholly placeable", () => {
    // Unchanged meaning, so callers that genuinely ask "can the whole plan go
    // on?" keep their answer. What changed is that this is no longer the field
    // deciding whether a stop is submitted.
    expect(verdict.valid).toBe(false);
    expect(verdict.reasonCode).toBe("TAKE_PROFIT_TRIGGER_INVALID");
  });

  it("the position is not treated as protected while only a stop exists", () => {
    // A verified stop covering the whole position is still NOT full coverage,
    // so nothing downstream can report this position as PROTECTED.
    expect(
      isFullyProtected({
        confirmedOpenQuantity: "2631",
        activeStopQuantity: "2631",
        activeTakeProfitQuantity: "0",
      })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/** A healthy LONG pair: stop below, take profit above, working price between. */
const LONG: TriggerValidationInput = {
  direction: "LONG",
  stopTriggerPrice: "96",
  takeProfitTriggerPrice: "108",
  workingPrice: "100",
  tickSize: "0.01",
  stepSize: "0.001",
  minQty: "0.001",
  quantity: "0.100",
};

describe("the four leg combinations", () => {
  it("A. STOP valid + TP valid — unchanged, the whole plan is placeable", () => {
    const verdict = validateProtectionTriggers(LONG);
    expect(verdict.stop.valid).toBe(true);
    expect(verdict.takeProfit.valid).toBe(true);
    expect(verdict.valid).toBe(true);
    expect(verdict.reasonCode).toBeNull();
  });

  it("B. STOP valid + TP invalid — the stop survives on its own verdict", () => {
    // LONG take profit at or below the working price: already passed.
    const verdict = validateProtectionTriggers({ ...LONG, takeProfitTriggerPrice: "100" });
    expect(verdict.stop.valid).toBe(true);
    expect(verdict.takeProfit.valid).toBe(false);
    expect(verdict.takeProfit.reasonCode).toBe("TAKE_PROFIT_TRIGGER_INVALID");
  });

  it("C. STOP invalid + TP valid — the stop failure stands, and it is the reported one", () => {
    // A LONG stop at the working price would fire immediately.
    const verdict = validateProtectionTriggers({ ...LONG, stopTriggerPrice: "100" });
    expect(verdict.stop.valid).toBe(false);
    expect(verdict.stop.reasonCode).toBe("STOP_TRIGGER_INVALID");
    expect(verdict.takeProfit.valid).toBe(true);
    expect(verdict.valid).toBe(false);
    // The STOP is what an operator must be told about.
    expect(verdict.reasonCode).toBe("STOP_TRIGGER_INVALID");
  });

  it("D. both invalid — fails closed, and reports the STOP first", () => {
    const verdict = validateProtectionTriggers({
      ...LONG,
      stopTriggerPrice: "101",
      takeProfitTriggerPrice: "99",
    });
    expect(verdict.stop.valid).toBe(false);
    expect(verdict.takeProfit.valid).toBe(false);
    expect(verdict.valid).toBe(false);
    expect(verdict.reasonCode).toBe("STOP_TRIGGER_INVALID");
  });

  it("I. the LONG mirror of the incident: target passed, stop still good", () => {
    // Price ran UP through a LONG take profit — the same good outcome.
    const verdict = validateProtectionTriggers({ ...LONG, workingPrice: "110" });
    expect(verdict.takeProfit.valid).toBe(false);
    expect(verdict.takeProfit.reasonCode).toBe("TAKE_PROFIT_TRIGGER_INVALID");
    expect(verdict.stop.valid).toBe(true);
  });
});

describe("shared preconditions still fail BOTH legs", () => {
  it("an unreadable working price blocks everything — direction cannot be judged", () => {
    for (const workingPrice of [null, "0", "-1"]) {
      const verdict = validateProtectionTriggers({ ...LONG, workingPrice });
      expect(verdict.stop.valid, String(workingPrice)).toBe(false);
      expect(verdict.takeProfit.valid, String(workingPrice)).toBe(false);
      expect(verdict.reasonCode).toBe("POSITION_STATE_UNAVAILABLE");
    }
  });

  it("H. an unsupported quantity blocks both legs — it is a property of the tranche", () => {
    for (const quantity of ["0", "-1", "0.0001"]) {
      const verdict = validateProtectionTriggers({ ...LONG, quantity });
      expect(verdict.stop.valid, quantity).toBe(false);
      expect(verdict.takeProfit.valid, quantity).toBe(false);
      expect(verdict.reasonCode).toBe("PROTECTION_QUANTITY_UNSUPPORTED");
    }
  });

  it("a shared precondition outranks a broken stop trigger, and still fails closed", () => {
    // Ordering note. The old function interleaved its checks and would have
    // reported STOP_TRIGGER_INVALID when the stop was missing AND the quantity
    // was unusable; grouping the shared preconditions first reports the
    // quantity instead. Both are refusals and both leave `stop.valid` false, so
    // the caller escalates identically — only the wording an operator reads
    // changes, and the quantity is the more actionable of the two.
    //
    // Pinned rather than left incidental: `executableStopLoss` is a non-null
    // column, so a null stop trigger is unreachable in practice, and this
    // documents the deliberate choice if that ever changes.
    const verdict = validateProtectionTriggers({ ...LONG, stopTriggerPrice: "", quantity: "0" });
    expect(verdict.valid).toBe(false);
    expect(verdict.stop.valid).toBe(false);
    expect(verdict.reasonCode).toBe("PROTECTION_QUANTITY_UNSUPPORTED");
  });

  it("H2. a valid partial quantity still passes both legs", () => {
    // Partial-fill protection sizing is unchanged: a smaller but legal
    // quantity is not a reason to refuse either leg.
    const verdict = validateProtectionTriggers({ ...LONG, quantity: "0.050" });
    expect(verdict.valid).toBe(true);
  });
});

describe("a plan with no take profit at all", () => {
  it("reports the take-profit leg as valid — there is nothing to refuse", () => {
    const verdict = validateProtectionTriggers({ ...LONG, takeProfitTriggerPrice: null });
    expect(verdict.takeProfit.valid).toBe(true);
    expect(verdict.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural guarantees about the caller
// ---------------------------------------------------------------------------

const SERVICE = readFileSync(
  path.resolve(__dirname, "../src/modules/execution/protection-lifecycle.service.ts"),
  "utf8"
);

describe("structural: only the stop can withhold protection", () => {
  it("the reservation gate reads the STOP leg, never the combined verdict", () => {
    // The exact line that caused the incident was `if (!validation.valid)`.
    expect(SERVICE).toContain("if (!validation.stop.valid)");
    expect(SERVICE).not.toContain("if (!validation.valid)");
  });

  it("an unplaceable take profit is dropped from the tranche, not faked", () => {
    // No TAKE_PROFIT order row is created, so nothing downstream can measure
    // coverage for a leg that does not exist.
    expect(SERVICE).toContain("const takeProfitForTranche = validation.takeProfit.valid ? takeProfitTrigger : null;");
    expect(SERVICE).toContain('role === "STOP_LOSS" ? stopTrigger : takeProfitForTranche');
  });

  it("F. a verified stop is never rolled back because the take profit failed", () => {
    // Pre-existing guarantee, pinned so this change cannot erode it.
    expect(SERVICE).toContain("The verified STOP is retained");
    expect(SERVICE).not.toMatch(/cancel[A-Za-z]*Stop|cancelProtection\(/);
  });

  it("the omission is recorded on the reservation event", () => {
    expect(SERVICE).toContain("takeProfitOmitted:");
    expect(SERVICE).toContain("takeProfitOmittedReason,");
  });

  it("G. a dropped take profit leaves the tranche INCOMPLETE, so the next tick resumes it", () => {
    // `findIncompleteTranche` treats a missing TP as incomplete, which is what
    // makes the next tick RESUME generation N instead of minting a new one —
    // the property that prevents a duplicate stop.
    // Asserted without line endings: the file is CRLF and the guarantee is
    // about the condition itself, not about how the source happens to wrap.
    const condition = SERVICE.slice(
      SERVICE.indexOf("const incomplete ="),
      SERVICE.indexOf("if (incomplete) return generation;")
    );
    expect(condition).toContain("!stop");
    expect(condition).toContain("!takeProfit");
  });

  it("K/L. this change touches no admission, capacity or authorization logic", () => {
    for (const forbidden of ["admitAndSubmit", "claimNaturalWindow", "maxTotalActiveTrades", "killSwitch"]) {
      expect(`${forbidden}:${SERVICE.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

describe("coverage arithmetic is unchanged", () => {
  it("still requires BOTH legs for full protection", () => {
    expect(isFullyProtected({ confirmedOpenQuantity: "10", activeStopQuantity: "10", activeTakeProfitQuantity: "10" })).toBe(true);
    expect(isFullyProtected({ confirmedOpenQuantity: "10", activeStopQuantity: "10", activeTakeProfitQuantity: "0" })).toBe(false);
    expect(isFullyProtected({ confirmedOpenQuantity: "10", activeStopQuantity: "0", activeTakeProfitQuantity: "10" })).toBe(false);
  });

  it("still reports over-protection rather than accepting it", () => {
    const coverage = calculateCoverage({
      confirmedOpenQuantity: "10",
      activeStopQuantity: "11",
      activeTakeProfitQuantity: "10",
    });
    expect(coverage.overProtected).toBe(true);
  });
});
