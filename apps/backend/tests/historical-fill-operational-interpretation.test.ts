import { describe, expect, it } from "vitest";

import {
  HISTORICAL_FILL_ISSUE_CODES,
  HISTORICAL_FILL_OPERATIONAL_STATES,
  interpretHistoricalFillOperationalSnapshot,
} from "../src/modules/execution/historical-fill-operational-interpretation";
import type { HistoricalFillOperationalSnapshot } from "../src/modules/execution/historical-fill-operational-snapshot.service";

/**
 * The one place historical-fill facts become a judgement.
 *
 * Pure, so every case is a direct call: no database, no clock, no HTTP. What
 * these tests mostly pin is RESTRAINT — the long list of ordinary conditions
 * that must NOT raise a flag matters more than the five that must, because a
 * panel that cries about a queue doing its job is a panel operators learn to
 * ignore.
 */

const CAPTURED_AT = new Date("2026-08-12T09:15:00.000Z");

/** A READY snapshot with every trigger at zero. */
const ready = (
  overrides: {
    windows?: Partial<Extract<HistoricalFillOperationalSnapshot, { outcome: "READY" }>["windows"]["byStatus"]>;
    pending?: Partial<Extract<HistoricalFillOperationalSnapshot, { outcome: "READY" }>["pending"]>;
    ledger?: Partial<Extract<HistoricalFillOperationalSnapshot, { outcome: "READY" }>["ledger"]>;
  } = {}
): HistoricalFillOperationalSnapshot => ({
  outcome: "READY",
  capturedAt: CAPTURED_AT,
  executionProfileId: "profile-1",
  windows: {
    total: 10,
    roots: 8,
    children: 2,
    distinctSymbolCount: 2,
    byStatus: {
      PENDING: 0,
      COMPLETE: 0,
      SPLIT: 0,
      INCOMPLETE_SKIPPED_ROWS: 0,
      SATURATED_SINGLE_MILLISECOND: 0,
      ABANDONED: 0,
      ...overrides.windows,
    },
  },
  pending: {
    total: 0,
    claimableNow: 0,
    activeLease: 0,
    staleLease: 0,
    inBackoff: 0,
    attemptExhausted: 0,
    oldestPendingCreatedAt: null,
    oldestClaimableCreatedAt: null,
    nextBackoffEligibleAt: null,
    ...overrides.pending,
  },
  ledger: { totalFills: 0, unattributedFills: 0, ...overrides.ledger },
});

describe("the contract", () => {
  it("offers exactly three states and five issue codes", () => {
    expect([...HISTORICAL_FILL_OPERATIONAL_STATES]).toEqual([
      "NORMAL",
      "NEEDS_ATTENTION",
      "UNAVAILABLE",
    ]);
    // No INFO/WARNING/CRITICAL ladder, and no colour is a state.
    expect(HISTORICAL_FILL_OPERATIONAL_STATES).toHaveLength(3);
    expect([...HISTORICAL_FILL_ISSUE_CODES]).toEqual([
      "STALE_LEASES_PRESENT",
      "ATTEMPT_EXHAUSTED_PRESENT",
      "ABANDONED_WINDOWS_PRESENT",
      "INCOMPLETE_SKIPPED_ROWS_PRESENT",
      "SATURATED_SINGLE_MILLISECOND_PRESENT",
    ]);
  });

  it("A. cannot evaluate an unbound profile, so it says so", () => {
    const snapshot: HistoricalFillOperationalSnapshot = {
      outcome: "PROFILE_UNAVAILABLE",
      capturedAt: CAPTURED_AT,
      reasonCode: "PROFILE_POLICY_MISSING",
    };

    // UNAVAILABLE, never NEEDS_ATTENTION: there is no workset to have an
    // opinion about.
    expect(interpretHistoricalFillOperationalSnapshot(snapshot)).toEqual({
      state: "UNAVAILABLE",
      issues: [],
    });
  });

  it("B. an untroubled snapshot is NORMAL with nothing to report", () => {
    expect(interpretHistoricalFillOperationalSnapshot(ready())).toEqual({
      state: "NORMAL",
      issues: [],
    });
  });
});

describe("a working queue is not a condition", () => {
  const ORDINARY: Array<[string, HistoricalFillOperationalSnapshot]> = [
    ["C. pending work", ready({ pending: { total: 500 } })],
    ["D. claimable work", ready({ pending: { total: 12, claimableNow: 12 } })],
    ["E. a live lease", ready({ pending: { total: 3, activeLease: 3 } })],
    ["F. a backoff in progress", ready({ pending: { total: 4, inBackoff: 4 } })],
    ["G. a split tree", ready({ windows: { SPLIT: 9 } })],
    ["completed windows", ready({ windows: { COMPLETE: 900 } })],
    ["H. unattributed fills", ready({ ledger: { totalFills: 40, unattributedFills: 40 } })],
  ];

  for (const [label, snapshot] of ORDINARY) {
    it(`${label} alone stays NORMAL`, () => {
      expect(interpretHistoricalFillOperationalSnapshot(snapshot)).toEqual({
        state: "NORMAL",
        issues: [],
      });
    });
  }

  it("R. no queue size, however large, becomes a condition", () => {
    const huge = ready({
      pending: { total: 100_000, claimableNow: 99_000, activeLease: 500, inBackoff: 500 },
      windows: { PENDING: 100_000, COMPLETE: 1_000_000, SPLIT: 50_000 },
      ledger: { totalFills: 5_000_000, unattributedFills: 4_000_000 },
    });

    expect(interpretHistoricalFillOperationalSnapshot(huge).state).toBe("NORMAL");
  });

  it("Q. no timestamp influences the answer", () => {
    const withInstants = ready();
    if (withInstants.outcome !== "READY") throw new Error("unreachable");
    const aged: HistoricalFillOperationalSnapshot = {
      ...withInstants,
      capturedAt: new Date("2031-01-01T00:00:00.000Z"),
      pending: {
        ...withInstants.pending,
        // Ancient work, still not a condition: this system has no SLA that
        // would make an age meaningful.
        oldestPendingCreatedAt: new Date("1999-01-01T00:00:00.000Z"),
        oldestClaimableCreatedAt: new Date("1999-01-01T00:00:00.000Z"),
        nextBackoffEligibleAt: new Date("2099-01-01T00:00:00.000Z"),
      },
    };

    expect(interpretHistoricalFillOperationalSnapshot(aged)).toEqual(
      interpretHistoricalFillOperationalSnapshot(withInstants)
    );
  });
});

