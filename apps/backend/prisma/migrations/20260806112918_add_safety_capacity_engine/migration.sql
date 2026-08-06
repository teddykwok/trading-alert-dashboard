-- CreateEnum
CREATE TYPE "SafetyDecision" AS ENUM ('PASS', 'SKIP', 'RETRY_CONFLICT', 'UNAVAILABLE');

-- AlterTable
ALTER TABLE "TradeExecution" ADD COLUMN     "signalTriggeredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ExecutionSafetyPolicy" (
    "id" TEXT NOT NULL,
    "executionProfileId" TEXT NOT NULL,
    "killSwitchActive" BOOLEAN NOT NULL DEFAULT true,
    "maxOpenPositions" INTEGER NOT NULL DEFAULT 1,
    "maxPendingEntries" INTEGER NOT NULL DEFAULT 1,
    "maxTotalActiveTrades" INTEGER NOT NULL DEFAULT 1,
    "maxActivePerSymbolSide" INTEGER NOT NULL DEFAULT 1,
    "maxAlertAgeSeconds" INTEGER NOT NULL DEFAULT 300,
    "maxTotalPlannedRiskUsd" DECIMAL(30,12) NOT NULL DEFAULT 1.50,
    "maxTotalIsolatedMarginUsd" DECIMAL(30,12) NOT NULL DEFAULT 5.00,
    "allowedSymbols" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionSafetyPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyAdmission" (
    "id" TEXT NOT NULL,
    "tradeExecutionId" TEXT NOT NULL,
    "evaluatedVersion" INTEGER NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "decision" "SafetyDecision" NOT NULL,
    "reasonCode" TEXT,
    "message" TEXT,
    "signalAgeSeconds" INTEGER,
    "effectiveLimits" JSONB,
    "capacityBefore" JSONB,
    "capacityProjected" JSONB,
    "reservedRiskUsd" DECIMAL(30,12),
    "reservedMarginUsd" DECIMAL(30,12),
    "symbolStateSummary" JSONB,
    "binanceSnapshotAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SafetyAdmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionSafetyPolicy_executionProfileId_key" ON "ExecutionSafetyPolicy"("executionProfileId");

-- CreateIndex
CREATE INDEX "SafetyAdmission_tradeExecutionId_idx" ON "SafetyAdmission"("tradeExecutionId");

-- CreateIndex
CREATE INDEX "SafetyAdmission_decision_idx" ON "SafetyAdmission"("decision");

-- CreateIndex
CREATE UNIQUE INDEX "SafetyAdmission_tradeExecutionId_evaluatedVersion_key" ON "SafetyAdmission"("tradeExecutionId", "evaluatedVersion");

-- AddForeignKey
ALTER TABLE "ExecutionSafetyPolicy" ADD CONSTRAINT "ExecutionSafetyPolicy_executionProfileId_fkey" FOREIGN KEY ("executionProfileId") REFERENCES "ExecutionProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SafetyAdmission" ADD CONSTRAINT "SafetyAdmission_tradeExecutionId_fkey" FOREIGN KEY ("tradeExecutionId") REFERENCES "TradeExecution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
