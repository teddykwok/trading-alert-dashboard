-- CreateEnum
CREATE TYPE "TradeEmotion" AS ENUM ('CALM', 'ANXIOUS', 'EXCITED', 'FRUSTRATED', 'TIRED', 'FOMO', 'REVENGE', 'UNCERTAIN');

-- CreateTable
CREATE TABLE "TradeJournal" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "signalMatchesPlan" BOOLEAN NOT NULL DEFAULT false,
    "entryStopTargetDefined" BOOLEAN NOT NULL DEFAULT false,
    "riskWithinLimit" BOOLEAN NOT NULL DEFAULT false,
    "leverageReviewed" BOOLEAN NOT NULL DEFAULT false,
    "notFomo" BOOLEAN NOT NULL DEFAULT false,
    "notRevengeTrade" BOOLEAN NOT NULL DEFAULT false,
    "acceptsPotentialLoss" BOOLEAN NOT NULL DEFAULT false,
    "emotion" "TradeEmotion",
    "confidenceLevel" INTEGER,
    "reasonForEntry" TEXT,
    "preTradeNotes" TEXT,
    "postTradeReflection" TEXT,
    "lessonLearned" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeJournal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TradeJournal_alertId_key" ON "TradeJournal"("alertId");

-- CreateIndex
CREATE INDEX "TradeJournal_emotion_idx" ON "TradeJournal"("emotion");

-- AddForeignKey
ALTER TABLE "TradeJournal" ADD CONSTRAINT "TradeJournal_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
