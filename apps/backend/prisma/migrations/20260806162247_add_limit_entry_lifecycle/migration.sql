-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ExecutionEventType" ADD VALUE 'EXCHANGE_CONFIG_VERIFIED';
ALTER TYPE "ExecutionEventType" ADD VALUE 'ENTRY_SUBMITTED';
ALTER TYPE "ExecutionEventType" ADD VALUE 'ENTRY_RECONCILED';
ALTER TYPE "ExecutionEventType" ADD VALUE 'ENTRY_CANCEL_REQUESTED';

-- AlterTable
ALTER TABLE "BinanceOrder" ADD COLUMN     "cancelConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3),
ADD COLUMN     "entryOrderExpiresAt" TIMESTAMP(3),
ADD COLUMN     "exchangeStatusRaw" TEXT,
ADD COLUMN     "lastReconcileAt" TIMESTAMP(3),
ADD COLUMN     "reconcileAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "submissionUnknownAt" TIMESTAMP(3);
