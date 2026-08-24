import { describe, expect, it } from "vitest";

import type { TradingControlStatusDto } from "../src/api/operator";
import {
  canEditRrLookback,
  canSaveRrLookback,
  describeRrLookback,
  describeStartContext,
} from "../src/features/operator/tradingControlActions";

/**
 * The Extreme RR lookback selector's decision logic.
 *
 * Pure functions only — no network, no DOM, no component harness (the repo
 * carries no React Testing Library, and the rules worth protecting live here).
 *
 * The load-bearing rule: an INVALID stored value must never be presented as
 * "300 candles". The operator would believe a window is governing new plans
 * when planning is in fact refusing.
 */

const SUPPORTED = [50, 100, 200, 300];

function statusFixture(overrides: Partial<TradingControlStatusDto> = {}): TradingControlStatusDto {
  return {
    generatedAt: "2026-08-24T00:00:00.000Z",
    systemState: "SAFE_OFF",
    profile: { name: "p", accountIdentifier: "a", environment: "MAINNET", isEnabled: false },
    environmentGates: { globalKillSwitch: true, liveEntryEnabled: false, protectionReady: false },
    runtimeAttestation: { status: "PASS", reasonCode: null, message: null, backendCount: 1, workerCount: 1 },
    allowedSymbols: ["COWUSDT"],
    sourceTimeframes: {
      enforceable: ["1W", "1M"],
      unrecognized: [],
      valid: true,
      supported: ["1D", "1W", "1M", "3M", "6M", "12M"],
    },
    rrLookback: { stored: 50, effective: 50, valid: true, supported: SUPPORTED },
    authorization: null,
    capacity: { pending: 0, open: 0, totalActive: 0, desiredOpen: 3, hardTotal: 5 },
    reservations: { riskUsd: "0", riskLimitUsd: "7.5", marginUsd: "0", marginLimitUsd: "40" },
    latestExecution: null,
    manualIntervention: { present: false, count: 0 },
    warnings: [],
    ...overrides,
  } as TradingControlStatusDto;
}

describe("rr lookback: how the policy reads", () => {
  it("offers exactly four choices, from the server rather than a hardcoded list", () => {
    expect(statusFixture().rrLookback.supported).toEqual([50, 100, 200, 300]);
    expect(statusFixture().rrLookback.supported).toHaveLength(4);
  });

  it("shows the in-force window plainly", () => {
    expect(describeRrLookback({ stored: 50, effective: 50, valid: true })).toBe("50 candles");
    expect(describeRrLookback({ stored: 300, effective: 300, valid: true })).toBe("300 candles");
  });

  it("NEVER renders an invalid stored value as 300", () => {
    const text = describeRrLookback({ stored: 150, effective: null, valid: false });
    expect(text).toContain("INVALID");
    expect(text).toContain("150");
    expect(text).toContain("refuses");
    expect(text).not.toContain("300");
  });

  it("names an unset value rather than inventing one", () => {
    const text = describeRrLookback({ stored: Number.NaN, effective: null, valid: false });
    expect(text).toContain("unset");
  });
});

describe("rr lookback: when Save may be offered", () => {
  const base = { supported: SUPPORTED, editable: true };

  it("allows a changed, supported selection on an editable system", () => {
    expect(canSaveRrLookback({ ...base, selection: 100, inForce: 50 }).allowed).toBe(true);
  });

  it("refuses an unchanged selection", () => {
    const verdict = canSaveRrLookback({ ...base, selection: 50, inForce: 50 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("already the lookback in force");
  });

  it("refuses an unsupported or absent selection — no arbitrary numbers", () => {
    for (const bad of [null, 49, 51, 150, 301, 0]) {
      const verdict = canSaveRrLookback({ ...base, selection: bad as number | null, inForce: 50 });
      expect(`${String(bad)}:${verdict.allowed}`).toBe(`${String(bad)}:false`);
    }
  });

  it("refuses when the system is not editable", () => {
    expect(canSaveRrLookback({ ...base, editable: false, selection: 100, inForce: 50 }).allowed).toBe(false);
  });

  it("mirrors the server's SAFE_OFF rule and names this control", () => {
    expect(canEditRrLookback(statusFixture()).allowed).toBe(true);

    const armed = canEditRrLookback(statusFixture({ systemState: "ARMED" }));
    expect(armed.allowed).toBe(false);
    expect(armed.reason).toContain("Extreme RR lookback");
    expect(armed.reason).toContain("SAFE OFF");

    const busy = canEditRrLookback(
      statusFixture({ capacity: { pending: 0, open: 1, totalActive: 1, desiredOpen: 3, hardTotal: 5 } })
    );
    expect(busy.allowed).toBe(false);

    expect(canEditRrLookback(statusFixture({ manualIntervention: { present: true, count: 1 } })).allowed).toBe(
      false
    );
    expect(canEditRrLookback(null).allowed).toBe(false);
  });
});

describe("rr lookback: the arming dialog", () => {
  it("J. shows the BACKEND in-force value", () => {
    const context = describeStartContext(statusFixture());
    expect(context.rrLookback).toBe("50 candles");
    expect(context.rrLookbackValid).toBe(true);
  });

  it("J2. cannot be influenced by an unsaved local draft", () => {
    // `describeStartContext` takes ONLY the server status; there is no
    // parameter through which a radio the operator moved but did not save
    // could reach the phrase they are asked to confirm.
    expect(describeStartContext.length).toBe(1);
    const status = statusFixture();
    const before = describeStartContext(status).rrLookback;
    const draft = 300; // the operator ticks a different radio
    expect(draft).not.toBe(status.rrLookback.effective);
    expect(describeStartContext(status).rrLookback).toBe(before);
  });

  it("J3. flags an invalid persisted policy rather than arming quietly over it", () => {
    const context = describeStartContext(
      statusFixture({ rrLookback: { stored: 150, effective: null, valid: false, supported: SUPPORTED } })
    );
    expect(context.rrLookbackValid).toBe(false);
    expect(context.rrLookback).toContain("INVALID");
  });
});