describe("the five conditions that do need a human", () => {
  const TRIGGERS: Array<[string, HistoricalFillOperationalSnapshot, string, number]> = [
    ["I. a stale lease", ready({ pending: { total: 1, staleLease: 1 } }), "STALE_LEASES_PRESENT", 1],
    [
      "J. a window at the attempt limit",
      ready({ pending: { total: 1, attemptExhausted: 1 } }),
      "ATTEMPT_EXHAUSTED_PRESENT",
      1,
    ],
    ["K. an abandoned window", ready({ windows: { ABANDONED: 1 } }), "ABANDONED_WINDOWS_PRESENT", 1],
    [
      "L. a window completed with skipped rows",
      ready({ windows: { INCOMPLETE_SKIPPED_ROWS: 1 } }),
      "INCOMPLETE_SKIPPED_ROWS_PRESENT",
      1,
    ],
    [
      "M. a single-millisecond saturation",
      ready({ windows: { SATURATED_SINGLE_MILLISECOND: 1 } }),
      "SATURATED_SINGLE_MILLISECOND_PRESENT",
      1,
    ],
  ];

  for (const [label, snapshot, code, count] of TRIGGERS) {
    it(`${label} raises exactly one condition`, () => {
      expect(interpretHistoricalFillOperationalSnapshot(snapshot)).toEqual({
        state: "NEEDS_ATTENTION",
        issues: [{ code, count }],
      });
    });
  }

  it("P. copies each count exactly, never capped or rounded", () => {
    const snapshot = ready({
      pending: { total: 9, staleLease: 7, attemptExhausted: 13 },
      windows: { ABANDONED: 101, INCOMPLETE_SKIPPED_ROWS: 2, SATURATED_SINGLE_MILLISECOND: 3 },
    });

    expect(interpretHistoricalFillOperationalSnapshot(snapshot).issues.map((i) => i.count)).toEqual([
      7, 13, 101, 2, 3,
    ]);
  });

  it("N+O. every condition is reported, in one deterministic order, at one level", () => {
    const snapshot = ready({
      pending: { total: 6, staleLease: 2, attemptExhausted: 1 },
      windows: { ABANDONED: 3, INCOMPLETE_SKIPPED_ROWS: 4, SATURATED_SINGLE_MILLISECOND: 5 },
    });

    const interpretation = interpretHistoricalFillOperationalSnapshot(snapshot);

    // Five conditions at once is still NEEDS_ATTENTION. There is no "worse".
    expect(interpretation.state).toBe("NEEDS_ATTENTION");
    expect(interpretation.issues).toEqual([
      { code: "STALE_LEASES_PRESENT", count: 2 },
      { code: "ATTEMPT_EXHAUSTED_PRESENT", count: 1 },
      { code: "ABANDONED_WINDOWS_PRESENT", count: 3 },
      { code: "INCOMPLETE_SKIPPED_ROWS_PRESENT", count: 4 },
      { code: "SATURATED_SINGLE_MILLISECOND_PRESENT", count: 5 },
    ]);
    // The declared order IS the reported order.
    expect(interpretation.issues.map((i) => i.code)).toEqual([...HISTORICAL_FILL_ISSUE_CODES]);
  });

  it("O. reports a subset in the same relative order", () => {
    const snapshot = ready({
      windows: { ABANDONED: 1, SATURATED_SINGLE_MILLISECOND: 1 },
      pending: { total: 1, attemptExhausted: 1 },
    });

    expect(
      interpretHistoricalFillOperationalSnapshot(snapshot).issues.map((i) => i.code)
    ).toEqual([
      "ATTEMPT_EXHAUSTED_PRESENT",
      "ABANDONED_WINDOWS_PRESENT",
      "SATURATED_SINGLE_MILLISECOND_PRESENT",
    ]);
  });

  it("stays NEEDS_ATTENTION when ordinary work sits alongside a condition", () => {
    const snapshot = ready({
      pending: { total: 400, claimableNow: 300, activeLease: 50, inBackoff: 49, staleLease: 1 },
      windows: { PENDING: 400, COMPLETE: 900, SPLIT: 30 },
      ledger: { totalFills: 1000, unattributedFills: 250 },
    });

    expect(interpretHistoricalFillOperationalSnapshot(snapshot)).toEqual({
      state: "NEEDS_ATTENTION",
      issues: [{ code: "STALE_LEASES_PRESENT", count: 1 }],
    });
  });

  it("is pure: the same snapshot always answers the same way", () => {
    const snapshot = ready({ pending: { total: 2, staleLease: 2 } });
    expect(interpretHistoricalFillOperationalSnapshot(snapshot)).toEqual(
      interpretHistoricalFillOperationalSnapshot(snapshot)
    );
  });
});
