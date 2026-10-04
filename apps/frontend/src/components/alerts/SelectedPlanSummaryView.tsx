import type { SelectedPlanSummary } from "@trading-alert-dashboard/shared";
import { DECIMAL_ROW_LABELS, presentSelectedPlan } from "../../features/plans/selectedPlanPresentation";
import { Badge } from "../ui/Badge";
import { DecimalText } from "../ui/DecimalText";

/** The selected, frozen plan as read-only rows. It has no controls: the Trade Plan owns the choice. */
export function SelectedPlanSummaryView({ summary }: { summary: SelectedPlanSummary | null }) {
  const shown = presentSelectedPlan(summary);
  return (
    <div className="min-w-0 space-y-2" data-testid="selected-plan-summary">
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
              <dd className="min-w-0 text-right text-slate-200">
                {DECIMAL_ROW_LABELS.includes(row.label) ? <DecimalText value={row.value} /> : <span className="break-words">{row.value}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
