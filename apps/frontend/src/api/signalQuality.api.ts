import type {
  SignalQualityChartDto,
  SignalQualityDetailDto,
  SignalQualityPageDto,
  SignalQualitySoakHealthDto,
  SignalQualitySummaryDto,
} from "@trading-alert-dashboard/shared";
import { apiClient } from "./client";

/**
 * The Native signal-quality observatory's API. READ ONLY: every call is a GET.
 * There is deliberately no post/put/patch/delete here — the observatory can
 * observe and do nothing else.
 */

const BASE = "/api/signal-quality";

export function fetchSignalQualitySummary(query: string, signal?: AbortSignal): Promise<SignalQualitySummaryDto> {
  return apiClient.getCancellable<SignalQualitySummaryDto>(`${BASE}/summary${query ? `?${query}` : ""}`, signal);
}

export function fetchSignalQualityPage(query: string, signal?: AbortSignal): Promise<SignalQualityPageDto> {
  return apiClient.getCancellable<SignalQualityPageDto>(`${BASE}/signals${query ? `?${query}` : ""}`, signal);
}

export function fetchSignalQualityDetail(alertId: string, asOf: string | null, signal?: AbortSignal): Promise<SignalQualityDetailDto> {
  return apiClient.getCancellable<SignalQualityDetailDto>(`${BASE}/signals/${encodeURIComponent(alertId)}${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ""}`, signal);
}

export function fetchSignalQualityChart(alertId: string, asOf: string | null, signal?: AbortSignal): Promise<SignalQualityChartDto> {
  return apiClient.getCancellable<SignalQualityChartDto>(`${BASE}/signals/${encodeURIComponent(alertId)}/chart${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ""}`, signal);
}

export function fetchSoakHealth(signal?: AbortSignal): Promise<SignalQualitySoakHealthDto> {
  return apiClient.getCancellable<SignalQualitySoakHealthDto>(`${BASE}/soak-health`, signal);
}

/** A plain link the browser downloads (GET). Same filters as the table, without paging. */
export function signalQualityExportHref(query: string, format: "csv" | "json"): string {
  const params = new URLSearchParams(query);
  params.delete("offset");
  params.delete("pageSize");
  params.set("format", format);
  const configured = import.meta.env.VITE_API_URL?.trim() ?? "";
  return `${configured}${BASE}/export?${params.toString()}`;
}
