-- Cross-process historical userTrades weight accounting — ADDITIVE ONLY.
--
-- One new table. No existing table is altered, no column is dropped or made
-- required, no existing value is rewritten, and NOTHING is backfilled.
-- ExecutionProfile gains only a Prisma-side back-relation, which is virtual and
-- produces no SQL.
--
-- WHY A DURABLE TABLE RATHER THAN AN IN-MEMORY COUNTER
-- The per-batch budget is already in memory and already correct — for ONE
-- process. Nothing stops a second worker from spending its own full budget in
-- the same minute, so the ceiling has to live somewhere both processes can see.
-- Postgres is the only coordination substrate this repository already trusts
-- for compare-and-set accounting.
--
-- WHY (executionProfileId, bucketStart) IS THE NATURAL KEY
-- The exchange allowance being spent belongs to an ACCOUNT, so two profiles
-- must never share a ceiling. The minute is the accounting period. The unique
-- index is also the race mechanism: two workers entering the same minute
-- converge on one row instead of creating two ceilings.
--
-- WHY THE CAP IS A COLUMN
-- Two processes may start with different configured caps. Storing the cap in
-- force makes disagreement detectable: a process whose configuration differs is
-- refused rather than silently raising a ceiling another process is already
-- counting against. The cap is never rewritten mid-bucket.
--
-- WHY THE CHECK CONSTRAINTS
-- `weightUsed` is only ever moved by a conditional UPDATE that re-proves the
-- cap, so these are defence in depth: the database refuses to hold a state the
-- reservation logic claims it can never produce.

CREATE TABLE "HistoricalFillWeightBucket" (
    "id" TEXT NOT NULL,
    "executionProfileId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "weightCap" INTEGER NOT NULL,
    "weightUsed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalFillWeightBucket_pkey" PRIMARY KEY ("id")
);

-- The natural identity, and the race mechanism.
CREATE UNIQUE INDEX "HistoricalFillWeightBucket_executionProfileId_bucketStart_key"
  ON "HistoricalFillWeightBucket"("executionProfileId", "bucketStart");

CREATE INDEX "HistoricalFillWeightBucket_bucketStart_idx"
  ON "HistoricalFillWeightBucket"("bucketStart");

ALTER TABLE "HistoricalFillWeightBucket"
  ADD CONSTRAINT "HistoricalFillWeightBucket_cap_check"
  CHECK ("weightCap" > 0);

ALTER TABLE "HistoricalFillWeightBucket"
  ADD CONSTRAINT "HistoricalFillWeightBucket_used_check"
  CHECK ("weightUsed" >= 0 AND "weightUsed" <= "weightCap");

ALTER TABLE "HistoricalFillWeightBucket"
  ADD CONSTRAINT "HistoricalFillWeightBucket_executionProfileId_fkey"
  FOREIGN KEY ("executionProfileId") REFERENCES "ExecutionProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- WHY A RESERVATION ROW AS WELL AS A COUNTER
-- `weightUsed` is an aggregate: it knows five weight is spent, not WHOSE.
-- Releasing against the counter alone cannot distinguish a first release of one
-- reservation from a second, and a duplicate would give back weight still owed
-- to a different outstanding reservation. That is an UNDERCOUNT -- the one error
-- direction that lets the account's exchange allowance be spent twice.
--
-- Each grant therefore gets a row, and `releasedAt` is the durable proof of
-- whether it has already been given back. Release is a compare-and-set on that
-- row inside the same short transaction that decrements the bucket: at most one
-- release per reservation, whatever a caller does and however many processes
-- attempt it at once. The database owns the idempotency, not the caller --
-- exactly the reason TradingSessionSlot.tradeExecutionId is unique.

CREATE TABLE "HistoricalFillWeightReservation" (
    "id" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoricalFillWeightReservation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HistoricalFillWeightReservation_bucketId_releasedAt_idx"
  ON "HistoricalFillWeightReservation"("bucketId", "releasedAt");

ALTER TABLE "HistoricalFillWeightReservation"
  ADD CONSTRAINT "HistoricalFillWeightReservation_weight_check"
  CHECK ("weight" > 0);

ALTER TABLE "HistoricalFillWeightReservation"
  ADD CONSTRAINT "HistoricalFillWeightReservation_bucketId_fkey"
  FOREIGN KEY ("bucketId") REFERENCES "HistoricalFillWeightBucket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
