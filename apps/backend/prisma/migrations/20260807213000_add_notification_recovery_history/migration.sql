-- CreateTable
CREATE TABLE "ExecutionProtectionVerification" (
    "id" TEXT NOT NULL,
    "tradeExecutionId" TEXT NOT NULL,
    "protectionVersion" INTEGER NOT NULL,
    "state" "ProtectionState" NOT NULL,
    "confirmedOpenQuantity" DECIMAL(40,18) NOT NULL,
    "protectedStopQuantity" DECIMAL(40,18) NOT NULL,
    "protectedTakeProfitQuantity" DECIMAL(40,18) NOT NULL,
    "liquidationSafe" BOOLEAN,
    "generation" INTEGER NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionProtectionVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionNotificationCheckpoint" (
    "id" TEXT NOT NULL,
    "executionEventId" TEXT,
    "protectionVerificationId" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionNotificationCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionProtectionVerification_tradeExecutionId_protectionV_key" ON "ExecutionProtectionVerification"("tradeExecutionId", "protectionVersion");

-- CreateIndex
CREATE INDEX "ExecutionProtectionVerification_tradeExecutionId_idx" ON "ExecutionProtectionVerification"("tradeExecutionId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionNotificationCheckpoint_executionEventId_key" ON "ExecutionNotificationCheckpoint"("executionEventId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionNotificationCheckpoint_protectionVerificationId_key" ON "ExecutionNotificationCheckpoint"("protectionVerificationId");

-- AddForeignKey
ALTER TABLE "ExecutionProtectionVerification" ADD CONSTRAINT "ExecutionProtectionVerification_tradeExecutionId_fkey" FOREIGN KEY ("tradeExecutionId") REFERENCES "TradeExecution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionNotificationCheckpoint" ADD CONSTRAINT "ExecutionNotificationCheckpoint_executionEventId_fkey" FOREIGN KEY ("executionEventId") REFERENCES "ExecutionEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionNotificationCheckpoint" ADD CONSTRAINT "ExecutionNotificationCheckpoint_protectionVerificationId_fkey" FOREIGN KEY ("protectionVerificationId") REFERENCES "ExecutionProtectionVerification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
