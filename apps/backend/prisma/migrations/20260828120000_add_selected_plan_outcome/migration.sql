-- Selected-plan execution outcomes — ADDITIVE ONLY.
--
-- One new table. No existing table is altered or recreated, no column is
-- dropped, no existing value is rewritten, and NOTHING is backfilled.
--
-- WHY A NEW TABLE RATHER THAN COLUMNS ON AN EXISTING ONE
-- The decision this records happens BEFORE any TradeExecution exists, so
-- neither "ExecutionEvent" nor "SafetyAdmission" can hold it — both require a
-- tradeExecutionId. Putting it on "ExtremeRRPlan" would overload a
-- plan-GENERATION row ("status", "errorReason") with an execution DECISION,
-- which is a different domain and a different lifetime.
--
-- WHY BOTH COLUMNS ARE UNIQUE
-- "ExtremeRRPlan"."alertId" is already unique and a READY plan is frozen, so
-- alert, plan and verdict are 1:1:1. Constraining both makes "one verdict per
-- plan" an invariant the database enforces, and it is what makes concurrent
-- evaluation deterministic without a lock.
--
-- WHY NOTHING IS BACKFILLED
-- Alerts that predate this table have no durable evidence of what the executor
-- decided; that evidence was only ever logged. Inventing rows from current
-- system state is exactly the inference this feature exists to remove, so an
-- old alert keeps saying "reason unavailable", which is true.
--
-- WHY "executionId" IS NOT A FOREIGN KEY
-- This is a historical record and must survive independently of the execution
-- it mentions. A FK would let execution retention rewrite observability history.
CREATE TABLE IF NOT EXISTS "SelectedPlanOutcome" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "extremeRRPlanId" TEXT NOT NULL,
    "handled" BOOLEAN NOT NULL,
    "reasonCode" TEXT,
    "message" TEXT,
    "executionId" TEXT,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SelectedPlanOutcome_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SelectedPlanOutcome_alertId_key"
  ON "SelectedPlanOutcome"("alertId");

CREATE UNIQUE INDEX IF NOT EXISTS "SelectedPlanOutcome_extremeRRPlanId_key"
  ON "SelectedPlanOutcome"("extremeRRPlanId");

CREATE INDEX IF NOT EXISTS "SelectedPlanOutcome_reasonCode_idx"
  ON "SelectedPlanOutcome"("reasonCode");

CREATE INDEX IF NOT EXISTS "SelectedPlanOutcome_evaluatedAt_idx"
  ON "SelectedPlanOutcome"("evaluatedAt");

ALTER TABLE "SelectedPlanOutcome"
  ADD CONSTRAINT "SelectedPlanOutcome_alertId_fkey"
  FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SelectedPlanOutcome"
  ADD CONSTRAINT "SelectedPlanOutcome_extremeRRPlanId_fkey"
  FOREIGN KEY ("extremeRRPlanId") REFERENCES "ExtremeRRPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
