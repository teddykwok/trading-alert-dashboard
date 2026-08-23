-- Source Timeframe execution filter — ADDITIVE ONLY.
--
-- Two columns, no table recreated, no column dropped, no existing value
-- rewritten, no index changed.
--
-- WHY THE POLICY DEFAULT IS ALL SIX
-- Before this feature every source timeframe was eligible, because nothing
-- consulted the source timeframe at all. The default is what turns "the column
-- did not exist" into "the column says every supported timeframe", so existing
-- rows keep their exact current behaviour with no backfill script and no
-- inference. An empty default would have silently disarmed every profile on
-- deploy, which is the one outcome this column exists to make impossible.
--
-- Note the emptiness asymmetry against "allowedSymbols" on the same table:
-- there, empty means no extra restriction; here, empty admits nothing, because
-- admission asks whether the list CONTAINS the signal's timeframe. That is
-- deliberate and is enforced in the engine, not by this default.
ALTER TABLE "ExecutionSafetyPolicy"
  ADD COLUMN IF NOT EXISTS "allowedSourceTimeframes" TEXT[]
    NOT NULL DEFAULT ARRAY['1D', '1W', '1M', '3M', '6M', '12M']::TEXT[];

-- WHY THE EXECUTION COLUMN IS NULLABLE WITH NO DEFAULT
-- It is a frozen copy of the originating Alert's sourceTimeframe, mirroring
-- signalTriggeredAt: retention may null alertId, so an admission input that
-- lives only on the alert can vanish. Existing rows are already admitted or
-- terminal and are never re-admitted, so they need no value; a NEW execution
-- that somehow reaches admission without one fails closed with
-- SOURCE_TIMEFRAME_UNAVAILABLE. Backfilling a guess here would manufacture
-- eligibility, so nothing is backfilled.
ALTER TABLE "TradeExecution"
  ADD COLUMN IF NOT EXISTS "sourceTimeframe" TEXT;
