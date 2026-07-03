export type AssetType = "CRYPTO" | "STOCK";

export type SignalType = "LONG" | "SHORT" | "WATCH" | "EXIT";

export type AlertStatus =
  | "RECEIVED"
  | "PROCESSING_SCREENSHOT"
  | "ANALYZING_WITH_AI"
  | "ANALYZED"
  | "FAILED"
  | "IGNORED_DUPLICATE";

export interface AiRiskNote {
  note: string;
}

export interface AiVisionResult {
  bias: string;
  confidence: number;
  pattern: string;
  summary: string;
  riskNotes: string[];
  provider: string;
}

export interface Alert {
  id: string;
  assetId: string | null;
  symbol: string;
  assetType: AssetType;
  exchange: string | null;
  timeframe: string;
  price: number;
  signal: SignalType;
  indicatorName: string | null;
  indicatorValue: number | null;
  rawPayload: unknown;
  status: AlertStatus;
  screenshotUrl: string | null;
  aiBias: string | null;
  aiConfidence: number | null;
  aiPattern: string | null;
  aiSummary: string | null;
  aiRiskNotes: string[] | null;
  aiProvider: string | null;
  duplicateCount: number;
  lastDuplicateAt: string | null;
  errorMessage: string | null;
  triggeredAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Asset {
  id: string;
  symbol: string;
  name: string | null;
  assetType: AssetType;
  exchange: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
