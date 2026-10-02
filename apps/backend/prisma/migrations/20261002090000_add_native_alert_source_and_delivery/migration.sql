-- Native alert emitter: a first-class alert SOURCE and the delivery LEDGER.
--
-- ADDITIVE ONLY: one new enum, one new column with a default, one new table.
-- No column is dropped, retyped or made required without a default, and no
-- existing row changes meaning: every existing Alert becomes TRADINGVIEW,
-- which is exactly what every existing Alert is.
--
-- WHY A COLUMN AND NOT A PAYLOAD FIELD
--
-- The execution fences must be decidable by the database in the same query
-- that discovers work. A flag hidden in rawPayload JSON would let a payload
-- that omits it pass as TradingView; a NOT NULL enum with a TRADINGVIEW
-- default cannot be omitted, and NATIVE can only be written deliberately.
--
-- WHY THE LEDGER
--
-- At most one dashboard Alert per (policy, lineage, market, symbol, chart
-- interval, bar). deliveryKey is a versioned canonical hash of exactly those
-- fields and is UNIQUE, so two emitters racing on one bar, or one emitter
-- re-reading its log after a restart, cannot both insert: the second gets a
-- unique violation and adopts (or, on a provenance contradiction, refuses).
-- The ledger row and its Alert are written in one transaction.

-- CreateEnum
CREATE TYPE "AlertSource" AS ENUM ('TRADINGVIEW', 'NATIVE');

-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "source" "AlertSource" NOT NULL DEFAULT 'TRADINGVIEW';

-- CreateTable
CREATE TABLE "NativeAlertDelivery" (
    "id" TEXT NOT NULL,
    "deliveryKey" TEXT NOT NULL,
    "deliveryKeySchema" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "lineageId" TEXT NOT NULL,
    "marketType" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "chartInterval" TEXT NOT NULL,
    "barOpenTime" TIMESTAMP(3) NOT NULL,
    "winningShadowEventId" TEXT NOT NULL,
    "evidenceClass" TEXT NOT NULL,
    "provenanceSha256" TEXT NOT NULL,
    "alertId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NativeAlertDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NativeAlertDelivery_deliveryKey_key" ON "NativeAlertDelivery"("deliveryKey");

-- CreateIndex
CREATE UNIQUE INDEX "NativeAlertDelivery_alertId_key" ON "NativeAlertDelivery"("alertId");

-- CreateIndex
CREATE INDEX "NativeAlertDelivery_lineageId_symbol_barOpenTime_idx" ON "NativeAlertDelivery"("lineageId", "symbol", "barOpenTime");

-- CreateIndex
CREATE INDEX "Alert_source_idx" ON "Alert"("source");

-- AddForeignKey
ALTER TABLE "NativeAlertDelivery" ADD CONSTRAINT "NativeAlertDelivery_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE SET NULL ON UPDATE CASCADE;
