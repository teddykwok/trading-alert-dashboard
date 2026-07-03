-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "duplicateCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastDuplicateAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Alert_symbol_assetType_timeframe_signal_indicatorName_idx" ON "Alert"("symbol", "assetType", "timeframe", "signal", "indicatorName");
