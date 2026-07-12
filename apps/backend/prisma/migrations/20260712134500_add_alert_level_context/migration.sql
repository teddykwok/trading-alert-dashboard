-- CreateEnum
CREATE TYPE "AlertEventType" AS ENUM ('LEVEL_CREATED', 'LEVEL_TOUCHED');

-- CreateEnum
CREATE TYPE "LevelColor" AS ENUM ('GREEN', 'RED');

-- CreateEnum
CREATE TYPE "TouchDirection" AS ENUM ('FROM_ABOVE', 'FROM_BELOW', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "eventType" "AlertEventType",
ADD COLUMN     "levelColor" "LevelColor",
ADD COLUMN     "sourceTimeframe" TEXT,
ADD COLUMN     "touchDirection" "TouchDirection";

-- CreateIndex
CREATE INDEX "Alert_sourceTimeframe_idx" ON "Alert"("sourceTimeframe");

-- CreateIndex
CREATE INDEX "Alert_levelColor_idx" ON "Alert"("levelColor");
