import { Fragment, type ReactNode } from "react";
import { SIGNAL_QUALITY_HORIZON_KEYS, SIGNAL_QUALITY_PAGE_SIZES, type SignalQualityPageDto, type SignalQualityRowDto } from "@trading-alert-dashboard/shared";
import {
  DIRECTION_OPTIONS,
  FLAG_OPTIONS,
  FRESHNESS_OPTIONS,
  HORIZON_OPTIONS,
  HORIZON_STATE_OPTIONS,
  INTEGRITY_OPTIONS,
  LEVEL_COLOR_OPTIONS,
  PLAN_OUTCOME_OPTIONS,
  SORT_OPTIONS,
  SOURCE_TF_OPTIONS,
  TIMEFRAME_CLASS_OPTIONS,
  activeFilterCount,
  checkSymbol,
  pageNumberOf,
  type FilterOption,
  type SignalQualityFilters,
  type SignalQualityPageSize,
} from "../../features/signal-quality/signalQualityQuery";
import { FLAG_TONE, PLAN_OUTCOME_LABEL, PLAN_OUTCOME_TONE, boundedRows, formatR, freshnessLabel, horizonCell, integrityLabel } from "../../features/signal-quality/signalQualityPresentation";
import type { SignalQualityView } from "../../hooks/useSignalQuality";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { SignalQualityDetail } from "./SignalQualityDetail";

/**
 * The observatory's alert table: filters, deterministic sort, bounded pages
 * and one expandable detail. Every control changes only what is shown. The DOM
 * holds one page (at most 100 rows) and one opened detail.
 */

export const SIGNAL_QUALITY_COLUMNS = ["Triggered", "Symbol", "Side", "Source TF", "Colour", "Level", "Freshness", "Integrity", "Plan", ...SIGNAL_QUALITY_HORIZON_KEYS, "Flags"] as const;

const CONTROL =
  "rounded border border-surface-border bg-surface px-2 py-1 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-[11px] uppercase tracking-wide text-slate-400">
        {label}
      </label>
      {children}
    </div>
  );
}

