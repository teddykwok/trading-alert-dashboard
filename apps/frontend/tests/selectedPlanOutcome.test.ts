import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { describeExecutionReason } from "../src/features/executions/executionReason";

/**
 * Showing WHY a READY plan produced no execution.
 *
 * ## What changed
 *
 * The executor's refusals were previously log-only, so Alert Detail could only
 * say "Reason unavailable" for a plan that was READY and produced nothing. The
 * backend now records that verdict when it happens, and the panel reads it.
 *
 * ## The two properties that matter most
 *
 * HISTORICAL, NOT INFERRED. The panel renders the stored reason and the stored
 * evaluation time. It must never consult current authorization, capacity or
 * positions — a plan refused at 12:00 for want of authorization still says so
 * at 15:00 when an authorization exists again.
 *
 * NOT EXECUTED, NOT FAILED. Every one of these refusals happens before any
 * order is built, so the wording must never suggest Binance saw anything.
 */

const FRONTEND = path.resolve(__dirname, "..");
const panel = readFileSync(path.join(FRONTEND, "src/features/executions/AlertExecutionPanel.tsx"), "utf8");
const vocabulary = readFileSync(
  path.join(FRONTEND, "src/features/executions/executionReason.ts"),
  "utf8"
);

const SKIP_REASONS = [
  "PLAN_NOT_READY",
  "NO_SELECTED_CANDIDATE",
  "CANDIDATE_INCOMPLETE",
  "MARGIN_PLAN_NOT_READY",
  "PROFILE_UNAVAILABLE",
  "CANARY_AUTHORIZATION_REQUIRED",
  "CANARY_AUTHORIZATION_WRONG_SYMBOL",
  "CANARY_AUTHORIZATION_WRONG_DIRECTION",
  "CANARY_AUTHORIZATION_ALREADY_CONSUMED",
] as const;

// ---------------------------------------------------------------------------
// H. One vocabulary, extended — not a second one
// ---------------------------------------------------------------------------

describe("H. the shared reason vocabulary covers the executor's refusals", () => {
  it("gives every skip reason its own sentence", () => {
    for (const reasonCode of SKIP_REASONS) {
      const reason = describeExecutionReason({
        status: "SKIPPED",
        reasonCode,
        symbol: "MTLUSDT",
        direction: "LONG",
      });
      expect(reason, reasonCode).toBeTruthy();
      // Never the raw code echoed back as if it were prose.
      expect(reason, reasonCode).not.toBe(reasonCode);
    }
  });

  it("the sentences are distinct, so two refusals never read the same", () => {
    const sentences = SKIP_REASONS.map((reasonCode) =>
      describeExecutionReason({ status: "SKIPPED", reasonCode, symbol: "MTLUSDT", direction: "LONG" })
    );
    expect(new Set(sentences).size).toBe(SKIP_REASONS.length);
  });

  it("lives in the existing dictionary rather than a new one", () => {
    // A second mapping would drift, and the same code would then read two ways
    // on two screens.
    for (const reasonCode of SKIP_REASONS) {
      expect(vocabulary, reasonCode).toContain(`case "${reasonCode}":`);
    }
    expect(panel).toContain('from "./executionReason"');
    // The panel maps no codes itself.
    expect(panel).not.toContain('case "CANARY_AUTHORIZATION_REQUIRED"');
    expect(panel).not.toContain('case "MARGIN_PLAN_NOT_READY"');
  });
});

// ---------------------------------------------------------------------------
// G. Wording must not imply an order was ever sent
// ---------------------------------------------------------------------------

describe("G. a pre-execution refusal never reads as an exchange failure", () => {
  it("no skip sentence claims a rejection, submission or fill", () => {
    for (const reasonCode of SKIP_REASONS) {
      const reason =
        describeExecutionReason({ status: "SKIPPED", reasonCode, symbol: "MTLUSDT", direction: "LONG" }) ?? "";
      for (const forbidden of ["Binance", "rejected", "submitted", "filled", "order was"]) {
        expect(`${reasonCode}/${forbidden}:${reason.includes(forbidden)}`).toBe(
          `${reasonCode}/${forbidden}:false`
        );
      }
    }
  });

  it("the empty state says 'Not executed', not 'failed'", () => {
    expect(panel).toContain('<h2 className="text-sm font-semibold text-slate-200">Not executed</h2>');
    expect(panel).toContain("no order was ever sent to the exchange");
    expect(panel).not.toContain("Execution failed");
  });

  it("the authorization wording is time-bound, not present-tense", () => {
    // "Nothing authorizes this signal" would read as a claim about NOW.
    expect(
      describeExecutionReason({
        status: "SKIPPED",
        reasonCode: "CANARY_AUTHORIZATION_REQUIRED",
        symbol: "MTLUSDT",
        direction: "LONG",
      })
    ).toBe("Nothing authorized this signal at evaluation time");
  });
});

