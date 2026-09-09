import { describe, expect, it } from "vitest";

import * as planner from "../src/modules/binance/user-trades-window-planner";
import {
  planUserTradesWindow,
  USER_TRADES_MAX_LIMIT,
  USER_TRADES_MAX_WINDOW_MS,
  type UserTradesWindow,
} from "../src/modules/binance/user-trades-window-planner";

/**
 * The doctrine these tests exist to hold in place.
 *
 * A time-windowed read can return a full page without saying so, and the
 * obvious continuation -- resume at the last returned trade's timestamp plus
 * one -- loses every other fill sharing that millisecond, silently, because
 * Binance documents no ordering that would let a caller notice. So the planner
 * decides on cardinality alone and never terminates on a saturated window.
 */

const window = (startTimeMs: number, endTimeMs: number): UserTradesWindow => ({ startTimeMs, endTimeMs });

const plan = (w: UserTradesWindow, returnedRowCount: number, limit = USER_TRADES_MAX_LIMIT) =>
  planUserTradesWindow({ window: w, limit, returnedRowCount });

/**
 * Child windows, obtained the ONLY way production can obtain them: by planning
 * a saturated observation. There is no exported splitter to call, so every
 * partition assertion below has already passed bound, limit and row-count
 * validation to get here.
 */
function childrenOf(w: UserTradesWindow) {
  const decision = plan(w, USER_TRADES_MAX_LIMIT);
  return decision.kind === "SPLIT" ? { left: decision.left, right: decision.right } : null;
}

describe("a page short of its limit was not truncated", () => {
  it("A. an empty page completes the window", () => {
    expect(plan(window(1000, 2000), 0)).toEqual({ kind: "COMPLETE", window: window(1000, 2000) });
  });

  it("B. one row short of the limit completes the window", () => {
    expect(plan(window(1000, 2000), 999).kind).toBe("COMPLETE");
  });

  it("Q. a zero timestamp is a real bound, not an absent one", () => {
    expect(plan(window(0, 0), 0).kind).toBe("COMPLETE");
    expect(plan(window(0, 10), 5).kind).toBe("COMPLETE");
  });

  it("completeness is measured against the REQUESTED limit, not a constant", () => {
    // A caller that asked for 10 and got 10 is saturated, even though 10 is
    // nowhere near the endpoint maximum.
    expect(plan(window(1000, 2000), 10, 10).kind).toBe("SPLIT");
    expect(plan(window(1000, 2000), 9, 10).kind).toBe("COMPLETE");
  });
});

describe("a saturated window is asked again, smaller", () => {
  it("C. a full page splits rather than completing", () => {
    const decision = plan(window(1000, 2000), 1000);
    expect(decision.kind).toBe("SPLIT");
  });

  it("D/E. odd and even spans both split into abutting halves", () => {
    // Even span: [10,13] has 4 ms.
    const even = childrenOf(window(10, 13));
    expect(even).toEqual({ left: window(10, 11), right: window(12, 13) });

    // Odd span: [10,14] has 5 ms, so one child is larger by one.
    const odd = childrenOf(window(10, 14));
    expect(odd).toEqual({ left: window(10, 12), right: window(13, 14) });
  });

  it("F. a two-millisecond window splits into two single milliseconds", () => {
    expect(childrenOf(window(10, 11))).toEqual({
      left: window(10, 10),
      right: window(11, 11),
    });
  });

  it("R. the midpoint stays exact near the safe-integer ceiling", () => {
    // start + floor((end - start) / 2) never sums two large timestamps, so no
    // intermediate exceeds MAX_SAFE_INTEGER even at the very top of the range.
    const end = Number.MAX_SAFE_INTEGER;
    const start = end - 10;
    const halves = childrenOf(window(start, end))!;

    expect(Number.isSafeInteger(halves.left.endTimeMs)).toBe(true);
    expect(halves.left.endTimeMs).toBe(start + 5);
    expect(halves.right.startTimeMs).toBe(start + 6);
    expect(halves.right.endTimeMs).toBe(end);
    // The naive midpoint would have overflowed into an imprecise double.
    expect(Number.isSafeInteger(start + end)).toBe(false);
  });

  it("a single millisecond yields no children, and an inverted window none either", () => {
    // Through the planner these are not merely "null" -- they are two
    // DIFFERENT answers, which is strictly more than the private splitter
    // could say: one is an unprovable window, the other a caller bug.
    expect(childrenOf(window(10, 10))).toBeNull();
    expect(plan(window(10, 10), USER_TRADES_MAX_LIMIT).kind).toBe("SATURATED_SINGLE_MILLISECOND");

    expect(childrenOf(window(11, 10))).toBeNull();
    expect(plan(window(11, 10), USER_TRADES_MAX_LIMIT).kind).toBe("REFUSED");
  });
});

