-- Phase 11E: one durable verdict PER EXECUTION PROFILE for each generic plan.
--
-- ADDITIVE ONLY: one new enum and one new table. No existing table is altered,
-- no column is dropped, retyped or made required, no existing row is rewritten,
-- and nothing is backfilled.
--
-- WHY THIS EXISTS
--
-- Until now one alert produced one ExtremeRRPlan, one generic BullMQ job, and
-- whichever worker dequeued that job created the single TradeExecution using
-- its own profile. With one account that is invisible. With two it means the
-- account that trades a signal is decided by a queue race, and the other
-- account silently never sees the opportunity at all.
--
-- Splitting the worker fixes who evaluates, but it needs somewhere durable to
-- record that a profile HAS evaluated a plan. Without it an execution worker
-- polling for plans would rediscover every refusal forever -- and one of those
-- refusals (MARGIN_PLAN_NOT_READY) is reached only after signed account and
-- leverageBracket reads, so "forever" would mean burning Binance request weight
-- on every tick for the life of the plan.
--
-- SelectedPlanOutcome could not be that record. It is keyed alertId UNIQUE and
-- extremeRRPlanId UNIQUE and its writer upserts on alertId, so it stores
-- exactly one verdict per plan: Account B's result would overwrite Account A's.
-- That row keeps its historical meaning and its existing readers; it simply
-- stops receiving new per-account execution verdicts.
--
-- WHY THE CLAIM COLUMNS
--
-- The pair (plan, profile) is unique, which alone would make a duplicate
-- execution impossible. But the margin planner's SIGNED reads happen BEFORE
-- TradeExecution is created, so uniqueness-after-the-fact would still let two
-- workers for one profile both spend request weight and only then discover the
-- race. The claim is therefore taken FIRST, and these columns are its lease:
-- attempts doubles as the fencing token, exactly as ExchangeFillIngestWindow
-- uses it, so a worker whose process stalled cannot come back and overwrite the
-- terminal result a reclaimer already wrote.

-- THE ROLLOUT FENCE
--
-- Nullable and NOT backfilled, deliberately. Every plan that already
-- reached READY under the pre-11E worker keeps NULL, which is what makes
-- it permanently ineligible for account fanout: it was already evaluated
-- once, by an architecture that had nowhere to record that it had been.
-- Only the 11E generic READY transition writes this column.
--
-- This is the one statement here that touches an existing table. It adds a
-- nullable column and nothing else: no existing row is rewritten, no
-- column is dropped, retyped or made required.
ALTER TABLE "ExtremeRRPlan" ADD COLUMN     "executionFanoutReadyAt" TIMESTAMP(3);

-- CreateIndex
-- The adoption discovery query's exact shape: eligible status, rollout
-- marker present, and the freshness comparison.
CREATE INDEX "ExtremeRRPlan_status_executionFanoutReadyAt_cutoffAt_idx" ON "ExtremeRRPlan"("status", "executionFanoutReadyAt", "cutoffAt");

-- CreateEnum
CREATE TYPE "SelectedPlanAdoptionStatus" AS ENUM ('PENDING', 'COMPLETED');

-- CreateTable
CREATE TABLE "SelectedPlanAdoption" (
    "id" TEXT NOT NULL,
    "extremeRRPlanId" TEXT NOT NULL,
    "executionProfileId" TEXT NOT NULL,
    "status" "SelectedPlanAdoptionStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "claimOwner" TEXT,
    "handled" BOOLEAN,
    "reasonCode" TEXT,
    "message" TEXT,
    "executionId" TEXT,
    "evaluatedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SelectedPlanAdoption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The discovery query's shape: this profile's non-terminal rows, and the lease
-- age that decides whether one of them is reclaimable.
CREATE INDEX "SelectedPlanAdoption_executionProfileId_status_claimedAt_idx" ON "SelectedPlanAdoption"("executionProfileId", "status", "claimedAt");

-- CreateIndex
-- THE correctness boundary: one verdict per (plan, profile), enforced by the
-- database rather than by every writer remembering.
CREATE UNIQUE INDEX "SelectedPlanAdoption_extremeRRPlanId_executionProfileId_key" ON "SelectedPlanAdoption"("extremeRRPlanId", "executionProfileId");

-- AddForeignKey
CREATE INDEX "SelectedPlanAdoption_extremeRRPlanId_idx" ON "SelectedPlanAdoption"("extremeRRPlanId");

-- AddForeignKey
ALTER TABLE "SelectedPlanAdoption" ADD CONSTRAINT "SelectedPlanAdoption_extremeRRPlanId_fkey" FOREIGN KEY ("extremeRRPlanId") REFERENCES "ExtremeRRPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict, like every other execution relation: a decision must not vanish
-- because a profile row was removed.
ALTER TABLE "SelectedPlanAdoption" ADD CONSTRAINT "SelectedPlanAdoption_executionProfileId_fkey" FOREIGN KEY ("executionProfileId") REFERENCES "ExecutionProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
