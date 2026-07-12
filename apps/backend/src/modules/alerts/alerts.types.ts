import type {
  Alert,
  AlertEventType,
  AlertStatus,
  AssetType,
  LevelColor,
  SignalType,
  TouchDirection,
  Prisma,
} from "@prisma/client";

export type { Alert, AlertEventType, AlertStatus, AssetType, LevelColor, SignalType, TouchDirection };

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
  symbol?: string;
  signal?: SignalType;
  assetType?: AssetType;
  sourceTimeframe?: string;
  levelColor?: LevelColor;
  limit: number;
  offset: number;
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
  symbol: string;
  assetType: AssetType;
  timeframe: string;
  signal: SignalType;
  indicatorName: string | null;
  since: Date;
}
