import type { SelectedPlanSummary } from "@trading-alert-dashboard/shared";
import { presentSelectedPlan } from "../../features/plans/selectedPlanPresentation";
import { Badge } from "../ui/Badge";

/** The selected, frozen plan as read-only rows. It has no controls: the Trade Plan owns the choice. */
export function SelectedPlanSummaryView({ summary }: { summary: SelectedPlanSummary | null }) {
  const shown = presentSelectedPlan(summary);
  return (
    <div className="space-y-2" data-testid="selected-plan-summary">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-slate-200">{shown.headline}</span>
        {summary?.alertSource === "NATIVE" && <Badge tone="yellow">PLANNING ONLY</Badge>}
      </div>
      {shown.rows.length === 0 ? (
        <p className="text-sm text-slate-500">{shown.status}</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {shown.rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-xs uppercase tracking-wide text-slate-500">{row.label}</dt>
              <dd className="text-right text-slate-200">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
