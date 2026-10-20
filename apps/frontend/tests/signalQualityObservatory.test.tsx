import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { signalQualityExportHref } from "../src/api/signalQuality.api";
import { ObservatoryBanner, QualityPanel, SoakHealthPanel, SummaryPanel } from "../src/components/signal-quality/ObservatorySections";
import { CHART_NOTICE, SignalQualityDetailView, chartMarkers } from "../src/components/signal-quality/SignalQualityDetail";
import { SIGNAL_QUALITY_COLUMNS, SignalQualityRows, SignalQualityTable } from "../src/components/signal-quality/SignalQualityTable";
import {
  DEFAULT_SOAK_WINDOW,
  EMPTY_SIGNAL_QUALITY_FILTERS,
  activeFilterCount,
  checkSymbol,
  nextOffset,
  pageQueryString,
  previousOffset,
  requestProblem,
  summaryQueryString,
} from "../src/features/signal-quality/signalQualityQuery";
import { BANNER_LINES, MAX_RENDERED_ROWS, boundedRows, formatPercent, formatRate, formatStats, horizonCell } from "../src/features/signal-quality/signalQualityPresentation";
import type { SignalQualityView } from "../src/hooks/useSignalQuality";
import { IDLE_LOADER_STATE } from "../src/utils/latestRequest";
import { LONG_SYMBOL, UNICODE_SYMBOL, detailFixture, pageFixture, rowFixture, soakHealthFixture, summaryFixture } from "./fixtures/signalQuality";

/**
 * M6.5 — the frontend Native signal-quality observatory (section 29).
 *
 * The repo has no DOM test environment, so behaviour is proven on the pure
 * modules, markup by static rendering (react-dom/server), and safety by source
 * fences — the same three techniques the existing suites use.
 */

const SRC = path.join(process.cwd(), "src");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");
/** Code only: comments may legitimately say what the page must never do. */
const codeOf = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const render = (node: JSX.Element) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

const OBSERVATORY_FILES = [
  "api/signalQuality.api.ts",
  "features/signal-quality/signalQualityQuery.ts",
  "features/signal-quality/signalQualityPresentation.ts",
  "hooks/useSignalQuality.ts",
  "pages/SignalQualityPage.tsx",
  ...readdirSync(path.join(SRC, "components/signal-quality")).map((f) => `components/signal-quality/${f}`),
];

function viewStub(over: Partial<SignalQualityView> = {}): SignalQualityView {
  const noop = () => undefined;
  return {
    window: DEFAULT_SOAK_WINDOW,
    filters: EMPTY_SIGNAL_QUALITY_FILTERS,
    sort: "TRIGGERED_DESC",
    pageSize: 50,
    offset: 0,
    problem: null,
    summaryKey: "",
    pageKey: "pageSize=50",
    summary: IDLE_LOADER_STATE,
    page: IDLE_LOADER_STATE,
    soakHealth: IDLE_LOADER_STATE,
    expanded: null,
    autoRefresh: true,
    setWindow: noop,
    setFilter: noop,
    clearFilters: noop,
    setSort: noop,
    setPageSize: noop,
    nextPage: noop,
    previousPage: noop,
    toggleRow: noop,
    setAutoRefresh: noop,
    reload: noop,
    ...over,
  };
}

const ready = <T,>(data: T, key = "pageSize=50") => ({ status: "ready" as const, key, data, dataKey: key, message: null });

describe("the monitoring-only banner", () => {
  it("is always rendered, and says MONITORING ONLY and NO EXECUTION AUTHORITY", () => {
    const html = render(<ObservatoryBanner />);
    for (const line of BANNER_LINES) expect(html).toContain(line);
    expect(BANNER_LINES).toEqual(["SIGNAL QUALITY OBSERVATORY", "MONITORING ONLY", "NO EXECUTION AUTHORITY"]);
    expect(read("pages/SignalQualityPage.tsx")).toMatch(/<ObservatoryBanner \/>/);
  });
});

