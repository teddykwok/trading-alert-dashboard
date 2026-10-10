import {
  EXTREME_RR_STATUSES,
  NATIVE_PLAN_EXECUTION_STATUS,
  NATIVE_PLAN_INTEGRITY_SCAN_LIMIT,
  nativeIntegrityMatches,
  type ExtremeRRPlanStatus,
  type NativeAccountPlanPolicy,
  type NativeAccountPlanPreview,
  type NativeExecutionIntegrityStatus,
  type NativePlanIntegrityFilter,
  type NativePlanListItemDto,
  type NativePlanPageDto,
  type NativePlanStatusCounts,
} from "@trading-alert-dashboard/shared";

/**
 * A realistic Native plan data set for the frontend: 525 plans (the live
 * universe's size), every integrity class, every plan status, a Unicode symbol,
 * a tie on trigger time, and a very long reason. Plus a fake server that pages
 * it exactly like the backend: newest trigger first, alertId breaking ties,
 * keyset cursors, database filters, and the bounded integrity scan.
 */

export const FIXTURE_T0 = Date.UTC(2026, 9, 10, 12, 0, 0, 0);
export const UNICODE_SYMBOL = "币安人生USDT";
export const LONG_REASON = `The scanner event log fails strict validation (MALFORMED_LINE). ${"x".repeat(400)} — end of reason.`;

export const POLICIES: NativeAccountPlanPolicy[] = [
  { account: "A", state: "RESOLVED", lookback: 100, source: "BUILTIN_DEFAULT", reason: null },
  { account: "B", state: "RESOLVED", lookback: 300, source: "BUILTIN_DEFAULT", reason: null },
];

const INTEGRITY_CYCLE: NativeExecutionIntegrityStatus[] = ["ELIGIBLE", "ELIGIBLE", "PENDING_BAR_CLOSE", "ELIGIBLE", "INELIGIBLE_GAP", "ELIGIBLE", "UNREADABLE", "INELIGIBLE_REQUARANTINED"];
const TFS = ["1D", "1W", "1M", "3M"] as const;

export const fixtureAlertId = (i: number) => `cm${String(i).padStart(6, "0")}fixtureplan`;

function preview(account: "A" | "B", lookback: 100 | 300, planStatus: ExtremeRRPlanStatus, i: number): NativeAccountPlanPreview {
  const base = { account, policy: "RESOLVED" as const, source: "BUILTIN_DEFAULT" as const, lookback, execution: NATIVE_PLAN_EXECUTION_STATUS };
  if (planStatus !== "READY") return { ...base, state: "PLAN_NOT_READY", stopLoss: null, takeProfit: null, riskRewardRatio: null, actualCandles: null, complete: null, reason: "Plan is still being generated" };
  if (account === "B" && i % 11 === 5) return { ...base, state: "NO_CANDIDATE", stopLoss: null, takeProfit: null, riskRewardRatio: null, actualCandles: null, complete: null, reason: "No candidate exists for lookback 300" };
  return { ...base, state: "RESOLVED", stopLoss: "1.1000000000123", takeProfit: "1.5", riskRewardRatio: account === "A" ? "1.97" : "3.2", actualCandles: lookback, complete: true, reason: null };
}

