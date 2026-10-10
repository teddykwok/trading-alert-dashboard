import {
  EXTREME_RR_STATUSES,
  NATIVE_PLAN_PAGE_MAX_SIZE,
  nativeIntegrityClassOf,
  type ExtremeRRPlanStatus,
  type NativeAccountPlanPreview,
  type NativeIntegrityClass,
  type NativePlanListItemDto,
  type NativePlanPageDto,
  type NativePlanPagination,
  type NativePlanStatusCounts,
  type SelectedPlanSummary,
} from "@trading-alert-dashboard/shared";
import { formatDateTime } from "../../utils/formatDate";
import { nativePlanStatusLabel, nativePlanStatusTone } from "./nativeAccountDefaults";
import { presentNativeExecutionIntegrity } from "./nativeExecutionIntegrity";

/**
 * One Native plan as a compact table row, and the counts above the table.
 * Pure, display only: every value comes verbatim from the read-only API, the
 * exact strings stay in titles, and nothing here selects or permits anything.
 */

export type RowTone = "green" | "red" | "yellow" | "gray" | "blue";

export interface NativePlanAccountCell {
  readonly account: NativeAccountPlanPreview["account"];
  readonly text: string;
  readonly tone: RowTone;
  /** The exact prices or the verbatim reason. */
  readonly title: string;
}

export interface NativePlanIntegrityCell {
  readonly label: string;
  readonly tone: RowTone;
  readonly detail: string;
  readonly integrityClass: NativeIntegrityClass;
  /** A textual marker so a fail-closed state is never told by colour alone. */
  readonly marker: string;
}

export interface NativePlanRowView {
  /** The alert id: unique per plan, stable across pages and refreshes. */
  readonly key: string;
  readonly alertId: string;
  readonly triggeredAtText: string;
  readonly triggeredAtExact: string;
  readonly symbol: string;
  readonly sourceTimeframe: string;
  readonly direction: string;
  readonly directionTone: RowTone;
  readonly entry: string;
  readonly planLabel: string;
  readonly planTone: RowTone;
  readonly planTitle: string;
  readonly selectedLookback: string;
  readonly rr: string;
  readonly accounts: readonly NativePlanAccountCell[];
  readonly integrity: NativePlanIntegrityCell;
}

/** Display only: the exact decimal string stays authoritative (and in the detail view). */
export function ratioText(value: string | null): string {
  if (value === null) return "—";
  const n = Number(value);
  return Number.isFinite(n) ? `1:${Number(n.toFixed(2))}` : "—";
}

const SELECTED_STATE_SHORT: Readonly<Record<SelectedPlanSummary["state"], string | null>> = Object.freeze({
  SELECTED: "SELECTED",
  PLAN_NOT_READY: null,
  NO_SELECTED_CANDIDATE: "NO CANDIDATE",
  SELECTED_CANDIDATE_INVALID: "NOT CALCULABLE",
});

function planCell(plan: SelectedPlanSummary): { label: string; tone: RowTone; title: string } {
  const status = nativePlanStatusLabel(plan.planStatus);
  const state = SELECTED_STATE_SHORT[plan.state];
  const label = state === null ? status : `${status} · ${state}`;
  // READY without a usable selected candidate is not a healthy plan, whatever its status says.
  const tone: RowTone = plan.planStatus === "READY" && plan.state !== "SELECTED" ? "yellow" : nativePlanStatusTone(plan.planStatus);
  return { label, tone, title: plan.reason ?? `${plan.planStatus} / ${plan.state}` };
}

const ACCOUNT_STATE_SHORT: Readonly<Record<NativeAccountPlanPreview["state"], string>> = Object.freeze({
  RESOLVED: "",
  PLAN_NOT_READY: "NOT READY",
  NO_CANDIDATE: "NO CANDIDATE",
  CANDIDATE_INVALID: "NOT CALCULABLE",
  INVALID_POLICY: "INVALID POLICY",
});

export function presentNativeAccountCell(preview: NativeAccountPlanPreview): NativePlanAccountCell {
  if (preview.state === "INVALID_POLICY") {
    return { account: preview.account, text: ACCOUNT_STATE_SHORT.INVALID_POLICY, tone: "red", title: preview.reason ?? "The account's lookback override is refused." };
  }
  const lookback = `${preview.lookback}`;
  if (preview.state !== "RESOLVED") {
    return {
      account: preview.account,
      text: `${lookback} · ${ACCOUNT_STATE_SHORT[preview.state]}`,
      tone: preview.state === "PLAN_NOT_READY" ? "gray" : "yellow",
      title: preview.reason ?? ACCOUNT_STATE_SHORT[preview.state],
    };
  }
  const partial = preview.complete === false ? " (partial)" : "";
  return {
    account: preview.account,
    text: `${lookback} · RR ${ratioText(preview.riskRewardRatio)}${partial}`,
    tone: "green",
    title: `Lookback ${lookback} · SL ${preview.stopLoss ?? "—"} · TP ${preview.takeProfit ?? "—"} · RR ${preview.riskRewardRatio ?? "—"}`,
  };
}

