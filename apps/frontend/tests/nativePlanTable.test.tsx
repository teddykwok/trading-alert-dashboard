import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EXTREME_RR_STATUSES,
  NATIVE_PLAN_INTEGRITY_FILTERS,
  NATIVE_PLAN_PAGE_MAX_SIZE,
  NATIVE_PLAN_PAGE_SIZES,
  SOURCE_TIMEFRAMES,
  type NativePlanPageDto,
} from "@trading-alert-dashboard/shared";

import { NativePlanDetail } from "../src/components/operator/NativePlanDetail";
import { NativePlansCard, NativeSafetySummary } from "../src/components/operator/NativePlansCard";
import { NativePlanRows, NativePlanTable, NATIVE_PLAN_COLUMNS } from "../src/components/operator/NativePlanTable";
import {
  DIRECTION_OPTIONS,
  EMPTY_NATIVE_PLAN_FILTERS,
  FIRST_NATIVE_PLAN_PAGE,
  INTEGRITY_OPTIONS,
  NATIVE_PLAN_SEARCH_DEBOUNCE_MS,
  PLAN_STATUS_OPTIONS,
  SOURCE_TIMEFRAME_OPTIONS,
  activeNativePlanFilterCount,
  checkNativePlanSearch,
  currentNativePlanCursor,
  hasActiveNativePlanQuery,
  nativePlanPageNumber,
  nativePlanQueryString,
  nextNativePlanPage,
  previousNativePlanPage,
  type NativePlanRequest,
} from "../src/features/plans/nativePlanQuery";
import {
  NATIVE_PLAN_PAGE_UNSUPPORTED,
  asNativePlanPage,
  boundedNativePlanItems,
  nativePlanPageCaption,
  planStatusCountViews,
  presentNativeAccountCell,
  presentNativeIntegrityCell,
  presentNativePlanRow,
  summarizePageIntegrity,
} from "../src/features/plans/nativePlanTable";
import type { NativePlanPageView } from "../src/hooks/useNativePlanPage";
import { NO_EXPANDED_ROWS, expandedKeysIn, toggleExpandedRow } from "../src/utils/expandedRows";
import { IDLE_LOADER_STATE, LatestOnlyLoader, createDebouncer, type LoaderState } from "../src/utils/latestRequest";
import { LONG_REASON, POLICIES, UNICODE_SYMBOL, fakeNativePlanServer, fixtureAlertId, nativePlanItem, nativePlanItems } from "./fixtures/nativePlans";

/**
 * UI SCALABILITY V1 — Trading Control's Native plan table.
 *
 * The repo has no DOM test environment, so behaviour is proven on the pure
 * modules the components and hook are built from, markup is proven by static
 * rendering (react-dom/server, already a dependency), and the wiring by source
 * fences — the same three techniques the existing suites use.
 */

const src = (rel: string) => readFileSync(path.join(process.cwd(), "src", rel), "utf8").replace(/\r\n/g, "\n");
const render = (node: ReactElement) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

// React Router's Link uses useLayoutEffect, which React reports when rendering on the "server" (this test).
// That one known notice is dropped; every other console error still surfaces.
const realConsoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) return;
    realConsoleError(...args);
  });
});
afterAll(() => vi.restoreAllMocks());
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

const REQUEST: NativePlanRequest = { pageSize: 50, cursor: null, q: null, sourceTimeframe: "", direction: "", planStatus: "", integrity: "" };
const noop = () => undefined;

function viewOf(overrides: Partial<NativePlanPageView> = {}): NativePlanPageView {
  return {
    filters: EMPTY_NATIVE_PLAN_FILTERS,
    pageSize: 50,
    pageNumber: 1,
    requestKey: "?pageSize=50",
    state: IDLE_LOADER_STATE,
    latest: null,
    current: null,
    expanded: new Set<string>(),
    setSearch: noop,
    setFilter: noop,
    clearFilters: noop,
    setPageSize: noop,
    nextPage: noop,
    previousPage: noop,
    toggleRow: noop,
    reload: noop,
    ...overrides,
  };
}

function readyView(page: NativePlanPageDto, overrides: Partial<NativePlanPageView> = {}): NativePlanPageView {
  const key = overrides.requestKey ?? "?pageSize=50";
  const state: LoaderState<NativePlanPageDto> = { status: "ready", key, data: page, dataKey: key, message: null };
  return viewOf({ state, latest: page, current: page, requestKey: key, ...overrides });
}

const server = () => fakeNativePlanServer(nativePlanItems(525));

