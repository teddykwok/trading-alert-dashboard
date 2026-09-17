-- Durable historical-backfill campaign control — ADDITIVE ONLY.
--
-- One new enum, one new table, and one new NULLABLE column with an index on an
-- existing table. No column is dropped, none is made required, no existing
-- value is rewritten, and NOTHING is backfilled. Every row that exists before
-- this migration is still valid after it: a reservation written before
-- campaigns existed carries a NULL "campaignId" and remains a complete record
-- of weight that was spent.
--
-- WHY A CAMPAIGN EXISTS AT ALL
-- Every bound this subsystem already has is per-request (weight 5), per-batch
-- (EXECUTION_FILL_BATCH_MAX_WINDOWS, EXECUTION_FILL_BATCH_MAX_USER_TRADES_WEIGHT)
-- or per-minute (the weight bucket). Not one of them survives the next tick.
-- A runtime that is simply left enabled therefore keeps going until the work
-- queue is empty, and nothing in the system can answer the only question an
-- operator actually asks before authorising a backfill: how much will this do
-- IN TOTAL. A campaign is the only bound that spans ticks, workers, crashes
-- and restarts, so it is the only place that question can be answered.
--
-- WHY THE UNIT IS AN ADMITTED DISPATCH
-- Not an executor invocation, and not a completed request. The campaign is
-- spending an exchange allowance, and the allowance is spent the moment a
-- request may leave this process. An invocation that threw has to be counted:
-- the throw proves nothing about whether the request was sent. Only the
-- outcomes that PROVABLY issue no request — NO_WORK and PROFILE_UNAVAILABLE,
-- both decided before the transport is touched — give their slot back.
-- Counting admissions rather than successes means the ceiling can only ever
-- overstate what was spent, which is the safe error direction.

CREATE TYPE "HistoricalFillCampaignStatus" AS ENUM (
  'ACTIVE',
  'PAUSED',
  'EXHAUSTED',
  'COMPLETED',
  'ABORTED'
);

-- WHY "status" HAS NO DEFAULT
-- Deliberate, and load-bearing. A default would mean a campaign could come into
-- existence because a caller omitted a field — an implicit licence to spend the
-- account's exchange allowance, which is the precise opposite of the purpose of
-- this table. Every writer must state the state it intends. The same reasoning
-- is why "maxDispatches" has no default either: there is no safe number to
-- guess on an operator's behalf.
CREATE TABLE "HistoricalFillCampaign" (
    "id" TEXT NOT NULL,
    "executionProfileId" TEXT NOT NULL,
    "status" "HistoricalFillCampaignStatus" NOT NULL,
    "maxDispatches" INTEGER NOT NULL,
    "dispatchesUsed" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAdmissionAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalFillCampaign_pkey" PRIMARY KEY ("id")
);

-- WHY A HARD CEILING IN THE DATABASE, NOT ONLY IN THE SERVICE
-- The service validates its input, but the service is one caller. A CHECK is
-- the bound that a future CLI, an operator route, a migration script or a
-- psql session cannot talk its way past. 100 is chosen because the weight of
-- one dispatch is 5, so a full campaign is at most 500 weight against an
-- account allowance measured in thousands per minute — a backfill that is
-- meaningful to run and impossible to mistake for unbounded.
ALTER TABLE "HistoricalFillCampaign"
  ADD CONSTRAINT "HistoricalFillCampaign_maxDispatches_check"
  CHECK ("maxDispatches" >= 1 AND "maxDispatches" <= 100);

-- WHY THE USED COUNTER IS CONSTRAINED AGAINST ITS OWN CEILING
-- "dispatchesUsed" is only ever moved by a conditional UPDATE that re-proves
-- the ceiling in its WHERE clause, so this constraint should be unreachable.
-- That is exactly why it is here: the database refuses to hold a state the
-- admission logic claims it can never produce, and a bug in that logic
-- surfaces as a failed write rather than as silently overspent allowance.
ALTER TABLE "HistoricalFillCampaign"
  ADD CONSTRAINT "HistoricalFillCampaign_dispatchesUsed_check"
  CHECK ("dispatchesUsed" >= 0 AND "dispatchesUsed" <= "maxDispatches");

ALTER TABLE "HistoricalFillCampaign"
  ADD CONSTRAINT "HistoricalFillCampaign_executionProfileId_fkey"
  FOREIGN KEY ("executionProfileId") REFERENCES "ExecutionProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "HistoricalFillCampaign_executionProfileId_status_idx"
  ON "HistoricalFillCampaign"("executionProfileId", "status");

-- WHY A PARTIAL UNIQUE INDEX, AND WHY IT IS HAND-WRITTEN
-- At most one LIVE campaign per profile. Two live campaigns would each hold
-- their own ceiling and each admit up to it, so the account's real exposure
-- would be their sum — the ceiling would stop meaning anything.
--
-- ACTIVE and PAUSED are both live: a paused campaign still owns its remaining
-- slots and is expected to resume, so letting a second campaign be created
-- beside it would be the same overspend with an extra step. EXHAUSTED,
-- COMPLETED and ABORTED are excluded because they are finished, and history
-- must be allowed to accumulate — a profile that has run ten backfills keeps
-- ten rows.
--
-- This is a UNIQUENESS RULE, not a convention, so it is enforced by the
-- database rather than by a read-then-write in the service: two processes
-- creating a campaign for the same profile at the same instant both pass any
-- prior read. One of them must lose, and only a unique index can make that
-- happen. It is written by hand because Prisma's schema language has no way to
-- express a WHERE clause on an index; `prisma validate` and `prisma generate`
-- are unaffected, and the index is invisible to the client, which is fine —
-- nothing queries through it. It exists to REFUSE writes.
CREATE UNIQUE INDEX "HistoricalFillCampaign_one_live_per_profile"
  ON "HistoricalFillCampaign"("executionProfileId")
  WHERE "status" IN ('ACTIVE', 'PAUSED');

-- WHY THE RESERVATION LEARNS ITS CAMPAIGN
-- A refund has to give back BOTH the minute's weight and the campaign's slot,
-- and it is handed nothing but the reservation. Without this column the refund
-- path would have to guess which campaign to credit, and crediting the wrong
-- one — or the right one twice — is an undercount of what has been spent.
--
-- NULLABLE permanently, not transitionally. Reservations that precede campaigns
-- carry NULL, and so does any future admission taken outside a campaign; a
-- release simply touches no campaign accounting when this is NULL.
--
-- RESTRICT so that a campaign with reservations pointing at it cannot be
-- deleted out from under its own audit trail, matching every other durable
-- account-scoped relation here.
ALTER TABLE "HistoricalFillWeightReservation"
  ADD COLUMN "campaignId" TEXT;

CREATE INDEX "HistoricalFillWeightReservation_campaignId_idx"
  ON "HistoricalFillWeightReservation"("campaignId");

ALTER TABLE "HistoricalFillWeightReservation"
  ADD CONSTRAINT "HistoricalFillWeightReservation_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "HistoricalFillCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