// ---------------------------------------------------------------------------
// A/B. READY + no execution
// ---------------------------------------------------------------------------

describe("A/B. a READY plan with no execution", () => {
  it("A. renders the persisted refusal when one exists", () => {
    expect(panel).toContain("const outcome = plan.executionOutcome;");
    expect(panel).toContain("if (outcome && !outcome.handled) {");
    expect(panel).toContain("reasonCode: outcome.reasonCode,");
    // Falls back to the executor's own sentence if the code is one this build
    // has never seen, rather than rendering nothing.
    expect(panel).toContain("?? outcome.message");
  });

  it("A2. shows WHEN the decision was taken", () => {
    // The evaluation time is the difference between "this is why" and "this is
    // why, and here is when it was true".
    expect(panel).toContain("outcome.evaluatedAt");
    expect(panel).toContain("evaluated ");
  });

  it("A3. keeps the canonical code reachable on hover", () => {
    expect(panel).toContain("title={outcome.reasonCode ?? undefined}");
  });

  it("B. still says Reason unavailable when nothing was recorded", () => {
    expect(panel).toContain(
      "Reason unavailable — the plan was READY but no pre-execution decision is persisted for this alert."
    );
  });
});

// ---------------------------------------------------------------------------
// C. Execution precedence
// ---------------------------------------------------------------------------

describe("C. a real execution stays authoritative", () => {
  it("the persisted outcome is only consulted when there is no execution", () => {
    // `describeMissingExecution` is reached only from the !execution branch, so
    // a live execution's own status and reason always win.
    // Sliced FORWARD from the branch: an earlier loading/error card closes a
    // </Card> before this point, so bounding on the first one yields nothing.
    const branchAt = panel.indexOf("if (!execution) {");
    const emptyState = panel.slice(branchAt, panel.indexOf("</Card>", branchAt));
    expect(emptyState).toContain("describeMissingExecution(alert, plan)");

    const helper = panel.slice(panel.indexOf("function describeMissingExecution"));
    expect(helper).toContain("plan.executionOutcome");
    // The helper never reads the execution — it cannot, there is none.
    expect(helper).not.toContain("execution.status");
  });

  it("a handled outcome is not rendered as a refusal", () => {
    // Only `!outcome.handled` renders. A handled row means an execution exists
    // and that execution is what the panel shows.
    expect(panel).toContain("if (outcome && !outcome.handled) {");
  });
});

// ---------------------------------------------------------------------------
// D/E/F. Everything else is unchanged
// ---------------------------------------------------------------------------

describe("D/E/F. the other empty-state answers are untouched", () => {
  it("D. non-directional alerts read exactly as before", () => {
    expect(panel).toContain("This alert is not directional, so no trade plan is generated for it.");
  });

  it("E. a missing plan reads exactly as before", () => {
    expect(panel).toContain("No Extreme RR plan was generated, so nothing reached execution.");
  });

  it("F. a non-READY plan still explains itself through plan status", () => {
    expect(panel).toContain("The Extreme RR plan is still being generated.");
    expect(panel).toContain('plan.status === "ERROR" || plan.status === "INVALID"');
    expect(panel).toContain("plan.errorReason");
  });

  it("the branch order is preserved, so the new case is genuinely last", () => {
    const helper = panel.slice(panel.indexOf("function describeMissingExecution"));
    const order = [
      "not directional",
      "No Extreme RR plan was generated",
      'plan.status === "PENDING"',
      'plan.status === "ERROR"',
      "plan.executionOutcome",
      "Reason unavailable",
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = helper.indexOf(marker);
      expect(at, marker).toBeGreaterThan(cursor);
      cursor = at;
    }
  });
});

// ---------------------------------------------------------------------------
// The historical-truth guarantee
// ---------------------------------------------------------------------------

describe("the panel never infers a reason from current state", () => {
  it("reads only the persisted outcome, never live trading state", () => {
    const helper = panel.slice(panel.indexOf("function describeMissingExecution"));
    for (const forbidden of [
      "Date.now(",
      "authorization",
      "capacity",
      "maxClaims",
      "positions",
      "riskUsd",
      "tradingControl",
      "fetch(",
    ]) {
      expect(`${forbidden}:${helper.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("the panel adds no new network call for this feature", () => {
    // It already loaded the plan; the outcome rides along on that payload.
    expect(panel).toContain("extremeRRApi.getForAlert(alertId)");
    expect(panel.match(/extremeRRApi\./g) ?? []).toHaveLength(1);
    expect(panel).not.toContain("outcomeApi");
  });

  it("the panel remains read-only", () => {
    for (const forbidden of [".post(", ".patch(", ".delete("]) {
      expect(`${forbidden}:${panel.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});
