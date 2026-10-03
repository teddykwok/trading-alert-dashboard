import type { Alert, AlertSource, AlertStatus, AssetType, LevelColor, SignalType, SourceTimeframe } from "./alert";

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
   * "Long + Short only" (signal direction, every source) = ["LONG", "SHORT"]; undefined = all signals.
   */
  signals?: SignalType[];
  assetType?: AssetType;
  /** Timeframe the level originated on (1D…12M) — not the chart timeframe. */
  sourceTimeframe?: SourceTimeframe;
  /**
   * Multi-source-timeframe filter (OR semantics), sent as comma-separated
   * values (`sourceTimeframes=1D,1W`). Wins over `sourceTimeframe` when both
   * are set; undefined/empty = all source timeframes.
   */
  sourceTimeframes?: SourceTimeframe[];
  levelColor?: LevelColor;
  /**
   * Which source produced the alert: TRADINGVIEW (an actual webhook delivery)
   * or NATIVE (Native scanner evidence). Undefined = all sources. Independent
   * of the signal-direction filter.
   */
  source?: AlertSource;
  limit?: number;
  offset?: number;
}

/** Minimal identity of an adjacent alert in the dashboard ordering. */
export interface AlertNeighbor {
  id: string;
  symbol: string;
  createdAt: string;
}

/**
 * Response of GET /api/alerts/:id/neighbors — the alerts adjacent to the
 * current one in dashboard ordering (createdAt DESC, id DESC), restricted to
 * the supplied filters. Null at the newest/oldest boundary respectively.
 */
export interface AlertNeighborsResponse {
  newer: AlertNeighbor | null;
  older: AlertNeighbor | null;
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
