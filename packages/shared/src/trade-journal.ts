/**
 * Trade Checklist & Psychology Journal — deterministic, self-reported
 * discipline/emotion documentation attached one-to-one to an alert.
 *
 * Nothing here judges the trade: the checklist summary is a plain count of
 * checked items (no weighting, no "discipline score"), and it is always
 * derived from the stored booleans — never persisted.
 */

export const TRADE_EMOTIONS = [
  "CALM",
  "ANXIOUS",
  "EXCITED",
  "FRUSTRATED",
  "TIRED",
  "FOMO",
  "REVENGE",
  "UNCERTAIN",
] as const;
export type TradeEmotion = (typeof TRADE_EMOTIONS)[number];

/** Display labels so components never re-spell enum values. */
export const TRADE_EMOTION_LABELS: Record<TradeEmotion, string> = {
  CALM: "Calm",
  ANXIOUS: "Anxious",
  EXCITED: "Excited",
  FRUSTRATED: "Frustrated",
  TIRED: "Tired",
  FOMO: "FOMO",
  REVENGE: "Revenge",
  UNCERTAIN: "Uncertain",
};

/**
 * The pre-trade checklist, defined once. `key` doubles as the boolean column
 * name on the TradeJournal model and the API field name — keep them in sync.
 */
export const TRADE_CHECKLIST_ITEMS = [
  { key: "signalMatchesPlan", label: "Signal matches my trading plan" },
  { key: "entryStopTargetDefined", label: "Entry, stop loss, and take profit are defined" },
  { key: "riskWithinLimit", label: "Risk is within my limit" },
  { key: "leverageReviewed", label: "Leverage and required margin were reviewed" },
  { key: "notFomo", label: "I am not entering because of FOMO" },
  { key: "notRevengeTrade", label: "This is not a revenge trade" },
  { key: "acceptsPotentialLoss", label: "I accept the possible loss before entering" },
] as const satisfies readonly { key: string; label: string; description?: string }[];

export type TradeChecklistKey = (typeof TRADE_CHECKLIST_ITEMS)[number]["key"];

export type TradeChecklist = Record<TradeChecklistKey, boolean>;

/** Self-reported confidence bounds (1 = very low, 5 = very high). */
export const TRADE_CONFIDENCE_MIN = 1;
export const TRADE_CONFIDENCE_MAX = 5;

/** Documented max lengths for the journal's free-text fields. */
export const TRADE_JOURNAL_TEXT_LIMITS = {
  reasonForEntry: 2000,
  preTradeNotes: 5000,
  postTradeReflection: 5000,
  lessonLearned: 2000,
} as const;

/**
 * A trade journal as serialized over the API. `id`, `createdAt`, and
 * `updatedAt` are null in the default representation returned before any
 * journal has been persisted for an alert (mirrors TradeReview).
 */
export interface TradeJournal extends TradeChecklist {
  id: string | null;
  alertId: string;
  emotion: TradeEmotion | null;
  /** Self-reported confidence (1–5) — the trader's own feeling, not a model output. */
  confidenceLevel: number | null;
  reasonForEntry: string | null;
  preTradeNotes: string | null;
  postTradeReflection: string | null;
  lessonLearned: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TradeChecklistSummary {
  completedCount: number;
  totalCount: number;
  /** Rounded to the nearest integer percent. */
  completionPercentage: number;
  isComplete: boolean;
  incompleteItems: TradeChecklistKey[];
}

/** GET/PUT /api/alerts/:alertId/trade-journal response shape. */
export interface TradeJournalWithSummary extends TradeJournal {
  checklistSummary: TradeChecklistSummary;
}

/**
 * GET /api/trade-journals/stats — plain counts only. Deliberately no
 * win-rate correlation and no claims about what completion or emotions
 * mean for performance.
 */
export interface TradeDisciplineStats {
  journals: number;
  fullChecklists: number;
  incompleteChecklists: number;
  mostCommonEmotion: TradeEmotion | null;
}

/**
 * Derives the checklist summary from the stored booleans. A plain count —
 * deliberately no weighting and no invented psychological/discipline score.
 */
export function summarizeChecklist(
  checklist: Partial<Record<TradeChecklistKey, boolean>>
): TradeChecklistSummary {
  const incompleteItems = TRADE_CHECKLIST_ITEMS.filter((item) => checklist[item.key] !== true).map(
    (item) => item.key
  );
  const totalCount = TRADE_CHECKLIST_ITEMS.length;
  const completedCount = totalCount - incompleteItems.length;

  return {
    completedCount,
    totalCount,
    completionPercentage: Math.round((completedCount / totalCount) * 100),
    isComplete: completedCount === totalCount,
    incompleteItems,
  };
}
