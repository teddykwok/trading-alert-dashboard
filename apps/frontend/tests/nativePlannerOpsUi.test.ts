import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { selectedPlanSummaryOf, type ExtremeRRCandidate, type ExtremeRRPlanDto } from "@trading-alert-dashboard/shared";

import { compactDecimal, COMPACT_SIGNIFICANT_DIGITS } from "../src/utils/formatDecimal";
import { acceptLiveAlert, insertLiveAlert } from "../src/features/alerts/liveAlerts";
import { applyLiveNativeDelivery, type SignalSourcesStatusDto } from "../src/api/signalSources.api";
import { presentNativePlannerStatus, type NativePlannerStatusDto } from "../src/api/nativePlanner.api";
import { DECIMAL_ROW_LABELS, PLAN_SELECTION_LABEL, presentSelectedPlan } from "../src/features/plans/selectedPlanPresentation";
import { NATIVE_ACCOUNT_DEFAULT_UNSET, PLAN_SELECTION_IS_NOT_ACCOUNT_DEFAULT, nativePlanStatusLabel, presentNativeAccountPolicy } from "../src/features/plans/nativeAccountDefaults";
import type { Alert } from "../src/types/alert";
import type { AlertListQuery } from "../src/types/api";

/**
 * Native planner ops + live UI polish: compact exact decimals, a live total that counts each genuinely new alert
 * exactly once, a live Native "Last delivered", and wording that never confuses the plan's global selection with an
 * account preference. Pure functions plus source checks (no DOM).
 */

