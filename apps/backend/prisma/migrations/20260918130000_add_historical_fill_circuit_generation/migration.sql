-- Durable breaker EPOCH, and the epoch each weight reservation was granted in.
-- ADDITIVE ONLY: two new columns and two CHECK constraints. No table is created
-- or dropped, no column is dropped, retyped or made required, no existing value
-- is rewritten, and NOTHING is backfilled by a query.
--
-- WHY THIS EXISTS
--
-- Acknowledging the circuit clears every column that says a fault happened:
-- state, openedAt, failureFamily, lastReasonCode, the streak count and both
-- streak timestamps. An acknowledged breaker row is therefore field-for-field
-- identical to one left behind by a streak that recovered on its own and never
-- opened anything. That was measured, not assumed.
--
-- The consequence was a real hole. A campaign whose FINAL slot was admitted,
-- leaving it EXHAUSTED with that reservation still outstanding, could be
-- reopened by the refund for that reservation if the refund happened to land
-- after an operator acknowledged an episode -- because at that moment the latch
-- reads CLOSED and no other live campaign exists. An account that was stopped
-- for a systemic fault would quietly acquire a runnable campaign again, with no
-- start and no resume, purely because a straggler arrived late.
--
-- WHY A COUNTER RATHER THAN A TIMESTAMP
--
-- The obvious alternative -- retain the opening time and compare it against the
-- reservation's createdAt -- cannot be made correct here. The breaker resolves
-- its `now` BEFORE it queues for the profile advisory lock, and a reservation's
-- createdAt is CURRENT_TIMESTAMP, which in Postgres is transaction START time.
-- Both are captured before their writer acquires the lock, so comparing them
-- decides by two different clocks an ordering that is actually settled by lock
-- acquisition -- and gets it backwards whenever the trip waited longer. Both
-- columns are also TIMESTAMP(3), so same-millisecond ties are ordinary under
-- load and no comparator resolves them correctly.
--
-- A counter read and written INSIDE the locked transaction inherits the lock's
-- own total order instead. There is no clock in the comparison at all.
--
-- WHY DEFAULT 0 IS THE CORRECT BACKFILL
--
-- Existing reservations predate the breaker entirely, so epoch 0 is not a
-- placeholder for them -- it is the truth. Absence of a breaker row is likewise
-- defined as logical generation 0, which is what keeps the healthy path free of
-- breaker writes. Since PostgreSQL 11 a non-volatile DEFAULT on ADD COLUMN is
-- stored as metadata, so neither table is rewritten and no row is touched.

ALTER TABLE "HistoricalFillCircuitBreaker"
  ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "HistoricalFillWeightReservation"
  ADD COLUMN "circuitGeneration" INTEGER NOT NULL DEFAULT 0;

-- Both counters are only ever moved by `{ increment: 1 }` from a zero default,
-- so neither can go negative through this application. These constraints are
-- for the paths the application does not own -- a hand-edit, a psql session, a
-- future migration -- exactly as the breaker's existing consecutiveCount check
-- already is.
ALTER TABLE "HistoricalFillCircuitBreaker"
  ADD CONSTRAINT "HistoricalFillCircuitBreaker_generation_check"
  CHECK ("generation" >= 0);

ALTER TABLE "HistoricalFillWeightReservation"
  ADD CONSTRAINT "HistoricalFillWeightReservation_circuit_generation_check"
  CHECK ("circuitGeneration" >= 0);

-- No index on either column. The breaker is always reached by its primary key,
-- and a reservation's generation is only ever read alongside the row itself,
-- which the refund has already fetched by id.
