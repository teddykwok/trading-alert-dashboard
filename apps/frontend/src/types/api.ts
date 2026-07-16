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
  /** Single-signal filter as supported by the backend list API. */
  signal?: SignalType;
  /**
   * Multi-signal filter used by the dashboard's CLIENT-SIDE filtering (like
   * every other dashboard filter, it is applied to the fetched alert window,
   * never sent to the server). "Actionable only" = ["LONG", "SHORT"];
   * undefined = all signals.
   */
  signals?: SignalType[];
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
