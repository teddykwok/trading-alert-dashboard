-- Durable trading sessions, bounded by trades that actually obtained exposure.
-- ADDITIVE ONLY.
--
-- Two new enums and two new tables. No existing table is altered or recreated,
-- no column is dropped, no existing value is rewritten, and NOTHING is
-- backfilled.
--
-- WHY A NEW DOMAIN RATHER THAN COLUMNS ON ExecutionCanaryAuthorization
-- That row's budget is `claimedCount`, which its own schema comment describes
-- as "NEVER decremented — a claim is not refunded when its execution later
-- expires unfilled". A session budget must be refundable: an entry that never
-- reaches the exchange has to give its slot back. Those are opposite
-- semantics, so widening the authorization row would have meant one column
-- meaning two different things depending on which mode wrote it.
--
-- WHY TradingSessionSlot HAS A UNIQUE tradeExecutionId
-- It is the idempotency mechanism, enforced by the database rather than by any
-- caller. An execution cannot reserve twice, and first-fill accounting can run
-- from the normal reconcile, startup recovery, an offline fill discovered
-- after a restart or a cancel-lost race without ever counting it again.
--
-- WHY NOTHING IS BACKFILLED
-- Historical authorization windows are not sessions and must not be presented
-- as though they were. A pre-feature window keeps exactly the meaning it had;
-- session accounting begins with the first session an operator starts.
CREATE TYPE "TradingSessionStatus" AS ENUM ('ACTIVE', 'EXHAUSTED', 'EXPIRED', 'REVOKED');
CREATE TYPE "SessionSlotState" AS ENUM ('RESERVED', 'OPENED', 'RELEASED');

CREATE TABLE "TradingSession" (
    "id" TEXT NOT NULL,
    "executionProfileId" TEXT NOT NULL,
    "status" "TradingSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "tradeBudget" INTEGER,
    "unlimited" BOOLEAN NOT NULL DEFAULT false,
    "openedCount" INTEGER NOT NULL DEFAULT 0,
    "reservedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TradingSessionSlot" (
    "id" TEXT NOT NULL,
    "tradingSessionId" TEXT NOT NULL,
    "tradeExecutionId" TEXT NOT NULL,
    "state" "SessionSlotState" NOT NULL DEFAULT 'RESERVED',
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingSessionSlot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TradingSession_executionProfileId_status_idx"
  ON "TradingSession"("executionProfileId", "status");
CREATE INDEX "TradingSession_expiresAt_idx" ON "TradingSession"("expiresAt");

-- One slot per execution, forever. This is what makes conversion to OPENED and
-- RELEASE safe to attempt repeatedly from any recovery path.
CREATE UNIQUE INDEX "TradingSessionSlot_tradeExecutionId_key"
  ON "TradingSessionSlot"("tradeExecutionId");
CREATE INDEX "TradingSessionSlot_tradingSessionId_state_idx"
  ON "TradingSessionSlot"("tradingSessionId", "state");

ALTER TABLE "TradingSession"
  ADD CONSTRAINT "TradingSession_executionProfileId_fkey"
  FOREIGN KEY ("executionProfileId") REFERENCES "ExecutionProfile"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TradingSessionSlot"
  ADD CONSTRAINT "TradingSessionSlot_tradingSessionId_fkey"
  FOREIGN KEY ("tradingSessionId") REFERENCES "TradingSession"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The durable link that makes a window SESSION-BACKED.
--
-- Nullable, and null is the LEGACY meaning: a window prepared before
-- sessions existed keeps the historical maxClaims behaviour exactly, because
-- nothing about its row changed. Only a window that Start Trading links to a
-- session is bounded by that session instead.
--
-- A stored link rather than an inference: "does this profile have an active
-- session?" would be ambiguous the moment a legacy window and a new session
-- coexist, and that ambiguity would decide whether a cumulative cap applies.
ALTER TABLE "ExecutionCanaryAuthorization"
  ADD COLUMN IF NOT EXISTS "tradingSessionId" TEXT;

CREATE INDEX IF NOT EXISTS "ExecutionCanaryAuthorization_tradingSessionId_idx"
  ON "ExecutionCanaryAuthorization"("tradingSessionId");

ALTER TABLE "ExecutionCanaryAuthorization"
  ADD CONSTRAINT "ExecutionCanaryAuthorization_tradingSessionId_fkey"
  FOREIGN KEY ("tradingSessionId") REFERENCES "TradingSession"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
