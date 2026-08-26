import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { describeExecutionReason } from "../src/features/executions/executionReason";

/**
 * Why an alert did or did not become an execution.
 *
 * ## What was actually broken
 *
 * Alert Detail declared an "Execution" tab in WORKFLOW_TABS and imported
 * `AlertExecutionPanel`, but no `TabPanel id="execution"` ever rendered it.
 * Clicking Execution showed an empty area, so an alert with no execution looked
 * as though it had dropped out of the pipeline without explanation.
 *
 * ## What can honestly be shown
 *
 * Three of the no-execution answers are structural facts held in stored state:
 * a non-directional alert never gets a plan, a missing plan never reaches the
 * executor, and a plan that is PENDING/ERROR/INVALID says so itself.
 *
 * The fourth is a genuine limitation and must be stated as one. When a plan is
 * READY and the executor still refuses, that refusal is only LOGGED — it is
 * written to no table — so for a historical alert it cannot be recovered. These
 * tests pin that the UI says "reason unavailable" rather than reconstructing
 * something plausible from timestamps.
 */

const FRONTEND = path.resolve(__dirname, "..");
const panel = readFileSync(path.join(FRONTEND, "src/features/executions/AlertExecutionPanel.tsx"), "utf8");
const page = readFileSync(path.join(FRONTEND, "src/pages/AlertDetailPage.tsx"), "utf8");

// ---------------------------------------------------------------------------
// The tab that rendered nothing
// ---------------------------------------------------------------------------

describe("the Execution tab actually renders", () => {
  it("declares the tab AND mounts a panel for it", () => {
    // The declaration always existed; the panel did not.
    expect(page).toContain('{ id: "execution", label: "Execution" }');
    expect(page).toContain('<TabPanel id="execution" activeId={activeTab}>');
    expect(page).toContain("<AlertExecutionPanel alert={alert} />");
  });

  it("every declared workflow tab has a panel", () => {
    // The defect in one sentence: a tab id with no matching TabPanel is a
    // clickable label that shows nothing.
    const declared = [...page.matchAll(/\{ id: "([a-z]+)", label:/g)].map((m) => m[1]);
    const mounted = [...page.matchAll(/<TabPanel id="([a-z]+)"/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    for (const id of declared) {
      expect(mounted, `tab "${id}" has no TabPanel`).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// A/B/C. An execution exists
// ---------------------------------------------------------------------------

describe("when an execution exists", () => {
  it("A. a healthy execution shows no misleading reason", () => {
    // ENTRY_PENDING carries ENTRY_RECONCILED, which means the order is resting
    // exactly as intended.
    expect(
      describeExecutionReason({
        status: "ENTRY_PENDING",
        reasonCode: "ENTRY_RECONCILED",
        symbol: "VELVETUSDT",
        direction: "SHORT",
      })
    ).toBeNull();
    expect(panel).toContain('if (!reason) return <span className="text-slate-500">—</span>;');
  });

  it("B. a SKIPPED execution shows the shared friendly reason", () => {
    expect(
      describeExecutionReason({
        status: "SKIPPED",
        reasonCode: "SYMBOL_NOT_ALLOWED",
        symbol: "VELVETUSDT",
        direction: "SHORT",
      })
    ).toBe("VELVETUSDT is not in the symbol allowlist");
  });

  it("C. a terminal execution still resolves through the same vocabulary", () => {
    expect(
      describeExecutionReason({ status: "FAILED", reasonCode: "ENTRY_SUBMISSION_REJECTED", symbol: "BLUAIUSDT" })
    ).toBe("Binance rejected the entry order");
  });

  it("F. an unknown future code degrades safely", () => {
    expect(
      describeExecutionReason({ status: "SKIPPED", reasonCode: "SOME_FUTURE_CODE", symbol: "BLUAIUSDT" })
    ).toBe("Some future code");
  });

  it("R. reuses the shared helper rather than a second dictionary", () => {
    expect(panel).toContain('from "./executionReason"');
    expect(panel).toContain("describeExecutionReason({");
    // No local switch over reason codes.
    expect(panel).not.toContain('case "SYMBOL_NOT_ALLOWED"');
    expect(panel).not.toContain('case "ALERT_STALE"');
  });

  it("G. links to the execution by id", () => {
    expect(panel).toContain("to={`/executions/${execution.id}`}");
  });

  it("keeps the raw reason code inspectable", () => {
    expect(panel).toContain("title={execution.decisionReasonCode ?? undefined}");
  });
});

// ---------------------------------------------------------------------------
// D/E/J. No execution
// ---------------------------------------------------------------------------

describe("when no execution exists", () => {
  it("D. reads the persisted plan rather than guessing", () => {
    // The plan is the one pre-execution artefact this system stores.
    expect(panel).toContain("extremeRRApi.getForAlert(alertId)");
    expect(panel).toContain("plan.status === \"ERROR\" || plan.status === \"INVALID\"");
    expect(panel).toContain("plan.errorReason");
  });

  it("D2. states the structural cases as facts", () => {
    expect(panel).toContain("This alert is not directional, so no trade plan is generated for it.");
    expect(panel).toContain("No Extreme RR plan was generated, so nothing reached execution.");
    expect(panel).toContain("The Extreme RR plan is still being generated.");
  });

  it("E. says the reason is UNAVAILABLE when nothing was persisted", () => {
    // The executor's refusal is only logged. Reconstructing it from timestamps
    // would look authoritative and could easily be wrong.
    expect(panel).toContain(
      "Reason unavailable — the plan was READY but no pre-execution decision is persisted for this alert."
    );
  });

  it("never infers a reason from status, symbol or timing", () => {
    for (const forbidden of ["new Date(", "Date.now(", "triggeredAt >", "createdAt >", "ALERT_STALE"]) {
      expect(`panel ${forbidden}:${panel.includes(forbidden)}`).toBe(`panel ${forbidden}:false`);
    }
  });

  it("J. does not present duplicate suppression as a no-execution reason", () => {
    // A suppressed delivery never creates its own alert row — it bumps an
    // existing alert's counter — so an alert you can open was NOT suppressed.
    // Offering "duplicate" here would be wrong for every alert that can reach
    // this panel.
    expect(panel).not.toContain("duplicateCount");
    expect(panel).not.toMatch(/duplicate/i);
  });
});

// ---------------------------------------------------------------------------
// H/K. Nothing else moved
// ---------------------------------------------------------------------------

describe("H/K. the rest of Alert Detail is untouched", () => {
  it("keeps the existing panels and timestamps", () => {
    for (const marker of ["<ExtremeRRPlanner alert={alert} />", "TradeOutcomePanel", "TradeJournalPanel", "AiOpinionPanel"]) {
      expect(page, marker).toContain(marker);
    }
  });

  it("changes no freshness or policy logic", () => {
    for (const forbidden of ["alertAgeLimitSeconds", "DUPLICATE_SUPPRESSION", "formatAlertAgeLimit"]) {
      expect(`page ${forbidden}:${page.includes(forbidden)}`).toBe(`page ${forbidden}:false`);
      expect(`panel ${forbidden}:${panel.includes(forbidden)}`).toBe(`panel ${forbidden}:false`);
    }
  });

  it("the panel remains read-only — it creates nothing", () => {
    for (const forbidden of [".post(", ".patch(", ".delete(", "generate("]) {
      expect(`panel ${forbidden}:${panel.includes(forbidden)}`).toBe(`panel ${forbidden}:false`);
    }
  });
});
