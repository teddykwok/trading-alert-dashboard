import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ExecutionListResponse } from "../src/api/executions.api";
import { ExecutionLifecycle } from "../src/components/executions/ExecutionLifecycle";
import { ExecutionRowDetailView } from "../src/components/executions/ExecutionRowDetail";
import { LIFECYCLE_STEP_IDS, deriveExecutionLifecycle, presentLifecycleState, type LifecycleStep, type LifecycleStepId } from "../src/features/executions/executionLifecycle";
import {
  EMPTY_EXECUTION_FILTERS,
  EXECUTION_PAGE_SIZES,
  checkExecutionSearch,
  executionListParams,
  executionPageCaption,
  executionQueryString,
  hasActiveExecutionFilters,
  supportsJournalSearch,
  utcDayEnd,
  utcDayStart,
} from "../src/features/executions/executionListQuery";
import type { ExecutionJournalView } from "../src/hooks/useExecutionJournal";
import { ExecutionJournal } from "../src/pages/ExecutionsPage";
import { IDLE_LOADER_STATE, type LoaderState } from "../src/utils/latestRequest";
import { T, admission, detail, listItem, listResponse, order, protectedExecution, protection, transition } from "./fixtures/executions";

/**
 * UI SCALABILITY V1 — Executions as the central, READ-ONLY lifecycle view.
 *
 * The lifecycle is derived from stored records only: a step is "Recorded" only
 * with a stored record behind it; missing evidence is "Not recorded" (unknown)
 * or "Not reached" (the execution provably ended first), never success.
 */

const src = (rel: string) => readFileSync(path.join(process.cwd(), "src", rel), "utf8").replace(/\r\n/g, "\n");
const render = (node: ReactElement) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;
const states = (steps: readonly LifecycleStep[]) => Object.fromEntries(steps.map((step) => [step.id, step.state])) as Record<LifecycleStepId, string>;
const step = (steps: readonly LifecycleStep[], id: LifecycleStepId) => steps.find((s) => s.id === id)!;

const realConsoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) return;
    realConsoleError(...args);
  });
});
afterAll(() => vi.restoreAllMocks());

