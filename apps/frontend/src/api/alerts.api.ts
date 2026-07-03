import { apiClient } from "./client";
import type { Alert, AlertStatus } from "../types/alert";
import type { AlertListQuery, AlertListResponse } from "../types/api";

function toQueryString(query: AlertListQuery): string {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const alertsApi = {
  list: (query: AlertListQuery = {}) =>
    apiClient.get<AlertListResponse>(`/api/alerts${toQueryString(query)}`),

  getById: (id: string) => apiClient.get<Alert>(`/api/alerts/${id}`),

  updateStatus: (id: string, status: AlertStatus, errorMessage?: string) =>
    apiClient.patch<Alert>(`/api/alerts/${id}/status`, { status, errorMessage }),

  remove: (id: string) => apiClient.delete<void>(`/api/alerts/${id}`),
};
