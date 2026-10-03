import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  START_TRADING_BUDGET_CHOICES,
  START_TRADING_DURATION_CHOICES,
} from "../src/api/operator";
import {
  formatRemaining,
  formatSessionDuration,
  presentSessionProgress,
  presentSessionRemaining,
} from "../src/components/operator/TradingControlCard";

/**
 * Session trade budgets, in the operator's view.
 *
 * ## The distinction this UI exists to make
 *
 * "Opened 37 / 100" counts trades that ACTUALLY obtained exposure. The old
 * "Claims 5 / 5" counted admissions, and never gave one back when an entry
 * failed to fill — so it stood beside the exposure counts looking like trade
 * progress while measuring something else entirely. These tests pin that the
 * two are now separate and honestly labelled.
 *
 * ## Unlimited is the server's decision
 *
 * The panel renders a capability the server computed from the execution
 * profile AND the connector URL. It never infers that "paper" means unlimited
 * is safe, and a failure to read the capability HIDES the option rather than
 * offering it.
 */

const FRONTEND = path.resolve(__dirname, "..");
const card = readFileSync(
  path.join(FRONTEND, "src/components/operator/TradingControlCard.tsx"),
  "utf8"
);
const api = readFileSync(path.join(FRONTEND, "src/api/operator.ts"), "utf8");

const codeOf = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const cardCode = codeOf(card);

// ---------------------------------------------------------------------------
// A-D. The choices offered
// ---------------------------------------------------------------------------

describe("A-D. duration and budget choices", () => {
  it("A. offers 1h, 6h, 12h, 24h, 3d, 7d and 30d", () => {
    // TEST L. Every choice the panel renders, and the label it renders it as.
    // "43200" is a number an operator has to decode; "30 days" is the decision
    // they are making.
    expect([...START_TRADING_DURATION_CHOICES]).toEqual([60, 360, 720, 1440, 4320, 10080, 43200]);
    expect(START_TRADING_DURATION_CHOICES.map(formatSessionDuration)).toEqual([
      "1 hour",
      "6 hours",
      "12 hours",
      "24 hours",
      "3 days",
      "7 days",
      "30 days",
    ]);
  });

  it("A2. renders whole days as days and everything else honestly", () => {
    // 1440 keeps its long-standing label rather than becoming "1 day":
    // the preset row reads 1h / 6h / 12h / 24h / 3d / 7d / 30d.
    expect(formatSessionDuration(1440)).toBe("24 hours");
    expect(formatSessionDuration(2880)).toBe("2 days");
    expect(formatSessionDuration(43_200)).toBe("30 days");
    // Not a whole day, so it is NOT rounded into a lie.
    expect(formatSessionDuration(2000)).toBe("2000 min");
    expect(formatSessionDuration(1500)).toBe("25 hours");
  });

  it("B. offers 10 / 50 / 100 / 200 / 300", () => {
    expect([...START_TRADING_BUDGET_CHOICES]).toEqual([10, 50, 100, 200, 300]);
    expect(card).toContain("START_TRADING_BUDGET_CHOICES.map((count)");
  });

  it("C. offers a custom duration field beside the presets", () => {
    expect(card).toContain('aria-label="Custom duration in minutes"');
    expect(cardCode).toContain("setCustomDuration(event.target.value)");
    // A custom value wins over the preset when it parses.
    expect(cardCode).toContain("customDuration !== \"\" && Number.isFinite(parsedDuration)");
  });

  it("D. offers a custom budget field", () => {
    expect(card).toContain('aria-label="Custom trade budget"');
    expect(cardCode).toContain("customBudget !== \"\" && Number.isFinite(parsedBudget)");
  });

  it("a custom duration that is not whole hours is shown exactly, not rounded", () => {
    // Rounding 90 minutes to "2 hours" would be a small lie about a value the
    // operator typed.
    expect(formatSessionDuration(90)).toBe("90 min");
    expect(formatSessionDuration(45)).toBe("45 min");
    expect(formatSessionDuration(120)).toBe("2 hours");
  });
});

