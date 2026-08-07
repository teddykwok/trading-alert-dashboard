-- Phase 8 execution journal: realized-result components.
-- Both columns are NULLABLE and null means "unknown / not yet collected".
-- Nothing estimates them and no historical Binance fetch exists, so they stay
-- null until a future phase records real values. Null is never zero.

-- AlterTable
ALTER TABLE "TradeExecution" ADD COLUMN     "tradingFeesUsd" DECIMAL(30,12),
ADD COLUMN     "fundingPnlUsd" DECIMAL(30,12);

-- CreateIndex
-- Journal lists default to "most recently updated first". status,
-- executionProfileId, symbol and (alertId, executionProfileId) are already
-- indexed, so this is the only addition the list query genuinely needs.
CREATE INDEX "TradeExecution_updatedAt_idx" ON "TradeExecution"("updatedAt");