describe("query: the shared vocabulary only, and one deterministic request per state", () => {
  it("every filter option is a value the server validates (no invented enum)", () => {
    expect(SOURCE_TIMEFRAME_OPTIONS.map((o) => o.value)).toEqual([...SOURCE_TIMEFRAMES]);
    expect(DIRECTION_OPTIONS.map((o) => o.value)).toEqual(["LONG", "SHORT"]);
    expect(PLAN_STATUS_OPTIONS.map((o) => o.value)).toEqual([...EXTREME_RR_STATUSES]);
    expect(new Set(INTEGRITY_OPTIONS.map((o) => o.value))).toEqual(new Set(NATIVE_PLAN_INTEGRITY_FILTERS));
    expect(INTEGRITY_OPTIONS).toHaveLength(NATIVE_PLAN_INTEGRITY_FILTERS.length);
    expect([...NATIVE_PLAN_PAGE_SIZES]).toEqual([50, 100, 200]);
  });

  it("search: empty is no search; letters and digits in any script are sent; anything else is refused before sending", () => {
    expect(checkNativePlanSearch("   ")).toEqual({ ok: true, q: null });
    expect(checkNativePlanSearch(" btc ")).toEqual({ ok: true, q: "btc" });
    expect(checkNativePlanSearch("币安人生")).toEqual({ ok: true, q: "币安人生" });
    expect(checkNativePlanSearch(fixtureAlertId(3))).toEqual({ ok: true, q: fixtureAlertId(3) });
    for (const bad of ["BTC USDT", "BTC%", "BTC_USDT", "a'b", "x".repeat(41)]) expect(checkNativePlanSearch(bad).ok, bad).toBe(false);
  });

  it("the query string always names its page size (a PAGE query), omits empty filters, and is stable", () => {
    expect(nativePlanQueryString(REQUEST)).toBe("?pageSize=50");
    const full = { ...REQUEST, pageSize: 200 as const, cursor: "abc", q: "币安", sourceTimeframe: "1W" as const, direction: "SHORT" as const, planStatus: "READY" as const, integrity: "FAIL_CLOSED" as const };
    expect(nativePlanQueryString(full)).toBe(`?pageSize=200&cursor=abc&q=${encodeURIComponent("币安")}&sourceTimeframe=1W&direction=SHORT&planStatus=READY&integrity=FAIL_CLOSED`);
    expect(nativePlanQueryString({ ...full })).toBe(nativePlanQueryString(full));
  });

  it("active filters are counted; Clear filters is offered only when something is active", () => {
    expect(hasActiveNativePlanQuery(EMPTY_NATIVE_PLAN_FILTERS)).toBe(false);
    expect(hasActiveNativePlanQuery({ ...EMPTY_NATIVE_PLAN_FILTERS, search: " x " })).toBe(true);
    expect(activeNativePlanFilterCount({ ...EMPTY_NATIVE_PLAN_FILTERS, direction: "LONG", integrity: "ELIGIBLE" })).toBe(2);
  });

  it("page position is a keyset stack: forward only with a server cursor, back returns exactly the previous cursor", () => {
    expect([currentNativePlanCursor(FIRST_NATIVE_PLAN_PAGE), nativePlanPageNumber(FIRST_NATIVE_PLAN_PAGE)]).toEqual([null, 1]);
    const two = nextNativePlanPage(FIRST_NATIVE_PLAN_PAGE, "c1");
    const three = nextNativePlanPage(two, "c2");
    expect([currentNativePlanCursor(three), nativePlanPageNumber(three)]).toEqual(["c2", 3]);
    expect(nextNativePlanPage(three, null)).toBe(three);
    expect(currentNativePlanCursor(previousNativePlanPage(three))).toBe("c1");
    expect(previousNativePlanPage(FIRST_NATIVE_PLAN_PAGE)).toBe(FIRST_NATIVE_PLAN_PAGE);
  });
});

