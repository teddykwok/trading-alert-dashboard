-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('CRYPTO', 'STOCK');

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('LONG', 'SHORT', 'WATCH', 'EXIT');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('RECEIVED', 'PROCESSING_SCREENSHOT', 'ANALYZING_WITH_AI', 'ANALYZED', 'FAILED', 'IGNORED_DUPLICATE');

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT,
    "assetType" "AssetType" NOT NULL,
    "exchange" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "assetId" TEXT,
    "symbol" TEXT NOT NULL,
    "assetType" "AssetType" NOT NULL,
    "exchange" TEXT,
    "timeframe" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "signal" "SignalType" NOT NULL,
    "indicatorName" TEXT,
    "indicatorValue" DOUBLE PRECISION,
    "rawPayload" JSONB NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'RECEIVED',
    "screenshotUrl" TEXT,
    "aiBias" TEXT,
    "aiConfidence" DOUBLE PRECISION,
    "aiPattern" TEXT,
    "aiSummary" TEXT,
    "aiRiskNotes" JSONB,
    "errorMessage" TEXT,
    "triggeredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Asset_symbol_assetType_key" ON "Asset"("symbol", "assetType");

-- CreateIndex
CREATE INDEX "Alert_status_idx" ON "Alert"("status");

-- CreateIndex
CREATE INDEX "Alert_symbol_idx" ON "Alert"("symbol");

-- CreateIndex
CREATE INDEX "Alert_signal_idx" ON "Alert"("signal");

-- CreateIndex
CREATE INDEX "Alert_createdAt_idx" ON "Alert"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Setting_key_key" ON "Setting"("key");

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
