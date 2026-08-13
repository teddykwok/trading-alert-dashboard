-- Additive only: a new terminal TradeExecutionStatus for a position that is
-- PROVEN flat but whose closure cannot be attributed to one of our owned,
-- verified SL / TP / emergency orders (manual operator close, another client,
-- liquidation or ADL are indistinguishable from the reconciler's viewpoint).
--
-- No existing row changes value and no column is altered.
ALTER TYPE "TradeExecutionStatus" ADD VALUE IF NOT EXISTS 'CLOSED_EXTERNAL';

-- The matching notification milestone, so a Telegram message can be emitted for
-- an external closure without inventing a cause.
ALTER TYPE "ExecutionNotificationType" ADD VALUE IF NOT EXISTS 'CLOSED_EXTERNAL';
