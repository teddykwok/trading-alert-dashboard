import { apiClient } from "./client";
import type {
  ExtremeRRLeverage,
  ExtremeRRLookback,
  ExtremeRRPlanDto,
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
};
