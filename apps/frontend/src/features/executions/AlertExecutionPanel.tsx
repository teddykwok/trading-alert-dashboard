import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { executionsApi, type ExecutionDetail } from "../../api/executions.api";
import { extremeRRApi } from "../../api/extreme-rr.api";
import type { Alert, ExtremeRRPlanDto } from "@trading-alert-dashboard/shared";
import { describeExecutionReason } from "./executionReason";
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
export function AlertExecutionPanel({ alert }: { alert: Alert }) {
  const alertId = alert.id;
  const [execution, setExecution] = useState<ExecutionDetail | null>(null);
  const [plan, setPlan] = useState<ExtremeRRPlanDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The plan is the ONE pre-execution artefact this system persists. When no
      // execution exists it is the only authoritative evidence available, so it
      // is read here rather than leaving the operator with a blank panel.
      const [found, foundPlan] = await Promise.all([
        executionsApi.forAlert(alertId),
        extremeRRApi.getForAlert(alertId).catch(() => null),
      ]);
      setExecution(found);
      setPlan(foundPlan);
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
        <h2 className="text-sm font-semibold text-slate-200">Not executed</h2>
        <p className="mt-1 text-sm text-slate-400">
          No execution was created for this alert, so no order was ever sent to the exchange.
        </p>
        <dl className="mt-3 grid gap-x-8 md:grid-cols-2">
          <FieldRow label="Reason">{describeMissingExecution(alert, plan)}</FieldRow>
          <FieldRow label="Extreme RR plan">
            {plan ? plan.status : <span className="text-slate-500">Not generated</span>}
          </FieldRow>
        </dl>
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
        <FieldRow label="Decision reason">{renderDecisionReason(execution)}</FieldRow>
        <FieldRow label="Execution">
          <Link className="text-blue-400 hover:underline" to={`/executions/${execution.id}`}>
            Open execution
          </Link>
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

/**
 * The friendly sentence for an execution's own decision, from the SHARED
 * vocabulary the Executions table and Trading Control already use.
 *
 * Returns an em dash rather than inventing text: a healthy execution carries a
 * reason code too, and rendering it here would report a problem for a trade
 * that is working.
 */
function renderDecisionReason(execution: ExecutionDetail) {
  const reason = describeExecutionReason({
    status: execution.status,
    reasonCode: execution.decisionReasonCode,
    symbol: execution.symbol,
    direction: execution.direction,
  });
  if (!reason) return <span className="text-slate-500">—</span>;
  return (
    <span title={execution.decisionReasonCode ?? undefined} className="text-slate-200">
      {reason}
    </span>
  );
}

/**
 * Why no execution exists — using ONLY what this system actually persisted.
 *
 * Two of these answers are structural facts, not inferences: a non-directional
 * alert never gets an Extreme RR plan, and without a READY plan there is
 * nothing for the executor to act on. Both are visible in stored state.
 *
 * The last case is the honest one. When a plan IS ready and still produced no
 * execution, the executor's refusal — no usable candidate, an incomplete
 * candidate, an unavailable profile, a missing authorization, a margin plan
 * that would not resolve — is only ever LOGGED. It is not written to any table,
 * so it cannot be recovered for a historical alert. Saying so is better than
 * reconstructing a plausible reason from timestamps and status, which would
 * look authoritative and could easily be wrong.
 */
function describeMissingExecution(alert: Alert, plan: ExtremeRRPlanDto | null) {
  if (alert.signal !== "LONG" && alert.signal !== "SHORT") {
    return <span className="text-slate-300">This alert is not directional, so no trade plan is generated for it.</span>;
  }
  if (!plan) {
    return <span className="text-slate-300">No Extreme RR plan was generated, so nothing reached execution.</span>;
  }
  if (plan.status === "PENDING") {
    return <span className="text-slate-300">The Extreme RR plan is still being generated.</span>;
  }
  if (plan.status === "ERROR" || plan.status === "INVALID") {
    return (
      <span className="text-slate-300">
        The Extreme RR plan is {plan.status}
        {plan.errorReason ? `: ${plan.errorReason}` : ", so nothing reached execution."}
      </span>
    );
  }
  // The plan was READY. If the executor recorded a refusal, that recorded
  // verdict is the answer — it is what was true when the decision was made,
  // which is exactly what cannot be reconstructed afterwards.
  const outcome = plan.executionOutcome;
  if (outcome && !outcome.handled) {
    const reason =
      describeExecutionReason({
        // A pre-execution refusal has no execution status of its own. SKIPPED
        // is passed purely so the shared vocabulary treats the code as a
        // refusal worth wording; nothing here creates or implies an execution.
        status: "SKIPPED",
        reasonCode: outcome.reasonCode,
        symbol: alert.symbol,
        direction: alert.signal,
      }) ?? outcome.message;

    return (
      <span className="text-slate-300" title={outcome.reasonCode ?? undefined}>
        {reason}
        {/* The shared formatter, never a locally constructed date. This panel
            is deliberately barred from date construction: that ban is what
            stops a reason being reconstructed from timing, and merely
            displaying a stored evaluatedAt must not become the exception that
            erodes it. */}
        <span className="text-slate-500"> (evaluated <TimestampValue value={outcome.evaluatedAt} />)</span>
      </span>
    );
  }

  return (
    <span className="text-slate-400">
      Reason unavailable — the plan was READY but no pre-execution decision is persisted for this alert.
    </span>
  );
}
