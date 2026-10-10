import { apiClient } from "./client";
import type {
  ExtremeRRLeverage,
  ExtremeRRLookback,
  ExtremeRRPlanDto,
  NativePlanListDto,
  NativePlanPageDto,
} from "@trading-alert-dashboard/shared";

/**
 * All plan numbers (SL/TP, quantity, margins…) are calculated server-side
 * from the frozen alert-time snapshot. The ONLY writable fields are the two
 * selections below; candidate values are never sent by the client.
 */
export interface ExtremeRRSelectionInput {
  selectedLookback?: ExtremeRRLookback;
  selectedLeverage?: ExtremeRRLeverage | null;
}

export const extremeRRApi = {
  /** null when no plan exists yet (e.g. alerts that predate the feature). */
  getForAlert: (alertId: string) =>
    apiClient.get<ExtremeRRPlanDto | null>(`/api/alerts/${alertId}/extreme-rr`),

  /** Safe for historical alerts — always uses the original triggeredAt cutoff. */
  generate: (alertId: string) =>
    apiClient.post<ExtremeRRPlanDto>(`/api/alerts/${alertId}/extreme-rr/generate`),

  updateSelection: (alertId: string, input: ExtremeRRSelectionInput) =>
    apiClient.patch<ExtremeRRPlanDto>(`/api/alerts/${alertId}/extreme-rr`, input),

  /** READ ONLY: recent Native plans as their selected, frozen summaries. Generates nothing. */
  listNativePlans: () => apiClient.get<NativePlanListDto>("/api/extreme-rr/native-plans"),

  /**
   * READ ONLY: one page of Native plans (search, filters, newest trigger first),
   * with server-side counts. `query` is a page query string built by
   * nativePlanQueryString. Generates, selects and writes nothing; abortable so a
   * superseded page is cancelled.
   */
  listNativePlanPage: (query: string, signal?: AbortSignal) =>
    apiClient.getCancellable<NativePlanPageDto>(`/api/extreme-rr/native-plans${query}`, signal),
};