describe("H/W. one saturated millisecond is never called complete", () => {
  it("G. a single-millisecond window short of the limit still completes", () => {
    expect(plan(window(10, 10), 999).kind).toBe("COMPLETE");
  });

  it("H. a single-millisecond window at the limit is SATURATED, not COMPLETE", () => {
    // The load-bearing case. There is no smaller window to ask for, so
    // exhaustion cannot be proven -- and saying otherwise would lose fills
    // exactly where they are most concentrated.
    const decision = plan(window(10, 10), 1000);

    expect(decision.kind).toBe("SATURATED_SINGLE_MILLISECOND");
    expect(decision.kind).not.toBe("COMPLETE");
    if (decision.kind !== "SATURATED_SINGLE_MILLISECOND") return;
    expect(decision.window).toEqual(window(10, 10));
  });

  it("the planner never advances past a saturated timestamp", () => {
    // 1000 fills all at 5000 ms. Nothing in the result mentions 5001.
    const decision = plan(window(5000, 5000), 1000);

    expect(decision.kind).toBe("SATURATED_SINGLE_MILLISECOND");
    expect(JSON.stringify(decision)).not.toContain("5001");
  });
});

describe("an impossible observation is refused, not interpreted", () => {
  const refusals: ReadonlyArray<[string, UserTradesWindow, number, number, string]> = [
    ["I. more rows than the limit", window(0, 10), 1001, 1000, "ROW_COUNT_EXCEEDS_LIMIT"],
    ["J. a negative row count", window(0, 10), -1, 1000, "ROW_COUNT_INVALID"],
    ["a fractional row count", window(0, 10), 1.5, 1000, "ROW_COUNT_INVALID"],
    ["K. a zero limit", window(0, 10), 0, 0, "LIMIT_OUT_OF_RANGE"],
    ["L. a limit above the maximum", window(0, 10), 0, 1001, "LIMIT_OUT_OF_RANGE"],
    ["M. a fractional limit", window(0, 10), 0, 10.5, "LIMIT_OUT_OF_RANGE"],
    ["N. a NaN bound", window(Number.NaN, 10), 0, 1000, "WINDOW_BOUND_NOT_INTEGER"],
    ["N. an infinite bound", window(0, Number.POSITIVE_INFINITY), 0, 1000, "WINDOW_BOUND_NOT_INTEGER"],
    ["N. a fractional bound", window(0, 10.5), 0, 1000, "WINDOW_BOUND_NOT_INTEGER"],
    ["O. a negative bound", window(-1, 10), 0, 1000, "WINDOW_BOUND_NEGATIVE"],
    ["P. an inverted window", window(20, 10), 0, 1000, "WINDOW_INVERTED"],
    [
      "S. a window longer than seven days",
      window(0, USER_TRADES_MAX_WINDOW_MS + 1),
      0,
      1000,
      "WINDOW_TOO_LONG",
    ],
  ];

  it.each(refusals)("%s is refused", (_label, w, rows, limit, reasonCode) => {
    const decision = plan(w, rows, limit);

    expect(decision.kind).toBe("REFUSED");
    if (decision.kind !== "REFUSED") return;
    expect(decision.reasonCode).toBe(reasonCode);
  });

  it("T. a window of exactly seven days is accepted", () => {
    expect(plan(window(0, USER_TRADES_MAX_WINDOW_MS), 0).kind).toBe("COMPLETE");
    expect(plan(window(0, USER_TRADES_MAX_WINDOW_MS), 1000).kind).toBe("SPLIT");
  });

  it("a saturated page with an impossible count is refused, not split", () => {
    // The refusal must win: turning a broken observation into ordinary work
    // would hide the caller's bug behind plausible-looking splitting.
    expect(plan(window(0, 10), 2000, 1000).kind).toBe("REFUSED");
  });
});

