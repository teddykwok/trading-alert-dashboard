import type {
  Alert,
  AlertEventType,
  AlertSource,
  AlertStatus,
  AssetType,
  LevelColor,
  SignalType,
  TouchDirection,
  Prisma,
} from "@prisma/client";

export type { Alert, AlertEventType, AlertSource, AlertStatus, AssetType, LevelColor, SignalType, TouchDirection };

export interface CreateAlertInput {
  assetId: string | null;
  symbol: string;
  assetType: AssetType;
  exchange: string | null;
  timeframe: string;
  price: number;
  signal: SignalType;
  indicatorName: string | null;
  indicatorValue: number | null;
  rawPayload: Prisma.InputJsonValue;
  /** Required: who produced the alert is stated, never left to a default. */
  source: AlertSource;
  triggeredAt: Date;
  // Level context parsed from the webhook note (all null when the note has
  // no structured metadata). sourceTimeframe = level origin tf, NOT the
  // chart timeframe stored in `timeframe`.
  eventType: AlertEventType | null;
  levelColor: LevelColor | null;
  sourceTimeframe: string | null;
  touchDirection: TouchDirection | null;
}

export interface AlertListFilter {
  status?: AlertStatus;
  /** Case-insensitive substring match (matches the dashboard search box). */
  symbol?: string;
  signal?: SignalType;
  /** Multi-signal filter (e.g. actionable = LONG+SHORT); wins over `signal`. */
  signals?: SignalType[];
  assetType?: AssetType;
  sourceTimeframe?: string;
  /** Multi-source-timeframe filter (OR semantics); wins over `sourceTimeframe`. */
  sourceTimeframes?: string[];
  levelColor?: LevelColor;
  limit: number;
  offset: number;
}

/** List filters without paging — the predicate shared with neighbor lookup. */
export type AlertNeighborFilter = Omit<AlertListFilter, "limit" | "offset">;

/** Minimal identity of an adjacent alert in the dashboard ordering. */
export interface AlertNeighbor {
  id: string;
  symbol: string;
  createdAt: Date;
}

export interface AlertNeighborsResult {
  newer: AlertNeighbor | null;
  older: AlertNeighbor | null;
}

/**
 * Range for the dashboard stat cards. Both bounds are explicit because the
 * server cannot know the viewer's timezone — the client states which instants
 * bound its "today". `from` is inclusive, `to` exclusive.
 */
export interface AlertStatsRange {
  from: Date;
  to: Date;
}

export interface AiVisionUpdateInput {
  aiBias: string;
  aiConfidence: number;
  aiPattern: string;
  aiSummary: string;
  aiRiskNotes: string[];
  aiProvider: string;
}

export interface DuplicateLookupInput {
  /** Only alerts of this source can be a duplicate. The webhook always passes TRADINGVIEW. */
  source: AlertSource;
  symbol: string;
  assetType: AssetType;
  timeframe: string;
  signal: SignalType;
  indicatorName: string | null;
  since: Date;
}
