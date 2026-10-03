import { useEffect, useState } from "react";
import { selectedPlanSummaryOf, type ExtremeRRPlanDto } from "@trading-alert-dashboard/shared";
import { extremeRRApi } from "../../api/extreme-rr.api";
import { SelectedPlanSummaryView } from "../../components/alerts/SelectedPlanSummaryView";
import { Card } from "../../components/ui/Card";
import type { Alert } from "../../types/alert";

/**
 * The selected plan on a Native alert's Execution tab. READ ONLY: one GET of
 * the plan, no generation, no write. It shows the selected, frozen plan for
 * what it is — planning only; the tab itself states that execution is disabled.
 */
export function NativeExecutionPlanPanel({ alert }: { alert: Alert }) {
  const [plan, setPlan] = useState<ExtremeRRPlanDto | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const directional = alert.signal === "LONG" || alert.signal === "SHORT";

  useEffect(() => {
    if (!directional) return;
    let live = true;
    extremeRRApi
      .getForAlert(alert.id)
      .then((loaded) => live && setPlan(loaded))
      .catch((caught) => live && setError(caught instanceof Error ? caught.message : "Failed to load the plan"));
    return () => {
      live = false;
    };
  }, [alert.id, directional]);

  return (
    <Card className="space-y-3 p-4">
      {!directional ? (
        <p className="text-sm text-slate-500">Extreme RR plans exist for LONG and SHORT alerts only.</p>
      ) : error !== null ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : plan === undefined ? (
        <p className="text-sm text-slate-500">Loading plan…</p>
      ) : (
        <SelectedPlanSummaryView summary={plan === null ? null : selectedPlanSummaryOf(plan)} />
      )}
    </Card>
  );
}
