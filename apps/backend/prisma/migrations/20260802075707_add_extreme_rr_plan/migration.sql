-- CreateEnum
CREATE TYPE "ExtremeRRPlanStatus" AS ENUM ('PENDING', 'READY', 'INVALID', 'ERROR');

-- CreateTable
CREATE TABLE "ExtremeRRPlan" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "status" "ExtremeRRPlanStatus" NOT NULL DEFAULT 'PENDING',
    "direction" "SignalType" NOT NULL,
    "entryBasis" TEXT NOT NULL DEFAULT 'ALERT_PRICE',
    "entryPrice" DECIMAL(30,12) NOT NULL,
    "cutoffAt" TIMESTAMP(3) NOT NULL,
    "timeframe" TEXT NOT NULL,
    "marketType" TEXT,
    "riskTemplateId" TEXT,
    "templateName" TEXT,
    "referenceCapital" DECIMAL(30,12),
    "riskPercent" DECIMAL(10,6),
    "rewardRatio" DECIMAL(10,4),
    "riskAmount" DECIMAL(30,12),
    "targetAmount" DECIMAL(30,12),
    "candidates" JSONB,
    "selectedLookback" INTEGER NOT NULL DEFAULT 300,
    "selectedLeverage" INTEGER,
    "errorReason" TEXT,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtremeRRPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExtremeRRPlan_alertId_key" ON "ExtremeRRPlan"("alertId");

-- CreateIndex
CREATE INDEX "ExtremeRRPlan_status_idx" ON "ExtremeRRPlan"("status");

-- AddForeignKey
ALTER TABLE "ExtremeRRPlan" ADD CONSTRAINT "ExtremeRRPlan_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
