import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { NATIVE_PLAN_EXECUTION_STATUS, type NativePlanListDto } from "@trading-alert-dashboard/shared";
import { extremeRRApi } from "../../api/extreme-rr.api";
import { SelectedPlanSummaryView } from "../alerts/SelectedPlanSummaryView";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";

/**
 * Native scanner plans — READ ONLY, for every account alike.
 *
 * Trading Control displays the selected, frozen Extreme RR plan of recent
 * Native alerts so the operator can see what the planner chose. It offers no
 * lookback selector (the Trade Plan owns that choice) and no action: Native
 * plans are planning only and are refused by every execution path, for every
 * source timeframe. Not account-scoped, because no account can execute one.
 */
export function NativePlansCard() {
  const [list, setList] = useState<NativePlanListDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    extremeRRApi
      .listNativePlans()
      .then((loaded) => live && setList(loaded))
      .catch((caught) => live && setError(caught instanceof Error ? caught.message : "Failed to load Native plans"));
    return () => {
      live = false;
    };
  }, []);

  return (
    <Card className="space-y-3 p-4" data-testid="native-plans-card">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Native plans (read-only)</h2>
        <Badge tone="red">{NATIVE_PLAN_EXECUTION_STATUS}</Badge>
      </div>
      {error !== null ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : list === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : list.items.length === 0 ? (
        <p className="text-sm text-slate-500">No Native alert has a generated plan yet. Plans are generated on demand from an alert&apos;s Trade Plan.</p>
      ) : (
        <ul className="space-y-3">
          {list.items.map((item) => (
            <li key={item.alertId} className="rounded-lg border border-surface-border p-3">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-xs text-slate-400">
                <Link to={`/alerts/${item.alertId}`} className="font-semibold text-slate-200 hover:underline">
                  {item.symbol}
                </Link>
                <span>source TF {item.sourceTimeframe ?? "—"}</span>
              </div>
              <SelectedPlanSummaryView summary={item.plan} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
