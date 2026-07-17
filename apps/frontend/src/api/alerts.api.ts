import type { AlertStats } from "@trading-alert-dashboard/shared";
import { apiClient } from "./client";
import type { Alert, AlertStatus } from "../types/alert";
import type { AlertListQuery, AlertStatsQuery, AlertListResponse } from "../types/api";

function toQueryString(query: AlertListQuery | AlertStatsQuery): string {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === "") return;
    // Arrays (e.g. signals: ["LONG","SHORT"]) travel as comma-separated
    // values, matching the backend's `signals` query parameter format.
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(","));
      return;
    }
    params.set(key, String(value));
  });
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const alertsApi = {
  list: (query: AlertListQuery = {}) =>
    apiClient.get<AlertListResponse>(`/api/alerts${toQueryString(query)}`),

  // Whole-day counts aggregated in the database — never derived from a page.
  // Goes through apiClient.get, so StrictMode's double-invoked effect still
  // makes a single network request.
  stats: (query: AlertStatsQuery) =>
    apiClient.get<AlertStats>(`/api/alerts/stats${toQueryString(query)}`),

  getById: (id: string) => apiClient.get<Alert>(`/api/alerts/${id}`),

  updateStatus: (id: string, status: AlertStatus, errorMessage?: string) =>
    apiClient.patch<Alert>(`/api/alerts/${id}/status`, { status, errorMessage }),

  remove: (id: string) => apiClient.delete<void>(`/api/alerts/${id}`),
};
