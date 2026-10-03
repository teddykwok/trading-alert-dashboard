import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { EDITABLE_POLICY_FIELDS } from "../src/api/operator";

/**
 * The Trading Policy editor.
 *
 * ## The distinction the panel exists to make visible
 *
 * "Capacity" used to hold observed counts and the limits governing them under
 * one heading. Those are different kinds of thing: open, pending, active,
 * reserved risk and reserved margin are COUNTED from execution rows and are
 * facts, while the limits are settings. The panel now separates them, and
 * these tests pin that no control was added on the facts side — there is no
 * endpoint behind one either.
 *
 * ## Review before apply
 *
 * Nothing saves on change, blur or Enter. Apply is unreachable until a review
 * has returned a non-empty diff, so a policy write is always something the
 * operator saw first.
 */

const FRONTEND = path.resolve(__dirname, "..");
const editor = readFileSync(
  path.join(FRONTEND, "src/components/operator/TradingPolicyEditor.tsx"),
  "utf8"
);
const card = readFileSync(
  path.join(FRONTEND, "src/components/operator/TradingControlCard.tsx"),
  "utf8"
);
const api = readFileSync(path.join(FRONTEND, "src/api/operator.ts"), "utf8");

/** Source with comments removed — the bans are about code, not about prose. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const editorCode = codeOf(editor);

// ---------------------------------------------------------------------------
// A-F. Current exposure is shown, and is read-only
// ---------------------------------------------------------------------------

describe("A-F. current exposure is separate and read-only", () => {
  it("A. renders exposure and limits under distinct headings", () => {
    expect(card).toContain('<Section title="Current Exposure">');
    expect(card).toContain('<Section title="Policy Limits">');
    expect(card.indexOf('title="Current Exposure"')).toBeLessThan(
      card.indexOf('title="Policy Limits"')
    );
  });

  it("B-F. every observed value is still a plain Row, with no input beside it", () => {
    // Bounded to the Current Exposure section itself: the Authorization
    // internals section now sits between it and Policy Limits, and sweeping
    // that in would make this assert about the wrong block.
    const exposureStart = card.indexOf('<Section title="Current Exposure">');
    const exposure = card.slice(exposureStart, card.indexOf("</Section>", exposureStart));
    // "Claims" is deliberately absent: it moved to its own Authorization
    // section, because it never measured trade progress.
    for (const label of ["Open", "Pending", "Active", "Risk", "Margin"]) {
      expect(exposure, label).toContain(`<Row label="${label}">`);
    }
    expect(exposure).not.toContain('<Row label="Claims">');
    // Facts are rendered, never edited: no field, no control, no handler.
    for (const forbidden of ["<input", "<select", "onChange", "Button"]) {
      expect(`exposure ${forbidden}:${exposure.includes(forbidden)}`).toBe(`exposure ${forbidden}:false`);
    }
  });

  it("P. no current-state name is editable anywhere in the editor", () => {
    for (const forbidden of [
      "currentOpen",
      "currentPending",
      "currentActive",
      "currentRisk",
      "currentMargin",
      "setOpen(0)",
    ]) {
      expect(`${forbidden}:${editorCode.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // The editor's whole field set is limits.
    expect([...EDITABLE_POLICY_FIELDS].every((field) => field.startsWith("max") || field.startsWith("soft"))).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// G-K. The draft flow
// ---------------------------------------------------------------------------

describe("G-K. edit, review, apply", () => {
  it("G. the editor opens a draft rather than editing in place", () => {
    expect(editorCode).toContain("const [open, setOpen] = useState(false)");
    expect(editorCode).toContain("Edit policy");
    expect(editorCode).toContain("const [draft, setDraft]");
  });

  it("H. inputs are seeded from the stored policy", () => {
    expect(editorCode).toContain("function draftFrom(read: PolicyReadDto)");
    expect(editorCode).toContain("read.fields?.[field]?.stored");
  });

  it("I. Cancel discards the draft and reopens from stored values", () => {
    const cancel = editorCode.slice(editorCode.indexOf("function cancel()"));
    expect(cancel).toContain("setDraft(draftFrom(read))");
    expect(cancel).toContain("setReview(null)");
    expect(cancel).toContain("setOpen(false)");
  });

  it("J. Review asks the server and shows current → proposed", () => {
    expect(editorCode).toContain("postValidatePolicy(account, changedValues(draft, read))");
    expect(editor).toContain("Review changes");
    expect(editor).toContain("{change.from}");
    expect(editor).toContain("{change.to}");
  });

  it("K. Apply writes once, with the version it loaded", () => {
    expect(editorCode).toContain("postSavePolicy(account, changedValues(draft, read), read.version)");
    expect(editorCode.match(/postSavePolicy\(/g) ?? []).toHaveLength(1);
  });

  it("K2. Apply is unreachable until a review has produced changes", () => {
    // The operator cannot write a draft they have not seen a diff for.
    expect(editor).toContain("disabled={busy || review === null || review.length === 0}");
  });

  it("L. success reloads the policy", () => {
    const apply = editorCode.slice(editorCode.indexOf("async function apply()"));
    expect(apply).toContain("await load()");
  });

  it("M. a server refusal is surfaced, not swallowed", () => {
    expect(editorCode).toContain("result.refusal ??");
    expect(editor).toContain('data-testid="policy-editor-error"');
    expect(editorCode).toContain("setSave(result)");
  });
});

// ---------------------------------------------------------------------------
// N-O. Gating and no auto-save
// ---------------------------------------------------------------------------

describe("N-O. gating and explicit saving", () => {
  it("N. editing is disabled when the server says it is not allowed", () => {
    // The server decides; the panel only reflects it. Gating in the browser is
    // presentation, and the endpoint refuses independently.
    expect(editor).toContain("disabled={!read.editable}");
    expect(editor).toContain('data-testid="policy-editor-blocked"');
    expect(editorCode).toContain("read.message");
  });

  it("O. no field auto-saves on change, blur or Enter", () => {
    for (const forbidden of ["onBlur", "onKeyDown", "onKeyUp", "onSubmit", "form onSubmit"]) {
      expect(`${forbidden}:${editorCode.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // The only thing a change does is edit local draft state.
    const onChange = editorCode.slice(editorCode.indexOf("onChange={"));
    expect(onChange).toContain("setDraft(");
    expect(onChange.slice(0, 400)).not.toContain("postSavePolicy");
  });

  it("only changed fields are sent, so an untouched limit is never rewritten", () => {
    const changed = editorCode.slice(editorCode.indexOf("function changedValues"));
    expect(changed).toContain('if (next === "" || next === stored) continue;');
  });
});

// ---------------------------------------------------------------------------
// The env ceiling is shown honestly
// ---------------------------------------------------------------------------

describe("the env ceiling is reported, not hidden", () => {
  it("shows the effective value and flags an env-capped limit", () => {
    // min(env, policy): raising a stored limit above its ceiling changes the
    // row and nothing else, so the panel must not present it as in force.
    expect(editorCode).toContain("view?.effective");
    expect(editorCode).toContain("view?.cappedByEnv");
    expect(editor).toContain("the environment caps this at");
  });

  it("the contract carries stored, effective and the ceiling", () => {
    const dto = api.slice(api.indexOf("export interface PolicyFieldDto"), api.indexOf("\n}", api.indexOf("export interface PolicyFieldDto")));
    for (const field of ["stored:", "effective:", "envCeiling:", "cappedByEnv:"]) {
      expect(dto, field).toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// Q-R. Nothing else moved
// ---------------------------------------------------------------------------

describe("Q-R. scope", () => {
  it("Q. the Session Trade Budget stays out of the POLICY EDITOR", () => {
    // This guard originally said "not added" — Phase 2 has since arrived, and
    // the card and API legitimately carry session UI now. What must remain
    // true is narrower and more durable: a session is a lifecycle window an
    // operator opens and closes, a policy limit is a standing rule, and the
    // EDITOR must not learn to set one from the other.
    for (const forbidden of [
      "sessionTradeBudget",
      "tradeBudget",
      "tradesRemaining",
      "Unlimited",
      "openedCount",
      "reservedCount",
    ]) {
      expect(`${forbidden}:${editorCode.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // And the editable set is still limits only.
    expect([...EDITABLE_POLICY_FIELDS]).not.toContain("tradeBudget" as never);
  });

  it("Q2. no daily loss limit UI was added", () => {
    for (const forbidden of ["dailyLoss", "Daily Loss", "pnlKillSwitch"]) {
      expect(`${forbidden}:${editorCode.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("R. Start Trading, Stop New Trades and Safe Off are untouched", () => {
    // The card drives every action through the shared action table and the
    // confirmation dialog, so those are the markers that prove the flow is
    // still wired — not per-handler names, which the card never spells out.
    for (const marker of [
      "TRADING_CONTROL_ACTIONS",
      "START_TRADING_DURATION_CHOICES",
      "setConfirming",
    ]) {
      expect(card, marker).toContain(marker);
    }
    // And the editor cannot reach any of it.
    for (const forbidden of [
      "TRADING_CONTROL_ACTIONS",
      "startTrading",
      "safeOff",
      "stopNewTrades",
      "killSwitch",
      "setConfirming",
    ]) {
      expect(`${forbidden}:${editorCode.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("the other operator editors still exist beside it", () => {
    for (const marker of ["AllowedSymbolsEditor", "SourceTimeframesEditor", "RrLookbackEditor"]) {
      expect(card, marker).toContain(marker);
    }
  });

  it("reuses the operator client, introducing no second auth path", () => {
    const policyApi = api.slice(api.indexOf("Execution policy LIMITS"));
    expect(policyApi.match(/operatorApiClient\./g) ?? []).toHaveLength(3);
    // Scanned on the CODE: the contract's doc comment legitimately calls the
    // version an "optimistic-lock token", which is a row number, not a
    // credential — and a raw-text scan would fail on that explanation.
    const policyCode = codeOf(policyApi);
    for (const forbidden of ["fetch(", "password", "token", "Bearer", "apiKey"]) {
      expect(`${forbidden}:${policyCode.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});
