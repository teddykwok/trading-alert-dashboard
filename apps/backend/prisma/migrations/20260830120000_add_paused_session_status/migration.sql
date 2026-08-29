-- Adds PAUSED to TradingSessionStatus.
--
-- Additive only. No existing row changes value, and no column is dropped or
-- retyped, so an older backend reading this database sees exactly what it saw
-- before. PAUSED is reachable only through the new Pause New Trades control.
--
-- The value is appended AFTER the existing ones deliberately: Postgres enum
-- ordering is positional, and inserting it earlier would silently reorder any
-- comparison or ORDER BY that relies on the existing sequence.
ALTER TYPE "TradingSessionStatus" ADD VALUE IF NOT EXISTS 'PAUSED';
