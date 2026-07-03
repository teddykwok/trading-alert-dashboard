import type { Alert, AlertStatus, AssetType, SignalType, Prisma } from "@prisma/client";

export type { Alert, AlertStatus, AssetType, SignalType };

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
}

export interface AlertListFilter {
  status?: AlertStatus;
  symbol?: string;
  signal?: SignalType;
  assetType?: AssetType;
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
