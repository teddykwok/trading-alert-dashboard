/**
 * Whole-range alert statistics, always computed in the database over every
 * matching row. These are deliberately independent of the dashboard's list
 * filters and of pagination: the cards answer "what happened today?", not
 * "what is on screen?".
 */
export interface AlertStats {
  /** Start of the counted range (inclusive), echoed back for clarity. */
  from: string;
  /** End of the counted range (exclusive). */
  to: string;
  /** Every alert created in the range, whatever its signal or status. */
  total: number;
  long: number;
  short: number;
  /**
   * RECEIVED + PROCESSING_SCREENSHOT + ANALYZING_WITH_AI (still in flight),
   * excluding dashboard-only NATIVE alerts, which are never analysed.
   */
  processing: number;
  analyzed: number;
  failed: number;
}
