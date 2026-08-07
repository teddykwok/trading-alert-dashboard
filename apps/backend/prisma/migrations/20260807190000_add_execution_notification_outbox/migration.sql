-- CreateEnum
CREATE TYPE "ExecutionNotificationType" AS ENUM ('LIMIT_PLACED', 'PARTIAL_FILL', 'POSITION_FILLED', 'POSITION_PROTECTED', 'ENTRY_EXPIRED', 'CLOSED_TP', 'CLOSED_SL', 'CLOSED_EMERGENCY', 'TRADE_SKIPPED');

-- CreateEnum
CREATE TYPE "ExecutionNotificationSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ExecutionNotificationStatus" AS ENUM ('PENDING', 'DELIVERED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE');

-- AlterTable
ALTER TABLE "CriticalAlert" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimOwner" TEXT;

-- CreateTable
CREATE TABLE "ExecutionNotification" (
    "id" TEXT NOT NULL,
    "tradeExecutionId" TEXT NOT NULL,
    "notificationType" "ExecutionNotificationType" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "severity" "ExecutionNotificationSeverity" NOT NULL DEFAULT 'INFO',
    "milestoneSequence" INTEGER NOT NULL,
    "payloadSnapshot" JSONB NOT NULL,
    "deliveryStatus" "ExecutionNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "sanitizedLastError" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimOwner" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionNotification_dedupeKey_key" ON "ExecutionNotification"("dedupeKey");

-- CreateIndex
CREATE INDEX "ExecutionNotification_tradeExecutionId_idx" ON "ExecutionNotification"("tradeExecutionId");

-- CreateIndex
CREATE INDEX "ExecutionNotification_deliveryStatus_createdAt_idx" ON "ExecutionNotification"("deliveryStatus", "createdAt");

-- AddForeignKey
ALTER TABLE "ExecutionNotification" ADD CONSTRAINT "ExecutionNotification_tradeExecutionId_fkey" FOREIGN KEY ("tradeExecutionId") REFERENCES "TradeExecution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
