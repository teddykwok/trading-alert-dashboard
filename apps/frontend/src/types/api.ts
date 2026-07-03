import type { Alert, AlertStatus, AssetType, SignalType } from "./alert";

export interface AlertListResponse {
  items: Alert[];
  total: number;
  limit: number;
  offset: number;
}

export interface AlertListQuery {
  status?: AlertStatus;
  symbol?: string;
  signal?: SignalType;
  assetType?: AssetType;
  limit?: number;
  offset?: number;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

export interface WebhookInfoResponse {
  webhookUrl: string;
  webhookPath: string;
  samplePayload: Record<string, unknown>;
  reminder: string;
}
