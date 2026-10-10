import { useEffect, useState } from "react";
import { NATIVE_PLAN_EXECUTION_STATUS, type NativePlanPageDto } from "@trading-alert-dashboard/shared";
import { extremeRRApi } from "../../api/extreme-rr.api";
import { nativePlannerApi, presentNativePlannerStatus, type NativePlannerStatusDto } from "../../api/nativePlanner.api";
import { NATIVE_EXECUTION_DISABLED_LABEL, NATIVE_PLANNING_ONLY_LABEL, presentNativeAccountPolicy } from "../../features/plans/nativeAccountDefaults";
import { asNativePlanPage, planStatusCountViews, summarizePageIntegrity } from "../../features/plans/nativePlanTable";
import { hasActiveNativePlanQuery } from "../../features/plans/nativePlanQuery";
import { useNativePlanPage, type NativePlanPageView } from "../../hooks/useNativePlanPage";
import type { CancellableFetcher } from "../../utils/latestRequest";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";
import { AccountDefaultRow } from "./NativePlanDetail";
import { NativePlanTable } from "./NativePlanTable";

/**
 * Native scanner plans — READ ONLY, for every account alike.
 *
 * The top of the card is the operator summary: Native execution's state (hard
 * disabled, shown as a safety fact, not an error), planning-only mode, each
 * account's DEFAULT planning lookback (built-in A 100 / B 300 unless
 * overridden; a lookback window, never a risk amount), the planner worker, and
 * counts, each labelled with exactly the scope it covers. Below it, the Native
 * plan table: search, filters, pages and expandable details for any number of
 * plans. Native plans are planning only and are refused by every execution
 * path, for every source timeframe; integrity grants nothing, even ELIGIBLE.
 */

// Module level, so the table's loader always holds the same read-only function.
const readNativePlanPage: CancellableFetcher<NativePlanPageDto> = async (query, signal) => asNativePlanPage(await extremeRRApi.listNativePlanPage(query, signal));

function Count({ label, count, tone }: { label: string; count: number; tone: "green" | "red" | "yellow" | "gray" | "blue" }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <Badge tone={tone}>{label}</Badge>
      <span className="font-semibold tabular-nums text-slate-100">{count}</span>
    </span>
  );
}

export function NativeSafetySummary({ view, planner, plannerUnreachable }: { view: NativePlanPageView; planner: NativePlannerStatusDto | null; plannerUnreachable: boolean }) {
  const list = view.latest;
  const plannerShown = presentNativePlannerStatus(planner, plannerUnreachable);
  const integrity = list === null ? null : summarizePageIntegrity(list.items);
  // The type says false; a payload saying anything else is a fault and is shown as one.
  const flagFault = list !== null && list.nativeExecutionEnabled !== false;
  return (
    <section aria-label="Native safety and planning summary" className="grid gap-3 lg:grid-cols-2">
      <div className="min-w-0 space-y-2 rounded-lg border-2 border-sky-400/50 bg-sky-500/10 p-3" role="status" data-testid="native-execution-state">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-sky-300">Native execution</p>
        <p className="text-base font-bold tracking-wide text-sky-100">{NATIVE_EXECUTION_DISABLED_LABEL}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="yellow">{NATIVE_PLANNING_ONLY_LABEL}</Badge>
          <span className="text-xs text-sky-100/80">{NATIVE_PLAN_EXECUTION_STATUS}</span>
        </div>
        <p className="text-xs text-slate-400">Hard-disabled in code. Nothing on this page can place, change or cancel an order.</p>
        {flagFault && (
          <p className="rounded border border-red-500/50 bg-red-500/10 p-2 text-xs font-semibold text-red-300" role="alert">
            The API reported a Native execution flag other than false. Treat this as a fault and stop.
          </p>
        )}
      </div>

      <div className="min-w-0 space-y-2 rounded-lg border border-surface-border p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Account planning defaults · lookback windows, not risk amounts</p>
        {list === null ? (
          <p className="text-xs text-slate-500">Loading…</p>
        ) : (
          <div className="space-y-1" data-testid="native-account-policies">
            {list.accountPolicies.map((policy) => (
              <AccountDefaultRow key={policy.account} row={presentNativeAccountPolicy(policy)} />
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-baseline gap-2 text-xs" data-testid="native-planner-status">
          <span className="text-slate-400">Planner worker</span>
          <Badge tone={plannerShown.tone} title={planner?.worker.reason}>
            {plannerShown.label}
          </Badge>
          <span className="min-w-0 break-words text-slate-500">{plannerShown.detail}</span>
        </div>
      </div>

      <div className="min-w-0 space-y-2 rounded-lg border border-surface-border p-3 lg:col-span-2" data-testid="native-plan-counts">
        {list === null ? (
          <p className="text-xs text-slate-500">Counting…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
              <span className="text-slate-400">
                All Native plans <span className="font-semibold tabular-nums text-slate-100">{list.summary.allNativePlans.total}</span>
              </span>
              {planStatusCountViews(list.summary.allNativePlans).map((entry) => (
                <Count key={entry.status} label={entry.label} count={entry.count} tone={entry.tone} />
              ))}
            </div>
            {hasActiveNativePlanQuery(view.filters) && (
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs" data-testid="native-plan-counts-matching">
                <span className="text-slate-400">
                  Matching search and filters{view.filters.integrity !== "" ? " (integrity not counted)" : ""}{" "}
                  <span className="font-semibold tabular-nums text-slate-100">{list.summary.matchingFilters.total}</span>
                </span>
                {planStatusCountViews(list.summary.matchingFilters).map((entry) => (
                  <Count key={entry.status} label={entry.label} count={entry.count} tone={entry.tone} />
                ))}
              </div>
            )}
            {integrity !== null && (
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs" data-testid="native-plan-counts-integrity">
                <span className="text-slate-400">
                  Integrity · this page only ({integrity.total} plan{integrity.total === 1 ? "" : "s"})
                </span>
                <Count label="ELIGIBLE" count={integrity.healthy} tone="green" />
                <Count label="PENDING BAR CLOSE" count={integrity.pending} tone="blue" />
                <Count label="! FAIL-CLOSED" count={integrity.failClosed} tone={integrity.failClosed > 0 ? "red" : "gray"} />
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function NativePlansCard() {
  const view = useNativePlanPage(readNativePlanPage);
  const [planner, setPlanner] = useState<NativePlannerStatusDto | null>(null);
  const [plannerUnreachable, setPlannerUnreachable] = useState(false);

  useEffect(() => {
    let live = true;
    // Read-only health of the separate planner worker (never starts it).
    nativePlannerApi
      .status()
      .then((loaded) => live && setPlanner(loaded))
      .catch(() => live && setPlannerUnreachable(true));
    return () => {
      live = false;
    };
  }, []);

  return (
    <Card className="space-y-4 p-4" data-testid="native-plans-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Native plans (read-only)</h2>
        <span className="text-xs text-slate-500">Planning inspection only</span>
      </div>
      <NativeSafetySummary view={view} planner={planner} plannerUnreachable={plannerUnreachable} />
      <NativePlanTable view={view} />
    </Card>
  );
}
