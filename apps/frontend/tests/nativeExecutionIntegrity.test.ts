import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NATIVE_EXECUTION_INTEGRITY_STATUSES } from "@trading-alert-dashboard/shared";

import {
  NATIVE_EXECUTION_INTEGRITY_HEADING,
  NATIVE_INTEGRITY_GRANTS_NOTHING,
  presentNativeExecutionIntegrity,
} from "../src/features/plans/nativeExecutionIntegrity";

/**
 * Trading Control: each Native plan shows a small, read-only "Execution data
 * integrity" line. ELIGIBLE is green but says it grants nothing; everything
 * blocked is red; PENDING is blue; anything missing reads UNREADABLE — never
 * eligible. No new control. Pure + source checks.
 */

const src = (rel: string) => readFileSync(path.join(process.cwd(), "src", rel), "utf8").replace(/\r\n/g, "\n");

describe("Native execution data integrity on Trading Control", () => {
  it("each status has its operator label and tone", () => {
    const shown = Object.fromEntries(
      NATIVE_EXECUTION_INTEGRITY_STATUSES.map((status) => {
        const view = presentNativeExecutionIntegrity({ status, reason: "why", barOpenTime: null });
        return [status, `${view.label}|${view.tone}`];
      })
    );
    expect(shown).toEqual({
      PENDING_BAR_CLOSE: "PENDING BAR CLOSE|blue",
      ELIGIBLE: "ELIGIBLE|green",
      INELIGIBLE_REQUARANTINED: "BLOCKED — RE-QUARANTINED|red",
      INELIGIBLE_GAP: "BLOCKED — GAP|red",
      INELIGIBLE_DUPLICATE: "BLOCKED — DUPLICATE|red",
      INELIGIBLE_CHECKPOINT_MISMATCH: "BLOCKED — CHECKPOINT MISMATCH|red",
      INELIGIBLE_STALE_GENERATION: "BLOCKED — STALE GENERATION|red",
      UNREADABLE: "UNREADABLE|yellow",
    });
  });

  it("ELIGIBLE never reads as a permission: Native execution remains disabled", () => {
    const view = presentNativeExecutionIntegrity({ status: "ELIGIBLE", reason: "clean.", barOpenTime: null });
    expect(view.detail).toContain(NATIVE_INTEGRITY_GRANTS_NOTHING);
    expect(NATIVE_INTEGRITY_GRANTS_NOTHING).toMatch(/Native execution remains disabled/);
  });

  it("a missing or unknown status (an older backend, a bad payload) is UNREADABLE, never eligible", () => {
    for (const value of [null, undefined, { status: "eligible", reason: "x", barOpenTime: null }, { status: "WHATEVER", reason: "x", barOpenTime: null }]) {
      const view = presentNativeExecutionIntegrity(value as never);
      expect([view.label, view.tone]).toEqual(["UNREADABLE", "yellow"]);
    }
  });

  it("the card shows the line per plan, inside the read-only card, with no new control", () => {
    const card = src("components/operator/NativePlansCard.tsx");
    // UI Scalability V1: the per-plan line is in the expandable row; the table cell shows the same presenter's badge.
    const detail = src("components/operator/NativePlanDetail.tsx");
    expect(NATIVE_EXECUTION_INTEGRITY_HEADING).toBe("Execution data integrity");
    expect(detail).toContain("presentNativeExecutionIntegrity(item.executionIntegrity)");
    expect(detail).toContain('data-testid="native-execution-integrity"');
    expect(detail).toContain("{NATIVE_EXECUTION_INTEGRITY_HEADING}:");
    expect(src("features/plans/nativePlanTable.ts")).toContain("presentNativeExecutionIntegrity(item.executionIntegrity)");
    expect(card).toContain('<Badge tone="yellow">{NATIVE_PLANNING_ONLY_LABEL}</Badge>');
    expect(card).toContain("{NATIVE_EXECUTION_DISABLED_LABEL}");
    for (const file of [card, detail]) {
      expect(file).not.toMatch(/<Button|<button|onClick|onSubmit|<form|<select|<input/);
      expect(file).not.toMatch(/execute|adopt|apply|startAccount|accountControl|operatorApi|LIVE_READY/i);
    }
  });
});
