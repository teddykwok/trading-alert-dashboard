import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  executionsApi,
  type ExecutionDetail,
  type ExecutionOrder,
  type ExecutionTimelineEntry,
} from "../api/executions.api";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Disclosure } from "../components/ui/Disclosure";
import { EmptyState } from "../components/ui/EmptyState";
import {
  CopyableId,
  DecimalValue,
  FieldRow,
  IntegerValue,
  MoneyValue,
  StatusBadge,
  TimestampValue,
  ValueCell,
} from "../features/executions/ExecutionValue";
import { presentTakeProfitExecution } from "../features/executions/takeProfitExecution";
import { UNKNOWN_DISPLAY, decimalDifference, displayNetPnl } from "../features/executions/executionFormat";
import {
  presentAlertDelivery,
  presentExecutionStatus,
  presentExitReason,
  presentMarginAdjustment,
  presentOrderStatus,
  presentProtectionState,
  presentSafetyDecision,
} from "../features/executions/executionPresentation";

/**
 * Phase 8 — execution detail.
 *
 * Read-only throughout. Nothing on this page can submit, cancel or change
 * anything: a red badge reports a state, it never performs a safety action.
 */
export function ExecutionDetailPage() {
  const { executionId = "" } = useParams();
  const [detail, setDetail] = useState<ExecutionDetail | null>(null);
  const [timeline, setTimeline] = useState<ExecutionTimelineEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The timeline is fetched only here, never as part of the global list.
      const [detailResult, timelineResult] = await Promise.all([
        executionsApi.detail(executionId),
        executionsApi.timeline(executionId),
      ]);
      setDetail(detailResult);
      setTimeline(timelineResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load the execution.");
    } finally {
      setLoading(false);
    }
  }, [executionId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !detail) {
    return (
      <Card className="p-6">
        <p className="text-sm text-slate-400">Loading execution…</p>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="p-6">
        <p className="text-sm text-red-400">{error}</p>
        <Button type="button" className="mt-3" onClick={() => void load()}>
          Retry
        </Button>
      </Card>
    );
  }

  if (!detail) return <EmptyState title="Execution not found" description="No execution matches this id." />;

  const status = presentExecutionStatus(detail.status);
  const protection = presentProtectionState(detail.protection?.state ?? null);
  const netPnl = displayNetPnl(detail.actual);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">
            {detail.symbol} <span className="text-slate-400">{detail.direction}</span>
          </h1>
          <p className="text-xs text-slate-400">
            {detail.profile.name} · {detail.profile.environment} · position side {detail.positionSide}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge presentation={status} />
          <StatusBadge presentation={protection} />
          <Link to="/executions" className="text-xs text-blue-400 underline">
            Back to executions
          </Link>
        </div>
      </header>

      {(status.critical || protection?.critical || detail.requiresManualIntervention) && (
        <Card className="border-red-500/40 bg-red-500/10 p-3">
          <p className="text-sm font-semibold text-red-300">This execution needs a human.</p>
          <p className="text-xs text-red-200/80">
            {detail.sanitizedMessage ?? "Review the protection and timeline sections below."} This page is
            read-only — it reports state and performs no action.
          </p>
        </Card>
      )}

      {/* 1. Overview */}
      <Section title="Overview">
        <dl className="grid gap-x-8 md:grid-cols-2">
          <FieldRow label="Execution status"><StatusBadge presentation={status} /></FieldRow>
          <FieldRow label="Protection status"><StatusBadge presentation={protection} /></FieldRow>
          <FieldRow label="Signal time"><TimestampValue value={detail.signalTriggeredAt} /></FieldRow>
          <FieldRow label="Created"><TimestampValue value={detail.createdAt} /></FieldRow>
          <FieldRow label="Selected lookback"><IntegerValue value={detail.selectedLookback} /></FieldRow>
          <FieldRow label="Selected leverage"><IntegerValue value={detail.planned.selectedLeverage} /></FieldRow>
          <FieldRow label="Actual leverage"><IntegerValue value={detail.actual.actualLeverage} /></FieldRow>
          <FieldRow label="Decision reason">{detail.decisionReasonCode ?? UNKNOWN_DISPLAY}</FieldRow>
          <FieldRow label="Last reconciled"><TimestampValue value={detail.lastReconciledAt} /></FieldRow>
          <FieldRow label="Manual intervention">
            {detail.requiresManualIntervention ? <Badge tone="red">Required</Badge> : "No"}
          </FieldRow>
        </dl>
        {detail.sanitizedMessage ? (
          <p className="mt-2 text-xs text-slate-400">{detail.sanitizedMessage}</p>
        ) : null}
      </Section>

      {/* 2. Planned versus actual */}
      <Section title="Planned versus actual">
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Planned</h3>
            <dl>
              <FieldRow label="Entry price"><DecimalValue value={detail.planned.entryPrice} /></FieldRow>
              <FieldRow label="Calculated stop"><DecimalValue value={detail.planned.calculatedStopLoss} /></FieldRow>
              <FieldRow label="Executable stop"><DecimalValue value={detail.planned.executableStopLoss} /></FieldRow>
              <FieldRow label="Take profit"><DecimalValue value={detail.planned.takeProfit} /></FieldRow>
              <FieldRow label="Risk budget"><DecimalValue value={detail.planned.riskBudgetUsd} /></FieldRow>
              <FieldRow label="Raw quantity"><DecimalValue value={detail.planned.quantityRaw} /></FieldRow>
              <FieldRow label="Planned quantity"><DecimalValue value={detail.planned.quantity} /></FieldRow>
              <FieldRow label="Position notional"><DecimalValue value={detail.planned.positionNotional} /></FieldRow>
              <FieldRow label="Actual planned loss"><DecimalValue value={detail.planned.actualPlannedLoss} /></FieldRow>
              <FieldRow label="Unused risk budget"><DecimalValue value={detail.planned.unusedRiskBudget} /></FieldRow>
              <FieldRow label="Estimated initial margin"><DecimalValue value={detail.planned.estimatedInitialMargin} /></FieldRow>
              <FieldRow label="Maximum isolated margin"><DecimalValue value={detail.planned.maximumIsolatedMargin} /></FieldRow>
              <FieldRow label="Estimated liquidation"><DecimalValue value={detail.planned.estimatedLiquidationPrice} /></FieldRow>
              <FieldRow label="Required boundary"><DecimalValue value={detail.planned.requiredLiquidationBoundary} /></FieldRow>
              <FieldRow label="Expected reward ratio"><DecimalValue value={detail.planned.estimatedRewardRatio} /></FieldRow>
            </dl>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Actual</h3>
            <dl>
              <FieldRow label="Submitted entry price"><DecimalValue value={detail.actual.submittedEntryPrice} /></FieldRow>
              <FieldRow label="Average fill price"><DecimalValue value={detail.actual.averageFillPrice} /></FieldRow>
              <FieldRow label="Filled quantity"><DecimalValue value={detail.actual.filledQuantity} /></FieldRow>
              <FieldRow label="Actual isolated margin"><DecimalValue value={detail.actual.actualIsolatedMargin} /></FieldRow>
              <FieldRow label="Reported liquidation"><DecimalValue value={detail.actual.reportedLiquidationPrice} /></FieldRow>
              <FieldRow label="Exit price"><DecimalValue value={detail.actual.actualExitPrice} /></FieldRow>
              <FieldRow label="Realized PnL"><MoneyValue value={detail.actual.realizedPnl} /></FieldRow>
              <FieldRow label="Trading fees"><MoneyValue value={detail.actual.tradingFeesUsd} /></FieldRow>
              <FieldRow label="Funding PnL"><MoneyValue value={detail.actual.fundingPnlUsd} /></FieldRow>
              <FieldRow label="Net PnL" emphasis>
                <span title={netPnl.exact ?? "Not available"}>{netPnl.text}</span>
              </FieldRow>
              <FieldRow label="Exit reason">
                {presentExitReason(detail.actual.exitReason, detail.status) ?? UNKNOWN_DISPLAY}
              </FieldRow>
              <FieldRow label="First fill"><TimestampValue value={detail.actual.firstFillAt} /></FieldRow>
              <FieldRow label="Fully filled"><TimestampValue value={detail.actual.entryFilledAt} /></FieldRow>
              <FieldRow label="Protection placed"><TimestampValue value={detail.actual.protectionPlacedAt} /></FieldRow>
              <FieldRow label="Closed"><TimestampValue value={detail.actual.closedAt} /></FieldRow>
            </dl>
            {netPnl.missingComponents.length > 0 ? (
              <p className="mt-2 text-[11px] text-yellow-400">
                Net PnL is unavailable: {netPnl.missingComponents.join(", ")} unknown.
              </p>
            ) : null}
          </div>
        </div>

        <Differences detail={detail} />
      </Section>

      <TakeProfitExecutionSection detail={detail} />

      {/* 3. Entry order */}
      <Section title="Entry order">
        {detail.entryOrder ? (
          <OrderTable orders={[detail.entryOrder]} />
        ) : (
          <p className="text-sm text-slate-400">No entry order was reserved.</p>
        )}
      </Section>

      {/* 4. Protection */}
      <Section title="Protection">
        {detail.protection ? (
          <>
            <dl className="grid gap-x-8 md:grid-cols-2">
              <FieldRow label="Protection state"><StatusBadge presentation={protection} /></FieldRow>
              <FieldRow label="Confirmed open quantity"><DecimalValue value={detail.protection.confirmedOpenQuantity} /></FieldRow>
              <FieldRow label="Protected stop quantity"><DecimalValue value={detail.protection.protectedStopQuantity} /></FieldRow>
              <FieldRow label="Protected TP quantity"><DecimalValue value={detail.protection.protectedTakeProfitQuantity} /></FieldRow>
              <FieldRow label="Stop coverage gap"><DecimalValue value={detail.protection.stopCoverageGap} /></FieldRow>
              <FieldRow label="TP coverage gap"><DecimalValue value={detail.protection.takeProfitCoverageGap} /></FieldRow>
              <FieldRow label="Liquidation safety">
                {detail.protection.liquidationSafe === null ? (
                  <span className="text-slate-500">Not established</span>
                ) : detail.protection.liquidationSafe ? (
                  <Badge tone="green">Safe</Badge>
                ) : (
                  <Badge tone="red">! Unsafe buffer</Badge>
                )}
              </FieldRow>
              <FieldRow label="Verified at"><TimestampValue value={detail.protection.verifiedAt} /></FieldRow>
            </dl>
            {detail.protectionOrders.length > 0 ? (
              <div className="mt-3">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Protection generations
                </h3>
                <OrderTable orders={detail.protectionOrders} />
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-400">No protection orders were reserved.</p>
            )}
          </>
        ) : (
          <p className="text-sm text-slate-400">No confirmed exposure was recorded for this execution.</p>
        )}
      </Section>

      {/* 5. Margin adjustments */}
      <Section title="Margin adjustments">
        {detail.marginAdjustments.length === 0 ? (
          <p className="text-sm text-slate-400">No automatic margin adjustment was recorded.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-slate-400">
              <tr>
                <th scope="col" className="py-1">Attempt</th>
                <th scope="col" className="py-1">Amount</th>
                <th scope="col" className="py-1">Baseline margin</th>
                <th scope="col" className="py-1">Verified margin</th>
                <th scope="col" className="py-1">Status</th>
                <th scope="col" className="py-1">Requested</th>
                <th scope="col" className="py-1">Resolved</th>
              </tr>
            </thead>
            <tbody>
              {detail.marginAdjustments.map((intent) => (
                <tr key={intent.id} className="border-t border-surface-border/60">
                  <td className="py-1">{intent.attempt}</td>
                  <td className="py-1"><DecimalValue value={intent.amount} /></td>
                  <td className="py-1"><DecimalValue value={intent.baselineIsolatedMargin} /></td>
                  <td className="py-1"><DecimalValue value={intent.verifiedIsolatedMargin} /></td>
                  <td className="py-1"><StatusBadge presentation={presentMarginAdjustment(intent.status)} /></td>
                  <td className="py-1"><TimestampValue value={intent.requestedAt} /></td>
                  <td className="py-1"><TimestampValue value={intent.resolvedAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* 6. Safety admission */}
      <Section title="Safety admission">
        {detail.safetyAdmissions.length === 0 ? (
          <p className="text-sm text-slate-400">No safety admission was recorded.</p>
        ) : (
          detail.safetyAdmissions.map((admission) => (
            <div key={admission.id} className="border-b border-surface-border/60 py-2 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge presentation={presentSafetyDecision(admission.decision)} />
                <span className="text-xs text-slate-400">{admission.reasonCode ?? "no reason code"}</span>
                <TimestampValue value={admission.evaluatedAt} />
              </div>
              {admission.message ? <p className="mt-1 text-xs text-slate-400">{admission.message}</p> : null}
              <dl className="mt-1 grid gap-x-8 md:grid-cols-2">
                <FieldRow label="Signal age (s)"><IntegerValue value={admission.signalAgeSeconds} /></FieldRow>
                <FieldRow label="Reserved risk"><DecimalValue value={admission.reservedRiskUsd} /></FieldRow>
                <FieldRow label="Reserved margin"><DecimalValue value={admission.reservedMarginUsd} /></FieldRow>
              </dl>
              <Disclosure title="Effective limits and capacity">
                <MetadataRows value={admission.effectiveLimits} />
                <MetadataRows value={admission.capacityBefore} />
                <MetadataRows value={admission.capacityProjected} />
              </Disclosure>
            </div>
          ))
        )}
      </Section>

      {/* 7. Critical alerts */}
      <Section title="Critical alerts">
        {detail.criticalAlerts.length === 0 ? (
          <p className="text-sm text-slate-400">No critical alert was raised.</p>
        ) : (
          detail.criticalAlerts.map((alert) => (
            <div key={alert.id} className="border-b border-surface-border/60 py-2 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="red">{alert.alertType}</Badge>
                <span className="text-xs text-slate-400">{alert.reasonCode}</span>
                <StatusBadge presentation={presentAlertDelivery(alert.status)} />
                <span className="text-xs text-slate-500">{alert.attempts} attempt(s)</span>
              </div>
              <p className="mt-1 whitespace-pre-line text-xs text-slate-300">{alert.message}</p>
              <p className="mt-1 text-[11px] text-slate-500">
                Raised <TimestampValue value={alert.createdAt} /> · Delivered{" "}
                <TimestampValue value={alert.sentAt} />
              </p>
            </div>
          ))
        )}
      </Section>

      {/* 8. Timeline */}
      <Section title="Timeline">
        {timeline && timeline.length > 0 ? (
          <ol className="space-y-2">
            {timeline.map((event) => (
              <li key={event.id} className="border-l-2 border-surface-border pl-3">
                <div className="flex flex-wrap items-center gap-2">
                  {/* sequenceNumber is the authoritative order, so it is shown. */}
                  <span className="rounded bg-slate-700/60 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
                    #{event.sequenceNumber}
                  </span>
                  <span className="text-sm font-medium text-slate-100">{event.eventType}</span>
                  {event.fromStatus || event.toStatus ? (
                    <span className="text-xs text-slate-400">
                      {event.fromStatus ?? "—"} → {event.toStatus ?? "—"}
                    </span>
                  ) : null}
                  {event.reasonCode ? (
                    <span className="text-xs text-slate-400">{event.reasonCode}</span>
                  ) : null}
                  <TimestampValue value={event.createdAt} />
                </div>
                {event.message ? <p className="mt-1 text-xs text-slate-400">{event.message}</p> : null}
                {event.metadata ? (
                  <Disclosure title="Details">
                    <MetadataRows value={event.metadata} />
                  </Disclosure>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-yellow-400">
            No events are recorded for this execution. That is unexpected — every execution should have at
            least a creation event.
          </p>
        )}
      </Section>
    </div>
  );
}

/**
 * How the take profit actually executed, when it is the thing that closed the
 * trade and every input is authoritative.
 *
 * Rendered only for an owned take-profit closure. For a stop or an external
 * close the backend reports null and the whole section disappears, because
 * showing $0 and 0% there would claim a perfect exit that was never measured.
 */
function TakeProfitExecutionSection({ detail }: { detail: ExecutionDetail }) {
  const view = presentTakeProfitExecution(detail.takeProfitExecution);
  if (!view) return null;

  return (
    <Section title="Take profit execution">
      <div className="mb-3 flex items-center gap-2">
        <Badge tone={view.tone}>{view.verdictLabel}</Badge>
        <span className="text-xs text-slate-400">
          The trigger is the only price a TAKE_PROFIT_MARKET order controls; the fill is wherever
          the market was when it triggered.
        </span>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <dl>
          <FieldRow label="TP trigger"><ValueCell value={view.triggerPrice} /></FieldRow>
          <FieldRow label="Actual exit"><ValueCell value={view.actualExitPrice} /></FieldRow>
          <FieldRow label="Closed quantity"><ValueCell value={view.closedQuantity} /></FieldRow>
        </dl>

        <dl>
          <FieldRow label="Planned gross profit"><ValueCell value={view.plannedGrossProfit} /></FieldRow>
          <FieldRow label="Actual gross profit"><ValueCell value={view.actualGrossProfit} /></FieldRow>
          <FieldRow label="Gross profit shortfall"><ValueCell value={view.grossProfitShortfall} /></FieldRow>
          <FieldRow label="Exit slippage"><ValueCell value={view.slippagePrice} /></FieldRow>
          <FieldRow label="Exit slippage (USD)" emphasis>
            <ValueCell value={view.slippageUsd} />
          </FieldRow>
          <FieldRow label="Slippage ratio"><ValueCell value={view.slippageRatio} /></FieldRow>
        </dl>
      </div>

      <p className="mt-2 text-[11px] text-slate-400">
        Gross profit shortfall compares the whole plan; exit slippage isolates the trigger-to-fill
        gap alone. They differ when the entry filled away from its planned price. Positive is worse
        than the trigger, negative means the fill beat it.
      </p>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-300">{title}</h2>
      {children}
    </Card>
  );
}

/** Recognized metadata as labelled rows — never a raw JSON dump by default. */
function MetadataRows({ value }: { value: unknown }) {
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;

  return (
    <dl className="grid gap-x-6 text-xs md:grid-cols-2">
      {entries.map(([key, entry]) => (
        <div key={key} className="flex justify-between gap-3 py-0.5">
          <dt className="text-slate-500">{key}</dt>
          <dd className="break-all text-right text-slate-300">
            {entry === null || entry === undefined
              ? UNKNOWN_DISPLAY
              : typeof entry === "object"
                ? JSON.stringify(entry)
                : String(entry)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Differences are only shown when BOTH sides are known. */
function Differences({ detail }: { detail: ExecutionDetail }) {
  const rows: Array<[string, string | null]> = [
    ["Entry slippage", decimalDifference(detail.planned.entryPrice, detail.actual.averageFillPrice)],
    ["Quantity difference", decimalDifference(detail.planned.quantity, detail.actual.filledQuantity)],
    [
      "Margin difference",
      decimalDifference(detail.planned.estimatedInitialMargin, detail.actual.actualIsolatedMargin),
    ],
    [
      "Liquidation difference",
      decimalDifference(detail.planned.estimatedLiquidationPrice, detail.actual.reportedLiquidationPrice),
    ],
  ];
  const known = rows.filter(([, value]) => value !== null);
  if (known.length === 0) return null;

  return (
    <div className="mt-4 border-t border-surface-border pt-3">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Differences</h3>
      <dl className="grid gap-x-8 md:grid-cols-2">
        {known.map(([label, value]) => (
          <FieldRow key={label} label={label}>
            <span className="tabular-nums">{value}</span>
          </FieldRow>
        ))}
      </dl>
    </div>
  );
}

function OrderTable({ orders }: { orders: ExecutionOrder[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-left text-xs">
        <thead className="text-slate-400">
          <tr>
            <th scope="col" className="py-1">Role / gen</th>
            <th scope="col" className="py-1">Client id</th>
            <th scope="col" className="py-1">Exchange id</th>
            <th scope="col" className="py-1">Side</th>
            <th scope="col" className="py-1">Type</th>
            <th scope="col" className="py-1">Price / trigger</th>
            <th scope="col" className="py-1">Qty / executed</th>
            <th scope="col" className="py-1">Avg fill</th>
            <th scope="col" className="py-1">Working type</th>
            <th scope="col" className="py-1">Status</th>
            <th scope="col" className="py-1">Reconciled</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id} className="border-t border-surface-border/60">
              <td className="py-1">
                {order.role}
                <span className="ml-1 text-slate-500">#{order.generation}</span>
              </td>
              <td className="py-1">
                <CopyableId value={order.clientAlgoId ?? order.clientOrderId} label="client order id" />
              </td>
              <td className="py-1">
                <CopyableId value={order.exchangeAlgoId ?? order.exchangeOrderId} label="exchange id" />
              </td>
              <td className="py-1">
                {order.side}
                <span className="ml-1 text-slate-500">{order.positionSide}</span>
              </td>
              <td className="py-1">{order.orderType}</td>
              <td className="py-1">
                <DecimalValue value={order.price} />
                <span className="mx-1 text-slate-600">/</span>
                <DecimalValue value={order.triggerPrice} />
              </td>
              <td className="py-1">
                <DecimalValue value={order.originalQuantity} />
                <span className="mx-1 text-slate-600">/</span>
                <DecimalValue value={order.executedQuantity} />
              </td>
              <td className="py-1"><DecimalValue value={order.averageFillPrice} /></td>
              <td className="py-1">{order.workingType ?? UNKNOWN_DISPLAY}</td>
              <td className="py-1">
                <StatusBadge presentation={presentOrderStatus(order.status)} />
                {order.algoStatus ? (
                  <span className="ml-1 text-[10px] text-slate-500">{order.algoStatus}</span>
                ) : null}
              </td>
              <td className="py-1"><TimestampValue value={order.lastReconcileAt} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