describe("lifecycle: stored evidence only", () => {
  it("a fresh plan claims nothing: admission is the next step, everything else is pending", () => {
    const steps = deriveExecutionLifecycle(detail(), []);
    expect(steps.map((s) => s.id)).toEqual([...LIFECYCLE_STEP_IDS]);
    expect(states(steps)).toEqual({
      ADMISSION: "IN_PROGRESS", ENTRY_ORDER: "PENDING", ENTRY_FILL: "PENDING", STOP_SUBMITTED: "PENDING", STOP_VERIFIED: "PENDING",
      TP_SUBMITTED: "PENDING", PROTECTED: "PENDING", RECONCILIATION: "PENDING", CLOSE: "PENDING",
    });
    expect(steps.some((s) => s.state === "DONE")).toBe(false);
  });

  it("a SKIP at admission ends it there: refused, then not reached, and the end is recorded", () => {
    const steps = deriveExecutionLifecycle(detail({ status: "SKIPPED", decisionReasonCode: "SYMBOL_NOT_ALLOWED", safetyAdmissions: [admission("SKIP", 2, 1, "SYMBOL_NOT_ALLOWED")] }), []);
    expect(states(steps)).toEqual({
      ADMISSION: "REFUSED", ENTRY_ORDER: "NOT_REACHED", ENTRY_FILL: "NOT_REACHED", STOP_SUBMITTED: "NOT_REACHED", STOP_VERIFIED: "NOT_REACHED",
      TP_SUBMITTED: "NOT_REACHED", PROTECTED: "NOT_REACHED", RECONCILIATION: "NOT_REACHED", CLOSE: "DONE",
    });
    expect(step(steps, "ADMISSION")).toMatchObject({ detail: "Safety admission SKIP: SYMBOL_NOT_ALLOWED", at: T(2) });
    expect(step(steps, "CLOSE").detail).toMatch(/^Ended: Skipped · close time not recorded$/);
  });

  it("a resting entry: submitted and reconciled, the fill is the next step", () => {
    const base = detail();
    const steps = deriveExecutionLifecycle(
      detail({ status: "ENTRY_PENDING", lastReconciledAt: T(9), safetyAdmissions: [admission("PASS", 2)], actual: { ...base.actual, entrySubmittedAt: T(3) }, entryOrder: order({ role: "ENTRY", status: "NEW", submittedAt: T(3) }) }),
      []
    );
    expect(states(steps)).toMatchObject({ ADMISSION: "DONE", ENTRY_ORDER: "DONE", ENTRY_FILL: "IN_PROGRESS", STOP_SUBMITTED: "PENDING", RECONCILIATION: "DONE", CLOSE: "PENDING" });
    expect(step(steps, "ENTRY_ORDER")).toMatchObject({ at: T(3) });
    expect(step(steps, "RECONCILIATION")).toMatchObject({ at: T(9) });
  });

  it("a protected position: every step recorded, each with its own record's time", () => {
    const steps = deriveExecutionLifecycle(protectedExecution(), [transition(1, "PROTECTED", 8)]);
    expect(states(steps)).toEqual({
      ADMISSION: "DONE", ENTRY_ORDER: "DONE", ENTRY_FILL: "DONE", STOP_SUBMITTED: "DONE", STOP_VERIFIED: "DONE",
      TP_SUBMITTED: "DONE", PROTECTED: "DONE", RECONCILIATION: "DONE", CLOSE: "PENDING",
    });
    expect(steps.map((s) => s.at)).toEqual([T(2), T(3), T(5), T(6), T(8), T(7), T(8), T(30), null]);
  });

  it("closed on its take profit: the close is recorded with its time and exit reason", () => {
    const open = protectedExecution();
    const closed = { ...open, status: "CLOSED_TP", actual: { ...open.actual, closedAt: T(40), exitReason: "TAKE_PROFIT" }, protection: protection("CLOSED", { verifiedAt: T(41) }) };
    const close = step(deriveExecutionLifecycle(closed, [transition(1, "PROTECTED", 8)]), "CLOSE");
    expect(close).toEqual({ id: "CLOSE", label: "Closed / cleaned up", state: "DONE", detail: "Ended: Closed - take profit · TAKE_PROFIT · protection closed", at: T(40) });
  });

  it("closed on a stop but missing its order rows: those steps are NOT RECORDED, never done", () => {
    const base = detail();
    const steps = deriveExecutionLifecycle(
      detail({ status: "CLOSED_SL", safetyAdmissions: [admission("PASS", 2)], actual: { ...base.actual, entrySubmittedAt: T(3), entryFilledAt: T(5), closedAt: T(50) } }),
      []
    );
    expect(states(steps)).toMatchObject({ ENTRY_FILL: "DONE", STOP_SUBMITTED: "NOT_RECORDED", STOP_VERIFIED: "NOT_RECORDED", TP_SUBMITTED: "NOT_RECORDED", PROTECTED: "NOT_RECORDED", CLOSE: "DONE" });
  });

  it("a later record with no admission row: admission is NOT RECORDED (unknown), not assumed", () => {
    const base = detail();
    const steps = deriveExecutionLifecycle(detail({ status: "ENTRY_PENDING", actual: { ...base.actual, entrySubmittedAt: T(3) } }), []);
    expect(step(steps, "ADMISSION")).toMatchObject({ state: "NOT_RECORDED" });
    expect(step(steps, "ADMISSION").detail).toMatch(/No admission decision is recorded/);
  });

  it("problems are recorded problems: unknown submission, incomplete protection, incomplete cleanup, manual intervention", () => {
    expect(step(deriveExecutionLifecycle(detail({ status: "ENTRY_SUBMITTING", safetyAdmissions: [admission("PASS", 2)], entryOrder: order({ role: "ENTRY", status: "UNKNOWN", submissionUnknownAt: T(3) }) }), []), "ENTRY_ORDER")).toMatchObject({
      state: "PROBLEM",
      detail: "Entry submission outcome is unknown",
      at: T(3),
    });
    const incomplete = { ...protectedExecution(), status: "PLACING_PROTECTION", protection: protection("PROTECTION_INCOMPLETE") };
    expect(step(deriveExecutionLifecycle(incomplete, []), "PROTECTED").state).toBe("PROBLEM");
    const cleanup = { ...protectedExecution(), status: "CLOSED_TP", protection: protection("CLOSURE_CLEANUP") };
    expect(step(deriveExecutionLifecycle(cleanup, []), "CLOSE")).toMatchObject({ state: "PROBLEM", detail: "Closed, but cleanup is incomplete" });
    const manual = deriveExecutionLifecycle({ ...detail(), status: "MANUAL_INTERVENTION", requiresManualIntervention: true }, []);
    expect(step(manual, "CLOSE").state).toBe("PROBLEM");
    expect(manual.some((s) => s.state === "IN_PROGRESS")).toBe(false);
  });

  it("no take profit planned: not applicable, and it does not make earlier steps look unrecorded", () => {
    const open = protectedExecution();
    const noTp = { ...open, planned: { ...open.planned, takeProfit: null }, protectionOrders: open.protectionOrders.filter((o) => o.role !== "TAKE_PROFIT") };
    const steps = deriveExecutionLifecycle(noTp, []);
    expect(states(steps)).toMatchObject({ STOP_VERIFIED: "DONE", TP_SUBMITTED: "NOT_APPLICABLE", PROTECTED: "DONE" });
  });

  it("an expired entry: submitted, never filled, then not reached; the end is recorded", () => {
    const base = detail();
    const steps = deriveExecutionLifecycle(detail({ status: "ENTRY_EXPIRED", safetyAdmissions: [admission("PASS", 2)], actual: { ...base.actual, entrySubmittedAt: T(3) }, entryOrder: order({ role: "ENTRY", status: "EXPIRED", submittedAt: T(3) }) }), []);
    expect(states(steps)).toMatchObject({ ENTRY_ORDER: "DONE", ENTRY_FILL: "NOT_REACHED", STOP_SUBMITTED: "NOT_REACHED", RECONCILIATION: "NOT_RECORDED", CLOSE: "DONE" });
  });

  it("failed after a fill with no recorded close: whether the position closed is NOT RECORDED", () => {
    const base = detail();
    const steps = deriveExecutionLifecycle(detail({ status: "FAILED", safetyAdmissions: [admission("PASS", 2)], actual: { ...base.actual, entrySubmittedAt: T(3), firstFillAt: T(4), filledQuantity: "0.1" } }), []);
    expect(step(steps, "ENTRY_FILL")).toMatchObject({ state: "PARTIAL", at: T(4) });
    expect(step(steps, "CLOSE")).toMatchObject({ state: "NOT_RECORDED" });
    expect(step(steps, "CLOSE").detail).toMatch(/after a fill, and no close is recorded/);
  });

  it("never claims success without a record: every DONE step names its record and its time is one the data holds", () => {
    const samples = [detail(), protectedExecution(), detail({ status: "CLOSED_EXTERNAL" }), detail({ status: "CANCELED" }), detail({ status: "MANUAL_INTERVENTION" })];
    for (const sample of samples) {
      const known = new Set(JSON.stringify(sample).match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? []);
      for (const s of deriveExecutionLifecycle(sample, [])) {
        if (s.state === "DONE" || s.state === "PARTIAL") {
          expect(s.detail.length, `${sample.status} ${s.id}`).toBeGreaterThan(5);
          if (s.at !== null) expect(known.has(s.at), `${sample.status} ${s.id} ${s.at}`).toBe(true);
        }
      }
    }
    // A position-closing status with no records: nothing in the chain is "done".
    const bare = deriveExecutionLifecycle(detail({ status: "CLOSED_EXTERNAL" }), []);
    expect(bare.filter((s) => s.id !== "CLOSE").some((s) => s.state === "DONE" || s.state === "PARTIAL")).toBe(false);
    expect(bare.filter((s) => s.id !== "CLOSE" && s.id !== "ADMISSION" && s.id !== "RECONCILIATION").every((s) => s.state === "NOT_RECORDED" || s.state === "NOT_APPLICABLE")).toBe(true);
  });

  it("every state has a text label and a marker (never colour alone); unknown is amber, problems red", () => {
    for (const state of ["DONE", "PARTIAL", "PROBLEM", "REFUSED", "IN_PROGRESS", "PENDING", "NOT_REACHED", "NOT_RECORDED", "NOT_APPLICABLE"] as const) {
      const shown = presentLifecycleState(state);
      expect(shown.label.length).toBeGreaterThan(2);
      expect(shown.marker.length).toBeGreaterThan(0);
    }
    expect(presentLifecycleState("NOT_RECORDED")).toMatchObject({ label: "Not recorded", tone: "yellow" });
    expect(presentLifecycleState("PROBLEM").tone).toBe("red");
    expect(presentLifecycleState("DONE")).toMatchObject({ label: "Recorded", tone: "green" });
  });
});

