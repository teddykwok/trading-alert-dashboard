-- CreateEnum
CREATE TYPE "CanaryDirection" AS ENUM ('LONG', 'SHORT');

-- CreateTable
CREATE TABLE "ExecutionCanaryAuthorization" (
    "id" TEXT NOT NULL,
    "executionProfileId" TEXT NOT NULL,
    "allowedSymbol" TEXT NOT NULL,
    "allowedDirection" "CanaryDirection" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    "consumedAlertId" TEXT,
    "consumedExecutionId" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ExecutionCanaryAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionCanaryAuthorization_tokenHash_key" ON "ExecutionCanaryAuthorization"("tokenHash");

-- CreateIndex
CREATE INDEX "ExecutionCanaryAuthorization_executionProfileId_idx" ON "ExecutionCanaryAuthorization"("executionProfileId");

-- CreateIndex
CREATE INDEX "ExecutionCanaryAuthorization_expiresAt_idx" ON "ExecutionCanaryAuthorization"("expiresAt");

-- AddForeignKey
ALTER TABLE "ExecutionCanaryAuthorization" ADD CONSTRAINT "ExecutionCanaryAuthorization_executionProfileId_fkey" FOREIGN KEY ("executionProfileId") REFERENCES "ExecutionProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
