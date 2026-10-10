import { Fragment, useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { executionsApi, type ExecutionListItem, type ExecutionListResponse } from "../api/executions.api";
import { ExecutionRowDetail } from "../components/executions/ExecutionRowDetail";
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
  EXECUTION_PAGE_SIZES,
  checkExecutionSearch,
  executionPageCaption,
  hasActiveExecutionFilters,
  isExecutionPageSize,
  supportsJournalSearch,
} from "../features/executions/executionListQuery";
import {
  EXECUTION_STATUSES,
  PROTECTION_STATES,
  presentExecutionStatus,
  presentExitReason,
  presentProtectionState,
} from "../features/executions/executionPresentation";
import { describeExecutionReason } from "../features/executions/executionReason";
import { useExecutionJournal, type ExecutionJournalView } from "../hooks/useExecutionJournal";
import { pinnedDetailStyle, useVisibleWidth } from "../hooks/useVisibleWidth";
import type { CancellableFetcher } from "../utils/latestRequest";

/**
 * The central execution lifecycle journal.
 *
 * Read-only: it renders persisted database state and contains no mutation
 * control of any kind — its controls only search, filter, page and expand.
 * There is no polling — the data is refreshed only by an explicit user
 * action, so the page never generates background traffic. Each row expands
 * into its lifecycle, built from stored records only.
 */

// Module level, so the journal's loader always holds the same read-only function.
const readExecutionPage: CancellableFetcher<ExecutionListResponse> = (query, signal) => executionsApi.listPage(query, signal);

const CONTROL =
  "rounded border border-surface-border bg-surface px-2 py-1 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50";

/** Every column of the table, the details toggle included (a detail row spans them all). */
const COLUMN_COUNT = 15;

export function ExecutionsPage() {
  return <ExecutionJournal view={useExecutionJournal(readExecutionPage)} />;
}

