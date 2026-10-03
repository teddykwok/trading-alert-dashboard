import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HISTORICAL_FILL_OPERATIONS_PATH,
  type HistoricalFillInterpretationDto,
  type HistoricalFillOperationalIssueCode,
  type HistoricalFillOperationalState,
  type HistoricalFillOperationsDto,
  type HistoricalFillProfileReason,
} from "../src/api/operator";
import { HISTORICAL_FILL_OPERATIONS_POLL_MS } from "../src/hooks/useHistoricalFillOperations";
import {
  HISTORICAL_FILL_ISSUE_WORDING,
  HISTORICAL_FILL_STATE_WORDING,
  NOT_AVAILABLE,
  PROFILE_REASON_WORDING,
  describeOperationalState,
  describeProfileReason,
  exactInstant,
  formatOptionalInstant,
  presentHistoricalFillOperations,
  presentInterpretationIssues,
  toneForOperationalState,
} from "../src/features/operator/historicalFillOperationsPresentation";
import {
  HISTORICAL_FILL_ESCALATION,
  HISTORICAL_FILL_EVIDENCE_NOTE,
  HISTORICAL_FILL_ISSUE_RUNBOOK,
  HISTORICAL_FILL_NORMAL_GUIDANCE,
  HISTORICAL_FILL_PROFILE_RUNBOOK,
  presentIssueRunbook,
  profileReasonCheck,
} from "../src/features/operator/historicalFillRunbook";

/**
 * The historical-fill operator panel.
 *
 * This repository has no DOM test environment, so — exactly as
 * `tradingControlPage` and `executionPresentation` already do — the panel is
 * proven in two halves: every display decision lives in a pure module and is
 * asserted directly, and the wiring that a render would otherwise show is
 * asserted from the source of the component, the hook and the client.
 *
 * That split is not a workaround here, it is the reason the panel is built this
 * way: what an operator is told about durable fill state is a fact worth
 * pinning, and a JSX snapshot would prove far less.
 */

const src = (relative: string) => readFileSync(path.join(process.cwd(), "src", relative), "utf8");

/**
 * Source with comments removed.
 *
 * These modules document what they deliberately do NOT do, so a raw text search
 * finds the promise rather than a breach of it. Mirrors the backend's own
 * structural suites, which strip comments for the same reason.
 */
const codeOf = (relative: string) =>
  src(relative)
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");

const CLIENT = src("api/operator.ts");
const HOOK = src("hooks/useHistoricalFillOperations.ts");
const CARD = src("components/operator/HistoricalFillOperationsCard.tsx");
const PAGE = src("pages/TradingControlPage.tsx");
const PRESENTATION = src("features/operator/historicalFillOperationsPresentation.ts");
const HOOK_CODE = codeOf("hooks/useHistoricalFillOperations.ts");
const CARD_CODE = codeOf("components/operator/HistoricalFillOperationsCard.tsx");
const PRESENTATION_CODE = codeOf("features/operator/historicalFillOperationsPresentation.ts");
const RUNBOOK = src("features/operator/historicalFillRunbook.ts");
const RUNBOOK_CODE = codeOf("features/operator/historicalFillRunbook.ts");

/** The repository runbook document, read as text. */
const RUNBOOK_DOC = readFileSync(
  path.join(process.cwd(), "..", "..", "docs", "historical-fill-operations-runbook.md"),
  "utf8"
);
/** Whitespace-normalised, so the doc assertions survive reflowing. */
const RUNBOOK_DOC_FLAT = RUNBOOK_DOC.replace(/\s+/g, " ");

const READY: Extract<HistoricalFillOperationsDto, { outcome: "READY" }> = {
  outcome: "READY",
  capturedAt: "2026-08-12T09:15:00.000Z",
  executionProfileId: "profile-abc",
  windows: {
    total: 9,
    roots: 7,
    children: 2,
    distinctSymbolCount: 3,
    byStatus: {
      PENDING: 3,
      COMPLETE: 2,
      SPLIT: 2,
      INCOMPLETE_SKIPPED_ROWS: 1,
      SATURATED_SINGLE_MILLISECOND: 0,
      ABANDONED: 3,
    },
  },
  pending: {
    total: 3,
    claimableNow: 1,
    activeLease: 1,
    staleLease: 2,
    inBackoff: 1,
    attemptExhausted: 1,
    oldestPendingCreatedAt: "2026-08-11T00:00:00.000Z",
    oldestClaimableCreatedAt: "2026-08-11T06:30:00.000Z",
    nextBackoffEligibleAt: null,
  },
  ledger: { totalFills: 12, unattributedFills: 4 },
  // The server's verdict for exactly these counts: staleLease 2,
  // attemptExhausted 1, ABANDONED 3, INCOMPLETE_SKIPPED_ROWS 1.
  interpretation: {
    state: "NEEDS_ATTENTION",
    issues: [
      { code: "STALE_LEASES_PRESENT", count: 2 },
      { code: "ATTEMPT_EXHAUSTED_PRESENT", count: 1 },
      { code: "ABANDONED_WINDOWS_PRESENT", count: 3 },
      { code: "INCOMPLETE_SKIPPED_ROWS_PRESENT", count: 1 },
    ],
  },
};

const interpretationOf = (
  state: HistoricalFillOperationalState,
  issues: HistoricalFillInterpretationDto["issues"] = []
): HistoricalFillInterpretationDto => ({ state, issues });

/** The issue rows the panel would render, flattened for assertion. */
const issueRowsOf = (interpretation: HistoricalFillInterpretationDto) =>
  presentInterpretationIssues(interpretation).map((row) => [row.label, row.value] as const);

const ISSUE_CODES: HistoricalFillOperationalIssueCode[] = [
  "STALE_LEASES_PRESENT",
  "ATTEMPT_EXHAUSTED_PRESENT",
  "ABANDONED_WINDOWS_PRESENT",
  "INCOMPLETE_SKIPPED_ROWS_PRESENT",
  "SATURATED_SINGLE_MILLISECOND_PRESENT",
];

const STATES: HistoricalFillOperationalState[] = ["NORMAL", "NEEDS_ATTENTION", "UNAVAILABLE"];

const PROFILE_REASONS: HistoricalFillProfileReason[] = [
  "PROFILE_NOT_CONFIGURED",
  "PROFILE_NOT_FOUND",
  "PROFILE_AMBIGUOUS",
  "PROFILE_POLICY_MISSING",
  "PROFILE_ENVIRONMENT_MISMATCH",
];