describe("journal query: the server's filters, one deterministic request per state", () => {
  it("search: letters and digits only; empty is no search", () => {
    expect(checkExecutionSearch("  ")).toEqual({ ok: true, q: null });
    expect(checkExecutionSearch("eth")).toEqual({ ok: true, q: "eth" });
    expect(checkExecutionSearch("cm1abcdef")).toEqual({ ok: true, q: "cm1abcdef" });
    for (const bad of ["ETH USDT", "ETH%", "a_b", "x".repeat(65)]) expect(checkExecutionSearch(bad).ok, bad).toBe(false);
  });

  it("params in a fixed order; UTC day bounds; repeated identical state gives the identical string", () => {
    const filters = { ...EMPTY_EXECUTION_FILTERS, source: "TRADINGVIEW" as const, status: "PROTECTED", lifecycle: "active" as const, createdFrom: "2026-10-01", createdTo: "2026-10-10", requiresManualIntervention: true, executionProfileId: "profile-a" };
    const query = executionQueryString(executionListParams(filters, "BTC", 2, 50));
    expect(query).toBe(
      "?q=BTC&executionProfileId=profile-a&source=TRADINGVIEW&status=PROTECTED&lifecycle=active&createdFrom=2026-10-01T00%3A00%3A00.000Z&createdTo=2026-10-10T23%3A59%3A59.999Z&requiresManualIntervention=true&page=2&pageSize=50"
    );
    expect(executionQueryString(executionListParams({ ...filters }, "BTC", 2, 50))).toBe(query);
    expect(executionQueryString(executionListParams(EMPTY_EXECUTION_FILTERS, null, 1, 25))).toBe("?page=1&pageSize=25");
    expect([utcDayStart("2026-13-40"), utcDayEnd("x")]).toEqual([undefined, undefined]);
    expect([...EXECUTION_PAGE_SIZES]).toEqual([25, 50, 100]);
  });

  it("active filters, the page caption, and a backend without search are all told truthfully", () => {
    expect(hasActiveExecutionFilters(EMPTY_EXECUTION_FILTERS)).toBe(false);
    expect(hasActiveExecutionFilters({ ...EMPTY_EXECUTION_FILTERS, requiresManualIntervention: true })).toBe(true);
    expect(executionPageCaption({ page: 2, pageSize: 50, total: 312 }, 50)).toBe("Page 2 of 7 · 51–100 of 312 execution(s)");
    expect(executionPageCaption({ page: 1, pageSize: 25, total: 0 }, 0)).toBe("Page 1 · 0 of 0 execution(s)");
    expect(supportsJournalSearch(listResponse([]))).toBe(true);
    const old = listResponse([]);
    delete (old as Partial<ExecutionListResponse>).profiles;
    expect(supportsJournalSearch(old)).toBe(false);
  });
});

