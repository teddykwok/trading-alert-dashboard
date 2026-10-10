import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { executionsApi, type ExecutionDetail, type ExecutionListItem, type ExecutionTimelineEntry } from "../../api/executions.api";
import { deriveExecutionLifecycle } from "../../features/executions/executionLifecycle";
import { describeExecutionReason } from "../../features/executions/executionReason";
import { DecimalValue, FieldRow, MoneyValue, StatusBadge, TimestampValue } from "../../features/executions/ExecutionValue";
import { presentExecutionStatus, presentExitReason, presentProtectionState } from "../../features/executions/executionPresentation";
import { UNKNOWN_DISPLAY } from "../../features/executions/executionFormat";
import { Button } from "../ui/Button";
import { ExecutionLifecycle } from "./ExecutionLifecycle";

/**
 * One execution, expanded in the journal: its lifecycle and the facts an
 * operator scans first, with a link to the full detail page. READ ONLY: it
 * loads the stored detail and timeline (GET) when the row is opened and never
 * changes anything; Retry only repeats that read.
 */

export function ExecutionRowDetailView({ item, detail, timeline }: { item: ExecutionListItem; detail: ExecutionDetail; timeline: readonly ExecutionTimelineEntry[] | null }) {
  const reason = describeExecutionReason({ status: detail.status, reasonCode: detail.decisionReasonCode, symbol: detail.symbol, direction: detail.direction });
  return (
    <div className="min-w-0 space-y-3" data-testid="execution-row-detail">
      <ExecutionLifecycle steps={deriveExecutionLifecycle(detail, timeline)} />
      <dl className="grid gap-x-8 text-xs md:grid-cols-2 xl:grid-cols-3">
        <FieldRow label="Account (profile)">
          {detail.profile.name} · {detail.profile.environment}
        </FieldRow>
        <FieldRow label="Signal source">{item.alertSource ?? UNKNOWN_DISPLAY}</FieldRow>
        <FieldRow label="Status">
          <StatusBadge presentation={presentExecutionStatus(detail.status)} />
        </FieldRow>
        <FieldRow label="Protection">
          <StatusBadge presentation={presentProtectionState(detail.protection?.state ?? null)} />
        </FieldRow>
        <FieldRow label="Signal time">
          <TimestampValue value={detail.signalTriggeredAt} />
        </FieldRow>
        <FieldRow label="Last reconciled">
          <TimestampValue value={detail.lastReconciledAt} />
        </FieldRow>
        <FieldRow label="Planned entry / SL / TP">
          <DecimalValue value={detail.planned.entryPrice} /> / <DecimalValue value={detail.planned.executableStopLoss} /> / <DecimalValue value={detail.planned.takeProfit} />
        </FieldRow>
        <FieldRow label="Average fill / filled qty">
          <DecimalValue value={detail.actual.averageFillPrice} /> / <DecimalValue value={detail.actual.filledQuantity} />
        </FieldRow>
        <FieldRow label="Exit">{presentExitReason(detail.actual.exitReason, detail.status) ?? UNKNOWN_DISPLAY}</FieldRow>
        <FieldRow label="Realized PnL">
          <MoneyValue value={detail.actual.realizedPnl} />
        </FieldRow>
        <FieldRow label="Decision reason">
          <span className="break-words" title={detail.decisionReasonCode ?? undefined}>
            {reason ?? detail.decisionReasonCode ?? UNKNOWN_DISPLAY}
          </span>
        </FieldRow>
        <FieldRow label="Manual intervention">{detail.requiresManualIntervention ? "Required" : "No"}</FieldRow>
      </dl>
      {detail.sanitizedMessage ? <p className="break-words text-xs text-slate-400">{detail.sanitizedMessage}</p> : null}
      <Link to={`/executions/${detail.id}`} className="inline-block text-xs text-blue-400 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
        Open the full execution detail
      </Link>
    </div>
  );
}

export function ExecutionRowDetail({ item }: { item: ExecutionListItem }) {
  const [loaded, setLoaded] = useState<{ detail: ExecutionDetail; timeline: ExecutionTimelineEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    Promise.all([executionsApi.detail(item.id), executionsApi.timeline(item.id)])
      .then(([detail, timeline]) => {
        if (live) setLoaded({ detail, timeline });
      })
      .catch((caught) => {
        if (live) setError(caught instanceof Error ? caught.message : "Failed to load the execution.");
      });
    return () => {
      live = false;
    };
    // updatedAt: a refreshed list row with newer state reloads its open detail.
  }, [item.id, item.updatedAt, attempt]);

  if (error !== null) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
        <span className="break-words text-red-400">The execution detail could not be loaded: {error}</span>
        <Button type="button" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
          Retry
        </Button>
      </div>
    );
  }
  if (loaded === null) {
    return (
      <p className="text-sm text-slate-400" role="status">
        Loading the execution lifecycle…
      </p>
    );
  }
  return <ExecutionRowDetailView item={item} detail={loaded.detail} timeline={loaded.timeline} />;
}