function Select<T extends string>({ id, label, value, options, onChange, any = true }: { id: string; label: string; value: T | ""; options: readonly FilterOption<T>[]; onChange: (v: T | "") => void; any?: boolean }) {
  return (
    <Field label={label} htmlFor={id}>
      <select id={id} className={CONTROL} value={value} onChange={(e) => onChange(options.find((o) => o.value === e.target.value)?.value ?? "")}>
        {any ? <option value="">Any</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function SignalQualityFiltersBar({ view }: { view: SignalQualityView }) {
  const f = view.filters;
  const set = <K extends keyof SignalQualityFilters>(key: K) => (value: SignalQualityFilters[K]) => view.setFilter(key, value);
  const symbolCheck = checkSymbol(f.symbol);
  return (
    <div role="search" aria-label="Filter Native signal quality" className="flex flex-wrap items-end gap-3">
      <Field label="Symbol" htmlFor="sq-symbol">
        <input id="sq-symbol" type="search" autoComplete="off" spellCheck={false} className={`${CONTROL} w-40`} value={f.symbol} aria-invalid={!symbolCheck.ok} onChange={(e) => view.setFilter("symbol", e.target.value)} />
      </Field>
      <Select id="sq-tf" label="Source TF" value={f.sourceTimeframe} options={SOURCE_TF_OPTIONS} onChange={set("sourceTimeframe")} />
      <Select id="sq-side" label="Side" value={f.direction} options={DIRECTION_OPTIONS} onChange={set("direction")} />
      <Select id="sq-colour" label="Colour" value={f.levelColor} options={LEVEL_COLOR_OPTIONS} onChange={set("levelColor")} />
      <Select id="sq-class" label="TF class" value={f.timeframeClass} options={TIMEFRAME_CLASS_OPTIONS} onChange={set("timeframeClass")} />
      <Select id="sq-integrity" label="Integrity" value={f.integrity} options={INTEGRITY_OPTIONS} onChange={set("integrity")} />
      <Select id="sq-freshness" label="Freshness" value={f.freshness} options={FRESHNESS_OPTIONS} onChange={set("freshness")} />
      <Select id="sq-outcome" label="Plan outcome" value={f.planOutcome} options={PLAN_OUTCOME_OPTIONS} onChange={set("planOutcome")} />
      <Select id="sq-horizon" label="Horizon" value={f.horizon} options={HORIZON_OPTIONS} onChange={(v) => view.setFilter("horizon", v === "" ? "24h" : v)} any={false} />
      <Select id="sq-horizon-state" label="Horizon state" value={f.horizonState} options={HORIZON_STATE_OPTIONS} onChange={set("horizonState")} />
      <Select id="sq-flag" label="Flag" value={f.flag} options={FLAG_OPTIONS} onChange={set("flag")} />
      <Select id="sq-sort" label="Sort" value={view.sort} options={SORT_OPTIONS} onChange={(v) => view.setSort(v === "" ? "TRIGGERED_DESC" : v)} any={false} />
      <Button variant="ghost" type="button" disabled={activeFilterCount(f) === 0} onClick={view.clearFilters}>
        Clear filters
      </Button>
    </div>
  );
}

function Row({ row, expanded, onToggle, asOf }: { row: SignalQualityRowDto; expanded: boolean; onToggle: () => void; asOf: string | null }) {
  const integrity = integrityLabel(row);
  const fresh = freshnessLabel(row);
  return (
    <Fragment>
      <tr className="border-t border-surface-border align-top text-slate-300">
        <td className="whitespace-nowrap px-2 py-1 font-mono text-xs">{row.triggeredAt.replace("T", " ").slice(0, 19)}</td>
        <td className="max-w-[10rem] break-all px-2 py-1 font-semibold text-slate-100" title={row.symbol}>
          {row.symbol}
        </td>
        <td className="px-2 py-1">
          <Badge tone={row.direction === "LONG" ? "green" : "red"}>{row.direction}</Badge>
        </td>
        <td className="px-2 py-1">
          {row.sourceTimeframe ?? "—"}
          {row.timeframeClass === "DASHBOARD_ONLY_TIMEFRAME" ? <span className="ml-1 text-[10px] text-slate-500">(dashboard-only)</span> : null}
        </td>
        <td className="px-2 py-1">{row.levelColor ?? "—"}</td>
        <td className="px-2 py-1 font-mono text-xs">{row.levelPrice ?? "—"}</td>
        <td className="px-2 py-1">
          <Badge tone={fresh.tone}>{fresh.text}</Badge>
        </td>
        <td className="px-2 py-1">
          <Badge tone={integrity.tone}>{integrity.text}</Badge>
        </td>
        <td className="px-2 py-1">
          <Badge tone={PLAN_OUTCOME_TONE[row.plan.outcome]}>{PLAN_OUTCOME_LABEL[row.plan.outcome]}</Badge>
          {row.plan.rMultiple !== null ? <span className="ml-1 font-mono text-xs">{formatR(row.plan.rMultiple)}</span> : null}
        </td>
        {SIGNAL_QUALITY_HORIZON_KEYS.map((key) => {
          const cell = horizonCell(row.horizons.find((h) => h.key === key));
          return (
            <td key={key} className="whitespace-nowrap px-2 py-1 font-mono text-xs" title={cell.title}>
              <Badge tone={cell.tone}>{cell.text}</Badge>
            </td>
          );
        })}
        <td className="px-2 py-1">
          <div className="flex flex-wrap gap-1">
            {row.flags.map((flag, i) => (
              <Badge key={`${flag.code}-${i}`} tone={FLAG_TONE[flag.category]} title={flag.detail}>
                {flag.code}
              </Badge>
            ))}
          </div>
          <button type="button" className="mt-1 text-xs text-blue-400 hover:underline" aria-expanded={expanded} onClick={onToggle}>
            {expanded ? "Hide details" : "Details"}
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={SIGNAL_QUALITY_COLUMNS.length} className="bg-surface px-2 py-3">
            <SignalQualityDetail alertId={row.alertId} asOf={asOf} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

export function SignalQualityRows({ page, expanded, onToggle, asOf }: { page: SignalQualityPageDto; expanded: string | null; onToggle: (id: string) => void; asOf: string | null }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-[11px] uppercase tracking-wide text-slate-400">
          <tr>
            {SIGNAL_QUALITY_COLUMNS.map((c) => (
              <th key={c} className="px-2 py-1">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {boundedRows(page.items).map((row) => (
            <Row key={row.alertId} row={row} expanded={expanded === row.alertId} onToggle={() => onToggle(row.alertId)} asOf={asOf} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SignalQualityTable({ view }: { view: SignalQualityView }) {
  const state = view.page;
  const page = state.data;
  const stale = state.dataKey !== view.pageKey;
  return (
    <div className="space-y-3">
      <SignalQualityFiltersBar view={view} />
      {state.status === "error" ? (
        <div role="alert" className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          The signal-quality backend is unavailable: {state.message}. Nothing else is affected.{" "}
          <button type="button" className="underline" onClick={view.reload}>
            Retry
          </button>
        </div>
      ) : null}
      {page === null ? (
        state.status === "loading" ? <p className="text-sm text-slate-400">Loading Native signals…</p> : state.status === "error" ? null : <p className="text-sm text-slate-400">No request yet.</p>
      ) : page.items.length === 0 ? (
        <EmptyState title="No Native alerts match" description="Widen the soak window or clear filters. Alerts appear here as the monitoring stack delivers them." />
      ) : (
        <div className={stale ? "opacity-60" : undefined}>
          <SignalQualityRows page={page} expanded={view.expanded} onToggle={view.toggleRow} asOf={view.window.asOf.trim() || null} />
        </div>
      )}
      {page !== null ? (
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
          <span>
            {page.pagination.total} alert(s) · page {pageNumberOf(page.pagination.offset, page.pagination.pageSize)} · rows {page.items.length === 0 ? 0 : page.pagination.offset + 1}–{page.pagination.offset + page.items.length}
          </span>
          <Button variant="ghost" type="button" disabled={view.offset === 0} onClick={view.previousPage}>
            Previous
          </Button>
          <Button variant="ghost" type="button" disabled={!page.pagination.hasMore} onClick={view.nextPage}>
            Next
          </Button>
          <label className="flex items-center gap-1">
            Page size
            <select className={CONTROL} value={view.pageSize} onChange={(e) => view.setPageSize((SIGNAL_QUALITY_PAGE_SIZES.find((s) => String(s) === e.target.value) ?? 50) as SignalQualityPageSize)}>
              {SIGNAL_QUALITY_PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <span>* partial (censored) · market data: {page.sample.marketData.LOADED} loaded, {page.sample.marketData.NOT_LOADED} loading, {page.sample.marketData.UNAVAILABLE} unavailable</span>
        </div>
      ) : null}
    </div>
  );
}