/** Every sentence the runbook can put in front of an operator. */
const RUNBOOK_PROSE = [
  ...Object.values(HISTORICAL_FILL_ISSUE_RUNBOOK).flatMap((entry) => [
    entry.meaning,
    entry.operatorCheck,
  ]),
  ...Object.values(HISTORICAL_FILL_PROFILE_RUNBOOK).map((entry) => entry.operatorCheck),
  HISTORICAL_FILL_NORMAL_GUIDANCE,
  HISTORICAL_FILL_ESCALATION,
  HISTORICAL_FILL_EVIDENCE_NOTE,
];

/** Every sentence this panel can put in front of an operator. */
const VOCABULARY = [
  ...Object.values(HISTORICAL_FILL_STATE_WORDING),
  ...Object.values(HISTORICAL_FILL_ISSUE_WORDING),
]
  .join(" ")
  .toLowerCase();

/** Every row the READY panel renders, flattened for assertion. */
const rowsOf = (snapshot = READY) =>
  presentHistoricalFillOperations(snapshot).flatMap((section) =>
    section.rows.map((row) => [row.label, row.value] as const)
  );

const valueOf = (label: string, snapshot = READY) =>
  rowsOf(snapshot).find(([rowLabel]) => rowLabel === label)?.[1];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("historical fill operations: the API client", () => {
  it("A. reads exactly the operator snapshot route", () => {
    expect(HISTORICAL_FILL_OPERATIONS_PATH).toBe("/api/operator/historical-fills/operations");
    expect(CLIENT).toContain(
      "return operatorApiClient.get<HistoricalFillOperationsDto>(account, HISTORICAL_FILL_OPERATIONS_PATH);"
    );
  });

  it("B. goes through the operator client, which is the only thing that attaches the token", () => {
    // `operatorApiClient.get` adds `operatorAuthHeaders(account)` and refuses any path
    // outside /api/operator/. The panel never touches the token itself.
    expect(CLIENT).toContain("operatorApiClient");
    expect(CLIENT).not.toContain("operatorAuthHeaders");
    expect(CLIENT).not.toContain("Authorization");
    expect(HOOK).not.toContain("Authorization");
    expect(CARD).not.toContain("Authorization");
  });

  it("C. sends no profile, no clock and no body", () => {
    const fn = CLIENT.slice(CLIENT.indexOf("export function fetchHistoricalFillOperations"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("fetchHistoricalFillOperations(account: OperatorAccountId): Promise<HistoricalFillOperationsDto>");
    // The ONLY parameter is the explicit account (A or B), so there is still
    // nothing to smuggle a profile or a timestamp into.
    expect(body).not.toMatch(/executionProfileId/);
    expect(body).not.toMatch(/\bnow\b/);
    expect(body).not.toMatch(/capturedAt\s*[:=]/);
    expect(body).not.toContain("?");
  });

  it("O+N. the feature issues no mutation and touches no exchange", () => {
    for (const source of [HOOK, CARD]) {
      for (const forbidden of [
        "operatorApiClient.post",
        "apiClient.post",
        "apiClient.put",
        "apiClient.patch",
        "apiClient.delete",
        "binance",
        "Binance",
        "runHistoricalFillBatch",
        "claimNextWindow",
        "bootstrapHistoricalRoots",
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
    // The hook's only network call is the snapshot read.
    expect(HOOK.match(/fetchHistoricalFillOperations\(account\)/g)).toHaveLength(1);
    expect(CARD).not.toContain("fetch(");
  });
});

describe("historical fill operations: READY facts", () => {
  it("D. presents the window summary", () => {
    expect(valueOf("Total windows")).toBe("9");
    expect(valueOf("Roots")).toBe("7");
    expect(valueOf("Split children")).toBe("2");
    expect(valueOf("Distinct symbols")).toBe("3");
  });

  it("E. presents all six window states", () => {
    expect(valueOf("Pending")).toBe("3");
    expect(valueOf("Complete")).toBe("2");
    expect(valueOf("Split")).toBe("2");
    expect(valueOf("Incomplete / skipped rows")).toBe("1");
    expect(valueOf("Saturated single millisecond")).toBe("0");
    expect(valueOf("Abandoned")).toBe("3");
  });

  it("F. presents every pending diagnostic", () => {
    expect(valueOf("Total pending")).toBe("3");
    expect(valueOf("Claimable now")).toBe("1");
    expect(valueOf("Active leases")).toBe("1");
    expect(valueOf("Stale leases")).toBe("2");
    expect(valueOf("In backoff")).toBe("1");
    expect(valueOf("Attempt exhausted")).toBe("1");
  });

  it("I. presents the ledger totals", () => {
    expect(valueOf("Total fills")).toBe("12");
    expect(valueOf("Unattributed fills")).toBe("4");
  });

  it("F+E. never wires a count to the wrong field", () => {
    // Distinct values everywhere, so a crossed wire changes an assertion.
    const distinct = {
      ...READY,
      windows: {
        total: 41, roots: 42, children: 43, distinctSymbolCount: 44,
        byStatus: {
          PENDING: 51, COMPLETE: 52, SPLIT: 53,
          INCOMPLETE_SKIPPED_ROWS: 54, SATURATED_SINGLE_MILLISECOND: 55, ABANDONED: 56,
        },
      },
      pending: { ...READY.pending, total: 61, claimableNow: 62, activeLease: 63, staleLease: 64, inBackoff: 65, attemptExhausted: 66 },
      ledger: { totalFills: 71, unattributedFills: 72 },
    };
    expect(rowsOf(distinct)).toEqual([
      ["Total windows", "41"], ["Roots", "42"], ["Split children", "43"], ["Distinct symbols", "44"],
      ["Pending", "51"], ["Complete", "52"], ["Split", "53"],
      ["Incomplete / skipped rows", "54"], ["Saturated single millisecond", "55"], ["Abandoned", "56"],
      ["Total pending", "61"], ["Claimable now", "62"], ["Active leases", "63"],
      ["Stale leases", "64"], ["In backoff", "65"], ["Attempt exhausted", "66"],
      ["Oldest pending", formatOptionalInstant(READY.pending.oldestPendingCreatedAt)],
      ["Oldest claimable", formatOptionalInstant(READY.pending.oldestClaimableCreatedAt)],
      ["Next backoff eligible", NOT_AVAILABLE],
      ["Total fills", "71"], ["Unattributed fills", "72"],
    ]);
  });

  it("S. presents no economics and no credential-shaped value", () => {
    const rendered = JSON.stringify(presentHistoricalFillOperations(READY));
    for (const forbidden of ["realizedPnl", "quantity", "price", "commission", "apiKey", "secret", "token"]) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  it("R. renders nothing the contract does not name", () => {
    const withExtras = {
      ...READY,
      apiKey: "BINANCE-KEY",
      debugInternal: "leak",
      ledger: { ...READY.ledger, realizedPnl: "123.45" },
    } as unknown as typeof READY;
    const rendered = JSON.stringify(presentHistoricalFillOperations(withExtras));
    expect(rendered).not.toContain("BINANCE-KEY");
    expect(rendered).not.toContain("debugInternal");
    expect(rendered).not.toContain("123.45");
  });
});

describe("historical fill operations: instants", () => {
  it("G. formats a durable instant and keeps the exact value for a tooltip", () => {
    const rows = presentHistoricalFillOperations(READY).find((s) => s.title === "Queue timing")!.rows;
    const oldest = rows.find((r) => r.label === "Oldest pending")!;
    expect(oldest.value).not.toBe(NOT_AVAILABLE);
    expect(oldest.title).toBe("2026-08-11T00:00:00.000Z");
    expect(exactInstant("2026-08-11T00:00:00.000Z")).toBe("2026-08-11T00:00:00.000Z");
  });

  it("H. renders a missing instant neutrally, never as 'Never'", () => {
    expect(formatOptionalInstant(null)).toBe(NOT_AVAILABLE);
    expect(NOT_AVAILABLE).toBe("—");
    expect(valueOf("Next backoff eligible")).toBe(NOT_AVAILABLE);
    const rows = presentHistoricalFillOperations(READY).find((s) => s.title === "Queue timing")!.rows;
    expect(rows.find((r) => r.label === "Next backoff eligible")!.title).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain("Never");
  });
});

describe("historical fill operations: configuration state", () => {
  const REASONS: HistoricalFillProfileReason[] = [
    "PROFILE_NOT_CONFIGURED",
    "PROFILE_NOT_FOUND",
    "PROFILE_AMBIGUOUS",
    "PROFILE_POLICY_MISSING",
    "PROFILE_ENVIRONMENT_MISMATCH",
  ];

  it("J. describes every reason factually", () => {
    expect(Object.keys(PROFILE_REASON_WORDING).sort()).toEqual([...REASONS].sort());
    expect(describeProfileReason("PROFILE_NOT_CONFIGURED")).toBe(
      "No execution profile is configured."
    );
    expect(describeProfileReason("PROFILE_AMBIGUOUS")).toBe(
      "More than one execution profile matches the configured environment."
    );
    for (const reason of REASONS) {
      const wording = describeProfileReason(reason);
      expect(wording.length).toBeGreaterThan(0);
      // A description of configuration, never an instruction or a verdict.
      for (const judgement of ["broken", "critical", "unsafe", "immediately", "action", "healthy"]) {
        expect(wording.toLowerCase()).not.toContain(judgement);
      }
    }
  });
});

describe("historical fill operations: states are distinguishable", () => {
  it("K. loading is a distinct branch from a loaded all-zero snapshot", () => {
    // `loading` is true only with nothing yet to show, and the card renders a
    // sentence for it rather than falling through to the metric grid.
    expect(HOOK).toContain("loading: authenticated && snapshot === null && error === null");
    expect(CARD).toContain("Loading historical fill operations…");
    // A zero snapshot still goes down the READY branch and renders "0"s.
    const empty = {
      ...READY,
      windows: { total: 0, roots: 0, children: 0, distinctSymbolCount: 0,
        byStatus: { PENDING: 0, COMPLETE: 0, SPLIT: 0, INCOMPLETE_SKIPPED_ROWS: 0, SATURATED_SINGLE_MILLISECOND: 0, ABANDONED: 0 } },
      pending: { total: 0, claimableNow: 0, activeLease: 0, staleLease: 0, inBackoff: 0, attemptExhausted: 0,
        oldestPendingCreatedAt: null, oldestClaimableCreatedAt: null, nextBackoffEligibleAt: null },
      ledger: { totalFills: 0, unattributedFills: 0 },
    };
    expect(valueOf("Total windows", empty)).toBe("0");
    expect(valueOf("Oldest pending", empty)).toBe(NOT_AVAILABLE);
  });

  it("L. a transport failure is never turned into zeros or a configuration state", () => {
    const failure = HOOK.slice(HOOK.indexOf("} catch (caught) {"), HOOK.indexOf("} finally {"));
    // The catch sets an error message and nothing else. It never fabricates a
    // snapshot, and PROFILE_UNAVAILABLE appears nowhere in the hook at all.
    expect(failure).toContain("setError(LOAD_FAILED_MESSAGE)");
    expect(failure).not.toContain("outcome:");
    // No code path constructs a configuration outcome; only the comment
    // promising as much mentions the word.
    expect(HOOK_CODE).not.toContain("PROFILE_UNAVAILABLE");
    expect(CARD).toContain("{error}");
  });

  it("Q. a 401 follows the existing operator-session precedent", () => {
    // `isSessionEnded` is the shared rule; the panel does not invent a second
    // authentication experience, and it drops stale numbers rather than
    // leaving them beside a quiet error.
    expect(HOOK).toContain("isSessionEnded(caught)");
    expect(HOOK).toContain("setSnapshot(null)");
    expect(HOOK).not.toContain("setOperatorToken");
    expect(CARD).not.toContain("token");
  });

  it("29. a later snapshot replaces the earlier one rather than accumulating", () => {
    expect(HOOK).toContain("setSnapshot(next)");
    for (const accumulation of ["+=", "prev =>", "prev)", "concat(", "push("]) {
      expect(HOOK).not.toContain(accumulation);
    }
  });
});

describe("historical fill operations: facts, not verdicts", () => {
  it("M+G. a snapshot full of alarming-looking numbers still produces no judgement", () => {
    // staleLease 2, attemptExhausted 1, ABANDONED 3, unattributedFills 4.
    const rendered = JSON.stringify(presentHistoricalFillOperations(READY)).toLowerCase();
    for (const verdict of [
      "healthy", "unhealthy", "degraded", "warning", "critical",
      "danger", "safe", "unsafe", "good", "bad", "severity", "attention",
    ]) {
      expect(rendered).not.toContain(verdict);
    }
  });

  it("M. the presentation module still owns no threshold, and no metric carries a colour", () => {
    // Tone exists now, but only as a lookup keyed by the server's state. No
    // Tailwind colour class appears here at all: the states map to the shared
    // Badge's existing tones, so this module names no palette of its own.
    for (const forbidden of [
      "severity", "text-red-", "bg-red-", "text-green-", "bg-green-",
      "text-amber-", "bg-amber-", "text-yellow-", "bg-yellow-",
    ]) {
      expect(PRESENTATION_CODE).not.toContain(forbidden);
    }
    // No number is compared against anything: no thresholds exist to compare.
    expect(PRESENTATION_CODE).not.toMatch(/[><]=?\s*\d/);
    // The metric sections are unchanged: still label/value pairs with no tone.
    const sections = JSON.stringify(presentHistoricalFillOperations(READY));
    expect(sections).not.toContain("tone");
    expect(sections).not.toContain("colour");
  });

  it("9. the card's one badge is bound to the server's state, never to a metric", () => {
    // Exactly one badge on the surface, and its tone is a function of the
    // state the API sent -- not of any count the panel is displaying.
    expect(CARD_CODE.match(/<Badge/g)).toHaveLength(1);
    expect(CARD_CODE).toContain("tone={toneForOperationalState(interpretation.state)}");
    // The metric renderer never sees a tone.
    const section = CARD_CODE.slice(
      CARD_CODE.indexOf("function Section("),
      CARD_CODE.indexOf("export function HistoricalFillOperationsCard")
    );
    expect(section).not.toContain("Badge");
    expect(section).not.toContain("tone");
  });
});

describe("historical fill operations: observability only", () => {
  it("N. the panel offers no operational control", () => {
    for (const control of [
      "Start", "Run now", "Retry", "Resume", "Repair", "Requeue",
      "Abandon", "Cancel", "Bootstrap", "Process", "Claim", "Reset", "Clear", "Delete",
    ]) {
      expect(CARD).not.toContain(`>${control}`);
      expect(CARD).not.toContain(`${control}<`);
    }
    // Exactly one button, and it is the read-only refresh.
    expect(CARD.match(/<Button/g)).toHaveLength(1);
    expect(CARD).toContain("void refresh()");
  });

  it("P+18. refresh only refetches the snapshot", () => {
    // The card's refresh is the hook's `read`, whose only call is the GET.
    expect(HOOK).toContain("refresh: read");
    expect(CARD).toContain("{refreshing ? \"Refreshing…\" : \"Refresh\"}");
  });

  it("17. polls at the established cadence, one request at a time, cleaned up", () => {
    expect(HISTORICAL_FILL_OPERATIONS_POLL_MS).toBe(15_000);
    expect(HISTORICAL_FILL_OPERATIONS_POLL_MS).toBeGreaterThanOrEqual(5_000);
    expect(HOOK).toContain("if (inFlight.current) return;");
    expect(HOOK).toContain("window.clearInterval(timer)");
  });

  it("T+4. is mounted on the existing operator page, below the controls", () => {
    // Account-scoped: mounted for the selected account, keyed by it, below the controls.
    expect(PAGE).toContain("<HistoricalFillOperationsCard key={`historical-fills-${account}`} account={account} />");
    expect(PAGE.indexOf("<TradingControlCard ")).toBeLessThan(PAGE.indexOf("<HistoricalFillOperationsCard "));
    // The profile id is a compact metadata row, not a headline metric.
    expect(CARD).toContain("Profile {snapshot.executionProfileId}");
    expect(CARD).toContain("text-xs text-slate-500");
  });
});

describe("historical fill operations: the server's interpretation", () => {
  it("A. NORMAL says no condition requires attention, scoped to historical fills", () => {
    expect(describeOperationalState("NORMAL")).toBe(
      "No historical fill conditions currently require operator attention."
    );
    // NORMAL carries no issue rows, so a stale row cannot survive a recovery.
    expect(issueRowsOf(interpretationOf("NORMAL"))).toEqual([]);
  });

  it("B. NEEDS_ATTENTION asks for review, and never for a specific action", () => {
    expect(describeOperationalState("NEEDS_ATTENTION")).toBe(
      "Historical fill ingestion has conditions that require operator review."
    );
    // Slice 5 owns remediation. The wording must not pre-empt it.
    for (const instruction of ["Retry", "Restart", "Repair", "Requeue", "immediately", "must "]) {
      expect(describeOperationalState("NEEDS_ATTENTION")).not.toContain(instruction);
    }
  });

  it("C. UNAVAILABLE reports an unknown state, not a broken one", () => {
    expect(describeOperationalState("UNAVAILABLE")).toBe(
      "Historical fill operational state is unavailable."
    );
    expect(issueRowsOf(interpretationOf("UNAVAILABLE"))).toEqual([]);
  });

  it("A+B+C. the three states are the whole vocabulary, with no severity ladder", () => {
    expect(Object.keys(HISTORICAL_FILL_STATE_WORDING).sort()).toEqual([...STATES].sort());
    for (const rung of ["INFO", "WARNING", "CRITICAL", "GREEN", "AMBER", "RED", "DEGRADED"]) {
      expect(Object.keys(HISTORICAL_FILL_STATE_WORDING)).not.toContain(rung);
    }
    // Every sentence names its own scope, so none can be read as a global claim.
    for (const sentence of Object.values(HISTORICAL_FILL_STATE_WORDING)) {
      expect(sentence.toLowerCase()).toContain("historical fill");
    }
  });

  it("D. labels exactly the five issue codes the contract defines", () => {
    expect(Object.keys(HISTORICAL_FILL_ISSUE_WORDING).sort()).toEqual([...ISSUE_CODES].sort());
    expect(HISTORICAL_FILL_ISSUE_WORDING.STALE_LEASES_PRESENT).toBe("Stale leases");
    expect(HISTORICAL_FILL_ISSUE_WORDING.ATTEMPT_EXHAUSTED_PRESENT).toBe(
      "Pending windows at the attempt limit"
    );
    expect(HISTORICAL_FILL_ISSUE_WORDING.ABANDONED_WINDOWS_PRESENT).toBe("Abandoned windows");
    expect(HISTORICAL_FILL_ISSUE_WORDING.INCOMPLETE_SKIPPED_ROWS_PRESENT).toBe(
      "Windows completed with skipped rows"
    );
    expect(HISTORICAL_FILL_ISSUE_WORDING.SATURATED_SINGLE_MILLISECOND_PRESENT).toBe(
      "Windows saturated at single-millisecond granularity"
    );
    // Every code is renderable: no code can reach an operator as `undefined`.
    for (const code of ISSUE_CODES) {
      const [row] = issueRowsOf(interpretationOf("NEEDS_ATTENTION", [{ code, count: 1 }]));
      expect(row?.[0]).toBeTruthy();
      expect(row?.[0]).not.toContain("undefined");
    }
  });

  it("E. renders each count exactly, never bucketed, rounded or abbreviated", () => {
    for (const count of [1, 2, 9, 37, 1234]) {
      expect(
        issueRowsOf(
          interpretationOf("NEEDS_ATTENTION", [{ code: "STALE_LEASES_PRESENT", count }])
        )
      ).toEqual([["Stale leases", String(count)]]);
    }
    // No "many", no "1k+", no threshold language substituted for the number.
    const rendered = JSON.stringify(
      presentInterpretationIssues(
        interpretationOf("NEEDS_ATTENTION", [{ code: "ABANDONED_WINDOWS_PRESENT", count: 1234 }])
      )
    );
    expect(rendered).toContain("1234");
    for (const fuzz of ["many", "several", "k+", "99+", "lots"]) {
      expect(rendered.toLowerCase()).not.toContain(fuzz);
    }
  });

  it("F. renders every issue the server sent, in the server's order", () => {
    // READY carries four live conditions at once.
    expect(issueRowsOf(READY.interpretation)).toEqual([
      ["Stale leases", "2"],
      ["Pending windows at the attempt limit", "1"],
      ["Abandoned windows", "3"],
      ["Windows completed with skipped rows", "1"],
    ]);
    // All five together: nothing is dropped, merged, ranked or promoted.
    const all = interpretationOf(
      "NEEDS_ATTENTION",
      ISSUE_CODES.map((code, index) => ({ code, count: index + 1 }))
    );
    expect(issueRowsOf(all)).toHaveLength(ISSUE_CODES.length);
    expect(issueRowsOf(all).map(([label]) => label)).toEqual(
      ISSUE_CODES.map((code) => HISTORICAL_FILL_ISSUE_WORDING[code])
    );
  });
});

describe("historical fill operations: the panel never reaches its own verdict", () => {
  /** A READY snapshot the server called NORMAL, whatever its counts look like. */
  const calledNormal = (
    overrides: Partial<Extract<HistoricalFillOperationsDto, { outcome: "READY" }>> = {}
  ): Extract<HistoricalFillOperationsDto, { outcome: "READY" }> => ({
    ...READY,
    ...overrides,
    interpretation: interpretationOf("NORMAL"),
  });

  it("G. unattributed fills alone are not an attention condition", () => {
    // Four unattributed fills, and the server still said NORMAL.
    const snapshot = calledNormal({ ledger: { totalFills: 12, unattributedFills: 4 } });
    expect(describeOperationalState(snapshot.interpretation.state)).toBe(
      HISTORICAL_FILL_STATE_WORDING.NORMAL
    );
    expect(issueRowsOf(snapshot.interpretation)).toEqual([]);
    // ...and the figure itself is still reported, exactly (fact preservation).
    expect(valueOf("Unattributed fills", snapshot)).toBe("4");
  });

  it("H. pending, active leases and backoff alone are not attention conditions", () => {
    // A busy but healthy queue: work pending, one lease live, one in backoff,
    // and none of the five trigger counts above zero.
    const snapshot = calledNormal({
      windows: {
        ...READY.windows,
        byStatus: {
          PENDING: 40,
          COMPLETE: 12,
          SPLIT: 6,
          INCOMPLETE_SKIPPED_ROWS: 0,
          SATURATED_SINGLE_MILLISECOND: 0,
          ABANDONED: 0,
        },
      },
      pending: {
        ...READY.pending,
        total: 40,
        claimableNow: 31,
        activeLease: 8,
        staleLease: 0,
        inBackoff: 1,
        attemptExhausted: 0,
      },
    });
    expect(describeOperationalState(snapshot.interpretation.state)).toBe(
      HISTORICAL_FILL_STATE_WORDING.NORMAL
    );
    expect(issueRowsOf(snapshot.interpretation)).toEqual([]);
    // Every figure still shown, so NORMAL never means "hidden".
    expect(valueOf("Total pending", snapshot)).toBe("40");
    expect(valueOf("Active leases", snapshot)).toBe("8");
    expect(valueOf("In backoff", snapshot)).toBe("1");
    expect(valueOf("Split", snapshot)).toBe("6");
  });

  it("G+H. no frontend module derives a state from a count", () => {
    // A local recomputation needs a comparison. There is not one anywhere in
    // the three modules that could perform it.
    for (const source of [PRESENTATION_CODE, CARD_CODE, HOOK_CODE]) {
      expect(source).not.toMatch(/[><]=?\s*\d/);
      for (const derivation of [
        "staleLease >", "attemptExhausted >", "unattributedFills >",
        "ABANDONED >", "INCOMPLETE_SKIPPED_ROWS >", "SATURATED_SINGLE_MILLISECOND >",
        ".some(", ".filter(", "||", "&&",
      ]) {
        expect(source).not.toContain(`${derivation} 0`);
      }
    }
    // The only state on the surface is the one the API sent.
    expect(CARD_CODE).toContain("interpretation={snapshot.interpretation}");
    expect(CARD_CODE).toContain("describeOperationalState(interpretation.state)");
    expect(PRESENTATION_CODE).toContain("HISTORICAL_FILL_STATE_WORDING[state]");
    // The metric renderer and the interpretation renderer share no input:
    // presenting the facts cannot change the verdict, or vice versa.
    expect(PRESENTATION_CODE).toContain("interpretation.issues.map");
  });

  it("I. claims nothing about trading, the account, or overall system safety", () => {
    for (const claim of [
      "system healthy", "trading healthy", "trading unsafe", "account unsafe",
      "safe to trade", "execution safe", "trading", "account", "system", "all clear",
    ]) {
      expect(VOCABULARY).not.toContain(claim);
    }
  });

  it("J. uses no critical, danger or emergency vocabulary, and no red", () => {
    for (const alarm of [
      "critical", "danger", "emergency", "fatal", "severe", "alarm",
      "urgent", "broken", "corrupt", "outage", "incident",
    ]) {
      expect(VOCABULARY).not.toContain(alarm);
    }
    // Tone is amber at worst. `red` is not reachable from any state.
    expect(STATES.map(toneForOperationalState)).toEqual(["green", "yellow", "gray"]);
    expect(STATES.map(toneForOperationalState)).not.toContain("red");
    expect(CARD_CODE).not.toContain('tone="red"');
    expect(CARD_CODE).not.toContain("text-red-");
  });

  it("K. a later NORMAL response replaces an earlier NEEDS_ATTENTION one", () => {
    // The hook replaces the snapshot wholesale, so an interpretation cannot
    // outlive the response that carried it.
    expect(HOOK_CODE).toContain("setSnapshot(next)");
    for (const sticky of ["acknowledge", "dismiss", "sticky", "latch", "everSeen", "hadIssues"]) {
      expect(HOOK_CODE).not.toContain(sticky);
    }
    // Presentation is a pure function of the interpretation handed to it.
    const first = READY.interpretation;
    const second = interpretationOf("NORMAL");
    expect(issueRowsOf(first)).toHaveLength(4);
    expect(describeOperationalState(second.state)).toBe(HISTORICAL_FILL_STATE_WORDING.NORMAL);
    expect(issueRowsOf(second)).toEqual([]);
    // ...and rendering the second did not mutate or accumulate onto the first.
    expect(issueRowsOf(first)).toHaveLength(4);
    expect(READY.interpretation.issues).toHaveLength(4);
  });

  it("L. an attention state creates no remediation control", () => {
    // Still exactly one button on the whole surface, and it is Refresh.
    expect(CARD.match(/<Button/g)).toHaveLength(1);
    const block = CARD_CODE.slice(
      CARD_CODE.indexOf("function InterpretationBlock"),
      CARD_CODE.indexOf("function Section(")
    );
    expect(block).toContain("Badge");
    for (const control of [
      "Button", "onClick", "Retry", "Resume", "Repair", "Requeue",
      "Process", "Run now", "Bootstrap", "Reset", "Abandon", "Clear", "Claim",
    ]) {
      expect(block).not.toContain(control);
    }
    // Nor does the attention wording smuggle in a control-shaped label.
    expect(CARD_CODE).not.toContain("NEEDS_ATTENTION ?");
  });

  it("M. the frontend holds zero numeric interpretation thresholds", () => {
    for (const source of [PRESENTATION_CODE, CARD_CODE, HOOK_CODE]) {
      // No comparison against a literal, and no arithmetic over the counts.
      expect(source).not.toMatch(/[><]=?\s*\d/);
      expect(source).not.toMatch(/\bMath\./);
    }
    // The client declares the states and codes, and computes nothing.
    for (const declared of [
      '"NORMAL" | "NEEDS_ATTENTION" | "UNAVAILABLE"',
      '"STALE_LEASES_PRESENT"',
      '"SATURATED_SINGLE_MILLISECOND_PRESENT"',
      "interpretation: HistoricalFillInterpretationDto;",
    ]) {
      expect(CLIENT).toContain(declared);
    }
    // The poll interval is the only number the panel owns, and it is a
    // cadence, not a threshold.
    expect(HISTORICAL_FILL_OPERATIONS_POLL_MS).toBe(15_000);
  });
});

describe("historical fill operations: the operator runbook", () => {
  it("A. every issue code has exactly one runbook entry", () => {
    expect(Object.keys(HISTORICAL_FILL_ISSUE_RUNBOOK).sort()).toEqual([...ISSUE_CODES].sort());
    for (const code of ISSUE_CODES) {
      const entry = HISTORICAL_FILL_ISSUE_RUNBOOK[code];
      expect(entry.meaning.length).toBeGreaterThan(0);
      expect(entry.operatorCheck.length).toBeGreaterThan(0);
    }
    // Guidance is distinct per code: no entry is a copy of another.
    const checks = ISSUE_CODES.map((code) => HISTORICAL_FILL_ISSUE_RUNBOOK[code].operatorCheck);
    expect(new Set(checks).size).toBe(ISSUE_CODES.length);
    const meanings = ISSUE_CODES.map((code) => HISTORICAL_FILL_ISSUE_RUNBOOK[code].meaning);
    expect(new Set(meanings).size).toBe(ISSUE_CODES.length);
  });

  it("B. every PROFILE_UNAVAILABLE reason has exactly one runbook entry", () => {
    expect(Object.keys(HISTORICAL_FILL_PROFILE_RUNBOOK).sort()).toEqual([...PROFILE_REASONS].sort());
    const checks = PROFILE_REASONS.map(profileReasonCheck);
    expect(new Set(checks).size).toBe(PROFILE_REASONS.length);
    for (const check of checks) expect(check.length).toBeGreaterThan(0);
  });

  it("C. STALE_LEASES_PRESENT guidance renders its own meaning and check", () => {
    const [item] = presentIssueRunbook(
      interpretationOf("NEEDS_ATTENTION", [{ code: "STALE_LEASES_PRESENT", count: 2 }])
    );
    expect(item.code).toBe("STALE_LEASES_PRESENT");
    expect(item.meaning).toContain("lease");
    expect(item.operatorCheck).toContain("Review");
  });

  it("D. ATTEMPT_EXHAUSTED_PRESENT guidance renders", () => {
    const [item] = presentIssueRunbook(
      interpretationOf("NEEDS_ATTENTION", [{ code: "ATTEMPT_EXHAUSTED_PRESENT", count: 1 }])
    );
    expect(item.code).toBe("ATTEMPT_EXHAUSTED_PRESENT");
    expect(item.meaning).toContain("attempt limit");
    expect(item.operatorCheck).toContain("attempt budget");
  });

  it("E. ABANDONED_WINDOWS_PRESENT guidance renders", () => {
    const [item] = presentIssueRunbook(
      interpretationOf("NEEDS_ATTENTION", [{ code: "ABANDONED_WINDOWS_PRESENT", count: 3 }])
    );
    expect(item.code).toBe("ABANDONED_WINDOWS_PRESENT");
    expect(item.meaning).toContain("coverage gap");
    expect(item.operatorCheck).toContain("failure history");
  });

  it("F. INCOMPLETE_SKIPPED_ROWS_PRESENT guidance renders", () => {
    const [item] = presentIssueRunbook(
      interpretationOf("NEEDS_ATTENTION", [{ code: "INCOMPLETE_SKIPPED_ROWS_PRESENT", count: 1 }])
    );
    expect(item.code).toBe("INCOMPLETE_SKIPPED_ROWS_PRESENT");
    expect(item.meaning).toContain("coverage gap");
    expect(item.operatorCheck).toContain("skipped");
    // Never suggests rewriting or discarding data.
    for (const forbidden of ["rewrite", "drop", "discard", "accept anyway"]) {
      expect(item.operatorCheck.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("G. SATURATED_SINGLE_MILLISECOND_PRESENT guidance renders", () => {
    const [item] = presentIssueRunbook(
      interpretationOf("NEEDS_ATTENTION", [
        { code: "SATURATED_SINGLE_MILLISECOND_PRESENT", count: 1 },
      ])
    );
    expect(item.code).toBe("SATURATED_SINGLE_MILLISECOND_PRESENT");
    expect(item.meaning).toContain("millisecond");
    expect(item.operatorCheck).toContain("millisecond");
    // Never suggests widening the interval or retrying forever.
    for (const forbidden of ["widen", "retry", "forever"]) {
      expect(item.operatorCheck.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("H. multiple server issues render all matching guidance, and nothing else", () => {
    // READY carries four live conditions.
    const items = presentIssueRunbook(READY.interpretation);
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.code)).toEqual([
      "STALE_LEASES_PRESENT",
      "ATTEMPT_EXHAUSTED_PRESENT",
      "ABANDONED_WINDOWS_PRESENT",
      "INCOMPLETE_SKIPPED_ROWS_PRESENT",
    ]);
    // The fifth condition was not reported, so its guidance is not shown.
    expect(items.map((item) => item.code)).not.toContain("SATURATED_SINGLE_MILLISECOND_PRESENT");
  });

  it("I. issue guidance follows the server's order, never a count ranking", () => {
    // Descending counts deliberately fight the contract order.
    const server = interpretationOf("NEEDS_ATTENTION", [
      { code: "SATURATED_SINGLE_MILLISECOND_PRESENT", count: 99 },
      { code: "STALE_LEASES_PRESENT", count: 1 },
      { code: "ABANDONED_WINDOWS_PRESENT", count: 50 },
    ]);
    expect(presentIssueRunbook(server).map((item) => item.code)).toEqual([
      "SATURATED_SINGLE_MILLISECOND_PRESENT",
      "STALE_LEASES_PRESENT",
      "ABANDONED_WINDOWS_PRESENT",
    ]);
    // No sort, and no count ever reaches the guidance logic: the module maps
    // codes to prose and never reads the number beside them.
    expect(RUNBOOK_CODE).not.toContain(".sort(");
    expect(RUNBOOK_CODE).not.toContain("issue.count");
    expect(RUNBOOK_CODE).not.toMatch(/[><]=?\s*\d/);
  });

  it("J. NORMAL shows no issue guidance at all", () => {
    expect(presentIssueRunbook(interpretationOf("NORMAL"))).toEqual([]);
    // The card falls back to the scoped no-action sentence.
    expect(CARD_CODE).toContain("HISTORICAL_FILL_NORMAL_GUIDANCE");
  });

  it("K. NORMAL guidance stays scoped to historical fills", () => {
    expect(HISTORICAL_FILL_NORMAL_GUIDANCE).toBe(
      "No historical-fill runbook action is indicated by the current snapshot."
    );
    expect(HISTORICAL_FILL_NORMAL_GUIDANCE.toLowerCase()).toContain("historical-fill");
  });
});

describe("historical fill operations: the runbook is guidance, never a control", () => {
  it("L. UNAVAILABLE shows only the reported reason's check", () => {
    expect(profileReasonCheck("PROFILE_AMBIGUOUS")).toBe(
      "Verify that the current environment resolves to exactly one execution profile."
    );
    // One reason in, one check out -- the card never renders all five.
    expect(CARD_CODE).toContain("profileReasonCheck(reason)");
    expect(CARD_CODE).not.toContain("HISTORICAL_FILL_PROFILE_RUNBOOK");
    expect(CARD_CODE).not.toContain("Object.values");
    expect(CARD_CODE).not.toContain("Object.entries");
  });

  it("M. the factual reason sentence stays visible alongside the check", () => {
    // Slice 3's wording is not collapsed into the runbook.
    expect(CARD_CODE).toContain("describeProfileReason(snapshot.reasonCode)");
    expect(CARD_CODE).toContain("<ProfileRunbook reason={snapshot.reasonCode} />");
    expect(describeProfileReason("PROFILE_AMBIGUOUS")).toBe(
      "More than one execution profile matches the configured environment."
    );
  });

  it("N+O. the runbook adds no button; the card still has exactly one, Refresh", () => {
    expect(CARD.match(/<Button/g)).toHaveLength(1);
    expect(CARD).toContain('{refreshing ? "Refreshing…" : "Refresh"}');
    // The guidance is a native <details>: no handler, no state, nothing to click
    // but the disclosure triangle itself.
    expect(CARD_CODE).toContain("<details");
    expect(CARD_CODE.match(/onClick/g)).toHaveLength(1);
    expect(CARD_CODE).not.toContain("useState");
    const block = CARD_CODE.slice(
      CARD_CODE.indexOf("function OperatorChecks"),
      CARD_CODE.indexOf("function Section(")
    );
    for (const control of ["<Button", "onClick", "<form", "<input", "<select"]) {
      expect(block).not.toContain(control);
    }
  });

  it("P. no remediation control appears anywhere on the panel", () => {
    for (const control of [
      "Retry", "Resume", "Repair", "Requeue", "Reset", "Run now",
      "Process", "Bootstrap", "Claim", "Abandon", "Delete", "Clear", "Force", "Override",
    ]) {
      expect(CARD).not.toContain(`>${control}`);
      expect(CARD).not.toContain(`${control}<`);
    }
    // Nor does the guidance prose issue a mutation instruction.
    for (const sentence of RUNBOOK_PROSE) {
      for (const verb of [
        "Retry ", "Requeue", "Reset the", "Delete the", "Force ", "Override",
        "edit ", "rewrite", "DROP ", "UPDATE ", "INSERT ",
      ]) {
        expect(sentence).not.toContain(verb);
      }
    }
  });

  it("Q. the runbook module holds no interpretation logic at all", () => {
    // Keyed by code, never by magnitude: no comparison, no arithmetic, no
    // conditional state.
    expect(RUNBOOK_CODE).not.toMatch(/[><]=?\s*\d/);
    expect(RUNBOOK_CODE).not.toMatch(/\bMath\./);
    for (const derived of [
      "staleLease", "attemptExhausted", "unattributedFills", "byStatus",
      "NEEDS_ATTENTION", "NORMAL:", "UNAVAILABLE:", "pending.",
    ]) {
      expect(RUNBOOK_CODE).not.toContain(derived);
    }
  });

  it("R. guidance is derived from the state, and never the other way round", () => {
    // Same interpretation in, same interpretation out: looking up guidance
    // cannot alter what the server said.
    const server = interpretationOf("NEEDS_ATTENTION", [
      { code: "ABANDONED_WINDOWS_PRESENT", count: 3 },
    ]);
    const before = JSON.stringify(server);
    presentIssueRunbook(server);
    expect(JSON.stringify(server)).toBe(before);
    expect(server.state).toBe("NEEDS_ATTENTION");
    // The state sentence still comes from the presentation module, not here.
    expect(RUNBOOK_CODE).not.toContain("describeOperationalState");
    expect(RUNBOOK_CODE).not.toContain("toneForOperationalState");
  });

  it("S. a later snapshot replaces the earlier state and its guidance", () => {
    expect(HOOK_CODE).toContain("setSnapshot(next)");
    const first = READY.interpretation;
    expect(presentIssueRunbook(first)).toHaveLength(4);
    const later = interpretationOf("NORMAL");
    expect(presentIssueRunbook(later)).toEqual([]);
    // Nothing accumulated onto the earlier one.
    expect(presentIssueRunbook(first)).toHaveLength(4);
    // No client-side latch of any kind.
    for (const sticky of ["acknowledge", "dismiss", "sticky", "latch", "everSeen"]) {
      expect(CARD_CODE).not.toContain(sticky);
    }
  });

  it("T. the runbook claims nothing about trading or overall safety", () => {
    const prose = RUNBOOK_PROSE.join(" ").toLowerCase();
    for (const claim of [
      "safe to trade", "trading unsafe", "trading healthy", "system healthy",
      "account unsafe", "execution safe", "all clear", "no risk",
    ]) {
      expect(prose).not.toContain(claim);
    }
  });

  it("U. the runbook contains no time or SLA threshold", () => {
    // No digit reaches operator-facing guidance at all, so there is no
    // "after 15 minutes" to disagree with a policy nobody has reviewed.
    for (const sentence of RUNBOOK_PROSE) {
      expect(sentence).not.toMatch(/\d/);
    }
    // Checking whether something clears on a refresh is allowed; turning that
    // into a counted threshold is not.
    expect(HISTORICAL_FILL_ISSUE_RUNBOOK.STALE_LEASES_PRESENT.operatorCheck).toContain(
      "later refresh"
    );
    const prose = RUNBOOK_PROSE.join(" ").toLowerCase();
    for (const threshold of ["minutes", "hours", "sla", "deadline", "within "]) {
      expect(prose).not.toContain(threshold);
    }
  });

  it("V. no secret or environment value is named or rendered", () => {
    for (const source of [RUNBOOK_CODE, CARD_CODE]) {
      for (const secret of [
        "process.env", "import.meta.env", "apiKey", "apiSecret",
        "secretKey", "credential", "password", "Bearer ",
      ]) {
        expect(source).not.toContain(secret);
      }
    }
  });

  it("W+X. the runbook reaches no network, and the feature still only reads", () => {
    for (const call of ["fetch(", "axios", "binance", "operatorApiClient", "XMLHttpRequest"]) {
      expect(RUNBOOK_CODE).not.toContain(call);
    }
    // The panel's whole network surface is still the one authenticated GET.
    expect(CLIENT).toContain(
      "operatorApiClient.get<HistoricalFillOperationsDto>(account, HISTORICAL_FILL_OPERATIONS_PATH)"
    );
    for (const source of [RUNBOOK_CODE, CARD_CODE, HOOK_CODE]) {
      for (const verb of [".post(", ".put(", ".patch(", ".delete("]) {
        expect(source).not.toContain(verb);
      }
    }
  });
});

describe("historical fill operations: the repository runbook document", () => {
  it("covers every issue code and every unavailable reason", () => {
    for (const code of ISSUE_CODES) expect(RUNBOOK_DOC).toContain(code);
    for (const reason of PROFILE_REASONS) expect(RUNBOOK_DOC).toContain(reason);
  });

  it("describes the scope of all three states", () => {
    for (const state of STATES) expect(RUNBOOK_DOC).toContain(state);
    // Scoped to this subsystem, and says so.
    expect(RUNBOOK_DOC_FLAT.toLowerCase()).toContain("historical-fill ingestion subsystem");
    expect(RUNBOOK_DOC_FLAT).toContain("does not mean the system as a whole is healthy");
  });

  it("forbids direct durable-state mutation from the dashboard", () => {
    const flat = RUNBOOK_DOC_FLAT.toLowerCase();
    expect(flat).toContain("do not do these from this dashboard");
    for (const forbidden of [
      "run direct sql against the production database",
      "run prisma console mutations against production",
      "mutate redis keys",
    ]) {
      expect(flat).toContain(forbidden);
    }
    // And it offers no procedure for doing any of it.
    for (const procedure of ["UPDATE ", "DELETE FROM", "INSERT INTO", "prisma.$executeRaw"]) {
      expect(RUNBOOK_DOC).not.toContain(procedure);
    }
  });

  it("does not claim the historical-fill runtime is enabled", () => {
    expect(RUNBOOK_DOC_FLAT).toContain("historical-fill ingestion does not run by itself");
    expect(RUNBOOK_DOC_FLAT.toLowerCase()).toContain("no production caller invokes it");
  });

  it("states the evidence limits instead of inventing observability", () => {
    const flat = RUNBOOK_DOC_FLAT.toLowerCase();
    expect(flat).toContain("emit **no runtime logs**".toLowerCase());
    expect(flat).toContain("not exposed anywhere an operator can read");
    expect(flat).toContain("do not go looking for one");
  });

  it("carries the escalation boundary and invents no SLA", () => {
    expect(RUNBOOK_DOC_FLAT).toContain(HISTORICAL_FILL_ESCALATION);
    expect(RUNBOOK_DOC_FLAT.toLowerCase()).toContain("no operational sla has been reviewed");
    // No escalation threshold of any shape.
    for (const pattern of [
      /after \d+ (second|minute|hour|day)/i,
      /older than \d+/i,
      /within \d+ (second|minute|hour)/i,
      /\d+ refreshe?s/i,
      /\d+ polling cycles/i,
    ]) {
      expect(RUNBOOK_DOC).not.toMatch(pattern);
    }
  });

  it("agrees with the typed guidance the panel renders, so the two cannot drift", () => {
    for (const code of ISSUE_CODES) {
      expect(RUNBOOK_DOC_FLAT).toContain(HISTORICAL_FILL_ISSUE_RUNBOOK[code].operatorCheck);
    }
    for (const reason of PROFILE_REASONS) {
      expect(RUNBOOK_DOC_FLAT).toContain(profileReasonCheck(reason));
    }
  });
});
