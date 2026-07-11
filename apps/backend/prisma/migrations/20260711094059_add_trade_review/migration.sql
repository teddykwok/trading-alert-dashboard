-- CreateEnum
CREATE TYPE "TradeReviewStatus" AS ENUM ('UNREVIEWED', 'IGNORED', 'OPEN', 'WIN', 'LOSS', 'BREAKEVEN');

-- CreateTable
CREATE TABLE "TradeReview" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "status" "TradeReviewStatus" NOT NULL DEFAULT 'UNREVIEWED',
    "entryPrice" DECIMAL(30,12),
    "exitPrice" DECIMAL(30,12),
    "notes" TEXT,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TradeReview_alertId_key" ON "TradeReview"("alertId");

-- CreateIndex
CREATE INDEX "TradeReview_status_idx" ON "TradeReview"("status");

-- AddForeignKey
ALTER TABLE "TradeReview" ADD CONSTRAINT "TradeReview_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