/** The journal for one state of the read: pure render, so it can be shown with any data. */
export function ExecutionJournal({ view }: { view: ExecutionJournalView }) {
  const data = view.latest;
  const loading = view.state.status === "loading";
  const items = data?.items ?? [];
  const stale = data !== null && view.current === null;
  const [scrollRef, visibleWidth] = useVisibleWidth<HTMLDivElement>();

  const aggregate = useMemo(
    () => (data ? displayAggregatePnl(data.metrics) : null),
    [data]
  );

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold text-slate-100">Executions</h1>
        <p className="text-sm text-slate-400">
          Execution lifecycle journal. This page is read-only and shows stored records only: it makes no exchange call and has no
          trading control.
        </p>
      </header>

      {data ? (
        <section aria-label="Execution summary" className="space-y-1">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
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
          </div>
          <p className="text-[11px] text-slate-500" data-testid="execution-summary-scope">
            Counts cover every execution matching the search and filters (all pages); the Lifecycle filter is not applied to them.
          </p>
        </section>
      ) : null}

      <Toolbar view={view} />

      {view.state.status === "error" ? (
        <Card className="p-4" role="alert">
          <p className="break-words text-sm text-red-400">{view.state.message}</p>
          <Button type="button" className="mt-2" onClick={view.reload}>
            Retry
          </Button>
        </Card>
      ) : null}

      {data === null && view.state.status !== "error" ? (
        <Card className="p-6">
          <p className="text-sm text-slate-400" role="status">
            Loading executions…
          </p>
        </Card>
      ) : null}

      {data && items.length === 0 && view.state.status !== "error" ? (
        <EmptyState
          title="No executions"
          description={hasActiveExecutionFilters(view.filters) ? "No execution records match the current search and filters." : "No execution has been recorded yet."}
        />
      ) : null}

      {data && items.length > 0 && view.state.status !== "error" ? (
        <Card className={`p-0 ${stale ? "opacity-60" : ""}`} aria-busy={loading}>
          <div ref={scrollRef} className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <caption className="sr-only">Execution journal, most recently updated first</caption>
            <thead className="border-b border-surface-border text-xs uppercase text-slate-400">
              <tr>
                <th scope="col" className="w-8 px-2 py-2">
                  <span className="sr-only">Details</span>
                </th>
                <th scope="col" className="px-3 py-2">Signal / created</th>
                <th scope="col" className="px-3 py-2">Symbol</th>
                <th scope="col" className="px-3 py-2">Direction</th>
                <th scope="col" className="px-3 py-2">Profile</th>
                <th scope="col" className="px-3 py-2">Status</th>
                <th scope="col" className="px-3 py-2">Reason</th>
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
              {items.map((item) => (
                <ExecutionRow key={item.id} item={item} open={view.expanded.has(item.id)} onToggle={view.toggleRow} detailWidth={visibleWidth} />
              ))}
            </tbody>
          </table>
          </div>
        </Card>
      ) : null}

      {data && view.state.status !== "error" ? (
        <nav aria-label="Execution pages" className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          <span aria-live="polite">
            {loading ? "Loading… " : ""}
            {executionPageCaption(data, items.length)}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" disabled={view.page <= 1} onClick={() => view.goToPage(view.page - 1)}>
              Previous
            </Button>
            <Button type="button" variant="secondary" disabled={loading || !view.current?.hasMore} onClick={() => view.goToPage(view.page + 1)}>
              Next
            </Button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}

/** px-3 on the detail cell: the pinned panel is inset by it on both sides. */
const DETAIL_INSET_PX = 12;

function ExecutionRow({
  item,
  open,
  onToggle,
  detailWidth,
}: {
  item: ExecutionListItem;
  open: boolean;
  onToggle: (key: string) => void;
  detailWidth: number | null;
}) {
  const detailId = `execution-detail-${item.id}`;
  return (
    <Fragment>
      <tr className={`border-b border-surface-border/60 ${open ? "bg-surface-raised" : "hover:bg-surface-raised"}`} data-row-key={item.id}>
        <td className="w-8 px-2 py-2 align-top">
          <button
            type="button"
            className="rounded px-1 text-slate-400 hover:bg-surface-border hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            aria-label={`${open ? "Hide" : "Show"} lifecycle for ${item.symbol} ${item.direction}`}
            onClick={() => onToggle(item.id)}
          >
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          </button>
        </td>
        <td className="px-3 py-2">
          <TimestampValue value={item.signalTriggeredAt ?? item.createdAt} />
        </td>
        <td className="px-3 py-2 font-medium text-slate-100">
          <Link
            to={`/executions/${item.id}`}
            className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            aria-label={`Open execution detail for ${item.symbol} ${item.direction}`}
          >
            {item.symbol}
          </Link>
        </td>
        <td className="px-3 py-2">
          <Badge tone={item.direction === "LONG" ? "green" : "red"}>{item.direction}</Badge>
        </td>
        <td className="px-3 py-2 text-xs text-slate-300">
          {item.profile.name}
          <span className="block text-[10px] text-slate-500">
            {item.profile.environment}
            {item.alertSource !== undefined ? ` · ${item.alertSource ?? "source unknown"}` : ""}
          </span>
        </td>
        <td className="px-3 py-2">
          <StatusBadge presentation={presentExecutionStatus(item.status)} />
        </td>
        <td className="px-3 py-2">
          <ExecutionReasonCell status={item.status} reasonCode={item.decisionReasonCode} symbol={item.symbol} direction={item.direction} />
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
      {open ? (
        <tr id={detailId} className="border-b border-surface-border/60 bg-surface/60">
          <td colSpan={COLUMN_COUNT} className="px-3 py-3">
            {/* As wide as what is on screen, pinned left, so no part of it hides beyond the table's scroll. */}
            <div className="sticky left-3" style={pinnedDetailStyle(detailWidth, DETAIL_INSET_PX)}>
              <ExecutionRowDetail item={item} />
            </div>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

function Toolbar({ view }: { view: ExecutionJournalView }) {
  const { filters } = view;
  const live = checkExecutionSearch(filters.search);
  // An older backend ignores search, source and account: those controls say so instead of pretending.
  const searchable = supportsJournalSearch(view.latest);
  const profiles = view.latest?.profiles ?? [];
  return (
    <Card className="space-y-2 p-3">
      <div role="search" aria-label="Search and filter executions" className="flex flex-wrap items-end gap-3">
        <FilterField label="Search" htmlFor="execution-search">
          <input
            id="execution-search"
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Symbol, execution or alert id"
            className={`${CONTROL} w-52`}
            value={filters.search}
            disabled={!searchable}
            aria-invalid={!live.ok}
            aria-describedby={!live.ok ? "execution-search-error" : undefined}
            onChange={(event) => view.setSearch(event.target.value)}
          />
        </FilterField>

        <FilterField label="Account (profile)" htmlFor="execution-profile">
          <select id="execution-profile" className={CONTROL} value={filters.executionProfileId} disabled={!searchable} onChange={(event) => view.setFilter("executionProfileId", event.target.value)}>
            <option value="">Any</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} · {profile.environment}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Source" htmlFor="execution-source">
          <select
            id="execution-source"
            className={CONTROL}
            value={filters.source}
            disabled={!searchable}
            onChange={(event) => view.setFilter("source", event.target.value === "TRADINGVIEW" || event.target.value === "NATIVE" ? event.target.value : "")}
          >
            <option value="">Any</option>
            <option value="TRADINGVIEW">TRADINGVIEW</option>
            <option value="NATIVE">NATIVE</option>
          </select>
        </FilterField>

        <FilterField label="Direction" htmlFor="execution-direction">
          <select
            id="execution-direction"
            className={CONTROL}
            value={filters.direction}
            onChange={(event) => view.setFilter("direction", event.target.value === "LONG" || event.target.value === "SHORT" ? event.target.value : "")}
          >
            <option value="">Any</option>
            <option value="LONG">LONG</option>
            <option value="SHORT">SHORT</option>
          </select>
        </FilterField>

        <FilterField label="Status" htmlFor="execution-status">
          <select id="execution-status" className={CONTROL} value={filters.status} onChange={(event) => view.setFilter("status", event.target.value)}>
            <option value="">Any</option>
            {EXECUTION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {presentExecutionStatus(status).label}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Protection" htmlFor="execution-protection">
          <select id="execution-protection" className={CONTROL} value={filters.protectionState} onChange={(event) => view.setFilter("protectionState", event.target.value)}>
            <option value="">Any</option>
            {PROTECTION_STATES.map((state) => (
              <option key={state} value={state}>
                {presentProtectionState(state)?.label}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Environment" htmlFor="execution-environment">
          <select
            id="execution-environment"
            className={CONTROL}
            value={filters.environment}
            onChange={(event) => view.setFilter("environment", event.target.value === "MAINNET" || event.target.value === "TESTNET" ? event.target.value : "")}
          >
            <option value="">Any</option>
            <option value="MAINNET">MAINNET</option>
            <option value="TESTNET">TESTNET</option>
          </select>
        </FilterField>

        <FilterField label="Lifecycle" htmlFor="execution-lifecycle">
          <select
            id="execution-lifecycle"
            className={CONTROL}
            value={filters.lifecycle}
            onChange={(event) => view.setFilter("lifecycle", event.target.value === "active" || event.target.value === "closed" ? event.target.value : "")}
          >
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="closed">Closed (terminal)</option>
          </select>
        </FilterField>

        <FilterField label="Created from (UTC)" htmlFor="execution-created-from">
          <input id="execution-created-from" type="date" className={CONTROL} value={filters.createdFrom} onChange={(event) => view.setFilter("createdFrom", event.target.value)} />
        </FilterField>

        <FilterField label="Created to (UTC)" htmlFor="execution-created-to">
          <input id="execution-created-to" type="date" className={CONTROL} value={filters.createdTo} onChange={(event) => view.setFilter("createdTo", event.target.value)} />
        </FilterField>

        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" checked={filters.requiresManualIntervention} onChange={(event) => view.setFilter("requiresManualIntervention", event.target.checked)} />
          Needs manual intervention
        </label>

        <FilterField label="Rows per page" htmlFor="execution-page-size">
          <select
            id="execution-page-size"
            className={CONTROL}
            value={view.pageSize}
            onChange={(event) => {
              const size = Number(event.target.value);
              if (isExecutionPageSize(size)) view.setPageSize(size);
            }}
          >
            {EXECUTION_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </FilterField>

        <div className="flex gap-2">
          <Button type="button" variant="secondary" disabled={!hasActiveExecutionFilters(filters)} onClick={view.clearFilters}>
            Clear filters
          </Button>
          <Button type="button" onClick={view.reload}>
            Refresh
          </Button>
        </div>
      </div>
      {!live.ok ? (
        <p id="execution-search-error" role="alert" className="text-xs text-yellow-400">
          {live.message} The list is not filtered by it.
        </p>
      ) : null}
      {!searchable ? (
        <p className="text-xs text-yellow-400" data-testid="execution-search-unsupported">
          The backend serving this page predates journal search: search, source and account filters are unavailable until it is updated.
        </p>
      ) : null}
    </Card>
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

function FilterField({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-[11px] uppercase tracking-wide text-slate-400">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * Why an execution did not become an entry.
 *
 * The sentence comes from the backend's persisted `decisionReasonCode` through
 * the shared vocabulary — never inferred here from the status, the symbol or
 * the timestamps, because a guess that looks authoritative is worse than no
 * answer at all.
 *
 * A healthy row shows an em dash rather than a stale explanation: an
 * ENTRY_PENDING execution carries ENTRY_RECONCILED, which means the order is
 * resting exactly as intended, and printing that under "Reason" would report a
 * problem for a trade that is working.
 *
 * The raw code stays reachable on hover, so an operator can always get from the
 * sentence back to the thing the engine actually recorded.
 */
function ExecutionReasonCell({
  status,
  reasonCode,
  symbol,
  direction,
}: {
  status: string;
  reasonCode: string | null;
  symbol: string;
  direction: string;
}) {
  // No alert-age limit is passed: the executions list carries no policy
  // context, and hardcoding one here would put a second copy of a configurable
  // value in front of the operator. The stale-alert copy stays neutral.
  const reason = describeExecutionReason({ status, reasonCode, symbol, direction });
  if (!reason) return <span className="text-slate-600">—</span>;

  return (
    <span
      className="block max-w-[22rem] truncate text-xs text-slate-300"
      title={reasonCode ? `${reason}\n\n${reasonCode}` : reason}
    >
      {reason}
    </span>
  );
}