describe("rendered lifecycle and journal", () => {
  function viewOf(data: ExecutionListResponse | null, overrides: Partial<ExecutionJournalView> = {}): ExecutionJournalView {
    const key = "?page=1&pageSize=25";
    const state: LoaderState<ExecutionListResponse> = data === null ? IDLE_LOADER_STATE : { status: "ready", key, data, dataKey: key, message: null };
    const noop = () => undefined;
    return {
      filters: EMPTY_EXECUTION_FILTERS, page: 1, pageSize: 25, requestKey: key, state, latest: data, current: data, expanded: new Set<string>(),
      setSearch: noop, setFilter: noop, clearFilters: noop, setPageSize: noop, goToPage: noop, toggleRow: noop, reload: noop,
      ...overrides,
    };
  }

  it("the lifecycle renders nine ordered, labelled steps with their state in text", () => {
    const html = render(<ExecutionLifecycle steps={deriveExecutionLifecycle(protectedExecution(), [])} />);
    expect(html).toContain('<ol aria-label="Execution lifecycle"');
    expect(count(html, /<li /g)).toBe(9);
    expect(count(html, /data-state="DONE"/g)).toBe(8);
    expect(html).toContain("Recorded");
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/<button|<input|<select|<form/);
  });

  it("an expanded row: lifecycle, account, source, reason, and a link to the full detail — no control", () => {
    const html = render(<ExecutionRowDetailView item={listItem()} detail={protectedExecution()} timeline={[]} />);
    for (const text of ["Account A · MAINNET", "TRADINGVIEW", "Fully protected", "Open the full execution detail", 'href="/executions/exec-1"']) expect(html, text).toContain(text);
    expect(html).not.toMatch(/<button|<input|<select|<form/);
  });

  it("the journal: loading, then a table with labelled toggles, a detail link per row, no row-click navigation", () => {
    expect(render(<ExecutionJournal view={viewOf(null)} />)).toContain("Loading executions…");
    const items = [listItem(), listItem({ id: "exec-2", symbol: "币安人生USDT", direction: "SHORT", alertSource: null, status: "SKIPPED", protectionState: null })];
    const html = render(<ExecutionJournal view={viewOf(listResponse(items), { expanded: new Set(["exec-2"]) })} />);
    expect(count(html, /data-row-key="/g)).toBe(2);
    expect(count(html, /aria-expanded="true"/g)).toBe(1);
    expect(html).toContain('aria-label="Show lifecycle for BTCUSDT LONG"');
    expect(html).toContain('aria-label="Hide lifecycle for 币安人生USDT SHORT"');
    expect(html).toContain('id="execution-detail-exec-2"');
    expect(html).toContain('href="/executions/exec-2"');
    expect(html).toContain("source unknown");
    expect(html).toContain("Loading the execution lifecycle…");
    expect(html).not.toMatch(/role="link"|tabindex="0"/i);
    expect(html).toContain("Counts cover every execution matching the search and filters (all pages)");
    for (const id of ["execution-search", "execution-profile", "execution-source", "execution-direction", "execution-status", "execution-protection", "execution-environment", "execution-lifecycle", "execution-created-from", "execution-created-to", "execution-page-size"]) {
      expect(html, id).toContain(`for="${id}"`);
    }
    expect(html).toContain("Account A · MAINNET");
  });

  it("an empty filtered result, an API error with Retry, and an older backend without search are each explicit", () => {
    const empty = render(<ExecutionJournal view={viewOf(listResponse([]), { filters: { ...EMPTY_EXECUTION_FILTERS, direction: "SHORT" } })} />);
    expect(empty).toContain("No execution records match the current search and filters.");
    const state: LoaderState<ExecutionListResponse> = { status: "error", key: "k", data: null, dataKey: null, message: "Request failed with status 500" };
    const failed = render(<ExecutionJournal view={viewOf(null, { state })} />);
    expect(failed).toContain("Request failed with status 500");
    expect(failed).toMatch(/<button[^>]*>Retry<\/button>/);
    const old = listResponse([listItem()]);
    delete (old as Partial<ExecutionListResponse>).profiles;
    const legacy = render(<ExecutionJournal view={viewOf(old)} />);
    expect(legacy).toContain('data-testid="execution-search-unsupported"');
    expect(legacy).toMatch(/<input[^>]*id="execution-search"[^>]*disabled=""/);
  });
});

describe("source fences: the journal stays observational", () => {
  const page = src("pages/ExecutionsPage.tsx");
  const rowDetail = src("components/executions/ExecutionRowDetail.tsx");
  const lifecycle = src("features/executions/executionLifecycle.ts");
  const journalHook = src("hooks/useExecutionJournal.ts");

  it("its only requests are GET reads: the list page, and one execution's detail and timeline", () => {
    expect([...page.matchAll(/executionsApi\s*\.\s*(\w+)/g)].map((m) => m[1])).toEqual(["listPage"]);
    expect([...rowDetail.matchAll(/executionsApi\s*\.\s*(\w+)/g)].map((m) => m[1]).sort()).toEqual(["detail", "timeline"]);
    expect(src("api/executions.api.ts")).toContain("listPage: (query: string, signal?: AbortSignal) => apiClient.getCancellable<ExecutionListResponse>(`/api/executions${query}`, signal)");
    for (const file of [page, rowDetail, journalHook, lifecycle]) {
      expect(file).not.toMatch(/apiClient\.(post|put|patch|delete)|operatorApiClient|operatorApi\b|fetch\(/);
    }
    expect(lifecycle).not.toMatch(/executionsApi|apiClient|useState|useEffect/);
  });

  it("its controls only search, filter, page, expand, refresh or retry", () => {
    // Each Button's label: the text after the last ">" before its closing tag (handlers may contain "=>").
    const labels = (source: string) => [...source.matchAll(/<Button\b([\s\S]*?)<\/Button>/g)].map((m) => m[1].slice(m[1].lastIndexOf(">") + 1).trim());
    expect(labels(page).sort()).toEqual(["Clear filters", "Next", "Previous", "Refresh", "Retry"].sort());
    expect(labels(rowDetail)).toEqual(["Retry"]);
    expect(count(page, /<button\b/g)).toBe(1);
    expect(page).not.toMatch(/<form|onSubmit|useNavigate|navigate\(/);
    for (const file of [page, rowDetail]) {
      expect(file).not.toMatch(/\b(cancel|close|flatten|arm|disarm|adopt|execute|submit)[A-Z]\w*\(|LIVE_READY|emergencyClose\(|killSwitch/);
    }
  });
});
