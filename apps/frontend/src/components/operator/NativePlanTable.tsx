import { Fragment, useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { NATIVE_PLAN_INTEGRITY_SCAN_LIMIT, NATIVE_PLAN_PAGE_SIZES, type NativePlanListItemDto } from "@trading-alert-dashboard/shared";
import {
  DIRECTION_OPTIONS,
  INTEGRITY_OPTIONS,
  PLAN_STATUS_OPTIONS,
  SOURCE_TIMEFRAME_OPTIONS,
  checkNativePlanSearch,
  hasActiveNativePlanQuery,
  isNativePlanPageSize,
  type FilterOption,
} from "../../features/plans/nativePlanQuery";
import { boundedNativePlanItems, nativePlanPageCaption, presentNativePlanRow, type NativePlanRowView } from "../../features/plans/nativePlanTable";
import type { NativePlanPageView } from "../../hooks/useNativePlanPage";
import { pinnedDetailStyle, useVisibleWidth } from "../../hooks/useVisibleWidth";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { DecimalText } from "../ui/DecimalText";
import { NativePlanDetail } from "./NativePlanDetail";

/**
 * Trading Control's Native plan table: search, filters, keyset pages and
 * expandable rows, for 50 to 500+ plans and beyond.
 *
 * Every control here only changes WHAT IS SHOWN: the search box, the filters,
 * the page size, Previous / Next, Clear filters, Refresh, Retry and each row's
 * details toggle. None of them writes, plans, selects or permits anything —
 * the page's only request is the read-only plan list. The DOM holds one page
 * of rows (at most 200) and their opened details, never the whole data set.
 */

/**
 * The two state columns (Plan, Integrity) come before the numbers, so the
 * safety-relevant integrity verdict is on screen without scrolling at desktop
 * widths; on a phone it is repeated under the symbol.
 */
export const NATIVE_PLAN_COLUMNS = [
  "Triggered",
  "Symbol",
  "Source TF",
  "Direction",
  "Plan",
  "Integrity",
  "Entry",
  "Lookback",
  "RR",
  "Account A",
  "Account B",
] as const;

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

function FilterSelect<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T | "";
  options: readonly FilterOption<T>[];
  onChange: (value: T | "") => void;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <select
        id={id}
        className={CONTROL}
        value={value}
        // Only a value from the shared vocabulary can ever be chosen.
        onChange={(event) => onChange(options.find((option) => option.value === event.target.value)?.value ?? "")}
      >
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Toolbar({ view }: { view: NativePlanPageView }) {
  const live = checkNativePlanSearch(view.filters.search);
  const searchError = live.ok ? null : live.message;
  return (
    <div className="space-y-2">
      <div role="search" aria-label="Search and filter Native plans" className="flex flex-wrap items-end gap-3">
        <Field label="Search" htmlFor="native-plan-search">
          <input
            id="native-plan-search"
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Symbol or alert id"
            className={`${CONTROL} w-48`}
            value={view.filters.search}
            aria-invalid={searchError !== null}
            aria-describedby={searchError !== null ? "native-plan-search-error" : undefined}
            onChange={(event) => view.setSearch(event.target.value)}
          />
        </Field>
        <FilterSelect id="native-plan-source-tf" label="Source TF" value={view.filters.sourceTimeframe} options={SOURCE_TIMEFRAME_OPTIONS} onChange={(value) => view.setFilter("sourceTimeframe", value)} />
        <FilterSelect id="native-plan-direction" label="Direction" value={view.filters.direction} options={DIRECTION_OPTIONS} onChange={(value) => view.setFilter("direction", value)} />
        <FilterSelect id="native-plan-status" label="Plan status" value={view.filters.planStatus} options={PLAN_STATUS_OPTIONS} onChange={(value) => view.setFilter("planStatus", value)} />
        <FilterSelect id="native-plan-integrity" label="Integrity" value={view.filters.integrity} options={INTEGRITY_OPTIONS} onChange={(value) => view.setFilter("integrity", value)} />
        <Field label="Rows per page" htmlFor="native-plan-page-size">
          <select
            id="native-plan-page-size"
            className={CONTROL}
            value={view.pageSize}
            onChange={(event) => {
              const size = Number(event.target.value);
              if (isNativePlanPageSize(size)) view.setPageSize(size);
            }}
          >
            {NATIVE_PLAN_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" disabled={!hasActiveNativePlanQuery(view.filters)} onClick={view.clearFilters}>
            Clear filters
          </Button>
          <Button type="button" variant="ghost" onClick={view.reload} aria-label="Refresh the Native plan list">
            Refresh
          </Button>
        </div>
      </div>
      {searchError !== null && (
        <p id="native-plan-search-error" role="alert" className="text-xs text-yellow-400">
          {searchError} The list below is not filtered by it.
        </p>
      )}
      {view.filters.integrity !== "" && (
        <p className="text-xs text-slate-500" data-testid="native-plan-integrity-note">
          Integrity is rebuilt from scanner files on every read and is never stored, so it cannot be counted in the database. Each page checks up to{" "}
          {NATIVE_PLAN_INTEGRITY_SCAN_LIMIT} plans, newest first, and says how far it got.
        </p>
      )}
    </div>
  );
}

const CELL = "px-2 py-1.5 align-top";

/** px-3 on the detail cell: the pinned panel is inset by it on both sides. */
const DETAIL_INSET_PX = 12;

function PlanRow({
  row,
  item,
  open,
  onToggle,
  detailWidth,
}: {
  row: NativePlanRowView;
  item: NativePlanListItemDto;
  open: boolean;
  onToggle: (key: string) => void;
  detailWidth: number | null;
}) {
  const detailId = `native-plan-detail-${row.key}`;
  return (
    <Fragment>
      <tr className={`border-b border-surface-border/60 ${open ? "bg-surface-border/30" : "hover:bg-surface-border/20"}`} data-row-key={row.key}>
        <td className={`${CELL} w-8`}>
          <button
            type="button"
            className="rounded px-1 text-slate-400 hover:bg-surface-border hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            aria-label={`${open ? "Hide" : "Show"} plan details for ${row.symbol} ${row.direction}`}
            onClick={() => onToggle(row.key)}
          >
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          </button>
        </td>
        <td className={`${CELL} whitespace-nowrap tabular-nums text-slate-300`}>
          <time dateTime={row.triggeredAtExact} title={row.triggeredAtExact}>
            {row.triggeredAtText}
          </time>
        </td>
        <td className={`${CELL} max-w-[12rem]`}>
          <Link to={`/alerts/${row.alertId}`} title={row.symbol} className="block truncate font-semibold text-slate-100 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
            {row.symbol}
          </Link>
          {/* Phones: the integrity column is off-screen, so its verdict is repeated here (the real cell stays in the row). */}
          <span aria-hidden="true" className="mt-1 block md:hidden">
            <Badge tone={row.integrity.tone} className="whitespace-nowrap">
              {row.integrity.marker}
              {row.integrity.label}
            </Badge>
          </span>
        </td>
        <td className={`${CELL} whitespace-nowrap text-slate-300`}>{row.sourceTimeframe}</td>
        <td className={CELL}>
          <Badge tone={row.directionTone}>{row.direction}</Badge>
        </td>
        <td className={CELL}>
          <Badge tone={row.planTone} title={row.planTitle} className="whitespace-nowrap">
            {row.planLabel}
          </Badge>
        </td>
        <td className={CELL}>
          <Badge tone={row.integrity.tone} title={row.integrity.detail} data-integrity-class={row.integrity.integrityClass} className="whitespace-nowrap">
            {row.integrity.marker}
            {row.integrity.label}
          </Badge>
        </td>
        <td className={`${CELL} whitespace-nowrap tabular-nums text-slate-200`}>
          <DecimalText value={row.entry} />
        </td>
        <td className={`${CELL} tabular-nums text-slate-300`}>{row.selectedLookback}</td>
        <td className={`${CELL} whitespace-nowrap tabular-nums text-slate-300`}>{row.rr}</td>
        {row.accounts.map((cell) => (
          <td key={cell.account} className={CELL}>
            <Badge tone={cell.tone} title={cell.title} className="whitespace-nowrap">
              {cell.text}
            </Badge>
          </td>
        ))}
      </tr>
      {open && (
        <tr id={detailId} className="border-b border-surface-border/60 bg-surface/60">
          <td colSpan={NATIVE_PLAN_COLUMNS.length + 1} className="px-3 py-3">
            {/* As wide as what is on screen, pinned left, so no part of it hides beyond the table's scroll. */}
            <div className="sticky left-3" style={pinnedDetailStyle(detailWidth, DETAIL_INSET_PX)}>
              <NativePlanDetail item={item} />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/** The rows of one page. Pure render: no request, no timer. */
export function NativePlanRows({
  items,
  expanded,
  onToggle,
  detailWidth = null,
}: {
  items: readonly NativePlanListItemDto[];
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** The scroll container's visible width, for the expanded detail; null = natural width. */
  detailWidth?: number | null;
}) {
  const bounded = useMemo(() => boundedNativePlanItems(items), [items]);
  const rows = useMemo(() => bounded.map((item) => ({ item, row: presentNativePlanRow(item) })), [bounded]);
  return (
    <table className="w-full min-w-[1080px] text-left text-xs">
      <caption className="sr-only">Native plans, newest trigger first. Planning only; Native execution is disabled.</caption>
      <thead className="border-b border-surface-border text-[11px] uppercase tracking-wide text-slate-400">
        <tr>
          <th scope="col" className="w-8 px-2 py-2">
            <span className="sr-only">Details</span>
          </th>
          {NATIVE_PLAN_COLUMNS.map((column) => (
            <th key={column} scope="col" className="whitespace-nowrap px-2 py-2 font-semibold">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ item, row }) => (
          <PlanRow key={row.key} row={row} item={item} open={expanded.has(row.key)} onToggle={onToggle} detailWidth={detailWidth} />
        ))}
      </tbody>
    </table>
  );
}

function EmptyMessage({ view }: { view: NativePlanPageView }) {
  const scan = view.latest?.pagination.integrityScan ?? null;
  if (scan !== null && !scan.exhausted) {
    return <>No match among the {scan.scanned} plan(s) checked on this page. Next continues the scan with older plans.</>;
  }
  if (hasActiveNativePlanQuery(view.filters)) return <>No Native plans match the current search and filters.</>;
  return (
    <>No Native alert has a plan yet. New Native alerts are planned automatically after delivery; any Native alert can be planned on demand from its Trade Plan.</>
  );
}

export function NativePlanTable({ view }: { view: NativePlanPageView }) {
  const { state, latest } = view;
  const loading = state.status === "loading";
  const items = latest?.items ?? [];
  const stale = latest !== null && view.current === null;
  const [scrollRef, visibleWidth] = useVisibleWidth<HTMLDivElement>();

  return (
    <section aria-label="Native plan list" className="space-y-3">
      <Toolbar view={view} />

      {state.status === "error" ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3">
          <p className="min-w-0 break-words text-sm text-red-300">Native plans could not be loaded: {state.message}</p>
          <Button type="button" variant="secondary" onClick={view.reload}>
            Retry
          </Button>
        </div>
      ) : latest === null ? (
        <p className="text-sm text-slate-500" role="status">
          Loading Native plans…
        </p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-surface-border px-4 py-8 text-center text-sm text-slate-400" role="status" data-testid="native-plan-empty">
          <EmptyMessage view={view} />
        </div>
      ) : (
        <div ref={scrollRef} className={`overflow-x-auto rounded-lg border border-surface-border ${stale ? "opacity-60" : ""}`} aria-busy={loading}>
          <NativePlanRows items={items} expanded={view.expanded} onToggle={view.toggleRow} detailWidth={visibleWidth} />
        </div>
      )}

      {latest !== null && state.status !== "error" && (
        <nav aria-label="Native plan pages" className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          <span aria-live="polite">
            {loading ? "Loading… " : ""}
            {nativePlanPageCaption(latest.pagination, view.pageNumber, items.length)}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" disabled={view.pageNumber <= 1} onClick={view.previousPage}>
              Previous
            </Button>
            <Button type="button" variant="secondary" disabled={loading || view.current?.pagination.nextCursor == null} onClick={view.nextPage}>
              {view.current?.pagination.integrityScan && !view.current.pagination.integrityScan.exhausted ? "Next (continue scan)" : "Next"}
            </Button>
          </div>
        </nav>
      )}
    </section>
  );
}
