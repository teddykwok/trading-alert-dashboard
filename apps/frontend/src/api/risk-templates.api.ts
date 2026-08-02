import { apiClient } from "./client";
import type { RiskTemplate } from "@trading-alert-dashboard/shared";

/**
 * Decimal fields travel as exact strings ("400", "1.5"). riskAmount and
 * targetAmount in responses are always derived server-side from the stored
 * template — they are never accepted as inputs.
 */
export interface RiskTemplateInput {
  name: string;
  referenceCapital: string;
  riskPercent: string;
  rewardRatio: string;
}

export const riskTemplatesApi = {
  list: () => apiClient.get<RiskTemplate[]>("/api/risk-templates"),
  /** null when no template is active. */
  getActive: () => apiClient.get<RiskTemplate | null>("/api/risk-templates/active"),
  create: (input: RiskTemplateInput) => apiClient.post<RiskTemplate>("/api/risk-templates", input),
  update: (id: string, input: Partial<RiskTemplateInput>) =>
    apiClient.patch<RiskTemplate>(`/api/risk-templates/${id}`, input),
  activate: (id: string) => apiClient.post<RiskTemplate>(`/api/risk-templates/${id}/activate`),
  remove: (id: string) => apiClient.delete<void>(`/api/risk-templates/${id}`),
};
