-- CreateEnum
CREATE TYPE "ProtectionState" AS ENUM ('UNPROTECTED', 'MARGIN_CHECK', 'MARGIN_ADJUSTING', 'PLACING_STOP', 'STOP_VERIFIED', 'PLACING_TAKE_PROFIT', 'PROTECTED', 'PROTECTION_INCOMPLETE', 'EMERGENCY_CLOSING', 'CLOSURE_CLEANUP', 'CLOSED', 'MANUAL_INTERVENTION');

-- CreateEnum
CREATE TYPE "MarginAdjustmentStatus" AS ENUM ('PENDING', 'SUBMITTING', 'RESULT_UNKNOWN', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CriticalAlertStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ExecutionEventType" ADD VALUE 'PROTECTION_RESERVED';
ALTER TYPE "ExecutionEventType" ADD VALUE 'PROTECTION_SUBMITTED';
ALTER TYPE "ExecutionEventType" ADD VALUE 'PROTECTION_VERIFIED';
ALTER TYPE "ExecutionEventType" ADD VALUE 'PROTECTION_RECONCILED';
ALTER TYPE "ExecutionEventType" ADD VALUE 'MARGIN_ADJUSTED';
ALTER TYPE "ExecutionEventType" ADD VALUE 'EMERGENCY_CLOSE_SUBMITTED';
ALTER TYPE "ExecutionEventType" ADD VALUE 'PROTECTION_CLEANUP';
ALTER TYPE "ExecutionEventType" ADD VALUE 'CRITICAL_ALERT_RAISED';

-- AlterEnum
ALTER TYPE "TradeExecutionStatus" ADD VALUE 'CLOSED_EMERGENCY';

-- AlterTable
ALTER TABLE "BinanceOrder" ADD COLUMN     "actualOrderId" TEXT,
ADD COLUMN     "algoStatus" TEXT,
ADD COLUMN     "clientAlgoId" TEXT,
ADD COLUMN     "exchangeAlgoId" TEXT,
ADD COLUMN     "priceProtect" BOOLEAN,
ADD COLUMN     "triggerPrice" DECIMAL(30,12),
ADD COLUMN     "triggeredAt" TIMESTAMP(3),
ADD COLUMN     "workingType" TEXT;

-- CreateTable
CREATE TABLE "ExecutionProtectionState" (
    "id" TEXT NOT NULL,
    "tradeExecutionId" TEXT NOT NULL,
    "state" "ProtectionState" NOT NULL DEFAULT 'UNPROTECTED',
    "confirmedOpenQuantity" DECIMAL(40,18) NOT NULL DEFAULT 0,
    "protectedStopQuantity" DECIMAL(40,18) NOT NULL DEFAULT 0,
    "protectedTakeProfitQuantity" DECIMAL(40,18) NOT NULL DEFAULT 0,
    "currentGeneration" INTEGER NOT NULL DEFAULT 0,
    "liquidationSafe" BOOLEAN,
    "verifiedAt" TIMESTAMP(3),
    "reasonCode" TEXT,
    "sanitizedMessage" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionProtectionState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarginAdjustmentIntent" (
    "id" TEXT NOT NULL,
    "tradeExecutionId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "positionSide" "ExecutionPositionSide" NOT NULL,
    "adjustType" INTEGER NOT NULL DEFAULT 1,
    "amount" DECIMAL(30,12) NOT NULL,
    "baselineIsolatedMargin" DECIMAL(30,12),
    "baselinePositionAmt" DECIMAL(40,18),
    "baselineLiquidationPrice" DECIMAL(30,12),
    "status" "MarginAdjustmentStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedIsolatedMargin" DECIMAL(30,12),
    "reasonCode" TEXT,
    "requestedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarginAdjustmentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CriticalAlert" (
    "id" TEXT NOT NULL,
    "tradeExecutionId" TEXT NOT NULL,
    "alertType" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "status" "CriticalAlertStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CriticalAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionProtectionState_tradeExecutionId_key" ON "ExecutionProtectionState"("tradeExecutionId");

-- CreateIndex
CREATE INDEX "ExecutionProtectionState_state_idx" ON "ExecutionProtectionState"("state");

-- CreateIndex
CREATE INDEX "MarginAdjustmentIntent_tradeExecutionId_idx" ON "MarginAdjustmentIntent"("tradeExecutionId");

-- CreateIndex
CREATE INDEX "MarginAdjustmentIntent_status_idx" ON "MarginAdjustmentIntent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MarginAdjustmentIntent_tradeExecutionId_attempt_key" ON "MarginAdjustmentIntent"("tradeExecutionId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "CriticalAlert_dedupeKey_key" ON "CriticalAlert"("dedupeKey");

-- CreateIndex
CREATE INDEX "CriticalAlert_tradeExecutionId_idx" ON "CriticalAlert"("tradeExecutionId");

-- CreateIndex
CREATE INDEX "CriticalAlert_status_idx" ON "CriticalAlert"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BinanceOrder_clientAlgoId_key" ON "BinanceOrder"("clientAlgoId");

-- AddForeignKey
ALTER TABLE "ExecutionProtectionState" ADD CONSTRAINT "ExecutionProtectionState_tradeExecutionId_fkey" FOREIGN KEY ("tradeExecutionId") REFERENCES "TradeExecution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarginAdjustmentIntent" ADD CONSTRAINT "MarginAdjustmentIntent_tradeExecutionId_fkey" FOREIGN KEY ("tradeExecutionId") REFERENCES "TradeExecution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CriticalAlert" ADD CONSTRAINT "CriticalAlert_tradeExecutionId_fkey" FOREIGN KEY ("tradeExecutionId") REFERENCES "TradeExecution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