describe("rows: compact, exact, and a severity hierarchy that is never colour alone", () => {
  it("READY with a selected candidate is healthy; READY without one is a warning; PLANNING and ERROR stay truthful", () => {
    const ready = presentNativePlanRow(nativePlanItem(1));
    expect([ready.planLabel, ready.planTone, ready.rr, ready.selectedLookback]).toEqual(["READY · SELECTED", "green", "1:1.97", "100"]);
    const pending = presentNativePlanRow(nativePlanItem(4));
    expect([pending.planLabel, pending.planTone, pending.rr]).toEqual(["PLANNING", "blue", "—"]);
    const error = presentNativePlanRow(nativePlanItem(9));
    expect([error.planLabel, error.planTone]).toEqual(["ERROR", "red"]);
    const noCandidate = { ...nativePlanItem(1), plan: { ...nativePlanItem(1).plan, state: "NO_SELECTED_CANDIDATE" as const, reason: "No candidate exists for the selected lookback 100" } };
    expect(presentNativePlanRow(noCandidate)).toMatchObject({ planLabel: "READY · NO CANDIDATE", planTone: "yellow", planTitle: "No candidate exists for the selected lookback 100" });
  });

  it("integrity: ELIGIBLE healthy, PENDING BAR CLOSE neutral (never red), every fail-closed state marked with '!'", () => {
    const eligible = presentNativeIntegrityCell({ executionIntegrity: { status: "ELIGIBLE", reason: "r", barOpenTime: null } });
    expect([eligible.integrityClass, eligible.tone, eligible.marker]).toEqual(["HEALTHY", "green", ""]);
    const pending = presentNativeIntegrityCell({ executionIntegrity: { status: "PENDING_BAR_CLOSE", reason: "r", barOpenTime: null } });
    expect([pending.integrityClass, pending.tone, pending.marker]).toEqual(["PENDING", "blue", ""]);
    for (const status of ["INELIGIBLE_REQUARANTINED", "INELIGIBLE_GAP", "INELIGIBLE_DUPLICATE", "INELIGIBLE_CHECKPOINT_MISMATCH", "INELIGIBLE_STALE_GENERATION"] as const) {
      expect(presentNativeIntegrityCell({ executionIntegrity: { status, reason: "r", barOpenTime: null } })).toMatchObject({ integrityClass: "FAIL_CLOSED", tone: "red", marker: "! " });
    }
    expect(presentNativeIntegrityCell({ executionIntegrity: { status: "UNREADABLE", reason: "r", barOpenTime: null } })).toMatchObject({ integrityClass: "FAIL_CLOSED", tone: "yellow", marker: "! " });
    // Missing or unknown is fail-closed, never eligible.
    for (const odd of [null, undefined, { status: "eligible", reason: "x", barOpenTime: null }]) {
      expect(presentNativeIntegrityCell({ executionIntegrity: odd as never })).toMatchObject({ integrityClass: "FAIL_CLOSED", label: "UNREADABLE" });
    }
  });

  it("account cells: A at lookback 100 and B at 300, each from its own preview; refused policy and missing candidate say so", () => {
    const [a, b] = presentNativePlanRow(nativePlanItem(1)).accounts;
    expect([a.account, a.text, a.tone]).toEqual(["A", "100 · RR 1:1.97", "green"]);
    expect([b.account, b.text, b.tone]).toEqual(["B", "300 · RR 1:3.2", "green"]);
    expect(a.title).toBe("Lookback 100 · SL 1.1000000000123 · TP 1.5 · RR 1.97");
    expect(presentNativePlanRow(nativePlanItem(16)).accounts[1]).toMatchObject({ text: "300 · NO CANDIDATE", tone: "yellow" });
    expect(presentNativeAccountCell({ account: "B", policy: "INVALID", source: "ENV_OVERRIDE", lookback: null, state: "INVALID_POLICY", stopLoss: null, takeProfit: null, riskRewardRatio: null, actualCandles: null, complete: null, reason: "override \"7\" is not one of 50, 100, 200, 300", execution: "PLANNING ONLY / EXECUTION DISABLED" })).toMatchObject({ text: "INVALID POLICY", tone: "red" });
  });

  it("the DOM can hold at most one page: 525 items are cut to 200 and duplicate keys are dropped", () => {
    expect(boundedNativePlanItems(nativePlanItems(525))).toHaveLength(NATIVE_PLAN_PAGE_MAX_SIZE);
    const dup = [nativePlanItem(1), nativePlanItem(1), nativePlanItem(2)];
    expect(boundedNativePlanItems(dup).map((i) => i.alertId)).toEqual([fixtureAlertId(1), fixtureAlertId(2)]);
  });
});

describe("counts: each labelled with exactly what it covers", () => {
  it("integrity counts are for the page's own items", () => {
    const items = nativePlanItems(16);
    expect(summarizePageIntegrity(items)).toEqual({ total: 16, healthy: 8, pending: 2, failClosed: 6 });
  });

  it("plan counts: READY always, other statuses only when present", () => {
    expect(planStatusCountViews({ total: 3, byPlanStatus: { PENDING: 0, READY: 3, INVALID: 0, ERROR: 0 } }).map((v) => [v.label, v.count])).toEqual([["READY", 3]]);
    expect(planStatusCountViews({ total: 0, byPlanStatus: { PENDING: 0, READY: 0, INVALID: 0, ERROR: 0 } }).map((v) => v.label)).toEqual(["READY"]);
    expect(planStatusCountViews({ total: 5, byPlanStatus: { PENDING: 1, READY: 3, INVALID: 0, ERROR: 1 } }).map((v) => v.label)).toEqual(["PLANNING", "READY", "ERROR"]);
  });

  it("the page caption never claims more than the response proves", () => {
    const base = { order: "TRIGGERED_AT_DESC" as const, pageSize: 50, cursor: null, nextCursor: "n", hasMore: true, totalMatching: 525, integrityScan: null };
    expect(nativePlanPageCaption(base, 3, 50)).toBe("Page 3 · 101–150 of 525");
    expect(nativePlanPageCaption({ ...base, totalMatching: 0 }, 1, 0)).toBe("Page 1 · 0 of 0");
    const scan = nativePlanPageCaption({ ...base, totalMatching: null, integrityScan: { scanned: 500, limit: 500, exhausted: false } }, 1, 3);
    expect(scan).toMatch(/3 matching on this page · 500 plan\(s\) checked/);
    expect(scan).toMatch(/Next continues the scan/);
    expect(scan).not.toMatch(/of \d/);
  });
});

