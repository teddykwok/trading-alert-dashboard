import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { executionsApi, type ExecutionDetail } from "../../api/executions.api";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { DecimalValue, FieldRow, IntegerValue, StatusBadge, TimestampValue } from "./ExecutionValue";
import {
  presentExecutionStatus,
  presentProtectionState,
  presentSafetyDecision,
} from "./executionPresentation";

/**
 * Phase 8 — the Execution tab inside Alert Detail.
 *
 * Purely a read of persisted state: opening this tab performs a single GET and
 * creates nothing. An alert with no execution gets a neutral empty state — the
 * absence of a record is NOT evidence that the alert was skipped, and it is
 * never presented as such.
 */
export function AlertExecutionPanel({ alertId }: { alertId: string }) {
  const [execution, setExecution] = useState<ExecutionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setExecution(await executionsApi.forAlert(alertId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load the execution record.");
    } finally {
      setLoading(false);
    }
  }, [alertId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Card className="p-4">
        <p className="text-sm text-slate-400">Loading execution record…</p>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="p-4">
        <p className="text-sm text-red-400">{error}</p>
        <Button type="button" className="mt-2" onClick={() => void load()}>
          Retry
        </Button>
      </Card>
    );
  }

  if (!execution) {
    return (
      <Card className="p-4">
        <h2 className="text-sm font-semibold text-slate-200">No execution record</h2>
        <p className="mt-1 text-sm text-slate-400">
          No automated execution record exists for this alert. That means nothing was recorded here — it does
          not by itself indicate that the alert was skipped or rejected.
        </p>
      </Card>
    );
  }

  const latestAdmission = execution.safetyAdmissions[0] ?? null;

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-200">Execution</h2>
        <StatusBadge presentation={presentExecutionStatus(execution.status)} />
        <StatusBadge presentation={presentProtectionState(execution.protection?.state ?? null)} />
        {execution.requiresManualIntervention ? <Badge tone="red">! Manual intervention</Badge> : null}
      </div>

      <dl className="grid gap-x-8 md:grid-cols-2">
        <FieldRow label="Execution profile">
          {execution.profile.name}
          <span className="ml-1 text-xs text-slate-500">{execution.profile.environment}</span>
        </FieldRow>
        <FieldRow label="Safety decision">
          {latestAdmission ? (
            <>
              <StatusBadge presentation={presentSafetyDecision(latestAdmission.decision)} />
              {latestAdmission.reasonCode ? (
                <span className="ml-1 text-xs text-slate-400">{latestAdmission.reasonCode}</span>
              ) : null}
            </>
          ) : (
            <span className="text-slate-500">—</span>
          )}
        </FieldRow>
        <FieldRow label="Signal time"><TimestampValue value={execution.signalTriggeredAt} /></FieldRow>
        <FieldRow label="Selected lookback"><IntegerValue value={execution.selectedLookback} /></FieldRow>
        <FieldRow label="Planned risk"><DecimalValue value={execution.planned.riskBudgetUsd} /></FieldRow>
        <FieldRow label="Planned maximum margin">
          <DecimalValue value={execution.planned.maximumIsolatedMargin} />
        </FieldRow>
        <FieldRow label="Last reconciled"><TimestampValue value={execution.lastReconciledAt} /></FieldRow>
      </dl>

      <Link
        to={`/executions/${execution.id}`}
        className="mt-3 inline-block rounded text-sm text-blue-400 underline focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        Open full execution detail
      </Link>
    </Card>
  );
}
