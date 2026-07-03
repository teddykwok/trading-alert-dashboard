import { apiClient } from "./client";
import type { WebhookInfoResponse } from "../types/api";

export const settingsApi = {
  getWebhookInfo: () => apiClient.get<WebhookInfoResponse>("/api/settings/webhook-info"),
};
