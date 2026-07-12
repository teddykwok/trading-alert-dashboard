import type { Alert, AlertStatus, AssetType, LevelColor, SignalType, SourceTimeframe } from "./alert";

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
  /** Timeframe the level originated on (1D…12M) — not the chart timeframe. */
  sourceTimeframe?: SourceTimeframe;
  levelColor?: LevelColor;
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
