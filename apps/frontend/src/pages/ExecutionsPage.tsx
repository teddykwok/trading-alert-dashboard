import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { executionsApi, type ExecutionListParams, type ExecutionListResponse } from "../api/executions.api";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import {
  DecimalValue,
  IntegerValue,
  MoneyValue,
  StatusBadge,
  TimestampValue,
} from "../features/executions/ExecutionValue";
import { displayAggregatePnl } from "../features/executions/executionFormat";
import {
  EXECUTION_STATUSES,
  PROTECTION_STATES,
  presentExecutionStatus,
  presentExitReason,
  presentProtectionState,
} from "../features/executions/executionPresentation";

/**
 * Phase 8 — global execution journal.
 *
 * Read-only: it renders persisted database state and contains no mutation
 * control of any kind. There is no polling — the data is refreshed only by an
 * explicit user action, so the page never generates background traffic.
 */
export function ExecutionsPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<ExecutionListParams>({ page: 1, pageSize: 25 });
  const [data, setData] = useState<ExecutionListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await executionsApi.list(filters));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load executions.");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const aggregate = useMemo(
    () => (data ? displayAggregatePnl(data.metrics) : null),
    [data]
  );

  function update(patch: Partial<ExecutionListParams>) {
    // Any filter change resets to page 1 so the view cannot land past the end.
    setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold text-slate-100">Executions</h1>
        <p className="text-sm text-slate-400">
          Automated execution journal. This page is read-only and shows stored records only.
        </p>
      </header>

      {data ? (
        <section aria-label="Execution summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <SummaryTile label="Active" value={data.metrics.activeCount} />
          <SummaryTile label="Pending entries" value={data.metrics.pendingEntryCount} />
          <SummaryTile label="Protected" value={data.metrics.protectedCount} />
          <SummaryTile label="Manual intervention" value={data.metrics.manualInterventionCount} critical />
          <SummaryTile label="Closed" value={data.metrics.closedCount} />
          <Card className="p-3">
            <p className="text-xs text-slate-400">Known realized PnL</p>
            <p className="text-lg font-semibold tabular-nums text-slate-100">{aggregate?.text}</p>
            {/* Never labelled "net profit" while any component is unknown. */}
            {aggregate?.caveat ? <p className="mt-1 text-[11px] text-yellow-400">{aggregate.caveat}</p> : null}
          </Card>
        </section>
      ) : null}

      <Card className="p-3">
        <div className="flex flex-wrap items-end gap-3">
          <FilterField label="Symbol">
            <input
              type="text"
              className="w-32 rounded border border-surface-border bg-surface px-2 py-1 text-sm text-slate-100"
              value={filters.symbol ?? ""}
              onChange={(event) => update({ symbol: event.target.value || undefined })}
            />
          </FilterField>

          <FilterField label="Direction">
            <select
              className="rounded border border-surface-border bg-surface px-2 py-1 text-sm text-slate-100"
              value={filters.direction ?? ""}
              onChange={(event) => update({ direction: event.target.value || undefined })}
            >
              <option value="">Any</option>
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT</option>
            </select>
          </FilterField>

          <FilterField label="Status">
            <select
              className="rounded border border-surface-border bg-surface px-2 py-1 text-sm text-slate-100"
              value={filters.status?.[0] ?? ""}
              onChange={(event) => update({ status: event.target.value ? [event.target.value] : undefined })}
            >
              <option value="">Any</option>
              {EXECUTION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {presentExecutionStatus(status).label}
                </option>
              ))}
            </select>
          </FilterField>

          <FilterField label="Protection">
            <select
              className="rounded border border-surface-border bg-surface px-2 py-1 text-sm text-slate-100"
              value={filters.protectionState?.[0] ?? ""}
              onChange={(event) =>
                update({ protectionState: event.target.value ? [event.target.value] : undefined })
              }
            >
              <option value="">Any</option>
              {PROTECTION_STATES.map((state) => (
                <option key={state} value={state}>
                  {presentProtectionState(state)?.label}
                </option>
              ))}
            </select>
          </FilterField>

          <FilterField label="Environment">
            <select
              className="rounded border border-surface-border bg-surface px-2 py-1 text-sm text-slate-100"
              value={filters.environment ?? ""}
              onChange={(event) => update({ environment: event.target.value || undefined })}
            >
              <option value="">Any</option>
              <option value="MAINNET">MAINNET</option>
              <option value="TESTNET">TESTNET</option>
            </select>
          </FilterField>

          <FilterField label="Lifecycle">
            <select
              className="rounded border border-surface-border bg-surface px-2 py-1 text-sm text-slate-100"
              value={filters.lifecycle ?? ""}
              onChange={(event) =>
                update({ lifecycle: (event.target.value || undefined) as ExecutionListParams["lifecycle"] })
              }
            >
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="closed">Closed</option>
            </select>
          </FilterField>

          <FilterField label="Created from">
            <input
              type="date"
              className="rounded border border-surface-border bg-surface px-2 py-1 text-sm text-slate-100"
              value={filters.createdFrom?.slice(0, 10) ?? ""}
              onChange={(event) =>
                update({ createdFrom: event.target.value ? new Date(event.target.value).toISOString() : undefined })
              }
            />
          </FilterField>

          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={filters.requiresManualIntervention === true}
              onChange={(event) => update({ requiresManualIntervention: event.target.checked || undefined })}
            />
            Needs manual intervention
          </label>

          <Button type="button" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </Card>

      {error ? (
        <Card className="p-4">
          <p className="text-sm text-red-400">{error}</p>
          <Button type="button" className="mt-2" onClick={() => void load()}>
            Retry
          </Button>
        </Card>
      ) : null}

      {loading && !data ? (
        <Card className="p-6">
          <p className="text-sm text-slate-400">Loading executions…</p>
        </Card>
      ) : null}

      {data && data.items.length === 0 && !loading ? (
        <EmptyState title="No executions" description="No execution records match the current filters." />
      ) : null}

      {data && data.items.length > 0 ? (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <caption className="sr-only">Execution journal</caption>
            <thead className="border-b border-surface-border text-xs uppercase text-slate-400">
              <tr>
                <th scope="col" className="px-3 py-2">Signal / created</th>
                <th scope="col" className="px-3 py-2">Symbol</th>
                <th scope="col" className="px-3 py-2">Direction</th>
                <th scope="col" className="px-3 py-2">Profile</th>
                <th scope="col" className="px-3 py-2">Status</th>
                <th scope="col" className="px-3 py-2">Protection</th>
                <th scope="col" className="px-3 py-2">Entry planned / actual</th>
                <th scope="col" className="px-3 py-2">Qty planned / filled</th>
                <th scope="col" className="px-3 py-2">Leverage</th>
                <th scope="col" className="px-3 py-2">Margin max / actual</th>
                <th scope="col" className="px-3 py-2">Exit</th>
                <th scope="col" className="px-3 py-2">Realized PnL</th>
                <th scope="col" className="px-3 py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr
                  key={item.id}
                  tabIndex={0}
                  role="link"
                  aria-label={`Open execution detail for ${item.symbol} ${item.direction}`}
                  className="cursor-pointer border-b border-surface-border/60 last:border-b-0 hover:bg-surface-raised focus:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500"
                  onClick={() => navigate(`/executions/${item.id}`)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      navigate(`/executions/${item.id}`);
                    }
                  }}
                >
                  <td className="px-3 py-2">
                    <TimestampValue value={item.signalTriggeredAt ?? item.createdAt} />
                  </td>
                  <td className="px-3 py-2 font-medium text-slate-100">{item.symbol}</td>
                  <td className="px-3 py-2">
                    <Badge tone={item.direction === "LONG" ? "green" : "red"}>{item.direction}</Badge>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-300">
                    {item.profile.name}
                    <span className="block text-[10px] text-slate-500">{item.profile.environment}</span>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge presentation={presentExecutionStatus(item.status)} />
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge presentation={presentProtectionState(item.protectionState)} />
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <DecimalValue value={item.plannedEntryPrice} />
                    <span className="mx-1 text-slate-600">/</span>
                    <DecimalValue value={item.averageFillPrice} />
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <DecimalValue value={item.plannedQuantity} />
                    <span className="mx-1 text-slate-600">/</span>
                    <DecimalValue value={item.filledQuantity} />
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <IntegerValue value={item.selectedLeverage} />
                    <span className="mx-1 text-slate-600">/</span>
                    <IntegerValue value={item.actualLeverage} />
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <DecimalValue value={item.maximumIsolatedMargin} />
                    <span className="mx-1 text-slate-600">/</span>
                    <DecimalValue value={item.actualIsolatedMargin} />
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-300">
                    {presentExitReason(item.exitReason, item.status) ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <MoneyValue value={item.realizedPnl} />
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <TimestampValue value={item.updatedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {data && data.total > data.pageSize ? (
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>
            Page {data.page} · {data.total} execution(s)
          </span>
          <div className="flex gap-2">
            <Button type="button" disabled={data.page <= 1} onClick={() => update({ page: data.page - 1 })}>
              Previous
            </Button>
            <Button type="button" disabled={!data.hasMore} onClick={() => update({ page: data.page + 1 })}>
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SummaryTile({ label, value, critical }: { label: string; value: number; critical?: boolean }) {
  return (
    <Card className="p-3">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${critical && value > 0 ? "text-red-400" : "text-slate-100"}`}>
        {value}
      </p>
    </Card>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-slate-400">{label}</span>
      {children}
    </label>
  );
}