describe("no control can trade, arm, prepare LIVE_READY or enable execution", () => {
  it("rendered controls are only Refresh, filters, paging, details and export links", () => {
    const html = render(
      <>
        <SummaryPanel summary={summaryFixture()} />
        <QualityPanel summary={summaryFixture()} />
        <SignalQualityTable view={viewStub({ page: ready(pageFixture([rowFixture()])) })} />
        <SignalQualityDetailView detail={detailFixture()} chart={null} chartError={null} />
      </>
    );
    const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
    for (const text of buttons) expect(text).toMatch(/^(Clear filters|Previous|Next|Details|Hide details|Retry)$/);
    expect(html).not.toMatch(/>\s*(Trade|Buy|Sell|Arm|Disarm|Enable|Execute|Place order|Go live|Live ready)\b/i);
  });
  it("the observatory's code calls only GETs, never the operator client, a token or a mutation", () => {
    for (const rel of OBSERVATORY_FILES) {
      const code = codeOf(rel);
      expect({ rel, hit: code.match(/apiClient\.(post|put|patch|delete)|operatorApiClient|operatorAuthHeaders|operator-token|localStorage|sessionStorage|method:\s*["'](POST|PUT|PATCH|DELETE)/)?.[0] ?? null }).toEqual({ rel, hit: null });
      expect({ rel, hit: code.match(/\b(armNaturalWindow|prepareLiveReady|LIVE_READY|enableExecution|NATIVE_EXECUTION_ENABLED\s*=)/)?.[0] ?? null }).toEqual({ rel, hit: null });
    }
    expect(read("api/signalQuality.api.ts").match(/apiClient\.\w+/g)).toEqual(Array(5).fill("apiClient.getCancellable"));
  });
  it("is reachable from the sidebar and its own route", () => {
    expect(read("App.tsx")).toContain('<Route path="/signal-quality" element={<SignalQualityPage />} />');
    expect(read("components/layout/Sidebar.tsx")).toContain('{ to: "/signal-quality", label: "Signal Quality" }');
  });
});

describe("filters, query identity and pagination", () => {
  it("the query string is deterministic and carries only set filters", () => {
    expect(summaryQueryString({ window: DEFAULT_SOAK_WINDOW, filters: EMPTY_SIGNAL_QUALITY_FILTERS })).toBe("");
    const filters = { ...EMPTY_SIGNAL_QUALITY_FILTERS, symbol: "btcusdt", direction: "LONG" as const, sourceTimeframe: "1W" as const, planOutcome: "TP_FIRST" as const, horizon: "4h" as const, horizonState: "MATURED" as const, flag: "EXPECTED_REPEAT" as const };
    const window = { soakStart: "2026-10-21T08:00:00Z", soakEnd: "2026-10-22T08:00:00Z", scope: "TRIGGERED_DURING_SOAK" as const, asOf: "" };
    expect(summaryQueryString({ window, filters })).toBe("soakStart=2026-10-21T08%3A00%3A00Z&soakEnd=2026-10-22T08%3A00%3A00Z&scope=TRIGGERED_DURING_SOAK&symbol=BTCUSDT&sourceTimeframe=1W&direction=LONG&planOutcome=TP_FIRST&horizon=4h&horizonState=MATURED&flag=EXPECTED_REPEAT");
    expect(pageQueryString({ window, filters, sort: "R_DESC", offset: 50, pageSize: 25 })).toMatch(/&sort=R_DESC&offset=50&pageSize=25$/);
    expect(activeFilterCount(filters)).toBe(6);
  });
  it("an incomplete or contradictory window is refused before any request", () => {
    expect(requestProblem({ window: { ...DEFAULT_SOAK_WINDOW, soakStart: "2026-10-21T08:00:00Z" }, filters: EMPTY_SIGNAL_QUALITY_FILTERS })).toMatch(/both soak start and soak end/);
    expect(requestProblem({ window: { soakStart: "2026-10-22T08:00:00Z", soakEnd: "2026-10-21T08:00:00Z", scope: "ALL", asOf: "" }, filters: EMPTY_SIGNAL_QUALITY_FILTERS })).toMatch(/after soak start/);
    expect(requestProblem({ window: { ...DEFAULT_SOAK_WINDOW, scope: "TRIGGERED_DURING_SOAK" }, filters: EMPTY_SIGNAL_QUALITY_FILTERS })).toMatch(/needs a soak window/);
    expect(requestProblem({ window: { ...DEFAULT_SOAK_WINDOW, asOf: "tomorrow" }, filters: EMPTY_SIGNAL_QUALITY_FILTERS })).toMatch(/ISO-8601/);
    expect(requestProblem({ window: DEFAULT_SOAK_WINDOW, filters: EMPTY_SIGNAL_QUALITY_FILTERS })).toBeNull();
  });
  it("pagination is bounded: never past the end, never before the start, one page in the DOM", () => {
    expect([nextOffset(0, 50, 120), nextOffset(100, 50, 120), previousOffset(25, 50)]).toEqual([50, 100, 0]);
    const many = Array.from({ length: 250 }, (_, i) => rowFixture({ alertId: `a${i}` }));
    expect(boundedRows(many)).toHaveLength(MAX_RENDERED_ROWS);
  });
  it("export links are GETs carrying the same filters, without paging", () => {
    const href = signalQualityExportHref("symbol=BTCUSDT&offset=50&pageSize=25", "csv");
    expect(href).toBe("/api/signal-quality/export?symbol=BTCUSDT&format=csv");
  });
});

describe("states: empty, loading, backend unavailable", () => {
  it("empty", () => {
    expect(render(<SignalQualityTable view={viewStub({ page: ready(pageFixture([])) })} />)).toContain("No Native alerts match");
  });
  it("loading", () => {
    expect(render(<SignalQualityTable view={viewStub({ page: { status: "loading", key: "pageSize=50", data: null, dataKey: null, message: null } })} />)).toContain("Loading Native signals");
  });
  it("backend unavailable: a plain alert, nothing else is affected", () => {
    const html = render(<SignalQualityTable view={viewStub({ page: { status: "error", key: "pageSize=50", data: null, dataKey: null, message: "Request failed with status 502" } })} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("The signal-quality backend is unavailable");
    expect(render(<SoakHealthPanel health={null} error="502" />)).toContain("Soak health unavailable");
  });
});

describe("censoring, ambiguity and gaps are shown as such", () => {
  it("a partial horizon is marked censored; pending, gap and unavailable never show a number", () => {
    const row = rowFixture({ states: ["MATURED", "PARTIAL", "PENDING", "DATA_GAP", "DATA_UNAVAILABLE"] });
    const cells = row.horizons.map((h) => horizonCell(h));
    expect(cells.map((c) => c.text)).toEqual(["+0.75%", "+0.75%*", "pending", "gap", "no data"]);
    expect(cells[1].title).toMatch(/PARTIAL \(censored\)/);
    expect(cells[2].title).toMatch(/PENDING \(censored\)/);
  });
  it("ambiguous, data-gap and no-data plan outcomes render with their own labels and no R", () => {
    const html = render(<SignalQualityRows page={pageFixture([rowFixture({ outcome: "AMBIGUOUS_SAME_BAR" }), rowFixture({ alertId: "b", outcome: "DATA_GAP" }), rowFixture({ alertId: "c", outcome: "DATA_UNAVAILABLE" })])} expanded={null} onToggle={() => undefined} asOf={null} />);
    expect(html).toContain("Ambiguous (same bar)");
    expect(html).toContain("Data gap");
    expect(html).toContain("No data");
    expect(html).not.toMatch(/[+-]\d+\.\d\dR/);
  });
  it("public market data unavailable is counted and visible in the summary", () => {
    expect(render(<SummaryPanel summary={summaryFixture()} />)).toContain("1 unavailable");
  });
  it("every rate shows its denominator; an empty sample says n = 0; an absent value is a dash", () => {
    expect(formatRate({ numerator: 7, denominator: 19, value: 7 / 19 }, "resolved non-ambiguous plans")).toBe("7 / 19 resolved non-ambiguous plans · 36.8%");
    expect(formatRate({ numerator: 0, denominator: 0, value: null }, "resolved")).toBe("0 / 0 resolved · —");
    expect(formatStats({ n: 0, mean: null, median: null })).toBe("no matured sample (n = 0)");
    expect(formatPercent(null)).toBe("—");
    expect(render(<QualityPanel summary={summaryFixture()} />)).toContain("7 / 19 resolved non-ambiguous plans");
  });
});

describe("detail, chart and plan unavailable", () => {
  it("the detail shows the canonical evidence, the M5 window, the plan and the chart's look-ahead notice", () => {
    const html = render(<SignalQualityDetailView detail={detailFixture()} chart={null} chartError={null} />);
    for (const text of ["Engine evidence", "Operational 15m bar start", "1m 1s after bar start", "Lookback (candles, never money)", "64000.5 / 63500 / 65500", CHART_NOTICE, "Durable payload provenance"]) expect(html).toContain(text);
  });
  it("plan unavailable is stated, never filled with numbers", () => {
    const row = rowFixture({ plan: { ...rowFixture().plan, available: false, state: "NO_PLAN", entry: null, stopLoss: null, takeProfit: null, outcome: "PLAN_UNAVAILABLE", rMultiple: null, reason: "the alert has no plan" } });
    const html = render(<SignalQualityDetailView detail={detailFixture(row)} chart={null} chartError="budget" />);
    expect(html).toContain("No usable plan (NO_PLAN)");
    expect(html).toContain("Chart unavailable: budget");
  });
  it("chart markers mark the SIGNAL and only the horizons already reached", () => {
    const markers = chartMarkers({
      policy: "NATIVE_SIGNAL_QUALITY_OBSERVATORY_V1",
      authority: "NONE",
      nativeExecutionEnabled: false,
      monitoringOnly: true,
      alertId: "a",
      interval: "15m",
      asOf: "2026-10-20T14:00:00.000Z",
      signalTime: "2026-10-20T12:16:01.234Z",
      bars: [],
      levelPrice: 1,
      entry: 1,
      stopLoss: 0.9,
      takeProfit: 1.3,
      horizonMarks: [
        { key: "15m", time: "2026-10-20T12:32:00.000Z" },
        { key: "1h", time: "2026-10-20T13:17:00.000Z" },
      ],
      marketData: { status: "LOADED", reason: null },
    });
    expect(markers.map((m) => m.text)).toEqual(["SIGNAL", "15m", "1h"]);
  });
});

describe("long and Unicode symbols", () => {
  it("render intact (wrapped, never truncated) and pass the symbol filter", () => {
    const html = render(<SignalQualityRows page={pageFixture([rowFixture({ symbol: UNICODE_SYMBOL }), rowFixture({ alertId: "z", symbol: LONG_SYMBOL })])} expanded={null} onToggle={() => undefined} asOf={null} />);
    expect(html).toContain(UNICODE_SYMBOL);
    expect(html).toContain(LONG_SYMBOL);
    expect(html).toContain("break-all");
    expect(checkSymbol(UNICODE_SYMBOL)).toEqual({ ok: true, value: UNICODE_SYMBOL });
    expect(checkSymbol("BTC-USDT").ok).toBe(false);
  });
  it("the table header is the documented column list", () => {
    expect(SIGNAL_QUALITY_COLUMNS).toEqual(["Triggered", "Symbol", "Side", "Source TF", "Colour", "Level", "Freshness", "Integrity", "Plan", "15m", "1h", "4h", "12h", "24h", "Flags"]);
  });
  it("soak health shows the dynamic universe as reported, with no fixed symbol count", () => {
    const html = render(<SoakHealthPanel health={soakHealthFixture()} error={null} />);
    expect(html).toContain("518 live / 520 selected");
    expect(html).toContain("exchange candidates 528");
    for (const rel of OBSERVATORY_FILES) expect({ rel, hit: /\b525\b/.test(read(rel)) }).toEqual({ rel, hit: false });
  });
});
