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
   * Multi-signal filter, sent to the server as comma-separated values
   * (`signals=LONG,SHORT`). Wins over `signal` when both are set.
   * "Actionable only" = ["LONG", "SHORT"]; undefined = all signals.
   */
  signals?: SignalType[];
  assetType?: AssetType;
  /** Timeframe the level originated on (1D…12M) — not the chart timeframe. */
  sourceTimeframe?: SourceTimeframe;
  levelColor?: LevelColor;
  limit?: number;
  offset?: number;
}

/**
 * Bounds of the stat cards' range as ISO instants. The client sends its local
 * day boundaries because only the browser knows the viewer's timezone.
 */
export interface AlertStatsQuery {
  from: string;
  to: string;
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