export function nativePlanItem(i: number): NativePlanListItemDto {
  const planStatus: ExtremeRRPlanStatus = i % 50 === 9 ? "ERROR" : i % 10 === 4 ? "PENDING" : "READY";
  const direction = i % 3 === 0 ? "SHORT" : "LONG";
  const triggeredAt = new Date(FIXTURE_T0 - (i === 21 || i === 22 ? 21 : i) * 60_000).toISOString();
  const status = INTEGRITY_CYCLE[i % INTEGRITY_CYCLE.length];
  const ready = planStatus === "READY";
  return {
    alertId: fixtureAlertId(i),
    symbol: i === 7 ? UNICODE_SYMBOL : `SYM${String(i).padStart(4, "0")}USDT`,
    sourceTimeframe: TFS[i % TFS.length],
    triggeredAt,
    plan: {
      state: ready ? "SELECTED" : "PLAN_NOT_READY",
      alertSource: "NATIVE",
      planStatus,
      selectedLookback: 100,
      direction,
      entryPrice: "1.23450000000001",
      stopLoss: ready ? "1.1000000000123" : null,
      takeProfit: ready ? "1.5" : null,
      riskRewardRatio: ready ? "1.97" : null,
      actualCandles: ready ? 100 : null,
      complete: ready ? true : null,
      reason: ready ? null : planStatus === "PENDING" ? "Plan is PENDING" : "fixture error",
      cutoffAt: triggeredAt,
      execution: NATIVE_PLAN_EXECUTION_STATUS,
    },
    availableLookbacks: ready ? [50, 100, 200, 300] : [],
    accountDefaults: [preview("A", 100, planStatus, i), preview("B", 300, planStatus, i)],
    executionIntegrity: {
      status,
      reason: status === "UNREADABLE" ? LONG_REASON : `fixture ${status}`,
      barOpenTime: new Date(FIXTURE_T0 - i * 60_000 - 15 * 60_000).toISOString(),
    },
  };
}

export const nativePlanItems = (count = 525): NativePlanListItemDto[] => Array.from({ length: count }, (_, i) => nativePlanItem(i));

function counts(items: readonly NativePlanListItemDto[]): NativePlanStatusCounts {
  const byPlanStatus = Object.fromEntries(EXTREME_RR_STATUSES.map((s) => [s, 0])) as Record<ExtremeRRPlanStatus, number>;
  for (const item of items) byPlanStatus[item.plan.planStatus] += 1;
  return { total: items.length, byPlanStatus };
}

/** Pages the fixture the way the backend does; records every request it receives. */
export function fakeNativePlanServer(all: readonly NativePlanListItemDto[]) {
  const ordered = [...all].sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt) || (a.alertId < b.alertId ? 1 : a.alertId > b.alertId ? -1 : 0));
  const requests: string[] = [];
  const serve = (query: string): NativePlanPageDto => {
    requests.push(query);
    const params = new URLSearchParams(query.replace(/^\?/, ""));
    const pageSize = Number(params.get("pageSize") ?? 50);
    const q = params.get("q");
    const filtered = ordered.filter(
      (item) =>
        (q === null || item.symbol.toLowerCase().includes(q.toLowerCase()) || item.alertId === q) &&
        (params.get("sourceTimeframe") === null || item.sourceTimeframe === params.get("sourceTimeframe")) &&
        (params.get("direction") === null || item.plan.direction === params.get("direction")) &&
        (params.get("planStatus") === null || item.plan.planStatus === params.get("planStatus"))
    );
    const cursor = params.get("cursor");
    const start = cursor === null ? 0 : filtered.findIndex((item) => item.alertId === cursor) + 1;
    const integrity = params.get("integrity") as NativePlanIntegrityFilter | null;
    let page: NativePlanListItemDto[];
    // Index of the last row this request returned (or, with the integrity filter, examined).
    let last: number;
    let integrityScan = null;
    if (integrity === null) {
      page = filtered.slice(start, start + pageSize);
      last = start + page.length - 1;
    } else {
      page = [];
      last = start - 1;
      for (let i = start; i < filtered.length && i < start + NATIVE_PLAN_INTEGRITY_SCAN_LIMIT; i += 1) {
        last = i;
        if (nativeIntegrityMatches(integrity, filtered[i].executionIntegrity.status)) page.push(filtered[i]);
        if (page.length === pageSize) break;
      }
    }
    const hasMore = last >= 0 && last < filtered.length - 1;
    if (integrity !== null) integrityScan = { scanned: last - start + 1, limit: NATIVE_PLAN_INTEGRITY_SCAN_LIMIT, exhausted: !hasMore };
    return {
      nativeExecutionEnabled: false,
      accountPolicies: POLICIES,
      items: page,
      pagination: {
        order: "TRIGGERED_AT_DESC",
        pageSize,
        cursor,
        nextCursor: hasMore ? filtered[last].alertId : null,
        hasMore,
        totalMatching: integrity === null ? filtered.length : null,
        integrityScan,
      },
      summary: { allNativePlans: counts(all), matchingFilters: counts(filtered) },
    };
  };
  return { serve, requests, ordered };
}
