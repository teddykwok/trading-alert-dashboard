import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { NATIVE_PLAN_EXECUTION_STATUS, type NativePlanListDto } from "@trading-alert-dashboard/shared";
import { extremeRRApi } from "../../api/extreme-rr.api";
import {
  NATIVE_EXECUTION_DISABLED_LABEL,
  NATIVE_PLANNING_ONLY_LABEL,
  nativePlanStatusLabel,
  nativePlanStatusTone,
  presentNativeAccountDefault,
  presentNativeAccountPolicy,
  type NativeAccountDefaultRow,
} from "../../features/plans/nativeAccountDefaults";
import { SelectedPlanSummaryView } from "../alerts/SelectedPlanSummaryView";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";

/**
 * Native scanner plans — READ ONLY, for every account alike.
 *
 * Trading Control displays the frozen Extreme RR plan of recent Native alerts
 * (generated automatically after delivery, or on demand), the plan's global
 * selected lookback, and each account's DEFAULT Native lookback preview —
 * UNSET unless configured. It offers no lookback selector (the Trade Plan owns
 * that choice) and no action: Native plans are planning only and are refused
 * by every execution path, for every source timeframe.
 */
function AccountDefaultRow({ row }: { row: NativeAccountDefaultRow }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 text-xs" data-testid="native-account-default">
      <span className="text-slate-400">{row.label}</span>
      <Badge tone={row.tone}>{row.value}</Badge>
      {row.detail !== null && <span className="text-slate-500">{row.detail}</span>}
    </div>
  );
}

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
        <Badge tone="yellow">{NATIVE_PLANNING_ONLY_LABEL}</Badge>
        <Badge tone="red">{NATIVE_EXECUTION_DISABLED_LABEL}</Badge>
      </div>
      <p className="text-xs text-slate-500">{NATIVE_PLAN_EXECUTION_STATUS}</p>
      {error !== null ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : list === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <>
          <div className="space-y-1" data-testid="native-account-policies">
            {list.accountPolicies.map((policy) => (
              <AccountDefaultRow key={policy.account} row={presentNativeAccountPolicy(policy)} />
            ))}
          </div>
          {list.items.length === 0 ? (
            <p className="text-sm text-slate-500">No Native alert has a plan yet. New Native alerts are planned automatically after delivery; any Native alert can be planned on demand from its Trade Plan.</p>
          ) : (
            <ul className="space-y-3">
              {list.items.map((item) => (
                <li key={item.alertId} className="space-y-2 rounded-lg border border-surface-border p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-slate-400">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Link to={`/alerts/${item.alertId}`} className="font-semibold text-slate-200 hover:underline">
                        {item.symbol}
                      </Link>
                      <Badge tone={item.plan.direction === "LONG" ? "green" : "red"}>{item.plan.direction}</Badge>
                      <span>source TF {item.sourceTimeframe ?? "—"}</span>
                      <span>Entry {item.plan.entryPrice}</span>
                    </div>
                    <Badge tone={nativePlanStatusTone(item.plan.planStatus)}>{nativePlanStatusLabel(item.plan.planStatus)}</Badge>
                  </div>
                  <p className="text-xs text-slate-500">
                    Available lookbacks: {item.availableLookbacks.length > 0 ? item.availableLookbacks.join(" / ") : "none yet"}
                  </p>
                  <SelectedPlanSummaryView summary={item.plan} />
                  <div className="space-y-1">
                    {item.accountDefaults.map((preview) => (
                      <AccountDefaultRow key={preview.account} row={presentNativeAccountDefault(preview)} />
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
