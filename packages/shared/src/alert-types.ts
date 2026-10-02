import type {
  AlertContext,
  AlertEventType,
  LevelColor,
  TouchDirection,
} from "./alert-context";

export type AssetType = "CRYPTO" | "STOCK";

export type SignalType = "LONG" | "SHORT" | "WATCH" | "EXIT";

/**
 * Who produced an alert. TRADINGVIEW: the authenticated webhook. NATIVE: the
 * in-house native scanner's emitter — dashboard-only, never planned or executed.
 */
export type AlertSource = "TRADINGVIEW" | "NATIVE";

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
  /** Optional only for payloads from servers that predate the column; absent means TRADINGVIEW. */
  source?: AlertSource;
  status: AlertStatus;
  screenshotUrl: string | null;
  aiBias: string | null;
  aiConfidence: number | null;
  aiPattern: string | null;
  aiSummary: string | null;
  aiRiskNotes: string[] | null;
  aiProvider: string | null;
  /**
   * Structured level context parsed from the webhook note at ingestion time.
   * Null on alerts received before these columns existed (their context is
   * still derived on read — see `alertContext`) and on notes without metadata.
   * `sourceTimeframe` is where the level originated (1D…12M) — NOT the chart
   * timeframe, which lives in `timeframe`.
   */
  eventType: AlertEventType | null;
  levelColor: LevelColor | null;
  sourceTimeframe: string | null;
  touchDirection: TouchDirection | null;
  /**
   * Derived level context attached by the API/socket serializer: structured
   * columns when present, else parsed from the original note; null when the
   * alert carries no level metadata at all.
   */
  alertContext?: AlertContext | null;
  duplicateCount: number;
  lastDuplicateAt: string | null;
  errorMessage: string | null;
  triggeredAt: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Present on list responses (and undefined on socket-pushed alerts): the
   * manual trade review's status, used for the outcome badge on alert cards.
   */
  tradeReview?: { status: import("./trade-review-types").TradeReviewStatus } | null;
  /**
   * Present on list responses (and undefined on socket-pushed alerts): the
   * journal's checklist booleans + emotion, used for the "Checklist n/7"
   * badge on alert cards. Null when no journal exists for the alert.
   */
  tradeJournal?:
    | (import("./trade-journal").TradeChecklist & {
        emotion: import("./trade-journal").TradeEmotion | null;
      })
    | null;
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
