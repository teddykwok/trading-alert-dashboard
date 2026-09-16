import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HISTORICAL_FILL_OPERATIONS_PATH,
  type HistoricalFillOperationsDto,
  type HistoricalFillProfileReason,
} from "../src/api/operator";
import { HISTORICAL_FILL_OPERATIONS_POLL_MS } from "../src/hooks/useHistoricalFillOperations";
import {
  NOT_AVAILABLE,
  PROFILE_REASON_WORDING,
  describeProfileReason,
  exactInstant,
  formatOptionalInstant,
  presentHistoricalFillOperations,
} from "../src/features/operator/historicalFillOperationsPresentation";

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
};

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
      "return operatorApiClient.get<HistoricalFillOperationsDto>(HISTORICAL_FILL_OPERATIONS_PATH);"
    );
  });

  it("B. goes through the operator client, which is the only thing that attaches the token", () => {
    // `operatorApiClient.get` adds `operatorAuthHeaders()` and refuses any path
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
    expect(body).toContain("fetchHistoricalFillOperations(): Promise<HistoricalFillOperationsDto>");
    // No parameters at all, so there is nothing to smuggle a profile or a
    // timestamp into.
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
    expect(HOOK.match(/fetchHistoricalFillOperations\(\)/g)).toHaveLength(1);
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

  it("M. the presentation module owns no tone, threshold or colour", () => {
    // Colour and tone in the forms this codebase actually expresses them:
    // a Badge `tone`, or a Tailwind semantic class. A bare "red" would match
    // ordinary words like "required".
    for (const forbidden of [
      "tone:", "tone=", "Tone", "severity", "Badge",
      "text-red-", "bg-red-", "text-green-", "bg-green-",
      "text-amber-", "bg-amber-", "text-yellow-", "bg-yellow-",
    ]) {
      expect(PRESENTATION_CODE).not.toContain(forbidden);
    }
    // No number is compared against anything: no thresholds exist to compare.
    expect(PRESENTATION_CODE).not.toMatch(/[><]=?\s*\d/);
  });

  it("9. the card uses no semantic status badge for these metrics", () => {
    expect(CARD_CODE).not.toContain("Badge");
    expect(CARD_CODE).not.toContain('tone="');
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
    expect(PAGE).toContain("<HistoricalFillOperationsCard />");
    expect(PAGE.indexOf("<TradingControlCard />")).toBeLessThan(
      PAGE.indexOf("<HistoricalFillOperationsCard />")
    );
    // The profile id is a compact metadata row, not a headline metric.
    expect(CARD).toContain("Profile {snapshot.executionProfileId}");
    expect(CARD).toContain("text-xs text-slate-500");
  });
});
