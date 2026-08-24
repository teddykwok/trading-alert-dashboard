-- Extreme RR lookback policy — ADDITIVE ONLY.
--
-- One column, no table recreated, no column dropped, no existing value
-- rewritten, no index changed, no historical plan or execution backfilled.
--
-- WHY THE DEFAULT IS 300
-- Before this feature every new plan started on the 300-candle candidate
-- (`EXTREME_RR_DEFAULT_LOOKBACK`). The default is what turns "the column did
-- not exist" into "the column says 300", so existing profiles keep their exact
-- current behaviour with no backfill script and no inference.
--
-- WHY NOTHING IS BACKFILLED ONTO PLANS OR EXECUTIONS
-- `ExtremeRRPlan.selectedLookback` and `TradeExecution.selectedLookback`
-- already carry each row's own frozen choice. This column governs the INITIAL
-- selection of a NEW plan and nothing else, so rewriting history here would
-- change what an existing trade claims it was planned from.
ALTER TABLE "ExecutionSafetyPolicy"
  ADD COLUMN IF NOT EXISTS "extremeRrLookbackCandles" INTEGER NOT NULL DEFAULT 300;