describe("loading: only the newest request publishes, superseded ones are aborted, nothing loops", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("a slow older response never overwrites a newer one, and the older request is aborted", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<string>>>();
    const signals = new Map<string, AbortSignal>();
    const published: Array<LoaderState<string>> = [];
    const loader = new LatestOnlyLoader<string>(
      (key, signal) => {
        const d = deferred<string>();
        pending.set(key, d);
        signals.set(key, signal);
        return d.promise;
      },
      (state) => published.push(state)
    );
    loader.load("?q=B");
    loader.load("?q=BT");
    expect(signals.get("?q=B")?.aborted).toBe(true);
    pending.get("?q=BT")!.resolve("new");
    await Promise.resolve();
    pending.get("?q=B")!.resolve("old");
    await Promise.resolve();
    await Promise.resolve();
    expect(loader.current()).toMatchObject({ status: "ready", key: "?q=BT", data: "new", dataKey: "?q=BT" });
    expect(published.some((s) => s.data === "old")).toBe(false);
  });

  it("the same request is not sent twice while in flight; a refresh is explicit", () => {
    const fetcher = vi.fn(() => new Promise<string>(() => undefined));
    const loader = new LatestOnlyLoader<string>(fetcher, noop);
    loader.load("?pageSize=50");
    loader.load("?pageSize=50");
    loader.load("?pageSize=50");
    expect(fetcher).toHaveBeenCalledTimes(1);
    loader.load("?pageSize=50", true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("errors are reported with their message, keep the last data, and a forced retry recovers", async () => {
    let fail = true;
    const loader = new LatestOnlyLoader<string>(async () => {
      if (fail) throw new Error("Request failed with status 503");
      return "ok";
    }, noop);
    loader.load("k");
    await Promise.resolve();
    await Promise.resolve();
    expect(loader.current()).toMatchObject({ status: "error", key: "k", message: "Request failed with status 503", data: null });
    fail = false;
    loader.load("k");
    await Promise.resolve();
    await Promise.resolve();
    expect(loader.current()).toMatchObject({ status: "ready", data: "ok" });
  });

  it("after dispose nothing publishes (no state update after unmount)", async () => {
    const d = deferred<string>();
    const publish = vi.fn();
    const loader = new LatestOnlyLoader<string>(() => d.promise, publish);
    loader.load("k");
    const before = publish.mock.calls.length;
    loader.dispose();
    d.resolve("late");
    await Promise.resolve();
    await Promise.resolve();
    expect(publish.mock.calls.length).toBe(before);
  });
});

describe("search debounce: one request after typing settles", () => {
  afterEach(() => vi.useRealTimers());

  it("six keystrokes inside the wait emit once, with the last text; clear cancels a pending emission", () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    const debouncer = createDebouncer<string>(NATIVE_PLAN_SEARCH_DEBOUNCE_MS, (text) => emitted.push(text));
    for (const text of ["B", "BT", "BTC", "BTCU", "BTCUS", "BTCUSDT"]) {
      debouncer.push(text);
      vi.advanceTimersByTime(NATIVE_PLAN_SEARCH_DEBOUNCE_MS - 1);
    }
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(["BTCUSDT"]);
    debouncer.push("ETH");
    debouncer.cancel();
    vi.advanceTimersByTime(NATIVE_PLAN_SEARCH_DEBOUNCE_MS * 2);
    expect(emitted).toEqual(["BTCUSDT"]);
    debouncer.push("SOL");
    debouncer.flush();
    expect(emitted).toEqual(["BTCUSDT", "SOL"]);
  });

  it("typed through the same pieces the hook composes, a search sends exactly one page request", async () => {
    vi.useFakeTimers();
    const fake = server();
    const loader = new LatestOnlyLoader<NativePlanPageDto>(async (key) => fake.serve(key), noop);
    const debouncer = createDebouncer<string>(NATIVE_PLAN_SEARCH_DEBOUNCE_MS, (text) => {
      const check = checkNativePlanSearch(text);
      if (check.ok) loader.load(nativePlanQueryString({ ...REQUEST, q: check.q }));
    });
    for (const text of ["s", "sy", "sym", "sym00", "sym001"]) debouncer.push(text);
    vi.advanceTimersByTime(NATIVE_PLAN_SEARCH_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(fake.requests).toEqual(["?pageSize=50&q=sym001"]);
    expect(loader.current().data?.items.map((i) => i.symbol)).toEqual(Array.from({ length: 10 }, (_, k) => `SYM001${k}USDT`));
  });
});

describe("525 plans: every page bounded, every plan exactly once, back returns the same page", () => {
  async function walkAll(query: Omit<NativePlanRequest, "cursor">) {
    const fake = server();
    let position = FIRST_NATIVE_PLAN_PAGE;
    const pages: NativePlanPageDto[] = [];
    for (let guard = 0; guard < 100; guard += 1) {
      const page = fake.serve(nativePlanQueryString({ ...query, cursor: currentNativePlanCursor(position) }));
      pages.push(page);
      expect(page.items.length).toBeLessThanOrEqual(query.pageSize);
      if (page.pagination.nextCursor === null) break;
      position = nextNativePlanPage(position, page.pagination.nextCursor);
    }
    return { fake, pages, position };
  }

  it.each([50, 100, 200] as const)("page size %i", async (pageSize) => {
    const { fake, pages, position } = await walkAll({ ...REQUEST, pageSize });
    const ids = pages.flatMap((p) => p.items.map((i) => i.alertId));
    expect(ids).toEqual(fake.ordered.map((i) => i.alertId));
    expect(new Set(ids).size).toBe(525);
    expect(pages).toHaveLength(Math.ceil(525 / pageSize));
    expect(nativePlanPageNumber(position)).toBe(pages.length);
    // Back one page: exactly the same rows as before.
    const back = previousNativePlanPage(position);
    const again = fake.serve(nativePlanQueryString({ ...REQUEST, pageSize, cursor: currentNativePlanCursor(back) }));
    expect(again.items.map((i) => i.alertId)).toEqual(pages[pages.length - 2].items.map((i) => i.alertId));
  });

  it("the trigger-time tie (two plans at one instant) is ordered by alertId and never split into a repeat", async () => {
    const { pages } = await walkAll({ ...REQUEST, pageSize: 50 });
    const ids = pages.flatMap((p) => p.items.map((i) => i.alertId));
    expect(ids.indexOf(fixtureAlertId(22))).toBe(ids.indexOf(fixtureAlertId(21)) - 1);
  });

  it("filters and the integrity scan page the same way; counts describe their own scope", async () => {
    const shorts = await walkAll({ ...REQUEST, pageSize: 50, direction: "SHORT" });
    expect(shorts.pages[0].pagination.totalMatching).toBe(175);
    expect(shorts.pages.flatMap((p) => p.items).every((i) => i.plan.direction === "SHORT")).toBe(true);
    const failClosed = await walkAll({ ...REQUEST, pageSize: 50, integrity: "FAIL_CLOSED" });
    const shown = failClosed.pages.flatMap((p) => p.items);
    expect(shown.every((i) => !["ELIGIBLE", "PENDING_BAR_CLOSE"].includes(i.executionIntegrity.status))).toBe(true);
    expect(failClosed.pages[0].pagination.totalMatching).toBeNull();
    expect(failClosed.pages[0].summary.matchingFilters.total).toBe(525);
  });
});

describe("rendered table: bounded DOM, keyboard disclosure, exact values, Unicode, distinct integrity", () => {
  it("a 525-plan data set renders one page of rows, never the data set", () => {
    const all = nativePlanItems(525);
    expect(count(render(<NativePlanRows items={all.slice(0, 50)} expanded={new Set()} onToggle={noop} />), /data-row-key="/g)).toBe(50);
    expect(count(render(<NativePlanRows items={all} expanded={new Set()} onToggle={noop} />), /data-row-key="/g)).toBe(NATIVE_PLAN_PAGE_MAX_SIZE);
  });

  it("every row has a labelled toggle with aria-expanded; only the open row controls a rendered detail row", () => {
    const items = nativePlanItems(5);
    const html = render(<NativePlanRows items={items} expanded={new Set([fixtureAlertId(2)])} onToggle={noop} />);
    expect(count(html, /aria-expanded="true"/g)).toBe(1);
    expect(count(html, /aria-expanded="false"/g)).toBe(4);
    expect(count(html, /aria-controls="/g)).toBe(1);
    expect(html).toContain(`aria-controls="native-plan-detail-${fixtureAlertId(2)}"`);
    expect(html).toContain(`id="native-plan-detail-${fixtureAlertId(2)}"`);
    expect(html).toContain(`aria-label="Hide plan details for SYM0002USDT LONG"`);
    expect(html).toContain(`aria-label="Show plan details for SYM0001USDT LONG"`);
    expect(html).toMatch(/focus-visible:ring-2/);
    expect(count(html, /<th scope="col"/g)).toBe(NATIVE_PLAN_COLUMNS.length + 1);
    expect(html).toContain('<caption class="sr-only">');
  });

  it("columns: time, symbol, source TF, direction, plan, integrity (both state columns before the numbers), entry, lookback, RR, both accounts", () => {
    expect([...NATIVE_PLAN_COLUMNS]).toEqual(["Triggered", "Symbol", "Source TF", "Direction", "Plan", "Integrity", "Entry", "Lookback", "RR", "Account A", "Account B"]);
    const html = render(<NativePlanRows items={[nativePlanItem(1)]} expanded={new Set()} onToggle={noop} />);
    for (const text of ["SYM0001USDT", "1W", "LONG", "READY · SELECTED", "1:1.97", "100 · RR 1:1.97", "300 · RR 1:3.2"]) expect(html, text).toContain(text);
    expect(html).toContain(`dateTime="${nativePlanItem(1).triggeredAt}"`);
    expect(html).toContain('data-exact="1.23450000000001"');
  });

  it("a Unicode symbol is shown exactly, in the row and in its detail", () => {
    const html = render(<NativePlanRows items={[nativePlanItem(7)]} expanded={new Set([fixtureAlertId(7)])} onToggle={noop} />);
    expect(count(html, new RegExp(UNICODE_SYMBOL, "g"))).toBeGreaterThanOrEqual(3);
  });

  it("integrity badges: PENDING is blue, never red; fail-closed is marked '!' and tinted as a warning", () => {
    const html = render(<NativePlanRows items={nativePlanItems(8)} expanded={new Set()} onToggle={noop} />);
    expect(count(html, /data-integrity-class="HEALTHY"/g)).toBe(4);
    expect(count(html, /data-integrity-class="PENDING"/g)).toBe(1);
    expect(count(html, /data-integrity-class="FAIL_CLOSED"/g)).toBe(3);
    const pendingBadge = html.slice(html.lastIndexOf("<span", html.indexOf('data-integrity-class="PENDING"')), html.indexOf("</span>", html.indexOf('data-integrity-class="PENDING"')));
    expect(pendingBadge).toContain("text-blue-400");
    expect(pendingBadge).not.toMatch(/red/);
    expect(html).toContain("! BLOCKED — GAP");
    expect(html).toContain("! UNREADABLE");
    // Phones: the verdict is repeated under the symbol (hidden from assistive tech: the real cell is in the row).
    expect(count(html, /<span aria-hidden="true" class="mt-1 block md:hidden">/g)).toBe(8);
  });

  it("the expanded detail: identity, selected plan, both accounts, integrity with its full reason, and PLANNING ONLY wording", () => {
    const html = render(<NativePlanDetail item={nativePlanItem(6)} />);
    for (const text of [fixtureAlertId(6), "PLANNING ONLY / EXECUTION DISABLED", "Plan cutoff", "Account A Native default", "Account B Native default", "BUILT-IN DEFAULT", "Available lookbacks: 50 / 100 / 200 / 300", LONG_REASON, "Source bar opened"]) {
      expect(html, text.slice(0, 40)).toContain(text);
    }
    // Long ids and reasons wrap; nothing is cut permanently.
    expect(html).toContain("break-all font-mono");
    expect(html).toMatch(/break-words[^"]*">The scanner event log fails strict validation/);
    // No control of any kind, only a link to the alert.
    expect(html).not.toMatch(/<button|<input|<select|<form/);
    expect(count(html, /<a /g)).toBe(1);
  });
});

describe("rendered states: loading, error with retry, empty, stale", () => {
  it("before the first response: the safety panel is already visible and the list says Loading", () => {
    const html = render(<NativePlansCard />);
    expect(html).toContain("NATIVE EXECUTION DISABLED");
    expect(html).toContain("PLANNING ONLY");
    expect(html).toContain("Loading Native plans…");
  });

  it("an API error shows its message and a Retry button that reloads", () => {
    const reload = vi.fn();
    const state: LoaderState<NativePlanPageDto> = { status: "error", key: "k", data: null, dataKey: null, message: "Request failed with status 503" };
    const html = render(<NativePlanTable view={viewOf({ state, reload })} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Native plans could not be loaded: Request failed with status 503");
    expect(html).toMatch(/<button[^>]*>Retry<\/button>/);
  });

  it("empty: no plans at all, no match for the filters, or a scan that has not reached the end yet", () => {
    const fake = server();
    const none = fakeNativePlanServer([]).serve("?pageSize=50");
    expect(render(<NativePlanTable view={readyView(none)} />)).toContain("No Native alert has a plan yet.");
    const noMatch = fake.serve("?pageSize=50&q=NOSUCH");
    expect(render(<NativePlanTable view={readyView(noMatch, { filters: { ...EMPTY_NATIVE_PLAN_FILTERS, search: "NOSUCH" } })} />)).toContain("No Native plans match the current search and filters.");
    const scanning: NativePlanPageDto = { ...noMatch, pagination: { ...noMatch.pagination, totalMatching: null, hasMore: true, nextCursor: "x", integrityScan: { scanned: 500, limit: 500, exhausted: false } } };
    const html = render(<NativePlanTable view={readyView(scanning, { filters: { ...EMPTY_NATIVE_PLAN_FILTERS, integrity: "ELIGIBLE" } })} />);
    expect(html).toContain("No match among the 500 plan(s) checked on this page. Next continues the scan with older plans.");
    expect(html).toContain("Next (continue scan)");
    expect(html).toContain('data-testid="native-plan-integrity-note"');
  });

  it("a ready page: labelled filters, Clear filters disabled without filters, Previous disabled on page 1, caption", () => {
    const page = server().serve("?pageSize=50");
    const html = render(<NativePlanTable view={readyView(page)} />);
    for (const id of ["native-plan-search", "native-plan-source-tf", "native-plan-direction", "native-plan-status", "native-plan-integrity", "native-plan-page-size"]) {
      expect(html, id).toContain(`for="${id}"`);
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Clear filters<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Previous<\/button>/);
    // The attribute, not the Tailwind `disabled:` classes every Button carries.
    expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*>Next<\/button>/);
    expect(html).toContain("Page 1 · 1–50 of 525");
    expect(count(html, /data-row-key="/g)).toBe(50);
    expect(html).toContain('role="search"');
  });

  it("while a newer page loads, the shown rows are dimmed and busy, and Next waits", () => {
    const page = server().serve("?pageSize=50");
    const state: LoaderState<NativePlanPageDto> = { status: "loading", key: "?pageSize=100", data: page, dataKey: "?pageSize=50", message: null };
    const html = render(<NativePlanTable view={viewOf({ state, latest: page, current: null, requestKey: "?pageSize=100" })} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("opacity-60");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Next<\/button>/);
  });

  it("an invalid search is explained next to the box and is not sent", () => {
    const html = render(<NativePlanTable view={readyView(server().serve("?pageSize=50"), { filters: { ...EMPTY_NATIVE_PLAN_FILTERS, search: "BTC USDT" } })} />);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="native-plan-search-error"');
    expect(html).toContain("Search accepts letters and digits only");
  });
});

describe("rendered safety summary: DISABLED as a safety fact, A 100 / B 300, counts with their scope", () => {
  const page = server().serve("?pageSize=50");

  it("Native execution DISABLED is a strong informational panel (not error red); A and B planning defaults; planner", () => {
    const html = render(<NativeSafetySummary view={readyView(page)} planner={null} plannerUnreachable={false} />);
    const panel = html.slice(html.indexOf('data-testid="native-execution-state"') - 120, html.indexOf("NATIVE EXECUTION DISABLED") + 30);
    expect(panel).toContain('role="status"');
    expect(panel).toContain("border-sky-400/50");
    expect(panel).not.toMatch(/red/);
    expect(html).toContain("PLANNING ONLY / EXECUTION DISABLED");
    expect(html).toContain("lookback windows, not risk amounts");
    expect(html).toMatch(/Account A Native default<\/span><span[^>]*>100 candles<\/span><span[^>]*>BUILT-IN DEFAULT/);
    expect(html).toMatch(/Account B Native default<\/span><span[^>]*>300 candles<\/span><span[^>]*>BUILT-IN DEFAULT/);
    expect(html).toContain('data-testid="native-planner-status"');
    expect(html).not.toMatch(/<button|<input|<select|<form/);
    expect(html).not.toMatch(/\$\s?\d|USD|risk amount:/i);
  });

  it("counts: all Native plans (server), integrity for THIS PAGE only; the filtered scope appears only with filters", () => {
    const html = render(<NativeSafetySummary view={readyView(page)} planner={null} plannerUnreachable={false} />);
    expect(html).toMatch(/All Native plans <span[^>]*>525<\/span>/);
    expect(html).toContain("Integrity · this page only (50 plans)");
    expect(html).not.toContain('data-testid="native-plan-counts-matching"');
    const filtered = fakeNativePlanServer(nativePlanItems(525)).serve("?pageSize=50&direction=SHORT");
    const withFilters = render(<NativeSafetySummary view={readyView(filtered, { filters: { ...EMPTY_NATIVE_PLAN_FILTERS, direction: "SHORT" } })} planner={null} plannerUnreachable={false} />);
    expect(withFilters).toMatch(/Matching search and filters <span[^>]*>175<\/span>/);
    const integrityFiltered = render(<NativeSafetySummary view={readyView(filtered, { filters: { ...EMPTY_NATIVE_PLAN_FILTERS, integrity: "ELIGIBLE" } })} planner={null} plannerUnreachable={false} />);
    expect(integrityFiltered).toContain("Matching search and filters (integrity not counted)");
  });

  it("a payload claiming Native execution is enabled is shown as a fault, never as a state", () => {
    const html = render(<NativeSafetySummary view={readyView({ ...page, nativeExecutionEnabled: true as unknown as false })} planner={null} plannerUnreachable={false} />);
    expect(html).toContain("Treat this as a fault and stop.");
    expect(html).toContain("NATIVE EXECUTION DISABLED");
  });
});

describe("expanded rows: scoped to the data on screen", () => {
  it("toggle opens and closes by key; a new page or query starts collapsed; a refresh keeps rows still present", () => {
    const opened = toggleExpandedRow(NO_EXPANDED_ROWS, "?pageSize=50", "a");
    expect([...expandedKeysIn(opened, "?pageSize=50", ["a", "b"])]).toEqual(["a"]);
    expect([...expandedKeysIn(opened, "?pageSize=50&cursor=x", ["a", "b"])]).toEqual([]);
    expect([...expandedKeysIn(opened, "?pageSize=50", ["b"])]).toEqual([]);
    expect([...expandedKeysIn(toggleExpandedRow(opened, "?pageSize=50", "a"), "?pageSize=50", ["a"])]).toEqual([]);
    // Opening a row on a different page does not resurrect the old page's rows.
    expect([...toggleExpandedRow(opened, "?pageSize=100", "c").keys]).toEqual(["c"]);
  });
});

describe("source fences: navigation-only controls, one read-only request", () => {
  const table = src("components/operator/NativePlanTable.tsx");
  const hook = src("hooks/useNativePlanPage.ts");
  const api = src("api/extreme-rr.api.ts");
  const client = src("api/client.ts");

  it("the table's only controls show or navigate: search, filters, page size, Clear, Refresh, Retry, Previous, Next, row toggles", () => {
    const buttonLabels = [...table.matchAll(/<Button\b[^>]*>\s*([^<{]+?)\s*</g)].map((m) => m[1].trim());
    expect(buttonLabels.sort()).toEqual(["Clear filters", "Previous", "Refresh", "Retry"].sort());
    expect(table).toContain('{view.current?.pagination.integrityScan && !view.current.pagination.integrityScan.exhausted ? "Next (continue scan)" : "Next"}');
    expect(count(table, /<button\b/g)).toBe(1);
    expect(count(table, /<input\b/g)).toBe(1);
    expect(count(table, /<select\b/g)).toBe(2);
    expect(table).not.toMatch(/<form|onSubmit/);
    expect(table).not.toMatch(/execute|adopt|apply|arm\b|startAccount|accountControl|operatorApi|LIVE_READY|generate\(|updateSelection/i);
  });

  it("the table and hook make no request themselves: the read is injected by the card", () => {
    for (const file of [table, hook]) {
      expect(file).not.toMatch(/extremeRRApi|apiClient|operatorApiClient|fetch\(/);
    }
    expect(hook).toContain("new LatestOnlyLoader(fetchPage, setState)");
    expect(hook).toContain("}, [loader, requestKey, searchValid]);");
    expect(hook).toContain("createDebouncer<string>(NATIVE_PLAN_SEARCH_DEBOUNCE_MS");
  });

  it("an older backend's original list (no page fields) is refused as a page and explained, never shown as filtered", () => {
    const legacy = { nativeExecutionEnabled: false, accountPolicies: POLICIES, items: nativePlanItems(20) };
    expect(() => asNativePlanPage(legacy)).toThrow(NATIVE_PLAN_PAGE_UNSUPPORTED);
    expect(() => asNativePlanPage(null)).toThrow(NATIVE_PLAN_PAGE_UNSUPPORTED);
    const page = server().serve("?pageSize=50");
    expect(asNativePlanPage(page)).toBe(page);
    expect(src("components/operator/NativePlansCard.tsx")).toContain("asNativePlanPage(await extremeRRApi.listNativePlanPage(query, signal))");
  });

  it("the page read is a GET, abortable and never deduped with another caller", () => {
    expect(api).toContain("listNativePlanPage: (query: string, signal?: AbortSignal) =>\n    apiClient.getCancellable<NativePlanPageDto>(`/api/extreme-rr/native-plans${query}`, signal)");
    expect(client).toContain('getCancellable: <T>(path: string, signal?: AbortSignal) => request<T>(path, { method: "GET", signal })');
  });
});
