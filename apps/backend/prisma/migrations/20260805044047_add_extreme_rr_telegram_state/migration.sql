-- CreateEnum
CREATE TYPE "ExtremeRRTelegramStatus" AS ENUM ('SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "ExtremeRRPlan" ADD COLUMN     "telegramLastError" TEXT,
ADD COLUMN     "telegramNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "telegramStatus" "ExtremeRRTelegramStatus";