// ---------------------------------------------------------------------------
// E/F. Unlimited
// ---------------------------------------------------------------------------

describe("E/F. unlimited is server-driven", () => {
  it("E. is rendered only when the server permits it", () => {
    expect(cardCode).toContain("capability?.unlimitedPermitted ? (");
    // The panel asks the server; it computes nothing itself.
    expect(cardCode).toContain("fetchSessionCapability(account)");
    for (const forbidden of ["TESTNET", "MAINNET", "paper", "isPaper"]) {
      expect(`${forbidden}:${cardCode.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("F. a live environment cannot submit it, and is told why", () => {
    // No button is rendered at all, so there is nothing to click — and the
    // server's own sentence explains the refusal.
    expect(card).toContain('data-testid="unlimited-blocked"');
    expect(cardCode).toContain("capability && !capability.unlimitedPermitted");
    expect(cardCode).toContain("capability.reason");
  });

  it("a capability that could not be read HIDES unlimited rather than offering it", () => {
    // `setCapability(null)` on failure, and the render is guarded on
    // `capability?.unlimitedPermitted` — so an unreachable server fails closed.
    expect(cardCode).toContain("setCapability(null)");
    expect(cardCode).not.toContain("unlimitedPermitted ?? true");
  });

  it("unlimited sends no numeric budget", () => {
    // Sending both would leave the server to guess which the operator meant.
    expect(cardCode).toContain("unlimited ? undefined : resolvedBudget");
    expect(api).toContain("...(unlimited ? { unlimited: true } : tradeBudget !== undefined");
  });
});

// ---------------------------------------------------------------------------
// G-J. The review step
// ---------------------------------------------------------------------------

describe("G-J. review before starting", () => {
  it("G/H. shows the duration and the budget about to be sent", () => {
    const review = card.slice(card.indexOf('data-testid="start-review"'));
    expect(review).toContain("formatSessionDuration(resolvedDuration)");
    expect(review).toContain("opened trades");
    expect(review).toContain('unlimited ? "Unlimited"');
  });

  it("I/J. shows the standing policy it will run under", () => {
    const review = card.slice(card.indexOf('data-testid="start-review"'));
    expect(review).toContain("Max active");
    expect(review).toContain("context ? context.hardTotal");
    expect(review).toContain("Max risk");
    expect(review).toContain("context ? context.riskLimit");
  });

  it("the review displays policy, and never edits it", () => {
    // The Policy Editor owns those values and is SAFE-only. A second way to
    // change them from a dialog that runs while arming would be a bypass.
    const review = card.slice(
      card.indexOf('data-testid="start-review"'),
      card.indexOf("</dl>", card.indexOf('data-testid="start-review"'))
    );
    for (const forbidden of ["<input", "onChange", "postSavePolicy"]) {
      expect(`${forbidden}:${review.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

// ---------------------------------------------------------------------------
// K-P. The Session section
// ---------------------------------------------------------------------------

describe("K-P. the Session section", () => {
  it("K. is separate from Current Exposure, and comes before it", () => {
    expect(card).toContain('<Section title="Session">');
    expect(card).toContain('<Section title="Current Exposure">');
    expect(card.indexOf('title="Session"')).toBeLessThan(card.indexOf('title="Current Exposure"'));
  });

  it("L/M/N. shows opened, reserved and remaining", () => {
    const session = card.slice(
      card.indexOf('<Section title="Session">'),
      card.indexOf("</Section>", card.indexOf('<Section title="Session">'))
    );
    expect(session).toContain('<Row label="Opened">');
    expect(session).toContain('<Row label="Reserved">');
    expect(session).toContain('<Row label="Remaining">');
    expect(session).toContain("presentSessionProgress(status.session)");
    expect(session).toContain("status.session.reservedCount");
    expect(session).toContain("presentSessionRemaining(status.session)");
  });

  it("L2. opened reads as a fraction of the budget", () => {
    expect(presentSessionProgress({ openedCount: 37, tradeBudget: 100, unlimited: false })).toBe(
      "37 / 100"
    );
    expect(presentSessionProgress({ openedCount: 0, tradeBudget: 10, unlimited: false })).toBe(
      "0 / 10"
    );
  });

  it("O. unlimited shows a word, never a number it does not have", () => {
    // There is no denominator, so inventing one would be a lie.
    expect(presentSessionProgress({ openedCount: 37, tradeBudget: null, unlimited: true })).toBe("37");
    expect(presentSessionRemaining({ remaining: null, unlimited: true })).toBe("Unlimited");
    expect(presentSessionRemaining({ remaining: 61, unlimited: false })).toBe("61");
  });

  it("P. shows the session's own status and time remaining", () => {
    const session = card.slice(
      card.indexOf('<Section title="Session">'),
      card.indexOf("</Section>", card.indexOf('<Section title="Session">'))
    );
    // ACTIVE / EXHAUSTED / EXPIRED / REVOKED come from the server, derived at
    // read time, so a session that ran out while nothing watched still says so.
    expect(session).toContain("status.session.status");
    expect(session).toContain("formatRemaining(status.session.remainingTtlSeconds)");
  });

  it("P2. time remaining is human, and never negative", () => {
    expect(formatRemaining(63720)).toBe("17h 42m");
    expect(formatRemaining(600)).toBe("10m");
    expect(formatRemaining(0)).toBe("0m");
    expect(formatRemaining(-5)).toBe("0m");
    // TEST L, the long end. A 30-day countdown in `719h 42m` tells an operator
    // less than `29d 23h` does, so days take over once there are any.
    expect(formatRemaining(30 * 86_400)).toBe("30d 0h");
    expect(formatRemaining(30 * 86_400 - 60)).toBe("29d 23h");
    expect(formatRemaining(6 * 86_400 + 14 * 3600)).toBe("6d 14h");
    expect(formatRemaining(23 * 3600 + 42 * 60)).toBe("23h 42m");
  });

  it("the section is absent when no session has ever been started", () => {
    expect(cardCode).toContain("{status.session ? (");
  });
});

// ---------------------------------------------------------------------------
// Q-T. Nothing else moved
// ---------------------------------------------------------------------------

describe("Q-T. the rest of Trading Control", () => {
  it("Q. Claims no longer sits among the exposure counts", () => {
    const exposureStart = card.indexOf('<Section title="Current Exposure">');
    const exposure = card.slice(exposureStart, card.indexOf("</Section>", exposureStart));
    expect(exposure).not.toContain('<Row label="Claims">');

    // It survives as clearly-labelled authorization evidence, not as progress.
    expect(card).toContain('<Section title="Authorization (internal)">');
    expect(card).toContain('<Row label="Window claims">');
  });

  it("R. Current Exposure remains read-only", () => {
    const exposureStart = card.indexOf('<Section title="Current Exposure">');
    const exposure = card.slice(exposureStart, card.indexOf("</Section>", exposureStart));
    for (const forbidden of ["<input", "<select", "onChange", "Button"]) {
      expect(`${forbidden}:${exposure.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("S. the Policy Editor is still mounted and untouched", () => {
    expect(card).toContain('<Section title="Policy Limits">');
    expect(card).toContain("<TradingPolicyEditor account={account} />");
  });

  it("T. Start, Stop New Trades and Safe Off are all still wired", () => {
    for (const marker of ["TRADING_CONTROL_ACTIONS", "setConfirming", "runAction("]) {
      expect(card, marker).toContain(marker);
    }
    // The budget rides on the SAME confirmed action; no second control appeared.
    expect(cardCode).toContain(
      "onConfirm(typed, resolvedDuration, unlimited ? undefined : resolvedBudget, unlimited)"
    );
  });

  it("the confirmation phrase is still required before anything is sent", () => {
    expect(card).toContain("action.requiredPhrase");
    expect(cardCode).toContain("isConfirmationSatisfied(action, typed)");
  });
});