export function presentNativeIntegrityCell(item: Pick<NativePlanListItemDto, "executionIntegrity">): NativePlanIntegrityCell {
  const view = presentNativeExecutionIntegrity(item.executionIntegrity);
  // A missing or unrecognised status is fail-closed, exactly as its UNREADABLE label says.
  const integrityClass = nativeIntegrityClassOf(item.executionIntegrity?.status);
  return { ...view, integrityClass, marker: integrityClass === "FAIL_CLOSED" ? "! " : "" };
}

export function presentNativePlanRow(item: NativePlanListItemDto): NativePlanRowView {
  const plan = planCell(item.plan);
  return {
    key: item.alertId,
    alertId: item.alertId,
    triggeredAtText: formatDateTime(item.triggeredAt),
    triggeredAtExact: item.triggeredAt,
    symbol: item.symbol,
    sourceTimeframe: item.sourceTimeframe ?? "—",
    direction: item.plan.direction,
    directionTone: item.plan.direction === "LONG" ? "green" : "red",
    entry: item.plan.entryPrice,
    planLabel: plan.label,
    planTone: plan.tone,
    planTitle: plan.title,
    selectedLookback: `${item.plan.selectedLookback}`,
    rr: item.plan.state === "SELECTED" ? ratioText(item.plan.riskRewardRatio) : "—",
    accounts: item.accountDefaults.map(presentNativeAccountCell),
    integrity: presentNativeIntegrityCell(item),
  };
}

export const NATIVE_PLAN_PAGE_UNSUPPORTED =
  "The backend answered with the original Native plan list (no page fields). Update and restart the backend to use the paged table.";

/**
 * A backend older than this page answers a page query with the original
 * 20-item list. That is refused here, so it is reported as such instead of
 * being shown as if it were a filtered, counted page.
 */
export function asNativePlanPage(value: unknown): NativePlanPageDto {
  const page = value as Partial<NativePlanPageDto> | null;
  if (page === null || typeof page !== "object" || !Array.isArray(page.items) || page.pagination == null || page.summary == null) {
    throw new Error(NATIVE_PLAN_PAGE_UNSUPPORTED);
  }
  return page as NativePlanPageDto;
}

/**
 * Never more rows than one page can hold, and never two rows with one key:
 * the DOM stays bounded and React keys stay unique even if a response were
 * malformed. The server already guarantees both; this only refuses to trust it.
 */
export function boundedNativePlanItems(items: readonly NativePlanListItemDto[]): NativePlanListItemDto[] {
  const seen = new Set<string>();
  const out: NativePlanListItemDto[] = [];
  for (const item of items) {
    if (out.length >= NATIVE_PLAN_PAGE_MAX_SIZE) break;
    if (seen.has(item.alertId)) continue;
    seen.add(item.alertId);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Counts above the table, each labelled with exactly what it covers
// ---------------------------------------------------------------------------

export interface IntegrityCounts {
  readonly total: number;
  readonly healthy: number;
  readonly pending: number;
  readonly failClosed: number;
}

/** THIS PAGE ONLY: integrity is evaluated per page from scanner files, never counted in the database. */
export function summarizePageIntegrity(items: readonly Pick<NativePlanListItemDto, "executionIntegrity">[]): IntegrityCounts {
  let healthy = 0;
  let pending = 0;
  let failClosed = 0;
  for (const item of items) {
    const integrityClass = presentNativeIntegrityCell(item).integrityClass;
    if (integrityClass === "HEALTHY") healthy += 1;
    else if (integrityClass === "PENDING") pending += 1;
    else failClosed += 1;
  }
  return { total: items.length, healthy, pending, failClosed };
}

export interface PlanStatusCountView {
  readonly status: ExtremeRRPlanStatus;
  readonly label: string;
  readonly count: number;
  readonly tone: RowTone;
}

/** READY always; every other status only when present. */
export function planStatusCountViews(counts: NativePlanStatusCounts): PlanStatusCountView[] {
  return EXTREME_RR_STATUSES.filter((status) => status === "READY" || (counts.byPlanStatus[status] ?? 0) > 0).map((status) => ({
    status,
    label: nativePlanStatusLabel(status),
    count: counts.byPlanStatus[status] ?? 0,
    tone: nativePlanStatusTone(status),
  }));
}

/** One line under the table that never claims more than the response proves. */
export function nativePlanPageCaption(pagination: NativePlanPagination, pageNumber: number, shown: number): string {
  const page = `Page ${pageNumber}`;
  if (pagination.integrityScan !== null) {
    const scan = pagination.integrityScan;
    const reach = scan.exhausted ? "the scan reached the oldest matching plan" : "older plans are not scanned yet; Next continues the scan";
    return `${page} · ${shown} matching on this page · ${scan.scanned} plan(s) checked for integrity by this page (limit ${scan.limit}) · ${reach}`;
  }
  if (pagination.totalMatching === null) return `${page} · ${shown} shown`;
  if (shown === 0) return `${page} · 0 of ${pagination.totalMatching}`;
  const from = (pageNumber - 1) * pagination.pageSize + 1;
  return `${page} · ${from}–${from + shown - 1} of ${pagination.totalMatching}`;
}