const src = (rel: string) => readFileSync(path.join(process.cwd(), "src", rel), "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------
// B1. Precision / overflow
// ---------------------------------------------------------------------------

describe("B1. compact, exact decimals", () => {
  it("14. the smoke's long SL is shown compactly; short values are shown exactly as given", () => {
    expect(compactDecimal("0.0008901333333333333333333333333333333333333")).toEqual({ text: "0.00089013333", exact: "0.0008901333333333333333333333333333333333333", shortened: true });
    expect(compactDecimal("773.3866666666666666666666666666666666667").text).toBe("773.38667");
    for (const short of ["0.0009348", "0.0010018", "781.44", "0.032724", "100", "96", "0.04234"]) {
      expect(compactDecimal(short)).toEqual({ text: short, exact: short, shortened: false });
    }
    expect(COMPACT_SIGNIFICANT_DIGITS).toBe(8);
  });

  it("never changes magnitude or uses scientific notation; non-decimals pass through", () => {
    expect(compactDecimal("123456789.123").text).toBe("123456789");
    expect(compactDecimal("0.00000001234567891").text).toBe("0.000000012345679");
    expect(compactDecimal("-0.0008901333333333").text).toBe("-0.00089013333");
    for (const odd of ["abc", "1e-7", "", "—"]) expect(compactDecimal(odd)).toMatchObject({ text: odd, shortened: false });
  });

  it("15. the exact value stays available (title + data-exact), and nothing can overflow the card", () => {
    const decimal = src("components/ui/DecimalText.tsx");
    expect(decimal).toContain("title={shown.exact}");
    expect(decimal).toContain("data-exact={shown.exact}");
    expect(decimal).toContain("break-all");
    const view = src("components/alerts/SelectedPlanSummaryView.tsx");
    expect(view).toContain("DECIMAL_ROW_LABELS.includes(row.label) ? <DecimalText value={row.value} />");
    expect(view).toContain('<dd className="min-w-0 text-right text-slate-200">');
    expect([...DECIMAL_ROW_LABELS]).toEqual(["Entry", "SL", "TP"]);
    const card = src("components/operator/NativePlansCard.tsx");
    expect(card).toContain("Entry <DecimalText value={item.plan.entryPrice} />");
    expect(card).toContain("min-w-0 space-y-2 overflow-hidden rounded-lg");
    expect(card).toContain("title={row.detailExact ?? undefined}");
  });

  it("the presented rows still carry the EXACT strings (display-only formatting; stored numbers untouched)", () => {
    const candidate = (lookback: 50 | 100 | 200 | 300): ExtremeRRCandidate => ({
      requestedCandles: lookback, actualCandles: lookback, complete: true, extremePrice: "0.0010018", oldestCandleOpenTime: null, newestCandleCloseTime: null, valid: true,
      invalidReason: null, extremeType: "HIGHEST_HIGH", takeProfit: "0.0010018", stopLoss: "0.0008901333333333333333333333333333333333333", rewardDistance: "1", riskDistance: "1", riskRewardRatio: "1.5", money: null,
    });
    const plan = {
      id: "p", alertId: "a", alertSource: "NATIVE", status: "READY", direction: "LONG", entryBasis: "ALERT_PRICE", entryPrice: "0.0009348", cutoffAt: "2026-10-04T17:30:06.546Z",
      timeframe: "15m", template: null, candidates: [candidate(50), candidate(100), candidate(200), candidate(300)], selectedLookback: 100, selectedLeverage: null,
      precision: "UNROUNDED", leverageLimitVerified: false, errorReason: null, executionOutcomes: [], executionOutcome: null, generatedAt: null, createdAt: "x", updatedAt: "x",
    } as ExtremeRRPlanDto;
    const rows = Object.fromEntries(presentSelectedPlan(selectedPlanSummaryOf(plan)).rows.map((r) => [r.label, r.value]));
    expect(rows.SL).toBe("0.0008901333333333333333333333333333333333333");
    expect(rows.Entry).toBe("0.0009348");
  });
});

// ---------------------------------------------------------------------------
// B2. Live total count
// ---------------------------------------------------------------------------

const alert = (id: string, over: Partial<Alert> = {}): Alert => ({ id, symbol: "PTBUSDT", signal: "LONG", status: "RECEIVED", source: "NATIVE", assetType: "CRYPTO", createdAt: "2026-10-04T17:30:08.861Z", alertContext: null, ...over }) as unknown as Alert;
const LONG_SHORT: AlertListQuery = { signals: ["LONG", "SHORT"] } as AlertListQuery;

describe("B2. a live alert adds to the total exactly once", () => {
  it("16. a genuinely new matching alert: +1 to the total and one card", () => {
    const known = new Set(["a1", "a2"]);
    let list = [alert("a1"), alert("a2")];
    let total = 27214;
    const { isNew, totalDelta } = acceptLiveAlert(known, alert("n1"), LONG_SHORT);
    list = insertLiveAlert(list, alert("n1"));
    total += totalDelta;
    expect([isNew, totalDelta, total, list.length, list[0].id]).toEqual([true, 1, 27215, 3, "n1"]);
  });

  it("17. the same alert twice (duplicate frame): still one card, and the total moved only once", () => {
    const known = new Set<string>();
    let list: Alert[] = [];
    let total = 100;
    for (let i = 0; i < 3; i += 1) {
      total += acceptLiveAlert(known, alert("dup"), LONG_SHORT).totalDelta;
      list = insertLiveAlert(list, alert("dup"));
    }
    expect([list.length, total]).toEqual([1, 101]);
    // An alert the REST page already returned never counts again either.
    expect(acceptLiveAlert(new Set(["rest"]), alert("rest"), LONG_SHORT)).toEqual({ isNew: false, totalDelta: 0 });
  });

  it("filters keep behaving: a new alert that does not match the active filters is not a 'matching alert'", () => {
    const known = new Set<string>();
    expect(acceptLiveAlert(known, alert("tv", { source: "TRADINGVIEW" }), { source: "NATIVE" } as AlertListQuery)).toEqual({ isNew: true, totalDelta: 0 });
    expect(acceptLiveAlert(known, alert("watch", { signal: "WATCH" } as Partial<Alert>), LONG_SHORT)).toEqual({ isNew: true, totalDelta: 0 });
    expect(acceptLiveAlert(known, alert("tv2", { source: "TRADINGVIEW" }), {} as AlertListQuery)).toEqual({ isNew: true, totalDelta: 1 });
  });

  it("18. a refetch reconciles: the server's items reset the known set and the server's total replaces the local one", () => {
    const hook = src("hooks/useAlerts.ts");
    const refetch = hook.slice(hook.indexOf("const refetch = useCallback"), hook.indexOf("const loadMore = useCallback"));
    expect(refetch).toContain("knownIdsRef.current = new Set(response.items.map((alert) => alert.id));");
    expect(refetch).toContain("setTotal(response.total);");
    const loadMore = hook.slice(hook.indexOf("const loadMore = useCallback"), hook.indexOf("const applyLiveAlert"));
    expect(loadMore).toContain("for (const alert of response.items) knownIdsRef.current.add(alert.id);");
    const apply = hook.slice(hook.indexOf("const applyLiveAlert"), hook.indexOf("const hasMore"));
    // Decided once, outside any state updater (StrictMode double-invokes updaters); never total = list length.
    expect(apply).toContain("const { totalDelta } = acceptLiveAlert(knownIdsRef.current, alert, filters);");
    expect(apply).toContain("if (totalDelta === 1) setTotal((current) => current + 1);");
    expect(apply).not.toMatch(/setTotal\([^)]*length/);
    // The server paging offset is NOT shifted by a live alert (existing pagination semantics).
    expect(apply).not.toContain("nextOffsetRef");
    expect(src("pages/DashboardPage.tsx")).toContain("useSocketAlerts(setAlerts, applyLiveAlert);");
  });

  it("28. TradingView alert socket behaviour is unchanged: the same canonical event inserts/replaces the card the same way", () => {
    const socket = src("hooks/useSocketAlerts.ts");
    expect(socket).toContain("if (onNewAlert) onNewAlert(alert);");
    expect(socket).toContain("else setAlerts((prev) => insertLiveAlert(prev, alert));");
    expect(socket).toContain("socket.on(SOCKET_EVENTS.ALERT_UPDATED, handleAlertUpdated);");
    expect(insertLiveAlert([alert("x", { source: "TRADINGVIEW" })], alert("x", { source: "TRADINGVIEW", status: "ANALYZED" } as Partial<Alert>)).map((a) => [a.id, a.status])).toEqual([["x", "ANALYZED"]]);
  });
});

// ---------------------------------------------------------------------------
// B3. Signal Sources "Last delivered"
// ---------------------------------------------------------------------------

const status = (over: Partial<SignalSourcesStatusDto["native"]> = {}): SignalSourcesStatusDto => ({
  generatedAt: "2026-10-04T17:29:00.000Z",
  tradingView: { webhook: "READY", webhookRoute: "/api/webhooks/tradingview", lastReceivedAt: "2026-09-30T12:20:00.000Z", lastReceivedSymbol: "BTCUSDT" },
  native: {
    state: "RUNNING", reason: "fresh", profileId: "TEDDY_7_ALL_ACTIVE_V1", profileLabel: "Teddy 7%", runId: "r", engineFingerprintPrefix: "5cd970a6", targetEligible: 471, acceptedEligible: 471,
    selected: 471, liveEligible: 471, failed: 0, writtenAt: null, ageSeconds: 3, freshnessWindowSeconds: 300, lastDeliveredAt: "2026-10-04T14:30:08.191Z", lastDeliveredSymbol: "WCTUSDT", ...over,
  },
});

describe("B3. Native 'Last delivered' moves live, once", () => {
  it("19. a unique live Native alert moves the Native last delivered to its createdAt and symbol", () => {
    const next = applyLiveNativeDelivery(status(), alert("n1"))!;
    expect(next.native).toMatchObject({ lastDeliveredAt: "2026-10-04T17:30:08.861Z", lastDeliveredSymbol: "PTBUSDT" });
  });

  it("20. a duplicate frame (or an older alert) changes nothing and returns the SAME object", () => {
    const once = applyLiveNativeDelivery(status(), alert("n1"))!;
    expect(applyLiveNativeDelivery(once, alert("n1"))).toBe(once);
    expect(applyLiveNativeDelivery(once, alert("old", { createdAt: "2026-10-01T00:00:00.000Z" }))).toBe(once);
    expect(applyLiveNativeDelivery(null, alert("n1"))).toBeNull();
    expect(applyLiveNativeDelivery(status({ lastDeliveredAt: null }), alert("first"))!.native.lastDeliveredAt).toBe("2026-10-04T17:30:08.861Z");
  });

  it("21. TradingView's summary is never touched by a live alert (it keeps its poll-only behaviour)", () => {
    const before = status();
    expect(applyLiveNativeDelivery(before, alert("tv", { source: "TRADINGVIEW", createdAt: "2026-10-05T00:00:00.000Z" }))).toBe(before);
    const after = applyLiveNativeDelivery(before, alert("n1"))!;
    expect(after.tradingView).toEqual(before.tradingView);
    const hook = src("hooks/useSignalSources.ts");
    expect(hook).toContain("socket.on(SOCKET_EVENTS.NEW_ALERT, onNewAlert);");
    expect(hook).toContain("socket.off(SOCKET_EVENTS.NEW_ALERT, onNewAlert);");
    expect(hook).toContain("setStatus((previous) => applyLiveNativeDelivery(previous, alert))");
    expect(hook).toContain("SIGNAL_SOURCES_POLL_MS = 30_000");
  });
});

// ---------------------------------------------------------------------------
// B4-B6. Wording, planning state, no controls
// ---------------------------------------------------------------------------

describe("B4-B6. Trading Control says exactly what is true", () => {
  const card = src("components/operator/NativePlansCard.tsx");

  it("22/23. the plan's global selection is labelled as such, and separately from Account A and Account B defaults", () => {
    expect(PLAN_SELECTION_LABEL).toBe("Plan selection (global)");
    expect(PLAN_SELECTION_IS_NOT_ACCOUNT_DEFAULT).toMatch(/not an account execution preference/);
    expect(PLAN_SELECTION_IS_NOT_ACCOUNT_DEFAULT).toMatch(/Account A \/ B Native defaults/);
    expect(card).toContain("{PLAN_SELECTION_IS_NOT_ACCOUNT_DEFAULT}");
    expect(card).toContain("item.accountDefaults.map");
    expect(presentNativeAccountPolicy({ account: "A", state: "UNSET", lookback: null, reason: null }).label).toBe("Account A Native default");
    expect(presentNativeAccountPolicy({ account: "B", state: "UNSET", lookback: null, reason: null }).label).toBe("Account B Native default");
    expect(PLAN_SELECTION_LABEL).not.toMatch(/Account/);
  });

  it("24. A and B UNSET stay UNSET", () => {
    for (const account of ["A", "B"] as const) {
      expect(presentNativeAccountPolicy({ account, state: "UNSET", lookback: null, reason: null }).value).toBe(NATIVE_ACCOUNT_DEFAULT_UNSET);
    }
  });

  it("25/26. no Execute, Start Account, adopt or selection control; only read-only API calls", () => {
    expect(card).not.toMatch(/<Button|<button|onClick|onSubmit|<form|<select|<input/);
    expect(card).not.toMatch(/execute|adopt|LIVE_READY|startAccount|accountControl|operatorApi/i);
    expect([...card.matchAll(/extremeRRApi\s*\.\s*(\w+)/g)].map((m) => m[1])).toEqual(["listNativePlans"]);
    expect([...card.matchAll(/nativePlannerApi\s*\.\s*(\w+)/g)].map((m) => m[1])).toEqual(["status"]);
  });

  it("27. PLANNING / READY / ERROR stay truthful, with no artificial minimum PLANNING time", () => {
    expect(nativePlanStatusLabel("PENDING")).toBe("PLANNING");
    expect(nativePlanStatusLabel("READY")).toBe("READY");
    expect(nativePlanStatusLabel("ERROR")).toBe("ERROR");
    expect(card).not.toMatch(/setTimeout|minimumPlanning|delay/);
  });

  it("the planner worker's health is shown truthfully and read-only", () => {
    const base: NativePlannerStatusDto = {
      generatedAt: "x", role: "native-planner", queue: "native-extreme-rr-plan", nativeExecutionEnabled: false, startedBy: "EXPLICIT_COMMAND_OR_LAUNCHER",
      worker: { state: "RUNNING", reason: "fresh", startedAt: "s", lastHeartbeatAt: "h", ageSeconds: 4, consumerRunning: true, lastSweep: { at: "t", phase: "STARTUP", inspected: 0, recovered: 0, alreadyQueued: 0, closedAsError: 0, queueUnavailable: false }, lastSweepError: null },
      connectedConsumers: 1, jobs: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 1 }, pendingNativePlans: 0, readiness: "READY",
    };
    expect(presentNativePlannerStatus(base, false)).toEqual({ label: "READY", tone: "green", detail: "heartbeat 4s ago · consumers 1 · waiting 0 · PENDING plans 0 · last sweep inspected 0" });
    expect(presentNativePlannerStatus({ ...base, readiness: "DOWN", worker: { ...base.worker, state: "OFF", ageSeconds: null, lastSweep: null }, connectedConsumers: 0 }, false)).toMatchObject({ label: "DOWN", tone: "red" });
    expect(presentNativePlannerStatus(null, true)).toMatchObject({ label: "UNKNOWN", tone: "gray" });
    expect(card).toContain('data-testid="native-planner-status"');
  });
});
