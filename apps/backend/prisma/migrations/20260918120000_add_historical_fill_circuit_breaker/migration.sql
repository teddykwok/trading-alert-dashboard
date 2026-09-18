-- Profile-level systemic circuit breaker for historical fill ingestion.
-- ADDITIVE ONLY: one new enum, one new table. No existing table is altered, no
-- column is dropped or made required, no existing value is rewritten, and
-- NOTHING is backfilled. The table starts empty and stays empty until a
-- systemic failure is actually observed.
--
-- WHY A PROFILE-SCOPED TABLE RATHER THAN CAMPAIGN COLUMNS
--
-- The faults this stops -- rejected credentials, a revoked API permission, a
-- banned IP, a connector switched off -- are facts about an ACCOUNT. Attaching
-- them to a campaign leaves two holes that were both proven reachable:
--
--   * a campaign that spends its last slot becomes EXHAUSTED, and the live
--     uniqueness index only covers ACTIVE and PAUSED, so a replacement campaign
--     can be created immediately and spent against the same unresolved fault;
--   * a campaign manually PAUSED while a request is still in flight cannot
--     record that request's systemic result at all, so ordinary resume walks
--     back into it with no acknowledgement.
--
-- Keyed by the profile, the latch outlives every campaign, worker and restart.
--
-- WHY CURRENT STATE AND NOT HISTORY
--
-- These columns answer "why is historical ingestion stopped right now". A
-- healthy dispatch clears the streak and an acknowledgement clears the latch,
-- so nothing here accumulates. The durable record of a trip is the structured
-- log event. That is also why there is no campaign id, no error message and no
-- exchange payload: an operator needs the cause and the count, and anything
-- more would put unreviewed text into an HTTP response.

CREATE TYPE "HistoricalFillCircuitState" AS ENUM ('CLOSED', 'OPEN');

-- WHY THE PROFILE IS THE PRIMARY KEY
-- One breaker per account, enforced by the shape of the table rather than by a
-- unique index somebody could later drop. It also makes the row LAZY: absence
-- is a complete, unambiguous answer meaning CLOSED and never-failed, so the
-- healthy path writes nothing at all.
CREATE TABLE "HistoricalFillCircuitBreaker" (
    "executionProfileId" TEXT NOT NULL,
    "state" "HistoricalFillCircuitState" NOT NULL,
    "failureFamily" TEXT,
    "lastReasonCode" TEXT,
    "consecutiveCount" INTEGER NOT NULL DEFAULT 0,
    "firstFailureAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalFillCircuitBreaker_pkey" PRIMARY KEY ("executionProfileId")
);

-- No DEFAULT on "state", deliberately. A row exists only because the breaker
-- service wrote it, and every writer states the state it means. A defaulted
-- state would be a licence to dispatch that nobody granted.

ALTER TABLE "HistoricalFillCircuitBreaker"
  ADD CONSTRAINT "HistoricalFillCircuitBreaker_count_check"
  CHECK ("consecutiveCount" >= 0);

-- The one structural invariant worth spending a constraint on: OPEN and
-- openedAt must agree. A latch that claimed to be open with no opening time, or
-- carried an opening time while closed, would make the operator's snapshot lie
-- about whether work is stopped. Cheap, total, and not brittle -- it constrains
-- two columns this service always writes together.
ALTER TABLE "HistoricalFillCircuitBreaker"
  ADD CONSTRAINT "HistoricalFillCircuitBreaker_open_state_check"
  CHECK (("state" = 'OPEN') = ("openedAt" IS NOT NULL));

-- RESTRICT, like every other durable account-scoped record here: a profile with
-- a breaker row must not be deleted out from under the thing that is stopping
-- its work.
ALTER TABLE "HistoricalFillCircuitBreaker"
  ADD CONSTRAINT "HistoricalFillCircuitBreaker_executionProfileId_fkey"
  FOREIGN KEY ("executionProfileId") REFERENCES "ExecutionProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- No further index. Every access is by the primary key.
