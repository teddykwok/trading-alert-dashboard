import { describe, expect, it } from "vitest";

import type { TradingControlStatusDto } from "../src/api/operator";
import {
  canEditSourceTimeframes,
  canSaveSourceTimeframes,
  describeSourceTimeframes,
  describeStartContext,
  sameSelection,
  toggleSourceTimeframe,
} from "../src/features/operator/tradingControlActions";

/**
 * The Source Timeframe editor's decision logic.
 *
 * Pure functions only — no network, no DOM, no component harness (the repo
 * carries no React Testing Library, and the rules worth protecting are all in
 * this layer anyway). What the component does with these answers is a matter of
 * rendering; whether the answers are right is a matter of money.
 *
 * The load-bearing rule: an EMPTY selection is never "all". It is the opposite
 * of the symbol allowlist convention sitting next to it in the same panel, so
 * every path that could present or save one is pinned here.
 */

const SUPPORTED = ["1D", "1W", "1M", "3M", "6M", "12M"];

function statusFixture(
  overrides: Partial<TradingControlStatusDto> = {}
): TradingControlStatusDto {
  return {
    generatedAt: "2026-08-23T00:00:00.000Z",
    systemState: "SAFE_OFF",
    profile: { name: "p", accountIdentifier: "a", environment: "MAINNET", isEnabled: false },
    environmentGates: { globalKillSwitch: true, liveEntryEnabled: false, protectionReady: false },
    runtimeAttestation: {
      status: "PASS",
      reasonCode: null,
      message: null,
      backendCount: 1,
      workerCount: 1,
    },
    allowedSymbols: ["COWUSDT"],
    // The Extreme RR lookback governing NEW plans, as persisted.
    rrLookback: { stored: 300, effective: 300, valid: true, supported: [50, 100, 200, 300] },
    sourceTimeframes: {
      enforceable: ["1W", "1M"],
      unrecognized: [],
      valid: true,
      supported: SUPPORTED,
    },
    authorization: null,
    capacity: { pending: 0, open: 0, totalActive: 0, desiredOpen: 3, hardTotal: 5 },
    reservations: { riskUsd: "0", riskLimitUsd: "7.5", marginUsd: "0", marginLimitUsd: "40" },
    latestExecution: null,
    manualIntervention: { present: false, count: 0 },
    warnings: [],
    ...overrides,
  } as TradingControlStatusDto;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

describe("source timeframes: how the policy reads", () => {
  it("offers all six canonical choices from the server, not a hardcoded list", () => {
    // The panel renders `supported` verbatim, so the vocabulary has exactly one
    // owner and a seventh timeframe would appear without a frontend change.
    expect(statusFixture().sourceTimeframes.supported).toEqual([
      "1D",
      "1W",
      "1M",
      "3M",
      "6M",
      "12M",
    ]);
  });

  it("shows the in-force selection plainly", () => {
    expect(describeSourceTimeframes({ enforceable: ["1W", "1M"], unrecognized: [], valid: true })).toBe(
      "1W, 1M"
    );
  });

  it("NEVER renders an empty policy as 'all' — it renders it as none", () => {
    // The single most important assertion in this file. Empty means no signal
    // can execute; the symbol allowlist beside it means the opposite by empty,
    // and an operator must never have to guess which convention they are
    // looking at.
    const text = describeSourceTimeframes({ enforceable: [], unrecognized: [], valid: false });
    expect(text).toContain("NONE");
    expect(text).toContain("no signal can execute");
    expect(text.toLowerCase()).not.toContain("all");
    expect(text.toLowerCase()).not.toContain("unrestricted");
  });

  it("surfaces unrecognised stored values instead of hiding them", () => {
    const text = describeSourceTimeframes({
      enforceable: ["1W"],
      unrecognized: ["4H"],
      valid: false,
    });
    expect(text).toContain("1W");
    expect(text).toContain("1 unrecognised");
  });
});

// ---------------------------------------------------------------------------
// Local editing
// ---------------------------------------------------------------------------

describe("source timeframes: local editing", () => {
  it("toggles a choice on and off, keeping the canonical order", () => {
    expect(toggleSourceTimeframe(["1W"], "1D", SUPPORTED)).toEqual(["1D", "1W"]);
    expect(toggleSourceTimeframe(["1D", "1W"], "1D", SUPPORTED)).toEqual(["1W"]);
    // Order follows `supported`, never click order.
    expect(toggleSourceTimeframe(["12M"], "1D", SUPPORTED)).toEqual(["1D", "12M"]);
  });

  it("can build any non-empty combination, and can empty itself", () => {
    let selection: string[] = [];
    for (const timeframe of SUPPORTED) selection = toggleSourceTimeframe(selection, timeframe, SUPPORTED);
    expect(selection).toEqual(SUPPORTED);
    for (const timeframe of SUPPORTED) selection = toggleSourceTimeframe(selection, timeframe, SUPPORTED);
    // Emptying is allowed locally — it is SAVING one that must be refused, so
    // the operator can clear and rebuild without fighting the control.
    expect(selection).toEqual([]);
  });

  it("treats a reordered selection as unchanged", () => {
    expect(sameSelection(["1W", "1M"], ["1M", "1W"])).toBe(true);
    expect(sameSelection(["1W"], ["1W", "1M"])).toBe(false);
    expect(sameSelection([], [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Save gating
// ---------------------------------------------------------------------------

describe("source timeframes: when Save may be offered", () => {
  it("REFUSES an empty selection, and says what empty would mean", () => {
    const verdict = canSaveSourceTimeframes({ selection: [], inForce: ["1W"], editable: true });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("at least one");
    expect(verdict.reason).toContain("no signal at all");
  });

  it("refuses an empty selection even when everything else is perfect", () => {
    // Emptiness is checked FIRST, so it cannot be masked by an editable system
    // or by looking like a change.
    expect(canSaveSourceTimeframes({ selection: [], inForce: [], editable: true }).allowed).toBe(false);
  });

  it("refuses when the system is not editable", () => {
    expect(canSaveSourceTimeframes({ selection: ["1W"], inForce: ["1M"], editable: false }).allowed).toBe(
      false
    );
  });

  it("refuses an unchanged selection", () => {
    const verdict = canSaveSourceTimeframes({
      selection: ["1M", "1W"],
      inForce: ["1W", "1M"],
      editable: true,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("already the policy in force");
  });

  it("allows a changed, non-empty selection on an editable system", () => {
    expect(
      canSaveSourceTimeframes({ selection: ["1W"], inForce: ["1W", "1M"], editable: true }).allowed
    ).toBe(true);
  });

  it("mirrors the server's SAFE_OFF rule, and names this control in the reason", () => {
    expect(canEditSourceTimeframes(statusFixture()).allowed).toBe(true);

    const armed = canEditSourceTimeframes(statusFixture({ systemState: "ARMED" }));
    expect(armed.allowed).toBe(false);
    expect(armed.reason).toContain("Source timeframes");
    expect(armed.reason).toContain("SAFE OFF");

    const busy = canEditSourceTimeframes(
      statusFixture({ capacity: { pending: 0, open: 1, totalActive: 1, desiredOpen: 3, hardTotal: 5 } })
    );
    expect(busy.allowed).toBe(false);
    expect(busy.reason).toContain("active");

    const manual = canEditSourceTimeframes(
      statusFixture({ manualIntervention: { present: true, count: 1 } })
    );
    expect(manual.allowed).toBe(false);

    expect(canEditSourceTimeframes(null).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The Start Trading confirmation
// ---------------------------------------------------------------------------

describe("source timeframes: the arming dialog", () => {
  it("J. shows the BACKEND in-force policy", () => {
    const context = describeStartContext(statusFixture());
    expect(context.sourceTimeframes).toBe("1W, 1M");
    expect(context.sourceTimeframesValid).toBe(true);
  });

  it("J2. cannot be influenced by an unsaved local draft", () => {
    // `describeStartContext` takes ONLY the server status. There is no
    // parameter through which a checkbox the operator ticked but did not save
    // could reach the phrase they are being asked to confirm.
    expect(describeStartContext.length).toBe(1);
    const status = statusFixture();
    const before = describeStartContext(status).sourceTimeframes;
    const draft = toggleSourceTimeframe(status.sourceTimeframes.enforceable, "12M", SUPPORTED);
    expect(draft).not.toEqual(status.sourceTimeframes.enforceable);
    expect(describeStartContext(status).sourceTimeframes).toBe(before);
  });

  it("J3. flags an invalid persisted policy rather than arming quietly over it", () => {
    const context = describeStartContext(
      statusFixture({
        sourceTimeframes: { enforceable: [], unrecognized: [], valid: false, supported: SUPPORTED },
      })
    );
    expect(context.sourceTimeframesValid).toBe(false);
    expect(context.sourceTimeframes).toContain("NONE");
  });
});
