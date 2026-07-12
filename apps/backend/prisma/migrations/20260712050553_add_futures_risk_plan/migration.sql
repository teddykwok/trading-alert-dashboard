-- CreateEnum
CREATE TYPE "TradeMarginMode" AS ENUM ('ISOLATED', 'CROSS');

-- AlterTable
ALTER TABLE "TradeReview" ADD COLUMN     "accountBalance" DECIMAL(30,12),
ADD COLUMN     "leverage" DECIMAL(10,4),
ADD COLUMN     "liquidationPrice" DECIMAL(30,12),
ADD COLUMN     "marginMode" "TradeMarginMode",
ADD COLUMN     "riskPercent" DECIMAL(10,6),
ADD COLUMN     "stopLossPrice" DECIMAL(30,12),
ADD COLUMN     "takeProfitPrice" DECIMAL(30,12);