describe("U/V. splitting partitions the window exactly", () => {
  /** Every millisecond of an inclusive window. */
  const millisecondsOf = (w: UserTradesWindow) =>
    Array.from({ length: w.endTimeMs - w.startTimeMs + 1 }, (_, index) => w.startTimeMs + index);

  it("U. children cover every millisecond of a small parent exactly once", () => {
    for (let end = 1; end <= 40; end += 1) {
      const parent = window(7, 7 + end);
      const halves = childrenOf(parent)!;
      const covered = [...millisecondsOf(halves.left), ...millisecondsOf(halves.right)];

      expect(covered).toEqual(millisecondsOf(parent));
      expect(new Set(covered).size).toBe(covered.length);
    }
  });

  it("every split holds the boundary invariants", () => {
    // Deterministic sweep rather than random input: the property must hold for
    // every shape, and a flaky generator would make a failure hard to reproduce.
    for (let start = 0; start <= 12; start += 1) {
      for (let span = 1; span <= 60; span += 1) {
        const parent = window(start, start + span);
        const { left, right } = childrenOf(parent)!;

        expect(left.startTimeMs).toBe(parent.startTimeMs);
        expect(right.endTimeMs).toBe(parent.endTimeMs);
        // Abutting: no gap, no overlap.
        expect(left.endTimeMs + 1).toBe(right.startTimeMs);
        // Non-empty.
        expect(left.startTimeMs).toBeLessThanOrEqual(left.endTimeMs);
        expect(right.startTimeMs).toBeLessThanOrEqual(right.endTimeMs);
        // Strictly smaller, which is what guarantees termination.
        const spanOf = (w: UserTradesWindow) => w.endTimeMs - w.startTimeMs;
        expect(spanOf(left)).toBeLessThan(spanOf(parent));
        expect(spanOf(right)).toBeLessThan(spanOf(parent));
      }
    }
  });

  it("V. repeated EXTERNAL splitting reaches single milliseconds without internal recursion", () => {
    // The caller drives the tree; one invocation returns one decision. This
    // walks it by hand to prove the planner terminates without ever having
    // expanded the descendants itself.
    const parent = window(1000, 1000 + 255);
    let frontier: UserTradesWindow[] = [parent];
    const leaves: UserTradesWindow[] = [];
    let rounds = 0;

    while (frontier.length > 0) {
      rounds += 1;
      expect(rounds).toBeLessThanOrEqual(64); // termination, not a hang
      const next: UserTradesWindow[] = [];
      for (const current of frontier) {
        const decision = plan(current, 1000);
        if (decision.kind === "SPLIT") {
          next.push(decision.left, decision.right);
          continue;
        }
        expect(decision.kind).toBe("SATURATED_SINGLE_MILLISECOND");
        leaves.push(current);
      }
      frontier = next;
    }

    // 256 milliseconds, every one reached exactly once, all single-ms.
    expect(leaves).toHaveLength(256);
    expect(new Set(leaves.map((w) => w.startTimeMs)).size).toBe(256);
    expect(leaves.every((w) => w.startTimeMs === w.endTimeMs)).toBe(true);
    // log2(256) + 1 rounds: halving, not linear scanning.
    expect(rounds).toBe(9);
  });

  it("M/N. one invocation returns at most two children and no deeper tree", () => {
    const decision = plan(window(0, 1000), 1000);

    expect(decision.kind).toBe("SPLIT");
    if (decision.kind !== "SPLIT") return;
    // Exactly the parent plus two children; nothing enumerated beneath them.
    expect(Object.keys(decision).sort()).toEqual(["kind", "left", "right", "window"]);
  });
});

describe("the public surface is the planner, and only the planner", () => {
  it("exports no splitter, so children come only from a validated saturation", () => {
    // Splitting is a CONSEQUENCE of a checked, saturated observation. Exposed
    // as its own function it was a way around that contract: it validated only
    // start >= end, so NaN bounds sailed through and a window longer than
    // seven days split happily even though the planner refuses it.
    const exported = Object.keys(planner).sort();

    expect(exported).not.toContain("splitUserTradesWindow");
    expect(exported).toEqual([
      "USER_TRADES_MAX_LIMIT",
      "USER_TRADES_MAX_WINDOW_MS",
      "USER_TRADES_WINDOW_REFUSALS",
      "planUserTradesWindow",
    ]);
  });

  it("the refused shapes cannot be split by any exported route", () => {
    // The bypasses the private splitter would have allowed, now unreachable:
    // each is refused, and a refusal carries no children.
    for (const w of [
      window(Number.NaN, 10),
      window(-1, 10),
      window(0, USER_TRADES_MAX_WINDOW_MS + 1),
    ]) {
      const decision = plan(w, USER_TRADES_MAX_LIMIT);
      expect(decision.kind).toBe("REFUSED");
      expect(decision).not.toHaveProperty("left");
      expect(decision).not.toHaveProperty("right");
    }
  });

  it("the endpoint maximums stay pinned at their documented values", () => {
    // The wrapper keeps its own private copy of the page maximum for argument
    // validation. Both are pinned to 1000 here and there so a change to either
    // is visible; hoisting one shared constant is a follow-up for whichever
    // slice legitimately touches both.
    expect(USER_TRADES_MAX_LIMIT).toBe(1000);
    expect(USER_TRADES_MAX_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
